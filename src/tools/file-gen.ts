/* =============================================================================
   DUMMY FILE GENERATOR
   -----------------------------------------------------------------------------
   Frontend logic for the Dummy File Generator tool. File generation runs in
   Rust via invoke(); this file owns batch entry state, UI rendering, the
   extension-picker modal, and result display.

   Architecture notes:
     • batchEntries[] is the source of truth for the batch list. renderBatchList()
       rebuilds the DOM from it on every add/remove; individual input changes
       update the array directly via change listeners.
     • The extension-picker modal uses activeExtInput to track which entry card's
       extension field it was opened from, so pill selection can write back to the
       correct input. See openExtModal / closeExtModal.
     • Uncommitted DOM values are flushed from inputs into batchEntries[] at the
       start of handleGenerate() to catch values that changed without firing a
       change event (e.g. typing without blurring).

   Rust commands used:
     dfg_generate_files
============================================================================= */

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { flash, escapeHtml } from "../shell";
import { Modal } from "../modal";

/* =============================================================================
   TYPES
============================================================================= */

interface GenerateResult {
  folder: string;
  totalCount: number;
  breakdown: { extension: string; count: number }[];
}

type NamingMode   = "numeric" | "alpha" | "hex";
type OrganizeMode = "flat" | "byext" | "byline";

interface BatchEntry {
  count: number;
  prefix: string;
  namingMode: NamingMode;
  suffix: string;
  extension: string;
}

/* =============================================================================
   CONSTANTS
============================================================================= */

const TEXT_EXTENSIONS = new Set([
  ".txt", ".csv", ".json", ".md", ".html", ".xml", ".js", ".css", ".log",
  ".tsv", ".yaml", ".rb", ".py", ".java", ".cpp", ".c", ".php", ".pl",
  ".sh", ".bat", ".ini", ".conf", ".sql", ".r", ".go", ".swift", ".scala",
  ".doc", ".docx", ".rtf", ".odt", ".tex", ".markdown", ".ts", ".jsx",
  ".tsx", ".vue", ".toml", ".env", ".gitignore",
]);

const BINARY_EXTENSIONS = new Set([
  ".bmp", ".jpg", ".jpeg", ".png", ".gif", ".webp", ".ico", ".tiff", ".svg",
  ".mp3", ".wav", ".ogg", ".flac", ".aac", ".m4a",
  ".mp4", ".mkv", ".avi", ".mov", ".wmv", ".webm",
  ".zip", ".tar", ".gz", ".rar", ".7z",
  ".pdf", ".epub", ".xlsx", ".pptx",
  ".exe", ".dll", ".so", ".bin", ".iso",
]);

const ALL_EXTENSIONS = new Set([...TEXT_EXTENSIONS, ...BINARY_EXTENSIONS]);

const ORGANIZE_LABELS: Record<OrganizeMode, string> = {
  flat:   "One folder",
  byext:  "Subfolders by extension",
  byline: "Subfolders by line",
};

/* =============================================================================
   STATE
============================================================================= */

let batchEntries: BatchEntry[] = [];
let organizeMode: OrganizeMode = "flat";

// The extension input currently targeted by the ext-picker modal.
// Set by openExtModal() when a card's picker button is clicked, so the modal
// knows which entry's extension field to write back to on pill selection.
// Cleared to null by closeExtModal() after the modal closes.
let activeExtInput: HTMLInputElement | null = null;

/* =============================================================================
   ELEMENT REFS
============================================================================= */

let outputDirInput:   HTMLInputElement;
let browseDirBtn:     HTMLButtonElement;
let generateBtn:      HTMLButtonElement;
let resetBtn:         HTMLButtonElement;
let batchList:        HTMLElement;
let addEntryBtn:      HTMLButtonElement;
let resultsList:      HTMLElement;
let organizeSublabel: HTMLElement;

// Ext-picker modal. Modal instance created in bindExtModal once DOM is ready
let extModal: Modal;

/* =============================================================================
   VALIDATION
============================================================================= */

function normaliseExtension(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return trimmed.startsWith(".") ? trimmed.toLowerCase() : `.${trimmed.toLowerCase()}`;
}

