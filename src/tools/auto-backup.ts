/* =============================================================================
   AUTO-BACKUP  — Robocopy-based folder mirroring
   -----------------------------------------------------------------------------
   Frontend logic for the Auto-Backup tool. All filesystem operations and the
   Robocopy subprocess run in Rust; this file owns UI state, progress display,
   event wiring, and the Presets modal.

   Architecture notes:
     • Backup runs on a dedicated Rust thread so Tauri's IPC thread pool is
       never blocked. Progress arrives as Tauri events (backup-plan-progress,
       backup-plan-done, backup-folder-start, backup-file-progress,
       backup-folder-done, backup-complete). The overall bar is byte-weighted
       against a preflight plan and animated via requestAnimationFrame — see
       the SMOOTH PROGRESS BAR ENGINE section.
     • Listeners are attached once at init and remain alive for the session
       (unlisteners[] tracks them for cleanup if ever needed).
     • Source folder sizes are scanned lazily and cached in sizeCache/statsCache
       so the summary panel updates without re-rendering the whole list.

   Rust commands used:
     save_backup_config, load_backup_config,
     get_folder_stats, get_free_space, estimate_backup,
     cancel_backup, run_backup,
     save_backup_presets, load_backup_presets
============================================================================= */

import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { flash, devError, devWarn } from "../shell";
import { Modal } from "../modal";

/* =============================================================================
   TYPES
============================================================================= */

interface BackupConfig {
  sources: string[];
  destinations: string[];
  copySpeed: number; // bytes/sec
  /** True once the user checks "Never show this warning again" on the
   *  entry disclaimer — suppresses the disclaimer face on future entries. */
  skipDisclaimer: boolean;
  /** When true (default), show live per-file progress during a backup. This
   *  is slower because parsing robocopy's per-file output live can throttle
   *  robocopy on trees full of small files. When false, robocopy runs
   *  unmonitored and the bar/stats update per-folder instead — much faster. */
  showDetails: boolean;
}

interface BackupFolderStartEvent {
  source: string;
  destination: string;
  source_index: number;
  source_total: number;
  dest_index: number;
  dest_total: number;
}

interface BackupFolderDoneEvent {
  source: string;
  destination: string;
  files_copied: number;
  dirs_copied: number;
  bytes_copied: number;
  elapsed_secs: number;
  /** Which destination (by index) this folder pair belongs to — destinations
   *  now mirror concurrently, so folder-done events interleave across them. */
  dest_index: number;
  folders_done: number;
  folders_total: number;
}

/** One file that couldn't be copied (locked/access error, not a "no
 *  difference" skip — see run_destination's doc comment in Rust for why
 *  those two can't be confused here). */
interface SkippedFileEntry {
  source: string;
  destination: string;
}

interface BackupCompleteEvent {
  success: boolean;
  message: string;
  log_paths: string[];
  total_files: number;
  total_dirs: number;
  total_bytes: number;
  total_extras: number;
  total_secs: number;
  aborted_file: string | null;
  skipped_files: SkippedFileEntry[];
  skipped_log_paths: string[];
}

interface BackupFileProgressEvent {
  /** Bytes of COMPLETED files (excludes the file currently copying). RUN-WIDE
   *  — sums every destination's progress, since destinations now mirror
   *  concurrently rather than one after another. */
  bytes_done: number;
  files_done: number;
  dirs_done: number;
  current_file: string;
  /** Size of the file currently being copied. */
  current_file_bytes: number;
  file_pct: number | null;
  /** Which destination (by index) this file belongs to. */
  dest_index: number;
  /** This destination's OWN completed-bytes total (excludes the in-flight
   *  file) — the numerator for that destination's own progress bar. */
  dest_bytes_done: number;
}

interface BackupPlanProgressEvent {
  pair_index: number;
  pairs_total: number;
  source: string;
}

interface PlanPair {
  source: string;
  destination: string;
  bytes: number;
  files: number;
}

interface BackupPlanDoneEvent {
  bytes_to_copy: number;
  files_to_copy: number;
  extras_to_delete: number;
  /** Per-pair breakdown in run order — feeds the work-weighted bar. */
  per_pair: PlanPair[];
}

interface FolderStats {
  files: number;
  dirs: number;
  bytes: number;
}

interface EstimatePerDest {
  destination: string;
  bytes: number;
  files: number;
  dirs: number;
  extras: number;
}

interface BackupEstimate {
  bytes_to_copy: number;
  files_to_copy: number;
  dirs_to_copy: number;
  extras_to_delete: number;
  per_destination: EstimatePerDest[];
}

interface BackupPreset {
  id: string;
  name: string;
  sources: string[];
  destinations: string[];
}

/* =============================================================================
   CONSTANTS
============================================================================= */

const DEFAULT_COPY_SPEED = 30 * 1024 * 1024; // 30 MB/s

/* =============================================================================
   STATE
============================================================================= */

let config: BackupConfig = {
  sources: [],
  destinations: [],
  copySpeed: DEFAULT_COPY_SPEED,
  skipDisclaimer: false,
  showDetails: true, // on by default; users opt into fast mode
};

/** Cached folder sizes: path → bytes (or null = pending). */
const sizeCache  = new Map<string, number | null>();
const statsCache = new Map<string, { files: number; dirs: number } | null>();
const sizePending = new Set<string>();
let totalSourceBytes = 0;
let totalSourceFiles = 0;
let totalSourceDirs  = 0;
let backupRunning = false;
let unlisteners: UnlistenFn[] = [];
let elapsedInterval: ReturnType<typeof setInterval> | null = null;
let runStartTime: number | null = null;
let runTotalFiles = 0;
let runTotalDirs = 0;
let runTotalBytes = 0;
let hasRunOnce = false; // tracks whether a backup has run this session

/** Files the last run couldn't copy (locked/access error) — populated by
 *  backup-complete, read by the "View Skipped Files" modal. */
let lastSkippedFiles: SkippedFileEntry[] = [];

/* ── Smooth progress-bar state ─────────────────────────────────────────────
   The bar is driven by a requestAnimationFrame loop, not directly by events.
   Events update a TARGET; the loop eases the DISPLAYED value toward it every
   frame and interpolates through the in-flight file at the measured copy
   speed — that combination is what makes the bar glide instead of chunking,
   even though robocopy's piped output arrives in buffered bursts. */
/** Exact bytes this run will copy, from the preflight pass (the denominator). */
let planBytes = 0;
/** True once backup-plan-done arrives with a non-zero byte plan. */
let planKnown = false;
/** Bytes of completed files so far (numerator, from progress events). */
let doneBytes = 0;
/** Size of the file currently being copied, and when we learned about it. */
let inFlightBytes = 0;
let inFlightSince = 0;
/** Exponential moving average of measured copy throughput (bytes/sec). */
let measuredBps = 0;
let _lastProgAt = 0;
let _lastProgBytes = 0;
/** Folder-fraction fallback inputs (used when the plan is zero/unknown). */
let foldersDoneN = 0;
let foldersTotalN = 0;
/* ── Work-model state (copy + scan blended) ───────────────────────────────
   A backup's real duration is copying PLUS comparison-scanning, and on a
   mostly-up-to-date run the scanning dominates. The bar therefore measures
   WORK-SECONDS: each pair's weight = its copy seconds (plan bytes ÷ measured
   throughput) + its scan seconds (source file count ÷ a learned comparison
   rate). Completed pairs credit their full weight; the active pair credits
   copied bytes plus wall-clock scan time, capped just short of its weight so
   only the folder-done event can complete a pair's slice. */
let planPairs: PlanPair[] = [];
/** Index of the pair currently being processed (advanced by folder-start). */
let activePairIdx = -1;
let pairStartedAt = 0;      // performance.now() at folder-start
let pairStartBytes = 0;     // doneBytes snapshot at folder-start
/** Learned comparison rate (files/sec robocopy walks when not copying).
 *  Seeded conservatively (external drives with /COPYALL compare slowly);
 *  the FIRST real measurement is adopted outright, then an EMA refines. */
let scanFilesPerSec = 500;
let scanRateLearned = false;

/** Animation loop bookkeeping. */
let barRaf: number | null = null;
let barLastTick = 0;
let displayedPct = 0;
let barFinished = false; // completion event arrived — sprint to 100 and stop
/** Sum of authoritative per-folder byte totals (from folder-done events) —
 *  reconciles the last in-flight file of each folder, whose bytes complete
 *  after that folder's final progress emit. */
let folderBytesAccum = 0;

/* ── Live backup estimate (Summary panel's "Next Backup" stats) ───────────
   Whenever the source/destination sets change, a debounced robocopy /L scan
   (the same preflight the real run uses) computes the EXACT workload a
   backup would perform right now — files to copy, bytes to copy, stale items
   to delete. A fingerprint of the path sets makes repeat triggers free, and
   a sequence counter discards stale responses from superseded scans. */
let estimate: BackupEstimate | null = null;
let estimateScanning = false;
let estimateError: string | null = null;
let _estimateTimer: number | null = null;
let _estimateSeq = 0;
let _lastEstimateFp = "";
let _estimateForce = false;
/** True when the current estimate was started by the Run Estimate button —
 *  errors then flash a toast; automatic (config-change / post-backup)
 *  estimates surface errors only via the ⚠ cells to avoid toast spam. */
let _estimateManual = false;

/** Presets */
let presets: BackupPreset[] = [];
let activePresetId: string | null = null;

/* =============================================================================
   ELEMENT REFS
============================================================================= */

let sourceList: HTMLElement;
let addSourceBtn: HTMLButtonElement;
let browseSourceBtn: HTMLButtonElement;
let sourceInput: HTMLInputElement;

let destList: HTMLElement;
let addDestBtn: HTMLButtonElement;
let browseDestBtn: HTMLButtonElement;
let destInput: HTMLInputElement;

let totalSizeEl: HTMLElement;
let totalFilesEl: HTMLElement;
let totalDirsEl: HTMLElement;
let estSizeEl: HTMLElement;
let estFilesEl: HTMLElement;
let estDirsEl: HTMLElement;
let dirsInfoBtn: HTMLButtonElement;
let estimateBtn: HTMLButtonElement;
let estimateBtnLabel: HTMLElement;
let estimateSpinner: HTMLElement;
let runBtnLabel: HTMLElement;
let runSpinner: HTMLElement;
let estDeletesEl: HTMLElement;
let estimateStatusEl: HTMLElement;
let estTimeEl: HTMLElement;
let freeSpaceEl: HTMLElement;
let speedInput: HTMLInputElement;

let runBtn: HTMLButtonElement;
let cancelBtn: HTMLButtonElement;
let detailsToggle: HTMLInputElement;
let detailsLabel: HTMLElement;
let detailsToggleWrap: HTMLElement;

let progressPanel: HTMLElement;
let progressContent: HTMLElement;
let progressIdleEl: HTMLElement;
let progressCurrentLabel: HTMLElement;
let progressCurrentFileEl: HTMLElement;
let progressFilesEl: HTMLElement;
let progressDirsEl: HTMLElement;
let progressBytesEl: HTMLElement;
let progressElapsedEl: HTMLElement;
let progressSpeedEl: HTMLElement;
let progressEtaEl: HTMLElement;
let progressExtrasEl: HTMLElement;
let progressBarFill: HTMLElement;
let progressLogEl: HTMLElement;
let clearBtn: HTMLButtonElement;
let clearSourceBtn: HTMLButtonElement;
let clearDestBtn: HTMLButtonElement;
let presetsBtn: HTMLButtonElement;
let presetsModal: Modal; // initialised in initPresetsModal once the DOM element exists

