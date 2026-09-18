/* =============================================================================
   WHITEBOARD: an open surface to type and scribble on, that can feed Kanban
   -----------------------------------------------------------------------------
   For the moment in a meeting when something needs writing down and filling in
   a Kanban card would take too long. Click and type, or switch to Draw and
   scribble, and sort it out later. Later is the Send to Kanban button: every
   text box becomes one bare card, and the board can drop what it sent.

   ONE BOARD, ONE FILE. There is no naming, saving or loading. Everything on the
   board is written to whiteboard/whiteboard.json a moment after it changes, and
   that file is snapshotted once an hour like any record you would miss (see
   WHITEBOARD_GROUP in lib.rs). Clear is one click, so it confirms, and Undo
   reaches back over it for the rest of the session.

   -----------------------------------------------------------------------------
   TWO LAYERS, AND WHY TEXT IS NEVER PAINTED

   Ink is drawn on a canvas. Typed text is real DOM text boxes floating over it.
   That split is the whole Kanban feature: text baked into pixels is gone as
   text forever, and there would be nothing left to send.

   The canvas is only the size of the window onto the board, not the board. A
   board this big as one canvas is hundreds of megabytes of pixels, so the
   strokes are kept as points and redrawn for whatever is in view whenever the
   view moves. The text boxes live inside the scrolling surface and scroll
   natively.

   -----------------------------------------------------------------------------
   COLORS COME FROM THE THEME

   The six pens are the theme's text color and its first five chart colors,
   stored by slot rather than by value. Named colors would lie (Christmas's
   "red" slot is green), and a fixed hex would vanish on a theme whose surface
   happens to match it. A theme change redraws the ink in the new palette.

   Rust commands used: save_tool_file / load_tool_file (toolId "whiteboard",
   kind "data"), through core/tool-store.ts, and list_tool_backups /
   read_tool_backup through core/tool-backups.ts.
============================================================================= */

import { devError } from "../core/dev-log";
import { newId } from "../core/ids";
import {
  isToolFileBlocked,
  loadToolJson,
  saveToolJson,
  unblockAfterReplacement,
} from "../core/tool-store";
import { formatBackupName, readToolBackup, renderToolBackups } from "../core/tool-backups";
import { Modal } from "../modal/modal";
import { attachMenu, isTextEntry, type MenuItem } from "../menu/menu";
import { appConfirm, backgroundMenu, flash, navigateToTool } from "../core/shell";
import {
  MAX_TITLE_LEN,
  addCardsFromElsewhere,
  kanbanTargets,
  type IncomingCard,
  type KanbanTarget,
} from "./kanban";

/* =============================================================================
   TYPES AND LIMITS
============================================================================= */

type Mode = "type" | "draw" | "erase";

/** A pen, by its slot in the theme rather than by value. See the header. */
type InkId = "ink" | "c1" | "c2" | "c3" | "c4" | "c5";

type SizeId = "fine" | "medium" | "bold";

interface Stroke {
  id: string;
  ink: InkId;
  size: SizeId;
  /** Rubs out ink under it instead of laying any down. */
  erase: boolean;
  /** Board coordinates as flat x,y pairs. */
  pts: number[];
}

interface TextNote {
  id: string;
  x: number;
  y: number;
  ink: InkId;
  text: string;
}

interface SendTarget {
  boardId: string;
  columnId: string;
}

interface WhiteboardFile {
  version: 1;
  strokes: Stroke[];
  texts: TextNote[];
  mode: Mode;
  ink: InkId;
  size: SizeId;
  scroll: { x: number; y: number };
  /** Where Send to Kanban last sent to, offered first next time. */
  target: SendTarget | null;
}

/** What Undo puts back. Strokes are never edited once drawn, so holding the
 *  same objects is safe and costs one pointer each; text notes are edited in
 *  place, so they are copied. */
interface Snapshot {
  strokes: Stroke[];
  texts: TextNote[];
}

/* The size of the board. "Very large" was the brief: several screens in each
   direction, with the canvas never growing past the window onto it. */
const SURFACE_W = 12000;
const SURFACE_H = 8000;

const INKS: readonly { id: InkId; cssVar: string; label: string }[] = [
  { id: "ink", cssVar: "--color-text", label: "Ink (the theme's text color)" },
  { id: "c1", cssVar: "--color-chart-1", label: "Theme color 1" },
  { id: "c2", cssVar: "--color-chart-2", label: "Theme color 2" },
  { id: "c3", cssVar: "--color-chart-3", label: "Theme color 3" },
  { id: "c4", cssVar: "--color-chart-4", label: "Theme color 4" },
  { id: "c5", cssVar: "--color-chart-5", label: "Theme color 5" },
];

/** Pen widths in board pixels. The eraser is wider than the pen at every size,
 *  because rubbing out a fine line with a fine eraser takes several passes. */
const PEN_WIDTH: Record<SizeId, number> = { fine: 2, medium: 4, bold: 8 };
const ERASER_WIDTH: Record<SizeId, number> = { fine: 10, medium: 20, bold: 40 };

const MODES: readonly Mode[] = ["type", "draw", "erase"];
const SIZES: readonly SizeId[] = ["fine", "medium", "bold"];

/* Ceilings, so the file stays one a person could open and the board stays one
   that redraws without stuttering. Erasing ADDS ink (it is a stroke that rubs
   out), so the ink limit counts eraser strokes too. */
const MAX_TOTAL_POINTS = 500_000;
const MAX_POINTS_PER_STROKE = 20_000;
const MAX_TEXTS = 2000;
const MAX_TEXT_LEN = 4000;
const MAX_UNDO = 100;

/** Points closer than this to the last one add nothing a mouse can draw. */
const MIN_POINT_GAP = 1.5;

/** How far a text box has to travel before a press on it is a drag. Anything
 *  shorter is a click, which starts editing it. */
const DRAG_THRESHOLD = 4;

/** Gap between a text box and the one Enter opens below it. */
const NEXT_LINE_GAP = 4;

const SAVE_DEBOUNCE_MS = 500;

/** Offset from the click to a new box's top-left corner, so the caret lands
 *  under the pointer rather than below and to the right of it. */
const NEW_BOX_NUDGE_X = 5;
const NEW_BOX_NUDGE_Y = 13;

/* =============================================================================
   STATE
============================================================================= */

let strokes: Stroke[] = [];
let texts: TextNote[] = [];
let mode: Mode = "type";
let ink: InkId = "ink";
let size: SizeId = "medium";
let target: SendTarget | null = null;

let undoStack: Snapshot[] = [];
let redoStack: Snapshot[] = [];

