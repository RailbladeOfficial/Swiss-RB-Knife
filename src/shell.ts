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
  applyRandomModalStyles,
  maybeRegenerateRandom,
} from "./random-theme";
import {
  ANIMATED_THEMES,
  applyTheme,
  themeCssUrl,
  getActiveCustomId,
  setActiveCustomId,
} from "./theme-core";
import {
  advanceCycleNow,
  getActiveHolidayOverrideThemeId,
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
type SidebarItemState = {
  key: string;
  pinned: boolean;
  /** Epoch ms this tool was last opened. Absent until it has been. Feeds the
   *  Most Recent sort. */
  lastUsedAt?: number;
  /** How many times it has been opened. Feeds the Most Used sort. */
  useCount?: number;
};

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
type SoundPack = {
  id: string; // stable key, persisted in settings.soundPack
  name: string; // display name shown in the dropdown
  success?: string; // e.g. "/sounds/default/success.wav"
  error?: string; // e.g. "/sounds/default/error.wav"
};

type ShellSettings = {
  fontScale: number;
  hour12: boolean;
  americanDates: boolean;
  solidModals: boolean;
  startupTarget: string;
  theme: string;
  randomPersistent: boolean;
  randomHarmonized: boolean;
  /** Order themes advance through: "sequential" walks the pool in order,
   *  "random" jumps to a random other pool member each time. */
  cycleOrder: "sequential" | "random";
  /** What advances the cycle: "click" reacts to any button click, "everything"
   *  additionally reacts to the same field-commit/change events Random's
   *  Regenerative mode does, "time" advances on a fixed interval instead of
   *  user interaction (see cycleIntervalAmount/cycleIntervalUnit); "onStartup"
   *  advances exactly once per session, the moment the app finishes loading
   *  settings, and never again on its own after that. */
  cycleTrigger: "onStartup" | "time" | "everything" | "click";
  cycleIntervalAmount: number;
  cycleIntervalUnit: "seconds" | "minutes" | "hours" | "days";
  /** Off by default: whether saved Custom Themes are included in the cycle
   *  pool alongside the built-in Main/Holiday/Special themes. */
  cycleIncludeCustom: boolean;
  /** Off by default: force-switches to the matching Holiday theme on its
   *  real-world date, overriding whatever the cycle would otherwise show.
   *  Independent of cycleHolidaySeasonOnly, combine both if you want a
   *  Holiday theme to appear ONLY by being force-switched to. */
  cycleHolidayOverride: boolean;
  /** Off by default, independent of cycleHolidayOverride: keeps each Holiday
   *  theme out of the normal cycle pool except during its own window (so it
   *  can still turn up via ordinary click/interaction/time advances, just
   *  not year-round). */
  cycleHolidaySeasonOnly: boolean;
  /** Off by default: widens each Holiday theme's active window to its
   *  traditional season (e.g. all of October for Halloween) instead of just
   *  its exact date, shared by both settings above, wherever either is on. */
  cycleHolidayFullSeason: boolean;
  /** Which pool member (built-in theme id or custom theme id) Cycle mode is
   *  currently showing, persisted so reopening the app doesn't jump. */
  cycleCurrentThemeId: string;
  /** Epoch ms of the last cycle advance. The anchor the "time" trigger
   *  counts from, persisted so the countdown survives an app restart. */
  cycleLastAdvance: number;
  /** On by default: master switch for every theme's canvas animation (snow,
   *  lightning, fireworks, …). Off suppresses all of them and hides the
   *  per-theme opt-outs below, which only make sense while this is on. */
  themeAnimations: boolean;
  /** Theme ids whose animation is individually switched off while
   *  themeAnimations is still on, e.g. keeping Christmas snow but dropping
   *  Halloween's lightning. Stored as an opt-OUT list so a newly added effect
   *  is enabled by default without needing a migration. */
  themeAnimationsOff: string[];
  appLock: boolean;
  lockCredentialType: "pin" | "password";
  soundPack: string;
  /** Toast cue loudness in decibels, relative to the volume the app has always
   *  played at. 0 is that original level and the default; the usable range is
   *  -25 to +5, with TOAST_VOLUME_MUTED_DB one step below the bottom standing
   *  for silence. Decibels rather than a 0-100 percentage because loudness is
   *  perceived logarithmically, so equal dB steps sound like equal steps. */
  toastVolumeDb: number;
  /** Opt-in: run a single GitHub Releases check on startup (and on enable).
   *  Off by default. The app is offline-by-default and only touches the
   *  network when this is explicitly turned on. */
  autoCheckUpdates: boolean;
  /** How loudly a found update announces itself once per run, false (default)
   *  is Gentle, a toast; true is Aggressive, a modal you have to dismiss.
   *  Mirrors Auto-Backup's reminder mode. The passive signals (sidebar pulse,
   *  Home top-bar line, About notice) show in BOTH modes. This only picks
   *  which one-shot announcement rides along with them. */
  updateNotifyAggressive: boolean;
  /** The release tag the user chose to "ignore" (e.g. "v0.3.4"). A release
   *  NEWER than this re-surfaces the notice; this exact one stays silent.
   *  Empty string = nothing ignored. */
  ignoredUpdateVersion: string;
  /** Sidebar/Home-dashboard tool order + pin state, edited via the "Edit
   *  Sidebar" modal. Pinned items (in this array order) appear on the
   *  sidebar and Home dashboard; unpinned items are hidden from both but
   *  keep all their own data/settings untouched. */
  sidebarItems: SidebarItemState[];
  sidebarSort: SidebarSortMode;
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
const SOUND_PACKS: SoundPack[] = [
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
const ALL_TOOLS: ToolMeta[] = [
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
type SidebarSortMode = "classic" | "az" | "za" | "recent" | "used" | "custom";

const SIDEBAR_SORT_MODES: SidebarSortMode[] = ["classic", "az", "za", "recent", "used", "custom"];

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
function applySidebarSortMode(): void {
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

const DEFAULT_SETTINGS: ShellSettings = {
  fontScale: 0,
  hour12: false,
  americanDates: false,
  solidModals: true,
  startupTarget: "lastView",
  theme: "default",
  randomPersistent: true,
  randomHarmonized: true,
  cycleOrder: "sequential",
  cycleTrigger: "click",
  cycleIntervalAmount: 1,
  cycleIntervalUnit: "hours",
  cycleIncludeCustom: false,
  cycleHolidayOverride: false,
  cycleHolidaySeasonOnly: false,
  cycleHolidayFullSeason: false,
  cycleCurrentThemeId: "",
  cycleLastAdvance: 0,
  themeAnimations: true,
  themeAnimationsOff: [],
  appLock: false,
  lockCredentialType: "pin",
  soundPack: "default",
  toastVolumeDb: 0, // 0 dB = the level the app shipped with
  autoCheckUpdates: false,
  updateNotifyAggressive: false, // Gentle by default
  ignoredUpdateVersion: "",
  // Placeholder, always overridden with freshSidebarItems() wherever settings
  // get reset to defaults (see the comment on that function for why).
  sidebarItems: [],
  sidebarSort: "classic",
};

/* =============================================================================
   STATE
============================================================================= */

export let settings: ShellSettings = { ...DEFAULT_SETTINGS, sidebarItems: freshSidebarItems() };
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
const randomSubsettings = document.getElementById("randomSubsettings")!;
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
const startupSelect = document.getElementById(
  "startupSelect",
) as HTMLSelectElement;
const soundPackEditBtn = document.getElementById("soundPackEditBtn")!;
const soundPackCurrentBadge = document.getElementById("soundPackCurrentBadge")!;
const soundPackPickerBackdrop = document.getElementById("soundPackPickerBackdrop")!;
const soundPackPickerBack = document.getElementById("soundPackPickerBack")!;
const soundPackPickerClose = document.getElementById("soundPackPickerClose")!;
const soundPackPickerGrid = document.getElementById("soundPackPickerGrid")!;

const sidebarEditBtn = document.getElementById("sidebarEditBtn")!;
const sidebarEditBackdrop = document.getElementById("sidebarEditBackdrop")!;
const sidebarEditBack = document.getElementById("sidebarEditBack")!;
const sidebarEditClose = document.getElementById("sidebarEditClose")!;
const sidebarEditShownList = document.getElementById("sidebarEditShownList")!;
const sidebarEditHiddenList = document.getElementById("sidebarEditHiddenList")!;
const sidebarEditHiddenSection = document.getElementById("sidebarEditHiddenSection")!;
const sidebarHiddenBadge = document.getElementById("sidebarHiddenBadge")!;
const navListEl = document.getElementById("navList")!;
const toolCardGrid = document.querySelector<HTMLElement>(".tool-card-grid");

const themeEditBtn = document.getElementById("themeEditBtn")!;
const themeCurrentBadge = document.getElementById("themeCurrentBadge")!;
const themePickerBackdrop = document.getElementById("themePickerBackdrop")!;
const themePickerBack = document.getElementById("themePickerBack")!;
const themePickerClose = document.getElementById("themePickerClose")!;
const themePickerGrid = document.getElementById("themePickerGrid")!;
const themePickerRandomTileWrap = document.getElementById("themePickerRandomTileWrap")!;
const themePickerCycleTileWrap = document.getElementById("themePickerCycleTileWrap")!;
const themeAnimationsToggle = document.getElementById("themeAnimationsToggle") as HTMLInputElement;
const themeAnimationsLabel = document.getElementById("themeAnimationsLabel")!;
const themeAnimationsPerTheme = document.getElementById("themeAnimationsPerTheme")!;
const themeAnimationsList = document.getElementById("themeAnimationsList")!;
const cycleSubsettings = document.getElementById("cycleSubsettings")!;
const cycleOrderToggle = document.getElementById("cycleOrderToggle") as HTMLInputElement;
const cycleOrderLabel = document.getElementById("cycleOrderLabel")!;
const cycleTriggerSelect = document.getElementById("cycleTriggerSelect") as HTMLSelectElement;
const cycleIntervalRow = document.getElementById("cycleIntervalRow")!;
const cycleIntervalAmountInput = document.getElementById("cycleIntervalAmount") as HTMLInputElement;
const cycleIntervalUnitSelect = document.getElementById("cycleIntervalUnit") as HTMLSelectElement;
const cycleIncludeCustomToggle = document.getElementById("cycleIncludeCustomToggle") as HTMLInputElement;
const cycleIncludeCustomLabel = document.getElementById("cycleIncludeCustomLabel")!;
const cycleHolidayOverrideToggle = document.getElementById("cycleHolidayOverrideToggle") as HTMLInputElement;
const cycleHolidayOverrideLabel = document.getElementById("cycleHolidayOverrideLabel")!;
const cycleHolidaySeasonOnlyToggle = document.getElementById("cycleHolidaySeasonOnlyToggle") as HTMLInputElement;
const cycleHolidaySeasonOnlyLabel = document.getElementById("cycleHolidaySeasonOnlyLabel")!;
const cycleHolidayFullSeasonRow = document.getElementById("cycleHolidayFullSeasonRow")!;
const cycleHolidayFullSeasonToggle = document.getElementById("cycleHolidayFullSeasonToggle") as HTMLInputElement;
const cycleHolidayFullSeasonLabel = document.getElementById("cycleHolidayFullSeasonLabel")!;
const cycleHolidayActiveNote = document.getElementById("cycleHolidayActiveNote")!;
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
let _activeViewKey = "";

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
  _activeViewKey = nextViewKey;

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
function activateSection(sectionKey: string): void {
  switchSection(sectionKey);

  const sectionEl = document.getElementById(`section-${sectionKey}`);
  const defaultTool = sectionEl?.dataset.defaultTool;
  if (defaultTool) {
    activateTool(sectionKey, defaultTool);
  } else {
    activateLanding(sectionKey);
    saveShellState(sectionKey);
  }
}

/** Wraps activateTool() for explicit user clicks only (sidebar icon, Home
 *  tile, tool-card), never for mouse back/forward history replay or
 *  restored-state entry, which call activateTool() directly. Game Stats uses
 *  this to jump back to its tile view even when the icon is clicked while
 *  the tool is already open; see onGameStatsIconClicked(). */
function activateToolFromClick(section: string, tool: string): void {
  activateTool(section, tool);
  if (section === "games" && tool === "game-stats") onGameStatsIconClicked();
}

navItems.forEach((item) => {
  item.addEventListener("click", () => {
    const section = item.dataset.section;
    const tool = item.dataset.tool;
    if (!section) return;
    if (tool) {
      activateToolFromClick(section, tool);
    } else {
      activateSection(section);
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
}

// Dashboard tool buttons and category card headers
document.querySelectorAll<HTMLElement>(".dashboard-tool-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const section = btn.dataset.section!;
    const tool = btn.dataset.tool;
    if (tool) {
      activateToolFromClick(section, tool);
    } else {
      activateSection(section);
    }
  });
});

document
  .querySelectorAll<HTMLElement>(".dashboard-card-header[data-section]")
  .forEach((hdr) => {
    hdr.addEventListener("click", () => {
      activateSection(hdr.dataset.section!);
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
    settings = {
      fontScale:
        typeof merged.fontScale === "number"
          ? merged.fontScale
          : DEFAULT_SETTINGS.fontScale,
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
        typeof merged.startupTarget === "string"
          ? merged.startupTarget
          : DEFAULT_SETTINGS.startupTarget,
      theme:
        typeof merged.theme === "string"
          ? merged.theme
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
        merged.cycleTrigger === "click"
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
          ? merged.cycleCurrentThemeId
          : DEFAULT_SETTINGS.cycleCurrentThemeId,
      cycleLastAdvance:
        typeof merged.cycleLastAdvance === "number"
          ? merged.cycleLastAdvance
          : DEFAULT_SETTINGS.cycleLastAdvance,
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
    };
  } catch {
    settings = { ...DEFAULT_SETTINGS, sidebarItems: freshSidebarItems() };
  }
  // Note: applySettings() is deferred to after loadCustomThemes() in init()
  // so that custom theme application has the themes array available.
  applySettings();
}

/* =============================================================================
   SIDEBAR ORDER / VISIBILITY  (Edit Sidebar modal)
   -----------------------------------------------------------------------------
   Drives three surfaces from a single source of truth (settings.sidebarItems):
   the sidebar nav-items, the Home dashboard's .tool-card-grid, and the
   "Specific Tool" options in the On Startup select. Reordering/hiding here
   only ever moves/hides existing DOM nodes. It never touches a tool's own
   data or settings, so a re-shown tool picks up exactly where it left off.
============================================================================= */

const SIDEBAR_DRAG_HANDLE_SVG = `
  <svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
    <circle cx="8" cy="6" r="1.6" /><circle cx="16" cy="6" r="1.6" />
    <circle cx="8" cy="12" r="1.6" /><circle cx="16" cy="12" r="1.6" />
    <circle cx="8" cy="18" r="1.6" /><circle cx="16" cy="18" r="1.6" />
  </svg>`;

// Same open-eye / eye-with-slash pair used elsewhere in the app to mark a
// visible vs. hidden item. The slashed version here is Budget's exact
// "Excluded from Charts" icon (see budget.ts's summary-row builder), reused
// verbatim so "hidden" reads identically everywhere in the app.
const EYE_SVG_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
const EYE_SHOWN_SVG = `<svg ${EYE_SVG_ATTRS}><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_HIDDEN_SVG = `<svg ${EYE_SVG_ATTRS}><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

/** Whether the given "section/tool" key is currently shown. Defaults to true
 *  for a key with no recorded state, normalizeSidebarItems() should always
 *  have added one for every known tool, so this is just a safety net. */
function isToolPinned(key: string): boolean {
  return settings.sidebarItems.find((it) => it.key === key)?.pinned ?? true;
}

/** Re-syncs the "Specific Tool" options in the On Startup select with the
 *  current visibility state: hides/disables options for hidden tools so a
 *  user never sees (or can pick) a tool that isn't on the sidebar. If the
 *  currently-selected startup target IS one of those now-hidden options,
 *  falls back to "lastView" and persists the change, otherwise the select
 *  would be silently pointed at an option the user can no longer choose. */
function refreshStartupSelectOptions(): void {
  let selectedNowHidden = false;
  ALL_TOOLS.forEach((meta) => {
    const optValue = `${meta.section}:${meta.tool}`;
    const opt = startupSelect.querySelector<HTMLOptionElement>(
      `option[value="${optValue}"]`,
    );
    if (!opt) return;
    const shown = isToolPinned(meta.key);
    opt.hidden = !shown;
    opt.disabled = !shown;
    if (!shown && settings.startupTarget === optValue) selectedNowHidden = true;
  });

  if (selectedNowHidden) {
    settings.startupTarget = "lastView";
    saveSettings();
  }
  startupSelect.value = settings.startupTarget;
}

/** Updates the "Sidebar:" row's status badge in General Settings, hidden
 *  entirely when nothing is hidden, "N tools hidden" otherwise. Mirrors Time
 *  Tracker's CSV import status badge pattern. */
function refreshSidebarHiddenBadge(): void {
  const hiddenCount = settings.sidebarItems.filter((it) => !it.pinned).length;
  if (hiddenCount === 0) {
    sidebarHiddenBadge.style.display = "none";
    return;
  }
  sidebarHiddenBadge.textContent =
    hiddenCount === ALL_TOOLS.length
      ? "All tools hidden"
      : `${hiddenCount} ${hiddenCount === 1 ? "tool" : "tools"} hidden`;
  sidebarHiddenBadge.style.display = "";
}

/** Reorders and shows/hides the sidebar nav-items and Home dashboard
 *  tool-cards to match settings.sidebarItems, then re-syncs the On Startup
 *  select and the Settings-row status badge. Call after ANY change to
 *  settings.sidebarItems (drag, show/hide toggle, reset, or a fresh
 *  settings load). */
function applySidebarOrder(): void {
  // Sorting happens here rather than only at the moment a sort button is
  // clicked, so the usage-driven modes stay live: opening a tool re-ranks the
  // sidebar on the spot instead of at next launch.
  applySidebarSortMode();

  const shownKeys = settings.sidebarItems.filter((it) => it.pinned).map((it) => it.key);
  const shownSet = new Set(shownKeys);

  // Move shown items into order (appendChild on an already-attached node
  // relocates it, repeated in desired order, this leaves everything in that
  // order without disturbing the fixed, non-reorderable nav-items around it:
  // the sidebar-toggle control and Home always stay first).
  shownKeys.forEach((key) => {
    const meta = ALL_TOOLS.find((t) => t.key === key);
    if (!meta) return;
    const li = document.querySelector<HTMLElement>(
      `.nav-item[data-section="${meta.section}"][data-tool="${meta.tool}"]`,
    );
    if (li) {
      li.style.display = "";
      navListEl.appendChild(li);
    }
    const card = toolCardGrid?.querySelector<HTMLElement>(
      `.tool-card[data-section="${meta.section}"][data-tool="${meta.tool}"]`,
    );
    if (card) {
      card.style.display = "";
      toolCardGrid!.appendChild(card);
    }
  });

  ALL_TOOLS.forEach((meta) => {
    if (shownSet.has(meta.key)) return;
    const li = document.querySelector<HTMLElement>(
      `.nav-item[data-section="${meta.section}"][data-tool="${meta.tool}"]`,
    );
    if (li) li.style.display = "none";
    const card = toolCardGrid?.querySelector<HTMLElement>(
      `.tool-card[data-section="${meta.section}"][data-tool="${meta.tool}"]`,
    );
    if (card) card.style.display = "none";
  });

  refreshStartupSelectOptions();
  refreshSidebarHiddenBadge();

  // Every path that changes tool visibility funnels through here, so this is
  // the one place a "sidebarchange" needs announcing. Tools that offer a
  // hand-off to another tool (Countdown Timer → Time Tracker) listen for it so they
  // can disable that offer when the target has been hidden.
  window.dispatchEvent(new CustomEvent("sidebarchange"));
}

/** Whether a tool is currently shown in the sidebar / on Home. Exported for
 *  tools that cross-link to another tool: a hand-off to something the user
 *  has deliberately hidden shouldn't be on offer. Keys are the same
 *  "section/tool" strings ALL_TOOLS uses. */
export function isToolVisible(key: string): boolean {
  return isToolPinned(key);
}

/** Shows or hides a tool, moving it to the end of its new group (shown
 *  entries stay a flat, freely-reorderable list; hidden entries have no
 *  meaningful order of their own). Persists immediately, re-renders both the
 *  live sidebar/Home and (if open) the Edit Sidebar modal, and, per spec,
 *  redirects to Home if the tool being hidden is the one currently open. */
function setPinned(key: string, shown: boolean): void {
  const item = settings.sidebarItems.find((it) => it.key === key);
  if (!item || item.pinned === shown) return;
  item.pinned = shown;

  const withoutItem = settings.sidebarItems.filter((it) => it.key !== key);
  const shownItems = withoutItem.filter((it) => it.pinned);
  const hiddenItems = withoutItem.filter((it) => !it.pinned);
  settings.sidebarItems = shown
    ? [...shownItems, item, ...hiddenItems]
    : [...shownItems, ...hiddenItems, item];

  applySidebarOrder();
  saveSettings();
  renderSidebarEditModal();

  if (!shown && _activeViewKey === key) {
    activateSection("home");
  }
}

// Tracks which shown row is mid-drag, shared by every row's dragover
// handler so a row can find (and move) the node actually being dragged.
let sidebarDragKey: string | null = null;

function attachSidebarDragHandlers(row: HTMLElement, key: string): void {
  row.draggable = true;

  row.addEventListener("dragstart", (e) => {
    sidebarDragKey = key;
    row.classList.add("dragging");
    e.dataTransfer?.setData("text/plain", key);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  });

  // dragend fires unconditionally (whether or not the drag ended over a
  // valid drop target) so the commit belongs here, not in "drop". Relying
  // on "drop" alone would leave the live (already-reordered) DOM out of
  // sync with settings.sidebarItems whenever the user releases outside any
  // row (e.g. drops on the modal's padding or off the modal entirely).
  row.addEventListener("dragend", () => {
    row.classList.remove("dragging");
    sidebarDragKey = null;
    commitShownOrderFromDom();
  });

  row.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (!sidebarDragKey || sidebarDragKey === key) return;
    const draggedEl = sidebarEditShownList.querySelector<HTMLElement>(
      `[data-key="${CSS.escape(sidebarDragKey)}"]`,
    );
    if (!draggedEl) return;
    const rect = row.getBoundingClientRect();
    const before = e.clientY - rect.top < rect.height / 2;
    row.parentElement?.insertBefore(draggedEl, before ? row : row.nextSibling);
  });

  // Still needed so the browser allows the drop to occur at all (without
  // this, some drop targets reject it and the row snaps back).
  row.addEventListener("drop", (e) => e.preventDefault());
}

/** Reads the shown list's current DOM order (post-drag) and writes it back
 *  into settings.sidebarItems, leaving the hidden group's order untouched. */
function commitShownOrderFromDom(): void {
  const orderedKeys = Array.from(
    sidebarEditShownList.querySelectorAll<HTMLElement>("[data-key]"),
  ).map((el) => el.dataset.key!);
  const hiddenItems = settings.sidebarItems.filter((it) => !it.pinned);
  settings.sidebarItems = [
    ...orderedKeys.map((key) => settings.sidebarItems.find((it) => it.key === key)!),
    ...hiddenItems,
  ];
  // A hand-placed order IS the mode from here on. Without this the active sort
  // would re-apply on the very next applySidebarOrder() and silently undo the
  // drag the user just made.
  settings.sidebarSort = "custom";
  applySidebarOrder();
  saveSettings();
  refreshSidebarSortButtons();
}

/** Marks whichever sort button matches the active mode. Nothing is marked
 *  under "custom", a dragged order isn't any of them. */
function refreshSidebarSortButtons(): void {
  document.querySelectorAll<HTMLButtonElement>(".sidebar-sort-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.sort === settings.sidebarSort);
  });
}

function buildSidebarEditRow(item: SidebarItemState, draggable: boolean): HTMLElement {
  const row = document.createElement("div");
  row.className = draggable ? "sidebar-edit-item" : "sidebar-edit-item sidebar-edit-item-hidden";
  row.dataset.key = item.key;

  const meta = ALL_TOOLS.find((t) => t.key === item.key);
  if (!meta) return row; // defensive, normalizeSidebarItems() guarantees a match

  const handle = document.createElement("span");
  handle.className = draggable
    ? "sidebar-edit-drag-handle"
    : "sidebar-edit-drag-handle sidebar-edit-drag-handle-disabled";
  handle.innerHTML = SIDEBAR_DRAG_HANDLE_SVG;
  handle.title = "Drag to reorder";
  row.appendChild(handle);

  const iconWrap = document.createElement("span");
  iconWrap.className = "sidebar-edit-icon";
  const sourceIcon = document.querySelector(
    `.nav-item[data-section="${meta.section}"][data-tool="${meta.tool}"] .nav-icon`,
  );
  if (sourceIcon) iconWrap.appendChild(sourceIcon.cloneNode(true));
  row.appendChild(iconWrap);

  const name = document.createElement("span");
  name.className = "sidebar-edit-name";
  name.textContent = meta.label;
  row.appendChild(name);

  const visibilityBtn = document.createElement("button");
  visibilityBtn.className = item.pinned
    ? "sidebar-edit-visibility-btn"
    : "sidebar-edit-visibility-btn is-hidden";
  visibilityBtn.innerHTML = item.pinned ? EYE_SHOWN_SVG : EYE_HIDDEN_SVG;
  visibilityBtn.title = item.pinned
    ? "Hide from sidebar and Home"
    : "Show on sidebar and Home";
  visibilityBtn.addEventListener("click", () => setPinned(item.key, !item.pinned));
  row.appendChild(visibilityBtn);

  if (draggable) attachSidebarDragHandlers(row, item.key);

  return row;
}

function renderSidebarEditModal(): void {
  sidebarEditShownList.innerHTML = "";
  sidebarEditHiddenList.innerHTML = "";

  const shown = settings.sidebarItems.filter((it) => it.pinned);
  const hidden = settings.sidebarItems.filter((it) => !it.pinned);

  shown.forEach((it) => sidebarEditShownList.appendChild(buildSidebarEditRow(it, true)));
  hidden.forEach((it) => sidebarEditHiddenList.appendChild(buildSidebarEditRow(it, false)));

  sidebarEditHiddenSection.style.display = hidden.length > 0 ? "" : "none";
}

// Replaces (rather than stacks on) the General Settings modal. Same pattern
// Time Tracker's Setup → Add/Edit Activity / CSV Import modals use: opening
// closes the parent first, and a back-arrow (not the X) is what reopens it.
const sidebarEditModal = new Modal(sidebarEditBackdrop, {
  closeOnEsc: true,
  onOpen: () => {
    renderSidebarEditModal();
    refreshSidebarSortButtons();
  },
});

sidebarEditBtn.addEventListener("click", () => {
  settingsModal.close({ handoff: true });
  sidebarEditModal.open();
});

sidebarEditBack.addEventListener("click", () => {
  sidebarEditModal.close();
  settingsModal.open();
});

sidebarEditClose.addEventListener("click", () => sidebarEditModal.close());

/** Shows every hidden tool again. Restored items are appended after the
 *  already-shown ones, keeping their relative order. That only matters under
 *  a custom order, since every sort mode re-ranks the whole list anyway. */
document.getElementById("sidebarUnhideAllBtn")!.addEventListener("click", () => {
  const hidden = settings.sidebarItems.filter((it) => !it.pinned);
  if (hidden.length === 0) return;

  const shown = settings.sidebarItems.filter((it) => it.pinned);
  hidden.forEach((it) => { it.pinned = true; });
  settings.sidebarItems = [...shown, ...hidden];

  applySidebarOrder();
  saveSettings();
  renderSidebarEditModal();
  flash(
    hidden.length === 1 ? "1 tool unhidden" : `${hidden.length} tools unhidden`,
    "success",
  );
});

const SIDEBAR_SORT_LABELS: Record<string, string> = {
  classic: "Classic order",
  az: "Sorted A-Z",
  za: "Sorted Z-A",
  recent: "Sorted by most recent",
  used: "Sorted by most used",
};

document.querySelectorAll<HTMLButtonElement>(".sidebar-sort-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const mode = btn.dataset.sort as SidebarSortMode;
    if (!SIDEBAR_SORT_MODES.includes(mode)) return;
    settings.sidebarSort = mode;
    applySidebarOrder();
    saveSettings();
    renderSidebarEditModal();
    refreshSidebarSortButtons();
    flash(SIDEBAR_SORT_LABELS[mode] ?? "Sidebar sorted", "success");
  });
});

/* =============================================================================
   CHOOSE THEME MODAL
   -----------------------------------------------------------------------------
   Replaces the old <select id="themeSelect"> dropdown with a tabbed grid of
   preview tiles (Main/Holiday/Special/Custom, matching the old optgroups).
   themeSelect itself still exists in the DOM (hidden), theme-editor.ts reads
   and writes its .value directly, so it stays the one place that mapping is
   defined, but it no longer drives anything by firing "change".

   Built-in themes are previewed by fetching their CSS file and pulling a
   handful of --color-* values out with a regex (cheap, cached per theme id.
   These are small static files). Custom themes use their already-in-memory
   `vars` directly, no fetch needed. Random has no fixed palette to preview,
   so it gets a die icon instead; the Custom tab's "add" tile gets a palette
   icon for the same reason.
============================================================================= */

export type ThemePickerTab =
  | "main"
  | "holiday"
  | "special"
  | "cycle"
  | "random"
  | "custom"
  | "preferences";

/** Exported so cycle-theme.ts can build its cycle pool and holiday-override
 *  lookups off the same built-in theme list, rather than duplicating it. */
export const THEME_GROUPS: { tab: ThemePickerTab; themes: { id: string; label: string }[] }[] = [
  {
    tab: "main",
    themes: [
      { id: "default", label: "Default" },
      { id: "light", label: "Light" },
      { id: "dark", label: "Dark" },
      { id: "matte", label: "Matte" },
      { id: "midnight", label: "Midnight" },
      { id: "terminal", label: "Terminal" },
    ],
  },
  {
    tab: "holiday",
    themes: [
      { id: "valentine", label: "Valentine" },
      { id: "mardi-gras", label: "Mardi Gras" },
      { id: "rainbow", label: "Rainbow" },
      { id: "patriot", label: "Patriot" },
      { id: "halloween", label: "Halloween" },
      { id: "thanksgiving", label: "Thanksgiving" },
      { id: "christmas", label: "Christmas" },
    ],
  },
  {
    tab: "special",
    themes: [
      { id: "cake", label: "Cake" },
      { id: "knowledge", label: "Knowledge" },
      { id: "neon", label: "Neon" },
      { id: "retro-electric", label: "Retro-Electric" },
      { id: "halo", label: "Halo" },
    ],
  },
];

const DIE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.2" fill="currentColor" stroke="none"/><circle cx="16" cy="8" r="1.2" fill="currentColor" stroke="none"/><circle cx="8" cy="16" r="1.2" fill="currentColor" stroke="none"/><circle cx="16" cy="16" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/></svg>`;
const CYCLE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></svg>`;
const PALETTE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22a9.5 9.5 0 1 1 0-19c4.7 0 9 3.5 9 8 0 2.5-2 4-4.5 4H15a2 2 0 0 0-1.5 3.3c.4.5.5 1.2.1 1.7-.4.6-1 1-1.6 1z"/><circle cx="7.5" cy="10.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="10.5" cy="7" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="7" r="1.2" fill="currentColor" stroke="none"/><circle cx="17" cy="11" r="1.2" fill="currentColor" stroke="none"/></svg>`;
const EDIT_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>`;
const TRASH_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /></svg>`;

/** Returns the display name for whatever theme is currently active, a
 *  built-in theme's label, "Random", or the active custom theme's own name
 *  (falling back to "Custom" if none is resolvable). Drives both the
 *  Settings-row badge and (indirectly, via re-render) the picker's active
 *  tile highlight. */
function getThemeDisplayName(themeId: string): string {
  if (themeId === "random") return "Random";
  if (themeId === "cycle") return "Cycle";
  if (themeId === "custom") {
    const activeId = getActiveCustomId();
    const active = activeId ? customThemes.find((t) => t.id === activeId) : undefined;
    return active ? active.name : "Custom";
  }
  for (const group of THEME_GROUPS) {
    const match = group.themes.find((t) => t.id === themeId);
    if (match) return match.label;
  }
  return themeId;
}

function refreshThemeCurrentBadge(): void {
  themeCurrentBadge.textContent = getThemeDisplayName(settings.theme);
}

const THEME_PREVIEW_VAR_NAMES = [
  "--color-bg",
  "--color-panel",
  "--color-text",
  "--color-text-muted",
  "--color-btn",
  "--color-accent",
  // Budget's 8-color chart palette, deliberately vivid/distinct per theme
  // (see the "Blue / emerald / amber / red / violet / cyan / orange / mint"
  // comment in each theme's own CSS), so it doubles as a rich "fingerprint"
  // strip for the preview tile. Present in every built-in theme's CSS file
  // AND in RANDOM_VARS (so custom themes carry it too), safe for both tile
  // kinds.
  "--color-chart-1",
  "--color-chart-2",
  "--color-chart-3",
  "--color-chart-4",
  "--color-chart-5",
  "--color-chart-6",
  "--color-chart-7",
  "--color-chart-8",
] as const;

const CHART_VAR_NAMES = [
  "--color-chart-1",
  "--color-chart-2",
  "--color-chart-3",
  "--color-chart-4",
  "--color-chart-5",
  "--color-chart-6",
  "--color-chart-7",
  "--color-chart-8",
] as const;

// Keyed by theme id. These are small static files under /themes/, so a
// per-id fetch is cheap and only ever happens once per session.
const themePreviewCache = new Map<string, Record<string, string>>();

async function fetchThemePreviewVars(themeId: string): Promise<Record<string, string>> {
  const cached = themePreviewCache.get(themeId);
  if (cached) return cached;
  const vars: Record<string, string> = {};
  try {
    const res = await fetch(themeCssUrl(themeId));
    const text = await res.text();
    for (const name of THEME_PREVIEW_VAR_NAMES) {
      const match = text.match(new RegExp(`${name}:\\s*([^;]+);`));
      if (match) vars[name] = match[1]!.trim();
    }
  } catch {
    // Preview tile just keeps its CSS-default colours if the fetch fails.
  }
  themePreviewCache.set(themeId, vars);
  return vars;
}

/** Paints a set of preview vars onto a tile's .theme-tile-preview markup. */
function applyPreviewVars(preview: HTMLElement, vars: Record<string, string>): void {
  if (vars["--color-bg"]) preview.style.background = vars["--color-bg"]!;

  const header = preview.querySelector<HTMLElement>(".theme-tile-preview-header");
  if (header && vars["--color-panel"]) header.style.background = vars["--color-panel"]!;

  const dot = preview.querySelector<HTMLElement>(".theme-tile-preview-dot");
  if (dot && vars["--color-btn"]) dot.style.background = vars["--color-btn"]!;

  const bar = preview.querySelector<HTMLElement>(".theme-tile-preview-bar");
  if (bar && vars["--color-accent"]) bar.style.background = vars["--color-accent"]!;

  const chips = preview.querySelectorAll<HTMLElement>(".theme-tile-preview-chips span");
  CHART_VAR_NAMES.forEach((name, i) => {
    const chip = chips[i];
    if (chip && vars[name]) chip.style.background = vars[name]!;
  });

  const lines = preview.querySelectorAll<HTMLElement>(".theme-tile-preview-lines span");
  if (lines[0] && vars["--color-text"]) lines[0].style.background = vars["--color-text"]!;
  if (lines[1] && vars["--color-text-muted"]) lines[1].style.background = vars["--color-text-muted"]!;
}

function buildPreviewSwatchMarkup(): string {
  const chips = CHART_VAR_NAMES.map(() => "<span></span>").join("");
  return (
    '<div class="theme-tile-preview-header"><span class="theme-tile-preview-dot"></span><span class="theme-tile-preview-bar"></span></div>' +
    `<div class="theme-tile-preview-chips">${chips}</div>` +
    '<div class="theme-tile-preview-lines"><span></span><span></span></div>'
  );
}

// Tiles are plain divs, not <button>. The global `button { color:
// var(--color-btn-text) }` rule (meant for solid-colored buttons) made tile
// names unreadable against a transparent tile background on themes where
// --color-btn-text is light (e.g. Light/Patriot), and custom theme tiles
// need real nested <button>s for their edit/delete icons, which HTML doesn't
// allow inside a <button> ancestor. Click handling + hover cursor are
// replicated via CSS/JS instead of relying on native button semantics.
function buildThemeTile(id: string, label: string): HTMLElement {
  const tile = document.createElement("div");
  tile.className = settings.theme === id ? "theme-tile active" : "theme-tile";
  tile.dataset.themeId = id;

  const preview = document.createElement("div");
  preview.className = "theme-tile-preview";
  preview.innerHTML = buildPreviewSwatchMarkup();
  tile.appendChild(preview);
  fetchThemePreviewVars(id).then((vars) => applyPreviewVars(preview, vars));

  const name = document.createElement("span");
  name.className = "theme-tile-name";
  name.textContent = label;
  tile.appendChild(name);

  tile.addEventListener("click", () => selectTheme(id));
  return tile;
}

function buildRandomTile(): HTMLElement {
  const tile = document.createElement("div");
  tile.className = settings.theme === "random" ? "theme-tile active" : "theme-tile";
  tile.dataset.themeId = "random";

  const preview = document.createElement("div");
  preview.className = "theme-tile-preview";
  const iconWrap = document.createElement("div");
  iconWrap.className = "theme-tile-preview-icon";
  iconWrap.innerHTML = DIE_SVG;
  preview.appendChild(iconWrap);
  tile.appendChild(preview);

  const name = document.createElement("span");
  name.className = "theme-tile-name";
  name.textContent = "Random";
  tile.appendChild(name);

  tile.addEventListener("click", () => selectTheme("random"));
  return tile;
}

function buildCycleTile(): HTMLElement {
  const tile = document.createElement("div");
  tile.className = settings.theme === "cycle" ? "theme-tile active" : "theme-tile";
  tile.dataset.themeId = "cycle";

  const preview = document.createElement("div");
  preview.className = "theme-tile-preview";
  const iconWrap = document.createElement("div");
  iconWrap.className = "theme-tile-preview-icon";
  iconWrap.innerHTML = CYCLE_SVG;
  preview.appendChild(iconWrap);
  tile.appendChild(preview);

  const name = document.createElement("span");
  name.className = "theme-tile-name";
  name.textContent = "Cycle";
  tile.appendChild(name);

  tile.addEventListener("click", () => selectTheme("cycle"));
  return tile;
}

function buildCustomThemeTile(theme: CustomTheme): HTMLElement {
  const isActive = settings.theme === "custom" && getActiveCustomId() === theme.id;
  const tile = document.createElement("div");
  tile.className = isActive ? "theme-tile active" : "theme-tile";
  tile.dataset.themeId = theme.id;

  const preview = document.createElement("div");
  preview.className = "theme-tile-preview";
  preview.innerHTML = buildPreviewSwatchMarkup();
  tile.appendChild(preview);
  applyPreviewVars(preview, theme.vars);

  const footer = document.createElement("div");
  footer.className = "theme-tile-footer";

  const name = document.createElement("span");
  name.className = "theme-tile-name";
  name.textContent = theme.name;
  footer.appendChild(name);

  const actions = document.createElement("div");
  actions.className = "theme-tile-custom-actions";

  const editBtn = document.createElement("button");
  editBtn.className = "theme-tile-icon-btn";
  editBtn.title = "Edit theme";
  editBtn.innerHTML = EDIT_SVG;
  editBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    themePickerModal.close();
    openThemeEditor("edit", theme.id);
  });
  actions.appendChild(editBtn);

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "theme-tile-icon-btn theme-tile-icon-btn-danger";
  deleteBtn.title = "Delete theme";
  deleteBtn.innerHTML = TRASH_SVG;
  deleteBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    requestDeleteCustomTheme(theme.id);
  });
  actions.appendChild(deleteBtn);

  footer.appendChild(actions);
  tile.appendChild(footer);

  tile.addEventListener("click", () => selectCustomTheme(theme.id));
  return tile;
}