function validateExtension(ext: string): string | null {
  if (!ext) return "Extension is required.";
  if (!ALL_EXTENSIONS.has(ext)) return `Unsupported extension "${ext}".`;
  return null;
}

function validateCount(raw: string): string | null {
  const n = parseInt(raw, 10);
  if (!raw.trim() || isNaN(n)) return "Count must be a positive integer.";
  if (n <= 0) return "Count must be greater than zero.";
  if (n > 10000) return "Count cannot exceed 10,000 per type.";
  return null;
}

/* =============================================================================
   EXT-PICKER MODAL
============================================================================= */

function openExtModal(targetInput: HTMLInputElement): void {
  activeExtInput = targetInput;
  // Highlight the pill matching the current value
  const current = normaliseExtension(targetInput.value);
  document.querySelectorAll<HTMLElement>("#dfg-ext-modal .dfg-ext-pill").forEach((p) => {
    p.classList.toggle("active", p.dataset.ext === current);
  });
  extModal.open();
}

function closeExtModal(): void {
  extModal.close();
  activeExtInput = null;
}

function bindExtModal(): void {
  extModal = new Modal(document.getElementById("dfg-ext-backdrop")!);
  document.getElementById("dfg-ext-modal-close")!.addEventListener("click", closeExtModal);

  // Pill clicks: write to the active input, sync state, close modal
  document.querySelectorAll<HTMLElement>("#dfg-ext-modal .dfg-ext-pill").forEach((pill) => {
    pill.addEventListener("click", () => {
      const ext = pill.dataset.ext ?? "";
      if (activeExtInput) {
        activeExtInput.value = ext;
        // Fire a change event so the state array updates
        activeExtInput.dispatchEvent(new Event("change", { bubbles: true }));
      }
      closeExtModal();
    });
  });
}

/* =============================================================================
   RESULTS LIST
============================================================================= */

function appendResult(state: "success" | "error", title: string, detail: string, folder: string): void {
  const card = document.createElement("div");
  card.className = `dfg-result-card dfg-result-card--${state}`;
  const icon = state === "success" ? "\u2713" : "\u2715";
  // title/detail/folder all pass through escapeHtml: detail carries backend
  // error messages that quote user input verbatim (offending prefixes,
  // extensions), and folder is a user-chosen path.
  card.innerHTML = `
    <span class="dfg-status-icon">${icon}</span>
    <div class="dfg-status-text">
      <span class="dfg-status-title">${escapeHtml(title)}</span>
      <span class="dfg-status-detail">${escapeHtml(detail)}</span>
      ${folder ? `<span class="dfg-status-folder">${escapeHtml(folder)}</span>` : ""}
    </div>
    <button class="modal-cancel-btn dfg-status-clear-btn" title="Clear this result">Clear</button>
  `;
  card.querySelector(".dfg-status-clear-btn")!.addEventListener("click", () => {
    card.remove();
    flash("Result cleared", "success");
  });
  resultsList.insertBefore(card, resultsList.firstChild);
}

function clearAllResults(): void {
  resultsList.innerHTML = "";
}

/* =============================================================================
   BATCH ENTRY LIST
============================================================================= */

