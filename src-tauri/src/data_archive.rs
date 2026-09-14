/* =============================================================================
   WHOLE-FOLDER EXPORT AND IMPORT
   -----------------------------------------------------------------------------
   One zip of the app's entire data folder, and one way to put it back.

   WHY THIS REPLACED THE PER-TOOL EXPORT. The Data tab used to hold a dropdown
   of tools, each with its own hand-written pair of functions saying what to
   gather and how to apply it. Seven pairs is seven things to keep correct, and
   every one of them was a promise that a JSON file held everything that tool
   owned. Some of those promises were quietly partial: an export carried a
   tool's records but not its snapshots, not its attachments, and not the
   settings that decide how its records are read.

   A zip of the folder makes no promise it cannot keep. It is the folder. You
   can open it in Explorer and see exactly what you have, which is the part
   that matters: a backup you cannot inspect is a backup you are trusting
   rather than one you have checked.

   IT ALSO SOLVES ENCRYPTION FOR FREE. Budget's files are copied byte for byte,
   so an encrypted budget stays encrypted inside the archive. The old per-tool
   path had to decrypt into memory to gather, which meant an export in the
   clear from a tool the user had deliberately locked. That was answered with a
   sentence under the button admitting it, and later with a bespoke sealing
   format; copying the bytes needs neither.

   WHY AN IMPORT NEEDS A RESTART. Replacing the folder means replacing files
   the running app is holding open: the SQLite connection Game Stats keeps, and
   settings.json, which several owners write to. It would also leave every tool
   in the front end holding state that no longer matches the disk, and there is
   no honest way to re-hydrate all of that in place.

   So an import is TWO PHASES. Here, now: unpack into a staging folder beside
   the data folder and leave it there. On the next launch, before anything has
   opened a file: swap it in. The app restarts itself between the two, which is
   why `take_pending_import` is the very first thing setup() calls.

   UNPACKING IS NOT AGREEING. The archive is unpacked before the user is asked
   anything, so that a bad one is refused while the live folder is untouched,
   which means a full copy of their data is staged before they have said yes.
   The swap therefore keys off a marker file that only `restart_for_import`
   writes, not off the staging folder existing. Declining the confirmation
   leaves an inert copy on disk and changes nothing.

   NOTHING IS DELETED. The swap RENAMES the current folder aside rather than
   removing it, so the state an import replaced is still on disk afterwards and
   an import you regret is undone by hand. The three most recent are kept.

   THE ARCHIVE IS PLAIN ZIP, DEFLATE ONLY, on purpose. See the note on the
   dependency in Cargo.toml: the point of shipping a format every tool on earth
   can open is lost the moment it needs this app to read it.
============================================================================= */

use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::{data_root, file_timestamp, DATA_SCHEMA_VERSION};

/* -----------------------------------------------------------------------------
   NAMES AND LIMITS
----------------------------------------------------------------------------- */

/// Written into every archive this app makes, and required on the way back in.
/// A zip without it is somebody else's zip, and unpacking one over the data
/// folder is the single most destructive thing this app can do.
const MANIFEST: &str = "srbk-export.json";

/// Suffix for the staging folder an import unpacks into, appended to the data
/// folder's own name so the two sit together: in a release build the data
/// folder is %APPDATA%\Roaming\swiss-rb-knife, and a bare "srbk-incoming"
/// would appear in Roaming as a stray folder with no obvious owner.
///
/// A SIBLING rather than a child, because the swap is a rename of the data
/// folder itself and a child would be renamed away with it.
const INCOMING_SUFFIX: &str = ".srbk-incoming";

/// Written inside the staging folder when, and only when, the user has agreed
/// to apply it. See `restart_for_import`.
const READY_MARKER: &str = "srbk-apply-me";

/// Suffix for a folder an import set aside, followed by the house timestamp.
/// Beside the data folder and named after it, for the same reason.
const REPLACED_SUFFIX: &str = ".srbk-replaced-";

/// How many replaced folders survive. Enough to undo the import you just did
/// and the one before it; not so many that a folder of attachments accumulates
/// without limit.
const KEEP_REPLACED: usize = 3;

/// Refused above this, uncompressed. A data folder that has genuinely grown
/// past this is a case worth looking at by hand rather than one to unpack
/// silently, and the cap is what stops a hand-made zip claiming to be an
/// export from filling the disk.
const MAX_TOTAL_BYTES: u64 = 8 * 1024 * 1024 * 1024;

