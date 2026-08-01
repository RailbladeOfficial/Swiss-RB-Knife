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
import { open } from "@tauri-apps/plugin-dialog";
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
  notes: string;
};

// A separate {id, name, status} list — same shape/spirit as Budget's
// SimpleEntity — powering the Activity field's autocomplete (Phase 3) and the
// Setup modal's Activities tab. Entries above keep storing `activity` as free
// text; this list never rewrites history, it just remembers names that have
// been used so they can be suggested/managed.
type ActivityStatus = "active" | "retired";
type Activity = { id: string; name: string; status: ActivityStatus };

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
  // ISO timestamp of the last successful CSV import, or "" if never.
  lastCsvImportAt: string;
};

/* =============================================================================
   MODULE-LEVEL STATE
   Declared outside initTimeTracker so internal functions can close over them.
============================================================================= */

let entries: Entry[] = [];
let activities: Activity[] = [];
let lastActivity = "";
let selectedDate: string = today();
let viewStart: string = today();
let viewEnd: string = today();

function makeId(): string {
  return crypto.randomUUID();
}

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
  lastCsvImportAt: "",
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

/** Formats an ISO timestamp using TT's existing date/time display prefs. */
function formatImportTimestamp(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const timeStr = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${formatDate(localDateString(d))} ${formatTime(timeStr)}`;
}

/* =============================================================================
   VALIDATION
============================================================================= */

function validateEntry({ date, start, end, activity }: Pick<Entry, "date" | "start" | "end" | "activity">): boolean {
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
  refreshCsvImportStatusUI();
}

function saveSettings(): void {
  if (settingsSaveTimer) clearTimeout(settingsSaveTimer);
  settingsSaveTimer = window.setTimeout(async () => {
    // TT's settings live in TT's OWN file (time-tracker-settings.json) —
    // settings.json belongs to the shell alone. Only the keys this tool
    // owns are written; shell-owned display prefs (fontScale, theme,
    // hour12, americanDates) are read-only here. Activities ride along in
    // this same file — they're TT-owned user data, and keeping them out of
    // the entries data file (save_data) avoids reshaping that atomic blob.
    const own = {
      quickDelete: settings.quickDelete,
      payPeriod: settings.payPeriod,
      activities: activities,
      lastCsvImportAt: settings.lastCsvImportAt,
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
      ("quickDelete" in own || "payPeriod" in own || "activities" in own);

    if (hasOwnFile) {
      if (typeof own.quickDelete === "boolean") settings.quickDelete = own.quickDelete;
      if (own.payPeriod && typeof own.payPeriod === "object") {
        settings.payPeriod = { ...settings.payPeriod, ...own.payPeriod };
      }
      if (Array.isArray(own.activities)) {
        activities = own.activities.filter(isValidActivity);
      }
      if (typeof own.lastCsvImportAt === "string") settings.lastCsvImportAt = own.lastCsvImportAt;
    } else if ("quickDelete" in shared || "payPeriod" in shared) {
      // Legacy keys found in settings.json and no own-file yet: migrate.
      saveSettings();
    }

    applyTTSettings();
  } catch (err) {
    devError("Settings load failed:", err);
  }
}

function isValidActivity(a: unknown): a is Activity {
  return (
    a !== null &&
    typeof a === "object" &&
    typeof (a as Activity).id === "string" &&
    typeof (a as Activity).name === "string" &&
    (a as Activity).name.length > 0 &&
    ((a as Activity).status === "active" || (a as Activity).status === "retired")
  );
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
    entries = parsed
      .filter((e): e is Entry =>
        e !== null &&
        typeof e === "object" &&
        typeof e.date     === "string" && e.date.length > 0 &&
        typeof e.start    === "string" &&
        typeof e.end      === "string" &&
        typeof e.activity === "string"
      )
      // notes is a later addition — older saved entries won't have it, so
      // default to "" rather than dropping them.
      .map((e) => ({ ...e, notes: typeof e.notes === "string" ? e.notes : "" }));
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
  notesInput: HTMLTextAreaElement,
): void {
  if (draftSaveTimer) clearTimeout(draftSaveTimer);
  draftSaveTimer = window.setTimeout(async () => {
    await invoke("save_draft", {
      data: JSON.stringify({
        selectedDate: datePicker.value,
        activity: activityInput.value,
        start: startInput.value,
        end: endInput.value,
        notes: notesInput.value,
      }),
    });
  }, 500);
}

async function loadDraft(
  datePicker: HTMLInputElement,
  activityInput: HTMLInputElement,
  startInput: HTMLInputElement,
  endInput: HTMLInputElement,
  notesInput: HTMLTextAreaElement,
  onLoad: () => void,
): Promise<void> {
  try {
    const raw = await invoke<string>("load_draft");
    const draft = JSON.parse(raw);
    if (draft.selectedDate) datePicker.value = draft.selectedDate;
    if (draft.activity)     activityInput.value = draft.activity;
    if (draft.start)        startInput.value = draft.start;
    if (draft.end)          endInput.value = draft.end;
    if (draft.notes)        notesInput.value = draft.notes;
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
/* =============================================================================
   STATS COMPUTATION
   -----------------------------------------------------------------------------
   Shared by the Stats pane (renderStats) and the CSV export so the two can
   never disagree. Operates on whatever slice of entries the caller passes in
   — always the currently-visible (view-filtered) set — so the numbers track
   the active view mode exactly like the Totals pane does.
============================================================================= */

type Stat = { label: string; value: string };

function computeStats(visible: Entry[]): Stat[] {
  if (visible.length === 0) return [];

  const totalEntries = visible.length;
  const totalMins = visible.reduce(
    (sum, e) => sum + (parseTime(e.end) - parseTime(e.start)),
    0,
  );
  const avgPerActivity = Math.round(totalMins / totalEntries);

  // Group by activity name (case-insensitive), same convention render() and
  // exportCSV() use for the Totals summary.
  const byActivity = new Map<string, { display: string; count: number; mins: number }>();
  visible.forEach((e) => {
    const key = e.activity.toLowerCase();
    const g = byActivity.get(key) ?? { display: e.activity, count: 0, mins: 0 };
    g.count += 1;
    g.mins += parseTime(e.end) - parseTime(e.start);
    byActivity.set(key, g);
  });

  let mostEntries = { display: "", count: 0 };
  let highestTime = { display: "", mins: 0 };
  let highestAvg = { display: "", mins: 0 };
  byActivity.forEach((g) => {
    if (g.count > mostEntries.count) mostEntries = { display: g.display, count: g.count };
    if (g.mins > highestTime.mins) highestTime = { display: g.display, mins: g.mins };
    const avg = g.mins / g.count;
    if (avg > highestAvg.mins) highestAvg = { display: g.display, mins: avg };
  });

  // Single entry with the highest duration.
  let longestEntry = visible[0]!;
  let longestMins = parseTime(longestEntry.end) - parseTime(longestEntry.start);
  visible.forEach((e) => {
    const mins = parseTime(e.end) - parseTime(e.start);
    if (mins > longestMins) { longestEntry = e; longestMins = mins; }
  });

  // Earliest start / latest finish, compared by time-of-day (mod 1440) so an
  // overnight entry's inflated end value (e.g. 25:30 for a 1:30am finish)
  // still ranks and displays correctly against same-day times.
  let earliestEntry = visible[0]!;
  let earliestMins = parseTime(earliestEntry.start) % 1440;
  let latestEntry = visible[0]!;
  let latestMins = parseTime(latestEntry.end) % 1440;
  visible.forEach((e) => {
    const sMins = parseTime(e.start) % 1440;
    if (sMins < earliestMins) { earliestEntry = e; earliestMins = sMins; }
    const eMins = parseTime(e.end) % 1440;
    if (eMins > latestMins) { latestEntry = e; latestMins = eMins; }
  });

  // Per-date grouping — "craziest" (most entries) and "busiest" (most time).
  const byDate = new Map<string, { count: number; mins: number }>();
  visible.forEach((e) => {
    const g = byDate.get(e.date) ?? { count: 0, mins: 0 };
    g.count += 1;
    g.mins += parseTime(e.end) - parseTime(e.start);
    byDate.set(e.date, g);
  });

  let craziestDate = "";
  let craziestCount = 0;
  let busiestDate = "";
  let busiestMins = 0;
  byDate.forEach((g, date) => {
    if (g.count > craziestCount) { craziestCount = g.count; craziestDate = date; }
    if (g.mins > busiestMins) { busiestMins = g.mins; busiestDate = date; }
  });

  const avgEntriesPerDay = totalEntries / byDate.size;

  return [
    {
      label: "Total Activities Logged",
      value: `${totalEntries} ${totalEntries === 1 ? "activity" : "activities"}`,
    },
    {
      label: "Unique Activities Tracked",
      value: `${byActivity.size} ${byActivity.size === 1 ? "activity" : "activities"}`,
    },
    {
      label: "Average Time per Activity",
      value: `${formatMinutes(avgPerActivity)} per activity`,
    },
    {
      label: "Activity with Most Entries",
      value: `${mostEntries.display} (${mostEntries.count} ${mostEntries.count === 1 ? "entry" : "entries"})`,
    },
    {
      label: "Activity with Highest Time",
      value: `${highestTime.display} (${formatMinutes(highestTime.mins)})`,
    },
    {
      label: "Activity with Highest Average Time",
      value: `${highestAvg.display} (${formatMinutes(Math.round(highestAvg.mins))})`,
    },
    {
      label: "Entry with Highest Time",
      value: `${longestEntry.activity} on ${formatDate(longestEntry.date)} (${formatMinutes(longestMins)})`,
    },
    {
      label: "Earliest Start",
      value: `${formatTime(minsToTimeString(earliestMins))} on ${formatDate(earliestEntry.date)} (${earliestEntry.activity})`,
    },
    {
      label: "Latest Finish",
      value: `${formatTime(minsToTimeString(latestMins))} on ${formatDate(latestEntry.date)} (${latestEntry.activity})`,
    },
    {
      label: "Craziest Day",
      value: `${formatDate(craziestDate)} (${craziestCount} ${craziestCount === 1 ? "entry" : "entries"})`,
    },
    {
      label: "Busiest Day",
      value: `${formatDate(busiestDate)} (${formatMinutes(busiestMins)})`,
    },
    {
      label: "Avg Entries per Day",
      value: `${avgEntriesPerDay.toFixed(1)} entries/day`,
    },
  ];
}

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

  lines.push("STATS");
  lines.push("Stat,Value");
  computeStats(visibleEntries).forEach((s) => {
    lines.push(`${csvField(s.label)},${csvField(s.value)}`);
  });
  lines.push("");

  lines.push("ENTRIES");
  lines.push("Date,Start,End,Activity,Duration,Notes");
  visibleEntries
    .slice()
    .sort((a, b) => {
      const d = a.date.localeCompare(b.date);
      return d !== 0 ? d : parseTime(a.start) - parseTime(b.start);
    })
    .forEach((e) => {
      const mins = parseTime(e.end) - parseTime(e.start);
      lines.push(
        `"${e.date}","${e.start}","${e.end}",${csvField(e.activity)},"${formatMinutes(mins)}",${csvField(e.notes)}`,
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
   CSV IMPORT
   -----------------------------------------------------------------------------
   Adds new entries from a user-provided CSV; never edits existing ones. All
   rows are validated before anything is added — if any row is missing a
   required field, the whole import is rejected and nothing changes.
============================================================================= */

const CSV_IMPORT_REQUIRED_COLUMNS = ["date", "start time", "end time", "activity"] as const;

/** Splits raw CSV text into rows of cells, honoring RFC4180 quoting (quoted
 *  fields may contain commas, newlines, and doubled "" as an escaped quote). */
function parseCsvText(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') { inQuotes = true; }
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\r") { /* skip — \n (below) closes the row */ }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else { field += ch; }
  }
  // A file that doesn't end with a newline still has a trailing row to flush.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function capitalizeHeader(h: string): string {
  return h.replace(/\b\w/g, (c) => c.toUpperCase());
}

type CsvImportResult =
  | { ok: true; entries: Entry[] }
  | { ok: false; message: string };

function parseCsvImport(raw: string): CsvImportResult {
  const rows = parseCsvText(raw).filter((r) => r.some((c) => c.trim() !== ""));
  if (rows.length === 0) {
    return { ok: false, message: "The file is empty." };
  }

  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  const colIndex: Record<string, number> = {};
  header.forEach((h, i) => { colIndex[h] = i; });

  const missingCols = CSV_IMPORT_REQUIRED_COLUMNS.filter((c) => !(c in colIndex));
  if (missingCols.length > 0) {
    return {
      ok: false,
      message: `Missing required column${missingCols.length > 1 ? "s" : ""}: ${missingCols.map(capitalizeHeader).join(", ")}.`,
    };
  }
  const notesIdx = colIndex["notes"];

  const errors: string[] = [];
  const parsed: Entry[] = [];

  rows.slice(1).forEach((row, i) => {
    const lineNum = i + 2; // +1 for the header row, +1 for 1-indexing
    const dateRaw     = (row[colIndex["date"]!] ?? "").trim();
    const startRaw    = (row[colIndex["start time"]!] ?? "").trim();
    const endRaw      = (row[colIndex["end time"]!] ?? "").trim();
    const activityRaw = (row[colIndex["activity"]!] ?? "").trim();
    const notesRaw     = notesIdx !== undefined ? (row[notesIdx] ?? "").trim() : "";

    const missing: string[] = [];
    if (!dateRaw) missing.push("Date");
    if (!startRaw) missing.push("Start Time");
    if (!endRaw) missing.push("End Time");
    if (!activityRaw) missing.push("Activity");
    if (missing.length > 0) {
      errors.push(`Line ${lineNum}: missing ${missing.join(", ")}.`);
      return;
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) {
      errors.push(`Line ${lineNum}: Date "${dateRaw}" isn't in YYYY-MM-DD format.`);
      return;
    }
    const start = normalizeTime(startRaw);
    const end = normalizeTime(endRaw);
    if (!start) { errors.push(`Line ${lineNum}: Start Time "${startRaw}" isn't a recognizable time.`); return; }
    if (!end)   { errors.push(`Line ${lineNum}: End Time "${endRaw}" isn't a recognizable time.`); return; }

    let startMins = parseTime(start);
    let endMins = parseTime(end);
    if (endMins <= startMins) endMins += 1440;

    parsed.push({
      date: dateRaw,
      start: minsToTimeString(startMins),
      end: minsToTimeString(endMins),
      activity: activityRaw,
      notes: notesRaw,
    });
  });

  if (errors.length > 0) {
    return {
      ok: false,
      message: `Import cancelled — ${errors.length} row${errors.length > 1 ? "s" : ""} failed validation:\n${errors.join("\n")}`,
    };
  }
  if (parsed.length === 0) {
    return { ok: false, message: "No data rows found in the file." };
  }

  return { ok: true, entries: parsed };
}

