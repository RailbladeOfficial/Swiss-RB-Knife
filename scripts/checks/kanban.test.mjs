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
  const html = read("index.html");
  const pane = html.slice(
    html.indexOf('id="kbTabPreferences"'),
    html.indexOf('id="kbTabData"'),
  );
  assert.ok(pane.length > 500, "could not isolate the Kanban preferences pane");

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
    html.indexOf('id="kbTabPreferences"'),
    html.indexOf('id="kbTabSecurity"'),
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
  // the window, cancelled with Escape). Committing on drop instead leaves the
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

test("the tool refuses to be entered before it has initialised", () => {
  // Not defensiveness for its own sake. shell.ts calls loadShellState() at the
  // TOP of its init and every init*() at the bottom, so an install whose saved
  // startup target is this tool navigates into it, and fires its entry hook,
  // before a single element reference here has been assigned. Kanban's hooks
  // touch pre-assigned refs, so without this the app crashes on launch and the
  // only way out is hand-editing the settings file.
  const src = ts();
  assert.match(src, /let initialised = false;/, "there is no initialised flag");
  assert.match(src, /\n  initialised = true;/, "the flag is never set");

  for (const hook of ["onKanbanToolEntry", "onKanbanIconClicked", "onKanbanToolExit"]) {
    const at = src.search(new RegExp(String.raw`export (?:async )?function ${hook}\(`));
    assert.notEqual(at, -1, `${hook} does not exist`);
    const body = src.slice(at, src.indexOf("\n}", at));
    assert.ok(
      /if \(!initialised\) return;/.test(body),
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
    "overdueWarn",
    "defaultColumns",
    "defaultBoardName",
    "lockOnOpen",
    "sectionOrder",
    "priorityColors",
  ];

  // Three places may touch the defaults directly, because handling the defaults
  // IS their job: the resolver that merges them with a board's overrides, and
  // the two halves of the Preferences tab that read and write them.
  const exempt = [
    "function effective(board: Board | null)",
    "function bindPreferenceControls(",
    "function applySettingsToForm(",
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
  assert.ok(
    boardsTab.includes("kbDefaultColumnsList") && boardsTab.includes("kbDefaultBoardNameInput"),
    "the Boards tab should hold the defaults for a new board",
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

  const labels = slice("src/tool/kanban.ts", "export const PRIORITY_LABELS", "};");
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

  // Streamed, never read whole: an attachment can be a screen recording, and
  // the encrypted path has to hold one chunk rather than one file.
  assert.match(body, /fs::copy\(source, &temp\)/, "the copy is not streamed");
  assert.ok(!/fs::read\(/.test(body), "the whole file is read into memory to copy it");

  // Through a temporary name, so a copy interrupted half way never appears
  // under the name a card is about to point at.
  assert.match(body, /fs::rename\(&temp, &final_path\)/, "the copy is not renamed into place");

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
  assert.match(src, /let saveChain: Promise<void>/, "saves are not serialised");

  const at = src.indexOf("function saveNow(");
  const body = src.slice(at, src.indexOf("\n}", at));
  assert.match(body, /saveChain = saveChain/, "saveNow does not queue behind the running save");
  assert.match(body, /return saveChain;/, "saveNow does not resolve on its own write");

  const flushAt = src.indexOf("async function flushSave(");
  const flush = src.slice(flushAt, src.indexOf("\n}", flushAt));
  assert.match(flush, /await saveNow\(\)/, "flushSave does not await the chain");

  // Nothing may reach the writer except through the chain: its declaration,
  // the one .then() that runs it, and the comment naming it.
  const uses = [...src.matchAll(/\bwriteDirty\b/g)].length;
  assert.equal(uses, 3, `writeDirty is named ${uses} times; only the declaration, the chain and one comment should mention it`);
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
    body.indexOf("remove_dir_all(backups_root.join(old_name))") <
      body.indexOf("prune_kanban_attachment_store("),
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

  // And the cutoff is the OLDEST SURVIVING bucket, taken after the drop.
  assert.match(body, /existing_buckets\.drain\(/, "the pruned buckets are still counted as surviving");
  assert.match(body, /existing_buckets\.first\(\)/, "the cutoff is not the oldest surviving bucket");
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
