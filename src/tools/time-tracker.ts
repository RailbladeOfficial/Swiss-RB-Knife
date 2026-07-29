/* =============================================================================
   TIME TRACKER
   -----------------------------------------------------------------------------
   Frontend logic for the Time Tracker tool. Entries are persisted to disk via
   Rust commands; this file owns all UI state, event wiring, rendering, and the
   delete-confirm modal.

   Architecture notes:
     • Module-level state (entries, settings, viewStart/viewEnd) is closed over
       by all functions rather than passed through DOM refs. DOM refs that change
       on every render (inputs, display divs) are resolved once in initTimeTracker
       and threaded into functions that need them as parameters.
     • Settings are read from the shared settings.json (written by shell.ts) so
       formatDate() and formatTime() stay in sync with app-level preferences
       without needing a callback into shell.ts.
     • The draft is auto-saved on every input change (debounced 500 ms) so the
       form survives accidental closes.

   Rust commands used:
     save_data, load_data, save_draft, load_draft, export_csv, save_settings, load_settings
============================================================================= */

import { invoke } from "@tauri-apps/api/core";
import { flash, devError } from "../shell";
import { Modal } from "../modal";

/* =============================================================================
   TYPES
============================================================================= */

type Entry = {
  date: string;    // YYYY-MM-DD
  start: string;   // HH:MM (may exceed 23:xx for overnight entries)
  end: string;     // HH:MM
  activity: string;
};

// TT-specific settings — shell owns fontScale, theme, hour12 at the app level,
// but TT reads them back from disk so its render/format functions still work.
type TTSettings = {
  fontScale: number;
  americanDates: boolean;
  hour12: boolean;
  theme: string;
  randomColors: Record<string, string>;
  quickDelete: boolean;
  payPeriod: {
    enabled: boolean;
    anchorDate: string;
    lengthDays: number;
  };
};

/* =============================================================================
   MODULE-LEVEL STATE
   Declared outside initTimeTracker so internal functions can close over them.
============================================================================= */

let entries: Entry[] = [];
let lastActivity = "";
let selectedDate: string = today();
let viewStart: string = today();
let viewEnd: string = today();

let settings: TTSettings = {
  fontScale: 0,
  americanDates: false,
  hour12: false,
  theme: "default",
  randomColors: {},
  quickDelete: false,
  payPeriod: {
    enabled: false,
    anchorDate: "",
    lengthDays: 14,
  },
};

let settingsSaveTimer: number | null = null;
let draftSaveTimer: number | null = null;
let durationPreviewTimer: number | null = null;

let pendingDeleteIndex: number | null = null;

/* =============================================================================
   DATE HELPERS
============================================================================= */

function localDateString(d = new Date()): string {
  return d.toLocaleDateString("en-CA");
}

function today(): string {
  return localDateString();
}

function formatDate(dateStr: string): string {
  if (!settings.americanDates) return dateStr;
  const [y, m, d] = dateStr.split("-");
  return `${m}-${d}-${y}`;
}

function getPresetRange(preset: string): { start: string; end: string } {
  const now = new Date();
  const todayStr = localDateString(now);

  switch (preset) {
    case "today":
      return { start: todayStr, end: todayStr };

    case "yesterday": {
      const d = new Date(now);
      d.setDate(d.getDate() - 1);
      const s = localDateString(d);
      return { start: s, end: s };
    }

    case "week-to-date": {
      const d = new Date(now);
      const day = d.getDay() || 7;
      d.setDate(d.getDate() - (day - 1));
      return { start: localDateString(d), end: todayStr };
    }

    case "last-7": {
      const d = new Date(now);
      d.setDate(d.getDate() - 6);
      return { start: localDateString(d), end: todayStr };
    }

    case "month-to-date": {
      const d = new Date(now.getFullYear(), now.getMonth(), 1);
      return { start: localDateString(d), end: todayStr };
    }

    case "last-14": {
      const d = new Date(now);
      d.setDate(d.getDate() - 13);
      return { start: localDateString(d), end: todayStr };
    }

    case "last-30": {
      const d = new Date(now);
      d.setDate(d.getDate() - 29);
      return { start: localDateString(d), end: todayStr };
    }

    case "last-month": {
      const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const last = new Date(now.getFullYear(), now.getMonth(), 0);
      return { start: localDateString(first), end: localDateString(last) };
    }

    case "year-to-date": {
      const d = new Date(now.getFullYear(), 0, 1);
      return { start: localDateString(d), end: todayStr };
    }

    case "last-year": {
      const first = new Date(now.getFullYear() - 1, 0, 1);
      const last = new Date(now.getFullYear() - 1, 11, 31);
      return { start: localDateString(first), end: localDateString(last) };
    }

    case "this-pay-period": {
      const r = getThisPayPeriod();
      return r ?? { start: todayStr, end: todayStr };
    }

    case "last-pay-period": {
      const r = getLastPayPeriod();
      return r ?? { start: todayStr, end: todayStr };
    }

    case "all":
      return { start: "", end: "" };

    default:
      return { start: todayStr, end: todayStr };
  }
}

/* =============================================================================
   TIME HELPERS
============================================================================= */