async function downloadCsvTemplate(): Promise<void> {
  try {
    await invoke("export_csv", {
      filename: "time-tracker-import-template.csv",
      data: "Date,Start Time,End Time,Activity,Notes",
    });
    flash("Template downloaded to Downloads!", "success");
  } catch (err) {
    devError("Template download failed:", err);
    flash("Template download failed.", "error");
  }
}

/* =============================================================================
   RENDER
============================================================================= */

function render(
  entriesDiv: HTMLElement,
  dayTotalDiv: HTMLElement,
  groupTotalsDiv: HTMLElement,
  statsDiv: HTMLElement,
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
        makeEditable(activitySpan, entry, "activity", entriesDiv, dayTotalDiv, groupTotalsDiv, statsDiv),
      );
      row.appendChild(activitySpan);

      const startSpan = document.createElement("span");
      startSpan.className = "entry-field entry-col-time";
      startSpan.textContent = formatTime(entry.start);
      startSpan.title = "Double-click to edit";
      startSpan.addEventListener("dblclick", () =>
        makeEditable(startSpan, entry, "start", entriesDiv, dayTotalDiv, groupTotalsDiv, statsDiv),
      );
      row.appendChild(startSpan);

      const endSpan = document.createElement("span");
      endSpan.className = "entry-field entry-col-time";
      endSpan.textContent = formatTime(entry.end);
      endSpan.title = "Double-click to edit";
      endSpan.addEventListener("dblclick", () =>
        makeEditable(endSpan, entry, "end", entriesDiv, dayTotalDiv, groupTotalsDiv, statsDiv),
      );
      row.appendChild(endSpan);

      const durSpan = document.createElement("span");
      durSpan.className = "entry-col-duration";
      durSpan.textContent = formatMinutes(mins);
      row.appendChild(durSpan);

      const notesSpan = document.createElement("span");
      notesSpan.className = "entry-field entry-col-notes";
      notesSpan.textContent = entry.notes;
      notesSpan.title = "Double-click to edit";
      notesSpan.addEventListener("dblclick", () =>
        openNotesEditModal(entry, () => render(entriesDiv, dayTotalDiv, groupTotalsDiv, statsDiv)),
      );
      row.appendChild(notesSpan);

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
          render(entriesDiv, dayTotalDiv, groupTotalsDiv, statsDiv);
        }

        dateInput.addEventListener("change", commitDate);
        dateInput.addEventListener("blur", () => render(entriesDiv, dayTotalDiv, groupTotalsDiv, statsDiv));
      });
      row.appendChild(calBtn);

      const deleteBtn = document.createElement("button");
      deleteBtn.textContent = "🗑️";
      deleteBtn.className = "entry-delete-btn";
      deleteBtn.addEventListener("click", () =>
        deleteEntry(entryIndex, entriesDiv, dayTotalDiv, groupTotalsDiv, statsDiv),
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

  renderStats(statsDiv, visible);
}

