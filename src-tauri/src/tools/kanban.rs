/* =============================================================================
   KANBAN BOARDS: storage, snapshots, background images, attachments
   -----------------------------------------------------------------------------
   WHAT IS IN THIS FILE. The tool's records, as JSON files, plus everything
   that is a file on disk because it is a picture, a video or a document:

   All of it under kanban/ in the data directory:

     kanban-index.json        the board list and the default tag vocabulary.
     kanban-settings.json     preferences.
     kanban-boards/           one file per board: its columns, cards, tags
                              and the settings it overrides.
     kanban-backgrounds/      imported board background images.
     kanban-attachments/      files attached to cards and to comments.
     kanban-attachment-store/ attachments a surviving snapshot still needs.

   Preferences are an ordinary tool file and go through lib.rs's shared store,
   like every other tool's.

   Nothing here is encrypted. The Budget Tracker is the one place in the app
   that encrypts, because it is the one place holding data that normally sits
   behind a bank login.

   Rust commands exposed (a check keeps this list and the file in step):
     save_kanban_index, load_kanban_index,
     save_kanban_board, load_kanban_board, delete_kanban_board,
     list_kanban_backups, read_kanban_backup,
     import_kanban_image, delete_kanban_image, kanban_backgrounds_dir,
     kanban_attachments_dir, import_kanban_attachment, paste_kanban_attachment,
     copy_kanban_attachment, delete_kanban_attachment,
     delete_kanban_board_attachments, sweep_kanban_attachments,
     revive_kanban_attachments, kanban_attachments_exist,
     open_kanban_attachment
============================================================================= */

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::AppHandle;

use crate::{atomic_write, backed_up_write_group, get_data_path};


/// Folder holding imported board backgrounds.
const IMAGE_DIR: &str = "kanban/kanban-backgrounds";

/// Ceiling on a board background. A background is scaled to fill a panel and
/// then blurred, so there is nothing to gain past a couple of thousand pixels
/// on the long edge; this is generous enough for a phone photo straight off
/// the camera and small enough that a dozen boards do not quietly turn the
/// data directory into a photo library.
const MAX_IMAGE_BYTES: u64 = 24 * 1024 * 1024;

/// Image extensions the WebView can actually render. Anything else would copy
/// happily and then show as a blank panel, which reads as a broken tool.
const ALLOWED_IMAGE_EXTS: [&str; 6] = ["png", "jpg", "jpeg", "webp", "gif", "bmp"];

/* =============================================================================
   NAME SAFETY
   -----------------------------------------------------------------------------
   A board id and a snapshot folder name both arrive from the front end and are
   both about to be joined onto a path. "It came from our own list" is not a
   thing to rely on: a hand-edited data file, or a stale screen, can hand back
   anything at all.
============================================================================= */

/// Board ids are UUIDs from crypto.randomUUID(). This deliberately allows a
/// slightly wider alphabet (a migrated or hand-made id might not be a UUID) but
/// admits nothing that can traverse or escape: no dots, no separators, no
/// colons, no spaces.
fn valid_board_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/* =============================================================================
   RECORD STORAGE
   -----------------------------------------------------------------------------
   The board list in one file, each board's contents in its own file.

     kanban-index.json           the board list, plus the default tag vocabulary
     kanban-board-<id>.json      that board's columns, cards, tags and overrides

   These records spent one release in a database and have been brought back
   deliberately. What the split already gave was the thing the database was
   meant to give: a save rewrites ONE board's file and the index, not everything
   you own. What it also gives, and the database took away, is that every single
   write captures the state it is about to replace, and that a board file can be
   opened in a text editor and repaired when something goes wrong.

   Game Stats stayed in the database, because a round and a score there are rows
   worth querying across games. A Kanban board is read whole, drawn whole and
   written whole; there is no query to run against it.
============================================================================= */

/// The board list. Small on purpose: the gallery reads this and nothing else.
const INDEX_FILE: &str = "kanban/kanban-index.json";

/// One folder holding every board file. Boards are the thing there can be
/// fifty of, and fifty files loose beside the index is a folder you cannot
/// read at a glance.
const BOARD_DIR: &str = "kanban/kanban-boards";

/// A board file keeps its "kanban-board-" prefix inside that folder, and that
/// is not redundant: a snapshot bucket is one flat folder, so a captured board
/// and the captured index sit side by side under their basenames alone, with
/// nothing but the name to tell them apart.
fn board_file_name(id: &str) -> String {
    format!("kanban-board-{id}.json")
}

/// That file's path inside the data directory.
fn board_path(id: &str) -> String {
    format!("{BOARD_DIR}/{}", board_file_name(id))
}

/// What a board write snapshots: that board, plus the index. The index is in
/// the group because a board's contents and the index entry naming it are only
/// meaningful as a pair; restoring cards into a board the index has never heard
/// of restores nothing you can reach.
///
/// Everything else you own is deliberately NOT in this group. That is the whole
/// point of the file split: an afternoon of dragging cards around one board
/// costs snapshots of one board.
fn board_group(id: &str) -> Vec<String> {
    vec![board_path(id), INDEX_FILE.to_string()]
}

fn as_refs(v: &[String]) -> Vec<&str> {
    v.iter().map(|s| s.as_str()).collect()
}

#[tauri::command]
pub fn save_kanban_index(app: AppHandle, data: String) -> Result<(), String> {
    backed_up_write_group(&app, &[INDEX_FILE], INDEX_FILE, data.as_bytes())
}

