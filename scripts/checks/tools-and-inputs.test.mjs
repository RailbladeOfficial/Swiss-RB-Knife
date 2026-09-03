/* =============================================================================
   TOOLS AND INPUTS
   -----------------------------------------------------------------------------
   Two kinds of check.

   Tools: adding or removing a tool means touching several places by hand, with
   nothing reconciling them. Miss one and the tool is half-present: a card that
   opens nothing, or a tool with no way to reach it.

   Inputs: number and slider fields carry their limits as attributes in the page.
   These confirm those limits are sane, because a field whose starting value sits
   outside its own limits, or whose limits are backwards, behaves unpredictably
   the first time it is touched.
============================================================================= */

import test from "node:test";
import assert from "node:assert/strict";
import { read, exists, slice, filesUnder, htmlIds } from "./_source.mjs";

/** The tool registry, the single list everything else is supposed to match. */
function allTools() {
  const block = slice("src/core/shell.ts", "const ALL_TOOLS", "];");
  return [...block.matchAll(
    /key: "([^"]+)", section: "([a-z-]+)", tool: "([a-z-]+)", label: "([^"]+)"/g,
  )].map((m) => ({ key: m[1], section: m[2], tool: m[3], label: m[4] }));
}

/** The category ids the headings are built from, in heading order. */
function toolCategories() {
  const block = slice("src/core/shell.ts", "const TOOL_CATEGORIES", "];");
  return [...block.matchAll(/id: "([a-z-]+)", label: "([^"]+)"/g)].map((m) => ({
    id: m[1], label: m[2],
  }));
}

test("the tool list is not empty (guards every tool check below)", () => {
  // Without this, a parsing change would make the checks below pass by
  // checking nothing at all.
  assert.ok(allTools().length >= 9, `expected the full tool list, parsed ${allTools().length}`);
});

test("every tool has BOTH a sidebar entry and a dashboard card", () => {
  // Checked separately on purpose. An earlier version of this test only asked
  // whether the tool was mentioned anywhere, which meant deleting the card
  // still passed because the sidebar entry alone satisfied it. Mutation testing
  // caught that; each way in is now verified in its own right.
  //
  // The third way in, .dashboard-tool-btn, is deliberately not required: only
  // Kanban has one, so it is a partial feature rather than part of the
  // contract.
  const html = read("index.html");
  const missing = [];
  for (const t of allTools()) {
    const marks = `data-section="${t.section}" data-tool="${t.tool}"`;
    for (const cls of ["nav-item", "tool-card"]) {
      if (!new RegExp(`class="${cls}"[^>]*${marks}`).test(html)) {
        missing.push(`${t.label}: no ${cls}`);
      }
    }
  }
  assert.deepEqual(missing, [], "these tools cannot be opened the usual way");
});

test("every tool lives in a category that has a heading", () => {
  // A tool's category IS its section. The headings are built by walking
  // TOOL_CATEGORIES and filtering the tool list into each one, so a tool whose
  // section is not in that list matches no group: it does not merely lose its
  // heading, it vanishes from the sidebar and from Home, and only while Tool
  // Categories is on, which is exactly the kind of thing nobody notices for a
  // month.
  const known = new Set(toolCategories().map((c) => c.id));
  assert.ok(known.size >= 2, `expected the category list, parsed ${known.size}`);

  const stranded = allTools()
    .filter((t) => !known.has(t.section))
    .map((t) => `${t.label} (${t.section})`);
  assert.deepEqual(stranded, [], "these tools would disappear when categories are on");
});

test("every category heading has at least one tool under it", () => {
  // The reverse: a category nothing is assigned to is a heading that can never
  // appear, so it is dead weight in the list rather than a bug on screen. Worth
  // failing on anyway, because it is usually a half-finished rename.
  const tools = allTools();
  const empty = toolCategories()
    .filter((c) => !tools.some((t) => t.section === c.id))
    .map((c) => c.id);
  assert.deepEqual(empty, [], "these categories have no tools");
});

test("a tool's key always matches the section and tool it is built from", () => {
  // key, section and tool are written out separately in ALL_TOOLS, and every
  // lookup in the app assumes "<section>/<tool>". A key that disagrees with its
  // own pair silently breaks pin state and usage counts for that one tool.
  const wrong = allTools()
    .filter((t) => t.key !== `${t.section}/${t.tool}`)
    .map((t) => `${t.key} != ${t.section}/${t.tool}`);
  assert.deepEqual(wrong, [], "these keys disagree with their own section/tool");
});

test("every renamed tool key points at a tool that still exists", () => {
  // RENAMED_TOOL_KEYS is what stops a re-categorisation from quietly wiping a
  // tool's place in the sidebar order, its pin state and its usage counts. An
  // entry whose target is not a real key does nothing at all, and does nothing
  // silently: the stale key is dropped exactly as if there were no map.
  const block = slice("src/core/shell.ts", "RENAMED_TOOL_KEYS: Record<string, string>", "};");
  const pairs = [...block.matchAll(/"([^"]+)": "([^"]+)"/g)].map((m) => [m[1], m[2]]);
  assert.ok(pairs.length > 0, "parsed no rename entries");

  const known = new Set(allTools().map((t) => t.key));
  const broken = pairs.filter(([, to]) => !known.has(to)).map(([from, to]) => `${from} -> ${to}`);
  assert.deepEqual(broken, [], "these renames point at keys no tool has");

  const notStale = pairs.filter(([from]) => known.has(from)).map(([from]) => from);
  assert.deepEqual(notStale, [], "these old keys are still live tool keys, so the rename is wrong");
});