/* =============================================================================
   STATS PANE
============================================================================= */

function renderStats(statsDiv: HTMLElement, visible: Entry[]): void {
  statsDiv.innerHTML = "";
  const stats = computeStats(visible);

  if (stats.length === 0) {
    const p = document.createElement("p");
    p.className = "placeholder-text";
    p.textContent = "No entries in this view yet.";
    statsDiv.appendChild(p);
    return;
  }

  stats.forEach((stat) => {
    const row = document.createElement("div");
    row.className = "stat-row";

    const label = document.createElement("span");
    label.className = "stat-label";
    label.textContent = stat.label;
    row.appendChild(label);

    const value = document.createElement("span");
    value.className = "stat-value";
    value.textContent = stat.value;
    row.appendChild(value);

    statsDiv.appendChild(row);
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
  statsDiv: HTMLElement,
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
      // Inline-editing the activity name should register it for autocomplete
      // too, same as adding a fresh entry.
      if (field === "activity") findOrCreateActivity(raw);
    }

    let startMins = parseTime(entry.start);
    let endMins = parseTime(entry.end);
    if (endMins <= startMins) endMins += 1440;
    entry.end = minsToTimeString(endMins);

    sortEntries();
    render(entriesDiv, dayTotalDiv, groupTotalsDiv, statsDiv);
    saveToDisk();
    flash("Entry edited", "success");
  }

  function cancel() {
    render(entriesDiv, dayTotalDiv, groupTotalsDiv, statsDiv);
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
  notes: string,
  datePicker: HTMLInputElement,
  activityInput: HTMLInputElement,
  startInput: HTMLInputElement,
  endInput: HTMLInputElement,
  notesInput: HTMLTextAreaElement,
  entriesDiv: HTMLElement,
  dayTotalDiv: HTMLElement,
  groupTotalsDiv: HTMLElement,
  statsDiv: HTMLElement,
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
    notes,
  });

  sortEntries();
  lastActivity = activity;
  // Remember this activity name for autocomplete — silent quick-add, mirrors
  // Budget calling findOrCreateExpenseSource on entry commit.
  findOrCreateActivity(activity);

  render(entriesDiv, dayTotalDiv, groupTotalsDiv, statsDiv);
  await saveToDisk();
  flash("Entry added", "success");

  activityInput.value = "";
  startInput.value = "";
  endInput.value = "";
  notesInput.value = "";
  saveDraft(datePicker, activityInput, startInput, endInput, notesInput);
  updateDurationPreview(startInput, endInput, durationPreview);
}

