/* =============================================================================
   WHITEBOARD: an open surface to type and scribble on, that can feed Kanban
   -----------------------------------------------------------------------------
   For the moment in a meeting when something needs writing down and filling in
   a Kanban card would take too long. Click and type, or switch to Draw and
   scribble, and sort it out later. Later is Send to Kanban: every text box can
   become one bare card, and any area of the board can go over as a picture on
   a card of its own.

   ONE BOARD, TWO FILES. whiteboard.json is what is ON the board and is
   snapshotted once an hour like any record you would miss (see
   WHITEBOARD_GROUP in lib.rs). whiteboard-settings.json is how you like it:
   the grid, the board color, the pen last picked. There is no naming, saving
   or loading; the board is written a moment after it changes. Clear is one
   click, so it confirms, and Undo reaches back over it for the session.

   -----------------------------------------------------------------------------
   TWO LAYERS, AND WHY TEXT IS NEVER PAINTED

   Ink is drawn on a canvas. Typed text is real DOM text boxes floating over it.
   That split is the whole Kanban feature: text baked into pixels is gone as
   text forever, and there would be nothing left to send as a card.

   The canvas is only the size of the window onto the board, not the board. A
   board this big as one canvas is hundreds of megabytes of pixels, so the
   strokes are kept as points and redrawn for whatever is in view whenever the
   view moves. The text boxes live inside the scrolling surface and scroll
   natively. Sending an area as a picture draws both into a canvas of its own,
   sized to the area.

   -----------------------------------------------------------------------------
   COLORS

   The six pens are the board's ink and the theme's first five chart colors,
   stored by slot rather than by value, plus any color picked by hand, stored
   as #rrggbb. Named theme colors would lie (Christmas's "red" slot is green),
   so the slots are shown, never named.

   "Ink" is the one pen that is not simply a theme color. On the theme's own
   board it is the theme's text color; on a black, white or custom board it is
   whichever of dark or light reads on that board, or a light theme's ink would
   vanish on a black board. A theme change redraws the ink in the new palette.

   Rust commands used: save_tool_file / load_tool_file (toolId "whiteboard",
   kinds "data" and "settings"), through core/tool-store.ts, and
   list_tool_backups / read_tool_backup through core/tool-backups.ts.
============================================================================= */

import { devError } from "../core/dev-log";
import { newId } from "../core/ids";
import { fileTimestamp } from "../core/timestamp";
import {
  isToolFileBlocked,
  loadToolJson,
  saveToolJson,
  unblockAfterReplacement,
} from "../core/tool-store";
import { formatBackupName, readToolBackup, renderToolBackups } from "../core/tool-backups";
import { Modal, ModalTabs } from "../modal/modal";
import { attachMenu, isTextEntry, type MenuItem } from "../menu/menu";
import { appConfirm, backgroundMenu, flash, navigateToTool } from "../core/shell";
import {
  MAX_TITLE_LEN,
  addCardsFromElsewhere,
  addImageCardFromElsewhere,
  isHexColor,
  kanbanTargets,
  readableTextOn,
  type IncomingCard,
  type KanbanTarget,
} from "./kanban";

/* =============================================================================
   TYPES AND LIMITS
============================================================================= */

type Mode = "type" | "draw" | "erase" | "select";

/** A pen slot in the theme. See COLORS in the header. */
type InkId = "ink" | "c1" | "c2" | "c3" | "c4" | "c5";

/** A pen: a theme slot, or a color picked by hand as #rrggbb. */
type Pen = InkId | string;

type SizeId = "fine" | "medium" | "bold";

type BoardColor = "theme" | "black" | "white" | "custom";

interface Stroke {
  id: string;
  ink: Pen;
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
  ink: Pen;
  size: SizeId;
  text: string;
}

interface SendTarget {
  boardId: string;
  columnId: string;
}

