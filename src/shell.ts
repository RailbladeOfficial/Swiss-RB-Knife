/* =============================================================================
   SHELL: Swiss RB Knife application shell
   -----------------------------------------------------------------------------
   Top-level orchestrator for the app. Owns:

     • Sidebar navigation (section switching, tool activation, landing pages)
     • Mouse back/forward history stack
     • Shell state persistence (active section/tool across restarts)
     • Settings modal + all setting controls
     • Toast notification system with centralized audio
     • Window size save/restore (DPI-aware, logical pixels)
     • Exit confirm modal
     • Modal instances for the Settings modal and Exit confirm (the rest (
       About, Changelog, Licensing, Full License, README, Security,
       Contributing, License Agreement) live in docs.ts)

   As of Tier 6, the theme system, custom theme editor, lock screen, and the
   About/Changelog/Licensing/README/Security/Contributing/License-Agreement
   modal family have been split into their own files:
     • theme-core.ts:    applyTheme() dispatcher + seasonal canvas effects
     • random-theme.ts:  Random theme palette generation
     • theme-editor.ts:  Custom Theme Editor modal + storage
     • lockscreen.ts:    App Lock screen + Set/Change Credential modal
     • docs.ts:          About/Changelog/Licensing/README/Security/
                           Contributing/License Agreement + startup gates
   This file wires them together via init() but no longer owns their internals.

   Per-tool logic lives in src/tools/<tool>.ts and is initialized via init*()
   calls at the bottom of init(). The Modal primitive (modal.ts) owns all shared
   chrome behaviour (Escape, drag, open-stack, scroll reset).
============================================================================= */

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { Modal, ModalTabs, setGlobalModalOpenHook } from "./modal";
import { initTimeTracker } from "./tools/time-tracker";
import { initImageCCR } from "./tools/image-ccr";
import { initFileGen } from "./tools/file-gen";
import {
  initAutoBackup,
  onAutoBackupToolEntry,
  getDueBackupReminder,
} from "./tools/auto-backup";
import {
  initBudget,
  setBudgetAmericanDates,
  onBudgetToolEntry,
  onBudgetToolExit,
  getDueBudgetReminder,
  markBudgetReviewed,
} from "./tools/budget";
import { initGameStats, onGameStatsToolEntry, onGameStatsIconClicked } from "./tools/game-stats";
import { initTTSRepeater } from "./tools/tts-repeater";
import { initCountdown } from "./tools/countdown";
import { initDaysBetween } from "./tools/days-between";
import {
  RANDOM_VARS,
  PERSISTENT_RANDOM_KEY,
  maybeRegenerateRandom,
} from "./random-theme";
import {
  ANIMATED_THEMES,
  applyTheme,
  isKnownBuiltinTheme,
  themeCssUrl,
  getActiveCustomId,
  setActiveCustomId,
} from "./theme-core";
import { DEFAULT_THEME_ID, THEME_SENTINELS, migrateThemeId } from "./theme-ids";
import {
  advanceCycleNow,
  getActiveHolidayOverrideThemeId,
  getDayNightStatus,
  getHolidayOverrideEndDate,
} from "./cycle-theme";
import {
  genThemeId,
  saveCustomThemes,
  loadCustomThemes,
  applyCustomThemeById,
  clearCustomTheme,
  customThemes,
  openThemeEditor,
  requestDeleteCustomTheme,
} from "./theme-editor";
import {
  DEFAULT_SETTINGS,
  SIDEBAR_SORT_MODES,
  type ShellSettings,
  type SidebarItemState,
  type SidebarSortMode,
  settings,
  setSettings,
} from "./settings-store";
// Re-exported so the many existing `import { settings } from "./shell"` call
// sites keep working. New code should import from ./settings-store directly.
export {
  DEFAULT_SETTINGS,
  SIDEBAR_SORT_MODES,
  type ShellSettings,
  type SidebarItemState,
  type SidebarSortMode,
  settings,
  setSettings,
};

import {
  populateDayNightThemeSelects,
  refreshCycleDayNightNote,
  refreshCycleHolidayNote,
  refreshThemeCurrentBadge,
  syncCycleSettingsVisibility,
  themePickerModal,
  themePickerTabs,
} from "./theme-picker";
// Re-exported so theme-editor.ts keeps importing these from shell, matching
// how it already reaches every other shared binding.
export { reopenThemePickerOnCustomTab, themePickerModal } from "./theme-picker";

import {
  applyToastVolumeSettings,
  clampToastVolume,
  errorAudio,
  loadSoundPack,
  playCue,
  refreshSoundPackCurrentBadge,
  successAudio,
} from "./sound";
// Re-exported so tool files keep importing these from "../shell", their
// existing convention, rather than reaching into a shell-internal module.
export { getSoundOptions, resolveSoundUrl, playSoundUrl } from "./sound";

import {
  applySidebarOrder,
  isToolPinned,
  isToolVisible,
} from "./sidebar-edit";
// Re-exported so tool files keep importing it from "../shell", their existing
// convention, rather than reaching into a shell-internal module.
export { isToolVisible };

import {
  applyLockSettings,
  buildPinDots,
  resetPinBuffer,
  lockScreen,
  lockPinView,
  lockPasswordView,
  lockPinError,
  lockPasswordInput,
  lockPasswordError,
} from "./lockscreen";
import { applyUpdateSettings, checkForUpdates, runStartupGates } from "./docs";

/* =============================================================================
   TYPES
============================================================================= */

type ToastMeta = {
  id: number;
  timeout: ReturnType<typeof setTimeout> | null;
  /** The toast's own requested duration, untouched by pausing. The floor a
   *  return-from-away resume never shortens it below (see TOAST_RETURN_MS). */
  durationMs: number;
  remaining: number;
  startedAt: number;
  hovered: boolean;
  /** True only for a toast that fired while the app wasn't on screen and so
   *  has never been shown to the user yet. Its countdown hasn't started.
   *  Cleared the first time the app becomes visible, after which the toast
   *  is "seen" and leaving the app again no longer pauses it. */
  awaitingFirstView: boolean;
  dismiss: () => void;
};

type NavEntry = {
  section: string;
  tool?: string;
};

/** Static metadata for a real, navigable tool. One entry per sidebar/Home
 *  item. `key` is "section/tool", matching the format switchSection() already
 *  uses for _activeViewKey, so pin-state lookups can compare directly. */
type ToolMeta = {
  key: string;
  section: string;
  tool: string;
  label: string;
};

/** One row of the persisted sidebar order/pin state (settings.sidebarItems).
 *  Array order IS the display order for pinned items; unpinned items are
 *  hidden and their relative order is never shown or editable. */

/** Advanced visual overrides stored per custom theme. All fields optional,
 *  absent means "no override" (flat colour from the CSS vars applies). */
export type AdvancedOptions = {
  headerGradient?: { colorA: string; colorB: string; angle: number };
  headerGlow?: { color: string; intensity: "low" | "medium" | "high" };
  bodyGradient?: { colorA: string; colorB: string; angle: number };
  modalGlow?: { color: string; intensity: "low" | "medium" | "high" };
  panelGlow?: { color: string; intensity: "low" | "medium" | "high" };
  buttonGlow?: { color: string; intensity: "low" | "medium" | "high" };
};

/** A persisted custom theme. vars holds all --color-* values; advanced holds
 *  the optional gradient / glow overrides. */
export type CustomTheme = {
  id: string; // stable UUID-style key, never shown to user
  name: string; // display name, user-editable
  vars: Record<string, string>;
  advanced: AdvancedOptions;
};

/** A toast sound pack. `success`/`error` are URL paths under /sounds/ served
 *  from the public/sounds folder. Omit either (or both) to mute that cue,
 *  used by the built-in "None" pack. This is the single source of truth for
 *  the Sound Pack dropdown; add a pack here and it appears in Settings. */
export type SoundPack = {
  id: string; // stable key, persisted in settings.soundPack
  name: string; // display name shown in the dropdown
  success?: string; // e.g. "/sounds/default/success.wav"
  error?: string; // e.g. "/sounds/default/error.wav"
};


/** Result of a successful update check, shared by the sidebar pulse and the
 *  About-modal notice so neither has to re-query. `available` folds in both
 *  the "newer than current" and "newer than ignored" checks. */
export interface UpdateInfo {
  current: string; // running version, e.g. "0.3.3" (no leading v)
  latest: string; // latest release tag, e.g. "v0.3.4"
  htmlUrl: string; // release page, opened in the default browser
  available: boolean;
}

/* =============================================================================
   CONSTANTS
============================================================================= */

// Bump this string whenever the license terms change in a way that requires
// users to re-read and re-accept. Any change causes the agreement gate to
// reopen on next launch. Incrementing a number is sufficient (e.g. "2", "3").
export const LICENSE_VERSION = "1";

const MAX_TOASTS = 4;

/* Sound packs available for toast cues. Each pack is a subfolder under
   public/sounds/ containing (at minimum) the files referenced below, see
   the "TOAST NOTIFICATIONS" section for how these are loaded/played.
   Add a new pack by dropping a folder in public/sounds/<id>/ and adding an
   entry here; the Settings dropdown is populated from this array. */
export const SOUND_PACKS: SoundPack[] = [
  {
    id: "default",
    name: "Default",
    success: "/sounds/default/default-success.wav",
    error: "/sounds/default/default-error.wav",
  },
  {
    id: "alternate",
    name: "Alternate",
    success: "/sounds/alternate/alternate-success.wav",
    error: "/sounds/alternate/alternate-error.wav",
  },
  {
    id: "subtle",
    name: "Subtle",
    success: "/sounds/subtle/subtle-success.wav",
    error: "/sounds/subtle/subtle-error.wav",
  },
  {
    id: "saxy-time",
    name: "Saxy Time",
    success: "/sounds/saxy-time/saxy-time-success.wav",
    error: "/sounds/saxy-time/saxy-time-error.wav",
  },
  {
    id: "futuristic-1",
    name: "Futuristic 1",
    success: "/sounds/futuristic-1/futuristic-1-success.wav",
    error: "/sounds/futuristic-1/futuristic-1-error.wav",
  },
  {
    id: "futuristic-2",
    name: "Futuristic 2",
    success: "/sounds/futuristic-2/futuristic-2-success.wav",
    error: "/sounds/futuristic-2/futuristic-2-error.wav",
  },
  {
    id: "cake",
    name: "Cake",
    success: "/sounds/cake/cake-success.wav",
    error: "/sounds/cake/cake-error.wav",
  },
  {
    id: "sassy-cake",
    name: "Sassy Cake",
    success: "/sounds/sassy-cake/sassy-cake-success.wav",
    error: "/sounds/sassy-cake/sassy-cake-error.wav",
  },
];

/* Every real, navigable tool in the app, in the app's original/default
   order. This is the single source of truth for the Edit Sidebar modal, the
   Home dashboard, and the "Specific Tool" options in the On Startup select,
   add a tool here (matching its data-section/data-tool attributes in
   index.html) and it's automatically pinnable/reorderable/hideable. */
export const ALL_TOOLS: ToolMeta[] = [
  { key: "finance/budget", section: "finance", tool: "budget", label: "Budget Tracker" },
  { key: "utility/time-tracker", section: "utility", tool: "time-tracker", label: "Time Tracker" },
  { key: "files/auto-backup", section: "files", tool: "auto-backup", label: "Auto-Backup" },
  { key: "utility/countdown", section: "utility", tool: "countdown", label: "Countdown Timer" },
  { key: "games/game-stats", section: "games", tool: "game-stats", label: "Game Stats" },
  { key: "media/image-ccr", section: "media", tool: "image-ccr", label: "Image CCR" },
  { key: "utility/days-between", section: "utility", tool: "days-between", label: "Days Between Dates" },
  { key: "utility/tts-repeater", section: "utility", tool: "tts-repeater", label: "TTS Repeater" },
  { key: "files/dummy-file-generator", section: "files", tool: "dummy-file-generator", label: "Dummy File Generator" },
];

/** How the sidebar is ordered. "classic" is ALL_TOOLS' own order above;
 *  "custom" is whatever the user last dragged it into, and is what a drag
 *  switches you to, otherwise a live sort would immediately undo the drag. */


function toolLabel(key: string): string {
  return ALL_TOOLS.find((t) => t.key === key)?.label ?? key;
}

/** Orders one group (shown or hidden) by the active mode. Every usage-driven
 *  sort falls back to alphabetical so tools that have never been opened land
 *  in a stable, predictable order instead of whatever the array happened to
 *  hold. */