async function deleteEntry(
  index: number,
  entriesDiv: HTMLElement,
  dayTotalDiv: HTMLElement,
  groupTotalsDiv: HTMLElement,
  statsDiv: HTMLElement,
): Promise<void> {
  if (settings.quickDelete) {
    entries.splice(index, 1);
    render(entriesDiv, dayTotalDiv, groupTotalsDiv, statsDiv);
    await saveToDisk();
    flash("Entry deleted", "success");
  } else {
    openDeleteModal(index);
  }
}

/* =============================================================================
   ACTIVITIES — SETUP LIST + AUTOCOMPLETE SOURCE
   -----------------------------------------------------------------------------
   Mirrors Budget's Expense Sources: a {id,name,status} list managed in the
   Setup modal, used to populate the Activity field's datalist (Phase 3).
============================================================================= */

/**
 * Silent quick-add used from the main entry form (typed Activity text, or an
 * inline activity edit). Matches an existing ACTIVE activity case-insensitively
 * and does nothing if found; otherwise creates a new active one. No toast, no
 * reactivation of retired items — mirrors Budget's findOrCreate (active-only)
 * as opposed to the explicit addOrReactivate path used by the Setup button.
 */
function findOrCreateActivity(name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  const existing = activities.find(
    (a) => a.status === "active" && a.name.toLowerCase() === trimmed.toLowerCase(),
  );
  if (existing) return;
  activities.push({ id: makeId(), name: trimmed, status: "active" });
  saveSettings();
  refreshActivityDatalist();
  renderActivitiesList();
}

