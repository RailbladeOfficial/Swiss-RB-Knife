/* =============================================================================
   DB: the shared SQLite connection, schema versioning and snapshotting
   -----------------------------------------------------------------------------
   One database file, `tools.db`, in the same data directory as everything else.
   One file rather than one per tool because a database is not a JSON blob: the
   reason the JSON files were split per board was that a save rewrote whichever
   file it touched, and that reason is gone. One file means one connection, one
   transaction boundary, and one thing to back up.

   WHAT LIVES HERE, AND WHY IT IS ONLY GAME STATS.

   Kanban and Time Tracker were moved into this database and then moved back
   out. That was the right correction. Both are read whole, drawn whole and
   written whole; neither has a question you would ask in SQL. What they lost by
   being here was the two things that actually protected them: a file you can
   open and repair by hand, and a snapshot of the previous state taken on every
   single save rather than once an hour.

   Game Stats stays, and it is the one that earns it. A round is a record and a
   score inside that round is a record, which for one modest history is already
   about 1,900 rounds and 5,800 scores. Every question the Stats and Compare
   page wants to ask ("what does each player average in round seven", "who
   recovers from behind") is a join across those. Held as files, each of those
   is a full walk of every game in code; held as rows, each is one query.

   BUDGET stays JSON as well, and separately: it is the one tool that encrypts,
   and an encrypted database means SQLCipher, which means an OpenSSL build chain
   on every machine that compiles this app. Its data is bounded by months rather
   than growing forever, so it does not need what SQLite offers.

   NO JSON BLOBS. Every field is a column and every list is a table. That is a
   deliberate reversal: the first cut of this schema kept the awkward parts
   (a game's rounds and scores) as JSON inside a `payload` column, on the
   reasoning that it avoided a schema change every time a field was added.

   It was the wrong trade. It bought convenience for whoever edits the schema
   and charged it to whoever wants to look at their own data, which is the whole
   other half of why a database is worth having. A game row that does not show
   you the scores is not a record of anything.

   The cost is real and is paid deliberately: adding a field means a migration
   step here. `migrate` exists to make that ordinary rather than frightening.
============================================================================= */

use std::sync::Mutex;

use rusqlite::Connection;
use tauri::{AppHandle, Manager};

use crate::get_data_path;

/// The database filename, beside the JSON files in the data directory.
pub const DB_FILE: &str = "tools.db";

/// Bumped when the schema changes. `migrate` walks from whatever the file says
/// to this, one step at a time, so a version can never be skipped.
const SCHEMA_VERSION: i32 = 3;

/// The one connection, opened on first use and held for the life of the app.
///
/// A Mutex rather than a pool because every caller here is a Tauri command
/// answering one user action: there is no concurrency to pool for, and one
/// connection is what makes a transaction mean something.
#[derive(Default)]
pub struct Db(pub Mutex<Option<Connection>>);

/// Runs `f` with the open connection, opening and migrating it if this is the
/// first call.
pub fn with_db<T>(app: &AppHandle, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Result<T, String> {
    let state = app
        .try_state::<Db>()
        .ok_or_else(|| "The database state is missing.".to_string())?;
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "The database lock is poisoned.".to_string())?;

    if guard.is_none() {
        let path = get_data_path(app, DB_FILE);
        let conn = Connection::open(&path)
            .map_err(|e| format!("Could not open the database: {e}"))?;
        configure(&conn).map_err(|e| format!("Could not configure the database: {e}"))?;
        migrate(&conn).map_err(|e| format!("Could not prepare the database: {e}"))?;
        *guard = Some(conn);
    }

    let conn = guard.as_ref().expect("just opened");
    f(conn).map_err(|e| e.to_string())
}

fn configure(conn: &Connection) -> rusqlite::Result<()> {
    // WAL: a reader never blocks a writer, and a crash mid-write rolls back to
    // the last good state rather than leaving a torn file. This is most of why
    // a database is safer than the whole-file rewrite it replaces.
    conn.pragma_update(None, "journal_mode", "WAL")?;
    // NORMAL rather than FULL: with WAL this still survives an application
    // crash, and only risks the last transaction on a power cut. FULL fsyncs on
    // every commit, which for a tool saving on a 400 ms debounce is a stutter
    // in exchange for a guarantee the JSON files never offered either.
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    // Referential integrity is not on by default in SQLite, which surprises
    // everyone once. Cards belong to boards; a card whose board is gone should
    // go with it rather than linger as an orphan nothing renders.
    conn.pragma_update(None, "foreign_keys", "ON")?;
    Ok(())
}

fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let current: i32 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if current >= SCHEMA_VERSION {
        return Ok(());
    }

    /* Neither earlier version of this schema ever left development, and
       nothing in either one was the only copy of anything: every row in them
       came from a JSON file that a migration never deletes. So both older
       versions are handled the same way, by dropping what they made and
       building v3 fresh.

       v1 kept `payload` JSON columns and two `meta` tables that were one row
       holding one blob. v2 removed those, and also held Kanban and Time
       Tracker, which have since gone back to files. v3 is Game Stats alone. */
    if current < 3 {
        conn.execute_batch(
            "DROP TABLE IF EXISTS kb_attachment;
             DROP TABLE IF EXISTS kb_comment;
             DROP TABLE IF EXISTS kb_subtask;
             DROP TABLE IF EXISTS kb_card_tag;
             DROP TABLE IF EXISTS kb_card;
             DROP TABLE IF EXISTS kb_tag;
             DROP TABLE IF EXISTS kb_tag_category;
             DROP TABLE IF EXISTS kb_column;
             DROP TABLE IF EXISTS kb_board_section_order;
             DROP TABLE IF EXISTS kb_board_override;
             DROP TABLE IF EXISTS kb_board;
             DROP TABLE IF EXISTS kb_meta;
             DROP TABLE IF EXISTS tt_entry;
             DROP TABLE IF EXISTS gs_round_score;
             DROP TABLE IF EXISTS gs_round;
             DROP TABLE IF EXISTS gs_game_player;
             DROP TABLE IF EXISTS gs_game;
             DROP TABLE IF EXISTS gs_table_player;
             DROP TABLE IF EXISTS gs_table;
             DROP TABLE IF EXISTS gs_profile;
             DROP TABLE IF EXISTS gs_meta;",
        )?;
        conn.execute_batch(SCHEMA)?;
    }

    conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    Ok(())
}

/* -----------------------------------------------------------------------------
   SCHEMA
----------------------------------------------------------------------------- */

const SCHEMA: &str = r#"
CREATE TABLE gs_profile (
  id     TEXT PRIMARY KEY,
  name   TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active'
);

-- A table is one exact group of players at one game type. Its key is derived
-- from those two things rather than invented, so the same three people playing
-- the same game always land at the same table.
CREATE TABLE gs_table (
  key       TEXT PRIMARY KEY,
  game_type TEXT NOT NULL DEFAULT '',
  name      TEXT NOT NULL DEFAULT ''
);

CREATE TABLE gs_table_player (
  table_key TEXT NOT NULL REFERENCES gs_table(key) ON DELETE CASCADE,
  position  INTEGER NOT NULL,
  player_id TEXT NOT NULL,
  PRIMARY KEY (table_key, position)
);

CREATE TABLE gs_game (
  id           TEXT PRIMARY KEY,
  table_key    TEXT NOT NULL DEFAULT '',
  game_type    TEXT NOT NULL DEFAULT '',
  -- Counts within its TABLE, not globally, and is never reissued. See the note
  -- on GameInstance.gameNumber.
  number       INTEGER NOT NULL DEFAULT 0,
  played_at    TEXT NOT NULL DEFAULT '',
  tie_accepted INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT '',
  updated_at   TEXT NOT NULL DEFAULT ''
);
-- Games are read per table, in play order, which is what `number` is.
CREATE INDEX gs_game_table ON gs_game(table_key, number);
CREATE INDEX gs_game_played ON gs_game(played_at);

-- Entry order, which drives column order in the scoring grid.
CREATE TABLE gs_game_player (
  game_id   TEXT NOT NULL REFERENCES gs_game(id) ON DELETE CASCADE,
  position  INTEGER NOT NULL,
  player_id TEXT NOT NULL,
  PRIMARY KEY (game_id, position)
);
CREATE INDEX gs_game_player_player ON gs_game_player(player_id);

