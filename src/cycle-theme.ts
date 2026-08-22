/* =============================================================================
   CYCLE THEME: "Cycle" theme mode: sequential/random rotation through the
   built-in (and optionally custom) themes, a two-theme Day/Night schedule,
   plus real-world Holiday Overrides.
   -----------------------------------------------------------------------------
   Owns everything about Cycle mode: which theme is currently showing
   (settings.cycleCurrentThemeId), advancing that pointer (click/everything/
   time triggers), applying whatever it resolves to (a built-in theme name or
   a saved custom theme id) directly onto :root/themeLink, and the Holiday
   Override date math.

   Two shapes of Cycle live here, and they meet only in
   resolveActiveCycleThemeId():

     POOL modes ("click" / "everything" / "time" / "onStartup") walk a pointer
       through a set of themes. Order, Include Custom Themes and Restrict to
       Holiday Season all shape that pool.
     DAY/NIGHT mode ("dayNight") ignores the pool entirely and picks between
       exactly two configured themes based on the wall clock. Nothing advances;
       the answer is a pure function of the current time, so there is no pointer
       to persist and no catch-up to do after the app has been closed.

   Holiday Overrides sit above both: a live override wins outright either way.

   Split out the same way random-theme.ts is split out of shell.ts: this file
   is one more node in the existing theme-core.ts <-> theme-editor.ts <->
   random-theme.ts circular-import graph (see theme-core.ts's header comment)
:   imported bindings here are only ever used inside functions/handlers that
   run after the whole module graph has finished loading, never at this
   file's own top-level evaluation time, so the cycle is safe.
============================================================================= */

import { saveSettings } from "./shell";
import { settings } from "./settings-store";
import { resolveThemeId, themeLink, themeCssUrl } from "./theme-core";
import { BASE_THEME_ID, DEFAULT_THEME_ID, THEME_GROUPS } from "./theme-ids";
import { clearRandomPalette, PERSISTENT_RANDOM_KEY } from "./random-theme";
import { applyCustomThemeById, clearCustomTheme, customThemes } from "./theme-editor";

/* -----------------------------------------------------------------------------
   Holiday Override date math
   -----------------------------------------------------------------------------
   Each Holiday-tab theme maps to a real-world date window. Two possible
   windows, actually: a tight one (the exact traditional date) and a wide one
   (the whole traditional season), switched by settings.cycleHolidayFullSeason
   ("Full Holiday Season"). Mardi Gras is the one exception to the fixed-date
   windows below (Fat Tuesday moves every year) so it's derived from Easter
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

/** US Thanksgiving: the 4th Thursday of November, moves every year, so
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

/** Returns the Holiday-tab theme id active right now, if any, checked in
 *  THEME_GROUPS' holiday-tab order (no two windows above overlap, so order
 *  only matters as a tiebreaker that never actually gets exercised). */
function getActiveHolidayThemeId(now: Date = new Date()): string | null {
  const holidayThemes = THEME_GROUPS.find((g) => g.tab === "holiday")?.themes ?? [];
  for (const t of holidayThemes) {
    if (isHolidayActive(t.id, now)) return t.id;
  }
  return null;
}

/** Same "is a Holiday Override live right now" check resolveActiveCycleThemeId()
 *  uses to decide whether to force a holiday theme, exposed so shell.ts can
 *  explain, in the Cycle pane, *why* the theme is pinned. Returns null
 *  whenever the override wouldn't actually fire (setting off, or no Holiday
 *  window active today), same as resolveActiveCycleThemeId's own check. */
export function getActiveHolidayOverrideThemeId(): string | null {
  return settings.cycleHolidayOverride ? getActiveHolidayThemeId() : null;
}

/** The last calendar day `themeId`'s currently-active window keeps it forced
 *  on (inclusive). Mardi Gras/Thanksgiving via their own movable-date math,
 *  everything else via whichever of the two HOLIDAY_WINDOWS_* tables actually
 *  produced the active match, so this always agrees with isHolidayActive().
 *  Only meaningful to call while getActiveHolidayOverrideThemeId() returns
 *  this same themeId. */
