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
     save_data, load_data, save_draft, load_draft, export_csv, import_csv,
     save_tool_settings, load_tool_settings, load_settings (legacy-key migration)
============================================================================= */

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { flash, devError } from "../shell";
import { Modal } from "../modal";

/* =============================================================================
   TYPES
============================================================================= */

type Entry = {
  date: string;     // start date, YYYY-MM-DD
  start: string;    // start time, real HH:MM:SS (00:00:00-23:59:59)
  endDate: string;  // end date, YYYY-MM-DD — always >= date
  end: string;      // end time, real HH:MM:SS (00:00:00-23:59:59)
  activity: string;
  project: string;  // free-text project name, "" if unset — optional grouping
  notes: string;
};

// A separate {id, name, status} list — same shape/spirit as Budget's
// SimpleEntity — powering the Activity field's autocomplete (Phase 3) and the
// Setup modal's Activities tab. Entries above keep storing `activity` as free
// text; this list never rewrites history, it just remembers names that have
// been used so they can be suggested/managed.
type ActivityStatus = "active" | "retired";
type Activity = { id: string; name: string; status: ActivityStatus };

// Same shape/spirit as Activity, plus a user-assigned integer ID (unique
// across all projects) used to categorize groups of related entries.
// Entries store `project` as free text (like `activity`), not this id.
type Project = { id: string; projectNumber: number; name: string; status: ActivityStatus };