function sortSidebarGroup(items: SidebarItemState[], mode: SidebarSortMode): SidebarItemState[] {
  const byName = (a: SidebarItemState, b: SidebarItemState): number =>
    toolLabel(a.key).localeCompare(toolLabel(b.key));
  const copy = [...items];

  switch (mode) {
    case "classic": {
      const rank = new Map(ALL_TOOLS.map((t, i) => [t.key, i]));
      return copy.sort((a, b) => (rank.get(a.key) ?? 999) - (rank.get(b.key) ?? 999));
    }
    case "az":
      return copy.sort(byName);
    case "za":
      return copy.sort((a, b) => byName(b, a));
    case "recent":
      return copy.sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || byName(a, b));
    case "used":
      return copy.sort((a, b) => (b.useCount ?? 0) - (a.useCount ?? 0) || byName(a, b));
    default:
      return copy;
  }
}

/** Re-orders settings.sidebarItems in place for the active mode. Shown and
 *  hidden are sorted separately and re-concatenated, because the rest of the
 *  sidebar code takes "pinned items come first" as a given. */
export function applySidebarSortMode(): void {
  const mode = settings.sidebarSort;
  if (mode === "custom") return;
  settings.sidebarItems = [
    ...sortSidebarGroup(settings.sidebarItems.filter((it) => it.pinned), mode),
    ...sortSidebarGroup(settings.sidebarItems.filter((it) => !it.pinned), mode),
  ];
}

/** Notes that a tool was opened, feeding the Most Recent / Most Used sorts.
 *  Called from activateTool, so back/forward navigation counts too. You did
 *  go there, whichever control took you. */
function recordToolUsage(section: string, tool: string): void {
  const item = settings.sidebarItems.find((it) => it.key === `${section}/${tool}`);
  if (!item) return;
  item.lastUsedAt = Date.now();
  item.useCount = (item.useCount ?? 0) + 1;
  // Under a usage-driven mode the order this just changed is on screen, so it
  // has to be re-applied now rather than at next launch.
  if (settings.sidebarSort === "recent" || settings.sidebarSort === "used") {
    applySidebarOrder();
  }
  saveSettings();
}

/** A fresh default sidebarItems array. All tools pinned, in ALL_TOOLS order.
 *  Always call this rather than referencing a shared array literal: settings
 *  resets (`{...DEFAULT_SETTINGS}`) are shallow copies, so a single shared
 *  array instance would let a later reorder/pin mutation silently corrupt
 *  what "default" means for every future reset. */
function freshSidebarItems(): SidebarItemState[] {
  return ALL_TOOLS.map((t) => ({ key: t.key, pinned: true }));
}

/** Whether `target` is a startup target the app actually offers. Checked
 *  against #startupSelect's own options rather than a second hardcoded list,
 *  so the dropdown stays the single source of truth.
 *
 *  Hidden options still count as known values, which is the point: the
 *  category targets are shelved from the UI rather than removed, and anyone
 *  who set one before they were hidden keeps it through the shelving.
 *
 *  CSS.escape because this string can come from a hand-edited settings file
 *  and is being interpolated into a selector. */
function isKnownStartupTarget(target: string): boolean {
  return (
    startupSelect.querySelector(`option[value="${CSS.escape(target)}"]`) !== null
  );
}

/** Bounds for settings.fontScale, matching #fontScaleValue's min/max in
 *  index.html. Declared here because the HTML attributes were the ONLY thing
 *  enforcing this, and a number input does not actually prevent an
 *  out-of-range value being typed into it. */
const FONT_SCALE_MIN = -10;
const FONT_SCALE_MAX = 10;

/** Clamps a font scale into the usable range, mapping anything non-numeric to
 *  the default.
 *
 *  Worth being strict about: --font-scale feeds `font-size: calc(20px +
 *  var(--font-scale) * 1px)` on :root in shell.css, so a value of 500 renders
 *  the entire app at a ~520px root font. At that size the General Settings
 *  modal cannot be read, which means the control that would undo it is no
 *  longer usable and the only fix is hand-editing settings.json. NaN passes a
 *  bare `typeof === "number"` check, so it is excluded explicitly. */
function clampFontScale(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_SETTINGS.fontScale;
  }
  return Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, Math.round(value)));
}

/** Enforces the "After Time Passes" trigger's floor: an interval under 10
 *  seconds is too fast to be a deliberate "ambient" cycle and mostly just
 *  thrashes the theme, so seconds-denominated intervals are clamped up to at
 *  least 10. Every other unit (minutes/hours/days) already clears that floor
 *  at an amount of 1, so it's a no-op there. */
function clampCycleIntervalAmount(
  amount: number,
  unit: ShellSettings["cycleIntervalUnit"],
): number {
  return Math.max(unit === "seconds" ? 10 : 1, amount);
}

/** Whether a persisted value is a usable "HH:MM" 24-hour clock time, the format
 *  <input type="time"> reads and writes. Guards the Day/Night window fields at
 *  load, so a hand-edited settings file can't feed NaN into the schedule. */
export function isClockTime(value: unknown): value is string {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

/** Shortest span the Day/Night window may leave on either side of itself.
 *
 *  Equal times had to go: they describe no switch at all, which is the one
 *  thing this mode exists to do. A floor rather than a bare inequality because
 *  a one-minute night is the same non-answer wearing a hat. Half an hour is
 *  deliberately mild, though: a whole hour would rule out a legitimately short
 *  themed window (an evening theme from 20:00 to 20:45, say) to prevent
 *  nothing, since the boundary timer schedules to the exact edge and hits
 *  short windows precisely. One constant, easy to move if it ever chafes. */
const MIN_DAY_NIGHT_SPAN_MINUTES = 30;

const MINUTES_PER_DAY = 24 * 60;

function clockToMinutes(value: string): number {
  const [h, m] = value.split(":");
  return Number(h) * 60 + Number(m);
}

/** Whether a start/end pair leaves at least MIN_DAY_NIGHT_SPAN_MINUTES of BOTH
 *  day and night. Measured around the clock rather than as end-minus-start,
 *  because the window is allowed to wrap midnight: 07:00-06:40 is a 23h40m day
 *  and a 20-minute night, and it's the night that's too short there. */
export function isValidDayNightWindow(start: string, end: string): boolean {
  if (!isClockTime(start) || !isClockTime(end)) return false;
  const day = (clockToMinutes(end) - clockToMinutes(start) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const night = MINUTES_PER_DAY - day;
  return day >= MIN_DAY_NIGHT_SPAN_MINUTES && night >= MIN_DAY_NIGHT_SPAN_MINUTES;
}


/* =============================================================================
   STATE
============================================================================= */

let toastMetas: ToastMeta[] = [];
let toastCounter = 0;

// Guard + handle for the Alt+F4 / close-request interception (see Exit modal section).
let allowAppClose = false;
let unlistenCloseRequest: (() => void) | null = null;

// Mouse back/forward navigation history
let navHistory: NavEntry[] = [];
let navIndex = -1;
let isNavigatingHistory = false;

// In-memory shell state, kept in sync with disk so saveShellState never
// needs to read back from Rust just to preserve fields it isn't changing.
// Populated by loadShellState() on startup; updated incrementally thereafter.
let _lastTool: string | null = null;
let _lastToolSection: string | null = null;
let _lastCategory: string | null = null;

// App version string, fetched once during init and reused by both
// loadAppVersion() (display) and runStartupGates() (changelog gate).
let _appVersion = "";

/* =============================================================================
   ELEMENT REFS
============================================================================= */

const clockEl = document.getElementById("clock")!;
const toastContainer = document.getElementById("toastContainer")!;

const settingsBtn = document.getElementById("settingsBtn")!;
const closeBtn = document.getElementById("closeBtn")!;

const navItems = document.querySelectorAll<HTMLElement>(".nav-item");
const contentSections =
  document.querySelectorAll<HTMLElement>(".content-section");

const settingsBackdrop = document.getElementById("settingsBackdrop")!;
const settingsClose = document.getElementById("settingsClose")!;
const settingsReset = document.getElementById("settingsReset")!;
const fontScaleInput = document.getElementById(
  "fontScaleValue",
) as HTMLInputElement;
const timeFormatToggle = document.getElementById(
  "timeFormatToggle",
) as HTMLInputElement;
const timeFormatLabel = document.getElementById("timeFormatLabel")!;
export const themeSelect = document.getElementById(
  "themeSelect",
) as HTMLSelectElement;
const rerollBtn = document.getElementById("rerollBtn") as HTMLButtonElement;
const randomModeToggle = document.getElementById(
  "randomModeToggle",
) as HTMLInputElement;
const randomModeLabel = document.getElementById("randomModeLabel")!;
const randomPaletteToggle = document.getElementById(
  "randomPaletteToggle",
) as HTMLInputElement;
const randomPaletteLabel = document.getElementById("randomPaletteLabel")!;
const solidModalsToggle = document.getElementById(
  "solidModalsToggle",
) as HTMLInputElement;
const solidModalsLabel = document.getElementById("solidModalsLabel")!;
const dateFormatToggle = document.getElementById(
  "dateFormatToggle",
) as HTMLInputElement;
const dateFormatLabel = document.getElementById("dateFormatLabel")!;
export const startupSelect = document.getElementById(
  "startupSelect",
) as HTMLSelectElement;


const cycleOrderToggle = document.getElementById("cycleOrderToggle") as HTMLInputElement;
const cycleOrderLabel = document.getElementById("cycleOrderLabel")!;
const cycleTriggerSelect = document.getElementById("cycleTriggerSelect") as HTMLSelectElement;
const cycleIntervalAmountInput = document.getElementById("cycleIntervalAmount") as HTMLInputElement;
const cycleIntervalUnitSelect = document.getElementById("cycleIntervalUnit") as HTMLSelectElement;
export const cycleDayThemeSelect = document.getElementById("cycleDayThemeSelect") as HTMLSelectElement;
export const cycleNightThemeSelect = document.getElementById("cycleNightThemeSelect") as HTMLSelectElement;
const cycleDayStartInput = document.getElementById("cycleDayStart") as HTMLInputElement;
const cycleDayEndInput = document.getElementById("cycleDayEnd") as HTMLInputElement;
const cycleIncludeCustomToggle = document.getElementById("cycleIncludeCustomToggle") as HTMLInputElement;
const cycleIncludeCustomLabel = document.getElementById("cycleIncludeCustomLabel")!;
const cycleHolidayOverrideToggle = document.getElementById("cycleHolidayOverrideToggle") as HTMLInputElement;
const cycleHolidayOverrideLabel = document.getElementById("cycleHolidayOverrideLabel")!;
const cycleHolidaySeasonOnlyToggle = document.getElementById("cycleHolidaySeasonOnlyToggle") as HTMLInputElement;
const cycleHolidaySeasonOnlyLabel = document.getElementById("cycleHolidaySeasonOnlyLabel")!;
const cycleHolidayFullSeasonToggle = document.getElementById("cycleHolidayFullSeasonToggle") as HTMLInputElement;
const cycleHolidayFullSeasonLabel = document.getElementById("cycleHolidayFullSeasonLabel")!;
const cycleNowBtn = document.getElementById("cycleNowBtn") as HTMLButtonElement;

const appVersionEl = document.getElementById("appVersion");

const exitBackdrop = document.getElementById("exitBackdrop")!;
const exitConfirmBtn = document.getElementById("exitConfirmBtn")!;
const exitCancelBtn = document.getElementById("exitCancelBtn")!;

const backupReminderBackdrop = document.getElementById(
  "backupReminderBackdrop",
)!;
const backupReminderDaysEl = document.getElementById("backupReminderDays")!;
const backupReminderGoBtn = document.getElementById("backupReminderGoBtn")!;
const backupReminderCancelBtn = document.getElementById(
  "backupReminderCancelBtn",
)!;

const budgetReminderBackdrop = document.getElementById(
  "budgetReminderBackdrop",
)!;
const budgetReminderDaysEl = document.getElementById("budgetReminderDaysEl")!;
const budgetReminderGoBtn = document.getElementById("budgetReminderGoBtn")!;
const budgetReminderReviewedBtn = document.getElementById(
  "budgetReminderReviewedBtn",
)!;
const budgetReminderCancelBtn = document.getElementById(
  "budgetReminderCancelBtn",
)!;

/* =============================================================================
   CLOCK
============================================================================= */

function updateClock(): void {
  const now = new Date();
  let date: string;
  if (settings.americanDates) {
    // MM/DD/YYYY
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    const y = now.getFullYear();
    date = `${m}/${d}/${y}`;
  } else {
    // YYYY-MM-DD (default)
    date = now.toLocaleDateString("en-CA");
  }
  const time = now.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: settings.hour12,
  });
  clockEl.textContent = `${date}  ${time}`;
}