/* Disclaimer face */
let faceDisclaimer: HTMLElement;
let faceTool: HTMLElement;
let disclaimerSkipCheck: HTMLInputElement;

/* Run-confirmation modal */
let runConfirmModal: Modal; // initialised in initRunConfirmModal
let confirmFilesEl: HTMLElement;
let confirmSizeEl: HTMLElement;
let confirmDrivesEl: HTMLElement;
let confirmSpaceWarningsEl: HTMLElement;

/* Skipped-files modal */
let skippedFilesModal: Modal; // initialised in initSkippedFilesModal
let skippedFilesBtn: HTMLButtonElement;
let skippedFilesCountEl: HTMLElement;
let skippedFilesListEl: HTMLElement;

/** Set once initAutoBackup completes. Entry-hook calls that arrive before
 *  then (the startup-restore path navigates before tools initialise) are
 *  deferred — init applies the disclaimer state itself when it finishes. */
let _abInitialized = false;

/* =============================================================================
   PERSISTENCE
============================================================================= */

async function saveConfig(): Promise<void> {
  try {
    await invoke("save_backup_config", { data: JSON.stringify(config) });
  } catch (e) {
    devError("Failed to save backup config:", e);
  }
  // Every config mutation flows through here, so this is the one hook needed
  // to keep the "Next Backup" estimate current. Path-neutral changes (copy
  // speed) are filtered out by the fingerprint check inside.
  //
  // If a scan is mid-flight, kill it NOW at the backend (its robocopy child
  // dies within a few hundred lines of output) rather than letting it finish
  // a walk whose answer describes paths that no longer exist. The debounced
  // refresh below then starts the fresh one.
  if (estimateScanning) {
    void invoke("cancel_estimate").catch(() => {});
  }
  queueEstimateRefresh();
}

async function loadConfig(): Promise<void> {
  try {
    const raw = await invoke<string>("load_backup_config");
    const parsed = JSON.parse(raw);
    // Coerce each field to its expected type rather than trusting the stored shape.
    const sources = Array.isArray(parsed?.sources)
      ? parsed.sources.filter((s: unknown) => typeof s === "string")
      : [];
    const destinations = Array.isArray(parsed?.destinations)
      ? parsed.destinations.filter((s: unknown) => typeof s === "string")
      : [];
    const copySpeed = typeof parsed?.copySpeed === "number" && parsed.copySpeed > 0
      ? parsed.copySpeed
      : DEFAULT_COPY_SPEED;
    config.sources        = sources;
    config.destinations   = destinations;
    config.copySpeed      = copySpeed;
    config.skipDisclaimer = parsed?.skipDisclaimer === true;
    // Default ON when the key is missing (older configs) or malformed — only
    // an explicit stored `false` turns details off.
    config.showDetails    = parsed?.showDetails !== false;
  } catch {
    // use defaults
  }
}

const PRESETS_LS_KEY = "ab-presets-fallback";

async function savePresets(): Promise<void> {
  // Write to localStorage first — zero-latency, zero-failure insurance so
  // presets survive reloads even in the unlikely event the Rust write fails.
  try {
    localStorage.setItem(PRESETS_LS_KEY, JSON.stringify(presets));
  } catch (e) {
    devError("localStorage write failed:", e);
  }
  // Also persist via Rust for proper AppData storage (registered in lib.rs).
  try {
    await invoke("save_backup_presets", { data: JSON.stringify(presets) });
  } catch (e) {
    devWarn("save_backup_presets invoke failed:", e);
  }
}

async function loadPresets(): Promise<void> {
  /** Validates and filters a raw parsed value into BackupPreset[]. */
  function sanitizePresets(raw: unknown): BackupPreset[] {
    if (!Array.isArray(raw)) return [];
    return raw.filter((p): p is BackupPreset =>
      p !== null &&
      typeof p === "object" &&
      typeof p.id   === "string" && p.id.length > 0 &&
      typeof p.name === "string" &&
      Array.isArray(p.sources) &&
      Array.isArray(p.destinations)
    ).map((p) => ({
      id:           p.id,
      name:         p.name,
      sources:      p.sources.filter((s: unknown) => typeof s === "string"),
      destinations: p.destinations.filter((s: unknown) => typeof s === "string"),
    }));
  }

  // Try Rust storage first (proper AppData location).
  try {
    const raw = await invoke<string>("load_backup_presets");
    const loaded = sanitizePresets(JSON.parse(raw));
    // If Rust returned real data, sync it to localStorage as well.
    if (loaded.length > 0) {
      presets = loaded;
      try { localStorage.setItem(PRESETS_LS_KEY, JSON.stringify(presets)); } catch {}
      return;
    }
  } catch {
    // Rust read failed — fall through to localStorage.
  }
  // Fall back to localStorage (e.g. first run before any Rust write has occurred).
  try {
    const raw = localStorage.getItem(PRESETS_LS_KEY);
    presets = raw ? sanitizePresets(JSON.parse(raw)) : [];
  } catch {
    presets = [];
  }
}

/* =============================================================================
   UTILITIES
============================================================================= */

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = bytes;
  let ui = 0;
  while (size >= 1024 && ui < units.length - 1) { size /= 1024; ui++; }
  return `${size.toFixed(2)} ${units[ui]}`;
}