test("every tool lives in a section that exists", () => {
  const sections = new Set(
    [...read("index.html").matchAll(/id="section-([a-z-]+)"/g)].map((m) => m[1]),
  );
  const orphans = allTools().filter((t) => !sections.has(t.section));
  assert.deepEqual(
    orphans.map((t) => `${t.label} (in "${t.section}")`),
    [],
    "these tools are filed under a section that does not exist in the page",
  );
});

test("every tool's view sits inside its own category's section", () => {
  // activateTool() hides "#section-<section> .tool-view" and then shows
  // "#<section>-tool-<tool>". A view whose id says one category while it
  // physically sits in another opens to a blank pane: the show finds it, the
  // hide that runs on the NEXT navigation never does, so it is also left
  // stacked under whatever opens after it. Re-categorising a tool means
  // physically moving its view, and this is the only thing that says so.
  const html = read("index.html");
  const bounds = [...html.matchAll(
    /<section id="section-([a-z-]+)" class="content-section[^>]*>/g,
  )].map((m) => ({ id: m[1], start: m.index }));
  bounds.forEach((b, i) => {
    b.end = i + 1 < bounds.length ? bounds[i + 1].start : html.length;
  });
  assert.ok(bounds.length > 1, "parsed no section containers");

  const misplaced = [];
  for (const t of allTools()) {
    const at = html.indexOf(`id="${t.section}-tool-${t.tool}"`);
    if (at === -1) {
      misplaced.push(`${t.label}: no view #${t.section}-tool-${t.tool}`);
      continue;
    }
    const holder = bounds.find((b) => at > b.start && at < b.end);
    if (holder?.id !== t.section) {
      misplaced.push(`${t.label}: view sits in section-${holder?.id ?? "none"}, not section-${t.section}`);
    }
  }
  assert.deepEqual(misplaced, [], "these tool views are in the wrong section container");
});

test("every tool has its own code and styling files", () => {
  const missing = [];
  for (const t of allTools()) {
    // Dummy File Generator's files are named file-gen, so the check is that
    // SOME file pair exists for the tool, matched on either naming.
    const candidates = [t.tool, t.tool.replace(/^dummy-/, "").replace(/-generator$/, "-gen")];
    const hasTs = candidates.some((c) => exists(`src/tool/${c}.ts`));
    const hasCss = candidates.some((c) => exists(`src/tool/${c}.css`));
    if (!hasTs) missing.push(`${t.label}: no .ts file`);
    if (!hasCss) missing.push(`${t.label}: no .css file`);
  }
  assert.deepEqual(missing, [], "these tools are missing their own files");
});

test("every tool's stylesheet is actually loaded by the page", () => {
  // A stylesheet that exists but is never linked means the tool renders
  // unstyled, which looks like a broken screen rather than a missing file.
  const html = read("index.html");
  const linked = new Set(
    [...html.matchAll(/<link[^>]*href="(src\/tool\/[^"]+\.css)"/g)].map((m) => m[1]),
  );
  const onDisk = filesUnder("src/tool", ".css");
  const unlinked = onDisk.filter((f) => !linked.has(f));
  assert.deepEqual(unlinked, [], "these tool stylesheets exist but are never loaded");
});

test("no number or slider field starts outside its own limits", () => {
  const problems = [];
  for (const m of read("index.html").matchAll(/<input[^>]*>/g)) {
    const tag = m[0];
    if (!/type="(number|range)"/.test(tag)) continue;
    const num = (name) => {
      const hit = new RegExp(`${name}="(-?[0-9.]+)"`).exec(tag);
      return hit ? Number(hit[1]) : null;
    };
    const id = (/id="([^"]+)"/.exec(tag) || [])[1] ?? "(unnamed field)";
    const [min, max, value, step] = [num("min"), num("max"), num("value"), num("step")];

    if (min !== null && max !== null && min >= max) problems.push(`${id}: min ${min} >= max ${max}`);
    if (value !== null && min !== null && value < min) problems.push(`${id}: starts at ${value}, below its minimum ${min}`);
    if (value !== null && max !== null && value > max) problems.push(`${id}: starts at ${value}, above its maximum ${max}`);
    if (step !== null && step <= 0) problems.push(`${id}: step ${step} must be positive`);
  }
  assert.deepEqual(problems, []);
});

