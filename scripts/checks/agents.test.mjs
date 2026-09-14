/* =============================================================================
   KANBAN AGENT ACCESS
   -----------------------------------------------------------------------------
   This feature is one decision spread across four files, and three of the four
   fail SILENTLY when they drift apart.

     src-tauri/src/agent_gate.rs   the permission ids and what each operation
                                   costs. This is the half that enforces.
     src/tool/kanban-agents.ts     the same permission ids, and the labels the
                                   switches are drawn from.
     src/tool/kanban.ts            the operations, performed.
     src-tauri/agent/src/main.rs   the tools an AI agent is offered.

   What drift looks like, in each direction:

     • A permission in the front end that the gate has never heard of is a
       switch that appears to work, saves happily, and grants nothing.
     • A permission in the gate that the front end does not draw is a
       permission nobody can turn on, so the operation behind it is dead.
     • A LABEL that differs between the two is worse than either: the gate's
       refusal tells the agent to go and turn on a switch whose name does not
       appear anywhere in the app.
     • An operation the sidecar offers that the gate does not know is a tool
       that always fails.
     • An operation the gate allows that kanban.ts has no case for reaches the
       front end and dies in the default branch, after the permission check has
       already said yes.
============================================================================= */

import test from "node:test";
import assert from "node:assert/strict";
import { read, htmlIds, slice } from "./_source.mjs";

const gate = () => read("src-tauri/src/agent_gate.rs");
const settings = () => read("src/tool/kanban-agents.ts");
const kanban = () => read("src/tool/kanban.ts");
const sidecar = () => read("src-tauri/agent/src/main.rs");

/* -----------------------------------------------------------------------------
   THE FOUR LISTS
----------------------------------------------------------------------------- */

/** The permission ids and labels the GATE enforces. */
function gatePermissions() {
  const text = gate();
  const block = text.slice(
    text.indexOf("const PERMISSION_LABELS"),
    text.indexOf("];", text.indexOf("const PERMISSION_LABELS")),
  );
  return [...block.matchAll(/\("(\w+)",\s*"([^"]+)"\)/g)].map((m) => ({
    id: m[1],
    label: m[2],
  }));
}

/** The permission ids and labels the TAB draws. */
function uiPermissions() {
  const text = settings();
  const block = text.slice(
    text.indexOf("export const AGENT_PERMISSIONS"),
    text.indexOf("export const AGENT_PERMISSION_IDS"),
  );
  return [...block.matchAll(/id:\s*"(\w+)",\s*\n\s*label:\s*"([^"]+)"/g)].map((m) => ({
    id: m[1],
    label: m[2],
  }));
}

/** Every operation the gate knows, with the permissions it costs. */
function gateOps() {
  const text = gate();
  const block = text.slice(text.indexOf("const OPS:"), text.indexOf("];", text.indexOf("const OPS:")));
  return [...block.matchAll(/op:\s*"(\w+)",\s*permissions:\s*&\[([^\]]*)\]/g)].map((m) => ({
    op: m[1],
    permissions: [...m[2].matchAll(/"(\w+)"/g)].map((p) => p[1]),
  }));
}

/** Every operation kanban.ts will actually perform. */
function frontEndOps() {
  const text = kanban();
  const at = text.indexOf("async function runAgentRequest(");
  const block = text.slice(at, text.indexOf("\n}", text.indexOf("switch (req.op)", at)));
  return [...block.matchAll(/case "(\w+)":/g)].map((m) => m[1]);
}

/** Every tool the sidecar offers an agent. */
function sidecarTools() {
  const text = sidecar();
  const block = text.slice(text.indexOf("const TOOLS:"), text.indexOf("\n];", text.indexOf("const TOOLS:")));
  return [...block.matchAll(/name:\s*"(\w+)",\s*\n\s*op:\s*"(\w+)",/g)].map((m) => ({ name: m[1], op: m[2] }));
}

/** The operations the Customize modal draws as always allowed. */
function readAccessOps() {
  const text = settings();
  const block = text.slice(
    text.indexOf("export const AGENT_READ_ACCESS"),
    text.indexOf("];", text.indexOf("export const AGENT_READ_ACCESS")),
  );
  return [...block.matchAll(/op:\s*"(\w+)"/g)].map((m) => m[1]);
}

/* -----------------------------------------------------------------------------
   THE CHECKS
----------------------------------------------------------------------------- */

