/* =============================================================================
   COUNTDOWN
   -----------------------------------------------------------------------------
   A countdown timer built to be looked at by other people. The driving case is
   a break in a screen-shared meeting: set 10 minutes, share this window, walk
   away and do something else, and the people watching keep seeing an accurate
   countdown the whole time. It doubles as a Pomodoro timer, since every run
   carries a memo and lands in a log that can be pushed into the Time Tracker.

   Architecture notes:
     • THE CLOCK IS AN ABSOLUTE TIMESTAMP, NOT A DECREMENTING NUMBER. A session
       stores `endsAt` in epoch ms, and every paint computes remaining as
       endsAt - Date.now(). Nothing accumulates, so nothing can drift: a paint
       that arrives late shows the correct smaller number rather than a stale
       larger one. It also means closing the app mid-countdown and reopening it
       resumes at the right time instead of where it left off.
     • THE REPAINT IS DRIVEN FROM RUST. Correctness doesn't depend on it (see
       above), but liveness does, and this tool's entire premise is a window
       that is visible to an audience while unfocused and very likely occluded
       by whatever the user is actually doing. Chromium treats an occluded
       window as a hidden page and clamps its timers to about one wake-up per
       minute, which is precisely the frozen-countdown failure the user hit in
       other timer apps. src-tauri/src/tools/countdown.rs emits "countdown-tick"
       from an OS thread instead.
     • Pausing shifts `endsAt` forward by however long the pause lasted, which
       keeps the single-source-of-truth timestamp model intact rather than
       introducing a second "remaining" field that could disagree with it.
     • Completion is detected in the paint, not scheduled. Whatever wakes the
       paint up (a tick, a tab switch, coming back from sleep) is also what
       notices the clock has run out, so there's no separate alarm timer that
       could be throttled into firing late.
     • The duration has no input fields of its own: the clock IS the field,
       edited by double-clicking it. One number on screen, one place to change
       it, and nothing to disagree with what's displayed.

   Rust commands used:
     save_countdown_data, load_countdown_data,
     countdown_start_ticker, countdown_stop_ticker
============================================================================= */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import {
  flash, escapeHtml, isToolVisible, getSoundOptions, resolveSoundUrl, playSoundUrl,
} from "../shell";
import { Modal } from "../modal";
import { addTimeTrackerEntry } from "./time-tracker";

/* =============================================================================
   TYPES
============================================================================= */

/** The one in-flight countdown, or null. Persisted, so it survives a restart. */
interface CountdownSession {
  memo: string;
  /** What the user asked for, kept for the log even after extensions. */
  plannedMs: number;
  startedAt: number;
  /** Epoch ms the countdown reaches zero. Shifts when paused or extended. */
  endsAt: number;
  /** Epoch ms the current pause began, or null when running. */
  pausedAt: number | null;
  /** Accumulated paused time, so the log can report real elapsed vs. planned. */
  pausedMs: number;
  /** Set once the alarm has fired, so it fires exactly once per session even
   *  though completion is re-detected on every paint. */
  finished: boolean;
}

interface CountdownLogEntry {
  id: string;
  memo: string;
  plannedMs: number;
  startedAt: number;
  endedAt: number;
  pausedMs: number;
  outcome: "completed" | "stopped";
  /** True once this entry has been pushed into the Time Tracker, so it can't
   *  be double-logged. */
  logged: boolean;
}

interface CountdownPreset {
  id: string;
  label: string;
  seconds: number;
}

type ProgressStyle = "none" | "bar" | "ring" | "hourglass";
type ClockFormat = "colon" | "units";
type DisplayMode = "brief" | "partial" | "full";
/** What a duration typed as a plain number means. */
type BareUnit = "seconds" | "minutes" | "hours";

interface CountdownSettings {
  progressStyle: ProgressStyle;
  clockFormat: ClockFormat;
  /** How much of the clock is shown when the leading units are zero:
   *  "brief" drops every zero unit above the largest non-zero one, "partial"
   *  drops only the hours, "full" always shows all three. */
  displayMode: DisplayMode;
  /** What "90" means when typed into a duration field. */
  bareUnit: BareUnit;
  showTrackerLog: boolean;
  /** "<packId>:<kind>", where an empty pack id follows the app's active pack.
   *  "none" is silent. */
  soundId: string;
  soundRepeats: number;
  /** Milliseconds between the START of each repeat. Shorter than the clip
   *  itself means they overlap, which is the point for cues with long silent
   *  tails. */
  soundGapMs: number;
}

interface CountdownStore {
  session: CountdownSession | null;
  log: CountdownLogEntry[];
  settings: CountdownSettings | null;
  presets: CountdownPreset[] | null;
  /** The duration sitting on the clock while idle, so it survives a restart. */
  lastDurationMs: number | null;
}

/* =============================================================================
   CONSTANTS
============================================================================= */

/** Fast enough that the displayed seconds turn over on time for viewers. */
const TICK_MS = 250;

const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
const MAX_LOG_ENTRIES = 200;

const DEFAULT_DURATION_MS = 10 * 60 * 1000;

const MAX_SOUND_REPEATS = 20;
/** Floor on the spacing between repeats. Below this the repeats stop reading
 *  as separate pings and just pile into one smeared noise. */
const MIN_SOUND_GAP_MS = 150;
const MAX_SOUND_GAP_MS = 5_000;

const BARE_UNIT_MS: Record<BareUnit, number> = {
  seconds: 1000,
  minutes: 60_000,
  hours: 3_600_000,
};

const RING_STROKE = 6;
const RING_RADIUS = 18;

const DEFAULT_SETTINGS: CountdownSettings = {
  progressStyle: "bar",
  clockFormat: "colon",
  displayMode: "brief",
  bareUnit: "minutes",
  showTrackerLog: true,
  soundId: ":success",
  soundRepeats: 1,
  soundGapMs: 400,
};

function defaultPresets(): CountdownPreset[] {
  return [
    { id: "p5", label: "5 min", seconds: 300 },
    { id: "p10", label: "10 min", seconds: 600 },
    { id: "p15", label: "15 min", seconds: 900 },
    { id: "p25", label: "25 min", seconds: 1500 },
    { id: "p30", label: "30 min", seconds: 1800 },
    { id: "p60", label: "1 hour", seconds: 3600 },
  ];
}

const TIME_TRACKER_KEY = "utility/time-tracker";

/* =============================================================================
   STATE
============================================================================= */

let session: CountdownSession | null = null;
let log: CountdownLogEntry[] = [];
let cdSettings: CountdownSettings = { ...DEFAULT_SETTINGS };
let presets: CountdownPreset[] = defaultPresets();

/** Duration on the clock while idle, what Start will use. */
let pendingDurationMs = DEFAULT_DURATION_MS;

let storeLoaded = false;

/** Generation of the Rust ticker currently repainting us; -1 when stopped. */
let tickerGeneration = -1;

/** Bumped whenever an alarm should stop, ending a session, or starting a new
 *  one. A repeat loop that finds its token stale abandons the rest. */
let alarmToken = 0;

let pendingClearLog = false;

/** Preset being edited in the Presets modal, or null when adding. */
let editingPresetId: string | null = null;

let ringLength = 0;

/* =============================================================================
   ELEMENT REFS
============================================================================= */

