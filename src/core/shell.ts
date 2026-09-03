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

   Per-tool logic lives in src/tool/<tool>.ts and is initialized via init*()
   calls at the bottom of init(). The Modal primitive (modal.ts) owns all shared
   chrome behavior (Escape, drag, open-stack, scroll reset).
============================================================================= */

import { invoke } from "@tauri-apps/api/core";
import { devError, devWarn, isDev } from "./dev-log";
import { fileTimestamp } from "./timestamp";
import { initDataTransfer, refreshDataTab } from "./data-transfer";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { Modal, ModalTabs, setGlobalModalOpenHook } from "../modal/modal";
import { initTimeTracker } from "../tool/time-tracker";
import { initImageCCR } from "../tool/image-ccr";
import { initFileGen } from "../tool/file-gen";
import {
  initAutoBackup,
  onAutoBackupToolEntry,
  getDueBackupReminder,
} from "../tool/auto-backup";
import {
  initBudget,
  setBudgetAmericanDates,
  onBudgetToolEntry,
  onBudgetToolExit,
  getDueBudgetReminder,
  markBudgetReviewed,
} from "../tool/budget";
import { initGameStats, onGameStatsToolEntry, onGameStatsIconClicked } from "../tool/game-stats";
import { initTTSRepeater } from "../tool/tts-repeater";
import { initCountdown } from "../tool/countdown";
import { initDaysBetween } from "../tool/days-between";
import { initRNG } from "../tool/rng";
import {
  initKanban,
  onKanbanToolEntry,
  onKanbanToolExit,
  onKanbanIconClicked,
} from "../tool/kanban";
import {
  RANDOM_VARS,
  PERSISTENT_RANDOM_KEY,
  maybeRegenerateRandom,
} from "../theme/random-theme";
import {
  ANIMATED_THEMES,
  applyTheme,
  isKnownBuiltinTheme,
  themeCssUrl,
  getActiveCustomId,
  setActiveCustomId,
} from "../theme/theme-core";
import { DEFAULT_THEME_ID, THEME_SENTINELS, migrateThemeId } from "../theme/theme-ids";
import {
  advanceCycleNow,
  getActiveHolidayOverrideThemeId,
  getDayNightStatus,
  getHolidayOverrideEndDate,
} from "../theme/cycle-theme";
import {
  genThemeId,
  saveCustomThemes,
  loadCustomThemes,
  applyCustomThemeById,
  clearCustomTheme,
  customThemes,
  openThemeEditor,
  requestDeleteCustomTheme,
} from "../theme/theme-editor";
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
  syncHolidayOverrideControls,
  themePickerModal,
  themePickerTabs,
} from "../theme/theme-picker";
// Re-exported so theme-editor.ts keeps importing these from shell, matching
// how it already reaches every other shared binding.
export { reopenThemePickerOnCustomTab, themePickerModal } from "../theme/theme-picker";

import {
  applyAudioSettings,
  clampCueVolumeDb,
  loadSoundPack,
  playButtonCue,
  playModalCue,
  playToastCue,
  refreshSoundPackCurrentBadge,
} from "../sound/sound";
// Re-exported so tool files keep importing these from "./shell", their
// existing convention, rather than reaching into a shell-internal module.
export { getSoundOptions, resolveSoundUrl, playSoundUrl } from "../sound/sound";

import {
  SIDEBAR_SORT_MENU,
  applySidebarOrder,
  applySidebarSort,
  isToolPinned,
  isToolVisible,
  openSidebarEditModal,
  setPinned,
} from "./sidebar-edit";
import { attachMenu, openMenu, type MenuItem } from "../menu/menu";
import { openEditMenu, setEditMenuNotify } from "../menu/edit-menu";
// Re-exported so tool files keep importing it from "./shell", their existing
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
  /** The tool's category. Called `section` throughout because that is what
   *  the DOM calls it: it names the tool's `#section-<id>` container, its
   *  `#<id>-tool-<tool>` view, and its data-section attribute. A tool has one
   *  grouping, not two. */
  section: ToolCategoryId;
  tool: string;
  label: string;
};

/** The categories, in the order their headings appear. Kept small on purpose:
 *  a category earns its place by what it turns away, not by how full it is,
 *  and a bucket that accepts anything (the old "utility") is how the last set
 *  of categories stopped meaning anything.
 *
 *  Renaming an id here is not a rename. It is the tool key ("<id>/<tool>"),
 *  the section container's id, every tool view id inside it, the per-tool
 *  theme selectors in public/themes/, and two persisted files. Re-assigning a
 *  tool from one existing category to another is cheap; adding or renaming a
 *  category is not. See RENAMED_TOOL_KEYS below for what that costs. */
export type ToolCategoryId = "productivity" | "tracking" | "calculators" | "files";

/* Array order IS heading order, on the sidebar, on the Home dashboard and in
   the Edit Home/Sidebar modal's drag list. Nothing else reads it, so this is
   the one place to reorder them. */
export const TOOL_CATEGORIES: { id: ToolCategoryId; label: string }[] = [
  // Records you add to over time and look back at.
  { id: "tracking", label: "Tracking" },
  // Things that have not happened yet.
  { id: "productivity", label: "Productivity" },
  // Takes files off disk, hands files back.
  { id: "files", label: "File Tools" },
  // One-off answers. Nothing is kept.
  { id: "calculators", label: "Calculators" },
];

/** One row of the persisted sidebar order/pin state (settings.sidebarItems).
 *  Array order IS the display order for pinned items; unpinned items are
 *  hidden and their relative order is never shown or editable. */

/** Advanced visual overrides stored per custom theme. All fields optional,
 *  absent means "no override" (flat color from the CSS vars applies). */
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
 *  the Choose Notification Sound Pack modal; add a pack here and a tile for
 *  it appears there. */
