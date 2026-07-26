/* =============================================================================
   IMAGE CCR  — Combine / Compress / Resize
   -----------------------------------------------------------------------------
   Tauri commands for the Image CCR tool. All image processing uses the `image`
   crate (v0.25); no ImageMagick dependency.

   Tabs / commands:
     Combine  — stack 2+ images into one with gap, border, and format options
                (get_image_info, preview_combine, combine_images)
     Compress — scale a single image by percentage
                (compress_image)
     Resize   — batch-resize a set of images (a folder OR a hand-picked file
                list) to a target dimension / canvas size, running on a
                dedicated thread with live progress events
                (scan_resize_sources, resize_images, cancel_resize)
     Utility  — show_in_explorer (shared across tabs)

   THREADING MODEL
   ---------------
   Every command here that touches image bytes is CPU-bound. A plain
   #[tauri::command] runs on the thread that services the IPC message, so a
   heavy decode/encode loop there freezes the whole UI until it returns — which
   is exactly what a big Resize folder used to do (hundreds of full image
   decodes, synchronously, on the UI path). Two rules fix that class of bug:

     • Never fully decode an image just to read its size. get_image_info and
       the resize scan use image::image_dimensions(), which reads only the
       header — orders of magnitude faster than image::open() on large files.

     • Never do the CPU work on the IPC thread. The one-shot commands
       (get_image_info / preview_combine / combine_images / compress_image) are
       `async` and hand their body to async_runtime::spawn_blocking, so the
       work lands on a blocking-pool thread and the UI stays live. The batch
       jobs (scan_resize_sources, resize_images) run their loop on a dedicated
       thread and report back through Tauri events:
         scan   → "resize-scan-progress"
         resize → "resize-progress" / "resize-complete"

     • resize_images fans its work out across a small pool of worker threads
       (std::thread + a shared atomic work-claim index, not a new dependency)
       instead of resizing one image at a time. The pool size is derived from
       available_parallelism(), minus one core left free for the OS/UI, and
       capped at 8 — so a 16-core desktop actually uses its hardware, while a
       2-core laptop falls back to a single worker (i.e. today's sequential
       behaviour) instead of contending with itself.
============================================================================= */

use image::{DynamicImage, GenericImageView, ImageFormat};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

// =============================================================================
//  SHARED STRUCTS
// =============================================================================

#[derive(serde::Serialize)]
pub struct ImageInfo {
    path: String,
    name: String,
    width: u32,
    height: u32,
    size_bytes: u64,
}

#[derive(serde::Serialize)]
pub struct CombineResult {
    output_path: String,
    width: u32,
    height: u32,
    size_bytes: u64,
}

#[derive(serde::Serialize)]
pub struct PreviewResult {
    temp_path: String,
    width: u32,
    height: u32,
}

#[derive(serde::Serialize)]
pub struct CompressResult {
    output_path: String,
    width: u32,
    height: u32,
    size_bytes: u64,
}

// =============================================================================
//  OUTPUT NAME VALIDATION
// =============================================================================

/// Rejects an output filename (the stem, WITHOUT extension) that could escape
/// the chosen output folder or that Windows can't create. combine_images and
/// compress_image join this straight onto the output dir, so a value with a
/// path separator, ".." , or an absolute path would otherwise write OUTSIDE it
/// — and because this app runs elevated, that write lands with the admin token.
/// This is the same guard the Dummy File Generator (validate_name_part) and the
/// Time Tracker CSV export (sanitize_filename) already apply to their
/// user-supplied names; Image CCR just never had it.
fn validate_output_name(name: &str) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Output name is empty.".to_string());
    }
    if trimmed.contains("..") {
        return Err("Output name cannot contain '..'.".to_string());
    }
    const ILLEGAL: [char; 9] = ['/', '\\', ':', '*', '?', '"', '<', '>', '|'];
    if let Some(bad) = trimmed.chars().find(|c| ILLEGAL.contains(c) || (*c as u32) < 0x20) {
        return Err(format!(
            "Output name contains a character that isn't allowed in filenames: '{}'",
            if (bad as u32) < 0x20 { '\u{FFFD}' } else { bad }
        ));
    }
    Ok(())
}

// =============================================================================
//  get_image_info
// =============================================================================