let memoInput: HTMLInputElement;
let startBtn: HTMLButtonElement;
let pauseBtn: HTMLButtonElement;
let stopBtn: HTMLButtonElement;
let clockEl: HTMLElement;
let clockEditInput: HTMLInputElement;
let clockHintEl: HTMLElement;
let clockWrap: HTMLElement;
let clockMemoEl: HTMLElement;
let startedAtEl: HTMLElement;
let endingAtEl: HTMLElement;
let setupPanel: HTMLElement;
let runningPanel: HTMLElement;
let extendRow: HTMLElement;
let presetsRow: HTMLElement;
let logListEl: HTMLElement;
let logEmptyEl: HTMLElement;

let barWrap: HTMLElement;
let barEl: HTMLElement;
let ringSvg: SVGSVGElement;
let ringTrack: SVGRectElement;
let ringProgress: SVGRectElement;
let hourglassSvg: SVGSVGElement;
let hgTopSand: SVGRectElement;
let hgBottomSand: SVGRectElement;
let hgTopClipPath: SVGPathElement;
let hgBottomClipPath: SVGPathElement;
let hgFramePath: SVGPathElement;
let hgStream: SVGGElement;
let hgStreamRect: SVGRectElement;

let soundSelect: HTMLSelectElement;
let soundRepeatsInput: HTMLInputElement;
let soundGapInput: HTMLInputElement;
let showTrackerToggle: HTMLInputElement;
let trackerNoteEl: HTMLElement;
let presetLabelInput: HTMLInputElement;
let presetDurationInput: HTMLInputElement;
let presetSaveBtn: HTMLButtonElement;
let presetCancelBtn: HTMLButtonElement;
let presetListEl: HTMLElement;

let clearLogModal: Modal | null = null;
let setupModal: Modal | null = null;
let presetsModal: Modal | null = null;

/* =============================================================================
   PERSISTENCE
============================================================================= */

async function loadStore(): Promise<void> {
  try {
    const raw = await invoke<string>("load_countdown_data");
    const parsed = JSON.parse(raw) as Partial<CountdownStore>;
    log = Array.isArray(parsed.log) ? parsed.log.filter(isValidLogEntry) : [];
    session = isValidSession(parsed.session) ? parsed.session : null;
    cdSettings = normalizeSettings(parsed.settings ?? {});
    presets = Array.isArray(parsed.presets) && parsed.presets.length > 0
      ? parsed.presets.filter(isValidPreset)
      : defaultPresets();
    if (typeof parsed.lastDurationMs === "number" && parsed.lastDurationMs > 0) {
      pendingDurationMs = Math.min(MAX_DURATION_MS, parsed.lastDurationMs);
    }
  } catch (err) {
    flash(`Couldn't load Countdown Timer data: ${String(err)}`, "error");
  } finally {
    storeLoaded = true;
  }

  applySettingsToForm();
  refreshBareUnitHints();
  renderPresets();
  renderPresetList();
  renderLog();
  if (session) {
    memoInput.value = session.memo;
    if (session.pausedAt === null) void startTicker();
  }
  render();
}

async function saveStore(): Promise<void> {
  if (!storeLoaded) return;
  const store: CountdownStore = {
    session, log, settings: cdSettings, presets, lastDurationMs: pendingDurationMs,
  };
  try {
    await invoke("save_countdown_data", { data: JSON.stringify(store) });
  } catch (err) {
    flash(`Couldn't save Countdown Timer data: ${String(err)}`, "error");
  }
}

function normalizeSettings(raw: Partial<CountdownSettings>): CountdownSettings {
  const styles: ProgressStyle[] = ["none", "bar", "ring", "hourglass"];
  const units: BareUnit[] = ["seconds", "minutes", "hours"];

  const num = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fallback;

  // Sound ids gained a ":<kind>" suffix when error cues became pickable. A
  // stored id without one is from before that and meant the success cue.
  let soundId = typeof raw.soundId === "string" ? raw.soundId : DEFAULT_SETTINGS.soundId;
  if (soundId !== "none" && !soundId.includes(":")) soundId = `${soundId}:success`;

  return {
    progressStyle: styles.includes(raw.progressStyle as ProgressStyle)
      ? (raw.progressStyle as ProgressStyle)
      : DEFAULT_SETTINGS.progressStyle,
    clockFormat: raw.clockFormat === "units" ? "units" : "colon",
    displayMode: raw.displayMode === "full" || raw.displayMode === "partial" ? raw.displayMode : "brief",
    bareUnit: units.includes(raw.bareUnit as BareUnit)
      ? (raw.bareUnit as BareUnit)
      : DEFAULT_SETTINGS.bareUnit,
    showTrackerLog: raw.showTrackerLog !== false,
    soundId,
    soundRepeats: Math.min(MAX_SOUND_REPEATS, Math.max(1, num(raw.soundRepeats, DEFAULT_SETTINGS.soundRepeats))),
    soundGapMs: Math.min(
      MAX_SOUND_GAP_MS,
      Math.max(MIN_SOUND_GAP_MS, num(raw.soundGapMs, DEFAULT_SETTINGS.soundGapMs)),
    ),
  };
}

function isValidSession(s: unknown): s is CountdownSession {
  if (s === null || typeof s !== "object") return false;
  const c = s as CountdownSession;
  return (
    typeof c.memo === "string" &&
    Number.isFinite(c.plannedMs) &&
    Number.isFinite(c.startedAt) &&
    Number.isFinite(c.endsAt) &&
    (c.pausedAt === null || Number.isFinite(c.pausedAt)) &&
    Number.isFinite(c.pausedMs) &&
    typeof c.finished === "boolean"
  );
}

function isValidLogEntry(e: unknown): e is CountdownLogEntry {
  if (e === null || typeof e !== "object") return false;
  const c = e as CountdownLogEntry;
  return (
    typeof c.id === "string" &&
    typeof c.memo === "string" &&
    Number.isFinite(c.plannedMs) &&
    Number.isFinite(c.startedAt) &&
    Number.isFinite(c.endedAt)
  );
}

function isValidPreset(p: unknown): p is CountdownPreset {
  if (p === null || typeof p !== "object") return false;
  const c = p as CountdownPreset;
  return typeof c.id === "string" && typeof c.label === "string" &&
    Number.isFinite(c.seconds) && c.seconds > 0;
}

/* =============================================================================
   DURATION PARSING / FORMATTING
============================================================================= */

/** Parses a typed duration. Accepts unit form ("1h 30m", "90m", "45s") and
 *  colon form ("1:30:00", "10:00"). What a BARE number means is a setting (
 *  seconds, minutes or hours) because the sensible default depends entirely
 *  on what you use the tool for; the editor's hint reads it back so it's never
 *  a guess. Returns null on anything it can't read. */
export function parseDurationInput(raw: string, bareUnit: BareUnit = "minutes"): number | null {
  const text = raw.trim().toLowerCase();
  if (!text) return null;

  if (/[hms]/.test(text)) {
    let total = 0;
    let matched = false;
    const re = /(\d+(?:\.\d+)?)\s*([hms])/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      matched = true;
      const n = parseFloat(m[1]);
      total += n * (m[2] === "h" ? 3600 : m[2] === "m" ? 60 : 1);
    }
    // Guards against "abc" and against trailing junk that matched nothing.
    if (!matched || /[^0-9hms\s.]/.test(text)) return null;
    return Math.round(total * 1000);
  }

  const parts = text.split(":");
  if (parts.length > 3 || parts.some((p) => !/^\d+$/.test(p))) return null;
  const nums = parts.map(Number);
  if (nums.length === 1) return nums[0] * BARE_UNIT_MS[bareUnit];
  if (nums.length === 2) return (nums[0] * 60 + nums[1]) * 1000;
  return ((nums[0] * 60 + nums[1]) * 60 + nums[2]) * 1000;
}

