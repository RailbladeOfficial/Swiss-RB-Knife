/* =============================================================================
   TOOL FILE STORE: loading and saving a tool's own data, safely
   -----------------------------------------------------------------------------
   Every tool keeps its state in a file of its own and reads it back at startup.
   The dangerous moment is not the write. It is the read that DID NOT WORK and
   was treated as a read of an empty tool.

   Three answers arrive at a load, and they are not the same:

     the file is not there        -> the defaults ARE the right answer
     the file could not be read   -> the tool has no idea what it holds
     the file could not be parsed -> the same, with the bytes still on disk

   The back end already separates the first from the second: load_tool_file
   returns the tool's empty shape only for NotFound, and an error for anything
   else. This is the other half. A parse failure is a file that exists and was
   not understood, and treating it as an empty tool means the next save writes
   that emptiness over whatever was really in there.

   A WARNING IS NOT ENOUGH. A banner on a tool that otherwise behaves normally
   still loses the file, because the first edit saves. So a file that failed to
   load is BLOCKED: every save to it is refused for the rest of the session, and
   the refusal names the tool and the file rather than saying something went
   wrong. The user closes the app, looks at the file or moves it, and opens the
   app again. Nothing was overwritten in between.

   The block lasts the session and is deliberately not clearable from the UI.
   There is no "try again" that could be safe: the tool is holding defaults by
   then, so a save that succeeded would write those defaults over the file.
============================================================================= */

import { invoke } from "@tauri-apps/api/core";

import { devError } from "./dev-log";

/** Tool ids as the file store knows them, to the name on the tool's card. Used
 *  to say WHICH tool a blocked file belongs to. Checked against the shell's
 *  tool registry by scripts/checks, so a renamed tool cannot leave a message
 *  pointing at a name that no longer exists. */
const TOOL_LABELS: Record<string, string> = {
  "auto-backup": "Auto-Backup",
  budget: "Budget",
  countdown: "Countdown Timer",
  "game-stats": "Game Stats",
  kanban: "Kanban",
  rng: "RNGesus",
  "time-tracker": "Time Tracker",
  "tts-repeater": "TTS Repeater",
};

/** Files that failed to load this session, keyed "toolId:kind", holding the
 *  filename the back end gave for them. */
const blocked = new Map<string, string>();

let flashFn: (msg: string, kind?: "success" | "error", ms?: number) => void = () => {};

/** Hands over the shell's toast function. Passed in rather than imported: the
 *  tools import this module and shell.ts imports the tools, so importing back
 *  the other way would put the three in a load-order loop. Same reason as
 *  initDataTransfer. */
export function initToolStore(deps: { flash: typeof flashFn }): void {
  flashFn = deps.flash;
}

/** Thrown by a load that could not produce the tool's real data. Callers catch
 *  it to draw an empty screen; what they must NOT do is carry on and save. */
export class ToolFileUnreadable extends Error {
  constructor(
    readonly toolId: string,
    readonly kind: string,
    readonly filename: string,
    readonly reason: unknown,
  ) {
    super(
      `${TOOL_LABELS[toolId] ?? toolId} could not read ${filename}. Nothing will be ` +
        `saved over it this session. Close the app, then repair or move that file.`,
    );
    this.name = "ToolFileUnreadable";
  }
}

/* -----------------------------------------------------------------------------
   THE WHOLE-FOLDER FREEZE

   The per-file block above answers "this one file did not read". This answers
   "this entire data folder was written by a version of the app that knows more
   than this one does", which is not something any single load can notice: every
   file in it parses, and the fields this build does not recognize are simply
   dropped. The first save then writes the folder back WITHOUT them.

   So the answer is the same as for one unreadable file, applied to all of them,
   and it is set by the data-folder check at startup before any tool loads. See
   core/data-version.ts.
----------------------------------------------------------------------------- */

let frozenReason: string | null = null;

/** Refuses every write for the rest of the session. There is no unfreeze: the
 *  only safe way out is to close the app and open the version that wrote the
 *  folder. */
export function freezeAllWrites(reason: string): void {
  frozenReason = reason;
}

/** Why writing is refused, or null when it is not. Tools with their own save
 *  paths (Kanban's boards, Budget's encrypted pair) ask this before writing. */
export function writesFrozen(): string | null {
  return frozenReason;
}

