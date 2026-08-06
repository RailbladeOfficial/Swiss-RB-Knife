/* =============================================================================
   CYCLE THEME  — "Cycle" theme mode: sequential/random rotation through the
   built-in (and optionally custom) themes, plus real-world Holiday Overrides.
   -----------------------------------------------------------------------------
   Owns everything about Cycle mode: which theme is currently showing
   (settings.cycleCurrentThemeId), advancing that pointer (click/everything/
   time triggers), applying whatever it resolves to (a built-in theme name or
   a saved custom theme id) directly onto :root/themeLink, and the Holiday
   Override date math.

   Split out the same way random-theme.ts is split out of shell.ts: this file
   is one more node in the existing theme-core.ts <-> theme-editor.ts <->
   random-theme.ts circular-import graph (see theme-core.ts's header comment)
   — imported bindings here are only ever used inside functions/handlers that
   run after the whole module graph has finished loading, never at this
   file's own top-level evaluation time, so the cycle is safe.
============================================================================= */

import { settings, saveSettings, THEME_GROUPS } from "./shell";
import { themeLink } from "./theme-core";
import { clearRandomPalette, PERSISTENT_RANDOM_KEY } from "./random-theme";
import { applyCustomThemeById, clearCustomTheme, customThemes } from "./theme-editor";

/* -----------------------------------------------------------------------------
   Holiday Override date math
   -----------------------------------------------------------------------------
   Each Holiday-tab theme maps to a real-world date window — two possible
   windows, actually: a tight one (the exact traditional date) and a wide one
   (the whole traditional season), switched by settings.cycleHolidayFullSeason
   ("Full Holiday Season"). Mardi Gras is the one exception to the fixed-date
   windows below — Fat Tuesday moves every year — so it's derived from Easter
   (Meeus/Jones/Butcher Gregorian algorithm) rather than a fixed month/day.
----------------------------------------------------------------------------- */

type HolidayWindow = { startMonth: number; startDay: number; endMonth: number; endDay: number };

const HOLIDAY_WINDOWS_TIGHT: Record<string, HolidayWindow> = {
  valentine: { startMonth: 2, startDay: 14, endMonth: 2, endDay: 14 }, // Valentine's Day
  rainbow: { startMonth: 6, startDay: 1, endMonth: 6, endDay: 30 }, // Pride Month
  patriot: { startMonth: 7, startDay: 4, endMonth: 7, endDay: 4 }, // Independence Day
  halloween: { startMonth: 10, startDay: 31, endMonth: 10, endDay: 31 }, // Halloween
  christmas: { startMonth: 12, startDay: 24, endMonth: 12, endDay: 26 }, // Christmas
};

const HOLIDAY_WINDOWS_WIDE: Record<string, HolidayWindow> = {
  valentine: { startMonth: 2, startDay: 7, endMonth: 2, endDay: 14 }, // week of Valentine's Day
  rainbow: { startMonth: 6, startDay: 1, endMonth: 6, endDay: 30 }, // Pride Month (same either way)
  patriot: { startMonth: 6, startDay: 28, endMonth: 7, endDay: 4 }, // Independence Day week
  halloween: { startMonth: 10, startDay: 1, endMonth: 10, endDay: 31 }, // all of October
  christmas: { startMonth: 12, startDay: 1, endMonth: 12, endDay: 26 }, // all of December through the 26th
};

/** Whether `now`'s month/day falls within [start, end] (inclusive), where the
 *  range is expressed as month*100+day so e.g. Jun 28 (628) – Jul 4 (704)
 *  compares correctly across the month boundary. */
function isWithinMonthDayRange(now: Date, win: HolidayWindow): boolean {
  const val = (now.getMonth() + 1) * 100 + now.getDate();
  const startVal = win.startMonth * 100 + win.startDay;
  const endVal = win.endMonth * 100 + win.endDay;
  return val >= startVal && val <= endVal;
}

function computeEasterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

function computeMardiGras(year: number): Date {
  const fatTuesday = computeEasterSunday(year);
  fatTuesday.setDate(fatTuesday.getDate() - 47);
  return fatTuesday;
}

/** Tight: just Fat Tuesday itself. Wide ("Full Holiday Season"): the whole
 *  Carnival season, Epiphany (Jan 6) through Fat Tuesday. */
function isMardiGrasActive(now: Date): boolean {
  const mg = computeMardiGras(now.getFullYear());
  if (!settings.cycleHolidayFullSeason) {
    return now.getMonth() === mg.getMonth() && now.getDate() === mg.getDate();
  }
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const seasonStart = new Date(now.getFullYear(), 0, 6);
  const seasonEnd = new Date(mg.getFullYear(), mg.getMonth(), mg.getDate());
  return today >= seasonStart && today <= seasonEnd;
}