/** parseDurationInput bound to the user's current bare-number setting. */
function parseDuration(raw: string): number | null {
  return parseDurationInput(raw, cdSettings.bareUnit);
}

function bareUnitWord(): string {
  return cdSettings.bareUnit;
}

/** Keeps the two places that explain the bare-number rule in step with the
 *  setting, a hint that contradicts the behaviour is worse than no hint. */
function refreshBareUnitHints(): void {
  const presetHint = document.getElementById("cd-preset-hint");
  if (presetHint) {
    presetHint.textContent =
      `Leave the label blank to name it after the duration. A bare number means ${bareUnitWord()}.`;
  }
  clockHintEl.textContent = `Enter, or Esc to cancel. A bare number means ${bareUnitWord()}.`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** The clock face. Rounds UP, so a display reading "1" still has up to a
 *  second on it, a clock showing 0 while time remains looks broken to anyone
 *  watching.
 *
 *  Three levels of disclosure, differing only in what they do with leading
 *  ZERO units. The digits themselves are always the same:
 *    brief:   drops every zero unit above the largest non-zero one, so
 *              10 minutes reads "10:00" and 45 seconds reads "45".
 *    partial, drops only the hours, so minutes are always on screen and
 *              45 seconds reads "00:45". The clock keeps a steady shape for
 *              anything under an hour, which brief doesn't.
 *    full:    always all three, "00:00:45".
 *  A unit never disappears from the middle in any of them.
 *
 *  Exported with its settings as arguments rather than reading module state so
 *  the rules can be exercised directly. */
export function formatClockFace(ms: number, format: ClockFormat, mode: DisplayMode): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const full = mode === "full";
  const partial = mode === "partial";

  if (format === "units") {
    const parts: string[] = [];
    if (full || h > 0) parts.push(`${h}h`);
    if (full || partial || h > 0 || m > 0) parts.push(`${m}m`);
    parts.push(`${s}s`);
    return parts.join(" ");
  }

  if (full) return `${pad(h)}:${pad(m)}:${pad(s)}`;
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  if (partial) return `${pad(m)}:${pad(s)}`;
  if (m > 0) return `${m}:${pad(s)}`;
  return String(s);
}

function formatClock(ms: number): string {
  return formatClockFace(ms, cdSettings.clockFormat, cdSettings.displayMode);
}

/** Compact duration for the log and preset labels ("25m", "1h 05m", "45s"). */
function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${pad(m)}m`;
  if (m > 0) return `${m}m ${pad(s)}s`;
  return `${s}s`;
}

function formatWallClock(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: "numeric", minute: "2-digit", second: "2-digit",
  });
}

function localDateIso(ts: number): string {
  const d = new Date(ts);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
}

function localTimeHms(ts: number): string {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => pad(n)).join(":");
}

/* =============================================================================
   SESSION MATH
============================================================================= */

/** Milliseconds left. While paused the clock is frozen at whatever it read
 *  when the pause began, so the number on screen doesn't quietly drain. */
function remainingMs(s: CountdownSession): number {
  return s.endsAt - (s.pausedAt ?? Date.now());
}

/** The span the progress figures measure against. Derived rather than stored
 *  so it stays right through both pauses (which push endsAt AND pausedMs by
 *  the same amount, cancelling out) and extensions (which push only endsAt,
 *  correctly growing the span). */
function spanMs(s: CountdownSession): number {
  return Math.max(1, s.endsAt - s.startedAt - s.pausedMs);
}

/* =============================================================================
   TICKER
============================================================================= */

async function startTicker(): Promise<void> {
  try {
    tickerGeneration = await invoke<number>("countdown_start_ticker", { intervalMs: TICK_MS });
  } catch (err) {
    // The countdown itself is still correct (it's read from the clock) so
    // this degrades to "the display only refreshes when something else
    // happens" rather than to a wrong timer.
    tickerGeneration = -1;
    flash(`Countdown Timer display may not refresh smoothly: ${String(err)}`, "error");
  }
}

async function stopTicker(): Promise<void> {
  tickerGeneration = -1;
  try {
    await invoke("countdown_stop_ticker");
  } catch {
    // A stray ticker only causes extra repaints, which are harmless.
  }
}

/* =============================================================================
   ALARM
============================================================================= */

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Plays the configured cue the configured number of times.
 *
 *  Spacing is measured from the START of each repeat, not from the end of the
 *  last one, which is what makes a gap shorter than the clip overlap them.
 *  That's deliberate: several of the packs have long silent tails, so waiting
 *  for `ended` would put seconds of nothing between beeps. Each firing gets
 *  its own Audio element, so overlapping plays actually stack instead of
 *  restarting one another. */
async function playAlarm(): Promise<void> {
  if (cdSettings.soundId === "none") return;
  const url = resolveSoundUrl(cdSettings.soundId);
  if (!url) return;

  const token = ++alarmToken;
  for (let i = 0; i < cdSettings.soundRepeats; i++) {
    if (token !== alarmToken) return;
    void playSoundUrl(url);
    if (i < cdSettings.soundRepeats - 1) await delay(cdSettings.soundGapMs);
  }
}

/** Cuts off a repeat sequence in progress, stopping a rung-out timer should
 *  stop the noise too. */
function silenceAlarm(): void {
  alarmToken++;
}

/* =============================================================================
   CONTROLS
============================================================================= */

async function startCountdown(): Promise<void> {
  if (pendingDurationMs <= 0) {
    flash("Set a duration first. Double-click the clock to type one.", "error");
    return;
  }
  if (pendingDurationMs > MAX_DURATION_MS) {
    flash("Countdown can't be longer than 24 hours.", "error");
    return;
  }

  silenceAlarm();
  const now = Date.now();
  session = {
    memo: memoInput.value.trim(),
    plannedMs: pendingDurationMs,
    startedAt: now,
    endsAt: now + pendingDurationMs,
    pausedAt: null,
    pausedMs: 0,
    finished: false,
  };

  await startTicker();
  render();
  void saveStore();
}

async function togglePause(): Promise<void> {
  if (!session) return;

  if (session.pausedAt === null) {
    session.pausedAt = Date.now();
    // A frozen clock has nothing to repaint.
    await stopTicker();
  } else {
    // Push the finish line back by exactly the paused duration, keeping endsAt
    // the single source of truth rather than tracking a separate remainder.
    const pausedFor = Date.now() - session.pausedAt;
    session.endsAt += pausedFor;
    session.pausedMs += pausedFor;
    session.pausedAt = null;
    await startTicker();
  }

  render();
  void saveStore();
}

async function extendBy(ms: number): Promise<void> {
  if (!session) return;
  await setEndsAt(session.endsAt + ms);
  flash(`Added ${formatDuration(ms)}`, "success");
}

/** Moves the finish line, handling the one non-obvious case: a countdown that
 *  had already rung becomes live again, which means un-finishing it, killing
 *  the alarm, and restarting the ticker that stopped when it ended. */
async function setEndsAt(ts: number): Promise<void> {
  if (!session) return;
  const wasFinished = session.finished;
  session.endsAt = ts;
  session.finished = false;
  silenceAlarm();
  if (wasFinished && session.pausedAt === null) await startTicker();
  render();
  void saveStore();
}

/** The next wall-clock boundary strictly after `fromTs`, :15/:30/:45/:00 for
 *  a 15-minute step, :30/:00 for a 30-minute one.
 *
 *  Computed from LOCAL clock components rather than by rounding epoch
 *  milliseconds. Those agree for whole-hour time zones, but not for the
 *  45-minute-offset ones: epoch half-hour boundaries land on local :15 and :45
 *  there, which is not what "the next half hour" means to anyone reading it. */
export function nextClockBoundary(fromTs: number, stepMinutes: number): number {
  const d = new Date(fromTs);
  d.setSeconds(0, 0);
  // setMinutes rolls into the next hour (and day) on its own, so 50 → 60 with
  // a 15-minute step lands on the top of the next hour without special-casing.
  d.setMinutes(Math.ceil(d.getMinutes() / stepMinutes) * stepMinutes);
  const ts = d.getTime();
  // Truncating the seconds can leave the "next" boundary at or behind where we
  // started, e.g. 2:15:00.400 truncates to 2:15:00.000, which has passed.
  return ts > fromTs ? ts : ts + stepMinutes * 60_000;
}

/** Snaps the countdown's end to the next quarter- or half-hour on the clock.
 *  Built for the meeting case: "back at half past" is a thing people say, and
 *  it beats doing the arithmetic to find the right number of minutes to add. */
async function roundEndTo(stepMinutes: number): Promise<void> {
  if (!session || session.pausedAt !== null) return;
  const target = nextClockBoundary(session.endsAt, stepMinutes);
  await setEndsAt(target);
  flash(`Ending at ${formatWallClock(target)}`, "success");
}

/** Ends the session and files it in the log. */
async function endSession(outcome: "completed" | "stopped"): Promise<void> {
  if (!session) return;

  silenceAlarm();

  // Running to zero announces itself from ring(). A manual Stop clears the
  // panel and files the session into the history log, which is the same amount
  // of state change with none of the noise, so it says so here.
  if (outcome === "stopped") {
    flash(
      `Stopped with ${formatDuration(remainingMs(session))} left, saved to history`,
      "success",
    );
  }

  // A completed run's real end is when the clock hit zero, not when the code
  // noticed. Those differ if the app was closed or asleep at the time.
  const endedAt = outcome === "completed" ? session.endsAt : Date.now();

  log.unshift({
    id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    memo: session.memo,
    plannedMs: session.plannedMs,
    startedAt: session.startedAt,
    endedAt,
    pausedMs: session.pausedMs,
    outcome,
    logged: false,
  });
  if (log.length > MAX_LOG_ENTRIES) log.length = MAX_LOG_ENTRIES;

  session = null;
  await stopTicker();
  renderLog();
  render();
  void saveStore();
}

/** Fires once when the clock reaches zero. The session stays on screen showing
 *  zero so the room can see it landed; the user clears it with Done. */
function ring(): void {
  if (!session || session.finished) return;
  session.finished = true;

  const label = session.memo ? `"${session.memo}"` : "Countdown Timer";
  // Silent toast: the alarm below is the sound for this event, and the toast's
  // own cue would land on top of it as an extra, unasked-for repeat.
  flash(`${label} finished`, "success", 8000, true);
  void playAlarm();
  // The whole point is that nobody is looking at this window, including,
  // often, the person who set it.
  void getCurrentWindow().requestUserAttention(UserAttentionType.Critical).catch(() => {});
  void saveStore();
}

/* =============================================================================
   CLOCK EDITING
   -----------------------------------------------------------------------------
   Double-clicking the clock turns it into the duration field. There is no
   separate h/m/s row: one number on screen, one place to change it.
============================================================================= */

function openClockEditor(): void {
  if (session) return; // no editing a live countdown, extend it instead
  refreshBareUnitHints();
  clockEditInput.value = formatClock(pendingDurationMs);
  clockEl.style.display = "none";
  clockEditInput.style.display = "";
  clockHintEl.style.display = "";
  clockEditInput.focus();
  clockEditInput.select();
}

function closeClockEditor(commit: boolean): void {
  if (clockEditInput.style.display === "none") return;

  if (commit) {
    const parsed = parseDuration(clockEditInput.value);
    if (parsed === null) {
      flash(`Couldn't read that duration. Try 25m, 1:30:00, or a plain number of ${bareUnitWord()}.`, "error");
    } else if (parsed <= 0) {
      flash("Duration has to be more than zero", "error");
    } else if (parsed > MAX_DURATION_MS) {
      flash("Countdown can't be longer than 24 hours.", "error");
    } else {
      pendingDurationMs = parsed;
      void saveStore();
    }
  }

  clockEditInput.style.display = "none";
  clockHintEl.style.display = "none";
  clockEl.style.display = "";
  render();
}