/// Refused above this, per entry, for the same reason.
const MAX_ENTRY_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/* -----------------------------------------------------------------------------
   THE MANIFEST
----------------------------------------------------------------------------- */

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    /// Checked on import. Anything else is not one of ours.
    app: String,
    /// The app version that wrote it, for a human reading the file.
    app_version: String,
    /// The data-folder shape, checked the same way the folder's own stamp is:
    /// an archive from a build that arranges things differently is refused
    /// rather than unpacked into a shape this build would then rearrange.
    schema: u32,
    exported_at: String,
    /// Counts, so the import can say what it is about to put back before it
    /// does, and so a truncated archive is visible as a mismatch.
    file_count: u64,
    total_bytes: u64,
}

const APP_TAG: &str = "swiss-rb-knife";

/* -----------------------------------------------------------------------------
   WHAT THE DATA TAB SHOWS
----------------------------------------------------------------------------- */

/// A readout of the folder as it stands, so the screen can say what an export
/// would contain before anyone presses anything.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataSummary {
    file_count: u64,
    total_bytes: u64,
    /// Shown so the user can go and look at it themselves.
    path: String,
}

#[tauri::command(async)]
pub fn app_data_summary(app: AppHandle) -> Result<DataSummary, String> {
    let root = data_root(&app);
    let mut files = Vec::new();
    collect_files(&root, &root, &mut files)?;
    Ok(DataSummary {
        file_count: files.len() as u64,
        total_bytes: files.iter().map(|(_, size)| size).sum(),
        path: root.to_string_lossy().to_string(),
    })
}

/// Every file under `dir`, as (path relative to `root`, size in bytes).
///
/// Follows no symlinks and descends no reparse point: a junction pointing
/// somewhere else on the disk would otherwise put that somewhere else in the
/// user's backup, and could put it in a loop.
fn collect_files(
    root: &Path,
    dir: &Path,
    out: &mut Vec<(PathBuf, u64)>,
) -> Result<(), String> {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        // A folder that is not there yet is not an error: it is a tool that has
        // never been used.
        Err(_) => return Ok(()),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_dir() {
            collect_files(root, &path, out)?;
        } else if meta.is_file() {
            let rel = path
                .strip_prefix(root)
                .map_err(|_| "a file resolved outside the data folder".to_string())?;
            out.push((rel.to_path_buf(), meta.len()));
        }
    }
    Ok(())
}

/* -----------------------------------------------------------------------------
   EXPORT
----------------------------------------------------------------------------- */

/// Zips the whole data folder to a file the user picks, returning where it
/// landed. `Ok(None)` means the dialog was canceled, which is not an error.
///
/// The dialog is opened HERE rather than taking a path from the front end, for
/// the reason export_tool_json states and this inherits: this process runs as
/// Administrator, so a destination it was handed would be a write-anywhere
/// command with nothing but a convention in front of it.
///
/// `#[tauri::command(async)]` on a sync function is what puts this on a worker
/// thread. The blocking dialog must not run on the main thread, and neither
/// should zipping a folder that may hold a lot of attachments.
#[tauri::command(async)]
pub fn export_app_data(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let root = data_root(&app);
    let mut files = Vec::new();
    collect_files(&root, &root, &mut files)?;

    let suggested = format!("swiss-rb-knife-data-{}.zip", file_timestamp());
    let picked = app
        .dialog()
        .file()
        .set_title("Export Data")
        .set_file_name(suggested)
        .add_filter("Zip archive", &["zip"])
        .blocking_save_file();
    let Some(dest) = picked.and_then(|p| p.as_path().map(|p| p.to_path_buf())) else {
        return Ok(None);
    };

    /* Written to a temp name beside the destination and renamed at the end, so
       an export interrupted half way never leaves a file that looks like a
       complete backup. This is the same reasoning as atomic_write, done by
       hand because the payload is streamed rather than held in memory: a data
       folder with attachments in it does not want to be a Vec<u8>.

       The ".tmp-<pid>" suffix is the house staging name, per process so two
       exports running at once cannot land on each other's temp file. */
    let staging = dest.with_extension(format!("tmp-{}", std::process::id()));
    write_archive(&root, &files, &staging).inspect_err(|_| {
        let _ = fs::remove_file(&staging);
    })?;
    if dest.exists() {
        fs::remove_file(&dest).map_err(|e| format!("could not replace that file: {e}"))?;
    }
    fs::rename(&staging, &dest).map_err(|e| {
        let _ = fs::remove_file(&staging);
        format!("could not finish writing the archive: {e}")
    })?;

    Ok(Some(dest.to_string_lossy().to_string()))
}