export type SoundPack = {
  id: string; // stable key, persisted in settings.soundPack
  name: string; // display name shown on the pack's tile
  success?: string; // e.g. "/sounds/notification-sound-packs/default/success.wav"
  error?: string; // e.g. "/sounds/notification-sound-packs/default/error.wav"
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
   public/sounds/notification-sound-packs/ containing (at minimum) the files
   referenced below, see the "TOAST NOTIFICATIONS" section for how these are
   loaded/played. Add a new pack by dropping a folder in there and adding an
   entry here; the picker is populated from this array.

   These stay hand-written, unlike the button/modal cues in sound-manifest.ts:
   a pack is a curated success/error pair with a display name ("Saxy Time")
   that no filename-derived guess would produce.

   Paths are written as URLs, so anything in a name that has to travel as an
   escape belongs escaped here; scripts/checks/settings.test.mjs decodes them
   back before checking each file is on disk. */
export const SOUND_PACKS: SoundPack[] = [
  {
    id: "default",
    name: "Default",
    success: "/sounds/notification-sound-packs/default/default-success.wav",
    error: "/sounds/notification-sound-packs/default/default-error.wav",
  },
  {
    id: "machine",
    name: "Machine",
    success: "/sounds/notification-sound-packs/machine/machine-success.wav",
    error: "/sounds/notification-sound-packs/machine/machine-error.wav",
  },
  {
    id: "subtle",
    name: "Subtle",
    success: "/sounds/notification-sound-packs/subtle/subtle-success.wav",
    error: "/sounds/notification-sound-packs/subtle/subtle-error.wav",
  },
  {
    id: "saxy-time",
    name: "Saxy Time",
    success: "/sounds/notification-sound-packs/saxy-time/saxy-time-success.wav",
    error: "/sounds/notification-sound-packs/saxy-time/saxy-time-error.wav",
  },
  {
    id: "futuristic-1",
    name: "Futuristic 1",
    success: "/sounds/notification-sound-packs/futuristic-1/futuristic-1-success.wav",
    error: "/sounds/notification-sound-packs/futuristic-1/futuristic-1-error.wav",
  },
  {
    id: "futuristic-2",
    name: "Futuristic 2",
    success: "/sounds/notification-sound-packs/futuristic-2/futuristic-2-success.wav",
    error: "/sounds/notification-sound-packs/futuristic-2/futuristic-2-error.wav",
  },
  {
    id: "ancient-forest",
    name: "Ancient Forest",
    success: "/sounds/notification-sound-packs/ancient-forest/ancient-forest-success.wav",
    error: "/sounds/notification-sound-packs/ancient-forest/ancient-forest-error.wav",
  },
  {
    id: "chipped",
    name: "Chipped",
    success: "/sounds/notification-sound-packs/chipped/chipped-success.wav",
    error: "/sounds/notification-sound-packs/chipped/chipped-error.wav",
  },
  {
    id: "intergalactic",
    name: "Intergalactic",
    success: "/sounds/notification-sound-packs/intergalactic/intergalactic-success.wav",
    error: "/sounds/notification-sound-packs/intergalactic/intergalactic-error.wav",
  },
  {
    id: "minimal",
    name: "Minimal",
    success: "/sounds/notification-sound-packs/minimal/minimal-success.wav",
    error: "/sounds/notification-sound-packs/minimal/minimal-error.wav",
  },
  {
    id: "sleek",
    name: "Sleek",
    success: "/sounds/notification-sound-packs/sleek/sleek-success.wav",
    error: "/sounds/notification-sound-packs/sleek/sleek-error.wav",
  },
  {
    id: "cake",
    name: "Cake",
    success: "/sounds/notification-sound-packs/cake/cake-success.wav",
    error: "/sounds/notification-sound-packs/cake/cake-error.wav",
  },
  {
    id: "sassy-cake",
    name: "Sassy Cake",
    success: "/sounds/notification-sound-packs/sassy-cake/sassy-cake-success.wav",
    error: "/sounds/notification-sound-packs/sassy-cake/sassy-cake-error.wav",
  },
];

/* Packs that have been renamed, old id -> current id. A pack id is not just
   a label: it is persisted in settings.soundPack, and the Countdown Timer
   stores it inside its alarm cue id too. Without a map, renaming a folder
   silently resets the app's pack to Default and leaves that timer with no
   alarm sound at all, which is the kind of quiet breakage nobody reports.

   Same bar as THEME_ID_MIGRATIONS in theme-ids.ts, and the same permanence:
   an entry earns its place if the old id ever shipped, and is then never
   removed, because dropping it strands anyone whose settings still name it,
   whether from an older build, a restored backup or a hand-edited file. */
export const RENAMED_SOUND_PACKS: Record<string, string> = {
  // Renamed 2026-08-24. "alternate" shipped in v0.3.3, v0.4.0, v0.5.0 and
  // v0.6.0, so settings files naming it are out there.
  alternate: "machine",
};

/** Maps a possibly-stale pack id to the current one. Ids that were never
 *  renamed pass straight through, still to be validated by the caller. */
export function currentSoundPackId(id: string): string {
  return RENAMED_SOUND_PACKS[id] ?? id;
}

/* Every real, navigable tool in the app, in the app's original/default
   order. This is the single source of truth for the Edit Sidebar modal, the
   Home dashboard, and the "Specific Tool" options in the On Startup select,
   add a tool here (matching its data-section/data-tool attributes in
   index.html) and it's automatically pinnable/reorderable/hideable. */
export const ALL_TOOLS: ToolMeta[] = [
  { key: "tracking/budget", section: "tracking", tool: "budget", label: "Budget Tracker" },
  { key: "tracking/time-tracker", section: "tracking", tool: "time-tracker", label: "Time Tracker" },
  { key: "productivity/kanban", section: "productivity", tool: "kanban", label: "Kanban" },
  { key: "files/auto-backup", section: "files", tool: "auto-backup", label: "Auto-Backup" },
  { key: "productivity/countdown", section: "productivity", tool: "countdown", label: "Countdown Timer" },
  { key: "tracking/game-stats", section: "tracking", tool: "game-stats", label: "Game Stats" },
  { key: "files/image-ccr", section: "files", tool: "image-ccr", label: "Image CCR" },
  { key: "calculators/days-between", section: "calculators", tool: "days-between", label: "Days Between Dates" },
  { key: "productivity/tts-repeater", section: "productivity", tool: "tts-repeater", label: "TTS Repeater" },
  { key: "files/dummy-file-generator", section: "files", tool: "dummy-file-generator", label: "Dummy File Generator" },
  { key: "calculators/rng", section: "calculators", tool: "rng", label: "RNGesus" },
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
 *  the entire app at a ~520px root font. At that size the App Settings
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
// Holiday Overrides / Full Holiday Season are wired in theme-picker.ts
// instead of here: each has a second copy on the Preferences tab, and both
// copies have to move together. Restrict to Holiday Season stays below,
// since it only ever shapes the Cycle pool.
const cycleHolidaySeasonOnlyToggle = document.getElementById("cycleHolidaySeasonOnlyToggle") as HTMLInputElement;
const cycleHolidaySeasonOnlyLabel = document.getElementById("cycleHolidaySeasonOnlyLabel")!;
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

/* Both now live in core/dev-log.ts, which imports nothing, and are re-exported
   here so the several dozen files already importing them from shell keep
   working. The move was not tidying: theme-core.ts does not import shell, could
   not reach these, and had quietly grown a bare console.warn that logged in
   production while every sibling call was correctly silent. */
export { devError, devWarn } from "./dev-log";
const __DEV__ = isDev;

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

   Two different behaviors are wanted, and the difference is intent rather
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
/** Navigates to a tool from outside the shell. The Data tab in App Settings
 *  uses this: a tool's own import screens belong to that tool, so a link to one
 *  has to put you in front of it rather than open a modal over whatever you
 *  happened to be looking at. */
export function navigateToTool(sectionKey: string, toolKey: string): void {
  switchSection(sectionKey, toolKey);
}

function switchSection(sectionKey: string, toolKey?: string): void {
  // Fire tool-exit hooks BEFORE the view changes. Budget debounces its saves
  // (400 ms), so an edit made just before navigating away would otherwise
  // still be sitting in the queue when the tool re-locks or the state resets.
  const nextViewKey = `${sectionKey}/${toolKey ?? ""}`;
  if (_activeViewKey === "tracking/budget" && nextViewKey !== "tracking/budget") {
    onBudgetToolExit();
  }
  // Kanban for the same reason, plus one of its own: its session password is
  // given up here when the tool lock is on, and any queued edit has to be
  // written while that password is still held.
  if (_activeViewKey === "productivity/kanban" && nextViewKey !== "productivity/kanban") {
    void onKanbanToolExit();
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
  // a theme that colors per tool (Blades) has no other way to reach them.
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
  // This is NOT about the category sections. Each category still has its own
  // #section-<id> container holding that category's tool views, so
  // activateSection("productivity") resolves normally today and will keep
  // doing so if landing pages come back. Nor is it about "lastCategory",
  // which has its own branch in loadShellState() and resolves through
  // state.lastCategory. What reaches this guard is a key with no section at
  // all: a hand-edited settings file, or a shell-state naming a section that
  // no longer exists AND that currentSectionId() has no rename for.
  if (!sectionEl && sectionKey !== "home") {
    devWarn(`[nav] no section "${sectionKey}", falling back to home`);
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
  if (section === "tracking" && tool === "game-stats") onGameStatsIconClicked();
  if (section === "productivity" && tool === "kanban") onKanbanIconClicked();
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

  // Only the tool entries. Home, About, Settings and the collapse toggle are
  // sidebar furniture, not list entries, so there is nothing to hide or sort
  // about them; the toggle gets its own menu below.
  const section = item.dataset.section;
  const tool = item.dataset.tool;
  if (section && tool) attachMenu(item, () => toolEntryMenu(section, tool));
});

const sidebarToggleEl = document.getElementById("sidebarToggle")!;

sidebarToggleEl.addEventListener("click", () => {
  document.getElementById("sidebar")!.classList.toggle("expanded");
});

// The collapse control gets the list-level actions: the sort modes, and a way
// into the modal. Reaching either otherwise means Settings → Customize.
//
// Passed as a named function rather than an inline arrow on purpose.
// SIDEBAR_SORT_MENU comes from sidebar-edit.ts, which is a circular-import
// partner of this file, so the startup-order check in
// scripts/checks/module-init.test.mjs has to be able to see that the read
// happens on click and not at load. It recognizes a function declaration as
// deferred; an `() => [ … ]` with no braces it cannot tell apart from a value
// being built on the spot, and it errs toward flagging.
attachMenu(sidebarToggleEl, sidebarListMenu);

function sidebarListMenu(): MenuItem[] {
  return [
    { label: "Customize Home/Sidebar…", onClick: openSidebarEditModal },
    ...sidebarSortItems(),
  ];
}

/** The sort modes as menu rows, with the active one grayed out. Shared by the
 *  collapse control's menu and every tool entry's Sort submenu. */
function sidebarSortItems(): MenuItem[] {
  return SIDEBAR_SORT_MENU.map((s) => ({
    label: s.label,
    disabled: settings.sidebarSort === s.mode,
    onClick: () => applySidebarSort(s.mode),
  }));
}

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
  if (section === "tracking" && tool === "budget") onBudgetToolEntry();
  if (section === "tracking" && tool === "game-stats") onGameStatsToolEntry();
  if (section === "files" && tool === "auto-backup") onAutoBackupToolEntry();
  if (section === "productivity" && tool === "kanban") onKanbanToolEntry();

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
    attachMenu(card, () =>
      toolEntryMenu(card.dataset.section!, card.dataset.tool!),
    );
  });

/* =============================================================================
   HOME CARD / SIDEBAR ITEM MENUS
   -----------------------------------------------------------------------------
   The same menu on both surfaces, because they are the same list: a Home card
   and a sidebar item are two renderings of one entry in settings.sidebarItems,
   and hiding one hides the other. Building it once is what guarantees they
   keep agreeing.

   The actions themselves belong to sidebar-edit.ts and are called through its
   exported entry points, so a menu and the Edit Home/Sidebar modal always do
   the same thing.
============================================================================= */

function toolEntryMenu(section: string, tool: string): MenuItem[] {
  const key = `${section}/${tool}`;
  return [
    { label: "Open", onClick: () => activateToolFromClick(section, tool) },
    {
      label: "Hide from Home & Sidebar",
      // Hiding the tool you are currently in sends you back to Home; that is
      // setPinned's own behavior, not something this menu adds.
      onClick: () => setPinned(key, false),
    },
    { label: "Customize Home/Sidebar…", onClick: openSidebarEditModal },
    { label: "Sort", submenu: sidebarSortItems() },
  ];
}

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
   after another now, so a nudge that lingered twice as long as its neighbor
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
    // The three section fields are mapped through the rename table for the
    // same reason settings' keys are: shell-state.json outlives a
    // re-categorisation, and an un-mapped section names a #section-<id> that
    // no longer exists, so the app opens to a blank main pane.
    _lastTool = state.lastTool ?? null;
    _lastToolSection =
      (state.lastToolSection && state.lastTool
        ? currentSectionForTool(state.lastToolSection, state.lastTool)
        : currentSectionId(state.lastToolSection)) ?? null;
    _lastCategory = currentSectionId(state.lastCategory) ?? null;
    const activeSectionId =
      (state.activeSection && state.activeTool
        ? currentSectionForTool(state.activeSection, state.activeTool)
        : currentSectionId(state.activeSection)) ?? null;

    const target = settings.startupTarget ?? "lastView";

    if (target === "lastView") {
      // Restore exactly where the user left off, tool, landing, or home
      if (state.activeTool && activeSectionId) {
        activateToolIfPinned(activeSectionId, state.activeTool);
      } else if (activeSectionId) {
        activateSection(activeSectionId);
      } else {
        activateSection("home");
      }
    } else if (target === "lastTool") {
      // Restore the last tool opened, regardless of where the user closed from
      if (state.lastTool && _lastToolSection) {
        activateToolIfPinned(_lastToolSection, state.lastTool);
      } else {
        activateSection("home");
      }
    } else if (target === "lastCategory") {
      // Restore the last real category visited, never Home
      if (_lastCategory) {
        activateSection(_lastCategory);
      } else {
        activateSection("home");
      }
    } else if (target === "home") {
      activateSection("home");
    } else if (target.includes(":")) {
      // Specific tool, format is "section:tool-id"
      const [section, tool] = currentStartupTarget(target).split(":");
      activateToolIfPinned(section, tool);
    } else {
      // Specific category, value matches a section key (e.g. "productivity")
      activateSection(currentSectionId(target) ?? target);
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

/** Lets a tool with its own internal sub-pages (Game Stats' Home/New Game/
 *  Historical/Stats views, Kanban's gallery/board views) claim the mouse
 *  back/forward buttons while it's the active tool. back()/forward() should
 *  return true once they've handled the navigation themselves, or false to
 *  fall through to this shell's own section/tool-level history (e.g. once the
 *  tool's own sub-history is exhausted).
 *
 *  A LIST rather than one slot. Every handler is asked in turn until one says
 *  it handled the press, and each one's first job is to check whether its own
 *  tool is actually on screen, so at most one can ever claim a given press.
 *  This used to be a single slot, which was correct only while exactly one
 *  tool used it: the second tool to register at startup would silently take
 *  the buttons away from the first, and the failure looked like "the back
 *  button stopped working in Game Stats" with nothing in Game Stats to blame. */
export type SubNavHandler = { back: () => boolean; forward: () => boolean };
const subNavHandlers: SubNavHandler[] = [];

/** Registers a tool's sub-navigation handler. Passing null clears every
 *  registration, which nothing does today; it exists so the registry can be
 *  torn down in a test without reaching into module state. */
export function setSubNavHandler(handler: SubNavHandler | null): void {
  if (handler === null) {
    subNavHandlers.length = 0;
    return;
  }
  if (!subNavHandlers.includes(handler)) subNavHandlers.push(handler);
}

/** Asks each registered tool, in registration order, whether it handled the
 *  press. Returns true as soon as one does. */
function runSubNav(direction: "back" | "forward"): boolean {
  return subNavHandlers.some((h) => h[direction]());
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
      if (runSubNav("back")) return;
      navigateBack();
    } else {
      if (runSubNav("forward")) return;
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

// The text-field menu reports a refused clipboard read as a toast. Handed
// over rather than imported, so edit-menu.ts stays free of the shell.
setEditMenuNotify(flash);

/* -----------------------------------------------------------------------------
   THE LAST RIGHT-CLICK HANDLER
   ---------------------------------------------------------------------------
   The webview's own right-click menu (Back, Reload, Save as, Inspect, View
   source) is all browser concepts that mean nothing in a desktop app, and
   several of them can visibly break it, so it never appears. This handler is
   what replaces it.

   Deliberately a BUBBLING listener on window, which makes it the LAST thing
   the event reaches. Any element that wants its own menu adds a contextmenu
   listener of its own (see attachMenu in menu.ts); that one runs first on the
   way up and stops the event, so this never sees the clicks it claimed. What
   is left here is exactly "a right-click nothing else wanted": the page
   background, a panel, the gap between controls.

   Two menus come out of that:

     a text field   Cut / Copy / Paste / Select All / Undo / Redo, drawn by
                    the app. See edit-menu.ts. This used to be the one place
                    the webview's menu was left alone, because those commands
                    were worth more than a blank gesture; now there is an app
                    menu that does the same six things.
     anywhere else  the background menu: the open tool's own header buttons,
                    then Settings / About / Immersive / Exit. See
                    backgroundMenu() below.
----------------------------------------------------------------------------- */
window.addEventListener("contextmenu", (e: MouseEvent) => {
  e.preventDefault();

  if (isTextEntry(e.target)) {
    openEditMenu(e.target as HTMLElement, e.clientX, e.clientY);
    return;
  }

  if (!backgroundMenuAvailable()) return;
  openMenu({ x: e.clientX, y: e.clientY }, backgroundMenu());
});

/** True for the elements that get the text-editing menu: a text-editable
 *  input, a textarea, or a contenteditable region. A non-text input
 *  (checkbox, range, color, file) has nothing to cut or paste, so it is
 *  treated like the rest of the page. */
function isTextEntry(target: EventTarget | null): boolean {
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  if (target instanceof HTMLInputElement) {
    // Types that hold selectable, editable text. A readonly field still
    // qualifies: Copy and Select All are the point there.
    return /^(text|search|url|tel|email|password|number|)$/.test(target.type);
  }
  return false;
}

/* =============================================================================
   IMMERSIVE MODE  (F11)
   -----------------------------------------------------------------------------
   F11 cycles through three stages, so the chrome comes off in the order you
   are most likely to want it gone rather than all at once:

     0  Windowed. Everything visible. Where every session starts.
     1  Fullscreen, title bar and sidebar hidden. The tool keeps its own
        header bar, so its Back button, Setup button and sub-nav tabs are all
        still reachable. This is the stage most work happens in.
     2  Also hides the tool header bar. Nothing left but the tool itself.
     →  Back to 0.

   Fullscreen is entered on the way into stage 1 and left on the way back to
   0; stage 1 → 2 is a pure CSS change, which is why the OS call is guarded on
   the boolean changing rather than fired on every press.

   The layout half is body.immersive (stages 1 and 2) plus
   body.immersive-headers (stage 2 only) in shell.css.

   Deliberately NOT persisted. Immersive hides the title bar, which is the
   only close button and the only drag handle this window has (the OS one is
   off, see decorations:false in tauri.conf.json). Restoring it at launch
   would open the app with no visible way out of it, so every session starts
   windowed and F11 is the only way in.

   No hover-to-reveal strip. Two things stand in for one: staging, so stage 1
   still keeps every header control, and the background menu (see THE
   BACKGROUND MENU below), which puts those controls plus Settings, About and
   Exit on a right-click anywhere on empty space. That menu is also a second
   way out of stage 2, alongside F11.
============================================================================= */

/** 0 windowed · 1 fullscreen, no shell chrome · 2 also no tool header. */
type ImmersiveStage = 0 | 1 | 2;

let immersiveStage: ImmersiveStage = 0;

/** Moves to an immersive stage. The classes and the OS fullscreen state are
 *  set together so the two can never disagree. */
async function setImmersiveStage(stage: ImmersiveStage): Promise<void> {
  if (stage === immersiveStage) return;
  const wasFullscreen = immersiveStage > 0;
  immersiveStage = stage;

  document.body.classList.toggle("immersive", stage > 0);
  document.body.classList.toggle("immersive-headers", stage === 2);
  refreshViewModeButtons();

  const wantFullscreen = stage > 0;
  if (wantFullscreen === wasFullscreen) return;
  try {
    await getCurrentWindow().setFullscreen(wantFullscreen);
  } catch {
    // Fullscreen refused (or no window, in a browser dev context). The chrome
    // is already hidden, which is most of the value, so leave it that way
    // rather than half-reverting into a state the classes no longer describe.
  }
}

/* The App Settings > Display "View Mode (F11)" segmented control. It is a
   second face on the same state, not a second setting: pressing F11 moves the
   buttons, and pressing a button is the same call F11 makes. Which is why
   setImmersiveStage() repaints them rather than the click handler doing it. */
const viewModeGroup = document.getElementById("viewModeGroup")!;

function refreshViewModeButtons(): void {
  viewModeGroup.querySelectorAll<HTMLButtonElement>(".toggle-btn").forEach((btn) => {
    btn.classList.toggle("active", Number(btn.dataset.value) === immersiveStage);
  });
}

viewModeGroup.querySelectorAll<HTMLButtonElement>(".toggle-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    void setImmersiveStage(Number(btn.dataset.value) as ImmersiveStage);
  });
});

