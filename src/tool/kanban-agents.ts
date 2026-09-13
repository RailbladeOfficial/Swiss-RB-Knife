/* =============================================================================
   KANBAN AGENT ACCESS: permissions, tokens and the connection block
   -----------------------------------------------------------------------------
   The settings side of letting a local AI agent work on one board. The
   OPERATIONS are in kanban.ts, because performing them needs the board model;
   everything here is about what is allowed and how an agent is told where to
   knock.

   A LEAF MODULE. It imports nothing from kanban.ts or shell.ts, which is what
   lets kanban.ts import it without an import cycle. See standards section 9.

   THE PERMISSION LIST IS THE CONTRACT. The same ids appear in
   src-tauri/src/agent_gate.rs, which is what actually enforces them, and
   agents.test.mjs fails if the two lists ever disagree. Add a permission in
   both places or in neither.

   WHY THE TOKEN IS STORED IN PLAIN TEXT. It is not a password and it is not
   protecting the file. Anything running as this user can read the data folder
   AND open the pipe, so hashing the token would protect nothing while making
   the connection impossible to copy a second time. What the token is FOR is
   naming one board: an agent holding it can reach that board and no other, and
   revoking it is deleting one line here.

   Rust commands used:
     save_tool_file / load_tool_file (toolId "kanban", kind "agents"),
     kanban_agent_status, kanban_agent_test_connection,
     read_kanban_agent_log, clear_kanban_agent_log
============================================================================= */

import { invoke } from "@tauri-apps/api/core";
import { devError } from "../core/dev-log";
import { loadToolJson, saveToolJson } from "../core/tool-store";

/* =============================================================================
   PERMISSIONS
============================================================================= */

export interface AgentPermission {
  id: string;
  label: string;
  /** Shown in the tab. States what the switch allows, in the app's own words
   *  rather than the agent's. */
  help: string;
}

/**
 * Every switch on the Agents tab, in the order they are shown.
 *
 * The ORDER is deliberate: what an agent does constantly is at the top, what
 * destroys something is near the bottom, and what changes the board's own shape
 * is last. Somebody skimming this list should meet the harmless things first.
 */
export const AGENT_PERMISSIONS: readonly AgentPermission[] = [
  {
    id: "createCard",
    label: "Create cards",
    help: "Add new cards to any column on this board.",
  },
  {
    id: "editCard",
    label: "Edit cards it created",
    help: "Change the title, description or priority of cards this agent added itself.",
  },
  {
    id: "editOthersCards",
    label: "Edit cards created by anyone else",
    help: "Change, move, archive or delete cards you made, or another agent made. Without this, an agent can only touch its own cards.",
  },
  {
    id: "moveCard",
    label: "Move cards between columns",
    help: "Move a card to another column, or to the top or bottom of the one it is in.",
  },
  {
    id: "setDates",
    label: "Set due and stage dates",
    help: "Set or clear the due date and the work, testing and complete dates.",
  },
  {
    id: "manageSubtasks",
    label: "Manage subtasks",
    help: "Add subtasks, tick them off, reword them and remove them.",
  },
  {
    id: "assignTags",
    label: "Assign existing tags",
    help: "Put this board's existing tags on a card, and take them off.",
  },
  {
    id: "createTags",
    label: "Create new tags",
    help: "Add new tags to this board's tag list.",
  },
  {
    id: "createComment",
    label: "Add comments",
    help: "Comment on any card. Comments an agent writes are labeled with its name.",
  },
  {
    id: "deleteComment",
    label: "Delete comments",
    help: "Remove comments from a card.",
  },
  {
    id: "archiveCard",
    label: "Archive cards",
    help: "Take cards off the board without destroying them, and put them back.",
  },
  {
    id: "deleteCard",
    label: "Delete cards",
    help: "Delete cards permanently. An hourly snapshot is the only way back.",
  },
  {
    id: "manageColumns",
    label: "Add and edit columns",
    help: "Add columns, rename them, and change their WIP limits.",
  },
];