/// async + spawn_blocking so a large source image never stalls the UI while
/// its header is read. Uses image_dimensions() (header only) rather than a full
/// image::open() decode — this command only needs width/height/size, and the
/// Combine tab may call it once per file across a whole multi-select.
#[tauri::command]
pub async fn get_image_info(path: String) -> Result<ImageInfo, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<ImageInfo, String> {
        let p = Path::new(&path);

        let size_bytes = std::fs::metadata(p)
            .map_err(|e| format!("Cannot read file metadata: {e}"))?
            .len();

        let (width, height) =
            image::image_dimensions(p).map_err(|e| format!("Cannot read image: {e}"))?;

        let name = p
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string();

        Ok(ImageInfo {
            path,
            name,
            width,
            height,
            size_bytes,
        })
    })
    .await
    .map_err(|e| format!("Image info task failed: {e}"))?
}

// =============================================================================
//  COMBINE  — shared compositing logic
// =============================================================================

/// Parse a colour spec into [r, g, b, a].
///
/// Accepts a CSS hex string (#RRGGBB or #RGB), which parses to an opaque
/// colour (a = 255), OR the literal sentinel "transparent" (case-insensitive)
/// / an empty string, which parses to a fully transparent fill (a = 0).
///
/// Transparency only survives in a format that has an alpha channel: saving an
/// RGBA image as JPG drops the alpha and the transparent regions flatten to
/// black. The frontend warns about that; here we just honour whatever fill the
/// caller asked for.
fn parse_hex_color(hex: &str) -> [u8; 4] {
    let trimmed = hex.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("transparent") {
        return [0, 0, 0, 0];
    }
    let hex = trimmed.trim_start_matches('#');
    let expanded: String = if hex.len() == 3 {
        hex.chars().flat_map(|c| [c, c]).collect()
    } else {
        hex.to_string()
    };
    let r = u8::from_str_radix(expanded.get(0..2).unwrap_or("00"), 16).unwrap_or(0);
    let g = u8::from_str_radix(expanded.get(2..4).unwrap_or("00"), 16).unwrap_or(0);
    let b = u8::from_str_radix(expanded.get(4..6).unwrap_or("00"), 16).unwrap_or(0);
    [r, g, b, 255]
}

/// Core compositing: takes loaded images and all options, returns a DynamicImage.
/// Images are NOT rotated to match orientation; mismatched sizes are padded with
/// canvas_rgba so they align correctly (centred on the cross-axis).
fn composite_images(
    images: &[DynamicImage],
    direction: &str,
    gap_px: u32,
    canvas_rgba: [u8; 4],
    border_px: u32,
    border_rgba: [u8; 4],
) -> DynamicImage {
    let n = images.len() as u32;
    let gap_count = n.saturating_sub(1);

    // ── Compose images onto canvas ──────────────────────────────────────────
    let composited = match direction {
        "below" | "above" => {
            let canvas_w: u32 = images.iter().map(|i| i.width()).max().unwrap_or(0);
            let imgs_h: u32   = images.iter().map(|i| i.height()).sum();
            let canvas_h: u32 = imgs_h + gap_count * gap_px;

            // Pre-fill canvas with canvas color (used for padding + gap bands)
            let mut canvas = image::RgbaImage::from_pixel(
                canvas_w, canvas_h, image::Rgba(canvas_rgba),
            );

            let mut y_offset = 0u32;
            for (idx, img) in images.iter().enumerate() {
                let rgba = img.to_rgba8();
                // Horizontally centre narrower images
                let x_off = (canvas_w.saturating_sub(img.width())) / 2;
                image::imageops::overlay(&mut canvas, &rgba, x_off as i64, y_offset as i64);
                y_offset += img.height();
                // Gap band (canvas color already there; skip explicit fill)
                if idx + 1 < images.len() {
                    y_offset += gap_px;
                }
            }

            DynamicImage::ImageRgba8(canvas)
        }
        _ /* "left" | "right" */ => {
            let imgs_w: u32   = images.iter().map(|i| i.width()).sum();
            let canvas_h: u32 = images.iter().map(|i| i.height()).max().unwrap_or(0);
            let canvas_w: u32 = imgs_w + gap_count * gap_px;

            let mut canvas = image::RgbaImage::from_pixel(
                canvas_w, canvas_h, image::Rgba(canvas_rgba),
            );

            let mut x_offset = 0u32;
            for (idx, img) in images.iter().enumerate() {
                let rgba = img.to_rgba8();
                // Vertically centre shorter images
                let y_off = (canvas_h.saturating_sub(img.height())) / 2;
                image::imageops::overlay(&mut canvas, &rgba, x_offset as i64, y_off as i64);
                x_offset += img.width();
                if idx + 1 < images.len() {
                    x_offset += gap_px;
                }
            }

            DynamicImage::ImageRgba8(canvas)
        }
    };

    // ── Apply border (uniform padding around the composited image) ──────────
    if border_px > 0 {
        let (cw, ch) = composited.dimensions();
        let full_w = cw + border_px * 2;
        let full_h = ch + border_px * 2;
        let mut canvas = image::RgbaImage::from_pixel(full_w, full_h, image::Rgba(border_rgba));
        let inner = composited.to_rgba8();
        image::imageops::overlay(&mut canvas, &inner, border_px as i64, border_px as i64);
        DynamicImage::ImageRgba8(canvas)
    } else {
        composited
    }
}