#[tauri::command]
pub fn load_kanban_index(app: AppHandle) -> Result<String, String> {
    match fs::read_to_string(get_data_path(&app, INDEX_FILE)) {
        Ok(content) => Ok(content),
        // No file yet is a new install, not an error.
        Err(_) => Ok(r#"{"boards":[],"tagCategories":[],"tags":[]}"#.to_string()),
    }
}

/// Writes one board's columns and cards.
#[tauri::command]
pub fn save_kanban_board(app: AppHandle, board_id: String, data: String) -> Result<(), String> {
    if !valid_board_id(&board_id) {
        return Err("That board id is not one of ours.".to_string());
    }
    let group = board_group(&board_id);
    backed_up_write_group(&app, &as_refs(&group), &board_path(&board_id), data.as_bytes())
}

/// Reads one board's contents. Returns "null" when there is no file, which the
/// front end reads as a board that has never been saved.
#[tauri::command]
pub fn load_kanban_board(app: AppHandle, board_id: String) -> Result<String, String> {
    if !valid_board_id(&board_id) {
        return Err("That board id is not one of ours.".to_string());
    }
    match fs::read_to_string(get_data_path(&app, &board_path(&board_id))) {
        Ok(content) => Ok(content),
        Err(_) => Ok("null".to_string()),
    }
}

/// Removes a board's contents file. The index entry is removed by the front end
/// rewriting the index; this only deletes the file.
///
/// Snapshotted first, through the ordinary group, so a board deleted by mistake
/// is still in the last snapshot rather than gone.
#[tauri::command]
pub fn delete_kanban_board(app: AppHandle, board_id: String) -> Result<(), String> {
    if !valid_board_id(&board_id) {
        return Err("That board id is not one of ours.".to_string());
    }
    let path = get_data_path(&app, &board_path(&board_id));

    // A write is what triggers a snapshot, and there is no write here, so the
    // snapshot is taken explicitly by writing the board out one last time as an
    // empty husk before removing it. The husk never survives this call.
    let group = board_group(&board_id);
    let _ = backed_up_write_group(&app, &as_refs(&group), &board_path(&board_id), b"null");

    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/* =============================================================================
   SNAPSHOTS
   -----------------------------------------------------------------------------
   One bucket per hour, in kanban/backups, holding a .bak per file that was
   about to be overwritten. Every write inside an hour refreshes that hour's
   bucket, so a bucket holds the LAST state before the gap rather than the
   first. Thirty buckets of KANBAN'S OWN writes are kept, so an afternoon spent
   in another tool cannot evict a month of boards; see backed_up_write_group
   and prune_buckets in lib.rs.
============================================================================= */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KanbanBackupFile {
    /// The .bak filename inside the snapshot folder.
    file: String,
    bytes: u64,
    /// Which board this is, or None for the index.
    board_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KanbanBackup {
    /// The snapshot folder's name, which is its LOCAL timestamp in
    /// "%Y-%m-%d_%H-%M-%S" form (BACKUP_FOLDER_FORMAT in lib.rs).
    name: String,
    files: Vec<KanbanBackupFile>,
}

fn backups_root(app: &AppHandle) -> Option<PathBuf> {
    Some(crate::backups_root(app, crate::tool_dir_of(INDEX_FILE)))
}

/// Filenames inside a snapshot folder, as offered by list_kanban_backups. Digits,
/// letters, dashes, underscores and the dot a filename needs; no separators.
fn valid_backup_file(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 96
        && name.starts_with("kanban")
        && !name.contains("..")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

/// Classifies one captured filename. Returns None for anything that is not
/// restorable Kanban content.
fn classify_backup_file(name: &str) -> Option<Option<String>> {
    let stem = name.strip_suffix(".bak")?;
    if let Some(rest) = stem.strip_prefix("kanban-board-") {
        let id = rest.strip_suffix(".json")?;
        return valid_board_id(id).then(|| Some(id.to_string()));
    }
    /* The index. Compared against the BASENAME, not against INDEX_FILE: that is
       a path inside the data folder now, and a bucket stores a captured file
       under its filename alone.

       The settings file is deliberately not offered: restoring preferences is
       not a recovery, and rewinding them would be a surprise nobody asked for
       when they set out to get a board back. */
    (stem == crate::file_basename(INDEX_FILE)).then_some(None)
}

/// Reads one snapshot folder and describes the Kanban files in it.
fn describe_bucket(dir: &Path) -> Vec<KanbanBackupFile> {
    let mut files: Vec<KanbanBackupFile> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            /* Kanban owns this folder, so nothing else writes into it, but the
               filter still earns its place: it is what decides which of Kanban's
               OWN captured files are restorable, and it deliberately leaves the
               settings file out. Buckets from before snapshots were split per
               tool were sorted into these folders by name, so a stray file is
               possible; one that is not recognized is left alone. */
            let board_id = classify_backup_file(&name)?;
            let bytes = e.metadata().ok()?.len();
            Some(KanbanBackupFile { file: name, bytes, board_id })
        })
        .collect();
    files.sort_by(|a, b| a.file.cmp(&b.file));
    files
}

/// Every snapshot holding at least one Kanban file, newest first.
#[tauri::command]
pub fn list_kanban_backups(app: AppHandle) -> Result<Vec<KanbanBackup>, String> {
    let root = match backups_root(&app) {
        Some(r) => r,
        None => return Ok(vec![]),
    };
    let entries = match fs::read_dir(&root) {
        Ok(e) => e,
        // No backups folder yet is not an error, it is a new install.
        Err(_) => return Ok(vec![]),
    };

    let mut out: Vec<KanbanBackup> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if !crate::valid_bucket_name(&name) {
                return None;
            }
            let files = describe_bucket(&e.path());
            if files.is_empty() {
                None
            } else {
                Some(KanbanBackup { name, files })
            }
        })
        .collect();

    // The folder format sorts correctly as plain strings, so reversing a string
    // sort is a true newest-first ordering with no date parsing.
    out.sort_by(|a, b| b.name.cmp(&a.name));
    Ok(out)
}

