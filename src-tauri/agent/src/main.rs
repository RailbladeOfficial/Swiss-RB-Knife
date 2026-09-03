/* =============================================================================
   SRBK-AGENT: the bridge between an AI coding agent and Swiss RB Knife
   -----------------------------------------------------------------------------
   WHAT THIS IS. A small program an AI agent (Claude Code, Cursor, anything that
   speaks MCP) spawns and talks to over its own stdin and stdout. It translates
   what the agent asks for into a request on a local named pipe, and hands back
   whatever Swiss RB Knife answers.

   WHAT IT DELIBERATELY IS NOT. It holds no permissions, no rules and no data.
   It cannot read a board file, it does not know where the data folder is, and
   it has no idea whether the thing it was just asked to do is allowed. Every
   one of those answers comes back from the app. That is the entire point: the
   agent, and this program the agent controls, are both on the untrusted side of
   the line, and nothing on that side is asked to enforce anything.

   WHY IT IS A SEPARATE PROGRAM AT ALL. The main app ships with a
   requireAdministrator manifest, so spawning it would raise a UAC prompt every
   time an agent started, and being a windowed binary it has no usable stdout
   anyway. This one is an ordinary console program that runs as whoever started
   it.

   TWO WAYS IN:

     srbk-agent --mcp                     the real one. Speaks MCP (JSON-RPC
                                          over stdin/stdout) and is what the
                                          copied connection block launches.

     srbk-agent call <op> [json]          one request, printed as JSON. For
     srbk-agent capabilities              trying things by hand and for agents
                                          that can run a command but not MCP.

   The token comes from SRBK_AGENT_TOKEN (or --token). It names ONE board: the
   app resolves which, so there is no board id here to get wrong or to change.

   THE WIRE, matching src-tauri/src/agent_gate.rs: four bytes of little-endian
   length, then that many bytes of JSON, both directions, one request per
   connection.
============================================================================= */

use std::collections::BTreeMap;
use std::io::{BufRead, Read, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Map, Value};

/// Matches agent_gate::pipe_name(). Overridable, because a dev build of the app
/// listens on a different name and the connection block says which.
const DEFAULT_PIPE: &str = r"\\.\pipe\swiss-rb-knife.agent";

/// Windows error numbers worth telling apart. 2 is "the app is not running",
/// which is the one a user actually hits; 231 is "all instances are busy",
/// which is transient and worth retrying.
const ERROR_FILE_NOT_FOUND: i32 = 2;
const ERROR_PIPE_BUSY: i32 = 231;

const MAX_FRAME: u32 = 8 * 1024 * 1024;

/// How often the tool list is re-derived from the board's permissions while an
/// MCP session is open. See spawn_permission_watcher() for why this is a poll
/// rather than something the app pushes.
const PERMISSION_POLL: Duration = Duration::from_secs(5);

/* =============================================================================
   TALKING TO THE APP
============================================================================= */

struct Connection {
    pipe: String,
    token: String,
}

impl Connection {
    fn from_env() -> Result<Self, String> {
        let mut token = std::env::var("SRBK_AGENT_TOKEN").unwrap_or_default();
        let mut pipe = std::env::var("SRBK_AGENT_PIPE").unwrap_or_else(|_| DEFAULT_PIPE.to_string());

        // Arguments win over the environment, so a config can pass either.
        let args: Vec<String> = std::env::args().collect();
        let mut index = 0;
        while index < args.len() {
            match args[index].as_str() {
                "--token" => {
                    token = args.get(index + 1).cloned().unwrap_or_default();
                    index += 1;
                }
                "--pipe" => {
                    pipe = args
                        .get(index + 1)
                        .cloned()
                        .unwrap_or_else(|| DEFAULT_PIPE.to_string());
                    index += 1;
                }
                _ => {}
            }
            index += 1;
        }

        if token.trim().is_empty() {
            return Err(
                "No connection token. Set SRBK_AGENT_TOKEN, or pass --token. Copy a connection \
                 from Swiss RB Knife: Kanban > the board > Setup > Agents."
                    .to_string(),
            );
        }
        Ok(Connection { pipe, token: token.trim().to_string() })
    }