/* =============================================================================
   GROUPS
   -----------------------------------------------------------------------------
   How the switches are laid out in the Customize modal: like with like, so a
   column is one decision rather than a list to read twice. The ORDER inside a
   group still runs harmless first, and the groups themselves still end on the
   two that can lose something and the one that changes the board's shape.

   THE GROUPS ARE PRESENTATION ONLY. AGENT_PERMISSIONS stays the contract that
   agent_gate.rs is checked against; a group that forgot a permission would hide
   a granted switch, so agents.test.mjs asserts every id appears in exactly one.
============================================================================= */

export interface AgentPermissionGroup {
  title: string;
  /** Why these belong together, under the group heading. */
  blurb: string;
  ids: readonly string[];
}

export const AGENT_PERMISSION_GROUPS: readonly AgentPermissionGroup[] = [
  {
    title: "Cards",
    blurb: "Making cards and putting them where they go.",
    ids: ["createCard", "editCard", "editOthersCards", "moveCard"],
  },
  {
    title: "What Is On A Card",
    blurb: "The detail inside a card, once it exists.",
    ids: ["setDates", "manageSubtasks", "assignTags", "createTags"],
  },
  {
    title: "Comments",
    blurb: "Talking on a card rather than changing it.",
    ids: ["createComment", "deleteComment"],
  },
  {
    title: "Taking Cards Off",
    blurb: "The two that remove something. Archive is reversible, delete is not.",
    ids: ["archiveCard", "deleteCard"],
  },
  {
    title: "The Board Itself",
    blurb: "Changing the board's shape rather than what is on it.",
    ids: ["manageColumns"],
  },
];

/** The permissions of one group, in the group's order, skipping any id that no
 *  longer exists so a stale group cannot crash the modal. */
export function groupPermissions(group: AgentPermissionGroup): AgentPermission[] {
  return group.ids
    .map((id) => AGENT_PERMISSIONS.find((p) => p.id === id))
    .filter((p): p is AgentPermission => p !== undefined);
}

/** "3 of 13 allowed", for the row that replaced the inline list. Somebody who
 *  never opens the modal should still know whether they granted anything. */
export function permissionSummary(permissions: Record<string, boolean>): string {
  const on = AGENT_PERMISSION_IDS.filter((id) => permissions[id] === true).length;
  if (on === 0) return "Nothing allowed yet";
  return `${on} of ${AGENT_PERMISSION_IDS.length} allowed`;
}

export const AGENT_PERMISSION_IDS: readonly string[] = AGENT_PERMISSIONS.map((p) => p.id);

export function permissionLabel(id: string): string {
  return AGENT_PERMISSIONS.find((p) => p.id === id)?.label ?? id;
}

/** A brand-new board's permissions: everything off.
 *
 *  Every one of them, written out, rather than an empty object. An absent key
 *  already reads as off in both halves of the app, but writing them makes the
 *  file say what it means, which matters for the one file in this tool somebody
 *  might open to check what they granted. */
export function emptyPermissions(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const permission of AGENT_PERMISSIONS) out[permission.id] = false;
  return out;
}

/** The set a first-time user gets when they switch a board on.
 *
 *  Reading is already granted by enabling at all. These three add the ordinary
 *  reason somebody wanted this: file work as cards, note progress, tick things
 *  off. Nothing here can lose anything: no delete, no editing what the user
 *  wrote, no touching the board's shape. */
export function starterPermissions(): Record<string, boolean> {
  return {
    ...emptyPermissions(),
    createCard: true,
    editCard: true,
    createComment: true,
  };
}

/* =============================================================================
   THE CONFIG FILE
============================================================================= */

export interface AgentToken {
  /** Stable for the life of the connection and NOT the secret. Cards record
   *  this as their author, so regenerating the secret does not turn an agent
   *  into a stranger to its own cards. */
  id: string;
  label: string;
  token: string;
  createdAt: number;
}