/** False until the file has been read. Nothing is drawn, taken or written
 *  before then, so an early click cannot save an empty board over a full one. */
let loaded = false;
/** The file would not read. The store refuses every save to it this session;
 *  this flag is what keeps a debounced save from saying so every half second. */
let blocked = false;

let dirty = false;
/** The scroll position changed. Written with the next save, or on the way out,
 *  but never a reason to write on its own: scrolling is not an edit. */
let scrollDirty = false;
let saveTimer: number | null = null;
let saveChain: Promise<boolean> = Promise.resolve(true);
/** One error toast per run of failed saves, not one every half second. */
let saveErrorShown = false;

/** Where the view is on the board, kept here rather than read off the
 *  scroller. A scroller that is hidden (another tool is open) reports 0,0 and
 *  forgets its position, so reading it at save time or on the way back in
 *  would put you at the top-left corner every time you left the tool. */
let viewScroll = { x: 0, y: 0 };
/** What the file last held for it, so scrolling back to where you were is not
 *  a reason to write. */
let writtenScroll = { x: 0, y: 0 };

/** The position to put the view at once the board is on screen. Scrolling a
 *  hidden element does nothing, so a restored position waits for the tool. */
let pendingScroll: { x: number; y: number } | null = null;

/** The box being typed in, and the board as it stood before the edit began,
 *  which is what Undo goes back to if the edit changed anything. */
let editingId: string | null = null;
let editStart: Snapshot | null = null;

/** The stroke under the mouse right now, and what the board was before it. */
let liveStroke: Stroke | null = null;
let livePre: Snapshot | null = null;

let boxDrag: {
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  moved: boolean;
  pre: Snapshot;
} | null = null;

let pan: { pointerId: number; x: number; y: number; left: number; top: number } | null = null;

/** Where the last right-click on the board landed, for "Type Here". */
let menuPoint: { x: number; y: number } | null = null;

const noteEls = new Map<string, HTMLElement>();
const inkColors = new Map<InkId, string>();
const strokeBounds = new WeakMap<Stroke, [number, number, number, number]>();
let totalPoints = 0;
let redrawQueued = false;

/* ── Elements, set in initWhiteboard ── */
let stage: HTMLElement;
let canvas: HTMLCanvasElement;
let ctx: CanvasRenderingContext2D;
let scroller: HTMLElement;
let surface: HTMLElement;
let emptyHint: HTMLElement;
let undoBtn: HTMLButtonElement;
let redoBtn: HTMLButtonElement;
let sendOpenBtn: HTMLButtonElement;
let clearBtn: HTMLButtonElement;
let noticeWrap: HTMLElement;
let notice: HTMLElement;

/* =============================================================================
   LOADING AND NORMALIZING
   -----------------------------------------------------------------------------
   Everything from disk is coerced into range or dropped. A stroke with an odd
   number of coordinates or a note off the edge of the board is worse than a
   missing one: the first would draw garbage and the second could never be
   reached to delete.
============================================================================= */

function isInk(v: unknown): v is InkId {
  return INKS.some((i) => i.id === v);
}

function clampX(v: number): number {
  return Math.min(Math.max(v, 0), SURFACE_W);
}

function clampY(v: number): number {
  return Math.min(Math.max(v, 0), SURFACE_H);
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function normalizeStroke(raw: unknown): Stroke | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.pts) || r.pts.length < 2) return null;
  const pts: number[] = [];
  const limit = Math.min(r.pts.length - (r.pts.length % 2), MAX_POINTS_PER_STROKE * 2);
  for (let i = 0; i < limit; i += 2) {
    const x = Number(r.pts[i]);
    const y = Number(r.pts[i + 1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    pts.push(round1(clampX(x)), round1(clampY(y)));
  }
  if (pts.length < 2) return null;
  return {
    id: typeof r.id === "string" && r.id ? r.id : newId(),
    ink: isInk(r.ink) ? r.ink : "ink",
    size: SIZES.includes(r.size as SizeId) ? (r.size as SizeId) : "medium",
    erase: r.erase === true,
    pts,
  };
}

function normalizeNote(raw: unknown): TextNote | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.text !== "string") return null;
  const text = r.text.slice(0, MAX_TEXT_LEN);
  if (!text.trim()) return null;
  const x = Number(r.x);
  const y = Number(r.y);
  return {
    id: typeof r.id === "string" && r.id ? r.id : newId(),
    x: Number.isFinite(x) ? clampX(x) : 0,
    y: Number.isFinite(y) ? clampY(y) : 0,
    ink: isInk(r.ink) ? r.ink : "ink",
    text,
  };
}

function normalizeFile(raw: unknown): WhiteboardFile | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  const outStrokes: Stroke[] = [];
  let points = 0;
  for (const s of Array.isArray(r.strokes) ? r.strokes : []) {
    const stroke = normalizeStroke(s);
    if (!stroke) continue;
    // Past the ink limit a hand-edited file is refused the rest, rather than
    // loaded into a board that can then take no more.
    if (points + stroke.pts.length / 2 > MAX_TOTAL_POINTS) break;
    points += stroke.pts.length / 2;
    outStrokes.push(stroke);
  }

  const outTexts: TextNote[] = [];
  for (const t of Array.isArray(r.texts) ? r.texts : []) {
    if (outTexts.length >= MAX_TEXTS) break;
    const note = normalizeNote(t);
    if (note) outTexts.push(note);
  }

  const scrollRaw = (r.scroll ?? {}) as Record<string, unknown>;
  const sx = Number(scrollRaw.x);
  const sy = Number(scrollRaw.y);

  let outTarget: SendTarget | null = null;
  const t = r.target as Record<string, unknown> | null | undefined;
  if (t && typeof t.boardId === "string" && typeof t.columnId === "string") {
    outTarget = { boardId: t.boardId, columnId: t.columnId };
  }

  return {
    version: 1,
    strokes: outStrokes,
    texts: outTexts,
    mode: MODES.includes(r.mode as Mode) ? (r.mode as Mode) : "type",
    ink: isInk(r.ink) ? r.ink : "ink",
    size: SIZES.includes(r.size as SizeId) ? (r.size as SizeId) : "medium",
    scroll: {
      x: Number.isFinite(sx) ? clampX(sx) : 0,
      y: Number.isFinite(sy) ? clampY(sy) : 0,
    },
    target: outTarget,
  };
}

/** Puts a file's contents on the board. Undo history is the caller's to keep
 *  or drop. */
function applyFile(file: WhiteboardFile): void {
  strokes = file.strokes;
  texts = file.texts;
  mode = file.mode;
  ink = file.ink;
  size = file.size;
  target = file.target;
  viewScroll = { ...file.scroll };
  writtenScroll = { ...file.scroll };
  pendingScroll = { ...file.scroll };
  recountPoints();
}

