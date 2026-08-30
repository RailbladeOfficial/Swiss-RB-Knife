/* =============================================================================
   KANBAN BOARDS: storage, per-board encryption, snapshots, background images
   -----------------------------------------------------------------------------
   THE FILE LAYOUT, and why it is three kinds of file rather than one blob.

     kanban-settings.json     the tool's own preferences. Nothing else.
     kanban-index.json        the board LIST (id, name, description, background,
                              order) plus the shared tag vocabulary.
     kanban-board-<id>.json   one board's contents: its columns and its cards.
     kanban-board-<id>.enc    the same board, encrypted.
     kanban-backgrounds/      imported board background images.

   Three reasons for the split, in order of how much they matter.

   1. ENCRYPTION HAS TO BE PER BOARD, and a thing can only be encrypted if it is
      a file. One blob means one all-or-nothing decision for every board you
      own; separate files mean the work board can be ciphertext while the
      shopping board is not.

   2. WHAT YOU CAN SEE WHILE LOCKED. The index is always plaintext, so the
      gallery can list a locked board by name and let you choose to unlock it.
      The board file holds everything that is actually private: the columns,
      the cards, the titles, the notes. A locked board shows as a locked board,
      not as a gap.

   3. SNAPSHOT SIZE. Every save snapshots what it is about to overwrite. With
      one blob, moving one card in one board copied every board you own. Now a
      board write snapshots that board plus the index (a board is meaningless
      without the index entry naming it), and nothing else is touched.

   THE ENCRYPTION MODEL, in one paragraph, because the alternative is guessing
   it from six functions.

   There is ONE Kanban password. Each board independently chooses whether to be
   encrypted with it. There is no second, outer layer and no per-board password:
   "lock the whole tool" is a gate in front of the tool that asks for the SAME
   password, so nothing is ever encrypted twice and no board has to be decrypted
   before the tool can be locked. Each encrypted board file is a fully
   self-contained envelope carrying its own password hash, KDF salt, nonce and
   ciphertext. Every envelope holds the same hash and salt VALUES, duplicated
   rather than shared, so no board's decryptability ever depends on another
   file's bytes surviving. That exact dependency destroyed six months of real
   budget data on this codebase once already; see budget.rs's header.

   The raw password is never written anywhere. Only the Argon2id hash of it
   lives on disk, for authentication, and the AES key is re-derived from the
   stored salt on every single encrypt and decrypt.

   Rust commands exposed:
     save_kanban_settings, load_kanban_settings,
     save_kanban_index, load_kanban_index,
     save_kanban_board, load_kanban_board, delete_kanban_board,
     kanban_lock_status, kanban_verify_password,
     kanban_decrypt_board, kanban_save_board_encrypted,
     kanban_encrypt_board, kanban_decrypt_board_to_plain,
     kanban_decrypt_envelope,
     list_kanban_backups, read_kanban_backup,
     import_kanban_image, delete_kanban_image, export_kanban_data
============================================================================= */

use std::fs;
use std::path::{Path, PathBuf};

use aes_gcm::aead::rand_core::RngCore;
use aes_gcm::{
    aead::{Aead, KeyInit, OsRng as AesOsRng},
    Aes256Gcm, Nonce,
};
use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2, Params,
};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use zeroize::Zeroizing;

use crate::{atomic_write, backed_up_write_group, get_data_path};

const SETTINGS_FILE: &str = "kanban-settings.json";
const INDEX_FILE: &str = "kanban-index.json";

/// Folder under the data directory holding imported board backgrounds.
const IMAGE_DIR: &str = "kanban-backgrounds";

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

/// Snapshot folder names are the UTC timestamp lib.rs writes
/// ("%Y-%m-%d_%H-%M-%S"), so digits, dashes and one underscore.
fn valid_bucket_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 40
        && name
            .chars()
            .all(|c| c.is_ascii_digit() || c == '-' || c == '_')
}

