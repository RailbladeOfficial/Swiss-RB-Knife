/* =============================================================================
   KANBAN AGENTS TAB: switching agent access on for one board
   -----------------------------------------------------------------------------
   The screen. What it can turn on is kanban-agents.ts, and what an agent then
   does with it is kanban-executor.ts; this is the tab in Board Setup where a
   person makes those decisions and copies a connection out.

     kanban-agents.ts     the permission list, the tokens, the connection
                          blocks. A leaf, importing neither of the others.
     this file            the screen: switches, connection rows, the log.
     kanban-executor.ts   what happens when an agent asks for something.
     kanban.ts            the board itself.

   THE CONFIG IS READ FROM DISK EVERY TIME THIS TAB OPENS rather than held in
   memory with the rest of the tool's state. It is written by this screen and
   read by the back end on every single agent request, so the copy that matters
   is the one on disk; keeping a second copy in memory is how the switch you see
   stops being the switch that is enforced.

   WRITES HERE ARE NOT DEBOUNCED, unlike everything else in this tool. See
   saveAgentConfig: the gap between turning a permission off and the file saying
   so is a gap in which an agent can still use it.

   ABOUT THE IMPORT LOOP with kanban.ts, and the same answer as the executor's:
   nothing here reads a value across it as this file LOADS. Every reference is
   inside a function, and the earliest any of them runs is the moment somebody
   opens Board Setup. See standards section 9 and module-init.test.mjs.
============================================================================= */

import { Modal } from "../modal/modal";
import { devError, flash } from "../core/shell";
import { toggleInfoTooltip } from "../core/info-tooltip";
import {
  AGENT_CLIENTS,
  AGENT_PERMISSIONS,
  AGENT_PERMISSION_GROUPS,
  AGENT_READ_ACCESS,
  COPY_COMMAND_LABEL,
  COPY_CONFIG_LABEL,
  COPY_MODE_NAMES,
  agentClient,
  agentClientOptionLabel,
  agentStatus,
  boardConfig,
  clearAgentLog,
  clientHint,
  connectionCommand,
  connectionConfig,
  copyModesFor,
  groupPermissions,
  loadAgentConfig,
  newConnection,
  opLabel,
  permissionSummary,
  readAgentLog,
  saveAgentConfig,
  starterPermissions,
  testAgentConnection,
  type AgentConfig,
  type AgentCopyMode,
  type AgentLogEntry,
  type AgentToken,
} from "./kanban-agents";
import type {
  Board,
} from "./kanban-model";
import {
  boardEditId,
  formatDate,
  getBoard,
  getBoardSetupModal,
  kbConfirm,
  openBoardSetup,
  openSetupOnTab,
} from "./kanban";

/** The permissions modal. Declared here rather than beside the tool's other
 *  modal handles: nothing outside this screen opens it. */
let _agentPermModal: Modal | null = null;

/** The config as this screen last read it. Null until the tab is opened. */
export let agentConfig: AgentConfig | null = null;

/* WHICH AGENT THE COPY BUTTONS ARE AIMED AT.
   Session state rather than a saved setting: it changes what is put on the
   clipboard and nothing else, and somebody who connects Claude Code once is
   not served by the app remembering that forever. Defaults to the first
   client, which is the one this was built against. */
let agentClientId: string = AGENT_CLIENTS[0].id;

/* HOW THE CONNECTION IS HANDED OVER: the command that sets the agent up, or the
   block for its settings file. Session state like the agent above, and put back
   to the agent's best way whenever the agent changes, so picking Claude Code
   after looking at Cursor lands on the command rather than on Cursor's file. */
let agentCopyMode: AgentCopyMode = "command";

async function loadAgentConfigForTab(): Promise<AgentConfig> {
  agentConfig = await loadAgentConfig();
  return agentConfig;
}

/** Applies a change and writes it, then redraws. Every switch on this tab goes
 *  through here so that none of them can forget the write. */