setInterval(updateClock, 1000);
updateClock();

/**
 * Escapes a string for safe interpolation into innerHTML templates. Both as
 * element text AND inside double-quoted attribute values (hence &quot;).
 *
 * Most of the app builds DOM via createElement + textContent, which needs no
 * escaping. This exists for the handful of places that interpolate
 * user-entered strings (bill names, image filenames, filename prefixes…)
 * into template literals assigned to innerHTML. Unescaped, a value like
 * `<img src=x onerror=…>` executes as script inside the webview, and in a
 * Tauri app, webview script can reach every registered backend command.
 * Every `${...}` carrying user data inside an innerHTML template must pass
 * through this.
 */
export function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* =============================================================================
   DEV-ONLY DIAGNOSTICS
   -----------------------------------------------------------------------------
   Error-path logging that stays out of production builds. In a `vite build`,
   import.meta.env.DEV resolves to a compile-time `false`, so these calls never
   run in the shipped app (the console stays clean for end users) while
   `npm run dev` keeps full diagnostics. The cast lets this typecheck without
   relying on the `vite/client` ambient types being in scope.
============================================================================= */

const __DEV__: boolean =
  (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV === true;

/** console.error, but silent in production builds. */
export function devError(...args: unknown[]): void {
  if (__DEV__) console.error(...args);
}

/** console.warn, but silent in production builds. */
export function devWarn(...args: unknown[]): void {
  if (__DEV__) console.warn(...args);
}

/* =============================================================================
   SIDEBAR NAVIGATION
============================================================================= */

/** The currently visible view, as "section/tool" (tool empty on landing pages).
 *  Used to detect leaving a tool so tools with pending state can flush it. */
export let _activeViewKey = "";

/* ── Per-view scroll position ──
   Every section shares one scroll container (#mainContent); the inactive ones
   are display:none, not separate scrollers. So without this, scrolling halfway
   down Budget and then opening Time Tracker leaves you halfway down Time
   Tracker, because scrollTop never moved.

   Two different behaviours are wanted, and the difference is intent rather
   than destination:
     - Going somewhere NEW (sidebar icon, Home card, tool card) should start at
       the top, the way opening a page does.
     - Coming BACK (the header back button, mouse back/forward) should land
       where you left off, the way returning to a page does.

   So the position is remembered per view on the way out, and the entry points
   that represent an explicit jump opt into "top" instead. Default is restore,
   which means a path that forgets to declare itself behaves like Back rather
   than silently discarding the user's place. */
const _viewScroll = new Map<string, number>();
let _scrollIntent: "top" | "restore" = "restore";

/** Marks the next view change as an explicit jump to somewhere new, which
 *  lands at the top instead of restoring. Consumed by applyViewScroll(). */
function scrollToTopOnNextView(): void {
  _scrollIntent = "top";
}

/** Applies the pending intent, then resets it. Called at the END of
 *  activateTool/activateLanding, once the target view is actually displayed:
 *  scrollTop clamps to scrollHeight, so setting it while every view is still
 *  hidden would clamp to 0 and quietly lose the restore. */
function applyViewScroll(): void {
  const top = _scrollIntent === "top" ? 0 : (_viewScroll.get(_activeViewKey) ?? 0);
  _scrollIntent = "restore";
  document.getElementById("mainContent")!.scrollTop = top;
}

/** Switches the active nav item and content section, does NOT touch tool/landing state.
 *  When toolKey is given, only nav items whose data-tool matches are marked active.
 *  This lets two sidebar items point at the same section (e.g. Auto-Backup and Dummy
 *  File Generator both live in "files") and still highlight independently.
 *  Also triggers a palette regeneration when the theme is set to Regenerative Random. */
function switchSection(sectionKey: string, toolKey?: string): void {
  // Fire tool-exit hooks BEFORE the view changes. Budget debounces its saves
  // (400 ms), so an edit made just before navigating away would otherwise
  // still be sitting in the queue when the tool re-locks or the state resets.
  const nextViewKey = `${sectionKey}/${toolKey ?? ""}`;
  if (_activeViewKey === "finance/budget" && nextViewKey !== "finance/budget") {
    onBudgetToolExit();
  }
  // Bank the outgoing view's scroll position. Guarded on the key actually
  // changing because activateSection() routes through here twice for one
  // navigation (once itself, then again via activateTool/activateLanding);
  // the second pass would otherwise overwrite the entry we just saved with
  // the scrollTop of the view we are arriving at.
  if (_activeViewKey && _activeViewKey !== nextViewKey) {
    _viewScroll.set(_activeViewKey, document.getElementById("mainContent")!.scrollTop);
  }
  _activeViewKey = nextViewKey;

  // Mirrored onto <body> so CSS outside the tool view can key off which tool
  // is open. Modals live at body level, not inside the tool's own subtree, so
  // a theme that colours per tool (Blades) has no other way to reach them.
  // Same "section/tool" key ALL_TOOLS uses; absent entirely on Home and on a
  // category landing, which is what makes `body[data-active-tool]` mean "a
  // tool is open" rather than "a tool was last open".
  if (toolKey) {
    document.body.dataset.activeTool = `${sectionKey}/${toolKey}`;
  } else {
    delete document.body.dataset.activeTool;
  }

  navItems.forEach((item) => {
    const matchesSection = item.dataset.section === sectionKey;
    const matchesTool = item.dataset.tool
      ? item.dataset.tool === toolKey
      : true;
    item.classList.toggle("active", matchesSection && matchesTool);
  });
  contentSections.forEach((section) => {
    section.classList.toggle("active", section.id === `section-${sectionKey}`);
  });
  // Regenerative random mode re-rolls on every view change (guarded + deduped
  // inside maybeRegenerateRandom).
  maybeRegenerateRandom();
}

/** Called when a sidebar icon is clicked, always resets to landing or default tool.
 *  If the section element has a data-default-tool attribute, goes directly to
 *  that tool instead of the landing page (used for single-tool sections). */
export function activateSection(sectionKey: string): void {
  const sectionEl = document.getElementById(`section-${sectionKey}`);
  // A key with no matching section element used to fall through to
  // activateLanding(), which renders an empty content area, and then
  // saveShellState() wrote the bad key straight back to disk, so the empty
  // view survived every restart. Home instead.
  //
  // This is NOT about the category sections. Those are only shelved from the
  // nav UI, not removed: section-utility/files/media/music/finance/games all
  // still exist in index.html, so activateSection("utility") resolves normally
  // today and will keep doing so when categories come back. Nor is it about
  // "lastCategory", which has its own branch in loadShellState() and resolves
  // through state.lastCategory. What reaches this guard is a key with no
  // section at all: a hand-edited settings file, or a stale shell-state naming
  // a section that no longer exists.
  if (!sectionEl && sectionKey !== "home") {
    console.warn(`[nav] no section "${sectionKey}", falling back to home`);
    activateSection("home");
    return;
  }

  switchSection(sectionKey);

  const defaultTool = sectionEl?.dataset.defaultTool;
  if (defaultTool) {
    activateTool(sectionKey, defaultTool);
  } else {
    activateLanding(sectionKey);
    saveShellState(sectionKey);
  }
}

/** Wraps activateTool() for explicit user clicks only (sidebar icon, Home
 *  tile, tool-card, reminder "Go" button), never for mouse back/forward
 *  replay or restored-state entry, which call activateTool() directly. Game
 *  Stats uses this to jump back to its tile view even when the icon is clicked
 *  while the tool is already open; see onGameStatsIconClicked(). */
function activateToolFromClick(section: string, tool: string): void {
  scrollToTopOnNextView();
  activateTool(section, tool);
  if (section === "games" && tool === "game-stats") onGameStatsIconClicked();
}

/** activateSection() for explicit user clicks only (sidebar icon with no tool,
 *  Home card header, dashboard button with no tool). The header back buttons
 *  call activateSection() directly so that returning to Home restores where
 *  you were on it, which is the whole point of the split. */
function activateSectionFromClick(section: string): void {
  scrollToTopOnNextView();
  activateSection(section);
}

navItems.forEach((item) => {
  item.addEventListener("click", () => {
    const section = item.dataset.section;
    const tool = item.dataset.tool;
    if (!section) return;
    if (tool) {
      activateToolFromClick(section, tool);
    } else {
      activateSectionFromClick(section);
    }
  });
});

document.getElementById("sidebarToggle")!.addEventListener("click", () => {
  document.getElementById("sidebar")!.classList.toggle("expanded");
});

/* =============================================================================
   TOOL NAVIGATION
   Categories have been retired. Home and the sidebar both link straight to
   tools now. This still handles two patterns, kept generic on purpose so the
   archived category markup (commented out in index.html) would "just work"
   again if it's ever restored:
   1. Dashboard tool buttons  (data-section + data-tool) → go to section, open tool
:      also the pattern used by the new flat Home tool cards
   2. Category card headers   (data-section, no data-tool) → go to section landing
:      currently unreachable; only archived category markup used this
   3. Tool card clicks        (.tool-card with data-section + data-tool) → open tool
:      also the pattern used by the new flat Home tool cards
============================================================================= */

/** Shows a specific tool view within a section, hiding the category landing and section header.
 *  Persists state to disk and pushes an entry onto the nav history stack. */
function activateTool(section: string, tool: string): void {
  switchSection(section, tool);

  // Hide the section header (category title), not needed when inside a tool
  const sectionHeader = document.querySelector<HTMLElement>(
    `#section-${section} > .section-header`,
  );
  if (sectionHeader) sectionHeader.style.display = "none";

  // Hide the landing grid
  const landing = document.getElementById(`${section}-landing`);
  if (landing) landing.style.display = "none";

  // Hide all tool views, then show the requested one
  document
    .querySelectorAll<HTMLElement>(`#section-${section} .tool-view`)
    .forEach((v) => {
      v.style.display = "none";
    });

  const view = document.getElementById(`${section}-tool-${tool}`);
  if (view) view.style.display = "flex";

  // Notify tools that need to gate entry (e.g. Budget encryption auth,
  // Auto-Backup's first-entry disclaimer)
  if (section === "finance" && tool === "budget") onBudgetToolEntry();
  if (section === "games" && tool === "game-stats") onGameStatsToolEntry();
  if (section === "files" && tool === "auto-backup") onAutoBackupToolEntry();

  saveShellState(section, tool);
  pushNavHistory(section, tool);
  recordToolUsage(section, tool);
  applyViewScroll();
}

/** Returns to the category landing page, restoring the section header and hiding all tool views. */
function activateLanding(section: string): void {
  switchSection(section);

  // Restore the section header
  const sectionHeader = document.querySelector<HTMLElement>(
    `#section-${section} > .section-header`,
  );
  if (sectionHeader) sectionHeader.style.display = "";

  // Hide all tool views
  document
    .querySelectorAll<HTMLElement>(`#section-${section} .tool-view`)
    .forEach((v) => {
      v.style.display = "none";
    });

  // Show the landing grid
  const landing = document.getElementById(`${section}-landing`);
  if (landing) landing.style.display = "block";
  pushNavHistory(section);
  applyViewScroll();
}

// Dashboard tool buttons and category card headers
document.querySelectorAll<HTMLElement>(".dashboard-tool-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const section = btn.dataset.section!;
    const tool = btn.dataset.tool;
    if (tool) {
      activateToolFromClick(section, tool);
    } else {
      activateSectionFromClick(section);
    }
  });
});

document
  .querySelectorAll<HTMLElement>(".dashboard-card-header[data-section]")
  .forEach((hdr) => {
    hdr.addEventListener("click", () => {
      activateSectionFromClick(hdr.dataset.section!);
    });
  });

// Tool cards on category landing pages
document
  .querySelectorAll<HTMLElement>(".tool-card[data-tool]")
  .forEach((card) => {
    card.addEventListener("click", () => {
      activateToolFromClick(card.dataset.section!, card.dataset.tool!);
    });
  });

// Back buttons inside tool views, categories have been retired, so these now
// always return to Home (previously: back to the category landing page).
document
  .querySelectorAll<HTMLElement>(".tool-back-btn[data-section]")
  .forEach((btn) => {
    btn.addEventListener("click", () => {
      activateSection("home");
    });
  });

