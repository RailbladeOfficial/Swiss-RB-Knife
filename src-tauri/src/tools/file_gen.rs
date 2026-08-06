/* =============================================================================
   DUMMY FILE GENERATOR  — batch file creation
   -----------------------------------------------------------------------------
   Tauri command for the Dummy File Generator tool. Creates batches of dummy
   files in a timestamped output folder, with support for three naming modes
   (numeric, alpha, hex), three organize modes (flat, by-extension, by-line),
   and both text and binary extensions.

   Text extensions get a human-readable content line describing the file
   (number, alpha label, or hex value). Binary extensions get an empty file.

   Rust commands exposed:
     dfg_generate_files
============================================================================= */

use std::fs;
use std::path::PathBuf;
use chrono::Local;
use serde::{Deserialize, Serialize};

/* =============================================================================
   TYPES
============================================================================= */

#[derive(Deserialize, Clone, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum NamingMode {
    Numeric,
    Alpha,
    Hex,
}

#[derive(Deserialize, Clone, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum OrganizeMode {
    Flat,
    #[serde(rename = "byext")]
    ByExt,
    #[serde(rename = "byline")]
    ByLine,
}

#[derive(Deserialize)]
pub struct BatchEntry {
    pub count: u32,
    pub prefix: String,
    #[serde(rename = "namingMode")]
    pub naming_mode: NamingMode,
    pub suffix: String,
    pub extension: String,
}

#[derive(Serialize)]
pub struct BreakdownItem {
    pub extension: String,
    pub count: u32,
}

#[derive(Serialize)]
pub struct GenerateResult {
    pub folder: String,
    #[serde(rename = "totalCount")]
    pub total_count: u32,
    pub breakdown: Vec<BreakdownItem>,
}

/* =============================================================================
   EXTENSION SETS
============================================================================= */

const TEXT_EXTENSIONS: &[&str] = &[
    ".txt", ".csv", ".json", ".md", ".html", ".xml", ".js", ".css", ".log",
    ".tsv", ".yaml", ".rb", ".py", ".java", ".cpp", ".c", ".php", ".pl",
    ".sh", ".bat", ".ini", ".conf", ".sql", ".r", ".go", ".swift", ".scala",
    ".doc", ".docx", ".rtf", ".odt", ".tex", ".markdown", ".ts", ".jsx",
    ".tsx", ".vue", ".toml", ".env", ".gitignore",
];

const BINARY_EXTENSIONS: &[&str] = &[
    ".bmp", ".jpg", ".jpeg", ".png", ".gif", ".webp", ".ico", ".tiff", ".svg",
    ".mp3", ".wav", ".ogg", ".flac", ".aac", ".m4a",
    ".mp4", ".mkv", ".avi", ".mov", ".wmv", ".webm",
    ".zip", ".tar", ".gz", ".rar", ".7z",
    ".pdf", ".epub", ".xlsx", ".pptx",
    ".exe", ".dll", ".so", ".bin", ".iso",
];

fn is_text_extension(ext: &str) -> bool { TEXT_EXTENSIONS.contains(&ext) }
fn is_valid_extension(ext: &str) -> bool {
    TEXT_EXTENSIONS.contains(&ext) || BINARY_EXTENSIONS.contains(&ext)
}

/// Validates a user-supplied filename fragment (prefix or suffix). Empty is
/// fine — both fields are optional — but anything present must be safe to
/// embed in a filename: no path separators, no "..", no Windows-illegal or
/// control characters.
fn validate_name_part(part: &str, field: &str) -> Result<(), String> {
    let trimmed = part.trim();
    if trimmed.contains("..") {
        return Err(format!("{field} cannot contain '..'."));
    }
    const ILLEGAL: [char; 9] = ['/', '\\', ':', '*', '?', '"', '<', '>', '|'];
    if let Some(bad) = trimmed.chars().find(|c| ILLEGAL.contains(c) || (*c as u32) < 0x20) {
        return Err(format!(
            "{field} contains a character that isn't allowed in filenames: '{}'",
            if (bad as u32) < 0x20 { '\u{FFFD}' } else { bad }
        ));
    }
    // Deliberately NOT checked here: whether this part is a reserved Windows
    // device name. A prefix/suffix is never the whole filename stem — the
    // sequence identifier is always appended — so rejecting "con" here would
    // refuse a perfectly valid prefix that generates con001.txt. The composed
    // filename is what has to be legal, and that is checked at the point it is
    // built (see the generation loop).
    Ok(())
}

