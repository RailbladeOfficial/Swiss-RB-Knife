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

use std::io::{BufRead, Read, Write};
use std::time::Duration;

use serde_json::{json, Value};

/// Matches agent_gate::pipe_name(). Overridable, because a dev build of the app
/// listens on a different name and the connection block says which.
const DEFAULT_PIPE: &str = r"\\.\pipe\swiss-rb-knife.agent";

/// Windows error numbers worth telling apart. 2 is "the app is not running",
/// which is the one a user actually hits; 231 is "all instances are busy",
/// which is transient and worth retrying.
const ERROR_FILE_NOT_FOUND: i32 = 2;
const ERROR_PIPE_BUSY: i32 = 231;

const MAX_FRAME: u32 = 8 * 1024 * 1024;

/* =============================================================================
   TALKING TO THE APP
============================================================================= */

struct Connection {
    pipe: String,
    token: String,
    /// Set when the app's own Test Connection started this (SRBK_AGENT_PROBE=1),
    /// so the app does not count its test as an agent using the connection.
    probe: bool,
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
        let probe = std::env::var("SRBK_AGENT_PROBE").map(|v| v == "1").unwrap_or(false);
        Ok(Connection { pipe, token: token.trim().to_string(), probe })
    }

    /// Whether this is aimed at a dev build, which listens on a pipe of its own.
    fn is_dev(&self) -> bool {
        self.pipe.ends_with(".dev")
    }

    /// One request, one connection. Retries only the "all instances busy" case,
    /// which means another request is in flight rather than anything being
    /// wrong.
    fn send(&self, op: &str, params: &Value) -> Result<Value, AppError> {
        let mut payload = json!({ "token": self.token, "op": op, "params": params });
        if self.probe {
            payload["probe"] = json!(true);
        }
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
   One row per tool: the MCP name, the operation the app knows it by, and the
   schema.

   EVERY TOOL IS ALWAYS LISTED, whatever the board's switches say. This program
   decides nothing, so it does not decide what to show either. A tool that is
   switched off is still offered; calling it reaches the app, which refuses it,
   names the switch that would allow it, and writes the attempt to the board's
   activity log. The list used to be trimmed to what was allowed, and a blocked
   action was then never attempted at all: nothing was refused, nothing was
   logged, and a switch doing its job looked exactly like a missing feature.
============================================================================= */

struct ToolSpec {
    name: &'static str,
    op: &'static str,
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
        description: "The board itself: its columns in order, how many cards are in each, its \
                      WIP limits, and the tags it knows about. Start here.",
        schema: || schema(json!({}), &[]),
    },
    ToolSpec {
        name: "kanban_list_cards",
        op: "list_cards",
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
        description: "One card in full: description, subtasks, comments, tags, dates and who \
                      created it.",
        schema: || schema(json!({ "card": card_ref() }), &["card"]),
    },
    ToolSpec {
        name: "kanban_create_card",
        op: "create_card",
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
                    "due": { "type": "string", "description": "Due date as YYYY-MM-DD, a day only. Needs the set-dates permission." },
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
        description: "Sets or clears a card's due date and its work-stage stamps. Pass null to \
                      clear one. The due date is a day, YYYY-MM-DD. The three stage stamps \
                      record when something happened and take YYYY-MM-DDTHH:MM, or a bare \
                      day when the time is not known.",
        schema: || {
            schema(
                json!({
                    "card": card_ref(),
                    "due": { "type": ["string", "null"], "description": "Target day, YYYY-MM-DD. A time is refused." },
                    "started": { "type": ["string", "null"], "description": "When work started, YYYY-MM-DDTHH:MM or YYYY-MM-DD." },
                    "testing": { "type": ["string", "null"], "description": "When testing started, YYYY-MM-DDTHH:MM or YYYY-MM-DD." },
                    "completed": { "type": ["string", "null"], "description": "When it was finished, YYYY-MM-DDTHH:MM or YYYY-MM-DD." }
                }),
                &["card"],
            )
        },
    },
    ToolSpec {
        name: "kanban_archive_card",
        op: "archive_card",
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
        description: "Deletes a card permanently. Prefer archiving unless the user asked for it \
                      to be deleted.",
        schema: || schema(json!({ "card": card_ref() }), &["card"]),
    },
    ToolSpec {
        name: "kanban_add_comment",
        op: "add_comment",
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
        description: "Adds a subtask to a card's checklist.",
        schema: || {
            schema(json!({ "card": card_ref(), "text": { "type": "string" } }), &["card", "text"])
        },
    },
    ToolSpec {
        name: "kanban_set_subtask",
        op: "set_subtask",
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
        description: "Adds a column to the board.",
        schema: || {
            schema(
                json!({
                    "title": { "type": "string" },
                    "wipLimit": { "type": ["integer", "null"], "description": "Work-in-progress limit, or null for unlimited." },
                    "isDone": { "type": "boolean", "description": "Cards here count as finished." },
                    "stage": {
                        "type": ["string", "null"],
                        "enum": ["started", "testing", null],
                        "description": "The stage date a card moved into this column is stamped with, if it has none: started (Work Started) or testing (Testing Started). null for none. A done column always stamps Completed and cannot take a stage."
                    },
                    "position": { "type": "integer", "description": "Where in the column order. Default last." }
                }),
                &["title"],
            )
        },
    },
    ToolSpec {
        name: "kanban_move_column",
        op: "move_column",
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
        description: "Renames a column or changes its WIP limit, its done flag, or the stage date it \
                      stamps. Leave a field out to leave it alone.",
        schema: || {
            schema(
                json!({
                    "column": { "type": "string", "description": "Column title or id." },
                    "title": { "type": "string" },
                    "wipLimit": { "type": ["integer", "null"] },
                    "isDone": { "type": "boolean" },
                    "stage": {
                        "type": ["string", "null"],
                        "enum": ["started", "testing", null],
                        "description": "The stage date a card moved into this column is stamped with, if it has none: started (Work Started) or testing (Testing Started). null for none. A done column always stamps Completed; to give one a stage, send isDone: false as well."
                    }
                }),
                &["column"],
            )
        },
    },
];