fn write_archive(
    root: &Path,
    files: &[(PathBuf, u64)],
    dest: &Path,
) -> Result<(), String> {
    let file = File::create(dest).map_err(|e| format!("could not create the archive: {e}"))?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    let manifest = Manifest {
        app: APP_TAG.to_string(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        schema: DATA_SCHEMA_VERSION,
        exported_at: chrono::Local::now().to_rfc3339(),
        file_count: files.len() as u64,
        total_bytes: files.iter().map(|(_, size)| size).sum(),
    };
    let manifest_json = serde_json::to_string_pretty(&manifest)
        .map_err(|e| format!("could not describe the export: {e}"))?;
    zip.start_file(MANIFEST, options)
        .map_err(|e| format!("could not start the archive: {e}"))?;
    zip.write_all(manifest_json.as_bytes())
        .map_err(|e| format!("could not write the archive: {e}"))?;

    let mut buffer = vec![0u8; 64 * 1024];
    for (rel, _) in files {
        // Zip entries are forward-slashed by spec. A Windows path written in
        // verbatim produces an archive whose "folders" are one long filename
        // everywhere except Windows.
        let name = rel
            .components()
            .filter_map(|c| match c {
                Component::Normal(part) => Some(part.to_string_lossy().to_string()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("/");
        if name.is_empty() {
            continue;
        }
        zip.start_file(&name, options)
            .map_err(|e| format!("could not add {name}: {e}"))?;

        /* A file that has gone since the walk is SKIPPED, not fatal. The folder
           is live while this runs: a tool can prune a snapshot bucket or
           rewrite a draft mid-export, and losing a backup because a disposable
           file moved would be the wrong trade entirely. */
        let mut source = match File::open(root.join(rel)) {
            Ok(f) => f,
            Err(_) => continue,
        };
        loop {
            let read = source
                .read(&mut buffer)
                .map_err(|e| format!("could not read {name}: {e}"))?;
            if read == 0 {
                break;
            }
            zip.write_all(&buffer[..read])
                .map_err(|e| format!("could not write {name}: {e}"))?;
        }
    }

    zip.finish()
        .map_err(|e| format!("could not finish the archive: {e}"))?;
    Ok(())
}

/* -----------------------------------------------------------------------------
   IMPORT, PHASE ONE: UNPACK AND STAGE
----------------------------------------------------------------------------- */

/// What an import has staged, so the front end can say what is about to happen
/// before it offers to restart.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedImport {
    file_count: u64,
    total_bytes: u64,
    exported_at: String,
    app_version: String,
}

/// Reads a chosen archive, checks it, and unpacks it into the staging folder.
/// Nothing in the live data folder is touched. `Ok(None)` means the dialog was
/// canceled.
///
/// DELIBERATELY NOT GUARDED BY `deny_if_frozen`. A frozen folder is one written
/// by a NEWER build, and restoring an older export over it is exactly how
/// somebody gets out of that; refusing here would make the freeze a trap. The
/// write goes to a sibling folder rather than into the frozen one either way.
#[tauri::command(async)]
pub fn import_app_data(app: AppHandle) -> Result<Option<StagedImport>, String> {
    use tauri_plugin_dialog::DialogExt;

    let picked = app
        .dialog()
        .file()
        .set_title("Import Data")
        .add_filter("Zip archive", &["zip"])
        .blocking_pick_file();
    let Some(source) = picked.and_then(|p| p.as_path().map(|p| p.to_path_buf())) else {
        return Ok(None);
    };

    let file = File::open(&source).map_err(|e| format!("could not open that file: {e}"))?;
    let mut archive =
        ZipArchive::new(file).map_err(|_| "that file is not a zip archive".to_string())?;

    // The manifest first, before a single byte is unpacked. A zip that is not
    // one of ours must be refused while the data folder is still untouched.
    let manifest = read_manifest(&mut archive)?;
    if manifest.app != APP_TAG {
        return Err("that archive was not exported by this app".to_string());
    }
    if manifest.schema > DATA_SCHEMA_VERSION {
        return Err(format!(
            "that archive came from a newer version of the app (it holds shape {}, this build understands {})",
            manifest.schema, DATA_SCHEMA_VERSION
        ));
    }

    let staging = incoming_dir(&app);
    // A staging folder left by an import that was never finished is replaced,
    // not merged into. Two halves of two different backups is not a state
    // worth being able to reach.
    if staging.exists() {
        fs::remove_dir_all(&staging)
            .map_err(|e| format!("could not clear the previous staged import: {e}"))?;
    }
    fs::create_dir_all(&staging).map_err(|e| format!("could not stage the import: {e}"))?;

    match unpack(&mut archive, &staging) {
        Ok(counted) => Ok(Some(StagedImport {
            file_count: counted.0,
            total_bytes: counted.1,
            exported_at: manifest.exported_at,
            app_version: manifest.app_version,
        })),
        Err(message) => {
            // A failed unpack leaves nothing staged, so the next launch has
            // nothing to swap in and the live folder is still the live folder.
            let _ = fs::remove_dir_all(&staging);
            Err(message)
        }
    }
}

fn read_manifest<R: Read + std::io::Seek>(archive: &mut ZipArchive<R>) -> Result<Manifest, String> {
    let mut entry = archive
        .by_name(MANIFEST)
        .map_err(|_| "that archive was not exported by this app".to_string())?;
    let mut text = String::new();
    entry
        .read_to_string(&mut text)
        .map_err(|_| "that archive's manifest could not be read".to_string())?;
    serde_json::from_str(&text).map_err(|_| "that archive's manifest is not readable".to_string())
}

/// Unpacks every entry but the manifest into `into`, returning (files, bytes).
fn unpack<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
    into: &Path,
) -> Result<(u64, u64), String> {
    let mut files = 0u64;
    let mut bytes = 0u64;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("could not read the archive: {e}"))?;
        if entry.is_dir() {
            continue;
        }

        /* ZIP SLIP. An entry name is data from a file, and a hand-made archive
           can name "../../../Windows/System32/…". `enclosed_name` is the zip
           crate's own answer: it returns None for anything that would escape.
           Checked again below against the staging root, because this app
           unpacks as Administrator and one guard for that is not enough. */
        let Some(rel) = entry.enclosed_name() else {
            return Err("that archive contains a file path that points outside it".to_string());
        };
        let name = rel.to_string_lossy().to_string();
        if name == MANIFEST {
            continue;
        }
        /* AN ARCHIVE MAY NOT ARM ITSELF. The marker that says "apply this on
           the next launch" lives inside the staging folder, which is where
           every entry here is being written. An archive carrying an entry
           called that would land one, and the swap would then run without
           anyone having agreed to it.

           Nothing this app exports can contain it: the marker is written to
           the staging folder, which is a sibling of the data folder and
           therefore never walked by an export, and it is deleted before the
           swap so it never lands in the live folder either. So an archive
           holding one was built by hand, and refusing is the honest answer
           rather than quietly dropping it. */
        if name == READY_MARKER || name.ends_with(&format!("/{READY_MARKER}")) {
            return Err("that archive contains a file it is not allowed to carry".to_string());
        }

        let size = entry.size();
        if size > MAX_ENTRY_BYTES {
            return Err("that archive contains a file too large to be one of ours".to_string());
        }
        bytes += size;
        if bytes > MAX_TOTAL_BYTES {
            return Err("that archive is too large to unpack safely".to_string());
        }

        let dest = into.join(&rel);
        if !dest.starts_with(into) {
            return Err("that archive contains a file path that points outside it".to_string());
        }
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
        }

        let mut out =
            File::create(&dest).map_err(|e| format!("could not write {}: {e}", rel.display()))?;
        std::io::copy(&mut entry, &mut out)
            .map_err(|e| format!("could not write {}: {e}", rel.display()))?;
        files += 1;
    }

    if files == 0 {
        return Err("that archive holds no files".to_string());
    }
    Ok((files, bytes))
}