/* =============================================================================
   FILENAME SEQUENCING
============================================================================= */

fn format_numeric(number: u32, total: u32) -> String {
    let width = total.to_string().len();
    format!("{:0>width$}", number, width = width)
}

/// Raw Excel-style alpha (1-based, no padding): 1→"a", 26→"z", 27→"aa"…
fn format_alpha_raw(mut n: u32) -> String {
    let mut chars = Vec::new();
    loop {
        let rem = ((n - 1) % 26) as u8;
        chars.push((b'a' + rem) as char);
        n = (n - 1) / 26;
        if n == 0 { break; }
    }
    chars.iter().rev().collect()
}

fn format_hex(number: u32, total: u32) -> String {
    let width = if total == 0 { 1 } else { format!("{:X}", total).len().max(4) };
    format!("{:0>width$X}", number, width = width)
}

fn build_identifier(mode: &NamingMode, number: u32, total: u32) -> String {
    match mode {
        NamingMode::Numeric => format_numeric(number, total),
        NamingMode::Alpha   => format_alpha_raw(number),
        NamingMode::Hex     => format_hex(number, total),
    }
}

/// Build the text content line describing the file.
/// For numeric: "This is .txt file number 01 of 25"
/// For alpha:   "This is .txt file number 19 (as) of 25 (ay)"
/// For hex:     "This is .txt file number 19 (0013) of 25 (0019)"
fn build_content(mode: &NamingMode, ext: &str, number: u32, total: u32) -> String {
    match mode {
        NamingMode::Numeric => {
            let id = format_numeric(number, total);
            format!("This is {} file number {} of {}", ext, id, total)
        }
        NamingMode::Alpha => {
            let num_id    = format_numeric(number, total);
            let alpha_id  = format_alpha_raw(number);
            let alpha_tot = format_alpha_raw(total);
            format!(
                "This is {} file number {} ({}) of {} ({})",
                ext, num_id, alpha_id, total, alpha_tot
            )
        }
        NamingMode::Hex => {
            let num_id  = format_numeric(number, total);
            let hex_id  = format_hex(number, total);
            let hex_tot = format_hex(total, total);
            format!(
                "This is {} file number {} ({}) of {} ({})",
                ext, num_id, hex_id, total, hex_tot
            )
        }
    }
}

/* =============================================================================
   TAURI COMMAND
============================================================================= */

/// Ceiling on rows per run. The per-row count cap alone doesn't bound the
/// batch — nothing stops a caller sending a thousand rows of 10,000 — and the
/// frontend imposes no row limit of its own, so this is the only gate.
const MAX_ENTRIES: usize = 100;
/// Ceiling on total files per run, checked after summing every row. Bounds the
/// batch even when both the row count and each row's count are individually
/// legal (100 x 10,000 would otherwise be a million files).
const MAX_TOTAL_FILES: u64 = 100_000;