export interface BoardAgentConfig {
  enabled: boolean;
  permissions: Record<string, boolean>;
  tokens: AgentToken[];
}

export interface AgentConfig {
  /** The master switch, in the tool's Setup. Off means off everywhere. */
  enabled: boolean;
  boards: Record<string, BoardAgentConfig>;
}

export function emptyAgentConfig(): AgentConfig {
  return { enabled: false, boards: {} };
}

function normalizeToken(raw: unknown): AgentToken | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Partial<AgentToken>;
  if (typeof t.id !== "string" || !t.id) return null;
  if (typeof t.token !== "string" || !t.token) return null;
  return {
    id: t.id,
    label: typeof t.label === "string" && t.label ? t.label.slice(0, 80) : "Agent",
    token: t.token,
    createdAt: typeof t.createdAt === "number" ? t.createdAt : Date.now(),
  };
}

function normalizeBoardConfig(raw: unknown): BoardAgentConfig {
  const empty: BoardAgentConfig = {
    enabled: false,
    permissions: emptyPermissions(),
    tokens: [],
  };
  if (!raw || typeof raw !== "object") return empty;
  const b = raw as Partial<BoardAgentConfig>;

  // Only ids this build knows are kept. A permission from a newer version is
  // dropped rather than carried, so a downgrade cannot leave a switch granted
  // that nothing on screen can turn off.
  const permissions = emptyPermissions();
  if (b.permissions && typeof b.permissions === "object") {
    for (const id of AGENT_PERMISSION_IDS) {
      permissions[id] = (b.permissions as Record<string, unknown>)[id] === true;
    }
  }
  return {
    enabled: b.enabled === true,
    permissions,
    tokens: Array.isArray(b.tokens)
      ? b.tokens.map(normalizeToken).filter((t): t is AgentToken => t !== null)
      : [],
  };
}

export function normalizeAgentConfig(raw: unknown): AgentConfig {
  if (!raw || typeof raw !== "object") return emptyAgentConfig();
  const c = raw as Partial<AgentConfig>;
  const boards: Record<string, BoardAgentConfig> = {};
  if (c.boards && typeof c.boards === "object") {
    for (const [boardId, value] of Object.entries(c.boards)) {
      boards[boardId] = normalizeBoardConfig(value);
    }
  }
  return { enabled: c.enabled === true, boards };
}

/**
 * Reads the agent config, or the empty one if it could not be read.
 *
 * The empty one is the safe FALLBACK here in a way it is not elsewhere: every
 * permission off and the bridge disabled is the right answer to "I cannot tell
 * what this file says". What would not be safe is saving it back. This file
 * holds the tokens pasted into agent configs elsewhere on the machine, so
 * writing an empty one over it breaks every agent with nothing saying why.
 * loadToolJson has already blocked that write by the time this returns.
 */
export async function loadAgentConfig(): Promise<AgentConfig> {
  try {
    return normalizeAgentConfig(await loadToolJson<unknown>("kanban", "agents"));
  } catch (err) {
    devError("[kanban] agent config load failed", err);
    return emptyAgentConfig();
  }
}

/**
 * Writes the config, and waits for the write to land.
 *
 * NOT debounced, unlike every other write in this tool. The back end re-reads
 * this file on every request an agent makes, so the moment between switching a
 * permission off and the file saying so is a moment in which the agent can
 * still use it. Turning something off has to mean it is off.
 */
export async function saveAgentConfig(config: AgentConfig): Promise<void> {
  await saveToolJson("kanban", "agents", config);
}

export function boardConfig(config: AgentConfig, boardId: string): BoardAgentConfig {
  return config.boards[boardId] ?? normalizeBoardConfig(null);
}

/* =============================================================================
   TOKENS
============================================================================= */

/** A connection secret. 32 hex characters of crypto randomness, prefixed so
 *  that a token found loose in a config file somewhere is identifiable as one
 *  of ours rather than an anonymous blob. */
export function newAgentToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `srbk1_${hex}`;
}