/**
 * Explicit add from the Setup modal's "+ New Activity" button. Reactivates a
 * matching retired activity instead of creating a duplicate. Mirrors Budget's
 * addOrReactivateSimple.
 */
function addOrReactivateActivity(name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;

  const existing = activities.find(
    (a) => a.name.toLowerCase() === trimmed.toLowerCase(),
  );
  const wasReactivated = !!existing && existing.status === "retired";
  if (existing) {
    existing.status = "active";
  } else {
    activities.push({ id: makeId(), name: trimmed, status: "active" });
  }

  flash(wasReactivated ? "Activity reactivated" : "Activity added", "success");
  saveSettings();
  refreshActivityDatalist();
  renderActivitiesList();
}

/**
 * Repopulates the Activity field's <datalist> from active activities.
 * No-op until Phase 3 adds the datalist element — safe to call now.
 */
function refreshActivityDatalist(): void {
  const datalist = document.getElementById("ttActivityList") as HTMLDataListElement | null;
  if (!datalist) return;
  datalist.innerHTML = "";
  activities
    .filter((a) => a.status === "active")
    .map((a) => a.name)
    .sort((a, b) => a.localeCompare(b))
    .forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      datalist.appendChild(opt);
    });
}

function buildActivityRow(item: Activity): HTMLElement {
  const row = document.createElement("div");
  row.className = "setup-item";
  if (item.status === "retired") row.classList.add("setup-item-retired");

  const nameSpan = document.createElement("span");
  nameSpan.className = "setup-item-name";
  nameSpan.textContent = item.name;
  if (item.status === "retired") {
    const retiredBadge = document.createElement("span");
    retiredBadge.className = "setup-item-retired-badge";
    retiredBadge.textContent = "Retired";
    retiredBadge.style.marginLeft = "8px";
    nameSpan.appendChild(retiredBadge);
  }
  row.appendChild(nameSpan);

  const chevron = document.createElement("span");
  chevron.className = "setup-item-chevron";
  chevron.textContent = "›";
  row.appendChild(chevron);

  row.style.cursor = "pointer";
  row.addEventListener("click", () => openActivityEdit(item));
  return row;
}

function renderActivitiesList(): void {
  const container = document.getElementById("ttActivitiesList");
  if (!container) return;
  container.innerHTML = "";

  if (activities.length === 0) {
    const p = document.createElement("p");
    p.className = "placeholder-text";
    p.textContent = "No activities yet — add one above.";
    container.appendChild(p);
    return;
  }

  [...activities]
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === "active" ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .forEach((item) => container.appendChild(buildActivityRow(item)));
}

/* =============================================================================
   MODAL — TT SETUP (Projects / Activities / Preferences tabs)
   -----------------------------------------------------------------------------
   Module-level (like Budget's getSetupModal) so the Activity Add/Edit/Delete
   modals can reopen Setup on the Activities tab after their actions.
============================================================================= */

type TTSetupTab = "projects" | "activities" | "preferences";
let ttActiveSetupTab: TTSetupTab = "projects";
let ttSetupModal: Modal | null = null;
const _ttSetupPanesToReset = new Set<string>();

// Set by initTimeTracker so module-level code (activity rename/delete, which
// mutate entries) can re-render the ledger without threading DOM refs out here.
let renderCurrentView: () => void = () => {};

function activateTTSetupTab(tab: TTSetupTab): void {
  ttActiveSetupTab = tab;
  document
    .querySelectorAll<HTMLButtonElement>("#ttSettingsModal .setup-tab")
    .forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.ttTab === tab);
    });

  const paneIds: Record<TTSetupTab, string> = {
    projects: "ttTabProjects",
    activities: "ttTabActivities",
    preferences: "ttTabPreferences",
  };

  for (const [key, id] of Object.entries(paneIds)) {
    const pane = document.getElementById(id)!;
    const isActive = key === tab;
    pane.style.display = isActive ? "" : "none";
    if (isActive && _ttSetupPanesToReset.has(id)) {
      pane.scrollTop = 0;
      _ttSetupPanesToReset.delete(id);
    }
  }
}

function openTTSetupOnTab(tab?: TTSetupTab): void {
  if (tab) ttActiveSetupTab = tab;
  getTTSetupModal().open();
}

function getTTSetupModal(): Modal {
  if (!ttSetupModal) {
    ttSetupModal = new Modal(document.getElementById("ttSettingsBackdrop")!, {
      closeOnEsc: true,
      onOpen: () => {
        activateTTSetupTab(ttActiveSetupTab);
        renderActivitiesList();
        applyTTSettings();
      },
      onClosed: () => {
        _ttSetupPanesToReset.add("ttTabProjects");
        _ttSetupPanesToReset.add("ttTabActivities");
        _ttSetupPanesToReset.add("ttTabPreferences");
      },
    });

    document
      .querySelectorAll<HTMLButtonElement>("#ttSettingsModal .setup-tab")
      .forEach((btn) => {
        btn.addEventListener("click", () =>
          activateTTSetupTab(btn.dataset.ttTab as TTSetupTab),
        );
      });

    document.getElementById("ttSettingsClose")!.addEventListener("click", () => ttSetupModal!.close());
  }
  return ttSetupModal;
}

/* =============================================================================
   MODAL — ACTIVITY ADD / EDIT (fully independent, mirrors Budget's simple
   source/category modals)
============================================================================= */

let ttActivityAddModal: Modal | null = null;
let ttActivityEditModal: Modal | null = null;
let ttActivityEditItem: Activity | null = null;