function formatSeconds(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0 || h > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

/* =============================================================================
   SIZE SCANNING
   After a scan completes we update both the summary panel AND the specific
   size tag inside the list row, without re-rendering the whole list.
============================================================================= */

async function fetchAndCacheSize(path: string): Promise<void> {
  if (sizePending.has(path)) return;
  sizePending.add(path);
  sizeCache.set(path, null);
  statsCache.set(path, null);
  updateSizeTagForPath(path, null);
  refreshSummary();

  try {
    const stats = await invoke<FolderStats>("get_folder_stats", { path });
    sizeCache.set(path, stats.bytes);
    statsCache.set(path, { files: stats.files, dirs: stats.dirs });
    updateSizeTagForPath(path, stats.bytes);
  } catch {
    sizeCache.set(path, 0);
    statsCache.set(path, { files: 0, dirs: 0 });
    updateSizeTagForPath(path, 0);
  } finally {
    sizePending.delete(path);
    refreshSummary();
  }
}

/**
 * Updates the .ab-list-size span for a specific path in the source list
 * without tearing down and rebuilding the whole list. Each row stores
 * its path in a data attribute so we can find it cheaply.
 */
function updateSizeTagForPath(path: string, bytes: number | null): void {
  const rows = sourceList?.querySelectorAll<HTMLElement>(".ab-list-row[data-path]");
  if (!rows) return;
  for (const row of rows) {
    if (row.dataset.path === path) {
      const tag = row.querySelector<HTMLElement>(".ab-list-size");
      if (tag) tag.textContent = bytes === null ? "…" : formatBytes(bytes);
      break;
    }
  }
}

function refreshSummary(): void {
  let total = 0;
  let files = 0;
  let dirs  = 0;
  let anyPending = false;

  for (const src of config.sources) {
    const cached = sizeCache.get(src);
    if (cached === null || cached === undefined) {
      anyPending = true;
    } else {
      total += cached;
      const sc = statsCache.get(src);
      if (sc) { files += sc.files; dirs += sc.dirs; }
    }
  }

  totalSourceBytes = total;
  totalSourceFiles = files;
  totalSourceDirs  = dirs;

  if (config.sources.length === 0) {
    totalSizeEl.textContent  = "—";
    totalFilesEl.textContent = "—";
    totalDirsEl.textContent  = "—";
  } else if (anyPending) {
    totalSizeEl.textContent  = `${formatBytes(total)} (scanning…)`;
    totalFilesEl.textContent = files > 0 ? files.toLocaleString() : "…";
    totalDirsEl.textContent  = dirs  > 0 ? dirs.toLocaleString()  : "…";
  } else {
    totalSizeEl.textContent  = formatBytes(total);
    totalFilesEl.textContent = files.toLocaleString();
    totalDirsEl.textContent  = dirs.toLocaleString();
  }
  // The "Next Backup" cells are owned by the estimate engine — one renderer,
  // one source of truth, regardless of which code path repainted the summary.
  renderEstimateCells();
}

/**
 * Sets an element's content to one <div> per line.
 * A single entry renders as plain text with no wrapper overhead.
 */
function setMultilineContent(el: HTMLElement, lines: string[]): void {
  el.innerHTML = "";
  for (const line of lines) {
    const div = document.createElement("div");
    div.textContent = line;
    el.appendChild(div);
  }
}

/* =============================================================================
   LIVE BACKUP ESTIMATE  ("Next Backup — If Run Now")
============================================================================= */

/** Identity of the path sets — if this hasn't changed, neither has the scan's
 *  input, so a re-trigger (e.g. a copy-speed save) costs nothing. */
function estimateFingerprint(): string {
  return JSON.stringify([config.sources, config.destinations]);
}

/**
 * Schedules a (debounced) estimate rescan. `force` bypasses the fingerprint
 * check — used after a backup completes, when the paths are unchanged but
 * the DISK state isn't.
 */
function queueEstimateRefresh(force = false): void {
  if (force) _estimateForce = true;
  if (_estimateTimer !== null) clearTimeout(_estimateTimer);
  _estimateTimer = window.setTimeout(() => {
    _estimateTimer = null;
    void runEstimate();
  }, 600);
}

/** Syncs the Run Estimate button's spinner/label/disabled state. */
function syncEstimateButton(): void {
  estimateSpinner.style.display = estimateScanning ? "" : "none";
  estimateBtnLabel.textContent = estimateScanning ? "Estimating…" : "Run Estimate";
  estimateBtn.disabled = estimateScanning || backupRunning;
}

/** Reflects the CURRENT mode on the toggle: the switch position (checked =
 *  details on) and the text beside it. Disabled mid-run, since the mode is
 *  captured at launch and can't change once a backup is in flight.
 *  ON = live details, slower; OFF = fast. */
function renderDetailsToggle(): void {
  detailsToggle.checked  = config.showDetails;
  detailsToggle.disabled = backupRunning;
  detailsToggleWrap.classList.toggle("ab-details-locked", backupRunning);
  detailsLabel.textContent = config.showDetails
    ? "Show Progress Details (slow)"
    : "Hide Progress Details (fast)";
}

async function runEstimate(): Promise<void> {
  const fp = estimateFingerprint();
  if (!_estimateForce && fp === _lastEstimateFp) return;
  // Never scan mid-backup: the disk is contended and the answer would
  // describe a moving target. The backup-complete handler re-queues.
  if (backupRunning) return;

  if (config.sources.length === 0 || config.destinations.length === 0) {
    estimate = null;
    estimateError = null;
    estimateScanning = false;
    _lastEstimateFp = fp;
    _estimateForce = false;
    renderEstimateCells();
    return;
  }

  const seq = ++_estimateSeq;
  estimateScanning = true;
  syncEstimateButton();
  renderEstimateCells();

  // Re-check free space too — a drive that was "unavailable" (not plugged in
  // when the app opened) may be connected now. Fire-and-forget: this just
  // refreshes a display value and shouldn't hold up the estimate itself.
  void refreshFreeSpace();

  let superseded = false;
  try {
    const result = await invoke<BackupEstimate>("estimate_backup", {
      sources: config.sources,
      destinations: config.destinations,
    });
    if (seq !== _estimateSeq) return; // superseded by a newer scan
    estimate = result;
    estimateError = null;
  } catch (e) {
    if (seq !== _estimateSeq) return;
    if (String(e).includes("__ESTIMATE_SUPERSEDED__")) {
      // The backend killed this scan because a newer one (or a config
      // change, or a backup launch) replaced it. Routine, not an error —
      // stay silent and leave the scanning state for the successor, whose
      // own run is already queued.
      superseded = true;
      return;
    }
    // Includes unsafe-path validation errors — surfacing them here means a
    // bad configuration is visible in the Summary the moment the scan runs,
    // not first discovered on Run.
    estimate = null;
    estimateError = String(e);
    if (_estimateManual) {
      flash(String(e), "error", 8000);
    }
  } finally {
    if (seq === _estimateSeq && !superseded) {
      estimateScanning = false;
      _lastEstimateFp = fp;
      _estimateForce = false;
      _estimateManual = false;
      syncEstimateButton();
      renderEstimateCells();
    }
  }
}

/** Renders every "Next Backup" cell from the current estimate state. */
function renderEstimateCells(): void {
  const noConfig = config.sources.length === 0 || config.destinations.length === 0;

  // Subtitle status chip
  estimateStatusEl.textContent = estimateScanning ? "scanning…" : "";

  // Error tooltip lives on the cells so a bad config explains itself on hover
  const tooltip = estimateError ?? "";
  estFilesEl.title = tooltip;
  estDirsEl.title = tooltip;
  estDeletesEl.title = tooltip;
  estSizeEl.title = tooltip;

  if (noConfig || (!estimate && !estimateScanning)) {
    const filler = estimateError ? "⚠" : "—";
    dirsInfoBtn.style.display = "none";
    estFilesEl.textContent = filler;
    estDirsEl.textContent = filler;
    estDeletesEl.textContent = filler;
    setMultilineContent(estSizeEl, [filler]);
    estTimeEl.textContent = "—";
    return;
  }

  if (estimateScanning && !estimate) {
    dirsInfoBtn.style.display = "none";
    estFilesEl.textContent = "…";
    estDirsEl.textContent = "…";
    estDeletesEl.textContent = "…";
    setMultilineContent(estSizeEl, ["…"]);
    estTimeEl.textContent = "…";
    return;
  }

  // From here on estimate is non-null (a stale one may show briefly while a
  // rescan runs — the "scanning…" chip signals that).
  const est = estimate!;
  estFilesEl.textContent = est.files_to_copy.toLocaleString();
  estDeletesEl.textContent = est.extras_to_delete.toLocaleString();

  // Dirs to Copy can legitimately exceed Total Source Dirs: robocopy also
  // creates each source folder's ROOT at <destination>\<name> — one extra
  // dir per source×destination pair — and Total Source Dirs (correctly)
  // describes only what's INSIDE the sources. When that happens, reveal the
  // ℹ button beside the value (it opens an explanatory modal — same pattern
  // as Copy Speed's), rather than inflating the source stats to hide it.
  estDirsEl.textContent = est.dirs_to_copy.toLocaleString();
  dirsInfoBtn.style.display = est.dirs_to_copy > totalSourceDirs ? "" : "none";

  // Data to Copy: exact bytes, one line per destination drive.
  const driveBytes = new Map<string, number>();
  for (const per of est.per_destination) {
    const first = per.destination.trim().charAt(0);
    const label = /[a-z]/i.test(first) ? `${first.toUpperCase()}:` : per.destination;
    driveBytes.set(label, (driveBytes.get(label) ?? 0) + per.bytes);
  }
  const lines: string[] = [];
  for (const [label, bytes] of driveBytes) {
    lines.push(driveBytes.size > 1 || config.destinations.length > 1
      ? `${label} ${formatBytes(bytes)}`
      : formatBytes(bytes));
  }
  if (lines.length === 0) lines.push("—");
  setMultilineContent(estSizeEl, lines);

  // Estimated Time: exact workload over the configured copy speed.
  estTimeEl.textContent = est.bytes_to_copy > 0
    ? formatSeconds(est.bytes_to_copy / config.copySpeed)
    : "—";
}

/** Back-compat shims — many call sites refresh these cells individually; both
 *  now render from the single estimate state. */
function refreshEstTime(): void {
  renderEstimateCells();
}

function refreshEstSize(): void {
  renderEstimateCells();
}

/** Per-drive-letter free space in bytes, from the last successful check —
 *  read by the confirmation modal to warn about destinations that don't have
 *  room for what's about to be copied. A letter with no entry here means the
 *  last check failed (unplugged drive, etc.) — treated as "unknown", not
 *  "definitely enough room", so no warning fires for it either way. */
const freeSpaceByLetter = new Map<string, number>();

/**
 * Queries free space for all destinations, but only once per unique drive letter.
 * Renders one line per drive.
 */
async function refreshFreeSpace(): Promise<void> {
  if (config.destinations.length === 0) {
    setMultilineContent(freeSpaceEl, ["—"]);
    return;
  }
  setMultilineContent(freeSpaceEl, ["…"]);

  // Build a map of driveLetter → one representative path, preserving insertion order.
  const driveMap = new Map<string, string>();
  for (const dest of config.destinations) {
    const letter = dest.replace(/\\/g, "/").charAt(0).toUpperCase();
    if (!driveMap.has(letter)) driveMap.set(letter, dest);
  }

  const lines: string[] = [];
  for (const [letter, path] of driveMap) {
    try {
      const bytes = await invoke<number>("get_free_space", { path });
      freeSpaceByLetter.set(letter, bytes);
      lines.push(`${letter}: ${formatBytes(bytes)} free`);
    } catch (e) {
      devError(`get_free_space failed for ${path}:`, e);
      freeSpaceByLetter.delete(letter);
      lines.push(`${letter}: unavailable`);
    }
  }
  setMultilineContent(freeSpaceEl, lines);
}

/* =============================================================================
   BROWSE HELPER
============================================================================= */

async function pickFolder(): Promise<string | null> {
  const selected = await open({ directory: true, multiple: false });
  if (!selected || Array.isArray(selected)) return null;
  return selected;
}

/* =============================================================================
   LIST RENDERERS
============================================================================= */

function renderSourceList(): void {
  sourceList.innerHTML = "";

  if (config.sources.length === 0) {
    const empty = document.createElement("div");
    empty.className   = "ab-list-empty";
    empty.textContent = "No source folders added.";
    sourceList.appendChild(empty);
    return;
  }

  config.sources.forEach((src, i) => {
    const row = document.createElement("div");
    row.className    = "ab-list-row";
    row.dataset.path = src;            // ← used by updateSizeTagForPath
    row.title        = "Double-click path to edit";

    const label = document.createElement("span");
    label.className   = "ab-list-path";
    label.textContent = src;
    label.title       = "Double-click to edit";
    label.addEventListener("dblclick", () => makePathEditable(label, "sources", i));
    row.appendChild(label);

    const sizeTag = document.createElement("span");
    sizeTag.className = "ab-list-size";
    const cached = sizeCache.get(src);
    sizeTag.textContent = (cached === null || cached === undefined) ? "…" : formatBytes(cached);
    row.appendChild(sizeTag);

    // Browse/replace (…)
    const browseBtn = document.createElement("button");
    browseBtn.className   = "ab-list-browse modal-cancel-btn";
    browseBtn.title       = "Browse to replace this path";
    browseBtn.textContent = "…";
    browseBtn.addEventListener("click", async () => {
      if (backupRunning) return;
      const picked = await pickFolder();
      if (!picked) return;
      if (config.sources.some((p, j) => j !== i && p === picked)) {
        flash("Source folder already in list.", "error");
        return;
      }
      const old = config.sources[i];
      sizeCache.delete(old);
      config.sources[i] = picked;
      renderSourceList();
      saveConfig();
      fetchAndCacheSize(picked);
      flash("Source folder updated.", "success");
    });
    row.appendChild(browseBtn);

    // Remove (×)
    const removeBtn = document.createElement("button");
    removeBtn.className = "ab-list-remove danger-btn";
    removeBtn.title     = "Remove";
    removeBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
    removeBtn.addEventListener("click", () => {
      if (backupRunning) return;
      sizeCache.delete(src);
      config.sources.splice(i, 1);
      renderSourceList();
      refreshSummary();
      refreshEstTime();
      saveConfig();
      flash("Source folder removed.", "success");
    });
    row.appendChild(removeBtn);

    sourceList.appendChild(row);
  });
}

function renderDestList(): void {
  destList.innerHTML = "";

  if (config.destinations.length === 0) {
    const empty = document.createElement("div");
    empty.className   = "ab-list-empty";
    empty.textContent = "No destination folders added.";
    destList.appendChild(empty);
    return;
  }

  config.destinations.forEach((dest, i) => {
    const row = document.createElement("div");
    row.className = "ab-list-row";

    const label = document.createElement("span");
    label.className   = "ab-list-path";
    label.textContent = dest;
    label.title       = "Double-click to edit";
    label.addEventListener("dblclick", () => makePathEditable(label, "destinations", i));
    row.appendChild(label);

    // Browse/replace (…)
    const browseBtn = document.createElement("button");
    browseBtn.className   = "ab-list-browse modal-cancel-btn";
    browseBtn.title       = "Browse to replace this path";
    browseBtn.textContent = "…";
    browseBtn.addEventListener("click", async () => {
      if (backupRunning) return;
      const picked = await pickFolder();
      if (!picked) return;
      if (config.destinations.some((p, j) => j !== i && p === picked)) {
        flash("Destination already in list.", "error");
        return;
      }
      config.destinations[i] = picked;
      renderDestList();
      refreshEstTime();
      refreshEstSize();
      refreshFreeSpace();
      saveConfig();
      flash("Destination updated.", "success");
    });
    row.appendChild(browseBtn);

    // Remove (×)
    const removeBtn = document.createElement("button");
    removeBtn.className = "ab-list-remove danger-btn";
    removeBtn.title     = "Remove";
    removeBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
    removeBtn.addEventListener("click", () => {
      if (backupRunning) return;
      config.destinations.splice(i, 1);
      renderDestList();
      refreshEstTime();
      refreshEstSize();
      refreshFreeSpace();
      saveConfig();
      flash("Destination removed.", "success");
    });
    row.appendChild(removeBtn);

    destList.appendChild(row);
  });
}

/* =============================================================================
   INLINE PATH EDITING
============================================================================= */

function makePathEditable(
  span: HTMLElement,
  listKey: "sources" | "destinations",
  index: number,
): void {
  if (backupRunning) return; // locked during backup
  const original = config[listKey][index];

  const input = document.createElement("input");
  input.className = "ab-edit-input";
  input.value     = original;
  input.style.width = Math.max(span.offsetWidth, 200) + "px";
  span.replaceWith(input);
  input.focus();
  input.select();

  let handledByKeydown = false;

  function commit(): void {
    const raw = input.value.trim();
    if (!raw || raw === original) { cancel(); return; }

    const isDupe = config[listKey].some((p, i) => i !== index && p.toLowerCase() === raw.toLowerCase());
    if (isDupe) {
      flash("That path is already in the list.", "error");
      cancel();
      return;
    }

    if (listKey === "sources") {
      sizeCache.delete(original);
      config.sources[index] = raw;
      renderSourceList();
      saveConfig();
      fetchAndCacheSize(raw);
      flash("Source folder updated.", "success");
    } else {
      config.destinations[index] = raw;
      renderDestList();
      refreshEstTime();
      refreshEstSize();
      refreshFreeSpace();
      saveConfig();
      flash("Destination updated.", "success");
    }
  }

  function cancel(): void {
    if (listKey === "sources") renderSourceList();
    else renderDestList();
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      handledByKeydown = true;
      commit();
    } else if (e.key === "Escape") {
      handledByKeydown = true;
      cancel();
    }
  });

  input.addEventListener("blur", () => {
    if (handledByKeydown) return;
    commit();
  });
}