    /// One request, one connection. Retries only the "all instances busy" case,
    /// which means another request is in flight rather than anything being
    /// wrong.
    fn send(&self, op: &str, params: &Value) -> Result<Value, AppError> {
        let payload = json!({ "token": self.token, "op": op, "params": params });
        let bytes = serde_json::to_vec(&payload).map_err(|err| AppError {
            code: "bad_request".to_string(),
            message: format!("Could not encode the request: {err}"),
        })?;

        let mut attempt = 0;
        let mut stream = loop {
            match std::fs::OpenOptions::new().read(true).write(true).open(&self.pipe) {
                Ok(stream) => break stream,
                Err(err) => {
                    let code = err.raw_os_error().unwrap_or(0);
                    if code == ERROR_PIPE_BUSY && attempt < 40 {
                        attempt += 1;
                        std::thread::sleep(Duration::from_millis(50));
                        continue;
                    }
                    return Err(AppError {
                        code: if code == ERROR_FILE_NOT_FOUND {
                            "app_not_running".to_string()
                        } else {
                            "connect_failed".to_string()
                        },
                        message: if code == ERROR_FILE_NOT_FOUND {
                            "Swiss RB Knife is not running, so the board cannot be reached. \
                             Ask the user to open Swiss RB Knife and try again."
                                .to_string()
                        } else {
                            format!("Could not reach Swiss RB Knife: {err}")
                        },
                    });
                }
            }
        };

        let framing = |err: std::io::Error| AppError {
            code: "transport".to_string(),
            message: format!("The connection to Swiss RB Knife failed: {err}"),
        };

        stream.write_all(&(bytes.len() as u32).to_le_bytes()).map_err(framing)?;
        stream.write_all(&bytes).map_err(framing)?;
        stream.flush().map_err(framing)?;

        let mut len_bytes = [0u8; 4];
        stream.read_exact(&mut len_bytes).map_err(framing)?;
        let len = u32::from_le_bytes(len_bytes);
        if len > MAX_FRAME {
            return Err(AppError {
                code: "transport".to_string(),
                message: "Swiss RB Knife sent a response that was too large to read.".to_string(),
            });
        }
        let mut buf = vec![0u8; len as usize];
        stream.read_exact(&mut buf).map_err(framing)?;

        let response: Value = serde_json::from_slice(&buf).map_err(|err| AppError {
            code: "transport".to_string(),
            message: format!("Swiss RB Knife sent something unreadable: {err}"),
        })?;

        if response.get("ok").and_then(Value::as_bool) == Some(true) {
            return Ok(response.get("result").cloned().unwrap_or(Value::Null));
        }
        let error = response.get("error");
        Err(AppError {
            code: error
                .and_then(|e| e.get("code"))
                .and_then(Value::as_str)
                .unwrap_or("rejected")
                .to_string(),
            message: error
                .and_then(|e| e.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("The operation was refused.")
                .to_string(),
        })
    }
}

struct AppError {
    code: String,
    message: String,
}

/* =============================================================================
   THE TOOLS THE AGENT SEES
   -----------------------------------------------------------------------------
   One row per tool: the MCP name, the operation the app knows it by, the
   permission that has to be on for it to be worth offering, and the schema.

   The permission is used ONLY to decide whether to LIST the tool. It is not a
   check: the app checks, on every call, and would refuse a call to a tool this
   program listed by mistake. Filtering the list exists so a well-behaved agent
   does not spend its turn discovering what it cannot do.
============================================================================= */

struct ToolSpec {
    name: &'static str,
    op: &'static str,
    /// Any one of these permissions is enough for the tool to be worth listing.
    /// Empty means reading, which needs none.
    permissions: &'static [&'static str],
    description: &'static str,
    schema: fn() -> Value,
}