async function commitAgentConfig(change: (config: AgentConfig) => void): Promise<void> {
  const config = agentConfig ?? (await loadAgentConfigForTab());
  change(config);
  try {
    await saveAgentConfig(config);
  } catch (err) {
    devError("[kanban] agent config save failed", err);
    flash("Couldn't save the agent settings.", "error", 6000);
    return;
  }
  await renderAgentsTab();
}

function agentBoardConfig(config: AgentConfig, boardId: string) {
  if (!config.boards[boardId]) {
    config.boards[boardId] = { enabled: false, permissions: starterPermissions(), tokens: [] };
  }
  return config.boards[boardId];
}

export async function renderAgentsTab(): Promise<void> {
  // agentBoard(), so a switch flipped in the Customize modal redraws it too.
  const board = agentBoard();
  if (!board) return;
  const config = await loadAgentConfigForTab();
  const mine = boardConfig(config, board.id);
  const status = await agentStatus();

  const masterOff = document.getElementById("kbAgentMasterOff")!;
  masterOff.style.display = !config.enabled && mine.enabled ? "" : "none";

  const toggle = document.getElementById("kbAgentEnabledToggle") as HTMLInputElement;
  const toggleLabel = document.getElementById("kbAgentEnabledLabel")!;
  toggle.checked = mine.enabled;
  toggleLabel.textContent = mine.enabled ? "On" : "Off";

  /* The badge is the honest answer to "is this actually working". A board
     switched on while the pipe failed to open looks identical otherwise, and
     the agent's error would be the first anybody heard of it. */
  const badge = document.getElementById("kbAgentStatusBadge")!;
  if (!mine.enabled) {
    badge.textContent = "";
  } else if (!config.enabled) {
    badge.textContent = "Blocked by the app-wide switch";
  } else if (!status.listening) {
    badge.textContent = status.error || "Not accepting connections";
  } else if (!status.sidecarFound) {
    badge.textContent = "srbk-agent.exe is missing";
  } else {
    badge.textContent = "Ready";
  }

  document.getElementById("kbAgentBody")!.style.display = mine.enabled ? "" : "none";
  if (!mine.enabled) {
    renderAgentLive(null);
    return;
  }

  document.getElementById("kbAgentPermSummary")!.textContent = permissionSummary(mine.permissions);
  document.getElementById("kbAgentPermSummaryInModal")!.textContent = permissionSummary(
    mine.permissions,
  );

  renderAgentPermissions(board, mine.permissions);
  renderAgentClientPicker();
  renderAgentConnections(board, mine.tokens, status);
  const entries = (await readAgentLog(200)).filter((entry) => entry.boardId === board.id);
  renderAgentLive(latestAgentContact(mine.tokens, status.lastSeen, entries[0] ?? null));
  renderAgentLog(entries);
}

/**
 * When an agent last reached this board, and which connection it used.
 *
 * TWO SOURCES, AND THE BADGE HAS TO READ BOTH. The activity log only records
 * operations (reading and changing cards), so a freshly reconnected agent that
 * had not touched a card yet left the badge reading "last seen 11 min ago"
 * while the connection row beside it said "last used just now". The app's
 * last-seen record also catches the capabilities check an agent's session makes
 * every few seconds, so it is the live one; but it is in memory, so after a
 * restart the log is all there is. Whichever is newer wins.
 */
function latestAgentContact(
  tokens: AgentToken[],
  lastSeen: Record<string, number> | undefined,
  logged: AgentLogEntry | null,
): { agent: string; at: number } | null {
  let best: { agent: string; at: number } | null = null;
  for (const token of tokens) {
    const at = lastSeen?.[token.id];
    if (at && (!best || at > best.at)) best = { agent: token.label, at };
  }
  const loggedAt = logged ? new Date(logged.at).getTime() : NaN;
  if (logged && !Number.isNaN(loggedAt) && (!best || loggedAt > best.at)) {
    best = { agent: logged.agent, at: loggedAt };
  }
  return best;
}

/** How recently counts as "right now". Long enough to still say so between two
 *  requests an agent makes while it thinks, short enough that a badge reading
 *  "Agent active" is not describing this morning. */
