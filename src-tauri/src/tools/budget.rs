/* =============================================================================
   BUDGET TRACKER — Rust backend
   -----------------------------------------------------------------------------
   Persistence and optional AES-256-GCM encryption of budget data, split
   across two independent files:

     • budget-data.json / budget-data.enc
       Transactional entries: billInstances, incomeEntries, fluctuatingExpenses.

     • budget-entities.json / budget-entities.enc
       Setup-modal structure: categories, incomeSources, expenseSources,
       recurringBills. Also carries `sessionUnlock` as a plain sibling field
       (never encrypted, whether the rest of the file is or not) — it's a UI
       preference, not sensitive, and budget_lock_status() needs to read it
       before any password is available.

   Both files toggle plaintext <-> encrypted together, under the same
   password, via budget_enable_encryption / budget_disable_encryption. There
   is no "enabled" flag stored anywhere — it's just whether budget-entities.enc
   exists. One less piece of state that could disagree with reality.

   Each encrypted file is a fully self-contained JSON envelope — its own
   passwordHash, kdfSaltHex, nonceHex, ciphertextHex, all together, written
   in one call. The two envelopes share the same password and salt VALUES
   (generated once, at enable time) but are duplicated independently into
   each file rather than one file referencing the other's copy. That's
   deliberate: no file's decryptability should ever depend on a different
   file's bytes being intact. That exact dependency — a salt in one file,
   ciphertext in another — is what silently destroyed six months of real
   budget data once already on this codebase, discovered days later with no
   warning and no way back. See lib.rs's backed_up_write_group for the other
   half of the fix (nothing here can ever be left half-written either).

   The raw password is NEVER stored. Key derivation happens on every encrypt
   / decrypt call using the stored salt; only the Argon2id hash of the
   password lives on disk, for authentication only.
============================================================================= */

use std::fs;
use crate::{backed_up_write_group, get_data_path};

use aes_gcm::{
    aead::{Aead, KeyInit, OsRng as AesOsRng},
    Aes256Gcm, Nonce,
};
use aes_gcm::aead::rand_core::RngCore;
use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2, Params,
};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

/// All four possible on-disk files for budget state. Only two exist at once
/// per data/entities pair (plaintext XOR encrypted) — backed_up_write_group
/// just skips whichever don't currently exist, so listing all four here
/// means a snapshot always captures whichever pair is live.
const BUDGET_BACKUP_GROUP: [&str; 4] = [
    "budget-data.json",
    "budget-data.enc",
    "budget-entities.json",
    "budget-entities.enc",
];

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

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct EntitiesEncryptedEnvelope {
    password_hash: String,
    kdf_salt_hex: String,
    nonce_hex: String,
    ciphertext_hex: String,
    /// Plain, unencrypted — see file header for why.
    session_unlock: bool,
}

fn read_data_envelope(app: &tauri::AppHandle) -> Option<EncryptedEnvelope> {
    let raw = fs::read_to_string(get_data_path(app, "budget-data.enc")).ok()?;
    serde_json::from_str(&raw).ok()
}

fn read_entities_envelope(app: &tauri::AppHandle) -> Option<EntitiesEncryptedEnvelope> {
    let raw = fs::read_to_string(get_data_path(app, "budget-entities.enc")).ok()?;
    serde_json::from_str(&raw).ok()
}

/* =============================================================================
   PLAINTEXT ENTITIES WRAPPER
   Only used when encryption is off. sessionUnlock sits alongside the opaque
   entities payload — Rust doesn't need to understand categories/sources/etc.
   any more than it understands the entries file's contents; it just needs
   this one field's name.
============================================================================= */

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PlaintextEntitiesFile {
    session_unlock: bool,
    entities: serde_json::Value,
}