/// Load images from paths and reverse order for "above"/"left" directions.
fn load_and_order(paths: &[String], direction: &str) -> Result<Vec<DynamicImage>, String> {
    let mut images: Vec<DynamicImage> = paths
        .iter()
        .map(|p| image::open(p).map_err(|e| format!("Cannot open {p}: {e}")))
        .collect::<Result<_, _>>()?;

    if direction == "above" || direction == "left" {
        images.reverse();
    }

    Ok(images)
}

// =============================================================================
//  preview_combine
// =============================================================================

/// Generates a downscaled preview into the system temp directory.
/// Does NOT save to the user's chosen output folder.
/// Returns the temp file path so the frontend can display it via asset protocol.
#[tauri::command]
pub async fn preview_combine(
    paths: Vec<String>,
    direction: String,
    gap: Option<u32>,
    canvas_color: Option<String>,
    border_enabled: Option<bool>,
    border_thickness: Option<u32>,
    border_color: Option<String>,
    output_format: Option<String>,
) -> Result<PreviewResult, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<PreviewResult, String> {
        if paths.len() < 2 {
            return Err("Need at least 2 images.".to_string());
        }

        let valid_dirs = ["above", "below", "left", "right"];
        if !valid_dirs.contains(&direction.as_str()) {
            return Err(format!("Invalid direction '{direction}'."));
        }

        let gap_px       = gap.unwrap_or(0);
        let border_on    = border_enabled.unwrap_or(false);
        let border_px    = if border_on { border_thickness.unwrap_or(0) } else { 0 };
        let canvas_rgba  = parse_hex_color(canvas_color.as_deref().unwrap_or("#ffffff"));
        let border_rgba  = parse_hex_color(border_color.as_deref().unwrap_or("#000000"));

        let images = load_and_order(&paths, &direction)?;
        let combined = composite_images(&images, &direction, gap_px, canvas_rgba, border_px, border_rgba);

        // Scale down for preview (max 1200px on the long edge)
        let (w, h) = combined.dimensions();
        let max_side = 1200u32;
        let preview = if w > max_side || h > max_side {
            let scale = max_side as f32 / w.max(h) as f32;
            let nw = (w as f32 * scale).round() as u32;
            let nh = (h as f32 * scale).round() as u32;
            combined.resize_exact(nw, nh, image::imageops::FilterType::Triangle)
        } else {
            combined
        };

        let (pw, ph) = preview.dimensions();

        // Write to temp file
        let use_png = output_format.as_deref() == Some("png");
        let ext     = if use_png { "png" } else { "jpg" };
        let temp_path = std::env::temp_dir().join(format!("swiss_rb_knife_preview.{ext}"));
        let fmt       = if use_png { ImageFormat::Png } else { ImageFormat::Jpeg };

        preview
            .save_with_format(&temp_path, fmt)
            .map_err(|e| format!("Failed to write preview: {e}"))?;

        Ok(PreviewResult {
            temp_path: temp_path.to_string_lossy().to_string(),
            width: pw,
            height: ph,
        })
    })
    .await
    .map_err(|e| format!("Preview task failed: {e}"))?
}

// =============================================================================
//  combine_images
// =============================================================================