async function load(): Promise<void> {
  try {
    const parsed = normalizeFile(await loadToolJson<unknown>("whiteboard", "data"));
    if (parsed) {
      applyFile(parsed);
    } else {
      /* It parsed as JSON and is not a whiteboard. Treated as the unreadable
         file it is: the store only blocks a file it could not parse, and this
         one it could, so the block is this tool's to keep. */
      blocked = true;
      flash(
        "The Whiteboard's file is not in a shape this version understands. Nothing will be " +
          "saved over it this session. Close the app, then repair or move that file.",
        "error",
        12000,
      );
    }
  } catch (err) {
    // The store has already said so out loud and blocked the file.
    devError("[whiteboard] load failed", err);
    blocked = true;
  }
  if (!blocked) blocked = isToolFileBlocked("whiteboard", "data");
  loaded = true;
  rebuildTexts();
  resolveInkColors();
  requestRedraw();
  applyPendingScroll();
  updateChrome();
}

/* =============================================================================
   SAVING
============================================================================= */

function buildFile(): WhiteboardFile {
  return {
    version: 1,
    strokes,
    texts,
    mode,
    ink,
    size,
    scroll: { ...viewScroll },
    target,
  };
}

function markDirty(): void {
  dirty = true;
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    void saveNow();
  }, SAVE_DEBOUNCE_MS);
}

/** Queued behind any save already in flight, so two writes never overlap. */
function saveNow(): Promise<boolean> {
  saveChain = saveChain.catch(() => false).then(writeFile);
  return saveChain;
}

/** Whether the board on screen is now the board on disk. */
async function writeFile(): Promise<boolean> {
  if (!loaded || blocked) return false;
  const moved = viewScroll.x !== writtenScroll.x || viewScroll.y !== writtenScroll.y;
  if (!dirty && !(scrollDirty && moved)) return true;
  // Taken before the write, so an edit made while it is in flight marks itself
  // dirty again rather than being cleared along with the one landing.
  dirty = false;
  scrollDirty = false;
  const file = buildFile();
  try {
    await saveToolJson("whiteboard", "data", file);
    writtenScroll = { ...file.scroll };
    saveErrorShown = false;
    return true;
  } catch (err) {
    dirty = true;
    devError("[whiteboard] save failed", err);
    if (!saveErrorShown) {
      saveErrorShown = true;
      flash(`Couldn't save the Whiteboard: ${String(err)}`, "error", 8000);
    }
    return false;
  }
}

/** Writes anything waiting NOW rather than after the debounce. */
function flushSave(): Promise<boolean> {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  return saveNow();
}

/* =============================================================================
   UNDO
   -----------------------------------------------------------------------------
   Whole-board snapshots rather than a list of inverse operations. The board is
   small in the ways that matter (strokes are shared, not copied), and one kind
   of step means Undo cannot disagree with whatever it is undoing: a stroke, a
   moved box, an edit, a Clear, a Send and Clear, a restore.

   Session only. It survives leaving the tool and coming back, not closing the
   app; the hourly snapshots are what reach further back than that.
============================================================================= */

function snapshot(): Snapshot {
  return { strokes: strokes.slice(), texts: texts.map((t) => ({ ...t })) };
}

function pushUndo(pre: Snapshot): void {
  undoStack.push(pre);
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack = [];
}

/** Records the board as it is now as the state Undo returns to. Call BEFORE
 *  changing anything. */
function checkpoint(): void {
  pushUndo(snapshot());
}

function restoreSnapshot(snap: Snapshot): void {
  strokes = snap.strokes.slice();
  texts = snap.texts.map((t) => ({ ...t }));
  recountPoints();
  rebuildTexts();
  requestRedraw();
  markDirty();
  updateChrome();
}

function undo(): void {
  endEditing();
  const snap = undoStack.pop();
  if (!snap) return;
  redoStack.push(snapshot());
  restoreSnapshot(snap);
}

function redo(): void {
  endEditing();
  const snap = redoStack.pop();
  if (!snap) return;
  undoStack.push(snapshot());
  restoreSnapshot(snap);
}

/** Two snapshots hold the same text notes. Strokes are compared by identity,
 *  since a stroke is never changed once drawn. */
function sameBoard(a: Snapshot, b: Snapshot): boolean {
  if (a.strokes.length !== b.strokes.length) return false;
  if (a.strokes.some((s, i) => s !== b.strokes[i])) return false;
  return JSON.stringify(a.texts) === JSON.stringify(b.texts);
}

/* =============================================================================
   DRAWING
============================================================================= */

function recountPoints(): void {
  totalPoints = strokes.reduce((n, s) => n + s.pts.length / 2, 0);
}

/** Reads the six pens out of the live theme. Called at load, on every theme
 *  change, and on entry, since a custom palette can change under the tool. */
function resolveInkColors(): void {
  const style = getComputedStyle(document.documentElement);
  for (const i of INKS) {
    inkColors.set(i.id, style.getPropertyValue(i.cssVar).trim() || "#888888");
  }
}

function strokeWidth(s: Stroke): number {
  return s.erase ? ERASER_WIDTH[s.size] : PEN_WIDTH[s.size];
}

function boundsOf(s: Stroke): [number, number, number, number] {
  const cached = strokeBounds.get(s);
  if (cached) return cached;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < s.pts.length; i += 2) {
    minX = Math.min(minX, s.pts[i]);
    maxX = Math.max(maxX, s.pts[i]);
    minY = Math.min(minY, s.pts[i + 1]);
    maxY = Math.max(maxY, s.pts[i + 1]);
  }
  const pad = strokeWidth(s) / 2 + 1;
  const b: [number, number, number, number] = [minX - pad, minY - pad, maxX + pad, maxY + pad];
  strokeBounds.set(s, b);
  return b;
}

function styleFor(s: Stroke): void {
  ctx.globalCompositeOperation = s.erase ? "destination-out" : "source-over";
  ctx.strokeStyle = s.erase ? "#000000" : inkColors.get(s.ink) ?? "#888888";
  ctx.fillStyle = ctx.strokeStyle;
  ctx.lineWidth = strokeWidth(s);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
}

/** A finished stroke, smoothed through the midpoints between its samples so a
 *  mouse's straight hops read as a curve. */