// TT-specific settings — shell owns fontScale, theme, hour12 at the app level,
// but TT reads them back from disk so its render/format functions still work.
type TTSettings = {
  fontScale: number;
  americanDates: boolean;
  hour12: boolean;
  theme: string;
  randomColors: Record<string, string>;
  quickDelete: boolean;
  // When true (default), the Start/End "Now" buttons drop seconds and fill
  // whole-minute times. When false, they fill the exact current time
  // including seconds.
  roundNowToMinute: boolean;
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
let projects: Project[] = [];
let lastActivity = "";
let selectedDate: string = today();
// True once the user has directly touched the End Date field on the entry
// form — after that, End Date no longer auto-follows Start Date, and the
// overnight-rollover convenience (see addEntry) stops applying.
let endDateManuallySet = false;
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
  roundNowToMinute: true,
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

/** Returns a YYYY-MM-DD date offset by `days` (may be negative). Uses local
 *  midnight so it's immune to DST shifts affecting the date component. */
function addDaysToDate(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return localDateString(d);
}

/** Whole-day index for a YYYY-MM-DD string, for duration math across dates.
 *  UTC-based so it's just a day count, unaffected by local DST transitions. */
function dateToDayIndex(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return Math.floor(Date.UTC(y!, m! - 1, d!) / 86400000);
}

/** Number of calendar days between two YYYY-MM-DD strings (b - a). */
function daysBetween(a: string, b: string): number {
  return dateToDayIndex(b) - dateToDayIndex(a);
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

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Parses a canonical "HH:MM" or "HH:MM:SS" string into total seconds since
 *  midnight. A missing seconds component (legacy data, or a caller that only
 *  ever dealt in minutes) is treated as :00. */
function parseTime(t: string): number {
  const [h, m, s] = t.split(":").map(Number);
  return (h ?? 0) * 3600 + (m ?? 0) * 60 + (s ?? 0);
}

/** Formats a duration in total seconds as "Xh Ym Zs" — minutes and seconds
 *  are always shown, even at :00, the same way a time typed as just an hour
 *  still normalizes (and displays) with ":00" minutes. */
function formatDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${h}h ${m}m ${s}s`;
}

/** Splits a bare digit run (no separators) into an {h,m,s} triple using
 *  positional convention: minutes and seconds are always 2 digits, so
 *  whatever's left at the front is the hour.
 *    1-2 digits -> H(H)      (hour only)
 *    3 digits   -> H MM      (single-digit hour + minutes)
 *    4 digits   -> HH MM
 *    5 digits   -> H MM SS   (single-digit hour + minutes + seconds)
 *    6 digits   -> HH MM SS
 *  Returns null for any other length (including 0) — never silently
 *  truncates or guesses at a reading. */
function splitDigitsToClock(digits: string): { h: number; m: number; s: number } | null {
  switch (digits.length) {
    case 1:
    case 2:
      return { h: parseInt(digits, 10), m: 0, s: 0 };
    case 3:
      return { h: parseInt(digits.slice(0, 1), 10), m: parseInt(digits.slice(1), 10), s: 0 };
    case 4:
      return { h: parseInt(digits.slice(0, 2), 10), m: parseInt(digits.slice(2), 10), s: 0 };
    case 5:
      return {
        h: parseInt(digits.slice(0, 1), 10),
        m: parseInt(digits.slice(1, 3), 10),
        s: parseInt(digits.slice(3), 10),
      };
    case 6:
      return {
        h: parseInt(digits.slice(0, 2), 10),
        m: parseInt(digits.slice(2, 4), 10),
        s: parseInt(digits.slice(4), 10),
      };
    default:
      return null;
  }
}

/** Whether h/m/s fall in valid clock ranges. minHour/maxHour let callers
 *  distinguish a 24h reading (0-23) from a still-unshifted 12h reading
 *  (1-12 — a 12-hour clock never reads 0, and never exceeds 12). */
function isValidClock(h: number, m: number, s: number, minHour: number, maxHour: number): boolean {
  return h >= minHour && h <= maxHour && m >= 0 && m <= 59 && s >= 0 && s <= 59;
}

/** Normalizes a user-typed time (12h or 24h, with or without seconds) into a
 *  canonical "HH:MM:SS" string, or "" if unparseable OR out of range — every
 *  branch below validates before returning, so a caller can trust that a
 *  non-empty result is always a real, in-range time. There is no "hour ≥24
 *  rolls to the next day" reading anywhere here: with Start/End Date now
 *  explicit fields, an inflated hour is just invalid input, not a shorthand
 *  for tomorrow. */
function normalizeTime(input: string): string {
  const trimmed = input.trim().toLowerCase();

  // Explicit colon-delimited 24h time, with optional seconds — matched
  // verbatim (and validated) before the digit-only heuristics below, which
  // would otherwise strip the colons and misread a 5-6 digit HH:MM:SS as a
  // bare HHMMSS value.
  const colonMatch = trimmed.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (colonMatch) {
    const hours = parseInt(colonMatch[1]!, 10);
    const minutes = parseInt(colonMatch[2]!, 10);
    const seconds = parseInt(colonMatch[3] || "0", 10);
    if (!isValidClock(hours, minutes, seconds, 0, 23)) return "";
    return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
  }

  // Colon-delimited 12h time with an am/pm suffix — "9:30pm", "9:30:15pm".
  const colonSuffixMatch = trimmed.match(
    /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?m?\.?)$/,
  );
  if (colonSuffixMatch) {
    let hours = parseInt(colonSuffixMatch[1]!, 10);
    const minutes = parseInt(colonSuffixMatch[2]!, 10);
    const seconds = parseInt(colonSuffixMatch[3] || "0", 10);
    if (!isValidClock(hours, minutes, seconds, 1, 12)) return "";
    const suffix = colonSuffixMatch[4]!.replace(/\./g, "");
    if (suffix.startsWith("a") && hours === 12) hours = 0;
    if (suffix.startsWith("p") && hours !== 12) hours += 12;
    return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
  }

  // Bare digit run with an am/pm suffix and no separators — "930pm",
  // "0930pm", "93045pm" — split by the digit-length convention above rather
  // than misreading the whole run as an hour (e.g. "930pm" used to parse as
  // hour 930, which "+12"'d into a nonsense value like "942:00:00").
  const bareSuffixMatch = trimmed.match(/^(\d{1,6})\s*([ap]\.?m?\.?)$/);
  if (bareSuffixMatch) {
    const parts = splitDigitsToClock(bareSuffixMatch[1]!);
    if (!parts || !isValidClock(parts.h, parts.m, parts.s, 1, 12)) return "";
    let hours = parts.h;
    const suffix = bareSuffixMatch[2]!.replace(/\./g, "");
    if (suffix.startsWith("a") && hours === 12) hours = 0;
    if (suffix.startsWith("p") && hours !== 12) hours += 12;
    return `${pad2(hours)}:${pad2(parts.m)}:${pad2(parts.s)}`;
  }

  // Bare digit run, no suffix at all — 24h reading via the same split.
  const cleaned = trimmed.replace(/[^0-9]/g, "");
  if (!cleaned) return "";
  const parts = splitDigitsToClock(cleaned);
  if (!parts || !isValidClock(parts.h, parts.m, parts.s, 0, 23)) return "";
  return `${pad2(parts.h)}:${pad2(parts.m)}:${pad2(parts.s)}`;
}

// Every character normalizeTime() can ever make sense of — digits, the
// separators, and am/pm (with or without periods), either case.
const TIME_INPUT_CHARS = /[^0-9:. apmAPM]/g;

/** Live keystroke guard for a Start/End time field: strips any character
 *  that couldn't possibly be part of a valid time as the user types, so
 *  garbage letters/symbols can't even be entered. This is a UX filter only —
 *  it doesn't validate the VALUE (e.g. "99:99" still passes it fine); that's
 *  normalizeTime()'s job at commit time. Preserves caret position so typing
 *  mid-string doesn't jump the cursor around. */
function restrictToTimeChars(input: HTMLInputElement): void {
  input.addEventListener("input", () => {
    const raw = input.value;
    const cleaned = raw.replace(TIME_INPUT_CHARS, "");
    if (cleaned === raw) return;
    const caret = input.selectionStart ?? raw.length;
    const caretAfterClean = raw.slice(0, caret).replace(TIME_INPUT_CHARS, "").length;
    input.value = cleaned;
    input.setSelectionRange(caretAfterClean, caretAfterClean);
  });
}

/** The current wall-clock time as "HH:MM" or "HH:MM:SS", per the "Round Now
 *  to Whole Minute" preference — used by the Start/End "Now" buttons. */
function nowTimeString(): string {
  const raw = new Date().toTimeString(); // "HH:MM:SS GMT+..."
  return settings.roundNowToMinute ? raw.slice(0, 5) : raw.slice(0, 8);
}

/** Converts a total-seconds value to a zero-padded "HH:MM:SS" string. */
function secondsToTimeString(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

/** Duration in seconds between an entry's start (date+start) and end
 *  (endDate+end), correctly spanning midnight or multiple days. Negative if
 *  end is before start — callers must reject that rather than display it. */
function entryDurationSeconds(e: Pick<Entry, "date" | "start" | "endDate" | "end">): number {
  const startTotal = dateToDayIndex(e.date) * 86400 + parseTime(e.start);
  const endTotal = dateToDayIndex(e.endDate) * 86400 + parseTime(e.end);
  return endTotal - startTotal;
}

/** Formats a canonical "HH:MM:SS" time-of-day for display. Seconds are only
 *  shown when non-zero, so entries logged without second-level precision
 *  keep the plain "HH:MM" look. */
function formatTime(timeStr: string): string {
  const [hStr, mStr, sStr] = timeStr.split(":");
  const seconds = Number(sStr ?? 0);
  const secPart = seconds ? `:${pad2(seconds)}` : "";

  if (!settings.hour12) return `${hStr}:${mStr}${secPart}`;

  let h = Number(hStr);
  const suffix = h >= 12 ? "pm" : "am";
  if (h === 0) h = 12;
  else if (h > 12) h -= 12;
  return `${h}:${mStr}${secPart}${suffix}`;
}

/** Splits a duration into a 24h-wrapped clock string plus a whole-days count,
 *  so the live preview can show "05:30:00" with a separate "+1d" badge
 *  instead of one ever-growing hour count. */
function formatPreviewDuration(totalSeconds: number): { time: string; days: number } {
  const days = Math.floor(totalSeconds / 86400);
  const rem = totalSeconds % 86400;
  const h = Math.floor(rem / 3600);
  const m = Math.floor((rem % 3600) / 60);
  const s = rem % 60;
  const time = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return { time, days };
}

/** Renders a formatPreviewDuration() result into the preview element: the
 *  clock time always, plus a "+Nd" badge only when the span crosses a
 *  day boundary. */
function renderDurationPreview(el: HTMLElement, totalSeconds: number): void {
  const { time, days } = formatPreviewDuration(totalSeconds);
  el.innerHTML = `<span class="tt-duration-time">${time}</span>` +
    (days > 0 ? `<span class="tt-duration-days">+${days}d</span>` : "");
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
  if (!date)     { flash("Start date is required.", "error"); return false; }
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

  (document.getElementById("roundNowToggle") as HTMLInputElement).checked = settings.roundNowToMinute;
  document.getElementById("roundNowLabel")!.textContent =
    settings.roundNowToMinute ? "On" : "Off";

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
      roundNowToMinute: settings.roundNowToMinute,
      payPeriod: settings.payPeriod,
      activities: activities,
      projects: projects,
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
      ("quickDelete" in own || "payPeriod" in own || "activities" in own || "projects" in own);

    if (hasOwnFile) {
      if (typeof own.quickDelete === "boolean") settings.quickDelete = own.quickDelete;
      if (typeof own.roundNowToMinute === "boolean") settings.roundNowToMinute = own.roundNowToMinute;
      if (own.payPeriod && typeof own.payPeriod === "object") {
        settings.payPeriod = { ...settings.payPeriod, ...own.payPeriod };
      }
      if (Array.isArray(own.activities)) {
        activities = own.activities.filter(isValidActivity);
      }
      if (Array.isArray(own.projects)) {
        projects = own.projects.filter(isValidProject);
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

function isValidProject(p: unknown): p is Project {
  return (
    p !== null &&
    typeof p === "object" &&
    typeof (p as Project).id === "string" &&
    typeof (p as Project).name === "string" &&
    (p as Project).name.length > 0 &&
    Number.isInteger((p as Project).projectNumber) &&
    ((p as Project).status === "active" || (p as Project).status === "retired")
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
      .filter((e): e is Entry & { endDate?: unknown } =>
        e !== null &&
        typeof e === "object" &&
        typeof e.date     === "string" && e.date.length > 0 &&
        typeof e.start    === "string" &&
        typeof e.end      === "string" &&
        typeof e.activity === "string"
      )
      // notes is a later addition — older saved entries won't have it, so
      // default to "" rather than dropping them.
      // endDate is a later addition too. Pre-migration entries encoded an
      // overnight span by inflating `end` past 24:00 (e.g. "26:00" for
      // 2am next day) — split that back into a real time-of-day plus a
      // rolled-forward endDate so old data reads correctly under the new
      // explicit-date model.
      // start/end are reformatted through parseTime+secondsToTimeString
      // either way, since both migration paths above may carry legacy
      // "HH:MM" (no seconds) values that need a ":00" appended to match
      // the current HH:MM:SS storage format.
      .map((e) => {
        const notes = typeof e.notes === "string" ? e.notes : "";
        // project is a later addition — older saved entries won't have it.
        const project = typeof e.project === "string" ? e.project : "";
        if (typeof e.endDate === "string" && e.endDate) {
          return {
            ...e,
            notes,
            project,
            endDate: e.endDate,
            start: secondsToTimeString(parseTime(e.start)),
            end: secondsToTimeString(parseTime(e.end)),
          } as Entry;
        }
        const endSecs = parseTime(e.end);
        const daysForward = Math.floor(endSecs / 86400);
        const endDate = daysForward > 0 ? addDaysToDate(e.date, daysForward) : e.date;
        const end = secondsToTimeString(endSecs - daysForward * 86400);
        const start = secondsToTimeString(parseTime(e.start));
        return { ...e, notes, project, endDate, start, end } as Entry;
      });
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
  endDatePicker: HTMLInputElement,
  projectInput: HTMLInputElement,
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
        endDate: endDatePicker.value,
        endDateManuallySet,
        project: projectInput.value,
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
  endDatePicker: HTMLInputElement,
  projectInput: HTMLInputElement,
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
    if (draft.endDate)      endDatePicker.value = draft.endDate;
    endDateManuallySet = draft.endDateManuallySet === true;
    if (draft.project)      projectInput.value = draft.project;
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
  startDatePicker: HTMLInputElement,
  endDatePicker: HTMLInputElement,
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
    const startDate = startDatePicker.value || today();
    let endDate = endDateManuallySet ? (endDatePicker.value || startDate) : startDate;
    if (!endDateManuallySet && parseTime(normalizedEnd) < parseTime(normalizedStart)) {
      endDate = addDaysToDate(startDate, 1);
    }
    const diffSeconds = Math.max(0, entryDurationSeconds({ date: startDate, start: normalizedStart, endDate, end: normalizedEnd }));
    renderDurationPreview(durationPreview, diffSeconds);
  } else {
    // Still-running preview: elapsed time from the real Start Date+Time to
    // now, using full date arithmetic (not just a same-day clock diff) so a
    // Start Date in the past correctly shows elapsed days via the "+Nd"
    // badge instead of silently wrapping to a same-day reading.
    function tick() {
      const now = new Date();
      const startDate = startDatePicker.value || today();
      const startTotalSeconds = dateToDayIndex(startDate) * 86400 + parseTime(normalizedStart);
      const nowTotalSeconds =
        dateToDayIndex(localDateString(now)) * 86400 +
        now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
      const diffSeconds = Math.max(0, nowTotalSeconds - startTotalSeconds);
      renderDurationPreview(durationPreview, diffSeconds);
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
  const totalSecs = visible.reduce(
    (sum, e) => sum + entryDurationSeconds(e),
    0,
  );
  const avgPerActivity = Math.round(totalSecs / totalEntries);

  // Group by activity name (case-insensitive), same convention render() and
  // exportCSV() use for the Totals summary.
  const byActivity = new Map<string, { display: string; count: number; secs: number }>();
  visible.forEach((e) => {
    const key = e.activity.toLowerCase();
    const g = byActivity.get(key) ?? { display: e.activity, count: 0, secs: 0 };
    g.count += 1;
    g.secs += entryDurationSeconds(e);
    byActivity.set(key, g);
  });

  let mostEntries = { display: "", count: 0 };
  let highestTime = { display: "", secs: 0 };
  let highestAvg = { display: "", secs: 0 };
  byActivity.forEach((g) => {
    if (g.count > mostEntries.count) mostEntries = { display: g.display, count: g.count };
    if (g.secs > highestTime.secs) highestTime = { display: g.display, secs: g.secs };
    const avg = g.secs / g.count;
    if (avg > highestAvg.secs) highestAvg = { display: g.display, secs: avg };
  });

  // Single entry with the highest duration.
  let longestEntry = visible[0]!;
  let longestSecs = entryDurationSeconds(longestEntry);
  visible.forEach((e) => {
    const secs = entryDurationSeconds(e);
    if (secs > longestSecs) { longestEntry = e; longestSecs = secs; }
  });

  // Earliest start / latest finish, compared by real time-of-day.
  let earliestEntry = visible[0]!;
  let earliestSecs = parseTime(earliestEntry.start);
  let latestEntry = visible[0]!;
  let latestSecs = parseTime(latestEntry.end);
  visible.forEach((e) => {
    const s = parseTime(e.start);
    if (s < earliestSecs) { earliestEntry = e; earliestSecs = s; }
    const e2 = parseTime(e.end);
    if (e2 > latestSecs) { latestEntry = e; latestSecs = e2; }
  });

  // Per-date grouping — "craziest" (most entries) and "busiest" (most time).
  // Grouped by start date, same as the ledger's per-day subheaders.
  const byDate = new Map<string, { count: number; secs: number }>();
  visible.forEach((e) => {
    const g = byDate.get(e.date) ?? { count: 0, secs: 0 };
    g.count += 1;
    g.secs += entryDurationSeconds(e);
    byDate.set(e.date, g);
  });

  let craziestDate = "";
  let craziestCount = 0;
  let busiestDate = "";
  let busiestSecs = 0;
  byDate.forEach((g, date) => {
    if (g.count > craziestCount) { craziestCount = g.count; craziestDate = date; }
    if (g.secs > busiestSecs) { busiestSecs = g.secs; busiestDate = date; }
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
      value: `${formatDuration(avgPerActivity)} per activity`,
    },
    {
      label: "Activity with Most Entries",
      value: `${mostEntries.display} (${mostEntries.count} ${mostEntries.count === 1 ? "entry" : "entries"})`,
    },
    {
      label: "Activity with Highest Time",
      value: `${highestTime.display} (${formatDuration(highestTime.secs)})`,
    },
    {
      label: "Activity with Highest Average Time",
      value: `${highestAvg.display} (${formatDuration(Math.round(highestAvg.secs))})`,
    },
    {
      label: "Entry with Highest Time",
      value: `${longestEntry.activity} on ${formatDate(longestEntry.date)} (${formatDuration(longestSecs)})`,
    },
    {
      label: "Earliest Start",
      value: `${formatTime(secondsToTimeString(earliestSecs))} on ${formatDate(earliestEntry.date)} (${earliestEntry.activity})`,
    },
    {
      label: "Latest Finish",
      value: `${formatTime(secondsToTimeString(latestSecs))} on ${formatDate(latestEntry.date)} (${latestEntry.activity})`,
    },
    {
      label: "Craziest Day",
      value: `${formatDate(craziestDate)} (${craziestCount} ${craziestCount === 1 ? "entry" : "entries"})`,
    },
    {
      label: "Busiest Day",
      value: `${formatDate(busiestDate)} (${formatDuration(busiestSecs)})`,
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
    const secs = entryDurationSeconds(e);
    const key = e.activity.toLowerCase();
    grouped[key] = (grouped[key] || 0) + secs;
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
    .forEach(([key, secs]) => {
      lines.push(`${csvField(groupedDisplay[key])},"${formatDuration(secs)}"`);
      grandTotal += secs;
    });
  lines.push(`"TOTAL","${formatDuration(grandTotal)}"`);
  lines.push("");

  lines.push("STATS");
  lines.push("Stat,Value");
  computeStats(visibleEntries).forEach((s) => {
    lines.push(`${csvField(s.label)},${csvField(s.value)}`);
  });
  lines.push("");

  lines.push("ENTRIES");
  lines.push("Date,Start,End Date,End,Project,Activity,Duration,Notes");
  visibleEntries
    .slice()
    .sort((a, b) => {
      const d = a.date.localeCompare(b.date);
      return d !== 0 ? d : parseTime(a.start) - parseTime(b.start);
    })
    .forEach((e) => {
      const secs = entryDurationSeconds(e);
      lines.push(
        `"${e.date}","${e.start}","${e.endDate}","${e.end}",${csvField(e.project)},${csvField(e.activity)},"${formatDuration(secs)}",${csvField(e.notes)}`,
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

const CSV_IMPORT_REQUIRED_COLUMNS = ["start date", "start time", "end time", "activity"] as const;

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

const MONTH_NAMES = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];
const MONTH_ABBR: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/** Resolves a month name/abbreviation ("March", "mar") to 1-12, or 0 if
 *  unrecognized. */
function monthNameToNumber(raw: string): number {
  const name = raw.toLowerCase();
  const fullIdx = MONTH_NAMES.indexOf(name);
  if (fullIdx >= 0) return fullIdx + 1;
  return MONTH_ABBR[name] ?? 0;
}

/** Builds a canonical "YYYY-MM-DD" string, rejecting anything that isn't a
 *  real calendar date (e.g. month 13, or day 30 in February) — JS's Date
 *  constructor silently rolls those over rather than erroring, so the
 *  round-trip through getFullYear/getMonth/getDate is what actually catches
 *  them. */
function buildDateString(year: number, month: number, day: number): string {
  if (month < 1 || month > 12) return "";
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return "";
  return `${String(year).padStart(4, "0")}-${pad2(month)}-${pad2(day)}`;
}

/** Given two numeric date parts that could each plausibly be a month (1-12)
 *  or a day, picks which is which. Prefers the reading implied by the
 *  Date Format setting (M/D vs D/M) but falls back to whichever reading is
 *  actually valid when the preferred one isn't (e.g. "25/03" under American
 *  ordering still reads as day 25 / month 3, since 25 can't be a month). */
function resolveMonthDay(a: number, b: number): [month: number, day: number] | null {
  const aIsMonth = a >= 1 && a <= 12;
  const bIsMonth = b >= 1 && b <= 12;
  if (settings.americanDates) {
    if (aIsMonth) return [a, b];
    if (bIsMonth) return [b, a];
  } else {
    if (bIsMonth) return [b, a];
    if (aIsMonth) return [a, b];
  }
  return null;
}

/** Parses a CSV date cell in any commonly-seen format — ISO ("2024-03-05"),
 *  numeric with slashes/dashes/dots in either month-first or day-first order
 *  ("3/5/2024", "05.03.2024"), or a month name ("March 5, 2024", "5 Mar
 *  2024") — into a canonical "YYYY-MM-DD" string. Returns "" if the text
 *  isn't a discernible date. Ambiguous numeric dates (both parts ≤12) follow
 *  the Date Format setting's month/day order. */
function normalizeCsvDate(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";

  const isoMatch = trimmed.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (isoMatch) {
    return buildDateString(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]));
  }

  const numericMatch = trimmed.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/);
  if (numericMatch) {
    let year = Number(numericMatch[3]);
    if (year < 100) year += year < 70 ? 2000 : 1900;
    const resolved = resolveMonthDay(Number(numericMatch[1]), Number(numericMatch[2]));
    if (!resolved) return "";
    return buildDateString(year, resolved[0], resolved[1]);
  }

  const monthFirstMatch = trimmed.match(/^([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/);
  if (monthFirstMatch) {
    const month = monthNameToNumber(monthFirstMatch[1]!);
    if (month) return buildDateString(Number(monthFirstMatch[3]), month, Number(monthFirstMatch[2]));
  }

  const dayFirstMatch = trimmed.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\.?,?\s+(\d{4})$/);
  if (dayFirstMatch) {
    const month = monthNameToNumber(dayFirstMatch[2]!);
    if (month) return buildDateString(Number(dayFirstMatch[3]), month, Number(dayFirstMatch[1]));
  }

  // Last resort — hand anything else recognizable (e.g. "2024-03-05T10:00:00")
  // to the native parser rather than rejecting it outright.
  const fallback = new Date(trimmed);
  if (!isNaN(fallback.getTime())) {
    return buildDateString(fallback.getFullYear(), fallback.getMonth() + 1, fallback.getDate());
  }

  return "";
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
  const endDateIdx = colIndex["end date"];
  const projectIdx = colIndex["project"];

  const errors: string[] = [];
  const parsed: Entry[] = [];

  rows.slice(1).forEach((row, i) => {
    const lineNum = i + 2; // +1 for the header row, +1 for 1-indexing
    const dateRaw     = (row[colIndex["start date"]!] ?? "").trim();
    const startRaw    = (row[colIndex["start time"]!] ?? "").trim();
    const endRaw      = (row[colIndex["end time"]!] ?? "").trim();
    const activityRaw = (row[colIndex["activity"]!] ?? "").trim();
    const notesRaw     = notesIdx !== undefined ? (row[notesIdx] ?? "").trim() : "";
    const endDateRaw    = endDateIdx !== undefined ? (row[endDateIdx] ?? "").trim() : "";
    const projectRaw    = projectIdx !== undefined ? (row[projectIdx] ?? "").trim() : "";

    const missing: string[] = [];
    if (!dateRaw) missing.push("Start Date");
    if (!startRaw) missing.push("Start Time");
    if (!endRaw) missing.push("End Time");
    if (!activityRaw) missing.push("Activity");
    if (missing.length > 0) {
      errors.push(`Line ${lineNum}: missing ${missing.join(", ")}.`);
      return;
    }

    const date = normalizeCsvDate(dateRaw);
    if (!date) {
      errors.push(`Line ${lineNum}: Start Date "${dateRaw}" isn't a recognizable date.`);
      return;
    }
    const start = normalizeTime(startRaw);
    const end = normalizeTime(endRaw);
    if (!start) { errors.push(`Line ${lineNum}: Start Time "${startRaw}" isn't a recognizable time.`); return; }
    if (!end)   { errors.push(`Line ${lineNum}: End Time "${endRaw}" isn't a recognizable time.`); return; }

    // End Date is optional — when absent, mirror the manual-entry convenience:
    // same day unless the end time is at/before the start time, in which case
    // it rolls forward one day.
    let endDate: string;
    if (endDateRaw) {
      const parsedEndDate = normalizeCsvDate(endDateRaw);
      if (!parsedEndDate) {
        errors.push(`Line ${lineNum}: End Date "${endDateRaw}" isn't a recognizable date.`);
        return;
      }
      endDate = parsedEndDate;
    } else {
      endDate = parseTime(end) < parseTime(start) ? addDaysToDate(date, 1) : date;
    }

    if (endDate < date) {
      errors.push(`Line ${lineNum}: End Date "${endDate}" is before Start Date "${dateRaw}".`);
      return;
    }
    if (entryDurationSeconds({ date, start, endDate, end }) < 0) {
      errors.push(`Line ${lineNum}: End Time "${endRaw}" is before Start Time "${startRaw}" on the given dates.`);
      return;
    }

    parsed.push({
      date,
      start,
      endDate,
      end,
      activity: activityRaw,
      project: projectRaw,
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
    const now = new Date();
    const timestamp = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
      String(now.getHours()).padStart(2, "0"),
      String(now.getMinutes()).padStart(2, "0"),
      String(now.getSeconds()).padStart(2, "0"),
    ].join("-");
    await invoke("export_csv", {
      filename: `time-tracker-import-template-${timestamp}.csv`,
      data: "Start Date,Start Time,End Date,End Time,Project,Activity,Notes",
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
    const secs = entryDurationSeconds(entry);
    total += secs;
    const key = entry.activity.toLowerCase();
    grouped[key] = (grouped[key] || 0) + secs;
    if (!groupedDisplay[key]) groupedDisplay[key] = entry.activity;
  });

  const byDate: Map<string, Entry[]> = new Map();
  visible.forEach((entry) => {
    if (!byDate.has(entry.date)) byDate.set(entry.date, []);
    byDate.get(entry.date)!.push(entry);
  });

  byDate.forEach((dateEntries, date) => {
    const daySecs = dateEntries.reduce(
      (sum, e) => sum + entryDurationSeconds(e),
      0,
    );

    const subheader = document.createElement("div");
    subheader.className = "entry-date-subheader";
    subheader.textContent = `${formatDate(date)} — ${formatDuration(daySecs)}`;
    entriesDiv.appendChild(subheader);

    dateEntries.forEach((entry) => {
      const entryIndex = entries.indexOf(entry);
      const secs = entryDurationSeconds(entry);

      const row = document.createElement("div");
      row.className = "entry-row";

      const projectSpan = document.createElement("span");
      projectSpan.className = "entry-field entry-col-project";
      projectSpan.textContent = entry.project;
      projectSpan.title = "Double-click to edit";
      projectSpan.addEventListener("dblclick", () =>
        makeEditable(projectSpan, entry, "project", entriesDiv, dayTotalDiv, groupTotalsDiv, statsDiv),
      );
      row.appendChild(projectSpan);

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
      const dayDiff = daysBetween(entry.date, entry.endDate);
      endSpan.className = dayDiff > 0
        ? "entry-field entry-col-time entry-col-time--spans"
        : "entry-field entry-col-time";
      endSpan.textContent = dayDiff > 0 ? `${formatTime(entry.end)} (+${dayDiff}d)` : formatTime(entry.end);
      endSpan.title = dayDiff > 0
        ? `Ends ${formatDate(entry.endDate)} — double-click to edit the time, use the calendar icon to edit dates`
        : "Double-click to edit";
      endSpan.addEventListener("dblclick", () =>
        makeEditable(endSpan, entry, "end", entriesDiv, dayTotalDiv, groupTotalsDiv, statsDiv),
      );
      row.appendChild(endSpan);

      const durSpan = document.createElement("span");
      durSpan.className = "entry-col-duration";
      durSpan.textContent = formatDuration(secs);
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
      calBtn.title = "Edit dates";
      calBtn.addEventListener("click", () =>
        openDateEditModal(entry, () => render(entriesDiv, dayTotalDiv, groupTotalsDiv, statsDiv)),
      );
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

  dayTotalDiv.textContent = `Total: ${formatDuration(total)}`;

  Object.entries(grouped)
    .sort(([a], [b]) => a.localeCompare(b))
    .forEach(([key, secs]) => {
      const d = document.createElement("div");
      d.textContent = `${groupedDisplay[key]}: ${formatDuration(secs)}`;
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
  // For start/end, edit the raw formatted time rather than the row's display
  // text — the end column may carry a "(+1d)" suffix that normalizeTime
  // can't parse.
  const original =
    field === "start" || field === "end" ? formatTime(entry[field]) : (span.textContent || "");

  const input = document.createElement("input");
  input.className = "entry-edit-input";
  input.value = original;
  input.style.width = span.offsetWidth + "px";
  if (field === "start" || field === "end") restrictToTimeChars(input);
  span.replaceWith(input);
  input.focus();
  input.select();

  let handledByKeydown = false;

  function commit() {
    const raw = input.value.trim();
    // Project is optional — clearing it to empty is a valid edit (removes
    // the entry from any project), unlike the other inline-editable fields
    // where empty means "discard this edit".
    if (!raw && field !== "project") { cancel(); return; }

    if (field === "start" || field === "end") {
      const normalized = normalizeTime(raw);
      if (!normalized) { cancel(); return; }
      const prevValue = entry[field];
      entry[field] = normalized;

      // No auto-roll here, unlike Add Entry — this is editing an EXISTING
      // entry's dates are already fixed, so a start/end time edit that would
      // make the span negative is simply rejected. If the entry is already
      // multi-day (date !== endDate), entryDurationSeconds() correctly
      // accounts for that and won't reject a same-day-looking time-of-day
      // comparison that's actually fine across the date boundary.
      if (entryDurationSeconds(entry) < 0) {
        entry[field] = prevValue;
        flash("End time can't be before start time — use the calendar icon to edit dates if this should span multiple days.", "error");
        render(entriesDiv, dayTotalDiv, groupTotalsDiv, statsDiv);
        return;
      }
    } else {
      entry[field] = raw;
      // Inline-editing the activity/project name should register it for
      // autocomplete too, same as adding a fresh entry. Project is optional,
      // so an empty value is skipped rather than creating a nameless project.
      if (field === "activity") findOrCreateActivity(raw);
      if (field === "project" && raw) findOrCreateProject(raw);
    }

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
  project: string,
  activity: string,
  notes: string,
  endDateInputValue: string,
  datePicker: HTMLInputElement,
  endDatePicker: HTMLInputElement,
  projectInput: HTMLInputElement,
  activityInput: HTMLInputElement,
  startInput: HTMLInputElement,
  endInput: HTMLInputElement,
  notesInput: HTMLTextAreaElement,
  entriesDiv: HTMLElement,
  dayTotalDiv: HTMLElement,
  groupTotalsDiv: HTMLElement,
  statsDiv: HTMLElement,
  durationPreview: HTMLElement,
): Promise<boolean> {
  const startDate = selectedDate;

  // Same-day auto-roll (see endDateManuallySet doc comment): a same-day
  // end-strictly-before-start reading rolls End Date forward a day, unless
  // the user has directly set End Date themselves. Equal start/end is a
  // legitimate zero-duration entry, not an overnight span.
  let endDate = endDateManuallySet ? (endDateInputValue || startDate) : startDate;
  if (!endDateManuallySet && parseTime(end) < parseTime(start)) {
    endDate = addDaysToDate(startDate, 1);
  }

  if (endDate < startDate) {
    flash("End date cannot be before Start date.", "error");
    return false;
  }
  if (entryDurationSeconds({ date: startDate, start, endDate, end }) < 0) {
    flash("End time must be after Start time — check the dates.", "error");
    return false;
  }

  entries.push({ date: startDate, start, endDate, end, activity, project, notes });

  sortEntries();
  lastActivity = activity;
  // Remember this activity/project name for autocomplete — silent quick-add,
  // mirrors Budget calling findOrCreateExpenseSource on entry commit. Project
  // is optional, so an empty value is skipped rather than creating a
  // nameless project.
  findOrCreateActivity(activity);
  if (project) findOrCreateProject(project);

  render(entriesDiv, dayTotalDiv, groupTotalsDiv, statsDiv);
  await saveToDisk();
  flash("Entry added", "success");

  projectInput.value = "";
  activityInput.value = "";
  startInput.value = "";
  endInput.value = "";
  notesInput.value = "";
  endDateManuallySet = false;
  endDatePicker.value = datePicker.value;
  saveDraft(datePicker, endDatePicker, projectInput, activityInput, startInput, endInput, notesInput);
  updateDurationPreview(startInput, endInput, durationPreview, datePicker, endDatePicker);
  return true;
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
 * matching retired activity instead of creating a duplicate; blocks (and
 * flashes) if the name matches an already-ACTIVE activity, since two active
 * activities can't share a name. Returns false on that failure so the modal
 * can stay open. Mirrors Budget's addOrReactivateSimple.
 */
function addOrReactivateActivity(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;

  const existing = activities.find(
    (a) => a.name.toLowerCase() === trimmed.toLowerCase(),
  );
  if (existing && existing.status === "active") {
    flash("Activity already exists", "error");
    return false;
  }
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
  return true;
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

/** Number of entries currently using a given activity/project name
 *  (case-insensitive) — the "N entries" count shown in Setup list rows, the
 *  Edit modal's context line, and the delete/merge confirmations. */
function entryCountFor(kind: "activity" | "project", name: string): number {
  return kind === "activity"
    ? entries.filter((e) => e.activity.toLowerCase() === name.toLowerCase()).length
    : entries.filter((e) => e.project.toLowerCase() === name.toLowerCase()).length;
}

function entryCountLabel(count: number): string {
  return `${count} ${count === 1 ? "entry" : "entries"}`;
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

  const countSpan = document.createElement("span");
  countSpan.className = "setup-item-count";
  countSpan.textContent = entryCountLabel(entryCountFor("activity", item.name));
  row.appendChild(countSpan);

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
   PROJECTS — SETUP LIST + AUTOCOMPLETE SOURCE
   -----------------------------------------------------------------------------
   Mirrors the Activities list above, plus a user-assigned integer ID
   (projectNumber) that must stay unique across all projects. Entries keep
   storing `project` as free text (like `activity`); Project is optional
   grouping, so unlike Activity an empty Project field is valid.
============================================================================= */

/** Smallest integer not currently in use as a projectNumber. Used only for
 *  the quick-add path (typing a new name directly in the Input panel) —
 *  the Setup "+ New Project" form lets the user pick the number explicitly. */
function nextProjectNumber(): number {
  return projects.reduce((max, p) => Math.max(max, p.projectNumber), 0) + 1;
}

/**
 * Silent quick-add used from the main entry form (typed Project text).
 * Matches an existing ACTIVE project case-insensitively and does nothing if
 * found; otherwise creates a new active one with the next free ID number.
 * Mirrors findOrCreateActivity — no toast, no reactivation of retired items.
 */
function findOrCreateProject(name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  const existing = projects.find(
    (p) => p.status === "active" && p.name.toLowerCase() === trimmed.toLowerCase(),
  );
  if (existing) return;
  projects.push({ id: makeId(), projectNumber: nextProjectNumber(), name: trimmed, status: "active" });
  saveSettings();
  refreshProjectDatalist();
  renderProjectsList();
}

/**
 * Explicit add from the Setup modal's "+ New Project" button, with a
 * user-chosen ID number. Reactivating a matching retired project (by name)
 * keeps its existing number rather than adopting the typed one, mirroring
 * addOrReactivateActivity's name-match convenience. Blocks (and flashes) if
 * the name matches an already-ACTIVE project, since two active projects
 * can't share a name. Returns false (and flashes the reason) on validation
 * failure, so the modal can stay open.
 */
function addOrReactivateProject(name: string, projectNumber: number): boolean {
  const trimmed = name.trim();
  if (!trimmed) { flash("Name cannot be empty", "error"); return false; }

  const existingByName = projects.find((p) => p.name.toLowerCase() === trimmed.toLowerCase());
  if (existingByName) {
    if (existingByName.status === "active") {
      flash("Project already exists", "error");
      return false;
    }
    existingByName.status = "active";
    flash("Project reactivated", "success");
    saveSettings();
    refreshProjectDatalist();
    renderProjectsList();
    return true;
  }

  if (!Number.isInteger(projectNumber)) { flash("ID Number must be a whole number.", "error"); return false; }
  if (projects.some((p) => p.projectNumber === projectNumber)) {
    flash(`ID Number ${projectNumber} is already in use.`, "error");
    return false;
  }

  projects.push({ id: makeId(), projectNumber, name: trimmed, status: "active" });
  flash("Project added", "success");
  saveSettings();
  refreshProjectDatalist();
  renderProjectsList();
  return true;
}

/**
 * Save handler for the Edit Project modal: renames, renumbers, and — like
 * activity rename — rewrites every matching entry's `project` text so
 * history stays in sync. Returns false (and flashes the reason) on
 * validation failure, so the modal can stay open.
 */
function saveProjectEdit(item: Project, name: string, projectNumber: number): boolean {
  const trimmed = name.trim();
  if (!trimmed) { flash("Name cannot be empty", "error"); return false; }
  if (!Number.isInteger(projectNumber)) { flash("ID Number must be a whole number.", "error"); return false; }
  if (projects.some((p) => p.id !== item.id && p.projectNumber === projectNumber)) {
    flash(`ID Number ${projectNumber} is already in use.`, "error");
    return false;
  }

  const oldName = item.name;
  item.name = trimmed;
  item.projectNumber = projectNumber;
  if (oldName.toLowerCase() !== trimmed.toLowerCase()) {
    let changed = 0;
    entries.forEach((e) => {
      if (e.project.toLowerCase() === oldName.toLowerCase()) {
        e.project = trimmed;
        changed++;
      }
    });
    if (changed > 0) saveToDisk();
  }
  saveSettings();
  refreshProjectDatalist();
  renderCurrentView();
  flash("Project saved", "success");
  return true;
}

/** Repopulates the Project field's <datalist> from active projects. */
function refreshProjectDatalist(): void {
  const datalist = document.getElementById("ttProjectList") as HTMLDataListElement | null;
  if (!datalist) return;
  datalist.innerHTML = "";
  projects
    .filter((p) => p.status === "active")
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((p) => {
      const opt = document.createElement("option");
      opt.value = p.name;
      datalist.appendChild(opt);
    });
}

function buildProjectRow(item: Project): HTMLElement {
  const row = document.createElement("div");
  row.className = "setup-item";
  if (item.status === "retired") row.classList.add("setup-item-retired");

  const nameSpan = document.createElement("span");
  nameSpan.className = "setup-item-name";
  nameSpan.textContent = `#${item.projectNumber} — ${item.name}`;
  if (item.status === "retired") {
    const retiredBadge = document.createElement("span");
    retiredBadge.className = "setup-item-retired-badge";
    retiredBadge.textContent = "Retired";
    retiredBadge.style.marginLeft = "8px";
    nameSpan.appendChild(retiredBadge);
  }
  row.appendChild(nameSpan);

  const countSpan = document.createElement("span");
  countSpan.className = "setup-item-count";
  countSpan.textContent = entryCountLabel(entryCountFor("project", item.name));
  row.appendChild(countSpan);

  const chevron = document.createElement("span");
  chevron.className = "setup-item-chevron";
  chevron.textContent = "›";
  row.appendChild(chevron);

  row.style.cursor = "pointer";
  row.addEventListener("click", () => openProjectEdit(item));
  return row;
}

function renderProjectsList(): void {
  const container = document.getElementById("ttProjectsList");
  if (!container) return;
  container.innerHTML = "";

  if (projects.length === 0) {
    const p = document.createElement("p");
    p.className = "placeholder-text";
    p.textContent = "No projects yet — add one above.";
    container.appendChild(p);
    return;
  }

  [...projects]
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === "active" ? -1 : 1;
      return a.projectNumber - b.projectNumber;
    })
    .forEach((item) => container.appendChild(buildProjectRow(item)));
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
        renderProjectsList();
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
      if (!addOrReactivateActivity(name)) return;
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
      const item = ttActivityEditItem;
      const name = nameInput.value.trim();
      if (!name) { flash("Name cannot be empty", "error"); return; }
      const oldName = item.name;

      // Renaming onto another activity's name would leave two activities
      // sharing one name — offer a merge instead of allowing the collision.
      if (name.toLowerCase() !== oldName.toLowerCase()) {
        const collision = activities.find(
          (a) => a.id !== item.id && a.name.toLowerCase() === name.toLowerCase(),
        );
        if (collision) {
          ttActivityEditModal!.close();
          openTTMergeConfirm("activity", item, collision);
          return;
        }
      }

      item.name = name;
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
      openTTSetupDelete("activity", item.id, item.name);
    });
  }
  return ttActivityEditModal;
}

function openActivityEdit(item: Activity): void {
  ttActivityEditItem = item;
  getTTSetupModal().close();
  getActivityEditModal(); // ensure wired
  (document.getElementById("ttActivityEditName") as HTMLInputElement).value = item.name;
  setContextLines(document.getElementById("ttActivityEditContext")!, [
    entryCountLabel(entryCountFor("activity", item.name)),
  ]);
  const retireBtn = document.getElementById("ttActivityEditRetire") as HTMLButtonElement;
  const deleteBtn = document.getElementById("ttActivityEditDelete") as HTMLButtonElement;
  retireBtn.textContent = item.status === "active" ? "Retire" : "Reactivate";
  deleteBtn.style.display = item.status === "retired" ? "" : "none";
  getActivityEditModal().open();
}

/* =============================================================================
   MODAL — PROJECT ADD / EDIT (mirrors the Activity Add/Edit modals, plus a
   required, unique integer ID Number field)
============================================================================= */

let ttProjectAddModal: Modal | null = null;
let ttProjectEditModal: Modal | null = null;
let ttProjectEditItem: Project | null = null;

function getProjectAddModal(): Modal {
  if (!ttProjectAddModal) {
    const nameInput = document.getElementById("ttProjectAddName") as HTMLInputElement;
    const numberInput = document.getElementById("ttProjectAddNumber") as HTMLInputElement;

    ttProjectAddModal = new Modal(document.getElementById("ttProjectAddBackdrop")!, {
      closeOnEsc: true,
      onOpen: () => setTimeout(() => nameInput.focus(), 50),
    });

    function goBack() { ttProjectAddModal!.close(); openTTSetupOnTab("projects"); }
    function doSave() {
      const name = nameInput.value.trim();
      const projectNumber = parseInt(numberInput.value, 10);
      if (!addOrReactivateProject(name, projectNumber)) return;
      ttProjectAddModal!.close();
      openTTSetupOnTab("projects");
    }

    document.getElementById("ttProjectAddBack")!.addEventListener("click", goBack);
    document.getElementById("ttProjectAddClose")!.addEventListener("click", () => ttProjectAddModal!.close());
    document.getElementById("ttProjectAddCancel")!.addEventListener("click", goBack);
    document.getElementById("ttProjectAddSave")!.addEventListener("click", doSave);
    [nameInput, numberInput].forEach((input) => {
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doSave(); } });
    });
  }
  return ttProjectAddModal;
}

function openProjectAdd(): void {
  getTTSetupModal().close();
  (document.getElementById("ttProjectAddName") as HTMLInputElement).value = "";
  (document.getElementById("ttProjectAddNumber") as HTMLInputElement).value = String(nextProjectNumber());
  getProjectAddModal().open();
}

function getProjectEditModal(): Modal {
  if (!ttProjectEditModal) {
    const nameInput = document.getElementById("ttProjectEditName") as HTMLInputElement;
    const numberInput = document.getElementById("ttProjectEditNumber") as HTMLInputElement;
    const retireBtn = document.getElementById("ttProjectEditRetire") as HTMLButtonElement;
    const deleteBtn = document.getElementById("ttProjectEditDelete") as HTMLButtonElement;

    ttProjectEditModal = new Modal(document.getElementById("ttProjectEditBackdrop")!, {
      closeOnEsc: true,
      onOpen: () => setTimeout(() => nameInput.focus(), 50),
      onClosed: () => { ttProjectEditItem = null; },
    });

    function goBack() { ttProjectEditModal!.close(); openTTSetupOnTab("projects"); }
    function doSave() {
      if (!ttProjectEditItem) return;
      const item = ttProjectEditItem;
      const name = nameInput.value.trim();
      if (!name) { flash("Name cannot be empty", "error"); return; }

      // Renaming onto another project's name would leave two projects sharing
      // one name — offer a merge instead of allowing the collision.
      if (name.toLowerCase() !== item.name.toLowerCase()) {
        const collision = projects.find(
          (p) => p.id !== item.id && p.name.toLowerCase() === name.toLowerCase(),
        );
        if (collision) {
          ttProjectEditModal!.close();
          openTTMergeConfirm("project", item, collision);
          return;
        }
      }

      const projectNumber = parseInt(numberInput.value, 10);
      if (!saveProjectEdit(item, name, projectNumber)) return;
      goBack();
    }

    document.getElementById("ttProjectEditBack")!.addEventListener("click", goBack);
    document.getElementById("ttProjectEditClose")!.addEventListener("click", () => ttProjectEditModal!.close());
    document.getElementById("ttProjectEditCancel")!.addEventListener("click", goBack);
    document.getElementById("ttProjectEditSave")!.addEventListener("click", doSave);
    [nameInput, numberInput].forEach((input) => {
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doSave(); } });
    });

    retireBtn.addEventListener("click", () => {
      if (!ttProjectEditItem) return;
      ttProjectEditItem.status = ttProjectEditItem.status === "active" ? "retired" : "active";
      saveSettings();
      refreshProjectDatalist();
      flash(ttProjectEditItem.status === "retired" ? "Project retired" : "Project reactivated", "success");
      goBack();
    });

    deleteBtn.addEventListener("click", () => {
      if (!ttProjectEditItem) return;
      const item = ttProjectEditItem;
      ttProjectEditModal!.close();
      openTTSetupDelete("project", item.id, item.name);
    });
  }
  return ttProjectEditModal;
}

