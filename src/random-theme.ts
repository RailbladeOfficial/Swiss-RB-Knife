/* =============================================================================
   RANDOM THEME: palette generation + live "Regenerative" reactivity
   -----------------------------------------------------------------------------
   Owns the Random theme's two palette generators (Harmonized/Chaotic), the
   :root CSS-var application + injected modal-override stylesheet, and the
   app-wide click/keydown/change listeners that drive Regenerative re-rolls.

   Split out of shell.ts (Tier 6). Pure and mostly self-contained. Its only
   external dependency is `settings` from shell.ts (to check the active theme
   mode). theme-core.ts and theme-editor.ts both import from this file; this
   file does not import from either of them.
============================================================================= */

import { settings } from "./settings-store";

export const RANDOM_VARS = [
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
  "--color-accent",
  "--color-btn-text",
  "--color-danger",
  "--color-danger-subtle",
  "--color-success",
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
  // Budget chart palette, 8 distinct colors for pie/bar segments
  "--color-chart-1",
  "--color-chart-2",
  "--color-chart-3",
  "--color-chart-4",
  "--color-chart-5",
  "--color-chart-6",
  "--color-chart-7",
  "--color-chart-8",
] as const;

export const PERSISTENT_RANDOM_KEY = "shell-persistent-random-palette";

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

export function generateRandomPalette(): Record<string, string> {
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
  // The bright highlight accent (active tabs, section titles, slider values):
  // a same-hue shade of the button colour (lighter on dark themes, darker on
  // light themes) mirroring how the static themes relate --color-accent to
  // --color-btn (e.g. default #60a5fa vs #2563eb; light #1e40af vs #3b82f6).
  const accent = isDark
    ? hslToHex(accentHue, rInt(70, 95), rInt(62, 74))
    : hslToHex(accentHue, rInt(70, 95), rInt(28, 40));
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
    "--color-accent": accent,
    "--color-btn-text": btnText,
    "--color-danger": danger,
    "--color-danger-subtle": dangerSub,
    "--color-success": tSBord,
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

export function generateChaoticPalette(): Record<string, string> {
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
    "--color-accent": rHex(),
    "--color-btn-text": rHex(),
    "--color-danger": rHex(),
    "--color-danger-subtle": rHex(),
    "--color-success": rHex(),
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
export function applyPalette(palette: Record<string, string>): void {
  const root = document.documentElement;
  for (const [key, value] of Object.entries(palette)) {
    root.style.setProperty(key, value);
  }
  // Notify tools that theme colors have changed so they can redraw anything
  // that reads CSS vars at draw time (e.g. budget chart canvases).
  window.dispatchEvent(new CustomEvent("themechange"));
}

/** Removes all inline random palette properties from :root. Call when switching
 *  away from the random theme. */
export function clearRandomPalette(): void {
  const root = document.documentElement;
  (RANDOM_VARS as readonly string[]).forEach((v) =>
    root.style.removeProperty(v),
  );
}

// Coalesces compound triggers so one user action re-rolls at most once: a click
// that also opens a modal fires both the global click listener and modal.ts's
// open hook microseconds apart, and a button that also changes view stacks a
// third. Anything inside this window collapses to a single roll; genuinely
// separate interactions are always further apart than this.
let _lastRegen = 0;

/** Regenerates the palette when (and only when) Regenerative random is active.
 *  The single choke point for every re-roll trigger (modal opens, view changes,
 *  button presses, input commits), so it stays a no-op in every other mode. */
export function maybeRegenerateRandom(): void {
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
   In Regenerative mode the palette should feel alive, re-rolling not just on
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
    // Only a commit/discard inside a field, never a modal-closing Escape.
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
