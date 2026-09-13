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

test("every theme defines the full palette (a partial one leaves parts of the UI colorless)", () => {
  const block = slice("src/theme/random-theme.ts", "export const RANDOM_VARS = [", "] as const");
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
  const block = slice("src/theme/theme-ids.ts", "THEME_ID_MIGRATIONS", "export function migrateThemeId");
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
  const ids = read("src/theme/theme-ids.ts");
  const def = /DEFAULT_THEME_ID = "([a-z-]+)"/.exec(ids)[1];
  const href = tagAttr("themeLink", "href");
  assert.equal(href, `/themes/${def}.css`, "index.html boot <link> does not match DEFAULT_THEME_ID");
  assert.ok(exists(`public/themes/${def}.css`), `default theme ${def}.css is missing`);
});

test("the colored stripe on a tool panel is not silently overwritten with gray", () => {
  // Budget, Time Tracker and Auto-Backup mark their panels with a colored
  // left border. Nine themes declared that border and THEN declared a plain
  // `border-color` after it, and because border-color is a shorthand covering
  // all four sides, it repainted the stripe gray. The color was in the file,
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
  assert.deepEqual(problems, [], "these panel stripes render gray instead of their color");
});

test("the Special tab stays alphabetical", () => {
  const block = slice("src/theme/theme-ids.ts", 'tab: "special"', "];");
  const labels = [...block.matchAll(/label: "([^"]+)"/g)].map((m) => m[1]);
  const sorted = [...labels].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  assert.deepEqual(labels, sorted, "Special tab themes are no longer in alphabetical order");
});

test("the theme editor shows what the saved theme will render", () => {
  /* Picking a system theme as the editor's base and going back to "This theme's
     saved colors" left six variables applied from the theme looked at on the
     way past. A system theme reads as all 39 of RANDOM_VARS; a custom theme
     holds whatever existed the day it was saved, which for the ones on this
     machine is 33. The live preview only ever SET properties, so the extra six
     stayed: --color-accent (the active tab's text in most themes, and the one
     you notice), --color-success, and the four changelog colors. */
  const src = read("src/theme/theme-editor.ts");
  const preview = slice("src/theme/theme-editor.ts", "function teLivePreview(", "\n}");
  assert.match(
    preview,
    /removeProperty\(/,
    "the live preview sets colors without clearing the ones it no longer has, so a previous base leaks through",
  );
  assert.match(preview, /for \(const key of RANDOM_VARS\)/, "the preview does not sweep the whole variable list");

  /* And it previews through the SAME rule that applying a saved theme uses.
     The accent derivation lived only in the apply path, so the preview fell
     through to the base sheet's accent and the saved theme came up different. */
  assert.match(src, /function effectiveThemeVars\(/, "there is no single definition of what a custom theme renders with");
  for (const fn of ["function teLivePreview(", "export function applyCustomThemeById("]) {
    const body = slice("src/theme/theme-editor.ts", fn, "\n}");
    assert.match(body, /effectiveThemeVars\(/, `${fn} does not go through the shared rule`);
  }
  assert.equal(
    (src.match(/deriveAccent\(/g) ?? []).length,
    2,
    "the accent derivation is called from more than the one place that defines the rule",
  );
});

test("the Blades theme colors tools by position, and the app stamps the position", () => {
  /* Blades hands every tool one of five colors and the whole look rests on the
     sidebar reading red, orange, green, blue, purple in order. That order is
     the USER's, so the stylesheet cannot know it: it keys on a data-blade
     number the app stamps, and this checks the two halves still meet.

     It is checked because both halves fail silently. A selector that stops
     matching renders as "unchanged", and an attribute nobody reads costs
     nothing and says nothing. The symptom of them drifting apart is every tool
     showing the default green, which is what shipping two new tools under the
     old hardcoded-per-tool blocks already produced once. */
  const css = read("public/themes/blades.css");

  // Five palettes, no more and no fewer, each claiming all four surfaces.
  for (const n of [1, 2, 3, 4, 5]) {
    for (const surface of [".nav-item", ".tool-card", ".tool-view"]) {
      assert.ok(
        css.includes(`${surface}[data-blade="${n}"]`),
        `blades.css does not color ${surface} for blade ${n}`,
      );
    }
    assert.ok(
      css.includes(`body[data-active-blade="${n}"] .modal-backdrop`),
      `blades.css does not reach the modals of blade ${n}`,
    );
  }
  assert.ok(
    !css.includes('[data-blade="6"]'),
    "there is a sixth blade, which the app never stamps",
  );

  // And nothing is keyed on a tool's NAME any more, which is what made the
  // colors fixed and every new tool green.
  const named = [...css.matchAll(/\.(?:nav-item|tool-card)\[data-section=/g)];
  assert.deepEqual(
    named.map((m) => m[0]),
    [],
    "blades.css is picking tools out by name again, so reordering will not recolor them",
  );

  // The app's half: the stamp, the cycle length, and the <body> mirror the
  // modals read.
  const sidebar = read("src/core/sidebar-edit.ts");
  assert.match(sidebar, /const BLADE_COUNT = 5;/, "the cycle length is not five");
  assert.match(sidebar, /el\.dataset\.blade = blade;/, "nothing stamps data-blade on the rows and cards");
  assert.match(sidebar, /view\.dataset\.blade = blade;/, "nothing stamps data-blade on the tool views");
  assert.match(
    sidebar,
    /export function applyBladeOrder/,
    "there is no function assigning the blades",
  );
  assert.match(
    read("src/core/sidebar-edit.ts"),
    /applyBladeOrder\(\);/,
    "applyBladeOrder is never called from applySidebarOrder",
  );

  const shell = read("src/core/shell.ts");
  assert.match(
    shell,
    /document\.body\.dataset\.activeBlade = String\(bladeForToolKey\(/,
    "the open tool's blade never reaches <body>, so its modals fall back to the default",
  );
  assert.match(
    shell,
    /delete document\.body\.dataset\.activeBlade;/,
    "the blade is left on <body> after leaving a tool",
  );
});

test("the attention pulse wears the tool's own blade", () => {
  /* The pulse animates --color-btn / --color-btn-text (shell.css and
     landing.css). The blade scopes deliberately do NOT remap the shared tokens
     on sidebar rows and Home cards, because that would recolor the silver
     stack itself, so both pulsed in :root's green whatever tool was asking.
     Budget and Auto-Backup are the only two that raise it, and both flashed
     the wrong color. */
  const css = read("public/themes/blades.css");
  const at = css.indexOf(".nav-item.attention-pulse,");
  assert.notEqual(at, -1, "blades.css does not recolor the pulse");
  const rule = css.slice(at, css.indexOf("}", at));
  assert.ok(rule.includes(".tool-card.attention-pulse"), "the Home card's pulse is not covered");
  assert.match(rule, /--color-btn:\s*var\(--bl-rail\)/, "the pulse does not take the blade's rail");
  assert.ok(
    css.includes(".nav-item.attention-pulse .nav-icon"),
    "the icon still has a color of its own, so it pulses into invisibility",
  );
});
