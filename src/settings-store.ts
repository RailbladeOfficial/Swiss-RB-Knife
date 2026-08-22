/* =============================================================================
   SETTINGS STORE: the shape of General Settings, its defaults, and the live copy
   -----------------------------------------------------------------------------
   Split out of shell.ts so the modules that only need to READ a setting no
   longer have to import shell to get one.

   That matters beyond tidiness. shell, theme-core, cycle-theme, theme-editor
   and others import each other in a loop, and a loop is what made the app open
   to a blank window once already. random-theme.ts and theme-core.ts reached
   into shell for exactly one thing, `settings`; pointing them here instead
   takes random-theme out of the loop entirely and removes three edges from it.

   This file imports ONLY theme-ids.ts, which itself imports nothing, so it is
   never the late half of a circular import. Keep it that way: put anything that
   needs flash(), the DOM, or Tauri in shell.ts instead. Loading and saving
   still live there for that reason.
============================================================================= */

import { DEFAULT_THEME_ID } from "./theme-ids";

export type SidebarItemState = {
  key: string;
  pinned: boolean;
  /** Epoch ms this tool was last opened. Absent until it has been. Feeds the
   *  Most Recent sort. */
  lastUsedAt?: number;
  /** How many times it has been opened. Feeds the Most Used sort. */
  useCount?: number;
};

export type SidebarSortMode = "classic" | "az" | "za" | "recent" | "used" | "custom";

export const SIDEBAR_SORT_MODES: SidebarSortMode[] = ["classic", "az", "za", "recent", "used", "custom"];

export type ShellSettings = {
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
   *  settings, and never again on its own after that.
   *
   *  "dayNight" is the odd one out: it doesn't advance a pointer through the
   *  pool at all, it alternates between exactly two themes on a clock window
   *  (see the four cycleDay/cycleNight fields below). Order, Include Custom and
   *  Restrict to Holiday Season have nothing to act on in that mode and are
   *  hidden while it's selected; Holiday Overrides still apply, since that's
   *  a force-switch checked ahead of every other rule. */
  cycleTrigger: "onStartup" | "time" | "everything" | "click" | "dayNight";
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
  /** Day/Night mode (the "dayNight" trigger): the two themes it alternates
   *  between. Either may be a built-in theme id or a saved custom theme's id;
   *  one that no longer resolves falls back at paint time rather than pointing
   *  themeLink at a missing file. */
  cycleDayThemeId: string;
  cycleNightThemeId: string;
  /** The clock window that counts as "day", as "HH:MM" 24-hour local strings
   *  (the format <input type="time"> reads and writes, so the controls need no
   *  conversion). The window is allowed to wrap midnight: a start of 20:00 with
   *  an end of 06:00 is a perfectly good overnight "day". Start equal to end
   *  means the day theme runs the whole 24 hours. */
  cycleDayStart: string;
  cycleDayEnd: string;
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

export const DEFAULT_SETTINGS: ShellSettings = {
  fontScale: 0,
  hour12: false,
  americanDates: false,
  solidModals: true,
  startupTarget: "lastView",
  theme: DEFAULT_THEME_ID,
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
  cycleDayThemeId: "light",
  cycleNightThemeId: "dark",
  cycleDayStart: "07:00",
  cycleDayEnd: "19:00",
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

/** The live settings object. Exported as a `let` so importers see reassignments
 *  (ES modules give them a live view, not a copy). Reassign ONLY through
 *  setSettings(), so there is a single place to look when tracing a change.
 *
 *  sidebarItems starts empty rather than fully populated: filling it needs
 *  ALL_TOOLS, which lives in shell.ts, and reaching for that here would put
 *  this file back in the import loop. shell.ts overwrites it via setSettings()
 *  as it starts, before any screen renders. */
export let settings: ShellSettings = { ...DEFAULT_SETTINGS };

/** Replaces the live settings object. */
export function setSettings(next: ShellSettings): void {
  settings = next;
}