function drawStroke(s: Stroke): void {
  styleFor(s);
  const p = s.pts;
  if (p.length === 2) {
    ctx.beginPath();
    ctx.arc(p[0], p[1], strokeWidth(s) / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(p[0], p[1]);
  for (let i = 2; i < p.length - 2; i += 2) {
    const mx = (p[i] + p[i + 2]) / 2;
    const my = (p[i + 1] + p[i + 3]) / 2;
    ctx.quadraticCurveTo(p[i], p[i + 1], mx, my);
  }
  ctx.lineTo(p[p.length - 2], p[p.length - 1]);
  ctx.stroke();
}

/** The canvas's transform: backing pixels to CSS pixels, then the board
 *  scrolled to where the view is. */
function applyViewTransform(): void {
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, -scroller.scrollLeft * dpr, -scroller.scrollTop * dpr);
}

function redraw(): void {
  redrawQueued = false;
  const w = scroller.clientWidth;
  const h = scroller.clientHeight;
  // Hidden (another tool is open). The resize observer asks again on return.
  if (w === 0 || h === 0) return;

  const dpr = window.devicePixelRatio || 1;
  const bw = Math.round(w * dpr);
  const bh = Math.round(h * dpr);
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  applyViewTransform();

  const left = scroller.scrollLeft;
  const top = scroller.scrollTop;
  const right = left + w;
  const bottom = top + h;
  for (const s of strokes) {
    const [x0, y0, x1, y1] = boundsOf(s);
    if (x1 < left || x0 > right || y1 < top || y0 > bottom) continue;
    drawStroke(s);
  }
  if (liveStroke) drawStroke(liveStroke);
}

function requestRedraw(): void {
  if (redrawQueued) return;
  redrawQueued = true;
  requestAnimationFrame(redraw);
}

/** The point under the pointer, in board coordinates. */
function boardPoint(e: { clientX: number; clientY: number }): { x: number; y: number } {
  const r = surface.getBoundingClientRect();
  return { x: clampX(e.clientX - r.left), y: clampY(e.clientY - r.top) };
}

function startStroke(e: PointerEvent): void {
  if (totalPoints >= MAX_TOTAL_POINTS) {
    flash(
      "The Whiteboard has reached its limit for ink. Clear it, or undo recent strokes, to make room.",
      "error",
    );
    return;
  }
  const { x, y } = boardPoint(e);
  livePre = snapshot();
  liveStroke = {
    id: newId(),
    ink,
    size,
    erase: mode === "erase",
    pts: [round1(x), round1(y)],
  };
  surface.setPointerCapture(e.pointerId);
  applyViewTransform();
  drawStroke(liveStroke);
}

function extendStroke(e: PointerEvent): void {
  const stroke = liveStroke;
  if (!stroke) return;
  /* The coalesced events are every sample the mouse reported since the last
     frame. Taking only the one the event carries draws a fast scribble as a
     handful of straight lines. */
  const samples = e.getCoalescedEvents?.() ?? [];
  const events = samples.length > 0 ? samples : [e];
  applyViewTransform();
  styleFor(stroke);
  for (const ev of events) {
    if (stroke.pts.length >= MAX_POINTS_PER_STROKE * 2) return;
    const { x, y } = boardPoint(ev);
    const lx = stroke.pts[stroke.pts.length - 2];
    const ly = stroke.pts[stroke.pts.length - 1];
    if (Math.hypot(x - lx, y - ly) < MIN_POINT_GAP) continue;
    stroke.pts.push(round1(x), round1(y));
    // Drawn as it comes, straight, and redrawn smoothed when the stroke ends.
    ctx.beginPath();
    ctx.moveTo(lx, ly);
    ctx.lineTo(x, y);
    ctx.stroke();
  }
}

function endStroke(): void {
  const stroke = liveStroke;
  const pre = livePre;
  liveStroke = null;
  livePre = null;
  if (!stroke || !pre) return;
  strokes.push(stroke);
  totalPoints += stroke.pts.length / 2;
  pushUndo(pre);
  requestRedraw();
  markDirty();
  updateChrome();
}

/* =============================================================================
   TEXT BOXES
   -----------------------------------------------------------------------------
   A box has no border until you are in it. It is editable only while it is
   being edited, which is what lets a press on an idle box be either a click
   (start editing there) or a drag (move it) without the browser deciding first.

   ENTER FINISHES THE LINE AND OPENS THE NEXT ONE BELOW IT. One box is one
   Kanban card, so rattling off tasks in a meeting should give one box per task
   without reaching for the mouse between them. Shift+Enter is a new line inside
   the same box, for a task that needs a second line.
============================================================================= */

function noteById(id: string | null): TextNote | null {
  if (!id) return null;
  return texts.find((t) => t.id === id) ?? null;
}

function buildNoteEl(note: TextNote): HTMLElement {
  const el = document.createElement("div");
  el.className = `wb-text wb-ink-${note.ink}`;
  el.dataset.id = note.id;
  el.style.left = `${note.x}px`;
  el.style.top = `${note.y}px`;
  // textContent, never markup: this is text somebody typed.
  el.textContent = note.text;
  el.spellcheck = true;
  el.addEventListener("keydown", (e) => onNoteKeydown(e, el));
  el.addEventListener("focusout", () => {
    /* Deferred one tick, and skipped if the box still has focus. Switching
       windows blurs the box and focuses it again on the way back, and a
       meeting is exactly when you alt-tab to the call and back mid-sentence. */
    window.setTimeout(() => {
      if (document.activeElement === el) return;
      if (editingId === note.id) endEditing();
    }, 0);
  });
  el.addEventListener("input", () => {
    if (el.textContent && el.textContent.length > MAX_TEXT_LEN) {
      el.textContent = el.textContent.slice(0, MAX_TEXT_LEN);
      placeCaretAtEnd(el);
    }
  });
  return el;
}

function rebuildTexts(): void {
  editingId = null;
  editStart = null;
  noteEls.clear();
  surface.replaceChildren();
  for (const note of texts) {
    const el = buildNoteEl(note);
    noteEls.set(note.id, el);
    surface.appendChild(el);
  }
}

/** The text a box holds, as it would be saved. */
function readNoteText(el: HTMLElement): string {
  return el.innerText
    .replace(/\r/g, "")
    .replace(/ /g, " ")
    .replace(/\s+$/, "")
    .slice(0, MAX_TEXT_LEN);
}

function placeCaretAtEnd(el: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

/** Puts the caret at the character under the pointer, which is where a click
 *  on a box being read (rather than edited) was pointing. */
function placeCaretAtPoint(el: HTMLElement, clientX: number, clientY: number): void {
  const range = document.caretRangeFromPoint?.(clientX, clientY);
  if (!range || !el.contains(range.startContainer)) {
    placeCaretAtEnd(el);
    return;
  }
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

function beginEditing(
  id: string,
  opts: { pre?: Snapshot; at?: { clientX: number; clientY: number } } = {},
): void {
  if (editingId && editingId !== id) endEditing();
  const el = noteEls.get(id);
  if (!el) return;
  editingId = id;
  editStart = opts.pre ?? snapshot();
  el.contentEditable = "plaintext-only";
  el.classList.add("wb-text-editing");
  el.focus();
  if (opts.at) placeCaretAtPoint(el, opts.at.clientX, opts.at.clientY);
  else placeCaretAtEnd(el);
}

/** Leaves the box being edited, keeping what was typed. An emptied box is
 *  removed rather than kept as an invisible thing on the board. */
function endEditing(): void {
  const id = editingId;
  const pre = editStart;
  editingId = null;
  editStart = null;
  if (!id) return;
  const el = noteEls.get(id);
  const note = noteById(id);
  if (el) {
    el.contentEditable = "false";
    el.classList.remove("wb-text-editing");
  }
  if (note && el) {
    const text = readNoteText(el);
    if (text.trim() === "") {
      texts = texts.filter((t) => t.id !== id);
      noteEls.delete(id);
      el.remove();
    } else {
      note.text = text;
      // What was saved, not what was typed: trailing space is gone, and the
      // box should show that now rather than after the next rebuild.
      if (el.textContent !== text) el.textContent = text;
    }
  }
  if (pre && !sameBoard(pre, snapshot())) {
    pushUndo(pre);
    markDirty();
  }
  updateChrome();
}

/** A new, empty box at a board point, ready to type in. */
function createNoteAt(x: number, y: number): void {
  if (texts.length >= MAX_TEXTS) {
    flash(
      `The Whiteboard holds up to ${MAX_TEXTS.toLocaleString()} text boxes. Send some to Kanban, or remove some, to make room.`,
      "error",
    );
    return;
  }
  const pre = snapshot();
  const note: TextNote = {
    id: newId(),
    x: clampX(Math.min(x, SURFACE_W - 40)),
    y: clampY(Math.min(y, SURFACE_H - 30)),
    ink,
    text: "",
  };
  texts.push(note);
  const el = buildNoteEl(note);
  noteEls.set(note.id, el);
  surface.appendChild(el);
  beginEditing(note.id, { pre });
  updateChrome();
}

function onNoteKeydown(e: KeyboardEvent, el: HTMLElement): void {
  if (e.isComposing) return;
  if (e.key === "Escape") {
    e.preventDefault();
    // Kept here: Escape in a box means "stop typing", not "close something".
    e.stopPropagation();
    el.blur();
    return;
  }
  if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
    e.preventDefault();
    const note = noteById(el.dataset.id ?? null);
    if (!note || readNoteText(el).trim() === "") {
      el.blur();
      return;
    }
    const nextY = note.y + el.offsetHeight + NEXT_LINE_GAP;
    const x = note.x;
    endEditing();
    if (nextY < SURFACE_H - 30) createNoteAt(x, nextY);
  }
}

function deleteNote(id: string): void {
  endEditing();
  if (!noteById(id)) return;
  checkpoint();
  texts = texts.filter((t) => t.id !== id);
  noteEls.get(id)?.remove();
  noteEls.delete(id);
  markDirty();
  updateChrome();
}

/* =============================================================================
   POINTER INPUT
============================================================================= */

function onSurfacePointerDown(e: PointerEvent): void {
  if (!loaded) return;

  // Middle button pans in every mode, the way it does in most drawing tools.
  if (e.button === 1) {
    e.preventDefault();
    pan = {
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      left: scroller.scrollLeft,
      top: scroller.scrollTop,
    };
    surface.setPointerCapture(e.pointerId);
    return;
  }
  if (e.button !== 0) return;

  if (mode === "draw" || mode === "erase") {
    e.preventDefault();
    startStroke(e);
    return;
  }

  const boxEl = (e.target as HTMLElement).closest<HTMLElement>(".wb-text");
  if (boxEl && boxEl.dataset.id === editingId) return; // the browser places the caret

  /* Everything below decides focus itself, so the browser's own focus change
     is cancelled. Without this, a click on empty board while typing would both
     end the edit and start a new box, which is two things for one click. */
  e.preventDefault();

  if (boxEl?.dataset.id) {
    const note = noteById(boxEl.dataset.id);
    if (!note) return;
    endEditing();
    boxDrag = {
      id: note.id,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originX: note.x,
      originY: note.y,
      moved: false,
      pre: snapshot(),
    };
    surface.setPointerCapture(e.pointerId);
    return;
  }

  if (editingId) {
    endEditing();
    (document.activeElement as HTMLElement | null)?.blur();
    return;
  }
  const { x, y } = boardPoint(e);
  createNoteAt(x - NEW_BOX_NUDGE_X, y - NEW_BOX_NUDGE_Y);
}

function onSurfacePointerMove(e: PointerEvent): void {
  if (pan && e.pointerId === pan.pointerId) {
    scroller.scrollLeft = pan.left - (e.clientX - pan.x);
    scroller.scrollTop = pan.top - (e.clientY - pan.y);
    return;
  }
  if (liveStroke) {
    extendStroke(e);
    return;
  }
  const drag = boxDrag;
  if (drag && e.pointerId === drag.pointerId) {
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    drag.moved = true;
    const note = noteById(drag.id);
    const el = noteEls.get(drag.id);
    if (!note || !el) return;
    note.x = clampX(Math.min(drag.originX + dx, SURFACE_W - 40));
    note.y = clampY(Math.min(drag.originY + dy, SURFACE_H - 30));
    el.style.left = `${note.x}px`;
    el.style.top = `${note.y}px`;
    el.classList.add("wb-text-dragging");
  }
}

function onSurfacePointerUp(e: PointerEvent): void {
  if (pan && e.pointerId === pan.pointerId) {
    pan = null;
    return;
  }
  if (liveStroke) {
    endStroke();
    return;
  }
  const drag = boxDrag;
  if (drag && e.pointerId === drag.pointerId) {
    boxDrag = null;
    noteEls.get(drag.id)?.classList.remove("wb-text-dragging");
    if (drag.moved) {
      pushUndo(drag.pre);
      markDirty();
      updateChrome();
    } else if (e.type === "pointerup") {
      beginEditing(drag.id, { at: { clientX: e.clientX, clientY: e.clientY } });
    }
  }
}

function onScroll(): void {
  // The dot grid is the stage's background, so it has to be moved by hand to
  // look like it belongs to the board rather than the window.
  stage.style.backgroundPosition = `${-scroller.scrollLeft}px ${-scroller.scrollTop}px`;
  // Only a scroll the person made. Hiding the tool resets the scroller to 0,0
  // and restoring a position scrolls it too; neither is somewhere they went.
  if (loaded && pendingScroll === null && scroller.clientWidth > 0) {
    viewScroll = { x: scroller.scrollLeft, y: scroller.scrollTop };
    scrollDirty = true;
  }
  requestRedraw();
}

function applyPendingScroll(): void {
  if (!pendingScroll || scroller.clientWidth === 0) return;
  const at = pendingScroll;
  scroller.scrollLeft = at.x;
  scroller.scrollTop = at.y;
  stage.style.backgroundPosition = `${-scroller.scrollLeft}px ${-scroller.scrollTop}px`;
  /* Cleared a frame later rather than now: the scroll event from the lines
     above arrives after this function returns, and while pendingScroll is set
     onScroll does not mistake it for the person scrolling. */
  requestAnimationFrame(() => {
    if (pendingScroll === at) pendingScroll = null;
  });
  requestRedraw();
}

function onKeydown(e: KeyboardEvent): void {
  if (document.body.dataset.activeTool !== "productivity/whiteboard") return;
  if (document.body.classList.contains("modal-open")) return;
  // Inside a text box, Ctrl+Z is that box's own typing undo.
  if (isTextEntry(e.target)) return;
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const key = e.key.toLowerCase();
  if (key === "z" && !e.shiftKey) {
    e.preventDefault();
    undo();
  } else if (key === "y" || (key === "z" && e.shiftKey)) {
    e.preventDefault();
    redo();
  }
}

/* =============================================================================
   TOOLBAR
============================================================================= */

function setMode(next: Mode): void {
  if (mode === next) return;
  endEditing();
  mode = next;
  markDirty();
  updateChrome();
}

function setInk(next: InkId): void {
  ink = next;
  markDirty();
  updateChrome();
}

function setSize(next: SizeId): void {
  size = next;
  markDirty();
  updateChrome();
}

function isEmpty(): boolean {
  return strokes.length === 0 && texts.length === 0;
}

/** Everything on screen that reflects state: which mode, pen and size are
 *  picked, and which actions have anything to act on. */
function updateChrome(): void {
  surface.classList.toggle("wb-mode-type", mode === "type");
  surface.classList.toggle("wb-mode-draw", mode === "draw");
  surface.classList.toggle("wb-mode-erase", mode === "erase");
  document.querySelectorAll<HTMLButtonElement>(".wb-mode-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === mode);
  });
  document.querySelectorAll<HTMLButtonElement>(".wb-swatch").forEach((b) => {
    b.classList.toggle("active", b.dataset.ink === ink);
  });
  document.querySelectorAll<HTMLButtonElement>(".wb-size-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.size === size);
  });
  undoBtn.disabled = undoStack.length === 0;
  redoBtn.disabled = redoStack.length === 0;
  clearBtn.disabled = isEmpty();
  sendOpenBtn.disabled = texts.length === 0;
  emptyHint.style.display = loaded && isEmpty() && !editingId ? "" : "none";
  emptyHint.textContent =
    mode === "type"
      ? "Click anywhere to start typing. Enter starts the next line as its own box."
      : mode === "draw"
        ? "Drag to draw. Hold the middle mouse button to move around the board."
        : "Drag over ink to rub it out. Text boxes are not erased.";

  noticeWrap.style.display = blocked ? "" : "none";
  notice.textContent = blocked ? "Not saving: the Whiteboard's file could not be read" : "";
}