/** Whether any shell chrome is currently hidden (stage 1 or 2). */
export function isImmersive(): boolean {
  return immersiveStage > 0;
}

/** Moves to the next view mode, wrapping Standard → Spacious → Bare →
 *  Standard. What F11 does, and what the Toggle View row on the background
 *  menu does, because they are the same control with two faces. */
function cycleViewMode(): void {
  void setImmersiveStage(((immersiveStage + 1) % 3) as ImmersiveStage);
}

// Capturing, like the F7 handler above, so this beats any default handling of
// F11 in the webview and the app is the only thing deciding what the key does.
window.addEventListener(
  "keydown",
  (e: KeyboardEvent) => {
    if (e.key !== "F11") return;
    e.preventDefault();
    e.stopImmediatePropagation();
    cycleViewMode();
  },
  { capture: true },
);

/* =============================================================================
   THE BACKGROUND MENU
   -----------------------------------------------------------------------------
   Right-click on anything that has no menu of its own (the page background,
   a panel, the sidebar below the last icon, the title bar) and this is what
   opens.

   It exists because of immersive mode. F11 stage 1 takes away the title bar
   and the sidebar, stage 2 takes away the tool's header bar as well, and up to
   now that meant App Settings, About, Exit, Back-to-Home and every tool's own
   header buttons went with them. The gesture that gets them back has to be one
   that works on empty space, because empty space is all stage 2 leaves.

   Two groups, ruled apart:

     the open tool's header buttons  read off the header bar itself, so a tool
                                     that gains a button gains a menu row with
                                     no code here to change. Nothing on Home,
                                     which has no header buttons.
     the app-wide rows               About, App Settings, Toggle View, Exit.
                                     Shared with the title bar's menu so the
                                     two can never disagree.

   NOT shown while a modal or the lock screen is up. A modal is a destination
   with its own way out; opening App Settings behind one, or offering Exit from
   the lock screen, is not something the gesture should be able to do.
============================================================================= */

