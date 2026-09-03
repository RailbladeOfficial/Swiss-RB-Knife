/* =============================================================================
   AGENT GATE: the door a local AI agent knocks on
   -----------------------------------------------------------------------------
   WHAT THIS IS. A named-pipe server that lets an AI coding agent running on
   this machine (Claude Code, Cursor, anything that speaks MCP) ask this app to
   read or change ONE Kanban board, and be refused when the board's settings say
   no.

   Nothing here reaches the network. A named pipe is a local kernel object; the
   app opens no socket, binds no port, and needs no firewall rule.

   THE SHAPE OF THE WHOLE THING, since this file is only the middle of it:

     srbk-agent.exe          the sidecar the agent spawns. Speaks MCP on its
     (not elevated)          stdin/stdout, speaks the framing below on the pipe.
            |                Holds no rules and no data. See src-tauri/agent/.
            v
     THIS FILE               authenticates the token, resolves which board it
     (elevated, with          names, checks that board's permissions, writes the
      the rest of the app)    audit line, and hands the operation to the front
            |                 end. A request refused here never reaches it.
            v
     kanban.ts               performs the operation with the real board model,
                             applies the checks that need the record itself
                             (who created this card), and replies.

   WHY THE FRONT END DOES THE WORK. The Kanban data model lives in TypeScript.
   Rust stores board files as opaque JSON and has no idea what a card is. Doing
   the mutation here would mean a second copy of card numbering, ordering,
   stamping and normalization, and the app already holds every board in memory
   and writes boards whole, so a write from here would be destroyed by the front
   end's next save. Splitting it this way keeps one copy of the model and puts
   the agent's card on screen the moment it is created.

   WHY THE PERMISSION CHECK IS STILL HERE. It is the half that can be decided
   from the request alone (is this token known, which board is it for, is this
   operation allowed at all), and deciding it before the front end is involved
   means a revoked token cannot reach the board even if the front end is wedged.
   The config file is re-read on EVERY request, so switching a permission off
   takes effect on the next call rather than at the next restart.

   THE ELEVATION PROBLEM, which is the reason for the Win32 in here. This app
   ships with a requireAdministrator manifest, so it runs at high integrity. The
   agent runs at medium. A kernel object created by a high-integrity process
   carries that level, and Windows forbids writing up, so a pipe created with
   the default security descriptor would refuse every connection the agent made
   with "Access is denied" and no explanation anywhere. The descriptor built in
   pipe_security() fixes that, and while it is being built it also makes the
   pipe TIGHTER than the default, which would have admitted Administrators and
   SYSTEM as well: the only thing that may open it is the user account running
   this app.

   Rust commands exposed:
     kanban_agent_reply, kanban_agent_status, kanban_agent_test_connection,
     read_kanban_agent_log, clear_kanban_agent_log
============================================================================= */

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::{atomic_write, get_data_path};

/* =============================================================================
   NAMES AND LIMITS
============================================================================= */

/// The agent configuration: which boards are open to an agent, what each one
/// allows, and the tokens that name them. Written by the front end through the
/// tool-file store, read here on every request.
const CONFIG_FILE: &str = "kanban/kanban-agents.json";

/// The board list, read here for one thing only: a board's NAME, so the sidecar
/// can tell the agent it is working on "Release 0.7" rather than on a uuid.
const INDEX_FILE: &str = "kanban/kanban-index.json";

/// What the agent did, one JSON object per line. See append_log.
const LOG_FILE: &str = "kanban/kanban-agent-log.jsonl";

/// Lines kept in the log. Enough to answer "what did it do while I was out",
/// small enough that the Agents tab can read the whole thing without thinking
/// about it.
const LOG_MAX_LINES: usize = 500;

/// Rewrite the log down to LOG_MAX_LINES once it passes this. Checked on size
/// rather than by counting lines, because the size is a stat call and the count
/// is a read of the whole file.
const LOG_TRIM_BYTES: u64 = 256 * 1024;

/// Ceiling on one request. A request is a card's worth of text, not a file.
const MAX_REQUEST_BYTES: u32 = 1024 * 1024;

/// Ceiling on one response. A board with a thousand long descriptions is the
/// case this has to fit, and it does, several times over.
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

/// How long the front end has to answer before the request is failed. Generous:
/// the front end may be mid-render on a large board, and an agent waiting two
/// seconds longer is better than an agent told a card failed that then appears.
const FRONTEND_TIMEOUT: Duration = Duration::from_secs(20);

/// Pipe instances created up front. Each one is a connection that can be
/// accepted without waiting for another to finish, so several agents (or
/// several tools in one agent) do not serialize on the accept itself. The
/// HANDLING is still serialized; see GATE_LOCK.
const PIPE_INSTANCES: u32 = 4;

/// The pipe's name, which the sidecar is told rather than left to work out.
///
/// The DEV SUFFIX is not cosmetic: a dev build and an installed build run at
/// the same time otherwise fight over one name, and an agent pointed at the
/// installed app would silently be answered by whichever one won the race.
pub fn pipe_name() -> String {
    #[cfg(debug_assertions)]
    {
        "\\\\.\\pipe\\swiss-rb-knife.agent.dev".to_string()
    }
    #[cfg(not(debug_assertions))]
    {
        "\\\\.\\pipe\\swiss-rb-knife.agent".to_string()
    }
}

/* =============================================================================
   THE CONFIGURATION FILE
   -----------------------------------------------------------------------------
   Every field carries a default, and a file that will not parse at all denies
   everything rather than allowing anything. Both point the same way: the safe
   answer to "I cannot tell what this says" is no.
============================================================================= */

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    /// The master switch, in the tool's own Setup. Off here means off for every
    /// board regardless of what the boards say.
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub boards: HashMap<String, BoardAgentConfig>,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardAgentConfig {
    #[serde(default)]
    pub enabled: bool,
    /// Permission id to on/off. An id that is not in the map is OFF: a
    /// permission added in a later version is not silently granted to a config
    /// written before it existed.
    #[serde(default)]
    pub permissions: HashMap<String, bool>,
    #[serde(default)]
    pub tokens: Vec<AgentToken>,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentToken {
    /// Stable for the life of the connection, and NOT the secret. Card
    /// ownership is recorded against this, so regenerating the secret does not
    /// make an agent a stranger to the cards it created.
    pub id: String,
    pub label: String,
    pub token: String,
}

fn load_config(app: &AppHandle) -> AgentConfig {
    match fs::read_to_string(get_data_path(app, CONFIG_FILE)) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => AgentConfig::default(),
    }
}

/// The board's display name, from the index. Falls back to the id, which is
/// still better than an error: a nameless board is a cosmetic problem.
fn board_name(app: &AppHandle, board_id: &str) -> String {
    let fallback = || board_id.to_string();
    let Ok(text) = fs::read_to_string(get_data_path(app, INDEX_FILE)) else {
        return fallback();
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return fallback();
    };
    value
        .get("boards")
        .and_then(Value::as_array)
        .and_then(|boards| {
            boards.iter().find(|b| b.get("id").and_then(Value::as_str) == Some(board_id))
        })
        .and_then(|b| b.get("name").and_then(Value::as_str))
        .map(str::to_string)
        .unwrap_or_else(fallback)
}

