/* =============================================================================
   KANBAN
   -----------------------------------------------------------------------------
   The Kanban tool makes two promises the rest of the app never has to, and
   both fail silently if broken.

   The first is CONTRAST. A card can be painted a color the theme knows nothing
   about, and its title text is then chosen rather than inherited. A palette
   entry that no ink reads well on produces a card that is simply hard to read,
   with nothing anywhere reporting a problem.

   The second is that its PREFERENCES round-trip. Every On/Off switch is wired
   in two separate places, one to write the setting and one to restore it on the
   next open. Miss the second and the switch works perfectly right up until you
   reopen Setup, where it has quietly reverted. The check counts the switches
   off the page rather than against a number written here, which is what stops
   this note going stale the next time one is added.

   Plus the usual house rule: the lists the code walks in parallel have to hold
   the same keys, and the one command that deletes a file has to be the one that
   checks where the file is.
============================================================================= */

import test from "node:test";
import assert from "node:assert/strict";
import { read, slice, htmlIds } from "./_source.mjs";

const ts = () => read("src/tool/kanban.ts");

/* -----------------------------------------------------------------------------
   WCAG relative luminance and contrast ratio, reimplemented here rather than
   imported. kanban.ts touches the DOM as it loads, so a test process cannot
   import it; and an independent implementation is the stronger check anyway,
   since a bug copied from the source would agree with itself.
----------------------------------------------------------------------------- */