/** The view and header bar of the tool currently open, or null on Home.
 *
 *  Found through body[data-active-tool], which switchSection() maintains, and
 *  not by looking for a visible header: at immersive stage 2 the header is
 *  display:none, which is precisely when this menu matters most. */
function activeToolHeader(): { view: HTMLElement; header: HTMLElement } | null {
  const key = document.body.dataset.activeTool;
  if (!key) return null;
  const [section, tool] = key.split("/");
  const view = document.getElementById(`${section}-tool-${tool}`);
  const header = view?.querySelector<HTMLElement>(".tool-view-header");
  return view && header ? { view, header } : null;
}

/** Whether `btn` would be on screen if the header bar were.
 *
 *  offsetParent would be the usual test and is no use here: the whole header
 *  is display:none at immersive stage 2, which would report every button in
 *  it as hidden. So the chain from the button up to the tool view is walked
 *  by hand, skipping the header itself and nothing else. Skipping only the
 *  header is what keeps the two real cases apart:
 *
 *    a button hidden inside a shown header   Kanban's Board Setup, which only
 *                                            appears once a board is open.
 *                                            Correctly left off the menu.
 *    a hidden header inside a shown view     Budget behind its password gate,
 *                                            where the whole tool including
 *                                            its header is switched off.
 *                                            Also correctly left off. */
