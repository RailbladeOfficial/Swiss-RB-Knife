/* =============================================================================
   RNGESUS  (random number generator)
   -----------------------------------------------------------------------------
   Draws numbers in a range. Whole or fractional, one at a time or a hundred at
   once, either replacing the last draw or piling up on top of it.

   Architecture notes:
     • THE RESULTS ARE THE STATE, not a rendering of it. Every number that has
       ever been kept lives in `results` with its own id and the batch it came
       from, and both views (grid and rows) are drawn from that one array. That
       is what makes "remove this one" a real operation rather than a display
       trick, and what lets the view be switched without disturbing anything.
     • KEEPING HISTORY IS A MODE, NOT A BUFFER. In "keep" mode a generation
       appends and nothing is thrown away until the user says so; in "replace"
       mode it clears first. The distinction is made once, at generation time,
       so nothing downstream has to care which mode produced the pool it is
       looking at.
     • THE POOL IS PERSISTED. Numbers you can't reconstruct are exactly the
       kind of thing that must not evaporate with the window: re-rolling does
       not give you them back, it gives you different ones. So the pool goes to
       disk with the settings and comes back on next launch.
     • RANDOMNESS COMES FROM THE CSPRNG, via randomUnit() below, rather than
       Math.random(). Not because this is a security context, but because
       Math.random() carries no guarantee about its distribution and a tool
       whose entire output is "a fair number" should not be resting on that.

   Rust commands used:
     save_rng_data, load_rng_data
============================================================================= */

import { invoke } from "@tauri-apps/api/core";
import { flash, escapeHtml } from "../core/shell";
import { attachMenuDelegated } from "../menu/menu";

/* =============================================================================
   TYPES
============================================================================= */

/** How the pool is laid out. "grid" is one comma-separated run that wraps,
 *  for reading and copying out; "rows" is a scrolling list where each number
 *  can be struck out individually. */
type OutputMode = "grid" | "rows";

interface RngSettings {
  min: number;
  max: number;
  /** Whether draws are fractional. Off means whole numbers, and `places` is
   *  then irrelevant rather than zero, so the field keeps its value while the
   *  toggle is off instead of being reset to nothing. */
  decimals: boolean;
  places: number;
  /** How many numbers one press of Generate draws. */
  count: number;
  /** True keeps every previous draw and appends; false clears first. */
  keepHistory: boolean;
  outputMode: OutputMode;
}

interface RngResult {
  id: string;
  value: number;
  /** How many decimal places this number was drawn to, carried per number
   *  rather than read from the live settings. A pool generated at 2 places
   *  must keep reading as 2 places after the setting is changed, otherwise
   *  changing the setting would silently rewrite history. */
  places: number;
  /** Which press of Generate produced it. Numbering the rows by batch is what
   *  makes a kept history legible instead of one long undifferentiated run. */
  batch: number;
}

interface RngStore {
  settings: RngSettings | null;
  results: RngResult[];
}

/* =============================================================================
   CONSTANTS
============================================================================= */

/** Bounds on the range itself. Well inside the 2^53 where a double stops being
 *  able to tell consecutive integers apart, so every whole number the tool can
 *  be asked for is a number it can actually represent, and every span it can
 *  be asked to divide is one randomUnit() can divide without bias. */
const VALUE_LIMIT = 1e12;

const MAX_PLACES = 8;
const MAX_COUNT = 1000;

/** Ceiling on the kept pool. A kept history left running for an afternoon
 *  would otherwise grow without limit, and both views draw every number they
 *  hold: removing one row re-renders the list, so the size that has to stay
 *  comfortable is the whole pool, not a window onto it.
 *
 *  Set where it is because 5,000 rows rebuild in a few milliseconds and 50,000
 *  would not, and because nothing is ever hidden from the user at this size.
 *  When the cap is reached the OLDEST are dropped, so the numbers just drawn
 *  are always the ones that survive, and generate() says so out loud rather
 *  than letting a list quietly stop growing. */
const MAX_RESULTS = 5_000;