function parseTime(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function formatMinutes(mins: number): string {
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function normalizeTime(input: string): string {
  const trimmed = input.trim().toLowerCase();

  if (trimmed === "midnight") return "00:00";
  if (trimmed === "midday" || trimmed === "noon") return "12:00";

  const suffixMatch = trimmed.match(
    /^(\d{1,4})(?::(\d{2}))?\s*([ap]\.?m?\.?)$/,
  );
  if (suffixMatch) {
    let hours = parseInt(suffixMatch[1], 10);
    const minutes = parseInt(suffixMatch[2] || "0", 10);
    const suffix = suffixMatch[3].replace(/\./g, "");
    const isAm = suffix.startsWith("a");
    const isPm = suffix.startsWith("p");
    if (isAm && hours === 12) hours = 0;
    if (isPm && hours !== 12) hours += 12;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  }

  const cleaned = trimmed.replace(/[^0-9]/g, "");
  if (!cleaned) return "";
  if (cleaned.length <= 2) return `${cleaned.padStart(2, "0")}:00`;
  if (cleaned.length === 3) return `0${cleaned[0]}:${cleaned.slice(1)}`;
  const padded = cleaned.padStart(4, "0");
  return `${padded.slice(0, 2)}:${padded.slice(2, 4)}`;
}

/** Converts a total-minutes value to a zero-padded "HH:MM" string. */
function minsToTimeString(mins: number): string {
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

function formatTime(timeStr: string): string {
  if (!settings.hour12) return timeStr;
  let [h, m] = timeStr.split(":").map(Number);
  const suffix = h >= 12 ? "pm" : "am";
  if (h === 0) h = 12;
  else if (h > 12) h -= 12;
  return `${h}:${String(m).padStart(2, "0")}${suffix}`;
}

function formatPreviewDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/* =============================================================================
   VALIDATION
============================================================================= */

function validateEntry({ date, start, end, activity }: Entry): boolean {
  if (!activity) { flash("Activity is required.", "error"); return false; }
  if (!start)    { flash("Start time is missing or invalid.", "error"); return false; }
  if (!end)      { flash("End time is missing or invalid.", "error"); return false; }
  if (!date)     { flash("Date is required.", "error"); return false; }
  return true;
}

/* =============================================================================
   SETTINGS — TT-SPECIFIC
   Shell owns fontScale, theme, hour12 at the app level. TT reads them back
   from shared settings.json so its render/format logic (formatDate, formatTime)
   stays in sync without needing to call back into shell.ts.
============================================================================= */

function applyPayPeriodVisibility(): void {
  const subsettings = document.getElementById("payPeriodSubsettings")!;
  subsettings.style.maxHeight = settings.payPeriod.enabled ? "200px" : "0";
}

function applyPayPeriodButtons(): void {
  const container = document.getElementById("payPeriodPresets")!;
  container.style.display = settings.payPeriod.enabled ? "flex" : "none";
}

/**
 * Applies TT-specific settings to the DOM.
 * Shell handles fontScale, theme, and clock format — this only touches
 * the fields TT owns: date format, quick delete, pay period.
 */
function applyTTSettings(): void {
  // Note: dateFormatToggle and dateFormatLabel are now managed by shell.ts
  // (Date Format is a universal Display setting). TT reads americanDates from
  // the shared settings object so formatDate() stays in sync.

  (document.getElementById("quickDeleteToggle") as HTMLInputElement).checked = settings.quickDelete;
  document.getElementById("quickDeleteLabel")!.textContent =
    settings.quickDelete ? "On" : "Off";

  (document.getElementById("payPeriodToggle") as HTMLInputElement).checked =
    settings.payPeriod.enabled;
  document.getElementById("payPeriodLabel")!.textContent =
    settings.payPeriod.enabled ? "On" : "Off";

  (document.getElementById("payPeriodAnchor") as HTMLInputElement).value =
    settings.payPeriod.anchorDate;
  (document.getElementById("payPeriodLength") as HTMLSelectElement).value =
    String(settings.payPeriod.lengthDays);

  applyPayPeriodVisibility();
  applyPayPeriodButtons();
}

function saveSettings(): void {
  if (settingsSaveTimer) clearTimeout(settingsSaveTimer);
  settingsSaveTimer = window.setTimeout(async () => {
    // TT's settings live in TT's OWN file (time-tracker-settings.json) —
    // settings.json belongs to the shell alone. Only the keys this tool
    // owns are written; shell-owned display prefs (fontScale, theme,
    // hour12, americanDates) are read-only here.
    const own = {
      quickDelete: settings.quickDelete,
      payPeriod: settings.payPeriod,
    };
    try {
      await invoke("save_tool_settings", {
        toolId: "time-tracker",
        data: JSON.stringify(own),
      });
    } catch (e) {
      // This fires from a timer — without a catch, a failed save would
      // vanish as an unhandled rejection while the user believes the
      // toggle stuck.
      flash(`Failed to save Time Tracker settings: ${e}`, "error", 8000);
    }
  }, 500);
}

async function loadSettings(): Promise<void> {
  try {
    // Shell-owned display prefs come from the shared settings.json (read-
    // only). This also picks up any LEGACY quickDelete/payPeriod keys still
    // sitting there from before tool settings moved to their own files.
    const sharedRaw = await invoke<string>("load_settings");
    const shared = JSON.parse(sharedRaw || "{}");
    settings = { ...settings, ...shared };

    // TT's own settings file is authoritative for TT keys. If it doesn't
    // exist yet (first run after the split), the legacy values merged above
    // stand — and get persisted to the new home so the migration happens
    // exactly once.
    const ownRaw = await invoke<string>("load_tool_settings", { toolId: "time-tracker" });
    const own = JSON.parse(ownRaw || "{}");
    const hasOwnFile =
      own && typeof own === "object" &&
      ("quickDelete" in own || "payPeriod" in own);

    if (hasOwnFile) {
      if (typeof own.quickDelete === "boolean") settings.quickDelete = own.quickDelete;
      if (own.payPeriod && typeof own.payPeriod === "object") {
        settings.payPeriod = { ...settings.payPeriod, ...own.payPeriod };
      }
    } else if ("quickDelete" in shared || "payPeriod" in shared) {
      // Legacy keys found in settings.json and no own-file yet: migrate.
      saveSettings();
    }

    applyTTSettings();
  } catch (err) {
    devError("Settings load failed:", err);
  }
}

/* =============================================================================
   PERSISTENCE — ENTRIES
============================================================================= */

async function saveToDisk(): Promise<void> {
  await invoke("save_data", { data: JSON.stringify(entries) });
}

async function loadFromDisk(): Promise<void> {
  try {
    const raw = await invoke<string>("load_data");
    const parsed = JSON.parse(raw || "[]");
    if (!Array.isArray(parsed)) {
      entries = [];
      return;
    }
    // Validate each entry — drop any records with missing or wrong-typed required
    // fields so downstream render/sort logic never hits unexpected values.
    entries = parsed.filter((e): e is Entry =>
      e !== null &&
      typeof e === "object" &&
      typeof e.date     === "string" && e.date.length > 0 &&
      typeof e.start    === "string" &&
      typeof e.end      === "string" &&
      typeof e.activity === "string"
    );
  } catch (err) {
    devError("Load failed:", err);
    entries = [];
  }
}

/* =============================================================================
   PERSISTENCE — DRAFT
============================================================================= */

function saveDraft(
  datePicker: HTMLInputElement,
  activityInput: HTMLInputElement,
  startInput: HTMLInputElement,
  endInput: HTMLInputElement,
  quickInput: HTMLInputElement,
): void {
  if (draftSaveTimer) clearTimeout(draftSaveTimer);
  draftSaveTimer = window.setTimeout(async () => {
    await invoke("save_draft", {
      data: JSON.stringify({
        selectedDate: datePicker.value,
        activity: activityInput.value,
        start: startInput.value,
        end: endInput.value,
        quick: quickInput.value,
      }),
    });
  }, 500);
}

async function loadDraft(
  datePicker: HTMLInputElement,
  activityInput: HTMLInputElement,
  startInput: HTMLInputElement,
  endInput: HTMLInputElement,
  quickInput: HTMLInputElement,
  onLoad: () => void,
): Promise<void> {
  try {
    const raw = await invoke<string>("load_draft");
    const draft = JSON.parse(raw);
    if (draft.selectedDate) datePicker.value = draft.selectedDate;
    if (draft.activity)     activityInput.value = draft.activity;
    if (draft.start)        startInput.value = draft.start;
    if (draft.end)          endInput.value = draft.end;
    if (draft.quick)        quickInput.value = draft.quick;
    onLoad();
  } catch (err) {
    devError("Draft load failed:", err);
  }
}

/* =============================================================================
   SORTING
============================================================================= */

function sortEntries(): void {
  entries.sort((a, b) => {
    const d = a.date.localeCompare(b.date);
    return d !== 0 ? d : parseTime(a.start) - parseTime(b.start);
  });
}

/* =============================================================================
   PAY PERIOD HELPERS
============================================================================= */

function getPayPeriodContaining(
  targetStr: string,
  anchorStr: string,
  lengthDays: number,
): { start: string; end: string } {
  const target = new Date(targetStr + "T00:00:00");
  let periodStart = new Date(anchorStr + "T00:00:00");
  while (periodStart > target) {
    periodStart.setDate(periodStart.getDate() - lengthDays);
  }
  while (true) {
    const periodEnd = new Date(periodStart);
    periodEnd.setDate(periodEnd.getDate() + lengthDays - 1);
    if (periodEnd >= target) {
      return {
        start: localDateString(periodStart),
        end: localDateString(periodEnd),
      };
    }
    periodStart.setDate(periodStart.getDate() + lengthDays);
  }
}

function getThisPayPeriod(): { start: string; end: string } | null {
  const { anchorDate, lengthDays } = settings.payPeriod;
  if (!anchorDate || !lengthDays) return null;
  return getPayPeriodContaining(today(), anchorDate, lengthDays);
}

function getLastPayPeriod(): { start: string; end: string } | null {
  const current = getThisPayPeriod();
  if (!current) return null;
  const { lengthDays } = settings.payPeriod;
  const prevEnd = new Date(current.start + "T00:00:00");
  prevEnd.setDate(prevEnd.getDate() - 1);
  const prevStart = new Date(prevEnd);
  prevStart.setDate(prevStart.getDate() - lengthDays + 1);
  return { start: localDateString(prevStart), end: localDateString(prevEnd) };
}

/* =============================================================================
   DURATION PREVIEW
============================================================================= */

function updateDurationPreview(
  startInput: HTMLInputElement,
  endInput: HTMLInputElement,
  durationPreview: HTMLElement,
): void {
  const rawStart = startInput.value.trim();
  const rawEnd = endInput.value.trim();

  if (!rawStart) {
    durationPreview.textContent = "";
    durationPreview.classList.remove("visible");
    if (durationPreviewTimer) {
      clearInterval(durationPreviewTimer);
      durationPreviewTimer = null;
    }
    return;
  }

  const normalizedStart = normalizeTime(rawStart);
  if (!normalizedStart) {
    durationPreview.textContent = "";
    durationPreview.classList.remove("visible");
    // A live "ticking" preview may be running from a previously-valid start
    // value — without this, its interval keeps firing every second against
    // the stale closure until the field becomes valid or empty again.
    if (durationPreviewTimer) {
      clearInterval(durationPreviewTimer);
      durationPreviewTimer = null;
    }
    return;
  }

  durationPreview.classList.add("visible");
  if (durationPreviewTimer) {
    clearInterval(durationPreviewTimer);
    durationPreviewTimer = null;
  }

  const normalizedEnd = rawEnd ? normalizeTime(rawEnd) : "";

  if (normalizedEnd) {
    let diffSeconds =
      (parseTime(normalizedEnd) - parseTime(normalizedStart)) * 60;
    if (diffSeconds < 0) diffSeconds += 1440 * 60;
    durationPreview.textContent = formatPreviewDuration(diffSeconds);
  } else {
    function tick() {
      const now = new Date();
      const nowMins = now.getHours() * 60 + now.getMinutes();
      const nowSecs = now.getSeconds();
      let diffSeconds = (nowMins - parseTime(normalizedStart)) * 60 + nowSecs;
      if (diffSeconds < 0) diffSeconds += 1440 * 60;
      durationPreview.textContent = formatPreviewDuration(diffSeconds);
    }
    tick();
    durationPreviewTimer = window.setInterval(tick, 1000);
  }
}

/* =============================================================================
   CSV EXPORT
============================================================================= */

/**
 * Wraps a value as a quoted CSV field. Two things happen here that naive
 * `"${value}"` interpolation gets wrong:
 *
 * 1. Embedded double quotes are doubled ("" ) per RFC 4180 — an activity
 *    named `Say "hi"` would otherwise produce a malformed row that shifts
 *    every column after it.
 * 2. Values starting with = + - @ or a tab get a leading apostrophe. Excel
 *    treats such cells as FORMULAS on open — an activity named
 *    `=HYPERLINK(...)` would execute rather than display. The apostrophe is
 *    Excel's own "treat as text" marker and is invisible in the cell.
 *
 * Only needed for user-entered text (activity names); generated dates/times
 * can't contain either hazard, but passing them through is harmless.
 */
function csvField(value: string): string {
  let v = value;
  if (/^[=+\-@\t]/.test(v)) v = "'" + v;
  return `"${v.replace(/"/g, '""')}"`;
}

async function exportCSV(): Promise<void> {
  const now = new Date();
  const timestamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("-");

  const filename = `time-tracker-report-${timestamp}.csv`;

  const visibleEntries = entries.filter((e) => {
    if (!viewStart && !viewEnd) return true;
    if (viewStart && e.date < viewStart) return false;
    if (viewEnd && e.date > viewEnd) return false;
    return true;
  });

  const grouped: Record<string, number> = {};
  const groupedDisplay: Record<string, string> = {};
  visibleEntries.forEach((e) => {
    const mins = parseTime(e.end) - parseTime(e.start);
    const key = e.activity.toLowerCase();
    grouped[key] = (grouped[key] || 0) + mins;
    if (!groupedDisplay[key]) groupedDisplay[key] = e.activity;
  });

  const reportDate = now.toLocaleDateString(
    settings.americanDates ? "en-US" : "en-CA",
    { year: "numeric", month: "2-digit", day: "2-digit" },
  );
  const reportTime = now.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: settings.hour12,
  });

  const lines: string[] = [];

  if (!viewStart && !viewEnd) {
    lines.push(`"All Dates"`);
  } else if (viewStart === viewEnd) {
    lines.push(`"For Date:","${formatDate(viewStart)}"`);
  } else {
    const from = viewStart ? formatDate(viewStart) : "beginning";
    const to = viewEnd ? formatDate(viewEnd) : "present";
    lines.push(`"For Dates:","${from}","to","${to}"`);
  }
  lines.push(`"Report Generated:","${reportDate}", at, ${reportTime}`);
  lines.push("");

  lines.push("SUMMARY");
  lines.push("Activity,Total Time");
  let grandTotal = 0;
  Object.entries(grouped)
    .sort(([a], [b]) => a.localeCompare(b))
    .forEach(([key, mins]) => {
      lines.push(`${csvField(groupedDisplay[key])},"${formatMinutes(mins)}"`);
      grandTotal += mins;
    });
  lines.push(`"TOTAL","${formatMinutes(grandTotal)}"`);
  lines.push("");

  lines.push("ENTRIES");
  lines.push("Date,Start,End,Activity,Duration");
  visibleEntries
    .slice()
    .sort((a, b) => {
      const d = a.date.localeCompare(b.date);
      return d !== 0 ? d : parseTime(a.start) - parseTime(b.start);
    })
    .forEach((e) => {
      const mins = parseTime(e.end) - parseTime(e.start);
      lines.push(
        `"${e.date}","${e.start}","${e.end}",${csvField(e.activity)},"${formatMinutes(mins)}"`,
      );
    });

  try {
    await invoke("export_csv", { filename, data: lines.join("\r\n") });
    flash("Report exported to Downloads!", "success");
  } catch (err) {
    devError("Export failed:", err);
    flash("Export failed.", "error");
  }
}

/* =============================================================================
   RENDER
============================================================================= */

function render(
  entriesDiv: HTMLElement,
  dayTotalDiv: HTMLElement,
  groupTotalsDiv: HTMLElement,
): void {
  entriesDiv.innerHTML = "";
  groupTotalsDiv.innerHTML = "";

  let total = 0;
  const grouped: Record<string, number> = {};
  const groupedDisplay: Record<string, string> = {};

  const visible = entries
    .filter((e) => {
      if (!viewStart && !viewEnd) return true;
      if (viewStart && e.date < viewStart) return false;
      if (viewEnd && e.date > viewEnd) return false;
      return true;
    })
    .slice()
    .sort((a, b) => {
      const d = a.date.localeCompare(b.date);
      return d !== 0 ? d : parseTime(a.start) - parseTime(b.start);
    });

  visible.forEach((entry) => {
    const mins = parseTime(entry.end) - parseTime(entry.start);
    total += mins;
    const key = entry.activity.toLowerCase();
    grouped[key] = (grouped[key] || 0) + mins;
    if (!groupedDisplay[key]) groupedDisplay[key] = entry.activity;
  });

  const byDate: Map<string, Entry[]> = new Map();
  visible.forEach((entry) => {
    if (!byDate.has(entry.date)) byDate.set(entry.date, []);
    byDate.get(entry.date)!.push(entry);
  });

  byDate.forEach((dateEntries, date) => {
    const dayMins = dateEntries.reduce(
      (sum, e) => sum + parseTime(e.end) - parseTime(e.start),
      0,
    );

    const subheader = document.createElement("div");
    subheader.className = "entry-date-subheader";
    subheader.textContent = `${formatDate(date)} — ${formatMinutes(dayMins)}`;
    entriesDiv.appendChild(subheader);

    dateEntries.forEach((entry) => {
      const entryIndex = entries.indexOf(entry);
      const mins = parseTime(entry.end) - parseTime(entry.start);

      const row = document.createElement("div");
      row.className = "entry-row";

      const activitySpan = document.createElement("span");
      activitySpan.className = "entry-field entry-col-activity";
      activitySpan.textContent = entry.activity;
      activitySpan.title = "Double-click to edit";
      activitySpan.addEventListener("dblclick", () =>
        makeEditable(activitySpan, entry, "activity", entriesDiv, dayTotalDiv, groupTotalsDiv),
      );
      row.appendChild(activitySpan);

      const startSpan = document.createElement("span");
      startSpan.className = "entry-field entry-col-time";
      startSpan.textContent = formatTime(entry.start);
      startSpan.title = "Double-click to edit";
      startSpan.addEventListener("dblclick", () =>
        makeEditable(startSpan, entry, "start", entriesDiv, dayTotalDiv, groupTotalsDiv),
      );
      row.appendChild(startSpan);

      const endSpan = document.createElement("span");
      endSpan.className = "entry-field entry-col-time";
      endSpan.textContent = formatTime(entry.end);
      endSpan.title = "Double-click to edit";
      endSpan.addEventListener("dblclick", () =>
        makeEditable(endSpan, entry, "end", entriesDiv, dayTotalDiv, groupTotalsDiv),
      );
      row.appendChild(endSpan);

      const durSpan = document.createElement("span");
      durSpan.className = "entry-col-duration";
      durSpan.textContent = formatMinutes(mins);
      row.appendChild(durSpan);

      const calBtn = document.createElement("button");
      calBtn.className = "entry-cal-btn";
      calBtn.textContent = "📅";
      calBtn.title = "Edit date";
      calBtn.addEventListener("click", () => {
        const dateInput = document.createElement("input");
        dateInput.type = "date";
        dateInput.value = entry.date;
        dateInput.className = "entry-date-picker";
        calBtn.replaceWith(dateInput);
        dateInput.focus();
        dateInput.showPicker?.();

        function commitDate() {
          if (dateInput.value && dateInput.value !== entry.date) {
            entry.date = dateInput.value;
            sortEntries();
            saveToDisk();
            flash("Date updated", "success");
          }
          render(entriesDiv, dayTotalDiv, groupTotalsDiv);
        }

        dateInput.addEventListener("change", commitDate);
        dateInput.addEventListener("blur", () => render(entriesDiv, dayTotalDiv, groupTotalsDiv));
      });
      row.appendChild(calBtn);

      const deleteBtn = document.createElement("button");
      deleteBtn.textContent = "🗑️";
      deleteBtn.className = "entry-delete-btn";
      deleteBtn.addEventListener("click", () =>
        deleteEntry(entryIndex, entriesDiv, dayTotalDiv, groupTotalsDiv),
      );
      row.appendChild(deleteBtn);

      entriesDiv.appendChild(row);
    });
  });

  dayTotalDiv.textContent = `Total: ${formatMinutes(total)}`;

  Object.entries(grouped)
    .sort(([a], [b]) => a.localeCompare(b))
    .forEach(([key, mins]) => {
      const d = document.createElement("div");
      d.textContent = `${groupedDisplay[key]}: ${formatMinutes(mins)}`;
      groupTotalsDiv.appendChild(d);
    });
}

/* =============================================================================
   INLINE EDITING
============================================================================= */

function makeEditable(
  span: HTMLElement,
  entry: Entry,
  field: keyof Entry,
  entriesDiv: HTMLElement,
  dayTotalDiv: HTMLElement,
  groupTotalsDiv: HTMLElement,
): void {
  const original = span.textContent || "";

  const input = document.createElement("input");
  input.className = "entry-edit-input";
  input.value = original;
  input.style.width = span.offsetWidth + "px";
  span.replaceWith(input);
  input.focus();
  input.select();

  let handledByKeydown = false;

  function commit() {
    const raw = input.value.trim();
    if (!raw) { cancel(); return; }

    if (field === "start" || field === "end") {
      entry[field] = normalizeTime(raw) || original;
    } else {
      entry[field] = raw;
    }

    let startMins = parseTime(entry.start);
    let endMins = parseTime(entry.end);
    if (endMins <= startMins) endMins += 1440;
    entry.end = minsToTimeString(endMins);

    sortEntries();
    render(entriesDiv, dayTotalDiv, groupTotalsDiv);
    saveToDisk();
    flash("Entry edited", "success");
  }

  function cancel() {
    render(entriesDiv, dayTotalDiv, groupTotalsDiv);
    flash("Edit discarded", "error");
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      handledByKeydown = true;
      commit();
    } else if (e.key === "Escape") {
      handledByKeydown = true;
      cancel();
    }
  });

  input.addEventListener("blur", () => {
    if (handledByKeydown) return;
    commit();
  });
}