function isShownInHeader(btn: HTMLElement, header: HTMLElement, view: HTMLElement): boolean {
  const stop = view.parentElement;
  for (let node: HTMLElement | null = btn; node && node !== stop; node = node.parentElement) {
    if (node === header) continue;
    if (node.hidden) return false;
    if (getComputedStyle(node).display === "none") return false;
  }
  return true;
}

/** A header button's menu label: its own text, or, for the icon-only Back
 *  button, the tooltip that is the only words it has. */
function headerButtonLabel(btn: HTMLButtonElement): string {
  const text = (btn.textContent ?? "").replace(/\s+/g, " ").trim();
  if (text !== "") return text;
  return (btn.getAttribute("aria-label") ?? btn.title).trim();
}

/** Every button on the open tool's header bar, as menu rows that click it.
 *
 *  Read off the DOM rather than declared per tool. A tool's header is already
 *  the single statement of what that tool offers at the top level; a second
 *  list here would be a second thing to keep in step, and the one that gets
 *  forgotten. Sub-nav tabs are included and the current one is grayed out,
 *  the same way the sidebar Sort submenu grays out the mode already in use. */
function toolHeaderItems(): MenuItem[] {
  const active = activeToolHeader();
  if (!active) return [];
  const { view, header } = active;

  const items: MenuItem[] = [];
  header.querySelectorAll<HTMLButtonElement>("button").forEach((btn) => {
    if (btn.disabled || !isShownInHeader(btn, header, view)) return;
    const label = headerButtonLabel(btn);
    if (label === "") return;
    items.push({
      label,
      disabled: btn.classList.contains("active"),
      onClick: () => btn.click(),
    });
  });
  return items;
}