/// Returns one captured file's contents, WITHOUT writing anything.
///
/// Deliberately a read and not a restore. Putting it back is an ordinary save,
/// which means the state being replaced is snapshotted on the way past, and a
/// restore of the wrong snapshot is therefore undoable by restoring the one
/// that call just created. A command that copied the file into place directly
/// would skip that and make the recovery tool the thing you needed recovering
/// from.
#[tauri::command]
pub fn read_kanban_backup(app: AppHandle, name: String, file: String) -> Result<String, String> {
    if !crate::valid_bucket_name(&name) {
        return Err("That snapshot name is not one of ours.".to_string());
    }
    if !valid_backup_file(&file) {
        return Err("That snapshot file is not one of ours.".to_string());
    }
    let root = backups_root(&app).ok_or_else(|| "No backups folder.".to_string())?;
    let path = root.join(&name).join(&file);
    fs::read_to_string(&path).map_err(|e| format!("Could not read that snapshot: {e}"))
}


/* =============================================================================
   BOARD BACKGROUND IMAGES
============================================================================= */

fn image_dir(app: &AppHandle) -> PathBuf {
    let dir = get_data_path(app, IMAGE_DIR);
    let _ = fs::create_dir_all(&dir);
    dir
}

/// Where board backgrounds live, so the front end can build asset-protocol URLs
/// for them.
///
/// Asked for rather than assumed, exactly as the attachments folder is: only
/// the back end knows whether this is a dev build or a release one. This is
/// also what lets a board record survive the folder moving, because the record
/// then only has to remember the FILENAME.
#[tauri::command]
pub fn kanban_backgrounds_dir(app: AppHandle) -> String {
    image_dir(&app).to_string_lossy().to_string()
}

/// Lowercased extension of `path`, if it is one we can render.
fn allowed_ext(path: &Path) -> Option<String> {
    let ext = path.extension()?.to_string_lossy().to_lowercase();
    if ALLOWED_IMAGE_EXTS.contains(&ext.as_str()) {
        Some(ext)
    } else {
        None
    }
}

/// Copies a user-picked image into kanban-backgrounds/ and returns the FILENAME
/// of the copy. The name is a timestamp plus a counter rather than the original
/// filename: two boards backed by two different photos both called
/// "background.jpg" must not collide, and the original name is of no interest
/// once the file is inside the app.
///
/// A filename rather than a path, because a path is a guess about the future.
/// Records that stored one stopped working the day the data folder was split
/// per tool: the file moved and every board went on pointing at where it had
/// been. Where the folder is, is a question the back end answers on request
/// (kanban_backgrounds_dir), the way it already does for attachments.
///
/// The background lives outside the board file so the gallery can draw it
/// without reading the board's contents.
#[tauri::command]
pub fn import_kanban_image(app: AppHandle, path: String) -> Result<String, String> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);

    let source = PathBuf::from(&path);
    let ext = allowed_ext(&source).ok_or_else(|| {
        format!(
            "That file is not an image this can show. Pick one of: {}.",
            ALLOWED_IMAGE_EXTS.join(", ")
        )
    })?;

    // Checked from the metadata before reading: the bytes are about to be held
    // in memory in full, so an accidentally-picked disk image should turn into a
    // message rather than an out-of-memory kill.
    let size = fs::metadata(&source)
        .map_err(|e| format!("Could not read that image: {e}"))?
        .len();
    if size > MAX_IMAGE_BYTES {
        return Err(format!(
            "That image is {:.1} MB. The limit for a board background is {} MB.",
            size as f64 / (1024.0 * 1024.0),
            MAX_IMAGE_BYTES / (1024 * 1024)
        ));
    }

    let bytes = fs::read(&source).map_err(|e| format!("Could not read that image: {e}"))?;

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let dest = image_dir(&app).join(format!("bg-{stamp}-{n}.{ext}"));

    // Through atomic_write for the same reason every other write is: a
    // half-copied background that the board already points at would render as a
    // broken panel with no obvious cause.
    atomic_write(&dest, &bytes)?;
    Ok(dest
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default())
}

/// Removes a background image the tool imported.
///
/// The path is checked to be inside kanban-backgrounds/ before anything is
/// unlinked. This command takes a path from the front end and deletes it; the
/// board's stored path is the only thing that should ever reach it, but a stale
/// board record or a hand-edited index must not be able to turn this into a
/// general-purpose delete.
#[tauri::command]
pub fn delete_kanban_image(app: AppHandle, path: String) -> Result<(), String> {
    let dir = image_dir(&app);
    /* A BARE FILENAME IS RESOLVED HERE, an absolute path is taken as given and
       then checked. Board records written before the data folder was split per
       tool hold an absolute path into the OLD flat layout, so joining a record's
       whole path would look for a file that moved; taking its filename finds the
       one that exists. Either way the containment check below is what decides. */
    let target = match Path::new(&path).file_name() {
        Some(name) if Path::new(&path).parent().is_none_or(|p| p.as_os_str().is_empty()) => {
            dir.join(name)
        }
        _ => PathBuf::from(&path),
    };

    // canonicalize resolves "..", symlinks and short paths, so the containment
    // check is on where the path actually LANDS rather than on how it reads. A
    // target that no longer exists cannot be canonicalized and is also nothing
    // to delete, so it succeeds quietly.
    let target = match target.canonicalize() {
        Ok(p) => p,
        Err(_) => return Ok(()),
    };
    let dir = dir
        .canonicalize()
        .map_err(|e| format!("Could not resolve the image folder: {e}"))?;
    if !target.starts_with(&dir) {
        return Err("That file is not a board background.".to_string());
    }

    // Best-effort: a background that will not delete (open in a viewer, say) is
    // not a reason to fail the board edit that triggered it.
    let _ = fs::remove_file(&target);
    Ok(())
}