const AGENT_LIVE_WINDOW_MS = 2 * 60 * 1000;

/**
 * The badge that answers "is my agent actually talking to this board".
 *
 * The status badge beside it can only say this app is LISTENING, which is true
 * of a board no agent has ever connected to. This says whether one has, and
 * how long ago, which is the difference between a setup that works and a setup
 * that merely looks right.
 */
function renderAgentLive(latest: { agent: string; at: number } | null): void {
  const badge = document.getElementById("kbAgentLiveBadge")!;
  if (!latest) {
    badge.style.display = "none";
    return;
  }

  const ago = Date.now() - latest.at;
  badge.style.display = "";
  if (ago <= AGENT_LIVE_WINDOW_MS) {
    badge.classList.add("kb-agent-live");
    badge.textContent = `${latest.agent} active now`;
  } else {
    // Still worth showing: "last seen three days ago" is how somebody notices a
    // connection quietly stopped working.
    badge.classList.remove("kb-agent-live");
    badge.textContent = `${latest.agent} last seen ${describeAgo(ago)}`;
  }
}

/** Rough and readable, not precise. Nobody needs the seconds. */
function describeAgo(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "an hour ago" : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

/**
 * The switches, grouped, into the Customize modal's grid.
 *
 * Renders whether or not the modal is open, because the tab re-renders after
 * every change and the modal is a child of the page rather than of the tab: a
 * grid built only on open would show yesterday's state for the moment between
 * a toggle and its save landing.
 */
function renderAgentPermissions(board: Board, permissions: Record<string, boolean>): void {
  const grid = document.getElementById("kbAgentPermissionList")!;
  grid.replaceChildren();

  grid.appendChild(readAccessGroup());

  for (const group of AGENT_PERMISSION_GROUPS) {
    const members = groupPermissions(group);
    if (members.length === 0) continue;

    const box = document.createElement("div");
    box.className = "kb-agent-perm-group";

    const title = document.createElement("div");
    title.className = "kb-agent-perm-group-title";
    title.textContent = group.title;

    const blurb = document.createElement("p");
    blurb.className = "kb-agent-perm-group-blurb";
    blurb.textContent = group.blurb;

    box.append(title, blurb);

    for (const permission of members) {
      box.appendChild(permissionRow(board, permission, permissions));
    }
    grid.appendChild(box);
  }
}

/** Reading, drawn first as switches locked on, so the modal is the whole list
 *  of what an agent can do. Nothing here is saved or counted in the summary:
 *  these are what agent access means, not choices within it. */
function readAccessGroup(): HTMLElement {
  const box = document.createElement("div");
  box.className = "kb-agent-perm-group kb-agent-perm-locked";

  const title = document.createElement("div");
  title.className = "kb-agent-perm-group-title";
  title.textContent = "Reading";

  const blurb = document.createElement("p");
  blurb.className = "kb-agent-perm-group-blurb";
  blurb.textContent =
    "Always allowed while agent access is on. To stop it, turn agent access off or revoke the connection.";

  box.append(title, blurb);
  for (const access of AGENT_READ_ACCESS) box.appendChild(lockedAccessRow(access.label, access.help));
  return box;
}

/** A switch that shows On and cannot be flipped, with the same label and info
 *  button as a real one. */
function lockedAccessRow(text: string, help: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "settings-row";

  const label = document.createElement("span");
  label.className = "kb-label-with-info";
  label.textContent = text;
  const info = document.createElement("button");
  info.type = "button";
  info.className = "info-trigger-btn kb-info-btn";
  info.textContent = "ℹ";
  info.title = help;
  info.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleInfoTooltip(info, help, "kb-info-tooltip");
  });
  label.appendChild(info);
  row.appendChild(label);

  const wrap = document.createElement("div");
  wrap.className = "toggle-with-label";
  wrap.title = "Reading cannot be switched off";
  const state = document.createElement("span");
  state.textContent = "Always On";
  const switchLabel = document.createElement("label");
  switchLabel.className = "toggle-switch";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = true;
  input.disabled = true;
  const slider = document.createElement("span");
  slider.className = "toggle-slider";
  switchLabel.append(input, slider);
  wrap.append(state, switchLabel);
  row.appendChild(wrap);
  return row;
}