// Back buttons on category landing pages, return to Home
document.querySelectorAll<HTMLElement>(".section-back-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    activateSection("home");
  });
});

/* =============================================================================
   SHELL STATE  (active section persistence)
============================================================================= */

/** Persists the current navigation position to disk.
 *  Uses in-memory _last* vars to avoid a disk read. They are seeded by
 *  loadShellState() on startup and kept current on every call. */
async function saveShellState(
  activeSection: string,
  activeTool?: string,
): Promise<void> {
  // Update in-memory tracking fields. No disk read needed.
  // _last* vars are seeded from disk by loadShellState() at startup and kept
  // current here, so we always have the right values without a round-trip.
  if (activeTool) {
    _lastTool = activeTool;
    _lastToolSection = activeSection;
  }
  if (activeSection !== "home") {
    _lastCategory = activeSection;
  }

  try {
    await invoke("save_shell_state", {
      data: JSON.stringify({
        activeSection,
        activeTool: activeTool ?? null,
        lastTool: _lastTool,
        lastToolSection: _lastToolSection,
        lastCategory: _lastCategory,
      }),
    });
  } catch {
    // Non-critical
  }
}

/** Reads persisted shell state on startup, seeds in-memory tracking vars, and
 *  navigates to the appropriate view based on the startupTarget setting.
 *  Target modes: "lastView" (exact restore), "lastTool", "lastCategory", "home",
 *  "section:tool-id" (specific tool), or a bare section key. */
/** Activates a tool, unless it's currently hidden (unpinned), in which case
 *  Home is shown instead. Every startup-navigation path in loadShellState()
 *  routes through this rather than calling activateTool() directly, so a
 *  tool hidden via the Edit Sidebar modal is never landed on at launch, per
 *  spec. Relies on settings.sidebarItems already being loaded, init() awaits
 *  loadSettings() before loadShellState() runs. */
function activateToolIfPinned(section: string, tool: string): void {
  if (isToolPinned(`${section}/${tool}`)) {
    activateTool(section, tool);
  } else {
    activateSection("home");
  }
}

/* =============================================================================
   GENTLE NUDGE TOASTS
   -----------------------------------------------------------------------------
   Gentle is the toast half of the startup nudges (the Aggressive half is a
   modal). Three of them can come due on the same launch, and firing them
   together stacks three toasts in the corner at once, which is a wall of text
   nobody reads, and defeats the point of the quiet option.

   So a Gentle nudge holds the queue in runStartupNudges() for as long as its
   toast is up, exactly as an Aggressive one holds it until dismissed. Same
   contract, so the queue doesn't have to care which mode each nudge is in.

   One duration for all three rather than each keeping its own: they're read one
   after another now, so a nudge that lingered twice as long as its neighbour
   would just be an unexplained pause in the sequence.
============================================================================= */

const GENTLE_NUDGE_TOAST_MS = 5000;
/** Breathing room after a toast expires before the next nudge starts, so they
 *  read as separate messages rather than one replacing another mid-glance. */
const GENTLE_NUDGE_GAP_MS = 400;

/** Fires a Gentle nudge toast and resolves once it has had the screen to
 *  itself. The wait is a fixed timer rather than anything hooked into the toast
 *  itself: toasts pause their own countdown while the app is hidden, so on an
 *  alt-tabbed launch these can still overlap slightly. Not worth threading a
 *  completion callback through the toast system for a cosmetic edge case. */
export function gentleNudge(message: string): Promise<void> {
  flash(message, "success", GENTLE_NUDGE_TOAST_MS);
  return new Promise<void>((resolve) =>
    setTimeout(resolve, GENTLE_NUDGE_TOAST_MS + GENTLE_NUDGE_GAP_MS),
  );
}

/** Trims an absolute path down to "parentFolder\file.ext" for display in a
 *  toast. The full C:\Users\<name>\Downloads\... form wraps to three lines and
 *  buries the only part that identifies the file; the parent folder is all the
 *  context a "saved it here" message needs. Falls back to the input unchanged
 *  if there's nothing to trim. */
export function shortPath(fullPath: string): string {
  const parts = fullPath.split(/[\\/]/).filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join("\\") : fullPath;
}

/** Length of one attention-pulse cycle. MUST match the animation-duration on
 *  #aboutBtn.update-available / .nav-item.attention-pulse (shell.css) and
 *  .tool-card.attention-pulse (landing.css). This is what those animations
 *  get phase-locked against. */
const ATTENTION_PULSE_MS = 2000;

/** Toggles an attention-pulse class and locks the animation's phase to a clock
 *  every pulsing element shares.
 *
 *  A CSS animation starts counting from the moment its class lands, and these
 *  classes land whenever their reason turns up: the update check on a network
 *  round-trip, the tool reminders during their tool's init, seconds apart. Same
 *  2s period, different start times, and two things pulsing at the same rate
 *  but out of phase don't read as "offset", they read as one of them running
 *  slower than the others. A negative animation-delay drops the element into
 *  the cycle wherever the shared clock already is, so everything peaks together
 *  no matter when it started.
 *
 *  (performance.now() shares its origin with the document timeline the
 *  animations run on. Even if it didn't, every element would inherit the same
 *  offset, being in phase with EACH OTHER is the whole requirement.)
 *
 *  No-ops when the class is already in the requested state, so the repeat calls
 *  from Budget's per-edit refresh don't rewrite style on every keystroke. */
function setAttentionPulse(
  el: HTMLElement,
  className: string,
  on: boolean,
): void {
  if (el.classList.contains(className) === on) return;
  el.classList.toggle(className, on);
  el.style.animationDelay = on
    ? `-${performance.now() % ATTENTION_PULSE_MS}ms`
    : "";
}

/** Raises or clears the update pulse on the About icon. Wired here rather than
 *  in docs.ts so it shares setAttentionPulse's phase lock with the tool
 *  signals. The About icon drifting against the sidebar was exactly the bug
 *  that lock exists to fix. */
export function setAboutUpdatePulse(on: boolean): void {
  const aboutBtn = document.getElementById("aboutBtn");
  if (aboutBtn) setAttentionPulse(aboutBtn, "update-available", on);
}

/** Raises or clears the "this tool is owed something" signal for a tool: the
 *  sidebar row pulse and every dashboard card for it. Owned here rather than in
 *  each tool because the two live in shell-owned markup and must move together
 *:  a reminder that lit one and forgot the other would be a signal that
 *  contradicts itself depending on where you happened to be looking.
 *
 *  Cards are plural: each tool has one on the Home dashboard and another on its
 *  category landing page, and it's the same card in two places.
 *
 *  Called by Auto-Backup (backup overdue) and Budget (not updated in a while);
 *  the About icon goes through setAboutUpdatePulse, since it isn't a tool and
 *  has no card. */
export function setToolAttention(
  section: string,
  tool: string,
  on: boolean,
): void {
  const navItem = document.querySelector<HTMLElement>(
    `.nav-item[data-section="${section}"][data-tool="${tool}"]`,
  );
  if (navItem) setAttentionPulse(navItem, "attention-pulse", on);

  document
    .querySelectorAll<HTMLElement>(
      `.tool-card[data-section="${section}"][data-tool="${tool}"]`,
    )
    .forEach((card) => setAttentionPulse(card, "attention-pulse", on));
}

async function loadShellState(): Promise<void> {
  try {
    const raw = await invoke<string>("load_shell_state");
    const state = JSON.parse(raw);

    // Seed in-memory tracking from persisted state so saveShellState
    // never needs to read back from disk to preserve these fields.
    _lastTool = state.lastTool ?? null;
    _lastToolSection = state.lastToolSection ?? null;
    _lastCategory = state.lastCategory ?? null;

    const target = settings.startupTarget ?? "lastView";

    if (target === "lastView") {
      // Restore exactly where the user left off, tool, landing, or home
      if (state.activeTool && state.activeSection) {
        activateToolIfPinned(state.activeSection, state.activeTool);
      } else if (state.activeSection) {
        activateSection(state.activeSection);
      } else {
        activateSection("home");
      }
    } else if (target === "lastTool") {
      // Restore the last tool opened, regardless of where the user closed from
      if (state.lastTool && state.lastToolSection) {
        activateToolIfPinned(state.lastToolSection, state.lastTool);
      } else {
        activateSection("home");
      }
    } else if (target === "lastCategory") {
      // Restore the last real category visited, never Home
      if (state.lastCategory) {
        activateSection(state.lastCategory);
      } else {
        activateSection("home");
      }
    } else if (target === "home") {
      activateSection("home");
    } else if (target.includes(":")) {
      // Specific tool, format is "section:tool-id"
      const [section, tool] = target.split(":");
      activateToolIfPinned(section, tool);
    } else {
      // Specific category, value matches a section key (e.g. "utility", "music")
      activateSection(target);
    }
  } catch {
    activateSection("home");
  }
}

/* =============================================================================
   MOUSE BACK / FORWARD NAVIGATION
============================================================================= */

/** Records the current view in the nav history stack.
 *  No-ops when called during a history traversal, or when the entry is
 *  identical to the one already at the current position. */
function pushNavHistory(section: string, tool?: string): void {
  if (isNavigatingHistory) return;
  if (navIndex >= 0) {
    const cur = navHistory[navIndex];
    if (cur.section === section && cur.tool === tool) return;
  }
  // Truncate any forward history that exists beyond the current position
  navHistory = navHistory.slice(0, navIndex + 1);
  navHistory.push({ section, tool });
  navIndex = navHistory.length - 1;
}

/** Navigates to the previous entry in the history stack (mouse button 3 / back). */
function navigateBack(): void {
  if (navIndex <= 0) return;
  navIndex--;
  const entry = navHistory[navIndex];
  isNavigatingHistory = true;
  if (entry.tool) {
    activateTool(entry.section, entry.tool);
  } else {
    activateLanding(entry.section);
    saveShellState(entry.section);
  }
  isNavigatingHistory = false;
}

/** Navigates to the next entry in the history stack (mouse button 4 / forward). */
function navigateForward(): void {
  if (navIndex >= navHistory.length - 1) return;
  navIndex++;
  const entry = navHistory[navIndex];
  isNavigatingHistory = true;
  if (entry.tool) {
    activateTool(entry.section, entry.tool);
  } else {
    activateLanding(entry.section);
    saveShellState(entry.section);
  }
  isNavigatingHistory = false;
}

/** Lets a tool with its own internal sub-pages (e.g. Game Stats' Home/New
 *  Game/Historical/Stats views) claim the mouse back/forward buttons while
 *  it's the active tool. back()/forward() should return true once they've
 *  handled the navigation themselves, or false to fall through to this
 *  shell's own section/tool-level history (e.g. once the tool's own
 *  sub-history is exhausted). Only one tool can hold this at a time; a tool
 *  that isn't currently visible should just return false from both. */
export type SubNavHandler = { back: () => boolean; forward: () => boolean };
let activeSubNavHandler: SubNavHandler | null = null;
export function setSubNavHandler(handler: SubNavHandler | null): void {
  activeSubNavHandler = handler;
}

/* Mouse button 3 = back, button 4 = forward (the extra side buttons on most
   mice).

   Registered in the CAPTURE phase on `window` (the earliest point in the
   dispatch) rather than bubbling up to `document`. A focused form control
   (e.g. a score cell in Game Stats' round grid) sits deep in the tree, and
   anything between it and `document` that consumes the event would silently
   swallow the navigation; capturing at the root can't be pre-empted.

   The active element is also blurred BEFORE navigating. An <input> that loses
   focus as a side effect of its view being hidden fires its `change` event
   afterwards, so the edit would be committed against a screen that has
   already been swapped out. Blurring first lets that commit run against the
   view it was actually made in. */
window.addEventListener(
  "mousedown",
  (e: MouseEvent) => {
    if (e.button !== 3 && e.button !== 4) return;
    e.preventDefault();

    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) active.blur();

    if (e.button === 3) {
      if (activeSubNavHandler?.back()) return;
      navigateBack();
    } else {
      if (activeSubNavHandler?.forward()) return;
      navigateForward();
    }
  },
  true,
);