/* =============================================================================
   PROGRESS FIGURES
============================================================================= */

/** Exact perimeter of a rounded rectangle: the four straightaways plus the
 *  four quarter-circles, which together make one full circle of radius r.
 *  Used as a fallback for getTotalLength(), which returns 0 on an element that
 *  hasn't been laid out yet. */
export function roundedRectPerimeter(w: number, h: number, r: number): number {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  return 2 * (w - 2 * rr) + 2 * (h - 2 * rr) + 2 * Math.PI * rr;
}

/** Sizes the ring's geometry from the clock wrapper's real pixel box. Doing it
 *  in JS rather than with a scaled viewBox is what keeps the stroke an even
 *  width all the way round, a viewBox stretched to a wide, short box would
 *  squash the stroke on one axis and mangle the corners with it. */
function layoutRing(): void {
  const w = clockWrap.clientWidth;
  const h = clockWrap.clientHeight;
  if (w <= RING_STROKE || h <= RING_STROKE) {
    ringLength = 0;
    return;
  }

  const rectW = w - RING_STROKE;
  const rectH = h - RING_STROKE;
  // Never let the corner radius exceed half the shorter side, which would
  // otherwise produce a shape the browser silently clamps and a perimeter that
  // no longer matches what's drawn.
  const radius = Math.max(0, Math.min(RING_RADIUS, rectW / 2, rectH / 2));

  // viewBox only, width/height come from CSS (inset:0), and setting both
  // would be two sources of truth for the same box.
  ringSvg.setAttribute("viewBox", `0 0 ${w} ${h}`);

  [ringTrack, ringProgress].forEach((rect) => {
    rect.setAttribute("x", String(RING_STROKE / 2));
    rect.setAttribute("y", String(RING_STROKE / 2));
    rect.setAttribute("width", String(rectW));
    rect.setAttribute("height", String(rectH));
    rect.setAttribute("rx", String(radius));
    rect.setAttribute("ry", String(radius));
    rect.setAttribute("stroke-width", String(RING_STROKE));
  });

  const measured = ringProgress.getTotalLength?.() ?? 0;
  ringLength = measured > 0 ? measured : roundedRectPerimeter(rectW, rectH, radius);
  ringProgress.style.strokeDasharray = String(ringLength);
}

/* ── Hourglass ─────────────────────────────────────────────────────────────── */

/* The glass is drawn from one profile function and the sand level is solved
   against that same function, so the outline you see and the fill inside it
   can't drift apart. Everything below is in the SVG's own 40x80 viewBox. */

const HG_CX = 20; // centre line
const HG_RIM_HALF_W = 14; // half-width where a bulb meets its cap
const HG_BULB_H = 31; // neck-to-rim height of one bulb
const HG_TOP_NECK_Y = 38;
const HG_BOTTOM_NECK_Y = 42;