/** US Thanksgiving: the 4th Thursday of November — moves every year, so
 *  (like Mardi Gras) it's computed rather than a fixed month/day. */
function computeThanksgiving(year: number): Date {
  const nov1 = new Date(year, 10, 1);
  const THURSDAY = 4;
  const firstThursday = 1 + ((THURSDAY - nov1.getDay() + 7) % 7);
  return new Date(year, 10, firstThursday + 21);
}

/** Tight: just Thanksgiving Day itself. Wide ("Full Holiday Season"): the
 *  whole harvest season, Nov 1 through Thanksgiving Day. */
function isThanksgivingActive(now: Date): boolean {
  const tg = computeThanksgiving(now.getFullYear());
  if (!settings.cycleHolidayFullSeason) {
    return now.getMonth() === tg.getMonth() && now.getDate() === tg.getDate();
  }
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const seasonStart = new Date(now.getFullYear(), 10, 1);
  const seasonEnd = new Date(tg.getFullYear(), tg.getMonth(), tg.getDate());
  return today >= seasonStart && today <= seasonEnd;
}

function isHolidayActive(themeId: string, now: Date): boolean {
  if (themeId === "mardi-gras") return isMardiGrasActive(now);
  if (themeId === "thanksgiving") return isThanksgivingActive(now);
  const windows = settings.cycleHolidayFullSeason ? HOLIDAY_WINDOWS_WIDE : HOLIDAY_WINDOWS_TIGHT;
  const win = windows[themeId];
  return win ? isWithinMonthDayRange(now, win) : false;
}

/** Returns the Holiday-tab theme id active right now, if any — checked in
 *  THEME_GROUPS' holiday-tab order (no two windows above overlap, so order
 *  only matters as a tiebreaker that never actually gets exercised). */
function getActiveHolidayThemeId(now: Date = new Date()): string | null {
  const holidayThemes = THEME_GROUPS.find((g) => g.tab === "holiday")?.themes ?? [];
  for (const t of holidayThemes) {
    if (isHolidayActive(t.id, now)) return t.id;
  }
  return null;
}

/* -----------------------------------------------------------------------------
   Cycle pool + pointer advancement
----------------------------------------------------------------------------- */

/** The ordered set of theme ids Cycle rotates through: every built-in
 *  Main/Holiday/Special theme (Holiday themes excluded when Holiday Override
 *  + "Holiday-Only Themes" are both on), plus saved Custom themes if opted in. */
function buildCyclePool(): string[] {
  const holidayIds = new Set(
    (THEME_GROUPS.find((g) => g.tab === "holiday")?.themes ?? []).map((t) => t.id),
  );
  const excludeHolidays = settings.cycleHolidayOverride && settings.cycleHolidayExclusive;
  const builtins = THEME_GROUPS.flatMap((g) => g.themes)
    .filter((t) => !(excludeHolidays && holidayIds.has(t.id)))
    .map((t) => t.id);
  const customs = settings.cycleIncludeCustom ? customThemes.map((t) => t.id) : [];
  const pool = [...builtins, ...customs];
  return pool.length > 0 ? pool : ["default"];
}

/** What Cycle mode should be showing right now: a live Holiday Override wins
 *  outright regardless of pool membership; otherwise the persisted pool
 *  pointer, falling back to the pool's first entry if that pointer no longer
 *  exists (pool composition changed, or its custom theme got deleted). */
function resolveActiveCycleThemeId(): string {
  if (settings.cycleHolidayOverride) {
    const holidayId = getActiveHolidayThemeId();
    if (holidayId) return holidayId;
  }
  const pool = buildCyclePool();
  if (settings.cycleCurrentThemeId && pool.includes(settings.cycleCurrentThemeId)) {
    return settings.cycleCurrentThemeId;
  }
  return pool[0]!;
}

function pickNextInPool(pool: string[], current: string): string {
  if (pool.length === 0) return "default";
  if (settings.cycleOrder === "random") {
    if (pool.length === 1) return pool[0]!;
    let next = current;
    while (next === current) next = pool[Math.floor(Math.random() * pool.length)]!;
    return next;
  }
  const idx = pool.indexOf(current);
  return pool[(idx + 1) % pool.length]!;
}

/** Applies a specific theme id — a built-in theme name (loads its CSS) or a
 *  saved custom theme's id — directly onto themeLink/:root, independent of
 *  settings.theme. Mirrors theme-core.ts's standard/custom branches exactly
 *  (same "call sync + set onload" idiom) since Cycle needs to apply an
 *  arbitrary underlying theme without ever setting settings.theme away from
 *  "cycle". */