CREATE TABLE gs_round (
  id          TEXT PRIMARY KEY,
  game_id     TEXT NOT NULL REFERENCES gs_game(id) ON DELETE CASCADE,
  round_index INTEGER NOT NULL DEFAULT 0,
  is_overtime INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX gs_round_game ON gs_round(game_id, round_index);

-- One row per player per round. `score` is NULL until it has been entered,
-- which is a different thing from a score of zero and has to stay that way:
-- a blank cell in the grid and a zero are not the same result.
--
-- Participation is what having a row MEANS. Rounds 3 to 13 have a row for every
-- player; an overtime round only has rows for the players who were tied, which
-- is exactly what participantIds used to say.
CREATE TABLE gs_round_score (
  round_id  TEXT NOT NULL REFERENCES gs_round(id) ON DELETE CASCADE,
  position  INTEGER NOT NULL,
  player_id TEXT NOT NULL,
  score     INTEGER,
  PRIMARY KEY (round_id, position)
);
CREATE INDEX gs_round_score_player ON gs_round_score(player_id);
"#;

/* -----------------------------------------------------------------------------
   SNAPSHOTS
   -----------------------------------------------------------------------------
   The database gets the same hourly history the JSON files had, and gets it a
   different way, because the old way would undo the reason for moving.

   THE JSON FILES were copied into a bucket on EVERY save. That was affordable
   when a save was already rewriting the whole file: the copy was the same size
   as the write. A database write is a few pages, so copying the whole database
   beside it would make every keystroke cost the entire dataset again, which is
   precisely the amplification the move was meant to remove.

   SO THE DATABASE IS SNAPSHOTTED ONCE PER BUCKET, on the first write of each
   hour. What that trades is real and worth stating: if the live database were
   destroyed you could lose up to an hour rather than a single edit. What buys
   that back is that a database is far harder to destroy than a whole-file
   rewrite. WAL means a crash rolls back to the last commit rather than leaving
   a half-written file, which is the exact failure the JSON snapshots existed to
   recover from.

   RESTORING NAMES ITS TOOL even though Game Stats is currently the only one
   in here. The snapshot is attached as a second database and only the
   asked-for tool's tables are copied across, inside one transaction, so a
   second tool arriving later does not make this the thing that has to change.
----------------------------------------------------------------------------- */

/// What a tool's tables are called, so a restore can name them without the
/// front end being able to name anything else.
fn tables_for(tool_id: &str) -> Result<&'static [&'static str], String> {
    match tool_id {
        /* PARENTS FIRST. A restore inserts in this order and empties in the
           reverse, so a child table is always emptied before its parent and
           filled after it. Getting that backwards trips the foreign keys, which
           is the point of having them. */
        "game-stats" => Ok(&[
            "gs_profile",
            "gs_table",
            "gs_table_player",
            "gs_game",
            "gs_game_player",
            "gs_round",
            "gs_round_score",
        ]),
        _ => Err(format!("'{tool_id}' does not keep records in the database.")),
    }
}

fn backups_root(app: &AppHandle) -> Option<std::path::PathBuf> {
    get_data_path(app, DB_FILE).parent().map(|p| p.join("backups"))
}

/// The bucket name for right now, in the same format and the same hourly
/// windows lib.rs uses for the JSON snapshots, so both kinds sit side by side
/// in one folder and read as one history.
fn current_bucket() -> String {
    use chrono::{TimeZone, Utc};
    let secs = (Utc::now().timestamp() / 3600) * 3600;
    Utc.timestamp_opt(secs, 0)
        .single()
        .map(|dt| dt.format("%Y-%m-%d_%H-%M-%S").to_string())
        .unwrap_or_else(|| "0000-00-00_00-00-00".to_string())
}