fn read_plaintext_entities(app: &tauri::AppHandle) -> Option<PlaintextEntitiesFile> {
    let raw = fs::read_to_string(get_data_path(app, "budget-entities.json")).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Reads sessionUnlock from whichever shape (plaintext or encrypted) the
/// entities file is currently in. Never needs a password — this is exactly
/// why it lives as a plain field either way.
fn read_session_unlock(app: &tauri::AppHandle) -> bool {
    if let Some(env) = read_entities_envelope(app) {
        return env.session_unlock;
    }
    if let Some(wrapper) = read_plaintext_entities(app) {
        return wrapper.session_unlock;
    }
    false
}

/* =============================================================================
   CRYPTO PRIMITIVES
============================================================================= */

/// Derives the AES-256 key from the password + stored salt. The key is
/// returned inside a Zeroizing wrapper, so its bytes are wiped from memory
/// automatically when the caller's copy goes out of scope — derived key
/// material should never outlive the single encrypt/decrypt it was made for.
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

/// Returns (nonce_bytes, ciphertext_with_tag) separately — the envelope
/// stores them as separate hex fields rather than one concatenated blob, so
/// the format is self-describing instead of relying on "the first 12 bytes
/// are the nonce" being remembered correctly everywhere that touches it.
fn encrypt_bytes(key: &[u8; 32], plaintext: &[u8]) -> Result<(Vec<u8>, Vec<u8>), String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| e.to_string())?;
    let mut nonce_bytes = [0u8; 12];
    AesOsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| e.to_string())?;
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
        .map_err(|_| "Decryption failed — wrong password or corrupted data".to_string())
}

/* =============================================================================
   STANDARD SAVE / LOAD — ENTRIES  (budget-data.json, used when encryption is off)
============================================================================= */

/// Persists the entries JSON (billInstances/incomeEntries/fluctuatingExpenses)
/// to disk, plaintext.
#[tauri::command]
pub fn save_budget_data(app: tauri::AppHandle, data: String) -> Result<(), String> {
    backed_up_write_group(&app, &BUDGET_BACKUP_GROUP, "budget-data.json", data.as_bytes())
}

/// Loads the entries JSON from disk. Returns "{}" if it doesn't exist yet.
#[tauri::command]
pub fn load_budget_data(app: tauri::AppHandle) -> Result<String, String> {
    match fs::read_to_string(get_data_path(&app, "budget-data.json")) {
        Ok(content) => Ok(content),
        Err(_) => Ok("{}".to_string()),
    }
}

/* =============================================================================
   STANDARD SAVE / LOAD — ENTITIES  (budget-entities.json, used when encryption is off)
============================================================================= */

/// Persists the entities JSON (categories/incomeSources/expenseSources/
/// recurringBills) to disk, plaintext — wrapped with the current
/// sessionUnlock value, which the frontend never sends here and never sees
/// on load either; it's managed separately via budget_set_session_unlock.
#[tauri::command]
pub fn save_budget_entities(app: tauri::AppHandle, data: String) -> Result<(), String> {
    let entities_value: serde_json::Value = serde_json::from_str(&data).map_err(|e| e.to_string())?;
    let wrapper = PlaintextEntitiesFile {
        session_unlock: read_session_unlock(&app),
        entities: entities_value,
    };
    let json = serde_json::to_string(&wrapper).map_err(|e| e.to_string())?;
    backed_up_write_group(&app, &BUDGET_BACKUP_GROUP, "budget-entities.json", json.as_bytes())
}

/// Loads just the entities JSON from disk — sessionUnlock is stripped back
/// out, since callers of this command only ever want the ledger structure.
#[tauri::command]
pub fn load_budget_entities(app: tauri::AppHandle) -> Result<String, String> {
    match read_plaintext_entities(&app) {
        Some(wrapper) => serde_json::to_string(&wrapper.entities).map_err(|e| e.to_string()),
        None => Ok("{}".to_string()),
    }
}

/* =============================================================================
   ENCRYPTION STATUS
============================================================================= */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetLockStatus {
    enabled: bool,
    session_unlock: bool,
}