#[tauri::command]
pub async fn combine_images(
    paths: Vec<String>,
    direction: String,
    output_folder: Option<String>,
    output_name: String,
    gap: Option<u32>,
    canvas_color: Option<String>,
    border_enabled: Option<bool>,
    border_thickness: Option<u32>,
    border_color: Option<String>,
    output_format: Option<String>,
) -> Result<CombineResult, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<CombineResult, String> {
        if paths.len() < 2 {
            return Err("Need at least 2 images to combine.".to_string());
        }

        let valid_dirs = ["above", "below", "left", "right"];
        if !valid_dirs.contains(&direction.as_str()) {
            return Err(format!(
                "Invalid direction '{direction}'. Use: above, below, left, right."
            ));
        }

        // Guard the output name before doing any image work — a traversal or
        // absolute-path value must be rejected, not joined onto the output dir.
        validate_output_name(&output_name)?;

        let gap_px       = gap.unwrap_or(0);
        let border_on    = border_enabled.unwrap_or(false);
        let border_px    = if border_on { border_thickness.unwrap_or(0) } else { 0 };
        let canvas_rgba  = parse_hex_color(canvas_color.as_deref().unwrap_or("#ffffff"));
        let border_rgba  = parse_hex_color(border_color.as_deref().unwrap_or("#000000"));

        let images  = load_and_order(&paths, &direction)?;
        let combined = composite_images(&images, &direction, gap_px, canvas_rgba, border_px, border_rgba);

        // ── Determine output format ──────────────────────────────────────────
        let use_png  = output_format.as_deref() == Some("png");
        let ext      = if use_png { "png" } else { "jpg" };
        let fmt      = if use_png { ImageFormat::Png } else { ImageFormat::Jpeg };

        // ── Determine output folder ──────────────────────────────────────────
        let first_path = paths[0].replace('/', "\\");
        let first_dir  = Path::new(&first_path)
            .parent()
            .unwrap_or(Path::new("."))
            .to_path_buf();
        let out_dir: PathBuf = output_folder.map(PathBuf::from).unwrap_or(first_dir);
        let out_path = out_dir.join(format!("{output_name}.{ext}"));

        combined
            .save_with_format(&out_path, fmt)
            .map_err(|e| format!("Failed to save combined image: {e}"))?;

        let (width, height) = combined.dimensions();
        let size_bytes = std::fs::metadata(&out_path).map(|m| m.len()).unwrap_or(0);

        Ok(CombineResult {
            output_path: out_path.to_string_lossy().to_string(),
            width,
            height,
            size_bytes,
        })
    })
    .await
    .map_err(|e| format!("Combine task failed: {e}"))?
}

// =============================================================================
//  compress_image
// =============================================================================

#[tauri::command]
pub async fn compress_image(
    path: String,
    percentage: u32,
    output_folder: Option<String>,
    output_name: String,
) -> Result<CompressResult, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<CompressResult, String> {
        if !(1..=99).contains(&percentage) {
            return Err("Percentage must be between 1 and 99.".to_string());
        }

        // Guard the output name before touching the image — see validate_output_name.
        validate_output_name(&output_name)?;

        let clean_path = path.replace('/', "\\");
        let p = Path::new(&clean_path);
        let img = image::open(p).map_err(|e| format!("Cannot open image: {e}"))?;

        let (orig_w, orig_h) = img.dimensions();
        let scale = percentage as f32 / 100.0;
        let new_w = (orig_w as f32 * scale).round() as u32;
        let new_h = (orig_h as f32 * scale).round() as u32;

        if new_w == 0 || new_h == 0 {
            return Err("Resulting dimensions would be 0px. Choose a higher percentage.".to_string());
        }

        let resized = img.resize_exact(new_w, new_h, image::imageops::FilterType::Lanczos3);

        let ext = p
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("jpg")
            .to_lowercase();

        let out_dir: PathBuf = output_folder
            .map(PathBuf::from)
            .unwrap_or_else(|| p.parent().unwrap_or(Path::new(".")).to_path_buf());

        let out_path = out_dir.join(format!("{output_name}.{ext}"));

        let fmt = match ext.as_str() {
            "png"  => ImageFormat::Png,
            "gif"  => ImageFormat::Gif,
            "webp" => ImageFormat::WebP,
            _      => ImageFormat::Jpeg,
        };

        resized
            .save_with_format(&out_path, fmt)
            .map_err(|e| format!("Failed to save compressed image: {e}"))?;

        let size_bytes = std::fs::metadata(&out_path).map(|m| m.len()).unwrap_or(0);

        Ok(CompressResult {
            output_path: out_path.to_string_lossy().to_string(),
            width: new_w,
            height: new_h,
            size_bytes,
        })
    })
    .await
    .map_err(|e| format!("Compress task failed: {e}"))?
}

// =============================================================================
//  show_in_explorer
// =============================================================================