/* =============================================================================
   ADD PATHS
============================================================================= */

function addSource(raw: string): void {
  const path = raw.trim();
  if (!path) { flash("Enter a folder path first.", "error"); return; }
  if (config.sources.includes(path)) {
    flash("Source folder already in list.", "error");
    return;
  }
  config.sources.push(path);
  sourceInput.value = "";
  renderSourceList();
  saveConfig();
  fetchAndCacheSize(path);
  flash("Source folder added.", "success");
}

function addDest(raw: string): void {
  const path = raw.trim();
  if (!path) { flash("Enter a folder path first.", "error"); return; }
  if (config.destinations.includes(path)) {
    flash("Destination already in list.", "error");
    return;
  }
  config.destinations.push(path);
  destInput.value = "";
  renderDestList();
  refreshEstTime();
  refreshEstSize();
  refreshFreeSpace();
  saveConfig();
  flash("Destination added.", "success");
}

/* =============================================================================
   PROGRESS UI
============================================================================= */

function showProgressContent(visible: boolean): void {
  progressContent.style.display = visible ? "flex" : "none";
  progressIdleEl.style.display  = visible ? "none"  : "";
}

function resetProgress(): void {
  progressCurrentLabel.textContent    = "Ready";
  progressCurrentFileEl.textContent   = "";
  progressFilesEl.textContent         = "0";
  progressDirsEl.textContent       = "0";
  progressBytesEl.textContent      = "0 B";
  progressElapsedEl.textContent    = "0s";
  progressSpeedEl.textContent      = "—";
  progressExtrasEl.textContent     = "0";
  progressEtaEl.textContent        = "—";
  progressLogEl.textContent        = "";
  progressLogEl.title              = "";
  progressBarFill.style.width      = "0%";
  progressBarFill.classList.remove("ab-bar-indeterminate");
  runTotalFiles = 0;
  runTotalDirs  = 0;
  runTotalBytes = 0;
  runStartTime  = null;
  lastSkippedFiles = [];
  syncSkippedFilesButton();
}

function startElapsedTimer(): void {
  runStartTime = Date.now();
  elapsedInterval = setInterval(() => {
    if (runStartTime === null) return;
    const elapsed = (Date.now() - runStartTime) / 1000;
    progressElapsedEl.textContent = formatSeconds(elapsed);

    // ETA. With a preflight plan the remaining work is EXACT (plan minus
    // completed bytes) and the rate is the measured throughput — far better
    // than the old source-size guess, which overestimated incremental runs
    // by however much hadn't changed. Pre-plan (or zero-copy runs): "…".
    const workRemaining = workRemainingSeconds(performance.now());
    if (workRemaining !== null) {
      // Work-model ETA: copy time AND comparison-scan time both counted, so a
      // mostly-up-to-date run over huge trees shows its real (scan-dominated)
      // remaining time instead of finishing the byte math early.
      progressEtaEl.textContent = workRemaining > 1 ? formatSeconds(workRemaining) : "—";
    } else if (planKnown && planBytes > 0) {
      const remaining = Math.max(0, planBytes - doneBytes);
      const etaSecs   = remaining / effectiveBps();
      progressEtaEl.textContent = remaining > 0 ? formatSeconds(etaSecs) : "—";
    } else {
      progressEtaEl.textContent = "…";
    }

    // Live measured copy speed (EMA over actual file completions — pure copy
    // throughput, uncontaminated by preflight/scan time). "—" until the first
    // real bytes land.
    progressSpeedEl.textContent = measuredBps > 0
      ? `${formatBytes(measuredBps)}/s`
      : "—";
  }, 500);
}

function stopElapsedTimer(): void {
  if (elapsedInterval !== null) {
    clearInterval(elapsedInterval);
    elapsedInterval = null;
  }
}

/**
 * Toggles the full UI lockdown state for a running backup.
 * When running=true:
 *   • Disables all source/dest inputs, add/browse/clear buttons, presets,
 *     the run button, and the per-row remove/browse buttons (via CSS class).
 *   • Suppresses tooltip text on all interactive elements in both lists so
 *     hover hints don't appear while controls are inert.
 * When running=false, all of the above is reversed.
 */
function setBackupRunning(running: boolean): void {
  backupRunning = running;
  runBtn.disabled          = running;
  cancelBtn.disabled       = !running;
  runSpinner.style.display = running ? "" : "none";
  runBtnLabel.textContent  = running ? "Backing up…" : "Run Backup";
  // Estimates can't run during a backup (the backend refuses; the disk is
  // busy) — reflect that on the button rather than letting clicks no-op.
  estimateBtn.disabled     = running;
  // Lock all interactive source/dest controls
  addSourceBtn.disabled    = running;
  browseSourceBtn.disabled = running;
  addDestBtn.disabled      = running;
  browseDestBtn.disabled   = running;
  sourceInput.disabled     = running;
  destInput.disabled       = running;
  speedInput.disabled      = running;
  // Lock presets and clear buttons
  presetsBtn.disabled      = running;
  clearBtn.disabled        = running;
  clearSourceBtn.disabled  = running;
  clearDestBtn.disabled    = running;
  // Mode can't change mid-run (it's captured at launch). renderDetailsToggle
  // handles both the input's disabled state and the wrapper's locked styling.
  renderDetailsToggle();
  // Lock all per-row remove and browse buttons by toggling a CSS class on the lists.
  // The class `ab-list-locked` sets pointer-events:none on child buttons.
  sourceList.classList.toggle("ab-list-locked", running);
  destList.classList.toggle("ab-list-locked", running);

  // Suppress / restore tooltip text on the add/browse input-row buttons so
  // they don't show hover hints while locked.
  const inputRowBtns: Array<{ el: HTMLElement; title: string }> = [
    { el: browseSourceBtn, title: "Browse for folder" },
    { el: addSourceBtn,    title: "Add source folder" },
    { el: clearSourceBtn,  title: "Clear all source folders" },
    { el: browseDestBtn,   title: "Browse for folder" },
    { el: addDestBtn,      title: "Add destination folder" },
    { el: clearDestBtn,    title: "Clear all destination folders" },
  ];
  for (const { el, title } of inputRowBtns) {
    el.title = running ? "" : title;
  }

  // Suppress / restore tooltip and dblclick hint text on all path-label spans
  // and browse/remove buttons inside the locked lists. Also clear the title on
  // the row itself — otherwise it bleeds through when hovering child buttons
  // (since the row's title is inherited by pointer events on children).
  const suppressInList = (list: HTMLElement) => {
    list.querySelectorAll<HTMLElement>(".ab-list-row").forEach(el => {
      el.title = running ? "" : "Double-click path to edit";
    });
    list.querySelectorAll<HTMLElement>(".ab-list-path").forEach(el => {
      el.title = running ? "" : "Double-click to edit";
    });
    list.querySelectorAll<HTMLElement>(".ab-list-browse").forEach(el => {
      el.title = running ? "" : "Browse to replace this path";
    });
    list.querySelectorAll<HTMLElement>(".ab-list-remove").forEach(el => {
      el.title = running ? "" : "Remove";
    });
  };
  suppressInList(sourceList);
  suppressInList(destList);
}

/* =============================================================================
   TAURI EVENT LISTENERS
============================================================================= */

/* =============================================================================
   SMOOTH PROGRESS BAR ENGINE
============================================================================= */

/** Effective throughput estimate: measured when available, else the user's
 *  configured copy speed (which also feeds the Est. Time summary cell). */
function effectiveBps(): number {
  return measuredBps > 0 ? measuredBps : config.copySpeed;
}

/** Source file count for a pair's scan weight. Prefers the folder-stats
 *  cache; falls back to the pair's plan files (a hard floor — you can't copy
 *  more files than you compare). */
function pairSourceFiles(pair: PlanPair): number {
  const stats = statsCache.get(pair.source);
  return Math.max(stats?.files ?? 0, pair.files, 1);
}

/** A pair's total work in seconds: copy time + comparison-scan time. */
function pairWorkSeconds(pair: PlanPair): number {
  const copySecs = pair.bytes / effectiveBps();
  const scanSecs = pairSourceFiles(pair) / scanFilesPerSec;
  return copySecs + scanSecs;
}

/** The bar's current true target, 0–100. */
function barTarget(now: number): number {
  if (barFinished) return 100;

  let pct: number;
  if (planPairs.length > 0) {
    // Work-weighted model: copying and scanning both count. Weights are
    // recomputed with the LIVE rates each tick, so the whole model sharpens
    // as the run teaches us the real throughput and scan speed. (Weight
    // shifts can nudge the target down; the monotonic clamp in barTick
    // holds the bar rather than letting it retreat.)
    const totalWork = planPairs.reduce((sum, p) => sum + pairWorkSeconds(p), 0);

    let doneWork = 0;
    for (let i = 0; i < planPairs.length; i++) {
      if (i < activePairIdx) {
        doneWork += pairWorkSeconds(planPairs[i]); // completed pairs: full credit
      } else if (i === activePairIdx) {
        const pair = planPairs[i];
        const work = pairWorkSeconds(pair);
        // Copy progress by bytes (exact), including the in-flight file.
        const inFlight = inFlightBytes > 0
          ? Math.min(inFlightBytes, ((now - inFlightSince) / 1000) * effectiveBps())
          : 0;
        const copyCredit = (Math.max(0, doneBytes - pairStartBytes) + inFlight) / effectiveBps();
        // Scan progress by wall time NOT attributable to copying, capped by
        // the pair's scan budget.
        const scanBudget = pairSourceFiles(pair) / scanFilesPerSec;
        const elapsed = (now - pairStartedAt) / 1000;
        const scanCredit = Math.min(scanBudget, Math.max(0, elapsed - copyCredit));
        // Only folder-done may complete a pair's slice.
        doneWork += Math.min(work * 0.98, copyCredit + scanCredit);
      }
    }
    pct = totalWork > 0 ? (doneWork / totalWork) * 100 : 0;
  } else if (planKnown && planBytes > 0) {
    // Fallback (no per-pair data): pure byte-weighted progress.
    const inFlight = inFlightBytes > 0
      ? Math.min(inFlightBytes, ((now - inFlightSince) / 1000) * effectiveBps())
      : 0;
    pct = ((doneBytes + inFlight) / planBytes) * 100;
  } else {
    // Last resort: equal-weight folder completion.
    pct = foldersTotalN > 0 ? (foldersDoneN / foldersTotalN) * 100 : 0;
  }

  // Never let estimation complete the bar — 100% is reserved for the
  // completion event. (Windows holds just short of full for the same reason.)
  return Math.min(pct, 99);
}