function openProjectEdit(item: Project): void {
  ttProjectEditItem = item;
  getTTSetupModal().close();
  getProjectEditModal(); // ensure wired
  (document.getElementById("ttProjectEditName") as HTMLInputElement).value = item.name;
  (document.getElementById("ttProjectEditNumber") as HTMLInputElement).value = String(item.projectNumber);
  setContextLines(document.getElementById("ttProjectEditContext")!, [
    entryCountLabel(entryCountFor("project", item.name)),
  ]);
  const retireBtn = document.getElementById("ttProjectEditRetire") as HTMLButtonElement;
  const deleteBtn = document.getElementById("ttProjectEditDelete") as HTMLButtonElement;
  retireBtn.textContent = item.status === "active" ? "Retire" : "Reactivate";
  deleteBtn.style.display = item.status === "retired" ? "" : "none";
  getProjectEditModal().open();
}

/* =============================================================================
   MODAL — TT SETUP DELETE CONFIRM
   Shared by Activities and Projects — only reachable for an already-retired
   item (Delete is hidden until an item is retired — mirrors Budget's setup
   delete flow).
============================================================================= */

type TTDeleteKind = "activity" | "project";
let ttSetupDeleteModal: Modal | null = null;
let pendingSetupDelete: { kind: TTDeleteKind; id: string; name: string } | null = null;

