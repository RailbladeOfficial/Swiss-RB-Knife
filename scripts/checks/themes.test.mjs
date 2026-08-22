/* =============================================================================
   THEME INTEGRITY
   -----------------------------------------------------------------------------
   Every check here maps to a symptom that has actually happened during
   development, not a hypothetical. Test names describe the symptom, so a
   failure tells you what the user would have seen.
============================================================================= */

import test from "node:test";
import assert from "node:assert/strict";
import { read, exists, slice, themeGroups, themeFiles, selectOptions, tagAttr } from "./_source.mjs";

const RANDOM_VAR_COUNT_MIN = 39;

test("every theme in the picker has a stylesheet (otherwise picking it shows an unstyled app)", () => {
  const files = new Set(themeFiles());
  const missing = themeGroups().themes.filter((t) => !files.has(t.id));
  assert.deepEqual(
    missing.map((t) => t.label),
    [],
    "these themes are offered in the picker but have no CSS file",
  );
});

test("the base sheet is never offered as a pickable theme", () => {
  // base-theme.css exists only to sit underneath Random and Custom themes.
  // If it ever appears in the picker, users can select a palette nobody designed.
  const offered = themeGroups().themes.map((t) => t.id);
  assert.ok(!offered.includes("base-theme"), "base-theme must not be selectable");

  for (const selectId of ["themeSelect", "teBaseSelect"]) {
    const values = selectOptions(selectId).map((o) => o.value);
    assert.ok(!values.includes("base-theme"), `base-theme must not appear in #${selectId}`);
  }
});

test("every stylesheet on disk is either pickable or the base sheet (no orphan files)", () => {
  const offered = new Set(themeGroups().themes.map((t) => t.id));
  const orphans = themeFiles().filter((id) => !offered.has(id) && id !== "base-theme");
  assert.deepEqual(orphans, [], "these theme files are dead weight, nothing can select them");
});

test("every theme defines the full palette (a partial one leaves parts of the UI colourless)", () => {
  const block = slice("src/random-theme.ts", "export const RANDOM_VARS = [", "] as const");
  const required = [...new Set([...block.matchAll(/"(--color-[a-z0-9-]+)"/g)].map((m) => m[1]))];
  assert.ok(
    required.length >= RANDOM_VAR_COUNT_MIN,
    `expected at least ${RANDOM_VAR_COUNT_MIN} palette variables, parsed ${required.length}`,
  );

  for (const id of themeFiles()) {
    const css = read(`public/themes/${id}.css`);
    const declared = new Set([...css.matchAll(/(--color-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    const missing = required.filter((v) => !declared.has(v));
    assert.deepEqual(missing, [], `${id}.css is missing ${missing.length} palette variable(s)`);
  }
});

test("the picker list and the hidden dropdown agree on contents AND order", () => {
  // #themeSelect is a hidden data holder the theme editor reads and writes.
  // If it drifts from THEME_GROUPS, the picker and the editor disagree about
  // which theme is active.
  const groups = themeGroups().themes.map((t) => `${t.id}|${t.label}`);
  const dropdown = selectOptions("themeSelect")
    .filter((o) => o.value !== "random" && o.value !== "custom")
    .map((o) => `${o.value}|${o.label}`);
  assert.deepEqual(dropdown, groups, "THEME_GROUPS (theme-ids.ts) and #themeSelect (index.html) differ");
});

test("the theme editor offers every built-in theme as a starting point", () => {
  // This list drifted out of sync once already, silently dropping four themes.
  const offered = new Set(selectOptions("teBaseSelect").map((o) => o.value));
  const missing = themeGroups().themes.filter((t) => !offered.has(t.id));
  assert.deepEqual(
    missing.map((t) => t.label),
    [],
    "these themes cannot be used as a custom-theme starting point",
  );
});

test("renamed themes still resolve for anyone whose settings name the old id", () => {
  const block = slice("src/theme-ids.ts", "THEME_ID_MIGRATIONS", "export function migrateThemeId");
  const pairs = [...block.matchAll(/^\s*([a-z-]+):\s*"([a-z-]+)",/gm)].map((m) => ({
    from: m[1],
    to: m[2],
  }));
  const files = new Set(themeFiles());
  for (const { from, to } of pairs) {
    assert.ok(files.has(to), `migration ${from} -> ${to}: target ${to}.css does not exist`);
    assert.ok(!files.has(from), `migration ${from} -> ${to}: old ${from}.css still on disk`);
  }
});

test("the first paint uses the default theme (a wrong href here means a blank first frame)", () => {
  // index.html's <link> is what paints before any code runs. It is kept in sync
  // with DEFAULT_THEME_ID by hand, so this is the only thing checking it.
  const ids = read("src/theme-ids.ts");
  const def = /DEFAULT_THEME_ID = "([a-z-]+)"/.exec(ids)[1];
  const href = tagAttr("themeLink", "href");
  assert.equal(href, `/themes/${def}.css`, "index.html boot <link> does not match DEFAULT_THEME_ID");
  assert.ok(exists(`public/themes/${def}.css`), `default theme ${def}.css is missing`);
});

test("the coloured stripe on a tool panel is not silently overwritten with grey", () => {
  // Budget, Time Tracker and Auto-Backup mark their panels with a coloured
  // left border. Nine themes declared that border and THEN declared a plain
  // `border-color` after it, and because border-color is a shorthand covering
  // all four sides, it repainted the stripe grey. The colour was in the file,
  // correct, and never once reached the screen.
  //
  // In CSS the later declaration wins, so border-color has to come FIRST.
  const problems = [];
  for (const id of themeFiles()) {
    const css = read(`public/themes/${id}.css`);
    for (const m of css.matchAll(/(\.panel-accent-[a-z]+[^{]*)\{([^}]*)\}/g)) {
      const [, selector, body] = m;
      const left = body.search(/border-left\s*:/);
      const all = body.search(/border-color\s*:/);
      if (left >= 0 && all >= 0 && all > left) {
        problems.push(`${id}.css ${selector.trim()}: border-color after border-left`);
      }
    }
  }
  assert.deepEqual(problems, [], "these panel stripes render grey instead of their colour");
});

test("the Special tab stays alphabetical", () => {
  const block = slice("src/theme-ids.ts", 'tab: "special"', "];");
  const labels = [...block.matchAll(/label: "([^"]+)"/g)].map((m) => m[1]);
  const sorted = [...labels].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  assert.deepEqual(labels, sorted, "Special tab themes are no longer in alphabetical order");
});