/// Opens the system file explorer at the given path, selecting the file if possible.
/// Falls back to opening the parent directory on Linux.
#[tauri::command]
pub fn show_in_explorer(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // IMPORTANT: /select, must be glued to the path as ONE argument with
        // no space after the comma. Passing them as two separate .args()
        // entries makes Rust's process spawner rejoin them with a space when
        // it builds the actual Windows command line (e.g.
        // `explorer.exe /select, "C:\path"`), which explorer.exe's picky
        // parser silently fails on — it just opens a bare window instead
        // (whatever your Explorer's default location is, e.g. Desktop) with
        // nothing selected. A single combined argument avoids that: Rust
        // will still quote it as a whole if the path contains spaces,
        // producing the one correct form: "/select,C:\path with spaces\file".
        std::process::Command::new(crate::windows_dir_exe("explorer.exe"))
            .arg(format!("/select,{}", path))
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        let parent = Path::new(&path)
            .parent()
            .unwrap_or(Path::new("/"))
            .to_string_lossy()
            .to_string();
        std::process::Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// =============================================================================
//  scan_resize_sources
// =============================================================================

/// Result of a source scan: the concrete list of image paths the resize will
/// operate on, plus dimension stats for the UI. Returning the resolved paths
/// (rather than re-reading the folder at resize time) is what lets Resize work
/// identically for a browsed folder and a hand-picked file selection — the run
/// step just consumes this list.
#[derive(serde::Serialize)]
pub struct ResizeScanResult {
    paths: Vec<String>,
    count: u32,
    min_w: u32,
    max_w: u32,
    min_h: u32,
    max_h: u32,
}

/// Emitted periodically during a scan so the UI can show real movement while
/// hundreds of image headers are read.
#[derive(Clone, serde::Serialize)]
pub struct ResizeScanProgressEvent {
    pub done:  u32,
    pub total: u32,
}

#[derive(Clone, serde::Serialize)]
pub struct ResizeProgressEvent {
    pub current_file: String,
    pub done:         u32,
    pub total:        u32,
}

#[derive(Clone, serde::Serialize)]
pub struct ResizeCompleteEvent {
    pub success:       bool,
    pub message:       String,
    pub output_folder: String,
    pub count:         u32,
}

static RESIZE_CANCEL: AtomicBool = AtomicBool::new(false);

/// True while a resize thread is alive. The frontend disables its Run button
/// during a job, but the backend guards independently — two concurrent jobs
/// would share one cancel flag and race each other's progress events.
static RESIZE_RUNNING: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub fn cancel_resize() {
    RESIZE_CANCEL.store(true, Ordering::SeqCst);
}

const RESIZE_SUPPORTED_EXTS: [&str; 8] =
    ["jpg", "jpeg", "png", "gif", "webp", "bmp", "tiff", "tif"];

fn has_supported_ext(p: &Path) -> bool {
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    RESIZE_SUPPORTED_EXTS.contains(&ext.as_str())
}

/// Scans a set of source images and returns their dimension statistics plus the
/// resolved path list. Accepts EITHER a `folder` (enumerated for supported
/// images) OR an explicit `files` list (e.g. a hand-picked multi-select) — this
/// is how the Resize tab supports both "browse a folder" and "pick files".
///
/// Runs on a blocking-pool thread (spawn_blocking) so the UI stays responsive
/// even for a large folder, and reads each header with image_dimensions()
/// rather than a full decode — the previous full-decode-per-file loop is what
/// made a big folder freeze the app for minutes. Progress is reported via
/// "resize-scan-progress" events, throttled to ~1% steps so a huge folder
/// doesn't flood the event channel.
#[tauri::command]
pub async fn scan_resize_sources(
    app: AppHandle,
    folder: Option<String>,
    files: Option<Vec<String>>,
) -> Result<ResizeScanResult, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<ResizeScanResult, String> {
        // ── Resolve the candidate path list ──────────────────────────────────
        let candidates: Vec<PathBuf> = match (folder, files) {
            (_, Some(list)) if !list.is_empty() => list
                .into_iter()
                .map(PathBuf::from)
                .filter(|p| p.is_file() && has_supported_ext(p))
                .collect(),
            (Some(dir), _) => {
                let entries = std::fs::read_dir(&dir)
                    .map_err(|e| format!("Cannot read folder: {e}"))?;
                entries
                    .flatten()
                    .map(|e| e.path())
                    .filter(|p| p.is_file() && has_supported_ext(p))
                    .collect()
            }
            _ => return Err("No source folder or files provided.".to_string()),
        };

        let total = candidates.len() as u32;
        // Throttle: at least every file for small sets, ~every 1% for big ones.
        let step = (total / 100).max(1);

        let mut paths: Vec<String> = Vec::new();
        let mut min_w = u32::MAX;
        let mut max_w = 0u32;
        let mut min_h = u32::MAX;
        let mut max_h = 0u32;
        let mut scanned = 0u32;

        for path in &candidates {
            // Header-only read; files that fail to parse are simply skipped so
            // one bad image can't abort the whole scan.
            if let Ok((w, h)) = image::image_dimensions(path) {
                paths.push(path.to_string_lossy().to_string());
                min_w = min_w.min(w);
                max_w = max_w.max(w);
                min_h = min_h.min(h);
                max_h = max_h.max(h);
            }
            scanned += 1;
            if scanned % step == 0 || scanned == total {
                let _ = app.emit("resize-scan-progress", ResizeScanProgressEvent {
                    done: scanned,
                    total,
                });
            }
        }

        let count = paths.len() as u32;
        if count == 0 {
            return Ok(ResizeScanResult {
                paths, count: 0, min_w: 0, max_w: 0, min_h: 0, max_h: 0,
            });
        }

        Ok(ResizeScanResult { paths, count, min_w, max_w, min_h, max_h })
    })
    .await
    .map_err(|e| format!("Scan task failed: {e}"))?
}