function getActivityAddModal(): Modal {
  if (!ttActivityAddModal) {
    const nameInput = document.getElementById("ttActivityAddName") as HTMLInputElement;

    ttActivityAddModal = new Modal(document.getElementById("ttActivityAddBackdrop")!, {
      closeOnEsc: true,
      onOpen: () => setTimeout(() => nameInput.focus(), 50),
    });

    function goBack() { ttActivityAddModal!.close(); openTTSetupOnTab("activities"); }
    function doSave() {
      const name = nameInput.value.trim();
      if (!name) { flash("Name cannot be empty", "error"); return; }
      addOrReactivateActivity(name);
      ttActivityAddModal!.close();
      openTTSetupOnTab("activities");
    }

    document.getElementById("ttActivityAddBack")!.addEventListener("click", goBack);
    document.getElementById("ttActivityAddClose")!.addEventListener("click", () => ttActivityAddModal!.close());
    document.getElementById("ttActivityAddCancel")!.addEventListener("click", goBack);
    document.getElementById("ttActivityAddSave")!.addEventListener("click", doSave);
    nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doSave(); } });
  }
  return ttActivityAddModal;
}

function openActivityAdd(): void {
  getTTSetupModal().close();
  (document.getElementById("ttActivityAddName") as HTMLInputElement).value = "";
  getActivityAddModal().open();
}

function getActivityEditModal(): Modal {
  if (!ttActivityEditModal) {
    const nameInput = document.getElementById("ttActivityEditName") as HTMLInputElement;
    const retireBtn = document.getElementById("ttActivityEditRetire") as HTMLButtonElement;
    const deleteBtn = document.getElementById("ttActivityEditDelete") as HTMLButtonElement;

    ttActivityEditModal = new Modal(document.getElementById("ttActivityEditBackdrop")!, {
      closeOnEsc: true,
      onOpen: () => setTimeout(() => nameInput.focus(), 50),
      onClosed: () => { ttActivityEditItem = null; },
    });

    function goBack() { ttActivityEditModal!.close(); openTTSetupOnTab("activities"); }
    function doSave() {
      if (!ttActivityEditItem) return;
      const name = nameInput.value.trim();
      if (!name) { flash("Name cannot be empty", "error"); return; }
      const oldName = ttActivityEditItem.name;
      ttActivityEditItem.name = name;
      // Entries store the activity as a free-text name (not an id), so a rename
      // must rewrite every matching entry to keep history in sync. Match
      // case-insensitively but write the new canonical casing.
      if (oldName.toLowerCase() !== name.toLowerCase()) {
        let changed = 0;
        entries.forEach((e) => {
          if (e.activity.toLowerCase() === oldName.toLowerCase()) {
            e.activity = name;
            changed++;
          }
        });
        if (changed > 0) saveToDisk();
      }
      saveSettings();
      refreshActivityDatalist();
      renderCurrentView();
      flash("Activity saved", "success");
      goBack();
    }

    document.getElementById("ttActivityEditBack")!.addEventListener("click", goBack);
    document.getElementById("ttActivityEditClose")!.addEventListener("click", () => ttActivityEditModal!.close());
    document.getElementById("ttActivityEditCancel")!.addEventListener("click", goBack);
    document.getElementById("ttActivityEditSave")!.addEventListener("click", doSave);
    nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doSave(); } });

    retireBtn.addEventListener("click", () => {
      if (!ttActivityEditItem) return;
      ttActivityEditItem.status = ttActivityEditItem.status === "active" ? "retired" : "active";
      saveSettings();
      refreshActivityDatalist();
      flash(ttActivityEditItem.status === "retired" ? "Activity retired" : "Activity reactivated", "success");
      goBack();
    });

    deleteBtn.addEventListener("click", () => {
      if (!ttActivityEditItem) return;
      const item = ttActivityEditItem;
      ttActivityEditModal!.close();
      openTTSetupDelete(item.id, item.name);
    });
  }
  return ttActivityEditModal;
}

function openActivityEdit(item: Activity): void {
  ttActivityEditItem = item;
  getTTSetupModal().close();
  getActivityEditModal(); // ensure wired
  (document.getElementById("ttActivityEditName") as HTMLInputElement).value = item.name;
  const retireBtn = document.getElementById("ttActivityEditRetire") as HTMLButtonElement;
  const deleteBtn = document.getElementById("ttActivityEditDelete") as HTMLButtonElement;
  retireBtn.textContent = item.status === "active" ? "Retire" : "Reactivate";
  deleteBtn.style.display = item.status === "retired" ? "" : "none";
  getActivityEditModal().open();
}

/* =============================================================================
   MODAL — TT SETUP DELETE CONFIRM
   Only reachable for an already-retired Activity (Delete is hidden until an
   item is retired — mirrors Budget's setup delete flow).
============================================================================= */

let ttSetupDeleteModal: Modal | null = null;
let pendingActivityDelete: { id: string; name: string } | null = null;