/* =============================================================================
   OPERATIONS AND WHAT EACH ONE COSTS
   -----------------------------------------------------------------------------
   ONE TABLE. An operation the sidecar can name but that is missing from here is
   refused, so adding a tool to the sidecar without deciding what it costs is a
   rejection rather than a hole.

   `permission` is what the request alone can be judged against, and is checked
   in this file. `owned` marks the operations that also need to know WHO created
   the record they name, which only the front end can answer; those carry the
   ownership rule described in kanban.ts's executor.

   The labels are the exact wording of the switches in the Agents tab, because
   they are what a refusal quotes back to the agent. A refusal that names a
   switch the user cannot find is a bad refusal.
============================================================================= */

struct OpSpec {
    op: &'static str,
    /// ANY ONE of these is enough. Empty means reading, which enabling agent
    /// access for the board grants on its own.
    ///
    /// Alternatives exist for one real case: editing a card is allowed by
    /// "Edit cards it created" OR by "Edit cards created by anyone else", and a
    /// user who granted only the second would otherwise be refused here before
    /// the front end ever got to check whose card it is.
    permissions: &'static [&'static str],
    /// Also subject to the "created by anyone else" rule, in the front end.
    owned: bool,
}

const OPS: &[OpSpec] = &[
    // Reading. Granted by enabling the board at all: a connection that cannot
    // read the board cannot do anything useful with permission to write to it.
    OpSpec { op: "capabilities", permissions: &[], owned: false },
    OpSpec { op: "get_board", permissions: &[], owned: false },
    OpSpec { op: "list_cards", permissions: &[], owned: false },
    OpSpec { op: "get_card", permissions: &[], owned: false },
    // Writing.
    OpSpec { op: "create_card", permissions: &["createCard"], owned: false },
    OpSpec { op: "update_card", permissions: &["editCard", "editOthersCards"], owned: true },
    OpSpec { op: "move_card", permissions: &["moveCard"], owned: true },
    OpSpec { op: "set_card_dates", permissions: &["setDates"], owned: true },
    OpSpec { op: "archive_card", permissions: &["archiveCard"], owned: true },
    OpSpec { op: "delete_card", permissions: &["deleteCard"], owned: true },
    OpSpec { op: "add_comment", permissions: &["createComment"], owned: false },
    OpSpec { op: "delete_comment", permissions: &["deleteComment"], owned: true },
    OpSpec { op: "add_subtask", permissions: &["manageSubtasks"], owned: true },
    OpSpec { op: "set_subtask", permissions: &["manageSubtasks"], owned: true },
    OpSpec { op: "remove_subtask", permissions: &["manageSubtasks"], owned: true },
    OpSpec { op: "set_card_tags", permissions: &["assignTags"], owned: true },
    OpSpec { op: "create_tag", permissions: &["createTags"], owned: false },
    OpSpec { op: "create_column", permissions: &["manageColumns"], owned: false },
    OpSpec { op: "update_column", permissions: &["manageColumns"], owned: false },
    OpSpec { op: "move_column", permissions: &["manageColumns"], owned: false },
];

/// The switch labels, matching the Agents tab word for word. Kept beside OPS so
/// a new permission is one row in each rather than a search of the file.
const PERMISSION_LABELS: &[(&str, &str)] = &[
    ("createCard", "Create cards"),
    ("editCard", "Edit cards it created"),
    ("editOthersCards", "Edit cards created by anyone else"),
    ("moveCard", "Move cards between columns"),
    ("setDates", "Set due and stage dates"),
    ("archiveCard", "Archive cards"),
    ("deleteCard", "Delete cards"),
    ("createComment", "Add comments"),
    ("deleteComment", "Delete comments"),
    ("manageSubtasks", "Manage subtasks"),
    ("assignTags", "Assign existing tags"),
    ("createTags", "Create new tags"),
    ("manageColumns", "Add and edit columns"),
];

fn op_spec(op: &str) -> Option<&'static OpSpec> {
    OPS.iter().find(|spec| spec.op == op)
}

fn permission_label(id: &str) -> &str {
    PERMISSION_LABELS
        .iter()
        .find(|(key, _)| *key == id)
        .map(|(_, label)| *label)
        .unwrap_or(id)
}

/// Every permission id, for the front end to render switches from and for the
/// check that the two lists agree.
pub fn permission_ids() -> Vec<&'static str> {
    PERMISSION_LABELS.iter().map(|(id, _)| *id).collect()
}

/* =============================================================================
   THE WIRE
   -----------------------------------------------------------------------------
   Four bytes of little-endian length, then that many bytes of JSON. Both ways.

   A length prefix rather than a message-mode pipe, because it makes the CLIENT
   side of this ordinary file I/O: the sidecar opens the pipe with std, reads
   and writes with std, and contains no Win32 and no unsafe at all.
============================================================================= */

#[derive(Debug, Deserialize)]
struct AgentRequest {
    token: String,
    op: String,
    #[serde(default)]
    params: Value,
}

fn error_response(code: &str, message: String) -> Value {
    json!({ "ok": false, "error": { "code": code, "message": message } })
}

fn ok_response(result: Value) -> Value {
    json!({ "ok": true, "result": result })
}

fn read_frame(stream: &mut fs::File) -> std::io::Result<Vec<u8>> {
    let mut len_bytes = [0u8; 4];
    stream.read_exact(&mut len_bytes)?;
    let len = u32::from_le_bytes(len_bytes);
    if len > MAX_REQUEST_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "request too large",
        ));
    }
    let mut buf = vec![0u8; len as usize];
    stream.read_exact(&mut buf)?;
    Ok(buf)
}

fn write_frame(stream: &mut fs::File, bytes: &[u8]) -> std::io::Result<()> {
    if bytes.len() > MAX_RESPONSE_BYTES {
        // Replaced rather than truncated: half a JSON document is worse than an
        // error, because the agent would try to parse it.
        let replacement = serde_json::to_vec(&error_response(
            "response_too_large",
            "The result was too large to return. Ask for fewer cards at a time.".to_string(),
        ))
        .unwrap_or_default();
        stream.write_all(&(replacement.len() as u32).to_le_bytes())?;
        stream.write_all(&replacement)?;
        return stream.flush();
    }
    stream.write_all(&(bytes.len() as u32).to_le_bytes())?;
    stream.write_all(bytes)?;
    stream.flush()
}

/* =============================================================================
   THE GATE
============================================================================= */

/// Handling is serialized. Two agents editing one board at the same moment is
/// not a case worth supporting, and letting requests interleave through the
/// front end's in-memory model is a way to lose one of them.
static GATE_LOCK: Mutex<()> = Mutex::new(());

/// Set once the pipe is up. The Agents tab reads it, so a pipe that failed to
/// open is reported on screen rather than discovered as an agent that cannot
/// connect for reasons nobody can see.
/// Keeps the test button from flashing a console window on screen.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

static LISTENING: AtomicBool = AtomicBool::new(false);

/// Why it is not listening, when it is not. Empty while all is well.
static LISTEN_ERROR: OnceLock<Mutex<String>> = OnceLock::new();

fn set_listen_error(message: &str) {
    let slot = LISTEN_ERROR.get_or_init(|| Mutex::new(String::new()));
    if let Ok(mut guard) = slot.lock() {
        *guard = message.to_string();
    }
}

fn listen_error() -> String {
    LISTEN_ERROR
        .get()
        .and_then(|slot| slot.lock().ok().map(|g| g.clone()))
        .unwrap_or_default()
}

/// Answers waiting to come back from the front end, keyed by request id.
static PENDING: OnceLock<Mutex<HashMap<u64, Sender<Result<Value, String>>>>> = OnceLock::new();
static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);

