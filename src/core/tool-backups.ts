/* =============================================================================
   TOOL SNAPSHOTS: the shared browse-and-restore list
   -----------------------------------------------------------------------------
   Budget and Kanban have captured every write since they shipped. Time Tracker
   and Game Stats did not, which meant an entry or a game deleted by mistake was
   simply gone. This is the other half of fixing that: the capture happens in
   lib.rs's save_tool_file, and this is how you get at it.

   One renderer rather than one per tool. Kanban keeps its own because its
   snapshots are per board and can be encrypted, which is a different set of
   questions to answer on screen; everything else is "here are the times we
   captured, here is what was in each, put one back".

   A RESTORE IS AN ORDINARY SAVE. It reads the captured bytes and hands them to
   the caller, which writes them the way it writes anything else, which captures
   the state being replaced on the way past. So restoring the wrong snapshot is
   undone by restoring the newest one, and the recovery tool can never become
   the thing you need recovering from.
============================================================================= */

import { invoke } from "@tauri-apps/api/core";
import { formatFileTimestamp } from "./timestamp";
import { formatBytes } from "./format";

export interface ToolBackupFile {
  /** The .bak filename inside the snapshot folder. */
  file: string;
  /** Which of the tool's files this is: "data", "settings", and so on. */
  kind: string;
  bytes: number;
}

export interface ToolBackup {
  /** The snapshot folder's name, a UTC timestamp. */
  name: string;
  files: ToolBackupFile[];
}

/** A snapshot folder name ("2026-09-01_14-00-00") as a readable date and time.
 *  One implementation, shared with the database snapshot list. */
export const formatBackupName = formatFileTimestamp;



export interface ToolBackupListOptions {
  /** Which tool's snapshots to list, matching lib.rs's tool_file table. */
  toolId: string;
  /** How to fetch the list, when the shared tool-file store is not where the
   *  answer is. Budget is the one tool that needs this: its records are a pair
   *  that swaps names when encryption is on, which the store cannot describe. */
  list?: () => Promise<ToolBackup[]>;
  /** Where the list is drawn. Emptied and rebuilt on every refresh. */
  host: HTMLElement;
  /** Optional element that gets a short "3 kept" style readout. */
  summary?: HTMLElement | null;
  /** What to call each kind on screen, e.g. { data: "Entries" }. A kind with
   *  no label here is skipped, so a tool shows only what it wants to offer. */
  labels: Record<string, string>;
  /** Reads the captured bytes and puts them back. The caller owns this because
   *  only the caller knows how to parse its own file and what to redraw. */
  onRestore: (entry: ToolBackupFile, snapshot: ToolBackup) => void | Promise<void>;
}

/**
 * Draws the snapshot list, newest first, and wires each row's Restore button.
 *
 * Everything is created rather than assembled from a template string: these
 * rows carry a filename and a timestamp, and building them as elements means
 * neither can ever be read as markup.
 */
export async function renderToolBackups(opts: ToolBackupListOptions): Promise<void> {
  const { host, summary, labels } = opts;
  host.replaceChildren();

  let items: ToolBackup[];
  try {
    items = opts.list
      ? await opts.list()
      : await invoke<ToolBackup[]>("list_tool_backups", { toolId: opts.toolId });
  } catch (err) {
    if (summary) summary.textContent = "unavailable";
    const error = document.createElement("p");
    error.className = "placeholder-text";
    error.textContent = `Couldn't read the snapshot folder: ${String(err)}`;
    host.appendChild(error);
    return;
  }

  // Only the kinds this tool offers, and only snapshots that still hold one.
  const shown = items
    .map((item) => ({ ...item, files: item.files.filter((f) => labels[f.kind]) }))
    .filter((item) => item.files.length > 0);

  if (summary) summary.textContent = shown.length === 0 ? "none yet" : `${shown.length} kept`;

  if (shown.length === 0) {
    const empty = document.createElement("p");
    empty.className = "placeholder-text";
    empty.textContent =
      "No snapshots yet. The first one is taken the next time you change something, " +
      "capturing the state from before that change.";
    host.appendChild(empty);
    return;
  }

  shown.forEach((item, index) => {
    const group = document.createElement("div");
    group.className = "tool-backup-group";

    const head = document.createElement("div");
    head.className = "tool-backup-head";
    const when = document.createElement("span");
    when.className = "tool-backup-when";
    when.textContent = formatBackupName(item.name);
    head.appendChild(when);
    if (index === 0) {
      const badge = document.createElement("span");
      badge.className = "setup-item-retired-badge";
      badge.textContent = "Newest";
      head.appendChild(badge);
    }
    group.appendChild(head);

    for (const entry of item.files) {
      const row = document.createElement("div");
      row.className = "setup-item tool-backup-row";

      const what = document.createElement("span");
      what.className = "setup-item-name";
      what.textContent = labels[entry.kind] ?? entry.kind;
      row.appendChild(what);

      const size = document.createElement("span");
      size.className = "tool-backup-size";
      size.textContent = formatBytes(entry.bytes);
      row.appendChild(size);

      const restore = document.createElement("button");
      restore.type = "button";
      restore.className = "settings-action-btn";
      restore.textContent = "Restore";
      restore.addEventListener("click", () => void opts.onRestore(entry, item));
      row.appendChild(restore);

      group.appendChild(row);
    }

    host.appendChild(group);
  });
}

/** Reads one captured file. Returns its contents; writing them back is the
 *  caller's job, deliberately (see the header). */
export function readToolBackup(
  toolId: string,
  snapshotName: string,
  kind: string,
): Promise<string> {
  return invoke<string>("read_tool_backup", { toolId, name: snapshotName, kind });
}