// =============================================================================
//  resize_images
// =============================================================================

/// Spawns the resize job on a dedicated thread and returns immediately.
/// Progress is communicated via "resize-progress" and "resize-complete" events.
///
/// `paths` is the resolved image list (from scan_resize_sources), so a browsed
/// folder and a hand-picked file selection take exactly the same run path.
/// `source_folder`, when present, is used only to name the default output
/// folder (`<folder>/resized-<ts>`); with a picked file list it's None and the
/// default lands next to the first source image instead.
#[tauri::command]
pub fn resize_images(
    app: AppHandle,
    paths: Vec<String>,
    source_folder: Option<String>,
    output_folder: Option<String>,
    target_w: Option<u32>,
    target_h: Option<u32>,
    canvas_w: Option<u32>,
    canvas_h: Option<u32>,
    gravity: Option<String>,
    bg_color: Option<String>,
    output_format: Option<String>,
) -> Result<(), String> {
    if paths.is_empty() {
        return Err("No source images selected.".to_string());
    }
    // Refuse to start if a job is already in flight — swap() makes the
    // check-and-claim atomic, so simultaneous invokes can't both proceed.
    if RESIZE_RUNNING.swap(true, Ordering::SeqCst) {
        return Err("A resize job is already running.".to_string());
    }
    RESIZE_CANCEL.store(false, Ordering::SeqCst);
    let image_paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    std::thread::spawn(move || {
        resize_images_thread(
            app, image_paths, source_folder, output_folder,
            target_w, target_h, canvas_w, canvas_h,
            gravity, bg_color, output_format,
        );
        // resize_images_thread returns on every completion path, so clearing
        // the flag here covers success, failure, and cancellation alike.
        RESIZE_RUNNING.store(false, Ordering::SeqCst);
    });
    Ok(())
}