function requestClear(): void {
  endEditing();
  if (isEmpty()) return;
  appConfirm(
    {
      title: "Clear the Whiteboard?",
      message:
        "Everything on the whiteboard is removed, typed and drawn. Undo brings it back until the app is closed.",
      confirmLabel: "Clear",
    },
    () => void clearBoard(),
  );
}

async function clearBoard(): Promise<void> {
  checkpoint();
  strokes = [];
  texts = [];
  recountPoints();
  rebuildTexts();
  requestRedraw();
  markDirty();
  updateChrome();
  if (await flushSave()) flash("Whiteboard cleared. Undo brings it back.", "success");
}

/* =============================================================================
   SEND TO KANBAN
   -----------------------------------------------------------------------------
   Every text box is offered, ticked, in reading order. Each one becomes a bare
   card titled with its first line; a box whose text does not fit in a title
   (a second line, or a first line past Kanban's limit) keeps the whole of it
   in the card's description, so nothing typed is lost on the way over.

   SEND AND CLEAR ONLY CLEARS WHAT LANDED. Kanban answers once the board is on
   disk, and the whiteboard lets go of the text only then. Cards that were made
   but not yet written are one crash from existing nowhere, and the whiteboard
   is the other copy.
============================================================================= */

let sendModal: Modal;
let sendBoardSel: HTMLSelectElement;
let sendColumnSel: HTMLSelectElement;
let sendList: HTMLElement;
let sendCount: HTMLElement;
let sendAllBtn: HTMLButtonElement;
let sendEmpty: HTMLElement;
let sendOpenKanbanBtn: HTMLButtonElement;
let sendBtn: HTMLButtonElement;
let sendClearBtn: HTMLButtonElement;
let sendTargets: KanbanTarget[] = [];
let sendChecked = new Set<string>();
let sendBusy = false;