/** The rows that mean the same thing everywhere in the app.
 *
 *  Toggle View is the same cycle F11 runs, all three modes rather than a
 *  two-way switch, so the menu can reach Bare and can walk back out of it the
 *  same way the key does. */
function appMenuItems(): MenuItem[] {
  return [
    { label: "About…", onClick: () => document.getElementById("aboutBtn")!.click() },
    { label: "App Settings…", onClick: () => settingsModal.open() },
    { label: "Toggle View (F11)", onClick: cycleViewMode },
    { label: "Exit Swiss RB Knife…", danger: true, onClick: () => openExitModal() },
  ];
}

/** Whether a right-click on empty space should produce a menu at all. */
function backgroundMenuAvailable(): boolean {
  if (lockScreen.style.display === "flex") return false;
  if (document.body.classList.contains("modal-open")) return false;
  return true;
}

/** The whole background menu: the open tool's header buttons, then the
 *  app-wide rows. The separator between them is dropped by menu.ts when the
 *  first group is empty, which is every right-click on Home. */
function backgroundMenu(): MenuItem[] {
  return [...toolHeaderItems(), { separator: true }, ...appMenuItems()];
}

// The title bar gets the app-wide rows on their own. It is only ever visible
// at stage 0, where the tool's header bar is visible too and one right-click
// away, so repeating its buttons up here would be a longer menu saying the
// same thing.
attachMenu(document.getElementById("titleBar")!, appMenuItems);

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
  applyAudioSettings();
  themeSelect.value = settings.theme;
  refreshThemeCurrentBadge();

  // The Random tab's settings panel (visibility + enabled/grayed state) is
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
  cycleHolidaySeasonOnlyToggle.checked = settings.cycleHolidaySeasonOnly;
  cycleHolidaySeasonOnlyLabel.textContent = settings.cycleHolidaySeasonOnly ? "On" : "Off";
  syncHolidayOverrideControls();
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
/* Tools whose category (and therefore whose key) has changed, old key ->
   current key. Same permanence and the same bar as RENAMED_SOUND_PACKS and
   THEME_ID_MIGRATIONS: an entry earns its place the day a key that shipped
   changes, and is then never removed, because dropping it strands anyone
   whose settings still name it, whether from an older build, a restored
   backup, or a hand-edited file.

   Without these, re-categorising is silently destructive rather than merely
   inconvenient: normalizeSidebarItems() drops any key not in ALL_TOOLS, so an
   un-migrated tool loses its place in the order, its pin state and its usage
   counts, and re-appears unpinned at the end of the list as though it were
   brand new.

   2026-08-30 (v0.6.1): the five old sections (finance, utility, files, games,
   media, of which "utility" held six of eleven tools) were replaced by the
   four categories in TOOL_CATEGORIES. Only auto-backup and
   dummy-file-generator kept their key. */
export const RENAMED_TOOL_KEYS: Record<string, string> = {
  "finance/budget": "tracking/budget",
  "utility/time-tracker": "tracking/time-tracker",
  "utility/kanban": "productivity/kanban",
  "utility/countdown": "productivity/countdown",
  "games/game-stats": "tracking/game-stats",
  "media/image-ccr": "files/image-ccr",
  "utility/days-between": "calculators/days-between",
  "utility/tts-repeater": "productivity/tts-repeater",
  "utility/rng": "calculators/rng",
};

/** Maps a possibly-stale tool key to the current one. Keys that were never
 *  renamed pass straight through, still to be validated by the caller. */
export function currentToolKey(key: string): string {
  return RENAMED_TOOL_KEYS[key] ?? key;
}

/** The section a stored "<section>/<tool>" pair resolves to now.
 *
 *  Always prefer this over currentSectionId() when a tool is in hand. A pair
 *  is exact; a bare section cannot be, because "utility" split three ways. */
function currentSectionForTool(section: string, tool: string): string {
  return currentToolKey(`${section}/${tool}`).split("/")[0];
}

/** Maps a possibly-stale SECTION id to the current one, for the persisted
 *  fields that name a section with no tool beside it.
 *
 *  Only old sections whose every tool landed in the SAME new one are mapped.
 *  "utility" is deliberately absent: its six tools went to three different
 *  categories, so any answer here would be a guess, and a guess sends the app
 *  to a category the user was not in. Left unmapped, it falls through
 *  activateSection()'s existing "no such section" guard to Home, which is
 *  wrong in a way the user can see and correct rather than wrong in a way
 *  that looks deliberate. */
export function currentSectionId<T extends string | null | undefined>(id: T): T | string {
  if (!id) return id;
  const targets = new Set(
    Object.entries(RENAMED_TOOL_KEYS)
      .filter(([from]) => from.split("/")[0] === id)
      .map(([, to]) => to.split("/")[0]),
  );
  return targets.size === 1 ? [...targets][0] : id;
}

/** The same map in the "section:tool" form the On Startup select uses, so
 *  a stored startup target survives a re-categorisation too. Derived rather
 *  than written out twice, which is what keeps the two from drifting. */
function currentStartupTarget(target: string): string {
  if (!target.includes(":")) return target;
  return currentToolKey(target.replace(":", "/")).replace("/", ":");
}