fn card_ref() -> Value {
    json!({
        "type": ["string", "integer"],
        "description": "The card, by its number on the board (42) or by its id."
    })
}

fn schema(properties: Value, required: &[&str]) -> Value {
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false
    })
}

const TOOLS: &[ToolSpec] = &[
    ToolSpec {
        name: "kanban_get_board",
        op: "get_board",
        permissions: &[],
        description: "The board itself: its columns in order, how many cards are in each, its \
                      WIP limits, and the tags it knows about. Start here.",
        schema: || schema(json!({}), &[]),
    },
    ToolSpec {
        name: "kanban_list_cards",
        op: "list_cards",
        permissions: &[],
        description: "Cards on the board, newest first, with optional filters. Returns a summary \
                      of each card rather than its full contents.",
        schema: || {
            schema(
                json!({
                    "column": { "type": "string", "description": "Only cards in this column, by title or id." },
                    "tag": { "type": "string", "description": "Only cards carrying this tag, by name or id." },
                    "priority": { "type": "string", "enum": ["none", "trivial", "low", "medium", "high", "critical"] },
                    "effort": { "type": "string", "enum": ["none", "tiny", "small", "medium", "large", "huge"] },
                    "archived": { "type": "boolean", "description": "Include archived cards. Default false." },
                    "overdue": { "type": "boolean", "description": "Only cards past their due date." },
                    "query": { "type": "string", "description": "Only cards whose title or description contains this text." },
                    "limit": { "type": "integer", "description": "Most cards to return. Default 100." }
                }),
                &[],
            )
        },
    },
    ToolSpec {
        name: "kanban_get_card",
        op: "get_card",
        permissions: &[],
        description: "One card in full: description, subtasks, comments, tags, dates and who \
                      created it.",
        schema: || schema(json!({ "card": card_ref() }), &["card"]),
    },
    ToolSpec {
        name: "kanban_create_card",
        op: "create_card",
        permissions: &["createCard"],
        description: "Adds a card to a column. Returns the new card, including the number the \
                      board gave it.",
        schema: || {
            schema(
                json!({
                    "title": { "type": "string", "description": "Required. The card's title." },
                    "description": { "type": "string", "description": "Markdown." },
                    "column": { "type": "string", "description": "Column title or id. Defaults to the first column." },
                    "priority": { "type": "string", "enum": ["none", "trivial", "low", "medium", "high", "critical"] },
                    "effort": { "type": "string", "enum": ["none", "tiny", "small", "medium", "large", "huge"] },
                    "tags": { "type": "array", "items": { "type": "string" }, "description": "Existing tags, by name or id. Needs the assign-tags permission." },
                    "due": { "type": "string", "description": "Due date as YYYY-MM-DD. Needs the set-dates permission." },
                    "subtasks": { "type": "array", "items": { "type": "string" } },
                    "position": { "type": "string", "enum": ["top", "bottom"], "description": "Where in the column. Default bottom." }
                }),
                &["title"],
            )
        },
    },
    ToolSpec {
        name: "kanban_update_card",
        op: "update_card",
        permissions: &["editCard", "editOthersCards"],
        description: "Changes a card's title, description, priority or effort. Leave a field \
                      out to leave it alone.",
        schema: || {
            schema(
                json!({
                    "card": card_ref(),
                    "title": { "type": "string" },
                    "description": { "type": "string", "description": "Markdown. Replaces the whole description." },
                    "priority": { "type": "string", "enum": ["none", "trivial", "low", "medium", "high", "critical"] },
                    "effort": { "type": "string", "enum": ["none", "tiny", "small", "medium", "large", "huge"] }
                }),
                &["card"],
            )
        },
    },
    ToolSpec {
        name: "kanban_move_card",
        op: "move_card",
        permissions: &["moveCard"],
        description: "Moves a card to another column, or to the top or bottom of the one it is \
                      already in.",
        schema: || {
            schema(
                json!({
                    "card": card_ref(),
                    "column": { "type": "string", "description": "Column title or id." },
                    "position": { "type": "string", "enum": ["top", "bottom"], "description": "Default bottom." }
                }),
                &["card", "column"],
            )
        },
    },
    ToolSpec {
        name: "kanban_set_card_dates",
        op: "set_card_dates",
        permissions: &["setDates"],
        description: "Sets or clears a card's due date and its work-stage dates. Pass null to \
                      clear one. Dates are YYYY-MM-DD.",
        schema: || {
            schema(
                json!({
                    "card": card_ref(),
                    "due": { "type": ["string", "null"] },
                    "started": { "type": ["string", "null"], "description": "When work started." },
                    "testing": { "type": ["string", "null"], "description": "When testing started." },
                    "completed": { "type": ["string", "null"], "description": "When it was finished." }
                }),
                &["card"],
            )
        },
    },
    ToolSpec {
        name: "kanban_archive_card",
        op: "archive_card",
        permissions: &["archiveCard"],
        description: "Takes a card off the board without destroying it, or puts an archived card \
                      back.",
        schema: || {
            schema(
                json!({
                    "card": card_ref(),
                    "archived": { "type": "boolean", "description": "True to archive, false to restore. Default true." }
                }),
                &["card"],
            )
        },
    },
    ToolSpec {
        name: "kanban_delete_card",
        op: "delete_card",
        permissions: &["deleteCard"],
        description: "Deletes a card permanently. Prefer archiving unless the user asked for it \
                      to be deleted.",
        schema: || schema(json!({ "card": card_ref() }), &["card"]),
    },
    ToolSpec {
        name: "kanban_add_comment",
        op: "add_comment",
        permissions: &["createComment"],
        description: "Adds a comment to a card. Comments are the right place for progress notes; \
                      the description is what the card is.",
        schema: || {
            schema(
                json!({
                    "card": card_ref(),
                    "body": { "type": "string", "description": "Markdown." }
                }),
                &["card", "body"],
            )
        },
    },
    ToolSpec {
        name: "kanban_delete_comment",
        op: "delete_comment",
        permissions: &["deleteComment"],
        description: "Deletes one comment from a card.",
        schema: || {
            schema(
                json!({ "card": card_ref(), "comment": { "type": "string", "description": "The comment's id." } }),
                &["card", "comment"],
            )
        },
    },
    ToolSpec {
        name: "kanban_add_subtask",
        op: "add_subtask",
        permissions: &["manageSubtasks"],
        description: "Adds a subtask to a card's checklist.",
        schema: || {
            schema(json!({ "card": card_ref(), "text": { "type": "string" } }), &["card", "text"])
        },
    },
    ToolSpec {
        name: "kanban_set_subtask",
        op: "set_subtask",
        permissions: &["manageSubtasks"],
        description: "Ticks, unticks or rewords one subtask.",
        schema: || {
            schema(
                json!({
                    "card": card_ref(),
                    "subtask": { "type": "string", "description": "The subtask's id." },
                    "done": { "type": "boolean" },
                    "text": { "type": "string" }
                }),
                &["card", "subtask"],
            )
        },
    },
    ToolSpec {
        name: "kanban_remove_subtask",
        op: "remove_subtask",
        permissions: &["manageSubtasks"],
        description: "Removes one subtask from a card.",
        schema: || {
            schema(
                json!({ "card": card_ref(), "subtask": { "type": "string" } }),
                &["card", "subtask"],
            )
        },
    },
    ToolSpec {
        name: "kanban_set_card_tags",
        op: "set_card_tags",
        permissions: &["assignTags"],
        description: "Replaces the tags on a card. The tags must already exist on the board; use \
                      kanban_get_board to see them.",
        schema: || {
            schema(
                json!({
                    "card": card_ref(),
                    "tags": { "type": "array", "items": { "type": "string" }, "description": "Tag names or ids. An empty list clears them." }
                }),
                &["card", "tags"],
            )
        },
    },
    ToolSpec {
        name: "kanban_create_tag",
        op: "create_tag",
        permissions: &["createTags"],
        description: "Adds a new tag to the board's vocabulary.",
        schema: || {
            schema(
                json!({
                    "name": { "type": "string" },
                    "category": { "type": "string", "description": "Tag category, by name or id. Created if it does not exist." },
                    "color": { "type": "string", "description": "As #rrggbb. Defaults to the category's color." }
                }),
                &["name"],
            )
        },
    },
    ToolSpec {
        name: "kanban_create_column",
        op: "create_column",
        permissions: &["manageColumns"],
        description: "Adds a column to the board.",
        schema: || {
            schema(
                json!({
                    "title": { "type": "string" },
                    "wipLimit": { "type": ["integer", "null"], "description": "Work-in-progress limit, or null for unlimited." },
                    "isDone": { "type": "boolean", "description": "Cards here count as finished." },
                    "position": { "type": "integer", "description": "Where in the column order. Default last." }
                }),
                &["title"],
            )
        },
    },
    ToolSpec {
        name: "kanban_move_column",
        op: "move_column",
        permissions: &["manageColumns"],
        description: "Moves a column to another place in the board's order.",
        schema: || {
            schema(
                json!({
                    "column": { "type": "string", "description": "Column title or id." },
                    "position": {
                        "type": "integer",
                        "description": "Where it lands, counting from 0 at the left."
                    }
                }),
                &["column", "position"],
            )
        },
    },
    ToolSpec {
        name: "kanban_update_column",
        op: "update_column",
        permissions: &["manageColumns"],
        description: "Renames a column or changes its WIP limit or done flag.",
        schema: || {
            schema(
                json!({
                    "column": { "type": "string", "description": "Column title or id." },
                    "title": { "type": "string" },
                    "wipLimit": { "type": ["integer", "null"] },
                    "isDone": { "type": "boolean" }
                }),
                &["column"],
            )
        },
    },
];