/// "enabled" is just "does budget-entities.enc exist" — not a stored flag
/// that could disagree with which files are actually on disk. Also treats
/// leftover artifacts from before this file split (a bare budget-data.enc
/// with no matching budget-entities.enc, or an old budget-lock.json) as
/// "enabled" too — the alternative is reporting encryption as off and
/// silently handing back an empty budget while real encrypted data sits
/// right there unread. A stuck auth screen is loud and diagnosable; a
/// quietly empty tool is not.
#[tauri::command]
pub fn budget_lock_status(app: tauri::AppHandle) -> BudgetLockStatus {
    let entities_envelope_exists = get_data_path(&app, "budget-entities.enc").exists();
    let legacy_artifacts_present = get_data_path(&app, "budget-data.enc").exists()
        || get_data_path(&app, "budget-lock.json").exists();
    BudgetLockStatus {
        enabled: entities_envelope_exists || legacy_artifacts_present,
        session_unlock: read_session_unlock(&app),
    }
}

/* =============================================================================
   AUTHENTICATION
============================================================================= */

/// Verifies the supplied password against the entities envelope's stored
/// Argon2id hash. Doesn't decrypt anything.
#[tauri::command]
pub fn budget_verify_password(app: tauri::AppHandle, password: String) -> Result<bool, String> {
    // Wipe the password from memory when this function returns (all paths).
    let password = Zeroizing::new(password);
    let envelope = match read_entities_envelope(&app) {
        Some(e) => e,
        None => {
            // No new-format envelope, but budget_lock_status() reported
            // enabled=true — that only happens if legacy artifacts were
            // detected. Say so plainly instead of returning Ok(false), which
            // the frontend shows as "Incorrect password." — misleading when
            // the actual problem is an unrecognized on-disk format.
            let legacy = get_data_path(&app, "budget-data.enc").exists()
                || get_data_path(&app, "budget-lock.json").exists();
            if legacy {
                return Err(
                    "Found an older-format encrypted budget file this version can't read. \
                     This needs a one-time migration — don't enter data yet, get help before continuing."
                        .to_string(),
                );
            }
            return Ok(false);
        }
    };
    let parsed = PasswordHash::new(envelope.password_hash.trim()).map_err(|e| e.to_string())?;
    Ok(Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok())
}

/* =============================================================================
   ENCRYPTED LOAD / SAVE — ENTRIES
============================================================================= */

/// Decrypts budget-data.enc and returns the entries JSON. Plaintext never
/// touches disk — it lives only in memory.
#[tauri::command]
pub fn budget_decrypt_to_memory(app: tauri::AppHandle, password: String) -> Result<String, String> {
    // Wipe the password from memory when this function returns (all paths).
    let password = Zeroizing::new(password);
    let envelope = read_data_envelope(&app).ok_or_else(|| "Encryption is not enabled".to_string())?;
    let parsed = PasswordHash::new(envelope.password_hash.trim()).map_err(|e| e.to_string())?;
    if Argon2::default().verify_password(password.as_bytes(), &parsed).is_err() {
        return Err("Wrong password".to_string());
    }
    let key = derive_key(&password, &envelope.kdf_salt_hex)?;
    let nonce_bytes = hex::decode(&envelope.nonce_hex).map_err(|e| e.to_string())?;
    let ciphertext = hex::decode(&envelope.ciphertext_hex).map_err(|e| e.to_string())?;
    let plaintext = decrypt_bytes(&key, &nonce_bytes, &ciphertext)?;
    String::from_utf8(plaintext).map_err(|e| e.to_string())
}

