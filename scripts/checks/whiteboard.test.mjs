/* =============================================================================
   WHITEBOARD
   -----------------------------------------------------------------------------
   Each of these is a way the Whiteboard can go wrong with nothing on screen to
   say so. A pen whose color names a variable no theme defines draws in a flat
   grey that looks deliberate. A snapshot group quietly set back to none means
   the one Clear the undo stack no longer reaches is gone for good. A Send and
   Clear that clears before Kanban has written is lost text on the one day the
   write fails.
============================================================================= */

import test from "node:test";
import assert from "node:assert/strict";

import { read, slice } from "./_source.mjs";

const TS = "src/tool/whiteboard.ts";

/** The pens, as whiteboard.ts declares them: slot id and the variable it reads. */
function inks() {
  return [...slice(TS, "const INKS", "];").matchAll(/id: "([a-z0-9]+)", cssVar: "(--[a-z0-9-]+)"/g)].map(
    (m) => ({ id: m[1], cssVar: m[2] }),
  );
}

test("the pen list parsed (guards the checks below)", () => {
  assert.equal(inks().length, 6, "INKS did not parse as six pens");
});

test("every pen reads a variable every theme is required to define", () => {
  // RANDOM_VARS is the palette every theme has to supply in full; see
  // themes.test.mjs. A pen outside it draws in the fallback grey on any theme
  // that happens not to define it.
  const palette = slice("src/theme/random-theme.ts", "export const RANDOM_VARS = [", "] as const");
  const missing = inks().filter((i) => !palette.includes(`"${i.cssVar}"`));
  assert.deepEqual(missing, [], "these pens read a variable that is not in the required palette");
});

test("every pen has a swatch, and a CSS class reading the same variable", () => {
  const html = read("index.html");
  const css = read("src/tool/whiteboard.css");
  const problems = [];
  for (const { id, cssVar } of inks()) {
    if (!html.includes(`data-ink="${id}"`)) problems.push(`${id}: no swatch button`);
    const rule = css.match(new RegExp(String.raw`\.wb-ink-${id}\s*\{\s*--wb-c:\s*([^;]+);`));
    if (!rule) problems.push(`${id}: no .wb-ink-${id} rule`);
    // The text box and the canvas have to agree, or a line typed in a color is
    // a different color from a line drawn in it.
    else if (!rule[1].includes(`var(${cssVar})`)) problems.push(`${id}: CSS reads ${rule[1]}, canvas reads ${cssVar}`);
  }
  assert.deepEqual(problems, []);
});

test("the whiteboard file is snapshotted, not treated as a throwaway draft", () => {
  const rs = read("src-tauri/src/lib.rs");
  assert.match(
    rs,
    /\("whiteboard", "data"\) => \(\s*"whiteboard\/whiteboard\.json",[^)]*WHITEBOARD_GROUP,?\s*\)/,
    "the whiteboard's file row no longer names its snapshot group",
  );
  assert.match(
    rs,
    /const WHITEBOARD_GROUP: &\[&str\] = &\["whiteboard\/whiteboard\.json"\];/,
    "WHITEBOARD_GROUP no longer captures the whiteboard file",
  );
});

test("a card title from the whiteboard is cut to Kanban's own limit, not a copy of it", () => {
  const ts = read(TS);
  assert.match(ts, /\bMAX_TITLE_LEN\b[\s\S]*?from "\.\/kanban"/, "whiteboard.ts does not import Kanban's title limit");
  assert.doesNotMatch(ts, /const MAX_TITLE_LEN\b/, "whiteboard.ts keeps its own title limit, which can drift");
});

test("Send and Clear lets go of what it sent only after Kanban has written it", () => {
  // Keyed on the line that actually removes things, not on the branch around
  // it: an if moved or duplicated elsewhere proves nothing about the removal.
  // Both ways over are checked, the text cards and the picture.
  for (const [fn, removalCall] of [
    ["async function sendText(", "texts = texts.filter("],
    ["async function sendImage(", "clearArea("],
  ]) {
    const start = read(TS).indexOf(fn);
    assert.notEqual(start, -1, `${fn} is missing`);
    const body = read(TS).slice(start, read(TS).indexOf("\n}\n", start));
    const guard = body.match(/if \(!result\.saved\) \{[\s\S]*?\n {2}\}/);
    const removal = body.indexOf(removalCall);
    assert.ok(guard && removal !== -1, `${fn} no longer has the guard or the removal this checks`);
    assert.ok(guard.index < removal, `${fn} can clear before Kanban has confirmed the write`);
    assert.match(guard[0], /\breturn;/, `${fn} falls through into the clear when the write failed`);
    assert.equal(
      body.split(removalCall).length,
      2,
      `${fn} removes things in more than one place, and only one of them is checked`,
    );
  }
});

test("leaving the tool and quitting both write what is waiting", () => {
  const shell = read("src/core/shell.ts");
  assert.match(
    shell,
    /_activeViewKey === "productivity\/whiteboard"[^\n]*\n\s*void onWhiteboardToolExit\(\);/,
    "navigating away from the Whiteboard does not flush it",
  );
  /* Quitting stopped naming tools one by one in 0.8.0: it walks the
     flushOnQuit registry instead, so the assertion is that the Whiteboard is
     ON that registry. wiring.test.mjs holds the registry's own end up. */
  assert.match(
    read("src/tool/whiteboard.ts"),
    /flushOnQuit\("whiteboard", onWhiteboardToolExit\)/,
    "quitting does not flush the Whiteboard",
  );
});

test("the text sizes in code match the ones the stylesheet draws", () => {
  // A picture of the board lays text out again from TEXT_REM. If the CSS says
  // something else, the picture's text lands a different size from the box.
  const rem = slice(TS, "const TEXT_REM", ";");
  const css = read("src/tool/whiteboard.css");
  const sizes = [...rem.matchAll(/(\w+): ([\d.]+)/g)];
  assert.equal(sizes.length, 3, "TEXT_REM did not parse as three sizes");
  const problems = [];
  for (const m of sizes) {
    const rule = css.match(new RegExp(String.raw`\.wb-tsize-${m[1]}\s*\{\s*font-size:\s*([\d.]+)rem`));
    if (!rule) problems.push(`${m[1]}: no .wb-tsize-${m[1]} rule`);
    else if (Number(rule[1]) !== Number(m[2])) problems.push(`${m[1]}: CSS ${rule[1]}rem, code ${m[2]}rem`);
  }
  assert.deepEqual(problems, []);
});

test("typed text is never put on the page as markup", () => {
  // Text boxes are built from runs of text somebody typed, now with spans for
  // their colors and sizes. Every one of those has to be made from nodes;
  // one innerHTML with a run's text in it is a way to run markup from a note.
  const ts = read(TS);
  assert.doesNotMatch(ts, /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML/, "whiteboard.ts writes markup");
});

test("a Custom theme repaints the ink, not only the text", () => {
  /* Custom themes, and the theme editor's live preview, write their colors
     onto the root element and never announce a "themechange". Text boxes
     follow through CSS; the canvas does not, and without watching the root it
     kept drawing a Custom theme's ink in the palette from before. */
  const ts = read(TS);
  assert.match(
    ts,
    /new MutationObserver\([\s\S]{0,400}?\)\.observe\(document\.documentElement,\s*\{[^}]*attributeFilter:\s*\["style"\]/,
    "the whiteboard no longer watches the root for a Custom theme's colors",
  );
});
