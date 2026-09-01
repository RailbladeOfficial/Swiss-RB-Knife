/* =============================================================================
   GAME STATS STORAGE
   -----------------------------------------------------------------------------
   Games, rounds and scores, in the shared database. No JSON columns: every
   field is a column and every list is a table.

   A ROUND IS ITS OWN RECORD, and a score is its own record inside that. This is
   the part of the app where that matters most. A game holds a dozen rounds and
   a round holds a score per player, which for one modest history is already
   1,928 rounds and 5,781 scores. Kept as nested JSON, every question about them
   ("what does each player average in round seven", "who recovers from behind")
   meant walking every game in code. As rows, each is one query.

   WHAT A NULL SCORE MEANS. Not zero. A round's score is NULL until it has been
   entered, and a blank cell in the scoring grid is a different fact from a
   player scoring nothing. The column is nullable for exactly that reason.

   WHO PLAYED A ROUND is what HAVING a row means. Rounds three to thirteen carry
   a row for every player at the table; an overtime round carries rows only for
   the players who were tied. That is what the old participantIds list said, now
   said by the rows themselves.

   MIGRATION. This tool has shipped, so game-stats.json holds real history. It
   moves once, only into empty tables, and the file is READ and never deleted.
============================================================================= */

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::db::{snapshot_if_due, with_db};

#[derive(Deserialize, Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProfileRow {
    pub id: String,
    pub name: String,
    pub status: String,
}

#[derive(Deserialize, Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TableRow {
    pub key: String,
    pub game_type: String,
    pub name: String,
    pub player_ids: Vec<String>,
}

#[derive(Deserialize, Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RoundRow {
    /// Stable per round. Minted by the front end when a round is entered, and
    /// once per round during the migration.
    pub id: String,
    pub round_index: i64,
    pub is_overtime: bool,
    /// Who played, in entry order. A score is null until it is entered.
    pub participant_ids: Vec<String>,
    pub scores: Vec<Option<i64>>,
}

#[derive(Deserialize, Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GameRow {
    pub id: String,
    pub table_key: String,
    pub game_type: String,
    pub number: i64,
    pub date: String,
    pub tie_accepted: bool,
    pub created_at: String,
    pub updated_at: String,
    pub player_ids: Vec<String>,
    pub rounds: Vec<RoundRow>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameStatsSnapshot {
    pub games: Vec<GameRow>,
    pub profiles: Vec<ProfileRow>,
    pub tables: Vec<TableRow>,
}

/* -----------------------------------------------------------------------------
   READING
----------------------------------------------------------------------------- */