fn resize_images_thread(
    app: AppHandle,
    image_paths: Vec<PathBuf>,
    source_folder: Option<String>,
    output_folder: Option<String>,
    target_w: Option<u32>,
    target_h: Option<u32>,
    canvas_w: Option<u32>,
    canvas_h: Option<u32>,
    gravity: Option<String>,
    bg_color: Option<String>,
    output_format: Option<String>,
) {
    let gravity_str = gravity.as_deref().unwrap_or("center").to_string();
    let bg_rgba     = parse_hex_color(bg_color.as_deref().unwrap_or("#000000"));
    let use_png     = output_format.as_deref() == Some("png");
    let out_ext     = if use_png { "png" } else { "jpg" };
    let out_fmt     = if use_png { ImageFormat::Png } else { ImageFormat::Jpeg };

    // The image list arrives already resolved (scan_resize_sources filtered and
    // validated it), so there's no folder enumeration here. total is just its
    // length; the caller guarantees it's non-empty.
    let total = image_paths.len() as u32;

    // ── Determine output folder ──────────────────────────────────────────────
    let out_dir: PathBuf = if let Some(f) = output_folder {
        PathBuf::from(f)
    } else {
        // Default lands in the source folder when one was browsed; for a picked
        // file list there's no single folder, so fall back to the parent of the
        // first selected image.
        let base_dir: PathBuf = source_folder
            .as_deref()
            .map(PathBuf::from)
            .or_else(|| image_paths.first().and_then(|p| p.parent().map(|d| d.to_path_buf())))
            .unwrap_or_else(|| PathBuf::from("."));

        // Use PowerShell to get a local-time timestamp matching the format used
        // elsewhere in the app (auto-backup log filenames, etc.): YYYYMMDDHHMMSS.
        let timestamp = std::process::Command::new(crate::powershell_exe())
            .args(["-NoProfile", "-NonInteractive", "-Command",
                   "Get-Date -Format 'yyyyMMddHHmmss'"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_string())
            .filter(|s| s.len() == 14 && s.chars().all(|c| c.is_ascii_digit()))
            .unwrap_or_else(|| {
                // Fallback: UTC unix seconds if PowerShell is unavailable
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0)
                    .to_string()
            });
        base_dir.join(format!("resized-{timestamp}"))
    };

    if let Err(e) = std::fs::create_dir_all(&out_dir) {
        let _ = app.emit("resize-complete", ResizeCompleteEvent {
            success: false,
            message: format!("Cannot create output folder: {e}"),
            output_folder: out_dir.to_string_lossy().to_string(),
            count: 0,
        });
        return;
    }

    // Output filenames are <stem>.<out_ext>, which collapses distinct inputs
    // together: a.png and a.jpg would BOTH write a.jpg, the second silently
    // overwriting the first. Track every name issued this run (Windows paths
    // are case-insensitive, hence the lowercasing) and uniquify collisions
    // with a -2 / -3 / … counter suffix.
    let mut used_names: std::collections::HashSet<String> = std::collections::HashSet::new();

    // If an output goes into the SAME directory as one of the originals, its
    // name can collide with that original and overwrite it — actual data loss,
    // not just a lost output. Pre-seed the set with any source filename whose
    // parent directory is the output directory so those collisions take the
    // counter-suffix path instead. (Handles both "output = browsed folder" and
    // a picked file that happens to live in the output folder.)
    let norm = |p: &Path| -> String {
        p.to_string_lossy().replace('/', "\\").trim_end_matches('\\').to_lowercase()
    };
    let out_dir_norm = norm(&out_dir);
    for p in &image_paths {
        let in_out_dir = p.parent().map(|d| norm(d) == out_dir_norm).unwrap_or(false);
        if in_out_dir {
            if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                used_names.insert(name.to_lowercase());
            }
        }
    }
    // Guards concurrent name-claims once the worker pool starts below.
    let used_names = Mutex::new(used_names);

    // ── Worker pool size ─────────────────────────────────────────────────────
    // Resizing is CPU-bound (decode → resample → encode), so spreading it
    // across cores is the single biggest lever for a big batch. But not every
    // machine running this app is a workstation: leave one core free for the
    // OS/UI so the app doesn't itself become the reason things feel sluggish,
    // and cap the upper bound — each in-flight worker holds a full decoded
    // bitmap in memory, so unlimited parallelism on a many-core box just trades
    // CPU headroom for a RAM/disk-I/O bottleneck instead. A 1-2 core machine
    // falls back to a single worker, i.e. today's sequential behaviour.
    let worker_count = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .saturating_sub(1)
        .clamp(1, 8);

    let next_index = AtomicU32::new(0);   // work-claim cursor into image_paths
    let processed  = AtomicU32::new(0);   // attempted (saved or skipped) — drives the progress bar
    let saved      = AtomicU32::new(0);   // actually written — drives the final count
    let cancelled  = AtomicBool::new(false);
    let aborted: Mutex<Option<String>> = Mutex::new(None); // first fatal save error, if any

    // std::thread::scope lets each worker borrow the function's local state
    // (image_paths, used_names, the atomics, …) directly instead of needing
    // Arc everywhere — the scope guarantees every spawned thread has finished
    // before it returns, so those borrows stay valid for the whole call.
    std::thread::scope(|scope| {
        for _ in 0..worker_count {
            // Fresh, per-iteration bindings: an owned AppHandle clone (cheap —
            // it's Arc-backed internally) plus plain references to everything
            // else. References are Copy, so each loop iteration hands the
            // `move` closure its own copy without fighting over ownership.
            let app         = app.clone();
            let image_paths = &image_paths;
            let used_names  = &used_names;
            let next_index  = &next_index;
            let processed   = &processed;
            let saved       = &saved;
            let cancelled   = &cancelled;
            let aborted     = &aborted;
            let out_dir     = &out_dir;
            let gravity_str = gravity_str.as_str();

            scope.spawn(move || {
                loop {
                    // Stop claiming new work once cancelled or another worker
                    // hit a fatal save error; anything already in flight still
                    // finishes naturally rather than being torn down mid-write.
                    if RESIZE_CANCEL.load(Ordering::SeqCst) {
                        cancelled.store(true, Ordering::SeqCst);
                        return;
                    }
                    if aborted.lock().unwrap().is_some() {
                        return;
                    }

                    let idx = next_index.fetch_add(1, Ordering::SeqCst);
                    if idx >= total {
                        return;
                    }
                    let src_path = &image_paths[idx as usize];

                    let file_name = src_path.file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("?")
                        .to_string();

                    let img = match image::open(src_path) {
                        Ok(i)  => i,
                        Err(_) => {
                            let done = processed.fetch_add(1, Ordering::SeqCst) + 1;
                            let _ = app.emit("resize-progress", ResizeProgressEvent {
                                current_file: file_name,
                                done,
                                total,
                            });
                            continue;
                        }
                    };

                    // ── Step 1: resize to fit within target box ──────────────
                    let resized = match (target_w, target_h) {
                        (Some(tw), Some(th)) => {
                            let (w, h) = img.dimensions();
                            let scale = (tw as f32 / w as f32).min(th as f32 / h as f32);
                            let nw = ((w as f32 * scale).round() as u32).max(1);
                            let nh = ((h as f32 * scale).round() as u32).max(1);
                            img.resize_exact(nw, nh, image::imageops::FilterType::Lanczos3)
                        }
                        (Some(tw), None) => {
                            let (w, h) = img.dimensions();
                            let scale  = tw as f32 / w as f32;
                            let nh     = ((h as f32 * scale).round() as u32).max(1);
                            img.resize_exact(tw, nh, image::imageops::FilterType::Lanczos3)
                        }
                        (None, Some(th)) => {
                            let (w, h) = img.dimensions();
                            let scale  = th as f32 / h as f32;
                            let nw     = ((w as f32 * scale).round() as u32).max(1);
                            img.resize_exact(nw, th, image::imageops::FilterType::Lanczos3)
                        }
                        (None, None) => img,
                    };

                    // ── Step 2: place on canvas ───────────────────────────────
                    let final_img = match (canvas_w, canvas_h) {
                        (Some(cw), Some(ch)) => {
                            let (iw, ih) = resized.dimensions();
                            let mut canvas = image::RgbaImage::from_pixel(cw, ch, image::Rgba(bg_rgba));

                            let x_off: i64 = match gravity_str {
                                "northwest" | "west" | "southwest" => 0,
                                "northeast" | "east" | "southeast" => (cw as i64) - (iw as i64),
                                _                                   => ((cw as i64) - (iw as i64)) / 2,
                            };
                            let y_off: i64 = match gravity_str {
                                "northwest" | "north" | "northeast" => 0,
                                "southwest" | "south" | "southeast" => (ch as i64) - (ih as i64),
                                _                                   => ((ch as i64) - (ih as i64)) / 2,
                            };

                            let x_off = x_off.max(0);
                            let y_off = y_off.max(0);
                            image::imageops::overlay(&mut canvas, &resized.to_rgba8(), x_off, y_off);
                            DynamicImage::ImageRgba8(canvas)
                        }
                        _ => resized,
                    };

                    // ── Step 3: save. The name-collision check and the insert
                    // happen inside one lock so two workers can never issue the
                    // same output filename to two different source images. ────
                    let stem = src_path.file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("image");
                    let out_path = {
                        let mut names = used_names.lock().unwrap();
                        let mut out_name = format!("{stem}.{out_ext}");
                        let mut suffix = 2u32;
                        while names.contains(&out_name.to_lowercase()) {
                            out_name = format!("{stem}-{suffix}.{out_ext}");
                            suffix += 1;
                        }
                        names.insert(out_name.to_lowercase());
                        out_dir.join(&out_name)
                    };

                    if let Err(e) = final_img.save_with_format(&out_path, out_fmt) {
                        let mut err = aborted.lock().unwrap();
                        if err.is_none() {
                            *err = Some(format!("Failed to save {}: {e}", out_path.display()));
                        }
                        return;
                    }

                    saved.fetch_add(1, Ordering::SeqCst);
                    let done = processed.fetch_add(1, Ordering::SeqCst) + 1;
                    let _ = app.emit("resize-progress", ResizeProgressEvent {
                        current_file: file_name,
                        done,
                        total,
                    });
                }
            });
        }
    });

    let final_count = saved.load(Ordering::SeqCst);

    if cancelled.load(Ordering::SeqCst) {
        let _ = app.emit("resize-complete", ResizeCompleteEvent {
            success: false,
            message: "Cancelled by user.".to_string(),
            output_folder: out_dir.to_string_lossy().to_string(),
            count: final_count,
        });
        return;
    }

    if let Some(message) = aborted.into_inner().unwrap() {
        let _ = app.emit("resize-complete", ResizeCompleteEvent {
            success: false,
            message,
            output_folder: out_dir.to_string_lossy().to_string(),
            count: final_count,
        });
        return;
    }

    let _ = app.emit("resize-complete", ResizeCompleteEvent {
        success: true,
        message: String::new(),
        output_folder: out_dir.to_string_lossy().to_string(),
        count: final_count,
    });
}