/** Half-width of a bulb as a fraction of HG_RIM_HALF_W. `t` runs 0 at the neck
 *  to 1 at the rim. The rational S-curve holds a narrow throat, flares out
 *  quickly, then flattens to a near-cylindrical rim, which is the silhouette a
 *  real hourglass has. It also matters for the sand: in a cone the level races
 *  at the wide end and crawls at the point, whereas here it moves at close to a
 *  steady rate through the tall middle stretch where the eye is watching it. */
const HG_NECK_W = 0.12;
const HG_FLARE = 0.18;
function hgHalfWidth(t: number): number {
  const s = (t * t) / (t * t + HG_FLARE * (1 - t) * (1 - t));
  return HG_NECK_W + (1 - HG_NECK_W) * s;
}

/** Cumulative bulb area from the neck up, sampled once at module load. Index
 *  `i` holds the area below `i / HG_SAMPLES` of the neck-to-rim height. */
const HG_SAMPLES = 512;
const hgCumulativeArea: number[] = (() => {
  const cum = [0];
  for (let i = 1; i <= HG_SAMPLES; i++) {
    const lo = hgHalfWidth((i - 1) / HG_SAMPLES);
    const hi = hgHalfWidth(i / HG_SAMPLES);
    cum.push(cum[i - 1] + ((lo + hi) / 2) * (1 / HG_SAMPLES));
  }
  return cum;
})();

/** Inverse of the area curve: how tall a column of sand standing on the neck
 *  has to be to hold `fraction` of one bulb. Sand transfers at a constant rate
 *  by volume, not by level, so this is what keeps the figure honest, the level
 *  has to move faster where the glass is narrow and slower where it's wide. */
export function hgHeightForArea(fraction: number): number {
  const target = Math.min(1, Math.max(0, fraction)) * hgCumulativeArea[HG_SAMPLES];
  let lo = 0;
  let hi = HG_SAMPLES;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (hgCumulativeArea[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0) return 0;
  // Interpolate within the straddling slice, otherwise the level visibly steps
  // between samples on a long timer.
  const span = hgCumulativeArea[lo] - hgCumulativeArea[lo - 1];
  const p = span > 0 ? (target - hgCumulativeArea[lo - 1]) / span : 0;
  return ((lo - 1 + p) / HG_SAMPLES) * HG_BULB_H;
}

/** Traces one bulb: down one side from rim to neck, across, back up the other.
 *  `dir` is -1 for the top bulb, whose rim sits above its neck, +1 for the
 *  bottom. Straight segments are fine at this sample count, the figure renders
 *  around 60px wide and each step is well under a pixel. */
function hgBulbPath(neckY: number, dir: -1 | 1): string {
  const steps = 48;
  const left: string[] = [];
  const right: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const y = (neckY + dir * t * HG_BULB_H).toFixed(2);
    const w = HG_RIM_HALF_W * hgHalfWidth(t);
    left.push(`${(HG_CX - w).toFixed(2)},${y}`);
    right.push(`${(HG_CX + w).toFixed(2)},${y}`);
  }
  left.reverse();
  return `M${left.join("L")}L${right.join("L")}Z`;
}

/** Paints the outline and the two clip shapes. Called once from init: the
 *  figure lives in a fixed viewBox, so unlike the ring it owes nothing to the
 *  element's pixel size. */
function layoutHourglass(): void {
  const top = hgBulbPath(HG_TOP_NECK_Y, -1);
  const bottom = hgBulbPath(HG_BOTTOM_NECK_Y, 1);
  hgTopClipPath.setAttribute("d", top);
  hgBottomClipPath.setAttribute("d", bottom);

  // The bulbs stop short of each other, so the frame carries the throat that
  // joins them.
  const throat = (HG_RIM_HALF_W * HG_NECK_W).toFixed(2);
  const left = (HG_CX - Number(throat)).toFixed(2);
  const right = (HG_CX + Number(throat)).toFixed(2);
  hgFramePath.setAttribute(
    "d",
    `${top}${bottom}` +
      `M${left},${HG_TOP_NECK_Y}L${left},${HG_BOTTOM_NECK_Y}` +
      `M${right},${HG_TOP_NECK_Y}L${right},${HG_BOTTOM_NECK_Y}`,
  );
}

/** Paints whichever progress figure is selected. `fraction` is time REMAINING,
 *  1 → 0, so every figure empties as the clock runs down. `flowing` is whether
 *  the clock is actually moving right now, which only the hourglass cares
 *  about: sand shouldn't pour while the timer sits paused or finished. */
function renderProgress(fraction: number, flowing = false): void {
  const style = cdSettings.progressStyle;
  const f = Math.min(1, Math.max(0, fraction));

  barWrap.style.display = style === "bar" ? "" : "none";
  ringSvg.style.display = style === "ring" ? "" : "none";
  hourglassSvg.style.display = style === "hourglass" ? "" : "none";

  if (style === "bar") {
    barEl.style.width = `${f * 100}%`;
  } else if (style === "ring") {
    if (ringLength === 0) layoutRing();
    ringProgress.style.strokeDashoffset = String(ringLength * (1 - f));
  } else if (style === "hourglass") {
    // Sand moves at a constant rate by area, so the level is the inverse of the
    // bulb's area curve rather than a straight multiple of `f`. Both bulbs are
    // the same shape, which is what makes one number do for both: the column
    // already drained off the top is exactly as tall as the gap still unfilled
    // at the bottom, so the two always read as halves of the same whole.
    const level = hgHeightForArea(f);
    hgTopSand.setAttribute("y", String(HG_TOP_NECK_Y - level));
    hgTopSand.setAttribute("height", String(level));
    hgBottomSand.setAttribute("y", String(HG_BOTTOM_NECK_Y + level));
    hgBottomSand.setAttribute("height", String(HG_BULB_H - level));

    // The stream runs from the throat to whatever the pile below has reached,
    // so it starts out long and shortens as the bottom fills. Grains keep
    // falling at a fixed rate the whole time; it's the drop that gets shorter,
    // which is the same thing the real object does.
    hgStream.style.display = flowing ? "" : "none";
    if (flowing) {
      hgStreamRect.setAttribute("height", String(HG_BOTTOM_NECK_Y + level - HG_TOP_NECK_Y));
    }
  }
}

/* =============================================================================
   RENDER
============================================================================= */