export function getHolidayOverrideEndDate(themeId: string, now: Date = new Date()): Date | null {
  if (themeId === "mardi-gras") return computeMardiGras(now.getFullYear());
  if (themeId === "thanksgiving") return computeThanksgiving(now.getFullYear());
  const windows = settings.cycleHolidayFullSeason ? HOLIDAY_WINDOWS_WIDE : HOLIDAY_WINDOWS_TIGHT;
  const win = windows[themeId];
  return win ? new Date(now.getFullYear(), win.endMonth - 1, win.endDay) : null;
}

/* -----------------------------------------------------------------------------
   Day/Night schedule
   -----------------------------------------------------------------------------
   Two themes, one clock window. Everything below is derived from the current
   time rather than stored, which is what keeps this mode honest across app
   restarts, suspends and clock changes: there is no "where was I" to get
   stale, only "what time is it now".

   The window may wrap midnight. A day of 20:00-06:00 is legitimate (someone
   who wants the bright theme overnight), so every comparison here works on
   minutes-since-local-midnight with an explicit wrapped branch rather than
   assuming start < end.
----------------------------------------------------------------------------- */

const MINUTES_PER_DAY = 24 * 60;

/* Mirrors DEFAULT_SETTINGS.cycleDayStart/cycleDayEnd in shell.ts. Only reached
   if a persisted value is malformed, which loadSettings() already coerces away.
   This is the belt to that pair of braces. */
const FALLBACK_DAY_START_MIN = 7 * 60;
const FALLBACK_DAY_END_MIN = 19 * 60;

