/* =============================================================================
   DATA TRANSFER: the App Settings Data tab
   -----------------------------------------------------------------------------
   Two buttons over the whole data folder. Export writes a zip of it; Import
   replaces it with one.

   WHAT THIS REPLACED, AND WHY. This screen used to be a dropdown of tools, each
   with its own pair of hand-written functions saying what to gather and how to
   put it back. Seven pairs is seven things that have to stay correct as seven
   tools change, and each one was a promise that a JSON file held everything
   that tool owned. Several of those promises were quietly partial: an export
   carried a tool's records but not its snapshots, not its attachments, and not
   the settings that decide how the records are read.

   A zip of the folder promises nothing it cannot keep, because it IS the
   folder. That matters more than tidiness here: a backup you cannot inspect is
   one you are trusting rather than one you have checked, and this one opens in
   Explorer.

   It also settled the encryption question. Budget's files are copied byte for
   byte, so an encrypted budget stays encrypted inside the archive. Gathering
   through the tool meant decrypting into memory first, which put budget records
   in the clear in a file, from a tool the user had deliberately locked.

   WHY IMPORT RESTARTS THE APP. It replaces files that are open while the app
   runs (the database connection, settings.json) and would leave every tool in
   the front end holding state that no longer matches the disk. So an import is
   two phases: unpack to a staging folder now, swap it in on the next launch
   before anything has opened a file. See src-tauri/src/data_archive.rs, which
   owns both halves and keeps the folder it replaced.

   THE FILE DIALOGS BELONG TO THE BACKEND. A path chosen here would be a path
   the backend had to take on trust, and it writes as Administrator. Each
   command opens its own dialog and returns null if it was closed.
============================================================================= */

import { invoke } from "@tauri-apps/api/core";

import { devError } from "./dev-log";
import { formatDataSize } from "./format";

/** What the folder holds right now, for the readout above the buttons. */
interface DataSummary {
  fileCount: number;
  totalBytes: number;
  path: string;
}

/** What an import has unpacked and is holding for the next launch. */
interface StagedImport {
  fileCount: number;
  totalBytes: number;
  exportedAt: string;
  appVersion: string;
}

/** What happened at launch to an import armed on the run before. */
interface ImportResult {
  state: "applied" | "failed";
  replaced: string | null;
  message: string;
}

/** A dev build closes rather than restarting to apply an import: `tauri dev`
 *  cannot follow an app that relaunches itself. See restart_for_import. */
const APPLY_BY_CLOSING = import.meta.env.DEV;

let wired = false;
let flashFn: (msg: string, kind?: "success" | "error", ms?: number) => void = () => {};
let confirmFn: (
  opts: { title: string; message: string; confirmLabel: string; reopen?: () => void; notice?: boolean },
  onConfirm: () => void,
) => void = (_o, run) => run();

/** Hands over the two shell services this screen needs. Passed in rather than
 *  imported, because shell.ts imports this module and the reverse would put the
 *  two in a load-order loop. */
export function initDataTransfer(deps: {
  flash: typeof flashFn;
  confirm: typeof confirmFn;
}): void {
  flashFn = deps.flash;
  confirmFn = deps.confirm;
}

/**
 * Says what happened to an import armed on the last run, once, at startup.
 *
 * The swap runs before the window exists, so this is the only way its outcome
 * reaches a person. A failure used to go to a log line and nowhere else, and
 * the import simply sat there unapplied with no explanation.
 *
 * Resolves once a failure has been read, so the startup gates queue behind it.
 */
export async function showImportResult(): Promise<void> {
  let result: ImportResult | null;
  try {
    result = await invoke<ImportResult | null>("take_import_result");
  } catch (err) {
    devError("[data] could not read the import result", err);
    return;
  }
  if (!result) return;

  if (result.state === "applied") {
    flashFn(
      result.replaced
        ? `Your data was imported. The folder it replaced is kept at ${result.replaced}`
        : "Your data was imported.",
      "success",
      12000,
    );
    return;
  }

  await new Promise<void>((resolve) => {
    confirmFn(
      {
        title: "Your import was not applied",
        message: result.message,
        confirmLabel: "OK",
        // Nothing to decide, so one button and no Cancel, and dismissing is
        // as good an answer as OK.
        notice: true,
        reopen: resolve,
      },
      resolve,
    );
  });
}

/* -----------------------------------------------------------------------------
   DRAWING THE TAB
----------------------------------------------------------------------------- */

/** Re-reads the folder and redraws the tab. Called every time it is opened,
 *  because the counts change as the app is used and a stale size is worse than
 *  none. */
export function refreshDataTab(): void {
  if (!document.getElementById("dataExportBtn")) return;
  wire();
  void drawSummary();
  void drawPending();
}

async function drawSummary(): Promise<void> {
  const badge = document.getElementById("dataFolderSummary");
  const path = document.getElementById("dataFolderPath");
  try {
    const summary = await invoke<DataSummary>("app_data_summary");
    if (badge) {
      badge.textContent =
        `${summary.fileCount} ${summary.fileCount === 1 ? "file" : "files"} · ` +
        formatDataSize(summary.totalBytes);
    }
    if (path) path.textContent = summary.path;
  } catch (err) {
    devError("[data] could not measure the data folder", err);
    // Said plainly rather than left blank: an empty badge reads as a count
    // that failed to load, which is exactly what it would be.
    if (badge) badge.textContent = "could not be read";
    if (path) path.textContent = "";
  }
}

/** The "waiting to apply" row, shown only while an import is staged. An app
 *  closed before restarting comes back still holding one, so this is read on
 *  every open of the tab rather than only after an import. */