export function newConnection(label: string): AgentToken {
  return {
    id: crypto.randomUUID(),
    label: label.trim().slice(0, 80) || "Agent",
    token: newAgentToken(),
    createdAt: Date.now(),
  };
}

/* =============================================================================
   WHAT GETS COPIED
   -----------------------------------------------------------------------------
   The whole point of the button: everything an agent needs, in the shape its
   config file already uses, with no folder to find and nothing to install.
============================================================================= */

export interface ConnectionInfo {
  boardName: string;
  token: string;
  sidecarPath: string;
  pipeName: string;
}

/** True for the pipe a dev build listens on. agent_gate.rs's pipe_name() adds
 *  the suffix, so this is the one place the front end can tell the two apart. */
export function isDevPipe(pipeName: string): boolean {
  return /\.dev$/.test(pipeName);
}

/** The key the agent's config file lists this server under. Derived from the
 *  board's name so a user with three boards connected can tell them apart in
 *  their own config.
 *
 *  A DEV BUILD GETS ITS OWN KEY. The copied command replaces whatever is saved
 *  under this key, so if the dev and installed apps shared one, connecting a
 *  dev board would silently disconnect the installed app's board of the same
 *  name, and the other way round. */
export function serverKey(boardName: string, pipeName = ""): string {
  const slug = boardName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const base = isDevPipe(pipeName) ? "srbk-dev-kanban" : "srbk-kanban";
  return slug ? `${base}-${slug}` : base;
}

/* =============================================================================
   THE CLIENTS
   -----------------------------------------------------------------------------
   MCP is one protocol and the sidecar speaks it the same way to everyone. What
   differs is where each client keeps its list of servers and what that file
   looks like, and getting either wrong produces a config that is silently
   ignored rather than one that reports an error.

   THREE SHAPES, not one:

     mcpServers   an "mcpServers" object of command/args/env. Claude Code,
                  Cursor, Windsurf and Gemini CLI all read this, differing only
                  in which file they read it from.
     vscode       VS Code. The key is "servers", NOT "mcpServers", and a stdio
                  server has to declare `"type": "stdio"`. This block used to
                  claim VS Code shared the shape above; it does not, and a
                  config copied from here would never have loaded there.
     codexToml    Codex. TOML rather than JSON, with the environment in a table
                  of its own.

   THE PIPE NAME is passed explicitly in every one of them rather than left to
   the sidecar's default. A dev build listens on a different name, so a copied
   connection that relied on the default would work from an installed app and
   fail from a dev one, with nothing on screen explaining the difference.
============================================================================= */

export type AgentClientFormat = "mcpServers" | "vscode" | "codexToml";

export interface AgentClient {
  id: string;
  label: string;
  /** Which of the three shapes its config file takes. */
  format: AgentClientFormat;
  /** Where the block goes, shown under the buttons so nobody has to guess. */
  where: string;
  /** True for the terminal agents, false for the editors. Only groups the
   *  list; both kinds work identically. */
  cli: boolean;
}

/**
 * Every client this connection can be copied for.
 *
 * The CLI agents come first because they are what this feature was built for:
 * something running beside you in a terminal while you work. The editors read
 * the same protocol and are listed under them.
 *
 * DeepSeek is deliberately absent. It publishes models rather than a
 * first-party terminal agent with a documented MCP config, and the third-party
 * harnesses that run its models each keep their own file in their own format.
 * Guessing at one and shipping it would produce a config that silently does
 * nothing, which is worse than not offering it.
 */