function getTTSetupDeleteModal(): Modal {
  if (!ttSetupDeleteModal) {
    ttSetupDeleteModal = new Modal(document.getElementById("ttSetupDeleteBackdrop")!, {
      closeOnEsc: true,
      onClosed: () => { pendingSetupDelete = null; },
    });

    document.getElementById("ttSetupDeleteConfirmBtn")!.addEventListener("click", () => {
      if (!pendingSetupDelete) return;
      const { kind, id, name } = pendingSetupDelete;
      // Entries store the name, not an id — so orphaned entries would keep a
      // name that no longer exists in the list. Reassign them to "Unknown"
      // (the delete confirm already warned how many are affected). This is
      // why Retire exists: it preserves the name on history without deletion.
      let changed = 0;
      if (kind === "activity") {
        activities = activities.filter((a) => a.id !== id);
        entries.forEach((e) => {
          if (e.activity.toLowerCase() === name.toLowerCase()) { e.activity = "Unknown"; changed++; }
        });
      } else {
        projects = projects.filter((p) => p.id !== id);
        entries.forEach((e) => {
          if (e.project.toLowerCase() === name.toLowerCase()) { e.project = "Unknown"; changed++; }
        });
      }
      pendingSetupDelete = null;
      if (changed > 0) { saveToDisk(); renderCurrentView(); }
      saveSettings();
      if (kind === "activity") refreshActivityDatalist(); else refreshProjectDatalist();
      ttSetupDeleteModal!.close();
      openTTSetupOnTab(kind === "activity" ? "activities" : "projects");
      flash(kind === "activity" ? "Activity deleted" : "Project deleted", "success");
    });

    document.getElementById("ttSetupDeleteCancelBtn")!.addEventListener("click", () => {
      const kind = pendingSetupDelete?.kind;
      pendingSetupDelete = null;
      ttSetupDeleteModal!.close();
      openTTSetupOnTab(kind === "project" ? "projects" : "activities");
    });
  }
  return ttSetupDeleteModal;
}