/// Everything, in six sweeps rather than six queries per game.
#[tauri::command]
pub fn gs_load(app: AppHandle) -> Result<GameStatsSnapshot, String> {
    with_db(&app, |conn| {
        let mut stmt = conn.prepare("SELECT id, name, status FROM gs_profile ORDER BY name")?;
        let profiles = stmt
            .query_map([], |r| {
                Ok(ProfileRow { id: r.get(0)?, name: r.get(1)?, status: r.get(2)? })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let mut stmt = conn.prepare("SELECT key, game_type, name FROM gs_table ORDER BY key")?;
        let mut tables = stmt
            .query_map([], |r| {
                Ok(TableRow {
                    key: r.get(0)?,
                    game_type: r.get(1)?,
                    name: r.get(2)?,
                    player_ids: Vec::new(),
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let table_at: std::collections::HashMap<String, usize> =
            tables.iter().enumerate().map(|(i, t)| (t.key.clone(), i)).collect();
        let mut stmt = conn.prepare(
            "SELECT table_key, player_id FROM gs_table_player ORDER BY table_key, position",
        )?;
        for row in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
            let (key, player) = row?;
            if let Some(&i) = table_at.get(&key) {
                tables[i].player_ids.push(player);
            }
        }

        let mut stmt = conn.prepare(
            "SELECT id, table_key, game_type, number, played_at, tie_accepted,
                    created_at, updated_at
               FROM gs_game ORDER BY table_key, number",
        )?;
        let mut games = stmt
            .query_map([], |r| {
                Ok(GameRow {
                    id: r.get(0)?,
                    table_key: r.get(1)?,
                    game_type: r.get(2)?,
                    number: r.get(3)?,
                    date: r.get(4)?,
                    tie_accepted: r.get::<_, i64>(5)? != 0,
                    created_at: r.get(6)?,
                    updated_at: r.get(7)?,
                    ..Default::default()
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let game_at: std::collections::HashMap<String, usize> =
            games.iter().enumerate().map(|(i, g)| (g.id.clone(), i)).collect();

        let mut stmt = conn
            .prepare("SELECT game_id, player_id FROM gs_game_player ORDER BY game_id, position")?;
        for row in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
            let (game_id, player) = row?;
            if let Some(&i) = game_at.get(&game_id) {
                games[i].player_ids.push(player);
            }
        }

        let mut stmt = conn.prepare(
            "SELECT game_id, id, round_index, is_overtime
               FROM gs_round ORDER BY game_id, round_index",
        )?;
        let round_rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    RoundRow {
                        id: r.get(1)?,
                        round_index: r.get(2)?,
                        is_overtime: r.get::<_, i64>(3)? != 0,
                        ..Default::default()
                    },
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut round_at: std::collections::HashMap<String, (usize, usize)> =
            std::collections::HashMap::new();
        for (game_id, round) in round_rows {
            if let Some(&i) = game_at.get(&game_id) {
                round_at.insert(round.id.clone(), (i, games[i].rounds.len()));
                games[i].rounds.push(round);
            }
        }

        let mut stmt = conn.prepare(
            "SELECT round_id, player_id, score FROM gs_round_score ORDER BY round_id, position",
        )?;
        for row in stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<i64>>(2)?))
        })? {
            let (round_id, player, score) = row?;
            if let Some(&(gi, ri)) = round_at.get(&round_id) {
                games[gi].rounds[ri].participant_ids.push(player);
                games[gi].rounds[ri].scores.push(score);
            }
        }

        Ok(GameStatsSnapshot { games, profiles, tables })
    })
}

/* -----------------------------------------------------------------------------
   WRITING
----------------------------------------------------------------------------- */

fn write_game(conn: &Connection, game: &GameRow) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO gs_game (id, table_key, game_type, number, played_at, tie_accepted,
                              created_at, updated_at)
              VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
         ON CONFLICT(id) DO UPDATE SET
              table_key = excluded.table_key, game_type = excluded.game_type,
              number = excluded.number, played_at = excluded.played_at,
              tie_accepted = excluded.tie_accepted, updated_at = excluded.updated_at",
        params![
            game.id, game.table_key, game.game_type, game.number, game.date,
            game.tie_accepted as i64, game.created_at, game.updated_at
        ],
    )?;

    // A game's players and rounds are replaced rather than diffed: a game has a
    // handful of each, and the transaction makes the swap atomic. The scores go
    // with their rounds through the cascade.
    conn.execute("DELETE FROM gs_game_player WHERE game_id = ?1", [&game.id])?;
    conn.execute("DELETE FROM gs_round WHERE game_id = ?1", [&game.id])?;

    let mut player = conn.prepare_cached(
        "INSERT INTO gs_game_player (game_id, position, player_id) VALUES (?1,?2,?3)",
    )?;
    for (i, id) in game.player_ids.iter().enumerate() {
        player.execute(params![game.id, i as i64, id])?;
    }
    drop(player);

    let mut round = conn.prepare_cached(
        "INSERT INTO gs_round (id, game_id, round_index, is_overtime) VALUES (?1,?2,?3,?4)",
    )?;
    let mut score = conn.prepare_cached(
        "INSERT INTO gs_round_score (round_id, position, player_id, score) VALUES (?1,?2,?3,?4)",
    )?;
    for r in &game.rounds {
        round.execute(params![r.id, game.id, r.round_index, r.is_overtime as i64])?;
        for (i, player_id) in r.participant_ids.iter().enumerate() {
            // Null rather than absent when a cell has not been filled in: a
            // blank is a different fact from a zero.
            score.execute(params![r.id, i as i64, player_id, r.scores.get(i).copied().flatten()])?;
        }
    }
    Ok(())
}

fn write_lists(
    conn: &Connection,
    profiles: &[ProfileRow],
    tables: &[TableRow],
) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM gs_profile", [])?;
    let mut p = conn
        .prepare_cached("INSERT INTO gs_profile (id, name, status) VALUES (?1,?2,?3)")?;
    for row in profiles {
        p.execute(params![row.id, row.name, row.status])?;
    }
    drop(p);

    conn.execute("DELETE FROM gs_table", [])?;
    let mut t =
        conn.prepare_cached("INSERT INTO gs_table (key, game_type, name) VALUES (?1,?2,?3)")?;
    let mut tp = conn.prepare_cached(
        "INSERT INTO gs_table_player (table_key, position, player_id) VALUES (?1,?2,?3)",
    )?;
    for row in tables {
        t.execute(params![row.key, row.game_type, row.name])?;
        for (i, id) in row.player_ids.iter().enumerate() {
            tp.execute(params![row.key, i as i64, id])?;
        }
    }
    Ok(())
}

/// Writes the games that changed, removes the ids that went, and refreshes the
/// profile and table lists. One transaction: finishing a game writes the game
/// and the table it belongs to, and half of that landing would leave a game at
/// a table that does not exist.
#[tauri::command]
pub fn gs_save(
    app: AppHandle,
    games: Vec<GameRow>,
    deleted: Vec<String>,
    profiles: Option<Vec<ProfileRow>>,
    tables: Option<Vec<TableRow>>,
) -> Result<(), String> {
    if games.is_empty() && deleted.is_empty() && profiles.is_none() {
        return Ok(());
    }
    snapshot_if_due(&app);
    with_db(&app, |conn| {
        let tx = conn.unchecked_transaction()?;
        for game in &games {
            write_game(&tx, game)?;
        }
        if !deleted.is_empty() {
            let mut del = tx.prepare_cached("DELETE FROM gs_game WHERE id = ?1")?;
            for id in &deleted {
                del.execute([id])?;
            }
        }
        if let (Some(profiles), Some(tables)) = (&profiles, &tables) {
            write_lists(&tx, profiles, tables)?;
        }
        tx.commit()?;
        Ok(())
    })
}

/// Replaces every game and every list, for a snapshot restore or a JSON import.
#[tauri::command]
pub fn gs_replace_all(
    app: AppHandle,
    games: Vec<GameRow>,
    profiles: Vec<ProfileRow>,
    tables: Vec<TableRow>,
) -> Result<(), String> {
    snapshot_if_due(&app);
    with_db(&app, |conn| {
        let tx = conn.unchecked_transaction()?;
        tx.execute("DELETE FROM gs_round_score", [])?;
        tx.execute("DELETE FROM gs_round", [])?;
        tx.execute("DELETE FROM gs_game_player", [])?;
        tx.execute("DELETE FROM gs_game", [])?;
        for game in &games {
            write_game(&tx, game)?;
        }
        write_lists(&tx, &profiles, &tables)?;
        tx.commit()?;
        Ok(())
    })
}

/// Moves game-stats.json into the tables, once.
///
/// Only into an EMPTY table, so running twice cannot double anything, and "is
/// it empty" is a question the database answers for itself rather than one a
/// flag in a settings file has to remember. The JSON file is left where it is.
#[tauri::command]
pub fn gs_migrate_from_json(
    app: AppHandle,
    games: Vec<GameRow>,
    profiles: Vec<ProfileRow>,
    tables: Vec<TableRow>,
) -> Result<u32, String> {
    if games.is_empty() {
        return Ok(0);
    }
    with_db(&app, |conn| {
        let existing: i64 = conn.query_row("SELECT count(*) FROM gs_game", [], |r| r.get(0))?;
        if existing > 0 {
            return Ok(0);
        }
        let tx = conn.unchecked_transaction()?;
        for game in &games {
            write_game(&tx, game)?;
        }
        write_lists(&tx, &profiles, &tables)?;
        tx.commit()?;
        Ok(games.len() as u32)
    })
}