/* =============================================================================
   CARD ATTACHMENTS
   -----------------------------------------------------------------------------
   A file hung off a card or off one of its comments. The tool copies it into
   its own folder and from then on owns that copy, so the original can be moved,
   renamed or thrown away without the card losing anything.

   WHERE A FILE LIVES, and why the layout is what makes deletion correct.

       kanban-attachments/<boardId>/<attachmentId>

   The location is DERIVED from the board and the attachment id. Nothing stores
   a path, which is the whole point: a card record cannot point at a file
   outside its own board's folder, because it does not carry a pointer at all.
   Three things follow for free, and each of them was a bug in the first cut:

     • Deleting a board deletes one folder, without needing that board's cards
       in memory to know which files were its.
     • Restoring an older snapshot of a board cannot resurrect a card pointing
       at a stranger's file, because ids are board-scoped by construction.
     • Anything in a board's folder that no card mentions is garbage, provably,
       so it can be swept (see sweep_kanban_attachments).

   THE NAME ON DISK IS NOT THE NAME ON SCREEN. The copy is named by the
   attachment's id and the original filename travels in the card's record. Two
   people's "screenshot.png" must not collide, and a filename is a place path
   traversal hides.

   Nothing in this tool is encrypted. The Budget Tracker is the one place in the
   app that encrypts, because it is the one place holding data that normally
   sits behind a bank login.
============================================================================= */

/// Folder under the data directory holding attached files.
const ATTACH_DIR: &str = "kanban/kanban-attachments";

/// Ceiling on one attachment. Large enough for a screen recording of a bug,
/// small enough that a board's folder cannot quietly outgrow the snapshots
/// around it, and small enough that a mis-picked file is cheap to undo.
const MAX_ATTACHMENT_BYTES: u64 = 256 * 1024 * 1024;

/// What an attachment looks like to the front end once it has been stored.
/// There is no path: where it lives is derived from the board and the id.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedAttachment {
    id: String,
    name: String,
    size: u64,
    /// What the copy is actually called inside its board's folder: the id plus
    /// the original file's extension. Kept on the card so the front end can
    /// point at it without guessing. See stored_name.
    file: String,
}

/* -----------------------------------------------------------------------------
   PATHS
----------------------------------------------------------------------------- */

/// Attachment ids are UUIDs from crypto.randomUUID(), same alphabet and same
/// reasoning as valid_board_id: nothing that can traverse or escape.
fn valid_attachment_id(id: &str) -> bool {
    valid_board_id(id)
}

fn attach_root(app: &AppHandle) -> PathBuf {
    let dir = get_data_path(app, ATTACH_DIR);
    let _ = fs::create_dir_all(&dir);
    dir
}

/// One board's folder, created on demand.
fn board_attach_dir(app: &AppHandle, board_id: &str) -> Result<PathBuf, String> {
    if !valid_board_id(board_id) {
        return Err("That board id is not one of ours.".to_string());
    }
    let dir = attach_root(app).join(board_id);
    fs::create_dir_all(&dir).map_err(|e| format!("Could not open the attachments folder: {e}"))?;
    Ok(dir)
}

/* THE COPY KEEPS THE ORIGINAL'S EXTENSION, and it has to.
   -----------------------------------------------------------------------------
   The file used to be stored under the bare attachment id, with the extension
   deliberately dropped, on the reasoning that the original name was of no
   interest once the file was inside the app. That is true of the NAME and false
   of the EXTENSION, because on Windows the extension is the file's type.

   Previews survived it, because Tauri's asset protocol sniffs the leading bytes
   and answers with a content type it worked out for itself. Opening did not: the
   Open button hands the path to the shell, and a file with no extension has
   nothing for the shell to associate, so a .pdf or a .docx landed on "How do you
   want to open this file?" instead of in the program that owns it.

   So the copy is <attachmentId>.<ext>. The id is still what names it, which is
   what keeps a card unable to point outside its own board; the extension is
   carried along beside it. Anything already stored under a bare id still opens:
   every lookup checks the exact id first and then anything that is the id plus
   an extension, so nothing has to be renamed on disk. */

/// The extension of `source`, lowercased and reduced to something that can only
/// ever be an extension. Empty when there is nothing usable.
fn stored_ext(source: &Path) -> String {
    let ext = match source.extension().and_then(|e| e.to_str()) {
        Some(e) => e.to_lowercase(),
        None => return String::new(),
    };
    // Letters and digits only, and short. An "extension" carrying a separator,
    // a dot or a device name is not one, and this string is about to be joined
    // onto a path.
    if ext.is_empty()
        || ext.len() > 16
        || !ext.chars().all(|c| c.is_ascii_alphanumeric())
        || crate::is_reserved_device_name(&ext)
    {
        return String::new();
    }
    ext
}