const DEFAULT_SETTINGS: RngSettings = {
  min: 1,
  max: 100,
  decimals: false,
  places: 2,
  count: 1,
  keepHistory: false,
  outputMode: "grid",
};

/* =============================================================================
   STATE
============================================================================= */

let rngSettings: RngSettings = { ...DEFAULT_SETTINGS };
let results: RngResult[] = [];

/** Highest batch number in `results`. Tracked rather than derived so that
 *  clearing the pool restarts the numbering at 1, which is what "clear" means
 *  to the person reading the rows. */
let batchCounter = 0;

/** False until loadStore() has finished (successfully or not). Guards every
 *  write: initRNG() doesn't await the load, so a generation made in the first
 *  moments of app start would otherwise persist over the real pool. */
let storeLoaded = false;

/* =============================================================================
   ELEMENT REFS
============================================================================= */

let minInput: HTMLInputElement;
let maxInput: HTMLInputElement;
let swapBtn: HTMLButtonElement;
let decimalsToggle: HTMLInputElement;
let placesField: HTMLElement;
let placesInput: HTMLInputElement;
let countInput: HTMLInputElement;
let historyToggle: HTMLInputElement;
let historyNote: HTMLElement;
let generateBtn: HTMLButtonElement;
let copyBtn: HTMLButtonElement;
let clearBtn: HTMLButtonElement;
let summaryEl: HTMLElement;
let emptyEl: HTMLElement;
let gridEl: HTMLElement;
let rowsEl: HTMLElement;

/* =============================================================================
   PERSISTENCE
============================================================================= */

async function loadStore(): Promise<void> {
  try {
    const raw = await invoke<string>("load_rng_data");
    const parsed = JSON.parse(raw) as Partial<RngStore>;
    rngSettings = normalizeSettings(parsed.settings ?? {});
    // slice(-n) rather than slice(0, n): if a hand-edited file (or an older
    // build with a larger cap) holds more than fits, the recent end is the
    // half worth keeping.
    results = Array.isArray(parsed.results)
      ? parsed.results.filter(isValidResult).slice(-MAX_RESULTS)
      : [];
    // Picks up where the file left off, so reopening the app doesn't restart
    // the batch numbering underneath a pool that is still on screen.
    batchCounter = results.reduce((hi, r) => Math.max(hi, r.batch), 0);
  } catch (err) {
    flash(`Couldn't load RNGesus data: ${String(err)}`, "error");
  } finally {
    // Set even on failure: a load that errored has already been reported, and
    // leaving writes blocked forever would silently stop persisting anything
    // for the rest of the session.
    storeLoaded = true;
  }

  applySettingsToForm();
  render();
}

async function saveStore(): Promise<void> {
  if (!storeLoaded) return;
  const store: RngStore = { settings: rngSettings, results };
  try {
    await invoke("save_rng_data", { data: JSON.stringify(store) });
  } catch (err) {
    flash(`Couldn't save RNGesus data: ${String(err)}`, "error");
  }
}

/** Coerces anything loaded from disk (or an older data file) into a complete,
 *  in-range settings object, so no later code has to defend against a missing
 *  or absurd field. Deliberately does NOT enforce min <= max: a reversed pair
 *  is a thing the user is halfway through typing, and generate() sorts it out
 *  at the one moment it actually matters. */
export function normalizeSettings(raw: Partial<RngSettings>): RngSettings {
  const num = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;

  const clampValue = (v: number): number =>
    Math.min(VALUE_LIMIT, Math.max(-VALUE_LIMIT, v));

  return {
    min: clampValue(num(raw.min, DEFAULT_SETTINGS.min)),
    max: clampValue(num(raw.max, DEFAULT_SETTINGS.max)),
    decimals: raw.decimals === true,
    places: Math.min(MAX_PLACES, Math.max(1, Math.round(num(raw.places, DEFAULT_SETTINGS.places)))),
    count: Math.min(MAX_COUNT, Math.max(1, Math.round(num(raw.count, DEFAULT_SETTINGS.count)))),
    keepHistory: raw.keepHistory === true,
    outputMode: raw.outputMode === "rows" ? "rows" : "grid",
  };
}