test("the lists are actually found, so an empty match cannot pass everything", () => {
  // Every check below compares two lists. Two empty lists agree perfectly,
  // which is how a renamed marker turns this whole file into a no-op.
  assert.ok(gatePermissions().length >= 10, "the gate's permission list did not parse");
  assert.ok(uiPermissions().length >= 10, "the tab's permission list did not parse");
  assert.ok(gateOps().length >= 15, "the gate's operation table did not parse");
  assert.ok(frontEndOps().length >= 15, "the front end's dispatcher did not parse");
  assert.ok(sidecarTools().length >= 15, "the sidecar's tool list did not parse");
});

test("the front end and the back end agree on which permissions exist", () => {
  const ids = (list) => list.map((p) => p.id).sort();
  assert.deepEqual(
    ids(uiPermissions()),
    ids(gatePermissions()),
    "a permission exists on one side of the app and not the other",
  );
});

test("a permission's label is the same word in the refusal and on the switch", () => {
  // The gate's refusal quotes the label back to the agent as the thing to go
  // and turn on. If the two ever differ, that sentence names a switch the user
  // cannot find.
  const ui = new Map(uiPermissions().map((p) => [p.id, p.label]));
  const wrong = gatePermissions()
    .filter((p) => ui.get(p.id) !== p.label)
    .map((p) => `${p.id}: gate says "${p.label}", the tab says "${ui.get(p.id)}"`);
  assert.deepEqual(wrong, []);
});

test("every operation the gate allows is one the front end can perform", () => {
  // The gate answers first. An operation it permits and the front end has no
  // case for gets past the permission check and then dies, which reads to the
  // agent as the app being broken rather than as the request being wrong.
  const performed = new Set(frontEndOps());
  // capabilities is answered inside the gate and never reaches the front end.
  const forwarded = gateOps().map((o) => o.op).filter((op) => op !== "capabilities");
  const missing = forwarded.filter((op) => !performed.has(op));
  assert.deepEqual(missing, [], "these operations are allowed but nothing performs them");
});

test("every operation the front end performs is one the gate knows the cost of", () => {
  // The dangerous direction. An operation missing from the gate's table is
  // refused as unknown, which is safe; but one performed by the front end that
  // the gate never scored would be an operation with no permission at all.
  const scored = new Set(gateOps().map((o) => o.op));
  const unscored = frontEndOps().filter((op) => !scored.has(op));
  assert.deepEqual(unscored, [], "these operations are performed but the gate does not score them");
});

test("every operation names permissions that exist", () => {
  const known = new Set(gatePermissions().map((p) => p.id));
  const unknown = [];
  for (const op of gateOps()) {
    for (const permission of op.permissions) {
      if (!known.has(permission)) unknown.push(`${op.op} needs ${permission}`);
    }
  }
  assert.deepEqual(unknown, []);
});

test("reading is free and everything that changes something costs a permission", () => {
  const READING = new Set(["capabilities", "get_board", "list_cards", "get_card"]);
  const wrong = gateOps()
    .filter((op) => READING.has(op.op) !== (op.permissions.length === 0))
    .map((op) => op.op);
  assert.deepEqual(wrong, [], "these operations are on the wrong side of the read/write line");
});

test("every tool the sidecar offers maps to a real operation", () => {
  const ops = new Set(gateOps().map((o) => o.op));
  const problems = sidecarTools()
    .filter((tool) => !ops.has(tool.op))
    .map((tool) => `${tool.name} calls ${tool.op}, which does not exist`);
  assert.deepEqual(problems, []);
});

test("the sidecar offers every operation, so a blocked one is refused and logged", () => {
  /* The tool list used to be trimmed to what the board allowed. An agent then
     never attempted anything switched off: the gate never saw the request, so
     nothing was refused and nothing reached the activity log, and a switch doing
     its job looked exactly like a missing feature. Every operation the gate
     performs now has a tool, listed unconditionally, and the gate alone decides. */
  const offered = new Set(sidecarTools().map((tool) => tool.op));
  const missing = gateOps()
    .map((o) => o.op)
    .filter((op) => op !== "capabilities" && !offered.has(op));
  assert.deepEqual(missing, [], "these operations have no tool, so an agent can never try them");

  const text = sidecar();
  const at = text.indexOf('"tools/list" =>');
  assert.match(text.slice(at, text.indexOf("\n", at)), /tool_list\(\)/, "tools/list no longer answers with the full list");
  const body = slice("src-tauri/agent/src/main.rs", "fn tool_list(", "\n}");
  assert.ok(!/filter|permission/.test(body), "the tool list is being trimmed to permissions again");
});

