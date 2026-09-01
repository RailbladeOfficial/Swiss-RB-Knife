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
import { registerTransferable } from "../core/data-transfer";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import {
  flash, escapeHtml, isToolVisible, getSoundOptions, resolveSoundUrl, playSoundUrl,
  settings,
} from "../core/shell";
import { Modal, ModalTabs } from "../modal/modal";
import { attachMenu } from "../menu/menu";
import {
  setSeasonalCanvasElevated, isThemeEffectRunning, themeHasTitleGlow, applyDisplaySurface,
} from "../theme/theme-core";
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
/** Every ProgressStyle, for validating stored values. Module-level because the
 *  timer and the Display View each keep one now and both have to check it. */
const PROGRESS_STYLES: ProgressStyle[] = ["none", "bar", "ring", "hourglass"];
/** The Setup modal's two tabs: how the timer behaves, and how it looks on a
 *  shared screen. */
type CdSetupTab = "timer" | "display";
type ClockFormat = "colon" | "units";
type DisplayMode = "brief" | "partial" | "full";
/** What a duration typed as a plain number means. */
type BareUnit = "seconds" | "minutes" | "hours";

interface CountdownSettings {
  progressStyle: ProgressStyle;
  clockFormat: ClockFormat;
  /** Id of the face the clock digits are drawn in; see CLOCK_FONTS. Stored as
   *  an id rather than a font stack so the stacks can be corrected in a later
   *  build without rewriting everyone's saved settings. */
  clockFont: string;
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

/** Appearance of the Display View overlay. Deliberately kept OUT of
 *  CountdownSettings: this is how the tool looks on someone else's screen, not
 *  how the timer behaves, and the two are reset independently.
 *
 *  Mirrors the TTS Repeater's TtsDisplaySettings field for field, because the
 *  two overlays are the same object wearing different content and a user who
 *  has set one up should find the other one already familiar. The three
 *  `show*` flags are the only additions, and they exist because a countdown
 *  card has more than one thing on it. */
interface CountdownDisplaySettings {
  /** "theme" tracks the active app theme; "custom" uses bgColor/textColor. */
  look: "theme" | "custom";
  bgColor: string;
  textColor: string;
  align: "left" | "center" | "right";
  /** Rendered clock size in px. Everything else on the card is sized in `em`
   *  against it, so this one number scales the whole thing. */
  fontSize: number;
  /** Keep the glow the active theme puts on its header titles. Theme look
   *  only: "custom" picks two exact colors and is flat by definition. */
  glow: boolean;
  /** Let a running seasonal effect (Christmas snow, Halloween lightning,
   *  Patriot fireworks) play OVER the overlay instead of behind it. Doesn't
   *  start an effect that's off. */
  animate: boolean;
  /** Show the session memo under the clock. */
  showMemo: boolean;
  /** Show the wall-clock time the countdown ends at. "Back at half past" is
   *  the thing people actually say, and it's readable from further away than
   *  a shrinking number. */
  showEndsAt: boolean;
  /** The card's own progress figure, set independently of the timer's. The
   *  two are looked at from different distances and answer different
   *  questions: the panel is a control surface a foot from your face, the card
   *  is glanced at from across a room or through a screen share, and the
   *  figure that reads best there is rarely the one you want beside the
   *  controls. "none" leaves the card as clock and nothing else. */
  progressStyle: ProgressStyle;
  /** Put Pause/Stop on the card itself, so a shared screen can be driven
   *  without dropping back to the app. Off by default: the overlay's whole
   *  premise is a screen with nothing on it but the clock, so app chrome
   *  appearing there has to be asked for. */
  showControls: boolean;
}

interface CountdownStore {
  session: CountdownSession | null;
  log: CountdownLogEntry[];
  settings: CountdownSettings | null;
  presets: CountdownPreset[] | null;
  /** The duration sitting on the clock while idle, so it survives a restart. */
  lastDurationMs: number | null;
  display: CountdownDisplaySettings | null;
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

/* Ring stroke. The figure is drawn three times over now, at three very
   different scales (the inline clock, the full-window Display View, the
   postage-stamp Setup preview), so one fixed width would be a hoop on the
   smallest and a hairline on the largest. It is derived from the shorter side
   of the box instead, which keeps the ring reading as the same ring at all
   three sizes.

   The per-figure ceiling is what preserves the inline clock exactly as it was:
   its box has always been well past 100px on the short side, so the ratio
   would give it ~10px where it has always had 6. The two display figures cap
   far higher, i.e. effectively not at all, so the ratio governs both and they
   stay proportional to each other. */
const RING_STROKE_MIN = 2;
const RING_STROKE_RATIO = 0.06;
/** What the clock panel's ring has always been drawn at. */
const RING_STROKE_MAX_INLINE = 6;
/** High enough to leave the Display View and its preview to the ratio. */
const RING_STROKE_MAX_DISPLAY = 14;
const RING_RADIUS = 18;

function ringStrokeFor(w: number, h: number, max: number): number {
  return Math.max(RING_STROKE_MIN, Math.min(max, Math.min(w, h) * RING_STROKE_RATIO));
}

/* ── Clock faces ───────────────────────────────────────────────────────────
   Windows-installed families only. This app ships no font files and the
   WebView has no network access at runtime, so a web font would silently fall
   back to the stack behind it and the picker would be lying about what it
   does. Every entry names real faces plus a generic keyword, so the worst case
   on a stripped-down machine is the right CATEGORY of letterform.

   Ordered by how well they hold up as a clock read from across a room, not
   alphabetically: fixed-width faces first (digits that don't dance as they
   count down), then the condensed and heavy display faces, then the ordinary
   text families, with the app's own font last as the opt-out.
========================================================================== */

interface ClockFontDef {
  id: string;
  label: string;
  /** A font-family value. "inherit" is legal here and is what the app-font
   *  option uses, since it lands in a `font-family:` declaration verbatim. */
  stack: string;
}

const CLOCK_FONTS: ClockFontDef[] = [
  { id: "mono", label: "Cascadia Mono", stack: '"Cascadia Mono", Consolas, "Courier New", monospace' },
  { id: "consolas", label: "Consolas", stack: 'Consolas, "Cascadia Mono", "Courier New", monospace' },
  { id: "courier", label: "Courier New", stack: '"Courier New", Courier, monospace' },
  { id: "bahnschrift", label: "Bahnschrift", stack: 'Bahnschrift, "DIN Alternate", "Segoe UI", sans-serif' },
  { id: "impact", label: "Impact", stack: 'Impact, Haettenschweiler, "Arial Narrow", sans-serif' },
  { id: "franklin", label: "Franklin Gothic", stack: '"Franklin Gothic Medium", "Arial Narrow", Arial, sans-serif' },
  { id: "segoe", label: "Segoe UI", stack: '"Segoe UI", system-ui, sans-serif' },
  { id: "arial", label: "Arial", stack: 'Arial, Helvetica, sans-serif' },
  { id: "verdana", label: "Verdana", stack: 'Verdana, Geneva, sans-serif' },
  { id: "tahoma", label: "Tahoma", stack: 'Tahoma, Verdana, sans-serif' },
  { id: "trebuchet", label: "Trebuchet MS", stack: '"Trebuchet MS", Tahoma, sans-serif' },
  { id: "candara", label: "Candara", stack: 'Candara, Calibri, "Segoe UI", sans-serif' },
  { id: "georgia", label: "Georgia", stack: 'Georgia, "Times New Roman", serif' },
  { id: "times", label: "Times New Roman", stack: '"Times New Roman", Times, serif' },
  { id: "garamond", label: "Garamond", stack: 'Garamond, "Book Antiqua", Palatino, serif' },
  { id: "comic", label: "Comic Sans MS", stack: '"Comic Sans MS", "Comic Sans", cursive' },
  { id: "app", label: "App font", stack: "inherit" },
];

/** The stack for a font id, falling back to the default face for an id that
 *  isn't in the catalogue (an older data file, a hand-edited one). */
function clockFontStack(id: string): string {
  return (CLOCK_FONTS.find((f) => f.id === id) ?? CLOCK_FONTS[0]).stack;
}

const DISPLAY_FONT_MIN = 40;
const DISPLAY_FONT_MAX = 400;

/** How long the Display View exit button stays visible after the pointer last
 *  moved. Matches the TTS Repeater's overlay: long enough to aim for, short
 *  enough that an idle cursor doesn't leave app chrome sitting on a stream. */
const DISPLAY_EXIT_IDLE_MS = 2000;

const DEFAULT_DISPLAY: CountdownDisplaySettings = {
  look: "theme",
  bgColor: "#000000",
  textColor: "#ffffff",
  align: "center",
  // Bigger than the TTS Repeater's 72 because a clock is a handful of glyphs
  // where a message is a sentence: at 72 it would sit in the middle of an
  // otherwise empty screen.
  fontSize: 200,
  glow: true,
  animate: true,
  showMemo: true,
  showEndsAt: true,
  // Matches DEFAULT_SETTINGS.progressStyle, so a card left alone looks like
  // the panel it came from; it is simply no longer tied to it.
  progressStyle: "bar",
  showControls: false,
};

const DEFAULT_SETTINGS: CountdownSettings = {
  progressStyle: "bar",
  clockFormat: "colon",
  clockFont: "mono",
  displayMode: "brief",
  bareUnit: "minutes",
  showTrackerLog: true,
  // The timer's own long chime, rather than a notification cue doing double
  // duty as an alarm. One repeat: the chime already rings out on its own.
  soundId: "timer:timer-chime-long",
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

const TIME_TRACKER_KEY = "tracking/time-tracker";

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

/* ── Progress figures ──────────────────────────────────────────────────────
   The bar, the ring and the hourglass are drawn THREE times over: on the tool's
   own clock panel, on the Display View overlay, and in the Setup modal's
   preview of that overlay. All three show the same session in the same style,
   so rather than three copies of the drawing code there is one set of
   functions taking a ProgressFigure, which is just the element handles for one
   copy of the markup.

   Which style shows is the tool's one Progress Style setting in every case:
   the Display View follows the clock panel rather than having a preference of
   its own. Its "Progress figure" toggle only decides whether the card carries
   one at all.
========================================================================== */

interface ProgressFigure {
  /** The box the ring is measured against and drawn into. */
  clockWrap: HTMLElement;
  barWrap: HTMLElement;
  bar: HTMLElement;
  ring: SVGSVGElement;
  ringTrack: SVGRectElement;
  ringProgress: SVGRectElement;
  /** Cached perimeter of the ring path. 0 means "not measured yet", which is
   *  also how a resize or a settings change invalidates it. */
  ringLength: number;
  /** Ceiling on this figure's ring stroke; see the constants above. */
  ringStrokeMax: number;
  hourglass: SVGSVGElement;
  hgTopSand: SVGRectElement;
  hgBottomSand: SVGRectElement;
  hgTopClip: SVGPathElement;
  hgBottomClip: SVGPathElement;
  hgFrame: SVGPathElement;
  hgStream: SVGGElement;
  hgStreamRect: SVGRectElement;
}

let inlineFigure: ProgressFigure;
let displayFigure: ProgressFigure;
let previewFigure: ProgressFigure;

/** Every figure, for the operations that apply to all of them (invalidating
 *  the ring geometry, tracing the hourglass at init). */
function allFigures(): ProgressFigure[] {
  return [inlineFigure, displayFigure, previewFigure];
}

/** Forces every ring to be re-measured on its next paint. Called whenever
 *  something that changes a clock box's size or shape has happened. */
function invalidateRings(): void {
  allFigures().forEach((fig) => { fig.ringLength = 0; });
}

let display: CountdownDisplaySettings = { ...DEFAULT_DISPLAY };

let displayOpen = false;

/** Hides the Display View exit button once the pointer has been still. */
let displayExitTimer: ReturnType<typeof setTimeout> | null = null;

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
let clockMemoEl: HTMLElement;
let startedAtEl: HTMLElement;
let endingAtEl: HTMLElement;
let setupPanel: HTMLElement;
let runningPanel: HTMLElement;
let extendRow: HTMLElement;
let presetsRow: HTMLElement;
let logListEl: HTMLElement;
let logEmptyEl: HTMLElement;

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

let clockFontSelect: HTMLSelectElement;

let displayBtn: HTMLButtonElement;
let displayOverlay: HTMLElement;
let displayStack: HTMLElement;
let displayClockEl: HTMLElement;
let displayMemoEl: HTMLElement;
let displayEndsAtEl: HTMLElement;
let displayExitBtn: HTMLButtonElement;
let displayControls: HTMLElement;
let displayPauseBtn: HTMLButtonElement;
let displayStopBtn: HTMLButtonElement;

let displayBgInput: HTMLInputElement;
let displayFgInput: HTMLInputElement;
let displayCustomRow: HTMLElement;
let displayEffectsRow: HTMLElement;
let displayGlowToggle: HTMLInputElement;
let displayAnimateToggle: HTMLInputElement;
let glowNote: HTMLElement;
let animateNote: HTMLElement;
let displayMemoToggle: HTMLInputElement;
let displayEndsAtToggle: HTMLInputElement;
let displayControlsToggle: HTMLInputElement;
let displaySizeInput: HTMLInputElement;
let displaySizeValue: HTMLElement;
let displaySizeEntry: HTMLInputElement;
let displayPreview: HTMLElement;
let displayPreviewStack: HTMLElement;
let displayPreviewClock: HTMLElement;
let displayPreviewMemo: HTMLElement;
let displayPreviewEndsAt: HTMLElement;
let displayPreviewControls: HTMLElement;

let clearLogModal: Modal | null = null;
let setupModal: Modal | null = null;
let setupTabs: ModalTabs<CdSetupTab> | null = null;
let presetsModal: Modal | null = null;

/* =============================================================================
   PERSISTENCE
============================================================================= */

async function loadStore(): Promise<void> {
  try {
    const raw = await invoke<string>("load_tool_file", { toolId: "countdown", kind: "data" });
    const parsed = JSON.parse(raw) as Partial<CountdownStore>;
    log = Array.isArray(parsed.log) ? parsed.log.filter(isValidLogEntry) : [];
    session = isValidSession(parsed.session) ? parsed.session : null;
    cdSettings = normalizeSettings(parsed.settings ?? {});
    // After cdSettings, not beside it: migrating a pre-independence card needs
    // the timer style its figure used to borrow.
    display = normalizeDisplay(parsed.display ?? {}, cdSettings.progressStyle);
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
  applyClockFont();
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
    session, log, settings: cdSettings, presets, lastDurationMs: pendingDurationMs, display,
  };
  try {
    await invoke("save_tool_file", { toolId: "countdown", kind: "data", data: JSON.stringify(store) });
  } catch (err) {
    flash(`Couldn't save Countdown Timer data: ${String(err)}`, "error");
  }
}

function normalizeSettings(raw: Partial<CountdownSettings>): CountdownSettings {
  const units: BareUnit[] = ["seconds", "minutes", "hours"];

  const num = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fallback;

  // Sound ids gained a ":<kind>" suffix when error cues became pickable. A
  // stored id without one is from before that and meant the success cue.
  let soundId = typeof raw.soundId === "string" ? raw.soundId : DEFAULT_SETTINGS.soundId;
  if (soundId !== "none" && !soundId.includes(":")) soundId = `${soundId}:success`;

  return {
    progressStyle: PROGRESS_STYLES.includes(raw.progressStyle as ProgressStyle)
      ? (raw.progressStyle as ProgressStyle)
      : DEFAULT_SETTINGS.progressStyle,
    clockFormat: raw.clockFormat === "units" ? "units" : "colon",
    // An unknown id is treated as "not set" rather than kept: keeping it would
    // leave the picker blank and the clock silently on the fallback face.
    clockFont: CLOCK_FONTS.some((f) => f.id === raw.clockFont)
      ? (raw.clockFont as string)
      : DEFAULT_SETTINGS.clockFont,
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

/** Same job as normalizeSettings(), for the Display View appearance. The hex
 *  check is the load-bearing one: a color that isn't a color would silently
 *  blank an <input type="color"> and the Setup form would then write that
 *  blank straight back over the real value. */
function normalizeDisplay(
  raw: Partial<CountdownDisplaySettings> & { showProgress?: boolean },
  /** What the card's figure USED to borrow, for the migration below. */
  legacyStyle: ProgressStyle,
): CountdownDisplaySettings {
  const hex = (v: unknown, fallback: string): string =>
    typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v : fallback;

  const size = typeof raw.fontSize === "number" && Number.isFinite(raw.fontSize)
    ? Math.round(raw.fontSize)
    : DEFAULT_DISPLAY.fontSize;

  return {
    look: raw.look === "custom" ? "custom" : "theme",
    bgColor: hex(raw.bgColor, DEFAULT_DISPLAY.bgColor),
    textColor: hex(raw.textColor, DEFAULT_DISPLAY.textColor),
    align: raw.align === "left" || raw.align === "right" ? raw.align : "center",
    fontSize: Math.min(DISPLAY_FONT_MAX, Math.max(DISPLAY_FONT_MIN, size)),
    glow: raw.glow !== false,
    animate: raw.animate !== false,
    showMemo: raw.showMemo !== false,
    showEndsAt: raw.showEndsAt !== false,
    progressStyle: normalizeDisplayProgress(raw, legacyStyle),
    showControls: raw.showControls === true,
  };
}

/** The card's figure, with the one-way migration from the flag it replaced.
 *
 *  It used to be a plain on/off that borrowed the timer's Progress Style, so a
 *  stored file has `showProgress` and no `progressStyle`. Off becomes None; on
 *  becomes the style it was borrowing, which is exactly what was on the card
 *  last time it was opened. Neither branch can fire once a real style has been
 *  written, so the migration costs one comparison and then never runs again. */
function normalizeDisplayProgress(
  raw: Partial<CountdownDisplaySettings> & { showProgress?: boolean },
  legacyStyle: ProgressStyle,
): ProgressStyle {
  if (PROGRESS_STYLES.includes(raw.progressStyle as ProgressStyle)) {
    return raw.progressStyle as ProgressStyle;
  }
  if (raw.showProgress === false) return "none";
  if (raw.showProgress === true) return legacyStyle;
  return DEFAULT_DISPLAY.progressStyle;
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

/** Publishes the chosen face as --cd-clock-font on the document root, which is
 *  where every clock-shaped element in this tool reads it from: the inline
 *  clock, the duration editor it turns into, the Display View overlay and the
 *  Setup modal's preview.
 *
 *  Set once on the root rather than inline on four elements because two of
 *  those four (the overlay, the preview) live outside the tool view entirely,
 *  and because a variable is the only version of this that can't get out of
 *  step with itself. The name is tool-prefixed, so nothing else inherits it by
 *  accident. */
function applyClockFont(): void {
  document.documentElement.style.setProperty(
    "--cd-clock-font",
    clockFontStack(cdSettings.clockFont),
  );
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

/** A time of day for display. Follows the app's own 12/24-hour setting rather
 *  than the OS locale (toLocaleTimeString would ignore the setting entirely),
 *  and renders it the same way Time Tracker does, so the same moment reads
 *  identically in both tools. Read live from the shell's settings, so a change
 *  in App Settings lands on the next repaint. */
function formatWallClock(ts: number): string {
  const d = new Date(ts);
  const rest = `${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  if (!settings.hour12) return `${pad(d.getHours())}:${rest}`;

  let h = d.getHours();
  const suffix = h >= 12 ? "pm" : "am";
  if (h === 0) h = 12;
  else if (h > 12) h -= 12;
  return `${h}:${rest}${suffix}`;
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
function layoutRing(fig: ProgressFigure): void {
  const w = fig.clockWrap.clientWidth;
  const h = fig.clockWrap.clientHeight;
  const stroke = ringStrokeFor(w, h, fig.ringStrokeMax);
  // Also the case where the figure is not on screen yet (a hidden overlay, a
  // closed modal), which measures zero. Left uncached, so the next paint after
  // it becomes visible measures it for real.
  if (w <= stroke || h <= stroke) {
    fig.ringLength = 0;
    return;
  }

  const rectW = w - stroke;
  const rectH = h - stroke;
  // Never let the corner radius exceed half the shorter side, which would
  // otherwise produce a shape the browser silently clamps and a perimeter that
  // no longer matches what's drawn.
  const radius = Math.max(0, Math.min(RING_RADIUS, rectW / 2, rectH / 2));

  // viewBox only, width/height come from CSS (inset:0), and setting both
  // would be two sources of truth for the same box.
  fig.ring.setAttribute("viewBox", `0 0 ${w} ${h}`);

  [fig.ringTrack, fig.ringProgress].forEach((rect) => {
    rect.setAttribute("x", String(stroke / 2));
    rect.setAttribute("y", String(stroke / 2));
    rect.setAttribute("width", String(rectW));
    rect.setAttribute("height", String(rectH));
    rect.setAttribute("rx", String(radius));
    rect.setAttribute("ry", String(radius));
    rect.setAttribute("stroke-width", String(stroke));
  });

  const measured = fig.ringProgress.getTotalLength?.() ?? 0;
  fig.ringLength = measured > 0 ? measured : roundedRectPerimeter(rectW, rectH, radius);
  fig.ringProgress.style.strokeDasharray = String(fig.ringLength);
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

/** Paints the outline and the two clip shapes. Called once per figure from
 *  init: the figure lives in a fixed viewBox, so unlike the ring it owes
 *  nothing to the element's pixel size and never needs re-tracing. */
function layoutHourglass(fig: ProgressFigure): void {
  const top = hgBulbPath(HG_TOP_NECK_Y, -1);
  const bottom = hgBulbPath(HG_BOTTOM_NECK_Y, 1);
  fig.hgTopClip.setAttribute("d", top);
  fig.hgBottomClip.setAttribute("d", bottom);

  // The bulbs stop short of each other, so the frame carries the throat that
  // joins them.
  const throat = (HG_RIM_HALF_W * HG_NECK_W).toFixed(2);
  const left = (HG_CX - Number(throat)).toFixed(2);
  const right = (HG_CX + Number(throat)).toFixed(2);
  fig.hgFrame.setAttribute(
    "d",
    `${top}${bottom}` +
      `M${left},${HG_TOP_NECK_Y}L${left},${HG_BOTTOM_NECK_Y}` +
      `M${right},${HG_TOP_NECK_Y}L${right},${HG_BOTTOM_NECK_Y}`,
  );
}

/* ── The falling stream ────────────────────────────────────────────────────
   Flipping a real hourglass doesn't put a column of sand on the floor
   instantly: the first grains have to fall the length of the glass. The
   stream is drawn by revealing the grain group through a clip rect anchored
   at the throat, so "the sand is still on its way down" is just that rect
   being shorter than the gap it will eventually span.

   Two reasons this is driven frame by frame from a timestamp instead of being
   left to the steady-state CSS transition on the clip:

     • The rect keeps whatever height the last run left on it, so on the
       second and later starts there was nothing for a transition to animate
       FROM. The stream simply appeared at full length.
     • Even on a first run, a repaint lands every TICK_MS and would retarget
       an in-flight transition, restarting it from wherever it had got to.
       The drop stretches into a decelerating creep instead of falling.

   The pile below is deliberately NOT held back during the drop. It's derived
   from elapsed time like everything else here, and over half a second on a
   timer measured in minutes the difference is far below one pixel. Fudging
   the fill to match the visual would be trading honest numbers for nothing. */
const HG_FALL_MS = 600;
/** When the current pour began, or 0 when nothing is pouring. */
let hgFlowStartedAt = 0;
let hgFallRaf: number | null = null;

/** Sizes one figure's clip rect: full span from the throat to the pile once
 *  the sand has landed, a fraction of it while the leading edge is still
 *  falling. The pour timing is shared (all the figures show one session), only
 *  the element being sized differs. */
function hgPaintStream(fig: ProgressFigure, level: number): void {
  const full = HG_BOTTOM_NECK_Y + level - HG_TOP_NECK_Y;
  const elapsed = hgFlowStartedAt === 0 ? HG_FALL_MS : Date.now() - hgFlowStartedAt;
  if (elapsed >= HG_FALL_MS) {
    // Landed. Hand the rect back to the CSS transition, which from here on
    // eases it shorter as the pile rises to meet it.
    fig.hgStreamRect.classList.remove("cd-hg-dropping");
    fig.hgStreamRect.setAttribute("height", String(full));
    return;
  }
  fig.hgStreamRect.setAttribute("height", String(full * (elapsed / HG_FALL_MS)));
}

/** Own frames for the drop only. TICK_MS is 250, which would give the whole
 *  fall two frames; it stops as soon as the sand lands. One loop drives every
 *  figure, so a Display View open during the pour stays in step with the panel
 *  behind it rather than running a drop of its own. */
function hgScheduleFallFrames(): void {
  if (hgFallRaf !== null) return;
  // Nothing left to draw once the sand has landed. renderProgress() now calls
  // this on every tick (so a Display View opened mid-pour picks the drop up),
  // and without this that would be a wasted frame four times a second for the
  // whole rest of the run.
  if (hgFlowStartedAt === 0 || Date.now() - hgFlowStartedAt >= HG_FALL_MS) return;
  const step = (): void => {
    hgFallRaf = null;
    if (hgFlowStartedAt === 0 || !session) return;
    const level = hgHeightForArea(clampFraction(remainingMs(session) / spanMs(session)));
    allFigures().forEach((fig) => hgPaintStream(fig, level));
    if (Date.now() - hgFlowStartedAt < HG_FALL_MS) hgFallRaf = requestAnimationFrame(step);
  };
  hgFallRaf = requestAnimationFrame(step);
}

function hgCancelFallFrames(): void {
  if (hgFallRaf !== null) {
    cancelAnimationFrame(hgFallRaf);
    hgFallRaf = null;
  }
}

function clampFraction(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/** Paints ONE figure in `style`. `fraction` is time REMAINING, 1 → 0, so every
 *  figure empties as the clock runs down. `flowing` is whether the clock is
 *  actually moving right now, which only the hourglass cares about: sand
 *  shouldn't pour while the timer sits paused or finished. A style of "none"
 *  simply hides all three, which is also how a Display View with its progress
 *  figure switched off is drawn. */
function paintFigure(
  fig: ProgressFigure,
  style: ProgressStyle,
  f: number,
  flowing: boolean,
): void {
  fig.barWrap.style.display = style === "bar" ? "" : "none";
  fig.ring.style.display = style === "ring" ? "" : "none";
  fig.hourglass.style.display = style === "hourglass" ? "" : "none";

  if (style === "bar") {
    fig.bar.style.width = `${f * 100}%`;
  } else if (style === "ring") {
    if (fig.ringLength === 0) layoutRing(fig);
    fig.ringProgress.style.strokeDashoffset = String(fig.ringLength * (1 - f));
  } else if (style === "hourglass") {
    // Sand moves at a constant rate by area, so the level is the inverse of the
    // bulb's area curve rather than a straight multiple of `f`. Both bulbs are
    // the same shape, which is what makes one number do for both: the column
    // already drained off the top is exactly as tall as the gap still unfilled
    // at the bottom, so the two always read as halves of the same whole.
    const level = hgHeightForArea(f);
    fig.hgTopSand.setAttribute("y", String(HG_TOP_NECK_Y - level));
    fig.hgTopSand.setAttribute("height", String(level));
    fig.hgBottomSand.setAttribute("y", String(HG_BOTTOM_NECK_Y + level));
    fig.hgBottomSand.setAttribute("height", String(HG_BULB_H - level));

    // The stream runs from the throat to whatever the pile below has reached,
    // so it starts out long and shortens as the bottom fills. Grains keep
    // falling at a fixed rate the whole time; it's the drop that gets shorter,
    // which is the same thing the real object does.
    fig.hgStream.style.display = flowing ? "" : "none";
    if (flowing) hgPaintStream(fig, level);
  }
}

/** The card's figure. Its own setting, no longer derived from the timer's:
 *  see CountdownDisplaySettings.progressStyle for why the two differ. */
function displayProgressStyle(): ProgressStyle {
  return display.progressStyle;
}

/** Whether an hourglass is being drawn anywhere on screen. The panel and the
 *  card answer to different settings now, so the pour's frame loop has to be
 *  armed when EITHER of them is the glass. */
function hourglassVisible(): boolean {
  return cdSettings.progressStyle === "hourglass"
    || (displayOpen && display.progressStyle === "hourglass");
}

/** Paints the live figures: the clock panel's always, the Display View's when
 *  it is up. The Setup preview is painted separately, from the modal.
 *
 *  The pour bookkeeping happens here rather than per figure because the pour is
 *  a property of the SESSION, not of any one drawing of it. It also runs
 *  whatever style is selected, so switching styles mid-run can't strand the
 *  drop state in a half-poured position. */
function renderProgress(fraction: number, flowing = false): void {
  const f = clampFraction(fraction);

  if (flowing && hgFlowStartedAt === 0) {
    hgFlowStartedAt = Date.now();
    allFigures().forEach((fig) => fig.hgStreamRect.classList.add("cd-hg-dropping"));
  } else if (!flowing && hgFlowStartedAt !== 0) {
    hgFlowStartedAt = 0;
    allFigures().forEach((fig) => fig.hgStreamRect.classList.remove("cd-hg-dropping"));
    hgCancelFallFrames();
  }

  // Armed here rather than inside the branch above, because the transition
  // into flowing may have happened while the panel was showing a bar and no
  // glass needed frames; opening the card onto an hourglass then has to start
  // them. Idempotent: hgScheduleFallFrames() returns early if the loop is up.
  if (hgFlowStartedAt !== 0 && hourglassVisible()) hgScheduleFallFrames();

  paintFigure(inlineFigure, cdSettings.progressStyle, f, flowing);
  // Idle, the panel's figure sits full as a preview of what Start will draw.
  // The Display View instead shows nothing: it is a card about a run in
  // progress, and a figure pinned at full on it would read as a stuck timer.
  if (displayOpen) {
    paintFigure(displayFigure, session ? displayProgressStyle() : "none", f, flowing);
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
  // Display View is offered only while a session exists: its whole point is
  // putting the clock that is actually running on screen.
  displayBtn.style.display = active ? "" : "none";

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
    // The overlay can outlive the session (Done pressed from the keyboard, a
    // run cleared from elsewhere), so it is repainted on this path too rather
    // than being left showing a stale clock.
    renderDisplay();
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
  renderDisplay();
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

    attachMenu(row, () => [
      {
        // Arms the timer the way a preset chip does, rather than starting it:
        // the duration and memo go in, you press Start. Uses the PLANNED
        // length, not the length it actually took, so repeating a session you
        // stopped early gives you the full run again and not the stub.
        label: `Load ${formatDuration(entry.plannedMs)} + Memo`,
        disabled: session !== null,
        onClick: () => {
          pendingDurationMs = entry.plannedMs;
          memoInput.value = entry.memo;
          render();
          void saveStore();
        },
      },
      {
        label: "Log to Time Tracker",
        disabled: entry.logged || !showTrack,
        onClick: () => void logToTimeTracker(entry),
      },
      {
        label: "Copy Session Summary",
        onClick: () => {
          const text = `${entry.memo || "(no memo)"} · ${meta.join(" · ")}`;
          void navigator.clipboard
            .writeText(text)
            .then(() => flash("Session copied.", "success"))
            .catch(() => flash("Couldn't reach the clipboard.", "error"));
        },
      },
      {
        label: "Remove from History",
        danger: true,
        onClick: () => {
          log = log.filter((e) => e.id !== entry.id);
          renderLog();
          void saveStore();
        },
      },
    ]);

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
   SLIDER RAW ENTRY
   -----------------------------------------------------------------------------
   A slider is good for hunting a feel and useless for "exactly 168". Double-
   clicking the read-out swaps it for a number box; Enter or blur commits,
   Escape backs out. The typed value is clamped to the slider's own min/max, so
   the bounds are declared once, in the markup.
============================================================================= */

function bindSliderEntry(
  slider: HTMLInputElement,
  readout: HTMLElement,
  entry: HTMLInputElement,
  onCommit: () => void,
): void {
  const open = (): void => {
    if (slider.disabled) return;
    entry.value = slider.value;
    readout.hidden = true;
    entry.hidden = false;
    entry.focus();
    entry.select();
  };

  const close = (commit: boolean): void => {
    if (entry.hidden) return;
    if (commit) {
      const parsed = parseFloat(entry.value);
      if (Number.isFinite(parsed)) {
        const min = parseFloat(slider.min);
        const max = parseFloat(slider.max);
        slider.value = String(Math.min(max, Math.max(min, parsed)));
      }
    }
    entry.hidden = true;
    readout.hidden = false;
    onCommit();
  };

  readout.addEventListener("dblclick", open);
  entry.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      close(true);
    } else if (e.key === "Escape") {
      // Stopped here: Escape would otherwise reach the modal stack (Setup) or
      // close Display View out from under an edit.
      e.preventDefault();
      e.stopPropagation();
      close(false);
    }
  });
  entry.addEventListener("blur", () => close(true));
}

/* =============================================================================
   DISPLAY VIEW
   -----------------------------------------------------------------------------
   The clock alone, filling the window, for screen-sharing a break without also
   broadcasting the app around it. Built as the twin of the TTS Repeater's
   Display View and sharing its whole approach; see the DISPLAY VIEW THEMING
   note at the top of tts-repeater.css for why "follow theme" sets no inline
   colors at all.

   Offered only while a session exists, for the same reason the TTS one is
   offered only mid-run: the point is putting the LIVE thing on screen. An idle
   clock showing the duration you are about to start is the setup form's job.
============================================================================= */

/** Paints an overlay (or the Setup modal's preview) from `display`.
 *
 *  Follow-theme mode deliberately sets NO inline colors: it hands off to the
 *  .cd-display-themed rules, which resolve through the theme's own tokens.
 *  That is what lets a theme change mid-run, Cycle mode included, repaint an
 *  open Display View live, and what makes the glow look like the rest of the
 *  app rather than a generic effect bolted on. Custom mode is the opposite by
 *  design: two exact colors, flat, no effects.
 *
 *  Note which element takes which class. The STACK wears .tool-view-title, so
 *  the theme's title color and glow reach the memo and the ending time too
 *  rather than the clock alone floating in body-colored text; text-shadow is
 *  an inherited property, which is what makes that work. The CLOCK takes the
 *  font-relative amplifier, because a filter has to sit on the thing being
 *  amplified and because a finished clock turns red, and its halo should
 *  follow it.
 *
 *  Size is published as --cd-display-size rather than set on the clock: every
 *  other element on the card is sized against that one number, so one property
 *  scales the whole thing and nothing depends on inheriting a font size. */
function applyDisplayAppearance(
  root: HTMLElement,
  stack: HTMLElement,
  clock: HTMLElement,
  scale: number,
): void {
  const themed = display.look !== "custom";

  root.classList.toggle("cd-display-themed", themed);
  // Lets the active theme paint its full-window ambience (lava's lamp,
  // liminal's room and tape, neon's and terminal's scanlines) onto the card,
  // which it otherwise cannot: the overlay covers the window those layers live
  // on. Gated on the card's own two switches, so Custom look gets none of it
  // and Animations off gets it still. See applyDisplaySurface().
  applyDisplaySurface(root, themed, display.animate);
  root.style.background = themed ? "" : display.bgColor;
  stack.style.color = themed ? "" : display.textColor;

  // Only ever removes: the glow itself arrives from the theme's own
  // .tool-view-title rule, so "on" is simply not interfering with it.
  stack.classList.toggle("cd-display-noglow", !display.glow);
  // Gated on the theme actually having a glow, so it can only ever strengthen
  // one, never invent one.
  clock.classList.toggle("cd-display-themeglow", themed && display.glow && themeHasTitleGlow());

  stack.style.textAlign = display.align;
  stack.style.setProperty("--cd-display-size", `${display.fontSize * scale}px`);
}

/** Reveals the exit button (and the mouse cursor) then hides both again once
 *  the pointer settles. An arrow parked in the middle of a "back at half past"
 *  card is as much of a giveaway as the button is. */
function nudgeDisplayExit(): void {
  displayExitBtn.classList.add("cd-display-exit-visible");
  displayOverlay.classList.remove("cd-display-idle");
  if (displayExitTimer !== null) clearTimeout(displayExitTimer);
  displayExitTimer = setTimeout(() => {
    displayExitTimer = null;
    displayExitBtn.classList.remove("cd-display-exit-visible");
    displayOverlay.classList.add("cd-display-idle");
  }, DISPLAY_EXIT_IDLE_MS);
}

function openDisplayView(): void {
  // Can only be reached while a session exists (render() hides the button
  // otherwise), but the run can end between paint and click.
  if (!session) {
    flash("Start the countdown first. Display View shows a running clock.", "error");
    return;
  }
  displayOpen = true;
  // Shown BEFORE anything is measured or painted. The ring's geometry is read
  // off the clock box's real pixel size, and a display:none element measures
  // zero, so laying it out first would cache a ring of nothing.
  displayOverlay.style.display = "flex";
  displayFigure.ringLength = 0;
  applyDisplayAppearance(displayOverlay, displayStack, displayClockEl, 1);
  // A full paint, not just renderDisplay(): the progress figure is painted by
  // renderProgress(), so anything less would leave the card without one until
  // the next tick, and a countdown opened while paused has no next tick.
  render();
  // The overlay sits above every normal layer, so a running seasonal effect
  // would be hidden behind it. Lifting the canvas is what puts the snow (or
  // lightning, or fireworks) on the card, a big part of what a theme IS.
  setSeasonalCanvasElevated(display.look !== "custom" && display.animate);
  // Show the way out once on entry, then let it fade, otherwise the first
  // thing a new user does is wonder how to get back.
  nudgeDisplayExit();
}

function closeDisplayView(): void {
  if (!displayOpen) return;
  displayOpen = false;
  displayOverlay.style.display = "none";
  setSeasonalCanvasElevated(false);
  if (displayExitTimer !== null) {
    clearTimeout(displayExitTimer);
    displayExitTimer = null;
  }
  displayExitBtn.classList.remove("cd-display-exit-visible");
  displayOverlay.classList.remove("cd-display-idle");
}

/** Repaints the overlay's contents. Driven from render(), so the big clock is
 *  refreshed by the same Rust-side tick as the small one and cannot drift from
 *  it. Guarded on displayOpen, so a closed overlay costs nothing. */
function renderDisplay(): void {
  if (!displayOpen) return;

  // Falls back to the pending duration rather than bailing: a session that
  // ends while the overlay is up should leave a readable card behind rather
  // than an empty screen.
  const remaining = session ? remainingMs(session) : pendingDurationMs;
  displayClockEl.textContent = formatClock(remaining);
  displayClockEl.classList.toggle("cd-display-done", session !== null && remaining <= 0);
  displayClockEl.classList.toggle("cd-display-paused", session?.pausedAt != null);

  const memo = session?.memo ?? "";
  displayMemoEl.textContent = memo;
  displayMemoEl.style.display = display.showMemo && memo ? "" : "none";

  displayEndsAtEl.textContent = session ? "Ends at " + formatWallClock(session.endsAt) : "";
  displayEndsAtEl.style.display = display.showEndsAt && session ? "" : "none";

  // Only while there is a run to drive. The card can outlive its session (see
  // above), and Pause on a countdown that has already been filed does nothing.
  const controls = display.showControls && session !== null;
  displayControls.style.display = controls ? "" : "none";
  if (controls) {
    // The same three lines render() gives the panel's pair, deliberately: two
    // buttons labelled Pause and Stop that disagree about what they will do
    // would be worse than no buttons at all.
    displayPauseBtn.textContent = session!.pausedAt !== null ? "Resume" : "Pause";
    displayPauseBtn.disabled = remaining <= 0 && session!.pausedAt === null;
    displayStopBtn.textContent = remaining <= 0 ? "Done" : "Stop";
  }

  // The figure itself is painted by renderProgress(), which owns all three
  // styles, the pour timing and the hiding; there is nothing to do for it here.
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
    // Built here rather than at module level so nothing in this file touches
    // the DOM on import; the modal is lazy anyway, and Modal wants the tabs at
    // construction so it can restore them on open.
    setupTabs = new ModalTabs<CdSetupTab>({
      scope: "#cdSetupModal",
      key: "cdTab",
      panes: { timer: "cdTabTimer", display: "cdTabDisplay" },
      onActivate: (tab) => {
        // The preview's ring is measured off its clock box, and a box inside a
        // hidden pane measures zero. Showing the pane is the first moment
        // there is anything real to measure, so the cached geometry is dropped
        // and the preview repainted here rather than left as whatever a fresh
        // open that landed on the other tab produced.
        if (tab !== "display") return;
        previewFigure.ringLength = 0;
        syncSetupUI();
      },
    });

    setupModal = new Modal(document.getElementById("cd-setup-backdrop")!, {
      tabs: setupTabs,
      onOpen: () => {
        applySettingsToForm();
        syncSetupUI();
      },
    });
    document.getElementById("cd-setup-close")!.addEventListener("click", () => setupModal!.close());

    document
      .querySelectorAll<HTMLButtonElement>(
        "#cd-progress-style .toggle-btn, #cd-clock-format .toggle-btn, " +
        "#cd-display-mode .toggle-btn, #cd-bare-unit .toggle-btn, " +
        "#cd-display-look .toggle-btn, #cd-display-align .toggle-btn, " +
        "#cd-display-progress .toggle-btn",
      )
      .forEach((btn) => {
        btn.addEventListener("click", () => {
          btn.parentElement!.querySelectorAll<HTMLButtonElement>(".toggle-btn")
            .forEach((b) => b.classList.toggle("active", b === btn));
          commitSettings();
        });
      });

    clockFontSelect.addEventListener("change", commitSettings);
    [displayBgInput, displayFgInput, displaySizeInput].forEach((el) => {
      el.addEventListener("input", commitSettings);
    });
    [displayGlowToggle, displayAnimateToggle, displayMemoToggle,
      displayEndsAtToggle, displayControlsToggle].forEach((el) => {
      el.addEventListener("change", commitSettings);
    });

    bindSliderEntry(displaySizeInput, displaySizeValue, displaySizeEntry, commitSettings);

    document.getElementById("cd-display-reset")!.addEventListener("click", () => {
      // Separate from the settings reset below on purpose: how the tool LOOKS
      // on a shared screen and how the timer BEHAVES are set up at different
      // times, and wiping one while adjusting the other is never meant.
      display = { ...DEFAULT_DISPLAY };
      applySettingsToForm();
      syncSetupUI();
      void saveStore();
      flash("Display View appearance reset", "success");
    });

    showTrackerToggle.addEventListener("change", commitSettings);
    soundSelect.addEventListener("change", commitSettings);
    soundRepeatsInput.addEventListener("change", commitSettings);
    soundGapInput.addEventListener("change", commitSettings);

    document.getElementById("cd-sound-test")!.addEventListener("click", () => void playAlarm());

    document.getElementById("cd-setup-reset")!.addEventListener("click", () => {
      // Deliberately leaves `display` alone; the Display View section has its
      // own Reset for the same reason it has its own settings.
      cdSettings = { ...DEFAULT_SETTINGS };
      applySettingsToForm();
      applyClockFont();
      syncSetupUI();
      // The ring's geometry only exists while it's the chosen style, so a
      // style change has to invalidate it rather than reuse a stale length.
      invalidateRings();
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
    clockFont: clockFontSelect.value,
    displayMode: segValue("cd-display-mode", "brief") as DisplayMode,
    bareUnit: segValue("cd-bare-unit", "minutes") as BareUnit,
    showTrackerLog: showTrackerToggle.checked,
    soundId: soundSelect.value,
    soundRepeats: parseInt(soundRepeatsInput.value, 10),
    soundGapMs: parseInt(soundGapInput.value, 10),
  });

  display = normalizeDisplay({
    look: segValue("cd-display-look", "theme") as CountdownDisplaySettings["look"],
    bgColor: displayBgInput.value,
    textColor: displayFgInput.value,
    align: segValue("cd-display-align", "center") as CountdownDisplaySettings["align"],
    fontSize: parseInt(displaySizeInput.value, 10),
    glow: displayGlowToggle.checked,
    animate: displayAnimateToggle.checked,
    showMemo: displayMemoToggle.checked,
    showEndsAt: displayEndsAtToggle.checked,
    progressStyle: segValue("cd-display-progress", "bar") as ProgressStyle,
    showControls: displayControlsToggle.checked,
    // Every field is present, so the migration inside never fires and this
    // argument is only ever the unused fallback.
  }, cdSettings.progressStyle);

  // The clock font is a live property of the page, so it has to be republished
  // here; the Display View settings do not, because Setup and the overlay can
  // never be on screen together (the overlay covers every route to Setup, and
  // Setup's backdrop covers every route to the overlay) and openDisplayView()
  // paints from whatever these settings are at the moment it runs.
  applyClockFont();

  // Push the clamped numbers back into the boxes. The min/max attributes only
  // bind the spinner arrows (a typed 500 stays 500 in the field) so without
  // this the box would keep showing a value the app isn't actually using.
  soundRepeatsInput.value = String(cdSettings.soundRepeats);
  soundGapInput.value = String(cdSettings.soundGapMs);

  // A new clock face, a new detail level or a new display size all change the
  // clock box the ring is traced around.
  invalidateRings();
  syncSetupUI();
  refreshBareUnitHints();
  render();
  renderLog();
  void saveStore();
}

function applySettingsToForm(): void {
  setSegValue("cd-progress-style", cdSettings.progressStyle);
  setSegValue("cd-clock-format", cdSettings.clockFormat);
  clockFontSelect.value = cdSettings.clockFont;

  setSegValue("cd-display-look", display.look);
  setSegValue("cd-display-align", display.align);
  displayBgInput.value = display.bgColor;
  displayFgInput.value = display.textColor;
  displaySizeInput.value = String(display.fontSize);
  displayGlowToggle.checked = display.glow;
  displayAnimateToggle.checked = display.animate;
  displayMemoToggle.checked = display.showMemo;
  displayEndsAtToggle.checked = display.showEndsAt;
  setSegValue("cd-display-progress", display.progressStyle);
  displayControlsToggle.checked = display.showControls;

  setSegValue("cd-display-mode", cdSettings.displayMode);
  setSegValue("cd-bare-unit", cdSettings.bareUnit);
  showTrackerToggle.checked = cdSettings.showTrackerLog;
  soundSelect.value = cdSettings.soundId;
  // An id can name a cue file that is not in this build (the manifest folders
  // are scanned at build time). Assigning one the select has no option for
  // leaves it blank, so fall back to Silent in the UI. cdSettings keeps the
  // stored id, which comes back if the file does.
  if (soundSelect.selectedIndex === -1) soundSelect.value = "none";
  soundRepeatsInput.value = String(cdSettings.soundRepeats);
  soundGapInput.value = String(cdSettings.soundGapMs);
}

/** Derived Setup state: the Time Tracker dependency, and everything the
 *  Display View section shows conditionally. */
function syncSetupUI(): void {
  const trackerAvailable = isToolVisible(TIME_TRACKER_KEY);
  // Greyed out rather than hidden: the setting still exists and comes back on
  // its own the moment the Time Tracker is unhidden, so saying why beats
  // making the row vanish.
  showTrackerToggle.disabled = !trackerAvailable;
  trackerNoteEl.textContent = trackerAvailable
    ? "Adds a per-session button that files it as a Time Tracker entry."
    : "Unavailable: Time Tracker is hidden in Settings › Sidebar.";

  displayCustomRow.style.display = display.look === "custom" ? "" : "none";
  displayEffectsRow.style.display = display.look === "custom" ? "none" : "";

  // Both effect toggles depend on the ACTIVE theme actually having the thing
  // they switch. Rather than greying them out (which reads as "broken") they
  // stay usable and the note says why nothing will change. Re-checked on every
  // themechange, so Cycle mode keeps these honest.
  glowNote.textContent = themeHasTitleGlow() ? "" : "This theme has no glow.";
  animateNote.textContent = isThemeEffectRunning()
    // "on", not "over": a canvas effect plays above the card, while a
    // CSS theme's own layers play in front of and behind it.
    ? "Plays on Display View."
    : "This theme has no animation running.";

  displaySizeValue.textContent = `${display.fontSize}px`;

  renderSetupPreview();
}

/* ── The Setup preview ──────────────────────────────────────────────────────
   Scaled down rather than reproduced at full size: the preview box is a small
   fraction of the window's height, so the real clock size would overflow it
   instantly. One factor scales the whole card, which keeps the preview honest
   about proportion, the part actually being judged. */

/** The factor at ordinary sizes. Chosen so the default 200px clock lands at a
 *  readable ~56px in the 164px-tall preview box. */
const PREVIEW_SCALE = 0.28;
/** Tallest the preview's clock is allowed to get, in px. Past roughly this,
 *  the rest of the card stops fitting in the box and the preview would be
 *  showing a cropped card rather than a small one. */
const PREVIEW_CLOCK_CAP = 62;

/** Shrinks further than PREVIEW_SCALE once the chosen size would push the card
 *  out of the box. The preview then stops growing near the top of the slider's
 *  travel, which is a smaller lie than clipping the bar off the bottom. */
function previewScale(): number {
  return Math.min(PREVIEW_SCALE, PREVIEW_CLOCK_CAP / display.fontSize);
}

function renderSetupPreview(): void {
  applyDisplayAppearance(displayPreview, displayPreviewStack, displayPreviewClock, previewScale());

  // Shows the live session when there is one, so the preview is of the card
  // you are about to put on screen rather than a generic sample.
  const remaining = session ? remainingMs(session) : pendingDurationMs;
  displayPreviewClock.textContent = formatClock(remaining);

  // Live session first, then whatever is half-typed into the memo field, then
  // a placeholder, so the preview is never a blank line pretending to be one.
  const memo = (session?.memo ?? memoInput.value).trim() || "Break";
  displayPreviewMemo.textContent = memo;
  displayPreviewMemo.style.display = display.showMemo ? "" : "none";

  const endsAt = session ? session.endsAt : Date.now() + pendingDurationMs;
  displayPreviewEndsAt.textContent = `Ends at ${formatWallClock(endsAt)}`;
  displayPreviewEndsAt.style.display = display.showEndsAt ? "" : "none";

  // Shown regardless of whether a session is running, unlike the real card:
  // the preview's job is to answer "what will this look like", and hiding the
  // row while the timer is idle would answer it wrong.
  displayPreviewControls.style.display = display.showControls ? "" : "none";

  // Never "flowing": a preview that poured sand would animate forever inside a
  // modal, and the drop is a property of the running session anyway.
  const fraction = session ? clampFraction(remaining / spanMs(session)) : 1;
  paintFigure(previewFigure, displayProgressStyle(), fraction, false);
}

/** Fills the clock-face picker from CLOCK_FONTS, each option drawn IN the face
 *  it names so the list is its own specimen sheet. A face the machine does not
 *  have renders in the next one down its own stack, which is exactly what the
 *  clock would do, so the preview stays truthful either way.
 *
 *  The app-font option is deliberately left in the list's own type: "inherit"
 *  is what it means, and rendering it in the menu's font is that. */
function populateFontOptions(): void {
  clockFontSelect.innerHTML = "";
  CLOCK_FONTS.forEach((font) => {
    const opt = document.createElement("option");
    opt.value = font.id;
    opt.textContent = font.label;
    opt.style.fontFamily = font.stack;
    clockFontSelect.appendChild(opt);
  });
}

/** Every cue the app ships, grouped by where it comes from: the pack the app
 *  is currently set to, the timer's own sounds, then every notification pack,
 *  button cue and modal cue individually. Silent sits above the groups as a
 *  plain option because it belongs to none of them.
 *
 *  The groups and their contents are decided by getSoundOptions() in sound.ts;
 *  all this does is turn them into optgroups. */
function populateSoundOptions(): void {
  soundSelect.innerHTML = "";

  const silent = document.createElement("option");
  silent.value = "none";
  silent.textContent = "Silent";
  soundSelect.appendChild(silent);

  getSoundOptions().forEach((group) => {
    const groupEl = document.createElement("optgroup");
    groupEl.label = group.label;
    group.options.forEach((opt) => {
      const el = document.createElement("option");
      el.value = opt.id;
      el.textContent = opt.name;
      groupEl.appendChild(el);
    });
    soundSelect.appendChild(groupEl);
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

    const editBtn = row.querySelector<HTMLButtonElement>(".cd-preset-edit")!;
    const removeBtn = row.querySelector<HTMLButtonElement>(".cd-preset-remove")!;
    editBtn.addEventListener("click", () => beginPresetEdit(preset));
    removeBtn.addEventListener("click", () => {
      const label = preset.label || formatDuration(preset.seconds * 1000);
      presets = presets.filter((p) => p.id !== preset.id);
      if (editingPresetId === preset.id) cancelPresetEdit();
      renderPresetList();
      renderPresets();
      void saveStore();
      flash(`Deleted "${label}"`, "success");
    });

    // The row already carries four small buttons. The menu restates them with
    // names rather than arrows, which is the difference between guessing and
    // reading, and adds the one thing the row cannot do: arm the timer.
    attachMenu(row, () => [
      {
        label: "Load This Duration",
        disabled: session !== null,
        onClick: () => {
          pendingDurationMs = preset.seconds * 1000;
          render();
          void saveStore();
        },
      },
      { label: "Edit Preset", onClick: () => beginPresetEdit(preset) },
      { label: "Move Up", disabled: up.disabled, onClick: () => movePreset(preset.id, -1) },
      { label: "Move Down", disabled: down.disabled, onClick: () => movePreset(preset.id, 1) },
      { label: "Delete Preset", danger: true, onClick: () => removeBtn.click() },
    ]);

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
  clockMemoEl = document.getElementById("cd-clock-memo")!;
  startedAtEl = document.getElementById("cd-started-at")!;
  endingAtEl = document.getElementById("cd-ending-at")!;
  setupPanel = document.getElementById("cd-setup-panel")!;
  runningPanel = document.getElementById("cd-running-panel")!;
  extendRow = document.getElementById("cd-extend-row")!;
  presetsRow = document.getElementById("cd-presets")!;
  logListEl = document.getElementById("cd-log-list")!;
  logEmptyEl = document.getElementById("cd-log-empty")!;

  // The three copies of the progress markup. Written out one element at a
  // time, with the ids as literal strings, so the wiring check in
  // scripts/checks can see every lookup and catch a renamed element in the
  // page. A loop over an id prefix would hide all forty-two of them from it.
  inlineFigure = {
    clockWrap: document.getElementById("cd-clock-wrap")!,
    barWrap: document.getElementById("cd-bar-wrap")!,
    bar: document.getElementById("cd-bar")!,
    ring: document.getElementById("cd-ring") as unknown as SVGSVGElement,
    ringTrack: document.getElementById("cd-ring-track") as unknown as SVGRectElement,
    ringProgress: document.getElementById("cd-ring-progress") as unknown as SVGRectElement,
    ringLength: 0,
    ringStrokeMax: RING_STROKE_MAX_INLINE,
    hourglass: document.getElementById("cd-hourglass") as unknown as SVGSVGElement,
    hgTopSand: document.getElementById("cd-hg-top-sand") as unknown as SVGRectElement,
    hgBottomSand: document.getElementById("cd-hg-bottom-sand") as unknown as SVGRectElement,
    hgTopClip: document.getElementById("cd-hg-top-clip-path") as unknown as SVGPathElement,
    hgBottomClip: document.getElementById("cd-hg-bottom-clip-path") as unknown as SVGPathElement,
    hgFrame: document.getElementById("cd-hg-frame") as unknown as SVGPathElement,
    hgStream: document.getElementById("cd-hg-stream") as unknown as SVGGElement,
    hgStreamRect: document.getElementById("cd-hg-stream-rect") as unknown as SVGRectElement,
  };

  displayFigure = {
    clockWrap: document.getElementById("cd-display-clock-wrap")!,
    barWrap: document.getElementById("cd-display-bar-wrap")!,
    bar: document.getElementById("cd-display-bar")!,
    ring: document.getElementById("cd-display-ring") as unknown as SVGSVGElement,
    ringTrack: document.getElementById("cd-display-ring-track") as unknown as SVGRectElement,
    ringProgress: document.getElementById("cd-display-ring-progress") as unknown as SVGRectElement,
    ringLength: 0,
    ringStrokeMax: RING_STROKE_MAX_DISPLAY,
    hourglass: document.getElementById("cd-display-hourglass") as unknown as SVGSVGElement,
    hgTopSand: document.getElementById("cd-display-hg-top-sand") as unknown as SVGRectElement,
    hgBottomSand: document.getElementById("cd-display-hg-bottom-sand") as unknown as SVGRectElement,
    hgTopClip: document.getElementById("cd-display-hg-top-clip-path") as unknown as SVGPathElement,
    hgBottomClip: document.getElementById("cd-display-hg-bottom-clip-path") as unknown as SVGPathElement,
    hgFrame: document.getElementById("cd-display-hg-frame") as unknown as SVGPathElement,
    hgStream: document.getElementById("cd-display-hg-stream") as unknown as SVGGElement,
    hgStreamRect: document.getElementById("cd-display-hg-stream-rect") as unknown as SVGRectElement,
  };

  previewFigure = {
    clockWrap: document.getElementById("cd-display-preview-clock-wrap")!,
    barWrap: document.getElementById("cd-display-preview-bar-wrap")!,
    bar: document.getElementById("cd-display-preview-bar")!,
    ring: document.getElementById("cd-display-preview-ring") as unknown as SVGSVGElement,
    ringTrack: document.getElementById("cd-display-preview-ring-track") as unknown as SVGRectElement,
    ringProgress: document.getElementById("cd-display-preview-ring-progress") as unknown as SVGRectElement,
    ringLength: 0,
    ringStrokeMax: RING_STROKE_MAX_DISPLAY,
    hourglass: document.getElementById("cd-display-preview-hourglass") as unknown as SVGSVGElement,
    hgTopSand: document.getElementById("cd-display-preview-hg-top-sand") as unknown as SVGRectElement,
    hgBottomSand: document.getElementById("cd-display-preview-hg-bottom-sand") as unknown as SVGRectElement,
    hgTopClip: document.getElementById("cd-display-preview-hg-top-clip-path") as unknown as SVGPathElement,
    hgBottomClip: document.getElementById("cd-display-preview-hg-bottom-clip-path") as unknown as SVGPathElement,
    hgFrame: document.getElementById("cd-display-preview-hg-frame") as unknown as SVGPathElement,
    hgStream: document.getElementById("cd-display-preview-hg-stream") as unknown as SVGGElement,
    hgStreamRect: document.getElementById("cd-display-preview-hg-stream-rect") as unknown as SVGRectElement,
  };

  allFigures().forEach(layoutHourglass);

  displayBtn = document.getElementById("cd-display-btn") as HTMLButtonElement;
  displayOverlay = document.getElementById("cd-display-overlay")!;
  displayStack = document.getElementById("cd-display-stack")!;
  displayClockEl = document.getElementById("cd-display-clock")!;
  displayMemoEl = document.getElementById("cd-display-memo")!;
  displayEndsAtEl = document.getElementById("cd-display-ends-at")!;
  displayExitBtn = document.getElementById("cd-display-exit") as HTMLButtonElement;
  displayControls = document.getElementById("cd-display-controls")!;
  displayPauseBtn = document.getElementById("cd-display-pause") as HTMLButtonElement;
  displayStopBtn = document.getElementById("cd-display-stop") as HTMLButtonElement;

  clockFontSelect = document.getElementById("cd-clock-font") as HTMLSelectElement;
  displayBgInput = document.getElementById("cd-display-bg") as HTMLInputElement;
  displayFgInput = document.getElementById("cd-display-fg") as HTMLInputElement;
  displayCustomRow = document.getElementById("cd-display-custom-row")!;
  displayEffectsRow = document.getElementById("cd-display-effects-row")!;
  displayGlowToggle = document.getElementById("cd-display-glow") as HTMLInputElement;
  displayAnimateToggle = document.getElementById("cd-display-animate") as HTMLInputElement;
  glowNote = document.getElementById("cd-glow-note")!;
  animateNote = document.getElementById("cd-animate-note")!;
  displayMemoToggle = document.getElementById("cd-display-show-memo") as HTMLInputElement;
  displayEndsAtToggle = document.getElementById("cd-display-show-ends-at") as HTMLInputElement;
  displayControlsToggle = document.getElementById("cd-display-show-controls") as HTMLInputElement;
  displaySizeInput = document.getElementById("cd-display-size") as HTMLInputElement;
  displaySizeValue = document.getElementById("cd-display-size-value")!;
  displaySizeEntry = document.getElementById("cd-display-size-entry") as HTMLInputElement;
  displayPreview = document.getElementById("cd-display-preview")!;
  displayPreviewStack = document.getElementById("cd-display-preview-stack")!;
  displayPreviewClock = document.getElementById("cd-display-preview-clock")!;
  displayPreviewMemo = document.getElementById("cd-display-preview-memo")!;
  displayPreviewEndsAt = document.getElementById("cd-display-preview-ends-at")!;
  displayPreviewControls = document.getElementById("cd-display-preview-controls")!;

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
  populateFontOptions();
  applyClockFont();

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

  /* ── Display View ── */
  displayBtn.addEventListener("click", openDisplayView);
  displayExitBtn.addEventListener("click", closeDisplayView);
  // Routed to the same two functions as the panel's buttons rather than to
  // copies of them, so the card cannot end a session by a different path than
  // the app does (the tracker entry, the log line, the alarm are all in there).
  displayPauseBtn.addEventListener("click", () => void togglePause());
  displayStopBtn.addEventListener("click", () => {
    if (!session) return;
    // Leave first, then end it. Ending the run from the card empties the card:
    // there is nothing left on it to look at and no way to start another from
    // it, since the duration field, the memo and the presets all live in the
    // panel. So the button that ends the run also puts you back where you can
    // begin one. Closing before rather than after also means endSession()'s
    // toast is not raised behind an overlay that outranks the toast layer.
    //
    // Deliberately only THIS button. A countdown that reaches zero on its own
    // leaves the card up, because watching it land on 0:00 is what the card is
    // for; the alarm and the red digits say the rest.
    closeDisplayView();
    void endSession(remainingMs(session) <= 0 ? "completed" : "stopped");
  });
  displayOverlay.addEventListener("pointermove", nudgeDisplayExit);
  // Escape is handled here rather than through Modal: the overlay is not a
  // modal (no backdrop, and it sits above the toast layer), so the shared
  // open-stack never sees it. Modal's own Escape handler only fires when that
  // stack is non-empty, and Display View cannot be entered with a modal open,
  // so the two never contend.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && displayOpen) {
      e.preventDefault();
      closeDisplayView();
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

  // A theme swap changes what the preview should show and whether the glow /
  // animation notes still apply. Cycle mode can do that at any moment,
  // including while Setup is open or the overlay is up.
  window.addEventListener("themechange", () => {
    // Colors and the theme's own glow follow the new stylesheet on their own;
    // the amplifier class does not, because whether the new theme HAS a glow is
    // a measured fact rather than a CSS one.
    if (displayOpen) applyDisplayAppearance(displayOverlay, displayStack, displayClockEl, 1);
    if (setupModal?.isOpen) syncSetupUI();
  });

  // The ring is measured from its clock wrapper's real box, so anything that
  // resizes one (the window, font scale, a longer clock string, the Display
  // View's size slider) invalidates that figure's cached geometry. The preview
  // is not watched: it is only ever on screen with the modal open, and every
  // route to changing it already repaints through syncSetupUI().
  const watchRing = (fig: ProgressFigure, isRing: () => boolean): void => {
    new ResizeObserver(() => {
      // Re-measuring is only worth a repaint when this figure is actually the
      // ring, and the two figures answer to different settings now.
      if (!isRing()) return;
      fig.ringLength = 0;
      render();
    }).observe(fig.clockWrap);
  };
  watchRing(inlineFigure, () => cdSettings.progressStyle === "ring");
  watchRing(displayFigure, () => display.progressStyle === "ring");

  render();
  void loadStore();
}

/* -----------------------------------------------------------------------------
   EXPORT AND IMPORT
   -----------------------------------------------------------------------------
   Registered with the Data tab in App Settings, which owns the buttons. This
   tool's records are still a JSON file, so its export IS that file's contents
   and its import writes them straight back.
----------------------------------------------------------------------------- */

registerTransferable({
  id: "countdown",
  label: "Countdown Timer",
  gather: async () => JSON.parse(
    await invoke<string>("load_tool_file", { toolId: "countdown", kind: "data" }),
  ),
  apply: async (parsed) => {
    if (parsed === null || typeof parsed !== "object") {
      throw new Error("that file does not hold this tool's data");
    }
    await invoke("save_tool_file", {
      toolId: "countdown",
      kind: "data",
      data: JSON.stringify(parsed),
    });
    // Read back through the ordinary load, so every validator and default this
    // tool applies on the way in is applied to an imported file too.
    await loadStore();
  },
});