/** Remaining run time in seconds under the work model, or null pre-plan. */
function workRemainingSeconds(now: number): number | null {
  if (planPairs.length === 0) return null;
  const totalWork = planPairs.reduce((sum, p) => sum + pairWorkSeconds(p), 0);
  // Reuse barTarget's accounting via its percentage (cheap and consistent):
  const donePct = Math.min(99, barTarget(now)) / 100;
  return Math.max(0, totalWork * (1 - donePct));
}

/** One animation frame: ease displayed toward target, frame-rate independent. */
function barTick(now: number): void {
  barRaf = null;
  const dt = barLastTick > 0 ? now - barLastTick : 16.7;
  barLastTick = now;

  const target = barTarget(now);

  // Exponential approach with a per-16.7ms base rate — the same easing at any
  // refresh rate. Finishing sprints harder so 100% lands promptly.
  const base = barFinished ? 0.28 : 0.10;
  const k = 1 - Math.pow(1 - base, dt / 16.7);
  // Monotonic: if the target momentarily dips below the displayed value
  // (e.g. the in-flight interpolation ran slightly ahead of a folder
  // boundary reconciliation), the bar HOLDS rather than retreating —
  // progress bars that move backward read as broken.
  if (target > displayedPct) {
    displayedPct += (target - displayedPct) * k;
    // Snap when the remaining distance is subpixel.
    if (target - displayedPct < 0.05) displayedPct = target;
  }

  progressBarFill.style.width = `${displayedPct.toFixed(2)}%`;

  // Stop condition: the run is over and the bar has landed.
  if (barFinished && displayedPct >= 99.95) {
    progressBarFill.style.width = "100%";
    return;
  }
  barRaf = requestAnimationFrame(barTick);
}

/** Resets all bar state and starts the animation loop for a new run. */
function startBarEngine(): void {
  stopBarEngine();
  planBytes = 0;
  planKnown = false;
  doneBytes = 0;
  inFlightBytes = 0;
  inFlightSince = 0;
  measuredBps = 0;
  _lastProgAt = 0;
  _lastProgBytes = 0;
  foldersDoneN = 0;
  foldersTotalN = 0;
  displayedPct = 0;
  barLastTick = 0;
  barFinished = false;
  folderBytesAccum = 0;
  planPairs = [];
  activePairIdx = -1;
  pairStartedAt = 0;
  pairStartBytes = 0;
  // scanFilesPerSec deliberately NOT reset — it's learned knowledge about
  // this machine, and it carries usefully from run to run within a session.
  progressBarFill.style.width = "0%";
  barRaf = requestAnimationFrame(barTick);
}

/** Halts the animation loop where it stands (failure/cancel path). */
function stopBarEngine(): void {
  if (barRaf !== null) {
    cancelAnimationFrame(barRaf);
    barRaf = null;
  }
}

/** Feeds a progress event into the throughput EMA. Bursty piped output makes
 *  instantaneous rates noisy — the EMA (and a minimum sample window) keeps the
 *  in-flight interpolation from twitching. */
function updateThroughput(bytesDoneNow: number): void {
  const now = performance.now();
  if (_lastProgAt > 0 && bytesDoneNow > _lastProgBytes) {
    const dtSec = (now - _lastProgAt) / 1000;
    if (dtSec >= 0.05) {
      const inst = (bytesDoneNow - _lastProgBytes) / dtSec;
      measuredBps = measuredBps === 0 ? inst : measuredBps * 0.7 + inst * 0.3;
      _lastProgAt = now;
      _lastProgBytes = bytesDoneNow;
    }
  } else if (_lastProgAt === 0) {
    _lastProgAt = now;
    _lastProgBytes = bytesDoneNow;
  }
}

async function attachBackupListeners(): Promise<void> {
  const unlistenPlanProgress = await listen<BackupPlanProgressEvent>(
    "backup-plan-progress",
    ({ payload }) => {
      // Preflight phase — mirror Windows' "Calculating…" stage.
      progressBarFill.classList.add("ab-bar-indeterminate");
      progressCurrentLabel.textContent =
        `Calculating backup size… (${payload.pair_index + 1}/${payload.pairs_total})`;
      progressCurrentFileEl.textContent = `Scanning ${payload.source}`;
    }
  );

  const unlistenPlanDone = await listen<BackupPlanDoneEvent>(
    "backup-plan-done",
    ({ payload }) => {
      progressBarFill.classList.remove("ab-bar-indeterminate");
      planBytes = payload.bytes_to_copy;
      planKnown = payload.bytes_to_copy > 0;
      planPairs = payload.per_pair ?? [];
      const deletions = payload.extras_to_delete > 0
        ? `, ${payload.extras_to_delete.toLocaleString()} stale item${payload.extras_to_delete === 1 ? "" : "s"} to remove`
        : "";
      progressCurrentFileEl.textContent = payload.files_to_copy > 0
        ? `${payload.files_to_copy.toLocaleString()} file${payload.files_to_copy === 1 ? "" : "s"} to copy (${formatBytes(payload.bytes_to_copy)})${deletions}`
        : `Everything up to date${deletions} — verifying…`;
    }
  );

  const unlisten1 = await listen<BackupFolderStartEvent>(
    "backup-folder-start",
    ({ payload }) => {
      const { source, destination, source_index, source_total, dest_index, dest_total } = payload;
      // Destinations run one at a time, so a single label describing the
      // current folder is accurate — nothing else is copying to fight over it.
      progressCurrentLabel.textContent =
        `[Dest ${dest_index + 1}/${dest_total}] ` +
        `[Folder ${source_index + 1}/${source_total}] ` +
        `${source} → ${destination}`;
      // Show scanning state until the first file-progress event arrives.
      progressCurrentFileEl.textContent = "Scanning files…";

      // Advance the work model's active pair. Pairs arrive in order (one
      // destination fully finishes before the next starts), so an ordinal
      // counter stays aligned.
      activePairIdx += 1;
      pairStartedAt = performance.now();
      pairStartBytes = doneBytes;
    }
  );

  const unlistenProgress = await listen<BackupFileProgressEvent>(
    "backup-file-progress",
    ({ payload }) => {
      runTotalBytes = payload.bytes_done;
      runTotalFiles = payload.files_done;
      runTotalDirs  = payload.dirs_done;
      progressBytesEl.textContent = formatBytes(runTotalBytes);
      progressFilesEl.textContent = runTotalFiles.toLocaleString();
      progressDirsEl.textContent  = runTotalDirs.toLocaleString();
      // Empty current_file = fast mode's per-folder synthetic event, which
      // carries no filename; leave the (hidden) line alone in that case.
      if (payload.current_file) {
        progressCurrentFileEl.textContent = `Copying ${payload.current_file}`;
      }

      // Feed the bar engine: completed bytes, the in-flight file, and the
      // throughput estimate the in-flight interpolation runs on.
      updateThroughput(payload.bytes_done);
      doneBytes = payload.bytes_done;
      if (payload.current_file_bytes !== inFlightBytes || payload.file_pct === null) {
        inFlightBytes = payload.current_file_bytes;
        inFlightSince = performance.now();
      }
    }
  );

  const unlisten2 = await listen<BackupFolderDoneEvent>(
    "backup-folder-done",
    ({ payload }) => {
      // The bar itself is byte-driven via the animation engine; folder
      // completion only feeds the fallback fraction (used when the plan is
      // zero — i.e. a fully up-to-date run that's just scanning).
      foldersDoneN  = payload.folders_done;
      foldersTotalN = payload.folders_total;
      // The folder's last in-flight file is definitionally finished, and the
      // folder's summary bytes are authoritative — including that last file,
      // which completed after the folder's final progress emit.
      inFlightBytes = 0;
      folderBytesAccum += payload.bytes_copied;
      doneBytes = Math.max(doneBytes, runTotalBytes, folderBytesAccum);

      // Teach the work model this machine's real comparison-scan rate: the
      // pair's wall time minus its copy time is scan time, and we know how
      // many files were compared. EMA'd so one anomalous folder can't skew
      // it; skipped for pairs too brief to measure meaningfully.
      const stats = statsCache.get(payload.source);
      const srcFiles = stats?.files ?? 0;
      if (srcFiles > 100 && payload.elapsed_secs > 0.5) {
        const copySecs = payload.bytes_copied / effectiveBps();
        const scanSecs = payload.elapsed_secs - copySecs;
        if (scanSecs > 0.25) {
          const rate = srcFiles / scanSecs;
          // First real measurement replaces the seed outright — a guess
          // deserves no vote against data. After that, EMA.
          scanFilesPerSec = scanRateLearned
            ? scanFilesPerSec * 0.7 + rate * 0.3
            : rate;
          scanRateLearned = true;
        }
      }
      // Reconcile stats with authoritative per-folder summary values.
      runTotalFiles = Math.max(runTotalFiles, payload.files_copied);
      runTotalDirs  = Math.max(runTotalDirs,  payload.dirs_copied);
      progressFilesEl.textContent = runTotalFiles.toLocaleString();
      progressDirsEl.textContent  = runTotalDirs.toLocaleString();
      progressBytesEl.textContent = formatBytes(runTotalBytes);
    }
  );

  const unlisten3 = await listen<BackupCompleteEvent>(
    "backup-complete",
    ({ payload }) => {
      stopElapsedTimer();
      setBackupRunning(false);
      clearBtn.disabled = false;

      progressFilesEl.textContent   = payload.total_files.toLocaleString();
      progressDirsEl.textContent    = payload.total_dirs.toLocaleString();
      progressBytesEl.textContent   = formatBytes(payload.total_bytes);
      progressExtrasEl.textContent  = payload.total_extras.toLocaleString();
      progressElapsedEl.textContent = formatSeconds(payload.total_secs);
      progressEtaEl.textContent     = "—";
      progressBarFill.classList.remove("ab-bar-indeterminate");
      if (payload.success) {
        // Let the engine sprint the bar to a full, animated 100%.
        barFinished = true;
        if (barRaf === null) barRaf = requestAnimationFrame(barTick);
      } else {
        // Failure/cancel: freeze the bar exactly where the run stopped.
        stopBarEngine();
      }
      if (!payload.aborted_file) {
        progressCurrentFileEl.textContent = "";
      }

      if (payload.log_paths && payload.log_paths.length > 0) {
        const names = payload.log_paths.map(p => p.replace(/\\/g, "/").split("/").pop() ?? p);
        progressLogEl.textContent = payload.log_paths.length === 1
          ? names[0]
          : `${payload.log_paths.length} log files`;
        progressLogEl.title = payload.log_paths.join("\n");
      }

      lastSkippedFiles = payload.skipped_files ?? [];
      syncSkippedFilesButton();

      if (payload.success) {
        const skipCount = lastSkippedFiles.length;
        if (skipCount > 0) {
          // Succeeded, but some files couldn't be copied — flag it with the
          // same ⚠ used in the Estimate Summary rather than a clean ✓.
          progressCurrentLabel.textContent =
            `⚠ Complete — ${skipCount} file${skipCount === 1 ? "" : "s"} skipped`;
          flash(
            `Backup complete, but ${skipCount} file${skipCount === 1 ? "" : "s"} couldn't be copied — see Skipped Files.`,
            "error",
            7000
          );
        } else {
          progressCurrentLabel.textContent = "Complete ✓";
          flash(
            `Backup complete — ${payload.total_files.toLocaleString()} files, ${formatBytes(payload.total_bytes)}`,
            "success",
            6000
          );
        }
      } else if (payload.aborted_file) {
        // Mid-file cancel: name what was interrupted, right where the person
        // is already looking (the line that showed "Copying …" a moment ago).
        progressCurrentLabel.textContent = "Cancelled";
        progressCurrentFileEl.textContent = `Aborted on: ${payload.aborted_file}`;
        flash(payload.message, "error", 8000);
      } else {
        progressCurrentLabel.textContent = `Failed: ${payload.message}`;
        flash(`Backup failed: ${payload.message}`, "error", 8000);
      }

      // Settle the Avg Copy Speed stat on the run's final measured value.
      progressSpeedEl.textContent = measuredBps > 0
        ? `${formatBytes(measuredBps)}/s`
        : "—";

      // ── Self-tuning copy speed ──
      // Blend the measured throughput into the stored setting so future time
      // estimates track this machine's reality instead of a manual guess.
      // Guards: only successful runs, only when enough data moved for the
      // measurement to mean something (small deltas are all noise), and only
      // when the EMA actually initialised. 70/30 blending means one outlier
      // run (thermal throttling, antivirus scan day) can't wreck the value,
      // and a manual override simply becomes the new 70% base. Clamped to the
      // input's own 1–10,000 MB/s range.
      const MIN_SAMPLE_BYTES = 100 * 1024 * 1024;
      if (payload.success && measuredBps > 0 && payload.total_bytes >= MIN_SAMPLE_BYTES) {
        const MB = 1024 * 1024;
        const blended = config.copySpeed * 0.7 + measuredBps * 0.3;
        const clamped = Math.min(10_000 * MB, Math.max(1 * MB, blended));
        if (Math.abs(clamped - config.copySpeed) >= 0.5 * MB) {
          config.copySpeed = clamped;
          speedInput.value = String(Math.max(1, Math.round(clamped / MB)));
          saveConfig(); // persists + re-renders estimates via the usual hook
        }
      }

      // The run changed the disk state (even a failed run may have got
      // part-way), so the "Next Backup" numbers are stale — force a rescan.
      // After a successful run this snaps the panel to the satisfying
      // "0 files to copy" state.
      queueEstimateRefresh(true);
    }
  );

  unlisteners.push(unlistenPlanProgress, unlistenPlanDone, unlisten1, unlistenProgress, unlisten2, unlisten3);
}