function buildNewCustomThemeTile(): HTMLElement {
  const tile = document.createElement("div");
  tile.className = "theme-tile";

  const preview = document.createElement("div");
  preview.className = "theme-tile-preview";
  const iconWrap = document.createElement("div");
  iconWrap.className = "theme-tile-preview-icon";
  iconWrap.innerHTML = PALETTE_SVG;
  preview.appendChild(iconWrap);
  tile.appendChild(preview);

  const name = document.createElement("span");
  name.className = "theme-tile-name";
  name.textContent = "New Custom Theme";
  tile.appendChild(name);

  tile.addEventListener("click", () => {
    themePickerModal.close();
    openThemeEditor("create");
  });
  return tile;
}

/** Which tab houses the currently active theme, main/holiday/special for a
 *  built-in theme, "random" or "custom" for those (regardless, for custom,
 *  of which saved one). */
function tabForCurrentTheme(): ThemePickerTab {
  if (settings.theme === "custom") return "custom";
  if (settings.theme === "random") return "random";
  if (settings.theme === "cycle") return "cycle";
  for (const group of THEME_GROUPS) {
    if (group.themes.some((t) => t.id === settings.theme)) return group.tab;
  }
  return "main";
}

/** Shows/hides the Cycle pane's conditional rows. The interval row only
 *  matters for the "time" trigger, the Full Holiday Season row only matters
 *  once one of Holiday Overrides / Restrict to Holiday Season is on (it's a
 *  shared window-widener for both, so either one turning it on is enough to
 *  make it relevant). Called from applySettings() (so it stays correct even
 *  while the pane isn't open) and whenever the picker renders the Cycle tab. */
