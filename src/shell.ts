/* =============================================================================
   SHELL  — Swiss RB Knife application shell
   -----------------------------------------------------------------------------
   Top-level orchestrator for the app. Owns:

     • Sidebar navigation (section switching, tool activation, landing pages)
     • Mouse back/forward history stack
     • Shell state persistence (active section/tool across restarts)
     • Settings modal + all setting controls
     • Theme system (named themes + Random with Persistent/Regenerative,
       Harmonized/Chaotic sub-modes)
     • Toast notification system with centralized audio
     • Window size save/restore (DPI-aware, logical pixels)
     • Modal instances for: Settings, About, Changelog, Licensing, Full License,
       README, License Agreement (first-launch gate), Exit confirm
     • Startup gate sequencing: license agreement → auto-changelog on new version
     • Custom renderMarkdown() for in-app doc display

   Per-tool logic lives in src/tools/<tool>.ts and is initialized via init*()
   calls at the bottom of init(). The Modal primitive (modal.ts) owns all shared
   chrome behaviour (Escape, drag, open-stack, scroll reset).
============================================================================= */

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Modal, setGlobalModalOpenHook } from "./modal";
import { initTimeTracker } from "./tools/time-tracker";
import { initImageCCR } from "./tools/image-ccr";
import { initFileGen } from "./tools/file-gen";
import { initAutoBackup, onAutoBackupToolEntry } from "./tools/auto-backup";
import {
  initBudget,
  setBudgetAmericanDates,
  onBudgetToolEntry,
  onBudgetToolExit,
} from "./tools/budget";

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
type AdvancedOptions = {
  headerGradient?: { colorA: string; colorB: string; angle: number };
  headerGlow?: { color: string; intensity: "low" | "medium" | "high" };
  bodyGradient?: { colorA: string; colorB: string; angle: number };
  modalGlow?: { color: string; intensity: "low" | "medium" | "high" };
  panelGlow?: { color: string; intensity: "low" | "medium" | "high" };
  buttonGlow?: { color: string; intensity: "low" | "medium" | "high" };
};

/** A persisted custom theme. vars holds all --color-* values; advanced holds
 *  the optional gradient / glow overrides. */