/// Throws away a staged import without applying it, for a user who changes
/// their mind before restarting.
#[tauri::command(async)]
pub fn cancel_staged_import(app: AppHandle) -> Result<(), String> {
    let staging = incoming_dir(&app);
    if staging.exists() {
        fs::remove_dir_all(&staging)
            .map_err(|e| format!("could not clear the staged import: {e}"))?;
    }
    Ok(())
}

/// Whether a staged import is waiting for the next launch. Read when the Data
/// tab opens, so an app closed without restarting still says so.
#[tauri::command(async)]
pub fn staged_import_waiting(app: AppHandle) -> bool {
    incoming_dir(&app).exists()
}

/// Arms the staged import and restarts so it can be swapped in on the way up.
///
/// UNPACKED IS NOT THE SAME AS AGREED, and this is the line between them.
/// `import_app_data` unpacks before asking anything, because every reason to
/// refuse an archive should be found while the live folder is still untouched.
/// That leaves a full copy of somebody's data sitting in the staging folder
/// before they have said yes, and if the swap keyed off "is there a staging
/// folder" then declining the confirmation would still have replaced
/// everything at the next launch. Saying no to "replace all of your data" must
/// not arm a replacement.
///
/// So the swap keys off this marker instead, which nothing writes but this
/// function, and this function is only ever reached from the confirmation's
/// Yes or from the Restart Now button next to the pending row. Both are the
/// user saying go.
///
/// Refuses when nothing is staged, so a stray call cannot bounce the app for
/// no reason. NOT an async command: restarting is the main thread's job.
#[tauri::command]
pub fn restart_for_import(app: AppHandle) -> Result<(), String> {
    let staging = incoming_dir(&app);
    if !staging.is_dir() {
        return Err("there is no staged import to apply".to_string());
    }
    fs::write(staging.join(READY_MARKER), b"apply")
        .map_err(|e| format!("could not arm the import: {e}"))?;

    /* A DEV BUILD CLOSES INSTEAD OF RESTARTING. `tauri dev` starts the app and
       the dev server its window loads from, and treats the app exiting as the
       end of the session. An app that relaunches itself comes back as a process
       `tauri dev` is not running, looking for a server that is going away with
       it. The import is applied on the next `npm run tauri dev`, and the Data tab
       says so before this is pressed. */
    #[cfg(debug_assertions)]
    {
        // Said in the dev terminal, because the last thing printed there on the
        // way out is otherwise WebView2's own shutdown noise, which reads like
        // the import crashing the app.
        eprintln!(
            "[data] Import armed. The dev app is closing on purpose: run `npm run tauri dev` \
             again to apply it. A \"Failed to unregister class Chrome_WidgetWin_0\" line from \
             WebView2 as it closes is harmless."
        );
        app.exit(0);
        return Ok(());
    }

    #[cfg(not(debug_assertions))]
    app.restart();
}