function luminance(hex) {
  const n = parseInt(hex.replace("#", ""), 16);
  const channel = (c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return (
    0.2126 * channel((n >> 16) & 255) +
    0.7152 * channel((n >> 8) & 255) +
    0.0722 * channel(n & 255)
  );
}

function contrast(a, b) {
  const [hi, lo] = luminance(a) > luminance(b) ? [luminance(a), luminance(b)] : [luminance(b), luminance(a)];
  return (hi + 0.05) / (lo + 0.05);
}

function inks() {
  const src = ts();
  const dark = /const DARK_INK = "(#[0-9a-f]{6})"/i.exec(src);
  const light = /const LIGHT_INK = "(#[0-9a-f]{6})"/i.exec(src);
  assert.ok(dark && light, "could not find the two ink colors in kanban.ts");
  return [dark[1], light[1]];
}

test("every card color has an ink that reads on it", () => {
  // 4.5:1 is the WCAG AA threshold for normal-size text. A card title below it
  // is legible in the sense that the pixels are there and unreadable in the
  // sense that matters.
  const block = slice("src/tool/kanban.ts", "const CARD_COLORS", "];");
  const colors = [...block.matchAll(/"(#[0-9a-f]{6})"/gi)].map((m) => m[1]);
  assert.ok(colors.length >= 8, `expected the card palette, parsed ${colors.length}`);

  const [dark, light] = inks();
  const bad = colors
    .map((c) => ({ c, best: Math.max(contrast(c, dark), contrast(c, light)) }))
    .filter((x) => x.best < 4.5)
    .map((x) => `${x.c} (best ratio ${x.best.toFixed(2)}:1)`);

  assert.deepEqual(bad, [], "no ink reads well enough on these card colors");
});

test("the two inks are far enough apart to be a real choice", () => {
  // If the dark and light inks were close, picking between them would be
  // theatre: every color would land on whichever happened to win, and the
  // check above would pass while doing nothing.
  const [dark, light] = inks();
  assert.ok(
    contrast(dark, light) > 15,
    `the two inks only differ by ${contrast(dark, light).toFixed(1)}:1`,
  );
});

test("the three stage lists hold the same stages", () => {
  // STAGES drives the Advance button, STAGE_LABELS names the rows, and
  // ADVANCE_LABELS is what the button says next. A stage missing from one of
  // them renders as "undefined" on screen rather than as any kind of error.
  const src = ts();
  const stages = [...slice("src/tool/kanban.ts", "export const STAGES", "as const;").matchAll(
    /"([a-z]+)"/g,
  )].map((m) => m[1]);
  assert.deepEqual(stages, ["started", "testing", "completed"], "the stage order changed");

  for (const [name, marker] of [
    ["STAGE_LABELS", "export const STAGE_LABELS"],
    ["ADVANCE_LABELS", "export const ADVANCE_LABELS"],
  ]) {
    const block = slice("src/tool/kanban.ts", marker, "};");
    const keys = [...block.matchAll(/^\s{2}([a-z]+):/gm)].map((m) => m[1]);
    assert.deepEqual(keys.sort(), [...stages].sort(), `${name} does not match STAGES`);
  }

  // CardDates carries the three stamps plus the due date, which is deliberately
  // NOT a stage (it is a target, not a thing that happened).
  const dates = slice("src/tool/kanban.ts", "export interface CardDates", "}");
  for (const stage of [...stages, "due"]) {
    assert.match(dates, new RegExp(`\\b${stage}:`), `CardDates has no ${stage} field`);
  }
  assert.ok(!src.includes('STAGES = ["due"'), "due must not be a stage");
});

test("every Kanban preference is both saved and restored", () => {
  // Each switch is wired twice, in bindPreferenceControls (write) and in
  // applySettingsToForm (restore). One without the other is a setting that
  // works until you reopen Setup and find it reverted, with nothing logged.
  //
  // BOTH panes, because the settings are split across two tabs now: Defaults
  // is what a board follows unless it overrides it, Preferences is what is
  // true of the tool whichever board you are on. The wiring rule is the same
  // on either side of that line, so it is checked across both.
  const html = read("index.html");
  const pane = html.slice(
    html.indexOf('id="kbTabDefaults"'),
    html.indexOf('id="kbTabData"'),
  );
  assert.ok(pane.length > 500, "could not isolate the Kanban preference panes");

  const toggles = [...pane.matchAll(/id="(kb[A-Za-z]+Toggle)"/g)].map((m) => m[1]);
  const selects = [...pane.matchAll(/id="(kb[A-Za-z]+Select)"/g)].map((m) => m[1]);
  const fields = [...pane.matchAll(/id="(kb[A-Za-z]+Input)"/g)].map((m) => m[1]);
  assert.ok(toggles.length >= 6, `expected the preference switches, found ${toggles.length}`);

  const bind = slice("src/tool/kanban.ts", "function bindPreferenceControls", "\n}");
  const apply = slice("src/tool/kanban.ts", "function applySettingsToForm", "\n}");

  const problems = [];
  for (const id of [...toggles, ...selects, ...fields]) {
    if (!bind.includes(`"${id}"`)) problems.push(`${id} is never saved`);
    if (!apply.includes(`"${id}"`)) problems.push(`${id} is never restored`);
  }
  assert.deepEqual(problems, []);
});

test("every preference switch has a label that says which way it is set", () => {
  // A toggle whose label never moves reads as broken even when the setting is
  // applying correctly.
  const html = read("index.html");
  const pane = html.slice(
    html.indexOf('id="kbTabDefaults"'),
    html.indexOf('id="kbTabData"'),
  );
  const ids = htmlIds();
  const missing = [...pane.matchAll(/id="kb([A-Za-z]+)Toggle"/g)]
    .map((m) => `kb${m[1]}Label`)
    .filter((labelId) => !ids.has(labelId));
  assert.deepEqual(missing, [], "these switches have no label element to update");
});

test("more than one tool can hold the mouse back/forward buttons", () => {
  // This used to be a single slot, which was correct only while exactly one
  // tool used it. Game Stats and Kanban both register now: with a single slot
  // whichever started last would silently take the buttons from the other, and
  // the symptom is "back stopped working" with nothing to blame.
  const shell = read("src/core/shell.ts");
  assert.match(
    shell,
    /const subNavHandlers: SubNavHandler\[\]/,
    "the sub-navigation registry is not a list",
  );
  assert.match(shell, /subNavHandlers\.some\(/, "handlers are not all given a chance to answer");

  const registrars = ["src/tool/game-stats.ts", "src/tool/kanban.ts"].filter((f) =>
    read(f).includes("setSubNavHandler({"),
  );
  assert.deepEqual(
    registrars,
    ["src/tool/game-stats.ts", "src/tool/kanban.ts"],
    "both tools should claim the mouse buttons",
  );

  // Each one's first job is to check it is actually on screen, which is what
  // makes holding a registration permanently safe. assert.ok rather than
  // assert.match: a failing match here would print the whole source file.
  for (const file of registrars) {
    assert.ok(
      /if \(!\w*ToolIsVisible\(\)/.test(read(file)),
      `${file} does not check whether its tool is visible before claiming a press`,
    );
  }
});

test("board background images can only be deleted from inside their own folder", () => {
  // delete_kanban_image takes a path from the front end and unlinks it. The
  // stored board path is the only thing that should ever reach it, but a
  // hand-edited kanban-index.json must not turn it into a general delete.
  const rs = read("src-tauri/src/tools/kanban.rs");
  const fn = rs.slice(rs.indexOf("pub fn delete_kanban_image"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.match(body, /canonicalize\(\)/, "the path is not resolved before being checked");
  assert.match(body, /starts_with\(&dir\)/, "the path is not checked against the image folder");
  assert.ok(
    body.indexOf("starts_with(&dir)") < body.indexOf("remove_file"),
    "the containment check must come before the delete",
  );
});










test("card order is committed on dragend, not on drop", () => {
  // dragend fires however the drag ends (on a column, on the padding, outside
  // the window, canceled with Escape). Committing on drop instead leaves the
  // already-reordered DOM disagreeing with the stored order every time the
  // release lands anywhere else. Same rule as sidebar-edit.ts.
  const src = ts();
  const drop = src.slice(src.indexOf('body.addEventListener("drop"'));
  assert.ok(
    !drop.slice(0, 200).includes("commitCardOrderFromDom"),
    "the drop handler commits, which misses every drag that ends elsewhere",
  );
  const dragend = src.slice(src.indexOf('el.addEventListener("dragend"'));
  assert.match(
    dragend.slice(0, 300),
    /commitCardOrderFromDom/,
    "nothing commits the new order when a card drag ends",
  );
});

test("the tool refuses to be entered before it has initialized", () => {
  // Not defensiveness for its own sake. shell.ts calls loadShellState() at the
  // TOP of its init and every init*() at the bottom, so an install whose saved
  // startup target is this tool navigates into it, and fires its entry hook,
  // before a single element reference here has been assigned. Kanban's hooks
  // touch pre-assigned refs, so without this the app crashes on launch and the
  // only way out is hand-editing the settings file.
  const src = ts();
  assert.match(src, /let initialized = false;/, "there is no initialized flag");
  assert.match(src, /\n  initialized = true;/, "the flag is never set");

  for (const hook of ["onKanbanToolEntry", "onKanbanIconClicked", "onKanbanToolExit"]) {
    const at = src.search(new RegExp(String.raw`export (?:async )?function ${hook}\(`));
    assert.notEqual(at, -1, `${hook} does not exist`);
    const body = src.slice(at, src.indexOf("\n}", at));
    assert.ok(
      /if \(!initialized\) return;/.test(body),
      `${hook} runs before init has, which is a crash on launch`,
    );
  }
});

test("only one place decides which pane is on screen", () => {
  // Two places used to set these displays and they disagreed with each other:
  // clicking the sidebar icon while one had hidden a pane unhid it again. So
  // exactly one function may touch them.
  const src = ts();
  const at = src.indexOf("function applyViewVisibility(");
  assert.notEqual(at, -1, "applyViewVisibility does not exist");
  const owner = src.slice(at, src.indexOf("\n}", at));
  assert.ok(
    owner.includes("viewBoards.style.display"),
    "the one owner does not place the gallery",
  );

  // Every other assignment to these elements' display is a bug.
  const strays = [];
  for (const [line] of src.matchAll(
    /^\s*(?:viewBoards|viewBoard|boardSetupBtn)\.style\.display\s*=.*$/gm,
  )) {
    if (!owner.includes(line.trim())) strays.push(line.trim());
  }
  assert.deepEqual(strays, [], "these set a pane's visibility outside applyViewVisibility");
});

test("board-overridable settings are read through the resolver, never off the defaults", () => {
  // A board's override only means anything if every render site asks
  // effective(board) rather than kbSettings. One direct read is one setting
  // that silently ignores the board it is on.
  const src = ts();
  // The tool-wide settings, which have no per-board answer and are read
  // directly on purpose.
  const allowed = [
    "defaultColumns",
    "defaultBoardName",
    "lockOnOpen",
    "sectionOrder",
    // How the GALLERY is ordered, which is a fact about the list of boards
    // rather than about any one of them. A board cannot override where it
    // sits any more than a tool can override the sidebar's sort.
    "boardSort",
    // The two scales. Tool-wide on purpose: a level called "Huge" on one board
    // and "Epic" on another would make a card's chip mean different things
    // depending on where you were standing.
    "priorityColors",
    "priorityLabels",
    "effortColors",
    "effortLabels",
  ];

  /* A short list may touch the defaults directly, because handling the defaults
     IS their job: the resolver that merges them with a board's overrides, the
     two halves of the Preferences tab that read and write them, and the sort
     editor, which is the one screen that edits all three levels and therefore
     has to be able to address the tool default by name. */
  const exempt = [
    "function effective(board: Board | null)",
    "function bindPreferenceControls(",
    "function applySettingsToForm(",
    "function sortEditRules(",
    "function setSortEditRules(",
    "function renderColumnSortSummary(",
  ].map((marker) => {
    const at = src.indexOf(marker);
    assert.notEqual(at, -1, `could not find ${marker}`);
    return [at, src.indexOf("\n}", at)];
  });

  const strays = [];
  for (const m of src.matchAll(/kbSettings\.([A-Za-z]+)/g)) {
    if (exempt.some(([from, to]) => m.index > from && m.index < to)) continue;
    if (allowed.includes(m[1])) continue;
    const line = src.slice(src.lastIndexOf("\n", m.index) + 1, src.indexOf("\n", m.index));
    strays.push(`${m[1]} (${line.trim()})`);
  }
  assert.deepEqual(strays, [], "these read a board-overridable setting without asking the board");
});

test("every board-overridable setting survives being written and read back", () => {
  /* normalizeOverrides keeps a hand-written list of the keys it will read. A
     boolean added to BoardScopedSettings and not to that list is written to
     disk, dropped on the way back in, and the board falls back to the tool
     default: the setting takes, looks right, and is gone next launch. That is
     what happened to openCardsInEditMode.

     The interface is the contract; this list has to match it. */
  const src = ts();

  const iface = src.slice(
    src.indexOf("export interface BoardScopedSettings {"),
    src.indexOf("\n}", src.indexOf("export interface BoardScopedSettings {")),
  );
  assert.ok(iface.length > 0, "BoardScopedSettings is gone");
  /* EVERY key, not only the booleans. The booleans were the ones that had gone
     missing before, so that is what this checked, and a non-boolean added
     later (defaultSort) went quiet in exactly the same way: saved, dropped on
     the way back in, and the board silently on the tool default again. The
     contract is the interface, so the check has to be the whole interface. */
  const declared = [...iface.matchAll(/^\s{2}([A-Za-z]+)[?]?:/gm)].map((m) => m[1]);
  assert.ok(declared.length > 8, `only found ${declared.length} board settings`);

  const at = src.indexOf("export function normalizeOverrides");
  const body = src.slice(at, src.indexOf("\n}", at));
  /* Named in the boolean list, or handled by name in the body: cardSize,
     sectionOrder and defaultSort each have their own branch, which counts. */
  const listed = [...body.matchAll(/"([A-Za-z]+)",/g)].map((m) => m[1]);

  const missing = declared.filter(
    (key) => !listed.includes(key) && !body.includes(`src.${key}`),
  );
  assert.deepEqual(
    missing,
    [],
    "these board settings are dropped when a board's overrides are read back",
  );
});

test("a board override stores only what the board disagrees about", () => {
  // Writing the current default into every key would freeze it: changing the
  // default later would stop reaching boards that never disagreed with it,
  // which is the entire point of the feature.
  const src = ts();
  const at = src.indexOf("export function normalizeOverrides");
  assert.notEqual(at, -1, "normalizeOverrides does not exist");
  const body = src.slice(at, src.indexOf("\n}", at));
  assert.ok(
    !body.includes("DEFAULT_SETTINGS") && !body.includes("kbSettings"),
    "normalizeOverrides fills in defaults, so an unset row would become a pinned one",
  );

  // And setting a row back to Default must DELETE the key, not store a value.
  for (const fn of ["buildOverrideRow", "buildOverrideSelect"]) {
    const fnAt = src.indexOf(`function ${fn}(`);
    assert.notEqual(fnAt, -1, `${fn} does not exist`);
    const fnBody = src.slice(fnAt, src.indexOf("\n}", fnAt));
    assert.ok(
      /delete board\.overrides\[/.test(fnBody),
      `${fn} never deletes the key, so "Default" would be stored as a value`,
    );
  }
});

test("tags are resolved against a board and never against one global list", () => {
  // Two boards can hold entirely different versions under the same category
  // name. That only works if nothing looks a tag up in an app-wide list.
  const src = ts();
  assert.match(
    src,
    /let globalTagCategories: TagCategory\[\]/,
    "the default vocabulary is not held separately",
  );
  assert.ok(
    !/^let tags: Tag\[\]/m.test(src) && !/^let tagCategories: TagCategory\[\]/m.test(src),
    "an app-wide tag list still exists",
  );

  const at = src.indexOf("function renderCardTags(");
  const body = src.slice(at, src.indexOf("\n}", at));
  assert.ok(
    body.includes("getBoard(card.boardId)"),
    "the card's tag picker does not scope to the card's board",
  );
});

test("copying the defaults onto a board gives the board its own tags", () => {
  // Shared ids would make a board's tags an alias of the defaults, so editing a
  // default would silently rewrite tags already sitting on cards.
  const src = ts();
  const at = src.indexOf("function copyDefaultTagsToBoard(");
  assert.notEqual(at, -1, "copyDefaultTagsToBoard does not exist");
  const body = src.slice(at, src.indexOf("\n}", at));
  assert.ok(body.includes("id: newId()"), "the copies reuse the defaults' ids");
  assert.ok(
    body.includes("toLowerCase()"),
    "copying twice should match on name rather than duplicating everything",
  );
});

test("the card modal has no save button and no destructive buttons in its body", () => {
  // Every edit applies live, so a Save button could only ever be a way to
  // believe work was lost. Archive and Delete moved to the three-dot menu, off
  // the surface you are typing on.
  const html = read("index.html");
  const modal = html.slice(
    html.indexOf('id="kbCardBackdrop"'),
    html.indexOf('id="kbCardColorBackdrop"'),
  );
  assert.ok(modal.length > 500, "could not isolate the card modal");
  for (const gone of [
    "kbCardDoneBtn",
    "kbCardArchiveBtn",
    "kbCardDeleteBtn",
    "kbCardColorClearBtn",
  ]) {
    assert.ok(!modal.includes(gone), `${gone} is back in the card modal body`);
  }

  const src = ts();
  const at = src.indexOf('document.getElementById("kbCardMenuBtn")');
  const body = src.slice(at, src.indexOf("\n  });", at));
  for (const item of ["Card Color", "Card Stats", "Delete Card"]) {
    assert.ok(body.includes(item), `the card menu is missing "${item}"`);
  }
});

test("there is exactly one control for giving a card no color", () => {
  // There were two, saying the same thing, one directly under the other.
  const src = ts();
  const at = src.indexOf("function renderCardColors(");
  const body = src.slice(at, src.indexOf("\n}", at));
  const clears = [...body.matchAll(/card\.color = null;/g)].length;
  assert.equal(clears, 1, `found ${clears} ways to clear the color; there should be one`);
});

test("every card modal block can be reordered and the anchors cannot", () => {
  // The title and the board/column/priority row are what tell you WHICH card
  // you are looking at, so they sit outside the reorderable region. Everything
  // else, the due date included, is content and can be moved.
  const html = read("index.html");
  const src = ts();
  const sections = [...html.matchAll(/data-kb-section="([a-z]+)"/g)].map((m) => m[1]);

  const listed = [
    ...slice("src/tool/kanban.ts", "export const CARD_SECTIONS", "];").matchAll(/"([a-z]+)"/g),
  ].map((m) => m[1]);
  assert.deepEqual(
    [...sections].sort(),
    [...listed].sort(),
    "the page's card blocks and CARD_SECTIONS disagree",
  );

  const labels = slice("src/tool/kanban.ts", "export const CARD_SECTION_LABELS", "};");
  for (const section of listed) {
    assert.match(labels, new RegExp(`\\b${section}:`), `${section} has no label`);
  }

  const hostAt = html.indexOf('id="kbCardSections"');
  const before = html.slice(html.indexOf('id="kbCardBackdrop"'), hostAt);
  assert.ok(before.includes("kbCardTitleInput"), "the title should be above the blocks");
  assert.ok(before.includes("kbCardPrioritySelect"), "priority should be above the blocks");
  assert.ok(src.includes("function applyCardSectionOrder"), "nothing applies the order");
});

test("an existing board is set up from inside itself, never from the tool's Setup", () => {
  // The tool's Boards tab is what a NEW board is made OF. It must not become a
  // list of the boards you have: those are edited from inside themselves, which
  // is the only place their contents are decrypted and in memory.
  const html = read("index.html");
  const boardsTab = html.slice(
    html.indexOf('id="kbTabBoards"'),
    html.indexOf('id="kbTabTags"'),
  );
  assert.ok(boardsTab.length > 200, "could not isolate the tool Setup's Boards tab");
  /* The columns themselves are edited on their own screen now, like every
     other list-valued setting in this tool, so the tab holds the ROW that
     reaches them rather than the list. */
  assert.ok(
    boardsTab.includes("kbDefaultColumnsEditBtn") && boardsTab.includes("kbDefaultBoardNameInput"),
    "the Boards tab should hold the defaults for a new board",
  );
  assert.ok(
    !boardsTab.includes("kbDefaultColumnsList"),
    "the default columns are being edited inline in a list of settings again",
  );
  assert.ok(
    !boardsTab.includes("kbSetupBoardsList"),
    "the Boards tab is listing existing boards again",
  );

  assert.ok(html.includes('id="kbBoardSetupBackdrop"'), "there is no Board Setup modal");
  assert.ok(html.includes('id="kbBoardSetupBtn"'), "there is no way into Board Setup from a board");
});

test("the system default columns are the five agreed ones, with the last meaning done", () => {
  // Pinned because they are the first thing anyone sees on a new board, and a
  // silent change to them is a silent change to what the tool suggests you do.
  const src = ts();
  const m = /const SYSTEM_DEFAULT_COLUMNS = "([^"]+)"/.exec(src);
  assert.ok(m, "could not find the system default column set");

  const parts = m[1].split(",").map((t) => t.trim());
  const names = parts.map((t) => (t.endsWith("*") ? t.slice(0, -1).trim() : t));
  assert.deepEqual(names, [
    "Backlog",
    "Planned",
    "Work In Progress",
    "Testing",
    "Completed",
  ]);

  // Exactly one done marker, on the last column.
  const marked = parts.filter((t) => t.endsWith("*"));
  assert.equal(marked.length, 1, "there should be exactly one done column");
  assert.equal(marked[0], parts[parts.length - 1], "the done column should be the last one");

  // And Reset has to put back that constant rather than a second copy of it.
  assert.match(
    src,
    /kbSettings\.defaultColumns = SYSTEM_DEFAULT_COLUMNS;/,
    "Reset does not restore the system default set",
  );
  assert.match(
    src,
    /defaultColumns: SYSTEM_DEFAULT_COLUMNS,/,
    "a fresh install does not start from the system default set",
  );
});

test("exactly one default column can mean done", () => {
  // Two would make throughput ambiguous and the complete-on-drop stamp
  // arbitrary, so marking one has to unmark the others.
  const src = ts();
  const at = src.indexOf('done.addEventListener("click"');
  assert.notEqual(at, -1, "the done marker is not wired");
  const body = src.slice(at, at + 700);
  assert.ok(
    body.includes("splitDoneMark(t).title"),
    "marking one done does not strip the marker from the others",
  );
});

test("the due date survives stage dates being switched off", () => {
  // A due date is a target rather than a record of something that happened, and
  // it is what the overdue warning reads, so it is not part of the optional
  // block and must not be hidden with it.
  const html = read("index.html");
  const stagesAt = html.indexOf('data-kb-section="stages"');
  const stagesBlock = html.slice(stagesAt, html.indexOf('id="kbCardColorBackdrop"'));
  assert.ok(!stagesBlock.includes("kbCardDueInput"), "the due date is inside the stages block");

  const src = ts();
  const at = src.indexOf("function renderCardModal(");
  const body = src.slice(at, src.indexOf("\n}", at));
  assert.ok(body.includes("renderCardDue(card)"), "the due row is never rendered");
  assert.ok(body.includes("settings.showStages"), "the stages block is not gated on the setting");
});

test("a tag editor can always get back to the list it was opened from", () => {
  // Board Setup is closed with a handoff to open the tag editor, and a handoff
  // still runs onClosed a moment later, which clears boardEditId. Reading that
  // on the way back meant saving a board tag closed the editor and reopened
  // nothing.
  const src = ts();
  const at = src.indexOf("function returnToTagList(");
  assert.notEqual(at, -1, "returnToTagList does not exist");
  const body = src.slice(at, src.indexOf("\n}", at));
  assert.ok(
    body.includes("tagEditBoardId"),
    "the return path reads state the modal it is returning to has already cleared",
  );
  assert.ok(!body.includes("boardEditId"), "boardEditId is gone by the time this runs");
});

test("nothing in this tool stacks a modal on another", () => {
  // Two dimmed panels deep is where it stops being obvious which one the
  // buttons belong to, and the panel most likely to be on top is the one that
  // deletes things. So a confirm and a password prompt REPLACE what they were
  // launched from, and every launch has to say how to get back.
  const src = ts();

  for (const fn of ["function kbConfirm("]) {
    const at = src.indexOf(fn);
    assert.notEqual(at, -1, `${fn} does not exist`);
    const body = src.slice(at, src.indexOf("\n}", at));
    assert.ok(
      body.includes("topOpenKanbanModal()?.close({ handoff: true })"),
      `${fn} opens over whatever is already there instead of replacing it`,
    );
  }

  // Every destructive confirm names its way back. Without one, dismissing it
  // drops you on the board rather than where you started.
  const missing = [];
  for (const m of src.matchAll(/kbConfirm\(\s*\{([\s\S]{0,700}?)\},/g)) {
    // "reopen: fn" and the shorthand "reopen," are the same property; both
    // count, and anything else is a confirm with no way back.
    if (!/\breopen\s*[,:]/.test(m[1])) {
      const title = /title: ([^\n]*)/.exec(m[1]);
      missing.push(title ? title[1].trim() : m[1].slice(0, 60));
    }
  }
  // requestDeleteCard forwards its caller's, so its own literal has one too.
  assert.deepEqual(missing, [], "these confirms have no way back");
});

test("a dismissed confirm goes back however it was dismissed", () => {
  // Cancel, Escape and the mouse back button are all dismissals and all owe the
  // same journey. Escape does not go through the Cancel handler, so the hook
  // that runs on every close is where the fallback has to live.
  const src = ts();
  const at = src.indexOf('_confirmModal = new Modal(');
  assert.notEqual(at, -1, "the confirm modal is not built here");
  const body = src.slice(at, at + 900);
  assert.ok(
    /onClosed: \(\) => \{[\s\S]*?back\?\.\(\)/.test(body),
    "closing the confirm any other way than Cancel does not reopen what it replaced",
  );
});

test("where a new card lands is decided by the button, not by a setting", () => {
  // The + in the column header means the top and the button at the foot means
  // the bottom, so there is nothing left for a preference to say.
  const src = ts();
  const html = read("index.html");
  assert.ok(!html.includes("kbNewCardPositionSelect"), "the position setting is still in the page");
  assert.ok(
    !/newCardPosition: /.test(src),
    "newCardPosition is still stored as a setting",
  );

  // Both call sites pass an explicit end.
  assert.match(src, /openQuickAdd\(board, column, footer, addBtn, "bottom"\)/, "the foot button does not add to the bottom");
  assert.match(src, /openQuickAdd\(board, column, footer, addBtn, "top"\)/, "the header button does not add to the top");
});

test("a section the stored order has never seen lands where the default puts it", () => {
  // Appending was the obvious thing and it was wrong: an order saved before Due
  // Date existed got Due Date after Stage Dates, which is not the default and
  // not what anyone asked for.
  const src = ts();
  const at = src.indexOf("export function normalizeSectionOrder");
  const body = src.slice(at, src.indexOf("\n}", at));
  assert.ok(body.includes("splice("), "missing sections are appended rather than placed");
  assert.ok(
    !/out\.push\(section\)/.test(body),
    "a missing section is still being pushed onto the end",
  );

  // And the default itself has Due before Stages.
  const order = /sectionOrder: \[([^\]]*)\]/.exec(
    slice("src/tool/kanban.ts", "const DEFAULT_SETTINGS", "};"),
  );
  assert.ok(order, "could not find the default section order");
  const list = order[1].split(",").map((t) => t.trim().replace(/"/g, ""));
  assert.ok(
    list.indexOf("due") < list.indexOf("stages"),
    `due should default above stages, got ${list.join(" ")}`,
  );
});

test("the priority ladder runs lowest to highest and every rung has a color", () => {
  const src = ts();
  const ladder = [
    ...slice("src/tool/kanban.ts", "export const PRIORITIES", "];").matchAll(/"([a-z]+)"/g),
  ].map((m) => m[1]);
  assert.deepEqual(ladder, ["none", "trivial", "low", "medium", "high", "critical"]);

  const labels = slice("src/tool/kanban.ts", "export const DEFAULT_PRIORITY_LABELS", "};");
  const colors = slice("src/tool/kanban.ts", "export const DEFAULT_PRIORITY_COLORS", "};");
  for (const level of ladder) {
    assert.match(labels, new RegExp(`\\b${level}:`), `${level} has no label`);
    assert.match(colors, new RegExp(`\\b${level}: "#[0-9a-f]{6}"`), `${level} has no color`);
  }

  // Trivial sits outside the urgency ramp, so it is the one blue rung.
  const trivial = /trivial: "(#[0-9a-f]{6})"/.exec(colors);
  assert.ok(trivial, "trivial has no color");
  const n = parseInt(trivial[1].slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  assert.ok(b > r && b > g, `trivial should read as blue, got ${trivial[1]}`);
});

test("the effort ladder is lightest to heaviest and every rung is named", () => {
  /* Effort mirrors Priority's shape on purpose: five rungs plus "none" for
     unset. If the two ever stop matching, a card's two chips start meaning
     different kinds of thing and the modal that edits both breaks on one. */
  const ladder = [
    ...slice("src/tool/kanban.ts", "export const EFFORTS", "];").matchAll(/"([a-z]+)"/g),
  ].map((m) => m[1]);
  assert.deepEqual(ladder, ["none", "tiny", "small", "medium", "large", "huge"]);
  assert.equal(ladder[0], "none", "the unset rung has to be first, the way Priority's is");

  const labels = slice("src/tool/kanban.ts", "export const DEFAULT_EFFORT_LABELS", "};");
  const colors = slice("src/tool/kanban.ts", "export const DEFAULT_EFFORT_COLORS", "};");
  for (const level of ladder) {
    assert.match(labels, new RegExp(`\\b${level}:`), `${level} has no label`);
    assert.match(colors, new RegExp(`\\b${level}: "#[0-9a-f]{6}"`), `${level} has no color`);
  }
});

test("a renamed level is shown under its new name everywhere", () => {
  /* The rungs are settable now, so reading DEFAULT_*_LABELS to DRAW one shows
     the shipped name and silently ignores the rename. Only the accessors and
     the reset target may touch the defaults. */
  const src = ts();
  const exempt = ["function priorityLabel(", "function effortLabel(", "function scaleSpec("].map(
    (marker) => {
      const at = src.indexOf(marker);
      assert.notEqual(at, -1, `could not find ${marker}`);
      return [at, src.indexOf("\n}", at)];
    },
  );

  const strays = [];
  for (const m of src.matchAll(/DEFAULT_(?:PRIORITY|EFFORT)_LABELS\[/g)) {
    if (exempt.some(([from, to]) => m.index > from && m.index < to)) continue;
    strays.push(src.slice(m.index - 40, m.index + 40).replace(/\s+/g, " "));
  }
  assert.deepEqual(strays, [], "these draw a shipped name instead of the renamed one");
});

test("the card modal does not borrow a class the board face owns", () => {
  /* .kb-card-top is the card face's header strip on the BOARD. The modal
     declared its own rule under that name lower down the same stylesheet, which
     outranked the board's by source order and turned every card on every board
     into a centered vertical stack. Nothing said a word: both selectors were
     valid, they just were not about the same thing.

     The modal's fields are kb-card-prop-* now. This fails if anything inside
     the card modal's markup claims a class the board face builds. */
  const ts0 = ts();
  const html = read("index.html");

  // What buildCardEl puts on a card face.
  const build = ts0.slice(ts0.indexOf("function buildCardEl("));
  const faceClasses = new Set(
    [...build.slice(0, 4000).matchAll(/"(kb-card-[a-z-]+)"/g)].map((m) => m[1]),
  );
  assert.ok(faceClasses.has("kb-card-top"), "the face no longer uses kb-card-top; update this");

  // What the card modal's markup uses.
  const modal = html.slice(
    html.indexOf('id="kbCardBackdrop"'),
    html.indexOf('id="kbCardColorBackdrop"'),
  );
  const modalClasses = new Set(
    [...modal.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)),
  );

  const shared = [...faceClasses].filter((c) => modalClasses.has(c));
  assert.deepEqual(
    shared,
    [],
    "the modal and the board face share these classes, so one will restyle the other",
  );
});

test("a card being read has no live control left in it", () => {
  /* The whole point of the reading face is that a stray keystroke cannot edit
     real work. Every control that WRITES has to be hidden by the
     [data-kb-editing="false"] block, and the failure mode is silent: a field
     added later and not listed stays live on a card claiming to be read-only. */
  const css = read("src/tool/kanban.css");
  const block = css.slice(
    css.indexOf('#kbCardModal[data-kb-editing="false"]'),
    css.indexOf('#kbCardModal[data-kb-editing="true"]'),
  );
  assert.ok(block.length > 0, "the reading-face rules are gone");

  for (const id of [
    "#kbCardTitleInput",
    "#kbCardAttachAddBtn",
    "#kbCardDueInput",
    // The two that end an edit. They used to be a footer (#kbCardEditActions);
    // they are header icons now, and either way they must not be reachable on
    // a card that is only being read.
    "#kbCardSaveBtn",
    "#kbCardCancelBtn",
  ]) {
    assert.ok(block.includes(id), `${id} is still live while the card is being read`);
  }
  // The selects are covered as a class rather than one by one, which is what
  // lets Priority and Effort be joined by a third without touching this.
  assert.match(block, /\.kb-card-prop-value select/, "the top selects are still live");

  /* TAGS ARE THE DELIBERATE EXCEPTION and are not in the list above. Tagging is
     filing rather than editing: you do it to find the card again, not to change
     what it says, so it stays available on a card you are only reading. If that
     is ever reversed, the tag row joins the list. */
  assert.ok(
    !block.includes("kb-tag-row"),
    "the tag row is hidden while reading; tags are meant to stay editable there",
  );
});

test("the reading face cannot be clicked into an editor", () => {
  /* Hiding the toolbar in CSS is not enough: the rendered face itself opens the
     textarea when clicked, which would turn a card being read into a card being
     edited with no way to tell it happened. */
  const src = ts();
  const at = src.indexOf('preview.addEventListener("click"');
  assert.notEqual(at, -1, "the preview no longer handles clicks");
  const body = src.slice(at, src.indexOf("});", at));
  assert.match(body, /opts\.readOnly\?\.\(\) === true/, "a read-only field still opens on click");

  // And the card's own description has to actually pass that hook.
  const desc = src.slice(src.indexOf("descField = createRichTextField({"));
  assert.match(
    desc.slice(0, 600),
    /readOnly: \(\) => !cardEditing/,
    "the card description does not follow the card's mode",
  );
});

test("cancelling an edit puts back what was there", () => {
  /* Cancel restores from a snapshot taken on the way in. A SHALLOW copy would
     hand back the same nested arrays that were just edited, so cancelling a
     subtask change would restore nothing. */
  const src = ts();
  const at = src.indexOf("function setCardEditing(");
  assert.notEqual(at, -1, "setCardEditing is gone");
  const body = src.slice(at, src.indexOf("\n}", at));
  assert.match(body, /structuredClone\(card\)/, "the snapshot is not a deep copy");
  assert.match(
    body,
    /!cardEditSnapshot/,
    "the snapshot is retaken mid-edit, so Discard would restore the edits",
  );
  /* And never taken at all on a board that is always editing. There is no
     discard button there to serve it, and every field has already written
     itself, so a snapshot would only be a way to undo work nobody asked to
     undo. */
  assert.match(
    body,
    /!cardAlwaysEditing/,
    "a snapshot is taken on a board with no discard button to use it",
  );

  const cancel = src.slice(src.indexOf("function cancelCardEdit("));
  assert.match(
    cancel.slice(0, 500),
    /Object\.assign\(card, structuredClone\(cardEditSnapshot\)\)/,
    "Cancel replaces the card object instead of restoring it in place",
  );
});

test("every card edit puts the board behind it in step", () => {
  /* The board shows the card you are editing, so it has to follow along. This
     used to be a renderAll() written out at each place that changed something,
     which is a rule nobody can keep: there are dozens of writes to a card in
     this file and only a handful remembered. Editing a title updated the board
     and ticking a subtask did not.

     It hangs off stampCard() now, the one call every card write already goes
     through, exactly as queueSave() does. */
  const src = ts();

  const at = src.indexOf("function stampCard(");
  assert.notEqual(at, -1, "stampCard is gone");
  const body = src.slice(at, src.indexOf("\n}", at));
  assert.match(body, /queueBoardRefresh\(\)/, "a card write no longer refreshes the board");

  /* And it must not fire mid-drag. A drag moves the card's element around the
     DOM and commits on dragend; rebuilding underneath would replace the very
     element the pointer is holding. */
  const q = src.indexOf("function queueBoardRefresh(");
  assert.notEqual(q, -1, "queueBoardRefresh is gone");
  const qBody = src.slice(q, src.indexOf("\n}", q));
  assert.match(qBody, /if \(dragCardId\) return;/, "a refresh can fire mid-drag and kill it");
  assert.match(qBody, /setTimeout/, "the refresh is not debounced, so typing redraws per keystroke");
});

test("always-editing boards have no session to save or discard", () => {
  /* "Open Cards in Edit Mode" is not "start an edit session automatically".
     It is the tool's original behavior: fields are live, each writes as you
     leave it, and closing the card finishes. So there is nothing to save and
     nothing to discard, and a Save button on a card that already saved, or a
     Discard that silently reverts ten minutes of work, would both be lies. */
  const src = ts();

  for (const fn of ["function saveCardEdit(", "function cancelCardEdit("]) {
    const at = src.indexOf(fn);
    assert.notEqual(at, -1, `${fn} is gone`);
    const body = src.slice(at, src.indexOf("\n}", at));
    assert.match(
      body,
      /if \(cardAlwaysEditing\) return;/,
      `${fn} still runs on a board that is always editing`,
    );
  }

  // And all three header controls are hidden there, not just unwired.
  const css = read("src/tool/kanban.css");
  const block = css.slice(css.indexOf('[data-kb-always-editing="true"]'));
  const rule = block.slice(0, block.indexOf("}"));
  for (const id of ["#kbCardEditBtn", "#kbCardSaveBtn", "#kbCardCancelBtn"]) {
    assert.ok(rule.includes(id), `${id} is still drawn on an always-editing board`);
  }
});

test("a card opened from a count lands on the tab that count belongs to", () => {
  const src = ts();

  // The subtask count calls openCard directly.
  const sub = src.indexOf('label.addEventListener("click"');
  assert.notEqual(sub, -1, "the subtask count is not clickable");
  const subBody = src.slice(sub, sub + 220);
  assert.match(subBody, /openCard\(card\.id, "subtasks"\)/, "the subtask count opens Basic");
  // Without this the card's own click handler also fires and wins.
  assert.match(
    subBody,
    /stopPropagation/,
    "the count's click also triggers the card's, which opens Basic",
  );

  /* The comment count goes through the shared `item` helper, which takes the
     tab as an argument, so what matters is that the helper honors it and that
     the comment item is the one passing "comments". */
  const helper = src.indexOf("const item = (svg: string");
  assert.notEqual(helper, -1, "the meta-item helper is gone");
  const helperBody = src.slice(helper, helper + 700);
  assert.match(helperBody, /openCard\(card\.id, tab\)/, "the helper ignores the tab it is given");
  assert.match(helperBody, /stopPropagation/, "the meta item's click also opens Basic");

  const commentCall = src.indexOf("Open this card's comments");
  assert.notEqual(commentCall, -1, "the comment count no longer names its tab");
  assert.match(
    src.slice(commentCall, commentCall + 80),
    /"comments"/,
    "the comment count does not pass the comments tab",
  );
});

test("every reorderable section still exists as a block to reorder", () => {
  /* CARD_SECTIONS drives both the layout list and the drag order. A name in it
     with no matching block is a row you can drag that moves nothing, and a
     block with no name is one that can never be moved. */
  const ladder = [
    ...slice("src/tool/kanban.ts", "export const CARD_SECTIONS", "];").matchAll(/"([a-z]+)"/g),
  ].map((m) => m[1]);
  assert.deepEqual(ladder, ["description", "attachments", "due", "stages"]);

  const html = read("index.html");
  const blocks = [...html.matchAll(/data-kb-section="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    [...blocks].sort(),
    [...ladder].sort(),
    "the reorderable list and the blocks in the page disagree",
  );
});

test("a card's description reads at the same size as its comments", () => {
  /* The description is the part of a card carrying the detail you opened it
     for, and it was the smallest text in the modal: a hard 13px in
     rich-text.css while comments overrode it with 0.85rem of their own. One
     token now drives every rich text face, and a second font-size on any of
     them is how the two drift apart again. */
  const rt = read("src/core/rich-text.css");
  assert.match(rt, /--rt-font-size:\s*0\.85rem/, "the shared rich text size has moved");

  // Both faces of a field read the token rather than a number.
  const body = rt.slice(rt.indexOf(".rt-body {"), rt.indexOf(".rt-body > *:first-child"));
  assert.match(body, /font-size:\s*var\(--rt-font-size\)/, "the rendered face has its own size");
  const area = rt.slice(rt.indexOf(".rt-editor textarea {"));
  assert.match(
    area.slice(0, 160),
    /font-size:\s*var\(--rt-font-size\)/,
    "the textarea has its own size, so writing and reading differ again",
  );

  // And nothing in the tool sets a size on a rich text block to override it.
  const css = read("src/tool/kanban.css");
  for (const cls of [".kb-comment-body", ".kb-card-desc"]) {
    const at = css.indexOf(`${cls} {`);
    if (at === -1) continue;
    const rule = css.slice(at, css.indexOf("}", at));
    assert.ok(
      !/font-size/.test(rule),
      `${cls} sets its own font-size, which is what made the description the odd one out`,
    );
  }
});

test("no placeholder names this app or a version of it", () => {
  // A placeholder that says "Swiss RB Knife v0.7" reads as a real entry someone
  // left behind, and is wrong for every board that is not about this app.
  const html = read("index.html");
  const start = html.indexOf('id="productivity-tool-kanban"');
  const kanban = html.slice(start);
  const bad = [];
  for (const m of kanban.matchAll(/placeholder="([^"]*)"/g)) {
    if (/swiss|rb knife|v\d+\.\d+/i.test(m[1])) bad.push(m[1]);
  }
  assert.deepEqual(bad, [], "these placeholders name the app or a version");
});

test("every color well in this tool is sized, not stretched", () => {
  // shell.css gives every input inside a .setup-field width:100%, which is
  // right for a text field and absurd for a color well: one of these was
  // stretching the whole width of the modal like a paint sample.
  const html = read("index.html");
  const start = html.indexOf('id="kbSetupBackdrop"');
  const kanban = html.slice(start);
  const unsized = [];
  for (const m of kanban.matchAll(/<input[^>]*type="color"[^>]*>/g)) {
    if (!m[0].includes("kb-color-input")) {
      unsized.push((/id="([^"]*)"/.exec(m[0]) || [])[1] ?? m[0].slice(0, 50));
    }
  }
  assert.deepEqual(unsized, [], "these color inputs have no size class");
  assert.match(read("src/tool/kanban.css"), /\.kb-color-input \{/, "the size class is not defined");
});

/* -----------------------------------------------------------------------------
   RICH TEXT AND ATTACHMENTS
   -----------------------------------------------------------------------------
   Card descriptions and comments are Markdown that a person typed, and the app
   turns them into HTML and assigns it with innerHTML. That is a safe thing to do
   for exactly as long as the renderer never lets a character of the source
   through as markup, so the checks below pin the properties that make it safe
   rather than the shape of the output.

   The attachment checks are the file-lifetime ones. An attachment is a copy the
   app owns, so every place a record is destroyed has to unlink the copy, and
   nothing that takes a path from the front end may unlink anything outside the
   one folder.
----------------------------------------------------------------------------- */

const rt = () => read("src/core/rich-text.ts");

test("text a person typed is escaped before any of it becomes markup", () => {
  const src = rt();

  // The inline scan is the only place source characters reach the output. Every
  // branch of it either escapes, or hands the text back to itself (which
  // escapes at the bottom of the recursion).
  const at = src.indexOf("function inline(");
  const body = src.slice(at, src.indexOf("\n}", at));
  assert.match(body, /escapeHtmlText\(raw\.slice\(last, m\.index\)\)/, "text between matches is emitted unescaped");
  assert.match(body, /out \+= escapeHtmlText\(raw\.slice\(last\)\);/, "the tail of the line is emitted unescaped");
  assert.match(body, /escapeHtmlText\(g\.code/, "a code span is emitted unescaped");

  // A fence is the one place a whole run of lines is emitted at once.
  assert.ok(
    !/out\.push\(`<pre[^`]*\$\{fence\.join/.test(src),
    "a fenced block is emitted without escaping",
  );
  assert.match(src, /escapeHtmlText\(fence\.join\("\\n"\)\)/, "a fenced block is not escaped");

  // The docs renderer deliberately passes raw HTML through. This one must not
  // have grown the same habit.
  for (const forbidden of ["HTML_BLOCK_TAGS", "inHtmlBlock", "htmlLines"]) {
    assert.ok(!src.includes(forbidden), `${forbidden} means raw HTML passthrough reached user text`);
  }
});

test("a link in someone's notes cannot carry a scheme the app will not open", () => {
  const src = rt();
  assert.match(src, /const SAFE_LINK_SCHEME = /, "no allowlist of link schemes");

  // Written into a data attribute rather than an href, so nothing rendered is
  // navigable without going through the handler that re-checks it.
  const at = src.indexOf("function anchor(");
  const body = src.slice(at, src.indexOf("\n}", at));
  assert.match(body, /SAFE_LINK_SCHEME\.test\(href\)/, "the destination is not checked");
  assert.match(body, /data-rt-href=/, "the destination is not parked in a data attribute");
  // A real href attribute is written with a space in front of it; the check has
  // to not also match the data-rt-href the renderer does use.
  assert.ok(!/ href="\$\{/.test(body), "a user-supplied destination reaches an href");

  // And checked again at the handover, which is where it actually matters.
  const bindAt = src.indexOf("export function bindRichTextLinks(");
  const bind = src.slice(bindAt, src.indexOf("\n}", bindAt));
  assert.match(bind, /SAFE_LINK_SCHEME\.test\(href\)/, "the click handler trusts the attribute");
});

test("card text uses the strict renderer and never the documents one", () => {
  // docs.ts renders the app's own shipped documents and passes raw HTML through
  // on purpose. Pointing a card description at it would make every card a place
  // to write a <script> tag.
  const src = ts();
  assert.match(src, /from "\.\.\/core\/rich-text"/, "the Kanban does not use the strict renderer");
  assert.ok(!/renderMarkdown/.test(src), "the Kanban is using the documents renderer");
});

test("an attachment cannot name a file outside its own board's folder", () => {
  // Where a file lives is DERIVED from the board id and the attachment id, and
  // no command takes a path from the front end at all. That is what replaced
  // the containment check the first cut needed: there is no longer a path to
  // contain. Both ids still have to be held to an alphabet that cannot carry a
  // separator, or the derivation is right back where it started.
  const rs = read("src-tauri/src/tools/kanban.rs");

  const resolve = rs.slice(rs.indexOf("fn find_attachment"));
  const body = resolve.slice(0, resolve.indexOf("\n}"));
  assert.match(body, /valid_board_id\(board_id\)/, "the board id is not validated");
  assert.match(body, /valid_attachment_id\(attachment_id\)/, "the attachment id is not validated");

  // valid_attachment_id has to be the SAME rule as valid_board_id, not a
  // looser one that happens to look similar.
  const idFn = rs.slice(rs.indexOf("fn valid_attachment_id"));
  assert.match(
    idFn.slice(0, idFn.indexOf("\n}")),
    /valid_board_id\(id\)/,
    "attachment ids are validated by a second, separate rule",
  );

  // And the front end holds ids to the same alphabet before they are ever
  // written into a card, so a hand-edited board file cannot smuggle one in.
  const at = ts().indexOf("function normalizeAttachment(");
  const norm = ts().slice(at, ts().indexOf("\n}", at));
  assert.match(norm, /\[A-Za-z0-9_-\]\{1,64\}/, "an attachment id from disk is not checked");

  // Nothing in the attachment surface may accept a path from the WebView. The
  // one command that still does is the IMPORT, whose whole job is to be handed
  // the file the user picked out of a native dialog.
  const commands = [...rs.matchAll(/pub fn (\w*attachment\w*)\(([^)]*)\)/gs)];
  assert.ok(commands.length >= 6, `expected the attachment commands, found ${commands.length}`);
  for (const [, name, args] of commands) {
    if (name === "import_kanban_attachment") continue;
    assert.ok(
      !/\bpath: String\b/.test(args),
      `${name} takes a path from the front end; it should derive one from ids`,
    );
  }
});

test("an attachment is a copy the app owns, not the file that was picked", () => {
  const rs = read("src-tauri/src/tools/kanban.rs");
  const at = rs.indexOf("fn store_attachment");
  const body = rs.slice(at, rs.indexOf("\n}\n", at));

  // Through the shared helper, which streams (an attachment can be a screen
  // recording), writes under a temporary name so a copy interrupted half way
  // never appears under the name a card is about to point at, and fsyncs before
  // the rename. This used to be rolled by hand here, without that last part.
  assert.match(body, /atomic_copy\(source, &final_path\)/, "the copy is not atomic");
  assert.ok(!/fs::read\(/.test(body), "the whole file is read into memory to copy it");
  assert.ok(!/fs::copy\(/.test(body), "this copies by hand instead of using atomic_copy");

  // The name on disk is the id, never the name that was picked.
  assert.ok(
    !/display_name/.test(body),
    "the original filename is being used to build a path",
  );
});




test("everything that destroys an attachment record also unlinks its file", () => {
  // A record is the only route to the file. Dropping one without the other
  // leaves bytes in the data folder that nothing can ever reach to delete.
  const src = ts();
  for (const [fn, why] of [
    ["function deleteCard(", "deleting a card"],
    ["function requestDeleteComment(", "deleting a comment"],
    ["function discardPendingComment(", "abandoning a half-written comment"],
  ]) {
    const at = src.indexOf(fn);
    assert.notEqual(at, -1, `${fn} is missing`);
    const body = src.slice(at, src.indexOf("\n}", at));
    assert.match(body, /forgetAttachmentFiles\(/, `${why} leaves its files on disk`);
  }

  // Deleting a BOARD is one call and no card walk. Walking the cards would mean
  // a board can only be deleted while its cards are in memory, and would miss
  // any file whose card had already gone.
  const at = src.indexOf("function deleteBoard(");
  const board = src.slice(at, src.indexOf("\n}", at));
  assert.match(board, /delete_kanban_board_attachments/, "deleting a board leaves its files on disk");
  assert.ok(
    !/forgetAttachmentFiles/.test(board),
    "deleting a board walks its cards instead of clearing the folder",
  );

  // The guarantee behind all of the above: anything unreferenced is swept once
  // the board's cards are actually in memory.
  const load = src.slice(src.indexOf("async function loadRecords("));
  assert.match(
    load.slice(0, load.indexOf("\n}")),
    /sweepBoardAttachments\(/,
    "nothing collects files a crash or a restore orphaned",
  );
  const sweep = src.slice(src.indexOf("function sweepBoardAttachments("));
  assert.match(
    sweep.slice(0, sweep.indexOf("\n}")),
    /if \(!getBoard\(boardId\)\) return;/,
    "the sweep runs for a board that is not in memory, whose cards are not either, and deletes everything",
  );

  // The card's own list and each comment's list are both reachable from one
  // place, so a delete path cannot walk one and forget the other.
  const allAt = src.indexOf("function allAttachments(");
  const allBody = src.slice(allAt, src.indexOf("\n}", allAt));
  assert.match(allBody, /card\.attachments/, "allAttachments misses the card's own files");
  assert.match(allBody, /comments\.flatMap/, "allAttachments misses the comments' files");
});

test("a card that changes board takes its files with it", () => {
  // The folder is named after the board, so the file has to physically move.
  const src = ts();
  const at = src.indexOf("function moveCardToBoard(");
  const body = src.slice(at, src.indexOf("\n}", at));
  assert.match(body, /moveAttachmentsToBoard\(/, "a moved card leaves its files on the old board");

  const mv = src.slice(src.indexOf("async function moveAttachmentsToBoard("));
  const mvBody = mv.slice(0, mv.indexOf("\n}\n"));
  assert.match(mvBody, /copy_kanban_attachment/, "nothing copies the files across");
  assert.match(mvBody, /delete_kanban_attachment/, "the old copies are left behind");
});

test("a pasted image is attached, and a pasted paragraph is not", () => {
  // Ctrl+V of a screenshot should become an attachment. Ctrl+V of text, or of
  // text that happens to carry a thumbnail alongside it (copying from a
  // document usually does), must stay a text paste.
  const src = ts();
  const at = src.indexOf('area.addEventListener("paste"');
  assert.notEqual(at, -1, "the editor does not handle paste at all");
  const body = src.slice(at, src.indexOf("\n    });", at));
  assert.match(body, /types\.includes\("text\/plain"\)/, "a text paste is not left alone");
  assert.match(body, /startsWith\("image\/"\)/, "non-image clipboard items are not filtered out");

  // All three places text can be typed accept one.
  const uses = [...src.matchAll(/onPasteImage:/g)].length;
  assert.equal(uses, 3, `${uses} of the 3 editors accept a pasted image`);
});

test("a player is emptied before the thing holding it is thrown away", () => {
  // A <video> removed from the page while it still holds a source keeps its
  // decoder and its buffer alive. These containers are rebuilt on every render.
  const src = ts();
  const at = src.indexOf("function releaseMedia(");
  const body = src.slice(at, src.indexOf("\n}", at));
  assert.match(body, /\.pause\(\)/, "the player is not paused");
  assert.match(body, /removeAttribute\("src"\)/, "the source is not cleared");
  assert.match(body, /\.load\(\)/, "the player is not reloaded, so it keeps the old resource open");

  // Every attachment list is emptied through the helper that does it.
  assert.match(
    src.slice(src.indexOf("function renderAttachmentList(")),
    /clearMediaHost\(host\)/,
    "an attachment list is emptied without releasing its players",
  );
  // And so is the card modal, on the way out.
  const closeAt = src.indexOf("  _cardModal = new Modal(backdrop");
  const close = src.slice(closeAt, src.indexOf("\n  });", closeAt));
  assert.match(close, /releaseMedia\(backdrop\)/, "the card modal leaves its players running");
});

test("a half-written comment belongs to a named card, not to whatever is open", () => {
  // The card modal steps aside for the picture viewer and for a confirm, and
  // comes back. Neither of those may throw away what was being typed, and
  // neither may leak it onto the next card opened.
  const src = ts();
  assert.match(src, /let pendingCommentCardId: string \| null = null;/, "the composer names no card");

  const closeAt = src.indexOf("  _cardModal = new Modal(backdrop");
  const close = src.slice(closeAt, src.indexOf("\n  });", closeAt));
  assert.match(
    close,
    /if \(!topOpenKanbanModal\(\)\) \{/,
    "the card modal discards the composer even when it is only stepping aside",
  );

  const openAt = src.indexOf("function openCard(");
  const open = src.slice(openAt, src.indexOf("\n}", openAt));
  assert.match(
    open,
    /pendingCommentCardId !== cardId/,
    "another card's half-written comment can follow you onto this one",
  );
});

test("redrawing the columns keeps where you were on the board", () => {
  /* Closing a card modal sent every column back to the top and the board back
     to the far left, because renderColumns() empties the strip and rebuilds it,
     and the scroll positions live on the elements being thrown away. Any card
     far enough down a column to need scrolling to was a card you then had to
     scroll back to, every time you looked at one.

     The read has to happen BEFORE replaceChildren(): emptying the strip
     collapses its width, and the browser clamps scrollLeft to 0 as it does, so
     the sideways position cannot be recovered afterwards. That ordering is the
     part worth pinning. */
  const body = slice("src/tool/kanban.ts", "function renderColumns(", "\n}");

  const readLeft = body.indexOf("columnsEl.scrollLeft");
  const readTops = body.indexOf(".scrollTop");
  const wipe = body.indexOf("columnsEl.replaceChildren()");
  assert.notEqual(wipe, -1, "renderColumns no longer rebuilds the strip");
  assert.ok(readLeft !== -1 && readLeft < wipe, "the sideways position is not read before the rebuild");
  assert.ok(readTops !== -1 && readTops < wipe, "the column positions are not read before the rebuild");

  // And put back after it.
  assert.ok(
    body.lastIndexOf("scrollTop") > wipe,
    "the column positions are never restored",
  );
  assert.ok(
    body.lastIndexOf("columnsEl.scrollLeft") > wipe,
    "the sideways position is never restored",
  );

  /* Only onto the board it came from. Column ids cannot collide across boards,
     but the sideways position is just a number and would otherwise be carried
     onto whatever board you opened next. */
  assert.match(body, /renderedBoardId/, "a board switch would inherit the previous board's position");
});

test("two saves can never be in flight at once", () => {
  // flushSave() is used as a barrier by four things that then change the world
  // underneath a save: Lock Now takes the password away, Encrypt deletes the
  // plaintext file, Decrypt does the reverse, and a snapshot restore replaces
  // the state wholesale. If a flush can return while an earlier save is still
  // mid-await, none of them is actually a barrier, and Encrypt's plaintext
  // delete can land BEFORE the in-flight plaintext write, leaving a readable
  // copy of an encrypted board's cards in the data folder for good, with the
  // whole app reporting that board as encrypted.
  const src = ts();
  assert.match(src, /let saveChain: Promise<void>/, "saves are not serialized");

  const at = src.indexOf("function saveNow(");
  const body = src.slice(at, src.indexOf("\n}", at));
  assert.match(body, /saveChain = saveChain/, "saveNow does not queue behind the running save");
  assert.match(body, /return saveChain;/, "saveNow does not resolve on its own write");

  const flushAt = src.indexOf("async function flushSave(");
  const flush = src.slice(flushAt, src.indexOf("\n}", flushAt));
  assert.match(flush, /await saveNow\(\)/, "flushSave does not await the chain");

  /* Nothing may reach the writer except through the chain: its declaration and
     the one .then() that runs it. Counted in CODE rather than in the file, so a
     comment that mentions it by name is not a failure; the old count included
     comments, which turned every explanatory edit into a broken test. */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const uses = [...code.matchAll(/\bwriteDirty\b/g)].length;
  assert.equal(uses, 2, `writeDirty is reached ${uses} times in code; only the declaration and the chain should reach it`);
});

test("an attachment is never destroyed in place", () => {
  // A board's cards are snapshotted on every write, so the hour you delete a
  // card, the hour before still has it. Its FILES only get the same deal if
  // nothing ever unlinks one outright: every path that would destroy or
  // overwrite an attachment moves it to the store instead, and the store drops
  // it once no surviving bucket could ask for it.
  const rs = read("src-tauri/src/tools/kanban.rs");

  for (const [fn, why] of [
    ["pub fn delete_kanban_attachment", "removing one attachment"],
    ["pub fn delete_kanban_board_attachments", "deleting a board"],
    ["pub fn sweep_kanban_attachments", "sweeping orphans"],
  ]) {
    const at = rs.indexOf(fn);
    assert.notEqual(at, -1, `${fn} is missing`);
    const body = rs.slice(at, rs.indexOf("\n}\n", at));
    assert.match(body, /retire_attachment\(/, `${why} unlinks the file instead of retiring it`);
  }

  // Retiring is a rename, not a copy: a 64 MB video must not cost 64 MB of
  // copying to delete, and one set of bytes must exist at a time.
  const at = rs.indexOf("fn retire_attachment");
  const body = rs.slice(at, rs.indexOf("\n}\n", at));
  assert.match(body, /fs::rename\(live_path, &dest\)/, "retiring copies rather than moves");
  assert.match(
    body,
    /set_modified\(std::time::SystemTime::now\(\)\)/,
    "the retirement time is not stamped, so the prune cannot measure it",
  );
});

test("a restored board asks for its files back", () => {
  // The records come back from the database; the files were retired rather than
  // unlinked, so they can come back too.
  const src = ts();
  const at = src.indexOf("async function refreshDataTab(");
  const body = src.slice(at, src.indexOf("\n});", at));
  assert.match(body, /revive_kanban_attachments/, "a restore brings back cards but not their files");
  // Re-read from the database first, so the ids asked for are the restored
  // ones rather than whatever was on screen.
  assert.ok(
    body.indexOf("loadRecords()") < body.indexOf("revive_kanban_attachments"),
    "the revive runs against the pre-restore cards",
  );
});

test("a board background is found by name, not by a path it remembered", () => {
  /* THE BUG THIS EXISTS TO STOP, which shipped once and went unnoticed.

     A background used to be recorded as a whole absolute path. When the data
     folder was split into one folder per tool, kanban-backgrounds moved, and
     every board went on pointing at where it used to be. The board then drew a
     background that was not there, with nothing on screen to say why: a missing
     image is just an empty panel.

     A record says WHICH image. Where the folder is, is the back end's answer,
     asked for at load the way the attachments folder already is. */
  const src = ts();

  assert.match(src, /function backgroundSrc\(/, "there is no single place a background is resolved");
  assert.match(
    src,
    /backgroundsRoot = await invoke<string>\("kanban_backgrounds_dir"\)/,
    "the backgrounds folder is guessed rather than asked for",
  );

  // Every drawing site goes through it, or the one that does not keeps the bug.
  const direct = [...src.matchAll(/convertFileSrc\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.deepEqual(
    direct.filter((arg) => /\bbg\.path|background\.path/.test(arg)),
    [],
    "these draw a background straight from the stored path",
  );

  // And the resolver reduces the record to its last segment, on BOTH separators.
  //
  // This is checked by running it, not by matching the source. The first cut of
  // this test asserted only that backgroundSrc called .split(, and it passed
  // happily over a character class that had lost a backslash and therefore
  // matched forward slashes alone. Against a Windows path that split nothing,
  // handed back the whole stale record, and the background stayed missing.
  const at = src.indexOf("function backgroundSrc(");
  const body = src.slice(at, src.indexOf("\n}", at));
  assert.match(body, /backgroundsRoot/, "backgroundSrc does not resolve against the reported folder");

  const reduce = new Function(
    "p",
    `${body.slice(body.indexOf("{") + 1, body.lastIndexOf("return"))} return file;`
      .replace(/bg\.path/g, "p"),
  );
  for (const [stored, expected] of [
    [String.raw`D:\app\data\kanban-backgrounds\bg-1.jpg`, "bg-1.jpg"],
    ["D:/app/data/kanban-backgrounds/bg-2.png", "bg-2.png"],
    ["bg-3.webp", "bg-3.webp"],
  ]) {
    assert.equal(
      reduce(stored),
      expected,
      `backgroundSrc does not reduce ${JSON.stringify(stored)} to its filename`,
    );
  }

  // The importer hands back a name, so new records cannot carry a path at all.
  const rs = read("src-tauri/src/tools/kanban.rs");
  const importAt = rs.indexOf("pub fn import_kanban_image(");
  assert.notEqual(importAt, -1, "import_kanban_image is missing");
  assert.match(
    rs.slice(importAt, rs.indexOf("\n}\n", importAt)),
    /\.file_name\(\)/,
    "import_kanban_image still returns a whole path for a board to remember",
  );
});

test("retired attachments are pruned with the buckets that could want them", () => {
  // The store would otherwise grow forever. The prune has to hang off the one
  // moment the answer changes, which is the backup pruner dropping a bucket.
  const lib = read("src-tauri/src/lib.rs");
  const at = lib.indexOf("fn snapshot_group");
  const body = lib.slice(at, lib.indexOf("\n}\n", at));
  assert.match(
    body,
    /prune_kanban_attachment_store\(/,
    "nothing ever drops a retired attachment, so the store grows without limit",
  );
  assert.ok(
    body.indexOf("prune_buckets(") < body.indexOf("prune_kanban_attachment_store("),
    "the store is pruned before the buckets are, so it measures against the wrong oldest bucket",
  );
  /* And only against KANBAN's buckets. Snapshots are per tool, so the oldest
     bucket in someone else's folder says nothing about which attachments a
     Kanban snapshot might still want back. */
  assert.match(
    body,
    /if tool_dir == "kanban"/,
    "another tool's retention would decide when Kanban's attachments are dropped",
  );
  // It takes the data root, not the backups folder. Walking up from a per-tool
  // backups folder lands in the tool folder, not the data root.
  assert.match(
    body,
    /prune_kanban_attachment_store\(&data_root\(app\)/,
    "the store is looked for relative to the wrong folder",
  );

  /* And the cutoff is the OLDEST SURVIVING bucket. The list comes back FROM
     the pruner rather than being read separately, so a bucket that has just
     been dropped cannot still be in it. */
  assert.match(
    body,
    /let existing_buckets = prune_buckets\(/,
    "the bucket list is not the one the pruner left behind",
  );
  assert.match(body, /existing_buckets\.first\(\)/, "the cutoff is not the oldest surviving bucket");

  // And the pruner itself deletes before it reports what survived.
  const pruneAt = lib.indexOf("pub(crate) fn prune_buckets(");
  assert.notEqual(pruneAt, -1, "prune_buckets is missing");
  const prune = lib.slice(pruneAt, lib.indexOf("\n}\n", pruneAt));
  assert.ok(
    prune.indexOf("remove_dir_all") < prune.indexOf("existing.drain("),
    "prune_buckets reports buckets it is about to delete as surviving",
  );
});

test("the attachment size limit is the same number on both sides", () => {
  // The front end refuses an oversized paste before encoding it and the back
  // end refuses it again on arrival. Two copies of one number is a thing that
  // drifts, and the drift shows up as a paste the app accepts and the back end
  // then rejects with a different figure in the message.
  const ts0 = ts();
  const rs = read("src-tauri/src/tools/kanban.rs");
  const front = /const MAX_ATTACHMENT_BYTES = (\d+) \* 1024 \* 1024;/.exec(ts0);
  const back = /const MAX_ATTACHMENT_BYTES: u64 = (\d+) \* 1024 \* 1024;/.exec(rs);
  assert.ok(front, "the front end has no attachment size limit");
  assert.ok(back, "the back end has no attachment size limit");
  assert.equal(front[1], back[1], "the two attachment size limits disagree");

  // And the words on screen quote the same figure.
  assert.match(
    read("index.html"),
    new RegExp(`${front[1]} MB per file`),
    "the attachments block quotes a different limit than the code enforces",
  );
});

test("the file header lists exactly the commands the file defines", () => {
  // A header that names the surface is worth having and worthless once it is
  // out of date, and it went out of date twice in one release. The list is now
  // checked rather than trusted.
  const rs = read("src-tauri/src/tools/kanban.rs");
  // Only snake_case words count as a command name. The block carries prose
  // as well as the list, and an earlier version of this read every long word
  // in that prose as a command that did not exist.
  const listed = new Set(
    slice("src-tauri/src/tools/kanban.rs", "   Rust commands exposed", "=====")
      .match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? [],
  );
  const defined = new Set(
    [...rs.matchAll(/#\[tauri::command\][\s\S]{0,120}?fn\s+([a-z0-9_]+)/g)].map((m) => m[1]),
  );

  const undocumented = [...defined].filter((c) => !listed.has(c));
  const phantom = [...listed].filter((c) => !defined.has(c));
  assert.deepEqual(undocumented, [], "these commands exist but the header does not name them");
  assert.deepEqual(phantom, [], "the header names these, and they do not exist");
});

test("a column sort is a view, not a rewrite of the board's order", () => {
  /* The whole promise of the feature: `card.order` is the arrangement someone
     made by hand, and a sort has to be something you can turn off and get it
     back. A sort that renumbered the cards would be a one-way door. */
  const src = read("src/tool/kanban.ts");
  const sortFn = slice("src/tool/kanban.ts", "function sortCards(", "\n}");
  assert.ok(
    !/\.order\s*=/.test(sortFn),
    "sortCards writes card.order, so clearing the sort could not put the hand-made order back",
  );
  assert.match(sortFn, /\[\.\.\.list\]/, "sortCards sorts the caller's array in place");
  // Ties fall back to the hand-made order, so the same rules always draw the
  // same result rather than relying on the sort being stable.
  assert.match(sortFn, /a\.order - b\.order/, "a tie is left to chance instead of the manual order");

  /* One editor, reached from both places. Two would have drifted: the rule set
     is the same shape whether it is a board default or one column's override. */
  assert.match(src, /function openSortEditor\(/, "there is no shared sort editor");
  const opens = [...src.matchAll(/openSortEditor\(\{ kind: "(board|column)"/g)].map((m) => m[1]);
  assert.ok(opens.includes("board"), "Board Setup cannot set the board's default sort");
  assert.ok(opens.includes("column"), "a column's settings cannot override the sort");

  // And one wording for a rule set, so the three places that describe it agree.
  assert.match(src, /function describeSortRules\(/, "each screen words the rules its own way");
});

test("dragging one of several selected cards brings the rest", () => {
  /* Selecting eleven cards and dragging one of them has to move eleven, or the
     selection was for nothing. Dragging a card that is NOT selected drops the
     selection first: that drag is about the one card, and carrying an unrelated
     selection into it moves things nobody was looking at. */
  const src = read("src/tool/kanban.ts");
  const start = slice("src/tool/kanban.ts", 'el.addEventListener("dragstart"', "});");
  assert.match(start, /selectedCardIds\.size > 1 && selectedCardIds\.has\(card\.id\)/,
    "a drag does not notice whether the card is part of a selection");
  assert.match(start, /clearCardSelection\(false\)/,
    "dragging an unselected card carries the old selection along with it");

  // The passengers are excluded from the drop-point measurement, or the
  // insertion point chases the group as it moves.
  const before = slice("src/tool/kanban.ts", "function cardBeforePoint(", "\n}");
  assert.match(before, /:not\(\.kb-dragging-with\)/,
    "the cards being carried are measured against as drop targets");
});

test("the sort rows read their value from a badge, not from their own button", () => {
  /* The house shape for a setting that opens its own editor: the name, a status
     badge saying where it stands, and a button whose label never changes.
     Priority, Effort and Card Layout all use it.

     Column Sort shipped with the RULES as the button label. It changed text on
     every edit and stretched the row to whatever the rules happened to say, so
     the control was also the readout and neither job was done well.

     Pinned narrowly, at the two rows that got it wrong, rather than as a
     general rule about buttons: "High to low" on a direction toggle is a label
     that states a two-way choice, and "Copy for <client>" is an action naming
     its target. Neither is a row reading itself back, and a check broad enough
     to catch this one would have to list them as exceptions. */
  const src = read("src/tool/kanban.ts");
  const html = read("index.html");

  // Board Setup > Preferences.
  const prefs = slice("src/tool/kanban.ts", "function renderBoardPrefs(", "\n}");
  assert.match(prefs, /btn\.textContent = "Customize";/, "the board's list-valued rows are labelled with their own value");
  assert.match(prefs, /badge\.textContent = setting\.badge;/, "the board's list-valued rows have no badge");
  /* BOTH of them, on the same row shape. Card Layout used to render its drag
     list inline under the row instead, which is why it never matched its
     neighbours. */
  for (const label of ['label: "Card Layout"', 'label: "Column Sort"']) {
    assert.ok(prefs.includes(label), `${label} is not one of the standard rows`);
  }

  // The column editor.
  assert.match(
    html,
    /id="kbColumnSortBtn" class="settings-action-btn">Customize</,
    "the column editor's sort button does not have a fixed label",
  );
  assert.match(
    html,
    /id="kbColumnSortSummary" class="settings-status-badge"/,
    "the column editor's sort row has no badge to carry the rules",
  );

  /* And the badge says something SHORT for the two cases that are not a rule
     list, so a glance tells "following the board" from "deliberately manual". */
  const badge = slice("src/tool/kanban.ts", "function describeSortBadge(", "\n}");
  assert.match(badge, /"Board Default"/, "a column following the board reads as something else");
  assert.match(badge, /"Manual"/, "a column deliberately left manual reads as something else");
  assert.match(badge, /"Customized"/, "a column with rules of its own spells them out in the badge");
  /* And nothing in it builds a sentence. A badge that can grow to the length of
     the rules is the thing this row was rebuilt to stop. */
  assert.ok(
    !badge.includes("describeSortRules("),
    "the badge is still printing the whole rule set",
  );
});

test("a settings badge says how it stands, not what it holds", () => {
  /* A badge answers one question at a glance: has anyone touched this. The
     answer is never a sentence, and a badge built from the value grows to the
     length of the value and drags the row's layout around with it. Column Sort
     and Card Layout both shipped that way.

     The two wordings are the whole vocabulary, so a row cannot invent a third
     way of saying the same thing. */
  const src = read("src/tool/kanban.ts");
  const tool = slice("src/tool/kanban.ts", "function toolBadge(", "\n}");
  const board = slice("src/tool/kanban.ts", "function boardBadge(", "\n}");
  assert.match(tool, /"Default"/, "a tool setting nobody has touched reads as something else");
  assert.match(tool, /"Customized"/, "a tool setting that has been changed reads as something else");
  assert.match(board, /"Tool Default"/, "a board following the tool reads as something else");
  assert.match(board, /"Customized"/, "a board with its own answer reads as something else");

  /* THE CHAIN. Each level either follows the one above it or answers for
     itself, and NAMES the level it follows, so a badge says where to go to
     change it. And a list-valued setting has three states, not two: an empty
     list is a decision ("this sorts nothing"), not the absence of one. The
     board badge used to collapse "deliberately manual" into "Customized". */
  const boardSort = slice("src/tool/kanban.ts", "function describeBoardSortBadge(", "\n}");
  for (const state of ['"Tool Default"', '"Manual"', '"Customized"']) {
    assert.ok(boardSort.includes(state), `the board's sort badge cannot say ${state}`);
  }
  const columnSort = slice("src/tool/kanban.ts", "function describeSortBadge(", "\n}");
  for (const state of ['"Board Default"', '"Manual"', '"Customized"']) {
    assert.ok(columnSort.includes(state), `a column's sort badge cannot say ${state}`);
  }

  /* Every settings-status-badge in this tool is filled from one of the two
     helpers, or from a fixed short string. Nothing formats a list into one. */
  const offenders = [];
  for (const m of src.matchAll(/(\w+)\.className = "settings-status-badge";([\s\S]{0,300}?)\n\n/g)) {
    const [, name, after] = m;
    const set = new RegExp(String.raw`${name}\.textContent\s*=\s*([\s\S]*?);`).exec(after);
    if (!set) continue;
    const value = set[1].trim();
    const ok =
      /^"[^"]*"$/.test(value) ||
      /^(toolBadge|boardBadge|describeSortBadge|describeBoardSortBadge|setting\.badge)/.test(value);
    if (!ok) {
      const line = src.slice(0, m.index).split("\n").length;
      offenders.push(`src/tool/kanban.ts:${line} ${name} = ${value.split("\n")[0]}`);
    }
  }
  assert.deepEqual(offenders, [], "these badges are built from the value rather than saying how it stands");
});

test("the sort levels are dragged into order, like every other ordered list here", () => {
  /* Card Layout's blocks are dragged. So are columns, and cards. A pair of
     arrow buttons per row would have been a second way to express an order,
     and two more controls in a row already carrying a name and a direction. */
  const editor = slice("src/tool/kanban.ts", "function renderSortEditor(", "\n}");
  assert.match(editor, /row\.draggable = true;/, "a sort level cannot be dragged");
  assert.match(editor, /"dragstart"/, "nothing starts a drag on a sort level");
  /* Committed on dragend, not drop: a release anywhere still lands the order.
     Same reason as renderSectionOrderInto, which this follows. */
  assert.match(editor, /"dragend"/, "the reordered list is never committed");
  assert.ok(
    !/kb-icon-btn[\s\S]{0,120}"\u25B2"/.test(editor) && !editor.includes("▲"),
    "the arrow buttons are still there beside the drag handle",
  );
});

test("the two preference screens group the same settings the same way", () => {
  /* Seventeen rows in one column is a wall, and Board Setup shows a subset of
     that same wall. Whoever reads both is reading the same settings twice, so
     they are grouped the same and in the same order; finding a setting on one
     screen has to teach you where it is on the other.

     The tool's half is the DEFAULTS tab. That is what the split was for: a
     default is exactly a setting a board can override, so the tab and the
     board's override list hold the same rows by definition, and the tool's
     Preferences tab is what is left over, which no board can override.

     Checked as ORDER, not as a count of dividers: the point is that the rows
     a board can override appear in the sequence the tool puts them in, so a row
     inserted on one screen and not the other shows up here. */
  const html = read("index.html");
  const pane = slice("index.html", 'id="kbTabDefaults"', 'id="kbTabPreferences"');

  // The tool's order, read off the markup rather than restated here.
  const toolOrder = [...pane.matchAll(/kb-label-with-info">([^<\n]+)|^\s*<span>([A-Z][^<]{2,45})<\/span>/gm)]
    .map((m) => (m[1] ?? m[2]).trim());
  assert.ok(toolOrder.length >= 13, `only found ${toolOrder.length} default rows`);

  // The board's order, read off its groups.
  const src = read("src/tool/kanban.ts");
  const groups = slice("src/tool/kanban.ts", "const BOARD_OVERRIDE_GROUPS", "\n];");
  const boardOrder = [...groups.matchAll(/label: "([^"]+)"/g)].map((m) => m[1]);
  assert.ok(boardOrder.length >= 8, `only found ${boardOrder.length} overridable rows`);

  /* Every overridable row appears on the tool screen, in the same relative
     order. A row the tool does not have at all is the other failure worth
     catching: a board cannot override something that does not exist. */
  const positions = boardOrder.map((label) => {
    const at = toolOrder.indexOf(label);
    assert.notEqual(at, -1, `Board Setup offers "${label}" and the tool's Defaults has no such row`);
    return at;
  });
  const sorted = [...positions].sort((a, b) => a - b);
  assert.deepEqual(
    positions,
    sorted,
    "Board Setup lists the overridable settings in a different order from the tool's own Defaults",
  );

  // Both screens actually draw the rules, rather than running the rows together.
  /* Enough rules that the rows are in buckets at all. Not an exact count: the
     buckets are a judgement about what belongs together and that judgement is
     allowed to change, unlike the two screens agreeing with each other, which
     is what the rest of this test is for. */
  assert.ok(
    (pane.match(/settings-section-divider/g) ?? []).length >= 3,
    "the tool's defaults are one undivided wall of rows",
  );
  const render = slice("src/tool/kanban.ts", "function renderBoardPrefs(", "\n}");
  assert.match(render, /settings-section-divider/, "Board Setup draws no dividers between its groups");
});

test("every ordered list in Kanban is dragged, and none of them has arrows", () => {
  /* Card Layout's blocks, sort levels, columns, cards, boards, tag categories
     and the tags inside them are all orders someone sets, and they are all set
     the same way. Two gestures for one idea is worse than either, and the tag
     categories were the last holdout: a pair of arrow buttons per block, on one
     screen where the chips inside those blocks drag.

     Checked as a rule rather than per list, so a list added later is caught. */
  const lists = {
    "the sort levels": "function renderSortEditor(",
    "the card layout blocks": "function renderSectionOrderInto(",
    "the default columns": "function renderDefaultColumns(",
    "the board order": "function renderBoardOrderList(",
  };
  const problems = [];
  for (const [what, marker] of Object.entries(lists)) {
    const editor = slice("src/tool/kanban.ts", marker, "\n}");
    if (!/\.draggable = /.test(editor)) problems.push(`${what} cannot be dragged`);
    if (!editor.includes('"dragstart"')) problems.push(`${what} starts no drag`);
    /* Committed on dragend, not drop: a release anywhere still lands the
       order. renderSectionOrderInto is the one the others follow. */
    if (!editor.includes('"dragend"')) problems.push(`${what} never commits the new order`);
    if (editor.includes("\u25B2") || editor.includes("\u25BC")) {
      problems.push(`${what} has arrow buttons as well as a drag`);
    }
  }
  assert.deepEqual(problems, []);

  /* The two vocabulary lists are built by one renderer, so they are checked on
     it rather than twice. The chips and the blocks around them both drag, and
     the chip has to stop the event or one gesture would start both. */
  const vocab = ts();
  assert.match(vocab, /function attachTagCategoryDrag/, "a tag category cannot be dragged");
  assert.match(vocab, /function attachTagChipDrag/, "a tag cannot be dragged within its category");
  const chip = slice("src/tool/kanban.ts", "function attachTagChipDrag(", "\n}");
  assert.match(
    chip,
    /e\.stopPropagation\(\);/,
    "a chip drag also reaches the category block around it, so one gesture starts two drags",
  );
  const cat = slice("src/tool/kanban.ts", "function attachTagCategoryDrag(", "\n}");
  assert.match(
    cat,
    /grip\.addEventListener\("pointerdown"/,
    "the whole category block is draggable, so a missed chip drags the block",
  );
});

test("a reordered list is written back from the DOM, and dropped if it disagrees", () => {
  /* Every one of these reads the order back off the DOM at the end of the drag
     rather than tracking indices through it, which is what makes a release
     anywhere land correctly. The other half is the guard: if the DOM and the
     data hold different numbers of things (a row deleted from under the drag,
     a stray node), the reorder is dropped rather than writing a short list
     over a longer one. */
  const committers = [
    "function commitBoardOrderFromDom(",
    "function reorderTagsInCategory(",
    "function commitTagCategoryOrder(",
  ];
  const problems = [];
  for (const marker of committers) {
    const fn = slice("src/tool/kanban.ts", marker, "\n}");
    if (!/\.length !== /.test(fn)) {
      problems.push(`${marker} writes the new order without checking it is the same size`);
    }
  }
  assert.deepEqual(problems, []);
});

test("boards can be put in order, from a control and from the background menu", () => {
  /* `boards` array order is gallery order and nothing could change it: a board
     sat where it was created, and getting the one you use daily to the front
     meant deleting and remaking it.

     Two ways in, because anything offered in a right-click menu has to be
     reachable without one. The Setup row is the one without. */
  const ids = htmlIds();
  for (const id of [
    "kbBoardOrderBackdrop",
    "kbBoardOrderModal",
    "kbBoardOrderList",
    "kbBoardOrderEditBtn",
    "kbBoardOrderSummary",
    "kbBoardOrderBack",
    "kbBoardOrderClose",
  ]) {
    assert.ok(ids.has(id), `the board reorder screen has no #${id}`);
  }

  const src = ts();
  assert.match(src, /openBoardOrder\(\(\) => openSetupOnTab\("boards"\)\)/, "Setup has no way in");
  assert.match(src, /"Reorder Boards/, "the gallery background menu does not offer it");

  /* The Setup row sits on the Boards tab, which is where a fact about the
     boards you have belongs; the rest of that tab is what a NEW board starts
     as, so the two are ruled apart. */
  const html = read("index.html");
  const boardsTab = html.slice(html.indexOf('id="kbTabBoards"'), html.indexOf('id="kbTabTags"'));
  assert.ok(boardsTab.includes("kbBoardOrderEditBtn"), "the reorder row is not on the Boards tab");

  // The order is a fact about the collection, so it lives in the index. Put in
  // each board's own file it would mean one board deciding where another sits.
  const commit = slice("src/tool/kanban.ts", "function commitBoardOrderFromDom(", "\n}");
  assert.match(commit, /markIndex\(\);/, "a reorder is never saved");
  assert.ok(!commit.includes("markBoard("), "the board order is being written into a board's own file");
});

test("a bulk selection can be tagged, the same way one card can", () => {
  /* Tagging eleven cards at once was the one thing the multi-select could not
     do, so it was eleven right-clicks or eleven card openings, which is the
     work a multi-select exists to avoid.

     The mark has three states here and two on a single card, because a
     selection can be PARTLY tagged, and clicking a partial one puts the tag on
     everything rather than taking it off. */
  const menu = slice("src/tool/kanban.ts", "function bulkCardMenu(", "\nfunction ");
  assert.match(menu, /label: "Tags", submenu: tagItems/, "the bulk menu offers no Tags");
  assert.match(menu, /on === 0 \? "/, "the bulk tag rows do not distinguish none from some");
  assert.match(
    menu,
    /const removing = live\.length > 0 && live\.every\(/,
    "a partly-tagged selection is not resolved before acting on it",
  );
  assert.match(menu, /const live = selectedCards\(\);/, "the selection is not re-read when the row runs");
  assert.match(menu, /"Clear All Tags"/, "there is no way to take every tag off a selection");
});

test("the card's tag search can reach a tag that does not exist yet", () => {
  /* The moment you find a tag missing is the moment you were going to add it,
     and until now that meant leaving the card for Board Setup and finding your
     own way back. Both halves are checked: the offer, and the return trip. */
  const src = ts();
  assert.match(src, /function newTagFromCard/, "there is no way to make a tag from a card");
  assert.match(src, /tagEditReturn = \(\) => openCard\(cardId\)/, "the trip does not come back to the card");
  assert.match(src, /tagEditOnCreate = \(tag\) =>/, "a tag made this way is not put on the card");

  // The editor honors that destination instead of its own list, and clears it
  // so an ordinary trip afterwards is not redirected.
  const back = slice("src/tool/kanban.ts", "function returnToTagList(", "\n}");
  assert.match(back, /const custom = tagEditReturn;/, "returnToTagList ignores a caller's destination");
  assert.match(back, /tagEditReturn = null;/, "the destination is never cleared, so it fires twice");

  /* The panel is parented to <body> to escape the card modal's scroll
     container, which means nothing takes it down on its own. */
  assert.match(src, /function closeTagSearch/, "the dropdown cannot be closed");
  const cardModal = slice("src/tool/kanban.ts", "_cardModal = new Modal(backdrop, {", "\n  });");
  assert.match(cardModal, /closeTagSearch\(\);/, "closing the card leaves its tag dropdown on screen");
});

test("Kanban Setup opens on Boards, not on Tags", () => {
  // The first thing in a setup screen should be the thing the screen is named
  // after. It opened on Tags, which is the third tab.
  assert.match(
    ts(),
    /getElementById\("kbSetupBtn"\)!\.addEventListener\("click", \(\) => openSetupOnTab\("boards"\)\)/,
    "the Setup button does not land on Boards",
  );
});

test("a stage stamp carries a time, and a due date does not", () => {
  /* A due date is a TARGET, compared as whole days by the overdue check. A
     stage stamp is a RECORD of something that happened, and the time it
     happened at is most of the point. Storing both the same way meant either
     lying about one or losing the other.

     The failure this guards is quiet in both directions: a time on a due date
     is accepted by parseDay, written, and then dropped by normalizeDay at the
     next load, and a stage stamp normalized as a day loses its time the same
     way. */
  const src = ts();

  const day = slice("src/tool/kanban.ts", "function normalizeDay(", "\n}");
  assert.match(day, /\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$/, "a due date would accept a time and then lose it");

  const moment = slice("src/tool/kanban.ts", "function normalizeMoment(", "\n}");
  assert.match(moment, /replace\(" ", "T"\)/, "a stamp written with a space is not normalized");

  // The three stages go through normalizeMoment, the due date through normalizeDay.
  const dates = src.slice(src.indexOf("    dates: {"), src.indexOf("    dates: {") + 500);
  assert.match(dates, /due: normalizeDay\(/, "the due date is not normalized as a day");
  for (const stage of ["started", "testing", "completed"]) {
    assert.match(
      dates,
      new RegExp(`${stage}: normalizeMoment\\(`),
      `${stage} is not normalized as a moment, so its time is dropped on load`,
    );
  }

  // Both stamping paths record the moment, not the day.
  const advance = slice("src/tool/kanban.ts", "function advanceStage(", "\n}");
  assert.match(advance, /nowStamp\(\)/, "the stage button still stamps a bare day");
  const move = slice("src/tool/kanban.ts", "function moveCardToColumn(", "\n}");
  assert.match(move, /card\.dates\.completed = nowStamp\(\)/, "the drop-into-Done stamp is still a bare day");

  // And the input can actually hold a time.
  assert.match(src, /input\.type = "datetime-local"/, "the stage editor is still a date-only input");
});

test("Created shows its time beside the stages, and only shows it", () => {
  /* The three stage rows show a date and a time, and Created showed only the
     date, which reads as the time being unknown. It is known: createdAt is an
     exact instant. But the same card's day counts ("12 days old", lead time)
     and the stage order check read createdDay(), and a real time there would
     move a count by a day depending on the hour and flag a Work Started stamp
     from earlier on the creation day as out of order. So the time is for the
     row alone. */
  const stages = slice("src/tool/kanban.ts", "function renderCardStages(", "\n}");
  assert.ok(
    stages.includes('buildStageRow("Created", createdMoment(card), null)'),
    "the Created row is back to showing a bare date",
  );

  const moment = slice("src/tool/kanban.ts", "function createdMoment(", "\n}");
  assert.ok(moment.includes("localStamp("), "the creation time is not built from the local clock");
  assert.ok(!moment.includes("toISOString"), "the creation time is UTC, so it shows the wrong hour");

  for (const [name, start] of [
    ["the stage order check", "function stageOrderWarning("],
    ["the card stats", "function computeCardStats("],
  ]) {
    const body = slice("src/tool/kanban.ts", start, "\n}");
    assert.ok(body.includes("createdDay("), `${name} no longer reads the creation day`);
    assert.ok(!body.includes("createdMoment("), `${name} does day math on the creation TIME`);
  }
});

test("a stage stamp made before times existed still opens", () => {
  /* Every card written before this release holds a bare YYYY-MM-DD. A
     datetime-local input will not display one at all, so it would read as the
     stamp having been cleared, and the first save would make that true. */
  const row = slice("src/tool/kanban.ts", "function buildStageRow(", "\n}");
  assert.match(
    row,
    /hasTimeOfDay\(value\) \? value : `\$\{value\}T00:00`/,
    "an older date-only stamp has nothing to show in the input",
  );

  // And parseDay reads both, with the bare day still pinned to noon so
  // whole-day arithmetic survives a daylight-saving boundary.
  const parse = slice("src/tool/kanban.ts", "export function parseDay(", "\n}");
  assert.match(parse, /hasTime \? Number\(m\[4\]\) : 12/, "a bare day is no longer pinned to noon");
});

test("the stage order warning compares instants when both have a time, and days otherwise", () => {
  /* With a time on both stamps, "completed 09:00, work started 14:00" is out of
     order on one day, and rounding to whole days would say nothing at all. But
     created is only ever a bare day, and parseDay pins a bare day to noon, so
     comparing it as an instant made a 09:00 start on the creation day read as
     "work started is before created". */
  const fn = slice("src/tool/kanban.ts", "export function stageOrderWarning(", "\n}");
  assert.ok(!fn.includes("dayDiff("), "the ordering check still rounds timed stamps to whole days");
  assert.match(fn, /hasTimeOfDay\(prev\) && hasTimeOfDay\(cur\)/, "a bare day is compared as an instant again, so a morning stamp on the creation day is flagged");
  assert.match(fn, /parseDay\(prev\)\?\.getTime\(\)/, "two timed stamps are no longer compared as instants");
  assert.match(fn, /cur\.slice\(0, 10\) < prev\.slice\(0, 10\)/, "a bare day is no longer compared by its day");
});

test("changing the shape of a stored field bumps the data-folder version", () => {
  /* An older build hands each stage value to a YYYY-MM-DD regex, gets no match,
     and normalizes it to null: it does not ignore the time, it drops the whole
     stamp and then writes the card back without it. That is the case the
     version stamp exists for, as opposed to a NEW field an older build would
     simply skip, which must not bump it. */
  const lib = read("src-tauri/src/lib.rs");
  const m = /pub\(crate\) const DATA_SCHEMA_VERSION: u32 = (\d+);/.exec(lib);
  assert.ok(m, "the data schema version is gone");
  assert.ok(Number(m[1]) >= 2, "stage stamps changed shape without the folder version moving");
  assert.match(lib, /2 = Kanban stage stamps carry a time/, "the new version is not written down");
});

test("resetting a board's card numbers cannot reuse a number in play", () => {
  /* A card number is permanent and human-facing: it goes in commit messages and
     gets handed to agents. The counter only goes up, which is right, and leaves
     one honest complaint: three deleted test cards mean the first real one is
     #4 forever.

     The reset winds the counter to one past the highest number STILL on the
     board. It closes a gap at the top and nothing else. */
  const safe = slice("src/tool/kanban.ts", "function safeNextCardNumber(", "\n}");
  assert.match(safe, /Math\.max\(max, c\.number\)/, "the floor is not the highest number in use");
  assert.ok(
    !safe.includes("archived"),
    "archived cards are excluded, so restoring one could collide with a live card",
  );

  const reset = slice("src/tool/kanban.ts", "function requestResetCardNumbers(", "\n}");
  assert.match(reset, /if \(safe >= board\.nextCardNumber\) return;/, "the reset can raise the counter");
  assert.match(reset, /kbConfirm\(/, "the reset does not ask first");
  assert.match(reset, /board\.nextCardNumber = safe;/, "the reset writes something other than the safe floor");

  // It must not renumber anything: that is what would break every reference
  // anybody has written down.
  assert.ok(!/\.number\s*=/.test(reset), "the reset renumbers existing cards");

  // And it is per board, in that board's own file, which is what keeps it safe
  // against snapshots: a restore brings back cards and counter together.
  assert.match(reset, /markBoard\(board\.id\)/, "the reset is not saved to the board it belongs to");
});

test("the board gallery sorts the way the sidebar does", () => {
  /* The same shape as the sidebar's sort, the same rule that dragging switches
     you to Custom, and the same reason: this is that feature one level down.

     NOT the same modes, though. The sidebar's "Classic" is the order ALL_TOOLS
     is written in, which a person can recognize; boards have no such order, so
     "Classic" there meant "oldest first" while saying nothing about it. Two
     honest modes instead, newest first by default. */
  const modes = slice("src/tool/kanban.ts", "export const BOARD_SORT_MODES", "\n];");
  for (const mode of ["newest", "oldest", "az", "za", "recent", "used", "custom"]) {
    assert.ok(modes.includes(`"${mode}"`), `the board sort has no ${mode} mode`);
  }
  assert.ok(
    !modes.includes('"classic"'),
    "the board sort still offers Classic, which means nothing for boards",
  );

  /* No rename map, on purpose. Board sorting has not shipped, so "classic"
     cannot be sitting in anyone's file, and a permanent map guarding a value
     that never existed in the wild is machinery with nothing behind it. An
     unrecognized stored mode falls back to the default like any other. */
  const norm = slice("src/tool/kanban.ts", "function normalizeBoardSort(", "\n}");
  assert.ok(
    !norm.includes("RENAMED"),
    "the board sort carries a rename map for a value that never shipped",
  );
  assert.match(
    norm,
    /DEFAULT_SETTINGS\.boardSort/,
    "an unrecognized stored board sort does not fall back to the default",
  );

  // New installs open newest first.
  const defaults = slice("src/tool/kanban.ts", "const DEFAULT_SETTINGS: KbSettings = {", "\n};");
  assert.match(defaults, /boardSort: "newest"/, "a new install does not open newest first");

  // Every mode offered is one the sorter actually handles.
  const sorter = slice("src/tool/kanban.ts", "function applyBoardSortMode(", "\n}");
  for (const mode of ["newest", "oldest", "az", "za", "recent", "used"]) {
    assert.ok(sorter.includes(`case "${mode}"`), `the sorter does not handle ${mode}`);
  }

  // Custom is reachable only by dragging, so it is disabled in the picker.
  const html = read("index.html");
  const select = html.slice(html.indexOf('id="kbBoardSortSelect"'), html.indexOf("</select>", html.indexOf('id="kbBoardSortSelect"')));
  assert.match(select, /value="custom" disabled/, "Custom can be picked from the list");

  // A drag switches the mode, or the next render would undo the drag.
  const commit = slice("src/tool/kanban.ts", "function commitBoardOrderFromDom(", "\n}");
  assert.match(commit, /kbSettings\.boardSort = "custom"/, "dragging a board does not switch to Custom");

  // Opening a board is what feeds the usage sorts, and it is NOT an edit.
  const usage = slice("src/tool/kanban.ts", "function recordBoardUsage(", "\n}");
  assert.match(usage, /board\.lastOpenedAt = Date\.now\(\)/, "opening a board is not recorded");
  assert.ok(!usage.includes("updatedAt"), "opening a board is being recorded as editing it");

  // Both places a board can be dragged land on the same committer.
  const src = ts();
  assert.match(src, /commitBoardOrderFromDom\(boardGrid, "\.kb-board-tile"\)/, "gallery tiles cannot be dragged");
  assert.match(src, /commitBoardOrderFromDom\(host, "\.kb-board-order-row"\)/, "the reorder modal cannot be dragged");
});

test("a tool's own background menu keeps the app-wide rows", () => {
  /* attachMenu stops the event once it has rows to show, so a menu on a whole
     view replaces the window-level one in shell.ts rather than adding to it.
     Kanban's gallery grew a menu and quietly took About, App Settings, Toggle
     View and Exit away from every right-click on that screen. */
  const src = ts();
  const at = src.indexOf('attachMenu(document.getElementById("kbViewBoards")');
  assert.notEqual(at, -1, "the gallery background has no menu");
  const menu = src.slice(at, src.indexOf("]);", at));
  assert.match(menu, /\.\.\.backgroundMenu\(\)/, "the gallery menu drops the app-wide rows");
  assert.match(menu, /\{ separator: true \}/, "the tool's own rows are not ruled off from the app's");

  // And shell.ts has to be offering it.
  assert.match(
    read("src/core/shell.ts"),
    /export function backgroundMenu\(\)/,
    "the app-wide background menu is not shared",
  );
});

test("the Subtasks and Comments tab counts follow every change, not just opening the card", () => {
  /* Ticking a subtask redrew "2 of 5 done (40%)" and left the tab reading 1/5
     until the card was closed and opened again, because the counts were only
     drawn on open. Every subtask and comment change already comes back through
     its list's render, so the counts are drawn there. */
  const subtasks = slice("src/tool/kanban.ts", "function renderCardSubtasks(", "\n}");
  assert.match(subtasks, /renderCardTabCounts\(card\)/, "ticking a subtask leaves the Subtasks tab count stale");
  const comments = slice("src/tool/kanban.ts", "function renderCardComments(", "\n}");
  assert.match(comments, /renderCardTabCounts\(card\)/, "adding a comment leaves the Comments tab count stale");
});