/** One switch and its label. Unchanged in behavior from the flat list this
 *  replaced; only where it is drawn moved. */
function permissionRow(
  board: Board,
  permission: (typeof AGENT_PERMISSIONS)[number],
  permissions: Record<string, boolean>,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "settings-row";

  const label = document.createElement("span");
  label.className = "kb-label-with-info";
  label.textContent = permission.label;
  const info = document.createElement("button");
  info.type = "button";
  info.className = "info-trigger-btn kb-info-btn";
  info.textContent = "ℹ";
  info.title = permission.help;
  info.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleInfoTooltip(info, permission.help, "kb-info-tooltip");
  });
  label.appendChild(info);
  row.appendChild(label);

  const wrap = document.createElement("div");
  wrap.className = "toggle-with-label";
  const state = document.createElement("span");
  state.textContent = permissions[permission.id] ? "On" : "Off";
  const switchLabel = document.createElement("label");
  switchLabel.className = "toggle-switch";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = permissions[permission.id] === true;
  input.addEventListener("change", () => {
    void commitAgentConfig((config) => {
      agentBoardConfig(config, board.id).permissions[permission.id] = input.checked;
    });
  });
  const slider = document.createElement("span");
  slider.className = "toggle-slider";
  switchLabel.append(input, slider);
  wrap.append(state, switchLabel);
  row.appendChild(wrap);
  return row;
}

/** The agent picker, and the line under it saying where that agent's file is.
 *
 *  Grouped so the terminal agents read as one kind of thing and the editors as
 *  another. Both work identically; the split is only so the list scans. */
function renderAgentClientPicker(): void {
  const select = document.getElementById("kbAgentClientSelect") as HTMLSelectElement;
  if (!select) return;

  if (select.options.length === 0) {
    for (const [label, cli] of [
      ["Coding agents", true],
      ["Editors", false],
    ] as const) {
      const group = document.createElement("optgroup");
      group.label = label;
      for (const client of AGENT_CLIENTS.filter((c) => c.cli === cli)) {
        const option = document.createElement("option");
        option.value = client.id;
        option.textContent = agentClientOptionLabel(client);
        group.appendChild(option);
      }
      select.appendChild(group);
    }
    select.addEventListener("change", () => {
      agentClientId = select.value;
      agentCopyMode = copyModesFor(agentClient(agentClientId))[0];
      void renderAgentsTab();
    });
  }

  select.value = agentClientId;
  const client = agentClient(agentClientId);

  /* Copy As, rebuilt per agent. An editor has no command, so its only option is
     the config file and the dropdown is disabled rather than offering a choice
     that is not one. */
  const modes = copyModesFor(client);
  if (!modes.includes(agentCopyMode)) agentCopyMode = modes[0];
  const modeSelect = document.getElementById("kbAgentCopyModeSelect") as HTMLSelectElement;
  modeSelect.replaceChildren(
    ...modes.map((mode) => {
      const option = document.createElement("option");
      option.value = mode;
      option.textContent = COPY_MODE_NAMES[mode];
      return option;
    }),
  );
  modeSelect.value = agentCopyMode;
  modeSelect.disabled = modes.length === 1;

  document.getElementById("kbAgentClientWhere")!.textContent = clientHint(client, agentCopyMode);
}