/// Re-encrypts updated entries to disk. Same salt and password hash carried
/// forward unchanged — only the nonce and ciphertext are new — written back
/// as one object, one write, so they can never end up representing two
/// different moments.
#[tauri::command]
pub fn budget_save_encrypted(app: tauri::AppHandle, password: String, data: String) -> Result<(), String> {
    // Wipe the password from memory when this function returns (all paths).
    let password = Zeroizing::new(password);
    let envelope = read_data_envelope(&app).ok_or_else(|| "Encryption is not enabled".to_string())?;
    let parsed = PasswordHash::new(envelope.password_hash.trim()).map_err(|e| e.to_string())?;
    if Argon2::default().verify_password(password.as_bytes(), &parsed).is_err() {
        return Err("Wrong password — refusing to overwrite the encrypted file".to_string());
    }
    let key = derive_key(&password, &envelope.kdf_salt_hex)?;
    let (nonce_bytes, ciphertext) = encrypt_bytes(&key, data.as_bytes())?;
    let new_envelope = EncryptedEnvelope {
        password_hash: envelope.password_hash,
        kdf_salt_hex: envelope.kdf_salt_hex,
        nonce_hex: hex::encode(nonce_bytes),
        ciphertext_hex: hex::encode(ciphertext),
    };
    let json = serde_json::to_string(&new_envelope).map_err(|e| e.to_string())?;
    backed_up_write_group(&app, &BUDGET_BACKUP_GROUP, "budget-data.enc", json.as_bytes())
}

/* =============================================================================
   ENCRYPTED LOAD / SAVE — ENTITIES
============================================================================= */

/// Decrypts budget-entities.enc and returns the entities JSON (sessionUnlock
/// is not part of the ciphertext — see file header — so it's not part of
/// this return value either; callers get exactly the same shape whether
/// encryption is on or off).
#[tauri::command]
pub fn budget_decrypt_entities_to_memory(app: tauri::AppHandle, password: String) -> Result<String, String> {
    // Wipe the password from memory when this function returns (all paths).
    let password = Zeroizing::new(password);
    let envelope = read_entities_envelope(&app).ok_or_else(|| "Encryption is not enabled".to_string())?;
    let parsed = PasswordHash::new(envelope.password_hash.trim()).map_err(|e| e.to_string())?;
    if Argon2::default().verify_password(password.as_bytes(), &parsed).is_err() {
        return Err("Wrong password".to_string());
    }
    let key = derive_key(&password, &envelope.kdf_salt_hex)?;
    let nonce_bytes = hex::decode(&envelope.nonce_hex).map_err(|e| e.to_string())?;
    let ciphertext = hex::decode(&envelope.ciphertext_hex).map_err(|e| e.to_string())?;
    let plaintext = decrypt_bytes(&key, &nonce_bytes, &ciphertext)?;
    String::from_utf8(plaintext).map_err(|e| e.to_string())
}

/// Re-encrypts updated entities to disk. sessionUnlock is carried forward
/// unchanged from the existing envelope — this command only ever touches
/// the entities data itself.
#[tauri::command]
pub fn budget_save_entities_encrypted(app: tauri::AppHandle, password: String, data: String) -> Result<(), String> {
    // Wipe the password from memory when this function returns (all paths).
    let password = Zeroizing::new(password);
    let envelope = read_entities_envelope(&app).ok_or_else(|| "Encryption is not enabled".to_string())?;
    let parsed = PasswordHash::new(envelope.password_hash.trim()).map_err(|e| e.to_string())?;
    if Argon2::default().verify_password(password.as_bytes(), &parsed).is_err() {
        return Err("Wrong password — refusing to overwrite the encrypted file".to_string());
    }
    let key = derive_key(&password, &envelope.kdf_salt_hex)?;
    let (nonce_bytes, ciphertext) = encrypt_bytes(&key, data.as_bytes())?;
    let new_envelope = EntitiesEncryptedEnvelope {
        password_hash: envelope.password_hash,
        kdf_salt_hex: envelope.kdf_salt_hex,
        nonce_hex: hex::encode(nonce_bytes),
        ciphertext_hex: hex::encode(ciphertext),
        session_unlock: envelope.session_unlock,
    };
    let json = serde_json::to_string(&new_envelope).map_err(|e| e.to_string())?;
    backed_up_write_group(&app, &BUDGET_BACKUP_GROUP, "budget-entities.enc", json.as_bytes())
}

/* =============================================================================
   ENABLE ENCRYPTION
   Reads both plaintext files, encrypts each under one shared password/salt
   (generated once, duplicated into both envelopes), writes both envelope
   files, deletes both plaintexts.
============================================================================= */

