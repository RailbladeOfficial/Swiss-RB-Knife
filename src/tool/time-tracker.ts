/* =============================================================================
   TIME TRACKER
   -----------------------------------------------------------------------------
   Frontend logic for the Time Tracker tool. Entries live in one JSON file,
   time-tracker.json, read and written whole; this file owns all UI state, event
   wiring, rendering, and the delete-confirm modal.

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
     save_tool_file, load_tool_file (entries, preferences and the draft),
     list_tool_backups, read_tool_backup, export_csv, import_csv,
     load_settings (the app-level preferences this tool formats against)
============================================================================= */

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { flash, devError, shortPath, navigateToTool } from "../core/shell";
import { Modal, ModalTabs } from "../modal/modal";
import { attachMenu } from "../menu/menu";
import { renderToolBackups, readToolBackup } from "../core/tool-backups";
import { newId } from "../core/ids";
import {
  loadToolJson,
  saveToolJson,
  saveToolText,
  unblockAfterReplacement,
} from "../core/tool-store";
import { fileTimestamp, formatStoredDate, localDay, today } from "../core/timestamp";

/* =============================================================================
   TYPES
============================================================================= */

type Entry = {
  date: string;     // start date, YYYY-MM-DD
  start: string;    // start time, real HH:MM:SS (00:00:00-23:59:59)
  endDate: string;  // end date, YYYY-MM-DD, always >= date
  end: string;      // end time, real HH:MM:SS (00:00:00-23:59:59)
  activity: string;
  project: string;  // free-text project name, "" if unset, optional grouping
  notes: string;
};

// A separate {id, name, status} list (same shape/spirit as Budget's
// SimpleEntity) powering the Activity field's autocomplete (Phase 3) and the
// Setup modal's Activities tab. Entries above keep storing `activity` as free
// text; this list never rewrites history, it just remembers names that have
// been used so they can be suggested/managed.
type ActivityStatus = "active" | "retired";
type Activity = { id: string; name: string; status: ActivityStatus };

// Same shape/spirit as Activity, plus a user-assigned integer ID (unique
// across all projects) used to categorize groups of related entries.
// Entries store `project` as free text (like `activity`), not this id.
type Project = { id: string; projectNumber: number; name: string; status: ActivityStatus };

// TT-specific settings, shell owns fontScale, theme, hour12 at the app level,
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
  // How the Break-In modal asks for the length of an interruption. Off (the
  // default) asks for a real end time, matching how every other time in this
  // tool is entered. On asks for a count of minutes, for people who recall
  // "that ate twenty minutes" more readily than "that ended at 10:47".
  breakInUseMinutes: boolean;
  // Tasks parked by the "Break In" button, most recent last. Persisted so
  // closing the app mid-interruption doesn't lose what you meant to go back
  // to. See the LIVE BREAK-IN section.
  pausedTasks: PausedTask[];
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
// form, after that, End Date no longer auto-follows Start Date, and the
// overnight-rollover convenience (see addEntry) stops applying.
let endDateManuallySet = false;
let viewStart: string = today();
let viewEnd: string = today();



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
  breakInUseMinutes: false,
  pausedTasks: [],
};

let settingsSaveTimer: number | null = null;
let draftSaveTimer: number | null = null;
let durationPreviewTimer: number | null = null;

let pendingDeleteIndex: number | null = null;

/* =============================================================================
   DATE HELPERS
============================================================================= */



function formatDate(dateStr: string): string {
  return formatStoredDate(dateStr, settings.americanDates);
}

/** Returns a YYYY-MM-DD date offset by `days` (may be negative). Uses local
 *  midnight so it's immune to DST shifts affecting the date component. */