function render(): void {
  const active = session !== null;
  setupPanel.style.display = active ? "none" : "";
  runningPanel.style.display = active ? "" : "none";
  extendRow.style.display = active ? "" : "none";
  startBtn.style.display = active ? "none" : "";
  pauseBtn.style.display = active ? "" : "none";
  stopBtn.style.display = active ? "" : "none";

  // Updated on both paths: the dot has to go out when a session ends, not just
  // come on when one starts.
  document
    .querySelector<HTMLElement>('.nav-item[data-tool="countdown"]')
    ?.classList.toggle("cd-running", active && session!.pausedAt === null && remainingMs(session!) > 0);

  if (!session) {
    // Idle: the clock shows the pending duration, so it doubles as the field
    // you'll edit and the preview of what Start will use.
    clockEl.textContent = formatClock(pendingDurationMs);
    clockEl.classList.remove("cd-clock-done", "cd-clock-paused");
    clockEl.classList.add("cd-clock-editable");
    // Otherwise the finished session's memo lingers over the setup form.
    clockMemoEl.style.display = "none";
    renderProgress(1);
    return;
  }

  const remaining = remainingMs(session);

  // Completion is noticed here rather than on a schedule, so whatever woke the
  // paint (a tick, a resume from sleep, the app reopening) is also what
  // notices the clock ran out.
  if (remaining <= 0 && !session.finished) ring();

  clockEl.textContent = formatClock(remaining);
  clockEl.classList.remove("cd-clock-editable");
  clockEl.classList.toggle("cd-clock-done", remaining <= 0);
  clockEl.classList.toggle("cd-clock-paused", session.pausedAt !== null);

  clockMemoEl.textContent = session.memo;
  clockMemoEl.style.display = session.memo ? "" : "none";

  startedAtEl.textContent = formatWallClock(session.startedAt);
  endingAtEl.textContent = formatWallClock(session.endsAt);

  pauseBtn.textContent = session.pausedAt !== null ? "Resume" : "Pause";
  // Nothing left to pause once it has rung; extending is the way back.
  pauseBtn.disabled = remaining <= 0 && session.pausedAt === null;
  stopBtn.textContent = remaining <= 0 ? "Done" : "Stop";

  // Rounding is meaningless while paused, resuming pushes endsAt forward by
  // the pause duration, which would walk the end straight back off the mark.
  const paused = session.pausedAt !== null;
  document.querySelectorAll<HTMLButtonElement>(".cd-round-btn").forEach((btn) => {
    btn.disabled = paused;
    const step = Number(btn.dataset.step);
    btn.title = paused
      ? "Resume the countdown to round its end time"
      : `End at ${formatWallClock(nextClockBoundary(session!.endsAt, step))}`;
  });

  renderProgress(remaining / spanMs(session), !paused && remaining > 0);
}

/** The quick-pick buttons under the memo field, rebuilt from saved presets. */
function renderPresets(): void {
  presetsRow.innerHTML = "";
  presets.forEach((preset) => {
    const btn = document.createElement("button");
    btn.className = "cd-preset-btn toggle-btn";
    btn.textContent = preset.label || formatDuration(preset.seconds * 1000);
    btn.title = formatDuration(preset.seconds * 1000);
    btn.addEventListener("click", () => {
      pendingDurationMs = preset.seconds * 1000;
      render();
      void saveStore();
    });
    presetsRow.appendChild(btn);
  });
}

function renderLog(): void {
  logEmptyEl.style.display = log.length === 0 ? "" : "none";
  logListEl.innerHTML = "";

  // Hidden either because the user turned it off, or because the Time Tracker
  // itself is hidden, offering a hand-off to a tool they've put away would be
  // a dead end.
  const trackerAvailable = isToolVisible(TIME_TRACKER_KEY);
  const showTrack = cdSettings.showTrackerLog && trackerAvailable;

  log.forEach((entry) => {
    const row = document.createElement("div");
    row.className = "cd-log-row";

    const actualMs = entry.endedAt - entry.startedAt - entry.pausedMs;
    const meta = [
      `${formatWallClock(entry.startedAt)} → ${formatWallClock(entry.endedAt)}`,
      `${formatDuration(actualMs)} of ${formatDuration(entry.plannedMs)}`,
    ];
    if (entry.pausedMs > 1000) meta.push(`paused ${formatDuration(entry.pausedMs)}`);
    if (entry.outcome === "stopped") meta.push("stopped early");

    row.innerHTML = `
      <div class="cd-log-info">
        <span class="cd-log-memo">${escapeHtml(entry.memo || "(no memo)")}</span>
        <span class="cd-log-meta">${escapeHtml(meta.join(" · "))}</span>
      </div>
      <div class="cd-log-actions">
        ${showTrack ? `<button class="cd-log-track">${entry.logged ? "Logged ✓" : "Log to Time Tracker"}</button>` : ""}
        <button class="cd-log-delete modal-cancel-btn" title="Remove from history">✕</button>
      </div>`;

    const trackBtn = row.querySelector<HTMLButtonElement>(".cd-log-track");
    if (trackBtn) {
      trackBtn.disabled = entry.logged;
      trackBtn.addEventListener("click", () => void logToTimeTracker(entry));
    }

    row.querySelector<HTMLButtonElement>(".cd-log-delete")!.addEventListener("click", () => {
      log = log.filter((e) => e.id !== entry.id);
      renderLog();
      void saveStore();
    });

    logListEl.appendChild(row);
  });
}

/* =============================================================================
   TIME TRACKER HAND-OFF
============================================================================= */

async function logToTimeTracker(entry: CountdownLogEntry): Promise<void> {
  if (entry.logged) return;
  if (!entry.memo.trim()) {
    // The Time Tracker keys everything off the activity name, so an unnamed
    // session has nothing to file itself under.
    flash("Give the session a memo before logging it. It becomes the activity name.", "error");
    return;
  }

  // A Time Tracker entry is a start time and an end time. It has no way to
  // represent a gap in the middle, so a paused session lands there as one
  // unbroken span. The note says so rather than letting the number quietly
  // overstate the work.
  const noteBits = [`Countdown Timer: ${formatDuration(entry.plannedMs)} planned`];
  if (entry.outcome === "stopped") noteBits.push("stopped early");
  if (entry.pausedMs > 1000) noteBits.push(`includes ${formatDuration(entry.pausedMs)} paused`);

  try {
    // Goes through the Time Tracker's own API rather than writing its file:
    // its entries are live module state, so a direct write would be clobbered
    // by its next save. See addTimeTrackerEntry.
    await addTimeTrackerEntry({
      date: localDateIso(entry.startedAt),
      start: localTimeHms(entry.startedAt),
      endDate: localDateIso(entry.endedAt),
      end: localTimeHms(entry.endedAt),
      activity: entry.memo.trim(),
      notes: noteBits.join(" · "),
    });
  } catch (err) {
    flash(`Couldn't add the Time Tracker entry: ${String(err)}`, "error");
    return;
  }

  entry.logged = true;
  renderLog();
  void saveStore();
  flash(`Logged "${entry.memo}" to Time Tracker.`, "success");
}

/* =============================================================================
   SETUP MODAL
============================================================================= */

function segValue(groupId: string, fallback: string): string {
  return document.querySelector<HTMLElement>(`#${groupId} .toggle-btn.active`)?.dataset.value ?? fallback;
}

function setSegValue(groupId: string, value: string): void {
  document.querySelectorAll<HTMLButtonElement>(`#${groupId} .toggle-btn`).forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.value === value);
  });
}

function getSetupModal(): Modal {
  if (!setupModal) {
    setupModal = new Modal(document.getElementById("cd-setup-backdrop")!, {
      onOpen: () => {
        applySettingsToForm();
        syncSetupUI();
      },
    });
    document.getElementById("cd-setup-close")!.addEventListener("click", () => setupModal!.close());

    document
      .querySelectorAll<HTMLButtonElement>(
        "#cd-progress-style .toggle-btn, #cd-clock-format .toggle-btn, " +
        "#cd-display-mode .toggle-btn, #cd-bare-unit .toggle-btn",
      )
      .forEach((btn) => {
        btn.addEventListener("click", () => {
          btn.parentElement!.querySelectorAll<HTMLButtonElement>(".toggle-btn")
            .forEach((b) => b.classList.toggle("active", b === btn));
          commitSettings();
        });
      });

    showTrackerToggle.addEventListener("change", commitSettings);
    soundSelect.addEventListener("change", commitSettings);
    soundRepeatsInput.addEventListener("change", commitSettings);
    soundGapInput.addEventListener("change", commitSettings);

    document.getElementById("cd-sound-test")!.addEventListener("click", () => void playAlarm());

    document.getElementById("cd-setup-reset")!.addEventListener("click", () => {
      cdSettings = { ...DEFAULT_SETTINGS };
      applySettingsToForm();
      syncSetupUI();
      // The ring's geometry only exists while it's the chosen style, so a
      // style change has to invalidate it rather than reuse a stale length.
      ringLength = 0;
      render();
      renderLog();
      void saveStore();
      flash("Countdown Timer settings reset", "success");
    });
  }
  return setupModal;
}