#[tauri::command]
pub fn budget_enable_encryption(app: tauri::AppHandle, password: String) -> Result<(), String> {
    // Wipe the password from memory when this function returns (all paths).
    let password = Zeroizing::new(password);
    let data_path = get_data_path(&app, "budget-data.json");
    let plain_data = fs::read_to_string(&data_path).unwrap_or_else(|_| "{}".to_string());

    let entities_path = get_data_path(&app, "budget-entities.json");
    let (plain_entities, session_unlock) = match read_plaintext_entities(&app) {
        Some(wrapper) => (
            serde_json::to_string(&wrapper.entities).unwrap_or_else(|_| "{}".to_string()),
            wrapper.session_unlock,
        ),
        None => ("{}".to_string(), false),
    };

    // One password hash, one KDF salt — generated once, duplicated into both
    // envelopes below rather than referenced from a shared file.
    let salt = SaltString::generate(&mut OsRng);
    let password_hash = Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map_err(|e| e.to_string())?
        .to_string();

    let mut kdf_salt = [0u8; 16];
    AesOsRng.fill_bytes(&mut kdf_salt);
    let kdf_salt_hex = hex::encode(kdf_salt);

    let key = derive_key(&password, &kdf_salt_hex)?;

    let (data_nonce, data_ciphertext) = encrypt_bytes(&key, plain_data.as_bytes())?;
    let data_envelope = EncryptedEnvelope {
        password_hash: password_hash.clone(),
        kdf_salt_hex: kdf_salt_hex.clone(),
        nonce_hex: hex::encode(data_nonce),
        ciphertext_hex: hex::encode(data_ciphertext),
    };
    let data_json = serde_json::to_string(&data_envelope).map_err(|e| e.to_string())?;
    backed_up_write_group(&app, &BUDGET_BACKUP_GROUP, "budget-data.enc", data_json.as_bytes())?;

    let (entities_nonce, entities_ciphertext) = encrypt_bytes(&key, plain_entities.as_bytes())?;
    let entities_envelope = EntitiesEncryptedEnvelope {
        password_hash,
        kdf_salt_hex,
        nonce_hex: hex::encode(entities_nonce),
        ciphertext_hex: hex::encode(entities_ciphertext),
        session_unlock,
    };
    let entities_json = serde_json::to_string(&entities_envelope).map_err(|e| e.to_string())?;
    // If this second write fails, remove the data envelope written above so
    // the on-disk state stays all-or-nothing. A lone budget-data.enc with no
    // matching entities envelope would otherwise trip the legacy-artifact
    // detector on next launch and show a misleading "older-format file"
    // message — when the truth is simply "enabling failed, nothing changed."
    // The plaintext files are still untouched at this point, so backing out
    // loses nothing.
    if let Err(e) = backed_up_write_group(&app, &BUDGET_BACKUP_GROUP, "budget-entities.enc", entities_json.as_bytes()) {
        let _ = fs::remove_file(get_data_path(&app, "budget-data.enc"));
        return Err(e);
    }

    // Only delete plaintexts after both envelopes are safely written.
    if data_path.exists() {
        fs::remove_file(&data_path).map_err(|e| e.to_string())?;
    }
    if entities_path.exists() {
        fs::remove_file(&entities_path).map_err(|e| e.to_string())?;
    }

    Ok(())
}

/* =============================================================================
   DISABLE ENCRYPTION
   Verifies the password against BOTH envelopes independently — they should
   always agree since they were created together, but "assume two files
   agree" is exactly the bug this whole design exists to eliminate, so it's
   checked rather than assumed. Decrypts both, writes both plaintexts,
   removes both envelopes.
============================================================================= */