// Suppress WebView2/Chromium's built-in "Turn on caret browsing?" prompt.
// F7 toggles it by default in every Chromium-based webview; nothing in this
// app uses caret browsing, so the prompt is just an accidental-keypress
// trap. Capturing phase + stopImmediatePropagation() so this runs before
// (and blocks) the webview's own default handling of the key, which is what
// actually shows the dialog.
window.addEventListener(
  "keydown",
  (e: KeyboardEvent) => {
    if (e.key === "F7") {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  },
  { capture: true },
);

/* =============================================================================
   SETTINGS: LOAD / SAVE / APPLY
============================================================================= */

/** Pushes all current settings values into the UI controls and re-applies
 *  theme, font scale, and clock format. Safe to call at any time. */
export function applySettings(): void {
  document.documentElement.style.setProperty(
    "--font-scale",
    String(settings.fontScale),
  );
  timeFormatLabel.textContent = settings.hour12 ? "12-hour" : "24-hour";
  timeFormatToggle.checked = settings.hour12;
  fontScaleInput.value = String(settings.fontScale);
  solidModalsToggle.checked = settings.solidModals;
  solidModalsLabel.textContent = settings.solidModals ? "On" : "Off";
  document.body.classList.toggle("solid-modals", settings.solidModals);
  dateFormatToggle.checked = settings.americanDates;
  dateFormatLabel.textContent = settings.americanDates
    ? "MM-DD-YYYY"
    : "YYYY-MM-DD";
  startupSelect.value = settings.startupTarget;
  loadSoundPack(settings.soundPack);
  refreshSoundPackCurrentBadge();
  applyToastVolumeSettings();
  themeSelect.value = settings.theme;
  refreshThemeCurrentBadge();

  // The Random tab's settings panel (visibility + enabled/greyed state) is
  // managed by renderThemePickerTab() as that tab is shown, not here, just
  // keep the control values themselves in sync so they're correct whenever
  // that panel is shown/enabled.
  randomModeToggle.checked = settings.randomPersistent;
  randomModeLabel.textContent = settings.randomPersistent
    ? "Persistent"
    : "Regenerative";
  randomPaletteToggle.checked = settings.randomHarmonized;
  randomPaletteLabel.textContent = settings.randomHarmonized
    ? "Harmonized"
    : "Chaotic";

  // Same story for the Cycle tab's settings panel.
  populateDayNightThemeSelects();
  cycleDayStartInput.value = settings.cycleDayStart;
  cycleDayEndInput.value = settings.cycleDayEnd;
  cycleOrderToggle.checked = settings.cycleOrder === "random";
  cycleOrderLabel.textContent = settings.cycleOrder === "random" ? "Random" : "Sequential";
  cycleTriggerSelect.value = settings.cycleTrigger;
  cycleIntervalAmountInput.min = settings.cycleIntervalUnit === "seconds" ? "10" : "1";
  cycleIntervalAmountInput.value = String(settings.cycleIntervalAmount);
  cycleIntervalUnitSelect.value = settings.cycleIntervalUnit;
  cycleIncludeCustomToggle.checked = settings.cycleIncludeCustom;
  cycleIncludeCustomLabel.textContent = settings.cycleIncludeCustom ? "On" : "Off";
  cycleHolidayOverrideToggle.checked = settings.cycleHolidayOverride;
  cycleHolidayOverrideLabel.textContent = settings.cycleHolidayOverride ? "On" : "Off";
  cycleHolidaySeasonOnlyToggle.checked = settings.cycleHolidaySeasonOnly;
  cycleHolidaySeasonOnlyLabel.textContent = settings.cycleHolidaySeasonOnly ? "On" : "Off";
  cycleHolidayFullSeasonToggle.checked = settings.cycleHolidayFullSeason;
  cycleHolidayFullSeasonLabel.textContent = settings.cycleHolidayFullSeason ? "On" : "Off";
  syncCycleSettingsVisibility();

  applyLockSettings();
  applyUpdateSettings();
  applyTheme(settings.theme);
  applySidebarOrder();
  updateClock();
}

/** Persists the shell's settings via a MERGE, not a whole-file write.
 *  settings.json has multiple owners (shell here, Time Tracker's and Budget's
 *  tool settings live alongside), and the shell's `settings` object holds
 *  ONLY shell-owned keys (its loadSettings whitelist guarantees that) so a
 *  whole-file JSON.stringify(settings) was erasing every tool key on disk
 *  each time any main setting changed. merge_settings patches exactly the
 *  keys present and preserves everything else. Non-critical, a failure
 *  flashes an error but does not block anything. */
export async function saveSettings(): Promise<void> {
  try {
    await invoke("merge_settings", { patch: JSON.stringify(settings) });
  } catch {
    flash("Failed to save settings", "error");
  }
}

/** Validates a loaded sidebarItems value against ALL_TOOLS: drops entries
 *  with the wrong shape or an unknown key (e.g. a tool removed since this was
 *  saved), de-dupes repeated keys, and appends any ALL_TOOLS entry missing
 *  from the loaded array (e.g. a tool added since this was saved) as pinned
 *  at the end, so a fresh install and an upgrade both always cover every
 *  known tool exactly once. */
function normalizeSidebarItems(raw: unknown): SidebarItemState[] {
  const candidates: SidebarItemState[] = Array.isArray(raw)
    ? raw.filter(
        (it): it is SidebarItemState =>
          it !== null &&
          typeof it === "object" &&
          typeof (it as SidebarItemState).key === "string" &&
          typeof (it as SidebarItemState).pinned === "boolean" &&
          ALL_TOOLS.some((t) => t.key === (it as SidebarItemState).key),
      )
    : [];

  const deduped: SidebarItemState[] = [];
  const seen = new Set<string>();
  for (const it of candidates) {
    if (seen.has(it.key)) continue;
    seen.add(it.key);
    deduped.push(it);
  }

  const missing = ALL_TOOLS.filter((t) => !seen.has(t.key)).map((t) => ({ key: t.key, pinned: true }));
  return [...deduped, ...missing];
}

/** Loads settings from disk, merges over defaults (so new settings get their
 *  default values on first run or after a partial write), then applies them. */
async function loadSettings(): Promise<void> {
  try {
    const raw = await invoke<string>("load_settings");
    const parsed = JSON.parse(raw);
    // Merge parsed values over defaults, then coerce each field so a bad value
    // in the JSON (wrong type, old enum value, etc.) falls back to the default
    // rather than propagating as-is into applySettings().
    const merged = { ...DEFAULT_SETTINGS, ...parsed };
    setSettings({
      fontScale: clampFontScale(merged.fontScale),
      hour12:
        typeof merged.hour12 === "boolean"
          ? merged.hour12
          : DEFAULT_SETTINGS.hour12,
      americanDates:
        typeof merged.americanDates === "boolean"
          ? merged.americanDates
          : DEFAULT_SETTINGS.americanDates,
      solidModals:
        typeof merged.solidModals === "boolean"
          ? merged.solidModals
          : DEFAULT_SETTINGS.solidModals,
      startupTarget:
        typeof merged.startupTarget === "string" &&
        isKnownStartupTarget(merged.startupTarget)
          ? merged.startupTarget
          : DEFAULT_SETTINGS.startupTarget,
      // Renames are mapped here so the corrected id is what gets persisted on
      // the next save. It runs on every stored theme id, not just this one, or
      // a Cycle day/night pick silently stops resolving. Note this only handles
      // RENAMES: an id that was never valid is caught later by resolveThemeId()
      // at paint time, which is also where ids that can't be checked yet (a
      // custom theme's, since custom themes load after settings do) get their
      // one and only validation.
      theme:
        typeof merged.theme === "string"
          ? migrateThemeId(merged.theme)
          : DEFAULT_SETTINGS.theme,
      randomPersistent:
        typeof merged.randomPersistent === "boolean"
          ? merged.randomPersistent
          : DEFAULT_SETTINGS.randomPersistent,
      randomHarmonized:
        typeof merged.randomHarmonized === "boolean"
          ? merged.randomHarmonized
          : DEFAULT_SETTINGS.randomHarmonized,
      cycleOrder:
        merged.cycleOrder === "sequential" || merged.cycleOrder === "random"
          ? merged.cycleOrder
          : DEFAULT_SETTINGS.cycleOrder,
      cycleTrigger:
        merged.cycleTrigger === "onStartup" ||
        merged.cycleTrigger === "time" ||
        merged.cycleTrigger === "everything" ||
        merged.cycleTrigger === "click" ||
        merged.cycleTrigger === "dayNight"
          ? merged.cycleTrigger
          : DEFAULT_SETTINGS.cycleTrigger,
      cycleIntervalAmount: clampCycleIntervalAmount(
        typeof merged.cycleIntervalAmount === "number" && merged.cycleIntervalAmount > 0
          ? merged.cycleIntervalAmount
          : DEFAULT_SETTINGS.cycleIntervalAmount,
        merged.cycleIntervalUnit === "seconds" ||
          merged.cycleIntervalUnit === "minutes" ||
          merged.cycleIntervalUnit === "hours" ||
          merged.cycleIntervalUnit === "days"
          ? merged.cycleIntervalUnit
          : DEFAULT_SETTINGS.cycleIntervalUnit,
      ),
      cycleIntervalUnit:
        merged.cycleIntervalUnit === "seconds" ||
        merged.cycleIntervalUnit === "minutes" ||
        merged.cycleIntervalUnit === "hours" ||
        merged.cycleIntervalUnit === "days"
          ? merged.cycleIntervalUnit
          : DEFAULT_SETTINGS.cycleIntervalUnit,
      cycleIncludeCustom:
        typeof merged.cycleIncludeCustom === "boolean"
          ? merged.cycleIncludeCustom
          : DEFAULT_SETTINGS.cycleIncludeCustom,
      cycleHolidayOverride:
        typeof merged.cycleHolidayOverride === "boolean"
          ? merged.cycleHolidayOverride
          : DEFAULT_SETTINGS.cycleHolidayOverride,
      // Falls back to the old "cycleHolidayExclusive" field name (pre-rename,
      // back when this setting only applied while cycleHolidayOverride was
      // on) so an existing on/off choice survives the rename.
      cycleHolidaySeasonOnly:
        typeof merged.cycleHolidaySeasonOnly === "boolean"
          ? merged.cycleHolidaySeasonOnly
          : typeof merged.cycleHolidayExclusive === "boolean"
            ? merged.cycleHolidayExclusive
            : DEFAULT_SETTINGS.cycleHolidaySeasonOnly,
      cycleHolidayFullSeason:
        typeof merged.cycleHolidayFullSeason === "boolean"
          ? merged.cycleHolidayFullSeason
          : DEFAULT_SETTINGS.cycleHolidayFullSeason,
      cycleCurrentThemeId:
        typeof merged.cycleCurrentThemeId === "string"
          ? migrateThemeId(merged.cycleCurrentThemeId)
          : DEFAULT_SETTINGS.cycleCurrentThemeId,
      cycleLastAdvance:
        typeof merged.cycleLastAdvance === "number"
          ? merged.cycleLastAdvance
          : DEFAULT_SETTINGS.cycleLastAdvance,
      // Theme ids aren't validated here on purpose: custom themes load after
      // settings do, so a legitimate custom id would look unknown at this
      // point. resolveDayNightThemeId() in cycle-theme.ts does the check at
      // paint time instead, when the full list actually exists.
      cycleDayThemeId:
        typeof merged.cycleDayThemeId === "string" && merged.cycleDayThemeId
          ? migrateThemeId(merged.cycleDayThemeId)
          : DEFAULT_SETTINGS.cycleDayThemeId,
      cycleNightThemeId:
        typeof merged.cycleNightThemeId === "string" && merged.cycleNightThemeId
          ? migrateThemeId(merged.cycleNightThemeId)
          : DEFAULT_SETTINGS.cycleNightThemeId,
      cycleDayStart: isClockTime(merged.cycleDayStart)
        ? merged.cycleDayStart
        : DEFAULT_SETTINGS.cycleDayStart,
      cycleDayEnd: isClockTime(merged.cycleDayEnd)
        ? merged.cycleDayEnd
        : DEFAULT_SETTINGS.cycleDayEnd,
      themeAnimations:
        typeof merged.themeAnimations === "boolean"
          ? merged.themeAnimations
          : DEFAULT_SETTINGS.themeAnimations,
      // Filtered to strings rather than trusted wholesale. This one is an
      // array, so a corrupted/hand-edited entry would otherwise reach
      // .includes() as a non-string and quietly never match.
      themeAnimationsOff: Array.isArray(merged.themeAnimationsOff)
        ? merged.themeAnimationsOff.filter((id: unknown): id is string => typeof id === "string")
        : [...DEFAULT_SETTINGS.themeAnimationsOff],
      appLock:
        typeof merged.appLock === "boolean"
          ? merged.appLock
          : DEFAULT_SETTINGS.appLock,
      lockCredentialType:
        merged.lockCredentialType === "pin" ||
        merged.lockCredentialType === "password"
          ? merged.lockCredentialType
          : DEFAULT_SETTINGS.lockCredentialType,
      soundPack:
        typeof merged.soundPack === "string" &&
        SOUND_PACKS.some((p) => p.id === merged.soundPack)
          ? merged.soundPack
          : DEFAULT_SETTINGS.soundPack,
      toastVolumeDb:
        typeof merged.toastVolumeDb === "number" &&
        Number.isFinite(merged.toastVolumeDb)
          ? clampToastVolume(Math.round(merged.toastVolumeDb))
          : DEFAULT_SETTINGS.toastVolumeDb,
      autoCheckUpdates:
        typeof merged.autoCheckUpdates === "boolean"
          ? merged.autoCheckUpdates
          : DEFAULT_SETTINGS.autoCheckUpdates,
      updateNotifyAggressive:
        typeof merged.updateNotifyAggressive === "boolean"
          ? merged.updateNotifyAggressive
          : DEFAULT_SETTINGS.updateNotifyAggressive,
      ignoredUpdateVersion:
        typeof merged.ignoredUpdateVersion === "string"
          ? merged.ignoredUpdateVersion
          : DEFAULT_SETTINGS.ignoredUpdateVersion,
      sidebarItems: normalizeSidebarItems(merged.sidebarItems),
      sidebarSort: SIDEBAR_SORT_MODES.includes(merged.sidebarSort as SidebarSortMode)
        ? (merged.sidebarSort as SidebarSortMode)
        : DEFAULT_SETTINGS.sidebarSort,
    });
  } catch {
    setSettings({ ...DEFAULT_SETTINGS, sidebarItems: freshSidebarItems() });
  }
  // Checked as a pair, which the per-field coercion above structurally can't
  // do. Both edges revert together: keeping one half of a window the schedule
  // rejects would just produce a different wrong window.
  if (!isValidDayNightWindow(settings.cycleDayStart, settings.cycleDayEnd)) {
    settings.cycleDayStart = DEFAULT_SETTINGS.cycleDayStart;
    settings.cycleDayEnd = DEFAULT_SETTINGS.cycleDayEnd;
  }
  // Note: applySettings() is deferred to after loadCustomThemes() in init()
  // so that custom theme application has the themes array available.
  applySettings();
}


/* =============================================================================
   SETTINGS MODAL
============================================================================= */

type SettingsTab = "display" | "audio" | "preferences";

/* Declaration order is tab order: Display is what a fresh open lands on. The
   Customize buttons (Sidebar / Theme / Notification Sound) and the App Lock and
   new-version flows all leave and come back, so they close with
   { handoff: true } to keep the tab they left from. */
const settingsTabs = new ModalTabs<SettingsTab>({
  scope: "#settingsModal",
  key: "settingsTab",
  panes: {
    display: "settingsTabDisplay",
    audio: "settingsTabAudio",
    preferences: "settingsTabPreferences",
  },
});

export const settingsModal = new Modal(settingsBackdrop, {
  tabs: settingsTabs,
  onOpen: () => applySettings(),
});

settingsBtn.addEventListener("click", () => settingsModal.open());
settingsClose.addEventListener("click", () => settingsModal.close());

settingsReset.addEventListener("click", () => {
  setSettings({ ...DEFAULT_SETTINGS, sidebarItems: freshSidebarItems() });
  applySettings();
  saveSettings();
  flash("Settings reset to defaults", "success");
});

fontScaleInput.addEventListener("input", () => {
  // Clamped here too, not just on load: the min/max attributes on a number
  // input mark an out-of-range value invalid, they don't stop it being typed,
  // and this handler is what writes it to settings.
  settings.fontScale = clampFontScale(parseInt(fontScaleInput.value, 10));
  applySettings();
  saveSettings();
});

timeFormatToggle.addEventListener("change", () => {
  settings.hour12 = timeFormatToggle.checked;
  applySettings();
  saveSettings();
});

solidModalsToggle.addEventListener("change", () => {
  settings.solidModals = solidModalsToggle.checked;
  solidModalsLabel.textContent = settings.solidModals ? "On" : "Off";
  document.body.classList.toggle("solid-modals", settings.solidModals);
  saveSettings();
});

// themeSelect no longer has a visible UI of its own to fire "change", theme
// selection now happens via the Choose Theme modal's tiles, which call
// selectTheme()/selectCustomTheme() (see the CHOOSE THEME MODAL section
// below) instead of relying on this element's change event.

rerollBtn.addEventListener("click", () => {
  localStorage.removeItem(PERSISTENT_RANDOM_KEY);
  applyTheme("random");
});

/* -----------------------------------------------------------------------------
   Save-random-as-custom button, sits to the immediate LEFT of the reroll die
   in index.html (both shown only while the Random theme is active; see
   applySettings). Captures the palette CURRENTLY applied to :root (which works
   for both persistent and chaotic modes, since applyPalette writes every
   RANDOM_VAR as an inline property on :root) and stores it as a new custom
   theme named "rng-<timestamp>". This lets a good roll be kept before chaotic
   mode regenerates it on the next modal open.
----------------------------------------------------------------------------- */
const saveRandomBtn = document.getElementById(
  "saveRandomBtn",
) as HTMLButtonElement;

saveRandomBtn.addEventListener("click", async () => {
  // Read the live palette straight off :root's inline properties.
  const root = document.documentElement;
  const vars: Record<string, string> = {};
  for (const v of RANDOM_VARS) {
    const val = root.style.getPropertyValue(v).trim();
    if (val) vars[v] = val;
  }
  if (Object.keys(vars).length === 0) {
    flash("No random palette to save", "error");
    return;
  }

  // Human-readable timestamp: rng-YYYYMMDDHHMMSS (local, 24h, zero-padded).
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  const name = `rng-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const newTheme: CustomTheme = {
    id: genThemeId(),
    name,
    vars,
    advanced: {},
  };
  customThemes.push(newTheme);
  // Pre-select the just-saved theme so choosing "Custom" later lands on it.
  setActiveCustomId(newTheme.id);
  await saveCustomThemes();
  // The Random settings panel (and this button) stays visible regardless of
  // which tab is open, if that happens to be Custom, refresh it so the new
  // tile shows up immediately instead of only on the next tab switch.
  if (themePickerTabs.active === "custom") themePickerTabs.activate("custom");
  flash(`Saved palette as "${name}"`, "success");
});

randomModeToggle.addEventListener("change", () => {
  // Switching mode clears stored palette so the new mode starts fresh
  localStorage.removeItem(PERSISTENT_RANDOM_KEY);
  settings.randomPersistent = randomModeToggle.checked;
  randomModeLabel.textContent = settings.randomPersistent
    ? "Persistent"
    : "Regenerative";
  applyTheme("random");
  saveSettings();
});

randomPaletteToggle.addEventListener("change", () => {
  // Switching palette type clears stored palette so it regenerates with new generator
  localStorage.removeItem(PERSISTENT_RANDOM_KEY);
  settings.randomHarmonized = randomPaletteToggle.checked;
  randomPaletteLabel.textContent = settings.randomHarmonized
    ? "Harmonized"
    : "Chaotic";
  applyTheme("random");
  saveSettings();
});

cycleOrderToggle.addEventListener("change", () => {
  settings.cycleOrder = cycleOrderToggle.checked ? "random" : "sequential";
  cycleOrderLabel.textContent = settings.cycleOrder === "random" ? "Random" : "Sequential";
  saveSettings();
});

cycleTriggerSelect.addEventListener("change", () => {
  settings.cycleTrigger = cycleTriggerSelect.value as typeof settings.cycleTrigger;
  syncCycleSettingsVisibility();
  applyTheme("cycle");
  saveSettings();
});

cycleIntervalAmountInput.addEventListener("change", () => {
  const parsed = parseInt(cycleIntervalAmountInput.value, 10);
  const raw = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  settings.cycleIntervalAmount = clampCycleIntervalAmount(raw, settings.cycleIntervalUnit);
  cycleIntervalAmountInput.value = String(settings.cycleIntervalAmount);
  applyTheme("cycle");
  saveSettings();
});

cycleIntervalUnitSelect.addEventListener("change", () => {
  settings.cycleIntervalUnit = cycleIntervalUnitSelect.value as typeof settings.cycleIntervalUnit;
  cycleIntervalAmountInput.min = settings.cycleIntervalUnit === "seconds" ? "10" : "1";
  settings.cycleIntervalAmount = clampCycleIntervalAmount(
    settings.cycleIntervalAmount,
    settings.cycleIntervalUnit,
  );
  cycleIntervalAmountInput.value = String(settings.cycleIntervalAmount);
  applyTheme("cycle");
  saveSettings();
});

cycleDayThemeSelect.addEventListener("change", () => {
  settings.cycleDayThemeId = cycleDayThemeSelect.value;
  applyTheme("cycle");
  saveSettings();
  refreshCycleDayNightNote();
});

cycleNightThemeSelect.addEventListener("change", () => {
  settings.cycleNightThemeId = cycleNightThemeSelect.value;
  applyTheme("cycle");
  saveSettings();
  refreshCycleDayNightNote();
});

/* Both time inputs go through the same handler. "change" rather than "input"
   so a half-typed hour never briefly becomes the schedule.

   Two ways an edit is refused, and both put back the field that was just
   edited rather than blanking the pair: a value that isn't a time at all (the
   picker can be cleared), and a pair that leaves too little day or night (see
   isValidDayNightWindow). Only the edited edge moves back, so the other one
   stays where it was deliberately put. */
function commitDayNightWindow(edited: HTMLInputElement): void {
  const stored = edited === cycleDayStartInput ? settings.cycleDayStart : settings.cycleDayEnd;

  if (!isClockTime(edited.value)) {
    edited.value = stored;
    return;
  }

  const start = cycleDayStartInput.value;
  const end = cycleDayEndInput.value;
  if (!isValidDayNightWindow(start, end)) {
    edited.value = stored;
    flash(
      `Day and night each need at least ${MIN_DAY_NIGHT_SPAN_MINUTES} minutes`,
      "error",
    );
    return;
  }

  settings.cycleDayStart = start;
  settings.cycleDayEnd = end;
  applyTheme("cycle");
  saveSettings();
  refreshCycleDayNightNote();
}

cycleDayStartInput.addEventListener("change", () =>
  commitDayNightWindow(cycleDayStartInput),
);
cycleDayEndInput.addEventListener("change", () =>
  commitDayNightWindow(cycleDayEndInput),
);

cycleIncludeCustomToggle.addEventListener("change", () => {
  settings.cycleIncludeCustom = cycleIncludeCustomToggle.checked;
  cycleIncludeCustomLabel.textContent = settings.cycleIncludeCustom ? "On" : "Off";
  applyTheme("cycle");
  saveSettings();
});

cycleHolidayOverrideToggle.addEventListener("change", () => {
  settings.cycleHolidayOverride = cycleHolidayOverrideToggle.checked;
  cycleHolidayOverrideLabel.textContent = settings.cycleHolidayOverride ? "On" : "Off";
  syncCycleSettingsVisibility();
  applyTheme("cycle");
  saveSettings();
});

cycleHolidaySeasonOnlyToggle.addEventListener("change", () => {
  settings.cycleHolidaySeasonOnly = cycleHolidaySeasonOnlyToggle.checked;
  cycleHolidaySeasonOnlyLabel.textContent = settings.cycleHolidaySeasonOnly ? "On" : "Off";
  syncCycleSettingsVisibility();
  applyTheme("cycle");
  saveSettings();
});

cycleHolidayFullSeasonToggle.addEventListener("change", () => {
  settings.cycleHolidayFullSeason = cycleHolidayFullSeasonToggle.checked;
  cycleHolidayFullSeasonLabel.textContent = settings.cycleHolidayFullSeason ? "On" : "Off";
  applyTheme("cycle");
  saveSettings();
});

// Cycle can repaint for plenty of reasons that never touch the toggles above
// (Cycle Now, an interaction/time-trigger advance, the holiday-boundary
// recheck) so the note listens on "themechange" itself rather than being
// called from each individual handler.
window.addEventListener("themechange", refreshCycleHolidayNote);
window.addEventListener("themechange", refreshCycleDayNightNote);

cycleNowBtn.addEventListener("click", () => advanceCycleNow());

/* -----------------------------------------------------------------------------
   Cycle tab's holiday-subsettings (i) buttons, click-to-toggle popover,
   styled and behaved identically to auto-backup.ts's own info-tooltip
   feature (see that file's "Info tooltips" section) but reimplemented here
   rather than imported, matching its own established convention of keeping
   this pattern local to whichever file owns the buttons.
----------------------------------------------------------------------------- */
let themePickerInfoTooltipEl: HTMLDivElement | null = null;
let themePickerInfoTooltipOpenBtn: HTMLButtonElement | null = null;

function closeThemePickerInfoTooltip(): void {
  themePickerInfoTooltipEl?.classList.remove("visible");
  themePickerInfoTooltipOpenBtn = null;
}

function toggleThemePickerInfoTooltip(btn: HTMLButtonElement, text: string): void {
  if (themePickerInfoTooltipOpenBtn === btn) {
    closeThemePickerInfoTooltip();
    return;
  }
  if (!themePickerInfoTooltipEl) {
    themePickerInfoTooltipEl = document.createElement("div");
    themePickerInfoTooltipEl.className = "theme-picker-info-tooltip";
    document.body.appendChild(themePickerInfoTooltipEl);
  }
  themePickerInfoTooltipEl.textContent = text;
  themePickerInfoTooltipEl.classList.add("visible");
  const rect = btn.getBoundingClientRect();
  const bubbleWidth = themePickerInfoTooltipEl.offsetWidth;
  const left = Math.min(
    Math.max(8, rect.left + rect.width / 2 - bubbleWidth / 2),
    window.innerWidth - bubbleWidth - 8,
  );
  themePickerInfoTooltipEl.style.top = `${rect.bottom + 6}px`;
  themePickerInfoTooltipEl.style.left = `${left}px`;
  themePickerInfoTooltipOpenBtn = btn;
}

document.querySelectorAll<HTMLButtonElement>(".theme-picker-info-btn[data-tooltip]").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleThemePickerInfoTooltip(btn, btn.dataset.tooltip ?? "");
  });
});
document.addEventListener("click", () => closeThemePickerInfoTooltip());

dateFormatToggle.addEventListener("change", () => {
  settings.americanDates = dateFormatToggle.checked;
  dateFormatLabel.textContent = settings.americanDates
    ? "MM-DD-YYYY"
    : "YYYY-MM-DD";
  updateClock();
  saveSettings();
  // Notify Budget Tracker so it re-renders all displayed dates immediately
  setBudgetAmericanDates(settings.americanDates);
});

startupSelect.addEventListener("change", () => {
  settings.startupTarget = startupSelect.value;
  saveSettings();
});

/* =============================================================================
   BACKUP REMINDER MODAL  (universal, owned by shell; Aggressive mode)
   -----------------------------------------------------------------------------
   Gentle mode is just a flash() toast. No modal needed. Aggressive mode
   uses this modal, shown once per startup (see runStartupGates / the
   changelog onClosed hook above) when Auto-Backup's getDueBackupReminder()
   says a reminder is due.

   Returns a promise so runStartupNudges() can show the startup nudges one at a
   time instead of stacking them, see that function for the ordering. The
   resolver hangs off the Modal's onClosed rather than the buttons, so EVERY
   way out (button, Escape, X) advances the queue; a close path that forgot to
   resolve would strand the rest of the nudges behind a modal nobody can see.
============================================================================= */

let _backupReminderResolve: (() => void) | null = null;

const backupReminderModal = new Modal(backupReminderBackdrop, {
  onClosed: () => {
    const resolve = _backupReminderResolve;
    _backupReminderResolve = null;
    resolve?.();
  },
});

export function maybeShowBackupReminder(): Promise<void> {
  const status = getDueBackupReminder();
  if (!status) return Promise.resolve();

  if (!status.aggressive) {
    return gentleNudge("Time to backup your shit!");
  }

  backupReminderDaysEl.textContent = String(status.elapsedDays);
  return new Promise<void>((resolve) => {
    _backupReminderResolve = resolve;
    backupReminderModal.open();
  });
}

backupReminderGoBtn.addEventListener("click", () => {
  backupReminderModal.close();
  activateToolFromClick("files", "auto-backup");
});

backupReminderCancelBtn.addEventListener("click", () => {
  backupReminderModal.close();
});

/* =============================================================================
   BUDGET REMINDER MODAL  (universal, owned by shell; Aggressive mode)
   -----------------------------------------------------------------------------
   Same shape as the backup reminder above, for the same reason it lives here:
   it fires during the startup sequence, before the tool it points at has
   necessarily been opened. Gentle mode is just a flash() toast.

   Budget's persistent signals (sidebar pulse + header notice) are managed
   inside budget.ts and clear themselves as soon as anything is updated. The
   one extra action here is "mark it reviewed", which clears the reminder
   without entering data. Budget is the only one of the three reminders with
   no natural clearing event of its own. See markBudgetReviewed().
============================================================================= */

let _budgetReminderResolve: (() => void) | null = null;

const budgetReminderModal = new Modal(budgetReminderBackdrop, {
  onClosed: () => {
    const resolve = _budgetReminderResolve;
    _budgetReminderResolve = null;
    resolve?.();
  },
});

export function maybeShowBudgetReminder(): Promise<void> {
  const status = getDueBudgetReminder();
  if (!status) return Promise.resolve();

  if (!status.aggressive) {
    return gentleNudge(
      `Your budget hasn't been updated in ${status.elapsedDays} days.`,
    );
  }

  budgetReminderDaysEl.textContent = String(status.elapsedDays);
  return new Promise<void>((resolve) => {
    _budgetReminderResolve = resolve;
    budgetReminderModal.open();
  });
}