/// What one attachment's copy is called on disk.
fn stored_name(attachment_id: &str, source: &Path) -> String {
    let ext = stored_ext(source);
    if ext.is_empty() {
        attachment_id.to_string()
    } else {
        format!("{attachment_id}.{ext}")
    }
}

/// Every filename in `dir` that belongs to this attachment: the bare id, as
/// stored before extensions were kept, and the id plus any one extension.
///
/// Ordered exact-first, so a folder somehow holding both answers the same way
/// every lookup does.
fn attachment_files(dir: &Path, attachment_id: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let exact = dir.join(attachment_id);
    if exact.is_file() {
        out.push(exact);
    }
    let prefix = format!("{attachment_id}.");
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            // Not the half-written temp from an interrupted copy.
            if name.starts_with(&prefix) && !name.ends_with(".part") && entry.path().is_file() {
                out.push(entry.path());
            }
        }
    }
    out
}

/// Where an attachment is, if it is anywhere.
fn find_attachment(
    app: &AppHandle,
    board_id: &str,
    attachment_id: &str,
) -> Result<Option<PathBuf>, String> {
    if !valid_board_id(board_id) || !valid_attachment_id(attachment_id) {
        return Err("That attachment is not one of ours.".to_string());
    }
    let dir = attach_root(app).join(board_id);
    Ok(attachment_files(&dir, attachment_id).into_iter().next())
}

/// The original filename, for display. Reduced to one path component and
/// trimmed, so nothing that arrives here can be read back as a path later.
fn display_name(path: &Path) -> String {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    let cleaned: String = name
        .chars()
        .filter(|c| !matches!(c, '/' | '\\' | '\0'))
        .take(120)
        .collect();
    if cleaned.trim().is_empty() {
        "file".to_string()
    } else {
        cleaned
    }
}

/* -----------------------------------------------------------------------------
   IMPORT, COPY, DELETE
----------------------------------------------------------------------------- */

/// Puts a file into the board's folder under `attachment_id`.
///
/// Written under a temporary name and renamed into place, so a copy interrupted
/// half way never appears under the name a card points at. The copy is streamed
/// rather than read into memory, which is why an attachment can be a screen
/// recording rather than something that has to fit in RAM.
/// `type_from` is what the extension is taken from, which is not always the
/// file being copied: a pasted image is staged under a temporary name, and it
/// is the name the paste was given that says what it is.
fn store_attachment(
    app: &AppHandle,
    board_id: &str,
    attachment_id: &str,
    source: &Path,
    type_from: &Path,
) -> Result<String, String> {
    let dir = board_attach_dir(app, board_id)?;
    if !valid_attachment_id(attachment_id) {
        return Err("That attachment id is not one of ours.".to_string());
    }
    let name = stored_name(attachment_id, type_from);
    let final_path = dir.join(&name);
    let temp = dir.join(format!("{attachment_id}.part"));

    if let Err(e) = fs::copy(source, &temp) {
        let _ = fs::remove_file(&temp);
        return Err(format!("Could not copy that file: {e}"));
    }
    if let Err(e) = fs::rename(&temp, &final_path) {
        let _ = fs::remove_file(&temp);
        return Err(format!("Could not store that file: {e}"));
    }
    Ok(name)
}

/// Where the attachments folder is, so the front end can build asset-protocol
/// URLs for the files in it.
///
/// Asked for rather than assumed: only the back end knows whether this is a dev
/// build (data beside the repo) or a release one (the app data directory), and
/// a front end guessing at that would work in exactly one of the two.
#[tauri::command]
pub fn kanban_attachments_dir(app: AppHandle) -> String {
    attach_root(&app).to_string_lossy().to_string()
}

/// Copies a user-picked file into its board's folder and describes the copy.
///
/// Any file type is accepted. The front end decides how to SHOW it, and a type
/// it cannot preview still attaches and still opens in whatever program owns
/// it, which is the useful answer for a .docx or a .zip.
#[tauri::command]
pub fn import_kanban_attachment(
    app: AppHandle,
    board_id: String,
    attachment_id: String,
    path: String,
) -> Result<ImportedAttachment, String> {
    let source = PathBuf::from(&path);

    // From the metadata, before any copying: a mis-picked 40 GB file should be
    // a sentence on screen rather than a full disk.
    let size = fs::metadata(&source)
        .map_err(|e| format!("Could not read that file: {e}"))?
        .len();
    if size > MAX_ATTACHMENT_BYTES {
        return Err(format!(
            "That file is {:.1} MB. The limit for one attachment is {} MB.",
            size as f64 / (1024.0 * 1024.0),
            MAX_ATTACHMENT_BYTES / (1024 * 1024)
        ));
    }

    let file = store_attachment(&app, &board_id, &attachment_id, &source, &source)?;
    Ok(ImportedAttachment {
        id: attachment_id,
        name: display_name(&source),
        size,
        file,
    })
}