/// Filenames inside a snapshot folder, as offered by list_kanban_backups. Same
/// rules plus the dot a filename needs, and explicitly no separators.
fn valid_backup_file(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 96
        && name.starts_with("kanban")
        && !name.contains("..")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

fn board_plain_name(id: &str) -> String {
    format!("kanban-board-{id}.json")
}

fn board_enc_name(id: &str) -> String {
    format!("kanban-board-{id}.enc")
}

/// What a board write snapshots: the board in both of its possible forms, plus
/// the index. The index is in the group because a board's contents and the
/// index entry naming it are only meaningful as a pair; restoring cards into a
/// board the index has never heard of restores nothing you can reach.
///
/// Everything else you own is deliberately NOT in this group. That is the whole
/// point of the file split: an afternoon of dragging cards around one board
/// costs snapshots of one board.
fn board_group(id: &str) -> Vec<String> {
    vec![
        board_plain_name(id),
        board_enc_name(id),
        INDEX_FILE.to_string(),
    ]
}

fn as_refs(v: &[String]) -> Vec<&str> {
    v.iter().map(|s| s.as_str()).collect()
}

/* =============================================================================
   SETTINGS  (never encrypted)
   -----------------------------------------------------------------------------
   Preferences, and nothing else. Plaintext on purpose and by necessity: one of
   the things in here is "ask for the password when the tool opens", which has
   to be readable BEFORE any password exists to read it with.
============================================================================= */

#[tauri::command]
pub fn save_kanban_settings(app: AppHandle, data: String) -> Result<(), String> {
    atomic_write(&get_data_path(&app, SETTINGS_FILE), data.as_bytes())
}

#[tauri::command]
pub fn load_kanban_settings(app: AppHandle) -> Result<String, String> {
    match fs::read_to_string(get_data_path(&app, SETTINGS_FILE)) {
        Ok(content) => Ok(content),
        Err(_) => Ok("{}".to_string()),
    }
}

/* =============================================================================
   INDEX  (never encrypted)
   The board list and the shared tag vocabulary.
============================================================================= */

#[tauri::command]
pub fn save_kanban_index(app: AppHandle, data: String) -> Result<(), String> {
    backed_up_write_group(&app, &[INDEX_FILE], INDEX_FILE, data.as_bytes())
}

#[tauri::command]
pub fn load_kanban_index(app: AppHandle) -> Result<String, String> {
    match fs::read_to_string(get_data_path(&app, INDEX_FILE)) {
        Ok(content) => Ok(content),
        Err(_) => Ok(r#"{"boards":[],"tagCategories":[],"tags":[]}"#.to_string()),
    }
}

/* =============================================================================
   BOARD CONTENTS: PLAINTEXT
============================================================================= */

/// Writes one board's columns and cards. Refuses if that board is currently
/// encrypted: this command has no password and cannot produce an envelope, so
/// letting it through would silently drop the board out of encryption and leave
/// the private copy sitting on disk in the clear.
#[tauri::command]
pub fn save_kanban_board(app: AppHandle, board_id: String, data: String) -> Result<(), String> {
    if !valid_board_id(&board_id) {
        return Err("That board id is not one of ours.".to_string());
    }
    if get_data_path(&app, &board_enc_name(&board_id)).exists() {
        return Err(
            "That board is encrypted. It has to be saved through the encrypted path.".to_string(),
        );
    }
    let group = board_group(&board_id);
    backed_up_write_group(
        &app,
        &as_refs(&group),
        &board_plain_name(&board_id),
        data.as_bytes(),
    )
}

/// Reads one board's plaintext contents. Returns "null" when there is no
/// plaintext file, which the front end reads as "this one is encrypted, or new".
#[tauri::command]
pub fn load_kanban_board(app: AppHandle, board_id: String) -> Result<String, String> {
    if !valid_board_id(&board_id) {
        return Err("That board id is not one of ours.".to_string());
    }
    match fs::read_to_string(get_data_path(&app, &board_plain_name(&board_id))) {
        Ok(content) => Ok(content),
        Err(_) => Ok("null".to_string()),
    }
}

/// Removes a board's contents in whichever form it is in. The index entry is
/// removed by the front end rewriting the index; this only deletes the file.
///
/// Snapshotted first, through the ordinary group, so a board deleted by mistake
/// is still in the last snapshot rather than gone.
#[tauri::command]
pub fn delete_kanban_board(app: AppHandle, board_id: String) -> Result<(), String> {
    if !valid_board_id(&board_id) {
        return Err("That board id is not one of ours.".to_string());
    }
    let plain = get_data_path(&app, &board_plain_name(&board_id));
    let enc = get_data_path(&app, &board_enc_name(&board_id));

    // A write is what triggers a snapshot, and there is no write here, so the
    // snapshot is taken explicitly by writing the board out one last time as an
    // empty husk before removing it. The husk never survives this call.
    let group = board_group(&board_id);
    let _ = backed_up_write_group(
        &app,
        &as_refs(&group),
        &board_plain_name(&board_id),
        b"null",
    );

    if plain.exists() {
        fs::remove_file(&plain).map_err(|e| e.to_string())?;
    }
    if enc.exists() {
        fs::remove_file(&enc).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/* =============================================================================
   ENCRYPTED ENVELOPES
============================================================================= */

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct EncryptedEnvelope {
    password_hash: String,
    kdf_salt_hex: String,
    nonce_hex: String,
    ciphertext_hex: String,
}

fn read_envelope(app: &AppHandle, board_id: &str) -> Option<EncryptedEnvelope> {
    let raw = fs::read_to_string(get_data_path(app, &board_enc_name(board_id))).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Every board id that currently has an .enc file, by looking at the disk
/// rather than at a stored flag. A flag can disagree with the files; the files
/// cannot disagree with themselves. Same rule as budget_lock_status().
fn encrypted_board_ids(app: &AppHandle) -> Vec<String> {
    let dir = match get_data_path(app, INDEX_FILE).parent() {
        Some(p) => p.to_path_buf(),
        None => return vec![],
    };
    let mut out: Vec<String> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let id = name.strip_prefix("kanban-board-")?.strip_suffix(".enc")?;
            if valid_board_id(id) {
                Some(id.to_string())
            } else {
                None
            }
        })
        .collect();
    out.sort();
    out
}

/// Any existing envelope, for the password hash and salt a NEW encryption has
/// to reuse. Every envelope holds the same values, so the first one found is as
/// good as any other.
fn any_envelope(app: &AppHandle) -> Option<EncryptedEnvelope> {
    encrypted_board_ids(app)
        .into_iter()
        .find_map(|id| read_envelope(app, &id))
}

/* =============================================================================
   CRYPTO PRIMITIVES
   Deliberately identical to budget.rs's. Two tools encrypting user data two
   different ways is one of them being the weaker one, and nobody would know
   which.
============================================================================= */

/// Derives the AES-256 key from the password and the stored salt. Returned
/// inside Zeroizing so the bytes are wiped when the caller's copy drops:
/// derived key material should never outlive the one operation it was made for.
fn derive_key(password: &str, kdf_salt_hex: &str) -> Result<Zeroizing<[u8; 32]>, String> {
    let salt_bytes = hex::decode(kdf_salt_hex).map_err(|e| e.to_string())?;
    if salt_bytes.len() != 16 {
        return Err("Invalid KDF salt length".to_string());
    }
    let params = Params::new(65536, 3, 1, Some(32)).map_err(|e| e.to_string())?;
    let argon2 = Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    let mut key = Zeroizing::new([0u8; 32]);
    argon2
        .hash_password_into(password.as_bytes(), &salt_bytes, &mut *key)
        .map_err(|e| e.to_string())?;
    Ok(key)
}

fn encrypt_bytes(key: &[u8; 32], plaintext: &[u8]) -> Result<(Vec<u8>, Vec<u8>), String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| e.to_string())?;
    let mut nonce_bytes = [0u8; 12];
    AesOsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher.encrypt(nonce, plaintext).map_err(|e| e.to_string())?;
    Ok((nonce_bytes.to_vec(), ciphertext))
}

fn decrypt_bytes(key: &[u8; 32], nonce_bytes: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>, String> {
    if nonce_bytes.len() != 12 {
        return Err("Invalid nonce length".to_string());
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| e.to_string())?;
    let nonce = Nonce::from_slice(nonce_bytes);
    cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| "Decryption failed: wrong password or corrupted data".to_string())
}

fn verify_against(envelope: &EncryptedEnvelope, password: &str) -> Result<bool, String> {
    let parsed = PasswordHash::new(envelope.password_hash.trim()).map_err(|e| e.to_string())?;
    Ok(Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok())
}

/// Decrypts one envelope's payload after checking the password against the hash
/// it carries. The single place a password turns into plaintext, so there is one
/// place to look at when asking whether that is done correctly.
fn open_envelope(envelope: &EncryptedEnvelope, password: &str) -> Result<String, String> {
    if !verify_against(envelope, password)? {
        return Err("Wrong password".to_string());
    }
    let key = derive_key(password, &envelope.kdf_salt_hex)?;
    let nonce = hex::decode(&envelope.nonce_hex).map_err(|e| e.to_string())?;
    let ciphertext = hex::decode(&envelope.ciphertext_hex).map_err(|e| e.to_string())?;
    let plaintext = decrypt_bytes(&key, &nonce, &ciphertext)?;
    String::from_utf8(plaintext).map_err(|e| e.to_string())
}

/* =============================================================================
   LOCK STATUS + AUTHENTICATION
============================================================================= */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KanbanLockStatus {
    /// Whether a Kanban password has been established at all, which is exactly
    /// "is any board encrypted". There is no separate stored flag, because a
    /// flag is a thing that can be wrong.
    has_password: bool,
    encrypted_board_ids: Vec<String>,
}

#[tauri::command]
pub fn kanban_lock_status(app: AppHandle) -> KanbanLockStatus {
    let ids = encrypted_board_ids(&app);
    KanbanLockStatus {
        has_password: !ids.is_empty(),
        encrypted_board_ids: ids,
    }
}

/// Checks a password against the stored hash without decrypting anything. Used
/// by the tool-lock gate, which has to admit you to the tool before it knows
/// which board you are going to open.
#[tauri::command]
pub fn kanban_verify_password(app: AppHandle, password: String) -> Result<bool, String> {
    let password = Zeroizing::new(password);
    match any_envelope(&app) {
        Some(envelope) => verify_against(&envelope, &password),
        // No encrypted board means no password to be wrong about. Reported as
        // an error rather than as `true`, so a caller that reaches the gate in
        // a state that should be impossible fails loudly instead of opening.
        None => Err("No Kanban password has been set.".to_string()),
    }
}

/* =============================================================================
   ENCRYPTED LOAD / SAVE
============================================================================= */

/// Decrypts one board's contents and returns them. Plaintext never touches the
/// disk; it exists in this process's memory and in the WebView's, and nowhere
/// else.
#[tauri::command]
pub fn kanban_decrypt_board(
    app: AppHandle,
    board_id: String,
    password: String,
) -> Result<String, String> {
    let password = Zeroizing::new(password);
    if !valid_board_id(&board_id) {
        return Err("That board id is not one of ours.".to_string());
    }
    let envelope =
        read_envelope(&app, &board_id).ok_or_else(|| "That board is not encrypted.".to_string())?;
    open_envelope(&envelope, &password)
}

/// Re-encrypts a board's contents in place. The password hash and salt are
/// carried forward unchanged and only the nonce and ciphertext are new, written
/// back as one object in one call so the four fields can never end up
/// describing two different moments.
#[tauri::command]
pub fn kanban_save_board_encrypted(
    app: AppHandle,
    board_id: String,
    password: String,
    data: String,
) -> Result<(), String> {
    let password = Zeroizing::new(password);
    if !valid_board_id(&board_id) {
        return Err("That board id is not one of ours.".to_string());
    }
    let envelope =
        read_envelope(&app, &board_id).ok_or_else(|| "That board is not encrypted.".to_string())?;
    if !verify_against(&envelope, &password)? {
        return Err("Wrong password: refusing to overwrite the encrypted board".to_string());
    }
    let key = derive_key(&password, &envelope.kdf_salt_hex)?;
    let (nonce, ciphertext) = encrypt_bytes(&key, data.as_bytes())?;
    let next = EncryptedEnvelope {
        password_hash: envelope.password_hash,
        kdf_salt_hex: envelope.kdf_salt_hex,
        nonce_hex: hex::encode(nonce),
        ciphertext_hex: hex::encode(ciphertext),
    };
    let json = serde_json::to_string(&next).map_err(|e| e.to_string())?;
    let group = board_group(&board_id);
    backed_up_write_group(
        &app,
        &as_refs(&group),
        &board_enc_name(&board_id),
        json.as_bytes(),
    )
}

/// Decrypts an envelope handed in as a string rather than read from its usual
/// place. This exists for exactly one caller: restoring an encrypted board from
/// a snapshot, where the envelope is a .bak file rather than the live one.
///
/// No weaker than the command above it. The envelope carries its own hash and
/// the password is checked against that hash, so this cannot open anything a
/// caller could not already open by putting the same bytes back in place first.
#[tauri::command]
pub fn kanban_decrypt_envelope(envelope: String, password: String) -> Result<String, String> {
    let password = Zeroizing::new(password);
    let parsed: EncryptedEnvelope = serde_json::from_str(&envelope)
        .map_err(|_| "That is not an encrypted board.".to_string())?;
    open_envelope(&parsed, &password)
}

/* =============================================================================
   TURNING ENCRYPTION ON AND OFF, PER BOARD
============================================================================= */

/// Encrypts one board.
///
/// If other boards are already encrypted, this reuses their password hash and
/// salt, so every board on this install opens with the same password and the
/// argument is checked against the existing one. If this is the FIRST board to
/// be encrypted, the password given establishes the Kanban password.
///
/// The plaintext file is removed only after the envelope is safely on disk. A
/// failure anywhere before that leaves the board exactly as it was.
#[tauri::command]
pub fn kanban_encrypt_board(
    app: AppHandle,
    board_id: String,
    password: String,
) -> Result<(), String> {
    let password = Zeroizing::new(password);
    if !valid_board_id(&board_id) {
        return Err("That board id is not one of ours.".to_string());
    }
    if get_data_path(&app, &board_enc_name(&board_id)).exists() {
        return Err("That board is already encrypted.".to_string());
    }

    let plain_path = get_data_path(&app, &board_plain_name(&board_id));
    let plain = fs::read_to_string(&plain_path).unwrap_or_else(|_| "null".to_string());

    // Reuse the established credentials, or mint them if this is the first.
    let (password_hash, kdf_salt_hex) = match any_envelope(&app) {
        Some(existing) => {
            if !verify_against(&existing, &password)? {
                return Err(
                    "That is not the Kanban password. Every encrypted board on this install uses the same one."
                        .to_string(),
                );
            }
            (existing.password_hash, existing.kdf_salt_hex)
        }
        None => {
            let salt = SaltString::generate(&mut OsRng);
            let hash = Argon2::default()
                .hash_password(password.as_bytes(), &salt)
                .map_err(|e| e.to_string())?
                .to_string();
            let mut kdf_salt = [0u8; 16];
            AesOsRng.fill_bytes(&mut kdf_salt);
            (hash, hex::encode(kdf_salt))
        }
    };

    let key = derive_key(&password, &kdf_salt_hex)?;
    let (nonce, ciphertext) = encrypt_bytes(&key, plain.as_bytes())?;
    let envelope = EncryptedEnvelope {
        password_hash,
        kdf_salt_hex,
        nonce_hex: hex::encode(nonce),
        ciphertext_hex: hex::encode(ciphertext),
    };
    let json = serde_json::to_string(&envelope).map_err(|e| e.to_string())?;
    let group = board_group(&board_id);
    backed_up_write_group(
        &app,
        &as_refs(&group),
        &board_enc_name(&board_id),
        json.as_bytes(),
    )?;

    // Only now, with the envelope confirmed written.
    if plain_path.exists() {
        fs::remove_file(&plain_path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Takes one board back out of encryption: decrypts it, writes the plaintext,
/// and only then removes the envelope. Ordered that way on purpose, so an
/// interruption leaves two copies rather than none.
#[tauri::command]
pub fn kanban_decrypt_board_to_plain(
    app: AppHandle,
    board_id: String,
    password: String,
) -> Result<(), String> {
    let password = Zeroizing::new(password);
    if !valid_board_id(&board_id) {
        return Err("That board id is not one of ours.".to_string());
    }
    let envelope =
        read_envelope(&app, &board_id).ok_or_else(|| "That board is not encrypted.".to_string())?;
    let plain = open_envelope(&envelope, &password)?;

    let group = board_group(&board_id);
    backed_up_write_group(
        &app,
        &as_refs(&group),
        &board_plain_name(&board_id),
        plain.as_bytes(),
    )?;

    let enc_path = get_data_path(&app, &board_enc_name(&board_id));
    if enc_path.exists() {
        fs::remove_file(&enc_path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/* =============================================================================
   SNAPSHOTS
============================================================================= */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KanbanBackupFile {
    /// The .bak filename inside the snapshot folder.
    file: String,
    bytes: u64,
    /// Which board this is, or None for the index.
    board_id: Option<String>,
    /// Whether the captured bytes are an envelope rather than readable JSON.
    encrypted: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KanbanBackup {
    /// The snapshot folder's name, which is its UTC timestamp in
    /// "%Y-%m-%d_%H-%M-%S" form (BACKUP_FOLDER_FORMAT in lib.rs).
    name: String,
    files: Vec<KanbanBackupFile>,
}

fn backups_root(app: &AppHandle) -> Option<PathBuf> {
    get_data_path(app, INDEX_FILE)
        .parent()
        .map(|p| p.join("backups"))
}

/// Classifies one captured filename. Returns None for anything that is not
/// restorable Kanban content.
fn classify_backup_file(name: &str) -> Option<(Option<String>, bool)> {
    let stem = name.strip_suffix(".bak")?;
    if let Some(rest) = stem.strip_prefix("kanban-board-") {
        if let Some(id) = rest.strip_suffix(".enc") {
            return valid_board_id(id).then(|| (Some(id.to_string()), true));
        }
        let id = rest.strip_suffix(".json")?;
        return valid_board_id(id).then(|| (Some(id.to_string()), false));
    }
    // The index. The settings file is deliberately not offered: restoring
    // preferences is not a recovery, and rewinding them would be a surprise
    // nobody asked for when they set out to get a board back.
    (stem == INDEX_FILE).then_some((None, false))
}

/// Reads one snapshot folder and describes the Kanban files in it.
fn describe_bucket(dir: &Path) -> Vec<KanbanBackupFile> {
    let mut files: Vec<KanbanBackupFile> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            // The backups folder is shared with every other tool that
            // snapshots, so this is the filter that keeps Budget's files out of
            // the Kanban's restore list.
            let (board_id, encrypted) = classify_backup_file(&name)?;
            let bytes = e.metadata().ok()?.len();
            Some(KanbanBackupFile {
                file: name,
                bytes,
                board_id,
                encrypted,
            })
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
            if !valid_bucket_name(&name) {
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
    if !valid_bucket_name(&name) {
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

/// Lowercased extension of `path`, if it is one we can render.
fn allowed_ext(path: &Path) -> Option<String> {
    let ext = path.extension()?.to_string_lossy().to_lowercase();
    if ALLOWED_IMAGE_EXTS.contains(&ext.as_str()) {
        Some(ext)
    } else {
        None
    }
}

/// Copies a user-picked image into kanban-backgrounds/ and returns the path of
/// the copy. The name is a timestamp plus a counter rather than the original
/// filename: two boards backed by two different photos both called
/// "background.jpg" must not collide, and the original name is of no interest
/// once the file is inside the app.
///
/// Note what this means for an encrypted board: its background image is NOT
/// encrypted, because it is a separate file the gallery has to be able to draw
/// while the board is locked. A picture chosen to make a board recognisable
/// from across the room is not the private part; the cards are.
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
    Ok(dest.to_string_lossy().to_string())
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
    let target = PathBuf::from(&path);

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
   EXPORT
============================================================================= */

/// Writes an export to the user's Downloads folder as readable JSON, returning
/// the full path it landed at.
///
/// A plain file the user owns, deliberately: the in-app snapshots are for
/// recovering from a mistake inside the app, and they are pruned. An export is
/// for getting the data OUT, and nothing in here should ever prune that.
///
/// The front end assembles what goes in it, which is what lets an export taken
/// while a board is unlocked contain that board and an export taken while it is
/// locked leave it out. Nothing here can decrypt anything.
#[tauri::command]
pub fn export_kanban_data(
    app: AppHandle,
    filename: String,
    data: String,
) -> Result<String, String> {
    let safe_name = crate::sanitize_filename(&filename)?;

    use tauri::Manager;
    let downloads = app.path().download_dir().map_err(|e| e.to_string())?;
    let path = downloads.join(&safe_name);
    atomic_write(&path, data.as_bytes())?;
    Ok(path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_the_names_snapshot_folders_actually_have() {
        // The format lib.rs writes (BACKUP_FOLDER_FORMAT), UTC.
        assert!(valid_bucket_name("2026-08-28_14-00-00"));
        assert!(valid_bucket_name("2026-01-01_00-00-00"));
    }

    #[test]
    fn rejects_anything_that_could_climb_out_of_the_backups_folder() {
        // Each of these is a string the front end could hand back from a stale
        // list or a hand-edited file, and each is about to be joined onto a
        // path. Rejecting them here is what keeps read_kanban_backup a read of
        // one folder rather than a read of the disk.
        for bad in [
            "",
            "..",
            "../../secrets",
            r"..\..\secrets",
            "2026-08-28_14-00-00/../..",
            r"C:\Windows\System32\config",
            "name with spaces",
            "name.with.dots",
            "name$",
        ] {
            assert!(!valid_bucket_name(bad), "should have rejected {bad:?}");
        }
    }

    #[test]
    fn rejects_a_name_long_enough_to_be_a_payload() {
        assert!(!valid_bucket_name(&"1".repeat(41)));
    }

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
    fn a_snapshot_filename_has_to_be_one_of_ours() {
        assert!(valid_backup_file("kanban-index.json.bak"));
        assert!(valid_backup_file(
            "kanban-board-0f8fad5b-d9cb-469f-a165-70867728950e.enc.bak"
        ));
        for bad in [
            "",
            "budget-data.json.bak",
            "kanban/../../secrets",
            "kanban-..-index.bak",
            r"kanban\index.bak",
        ] {
            assert!(!valid_backup_file(bad), "should have rejected {bad:?}");
        }
    }

    #[test]
    fn a_snapshot_is_classified_by_what_it_actually_holds() {
        assert_eq!(
            classify_backup_file("kanban-board-abc.json.bak"),
            Some((Some("abc".to_string()), false))
        );
        assert_eq!(
            classify_backup_file("kanban-board-abc.enc.bak"),
            Some((Some("abc".to_string()), true))
        );
        assert_eq!(
            classify_backup_file("kanban-index.json.bak"),
            Some((None, false))
        );
        // Preferences are not a recovery, so they are not offered for restore.
        assert_eq!(classify_backup_file("kanban-settings.json.bak"), None);
        assert_eq!(classify_backup_file("budget-data.json.bak"), None);
    }

    #[test]
    fn a_board_write_only_snapshots_that_board_and_the_index() {
        // The whole reason for the file split. If this ever grows to include
        // other boards, an afternoon on one board starts copying all of them
        // again.
        let group = board_group("abc");
        assert_eq!(
            group,
            vec![
                "kanban-board-abc.json".to_string(),
                "kanban-board-abc.enc".to_string(),
                "kanban-index.json".to_string(),
            ]
        );
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
    fn the_extension_comes_back_lowercased() {
        // It is used to build the stored filename, so a mixed-case source must
        // not produce "bg-123-0.JPG" alongside "bg-124-0.jpg".
        assert_eq!(allowed_ext(Path::new("photo.JPEG")).as_deref(), Some("jpeg"));
    }

    /* -------------------------------------------------------------------------
       Crypto round trips. These exercise the primitives directly rather than
       through the commands, which need an AppHandle and a real data directory.
    ------------------------------------------------------------------------- */

    fn envelope_for(password: &str, payload: &str) -> EncryptedEnvelope {
        let salt = SaltString::generate(&mut OsRng);
        let password_hash = Argon2::default()
            .hash_password(password.as_bytes(), &salt)
            .unwrap()
            .to_string();
        let mut kdf_salt = [0u8; 16];
        AesOsRng.fill_bytes(&mut kdf_salt);
        let kdf_salt_hex = hex::encode(kdf_salt);
        let key = derive_key(password, &kdf_salt_hex).unwrap();
        let (nonce, ciphertext) = encrypt_bytes(&key, payload.as_bytes()).unwrap();
        EncryptedEnvelope {
            password_hash,
            kdf_salt_hex,
            nonce_hex: hex::encode(nonce),
            ciphertext_hex: hex::encode(ciphertext),
        }
    }

    #[test]
    fn a_board_comes_back_exactly_as_it_went_in() {
        let payload = r#"{"columns":[{"id":"c1","title":"Doing"}],"cards":[]}"#;
        let envelope = envelope_for("correct horse", payload);
        assert_eq!(open_envelope(&envelope, "correct horse").unwrap(), payload);
    }

    #[test]
    fn the_wrong_password_opens_nothing() {
        let envelope = envelope_for("correct horse", "secret");
        assert!(open_envelope(&envelope, "battery staple").is_err());
    }

    #[test]
    fn the_ciphertext_does_not_contain_the_plaintext() {
        // Cheap, but it is the check that would catch an envelope accidentally
        // storing its payload rather than encrypting it, which is the one
        // failure here that would otherwise look completely fine.
        let envelope = envelope_for("pw", "the quick brown fox");
        assert!(!envelope
            .ciphertext_hex
            .contains(&hex::encode("the quick brown fox")));
        assert!(!envelope.ciphertext_hex.contains("the quick brown fox"));
    }

    #[test]
    fn tampering_with_the_ciphertext_is_detected() {
        // AES-GCM is authenticated, so a flipped byte must fail to open rather
        // than yield garbage the front end would then try to parse as a board.
        let mut envelope = envelope_for("pw", "some cards");
        let mut bytes = hex::decode(&envelope.ciphertext_hex).unwrap();
        bytes[0] ^= 0xff;
        envelope.ciphertext_hex = hex::encode(bytes);
        assert!(open_envelope(&envelope, "pw").is_err());
    }

    #[test]
    fn two_boards_under_one_password_do_not_share_a_nonce() {
        // Reusing a nonce under the same key is the classic way to destroy
        // AES-GCM's guarantees. Each encrypt draws a fresh one.
        let a = envelope_for("pw", "board a");
        let b = envelope_for("pw", "board b");
        assert_ne!(a.nonce_hex, b.nonce_hex);
    }
}