budgetReminderGoBtn.addEventListener("click", () => {
  budgetReminderModal.close();
  activateToolFromClick("finance", "budget");
});

budgetReminderReviewedBtn.addEventListener("click", () => {
  budgetReminderModal.close();
  markBudgetReviewed();
  flash("Budget marked as reviewed", "success");
});

budgetReminderCancelBtn.addEventListener("click", () => {
  budgetReminderModal.close();
});

/* =============================================================================
   EXIT MODAL
============================================================================= */

const exitModal = new Modal(exitBackdrop);

function openExitModal(): void {
  exitModal.open();
}

function closeExitModal(): void {
  exitModal.close();
}

/** Quits the app. Flushes any pending debounced Budget save first (an edit
 *  made <400 ms before a fast Alt+F4 + Enter would otherwise be lost), then
 *  removes the close-request interceptor so the close isn't caught and
 *  re-routed to the exit modal, then closes the window. The allowAppClose
 *  flag is a fallback in case the unlisten handle isn't ready yet (e.g. a
 *  quit within the first frames of launch). */
export async function quitApp(): Promise<void> {
  try {
    await onBudgetToolExit();
  } catch {
    // Quitting must never be blocked by a failed flush. The debounce window
    // is 400 ms, so in the overwhelmingly common case there's nothing queued.
  }
  allowAppClose = true;
  unlistenCloseRequest?.();
  unlistenCloseRequest = null;
  getCurrentWindow().close();
}

