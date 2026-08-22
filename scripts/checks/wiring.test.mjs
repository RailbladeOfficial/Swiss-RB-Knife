/* =============================================================================
   WIRING: does everything the code reaches for actually exist?
   -----------------------------------------------------------------------------
   These all guard the same failure the blank window came from: the code asks
   for something by name, the something isn't there, and the app breaks at a
   point no build step looks at.

   The app wires itself to the page by name, in over a thousand places. Rename an
   element in index.html and nothing complains until the moment that screen is
   opened, or, if the lookup happens as the app starts, until the window opens
   empty. Same for the commands the front end asks the Rust side to run: a
   mistyped name is silently fine until a user presses that button.
============================================================================= */

import test from "node:test";
import assert from "node:assert/strict";
import { read, filesUnder, htmlIds, htmlIdList } from "./_source.mjs";

const ids = htmlIds();

test("every element the app looks up by name exists in the page", () => {
  // Over a thousand lookups. If one is missing, that screen breaks the moment
  // it opens, or the whole app fails to start if the lookup runs at launch.
  const referenced = new Map(); // id -> file that asks for it
  for (const file of filesUnder("src", ".ts")) {
    for (const m of read(file).matchAll(
      /getElementById\(\s*["']([A-Za-z0-9_-]+)["']\s*\)(\?)?/g,
    )) {
      // `getElementById("x")?.` means the code already handles the element not
      // being there, so its absence is a deliberate choice rather than a fault.
      if (m[2] === "?") continue;
      if (!referenced.has(m[1])) referenced.set(m[1], file);
    }
  }
  assert.ok(referenced.size > 500, `expected many lookups, found ${referenced.size}`);

  // Elements the app creates itself at runtime are legitimately absent from the
  // page. They are recognised by the code assigning the id rather than only
  // reading it.
  const source = filesUnder("src", ".ts").map(read).join("\n");
  const createdAtRuntime = new Set(
    [...source.matchAll(/\.id\s*=\s*["']([A-Za-z0-9_-]+)["']/g)].map((m) => m[1]),
  );

  const missing = [...referenced]
    .filter(([id]) => !ids.has(id) && !createdAtRuntime.has(id))
    .map(([id, file]) => `${id} (asked for in ${file})`);
  assert.deepEqual(missing, [], "these elements are looked up but do not exist in index.html");
});

test("no two elements in the page share a name", () => {
  // A duplicate id means the app silently talks to whichever came first, and
  // the other one quietly does nothing forever.
  const all = htmlIdList();
  const dupes = [...new Set(all.filter((v, i) => all.indexOf(v) !== i))];
  assert.deepEqual(dupes, [], "these ids appear more than once in index.html");
});

test("every action the app asks the backend to run actually exists there", () => {
  // A mistyped or removed command name is invisible until a user presses that
  // exact button, and then it just fails.
  const invoked = new Set();
  for (const file of filesUnder("src", ".ts")) {
    for (const m of read(file).matchAll(/invoke(?:<[^>]*>)?\(\s*["']([a-z0-9_]+)["']/g)) {
      invoked.add(m[1]);
    }
  }
  assert.ok(invoked.size > 40, `expected many backend calls, found ${invoked.size}`);

  const defined = new Set();
  for (const file of filesUnder("src-tauri/src", ".rs")) {
    for (const m of read(file).matchAll(/#\[tauri::command\][\s\S]{0,120}?fn\s+([a-z0-9_]+)/g)) {
      defined.add(m[1]);
    }
  }
  const undefinedCalls = [...invoked].filter((c) => !defined.has(c));
  assert.deepEqual(undefinedCalls, [], "the app calls these backend actions, which do not exist");
});

test("every backend action the app calls is switched on", () => {
  // Defining a command is not enough; it also has to be listed in the handler.
  // A command that exists but is unlisted fails at the moment it is called.
  const lib = read("src-tauri/src/lib.rs");
  const start = lib.indexOf("generate_handler!");
  assert.notEqual(start, -1, "could not find the command registration list");
  const block = lib.slice(start, lib.indexOf("]", start));
  // Entries may be plain (`load_settings,`) or namespaced
  // (`tools::budget::load_budget_data,`); the last segment is the name.
  const registered = new Set([...block.matchAll(/([a-z0-9_]+)\s*,/g)].map((m) => m[1]));

  const invoked = new Set();
  for (const file of filesUnder("src", ".ts")) {
    for (const m of read(file).matchAll(/invoke(?:<[^>]*>)?\(\s*["']([a-z0-9_]+)["']/g)) {
      invoked.add(m[1]);
    }
  }
  const unregistered = [...invoked].filter((c) => !registered.has(c));
  assert.deepEqual(unregistered, [], "these backend actions are called but not switched on");
});

test("no backend action exists that nothing ever calls", () => {
  // Guards against half-built features: plumbing written, registered, and then
  // never connected to a button. The Game Stats draft commands sat like that
  // for a while, which meant an in-progress game was silently lost on close
  // even though the code to save it existed.
  //
  // If this fails because you have deliberately landed a command ahead of its
  // UI, wire it up or take it out; do not just delete the test.
  const defined = new Map();
  for (const file of filesUnder("src-tauri/src", ".rs")) {
    for (const m of read(file).matchAll(/#\[tauri::command\][\s\S]{0,120}?fn\s+([a-z0-9_]+)/g)) {
      defined.set(m[1], file);
    }
  }
  const invoked = new Set();
  for (const file of filesUnder("src", ".ts")) {
    for (const m of read(file).matchAll(/invoke(?:<[^>]*>)?\(\s*["']([a-z0-9_]+)["']/g)) {
      invoked.add(m[1]);
    }
  }
  const unused = [...defined]
    .filter(([name]) => !invoked.has(name))
    .map(([name, file]) => `${name} (${file})`);
  assert.deepEqual(unused, [], "these backend actions exist but nothing calls them");
});

test("the Game Stats draft is actually saved, restored and cleared", () => {
  // Specifically pinned because this feature was plumbed and left unconnected
  // once already. Presence of the commands is not enough; all three moments
  // have to be wired or a draft either never appears or never goes away.
  const src = read("src/tools/game-stats.ts");
  assert.match(src, /invoke\("save_game_stats_draft"/, "nothing saves the draft");
  assert.match(src, /invoke<string>\("load_game_stats_draft"\)/, "nothing restores the draft");
  assert.match(src, /function clearGameStatsDraft/, "nothing clears the draft");
  // Cleared on both endings, or a saved/abandoned game returns next launch.
  for (const fn of ["saveNewGame", "cancelNewGame", "resetNewGameSetup"]) {
    const body = src.slice(src.indexOf(`function ${fn}(`));
    assert.match(
      body.slice(0, body.indexOf("\n}")),
      /clearGameStatsDraft\(\)/,
      `${fn}() does not clear the stored draft`,
    );
  }
});

test("every pop-up panel is built correctly", () => {
  // Each pop-up is a dimmed backdrop wrapping a panel. If the panel is missing,
  // the modal still opens but several of its behaviours silently do nothing,
  // because the code that positions and sizes it has nothing to hold.
  const html = read("index.html");
  const backdrops = [...html.matchAll(/<div\s+id="([^"]+)"[^>]*class="[^"]*modal-backdrop[^"]*"[^>]*>/g)];
  assert.ok(backdrops.length > 50, `expected many pop-ups, found ${backdrops.length}`);

  const anonymous = [...html.matchAll(/class="[^"]*modal-backdrop[^"]*"/g)].length;
  assert.equal(
    backdrops.length,
    anonymous,
    "some pop-up backdrops have no id, so nothing can open them",
  );

  // Each pop-up's contents run from the end of its own opening tag to the start
  // of the next pop-up's. Measured from the tag positions the regex already
  // found, rather than by searching for the next "modal-backdrop" occurrence,
  // which lands inside the SAME element's class attribute.
  for (let i = 0; i < backdrops.length; i++) {
    const id = backdrops[i][1];
    const contentsStart = backdrops[i].index + backdrops[i][0].length;
    const contentsEnd = i + 1 < backdrops.length ? backdrops[i + 1].index : html.length;
    const region = html.slice(contentsStart, contentsEnd);
    assert.match(region, /class="[^"]*\bmodal\b[^"]*"/, `pop-up "${id}" has no panel inside it`);
  }
});

test("every tabbed pop-up points its tabs at panels that exist", () => {
  // A tab whose panel is missing switches to a blank area with no error.
  const source = filesUnder("src", ".ts").map(read).join("\n");
  const strips = [...source.matchAll(/new ModalTabs[\s\S]{0,900}?\}\);/g)].map((m) => m[0]);
  assert.ok(strips.length > 0, "no tab strips found, the check is not looking in the right place");

  const problems = [];
  for (const strip of strips) {
    const scope = /scope:\s*"([^"]+)"/.exec(strip);
    if (scope && scope[1].startsWith("#") && !ids.has(scope[1].slice(1))) {
      problems.push(`tab strip owner ${scope[1]} does not exist`);
    }
    const panes = /panes:\s*\{([\s\S]*?)\}/.exec(strip);
    if (!panes) continue;
    for (const p of panes[1].matchAll(/["']?([A-Za-z0-9_-]+)["']?\s*:\s*"([A-Za-z0-9_-]+)"/g)) {
      if (!ids.has(p[2])) problems.push(`tab "${p[1]}" points at missing panel "${p[2]}"`);
    }
  }
  assert.deepEqual(problems, []);
});