function renderAgentConnections(
  board: Board,
  tokens: AgentToken[],
  status: {
    pipeName: string;
    sidecarPath: string;
    sidecarFound: boolean;
    lastSeen: Record<string, number>;
  },
): void {
  const list = document.getElementById("kbAgentConnectionList")!;
  list.replaceChildren();

  if (tokens.length === 0) {
    const empty = document.createElement("p");
    empty.className = "kb-agent-empty";
    empty.textContent = "No connections yet. Make one, then paste it into your AI agent.";
    list.appendChild(empty);
    return;
  }

  for (const token of tokens) {
    const row = document.createElement("div");
    row.className = "kb-agent-connection";

    const head = document.createElement("div");
    head.className = "kb-agent-connection-head";
    const name = document.createElement("span");
    name.className = "kb-agent-connection-name";
    name.textContent = token.label;
    const made = document.createElement("span");
    made.className = "kb-agent-connection-date";
    /* Whether an agent has actually used it, beside when it was made. This is
       the half Test Connection cannot see: a connection can work perfectly from
       here while the agent is still set up with an older one. */
    const seenAt = status.lastSeen?.[token.id];
    made.textContent =
      `Added ${formatDate(new Date(token.createdAt).toLocaleDateString("en-CA"))} · ` +
      (seenAt ? `last used ${describeAgo(Date.now() - seenAt)}` : "not used since the app started");
    head.append(name, made);
    row.appendChild(head);

    const path = document.createElement("div");
    path.className = "kb-agent-connection-path";
    path.textContent = status.sidecarFound
      ? status.sidecarPath
      : `${status.sidecarPath} (not found)`;
    row.appendChild(path);

    const info = {
      boardName: board.name,
      token: token.token,
      sidecarPath: status.sidecarPath,
      pipeName: status.pipeName,
    };

    const actions = document.createElement("div");
    actions.className = "kb-agent-connection-actions";

    const client = agentClient(agentClientId);

    /* ONE copy button. What it copies is whatever Copy As says above, and its
       label names exactly that, so the hint and the button always agree. An
       editor has no command, and Copy As offers it nothing else, so this is
       always the config there. */
    const command = agentCopyMode === "command" ? connectionCommand(info, client) : null;
    const copyBtn = document.createElement("button");
    copyBtn.className = "settings-action-btn";
    if (command) {
      copyBtn.textContent = COPY_COMMAND_LABEL;
      copyBtn.title =
        `Sets up ${client.label} with this connection, replacing this board's earlier one ` +
        "there, then checks that it works.";
      copyBtn.addEventListener("click", () => {
        void copyAgentText(
          command,
          "Command",
          "Paste it into Command Prompt or PowerShell and press Enter.",
        );
      });
    } else {
      copyBtn.textContent = COPY_CONFIG_LABEL;
      copyBtn.addEventListener("click", () => {
        void copyAgentText(
          connectionConfig(info, client),
          `${client.label} config`,
          `Add it to ${client.where}.`,
        );
      });
    }

    /* Runs srbk-agent.exe for real, so a failure names the part that does not
       work: the exe missing, an antivirus blocking it, or a token this board no
       longer knows.

       WHAT A PASS DOES NOT PROVE, and the reason the result is worded the way it
       is. This tests the connection as Swiss RB Knife holds it. It cannot see
       the agent's own settings, so it passed happily for a connection whose
       agent was still set up with an older, revoked one. "Connection works" on
       its own was a claim about the agent it had no way to make. The only
       evidence this app can have about the agent is a request arriving, so the
       result says whether one has. */
    const testBtn = document.createElement("button");
    testBtn.className = "settings-action-btn";
    testBtn.textContent = "Test Connection";
    const testResult = document.createElement("span");
    testResult.className = "kb-agent-test-result";
    testBtn.addEventListener("click", () => {
      testBtn.disabled = true;
      testResult.className = "kb-agent-test-result";
      testResult.textContent = "Testing…";
      testResult.title = "";
      void testAgentConnection(token.token)
        .then(async (result) => {
          const seenAt = await agentStatus()
            .then((fresh) => fresh.lastSeen?.[token.id])
            .catch(() => undefined);
          testResult.className = result.ok
            ? "kb-agent-test-result kb-agent-test-ok"
            : "kb-agent-test-result kb-agent-test-bad";
          if (!result.ok) {
            testResult.textContent = result.summary;
          } else if (seenAt) {
            testResult.textContent = `Works. An agent last used it ${describeAgo(Date.now() - seenAt)}.`;
          } else {
            testResult.textContent =
              "Works in Swiss RB Knife, but no agent has used it since the app started. If " +
              "your agent can't see this board, copy this connection again and set the agent " +
              "up with it.";
          }
          // The sidecar's full report is the tooltip rather than the line: the
          // board, the connection and what it may do, or what to do about it.
          testResult.title = result.detail;
        })
        .finally(() => {
          testBtn.disabled = false;
        });
    });

    const remove = document.createElement("button");
    remove.className = "modal-cancel-btn";
    remove.textContent = "Revoke";
    remove.addEventListener("click", () => {
      kbConfirm(
        {
          title: "Revoke this connection?",
          /* States the cost of revoking, which is what there is to weigh
             here. The steps for reconnecting used to follow it; a confirm is
             a decision, not a runbook. */
          message:
            `"${token.label}" stops working immediately, and the agent has to be set up ` +
            "again with a new connection. Cards it already created keep its name.",
          confirmLabel: "Revoke",
          reopen: () => openBoardSetup(board, "agents"),
        },
        () => {
          // Reopened AFTER the write, not beside it: the tab renders from the
          // config on disk, so reopening first would draw the revoked
          // connection back one more time before correcting itself.
          void commitAgentConfig((config) => {
            const mine = agentBoardConfig(config, board.id);
            mine.tokens = mine.tokens.filter((t) => t.id !== token.id);
          }).then(() => openBoardSetup(board, "agents"));
        },
      );
    });

    actions.append(copyBtn, testBtn, remove);
    row.appendChild(actions);
    row.appendChild(testResult);
    list.appendChild(row);
  }
}