fn tool_by_name(name: &str) -> Option<&'static ToolSpec> {
    TOOLS.iter().find(|tool| tool.name == name)
}

/// Which tools to advertise, given what the board allows.
///
/// When the permission set cannot be fetched (the app is closed, most likely)
/// EVERYTHING is listed. A short list cached by the agent's client while the app
/// happened to be shut is worse than a long one: the calls would fail with a
/// clear message either way, but a missing tool looks like a missing feature.
fn visible_tools(permissions: Option<&Map<String, Value>>) -> Vec<&'static ToolSpec> {
    TOOLS
        .iter()
        .filter(|tool| {
            if tool.permissions.is_empty() {
                return true;
            }
            let Some(permissions) = permissions else { return true };
            tool.permissions.iter().any(|id| {
                permissions.get(*id).and_then(Value::as_bool).unwrap_or(false)
            })
        })
        .collect()
}

/* =============================================================================
   MCP
   -----------------------------------------------------------------------------
   JSON-RPC 2.0, one message per line, on stdin and stdout. Nothing else may be
   written to stdout: a stray print is a protocol error to the client, which is
   why every diagnostic here goes to stderr.
============================================================================= */

/// Protocol versions this understands. The surface is tools and nothing else,
/// which has not changed across any of them, so the client's choice is echoed
/// back when it is one of these.
const KNOWN_PROTOCOLS: &[&str] = &["2024-11-05", "2025-03-26", "2025-06-18"];
const DEFAULT_PROTOCOL: &str = "2025-06-18";