/// Stores an image pasted from the clipboard. Same store, different doorway:
/// there is no file on disk to copy from, so the bytes arrive base64'd and are
/// written to a temporary first.
///
/// Base64 rather than a raw byte array over IPC because the byte array form
/// serializes as JSON numbers, which is roughly seven bytes on the wire per
/// byte of image. A pasted screenshot is small enough that base64's extra third
/// is the cheaper of the two.
#[tauri::command]
pub fn paste_kanban_attachment(
    app: AppHandle,
    board_id: String,
    attachment_id: String,
    name: String,
    data_base64: String,
) -> Result<ImportedAttachment, String> {
    // Checked on the ENCODED length first. Decoding allocates three bytes for
    // every four that arrive, so measuring afterwards means the oversized paste
    // has already been built in memory before anything refuses it.
    if data_base64.len() as u64 > MAX_ATTACHMENT_BYTES / 3 * 4 + 4096 {
        return Err(format!(
            "That image is larger than the {} MB limit for one attachment.",
            MAX_ATTACHMENT_BYTES / (1024 * 1024)
        ));
    }
    let bytes = crate::base64_decode(&data_base64)
        .map_err(|_| "That image did not arrive intact.".to_string())?;
    let size = bytes.len() as u64;
    if size == 0 {
        return Err("There was no image on the clipboard.".to_string());
    }

    // Through a temporary so the paste path and the file-picker path are the
    // same one store, rather than two that could drift.
    let temp = attach_root(&app).join(format!("paste-{attachment_id}.tmp"));
    fs::write(&temp, &bytes).map_err(|e| format!("Could not stage that image: {e}"))?;
    // The extension comes from the name the paste was given, not from the
    // staging file: "paste-<id>.tmp" would store every screenshot as a .tmp.
    let stored = store_attachment(&app, &board_id, &attachment_id, &temp, Path::new(&name));
    let _ = fs::remove_file(&temp);
    let file = stored?;

    Ok(ImportedAttachment {
        id: attachment_id,
        name: display_name(Path::new(&name)),
        size,
        file,
    })
}

/// Copies an attachment the tool already owns, for duplicating a card or moving
/// one to another board.
///
/// A duplicate must not share its original's file: removing the attachment from
/// either card would then unlink the bytes the other one is still showing, and
/// the second card would go quietly broken at a moment unrelated to anything
/// the user did to it.
#[tauri::command]
pub fn copy_kanban_attachment(
    app: AppHandle,
    from_board_id: String,
    to_board_id: String,
    from_attachment_id: String,
    to_attachment_id: String,
) -> Result<String, String> {
    let source = find_attachment(&app, &from_board_id, &from_attachment_id)?
        .ok_or_else(|| "That attachment is no longer on disk.".to_string())?;
    // Returns what the copy is called, because the copy carries its own id and
    // therefore its own filename, and the card pointing at it needs to know.
    store_attachment(&app, &to_board_id, &to_attachment_id, &source, &source)
}

/// Whether each of these attachments is still on disk.
///
/// Answered in one call rather than one per file: a card with a dozen
/// attachments would otherwise make a dozen round trips every time it is opened.
#[tauri::command]
pub fn kanban_attachments_exist(
    app: AppHandle,
    board_id: String,
    attachment_ids: Vec<String>,
) -> Vec<bool> {
    attachment_ids
        .iter()
        .map(|id| matches!(find_attachment(&app, &board_id, id), Ok(Some(_))))
        .collect()
}

/// Opens an attachment in whatever program owns its type.
///
/// Routed through Rust rather than through the opener plugin's own command,
/// which is why `opener:allow-open-path` is NOT in the app's capabilities: that
/// permission would let the WebView ask the system to open any path at all.
/// This is the same capability narrowed to one folder, checked here.
#[tauri::command]
pub fn open_kanban_attachment(
    app: AppHandle,
    board_id: String,
    attachment_id: String,
    name: String,
) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    /* `name` is the ORIGINAL filename and is not what finds the file: the copy
       is named by its id. It stays in the signature because it is what the
       front end has, and because a copy stored before extensions were kept has
       nothing for the shell to associate; the fallback below uses it. */
    let path = find_attachment(&app, &board_id, &attachment_id)?
        .ok_or_else(|| "That file is no longer on disk.".to_string())?;

    /* A copy stored before extensions were kept has no type for the shell to
       look up, so it would open the "how do you want to open this" picker. For
       those, and only those, a correctly named copy is put in a temp folder and
       that is what opens. It is a copy: edits made in whatever opens it do not
       come back, which is the honest cost of a file that was stored without its
       type. Anything attached since keeps its extension and opens in place. */
    let target = if path.extension().is_none() {
        handoff_copy(&path, &name).unwrap_or(path)
    } else {
        path
    };

    app.opener()
        .open_path(target.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| format!("Could not open that file: {e}"))
}

/// A correctly named copy of an extension-less attachment, in its own temp
/// folder so two files called "report.pdf" cannot land on each other.
fn handoff_copy(path: &Path, display: &str) -> Option<PathBuf> {
    let name = display_name(Path::new(display));
    // No extension on the original name either: nothing to gain from a copy,
    // so the original opens and the shell asks what to use.
    Path::new(&name).extension()?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("swiss-rb-knife-open-{stamp}"));
    fs::create_dir_all(&dir).ok()?;
    let dest = dir.join(name);
    fs::copy(path, &dest).ok()?;
    Some(dest)
}

/// Removes one attachment's file.
#[tauri::command]
pub fn delete_kanban_attachment(
    app: AppHandle,
    board_id: String,
    attachment_id: String,
) -> Result<(), String> {
    if let Some(path) = find_attachment(&app, &board_id, &attachment_id)? {
        // Retired rather than unlinked, so the snapshot taken before this
        // delete can still be restored with its files. See the store's note.
        retire_attachment(&app, &board_id, &path);
    }
    Ok(())
}

/// Removes every attachment a board owns, folder and all.
#[tauri::command]
pub fn delete_kanban_board_attachments(app: AppHandle, board_id: String) -> Result<(), String> {
    if !valid_board_id(&board_id) {
        return Err("That board id is not one of ours.".to_string());
    }
    let dir = attach_root(&app).join(&board_id);
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            if entry.path().is_file() {
                retire_attachment(&app, &board_id, &entry.path());
            }
        }
    }
    // Whatever would not move is removed with the folder: the board is gone
    // either way, and a folder for a board that no longer exists is litter.
    if dir.is_dir() {
        let _ = fs::remove_dir_all(&dir);
    }
    Ok(())
}