function renderBatchList(): void {
  batchList.innerHTML = "";

  batchEntries.forEach((entry, idx) => {
    const card = document.createElement("div");
    card.className = "dfg-entry-card";
    card.dataset.idx = String(idx);

    const modes: NamingMode[] = ["numeric", "alpha", "hex"];
    const modeLabels: Record<NamingMode, string> = { numeric: "123", alpha: "abc", hex: "0xF" };
    const namingBtns = modes.map((m) =>
      `<button class="dfg-naming-btn${entry.namingMode === m ? " active" : ""}" data-mode="${m}">${modeLabels[m]}</button>`
    ).join("");

    const disabledAttr = batchEntries.length <= 1 ? " disabled" : "";

    card.innerHTML = `
      <div class="dfg-entry-row-a">
        <input class="dfg-batch-count" type="number" min="1" max="10000"
          placeholder="Count" value="${entry.count > 0 ? entry.count : ""}" autocomplete="off" />
        <div class="dfg-naming-group">${namingBtns}</div>
        <button class="dfg-batch-remove"${disabledAttr} title="Remove">\u2715</button>
      </div>
      <div class="dfg-entry-row-b">
        <div class="dfg-entry-field">
          <span class="dfg-entry-field-label">Prefix</span>
          <input class="dfg-batch-prefix" type="text" placeholder="prefix-"
            value="${escapeHtml(entry.prefix)}" autocomplete="off" />
        </div>
        <div class="dfg-entry-field">
          <span class="dfg-entry-field-label">Extension</span>
          <div class="dfg-ext-field-row">
            <input class="dfg-batch-ext" type="text" placeholder=".txt"
              value="${escapeHtml(entry.extension)}" autocomplete="off" spellcheck="false" />
            <button class="dfg-ext-picker-btn modal-cancel-btn" title="Pick extension">\u229e</button>
          </div>
        </div>
        <div class="dfg-entry-field">
          <span class="dfg-entry-field-label">Suffix</span>
          <input class="dfg-batch-suffix" type="text" placeholder="-suffix"
            value="${escapeHtml(entry.suffix)}" autocomplete="off" />
        </div>
      </div>
    `;

    const countEl   = card.querySelector<HTMLInputElement>(".dfg-batch-count")!;
    const prefixEl  = card.querySelector<HTMLInputElement>(".dfg-batch-prefix")!;
    const extEl     = card.querySelector<HTMLInputElement>(".dfg-batch-ext")!;
    const suffixEl  = card.querySelector<HTMLInputElement>(".dfg-batch-suffix")!;
    const removeEl  = card.querySelector<HTMLButtonElement>(".dfg-batch-remove")!;
    const pickerBtn = card.querySelector<HTMLButtonElement>(".dfg-ext-picker-btn")!;

    countEl.addEventListener("change",  () => { batchEntries[idx].count     = parseInt(countEl.value, 10) || 0; });
    prefixEl.addEventListener("change", () => { batchEntries[idx].prefix    = prefixEl.value; });
    suffixEl.addEventListener("change", () => { batchEntries[idx].suffix    = suffixEl.value; });
    extEl.addEventListener("change", () => {
      batchEntries[idx].extension = normaliseExtension(extEl.value);
      extEl.value = batchEntries[idx].extension;
    });

    pickerBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openExtModal(extEl);
    });

    card.querySelectorAll<HTMLButtonElement>(".dfg-naming-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        batchEntries[idx].namingMode = btn.dataset.mode as NamingMode;
        card.querySelectorAll<HTMLButtonElement>(".dfg-naming-btn").forEach((b) => {
          b.classList.toggle("active", b.dataset.mode === btn.dataset.mode);
        });
      });
    });

    removeEl.addEventListener("click", () => {
      batchEntries.splice(idx, 1);
      renderBatchList();
    });

    batchList.appendChild(card);
  });
}

function addBatchEntry(): void {
  batchEntries.push({ count: 0, prefix: "", namingMode: "numeric", suffix: "", extension: "" });
  renderBatchList();
  const cards = batchList.querySelectorAll<HTMLElement>(".dfg-entry-card");
  cards[cards.length - 1]?.querySelector<HTMLInputElement>(".dfg-batch-count")?.focus();
}

/* =============================================================================
   ORGANIZE BUTTONS
============================================================================= */

function bindOrganizeButtons(): void {
  document.querySelectorAll<HTMLButtonElement>(".dfg-organize-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      organizeMode = btn.dataset.mode as OrganizeMode;
      document.querySelectorAll<HTMLButtonElement>(".dfg-organize-btn").forEach((b) => {
        b.classList.toggle("active", b.dataset.mode === organizeMode);
      });
      organizeSublabel.textContent = ORGANIZE_LABELS[organizeMode];
    });
  });
}

/* =============================================================================
   GENERATE
============================================================================= */

