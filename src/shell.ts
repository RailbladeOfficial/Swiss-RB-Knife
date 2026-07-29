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
import {
  genThemeId,
  saveCustomThemes,
  loadCustomThemes,
  applyCustomThemeById,
  clearCustomTheme,
  refreshCustomThemeSelect,
  customThemes,
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
    id: "saxy-time",
    name: "Saxy Time",
    success: "/sounds/saxy-time/saxy-time-success.wav",
    error: "/sounds/saxy-time/saxy-time-error.wav",
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

const DEFAULT_SETTINGS: ShellSettings = {
  fontScale: 0,
  hour12: false,
  americanDates: false,
  solidModals: true,
  startupTarget: "lastView",
  theme: "default",
  randomPersistent: true,
  randomHarmonized: true,
  appLock: false,
  lockCredentialType: "pin",
  soundPack: "default",
  autoCheckUpdates: false,
  ignoredUpdateVersion: "",
};

/* =============================================================================
   STATE
============================================================================= */

export let settings: ShellSettings = { ...DEFAULT_SETTINGS };
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
const customSubsettings = document.getElementById("customSubsettings")!;
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
const soundPackSelect = document.getElementById(
  "soundPackSelect",
) as HTMLSelectElement;

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
        activateTool(state.activeSection, state.activeTool);
      } else if (state.activeSection) {
        activateSection(state.activeSection);
      } else {
        activateSection("home");
      }
    } else if (target === "lastTool") {
      // Restore the last tool opened, regardless of where the user closed from
      if (state.lastTool && state.lastToolSection) {
        activateTool(state.lastToolSection, state.lastTool);
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
      activateTool(section, tool);
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
  soundPackSelect.value = settings.soundPack;
  loadSoundPack(settings.soundPack);
  themeSelect.value = settings.theme;

  // Show/hide random subsettings and reroll button
  const isRandom = settings.theme === "random";
  const isCustom = settings.theme === "custom";
  randomSubsettings.style.maxHeight = isRandom ? "200px" : "0";
  rerollBtn.style.display = isRandom ? "inline-flex" : "none";
  saveRandomBtn.style.display = isRandom ? "inline-flex" : "none";
  randomModeToggle.checked = settings.randomPersistent;
  randomModeLabel.textContent = settings.randomPersistent
    ? "Persistent"
    : "Regenerative";
  randomPaletteToggle.checked = settings.randomHarmonized;
  randomPaletteLabel.textContent = settings.randomHarmonized
    ? "Harmonized"
    : "Chaotic";

  customSubsettings.style.maxHeight = isCustom ? "200px" : "0";
  if (isCustom) refreshCustomThemeSelect();

  applyLockSettings();
  applyUpdateSettings();
  applyTheme(settings.theme);
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
    };
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
  // Note: applySettings() is deferred to after loadCustomThemes() in init()
  // so that custom theme application has the themes array available.
  applySettings();
}

/* =============================================================================
   SETTINGS MODAL
============================================================================= */

export const settingsModal = new Modal(settingsBackdrop, {
  onOpen: () => applySettings(),
});

settingsBtn.addEventListener("click", () => settingsModal.open());
settingsClose.addEventListener("click", () => settingsModal.close());

settingsReset.addEventListener("click", () => {
  settings = { ...DEFAULT_SETTINGS };
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

themeSelect.addEventListener("change", () => {
  // Switching away from random clears stored palette so returning generates fresh
  if (settings.theme === "random" && themeSelect.value !== "random") {
    localStorage.removeItem(PERSISTENT_RANDOM_KEY);
  }
  // Switching away from custom clears inline overrides
  if (settings.theme === "custom" && themeSelect.value !== "custom") {
    clearCustomTheme();
  }
  settings.theme = themeSelect.value;
  applySettings();
  saveSettings();
});

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
  refreshCustomThemeSelect();
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

soundPackSelect.addEventListener("change", () => {
  settings.soundPack = soundPackSelect.value;
  loadSoundPack(settings.soundPack);
  saveSettings();
  // Preview the new pack immediately so the choice is audible without
  // needing to trigger a real toast elsewhere in the app.
  flash("Sound pack updated", "success");
});

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

/** Populates the Sound Pack dropdown from SOUND_PACKS. Called once at module
 *  init — the pack list is static, unlike the user-editable custom themes. */
function populateSoundPackSelect(): void {
  soundPackSelect.innerHTML = "";
  for (const pack of SOUND_PACKS) {
    const opt = document.createElement("option");
    opt.value = pack.id;
    opt.textContent = pack.name;
    soundPackSelect.appendChild(opt);
  }
}
populateSoundPackSelect();

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
  await Promise.all([
    loadSettings(),
    restoreWindowSize(),
    loadShellState(),
    loadCustomThemes(),
  ]);

  // If the saved theme is "custom", seed the active custom theme (theme-core.ts)
  // from the first stored theme and re-apply now that customThemes is loaded.
  if (settings.theme === "custom") {
    refreshCustomThemeSelect();
    const activeId = getActiveCustomId();
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
