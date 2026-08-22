/* =============================================================================
   SETTINGS SAFETY
   -----------------------------------------------------------------------------
   Covers the settings whose stored value can leave the app in a state you
   cannot fix from inside the app: text too large to read the Settings modal,
   a startup view that doesn't exist, a notification sound file that isn't there.
============================================================================= */

import test from "node:test";
import assert from "node:assert/strict";
import { read, exists, slice, selectOptions, tagAttr } from "./_source.mjs";

test("the font size limit in code matches the limit on the input (text can't be made unreadable)", () => {
  // font scale feeds the root font size directly. A value of 500 renders the
  // whole app at ~520px, at which point the control that would undo it cannot
  // be read. The number input's min/max used to be the only thing enforcing it,
  // and a number input does not stop an out-of-range value being typed.
  const shell = read("src/shell.ts");
  const min = Number(/FONT_SCALE_MIN = (-?\d+)/.exec(shell)[1]);
  const max = Number(/FONT_SCALE_MAX = (-?\d+)/.exec(shell)[1]);
  assert.equal(min, Number(tagAttr("fontScaleValue", "min")), "code min != input min");
  assert.equal(max, Number(tagAttr("fontScaleValue", "max")), "code max != input max");
  assert.ok(min < 0 && max > 0, "range should span either side of the default");
});

test("the font size is clamped when loaded from disk, not just when typed", () => {
  const shell = read("src/shell.ts");
  assert.match(
    shell,
    /fontScale: clampFontScale\(merged\.fontScale\)/,
    "loadSettings must clamp, or a hand-edited settings file bypasses the limit",
  );
  assert.match(
    shell,
    /settings\.fontScale = clampFontScale\(/,
    "the input handler must clamp, or an out-of-range typed value is saved as-is",
  );
});

test("every startup view the app offers actually leads somewhere", () => {
  // Each option is either a mode, a section that exists in the page, or a
  // "section:tool" pair. Anything else opens to an empty window.
  const html = read("index.html");
  const modes = ["lastView", "lastTool", "lastCategory", "home"];
  const sections = new Set(
    [...html.matchAll(/id="section-([a-z-]+)"/g)].map((m) => m[1]),
  );
  const tools = new Set(
    [...slice("src/shell.ts", "const ALL_TOOLS", "];").matchAll(
      /section: "([a-z-]+)", tool: "([a-z-]+)"/g,
    )].map((m) => `${m[1]}:${m[2]}`),
  );

  for (const { value, label } of selectOptions("startupSelect")) {
    if (modes.includes(value)) continue;
    if (value.includes(":")) {
      assert.ok(tools.has(value), `startup option "${label}" points at unknown tool ${value}`);
    } else {
      assert.ok(sections.has(value), `startup option "${label}" points at unknown section ${value}`);
    }
  }
});

test("the startup dropdown lists exactly the tools the app has", () => {
  // Kept in sync by hand: nothing in the app reconciles these two lists.
  const tools = [...slice("src/shell.ts", "const ALL_TOOLS", "];").matchAll(
    /section: "([a-z-]+)", tool: "([a-z-]+)"/g,
  )].map((m) => `${m[1]}:${m[2]}`);
  const listed = selectOptions("startupSelect")
    .map((o) => o.value)
    .filter((v) => v.includes(":"));
  assert.deepEqual([...listed].sort(), [...tools].sort(), "ALL_TOOLS and the dropdown disagree");
});

test("every notification sound file the app references exists (otherwise alerts are silent)", () => {
  const block = slice("src/shell.ts", "const SOUND_PACKS", "];");
  const files = [...block.matchAll(/"(\/sounds\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(files.length > 0, "no sound files parsed, the check is not looking at the right block");
  const missing = files.filter((f) => !exists(`public${f}`));
  assert.deepEqual(missing, [], "these sound files are referenced but not on disk");
});

test("every sound pack offers both a success and an error sound", () => {
  const block = slice("src/shell.ts", "const SOUND_PACKS", "];");
  const packs = [...block.matchAll(/\{\s*id: "([a-z0-9-]+)"[\s\S]*?\}/g)];
  assert.ok(packs.length > 0, "no sound packs parsed");
  for (const [entry, id] of packs.map((m) => [m[0], m[1]])) {
    assert.match(entry, /success:/, `sound pack "${id}" has no success sound`);
    assert.match(entry, /error:/, `sound pack "${id}" has no error sound`);
  }
});

test("the app lock cannot be left in a state with no way back in", () => {
  // A lock.json that exists but is corrupt used to gate the app behind a screen
  // that no credential could satisfy, with Change/Remove sitting behind that
  // same lock. Startup must test the stored hash is USABLE, not just present.
  const rs = read("src-tauri/src/lib.rs");
  assert.match(
    rs,
    /fn lock_is_set\([^)]*\)\s*->\s*bool\s*\{\s*read_valid_lock_hash\(&app\)\.is_some\(\)/,
    "lock_is_set must validate the stored hash, not just check the file exists",
  );
  assert.match(
    rs,
    /parsed\.hash\.is_some\(\) && parsed\.salt\.is_some\(\)/,
    "a truncated hash still parses; the digest and salt must both be required",
  );
});