function openTTSetupDelete(kind: TTDeleteKind, id: string, name: string): void {
  pendingSetupDelete = { kind, id, name };
  const impactCount = entryCountFor(kind, name);
  const impactNote = impactCount > 0
    ? ` ${impactCount} logged ${impactCount === 1 ? "entry" : "entries"} will be reassigned to "Unknown".`
    : "";
  document.getElementById("ttSetupDeleteMessage")!.textContent =
    `Permanently delete "${name}"?${impactNote} This can't be undone.`;
  getTTSetupDeleteModal().open();
}

/* =============================================================================
   MODAL — TT SETUP MERGE CONFIRM (shared by Activities and Projects)
   Reached when an Edit rename collides with another activity/project's name
   (case-insensitively) — since two active entities can't share a name, the
   only way forward is to merge the one being edited (`source`) into the
   existing one (`target`): source's entries are reassigned to target's name
   and source itself is deleted. target keeps its own name/casing and (for
   Project) its ID number; the typed name on `source` is discarded.
============================================================================= */

type TTMergeKind = "activity" | "project";
let ttMergeConfirmModal: Modal | null = null;
let pendingMerge: { kind: TTMergeKind; sourceId: string; targetId: string } | null = null;

function getTTMergeConfirmModal(): Modal {
  if (!ttMergeConfirmModal) {
    ttMergeConfirmModal = new Modal(document.getElementById("ttMergeConfirmBackdrop")!, {
      closeOnEsc: true,
      onClosed: () => { pendingMerge = null; },
    });

    document.getElementById("ttMergeConfirmBtn")!.addEventListener("click", () => {
      if (!pendingMerge) return;
      const { kind, sourceId, targetId } = pendingMerge;
      let changed = 0;
      if (kind === "activity") {
        const source = activities.find((a) => a.id === sourceId);
        const target = activities.find((a) => a.id === targetId);
        if (source && target) {
          entries.forEach((e) => {
            if (e.activity.toLowerCase() === source.name.toLowerCase()) { e.activity = target.name; changed++; }
          });
          activities = activities.filter((a) => a.id !== sourceId);
          target.status = "active";
        }
      } else {
        const source = projects.find((p) => p.id === sourceId);
        const target = projects.find((p) => p.id === targetId);
        if (source && target) {
          entries.forEach((e) => {
            if (e.project.toLowerCase() === source.name.toLowerCase()) { e.project = target.name; changed++; }
          });
          projects = projects.filter((p) => p.id !== sourceId);
          target.status = "active";
        }
      }
      pendingMerge = null;
      if (changed > 0) { saveToDisk(); renderCurrentView(); }
      saveSettings();
      if (kind === "activity") { refreshActivityDatalist(); renderActivitiesList(); }
      else { refreshProjectDatalist(); renderProjectsList(); }
      ttMergeConfirmModal!.close();
      openTTSetupOnTab(kind === "activity" ? "activities" : "projects");
      flash(kind === "activity" ? "Activities merged" : "Projects merged", "success");
    });

    document.getElementById("ttMergeConfirmCancelBtn")!.addEventListener("click", () => {
      const kind = pendingMerge?.kind;
      pendingMerge = null;
      ttMergeConfirmModal!.close();
      openTTSetupOnTab(kind === "project" ? "projects" : "activities");
    });
  }
  return ttMergeConfirmModal;
}