/// The names of the tools currently worth listing, in list order.
fn visible_tool_names(permissions: Option<&Map<String, Value>>) -> Vec<&'static str> {
    visible_tools(permissions).into_iter().map(|tool| tool.name).collect()
}

/// Watches the board's permissions and tells the client when the tool list has
/// changed underneath it.
///
/// WHY THIS EXISTS. tools/list re-asks the app for permissions every time, so
/// the answer is always current. But a client asks once, at startup, and then
/// caches. Flipping a switch in the Agents tab mid-session therefore changed
/// nothing the agent could see: a permission turned ON left the tool invisible
/// until the session was restarted, which reads as the feature not existing.
///
/// WHY IT POLLS. The wire is one request per connection, opened by this end.
/// The app has no way to call out to a sidecar it did not spawn and holds no
/// handle to, so "tell me when this changes" is not available and asking on an
/// interval is what is left. The cost is one pipe round trip every few seconds
/// for as long as an agent is connected.
fn spawn_permission_watcher(
    connection: Arc<Connection>,
    stdout: Arc<Mutex<std::io::Stdout>>,
    initial: Vec<&'static str>,
) {
    std::thread::spawn(move || {
        let mut known = initial;
        loop {
            std::thread::sleep(PERMISSION_POLL);

            // A failed fetch is the app being closed, not the permissions being
            // empty. Holding the last known list keeps a shutdown from reading
            // as a permission change and firing a pointless notification.
            let Ok(fresh) = connection.send("capabilities", &json!({})) else { continue };
            let current = visible_tool_names(
                fresh.get("permissions").and_then(Value::as_object),
            );
            if current == known {
                continue;
            }
            known = current;

            let notification = json!({
                "jsonrpc": "2.0",
                "method": "notifications/tools/list_changed"
            });
            let Ok(mut out) = stdout.lock() else { break };
            if writeln!(out, "{notification}").is_err() || out.flush().is_err() {
                break;
            }
        }
    });
}

