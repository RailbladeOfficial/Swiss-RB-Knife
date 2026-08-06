/* =============================================================================
   SHELL  — Swiss RB Knife application shell
   -----------------------------------------------------------------------------
   Top-level orchestrator for the app. Owns:

     • Sidebar navigation (section switching, tool activation, landing pages)
     • Mouse back/forward history stack
     • Shell state persistence (active section/tool across restarts)
     • Settings modal + all setting controls
     • Toast notification system with centralized audio
     • Window size save/restore (DPI-aware, logical pixels)
     • Exit confirm modal
     • Modal instances for the Settings modal and Exit confirm (the rest —
       About, Changelog, Licensing, Full License, README, Security,
       Contributing, License Agreement — live in docs.ts)

   As of Tier 6, the theme system, custom theme editor, lock screen, and the
   About/Changelog/Licensing/README/Security/Contributing/License-Agreement
   modal family have been split into their own files:
     • theme-core.ts    — applyTheme() dispatcher + seasonal canvas effects
     • random-theme.ts  — Random theme palette generation
     • theme-editor.ts  — Custom Theme Editor modal + storage
     • lockscreen.ts    — App Lock screen + Set/Change Credential modal
     • docs.ts          — About/Changelog/Licensing/README/Security/
                           Contributing/License Agreement + startup gates
   This file wires them together via init() but no longer owns their internals.

   Per-tool logic lives in src/tools/<tool>.ts and is initialized via init*()
   calls at the bottom of init(). The Modal primitive (modal.ts) owns all shared
   chrome behaviour (Escape, drag, open-stack, scroll reset).
============================================================================= */

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { Modal, setGlobalModalOpenHook } from "./modal";
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
} from "./tools/budget";
import {
  RANDOM_VARS,
  PERSISTENT_RANDOM_KEY,
  applyRandomModalStyles,
  maybeRegenerateRandom,
} from "./random-theme";
import { applyTheme, getActiveCustomId, setActiveCustomId } from "./theme-core";
import { advanceCycleNow } from "./cycle-theme";
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
  timeout: ReturnType<typeof setTimeout>;
  remaining: number;
  startedAt: number;
};

type NavEntry = {
  section: string;
  tool?: string;
};

/** Static metadata for a real, navigable tool — one entry per sidebar/Home
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
};

/** Advanced visual overrides stored per custom theme. All fields optional —
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
 *  from the public/sounds folder. Omit either (or both) to mute that cue —
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
   *  real-world date, overriding whatever the cycle would otherwise show. */
  cycleHolidayOverride: boolean;
  /** Only meaningful with cycleHolidayOverride on: removes Holiday themes
   *  from the normal cycle pool entirely, so they only ever appear via the
   *  override on their actual date. */
  cycleHolidayExclusive: boolean;
  /** Only meaningful with cycleHolidayOverride on: widens each Holiday
   *  theme's active window to its traditional season (e.g. all of October
   *  for Halloween) instead of just its exact date. */
  cycleHolidayFullSeason: boolean;
  /** Which pool member (built-in theme id or custom theme id) Cycle mode is
   *  currently showing — persisted so reopening the app doesn't jump. */
  cycleCurrentThemeId: string;
  /** Epoch ms of the last cycle advance — the anchor the "time" trigger
   *  counts from, persisted so the countdown survives an app restart. */
  cycleLastAdvance: number;
  appLock: boolean;
  lockCredentialType: "pin" | "password";
  soundPack: string;
  /** Opt-in: run a single GitHub Releases check on startup (and on enable).
   *  Off by default — the app is offline-by-default and only touches the
   *  network when this is explicitly turned on. */
  autoCheckUpdates: boolean;
  /** The release tag the user chose to "ignore" (e.g. "v0.3.4"). A release
   *  NEWER than this re-surfaces the notice; this exact one stays silent.
   *  Empty string = nothing ignored. */
  ignoredUpdateVersion: string;
  /** Sidebar/Home-dashboard tool order + pin state, edited via the "Edit
   *  Sidebar" modal. Pinned items (in this array order) appear on the
   *  sidebar and Home dashboard; unpinned items are hidden from both but
   *  keep all their own data/settings untouched. */
  sidebarItems: SidebarItemState[];
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
   public/sounds/ containing (at minimum) the files referenced below — see
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
   Home dashboard, and the "Specific Tool" options in the On Startup select —
   add a tool here (matching its data-section/data-tool attributes in
   index.html) and it's automatically pinnable/reorderable/hideable. */
