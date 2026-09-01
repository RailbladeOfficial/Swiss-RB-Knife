/* =============================================================================
   DATA TRANSFER: the App Settings Data tab
   -----------------------------------------------------------------------------
   One screen for getting a tool's data out to a JSON file and back in from one.

   WHY THIS EXISTS AT ALL. Two reasons, and they apply to different tools.

   Game Stats keeps its records in the database, so it has no file you can open
   in a text editor and repair by hand. That was a real safety net, and giving
   it up needs something in its place: an export holds everything required to
   rebuild the tool, and an import puts it back.

   Every other tool does still have that file, and an export is still worth
   having: a snapshot lives beside the data it protects, so it is no use for
   moving a tool to another machine or for keeping a copy somewhere else.

   WHY IMPORT REPLACES RATHER THAN MERGES. A merge has to answer "what happens
   when this already exists", and every answer is a guess at what someone meant.
   A replace has exactly one meaning, and it asks before it runs.

   WHETHER IT CAN BE UNDONE DEPENDS ON THE TOOL, and the warning has to say so
   rather than assume. Four of these tools capture the state a write replaces
   and offer a screen to put it back; the other four keep preferences and short
   lists, snapshot nothing, and an import into one of them is final. The
   confirmation used to promise an undo for all eight, which for half of them
   was not true. `snapshots` is what each tool says about itself.

   WHY THE CSV AND SPREADSHEET IMPORTERS ARE NOT HERE. Those read somebody
   else's file, so they need column matching, a preview and a per-row error
   list: Game Stats' importer alone is six screens' worth of controls. Folding
   them into a dropdown would either lose that or make this a button that opens
   them anyway. So it is a button that opens them, honestly labelled.

   ADDING A TOOL is one entry in TRANSFERABLE. Nothing else here knows the
   difference between one tool and another.
============================================================================= */

import { invoke } from "@tauri-apps/api/core";

import { devError } from "./dev-log";

/** What one tool needs in order to be exported and imported. */
export interface Transferable {
  /** Matches the tool ids used by the shared file store and the database. */
  id: string;
  label: string;
  /** Everything this tool holds, as the object that goes in the file. */
  gather: () => Promise<unknown>;
  /** Puts a parsed export back, replacing what is there. Throws with a sentence
   *  worth showing if the file is not one of this tool's. */
  apply: (parsed: unknown) => Promise<void>;
  /** A one-line readout for the tool row, e.g. "3 boards · 40 cards". */
  summary?: () => string;
  /** A tool-specific importer this screen deliberately does not replace. */
  otherFormats?: { label: string; open: () => void };
  /** Shown under the buttons. Anything true and worth knowing before you press
   *  one, such as what an export does not carry. */
  note?: string;
  /** Whether this tool captures what a write replaces AND has a screen to put
   *  it back. Decides whether the import warning offers an undo. Set it only
   *  where both halves are true: a snapshot nothing can reach is not an undo. */
  snapshots?: boolean;
}

const TRANSFERABLE: Transferable[] = [];

/** Tools register themselves as they initialise, so this module does not have
 *  to import every tool and put itself in the middle of the load order. */
export function registerTransferable(entry: Transferable): void {
  const at = TRANSFERABLE.findIndex((t) => t.id === entry.id);
  if (at === -1) TRANSFERABLE.push(entry);
  else TRANSFERABLE[at] = entry;
}

/** The version stamped into every export. Read on import: a file from a future
 *  version is refused rather than half-understood. */
const EXPORT_VERSION = 1;

interface ExportEnvelope {
  app: "swiss-rb-knife";
  tool: string;
  version: number;
  exportedAt: string;
  data: unknown;
}

let wired = false;
let flashFn: (msg: string, kind?: "success" | "error", ms?: number) => void = () => {};
let confirmFn: (opts: { title: string; message: string; confirmLabel: string },
                onConfirm: () => void) => void = (_o, run) => run();

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

function current(): Transferable | null {
  const select = document.getElementById("dataToolSelect") as HTMLSelectElement | null;
  if (!select) return null;
  return TRANSFERABLE.find((t) => t.id === select.value) ?? null;
}

/** Fills the dropdown and draws the row for whichever tool is chosen. Called
 *  every time the tab is opened, because a tool's summary changes as it is
 *  used and a stale count is worse than none. */