/** Top to bottom, then left to right, the order a person reads a board in. */
function notesInReadingOrder(): TextNote[] {
  return texts.slice().sort((a, b) => a.y - b.y || a.x - b.x);
}

/** A box as the card it becomes. See the section header for the rule. */
function noteToCard(note: TextNote): IncomingCard {
  const full = note.text.trim();
  const firstLine =
    full
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l !== "") ?? "";
  let title = firstLine;
  if (title.length > MAX_TITLE_LEN) {
    const cut = title.slice(0, MAX_TITLE_LEN - 1);
    const space = cut.lastIndexOf(" ");
    // At a word break when there is one reasonably near the end, so a title is
    // not cut mid-word; otherwise wherever the limit falls.
    title = `${(space > MAX_TITLE_LEN * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
  }
  return { title, description: title === full ? "" : full };
}

function openSend(only?: string): void {
  endEditing();
  const notes = notesInReadingOrder();
  if (notes.length === 0) return;
  sendChecked = new Set(only ? [only] : notes.map((n) => n.id));
  fillSendTargets();
  renderSendList();
  sendModal.open();
}

function fillSendTargets(): void {
  const targets = kanbanTargets();
  sendTargets = targets ?? [];
  sendBoardSel.replaceChildren();
  sendOpenKanbanBtn.style.display = "none";

  if (targets === null || targets.length === 0) {
    sendEmpty.style.display = "";
    sendEmpty.textContent =
      targets === null
        ? "Kanban is still loading. Try again in a moment."
        : "There are no Kanban boards yet. Make one in Kanban, then come back.";
    if (targets !== null) sendOpenKanbanBtn.style.display = "";
    sendBoardSel.disabled = true;
    fillSendColumns();
    return;
  }

  sendEmpty.style.display = "none";
  sendBoardSel.disabled = false;
  for (const t of targets) {
    const opt = document.createElement("option");
    opt.value = t.id;
    opt.textContent = t.name;
    sendBoardSel.appendChild(opt);
  }
  sendBoardSel.value = targets.some((t) => t.id === target?.boardId)
    ? target!.boardId
    : targets[0].id;
  fillSendColumns();
}

function fillSendColumns(): void {
  sendColumnSel.replaceChildren();
  const board = sendTargets.find((t) => t.id === sendBoardSel.value);
  if (!board || board.columns.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = board ? "This board has no columns" : "";
    sendColumnSel.appendChild(opt);
    sendColumnSel.disabled = true;
    updateSendButtons();
    return;
  }
  sendColumnSel.disabled = false;
  for (const c of board.columns) {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.title;
    sendColumnSel.appendChild(opt);
  }
  const remembered =
    target?.boardId === board.id && board.columns.some((c) => c.id === target?.columnId);
  sendColumnSel.value = remembered ? target!.columnId : board.columns[0].id;
  updateSendButtons();
}

function renderSendList(): void {
  sendList.replaceChildren();
  for (const note of notesInReadingOrder()) {
    const row = document.createElement("label");
    row.className = "wb-send-row";

    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = sendChecked.has(note.id);
    box.addEventListener("change", () => {
      if (box.checked) sendChecked.add(note.id);
      else sendChecked.delete(note.id);
      updateSendButtons();
    });
    row.appendChild(box);

    const body = document.createElement("span");
    body.className = "wb-send-text";
    const card = noteToCard(note);
    const title = document.createElement("span");
    title.className = "wb-send-title";
    title.textContent = card.title;
    body.appendChild(title);
    if (card.description) {
      const more = document.createElement("span");
      more.className = "wb-send-more";
      more.textContent = "The full text goes in the card's description.";
      body.appendChild(more);
    }
    row.title = note.text;
    row.appendChild(body);
    sendList.appendChild(row);
  }
  updateSendButtons();
}

function updateSendButtons(): void {
  const total = texts.length;
  const picked = texts.filter((t) => sendChecked.has(t.id)).length;
  sendCount.textContent = `${picked} of ${total} selected`;
  sendAllBtn.textContent = picked === total ? "Select None" : "Select All";
  const ready = picked > 0 && !sendBoardSel.disabled && !sendColumnSel.disabled && !sendBusy;
  sendBtn.disabled = !ready;
  sendClearBtn.disabled = !ready;
}

function toggleSendAll(): void {
  const all = texts.every((t) => sendChecked.has(t.id));
  sendChecked = all ? new Set() : new Set(texts.map((t) => t.id));
  renderSendList();
}

async function send(clearAfter: boolean): Promise<void> {
  const board = sendTargets.find((t) => t.id === sendBoardSel.value);
  const column = board?.columns.find((c) => c.id === sendColumnSel.value);
  const chosen = notesInReadingOrder().filter((n) => sendChecked.has(n.id));
  if (!board || !column || chosen.length === 0 || sendBusy) return;

  sendBusy = true;
  updateSendButtons();
  target = { boardId: board.id, columnId: column.id };
  markDirty();
  const result = await addCardsFromElsewhere(board.id, column.id, chosen.map(noteToCard));
  sendBusy = false;
  updateSendButtons();

  if (!result.ok) {
    flash(result.error, "error", 8000);
    return;
  }
  sendModal.close();

  const n = result.numbers;
  const what =
    n.length === 1 ? `card #${n[0]}` : `${n.length} cards, #${n[0]} to #${n[n.length - 1]},`;
  const where = `to ${column.title} on "${board.name}"`;
  if (!result.saved) {
    // Kanban has already said why its write failed. This says what it means here.
    flash(
      `Added ${what} ${where}, but Kanban could not save them yet. The whiteboard kept its text.`,
      "error",
      10000,
    );
    return;
  }

  if (clearAfter) {
    const sent = new Set(chosen.map((c) => c.id));
    checkpoint();
    texts = texts.filter((t) => !sent.has(t.id));
    rebuildTexts();
    markDirty();
    updateChrome();
    await flushSave();
    flash(`Sent ${what} ${where}, and cleared them from the whiteboard.`, "success");
  } else {
    flash(`Sent ${what} ${where}.`, "success");
  }
}