function syncCycleSettingsVisibility(): void {
  cycleIntervalRow.style.display = settings.cycleTrigger === "time" ? "" : "none";
  cycleHolidayFullSeasonRow.style.display =
    settings.cycleHolidayOverride || settings.cycleHolidaySeasonOnly ? "" : "none";
}

/** Explains, right where the Holiday Override toggles live, why the theme is
 *  currently pinned to a Holiday theme regardless of the cycle rule, shown
 *  only while an override is actually live today. Refreshed on tab render and
 *  on every "themechange" so it tracks Cycle Now, interaction/time advances,
 *  and the holiday-boundary recheck without needing its own polling. */
const HOLIDAY_NOTE_DATE_FMT = new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric" });

function refreshCycleHolidayNote(): void {
  const holidayId = getActiveHolidayOverrideThemeId();
  if (!holidayId) {
    cycleHolidayActiveNote.style.display = "none";
    return;
  }
  let untilText = "";
  if (settings.cycleHolidayFullSeason) {
    const endDate = getHolidayOverrideEndDate(holidayId);
    if (endDate) {
      const dayAfterEnd = new Date(endDate);
      dayAfterEnd.setDate(dayAfterEnd.getDate() + 1);
      untilText = ` until ${HOLIDAY_NOTE_DATE_FMT.format(dayAfterEnd)}`;
    }
  }
  cycleHolidayActiveNote.textContent =
    `Holiday Override active: showing ${getThemeDisplayName(holidayId)} today, overriding the normal cycle rotation${untilText}.`;
  cycleHolidayActiveNote.style.display = "";
}