function isValidResult(r: unknown): r is RngResult {
  if (r === null || typeof r !== "object") return false;
  const c = r as RngResult;
  return (
    typeof c.id === "string" &&
    Number.isFinite(c.value) &&
    Number.isFinite(c.places) &&
    Number.isFinite(c.batch)
  );
}

/* =============================================================================
   THE DRAW
============================================================================= */

/** A uniform double in [0, 1), built from 53 bits of the platform CSPRNG.
 *
 *  53 bits because that is exactly the significand of a double: fewer would
 *  leave representable values that can never come up, more would be discarded
 *  on the way in. The two shifts split one 64-bit draw into a 27-bit half and
 *  a 26-bit half, which is the standard construction and is what keeps every
 *  representable value in [0, 1) equally likely.
 *
 *  Exported alongside drawValue() so the rule can be exercised directly rather
 *  than only through the button that uses it. */
export function randomUnit(): number {
  const buf = new Uint32Array(2);
  crypto.getRandomValues(buf);
  const hi = buf[0] >>> 5; // 27 bits
  const lo = buf[1] >>> 6; // 26 bits
  return (hi * 67_108_864 + lo) / 9_007_199_254_740_992;
}

/** One draw from [min, max].
 *
 *  Whole numbers land on every integer in the range with equal probability,
 *  ends included, which is why the span is +1 and the result is floored. The
 *  guard afterwards covers only the case where a rounding error at the very
 *  top of the unit interval would otherwise put one value one past the end.
 *
 *  Fractional draws are continuous over [min, max] and then rounded to the
 *  requested places, so the two ends are half as likely as an interior value
 *  by exactly the amount rounding says they should be. That is the honest
 *  behaviour: the alternative, drawing integers over a scaled range, quietly
 *  changes what "between 1 and 2 to two places" means.
 *
 *  Exported with its arguments rather than reading module state so the rules
 *  can be exercised directly. */
export function drawValue(min: number, max: number, places: number): number {
  if (places <= 0) {
    const span = Math.floor(max) - Math.ceil(min) + 1;
    if (span <= 0) return Math.ceil(min);
    return Math.min(Math.floor(max), Math.ceil(min) + Math.floor(randomUnit() * span));
  }
  const raw = min + randomUnit() * (max - min);
  const factor = 10 ** places;
  return Math.round(raw * factor) / factor;
}

function formatValue(value: number, places: number): string {
  return places > 0 ? value.toFixed(places) : String(value);
}

function newId(): string {
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/* =============================================================================
   FORM  ⇄  SETTINGS
============================================================================= */

/** Reads the form. Raw except for the coercion normalizeSettings does; the
 *  range check that actually blocks a generation lives in generate(). */
function readForm(): RngSettings {
  return normalizeSettings({
    min: parseFloat(minInput.value),
    max: parseFloat(maxInput.value),
    decimals: decimalsToggle.checked,
    places: parseInt(placesInput.value, 10),
    count: parseInt(countInput.value, 10),
    keepHistory: historyToggle.checked,
    outputMode: activeSegValue("rng-output-mode", "grid") as OutputMode,
  });
}

function applySettingsToForm(): void {
  minInput.value = String(rngSettings.min);
  maxInput.value = String(rngSettings.max);
  decimalsToggle.checked = rngSettings.decimals;
  placesInput.value = String(rngSettings.places);
  countInput.value = String(rngSettings.count);
  historyToggle.checked = rngSettings.keepHistory;
  setSegValue("rng-output-mode", rngSettings.outputMode);
  syncDerivedUI();
}

function activeSegValue(groupId: string, fallback: string): string {
  return document.querySelector<HTMLElement>(`#${groupId} .toggle-btn.active`)?.dataset.value
    ?? fallback;
}

function setSegValue(groupId: string, value: string): void {
  document.querySelectorAll<HTMLButtonElement>(`#${groupId} .toggle-btn`).forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.value === value);
  });
}