/* =============================================================================
   ENTRIES — CORE OPERATIONS
============================================================================= */

async function addEntry(
  start: string,
  end: string,
  activity: string,
  datePicker: HTMLInputElement,
  activityInput: HTMLInputElement,
  startInput: HTMLInputElement,
  endInput: HTMLInputElement,
  quickInput: HTMLInputElement,
  entriesDiv: HTMLElement,
  dayTotalDiv: HTMLElement,
  groupTotalsDiv: HTMLElement,
  durationPreview: HTMLElement,
): Promise<void> {
  let startMins = parseTime(normalizeTime(start));
  let endMins   = parseTime(normalizeTime(end));
  if (endMins <= startMins) endMins += 1440;

  entries.push({
    date: selectedDate,
    start: minsToTimeString(startMins),
    end: minsToTimeString(endMins),
    activity,
  });

  sortEntries();
  lastActivity = activity;

  render(entriesDiv, dayTotalDiv, groupTotalsDiv);
  await saveToDisk();
  flash("Entry added", "success");

  activityInput.value = "";
  startInput.value = "";
  endInput.value = "";
  quickInput.value = "";
  saveDraft(datePicker, activityInput, startInput, endInput, quickInput);
  updateDurationPreview(startInput, endInput, durationPreview);
}

async function deleteEntry(
  index: number,
  entriesDiv: HTMLElement,
  dayTotalDiv: HTMLElement,
  groupTotalsDiv: HTMLElement,
): Promise<void> {
  if (settings.quickDelete) {
    entries.splice(index, 1);
    render(entriesDiv, dayTotalDiv, groupTotalsDiv);
    await saveToDisk();
    flash("Entry deleted", "success");
  } else {
    openDeleteModal(index);
  }
}