test("the modal's always-allowed list is exactly what the gate lets through for free", () => {
  /* The Customize modal draws reading as switches locked on. A name there that
     the gate charges for would promise access the gate refuses; a free
     operation missing from it would under-report what every connection can do.
     capabilities is the sidecar asking what it may do rather than anything done
     to the board, so it is not drawn. */
  const free = gateOps()
    .filter((o) => o.permissions.length === 0 && o.op !== "capabilities")
    .map((o) => o.op)
    .sort();
  assert.ok(free.length >= 3, "the gate's free operations did not parse");
  assert.deepEqual([...readAccessOps()].sort(), free);
});

test("a refused edit names the exact switch for that card, and asking never changes the board", () => {
  /* Editing a card is allowed by either of two switches, and which one applies
     depends on who made the card. The gate cannot see that, so it refused
     naming the first switch, which was wrong for every card the agent did not
     make. It now asks the front end for the wording. That question has to be
     answered before anything else runs (no write-rate charge, no operation) and
     with words only. */
  const gateText = gate();
  const handler = gateText.slice(gateText.indexOf("fn handle_request("), gateText.indexOf("\n}", gateText.indexOf("fn handle_request(")));
  assert.match(handler, /exact_refusal_message\(/, "a refusal is no longer reworded for whose card it is");
  const asker = slice("src-tauri/src/agent_gate.rs", "fn exact_refusal_message(", "\n}");
  assert.match(asker, /"explain":\s*true/, "the gate does not mark its question as a question");
  assert.match(asker, /fallback/, "a failed question could lose the refusal's wording");

  const text = kanban();
  const run = text.slice(text.indexOf("async function runAgentRequest("), text.indexOf("switch (req.op)", text.indexOf("async function runAgentRequest(")));
  const explainAt = run.indexOf("if (req.explain)");
  assert.ok(explainAt > -1, "the front end does not answer the gate's question");
  assert.ok(explainAt < run.indexOf("checkAgentWriteRate"), "asking for wording is charged as a write");

  const explain = slice("src/tool/kanban.ts", "function explainEditRefusal(", "\n}");
  for (const write of ["stampCard", "touchBoard", "flushSave", "renderAll", "saveBoard"]) {
    assert.ok(!explain.includes(write), `explaining a refusal calls ${write}, so it can change the board`);
  }
  assert.match(explain, /"editCard"/);
  assert.match(explain, /"editOthersCards"/);
});

test("a new board starts with nothing that can lose anything", () => {
  /* starterPermissions is what a user gets by flipping one switch, before they
     have read anything. It has to be the set that cannot cost them work. */
  const text = settings();
  const block = text.slice(
    text.indexOf("export function starterPermissions"),
    text.indexOf("}", text.indexOf("return {", text.indexOf("export function starterPermissions"))),
  );
  const granted = [...block.matchAll(/(\w+):\s*true/g)].map((m) => m[1]);

  const DESTRUCTIVE = [
    "deleteCard",
    "deleteComment",
    "editOthersCards",
    "manageColumns",
    "archiveCard",
    "setDates",
    "assignTags",
    "createTags",
  ];
  const bad = granted.filter((id) => DESTRUCTIVE.includes(id));
  assert.deepEqual(bad, [], "a board switched on for the first time grants these by default");
  assert.ok(granted.includes("createCard"), "the starter set should at least allow creating cards");
});

test("the agent config file is in the tool-file allowlist", () => {
  // Nothing joins a path that arrived from the front end unchecked. The config
  // is saved through the shared store, so it needs a row there or every save
  // fails with "Unknown tool file".
  const lib = read("src-tauri/src/lib.rs");
  assert.match(
    lib,
    /\("kanban",\s*"agents"\)\s*=>\s*\(\s*"kanban\/kanban-agents\.json"/,
    "kanban/agents is not in the tool-file allowlist",
  );
});

test("the agent config is snapshotted, because its tokens live in other apps", () => {
  // Losing this file is not "set those switches again": the tokens in it are
  // pasted into agent configs elsewhere on the machine.
  const lib = read("src-tauri/src/lib.rs");
  assert.match(lib, /KANBAN_AGENTS_GROUP/, "the agent config is written without a snapshot group");
});

test("the Agents tab is wired to elements that exist", () => {
  const ids = htmlIds();
  const needed = [
    "kbBoardTabAgents",
    "kbAgentEnabledToggle",
    "kbAgentEnabledLabel",
    "kbAgentStatusBadge",
    "kbAgentBody",
    "kbAgentPermissionList",
    "kbAgentPermSummary",
    "kbAgentPermSummaryInModal",
    "kbAgentPermEditBtn",
    "kbAgentPermBackdrop",
    "kbAgentPermBack",
    "kbAgentPermClose",
    "kbAgentLiveBadge",
    "kbAgentConnectionList",
    "kbAgentLogList",
    "kbAgentMasterOff",
    "kbAgentGlobalOffBtn",
    "kbAgentGlobalSummary",
  ];
  const missing = needed.filter((id) => !ids.has(id));
  assert.deepEqual(missing, [], "the Agents tab reads these ids and the page does not have them");
});

test("every permission is in exactly one group on the Customize modal", () => {
  /* The groups are how the switches are drawn now, so a permission missing
     from all of them is a switch that cannot be turned off through the UI
     while the gate still honors it, and one in two groups is a switch that
     disagrees with itself depending on which copy you touched last. */
  const source = read("src/tool/kanban-agents.ts");

  /* Scoped to the AGENT_PERMISSIONS list rather than the whole file. Other
     things in here are arrays of objects with an "id" too (the clients a
     connection can be copied for), and counting those as permissions makes
     this fail for a reason that has nothing to do with permissions. */
  const permissionBlock = source.slice(
    source.indexOf("export const AGENT_PERMISSIONS"),
    source.indexOf("export const AGENT_PERMISSION_IDS"),
  );
  assert.ok(permissionBlock.length > 0, "could not find the permission list");
  const ids = [...permissionBlock.matchAll(/^\s{4}id: "([A-Za-z]+)",$/gm)].map((m) => m[1]);
  assert.ok(ids.length > 0, "no permission ids were found to check");

  const groupBlock = source.slice(
    source.indexOf("AGENT_PERMISSION_GROUPS"),
    source.indexOf("export function groupPermissions"),
  );
  const grouped = [...groupBlock.matchAll(/"([A-Za-z]+)"/g)]
    .map((m) => m[1])
    .filter((name) => ids.includes(name));

  const missing = ids.filter((id) => !grouped.includes(id));
  assert.deepEqual(missing, [], "these permissions are in no group, so nothing draws them");

  const twice = grouped.filter((id, i) => grouped.indexOf(id) !== i);
  assert.deepEqual(twice, [], "these permissions are in more than one group");
});

test("the test button runs the sidecar rather than guessing", () => {
  /* A test that only read the status flags would pass for an install whose
     srbk-agent.exe antivirus had quarantined, which is the case it exists to
     catch. */
  const gate = read("src-tauri/src/agent_gate.rs");
  assert.match(
    gate,
    /pub async fn kanban_agent_test_connection/,
    "the test command is missing, or is not async and would deadlock the front end",
  );
  assert.match(gate, /\.arg\("check"\)/, "the test does not actually run the sidecar");
  // Marked, or the app's own test reads as an agent having used the connection.
  assert.match(gate, /SRBK_AGENT_PROBE/, "the test is counted as an agent using the connection");
  assert.match(
    read("src-tauri/src/lib.rs"),
    /kanban_agent_test_connection/,
    "the test command is not registered, so the button cannot reach it",
  );
});

test("the Agents tab is reachable from the board setup modal", () => {
  // A pane with no tab button is a screen nothing can open.
  const html = read("index.html");
  assert.match(html, /data-kb-board-tab="agents"/, "there is no Agents tab button");
  assert.match(
    kanban(),
    /agents:\s*"kbBoardTabAgents"/,
    "the Agents pane is not registered with the modal's tabs",
  );
});

test("the sidecar is built and bundled, or it ships as a feature that cannot run", () => {
  /* The sidecar is a separate crate, so `cargo build` in src-tauri never
     touches it and `tauri build` would happily produce an installer with the
     Agents tab in it and no srbk-agent.exe behind it. */
  const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
  assert.ok(
    conf.bundle.externalBin?.some((b) => b.includes("srbk-agent")),
    "srbk-agent is not in the bundle's externalBin",
  );
  assert.match(
    conf.build.beforeBuildCommand,
    /build:agent/,
    "a release build never builds the sidecar it bundles",
  );
  const pkg = JSON.parse(read("package.json"));
  assert.ok(pkg.scripts["build:agent"], "there is no build:agent script");
});

test("the agent's pipe name is the same on both sides", () => {
  /* The sidecar is told the pipe name in the copied connection, but it also
     carries a default for a hand-written config. A default that does not match
     what the app listens on fails with "Swiss RB Knife is not running" while it
     is running, which is the least helpful error in the whole feature. */
  /* The gate writes the name as an ordinary Rust string and the sidecar as a
     raw one, so a separator is two characters in the first file and one in the
     second. Both are read as "whatever follows the last separator", which
     compares the names rather than how each file escapes them.

     The gate has two: a dev build listens on its own name so it cannot answer
     for an installed one. The sidecar's default is the RELEASE name, since a
     dev connection carries its pipe name explicitly. */
  const names = [...gate().matchAll(/pipe\\\\([a-z0-9.-]+)"\.to_string/g)].map((m) => m[1]);
  assert.ok(names.length >= 2, "could not find the app's pipe names");
  const release = names.filter((n) => !n.endsWith(".dev"));
  assert.equal(release.length, 1, `expected exactly one release pipe name, got ${names}`);
  assert.ok(
    names.some((n) => n.endsWith(".dev")),
    "a dev build shares the installed app's pipe name, so an agent could reach either",
  );

  const fallback = sidecar().match(/DEFAULT_PIPE: &str = r"[^"]*pipe\\([a-z0-9.-]+)"/);
  assert.ok(fallback, "could not find the sidecar's default pipe name");
  assert.equal(fallback[1], release[0]);
});

test("VS Code gets its own shape, because it does not share the common one", () => {
  /* This is the one that was actually wrong. Every other client reads an
     "mcpServers" object; VS Code reads "servers" and wants an explicit
     "type": "stdio". The code used to claim VS Code shared the common shape,
     so a config copied from here would have been silently ignored there:
     no error, no server, nothing to tell you why. */
  const src = read("src/tool/kanban-agents.ts");

  const vscode = src.slice(
    src.indexOf("export function vsCodeConnectionJson"),
    src.indexOf("export function codexConnectionToml"),
  );
  assert.ok(vscode.length > 0, "the VS Code builder is gone");
  assert.match(vscode, /servers:/, "VS Code's block has no servers key");
  assert.ok(!/mcpServers/.test(vscode), "VS Code is being handed the wrong key");
  assert.match(vscode, /type: "stdio"/, "VS Code needs an explicit stdio type");

  // And the client entry has to actually route to it.
  const entry = src.slice(src.indexOf('id: "vscode"'), src.indexOf('id: "vscode"') + 200);
  assert.match(entry, /format: "vscode"/, "the VS Code client does not use the VS Code shape");
});

test("Codex gets TOML, with its paths escaped", () => {
  /* Codex reads config.toml, not JSON. A Windows path in a TOML basic string
     has to have its backslashes doubled, or \n and \t inside it are read as
     control characters and the command points nowhere. */
  const src = read("src/tool/kanban-agents.ts");
  const toml = src.slice(
    src.indexOf("export function codexConnectionToml"),
    src.indexOf("export function connectionConfig"),
  );
  assert.ok(toml.length > 0, "the Codex builder is gone");
  assert.match(toml, /\[mcp_servers\./, "Codex's block is not a mcp_servers table");
  assert.match(toml, /\.env\]/, "Codex's environment is not its own table");
  assert.ok(/replace\(/.test(toml), "the Codex path is not escaped for TOML");
});

test("only the clients with a command offer one", () => {
  /* An editor is configured by editing its file. Offering it a command would
     be an instruction to run something that does not exist, so
     connectionCommand returns null for it, Copy As offers only Config File, and
     the copy button copies the config. */
  const src = read("src/tool/kanban-agents.ts");
  const fn = src.slice(src.indexOf("export function connectionCommand"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.match(body, /if \(!client\.command\) return null/, "every client is offered a command, including the editors");

  const modes = src.slice(src.indexOf("export function copyModesFor"));
  assert.match(
    modes.slice(0, modes.indexOf("\n}")),
    /client\.command \? \["command", "config"\] : \["config"\]/,
    "Copy As offers a command to an agent that has none",
  );

  // Every client marked as having a command is one srbk-agent connect can set up.
  const list = src.slice(src.indexOf("export const AGENT_CLIENTS"), src.indexOf("export function agentClient"));
  const flagged = [...list.matchAll(/id: "([a-z-]+)"[\s\S]*?command: (true|false)/g)]
    .filter((m) => m[2] === "true")
    .map((m) => m[1])
    .sort();
  const known = [...sidecar().matchAll(/"([a-z-]+)" => Some\(Self::/g)].map((m) => m[1]).sort();
  assert.deepEqual(flagged, known, "the app offers a command for an agent srbk-agent connect cannot set up, or the other way round");

  // The button copies a command only when Copy As asks for one AND there is one.
  assert.match(
    read("src/tool/kanban.ts"),
    /const command = agentCopyMode === "command" \? connectionCommand\(info, client\) : null;/,
    "the copy button can copy a command the client does not have",
  );
});

test("every client says where its file goes and how to write it", () => {
  /* A client with no "where" is a copy button that leaves you holding a block
     of config and no idea which file it belongs in, which is the question this
     whole picker exists to answer. */
  const src = read("src/tool/kanban-agents.ts");
  const list = src.slice(
    src.indexOf("export const AGENT_CLIENTS"),
    src.indexOf("export function agentClient"),
  );
  assert.ok(list.length > 0, "the client list is gone");

  const ids = [...list.matchAll(/id: "([a-z-]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length >= 6, `only found ${ids.length} clients`);

  const wheres = [...list.matchAll(/where:/g)].length;
  const formats = [...list.matchAll(/format:/g)].length;
  const clis = [...list.matchAll(/cli:/g)].length;
  assert.equal(wheres, ids.length, "a client does not say where its config goes");
  assert.equal(formats, ids.length, "a client does not say which shape it takes");
  assert.equal(clis, ids.length, "a client is not sorted into agents or editors");

  // DeepSeek was asked for and deliberately left out; if it is added, it needs
  // a verified format rather than a guessed one, and this should be revisited.
  assert.ok(
    /DeepSeek is deliberately absent/.test(src),
    "the note explaining why DeepSeek is not listed has gone; was it added without one?",
  );
});

test("the copied connection launches the sidecar the way the sidecar expects", () => {
  /* The connection block is pasted into another program's config and run
     there, so nothing in this app ever executes it. A wrong flag or a wrong
     filename is discovered by the user, in someone else's error message. */
  const block = read("src/tool/kanban-agents.ts");
  assert.match(block, /args:\s*\["--mcp"\]/, "the connection does not start the sidecar in MCP mode");
  assert.match(sidecar(), /"--mcp"\s*\|\s*"mcp"\s*=>\s*run_mcp/, "the sidecar does not accept --mcp");

  // Both variables, because the pipe name is what makes a dev build reachable.
  assert.match(block, /SRBK_AGENT_TOKEN/);
  assert.match(block, /SRBK_AGENT_PIPE/);
  assert.match(sidecar(), /var\("SRBK_AGENT_TOKEN"\)/);
  assert.match(sidecar(), /var\("SRBK_AGENT_PIPE"\)/);
});

test("the app looks for the sidecar under the name the build produces", () => {
  // The installer places a sidecar beside the app with the target triple
  // stripped. The app resolves it by that name to put a real path in the
  // copied connection, and a mismatch is a Copy button that copies a path to
  // nothing.
  assert.match(gate(), /join\("srbk-agent\.exe"\)/, "the app looks for a different filename");
  assert.match(
    read("scripts/build-agent.mjs"),
    /srbk-agent-\$\{hostTriple\(\)\}\.exe/,
    "the build script does not produce the triple-suffixed name externalBin needs",
  );
});

test("no running agent can block a dev build", () => {
  /* An agent spawns srbk-agent.exe and holds it open for its whole session,
     and Windows will not let cargo overwrite a running exe. A connection
     pointed at the exe cargo writes does not fail on its own terms, it fails
     the NEXT dev build, with "failed to remove file ... Access is denied" and
     nothing on screen connecting the two.

     The first fix handed agents a copy in dev/bin, but the app fell back to
     target/debug whenever the copy was missing, and one connection made in
     that moment brought the whole trap back. So all three halves are pinned:
     the sidecar builds into a folder nothing runs from, a dev app hands out
     only the dev/bin copy (missing or not), and a copy an agent is running is
     moved aside rather than left stale or allowed to fail the build. */
  const build = read("scripts/build-agent.mjs");
  assert.match(
    build,
    /"--target-dir",\s*AGENT_TARGET_DIR/,
    "the sidecar builds into target/debug, where a connected agent can lock it",
  );
  assert.match(build, /path\.join\(ROOT_DIR, "dev", "bin"\)/, "the debug build no longer copies the exe out of target/");
  assert.match(
    build,
    /EBUSY[\s\S]{0,60}EPERM[\s\S]{0,120}renameSync\(copy, aside\)/,
    "a copy locked by a running agent must be moved aside, not fail the build",
  );

  const lookup = slice("src-tauri/src/agent_gate.rs", "fn sidecar_path(", "\n}");
  const dev = lookup.slice(lookup.indexOf("#[cfg(debug_assertions)]"), lookup.indexOf("#[cfg(not(debug_assertions))]"));
  assert.match(dev, /\.join\("dev"\)\.join\("bin"\)\.join\("srbk-agent\.exe"\)/, "a dev app no longer hands out the dev/bin copy");
  const devCode = dev.replace(/\/\/[^\n]*/g, "");
  assert.ok(!/target|exists\(\)/.test(devCode), "a dev app can still fall back to handing out an exe inside target/");
});

test("the tool list does not promise changes it never makes", () => {
  /* While the list was trimmed to the board's permissions it had to change
     mid-session, so it declared listChanged and a watcher polled for flips. The
     list is fixed now, and declaring listChanged would have clients waiting on
     notifications that never come. */
  const text = sidecar();
  assert.match(text, /"listChanged":\s*false/, "the sidecar still tells clients its tool list changes");
  assert.ok(!/notifications\/tools\/list_changed/.test(text), "a list-changed notification is still being sent");
});

test("a copied command runs the same in Command Prompt and PowerShell, and does the whole job", () => {
  /* The command used to be the steps themselves, in PowerShell syntax. Pasted
     into Command Prompt it did nothing useful: the steps ran together, a file
     named $null appeared, and the check still said the connection worked. Now
     the copied line is one call to srbk-agent connect behind cmd /c, which both
     shells run the same way as long as it carries exactly one pair of quotes
     (around the exe path), and the steps are processes the sidecar starts.

     What connect has to do is what an add-only command got wrong: remove the
     old entry first (`mcp add` refuses a name it already has, and Revoke cannot
     reach the agent's settings), save Claude Code at user scope (the default is
     whatever folder the terminal is in), and check afterwards. */
  const src = read("src/tool/kanban-agents.ts");
  const fn = src.slice(src.indexOf("export function connectionCommand"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  const line = body.slice(body.indexOf("return `"));
  const template = line.slice(0, line.indexOf("`;"));
  assert.match(
    template,
    /^return `cmd \/c "\$\{info\.sidecarPath\}" connect \$\{client\.id\}/,
    "the copied line is not a single cmd /c call to srbk-agent connect",
  );
  assert.equal((template.match(/"/g) ?? []).length, 2, "cmd /c only keeps its quotes when the line has exactly one pair");
  assert.ok(!/2>\$null|; |&/.test(template), "the copied line carries syntax one of the two shells cannot run");
  assert.match(template, /--name \$\{key\}/, "the command does not say which name to save the connection under");

  const agent = sidecar();
  assert.match(agent, /"connect" => std::process::exit\(run_connect\(/, "srbk-agent has no connect command");
  const start = agent.indexOf("fn run_connect(");
  const connect = agent.slice(start, start + 4000);
  const removeAt = connect.indexOf("remove_args(");
  const addAt = connect.indexOf("add_args(");
  const checkAt = connect.indexOf('send("capabilities"');
  assert.ok(removeAt !== -1 && removeAt < addAt, "connect adds without removing the old entry first");
  assert.ok(addAt < checkAt, "connect does not check the connection after saving it");
  const addStart = agent.indexOf("fn add_args(");
  assert.match(agent.slice(addStart, addStart + 900), /"-s", "user"/, "Claude Code's connection is saved to whatever folder the terminal is in");
});

test("a dev build's connection can never replace the installed app's", () => {
  /* The command replaces whatever is saved under its key. With one key for
     both builds, connecting a dev board would disconnect the installed app's
     board of the same name, and the other way round. */
  const src = read("src/tool/kanban-agents.ts");
  const key = src.slice(src.indexOf("export function serverKey"), src.indexOf("THE CLIENTS"));
  assert.match(key, /isDevPipe\(pipeName\)/, "the key does not depend on which build it is for");
  assert.match(key, /srbk-dev-kanban/, "a dev connection is saved under the installed app's name");

  // Every call has to pass the pipe, or it falls back to the installed name.
  const bare = [...src.matchAll(/serverKey\(([^)]*)\)/g)]
    .map((m) => m[1])
    .filter((args) => !args.includes(": string"))
    .filter((args) => !/pipeName/.test(args));
  assert.deepEqual(bare, [], "serverKey is called without the pipe name");
  assert.match(gate(), /swiss-rb-knife\.agent\.dev/, "a dev build no longer listens on a pipe of its own");
});

test("the permissions modal knows its board without asking Board Setup", () => {
  /* Board Setup steps aside with a handoff when Customize opens this modal,
     and its onClosed clears boardEditId a moment later. Back, Turn All Off and
     the redraw after a switch all read boardEditId, so all three did nothing. */
  const src = kanban();
  const modal = src.slice(src.indexOf("function agentPermModal("), src.indexOf("function wireAgentsTab("));
  assert.ok(modal.length > 0, "the permissions modal is gone");
  const code = modal.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.ok(!/boardEditId/.test(code), "the permissions modal reads boardEditId, which is null while it is open");
  assert.match(
    src,
    /agentPermBoardId = board\.id;\s*getBoardSetupModal\(\)\.close\(\{ handoff: true \}\)/,
    "Customize does not hand the modal its board before Board Setup steps aside",
  );
  const allOff = src.slice(src.indexOf('getElementById("kbAgentAllOffBtn")'));
  assert.match(allOff.slice(0, 200), /agentBoard\(\)/, "Turn All Off asks Board Setup which board it is on");
  const render = src.slice(src.indexOf("async function renderAgentsTab("));
  assert.match(render.slice(0, 300), /agentBoard\(\)/, "the Agents screens do not redraw while Customize is open");
});

test("the Copy As hint names the button as it is labeled, whichever way is picked", () => {
  /* The hint is the instruction ('Press "Copy Command" on a connection
     below...'), so a button renamed without it sends people looking for
     something that is not there. Both read the same labels. */
  const agents = read("src/tool/kanban-agents.ts");
  const hintFn = agents.slice(agents.indexOf("export function clientHint"));
  const hint = hintFn.slice(0, hintFn.indexOf("\n}"));
  assert.match(hint, /\$\{COPY_COMMAND_LABEL\}/, "the hint spells out the command button's label itself");
  assert.match(hint, /\$\{COPY_CONFIG_LABEL\}/, "the hint spells out the config button's label itself");
  assert.match(hint, /Command Prompt or `\s*\+\s*`PowerShell/, "the hint does not say where the command goes");
  assert.match(hint, /\$\{client\.where\}/, "the config hint does not say which file");

  const ui = kanban();
  assert.match(ui, /copyBtn\.textContent = COPY_COMMAND_LABEL/, "the command button has its own label");
  assert.match(ui, /copyBtn\.textContent = COPY_CONFIG_LABEL/, "the config button has its own label");
  assert.match(ui, /clientHint\(client, agentCopyMode\)/, "the line under Copy As is not the hint for the way picked");
});

test("the active-agent badge and the connection rows read the same evidence", () => {
  /* The badge read only the activity log, which records card operations. A
     reconnected agent that had not touched a card yet showed "last seen 11 min
     ago" beside a connection row saying "last used just now". The badge has to
     take the app's last-seen record too, and the newer of the two. */
  const ui = kanban();
  assert.match(
    ui,
    /renderAgentLive\(latestAgentContact\(mine\.tokens, status\.lastSeen, entries\[0\] \?\? null\)\)/,
    "the live badge does not look at when a connection was last seen",
  );

  // A person trying the connection from a terminal is not the agent using it.
  assert.match(
    sidecar(),
    /if first == "check" \|\| first == "connect" \{\s*connection\.probe = true;/,
    "pasting the command counts as the agent being active",
  );
});
