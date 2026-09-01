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
  // page. They are recognized by the code assigning the id rather than only
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
    // `#[tauri::command]` or `#[tauri::command(async)]`. The second form is what
    // puts a sync command on a worker thread, and a regex that only knew the
    // first reported those commands as missing.
    const decl = /#\[tauri::command(?:\([^)]*\))?\][\s\S]{0,120}?fn\s+([a-z0-9_]+)/g;
    for (const m of read(file).matchAll(decl)) {
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
    // `#[tauri::command]` or `#[tauri::command(async)]`. The second form is what
    // puts a sync command on a worker thread, and a regex that only knew the
    // first reported those commands as missing.
    const decl = /#\[tauri::command(?:\([^)]*\))?\][\s\S]{0,120}?fn\s+([a-z0-9_]+)/g;
    for (const m of read(file).matchAll(decl)) {
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
  const src = read("src/tool/game-stats.ts");
  // The draft goes through the shared tool-file store like every other tool's
  // own file; what matters here is that both halves are still wired.
  assert.match(
    src,
    /invoke\("save_tool_file", \{ toolId: "game-stats", kind: "draft"/,
    "nothing saves the draft",
  );
  assert.match(
    src,
    /invoke<string>\("load_tool_file", \{ toolId: "game-stats", kind: "draft"/,
    "nothing restores the draft",
  );
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
  // the modal still opens but several of its behaviors silently do nothing,
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

/* -----------------------------------------------------------------------------
   BACK ARROWS INTO GENERAL SETTINGS

   A back arrow means "put me back where I came from". Every panel that has one
   sits behind a button on exactly ONE tab of App Settings, so that tab is
   the answer, and the panel is the one that has to say it: leaving it to the
   Settings modal to remember only works if the person was in Settings in the
   first place, and right-click shortcuts (Customize Home/Sidebar off a Home
   card) reach these panels without ever going through it. Settings then has
   nothing to remember and opens on its first tab, which is the wrong one for
   four of the five.

   The two checks below are the drift guard. The first says every return names
   a tab; the second says the tab it names is the one the button is actually
   sitting in, read out of index.html, so moving a Customize button to another
   tab fails here rather than quietly stranding its back arrow.
----------------------------------------------------------------------------- */

/** Which App Settings tab pane an element sits inside, by position in the
 *  page. Panes are declared in tab order, so the last one that starts before
 *  the element is the one containing it. */
function settingsPaneOf(elementId) {
  const html = read("index.html");
  const start = html.indexOf('id="settingsBackdrop"');
  const end = html.indexOf(
    'class="modal-backdrop"',
    html.indexOf('id="settingsTabPreferences"'),
  );
  const region = html.slice(start, end);
  const at = region.indexOf(`id="${elementId}"`);
  if (at === -1) return null;

  let tab = null;
  for (const [name, id] of [
    ["display", "settingsTabDisplay"],
    ["audio", "settingsTabAudio"],
    ["preferences", "settingsTabPreferences"],
  ]) {
    const paneAt = region.indexOf(`id="${id}"`);
    if (paneAt !== -1 && paneAt < at) tab = name;
  }
  return tab;
}

/* Each panel that leaves App Settings and comes back, paired with the
   control inside Settings that leads to it. The tab is deliberately NOT
   written here: it is read off the page, so this table cannot drift out of
   agreement with the markup. */
const SETTINGS_RETURNS = [
  { button: "sidebarEditBtn", file: "src/core/sidebar-edit.ts", what: "Edit Home/Sidebar" },
  { button: "themeEditBtn", file: "src/theme/theme-picker.ts", what: "Choose Theme" },
  { button: "soundPackEditBtn", file: "src/sound/sound.ts", what: "the sound pickers" },
  { button: "lockChangeBtn", file: "src/core/lockscreen.ts", what: "App Lock" },
  { button: "newVersionToggle", file: "src/core/docs.ts", what: "version notifications" },
];

test("every way back into App Settings names the tab it returns to", () => {
  // shell.ts is exempt: it owns the modal, and its two bare opens are the
  // front doors (the sidebar entry, the title bar / background menus), which
  // are meant to land on a fresh first tab.
  const offenders = [];
  for (const file of filesUnder("src", ".ts")) {
    if (file === "src/core/shell.ts") continue;
    if (read(file).includes("settingsModal.open()")) offenders.push(file);
  }
  assert.deepEqual(
    offenders,
    [],
    "these return to App Settings without saying which tab, so a first-ever open lands on Display",
  );
});

test("a back arrow into App Settings lands on the tab its button lives on", () => {
  for (const { button, file, what } of SETTINGS_RETURNS) {
    const tab = settingsPaneOf(button);
    assert.ok(tab, `#${button} is no longer inside a App Settings tab pane`);
    assert.ok(
      read(file).includes(`openSettingsOnTab("${tab}")`),
      `${what} is reached from the ${tab} tab (#${button}), but ${file} does not return there`,
    );
  }
});

test("a pop-up you come back to is still scrolled where you left it", () => {
  // Leaving a pop-up for a child and returning by the back arrow used to drop
  // you at the top: open() zeroed .modal-body on EVERY open, handoff or not.
  // Only tab panes were spared, and only because ModalTabs deferred their
  // reset, so the behavior existed on the four tabbed setup panels and
  // nowhere else. Every modal in the app scrolls its body, so a long Kanban
  // card, a board archive or a preset list lost your place.
  //
  // The rule now: a modal you LEFT comes back as you left it, a modal you
  // OPEN starts at the top. Same rule, and the same deferral, as the tab.
  const modal = read("src/modal/modal.ts");

  assert.doesNotMatch(
    modal,
    /if \(body\) body\.scrollTop = 0;/,
    "open() must restore the banked position, not zero the body unconditionally",
  );
  assert.match(
    modal,
    /scrollRegions\(\)[\s\S]{0,200}\.modal-body, \.modal-tab-pane/,
    "the body AND the tab panes both scroll, so both have to be banked",
  );
  assert.match(
    modal,
    /if \(opts\.handoff\) \{[\s\S]{0,300}this\.saveScroll\(\)/,
    "stepping aside for a child must bank the scroll position",
  );
  assert.match(
    modal,
    /\} else \{[\s\S]{0,120}this\.forgetScroll\(\)/,
    "a real close must drop the banked position, or the next fresh open is not fresh",
  );
  assert.match(
    modal,
    /heldScrollPositions\)[\s\S]{0,120}forgetScroll\(\)/,
    "a bank nothing came back for must be collected when the stack empties",
  );
  assert.match(
    modal,
    /requestAnimationFrame\(\(\) => \{[\s\S]{0,300}this\.restoreScroll\(\)/,
    "the position must be restored a frame after open, so onOpen cannot render over it",
  );
});

test("a pop-up forgets its tab on every close, handoff or not", () => {
  // This used to be the opposite. A handoff DEFERRED the tab reset so that
  // returning landed on the tab you left from, and the deferral existed
  // because a back arrow only knew which modal to return to, never which tab.
  //
  // That could never answer the case it most needed to: arrive at a child
  // panel from a right-click shortcut, having never been in the parent, and
  // there is no tab to remember. So every back arrow in the app names its
  // destination outright instead, and the memory it replaced is gone.
  //
  // What is left has to STAY unconditional. A tab held across a handoff would
  // silently outrank the tab a back arrow asked for, and only on the routes
  // where the person had been in the parent first, which is the hardest kind
  // of inconsistency to spot.
  const modal = read("src/modal/modal.ts");

  assert.doesNotMatch(
    modal,
    /deferredTabResets/,
    "the deferred tab reset is gone; nothing should be reintroducing it",
  );
  assert.match(
    modal,
    /tabs\?\.reset\(\);[\s\S]{0,60}if \(opts\.handoff\)/,
    "the tab reset must run before the handoff branch, so a handoff cannot skip it",
  );
  assert.equal(
    (modal.match(/tabs\?\.reset\(\)/g) ?? []).length,
    1,
    "there should be exactly one place a modal forgets its tab",
  );
});
