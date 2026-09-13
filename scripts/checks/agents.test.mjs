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
import { read, htmlIds } from "./_source.mjs";

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
  return [...block.matchAll(/name:\s*"(\w+)",\s*\n\s*op:\s*"(\w+)",\s*\n\s*permissions:\s*&\[([^\]]*)\]/g)].map(
    (m) => ({
      name: m[1],
      op: m[2],
      permissions: [...m[3].matchAll(/"(\w+)"/g)].map((p) => p[1]),
    }),
  );
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

test("every tool the sidecar offers maps to a real operation and real permissions", () => {
  const ops = new Set(gateOps().map((o) => o.op));
  const permissions = new Set(gatePermissions().map((p) => p.id));
  const problems = [];
  for (const tool of sidecarTools()) {
    if (!ops.has(tool.op)) problems.push(`${tool.name} calls ${tool.op}, which does not exist`);
    for (const id of tool.permissions) {
      if (!permissions.has(id)) problems.push(`${tool.name} names ${id}, which does not exist`);
    }
  }
  assert.deepEqual(problems, []);
});

test("the sidecar hides a tool on exactly the permissions the gate charges for it", () => {
  /* The sidecar trims its tool list to what is allowed, purely so a
     well-behaved agent does not waste a turn discovering what it cannot do. If
     it hides a tool on a DIFFERENT permission than the gate charges, the tool
     disappears while still being allowed, or is offered while always failing.
     Neither is enforcement, and neither is visible without this. */
  const charged = new Map(gateOps().map((o) => [o.op, [...o.permissions].sort()]));
  const wrong = sidecarTools()
    .filter((tool) => {
      const expected = charged.get(tool.op) ?? [];
      return JSON.stringify([...tool.permissions].sort()) !== JSON.stringify(expected);
    })
    .map((tool) => `${tool.name}: hidden on ${tool.permissions}, charged ${charged.get(tool.op)}`);
  assert.deepEqual(wrong, []);
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
  /* An editor is configured by editing its file. A "Copy as Command" button
     beside one would be an instruction to run something that does not exist,
     so connectionCommand returns null and the button is not drawn. */
  const src = read("src/tool/kanban-agents.ts");
  const fn = src.slice(src.indexOf("export function connectionCommand"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.match(body, /claude mcp add/, "Claude Code has no command");
  assert.match(body, /codex mcp add/, "Codex has no command");
  assert.match(body, /return null/, "every client is offered a command, including the editors");

  // The button has to honor that null rather than copying "null".
  const ui = read("src/tool/kanban.ts");
  assert.match(
    ui,
    /if \(command\) actions\.append\(copyCmd\)/,
    "the command button is drawn for clients that have no command",
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

test("a dev build hands out the copy, not the exe cargo has to overwrite", () => {
  /* An agent spawns srbk-agent.exe and holds it open for its whole session,
     and Windows will not let cargo overwrite a running exe. So a connection
     pointed at target/debug does not fail on its own terms, it fails the NEXT
     dev build: cargo tries to relink the file the agent is holding and the
     build dies before the app starts, with nothing on screen connecting the
     two. The fix is that a debug build copies the exe out of target/ and the
     Agents tab hands out THAT path. Both halves have to stay, and the lookup
     has to prefer the copy, or the trap comes straight back. */
  const build = read("scripts/build-agent.mjs");
  assert.match(
    build,
    /path\.join\(ROOT_DIR, "dev", "bin"\)/,
    "the debug build no longer copies the exe out of target/",
  );
  assert.match(
    build,
    /EBUSY[\s\S]{0,60}EPERM/,
    "a destination locked by a running agent must warn, not fail the build",
  );

  const preferred = gate().indexOf('dev/bin/srbk-agent.exe');
  const beside = gate().indexOf('let beside = dir.join("srbk-agent.exe")');
  assert.ok(preferred !== -1, "the app no longer looks for the dev copy");
  assert.ok(
    preferred < beside,
    "the app finds target/debug first, so a dev connection still points at the exe cargo overwrites",
  );
});

test("a permission flipped mid-session reaches the agent's tool list", () => {
  /* The tool list is trimmed to what the board allows, and tools/list re-asks
     the app every time so its answer is always current. But an MCP client asks
     ONCE, at startup, and caches. Without a listChanged capability and a
     notification to go with it, turning a permission ON changed nothing the
     agent could see until the whole session was restarted, which reads to
     everyone involved as the feature not existing. That is exactly how the
     column tools went missing while their switch was on.

     The two halves have to ship together: the capability is the promise, the
     notification is the promise being kept, and declaring one without the
     other is worse than declaring neither. */
  const text = sidecar();
  assert.match(
    text,
    /"listChanged":\s*true/,
    "the sidecar tells clients its tool list never changes, so they will not re-ask",
  );
  assert.match(
    text,
    /notifications\/tools\/list_changed/,
    "nothing ever tells the client to re-ask, so listChanged is a promise not kept",
  );
  // The notification is only meaningful if something recomputes the list off
  // fresh permissions rather than the snapshot taken at startup.
  assert.match(
    text,
    /fn spawn_permission_watcher/,
    "no watcher, so the notification can never fire",
  );
});

test("a copied command replaces the old connection and says whether the new one works", () => {
  /* Three ways a paste used to quietly fail. `mcp add` refuses a name it
     already has, and Revoke cannot reach the agent's settings, so the command
     failed for every board that had ever been connected. Claude Code's default
     scope is the folder the command runs in, and an elevated terminal opens in
     System32. And nothing afterwards said whether it had worked. */
  const src = read("src/tool/kanban-agents.ts");
  const fn = src.slice(src.indexOf("export function connectionCommand"));
  const body = fn.slice(0, fn.indexOf("\n}"));

  const claude = body.slice(body.indexOf('"claude-code"'), body.indexOf('"codex"'));
  const remove = claude.indexOf("claude mcp remove");
  assert.ok(
    remove !== -1 && remove < claude.indexOf("claude mcp add"),
    "Claude Code's command adds without removing the old entry first",
  );
  assert.match(claude, /"-s user"/, "Claude Code's connection is saved to whatever folder the command ran in");

  const codex = body.slice(body.indexOf('"codex"'));
  const codexRemove = codex.indexOf("codex mcp remove");
  assert.ok(
    codexRemove !== -1 && codexRemove < codex.indexOf("codex mcp add"),
    "Codex's command adds without removing the old entry first",
  );

  assert.match(body, /check --token/, "the command does not check the connection it just saved");
  assert.match(
    sidecar(),
    /"check"\s*=>\s*std::process::exit\(run_check/,
    "the sidecar has no check command for the pasted line to run",
  );
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

test("the Copy For hint names the buttons as they are labeled, and the right shell", () => {
  /* The hint is the instruction ('Use "Copy for Claude Code" and...'), so a
     button renamed without it sends people looking for something that is not
     there. Both read the same label helpers. The command is PowerShell syntax
     that Command Prompt cannot run, so the hint has to say which shell. */
  const agents = read("src/tool/kanban-agents.ts");
  const hintFn = agents.slice(agents.indexOf("export function clientHint"));
  const hint = hintFn.slice(0, hintFn.indexOf("\n}"));
  assert.match(hint, /copyConfigLabel\(client\)/, "the hint spells out the config button's label itself");
  assert.match(hint, /COPY_COMMAND_LABEL/, "the hint spells out the command button's label itself");
  assert.match(hint, /PowerShell, not Command Prompt/, "the hint does not say which shell runs the command");

  const ui = kanban();
  assert.match(ui, /copyBtn\.textContent = copyConfigLabel\(client\)/, "the config button has its own label");
  assert.match(ui, /copyCmd\.textContent = COPY_COMMAND_LABEL/, "the command button has its own label");
  assert.match(ui, /clientHint\(agentClient\(agentClientId\)\)/, "the line under Copy For is not the hint");

  // The hint offers the command exactly for the clients that have one.
  const cmdFn = agents.slice(agents.indexOf("export function connectionCommand"));
  const cmd = cmdFn.slice(0, cmdFn.indexOf("\n}"));
  assert.match(cmd, /if \(!client\.command\) return null/, "a client without a command can still be handed one");
  const list = agents.slice(
    agents.indexOf("export const AGENT_CLIENTS"),
    agents.indexOf("export function agentClient"),
  );
  const flagged = [...list.matchAll(/id: "([a-z-]+)"[\s\S]*?command: (true|false)/g)]
    .filter((m) => m[2] === "true")
    .map((m) => m[1])
    .sort();
  const branched = [...cmd.matchAll(/client\.id === "([a-z-]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(flagged, branched, "the clients marked as having a command and the commands written differ");
});