/// Deletes anything in a board's folder that no card mentions, and reports how
/// many went.
///
/// The guarantee behind "delete the card and the file goes". Every other path
/// deletes the file at the same moment it drops the record, but a crash between
/// the two, a snapshot restored from before the file existed, or a board file
/// hand-edited leaves an orphan, and an orphan is unreachable by definition. The
/// front end calls this after loading a board, when it has the full list of ids
/// that board should own.
#[tauri::command]
pub fn sweep_kanban_attachments(
    app: AppHandle,
    board_id: String,
    keep: Vec<String>,
) -> Result<u32, String> {
    if !valid_board_id(&board_id) {
        return Err("That board id is not one of ours.".to_string());
    }
    let dir = attach_root(&app).join(&board_id);
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        // No folder is not an error, it is a board with no attachments.
        Err(_) => return Ok(0),
    };
    let keep: std::collections::HashSet<&str> = keep.iter().map(|s| s.as_str()).collect();

    let mut removed = 0u32;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if keep.contains(name.as_str()) {
            continue;
        }
        // Swept files are retired too. An orphan is usually the tail of a
        // delete that already happened, but it can also be the file a board
        // snapshot is about to be restored ON TOP of, and unlinking it here
        // would beat the restore to it. ".part" leftovers go the same way.
        retire_attachment(&app, &board_id, &entry.path());
        removed += 1;
    }
    Ok(removed)
}

/* -----------------------------------------------------------------------------
   THE RETIRED-ATTACHMENT STORE
   -----------------------------------------------------------------------------
   What makes restoring a Kanban snapshot actually bring the files back.

   A board's cards are snapshotted on every write: the hour you delete a card,
   the previous hour's bucket still has it. Its FILES had no equivalent, so a
   restore brought back a card pointing at bytes that were unlinked the moment
   you deleted it.

   Copying every attachment into every bucket is not the answer. Thirty hourly
   buckets of a 64 MB video is two gigabytes, for a file that never changes.

   So nothing is copied on write at all. Instead, NOTHING IS EVER DESTROYED IN
   PLACE: the instant before an attachment file would be unlinked or overwritten,
   it is MOVED here. Adding an attachment costs nothing. Editing a card costs
   nothing. Only a delete does any work, and it is a rename rather than a copy.
   One copy of the bytes exists at any moment, either live or retired.

       kanban-attachment-store/<boardId>/<attachmentId>[.<ext>]

   The name is whatever the file was called live, so a retired file goes back
   under the name the card is pointing at. Anything retired before attachments
   kept their extension is there under the bare id, and still revives.

   WHEN A RETIRED FILE IS FINALLY GONE. A file retired at time T can only be
   wanted by a snapshot taken BEFORE T, because every snapshot after T was taken
   of a board that no longer had it. So once the oldest surviving bucket is
   newer than T, nothing can ask for it again and it goes.

   That is why its modified time is the whole record. There is no manifest to
   keep in step, nothing to write on save, and no way for the bookkeeping to
   disagree with the files, which is the failure this tool's history is most
   full of.
----------------------------------------------------------------------------- */

/// Folder under the data directory holding attachments that have left a board
/// but that a surviving snapshot may still reference.
const ATT_STORE_DIR: &str = "kanban/kanban-attachment-store";