type CustomTheme = {
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
interface UpdateInfo {
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
const LICENSE_VERSION = "1";

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

let settings: ShellSettings = { ...DEFAULT_SETTINGS };
let toastMetas: ToastMeta[] = [];
let toastCounter = 0;

// Guard + handle for the Alt+F4 / close-request interception (see Exit modal section).
let allowAppClose = false;
let unlistenCloseRequest: (() => void) | null = null;

// Mouse back/forward navigation history
let navHistory: NavEntry[] = [];
let navIndex = -1;
let isNavigatingHistory = false;
let changelogLoaded = false;
let readmeLoaded = false;
let securityLoaded = false;
let contributingLoaded = false;
let fullLicenseLoaded = false;
// The README <img> that opened the lightbox, so the back-arrow can scroll
// README back to the same spot. Stays valid across closes/reopens since
// readmeBody's innerHTML is only ever set once (see loadReadme/readmeLoaded).
let lightboxSourceImg: HTMLImageElement | null = null;
let activeTab = "license";

// In-memory shell state — kept in sync with disk so saveShellState never
// needs to read back from Rust just to preserve fields it isn't changing.
// Populated by loadShellState() on startup; updated incrementally thereafter.
let _lastTool: string | null = null;
let _lastToolSection: string | null = null;
let _lastCategory: string | null = null;

// App version string — fetched once during init and reused by both
// loadAppVersion() (display) and runStartupGates() (changelog gate).
let _appVersion = "";

// Latest successful update-check result. null until a check completes (and
// reset to null on any failure). Read by refreshUpdateUI() — see UPDATE CHECK.
let _updateInfo: UpdateInfo | null = null;

// Where the full-license modal should return to when its back arrow is used.
// Set by whatever opens it (README or the licensing modal); the back arrow
// reopens that origin, the close X just dismisses.
let fullLicenseReturn: (() => void) | null = null;

// Per-tab HTML cache for the licensing modal — prevents tabs overwriting each other
const licensingTabCache: Record<string, string> = {};

// ── Custom themes ──────────────────────────────────────────────────────────
// All persisted custom themes, loaded at startup from Rust.
let customThemes: CustomTheme[] = [];

// Which custom theme is currently selected/active (its id string).
// Stored inside settings.theme as "custom:<id>" when a custom theme is active.
// If settings.theme === "custom" but no id part, the first theme is used.
let _activeCustomId: string | null = null;

// Theme editor session state — tracks what was active before the editor opened
// so we can revert on cancel.
let _teMode: "create" | "edit" = "create";
let _teEditId: string | null = null; // id of the theme being edited (edit mode)
let _tePrevTheme: string = "default"; // settings.theme value before editor opened
let _teWorkingVars: Record<string, string> = {}; // live working copy of vars in editor
let _teWorkingAdv: AdvancedOptions = {}; // live working copy of advanced options

/* =============================================================================
   ELEMENT REFS
============================================================================= */

const clockEl = document.getElementById("clock")!;
const toastContainer = document.getElementById("toastContainer")!;
const themeLink = document.getElementById("themeLink") as HTMLLinkElement;

const settingsBtn = document.getElementById("settingsBtn")!;
const aboutBtn = document.getElementById("aboutBtn")!;
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
const themeSelect = document.getElementById("themeSelect") as HTMLSelectElement;
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

const aboutBackdrop = document.getElementById("aboutBackdrop")!;
const aboutClose = document.getElementById("aboutClose")!;
const appVersionEl = document.getElementById("appVersion");

const exitBackdrop = document.getElementById("exitBackdrop")!;
const exitConfirmBtn = document.getElementById("exitConfirmBtn")!;
const exitCancelBtn = document.getElementById("exitCancelBtn")!;

const changelogBackdrop = document.getElementById("changelogBackdrop")!;
const changelogClose = document.getElementById("changelogClose")!;
const changelogBack = document.getElementById("changelogBack")!;

const licensingBackdrop = document.getElementById("licensingBackdrop")!;
const licensingClose = document.getElementById("licensingClose")!;
const licensingBack = document.getElementById("licensingBack")!;

const fullLicenseBackdrop = document.getElementById("fullLicenseBackdrop")!;
const fullLicenseClose = document.getElementById("fullLicenseClose")!;
const fullLicenseBack = document.getElementById("fullLicenseBack")!;

const readmeBackdrop = document.getElementById("readmeBackdrop")!;
const readmeClose = document.getElementById("readmeClose")!;
const readmeBack = document.getElementById("readmeBack")!;

const securityBackdrop = document.getElementById("securityBackdrop")!;
const securityClose = document.getElementById("securityClose")!;
const securityBack = document.getElementById("securityBack")!;

const contributingBackdrop = document.getElementById("contributingBackdrop")!;
const contributingClose = document.getElementById("contributingClose")!;
const contributingBack = document.getElementById("contributingBack")!;

const imageLightboxBackdrop = document.getElementById("imageLightboxBackdrop")!;
const imageLightboxClose = document.getElementById("imageLightboxClose")!;
const imageLightboxBack = document.getElementById("imageLightboxBack")!;
const imageLightboxTitle = document.getElementById("imageLightboxTitle")!;
const imageLightboxImg = document.getElementById(
  "imageLightboxImg",
) as HTMLImageElement;

const licenseAgreementBackdrop = document.getElementById(
  "licenseAgreementBackdrop",
)!;
const licenseAcceptBtn = document.getElementById("licenseAcceptBtn")!;
const licenseDeclineBtn = document.getElementById("licenseDeclineBtn")!;

// ── Custom theme subsettings refs ──────────────────────────────────────────
const customSubsettings = document.getElementById("customSubsettings")!;
const customThemeSelect = document.getElementById(
  "customThemeSelect",
) as HTMLSelectElement;
const customThemeCreateBtn = document.getElementById("customThemeCreateBtn")!;
const customThemeEditBtn = document.getElementById("customThemeEditBtn")!;
const customThemeDeleteBtn = document.getElementById("customThemeDeleteBtn")!;
const customThemeEmpty = document.getElementById("customThemeEmpty")!;

// ── Theme editor modal refs ────────────────────────────────────────────────
const themeEditorBackdrop = document.getElementById("themeEditorBackdrop")!;
const themeEditorTitle = document.getElementById("themeEditorTitle")!;
const themeEditorBack = document.getElementById("themeEditorBack")!;
const themeEditorClose = document.getElementById("themeEditorClose")!;
const teNameInput = document.getElementById("teNameInput") as HTMLInputElement;
const teBaseSelect = document.getElementById(
  "teBaseSelect",
) as HTMLSelectElement;
const teBaseCustomGroup = document.getElementById("teBaseCustomGroup")!;
const teCancel = document.getElementById("teCancel")!;
const teSave = document.getElementById("teSave")!;

// Advanced controls
const teHeaderGradientToggle = document.getElementById(
  "teHeaderGradientToggle",
) as HTMLInputElement;
const teHeaderGradientControls = document.getElementById(
  "teHeaderGradientControls",
)!;
const teHeaderColorA = document.getElementById(
  "teHeaderColorA",
) as HTMLInputElement;
const teHeaderColorAHex = document.getElementById(
  "teHeaderColorAHex",
) as HTMLInputElement;
const teHeaderColorB = document.getElementById(
  "teHeaderColorB",
) as HTMLInputElement;
const teHeaderColorBHex = document.getElementById(
  "teHeaderColorBHex",
) as HTMLInputElement;
const teHeaderAngle = document.getElementById(
  "teHeaderAngle",
) as HTMLInputElement;
const teHeaderGlowToggle = document.getElementById(
  "teHeaderGlowToggle",
) as HTMLInputElement;
const teHeaderGlowControls = document.getElementById("teHeaderGlowControls")!;
const teHeaderGlowColor = document.getElementById(
  "teHeaderGlowColor",
) as HTMLInputElement;
const teHeaderGlowColorHex = document.getElementById(
  "teHeaderGlowColorHex",
) as HTMLInputElement;
const teHeaderGlowIntensity = document.getElementById(
  "teHeaderGlowIntensity",
) as HTMLInputElement;
const teBodyGradientToggle = document.getElementById(
  "teBodyGradientToggle",
) as HTMLInputElement;
const teBodyGradientControls = document.getElementById(
  "teBodyGradientControls",
)!;
const teBodyColorA = document.getElementById(
  "teBodyColorA",
) as HTMLInputElement;
const teBodyColorAHex = document.getElementById(
  "teBodyColorAHex",
) as HTMLInputElement;
const teBodyColorB = document.getElementById(
  "teBodyColorB",
) as HTMLInputElement;
const teBodyColorBHex = document.getElementById(
  "teBodyColorBHex",
) as HTMLInputElement;
const teBodyAngle = document.getElementById("teBodyAngle") as HTMLInputElement;
const teModalGlowToggle = document.getElementById(
  "teModalGlowToggle",
) as HTMLInputElement;
const teModalGlowControls = document.getElementById("teModalGlowControls")!;
const teModalGlowColor = document.getElementById(
  "teModalGlowColor",
) as HTMLInputElement;
const teModalGlowColorHex = document.getElementById(
  "teModalGlowColorHex",
) as HTMLInputElement;
const teModalGlowIntensity = document.getElementById(
  "teModalGlowIntensity",
) as HTMLInputElement;
const tePanelGlowToggle = document.getElementById(
  "tePanelGlowToggle",
) as HTMLInputElement;
const tePanelGlowControls = document.getElementById("tePanelGlowControls")!;
const tePanelGlowColor = document.getElementById(
  "tePanelGlowColor",
) as HTMLInputElement;
const tePanelGlowColorHex = document.getElementById(
  "tePanelGlowColorHex",
) as HTMLInputElement;
const tePanelGlowIntensity = document.getElementById(
  "tePanelGlowIntensity",
) as HTMLInputElement;
const teButtonGlowToggle = document.getElementById(
  "teButtonGlowToggle",
) as HTMLInputElement;
const teButtonGlowControls = document.getElementById("teButtonGlowControls")!;
const teButtonGlowColor = document.getElementById(
  "teButtonGlowColor",
) as HTMLInputElement;
const teButtonGlowColorHex = document.getElementById(
  "teButtonGlowColorHex",
) as HTMLInputElement;
const teButtonGlowIntensity = document.getElementById(
  "teButtonGlowIntensity",
) as HTMLInputElement;

// ── Custom theme delete confirm modal refs ─────────────────────────────────
const customThemeDeleteBackdrop = document.getElementById(
  "customThemeDeleteBackdrop",
)!;
const customThemeDeleteMsg = document.getElementById("customThemeDeleteMsg")!;
const customThemeDeleteBack = document.getElementById("customThemeDeleteBack")!;
const customThemeDeleteConfirmBtn = document.getElementById(
  "customThemeDeleteConfirmBtn",
)!;
const customThemeDeleteCancelBtn = document.getElementById(
  "customThemeDeleteCancelBtn",
)!;

// ── Security settings refs ─────────────────────────────────────────────────
const appLockToggle = document.getElementById(
  "appLockToggle",
) as HTMLInputElement;
const appLockLabel = document.getElementById("appLockLabel")!;
const lockSubsettings = document.getElementById("lockSubsettings")!;
const lockChangeBtn = document.getElementById("lockChangeBtn")!;
const lockRemoveBtn = document.getElementById("lockRemoveBtn")!;

// ── Set-credential modal refs ──────────────────────────────────────────────
const setLockBackdrop = document.getElementById("setLockBackdrop")!;
const setLockBack = document.getElementById("setLockBack")!;
const setLockClose = document.getElementById("setLockClose")!;
const setLockTitle = document.getElementById("setLockTitle")!;
const setLockHint = document.getElementById("setLockHint")!;
const setLockPickPin = document.getElementById("setLockPickPin")!;
const setLockPickPassword = document.getElementById("setLockPickPassword")!;
const setLockInput = document.getElementById(
  "setLockInput",
) as HTMLInputElement;
const setLockShowInput = document.getElementById("setLockShowInput")!;
const setLockConfirm = document.getElementById(
  "setLockConfirm",
) as HTMLInputElement;
const setLockShowConfirm = document.getElementById("setLockShowConfirm")!;
const setLockConfirmWrap = document.getElementById("setLockConfirmWrap")!;
const setLockError = document.getElementById("setLockError")!;
const setLockCancelBtn = document.getElementById("setLockCancelBtn")!;
const setLockSaveBtn = document.getElementById("setLockSaveBtn")!;

// ── Lock screen refs ───────────────────────────────────────────────────────
const lockScreen = document.getElementById("lockScreen")!;
const lockPinView = document.getElementById("lockPinView")!;
const lockPasswordView = document.getElementById("lockPasswordView")!;
const lockDots = document.getElementById("lockDots")!;
const lockNumpad = document.getElementById("lockNumpad")!;
const lockBackspace = document.getElementById("lockBackspace")!;
const lockPinError = document.getElementById("lockPinError")!;
const lockPasswordInput = document.getElementById(
  "lockPasswordInput",
) as HTMLInputElement;
const lockShowPassword = document.getElementById("lockShowPassword")!;
const lockSubmitBtn = document.getElementById("lockSubmitBtn")!;
const lockPasswordError = document.getElementById("lockPasswordError")!;
const lockExitBtn = document.getElementById("lockExitBtn")!;
const lockExitBtnPw = document.getElementById("lockExitBtnPw")!;

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
   RANDOM THEME HELPERS
============================================================================= */

const RANDOM_VARS = [
  "--color-bg",
  "--color-panel",
  "--color-input-bg",
  "--color-border",
  "--color-border-dashed",
  "--color-text",
  "--color-text-muted",
  "--color-hover",
  "--color-btn",
  "--color-btn-hover",
  "--color-btn-text",
  "--color-danger",
  "--color-danger-subtle",
  "--color-accent-input",
  "--color-accent-view",
  "--color-accent-totals",
  "--color-accent-entries",
  "--color-toggle-off",
  "--color-toggle-on",
  "--color-changelog-features",
  "--color-changelog-improvements",
  "--color-changelog-bugfixes",
  "--color-changelog-tool",
  "--color-toast-success-bg",
  "--color-toast-success-border",
  "--color-toast-success-text",
  "--color-toast-error-bg",
  "--color-toast-error-border",
  "--color-toast-error-text",
  // Budget chart palette — 8 distinct colors for pie/bar segments
  "--color-chart-1",
  "--color-chart-2",
  "--color-chart-3",
  "--color-chart-4",
  "--color-chart-5",
  "--color-chart-6",
  "--color-chart-7",
  "--color-chart-8",
] as const;

const PERSISTENT_RANDOM_KEY = "shell-persistent-random-palette";
const LICENSE_ACCEPTED_KEY = "shell-license-accepted-version";
const CHANGELOG_SEEN_KEY = "shell-changelog-seen-version";

function rInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function hslToHex(h: number, s: number, l: number): string {
  const sn = s / 100,
    ln = l / 100;
  const a = sn * Math.min(ln, 1 - ln);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = ln - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function generateRandomPalette(): Record<string, string> {
  const baseHue = rInt(0, 359);
  const accentHue = (baseHue + rInt(120, 200)) % 360;
  const dangerHue = (baseHue + rInt(30, 60)) % 360;
  const isDark = Math.random() > 0.4;

  const bg = isDark
    ? hslToHex(baseHue, rInt(15, 35), rInt(8, 18))
    : hslToHex(baseHue, rInt(10, 30), rInt(88, 97));
  const panel = isDark
    ? hslToHex(baseHue, rInt(15, 35), rInt(13, 22))
    : hslToHex(baseHue, rInt(8, 25), rInt(93, 99));
  const inputBg = isDark
    ? hslToHex(baseHue, rInt(15, 30), rInt(17, 26))
    : hslToHex(baseHue, rInt(8, 20), rInt(88, 95));
  const border = hslToHex(baseHue, rInt(20, 45), rInt(35, 55));
  const borderD = hslToHex(accentHue, rInt(70, 100), rInt(45, 65));
  const text = isDark
    ? hslToHex(baseHue, rInt(10, 25), rInt(82, 96))
    : hslToHex(baseHue, rInt(10, 25), rInt(8, 18));
  const textMuted = isDark
    ? hslToHex(baseHue, rInt(10, 20), rInt(55, 70))
    : hslToHex(baseHue, rInt(10, 20), rInt(40, 55));
  const hover = isDark
    ? hslToHex(baseHue, rInt(15, 30), rInt(20, 30))
    : hslToHex(baseHue, rInt(10, 25), rInt(82, 90));
  const btn = hslToHex(accentHue, rInt(65, 100), rInt(40, 60));
  const btnHover = hslToHex(accentHue, rInt(65, 100), rInt(30, 48));
  const btnText = isDark ? "#ffffff" : "#111111";
  const danger = hslToHex(dangerHue, rInt(70, 100), rInt(45, 60));
  const dangerSub = hslToHex(dangerHue, rInt(70, 100), rInt(45, 60)) + "26";
  const acIn = hslToHex(accentHue, rInt(65, 100), rInt(45, 65));
  const acView = hslToHex((accentHue + 60) % 360, rInt(50, 85), rInt(40, 60));
  const acTot = hslToHex(accentHue, rInt(65, 100), rInt(50, 68));
  const acEnt = hslToHex((baseHue + 60) % 360, rInt(50, 80), rInt(40, 58));
  const togOff = isDark
    ? hslToHex(baseHue, rInt(15, 30), rInt(22, 32))
    : hslToHex(baseHue, rInt(10, 20), rInt(75, 85));
  const togOn = hslToHex(accentHue, rInt(60, 90), rInt(45, 62));
  const tSBg = isDark
    ? hslToHex(120, rInt(20, 40), rInt(10, 20))
    : hslToHex(120, rInt(30, 50), rInt(88, 96));
  const tSBord = hslToHex(120, rInt(50, 80), rInt(35, 55));
  const tSText = isDark
    ? hslToHex(120, rInt(30, 50), rInt(70, 88))
    : hslToHex(120, rInt(30, 50), rInt(12, 28));
  const tEBg = isDark
    ? hslToHex(0, rInt(30, 50), rInt(10, 20))
    : hslToHex(0, rInt(30, 50), rInt(90, 97));
  const tEBord = hslToHex(0, rInt(60, 90), rInt(40, 58));
  const tEText = isDark
    ? hslToHex(0, rInt(30, 50), rInt(70, 88))
    : hslToHex(0, rInt(30, 50), rInt(12, 28));

  // Chart palette: 8 hues spread 45° apart from a random starting hue,
  // with alternating lightness increments so adjacent slices never match.
  // Saturation is moderate-to-high so colors pop on both dark and light themes.
  const chartBaseHue = rInt(0, 44); // 0-44 ensures we get a full even spread
  const chartColors: Record<string, string> = {};
  for (let i = 1; i <= 8; i++) {
    const hue = (chartBaseHue + (i - 1) * 45) % 360;
    // Alternate lightness: odd slots slightly lighter, even slightly darker
    // so even if two hues happen to be close, their lightness differs.
    const sat = isDark ? rInt(60, 85) : rInt(55, 80);
    const lit = isDark
      ? i % 2 === 1
        ? rInt(52, 65)
        : rInt(38, 50)
      : i % 2 === 1
        ? rInt(40, 52)
        : rInt(55, 67);
    chartColors[`--color-chart-${i}`] = hslToHex(hue, sat, lit);
  }

  // Changelog accents: 4 hues spread 90° apart from their own random start
  // (independent of baseHue/accentHue/chartBaseHue) so they're guaranteed
  // distinct from each other and from the rest of the palette, with lightness
  // matched to bg darkness the same way the button/accent colors are above.
  const clBaseHue = rInt(0, 89); // 0-89 ensures a full even spread across 4×90°
  const clLit = isDark ? rInt(55, 68) : rInt(38, 50);
  const clFeatures = hslToHex(clBaseHue, rInt(65, 90), clLit);
  const clImprovements = hslToHex((clBaseHue + 90) % 360, rInt(65, 90), clLit);
  const clBugfixes = hslToHex((clBaseHue + 180) % 360, rInt(65, 90), clLit);
  const clTool = hslToHex((clBaseHue + 270) % 360, rInt(65, 90), clLit);

  return {
    "--color-bg": bg,
    "--color-panel": panel,
    "--color-input-bg": inputBg,
    "--color-border": border,
    "--color-border-dashed": borderD,
    "--color-text": text,
    "--color-text-muted": textMuted,
    "--color-hover": hover,
    "--color-btn": btn,
    "--color-btn-hover": btnHover,
    "--color-btn-text": btnText,
    "--color-danger": danger,
    "--color-danger-subtle": dangerSub,
    "--color-accent-input": acIn,
    "--color-accent-view": acView,
    "--color-accent-totals": acTot,
    "--color-accent-entries": acEnt,
    "--color-toggle-off": togOff,
    "--color-toggle-on": togOn,
    "--color-changelog-features": clFeatures,
    "--color-changelog-improvements": clImprovements,
    "--color-changelog-bugfixes": clBugfixes,
    "--color-changelog-tool": clTool,
    "--color-toast-success-bg": tSBg,
    "--color-toast-success-border": tSBord,
    "--color-toast-success-text": tSText,
    "--color-toast-error-bg": tEBg,
    "--color-toast-error-border": tEBord,
    "--color-toast-error-text": tEText,
    ...chartColors,
  };
}

function generateChaoticPalette(): Record<string, string> {
  const rHex = () => hslToHex(rInt(0, 359), rInt(0, 100), rInt(10, 90));
  return {
    "--color-bg": rHex(),
    "--color-panel": rHex(),
    "--color-input-bg": rHex(),
    "--color-border": rHex(),
    "--color-border-dashed": rHex(),
    "--color-text": rHex(),
    "--color-text-muted": rHex(),
    "--color-hover": rHex(),
    "--color-btn": rHex(),
    "--color-btn-hover": rHex(),
    "--color-btn-text": rHex(),
    "--color-danger": rHex(),
    "--color-danger-subtle": rHex(),
    "--color-accent-input": rHex(),
    "--color-accent-view": rHex(),
    "--color-accent-totals": rHex(),
    "--color-accent-entries": rHex(),
    "--color-toggle-off": rHex(),
    "--color-toggle-on": rHex(),
    "--color-changelog-features": rHex(),
    "--color-changelog-improvements": rHex(),
    "--color-changelog-bugfixes": rHex(),
    "--color-changelog-tool": rHex(),
    "--color-toast-success-bg": rHex(),
    "--color-toast-success-border": rHex(),
    "--color-toast-success-text": rHex(),
    "--color-toast-error-bg": rHex(),
    "--color-toast-error-border": rHex(),
    "--color-toast-error-text": rHex(),
    "--color-chart-1": rHex(),
    "--color-chart-2": rHex(),
    "--color-chart-3": rHex(),
    "--color-chart-4": rHex(),
    "--color-chart-5": rHex(),
    "--color-chart-6": rHex(),
    "--color-chart-7": rHex(),
    "--color-chart-8": rHex(),
  };
}

/** Writes a full palette object onto :root as inline CSS custom properties,
 *  then injects the random modal override style tag. */
function applyPalette(palette: Record<string, string>): void {
  const root = document.documentElement;
  for (const [key, value] of Object.entries(palette)) {
    root.style.setProperty(key, value);
  }
  applyRandomModalStyles(palette);
  // Notify tools that theme colors have changed so they can redraw anything
  // that reads CSS vars at draw time (e.g. budget chart canvases).
  window.dispatchEvent(new CustomEvent("themechange"));
}

/** Injects a <style> tag that overrides styles hardcoded in default.css with
 *  !important, making them respond to the random palette. Covers: modals,
 *  tool/section headers and titles, tab buttons, dir/prv buttons, slider vals. */
function applyRandomModalStyles(palette: Record<string, string>): void {
  const panel = palette["--color-panel"] ?? "#0f172a";
  const border = palette["--color-border"] ?? "#1f2937";
  const btn = palette["--color-btn"] ?? "#2563eb";
  const textMuted = palette["--color-text-muted"] ?? "#9ca3af";
  const inputBg = palette["--color-input-bg"] ?? "#111827";
  const text = palette["--color-text"] ?? "#e5e7eb";

  // Panel → rgba components for translucent modal
  const r = parseInt(panel.slice(1, 3), 16);
  const g = parseInt(panel.slice(3, 5), 16);
  const b = parseInt(panel.slice(5, 7), 16);
  // Border → rgba components for translucent modal border
  const br = parseInt(border.slice(1, 3), 16);
  const bg2 = parseInt(border.slice(3, 5), 16);
  const bb = parseInt(border.slice(5, 7), 16);
  // Btn → rgba components for header gradient and tab tints
  const btnR = parseInt(btn.slice(1, 3), 16);
  const btnG = parseInt(btn.slice(3, 5), 16);
  const btnB = parseInt(btn.slice(5, 7), 16);
  const btnText = palette["--color-btn-text"] ?? "#ffffff";

  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  const isDark = luminance < 0.5;

  const translucentBg = `rgba(${r}, ${g}, ${b}, ${isDark ? "0.25" : "0.45"})`;
  const translucentBorder = `rgba(${br}, ${bg2}, ${bb}, 0.6)`;
  const headerGradient = `linear-gradient(90deg, rgba(${btnR}, ${btnG}, ${btnB}, 0.12), rgba(${btnR}, ${btnG}, ${btnB}, 0.04))`;
  const headerBorderColor = `rgba(${btnR}, ${btnG}, ${btnB}, 0.3)`;
  const tabActiveBg = `rgba(${btnR}, ${btnG}, ${btnB}, 0.12)`;
  const tabActiveHoverBg = `rgba(${btnR}, ${btnG}, ${btnB}, 0.08)`;
  const tabActiveHoverBorder = `rgba(${btnR}, ${btnG}, ${btnB}, 0.4)`;
  const tabActiveBorder = `rgba(${btnR}, ${btnG}, ${btnB}, 0.5)`;

  const solidRule = `
    body.solid-modals .modal {
      background: ${panel} !important;
      border-color: ${border} !important;
      backdrop-filter: none !important;
      -webkit-backdrop-filter: none !important;
    }`;
  const translucentRule = `
    body:not(.solid-modals) .modal {
      background: ${translucentBg} !important;
      border-color: ${translucentBorder} !important;
      backdrop-filter: blur(24px) !important;
      -webkit-backdrop-filter: blur(24px) !important;
    }`;
  // Overrides the hardcoded blue gradient + #60a5fa title color in default.css
  const headerRule = `
    .tool-view-header, .section-header {
      background: ${headerGradient} !important;
      border-bottom-color: ${headerBorderColor} !important;
      box-shadow: none !important;
    }
    .tool-view-title, .section-title {
      color: ${btn} !important;
      text-shadow: none !important;
      opacity: 1 !important;
    }`;
  // Overrides hardcoded #60a5fa on tab/dir buttons and slider labels in default.css
  const controlsRule = `
    .tab-btn {
      color: ${textMuted} !important;
      border-color: transparent !important;
      background: transparent !important;
    }
    .tab-btn:hover {
      color: ${btn} !important;
      border-color: ${tabActiveHoverBorder} !important;
      background: ${tabActiveHoverBg} !important;
      box-shadow: none !important;
    }
    .tab-btn.active {
      color: ${btn} !important;
      border-color: ${tabActiveBorder} !important;
      background: ${tabActiveBg} !important;
      box-shadow: none !important;
    }
    .dir-btn, .prv-btn {
      background: ${inputBg} !important;
      color: ${textMuted} !important;
      border-color: ${border} !important;
      box-shadow: none !important;
    }
    .dir-btn:hover, .prv-btn:hover {
      color: ${text} !important;
      border-color: ${btn} !important;
      background: ${inputBg} !important;
      box-shadow: none !important;
    }
    .dir-btn.active, .prv-btn.active {
      color: ${btn} !important;
      border-color: ${btn} !important;
      background: ${tabActiveBg} !important;
      box-shadow: none !important;
    }
    .slider-val, .estimate-val {
      color: ${btn} !important;
    }
    .preview-card.anchor-card { border-color: ${btn} !important; }
    .preview-card.drag-target  { border-color: ${btn} !important; }`;

  // Newer budget accents (summary-tab active, view-mode toggle, annual-stats
  // title) are hardcoded to default.css's blue and aren't touched by the rules
  // above — so under random/custom they'd stay blue no matter the palette.
  // Re-point them at the palette's button colour. Semantic status colours
  // (good/late/overdue count badges) are intentionally left alone.
  const budgetRule = `
    .budget-summary-tab.active {
      color: ${btn} !important;
      background: ${tabActiveBg} !important;
      border-bottom-color: ${btn} !important;
      text-shadow: none !important;
    }
    .budget-view-mode-btn.active {
      background: ${btn} !important;
      color: ${btnText} !important;
      border-color: ${btn} !important;
      box-shadow: none !important;
    }
    .budget-annual-stats-title { color: ${btn} !important; }
    .budget-annual-stats-title-panel { border-left-color: ${btn} !important; }
    .budget-chart-cycle-btn:hover,
    .budget-chart-expand-btn:hover,
    .budget-chart-modal-cycle-btn:hover {
      border-color: ${btn} !important;
      color: ${btn} !important;
    }`;

  let tag = document.getElementById(
    "random-modal-styles",
  ) as HTMLStyleElement | null;
  if (!tag) {
    tag = document.createElement("style");
    tag.id = "random-modal-styles";
    document.head.appendChild(tag);
  }
  tag.textContent =
    solidRule + translucentRule + headerRule + controlsRule + budgetRule;
}

/** Removes all inline random palette properties from :root and removes the
 *  injected modal style override tag. Call when switching away from random theme. */
function clearRandomPalette(): void {
  const root = document.documentElement;
  (RANDOM_VARS as readonly string[]).forEach((v) =>
    root.style.removeProperty(v),
  );
  // Remove the injected random modal style override
  document.getElementById("random-modal-styles")?.remove();
}

// Coalesces compound triggers so one user action re-rolls at most once: a click
// that also opens a modal fires both the global click listener and modal.ts's
// open hook microseconds apart, and a button that also changes view stacks a
// third. Anything inside this window collapses to a single roll; genuinely
// separate interactions are always further apart than this.
let _lastRegen = 0;

/** Regenerates the palette when — and only when — Regenerative random is active.
 *  The single choke point for every re-roll trigger (modal opens, view changes,
 *  button presses, input commits), so it stays a no-op in every other mode. */
function maybeRegenerateRandom(): void {
  if (settings.theme !== "random" || settings.randomPersistent) return;
  const now = Date.now();
  if (now - _lastRegen < 80) return;
  _lastRegen = now;
  applyPalette(
    settings.randomHarmonized
      ? generateRandomPalette()
      : generateChaoticPalette(),
  );
}

/* -----------------------------------------------------------------------------
   Regenerative-random reactivity
   -----------------------------------------------------------------------------
   In Regenerative mode the palette should feel alive — re-rolling not just on
   modal opens and view changes (wired elsewhere) but on the interactions that
   make up actually USING the app: pressing a tool/modal button, switching a tab,
   collapsing a changelog entry, or committing/discarding a field with
   Enter/Escape. Two app-wide listeners funnel through maybeRegenerateRandom()
   above, so there's zero cost in any other theme or mode and no per-tool wiring.

   Deliberately NOT a trigger: modal CLOSES. Every close/dismiss control is
   excluded below, and Escape only re-rolls when it lands in a field (a discard),
   never when it's dismissing a modal. Both listeners use the capture phase so a
   handler that calls stopPropagation() (common on inline-edit Enter/Escape)
   can't swallow the signal. */

// Skip-list: the theme controls handle themselves (reroll re-rolls on its own;
// save must keep showing the palette it just captured), and every close/dismiss
// control counts as a "close", which the user asked to leave alone.
const REGEN_CLICK_EXCLUDE =
  "#rerollBtn, #saveRandomBtn, .modal-close-btn, [data-modal-close], .nav-back-btn, .modal-cancel-btn";

document.addEventListener(
  "click",
  (e) => {
    const btn = (e.target as HTMLElement | null)?.closest("button");
    if (!btn || btn.closest(REGEN_CLICK_EXCLUDE)) return;
    maybeRegenerateRandom();
  },
  true,
);

document.addEventListener(
  "keydown",
  (e) => {
    if (e.key !== "Enter" && e.key !== "Escape") return;
    const target = e.target as HTMLElement | null;
    // Only a commit/discard inside a field — never a modal-closing Escape.
    if (!target || !target.matches("input, textarea, select")) return;
    maybeRegenerateRandom();
  },
  true,
);

document.addEventListener(
  "change",
  (e) => {
    const el = e.target as HTMLElement | null;
    if (
      !el ||
      !el.matches('input[type="checkbox"], input[type="radio"], select')
    )
      return;
    // The random-mode and palette-type toggles already clear + re-apply a fresh
    // palette in their own handlers (via applyTheme("random")); skip them here so
    // flipping either one doesn't redundantly double-roll.
    if (el.closest("#randomModeToggle, #randomPaletteToggle")) return;
    maybeRegenerateRandom();
  },
  true,
);

/* =============================================================================
   CUSTOM THEME SYSTEM
============================================================================= */

/** Generates a simple unique ID for new custom themes. */
function genThemeId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** Sanitises a proposed theme name — returns null if it would cause file/JSON issues. */
function sanitiseThemeName(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Reject characters that could break JSON strings or CSS identifiers
  if (/["\\\x00-\x1f]/.test(trimmed)) return null;
  if (trimmed.length > 48) return null;
  return trimmed;
}

/** Saves all custom themes to disk via Rust. */
async function saveCustomThemes(): Promise<void> {
  try {
    await invoke("save_custom_themes", { data: JSON.stringify(customThemes) });
  } catch {
    flash("Failed to save custom themes", "error");
  }
}

/** Loads custom themes from disk on startup. */
async function loadCustomThemes(): Promise<void> {
  try {
    const raw = await invoke<string>("load_custom_themes");
    const parsed = JSON.parse(raw);
    // Validate: must be an array; each entry must have id (string), name (string),
    // and vars (object). Drop any malformed entries rather than crashing later
    // when the theme engine tries to dereference their fields.
    if (!Array.isArray(parsed)) {
      customThemes = [];
      return;
    }
    customThemes = parsed
      .filter(
        (t): t is CustomTheme =>
          t !== null &&
          typeof t === "object" &&
          typeof t.id === "string" &&
          t.id.length > 0 &&
          typeof t.name === "string" &&
          t.vars !== null &&
          typeof t.vars === "object" &&
          !Array.isArray(t.vars),
      )
      .map((t) => ({
        id: t.id,
        name: t.name,
        vars: t.vars ?? {},
        advanced:
          t.advanced &&
          typeof t.advanced === "object" &&
          !Array.isArray(t.advanced)
            ? t.advanced
            : {},
      }));
  } catch {
    customThemes = [];
  }
}

/** Intensity → box-shadow spread/opacity mappings for glow effects. */
const GLOW_INTENSITY = {
  low: { opacity: 0.25, spread: 12 },
  medium: { opacity: 0.45, spread: 20 },
  high: { opacity: 0.65, spread: 32 },
};

/** Converts a hex color to rgba with the given opacity (0–1). */
function hexToRgba(hex: string, opacity: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

/** Builds and injects the <style> tag that applies a custom theme's advanced
 *  overrides (gradients, glows) on top of the CSS var values. Also applies the
 *  same !important cascade fixes used by the random theme so default.css rules
 *  don't bleed through. */
function applyCustomThemeStyles(theme: CustomTheme): void {
  const vars = theme.vars;
  const adv = theme.advanced;

  // Re-use the same palette-based overrides as the random theme so all the
  // default.css !important rules are neutralised consistently.
  applyRandomModalStyles(vars);

  // Now build the advanced overrides on top.
  const rules: string[] = [];

  // Header gradient / title colour
  if (adv.headerGradient) {
    const { colorA, colorB, angle } = adv.headerGradient;
    rules.push(`.tool-view-header, .section-header {
      background: linear-gradient(${angle}deg, ${colorA}, ${colorB}) !important;
    }`);
  }

  // Header glow (box-shadow on the header element)
  if (adv.headerGlow) {
    const { opacity, spread } = GLOW_INTENSITY[adv.headerGlow.intensity];
    const glow = hexToRgba(adv.headerGlow.color, opacity);
    rules.push(`.tool-view-header, .section-header {
      box-shadow: 0 0 ${spread}px ${glow} !important;
    }`);
  }

  // Body background gradient
  if (adv.bodyGradient) {
    const { colorA, colorB, angle } = adv.bodyGradient;
    rules.push(`body {
      background: linear-gradient(${angle}deg, ${colorA}, ${colorB}) fixed !important;
    }`);
  }

  // Modal glow
  if (adv.modalGlow) {
    const { opacity, spread } = GLOW_INTENSITY[adv.modalGlow.intensity];
    const glow = hexToRgba(adv.modalGlow.color, opacity);
    rules.push(`body.solid-modals .modal, body:not(.solid-modals) .modal {
      box-shadow: 0 0 ${spread}px ${glow}, 0 24px 48px rgba(0,0,0,0.6) !important;
    }`);
  }

  // Panel glow
  if (adv.panelGlow) {
    const { opacity, spread } = GLOW_INTENSITY[adv.panelGlow.intensity];
    const glow = hexToRgba(adv.panelGlow.color, opacity);
    rules.push(`.panel {
      box-shadow: 0 0 ${spread}px ${glow} !important;
    }`);
  }

  // Button glow
  if (adv.buttonGlow) {
    const { opacity, spread } = GLOW_INTENSITY[adv.buttonGlow.intensity];
    const glow = hexToRgba(adv.buttonGlow.color, opacity);
    rules.push(`button {
      box-shadow: 0 0 ${spread}px ${glow} !important;
    }`);
  }

  if (rules.length > 0) {
    let advTag = document.getElementById(
      "custom-theme-adv-styles",
    ) as HTMLStyleElement | null;
    if (!advTag) {
      advTag = document.createElement("style");
      advTag.id = "custom-theme-adv-styles";
      document.head.appendChild(advTag);
    }
    advTag.textContent = rules.join("\n");
  } else {
    document.getElementById("custom-theme-adv-styles")?.remove();
  }
}

/** Removes all custom theme inline vars and injected style tags. */
function clearCustomTheme(): void {
  clearRandomPalette(); // reuses the same RANDOM_VARS list
  document.getElementById("custom-theme-adv-styles")?.remove();
}

/** Applies a custom theme by id: sets CSS vars on :root and injects advanced styles. */
function applyCustomThemeById(id: string): void {
  const theme = customThemes.find((t) => t.id === id);
  if (!theme) return;
  _activeCustomId = id;
  const root = document.documentElement;
  for (const [key, value] of Object.entries(theme.vars)) {
    root.style.setProperty(key, value);
  }
  applyCustomThemeStyles(theme);
}

/** Repopulates the customThemeSelect dropdown and shows/hides the action buttons
 *  and the empty-state message. Call whenever customThemes changes. */
function refreshCustomThemeSelect(): void {
  const hasThemes = customThemes.length > 0;
  customThemeEmpty.style.display = hasThemes ? "none" : "block";
  customThemeSelect.style.display = hasThemes ? "" : "none";
  customThemeEditBtn.style.display = hasThemes ? "" : "none";
  customThemeDeleteBtn.style.display = hasThemes ? "" : "none";

  // Rebuild options
  customThemeSelect.innerHTML = "";
  for (const t of customThemes) {
    const opt = document.createElement("option");
    opt.value = t.id;
    opt.textContent = t.name;
    customThemeSelect.appendChild(opt);
  }

  // Restore selection to the active theme if possible
  if (_activeCustomId && customThemes.find((t) => t.id === _activeCustomId)) {
    customThemeSelect.value = _activeCustomId;
  } else if (customThemes.length > 0) {
    customThemeSelect.value = customThemes[0].id;
    _activeCustomId = customThemes[0].id;
  }
}

/** Reads the current computed CSS variable values from the document. Used to
 *  seed the editor with whatever the currently-active theme looks like. */
function readCurrentVars(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  const vars: Record<string, string> = {};
  for (const v of RANDOM_VARS) {
    const raw = style.getPropertyValue(v).trim();
    // Normalise to 6-digit hex so color inputs can consume it
    vars[v] = cssColorToHex(raw) ?? "#000000";
  }
  return vars;
}

/** Best-effort conversion of a CSS colour value to a 6-digit hex string.
 *  Handles #rgb, #rrggbb, #rrggbbaa (strips alpha), and rgb()/rgba() strings.
 *  Returns null for anything it can't parse. */
function cssColorToHex(css: string): string | null {
  const s = css.trim();
  // Already a hex colour
  if (s.startsWith("#")) {
    const h = s.slice(1).replace(/[^0-9a-fA-F]/g, "");
    if (h.length === 3) {
      return (
        "#" +
        h
          .split("")
          .map((c) => c + c)
          .join("")
      );
    }
    if (h.length >= 6) return "#" + h.slice(0, 6);
    return null;
  }
  // rgb / rgba
  const m = s.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/);
  if (m) {
    return (
      "#" +
      [m[1], m[2], m[3]]
        .map((n) => parseInt(n).toString(16).padStart(2, "0"))
        .join("")
    );
  }
  return null;
}

// ── Theme Editor ────────────────────────────────────────────────────────────

/** Populates every swatch in the editor body from a vars record. */
function tePopulateSwatches(vars: Record<string, string>): void {
  document.querySelectorAll<HTMLElement>(".te-row[data-var]").forEach((row) => {
    const varName = row.dataset.var!;
    const swatch = row.querySelector<HTMLInputElement>(".te-swatch")!;
    const hexInput = row.querySelector<HTMLInputElement>(".te-hex")!;
    const val = vars[varName] ?? "#000000";
    const hex = cssColorToHex(val) ?? "#000000";
    swatch.value = hex;
    hexInput.value = hex.toUpperCase();
    _teWorkingVars[varName] = hex;
  });
}

/** Populates advanced controls from an AdvancedOptions object. */
function tePopulateAdvanced(adv: AdvancedOptions): void {
  _teWorkingAdv = JSON.parse(JSON.stringify(adv)); // deep copy

  // Header gradient
  const hg = adv.headerGradient;
  teHeaderGradientToggle.checked = !!hg;
  teHeaderGradientControls.style.display = hg ? "" : "none";
  if (hg) {
    teHeaderColorA.value = hg.colorA;
    teHeaderColorAHex.value = hg.colorA.toUpperCase();
    teHeaderColorB.value = hg.colorB;
    teHeaderColorBHex.value = hg.colorB.toUpperCase();
    teHeaderAngle.value = String(hg.angle);
  }

  // Header glow
  const hglow = adv.headerGlow;
  teHeaderGlowToggle.checked = !!hglow;
  teHeaderGlowControls.style.display = hglow ? "" : "none";
  if (hglow) {
    teHeaderGlowColor.value = hglow.color;
    teHeaderGlowColorHex.value = hglow.color.toUpperCase();
    teSetIntensity("teHeaderGlowIntensity", hglow.intensity);
  }

  // Body gradient
  const bg = adv.bodyGradient;
  teBodyGradientToggle.checked = !!bg;
  teBodyGradientControls.style.display = bg ? "" : "none";
  if (bg) {
    teBodyColorA.value = bg.colorA;
    teBodyColorAHex.value = bg.colorA.toUpperCase();
    teBodyColorB.value = bg.colorB;
    teBodyColorBHex.value = bg.colorB.toUpperCase();
    teBodyAngle.value = String(bg.angle);
  }

  // Modal glow
  const mg = adv.modalGlow;
  teModalGlowToggle.checked = !!mg;
  teModalGlowControls.style.display = mg ? "" : "none";
  if (mg) {
    teModalGlowColor.value = mg.color;
    teModalGlowColorHex.value = mg.color.toUpperCase();
    teSetIntensity("teModalGlowIntensity", mg.intensity);
  }

  // Panel glow
  const pg = adv.panelGlow;
  tePanelGlowToggle.checked = !!pg;
  tePanelGlowControls.style.display = pg ? "" : "none";
  if (pg) {
    tePanelGlowColor.value = pg.color;
    tePanelGlowColorHex.value = pg.color.toUpperCase();
    teSetIntensity("tePanelGlowIntensity", pg.intensity);
  }

  // Button glow
  const bgl = adv.buttonGlow;
  teButtonGlowToggle.checked = !!bgl;
  teButtonGlowControls.style.display = bgl ? "" : "none";
  if (bgl) {
    teButtonGlowColor.value = bgl.color;
    teButtonGlowColorHex.value = bgl.color.toUpperCase();
    teSetIntensity("teButtonGlowIntensity", bgl.intensity);
  }
}

/** Sets the active state of intensity buttons for a named group. */
function teSetIntensity(inputId: string, value: string): void {
  const hidden = document.getElementById(inputId) as HTMLInputElement;
  if (hidden) hidden.value = value;
  document
    .querySelectorAll<HTMLElement>(`[data-target="${inputId}"]`)
    .forEach((btn) => {
      btn.classList.toggle("te-intensity-active", btn.dataset.val === value);
    });
}

/** Live-previews the current working vars + advanced options by applying them
 *  to the document exactly as the active theme application does. */
function teLivePreview(): void {
  const root = document.documentElement;
  for (const [key, value] of Object.entries(_teWorkingVars)) {
    root.style.setProperty(key, value);
  }
  // Build a synthetic theme object and apply its advanced styles
  const synthetic: CustomTheme = {
    id: "__preview__",
    name: "__preview__",
    vars: { ..._teWorkingVars },
    advanced: { ..._teWorkingAdv },
  };
  applyCustomThemeStyles(synthetic);
}

/** Reads all swatch inputs and rebuilds _teWorkingVars, then live-previews. */
function teSyncVarsAndPreview(): void {
  document.querySelectorAll<HTMLElement>(".te-row[data-var]").forEach((row) => {
    const varName = row.dataset.var!;
    const swatch = row.querySelector<HTMLInputElement>(".te-swatch")!;
    const hexInput = row.querySelector<HTMLInputElement>(".te-hex")!;
    _teWorkingVars[varName] = swatch.value;
    hexInput.value = swatch.value.toUpperCase();
  });
  teLivePreview();
}

/** Reads all advanced controls and rebuilds _teWorkingAdv, then live-previews. */
function teSyncAdvAndPreview(): void {
  _teWorkingAdv = {};

  if (teHeaderGradientToggle.checked) {
    _teWorkingAdv.headerGradient = {
      colorA: teHeaderColorA.value,
      colorB: teHeaderColorB.value,
      angle: parseInt(teHeaderAngle.value, 10) || 90,
    };
  }
  if (teHeaderGlowToggle.checked) {
    _teWorkingAdv.headerGlow = {
      color: teHeaderGlowColor.value,
      intensity: teHeaderGlowIntensity.value as "low" | "medium" | "high",
    };
  }
  if (teBodyGradientToggle.checked) {
    _teWorkingAdv.bodyGradient = {
      colorA: teBodyColorA.value,
      colorB: teBodyColorB.value,
      angle: parseInt(teBodyAngle.value, 10) || 160,
    };
  }
  if (teModalGlowToggle.checked) {
    _teWorkingAdv.modalGlow = {
      color: teModalGlowColor.value,
      intensity: teModalGlowIntensity.value as "low" | "medium" | "high",
    };
  }
  if (tePanelGlowToggle.checked) {
    _teWorkingAdv.panelGlow = {
      color: tePanelGlowColor.value,
      intensity: tePanelGlowIntensity.value as "low" | "medium" | "high",
    };
  }
  if (teButtonGlowToggle.checked) {
    _teWorkingAdv.buttonGlow = {
      color: teButtonGlowColor.value,
      intensity: teButtonGlowIntensity.value as "low" | "medium" | "high",
    };
  }

  teLivePreview();
}

// Theme editor Modal instance — declared before openThemeEditor so the function
// body can safely reference it (called only from event listeners, but tsc checks
// the declaration order for const references inside closures).
// closeOnEsc is true so Escape works like any other close path. onClosed handles
// revert + settings reopen for ALL paths (Escape, X, back arrow) in one place,
// but is suppressed after a successful Save (which sets _teSaveCompleted = true).
let _teSaveCompleted = false;
const themeEditorModal = new Modal(themeEditorBackdrop, {
  closeOnEsc: true,
  closeOnBackdrop: false,
  onOpen: () => {
    // modal.ts resets .modal-body scrollTop, but the actual scrollable elements
    // here are the tab panes (.te-groups). Reset them explicitly.
    document.getElementById("teTabGeneral")?.scrollTo(0, 0);
    document.getElementById("teTabAdvanced")?.scrollTo(0, 0);
  },
  onClosed: () => {
    if (!_teSaveCompleted) {
      // Cancel / Escape / X / back — revert the preview and return to Settings
      teRevertPreview();
      settingsModal.open();
    }
    _teSaveCompleted = false;
  },
});

/** Opens the theme editor. mode = "create" seeds from the currently active
 *  theme; mode = "edit" loads the specific custom theme by id. */
function openThemeEditor(mode: "create", id?: undefined): void;
function openThemeEditor(mode: "edit", id: string): void;
function openThemeEditor(mode: "create" | "edit", id?: string): void {
  _teMode = mode;
  _teEditId = id ?? null;
  _tePrevTheme = settings.theme;

  // Always open on the General tab
  teActivateTab("general");

  if (mode === "create") {
    themeEditorTitle.textContent = "Create Theme";
    teNameInput.value = "";
    // Seed from whatever's currently rendered (the active theme's colours)
    _teWorkingVars = readCurrentVars();
    _teWorkingAdv = {};
    tePopulateSwatches(_teWorkingVars);
    tePopulateAdvanced({});
  } else {
    themeEditorTitle.textContent = "Edit Theme";
    const theme = customThemes.find((t) => t.id === id)!;
    teNameInput.value = theme.name;
    _teWorkingVars = { ...theme.vars };
    _teWorkingAdv = JSON.parse(JSON.stringify(theme.advanced));
    tePopulateSwatches(_teWorkingVars);
    tePopulateAdvanced(theme.advanced);
  }

  // Rebuild the base-theme picker's custom section
  teBaseCustomGroup.innerHTML = "";
  if (customThemes.length > 0) {
    (teBaseCustomGroup as HTMLOptGroupElement).style.display = "";
    for (const t of customThemes) {
      if (mode === "edit" && t.id === id) continue; // skip self
      const opt = document.createElement("option");
      opt.value = `custom:${t.id}`;
      opt.textContent = t.name;
      teBaseCustomGroup.appendChild(opt);
    }
    if (teBaseCustomGroup.children.length === 0) {
      (teBaseCustomGroup as HTMLOptGroupElement).style.display = "none";
    }
  } else {
    (teBaseCustomGroup as HTMLOptGroupElement).style.display = "none";
  }

  // Apply live preview immediately
  teLivePreview();

  themeEditorModal.open();
}

/** Reverts the app theme to whatever was active before the editor was opened. */
function teRevertPreview(): void {
  clearCustomTheme();
  applyTheme(_tePrevTheme);
}

themeEditorBack.addEventListener("click", () => themeEditorModal.close());
themeEditorClose.addEventListener("click", () => themeEditorModal.close());

teCancel.addEventListener("click", () => themeEditorModal.close());

// Base theme picker: re-seed all swatches when the base changes
teBaseSelect.addEventListener("change", async () => {
  const val = teBaseSelect.value;
  if (val.startsWith("custom:")) {
    const id = val.slice(7);
    const theme = customThemes.find((t) => t.id === id);
    if (theme) {
      _teWorkingVars = { ...theme.vars };
      _teWorkingAdv = JSON.parse(JSON.stringify(theme.advanced));
    }
  } else {
    // Named system theme: load its CSS vars by temporarily loading the CSS
    // and reading computed values. We do this by swapping themeLink, waiting,
    // then reading; we'll swap back (or leave as-is since editor preview takes over).
    const saved = themeLink.href;
    await new Promise<void>((resolve) => {
      themeLink.onload = () => resolve();
      themeLink.href = `/themes/${val}.css`;
      // Fallback in case onload doesn't fire (same href)
      setTimeout(resolve, 100);
    });
    // Clear any inline overrides so computed style reflects the loaded CSS
    clearCustomTheme();
    _teWorkingVars = readCurrentVars();
    _teWorkingAdv = {};
    // Restore the preview
    themeLink.href = saved;
  }
  tePopulateSwatches(_teWorkingVars);
  tePopulateAdvanced(_teWorkingAdv);
  teLivePreview();
});

// Swatch and hex input changes — wire after DOM is ready (they're static in HTML)
document.querySelectorAll<HTMLElement>(".te-row[data-var]").forEach((row) => {
  const varName = row.dataset.var!;
  const swatch = row.querySelector<HTMLInputElement>(".te-swatch")!;
  const hexInput = row.querySelector<HTMLInputElement>(".te-hex")!;

  // Swatch moved by colour picker: update vars + preview, and update the hex
  // display only when the hex input doesn't have focus (i.e. the user isn't
  // mid-typing — writing back would stomp what they're entering).
  swatch.addEventListener("input", () => {
    _teWorkingVars[varName] = swatch.value;
    if (document.activeElement !== hexInput) {
      hexInput.value = swatch.value.toUpperCase();
    }
    teLivePreview();
  });

  // Hex input: only update the swatch + preview when the value is a valid full
  // hex. Never write back to hexInput here — let blur handle normalisation.
  hexInput.addEventListener("input", () => {
    const raw = hexInput.value.trim();
    const normalised = raw.startsWith("#") ? raw : "#" + raw;
    const hex = cssColorToHex(normalised);
    if (hex) {
      swatch.value = hex;
      _teWorkingVars[varName] = hex;
      teLivePreview();
    }
  });

  // On blur, normalise the display to whatever the swatch currently holds.
  hexInput.addEventListener("blur", () => {
    hexInput.value = swatch.value.toUpperCase();
  });
  hexInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") hexInput.blur();
  });
});

// Advanced toggle handlers
function teWireToggle(
  toggle: HTMLInputElement,
  controls: HTMLElement,
  onEnable: () => void,
): void {
  toggle.addEventListener("change", () => {
    controls.style.display = toggle.checked ? "" : "none";
    if (toggle.checked) onEnable();
    teSyncAdvAndPreview();
  });
}

teWireToggle(teHeaderGradientToggle, teHeaderGradientControls, () => {
  if (!teHeaderColorA.value)
    teHeaderColorA.value = _teWorkingVars["--color-btn"] ?? "#2563eb";
  teHeaderColorAHex.value = teHeaderColorA.value.toUpperCase();
  if (!teHeaderColorB.value)
    teHeaderColorB.value = _teWorkingVars["--color-panel"] ?? "#0f172a";
  teHeaderColorBHex.value = teHeaderColorB.value.toUpperCase();
});
teWireToggle(teHeaderGlowToggle, teHeaderGlowControls, () => {
  if (!teHeaderGlowColor.value)
    teHeaderGlowColor.value = _teWorkingVars["--color-btn"] ?? "#2563eb";
  teHeaderGlowColorHex.value = teHeaderGlowColor.value.toUpperCase();
});
teWireToggle(teBodyGradientToggle, teBodyGradientControls, () => {
  if (!teBodyColorA.value)
    teBodyColorA.value = _teWorkingVars["--color-bg"] ?? "#0b1220";
  teBodyColorAHex.value = teBodyColorA.value.toUpperCase();
  if (!teBodyColorB.value)
    teBodyColorB.value = _teWorkingVars["--color-panel"] ?? "#0f172a";
  teBodyColorBHex.value = teBodyColorB.value.toUpperCase();
});
teWireToggle(teModalGlowToggle, teModalGlowControls, () => {
  if (!teModalGlowColor.value)
    teModalGlowColor.value = _teWorkingVars["--color-btn"] ?? "#2563eb";
  teModalGlowColorHex.value = teModalGlowColor.value.toUpperCase();
});
teWireToggle(tePanelGlowToggle, tePanelGlowControls, () => {
  if (!tePanelGlowColor.value)
    tePanelGlowColor.value = _teWorkingVars["--color-border"] ?? "#1f2937";
  tePanelGlowColorHex.value = tePanelGlowColor.value.toUpperCase();
});
teWireToggle(teButtonGlowToggle, teButtonGlowControls, () => {
  if (!teButtonGlowColor.value)
    teButtonGlowColor.value = _teWorkingVars["--color-btn"] ?? "#2563eb";
  teButtonGlowColorHex.value = teButtonGlowColor.value.toUpperCase();
});

// Advanced glow color + hex updates
/** Wires a colour picker + hex input pair in the Advanced tab.
 *  Swatch changes update the hex input and trigger preview;
 *  hex input changes update the swatch and trigger preview;
 *  blur normalises the hex display. */
function teWireGlowColor(
  swatch: HTMLInputElement,
  hexInput: HTMLInputElement,
): void {
  swatch.addEventListener("input", () => {
    hexInput.value = swatch.value.toUpperCase();
    teSyncAdvAndPreview();
  });
  hexInput.addEventListener("input", () => {
    const raw = hexInput.value.trim();
    const normalised = raw.startsWith("#") ? raw : "#" + raw;
    const hex = cssColorToHex(normalised);
    if (hex) {
      swatch.value = hex;
      teSyncAdvAndPreview();
    }
  });
  hexInput.addEventListener("blur", () => {
    hexInput.value = swatch.value.toUpperCase();
  });
  hexInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") hexInput.blur();
  });
}
teWireGlowColor(teHeaderColorA, teHeaderColorAHex);
teWireGlowColor(teHeaderColorB, teHeaderColorBHex);
teWireGlowColor(teHeaderGlowColor, teHeaderGlowColorHex);
teWireGlowColor(teBodyColorA, teBodyColorAHex);
teWireGlowColor(teBodyColorB, teBodyColorBHex);
teWireGlowColor(teModalGlowColor, teModalGlowColorHex);
teWireGlowColor(tePanelGlowColor, tePanelGlowColorHex);
teWireGlowColor(teButtonGlowColor, teButtonGlowColorHex);

// Angle inputs
teHeaderAngle.addEventListener("input", teSyncAdvAndPreview);
teBodyAngle.addEventListener("input", teSyncAdvAndPreview);

// Intensity buttons
document.querySelectorAll<HTMLElement>(".te-intensity-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const target = btn.dataset.target!;
    const val = btn.dataset.val!;
    teSetIntensity(target, val);
    teSyncAdvAndPreview();
  });
});