/* -----------------------------------------------------------------------------
   Theme Animations (Preferences tab)
----------------------------------------------------------------------------- */

/** Re-applies the seasonal-effect decision for whatever theme is showing.
 *  applySeasonalEffect() already listens for "themechange" and re-reads the
 *  animation settings on each one, so re-dispatching is all it takes to start
 *  or tear down an effect the moment a toggle flips. No direct call needed,
 *  and Cycle's underlying-theme resolution stays in the one place that owns
 *  it (theme-core.ts). */
function refreshSeasonalEffect(): void {
  window.dispatchEvent(new CustomEvent("themechange"));
}

/** Builds one toggle row per animated theme. Rebuilt on each render rather
 *  than diffed, it's eight rows behind a tab that has to be opened, so the
 *  simplicity is worth more than the churn. */
function renderThemeAnimationRows(): void {
  themeAnimationsList.innerHTML = "";

  for (const anim of ANIMATED_THEMES) {
    const row = document.createElement("div");
    row.className = "settings-row";

    const label = document.createElement("span");
    label.className = "theme-animation-label";
    const name = document.createElement("span");
    name.textContent = `${anim.label}:`;
    const effect = document.createElement("span");
    effect.className = "theme-animation-effect";
    effect.textContent = anim.effect;
    label.append(name, effect);

    const wrap = document.createElement("div");
    wrap.className = "toggle-with-label";
    const stateLabel = document.createElement("span");
    const enabled = !settings.themeAnimationsOff.includes(anim.id);
    stateLabel.textContent = enabled ? "Enabled" : "Disabled";

    const switchLabel = document.createElement("label");
    switchLabel.className = "toggle-switch";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = enabled;
    const slider = document.createElement("span");
    slider.className = "toggle-slider";
    switchLabel.append(input, slider);

    input.addEventListener("change", () => {
      const off = settings.themeAnimationsOff.filter((id) => id !== anim.id);
      if (!input.checked) off.push(anim.id);
      settings.themeAnimationsOff = off;
      saveSettings();
      stateLabel.textContent = input.checked ? "Enabled" : "Disabled";
      refreshSeasonalEffect();
    });

    wrap.append(stateLabel, switchLabel);
    row.append(label, wrap);
    themeAnimationsList.appendChild(row);
  }
}

