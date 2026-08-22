/* =============================================================================
   THEME ID RESOLUTION  (true unit tests)
   -----------------------------------------------------------------------------
   theme-ids.ts imports nothing and touches no browser API, so unlike the rest of
   the front end it can be loaded and exercised for real here. Node runs the
   TypeScript directly by stripping the type annotations.

   These cover the "app opened with no styling at all" failure: a stored theme
   name that no longer matches any file. resolveThemeId() itself lives in
   theme-core.ts, which needs a browser, so its decision is reconstructed here
   from the same two inputs it uses.
============================================================================= */

import test from "node:test";
import assert from "node:assert/strict";
import { themeGroups, themeFiles } from "./_source.mjs";
import {
  BASE_THEME_ID,
  DEFAULT_THEME_ID,
  THEME_SENTINELS,
  migrateThemeId,
} from "../../src/theme-ids.ts";

const builtinIds = new Set(themeGroups().themes.map((t) => t.id));
const isKnownBuiltin = (id) => id === BASE_THEME_ID || builtinIds.has(id);

/** Mirrors resolveThemeId() in theme-core.ts. */
const resolve = (id) => {
  const migrated = migrateThemeId(id);
  return isKnownBuiltin(migrated) ? migrated : DEFAULT_THEME_ID;
};

/** Mirrors healStoredThemeId() in shell.ts: does this stored value get rewritten? */
const isHealed = (id) => !(THEME_SENTINELS.includes(id) || isKnownBuiltin(id));

test("a theme name that does not exist falls back instead of showing an unstyled app", () => {
  for (const junk of ["", "   ", "titties", "Dark", "DARK", "../../etc/passwd", "theme.css"]) {
    assert.equal(resolve(junk), DEFAULT_THEME_ID, `${JSON.stringify(junk)} should fall back`);
  }
});

test("a renamed theme still opens on the theme it became", () => {
  assert.equal(resolve("default"), "midnight-blue");
  assert.equal(resolve("midnight"), "void");
});

test("a normal theme name is left exactly as-is", () => {
  for (const id of themeGroups().themes.map((t) => t.id)) {
    assert.equal(resolve(id), id, `${id} should resolve to itself`);
  }
});

test("Random, Custom and Cycle survive the settings clean-up", () => {
  // These three are modes, not stylesheet names. Treating them as unknown theme
  // names would silently kick the user off Random or Cycle on next launch.
  for (const sentinel of THEME_SENTINELS) {
    assert.equal(isHealed(sentinel), false, `${sentinel} must never be rewritten`);
  }
  assert.deepEqual([...THEME_SENTINELS].sort(), ["custom", "cycle", "random"]);
});

test("a junk theme name IS cleaned out of settings, a real one is not", () => {
  assert.equal(isHealed("titties"), true);
  assert.equal(isHealed(""), true);
  assert.equal(isHealed("dark"), false);
  assert.equal(isHealed("midnight-red"), false);
  assert.equal(isHealed(BASE_THEME_ID), false);
});

test("whatever the fallback resolves to actually exists on disk", () => {
  // If this ever fails, the safety net itself is broken and the app has no
  // palette to fall back to.
  const files = new Set(themeFiles());
  assert.ok(files.has(DEFAULT_THEME_ID), `${DEFAULT_THEME_ID}.css is missing`);
  assert.ok(files.has(BASE_THEME_ID), `${BASE_THEME_ID}.css is missing`);
});

test("every theme name a migration points at is a real theme", () => {
  for (const from of ["default", "midnight"]) {
    const to = migrateThemeId(from);
    assert.notEqual(to, from, `${from} should map to something`);
    assert.ok(isKnownBuiltin(to), `${from} maps to ${to}, which is not a real theme`);
  }
});