const ALL_TOOLS: ToolMeta[] = [
  { key: "finance/budget", section: "finance", tool: "budget", label: "Budget Tracker" },
  { key: "utility/time-tracker", section: "utility", tool: "time-tracker", label: "Time Tracker" },
  { key: "files/auto-backup", section: "files", tool: "auto-backup", label: "Auto-Backup" },
  { key: "media/image-ccr", section: "media", tool: "image-ccr", label: "Image CCR" },
  { key: "files/dummy-file-generator", section: "files", tool: "dummy-file-generator", label: "Dummy File Generator" },
];

/** A fresh default sidebarItems array — all tools pinned, in ALL_TOOLS order.
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
 *  least 10 — every other unit (minutes/hours/days) already clears that floor
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
  cycleHolidayExclusive: false,
  cycleHolidayFullSeason: false,
  cycleCurrentThemeId: "",
  cycleLastAdvance: 0,
  appLock: false,
  lockCredentialType: "pin",
  soundPack: "default",
  autoCheckUpdates: false,
  ignoredUpdateVersion: "",
  // Placeholder — always overridden with freshSidebarItems() wherever settings
  // get reset to defaults (see the comment on that function for why).
  sidebarItems: [],
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

// In-memory shell state — kept in sync with disk so saveShellState never
// needs to read back from Rust just to preserve fields it isn't changing.
// Populated by loadShellState() on startup; updated incrementally thereafter.
let _lastTool: string | null = null;
let _lastToolSection: string | null = null;
let _lastCategory: string | null = null;

// App version string — fetched once during init and reused by both
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
const sidebarEditResetBtn = document.getElementById("sidebarEditResetBtn")!;
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
const themePickerRandomPane = document.getElementById("themePickerRandomPane")!;
const themePickerRandomTileWrap = document.getElementById("themePickerRandomTileWrap")!;
const themePickerCyclePane = document.getElementById("themePickerCyclePane")!;
const themePickerCycleTileWrap = document.getElementById("themePickerCycleTileWrap")!;
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
const cycleHolidayExclusiveRow = document.getElementById("cycleHolidayExclusiveRow")!;
const cycleHolidayExclusiveToggle = document.getElementById("cycleHolidayExclusiveToggle") as HTMLInputElement;
const cycleHolidayExclusiveLabel = document.getElementById("cycleHolidayExclusiveLabel")!;
const cycleHolidayFullSeasonRow = document.getElementById("cycleHolidayFullSeasonRow")!;
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
 * Escapes a string for safe interpolation into innerHTML templates — both as
 * element text AND inside double-quoted attribute values (hence &quot;).
 *
 * Most of the app builds DOM via createElement + textContent, which needs no
 * escaping. This exists for the handful of places that interpolate
 * user-entered strings (bill names, image filenames, filename prefixes…)
 * into template literals assigned to innerHTML. Unescaped, a value like
 * `<img src=x onerror=…>` executes as script inside the webview — and in a
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
   run in the shipped app — the console stays clean for end users — while
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

/** Switches the active nav item and content section — does NOT touch tool/landing state.
 *  When toolKey is given, only nav items whose data-tool matches are marked active —
 *  this lets two sidebar items point at the same section (e.g. Auto-Backup and Dummy
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

/** Called when a sidebar icon is clicked — always resets to landing or default tool.
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

navItems.forEach((item) => {
  item.addEventListener("click", () => {
    const section = item.dataset.section;
    const tool = item.dataset.tool;
    if (!section) return;
    if (tool) {
      activateTool(section, tool);
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
   Categories have been retired — Home and the sidebar both link straight to
   tools now. This still handles two patterns, kept generic on purpose so the
   archived category markup (commented out in index.html) would "just work"
   again if it's ever restored:
   1. Dashboard tool buttons  (data-section + data-tool) → go to section, open tool
      — also the pattern used by the new flat Home tool cards
   2. Category card headers   (data-section, no data-tool) → go to section landing
      — currently unreachable; only archived category markup used this
   3. Tool card clicks        (.tool-card with data-section + data-tool) → open tool
      — also the pattern used by the new flat Home tool cards
============================================================================= */

/** Shows a specific tool view within a section, hiding the category landing and section header.
 *  Persists state to disk and pushes an entry onto the nav history stack. */