/** What a refused row's info button says. Refusals are logged as the sentence
 *  the agent was shown, which names the switch. Entries from before that were
 *  logged as a bare code, which is turned into words rather than shown raw. */
function refusalReason(error: string): string {
  if (/\s/.test(error)) return error;
  if (error === "permission_denied") {
    return "Refused because a switch was off. This entry was logged before the reason was kept, so it cannot say which one.";
  }
  if (error === "board_disabled") return "Refused because agent access was switched off for this board.";
  return `Refused (${error}).`;
}

/** Takes the entries rather than fetching them: the live badge needs the same
 *  read, and two reads of the same file would be two answers. */
function renderAgentLog(entries: AgentLogEntry[]): void {
  const list = document.getElementById("kbAgentLogList")!;
  list.replaceChildren();

  if (entries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "kb-agent-empty";
    empty.textContent = "Nothing yet. Anything an agent does to this board is listed here.";
    list.appendChild(empty);
    return;
  }

  for (const entry of entries.slice(0, 100)) {
    const row = document.createElement("div");
    row.className = entry.ok ? "kb-agent-log-row" : "kb-agent-log-row kb-agent-log-refused";

    const when = document.createElement("span");
    when.className = "kb-agent-log-when";
    const at = new Date(entry.at);
    when.textContent = Number.isNaN(at.getTime()) ? entry.at : at.toLocaleString();

    // The status sits before what was asked, at a fixed width, so the requests
    // line up down the list and a run of refusals reads as a column.
    const outcome = document.createElement("span");
    outcome.className = entry.ok
      ? "kb-agent-log-outcome kb-agent-log-passed"
      : "kb-agent-log-outcome";
    outcome.textContent = entry.ok ? "Passed" : "Refused";

    const what = document.createElement("span");
    what.className = "kb-agent-log-what";
    what.textContent = `${entry.agent}: ${opLabel(entry.op)}`;

    row.append(when, outcome, what);

    // Why it was refused, on click at the far right, rather than a hover title
    // nobody finds. The sentence names the switch that would have allowed it.
    if (!entry.ok && entry.error) {
      const reason = refusalReason(entry.error);
      const info = document.createElement("button");
      info.type = "button";
      info.className = "info-trigger-btn kb-info-btn kb-agent-log-info";
      info.textContent = "ℹ";
      info.title = "Why was this refused?";
      info.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleInfoTooltip(info, reason, "kb-info-tooltip");
      });
      row.appendChild(info);
    }
    list.appendChild(row);
  }
}