// CSS var name tooltip — 2-second hover delay, fires only over the label text
const teVarTooltip = document.getElementById("teVarTooltip")!;
let _teTooltipTimer: ReturnType<typeof setTimeout> | null = null;

document.querySelectorAll<HTMLElement>(".te-label-text").forEach((text) => {
  const label = text.closest<HTMLElement>(".te-label")!;

  text.addEventListener("mouseenter", (e) => {
    if ((e as MouseEvent).target !== text) return;
    _teTooltipTimer = setTimeout(() => {
      teVarTooltip.textContent = label.dataset.css!;
      teVarTooltip.style.display = "block";
      requestAnimationFrame(() => teVarTooltip.classList.add("visible"));
      const rect = text.getBoundingClientRect();
      teVarTooltip.style.left = `${rect.left}px`;
      teVarTooltip.style.top = `${rect.bottom + 4}px`;
    }, 2000);
  });
  text.addEventListener("mousemove", (e) => {
    if (teVarTooltip.classList.contains("visible")) {
      teVarTooltip.style.left = `${(e as MouseEvent).clientX + 10}px`;
      teVarTooltip.style.top = `${(e as MouseEvent).clientY + 16}px`;
    }
  });
  text.addEventListener("mouseleave", () => {
    if (_teTooltipTimer) {
      clearTimeout(_teTooltipTimer);
      _teTooltipTimer = null;
    }
    teVarTooltip.classList.remove("visible");
    teVarTooltip.style.display = "none";
  });
});