test("every input the app reads is a field it can actually read", () => {
  // The code casts these to input elements. If one is a <div> or a <select>,
  // reading .value gives undefined and the setting silently never applies.
  const html = read("index.html");
  const source = filesUnder("src", ".ts").map(read).join("\n");
  const asInput = [
    ...source.matchAll(
      /getElementById\(\s*["']([A-Za-z0-9_-]+)["']\s*\)\s*(?:as\s+HTML(?:Input|TextArea|Select)Element|\)?\s*as\s+HTML(?:Input|TextArea|Select)Element)/g,
    ),
  ].map((m) => m[1]);

  const wrong = [];
  for (const id of new Set(asInput)) {
    const at = html.indexOf(`id="${id}"`);
    if (at === -1) continue; // covered by the wiring check
    const tagStart = html.lastIndexOf("<", at);
    const tag = html.slice(tagStart, html.indexOf(">", at) + 1);
    if (!/^<(input|textarea|select)\b/.test(tag)) {
      wrong.push(`${id} is read as a form field but is a ${/^<([a-z]+)/.exec(tag)?.[1]}`);
    }
  }
  assert.deepEqual(wrong, []);
});

test("no dropdown is left permanently empty", () => {
  // A dropdown can legitimately ship empty and be filled from code at runtime
  // (the Cycle day/night theme pickers and the Countdown sound list both do).
  // What is never right is a dropdown that is empty in the page AND that no
  // code ever touches: that one is empty forever, and reads to the user as a
  // setting that refuses to open.
  const html = read("index.html");
  const source = filesUnder("src", ".ts").map(read).join("\n");

  const problems = [];
  for (const m of html.matchAll(/<select\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const [, id, contents] = m;
    if (/<option/.test(contents)) continue; // ships with choices
    if (source.includes(`"${id}"`)) continue; // filled from code
    problems.push(`${id} has no options and no code fills it`);
  }
  assert.deepEqual(problems, []);
});

test("every dropdown that ships with choices is one the app knows about", () => {
  // The reverse orphan: a populated dropdown nothing reads is a control the
  // user can change with no effect.
  const html = read("index.html");
  const source = filesUnder("src", ".ts").map(read).join("\n");
  const ignored = [];
  for (const m of html.matchAll(/<select\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const [, id, contents] = m;
    if (!/<option/.test(contents)) continue;
    if (!source.includes(`"${id}"`)) ignored.push(id);
  }
  assert.deepEqual(ignored, [], "these dropdowns have choices but nothing reads them");
});

/* -----------------------------------------------------------------------------
   HOUSE STANDARDS
   -----------------------------------------------------------------------------
   Jobs every tool has to do the SAME way. Each of these started as two tools
   quietly doing it differently, which is invisible until the day the difference
   is the bug.
----------------------------------------------------------------------------- */

test("nothing logs to the console except through the dev-only helpers", () => {
  // devError and devWarn compile out of a production build; a bare console call
  // does not, and ships diagnostics to end users beside sibling calls that are
  // correctly silent. theme-core.ts had three of these, because the helpers
  // used to live in shell.ts and theme-core deliberately does not import shell.
  /** Blanks out every `if (__DEV__) { ... }` block, keeping the file's length
   *  and line breaks so reported line numbers stay true. A whole block behind
   *  the dev flag is already compiled out, however much is inside it. */
  const stripDevBlocks = (text) => {
    let out = text;
    for (;;) {
      const at = out.search(/if \(__DEV__\) \{/);
      if (at === -1) return out;
      let depth = 0;
      let i = out.indexOf("{", at);
      const start = i;
      for (; i < out.length; i++) {
        if (out[i] === "{") depth++;
        else if (out[i] === "}" && --depth === 0) break;
      }
      const body = out.slice(start, i + 1);
      out = out.slice(0, start) + body.replace(/[^\n]/g, " ") + out.slice(i + 1);
    }
  };

  const offenders = [];
  for (const file of filesUnder("src", ".ts")) {
    // The helpers themselves, obviously.
    if (file.endsWith("core/dev-log.ts")) continue;
    const text = stripDevBlocks(read(file));
    for (const m of text.matchAll(/(?<![\w.])console\.(log|warn|error|info|debug)\s*\(/g)) {
      const line = text.slice(0, m.index).split("\n").length;
      offenders.push(`${file}:${line} console.${m[1]}`);
    }
  }
  assert.deepEqual(offenders, [], "these log straight to the console in production builds");
});

test("there is one base64 codec, not one per tool", () => {
  // Game Stats moves a spreadsheet across the IPC boundary and Kanban moves a
  // pasted image. Both need base64, and for a while both had their own copy of
  // it: the same algorithm twice, two error messages, and two places for a bug
  // to be fixed in one of.
  const copies = [];
  for (const file of filesUnder("src-tauri/src", ".rs")) {
    const text = read(file);
    for (const m of text.matchAll(/^(?:pub\(crate\) )?fn base64_(?:en|de)code\b/gm)) {
      const line = text.slice(0, m.index).split("\n").length;
      copies.push(`${file}:${line}`);
    }
  }
  assert.deepEqual(
    copies.filter((c) => !c.startsWith("src-tauri/src/lib.rs")),
    [],
    "these files carry their own base64 instead of using the shared one in lib.rs",
  );
});

test("every tool that keeps user data writes it without leaving a half-file", () => {
  // atomic_write and backed_up_write_group both write through a temp file and
  // rename. A bare fs::write to a data-directory path does not, and an install
  // that force-terminates the app mid-write (which is how Windows upgrades one)
  // leaves a truncated file where the data was.
  const offenders = [];
  for (const file of filesUnder("src-tauri/src", ".rs")) {
    const text = read(file);
    for (const m of text.matchAll(/fs::write\(&?(\w+)/g)) {
      const target = m[1];
      // Temporaries, staging files and export destinations are not the app's
      // own data files; each is named for what it is.
      if (/^(temp|tmp|out|dest|path|file_path|src|sealed|sealed2|p)$/.test(target)) continue;
      // The snapshot copy itself. A torn .bak costs one bucket and is not a
      // torn data file, which is the thing the atomic helper exists to stop;
      // routing it through that helper would also mean snapshotting a snapshot.
      if (target === "snapshot_dir") continue;
      const line = text.slice(0, m.index).split("\n").length;
      offenders.push(`${file}:${line} fs::write(${target})`);
    }
  }
  assert.deepEqual(offenders, [], "these write a data file without the atomic helper");
});

test("a tool's own files go through the shared store, not a pair of its own", () => {
  // Nine tools had each grown an identical save/load pair: atomic_write in,
  // read_to_string with a hardcoded empty shape out, differing only in a
  // filename. Nine places to remember when the write path changes.
  //
  // Budget's data and Kanban's index and board files are deliberately NOT here:
  // they snapshot what they overwrite and can be encrypted, which is a
  // different job rather than the same job written out again.
  const lib = read("src-tauri/src/lib.rs");
  assert.match(lib, /fn tool_file\(tool_id: &str, kind: &str\)/, "there is no shared tool-file store");

  const allowed = new Set([
    "save_kanban_index", "load_kanban_index",
    "save_kanban_board", "load_kanban_board",
    "save_budget_data", "load_budget_data",
    "save_budget_entities", "load_budget_entities",
  ]);
  const strays = [];
  for (const file of filesUnder("src-tauri/src/tools", ".rs")) {
    const text = read(file);
    for (const m of text.matchAll(/#\[tauri::command\][\s\S]{0,160}?fn\s+((?:save|load)_[a-z0-9_]+)/g)) {
      const name = m[1];
      if (allowed.has(name)) continue;
      // A command that just wraps atomic_write on a fixed filename is the
      // shape that belongs in the table.
      const body = text.slice(m.index, text.indexOf("\n}", m.index));
      if (/atomic_write\(&crate::get_data_path\(&app, "[a-z-]+\.json"\)/.test(body)) {
        strays.push(`${file}: ${name}`);
      }
    }
  }
  assert.deepEqual(strays, [], "these write a fixed data file instead of using the shared store");
});

test("every tool that keeps records you would miss also snapshots them", () => {
  // Budget and Kanban captured every write since they shipped; Time Tracker and
  // Game Stats did not, so an entry or a game deleted by mistake was gone.
  //
  // The tools whose records are in the database are captured a different way,
  // and deliberately: copying the whole database on every save would reinstate
  // exactly the amplification the move removed, so it happens once per hour
  // instead. Every write path has to trigger that check.
  const rs = read("src-tauri/src/db.rs");
  assert.match(rs, /pub fn snapshot_if_due/, "the database is never snapshotted");
  assert.match(
    rs,
    /VACUUM INTO/,
    "the snapshot copies the file, which can catch a database mid-transaction",
  );

  for (const [file, fns] of [
    ["src-tauri/src/tools/game_stats_db.rs", ["gs_save", "gs_replace_all"]],
  ]) {
    const text = read(file);
    for (const fn of fns) {
      const at = text.indexOf(`pub fn ${fn}(`);
      assert.notEqual(at, -1, `${fn} is missing`);
      const body = text.slice(at, text.indexOf("\n}\n", at));
      assert.match(body, /snapshot_if_due\(&app\)/, `${fn} writes without capturing what it replaces`);
    }
  }

  // And the tools on JSON files snapshot through the file helper, which
  // captures on EVERY write rather than once an hour.
  for (const file of ["src-tauri/src/tools/budget.rs", "src-tauri/src/tools/kanban.rs"]) {
    assert.match(
      read(file),
      /backed_up_write_group/,
      `${file} writes without capturing what it replaces`,
    );
  }
  // Time Tracker's entries go through lib.rs's shared store, which snapshots
  // any file whose tool_file entry names a group.
  assert.match(
    read("src-tauri/src/lib.rs"),
    /\("time-tracker", "data"\) => \("[^"]*time-tracker\.json", "\[\]", TT_GROUP\)/,
    "Time Tracker's entries are not in a snapshot group",
  );
});

test("a schema version never decides whether a table exists", () => {
  /* THE BUG THIS EXISTS TO STOP, which has happened once.

     migrate() returned as soon as the file's version matched the code's, so
     the CREATE TABLE statements sat behind that check. A database that reached
     a version WITHOUT the table that version added could then never get it: the
     only thing that creates it never ran again. Reads of that table failed
     forever and Game Stats loaded empty with every game still on disk.

     A version number records which ONE-WAY steps have run. Every statement in
     SCHEMA is IF NOT EXISTS, so it costs microseconds to run on every open and
     it makes that state unreachable. */
  const rs = read("src-tauri/src/db.rs");
  const at = rs.indexOf("fn migrate(");
  assert.notEqual(at, -1, "migrate is missing");
  const body = rs.slice(at, rs.indexOf("\n}\n", at));

  assert.ok(
    !/if current >= SCHEMA_VERSION \{\s*return Ok\(\)/.test(body),
    "migrate returns before creating its tables, so a missing one can never be repaired",
  );
  assert.match(body, /conn\.execute_batch\(SCHEMA\)/, "migrate never applies the schema");

  // And every table it creates has to be creatable more than once.
  const schema = rs.slice(rs.indexOf("const SCHEMA"), rs.indexOf('"#;', rs.indexOf("const SCHEMA")));
  const creates = [...schema.matchAll(/CREATE (TABLE|INDEX)([^(]*)/g)];
  assert.ok(creates.length >= 8, `parsed ${creates.length} schema statements, expected more`);
  const unguarded = creates
    .filter((m) => !m[2].includes("IF NOT EXISTS"))
    .map((m) => `${m[1]}${m[2]}`.trim());
  assert.deepEqual(unguarded, [], "these would fail on the second open, so the schema cannot re-run");
});

test("a migration runs once and records that it did", () => {
  /* Game Stats has shipped, so game-stats.json holds real history. The move
     happens ONCE, and "once" has to be a thing the database REMEMBERS.

     It used to be inferred from gs_game being empty, and that is a different
     statement: someone who deletes every game, or imports an export holding
     none, leaves the tables empty on purpose. The old rule read the file back
     in at that point and put the deleted history straight back. */
  for (const [file, fn, table] of [
    ["src-tauri/src/tools/game_stats_db.rs", "gs_migrate_from_json", "gs_game"],
  ]) {
    const text = read(file);
    const at = text.indexOf(`pub fn ${fn}(`);
    assert.notEqual(at, -1, `${fn} is missing`);
    const body = text.slice(at, text.indexOf("\n}\n", at));
    assert.match(
      body,
      /if json_migrated\(conn\)\? \{\s*return Ok\(0\);/,
      `${fn} decides whether it has already run without asking what was recorded`,
    );
    // Rows already there mean it ran before this flag existed, which is still
    // "already run" and still has to be written down.
    assert.ok(
      body.includes(`SELECT count(*) FROM ${table}`),
      `${fn} does not notice a database that migrated before the flag existed`,
    );
    assert.match(
      body,
      /mark_json_migrated\(/,
      `${fn} never records that it ran, so it would run again`,
    );
    // The old file is read and left alone. It is the fallback if this ever goes
    // wrong, and it costs a few kilobytes to keep.
    assert.ok(!/remove_file/.test(body), `${fn} deletes the file it migrated from`);
  }

  /* Every path that deliberately sets what this tool holds records the same
     thing, or an import of an empty export lets the old file back in. */
  const dbSrc = read("src-tauri/src/tools/game_stats_db.rs");
  const replaceAt = dbSrc.indexOf("pub fn gs_replace_all(");
  assert.notEqual(replaceAt, -1, "gs_replace_all is missing");
  assert.match(
    dbSrc.slice(replaceAt, dbSrc.indexOf("\n}\n", replaceAt)),
    /mark_json_migrated\(/,
    "importing or restoring an empty history would let the old JSON file back in",
  );

  // And the front end asks the recorded answer, not the row count.
  assert.match(
    read("src/tool/game-stats.ts"),
    /!snapshot\.jsonMigrated[\s\S]{0,700}migrateGamesFromJson\(/,
    "Game Stats decides whether to migrate from how many games it can see",
  );
});

test("the import warning only offers an undo where there is one", () => {
  /* The Data tab's import replaces everything a tool holds. Its confirmation
     used to promise that a snapshot made this undoable, for all eight tools,
     and for half of them that was simply false: four keep preferences and
     short lists, snapshot nothing, and have no screen to put anything back.

     `snapshots: true` is each tool's own claim, and a claim needs checking.
     A tool makes it if and only if it actually draws a snapshot list. */
  const declares = new Set();
  const draws = new Set();
  for (const file of filesUnder("src/tool", ".ts")) {
    const text = read(file);
    const at = text.indexOf("registerTransferable({");
    if (at === -1) continue;
    const id = /id:\s*"([a-z-]+)"/.exec(text.slice(at, at + 400))?.[1];
    assert.ok(id, `${file} registers a transferable with no id`);

    if (/snapshots:\s*true/.test(text.slice(at, at + 400))) declares.add(id);
    // Either shared renderer, or Kanban's own per-board one.
    if (/renderToolBackups\(|renderDbBackups\(|list_kanban_backups/.test(text)) draws.add(id);
  }
  assert.ok(declares.size > 0, "parsed no snapshot claims");

  assert.deepEqual(
    [...declares].filter((id) => !draws.has(id)),
    [],
    "these tools promise an import can be undone but show no snapshots to undo it with",
  );
  assert.deepEqual(
    [...draws].filter((id) => !declares.has(id)),
    [],
    "these tools have snapshots but their import warning does not say so",
  );
});

/* KINDS AN EXPORT IS NOT EXPECTED TO CARRY, and why each one is not an
   oversight:

     draft      the half-typed state of a form. It belongs to the session rather
                than to the records, and restoring somebody's abandoned
                keystrokes on another machine is worse than dropping them.
     settings   the tool's own preferences. An export moves what you MADE, not
                how you like the tool arranged, and an import that quietly
                rearranged the destination would be a surprise nobody asked for.
     agents     connection tokens. Each one is a working key to a board, so
                putting them in a file somebody might mail around is the one
                thing this export must never do.

   Anything else a tool writes has to be in its export. Auto-Backup's presets
   were not, and an export therefore moved the folders you were backing up while
   silently dropping the named sets you had saved. */
const NOT_EXPORTED = ["draft", "settings", "agents"];

test("an export carries every file its tool writes", () => {
  /* Auto-Backup writes two files, the config and the saved presets, and its
     export gathered only the first. Exporting on one machine and importing on
     another therefore brought the folders you are backing up right now and
     silently dropped the named sets you had saved, which is the half worth
     moving. The import succeeded, so nothing said a word.

     A tool's own load_tool_file/save_tool_file calls name the kinds it uses.
     Every one of those has to appear inside its registerTransferable block, or
     the export has a hole in it exactly like that one. */
  const holes = [];

  for (const file of filesUnder("src/tool", ".ts")) {
    const text = read(file);
    const at = text.indexOf("registerTransferable({");
    if (at === -1) continue;

    const id = /id:\s*"([a-z-]+)"/.exec(text.slice(at, at + 400))?.[1];
    assert.ok(id, `${file} registers a transferable with no id`);

    // The whole block, from the call to the line that closes it at column 0.
    const end = text.indexOf("\n});", at);
    assert.notEqual(end, -1, `${file}'s transferable block is not closed`);
    const block = text.slice(at, end);

    /* Every kind this tool WRITES. Matched as the toolId/kind pair that
       save_tool_file takes, not on "kind:" alone: several tools have unrelated
       fields by that name (a card's author kind, a budget row's kind) and
       counting those would demand an export carry files that do not exist.
       Reads are not enough either, or a legacy file a tool only migrates FROM
       would look like something it still owns. */
    const kindPair = /toolId:\s*"[a-z-]+"\s*,\s*kind:\s*"([a-z-]+)"/g;
    const savePair =
      /save_tool_file"[\s\S]{0,80}?toolId:\s*"[a-z-]+"\s*,\s*kind:\s*"([a-z-]+)"/g;

    const kinds = new Set([...text.matchAll(savePair)].map((m) => m[1]));
    for (const kind of NOT_EXPORTED) kinds.delete(kind);

    /* A transferable may name its files, or gather from the tool's live state,
       which is what the record-holding tools do. So a kind counts as covered
       if the block names it OR the block reads no files at all, in which case
       the records come from memory and only the exclusions above are at stake. */
    const namesFiles = /load_tool_file|save_tool_file/.test(block);
    if (!namesFiles) continue;

    const covered = new Set([...block.matchAll(kindPair)].map((m) => m[1]));
    for (const kind of kinds) {
      if (!covered.has(kind)) holes.push(`${id} writes "${kind}" but never exports it`);
    }
  }

  assert.deepEqual(holes, [], "these exports would lose data they were asked to carry");
});

test("a tool with nothing worth carrying stays out of the Data tab", () => {
  /* RNGesus was in it and should not have been: its settings are six fields you
     would retype in seconds, and the rest of what it held was a batch of random
     numbers, which mean nothing outside the session that drew them. An export
     that cannot say why you would restore it is a button that only invites
     mistakes. If it comes back, this says so. */
  const rng = read("src/tool/rng.ts");
  assert.ok(
    !rng.includes("registerTransferable"),
    "RNGesus registers an export again; if that is deliberate, this test should go with it",
  );
  assert.ok(
    !rng.includes("core/data-transfer"),
    "RNGesus still imports the transfer module it no longer uses",
  );
});

test("every file the app owns lives in a folder, not loose in the data root", () => {
  /* The data directory has a shape: app/ for the shell's own files, one folder
     per tool, and backups/ shared. A path with no slash in it would land loose
     at the top and quietly undo that, which is exactly how it looked before. */
  const lib = read("src-tauri/src/lib.rs");

  const table = lib.slice(lib.indexOf("fn tool_file("), lib.indexOf("Ok(ToolFile {"));
  // Every .json the table names. The default-shape strings beside them are raw
  // JSON literals rather than filenames, so they do not match.
  const paths = [...table.matchAll(/"([a-z0-9./-]+\.json)"/g)].map((m) => m[1]);
  assert.ok(paths.length >= 13, `only found ${paths.length} tool files; did the table move?`);
  for (const path of paths) {
    assert.ok(path.includes("/"), `${path} would sit loose in the data root`);
  }

  // The shell's own files, named directly rather than through the table.
  for (const name of ["settings", "shell-state", "window", "lock", "custom-themes"]) {
    assert.ok(lib.includes(`"app/${name}.json"`), `${name}.json is not in the app folder`);
    assert.ok(
      !new RegExp(`get_data_path\\([^)]*"${name}\\.json"`).test(lib),
      `${name}.json is still read from the data root`,
    );
  }

  // Kanban's records and Game Stats' database.
  const kb = read("src-tauri/src/tools/kanban.rs");
  assert.match(kb, /const INDEX_FILE: &str = "kanban\/kanban-index\.json"/);
  assert.match(kb, /const BOARD_DIR: &str = "kanban\/kanban-boards"/);
  assert.match(
    read("src-tauri/src/db.rs"),
    /pub const DB_FILE: &str = "game-stats\/game-stats\.db"/,
    "the database is not named for the one tool that uses it",
  );

  /* A snapshot bucket is one flat folder, so a captured file is stored under
     its basename. Anything looking one up has to say so. */
  assert.ok(
    lib.includes("fn file_basename("),
    "nothing reduces a tool-file path to the name its .bak is stored under",
  );
});

test("moving an old data folder into the new shape cannot destroy anything", () => {
  const lib = read("src-tauri/src/lib.rs");
  const at = lib.indexOf("fn relocate(");
  const fn = lib.slice(at, lib.indexOf("\n}\n", at));

  // The one rule that makes this safe to run on every launch: never write over
  // something, so a half-migrated folder is tidied rather than clobbered.
  assert.match(
    fn,
    /if !src\.exists\(\) \|\| dest\.exists\(\) \{\s*return;/,
    "relocate would overwrite a file already at the destination",
  );
  assert.ok(!/remove_file|remove_dir/.test(fn), "relocate deletes rather than moves");

  // The database moves with its write-ahead log, or the last writes are lost.
  const migrate = lib.slice(lib.indexOf("pub(crate) fn migrate_data_layout"));
  assert.match(migrate, /\["", "-wal", "-shm"\]/, "the database moves without its WAL");

  // And it runs before any command can read a file.
  assert.match(
    lib,
    /\.setup\(\|app\|[\s\S]{0,300}migrate_data_layout\(app\.handle\(\)\);/,
    "the layout migration does not run at startup",
  );
});

test("nothing the app writes lands loose in the data root", () => {
  /* THE GENERAL GUARD, not a list of the files that happen to exist today.

     Every path the app writes inside its own data folder goes through
     get_data_path, and the folder it lands in is decided by the string handed
     to it. A string with no slash lands at the top and quietly undoes the whole
     layout, and nothing else in the app would notice: the write succeeds, the
     read succeeds, and the file is simply in the wrong place.

     So this reads every argument get_data_path is ever given, follows the named
     constants to their definitions, and requires a folder in all of them. */
  const files = filesUnder("src-tauri/src", ".rs");
  assert.ok(files.length >= 8, `only found ${files.length} Rust files`);

  const source = files.map((f) => read(f)).join("\n");

  // Every constant in the backend, so a name passed to get_data_path can be
  // followed to the string it stands for.
  const consts = new Map(
    [...source.matchAll(/const\s+([A-Z_0-9]+):\s*&(?:'static\s+)?str\s*=\s*"([^"]*)"/g)]
      .map((m) => [m[1], m[2]]),
  );

  // Constants holding a LIST of paths: the snapshot groups.
  const groups = new Map(
    [...source.matchAll(/const\s+([A-Z_0-9]+):\s*(?:\[&(?:'static )?str;\s*\d+\]|&\[&str\])\s*=\s*&?\[([^\]]*)\]/g)]
      .map((m) => [m[1], [...m[2].matchAll(/"([^"]+)"/g)].map((s) => s[1])]),
  );

  const offenders = [];
  const seen = [];

  const judge = (value, where) => {
    seen.push(value);
    // A path inside the data folder has to name the folder it lives in. The
    // only thing allowed at the top is a folder, and nothing writes one
    // directly: get_data_path creates it from the path it was handed.
    if (!value.includes("/")) offenders.push(`${where}: "${value}"`);
  };

  for (const file of files) {
    const text = read(file);
    for (const m of text.matchAll(/get_data_path\(\s*&?[a-z_]+,\s*(&?)([A-Za-z_0-9"][^,)]*)\)/g)) {
      const arg = m[2].trim();
      if (arg.startsWith('"')) {
        judge(arg.slice(1, -1), file);
      } else if (consts.has(arg)) {
        judge(consts.get(arg), `${file} (${arg})`);
      }
      // Anything else is a value built at runtime (a board path, a tool-file
      // entry). Those are covered by the two checks below.
    }
  }

  // The snapshot groups, which name files directly rather than through
  // get_data_path at the call site.
  for (const [name, values] of groups) {
    if (!/GROUP$|RELOCATIONS/.test(name)) continue;
    for (const v of values) judge(v, name);
  }

  assert.ok(seen.length >= 15, `only resolved ${seen.length} data paths; did the parse break?`);
  assert.deepEqual(offenders, [], "these would be written loose in the data root");

  // Two things build a path at runtime. Both have to produce a folder.
  const kb = read("src-tauri/src/tools/kanban.rs");
  assert.match(
    kb.slice(kb.indexOf("fn board_path(")),
    /format!\("\{BOARD_DIR\}\/\{\}"/,
    "a board file would not land in the boards folder",
  );
});

test("a snapshot group never spans two tools", () => {
  /* THE INVARIANT PER-TOOL SNAPSHOTS RELY ON.

     Snapshots live in <tool>/backups now, and backed_up_write_group works out
     which tool from the file it is WRITING. Every other file in the group is
     captured into that same folder. So a group that named files from two tools
     would file one tool's history under the other's name, and that tool's
     retention would then decide when it is dropped.

     Nothing enforces this at the type level, so it is enforced here. */
  const lib = read("src-tauri/src/lib.rs");
  const groups = [
    ...[...lib.matchAll(
      /const\s+([A-Z_0-9]+_GROUP):\s*&\[&str\]\s*=\s*\n?\s*&\[([^\]]*)\]/g,
    )].map((m) => [m[1], m[2]]),
    ...[...read("src-tauri/src/tools/budget.rs").matchAll(
      /const\s+([A-Z_0-9]+_GROUP):\s*\[&str;\s*\d+\]\s*=\s*\[([^\]]*)\]/g,
    )].map((m) => [m[1], m[2]]),
  ];
  // A floor rather than an exact count: the point is that the regexes above
  // actually parsed something, so an edit that renames the constants fails here
  // instead of passing on an empty list.
  assert.ok(groups.length >= 2, `parsed ${groups.length} snapshot groups, expected at least 2`);

  const mixed = [];
  for (const [name, body] of groups) {
    const dirs = new Set(
      [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1].split("/")[0]),
    );
    if (dirs.size > 1) mixed.push(`${name}: ${[...dirs].join(" + ")}`);
  }
  assert.deepEqual(mixed, [], "these snapshot groups would file one tool's history under another");

  // Kanban's group is built at runtime from two constants rather than listed.
  const kb = read("src-tauri/src/tools/kanban.rs");
  const boardDir = kb.match(/BOARD_DIR: &str = "([^"]+)"/)[1];
  const indexFile = kb.match(/INDEX_FILE: &str = "([^"]+)"/)[1];
  assert.equal(
    boardDir.split("/")[0],
    indexFile.split("/")[0],
    "a board and the index naming it would be captured into different tools",
  );

  // And the tool is taken from the file being written, not passed separately,
  // so it cannot disagree with where that file actually lands.
  assert.match(
    lib,
    /snapshot_group\(app, tool_dir_of\(write_filename\), &group_paths\)/,
    "the snapshot folder is not derived from the file being written",
  );
});

test("every tool's snapshots are pruned against its own history", () => {
  /* The reason snapshots moved out of one shared folder. Thirty buckets shared
     is the last thirty hours in which ANY tool was written, so an afternoon in
     one tool evicts months of history from a tool nothing touched. */
  const lib = read("src-tauri/src/lib.rs");
  assert.match(
    lib,
    /pub\(crate\) fn backups_root\(app: &tauri::AppHandle, tool_dir: &str\) -> PathBuf \{\s*data_root\(app\)\.join\(tool_dir\)\.join\("backups"\)/,
    "snapshots are not kept per tool",
  );

  // Every caller names a tool. A call with no tool would not compile, but a
  // caller passing a constant that is not a tool folder would.
  for (const [file, expected] of [
    ["src-tauri/src/db.rs", "DB_FILE"],
    ["src-tauri/src/tools/kanban.rs", "INDEX_FILE"],
  ]) {
    assert.match(
      read(file),
      new RegExp(`crate::backups_root\\(app, crate::tool_dir_of\\(${expected}\\)\\)`),
      `${file} does not derive its snapshot folder from its own data path`,
    );
  }

  /* AND EVERY WRITER OF A BUCKET PRUNES ONE. Naming a per-tool folder is only
     half of it: a writer that never drops an old bucket grows that folder
     forever. The database snapshot did exactly that, and it is the one whose
     buckets are whole copies of the dataset, so it was the most expensive
     folder in the app to leave uncapped.

     Both go through the same helper, so retention is one answer rather than
     one per writer. */
  assert.match(
    lib,
    /pub\(crate\) fn prune_buckets\(/,
    "there is no shared pruner, so each writer decides its own retention",
  );
  for (const file of ["src-tauri/src/lib.rs", "src-tauri/src/db.rs"]) {
    assert.match(
      read(file),
      /prune_buckets\([^)]*BACKUP_KEEP_COUNT\)/,
      `${file} writes snapshot buckets it never prunes`,
    );
  }
});

test("splitting the old shared backups folder cannot lose a snapshot", () => {
  const lib = read("src-tauri/src/lib.rs");
  const at = lib.indexOf("fn split_shared_backups(");
  const fn = lib.slice(at, lib.indexOf("\n}\n", at));

  // Same rule as every other move: never over the top of something.
  assert.match(fn, /if dest\.exists\(\) \{\s*continue;/, "the split would overwrite a snapshot");
  assert.ok(!/remove_file|remove_dir_all/.test(fn), "the split deletes rather than moves");

  /* A .bak nothing claims is LEFT WHERE IT IS, and the folders are removed with
     remove_dir, which only succeeds when empty. So an unrecognized file keeps
     both itself and the folder holding it. */
  assert.match(fn, /None => continue/, "an unclaimed snapshot would not be left alone");
  assert.ok(
    !/remove_dir_all/.test(fn) && /fs::remove_dir\(/.test(fn),
    "the split removes folders that may still hold something",
  );

  // The database was captured under the name it had when it held three tools.
  assert.match(fn, /"tools\.db\.bak"/, "an old database snapshot would not be recognized");
  assert.match(fn, /"game-stats\.db\.bak"/, "an old database snapshot keeps a misleading name");

  // Every tool that snapshots has to be claimable, or its history is stranded.
  const owner = lib.slice(lib.indexOf("fn owner_of_backup("));
  for (const tool of ["budget", "kanban", "time-tracker", "game-stats"]) {
    assert.ok(
      owner.slice(0, owner.indexOf("\n}\n")).includes(`"${tool}"`),
      `${tool}'s old snapshots would be stranded in the shared folder`,
    );
  }
});
