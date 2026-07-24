/* =============================================================================
   IMAGE CCR  — Combine / Compress / Resize
   -----------------------------------------------------------------------------
   Frontend logic for the Image CCR tool. All image processing runs in Rust
   via invoke(); this file owns UI state, event wiring, and result display.

   Tabs:
     Combine  — stack multiple images into one (with gap, border, format options)
     Compress — scale a single image down by percentage
     Resize   — batch-resize a folder of images to a target dimension / canvas

   Rust commands used:
     get_image_info, preview_combine, combine_images,
     compress_image, show_in_explorer,
     get_resize_folder_stats, resize_images, cancel_resize
============================================================================= */

import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open }           from "@tauri-apps/plugin-dialog";
import { Modal }          from "../modal";
import { flash, escapeHtml } from "../shell";

// =============================================================================
//  TYPES  — mirror Rust structs exactly
// =============================================================================

interface ImageInfo {
  path:       string;
  name:       string;
  width:      number;
  height:     number;
  size_bytes: number;
}

interface CombineResult {
  output_path: string;
  width:       number;
  height:      number;
  size_bytes:  number;
}

interface PreviewResult {
  temp_path: string;
  width:     number;
  height:    number;
}

interface CompressResult {
  output_path: string;
  width:       number;
  height:      number;
  size_bytes:  number;
}

interface ResizeFolderStats {
  count:   number;
  min_w:   number;
  max_w:   number;
  min_h:   number;
  max_h:   number;
}

// =============================================================================
//  STATE
// =============================================================================

const combineState = {
  images:          [] as ImageInfo[],
  direction:       "below",
  outputFolder:    null as string | null,
  resultPath:      null as string | null,
  canvasColor:        "#000000",
  gap:                0,
  borderEnabled:      false,
  borderThickness:    0,
  borderColor:        "#000000",
  borderColorUserSet: false,
  outputFormat:    "jpg" as "jpg" | "png",
};

const compressState = {
  image:        null as ImageInfo | null,
  percentage:   80,
  outputFolder: null as string | null,
  resultPath:   null as string | null,
};

const resizeState = {
  sourceFolder:      null as string | null,
  outputFolder:      null as string | null,
  lastResultFolder:  null as string | null,
  targetW:           null as number | null,
  targetH:           null as number | null,
  canvasManual:      false,
  canvasW:           null as number | null,
  canvasH:           null as number | null,
  gravity:           "center",
  bgColor:           "#000000",
  outputFormat:      "jpg" as "jpg" | "png",
};

// =============================================================================
//  UTILITIES
// =============================================================================