function normalizeSidebarItems(raw: unknown): SidebarItemState[] {
  const candidates: SidebarItemState[] = Array.isArray(raw)
    ? raw.filter(
        (it): it is SidebarItemState =>
          it !== null &&
          typeof it === "object" &&
          typeof (it as SidebarItemState).key === "string" &&
          typeof (it as SidebarItemState).pinned === "boolean",
      )
        // Renames are applied BEFORE the "is this a tool we know about" test
        // below, or a re-categorised tool fails it and is dropped along with
        // everything the user had set on it.
        .map((it) => ({ ...it, key: currentToolKey(it.key) }))
        .filter((it) => ALL_TOOLS.some((t) => t.key === it.key))
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
      // Mapped through the rename table first, so a startup target naming a
      // tool's old category still resolves. Without that it fails the
      // isKnownStartupTarget check and silently reverts to Last View, which
      // reads as the setting having been forgotten.
      startupTarget:
        typeof merged.startupTarget === "string" &&
        isKnownStartupTarget(currentStartupTarget(merged.startupTarget))
          ? currentStartupTarget(merged.startupTarget)
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
        SOUND_PACKS.some((p) => p.id === currentSoundPackId(merged.soundPack))
          ? currentSoundPackId(merged.soundPack)
          : DEFAULT_SETTINGS.soundPack,
      toastVolumeDb:
        typeof merged.toastVolumeDb === "number" &&
        Number.isFinite(merged.toastVolumeDb)
          ? clampCueVolumeDb(Math.round(merged.toastVolumeDb))
          : DEFAULT_SETTINGS.toastVolumeDb,
      // The two cue ids are NOT checked against the manifest here. The
      // folders they name are scanned at build time, so an id can be valid
      // on one machine and gone on the next; the cue pickers resolve that at
      // the point of use (silent cue, badge reads Unavailable) and leave the
      // stored id alone, so a temporarily-missing file is not erased out of
      // settings on load.
      buttonSoundId:
        typeof merged.buttonSoundId === "string"
          ? merged.buttonSoundId
          : DEFAULT_SETTINGS.buttonSoundId,
      buttonVolumeDb:
        typeof merged.buttonVolumeDb === "number" &&
        Number.isFinite(merged.buttonVolumeDb)
          ? clampCueVolumeDb(Math.round(merged.buttonVolumeDb))
          : DEFAULT_SETTINGS.buttonVolumeDb,
      modalSoundId:
        typeof merged.modalSoundId === "string"
          ? merged.modalSoundId
          : DEFAULT_SETTINGS.modalSoundId,
      modalVolumeDb:
        typeof merged.modalVolumeDb === "number" &&
        Number.isFinite(merged.modalVolumeDb)
          ? clampCueVolumeDb(Math.round(merged.modalVolumeDb))
          : DEFAULT_SETTINGS.modalVolumeDb,
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
      toolCategories:
        typeof merged.toolCategories === "boolean"
          ? merged.toolCategories
          : DEFAULT_SETTINGS.toolCategories,
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

export type SettingsTab = "display" | "audio" | "preferences" | "data";

/* Declaration order is tab order: Display is what a fresh open lands on.

   Everything that leaves Settings and comes back (the Customize buttons for
   Sidebar / Theme / the three sound cues, the App Lock flows, the new-version
   flow) closes with { handoff: true } on the way out and returns through
   openSettingsOnTab() below, naming the tab it belongs to. */
const settingsTabs = new ModalTabs<SettingsTab>({
  scope: "#settingsModal",
  key: "settingsTab",
  panes: {
    display: "settingsTabDisplay",
    audio: "settingsTabAudio",
    preferences: "settingsTabPreferences",
    data: "settingsTabData",
  },
  onActivate: (tab) => {
    // The tool list and its counts change as tools are used, so they are read
    // when the tab is looked at rather than once at startup.
    if (tab === "data") refreshDataTab();
  },
});

/* The Data tab's two shell services, handed over rather than imported: shell
   imports data-transfer, and importing back would put the two in a load-order
   loop of exactly the kind module-init.test.mjs exists to catch. */
initDataTransfer({
  flash: (msg, kind, ms) => flash(msg, kind ?? "success", ms),
  confirm: (opts, run) => appConfirm({ ...opts, reopen: () => openSettingsOnTab("data") }, run),
});

/* =============================================================================
   APP CONFIRM
   -----------------------------------------------------------------------------
   The shell's own "are you sure", for actions that belong to the app rather
   than to one tool. Same rule every confirm in this app follows: it REPLACES
   what it was launched from rather than stacking on it, and the caller says how
   to get back, because only the caller knows.
============================================================================= */

let _appConfirmModal: Modal | null = null;
let appConfirmAction: (() => void) | null = null;
let appConfirmReturn: (() => void) | null = null;

function getAppConfirmModal(): Modal {
  if (_appConfirmModal) return _appConfirmModal;
  _appConfirmModal = new Modal(document.getElementById("appConfirmBackdrop")!, {
    closeOnEsc: true,
    onClosed: () => {
      // Still set means this was dismissed by something other than the buttons
      // below (Escape, most likely). That is a dismissal and owes the same
      // journey back.
      const back = appConfirmReturn;
      appConfirmAction = null;
      appConfirmReturn = null;
      back?.();
    },
  });

  const dismiss = (): void => {
    const back = appConfirmReturn;
    appConfirmAction = null;
    appConfirmReturn = null;
    _appConfirmModal!.close({ handoff: true });
    back?.();
  };
  document.getElementById("appConfirmCancelBtn")!.addEventListener("click", dismiss);
  document.getElementById("appConfirmOkBtn")!.addEventListener("click", () => {
    // Captured before the close, because onClosed clears both.
    const action = appConfirmAction;
    appConfirmAction = null;
    appConfirmReturn = null;
    _appConfirmModal!.close({ handoff: true });
    action?.();
  });
  return _appConfirmModal;
}

/** Asks, over the top of nothing. `reopen` runs on dismissal AND after the
 *  action, because unlike a delete these actions leave you somewhere you were
 *  looking at. */
export function appConfirm(
  opts: { title: string; message: string; confirmLabel: string; reopen?: () => void },
  onConfirm: () => void,
): void {
  // Handoff, so the parent keeps its tab and its scroll position.
  if (settingsModal.isOpen) settingsModal.close({ handoff: true });

  const modal = getAppConfirmModal();
  document.getElementById("appConfirmTitle")!.textContent = opts.title;
  document.getElementById("appConfirmMessage")!.textContent = opts.message;
  document.getElementById("appConfirmOkBtn")!.textContent = opts.confirmLabel;
  appConfirmAction = onConfirm;
  appConfirmReturn = opts.reopen ?? null;
  modal.open();
}

export const settingsModal = new Modal(settingsBackdrop, {
  tabs: settingsTabs,
  onOpen: () => applySettings(),
});

/** Opens App Settings, optionally on a named tab.
 *
 *  The one way back into Settings from a panel that left it. Every such panel
 *  sits behind a button on exactly one tab, and that tab is the honest answer
 *  to "where was I?", whether or not the person was ever actually there: reach
 *  Customize Home/Sidebar from a right-click on a Home card and the back arrow
 *  still has to land on Preferences, because that is the only place the
 *  Customize button lives.
 *
 *  Naming the tab rather than letting the modal restore its own is also what
 *  makes a first-ever open land correctly. A modal that has never been opened
 *  has no tab in use to restore, so it would fall back to the first one.
 *
 *  Same shape as openSetupModalOnTab() in budget.ts, openTTSetupOnTab() in
 *  time-tracker.ts, openGsSetupOnTab() in game-stats.ts and openSetupOnTab()
 *  in kanban.ts. Settings was the last tabbed modal in the app not doing this.
 *
 *  Called with no tab (the sidebar's Settings entry, the title bar and
 *  background menus) it is an ordinary open: a fresh one lands on Display. */
export function openSettingsOnTab(tab?: SettingsTab): void {
  if (tab) settingsTabs.select(tab);
  settingsModal.open();
}

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

  // The house name format: rng-YYYY-MM-DD_HH-MM-SS, local time.
  const name = `rng-${fileTimestamp()}`;
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

cycleHolidaySeasonOnlyToggle.addEventListener("change", () => {
  settings.cycleHolidaySeasonOnly = cycleHolidaySeasonOnlyToggle.checked;
  cycleHolidaySeasonOnlyLabel.textContent = settings.cycleHolidaySeasonOnly ? "On" : "Off";
  syncCycleSettingsVisibility();
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

// Both classes, one bubble. .settings-info-btn is the same control in a
// App Settings row; it needs the identical click-to-toggle behavior and
// there is no reason for a second copy of it.
document
  .querySelectorAll<HTMLButtonElement>(
    ".theme-picker-info-btn[data-tooltip], .settings-info-btn[data-tooltip]",
  )
  .forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleThemePickerInfoTooltip(btn, btn.dataset.tooltip ?? "");
    });
  });