closeBtn.addEventListener("click", openExitModal);
exitCancelBtn.addEventListener("click", closeExitModal);
exitConfirmBtn.addEventListener("click", quitApp);

// Intercept Alt+F4 / OS-level close requests and route them to the exit modal.
// Exception: when the lock screen is showing, close immediately without
// prompting. The user has no access to app content yet, so there's nothing
// to confirm discarding.
// The custom titlebar X already calls openExitModal directly, so it bypasses this.
// quitApp() removes this listener before closing, so a confirmed exit goes through.
getCurrentWindow()
  .onCloseRequested((event) => {
    if (allowAppClose) return;
    // If the lock screen is active, just close without the exit confirmation modal
    if (lockScreen.style.display === "flex") {
      quitApp();
      return;
    }
    event.preventDefault();
    openExitModal();
  })
  .then((unlisten) => {
    unlistenCloseRequest = unlisten;
  });

// Tauri keeps JS-registered window listeners alive on the Rust side across a
// webview reload (Ctrl+R / F5). Left in place, the stale close-request listener
// from the previous page poisons the close flow. The new page's Alt+F4 stops
// reaching the exit modal and close() no longer quits. Tearing it down on unload
// guarantees the next page starts with a single, working listener.
window.addEventListener("beforeunload", () => {
  unlistenCloseRequest?.();
  unlistenCloseRequest = null;
});

/* =============================================================================
   TOAST NOTIFICATIONS
============================================================================= */


/* A toast that fires while the app isn't on screen (window unfocused
   (alt-tabbed away, covered by another window) or the document hidden
   (minimized)) doesn't start its countdown at all. It waits, and the
   taskbar flashes, until the user comes back and can actually read it; the
   timer then starts with TOAST_RETURN_MS of fresh time, since a toast that
   expires the instant attention returns defeats the point of holding it.

   Only that FIRST view is waited for. Once a toast has been on screen its
   countdown just runs, and alt-tabbing away again does not pause it, a
   toast you've already seen shouldn't be able to outlive the moment it
   belongs to, and a toast fired while you're looking at the app was never
   waiting on anything to begin with. */
let _appVisible = document.visibilityState === "visible" && document.hasFocus();

// A toast resuming because the user came back gets AT LEAST this much visible
// time, longer than the standard 5s, since attention was elsewhere and a
// just-expired-or-nearly-expired toast would otherwise vanish before it's
// even read. Only a floor: a toast whose own requested duration is already
// longer (e.g. an 8s error) keeps that instead.
const TOAST_RETURN_MS = 7000;