function formatBytes(bytes: number): string {
  if (bytes < 1024)        return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function pathToSrc(filePath: string): string {
  return convertFileSrc(filePath);
}

function swap<T>(arr: T[], a: number, b: number) {
  [arr[a], arr[b]] = [arr[b], arr[a]];
}

function setLoading(btn: HTMLButtonElement, loading: boolean) {
  btn.classList.toggle("loading", loading);
  if (loading) {
    btn.dataset.label = btn.textContent!.trim();
    btn.textContent   = `${btn.dataset.label} ⟳`;
  } else {
    btn.textContent = btn.dataset.label ?? btn.textContent!.replace(" ⟳", "");
  }
}

/**
 * Makes a hex colour label span double-click-editable.
 * On commit, validates the value as a 6-digit hex colour, updates both the
 * colour picker input and the label text, and calls onCommit with the new value.
 * Used for canvas color, border color, and resize background color.
 */
function makeHexEditable(
  hexSpan: HTMLElement,
  colorInput: HTMLInputElement,
  onCommit: (val: string) => void,
): void {
  hexSpan.style.cursor = "text";
  hexSpan.title = "Double-click to edit";
  hexSpan.addEventListener("dblclick", () => {
    if (hexSpan.querySelector("input")) return;
    const current = hexSpan.textContent!.trim();
    const field = document.createElement("input");
    field.type      = "text";
    field.value     = current;
    field.maxLength = 7;
    field.className = "hex-inline-input";
    hexSpan.textContent = "";
    hexSpan.appendChild(field);
    field.focus();
    field.select();

    function commit() {
      let val = field.value.trim();
      if (!val.startsWith("#")) val = "#" + val;
      if (/^#[0-9a-fA-F]{6}$/.test(val)) {
        colorInput.value    = val.toLowerCase();
        hexSpan.textContent = val.toUpperCase();
        onCommit(val.toLowerCase());
      } else {
        hexSpan.textContent = current;
      }
    }

    field.addEventListener("blur", commit);
    field.addEventListener("keydown", (e) => {
      if (e.key === "Enter")  { e.preventDefault(); field.blur(); }
      if (e.key === "Escape") { hexSpan.textContent = current; }
    });
  });
}

// =============================================================================
//  COMBINE HELPERS
// =============================================================================

let dragSrcIdx: number | null = null;

function renderCombinePreview() {
  const strip          = document.getElementById("combine-preview-strip")!;
  const previewSection = document.getElementById("combine-preview-section")!;
  const optionsSection = document.getElementById("combine-options-section")!;
  const countBadge     = document.getElementById("combine-count")!;

  const count = combineState.images.length;
  countBadge.textContent = `${count} image${count !== 1 ? "s" : ""}`;
  strip.innerHTML = "";

  strip.addEventListener("dragover", (e) => {
    if (dragSrcIdx !== null) e.preventDefault();
  });

  combineState.images.forEach((img, idx) => {
    const card       = document.createElement("div");
    card.className   = "preview-card" + (idx === 0 ? " anchor-card" : "");
    card.dataset.idx = String(idx);
    card.draggable   = true;

    // img.name is a user-controlled filename and pathToSrc() output embeds
    // the user's directory names — both are escaped so a crafted filename
    // can't break out of the attribute or inject markup. The image-load
    // fallback is wired via addEventListener rather than an inline onerror
    // attribute, which the app's CSP (script-src 'self') would block.
    card.innerHTML = `
      ${idx === 0 ? '<span class="anchor-badge">ANCHOR</span>' : ""}
      <img src="${escapeHtml(pathToSrc(img.path))}" alt="${escapeHtml(img.name)}" />
      <div class="preview-card-info">
        <div class="preview-card-name">${escapeHtml(img.name)}</div>
        <div class="preview-card-dims">${img.width}×${img.height}</div>
      </div>
      <div class="preview-card-btns">
        ${idx > 0
          ? `<button class="card-move-btn" data-move="left"  title="Move left">◀</button>`
          : ""}
        ${idx < count - 1
          ? `<button class="card-move-btn" data-move="right" title="Move right">▶</button>`
          : ""}
        <button class="preview-card-remove" title="Remove">✕</button>
      </div>
    `;

    const thumbEl = card.querySelector<HTMLImageElement>("img")!;
    thumbEl.addEventListener(
      "error",
      () => { thumbEl.style.opacity = "0.15"; },
      { once: true },
    );

    card.querySelector<HTMLButtonElement>(".preview-card-remove")!
      .addEventListener("click", (e) => {
        e.stopPropagation();
        combineState.images.splice(idx, 1);
        renderCombinePreview();
      });

    card.querySelectorAll<HTMLButtonElement>(".card-move-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (btn.dataset.move === "left"  && idx > 0)         swap(combineState.images, idx - 1, idx);
        if (btn.dataset.move === "right" && idx < count - 1) swap(combineState.images, idx, idx + 1);
        renderCombinePreview();
      });
    });

    card.addEventListener("dragstart", (e) => {
      dragSrcIdx = idx;
      card.classList.add("dragging");
      e.dataTransfer?.setData("text/plain", String(idx));
    });

    card.addEventListener("dragend", () => {
      dragSrcIdx = null;
      card.classList.remove("dragging");
      strip.querySelectorAll(".preview-card").forEach((c) =>
        c.classList.remove("drag-target"),
      );
    });

    card.addEventListener("dragover", (e) => {
      if (dragSrcIdx === null) return;
      e.preventDefault();
      e.stopPropagation();
      strip.querySelectorAll(".preview-card").forEach((c) =>
        c.classList.remove("drag-target"),
      );
      if (dragSrcIdx !== idx) card.classList.add("drag-target");
    });

    card.addEventListener("drop", (e) => {
      if (dragSrcIdx === null || dragSrcIdx === idx) return;
      e.preventDefault();
      e.stopPropagation();
      const [moved] = combineState.images.splice(dragSrcIdx, 1);
      combineState.images.splice(idx, 0, moved);
      dragSrcIdx = null;
      renderCombinePreview();
    });

    strip.appendChild(card);
  });

  previewSection.style.display = count > 0  ? "" : "none";
  optionsSection.style.display = count >= 2 ? "" : "none";
  document.getElementById("combine-result-section")!.style.display = "none";
  // Clear live preview when image list changes
  clearLivePreview();
}