export function refreshDataTab(): void {
  const select = document.getElementById("dataToolSelect") as HTMLSelectElement | null;
  if (!select) return;
  wire();

  const chosen = select.value;
  select.replaceChildren();
  for (const tool of TRANSFERABLE) {
    const option = document.createElement("option");
    option.value = tool.id;
    option.textContent = tool.label;
    select.appendChild(option);
  }
  if (TRANSFERABLE.some((t) => t.id === chosen)) select.value = chosen;

  drawRow();
}

function drawRow(): void {
  const tool = current();
  const summary = document.getElementById("dataToolSummary");
  const note = document.getElementById("dataToolNote");
  const other = document.getElementById("dataOtherFormats");
  const otherLabel = document.getElementById("dataOtherFormatsLabel");

  if (summary) summary.textContent = tool?.summary?.() ?? "";
  if (note) note.textContent = tool?.note ?? "";
  if (other) other.style.display = tool?.otherFormats ? "" : "none";
  if (otherLabel && tool?.otherFormats) otherLabel.textContent = tool.otherFormats.label;
}

function wire(): void {
  if (wired) return;
  wired = true;

  (document.getElementById("dataToolSelect") as HTMLSelectElement)
    .addEventListener("change", drawRow);

  document.getElementById("dataExportBtn")!.addEventListener("click", () => void doExport());
  document.getElementById("dataImportBtn")!.addEventListener("click", () => void doImport());
  document.getElementById("dataOtherFormatsBtn")!.addEventListener("click", () => {
    current()?.otherFormats?.open();
  });
}

/** A filename that says what it is and when, so a folder of them is readable
 *  without opening any. */
function suggestedName(tool: Transferable): string {
  const day = new Date().toLocaleDateString("en-CA");
  return `${tool.id}-${day}.json`;
}

/* THE FILE DIALOGS BELONG TO THE BACKEND, not to this module, and that is why
   neither of these opens one. A path chosen here would be a path the backend
   had to take on trust, and it writes as Administrator. The command opens the
   dialog itself and returns null if it was closed. See the note above
   export_tool_json in lib.rs. */

async function doExport(): Promise<void> {
  const tool = current();
  if (!tool) return;
  try {
    const envelope: ExportEnvelope = {
      app: "swiss-rb-knife",
      tool: tool.id,
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      data: await tool.gather(),
    };
    // Indented: an export is meant to be readable and diffable outside this
    // app, which one long line is useless for.
    const written = await invoke<string | null>("export_tool_json", {
      suggestedName: suggestedName(tool),
      data: JSON.stringify(envelope, null, 2),
    });
    if (written === null) return; // dialog closed
    flashFn(`Exported ${tool.label} to ${written}`, "success", 8000);
  } catch (err) {
    devError("[data] export failed", err);
    flashFn(`Export failed: ${String(err)}`, "error", 9000);
  }
}

async function doImport(): Promise<void> {
  const tool = current();
  if (!tool) return;
  try {
    const raw = await invoke<string | null>("import_tool_json");
    if (raw === null) return; // dialog closed

    const envelope = JSON.parse(raw) as Partial<ExportEnvelope>;

    // Checked before anything is replaced. Importing Game Stats into the Kanban
    // would otherwise empty one tool and fill it with nonsense.
    if (envelope.app !== "swiss-rb-knife" || typeof envelope.tool !== "string") {
      throw new Error("that file was not exported by this app");
    }
    if (envelope.tool !== tool.id) {
      const other = TRANSFERABLE.find((t) => t.id === envelope.tool);
      throw new Error(
        `that file holds ${other ? other.label : envelope.tool} data, not ${tool.label}`,
      );
    }
    if (typeof envelope.version === "number" && envelope.version > EXPORT_VERSION) {
      throw new Error("that file came from a newer version of the app");
    }

    confirmFn(
      {
        title: `Replace all ${tool.label} data?`,
        message:
          `Everything ${tool.label} currently holds is replaced by the contents of this file. ` +
          (tool.snapshots
            ? `A snapshot of the current state is taken first, which the Data tab in ${tool.label}'s own settings can put back.`
            : `${tool.label} keeps no snapshots, so this cannot be undone. Export the current data first if you might want it back.`),
        confirmLabel: "Replace",
      },
      () => {
        void (async () => {
          try {
            await tool.apply(envelope.data);
            flashFn(`Imported ${tool.label}.`, "success", 8000);
            drawRow();
          } catch (err) {
            devError("[data] import failed", err);
            flashFn(`Import failed: ${String(err)}`, "error", 9000);
          }
        })();
      },
    );
  } catch (err) {
    devError("[data] import failed", err);
    flashFn(`Import failed: ${String(err)}`, "error", 9000);
  }
}