function openTTMergeConfirm(kind: TTMergeKind, source: Activity | Project, target: Activity | Project): void {
  pendingMerge = { kind, sourceId: source.id, targetId: target.id };
  const noun = kind === "activity" ? "activity" : "project";
  const sourceCount = entryCountFor(kind, source.name);
  const targetCount = entryCountFor(kind, target.name);

  document.getElementById("ttMergeConfirmTitle")!.textContent =
    `Merge ${kind === "activity" ? "Activities" : "Projects"}?`;
  document.getElementById("ttMergeConfirmMessage")!.textContent =
    `An ${noun} named "${target.name}" already exists, with ${entryCountLabel(targetCount)}. ` +
    `Merge "${source.name}" (${entryCountLabel(sourceCount)}) into it? ` +
    `This deletes "${source.name}" and moves its entries to "${target.name}". This can't be undone.`;
  getTTMergeConfirmModal().open();
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
    if (e.project) findOrCreateProject(e.project);
  });
  sortEntries();
  await saveToDisk();
  refreshActivityDatalist();
  refreshProjectDatalist();
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

/** Fills a modal's context block with one line per string — built via
 *  createElement/textContent (not innerHTML) since these lines carry
 *  free-text user data (project/activity names) that must never be parsed
 *  as HTML. */