/** Paints the Preferences tab from current settings: master toggle state, and
 *  the per-theme list (hidden entirely while the master switch is off, since
 *  those toggles would otherwise be controls that visibly do nothing). */
function renderThemePreferences(): void {
  themeAnimationsToggle.checked = settings.themeAnimations;
  themeAnimationsLabel.textContent = settings.themeAnimations ? "Enabled" : "Disabled";
  themeAnimationsPerTheme.style.display = settings.themeAnimations ? "" : "none";
  if (settings.themeAnimations) renderThemeAnimationRows();
}

themeAnimationsToggle.addEventListener("change", () => {
  settings.themeAnimations = themeAnimationsToggle.checked;
  saveSettings();
  renderThemePreferences();
  refreshSeasonalEffect();
});

/** Fills in whichever tab was just selected. Registered as the theme picker's
 *  ModalTabs onActivate hook, so showing/hiding the panes and marking the tab
 *  button are already done by the time this runs, leaving only the content. */
function renderThemePickerTab(tab: ThemePickerTab): void {
  if (tab === "preferences") {
    renderThemePreferences();
    return;
  }

  if (tab === "random") {
    themePickerRandomTileWrap.innerHTML = "";
    themePickerRandomTileWrap.appendChild(buildRandomTile());
    // Settings are visible either way, but only interactive once Random is
    // actually the active theme, not just being looked at.
    randomSubsettings.classList.toggle("inactive", settings.theme !== "random");
    return;
  }

  if (tab === "cycle") {
    themePickerCycleTileWrap.innerHTML = "";
    themePickerCycleTileWrap.appendChild(buildCycleTile());
    // Same "visible but inert until actually active" treatment as Random.
    cycleSubsettings.classList.toggle("inactive", settings.theme !== "cycle");
    syncCycleSettingsVisibility();
    refreshCycleHolidayNote();
    return;
  }

  themePickerGrid.innerHTML = "";

  if (tab === "custom") {
    customThemes.forEach((ct) => themePickerGrid.appendChild(buildCustomThemeTile(ct)));
    themePickerGrid.appendChild(buildNewCustomThemeTile());
    syncThemeGridHeight();
    return;
  }

  const group = THEME_GROUPS.find((g) => g.tab === tab);
  group?.themes.forEach((t) => themePickerGrid.appendChild(buildThemeTile(t.id, t.label)));
  syncThemeGridHeight();
}