fn run_mcp(connection: Connection) {
    let stdin = std::io::stdin();
    let stdout = Arc::new(Mutex::new(std::io::stdout()));
    let connection = Arc::new(connection);

    // Asked once at startup so the board's name can go in the instructions and
    // the tool list can be trimmed to what is allowed. A failure here is not
    // fatal: the app may simply not be open yet.
    let capabilities = connection.send("capabilities", &json!({})).ok();

    spawn_permission_watcher(
        Arc::clone(&connection),
        Arc::clone(&stdout),
        visible_tool_names(
            capabilities
                .as_ref()
                .and_then(|c| c.get("permissions"))
                .and_then(Value::as_object),
        ),
    );

    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(message) = serde_json::from_str::<Value>(line) else {
            // Not JSON at all. There is no id to answer against, so there is
            // nothing to reply to.
            eprintln!("srbk-agent: ignored a line that was not JSON");
            continue;
        };

        // A notification (no id) is not answered, per JSON-RPC.
        let id = message.get("id").cloned();
        let method = message.get("method").and_then(Value::as_str).unwrap_or("");
        let params = message.get("params").cloned().unwrap_or(Value::Null);

        let response = match method {
            "initialize" => Some(initialize_result(&params, capabilities.as_ref())),
            "tools/list" => {
                // Re-asked rather than reused: the user may have changed the
                // permissions since this process started, and the tool list is
                // the one place that shows.
                let fresh = connection.send("capabilities", &json!({})).ok();
                let permissions = fresh
                    .as_ref()
                    .or(capabilities.as_ref())
                    .and_then(|c| c.get("permissions"))
                    .and_then(Value::as_object);
                let tools: Vec<Value> = visible_tools(permissions)
                    .into_iter()
                    .map(|tool| {
                        json!({
                            "name": tool.name,
                            "description": tool.description,
                            "inputSchema": (tool.schema)()
                        })
                    })
                    .collect();
                Some(Ok(json!({ "tools": tools })))
            }
            "tools/call" => Some(call_tool(&connection, &params)),
            "ping" => Some(Ok(json!({}))),
            // Declared as unsupported in initialize, but some clients ask
            // anyway. An empty list is a kinder answer than an error.
            "resources/list" => Some(Ok(json!({ "resources": [] }))),
            "prompts/list" => Some(Ok(json!({ "prompts": [] }))),
            "notifications/initialized" | "notifications/cancelled" => None,
            _ => {
                if id.is_some() {
                    Some(Err((-32601, format!("Unknown method: {method}"))))
                } else {
                    None
                }
            }
        };

        let (Some(id), Some(response)) = (id, response) else { continue };
        let body = match response {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err((code, message)) => {
                json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
            }
        };
        let Ok(text) = serde_json::to_string(&body) else { continue };
        let Ok(mut out) = stdout.lock() else { break };
        if writeln!(out, "{text}").is_err() || out.flush().is_err() {
            break;
        }
    }
}