function key(toolId: string, kind: string): string {
  return `${toolId}:${kind}`;
}

/** Whether a save to this file is refused. With no `kind`, whether ANY of the
 *  tool's files are, which is what a tool asks before offering to write. */
export function isToolFileBlocked(toolId: string, kind?: string): boolean {
  if (kind !== undefined) return blocked.has(key(toolId, kind));
  return [...blocked.keys()].some((k) => k.startsWith(`${toolId}:`));
}

/** The filenames blocked for a tool, for a screen that wants to name them. */
export function blockedToolFiles(toolId: string): string[] {
  return [...blocked.entries()]
    .filter(([k]) => k.startsWith(`${toolId}:`))
    .map(([, name]) => name);
}

/** The real name of a tool's file, asked of the back end rather than kept in a
 *  second table here. Falls back to the id pair, which still identifies the
 *  file well enough to act on. */
async function filenameOf(toolId: string, kind: string): Promise<string> {
  try {
    return await invoke<string>("tool_file_name", { toolId, kind });
  } catch {
    return `${toolId} (${kind})`;
  }
}

async function block(toolId: string, kind: string, reason: unknown): Promise<ToolFileUnreadable> {
  const filename = await filenameOf(toolId, kind);
  blocked.set(key(toolId, kind), filename);
  const err = new ToolFileUnreadable(toolId, kind, filename, reason);
  devError(`[tool-store] blocked ${key(toolId, kind)}:`, reason);
  // Said out loud, not only written to the dev log. A file that will not open
  // needs looking at, and nobody can look at a problem they were never told
  // about. Long, because it is asking for something to be done.
  flashFn(err.message, "error", 12000);
  return err;
}

/**
 * Reads one of a tool's files as text.
 *
 * Throws `ToolFileUnreadable` if the back end could not read it, having first
 * blocked every save to that file. A file that is simply not there is not an
 * error: the back end answers with the tool's empty shape.
 */
export async function loadToolText(toolId: string, kind: string): Promise<string> {
  try {
    return await invoke<string>("load_tool_file", { toolId, kind });
  } catch (err) {
    throw await block(toolId, kind, err);
  }
}

/**
 * Reads one of a tool's files and parses it.
 *
 * The parse is the point. JSON.parse failing means the bytes are there and are
 * not what this tool writes: an older shape, a half-written file from before
 * the atomic writes, or something edited by hand. Every one of those is a file
 * to look at, and none of them is an empty tool.
 */
export async function loadToolJson<T>(toolId: string, kind: string): Promise<T> {
  const raw = await loadToolText(toolId, kind);
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw await block(toolId, kind, err);
  }
}

/**
 * Writes one of a tool's files, unless that file failed to load.
 *
 * The refusal is the whole mechanism. Everything else here only explains it.
 */
export async function saveToolText(toolId: string, kind: string, data: string): Promise<void> {
  // The whole folder first: it outranks anything about one file, and an import
  // or a restore does not lift it the way it lifts a per-file block. A file the
  // user hands us is still written into a folder this build does not
  // understand, and that is the thing being refused.
  if (frozenReason) throw new Error(frozenReason);

  const name = blocked.get(key(toolId, kind));
  if (name !== undefined) {
    /* Names the FILE, not the tool. Every caller already puts the tool's name
       in front of this ("Couldn't save Countdown Timer data: ..."), and saying
       it twice in one toast reads like two different problems. */
    throw new Error(
      `${name} could not be read when the app started, so nothing is written over it. ` +
        `Close the app, then repair or move that file.`,
    );
  }
  await invoke("save_tool_file", { toolId, kind, data });
}

/** Writes one of a tool's files as JSON. Same refusal as saveToolText. */
export async function saveToolJson(toolId: string, kind: string, value: unknown): Promise<void> {
  await saveToolText(toolId, kind, JSON.stringify(value));
}

/**
 * Lifts the block after the file has been REPLACED rather than repaired.
 *
 * The Data tab's import is the one write that may land on a blocked file: it
 * carries a whole file the user just chose, so it is not the defaults the tool
 * fell back to. A snapshot restore is the same shape. Nothing else calls this.
 */
export function unblockAfterReplacement(toolId: string, kind: string): void {
  blocked.delete(key(toolId, kind));
}