fn pending() -> &'static Mutex<HashMap<u64, Sender<Result<Value, String>>>> {
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// What a request is allowed to do, once the config has answered.
struct Authorized<'a> {
    board_id: &'a str,
    token: &'a AgentToken,
    board: &'a BoardAgentConfig,
    spec: &'static OpSpec,
    /// The board's display name, resolved while deciding because every refusal
    /// below quotes it.
    name: String,
}

/// A refusal, with the code the sidecar reports and the sentence the agent is
/// shown. `logged` marks the ones worth a line in the activity list: a refusal
/// about a token nobody recognizes has no board to file it under.
struct Refusal {
    code: &'static str,
    message: String,
    logged: bool,
}

/// THE PERMISSION DECISION, and the reason it is a function of its arguments
/// rather than a walk through app state: it is the part that must not be wrong,
/// and this shape is what lets it be tested against a config rather than
/// against a running app. handle_request does the file reads and the logging
/// around it.
///
/// `name_of` resolves a board id to its display name. Taken as a closure
/// because the id is not known until the token has been matched, and every
/// refusal from that point on quotes the name.
fn authorize<'a>(
    config: &'a AgentConfig,
    secret: &str,
    op: &str,
    name_of: impl Fn(&str) -> String,
) -> Result<Authorized<'a>, Refusal> {
    if !config.enabled {
        return Err(Refusal {
            code: "access_disabled",
            message: "Agent access is switched off for this app. Turn it on in Swiss RB Knife: \
                      Kanban > Setup > Agents."
                .to_string(),
            logged: false,
        });
    }

    // The token names the board. Nothing in the request does, which is what
    // stops an agent asking for a board it was never given.
    let Some((board_id, token)) = find_token(config, secret) else {
        return Err(Refusal {
            code: "unknown_token",
            message: "This connection is not recognized. It may have been revoked. Copy a new \
                      connection from Swiss RB Knife: Kanban > the board > Setup > Agents."
                .to_string(),
            logged: false,
        });
    };

    let name = name_of(board_id);
    let board = match config.boards.get(board_id) {
        Some(board) if board.enabled => board,
        _ => {
            return Err(Refusal {
                code: "board_disabled",
                message: format!(
                    "Agent access is switched off for the board \"{name}\". Turn it on in \
                     Swiss RB Knife: Kanban > {name} > Setup > Agents."
                ),
                logged: true,
            })
        }
    };

    let Some(spec) = op_spec(op) else {
        return Err(Refusal {
            code: "unknown_operation",
            message: format!("\"{op}\" is not an operation this board understands."),
            logged: false,
        });
    };

    if !spec.permissions.is_empty() {
        let granted = spec
            .permissions
            .iter()
            .any(|id| board.permissions.get(*id).copied().unwrap_or(false));
        if !granted {
            // Named after the FIRST alternative, which is always the ordinary
            // one. The front end names the other where it matters.
            let label = permission_label(spec.permissions[0]);
            return Err(Refusal {
                code: "permission_denied",
                message: format!(
                    "Permission denied. \"{label}\" is not allowed on the board \"{name}\". \
                     To allow it: Swiss RB Knife > Kanban > {name} > Setup > Agents > \"{label}\"."
                ),
                logged: true,
            });
        }
    }

    Ok(Authorized { board_id, token, board, spec, name })
}

/// The whole decision, for one request. Returns the JSON to send back.
fn handle_request(app: &AppHandle, raw: &[u8]) -> Value {
    let request: AgentRequest = match serde_json::from_slice(raw) {
        Ok(request) => request,
        Err(err) => {
            return error_response("bad_request", format!("The request was not valid JSON: {err}"))
        }
    };

    let config = load_config(app);
    let allowed = match authorize(&config, &request.token, &request.op, |id| board_name(app, id)) {
        Ok(allowed) => allowed,
        Err(refusal) => {
            if refusal.logged {
                // Filed under the board it was about. The unlogged refusals are
                // the ones with no board to file them under.
                if let Some((board_id, token)) = find_token(&config, &request.token) {
                    append_log(app, board_id, &token.label, &request.op, false, refusal.code);
                }
            }
            return error_response(refusal.code, refusal.message);
        }
    };

    // Answered here rather than by the front end, so an agent starting up while
    // the app is still loading its boards still learns what it may do.
    if request.op == "capabilities" {
        let permissions: HashMap<&str, bool> = PERMISSION_LABELS
            .iter()
            .map(|(id, _)| (*id, allowed.board.permissions.get(*id).copied().unwrap_or(false)))
            .collect();
        return ok_response(json!({
            "board": { "id": allowed.board_id, "name": allowed.name },
            "connection": { "id": allowed.token.id, "label": allowed.token.label },
            "permissions": permissions,
            "appVersion": env!("CARGO_PKG_VERSION"),
        }));
    }

    // Everything else is the front end's to perform. It is handed the board,
    // the connection and the permission set that was just read from disk, so it
    // cannot act on a stale copy of any of the three.
    let payload = json!({
        "boardId": allowed.board_id,
        "connectionId": allowed.token.id,
        "connectionLabel": allowed.token.label,
        "op": request.op,
        "params": request.params,
        "permissions": allowed.board.permissions,
        "ownershipChecked": allowed.spec.owned,
    });

    match ask_frontend(app, payload) {
        Ok(result) => {
            append_log(app, allowed.board_id, &allowed.token.label, &request.op, true, "");
            ok_response(result)
        }
        Err(message) => {
            // The front end reports its own refusals (a card created by someone
            // else, a card open on screen) as errors, and they are logged the
            // same way a refusal here is.
            append_log(
                app,
                allowed.board_id,
                &allowed.token.label,
                &request.op,
                false,
                &message,
            );
            error_response("rejected", message)
        }
    }
}

fn find_token<'a>(config: &'a AgentConfig, secret: &str) -> Option<(&'a String, &'a AgentToken)> {
    if secret.is_empty() {
        return None;
    }
    for (board_id, board) in &config.boards {
        for token in &board.tokens {
            if !token.token.is_empty() && token.token == secret {
                return Some((board_id, token));
            }
        }
    }
    None
}

/// Hands one operation to the front end and waits for its answer.
fn ask_frontend(app: &AppHandle, mut payload: Value) -> Result<Value, String> {
    let id = NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed);
    payload["id"] = json!(id);

    let (tx, rx) = channel();
    match pending().lock() {
        Ok(mut map) => {
            map.insert(id, tx);
        }
        Err(_) => return Err("The app is in a bad state and cannot answer.".to_string()),
    }

    if app.emit("kanban-agent-request", &payload).is_err() {
        if let Ok(mut map) = pending().lock() {
            map.remove(&id);
        }
        return Err("Swiss RB Knife could not be reached.".to_string());
    }

    let answer = rx.recv_timeout(FRONTEND_TIMEOUT);
    if let Ok(mut map) = pending().lock() {
        map.remove(&id);
    }

    match answer {
        Ok(Ok(result)) => Ok(result),
        Ok(Err(message)) => Err(message),
        Err(_) => Err(
            "Swiss RB Knife did not answer in time. It may be busy or still loading its boards. \
             Try again in a moment."
                .to_string(),
        ),
    }
}