/** Caps the grid at exactly two full tile rows and lets it scroll beyond
 *  that, instead of the old fixed 58vh cap, which could either clip a
 *  second row's titles or leave dead space, since tile height depends on
 *  how many columns the auto-fill grid ends up with. One or two rows: no
 *  cap, so the modal simply grows to fit. Three or more: capped to the
 *  height of the first two rows, so row three+ scrolls into view instead
 *  of being clipped. Reading offsetTop/offsetHeight forces a synchronous
 *  layout, which is fine here since it runs once right after populating
 *  the grid, not on every frame. */
function syncThemeGridHeight(): void {
  const tiles = Array.from(themePickerGrid.children) as HTMLElement[];
  if (tiles.length === 0) {
    themePickerGrid.style.maxHeight = "";
    return;
  }
  const rowTops = [...new Set(tiles.map((t) => t.offsetTop))].sort((a, b) => a - b);
  if (rowTops.length < 3) {
    themePickerGrid.style.maxHeight = "none";
    return;
  }
  const secondRowTile = tiles.find((t) => t.offsetTop === rowTops[1])!;
  themePickerGrid.style.maxHeight = `${rowTops[1] + secondRowTile.offsetHeight}px`;
}

// Column count (and therefore row height/count) can change on window
// resize, so re-run the cap while the picker is open and on a tab that
// actually uses the grid (Random/Cycle use their own single-tile panes).
window.addEventListener("resize", () => {
  if (themePickerModal.isOpen && themePickerGrid.style.display !== "none") {
    syncThemeGridHeight();
  }
});

/** Selects a built-in theme or "random"/"custom" by id. Same logic the old
 *  themeSelect "change" handler used to run. Re-renders the picker's active
 *  tab afterward so the active-tile highlight tracks the new selection
 *  without closing the modal (letting you flip through a few before leaving). */
function selectTheme(themeId: string): void {
  if (settings.theme === "random" && themeId !== "random") {
    localStorage.removeItem(PERSISTENT_RANDOM_KEY);
  }
  if (settings.theme === "custom" && themeId !== "custom") {
    clearCustomTheme();
  }
  settings.theme = themeId;
  themeSelect.value = themeId;
  applySettings();
  saveSettings();
  themePickerTabs.restore();
}

/** Selects a specific saved custom theme by id, then applies it via
 *  selectTheme("custom"). */
function selectCustomTheme(customId: string): void {
  setActiveCustomId(customId);
  selectTheme("custom");
}

/* The picker's tab strip, on the shared ModalTabs controller (modal.ts) like
   every other tabbed modal. Two things here are specific to this modal:

   • Main/Holiday/Special/Custom all render into the one #themePickerGrid, so
     they share a pane entry. Cycle, Random and Preferences have their own.
   • A fresh open lands on the tab housing the theme in use, not on Main, via
     defaultTab. Returning from a child modal still keeps the tab you left. */
const themePickerTabs = new ModalTabs<ThemePickerTab>({
  scope: "#themePickerBackdrop",
  key: "themeTab",
  panes: {
    main: "themePickerGrid",
    holiday: "themePickerGrid",
    special: "themePickerGrid",
    cycle: "themePickerCyclePane",
    random: "themePickerRandomPane",
    custom: "themePickerGrid",
    preferences: "themePickerPreferencesPane",
  },
  defaultTab: () => tabForCurrentTheme(),
  onActivate: (tab) => renderThemePickerTab(tab),
});

// Replaces (rather than stacks on) the General Settings modal, same pattern
// as the Edit Sidebar modal above. Exported: theme-editor.ts's Create/Edit
// Custom Theme flow returns here (not to Settings) when done, since it's now
// only ever reached from this modal.
export const themePickerModal = new Modal(themePickerBackdrop, {
  closeOnEsc: true,
  tabs: themePickerTabs,
});

/** Reopens Choose Theme on the Custom tab. Exported for theme-editor.ts to call
 *  when returning from Create/Edit/Delete Custom Theme. Selecting the tab before
 *  opening beats letting defaultTab decide, because tabForCurrentTheme() tracks
 *  settings.theme, which those flows don't necessarily change (e.g. editing or
 *  deleting a custom theme that isn't the active one). */
