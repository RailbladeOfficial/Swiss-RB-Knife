/* =============================================================================
   THE DATA FOLDER COMPATIBILITY CHECK
   -----------------------------------------------------------------------------
   The front half of the version stamp described in lib.rs. Two jobs, and they
   happen at different moments on purpose:

     1. DECIDE, before any tool loads. A folder written by a newer build freezes
        every write for the session. This has to run first, because a tool that
        has already loaded will save the moment anything is touched, and by then
        the damage is the thing this exists to prevent.

     2. EXPLAIN, once the window is up. The message is the first startup gate,
        ahead of the app lock, because it is the answer to "why does nothing I
        do stick?" and a person who cannot get past the lock never sees it.

   WHY FREEZING AND NOT WARNING. Every file in a newer folder still parses. The
   fields this build does not know about are dropped on the way in, silently and
   correctly, and the first save writes the folder back without them. Nothing
   looks wrong at any point. A banner over a tool that saves anyway is a banner
   that watched it happen.
============================================================================= */

import { invoke } from "@tauri-apps/api/core";

import { devError } from "./dev-log";
import { freezeAllWrites } from "./tool-store";

interface DataFolderStatus {
  state: "fresh" | "ok" | "newer" | "unreadable";
  found: number | null;
  supported: number;
}

/** What the check decided, held for the gate to explain later. */
let outcome: DataFolderStatus | null = null;

/**
 * Asks what was decided and freezes writes if the folder is not one this build
 * should write to. Call BEFORE any tool initializes.
 *
 * THE DECISION IS NOT MADE HERE. It is made in setup(), straight after the
 * migrations and before any command can run, and the folder is stamped there
 * too. This only fetches the answer and acts on it, so nothing depends on the
 * front end asking early enough.
 *
 * A failure to fetch it is treated as "carry on". The check guards against a
 * specific, rare mistake; making the app unusable because the guard itself
 * could not be reached would be a worse failure than the one it prevents.
 */
export async function checkDataFolder(): Promise<void> {
  try {
    outcome = await invoke<DataFolderStatus>("data_folder_status");
  } catch (err) {
    devError("[data-version] the folder check could not run", err);
    outcome = null;
    return;
  }

  if (outcome.state === "newer") {
    freezeAllWrites(
      `This data folder was written by a newer version of Swiss RB Knife ` +
        `(format ${outcome.found}, this build understands ${outcome.supported}). ` +
        `Nothing will be saved, so that version's data stays intact. Close this ` +
        `and open the newer version instead.`,
    );
    return;
  }
  if (outcome.state === "unreadable") {
    freezeAllWrites(
      "This data folder's version stamp could not be read, so which version " +
        "wrote it is unknown and nothing will be saved. Close the app, then " +
        "repair or delete app/data-version.json.",
    );
    return;
  }

}

/**
 * The first startup gate: says what is wrong, and offers the two things that
 * are actually useful.
 *
 * Resolves once the person has answered, so the rest of the gate sequence
 * queues behind it rather than opening on top of it.
 */
export async function showDataFolderGate(deps: {
  confirm: (
    opts: { title: string; message: string; confirmLabel: string; reopen?: () => void },
    onConfirm: () => void,
  ) => void;
  quit: () => void;
}): Promise<void> {
  if (!outcome || (outcome.state !== "newer" && outcome.state !== "unreadable")) return;

  const message =
    outcome.state === "newer"
      ? `This data folder was written by a newer version of Swiss RB Knife. It is ` +
        `in format ${outcome.found}, and this build reads format ${outcome.supported}.\n\n` +
        `Everything is still here and nothing has been changed. Saving has been ` +
        `turned off for this session, so opening the newer version again will find ` +
        `its data exactly as it left it.`
      : `The file recording which version wrote this data folder could not be read, ` +
        `so there is no way to tell whether this build should be writing to it.\n\n` +
        `Saving has been turned off for this session. Nothing has been changed.`;

  await new Promise<void>((resolve) => {
    deps.confirm(
      {
        title: "This data folder is not one this version can write to",
        message,
        confirmLabel: "Close Swiss RB Knife",
        /* Dismissing leaves the app open and read-only, which is a real
           answer: looking something up in a folder you must not write to is
           exactly what a read-only session is for. `reopen` is the shared
           confirm's dismissal hook, and it also fires on Escape, so the gate
           sequence continues however this was answered rather than hanging on
           a promise nothing will ever settle. */
        reopen: resolve,
      },
      () => {
        resolve();
        deps.quit();
      },
    );
  });
}