/// The front end's answer to one request. Named by id, so a late answer to a
/// request that already timed out is dropped rather than handed to whoever is
/// waiting next.
#[tauri::command]
pub fn kanban_agent_reply(id: u64, ok: bool, result: Option<Value>, error: Option<String>) {
    let sender = match pending().lock() {
        Ok(mut map) => map.remove(&id),
        Err(_) => None,
    };
    let Some(sender) = sender else { return };
    let message = if ok {
        Ok(result.unwrap_or(Value::Null))
    } else {
        Err(error.unwrap_or_else(|| "The operation failed.".to_string()))
    };
    let _ = sender.send(message);
}

/* =============================================================================
   THE AUDIT LOG
   -----------------------------------------------------------------------------
   One JSON object per line, appended. This is the answer to "what did it do
   while I was not looking", which is the question that makes handing an agent
   write access reasonable in the first place.

   APPENDED rather than written through atomic_write, which is the house rule
   everywhere else. The rule exists because the installer force-terminates the
   app mid-write and a truncated rewrite loses the old contents; an append of
   one line cannot truncate anything, and the worst a kill mid-append can leave
   is a partial last line, which the reader skips. The rewrite that TRIMS the
   file is a real rewrite and does go through atomic_write.
============================================================================= */

fn append_log(app: &AppHandle, board_id: &str, label: &str, op: &str, ok: bool, error: &str) {
    let line = json!({
        "at": chrono::Local::now().to_rfc3339(),
        "boardId": board_id,
        "agent": label,
        "op": op,
        "ok": ok,
        "error": if error.is_empty() { Value::Null } else { json!(error) },
    });
    let Ok(mut text) = serde_json::to_string(&line) else { return };
    text.push('\n');

    let path = get_data_path(app, LOG_FILE);
    let appended = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut file| file.write_all(text.as_bytes()));
    if appended.is_err() {
        return;
    }

    if fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > LOG_TRIM_BYTES {
        trim_log(&path);
    }
}

fn trim_log(path: &std::path::Path) {
    let Ok(text) = fs::read_to_string(path) else { return };
    let lines: Vec<&str> = text.lines().collect();
    if lines.len() <= LOG_MAX_LINES {
        return;
    }
    let kept = lines[lines.len() - LOG_MAX_LINES..].join("\n");
    let _ = atomic_write(path, format!("{kept}\n").as_bytes());
}

/// The log, newest first, capped. Read by the Agents tab.
#[tauri::command]
pub fn read_kanban_agent_log(app: AppHandle, limit: Option<usize>) -> Result<Vec<Value>, String> {
    let path = get_data_path(&app, LOG_FILE);
    let Ok(text) = fs::read_to_string(path) else {
        return Ok(Vec::new());
    };
    let limit = limit.unwrap_or(LOG_MAX_LINES).min(LOG_MAX_LINES);
    Ok(text
        .lines()
        .rev()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .take(limit)
        .collect())
}

#[tauri::command]
pub fn clear_kanban_agent_log(app: AppHandle) -> Result<(), String> {
    let path = get_data_path(&app, LOG_FILE);
    if path.exists() {
        atomic_write(&path, b"")?;
    }
    Ok(())
}

/* =============================================================================
   WHAT THE AGENTS TAB NEEDS TO KNOW
============================================================================= */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    pub listening: bool,
    pub error: String,
    pub pipe_name: String,
    pub sidecar_path: String,
    pub sidecar_found: bool,
    pub permission_ids: Vec<&'static str>,
}

#[tauri::command]
pub fn kanban_agent_status(app: AppHandle) -> AgentStatus {
    let sidecar = sidecar_path(&app);
    AgentStatus {
        listening: LISTENING.load(Ordering::Relaxed),
        error: listen_error(),
        pipe_name: pipe_name(),
        sidecar_found: sidecar.as_ref().map(|p| p.exists()).unwrap_or(false),
        sidecar_path: sidecar.map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
        permission_ids: permission_ids(),
    }
}

/// Where srbk-agent.exe is, which is the one thing the copied connection block
/// cannot guess: the installer is per-machine but the user may have chosen a
/// different folder, and a dev build has it somewhere else entirely.
fn sidecar_path(_app: &AppHandle) -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;

    // Release: the sidecar sits beside the app, put there by the installer.
    let beside = dir.join("srbk-agent.exe");
    if beside.exists() {
        return Some(beside);
    }

    // Dev: cargo puts both binaries in the same target folder anyway, so the
    // line above usually finds it. This is the fallback for a dev run started
    // from somewhere unusual.
    #[cfg(debug_assertions)]
    {
        let candidate = dir.join("../../target/debug/srbk-agent.exe");
        if candidate.exists() {
            return fs::canonicalize(candidate).ok();
        }
    }

    Some(beside)
}

/* =============================================================================
   THE TEST BUTTON
   -----------------------------------------------------------------------------
   The honest answer to "is this actually hooked up", which the status badge
   cannot give. The badge says this app is listening. It cannot say whether the
   sidecar runs, whether antivirus ate it, or whether a token still works.

   SO IT RUNS THE REAL BINARY. `srbk-agent capabilities` is the same program an
   agent launches, taking the same pipe and the same token, so a pass here means
   the whole path works and a failure names the part that does not. Testing by
   opening the pipe from in here would prove less and skip the two things that
   actually break.
============================================================================= */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTestResult {
    pub ok: bool,
    /// One line, for the badge beside the button.
    pub summary: String,
    /// What the sidecar printed, for when the one line is not enough.
    pub detail: String,
}

fn test_failed(summary: &str, detail: String) -> AgentTestResult {
    AgentTestResult { ok: false, summary: summary.to_string(), detail }
}

/// ASYNC ON PURPOSE. The request the sidecar makes is answered by the front
/// end, so a blocking command would deadlock: the front end would sit waiting
/// on this call while this call sat waiting on the front end. Tauri runs an
/// async command on a worker thread, which leaves the front end free to answer
/// the request this very function provokes.
#[tauri::command]
pub async fn kanban_agent_test_connection(app: AppHandle, token: String) -> AgentTestResult {
    if !LISTENING.load(Ordering::Relaxed) {
        let why = listen_error();
        return test_failed(
            "Not accepting connections",
            if why.is_empty() { "The pipe is not open.".to_string() } else { why },
        );
    }

    let Some(sidecar) = sidecar_path(&app) else {
        return test_failed("srbk-agent.exe is missing", String::new());
    };
    if !sidecar.exists() {
        return test_failed(
            "srbk-agent.exe is missing",
            format!("Looked for it at {}", sidecar.display()),
        );
    }

    let mut command = Command::new(&sidecar);
    command
        .arg("capabilities")
        .env("SRBK_AGENT_TOKEN", &token)
        .env("SRBK_AGENT_PIPE", pipe_name())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let output = match command.output() {
        Ok(output) => output,
        Err(err) => {
            // The usual cause is antivirus, because the sidecar is unsigned.
            return test_failed(
                "Could not start srbk-agent.exe",
                format!("{err}\n\nAt {}", sidecar.display()),
            );
        }
    };

    let out = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let err = String::from_utf8_lossy(&output.stderr).trim().to_string();

    if output.status.success() {
        AgentTestResult { ok: true, summary: "Connection works".to_string(), detail: out }
    } else {
        test_failed(
            "The agent could not reach this board",
            if err.is_empty() { out } else { err },
        )
    }
}