/** The same success/failure toast the rest of the app uses for a clipboard
 *  write. */
async function copyAgentText(
  text: string,
  what: string,
  next = "Paste it into your AI agent's config.",
): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    flash(`${what} copied. ${next}`, "success", 5000);
  } catch {
    flash("Couldn't reach the clipboard", "error");
  }
}

/** The summary and kill switch on the tool's own Setup > Data tab. */
export async function renderAgentGlobalRow(): Promise<void> {
  const summary = document.getElementById("kbAgentGlobalSummary")!;
  const button = document.getElementById("kbAgentGlobalOffBtn") as HTMLButtonElement;
  const config = await loadAgentConfig();
  const on = Object.entries(config.boards).filter(([, board]) => board.enabled);

  if (!config.enabled) {
    summary.textContent =
      on.length > 0 ? `Off everywhere (${on.length} board(s) set up)` : "Off everywhere";
    button.textContent = "Turn Back On";
    button.className = "settings-action-btn";
  } else if (on.length === 0) {
    summary.textContent = "No boards are open to an agent";
    button.textContent = "Turn Off Everywhere";
    button.className = "danger-btn";
  } else {
    summary.textContent = `${on.length} board${on.length === 1 ? "" : "s"} open to an agent`;
    button.textContent = "Turn Off Everywhere";
    button.className = "danger-btn";
  }
  button.disabled = config.enabled && on.length === 0;
}

function wireAgentGlobalRow(): void {
  document.getElementById("kbAgentGlobalOffBtn")!.addEventListener("click", () => {
    void (async () => {
      const config = await loadAgentConfig();
      if (config.enabled) {
        kbConfirm(
          {
            title: "Turn off agent access?",
            message:
              "Every agent request is refused, on every board, from now. Each board keeps its " +
              "own settings, so turning this back on restores exactly what was allowed before.",
            confirmLabel: "Turn Off",
            reopen: () => openSetupOnTab("data"),
          },
          () => {
            void (async () => {
              config.enabled = false;
              await saveAgentConfig(config);
              flash("Agent access is off for every board.", "success");
              openSetupOnTab("data");
            })();
          },
        );
        return;
      }
      config.enabled = true;
      await saveAgentConfig(config);
      flash("Agent access is on again.", "success");
      await renderAgentGlobalRow();
    })();
  });
}

/** The board the Customize modal is showing, handed to it by the Customize
 *  button.
 *
 *  NOT read from boardEditId. Board Setup steps aside with a handoff when this
 *  modal opens, and its onClosed runs a moment later and clears boardEditId. So
 *  everything in this modal that asked boardEditId which board it was on got
 *  null: Back went nowhere, Turn All Off did nothing, and a switch flipped here
 *  saved without redrawing. */
let agentPermBoardId: string | null = null;

/** The board the Agents screens are about: Board Setup's while it is open, or
 *  the Customize modal's while that is. */
function agentBoard(): Board | null {
  return getBoard(boardEditId) ?? getBoard(agentPermBoardId);
}

/** The Customize modal. Built once, on first use, like the rest of this tool's
 *  modals, so a board that never opens it never pays for it. */
function agentPermModal(): Modal {
  if (_agentPermModal) return _agentPermModal;

  _agentPermModal = new Modal(document.getElementById("kbAgentPermBackdrop")!, {
    closeOnEsc: true,
    onClosed: () => {
      agentPermBoardId = null;
    },
  });

  const back = () => {
    const board = getBoard(agentPermBoardId);
    _agentPermModal!.close();
    if (board) openBoardSetup(board, "agents");
  };
  document.getElementById("kbAgentPermBack")!.addEventListener("click", back);
  document
    .getElementById("kbAgentPermClose")!
    .addEventListener("click", () => _agentPermModal!.close());

  return _agentPermModal;
}