/* =============================================================================
   RUN BACKUP
============================================================================= */

async function startBackup(): Promise<void> {
  if (backupRunning) return;

  if (config.sources.length === 0) {
    flash("Add at least one source folder.", "error");
    return;
  }
  if (config.destinations.length === 0) {
    flash("Add at least one destination folder.", "error");
    return;
  }

  // Run the FULL path-safety validation (same checks the backend enforces:
  // same-path, nesting, duplicate leaf names) BEFORE showing the
  // confirmation modal. Confirming a backup that was always going to be
  // refused is a broken promise — the error belongs on this click, not
  // after "Proceed".
  try {
    await invoke("validate_backup_config", {
      sources: config.sources,
      destinations: config.destinations,
    });
  } catch (e) {
    flash(String(e), "error", 8000);
    return;
  }

  // Everything below is gated behind an explicit confirmation — /MIR can
  // delete files in the destinations, so a stray click on Run must never
  // start a backup by itself.
  await openRunConfirmModal();
}

/** Fills the confirmation modal's dynamic text and opens it. */
async function openRunConfirmModal(): Promise<void> {
  // Prefer the live estimate — it's the EXACT workload of this run (the /L
  // delta), which is what the person is actually consenting to. "Fresh"
  // means: a scan has completed, none is in flight, and the path sets
  // haven't changed since it ran.
  const estFresh =
    estimate !== null &&
    !estimateScanning &&
    estimateFingerprint() === _lastEstimateFp;

  if (estFresh) {
    const n = estimate!.files_to_copy;
    confirmFilesEl.textContent = `${n.toLocaleString()} ${n === 1 ? "file" : "files"}`;
    confirmSizeEl.textContent = formatBytes(estimate!.bytes_to_copy);
  } else {
    // No trustworthy estimate yet (still scanning, or config just changed):
    // fall back to the source totals as an explicit UPPER BOUND — a mirror
    // run never copies more than the sources contain.
    const scanning = config.sources.some((s) => sizeCache.get(s) == null);
    const n = totalSourceFiles;
    confirmFilesEl.textContent = scanning
      ? `${n.toLocaleString()}+ files`
      : `up to ${n.toLocaleString()} ${n === 1 ? "file" : "files"}`;
    confirmSizeEl.textContent = scanning
      ? "size still being calculated"
      : `up to ${formatBytes(totalSourceBytes * config.destinations.length)}`;
  }
  confirmDrivesEl.textContent = formatDriveList(config.destinations);

  // Open right away with whatever we've got, then refresh free space and
  // fill in the warnings once that resolves — a drive plugged in seconds ago
  // shouldn't still show as unavailable at exactly this moment. The modal
  // isn't gated behind this network round-trip; the warnings just appear a
  // beat after the rest of the text if the check takes a moment.
  confirmSpaceWarningsEl.innerHTML = "";
  runConfirmModal.open();

  await refreshFreeSpace();
  renderSpaceWarnings(estFresh);
}

/**
 * Builds one warning paragraph per destination whose free space is less than
 * what this run plans to copy TO it. Non-blocking by design: "size to copy"
 * is the full size of every changed file, not the actual new bytes an
 * overwrite adds (robocopy replaces a changed file wholesale rather than
 * patching it, so the real new disk usage for a changed file is only the
 * size difference — usually smaller, sometimes nothing). Only shown when a
 * fresh estimate gives real per-destination numbers to compare against.
 */
function renderSpaceWarnings(estFresh: boolean): void {
  confirmSpaceWarningsEl.innerHTML = "";
  if (!estFresh || !estimate) return;

  const bytesByDest = new Map<string, number>();
  for (const per of estimate.per_destination) {
    bytesByDest.set(per.destination, (bytesByDest.get(per.destination) ?? 0) + per.bytes);
  }

  for (const destination of config.destinations) {
    const plannedBytes = bytesByDest.get(destination) ?? 0;
    if (plannedBytes === 0) continue;

    const first = destination.trim().charAt(0);
    const isDriveLetter = /[a-z]/i.test(first);
    const letter = isDriveLetter ? first.toUpperCase() : null;
    const freeBytes = letter ? freeSpaceByLetter.get(letter) : undefined;
    // No reading for this drive (unplugged, or a UNC path free-space can't
    // check) means "unknown", not "definitely fine" — stay silent rather
    // than guess either way.
    if (freeBytes === undefined || freeBytes >= plannedBytes) continue;

    const p = document.createElement("p");
    p.className = "ab-confirm-space-warning";
    p.textContent =
      `⚠ ${destination} has ${formatBytes(freeBytes)} free, but this run plans to copy ` +
      `${formatBytes(plannedBytes)} to it. That number counts the full size of every ` +
      `changed file, not just the new bytes an overwrite actually adds, so this may still ` +
      `fit — but it's close enough to be worth checking first.`;
    confirmSpaceWarningsEl.appendChild(p);
  }
}

/**
 * Renders the destination set as "drive D:" / "drives D: and E:" /
 * "drives D:, E:, and F:". Destinations without a drive letter (e.g. UNC
 * paths) are listed by their path instead.
 */