/* =============================================================================
   THE PIPE
   -----------------------------------------------------------------------------
   Everything below is Win32. See the header for why the security descriptor is
   not optional.
============================================================================= */

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{
    CloseHandle, LocalFree, ERROR_PIPE_CONNECTED, HANDLE, HLOCAL, INVALID_HANDLE_VALUE,
};
use windows::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows::Win32::Security::{
    GetTokenInformation, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
    TokenUser,
};
use windows::Win32::Storage::FileSystem::{FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX};
use windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS,
    PIPE_TYPE_BYTE, PIPE_WAIT,
};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// The SID of the account this process runs as, as a string.
///
/// UAC elevation keeps the user's own SID, so this is the same value the
/// agent's (non-elevated) process would produce. It is different only if the
/// app was elevated with a DIFFERENT administrator account, in which case the
/// pipe belongs to that account and the agent will not be able to reach it.
/// That is the correct outcome rather than a bug: the two are different users.
fn current_user_sid() -> Option<String> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).ok()?;

        // Asked twice: once for the size, once for the data. The first call is
        // expected to fail with ERROR_INSUFFICIENT_BUFFER.
        let mut needed = 0u32;
        let _ = GetTokenInformation(token, TokenUser, None, 0, &mut needed);
        if needed == 0 {
            let _ = CloseHandle(token);
            return None;
        }
        let mut buffer = vec![0u8; needed as usize];
        let filled = GetTokenInformation(
            token,
            TokenUser,
            Some(buffer.as_mut_ptr() as *mut _),
            needed,
            &mut needed,
        );
        let _ = CloseHandle(token);
        filled.ok()?;

        let user = &*(buffer.as_ptr() as *const TOKEN_USER);
        let mut raw = PWSTR::null();
        ConvertSidToStringSidW(user.User.Sid, &mut raw).ok()?;
        if raw.is_null() {
            return None;
        }
        let text = raw.to_string().ok();
        let _ = LocalFree(Some(HLOCAL(raw.0 as *mut _)));
        text
    }
}

/// The pipe's security descriptor, which decides who may talk to this app.
///
/// Two clauses, and both matter:
///
///   D:P(A;;GA;;;<user>)   only the account running this app may open the pipe,
///                         and P (protected) stops anything being inherited in
///                         on top of that. This is TIGHTER than the default
///                         descriptor, which would also have admitted the
///                         Administrators group and SYSTEM.
///
///   S:(ML;;NW;;;ME)       the mandatory label, set to medium. Without it the
///                         pipe carries this process's HIGH integrity level and
///                         Windows refuses the write from a medium-integrity
///                         agent, which is every agent, with "Access is denied"
///                         and nothing anywhere saying why.
fn pipe_security() -> Option<(PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES)> {
    let sid = current_user_sid()?;
    let sddl = format!("D:P(A;;GA;;;{sid})S:(ML;;NW;;;ME)");
    let sddl_wide = wide(&sddl);
    unsafe {
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            PCWSTR(sddl_wide.as_ptr()),
            SDDL_REVISION_1,
            &mut descriptor,
            None,
        )
        .ok()?;
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0,
            bInheritHandle: false.into(),
        };
        Some((descriptor, attributes))
    }
}