/* =============================================================================
   MODAL HELPERS — TT-OWNED (delete confirm only)
   Shell owns: settings, about, exit, changelog.
============================================================================= */

/* =============================================================================
   MODAL — DELETE CONFIRM
   Owned by time-tracker; uses the shared Modal primitive.
============================================================================= */

// Instantiated once on first access; the element exists in index.html at init time.
let deleteModal: Modal | null = null;

function getDeleteModal(): Modal {
  if (!deleteModal) {
    deleteModal = new Modal(document.getElementById("deleteBackdrop")!, {
      closeOnEsc: true,
      onClosed: () => { pendingDeleteIndex = null; },
    });
  }
  return deleteModal;
}

function openDeleteModal(index: number): void {
  pendingDeleteIndex = index;
  getDeleteModal().open();
}

function closeDeleteModal(): void {
  getDeleteModal().close();
  // pendingDeleteIndex is cleared by onClosed after the fade completes.
}

/* =============================================================================
   VIEW — PRESET / DATE RANGE HELPERS
============================================================================= */

function applyPreset(
  preset: string,
  viewStartInput: HTMLInputElement,
  viewEndInput: HTMLInputElement,
  entriesDiv: HTMLElement,
  dayTotalDiv: HTMLElement,
  groupTotalsDiv: HTMLElement,
): void {
  const range = getPresetRange(preset);
  viewStart = range.start;
  viewEnd = range.end;
  viewStartInput.value = range.start;
  viewEndInput.value = range.end;

  document.querySelectorAll("#utility-tool-time-tracker .preset-btn").forEach((btn) => {
    btn.classList.toggle("active", (btn as HTMLElement).dataset.preset === preset);
  });

  render(entriesDiv, dayTotalDiv, groupTotalsDiv);
}

