/* =============================================================================
   THEME EDITOR  — custom theme creation/editing modal + storage
   -----------------------------------------------------------------------------
   Owns the Theme Editor modal (color pickers, gradients, glow controls, live
   preview), custom theme storage (load/save/generate-id), and the delete
   confirmation flow.

   Split out of shell.ts (Tier 6). Genuinely two-way coupled with
   theme-core.ts: this file calls applyTheme() (e.g. reverting a live preview),
   and theme-core.ts calls applyCustomThemeById()/clearCustomTheme() (applying
   a stored custom theme). Standard ES module circular import — both
   directions are plain function references only invoked from event
   handlers/later calls, never at module top-level, so load order is never
   actually a problem.
============================================================================= */

import { invoke } from "@tauri-apps/api/core";
import { Modal } from "./modal";
import {
  settings,
  flash,
  applySettings,
  saveSettings,
  themePickerModal,
  reopenThemePickerOnCustomTab,
  themeSelect,
  type AdvancedOptions,
  type CustomTheme,
} from "./shell";
import { RANDOM_VARS, clearRandomPalette } from "./random-theme";
import { applyTheme, themeLink, themeCssUrl, getActiveCustomId, setActiveCustomId } from "./theme-core";

/* ── Element refs ────────────────────────────────────────────────────────── */

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

/* ── State ───────────────────────────────────────────────────────────────── */

export let customThemes: CustomTheme[] = [];
let _teMode: "create" | "edit" = "create";
let _teEditId: string | null = null; // id of the theme being edited (edit mode)
let _tePrevTheme: string = "default"; // settings.theme value before editor opened
let _teWorkingVars: Record<string, string> = {}; // live working copy of vars in editor
let _teWorkingAdv: AdvancedOptions = {}; // live working copy of advanced options