function getTTSetupDeleteModal(): Modal {
  if (!ttSetupDeleteModal) {
    ttSetupDeleteModal = new Modal(document.getElementById("ttSetupDeleteBackdrop")!, {
      closeOnEsc: true,
      onClosed: () => { pendingActivityDelete = null; },
    });

    document.getElementById("ttSetupDeleteConfirmBtn")!.addEventListener("click", () => {
      if (!pendingActivityDelete) return;
      const { id, name } = pendingActivityDelete;
      activities = activities.filter((a) => a.id !== id);
      // Entries store the name, not an id — so orphaned entries would keep a
      // name that no longer exists in the list. Reassign them to "Unknown"
      // (the delete confirm already warned how many are affected). This is
      // why Retire exists: it preserves the name on history without deletion.
      let changed = 0;
      entries.forEach((e) => {
        if (e.activity.toLowerCase() === name.toLowerCase()) {
          e.activity = "Unknown";
          changed++;
        }
      });
      pendingActivityDelete = null;
      if (changed > 0) { saveToDisk(); renderCurrentView(); }
      saveSettings();
      refreshActivityDatalist();
      ttSetupDeleteModal!.close();
      openTTSetupOnTab("activities");
      flash("Activity deleted", "success");
    });

    document.getElementById("ttSetupDeleteCancelBtn")!.addEventListener("click", () => {
      pendingActivityDelete = null;
      ttSetupDeleteModal!.close();
      openTTSetupOnTab("activities");
    });
  }
  return ttSetupDeleteModal;
}

function openTTSetupDelete(id: string, name: string): void {
  pendingActivityDelete = { id, name };
  const impactCount = entries.filter(
    (e) => e.activity.toLowerCase() === name.toLowerCase(),
  ).length;
  const impactNote = impactCount > 0
    ? ` ${impactCount} logged ${impactCount === 1 ? "entry" : "entries"} will be reassigned to "Unknown".`
    : "";
  document.getElementById("ttSetupDeleteMessage")!.textContent =
    `Permanently delete "${name}"?${impactNote} This can't be undone.`;
  getTTSetupDeleteModal().open();
}

/* =============================================================================
   MODAL — CSV IMPORT
   Mirrors the Activity Add/Edit modals' "leaves Setup, returns to Setup on
   close" pattern — Back, the header X, and Cancel all return to the
   Preferences tab rather than closing to the underlying tool view.
============================================================================= */

function refreshCsvImportStatusUI(): void {
  const text = settings.lastCsvImportAt
    ? `Last import: ${formatImportTimestamp(settings.lastCsvImportAt)}`
    : "Never imported";
  const badge = document.getElementById("ttCsvImportStatus");
  if (badge) badge.textContent = text;
  const modalLine = document.getElementById("ttCsvImportLastRow");
  if (modalLine) modalLine.textContent = text;
}

function showCsvImportResult(kind: "success" | "error", message: string): void {
  const el = document.getElementById("ttCsvImportResult") as HTMLElement;
  el.textContent = message;
  el.className = `tt-csv-import-result ${kind}`;
  el.style.display = "";
}

function hideCsvImportResult(): void {
  const el = document.getElementById("ttCsvImportResult") as HTMLElement;
  el.style.display = "none";
  el.textContent = "";
  el.className = "tt-csv-import-result";
}

let csvImportModal: Modal | null = null;
let csvImportSelectedPath: string | null = null;

function resetCsvImportModalState(): void {
  csvImportSelectedPath = null;
  document.getElementById("ttCsvImportFileName")!.textContent = "No file selected";
  (document.getElementById("ttCsvImportRunBtn") as HTMLButtonElement).disabled = true;
  hideCsvImportResult();
}

async function runCsvImport(): Promise<void> {
  if (!csvImportSelectedPath) return;
  const runBtn = document.getElementById("ttCsvImportRunBtn") as HTMLButtonElement;
  runBtn.disabled = true;

  let raw: string;
  try {
    raw = await invoke<string>("import_csv", { path: csvImportSelectedPath });
  } catch (err) {
    devError("CSV read failed:", err);
    showCsvImportResult("error", `Could not read the file: ${err}`);
    runBtn.disabled = false;
    return;
  }

  const result = parseCsvImport(raw);
  if (!result.ok) {
    showCsvImportResult("error", result.message);
    runBtn.disabled = false;
    return;
  }

  result.entries.forEach((e) => {
    entries.push(e);
    findOrCreateActivity(e.activity);
  });
  sortEntries();
  await saveToDisk();
  refreshActivityDatalist();
  renderCurrentView();

  settings.lastCsvImportAt = new Date().toISOString();
  saveSettings();
  refreshCsvImportStatusUI();

  showCsvImportResult(
    "success",
    `Imported ${result.entries.length} ${result.entries.length === 1 ? "entry" : "entries"}.`,
  );
  flash("CSV import complete", "success");
}