function activateTool(section: string, tool: string): void {
  switchSection(section, tool);

  // Hide the section header (category title) — not needed when inside a tool
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
  if (section === "files" && tool === "auto-backup") onAutoBackupToolEntry();

  saveShellState(section, tool);
  pushNavHistory(section, tool);
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
      activateTool(section, tool);
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
      activateTool(card.dataset.section!, card.dataset.tool!);
    });
  });

// Back buttons inside tool views — categories have been retired, so these now
// always return to Home (previously: back to the category landing page).
document
  .querySelectorAll<HTMLElement>(".tool-back-btn[data-section]")
  .forEach((btn) => {
    btn.addEventListener("click", () => {
      activateSection("home");
    });
  });

// Back buttons on category landing pages — return to Home
document.querySelectorAll<HTMLElement>(".section-back-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    activateSection("home");
  });
});

/* =============================================================================
   SHELL STATE  (active section persistence)
============================================================================= */

/** Persists the current navigation position to disk.
 *  Uses in-memory _last* vars to avoid a disk read — they are seeded by
 *  loadShellState() on startup and kept current on every call. */
async function saveShellState(
  activeSection: string,
  activeTool?: string,
): Promise<void> {
  // Update in-memory tracking fields — no disk read needed.
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
/** Activates a tool, unless it's currently hidden (unpinned) — in which case
 *  Home is shown instead. Every startup-navigation path in loadShellState()
 *  routes through this rather than calling activateTool() directly, so a
 *  tool hidden via the Edit Sidebar modal is never landed on at launch, per
 *  spec. Relies on settings.sidebarItems already being loaded — init() awaits
 *  loadSettings() before loadShellState() runs. */
function activateToolIfPinned(section: string, tool: string): void {
  if (isToolPinned(`${section}/${tool}`)) {
    activateTool(section, tool);
  } else {
    activateSection("home");
  }
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
      // Restore exactly where the user left off — tool, landing, or home
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
      // Restore the last real category visited — never Home
      if (state.lastCategory) {
        activateSection(state.lastCategory);
      } else {
        activateSection("home");
      }
    } else if (target === "home") {
      activateSection("home");
    } else if (target.includes(":")) {
      // Specific tool — format is "section:tool-id"
      const [section, tool] = target.split(":");
      activateToolIfPinned(section, tool);
    } else {
      // Specific category — value matches a section key (e.g. "utility", "music")
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

// Mouse button 3 = back, button 4 = forward (the extra side buttons on most mice)
document.addEventListener("mousedown", (e: MouseEvent) => {
  if (e.button === 3) {
    e.preventDefault();
    navigateBack();
  }
  if (e.button === 4) {
    e.preventDefault();
    navigateForward();
  }
});

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
   SETTINGS — LOAD / SAVE / APPLY
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
  themeSelect.value = settings.theme;
  refreshThemeCurrentBadge();

  // The Random tab's settings panel (visibility + enabled/greyed state) is
  // managed by renderThemePickerTab(), not here — just keep the control
  // values themselves in sync so they're correct whenever that panel is
  // shown/enabled.
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
  cycleHolidayExclusiveToggle.checked = settings.cycleHolidayExclusive;
  cycleHolidayExclusiveLabel.textContent = settings.cycleHolidayExclusive ? "On" : "Off";
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
 *  ONLY shell-owned keys — its loadSettings whitelist guarantees that — so a
 *  whole-file JSON.stringify(settings) was erasing every tool key on disk
 *  each time any main setting changed. merge_settings patches exactly the
 *  keys present and preserves everything else. Non-critical — a failure
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
 *  at the end — so a fresh install and an upgrade both always cover every
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
      cycleHolidayExclusive:
        typeof merged.cycleHolidayExclusive === "boolean"
          ? merged.cycleHolidayExclusive
          : DEFAULT_SETTINGS.cycleHolidayExclusive,
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
      autoCheckUpdates:
        typeof merged.autoCheckUpdates === "boolean"
          ? merged.autoCheckUpdates
          : DEFAULT_SETTINGS.autoCheckUpdates,
      ignoredUpdateVersion:
        typeof merged.ignoredUpdateVersion === "string"
          ? merged.ignoredUpdateVersion
          : DEFAULT_SETTINGS.ignoredUpdateVersion,
      sidebarItems: normalizeSidebarItems(merged.sidebarItems),
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
   only ever moves/hides existing DOM nodes — it never touches a tool's own
   data or settings, so a re-shown tool picks up exactly where it left off.
============================================================================= */

const SIDEBAR_DRAG_HANDLE_SVG = `
  <svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
    <circle cx="8" cy="6" r="1.6" /><circle cx="16" cy="6" r="1.6" />
    <circle cx="8" cy="12" r="1.6" /><circle cx="16" cy="12" r="1.6" />
    <circle cx="8" cy="18" r="1.6" /><circle cx="16" cy="18" r="1.6" />
  </svg>`;

// Same open-eye / eye-with-slash pair used elsewhere in the app to mark a
// visible vs. hidden item — the slashed version here is Budget's exact
// "Excluded from Charts" icon (see budget.ts's summary-row builder), reused
// verbatim so "hidden" reads identically everywhere in the app.
const EYE_SVG_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
const EYE_SHOWN_SVG = `<svg ${EYE_SVG_ATTRS}><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_HIDDEN_SVG = `<svg ${EYE_SVG_ATTRS}><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

/** Whether the given "section/tool" key is currently shown. Defaults to true
 *  for a key with no recorded state — normalizeSidebarItems() should always
 *  have added one for every known tool, so this is just a safety net. */
function isToolPinned(key: string): boolean {
  return settings.sidebarItems.find((it) => it.key === key)?.pinned ?? true;
}

/** Re-syncs the "Specific Tool" options in the On Startup select with the
 *  current visibility state: hides/disables options for hidden tools so a
 *  user never sees (or can pick) a tool that isn't on the sidebar. If the
 *  currently-selected startup target IS one of those now-hidden options,
 *  falls back to "lastView" and persists the change — otherwise the select
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

/** Updates the "Sidebar:" row's status badge in General Settings — hidden
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
  const shownKeys = settings.sidebarItems.filter((it) => it.pinned).map((it) => it.key);
  const shownSet = new Set(shownKeys);

  // Move shown items into order (appendChild on an already-attached node
  // relocates it — repeated in desired order, this leaves everything in that
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
}

/** Shows or hides a tool, moving it to the end of its new group (shown
 *  entries stay a flat, freely-reorderable list; hidden entries have no
 *  meaningful order of their own). Persists immediately, re-renders both the
 *  live sidebar/Home and (if open) the Edit Sidebar modal, and — per spec —
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

  // dragend fires unconditionally — whether or not the drag ended over a
  // valid drop target — so the commit belongs here, not in "drop". Relying
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
  applySidebarOrder();
  saveSettings();
}

function buildSidebarEditRow(item: SidebarItemState, draggable: boolean): HTMLElement {
  const row = document.createElement("div");
  row.className = draggable ? "sidebar-edit-item" : "sidebar-edit-item sidebar-edit-item-hidden";
  row.dataset.key = item.key;

  const meta = ALL_TOOLS.find((t) => t.key === item.key);
  if (!meta) return row; // defensive — normalizeSidebarItems() guarantees a match

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

// Replaces (rather than stacks on) the General Settings modal — same pattern
// Time Tracker's Setup → Add/Edit Activity / CSV Import modals use: opening
// closes the parent first, and a back-arrow (not the X) is what reopens it.
const sidebarEditModal = new Modal(sidebarEditBackdrop, {
  closeOnEsc: true,
  onOpen: () => renderSidebarEditModal(),
});

sidebarEditBtn.addEventListener("click", () => {
  settingsModal.close();
  sidebarEditModal.open();
});

sidebarEditBack.addEventListener("click", () => {
  sidebarEditModal.close();
  settingsModal.open();
});

sidebarEditClose.addEventListener("click", () => sidebarEditModal.close());

sidebarEditResetBtn.addEventListener("click", () => {
  settings.sidebarItems = freshSidebarItems();
  applySidebarOrder();
  saveSettings();
  renderSidebarEditModal();
  flash("Sidebar reset to default", "success");
});

/* =============================================================================
   CHOOSE THEME MODAL
   -----------------------------------------------------------------------------
   Replaces the old <select id="themeSelect"> dropdown with a tabbed grid of
   preview tiles (Main/Holiday/Special/Custom, matching the old optgroups).
   themeSelect itself still exists in the DOM (hidden) — theme-editor.ts reads
   and writes its .value directly, so it stays the one place that mapping is
   defined, but it no longer drives anything by firing "change".

   Built-in themes are previewed by fetching their CSS file and pulling a
   handful of --color-* values out with a regex (cheap, cached per theme id —
   these are small static files). Custom themes use their already-in-memory
   `vars` directly, no fetch needed. Random has no fixed palette to preview,
   so it gets a die icon instead; the Custom tab's "add" tile gets a palette
   icon for the same reason.
============================================================================= */

export type ThemePickerTab = "main" | "holiday" | "special" | "cycle" | "random" | "custom";

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

/** Returns the display name for whatever theme is currently active — a
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
  // Budget's 8-color chart palette — deliberately vivid/distinct per theme
  // (see the "Blue / emerald / amber / red / violet / cyan / orange / mint"
  // comment in each theme's own CSS), so it doubles as a rich "fingerprint"
  // strip for the preview tile. Present in every built-in theme's CSS file
  // AND in RANDOM_VARS (so custom themes carry it too) — safe for both tile
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

// Keyed by theme id — these are small static files under /themes/, so a
// per-id fetch is cheap and only ever happens once per session.
const themePreviewCache = new Map<string, Record<string, string>>();

async function fetchThemePreviewVars(themeId: string): Promise<Record<string, string>> {
  const cached = themePreviewCache.get(themeId);
  if (cached) return cached;
  const vars: Record<string, string> = {};
  try {
    const res = await fetch(`/themes/${themeId}.css`);
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

// Tiles are plain divs, not <button> — the global `button { color:
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

let themePickerActiveTab: ThemePickerTab = "main";

/** Which tab houses the currently active theme — main/holiday/special for a
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

/** Shows/hides the Cycle pane's conditional rows — the interval row only
 *  matters for the "time" trigger, the holiday-exclusive row only matters
 *  once Holiday Overrides is on. Called from applySettings() (so it stays
 *  correct even while the pane isn't open) and whenever the picker renders
 *  the Cycle tab. */
function syncCycleSettingsVisibility(): void {
  cycleIntervalRow.style.display = settings.cycleTrigger === "time" ? "" : "none";
  const holidaySubRowDisplay = settings.cycleHolidayOverride ? "" : "none";
  cycleHolidayExclusiveRow.style.display = holidaySubRowDisplay;
  cycleHolidayFullSeasonRow.style.display = holidaySubRowDisplay;
}

function renderThemePickerTab(tab: ThemePickerTab): void {
  themePickerActiveTab = tab;
  document.querySelectorAll<HTMLElement>(".theme-picker-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.themeTab === tab);
  });

  themePickerGrid.style.display = "none";
  themePickerRandomPane.style.display = "none";
  themePickerCyclePane.style.display = "none";

  if (tab === "random") {
    themePickerRandomPane.style.display = "";
    themePickerRandomTileWrap.innerHTML = "";
    themePickerRandomTileWrap.appendChild(buildRandomTile());
    // Settings are visible either way, but only interactive once Random is
    // actually the active theme — not just being looked at.
    randomSubsettings.classList.toggle("inactive", settings.theme !== "random");
    return;
  }

  if (tab === "cycle") {
    themePickerCyclePane.style.display = "";
    themePickerCycleTileWrap.innerHTML = "";
    themePickerCycleTileWrap.appendChild(buildCycleTile());
    // Same "visible but inert until actually active" treatment as Random.
    cycleSubsettings.classList.toggle("inactive", settings.theme !== "cycle");
    syncCycleSettingsVisibility();
    return;
  }

  themePickerGrid.style.display = "";
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
 *  that, instead of the old fixed 58vh cap — which could either clip a
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

document.querySelectorAll<HTMLElement>(".theme-picker-tab").forEach((btn) => {
  btn.addEventListener("click", () => renderThemePickerTab(btn.dataset.themeTab as ThemePickerTab));
});

/** Selects a built-in theme or "random"/"custom" by id — same logic the old
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
  renderThemePickerTab(themePickerActiveTab);
}

/** Selects a specific saved custom theme by id, then applies it via
 *  selectTheme("custom"). */
function selectCustomTheme(customId: string): void {
  setActiveCustomId(customId);
  selectTheme("custom");
}

// Set just before calling themePickerModal.open() to force a specific tab on
// the next open, bypassing tabForCurrentTheme(). Consumed (and cleared) by
// onOpen below. Needed because tabForCurrentTheme() tracks settings.theme,
// which the Create/Edit/Delete Custom Theme flows don't necessarily change
// (e.g. editing or deleting a custom theme that isn't the active one) — so
// it alone can't be trusted to land back on the Custom tab for those flows.
let themePickerForceTab: ThemePickerTab | null = null;

// Replaces (rather than stacks on) the General Settings modal, same pattern
// as the Edit Sidebar modal above. Exported: theme-editor.ts's Create/Edit
// Custom Theme flow returns here (not to Settings) when done, since it's now
// only ever reached from this modal.
export const themePickerModal = new Modal(themePickerBackdrop, {
  closeOnEsc: true,
  // Lands on the tab that houses whatever theme is currently active by
  // default, unless a specific tab was requested (see themePickerForceTab).
  onOpen: () => {
    const tab = themePickerForceTab ?? tabForCurrentTheme();
    themePickerForceTab = null;
    renderThemePickerTab(tab);
  },
});

/** Reopens Choose Theme forced to the Custom tab. Exported for theme-editor.ts
 *  to call when returning from Create/Edit/Delete Custom Theme — see
 *  themePickerForceTab's doc comment for why tabForCurrentTheme() alone
 *  isn't reliable for those flows. */
export function reopenThemePickerOnCustomTab(): void {
  themePickerForceTab = "custom";
  themePickerModal.open();
}

themeEditBtn.addEventListener("click", () => {
  settingsModal.close();
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

export const settingsModal = new Modal(settingsBackdrop, {
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

// themeSelect no longer has a visible UI of its own to fire "change" — theme
// selection now happens via the Choose Theme modal's tiles, which call
// selectTheme()/selectCustomTheme() (see the CHOOSE THEME MODAL section
// below) instead of relying on this element's change event.

rerollBtn.addEventListener("click", () => {
  localStorage.removeItem(PERSISTENT_RANDOM_KEY);
  applyTheme("random");
});

/* -----------------------------------------------------------------------------
   Save-random-as-custom button — sits to the immediate LEFT of the reroll die
   in index.html (both shown only while the Random theme is active; see
   applySettings). Captures the palette CURRENTLY applied to :root — which works
   for both persistent and chaotic modes, since applyPalette writes every
   RANDOM_VAR as an inline property on :root — and stores it as a new custom
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
    flash("No random palette to save.", "error");
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
  // which tab is open — if that happens to be Custom, refresh it so the new
  // tile shows up immediately instead of only on the next tab switch.
  if (themePickerActiveTab === "custom") renderThemePickerTab("custom");
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

cycleHolidayExclusiveToggle.addEventListener("change", () => {
  settings.cycleHolidayExclusive = cycleHolidayExclusiveToggle.checked;
  cycleHolidayExclusiveLabel.textContent = settings.cycleHolidayExclusive ? "On" : "Off";
  applyTheme("cycle");
  saveSettings();
});

cycleHolidayFullSeasonToggle.addEventListener("change", () => {
  settings.cycleHolidayFullSeason = cycleHolidayFullSeasonToggle.checked;
  cycleHolidayFullSeasonLabel.textContent = settings.cycleHolidayFullSeason ? "On" : "Off";
  applyTheme("cycle");
  saveSettings();
});

cycleNowBtn.addEventListener("click", () => advanceCycleNow());

/* -----------------------------------------------------------------------------
   Cycle tab's holiday-subsettings (i) buttons — click-to-toggle popover,
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
   Theme's tiles, these don't preview a different palette — a sound pack has
   no visuals of its own, so the cards just render in the app's own current
   theme. Each card has two icon buttons that play that pack's success/error
   cue directly (independent of the currently *active* pack, and without
   selecting it) — selecting the pack itself happens by clicking the tile.
============================================================================= */

const SPEAKER_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>`;

function refreshSoundPackCurrentBadge(): void {
  const pack = SOUND_PACKS.find((p) => p.id === settings.soundPack);
  soundPackCurrentBadge.textContent = pack ? pack.name : settings.soundPack;
}

/** Tracks whatever preview cue is currently playing so a new preview click
 *  can stop it — without this, rapid clicks across tiles/buttons stack up
 *  and play over each other instead of replacing one another. */
let _soundPackPreviewAudio: HTMLAudioElement | null = null;

/** Plays one specific pack's cue directly — a standalone preview, not tied
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
  audio.play().catch(() => {});
}

/** Selects a sound pack — same effect the old dropdown's "change" handler
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
  settingsModal.close();
  soundPackPickerModal.open();
});

soundPackPickerBack.addEventListener("click", () => {
  soundPackPickerModal.close();
  settingsModal.open();
});

soundPackPickerClose.addEventListener("click", () => soundPackPickerModal.close());

/* =============================================================================
   BACKUP REMINDER MODAL  (universal — owned by shell; Aggressive mode)
   -----------------------------------------------------------------------------
   Gentle mode is just a flash() toast — no modal needed. Aggressive mode
   uses this modal, shown once per startup (see runStartupGates / the
   changelog onClosed hook above) when Auto-Backup's getDueBackupReminder()
   says a reminder is due.
============================================================================= */

const backupReminderModal = new Modal(backupReminderBackdrop);

export function maybeShowBackupReminder(): void {
  const status = getDueBackupReminder();
  if (!status) return;

  if (status.aggressive) {
    backupReminderDaysEl.textContent = String(status.elapsedDays);
    backupReminderModal.open();
  } else {
    flash("Time to backup your shit!", "success");
  }
}

backupReminderGoBtn.addEventListener("click", () => {
  backupReminderModal.close();
  activateTool("files", "auto-backup");
});

backupReminderCancelBtn.addEventListener("click", () => {
  backupReminderModal.close();
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
    // Quitting must never be blocked by a failed flush — the debounce window
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
// prompting — the user has no access to app content yet, so there's nothing
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
// from the previous page poisons the close flow — the new page's Alt+F4 stops
// reaching the exit modal and close() no longer quits. Tearing it down on unload
// guarantees the next page starts with a single, working listener.
window.addEventListener("beforeunload", () => {
  unlistenCloseRequest?.();
  unlistenCloseRequest = null;
});

/* =============================================================================
   TOAST NOTIFICATIONS
============================================================================= */

// Active pack's audio elements — swapped out by loadSoundPack() whenever the
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

/** Displays a toast notification with optional type and duration.
 *  Plays the corresponding audio cue, enforces a MAX_TOASTS cap by evicting the
 *  oldest toast, and supports hover-to-pause and click-to-dismiss. */
export function flash(
  message: string,
  type: "success" | "error" = "success",
  durationMs = 5000,
): void {
  if (type === "success" && successAudio) {
    successAudio.currentTime = 0;
    successAudio.play().catch(() => {});
  }
  if (type === "error" && errorAudio) {
    errorAudio.currentTime = 0;
    errorAudio.play().catch(() => {});
  }

  if (toastMetas.length >= MAX_TOASTS) {
    const oldest = toastMetas.shift()!;
    clearTimeout(oldest.timeout);
    const oldEl = document.getElementById(`toast-${oldest.id}`);
    if (oldEl) oldEl.remove();
  }

  const id = ++toastCounter;
  const toast = document.createElement("div");
  toast.id = `toast-${id}`;
  toast.className = `toast ${type}`;
  toast.textContent = message;
  toastContainer.appendChild(toast);

  const meta: ToastMeta = {
    id,
    timeout: 0 as unknown as ReturnType<typeof setTimeout>,
    remaining: durationMs,
    startedAt: Date.now(),
  };

  function dismiss(): void {
    clearTimeout(meta.timeout);
    toastMetas = toastMetas.filter((m) => m.id !== id);
    toast.classList.add("hide");
    toast.addEventListener("animationend", () => toast.remove(), {
      once: true,
    });
  }

  function startTimer(ms: number): void {
    meta.remaining = ms;
    meta.startedAt = Date.now();
    meta.timeout = setTimeout(dismiss, ms);
  }

  toast.addEventListener("mouseenter", () => {
    clearTimeout(meta.timeout);
    meta.remaining = Math.max(
      0,
      meta.remaining - (Date.now() - meta.startedAt),
    );
  });

  toast.addEventListener("mouseleave", () => {
    startTimer(meta.remaining);
  });

  toast.addEventListener("click", dismiss);

  toastMetas.push(meta);
  startTimer(durationMs);
}

/* =============================================================================
   WINDOW SIZE — SAVE / RESTORE
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
  // loadSettings() must finish before loadShellState() runs — the latter
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

  // Fetch the app version once and cache it — used for both the About modal
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

  // Opt-in update check — fire-and-forget so a slow or unreachable network can
  // never delay startup. Off by default; on failure it silently no-ops.
  if (settings.autoCheckUpdates) {
    void checkForUpdates();
  }

  // Run after window is visible — license gate then auto-changelog
  await runStartupGates(_appVersion !== "unknown" ? _appVersion : "accepted");
}

init();