function applyUnderlyingTheme(themeId: string): void {
  const isCustom = customThemes.some((t) => t.id === themeId);
  if (isCustom) {
    themeLink.href = "/themes/default.css";
    themeLink.onload = () => {
      applyCustomThemeById(themeId);
      window.dispatchEvent(new CustomEvent("themechange"));
    };
    applyCustomThemeById(themeId);
    window.dispatchEvent(new CustomEvent("themechange"));
    return;
  }
  localStorage.removeItem(PERSISTENT_RANDOM_KEY);
  themeLink.href = `/themes/${themeId}.css`;
  themeLink.onload = () => {
    clearRandomPalette();
    clearCustomTheme();
    window.dispatchEvent(new CustomEvent("themechange"));
  };
  clearRandomPalette();
  clearCustomTheme();
}

// Tracks what's actually been painted, so theme-core.ts's seasonal-effect
// wiring can ask "which real theme is Cycle showing" and so repeated
// applySettings() calls (Settings modal reopen, etc.) don't needlessly
// re-fetch/re-apply the same CSS file.
let _lastAppliedCycleThemeId: string | null = null;

function applyResolvedCycleTheme(force = false): void {
  const resolved = resolveActiveCycleThemeId();
  if (!force && resolved === _lastAppliedCycleThemeId) return;
  _lastAppliedCycleThemeId = resolved;
  applyUnderlyingTheme(resolved);
}

/** Which real theme id Cycle mode is currently displaying — used by
 *  theme-core.ts to decide whether to run a seasonal canvas effect (Cycle's
 *  own settings.theme value, "cycle", never matches christmas/halloween/halo,
 *  so the seasonal-effect switch needs the actual underlying id instead). */
export function getCurrentCycleUnderlyingThemeId(): string {
  return _lastAppliedCycleThemeId ?? resolveActiveCycleThemeId();
}

function advanceCyclePointer(): void {
  const pool = buildCyclePool();
  const current =
    settings.cycleCurrentThemeId && pool.includes(settings.cycleCurrentThemeId)
      ? settings.cycleCurrentThemeId
      : pool[0]!;
  settings.cycleCurrentThemeId = pickNextInPool(pool, current);
  settings.cycleLastAdvance = Date.now();
  saveSettings();
  applyResolvedCycleTheme(true);
}

/** "Cycle Now" button — always allowed while Cycle is the active theme,
 *  regardless of the configured trigger mode. */
export function advanceCycleNow(): void {
  if (settings.theme !== "cycle") return;
  advanceCyclePointer();
}

/* -----------------------------------------------------------------------------
   "Time" trigger — schedules the next advance instead of reacting to
   interaction. Anchored on settings.cycleLastAdvance (persisted), so the
   countdown survives closing and reopening the app: on (re)schedule, elapsed
   time since the last advance is subtracted from the interval, and if that's
   already past due, one catch-up advance fires immediately rather than
   several back-to-back.
----------------------------------------------------------------------------- */

const UNIT_MS: Record<string, number> = {
  seconds: 1000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
};

function cycleIntervalMs(): number {
  const amount = Math.max(1, settings.cycleIntervalAmount || 1);
  return amount * (UNIT_MS[settings.cycleIntervalUnit] ?? UNIT_MS.hours!);
}

let _cycleTimerHandle: number | null = null;

function clearCycleTimer(): void {
  if (_cycleTimerHandle !== null) {
    window.clearTimeout(_cycleTimerHandle);
    _cycleTimerHandle = null;
  }
}

function rescheduleCycleTimer(): void {
  clearCycleTimer();
  if (settings.theme !== "cycle" || settings.cycleTrigger !== "time") return;
  if (!settings.cycleLastAdvance) {
    settings.cycleLastAdvance = Date.now();
    saveSettings();
  }
  const remaining = cycleIntervalMs() - (Date.now() - settings.cycleLastAdvance);
  if (remaining <= 0) {
    advanceCyclePointer();
    rescheduleCycleTimer();
    return;
  }
  _cycleTimerHandle = window.setTimeout(() => {
    advanceCyclePointer();
    rescheduleCycleTimer();
  }, remaining);
}

/* -----------------------------------------------------------------------------
   Holiday-boundary recheck — a periodic re-resolve so a Holiday Override
   engages/disengages at the right moment even if the app is left open across
   a date boundary (e.g. open at 11:50pm Dec 23rd, still open past midnight).
   Self-cancels the moment Cycle/Holiday-Override stops being relevant, so
   nothing needs to explicitly stop it when the user switches away.
----------------------------------------------------------------------------- */