export function reopenThemePickerOnCustomTab(): void {
  themePickerTabs.select("custom");
  themePickerModal.open();
}

themeEditBtn.addEventListener("click", () => {
  settingsModal.close({ handoff: true });
  themePickerModal.open();
});

themePickerBack.addEventListener("click", () => {
  themePickerModal.close();
  settingsModal.open();
});

themePickerClose.addEventListener("click", () => themePickerModal.close());

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
  settings = { ...DEFAULT_SETTINGS, sidebarItems: freshSidebarItems() };
  applySettings();
  saveSettings();
  flash("Settings reset to defaults", "success");
});

fontScaleInput.addEventListener("input", () => {
  settings.fontScale = parseInt(fontScaleInput.value, 10) || 0;
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
  if (settings.theme === "random") {
    const stored = localStorage.getItem(PERSISTENT_RANDOM_KEY);
    if (stored) {
      try {
        applyRandomModalStyles(JSON.parse(stored));
      } catch {
        /* non-critical */
      }
    }
  }
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
   CHOOSE SOUND PACK MODAL
   -----------------------------------------------------------------------------
   Tile cards, same modal-replaces-Settings pattern as Sidebar/Theme. Unlike
   Theme's tiles, these don't preview a different palette, a sound pack has
   no visuals of its own, so the cards just render in the app's own current
   theme. Each card has two icon buttons that play that pack's success/error
   cue directly (independent of the currently *active* pack, and without
   selecting it), selecting the pack itself happens by clicking the tile.
============================================================================= */

const SPEAKER_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>`;

/* =============================================================================
   SOUND API FOR TOOLS
   -----------------------------------------------------------------------------
   Tools that need their own alert cue (Countdown Timer's timer-end alarm) pick from
   the same packs the app ships rather than bundling audio of their own. The
   pack list stays private; these two functions are the whole surface.
============================================================================= */

/** Every cue in every pack (both the success and the error sound) as
 *  pickable options. Ids are "<packId>:<kind>", and an EMPTY pack id means
 *  "whichever pack the app is set to", resolved late so changing the app's
 *  sound pack changes the tool's cue with it. */
export function getSoundOptions(): { id: string; name: string }[] {
  const options: { id: string; name: string }[] = [
    { id: ":success", name: "App pack: Success" },
    { id: ":error", name: "App pack: Error" },
  ];
  SOUND_PACKS.forEach((p) => {
    options.push({ id: `${p.id}:success`, name: `${p.name}: Success` });
    options.push({ id: `${p.id}:error`, name: `${p.name}: Error` });
  });
  return options;
}

/** Resolves a stored sound id to a playable url. Accepts "<packId>:<kind>",
 *  and tolerates the older bare "<packId>" (and "") forms, which meant that
 *  pack's success cue. Returns null when the pack no longer exists
 *  (uninstalled/renamed) so callers degrade to silence rather than throwing. */
export function resolveSoundUrl(soundId: string): string | null {
  const [packPart, kindPart] = soundId.split(":");
  const wanted = packPart || settings.soundPack;
  const pack = SOUND_PACKS.find((p) => p.id === wanted);
  if (!pack) return null;
  return (kindPart === "error" ? pack.error : pack.success) ?? null;
}

/** Plays a cue once and resolves when it finishes (or immediately fails
 *  quiet). Resolving on `ended` is what lets a caller chain repeats without
 *  them overlapping into mush. */
export function playSoundUrl(url: string): Promise<void> {
  return new Promise((resolve) => {
    const audio = new Audio(url);
    const done = (): void => resolve();
    audio.addEventListener("ended", done, { once: true });
    audio.addEventListener("error", done, { once: true });
    audio.play().catch(done);
  });
}

function refreshSoundPackCurrentBadge(): void {
  const pack = SOUND_PACKS.find((p) => p.id === settings.soundPack);
  soundPackCurrentBadge.textContent = pack ? pack.name : settings.soundPack;
}

/** Tracks whatever preview cue is currently playing so a new preview click
 *  can stop it. Without this, rapid clicks across tiles/buttons stack up
 *  and play over each other instead of replacing one another. */
let _soundPackPreviewAudio: HTMLAudioElement | null = null;

/** Plays one specific pack's cue directly, a standalone preview, not tied
 *  to the active successAudio/errorAudio elements used by flash(). Only one
 *  preview ever plays at a time; starting a new one kills the last. */
function previewSoundPackCue(pack: SoundPack, kind: "success" | "error"): void {
  const src = kind === "success" ? pack.success : pack.error;
  if (!src) return;

  if (_soundPackPreviewAudio) {
    _soundPackPreviewAudio.pause();
    _soundPackPreviewAudio.currentTime = 0;
  }

  const audio = new Audio(src);
  _soundPackPreviewAudio = audio;
  audio.addEventListener("ended", () => {
    if (_soundPackPreviewAudio === audio) _soundPackPreviewAudio = null;
  });
  // Through playCue so a preview is heard at the volume the cue will actually
  // play at, which is the whole point of previewing it.
  playCue(audio);
}

/** Selects a sound pack. Same effect the old dropdown's "change" handler
 *  had: applies it, persists it, and flashes a success toast (which, using
 *  the newly-loaded pack, doubles as an audible confirmation). */
function selectSoundPack(id: string): void {
  settings.soundPack = id;
  loadSoundPack(settings.soundPack);
  saveSettings();
  refreshSoundPackCurrentBadge();
  renderSoundPackPickerGrid();
  flash("Sound pack updated", "success");
}

function buildSoundPackTile(pack: SoundPack): HTMLElement {
  const tile = document.createElement("div");
  tile.className = pack.id === settings.soundPack ? "sound-pack-tile active" : "sound-pack-tile";

  const name = document.createElement("span");
  name.className = "sound-pack-tile-name";
  name.textContent = pack.name;
  tile.appendChild(name);

  const actions = document.createElement("div");
  actions.className = "sound-pack-tile-actions";

  const successBtn = document.createElement("button");
  successBtn.className = "sound-pack-preview-btn success";
  successBtn.title = "Preview success sound";
  successBtn.innerHTML = SPEAKER_SVG;
  successBtn.disabled = !pack.success;
  successBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    previewSoundPackCue(pack, "success");
  });
  actions.appendChild(successBtn);

  const errorBtn = document.createElement("button");
  errorBtn.className = "sound-pack-preview-btn error";
  errorBtn.title = "Preview error sound";
  errorBtn.innerHTML = SPEAKER_SVG;
  errorBtn.disabled = !pack.error;
  errorBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    previewSoundPackCue(pack, "error");
  });
  actions.appendChild(errorBtn);

  tile.appendChild(actions);

  tile.addEventListener("click", () => selectSoundPack(pack.id));
  return tile;
}

function renderSoundPackPickerGrid(): void {
  soundPackPickerGrid.innerHTML = "";
  SOUND_PACKS.forEach((pack) => soundPackPickerGrid.appendChild(buildSoundPackTile(pack)));
}

const soundPackPickerModal = new Modal(soundPackPickerBackdrop, {
  closeOnEsc: true,
  onOpen: () => renderSoundPackPickerGrid(),
});

soundPackEditBtn.addEventListener("click", () => {
  settingsModal.close({ handoff: true });
  soundPackPickerModal.open();
});

soundPackPickerBack.addEventListener("click", () => {
  soundPackPickerModal.close();
  settingsModal.open();
});

soundPackPickerClose.addEventListener("click", () => soundPackPickerModal.close());

/* ── Notification volume ──────────────────────────────────────────────────
   Lives on the Audio tab of General Settings, above Notification Sound: same
   subject, but it applies to whichever pack is selected rather than being
   part of picking one. Wired up here, next to the pack picker it shares a tab
   with, rather than up in the settings-modal section. Persisting is debounced
   off the "change" event rather than "input", so dragging across the range
   writes settings once at the end instead of thirty times on the way. */

const soundVolumeSlider = document.getElementById(
  "soundVolumeSlider",
) as HTMLInputElement;
const soundVolumeValue = document.getElementById("soundVolumeValue")!;
const soundVolumeReset = document.getElementById("soundVolumeReset")!;

/** How the current value reads on screen. Three cases, because the two ends of
 *  the range aren't levels: the bottom notch is silence and the centre is the
 *  app's original loudness. */
function toastVolumeLabel(db: number): string {
  if (db <= TOAST_VOLUME_MUTED_DB) return "Muted";
  if (db === 0) return "Default";
  return `${db > 0 ? "+" : ""}${db} dB`;
}

/** Syncs the slider, its read-out, and the Reset button's enabled state to the
 *  current setting. Called from applySettings(), so load, reset-to-defaults and
 *  reopening the modal all stay in step. */
function applyToastVolumeSettings(): void {
  const db = settings.toastVolumeDb;
  soundVolumeSlider.value = String(db);
  soundVolumeValue.textContent = toastVolumeLabel(db);
  soundVolumeValue.classList.toggle("is-muted", db <= TOAST_VOLUME_MUTED_DB);
  (soundVolumeReset as HTMLButtonElement).disabled = db === 0;
}

/** Live feedback while dragging: the read-out tracks the thumb, but nothing is
 *  written to disk until the drag ends. */
soundVolumeSlider.addEventListener("input", () => {
  settings.toastVolumeDb = clampToastVolume(Number(soundVolumeSlider.value));
  applyToastVolumeSettings();
});

soundVolumeSlider.addEventListener("change", () => {
  void saveSettings();
  // Play the active pack's success cue at the new level, so the setting is
  // judged by ear at the moment it's chosen. Muted plays nothing, which is
  // itself the correct preview.
  if (successAudio) playCue(successAudio);
});

soundVolumeReset.addEventListener("click", () => {
  settings.toastVolumeDb = 0;
  applyToastVolumeSettings();
  void saveSettings();
  if (successAudio) playCue(successAudio);
});

/** Double-click the read-out to type an exact dB value, matching the inline
 *  edits elsewhere in the app (Auto-Backup's paths, Budget's amounts, the
 *  Countdown clock): Enter or Tab commits, Escape cancels, blur commits.
 *
 *  Typing is the only way to hit a specific number on a 36-step slider without
 *  fighting the thumb, and "mute"/"muted"/"off" are accepted as words since the
 *  bottom notch has no number to type. */
function beginToastVolumeEdit(): void {
  if (soundVolumeValue.querySelector("input")) return; // already editing

  const original = settings.toastVolumeDb;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "sound-volume-edit";
  input.value =
    original <= TOAST_VOLUME_MUTED_DB ? "muted" : String(original);
  input.setAttribute("aria-label", "Notification volume in decibels");

  soundVolumeValue.textContent = "";
  soundVolumeValue.appendChild(input);
  input.focus();
  input.select();

  let handledByKeydown = false;

  function finish(db: number): void {
    settings.toastVolumeDb = db;
    applyToastVolumeSettings();
    void saveSettings();
    if (successAudio) playCue(successAudio);
  }

  function commit(): void {
    const raw = input.value.trim().toLowerCase();
    if (raw === "muted" || raw === "mute" || raw === "off") {
      finish(TOAST_VOLUME_MUTED_DB);
      return;
    }
    // "Default" is what the read-out shows at 0, so accept it back.
    if (raw === "default") {
      finish(0);
      return;
    }
    // Tolerates a typed "dB" suffix and a leading "+".
    const parsed = Number(raw.replace(/\s*db$/, "").replace(/^\+/, ""));
    if (!Number.isFinite(parsed)) {
      applyToastVolumeSettings(); // put the old value back
      flash(
        `Enter a number between ${TOAST_VOLUME_MIN_DB} and ${TOAST_VOLUME_MAX_DB}, or "muted"`,
        "error",
      );
      return;
    }
    finish(clampToastVolume(parsed));
  }

  input.addEventListener("keydown", (e) => {
    // The slider is a sibling control; stop arrow keys from reaching it.
    e.stopPropagation();
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      handledByKeydown = true;
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      handledByKeydown = true;
      applyToastVolumeSettings();
    }
  });

  input.addEventListener("blur", () => {
    if (handledByKeydown) return;
    commit();
  });
}

soundVolumeValue.addEventListener("dblclick", beginToastVolumeEdit);

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
  activateTool("files", "auto-backup");
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
  activateTool("finance", "budget");
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

// Active pack's audio elements, swapped out by loadSoundPack() whenever the
// Sound Pack setting changes. Null means that cue is muted for this pack.
let successAudio: HTMLAudioElement | null = null;
let errorAudio: HTMLAudioElement | null = null;

/** Swaps the active success/error Audio elements to the given pack. Falls
 *  back to the first registered pack if the id is unknown (e.g. a pack was
 *  removed after being selected). A pack that omits a path mutes that cue. */
function loadSoundPack(id: string): void {
  const pack = SOUND_PACKS.find((p) => p.id === id) ?? SOUND_PACKS[0];
  successAudio = pack.success ? new Audio(pack.success) : null;
  errorAudio = pack.error ? new Audio(pack.error) : null;
}
loadSoundPack(DEFAULT_SETTINGS.soundPack);

/* =============================================================================
   TOAST CUE VOLUME
   -----------------------------------------------------------------------------
   settings.toastVolumeDb shifts every cue up or down from the level the app
   has always played at. 0 dB is that level, so an untouched install sounds
   exactly as it did before this existed.

   Two mechanisms, because one alone can't cover the range:

     quieter (<= 0 dB)  HTMLAudioElement.volume, which is a 0..1 multiplier.
     louder  (>  0 dB)  volume is already pinned at its 1.0 ceiling, so a boost
                        has to go through a Web Audio GainNode, which has no
                        upper limit.

   The Web Audio graph is built lazily, per element, and ONLY when a boost is
   actually asked for. Cues are load-bearing feedback, and routing every one of
   them through an AudioContext that might be suspended or unavailable would
   risk silence for people who never touch this slider. Quieter and default
   keep the plain, proven path.

   Once an element has been wired it stays wired, which is fine: the element's
   own `volume` is applied before the graph sees it, so the two multiply
   cleanly and attenuation still works on a wired element.
============================================================================= */

const TOAST_VOLUME_MAX_DB = 5;
const TOAST_VOLUME_MIN_DB = -25;
/** One step below the quietest real setting, standing for silence rather than
 *  for a level. -25 dB is already very quiet but still audible, and there was
 *  no way to say "off" without a value that means it. */
const TOAST_VOLUME_MUTED_DB = TOAST_VOLUME_MIN_DB - 1;

/** Holds a stored or typed value inside the slider's range, including the mute
 *  notch at the bottom. */
function clampToastVolume(db: number): number {
  if (!Number.isFinite(db)) return 0;
  return Math.min(TOAST_VOLUME_MAX_DB, Math.max(TOAST_VOLUME_MUTED_DB, Math.round(db)));
}

/** Linear amplitude for a decibel offset. 0 dB is 1.0 (unchanged), +6 dB is
 *  roughly double, -6 dB roughly half, and the mute notch is a hard 0. */
function dbToGain(db: number): number {
  if (db <= TOAST_VOLUME_MUTED_DB) return 0;
  return Math.pow(10, db / 20);
}

let _audioCtx: AudioContext | null = null;
/** Gain node per boosted element. Also serves as the "is this one wired yet"
 *  check, since createMediaElementSource() may only be called once per
 *  element and throws on a second attempt. */
const _boostNodes = new WeakMap<HTMLAudioElement, GainNode>();

/** Returns the shared AudioContext, creating it on first boost. Null when the
 *  browser has no Web Audio at all, which sends callers back to the plain path
 *  rather than failing. */
function audioContext(): AudioContext | null {
  if (_audioCtx) return _audioCtx;
  try {
    _audioCtx = new AudioContext();
  } catch {
    _audioCtx = null;
  }
  return _audioCtx;
}

/** Applies the current volume setting to one cue element and plays it from the
 *  start. Never throws: a rejected play() (autoplay policy, missing file) is
 *  swallowed exactly as it was before, and any Web Audio failure degrades to
 *  the plain element at its 1.0 ceiling rather than to silence. */
function playCue(audio: HTMLAudioElement): void {
  const gain = dbToGain(settings.toastVolumeDb);

  // Muted: don't start playback at all rather than playing at volume 0, so a
  // muted cue costs nothing and can't be heard through a boosted graph.
  if (gain === 0) return;

  audio.volume = Math.min(1, gain);

  if (gain > 1) {
    try {
      const ctx = audioContext();
      if (ctx) {
        // A context created before any user gesture starts suspended.
        if (ctx.state === "suspended") void ctx.resume();

        const existing = _boostNodes.get(audio);
        if (existing) {
          existing.gain.value = gain;
        } else if (ctx.state === "running") {
          // Only ever wire an element into a RUNNING graph. Connecting a media
          // element to Web Audio replaces its normal output, so wiring into a
          // suspended context would mute the cue outright. A boosted setting
          // restored at launch, before any click has resumed audio, would then
          // silence the very first toast. Skipping the boost costs loudness for
          // one cue; wiring blind costs the cue.
          const node = ctx.createGain();
          ctx.createMediaElementSource(audio).connect(node);
          node.connect(ctx.destination);
          node.gain.value = gain;
          _boostNodes.set(audio, node);
        }
      }
    } catch {
      /* Boost unavailable; the element still plays at full volume. */
    }
  } else {
    // Back down to unity so an element wired during an earlier boost doesn't
    // keep multiplying after the slider comes back down.
    const node = _boostNodes.get(audio);
    if (node) node.gain.value = 1;
  }

  audio.currentTime = 0;
  audio.play().catch(() => {});
}

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