function commitSettings(): void {
  cdSettings = normalizeSettings({
    progressStyle: segValue("cd-progress-style", "bar") as ProgressStyle,
    clockFormat: segValue("cd-clock-format", "colon") as ClockFormat,
    displayMode: segValue("cd-display-mode", "brief") as DisplayMode,
    bareUnit: segValue("cd-bare-unit", "minutes") as BareUnit,
    showTrackerLog: showTrackerToggle.checked,
    soundId: soundSelect.value,
    soundRepeats: parseInt(soundRepeatsInput.value, 10),
    soundGapMs: parseInt(soundGapInput.value, 10),
  });

  // Push the clamped numbers back into the boxes. The min/max attributes only
  // bind the spinner arrows (a typed 500 stays 500 in the field) so without
  // this the box would keep showing a value the app isn't actually using.
  soundRepeatsInput.value = String(cdSettings.soundRepeats);
  soundGapInput.value = String(cdSettings.soundGapMs);

  ringLength = 0;
  syncSetupUI();
  refreshBareUnitHints();
  render();
  renderLog();
  void saveStore();
}

function applySettingsToForm(): void {
  setSegValue("cd-progress-style", cdSettings.progressStyle);
  setSegValue("cd-clock-format", cdSettings.clockFormat);
  setSegValue("cd-display-mode", cdSettings.displayMode);
  setSegValue("cd-bare-unit", cdSettings.bareUnit);
  showTrackerToggle.checked = cdSettings.showTrackerLog;
  soundSelect.value = cdSettings.soundId;
  soundRepeatsInput.value = String(cdSettings.soundRepeats);
  soundGapInput.value = String(cdSettings.soundGapMs);
}

/** Derived Setup state, currently just the Time Tracker dependency. */
function syncSetupUI(): void {
  const trackerAvailable = isToolVisible(TIME_TRACKER_KEY);
  // Greyed out rather than hidden: the setting still exists and comes back on
  // its own the moment the Time Tracker is unhidden, so saying why beats
  // making the row vanish.
  showTrackerToggle.disabled = !trackerAvailable;
  trackerNoteEl.textContent = trackerAvailable
    ? "Adds a per-session button that files it as a Time Tracker entry."
    : "Unavailable: Time Tracker is hidden in Settings › Sidebar.";
}

/** Every cue in every pack (success AND error) plus a silent option. The
 *  "App pack" entries at the top track whatever the app's sound pack is set
 *  to, rather than pinning a specific one. */
function populateSoundOptions(): void {
  soundSelect.innerHTML = "";

  const silent = document.createElement("option");
  silent.value = "none";
  silent.textContent = "Silent";
  soundSelect.appendChild(silent);

  getSoundOptions().forEach((opt) => {
    const el = document.createElement("option");
    el.value = opt.id;
    el.textContent = opt.name;
    soundSelect.appendChild(el);
  });
}

/* =============================================================================
   PRESETS MODAL
============================================================================= */

function getPresetsModal(): Modal {
  if (!presetsModal) {
    presetsModal = new Modal(document.getElementById("cd-presets-backdrop")!, {
      onOpen: renderPresetList,
      onClosed: cancelPresetEdit,
    });
    document.getElementById("cd-presets-close")!.addEventListener("click", () => presetsModal!.close());
    presetSaveBtn.addEventListener("click", savePresetFromForm);
    presetCancelBtn.addEventListener("click", cancelPresetEdit);
    presetDurationInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        savePresetFromForm();
      }
    });
    document.getElementById("cd-presets-reset")!.addEventListener("click", () => {
      presets = defaultPresets();
      cancelPresetEdit();
      renderPresetList();
      renderPresets();
      void saveStore();
      flash("Default presets restored", "success");
    });
  }
  return presetsModal;
}

function savePresetFromForm(): void {
  const ms = parseDuration(presetDurationInput.value);
  if (ms === null || ms <= 0) {
    flash(`Couldn't read that duration. Try 25m, 1:30:00, or a plain number of ${bareUnitWord()}.`, "error");
    return;
  }
  if (ms > MAX_DURATION_MS) {
    flash("Preset can't be longer than 24 hours.", "error");
    return;
  }

  const seconds = Math.round(ms / 1000);
  // A blank label names itself after the duration, so adding a preset can be
  // a single field.
  const label = presetLabelInput.value.trim() || formatDuration(ms);

  if (editingPresetId) {
    const existing = presets.find((p) => p.id === editingPresetId);
    if (existing) {
      existing.label = label;
      existing.seconds = seconds;
    }
    flash(`Updated "${label}".`, "success");
  } else {
    presets.push({
      id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      label,
      seconds,
    });
    flash(`Added "${label}".`, "success");
  }

  cancelPresetEdit();
  renderPresetList();
  renderPresets();
  void saveStore();
}

function beginPresetEdit(preset: CountdownPreset): void {
  editingPresetId = preset.id;
  presetLabelInput.value = preset.label;
  presetDurationInput.value = formatDuration(preset.seconds * 1000);
  presetSaveBtn.textContent = "Save";
  presetCancelBtn.style.display = "";
  presetLabelInput.focus();
  renderPresetList();
}

function cancelPresetEdit(): void {
  editingPresetId = null;
  presetLabelInput.value = "";
  presetDurationInput.value = "";
  presetSaveBtn.textContent = "Add";
  presetCancelBtn.style.display = "none";
  renderPresetList();
}

function movePreset(id: string, delta: number): void {
  const index = presets.findIndex((p) => p.id === id);
  const target = index + delta;
  if (index === -1 || target < 0 || target >= presets.length) return;
  const [item] = presets.splice(index, 1);
  presets.splice(target, 0, item);
  renderPresetList();
  renderPresets();
  void saveStore();
}

function renderPresetList(): void {
  presetListEl.innerHTML = "";

  if (presets.length === 0) {
    const empty = document.createElement("p");
    empty.className = "placeholder-text";
    empty.textContent = "No presets. Add one above, or restore the defaults.";
    presetListEl.appendChild(empty);
    return;
  }

  presets.forEach((preset, index) => {
    const row = document.createElement("div");
    row.className = "cd-preset-row";
    if (preset.id === editingPresetId) row.classList.add("cd-preset-editing");

    row.innerHTML = `
      <div class="cd-preset-info">
        <span class="cd-preset-name">${escapeHtml(preset.label)}</span>
        <span class="cd-preset-duration">${escapeHtml(formatDuration(preset.seconds * 1000))}</span>
      </div>
      <div class="cd-preset-actions">
        <button class="cd-preset-up modal-cancel-btn" title="Move up">↑</button>
        <button class="cd-preset-down modal-cancel-btn" title="Move down">↓</button>
        <button class="cd-preset-edit modal-cancel-btn" title="Edit">Edit</button>
        <button class="cd-preset-remove modal-cancel-btn" title="Remove">✕</button>
      </div>`;

    const up = row.querySelector<HTMLButtonElement>(".cd-preset-up")!;
    const down = row.querySelector<HTMLButtonElement>(".cd-preset-down")!;
    up.disabled = index === 0;
    down.disabled = index === presets.length - 1;
    up.addEventListener("click", () => movePreset(preset.id, -1));
    down.addEventListener("click", () => movePreset(preset.id, 1));

    row.querySelector<HTMLButtonElement>(".cd-preset-edit")!
      .addEventListener("click", () => beginPresetEdit(preset));
    row.querySelector<HTMLButtonElement>(".cd-preset-remove")!.addEventListener("click", () => {
      const label = preset.label || formatDuration(preset.seconds * 1000);
      presets = presets.filter((p) => p.id !== preset.id);
      if (editingPresetId === preset.id) cancelPresetEdit();
      renderPresetList();
      renderPresets();
      void saveStore();
      flash(`Deleted "${label}"`, "success");
    });

    presetListEl.appendChild(row);
  });
}