#[tauri::command]
pub fn dfg_generate_files(
    entries: Vec<BatchEntry>,
    output_dir: Option<String>,
    organize_mode: OrganizeMode,
) -> Result<GenerateResult, String> {
    if entries.is_empty() {
        return Err("No entries provided.".into());
    }
    if entries.len() > MAX_ENTRIES {
        return Err(format!(
            "Too many rows: {} (maximum is {MAX_ENTRIES} per run).",
            entries.len()
        ));
    }

    // u64 so the sum can't overflow before the cap is checked — 100 rows of
    // u32::MAX would wrap a u32 accumulator and slip past the comparison.
    let requested_total: u64 = entries.iter().map(|e| e.count as u64).sum();
    if requested_total > MAX_TOTAL_FILES {
        return Err(format!(
            "This batch would create {requested_total} files; the maximum is \
             {MAX_TOTAL_FILES} per run. Split it across several runs."
        ));
    }

    for (i, entry) in entries.iter().enumerate() {
        let label = if entries.len() > 1 { format!("Row {}: ", i + 1) } else { String::new() };
        if entry.count == 0 {
            return Err(format!("{label}Count must be a positive integer."));
        }
        if entry.count > 10_000 {
            return Err(format!("{label}Count cannot exceed 10,000 per type."));
        }
        // Prefix/suffix become part of filenames joined onto the output
        // folder — path separators or ".." in them would let generated files
        // land OUTSIDE the timestamped folder, and Windows-illegal characters
        // would fail with a cryptic OS error mid-batch. Reject both up front
        // with a message that names the offending field.
        validate_name_part(&entry.prefix, &format!("{label}Prefix"))?;
        validate_name_part(&entry.suffix, &format!("{label}Suffix"))?;
        let ext = entry.extension.trim().to_lowercase();
        if !ext.starts_with('.') {
            return Err(format!("{label}Extension must begin with a period (got '{ext}')."));
        }
        if !is_valid_extension(&ext) {
            return Err(format!("{label}Unsupported extension '{ext}'."));
        }
    }

    let base: PathBuf = if let Some(dir) = output_dir.filter(|d| !d.trim().is_empty()) {
        PathBuf::from(dir.trim())
    } else {
        dirs::download_dir()
            .or_else(dirs::home_dir)
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
    };

    if !base.exists() {
        return Err(format!("Output directory does not exist: {}", base.display()));
    }

    let timestamp   = Local::now().format("%Y-%m-%d-%H-%M-%S");
    let folder_name = format!("files-generated-{timestamp}");
    let root_path   = base.join(&folder_name);
    fs::create_dir_all(&root_path)
        .map_err(|e| format!("Failed to create output folder: {e}"))?;

    let mut breakdown: Vec<BreakdownItem> = Vec::new();
    let mut total_count: u32 = 0;

    for (line_idx, entry) in entries.iter().enumerate() {
        let ext    = entry.extension.trim().to_lowercase();
        let prefix = entry.prefix.trim();
        let suffix = entry.suffix.trim();

        let target_dir = match organize_mode {
            OrganizeMode::Flat   => root_path.clone(),
            OrganizeMode::ByExt  => {
                let sub = root_path.join(ext.trim_start_matches('.'));
                fs::create_dir_all(&sub)
                    .map_err(|e| format!("Failed to create subfolder: {e}"))?;
                sub
            }
            OrganizeMode::ByLine => {
                let width    = entries.len().to_string().len();
                let sub_name = format!("line-{:0>width$}", line_idx + 1, width = width);
                let sub      = root_path.join(&sub_name);
                fs::create_dir_all(&sub)
                    .map_err(|e| format!("Failed to create subfolder '{sub_name}': {e}"))?;
                sub
            }
        };

        let write_text = is_text_extension(&ext);

        for i in 1..=entry.count {
            let id        = build_identifier(&entry.naming_mode, i, entry.count);
            let file_name = format!("{}{}{}{}", prefix, id, suffix, ext);

            // The composed stem is what Windows actually resolves, so this is
            // the only place the device-name check is meaningful. Contrived
            // but reachable: prefix "co" + alpha identifier "n" composes to
            // "con.txt", which would write to the console device and silently
            // produce no file.
            if crate::is_reserved_device_name(&file_name) {
                return Err(format!(
                    "This combination generates '{file_name}', which is a reserved Windows \
                     device name. Adjust the prefix, suffix, or naming mode."
                ));
            }

            let file_path = target_dir.join(&file_name);

            if write_text {
                let content = build_content(&entry.naming_mode, &ext, i, entry.count);
                fs::write(&file_path, content)
                    .map_err(|e| format!("Failed to write '{file_name}': {e}"))?;
            } else {
                fs::write(&file_path, b"")
                    .map_err(|e| format!("Failed to create '{file_name}': {e}"))?;
            }
        }

        breakdown.push(BreakdownItem { extension: ext.clone(), count: entry.count });
        total_count += entry.count;
    }

    Ok(GenerateResult {
        folder: root_path.to_string_lossy().into_owned(),
        total_count,
        breakdown,
    })
}