function getCsvImportModal(): Modal {
  if (!csvImportModal) {
    csvImportModal = new Modal(document.getElementById("ttCsvImportBackdrop")!, {
      closeOnEsc: true,
      onOpen: () => refreshCsvImportStatusUI(),
      onClosed: () => resetCsvImportModalState(),
    });

    function goBack() { csvImportModal!.close(); openTTSetupOnTab("preferences"); }

    document.getElementById("ttCsvImportBack")!.addEventListener("click", goBack);
    document.getElementById("ttCsvImportClose")!.addEventListener("click", goBack);
    document.getElementById("ttCsvImportCancelBtn")!.addEventListener("click", goBack);

    document.getElementById("ttCsvImportTemplateBtn")!.addEventListener("click", downloadCsvTemplate);

    document.getElementById("ttCsvImportChooseBtn")!.addEventListener("click", async () => {
      const selected = await open({
        multiple: false,
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (!selected || Array.isArray(selected)) return;
      csvImportSelectedPath = selected;
      document.getElementById("ttCsvImportFileName")!.textContent =
        selected.split(/[\\/]/).pop() || selected;
      (document.getElementById("ttCsvImportRunBtn") as HTMLButtonElement).disabled = false;
      hideCsvImportResult();
    });

    document.getElementById("ttCsvImportRunBtn")!.addEventListener("click", runCsvImport);
  }
  return csvImportModal;
}

function openCsvImportModal(): void {
  getTTSetupModal().close();
  resetCsvImportModalState();
  getCsvImportModal().open();
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
   MODAL — EDIT NOTES
   Notes get a dedicated modal (a plain multi-line textarea) rather than the
   inline entry-edit-input used by the other columns — multi-line text
   doesn't fit a single-line inline editor.
============================================================================= */

let notesEditModal: Modal | null = null;
let notesEditEntry: Entry | null = null;
let notesEditRerender: () => void = () => {};

function getNotesEditModal(): Modal {
  if (!notesEditModal) {
    const textarea = document.getElementById("ttNotesEditTextarea") as HTMLTextAreaElement;

    notesEditModal = new Modal(document.getElementById("ttNotesEditBackdrop")!, {
      closeOnEsc: true,
      onOpen: () => setTimeout(() => textarea.focus(), 50),
      onClosed: () => { notesEditEntry = null; },
    });

    function doSave() {
      if (!notesEditEntry) return;
      notesEditEntry.notes = textarea.value;
      saveToDisk();
      notesEditRerender();
      flash("Notes updated", "success");
      notesEditModal!.close();
    }

    document.getElementById("ttNotesEditClose")!.addEventListener("click", () => notesEditModal!.close());
    document.getElementById("ttNotesEditCancel")!.addEventListener("click", () => notesEditModal!.close());
    document.getElementById("ttNotesEditSave")!.addEventListener("click", doSave);
  }
  return notesEditModal;
}

function openNotesEditModal(entry: Entry, rerender: () => void): void {
  notesEditEntry = entry;
  notesEditRerender = rerender;
  (document.getElementById("ttNotesEditTextarea") as HTMLTextAreaElement).value = entry.notes;
  document.getElementById("ttNotesEditContext")!.textContent =
    `${formatDate(entry.date)} · ${entry.activity} · ${formatTime(entry.start)}–${formatTime(entry.end)}`;
  getNotesEditModal().open();
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
  statsDiv: HTMLElement,
): void {
  const range = getPresetRange(preset);
  viewStart = range.start;
  viewEnd = range.end;
  viewStartInput.value = range.start;
  viewEndInput.value = range.end;

  document.querySelectorAll("#utility-tool-time-tracker .preset-btn").forEach((btn) => {
    btn.classList.toggle("active", (btn as HTMLElement).dataset.preset === preset);
  });

  render(entriesDiv, dayTotalDiv, groupTotalsDiv, statsDiv);
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
  const notesInput      = document.getElementById("notesInput") as HTMLTextAreaElement;
  const datePicker      = document.getElementById("datePicker") as HTMLInputElement;
  const viewStartInput  = document.getElementById("viewStart") as HTMLInputElement;
  const viewEndInput    = document.getElementById("viewEnd") as HTMLInputElement;
  const entriesDiv      = document.getElementById("entries")!;
  const dayTotalDiv     = document.getElementById("dayTotal")!;
  const groupTotalsDiv  = document.getElementById("groupTotals")!;
  const statsDiv        = document.getElementById("statsPanel")!;
  const durationPreview = document.getElementById("durationPreview")!;
  // Convenience wrappers so inner functions don't have to pass DOM refs everywhere
  function doRender() {
    render(entriesDiv, dayTotalDiv, groupTotalsDiv, statsDiv);
  }
  function doSaveDraft() {
    saveDraft(datePicker, activityInput, startInput, endInput, notesInput);
  }
  function doUpdateDurationPreview() {
    updateDurationPreview(startInput, endInput, durationPreview);
  }
  function doApplyPreset(preset: string) {
    applyPreset(preset, viewStartInput, viewEndInput, entriesDiv, dayTotalDiv, groupTotalsDiv, statsDiv);
  }
  // Module-level activity rename/delete mutate entries and need to refresh the
  // ledger; expose doRender to them without leaking DOM refs out of init.
  renderCurrentView = doRender;

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
      start, end, activity, notesInput.value.trim(),
      datePicker, activityInput, startInput, endInput, notesInput,
      entriesDiv, dayTotalDiv, groupTotalsDiv, statsDiv, durationPreview,
    );
  });

  document.getElementById("clearBtn")!.addEventListener("click", (e) => {
    e.preventDefault();
    activityInput.value = "";
    startInput.value = "";
    endInput.value = "";
    notesInput.value = "";
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

  [activityInput, startInput, endInput, notesInput].forEach((input) => {
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
     EVENT LISTENERS — TT SETUP MODAL
     Modal instantiation/tabs/Reset live at module level (getTTSetupModal) so
     the Activity Add/Edit modals can reopen Setup on the Activities tab.
  -------------------------------------------------------------------------- */

  document.getElementById("ttSetupBtn")!.addEventListener("click", () => openTTSetupOnTab("projects"));
  document.getElementById("ttActivityNewBtn")!.addEventListener("click", openActivityAdd);
  document.getElementById("ttCsvImportBtn")!.addEventListener("click", openCsvImportModal);

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
    loadDraft(datePicker, activityInput, startInput, endInput, notesInput, doUpdateDurationPreview),
  ]).then(() => {
    const draftHasData = activityInput.value || startInput.value || endInput.value || notesInput.value;
    if (!draftHasData) {
      datePicker.value = today();
      selectedDate = today();
    } else {
      selectedDate = datePicker.value;
    }
    // Activities are loaded by loadSettings(); reflect them in the Setup list
    // and the autocomplete source now that they're in memory.
    renderActivitiesList();
    refreshActivityDatalist();
    doApplyPreset("today");
  });
}