/** Reads the form into `rngSettings` and reconciles the form with what was
 *  actually accepted. Paints and persists nothing: both callers below finish
 *  the job themselves, and generate() in particular must not save twice per
 *  press of a button pressed as often as that one is. */
function absorbForm(): void {
  rngSettings = readForm();
  // Push the clamped numbers back into the boxes. A number input's min/max
  // only bind its spinner arrows, so without this a typed 5000 would sit in
  // the field looking accepted while the app used 1000.
  placesInput.value = String(rngSettings.places);
  countInput.value = String(rngSettings.count);
  syncDerivedUI();
}

/** Commits the form and repaints everything derived from it. Called on every
 *  field change, so the tool has no separate "apply". */
function commitSettings(): void {
  absorbForm();
  render();
  void saveStore();
}

/** Everything in the form that is derived purely from other fields. */
function syncDerivedUI(): void {
  placesField.style.display = rngSettings.decimals ? "" : "none";
  historyNote.textContent = rngSettings.keepHistory
    ? "New numbers are added to the list below."
    : "Each generation replaces the list below.";
}

/* =============================================================================
   GENERATE / REMOVE / CLEAR
============================================================================= */

function generate(): void {
  absorbForm();

  const lo = Math.min(rngSettings.min, rngSettings.max);
  const hi = Math.max(rngSettings.min, rngSettings.max);
  const places = rngSettings.decimals ? rngSettings.places : 0;

  // Whole numbers need an integer to exist inside the range at all. 1.2 to 1.8
  // contains none, and silently handing back 2 (or 1) would be a lie about
  // what was asked for.
  if (places === 0 && Math.floor(hi) < Math.ceil(lo)) {
    flash("No whole number lies in that range. Widen it, or turn on decimals.", "error");
    return;
  }

  // "Replace" clears first, so the batch numbering restarts with the pool and
  // the rows read 1..n rather than continuing from wherever the last run got
  // to.
  if (!rngSettings.keepHistory) {
    results = [];
    batchCounter = 0;
  }

  batchCounter++;
  for (let i = 0; i < rngSettings.count; i++) {
    results.push({
      id: newId(),
      value: drawValue(lo, hi, places),
      places,
      batch: batchCounter,
    });
  }

  // Oldest first: the numbers just drawn are the ones the user is looking at,
  // so they are never the ones dropped. Said out loud, because a list that
  // silently stops growing is a list you stop trusting.
  if (results.length > MAX_RESULTS) {
    const dropped = results.length - MAX_RESULTS;
    results = results.slice(-MAX_RESULTS);
    flash(
      `Kept the most recent ${MAX_RESULTS.toLocaleString()}; dropped the oldest ${dropped.toLocaleString()}.`,
      "error",
    );
  }

  render();
  void saveStore();
}

function removeResult(id: string): void {
  results = results.filter((r) => r.id !== id);
  render();
  void saveStore();
}

function clearResults(): void {
  if (results.length === 0) {
    flash("Nothing to clear", "error");
    return;
  }
  const removed = results.length;
  results = [];
  batchCounter = 0;
  render();
  void saveStore();
  flash(`Cleared ${removed} number${removed === 1 ? "" : "s"}`, "success");
}

/** Puts `text` on the clipboard, by whichever route works.
 *
 *  The async Clipboard API is tried first and is what normally runs. The
 *  execCommand path behind it is deprecated and kept anyway: this app ships no
 *  clipboard plugin, so the WebView's own API is the only route there is, and
 *  it is gated on a secure context and on permission that a WebView can refuse
 *  for reasons nothing here controls. A Copy button that silently does nothing
 *  is a worse thing to ship than a deprecated call.
 *
 *  The textarea is positioned off-screen rather than hidden: execCommand copies
 *  a SELECTION, and there is nothing to select inside a display:none element. */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* falls through to the legacy path */
  }

  const holder = document.createElement("textarea");
  holder.value = text;
  holder.setAttribute("readonly", "");
  holder.style.position = "fixed";
  holder.style.top = "-9999px";
  holder.style.opacity = "0";
  document.body.appendChild(holder);
  try {
    holder.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    holder.remove();
  }
}