function wireSendModal(): void {
  sendModal = new Modal(document.getElementById("wbSendBackdrop")!);
  sendBoardSel = document.getElementById("wbSendBoard") as HTMLSelectElement;
  sendColumnSel = document.getElementById("wbSendColumn") as HTMLSelectElement;
  sendList = document.getElementById("wbSendList")!;
  sendCount = document.getElementById("wbSendCount")!;
  sendAllBtn = document.getElementById("wbSendAllBtn") as HTMLButtonElement;
  sendEmpty = document.getElementById("wbSendEmpty")!;
  sendOpenKanbanBtn = document.getElementById("wbSendOpenKanbanBtn") as HTMLButtonElement;
  sendBtn = document.getElementById("wbSendBtn") as HTMLButtonElement;
  sendClearBtn = document.getElementById("wbSendClearBtn") as HTMLButtonElement;

  document.getElementById("wbSendClose")!.addEventListener("click", () => sendModal.close());
  document.getElementById("wbSendCancelBtn")!.addEventListener("click", () => sendModal.close());
  sendBoardSel.addEventListener("change", fillSendColumns);
  sendColumnSel.addEventListener("change", updateSendButtons);
  sendAllBtn.addEventListener("click", toggleSendAll);
  sendBtn.addEventListener("click", () => void send(false));
  sendClearBtn.addEventListener("click", () => void send(true));
  sendOpenKanbanBtn.addEventListener("click", () => {
    sendModal.close();
    navigateToTool("productivity", "kanban");
  });
}

/* =============================================================================
   HISTORY
   -----------------------------------------------------------------------------
   The hourly snapshots, through the shared list every tool uses. A restore is
   an ordinary save, so what it replaces is captured on the way past, and it is
   also an ordinary Undo step for the rest of the session.
============================================================================= */

let historyModal: Modal;