#[tauri::command]
pub fn budget_disable_encryption(app: tauri::AppHandle, password: String) -> Result<(), String> {
    // Wipe the password from memory when this function returns (all paths).
    let password = Zeroizing::new(password);
    let data_envelope = read_data_envelope(&app).ok_or_else(|| "Encryption is not enabled".to_string())?;
    let entities_envelope = read_entities_envelope(&app).ok_or_else(|| "Encryption is not enabled".to_string())?;

    let data_hash = PasswordHash::new(data_envelope.password_hash.trim()).map_err(|e| e.to_string())?;
    if Argon2::default().verify_password(password.as_bytes(), &data_hash).is_err() {
        return Err("Wrong password".to_string());
    }
    let entities_hash = PasswordHash::new(entities_envelope.password_hash.trim()).map_err(|e| e.to_string())?;
    if Argon2::default().verify_password(password.as_bytes(), &entities_hash).is_err() {
        return Err("Wrong password".to_string());
    }

    let data_key = derive_key(&password, &data_envelope.kdf_salt_hex)?;
    let data_nonce = hex::decode(&data_envelope.nonce_hex).map_err(|e| e.to_string())?;
    let data_ciphertext = hex::decode(&data_envelope.ciphertext_hex).map_err(|e| e.to_string())?;
    let plain_data = decrypt_bytes(&data_key, &data_nonce, &data_ciphertext)?;

    let entities_key = derive_key(&password, &entities_envelope.kdf_salt_hex)?;
    let entities_nonce = hex::decode(&entities_envelope.nonce_hex).map_err(|e| e.to_string())?;
    let entities_ciphertext = hex::decode(&entities_envelope.ciphertext_hex).map_err(|e| e.to_string())?;
    let plain_entities_bytes = decrypt_bytes(&entities_key, &entities_nonce, &entities_ciphertext)?;
    let entities_value: serde_json::Value =
        serde_json::from_slice(&plain_entities_bytes).map_err(|e| e.to_string())?;

    // Write both plaintexts first — only remove the envelopes after both succeed.
    backed_up_write_group(&app, &BUDGET_BACKUP_GROUP, "budget-data.json", &plain_data)?;

    let entities_wrapper = PlaintextEntitiesFile {
        session_unlock: entities_envelope.session_unlock,
        entities: entities_value,
    };
    let entities_json = serde_json::to_string(&entities_wrapper).map_err(|e| e.to_string())?;
    backed_up_write_group(&app, &BUDGET_BACKUP_GROUP, "budget-entities.json", entities_json.as_bytes())?;

    let data_enc_path = get_data_path(&app, "budget-data.enc");
    if data_enc_path.exists() {
        fs::remove_file(&data_enc_path).map_err(|e| e.to_string())?;
    }
    let entities_enc_path = get_data_path(&app, "budget-entities.enc");
    if entities_enc_path.exists() {
        fs::remove_file(&entities_enc_path).map_err(|e| e.to_string())?;
    }

    Ok(())
}

/* =============================================================================
   SESSION UNLOCK PREFERENCE
============================================================================= */

/// Updates sessionUnlock in place, in whichever shape the entities file is
/// currently in — never touches the password hash, salt, or ciphertext, so
/// this never needs a password.
#[tauri::command]
pub fn budget_set_session_unlock(app: tauri::AppHandle, session_unlock: bool) -> Result<(), String> {
    if let Some(mut envelope) = read_entities_envelope(&app) {
        envelope.session_unlock = session_unlock;
        let json = serde_json::to_string(&envelope).map_err(|e| e.to_string())?;
        return backed_up_write_group(&app, &BUDGET_BACKUP_GROUP, "budget-entities.enc", json.as_bytes());
    }

    let wrapper = PlaintextEntitiesFile {
        session_unlock,
        entities: match read_plaintext_entities(&app) {
            Some(existing) => existing.entities,
            None => serde_json::json!({}),
        },
    };
    let json = serde_json::to_string(&wrapper).map_err(|e| e.to_string())?;
    // Low-stakes and doesn't touch the ledger, but goes through the same
    // path as everything else for consistency.
    backed_up_write_group(&app, &BUDGET_BACKUP_GROUP, "budget-entities.json", json.as_bytes())
}