function formatDriveList(destinations: string[]): string {
  const labels: string[] = [];
  for (const dest of destinations) {
    const first = dest.trim().charAt(0);
    const label = /[a-z]/i.test(first) ? `${first.toUpperCase()}:` : dest;
    if (!labels.includes(label)) labels.push(label);
  }
  labels.sort();

  const word = labels.length === 1 ? "drive" : "drives";
  const joined =
    labels.length <= 1 ? labels.join("")
    : labels.length === 2 ? `${labels[0]} and ${labels[1]}`
    : `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
  return `${word} ${joined}`;
}

/** Actually starts the backup — only ever reached via the confirmation
 *  modal's "Proceed with Backup" button. */
async function launchBackup(): Promise<void> {
  if (backupRunning) return;

  // A live estimate is now pointless — the run's own preflight measures the
  // same thing, and the post-run refresh re-estimates anyway. Kill it at the
  // backend and orphan its promise (the seq bump makes every branch of the
  // in-flight call early-return), then reset the button/cells it owned.
  void invoke("cancel_estimate").catch(() => {});
  _estimateSeq++;
  estimateScanning = false;
  syncEstimateButton();
  renderEstimateCells();

  resetProgress();
  showProgressContent(true);
  // Fast mode has no live per-file text — hide that line for this run so it
  // doesn't sit frozen on a stale filename. Details mode shows it as usual.
  progressCurrentFileEl.style.display = config.showDetails ? "" : "none";
  hasRunOnce = true;
  clearBtn.disabled = true; // disabled while running
  setBackupRunning(true);
  startBarEngine();
  startElapsedTimer();
  progressCurrentLabel.textContent = "Calculating backup size…";
  flash("Backup started.", "success", 3000);
  // Same reasoning as runEstimate: a drive connected after the app opened
  // (or since the last check) should stop showing "unavailable".
  void refreshFreeSpace();

  try {
    await invoke("run_backup", {
      sources:      config.sources,
      destinations: config.destinations,
      showDetails:  config.showDetails,
    });
  } catch (e) {
    stopElapsedTimer();
    setBackupRunning(false);
    clearBtn.disabled = false;
    progressCurrentLabel.textContent = `Error: ${e}`;
    flash(`Backup error: ${e}`, "error", 8000);
  }
}

/* =============================================================================
   ENTRY DISCLAIMER  — first-thing warning face
   -----------------------------------------------------------------------------
   Shown on every entry to the tool (via onAutoBackupToolEntry, called from
   shell.ts) until the user checks "Never show this warning again", which is
   persisted in the backup config. "Continue to Tool" cross-fades to the tool
   face using the same pattern as Budget's main ⇄ Annual Stats switch.
============================================================================= */

/** Guards against double-clicks mid cross-fade. */
let _faceSwitching = false;

/** Snaps directly to a face with no animation (used on tool entry). */
function setFaceInstant(which: "tool" | "disclaimer"): void {
  faceDisclaimer.classList.remove("ab-face-hiding", "ab-face-showing");
  faceTool.classList.remove("ab-face-hiding", "ab-face-showing");
  faceDisclaimer.style.display = which === "disclaimer" ? "flex" : "none";
  faceTool.style.display = which === "tool" ? "flex" : "none";
  _faceSwitching = false;
}

/** Decides which face an entry to the tool should land on. */
function applyDisclaimerEntryState(): void {
  // A live backup takes precedence over the disclaimer: hiding an active
  // progress view behind a warning would be worse than skipping a warning
  // for someone who has clearly already engaged with the tool this session.
  if (config.skipDisclaimer || backupRunning) {
    setFaceInstant("tool");
    return;
  }
  disclaimerSkipCheck.checked = false;
  setFaceInstant("disclaimer");
}

/**
 * Called by shell.ts every time the user navigates to the Auto-Backup tool.
 * Calls that arrive before init completes (the startup-restore path) are
 * ignored — initAutoBackup applies the entry state itself once ready.
 */
export function onAutoBackupToolEntry(): void {
  if (!_abInitialized) return;
  applyDisclaimerEntryState();
}

/** Cross-fades disclaimer → tool (mirrors Budget's toggleAnnualStats). */
function fadeToToolFace(): void {
  const HALF = 400; // ms — matches the CSS animation duration

  if (_faceSwitching) return;
  _faceSwitching = true;

  // Phase 1: fade out the disclaimer face
  faceDisclaimer.classList.add("ab-face-hiding");

  window.setTimeout(() => {
    // Midpoint: swap which face is in the DOM flow
    faceDisclaimer.classList.remove("ab-face-hiding");
    faceDisclaimer.style.display = "none";
    faceTool.style.display = "flex";

    // Phase 2: fade in the tool face
    faceTool.classList.add("ab-face-showing");

    faceTool.addEventListener("animationend", function done(e: AnimationEvent) {
      // Children animate too as they enter the DOM flow (e.g. the list rows'
      // abRowIn) and those animationend events BUBBLE up to the face —
      // filter to our own fade so a 0.15s row animation can't cut the 0.4s
      // face fade short.
      if (e.animationName !== "ab-face-in") return;
      faceTool.removeEventListener("animationend", done);
      faceTool.classList.remove("ab-face-showing");
      _faceSwitching = false;
    });
  }, HALF);
}

/** Wires the disclaimer face's controls. Called once from initAutoBackup. */
function initDisclaimer(): void {
  faceDisclaimer      = document.getElementById("ab-face-disclaimer")!;
  faceTool            = document.getElementById("ab-face-tool")!;
  disclaimerSkipCheck = document.getElementById("ab-disclaimer-skip-check") as HTMLInputElement;

  document.getElementById("ab-disclaimer-continue-btn")!.addEventListener("click", () => {
    if (disclaimerSkipCheck.checked && !config.skipDisclaimer) {
      config.skipDisclaimer = true;
      saveConfig();
    }
    fadeToToolFace();
  });

  document.getElementById("ab-disclaimer-home-btn")!.addEventListener("click", () => {
    // Reuse the header back-button's existing shell wiring for Home
    // navigation rather than importing shell internals.
    document
      .querySelector<HTMLElement>("#files-tool-auto-backup .tool-back-btn")
      ?.click();
  });
}

/* =============================================================================
   RUN CONFIRMATION MODAL
============================================================================= */

/** Wires the Copy Speed info modal. Called once from initAutoBackup. */
function initSpeedInfoModal(): void {
  const speedInfoModal = new Modal(document.getElementById("abSpeedInfoBackdrop")!);
  document.getElementById("ab-speed-info-btn")!
    .addEventListener("click", () => speedInfoModal.open());
  document.getElementById("abSpeedInfoClose")!
    .addEventListener("click", () => speedInfoModal.close());
}

/** Wires the Dirs to Copy info modal (the ℹ button itself is revealed by
 *  renderEstimateCells only when Dirs to Copy exceeds Total Source Dirs). */
function initDirsInfoModal(): void {
  const dirsInfoModal = new Modal(document.getElementById("abDirsInfoBackdrop")!);
  document.getElementById("ab-dirs-info-btn")!
    .addEventListener("click", () => dirsInfoModal.open());
  document.getElementById("abDirsInfoClose")!
    .addEventListener("click", () => dirsInfoModal.close());
}

/** Wires the run-confirmation modal. Called once from initAutoBackup. */
function initRunConfirmModal(): void {
  runConfirmModal = new Modal(document.getElementById("abRunConfirmBackdrop")!);

  confirmFilesEl  = document.getElementById("ab-confirm-files")!;
  confirmSizeEl   = document.getElementById("ab-confirm-size")!;
  confirmDrivesEl = document.getElementById("ab-confirm-drives")!;
  confirmSpaceWarningsEl = document.getElementById("ab-confirm-space-warnings")!;

  // X and the abort button both simply close — closing IS the abort, since
  // nothing has been started yet. Escape and header-drag come free from the
  // Modal primitive.
  document.getElementById("abRunConfirmClose")!
    .addEventListener("click", () => runConfirmModal.close());
  document.getElementById("abRunConfirmAbortBtn")!
    .addEventListener("click", () => runConfirmModal.close());

  document.getElementById("abRunConfirmProceedBtn")!.addEventListener("click", () => {
    runConfirmModal.close();
    launchBackup();
  });
}

/* =============================================================================
   SKIPPED FILES MODAL
   -----------------------------------------------------------------------------
   Files robocopy attempted to copy but couldn't (locked/access error) — the
   destination still completed; these were skipped, not the reason for a
   failure. Populated once per run by the backup-complete handler.
============================================================================= */

function initSkippedFilesModal(): void {
  skippedFilesModal = new Modal(document.getElementById("abSkippedFilesBackdrop")!);
  skippedFilesBtn      = document.getElementById("ab-skipped-files-btn") as HTMLButtonElement;
  skippedFilesCountEl  = document.getElementById("ab-skipped-files-count")!;
  skippedFilesListEl   = document.getElementById("ab-skipped-files-list")!;

  skippedFilesBtn.addEventListener("click", () => {
    renderSkippedFilesList();
    skippedFilesModal.open();
  });
  document.getElementById("abSkippedFilesClose")!
    .addEventListener("click", () => skippedFilesModal.close());

  document.getElementById("ab-skipped-files-explorer-btn")!.addEventListener("click", async () => {
    if (lastSkippedFiles.length === 0) return;
    // Open to the FIRST skipped file's SOURCE path, not its destination —
    // the destination copy was never successfully written (that's the whole
    // reason it's in this list), so explorer would have nothing to select
    // there. The source file always exists; robocopy failed to read/write
    // it, but never touched the original.
    const path = lastSkippedFiles[0].source;
    try {
      await invoke("show_in_explorer", { path });
    } catch (e) {
      devError(`show_in_explorer failed for ${path}:`, e);
    }
  });
}

/** Fills the skipped-files modal's count and scrollable list from the last
 *  run's results. Called each time the modal is opened, not just once at
 *  backup-complete, so it always reflects lastSkippedFiles exactly. */
function renderSkippedFilesList(): void {
  const n = lastSkippedFiles.length;
  skippedFilesCountEl.textContent = `${n.toLocaleString()} file${n === 1 ? "" : "s"} couldn't be copied`;

  skippedFilesListEl.innerHTML = "";
  for (const entry of lastSkippedFiles) {
    const row = document.createElement("div");
    row.className = "ab-skipped-file-row";

    const srcEl = document.createElement("div");
    srcEl.className = "ab-skipped-file-source";
    srcEl.textContent = entry.source;
    srcEl.title = entry.source;

    const arrowEl = document.createElement("div");
    arrowEl.className = "ab-skipped-file-arrow";
    arrowEl.textContent = "→";

    const destEl = document.createElement("div");
    destEl.className = "ab-skipped-file-dest";
    destEl.textContent = entry.destination;
    destEl.title = entry.destination;

    row.appendChild(srcEl);
    row.appendChild(arrowEl);
    row.appendChild(destEl);
    skippedFilesListEl.appendChild(row);
  }
}

/** Shows/hides the "View Skipped Files" button based on the last run. */
function syncSkippedFilesButton(): void {
  skippedFilesBtn.style.display = lastSkippedFiles.length > 0 ? "" : "none";
}

/* =============================================================================
   PRESETS MODAL
============================================================================= */

function initPresetsModal(): void {
  presetsModal = new Modal(document.getElementById("abPresetsBackdrop")!, {
    onOpen: () => {
      renderPresetList();
      renderPresetEditor();
    },
  });

  // Open / close
  presetsBtn.addEventListener("click", () => presetsModal.open());
  document.getElementById("abPresetsClose")!.addEventListener("click", () => presetsModal.close());

  // New preset
  document.getElementById("ab-preset-new-btn")!.addEventListener("click", () => {
    const preset: BackupPreset = {
      id:           generateId(),
      name:         "New Preset",
      sources:      [],
      destinations: [],
    };
    presets.push(preset);
    savePresets();
    selectPreset(preset.id);
    // Focus name field so user can rename immediately
    setTimeout(() => {
      const input = document.getElementById("ab-preset-name-input") as HTMLInputElement;
      input.focus();
      input.select();
    }, 50);
  });

  // Name input auto-save
  document.getElementById("ab-preset-name-input")!.addEventListener("input", () => {
    const preset = presets.find(p => p.id === activePresetId);
    if (!preset) return;
    preset.name = (document.getElementById("ab-preset-name-input") as HTMLInputElement).value.trim() || "Unnamed";
    savePresets();
    renderPresetList();
  });

  // Source add
  const srcInput  = document.getElementById("ab-preset-src-input")  as HTMLInputElement;
  document.getElementById("ab-preset-src-add")!.addEventListener("click", () => {
    addPathToPreset("sources", srcInput.value);
    srcInput.value = "";
  });
  srcInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { addPathToPreset("sources", srcInput.value); srcInput.value = ""; }
  });
  document.getElementById("ab-preset-src-browse")!.addEventListener("click", async () => {
    const picked = await pickFolder();
    if (picked) { addPathToPreset("sources", picked); }
  });

  // Destination add
  const dstInput  = document.getElementById("ab-preset-dst-input")  as HTMLInputElement;
  document.getElementById("ab-preset-dst-add")!.addEventListener("click", () => {
    addPathToPreset("destinations", dstInput.value);
    dstInput.value = "";
  });
  dstInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { addPathToPreset("destinations", dstInput.value); dstInput.value = ""; }
  });
  document.getElementById("ab-preset-dst-browse")!.addEventListener("click", async () => {
    const picked = await pickFolder();
    if (picked) { addPathToPreset("destinations", picked); }
  });

  // Load into main
  document.getElementById("ab-preset-load-btn")!.addEventListener("click", () => {
    const preset = presets.find(p => p.id === activePresetId);
    if (!preset) return;
    if (backupRunning) { flash("Cannot load a preset while a backup is running.", "error"); return; }

    // Clear size cache for old sources
    for (const src of config.sources) sizeCache.delete(src);

    config.sources      = [...preset.sources];
    config.destinations = [...preset.destinations];
    saveConfig();

    renderSourceList();
    renderDestList();
    refreshSummary();
    refreshEstSize();
    refreshFreeSpace();

    // Kick off size scans
    for (const src of config.sources) {
      if (!sizeCache.has(src)) fetchAndCacheSize(src);
    }

    presetsModal.close();
    flash(`Preset "${preset.name}" loaded.`, "success");
  });

  // Delete preset
  document.getElementById("ab-preset-delete-btn")!.addEventListener("click", () => {
    const preset = presets.find(p => p.id === activePresetId);
    if (!preset) return;
    const name = preset.name;
    presets = presets.filter(p => p.id !== activePresetId);
    activePresetId = presets.length > 0 ? presets[0].id : null;
    savePresets();
    renderPresetList();
    renderPresetEditor();
    flash(`Preset "${name}" deleted.`, "success");
  });
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function renderPresetList(): void {
  const list = document.getElementById("ab-presets-list")!;
  list.innerHTML = "";

  if (presets.length === 0) {
    const empty = document.createElement("div");
    empty.className   = "ab-presets-list-empty";
    empty.textContent = "No presets yet.";
    list.appendChild(empty);
    return;
  }

  for (const preset of presets) {
    const item = document.createElement("div");
    item.className = "ab-preset-item" + (preset.id === activePresetId ? " active" : "");
    item.textContent = preset.name || "(unnamed)";
    item.title       = preset.name || "(unnamed)";
    item.addEventListener("click", () => selectPreset(preset.id));
    list.appendChild(item);
  }
}