/// Creates one instance of the pipe.
///
/// `first` asks for FILE_FLAG_FIRST_PIPE_INSTANCE, which fails if the name is
/// already taken. That is how a SECOND copy of the app discovers it should not
/// serve: two servers on one name would answer alternate connections, so an
/// agent would be talking to whichever instance happened to win, which is worse
/// than one of them staying quiet.
fn create_instance(
    pipe: &str,
    attributes: &SECURITY_ATTRIBUTES,
    first: bool,
) -> Result<HANDLE, String> {
    let name = wide(pipe);
    let mut open_mode = PIPE_ACCESS_DUPLEX;
    if first {
        open_mode |= FILE_FLAG_FIRST_PIPE_INSTANCE;
    }
    let handle = unsafe {
        CreateNamedPipeW(
            PCWSTR(name.as_ptr()),
            open_mode,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            PIPE_INSTANCES,
            64 * 1024,
            64 * 1024,
            0,
            Some(attributes as *const _),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(handle)
}

/// Serves one connected pipe instance: read the request, answer it, close.
///
/// The handle is CLOSED rather than disconnected. DisconnectNamedPipe throws
/// away whatever the client has not read yet, so calling it right after writing
/// the response is a race the client loses on a slow read. Closing leaves the
/// written bytes in the pipe for the client to finish reading, and then ends the
/// connection, which is exactly the wanted behavior.
fn serve_connection(app: &AppHandle, handle: HANDLE) {
    let mut stream = unsafe {
        use std::os::windows::io::FromRawHandle;
        fs::File::from_raw_handle(handle.0 as *mut std::ffi::c_void)
    };
    if let Ok(raw) = read_frame(&mut stream) {
        let response = {
            // Serialized: two agents editing one board at the same moment is
            // not worth supporting, and interleaving requests through the front
            // end's in-memory model is a way to lose one of them.
            let _guard = GATE_LOCK.lock();
            handle_request(app, &raw)
        };
        let bytes = serde_json::to_vec(&response).unwrap_or_default();
        let _ = write_frame(&mut stream, &bytes);
    }
    // Dropping the File closes the handle.
}

/// One accept thread: wait for a client on this instance, serve it, then make a
/// fresh instance and wait again.
///
/// A new instance per connection rather than reusing one, because it is the
/// shape with the fewest states to get wrong, and creating one costs
/// microseconds against an operation that costs milliseconds.
fn accept_loop(app: AppHandle, mut handle: HANDLE) {
    let Some((descriptor, attributes)) = pipe_security() else {
        set_listen_error("Could not build the pipe's security settings.");
        unsafe {
            let _ = CloseHandle(handle);
        }
        return;
    };

    loop {
        // ERROR_PIPE_CONNECTED means a client got in between the create and the
        // connect. That is a connected client, not a failure.
        let connected = match unsafe { ConnectNamedPipe(handle, None) } {
            Ok(()) => true,
            Err(err) => err.code().0 as u32 == 0x8007_0000 | ERROR_PIPE_CONNECTED.0,
        };

        if connected {
            serve_connection(&app, handle);
        } else {
            unsafe {
                let _ = CloseHandle(handle);
            }
        }

        handle = match create_instance(&pipe_name(), &attributes, false) {
            Ok(handle) => handle,
            Err(err) => {
                // Every thread that gets here has already served; losing one
                // instance is a smaller thing than reporting the gate as down,
                // so this only speaks up if it is the last one standing.
                if ACCEPT_THREADS.fetch_sub(1, Ordering::Relaxed) <= 1 {
                    LISTENING.store(false, Ordering::Relaxed);
                    set_listen_error(&format!("The agent pipe stopped accepting: {err}"));
                }
                unsafe {
                    let _ = LocalFree(Some(HLOCAL(descriptor.0)));
                }
                return;
            }
        };
    }
}

/// Accept threads still running. Only used to decide who reports a failure.
static ACCEPT_THREADS: AtomicU64 = AtomicU64::new(0);

/// Starts the pipe server. Best effort, like session_watch: a failure here means
/// agent access does not work and the Agents tab says so, never that the app
/// fails to start.
///
/// THE FIRST INSTANCE IS CREATED HERE, on the calling thread, and that ordering
/// is load-bearing. It is the one created with FILE_FLAG_FIRST_PIPE_INSTANCE,
/// which fails if the name is already taken and is therefore how a SECOND copy
/// of the app discovers it should not serve. Created on a worker alongside the
/// others, whichever thread happened to win would claim the name and the real
/// first-instance check would report a collision with itself.
pub fn init(app: &AppHandle) {
    let Some((descriptor, attributes)) = pipe_security() else {
        set_listen_error("Could not build the pipe's security settings.");
        return;
    };

    let first = match create_instance(&pipe_name(), &attributes, true) {
        Ok(handle) => handle,
        Err(err) => {
            // ERROR_ACCESS_DENIED here is the ordinary case of a second copy of
            // the app being open, not a fault worth alarming anyone about.
            set_listen_error(&format!(
                "Agent access is not available: {err} This is expected if another \
                 copy of Swiss RB Knife is already running."
            ));
            unsafe {
                let _ = LocalFree(Some(HLOCAL(descriptor.0)));
            }
            return;
        }
    };
    unsafe {
        let _ = LocalFree(Some(HLOCAL(descriptor.0)));
    }

    LISTENING.store(true, Ordering::Relaxed);
    set_listen_error("");

    let mut handles = vec![first];
    // The rest are created up front so several requests can be accepted without
    // waiting on each other. Falling short is not fatal: one instance serves
    // fine, just one request at a time.
    if let Some((extra_descriptor, extra_attributes)) = pipe_security() {
        for _ in 1..PIPE_INSTANCES {
            match create_instance(&pipe_name(), &extra_attributes, false) {
                Ok(handle) => handles.push(handle),
                Err(_) => break,
            }
        }
        unsafe {
            let _ = LocalFree(Some(HLOCAL(extra_descriptor.0)));
        }
    }

    ACCEPT_THREADS.store(handles.len() as u64, Ordering::Relaxed);
    for handle in handles {
        let app = app.clone();
        // usize rather than the HANDLE itself: a raw pointer is not Send, and
        // the value is just a kernel handle number.
        let raw = handle.0 as usize;
        std::thread::spawn(move || accept_loop(app, HANDLE(raw as *mut std::ffi::c_void)));
    }
}

/* =============================================================================
   TESTS
============================================================================= */

#[cfg(test)]
mod tests {
    use super::*;

    /* -------------------------------------------------------------------------
       THE PERMISSION DECISION

       The part of this feature that must not be wrong. Every one of these is a
       config an ordinary user could arrive at by clicking, checked against the
       answer the gate gives an agent.
    ------------------------------------------------------------------------- */

    /// A board with agent access on and exactly these permissions granted.
    fn config_with(granted: &[&str]) -> AgentConfig {
        let permissions: HashMap<String, bool> =
            granted.iter().map(|id| (id.to_string(), true)).collect();
        let board = BoardAgentConfig {
            enabled: true,
            permissions,
            tokens: vec![AgentToken {
                id: "conn-1".to_string(),
                label: "Claude Code".to_string(),
                token: "srbk1_secret".to_string(),
            }],
        };
        AgentConfig {
            enabled: true,
            boards: HashMap::from([("board-1".to_string(), board)]),
        }
    }

    fn decide(config: &AgentConfig, secret: &str, op: &str) -> Result<String, (String, String)> {
        match authorize(config, secret, op, |_| "Release 0.7".to_string()) {
            Ok(allowed) => Ok(allowed.board_id.to_string()),
            Err(refusal) => Err((refusal.code.to_string(), refusal.message)),
        }
    }

    #[test]
    fn creating_is_allowed_and_deleting_is_refused_when_that_is_what_was_ticked() {
        // The worked example from the request this feature came from: a board
        // that allows creating cards but not deleting them.
        let config = config_with(&["createCard"]);
        assert!(decide(&config, "srbk1_secret", "create_card").is_ok());

        let (code, message) = decide(&config, "srbk1_secret", "delete_card").unwrap_err();
        assert_eq!(code, "permission_denied");
        // The refusal has to name the board and the switch, or the agent cannot
        // tell the user what would fix it.
        assert!(message.contains("Delete cards"), "{message}");
        assert!(message.contains("Release 0.7"), "{message}");
        assert!(message.contains("Setup > Agents"), "{message}");
    }

    #[test]
    fn reading_works_with_nothing_granted_at_all() {
        let config = config_with(&[]);
        for op in ["get_board", "list_cards", "get_card", "capabilities"] {
            assert!(decide(&config, "srbk1_secret", op).is_ok(), "{op} should be readable");
        }
        assert!(decide(&config, "srbk1_secret", "create_card").is_err());
    }

    #[test]
    fn the_app_wide_switch_beats_every_board() {
        let mut config = config_with(&["createCard"]);
        config.enabled = false;
        let (code, message) = decide(&config, "srbk1_secret", "create_card").unwrap_err();
        assert_eq!(code, "access_disabled");
        assert!(message.contains("Setup > Agents"), "{message}");
        // Reading is refused too: the switch is off for everything, not just
        // for writing.
        assert_eq!(decide(&config, "srbk1_secret", "get_board").unwrap_err().0, "access_disabled");
    }

    #[test]
    fn a_board_switched_off_refuses_even_what_it_still_has_ticked() {
        let mut config = config_with(&["createCard", "deleteCard"]);
        config.boards.get_mut("board-1").unwrap().enabled = false;
        let (code, message) = decide(&config, "srbk1_secret", "create_card").unwrap_err();
        assert_eq!(code, "board_disabled");
        assert!(message.contains("Release 0.7"), "{message}");
    }

    #[test]
    fn a_revoked_token_is_not_recognized() {
        let config = config_with(&["createCard"]);
        let (code, _) = decide(&config, "srbk1_someone_elses", "create_card").unwrap_err();
        assert_eq!(code, "unknown_token");
        // And an empty one, which is what an agent started with no token sends.
        assert_eq!(decide(&config, "", "get_board").unwrap_err().0, "unknown_token");
    }

    #[test]
    fn a_token_cannot_reach_a_board_it_was_not_issued_for() {
        let mut config = config_with(&["deleteCard"]);
        let other = BoardAgentConfig {
            enabled: true,
            permissions: HashMap::from([("deleteCard".to_string(), true)]),
            tokens: vec![AgentToken {
                id: "conn-2".to_string(),
                label: "Other".to_string(),
                token: "srbk1_other".to_string(),
            }],
        };
        config.boards.insert("board-2".to_string(), other);

        // Each token resolves to its own board and there is no argument in the
        // request that could say otherwise.
        assert_eq!(decide(&config, "srbk1_secret", "delete_card").unwrap(), "board-1");
        assert_eq!(decide(&config, "srbk1_other", "delete_card").unwrap(), "board-2");
    }

    #[test]
    fn an_operation_nobody_has_heard_of_is_refused() {
        let config = config_with(&["createCard", "deleteCard", "manageColumns"]);
        let (code, _) = decide(&config, "srbk1_secret", "drop_all_boards").unwrap_err();
        assert_eq!(code, "unknown_operation");
    }

    #[test]
    fn either_edit_permission_gets_an_edit_past_the_gate() {
        // Whose card it is gets decided in the front end; the gate must not
        // refuse the request before it can be asked.
        assert!(decide(&config_with(&["editCard"]), "srbk1_secret", "update_card").is_ok());
        assert!(decide(&config_with(&["editOthersCards"]), "srbk1_secret", "update_card").is_ok());
        assert!(decide(&config_with(&["moveCard"]), "srbk1_secret", "update_card").is_err());
    }

    #[test]
    fn every_write_operation_is_refused_by_a_board_with_nothing_ticked() {
        // The default a board arrives in has to be a board that can be read and
        // not written, whatever is added to the operation table later.
        let config = config_with(&[]);
        for spec in OPS {
            if spec.permissions.is_empty() {
                continue;
            }
            let result = decide(&config, "srbk1_secret", spec.op);
            assert_eq!(
                result.unwrap_err().0,
                "permission_denied",
                "{} was not refused by an empty permission set",
                spec.op
            );
        }
    }

    /* -------------------------------------------------------------------------
       THE PIPE

       Proves the security descriptor is one Windows accepts and that a client
       using ordinary file I/O can open the pipe and round-trip a message. What
       it cannot prove from inside a test process is the CROSS-INTEGRITY case,
       which is the one the descriptor exists for: that needs a medium
       integrity client against this app running elevated.
    ------------------------------------------------------------------------- */

    #[test]
    fn a_client_can_open_the_pipe_and_round_trip_a_frame() {
        use std::os::windows::io::FromRawHandle;

        let name = format!(r"\\.\pipe\swiss-rb-knife.agent.test.{}", std::process::id());
        let (descriptor, attributes) =
            pipe_security().expect("the security descriptor should be valid SDDL");
        let handle = create_instance(&name, &attributes, true).expect("the pipe should open");

        let raw = handle.0 as usize;
        let server = std::thread::spawn(move || {
            let handle = HANDLE(raw as *mut std::ffi::c_void);
            let connected = match unsafe { ConnectNamedPipe(handle, None) } {
                Ok(()) => true,
                Err(err) => err.code().0 as u32 == 0x8007_0000 | ERROR_PIPE_CONNECTED.0,
            };
            assert!(connected, "the server never saw the client connect");
            let mut stream = unsafe {
                fs::File::from_raw_handle(handle.0 as *mut std::ffi::c_void)
            };
            let request = read_frame(&mut stream).expect("the server should read the request");
            // Echoed, so the assertion below covers both directions.
            write_frame(&mut stream, &request).expect("the server should write the response");
        });

        let mut client = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&name)
            .expect("a client should be able to open the pipe");

        let sent = br#"{"token":"x","op":"get_board"}"#;
        write_frame(&mut client, sent).expect("the client should write");
        let back = read_frame(&mut client).expect("the client should read the response");
        assert_eq!(back, sent);

        server.join().expect("the server thread should finish");
        unsafe {
            let _ = LocalFree(Some(HLOCAL(descriptor.0)));
        }
    }

    #[test]
    fn the_pipe_really_carries_the_medium_integrity_label() {
        /* THE ONE THING THAT MAKES THIS FEATURE WORK AT ALL, asserted rather
           than assumed. This app runs elevated; a pipe created by an elevated
           process carries HIGH integrity unless told otherwise, and Windows
           forbids a medium-integrity agent from writing to it. The label set in
           pipe_security() is what lowers it.

           The failure this catches is silent in every other way: the pipe opens,
           the app reports itself as listening, and every agent gets "Access is
           denied" with nothing anywhere explaining why. Read back off the real
           kernel object rather than off the string that was passed in, so it is
           testing what Windows stored and not what we asked for. */
        use windows::Win32::Security::Authorization::{
            ConvertSecurityDescriptorToStringSecurityDescriptorW, GetSecurityInfo, SE_KERNEL_OBJECT,
        };
        use windows::Win32::Security::LABEL_SECURITY_INFORMATION;

        let name = format!(r"\\.\pipe\swiss-rb-knife.agent.label.{}", std::process::id());
        let (descriptor, attributes) = pipe_security().expect("security descriptor");
        let handle = create_instance(&name, &attributes, true).expect("pipe");

        let label = unsafe {
            let mut stored = PSECURITY_DESCRIPTOR::default();
            GetSecurityInfo(
                handle,
                SE_KERNEL_OBJECT,
                LABEL_SECURITY_INFORMATION,
                None,
                None,
                None,
                None,
                Some(&mut stored),
            )
            .ok()
            .expect("the pipe's label should be readable");

            let mut text = PWSTR::null();
            ConvertSecurityDescriptorToStringSecurityDescriptorW(
                stored,
                SDDL_REVISION_1,
                LABEL_SECURITY_INFORMATION,
                &mut text,
                None,
            )
            .expect("the label should convert back to SDDL");
            let out = text.to_string().unwrap_or_default();
            let _ = LocalFree(Some(HLOCAL(text.0 as *mut _)));
            let _ = LocalFree(Some(HLOCAL(stored.0)));
            out
        };

        unsafe {
            let _ = CloseHandle(handle);
            let _ = LocalFree(Some(HLOCAL(descriptor.0)));
        }

        // ML = mandatory label, NW = no write up, ME = medium. Without this the
        // object sits at the creator's level, which for this app is high.
        assert!(
            label.contains("ML") && label.contains("NW") && label.contains("ME"),
            "the pipe's mandatory label is {label:?}, which is not medium/no-write-up"
        );
    }

    /* -------------------------------------------------------------------------
       THE SIDECAR, FOR REAL

       These run the actual srbk-agent.exe against an actual pipe served by the
       actual framing code in this file. Between them they cover the whole
       client half of the feature: reading the token and pipe name out of the
       environment, opening the pipe, writing a request, reading the response,
       and turning an app refusal into something a person can act on.

       What is still NOT covered anywhere, and has to be checked by hand once:
       an agent running at MEDIUM integrity against this app running ELEVATED.
       Every test here is one process talking to itself, which is the case the
       mandatory label was never needed for.
    ------------------------------------------------------------------------- */

    /// The built sidecar, debug for preference and release as a fallback.
    ///
    /// Returns None rather than failing when neither is there: the sidecar is a
    /// separate crate, so `cargo test` alone never builds it, and a red suite
    /// for "you have not run npm run build:agent" would be a test failing about
    /// itself rather than about the app.
    fn built_sidecar() -> Option<PathBuf> {
        let exe = std::env::current_exe().ok()?;
        // target/debug/deps/<test>.exe -> target/debug -> target
        let target = exe.parent()?.parent()?.parent()?;
        for profile in ["debug", "release"] {
            let candidate = target.join(profile).join("srbk-agent.exe");
            if candidate.exists() {
                return Some(candidate);
            }
        }
        None
    }

    /// Serves exactly one request on a private pipe and hands back what the
    /// client sent, so the test can assert on it.
    fn serve_one(pipe: &str, response: Value) -> std::thread::JoinHandle<Value> {
        let (descriptor, attributes) = pipe_security().expect("security descriptor");
        let handle = create_instance(pipe, &attributes, true).expect("pipe");
        let raw = handle.0 as usize;
        let descriptor_raw = descriptor.0 as usize;

        std::thread::spawn(move || {
            use std::os::windows::io::FromRawHandle;
            let handle = HANDLE(raw as *mut std::ffi::c_void);
            let connected = match unsafe { ConnectNamedPipe(handle, None) } {
                Ok(()) => true,
                Err(err) => err.code().0 as u32 == 0x8007_0000 | ERROR_PIPE_CONNECTED.0,
            };
            assert!(connected, "the client never connected");
            let mut stream = unsafe { fs::File::from_raw_handle(handle.0 as *mut std::ffi::c_void) };
            let raw_request = read_frame(&mut stream).expect("read the request");
            let bytes = serde_json::to_vec(&response).unwrap();
            write_frame(&mut stream, &bytes).expect("write the response");
            drop(stream);
            unsafe {
                let _ = LocalFree(Some(HLOCAL(descriptor_raw as *mut std::ffi::c_void)));
            }
            serde_json::from_slice(&raw_request).expect("the request should be JSON")
        })
    }

    #[test]
    fn the_real_sidecar_sends_what_the_gate_expects_and_prints_what_it_gets_back() {
        let Some(sidecar) = built_sidecar() else {
            eprintln!("skipped: srbk-agent.exe is not built (run: npm run build:agent)");
            return;
        };

        let pipe = format!(r"\\.\pipe\swiss-rb-knife.agent.e2e.{}", std::process::id());
        let server = serve_one(
            &pipe,
            json!({ "ok": true, "result": { "board": { "name": "Release 0.7" } } }),
        );

        let output = std::process::Command::new(&sidecar)
            .args(["call", "get_board"])
            .env("SRBK_AGENT_TOKEN", "srbk1_end_to_end")
            .env("SRBK_AGENT_PIPE", &pipe)
            .output()
            .expect("the sidecar should run");

        let request = server.join().expect("the server thread");

        // What the sidecar put on the wire is exactly what the gate reads: the
        // token that names the board, and the operation. Nothing else, and in
        // particular no board id, because there is none for an agent to give.
        assert_eq!(request["token"], "srbk1_end_to_end");
        assert_eq!(request["op"], "get_board");
        assert!(request.get("boardId").is_none(), "the sidecar must not name a board");

        assert!(output.status.success(), "the sidecar should exit 0 on a result");
        let printed = String::from_utf8_lossy(&output.stdout);
        assert!(printed.contains("Release 0.7"), "the result was not printed: {printed}");
    }

    #[test]
    fn a_refusal_reaches_the_agent_as_the_message_and_a_failure() {
        let Some(sidecar) = built_sidecar() else {
            eprintln!("skipped: srbk-agent.exe is not built (run: npm run build:agent)");
            return;
        };

        let pipe = format!(r"\\.\pipe\swiss-rb-knife.agent.deny.{}", std::process::id());
        // The exact refusal the gate produces for the worked example: a board
        // that allows creating cards and not deleting them.
        let message = "Permission denied. \"Delete cards\" is not allowed on the board \
                       \"Release 0.7\". To allow it: Swiss RB Knife > Kanban > Release 0.7 > \
                       Setup > Agents > \"Delete cards\".";
        let server = serve_one(
            &pipe,
            json!({ "ok": false, "error": { "code": "permission_denied", "message": message } }),
        );

        let output = std::process::Command::new(&sidecar)
            .args(["call", "delete_card", r#"{"card":12}"#])
            .env("SRBK_AGENT_TOKEN", "srbk1_end_to_end")
            .env("SRBK_AGENT_PIPE", &pipe)
            .output()
            .expect("the sidecar should run");

        let request = server.join().expect("the server thread");
        assert_eq!(request["op"], "delete_card");
        assert_eq!(request["params"]["card"], 12);

        assert!(!output.status.success(), "a refusal should not exit 0");
        let reported = String::from_utf8_lossy(&output.stderr);
        // The whole point of the wording: the agent can tell the user which
        // switch to turn on. Losing that on the way through would leave
        // "permission denied" and nothing to do about it.
        assert!(reported.contains("Delete cards"), "{reported}");
        assert!(reported.contains("Setup > Agents"), "{reported}");
        assert!(reported.contains("permission_denied"), "{reported}");
    }

    #[test]
    fn the_sidecar_refuses_to_run_without_a_token() {
        let Some(sidecar) = built_sidecar() else {
            eprintln!("skipped: srbk-agent.exe is not built (run: npm run build:agent)");
            return;
        };
        let output = std::process::Command::new(&sidecar)
            .args(["call", "get_board"])
            .env_remove("SRBK_AGENT_TOKEN")
            .output()
            .expect("the sidecar should run");
        assert!(!output.status.success());
        let reported = String::from_utf8_lossy(&output.stderr);
        assert!(reported.contains("Setup > Agents"), "{reported}");
    }

    #[test]
    fn an_oversized_frame_is_refused_rather_than_allocated() {
        // The length prefix arrives from outside this process. Trusting it is
        // how a four-byte message asks for a four-gigabyte buffer.
        let mut framed = Vec::new();
        framed.extend_from_slice(&(MAX_REQUEST_BYTES + 1).to_le_bytes());
        framed.extend_from_slice(b"{}");

        let path = std::env::temp_dir().join(format!("srbk-frame-{}.bin", std::process::id()));
        fs::write(&path, &framed).unwrap();
        let mut file = fs::File::open(&path).unwrap();
        let result = read_frame(&mut file);
        let _ = fs::remove_file(&path);

        assert!(result.is_err(), "an oversized frame should be refused");
    }

    #[test]
    fn every_operation_names_a_permission_that_exists() {
        for spec in OPS {
            for permission in spec.permissions {
                assert!(
                    PERMISSION_LABELS.iter().any(|(id, _)| id == permission),
                    "operation {} needs permission {permission}, which has no label",
                    spec.op
                );
            }
        }
    }

    #[test]
    fn an_unknown_operation_is_refused() {
        assert!(op_spec("drop_everything").is_none());
    }

    #[test]
    fn a_permission_absent_from_the_config_reads_as_off() {
        // The case this protects: a config file written by an older version,
        // which cannot possibly mention a permission added later. Absent has to
        // mean off, or upgrading the app would grant something silently.
        let config: AgentConfig = serde_json::from_str(
            r#"{"enabled":true,"boards":{"b1":{"enabled":true,"permissions":{"createCard":true},
               "tokens":[{"id":"c1","label":"x","token":"t"}]}}}"#,
        )
        .unwrap();
        let board = config.boards.get("b1").unwrap();
        assert_eq!(board.permissions.get("createCard").copied(), Some(true));
        assert_eq!(board.permissions.get("deleteCard").copied().unwrap_or(false), false);
    }

    #[test]
    fn a_token_finds_only_its_own_board() {
        let config: AgentConfig = serde_json::from_str(
            r#"{"enabled":true,"boards":{
                "b1":{"enabled":true,"permissions":{},"tokens":[{"id":"c1","label":"one","token":"aaa"}]},
                "b2":{"enabled":true,"permissions":{},"tokens":[{"id":"c2","label":"two","token":"bbb"}]}}}"#,
        )
        .unwrap();
        assert_eq!(find_token(&config, "aaa").unwrap().0, "b1");
        assert_eq!(find_token(&config, "bbb").unwrap().0, "b2");
        assert!(find_token(&config, "ccc").is_none());
        // An empty token must never match a connection with an empty secret.
        assert!(find_token(&config, "").is_none());
    }

    #[test]
    fn a_config_that_will_not_parse_denies_everything() {
        let config: AgentConfig = serde_json::from_str("{ this is not json").unwrap_or_default();
        assert!(!config.enabled);
        assert!(config.boards.is_empty());
    }

    #[test]
    fn reading_needs_no_permission_but_writing_always_does() {
        for spec in OPS {
            let reading = matches!(
                spec.op,
                "capabilities" | "get_board" | "list_cards" | "get_card"
            );
            assert_eq!(
                spec.permissions.is_empty(),
                reading,
                "{} is on the wrong side of the read/write line",
                spec.op
            );
        }
    }

    #[test]
    fn editing_is_allowed_by_either_edit_permission() {
        // A user who granted only "edit cards created by anyone else" must not
        // be refused here before the front end can check whose card it is.
        let spec = op_spec("update_card").unwrap();
        assert!(spec.permissions.contains(&"editCard"));
        assert!(spec.permissions.contains(&"editOthersCards"));
    }
}