/** Generates a simple unique ID for new custom themes. */
export function genThemeId(): string {
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
export async function saveCustomThemes(): Promise<void> {
  try {
    await invoke("save_custom_themes", { data: JSON.stringify(customThemes) });
  } catch {
    flash("Failed to save custom themes", "error");
  }
}

/** Loads custom themes from disk on startup. */
export async function loadCustomThemes(): Promise<void> {
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
 *  overrides (gradients, glows) on top of the CSS var values. These are injected
 *  after the theme <link> in the cascade, so they win on source order without
 *  !important now that the base layer (default.css) is variable-driven and
 *  carries no !important of its own. */
function applyCustomThemeStyles(theme: CustomTheme): void {
  const adv = theme.advanced;

  // Build the advanced overrides.
  const rules: string[] = [];

  // Header gradient / title colour
  if (adv.headerGradient) {
    const { colorA, colorB, angle } = adv.headerGradient;
    rules.push(`.tool-view-header, .section-header {
      background: linear-gradient(${angle}deg, ${colorA}, ${colorB});
    }`);
  }

  // Header glow (box-shadow on the header element)
  if (adv.headerGlow) {
    const { opacity, spread } = GLOW_INTENSITY[adv.headerGlow.intensity];
    const glow = hexToRgba(adv.headerGlow.color, opacity);
    rules.push(`.tool-view-header, .section-header {
      box-shadow: 0 0 ${spread}px ${glow};
    }`);
  }

  // Body background gradient
  if (adv.bodyGradient) {
    const { colorA, colorB, angle } = adv.bodyGradient;
    rules.push(`body {
      background: linear-gradient(${angle}deg, ${colorA}, ${colorB}) fixed;
    }`);
  }

  // Modal glow
  if (adv.modalGlow) {
    const { opacity, spread } = GLOW_INTENSITY[adv.modalGlow.intensity];
    const glow = hexToRgba(adv.modalGlow.color, opacity);
    rules.push(`body.solid-modals .modal, body:not(.solid-modals) .modal {
      box-shadow: 0 0 ${spread}px ${glow}, 0 24px 48px rgba(0,0,0,0.6);
    }`);
  }

  // Panel glow
  if (adv.panelGlow) {
    const { opacity, spread } = GLOW_INTENSITY[adv.panelGlow.intensity];
    const glow = hexToRgba(adv.panelGlow.color, opacity);
    rules.push(`.panel {
      box-shadow: 0 0 ${spread}px ${glow};
    }`);
  }

  // Button glow
  if (adv.buttonGlow) {
    const { opacity, spread } = GLOW_INTENSITY[adv.buttonGlow.intensity];
    const glow = hexToRgba(adv.buttonGlow.color, opacity);
    rules.push(`button {
      box-shadow: 0 0 ${spread}px ${glow};
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
export function clearCustomTheme(): void {
  clearRandomPalette(); // reuses the same RANDOM_VARS list
  document.getElementById("custom-theme-adv-styles")?.remove();
}

/** Applies a custom theme by id: sets CSS vars on :root and injects advanced styles. */
export function applyCustomThemeById(id: string): void {
  const theme = customThemes.find((t) => t.id === id);
  if (!theme) return;
  setActiveCustomId(id);
  const root = document.documentElement;
  for (const [key, value] of Object.entries(theme.vars)) {
    root.style.setProperty(key, value);
  }
  // --color-accent (the bright highlight for active tabs/titles/slider values)
  // isn't a custom-editor swatch. Derive it from --color-btn so custom themes —
  // including ones saved before this var existed — get a sensible highlight
  // without an extra picker. Only set if the theme didn't explicitly provide one.
  if (!theme.vars["--color-accent"]) {
    const btn = theme.vars["--color-btn"];
    if (btn) root.style.setProperty("--color-accent", deriveAccent(btn));
  }
  applyCustomThemeStyles(theme);
}

/** Lightens (or, for very light buttons, darkens) a hex colour to serve as the
 *  highlight accent, mirroring how the built-in themes relate --color-accent to
 *  --color-btn. Pure fallback for custom themes with no explicit accent. */
function deriveAccent(hex: string): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m || !m[1]) return hex;
  const n = parseInt(m[1], 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  // Dark button → lighten toward white; light button → darken toward black.
  const t = lum < 0.6 ? 0.4 : -0.35;
  const adj = (c: number) => Math.max(0, Math.min(255, Math.round(t >= 0 ? c + (255 - c) * t : c * (1 + t))));
  r = adj(r); g = adj(g); b = adj(b);
  return "#" + [r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("");
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
      // Cancel / Escape / X / back — revert the preview and return to Choose
      // Theme (this modal is only ever reached from there now).
      teRevertPreview();
      reopenThemePickerOnCustomTab();
    }
    _teSaveCompleted = false;
  },
});

/** Opens the theme editor. mode = "create" seeds from the currently active
 *  theme; mode = "edit" loads the specific custom theme by id. */
export function openThemeEditor(mode: "create", id?: undefined): void;
export function openThemeEditor(mode: "edit", id: string): void;
export function openThemeEditor(mode: "create" | "edit", id?: string): void {
  _teMode = mode;
  _teEditId = id ?? null;
  _tePrevTheme = settings.theme;

  // Always open on the General tab
  teActivateTab("general");

  if (mode === "create") {
    themeEditorTitle.textContent = "Create Custom Theme";
    teNameInput.value = "";
    // Seed from whatever's currently rendered (the active theme's colours)
    _teWorkingVars = readCurrentVars();
    _teWorkingAdv = {};
    tePopulateSwatches(_teWorkingVars);
    tePopulateAdvanced({});
  } else {
    themeEditorTitle.textContent = "Edit Custom Theme";
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
      themeLink.href = themeCssUrl(val);
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

// Theme editor tab switching. Scoped to #themeEditorModal because .setup-tab
// is now shared across Budget/Time Tracker/Theme Editor — an unscoped query
// would toggle every tool's tabs at once.
function teActivateTab(tab: "general" | "advanced"): void {
  document.querySelectorAll<HTMLElement>("#themeEditorModal .setup-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.teTab === tab);
  });
  const general = document.getElementById("teTabGeneral")!;
  const advanced = document.getElementById("teTabAdvanced")!;
  general.style.display = tab === "general" ? "" : "none";
  advanced.style.display = tab === "advanced" ? "" : "none";
}

document.querySelectorAll<HTMLElement>("#themeEditorModal .setup-tab").forEach((btn) => {
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
    setActiveCustomId(newTheme.id);
    await saveCustomThemes();
    // Create → becomes the active theme
    settings.theme = "custom";
    themeSelect.value = "custom";
    applySettings();
    await saveSettings();
    _teSaveCompleted = true;
    themeEditorModal.close();
    reopenThemePickerOnCustomTab();
    flash(`Theme "${name}" created`, "success");
  } else {
    const theme = customThemes.find((t) => t.id === _teEditId)!;
    theme.name = name;
    theme.vars = { ..._teWorkingVars };
    theme.advanced = { ..._teWorkingAdv };
    await saveCustomThemes();
    // Edit → revert to previously active theme (user must choose it themselves)
    teRevertPreview();
    _teSaveCompleted = true;
    themeEditorModal.close();
    reopenThemePickerOnCustomTab();
    flash(`Theme "${name}" saved`, "success");
  }
});

// ── Custom theme delete confirm modal ───────────────────────────────────────
// Reached from a delete icon on a theme tile in the Choose Theme modal (see
// requestDeleteCustomTheme, exported below) — there's no dropdown anymore to
// read a selection from, so the pending id is tracked here instead.

let _pendingCustomThemeDeleteId: string | null = null;

const customThemeDeleteModal = new Modal(customThemeDeleteBackdrop, {
  onClosed: () => { _pendingCustomThemeDeleteId = null; },
});

/** Opens the delete-confirm modal for a specific custom theme. Called from
 *  the Choose Theme modal's per-tile delete icon (shell.ts). */
export function requestDeleteCustomTheme(id: string): void {
  const theme = customThemes.find((t) => t.id === id);
  if (!theme) return;
  _pendingCustomThemeDeleteId = id;
  customThemeDeleteMsg.textContent = `Are you sure you want to delete "${theme.name}"? This cannot be undone.`;
  themePickerModal.close();
  customThemeDeleteModal.open();
}

customThemeDeleteBack.addEventListener("click", () => {
  customThemeDeleteModal.close();
  reopenThemePickerOnCustomTab();
});
customThemeDeleteCancelBtn.addEventListener("click", () => {
  customThemeDeleteModal.close();
  reopenThemePickerOnCustomTab();
});

customThemeDeleteConfirmBtn.addEventListener("click", async () => {
  const id = _pendingCustomThemeDeleteId;
  const theme = id ? customThemes.find((t) => t.id === id) : undefined;
  if (!id || !theme) {
    customThemeDeleteModal.close();
    reopenThemePickerOnCustomTab();
    return;
  }
  const wasActive = settings.theme === "custom" && getActiveCustomId() === id;
  customThemes = customThemes.filter((t) => t.id !== id);
  await saveCustomThemes();
  customThemeDeleteModal.close();
  if (wasActive) {
    // Deleted the active theme — revert to default
    settings.theme = "default";
    setActiveCustomId(null);
    themeSelect.value = "default";
    applySettings();
    await saveSettings();
  }
  reopenThemePickerOnCustomTab();
  flash(`Theme "${theme.name}" deleted`, "success");
});