/// Takes a snapshot if this hour has not had one yet.
///
/// Called on the way INTO a write rather than after it, so what is captured is
/// the state before the change, matching what the JSON snapshots always did:
/// the thing you want back is what you had before you broke it.
pub fn snapshot_if_due(app: &AppHandle) {
    let root = match backups_root(app) {
        Some(r) => r,
        None => return,
    };
    let dir = root.join(current_bucket());
    let dest = dir.join("tools.db.bak");
    if dest.exists() {
        return; // this hour is already captured
    }
    // Nothing to capture before the database exists.
    if !get_data_path(app, DB_FILE).exists() {
        return;
    }
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    // Best effort. A snapshot that cannot be taken must not fail the save it
    // was riding along with; the alternative is an app that stops accepting
    // edits because its backup folder is read-only.
    let _ = snapshot_to(app, &dest);
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbBackup {
    /// The bucket folder's name: a UTC timestamp in lib.rs's format.
    name: String,
    bytes: u64,
}

/// Every snapshot of the database, newest first.
#[tauri::command]
pub fn list_db_backups(app: AppHandle) -> Result<Vec<DbBackup>, String> {
    let root = match backups_root(&app) {
        Some(r) => r,
        None => return Ok(vec![]),
    };
    let entries = match std::fs::read_dir(&root) {
        Ok(e) => e,
        // No backups folder yet is a new install, not an error.
        Err(_) => return Ok(vec![]),
    };
    let mut out: Vec<DbBackup> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if !crate::valid_bucket_name(&name) {
                return None;
            }
            let meta = std::fs::metadata(e.path().join("tools.db.bak")).ok()?;
            Some(DbBackup { name, bytes: meta.len() })
        })
        .collect();
    // The format sorts correctly as plain strings, so a reversed string sort is
    // a true newest-first with no date parsing.
    out.sort_by(|a, b| b.name.cmp(&a.name));
    Ok(out)
}

/// Puts one tool's records back from a snapshot, and touches no other tool.
///
/// The snapshot is ATTACHED rather than copied over the live file. Copying
/// would mean closing the connection, replacing the file and reopening, and
/// would restore every tool at once; attaching lets this replace three tables
/// and leave the rest of the database alone.
///
/// A snapshot is taken first, so restoring the wrong one is undone by restoring
/// the newest, exactly as it was with the JSON files.
#[tauri::command]
pub fn restore_db_backup(app: AppHandle, tool_id: String, name: String) -> Result<(), String> {
    if !crate::valid_bucket_name(&name) {
        return Err("That snapshot name is not one of ours.".to_string());
    }
    let tables = tables_for(&tool_id)?;
    let root = backups_root(&app).ok_or_else(|| "No backups folder.".to_string())?;
    let src = root.join(&name).join("tools.db.bak");
    if !src.is_file() {
        return Err("That snapshot does not hold a database.".to_string());
    }

    // The state being replaced, captured before it is replaced.
    snapshot_if_due(&app);

    with_db(&app, |conn| {
        conn.execute("ATTACH DATABASE ?1 AS snap", [src.to_string_lossy().to_string()])?;
        let result = (|| -> rusqlite::Result<()> {
            let tx = conn.unchecked_transaction()?;
            // Emptied in reverse, so a child table goes before its parent.
            for table in tables.iter().rev() {
                tx.execute(&format!("DELETE FROM main.{table}"), [])?;
            }
            for table in tables.iter() {
                tx.execute(
                    &format!("INSERT INTO main.{table} SELECT * FROM snap.{table}"),
                    [],
                )?;
            }
            tx.commit()
        })();
        // Detached whether or not the copy worked, or the next restore in this
        // session finds the name already taken.
        let _ = conn.execute("DETACH DATABASE snap", []);
        result
    })
}

/* -----------------------------------------------------------------------------
   SNAPSHOTS
----------------------------------------------------------------------------- */

/// Writes a consistent copy of the database into `dest`.
///
/// `VACUUM INTO` rather than copying the file: with WAL on, the .db on disk is
/// only half the story until a checkpoint runs, so a plain file copy can catch
/// a database mid-transaction and produce a snapshot that will not open. This
/// asks SQLite for a complete, compacted copy and gets a file that is valid by
/// construction.
pub fn snapshot_to(app: &AppHandle, dest: &std::path::Path) -> Result<(), String> {
    // VACUUM INTO refuses to overwrite, so the stale one goes first.
    if dest.exists() {
        std::fs::remove_file(dest).map_err(|e| format!("Could not replace the snapshot: {e}"))?;
    }
    with_db(app, |conn| {
        conn.execute("VACUUM INTO ?1", [dest.to_string_lossy().to_string()])?;
        Ok(())
    })
}