/// What happened to an armed import at launch, for the front end to say once.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    /// "applied" or "failed".
    pub state: &'static str,
    /// Where the replaced folder was put, when there was one to keep.
    pub replaced: Option<String>,
    /// Why it did not apply, in words, for "failed".
    pub message: String,
}

/// Held from setup() until the front end takes it, so it is said once a launch
/// rather than on every reload of the page.
pub struct PendingImportResult(pub std::sync::Mutex<Option<ImportResult>>);

#[tauri::command]
pub fn take_import_result(result: tauri::State<'_, PendingImportResult>) -> Option<ImportResult> {
    result.0.lock().ok().and_then(|mut slot| slot.take())
}

/// How many times a folder rename is tried before the swap gives up, 200ms
/// apart: five seconds. See `rename_patiently`.
const RENAME_ATTEMPTS: u32 = 25;

/// fs::rename, retried for a few seconds.
///
/// The app restarts itself to apply an import, and the new process can reach
/// the swap while the old one is still letting go of the files it had open:
/// the database, settings.json. Windows will not rename a folder while anything
/// inside it is open, so a single attempt could lose a race it would have won
/// a moment later.
fn rename_patiently(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut attempt = 1;
    loop {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(_) if attempt < RENAME_ATTEMPTS => {
                attempt += 1;
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            Err(err) => return Err(err),
        }
    }
}

/// The failure a person reads, for a swap Windows refused.
fn swap_failed(err: &std::io::Error) -> ImportResult {
    ImportResult {
        state: "failed",
        replaced: None,
        message: format!(
            "Your data was not changed. Windows would not let Swiss RB Knife move its data \
             folder ({err}), which means something still has a file in it open: most often a \
             File Explorer window showing that folder, or a program that watches it. The \
             import is still unpacked. Close whatever that is, then open App Settings > Data \
             and press Restart Now to try again, or Discard it."
        ),
    }
}

/* -----------------------------------------------------------------------------
   IMPORT, PHASE TWO: THE SWAP
----------------------------------------------------------------------------- */