function _isAppVisible(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

function _setAppVisible(visible: boolean): void {
  if (visible === _appVisible) return;
  _appVisible = visible;
  // Leaving no longer pauses anything: unseen toasts have no timer running to
  // pause, and seen ones are meant to keep counting down in the background.
  if (!visible) return;

  for (const meta of toastMetas) {
    if (meta.awaitingFirstView) {
      // Being on screen at last is what this toast was waiting for. Full fresh
      // time (never less than TOAST_RETURN_MS), and from here on it's an
      // ordinary toast that ignores visibility entirely.
      meta.awaitingFirstView = false;
      meta.remaining = Math.max(meta.durationMs, TOAST_RETURN_MS);
    }
    // Already counting down, leave it be. Hovered, mouseleave owns the
    // restart, and now reads the remaining set just above. The rest is a
    // toast left paused by a mouseleave that happened while the app was
    // away (which couldn't restart it then); this is where it recovers.
    if (meta.timeout !== null || meta.hovered) continue;
    meta.startedAt = Date.now();
    meta.timeout = setTimeout(meta.dismiss, meta.remaining);
  }
}

document.addEventListener("visibilitychange", () => _setAppVisible(_isAppVisible()));
window.addEventListener("focus", () => _setAppVisible(_isAppVisible()));
window.addEventListener("blur", () => _setAppVisible(_isAppVisible()));

/** Displays a toast notification with optional type and duration.
 *  Plays the corresponding audio cue, enforces a MAX_TOASTS cap by evicting the
 *  oldest toast, and supports hover-to-pause and click-to-dismiss. A toast
 *  fired while the app is unfocused/hidden holds its countdown until the user
 *  is back to see it; once shown, it counts down regardless, see
 *  _setAppVisible() above. */
export function flash(
  message: string,
  type: "success" | "error" = "success",
  durationMs = 5000,
  /** Suppresses the toast's own cue. For callers that play their own audio for
   *  the same event (Countdown Timer's configurable end-of-timer alarm) where the
   *  toast sound would otherwise land on top of it as an extra, unasked-for
   *  repeat. */
  silent = false,
): void {
  if (!silent && type === "success" && successAudio) playCue(successAudio);
  if (!silent && type === "error" && errorAudio) playCue(errorAudio);

  if (toastMetas.length >= MAX_TOASTS) {
    const oldest = toastMetas.shift()!;
    if (oldest.timeout !== null) clearTimeout(oldest.timeout);
    const oldEl = document.getElementById(`toast-${oldest.id}`);
    if (oldEl) oldEl.remove();
  }

  const id = ++toastCounter;
  const toast = document.createElement("div");
  toast.id = `toast-${id}`;
  toast.className = `toast ${type}`;
  toast.textContent = message;
  toastContainer.appendChild(toast);

  function dismiss(): void {
    meta.timeout = null;
    toastMetas = toastMetas.filter((m) => m.id !== id);
    toast.classList.add("hide");
    toast.addEventListener("animationend", () => toast.remove(), {
      once: true,
    });
  }

  const meta: ToastMeta = {
    id,
    timeout: null,
    durationMs,
    remaining: durationMs,
    startedAt: Date.now(),
    hovered: false,
    awaitingFirstView: !_appVisible,
    dismiss,
  };

  function startTimer(ms: number): void {
    meta.remaining = ms;
    meta.startedAt = Date.now();
    meta.timeout = setTimeout(dismiss, ms);
  }

  toast.addEventListener("mouseenter", () => {
    meta.hovered = true;
    if (meta.timeout === null) return;
    clearTimeout(meta.timeout);
    meta.timeout = null;
    meta.remaining = Math.max(
      0,
      meta.remaining - (Date.now() - meta.startedAt),
    );
  });

  toast.addEventListener("mouseleave", () => {
    meta.hovered = false;
    if (_appVisible) startTimer(meta.remaining);
  });

  toast.addEventListener("click", dismiss);

  toastMetas.push(meta);
  if (_appVisible) {
    // On screen when it fired, so it starts counting down straight away and
    // keeps doing so even if the user alt-tabs off mid-toast.
    startTimer(durationMs);
  } else {
    // Unseen, so no timer yet, _setAppVisible(true) starts it on return with
    // TOAST_RETURN_MS of fresh time. Flash the taskbar meanwhile, so a toast
    // firing in the background (e.g. a backup finishing while alt-tabbed away)
    // doesn't go unnoticed. Windows clears the flash on its own once the user
    // brings the window to the front.
    getCurrentWindow().requestUserAttention(UserAttentionType.Critical).catch(() => {});
  }
}

/* Dev-only: type "debugtoast" anywhere outside a text field to fire a toast
   5 seconds later, long enough to alt-tab away and confirm it's still
   waiting, unstarted, when you come back (and that it then counts down and
   goes, even if you alt-tab away again). Stripped from production builds
   along with every other __DEV__ block. */
if (__DEV__) {
  let _debugToastBuffer = "";
  const DEBUG_TOAST_PHRASE = "debugtoast";
  document.addEventListener("keydown", (e) => {
    const active = document.activeElement;
    const isTyping =
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement ||
      (active instanceof HTMLElement && active.isContentEditable);
    if (isTyping || e.key.length !== 1 || !/[a-z]/i.test(e.key)) return;

    _debugToastBuffer = (_debugToastBuffer + e.key.toLowerCase()).slice(
      -DEBUG_TOAST_PHRASE.length,
    );
    if (_debugToastBuffer !== DEBUG_TOAST_PHRASE) return;
    _debugToastBuffer = "";

    console.log("[debugtoast] firing in 5s, alt-tab away now");
    setTimeout(() => flash("Debug toast: fired 5s ago, still here?", "success"), 5000);
  });
}

/* =============================================================================
   WINDOW SIZE: SAVE / RESTORE
============================================================================= */

// Last known non-maximized dimensions (logical pixels).
// Updated every time we save a non-maximized size so we can
// include it when saving maximized state.
let _lastNonMaxSize: { width: number; height: number } | null = null;

/** Saves the current window size to disk in logical pixels (DPI-independent).
 *  When maximized, saves the maximized flag alongside the last known restore
 *  dimensions so Windows has the correct restore size when unmaximizing. */
async function saveWindowSize(): Promise<void> {
  try {
    const win = getCurrentWindow();
    const isMaximized = await win.isMaximized();
    if (isMaximized) {
      // Save maximized flag alongside last known restore dimensions
      await invoke("save_window_size", {
        data: JSON.stringify({
          maximized: true,
          width: _lastNonMaxSize?.width ?? null,
          height: _lastNonMaxSize?.height ?? null,
        }),
      });
      return;
    }
    // Convert physical → logical so saved values are DPI-independent
    const size = await win.innerSize();
    const factor = await win.scaleFactor();
    const logicalW = size.width / factor;
    const logicalH = size.height / factor;
    _lastNonMaxSize = { width: logicalW, height: logicalH };
    await invoke("save_window_size", {
      data: JSON.stringify({
        width: logicalW,
        height: logicalH,
        maximized: false,
      }),
    });
  } catch {
    /* non-critical */
  }
}

/** Restores the saved window size on startup. Always sets the logical pixel
 *  dimensions first (even if the window will be maximized), so Windows registers
 *  the correct restore size before the maximize call. Falls back to the
 *  tauri.conf.json defaults silently if no saved size exists. */
async function restoreWindowSize(): Promise<void> {
  try {
    const raw = await invoke<string>("load_window_size");
    const parsed = JSON.parse(raw);
    const width =
      typeof parsed.width === "number" && parsed.width > 0
        ? parsed.width
        : null;
    const height =
      typeof parsed.height === "number" && parsed.height > 0
        ? parsed.height
        : null;
    const maximized =
      typeof parsed.maximized === "boolean" ? parsed.maximized : false;
    const win = getCurrentWindow();
    if (width && height) {
      // Always restore the saved dimensions first so Windows has the
      // correct restore size in memory before we maximize (if needed)
      _lastNonMaxSize = { width, height };
      await win.setSize(new LogicalSize(width, height));
    }
    if (maximized) {
      await win.maximize();
    }
  } catch {
    /* use tauri.conf.json defaults */
  }
}

/* =============================================================================
   INITIALISATION
============================================================================= */

/** Rewrites settings.theme to the default when it names something that can't be
 *  resolved, and persists the correction.
 *
 *  resolveThemeId() already stops a junk id from painting an unstyled window,
 *  but it resolves without writing anything back, so the junk stays on disk and
 *  the picker highlights no tile. This closes that loop.
 *
 *  Deliberately runs from init() after loadCustomThemes() rather than inside
 *  loadSettings(): "custom" is only meaningful once the custom themes exist.
 *
 *  Deliberately touches settings.theme ONLY. cycleDayThemeId/cycleNightThemeId
 *  may legitimately name a custom theme, and a custom theme can be absent for
 *  reasons that aren't corruption (a not-yet-synced install, a restored backup
 *  mid-copy). Overwriting those would destroy a real setting to fix nothing,
 *  since resolveDayNightThemeId() already resolves them safely at paint time.
 *  Healing is for values that are unrecoverable, not merely unresolvable now. */
async function healStoredThemeId(): Promise<void> {
  const stored = settings.theme;
  if (THEME_SENTINELS.includes(stored) || isKnownBuiltinTheme(stored)) return;
  console.warn(
    `[theme] stored theme ${JSON.stringify(stored)} does not exist, resetting to ${JSON.stringify(DEFAULT_THEME_ID)}`,
  );
  settings.theme = DEFAULT_THEME_ID;
  await saveSettings();
  // The first applySettings() (end of loadSettings) already painted the
  // resolved fallback, but it did so while settings.theme still read as the
  // junk value, so the Settings badge and picker highlight are stale. Re-run
  // now that the field itself is correct.
  applySettings();
}

async function init(): Promise<void> {
  // loadSettings() must finish before loadShellState() runs. The latter
  // uses settings.sidebarItems (via activateToolIfPinned) to decide whether
  // the saved startup target is still valid, so it can't race against the
  // settings load that populates it.
  await loadSettings();
  await Promise.all([
    restoreWindowSize(),
    loadShellState(),
    loadCustomThemes(),
  ]);

  // Must precede the "custom" seeding below: that branch is only correct once
  // settings.theme is known to be a value applyTheme() can actually act on.
  await healStoredThemeId();

  // If the saved theme is "custom", seed the active custom theme (theme-core.ts)
  // from the first stored theme and re-apply now that customThemes is loaded.
  // Falls back to the first saved custom theme if the previously-active id is
  // missing or no longer exists (e.g. deleted from another install).
  if (settings.theme === "custom") {
    let activeId = getActiveCustomId();
    if (!activeId || !customThemes.some((t) => t.id === activeId)) {
      activeId = customThemes.length > 0 ? customThemes[0]!.id : null;
      setActiveCustomId(activeId);
    }
    if (activeId) applyCustomThemeById(activeId);
  }

  // Fetch the app version once and cache it, used for both the About modal
  // display and the startup gates (changelog seen check).
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    _appVersion = await getVersion();
  } catch {
    _appVersion = "unknown";
  }
  if (appVersionEl) appVersionEl.textContent = `v${_appVersion}`;

  // Regenerate the random palette (when in regenerative-random mode) on every
  // modal open, without modal.ts needing any knowledge of the theme system.
  setGlobalModalOpenHook(maybeRegenerateRandom);

  initTimeTracker();
  initImageCCR();
  initFileGen();
  await initAutoBackup();
  await initBudget();
  initGameStats();
  initTTSRepeater();
  initCountdown();
  initDaysBetween();

  let _resizeTimer: ReturnType<typeof setTimeout> | null = null;
  getCurrentWindow().onResized(() => {
    if (_resizeTimer) clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(() => saveWindowSize(), 300);
  });

  // If lock is enabled, show the lock overlay BEFORE the window becomes visible
  // so the user never catches a glimpse of app content.
  if (settings.appLock) {
    const hasHash = await invoke<boolean>("lock_is_set").catch(() => false);
    if (hasHash) {
      lockScreen.style.display = "flex";
      // Render correct variant immediately (pre-gate)
      if (settings.lockCredentialType === "pin") {
        lockPinView.style.display = "";
        lockPasswordView.style.display = "none";
        buildPinDots(0);
        resetPinBuffer();
        lockPinError.textContent = "";
      } else {
        lockPinView.style.display = "none";
        lockPasswordView.style.display = "";
        lockPasswordInput.value = "";
        lockPasswordError.textContent = "";
      }
    }
  }

  await getCurrentWindow().show();

  // Opt-in update check, fire-and-forget so a slow or unreachable network can
  // never delay startup. Off by default; on failure it silently no-ops.
  if (settings.autoCheckUpdates) {
    void checkForUpdates();
  }

  // Run after window is visible, license gate then auto-changelog
  await runStartupGates(_appVersion !== "unknown" ? _appVersion : "accepted");
}

/* -----------------------------------------------------------------------------
   Startup, with a guaranteed-visible failure mode.

   The window is created with "visible": false (tauri.conf.json) and only shown
   by the getCurrentWindow().show() at the end of init(). That means ANY throw
   before that line (a renamed element id tripping one of the getElementById
   non-null assertions, a tool's init rejecting, a corrupt data file getting
   past its parser) leaves a running process with no window at all. No error,
   no UI, nothing to report: the user double-clicks the icon and believes the
   app is broken.

   budget.ts already guards its own init against this (see its "blast-door"
   persistence notes), but that protects one call site out of many. This is the
   backstop for every other one: whatever happens, show the window and say what
   went wrong, so a startup failure is diagnosable instead of invisible.
----------------------------------------------------------------------------- */
init().catch(async (err: unknown) => {
  devError("Startup failed:", err);

  // Built with createElement/textContent rather than innerHTML: `err` can
  // carry arbitrary text (file contents, paths) and must never be parsed as
  // markup, least of all on the one path where the rest of the app's
  // safeguards clearly aren't running.
  try {
    const banner = document.createElement("div");
    banner.setAttribute(
      "style",
      "position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;" +
        "gap:12px;align-items:flex-start;justify-content:center;padding:32px;" +
        "background:#1a1a1a;color:#f5f5f5;font:14px/1.5 system-ui,sans-serif;overflow:auto",
    );

    const title = document.createElement("div");
    title.setAttribute("style", "font-size:18px;font-weight:600;color:#ff6b6b");
    title.textContent = "Swiss RB Knife failed to start";
    banner.appendChild(title);

    const detail = document.createElement("pre");
    detail.setAttribute(
      "style",
      "margin:0;white-space:pre-wrap;word-break:break-word;font:12px/1.5 ui-monospace,monospace;opacity:0.85",
    );
    detail.textContent = err instanceof Error ? `${err.message}\n\n${err.stack ?? ""}` : String(err);
    banner.appendChild(detail);

    const hint = document.createElement("div");
    hint.setAttribute("style", "opacity:0.7");
    hint.textContent =
      "Your data files were not modified. Please report this message to the developer.";
    banner.appendChild(hint);

    document.body.appendChild(banner);
  } catch {
    // DOM itself is unusable. Nothing further to try; still show the window
    // below so the failure is at least visible rather than silent.
  }

  try {
    await getCurrentWindow().show();
  } catch {
    /* If even show() fails there is nothing left this code can do. */
  }
});