function showCombineResult(result: CombineResult) {
  clearLivePreview();
  const img     = document.getElementById("combine-result-img") as HTMLImageElement;
  const meta    = document.getElementById("combine-result-meta")!;
  const section = document.getElementById("combine-result-section")!;
  img.src          = `${pathToSrc(result.output_path)}?t=${Date.now()}`;
  meta.textContent = `${result.width}×${result.height} · ${formatBytes(result.size_bytes)} · ${result.output_path}`;
  section.style.display = "";
  section.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function addCombineFilePaths(paths: string[]) {
  for (const path of paths) {
    if (combineState.images.some((i) => i.path === path)) continue;
    try {
      const info = await invoke<ImageInfo>("get_image_info", { path });
      combineState.images.push(info);
    } catch (err) {
      flash(`Could not load ${path}: ${err}`, "error");
    }
  }
  renderCombinePreview();
}

// =============================================================================
//  LIVE PREVIEW
// =============================================================================

function clearLivePreview() {
  const wrap = document.getElementById("combine-live-preview-wrap")!;
  wrap.style.display = "none";
  const img = document.getElementById("combine-live-preview-img") as HTMLImageElement;
  img.src = "";
}

async function runLivePreview() {
  if (combineState.images.length < 2) return;

  document.getElementById("combine-result-section")!.style.display = "none";
  combineState.resultPath = null;

  const btn  = document.getElementById("combine-preview-btn") as HTMLButtonElement;
  const wrap = document.getElementById("combine-live-preview-wrap")!;
  const img  = document.getElementById("combine-live-preview-img") as HTMLImageElement;
  const meta = document.getElementById("combine-live-preview-meta")!;

  setLoading(btn, true);
  try {
    const result = await invoke<PreviewResult>("preview_combine", {
      paths:           combineState.images.map((i) => i.path),
      direction:       combineState.direction,
      gap:             combineState.gap,
      canvasColor:     combineState.canvasColor,
      borderEnabled:   combineState.borderEnabled,
      borderThickness: combineState.borderThickness,
      borderColor:     combineState.borderColor,
      outputFormat:    combineState.outputFormat,
    });
    img.src = `${pathToSrc(result.temp_path)}?t=${Date.now()}`;
    meta.textContent = `Preview · ${result.width}×${result.height}`;
    wrap.style.display = "";
  } catch (err) {
    flash(`Preview failed: ${err}`, "error");
  } finally {
    setLoading(btn, false);
  }
}

// =============================================================================
//  COMPRESS HELPERS
// =============================================================================

function applyCompressInfo(info: ImageInfo) {
  compressState.image = info;

  const dotIdx = info.name.lastIndexOf(".");
  const ext    = dotIdx >= 0 ? info.name.slice(dotIdx + 1).toLowerCase() : "jpg";
  const base   = dotIdx >= 0 ? info.name.slice(0, dotIdx) : info.name;

  (document.getElementById("compress-output-name") as HTMLInputElement).value = `${base}_compressed`;
  document.getElementById("compress-ext")!.textContent      = `.${ext}`;
  (document.getElementById("compress-thumb") as HTMLImageElement).src = pathToSrc(info.path);
  document.getElementById("compress-name")!.textContent     = info.name;
  document.getElementById("compress-dims")!.textContent     = `${info.width} × ${info.height} px`;
  document.getElementById("compress-filesize")!.textContent = formatBytes(info.size_bytes);

  document.getElementById("compress-loaded")!.style.display          = "flex";
  document.getElementById("compress-options-section")!.style.display  = "";
  document.getElementById("compress-result-section")!.style.display   = "none";

  updateSizeEstimate();
}

function updateSizeEstimate() {
  const img = compressState.image;
  if (!img) return;
  const pct = compressState.percentage / 100;
  document.getElementById("est-orig-dims")!.textContent = `${img.width} × ${img.height} px`;
  document.getElementById("est-new-dims")!.textContent  =
    `${Math.round(img.width * pct)} × ${Math.round(img.height * pct)} px`;
  document.getElementById("est-filesize")!.textContent  = `~${formatBytes(img.size_bytes * pct * pct)}`;
}

function showCompressResult(result: CompressResult) {
  const img     = document.getElementById("compress-result-img") as HTMLImageElement;
  const meta    = document.getElementById("compress-result-meta")!;
  const section = document.getElementById("compress-result-section")!;
  img.src          = `${pathToSrc(result.output_path)}?t=${Date.now()}`;
  meta.textContent = `${result.width}×${result.height} · ${formatBytes(result.size_bytes)} · ${result.output_path}`;
  section.style.display = "";
  section.scrollIntoView({ behavior: "smooth", block: "start" });
}

// =============================================================================
//  INIT  — called by shell.ts after the DOM is ready
// =============================================================================

export async function initImageCCR(): Promise<void> {

  // ── Tab switching ──
  document.querySelectorAll<HTMLButtonElement>(".tab-nav .tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-nav .tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(`tab-${btn.dataset.tab}`)!.classList.add("active");
    });
  });

  // ── Combine: browse ──
  document.getElementById("combine-browse-btn")!.addEventListener("click", async () => {
    const selected = await open({
      multiple: true,
      filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "gif", "webp"] }],
    });
    if (!selected) return;
    await addCombineFilePaths(Array.isArray(selected) ? selected : [selected]);
  });

  // ── Combine: clear all ──
  document.getElementById("combine-clear")!.addEventListener("click", () => {
    combineState.images     = [];
    combineState.resultPath = null;
    renderCombinePreview();
  });

  // ── Combine: direction buttons ──
  document.querySelectorAll<HTMLButtonElement>(".direction-grid .dir-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".direction-grid .dir-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      combineState.direction = btn.dataset.dir!;
    });
  });

  // ── Combine: canvas color ──
  const canvasColorInput = document.getElementById("combine-canvas-color") as HTMLInputElement;
  const canvasColorHex   = document.getElementById("combine-canvas-color-hex")!;
  function applyCanvasColor(val: string) {
    combineState.canvasColor       = val;
    canvasColorHex.textContent     = val.toUpperCase();
    // Mirror to border color if user hasn't manually changed it yet
    if (!combineState.borderColorUserSet) {
      combineState.borderColor = val;
      const bci = document.getElementById("combine-border-color") as HTMLInputElement;
      const bch = document.getElementById("combine-border-color-hex")!;
      bci.value           = val;
      bch.textContent     = val.toUpperCase();
    }
  }
  canvasColorInput.addEventListener("input", (e) => {
    applyCanvasColor((e.target as HTMLInputElement).value);
  });
  makeHexEditable(canvasColorHex as HTMLElement, canvasColorInput, applyCanvasColor);

  // ── Combine: gap ──
  document.getElementById("combine-gap")!.addEventListener("input", (e) => {
    combineState.gap = parseInt((e.target as HTMLInputElement).value) || 0;
  });

  // ── Combine: border toggle ──
  const borderToggle = document.getElementById("combine-border-enabled") as HTMLInputElement;
  const borderFields = document.getElementById("combine-border-fields")!;
  borderToggle.addEventListener("change", () => {
    combineState.borderEnabled = borderToggle.checked;
    borderFields.style.display = borderToggle.checked ? "" : "none";
  });

  // ── Combine: border thickness ──
  document.getElementById("combine-border-thickness")!.addEventListener("input", (e) => {
    combineState.borderThickness = parseInt((e.target as HTMLInputElement).value) || 0;
  });

  // ── Combine: border color ──
  const borderColorInput = document.getElementById("combine-border-color") as HTMLInputElement;
  const borderColorHex   = document.getElementById("combine-border-color-hex")!;
  function applyBorderColor(val: string) {
    combineState.borderColor        = val;
    combineState.borderColorUserSet = true;
    borderColorHex.textContent      = val.toUpperCase();
  }
  borderColorInput.addEventListener("input", (e) => {
    applyBorderColor((e.target as HTMLInputElement).value);
  });
  makeHexEditable(borderColorHex as HTMLElement, borderColorInput, applyBorderColor);

  // ── Combine: output format ──
  document.querySelectorAll<HTMLButtonElement>(".fmt-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".fmt-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      combineState.outputFormat = btn.dataset.fmt as "jpg" | "png";
      document.getElementById("combine-output-ext")!.textContent = `.${combineState.outputFormat}`;
    });
  });

  // ── Combine: output folder ──
  document.getElementById("combine-pick-folder")!.addEventListener("click", async () => {
    const selected = await open({ directory: true, multiple: false });
    if (selected && typeof selected === "string") {
      combineState.outputFolder = selected;
      (document.getElementById("combine-save-path") as HTMLInputElement).value = selected;
    }
  });

  // ── Combine: live preview ──
  document.getElementById("combine-preview-btn")!.addEventListener("click", async () => {
    await runLivePreview();
  });

  // ── Combine: run ──
  document.getElementById("combine-run")!.addEventListener("click", async () => {
    if (combineState.images.length < 2) {
      flash("Need at least 2 images to combine", "error");
      return;
    }
    const btn = document.getElementById("combine-run") as HTMLButtonElement;
    setLoading(btn, true);
    const outputName =
      (document.getElementById("combine-output-name") as HTMLInputElement)
        .value.trim() || "combined_image";
    try {
      const result = await invoke<CombineResult>("combine_images", {
        paths:           combineState.images.map((i) => i.path),
        direction:       combineState.direction,
        outputFolder:    combineState.outputFolder ?? null,
        outputName,
        gap:             combineState.gap,
        canvasColor:     combineState.canvasColor,
        borderEnabled:   combineState.borderEnabled,
        borderThickness: combineState.borderThickness,
        borderColor:     combineState.borderColor,
        outputFormat:    combineState.outputFormat,
      });
      combineState.resultPath = result.output_path;
      showCombineResult(result);
      flash("Images combined successfully!", "success");
    } catch (err) {
      flash(`Combine failed: ${err}`, "error");
    } finally {
      setLoading(btn, false);
    }
  });

  // ── Combine: open result in explorer ──
  document.getElementById("combine-result-open")!.addEventListener("click", async () => {
    if (combineState.resultPath) {
      await invoke("show_in_explorer", { path: combineState.resultPath });
    }
  });

  // ── Compress: browse ──
  document.getElementById("compress-browse-btn")!.addEventListener("click", async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "gif", "webp"] }],
    });
    if (!selected) return;
    try {
      const path = Array.isArray(selected) ? selected[0] : selected;
      const info = await invoke<ImageInfo>("get_image_info", { path });
      applyCompressInfo(info);
    } catch (err) {
      flash(`Could not load file: ${err}`, "error");
    }
  });

  // ── Compress: clear ──
  document.getElementById("compress-clear")!.addEventListener("click", () => {
    compressState.image      = null;
    compressState.resultPath = null;
    document.getElementById("compress-loaded")!.style.display          = "none";
    document.getElementById("compress-options-section")!.style.display  = "none";
    document.getElementById("compress-result-section")!.style.display   = "none";
  });

  // ── Compress: slider ──
  const slider = document.getElementById("compress-slider") as HTMLInputElement;
  slider.addEventListener("input", () => {
    compressState.percentage = parseInt(slider.value);
    document.getElementById("slider-pct-label")!.textContent = `${compressState.percentage}%`;
    slider.style.setProperty("--pct", `${((compressState.percentage - 1) / 98) * 100}%`);
    updateSizeEstimate();
  });
  slider.style.setProperty("--pct", `${((80 - 1) / 98) * 100}%`);

  // ── Compress: output folder ──
  document.getElementById("compress-pick-folder")!.addEventListener("click", async () => {
    const selected = await open({ directory: true, multiple: false });
    if (selected && typeof selected === "string") {
      compressState.outputFolder = selected;
      (document.getElementById("compress-save-path") as HTMLInputElement).value = selected;
    }
  });

  // ── Compress: run ──
  document.getElementById("compress-run")!.addEventListener("click", async () => {
    if (!compressState.image) {
      flash("No image selected", "error");
      return;
    }
    const btn = document.getElementById("compress-run") as HTMLButtonElement;
    setLoading(btn, true);
    const outputName =
      (document.getElementById("compress-output-name") as HTMLInputElement)
        .value.trim() ||
      `${compressState.image.name.replace(/\.[^.]+$/, "")}_compressed`;
    try {
      const result = await invoke<CompressResult>("compress_image", {
        path:         compressState.image.path,
        percentage:   compressState.percentage,
        outputFolder: compressState.outputFolder ?? null,
        outputName,
      });
      compressState.resultPath = result.output_path;
      showCompressResult(result);
      flash("Image compressed successfully!", "success");
    } catch (err) {
      flash(`Compress failed: ${err}`, "error");
    } finally {
      setLoading(btn, false);
    }
  });

  // ── Compress: open result in explorer ──
  document.getElementById("compress-result-open")!.addEventListener("click", async () => {
    if (compressState.resultPath) {
      await invoke("show_in_explorer", { path: compressState.resultPath });
    }
  });


  // =============================================================================
  //  RESIZE
  // =============================================================================

  let resizeRunning    = false;
  let resizeUnlisteners: Array<() => void> = [];

  // ── Resize info modal ──
  const resizeInfoBackdrop = document.getElementById("resizeInfoBackdrop")!;
  const resizeInfoModal    = new Modal(resizeInfoBackdrop);
  document.getElementById("resize-info-btn")!.addEventListener("click", () => resizeInfoModal.open());
  document.getElementById("resizeInfoClose")!.addEventListener("click", () => resizeInfoModal.close());

  function showResizeCanvas(visible: boolean) {
    document.getElementById("resize-canvas-fields")!.style.display  = visible ? "" : "none";
    document.getElementById("resize-gravity-group")!.style.display  = visible ? "" : "none";
    document.getElementById("resize-bgcolor-group")!.style.display  = visible ? "" : "none";
  }

  function setResizeRunning(running: boolean) {
    resizeRunning = running;
    (document.getElementById("resize-run") as HTMLButtonElement).disabled        = running;
    (document.getElementById("resize-cancel-btn") as HTMLButtonElement).disabled = !running;
  }

  function resetResizeProgress() {
    document.getElementById("resize-progress-bar")!.style.width   = "0%";
    document.getElementById("resize-progress-file")!.textContent  = "";
    document.getElementById("resize-progress-count")!.textContent = "";
  }

  async function scanResizeFolder(folder: string) {
    if (!folder.trim()) return;
    resizeState.sourceFolder = folder.trim();
    (document.getElementById("resize-source-path") as HTMLInputElement).value = resizeState.sourceFolder;
    try {
      const stats = await invoke<ResizeFolderStats>("get_resize_folder_stats", { folder: resizeState.sourceFolder });
      document.getElementById("resize-stat-count")!.textContent = String(stats.count);
      document.getElementById("resize-stat-max-w")!.textContent = `${stats.max_w}px`;
      document.getElementById("resize-stat-min-w")!.textContent = `${stats.min_w}px`;
      document.getElementById("resize-stat-max-h")!.textContent = `${stats.max_h}px`;
      document.getElementById("resize-stat-min-h")!.textContent = `${stats.min_h}px`;
      document.getElementById("resize-folder-stats")!.style.display    = "";
      document.getElementById("resize-options-section")!.style.display  = stats.count > 0 ? "" : "none";
      document.getElementById("resize-result-inline")!.style.display   = "none";
      resetResizeProgress();
      document.getElementById("resize-progress-section")!.style.display = "none";
      if (stats.count === 0) flash("No supported images found in that folder.", "error");
    } catch (err) {
      flash(`Could not read folder: ${err}`, "error");
    }
  }

  // ── Resize: browse source folder ──
  document.getElementById("resize-browse-source")!.addEventListener("click", async () => {
    const selected = await open({ directory: true, multiple: false });
    if (!selected || typeof selected !== "string") return;
    await scanResizeFolder(selected);
  });

  // ── Resize: manual path — scan on Enter or blur ──
  const resizeSourceInput = document.getElementById("resize-source-path") as HTMLInputElement;
  resizeSourceInput.addEventListener("keydown", async (e) => {
    if (e.key === "Enter") await scanResizeFolder(resizeSourceInput.value);
  });
  resizeSourceInput.addEventListener("blur", async () => {
    if (resizeSourceInput.value.trim() && resizeSourceInput.value.trim() !== resizeState.sourceFolder) {
      await scanResizeFolder(resizeSourceInput.value);
    }
  });

  // ── Resize: scan button ──
  document.getElementById("resize-scan-source")!.addEventListener("click", async () => {
    await scanResizeFolder(resizeSourceInput.value);
  });

  // ── Resize: target dimensions ──
  document.getElementById("resize-target-w")!.addEventListener("input", (e) => {
    const v = parseInt((e.target as HTMLInputElement).value);
    resizeState.targetW = isNaN(v) ? null : v;
  });
  document.getElementById("resize-target-h")!.addEventListener("input", (e) => {
    const v = parseInt((e.target as HTMLInputElement).value);
    resizeState.targetH = isNaN(v) ? null : v;
  });

  // ── Resize: canvas toggle ──
  const canvasToggle = document.getElementById("resize-canvas-manual") as HTMLInputElement;
  canvasToggle.addEventListener("change", () => {
    resizeState.canvasManual = canvasToggle.checked;
    showResizeCanvas(canvasToggle.checked);
  });

  // ── Resize: canvas dimensions ──
  document.getElementById("resize-canvas-w")!.addEventListener("input", (e) => {
    const v = parseInt((e.target as HTMLInputElement).value);
    resizeState.canvasW = isNaN(v) ? null : v;
  });
  document.getElementById("resize-canvas-h")!.addEventListener("input", (e) => {
    const v = parseInt((e.target as HTMLInputElement).value);
    resizeState.canvasH = isNaN(v) ? null : v;
  });

  // ── Resize: gravity grid ──
  document.querySelectorAll<HTMLButtonElement>(".gravity-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".gravity-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      resizeState.gravity = btn.dataset.gravity!;
    });
  });

  // ── Resize: background color ──
  const resizeBgInput = document.getElementById("resize-bg-color") as HTMLInputElement;
  const resizeBgHex   = document.getElementById("resize-bg-color-hex")!;
  function applyResizeBgColor(val: string) {
    resizeState.bgColor     = val;
    resizeBgHex.textContent = val.toUpperCase();
  }
  resizeBgInput.addEventListener("input", (e) => {
    applyResizeBgColor((e.target as HTMLInputElement).value);
  });
  makeHexEditable(resizeBgHex as HTMLElement, resizeBgInput, applyResizeBgColor);

  // ── Resize: output format ──
  document.querySelectorAll<HTMLButtonElement>(".resize-fmt-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".resize-fmt-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      resizeState.outputFormat = btn.dataset.fmt as "jpg" | "png";
    });
  });

  // ── Resize: output folder ──
  document.getElementById("resize-pick-output")!.addEventListener("click", async () => {
    const selected = await open({ directory: true, multiple: false });
    if (selected && typeof selected === "string") {
      resizeState.outputFolder = selected;
      (document.getElementById("resize-output-path") as HTMLInputElement).value = selected;
    }
  });

  // ── Resize: event listeners (attached fresh each run) ──
  async function attachResizeListeners() {
    const { listen } = await import("@tauri-apps/api/event");

    const unlistenProgress = await listen<{ current_file: string; done: number; total: number }>(
      "resize-progress",
      ({ payload }) => {
        const pct = payload.total > 0 ? (payload.done / payload.total) * 100 : 0;
        document.getElementById("resize-progress-bar")!.style.width   = `${pct.toFixed(1)}%`;
        document.getElementById("resize-progress-file")!.textContent  = payload.current_file;
        document.getElementById("resize-progress-count")!.textContent = `${payload.done} / ${payload.total}`;
      }
    );

    const unlistenComplete = await listen<{ success: boolean; message: string; output_folder: string; count: number }>(
      "resize-complete",
      ({ payload }) => {
        setResizeRunning(false);
        resizeUnlisteners.forEach(u => u());
        resizeUnlisteners = [];

        if (payload.success) {
          document.getElementById("resize-progress-bar")!.style.width = "100%";
          document.getElementById("resize-progress-count")!.textContent = `${payload.count} / ${payload.count}`;
          resizeState.lastResultFolder = payload.output_folder;
          document.getElementById("resize-result-text")!.textContent =
            `${payload.count} image${payload.count !== 1 ? "s" : ""} saved to ${payload.output_folder}`;
          document.getElementById("resize-result-inline")!.style.display = "";
          flash(`${payload.count} images resized successfully!`, "success");
        } else {
          document.getElementById("resize-progress-file")!.textContent = "";
          flash(`Resize failed: ${payload.message}`, "error");
        }
      }
    );

    resizeUnlisteners.push(unlistenProgress, unlistenComplete);
  }

  // ── Resize: cancel ──
  document.getElementById("resize-cancel-btn")!.addEventListener("click", async () => {
    await invoke("cancel_resize");
  });

  // ── Resize: run ──
  document.getElementById("resize-run")!.addEventListener("click", async () => {
    if (resizeRunning) return;
    if (!resizeState.sourceFolder) {
      flash("No source folder selected.", "error");
      return;
    }
    const hasResize = resizeState.targetW !== null || resizeState.targetH !== null;
    const hasCanvas = resizeState.canvasManual && (resizeState.canvasW !== null || resizeState.canvasH !== null);
    if (!hasResize && !hasCanvas) {
      flash("Set a resize target, a canvas size, or both.", "error");
      return;
    }
    if (resizeState.canvasManual && (resizeState.canvasW === null || resizeState.canvasH === null)) {
      flash("Canvas size requires both width and height.", "error");
      return;
    }

    document.getElementById("resize-result-inline")!.style.display    = "none";
    document.getElementById("resize-progress-section")!.style.display  = "";
    resetResizeProgress();
    setResizeRunning(true);

    await attachResizeListeners();

    try {
      await invoke("resize_images", {
        sourceFolder:  resizeState.sourceFolder,
        outputFolder:  resizeState.outputFolder ?? null,
        targetW:       resizeState.targetW ?? null,
        targetH:       resizeState.targetH ?? null,
        canvasW:       resizeState.canvasManual ? (resizeState.canvasW ?? null) : null,
        canvasH:       resizeState.canvasManual ? (resizeState.canvasH ?? null) : null,
        gravity:       resizeState.gravity,
        bgColor:       resizeState.bgColor,
        outputFormat:  resizeState.outputFormat,
      });
    } catch (err) {
      setResizeRunning(false);
      resizeUnlisteners.forEach(u => u());
      resizeUnlisteners = [];
      flash(`Resize error: ${err}`, "error");
    }
  });

  // ── Resize: open result in explorer ──
  document.getElementById("resize-result-open")!.addEventListener("click", async () => {
    if (resizeState.lastResultFolder) {
      await invoke("show_in_explorer", { path: resizeState.lastResultFolder });
    }
  });
}