/** "HH:MM" to minutes since local midnight, or null if it isn't that shape. */
function parseClockMinutes(value: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function dayStartMinutes(): number {
  return parseClockMinutes(settings.cycleDayStart) ?? FALLBACK_DAY_START_MIN;
}

function dayEndMinutes(): number {
  return parseClockMinutes(settings.cycleDayEnd) ?? FALLBACK_DAY_END_MIN;
}

/** Whether `now` falls inside the configured day window.
 *
 *  Start === end can no longer be entered (shell.ts's isValidDayNightWindow
 *  rejects it, and any stored pair breaking that rule is reset at load), so the
 *  equal branch is only a guard against a degenerate value reaching here by
 *  some other route. It reads as "day, all day", the least surprising answer
 *  for a window with no night in it. */
export function isDaytimeNow(now: Date = new Date()): boolean {
  const start = dayStartMinutes();
  const end = dayEndMinutes();
  if (start === end) return true;
  const mins = now.getHours() * 60 + now.getMinutes();
  return start < end ? mins >= start && mins < end : mins >= start || mins < end;
}

/** Whether `themeId` still names something paintable: a built-in theme or a
 *  saved custom one. */
function themeIdExists(themeId: string): boolean {
  if (!themeId) return false;
  if (THEME_GROUPS.some((g) => g.themes.some((t) => t.id === themeId))) return true;
  return customThemes.some((t) => t.id === themeId);
}

/** Whichever of the two Day/Night themes the clock currently calls for. Falls
 *  back to Light/Dark if the configured id has gone (a custom theme deleted
 *  since it was picked), so a missing theme degrades to the default pairing
 *  instead of pointing themeLink at a stylesheet that isn't there. */
function resolveDayNightThemeId(now: Date = new Date()): string {
  const daytime = isDaytimeNow(now);
  const wanted = daytime ? settings.cycleDayThemeId : settings.cycleNightThemeId;
  if (themeIdExists(wanted)) return wanted;
  return daytime ? "light" : "dark";
}

/** When the schedule next flips, i.e. the next occurrence of either edge of the
 *  window. Null while the window covers the whole day, since nothing flips.
 *  Exported for the Cycle pane's "showing X until Y" note. */
export function getNextDayNightSwitch(now: Date = new Date()): Date | null {
  const start = dayStartMinutes();
  const end = dayEndMinutes();
  if (start === end) return null;
  const mins = now.getHours() * 60 + now.getMinutes();
  const until = (edge: number): number => {
    const delta = edge - mins;
    return delta > 0 ? delta : delta + MINUTES_PER_DAY;
  };
  const next = Math.min(until(start), until(end));
  const at = new Date(now);
  at.setSeconds(0, 0);
  at.setMinutes(at.getMinutes() + next);
  return at;
}

/** What the Cycle pane needs to describe the current state in one line: which
 *  side of the window we're on, the theme id that side resolves to, and when
 *  it changes. Null unless Day/Night is the active mode. */
export function getDayNightStatus(): {
  daytime: boolean;
  themeId: string;
  nextSwitch: Date | null;
} | null {
  if (settings.theme !== "cycle" || settings.cycleTrigger !== "dayNight") return null;
  return {
    daytime: isDaytimeNow(),
    themeId: resolveDayNightThemeId(),
    nextSwitch: getNextDayNightSwitch(),
  };
}

/* -----------------------------------------------------------------------------
   Cycle pool + pointer advancement
----------------------------------------------------------------------------- */

/** The ordered set of theme ids Cycle rotates through: every built-in
 *  Main/Holiday/Special theme, plus saved Custom themes if opted in. With
 *  "Restrict to Holiday Season" on, a Holiday theme is only pool-eligible
 *  during its own window (tight day or full season, per cycleHolidayFullSeason)
 *:  independent of Holiday Override, which is a separate force-switch check
 *  resolveActiveCycleThemeId() makes outside of pool membership entirely. */
function buildCyclePool(): string[] {
  const holidayIds = new Set(
    (THEME_GROUPS.find((g) => g.tab === "holiday")?.themes ?? []).map((t) => t.id),
  );
  const now = new Date();
  const builtins = THEME_GROUPS.flatMap((g) => g.themes)
    .filter(
      (t) =>
        !settings.cycleHolidaySeasonOnly || !holidayIds.has(t.id) || isHolidayActive(t.id, now),
    )
    .map((t) => t.id);
  const customs = settings.cycleIncludeCustom ? customThemes.map((t) => t.id) : [];
  const pool = [...builtins, ...customs];
  return pool.length > 0 ? pool : [DEFAULT_THEME_ID];
}

/** What Cycle mode should be showing right now: a live Holiday Override wins
 *  outright regardless of mode; then Day/Night, if that's the selected mode,
 *  answers straight from the clock; otherwise the persisted pool pointer,
 *  falling back to the pool's first entry if that pointer no longer exists
 *  (pool composition changed, or its custom theme got deleted). */
function resolveActiveCycleThemeId(): string {
  if (settings.cycleHolidayOverride) {
    const holidayId = getActiveHolidayThemeId();
    if (holidayId) return holidayId;
  }
  if (settings.cycleTrigger === "dayNight") return resolveDayNightThemeId();
  const pool = buildCyclePool();
  if (settings.cycleCurrentThemeId && pool.includes(settings.cycleCurrentThemeId)) {
    return settings.cycleCurrentThemeId;
  }
  return pool[0]!;
}

function pickNextInPool(pool: string[], current: string): string {
  if (pool.length === 0) return DEFAULT_THEME_ID;
  if (settings.cycleOrder === "random") {
    if (pool.length === 1) return pool[0]!;
    let next = current;
    while (next === current) next = pool[Math.floor(Math.random() * pool.length)]!;
    return next;
  }
  const idx = pool.indexOf(current);
  return pool[(idx + 1) % pool.length]!;
}

/** Applies a specific theme id (a built-in theme name (loads its CSS) or a
 *  saved custom theme's id) directly onto themeLink/:root, independent of
 *  settings.theme. Mirrors theme-core.ts's standard/custom branches exactly
 *  (same "call sync + set onload" idiom) since Cycle needs to apply an
 *  arbitrary underlying theme without ever setting settings.theme away from
 *  "cycle". */
function applyUnderlyingTheme(themeId: string): void {
  const isCustom = customThemes.some((t) => t.id === themeId);
  if (isCustom) {
    themeLink.href = themeCssUrl(BASE_THEME_ID);
    themeLink.onload = () => {
      applyCustomThemeById(themeId);
      window.dispatchEvent(new CustomEvent("themechange"));
    };
    applyCustomThemeById(themeId);
    window.dispatchEvent(new CustomEvent("themechange"));
    return;
  }
  localStorage.removeItem(PERSISTENT_RANDOM_KEY);
  // Same guard as applyTheme()'s standard branch: a Cycle pool entry or a
  // stored day/night pick naming a theme that no longer exists must not be
  // handed to themeLink raw. See resolveThemeId() for why a missing file does
  // not announce itself.
  themeLink.href = themeCssUrl(resolveThemeId(themeId));
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

/** Which real theme id Cycle mode is currently displaying, used by
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

/** "Cycle Now" button, allowed while Cycle is the active theme regardless of
 *  which pool trigger is configured. Day/Night is the exception: there is no
 *  pointer to advance there, only a clock to read, so the button is hidden in
 *  that mode and this guards the path anyway. */
export function advanceCycleNow(): void {
  if (settings.theme !== "cycle") return;
  if (settings.cycleTrigger === "dayNight") return;
  advanceCyclePointer();
}

/* -----------------------------------------------------------------------------
   "Time" trigger, schedules the next advance instead of reacting to
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
   Day/Night boundary timer. The counterpart to the interval timer above, but
   it schedules toward a wall-clock edge rather than a duration, and re-resolves
   rather than advancing anything.

   The wait is capped well below a full window so the mode self-corrects instead
   of trusting one long timeout: a laptop suspended across sunset, or a system
   clock that jumps, is caught at the next tick rather than staying on the wrong
   theme until the following edge. Re-resolving is free when nothing changed,
   applyResolvedCycleTheme() no-ops unless the answer actually differs.
----------------------------------------------------------------------------- */

const DAY_NIGHT_MAX_WAIT_MS = 5 * 60 * 1000;

let _dayNightTimerHandle: number | null = null;

function clearDayNightTimer(): void {
  if (_dayNightTimerHandle !== null) {
    window.clearTimeout(_dayNightTimerHandle);
    _dayNightTimerHandle = null;
  }
}

function rescheduleDayNightTimer(): void {
  clearDayNightTimer();
  if (settings.theme !== "cycle" || settings.cycleTrigger !== "dayNight") return;

  const now = new Date();
  const next = getNextDayNightSwitch(now);
  // No switch scheduled (a 24-hour window) still polls, so editing the window
  // while the app is open starts flipping again without needing a re-arm.
  const untilEdge = next ? next.getTime() - now.getTime() : DAY_NIGHT_MAX_WAIT_MS;
  const wait = Math.max(1000, Math.min(untilEdge, DAY_NIGHT_MAX_WAIT_MS));

  _dayNightTimerHandle = window.setTimeout(() => {
    applyResolvedCycleTheme();
    rescheduleDayNightTimer();
  }, wait);
}

/* -----------------------------------------------------------------------------
   Holiday-boundary recheck, a periodic re-resolve so a Holiday Override
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
// advance, set on the very first activateCycleTheme() call regardless of
// trigger, so switching the dropdown to "On Startup" mid-session never
// retroactively fires a surprise advance; only a real app-launch activation
// (settings.cycleTrigger already "onStartup" when the app first applies
// settings) gets the bonus advance.
let _cycleActivatedOnce = false;

/** Single entry point theme-core.ts's applyTheme("cycle") dispatches to:
 *  resolves + (re)paints whatever Cycle should be showing right now, and
 *  (re)arms the time-trigger timer and holiday-boundary check. Safe to call
 *  repeatedly (Settings modal reopen, any cycle-setting change). Each piece
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
  rescheduleDayNightTimer();
  ensureHolidayCheckInterval();
}

/* -----------------------------------------------------------------------------
   Interaction-driven triggers. Two independent trigger modes, each with its
   own listener(s):

     "click":      mousedown anywhere (not just buttons): fires the instant
                    the mouse goes down rather than waiting for the full
                    click, so it feels snappier. The simplest of the two.
     "everything", mirrors random-theme.ts's Regenerative reactivity exactly:
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

// "everything" trigger, button clicks.
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

// "everything" trigger. Enter/Escape field commits.
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

// "everything" trigger, checkbox/radio/select changes.
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