fn store_dir(app: &AppHandle, board_id: &str) -> Option<PathBuf> {
    if !valid_board_id(board_id) {
        return None;
    }
    let dir = get_data_path(app, ATT_STORE_DIR).join(board_id);
    fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// Moves an attachment file out of the live folder and into the store, instead
/// of unlinking it.
///
/// Best effort throughout, and deliberately so: this runs on the delete path,
/// where the card is already gone from the board in memory. A file that will
/// not move (open in a viewer, say) must not fail the edit that triggered it.
/// The cost of failing here is one unrecoverable attachment, and the cost of
/// propagating the error is a card that will not delete.
fn retire_attachment(app: &AppHandle, board_id: &str, live_path: &Path) {
    let name = match live_path.file_name() {
        Some(n) => n.to_os_string(),
        None => return,
    };
    let dir = match store_dir(app, board_id) {
        Some(d) => d,
        None => {
            let _ = fs::remove_file(live_path);
            return;
        }
    };
    let dest = dir.join(&name);

    // A rename, so retiring a 64 MB video costs what renaming a file costs.
    // Both paths are inside the app's own data directory, so this is always
    // within one volume; the copy is a fallback for the impossible case rather
    // than an expected route.
    if fs::rename(live_path, &dest).is_ok() {
        // The modified time IS the retirement record, and a rename carries the
        // original across. Stamped to now so the prune below measures how long
        // ago the file LEFT, not when it was first attached.
        let _ = fs::File::options().write(true).open(&dest).and_then(|f| {
            f.set_modified(std::time::SystemTime::now())?;
            Ok(())
        });
        return;
    }
    if fs::copy(live_path, &dest).is_ok() {
        let _ = fs::remove_file(live_path);
    } else {
        // Nowhere to put it and no way to keep it. Better an unrecoverable
        // delete than a card that cannot be deleted.
        let _ = fs::remove_file(live_path);
    }
}

/// Puts a retired attachment back, for a snapshot restore that needs it.
/// Copies rather than moves: the same file may be wanted by more than one
/// restore, and until it is pruned it still belongs to the store.
fn revive_attachment(app: &AppHandle, board_id: &str, attachment_id: &str) -> bool {
    let dir = match store_dir(app, board_id) {
        Some(d) => d,
        None => return false,
    };
    let live_dir = match board_attach_dir(app, board_id) {
        Ok(d) => d,
        Err(_) => return false,
    };
    /* Whatever the store has under this id, which is the bare id for anything
       retired before extensions were kept and id.ext for everything since. It
       goes back under the name it was retired with, so a revived file is the
       same file the card was pointing at. */
    for from in attachment_files(&dir, attachment_id) {
        let Some(name) = from.file_name() else { continue };
        if fs::copy(&from, live_dir.join(name)).is_ok() {
            return true;
        }
    }
    false
}

/// Drops retired files that no surviving snapshot could still ask for.
///
/// Called after the backup pruner has dropped the oldest buckets, which is the
/// only moment the answer changes. See the section note for why a modified time
/// is the whole test.
/// Takes the DATA ROOT rather than an AppHandle, because the one caller is
/// lib.rs's snapshot pruner, which is a plain function working on paths.
///
/// It used to take the backups folder and walk up to find the data root. That
/// worked only while backups sat at the top of it; now that each tool has its
/// own, walking up from kanban/backups lands in kanban/ and the store would be
/// looked for at kanban/kanban/kanban-attachment-store.
pub fn prune_kanban_attachment_store(data_root: &Path, cutoff: std::time::SystemTime) {
    let root = data_root.join(ATT_STORE_DIR);

    let boards = match fs::read_dir(&root) {
        Ok(e) => e,
        Err(_) => return,
    };
    for board in boards.flatten() {
        let dir = board.path();
        if !dir.is_dir() {
            continue;
        }
        let files = match fs::read_dir(&dir) {
            Ok(f) => f,
            Err(_) => continue,
        };
        let mut left = 0u32;
        for file in files.flatten() {
            let retired_at = file
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or_else(|_| std::time::SystemTime::now());
            if retired_at < cutoff {
                let _ = fs::remove_file(file.path());
            } else {
                left += 1;
            }
        }
        // A board whose every retired file has aged out leaves no empty folder
        // behind to accumulate.
        if left == 0 {
            let _ = fs::remove_dir(&dir);
        }
    }
}

/// Puts back every attachment a restored board expects and does not have.
///
/// Called by the front end after restoring a board snapshot, with the ids that
/// snapshot's cards actually reference. Reports how many came back, so the
/// restore can say so rather than leaving someone to discover it.
#[tauri::command]
pub fn revive_kanban_attachments(
    app: AppHandle,
    board_id: String,
    attachment_ids: Vec<String>,
) -> Result<u32, String> {
    if !valid_board_id(&board_id) {
        return Err("That board id is not one of ours.".to_string());
    }
    let mut revived = 0u32;
    for id in attachment_ids {
        if !valid_attachment_id(&id) {
            continue;
        }
        // Only what is actually missing. A restore that changes nothing about
        // an attachment should not touch its file.
        if matches!(find_attachment(&app, &board_id, &id), Ok(Some(_))) {
            continue;
        }
        if revive_attachment(&app, &board_id, &id) {
            revived += 1;
        }
    }
    Ok(revived)
}


#[cfg(test)]
mod tests {
    use super::*;


    #[test]
    fn a_board_id_is_a_name_and_never_a_path() {
        assert!(valid_board_id("0f8fad5b-d9cb-469f-a165-70867728950e"));
        assert!(valid_board_id("board_1"));
        for bad in [
            "",
            "..",
            "../../kanban-index",
            r"..\..\budget-data",
            "a/b",
            r"a\b",
            // A dot is excluded specifically because the id is interpolated
            // into "kanban-board-{id}.json": an id ending ".enc" would otherwise
            // let a plaintext save write over an envelope's name.
            "id.enc",
            "C:",
            &"a".repeat(65),
        ] {
            assert!(!valid_board_id(bad), "should have rejected {bad:?}");
        }
    }


    #[test]
    fn only_image_types_the_webview_can_draw_are_importable() {
        // A file that copies happily and then renders as a blank panel reads to
        // the user as a broken tool, so the extension is checked up front.
        for good in ["a.png", "a.JPG", "a.jpeg", "a.WebP", "a.gif", "a.bmp"] {
            assert!(allowed_ext(Path::new(good)).is_some(), "{good} should import");
        }
        for bad in ["a.svg", "a.tiff", "a.heic", "a.pdf", "a.exe", "noextension"] {
            assert!(
                allowed_ext(Path::new(bad)).is_none(),
                "{bad} should not import"
            );
        }
    }

    #[test]
    fn the_displayed_filename_can_never_be_read_back_as_a_path() {
        // This string is stored in the card and shown as a label. It is never
        // joined onto anything, but a label carrying separators is one refactor
        // away from being treated as a path, so it is reduced here.
        assert_eq!(display_name(Path::new("C:/tmp/report.pdf")), "report.pdf");
        assert!(!display_name(Path::new("C:/tmp/report.pdf")).contains('/'));
        // Nothing usable left over still produces something clickable.
        assert_eq!(display_name(Path::new("/")), "file");
    }

    #[test]
    fn the_extension_comes_back_lowercased() {
        // It is used to build the stored filename, so a mixed-case source must
        // not produce "bg-123-0.JPG" alongside "bg-124-0.jpg".
        assert_eq!(allowed_ext(Path::new("photo.JPEG")).as_deref(), Some("jpeg"));
    }

}