async function handleGenerate(): Promise<void> {
  // Flush un-committed DOM values
  batchList.querySelectorAll<HTMLElement>(".dfg-entry-card").forEach((card, idx) => {
    const countEl  = card.querySelector<HTMLInputElement>(".dfg-batch-count");
    const prefixEl = card.querySelector<HTMLInputElement>(".dfg-batch-prefix");
    const extEl    = card.querySelector<HTMLInputElement>(".dfg-batch-ext");
    const suffixEl = card.querySelector<HTMLInputElement>(".dfg-batch-suffix");
    if (countEl)  batchEntries[idx].count     = parseInt(countEl.value, 10) || 0;
    if (prefixEl) batchEntries[idx].prefix    = prefixEl.value;
    if (extEl)    batchEntries[idx].extension = normaliseExtension(extEl.value);
    if (suffixEl) batchEntries[idx].suffix    = suffixEl.value;
  });

  const errors: string[] = [];
  const hasMultiple = batchEntries.length > 1;
  batchEntries.forEach((entry, idx) => {
    const label    = hasMultiple ? `Row ${idx + 1}: ` : "";
    const countErr = validateCount(String(entry.count));
    const extErr   = validateExtension(entry.extension);
    if (countErr) errors.push(`${label}${countErr}`);
    if (extErr)   errors.push(`${label}${extErr}`);
  });

  if (errors.length > 0) {
    errors.forEach((e) => flash(e, "error", 4500));
    return;
  }

  const outputDir = outputDirInput.value.trim();
  generateBtn.disabled = true;

  try {
    const result = await invoke<GenerateResult>("dfg_generate_files", {
      entries: batchEntries,
      outputDir: outputDir || null,
      organizeMode,
    });
    const folderName = result.folder.split(/[\\/]/).pop() ?? result.folder;
    const breakdown  = result.breakdown.map((b) => `${b.count}\u00d7 ${b.extension}`).join("  \u00b7  ");
    appendResult("success", `${result.totalCount} file${result.totalCount !== 1 ? "s" : ""} created`, breakdown, result.folder);
    flash(`Generated ${result.totalCount} files in ${folderName}`, "success");
  } catch (err) {
    const msg = String(err);
    appendResult("error", "Generation failed", msg, "");
    flash(`Error: ${msg}`, "error", 5000);
  } finally {
    generateBtn.disabled = false;
  }
}

/* =============================================================================
   BROWSE
============================================================================= */

async function handleBrowse(): Promise<void> {
  try {
    const selected = await open({ directory: true, multiple: false, title: "Choose output folder" });
    if (selected && typeof selected === "string") outputDirInput.value = selected;
  } catch { /* cancelled */ }
}

/* =============================================================================
   RESET
============================================================================= */

function handleReset(): void {
  batchEntries = [{ count: 0, prefix: "", namingMode: "numeric", suffix: "", extension: "" }];
  organizeMode = "flat";
  renderBatchList();
  outputDirInput.value = "";
  document.querySelectorAll<HTMLButtonElement>(".dfg-organize-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === "flat");
  });
  if (organizeSublabel) organizeSublabel.textContent = ORGANIZE_LABELS.flat;
  clearAllResults();
  flash("Tool reset", "success");
}

/* =============================================================================
   INIT
============================================================================= */

export function initFileGen(): void {
  outputDirInput   = document.getElementById("dfg-output-dir")       as HTMLInputElement;
  browseDirBtn     = document.getElementById("dfg-browse-btn")       as HTMLButtonElement;
  generateBtn      = document.getElementById("dfg-generate-btn")     as HTMLButtonElement;
  resetBtn         = document.getElementById("dfg-reset-btn")        as HTMLButtonElement;
  batchList        = document.getElementById("dfg-batch-list")!;
  addEntryBtn      = document.getElementById("dfg-add-entry-btn")    as HTMLButtonElement;
  resultsList      = document.getElementById("dfg-results-list")!;
  organizeSublabel = document.getElementById("dfg-organize-sublabel")!;

  bindOrganizeButtons();
  bindExtModal();

  batchEntries = [{ count: 0, prefix: "", namingMode: "numeric", suffix: "", extension: "" }];
  renderBatchList();

  addEntryBtn.addEventListener("click",  addBatchEntry);
  browseDirBtn.addEventListener("click", handleBrowse);
  generateBtn.addEventListener("click",  handleGenerate);
  resetBtn.addEventListener("click",     handleReset);

  batchList.addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleGenerate();
  });
}