// Theme editor tab switching
function teActivateTab(tab: "general" | "advanced"): void {
  document.querySelectorAll<HTMLElement>(".te-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.teTab === tab);
  });
  const general = document.getElementById("teTabGeneral")!;
  const advanced = document.getElementById("teTabAdvanced")!;
  general.style.display = tab === "general" ? "" : "none";
  advanced.style.display = tab === "advanced" ? "" : "none";
}

document.querySelectorAll<HTMLElement>(".te-tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    const tab = btn.dataset.teTab as "general" | "advanced";
    if (tab) teActivateTab(tab);
  });
});

// Save
teSave.addEventListener("click", async () => {
  const raw = teNameInput.value;
  const name = sanitiseThemeName(raw);
  if (!name) {
    flash("Please enter a valid theme name.", "error");
    return;
  }
  // Check for duplicate name (excluding self when editing)
  const duplicate = customThemes.find(
    (t) => t.name.toLowerCase() === name.toLowerCase() && t.id !== _teEditId,
  );
  if (duplicate) {
    flash(`A theme named "${name}" already exists.`, "error");
    return;
  }

  teSyncVarsAndPreview();
  teSyncAdvAndPreview();

  if (_teMode === "create") {
    const newTheme: CustomTheme = {
      id: genThemeId(),
      name,
      vars: { ..._teWorkingVars },
      advanced: { ..._teWorkingAdv },
    };
    customThemes.push(newTheme);
    _activeCustomId = newTheme.id;
    await saveCustomThemes();
    refreshCustomThemeSelect();
    // Create → becomes the active theme
    settings.theme = "custom";
    themeSelect.value = "custom";
    applySettings();
    await saveSettings();
    _teSaveCompleted = true;
    themeEditorModal.close();
    settingsModal.open();
    flash(`Theme "${name}" created`, "success");
  } else {
    const theme = customThemes.find((t) => t.id === _teEditId)!;
    theme.name = name;
    theme.vars = { ..._teWorkingVars };
    theme.advanced = { ..._teWorkingAdv };
    await saveCustomThemes();
    refreshCustomThemeSelect();
    // Edit → revert to previously active theme (user must choose it themselves)
    teRevertPreview();
    _teSaveCompleted = true;
    themeEditorModal.close();
    settingsModal.open();
    flash(`Theme "${name}" saved`, "success");
  }
});

// ── Custom subsettings wiring ───────────────────────────────────────────────

customThemeSelect.addEventListener("change", () => {
  _activeCustomId = customThemeSelect.value;
  if (settings.theme === "custom") {
    applyCustomThemeById(_activeCustomId);
  }
});

customThemeCreateBtn.addEventListener("click", () => {
  settingsModal.close();
  openThemeEditor("create");
});

customThemeEditBtn.addEventListener("click", () => {
  const id = customThemeSelect.value;
  if (id) {
    settingsModal.close();
    openThemeEditor("edit", id);
  }
});

// Delete confirm modal
const customThemeDeleteModal = new Modal(customThemeDeleteBackdrop);
customThemeDeleteBack.addEventListener("click", () => {
  customThemeDeleteModal.close();
  settingsModal.open();
});
customThemeDeleteCancelBtn.addEventListener("click", () => {
  customThemeDeleteModal.close();
  settingsModal.open();
});

customThemeDeleteBtn.addEventListener("click", () => {
  const id = customThemeSelect.value;
  const theme = customThemes.find((t) => t.id === id);
  if (!theme) return;
  customThemeDeleteMsg.textContent = `Are you sure you want to delete "${theme.name}"? This cannot be undone.`;
  settingsModal.close();
  customThemeDeleteModal.open();
});

customThemeDeleteConfirmBtn.addEventListener("click", async () => {
  const id = customThemeSelect.value;
  const theme = customThemes.find((t) => t.id === id);
  if (!theme) {
    customThemeDeleteModal.close();
    settingsModal.open();
    return;
  }
  const wasActive = settings.theme === "custom" && _activeCustomId === id;
  customThemes = customThemes.filter((t) => t.id !== id);
  await saveCustomThemes();
  customThemeDeleteModal.close();
  if (wasActive) {
    // Deleted the active theme — revert to default
    settings.theme = "default";
    _activeCustomId = null;
    themeSelect.value = "default";
    applySettings();
    await saveSettings();
  }
  refreshCustomThemeSelect();
  settingsModal.open();
  flash(`Theme "${theme.name}" deleted`, "success");
});

/* =============================================================================
   THEME
============================================================================= */

/** Applies a named theme, the random palette system, or a custom theme.
 *  For standard themes: loads the CSS file and clears any leftover inline
 *  random overrides. For "random": generates and applies a palette immediately
 *  (persistent reuses the stored palette; regenerative always generates fresh).
 *  For "custom": applies the selected custom theme by id. */
function applyTheme(themeName: string): void {
  if (themeName === "custom") {
    themeLink.href = "/themes/default.css";
    themeLink.onload = () => {
      if (_activeCustomId) applyCustomThemeById(_activeCustomId);
    };
    if (_activeCustomId) applyCustomThemeById(_activeCustomId);
    return;
  }

  if (themeName === "random") {
    const generator = settings.randomHarmonized
      ? generateRandomPalette
      : generateChaoticPalette;
    if (settings.randomPersistent) {
      // Persistent: reuse stored palette, generate+store if none exists
      let palette: Record<string, string>;
      const stored = localStorage.getItem(PERSISTENT_RANDOM_KEY);
      if (stored) {
        try {
          palette = JSON.parse(stored);
        } catch {
          palette = generator();
        }
      } else {
        palette = generator();
      }
      localStorage.setItem(PERSISTENT_RANDOM_KEY, JSON.stringify(palette));
      themeLink.href = "/themes/default.css";
      themeLink.onload = () => applyPalette(palette);
      applyPalette(palette);
    } else {
      // Regenerative: generate fresh every time applyTheme is called
      const palette = generator();
      themeLink.href = "/themes/default.css";
      themeLink.onload = () => applyPalette(palette);
      applyPalette(palette);
    }
    return;
  }

  // Standard theme: load CSS first, clear inline overrides once ready.
  // clearRandomPalette() is called immediately AND on onload because if the new
  // href is the same as the current one (e.g. switching from Random to Default,
  // both of which use default.css as a base), the browser won't fire onload.
  localStorage.removeItem(PERSISTENT_RANDOM_KEY);
  themeLink.href = `/themes/${themeName}.css`;
  themeLink.onload = () => {
    clearRandomPalette();
    clearCustomTheme();
    // CSS file is now loaded and :root vars are live — notify tools.
    window.dispatchEvent(new CustomEvent("themechange"));
  };
  clearRandomPalette();
  clearCustomTheme();
}

/* =============================================================================
   SEASONAL THEME EFFECTS  (Christmas snow / Halloween lightning)
   -----------------------------------------------------------------------------
   Canvas-based instead of CSS keyframes so each flake/bolt is genuinely
   independent: no shared "loop" for the whole layer to visibly snap back on,
   and shapes/timing can be randomized per-instance instead of picked from a
   handful of fixed keyframe steps. One shared full-window canvas, appended as
   the LAST child of <body> so it always paints above ordinary content
   (including panels, which was the complaint with the old body::before/::after
   version) while staying below the toast/lock-screen layer (z-index 9999+).
   pointer-events stays off throughout, so nothing here can ever block a click.
============================================================================= */

interface Snowflake {
  x: number;
  y: number;
  r: number;
  speed: number;
  drift: number;
  driftPhase: number;
  driftFreq: number;
  wanderVel: number;
}

interface LightningStrike {
  points: { x: number; y: number }[];
  branches: { x: number; y: number }[][];
  bornAt: number;
  lifespanMs: number;
}

let seasonalCanvas: HTMLCanvasElement | null = null;
let seasonalCtx: CanvasRenderingContext2D | null = null;
let seasonalAnimationId: number | null = null;
let seasonalResizeHandler: (() => void) | null = null;
let seasonalActiveTheme: string | null = null;

let snowflakes: Snowflake[] = [];
let snowPile: number[] = [];
const SNOW_PILE_COLUMN_WIDTH = 5; // px per accumulation bucket along the bottom edge
const SNOW_PILE_MAX_HEIGHT = 100; // px cap — settles into a bank instead of swallowing the UI
const SNOW_MAX_SLOPE = 1.5; // px — max height difference tolerated between adjacent columns before it slides
const SNOW_RELAX_PASSES = 4; // relaxation sweeps per frame; alternates direction, see relaxSnowPile()
const SNOW_WANDER_ACCEL = 55; // px/sec² — magnitude of the random gust nudges applied to wanderVel each frame
const SNOW_WANDER_DAMPING = 0.86; // per-frame decay applied to wanderVel so gusts settle instead of accumulating forever

let lightningStrikes: LightningStrike[] = [];
let lightningTimeoutId: number | null = null;
const LIGHTNING_DARKEN_STRENGTH = 0.4; // how far the screen dims at peak flash brightness, so bolts pop by contrast

/** Creates (once) and returns the shared full-window canvas + context used by
 *  both seasonal effects, resizing it to the current window/DPR each call. */