export function wireAgentsTab(): void {
  const toggle = document.getElementById("kbAgentEnabledToggle") as HTMLInputElement;
  toggle.addEventListener("change", () => {
    const board = getBoard(boardEditId);
    if (!board) return;
    void commitAgentConfig((config) => {
      const mine = agentBoardConfig(config, board.id);
      mine.enabled = toggle.checked;
      /* Switching a board on switches the app-wide gate on with it. The
         alternative is a user who ticks the board, copies the connection, and
         is refused by a second switch they were never shown. The app-wide one
         exists to turn everything off at once, which is a thing you go looking
         for; it is not a thing to have to find first. */
      if (toggle.checked) config.enabled = true;
      // A board switched on for the first time gets a connection straight away,
      // because a board with permissions and no connection cannot be used and
      // the next step would always have been this button.
      if (toggle.checked && mine.tokens.length === 0) {
        mine.tokens.push(newConnection("Claude Code"));
      }
    });
  });

  document.getElementById("kbAgentCopyModeSelect")!.addEventListener("change", (e) => {
    agentCopyMode = (e.target as HTMLSelectElement).value as AgentCopyMode;
    void renderAgentsTab();
  });

  document.getElementById("kbAgentMasterOnBtn")!.addEventListener("click", () => {
    void commitAgentConfig((config) => {
      config.enabled = true;
    });
  });

  /* Customize hands off the way every other one in the app does: the setup
     modal steps aside rather than stacking, and Back brings it and its scroll
     position back on the Agents tab. */
  document.getElementById("kbAgentPermEditBtn")!.addEventListener("click", () => {
    const board = getBoard(boardEditId);
    if (!board) return;
    agentPermBoardId = board.id;
    getBoardSetupModal().close({ handoff: true });
    agentPermModal().open();
  });

  // Lives in the Customize modal, where boardEditId has already been cleared.
  document.getElementById("kbAgentAllOffBtn")!.addEventListener("click", () => {
    const board = agentBoard();
    if (!board) return;
    void commitAgentConfig((config) => {
      const mine = agentBoardConfig(config, board.id);
      for (const permission of AGENT_PERMISSIONS) mine.permissions[permission.id] = false;
    });
  });

  document.getElementById("kbAgentNewConnectionBtn")!.addEventListener("click", () => {
    const board = getBoard(boardEditId);
    if (!board) return;
    void commitAgentConfig((config) => {
      const mine = agentBoardConfig(config, board.id);
      mine.tokens.push(newConnection(`Agent ${mine.tokens.length + 1}`));
    });
  });

  document.getElementById("kbAgentLogRefreshBtn")!.addEventListener("click", () => {
    void renderAgentsTab();
  });

  document.getElementById("kbAgentLogClearBtn")!.addEventListener("click", () => {
    const board = getBoard(boardEditId);
    if (!board) return;
    kbConfirm(
      {
        title: "Clear the activity list?",
        message:
          "The record of what agents have done is deleted, for every board. Nothing on the " +
          "board itself changes.",
        confirmLabel: "Clear",
        reopen: () => openBoardSetup(board, "agents"),
      },
      () => {
        void (async () => {
          await clearAgentLog();
          openBoardSetup(board, "agents");
        })();
      },
    );
  });

  wireAgentGlobalRow();
}

/** Forgets a deleted board's agent settings.
 *
 *  Not tidiness: the board id is gone, but its TOKENS are still valid keys in a
 *  file the back end reads on every request. Leaving them behind means a live
 *  connection pointing at nothing, which fails with "that board no longer
 *  exists" rather than being refused outright. */
export function forgetAgentAccess(boardId: string): void {
  void (async () => {
    try {
      const config = await loadAgentConfig();
      if (!config.boards[boardId]) return;
      delete config.boards[boardId];
      await saveAgentConfig(config);
    } catch (err) {
      devError("[kanban] could not clear agent access for a deleted board", err);
    }
  })();
}