type RpcResult = Result<Value, (i64, String)>;

fn initialize_result(params: &Value, capabilities: Option<&Value>) -> RpcResult {
    let requested = params.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
    let protocol = if KNOWN_PROTOCOLS.contains(&requested) { requested } else { DEFAULT_PROTOCOL };

    let board = capabilities
        .and_then(|c| c.get("board"))
        .and_then(|b| b.get("name"))
        .and_then(Value::as_str);

    let instructions = match board {
        Some(name) => format!(
            "These tools act on one Kanban board in Swiss RB Knife: \"{name}\". Every tool is a \
             REQUEST. Swiss RB Knife checks that board's own permissions and performs the \
             operation or refuses it, so a refusal is the app's decision and is not something to \
             work around. If a tool is refused, tell the user which switch would allow it rather \
             than trying another route. Swiss RB Knife must be open for any of this to work."
        ),
        None => "These tools act on one Kanban board in Swiss RB Knife. Swiss RB Knife is not \
                 currently running, so calls will fail until the user opens it. Every tool is a \
                 request the app checks against that board's permissions before performing."
            .to_string(),
    };

    Ok(json!({
        "protocolVersion": protocol,
        "capabilities": { "tools": { "listChanged": true } },
        "serverInfo": { "name": "swiss-rb-knife-kanban", "version": env!("CARGO_PKG_VERSION") },
        "instructions": instructions
    }))
}

fn call_tool(connection: &Connection, params: &Value) -> RpcResult {
    let name = params.get("name").and_then(Value::as_str).unwrap_or("");
    let arguments = params.get("arguments").cloned().unwrap_or_else(|| json!({}));

    let Some(tool) = tool_by_name(name) else {
        return Err((-32602, format!("Unknown tool: {name}")));
    };

    // A refusal is a TOOL result, not a JSON-RPC error. The difference matters:
    // a protocol error reads to the agent as "this connection is broken", while
    // an error result reads as "that did not work, and here is why", which is
    // what a permission refusal actually is.
    match connection.send(tool.op, &arguments) {
        Ok(result) => Ok(json!({
            "content": [{ "type": "text", "text": pretty(&result) }],
            "isError": false
        })),
        Err(err) => Ok(json!({
            "content": [{ "type": "text", "text": format!("{} ({})", err.message, err.code) }],
            "isError": true
        })),
    }
}

fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
}

/* =============================================================================
   THE COMMAND LINE
============================================================================= */

fn run_cli(connection: Connection, op: &str, raw_params: Option<&str>) -> i32 {
    let params: Value = match raw_params {
        Some(text) => match serde_json::from_str(text) {
            Ok(value) => value,
            Err(err) => {
                eprintln!("The parameters were not valid JSON: {err}");
                return 2;
            }
        },
        None => json!({}),
    };
    match connection.send(op, &params) {
        Ok(result) => {
            println!("{}", pretty(&result));
            0
        }
        Err(err) => {
            eprintln!("{} ({})", err.message, err.code);
            1
        }
    }
}

