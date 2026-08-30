/* =============================================================================
   KANBAN
   -----------------------------------------------------------------------------
   The Kanban tool makes two promises the rest of the app never has to, and
   both fail silently if broken.

   The first is CONTRAST. A card can be painted a color the theme knows nothing
   about, and its title text is then chosen rather than inherited. A palette
   entry that no ink reads well on produces a card that is simply hard to read,
   with nothing anywhere reporting a problem.

   The second is that its PREFERENCES round-trip. Nine On/Off switches are each
   wired in two separate places, one to write the setting and one to restore it
   on the next open. Miss the second and the switch works perfectly right up
   until you reopen Setup, where it has quietly reverted.

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
    html.indexOf('id="kbTabSecurity"'),
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

test("a snapshot name from the front end is validated before it becomes a path", () => {
  const rs = read("src-tauri/src/tools/kanban.rs");
  const fn = rs.slice(rs.indexOf("pub fn read_kanban_backup"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.match(body, /valid_bucket_name\(&name\)/, "the snapshot name is not validated");
  assert.ok(
    body.indexOf("valid_bucket_name") < body.indexOf("join(&name)"),
    "the name is joined onto a path before it is validated",
  );
});

test("a restore goes through the ordinary save, so it snapshots what it replaces", () => {
  // This is the whole reason read_kanban_backup is a read and not a restore: the
  // state being replaced has to be captured on the way past, or the recovery
  // feature becomes the thing you need recovering from.
  const src = ts();
  const fn = src.slice(src.indexOf("async function restoreBackup"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.match(body, /await flushSave\(\)/, "a queued edit would be lost before the restore");
  assert.ok(
    body.indexOf("flushSave") < body.indexOf("read_kanban_backup"),
    "the pending edit must land before the snapshot is read",
  );

  // Every write path snapshots what it is about to overwrite. There are three
  // now rather than one, and missing any of them means that kind of file is
  // silently unrecoverable.
  const rs = read("src-tauri/src/tools/kanban.rs");
  for (const name of ["save_kanban_board", "save_kanban_index", "kanban_save_board_encrypted"]) {
    const at = rs.indexOf(`pub fn ${name}`);
    assert.notEqual(at, -1, `${name} does not exist`);
    assert.match(
      rs.slice(at, rs.indexOf("\n}", at)),
      /backed_up_write_group/,
      `${name} does not snapshot what it replaces`,
    );
  }
});

test("a board write snapshots that board and the index, and no other board", () => {
  // The whole reason the files were split. If board_group ever grows, an
  // afternoon spent on one board goes back to copying every board you own,
  // which is exactly the problem the split was for.
  const rs = read("src-tauri/src/tools/kanban.rs");
  const at = rs.indexOf("fn board_group(");
  assert.notEqual(at, -1, "board_group does not exist");
  const body = rs.slice(at, rs.indexOf("\n}", at));
  const entries = [...body.matchAll(/board_(?:plain|enc)_name\(id\)|INDEX_FILE/g)].map((m) => m[0]);
  assert.deepEqual(
    entries,
    ["board_plain_name(id)", "board_enc_name(id)", "INDEX_FILE"],
    "a board write should snapshot that board (both forms) and the index, nothing else",
  );
});

test("the plaintext save path refuses a board that is encrypted", () => {
  // save_kanban_board takes no password and cannot produce an envelope. If it
  // ever wrote anyway, the board would silently drop out of encryption and its
  // cards would land on disk in the clear, with the UI still showing a padlock.
  const rs = read("src-tauri/src/tools/kanban.rs");
  const at = rs.indexOf("pub fn save_kanban_board");
  const body = rs.slice(at, rs.indexOf("\n}", at));
  assert.ok(body.includes("board_enc_name(&board_id)"), "it never looks for an envelope");
  assert.ok(body.includes("return Err"), "it does not refuse");
});

test("a locked board is never written from memory it does not have", () => {
  // A locked board's contents are not in memory. Saving one would write an
  // empty board over a full one, which is the single most destructive thing
  // this tool could do, so it is refused rather than assumed impossible.
  const src = ts();
  const at = src.indexOf("async function saveNow(");
  const body = src.slice(at, src.indexOf("\n}", at));
  assert.ok(body.includes("board.locked"), "saveNow does not check whether the board is locked");
});

test("the tool lock is a gate and never a second layer of encryption", () => {
  // The question this whole design exists to answer: three encrypted boards
  // plus a locked tool must not mean anything is encrypted twice, and must not
  // require decrypting anything first. That holds precisely as long as turning
  // the gate on only ever touches a preference, and passing it only verifies.
  const src = ts();
  const gateAt = src.indexOf("function gateRequired(");
  assert.notEqual(gateAt, -1, "the gate check does not exist");

  const gate = src.slice(gateAt, src.indexOf("async function submitAuthGate"));
  for (const forbidden of [
    "kanban_encrypt_board",
    "kanban_decrypt_board_to_plain",
    "save_kanban_board",
  ]) {
    assert.ok(!gate.includes(forbidden), `the tool lock calls ${forbidden}, so it is not just a gate`);
  }

  const submitAt = src.indexOf("async function submitAuthGate");
  const submit = src.slice(submitAt, src.indexOf("\n}", submitAt));
  assert.ok(submit.includes("kanban_verify_password"), "the gate does not verify the password");
  assert.ok(
    !submit.includes("kanban_decrypt_board"),
    "the gate decrypts a board, which is the job of opening one",
  );
});

test("the lock-on-open preference cannot be set with no password to ask for", () => {
  // Otherwise the gate would be on with nothing to check against, and would
  // either lock the user out permanently or wave everyone through.
  const src = ts();
  const at = src.indexOf('const lockOnOpen = document.getElementById("kbLockOnOpenToggle")');
  assert.notEqual(at, -1, "the lock-on-open switch is not wired");
  assert.ok(
    src.slice(at, at + 900).includes("encryptedBoardIds.size === 0"),
    "it does not check that a password exists",
  );
});

test("the password is held in memory and never written to a file", () => {
  const src = ts();
  assert.match(
    src,
    /let sessionPassword: string \| null = null;/,
    "there is no single place the password is held",
  );
  // The three plaintext write commands must never be handed it, in any
  // argument. Only the encrypted path takes a password, and it takes it as
  // `password`, never as `data`.
  for (const [call] of src.matchAll(
    /invoke\(\s*"(?:save_kanban_settings|save_kanban_index|save_kanban_board)"[\s\S]{0,220}?\)/g,
  )) {
    assert.ok(!call.includes("sessionPassword"), `a plaintext write carries the password: ${call}`);
  }
});

test("every Kanban security control is wired to something", () => {
  // These live outside bindPreferenceControls/applySettingsToForm (they need
  // the encrypted-board count, which is not a preference), so the earlier
  // round-trip check does not cover them. This is their equivalent.
  const html = read("index.html");
  const pane = html.slice(html.indexOf('id="kbTabSecurity"'), html.indexOf('id="kbTabData"'));
  assert.ok(pane.length > 300, "could not isolate the Kanban security pane");

  const src = ts();
  const controls = [...pane.matchAll(/id="(kb[A-Za-z]+(?:Toggle|Btn|List|Status))"/g)].map(
    (m) => m[1],
  );
  assert.ok(controls.length >= 4, `expected the security controls, found ${controls.length}`);
  const orphans = controls.filter((id) => !src.includes(`"${id}"`));
  assert.deepEqual(orphans, [], "these security controls exist but nothing reads them");
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
  // View switching and the lock gate both used to set these displays, and they
  // disagreed: clicking the sidebar icon while the gate was up unhid the
  // gallery from behind it. Revealing a locked board has to be impossible by
  // construction, so exactly one function may touch this.
  const src = ts();
  const at = src.indexOf("function applyViewVisibility(");
  assert.notEqual(at, -1, "applyViewVisibility does not exist");
  const owner = src.slice(at, src.indexOf("\n}", at));
  assert.ok(owner.includes("authGateShowing"), "the one owner does not consult the gate");

  // Every other assignment to those three elements' display is a bug.
  const strays = [];
  for (const [line] of src.matchAll(
    /^\s*(?:authView|viewBoards|viewBoard|boardStatsBtn)\.style\.display\s*=.*$/gm,
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

  for (const fn of ["function kbConfirm(", "function promptForPassword("]) {
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
    if (!m[1].includes("reopen:")) {
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
  const start = html.indexOf('id="utility-tool-kanban"');
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