function addDaysToDate(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return localDay(d);
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
  const todayStr = localDay(now);

  switch (preset) {
    case "today":
      return { start: todayStr, end: todayStr };

    case "yesterday": {
      const d = new Date(now);
      d.setDate(d.getDate() - 1);
      const s = localDay(d);
      return { start: s, end: s };
    }

    case "week-to-date": {
      const d = new Date(now);
      const day = d.getDay() || 7;
      d.setDate(d.getDate() - (day - 1));
      return { start: localDay(d), end: todayStr };
    }

    case "last-7": {
      const d = new Date(now);
      d.setDate(d.getDate() - 6);
      return { start: localDay(d), end: todayStr };
    }

    case "month-to-date": {
      const d = new Date(now.getFullYear(), now.getMonth(), 1);
      return { start: localDay(d), end: todayStr };
    }

    case "last-14": {
      const d = new Date(now);
      d.setDate(d.getDate() - 13);
      return { start: localDay(d), end: todayStr };
    }

    case "last-30": {
      const d = new Date(now);
      d.setDate(d.getDate() - 29);
      return { start: localDay(d), end: todayStr };
    }

    case "last-month": {
      const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const last = new Date(now.getFullYear(), now.getMonth(), 0);
      return { start: localDay(first), end: localDay(last) };
    }

    case "year-to-date": {
      const d = new Date(now.getFullYear(), 0, 1);
      return { start: localDay(d), end: todayStr };
    }

    case "last-year": {
      const first = new Date(now.getFullYear() - 1, 0, 1);
      const last = new Date(now.getFullYear() - 1, 11, 31);
      return { start: localDay(first), end: localDay(last) };
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

/** Formats a duration in total seconds as "Xh Ym Zs", minutes and seconds
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
 *  Returns null for any other length (including 0), never silently
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
 *  (1-12, a 12-hour clock never reads 0, and never exceeds 12). */
function isValidClock(h: number, m: number, s: number, minHour: number, maxHour: number): boolean {
  return h >= minHour && h <= maxHour && m >= 0 && m <= 59 && s >= 0 && s <= 59;
}

/** Normalizes a user-typed time (12h or 24h, with or without seconds) into a
 *  canonical "HH:MM:SS" string, or "" if unparseable OR out of range. Every
 *  branch below validates before returning, so a caller can trust that a
 *  non-empty result is always a real, in-range time. There is no "hour ≥24
 *  rolls to the next day" reading anywhere here: with Start/End Date now
 *  explicit fields, an inflated hour is just invalid input, not a shorthand
 *  for tomorrow. */
function normalizeTime(input: string): string {
  const trimmed = input.trim().toLowerCase();

  // Explicit colon-delimited 24h time, with optional seconds, matched
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

  // Colon-delimited 12h time with an am/pm suffix, "9:30pm", "9:30:15pm".
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

  // Bare digit run with an am/pm suffix and no separators ("930pm",
  // "0930pm", "93045pm") split by the digit-length convention above rather
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

  // Bare digit run, no suffix at all, 24h reading via the same split.
  const cleaned = trimmed.replace(/[^0-9]/g, "");
  if (!cleaned) return "";
  const parts = splitDigitsToClock(cleaned);
  if (!parts || !isValidClock(parts.h, parts.m, parts.s, 0, 23)) return "";
  return `${pad2(parts.h)}:${pad2(parts.m)}:${pad2(parts.s)}`;
}

// Every character normalizeTime() can ever make sense of, digits, the
// separators, and am/pm (with or without periods), either case.
const TIME_INPUT_CHARS = /[^0-9:. apmAPM]/g;

/** Live keystroke guard for a Start/End time field: strips any character
 *  that couldn't possibly be part of a valid time as the user types, so
 *  garbage letters/symbols can't even be entered. This is a UX filter only.
 *  It doesn't validate the VALUE (e.g. "99:99" still passes it fine); that's
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
 *  to Whole Minute" preference, used by the Start/End "Now" buttons. */
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
 *  end is before start, callers must reject that rather than display it. */
function entryDurationSeconds(e: Pick<Entry, "date" | "start" | "endDate" | "end">): number {
  const startTotal = dateToDayIndex(e.date) * 86400 + parseTime(e.start);
  const endTotal = dateToDayIndex(e.endDate) * 86400 + parseTime(e.end);
  return endTotal - startTotal;
}

/* -----------------------------------------------------------------------------
   ABSOLUTE TIMELINE
   ---------------------------------------------------------------------------
   A single number, "seconds since day 0", that collapses an entry's (date,
   time) pair into one comparable value. Any operation that has to reason about
   ordering or containment ACROSS dates (merging entries, carving a break-in
   out of a span, sorting an overnight shift against a morning one) is written
   against these rather than against date strings plus times, because comparing
   the two halves separately is exactly where midnight-spanning entries go
   wrong. entryDurationSeconds() above is the same arithmetic, inlined.
----------------------------------------------------------------------------- */

function entryStartAbs(e: Pick<Entry, "date" | "start">): number {
  return dateToDayIndex(e.date) * 86400 + parseTime(e.start);
}

function entryEndAbs(e: Pick<Entry, "endDate" | "end">): number {
  return dateToDayIndex(e.endDate) * 86400 + parseTime(e.end);
}

/** Inverse of dateToDayIndex. UTC-based for the same reason it is. */
function dayIndexToDate(index: number): string {
  const d = new Date(index * 86400000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Splits an absolute-timeline value back into the (date, HH:MM:SS) pair an
 *  Entry stores. */
function absToDateTime(abs: number): { date: string; time: string } {
  const dayIndex = Math.floor(abs / 86400);
  return {
    date: dayIndexToDate(dayIndex),
    time: secondsToTimeString(abs - dayIndex * 86400),
  };
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
  return `${formatDate(localDay(d))} ${formatTime(timeStr)}`;
}

/* =============================================================================
   VALIDATION
============================================================================= */

function validateEntry({ date, start, end, activity }: Pick<Entry, "date" | "start" | "end" | "activity">): boolean {
  if (!activity) { flash("Activity is required", "error"); return false; }
  if (!start)    { flash("Start time is missing or invalid", "error"); return false; }
  if (!end)      { flash("End time is missing or invalid", "error"); return false; }
  if (!date)     { flash("Start date is required", "error"); return false; }
  return true;
}

/* =============================================================================
   SETTINGS: TT-SPECIFIC
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
 * Shell handles fontScale, theme, and clock format. This only touches
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

  (document.getElementById("breakInMinutesToggle") as HTMLInputElement).checked =
    settings.breakInUseMinutes;
  document.getElementById("breakInMinutesLabel")!.textContent =
    settings.breakInUseMinutes ? "On" : "Off";

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
  refreshBreakInUI();
}

function saveSettings(): void {
  if (settingsSaveTimer) clearTimeout(settingsSaveTimer);
  settingsSaveTimer = window.setTimeout(async () => {
    // TT's settings live in TT's OWN file (time-tracker-settings.json),
    // settings.json belongs to the shell alone. Only the keys this tool
    // owns are written; shell-owned display prefs (fontScale, theme,
    // hour12, americanDates) are read-only here. Activities ride along in
    // this same file, they're TT-owned user data, and keeping them out of
    // the entries data file (save_data) avoids reshaping that atomic blob.
    const own = {
      quickDelete: settings.quickDelete,
      roundNowToMinute: settings.roundNowToMinute,
      payPeriod: settings.payPeriod,
      activities: activities,
      projects: projects,
      lastCsvImportAt: settings.lastCsvImportAt,
      breakInUseMinutes: settings.breakInUseMinutes,
      pausedTasks: settings.pausedTasks,
    };
    try {
      await saveToolJson("time-tracker", "settings", own);
    } catch (e) {
      // This fires from a timer. Without a catch, a failed save would
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
    // stand, and get persisted to the new home so the migration happens
    // exactly once.
    const own = await loadToolJson<Record<string, unknown> | null>("time-tracker", "settings");
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
      if (typeof own.breakInUseMinutes === "boolean") {
        settings.breakInUseMinutes = own.breakInUseMinutes;
      }
      if (Array.isArray(own.pausedTasks)) {
        settings.pausedTasks = own.pausedTasks.filter(isValidPausedTask);
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
   PERSISTENCE: ENTRIES
   -----------------------------------------------------------------------------
   One file, time-tracker.json, holding the whole list.

   It was briefly a database table, and that has been undone deliberately. A
   ledger of a few thousand short records that is always read whole and always
   written whole gains nothing from SQL, and moving it there cost the two things
   that actually matter here: the file can be opened and repaired by hand when
   something goes wrong, and every single save captures the state it is about to
   replace. See backed_up_write_group in lib.rs for that second one.
============================================================================= */

/** Everything an entry holds, in a fixed order, so the file reads the same way
 *  every time and a diff of two exports is a diff of what changed. */
function entryToRow(e: Entry): Entry {
  return {
    date: e.date,
    start: e.start,
    endDate: e.endDate,
    end: e.end,
    activity: e.activity,
    project: e.project,
    notes: e.notes,
  };
}

async function saveToDisk(): Promise<void> {
  try {
    await saveToolJson("time-tracker", "data", entries.map(entryToRow));
  } catch (err) {
    devError("Save failed:", err);
    flash(`Couldn't save your entries: ${String(err)}`, "error", 9000);
  }
}

async function loadFromDisk(): Promise<void> {
  try {
    entries = entriesFrom(await loadToolJson<unknown>("time-tracker", "data"));
  } catch (err) {
    devError("Load failed:", err);
    flash(`Couldn't load your entries: ${String(err)}`, "error", 9000);
    entries = [];
  }
}

/**
 * Turns the stored array into entries, repairing what older versions left.
 *
 * These entries have been on disk since before some of their fields existed:
 * `notes`, `project` and `endDate` were all added after the fact, and an
 * overnight shift used to be stored by inflating the end time past midnight
 * ("26:00" meaning 2am the next day). Every one of those repairs has to stay
 * here, because a file written in 2025 is still a file this has to open.
 *
 * A record that is not an entry at all is dropped rather than fixed. One
 * malformed line must not take the whole ledger down with it.
 */
function entriesFrom(parsed: unknown): Entry[] {
  /* An empty ledger is what an ABSENT file means, and the back end answers a
     missing time-tracker.json with "[]" so that case arrives here as one. It is
     not what a file that would not parse means, and this used to return it for
     both: a corrupt file showed as no entries and the next save wrote no
     entries over it. The parse now happens in loadToolJson, which blocks that
     save instead of letting this decide. */
  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter(
      (e): e is Record<string, unknown> =>
        e !== null &&
        typeof e === "object" &&
        typeof (e as Record<string, unknown>).date === "string" &&
        typeof (e as Record<string, unknown>).start === "string" &&
        typeof (e as Record<string, unknown>).end === "string" &&
        typeof (e as Record<string, unknown>).activity === "string",
    )
    .map((e) => {
      const notes = typeof e.notes === "string" ? e.notes : "";
      const project = typeof e.project === "string" ? e.project : "";
      const date = String(e.date);
      let start = String(e.start);
      let end = String(e.end);
      let endDate = typeof e.endDate === "string" && e.endDate ? e.endDate : "";

      if (!endDate) {
        // The pre-endDate encoding: an end time past 24:00 meant the next day.
        // Split it back into a real time plus a rolled-forward date.
        const secs = parseTime(end);
        if (secs !== null && secs >= 86400) {
          const days = Math.floor(secs / 86400);
          end = secondsToTimeString(secs % 86400);
          endDate = addDaysToDate(date, days);
        } else {
          endDate = date;
        }
      }
      // Legacy values may be "HH:MM" with no seconds; both normalize the same.
      const startSecs = parseTime(start);
      if (startSecs !== null) start = secondsToTimeString(startSecs);
      const endSecs = parseTime(end);
      if (endSecs !== null) end = secondsToTimeString(endSecs);

      return { date, start, endDate, end, activity: String(e.activity), project, notes };
    });
}

/** One record, checked before anything renders it. Used on the import path,
 *  where the file came from outside the app and has not been through
 *  parseEntries. */
function isStoredEntry(e: unknown): e is Entry {
  if (!e || typeof e !== "object") return false;
  const r = e as Partial<Entry>;
  return (
    typeof r.date === "string" && r.date.length > 0 &&
    typeof r.start === "string" &&
    typeof r.end === "string" &&
    typeof r.activity === "string"
  );
}

/* =============================================================================
   PERSISTENCE: DRAFT
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
    await saveToolJson("time-tracker", "draft", {
        selectedDate: datePicker.value,
        endDate: endDatePicker.value,
        endDateManuallySet,
        project: projectInput.value,
        activity: activityInput.value,
        start: startInput.value,
        end: endInput.value,
        notes: notesInput.value,
    });
  }, 500);
}

/** The half-typed entry the draft file holds. Every field is optional: it is
 *  written whenever a box changes, so it can be saved with any of them empty. */
interface StoredDraft {
  selectedDate: string;
  endDate: string;
  endDateManuallySet: boolean;
  project: string;
  activity: string;
  start: string;
  end: string;
  notes: string;
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
    const draft = await loadToolJson<Partial<StoredDraft>>("time-tracker", "draft");
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
        start: localDay(periodStart),
        end: localDay(periodEnd),
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
  return { start: localDay(prevStart), end: localDay(prevEnd) };
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
    // value. Without this, its interval keeps firing every second against
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
        dateToDayIndex(localDay(now)) * 86400 +
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
 * 1. Embedded double quotes are doubled ("" ) per RFC 4180, an activity
 *    named `Say "hi"` would otherwise produce a malformed row that shifts
 *    every column after it.
 * 2. Values starting with = + - @ or a tab get a leading apostrophe. Excel
 *    treats such cells as FORMULAS on open, an activity named
 *    `=HYPERLINK(...)` would execute rather than display. The apostrophe is
 *    Excel's own "treat as text" marker and is invisible in the cell.
 *
 * Only needed for user-entered text (activity names); generated dates/times
 * can't contain either hazard, but passing them through is harmless.
 */
/* =============================================================================
   STATS COMPUTATION
   -----------------------------------------------------------------------------
   Shared by the Stats pane (renderStats), the Totals pane (renderTotals) and
   the CSV export so none of the three can disagree. Everything operates on
   whatever slice of entries the caller passes in: always the currently-visible
   (view-filtered) set, so the numbers track the active view mode exactly.
============================================================================= */

type Stat = { label: string; value: string };

/** One column of the Stats pane / one section of the CSV STATS block. */
type StatGroup = { title: string; stats: Stat[] };

/** One row of a Totals-pane breakdown table, and the raw material for every
 *  per-activity / per-project superlative below. `days` is the set of distinct
 *  START dates the bucket touches, which is what "spans the most days" means. */
type BreakdownRow = {
  name: string;
  /** True for the single bucket holding entries with an empty project. */
  unassigned: boolean;
  count: number;
  secs: number;
  days: Set<string>;
};

/**
 * Buckets entries by activity or project name, case-insensitively (the same
 * convention render() and exportCSV() have always used for the Totals summary),
 * keeping the first-seen spelling as the display name.
 *
 * Sorted by total time descending: that is the order the breakdown tables want
 * (biggest sink of time first) and it means the superlatives below can often
 * just read row [0] instead of scanning.
 */
function breakdownBy(visible: Entry[], field: "activity" | "project"): BreakdownRow[] {
  const map = new Map<string, BreakdownRow>();
  visible.forEach((e) => {
    const raw = e[field].trim();
    const key = raw.toLowerCase();
    let row = map.get(key);
    if (!row) {
      row = { name: raw, unassigned: raw === "", count: 0, secs: 0, days: new Set<string>() };
      map.set(key, row);
    }
    row.count += 1;
    row.secs += entryDurationSeconds(e);
    row.days.add(e.date);
  });
  return [...map.values()].sort(
    (a, b) => b.secs - a.secs || a.name.localeCompare(b.name),
  );
}

/** Rows with a real name, i.e. everything except the "no project" bucket. */
function namedRows(rows: BreakdownRow[]): BreakdownRow[] {
  return rows.filter((r) => !r.unassigned);
}

/** The row with the highest value of `pick`, or null for an empty list. Used
 *  for every "X with the most/highest Y" stat so they all break ties the same
 *  way (first one wins, and the list is already time-ordered). */
function maxRow(
  rows: BreakdownRow[],
  pick: (r: BreakdownRow) => number,
): BreakdownRow | null {
  let best: BreakdownRow | null = null;
  let bestVal = -Infinity;
  rows.forEach((r) => {
    const v = pick(r);
    if (v > bestVal) { bestVal = v; best = r; }
  });
  return best;
}

/** Whole percent of `total`, guarding the no-entries case. */
function pct(part: number, total: number): string {
  if (total <= 0) return "0%";
  return `${Math.round((part / total) * 100)}%`;
}

/** Longest run of consecutive calendar days that have at least one entry.
 *  Counted on start dates, matching how the ledger groups rows into days. */
function longestDayStreak(dates: string[]): number {
  if (dates.length === 0) return 0;
  const idx = [...new Set(dates)].map(dateToDayIndex).sort((a, b) => a - b);
  let best = 1;
  let run = 1;
  for (let i = 1; i < idx.length; i++) {
    run = idx[i] === idx[i - 1]! + 1 ? run + 1 : 1;
    if (run > best) best = run;
  }
  return best;
}

/**
 * Every stat the Stats pane shows, grouped into the three columns it renders.
 * The grouping is not cosmetic: it is what lets the pane run three columns
 * across the panel instead of one long list, and it is what the CSV export
 * writes as sub-headings.
 */
function computeStatGroups(visible: Entry[]): StatGroup[] {
  if (visible.length === 0) return [];

  const totalEntries = visible.length;
  const totalSecs = visible.reduce((sum, e) => sum + entryDurationSeconds(e), 0);

  const byActivity = breakdownBy(visible, "activity");
  const byProject = breakdownBy(visible, "project");
  const realProjects = namedRows(byProject);
  const unassignedSecs = byProject.find((r) => r.unassigned)?.secs ?? 0;
  const assignedSecs = totalSecs - unassignedSecs;

  /* ---- Activities ------------------------------------------------------- */

  const actMostEntries = maxRow(byActivity, (r) => r.count);
  const actMostTime = byActivity[0] ?? null;         // list is time-sorted
  const actHighestAvg = maxRow(byActivity, (r) => r.secs / r.count);

  let longestEntry = visible[0]!;
  let longestSecs = entryDurationSeconds(longestEntry);
  visible.forEach((e) => {
    const secs = entryDurationSeconds(e);
    if (secs > longestSecs) { longestEntry = e; longestSecs = secs; }
  });

  const activityStats: Stat[] = [
    { label: "Unique Activities", value: String(byActivity.length) },
    { label: "Entries Logged", value: String(totalEntries) },
    {
      label: "Avg Time per Entry",
      value: formatDuration(Math.round(totalSecs / totalEntries)),
    },
    {
      label: "Most Entries",
      value: actMostEntries
        ? `${actMostEntries.name} (${entryCountLabel(actMostEntries.count)})`
        : "—",
    },
    {
      label: "Most Time",
      value: actMostTime
        ? `${actMostTime.name} (${formatDuration(actMostTime.secs)})`
        : "—",
    },
    {
      label: "Highest Avg Time",
      value: actHighestAvg
        ? `${actHighestAvg.name} (${formatDuration(Math.round(actHighestAvg.secs / actHighestAvg.count))})`
        : "—",
    },
    {
      label: "Longest Single Entry",
      value: `${longestEntry.activity} on ${formatDate(longestEntry.date)} (${formatDuration(longestSecs)})`,
    },
  ];

  /* ---- Projects --------------------------------------------------------- */

  const projStats: Stat[] = [
    { label: "Projects Tracked", value: String(realProjects.length) },
    {
      label: "Time on Projects",
      value: `${formatDuration(assignedSecs)} (${pct(assignedSecs, totalSecs)})`,
    },
    {
      label: "Unassigned Time",
      value: `${formatDuration(unassignedSecs)} (${pct(unassignedSecs, totalSecs)})`,
    },
  ];

  if (realProjects.length > 0) {
    const projMostTime = realProjects[0]!;              // time-sorted
    const projMostEntries = maxRow(realProjects, (r) => r.count)!;
    const projHighestAvg = maxRow(realProjects, (r) => r.secs / r.count)!;
    const projMostDays = maxRow(realProjects, (r) => r.days.size)!;

    // Busiest single (project, day) pairing: the day a project ate the most
    // time. Distinct from "Busiest Day", which is across everything.
    const perProjectDay = new Map<string, { project: string; date: string; secs: number }>();
    visible.forEach((e) => {
      const name = e.project.trim();
      if (!name) return;
      const key = `${name.toLowerCase()}|${e.date}`;
      const g = perProjectDay.get(key) ?? { project: name, date: e.date, secs: 0 };
      g.secs += entryDurationSeconds(e);
      perProjectDay.set(key, g);
    });
    let bestProjectDay = { project: "", date: "", secs: -1 };
    perProjectDay.forEach((g) => {
      if (g.secs > bestProjectDay.secs) bestProjectDay = g;
    });

    projStats.push(
      {
        label: "Avg Time per Project",
        value: formatDuration(Math.round(assignedSecs / realProjects.length)),
      },
      {
        label: "Most Time",
        value: `${projMostTime.name} (${formatDuration(projMostTime.secs)})`,
      },
      {
        label: "Most Entries",
        value: `${projMostEntries.name} (${entryCountLabel(projMostEntries.count)})`,
      },
      {
        label: "Highest Avg Session",
        value: `${projHighestAvg.name} (${formatDuration(Math.round(projHighestAvg.secs / projHighestAvg.count))})`,
      },
      {
        label: "Spans Most Days",
        value: `${projMostDays.name} (${projMostDays.days.size} ${projMostDays.days.size === 1 ? "day" : "days"})`,
      },
      {
        label: "Biggest Project Day",
        value: `${bestProjectDay.project} on ${formatDate(bestProjectDay.date)} (${formatDuration(bestProjectDay.secs)})`,
      },
    );
  }

  /* ---- Days & Times ----------------------------------------------------- */

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

  const streak = longestDayStreak(visible.map((e) => e.date));

  const dayStats: Stat[] = [
    { label: "Total Time", value: formatDuration(totalSecs) },
    { label: "Days Tracked", value: String(byDate.size) },
    {
      label: "Avg Time per Day",
      value: formatDuration(Math.round(totalSecs / byDate.size)),
    },
    {
      label: "Avg Entries per Day",
      value: `${(totalEntries / byDate.size).toFixed(1)} entries/day`,
    },
    {
      label: "Longest Day Streak",
      value: `${streak} ${streak === 1 ? "day" : "days"}`,
    },
    {
      label: "Craziest Day",
      value: `${formatDate(craziestDate)} (${entryCountLabel(craziestCount)})`,
    },
    {
      label: "Busiest Day",
      value: `${formatDate(busiestDate)} (${formatDuration(busiestSecs)})`,
    },
    {
      label: "Earliest Start",
      value: `${formatTime(secondsToTimeString(earliestSecs))} on ${formatDate(earliestEntry.date)} (${earliestEntry.activity})`,
    },
    {
      label: "Latest Finish",
      value: `${formatTime(secondsToTimeString(latestSecs))} on ${formatDate(latestEntry.date)} (${latestEntry.activity})`,
    },
  ];

  return [
    { title: "Activities", stats: activityStats },
    { title: "Projects", stats: projStats },
    { title: "Days & Times", stats: dayStats },
  ];
}

function csvField(value: string): string {
  let v = value;
  if (/^[=+\-@\t]/.test(v)) v = "'" + v;
  return `"${v.replace(/"/g, '""')}"`;
}

async function exportCSV(): Promise<void> {
  // One instant for both the filename and the header inside the file, so the
  // two can never disagree by a second.
  const now = new Date();
  const filename = `time-tracker-report-${fileTimestamp(now)}.csv`;

  const visibleEntries = entries.filter((e) => {
    if (!viewStart && !viewEnd) return true;
    if (viewStart && e.date < viewStart) return false;
    if (viewEnd && e.date > viewEnd) return false;
    return true;
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

  // Both breakdowns come from the same helper the Totals pane renders from, so
  // an exported report and the on-screen panel can never drift apart.
  const grandTotal = visibleEntries.reduce((sum, e) => sum + entryDurationSeconds(e), 0);

  (["activity", "project"] as const).forEach((field) => {
    const label = field === "activity" ? "Activity" : "Project";
    lines.push(`SUMMARY BY ${label.toUpperCase()}`);
    lines.push(`${label},Entries,Total Time,Avg Time,Share`);
    breakdownBy(visibleEntries, field).forEach((row) => {
      const name = row.unassigned
        ? (field === "project" ? "(No Project)" : "(Unnamed)")
        : row.name;
      lines.push(
        `${csvField(name)},${row.count},"${formatDuration(row.secs)}",` +
        `"${formatDuration(Math.round(row.secs / row.count))}","${pct(row.secs, grandTotal)}"`,
      );
    });
    lines.push(`"TOTAL",${visibleEntries.length},"${formatDuration(grandTotal)}","",""`);
    lines.push("");
  });

  lines.push("STATS");
  computeStatGroups(visibleEntries).forEach((group) => {
    lines.push(`${csvField(group.title)},`);
    group.stats.forEach((stat) => {
      lines.push(`${csvField(stat.label)},${csvField(stat.value)}`);
    });
    lines.push("");
  });

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
    const savedTo = await invoke<string>("export_csv", { filename, data: lines.join("\r\n") });
    flash(`Report exported to ${shortPath(savedTo)}`, "success");
  } catch (err) {
    devError("Export failed:", err);
    flash("Export failed", "error");
  }
}

/* =============================================================================
   CSV IMPORT
   -----------------------------------------------------------------------------
   Adds new entries from a user-provided CSV; never edits existing ones. All
   rows are validated before anything is added, if any row is missing a
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
    else if (ch === "\r") { /* skip, \n (below) closes the row */ }
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
 *  real calendar date (e.g. month 13, or day 30 in February). JS's Date
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

/** Parses a CSV date cell in any commonly-seen format (ISO ("2024-03-05"),
 *  numeric with slashes/dashes/dots in either month-first or day-first order
 *  ("3/5/2024", "05.03.2024"), or a month name ("March 5, 2024", "5 Mar
 *  2024")) into a canonical "YYYY-MM-DD" string. Returns "" if the text
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

  // Last resort, hand anything else recognizable (e.g. "2024-03-05T10:00:00")
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

    // End Date is optional, when absent, mirror the manual-entry convenience:
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
      message: `Import canceled: ${errors.length} row${errors.length > 1 ? "s" : ""} failed validation:\n${errors.join("\n")}`,
    };
  }
  if (parsed.length === 0) {
    return { ok: false, message: "No data rows found in the file." };
  }

  return { ok: true, entries: parsed };
}

async function downloadCsvTemplate(): Promise<void> {
  try {
    const timestamp = fileTimestamp();
    const savedTo = await invoke<string>("export_csv", {
      filename: `time-tracker-import-template-${timestamp}.csv`,
      data: "Start Date,Start Time,End Date,End Time,Project,Activity,Notes",
    });
    flash(`Template saved to ${shortPath(savedTo)}`, "success");
  } catch (err) {
    devError("Template download failed:", err);
    flash("Template download failed", "error");
  }
}

/* =============================================================================
   SUMMARY PANEL: TAB STATE
   -----------------------------------------------------------------------------
   The Totals / Stats panes are both rendered on every render() (they are cheap,
   and keeping them both current means switching tabs never shows stale numbers
   for a frame). Only visibility is toggled here.
============================================================================= */

type TTSummaryTab = "totals" | "stats";
let activeSummaryTab: TTSummaryTab = "totals";

function activateSummaryTab(tab: TTSummaryTab): void {
  activeSummaryTab = tab;
  document
    .querySelectorAll<HTMLButtonElement>(".tt-summary-tabs .tt-summary-tab")
    .forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.ttSummaryTab === tab);
    });
  const totalsPane = document.getElementById("ttSummaryTotals");
  const statsPane = document.getElementById("ttSummaryStats");
  if (totalsPane) totalsPane.style.display = tab === "totals" ? "" : "none";
  if (statsPane) statsPane.style.display = tab === "stats" ? "" : "none";
}

/* =============================================================================
   ENTRY SELECTION (bulk clone / merge / delete)
   -----------------------------------------------------------------------------
   Selection is opt-in: the Select button in the entries header turns it on,
   which inserts a checkbox into every row and shows the action bar. Off by
   default so the ledger keeps its full width for content.

   Selected entries are tracked by OBJECT IDENTITY, not by index. Indexes move
   whenever entries are added, sorted, merged, or split, and a stale index in a
   delete path is how you lose the wrong row. Entry objects are stable for as
   long as they exist in `entries`, so a Set of them is both correct and
   self-cleaning: pruneSelection() drops anything no longer in the array.
============================================================================= */

let selectMode = false;
const selectedEntries = new Set<Entry>();
/** The entry whose checkbox was last clicked, the anchor for shift-click range
 *  selection. Cleared whenever selection mode is turned off. */
let lastCheckedEntry: Entry | null = null;
/** The entries currently on screen, in display order. Needed by the range
 *  select and the Select All button, both of which mean "of what I can see". */
let lastVisible: Entry[] = [];

/** Drops selections whose entry is no longer in `entries` (deleted, merged
 *  away, replaced by a split) so the count and the bulk actions can never
 *  operate on a ghost. */
function pruneSelection(): void {
  selectedEntries.forEach((e) => {
    if (!entries.includes(e)) selectedEntries.delete(e);
  });
}

/** Selection in display order. Every bulk action wants it ordered, and it must
 *  come from `entries` rather than the Set's insertion order. */
function selectedInOrder(): Entry[] {
  return lastVisible.filter((e) => selectedEntries.has(e));
}

function setSelectMode(on: boolean): void {
  selectMode = on;
  if (!on) {
    selectedEntries.clear();
    lastCheckedEntry = null;
  }
  const btn = document.getElementById("ttSelectModeBtn");
  if (btn) {
    btn.classList.toggle("active", on);
    btn.textContent = on ? "Done" : "Select";
  }
  const bar = document.getElementById("ttSelectionBar");
  if (bar) bar.style.display = on ? "" : "none";
  rerenderEntryViews();
}

/** Refreshes the selection bar's count and which actions are available.
 *  Merge needs at least two entries; clone and delete need at least one. */
function refreshSelectionBar(): void {
  const n = selectedEntries.size;
  const count = document.getElementById("ttSelectionCount");
  if (count) count.textContent = `${n} selected`;
  const setEnabled = (id: string, enabled: boolean) => {
    const b = document.getElementById(id) as HTMLButtonElement | null;
    if (b) b.disabled = !enabled;
  };
  setEnabled("ttBulkCloneBtn", n >= 1);
  setEnabled("ttBulkMergeBtn", n >= 2);
  setEnabled("ttBulkDeleteBtn", n >= 1);
}

/* =============================================================================
   RENDER
============================================================================= */

/** Builds one row of a Totals breakdown table. `share` (0-1) paints the row's
 *  background bar via the --share custom property, see .tt-breakdown-row. */
function buildBreakdownRow(
  name: string,
  count: number,
  secs: number,
  share: number,
  opts: { header?: boolean; total?: boolean; unassigned?: boolean } = {},
): HTMLElement {
  const row = document.createElement("div");
  row.className = "tt-breakdown-row"
    + (opts.header ? " tt-breakdown-row-header" : "")
    + (opts.total ? " tt-breakdown-row-total" : "");
  if (!opts.header && !opts.total) {
    row.style.setProperty("--share", `${Math.round(share * 100)}%`);
  }

  const nameSpan = document.createElement("span");
  nameSpan.className = "tt-breakdown-col-name"
    + (opts.unassigned ? " tt-breakdown-unassigned" : "");
  nameSpan.textContent = name;
  nameSpan.title = name;

  const countSpan = document.createElement("span");
  countSpan.className = "tt-breakdown-col-num";
  countSpan.textContent = opts.header ? "Entries" : String(count);

  const totalSpan = document.createElement("span");
  totalSpan.className = "tt-breakdown-col-num";
  totalSpan.textContent = opts.header ? "Total" : formatDuration(secs);

  const shareSpan = document.createElement("span");
  shareSpan.className = "tt-breakdown-col-share";
  shareSpan.textContent = opts.header ? "Share" : (opts.total ? "" : `${Math.round(share * 100)}%`);

  row.append(nameSpan, countSpan, totalSpan, shareSpan);
  return row;
}

/** Fills one breakdown table (By Activity or By Project). */
function renderBreakdownTable(
  container: HTMLElement,
  rows: BreakdownRow[],
  firstColLabel: string,
  emptyLabel: string,
  grandTotal: number,
): void {
  container.innerHTML = "";
  if (rows.length === 0) {
    const p = document.createElement("p");
    p.className = "placeholder-text";
    p.textContent = "Nothing in this view yet.";
    container.appendChild(p);
    return;
  }

  container.appendChild(buildBreakdownRow(firstColLabel, 0, 0, 0, { header: true }));
  let count = 0;
  rows.forEach((r) => {
    count += r.count;
    container.appendChild(
      buildBreakdownRow(
        r.unassigned ? emptyLabel : r.name,
        r.count,
        r.secs,
        grandTotal > 0 ? r.secs / grandTotal : 0,
        { unassigned: r.unassigned },
      ),
    );
  });
  container.appendChild(
    buildBreakdownRow("Total", count, grandTotal, 0, { total: true }),
  );
}

/** The headline chip strip: the handful of figures worth seeing without
 *  switching to the Stats tab. */
function renderHeadlineStrip(
  strip: HTMLElement,
  visible: Entry[],
  totalSecs: number,
  byActivity: BreakdownRow[],
  byProject: BreakdownRow[],
): void {
  strip.innerHTML = "";
  if (visible.length === 0) return;

  const days = new Set(visible.map((e) => e.date)).size;
  const chips: [string, string][] = [
    [String(visible.length), visible.length === 1 ? "entry" : "entries"],
    [String(byActivity.length), byActivity.length === 1 ? "activity" : "activities"],
    [String(namedRows(byProject).length), "projects"],
    [String(days), days === 1 ? "day" : "days"],
    [formatDuration(Math.round(totalSecs / days)), "avg/day"],
    [formatDuration(Math.round(totalSecs / visible.length)), "avg/entry"],
  ];

  chips.forEach(([value, label]) => {
    const chip = document.createElement("span");
    chip.className = "tt-headline-chip";
    const v = document.createElement("span");
    v.className = "tt-headline-chip-value";
    v.textContent = value;
    const l = document.createElement("span");
    l.className = "tt-headline-chip-label";
    l.textContent = label;
    chip.append(v, l);
    strip.appendChild(chip);
  });
}

/** The whole Totals pane: headline row plus the two breakdown tables. */
function renderTotals(
  dayTotalDiv: HTMLElement,
  groupTotalsDiv: HTMLElement,
  visible: Entry[],
): void {
  const totalSecs = visible.reduce((sum, e) => sum + entryDurationSeconds(e), 0);
  const byActivity = breakdownBy(visible, "activity");
  const byProject = breakdownBy(visible, "project");

  dayTotalDiv.textContent = `Total: ${formatDuration(totalSecs)}`;

  const strip = document.getElementById("ttHeadlineStrip");
  if (strip) renderHeadlineStrip(strip, visible, totalSecs, byActivity, byProject);

  renderBreakdownTable(groupTotalsDiv, byActivity, "Activity", "(Unnamed)", totalSecs);

  const projectTotals = document.getElementById("ttProjectTotals");
  if (projectTotals) {
    renderBreakdownTable(projectTotals, byProject, "Project", "(No Project)", totalSecs);
  }
}

function render(
  entriesDiv: HTMLElement,
  dayTotalDiv: HTMLElement,
  groupTotalsDiv: HTMLElement,
  statsDiv: HTMLElement,
): void {
  entriesDiv.innerHTML = "";

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

  lastVisible = visible;
  pruneSelection();

  const byDate: Map<string, Entry[]> = new Map();
  visible.forEach((entry) => {
    if (!byDate.has(entry.date)) byDate.set(entry.date, []);
    byDate.get(entry.date)!.push(entry);
  });

  const rerender = () => render(entriesDiv, dayTotalDiv, groupTotalsDiv, statsDiv);

  byDate.forEach((dateEntries, date) => {
    const daySecs = dateEntries.reduce(
      (sum, e) => sum + entryDurationSeconds(e),
      0,
    );

    const subheader = document.createElement("div");
    subheader.className = "entry-date-subheader";
    subheader.textContent = `${formatDate(date)}: ${formatDuration(daySecs)}`;
    entriesDiv.appendChild(subheader);

    dateEntries.forEach((entry) => {
      const entryIndex = entries.indexOf(entry);
      const secs = entryDurationSeconds(entry);

      const row = document.createElement("div");
      row.className = "entry-row"
        + (selectMode && selectedEntries.has(entry) ? " tt-entry-selected" : "");

      if (selectMode) {
        const check = document.createElement("input");
        check.type = "checkbox";
        check.className = "tt-entry-check";
        check.checked = selectedEntries.has(entry);
        check.title = "Select this entry (shift-click to select a range)";
        // click, not change: only the click event carries shiftKey, and the
        // browser has already flipped .checked by the time it fires.
        check.addEventListener("click", (ev) => {
          const on = check.checked;
          if ((ev as MouseEvent).shiftKey && lastCheckedEntry) {
            const a = visible.indexOf(lastCheckedEntry);
            const b = visible.indexOf(entry);
            if (a !== -1 && b !== -1) {
              const [lo, hi] = a < b ? [a, b] : [b, a];
              for (let k = lo; k <= hi; k++) {
                const target = visible[k]!;
                if (on) selectedEntries.add(target);
                else selectedEntries.delete(target);
              }
            }
          } else if (on) {
            selectedEntries.add(entry);
          } else {
            selectedEntries.delete(entry);
          }
          lastCheckedEntry = entry;
          rerender();
        });
        row.appendChild(check);
      }

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
        ? `Ends ${formatDate(entry.endDate)}, double-click to edit the time, use the calendar icon to edit dates`
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
        openNotesEditModal(entry, rerender),
      );
      row.appendChild(notesSpan);

      const breakInBtn = document.createElement("button");
      breakInBtn.className = "entry-cal-btn tt-entry-action-btn";
      breakInBtn.textContent = "⤵";
      breakInBtn.title = "Break-in tasks: carve interruptions out of this entry";
      breakInBtn.addEventListener("click", () => openBreakInModal(entry, rerender));
      row.appendChild(breakInBtn);

      const cloneBtn = document.createElement("button");
      cloneBtn.className = "entry-cal-btn tt-entry-action-btn";
      cloneBtn.textContent = "⧉";
      cloneBtn.title = "Duplicate this entry";
      cloneBtn.addEventListener("click", () => cloneEntries([entry]));
      row.appendChild(cloneBtn);

      const calBtn = document.createElement("button");
      calBtn.className = "entry-cal-btn";
      calBtn.textContent = "📅";
      calBtn.title = "Edit dates";
      calBtn.addEventListener("click", () => openDateEditModal(entry, rerender));
      row.appendChild(calBtn);

      const deleteBtn = document.createElement("button");
      deleteBtn.textContent = "🗑️";
      deleteBtn.className = "entry-delete-btn";
      deleteBtn.addEventListener("click", () =>
        deleteEntry(entryIndex, entriesDiv, dayTotalDiv, groupTotalsDiv, statsDiv),
      );
      row.appendChild(deleteBtn);

      /* The row's menu. Two shapes, because right-clicking inside a selection
         should act on the selection: while Select mode is on and this row is
         part of a multi-entry selection, the menu offers the bulk actions
         instead of the single-entry ones. Right-clicking a row OUTSIDE the
         selection still gets the single-entry menu, so there is no way to
         accidentally act on rows you had forgotten were ticked.

         Editing a field is offered here as well as by double-click, which is
         the only way to discover the double-click at all. */
      attachMenu(row, () => {
        const bulk = selectMode && selectedEntries.has(entry) && selectedEntries.size > 1;
        if (bulk) {
          const list = selectedInOrder();
          return [
            { label: `${list.length} entries selected`, disabled: true },
            { label: "Duplicate All", onClick: () => void cloneEntries(list) },
            {
              label: "Delete All",
              danger: true,
              onClick: () => openBulkDeleteModal(list, rerender),
            },
          ];
        }
        return [
          {
            label: "Edit Project",
            onClick: () =>
              makeEditable(projectSpan, entry, "project", entriesDiv, dayTotalDiv, groupTotalsDiv, statsDiv),
          },
          {
            label: "Edit Activity",
            onClick: () =>
              makeEditable(activitySpan, entry, "activity", entriesDiv, dayTotalDiv, groupTotalsDiv, statsDiv),
          },
          { label: "Edit Notes…", onClick: () => openNotesEditModal(entry, rerender) },
          { label: "Edit Dates…", onClick: () => openDateEditModal(entry, rerender) },
          { label: "Break-in Tasks…", onClick: () => openBreakInModal(entry, rerender) },
          { label: "Duplicate Entry", onClick: () => void cloneEntries([entry]) },
          {
            // Fills the input panel and presses Now, which is exactly the
            // sequence you would do by hand. Looked up here rather than held
            // as module state because render() runs long before init() wires
            // those refs up.
            label: "Start a New Entry Like This",
            onClick: () => {
              const p = document.getElementById("project") as HTMLInputElement | null;
              const a = document.getElementById("activity") as HTMLInputElement | null;
              if (p) p.value = entry.project;
              if (a) a.value = entry.activity;
              document.getElementById("startBtn")?.click();
            },
          },
          {
            label: "Delete Entry",
            danger: true,
            onClick: () =>
              void deleteEntry(entryIndex, entriesDiv, dayTotalDiv, groupTotalsDiv, statsDiv),
          },
        ];
      });

      entriesDiv.appendChild(row);
    });
  });

  renderTotals(dayTotalDiv, groupTotalsDiv, visible);
  renderStats(statsDiv, visible);
  refreshSelectionBar();
}

/* =============================================================================
   STATS PANE
============================================================================= */

function renderStats(statsDiv: HTMLElement, visible: Entry[]): void {
  statsDiv.innerHTML = "";
  const groups = computeStatGroups(visible);

  if (groups.length === 0) {
    const p = document.createElement("p");
    p.className = "placeholder-text";
    p.textContent = "No entries in this view yet.";
    statsDiv.appendChild(p);
    return;
  }

  groups.forEach((group) => {
    const col = document.createElement("div");
    col.className = "tt-stats-group";

    const title = document.createElement("div");
    title.className = "tt-stats-group-title";
    title.textContent = group.title;
    col.appendChild(title);

    const list = document.createElement("div");
    list.className = "stats-list";
    group.stats.forEach((stat) => {
      const row = document.createElement("div");
      row.className = "stat-row";

      const label = document.createElement("span");
      label.className = "stat-label";
      label.textContent = stat.label;
      row.appendChild(label);

      const value = document.createElement("span");
      value.className = "stat-value";
      value.textContent = stat.value;
      value.title = stat.value;
      row.appendChild(value);

      list.appendChild(row);
    });

    col.appendChild(list);
    statsDiv.appendChild(col);
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
  // text. The end column may carry a "(+1d)" suffix that normalizeTime
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
    // Project is optional, clearing it to empty is a valid edit (removes
    // the entry from any project), unlike the other inline-editable fields
    // where empty means "discard this edit".
    if (!raw && field !== "project") { cancel(); return; }

    if (field === "start" || field === "end") {
      const normalized = normalizeTime(raw);
      if (!normalized) { cancel(); return; }
      const prevValue = entry[field];
      entry[field] = normalized;

      // No auto-roll here, unlike Add Entry. This is editing an EXISTING
      // entry's dates are already fixed, so a start/end time edit that would
      // make the span negative is simply rejected. If the entry is already
      // multi-day (date !== endDate), entryDurationSeconds() correctly
      // accounts for that and won't reject a same-day-looking time-of-day
      // comparison that's actually fine across the date boundary.
      if (entryDurationSeconds(entry) < 0) {
        entry[field] = prevValue;
        flash("End time can't be before start time. Use the calendar icon to edit dates if this should span multiple days.", "error");
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
   ENTRIES: CORE OPERATIONS
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
    flash("End date cannot be before Start date", "error");
    return false;
  }
  if (entryDurationSeconds({ date: startDate, start, endDate, end }) < 0) {
    flash("End time must be after Start time. Check the dates.", "error");
    return false;
  }

  entries.push({ date: startDate, start, endDate, end, activity, project, notes });

  sortEntries();
  lastActivity = activity;
  // Remember this activity/project name for autocomplete, silent quick-add,
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

/* =============================================================================
   EXTERNAL ENTRY API
   -----------------------------------------------------------------------------
   Other tools that produce a real span of worked time (currently the Countdown Timer
   timer's "Log to Time Tracker") add it through here rather than writing
   time-tracker.json themselves. That matters because `entries` is live module
   state: a second writer touching the file directly would be silently
   overwritten the next time this tool saved. Going through one function also
   means an externally-added entry gets the same treatment as a hand-typed one
:   sorted into place, its activity/project remembered for autocomplete, and
   the visible list refreshed.
============================================================================= */

/** Appends an entry on behalf of another tool. Times are the same formats the
 *  Entry type documents: dates YYYY-MM-DD, times HH:MM:SS, both local. */
export async function addTimeTrackerEntry(input: {
  date: string;
  start: string;
  endDate: string;
  end: string;
  activity: string;
  project?: string;
  notes?: string;
}): Promise<void> {
  entries.push({
    date: input.date,
    start: input.start,
    endDate: input.endDate,
    end: input.end,
    activity: input.activity,
    project: input.project ?? "",
    notes: input.notes ?? "",
  });

  sortEntries();
  findOrCreateActivity(input.activity);
  if (input.project) findOrCreateProject(input.project);
  await saveToDisk();
  rerenderEntryViews();
}

/** Re-renders the entries list from the DOM ids, for callers outside
 *  initTimeTracker's closure (which is where render's element refs live).
 *  No-ops before init has run. Nothing is on screen to refresh yet. */
function rerenderEntryViews(): void {
  const entriesDiv = document.getElementById("entries");
  const dayTotalDiv = document.getElementById("dayTotal");
  const groupTotalsDiv = document.getElementById("groupTotals");
  const statsDiv = document.getElementById("statsPanel");
  if (!entriesDiv || !dayTotalDiv || !groupTotalsDiv || !statsDiv) return;
  render(entriesDiv, dayTotalDiv, groupTotalsDiv, statsDiv);
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
   ENTRY OPERATIONS: CLONE / MERGE / SPLIT
   -----------------------------------------------------------------------------
   The three ways an existing entry (or a run of them) can be reshaped without
   retyping it. All of them go through `entries` + sortEntries() + saveToDisk()
   rather than touching the file, for the same reason addTimeTrackerEntry does:
   `entries` is live module state and a second writer would be clobbered.
============================================================================= */

/** Duplicates entries in place, times and all. The copy is deliberately an
 *  exact one: "I did that again" is the common case, and the times are the
 *  part you were always going to edit anyway. */
async function cloneEntries(list: Entry[]): Promise<void> {
  if (list.length === 0) return;
  list.forEach((e) => entries.push({ ...e }));
  sortEntries();
  rerenderEntryViews();
  await saveToDisk();
  flash(
    list.length === 1 ? "Entry cloned" : `${list.length} entries cloned`,
    "success",
  );
}

/* -----------------------------------------------------------------------------
   MERGE
----------------------------------------------------------------------------- */

/**
 * Where the merged entry ends.
 *
 *   "span"    the latest end among the entries. The merged block covers the
 *             whole stretch of wall clock they sit in, so any gap between them
 *             becomes tracked time.
 *   "compact" earliest start plus what the entries add up to. Total tracked
 *             time is identical before and after the merge; the end is pulled
 *             back by however much dead air there was.
 */
type MergeDurationMode = "span" | "compact";

/** Where the merged entry's notes come from. "entry:<index>" picks one
 *  specific entry, indexed into the plan's `ordered` list.
 *
 *  There is deliberately no "earliest" / "latest" shorthand: whenever more than
 *  one entry has notes the dropdown lists each of them by name, so those two
 *  would just be the first and last rows of that list under a second name. */
type MergeNotesMode = "combine" | "none" | `entry:${number}`;

/** What merging the given entries would produce, without doing it. Shared by
 *  the modal's live summary and its Merge button so the preview can't lie. */
function computeMergePlan(list: Entry[]): {
  ordered: Entry[];
  startAbs: number;
  /** Latest end among the entries: where "span" mode finishes. */
  endAbs: number;
  /** Earliest start plus the tracked total: where "compact" mode finishes. */
  compactEndAbs: number;
  /** Wall-clock length of the merged entry in "span" mode, gaps included. */
  mergedSecs: number;
  /** What the entries add up to on their own, and the length of a
   *  "compact" merge by construction. */
  sumSecs: number;
} {
  const ordered = [...list].sort((a, b) => entryStartAbs(a) - entryStartAbs(b));
  const startAbs = Math.min(...ordered.map(entryStartAbs));
  const endAbs = Math.max(...ordered.map(entryEndAbs));
  const sumSecs = ordered.reduce((sum, e) => sum + entryDurationSeconds(e), 0);
  return {
    ordered,
    startAbs,
    endAbs,
    compactEndAbs: startAbs + sumSecs,
    mergedSecs: endAbs - startAbs,
    sumSecs,
  };
}

/** The end of a merge under the given mode. One place, so the summary, the
 *  dropdown labels and the actual merge can't pick different ends. */
function mergeEndAbs(
  plan: ReturnType<typeof computeMergePlan>,
  mode: MergeDurationMode,
): number {
  return mode === "compact" ? plan.compactEndAbs : plan.endAbs;
}

/** A point on the absolute timeline as the modal shows it: bare time when it
 *  falls on `refDate`, date-qualified when it doesn't. */
function mergePointLabel(abs: number, refDate: string): string {
  const { date, time } = absToDateTime(abs);
  return date === refDate ? formatTime(time) : `${formatDate(date)} ${formatTime(time)}`;
}

/** The entries carrying notes, in merge order. Every notes option is defined
 *  in terms of this list rather than the full selection, so "the earliest
 *  notes" means the earliest notes that exist, not an empty string from an
 *  entry that happened to sort first. */
function entriesWithNotes(ordered: Entry[]): Entry[] {
  return ordered.filter((e) => e.notes.trim());
}

/** Resolves the notes dropdown to the text the merged entry gets. */
function resolveMergedNotes(ordered: Entry[], mode: MergeNotesMode): string {
  if (mode === "none") return "";

  if (mode.startsWith("entry:")) {
    const index = Number(mode.slice("entry:".length));
    return ordered[index]?.notes ?? "";
  }

  // combine: every distinct note, in order, one per line. Duplicates are
  // dropped because merging three fragments of one session usually means
  // three copies of the same note.
  const seen = new Set<string>();
  return entriesWithNotes(ordered)
    .map((e) => e.notes.trim())
    .filter((n) => !seen.has(n) && seen.add(n))
    .join("\n");
}

/** Distinct values of one field across the selection, ordered by how much time
 *  each accounts for. Drives the "keep which name" dropdowns: the name you
 *  spent the most time under is the one you almost always mean to keep. */
function distinctByTime(list: Entry[], field: "activity" | "project"): string[] {
  const totals = new Map<string, { name: string; secs: number }>();
  list.forEach((e) => {
    const name = e[field].trim();
    const g = totals.get(name.toLowerCase()) ?? { name, secs: 0 };
    g.secs += entryDurationSeconds(e);
    totals.set(name.toLowerCase(), g);
  });
  return [...totals.values()]
    .sort((a, b) => b.secs - a.secs || a.name.localeCompare(b.name))
    .map((g) => g.name);
}

/* -----------------------------------------------------------------------------
   BREAK-IN / SPLIT
   ---------------------------------------------------------------------------
   The retroactive half of the break-in feature. One entry (the "host") is the
   uninterrupted block you THOUGHT you worked; each break-in is punched out of
   it, and the host's own task resumes on the far side of every hole. So one
   four-hour block plus three interruptions becomes seven entries in one pass,
   instead of one edit and six hand-typed rows.
----------------------------------------------------------------------------- */

/** One row of the Break-In modal, held as raw input strings so a half-typed
 *  row doesn't have to be valid to exist.
 *
 *  Both `endTime` and `lengthMin` are always carried, even though only one is
 *  on screen (settings.breakInUseMinutes decides which). Keeping them in step
 *  costs nothing and means flipping the preference never leaves a row holding
 *  a stale value from the other mode. */
type BreakInDraft = {
  activity: string;
  project: string;
  /** Free-text time, run through normalizeTime() on validation. */
  startTime: string;
  /** End time, as typed. Used when breakInUseMinutes is OFF (the default). */
  endTime: string;
  /** Length in minutes, as typed. Used when breakInUseMinutes is ON. */
  lengthMin: string;
  /** Days after the host's START date this break-in falls on. Always 0 unless
   *  the host spans midnight, in which case the row shows a day picker. */
  dayOffset: number;
};

type DraftSpan =
  | { ok: true; startAbs: number; endAbs: number }
  | { ok: false; error: string };

/**
 * Turns one draft row into a start/end pair on the absolute timeline, reading
 * whichever of the two length modes is switched on.
 *
 * Both the validator and the "add another row" default go through here, so the
 * two can't disagree about what a row means, and the mode switch only has to be
 * understood in one place.
 *
 * End-time mode uses the same overnight convention as the main entry form: an
 * end at or before the start reads as the next day round. That is what makes a
 * 23:50 interruption that ended at 00:20 work without a second day picker.
 */
function resolveDraftSpan(host: Entry, d: BreakInDraft, label: string): DraftSpan {
  const start = normalizeTime(d.startTime.trim());
  if (!start) return { ok: false, error: `${label} has an invalid start time.` };

  const startAbs = (dateToDayIndex(host.date) + d.dayOffset) * 86400 + parseTime(start);

  if (settings.breakInUseMinutes) {
    const minutes = Number(d.lengthMin);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      return { ok: false, error: `${label} needs a length in minutes.` };
    }
    return { ok: true, startAbs, endAbs: startAbs + Math.round(minutes * 60) };
  }

  const end = normalizeTime(d.endTime.trim());
  if (!end) return { ok: false, error: `${label} has an invalid end time.` };
  const span = (parseTime(end) - parseTime(start) + 86400) % 86400;
  if (span === 0) return { ok: false, error: `${label} has to end after it starts.` };
  return { ok: true, startAbs, endAbs: startAbs + span };
}

/** A fresh row starting at `fromAbs`, defaulting to a quarter hour and clamped
 *  to the host's end so a new row is never born out of bounds. Both length
 *  modes are filled in from the same span. */
function makeBreakInDraft(host: Entry, fromAbs: number): BreakInDraft {
  const hostEnd = entryEndAbs(host);
  const startAbs = Math.min(fromAbs, hostEnd);
  const endAbs = Math.min(startAbs + 15 * 60, hostEnd);
  return {
    activity: "",
    project: "",
    startTime: formatTime(absToDateTime(startAbs).time),
    endTime: formatTime(absToDateTime(endAbs).time),
    lengthMin: String(Math.max(1, Math.round((endAbs - startAbs) / 60))),
    dayOffset: Math.floor(startAbs / 86400) - dateToDayIndex(host.date),
  };
}

type BreakInSegment = { entry: Entry; isBreak: boolean };

type BreakInResult =
  | { ok: true; segments: BreakInSegment[] }
  | { ok: false; error: string };

/**
 * Turns a host entry plus a list of break-in drafts into the sequence of
 * entries that should replace it. Pure: validates and computes, changes
 * nothing. Everything is done on the absolute timeline (see entryStartAbs)
 * so a host that crosses midnight behaves exactly like one that doesn't.
 */
function computeBreakInResult(host: Entry, drafts: BreakInDraft[]): BreakInResult {
  const hostStart = entryStartAbs(host);
  const hostEnd = entryEndAbs(host);

  const breaks: { activity: string; project: string; startAbs: number; endAbs: number }[] = [];

  for (let i = 0; i < drafts.length; i++) {
    const d = drafts[i]!;
    const label = `Break-in ${i + 1}`;
    const activity = d.activity.trim();
    if (!activity) return { ok: false, error: `${label} needs an activity name.` };

    const span = resolveDraftSpan(host, d, label);
    if (!span.ok) return { ok: false, error: span.error };
    const { startAbs, endAbs } = span;

    if (startAbs < hostStart) {
      return { ok: false, error: `${label} starts before the entry it interrupts.` };
    }
    if (endAbs > hostEnd) {
      return { ok: false, error: `${label} runs past the end of the entry it interrupts.` };
    }

    breaks.push({ activity, project: d.project.trim(), startAbs, endAbs });
  }

  breaks.sort((a, b) => a.startAbs - b.startAbs);
  for (let i = 1; i < breaks.length; i++) {
    if (breaks[i]!.startAbs < breaks[i - 1]!.endAbs) {
      return { ok: false, error: "Two break-ins overlap. Adjust their times or lengths." };
    }
  }

  const segments: BreakInSegment[] = [];
  let cursor = hostStart;
  // The host's notes ride on its first SURVIVING segment only. Copying them
  // onto every segment would turn one note into four identical ones.
  let notesUnused = true;

  const pushHostSegment = (fromAbs: number, toAbs: number) => {
    if (toAbs <= fromAbs) return;
    const from = absToDateTime(fromAbs);
    const to = absToDateTime(toAbs);
    segments.push({
      isBreak: false,
      entry: {
        date: from.date,
        start: from.time,
        endDate: to.date,
        end: to.time,
        activity: host.activity,
        project: host.project,
        notes: notesUnused ? host.notes : "",
      },
    });
    notesUnused = false;
  };

  breaks.forEach((b) => {
    pushHostSegment(cursor, b.startAbs);
    const from = absToDateTime(b.startAbs);
    const to = absToDateTime(b.endAbs);
    segments.push({
      isBreak: true,
      entry: {
        date: from.date,
        start: from.time,
        endDate: to.date,
        end: to.time,
        activity: b.activity,
        project: b.project,
        notes: "",
      },
    });
    cursor = b.endAbs;
  });
  pushHostSegment(cursor, hostEnd);

  if (segments.length === 0) {
    return { ok: false, error: "That would leave nothing behind. Shorten a break-in." };
  }
  return { ok: true, segments };
}

/* =============================================================================
   LIVE BREAK-IN  (the go-forward half)
   -----------------------------------------------------------------------------
   The Break-In modal above fixes an afternoon after the fact. This fixes it as
   it happens, in one click, so there is nothing to reconstruct later.

   With the clock running (Start filled, End empty), "Break In" stops the clock
   at now, files the entry, pushes what you were doing onto a paused stack, and
   restarts the clock on a blank form. "Resume" does the mirror image: files
   whatever you pivoted to, pops the stack, and puts the original task back in
   the form with the clock running again.

   A STACK rather than a single slot, because interruptions nest: the thing
   that interrupted you gets interrupted too, and each Resume should hand back
   the most recent thing you dropped. The stack lives in TT's settings file, so
   closing the app mid-interruption doesn't lose the thread you meant to
   return to.
============================================================================= */

type PausedTask = { project: string; activity: string; notes: string };

function isValidPausedTask(t: unknown): t is PausedTask {
  return (
    t !== null &&
    typeof t === "object" &&
    typeof (t as PausedTask).project === "string" &&
    typeof (t as PausedTask).activity === "string" &&
    typeof (t as PausedTask).notes === "string"
  );
}

/** Shows/hides the Break In and Resume buttons and labels Resume with whatever
 *  is on top of the paused stack. Safe to call before the TT view exists. */
function refreshBreakInUI(): void {
  const startInput = document.getElementById("startTime") as HTMLInputElement | null;
  const endInput = document.getElementById("endTime") as HTMLInputElement | null;
  const breakBtn = document.getElementById("ttBreakInNowBtn");
  const resumeBtn = document.getElementById("ttResumeBtn");
  if (!startInput || !endInput || !breakBtn || !resumeBtn) return;

  // "Clock running": a usable start time and no end time yet.
  const running = !!normalizeTime(startInput.value.trim()) && !endInput.value.trim();
  breakBtn.style.display = running ? "" : "none";

  const stack = settings.pausedTasks;
  const paused = stack[stack.length - 1];
  if (paused) {
    const name = paused.project ? `${paused.project} · ${paused.activity}` : paused.activity;
    const deeper = stack.length - 1;
    resumeBtn.textContent = `↩ Resume: ${name}` + (deeper > 0 ? ` (+${deeper} paused)` : "");
    resumeBtn.title = `Log what you're on now and pick "${paused.activity}" back up`;
    resumeBtn.style.display = "";
  } else {
    resumeBtn.style.display = "none";
  }
}

/* =============================================================================
   ACTIVITIES: SETUP LIST + AUTOCOMPLETE SOURCE
   -----------------------------------------------------------------------------
   Mirrors Budget's Expense Sources: a {id,name,status} list managed in the
   Setup modal, used to populate the Activity field's datalist (Phase 3).
============================================================================= */

/**
 * Silent quick-add used from the main entry form (typed Activity text, or an
 * inline activity edit). Matches an existing ACTIVE activity case-insensitively
 * and does nothing if found; otherwise creates a new active one. No toast, no
 * reactivation of retired items, mirrors Budget's findOrCreate (active-only)
 * as opposed to the explicit addOrReactivate path used by the Setup button.
 */
function findOrCreateActivity(name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  const existing = activities.find(
    (a) => a.status === "active" && a.name.toLowerCase() === trimmed.toLowerCase(),
  );
  if (existing) return;
  activities.push({ id: newId(), name: trimmed, status: "active" });
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
    activities.push({ id: newId(), name: trimmed, status: "active" });
  }

  flash(wasReactivated ? "Activity reactivated" : "Activity added", "success");
  saveSettings();
  refreshActivityDatalist();
  renderActivitiesList();
  return true;
}

/**
 * Repopulates the Activity field's <datalist> from active activities.
 * No-op until Phase 3 adds the datalist element, safe to call now.
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
 *  (case-insensitive). The "N entries" count shown in Setup list rows, the
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
    p.textContent = "No activities yet. Add one above.";
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
   PROJECTS: SETUP LIST + AUTOCOMPLETE SOURCE
   -----------------------------------------------------------------------------
   Mirrors the Activities list above, plus a user-assigned integer ID
   (projectNumber) that must stay unique across all projects. Entries keep
   storing `project` as free text (like `activity`); Project is optional
   grouping, so unlike Activity an empty Project field is valid.
============================================================================= */

/** Smallest integer not currently in use as a projectNumber. Used only for
 *  the quick-add path (typing a new name directly in the Input panel).
 *  The Setup "+ New Project" form lets the user pick the number explicitly. */
function nextProjectNumber(): number {
  return projects.reduce((max, p) => Math.max(max, p.projectNumber), 0) + 1;
}

/**
 * Silent quick-add used from the main entry form (typed Project text).
 * Matches an existing ACTIVE project case-insensitively and does nothing if
 * found; otherwise creates a new active one with the next free ID number.
 * Mirrors findOrCreateActivity. No toast, no reactivation of retired items.
 */
function findOrCreateProject(name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  const existing = projects.find(
    (p) => p.status === "active" && p.name.toLowerCase() === trimmed.toLowerCase(),
  );
  if (existing) return;
  projects.push({ id: newId(), projectNumber: nextProjectNumber(), name: trimmed, status: "active" });
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

  if (!Number.isInteger(projectNumber)) { flash("ID Number must be a whole number", "error"); return false; }
  if (projects.some((p) => p.projectNumber === projectNumber)) {
    flash(`ID Number ${projectNumber} is already in use`, "error");
    return false;
  }

  projects.push({ id: newId(), projectNumber, name: trimmed, status: "active" });
  flash("Project added", "success");
  saveSettings();
  refreshProjectDatalist();
  renderProjectsList();
  return true;
}

/**
 * Save handler for the Edit Project modal: renames, renumbers, and (like
 * activity rename) rewrites every matching entry's `project` text so
 * history stays in sync. Returns false (and flashes the reason) on
 * validation failure, so the modal can stay open.
 */
function saveProjectEdit(item: Project, name: string, projectNumber: number): boolean {
  const trimmed = name.trim();
  if (!trimmed) { flash("Name cannot be empty", "error"); return false; }
  if (!Number.isInteger(projectNumber)) { flash("ID Number must be a whole number", "error"); return false; }
  if (projects.some((p) => p.id !== item.id && p.projectNumber === projectNumber)) {
    flash(`ID Number ${projectNumber} is already in use`, "error");
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
  nameSpan.textContent = `#${item.projectNumber}: ${item.name}`;
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
    p.textContent = "No projects yet. Add one above.";
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
   MODAL: TT SETUP (Projects / Activities / Preferences tabs)
   -----------------------------------------------------------------------------
   Module-level (like Budget's getSetupModal) so the Activity Add/Edit/Delete
   modals can reopen Setup on the Activities tab after their actions.
============================================================================= */

type TTSetupTab = "projects" | "activities" | "preferences" | "data";
let ttSetupModal: Modal | null = null;

// Set by initTimeTracker so module-level code (activity rename/delete, which
// mutate entries) can re-render the ledger without threading DOM refs out here.
let renderCurrentView: () => void = () => {};

/** Setup's tab strip, on the shared ModalTabs controller (modal.ts). It owns
 *  tab state, pane visibility and pane scroll resets. */
const ttSetupTabs = new ModalTabs<TTSetupTab>({
  scope: "#ttSettingsModal",
  key: "ttTab",
  panes: {
    projects: "ttTabProjects",
    activities: "ttTabActivities",
    preferences: "ttTabPreferences",
    data: "ttTabData",
  },
});

/* -----------------------------------------------------------------------------
   SNAPSHOTS
   -----------------------------------------------------------------------------
   Every save captures the file it is about to overwrite, the same hourly
   capture Budget and Kanban have had since they shipped. This is the screen
   that gets at it.

   Entries and the activity/project vocabulary are captured TOGETHER (see
   TT_GROUP in lib.rs), so an hour of entries can be restored beside the list of
   activities as it stood at that hour. They are still restored one at a time,
   because wanting last week's entries is not the same as wanting last week's
   preferences back with them.
----------------------------------------------------------------------------- */

/** Wired once, on the first Setup open. */
let ttBackupRefreshWired = false;

function wireTTBackupRefresh(): void {
  if (ttBackupRefreshWired) return;
  ttBackupRefreshWired = true;
  document
    .getElementById("ttBackupRefreshBtn")!
    .addEventListener("click", () => void refreshTTBackups());
}

async function refreshTTBackups(): Promise<void> {
  wireTTBackupRefresh();
  await renderToolBackups({
    toolId: "time-tracker",
    host: document.getElementById("ttBackupList")!,
    summary: document.getElementById("ttBackupSummary"),
    labels: { data: "Time entries", settings: "Activities and projects" },
    onRestore: async (entry, snapshot) => {
      const raw = await readToolBackup("time-tracker", snapshot.name, entry.kind);
      // Written back through the ordinary save path, which captures what it is
      // replacing on the way past. See the header of core/tool-backups.ts.
      // A restore REPLACES the file with bytes that were captured from it, so
      // it is allowed to land on one that would not read: that is the whole
      // point of having the snapshot.
      unblockAfterReplacement("time-tracker", entry.kind);
      await saveToolText("time-tracker", entry.kind, raw);
      if (entry.kind === "data") {
        await loadFromDisk();
      } else {
        await loadSettings();
        applyTTSettings();
      }
      renderCurrentView();
      await refreshTTBackups();
    },
  });
}


/* -----------------------------------------------------------------------------
   EXPORT AND IMPORT
   -----------------------------------------------------------------------------
   Registered with the Data tab in App Settings, which owns the buttons.

   Entries AND the activity/project vocabulary go in one file, because an export
   is meant to rebuild the tool: entries name their activity as free text, so a
   set of entries without the list that autocompletes them is a tool that works
   but has forgotten what you call things.
----------------------------------------------------------------------------- */

interface TimeTrackerExport {
  entries: Entry[];
  activities: Activity[];
  projects: Project[];
  settings: Partial<TTSettings>;
}
function openTTSetupOnTab(tab?: TTSetupTab): void {
  if (tab) ttSetupTabs.select(tab);
  getTTSetupModal().open();
  // Read on the way in rather than on tab switch: the list is a directory
  // listing of about thirty entries, and doing it here means the Data tab is
  // never the one that is still loading when you arrive at it.
  void refreshTTBackups();
}

function getTTSetupModal(): Modal {
  if (!ttSetupModal) {
    ttSetupModal = new Modal(document.getElementById("ttSettingsBackdrop")!, {
      closeOnEsc: true,
      tabs: ttSetupTabs,
      onOpen: () => {
        renderActivitiesList();
        renderProjectsList();
        applyTTSettings();
      },
    });

    document.getElementById("ttSettingsClose")!.addEventListener("click", () => ttSetupModal!.close());
  }
  return ttSetupModal;
}

/* =============================================================================
   MODAL: ACTIVITY ADD / EDIT (fully independent, mirrors Budget's simple
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
  getTTSetupModal().close({ handoff: true });
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
      // sharing one name, offer a merge instead of allowing the collision.
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
  getTTSetupModal().close({ handoff: true });
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
   MODAL: PROJECT ADD / EDIT (mirrors the Activity Add/Edit modals, plus a
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
  getTTSetupModal().close({ handoff: true });
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
      // one name, offer a merge instead of allowing the collision.
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
  getTTSetupModal().close({ handoff: true });
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
   MODAL: TT SETUP DELETE CONFIRM
   Shared by Activities and Projects (only reachable for an already-retired
   item (Delete is hidden until an item is retired) mirrors Budget's setup
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
      // Entries store the name, not an id, so orphaned entries would keep a
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
   MODAL: TT SETUP MERGE CONFIRM (shared by Activities and Projects)
   Reached when an Edit rename collides with another activity/project's name
   (case-insensitively), since two active entities can't share a name, the
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
   MODAL: CSV IMPORT
   Mirrors the Activity Add/Edit modals' "leaves Setup, returns to Setup on
   close" pattern. Back, the header X, and Cancel all return to the
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
  getTTSetupModal().close({ handoff: true });
  resetCsvImportModalState();
  getCsvImportModal().open();
}

/* =============================================================================
   MODAL HELPERS: TT-OWNED (delete confirm only)
   Shell owns: settings, about, exit, changelog.
============================================================================= */

/* =============================================================================
   MODAL: BREAK-IN TASKS
   -----------------------------------------------------------------------------
   Carves one or more interruptions out of a single existing entry. See the
   BREAK-IN / SPLIT section above for the arithmetic; this is only the UI.

   Rows are rebuilt wholesale on add/remove but never on keystroke: each input
   writes straight into its draft object and re-renders the PREVIEW only, so
   typing never steals focus from the field you're typing in.
============================================================================= */

let breakInModal: Modal | null = null;
let breakInHost: Entry | null = null;
let breakInRerender: () => void = () => {};
let breakInDrafts: BreakInDraft[] = [];

/** A label + control pair, one column of a break-in row. */
function buildBreakInCell(labelText: string, control: HTMLElement): HTMLElement {
  const cell = document.createElement("div");
  cell.className = "tt-break-in-cell";
  const label = document.createElement("label");
  label.className = "tt-field-label";
  label.textContent = labelText;
  cell.append(label, control);
  return cell;
}

function renderBreakInRows(): void {
  const container = document.getElementById("ttBreakInRows");
  const host = breakInHost;
  if (!container || !host) return;

  container.innerHTML = "";
  const spanDays = daysBetween(host.date, host.endDate);

  breakInDrafts.forEach((draft, index) => {
    const row = document.createElement("div");
    row.className = "tt-break-in-row" + (spanDays > 0 ? " tt-break-in-row--multiday" : "");

    const activity = document.createElement("input");
    activity.type = "text";
    activity.placeholder = "What interrupted you?";
    activity.setAttribute("list", "ttActivityList");
    activity.autocomplete = "off";
    activity.value = draft.activity;
    activity.addEventListener("input", () => {
      draft.activity = activity.value;
      renderBreakInPreview();
    });
    row.appendChild(buildBreakInCell("Activity", activity));

    const project = document.createElement("input");
    project.type = "text";
    project.placeholder = "Optional";
    project.setAttribute("list", "ttProjectList");
    project.autocomplete = "off";
    project.value = draft.project;
    project.addEventListener("input", () => {
      draft.project = project.value;
      renderBreakInPreview();
    });
    row.appendChild(buildBreakInCell("Project", project));

    // Only worth the column when the host actually crosses midnight; otherwise
    // there is exactly one day it could be on.
    if (spanDays > 0) {
      const day = document.createElement("select");
      for (let d = 0; d <= spanDays; d++) {
        const opt = document.createElement("option");
        opt.value = String(d);
        opt.textContent = formatDate(addDaysToDate(host.date, d));
        day.appendChild(opt);
      }
      day.value = String(draft.dayOffset);
      day.addEventListener("change", () => {
        draft.dayOffset = Number(day.value);
        renderBreakInPreview();
      });
      row.appendChild(buildBreakInCell("Day", day));
    }

    // Start and (in end-time mode) End get identical treatment: type freely,
    // and on leaving the field the value is normalized and redisplayed in the
    // app's own time format, the same contract the main entry form offers.
    const buildTimeField = (
      labelText: string,
      placeholder: string,
      get: () => string,
      set: (v: string) => void,
    ) => {
      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = placeholder;
      input.autocomplete = "off";
      input.value = get();
      restrictToTimeChars(input);
      input.addEventListener("input", () => {
        set(input.value);
        renderBreakInPreview();
      });
      input.addEventListener("blur", () => {
        const normalized = normalizeTime(input.value.trim());
        if (normalized) {
          const display = formatTime(normalized);
          set(display);
          input.value = display;
        }
        renderBreakInPreview();
      });
      return buildBreakInCell(labelText, input);
    };

    row.appendChild(buildTimeField(
      "Started", "10:15",
      () => draft.startTime,
      (v) => { draft.startTime = v; },
    ));

    if (settings.breakInUseMinutes) {
      const length = document.createElement("input");
      length.type = "number";
      length.min = "1";
      length.step = "1";
      length.placeholder = "15";
      length.autocomplete = "off";
      length.value = draft.lengthMin;
      length.addEventListener("input", () => {
        draft.lengthMin = length.value;
        renderBreakInPreview();
      });
      row.appendChild(buildBreakInCell("Minutes", length));
    } else {
      row.appendChild(buildTimeField(
        "Ended", "10:45",
        () => draft.endTime,
        (v) => { draft.endTime = v; },
      ));
    }

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "tt-break-in-remove";
    remove.textContent = "✕";
    remove.title = "Remove this break-in";
    // The last row stays: an empty modal has nothing to apply and no obvious
    // way back to a first row.
    remove.disabled = breakInDrafts.length <= 1;
    remove.addEventListener("click", () => {
      breakInDrafts.splice(index, 1);
      renderBreakInRows();
      renderBreakInPreview();
    });
    row.appendChild(remove);

    container.appendChild(row);
  });
}

/** The resulting timeline, or the first thing wrong with the current drafts.
 *  Also gates the Apply button. */
function renderBreakInPreview(): void {
  const preview = document.getElementById("ttBreakInPreview");
  const errorBox = document.getElementById("ttBreakInError");
  const applyBtn = document.getElementById("ttBreakInApply") as HTMLButtonElement | null;
  const host = breakInHost;
  if (!preview || !errorBox || !applyBtn || !host) return;

  preview.innerHTML = "";
  const result = computeBreakInResult(host, breakInDrafts);

  if (!result.ok) {
    errorBox.textContent = result.error;
    errorBox.style.display = "";
    applyBtn.disabled = true;
    const p = document.createElement("p");
    p.className = "placeholder-text";
    p.textContent = "Fill the rows in to see what this becomes.";
    preview.appendChild(p);
    return;
  }

  errorBox.style.display = "none";
  applyBtn.disabled = false;

  result.segments.forEach((seg) => {
    const row = document.createElement("div");
    row.className = "tt-break-in-preview-row" + (seg.isBreak ? " is-break" : "");

    const name = document.createElement("span");
    name.className = "tt-break-in-preview-name";
    name.textContent = seg.entry.project
      ? `${seg.entry.project} · ${seg.entry.activity}`
      : seg.entry.activity;
    name.title = name.textContent;

    const span = document.createElement("span");
    span.className = "tt-break-in-preview-span";
    const crossesDay = seg.entry.date !== seg.entry.endDate;
    span.textContent = crossesDay
      ? `${formatTime(seg.entry.start)} → ${formatDate(seg.entry.endDate)} ${formatTime(seg.entry.end)}`
      : `${formatTime(seg.entry.start)} → ${formatTime(seg.entry.end)}`;

    const dur = document.createElement("span");
    dur.className = "tt-break-in-preview-dur";
    dur.textContent = formatDuration(entryDurationSeconds(seg.entry));

    row.append(name, span, dur);
    preview.appendChild(row);
  });
}

function getBreakInModal(): Modal {
  if (!breakInModal) {
    breakInModal = new Modal(document.getElementById("ttBreakInBackdrop")!, {
      closeOnEsc: true,
      onClosed: () => {
        breakInHost = null;
        breakInDrafts = [];
      },
    });

    document.getElementById("ttBreakInClose")!.addEventListener("click", () => breakInModal!.close());
    document.getElementById("ttBreakInCancel")!.addEventListener("click", () => breakInModal!.close());

    document.getElementById("ttBreakInAddRowBtn")!.addEventListener("click", () => {
      const host = breakInHost;
      if (!host) return;
      // A new row starts where the previous one ended, which is almost always
      // the right neighborhood and is never invalid on its own. A previous row
      // that isn't finished yet has no end to follow, so fall back to the
      // host's start.
      const prev = breakInDrafts[breakInDrafts.length - 1];
      const prevSpan = prev ? resolveDraftSpan(host, prev, "") : null;
      breakInDrafts.push(makeBreakInDraft(
        host,
        prevSpan && prevSpan.ok ? prevSpan.endAbs : entryStartAbs(host),
      ));
      renderBreakInRows();
      renderBreakInPreview();
    });

    document.getElementById("ttBreakInApply")!.addEventListener("click", async () => {
      const host = breakInHost;
      if (!host) return;
      const result = computeBreakInResult(host, breakInDrafts);
      if (!result.ok) { flash(result.error, "error"); return; }

      const index = entries.indexOf(host);
      if (index === -1) { flash("That entry is no longer there", "error"); return; }

      entries.splice(index, 1, ...result.segments.map((seg) => seg.entry));
      result.segments.forEach((seg) => {
        if (!seg.isBreak) return;
        findOrCreateActivity(seg.entry.activity);
        if (seg.entry.project) findOrCreateProject(seg.entry.project);
      });
      sortEntries();

      const breakCount = result.segments.filter((seg) => seg.isBreak).length;
      breakInModal!.close();
      breakInRerender();
      await saveToDisk();
      flash(
        `${breakCount} break-in${breakCount === 1 ? "" : "s"} carved out, ` +
        `${result.segments.length} entries now`,
        "success",
      );
    });
  }
  return breakInModal;
}

function openBreakInModal(entry: Entry, rerender: () => void): void {
  breakInHost = entry;
  breakInRerender = rerender;
  breakInDrafts = [makeBreakInDraft(entry, entryStartAbs(entry))];

  const crossesDay = entry.date !== entry.endDate;
  setContextLines(document.getElementById("ttBreakInContext")!, [
    `${entry.project || "—"} · ${entry.activity}`,
    crossesDay
      ? `${formatDate(entry.date)} ${formatTime(entry.start)} → ${formatDate(entry.endDate)} ${formatTime(entry.end)} (${formatDuration(entryDurationSeconds(entry))})`
      : `${formatDate(entry.date)} ${formatTime(entry.start)} → ${formatTime(entry.end)} (${formatDuration(entryDurationSeconds(entry))})`,
  ]);

  getBreakInModal().open();
  renderBreakInRows();
  renderBreakInPreview();
}

/* =============================================================================
   MODAL: MERGE ENTRIES
   -----------------------------------------------------------------------------
   Collapses a selection of entries into one running from the earliest start to
   the latest end. The gap figure is shown up front rather than buried: merging
   two entries with an hour between them ADDS that hour to your tracked time,
   which is the one surprising thing this operation can do.
============================================================================= */

let mergeEntriesModal: Modal | null = null;
let mergeEntriesList: Entry[] = [];
let mergeEntriesRerender: () => void = () => {};

function buildMergeSummaryRow(label: string, value: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "tt-merge-summary-row";
  const l = document.createElement("span");
  l.className = "tt-merge-summary-label";
  l.textContent = label;
  const v = document.createElement("span");
  v.className = "tt-merge-summary-value";
  v.textContent = value;
  row.append(l, v);
  return row;
}

/** The duration dropdown's current value. */
function mergeDurationMode(): MergeDurationMode {
  const sel = document.getElementById("ttMergeDuration") as HTMLSelectElement | null;
  return sel?.value === "compact" ? "compact" : "span";
}

/**
 * Redraws the summary block and the note under it for whichever duration mode
 * is selected. Runs on open and on every change of that dropdown, so the
 * figures on screen always describe the merge you would actually get.
 */
function refreshMergeSummary(plan: ReturnType<typeof computeMergePlan>): void {
  const mode = mergeDurationMode();
  const endAbs = mergeEndAbs(plan, mode);
  const from = absToDateTime(plan.startAbs);
  const gap = plan.mergedSecs - plan.sumSecs;

  const summary = document.getElementById("ttMergeEntriesSummary")!;
  summary.innerHTML = "";
  summary.appendChild(buildMergeSummaryRow(
    "New span",
    `${formatDate(from.date)} ${formatTime(from.time)} → ${mergePointLabel(endAbs, from.date)}`,
  ));
  summary.appendChild(buildMergeSummaryRow(
    "Merged duration",
    formatDuration(endAbs - plan.startAbs),
  ));
  summary.appendChild(buildMergeSummaryRow(
    "The entries add up to",
    formatDuration(plan.sumSecs),
  ));

  // One box, two registers: red where the merge changes your tracked total,
  // muted where it only tells you something you should know.
  const note = document.getElementById("ttMergeEntriesWarning")!;
  let text = "";
  let neutral = false;

  if (mode === "span" && gap > 0) {
    text =
      `There is ${formatDuration(gap)} of untracked time between these entries. ` +
      `Merging swallows it, so the result is ${formatDuration(gap)} longer than the entries themselves.`;
  } else if (mode === "span" && gap < 0) {
    text =
      `These entries overlap by ${formatDuration(-gap)}, so the merged entry is ` +
      `shorter than their combined time.`;
  } else if (mode === "compact" && gap > 0) {
    text =
      `The end is pulled back ${formatDuration(gap)} to ${mergePointLabel(endAbs, from.date)}, ` +
      `dropping the untracked time between these entries. Your tracked total is unchanged.`;
    neutral = true;
  } else if (mode === "compact" && gap < 0) {
    // The overlap was double-counted to begin with, so preserving the total
    // has to push the end past when anything actually ran.
    text =
      `These entries overlap by ${formatDuration(-gap)}. Keeping their combined total ` +
      `runs the merged entry to ${mergePointLabel(endAbs, from.date)}, later than any of them ended.`;
  }

  note.textContent = text;
  note.classList.toggle("tt-merge-note", neutral);
  note.style.display = text ? "" : "none";
}

function getMergeEntriesModal(): Modal {
  if (!mergeEntriesModal) {
    mergeEntriesModal = new Modal(document.getElementById("ttMergeEntriesBackdrop")!, {
      closeOnEsc: true,
      onClosed: () => { mergeEntriesList = []; },
    });

    document.getElementById("ttMergeEntriesClose")!.addEventListener("click", () => mergeEntriesModal!.close());
    document.getElementById("ttMergeEntriesCancel")!.addEventListener("click", () => mergeEntriesModal!.close());

    document.getElementById("ttMergeDuration")!.addEventListener("change", () => {
      const list = mergeEntriesList.filter((e) => entries.includes(e));
      if (list.length >= 2) refreshMergeSummary(computeMergePlan(list));
    });

    document.getElementById("ttMergeEntriesConfirm")!.addEventListener("click", async () => {
      const list = mergeEntriesList.filter((e) => entries.includes(e));
      if (list.length < 2) { flash("Nothing left to merge", "error"); return; }

      const plan = computeMergePlan(list);
      const activity = (document.getElementById("ttMergeActivity") as HTMLSelectElement).value;
      const project = (document.getElementById("ttMergeProject") as HTMLSelectElement).value;
      const notesMode = (document.getElementById("ttMergeNotes") as HTMLSelectElement)
        .value as MergeNotesMode;

      const endAbs = mergeEndAbs(plan, mergeDurationMode());
      const from = absToDateTime(plan.startAbs);
      const to = absToDateTime(endAbs);
      const merged: Entry = {
        date: from.date,
        start: from.time,
        endDate: to.date,
        end: to.time,
        activity,
        project,
        notes: resolveMergedNotes(plan.ordered, notesMode),
      };

      entries = entries.filter((e) => !list.includes(e));
      entries.push(merged);
      findOrCreateActivity(activity);
      if (project) findOrCreateProject(project);
      sortEntries();

      selectedEntries.clear();
      mergeEntriesModal!.close();
      mergeEntriesRerender();
      await saveToDisk();
      flash(
        `${list.length} entries merged into one (${formatDuration(endAbs - plan.startAbs)})`,
        "success",
      );
    });
  }
  return mergeEntriesModal;
}

/** Fills the duration dropdown, spelling out the end time and length each mode
 *  produces so the choice needs no explaining. With no gap the two are the same
 *  merge, so there is nothing to choose and the dropdown says so. */
function fillMergeDurationSelect(plan: ReturnType<typeof computeMergePlan>): void {
  const sel = document.getElementById("ttMergeDuration") as HTMLSelectElement;
  const refDate = absToDateTime(plan.startAbs).date;
  const gap = plan.mergedSecs - plan.sumSecs;

  sel.innerHTML = "";
  const add = (value: MergeDurationMode, label: string, endAbs: number) => {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent =
      `${label} · ends ${mergePointLabel(endAbs, refDate)} (${formatDuration(endAbs - plan.startAbs)})`;
    sel.appendChild(opt);
  };

  add("span", "Cover the whole stretch", plan.endAbs);
  if (gap !== 0) add("compact", "Keep the tracked total", plan.compactEndAbs);

  sel.disabled = gap === 0;
  sel.title = gap === 0
    ? "These entries run back to back, so both readings give the same merge."
    : "";
  sel.value = "span";
}

/** Fills the notes dropdown. Which options exist depends on what notes are
 *  actually there: offering "keep the latest notes" when only one entry has any
 *  is a choice that isn't a choice. */
function fillMergeNotesSelect(ordered: Entry[]): void {
  const sel = document.getElementById("ttMergeNotes") as HTMLSelectElement;
  const withNotes = entriesWithNotes(ordered);
  const refDate = ordered[0] ? ordered[0].date : "";

  sel.innerHTML = "";
  const add = (value: string, label: string) => {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    sel.appendChild(opt);
  };

  if (withNotes.length === 0) {
    add("none", "No notes on these entries");
    sel.disabled = true;
    sel.value = "none";
    return;
  }

  sel.disabled = false;

  if (withNotes.length === 1) {
    add("combine", "Keep the one note there is");
  } else {
    add("combine", `Combine all ${withNotes.length} notes`);
    // Then one named option per noted entry. The time, activity and a snippet
    // are what make them tellable apart at a glance, and listing every one of
    // them is why no "earliest" / "latest" shorthand is needed.
    ordered.forEach((e, index) => {
      if (!e.notes.trim()) return;
      const when = mergePointLabel(entryStartAbs(e), refDate);
      const snippet = e.notes.trim().replace(/\s+/g, " ");
      const short = snippet.length > 40 ? `${snippet.slice(0, 40)}…` : snippet;
      add(`entry:${index}`, `Only ${when} ${e.activity} · "${short}"`);
    });
  }

  add("none", "Discard notes");
  sel.value = "combine";
}

function openMergeEntriesModal(list: Entry[], rerender: () => void): void {
  if (list.length < 2) { flash("Select at least two entries to merge", "error"); return; }
  mergeEntriesList = list;
  mergeEntriesRerender = rerender;

  const plan = computeMergePlan(list);

  setContextLines(document.getElementById("ttMergeEntriesContext")!, [
    `${list.length} entries into one`,
  ]);

  fillMergeDurationSelect(plan);
  refreshMergeSummary(plan);

  const fillSelect = (id: string, values: string[], emptyLabel: string) => {
    const sel = document.getElementById(id) as HTMLSelectElement;
    sel.innerHTML = "";
    values.forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name || emptyLabel;
      sel.appendChild(opt);
    });
    sel.selectedIndex = 0; // distinctByTime puts the biggest time sink first
  };
  fillSelect("ttMergeActivity", distinctByTime(list, "activity"), "(No Activity)");
  fillSelect("ttMergeProject", distinctByTime(list, "project"), "(No Project)");
  fillMergeNotesSelect(plan.ordered);

  const listEl = document.getElementById("ttMergeEntriesList")!;
  listEl.innerHTML = "";
  plan.ordered.forEach((e) => {
    const row = document.createElement("div");
    row.className = "tt-merge-list-row";

    const name = document.createElement("span");
    name.className = "tt-break-in-preview-name";
    name.textContent = e.project ? `${e.project} · ${e.activity}` : e.activity;
    name.title = name.textContent;

    const span = document.createElement("span");
    span.className = "tt-break-in-preview-span";
    span.textContent = `${formatDate(e.date)} ${formatTime(e.start)} → ${formatTime(e.end)}`;

    const dur = document.createElement("span");
    dur.className = "tt-break-in-preview-dur";
    dur.textContent = formatDuration(entryDurationSeconds(e));

    row.append(name, span, dur);
    listEl.appendChild(row);
  });

  getMergeEntriesModal().open();
}

/* =============================================================================
   MODAL: BULK DELETE CONFIRM
   Always confirms, even with Quick Delete on: that setting exists to skip a
   dialog for ONE row, and losing a whole selection is a different order of
   mistake.
============================================================================= */

let bulkDeleteModal: Modal | null = null;
let bulkDeleteList: Entry[] = [];
let bulkDeleteRerender: () => void = () => {};

function getBulkDeleteModal(): Modal {
  if (!bulkDeleteModal) {
    bulkDeleteModal = new Modal(document.getElementById("ttBulkDeleteBackdrop")!, {
      closeOnEsc: true,
      onClosed: () => { bulkDeleteList = []; },
    });

    document.getElementById("ttBulkDeleteCancelBtn")!.addEventListener("click", () => bulkDeleteModal!.close());

    document.getElementById("ttBulkDeleteConfirmBtn")!.addEventListener("click", async () => {
      const list = bulkDeleteList.filter((e) => entries.includes(e));
      if (list.length === 0) { bulkDeleteModal!.close(); return; }
      entries = entries.filter((e) => !list.includes(e));
      selectedEntries.clear();
      bulkDeleteModal!.close();
      bulkDeleteRerender();
      await saveToDisk();
      flash(`${list.length} entries deleted`, "success");
    });
  }
  return bulkDeleteModal;
}

function openBulkDeleteModal(list: Entry[], rerender: () => void): void {
  if (list.length === 0) return;
  bulkDeleteList = list;
  bulkDeleteRerender = rerender;
  const secs = list.reduce((sum, e) => sum + entryDurationSeconds(e), 0);
  document.getElementById("ttBulkDeleteMessage")!.textContent =
    `Delete ${list.length} entries (${formatDuration(secs)} in total)? This can't be undone.`;
  getBulkDeleteModal().open();
}

/* =============================================================================
   MODAL: DELETE CONFIRM
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
   MODAL: EDIT NOTES
   Notes get a dedicated modal (a plain multi-line textarea) rather than the
   inline entry-edit-input used by the other columns, multi-line text
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

/** Fills a modal's context block with one line per string, built via
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
   MODAL: EDIT DATES
   Launched from each row's calendar icon. Lets Start Date and End Date be
   edited independently. End Date must be on or after Start Date, and the
   resulting span must still be a positive duration given the entry's times.
============================================================================= */

let dateEditModal: Modal | null = null;
let dateEditEntry: Entry | null = null;
let dateEditRerender: () => void = () => {};
// Staged Start/End Time, initialized from the entry when the modal opens and
// only written back to the entry on Update, see makeDateEditTimeEditable's
// doc comment for why these can't just write straight to dateEditEntry.
let dateEditStagedStart = "";
let dateEditStagedEnd = "";

/** Double-click-to-edit for the Start/End Time values shown (read-only,
 *  until now) in the Edit Dates modal. It's a bit silly to show them next to
 *  editable dates and not let you fix them too, especially since a date
 *  change can put them in conflict. Mirrors the Entries panel's inline time
 *  edit's normalizeTime() parsing, but does NOT validate or save immediately
 *  the way that inline edit does: this modal's date fields are themselves
 *  only staged until Update, so checking the edited time against the
 *  entry's still-unstaged dates would reject perfectly valid combinations
 *  (e.g. changing 8am-12pm on 8/6 to 8am-7am spanning 8/6-8/7, typing the
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
      if (!newStart || !newEnd) { flash("Both dates are required", "error"); return; }
      if (newEnd < newStart) { flash("End date cannot be before Start date", "error"); return; }
      if (entryDurationSeconds({ date: newStart, start: dateEditStagedStart, endDate: newEnd, end: dateEditStagedEnd }) < 0) {
        flash("End time must be after Start time. Check the dates.", "error");
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
   VIEW: PRESET / DATE RANGE HELPERS
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

  document.querySelectorAll("#tracking-tool-time-tracker .preset-btn").forEach((btn) => {
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
  document.querySelectorAll("#tracking-tool-time-tracker .preset-btn").forEach((b) => b.classList.remove("active"));
  if (matched) {
    document.querySelectorAll("#tracking-tool-time-tracker .preset-btn").forEach((btn) => {
      if ((btn as HTMLElement).dataset.preset === matched) btn.classList.add("active");
    });
  }
}

function shiftDate(dateStr: string, delta: string): string {
  const d = new Date(dateStr + "T00:00:00");
  const sign = delta.startsWith("+") ? 1 : -1;
  const unit = delta.replace(/[+-]/, "");
  if (unit === "day") d.setDate(d.getDate() + sign);
  return localDay(d);
}

/* =============================================================================
   INIT: EXPORTED ENTRY POINT
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

  // Block keystrokes that could never be part of a valid time, letters
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
    // Whether the clock is "running" is exactly the state the duration preview
    // already recomputes on, so piggy-backing here means every path that
    // touches a time field (Now buttons, typing, blur, Clear, draft restore)
    // keeps the Break In button honest for free.
    refreshBreakInUI();
  }
  function doApplyPreset(preset: string) {
    applyPreset(preset, viewStartInput, viewEndInput, entriesDiv, dayTotalDiv, groupTotalsDiv, statsDiv);
  }
  // Keeps the visible End Date field in sync with the same overnight-roll
  // convenience Add Entry applies (see endDateManuallySet doc comment), so
  // the form shows the date the entry will actually get before you submit.
  // No-ops once End Date has been touched directly. Called whenever Start
  // Date changes and whenever the user leaves a time field (see the blur
  // listeners below). The same moments the draft gets saved.
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
  // "Now" button (which also sets Start Date to today), keeps both paths
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
     EVENT LISTENERS: INPUT PANEL
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
    // "Now" is an explicit, real end date, treat it like the user picked
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
     EVENT LISTENERS: BREAK IN / RESUME
     See the LIVE BREAK-IN section for what these are for.
  -------------------------------------------------------------------------- */

  /** Files whatever the form is holding as an entry that ends right now.
   *  Returns the task that got filed, or null if the form wasn't a runnable
   *  session (clock never started, or the work has no name yet). */
  async function commitRunningSession(): Promise<PausedTask | null> {
    const start = normalizeTime(startInput.value.trim());
    if (!start) { flash("Start the clock first", "error"); return null; }

    // No lastActivity fallback here, unlike Add Entry. On these two paths the
    // whole point is that you have MOVED to something else, so silently
    // reusing the previous name would file a duplicate of the very task you
    // just walked away from.
    const activity = activityInput.value.trim();
    if (!activity) {
      flash("Name what you're working on first", "error");
      activityInput.focus();
      return null;
    }

    const project = projectInput.value.trim();
    const notes = notesInput.value.trim();
    // "Now" is a real, explicit end date. Flag it so the overnight auto-roll
    // doesn't second-guess it (see endDateManuallySet).
    endDateManuallySet = true;
    const ok = await addEntry(
      start, normalizeTime(nowTimeString()), project, activity, notes, today(),
      datePicker, endDatePicker, projectInput, activityInput, startInput, endInput, notesInput,
      entriesDiv, dayTotalDiv, groupTotalsDiv, statsDiv, durationPreview,
    );
    if (!ok) { endDateManuallySet = false; return null; }
    return { project, activity, notes };
  }

  /** Leaves the form on a fresh session that is already running: clock started
   *  at now, end open. Pass a task to reload one, or null for a blank slate. */
  function startFreshSession(task: PausedTask | null): void {
    projectInput.value = task?.project ?? "";
    activityInput.value = task?.activity ?? "";
    notesInput.value = task?.notes ?? "";
    datePicker.value = today();
    selectedDate = today();
    startInput.value = nowTimeString();
    endInput.value = "";
    endDateManuallySet = false;
    endDatePicker.value = today();
    endDatePicker.min = today();
    doUpdateDurationPreview();
    doSaveDraft();
  }

  document.getElementById("ttBreakInNowBtn")!.addEventListener("click", async () => {
    const filed = await commitRunningSession();
    if (!filed) return;
    settings.pausedTasks.push(filed);
    saveSettings();
    startFreshSession(null);
    activityInput.focus();
    flash(`"${filed.activity}" logged and paused, clock restarted`, "success");
  });

  document.getElementById("ttResumeBtn")!.addEventListener("click", async () => {
    const stack = settings.pausedTasks;
    const paused = stack[stack.length - 1];
    if (!paused) return;

    // A running session gets filed first. Resume means "the detour is done",
    // not "throw away whatever I've been doing since I broke away".
    const runningStart = normalizeTime(startInput.value.trim());
    const running = !!runningStart && !endInput.value.trim();
    if (running) {
      if (activityInput.value.trim()) {
        if (!(await commitRunningSession())) return;
      } else {
        // Unnamed. Under a minute it's a mis-click on Break In and dropping it
        // costs nothing; any longer and it's real time that would vanish
        // without a trace, so ask for a name rather than eat it.
        const elapsed =
          dateToDayIndex(today()) * 86400 + parseTime(normalizeTime(nowTimeString()))
          - (dateToDayIndex(datePicker.value || today()) * 86400 + parseTime(runningStart));
        if (elapsed >= 60) {
          flash("Name what you're on now so it gets logged, or Clear the form", "error");
          activityInput.focus();
          return;
        }
      }
    }

    stack.pop();
    saveSettings();
    startFreshSession(paused);
    flash(`Back on "${paused.activity}"`, "success");
  });

  /* -------------------------------------------------------------------------
     EVENT LISTENERS: SUMMARY PANEL TABS
  -------------------------------------------------------------------------- */

  document
    .querySelectorAll<HTMLButtonElement>(".tt-summary-tabs .tt-summary-tab")
    .forEach((btn) => {
      btn.addEventListener("click", () => {
        // The cast below can't vouch for the attribute actually being there,
        // so check before trusting it rather than passing undefined on.
        const tab = btn.dataset.ttSummaryTab;
        if (!tab) return;
        activateSummaryTab(tab as TTSummaryTab);
      });
    });

  /* -------------------------------------------------------------------------
     EVENT LISTENERS: BULK SELECTION
  -------------------------------------------------------------------------- */

  document.getElementById("ttSelectModeBtn")!.addEventListener("click", () => {
    setSelectMode(!selectMode);
  });

  document.getElementById("ttSelectAllBtn")!.addEventListener("click", () => {
    lastVisible.forEach((e) => selectedEntries.add(e));
    doRender();
  });

  document.getElementById("ttSelectNoneBtn")!.addEventListener("click", () => {
    selectedEntries.clear();
    lastCheckedEntry = null;
    doRender();
  });

  document.getElementById("ttBulkCloneBtn")!.addEventListener("click", () => {
    cloneEntries(selectedInOrder());
  });

  document.getElementById("ttBulkMergeBtn")!.addEventListener("click", () => {
    openMergeEntriesModal(selectedInOrder(), doRender);
  });

  document.getElementById("ttBulkDeleteBtn")!.addEventListener("click", () => {
    openBulkDeleteModal(selectedInOrder(), doRender);
  });

  /* -------------------------------------------------------------------------
     EVENT LISTENERS: CONTROLS PANEL
  -------------------------------------------------------------------------- */

  document.querySelectorAll("#tracking-tool-time-tracker .preset-btn").forEach((btn) => {
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
     EVENT LISTENERS: TT SETTINGS ROWS (in shell settings modal)
  -------------------------------------------------------------------------- */

  // Note: shell.ts owns the dateFormatToggle label and saves the setting.
  // TT listens for the change event only to re-render entries in the new format.
  document.getElementById("dateFormatToggle")!.addEventListener("change", (e) => {
    settings.americanDates = (e.target as HTMLInputElement).checked;
    doRender();
  });

  // Same story for Time Format (12h/24h), shell.ts owns the toggle/label and
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

  document.getElementById("breakInMinutesToggle")!.addEventListener("change", (e) => {
    settings.breakInUseMinutes = (e.target as HTMLInputElement).checked;
    document.getElementById("breakInMinutesLabel")!.textContent =
      settings.breakInUseMinutes ? "On" : "Off";
    saveSettings();
    // The Break-In modal is never open at the same time as Setup, so there is
    // nothing on screen to re-render here; the next open reads the new mode.
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
     EVENT LISTENERS: TT SETUP MODAL
     Modal instantiation/tabs/Reset live at module level (getTTSetupModal) so
     the Activity Add/Edit modals can reopen Setup on the Activities tab.
  -------------------------------------------------------------------------- */

  document.getElementById("ttSetupBtn")!.addEventListener("click", () => openTTSetupOnTab("projects"));
  document.getElementById("ttActivityNewBtn")!.addEventListener("click", openActivityAdd);
  document.getElementById("ttProjectNewBtn")!.addEventListener("click", openProjectAdd);
  document.getElementById("ttCsvImportBtn")!.addEventListener("click", openCsvImportModal);

  /* -------------------------------------------------------------------------
     EVENT LISTENERS: TT-OWNED MODALS (delete confirm only)
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
    activateSummaryTab(activeSummaryTab);
    refreshBreakInUI();
    doApplyPreset("today");
  });
}