async function drawPending(): Promise<void> {
  const row = document.getElementById("dataImportPending");
  const badge = document.getElementById("dataImportPendingBadge");
  if (!row) return;
  try {
    const waiting = await invoke<boolean>("staged_import_waiting");
    row.style.display = waiting ? "" : "none";
    // "Not applied" rather than "restart to apply": a staged copy does nothing
    // until Restart Now is pressed, and a badge that reads like an instruction
    // would suggest an ordinary restart is enough to trigger it.
    if (badge) badge.textContent = waiting ? "unpacked, not applied" : "";
  } catch (err) {
    devError("[data] could not check for a staged import", err);
    row.style.display = "none";
  }
}

function wire(): void {
  if (wired) return;
  wired = true;

  document.getElementById("dataExportBtn")!.addEventListener("click", () => void doExport());
  document.getElementById("dataImportBtn")!.addEventListener("click", () => void doImport());

  document.getElementById("dataFolderOpenBtn")!.addEventListener("click", () => {
    void (async () => {
      const path = document.getElementById("dataFolderPath")?.textContent ?? "";
      if (!path) return;
      try {
        await invoke("show_in_explorer", { path });
      } catch (err) {
        devError("[data] could not open the data folder", err);
        flashFn("Could not open the data folder.", "error");
      }
    })();
  });

  const restartBtn = document.getElementById("dataImportRestartBtn")!;
  if (APPLY_BY_CLOSING) {
    restartBtn.textContent = "Close to Apply";
    restartBtn.title = "Dev build: the app closes, and the import is applied the next time you run npm run tauri dev.";
  }
  restartBtn.addEventListener("click", () => {
    void (async () => {
      try {
        // Never returns on success: the process is replaced, or closed in dev.
        await invoke("restart_for_import");
      } catch (err) {
        devError("[data] could not restart", err);
        flashFn(`Could not restart: ${String(err)}`, "error", 9000);
      }
    })();
  });

  document.getElementById("dataImportDiscardBtn")!.addEventListener("click", () => {
    confirmFn(
      {
        title: "Discard the staged import?",
        message:
          "The unpacked copy is deleted. Nothing else changes: a staged import does " +
          "nothing until Restart Now is pressed, so your data folder has not been touched.",
        confirmLabel: "Discard",
      },
      () => {
        void (async () => {
          try {
            await invoke("cancel_staged_import");
            flashFn("Staged import discarded.");
            void drawPending();
          } catch (err) {
            devError("[data] could not discard the staged import", err);
            flashFn(`Could not discard it: ${String(err)}`, "error", 9000);
          }
        })();
      },
    );
  });
}

/* -----------------------------------------------------------------------------
   EXPORT
----------------------------------------------------------------------------- */

async function doExport(): Promise<void> {
  const button = document.getElementById("dataExportBtn") as HTMLButtonElement;
  // Zipping a folder with attachments in it is not instant, and a second press
  // would open a second dialog over the first.
  button.disabled = true;
  try {
    const written = await invoke<string | null>("export_app_data");
    if (written === null) return; // dialog closed
    flashFn(`Exported your data to ${written}`, "success", 9000);
  } catch (err) {
    devError("[data] export failed", err);
    flashFn(`Export failed: ${String(err)}`, "error", 9000);
  } finally {
    button.disabled = false;
  }
}

/* -----------------------------------------------------------------------------
   IMPORT
----------------------------------------------------------------------------- */

async function doImport(): Promise<void> {
  const button = document.getElementById("dataImportBtn") as HTMLButtonElement;
  button.disabled = true;
  try {
    /* Unpacks to a staging folder and touches nothing live. Every reason to
       refuse an archive (not ours, from a newer build, an entry pointing
       outside the folder, empty) is decided in there, BEFORE this asks the user
       anything: a confirmation offered for a file that was never going to work
       is a question with no right answer. */
    const staged = await invoke<StagedImport | null>("import_app_data");
    if (staged === null) return; // dialog closed

    const when = describeExportDate(staged.exportedAt);
    confirmFn(
      {
        title: "Replace all of your data?",
        message:
          `That archive holds ${staged.fileCount} ${staged.fileCount === 1 ? "file" : "files"} ` +
          `(${formatDataSize(staged.totalBytes)}), exported from version ${staged.appVersion}${when}. ` +
          `Everything this app currently holds is replaced by it: every tool, every setting, ` +
          `every snapshot. ` +
          (APPLY_BY_CLOSING
            ? `This is a dev build, so the app closes, and the import is applied the next time ` +
              `you run npm run tauri dev. `
            : `The app restarts to apply it. `) +
          `The folder it replaces is kept beside the new one so you can get back to it.`,
        confirmLabel: APPLY_BY_CLOSING ? "Replace and Close" : "Replace and Restart",
      },
      () => {
        void (async () => {
          try {
            await invoke("restart_for_import");
          } catch (err) {
            devError("[data] could not restart", err);
            flashFn(`Could not restart: ${String(err)}`, "error", 9000);
            void drawPending();
          }
        })();
      },
    );
    /* Drawn now as well, not only after the confirm. Declining leaves the
       unpacked copy on disk, INERT: the swap keys off a marker that only the
       restart writes, so saying no changes nothing and a later restart applies
       nothing either. The row is the only thing that says the copy is there,
       and the only place to throw it away. */
    void drawPending();
  } catch (err) {
    devError("[data] import failed", err);
    flashFn(`Import failed: ${String(err)}`, "error", 9000);
  } finally {
    button.disabled = false;
  }
}

/** ", taken on <date>" for a timestamp that parses, and nothing at all for one
 *  that does not. The date is how someone tells two backups apart, so it is
 *  worth naming; a bad one is not worth saying "Invalid Date" over. */
function describeExportDate(raw: string): string {
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) return "";
  return `, taken on ${at.toLocaleString()}`;
}