function syncActivePreset(): void {
  const presets = [
    "today", "yesterday", "week-to-date", "last-7", "last-14",
    "month-to-date", "last-30", "last-month", "year-to-date",
    "last-year", "all", "this-pay-period", "last-pay-period",
  ];
  const matched = presets.find((preset) => {
    const range = getPresetRange(preset);
    return range.start === viewStart && range.end === viewEnd;
  });
  document.querySelectorAll("#utility-tool-time-tracker .preset-btn").forEach((b) => b.classList.remove("active"));
  if (matched) {
    document.querySelectorAll("#utility-tool-time-tracker .preset-btn").forEach((btn) => {
      if ((btn as HTMLElement).dataset.preset === matched) btn.classList.add("active");
    });
  }
}

function shiftDate(dateStr: string, delta: string): string {
  const d = new Date(dateStr + "T00:00:00");
  const sign = delta.startsWith("+") ? 1 : -1;
  const unit = delta.replace(/[+-]/, "");
  if (unit === "day") d.setDate(d.getDate() + sign);
  return localDateString(d);
}

/* =============================================================================
   INIT — EXPORTED ENTRY POINT
============================================================================= */

export function initTimeTracker(): void {

  // DOM refs (resolved here so they're guaranteed to exist when TT section loads)
  const startInput      = document.getElementById("startTime") as HTMLInputElement;
  const endInput        = document.getElementById("endTime") as HTMLInputElement;
  const activityInput   = document.getElementById("activity") as HTMLInputElement;
  const quickInput      = document.getElementById("quickInput") as HTMLInputElement;
  const datePicker      = document.getElementById("datePicker") as HTMLInputElement;
  const viewStartInput  = document.getElementById("viewStart") as HTMLInputElement;
  const viewEndInput    = document.getElementById("viewEnd") as HTMLInputElement;
  const entriesDiv      = document.getElementById("entries")!;
  const dayTotalDiv     = document.getElementById("dayTotal")!;
  const groupTotalsDiv  = document.getElementById("groupTotals")!;
  const durationPreview = document.getElementById("durationPreview")!;
  // Convenience wrappers so inner functions don't have to pass DOM refs everywhere
  function doRender() {
    render(entriesDiv, dayTotalDiv, groupTotalsDiv);
  }
  function doSaveDraft() {
    saveDraft(datePicker, activityInput, startInput, endInput, quickInput);
  }
  function doUpdateDurationPreview() {
    updateDurationPreview(startInput, endInput, durationPreview);
  }
  function doApplyPreset(preset: string) {
    applyPreset(preset, viewStartInput, viewEndInput, entriesDiv, dayTotalDiv, groupTotalsDiv);
  }

  /* -------------------------------------------------------------------------
     EVENT LISTENERS — INPUT PANEL
  -------------------------------------------------------------------------- */

  document.getElementById("addBtn")!.addEventListener("click", async (e) => {
    e.preventDefault();
    const start = normalizeTime(startInput.value.trim());
    const end   = normalizeTime(endInput.value.trim());
    const activity = (activityInput.value || lastActivity).trim();
    if (!validateEntry({ date: selectedDate, start, end, activity })) return;
    await addEntry(
      start, end, activity,
      datePicker, activityInput, startInput, endInput, quickInput,
      entriesDiv, dayTotalDiv, groupTotalsDiv, durationPreview,
    );
  });

  document.getElementById("clearBtn")!.addEventListener("click", (e) => {
    e.preventDefault();
    activityInput.value = "";
    startInput.value = "";
    endInput.value = "";
    datePicker.value = today();
    selectedDate = today();
    doUpdateDurationPreview();
    doSaveDraft();
  });

  document.getElementById("startBtn")!.addEventListener("click", (e) => {
    e.preventDefault();
    startInput.value = new Date().toTimeString().slice(0, 5);
    doUpdateDurationPreview();
    doSaveDraft();
  });

  document.getElementById("stopBtn")!.addEventListener("click", (e) => {
    e.preventDefault();
    endInput.value = new Date().toTimeString().slice(0, 5);
    doUpdateDurationPreview();
    doSaveDraft();
  });

  datePicker.addEventListener("change", () => {
    selectedDate = datePicker.value;
    doRender();
  });

  quickInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();

    const match = quickInput.value.match(
      /^(midnight|midday|noon|\d{1,4}(?::\d{2})?\s*(?:[ap]\.?m\.?)?)\s*[-\s]\s*(midnight|midday|noon|\d{1,4}(?::\d{2})?\s*(?:[ap]\.?m\.?)?)\s+(.+)/i,
    );

    if (!match) {
      flash("Bad format. Use: 900-1030 emails", "error");
      return;
    }

    const start = normalizeTime(match[1]);
    const end = normalizeTime(match[2]);
    const activity = match[3].trim();

    if (!validateEntry({ date: selectedDate, start, end, activity })) return;

    addEntry(
      start, end, activity,
      datePicker, activityInput, startInput, endInput, quickInput,
      entriesDiv, dayTotalDiv, groupTotalsDiv, durationPreview,
    );
    quickInput.value = "";
  });

  [activityInput, startInput, endInput, quickInput].forEach((input) => {
    input.addEventListener("input", doSaveDraft);
  });
  startInput.addEventListener("input", doUpdateDurationPreview);
  endInput.addEventListener("input", doUpdateDurationPreview);

  /* -------------------------------------------------------------------------
     EVENT LISTENERS — CONTROLS PANEL
  -------------------------------------------------------------------------- */

  document.querySelectorAll("#utility-tool-time-tracker .preset-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      doApplyPreset((btn as HTMLElement).dataset.preset!);
    });
  });

  viewStartInput.addEventListener("change", () => {
    viewStart = viewStartInput.value;
    if (viewEnd && viewStart > viewEnd) {
      viewEnd = viewStart;
      viewEndInput.value = viewStart;
    }
    syncActivePreset();
    doRender();
  });

  viewEndInput.addEventListener("change", () => {
    viewEnd = viewEndInput.value;
    if (viewStart && viewEnd < viewStart) {
      viewStart = viewEnd;
      viewStartInput.value = viewEnd;
    }
    syncActivePreset();
    doRender();
  });

  document.querySelectorAll(".date-nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = (btn as HTMLElement).dataset.target!;
      const delta  = (btn as HTMLElement).dataset.delta!;

      if (target === "start" && viewStart) {
        viewStart = shiftDate(viewStart, delta);
        viewStartInput.value = viewStart;
        if (viewEnd && viewStart > viewEnd) {
          viewEnd = viewStart;
          viewEndInput.value = viewStart;
        }
      } else if (target === "end" && viewEnd) {
        viewEnd = shiftDate(viewEnd, delta);
        viewEndInput.value = viewEnd;
        if (viewStart && viewEnd < viewStart) {
          viewStart = viewEnd;
          viewStartInput.value = viewEnd;
        }
      }

      syncActivePreset();
      doRender();
    });
  });

  document.getElementById("exportBtn")!.addEventListener("click", exportCSV);

  /* -------------------------------------------------------------------------
     EVENT LISTENERS — TT SETTINGS ROWS (in shell settings modal)
  -------------------------------------------------------------------------- */

  // Note: shell.ts owns the dateFormatToggle label and saves the setting.
  // TT listens for the change event only to re-render entries in the new format.
  document.getElementById("dateFormatToggle")!.addEventListener("change", (e) => {
    settings.americanDates = (e.target as HTMLInputElement).checked;
    doRender();
  });

  document.getElementById("quickDeleteToggle")!.addEventListener("change", (e) => {
    settings.quickDelete = (e.target as HTMLInputElement).checked;
    document.getElementById("quickDeleteLabel")!.textContent =
      settings.quickDelete ? "On" : "Off";
    saveSettings();
  });

  document.getElementById("payPeriodToggle")!.addEventListener("change", (e) => {
    settings.payPeriod.enabled = (e.target as HTMLInputElement).checked;
    document.getElementById("payPeriodLabel")!.textContent =
      settings.payPeriod.enabled ? "On" : "Off";
    applyPayPeriodVisibility();
    applyPayPeriodButtons();
    saveSettings();
  });

  document.getElementById("payPeriodAnchor")!.addEventListener("change", (e) => {
    settings.payPeriod.anchorDate = (e.target as HTMLInputElement).value;
    saveSettings();
  });

  document.getElementById("payPeriodLength")!.addEventListener("change", (e) => {
    settings.payPeriod.lengthDays = Number((e.target as HTMLSelectElement).value);
    saveSettings();
  });

  document.querySelectorAll(".pay-period-preset-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      doApplyPreset((btn as HTMLElement).dataset.preset!);
    });
  });

  /* -------------------------------------------------------------------------
     EVENT LISTENERS — TT SETTINGS MODAL
  -------------------------------------------------------------------------- */

  const ttSettingsModal = new Modal(document.getElementById("ttSettingsBackdrop")!, {
    closeOnEsc: true,
  });

  document.getElementById("ttSetupBtn")!.addEventListener("click", () => ttSettingsModal.open());
  document.getElementById("ttSettingsClose")!.addEventListener("click", () => ttSettingsModal.close());

  document.getElementById("ttSettingsReset")!.addEventListener("click", () => {
    settings.quickDelete = false;
    settings.payPeriod = { enabled: false, anchorDate: "", lengthDays: 14 };
    applyTTSettings();
    doRender();
    saveSettings();
    flash("Time Tracker settings reset", "success");
  });

  /* -------------------------------------------------------------------------
     EVENT LISTENERS — TT-OWNED MODALS (delete confirm only)
  -------------------------------------------------------------------------- */

  document.getElementById("deleteConfirmBtn")!.addEventListener("click", async () => {
    if (pendingDeleteIndex === null) return;
    entries.splice(pendingDeleteIndex, 1);
    closeDeleteModal();
    doRender();
    await saveToDisk();
    flash("Entry deleted", "success");
  });

  document.getElementById("deleteCancelBtn")!.addEventListener("click", closeDeleteModal);

  /* -------------------------------------------------------------------------
     BOOT
  -------------------------------------------------------------------------- */

  Promise.all([
    loadFromDisk(),
    loadSettings(),
    loadDraft(datePicker, activityInput, startInput, endInput, quickInput, doUpdateDurationPreview),
  ]).then(() => {
    const draftHasData = activityInput.value || startInput.value || endInput.value;
    if (!draftHasData) {
      datePicker.value = today();
      selectedDate = today();
    } else {
      selectedDate = datePicker.value;
    }
    doApplyPreset("today");
  });
}