export const AGENT_CLIENTS: readonly AgentClient[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    format: "mcpServers",
    where: "Copy as Command and paste it into PowerShell. Or put the block in .mcp.json in your project.",
    cli: true,
  },
  {
    id: "codex",
    label: "Codex",
    format: "codexToml",
    where:
      "Copy as Command and paste it into PowerShell. Or put the block in ~/.codex/config.toml, or .codex/config.toml in a trusted project.",
    cli: true,
  },
  {
    id: "gemini-cli",
    label: "Gemini CLI",
    format: "mcpServers",
    where: "Put the block in ~/.gemini/settings.json, or .gemini/settings.json in your project.",
    cli: true,
  },
  {
    id: "cursor",
    label: "Cursor",
    format: "mcpServers",
    where: "Put the block in ~/.cursor/mcp.json, or .cursor/mcp.json in your project.",
    cli: false,
  },
  {
    id: "windsurf",
    label: "Windsurf",
    format: "mcpServers",
    where: "Put the block in %USERPROFILE%\\.codeium\\windsurf\\mcp_config.json.",
    cli: false,
  },
  {
    id: "vscode",
    label: "VS Code",
    format: "vscode",
    where: "Put the block in .vscode/mcp.json in your project.",
    cli: false,
  },
];

export function agentClient(id: string): AgentClient {
  return AGENT_CLIENTS.find((c) => c.id === id) ?? AGENT_CLIENTS[0];
}

/** What the sidecar is launched with, which is the same for every client. */
function launch(info: ConnectionInfo) {
  return {
    command: info.sidecarPath,
    args: ["--mcp"],
    env: {
      SRBK_AGENT_TOKEN: info.token,
      SRBK_AGENT_PIPE: info.pipeName,
    },
  };
}

/** The "mcpServers" shape: Claude Code, Cursor, Windsurf, Gemini CLI. */
export function connectionJson(info: ConnectionInfo): string {
  return JSON.stringify(
    { mcpServers: { [serverKey(info.boardName, info.pipeName)]: launch(info) } },
    null,
    2,
  );
}

/** VS Code: "servers" rather than "mcpServers", and an explicit stdio type. */
export function vsCodeConnectionJson(info: ConnectionInfo): string {
  return JSON.stringify(
    { servers: { [serverKey(info.boardName, info.pipeName)]: { type: "stdio", ...launch(info) } } },
    null,
    2,
  );
}

/** Codex: TOML, with the environment as a table of its own.
 *
 *  Backslashes in the path are escaped, because a Windows path dropped into a
 *  TOML basic string would otherwise read \n and \t as control characters and
 *  produce a command that points nowhere. */
export function codexConnectionToml(info: ConnectionInfo): string {
  const key = serverKey(info.boardName, info.pipeName);
  const esc = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return [
    `[mcp_servers.${key}]`,
    `command = "${esc(info.sidecarPath)}"`,
    `args = ["--mcp"]`,
    "",
    `[mcp_servers.${key}.env]`,
    `SRBK_AGENT_TOKEN = "${esc(info.token)}"`,
    `SRBK_AGENT_PIPE = "${esc(info.pipeName)}"`,
  ].join("\n");
}

/** The config for whichever client is selected. */
export function connectionConfig(info: ConnectionInfo, client: AgentClient): string {
  if (client.format === "vscode") return vsCodeConnectionJson(info);
  if (client.format === "codexToml") return codexConnectionToml(info);
  return connectionJson(info);
}

/**
 * The same thing as a command, for the clients that have one. Null for the
 * editors, which are configured by editing their file.
 *
 * One line for PowerShell, which is what Windows Terminal opens, built so that
 * pasting it is the whole job however many times it has been done before:
 *
 *   1. REMOVE, then add. `mcp add` refuses a name that is already saved, and
 *      Revoke cannot reach the agent's settings, so an add-only command failed
 *      for every board that had ever been connected. Nothing on screen said the
 *      fix was to remove the old entry by hand. A remove with nothing to remove
 *      prints an error, which `2>$null` hides.
 *   2. USER SCOPE for Claude Code. The default scope is the folder the command
 *      is run in, and an elevated terminal opens in System32, so the connection
 *      was saved somewhere Claude would never be started from. The local-scope
 *      remove clears an entry an older version of this command left behind.
 *   3. CHECK. srbk-agent runs once with the same token and pipe and prints, in
 *      words, whether the board answered and what to do if it did not. It is
 *      the only feedback a pasted command gives before the agent is restarted.
 *
 * Replacing is safe because the key is per board and per build: see serverKey.
 */