function setContextLines(container: HTMLElement, lines: string[]): void {
  container.innerHTML = "";
  lines.forEach((text) => {
    const line = document.createElement("div");
    line.className = "tt-context-line";
    line.textContent = text;
    container.appendChild(line);
  });
}

function openNotesEditModal(entry: Entry, rerender: () => void): void {
  notesEditEntry = entry;
  notesEditRerender = rerender;
  (document.getElementById("ttNotesEditTextarea") as HTMLTextAreaElement).value = entry.notes;
  setContextLines(document.getElementById("ttNotesEditContext")!, [
    `${entry.project || "—"} · ${entry.activity}`,
    `${formatDate(entry.date)} ${formatTime(entry.start)} → ${formatDate(entry.endDate)} ${formatTime(entry.end)}`,
  ]);
  getNotesEditModal().open();
}

/* =============================================================================
   MODAL — EDIT DATES
   Launched from each row's calendar icon. Lets Start Date and End Date be
   edited independently — End Date must be on or after Start Date, and the
   resulting span must still be a positive duration given the entry's times.
============================================================================= */

let dateEditModal: Modal | null = null;
let dateEditEntry: Entry | null = null;
let dateEditRerender: () => void = () => {};
// Staged Start/End Time, initialized from the entry when the modal opens and
// only written back to the entry on Update — see makeDateEditTimeEditable's
// doc comment for why these can't just write straight to dateEditEntry.
let dateEditStagedStart = "";
let dateEditStagedEnd = "";

/** Double-click-to-edit for the Start/End Time values shown (read-only,
 *  until now) in the Edit Dates modal. It's a bit silly to show them next to
 *  editable dates and not let you fix them too — especially since a date
 *  change can put them in conflict. Mirrors the Entries panel's inline time
 *  edit's normalizeTime() parsing, but does NOT validate or save immediately
 *  the way that inline edit does: this modal's date fields are themselves
 *  only staged until Update, so checking the edited time against the
 *  entry's still-unstaged dates would reject perfectly valid combinations
 *  (e.g. changing 8am-12pm on 8/6 to 8am-7am spanning 8/6-8/7 — typing the
 *  new 7am end time fails immediately against the old same-day End Date,
 *  even though the pending End Date edit would make it valid). So a typed
 *  time is only parsed here and held in dateEditStaged{Start,End}; the real
 *  entryDurationSeconds() check runs once, against everything staged
 *  together, in doSave(). */
function makeDateEditTimeEditable(span: HTMLElement, field: "start" | "end"): void {
  if (!dateEditEntry) return;
  const spanId = span.id;

  const input = document.createElement("input");
  input.className = "entry-edit-input";
  input.value = formatTime(field === "start" ? dateEditStagedStart : dateEditStagedEnd);
  input.style.width = span.offsetWidth + "px";
  restrictToTimeChars(input);
  span.replaceWith(input);
  input.focus();
  input.select();

  let handledByKeydown = false;

  function rebuildSpan(): void {
    const fresh = document.createElement("span");
    fresh.id = spanId;
    fresh.className = "tt-date-edit-time-value";
    fresh.title = "Double-click to edit";
    fresh.textContent = formatTime(field === "start" ? dateEditStagedStart : dateEditStagedEnd);
    fresh.addEventListener("dblclick", () => makeDateEditTimeEditable(fresh, field));
    input.replaceWith(fresh);
  }

  function commit(): void {
    const raw = input.value.trim();
    if (!raw) { rebuildSpan(); return; }
    const normalized = normalizeTime(raw);
    if (!normalized) { rebuildSpan(); return; }

    if (field === "start") dateEditStagedStart = normalized;
    else dateEditStagedEnd = normalized;
    rebuildSpan();
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      handledByKeydown = true;
      commit();
    } else if (e.key === "Escape") {
      handledByKeydown = true;
      rebuildSpan();
    }
  });

  input.addEventListener("blur", () => {
    if (handledByKeydown) return;
    commit();
  });
}

function getDateEditModal(): Modal {
  if (!dateEditModal) {
    const startInput = document.getElementById("ttDateEditStart") as HTMLInputElement;
    const endInput = document.getElementById("ttDateEditEnd") as HTMLInputElement;
    const startTimeSpan = document.getElementById("ttDateEditStartTime")!;
    const endTimeSpan = document.getElementById("ttDateEditEndTime")!;

    dateEditModal = new Modal(document.getElementById("ttDateEditBackdrop")!, {
      closeOnEsc: true,
      onOpen: () => setTimeout(() => startInput.focus(), 50),
      onClosed: () => { dateEditEntry = null; },
    });

    startTimeSpan.addEventListener("dblclick", () => makeDateEditTimeEditable(startTimeSpan, "start"));
    endTimeSpan.addEventListener("dblclick", () => makeDateEditTimeEditable(endTimeSpan, "end"));

    // Keep the native picker's own min constraint in sync as Start Date
    // changes, in addition to the explicit validation in doSave.
    startInput.addEventListener("change", () => {
      endInput.min = startInput.value;
      if (startInput.value && endInput.value < startInput.value) {
        endInput.value = startInput.value;
      }
    });

    function doSave() {
      if (!dateEditEntry) return;
      const newStart = startInput.value;
      const newEnd = endInput.value;
      if (!newStart || !newEnd) { flash("Both dates are required.", "error"); return; }
      if (newEnd < newStart) { flash("End date cannot be before Start date.", "error"); return; }
      if (entryDurationSeconds({ date: newStart, start: dateEditStagedStart, endDate: newEnd, end: dateEditStagedEnd }) < 0) {
        flash("End time must be after Start time — check the dates.", "error");
        return;
      }
      dateEditEntry.date = newStart;
      dateEditEntry.endDate = newEnd;
      dateEditEntry.start = dateEditStagedStart;
      dateEditEntry.end = dateEditStagedEnd;
      sortEntries();
      saveToDisk();
      dateEditRerender();
      flash("Dates updated", "success");
      dateEditModal!.close();
    }

    document.getElementById("ttDateEditClose")!.addEventListener("click", () => dateEditModal!.close());
    document.getElementById("ttDateEditCancel")!.addEventListener("click", () => dateEditModal!.close());
    document.getElementById("ttDateEditSave")!.addEventListener("click", doSave);
  }
  return dateEditModal;
}

