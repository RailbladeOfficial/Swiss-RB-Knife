/* =============================================================================
   STYLING HOOKS
   -----------------------------------------------------------------------------
   CSS fails silently. A rule whose selector matches nothing, or whose value
   names a variable nothing defines, produces no error anywhere: the element
   just renders with whatever it had before. That is exactly how the Game Stats
   panel stripes stayed grey through several releases while the correct colour
   sat in the file.

   These check that the hooks styling reaches for actually exist.
============================================================================= */

import test from "node:test";
import assert from "node:assert/strict";
import { read, htmlIds, themeFiles } from "./_source.mjs";

const PANEL_ACCENTS = [
  "--color-accent-input",
  "--color-accent-view",
  "--color-accent-totals",
  "--color-accent-entries",
];

test("every theme supplies all four panel-accent colours", () => {
  // Anything reading one of these gets nothing at all if a theme omits it,
  // which shows up as an uncoloured border rather than as an error.
  const problems = [];
  for (const id of themeFiles()) {
    const css = read(`public/themes/${id}.css`);
    for (const v of PANEL_ACCENTS) {
      if (!css.includes(`${v}:`)) problems.push(`${id}.css is missing ${v}`);
    }
  }
  assert.deepEqual(problems, []);
});

test("the Game Stats home tiles are styled against elements that exist", () => {
  // The tiles are coloured by id. Rename a tile in index.html and the rule
  // stops matching, silently reverting that tile to the default accent.
  const css = read("src/tools/game-stats.css");
  const ids = htmlIds();

  const mapped = [...css.matchAll(/^#(gsNav[A-Za-z]+)\s*\{[^}]*--gs-card-accent/gm)].map(
    (m) => m[1],
  );
  assert.ok(mapped.length >= 3, `expected the tile mapping, found ${mapped.length} entries`);

  const missing = mapped.filter((id) => !ids.has(id));
  assert.deepEqual(missing, [], "these tiles are coloured by id but no longer exist in the page");
});

test("every Game Stats tile colour points at a real palette variable", () => {
  const css = read("src/tools/game-stats.css");
  const used = [...css.matchAll(/--gs-card-accent:\s*var\((--[a-z-]+)\)/g)].map((m) => m[1]);
  assert.ok(used.length >= 4, `expected four tile colours, found ${used.length}`);

  const known = new Set([...PANEL_ACCENTS, "--gs-accent"]);
  const unknown = used.filter((v) => !known.has(v));
  assert.deepEqual(unknown, [], "these tile colours name a variable that is not a panel accent");

  // All four accents should be in play; two tiles sharing one is a copy-paste slip.
  const accents = used.filter((v) => v !== "--gs-accent");
  assert.equal(
    new Set(accents).size,
    accents.length,
    "two Game Stats tiles are using the same colour",
  );
});

test("the per-tile colour is confined to the border", () => {
  // Scope matters as much as presence here. The tile titles and descriptions
  // are NOT per-tile, so tinting the hover wash or the icon per-tile leaves the
  // text looking like it belongs to a different card. Border only, idle and
  // hover; everything else stays on the tool accent.
  const css = read("src/tools/game-stats.css");

  const cardStart = css.indexOf(".gs-action-card {");
  const card = css.slice(cardStart, css.indexOf("}", cardStart));
  assert.match(card, /border-left:[^;]*--gs-card-accent/, "the idle rail is not per-tile");

  const hoverStart = css.indexOf(".gs-action-card:hover {");
  const hover = css.slice(hoverStart, css.indexOf("}", hoverStart));
  assert.match(hover, /border-color:\s*var\(--gs-card-accent\)/, "hover border is not per-tile");
  for (const prop of ["background", "box-shadow"]) {
    const decl = new RegExp(`${prop}:[^;]*`).exec(hover);
    assert.ok(decl, `hover has no ${prop}`);
    assert.ok(
      !decl[0].includes("--gs-card-accent"),
      `hover ${prop} is per-tile; it should stay on the tool accent so it matches the label colour`,
    );
  }

  const iconStart = css.indexOf(".gs-action-icon {");
  const icon = css.slice(iconStart, css.indexOf("}", iconStart));
  assert.ok(
    !icon.includes("--gs-card-accent"),
    "the tile icon is per-tile; it should match its label, which is not",
  );
});