export function connectionCommand(info: ConnectionInfo, client: AgentClient): string | null {
  const key = serverKey(info.boardName, info.pipeName);
  const env = [`SRBK_AGENT_TOKEN=${info.token}`, `SRBK_AGENT_PIPE=${info.pipeName}`].map(
    (e) => `--env ${e}`,
  );
  const exe = `"${info.sidecarPath}"`;
  const check = `& ${exe} check --token ${info.token} --pipe ${info.pipeName}`;

  if (client.id === "claude-code") {
    return [
      `claude mcp remove ${key} -s local 2>$null`,
      `claude mcp remove ${key} -s user 2>$null`,
      ["claude mcp add", key, "-s user", ...env, `-- ${exe} --mcp`].join(" "),
      check,
    ].join("; ");
  }
  if (client.id === "codex") {
    return [
      `codex mcp remove ${key} 2>$null`,
      ["codex mcp add", key, ...env, `-- ${exe} --mcp`].join(" "),
      check,
    ].join("; ");
  }
  return null;
}

/* =============================================================================
   STATUS AND HISTORY
============================================================================= */

export interface AgentStatus {
  listening: boolean;
  error: string;
  pipeName: string;
  sidecarPath: string;
  sidecarFound: boolean;
  permissionIds: string[];
  /** Connection id to when an agent last reached this app with it, in epoch ms.
   *  Since the app started; the app's own Test Connection is not counted. */
  lastSeen: Record<string, number>;
}

export async function agentStatus(): Promise<AgentStatus> {
  return invoke<AgentStatus>("kanban_agent_status");
}

export interface AgentTestResult {
  ok: boolean;
  summary: string;
  detail: string;
}

/**
 * Runs srbk-agent.exe for real and reports what happened.
 *
 * The status badge can only say this app is listening. This says whether the
 * whole path works, which is the question somebody setting it up is actually
 * asking. Takes a connection's token because a test that skipped the token
 * would pass for a connection that no longer works.
 */
export async function testAgentConnection(token: string): Promise<AgentTestResult> {
  try {
    return await invoke<AgentTestResult>("kanban_agent_test_connection", { token });
  } catch (err) {
    devError("[kanban] agent test failed", err);
    return { ok: false, summary: "The test could not run", detail: String(err) };
  }
}

export interface AgentLogEntry {
  at: string;
  boardId: string;
  agent: string;
  op: string;
  ok: boolean;
  error: string | null;
}

export async function readAgentLog(limit = 100): Promise<AgentLogEntry[]> {
  try {
    return await invoke<AgentLogEntry[]>("read_kanban_agent_log", { limit });
  } catch (err) {
    devError("[kanban] agent log read failed", err);
    return [];
  }
}

export async function clearAgentLog(): Promise<void> {
  await invoke("clear_kanban_agent_log");
}

/** How an operation reads in the activity list. The agent's own names are
 *  snake_case because they are an API; this is the same list for a person. */
const OP_LABELS: Record<string, string> = {
  capabilities: "Checked what it may do",
  get_board: "Read the board",
  list_cards: "Listed cards",
  get_card: "Read a card",
  create_card: "Created a card",
  update_card: "Edited a card",
  move_card: "Moved a card",
  set_card_dates: "Set dates",
  archive_card: "Archived a card",
  delete_card: "Deleted a card",
  add_comment: "Added a comment",
  delete_comment: "Deleted a comment",
  add_subtask: "Added a subtask",
  set_subtask: "Changed a subtask",
  remove_subtask: "Removed a subtask",
  set_card_tags: "Changed a card's tags",
  create_tag: "Created a tag",
  create_column: "Created a column",
  update_column: "Edited a column",
};

export function opLabel(op: string): string {
  return OP_LABELS[op] ?? op;
}