function ensureSeasonalCanvas(): { ctx: CanvasRenderingContext2D } {
  if (!seasonalCanvas) {
    seasonalCanvas = document.createElement("canvas");
    seasonalCanvas.id = "seasonalEffectsCanvas";
    seasonalCanvas.style.position = "fixed";
    seasonalCanvas.style.inset = "0";
    seasonalCanvas.style.width = "100vw";
    seasonalCanvas.style.height = "100vh";
    seasonalCanvas.style.pointerEvents = "none";
    seasonalCanvas.style.zIndex = "5000";
    document.body.appendChild(seasonalCanvas);
  }
  const ctx = seasonalCanvas.getContext("2d");
  if (!ctx)
    throw new Error("2d canvas context unavailable for seasonal effects");
  seasonalCtx = ctx;
  resizeSeasonalCanvas();
  return { ctx };
}

/** Sizes the canvas's backing store to the window at the current device pixel
 *  ratio so flakes/bolts stay crisp on high-DPI displays, and re-applies the
 *  DPR transform (resizing a canvas element always resets its context). */
function resizeSeasonalCanvas(): void {
  if (!seasonalCanvas || !seasonalCtx) return;
  const dpr = window.devicePixelRatio || 1;
  seasonalCanvas.width = Math.round(window.innerWidth * dpr);
  seasonalCanvas.height = Math.round(window.innerHeight * dpr);
  seasonalCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

/** Tears down whichever seasonal effect is currently running: cancels the
 *  animation frame and any pending strike timers, drops the resize listener,
 *  and removes the canvas entirely. Called before starting a new effect and
 *  whenever the active theme stops being Christmas/Halloween. */
function stopSeasonalEffect(): void {
  if (seasonalAnimationId !== null) {
    cancelAnimationFrame(seasonalAnimationId);
    seasonalAnimationId = null;
  }
  if (lightningTimeoutId !== null) {
    window.clearTimeout(lightningTimeoutId);
    lightningTimeoutId = null;
  }
  if (seasonalResizeHandler) {
    window.removeEventListener("resize", seasonalResizeHandler);
    seasonalResizeHandler = null;
  }
  if (seasonalCanvas) {
    seasonalCanvas.remove();
    seasonalCanvas = null;
    seasonalCtx = null;
  }
  snowflakes = [];
  snowPile = [];
  lightningStrikes = [];
  seasonalActiveTheme = null;
}

/** Starts (or leaves running) the canvas effect matching the given theme
 *  name, tearing down whatever was running before. No-ops if the requested
 *  effect is already active. Called on startup and on every "themechange". */
function applySeasonalEffect(themeName: string): void {
  if (seasonalActiveTheme === themeName) return;
  stopSeasonalEffect();
  if (themeName === "christmas") {
    seasonalActiveTheme = "christmas";
    startChristmasSnow();
  } else if (themeName === "halloween") {
    seasonalActiveTheme = "halloween";
    startHalloweenLightning();
  }
}

/** Christmas snowfall. Each flake is an independent object that falls,
 *  drifts side to side, and — once it reaches the accumulated snow line at
 *  its x position — "lands" (adding a little height to that column of the
 *  snowbank) and respawns at the top. Because every flake resets itself
 *  individually there's no shared loop for the whole layer to visibly snap
 *  back on; the snowfall is continuous for as long as the theme is active. */
function startChristmasSnow(): void {
  const { ctx } = ensureSeasonalCanvas();

  const pileColumns = Math.ceil(window.innerWidth / SNOW_PILE_COLUMN_WIDTH) + 1;
  snowPile = new Array(pileColumns).fill(0);

  function spawnSnowflake(randomY: boolean): Snowflake {
    return {
      x: Math.random() * window.innerWidth,
      y: randomY ? Math.random() * window.innerHeight : -10,
      r: 1.5 + Math.random() * 2.5,
      speed: 20 + Math.random() * 40, // px/sec
      drift: 10 + Math.random() * 20, // sway amplitude
      driftPhase: Math.random() * Math.PI * 2,
      driftFreq: 0.25 + Math.random() * 0.9, // sway rate — varies per flake so they don't all swing in lockstep
      wanderVel: 0, // slow random-walk "gust" velocity, built up frame to frame below
    };
  }

  window.setTimeout(() => {
    const flakeCount = Math.min(200, Math.round((window.innerWidth * window.innerHeight) / 2000),);
    snowflakes = Array.from({ length: flakeCount }, () => spawnSnowflake(true));
  }, 300); // give the window time to reach its final/restored size first

  function pileHeightAt(x: number): number {
    const col = Math.max(
      0,
      Math.min(snowPile.length - 1, Math.floor(x / SNOW_PILE_COLUMN_WIDTH)),
    );
    return snowPile[col] ?? 0;
  }

  function addToPile(x: number, amount: number): void {
    const col = Math.max(
      0,
      Math.min(snowPile.length - 1, Math.floor(x / SNOW_PILE_COLUMN_WIDTH)),
    );
    const current = snowPile[col] ?? 0;
    if (current < SNOW_PILE_MAX_HEIGHT) {
      snowPile[col] = Math.min(SNOW_PILE_MAX_HEIGHT, current + amount);
    }
    // Spread a little into the immediate neighbours so the bank reads as a
    // drift rather than a bar chart.
    for (const neighbor of [col - 1, col + 1]) {
      if (neighbor < 0 || neighbor >= snowPile.length) continue;
      const neighborCurrent = snowPile[neighbor] ?? 0;
      if (neighborCurrent < SNOW_PILE_MAX_HEIGHT) {
        snowPile[neighbor] = Math.min(
          SNOW_PILE_MAX_HEIGHT,
          neighborCurrent + amount * 0.3,
        );
      }
    }
  }

  /** Enforces a maximum height difference between adjacent columns — real
   *  snow has an angle of repose; ours didn't, which is why a busy pile
   *  turned into stalagmites instead of a level bank. Each pass nudges half
   *  the excess from a too-tall column into its shorter neighbor. Run a few
   *  passes a frame, alternating sweep direction, so tall spikes settle out
   *  in a couple of frames even under a heavy snowfall rate, with no bias
   *  toward one side from always relaxing left-to-right. */
  function relaxSnowPile(): void {
    for (let pass = 0; pass < SNOW_RELAX_PASSES; pass++) {
      const forward = pass % 2 === 0;
      const start = forward ? 0 : snowPile.length - 2;
      const end = forward ? snowPile.length - 1 : -1;
      const step = forward ? 1 : -1;
      for (let i = start; i !== end; i += step) {
        const a = snowPile[i] ?? 0;
        const b = snowPile[i + 1] ?? 0;
        const diff = a - b;
        if (Math.abs(diff) <= SNOW_MAX_SLOPE) continue;
        const move = (Math.abs(diff) - SNOW_MAX_SLOPE) * 0.5;
        if (diff > 0) {
          snowPile[i] = a - move;
          snowPile[i + 1] = b + move;
        } else {
          snowPile[i] = a + move;
          snowPile[i + 1] = b - move;
        }
      }
    }
  }

  let lastFrame = performance.now();

  function frame(now: number): void {
    const dt = Math.min(0.05, (now - lastFrame) / 1000); // clamp so a stalled/background tab doesn't jump-cut
    lastFrame = now;

    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

    relaxSnowPile();

    // Snowbank silhouette across the bottom edge.
    if (snowPile.length > 0 && snowPile.some((h) => h > 0)) {
      ctx.beginPath();
      ctx.moveTo(0, window.innerHeight);
      for (let i = 0; i < snowPile.length; i++) {
        ctx.lineTo(
          i * SNOW_PILE_COLUMN_WIDTH,
          window.innerHeight - (snowPile[i] ?? 0),
        );
      }
      ctx.lineTo(window.innerWidth, window.innerHeight);
      ctx.closePath();
      ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
      ctx.fill();
    }

    for (const flake of snowflakes) {
      flake.driftPhase += dt * flake.driftFreq;
      // Smoothed random walk ("gusts"): nudge velocity randomly each frame,
      // then decay it — an Ornstein-Uhlenbeck-style process. This is what
      // actually breaks up the pure-sine look; the sine term alone just
      // offsets in phase/amplitude, which still reads as "the same wave"
      // repeating for every flake.
      flake.wanderVel += (Math.random() - 0.5) * SNOW_WANDER_ACCEL * dt;
      flake.wanderVel *= Math.pow(SNOW_WANDER_DAMPING, dt * 60);
      flake.x +=
        Math.sin(flake.driftPhase) * flake.drift * dt * 4 +
        flake.wanderVel * dt;
      flake.y += flake.speed * dt;
      // Wrap horizontally so drift never permanently walks a flake off-screen.
      if (flake.x < -10) flake.x = window.innerWidth + 10;
      if (flake.x > window.innerWidth + 10) flake.x = -10;

      const groundY = window.innerHeight - pileHeightAt(flake.x);
      if (flake.y + flake.r >= groundY) {
        addToPile(flake.x, 0.15 + Math.random() * 0.25);
        Object.assign(flake, spawnSnowflake(false));
        continue;
      }

      ctx.beginPath();
      ctx.arc(flake.x, flake.y, flake.r, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
      ctx.fill();
    }

    seasonalAnimationId = requestAnimationFrame(frame);
  }

  seasonalAnimationId = requestAnimationFrame(frame);

  seasonalResizeHandler = () => {
    resizeSeasonalCanvas();
    const newColumns =
      Math.ceil(window.innerWidth / SNOW_PILE_COLUMN_WIDTH) + 1;
    if (newColumns !== snowPile.length) {
      const resized = new Array(newColumns).fill(0);
      for (let i = 0; i < Math.min(newColumns, snowPile.length); i++) {
        resized[i] = snowPile[i] ?? 0;
      }
      snowPile = resized;
    }
  };
  window.addEventListener("resize", seasonalResizeHandler);
}

/** Halloween lightning. Each strike's shape is generated fresh via recursive
 *  midpoint displacement (the standard fractal-lightning technique), so no
 *  two bolts look alike, and strikes are scheduled on a randomized interval
 *  rather than a fixed CSS loop, so the timing never falls into a rhythm. */
function startHalloweenLightning(): void {
  const { ctx } = ensureSeasonalCanvas();

  /** Recursively displaces the midpoint of a line segment to build a jagged
   *  bolt path from (x1,y1) to (x2,y2), pushing each final point into `points`. */
  function midpointBolt(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    displace: number,
    points: { x: number; y: number }[],
  ): void {
    if (displace < 6) {
      points.push({ x: x2, y: y2 });
      return;
    }
    const midX = (x1 + x2) / 2 + (Math.random() - 0.5) * displace;
    const midY = (y1 + y2) / 2;
    midpointBolt(x1, y1, midX, midY, displace / 1.9, points);
    midpointBolt(midX, midY, x2, y2, displace / 1.9, points);
  }

  function spawnStrike(): void {
    const startX = window.innerWidth * (0.1 + Math.random() * 0.8);
    const startY = 0;
    const endY = window.innerHeight * (0.55 + Math.random() * 0.4);
    const endX = startX + (Math.random() - 0.5) * window.innerWidth * 0.18;

    const points: { x: number; y: number }[] = [{ x: startX, y: startY }];
    midpointBolt(startX, startY, endX, endY, window.innerWidth * 0.12, points);

    const branches: { x: number; y: number }[][] = [];
    const branchCount = Math.random() < 0.4 ? 0 : Math.random() < 0.75 ? 1 : 2;
    for (let b = 0; b < branchCount; b++) {
      const originIndex =
        1 + Math.floor(Math.random() * Math.max(1, points.length - 2));
      const origin = points[originIndex];
      if (!origin) continue;
      const branchEndY =
        origin.y + (endY - origin.y) * (0.3 + Math.random() * 0.4);
      const branchEndX =
        origin.x + (Math.random() - 0.5) * window.innerWidth * 0.15;
      const branchPoints: { x: number; y: number }[] = [
        { x: origin.x, y: origin.y },
      ];
      midpointBolt(
        origin.x,
        origin.y,
        branchEndX,
        branchEndY,
        window.innerWidth * 0.06,
        branchPoints,
      );
      branches.push(branchPoints);
    }

    lightningStrikes.push({
      points,
      branches,
      bornAt: performance.now(),
      lifespanMs:
        Math.random() < 0.10
          ? 2500 + Math.random() * 2500 // occasional long, lingering flash
          : 250 + Math.random() * 250, // normal quick flash
    });

    // Occasional quick double-strike, like real lightning restriking the same area.
    if (Math.random() < 0.22) {
      window.setTimeout(spawnStrike, 60 + Math.random() * 90);
    }
  }

  function scheduleNextStrike(): void {
    const delay = 1000 + Math.random() * 2500; // noticeably more active than the original 2.2-8.7s gaps
    lightningTimeoutId = window.setTimeout(() => {
      spawnStrike();
      scheduleNextStrike();
    }, delay);
  }

  /** Two-pulse Gaussian flicker curve — a quick bright flash, brief dip, a
   *  fainter second pulse, then fade out — so each strike stutters like real
   *  lightning instead of doing a simple linear fade. */
  function flickerIntensity(elapsedMs: number, lifespanMs: number): number {
    const t = elapsedMs / lifespanMs;
    if (t >= 1) return 0;
    const pulse1 = Math.exp(-Math.pow((t - 0.08) / 0.06, 2));
    const pulse2 = Math.exp(-Math.pow((t - 0.32) / 0.1, 2)) * 0.55;
    return Math.min(1, pulse1 + pulse2);
  }

  function strokeBolt(
    points: { x: number; y: number }[],
    alpha: number,
    coreWidth: number,
  ): void {
    const [first, ...rest] = points;
    if (!first || rest.length === 0) return;

    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    // Wide soft purple glow pass.
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    for (const p of rest) ctx.lineTo(p.x, p.y);
    ctx.strokeStyle = `rgba(147, 112, 219, ${alpha * 0.5})`;
    ctx.lineWidth = coreWidth * 5;
    ctx.shadowColor = `rgba(147, 112, 219, ${alpha * 0.8})`;
    ctx.shadowBlur = 22;
    ctx.stroke();

    // Bright white-purple core.
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    for (const p of rest) ctx.lineTo(p.x, p.y);
    ctx.strokeStyle = `rgba(240, 235, 255, ${alpha})`;
    ctx.lineWidth = coreWidth;
    ctx.shadowBlur = 10;
    ctx.stroke();

    ctx.restore();
  }

  function frame(now: number): void {
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    lightningStrikes = lightningStrikes.filter(
      (strike) => now - strike.bornAt < strike.lifespanMs,
    );

    let maxAlpha = 0;
    for (const strike of lightningStrikes) {
      const alpha = flickerIntensity(now - strike.bornAt, strike.lifespanMs);
      if (alpha > maxAlpha) maxAlpha = alpha;
    }
    if (maxAlpha > 0.01) {
      ctx.fillStyle = `rgba(5, 0, 12, ${maxAlpha * LIGHTNING_DARKEN_STRENGTH})`;
      ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
    }

    for (const strike of lightningStrikes) {
      const alpha = flickerIntensity(now - strike.bornAt, strike.lifespanMs);
      if (alpha <= 0.01) continue;
      strokeBolt(strike.points, alpha, 2.2);
      for (const branch of strike.branches)
        strokeBolt(branch, alpha * 0.6, 1.3);
    }
    seasonalAnimationId = requestAnimationFrame(frame);
  }

  seasonalAnimationId = requestAnimationFrame(frame);
  lightningTimeoutId = window.setTimeout(
    () => {
      spawnStrike();
      scheduleNextStrike();
    },
    400 + Math.random() * 800,
  ); // first strike arrives quickly

  seasonalResizeHandler = () => resizeSeasonalCanvas();
  window.addEventListener("resize", seasonalResizeHandler);
  document.addEventListener("click", () => spawnStrike());
}

window.addEventListener("themechange", () =>
  applySeasonalEffect(settings.theme),
);

/* =============================================================================
   SETTINGS — LOAD / SAVE / APPLY
============================================================================= */

/** Pushes all current settings values into the UI controls and re-applies
 *  theme, font scale, and clock format. Safe to call at any time. */
function applySettings(): void {
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
async function saveSettings(): Promise<void> {
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

const settingsModal = new Modal(settingsBackdrop, {
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
  _activeCustomId = newTheme.id;
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
   ABOUT MODAL
============================================================================= */

const aboutModal = new Modal(aboutBackdrop);

aboutBtn.addEventListener("click", () => aboutModal.open());
aboutClose.addEventListener("click", () => aboutModal.close());

// External links inside about body open in the browser; modal links are handled separately
aboutBackdrop.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  if (target.tagName === "A") {
    const anchor = target as HTMLAnchorElement;
    if (
      anchor.id === "changelogLink" ||
      anchor.id === "licensingLink" ||
      anchor.id === "readmeLink" ||
      anchor.id === "securityLink" ||
      anchor.id === "contributingLink"
    )
      return;
    e.preventDefault();
    if (anchor.href) openUrl(anchor.href);
  }
});

document.getElementById("changelogLink")!.addEventListener("click", (e) => {
  e.preventDefault();
  aboutModal.close();
  openChangelog();
});

document.getElementById("licensingLink")!.addEventListener("click", (e) => {
  e.preventDefault();
  aboutModal.close();
  openLicensing();
});

document.getElementById("readmeLink")!.addEventListener("click", (e) => {
  e.preventDefault();
  aboutModal.close();
  openReadme();
});

document.getElementById("securityLink")!.addEventListener("click", (e) => {
  e.preventDefault();
  aboutModal.close();
  openSecurity();
});

document.getElementById("contributingLink")!.addEventListener("click", (e) => {
  e.preventDefault();
  aboutModal.close();
  openContributing();
});

/* =============================================================================
   UPDATE CHECK  (shell-level)
   -----------------------------------------------------------------------------
   Opt-in, fire-and-forget version check against the GitHub Releases API (see
   lib.rs `check_for_updates` — the only network call the app makes). Drives
   two signals while a newer, un-ignored release exists: the pulsing About icon
   in the sidebar, and a notice line + Ignore button in the About modal. Every
   UI reaction funnels through refreshUpdateUI() so there's a single place that
   reflects _updateInfo into the DOM. (The Settings toggle that enables all of
   this is wired in the General Settings section.)
============================================================================= */

const updateNotice = document.getElementById("updateNotice")!;
const updateNoticeLink = document.getElementById(
  "updateNoticeLink",
) as HTMLAnchorElement;
const homeUpdateNotice = document.getElementById("homeUpdateNotice")!;
const homeUpdateLink = document.getElementById(
  "homeUpdateLink",
) as HTMLAnchorElement;
const ignoreVersionBtn = document.getElementById("ignoreVersionBtn")!;
const ignoreVersionBackdrop = document.getElementById("ignoreVersionBackdrop")!;
const ignoreVersionBack = document.getElementById("ignoreVersionBack")!;
const ignoreVersionClose = document.getElementById("ignoreVersionClose")!;
const ignoreVersionCancel = document.getElementById("ignoreVersionCancel")!;
const ignoreVersionConfirm = document.getElementById("ignoreVersionConfirm")!;
const ignoreVersionTag = document.getElementById("ignoreVersionTag")!;

/** Compares two "vX.Y.Z" strings numerically. Leading 'v'/'V' and surrounding
 *  whitespace are ignored, missing trailing segments count as 0 (so "1.2" ==
 *  "1.2.0"), and any non-numeric segment is treated as 0. Returns > 0 when
 *  `a` is newer than `b`, < 0 when older, 0 when equal. Plain string compare
 *  would rank "v0.10.0" below "v0.9.0" — this doesn't. */
function compareVersions(a: string, b: string): number {
  const parse = (s: string): number[] =>
    s
      .trim()
      .replace(/^v/i, "")
      .split(".")
      .map((p) => parseInt(p, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Reflects the current _updateInfo into the DOM — the single choke point for
 *  every update signal: the sidebar About-icon pulse, the About-modal notice
 *  line, and the Home top-bar "Update Available" line (both with the latest tag
 *  linked to the release page). Safe to call anytime — with no update available
 *  it clears every signal. */
function refreshUpdateUI(): void {
  const info = _updateInfo;
  const available = info?.available ?? false;

  aboutBtn.classList.toggle("update-available", available);

  if (available && info) {
    updateNoticeLink.textContent = info.latest;
    updateNoticeLink.href = info.htmlUrl || "#";
    updateNotice.style.display = "";

    homeUpdateLink.textContent = info.latest;
    homeUpdateLink.href = info.htmlUrl || "#";
    homeUpdateNotice.style.display = "";
  } else {
    updateNotice.style.display = "none";
    homeUpdateNotice.style.display = "none";
  }
}

// Home top-bar update link → open the release page in the default browser.
// (The Home header isn't inside a modal, so it has no aboutBackdrop-style
// delegated link handler — wire it directly.)
homeUpdateLink.addEventListener("click", (e) => {
  e.preventDefault();
  if (_updateInfo?.htmlUrl) openUrl(_updateInfo.htmlUrl);
});

/** Runs the version check, then updates state + UI. Never throws: any failure
 *  (network down, rate-limited, 404 when no release exists, malformed body)
 *  leaves _updateInfo null and the UI untouched, so offline-by-default holds.
 *  An update counts as "available" only when the latest release is newer than
 *  BOTH the running version AND the ignored version — so a release newer than
 *  an ignored one re-surfaces, while the ignored one itself stays silent.
 *  Callers gate on settings.autoCheckUpdates; this function does not. */
async function checkForUpdates(): Promise<void> {
  try {
    const raw = await invoke<{
      current: string;
      latest: string;
      html_url: string;
    }>("check_for_updates");
    const newerThanCurrent = compareVersions(raw.latest, raw.current) > 0;
    const newerThanIgnored =
      compareVersions(raw.latest, settings.ignoredUpdateVersion) > 0;
    _updateInfo = {
      current: raw.current,
      latest: raw.latest,
      htmlUrl: raw.html_url,
      available: newerThanCurrent && newerThanIgnored,
    };
  } catch {
    // Silent by design — no toast, no noise.
    _updateInfo = null;
  }
  refreshUpdateUI();
}

/* -----------------------------------------------------------------------------
   Ignore-version modal — opened from the About-modal Ignore button. Follows the
   same replace-then-return pattern as the other About sub-modals (changelog,
   licensing…): About closes, this opens; back-arrow and Cancel return to About;
   the X closes out entirely. Only the Confirm button actually writes the
   ignored version — matching the "ignore is committed on the confirm modal,
   not the About button" behaviour we settled on.
----------------------------------------------------------------------------- */

const ignoreVersionModal = new Modal(ignoreVersionBackdrop);

ignoreVersionBtn.addEventListener("click", () => {
  if (_updateInfo) ignoreVersionTag.textContent = _updateInfo.latest;
  aboutModal.close();
  ignoreVersionModal.open();
});

/** Return to the About modal without ignoring — shared by the back arrow and
 *  Cancel. */
function returnToAboutFromIgnore(): void {
  ignoreVersionModal.close();
  aboutModal.open();
}

ignoreVersionBack.addEventListener("click", returnToAboutFromIgnore);
ignoreVersionCancel.addEventListener("click", returnToAboutFromIgnore);
ignoreVersionClose.addEventListener("click", () => ignoreVersionModal.close());

ignoreVersionConfirm.addEventListener("click", async () => {
  if (_updateInfo) {
    // Persist the ignored tag, then locally clear "available" so the notice +
    // pulse drop immediately (a later release, being newer than this tag, will
    // re-surface on the next check).
    settings.ignoredUpdateVersion = _updateInfo.latest;
    await saveSettings();
    _updateInfo = { ..._updateInfo, available: false };
    refreshUpdateUI();
    flash("Version ignored", "success");
  }
  returnToAboutFromIgnore();
});

/* -----------------------------------------------------------------------------
   New Version Notification toggle (General Settings) + enable-confirm modal.
   Off by default. Turning it ON is gated by a confirm modal explaining the one
   network request; the toggle only commits if the user proceeds (same
   revert-on-cancel shape as the App Lock toggle). Enabling also runs a check
   immediately so a pending update surfaces without waiting for the next launch.
   Turning it OFF stops checks and clears any live signal at once.
----------------------------------------------------------------------------- */

const newVersionToggle = document.getElementById(
  "newVersionToggle",
) as HTMLInputElement;
const newVersionLabel = document.getElementById("newVersionLabel")!;
const updateEnableBackdrop = document.getElementById("updateEnableBackdrop")!;
const updateEnableBack = document.getElementById("updateEnableBack")!;
const updateEnableClose = document.getElementById("updateEnableClose")!;
const updateEnableCancel = document.getElementById("updateEnableCancel")!;
const updateEnableConfirm = document.getElementById("updateEnableConfirm")!;

const updateEnableModal = new Modal(updateEnableBackdrop, {
  closeOnEsc: false,
});

/** Syncs the toggle + its Enabled/Disabled label to the current setting.
 *  Called from applySettings() so load, reset, and reopen all stay in sync. */
function applyUpdateSettings(): void {
  newVersionToggle.checked = settings.autoCheckUpdates;
  newVersionLabel.textContent = settings.autoCheckUpdates
    ? "Enabled"
    : "Disabled";
}

/** Opens the enable-confirm modal and resolves true only if the user proceeds.
 *  Back arrow, Cancel, and the X all resolve false; Esc is disabled so it can't
 *  bypass this resolution and strand the caller. Mirrors openSetLockModal. */
function openUpdateEnableModal(): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (proceed: boolean): void => {
      if (settled) return;
      settled = true;
      updateEnableBack.onclick = null;
      updateEnableCancel.onclick = null;
      updateEnableClose.onclick = null;
      updateEnableConfirm.onclick = null;
      updateEnableModal.close();
      resolve(proceed);
    };
    updateEnableBack.onclick = () => done(false);
    updateEnableCancel.onclick = () => done(false);
    updateEnableClose.onclick = () => done(false);
    updateEnableConfirm.onclick = () => done(true);
    updateEnableModal.open();
  });
}

newVersionToggle.addEventListener("change", async () => {
  if (newVersionToggle.checked) {
    // Turning ON: revert visually until confirmed, then gate on the modal —
    // the setting stays off unless the user proceeds through it.
    newVersionToggle.checked = false;
    settingsModal.close();
    const proceed = await openUpdateEnableModal();
    if (!proceed) {
      settingsModal.open(); // left off
      return;
    }
    settings.autoCheckUpdates = true;
    await saveSettings();
    applyUpdateSettings();
    settingsModal.open();
    flash("Version notifications enabled", "success");
    // Run a check now so a pending update shows without a restart.
    void checkForUpdates();
  } else {
    // Turning OFF: stop checking and clear any live pulse/notice immediately.
    settings.autoCheckUpdates = false;
    await saveSettings();
    applyUpdateSettings();
    _updateInfo = null;
    refreshUpdateUI();
    flash("Version notifications disabled", "success");
  }
});

/* =============================================================================
   CHANGELOG MODAL  (universal — owned by shell)
============================================================================= */

const changelogModal = new Modal(changelogBackdrop, {
  onOpen: () => loadChangelog(),
  onClosed: () => {
    // Reset collapse state: expand the first block, collapse the rest
    const body = document.getElementById("changelogBody");
    if (body) {
      body
        .querySelectorAll<HTMLElement>(".changelog-version-block")
        .forEach((block, i) => {
          const btn = block.querySelector<HTMLElement>(".changelog-toggle-btn");
          block.classList.toggle("collapsed", i > 0);
          btn?.classList.toggle("rotated", i > 0);
        });
    }
  },
});

function openChangelog(): void {
  changelogModal.open();
}

function closeChangelog(): void {
  changelogModal.close();
}

changelogBack.addEventListener("click", () => {
  closeChangelog();
  aboutModal.open();
});
changelogClose.addEventListener("click", closeChangelog);

async function loadChangelog(): Promise<void> {
  if (changelogLoaded) return;
  const body = document.getElementById("changelogBody")!;
  try {
    const res = await fetch("CHANGELOG.json");
    const versions = await res.json();
    body.innerHTML = "";

    type ToolMap = Record<string, string | string[]>;
    versions.forEach(
      (
        v: {
          version: string;
          date: string;
          changes: {
            features: ToolMap;
            improvements: ToolMap;
            bugfixes: ToolMap;
          };
        },
        index: number,
      ) => {
        const block = document.createElement("div");
        block.className = "changelog-version-block";

        const versionHeader = document.createElement("div");
        versionHeader.className = "changelog-version-header";

        const vNum = document.createElement("span");
        vNum.className = "changelog-version-number";
        vNum.textContent = `v${v.version}`;

        const vDate = document.createElement("span");
        vDate.className = "changelog-version-date";
        vDate.textContent = v.date;

        const toggleBtn = document.createElement("button");
        toggleBtn.className = "changelog-toggle-btn";
        toggleBtn.setAttribute("aria-label", "Toggle version details");
        toggleBtn.innerHTML = `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

        const contentWrapper = document.createElement("div");
        contentWrapper.className = "changelog-version-content";

        versionHeader.appendChild(vNum);
        versionHeader.appendChild(vDate);
        versionHeader.appendChild(toggleBtn);
        block.appendChild(versionHeader);

        versionHeader.addEventListener("click", () => {
          const isCollapsed = block.classList.contains("collapsed");

          if (isCollapsed) {
            // Expanding: measure actual content height and animate to it
            block.classList.remove("collapsed");
            toggleBtn.classList.remove("rotated");
            // scrollHeight is only valid after the class change removes max-height:0
            const fullHeight = contentWrapper.scrollHeight;
            contentWrapper.style.maxHeight = `${fullHeight}px`;
            // After the max-height transition completes, clear inline style so
            // content stays fluid. Filter to max-height — opacity also fires transitionend.
            const onDone = (ev: TransitionEvent) => {
              if (ev.propertyName !== "max-height") return;
              contentWrapper.style.maxHeight = "";
              contentWrapper.removeEventListener("transitionend", onDone);
            };
            contentWrapper.addEventListener("transitionend", onDone);
            setTimeout(() => {
              const changelogBody = document.getElementById("changelogBody");
              if (changelogBody) {
                changelogBody.scrollTo({
                  top: block.offsetTop - changelogBody.offsetTop,
                  behavior: "smooth",
                });
              }
            }, 350);
          } else {
            // Collapsing: pin current height first so the browser has a start
            // value to transition from, then animate to 0 on the next frame
            contentWrapper.style.maxHeight = `${contentWrapper.scrollHeight}px`;
            requestAnimationFrame(() => {
              block.classList.add("collapsed");
              toggleBtn.classList.add("rotated");
            });
          }
        });

        // Only the latest release (index 0) starts expanded
        if (index > 0) {
          block.classList.add("collapsed");
          toggleBtn.classList.add("rotated");
        }

        const categories: { key: keyof typeof v.changes; label: string }[] = [
          { key: "features", label: "Features" },
          { key: "improvements", label: "Improvements" },
          { key: "bugfixes", label: "Bug Fixes" },
        ];

        categories.forEach(({ key, label }) => {
          const toolMap = v.changes[key];
          if (!toolMap || Object.keys(toolMap).length === 0) return;

          const cat = document.createElement("div");
          cat.className = `changelog-category ${key}`;

          const catHeader = document.createElement("div");
          catHeader.className = `changelog-category-header ${key}`;
          catHeader.textContent = label;
          cat.appendChild(catHeader);

          Object.entries(toolMap).forEach(([toolName, entries]) => {
            const toolGroup = document.createElement("div");
            toolGroup.className = "changelog-tool-group";

            const toolLabel = document.createElement("div");
            toolLabel.className = "changelog-tool-label";
            toolLabel.textContent = toolName;
            toolGroup.appendChild(toolLabel);

            const lines = Array.isArray(entries) ? entries : [entries];
            lines.forEach((text: string) => {
              const item = document.createElement("div");
              item.className = "changelog-item";
              item.textContent = text;
              toolGroup.appendChild(item);
            });

            cat.appendChild(toolGroup);
          });

          contentWrapper.appendChild(cat);
        });

        block.appendChild(contentWrapper);
        body.appendChild(block);
      },
    );

    changelogLoaded = true;
  } catch (err) {
    devError("Changelog load failed:", err);
    body.innerHTML = `<p class="changelog-loading">Failed to load changelog.</p>`;
  }
}

/* =============================================================================
   LICENSING & ATTRIBUTIONS MODAL
============================================================================= */

const licensingModal = new Modal(licensingBackdrop);

function openLicensing(tab = "license"): void {
  activeTab = tab;
  document.querySelectorAll<HTMLElement>(".licensing-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  });
  licensingModal.open();
  loadLicensingTab(tab);
}

function closeLicensing(): void {
  licensingModal.close();
}

licensingBack.addEventListener("click", () => {
  closeLicensing();
  aboutModal.open();
});
licensingClose.addEventListener("click", closeLicensing);

// Internal doc link delegation — routes [LICENSE](LICENSE) etc. to their modals
document.getElementById("licensingBody")!.addEventListener("click", (e) => {
  const anchor = (e.target as HTMLElement).closest<HTMLAnchorElement>(
    "a.md-internal-link",
  );
  if (!anchor) return;
  e.preventDefault();
  const doc = anchor.dataset.doc!;
  if (doc === "LICENSE") {
    // Navigate to the full license: close Licensing, remember it as the return.
    const tab = activeTab;
    closeLicensing();
    fullLicenseReturn = () => openLicensing(tab);
    openFullLicense();
  } else {
    // LICENSING.md / ATTRIBUTION.md / THIRD_PARTY swap the tab in place; README.md
    // opens its own modal.
    INTERNAL_DOC_LINKS[doc]?.();
  }
});

document.getElementById("readmeBody")!.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;

  // Screenshots — README wraps each <img class="md-img"> in a real
  // <a href="./screenshots/…" target="_blank"> so GitHub's renderer can
  // still open the full-size file in a browser tab. That relative path only
  // resolves to a real, externally-reachable URL in dev (Vite's dev server);
  // in a packaged build the page origin is Tauri's internal asset protocol,
  // which the OS's default browser can't load. So in-app we intercept the
  // click before that default navigation fires and show it in our own
  // lightbox instead — same behaviour in dev and prod, and the markdown
  // source is untouched so GitHub is unaffected.
  //
  // Match against the wrapping <a> too, not just the <img> itself: the
  // whitespace/indentation between "<a>" and "<img>" in the markdown source
  // becomes real text nodes inside the anchor, so a click that lands in that
  // sliver has e.target resolve to the <a> (or its text), not the <img> —
  // and img.md-img alone would miss it, letting the native target="_blank"
  // navigation slip through uncontested.
  const img =
    target.closest<HTMLImageElement>("img.md-img") ??
    target
      .closest<HTMLAnchorElement>("a")
      ?.querySelector<HTMLImageElement>("img.md-img") ??
    null;
  if (img) {
    e.preventDefault();
    openImageLightbox(img);
    return;
  }

  const anchor = target.closest<HTMLAnchorElement>("a.md-internal-link");
  if (!anchor) return;
  e.preventDefault();
  const doc = anchor.dataset.doc!;
  if (!INTERNAL_DOC_LINKS[doc]) return;
  // Navigation model: close README, open the target. For the full license,
  // remember README as the return so its back arrow comes back here.
  closeReadme();
  if (doc === "LICENSE") fullLicenseReturn = () => openReadme();
  INTERNAL_DOC_LINKS[doc]();
});

// Tab switching
document.querySelectorAll<HTMLElement>(".licensing-tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    const tab = btn.dataset.tab!;
    activeTab = tab;
    document.querySelectorAll<HTMLElement>(".licensing-tab").forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === tab);
    });
    loadLicensingTab(tab);
  });
});

async function loadLicensingTab(tab: string): Promise<void> {
  const body = document.getElementById("licensingBody")!;

  // Restore from cache if already loaded
  if (licensingTabCache[tab] !== undefined) {
    body.innerHTML = licensingTabCache[tab];
    body.scrollTop = 0;
    if (tab === "license") rewireLicenseBtn(body);
    return;
  }

  body.innerHTML = `<p class="changelog-loading">Loading...</p>`;

  const urls: Record<string, string> = {
    license: "/LICENSING.md",
    attribution: "/ATTRIBUTION.md",
    thirdparty: "/THIRD_PARTY_LICENSES.md",
  };

  try {
    const res = await fetch(urls[tab]);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const html = renderMarkdown(text);
    licensingTabCache[tab] = html;
    body.innerHTML = html;
    if (tab === "license") rewireLicenseBtn(body);
  } catch {
    body.innerHTML = `<p class="changelog-loading">Could not load file.</p>`;
  }

  body.scrollTop = 0;
}

/** Appends the "View Full License Text" button and wires it. */
function rewireLicenseBtn(body: HTMLElement): void {
  // Remove any stale button first
  body.querySelector(".full-license-btn")?.remove();
  const btn = document.createElement("button");
  btn.className = "modal-cancel-btn full-license-btn";
  btn.textContent = "View Full License Text (GNU AGPL v3)";
  btn.addEventListener("click", () => {
    const tab = activeTab;
    closeLicensing();
    fullLicenseReturn = () => openLicensing(tab);
    openFullLicense();
  });
  body.appendChild(btn);
}

/* =============================================================================
   FULL LICENSE SUB-MODAL
============================================================================= */

const fullLicenseModal = new Modal(fullLicenseBackdrop, {
  onOpen: () => loadFullLicense(),
});

function openFullLicense(): void {
  fullLicenseModal.open();
}

function closeFullLicense(): void {
  fullLicenseModal.close();
}

fullLicenseBack.addEventListener("click", () => {
  const ret = fullLicenseReturn;
  fullLicenseReturn = null;
  closeFullLicense();
  ret?.(); // reopen whichever modal led here (README or Licensing)
});
fullLicenseClose.addEventListener("click", () => {
  fullLicenseReturn = null; // X dismisses entirely — no return
  closeFullLicense();
});

async function loadFullLicense(): Promise<void> {
  if (fullLicenseLoaded) return;
  const body = document.getElementById("fullLicenseBody")!;
  try {
    const res = await fetch("/LICENSE");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const pre = document.createElement("pre");
    pre.className = "full-license-text";
    pre.textContent = text;
    body.innerHTML = "";
    body.appendChild(pre);
    fullLicenseLoaded = true;
  } catch {
    body.innerHTML = `<p class="changelog-loading">Could not load LICENSE file.</p>`;
  }
}

/* =============================================================================
   README MODAL
============================================================================= */

const readmeModal = new Modal(readmeBackdrop, {
  onOpen: () => loadReadme(),
});

function openReadme(): void {
  readmeModal.open();
}

function closeReadme(): void {
  readmeModal.close();
}

readmeBack.addEventListener("click", () => {
  closeReadme();
  aboutModal.open();
});
readmeClose.addEventListener("click", closeReadme);

async function loadReadme(): Promise<void> {
  if (readmeLoaded) return;
  const body = document.getElementById("readmeBody")!;
  try {
    const res = await fetch("/README.md");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    body.innerHTML = renderMarkdown(text);
    readmeLoaded = true;
  } catch {
    body.innerHTML = `<p class="changelog-loading">Could not load README.md.</p>`;
  }
}

/* =============================================================================
   SECURITY POLICY & CONTRIBUTING MODALS
   -----------------------------------------------------------------------------
   Plain single-document modals: fetch the markdown once, render it, and let
   internal doc links route onward. They're independent Modal instances rather
   than extra tabs on the Licensing modal because neither is a licensing
   document, and an independent modal can grow its own behaviour later without
   adding cases to a shared one.

   Both files are copied into public/ by copy-public-docs.mjs, same as
   README.md — a doc that isn't in that script's FILES_TO_COPY list will 404
   here at runtime.
============================================================================= */

/** Fetches a markdown doc from public/ and renders it into `body`.
 *  Returns true on success so the caller can latch its "already loaded" flag
 *  and skip re-fetching on subsequent opens (a failed load stays retryable). */
async function loadMarkdownDoc(
  body: HTMLElement,
  url: string,
  label: string,
): Promise<boolean> {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    body.innerHTML = renderMarkdown(text);
    return true;
  } catch {
    body.innerHTML = `<p class="changelog-loading">Could not load ${escapeHtml(label)}.</p>`;
    return false;
  }
}

/** Routes [LICENSE](LICENSE)-style links inside a simple doc modal: close this
 *  modal, open the target, and make the full-license back arrow return here. */
function wireDocLinks(
  bodyId: string,
  closeSelf: () => void,
  reopenSelf: () => void,
): void {
  document.getElementById(bodyId)!.addEventListener("click", (e) => {
    const anchor = (e.target as HTMLElement).closest<HTMLAnchorElement>(
      "a.md-internal-link",
    );
    if (!anchor) return;
    e.preventDefault();
    const doc = anchor.dataset.doc!;
    if (!INTERNAL_DOC_LINKS[doc]) return;
    closeSelf();
    if (doc === "LICENSE") fullLicenseReturn = reopenSelf;
    INTERNAL_DOC_LINKS[doc]();
  });
}

/* ── Security Policy ─────────────────────────────────────────────────────── */

const securityModal = new Modal(securityBackdrop, {
  onOpen: () => loadSecurity(),
});

function openSecurity(): void {
  securityModal.open();
}

function closeSecurity(): void {
  securityModal.close();
}

securityBack.addEventListener("click", () => {
  closeSecurity();
  aboutModal.open();
});
securityClose.addEventListener("click", closeSecurity);

async function loadSecurity(): Promise<void> {
  if (securityLoaded) return;
  const body = document.getElementById("securityBody")!;
  securityLoaded = await loadMarkdownDoc(body, "/SECURITY.md", "SECURITY.md");
}

wireDocLinks("securityBody", closeSecurity, openSecurity);

/* ── Contributing ────────────────────────────────────────────────────────── */

const contributingModal = new Modal(contributingBackdrop, {
  onOpen: () => loadContributing(),
});

function openContributing(): void {
  contributingModal.open();
}

function closeContributing(): void {
  contributingModal.close();
}

contributingBack.addEventListener("click", () => {
  closeContributing();
  aboutModal.open();
});
contributingClose.addEventListener("click", closeContributing);

async function loadContributing(): Promise<void> {
  if (contributingLoaded) return;
  const body = document.getElementById("contributingBody")!;
  contributingLoaded = await loadMarkdownDoc(
    body,
    "/CONTRIBUTING.md",
    "CONTRIBUTING.md",
  );
}

wireDocLinks("contributingBody", closeContributing, openContributing);

/* =============================================================================
   README IMAGE LIGHTBOX
   -----------------------------------------------------------------------------
   Full-size view of a clicked README screenshot. Replaces README (rather than
   stacking over it) so the shared overlay doesn't flicker between the two.
============================================================================= */

const imageLightboxModal = new Modal(imageLightboxBackdrop, {
  replaceModal: readmeModal,
  // Covers every close path (X, Escape, and the back-arrow's own close
  // call) in one place, rather than clearing it per-button.
  onClosed: () => {
    lightboxSourceImg = null;
  },
});

function openImageLightbox(img: HTMLImageElement): void {
  lightboxSourceImg = img;
  imageLightboxImg.src = img.src;
  imageLightboxTitle.textContent = img.alt || "Screenshot";
  // No title attribute set here — the mouseenter listener below decides
  // on each hover whether the text is actually truncated right now.
  imageLightboxTitle.removeAttribute("title");
  imageLightboxModal.open();
}

// Native tooltip only when the header text is actually ellipsis-truncated.
// Checked on hover (not at open time) since scrollWidth/clientWidth aren't
// meaningful until the modal has been laid out and is visible.
imageLightboxTitle.addEventListener("mouseenter", () => {
  const truncated =
    imageLightboxTitle.scrollWidth > imageLightboxTitle.clientWidth;
  if (truncated) {
    imageLightboxTitle.title = imageLightboxTitle.textContent ?? "";
  } else {
    imageLightboxTitle.removeAttribute("title");
  }
});

function closeImageLightbox(): void {
  imageLightboxModal.close();
}

imageLightboxClose.addEventListener("click", () => {
  // X dismisses entirely — no return to README, matching the Full License
  // modal's close-button convention.
  closeImageLightbox();
});

imageLightboxBack.addEventListener("click", () => {
  const source = lightboxSourceImg;
  closeImageLightbox();
  openReadme();
  // Modal.open() resets the README body's scrollTop to 0 inside its own
  // double-rAF open sequence (see modal.ts). Chaining our own double rAF
  // here queues this scroll strictly after that reset settles, instead of
  // racing it.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      source?.scrollIntoView({ block: "center" });
    });
  });
});

/* =============================================================================
   MARKDOWN RENDERER  (headings, bold/italic, links, inline code, code blocks,
                       tables, blockquotes, unordered lists, HRs)
============================================================================= */

/** Internal doc filenames that should open a modal instead of the browser. */
const INTERNAL_DOC_LINKS: Record<string, () => void> = {
  "LICENSING.md": () => openLicensing("license"),
  LICENSE: () => openFullLicense(),
  "ATTRIBUTION.md": () => openLicensing("attribution"),
  "THIRD_PARTY_LICENSES.md": () => openLicensing("thirdparty"),
  "README.md": () => openReadme(),
  "SECURITY.md": () => openSecurity(),
  "CONTRIBUTING.md": () => openContributing(),
};

function renderMarkdown(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let inTable = false;
  let tableHeaderDone = false;
  let inCodeBlock = false;
  let codeLines: string[] = [];

  // Void elements never carry a closing tag, so a line that opens one of
  // these is always "complete" on its own — no block-mode needed.
  const VOID_TAGS = new Set([
    "img",
    "br",
    "hr",
    "input",
    "meta",
    "link",
    "area",
    "base",
    "col",
    "embed",
    "source",
    "track",
    "wbr",
  ]);
  // Non-void tags worth treating as raw HTML blocks. An allowlist (rather
  // than "any word that looks like a tag") avoids misfiring on Markdown's
  // own <https://example.com> angle-bracket autolink syntax, where "https"
  // would otherwise parse as a plausible-looking tag name.
  const HTML_BLOCK_TAGS = new Set([
    "p",
    "div",
    "span",
    "a",
    "table",
    "thead",
    "tbody",
    "tr",
    "td",
    "th",
    "figure",
    "figcaption",
    "picture",
    "video",
    "details",
    "summary",
    "center",
    "blockquote",
    "ul",
    "ol",
    "li",
    "pre",
    "code",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "sub",
    "sup",
    "kbd",
    "samp",
  ]);
  let inHtmlBlock = false;
  let htmlBlockTag = "";
  let htmlBlockDepth = 0;
  let htmlLines: string[] = [];

  const inlineFormat = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      // Images — must run BEFORE the link rule below, since [alt](src) would
      // otherwise match the link pattern too and leave a stray "!" behind.
      .replace(
        /!\[([^\]]*)\]\(([^)]+)\)/g,
        (_match, alt: string, src: string) =>
          `<img src="${src}" alt="${alt}" class="md-img" loading="lazy">`,
      )
      .replace(
        /\[([^\]]+)\]\(([^)]+)\)/g,
        (_match, label: string, href: string) => {
          // Route internal doc links to their modal; everything else opens in browser
          if (INTERNAL_DOC_LINKS[href]) {
            return `<a href="#" class="md-internal-link" data-doc="${href}">${label}</a>`;
          }
          return `<a href="${href}" target="_blank">${label}</a>`;
        },
      );

  for (const raw of lines) {
    const line = raw.trimEnd();

    // Fenced code block
    if (line.startsWith("```")) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeLines = [];
      } else {
        const escaped = codeLines
          .join("\n")
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
        out.push(`<div class="md-code-block"><code>${escaped}</code></div>`);
        inCodeBlock = false;
        codeLines = [];
      }
      continue;
    }
    if (inCodeBlock) {
      codeLines.push(raw);
      continue;
    }

    // Already inside a raw HTML block — collect verbatim (no escaping, no
    // markdown processing) until this tag's depth returns to zero. Depth
    // tracking (rather than "first closing tag wins") lets the same tag
    // legitimately nest inside itself, e.g. <div><div>...</div></div>.
    if (inHtmlBlock) {
      htmlLines.push(raw);
      const openRe = new RegExp(`<${htmlBlockTag}(?:\\s[^>]*)?>`, "gi");
      const closeRe = new RegExp(`</${htmlBlockTag}>`, "gi");
      const opens = (line.match(openRe) || []).length;
      const closes = (line.match(closeRe) || []).length;
      htmlBlockDepth += opens - closes;
      if (htmlBlockDepth <= 0) {
        out.push(htmlLines.join("\n"));
        inHtmlBlock = false;
        htmlLines = [];
      }
      continue;
    }

    // Start of a raw HTML block — README.md is a trusted local file we
    // already innerHTML the rest of, so passthrough here isn't a new
    // trust boundary. Markdown syntax is NOT processed inside these blocks
    // (matches standard Markdown behaviour) — use HTML tags throughout.
    const htmlOpenMatch = line.match(/^<([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/);
    if (htmlOpenMatch) {
      const tag = htmlOpenMatch[1].toLowerCase();
      if (!VOID_TAGS.has(tag) && !HTML_BLOCK_TAGS.has(tag)) {
        // Not a recognized tag (e.g. a <https://...> autolink) — fall
        // through to normal inline/paragraph handling below.
      } else {
        const closesOnSameLine = new RegExp(`</${tag}>\\s*$`, "i").test(line);
        if (VOID_TAGS.has(tag) || closesOnSameLine) {
          // Complete on this single line — pass through raw as-is.
          out.push(line);
        } else {
          inHtmlBlock = true;
          htmlBlockTag = tag;
          htmlBlockDepth = 1;
          htmlLines = [raw];
        }
        continue;
      }
    }

    // Headings
    const hMatch = line.match(/^(#{1,4})\s+(.*)/);
    if (hMatch) {
      const level = hMatch[1].length;
      out.push(
        `<h${level} class="md-h${level}">${inlineFormat(hMatch[2])}</h${level}>`,
      );
      continue;
    }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) {
      out.push("<hr class='md-hr'>");
      continue;
    }

    // Table rows
    if (line.startsWith("|")) {
      if (!inTable) {
        inTable = true;
        tableHeaderDone = false;
        out.push("<table class='md-table'>");
      }
      if (/^\|[\s|:-]+\|$/.test(line)) {
        tableHeaderDone = true;
        continue;
      }
      const cells = line
        .split("|")
        .slice(1, -1)
        .map((c) => inlineFormat(c.trim()));
      const tag = tableHeaderDone ? "td" : "th";
      out.push(
        `<tr>${cells.map((c) => `<${tag}>${c}</${tag}>`).join("")}</tr>`,
      );
      continue;
    } else if (inTable) {
      out.push("</table>");
      inTable = false;
      tableHeaderDone = false;
    }

    // Blockquote
    if (line.startsWith("> ")) {
      out.push(
        `<blockquote class="md-blockquote">${inlineFormat(line.slice(2))}</blockquote>`,
      );
      continue;
    }

    // Unordered list item
    const ulMatch = line.match(/^[-*]\s+(.*)/);
    if (ulMatch) {
      out.push(`<li class="md-li">${inlineFormat(ulMatch[1])}</li>`);
      continue;
    }

    // Empty line — emit a sentinel we'll collapse later
    if (line.trim() === "") {
      out.push("<!--blank-->");
      continue;
    }

    // Paragraph
    out.push(`<p class="md-p">${inlineFormat(line)}</p>`);
  }

  if (inTable) out.push("</table>");
  // Safety net: an unclosed HTML block (malformed README) shouldn't silently
  // swallow the rest of the document — flush whatever was collected as-is.
  if (inHtmlBlock) out.push(htmlLines.join("\n"));

  // Collapse runs of blank sentinels into a single small spacer
  return out
    .join("\n")
    .replace(/(<!--blank-->\n?)+/g, '<div class="md-gap"></div>\n');
}

/* =============================================================================
   LICENSE AGREEMENT MODAL  (first-launch / new-version gate)
============================================================================= */

const licenseAgreementModal = new Modal(licenseAgreementBackdrop, {
  closeOnBackdrop: false,
  closeOnEsc: false,
});

async function openLicenseAgreement(): Promise<void> {
  // Lock buttons until user scrolls to bottom
  _setLicenseButtonsLocked(true);
  licenseAgreementModal.open();
  await loadLicenseAgreementText();
}

function closeLicenseAgreement(): void {
  licenseAgreementModal.close();
}

function _setLicenseButtonsLocked(locked: boolean): void {
  const footer = licenseAgreementBackdrop.querySelector<HTMLElement>(
    ".license-agreement-footer",
  );
  if (!footer) return;
  footer.classList.toggle("license-footer-locked", locked);
  licenseAcceptBtn.toggleAttribute("disabled", locked);
  licenseDeclineBtn.toggleAttribute("disabled", locked);
}

async function loadLicenseAgreementText(): Promise<void> {
  const body = document.getElementById("licenseAgreementBody")!;
  try {
    const res = await fetch("LICENSE");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const pre = document.createElement("pre");
    pre.className = "full-license-text";
    pre.textContent = text;
    body.innerHTML = "";
    body.appendChild(pre);
  } catch {
    body.innerHTML = `<p class="changelog-loading">Could not load LICENSE file.</p>`;
    // Can't scroll a short error message — unlock immediately
    _setLicenseButtonsLocked(false);
    return;
  }

  // Unlock buttons once user has scrolled to (or near) the bottom
  const onScroll = () => {
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 8;
    if (atBottom) {
      _setLicenseButtonsLocked(false);
      body.removeEventListener("scroll", onScroll);
    }
  };
  body.addEventListener("scroll", onScroll);
  // Also check immediately in case content is short enough to not need scrolling
  requestAnimationFrame(() => {
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 8;
    if (atBottom) {
      _setLicenseButtonsLocked(false);
      body.removeEventListener("scroll", onScroll);
    }
  });
}

// Resolve callback set by runStartupGates so the accept handler can signal it
let _licenseAcceptedResolve: (() => void) | null = null;

licenseAcceptBtn.addEventListener("click", async () => {
  localStorage.setItem(LICENSE_ACCEPTED_KEY, LICENSE_VERSION);
  closeLicenseAgreement();
  // Signal runStartupGates that acceptance is done and flag is written
  _licenseAcceptedResolve?.();
  _licenseAcceptedResolve = null;
});

licenseDeclineBtn.addEventListener("click", () => {
  quitApp();
});

/* =============================================================================
   STARTUP GATES — license agreement + auto-changelog
   Auto-changelog fires after license is resolved.
============================================================================= */

/** Runs first-launch and version-change gates in sequence after the window is visible.
 *  1. App lock — shown if enabled; user must enter correct PIN/password to proceed.
 *  2. License agreement — shown if never accepted or if LICENSE_VERSION changed.
 *     Decline quits the app; accept writes the accepted version to localStorage.
 *  3. Auto-changelog — opens automatically when the app version has changed
 *     since the last launch. Stores the seen version in localStorage. */
async function runStartupGates(appVersion: string): Promise<void> {
  // Gate 1: App lock — verify before anything else is visible
  if (settings.appLock) {
    const hasHash = await invoke<boolean>("lock_is_set").catch(() => false);
    if (hasHash) {
      await showLockScreen();
    }
  }

  const needsLicense =
    localStorage.getItem(LICENSE_ACCEPTED_KEY) !== LICENSE_VERSION;

  if (needsLicense) {
    // Wait for the user to explicitly accept (decline closes the window)
    await new Promise<void>((resolve) => {
      _licenseAcceptedResolve = resolve;
      openLicenseAgreement();
    });
    // Small delay so the license modal finishes its close transition first
    await new Promise<void>((resolve) => setTimeout(resolve, 400));
  }

  const seenVersion = localStorage.getItem(CHANGELOG_SEEN_KEY);
  if (seenVersion !== appVersion) {
    localStorage.setItem(CHANGELOG_SEEN_KEY, appVersion);
    openChangelog();
  }
}

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
async function quitApp(): Promise<void> {
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
   MODAL KEYBOARD / DRAG / POSITION-RESET
   These are now owned by modal.ts (the Modal primitive):
     • Escape closes the top-most open modal (shared open-stack)
     • header drag + reset-to-centre on close
   Nothing to wire here.
============================================================================= */

/* =============================================================================
   APP LOCK SCREEN
   -----------------------------------------------------------------------------
   The lock screen is a full-window overlay shown at startup if appLock is on.
   It is NOT a Modal — no Escape, no drag, no close. It is removed only when
   the correct credential is verified by Rust (Argon2id).

   PIN flow: numpad buttons build a string; auto-submits after 4 digits.
   Password flow: input + submit button; Enter key also submits.

   A resolve callback (_lockResolve) lets runStartupGates await correct entry.
============================================================================= */

let _lockResolve: (() => void) | null = null;
let _pinBuffer = "";
const PIN_LENGTH = 4;

/** Shows the lock screen and returns a Promise that resolves when unlocked.
 *  If the lock screen is already visible (pre-shown in init before window.show()),
 *  just attaches the resolve callback without re-initializing the view. */
function showLockScreen(): Promise<void> {
  return new Promise<void>((resolve) => {
    _lockResolve = resolve;

    // If already visible (pre-shown in init), just wire the resolve and focus
    if (lockScreen.style.display === "flex") {
      requestAnimationFrame(() => {
        if (settings.lockCredentialType === "password") {
          lockPasswordInput.focus();
        }
      });
      return;
    }

    // Render the correct variant based on saved setting
    if (settings.lockCredentialType === "pin") {
      lockPinView.style.display = "";
      lockPasswordView.style.display = "none";
      buildPinDots(0);
      _pinBuffer = "";
      lockPinError.textContent = "";
    } else {
      lockPinView.style.display = "none";
      lockPasswordView.style.display = "";
      lockPasswordInput.value = "";
      lockPasswordError.textContent = "";
    }

    lockScreen.style.display = "flex";
    requestAnimationFrame(() => {
      if (settings.lockCredentialType === "password") {
        lockPasswordInput.focus();
      }
    });
  });
}

/** Fades and removes the lock screen, then resolves the startup gate.
 *  Uses setTimeout matching the CSS transition duration (0.3s) — same pattern
 *  as modal.ts close() — to avoid early teardown from child transitionend events. */
function dismissLockScreen(): void {
  lockScreen.classList.add("lock-fading");
  setTimeout(() => {
    lockScreen.style.display = "none";
    lockScreen.classList.remove("lock-fading");
    _lockResolve?.();
    _lockResolve = null;
  }, 300);
}

/** Rebuilds the PIN dot indicators for the given fill count. */
function buildPinDots(filled: number, error = false): void {
  lockDots.innerHTML = "";
  for (let i = 0; i < PIN_LENGTH; i++) {
    const dot = document.createElement("div");
    dot.className =
      "lock-dot" + (i < filled ? (error ? " error" : " filled") : "");
    lockDots.appendChild(dot);
  }
}

/** Flashes the dots red on wrong PIN, then resets. Uses toast for the message. */
function pinErrorFlash(): void {
  buildPinDots(PIN_LENGTH, true);
  flash("Incorrect PIN", "error");
  setTimeout(() => {
    _pinBuffer = "";
    buildPinDots(0);
  }, 700);
}

/** Submits the current PIN buffer for verification. */
async function submitPin(): Promise<void> {
  if (_pinBuffer.length !== PIN_LENGTH) return;
  try {
    const ok = await invoke<boolean>("verify_lock", { credential: _pinBuffer });
    if (ok) {
      dismissLockScreen();
    } else {
      pinErrorFlash();
    }
  } catch {
    pinErrorFlash();
  }
}

/** Submits the password input for verification. */
async function submitPassword(): Promise<void> {
  const val = lockPasswordInput.value;
  if (!val) return;
  try {
    const ok = await invoke<boolean>("verify_lock", { credential: val });
    if (ok) {
      dismissLockScreen();
    } else {
      flash("Incorrect password", "error");
      lockPasswordInput.classList.add("lock-input-error");
      lockPasswordInput.value = "";
      setTimeout(() => {
        lockPasswordInput.classList.remove("lock-input-error");
      }, 1200);
    }
  } catch {
    flash("Verification error", "error");
  }
}

// PIN numpad interaction
lockNumpad.addEventListener("click", async (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(
    "[data-digit]",
  );
  if (!btn || _pinBuffer.length >= PIN_LENGTH) return;
  _pinBuffer += btn.dataset.digit!;
  buildPinDots(_pinBuffer.length);
  if (_pinBuffer.length === PIN_LENGTH) {
    // Small delay so user sees all dots fill before the async verify fires
    await new Promise<void>((r) => setTimeout(r, 80));
    await submitPin();
  }
});

lockBackspace.addEventListener("click", () => {
  if (_pinBuffer.length > 0) {
    _pinBuffer = _pinBuffer.slice(0, -1);
    buildPinDots(_pinBuffer.length);
  }
});

// Allow physical keyboard for PIN
document.addEventListener("keydown", (e) => {
  if (lockScreen.style.display === "none" || lockScreen.style.display === "")
    return;
  if (settings.lockCredentialType !== "pin") return;
  if (e.key >= "0" && e.key <= "9" && _pinBuffer.length < PIN_LENGTH) {
    _pinBuffer += e.key;
    buildPinDots(_pinBuffer.length);
    if (_pinBuffer.length === PIN_LENGTH) {
      submitPin();
    }
  }
  if (e.key === "Backspace" && _pinBuffer.length > 0) {
    _pinBuffer = _pinBuffer.slice(0, -1);
    buildPinDots(_pinBuffer.length);
  }
});

// Show/hide password toggle — our own button; browser's native reveal is suppressed via CSS
lockShowPassword.addEventListener("click", () => {
  const isHidden = lockPasswordInput.type === "password";
  lockPasswordInput.type = isHidden ? "text" : "password";
  const eyeIcon = document.getElementById("lockEyeIcon")!;
  eyeIcon.innerHTML = isHidden
    ? `<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
       <line x1="1" y1="1" x2="23" y2="23" />`
    : `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
       <circle cx="12" cy="12" r="3" />`;
});

lockSubmitBtn.addEventListener("click", submitPassword);
lockPasswordInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") submitPassword();
});

// Exit app from the lock screen
lockExitBtn.addEventListener("click", quitApp);
lockExitBtnPw.addEventListener("click", quitApp);

/* =============================================================================
   SECURITY SETTINGS  (App Lock)
============================================================================= */

/** Updates the Security subsettings UI to match current settings. */
function applyLockSettings(): void {
  appLockToggle.checked = settings.appLock;
  appLockLabel.textContent = settings.appLock ? "On" : "Off";
  lockSubsettings.style.maxHeight = settings.appLock ? "200px" : "0";
}

// Enable/disable app lock toggle
appLockToggle.addEventListener("change", async () => {
  if (appLockToggle.checked) {
    // Turning ON: open set-credential flow first; only enable if saved
    appLockToggle.checked = false; // revert visually until credential is saved
    settingsModal.close();
    const saved = await openSetLockModal("enable");
    if (!saved) {
      // User cancelled — leave lock off
      settingsModal.open();
      return;
    }
    settings.appLock = true;
    await saveSettings();
    applyLockSettings();
    settingsModal.open();
    flash("App lock enabled", "success");
  } else {
    // Turning OFF
    settings.appLock = false;
    try {
      await invoke("clear_lock_hash");
    } catch {
      /* non-critical */
    }
    await saveSettings();
    applyLockSettings();
    flash("App lock disabled", "success");
  }
});

lockChangeBtn.addEventListener("click", async () => {
  settingsModal.close();
  await openSetLockModal("change");
  settingsModal.open();
});

lockRemoveBtn.addEventListener("click", async () => {
  settings.appLock = false;
  try {
    await invoke("clear_lock_hash");
  } catch {
    /* non-critical */
  }
  await saveSettings();
  applyLockSettings();
  flash("App lock removed", "success");
});

/* =============================================================================
   SET / CHANGE CREDENTIAL MODAL
============================================================================= */

const setLockModal = new Modal(setLockBackdrop, {
  closeOnEsc: false, // don't allow escape during the set-lock flow
});

/** Resets a set-lock eye icon SVG back to the visible-eye (password hidden) state. */
function _resetSetLockEye(iconId: string): void {
  const el = document.getElementById(iconId);
  if (!el) return;
  el.innerHTML = `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />`;
}

/** Wires a show/hide toggle button to its paired password input. */
function _wireSetLockShowBtn(
  btn: HTMLElement,
  input: HTMLInputElement,
  iconId: string,
): void {
  btn.addEventListener("click", () => {
    const hidden = input.type === "password";
    input.type = hidden ? "text" : "password";
    const icon = document.getElementById(iconId)!;
    icon.innerHTML = hidden
      ? `<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
         <line x1="1" y1="1" x2="23" y2="23" />`
      : `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
         <circle cx="12" cy="12" r="3" />`;
  });
}

// Wire the set-lock modal show/hide buttons once at startup (they persist across openings)
_wireSetLockShowBtn(setLockShowInput, setLockInput, "setLockInputEye");
_wireSetLockShowBtn(setLockShowConfirm, setLockConfirm, "setLockConfirmEye");

/** Configures the set-lock modal inputs for the currently selected type.
 *  Called whenever the user switches type inside the modal picker. */
function _applySetLockType(
  isPin: boolean,
  prevKeydownHandler?: (e: KeyboardEvent) => void,
): (e: KeyboardEvent) => void {
  // Remove old handler if re-configuring
  if (prevKeydownHandler) {
    setLockInput.removeEventListener("keydown", prevKeydownHandler);
    setLockConfirm.removeEventListener("keydown", prevKeydownHandler);
  }

  setLockPickPin.classList.toggle("active", isPin);
  setLockPickPassword.classList.toggle("active", !isPin);

  setLockHint.textContent = isPin
    ? `Enter a ${PIN_LENGTH}-digit PIN`
    : "Enter a password (case sensitive)";
  setLockInput.placeholder = isPin ? "PIN" : "New password";
  setLockInput.type = "password";
  setLockInput.value = "";
  setLockInput.maxLength = isPin ? PIN_LENGTH : 128;
  setLockInput.inputMode = isPin ? "numeric" : "text";
  setLockInput.pattern = isPin ? "[0-9]*" : "";

  setLockConfirm.placeholder = isPin ? "Confirm PIN" : "Confirm password";
  setLockConfirm.type = "password";
  setLockConfirm.value = "";
  setLockConfirm.maxLength = isPin ? PIN_LENGTH : 128;
  setLockConfirm.inputMode = isPin ? "numeric" : "text";
  setLockConfirm.pattern = isPin ? "[0-9]*" : "";

  // Always show reveal buttons — useful for both PIN and password to verify entry
  setLockShowInput.style.display = "";
  setLockShowConfirm.style.display = "";
  _resetSetLockEye("setLockInputEye");
  _resetSetLockEye("setLockConfirmEye");

  setLockError.textContent = "";
  setLockInput.classList.remove("input-error");
  setLockConfirm.classList.remove("input-error");

  // Digit-only filter for PIN
  const onKeydown = (e: KeyboardEvent) => {
    if (!isPin) return;
    const allowed = [
      "Backspace",
      "Delete",
      "Tab",
      "ArrowLeft",
      "ArrowRight",
      "Enter",
    ];
    if (!allowed.includes(e.key) && !/^\d$/.test(e.key)) e.preventDefault();
  };
  setLockInput.addEventListener("keydown", onKeydown);
  setLockConfirm.addEventListener("keydown", onKeydown);

  return onKeydown;
}

/** Opens the set-credential modal.
 *  Includes a PIN/Password picker so the user can choose before entering.
 *  On cancel, both the credential type and the stored hash revert to unchanged.
 *  Returns a promise that resolves to true if the user saved, false if cancelled. */
function openSetLockModal(mode: "enable" | "change"): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    // Snapshot state so cancel can restore it
    const prevCredType = settings.lockCredentialType;

    // Working type for the modal — user can switch before saving
    let modalType: "pin" | "password" = settings.lockCredentialType;

    setLockTitle.textContent =
      mode === "enable" ? "Set App Lock" : "Change Credential";

    let currentKeydownHandler = _applySetLockType(modalType === "pin");

    // Type picker buttons inside the modal
    const onPickPin = () => {
      if (modalType === "pin") return;
      modalType = "pin";
      currentKeydownHandler = _applySetLockType(true, currentKeydownHandler);
      setLockInput.focus();
    };
    const onPickPassword = () => {
      if (modalType === "password") return;
      modalType = "password";
      currentKeydownHandler = _applySetLockType(false, currentKeydownHandler);
      setLockInput.focus();
    };
    setLockPickPin.addEventListener("click", onPickPin);
    setLockPickPassword.addEventListener("click", onPickPassword);

    let _resolved = false;
    function done(saved: boolean): void {
      if (_resolved) return;
      _resolved = true;
      setLockInput.removeEventListener("keydown", currentKeydownHandler);
      setLockConfirm.removeEventListener("keydown", currentKeydownHandler);
      setLockPickPin.removeEventListener("click", onPickPin);
      setLockPickPassword.removeEventListener("click", onPickPassword);
      setLockModal.close();

      if (saved) {
        // Commit the type the user chose inside the modal
        settings.lockCredentialType = modalType;
        // Sync the settings panel type buttons
        applyLockSettings();
        saveSettings();
      } else {
        // Restore the type that was set before the modal opened
        settings.lockCredentialType = prevCredType;
        applyLockSettings();
      }

      resolve(saved);
    }

    const onSave = async () => {
      const isPin = modalType === "pin";
      const val = setLockInput.value;
      const confirm = setLockConfirm.value;

      if (isPin && val.length !== PIN_LENGTH) {
        flash(`PIN must be exactly ${PIN_LENGTH} digits`, "error");
        return;
      }
      if (!isPin && val.length < 1) {
        flash("Password cannot be empty", "error");
        return;
      }
      if (val !== confirm) {
        flash(`${isPin ? "PINs" : "Passwords"} don't match`, "error");
        return;
      }

      try {
        await invoke("save_lock_hash", { credential: val });
        const label = isPin ? "PIN" : "Password";
        done(true);
        flash(`${label} ${mode === "enable" ? "set" : "updated"}`, "success");
      } catch {
        flash("Failed to save credential", "error");
      }
    };

    setLockSaveBtn.onclick = onSave;
    setLockCancelBtn.onclick = () => done(false);
    setLockBack.onclick = () => done(false);
    setLockClose.onclick = () => done(false);

    // Enter in confirm field saves
    const onConfirmEnter = (e: KeyboardEvent) => {
      if (e.key === "Enter") onSave();
    };
    setLockConfirm.addEventListener("keydown", onConfirmEnter);

    setLockModal.open();
    requestAnimationFrame(() => setLockInput.focus());
  });
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

  // If the saved theme is "custom", seed _activeCustomId from the first theme
  // (or whichever is stored) and re-apply now that customThemes is loaded.
  if (settings.theme === "custom") {
    refreshCustomThemeSelect();
    if (_activeCustomId) applyCustomThemeById(_activeCustomId);
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
        _pinBuffer = "";
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