document.addEventListener("click", () => closeThemePickerInfoTooltip());

/* -----------------------------------------------------------------------------
   Button press cue
   -----------------------------------------------------------------------------
   One delegated listener rather than a cue call in every handler the app has:
   buttons are created dynamically all over this codebase (tool rows, theme
   tiles, generated lists) and anything per-handler would miss them and go on
   missing them as new ones are added.

   Not only <button>. The things that feel most like buttons in this app are
   the Home tool cards and the sidebar's tool listings, and neither is one:
   they are a <div> and an <li>. They are matched explicitly below. The
   sidebar's About and Settings entries are deliberately left out, along with
   the collapse toggle: those three carry no data-section, which is what marks
   a nav item as going somewhere, and the first two open a modal whose own cue
   is the better announcement of what just happened.

   Capture phase, so a handler that calls stopPropagation() (several do, the
   sound-pack tile previews among them) does not silently swallow the cue.

   Excluded: the three sound pickers' tile grids and their volume rows, plus
   the Countdown Timer's alarm Test button. Those all make a sound of their own
   (a preview, or the cue being adjusted), and firing the button cue on top of
   it would compete with the very thing being auditioned. The priority gate
   cannot help here: an audition plays through playSoundUrl(), outside the gate
   entirely, precisely because a preview must never be suppressed. A disabled
   button never fires click at all, so those need no exclusion.

   Silent unless a cue has been chosen; playButtonCue() no-ops on None, which
   is the default. -------------------------------------------------------- */

/** What counts as a press. Anything matching is a cue; `closest` picks the
 *  nearest match, so a real <button> inside a tool card is still the button. */
const BUTTON_CUE_INCLUDE = [
  "button",
  ".nav-item[data-section]",
  ".tool-card[data-tool]",
  ".dashboard-card-header[data-section]",
  // Kanban's board tiles and task cards. Both are divs rather than buttons
  // (each contains a real button, and a button inside a button is markup the
  // browser silently un-nests), so they are named here for the same reason
  // .nav-item and .tool-card are: they are presses in every sense that matters
  // to the person making them.
  ".kb-board-tile[data-board-id]",
  ".kb-card[data-card-id]",
  // Real checkboxes only, the same set shell.css restyles as circles. The
  // inputs inside a .toggle-switch are 0x0 and invisible (the .toggle-slider
  // beside them is what you actually press), so they are not a "checkbox"
  // click in any sense a user would recognize.
  //
  // Clicking a <label> that wraps a checkbox forwards a second, synthetic
  // click to the input itself. The label matches nothing here, so the cue
  // still fires exactly once either way.
  'input[type="checkbox"]:not(.toggle-switch input)',
].join(", ");

const BUTTON_CUE_EXCLUDE = [
  "#soundPackPickerGrid",
  "#buttonSoundPickerGrid",
  "#modalSoundPickerGrid",
  ".sound-volume-row",
  "#cd-sound-test",
].join(", ");

document.addEventListener(
  "click",
  (e) => {
    const pressed = (e.target as HTMLElement | null)?.closest(BUTTON_CUE_INCLUDE);
    if (!pressed || pressed.closest(BUTTON_CUE_EXCLUDE)) return;
    playButtonCue();
  },
  true,
);

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
  activateToolFromClick("tracking", "budget");
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
  // Through the cue gate rather than straight to the element, so a toast
  // fired by a click pre-empts that click's own button cue instead of landing
  // on top of it. See CUE PRIORITY GATE in sound.ts.
  if (!silent) playToastCue(type);

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
    // Entering immersive mode fullscreens the window, which fires onResized
    // and lands here. A fullscreen window is not maximized as far as the OS
    // is concerned, so without this the monitor's dimensions would be written
    // down as the restore size and the app would open at full screen size
    // forever after. Nothing to save while fullscreen: the size that matters
    // is the one already on disk from before F11.
    if (immersiveStage > 0 || (await win.isFullscreen())) return;
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
   INITIALIZATION
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
  devWarn(
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

  // Everything that has to happen on any modal open, funnelled through the
  // one hook modal.ts exposes so it needs no knowledge of either subject:
  // regenerate the random palette (in regenerative-random mode), and play the
  // modal cue. A click that opens a modal fires the button cue too, which is
  // why the two are separate settings rather than one; set either to None.
  setGlobalModalOpenHook(() => {
    maybeRegenerateRandom();
    playModalCue();
  });

  initTimeTracker();
  initImageCCR();
  initFileGen();
  await initAutoBackup();
  await initBudget();
  initGameStats();
  initTTSRepeater();
  initCountdown();
  initDaysBetween();
  initRNG();
  initKanban();

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