const HOLIDAY_CHECK_INTERVAL_MS = 15 * 60 * 1000;
let _holidayCheckHandle: number | null = null;

function ensureHolidayCheckInterval(): void {
  if (settings.theme !== "cycle" || !settings.cycleHolidayOverride) return;
  if (_holidayCheckHandle !== null) return;
  _holidayCheckHandle = window.setInterval(() => {
    if (settings.theme !== "cycle" || !settings.cycleHolidayOverride) {
      window.clearInterval(_holidayCheckHandle!);
      _holidayCheckHandle = null;
      return;
    }
    applyResolvedCycleTheme();
  }, HOLIDAY_CHECK_INTERVAL_MS);
}

// Whether this session has already had its one shot at an "onStartup"
// advance — set on the very first activateCycleTheme() call regardless of
// trigger, so switching the dropdown to "On Startup" mid-session never
// retroactively fires a surprise advance; only a real app-launch activation
// (settings.cycleTrigger already "onStartup" when the app first applies
// settings) gets the bonus advance.
let _cycleActivatedOnce = false;

/** Single entry point theme-core.ts's applyTheme("cycle") dispatches to:
 *  resolves + (re)paints whatever Cycle should be showing right now, and
 *  (re)arms the time-trigger timer and holiday-boundary check. Safe to call
 *  repeatedly (Settings modal reopen, any cycle-setting change) — each piece
 *  is independently idempotent, except the one-time "onStartup" advance
 *  below. */
export function activateCycleTheme(): void {
  const isFirstActivation = !_cycleActivatedOnce;
  _cycleActivatedOnce = true;
  if (isFirstActivation && settings.cycleTrigger === "onStartup") {
    advanceCyclePointer();
  } else {
    applyResolvedCycleTheme(true);
  }
  rescheduleCycleTimer();
  ensureHolidayCheckInterval();
}

/* -----------------------------------------------------------------------------
   Interaction-driven triggers — two independent trigger modes, each with its
   own listener(s):

     "click"      — mousedown anywhere (not just buttons): fires the instant
                    the mouse goes down rather than waiting for the full
                    click, so it feels snappier. The simplest of the two.
     "everything" — mirrors random-theme.ts's Regenerative reactivity exactly:
                    button clicks, Enter/Escape commits inside a field, and
                    checkbox/radio/select changes (capture phase, same
                    debounce window, same close/dismiss exclusions).

   Both exclude the Cycle settings pane itself so adjusting its own controls
   never counts as an advance.
----------------------------------------------------------------------------- */

const CYCLE_INTERACTION_EXCLUDE =
  "#themePickerCyclePane, .modal-close-btn, [data-modal-close], .nav-back-btn, .modal-cancel-btn";

let _lastCycleInteractionAdvance = 0;

/** Shared debounce + guard for every interaction-trigger listener below. */
function tryAdvanceFromInteraction(): void {
  if (settings.theme !== "cycle") return;
  const now = Date.now();
  if (now - _lastCycleInteractionAdvance < 80) return;
  _lastCycleInteractionAdvance = now;
  advanceCyclePointer();
}

// "click" trigger.
document.addEventListener(
  "mousedown",
  (e) => {
    if (settings.cycleTrigger !== "click") return;
    const target = e.target as HTMLElement | null;
    if (target?.closest(CYCLE_INTERACTION_EXCLUDE)) return;
    tryAdvanceFromInteraction();
  },
  true,
);

// "everything" trigger — button clicks.
document.addEventListener(
  "click",
  (e) => {
    if (settings.cycleTrigger !== "everything") return;
    const btn = (e.target as HTMLElement | null)?.closest("button");
    if (!btn || btn.closest(CYCLE_INTERACTION_EXCLUDE)) return;
    tryAdvanceFromInteraction();
  },
  true,
);

// "everything" trigger — Enter/Escape field commits.
document.addEventListener(
  "keydown",
  (e) => {
    if (settings.cycleTrigger !== "everything") return;
    if (e.key !== "Enter" && e.key !== "Escape") return;
    const target = e.target as HTMLElement | null;
    if (!target || !target.matches("input, textarea, select")) return;
    if (target.closest("#themePickerCyclePane")) return;
    tryAdvanceFromInteraction();
  },
  true,
);

// "everything" trigger — checkbox/radio/select changes.
document.addEventListener(
  "change",
  (e) => {
    if (settings.cycleTrigger !== "everything") return;
    const el = e.target as HTMLElement | null;
    if (!el || !el.matches('input[type="checkbox"], input[type="radio"], select')) return;
    if (el.closest("#themePickerCyclePane")) return;
    tryAdvanceFromInteraction();
  },
  true,
);