/// Applies a staged import, if there is one. Called as the FIRST thing in
/// setup(), before the folder is judged, before the layout migration, and
/// before anything at all has opened a file in it.
///
/// Returns what happened, or None when no import was armed.
///
/// EVERY FAILURE LEAVES THE LIVE FOLDER ALONE. The order is: rename the live
/// folder aside, then rename staging into place. If the first fails nothing
/// has happened; if the second fails the live folder is put straight back.
/// There is no window in which both are gone.
///
/// A FAILURE IS SAID, NOT LOGGED. This used to return None on a refused rename
/// and print nothing a person would ever see, having already removed the
/// marker, so the import sat there unapplied, disarmed, and unexplained. In a
/// dev build it failed every time, because the dev server was watching the
/// folder. The result goes to the front end now (see ImportResult).
pub fn take_pending_import(app: &AppHandle) -> Option<ImportResult> {
    let staging = incoming_dir(app);
    if !staging.is_dir() {
        return None;
    }
    /* Unpacked but not armed. The user opened an archive and then said no, or
       closed the app before answering. Left exactly where it is rather than
       applied or deleted: the Data tab shows it and offers both, and guessing
       either way here would be guessing about somebody's whole data folder. */
    let marker = staging.join(READY_MARKER);
    if !marker.is_file() {
        return None;
    }
    /* Removed BEFORE the swap, so the marker never lands inside the live data
       folder and cannot re-arm anything on a later launch. It also leaves a
       failed import disarmed, which is deliberate: one that failed on every
       launch would stall every launch by the retries below. The failure is said
       instead, and Restart Now arms it again. */
    let _ = fs::remove_file(&marker);

    let root = data_root(app);
    let parent = root.parent()?.to_path_buf();
    let replaced = sibling(&root, &format!("{REPLACED_SUFFIX}{}", file_timestamp()));

    /* Only a folder with something in it is worth setting aside. data_root()
       creates the folder as it resolves it, so on a first run this would
       otherwise leave an empty "replaced" folder behind every time, which is
       litter that looks like a backup. */
    let had_data = fs::read_dir(&root).map(|mut d| d.next().is_some()).unwrap_or(false);
    if had_data {
        if let Err(err) = rename_patiently(&root, &replaced) {
            return Some(swap_failed(&err));
        }
    } else {
        // Nothing to keep, but the empty folder is still in the way of the
        // rename below.
        let _ = fs::remove_dir_all(&root);
    }

    if let Err(err) = rename_patiently(&staging, &root) {
        // Put it back exactly as it was. The staged import stays for another
        // attempt rather than being thrown away on one bad launch.
        if had_data && rename_patiently(&replaced, &root).is_err() {
            return Some(ImportResult {
                state: "failed",
                replaced: Some(replaced.to_string_lossy().to_string()),
                message: format!(
                    "The import could not be moved into place ({err}), and your previous data \
                     folder could not be moved back either. Nothing is lost: it is at {}. Close \
                     Swiss RB Knife and rename that folder back to {} by hand.",
                    replaced.display(),
                    root.display()
                ),
            });
        }
        return Some(swap_failed(&err));
    }

    prune_replaced(&parent, &root);
    Some(ImportResult {
        state: "applied",
        // Nothing was set aside on a first run, so there is nothing to point at.
        replaced: had_data.then(|| replaced.to_string_lossy().to_string()),
        message: String::new(),
    })
}

/// `<data folder>.srbk-incoming`, beside the data folder.
fn incoming_dir(app: &AppHandle) -> PathBuf {
    sibling(&data_root(app), INCOMING_SUFFIX)
}

/// A path beside `root`, named after it plus `suffix`.
///
/// Falls back to the suffix alone when the folder has no name to build on,
/// which cannot happen for a real data root but keeps this total. It never
/// falls back to a path INSIDE root: the swap renames root, and anything
/// inside would go with it.
fn sibling(root: &Path, suffix: &str) -> PathBuf {
    let parent = root.parent().unwrap_or_else(|| Path::new("."));
    let name = root
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    parent.join(format!("{name}{suffix}"))
}

/// Keeps the newest KEEP_REPLACED folders an import set aside and removes the
/// rest. Sorted by NAME, which works because the house timestamp format sorts
/// chronologically as a plain string. Same reasoning as prune_buckets.
fn prune_replaced(parent: &Path, root: &Path) {
    // Only folders set aside from THIS data folder. Two builds sharing a
    // parent (a dev folder beside a release one) must not prune each other.
    let prefix = format!(
        "{}{REPLACED_SUFFIX}",
        root.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
    );
    let mut existing: Vec<String> = fs::read_dir(parent)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|name| name.starts_with(&prefix))
        .collect();
    existing.sort();
    if existing.len() > KEEP_REPLACED {
        for old in &existing[..existing.len() - KEEP_REPLACED] {
            let _ = fs::remove_dir_all(parent.join(old));
        }
    }
}