fn usage() {
    eprintln!(
        "srbk-agent {} - local bridge to a Swiss RB Knife Kanban board

USAGE
  srbk-agent --mcp                  Speak MCP on stdin/stdout. This is what an
                                    AI agent's config launches.
  srbk-agent capabilities           Print the board and what it allows.
  srbk-agent call <op> [json]       Send one operation and print the result.
  srbk-agent tools                  List the operations this build knows.

CONNECTION
  SRBK_AGENT_TOKEN   the connection token, from Swiss RB Knife:
                     Kanban > the board > Setup > Agents. Required.
  SRBK_AGENT_PIPE    override the pipe name. Only needed for a dev build.

  --token <t> and --pipe <p> do the same and win over the environment.",
        env!("CARGO_PKG_VERSION")
    );
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let first = args.first().map(String::as_str).unwrap_or("");

    if first == "tools" {
        let mut by_permission: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
        for tool in TOOLS {
            let key = tool.permissions.first().copied().unwrap_or("(reading)");
            by_permission.entry(key).or_default().push(tool.name);
        }
        for (permission, names) in by_permission {
            println!("{permission}: {}", names.join(", "));
        }
        return;
    }

    if first.is_empty() || first == "--help" || first == "-h" || first == "help" {
        usage();
        std::process::exit(if first.is_empty() { 2 } else { 0 });
    }

    let connection = match Connection::from_env() {
        Ok(connection) => connection,
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(2);
        }
    };

    match first {
        "--mcp" | "mcp" => run_mcp(connection),
        "capabilities" => std::process::exit(run_cli(connection, "capabilities", None)),
        "call" => {
            let Some(op) = args.get(1) else {
                eprintln!("Which operation? Try: srbk-agent tools");
                std::process::exit(2);
            };
            let params = args.get(2).map(String::as_str);
            std::process::exit(run_cli(connection, op, params));
        }
        other => {
            eprintln!("Unknown command: {other}");
            usage();
            std::process::exit(2);
        }
    }
}

/* =============================================================================
   TESTS
============================================================================= */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_tool_schema_is_an_object_schema() {
        for tool in TOOLS {
            let schema = (tool.schema)();
            assert_eq!(schema["type"], "object", "{} has a non-object schema", tool.name);
            assert!(schema.get("properties").is_some(), "{} has no properties", tool.name);
            // Every required field has to actually be declared, or a client
            // that validates will refuse to call the tool at all.
            for required in schema["required"].as_array().unwrap_or(&vec![]) {
                let name = required.as_str().unwrap_or("");
                assert!(
                    schema["properties"].get(name).is_some(),
                    "{} requires {name}, which is not in its properties",
                    tool.name
                );
            }
        }
    }

    #[test]
    fn tool_names_are_unique_and_prefixed() {
        let mut seen = std::collections::HashSet::new();
        for tool in TOOLS {
            assert!(tool.name.starts_with("kanban_"), "{} is not prefixed", tool.name);
            assert!(seen.insert(tool.name), "{} is listed twice", tool.name);
        }
    }

    #[test]
    fn reading_tools_are_listed_even_with_nothing_granted() {
        let permissions = serde_json::from_str::<Value>(r#"{"createCard":false}"#).unwrap();
        let visible = visible_tools(permissions.as_object());
        let names: Vec<&str> = visible.iter().map(|t| t.name).collect();
        assert!(names.contains(&"kanban_get_board"));
        assert!(names.contains(&"kanban_list_cards"));
        assert!(!names.contains(&"kanban_create_card"));
        assert!(!names.contains(&"kanban_delete_card"));
    }

    #[test]
    fn a_granted_permission_shows_its_tool() {
        let permissions =
            serde_json::from_str::<Value>(r#"{"createCard":true,"deleteCard":false}"#).unwrap();
        let names: Vec<&str> =
            visible_tools(permissions.as_object()).iter().map(|t| t.name).collect();
        assert!(names.contains(&"kanban_create_card"));
        assert!(!names.contains(&"kanban_delete_card"));
    }

    #[test]
    fn an_unreachable_app_lists_everything() {
        // The app being shut must not look like a build with fewer features.
        assert_eq!(visible_tools(None).len(), TOOLS.len());
    }

    #[test]
    fn editing_is_listed_when_either_edit_permission_is_on() {
        let only_others =
            serde_json::from_str::<Value>(r#"{"editCard":false,"editOthersCards":true}"#).unwrap();
        let names: Vec<&str> =
            visible_tools(only_others.as_object()).iter().map(|t| t.name).collect();
        assert!(names.contains(&"kanban_update_card"));
    }
}