function selectPreset(id: string): void {
  activePresetId = id;
  renderPresetList();
  renderPresetEditor();
}

function renderPresetEditor(): void {
  const placeholder = document.getElementById("ab-presets-placeholder")!;
  const form        = document.getElementById("ab-presets-form")!;

  const preset = presets.find(p => p.id === activePresetId);
  if (!preset) {
    placeholder.style.display = "";
    form.style.display = "none";
    return;
  }

  placeholder.style.display = "none";
  form.style.display = "flex";

  (document.getElementById("ab-preset-name-input") as HTMLInputElement).value = preset.name;
  renderPresetPathList("sources", preset);
  renderPresetPathList("destinations", preset);
}

function renderPresetPathList(which: "sources" | "destinations", preset: BackupPreset): void {
  const listId = which === "sources" ? "ab-preset-src-list" : "ab-preset-dst-list";
  const list   = document.getElementById(listId)!;
  list.innerHTML = "";

  const paths = preset[which];

  if (paths.length === 0) {
    const empty = document.createElement("div");
    empty.className   = "ab-presets-path-empty";
    empty.textContent = `No ${which} added.`;
    list.appendChild(empty);
    return;
  }

  paths.forEach((path, i) => {
    const row = document.createElement("div");
    row.className = "ab-preset-path-row";

    const label = document.createElement("span");
    label.className   = "ab-preset-path-label";
    label.textContent = path;
    label.title       = path;
    row.appendChild(label);

    const removeBtn = document.createElement("button");
    removeBtn.className = "ab-preset-path-remove danger-btn";
    removeBtn.title     = "Remove";
    removeBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
    removeBtn.addEventListener("click", () => {
      preset[which].splice(i, 1);
      savePresets();
      renderPresetPathList(which, preset);
      flash("Path removed from preset.", "success");
    });
    row.appendChild(removeBtn);

    list.appendChild(row);
  });
}

function addPathToPreset(which: "sources" | "destinations", raw: string): void {
  const preset = presets.find(p => p.id === activePresetId);
  if (!preset) return;
  const path = raw.trim();
  if (!path) { flash("Enter a folder path first.", "error"); return; }
  if (preset[which].includes(path)) { flash("That path is already in this preset.", "error"); return; }
  preset[which].push(path);
  savePresets();
  renderPresetPathList(which, preset);
  flash("Path added to preset.", "success");
}


/* =============================================================================
   EXPORT — INIT
============================================================================= */

export async function initAutoBackup(): Promise<void> {
  // Resolve element refs
  sourceList      = document.getElementById("ab-source-list")!;
  addSourceBtn    = document.getElementById("ab-add-source-btn") as HTMLButtonElement;
  browseSourceBtn = document.getElementById("ab-browse-source-btn") as HTMLButtonElement;
  sourceInput     = document.getElementById("ab-source-input") as HTMLInputElement;

  destList      = document.getElementById("ab-dest-list")!;
  addDestBtn    = document.getElementById("ab-add-dest-btn") as HTMLButtonElement;
  browseDestBtn = document.getElementById("ab-browse-dest-btn") as HTMLButtonElement;
  destInput     = document.getElementById("ab-dest-input") as HTMLInputElement;

  totalSizeEl  = document.getElementById("ab-total-size")!;
  totalFilesEl = document.getElementById("ab-total-files")!;
  totalDirsEl  = document.getElementById("ab-total-dirs")!;
  estSizeEl    = document.getElementById("ab-est-size")!;
  estFilesEl   = document.getElementById("ab-est-files")!;
  estDirsEl    = document.getElementById("ab-est-dirs")!;
  estimateBtn      = document.getElementById("ab-estimate-btn") as HTMLButtonElement;
  estimateBtnLabel = document.getElementById("ab-estimate-btn-label")!;
  estimateSpinner  = document.getElementById("ab-estimate-spinner")!;
  runBtnLabel      = document.getElementById("ab-run-btn-label")!;
  runSpinner       = document.getElementById("ab-run-spinner")!;
  dirsInfoBtn  = document.getElementById("ab-dirs-info-btn") as HTMLButtonElement;
  estDeletesEl = document.getElementById("ab-est-deletes")!;
  estimateStatusEl = document.getElementById("ab-estimate-status")!;
  estTimeEl   = document.getElementById("ab-est-time")!;
  freeSpaceEl = document.getElementById("ab-free-space")!;
  speedInput  = document.getElementById("ab-speed-input") as HTMLInputElement;

  runBtn    = document.getElementById("ab-run-btn") as HTMLButtonElement;
  cancelBtn = document.getElementById("ab-cancel-btn") as HTMLButtonElement;
  detailsToggle = document.getElementById("ab-details-toggle") as HTMLInputElement;
  detailsLabel  = document.getElementById("ab-details-label")!;
  detailsToggleWrap = document.getElementById("ab-details-toggle-wrap")!;

  progressPanel        = document.getElementById("ab-progress-panel")!;
  progressContent      = document.getElementById("ab-progress-content")!;
  progressIdleEl       = document.getElementById("ab-progress-idle")!;
  progressCurrentLabel    = document.getElementById("ab-progress-current")!;
  progressCurrentFileEl   = document.getElementById("ab-progress-current-file")!;
  progressFilesEl         = document.getElementById("ab-progress-files")!;
  progressDirsEl       = document.getElementById("ab-progress-dirs")!;
  progressBytesEl      = document.getElementById("ab-progress-bytes")!;
  progressElapsedEl    = document.getElementById("ab-progress-elapsed")!;
  progressSpeedEl      = document.getElementById("ab-progress-speed")!;
  progressExtrasEl     = document.getElementById("ab-progress-extras")!;
  progressEtaEl        = document.getElementById("ab-progress-eta")!;
  progressBarFill      = document.getElementById("ab-progress-bar-fill")!;
  progressLogEl        = document.getElementById("ab-progress-log")!;
  clearBtn             = document.getElementById("ab-clear-btn") as HTMLButtonElement;
  clearSourceBtn       = document.getElementById("ab-clear-source-btn") as HTMLButtonElement;
  clearDestBtn         = document.getElementById("ab-clear-dest-btn") as HTMLButtonElement;
  presetsBtn           = document.getElementById("ab-presets-btn") as HTMLButtonElement;

  await loadConfig();
  await loadPresets();

  speedInput.value = String(Math.round(config.copySpeed / (1024 * 1024)));

  renderSourceList();
  renderDestList();
  renderDetailsToggle();
  refreshSummary();
  refreshEstSize();
  refreshFreeSpace();

  // Kick off size scans for saved sources
  for (const src of config.sources) {
    if (!sizeCache.has(src)) fetchAndCacheSize(src);
  }

  // Deliberately NO estimate on app load — opening the app shouldn't spin
  // the disks through a full /L walk. The first estimate runs when the user
  // clicks Run Estimate, changes the configuration, or completes a backup.

  // ── Event wiring ─────────────────────────────────────────────────────────

  addSourceBtn.addEventListener("click", () => addSource(sourceInput.value));
  sourceInput.addEventListener("keydown", (e) => { if (e.key === "Enter") addSource(sourceInput.value); });
  browseSourceBtn.addEventListener("click", async () => {
    const picked = await pickFolder();
    if (picked) addSource(picked);
  });

  addDestBtn.addEventListener("click", () => addDest(destInput.value));
  destInput.addEventListener("keydown", (e) => { if (e.key === "Enter") addDest(destInput.value); });
  browseDestBtn.addEventListener("click", async () => {
    const picked = await pickFolder();
    if (picked) addDest(picked);
  });

  speedInput.addEventListener("change", () => {
    const mbps = parseFloat(speedInput.value) || 30;
    config.copySpeed = Math.max(1, mbps) * 1024 * 1024;
    saveConfig();
    refreshEstTime();
  });

  runBtn.addEventListener("click", startBackup);
  estimateBtn.addEventListener("click", () => {
    if (estimateScanning || backupRunning) return;
    _estimateForce = true; // a deliberate click means "measure NOW"
    _estimateManual = true; // errors on a deliberate click deserve a toast
    void runEstimate();
  });

  detailsToggle.addEventListener("change", () => {
    if (backupRunning) {
      // Shouldn't fire (disabled mid-run), but guard anyway: revert.
      detailsToggle.checked = config.showDetails;
      return;
    }
    config.showDetails = detailsToggle.checked;
    renderDetailsToggle();
    saveConfig();
  });

  cancelBtn.addEventListener("click", async () => {
    try {
      await invoke("cancel_backup");
      flash("Cancelling — stopping the current copy…", "error", 4000);
    } catch (e) {
      devError("Cancel failed:", e);
    }
  });

  clearBtn.addEventListener("click", () => {
    if (backupRunning) return;
    resetProgress();
    showProgressContent(false);
    clearBtn.disabled = true;
    flash("Last run results cleared.", "success");
  });

  clearSourceBtn.addEventListener("click", () => {
    if (backupRunning) return;
    for (const src of config.sources) sizeCache.delete(src);
    config.sources = [];
    saveConfig();
    renderSourceList();
    refreshSummary();
    refreshEstTime();
    refreshEstSize();
    flash("Source folders cleared.", "success");
  });

  clearDestBtn.addEventListener("click", () => {
    if (backupRunning) return;
    config.destinations = [];
    saveConfig();
    renderDestList();
    refreshEstTime();
    refreshEstSize();
    refreshFreeSpace();
    flash("Destination folders cleared.", "success");
  });

  initPresetsModal();
  initRunConfirmModal();
  initSkippedFilesModal();
  initSpeedInfoModal();
  initDirsInfoModal();
  initDisclaimer();

  await attachBackupListeners();

  _abInitialized = true;

  // The startup-restore path can navigate to this tool BEFORE this init ran
  // (loadShellState resolves earlier in shell.ts's boot sequence), in which
  // case the entry hook above was a deferred no-op — apply the disclaimer
  // decision now that config and refs exist. The window isn't shown until
  // after all tool inits complete, so there's no visible face flash.
  const view = document.getElementById("files-tool-auto-backup")!;
  if (view.style.display !== "none") applyDisclaimerEntryState();
}