/* =============================================================================
   TESTS
   -----------------------------------------------------------------------------
   The parts that can be tested without an AppHandle: the archive round trip,
   and the two ways a hostile archive tries to escape the folder it is being
   unpacked into.
============================================================================= */

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "srbk-archive-test-{}-{}-{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_folder_survives_the_round_trip_with_its_shape_intact() {
        let source = temp_dir("round-src");
        fs::create_dir_all(source.join("budget")).unwrap();
        fs::create_dir_all(source.join("kanban/backups/2026-09-06_10-00-00")).unwrap();
        fs::write(source.join("settings.json"), b"{\"a\":1}").unwrap();
        fs::write(source.join("budget/budget-data.enc"), b"ciphertext").unwrap();
        fs::write(
            source.join("kanban/backups/2026-09-06_10-00-00/board.json.bak"),
            b"old",
        )
        .unwrap();

        let mut files = Vec::new();
        collect_files(&source, &source, &mut files).unwrap();
        assert_eq!(files.len(), 3, "the walk missed a file");

        let archive_path = temp_dir("round-zip").join("out.zip");
        write_archive(&source, &files, &archive_path).unwrap();

        let dest = temp_dir("round-dest");
        let mut archive = ZipArchive::new(File::open(&archive_path).unwrap()).unwrap();
        let manifest = read_manifest(&mut archive).unwrap();
        assert_eq!(manifest.app, APP_TAG);
        assert_eq!(manifest.file_count, 3);

        let (count, _) = unpack(&mut archive, &dest).unwrap();
        assert_eq!(count, 3, "the unpack did not restore every file");

        // Nested folders are folders again, not one long filename.
        assert_eq!(
            fs::read(dest.join("budget/budget-data.enc")).unwrap(),
            b"ciphertext",
            "an encrypted file did not survive byte for byte"
        );
        assert_eq!(
            fs::read(dest.join("kanban/backups/2026-09-06_10-00-00/board.json.bak")).unwrap(),
            b"old",
            "a snapshot three folders deep did not survive"
        );
        // The manifest is ours, not the user's, and must not land in the folder.
        assert!(
            !dest.join(MANIFEST).exists(),
            "the manifest was unpacked into the data folder"
        );

        let _ = fs::remove_dir_all(&source);
        let _ = fs::remove_dir_all(&dest);
    }

    #[test]
    fn an_archive_that_is_not_ours_is_refused_before_anything_is_unpacked() {
        let mut buffer = Cursor::new(Vec::new());
        {
            let mut zip = ZipWriter::new(&mut buffer);
            let options =
                SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
            zip.start_file("some-other-app.txt", options).unwrap();
            zip.write_all(b"not ours").unwrap();
            zip.finish().unwrap();
        }
        let mut archive = ZipArchive::new(buffer).unwrap();
        assert!(
            read_manifest(&mut archive).is_err(),
            "a zip with no manifest was accepted"
        );
    }

    #[test]
    fn an_entry_that_climbs_out_of_the_folder_is_refused() {
        /* The one that matters most: this app unpacks as Administrator, so an
           entry named "../.." is a write anywhere on the machine. Written with
           the raw name on purpose, which is what a hand-made hostile archive
           would carry. */
        let mut buffer = Cursor::new(Vec::new());
        {
            let mut zip = ZipWriter::new(&mut buffer);
            let options =
                SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
            zip.start_file(MANIFEST, options).unwrap();
            zip.write_all(b"{}").unwrap();
            zip.start_file("../../escaped.txt", options).unwrap();
            zip.write_all(b"owned").unwrap();
            zip.finish().unwrap();
        }

        let dest = temp_dir("slip");
        let mut archive = ZipArchive::new(buffer).unwrap();
        let result = unpack(&mut archive, &dest);
        assert!(result.is_err(), "an escaping entry was unpacked");

        let outside = dest.parent().unwrap().parent().unwrap().join("escaped.txt");
        assert!(!outside.exists(), "a file was written outside the folder");
        let _ = fs::remove_dir_all(&dest);
    }

    #[test]
    fn an_archive_cannot_arm_itself() {
        /* The marker that says "apply this on the next launch" lives inside the
           staging folder, which is where every entry is unpacked. An archive
           carrying an entry of that name would land one, and the swap would run
           at the next launch without anybody having agreed to it. This is the
           one refusal that protects a decision rather than a file. */
        let mut buffer = Cursor::new(Vec::new());
        {
            let mut zip = ZipWriter::new(&mut buffer);
            let options =
                SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
            zip.start_file(MANIFEST, options).unwrap();
            zip.write_all(b"{}").unwrap();
            zip.start_file("settings.json", options).unwrap();
            zip.write_all(b"{}").unwrap();
            zip.start_file(READY_MARKER, options).unwrap();
            zip.write_all(b"apply").unwrap();
            zip.finish().unwrap();
        }
        let dest = temp_dir("self-arm");
        let mut archive = ZipArchive::new(buffer).unwrap();
        assert!(unpack(&mut archive, &dest).is_err(), "an archive armed itself");
        assert!(
            !dest.join(READY_MARKER).exists(),
            "the marker was written despite the refusal"
        );
        let _ = fs::remove_dir_all(&dest);
    }

    #[test]
    fn a_marker_nested_in_a_folder_cannot_arm_it_either() {
        // The check is on the whole entry name, so "app/srbk-apply-me" is not a
        // way round it even though it would land somewhere harmless: an entry
        // by that name has no business being in one of our archives at all.
        let mut buffer = Cursor::new(Vec::new());
        {
            let mut zip = ZipWriter::new(&mut buffer);
            let options =
                SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
            zip.start_file(MANIFEST, options).unwrap();
            zip.write_all(b"{}").unwrap();
            zip.start_file(format!("app/{READY_MARKER}"), options).unwrap();
            zip.write_all(b"apply").unwrap();
            zip.finish().unwrap();
        }
        let dest = temp_dir("self-arm-nested");
        let mut archive = ZipArchive::new(buffer).unwrap();
        assert!(unpack(&mut archive, &dest).is_err(), "a nested marker was accepted");
        let _ = fs::remove_dir_all(&dest);
    }

    #[test]
    fn an_archive_holding_nothing_is_refused() {
        // An empty archive would otherwise stage successfully and swap an empty
        // folder in over everything, which is the worst possible success.
        let mut buffer = Cursor::new(Vec::new());
        {
            let mut zip = ZipWriter::new(&mut buffer);
            let options =
                SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
            zip.start_file(MANIFEST, options).unwrap();
            zip.write_all(b"{}").unwrap();
            zip.finish().unwrap();
        }
        let dest = temp_dir("empty");
        let mut archive = ZipArchive::new(buffer).unwrap();
        assert!(unpack(&mut archive, &dest).is_err(), "an empty archive was accepted");
        let _ = fs::remove_dir_all(&dest);
    }

    #[test]
    fn the_newest_replaced_folders_are_the_ones_kept() {
        let parent = temp_dir("prune");
        let root = parent.join("data");
        fs::create_dir_all(&root).unwrap();
        let prefix = format!("data{REPLACED_SUFFIX}");

        // Named in the house timestamp format, which sorts chronologically as
        // a plain string. Deliberately created out of order.
        for stamp in [
            "2026-09-01_10-00-00",
            "2026-09-06_10-00-00",
            "2026-09-03_10-00-00",
            "2026-09-05_10-00-00",
            "2026-09-02_10-00-00",
        ] {
            fs::create_dir_all(parent.join(format!("{prefix}{stamp}"))).unwrap();
        }
        /* A SECOND DATA FOLDER'S set-asides, beside this one. A dev build and a
           release build are meant to be run side by side, and in the dev case
           both folders can share a parent; pruning one must not touch the
           other's history. */
        fs::create_dir_all(parent.join(format!("other{REPLACED_SUFFIX}2026-09-01_10-00-00"))).unwrap();
        fs::create_dir_all(parent.join(format!("other{REPLACED_SUFFIX}2026-09-02_10-00-00"))).unwrap();
        fs::create_dir_all(parent.join(format!("other{REPLACED_SUFFIX}2026-09-03_10-00-00"))).unwrap();
        fs::create_dir_all(parent.join(format!("other{REPLACED_SUFFIX}2026-09-04_10-00-00"))).unwrap();

        prune_replaced(&parent, &root);

        let mut left: Vec<String> = fs::read_dir(&parent)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.starts_with(&prefix))
            .collect();
        left.sort();
        assert_eq!(
            left,
            vec![
                format!("{prefix}2026-09-03_10-00-00"),
                format!("{prefix}2026-09-05_10-00-00"),
                format!("{prefix}2026-09-06_10-00-00"),
            ],
            "pruning kept the wrong folders"
        );
        assert!(root.exists(), "pruning removed the data folder itself");
        assert_eq!(
            fs::read_dir(&parent)
                .unwrap()
                .filter_map(|e| e.ok())
                .filter(|e| e.file_name().to_string_lossy().starts_with("other"))
                .count(),
            4,
            "pruning reached into another data folder's set-asides"
        );
        let _ = fs::remove_dir_all(&parent);
    }
}