function refreshHistory(): Promise<void> {
  return renderToolBackups({
    toolId: "whiteboard",
    host: document.getElementById("wbHistoryList")!,
    summary: document.getElementById("wbHistorySummary"),
    labels: { data: "Whiteboard" },
    onRestore: (_entry, snap) => {
      appConfirm(
        {
          title: "Restore This Snapshot?",
          message:
            `The whiteboard goes back to how it was at ${formatBackupName(snap.name)}. ` +
            "What is on it now is captured first, and Undo also brings it back.",
          confirmLabel: "Restore",
        },
        () => void restoreFromHistory(snap.name),
      );
    },
  });
}

async function restoreFromHistory(name: string): Promise<void> {
  let parsed: WhiteboardFile | null = null;
  try {
    parsed = normalizeFile(JSON.parse(await readToolBackup("whiteboard", name, "data")));
  } catch (err) {
    devError("[whiteboard] snapshot read failed", err);
  }
  if (!parsed) {
    flash("That snapshot could not be read as a whiteboard.", "error");
    return;
  }

  endEditing();
  checkpoint();
  strokes = parsed.strokes;
  texts = parsed.texts;
  recountPoints();
  if (blocked) {
    // A restore REPLACES the file, so it may land on one that would not read.
    unblockAfterReplacement("whiteboard", "data");
    blocked = false;
  }
  rebuildTexts();
  requestRedraw();
  markDirty();
  updateChrome();
  const saved = await flushSave();
  historyModal.close();
  if (saved) flash(`Whiteboard restored to ${formatBackupName(name)}.`, "success");
}

/* =============================================================================
   MENUS
============================================================================= */

function surfaceMenu(e: MouseEvent): MenuItem[] | null {
  if (!loaded) return null;
  const boxEl = (e.target as HTMLElement).closest<HTMLElement>(".wb-text");
  const id = boxEl?.dataset.id;
  if (id && id !== editingId) {
    return [
      { label: "Edit", onClick: () => beginEditing(id) },
      { label: "Send to Kanban…", onClick: () => openSend(id) },
      { separator: true },
      { label: "Delete", danger: true, onClick: () => deleteNote(id) },
    ];
  }
  menuPoint = boardPoint(e);
  return [
    { label: "Type Here", onClick: typeAtMenuPoint },
    { label: "Undo", disabled: undoStack.length === 0, onClick: undo },
    { label: "Redo", disabled: redoStack.length === 0, onClick: redo },
    { separator: true },
    { label: "Send to Kanban…", disabled: texts.length === 0, onClick: () => openSend() },
    { label: "Clear Whiteboard…", danger: true, disabled: isEmpty(), onClick: requestClear },
    // A menu on a background carries the app-wide rows, or it has removed them.
    { separator: true },
    ...backgroundMenu(),
  ];
}

function typeAtMenuPoint(): void {
  const at = menuPoint;
  if (!at) return;
  setMode("type");
  endEditing();
  createNoteAt(at.x - NEW_BOX_NUDGE_X, at.y - NEW_BOX_NUDGE_Y);
}

/* =============================================================================
   SHELL HOOKS
============================================================================= */

/** Called by shell.ts whenever the Whiteboard is opened. */
export function onWhiteboardToolEntry(): void {
  if (!stage) return;
  resolveInkColors();
  applyPendingScroll();
  requestRedraw();
  updateChrome();
}

/** Called by shell.ts when the Whiteboard is navigated away from, and on quit.
 *  A box still being typed in is kept, and anything waiting is written. */
export async function onWhiteboardToolExit(): Promise<void> {
  if (!stage) return;
  endEditing();
  // Put back on the way in: the scroller is about to be hidden, which loses it.
  if (loaded) pendingScroll = { ...viewScroll };
  await flushSave();
}

export function initWhiteboard(): void {
  stage = document.getElementById("wbStage")!;
  canvas = document.getElementById("wbInk") as HTMLCanvasElement;
  ctx = canvas.getContext("2d")!;
  scroller = document.getElementById("wbScroller")!;
  surface = document.getElementById("wbSurface")!;
  emptyHint = document.getElementById("wbEmptyHint")!;
  undoBtn = document.getElementById("wbUndoBtn") as HTMLButtonElement;
  redoBtn = document.getElementById("wbRedoBtn") as HTMLButtonElement;
  sendOpenBtn = document.getElementById("wbSendOpenBtn") as HTMLButtonElement;
  clearBtn = document.getElementById("wbClearBtn") as HTMLButtonElement;
  noticeWrap = document.getElementById("wbHeaderNoticeWrap")!;
  notice = document.getElementById("wbHeaderNotice")!;

  surface.style.width = `${SURFACE_W}px`;
  surface.style.height = `${SURFACE_H}px`;

  surface.addEventListener("pointerdown", onSurfacePointerDown);
  surface.addEventListener("pointermove", onSurfacePointerMove);
  surface.addEventListener("pointerup", onSurfacePointerUp);
  surface.addEventListener("pointercancel", onSurfacePointerUp);
  // A dropped file would otherwise be opened by the webview in place of the app.
  surface.addEventListener("dragover", (e) => e.preventDefault());
  surface.addEventListener("drop", (e) => e.preventDefault());
  scroller.addEventListener("scroll", onScroll, { passive: true });
  new ResizeObserver(() => {
    applyPendingScroll();
    requestRedraw();
  }).observe(scroller);

  document.querySelectorAll<HTMLButtonElement>(".wb-mode-btn").forEach((b) => {
    b.addEventListener("click", () => setMode(b.dataset.mode as Mode));
  });
  document.querySelectorAll<HTMLButtonElement>(".wb-swatch").forEach((b) => {
    b.addEventListener("click", () => setInk(b.dataset.ink as InkId));
  });
  document.querySelectorAll<HTMLButtonElement>(".wb-size-btn").forEach((b) => {
    b.addEventListener("click", () => setSize(b.dataset.size as SizeId));
  });
  undoBtn.addEventListener("click", undo);
  redoBtn.addEventListener("click", redo);
  sendOpenBtn.addEventListener("click", () => openSend());
  clearBtn.addEventListener("click", requestClear);
  document.addEventListener("keydown", onKeydown);

  attachMenu(surface, surfaceMenu);

  wireSendModal();
  historyModal = new Modal(document.getElementById("wbHistoryBackdrop")!, {
    onOpen: () => void refreshHistory(),
  });
  document.getElementById("wbHistoryBtn")!.addEventListener("click", () => {
    endEditing();
    historyModal.open();
  });
  document.getElementById("wbHistoryClose")!.addEventListener("click", () => historyModal.close());
  document
    .getElementById("wbHistoryRefreshBtn")!
    .addEventListener("click", () => void refreshHistory());

  window.addEventListener("themechange", () => {
    resolveInkColors();
    requestRedraw();
  });

  updateChrome();
  void load();
}