/** The whole pool as one comma-separated line, which is the form anything else
 *  (a spreadsheet, a chat message, a script) wants it in. */
async function copyResults(): Promise<void> {
  if (results.length === 0) {
    flash("Nothing to copy", "error");
    return;
  }
  const text = results.map((r) => formatValue(r.value, r.places)).join(", ");
  const ok = await copyToClipboard(text);
  flash(
    ok ? `Copied ${results.length} number${results.length === 1 ? "" : "s"}` : "Couldn't reach the clipboard",
    ok ? "success" : "error",
  );
}

/* =============================================================================
   RENDER
============================================================================= */

function render(): void {
  const mode = rngSettings.outputMode;
  const empty = results.length === 0;

  emptyEl.style.display = empty ? "" : "none";
  gridEl.style.display = !empty && mode === "grid" ? "" : "none";
  rowsEl.style.display = !empty && mode === "rows" ? "" : "none";

  copyBtn.disabled = empty;
  clearBtn.disabled = empty;

  summaryEl.textContent = empty
    ? ""
    : `${results.length} number${results.length === 1 ? "" : "s"}` +
      (batchCounter > 1 ? ` · ${batchCounter} generations` : "");

  if (empty) {
    gridEl.innerHTML = "";
    rowsEl.innerHTML = "";
    return;
  }

  if (mode === "grid") renderGrid();
  else renderRows();
}

/** Comma-separated, wrapping. Each number is its own cell so the commas can
 *  sit between them without becoming part of the number, which is what keeps a
 *  double-click selecting one value rather than a value and its punctuation. */
function renderGrid(): void {
  rowsEl.innerHTML = "";

  gridEl.innerHTML = results
    .map((r, i) => {
      const value = escapeHtml(formatValue(r.value, r.places));
      const comma = i < results.length - 1 ? '<span class="rng-comma">,</span>' : "";
      return `<span class="rng-cell"><span class="rng-value">${value}</span>${comma}</span>`;
    })
    .join("");
}

/** One scrolling row per number: its id on the left, the number itself in the
 *  centre, and its remove button on the right.
 *
 *  The number is what the eye is here for, so it takes the middle and every
 *  other row puts it in the same place. The identifying furniture is gathered
 *  on the left, the index and, once a kept history holds more than one
 *  generation, the batch that produced it, so a long pool stays navigable
 *  without anything landing between the number and the ✕.
 *
 *  Built as one innerHTML pass with a single delegated click handler rather
 *  than a listener per row: at MAX_RESULTS that is five thousand listeners
 *  saved, and the id is already on the row for the handler to read. */
function renderRows(): void {
  gridEl.innerHTML = "";

  const multiBatch = batchCounter > 1;
  rowsEl.innerHTML = results
    .map((r, i) => `
      <div class="rng-row" data-id="${escapeHtml(r.id)}">
        <span class="rng-row-id">
          <span class="rng-row-index">${i + 1}</span>
          ${multiBatch ? `<span class="rng-row-batch">gen ${r.batch}</span>` : ""}
        </span>
        <span class="rng-row-value">${escapeHtml(formatValue(r.value, r.places))}</span>
        <button class="rng-row-remove modal-cancel-btn" title="Remove this number">✕</button>
      </div>`)
    .join("");
}

/* =============================================================================
   RESET
============================================================================= */

function handleReset(): void {
  rngSettings = { ...DEFAULT_SETTINGS };
  applySettingsToForm();
  render();
  void saveStore();
  // Same wording the Days Between and TTS Repeater reset buttons use, so the
  // action reads identically wherever it appears. The pool is deliberately
  // left alone: Clear is its own button, right above the numbers it clears.
  flash("Tool reset", "success");
}

/* =============================================================================
   INIT
============================================================================= */