function openDateEditModal(entry: Entry, rerender: () => void): void {
  dateEditEntry = entry;
  dateEditRerender = rerender;
  dateEditStagedStart = entry.start;
  dateEditStagedEnd = entry.end;
  const startInput = document.getElementById("ttDateEditStart") as HTMLInputElement;
  const endInput = document.getElementById("ttDateEditEnd") as HTMLInputElement;
  startInput.value = entry.date;
  endInput.min = entry.date;
  endInput.value = entry.endDate;
  document.getElementById("ttDateEditStartTime")!.textContent = formatTime(entry.start);
  document.getElementById("ttDateEditEndTime")!.textContent = formatTime(entry.end);
  setContextLines(document.getElementById("ttDateEditContext")!, [
    `${entry.project || "—"} · ${entry.activity}`,
  ]);
  getDateEditModal().open();
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
  const projectInput    = document.getElementById("project") as HTMLInputElement;
  const activityInput   = document.getElementById("activity") as HTMLInputElement;
  const notesInput      = document.getElementById("notesInput") as HTMLTextAreaElement;
  const datePicker      = document.getElementById("startDatePicker") as HTMLInputElement;
  const endDatePicker   = document.getElementById("endDatePicker") as HTMLInputElement;
  const viewStartInput  = document.getElementById("viewStart") as HTMLInputElement;
  const viewEndInput    = document.getElementById("viewEnd") as HTMLInputElement;
  const entriesDiv      = document.getElementById("entries")!;
  const dayTotalDiv     = document.getElementById("dayTotal")!;
  const groupTotalsDiv  = document.getElementById("groupTotals")!;
  const statsDiv        = document.getElementById("statsPanel")!;
  const durationPreview = document.getElementById("durationPreview")!;

  // Block keystrokes that could never be part of a valid time — letters
  // other than a/p/m, symbols, etc. Doesn't validate the VALUE typed, just
  // the characters (see normalizeTime() for the actual range validation).
  restrictToTimeChars(startInput);
  restrictToTimeChars(endInput);

  // Convenience wrappers so inner functions don't have to pass DOM refs everywhere
  function doRender() {
    render(entriesDiv, dayTotalDiv, groupTotalsDiv, statsDiv);
  }
  function doSaveDraft() {
    saveDraft(datePicker, endDatePicker, projectInput, activityInput, startInput, endInput, notesInput);
  }
  function doUpdateDurationPreview() {
    updateDurationPreview(startInput, endInput, durationPreview, datePicker, endDatePicker);
  }
  function doApplyPreset(preset: string) {
    applyPreset(preset, viewStartInput, viewEndInput, entriesDiv, dayTotalDiv, groupTotalsDiv, statsDiv);
  }
  // Keeps the visible End Date field in sync with the same overnight-roll
  // convenience Add Entry applies (see endDateManuallySet doc comment), so
  // the form shows the date the entry will actually get before you submit.
  // No-ops once End Date has been touched directly. Called whenever Start
  // Date changes and whenever the user leaves a time field (see the blur
  // listeners below) — the same moments the draft gets saved.
  function syncEndDateFromTimes() {
    if (endDateManuallySet) return;
    const startDate = datePicker.value || today();
    const start = normalizeTime(startInput.value.trim());
    const end = normalizeTime(endInput.value.trim());
    const rolls = !!start && !!end && parseTime(end) < parseTime(start);
    const newEndDate = rolls ? addDaysToDate(startDate, 1) : startDate;
    endDatePicker.min = startDate;
    if (endDatePicker.value !== newEndDate) endDatePicker.value = newEndDate;
  }
  // Shared by the Start Date picker's own change event and the Start-time
  // "Now" button (which also sets Start Date to today) — keeps both paths
  // in sync with End Date/selectedDate/the ledger the same way.
  function applyStartDateChange() {
    selectedDate = datePicker.value;
    if (endDateManuallySet && endDatePicker.value < datePicker.value) {
      endDatePicker.value = datePicker.value;
    }
    syncEndDateFromTimes();
    doUpdateDurationPreview();
    doSaveDraft();
    doRender();
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
    const project = projectInput.value.trim();
    if (!validateEntry({ date: selectedDate, start, end, activity })) return;
    await addEntry(
      start, end, project, activity, notesInput.value.trim(), endDatePicker.value,
      datePicker, endDatePicker, projectInput, activityInput, startInput, endInput, notesInput,
      entriesDiv, dayTotalDiv, groupTotalsDiv, statsDiv, durationPreview,
    );
  });

  document.getElementById("clearBtn")!.addEventListener("click", (e) => {
    e.preventDefault();
    projectInput.value = "";
    activityInput.value = "";
    startInput.value = "";
    endInput.value = "";
    notesInput.value = "";
    datePicker.value = today();
    endDatePicker.value = today();
    endDatePicker.min = "";
    endDateManuallySet = false;
    selectedDate = today();
    doUpdateDurationPreview();
    doSaveDraft();
  });

  document.getElementById("startBtn")!.addEventListener("click", (e) => {
    e.preventDefault();
    startInput.value = nowTimeString();
    datePicker.value = today();
    applyStartDateChange();
  });

  document.getElementById("stopBtn")!.addEventListener("click", (e) => {
    e.preventDefault();
    endInput.value = nowTimeString();
    // "Now" is an explicit, real end date — treat it like the user picked
    // End Date directly rather than letting a later Start Date change (or
    // the overnight auto-roll) silently move it.
    endDatePicker.value = today();
    endDateManuallySet = true;
    endDatePicker.min = datePicker.value;
    doUpdateDurationPreview();
    doSaveDraft();
  });

  datePicker.addEventListener("change", applyStartDateChange);

  endDatePicker.addEventListener("change", () => {
    endDateManuallySet = true;
    doUpdateDurationPreview();
    doSaveDraft();
  });

  [projectInput, activityInput, startInput, endInput, notesInput].forEach((input) => {
    input.addEventListener("input", doSaveDraft);
  });
  startInput.addEventListener("input", doUpdateDurationPreview);
  endInput.addEventListener("input", doUpdateDurationPreview);

  // Apply the overnight End Date roll-forward once the user leaves whichever
  // time field they were editing, rather than only at Add Entry time.
  [startInput, endInput].forEach((input) => {
    input.addEventListener("blur", () => {
      syncEndDateFromTimes();
      doUpdateDurationPreview();
      doSaveDraft();
    });
  });

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

  // Same story for Time Format (12h/24h) — shell.ts owns the toggle/label and
  // saves the setting; TT just needs to know so formatTime() stops using a
  // stale value and the Entries panel re-renders without a relaunch.
  document.getElementById("timeFormatToggle")!.addEventListener("change", (e) => {
    settings.hour12 = (e.target as HTMLInputElement).checked;
    doRender();
  });

  document.getElementById("quickDeleteToggle")!.addEventListener("change", (e) => {
    settings.quickDelete = (e.target as HTMLInputElement).checked;
    document.getElementById("quickDeleteLabel")!.textContent =
      settings.quickDelete ? "On" : "Off";
    saveSettings();
  });

  document.getElementById("roundNowToggle")!.addEventListener("change", (e) => {
    settings.roundNowToMinute = (e.target as HTMLInputElement).checked;
    document.getElementById("roundNowLabel")!.textContent =
      settings.roundNowToMinute ? "On" : "Off";
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
  document.getElementById("ttProjectNewBtn")!.addEventListener("click", openProjectAdd);
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
    loadDraft(datePicker, endDatePicker, projectInput, activityInput, startInput, endInput, notesInput, doUpdateDurationPreview),
  ]).then(() => {
    const draftHasData = activityInput.value || startInput.value || endInput.value || notesInput.value || projectInput.value;
    if (!draftHasData) {
      datePicker.value = today();
      endDatePicker.value = today();
      endDateManuallySet = false;
      selectedDate = today();
    } else {
      selectedDate = datePicker.value;
      if (!endDatePicker.value) endDatePicker.value = datePicker.value;
    }
    endDatePicker.min = datePicker.value;
    // Activities/Projects are loaded by loadSettings(); reflect them in the
    // Setup list and the autocomplete source now that they're in memory.
    renderActivitiesList();
    refreshActivityDatalist();
    renderProjectsList();
    refreshProjectDatalist();
    doApplyPreset("today");
  });
}