/** A rectangle on the board, in board coordinates. */
interface Area {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface WhiteboardFile {
  version: 1;
  strokes: Stroke[];
  texts: TextNote[];
  scroll: { x: number; y: number };
  /** How far in or out the view is, 1 being actual size. */
  zoom: number;
}

interface WhiteboardSettings {
  grid: boolean;
  boardColor: BoardColor;
  /** The Custom board color, kept while another choice is in use so switching
   *  back does not lose it. */
  boardCustom: string;
  mode: Mode;
  ink: Pen;
  size: SizeId;
  /** The last color picked by hand, offered again in the color list. */
  customInk: string | null;
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
  { id: "ink", cssVar: "--color-text", label: "Ink" },
  { id: "c1", cssVar: "--color-chart-1", label: "Theme color 1" },
  { id: "c2", cssVar: "--color-chart-2", label: "Theme color 2" },
  { id: "c3", cssVar: "--color-chart-3", label: "Theme color 3" },
  { id: "c4", cssVar: "--color-chart-4", label: "Theme color 4" },
  { id: "c5", cssVar: "--color-chart-5", label: "Theme color 5" },
];

const BOARD_FIXED: Record<"black" | "white", string> = { black: "#000000", white: "#ffffff" };

/** Pen widths in board pixels. The eraser is wider than the pen at every size,
 *  because rubbing out a fine line with a fine eraser takes several passes. */
const PEN_WIDTH: Record<SizeId, number> = { fine: 2, medium: 4, bold: 8 };
const ERASER_WIDTH: Record<SizeId, number> = { fine: 10, medium: 20, bold: 40 };

const MODES: readonly Mode[] = ["type", "draw", "erase", "select"];

/** The single keys that switch mode, while not typing in a box. */
const MODE_KEYS: Record<string, Mode> = { t: "type", d: "draw", e: "erase", s: "select" };
const SIZES: readonly SizeId[] = ["fine", "medium", "bold"];
const BOARD_COLORS: readonly BoardColor[] = ["theme", "black", "white", "custom"];

const DEFAULT_SETTINGS: WhiteboardSettings = {
  grid: true,
  boardColor: "theme",
  boardCustom: "#fdf6e3",
  mode: "type",
  ink: "ink",
  size: "medium",
  customInk: null,
  target: null,
};

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

/** How far a press has to travel before it is a drag. Anything shorter is a
 *  click: on a text box it starts editing, in Select it clears the selection. */
const DRAG_THRESHOLD = 4;

/** Gap between a text box and the one Enter opens below it. */
const NEXT_LINE_GAP = 4;

const SAVE_DEBOUNCE_MS = 500;

/** Offset from the click to a new box's top-left corner, so the caret lands
 *  under the pointer rather than below and to the right of it. */
const NEW_BOX_NUDGE_X = 5;
/** Half a line of text at medium size, scaled by TEXT_REM for the others. */
const NEW_BOX_NUDGE_Y = 13;

/* A text box's box model, as whiteboard.css draws it, for drawing its text
   into a picture at the same place: padding plus the border, and the widest
   its text runs before it wraps. Kept in step with .wb-text by hand. */
const TEXT_INSET_X = 5;
const TEXT_INSET_Y = 3;
const TEXT_MAX_WIDTH = 560;

/* A picture of an area is drawn at twice the board's scale so it stays sharp
   on the card, and scaled down for an area too big to hold at that size. */
const IMAGE_SCALE = 2;
const IMAGE_MAX_PIXELS = 16_000_000;
const IMAGE_MAX_SIDE = 8192;
/** Margin around everything on the board when the whole board is sent. */
const BOARD_IMAGE_MARGIN = 24;
const PREVIEW_WIDTH = 480;

/* Zoom. The floor is not a number: it is whatever shows the whole board in
   the window, which is what Overview goes to. */
const ZOOM_MAX = 2;
const ZOOM_STEP = 1.25;
/** Spacing of the grid's dots at actual size, in board pixels. */
const GRID_STEP = 24;
/** Below this the dots would crowd into a grey wash, so they are spread four
 *  times as far apart. */
const GRID_SPARSE_BELOW = 0.5;
/** Margin kept around your notes when Go to Notes brings them into view. */
const NOTES_MARGIN = 40;

/** Text sizes, in rem, so they follow the app's font scale. Mirrored by the
 *  wb-tsize-* classes in whiteboard.css. */
const TEXT_REM: Record<SizeId, number> = { fine: 0.85, medium: 1, bold: 1.4 };

/* =============================================================================
   STATE
============================================================================= */

let strokes: Stroke[] = [];
let texts: TextNote[] = [];
let settings: WhiteboardSettings = { ...DEFAULT_SETTINGS };

let undoStack: Snapshot[] = [];
let redoStack: Snapshot[] = [];

/** False until the file has been read. Nothing is drawn, taken or written
 *  before then, so an early click cannot save an empty board over a full one. */
let loaded = false;
/** The board's file would not read. The store refuses every save to it this
 *  session; this flag is what keeps a debounced save quiet about it. */
let blocked = false;

let dirty = false;
/** The scroll position changed. Written with the next save, or on the way out,
 *  but never a reason to write on its own: scrolling is not an edit. */
let scrollDirty = false;
let saveTimer: number | null = null;
let saveChain: Promise<boolean> = Promise.resolve(true);
let settingsChain: Promise<void> = Promise.resolve();
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

/** The area picked in Select, which Send to Kanban offers as a picture. */
let selection: Area | null = null;
let selectDrag: { pointerId: number; x: number; y: number; moved: boolean } | null = null;

/** Where the last right-click on the board landed, for "Type Here". */
let menuPoint: { x: number; y: number } | null = null;

/** Board pixels to screen pixels. */
let zoom = 1;
/** Zoomed out to the whole board, where a click zooms back in at that spot
 *  rather than doing what the mode would do. */
let overview = false;

/** What the hidden color input is choosing for when it next reports: the pen,
 *  or one text box's color from its right-click menu. */
let colorFor: { kind: "pen" } | { kind: "note"; id: string } = { kind: "pen" };

const noteEls = new Map<string, HTMLElement>();
const inkColors = new Map<InkId, string>();
const strokeBounds = new WeakMap<Stroke, [number, number, number, number]>();
let totalPoints = 0;
let redrawQueued = false;

/* ── Elements, set in initWhiteboard ── */
let toolView: HTMLElement;
let stage: HTMLElement;
let canvas: HTMLCanvasElement;
let ctx: CanvasRenderingContext2D;
let scroller: HTMLElement;
let surface: HTMLElement;
/** Holds the text boxes and the selection, scaled by the zoom. */
let layer: HTMLElement;
let selectionEl: HTMLElement;
let zoomLabel: HTMLButtonElement;
let overviewBtn: HTMLButtonElement;
let undoBtn: HTMLButtonElement;
let redoBtn: HTMLButtonElement;
let sendOpenBtn: HTMLButtonElement;
let clearBtn: HTMLButtonElement;
let colorBtn: HTMLButtonElement;
let colorChip: HTMLElement;
let colorPop: HTMLElement;
let colorRecent: HTMLButtonElement;
let colorInput: HTMLInputElement;
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

function isPen(v: unknown): v is Pen {
  return isInk(v) || (isHexColor(v) && /^#[0-9a-f]{6}$/i.test(v));
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
    ink: isPen(r.ink) ? r.ink : "ink",
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
    ink: isPen(r.ink) ? r.ink : "ink",
    size: SIZES.includes(r.size as SizeId) ? (r.size as SizeId) : "medium",
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
  const z = Number(r.zoom);

  return {
    version: 1,
    strokes: outStrokes,
    texts: outTexts,
    // The scroll is in screen pixels at that zoom, so it can run past the
    // board's own size when zoomed in. The browser clamps it on the way in.
    scroll: {
      x: Number.isFinite(sx) ? Math.max(0, sx) : 0,
      y: Number.isFinite(sy) ? Math.max(0, sy) : 0,
    },
    zoom: Number.isFinite(z) && z > 0 ? Math.min(z, ZOOM_MAX) : 1,
  };
}

function normalizeSettings(raw: unknown): WhiteboardSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const t = r.target as Record<string, unknown> | null | undefined;
  const hex = (v: unknown): v is string => isHexColor(v) && /^#[0-9a-f]{6}$/i.test(v as string);
  return {
    grid: r.grid !== false,
    boardColor: BOARD_COLORS.includes(r.boardColor as BoardColor)
      ? (r.boardColor as BoardColor)
      : DEFAULT_SETTINGS.boardColor,
    boardCustom: hex(r.boardCustom) ? r.boardCustom : DEFAULT_SETTINGS.boardCustom,
    mode: MODES.includes(r.mode as Mode) ? (r.mode as Mode) : DEFAULT_SETTINGS.mode,
    ink: isPen(r.ink) ? r.ink : DEFAULT_SETTINGS.ink,
    size: SIZES.includes(r.size as SizeId) ? (r.size as SizeId) : DEFAULT_SETTINGS.size,
    customInk: hex(r.customInk) ? r.customInk : null,
    target:
      t && typeof t.boardId === "string" && typeof t.columnId === "string"
        ? { boardId: t.boardId, columnId: t.columnId }
        : null,
  };
}

/** Puts a file's contents on the board. Undo history is the caller's to keep
 *  or drop. */
function applyFile(file: WhiteboardFile): void {
  strokes = file.strokes;
  texts = file.texts;
  zoom = file.zoom;
  viewScroll = { ...file.scroll };
  writtenScroll = { ...file.scroll };
  pendingScroll = { ...file.scroll };
  recountPoints();
}

async function loadSettings(): Promise<void> {
  try {
    settings = normalizeSettings(await loadToolJson<unknown>("whiteboard", "settings"));
  } catch (err) {
    // Preferences, so the defaults are a usable board. The store has said so.
    devError("[whiteboard] settings load failed", err);
    settings = { ...DEFAULT_SETTINGS };
  }
}

async function load(): Promise<void> {
  await loadSettings();
  try {
    const parsed = normalizeFile(await loadToolJson<unknown>("whiteboard", "data"));
    if (parsed) {
      applyFile(parsed);
    } else {
      /* It parsed as JSON and is not a whiteboard. Treated as the unreadable
         file it is: the store only blocks a file it could not parse, and this
         one it could, so the block is this tool's to keep. */
      blocked = true;
      flash("Couldn't read the Whiteboard's file. It won't be saved over.", "error", 12000);
    }
  } catch (err) {
    // The store has already said so out loud and blocked the file.
    devError("[whiteboard] load failed", err);
    blocked = true;
  }
  if (!blocked) blocked = isToolFileBlocked("whiteboard", "data");
  loaded = true;
  applyZoomLayout();
  rebuildTexts();
  applyBoardLook();
  applyPendingScroll();
  updateChrome();
}

/* =============================================================================
   SAVING
============================================================================= */

function buildFile(): WhiteboardFile {
  return { version: 1, strokes, texts, scroll: { ...viewScroll }, zoom };
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

/** Preferences are small and change on a click, so they are written at once
 *  rather than debounced. A file that would not read at startup is left alone
 *  without a word each time: the store has already said so. */
function saveSettings(): void {
  if (!loaded || isToolFileBlocked("whiteboard", "settings")) return;
  const snapshotOfSettings = { ...settings };
  settingsChain = settingsChain.then(async () => {
    try {
      await saveToolJson("whiteboard", "settings", snapshotOfSettings);
    } catch (err) {
      devError("[whiteboard] settings save failed", err);
      flash(`Couldn't save Whiteboard preferences: ${String(err)}`, "error");
    }
  });
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
   BOARD LOOK AND COLORS
============================================================================= */

/** The board's color as #rrggbb, or null when it is the theme's own surface. */
function boardHex(): string | null {
  if (settings.boardColor === "theme") return null;
  if (settings.boardColor === "custom") return settings.boardCustom;
  return BOARD_FIXED[settings.boardColor];
}

/** Paints the board in its chosen color and grid, and gives "Ink" a color
 *  that reads on it. Set on the tool view rather than the board, so the Ink
 *  swatch in the toolbar shows the same ink the board uses. */
function applyBoardLook(): void {
  const hex = boardHex();
  if (hex) {
    const ink = readableTextOn(hex);
    toolView.style.setProperty("--wb-board", hex);
    toolView.style.setProperty("--wb-ink", ink);
    toolView.style.setProperty("--wb-dot", `color-mix(in srgb, ${ink} 22%, transparent)`);
  } else {
    toolView.style.removeProperty("--wb-board");
    toolView.style.removeProperty("--wb-ink");
    toolView.style.removeProperty("--wb-dot");
  }
  stage.classList.toggle("wb-no-grid", !settings.grid);
  resolveInkColors();
  updateCursor();
  requestRedraw();
}

/** Reads the pens out of the live theme. Called at load, on every theme
 *  change, and on entry, since a custom palette can change under the tool. */
function resolveInkColors(): void {
  const style = getComputedStyle(document.documentElement);
  for (const i of INKS) {
    inkColors.set(i.id, style.getPropertyValue(i.cssVar).trim() || "#888888");
  }
  const hex = boardHex();
  if (hex) inkColors.set("ink", readableTextOn(hex));
}

function penColor(pen: Pen): string {
  return isInk(pen) ? inkColors.get(pen) ?? "#888888" : pen;
}

/** Colors an element the way a pen colors ink: a theme slot by its class, so
 *  it follows the theme live, and a picked color by value. */
function paintWithPen(el: HTMLElement, pen: Pen): void {
  for (const i of INKS) el.classList.remove(`wb-ink-${i.id}`);
  if (isInk(pen)) {
    el.classList.add(`wb-ink-${pen}`);
    el.style.removeProperty("--wb-c");
  } else {
    el.style.setProperty("--wb-c", pen);
  }
}

/* =============================================================================
   DRAWING
============================================================================= */

function recountPoints(): void {
  totalPoints = strokes.reduce((n, s) => n + s.pts.length / 2, 0);
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

function styleFor(c: CanvasRenderingContext2D, s: Stroke): void {
  c.globalCompositeOperation = s.erase ? "destination-out" : "source-over";
  c.strokeStyle = s.erase ? "#000000" : penColor(s.ink);
  c.fillStyle = c.strokeStyle;
  c.lineWidth = strokeWidth(s);
  c.lineCap = "round";
  c.lineJoin = "round";
}

/** A finished stroke, smoothed through the midpoints between its samples so a
 *  mouse's straight hops read as a curve. */
function drawStroke(c: CanvasRenderingContext2D, s: Stroke): void {
  styleFor(c, s);
  const p = s.pts;
  if (p.length === 2) {
    c.beginPath();
    c.arc(p[0], p[1], strokeWidth(s) / 2, 0, Math.PI * 2);
    c.fill();
    return;
  }
  c.beginPath();
  c.moveTo(p[0], p[1]);
  for (let i = 2; i < p.length - 2; i += 2) {
    const mx = (p[i] + p[i + 2]) / 2;
    const my = (p[i + 1] + p[i + 3]) / 2;
    c.quadraticCurveTo(p[i], p[i + 1], mx, my);
  }
  c.lineTo(p[p.length - 2], p[p.length - 1]);
  c.stroke();
}

/** The canvas's transform: backing pixels to CSS pixels, then the board
 *  scrolled to where the view is. */
function applyViewTransform(): void {
  const dpr = window.devicePixelRatio || 1;
  const k = dpr * zoom;
  ctx.setTransform(k, 0, 0, k, -scroller.scrollLeft * dpr, -scroller.scrollTop * dpr);
}

function overlaps(b: [number, number, number, number], a: Area): boolean {
  return !(b[2] < a.x || b[0] > a.x + a.w || b[3] < a.y || b[1] > a.y + a.h);
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

  const view: Area = {
    x: scroller.scrollLeft / zoom,
    y: scroller.scrollTop / zoom,
    w: w / zoom,
    h: h / zoom,
  };
  for (const s of strokes) {
    if (overlaps(boundsOf(s), view)) drawStroke(ctx, s);
  }
  if (liveStroke) drawStroke(ctx, liveStroke);
}

function requestRedraw(): void {
  if (redrawQueued) return;
  redrawQueued = true;
  requestAnimationFrame(redraw);
}

/** The point under the pointer, in board coordinates. */
function boardPoint(e: { clientX: number; clientY: number }): { x: number; y: number } {
  const r = surface.getBoundingClientRect();
  return { x: clampX((e.clientX - r.left) / zoom), y: clampY((e.clientY - r.top) / zoom) };
}

function startStroke(e: PointerEvent): void {
  if (totalPoints >= MAX_TOTAL_POINTS) {
    flash("The Whiteboard is full.", "error");
    return;
  }
  const { x, y } = boardPoint(e);
  livePre = snapshot();
  liveStroke = {
    id: newId(),
    ink: settings.ink,
    size: settings.size,
    erase: settings.mode === "erase",
    pts: [round1(x), round1(y)],
  };
  surface.setPointerCapture(e.pointerId);
  applyViewTransform();
  drawStroke(ctx, liveStroke);
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
  styleFor(ctx, stroke);
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
  el.className = `wb-text wb-tsize-${note.size}`;
  paintWithPen(el, note.ink);
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
  layer.replaceChildren();
  for (const note of texts) {
    const el = buildNoteEl(note);
    noteEls.set(note.id, el);
    layer.appendChild(el);
  }
  // Last, so the selection outline sits above the text it is picking.
  layer.appendChild(selectionEl);
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

/** A new, empty box at a board point, ready to type in, in the pen's color and
 *  size unless it is carrying on from a box above it. */
function createNoteAt(x: number, y: number, style?: { ink: Pen; size: SizeId }): void {
  if (texts.length >= MAX_TEXTS) {
    flash("The Whiteboard can't hold more text boxes.", "error");
    return;
  }
  const pre = snapshot();
  const note: TextNote = {
    id: newId(),
    x: clampX(Math.min(x, SURFACE_W - 40)),
    y: clampY(Math.min(y, SURFACE_H - 30)),
    ink: style?.ink ?? settings.ink,
    size: style?.size ?? settings.size,
    text: "",
  };
  texts.push(note);
  const el = buildNoteEl(note);
  noteEls.set(note.id, el);
  layer.insertBefore(el, selectionEl);
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
    // The next line carries on in this box's color and size, not the pen's:
    // a list started in red and large is still that list.
    const style = { ink: note.ink, size: note.size };
    endEditing();
    if (nextY < SURFACE_H - 30) createNoteAt(x, nextY, style);
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

/** A text box's footprint on the board, measured off the box as drawn. */
function noteArea(note: TextNote): Area {
  const el = noteEls.get(note.id);
  return { x: note.x, y: note.y, w: el?.offsetWidth ?? 0, h: el?.offsetHeight ?? 0 };
}

/* =============================================================================
   SELECT
   -----------------------------------------------------------------------------
   A rectangle dragged out in Select mode, for sending that part of the board
   to Kanban as a picture. A click without a drag clears it, and so does
   leaving Select.
============================================================================= */

function showSelection(): void {
  if (!selection) {
    selectionEl.style.display = "none";
    return;
  }
  selectionEl.style.display = "";
  selectionEl.style.left = `${selection.x}px`;
  selectionEl.style.top = `${selection.y}px`;
  selectionEl.style.width = `${selection.w}px`;
  selectionEl.style.height = `${selection.h}px`;
}

function clearSelection(): void {
  if (!selection) return;
  selection = null;
  showSelection();
  updateChrome();
}

function inside(a: Area, outer: Area): boolean {
  return a.x >= outer.x && a.y >= outer.y && a.x + a.w <= outer.x + outer.w && a.y + a.h <= outer.y + outer.h;
}

function boundsArea(b: [number, number, number, number]): Area {
  return { x: b[0], y: b[1], w: b[2] - b[0], h: b[3] - b[1] };
}

/** Everything on the board, with a margin, or null for an empty board. */
function contentArea(includeText: boolean): Area | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const take = (a: Area): void => {
    minX = Math.min(minX, a.x);
    minY = Math.min(minY, a.y);
    maxX = Math.max(maxX, a.x + a.w);
    maxY = Math.max(maxY, a.y + a.h);
  };
  for (const s of strokes) if (!s.erase) take(boundsArea(boundsOf(s)));
  if (includeText) for (const t of texts) take(noteArea(t));
  if (minX === Infinity) return null;
  const x = Math.max(0, minX - BOARD_IMAGE_MARGIN);
  const y = Math.max(0, minY - BOARD_IMAGE_MARGIN);
  return {
    x,
    y,
    w: Math.min(SURFACE_W, maxX + BOARD_IMAGE_MARGIN) - x,
    h: Math.min(SURFACE_H, maxY + BOARD_IMAGE_MARGIN) - y,
  };
}

/* =============================================================================
   PICTURES OF THE BOARD
   -----------------------------------------------------------------------------
   An area drawn into a canvas of its own: the board's color, then the ink on a
   layer of its own (so the eraser rubs out ink and not the board), then the
   text boxes on top if they were asked for. The text is laid out again here
   with the same font, width and wrapping the box uses on screen.
============================================================================= */

function renderArea(area: Area, includeText: boolean, maxWidth?: number): HTMLCanvasElement {
  let scale = Math.min(
    IMAGE_SCALE,
    Math.sqrt(IMAGE_MAX_PIXELS / Math.max(1, area.w * area.h)),
    IMAGE_MAX_SIDE / Math.max(1, area.w),
    IMAGE_MAX_SIDE / Math.max(1, area.h),
  );
  if (maxWidth) scale = Math.min(scale, maxWidth / Math.max(1, area.w));
  const w = Math.max(1, Math.round(area.w * scale));
  const h = Math.max(1, Math.round(area.h * scale));
  const toArea = (c: CanvasRenderingContext2D): void =>
    c.setTransform(scale, 0, 0, scale, -area.x * scale, -area.y * scale);

  const inkLayer = document.createElement("canvas");
  inkLayer.width = w;
  inkLayer.height = h;
  const ictx = inkLayer.getContext("2d")!;
  toArea(ictx);
  for (const s of strokes) if (overlaps(boundsOf(s), area)) drawStroke(ictx, s);

  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const octx = out.getContext("2d")!;
  // The board as it is painted right now, resolved to a real color.
  octx.fillStyle = getComputedStyle(stage).backgroundColor;
  octx.fillRect(0, 0, w, h);
  octx.drawImage(inkLayer, 0, 0);

  if (includeText) {
    toArea(octx);
    for (const note of texts) {
      const b = noteArea(note);
      if (overlaps([b.x, b.y, b.x + b.w, b.y + b.h], area)) drawNoteText(octx, note);
    }
  }
  return out;
}

function drawNoteText(c: CanvasRenderingContext2D, note: TextNote): void {
  const el = noteEls.get(note.id);
  if (!el) return;
  const cs = getComputedStyle(el);
  const fontSize = parseFloat(cs.fontSize) || 16;
  const lineHeight = parseFloat(cs.lineHeight) || fontSize * 1.4;
  c.font = `${cs.fontStyle} ${cs.fontWeight} ${fontSize}px ${cs.fontFamily}`;
  c.fillStyle = penColor(note.ink);
  c.textBaseline = "middle";
  const lines = wrapLines(c, note.text, TEXT_MAX_WIDTH);
  lines.forEach((line, i) => {
    c.fillText(line, note.x + TEXT_INSET_X, note.y + TEXT_INSET_Y + i * lineHeight + lineHeight / 2);
  });
}

/** The text split the way the box wraps it: at its own line breaks, then at
 *  word breaks past the width, then anywhere in a word too long for a line. */
function wrapLines(c: CanvasRenderingContext2D, text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/(\s+)/)) {
      if (c.measureText(line + word).width <= width) {
        line += word;
        continue;
      }
      if (line.trim()) out.push(line.trimEnd());
      line = word.trimStart();
      while (c.measureText(line).width > width && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && c.measureText(line.slice(0, cut)).width > width) cut--;
        out.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    out.push(line);
  }
  return out;
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

  if (overview) {
    e.preventDefault();
    leaveOverviewAt(e);
    return;
  }

  const mode = settings.mode;
  if (mode === "draw" || mode === "erase") {
    e.preventDefault();
    startStroke(e);
    return;
  }

  if (mode === "select") {
    e.preventDefault();
    const { x, y } = boardPoint(e);
    selectDrag = { pointerId: e.pointerId, x, y, moved: false };
    surface.setPointerCapture(e.pointerId);
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
  createNoteAt(x - NEW_BOX_NUDGE_X, y - NEW_BOX_NUDGE_Y * TEXT_REM[settings.size]);
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
  const sel = selectDrag;
  if (sel && e.pointerId === sel.pointerId) {
    const { x, y } = boardPoint(e);
    if (!sel.moved && Math.hypot(x - sel.x, y - sel.y) * zoom < DRAG_THRESHOLD) return;
    sel.moved = true;
    selection = {
      x: Math.min(x, sel.x),
      y: Math.min(y, sel.y),
      w: Math.abs(x - sel.x),
      h: Math.abs(y - sel.y),
    };
    showSelection();
    return;
  }
  const drag = boxDrag;
  if (drag && e.pointerId === drag.pointerId) {
    const dx = (e.clientX - drag.startX) / zoom;
    const dy = (e.clientY - drag.startY) / zoom;
    if (!drag.moved && Math.hypot(dx, dy) * zoom < DRAG_THRESHOLD) return;
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
  const sel = selectDrag;
  if (sel && e.pointerId === sel.pointerId) {
    selectDrag = null;
    if (!sel.moved) selection = null;
    showSelection();
    updateChrome();
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

/** The dot grid is the stage's background, so it has to be moved and sized by
 *  hand to look like it belongs to the board rather than the window. */
function placeGrid(): void {
  const step = GRID_STEP * zoom * (zoom < GRID_SPARSE_BELOW ? 4 : 1);
  stage.style.backgroundSize = `${step}px ${step}px`;
  stage.style.backgroundPosition = `${-scroller.scrollLeft}px ${-scroller.scrollTop}px`;
}

function onScroll(): void {
  placeGrid();
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
  placeGrid();
  /* Cleared a frame later rather than now: the scroll event from the lines
     above arrives after this function returns, and while pendingScroll is set
     onScroll does not mistake it for the person scrolling. */
  requestAnimationFrame(() => {
    if (pendingScroll === at) pendingScroll = null;
  });
  requestRedraw();
}

/* =============================================================================
   ZOOM AND FINDING YOUR WAY
   -----------------------------------------------------------------------------
   The surface is sized to the board at the current zoom, so the scrollbars
   stay honest, and the text boxes sit in a layer scaled by it. The canvas is
   told the zoom in its transform. Everything that turns a pointer into a board
   point divides by it (boardPoint), so every mode works at any zoom.

   OVERVIEW is zoomed out to the whole board. A click there zooms back to
   actual size at the spot clicked, rather than typing or drawing, which is
   what makes the whole board a map you can jump across.
============================================================================= */

/** The zoom that shows the whole board in the window. */
function fitBoardZoom(): number {
  const w = scroller.clientWidth || 1;
  const h = scroller.clientHeight || 1;
  return Math.min(1, w / SURFACE_W, h / SURFACE_H);
}

function clampZoom(z: number): number {
  return Math.min(ZOOM_MAX, Math.max(fitBoardZoom(), z));
}

/** Sizes the surface and scales the layer for the current zoom. */
function applyZoomLayout(): void {
  surface.style.width = `${SURFACE_W * zoom}px`;
  surface.style.height = `${SURFACE_H * zoom}px`;
  layer.style.transform = `scale(${zoom})`;
  updateCursor();
  zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  surface.classList.toggle("wb-overview", overview);
  overviewBtn.classList.toggle("active", overview);
  placeGrid();
}

/** Changes the zoom, keeping the board point under `anchor` (a screen point)
 *  where it is. With no anchor, the middle of the view stays put. */
function setZoom(next: number, anchor?: { clientX: number; clientY: number }): void {
  const z = clampZoom(next);
  const r = scroller.getBoundingClientRect();
  const ax = anchor ? anchor.clientX - r.left : scroller.clientWidth / 2;
  const ay = anchor ? anchor.clientY - r.top : scroller.clientHeight / 2;
  const bx = (scroller.scrollLeft + ax) / zoom;
  const by = (scroller.scrollTop + ay) / zoom;
  zoom = z;
  applyZoomLayout();
  scrollViewTo(bx * zoom - ax, by * zoom - ay);
}

/** Scrolls the view, and records it as where you are. */
function scrollViewTo(left: number, top: number): void {
  scroller.scrollLeft = Math.max(0, left);
  scroller.scrollTop = Math.max(0, top);
  viewScroll = { x: scroller.scrollLeft, y: scroller.scrollTop };
  scrollDirty = true;
  placeGrid();
  requestRedraw();
}

function toggleOverview(): void {
  endEditing();
  if (overview) {
    overview = false;
    setZoom(1);
  } else {
    overview = true;
    setZoom(fitBoardZoom());
  }
}

/** Out of Overview, at actual size, with the spot clicked under the pointer. */
function leaveOverviewAt(e: PointerEvent): void {
  overview = false;
  setZoom(1, e);
}

/** Brings your notes into view: centered if they fit at this zoom, and
 *  zoomed out just far enough to fit them if they do not. */
function goToNotes(): void {
  endEditing();
  const area = contentArea(true);
  if (!area) return;
  overview = false;
  const w = scroller.clientWidth;
  const h = scroller.clientHeight;
  const fit = Math.min((w - NOTES_MARGIN * 2) / area.w, (h - NOTES_MARGIN * 2) / area.h);
  if (fit < zoom) zoom = clampZoom(fit);
  applyZoomLayout();
  const cx = (area.x + area.w / 2) * zoom;
  const cy = (area.y + area.h / 2) * zoom;
  scrollViewTo(cx - w / 2, cy - h / 2);
}

function onWheel(e: WheelEvent): void {
  // Ctrl+wheel zooms around the pointer, the way it does in most boards.
  // Taken here so it never reaches the webview's own page zoom.
  if (!e.ctrlKey) return;
  e.preventDefault();
  overview = false;
  setZoom(zoom * Math.exp(-e.deltaY * 0.0015), e);
}

function onKeydown(e: KeyboardEvent): void {
  if (document.body.dataset.activeTool !== "productivity/whiteboard") return;
  if (document.body.classList.contains("modal-open")) return;
  // Inside a text box, Ctrl+Z is that box's own typing undo.
  if (isTextEntry(e.target)) return;
  if (e.key === "Escape") {
    if (!colorPop.hidden) closeColorPop();
    else if (overview) toggleOverview();
    else clearSelection();
    return;
  }
  const key = e.key.toLowerCase();
  // The mode keys. Only with nothing held, so they never shadow a shortcut,
  // and never while typing, which the text-entry check above already rules out.
  if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && MODE_KEYS[key]) {
    e.preventDefault();
    setMode(MODE_KEYS[key]);
    return;
  }
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
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
  if (settings.mode === next) return;
  endEditing();
  if (next !== "select") clearSelection();
  settings.mode = next;
  saveSettings();
  updateChrome();
}

function setInk(next: Pen): void {
  settings.ink = next;
  saveSettings();
  updateChrome();
}

function setSize(next: SizeId): void {
  settings.size = next;
  saveSettings();
  updateChrome();
}

function isEmpty(): boolean {
  return strokes.length === 0 && texts.length === 0;
}

/** Everything on screen that reflects state: which mode, pen and size are
 *  picked, and which actions have anything to act on. */
/* The pointer in Draw and Erase is the stroke it will make: a dot the pen's
   size and color, or a ring the eraser's size, at the current zoom. Ringed
   dark then light, so it shows on any board. Chromium drops a cursor image
   past 128px, hence the ceiling; the crosshair in the stylesheet is what is
   left if an image is ever refused. */
const CURSOR_MAX = 120;
const CURSOR_MIN_DOT = 4;

function updateCursor(): void {
  const mode = settings.mode;
  if (overview || (mode !== "draw" && mode !== "erase")) {
    surface.style.removeProperty("cursor");
    return;
  }
  const erase = mode === "erase";
  const width = (erase ? ERASER_WIDTH : PEN_WIDTH)[settings.size] * zoom;
  const d = Math.min(CURSOR_MAX - 4, Math.max(erase ? 6 : CURSOR_MIN_DOT, width));
  const size = Math.ceil(d + 4);
  const c = size / 2;
  const r = d / 2;
  const fill = erase ? "none" : penColor(settings.ink);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
    `<circle cx="${c}" cy="${c}" r="${r + 1}" fill="none" stroke="#ffffff" stroke-width="1"/>` +
    `<circle cx="${c}" cy="${c}" r="${r}" fill="${fill}" stroke="#000000" stroke-width="1"/>` +
    `</svg>`;
  const hot = Math.round(c);
  surface.style.cursor = `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hot} ${hot}, crosshair`;
}

function updateChrome(): void {
  updateCursor();
  for (const m of MODES) surface.classList.toggle(`wb-mode-${m}`, settings.mode === m);
  document.querySelectorAll<HTMLButtonElement>(".wb-mode-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === settings.mode);
  });
  document.querySelectorAll<HTMLButtonElement>(".wb-size-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.size === settings.size);
  });
  paintWithPen(colorChip, settings.ink);
  colorPop.querySelectorAll<HTMLButtonElement>(".wb-swatch[data-ink]").forEach((b) => {
    b.classList.toggle("active", b.dataset.ink === settings.ink);
  });
  if (settings.customInk) {
    colorRecent.hidden = false;
    colorRecent.dataset.ink = settings.customInk;
    paintWithPen(colorRecent, settings.customInk);
    colorRecent.title = settings.customInk;
  } else {
    colorRecent.hidden = true;
  }
  undoBtn.disabled = undoStack.length === 0;
  redoBtn.disabled = redoStack.length === 0;
  clearBtn.disabled = isEmpty();
  sendOpenBtn.disabled = isEmpty();
  noticeWrap.style.display = blocked ? "" : "none";
}

function requestClear(): void {
  endEditing();
  if (isEmpty()) return;
  appConfirm(
    {
      title: "Clear the Whiteboard?",
      message: "Everything on the whiteboard will be removed.",
      confirmLabel: "Clear",
    },
    () => void clearBoard(),
  );
}

async function clearBoard(): Promise<void> {
  checkpoint();
  strokes = [];
  texts = [];
  selection = null;
  recountPoints();
  rebuildTexts();
  showSelection();
  requestRedraw();
  markDirty();
  updateChrome();
  if (await flushSave()) flash("Whiteboard cleared.", "success");
}

/* ── The pen color list ── */

function openColorPop(): void {
  colorPop.hidden = false;
  colorBtn.classList.add("active");
}

function closeColorPop(): void {
  colorPop.hidden = true;
  colorBtn.classList.remove("active");
}

function wireColorPop(): void {
  colorBtn.addEventListener("click", () => {
    if (colorPop.hidden) openColorPop();
    else closeColorPop();
  });
  colorPop.querySelectorAll<HTMLButtonElement>(".wb-swatch[data-ink]").forEach((b) => {
    b.addEventListener("click", () => {
      const pen = b.dataset.ink;
      if (isPen(pen)) setInk(pen);
      closeColorPop();
    });
  });
  document
    .getElementById("wbColorPickBtn")!
    .addEventListener("click", () => pickColorFor({ kind: "pen" }));
  colorInput.addEventListener("change", () => {
    const hex = colorInput.value.toLowerCase();
    if (!isPen(hex)) return;
    settings.customInk = hex;
    const target = colorFor;
    colorFor = { kind: "pen" };
    if (target.kind === "note") {
      saveSettings();
      setNoteStyle(target.id, { ink: hex });
    } else {
      setInk(hex);
    }
    closeColorPop();
  });
  // Anywhere else closes it, the way a dropdown does.
  document.addEventListener("pointerdown", (e) => {
    if (colorPop.hidden) return;
    const t = e.target as Node;
    if (colorPop.contains(t) || colorBtn.contains(t)) return;
    closeColorPop();
  });
}

/* =============================================================================
   SEND TO KANBAN
   -----------------------------------------------------------------------------
   Two ways over, one tab each, sharing the board and column.

   TEXT AS CARDS: every text box, ticked, in reading order. Each one becomes a
   bare card titled with its first line; a box whose text does not fit in a
   title (a second line, or a first line past Kanban's limit) keeps the whole
   of it in the card's description, so nothing typed is lost on the way over.

   IMAGE: the selection, or everything on the board, as a picture on one new
   card, with or without the text boxes in it.

   SEND AND CLEAR ONLY CLEARS WHAT LANDED. Kanban answers once the board is on
   disk, and the whiteboard lets go only then. Cards that were made but not yet
   written are one crash from existing nowhere, and the whiteboard is the other
   copy. For a picture, what is cleared is what lies wholly inside the area:
   a stroke that runs out past its edge stays, since only part of it went.
============================================================================= */

type SendTab = "text" | "image";
type ImageArea = "selection" | "board";

let sendModal: Modal;
let sendTabs: ModalTabs<SendTab>;
let sendBoardSel: HTMLSelectElement;
let sendColumnSel: HTMLSelectElement;
let sendList: HTMLElement;
let sendCount: HTMLElement;
let sendAllBtn: HTMLButtonElement;
let sendEmpty: HTMLElement;
let sendOpenKanbanBtn: HTMLButtonElement;
let sendBtn: HTMLButtonElement;
let sendClearBtn: HTMLButtonElement;
let sendIncludeText: HTMLInputElement;
let sendImageTitle: HTMLInputElement;
let sendPreview: HTMLImageElement;
let sendAreaNote: HTMLElement;
let sendTargets: KanbanTarget[] = [];
let sendChecked = new Set<string>();
let sendArea: ImageArea = "board";
let sendBusy = false;

/** Top to bottom, then left to right, the order a person reads a board in. */
function notesInReadingOrder(): TextNote[] {
  return texts.slice().sort((a, b) => a.y - b.y || a.x - b.x);
}

/** A box as the card it becomes. See the section header for the rule. */
function noteToCard(note: TextNote): IncomingCard {
  const full = note.text.trim();
  const lines = full
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  const firstLine = lines[0] ?? "";

  /* A CHECKLIST: a first line, then only list lines. The first line is the
     title and the list lines are the card's subtasks, ticked where they were
     written as [x]. A box with any plain line after the first is ordinary
     text, and goes over whole in the description. */
  const rest = lines.slice(1);
  if (rest.length > 0 && rest.every((l) => CHECKLIST_LINE.test(l))) {
    return {
      title: cutTitle(firstLine.replace(CHECKLIST_LINE, "")),
      description: "",
      subtasks: rest.map((l) => {
        const m = CHECKLIST_LINE.exec(l)!;
        return { text: l.slice(m[0].length), done: /x/i.test(m[1] ?? m[2] ?? "") };
      }),
    };
  }

  // A list marker is never part of a title, even on a box that is one line.
  const title = cutTitle(firstLine.replace(CHECKLIST_LINE, ""));
  return { title, description: title === full.replace(CHECKLIST_LINE, "") ? "" : full };
}

/** A list line: "- ", "* ", "• ", "[ ] " or "[x] " at the start. The bracket's
 *  contents are captured, to tell a ticked item from an open one. */
const CHECKLIST_LINE = /^(?:[-*•]\s+(?:\[([ xX]?)\]\s*)?|\[([ xX]?)\]\s*)/;

/** A card title within Kanban's limit, cut at a word break where there is one
 *  reasonably near the end, so it is not cut mid-word. */
function cutTitle(line: string): string {
  let title = line.trim();
  if (title.length > MAX_TITLE_LEN) {
    const cut = title.slice(0, MAX_TITLE_LEN - 1);
    const space = cut.lastIndexOf(" ");
    // At a word break when there is one reasonably near the end, so a title is
    // not cut mid-word; otherwise wherever the limit falls.
    title = `${(space > MAX_TITLE_LEN * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
  }
  return title;
}

function openSend(tab?: SendTab, onlyNote?: string): void {
  endEditing();
  closeColorPop();
  if (isEmpty()) return;
  const notes = notesInReadingOrder();
  sendChecked = new Set(onlyNote ? [onlyNote] : notes.map((n) => n.id));
  sendArea = selection ? "selection" : "board";
  sendImageTitle.value = "Whiteboard";
  sendTabs.select(tab ?? (selection || texts.length === 0 ? "image" : "text"));
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
    sendEmpty.textContent = targets === null ? "Kanban is still loading." : "There are no Kanban boards yet.";
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
  const target = settings.target;
  sendBoardSel.value = targets.some((t) => t.id === target?.boardId) ? target!.boardId : targets[0].id;
  fillSendColumns();
}

function fillSendColumns(): void {
  sendColumnSel.replaceChildren();
  const board = sendTargets.find((t) => t.id === sendBoardSel.value);
  if (!board || board.columns.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = board ? "No columns" : "";
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
  const target = settings.target;
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

    const title = document.createElement("span");
    title.className = "wb-send-title";
    const card = noteToCard(note);
    title.textContent = card.title;
    row.title = note.text;
    row.appendChild(title);
    const subtasks = card.subtasks?.length ?? 0;
    if (subtasks > 0) {
      const count = document.createElement("span");
      count.className = "wb-send-meta";
      count.textContent = `${subtasks} ${subtasks === 1 ? "subtask" : "subtasks"}`;
      row.appendChild(count);
    }
    sendList.appendChild(row);
  }
  updateSendButtons();
}

/** The area the Image tab would send right now, or null if there is none. */
function chosenArea(): Area | null {
  if (sendArea === "selection" && selection) return selection;
  return contentArea(sendIncludeText.checked);
}

function renderImageTab(): void {
  document.querySelectorAll<HTMLButtonElement>(".wb-area-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.area === sendArea);
    if (b.dataset.area === "selection") b.disabled = !selection;
  });
  const area = chosenArea();
  if (area) {
    sendPreview.src = renderArea(area, sendIncludeText.checked, PREVIEW_WIDTH).toDataURL("image/png");
    sendPreview.style.display = "";
    sendAreaNote.style.display = "none";
  } else {
    sendPreview.removeAttribute("src");
    sendPreview.style.display = "none";
    sendAreaNote.style.display = "";
  }
  updateSendButtons();
}

function updateSendButtons(): void {
  const total = texts.length;
  const picked = texts.filter((t) => sendChecked.has(t.id)).length;
  sendCount.textContent = `${picked} of ${total}`;
  sendAllBtn.textContent = picked === total ? "Select None" : "Select All";
  const hasTarget = !sendBoardSel.disabled && !sendColumnSel.disabled && !sendBusy;
  const ready =
    hasTarget && (sendTabs.active === "text" ? picked > 0 : chosenArea() !== null);
  sendBtn.disabled = !ready;
  sendClearBtn.disabled = !ready;
}

function toggleSendAll(): void {
  const all = texts.every((t) => sendChecked.has(t.id));
  sendChecked = all ? new Set() : new Set(texts.map((t) => t.id));
  renderSendList();
}

/** The picked board and column, remembered for next time. */
function sendDestination(): { board: KanbanTarget; column: { id: string; title: string } } | null {
  const board = sendTargets.find((t) => t.id === sendBoardSel.value);
  const column = board?.columns.find((c) => c.id === sendColumnSel.value);
  if (!board || !column) return null;
  settings.target = { boardId: board.id, columnId: column.id };
  saveSettings();
  return { board, column };
}

function setSendBusy(busy: boolean): void {
  sendBusy = busy;
  updateSendButtons();
}

async function sendText(clearAfter: boolean): Promise<void> {
  const chosen = notesInReadingOrder().filter((n) => sendChecked.has(n.id));
  const dest = sendDestination();
  if (!dest || chosen.length === 0 || sendBusy) return;

  setSendBusy(true);
  const result = await addCardsFromElsewhere(dest.board.id, dest.column.id, chosen.map(noteToCard));
  setSendBusy(false);
  if (!result.ok) {
    flash(result.error, "error", 8000);
    return;
  }
  sendModal.close();
  if (!result.saved) {
    // Kanban has already said why its write failed.
    flash("Kanban couldn't save the new cards.", "error", 8000);
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
  }
  const n = result.numbers.length;
  flash(`Sent ${n} ${n === 1 ? "card" : "cards"} to "${dest.board.name}".`, "success");
}

async function sendImage(clearAfter: boolean): Promise<void> {
  const area = chosenArea();
  const includeText = sendIncludeText.checked;
  const dest = sendDestination();
  if (!dest || !area || sendBusy) return;

  setSendBusy(true);
  const png = renderArea(area, includeText).toDataURL("image/png").split(",")[1] ?? "";
  const result = await addImageCardFromElsewhere(
    dest.board.id,
    dest.column.id,
    sendImageTitle.value.trim().slice(0, MAX_TITLE_LEN) || "Whiteboard",
    `whiteboard-${fileTimestamp()}.png`,
    png,
  );
  setSendBusy(false);
  if (!result.ok) {
    flash(result.error, "error", 8000);
    return;
  }
  sendModal.close();
  if (!result.saved) {
    flash("Kanban couldn't save the new card.", "error", 8000);
    return;
  }

  if (clearAfter) {
    checkpoint();
    removeInside(area, includeText);
    markDirty();
    updateChrome();
    await flushSave();
  }
  flash(`Sent to "${dest.board.name}".`, "success");
}

/** Takes off the board everything lying wholly inside an area: ink, and text
 *  boxes when they went too. */
function removeInside(area: Area, includeText: boolean): void {
  strokes = strokes.filter((s) => !inside(boundsArea(boundsOf(s)), area));
  if (includeText) texts = texts.filter((t) => !inside(noteArea(t), area));
  selection = null;
  recountPoints();
  rebuildTexts();
  showSelection();
  requestRedraw();
}

function send(clearAfter: boolean): void {
  if (sendTabs.active === "text") void sendText(clearAfter);
  else void sendImage(clearAfter);
}

function wireSendModal(): void {
  sendTabs = new ModalTabs<SendTab>({
    scope: "#wbSendModal",
    key: "wbSendTab",
    panes: { text: "wbSendTabText", image: "wbSendTabImage" },
    onActivate: (tab) => {
      if (tab === "image") renderImageTab();
      else updateSendButtons();
    },
  });
  sendModal = new Modal(document.getElementById("wbSendBackdrop")!, { tabs: sendTabs });
  sendBoardSel = document.getElementById("wbSendBoard") as HTMLSelectElement;
  sendColumnSel = document.getElementById("wbSendColumn") as HTMLSelectElement;
  sendList = document.getElementById("wbSendList")!;
  sendCount = document.getElementById("wbSendCount")!;
  sendAllBtn = document.getElementById("wbSendAllBtn") as HTMLButtonElement;
  sendEmpty = document.getElementById("wbSendEmpty")!;
  sendOpenKanbanBtn = document.getElementById("wbSendOpenKanbanBtn") as HTMLButtonElement;
  sendBtn = document.getElementById("wbSendBtn") as HTMLButtonElement;
  sendClearBtn = document.getElementById("wbSendClearBtn") as HTMLButtonElement;
  sendIncludeText = document.getElementById("wbSendIncludeText") as HTMLInputElement;
  sendImageTitle = document.getElementById("wbSendImageTitle") as HTMLInputElement;
  sendPreview = document.getElementById("wbSendPreview") as HTMLImageElement;
  sendAreaNote = document.getElementById("wbSendAreaEmpty")!;

  document.getElementById("wbSendClose")!.addEventListener("click", () => sendModal.close());
  document.getElementById("wbSendCancelBtn")!.addEventListener("click", () => sendModal.close());
  sendBoardSel.addEventListener("change", fillSendColumns);
  sendColumnSel.addEventListener("change", updateSendButtons);
  sendAllBtn.addEventListener("click", toggleSendAll);
  sendBtn.addEventListener("click", () => send(false));
  sendClearBtn.addEventListener("click", () => send(true));
  sendIncludeText.addEventListener("change", renderImageTab);
  document.querySelectorAll<HTMLButtonElement>(".wb-area-btn").forEach((b) => {
    b.addEventListener("click", () => {
      sendArea = b.dataset.area === "selection" ? "selection" : "board";
      renderImageTab();
    });
  });
  sendOpenKanbanBtn.addEventListener("click", () => {
    sendModal.close();
    navigateToTool("productivity", "kanban");
  });
}

/* =============================================================================
   SETUP
   -----------------------------------------------------------------------------
   Preferences (the grid and the board's color) and Data (the hourly
   snapshots, through the shared list every tool uses). A restore is an
   ordinary save, so what it replaces is captured on the way past, and it is
   also an ordinary Undo step for the rest of the session.
============================================================================= */

type SetupTab = "preferences" | "data";

let setupModal: Modal;
let gridToggle: HTMLInputElement;
let gridLabel: HTMLElement;
let boardColorSel: HTMLSelectElement;
let boardColorInput: HTMLInputElement;
let boardCustomRow: HTMLElement;

/** Every control in Setup, put back to what the settings say. Run on every
 *  open, so a control can never show a value that is not the one in use. */
function applySettingsToForm(): void {
  gridToggle.checked = settings.grid;
  gridLabel.textContent = settings.grid ? "Enabled" : "Disabled";
  boardColorSel.value = settings.boardColor;
  boardColorInput.value = settings.boardCustom;
  boardCustomRow.style.display = settings.boardColor === "custom" ? "" : "none";
}

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
          message: `The whiteboard goes back to ${formatBackupName(snap.name)}.`,
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
    flash("Couldn't read that snapshot.", "error");
    return;
  }

  endEditing();
  checkpoint();
  strokes = parsed.strokes;
  texts = parsed.texts;
  selection = null;
  recountPoints();
  if (blocked) {
    // A restore REPLACES the file, so it may land on one that would not read.
    unblockAfterReplacement("whiteboard", "data");
    blocked = false;
  }
  rebuildTexts();
  showSelection();
  requestRedraw();
  markDirty();
  updateChrome();
  const saved = await flushSave();
  setupModal.close();
  if (saved) flash("Whiteboard restored.", "success");
}

function wireSetup(): void {
  const tabs = new ModalTabs<SetupTab>({
    scope: "#wbSetupModal",
    key: "wbTab",
    panes: { preferences: "wbTabPreferences", data: "wbTabData" },
    onActivate: (tab) => {
      if (tab === "data") void refreshHistory();
    },
  });
  setupModal = new Modal(document.getElementById("wbSetupBackdrop")!, {
    tabs,
    onOpen: applySettingsToForm,
  });
  gridToggle = document.getElementById("wbGridToggle") as HTMLInputElement;
  gridLabel = document.getElementById("wbGridLabel")!;
  boardColorSel = document.getElementById("wbBoardColorSelect") as HTMLSelectElement;
  boardColorInput = document.getElementById("wbBoardColorInput") as HTMLInputElement;
  boardCustomRow = document.getElementById("wbBoardCustomRow")!;

  document.getElementById("wbSetupBtn")!.addEventListener("click", () => {
    endEditing();
    closeColorPop();
    setupModal.open();
  });
  document.getElementById("wbSetupClose")!.addEventListener("click", () => setupModal.close());
  document
    .getElementById("wbHistoryRefreshBtn")!
    .addEventListener("click", () => void refreshHistory());

  gridToggle.addEventListener("change", () => {
    settings.grid = gridToggle.checked;
    saveSettings();
    applySettingsToForm();
    applyBoardLook();
  });
  boardColorSel.addEventListener("change", () => {
    const next = boardColorSel.value as BoardColor;
    if (!BOARD_COLORS.includes(next)) return;
    settings.boardColor = next;
    saveSettings();
    applySettingsToForm();
    applyBoardLook();
  });
  // "input" as well as "change": the board follows the picker while it is open.
  const takeCustom = (): void => {
    const hex = boardColorInput.value.toLowerCase();
    if (!/^#[0-9a-f]{6}$/.test(hex)) return;
    settings.boardCustom = hex;
    applyBoardLook();
  };
  boardColorInput.addEventListener("input", takeCustom);
  boardColorInput.addEventListener("change", () => {
    takeCustom();
    saveSettings();
  });
}

/* =============================================================================
   MENUS
============================================================================= */

function surfaceMenu(e: MouseEvent): MenuItem[] | null {
  if (!loaded) return null;
  const boxEl = (e.target as HTMLElement).closest<HTMLElement>(".wb-text");
  const id = boxEl?.dataset.id;
  if (id && id !== editingId) {
    const note = noteById(id);
    return [
      { label: "Edit", onClick: () => beginEditing(id) },
      { label: "Color", submenu: noteColorMenu(id, note?.ink) },
      {
        label: "Size",
        submenu: SIZES.map((sz) => ({
          label: SIZE_LABELS[sz],
          disabled: note?.size === sz,
          onClick: () => setNoteStyle(id, { size: sz }),
        })),
      },
      { label: "Send to Kanban…", onClick: () => openSend("text", id) },
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
    { label: "Send to Kanban…", disabled: isEmpty(), onClick: () => openSend() },
    { label: "Send Selection to Kanban…", disabled: !selection, onClick: () => openSend("image") },
    { label: "Clear Whiteboard…", danger: true, disabled: isEmpty(), onClick: requestClear },
    // A menu on a background carries the app-wide rows, or it has removed them.
    { separator: true },
    ...backgroundMenu(),
  ];
}

const SIZE_LABELS: Record<SizeId, string> = { fine: "Fine", medium: "Medium", bold: "Bold" };

/** A color as #rrggbb, for a menu row's swatch, or undefined when the theme's
 *  value is not a plain opaque color the swatch could show. */
function toHex(color: string): string | undefined {
  const c = document.createElement("canvas").getContext("2d");
  if (!c) return undefined;
  c.fillStyle = "#000000";
  c.fillStyle = color;
  return /^#[0-9a-f]{6}$/i.test(c.fillStyle) ? c.fillStyle : undefined;
}

/** The pens, plus the last hand-picked color and a way to pick another, for
 *  one text box. */
function noteColorMenu(id: string, current: Pen | undefined): MenuItem[] {
  const rows: MenuItem[] = INKS.map((i) => ({
    label: i.label,
    swatch: toHex(penColor(i.id)),
    disabled: current === i.id,
    onClick: () => setNoteStyle(id, { ink: i.id }),
  }));
  const custom = settings.customInk;
  if (custom) {
    rows.push({
      label: custom,
      swatch: custom,
      disabled: current === custom,
      onClick: () => setNoteStyle(id, { ink: custom }),
    });
  }
  rows.push({ separator: true }, { label: "Custom…", onClick: () => pickColorFor({ kind: "note", id }) });
  return rows;
}

/** Recolors or resizes one text box, as one Undo step. */
function setNoteStyle(id: string, patch: { ink?: Pen; size?: SizeId }): void {
  endEditing();
  const note = noteById(id);
  if (!note) return;
  if ((patch.ink === undefined || patch.ink === note.ink) && (patch.size === undefined || patch.size === note.size)) {
    return;
  }
  checkpoint();
  if (patch.ink !== undefined) note.ink = patch.ink;
  if (patch.size !== undefined) note.size = patch.size;
  const el = noteEls.get(id);
  if (el) {
    paintWithPen(el, note.ink);
    for (const sz of SIZES) el.classList.toggle(`wb-tsize-${sz}`, sz === note.size);
  }
  markDirty();
  updateChrome();
}

/** Opens the system color picker for the pen or for one text box. */
function pickColorFor(target: typeof colorFor): void {
  colorFor = target;
  const note = target.kind === "note" ? noteById(target.id) : null;
  const start = note ? note.ink : settings.ink;
  colorInput.value = isInk(start) ? settings.customInk ?? toHex(penColor(start)) ?? "#ff4f81" : start;
  colorInput.click();
}

function typeAtMenuPoint(): void {
  const at = menuPoint;
  if (!at) return;
  setMode("type");
  endEditing();
  createNoteAt(at.x - NEW_BOX_NUDGE_X, at.y - NEW_BOX_NUDGE_Y * TEXT_REM[settings.size]);
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
  closeColorPop();
  // Put back on the way in: the scroller is about to be hidden, which loses it.
  if (loaded) pendingScroll = { ...viewScroll };
  await flushSave();
}

export function initWhiteboard(): void {
  toolView = document.getElementById("productivity-tool-whiteboard")!;
  stage = document.getElementById("wbStage")!;
  canvas = document.getElementById("wbInk") as HTMLCanvasElement;
  ctx = canvas.getContext("2d")!;
  scroller = document.getElementById("wbScroller")!;
  surface = document.getElementById("wbSurface")!;
  undoBtn = document.getElementById("wbUndoBtn") as HTMLButtonElement;
  redoBtn = document.getElementById("wbRedoBtn") as HTMLButtonElement;
  sendOpenBtn = document.getElementById("wbSendOpenBtn") as HTMLButtonElement;
  clearBtn = document.getElementById("wbClearBtn") as HTMLButtonElement;
  colorBtn = document.getElementById("wbColorBtn") as HTMLButtonElement;
  colorChip = document.getElementById("wbColorChip")!;
  colorPop = document.getElementById("wbColorPop")!;
  colorRecent = document.getElementById("wbColorRecent") as HTMLButtonElement;
  colorInput = document.getElementById("wbColorInput") as HTMLInputElement;
  noticeWrap = document.getElementById("wbHeaderNoticeWrap")!;
  notice = document.getElementById("wbHeaderNotice")!;
  notice.textContent = "Not saving";

  zoomLabel = document.getElementById("wbZoomResetBtn") as HTMLButtonElement;
  overviewBtn = document.getElementById("wbOverviewBtn") as HTMLButtonElement;

  layer = document.createElement("div");
  layer.className = "wb-layer";
  layer.style.width = `${SURFACE_W}px`;
  layer.style.height = `${SURFACE_H}px`;
  surface.appendChild(layer);

  selectionEl = document.createElement("div");
  selectionEl.className = "wb-selection";
  selectionEl.style.display = "none";
  layer.appendChild(selectionEl);

  applyZoomLayout();

  surface.addEventListener("pointerdown", onSurfacePointerDown);
  surface.addEventListener("pointermove", onSurfacePointerMove);
  surface.addEventListener("pointerup", onSurfacePointerUp);
  surface.addEventListener("pointercancel", onSurfacePointerUp);
  // A dropped file would otherwise be opened by the webview in place of the app.
  surface.addEventListener("dragover", (e) => e.preventDefault());
  surface.addEventListener("drop", (e) => e.preventDefault());
  scroller.addEventListener("scroll", onScroll, { passive: true });
  // Not passive: Ctrl+wheel has to be kept from the webview's page zoom.
  scroller.addEventListener("wheel", onWheel, { passive: false });
  new ResizeObserver(() => {
    // Overview is "the whole board", so it follows the window's size.
    if (overview && scroller.clientWidth > 0) {
      zoom = fitBoardZoom();
      applyZoomLayout();
    }
    applyPendingScroll();
    requestRedraw();
  }).observe(scroller);

  document.querySelectorAll<HTMLButtonElement>(".wb-mode-btn").forEach((b) => {
    b.addEventListener("click", () => setMode(b.dataset.mode as Mode));
  });
  document.querySelectorAll<HTMLButtonElement>(".wb-size-btn").forEach((b) => {
    b.addEventListener("click", () => setSize(b.dataset.size as SizeId));
  });
  undoBtn.addEventListener("click", undo);
  redoBtn.addEventListener("click", redo);
  sendOpenBtn.addEventListener("click", () => openSend());
  document.getElementById("wbZoomOutBtn")!.addEventListener("click", () => {
    overview = false;
    setZoom(zoom / ZOOM_STEP);
  });
  document.getElementById("wbZoomInBtn")!.addEventListener("click", () => {
    overview = false;
    setZoom(zoom * ZOOM_STEP);
  });
  zoomLabel.addEventListener("click", () => {
    overview = false;
    setZoom(1);
  });
  overviewBtn.addEventListener("click", toggleOverview);
  document.getElementById("wbNotesBtn")!.addEventListener("click", goToNotes);
  clearBtn.addEventListener("click", requestClear);
  document.addEventListener("keydown", onKeydown);
  wireColorPop();

  attachMenu(surface, surfaceMenu);

  wireSendModal();
  wireSetup();

  window.addEventListener("themechange", () => {
    resolveInkColors();
    updateCursor();
    requestRedraw();
  });

  updateChrome();
  void load();
}