export function initRNG(): void {
  minInput = document.getElementById("rng-min") as HTMLInputElement;
  maxInput = document.getElementById("rng-max") as HTMLInputElement;
  swapBtn = document.getElementById("rng-swap") as HTMLButtonElement;
  decimalsToggle = document.getElementById("rng-decimals") as HTMLInputElement;
  placesField = document.getElementById("rng-places-field")!;
  placesInput = document.getElementById("rng-places") as HTMLInputElement;
  countInput = document.getElementById("rng-count") as HTMLInputElement;
  historyToggle = document.getElementById("rng-keep-history") as HTMLInputElement;
  historyNote = document.getElementById("rng-history-note")!;
  generateBtn = document.getElementById("rng-generate-btn") as HTMLButtonElement;
  copyBtn = document.getElementById("rng-copy-btn") as HTMLButtonElement;
  clearBtn = document.getElementById("rng-clear-btn") as HTMLButtonElement;
  summaryEl = document.getElementById("rng-summary")!;
  emptyEl = document.getElementById("rng-empty")!;
  gridEl = document.getElementById("rng-grid")!;
  rowsEl = document.getElementById("rng-rows")!;

  minInput.min = String(-VALUE_LIMIT);
  minInput.max = String(VALUE_LIMIT);
  maxInput.min = String(-VALUE_LIMIT);
  maxInput.max = String(VALUE_LIMIT);

  /* ── Fields ── */
  [minInput, maxInput, placesInput, countInput].forEach((el) => {
    el.addEventListener("change", commitSettings);
  });
  [decimalsToggle, historyToggle].forEach((el) => {
    el.addEventListener("change", commitSettings);
  });

  document.querySelectorAll<HTMLButtonElement>("#rng-output-mode .toggle-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      btn.parentElement!.querySelectorAll<HTMLButtonElement>(".toggle-btn")
        .forEach((b) => b.classList.toggle("active", b === btn));
      commitSettings();
    });
  });

  swapBtn.addEventListener("click", () => {
    const a = minInput.value;
    minInput.value = maxInput.value;
    maxInput.value = a;
    commitSettings();
  });

  // Enter anywhere in the range/count fields generates, so a whole roll can be
  // set up and fired without reaching for the mouse.
  [minInput, maxInput, placesInput, countInput].forEach((el) => {
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        generate();
      }
    });
  });

  /* ── Actions ── */
  generateBtn.addEventListener("click", generate);
  copyBtn.addEventListener("click", () => void copyResults());
  clearBtn.addEventListener("click", clearResults);
  document.getElementById("rng-reset")!.addEventListener("click", handleReset);

  // One delegated handler for every remove button; see renderRows().
  rowsEl.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>(".rng-row-remove");
    if (!btn) return;
    const id = btn.closest<HTMLElement>(".rng-row")?.dataset.id;
    if (id) removeResult(id);
  });

  // Delegated for the same reason the click handler above is: at MAX_RESULTS
  // a listener per row would be thousands of them, thrown away on every
  // render. One on the container survives every re-render instead.
  attachMenuDelegated(rowsEl, ".rng-row", (row) => {
    const id = row.dataset.id;
    const index = results.findIndex((r) => r.id === id);
    if (index === -1) return null;
    const result = results[index];
    const copy = async (list: typeof results, what: string): Promise<void> => {
      const ok = await copyToClipboard(
        list.map((r) => formatValue(r.value, r.places)).join(", "),
      );
      flash(ok ? `Copied ${what}` : "Couldn't reach the clipboard", ok ? "success" : "error");
    };
    return [
      {
        label: "Copy This Number",
        onClick: () => void copy([result], "1 number"),
      },
      {
        // Useful when a roll produced a run you want and a tail you don't:
        // the numbers are in generation order, so "from here down" is "the
        // rest of this batch".
        label: `Copy From Here Down (${results.length - index})`,
        onClick: () =>
          void copy(results.slice(index), `${results.length - index} numbers`),
      },
      { label: "Copy All", onClick: () => void copyResults() },
      { label: "Remove This Number", danger: true, onClick: () => removeResult(result.id) },
    ];
  });

  applySettingsToForm();
  render();
  void loadStore();
}
