/* =============================================================================
   THEME IDS: the identity constants, and nothing else
   -----------------------------------------------------------------------------
   THIS FILE MUST NOT IMPORT ANYTHING. That is its entire reason for existing,
   not a coincidence to be tidied up later.

   shell, theme-core, theme-editor and cycle-theme are a four-way import cycle.
   In a cycle, a module's body can run before the body of a module it imports
   from has run, which leaves that module's `const`s in the temporal dead zone.
   Both constants here are read at module top level (DEFAULT_SETTINGS in
   shell.ts, _tePrevTheme in theme-editor.ts), so when they lived in
   theme-core.ts, theme-editor's body evaluated ~1000 lines before theme-core
   declared them and init died with "Cannot access 'DEFAULT_THEME_ID' before
   initialization" — a blank window, and nothing tsc can catch, since the types
   are all perfectly valid.

   A module with no imports has no such hazard: it is fully evaluated before any
   module that imports it. Keep it that way. If something here ever needs an
   import, it belongs in a different file.
============================================================================= */

/** The sheet Random and Custom themes are painted on top of. Deliberately NOT a
 *  selectable theme (absent from THEME_GROUPS, #themeSelect and #teBaseSelect):
 *  it exists only to supply the structural rules a custom palette's ~39 :root
 *  vars can't carry. This used to be "default", which meant the Default theme
 *  could never be restyled without restyling every custom theme with it. See
 *  the header in base-theme.css.
 *
 *  Also the fallback applyTheme() drops to when a theme id resolves to no file.
 *  That path matters more than it looks: shell.css's :root declares no
 *  --color-* vars, so an unresolvable themeLink means the app renders with no
 *  palette at all rather than merely the wrong one. */
export const BASE_THEME_ID = "base-theme";

/** What a brand-new install starts on, and what everything falls back to when a
 *  theme id can't be resolved. index.html's boot <link href> is pointed at this
 *  theme's CSS by hand; keep the two in sync. */
export const DEFAULT_THEME_ID = "dark";

/** The values settings.theme can hold that are NOT a CSS filename. Each is
 *  handled by its own branch in applyTheme() and must never be treated as an
 *  unknown id and healed away. settings.theme is never a raw custom-theme id:
 *  "custom" is the marker, and which custom theme is active lives in
 *  theme-core's in-memory _activeCustomId, re-seeded from disk on each boot. */
export const THEME_SENTINELS: readonly string[] = ["random", "custom", "cycle"];

/** Theme ids that have been renamed, old -> new. Applied to stored settings on
 *  load, and again at paint time by resolveThemeId(). Entries are permanent:
 *  dropping one strands anyone whose settings still name the old id, whether
 *  that's an older build, a restored backup, or a hand-edited settings file. */
const THEME_ID_MIGRATIONS: Record<string, string> = {
  // Default became a named member of the Midnight family; its palette is
  // unchanged, so this is a pure id/label move for anyone already on it.
  default: "midnight-blue",
  // Freed up the "Midnight" name for that family. The old Midnight is a
  // true-black theme, which is what "Void" describes.
  midnight: "void",
  // NOTE: windowed -> nostalgia and amuzed -> ezmuze are deliberately absent.
  // Those renames happened before any build carrying them shipped, so no
  // settings file anywhere can name the old ids and an entry would be dead
  // weight. Only add a pair here once the id it replaces has actually been
  // released.
};

/** Maps a renamed theme id to its current one. Ids that were never renamed
 *  (and "random"/"custom"/"cycle", which aren't files) pass straight through.
 *  This only knows about renames; an id that was never valid in the first place
 *  is resolveThemeId()'s problem, not this function's. */
export function migrateThemeId(themeId: string): string {
  return THEME_ID_MIGRATIONS[themeId] ?? themeId;
}