/* =============================================================================
   CLEAR-HISTORY CONFIRM
============================================================================= */

function getClearLogModal(): Modal {
  if (!clearLogModal) {
    clearLogModal = new Modal(document.getElementById("cd-clear-backdrop")!, {
      onClosed: () => { pendingClearLog = false; },
    });
    document.getElementById("cd-clear-cancel")!.addEventListener("click", () => clearLogModal!.close());
    document.getElementById("cd-clear-confirm")!.addEventListener("click", () => {
      if (pendingClearLog) {
        log = [];
        renderLog();
        void saveStore();
        flash("History cleared", "success");
      }
      clearLogModal!.close();
    });
  }
  return clearLogModal;
}

/* =============================================================================
   INIT
============================================================================= */

export function initCountdown(): void {
  memoInput = document.getElementById("cd-memo") as HTMLInputElement;
  startBtn = document.getElementById("cd-start-btn") as HTMLButtonElement;
  pauseBtn = document.getElementById("cd-pause-btn") as HTMLButtonElement;
  stopBtn = document.getElementById("cd-stop-btn") as HTMLButtonElement;
  clockEl = document.getElementById("cd-clock")!;
  clockEditInput = document.getElementById("cd-clock-edit") as HTMLInputElement;
  clockHintEl = document.getElementById("cd-clock-hint")!;
  clockWrap = document.getElementById("cd-clock-wrap")!;
  clockMemoEl = document.getElementById("cd-clock-memo")!;
  startedAtEl = document.getElementById("cd-started-at")!;
  endingAtEl = document.getElementById("cd-ending-at")!;
  setupPanel = document.getElementById("cd-setup-panel")!;
  runningPanel = document.getElementById("cd-running-panel")!;
  extendRow = document.getElementById("cd-extend-row")!;
  presetsRow = document.getElementById("cd-presets")!;
  logListEl = document.getElementById("cd-log-list")!;
  logEmptyEl = document.getElementById("cd-log-empty")!;

  barWrap = document.getElementById("cd-bar-wrap")!;
  barEl = document.getElementById("cd-bar")!;
  ringSvg = document.getElementById("cd-ring") as unknown as SVGSVGElement;
  ringTrack = document.getElementById("cd-ring-track") as unknown as SVGRectElement;
  ringProgress = document.getElementById("cd-ring-progress") as unknown as SVGRectElement;
  hourglassSvg = document.getElementById("cd-hourglass") as unknown as SVGSVGElement;
  hgTopSand = document.getElementById("cd-hg-top-sand") as unknown as SVGRectElement;
  hgBottomSand = document.getElementById("cd-hg-bottom-sand") as unknown as SVGRectElement;
  hgTopClipPath = document.getElementById("cd-hg-top-clip-path") as unknown as SVGPathElement;
  hgBottomClipPath = document.getElementById("cd-hg-bottom-clip-path") as unknown as SVGPathElement;
  hgFramePath = document.getElementById("cd-hg-frame") as unknown as SVGPathElement;
  hgStream = document.getElementById("cd-hg-stream") as unknown as SVGGElement;
  hgStreamRect = document.getElementById("cd-hg-stream-rect") as unknown as SVGRectElement;
  layoutHourglass();

  soundSelect = document.getElementById("cd-sound") as HTMLSelectElement;
  soundRepeatsInput = document.getElementById("cd-sound-repeats") as HTMLInputElement;
  soundGapInput = document.getElementById("cd-sound-gap") as HTMLInputElement;
  showTrackerToggle = document.getElementById("cd-show-tracker") as HTMLInputElement;
  trackerNoteEl = document.getElementById("cd-tracker-note")!;
  presetLabelInput = document.getElementById("cd-preset-label") as HTMLInputElement;
  presetDurationInput = document.getElementById("cd-preset-duration") as HTMLInputElement;
  presetSaveBtn = document.getElementById("cd-preset-save") as HTMLButtonElement;
  presetCancelBtn = document.getElementById("cd-preset-cancel") as HTMLButtonElement;
  presetListEl = document.getElementById("cd-preset-list")!;

  populateSoundOptions();

  /* ── Clock as the duration field ── */
  clockEl.addEventListener("dblclick", openClockEditor);
  clockEditInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      closeClockEditor(true);
    } else if (e.key === "Escape") {
      // Stopped here so it can't reach the modal stack behind this view.
      e.preventDefault();
      e.stopPropagation();
      closeClockEditor(false);
    }
  });
  clockEditInput.addEventListener("blur", () => closeClockEditor(true));

  /* ── Extend ── */
  document.querySelectorAll<HTMLButtonElement>(".cd-extend-btn").forEach((btn) => {
    btn.addEventListener("click", () => void extendBy(Number(btn.dataset.seconds) * 1000));
  });

  document.querySelectorAll<HTMLButtonElement>(".cd-round-btn").forEach((btn) => {
    btn.addEventListener("click", () => void roundEndTo(Number(btn.dataset.step)));
  });

  startBtn.addEventListener("click", () => void startCountdown());
  pauseBtn.addEventListener("click", () => void togglePause());
  stopBtn.addEventListener("click", () => {
    if (!session) return;
    void endSession(remainingMs(session) <= 0 ? "completed" : "stopped");
  });

  memoInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !session) {
      e.preventDefault();
      void startCountdown();
    }
  });

  document.getElementById("cd-setup-btn")!.addEventListener("click", () => getSetupModal().open());
  document.getElementById("cd-presets-btn")!.addEventListener("click", () => getPresetsModal().open());

  document.getElementById("cd-clear-log-btn")!.addEventListener("click", () => {
    if (log.length === 0) {
      flash("History is already empty", "error");
      return;
    }
    pendingClearLog = true;
    getClearLogModal().open();
  });

  /* ── Repaint ── */
  listen<number>("countdown-tick", (event) => {
    if (event.payload !== tickerGeneration) return;
    render();
  }).catch(() => {});

  // Belt and braces around the Rust ticker: coming back to a visible window
  // repaints immediately rather than waiting up to one tick, which matters
  // most in the one case the ticker can't help with, a machine resuming from
  // sleep with a countdown that expired while it was out.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") render();
  });

  // Hiding the Time Tracker has to withdraw the hand-off immediately, not on
  // next entry. The log may well be on screen when it happens.
  window.addEventListener("sidebarchange", () => {
    renderLog();
    if (setupModal?.isOpen) syncSetupUI();
  });

  // The ring is measured from the clock wrapper's real box, so anything that
  // resizes it (window, font scale, a longer clock string) invalidates the
  // cached geometry.
  new ResizeObserver(() => {
    if (cdSettings.progressStyle !== "ring") return;
    layoutRing();
    render();
  }).observe(clockWrap);

  render();
  void loadStore();
}