fn tool_by_name(name: &str) -> Option<&'static ToolSpec> {
    TOOLS.iter().find(|tool| tool.name == name)
}

/// The tools/list answer: every tool, in list order. See the note above TOOLS
/// for why nothing is filtered out.
fn tool_list() -> Vec<Value> {
    TOOLS
        .iter()
        .map(|tool| {
            json!({
                "name": tool.name,
                "description": tool.description,
                "inputSchema": (tool.schema)()
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

fn run_mcp(connection: Connection) {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();

    // Asked once at startup so the board's name can go in the instructions. A
    // failure here is not fatal: the app may simply not be open yet.
    //
    // Said on stderr either way, which is where an MCP client keeps a server's
    // log. A connection that silently does nothing is the failure people cannot
    // diagnose, so the log carries the same words `srbk-agent check` prints.
    let capabilities = match connection.send("capabilities", &json!({})) {
        Ok(result) => {
            eprintln!("srbk-agent: {}", connected_line(&result, connection.is_dev()));
            Some(result)
        }
        Err(err) => {
            let report = describe_failure(&err, connection.is_dev());
            for line in report.lines().filter(|line| !line.trim().is_empty()) {
                eprintln!("srbk-agent: {line}");
            }
            None
        }
    };

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
            "tools/list" => Some(Ok(json!({ "tools": tool_list() }))),
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
        if writeln!(stdout, "{text}").is_err() || stdout.flush().is_err() {
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
             work around. Every tool is listed whether or not the board allows it, so a tool \
             being listed says nothing about whether it will work. If a tool is refused, tell the \
             user which switch would allow it rather than trying another route. Swiss RB Knife \
             must be open for any of this to work."
        ),
        None => "These tools act on one Kanban board in Swiss RB Knife. Swiss RB Knife is not \
                 currently running, so calls will fail until the user opens it. Every tool is a \
                 request the app checks against that board's permissions before performing."
            .to_string(),
    };

    Ok(json!({
        "protocolVersion": protocol,
        "capabilities": { "tools": { "listChanged": false } },
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

fn build_name(dev: bool) -> &'static str {
    if dev {
        "dev build"
    } else {
        "installed"
    }
}

/// What the board allows, as the words on its switches.
fn allowed_labels(result: &Value) -> Vec<String> {
    if let Some(list) = result.get("allowed").and_then(Value::as_array) {
        return list.iter().filter_map(Value::as_str).map(str::to_lowercase).collect();
    }
    // An app from before it sent the words: the ids are all there is to show.
    result
        .get("permissions")
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .filter(|(_, on)| on.as_bool() == Some(true))
                .map(|(id, _)| id.clone())
                .collect()
        })
        .unwrap_or_default()
}

/// One line for an MCP client's server log.
fn connected_line(result: &Value, dev: bool) -> String {
    let board = result.pointer("/board/name").and_then(Value::as_str).unwrap_or("?");
    let label = result.pointer("/connection/label").and_then(Value::as_str).unwrap_or("?");
    format!(
        "connected to the board \"{board}\" in Swiss RB Knife ({}) as \"{label}\".",
        build_name(dev)
    )
}

/// What `check` prints when the board answered.
fn describe_success(result: &Value, dev: bool) -> String {
    let board = result.pointer("/board/name").and_then(Value::as_str).unwrap_or("?");
    let label = result.pointer("/connection/label").and_then(Value::as_str).unwrap_or("?");
    let allowed = allowed_labels(result);
    let may = if allowed.is_empty() {
        format!(
            "read the board, and nothing else yet. Switch on what it may change in \
             Kanban > {board} > Setup > Agents > What It May Do."
        )
    } else {
        format!("read the board, {}", allowed.join(", "))
    };
    format!(
        "Connection works.\n\n  App:         Swiss RB Knife ({})\n  Board:       {board}\n  \
         Connection:  {label}\n  It may:      {may}",
        build_name(dev)
    )
}

/// What `check` prints, and what the MCP log carries, when the board did not
/// answer. The first line stands alone, because the app's Test Connection shows
/// it as its one-line result; the lines after it say what to do.
fn describe_failure(err: &AppError, dev: bool) -> String {
    match err.code.as_str() {
        "app_not_running" => {
            let other = if dev {
                "This connection is for the dev build. The installed app does not answer it."
            } else {
                "This connection is for the installed app. A dev build does not answer it."
            };
            format!(
                "Connection not checked: Swiss RB Knife ({}) is not running.\n\nOpen it, then \
                 run this command again. {other}",
                build_name(dev)
            )
        }
        "unknown_token" => "Connection does not work: Swiss RB Knife does not recognize it.\n\n\
             It was revoked, or replaced by a newer one. In Swiss RB Knife, open Kanban > the \
             board > Setup > Agents, press Copy Command on the connection you want, and paste \
             it into Command Prompt or PowerShell. It replaces this one."
            .to_string(),
        "access_disabled" | "board_disabled" => {
            format!("Connection does not work yet: agent access is off.\n\n{}", err.message)
        }
        _ => format!("Connection does not work: {} ({})", err.message, err.code),
    }
}

/* =============================================================================
   CONNECT: saving this connection into an agent's own settings
   -----------------------------------------------------------------------------
   `srbk-agent connect claude-code --name <key> --token <t> --pipe <p>`

   What the Agents tab's Copy Command copies, behind `cmd /c "<this exe>"`. The
   copied line used to BE these steps, written in PowerShell syntax, and pasted
   into Command Prompt it quietly did nothing: the steps ran together into one
   garbled call, a file named `$null` appeared, and the check at the end still
   said the connection worked. Here they are processes started with real
   arguments rather than shell text, so the copied line is one call that
   Command Prompt and PowerShell both run the same way.

   THE STEPS, and why each is there:

     1. REMOVE whatever is saved under this name. `mcp add` refuses a name it
        already has, and Revoke in the app cannot reach the agent's settings, so
        an add-only command failed for every board that had ever been connected.
        Claude Code is cleared in the user scope (where this saves) and the
        local scope (where the older command saved, in whatever folder it ran
        in). Nothing to remove is the usual case, so a failed remove is fine.
     2. ADD it. Claude Code at user scope, because the default is the folder the
        terminal happens to be in, and an elevated terminal opens in System32.
     3. CHECK it with the same token and pipe, and say in words what happened.

   The agent's CLI is found by name on PATH, exactly as the user's own terminal
   would find it. This process is not elevated: it is the user running their own
   tool, which is why a bare name is right here and would not be in the app.
============================================================================= */

/// The agents `connect` knows how to set up. Their ids match the clients marked
/// `command: true` in src/tool/kanban-agents.ts, and a check keeps them in step.
#[derive(Clone, Copy, Debug, PartialEq)]
enum AgentCli {
    ClaudeCode,
    Codex,
}

impl AgentCli {
    fn parse(id: &str) -> Option<Self> {
        match id {
            "claude-code" => Some(Self::ClaudeCode),
            "codex" => Some(Self::Codex),
            _ => None,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::ClaudeCode => "Claude Code",
            Self::Codex => "Codex",
        }
    }

    /// Program names to try, in order. The native installers put an .exe on
    /// PATH; an npm install puts a .cmd shim there instead, and a .cmd has to be
    /// named in full to be started as a process.
    fn programs(self) -> &'static [&'static str] {
        match self {
            Self::ClaudeCode => &["claude", "claude.cmd"],
            Self::Codex => &["codex", "codex.cmd"],
        }
    }

    fn remove_args(self, name: &str) -> Vec<Vec<String>> {
        match self {
            Self::ClaudeCode => ["user", "local"]
                .iter()
                .map(|scope| owned(&["mcp", "remove", name, "-s", scope]))
                .collect(),
            Self::Codex => vec![owned(&["mcp", "remove", name])],
        }
    }

    fn add_args(self, name: &str, token: &str, pipe: &str, exe: &str) -> Vec<String> {
        let mut args = owned(&["mcp", "add", name]);
        if self == Self::ClaudeCode {
            args.extend(owned(&["-s", "user"]));
        }
        args.extend([
            "--env".to_string(),
            format!("SRBK_AGENT_TOKEN={token}"),
            "--env".to_string(),
            format!("SRBK_AGENT_PIPE={pipe}"),
            // Everything after this is the server's own command line. The exe
            // path is ONE argument, spaces and all, which is exactly what a line
            // of shell text kept getting wrong.
            "--".to_string(),
            exe.to_string(),
            "--mcp".to_string(),
        ]);
        args
    }
}

fn owned(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| item.to_string()).collect()
}

enum CliRun {
    Ran(std::process::Output),
    /// None of the program names exists on PATH.
    Missing,
    Failed(String),
}

fn run_agent_cli(cli: AgentCli, args: &[String]) -> CliRun {
    for program in cli.programs() {
        match std::process::Command::new(program)
            .args(args)
            .stdin(std::process::Stdio::null())
            .output()
        {
            Ok(output) => return CliRun::Ran(output),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
            Err(err) => return CliRun::Failed(err.to_string()),
        }
    }
    CliRun::Missing
}

/// A server name as serverKey() in the app makes them. Checked because it
/// becomes an argument to someone else's CLI and a key in their settings.
fn valid_server_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn flag_value(args: &[String], flag: &str) -> Option<String> {
    let at = args.iter().position(|arg| arg == flag)?;
    args.get(at + 1).cloned()
}

fn describe_missing_cli(cli: AgentCli) -> String {
    let label = cli.label();
    format!(
        "Nothing was changed: {label} isn't installed, or this terminal can't find it.\n\n\
         Install {label}, open a new terminal, and paste the command again. Or, in Swiss RB \
         Knife, set Copy As to Config File and add the block to {label}'s settings file."
    )
}

/// What the agent's CLI printed, for when it refused.
fn cli_said(output: &std::process::Output) -> String {
    let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let out = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if err.is_empty() {
        out
    } else {
        err
    }
}

/// `srbk-agent connect <agent>`. Everything goes to stdout, because it is a
/// report written for the person who pasted the command.
fn run_connect(connection: &Connection, args: &[String]) -> i32 {
    let Some(cli) = args.get(1).and_then(|id| AgentCli::parse(id)) else {
        println!(
            "Nothing was changed: this command does not say which agent to set up. Copy it \
             from Swiss RB Knife again: Kanban > the board > Setup > Agents."
        );
        return 2;
    };
    let Some(name) = flag_value(args, "--name").filter(|name| valid_server_name(name)) else {
        println!(
            "Nothing was changed: this command is missing its connection name. Copy it from \
             Swiss RB Knife again: Kanban > the board > Setup > Agents."
        );
        return 2;
    };
    let exe = match std::env::current_exe() {
        Ok(path) => path.to_string_lossy().to_string(),
        Err(err) => {
            println!("Nothing was changed: could not work out where srbk-agent.exe is ({err}).");
            return 1;
        }
    };
    let label = cli.label();
    println!("Connecting {label} to Swiss RB Knife...\n");

    let mut replaced = false;
    for remove in cli.remove_args(&name) {
        match run_agent_cli(cli, &remove) {
            CliRun::Missing => {
                println!("{}", describe_missing_cli(cli));
                return 1;
            }
            CliRun::Ran(output) if output.status.success() => replaced = true,
            // Nothing saved under that name, which is the usual case.
            _ => {}
        }
    }

    let add = cli.add_args(&name, &connection.token, &connection.pipe, &exe);
    match run_agent_cli(cli, &add) {
        CliRun::Ran(output) if output.status.success() => {
            if replaced {
                println!("  Replaced the earlier connection in {label} (\"{name}\").");
            } else {
                println!("  Saved the connection in {label} as \"{name}\".");
            }
        }
        CliRun::Ran(output) => {
            if replaced {
                println!("The old connection was removed, but {label} would not save the new one. It said:\n");
            } else {
                println!("Nothing was saved: {label} would not save the connection. It said:\n");
            }
            for line in cli_said(&output).lines() {
                println!("  {line}");
            }
            return 1;
        }
        CliRun::Missing => {
            println!("{}", describe_missing_cli(cli));
            return 1;
        }
        CliRun::Failed(err) => {
            println!("Nothing was saved: {label} could not be started ({err}).");
            return 1;
        }
    }

    println!();
    let code = match connection.send("capabilities", &json!({})) {
        Ok(result) => {
            println!("{}", describe_success(&result, connection.is_dev()));
            0
        }
        Err(err) => {
            println!("{}", describe_failure(&err, connection.is_dev()));
            1
        }
    };
    println!("\nRestart {label} so it picks up the connection.");
    code
}

/// `srbk-agent check`: the connection, tried and described in words.
///
/// The copied command runs this last, so pasting it ends with a sentence about
/// whether it worked rather than with the agent's own "added" line, which only
/// means a config entry was written. It all goes to stdout because it is a
/// report either way; the exit code says which kind.
fn run_check(connection: &Connection) -> i32 {
    match connection.send("capabilities", &json!({})) {
        Ok(result) => {
            println!("{}", describe_success(&result, connection.is_dev()));
            0
        }
        Err(err) => {
            println!("{}", describe_failure(&err, connection.is_dev()));
            1
        }
    }
}

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
  srbk-agent connect <agent>        Save this connection in claude-code or codex, replacing
                                    an older one, then check it. Needs --name.
  srbk-agent check                  Say whether this connection works, in words.
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
        // Every tool and the operation behind it. What each one costs is the
        // app's to say, so it is not repeated here: `capabilities` prints that.
        for tool in TOOLS {
            println!("{}  ({})", tool.name, tool.op);
        }
        return;
    }

    if first.is_empty() || first == "--help" || first == "-h" || first == "help" {
        usage();
        std::process::exit(if first.is_empty() { 2 } else { 0 });
    }

    let mut connection = match Connection::from_env() {
        Ok(connection) => connection,
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(2);
        }
    };
    // `check` and `connect` are a PERSON at a terminal trying the connection,
    // not the agent using it, so they do not count toward "last used" or the
    // "active now" badge. Pasting the command would otherwise show Claude Code
    // as active before Claude Code had even been started.
    if first == "check" || first == "connect" {
        connection.probe = true;
    }

    match first {
        "--mcp" | "mcp" => run_mcp(connection),
        "check" => std::process::exit(run_check(&connection)),
        "connect" => std::process::exit(run_connect(&connection, &args)),
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
    fn every_tool_is_listed_whatever_the_board_allows() {
        // Nothing is filtered, so a switched-off action is still attempted and
        // the app gets to refuse it and log it.
        let names: Vec<String> = tool_list()
            .iter()
            .filter_map(|tool| tool["name"].as_str().map(str::to_string))
            .collect();
        assert_eq!(names.len(), TOOLS.len());
        for expected in ["kanban_get_board", "kanban_delete_card", "kanban_update_column"] {
            assert!(names.iter().any(|n| n == expected), "{expected} is not listed");
        }
    }

    #[test]
    fn the_tool_list_is_declared_as_never_changing() {
        // A list that never changes must not promise change notifications.
        let result = initialize_result(&json!({}), None).unwrap();
        assert_eq!(result["capabilities"]["tools"]["listChanged"], json!(false));
    }

    fn failure(code: &str) -> AppError {
        AppError { code: code.to_string(), message: "from the app".to_string() }
    }

    #[test]
    fn a_revoked_connection_says_how_to_replace_it() {
        let text = describe_failure(&failure("unknown_token"), false);
        assert!(text.starts_with("Connection does not work"), "{text}");
        assert!(text.contains("Copy Command"), "{text}");
        assert!(text.contains("Command Prompt or PowerShell"), "{text}");
        assert!(text.contains("replaces"), "{text}");
    }

    #[test]
    fn a_closed_app_names_which_build_the_connection_is_for() {
        let dev = describe_failure(&failure("app_not_running"), true);
        assert!(dev.contains("(dev build) is not running"), "{dev}");
        let installed = describe_failure(&failure("app_not_running"), false);
        assert!(installed.contains("(installed) is not running"), "{installed}");
    }

    #[test]
    fn the_first_line_of_a_failure_stands_alone() {
        // The app shows only that line as Test Connection's result.
        for code in ["app_not_running", "unknown_token", "board_disabled", "transport"] {
            let first = describe_failure(&failure(code), false).lines().next().unwrap_or("").to_string();
            assert!(first.starts_with("Connection "), "{code}: {first}");
        }
    }

    #[test]
    fn a_working_connection_names_the_board_and_what_it_may_do() {
        let result = json!({
            "board": { "name": "SRBK" },
            "connection": { "label": "Claude Code" },
            "allowed": ["Create cards", "Move cards between columns"]
        });
        let text = describe_success(&result, true);
        assert!(text.starts_with("Connection works."), "{text}");
        assert!(text.contains("SRBK") && text.contains("Claude Code"), "{text}");
        assert!(text.contains("create cards, move cards between columns"), "{text}");
    }

    #[test]
    fn nothing_switched_on_says_where_to_switch_it() {
        let result = json!({ "board": { "name": "SRBK" }, "connection": { "label": "x" }, "allowed": [] });
        assert!(describe_success(&result, false).contains("Kanban > SRBK > Setup > Agents"));
    }

    fn as_strs(args: &[String]) -> Vec<&str> {
        args.iter().map(String::as_str).collect()
    }

    #[test]
    fn claude_code_is_saved_for_the_user_after_clearing_both_scopes() {
        let removes = AgentCli::ClaudeCode.remove_args("srbk-dev-kanban-x");
        let removes: Vec<Vec<&str>> = removes.iter().map(|r| as_strs(r)).collect();
        assert!(removes.contains(&vec!["mcp", "remove", "srbk-dev-kanban-x", "-s", "user"]));
        assert!(removes.contains(&vec!["mcp", "remove", "srbk-dev-kanban-x", "-s", "local"]));

        let exe = r"C:\Program Files\Swiss RB Knife\srbk-agent.exe";
        let add = AgentCli::ClaudeCode.add_args("srbk-dev-kanban-x", "srbk1_ab", r"\\.\pipe\p.dev", exe);
        let add = as_strs(&add);
        assert_eq!(&add[..5], &["mcp", "add", "srbk-dev-kanban-x", "-s", "user"]);
        assert!(add.contains(&"SRBK_AGENT_TOKEN=srbk1_ab"));
        assert!(add.contains(&r"SRBK_AGENT_PIPE=\\.\pipe\p.dev"));
        // The exe path is one argument, spaces and all.
        let sep = add.iter().position(|a| *a == "--").unwrap();
        assert_eq!(&add[sep + 1..], &[exe, "--mcp"]);
    }

    #[test]
    fn codex_has_no_scope_to_pass() {
        let add = AgentCli::Codex.add_args("srbk-kanban-x", "t", "p", "exe");
        assert!(!add.iter().any(|a| a == "-s"));
        assert_eq!(
            AgentCli::Codex.remove_args("srbk-kanban-x"),
            vec![owned(&["mcp", "remove", "srbk-kanban-x"])]
        );
    }

    #[test]
    fn only_agents_with_a_cli_can_be_connected() {
        assert_eq!(AgentCli::parse("claude-code"), Some(AgentCli::ClaudeCode));
        assert_eq!(AgentCli::parse("codex"), Some(AgentCli::Codex));
        assert_eq!(AgentCli::parse("cursor"), None);
    }

    #[test]
    fn a_connection_name_is_what_serverkey_makes_and_nothing_else() {
        assert!(valid_server_name("srbk-dev-kanban-srbk"));
        assert!(!valid_server_name(""));
        assert!(!valid_server_name("srbk kanban"));
        assert!(!valid_server_name("srbk&calc"));
        assert!(!valid_server_name(&"a".repeat(65)));
    }

    #[test]
    fn a_missing_agent_says_nothing_changed_and_what_to_do_instead() {
        let text = describe_missing_cli(AgentCli::ClaudeCode);
        assert!(text.starts_with("Nothing was changed"), "{text}");
        assert!(text.contains("Config File"), "{text}");
    }
}
