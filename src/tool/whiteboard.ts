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
import { appConfirm, backgroundMenu, flash, navigateToTool, flushOnQuit } from "../core/shell";
import {
  addCardsFromElsewhere,
  addImageCardFromElsewhere,
  attachImageToCard,
  findCardsOnBoard,
  effortChoices,
  priorityChoices,
  type IncomingOptions,
  type LevelChoice,
  contrastRatio,
  hexToRgb,
  isHexColor,
  kanbanTargets,
  readableTextOn,
  type IncomingCard,
  type KanbanTarget,
} from "./kanban";
import {
  MAX_TITLE_LEN,
  NO_LEVEL,
  type Effort,
  type Priority,
} from "./kanban-model";

/* =============================================================================
   TYPES AND LIMITS
============================================================================= */

type Mode = "type" | "draw" | "shape" | "erase" | "select";

/** What Shapes draws. */
type ShapeKind = "line" | "arrow" | "box" | "ellipse";

/** Rub Out takes ink off where it passes, like a real eraser. Whole Strokes
 *  removes any stroke it touches, which also gives back the room it took. */
type EraserKind = "rub" | "stroke";

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
  /** A shape rather than a freehand line, drawn between the two corners in
   *  pts. "clear" is a cleared rectangle (with erase set): what Delete and Cut
   *  leave behind, so an area is emptied without touching the parts of a
   *  stroke that run out past its edge. */
  shape?: ShapeKind | "clear";
  /** Drawn only inside this rectangle, [x, y, w, h]. A pasted stroke carries
   *  the edge of the area it was copied from, so a line that ran out of the
   *  copied area is cut where the copy was cut. */
  clip?: [number, number, number, number];
  /** Rectangles this stroke is not drawn in, each [x, y, w, h]. Restyling part
   *  of a line leaves a hole in it where the selection was, and a restyled copy
   *  clipped to that same rectangle on top, so the change lands exactly inside
   *  the selection and nowhere else, whichever way the line runs through it. */
  holes?: [number, number, number, number][];
  /** Board coordinates as flat x,y pairs. */
  pts: number[];
}

interface TextNote {
  id: string;
  x: number;
  y: number;
  /** The box's own color and size, which any run without its own follows. */
  ink: Pen;
  size: SizeId;
  /** The box's plain text, always. What goes to Kanban, and what a box with
   *  no runs is drawn from. */
  text: string;
  /** Stretches styled apart from the box, in order, together spelling out
   *  `text` exactly. Absent when the whole box is in its own color and size. */
  runs?: TextRun[];
}

/** A stretch of a text box in a color or size of its own. It carries only
 *  what differs from the box. */
interface TextRun {
  text: string;
  ink?: Pen;
  size?: SizeId;
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
  /** After Send and Clear, go back to the top-left corner at actual size, where
   *  a new board starts. */
  homeAfterSend: boolean;
  /** A color or size picked with a selection also restyles the text boxes in
   *  it, not only the ink. */
  selectionStylesText: boolean;
  boardColor: BoardColor;
  /** The Custom board color, kept while another choice is in use so switching
   *  back does not lose it. */
  boardCustom: string;
  mode: Mode;
  shape: ShapeKind;
  eraser: EraserKind;
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

/** The least contrast a theme pen is allowed against the board before it is
 *  nudged toward readable. Low on purpose: this is "can you see the line",
 *  not body-text legibility, and a pen should keep looking like its color. */
const MIN_PEN_CONTRAST = 2;
/** At most this many tenths of the way toward readable ink. */
const PEN_NUDGE_STEPS = 7;

/** Pen widths in board pixels. The eraser is wider than the pen at every size,
 *  because rubbing out a fine line with a fine eraser takes several passes. */
const PEN_WIDTH: Record<SizeId, number> = { fine: 2, medium: 4, bold: 8 };
const ERASER_WIDTH: Record<SizeId, number> = { fine: 10, medium: 20, bold: 40 };

const MODES: readonly Mode[] = ["type", "draw", "shape", "erase", "select"];
const SHAPES: readonly ShapeKind[] = ["line", "arrow", "box", "ellipse"];
const ERASERS: readonly EraserKind[] = ["rub", "stroke"];

/** The single keys that switch mode, while not typing in a box. */
const MODE_KEYS: Record<string, Mode> = { t: "type", d: "draw", q: "shape", e: "erase", s: "select" };
const SIZES: readonly SizeId[] = ["fine", "medium", "bold"];
const BOARD_COLORS: readonly BoardColor[] = ["theme", "black", "white", "custom"];

const DEFAULT_SETTINGS: WhiteboardSettings = {
  grid: false,
  homeAfterSend: true,
  selectionStylesText: true,
  boardColor: "theme",
  boardCustom: "#fdf6e3",
  mode: "type",
  shape: "box",
  eraser: "rub",
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
/** Holes one stroke can carry, one per restyle that cut through it. Past this a
 *  hand-edited file is trimmed rather than drawn slowly forever. */
const MAX_HOLES = 64;

/** How far an arrow's head spreads from its line, in radians. */
const ARROW_SPREAD = Math.PI / 7;
/** Points around an ellipse when telling whether the eraser touches it. */
const ELLIPSE_SAMPLES = 48;
/** Shift snaps a shape's line to multiples of this angle. */
const SNAP_ANGLE = Math.PI / 4;

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
/** The zooms the buttons and the wheel step through, so each step is one of
 *  these rather than a factor of wherever you happened to be. The floor below
 *  the first is Overview's, and is reached by stepping past it. */
const ZOOM_LEVELS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
/** Wheel travel that makes one zoom step: one notch of an ordinary mouse. */
const WHEEL_PER_STEP = 100;
/** Spacing of the grid's dots at actual size, in board pixels. */
const GRID_STEP = 24;
/** The grid fades out between these on-screen spacings as you zoom out, rather
 *  than crowding into a grey wash. */
const GRID_FADE_FROM = 12;
const GRID_FADE_TO = 6;
/** How far past the view the ink is drawn, in screen pixels, so a quick scroll
 *  shows ink already there rather than a blank edge waiting for the redraw. */
const INK_OVERSCAN = 256;
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
/** The stroke as it stood when Shift went down. While Shift is held, the
 *  stroke is that plus one straight line from its last point to the pointer. */
let straightBase: number[] | null = null;

/** The whole-stroke eraser mid-swipe. */
let wipe: { pointerId: number; pre: Snapshot; removed: boolean; last: { x: number; y: number } } | null = null;

/** The selection's contents being dragged somewhere else. */
let areaMove: {
  pointerId: number;
  start: { x: number; y: number };
  area: Area;
  pre: Snapshot;
  data: AreaData | null;
  base: Stroke[];
  notes: TextNote[];
  moved: boolean;
} | null = null;

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

/** Wheel travel not yet spent on a zoom step. */
let wheelCarry = 0;

/** The canvas's top-left corner, in surface pixels, as of the last redraw.
 *  The canvas sits inside the scrolling surface so it moves with the text and
 *  the grid, and is put back over the view each redraw. */
let inkOrigin = { x: 0, y: 0 };

/** The last point on the board under the pointer, which is where a paste lands. */
let lastPointer: { x: number; y: number } | null = null;

/** What Copy and Cut took: an area's ink and text, relative to its corner. */
let clipboard: { w: number; h: number; strokes: Stroke[]; texts: TextNote[] } | null = null;

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
    ...(strokeShape(r.shape, r.erase === true) && pts.length >= 4
      ? { shape: strokeShape(r.shape, r.erase === true)! }
      : {}),
    ...(normalizeClip(r.clip) ? { clip: normalizeClip(r.clip)! } : {}),
    ...(normalizeHoles(r.holes) ? { holes: normalizeHoles(r.holes)! } : {}),
    pts,
  };
}

/** A stored shape name, or null for a freehand line. "rect" is what a cleared
 *  area was called before shapes arrived, on boards drawn in development. */
function strokeShape(raw: unknown, erase: boolean): ShapeKind | "clear" | null {
  if (erase) return raw === "clear" || raw === "rect" ? "clear" : null;
  return SHAPES.includes(raw as ShapeKind) ? (raw as ShapeKind) : null;
}

function normalizeHoles(raw: unknown): [number, number, number, number][] | null {
  if (!Array.isArray(raw)) return null;
  const holes = raw
    .map(normalizeClip)
    .filter((h): h is [number, number, number, number] => h !== null)
    .slice(0, MAX_HOLES);
  return holes.length > 0 ? holes : null;
}

function normalizeClip(raw: unknown): [number, number, number, number] | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  const n = raw.map(Number);
  if (!n.every(Number.isFinite) || n[2] <= 0 || n[3] <= 0) return null;
  return [n[0], n[1], n[2], n[3]];
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
    ...(normalizeStoredRuns(r.runs, text) ? { runs: normalizeStoredRuns(r.runs, text)! } : {}),
  };
}

/** Runs from disk, kept only if they spell out the box's text exactly. Runs
 *  that disagree with the text are dropped whole: the text is what matters,
 *  and a box drawn in one color is a smaller loss than one drawn wrong. */
function normalizeStoredRuns(raw: unknown, text: string): TextRun[] | null {
  if (!Array.isArray(raw)) return null;
  const runs: TextRun[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return null;
    const r = item as Record<string, unknown>;
    if (typeof r.text !== "string") return null;
    const run: TextRun = { text: r.text };
    if (isPen(r.ink)) run.ink = r.ink;
    if (SIZES.includes(r.size as SizeId)) run.size = r.size as SizeId;
    runs.push(run);
  }
  if (runs.map((r) => r.text).join("") !== text) return null;
  return runs.some((r) => r.ink !== undefined || r.size !== undefined) ? runs : null;
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
    grid: r.grid === true,
    homeAfterSend: r.homeAfterSend !== false,
    selectionStylesText: r.selectionStylesText !== false,
    boardColor: BOARD_COLORS.includes(r.boardColor as BoardColor)
      ? (r.boardColor as BoardColor)
      : DEFAULT_SETTINGS.boardColor,
    boardCustom: hex(r.boardCustom) ? r.boardCustom : DEFAULT_SETTINGS.boardCustom,
    mode: MODES.includes(r.mode as Mode) ? (r.mode as Mode) : DEFAULT_SETTINGS.mode,
    shape: SHAPES.includes(r.shape as ShapeKind) ? (r.shape as ShapeKind) : DEFAULT_SETTINGS.shape,
    eraser: ERASERS.includes(r.eraser as EraserKind) ? (r.eraser as EraserKind) : DEFAULT_SETTINGS.eraser,
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
  // --wb-ink is set by resolveInkColors, below, for every board.
  if (hex) {
    const ink = readableTextOn(hex);
    toolView.style.setProperty("--wb-board", hex);
    toolView.style.setProperty("--wb-dot", `color-mix(in srgb, ${ink} 22%, transparent)`);
  } else {
    toolView.style.removeProperty("--wb-board");
    toolView.style.removeProperty("--wb-dot");
  }
  stage.classList.toggle("wb-no-grid", !settings.grid);
  resolveInkColors();
  updateCursor();
  requestRedraw();
}

/**
 * Reads the pens out of the live theme, as they will look on this board.
 * Called at load, on every theme change, when the board's color changes, and
 * on entry, since a custom palette can change under the tool.
 *
 * A PEN IS NUDGED UNTIL IT SHOWS. The five theme pens are a theme's chart
 * colors, chosen to read on its panels, not on its board: a few themes carry
 * one that nearly vanishes there (Rainbow's third, Valentine's fourth), and on
 * a Black, White or Custom board any of them can. Such a pen is mixed toward
 * whichever of dark or light reads on the board, a step at a time, only until
 * it clears MIN_PEN_CONTRAST, so it stays recognizably the color it was. The
 * result is handed to the stylesheet as --wb-pen-*, so a typed line and a
 * drawn one in the same pen are the same color. A color picked by hand is
 * never nudged: that was a choice, not a theme's accident.
 */
function resolveInkColors(): void {
  const style = getComputedStyle(document.documentElement);
  const board = boardHex() ?? toHex(getComputedStyle(toolView).getPropertyValue("--color-input-bg").trim()) ?? null;
  for (const i of INKS) {
    let color = style.getPropertyValue(i.cssVar).trim() || "#888888";
    if (i.id === "ink" && boardHex()) color = readableTextOn(boardHex()!);
    if (board) color = legibleOn(color, board);
    inkColors.set(i.id, color);
    toolView.style.setProperty(i.id === "ink" ? "--wb-ink" : `--wb-pen-${i.id}`, color);
  }
}

/** A color moved toward the readable ink for a board only as far as it needs
 *  to be seen on it. See resolveInkColors. */
function legibleOn(color: string, board: string): string {
  const from = toHex(color);
  const to = readableTextOn(board);
  if (!from || contrastRatio(from, board) >= MIN_PEN_CONTRAST) return from ?? color;
  let mixed = from;
  for (let step = 1; step <= PEN_NUDGE_STEPS; step++) {
    mixed = mixHex(from, to, step / 10);
    if (contrastRatio(mixed, board) >= MIN_PEN_CONTRAST) break;
  }
  return mixed;
}

/** a mixed t of the way toward b, as #rrggbb. */
function mixHex(a: string, b: string, t: number): string {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  if (!x || !y) return a;
  const ch = (p: number, q: number): string =>
    Math.round(p + (q - p) * t)
      .toString(16)
      .padStart(2, "0");
  return `#${ch(x.r, y.r)}${ch(x.g, y.g)}${ch(x.b, y.b)}`;
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
  const pad =
    s.shape === "clear" ? 0 : strokeWidth(s) / 2 + 1 + (s.shape === "arrow" ? arrowHead(s) : 0);
  let b: [number, number, number, number] = [minX - pad, minY - pad, maxX + pad, maxY + pad];
  if (s.clip) {
    const [cx, cy, cw, ch] = s.clip;
    b = [Math.max(b[0], cx), Math.max(b[1], cy), Math.min(b[2], cx + cw), Math.min(b[3], cy + ch)];
  }
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
  if (!s.clip && !s.holes) {
    drawStrokeShape(c, s);
    return;
  }
  c.save();
  if (s.clip) {
    c.beginPath();
    c.rect(...s.clip);
    c.clip();
  }
  // Each hole is its own clip, the board with that rectangle cut out of it.
  // Clips stack by intersection, so the stroke is kept out of every hole,
  // however they overlap.
  for (const hole of s.holes ?? []) {
    c.beginPath();
    c.rect(-SURFACE_W, -SURFACE_H, SURFACE_W * 3, SURFACE_H * 3);
    c.rect(...hole);
    c.clip("evenodd");
  }
  drawStrokeShape(c, s);
  c.restore();
}

function drawStrokeShape(c: CanvasRenderingContext2D, s: Stroke): void {
  styleFor(c, s);
  const p = s.pts;
  if (s.shape === "clear") {
    c.fillRect(p[0], p[1], p[2] - p[0], p[3] - p[1]);
    return;
  }
  if (s.shape) {
    drawShape(c, s);
    return;
  }
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

/** How long an arrow's head is, for its line width. */
function arrowHead(s: Stroke): number {
  return Math.max(12, strokeWidth(s) * 4);
}

/** A line, arrow, box or ellipse between the two corners in pts. */
function drawShape(c: CanvasRenderingContext2D, s: Stroke): void {
  const [x0, y0, x1, y1] = s.pts;
  c.beginPath();
  if (s.shape === "box") {
    c.rect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
  } else if (s.shape === "ellipse") {
    c.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, Math.PI * 2);
  } else {
    c.moveTo(x0, y0);
    c.lineTo(x1, y1);
    if (s.shape === "arrow" && (x1 !== x0 || y1 !== y0)) {
      const angle = Math.atan2(y1 - y0, x1 - x0);
      const head = arrowHead(s);
      for (const side of [-1, 1]) {
        c.moveTo(x1, y1);
        c.lineTo(x1 - head * Math.cos(angle + side * ARROW_SPREAD), y1 - head * Math.sin(angle + side * ARROW_SPREAD));
      }
    }
  }
  c.stroke();
}

/** Points along a stroke as it is drawn, for telling whether a point is on it. */
function strokePath(s: Stroke): number[] {
  if (!s.shape) return s.pts;
  const [x0, y0, x1, y1] = s.pts;
  if (s.shape === "box" || s.shape === "clear") return [x0, y0, x1, y0, x1, y1, x0, y1, x0, y0];
  if (s.shape === "ellipse") {
    const out: number[] = [];
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const rx = Math.abs(x1 - x0) / 2;
    const ry = Math.abs(y1 - y0) / 2;
    for (let i = 0; i <= ELLIPSE_SAMPLES; i++) {
      const t = (i / ELLIPSE_SAMPLES) * Math.PI * 2;
      out.push(cx + rx * Math.cos(t), cy + ry * Math.sin(t));
    }
    return out;
  }
  return [x0, y0, x1, y1];
}

function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Whether a circle of radius r at (x, y) touches a stroke's drawn line. */
function touchesStroke(s: Stroke, x: number, y: number, r: number): boolean {
  if (s.clip) {
    const [cx, cy, cw, ch] = s.clip;
    if (x < cx - r || y < cy - r || x > cx + cw + r || y > cy + ch + r) return false;
  }
  // Nothing of it is drawn inside a hole, so nothing there can be touched.
  if (s.holes?.some(([hx, hy, hw, hh]) => x >= hx && y >= hy && x <= hx + hw && y <= hy + hh)) return false;
  const reach = r + strokeWidth(s) / 2;
  const p = strokePath(s);
  if (p.length === 2) return Math.hypot(x - p[0], y - p[1]) <= reach;
  for (let i = 0; i + 3 < p.length; i += 2) {
    if (distanceToSegment(x, y, p[i], p[i + 1], p[i + 2], p[i + 3]) <= reach) return true;
  }
  return false;
}

/** The canvas's transform: backing pixels to CSS pixels, then the board
 *  moved to where the canvas sits on the surface. */
function applyViewTransform(): void {
  const dpr = window.devicePixelRatio || 1;
  const k = dpr * zoom;
  ctx.setTransform(k, 0, 0, k, -inkOrigin.x * dpr, -inkOrigin.y * dpr);
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

  /* The view plus a margin on every side, clamped to the surface. The canvas
     is placed there on the surface itself, so between redraws it scrolls with
     the text and the grid instead of trailing them by a frame. */
  const surfW = SURFACE_W * zoom;
  const surfH = SURFACE_H * zoom;
  const left = Math.max(0, scroller.scrollLeft - INK_OVERSCAN);
  const top = Math.max(0, scroller.scrollTop - INK_OVERSCAN);
  const cw = Math.max(1, Math.min(surfW - left, w + INK_OVERSCAN * 2));
  const ch = Math.max(1, Math.min(surfH - top, h + INK_OVERSCAN * 2));
  inkOrigin = { x: left, y: top };
  canvas.style.left = `${left}px`;
  canvas.style.top = `${top}px`;

  const dpr = window.devicePixelRatio || 1;
  const bw = Math.round(cw * dpr);
  const bh = Math.round(ch * dpr);
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
    canvas.style.width = `${cw}px`;
    canvas.style.height = `${ch}px`;
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  applyViewTransform();

  const view: Area = { x: left / zoom, y: top / zoom, w: cw / zoom, h: ch / zoom };
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
  straightBase = null;
  liveStroke = {
    id: newId(),
    ink: settings.ink,
    size: settings.size,
    erase: settings.mode === "erase",
    pts: [round1(x), round1(y)],
  };
  if (settings.mode === "shape") {
    liveStroke.shape = settings.shape;
    liveStroke.pts.push(round1(x), round1(y));
  }
  surface.setPointerCapture(e.pointerId);
  applyViewTransform();
  drawStroke(ctx, liveStroke);
}

/** A shape's far corner, with Shift held: a square, a circle, or a line at a
 *  multiple of 45 degrees. */
function constrainCorner(kind: ShapeKind, x0: number, y0: number, x: number, y: number): [number, number] {
  const dx = x - x0;
  const dy = y - y0;
  if (kind === "box" || kind === "ellipse") {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    return [x0 + Math.sign(dx || 1) * side, y0 + Math.sign(dy || 1) * side];
  }
  const angle = Math.round(Math.atan2(dy, dx) / SNAP_ANGLE) * SNAP_ANGLE;
  const len = Math.hypot(dx, dy);
  return [x0 + Math.cos(angle) * len, y0 + Math.sin(angle) * len];
}

function extendStroke(e: PointerEvent): void {
  const stroke = liveStroke;
  if (!stroke) return;
  /* The coalesced events are every sample the mouse reported since the last
     frame. Taking only the one the event carries draws a fast scribble as a
     handful of straight lines. */
  const samples = e.getCoalescedEvents?.() ?? [];
  const events = samples.length > 0 ? samples : [e];

  // A shape only ever has its two corners; the far one follows the pointer.
  if (stroke.shape && stroke.shape !== "clear") {
    const { x, y } = boardPoint(e);
    const [fx, fy] = e.shiftKey ? constrainCorner(stroke.shape, stroke.pts[0], stroke.pts[1], x, y) : [x, y];
    stroke.pts[2] = round1(clampX(fx));
    stroke.pts[3] = round1(clampY(fy));
    requestRedraw();
    return;
  }

  /* Shift in Draw rules a straight line from wherever the stroke is to the
     pointer. Letting go goes back to freehand from the end of that line, and
     pressing it again rules the next one, so a stroke can be part drawn and
     part ruled. */
  if (e.shiftKey) {
    straightBase ??= stroke.pts.slice();
    const { x, y } = boardPoint(e);
    stroke.pts = straightBase.concat(round1(x), round1(y));
    requestRedraw();
    return;
  }
  if (straightBase) {
    straightBase = null;
    requestRedraw();
  }

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
  straightBase = null;
  if (!stroke || !pre) return;
  // A shape dragged out to nothing (a click) is not worth keeping.
  if (stroke.shape && stroke.pts[0] === stroke.pts[2] && stroke.pts[1] === stroke.pts[3]) {
    requestRedraw();
    return;
  }
  strokes.push(stroke);
  totalPoints += stroke.pts.length / 2;
  pushUndo(pre);
  requestRedraw();
  markDirty();
  updateChrome();
}

/* ── The whole-stroke eraser ── */

function startWipe(e: PointerEvent): void {
  wipe = { pointerId: e.pointerId, pre: snapshot(), removed: false, last: boardPoint(e) };
  surface.setPointerCapture(e.pointerId);
  wipeAt(wipe.last.x, wipe.last.y);
}

/** Removes every stroke the eraser touches at a point. Eraser strokes and
 *  cleared areas are left alone: taking one away would bring back the ink it
 *  had rubbed out. */
function wipeAt(x: number, y: number): void {
  if (!wipe) return;
  const r = ERASER_WIDTH[settings.size] / 2;
  const before = strokes.length;
  strokes = strokes.filter((s) => {
    if (s.erase) return true;
    const b = boundsOf(s);
    if (x < b[0] - r || x > b[2] + r || y < b[1] - r || y > b[3] + r) return true;
    return !touchesStroke(s, x, y, r);
  });
  if (strokes.length !== before) {
    wipe.removed = true;
    recountPoints();
    requestRedraw();
  }
}

/** Follows the pointer in steps no wider than half the eraser, so a fast
 *  swipe cannot jump over a thin line between two samples. */
function extendWipe(e: PointerEvent): void {
  if (!wipe) return;
  const step = ERASER_WIDTH[settings.size] / 4;
  const samples = e.getCoalescedEvents?.() ?? [];
  for (const ev of samples.length > 0 ? samples : [e]) {
    const to = boardPoint(ev);
    const from = wipe.last;
    const n = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / step));
    for (let i = 1; i <= n; i++) wipeAt(from.x + ((to.x - from.x) * i) / n, from.y + ((to.y - from.y) * i) / n);
    wipe.last = to;
  }
}

function endWipe(): void {
  const done = wipe;
  wipe = null;
  if (!done?.removed) return;
  pushUndo(done.pre);
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
  renderRuns(el, note);
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
  updateChrome();
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
    const runs = tidyRuns(readRuns(el), note);
    const text = runs.map((r) => r.text).join("");
    if (text.trim() === "") {
      texts = texts.filter((t) => t.id !== id);
      noteEls.delete(id);
      el.remove();
    } else {
      setNoteRuns(note, runs);
      // What was saved, not what was typed: trailing space is gone, and the
      // box should show that now rather than after the next rebuild.
      renderRuns(el, note);
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
   STYLED TEXT
   -----------------------------------------------------------------------------
   While a box is being typed in, the toolbar's color and size apply to it
   rather than taking the focus away: to the selected text when some is
   selected, and to the whole box when the caret is only sitting there.

   Every change goes through PLAIN-TEXT OFFSETS, not the DOM. The box's runs
   are read out, the style is applied to characters start..end, the runs are
   tidied and drawn back in, and the selection is put back at the same
   offsets. Working on the DOM directly would nest a span in a span every time
   a range was restyled, and the box would slowly become unreadable markup.
============================================================================= */

/** What the selection in the box being typed in was, as plain-text offsets. */
interface EditSelection {
  id: string;
  start: number;
  end: number;
}

/** The selection held while the system color picker is open, which takes the
 *  focus and can drop it. */
let pickerSelection: EditSelection | null = null;

/** A box's runs, one run standing for the whole box when it has none. */
function noteRuns(note: TextNote): TextRun[] {
  return note.runs ?? [{ text: note.text }];
}

/** Draws a box's text into its element: plain text nodes for what follows the
 *  box, spans for runs of their own. Built as nodes, never markup: this is
 *  text somebody typed. */
function renderRuns(el: HTMLElement, note: TextNote): void {
  paintWithPen(el, note.ink);
  for (const sz of SIZES) el.classList.toggle(`wb-tsize-${sz}`, sz === note.size);
  el.replaceChildren(
    ...noteRuns(note).map((run) => {
      if (run.ink === undefined && run.size === undefined) return document.createTextNode(run.text);
      const span = document.createElement("span");
      span.className = "wb-run";
      if (run.ink !== undefined) {
        span.dataset.ink = run.ink;
        paintWithPen(span, run.ink);
      }
      if (run.size !== undefined) {
        span.dataset.size = run.size;
        span.classList.add(`wb-tsize-${run.size}`);
      }
      span.textContent = run.text;
      return span;
    }),
  );
}

/** The runs a box's element holds right now, as typed. Reads what the browser
 *  may have put there as well as what renderRuns did: a <br> or a new block
 *  is a line break. */
function readRuns(root: Node): TextRun[] {
  const out: TextRun[] = [];
  const push = (text: string, style: { ink?: Pen; size?: SizeId }): void => {
    if (text) out.push({ text, ...style });
  };
  const endsWithBreak = (): boolean => {
    const last = out[out.length - 1];
    return !last || last.text.endsWith("\n");
  };
  const walk = (node: Node, style: { ink?: Pen; size?: SizeId }): void => {
    node.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        push(child.textContent ?? "", style);
        return;
      }
      if (!(child instanceof HTMLElement)) return;
      if (child.tagName === "BR") {
        push("\n", style);
        return;
      }
      if ((child.tagName === "DIV" || child.tagName === "P") && !endsWithBreak()) push("\n", style);
      const next = { ...style };
      if (isPen(child.dataset.ink)) next.ink = child.dataset.ink;
      if (SIZES.includes(child.dataset.size as SizeId)) next.size = child.dataset.size as SizeId;
      walk(child, next);
    });
  };
  walk(root, {});
  return out;
}

/** Runs made tidy for keeping: what matches the box is dropped from each run,
 *  neighbors that now look the same are merged, the no-break spaces a browser
 *  types are made ordinary, and trailing space is trimmed off the end. */
function tidyRuns(runs: TextRun[], note: TextNote, trimEnd = true): TextRun[] {
  const out: TextRun[] = [];
  for (const r of runs) {
    const run: TextRun = { text: r.text.replace(/\r/g, "").replace(/ /g, " ") };
    if (r.ink !== undefined && r.ink !== note.ink) run.ink = r.ink;
    if (r.size !== undefined && r.size !== note.size) run.size = r.size;
    const last = out[out.length - 1];
    if (last && last.ink === run.ink && last.size === run.size) last.text += run.text;
    else if (run.text) out.push(run);
  }
  // Only when the box is finished: mid-sentence, the space just typed is
  // where the next word goes.
  while (trimEnd && out.length > 0) {
    const last = out[out.length - 1];
    last.text = last.text.replace(/\s+$/, "");
    if (last.text) break;
    out.pop();
  }
  let room = MAX_TEXT_LEN;
  return out
    .map((r) => {
      const text = r.text.slice(0, Math.max(0, room));
      room -= text.length;
      return { ...r, text };
    })
    .filter((r) => r.text);
}

/** Keeps tidied runs on a box, and the plain text they spell. */
function setNoteRuns(note: TextNote, runs: TextRun[]): void {
  note.text = runs.map((r) => r.text).join("");
  const styled = runs.some((r) => r.ink !== undefined || r.size !== undefined);
  if (styled) note.runs = runs;
  else delete note.runs;
}

/** A color or size for the whole box: the box takes it, and no run keeps a
 *  color or size of its own that would contradict it. */
function styleWholeNote(note: TextNote, patch: { ink?: Pen; size?: SizeId }, trimEnd = true): void {
  if (patch.ink !== undefined) note.ink = patch.ink;
  if (patch.size !== undefined) note.size = patch.size;
  const runs = noteRuns(note).map((r) => {
    const run: TextRun = { ...r };
    if (patch.ink !== undefined) delete run.ink;
    if (patch.size !== undefined) delete run.size;
    return run;
  });
  setNoteRuns(note, tidyRuns(runs, note, trimEnd));
}

/** The style applied to characters start..end, splitting the runs it cuts. */
function styleRange(runs: TextRun[], start: number, end: number, patch: { ink?: Pen; size?: SizeId }): TextRun[] {
  const out: TextRun[] = [];
  let at = 0;
  for (const r of runs) {
    const from = at;
    const to = at + r.text.length;
    at = to;
    const a = Math.max(from, Math.min(start, to));
    const b = Math.max(from, Math.min(end, to));
    if (a > from) out.push({ ...r, text: r.text.slice(0, a - from) });
    if (b > a) out.push({ ...r, ...patch, text: r.text.slice(a - from, b - from) });
    if (to > b) out.push({ ...r, text: r.text.slice(b - from) });
  }
  return out;
}

/** How many characters of plain text come before a point in the box. */
function textOffset(el: HTMLElement, node: Node, offset: number): number {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.setEnd(node, offset);
  const holder = document.createElement("div");
  holder.appendChild(range.cloneContents());
  return readRuns(holder).reduce((n, r) => n + r.text.length, 0);
}

/** The DOM point at a plain-text offset, in a box drawn by renderRuns, which
 *  holds only text nodes and spans of text. */
function pointAt(el: HTMLElement, offset: number): { node: Node; offset: number } {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let left = offset;
  let last: Text | null = null;
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const len = n.data.length;
    if (left <= len) return { node: n, offset: left };
    left -= len;
    last = n;
  }
  return last ? { node: last, offset: last.data.length } : { node: el, offset: el.childNodes.length };
}

function captureEditSelection(): EditSelection | null {
  const el = noteEls.get(editingId ?? "");
  const sel = window.getSelection();
  if (!editingId || !el || !sel || sel.rangeCount === 0) return null;
  const r = sel.getRangeAt(0);
  if (!el.contains(r.startContainer) || !el.contains(r.endContainer)) return null;
  const start = textOffset(el, r.startContainer, r.startOffset);
  const end = textOffset(el, r.endContainer, r.endOffset);
  return { id: editingId, start: Math.min(start, end), end: Math.max(start, end) };
}

function restoreEditSelection(saved: EditSelection | null): void {
  if (!saved || saved.id !== editingId) return;
  const el = noteEls.get(saved.id);
  if (!el) return;
  el.focus();
  const a = pointAt(el, saved.start);
  const b = pointAt(el, saved.end);
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

/** A toolbar color or size, applied to the box being typed in, if there is
 *  one: the selected text, or the whole box. Part of the edit's own Undo
 *  step, which endEditing records. */
function styleWhileTyping(patch: { ink?: Pen; size?: SizeId }): void {
  const note = noteById(editingId);
  const el = note ? noteEls.get(note.id) : undefined;
  if (!note || !el) return;
  const saved = captureEditSelection();
  const runs = readRuns(el);
  if (saved && saved.end > saved.start) {
    setNoteRuns(note, tidyRuns(styleRange(runs, saved.start, saved.end, patch), note, false));
  } else {
    setNoteRuns(note, tidyRuns(runs, note, false));
    styleWholeNote(note, patch, false);
  }
  renderRuns(el, note);
  restoreEditSelection(saved);
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
   DELETE, CUT, COPY, PASTE
   -----------------------------------------------------------------------------
   All four work on the selection's AREA, not on whole strokes. A stroke that
   runs out past the edge is cut there: Delete and Cut leave a cleared
   rectangle over the part inside (a "rect" stroke), and Copy clips the copy to
   the edge. Text boxes cannot be cut in half, so a box goes when it lies
   wholly inside and stays when it does not.

   The clipboard is the Whiteboard's own and lasts the session. A paste lands
   with its corner under the pointer, or near the top of the view when the
   pointer is off the board, and arrives selected, so it can be deleted again
   or cut somewhere else straight away.

   A paste lies over what is already there. An eraser mark copied with the ink
   is still an eraser, so inside the pasted area it rubs out whatever it lands
   on, as it did where it was copied from.
============================================================================= */

function intersectRect(
  a: [number, number, number, number],
  b: [number, number, number, number],
): [number, number, number, number] {
  const x = Math.max(a[0], b[0]);
  const y = Math.max(a[1], b[1]);
  const w = Math.min(a[0] + a[2], b[0] + b[2]) - x;
  const h = Math.min(a[1] + a[3], b[1] + b[3]) - y;
  return [x, y, Math.max(0, w), Math.max(0, h)];
}

/** A stroke moved by (dx, dy), as a new stroke, clipped to `clip` when given. */
function shiftStroke(s: Stroke, dx: number, dy: number, clip?: [number, number, number, number]): Stroke {
  const pts = s.pts.map((v, i) => round1(v + (i % 2 === 0 ? dx : dy)));
  let c = clip;
  if (s.clip) {
    const moved: [number, number, number, number] = [s.clip[0] + dx, s.clip[1] + dy, s.clip[2], s.clip[3]];
    c = clip ? intersectRect(moved, clip) : moved;
  }
  const out: Stroke = { ...s, id: newId(), pts };
  if (c) out.clip = c;
  else delete out.clip;
  if (s.holes) out.holes = s.holes.map(([x, y, w, h]) => [x + dx, y + dy, w, h]);
  return out;
}

/** Empties an area: ink wholly inside is removed, ink crossing the edge is
 *  cleared inside it, and text boxes wholly inside go when `includeText`. */
function clearArea(area: Area, includeText: boolean): void {
  const kept: Stroke[] = [];
  let crossing = false;
  for (const s of strokes) {
    const b = boundsOf(s);
    if (inside(boundsArea(b), area)) continue;
    if (overlaps(b, area)) crossing = true;
    kept.push(s);
  }
  if (crossing) {
    kept.push({
      id: newId(),
      ink: "ink",
      size: "medium",
      erase: true,
      shape: "clear",
      pts: [round1(area.x), round1(area.y), round1(area.x + area.w), round1(area.y + area.h)],
    });
  }
  strokes = kept;
  if (includeText) texts = texts.filter((t) => !inside(noteArea(t), area));
  selection = null;
  recountPoints();
  rebuildTexts();
  showSelection();
  requestRedraw();
}

function deleteSelection(): void {
  const area = selection;
  if (!area) return;
  checkpoint();
  clearArea(area, true);
  markDirty();
  updateChrome();
}

/** An area's ink and text, relative to its corner: what Copy puts on the
 *  clipboard, and what a move carries. */
interface AreaData {
  w: number;
  h: number;
  strokes: Stroke[];
  texts: TextNote[];
}

/** What lies in an area, or null when it holds nothing. */
function areaData(area: Area): AreaData | null {
  const clip: [number, number, number, number] = [0, 0, area.w, area.h];
  const copied = strokes
    .filter((s) => overlaps(boundsOf(s), area))
    .map((s) => shiftStroke(s, -area.x, -area.y, clip))
    .filter((s) => !s.clip || (s.clip[2] > 0 && s.clip[3] > 0));
  const copiedTexts = texts
    .filter((t) => inside(noteArea(t), area))
    .map((t) => ({ ...t, x: t.x - area.x, y: t.y - area.y }));
  if (copied.length === 0 && copiedTexts.length === 0) return null;
  return { w: area.w, h: area.h, strokes: copied, texts: copiedTexts };
}

/** Takes the selection's ink and text onto the clipboard. False when the
 *  selection holds nothing, so an empty copy never replaces a full one. */
function copySelection(): boolean {
  const area = selection;
  const data = area ? areaData(area) : null;
  if (!data) return false;
  clipboard = data;
  updateChrome();
  return true;
}

/** Starts carrying the selection's contents once the pointer has actually
 *  moved, then keeps them under it. They are lifted out the way Cut takes
 *  them, so a stroke crossing the edge leaves its outside part behind. */
function moveArea(e: PointerEvent): void {
  const m = areaMove;
  if (!m) return;
  const p = boardPoint(e);
  let dx = p.x - m.start.x;
  let dy = p.y - m.start.y;
  if (!m.moved) {
    if (Math.hypot(dx, dy) * zoom < DRAG_THRESHOLD) return;
    m.data = areaData(m.area);
    if (!m.data) {
      areaMove = null;
      return;
    }
    m.moved = true;
    clearArea(m.area, true);
    m.base = strokes.slice();
    m.notes = m.data.texts.map((t) => ({ ...t, id: newId(), x: t.x + m.area.x, y: t.y + m.area.y }));
    texts.push(...m.notes);
    rebuildTexts();
  }
  const data = m.data!;
  dx = Math.min(Math.max(dx, -m.area.x), SURFACE_W - m.area.w - m.area.x);
  dy = Math.min(Math.max(dy, -m.area.y), SURFACE_H - m.area.h - m.area.y);
  const x = m.area.x + dx;
  const y = m.area.y + dy;
  strokes = m.base.concat(data.strokes.map((st) => shiftStroke(st, x, y)));
  data.texts.forEach((t, i) => {
    const note = m.notes[i];
    note.x = t.x + x;
    note.y = t.y + y;
    const el = noteEls.get(note.id);
    if (el) {
      el.style.left = `${note.x}px`;
      el.style.top = `${note.y}px`;
    }
  });
  selection = { x, y, w: m.area.w, h: m.area.h };
  showSelection();
  requestRedraw();
}

function endMoveArea(): void {
  const m = areaMove;
  areaMove = null;
  if (!m?.moved) return;
  recountPoints();
  pushUndo(m.pre);
  markDirty();
  updateChrome();
}

function cutSelection(): void {
  const area = selection;
  if (!area || !copySelection()) return;
  checkpoint();
  clearArea(area, true);
  markDirty();
  updateChrome();
}

function pasteClipboard(): void {
  if (!clipboard) return;
  pasteData(clipboard, lastPointer);
}

/** Puts area data on the board with its corner at `at` (or near the top of
 *  the view), and selects it. */
function pasteData(cb: AreaData, at: { x: number; y: number } | null): void {
  endEditing();
  const points = cb.strokes.reduce((n, st) => n + st.pts.length / 2, 0);
  if (totalPoints + points > MAX_TOTAL_POINTS || texts.length + cb.texts.length > MAX_TEXTS) {
    flash("The Whiteboard is full.", "error");
    return;
  }
  const corner = at ?? {
    x: scroller.scrollLeft / zoom + NOTES_MARGIN,
    y: scroller.scrollTop / zoom + NOTES_MARGIN,
  };
  const x = Math.round(Math.min(Math.max(0, corner.x), SURFACE_W - cb.w));
  const y = Math.round(Math.min(Math.max(0, corner.y), SURFACE_H - cb.h));

  checkpoint();
  for (const st of cb.strokes) strokes.push(shiftStroke(st, x, y));
  for (const t of cb.texts) texts.push({ ...t, id: newId(), x: t.x + x, y: t.y + y });
  recountPoints();
  rebuildTexts();
  // Straight into Select with the paste selected. Set directly rather than
  // through setMode, which would drop the selection on the way.
  settings.mode = "select";
  saveSettings();
  selection = { x, y, w: cb.w, h: cb.h };
  showSelection();
  requestRedraw();
  markDirty();
  updateChrome();
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
  const remPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const fontOf = (size: SizeId): string =>
    `${cs.fontStyle} ${cs.fontWeight} ${TEXT_REM[size] * remPx}px ${cs.fontFamily}`;
  c.textBaseline = "alphabetic";
  let y = note.y + TEXT_INSET_Y;
  for (const line of layoutRuns(c, note, fontOf, remPx)) {
    const lineHeight = line.fontPx * 1.4;
    const baseline = y + (lineHeight - line.fontPx) / 2 + line.fontPx * 0.8;
    for (const piece of line.pieces) {
      c.font = fontOf(piece.size);
      c.fillStyle = penColor(piece.ink);
      c.fillText(piece.text, note.x + TEXT_INSET_X + piece.x, baseline);
    }
    y += lineHeight;
  }
}

interface LaidPiece {
  text: string;
  x: number;
  ink: Pen;
  size: SizeId;
}

/** A box's runs broken into lines the way the box wraps them: at its own line
 *  breaks, then at word breaks past the width, then anywhere in a word too
 *  long for a line. Each line knows its largest text, which sets its height. */
function layoutRuns(
  c: CanvasRenderingContext2D,
  note: TextNote,
  fontOf: (size: SizeId) => string,
  remPx: number,
): { pieces: LaidPiece[]; fontPx: number }[] {
  const lines: { pieces: LaidPiece[]; fontPx: number }[] = [];
  let pieces: LaidPiece[] = [];
  let x = 0;
  let fontPx = TEXT_REM[note.size] * remPx;
  const newLine = (): void => {
    lines.push({ pieces, fontPx });
    pieces = [];
    x = 0;
    fontPx = TEXT_REM[note.size] * remPx;
  };
  const place = (text: string, ink: Pen, size: SizeId, width: number): void => {
    pieces.push({ text, x, ink, size });
    x += width;
    fontPx = Math.max(fontPx, TEXT_REM[size] * remPx);
  };

  for (const run of noteRuns(note)) {
    const ink = run.ink ?? note.ink;
    const size = run.size ?? note.size;
    c.font = fontOf(size);
    for (const token of run.text.split(/(\n|\s+)/)) {
      if (token === "") continue;
      if (token === "\n") {
        newLine();
        continue;
      }
      let w = c.measureText(token).width;
      if (x + w <= TEXT_MAX_WIDTH) {
        place(token, ink, size, w);
        continue;
      }
      if (/^\s+$/.test(token)) continue; // a space at a wrap hangs off the line
      if (x > 0) newLine();
      let rest = token;
      while (w > TEXT_MAX_WIDTH && rest.length > 1) {
        let cut = rest.length - 1;
        while (cut > 1 && c.measureText(rest.slice(0, cut)).width > TEXT_MAX_WIDTH) cut--;
        place(rest.slice(0, cut), ink, size, 0);
        newLine();
        rest = rest.slice(cut);
        w = c.measureText(rest).width;
      }
      place(rest, ink, size, w);
    }
  }
  newLine();
  return lines;
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

  closePops();
  const mode = settings.mode;
  if (mode === "erase" && settings.eraser === "stroke") {
    e.preventDefault();
    startWipe(e);
    return;
  }
  if (mode === "draw" || mode === "erase" || mode === "shape") {
    e.preventDefault();
    startStroke(e);
    return;
  }

  if (mode === "select") {
    e.preventDefault();
    const { x, y } = boardPoint(e);
    // Inside the selection, a drag moves what is in it.
    if (selection && inside({ x, y, w: 0, h: 0 }, selection)) {
      areaMove = {
        pointerId: e.pointerId,
        start: { x, y },
        area: { ...selection },
        pre: snapshot(),
        data: null,
        base: [],
        notes: [],
        moved: false,
      };
    } else {
      selectDrag = { pointerId: e.pointerId, x, y, moved: false };
    }
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
  lastPointer = boardPoint(e);
  if (pan && e.pointerId === pan.pointerId) {
    scroller.scrollLeft = pan.left - (e.clientX - pan.x);
    scroller.scrollTop = pan.top - (e.clientY - pan.y);
    return;
  }
  if (liveStroke) {
    extendStroke(e);
    return;
  }
  if (wipe && e.pointerId === wipe.pointerId) {
    extendWipe(e);
    return;
  }
  if (areaMove && e.pointerId === areaMove.pointerId) {
    moveArea(e);
    return;
  }
  if (settings.mode === "select") {
    const p = boardPoint(e);
    surface.classList.toggle("wb-over-selection", !!selection && inside({ ...p, w: 0, h: 0 }, selection));
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
  if (wipe && e.pointerId === wipe.pointerId) {
    endWipe();
    return;
  }
  if (areaMove && e.pointerId === areaMove.pointerId) {
    endMoveArea();
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

/** The dot grid is the surface's own background, so it scrolls with the
 *  board natively. Only the zoom changes it: the spacing scales with the
 *  board, the dots grow and shrink a little with it, and the whole grid fades
 *  out as the dots close up rather than turning into a grey wash. */
function placeGrid(): void {
  const step = GRID_STEP * zoom;
  const fade = Math.min(1, Math.max(0, (step - GRID_FADE_TO) / (GRID_FADE_FROM - GRID_FADE_TO)));
  const dot = Math.min(1.5, Math.max(0.6, zoom));
  surface.style.setProperty("--wb-grid-step", `${step}px`);
  surface.style.setProperty("--wb-grid-alpha", `${Math.round(fade * 100)}%`);
  surface.style.setProperty("--wb-grid-dot", `${dot}px`);
}

function onScroll(): void {
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

/** Back to where a new board starts: the top-left corner at actual size. */
function goHome(): void {
  overview = false;
  zoom = 1;
  applyZoomLayout();
  scrollViewTo(0, 0);
}

/** Brings your notes into view: centered if they fit at this zoom, and
 *  zoomed out just far enough to fit them if they do not. */
function goToNotes(): void {
  endEditing();
  const area = contentArea(true);
  overview = false;
  if (!area) {
    goHome();
    return;
  }
  const w = scroller.clientWidth;
  const h = scroller.clientHeight;
  const fit = Math.min((w - NOTES_MARGIN * 2) / area.w, (h - NOTES_MARGIN * 2) / area.h);
  if (fit < zoom) zoom = clampZoom(fit);
  applyZoomLayout();
  const cx = (area.x + area.w / 2) * zoom;
  const cy = (area.y + area.h / 2) * zoom;
  scrollViewTo(cx - w / 2, cy - h / 2);
}

/** The next zoom on the ladder in a direction, from wherever the zoom is now,
 *  on the ladder or between two of its steps. Past the bottom is Overview's
 *  floor, the whole board. */
function nextZoom(direction: 1 | -1): number {
  const eps = 0.001;
  if (direction > 0) return ZOOM_LEVELS.find((z) => z > zoom + eps) ?? ZOOM_MAX;
  const lower = [...ZOOM_LEVELS].reverse().find((z) => z < zoom - eps);
  return lower ?? fitBoardZoom();
}

function stepZoom(direction: 1 | -1, anchor?: { clientX: number; clientY: number }): void {
  overview = false;
  setZoom(nextZoom(direction), anchor);
}

function onWheel(e: WheelEvent): void {
  // Ctrl+wheel zooms around the pointer, one ladder step per notch, however
  // finely the wheel or touchpad reports. Taken here so it never reaches the
  // webview's own page zoom.
  if (!e.ctrlKey) return;
  e.preventDefault();
  wheelCarry += e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
  while (Math.abs(wheelCarry) >= WHEEL_PER_STEP) {
    const direction = wheelCarry > 0 ? -1 : 1;
    wheelCarry -= WHEEL_PER_STEP * -direction;
    stepZoom(direction, e);
  }
}

function onKeydown(e: KeyboardEvent): void {
  if (document.body.dataset.activeTool !== "productivity/whiteboard") return;
  if (document.body.classList.contains("modal-open")) return;
  // Inside a text box, Ctrl+Z is that box's own typing undo.
  if (isTextEntry(e.target)) return;
  if (e.key === "Escape") {
    if (anyPopOpen()) closePops();
    else if (overview) toggleOverview();
    else clearSelection();
    return;
  }
  const key = e.key.toLowerCase();
  // The mode keys. Only with nothing held, so they never shadow a shortcut,
  // and never while typing, which the text-entry check above already rules out.
  if (key === "k" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
    e.preventDefault();
    requestSend();
    return;
  }
  // C and Z step through the pens and sizes. Only with nothing held: Ctrl+C
  // is Copy and Ctrl+Z is Undo.
  if ((key === "c" || key === "z") && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
    e.preventDefault();
    if (key === "c") cycleInk();
    else setSize(SIZES[(SIZES.indexOf(settings.size) + 1) % SIZES.length]);
    return;
  }
  if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && MODE_KEYS[key]) {
    e.preventDefault();
    const mode = MODE_KEYS[key];
    // Pressing the key of the mode already in use steps through its kinds.
    if (mode === settings.mode && (mode === "shape" || mode === "erase")) cycleKind(mode);
    else setMode(mode);
    return;
  }
  if ((e.key === "Delete" || e.key === "Backspace") && selection && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    deleteSelection();
    return;
  }
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  if (key === "0") {
    e.preventDefault();
    overview = false;
    setZoom(1);
    return;
  }
  if (key === "c" && selection) {
    if (copySelection()) e.preventDefault();
    return;
  }
  if (key === "x" && selection) {
    e.preventDefault();
    cutSelection();
    return;
  }
  if (key === "v" && clipboard) {
    e.preventDefault();
    pasteClipboard();
    return;
  }
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

/** The next pen along: the six theme pens, then the last color picked by hand
 *  if there is one, wrapping round. A pen picked by hand that is no longer the
 *  last one starts the round again from the first. */
function cycleInk(): void {
  const pens: Pen[] = INKS.map((i) => i.id);
  if (settings.customInk) pens.push(settings.customInk);
  setInk(pens[(pens.indexOf(settings.ink) + 1) % pens.length]);
}

/** The next kind along for Shapes or Erase, wrapping round. */
function cycleKind(mode: "shape" | "erase"): void {
  if (mode === "shape") {
    settings.shape = SHAPES[(SHAPES.indexOf(settings.shape) + 1) % SHAPES.length];
  } else {
    settings.eraser = ERASERS[(ERASERS.indexOf(settings.eraser) + 1) % ERASERS.length];
  }
  saveSettings();
  updateChrome();
}

function setInk(next: Pen): void {
  settings.ink = next;
  saveSettings();
  styleWhileTyping({ ink: next });
  restyleSelection({ ink: next });
  updateChrome();
}

function setSize(next: SizeId): void {
  settings.size = next;
  saveSettings();
  styleWhileTyping({ size: next });
  restyleSelection({ size: next });
  updateChrome();
}

/** A toolbar color or size, applied to everything wholly inside the selection:
 *  its ink, and its text boxes unless the preference says ink only. A stroke
 *  crossing the edge is left as it is, since a line cannot be half one color.
 *  One Undo step. */
/** How close a point is to a rectangle, 0 inside it. */
function distanceToRect(x: number, y: number, r: Area): number {
  const dx = Math.max(r.x - x, 0, x - (r.x + r.w));
  const dy = Math.max(r.y - y, 0, y - (r.y + r.h));
  return Math.hypot(dx, dy);
}

/** Whether any of a stroke's drawn line, thickness included, falls inside an
 *  area: a segment passing just outside the edge can still paint inside it. */
function strokeTouchesArea(s: Stroke, area: Area): boolean {
  const reach = strokeWidth(s) / 2;
  const p = strokePath(s);
  if (p.length === 2) return distanceToRect(p[0], p[1], area) <= reach;
  const corners = [
    [area.x, area.y],
    [area.x + area.w, area.y],
    [area.x, area.y + area.h],
    [area.x + area.w, area.y + area.h],
  ];
  for (let i = 0; i + 3 < p.length; i += 2) {
    const [ax, ay, bx, by] = [p[i], p[i + 1], p[i + 2], p[i + 3]];
    if (distanceToRect(ax, ay, area) <= reach || distanceToRect(bx, by, area) <= reach) return true;
    // A segment crossing the whole area with both ends outside it: the
    // nearest point is then on the segment, closest to one of the corners,
    // or the segment runs straight through.
    if (corners.some(([cx, cy]) => distanceToSegment(cx, cy, ax, ay, bx, by) <= reach)) return true;
    if (segmentCrossesRect(ax, ay, bx, by, area)) return true;
  }
  return false;
}

/** Whether a segment passes through a rectangle (Liang-Barsky). */
function segmentCrossesRect(ax: number, ay: number, bx: number, by: number, r: Area): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  let t0 = 0;
  let t1 = 1;
  for (const [q, d] of [
    [-dx, ax - r.x],
    [dx, r.x + r.w - ax],
    [-dy, ay - r.y],
    [dy, r.y + r.h - ay],
  ]) {
    if (q === 0) {
      if (d < 0) return false;
    } else {
      const t = d / q;
      if (q < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
    }
  }
  return t0 <= t1;
}

function restyleSelection(patch: { ink?: Pen; size?: SizeId }): void {
  const area = selection;
  if (!area || editingId) return;
  const pre = snapshot();
  let changed = false;
  const restyle = (st: Stroke): Stroke => {
    const next = { ...st, ...patch, id: newId() };
    if (next.ink !== st.ink || next.size !== st.size) changed = true;
    return next;
  };
  // New objects, never edits: Undo's snapshots hold the old ones.
  strokes = strokes.flatMap((st) => {
    if (st.erase || !overlaps(boundsOf(st), area)) return [st];
    // A shape is one thing, so touching it restyles all of it.
    if (st.shape) return [restyle(st)];
    /* A freehand line changes exactly inside the selection, the way it would
       in a paint program: the line keeps its old look everywhere but a hole
       the size of the selection, and a restyled copy of it drawn only inside
       that rectangle sits straight on top. Cutting the line's path at the edge
       instead left the restyled piece's thickness and rounded ends spilling
       past the selection wherever the line ran along it. */
    if (!strokeTouchesArea(st, area)) return [st];
    // Already that color and size: nothing to cut.
    if ((patch.ink ?? st.ink) === st.ink && (patch.size ?? st.size) === st.size) return [st];
    const within = (r: [number, number, number, number]): boolean =>
      r[0] >= area.x && r[1] >= area.y && r[0] + r[2] <= area.x + area.w && r[1] + r[3] <= area.y + area.h;
    const covers = (r: [number, number, number, number]): boolean =>
      r[0] <= area.x && r[1] <= area.y && r[0] + r[2] >= area.x + area.w && r[1] + r[3] >= area.y + area.h;
    // A copy from an earlier restyle that lies wholly inside this selection is
    // restyled as it is, so restyling one selection again does not pile up
    // copies. A line with a hole already covering the selection shows nothing
    // there to change.
    if (st.clip && within(st.clip)) return [restyle(st)];
    if (st.holes?.some(covers)) return [st];
    const rect: [number, number, number, number] = [area.x, area.y, area.w, area.h];
    const clip = st.clip ? intersectRect(st.clip, rect) : rect;
    if (clip[2] <= 0 || clip[3] <= 0) return [st];
    const kept: Stroke = { ...st, id: newId(), holes: [...(st.holes ?? []), rect].slice(-MAX_HOLES) };
    return [kept, { ...restyle(st), clip }];
  });
  for (const note of settings.selectionStylesText ? texts : []) {
    const b = noteArea(note);
    if (!overlaps([b.x, b.y, b.x + b.w, b.y + b.h], area)) continue;
    const before = JSON.stringify(note);
    styleWholeNote(note, patch);
    if (JSON.stringify(note) !== before) changed = true;
  }
  if (!changed) return;
  pushUndo(pre);
  recountPoints();
  rebuildTexts();
  showSelection();
  requestRedraw();
  markDirty();
}

function isEmpty(): boolean {
  return strokes.length === 0 && texts.length === 0;
}

/** Everything on screen that reflects state: which mode, pen and size are
 *  picked, and which actions have anything to act on. */
/* The pointer in Draw and Erase is the stroke it will make: a dot the pen's
   size and color, or a ring the eraser's size, at the current zoom. Chromium
   drops a cursor image past 128px, hence the ceiling; the crosshair in the
   stylesheet is what is left if an image is ever refused. */
const CURSOR_MAX = 120;
const CURSOR_MIN_DOT = 4;

function updateCursor(): void {
  const mode = settings.mode;
  if (overview || (mode !== "draw" && mode !== "erase")) {
    surface.style.removeProperty("cursor");
    return;
  }
  const erase = mode === "erase";
  const whole = erase && settings.eraser === "stroke";
  const width = (erase ? ERASER_WIDTH : PEN_WIDTH)[settings.size] * zoom;
  const d = Math.min(CURSOR_MAX - 4, Math.max(erase ? 6 : CURSOR_MIN_DOT, width));
  const size = Math.ceil(d + 4);
  const c = size / 2;
  const r = d / 2;
  // The pen is its own color and nothing else, exactly the dot it will leave.
  // The eraser has no color of its own, so it is a ring in the board's ink.
  const shape = erase
    ? `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${penColor("ink")}" stroke-width="1.5"${
        whole ? ' stroke-dasharray="3 2"' : ""
      }/>`
    : `<circle cx="${c}" cy="${c}" r="${r}" fill="${penColor(settings.ink)}"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">${shape}</svg>`;
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
  document.querySelectorAll<HTMLButtonElement>(".wb-shape-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.shape === settings.shape);
  });
  // The Shapes and Erase buttons wear the icon of the kind they will use.
  document.querySelectorAll<SVGElement>("[data-kind-icon]").forEach((icon) => {
    const kind = icon.dataset.kindIcon;
    icon.toggleAttribute("hidden", kind !== settings.shape && kind !== settings.eraser);
  });
  document.querySelectorAll<HTMLButtonElement>(".wb-eraser-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.eraser === settings.eraser);
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
  // While typing they are the box's own history, which this cannot see.
  undoBtn.disabled = !editingId && undoStack.length === 0;
  redoBtn.disabled = !editingId && redoStack.length === 0;
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
  closePops();
  colorPop.hidden = false;
  colorBtn.classList.add("active");
}

function closeColorPop(): void {
  colorPop.hidden = true;
  colorBtn.classList.remove("active");
}

/* The Shapes and Erase buttons each have a small list of kinds under them.
   Pressing the button picks the mode and opens its list; drawing, a pick, or a
   click anywhere else closes it, so the list costs nothing when not wanted. */

function modePops(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(".wb-mode-pop")];
}

function anyPopOpen(): boolean {
  return !colorPop.hidden || modePops().some((p) => !p.hidden);
}

function closePops(): void {
  closeColorPop();
  for (const p of modePops()) p.hidden = true;
}

function toggleModePop(mode: Mode): void {
  const pop = document.querySelector<HTMLElement>(`.wb-mode-pop[data-for="${mode}"]`);
  if (!pop) return;
  const open = pop.hidden;
  closePops();
  pop.hidden = !open;
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
      restoreEditSelection(pickerSelection);
      setInk(hex);
    }
    pickerSelection = null;
    closeColorPop();
  });
  // Anywhere else closes it, the way a dropdown does. The same goes for the
  // Shapes and Erase lists.
  document.addEventListener("pointerdown", (e) => {
    if (!anyPopOpen()) return;
    const t = e.target as HTMLElement;
    if (t.closest?.(".wb-color-group, .wb-pop-anchor")) return;
    closePops();
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
let sendTitle: HTMLInputElement;
let sendPreview: HTMLImageElement;
let sendAreaNote: HTMLElement;
let sendTargets: KanbanTarget[] = [];
let sendChecked = new Set<string>();
let sendArea: ImageArea = "board";
/** Where the Image tab sends: a new card, or one already on the board. */
let sendDest: "new" | "existing" = "new";
let sendCardId: string | null = null;
let sendTagIds = new Set<string>();
let sendColumnField: HTMLElement;
let sendDestGroup: HTMLElement;
let sendNewFields: HTMLElement;
let sendExistingFields: HTMLElement;
let sendCardSearch: HTMLInputElement;
let sendCardResults: HTMLElement;
let sendAdvanced: HTMLDetailsElement;
let sendPriority: HTMLSelectElement;
let sendEffort: HTMLSelectElement;
let sendDue: HTMLInputElement;
let sendDescription: HTMLTextAreaElement;
let sendTagsEl: HTMLElement;
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

  /* A CHECKLIST: list lines, ticked where they were written as [x], become
     the card's subtasks. When every line is a list line, every one of them is
     a subtask, and the title is the first item's text unless one is typed in
     the modal (see cardsToSend). When a plain first line leads the list, it is
     the title. A box with any plain line after the first is ordinary text, and
     goes over whole in the description. */
  const allListed = lines.length > 1 && lines.every((l) => CHECKLIST_LINE.test(l));
  const rest = allListed ? lines : lines.slice(1);
  if (rest.length > 0 && rest.every((l) => CHECKLIST_LINE.test(l))) {
    return {
      title: cutTitle(firstLine.replace(CHECKLIST_LINE, "")),
      description: "",
      subtasks: rest.map(checklistItem),
    };
  }

  // A list marker is never part of a title, even on a box that is one line.
  const title = cutTitle(firstLine.replace(CHECKLIST_LINE, ""));
  return { title, description: title === full.replace(CHECKLIST_LINE, "") ? "" : full };
}

/** One line as a subtask: its list marker gone, ticked if written [x]. */
function checklistItem(line: string): { text: string; done: boolean } {
  const m = CHECKLIST_LINE.exec(line);
  if (!m) return { text: line, done: false };
  return { text: line.slice(m[0].length), done: /x/i.test(m[1] ?? m[2] ?? "") };
}

/**
 * The cards a Text as Cards send makes. With no title typed, one card per box.
 * With a title typed, ONE card with that title, whose subtasks are every line
 * of every box picked, in reading order: the way to turn a list, or a few
 * boxes, into one card named on the spot.
 */
function cardsToSend(notes: TextNote[]): IncomingCard[] {
  const title = sendTitle.value.trim();
  if (!title) return notes.map(noteToCard);
  const subtasks = notes.flatMap((n) =>
    n.text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "")
      .map(checklistItem),
  );
  return [{ title: cutTitle(title), description: "", subtasks }];
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

/** Send to Kanban from the keyboard: the modal when there is somewhere to send
 *  and something to send, and a toast saying which is missing when not. */
function requestSend(): void {
  const targets = kanbanTargets();
  if (isEmpty()) flash("There's nothing on the whiteboard to send.", "error");
  else if (targets === null) flash("Kanban is still loading.", "error");
  else if (targets.length === 0) flash("There are no Kanban boards yet.", "error");
  else openSend();
}

/** One scale into one select, in ladder order with the unset rung first. */
function fillLevelSelect(select: HTMLSelectElement, choices: LevelChoice[]): void {
  select.replaceChildren();
  for (const choice of choices) {
    const option = document.createElement("option");
    option.value = choice.id;
    option.textContent = choice.label;
    select.appendChild(option);
  }
}

function openSend(tab?: SendTab, onlyNote?: string): void {
  endEditing();
  closeColorPop();
  if (isEmpty()) return;
  const notes = notesInReadingOrder();
  sendChecked = new Set(onlyNote ? [onlyNote] : notes.map((n) => n.id));
  sendArea = selection ? "selection" : "board";
  sendTitle.value = "";
  // Every send starts plain: a new card, nothing extra. Advanced is there
  // when it is wanted and costs nothing when it is not.
  sendDest = "new";
  sendCardId = null;
  sendCardSearch.value = "";
  sendTagIds = new Set();
  /* Both ladders are refilled on every open rather than once at startup: the
     levels are built per install now, and a scale edited in Kanban since this
     tool loaded would otherwise offer rungs that no longer exist. */
  fillLevelSelect(sendPriority, priorityChoices());
  fillLevelSelect(sendEffort, effortChoices());
  sendPriority.value = NO_LEVEL;
  sendEffort.value = NO_LEVEL;
  sendDue.value = "";
  sendDescription.value = "";
  sendAdvanced.open = false;
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
  // A different board has different tags and different cards.
  sendTagIds = new Set();
  sendCardId = null;
  renderSendTags();
  renderCardResults();
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

/** Shows the fields the current tab and destination use, and only those.
 *  Text always makes new cards, so New Card / Existing Card is the Image
 *  tab's alone. An existing card needs no column, no title and no new-card
 *  extras; a new picture card needs a title. */
function syncSendFields(): void {
  const image = sendTabs.active === "image";
  const existing = image && sendDest === "existing";
  sendDestGroup.style.display = image ? "" : "none";
  sendColumnField.style.display = existing ? "none" : "";
  sendAdvanced.style.display = existing ? "none" : "";
  // Text always makes new cards, so its title field shows on that tab too.
  sendNewFields.style.display = existing ? "none" : "";
  sendExistingFields.style.display = existing ? "" : "none";
  document.querySelectorAll<HTMLButtonElement>(".wb-dest-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.dest === sendDest);
  });
  updateSendButtons();
}

function renderSendTags(): void {
  const board = sendTargets.find((t) => t.id === sendBoardSel.value);
  sendTagsEl.replaceChildren();
  if (!board || board.tags.length === 0) {
    const none = document.createElement("span");
    none.className = "wb-send-none";
    none.textContent = "No tags";
    sendTagsEl.appendChild(none);
    return;
  }
  for (const tag of board.tags) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "toggle-btn wb-tag-chip";
    chip.textContent = tag.name;
    chip.title = tag.category;
    chip.classList.toggle("active", sendTagIds.has(tag.id));
    chip.addEventListener("click", () => {
      if (sendTagIds.has(tag.id)) sendTagIds.delete(tag.id);
      else sendTagIds.add(tag.id);
      chip.classList.toggle("active", sendTagIds.has(tag.id));
    });
    sendTagsEl.appendChild(chip);
  }
}

/** The cards matching the search, best first. Picking one is what Send sends
 *  to; a new search that no longer lists it lets it go. */
function renderCardResults(): void {
  const board = sendTargets.find((t) => t.id === sendBoardSel.value);
  const matches = board ? findCardsOnBoard(board.id, sendCardSearch.value) : [];
  if (!matches.some((m) => m.id === sendCardId)) sendCardId = null;
  sendCardResults.replaceChildren();
  if (matches.length === 0) {
    const none = document.createElement("span");
    none.className = "wb-send-none";
    none.textContent = board ? "No matching cards" : "";
    sendCardResults.appendChild(none);
  }
  for (const m of matches) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "wb-card-result";
    row.classList.toggle("active", m.id === sendCardId);
    const num = document.createElement("span");
    num.className = "wb-card-result-num";
    num.textContent = `#${m.number}`;
    const title = document.createElement("span");
    title.className = "wb-card-result-title";
    title.textContent = m.title;
    const col = document.createElement("span");
    col.className = "wb-card-result-col";
    col.textContent = m.column;
    row.append(num, title, col);
    row.addEventListener("click", () => {
      sendCardId = m.id;
      renderCardResults();
    });
    sendCardResults.appendChild(row);
  }
  updateSendButtons();
}

/** The Advanced choices, for the cards a send creates. */
function sendOptions(): IncomingOptions {
  const priority = sendPriority.value as Priority;
  const effort = sendEffort.value as Effort;
  // Checked against the ladder rather than a constant. applyIncomingOptions
  // checks again on the far side; this is what stops the field being sent at
  // all when it is the unset rung.
  return {
    tagIds: [...sendTagIds],
    priority: priority && priority !== NO_LEVEL ? priority : undefined,
    effort: effort && effort !== NO_LEVEL ? effort : undefined,
    due: sendDue.value || undefined,
    description: sendDescription.value.trim() || undefined,
  };
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
  const cards = picked === 0 ? 0 : sendTitle.value.trim() ? 1 : picked;
  sendCount.textContent = `${picked} of ${total} \u00b7 ${cards} ${cards === 1 ? "card" : "cards"}`;
  sendAllBtn.textContent = picked === total ? "Select None" : "Select All";
  const existing = sendTabs.active === "image" && sendDest === "existing";
  const hasTarget = !sendBoardSel.disabled && (existing || !sendColumnSel.disabled) && !sendBusy;
  const ready =
    hasTarget &&
    (sendTabs.active === "text" ? picked > 0 : chosenArea() !== null && (!existing || sendCardId !== null));
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
  const result = await addCardsFromElsewhere(dest.board.id, dest.column.id, cardsToSend(chosen), sendOptions());
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
    if (settings.homeAfterSend) goHome();
    await flushSave();
  }
  const n = result.numbers.length;
  flash(`Sent ${n} ${n === 1 ? "card" : "cards"} to "${dest.board.name}".`, "success");
}

async function sendImage(clearAfter: boolean): Promise<void> {
  const area = chosenArea();
  const includeText = sendIncludeText.checked;
  const board = sendTargets.find((t) => t.id === sendBoardSel.value);
  const existing = sendDest === "existing";
  // An existing card has a column of its own, so only a new card needs one.
  const dest = existing ? null : sendDestination();
  if (!board || !area || sendBusy || (existing ? !sendCardId : !dest)) return;

  setSendBusy(true);
  const png = renderArea(area, includeText).toDataURL("image/png").split(",")[1] ?? "";
  const fileName = `whiteboard-${fileTimestamp()}.png`;
  const result =
    existing && sendCardId
      ? await attachImageToCard(board.id, sendCardId, fileName, png)
      : await addImageCardFromElsewhere(
          board.id,
          dest!.column.id,
          sendTitle.value.trim().slice(0, MAX_TITLE_LEN) || "Whiteboard",
          fileName,
          png,
          sendOptions(),
        );
  setSendBusy(false);
  if (!result.ok) {
    flash(result.error, "error", 8000);
    return;
  }
  sendModal.close();
  if (!result.saved) {
    flash("Kanban couldn't save the card.", "error", 8000);
    return;
  }

  if (clearAfter) {
    checkpoint();
    clearArea(area, includeText);
    markDirty();
    updateChrome();
    if (settings.homeAfterSend) goHome();
    await flushSave();
  }
  flash(existing ? `Added to card #${result.number}.` : `Sent to "${board.name}".`, "success");
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
      syncSendFields();
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
  sendTitle = document.getElementById("wbSendTitle") as HTMLInputElement;
  sendPreview = document.getElementById("wbSendPreview") as HTMLImageElement;
  sendAreaNote = document.getElementById("wbSendAreaEmpty")!;
  sendColumnField = document.getElementById("wbSendColumnField")!;
  sendDestGroup = document.getElementById("wbSendDestGroup")!;
  sendNewFields = document.getElementById("wbSendNewFields")!;
  sendExistingFields = document.getElementById("wbSendExistingFields")!;
  sendCardSearch = document.getElementById("wbSendCardSearch") as HTMLInputElement;
  sendCardResults = document.getElementById("wbSendCardResults")!;
  sendAdvanced = document.getElementById("wbSendAdvanced") as HTMLDetailsElement;
  sendPriority = document.getElementById("wbSendPriority") as HTMLSelectElement;
  sendEffort = document.getElementById("wbSendEffort") as HTMLSelectElement;
  sendDue = document.getElementById("wbSendDue") as HTMLInputElement;
  sendDescription = document.getElementById("wbSendDescription") as HTMLTextAreaElement;
  sendTagsEl = document.getElementById("wbSendTags")!;

  sendCardSearch.addEventListener("input", renderCardResults);
  // A typed title changes how many cards a text send makes.
  sendTitle.addEventListener("input", updateSendButtons);
  document.querySelectorAll<HTMLButtonElement>(".wb-dest-btn").forEach((b) => {
    b.addEventListener("click", () => {
      sendDest = b.dataset.dest === "existing" ? "existing" : "new";
      syncSendFields();
      if (sendDest === "existing") {
        renderCardResults();
        sendCardSearch.focus();
      }
    });
  });

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

type SetupTab = "preferences" | "data" | "info";

let setupModal: Modal;
let gridToggle: HTMLInputElement;
let gridLabel: HTMLElement;
let homeToggle: HTMLInputElement;
let homeLabel: HTMLElement;
let selTextToggle: HTMLInputElement;
let selTextLabel: HTMLElement;
let boardColorSel: HTMLSelectElement;
let boardColorInput: HTMLInputElement;
let boardCustomRow: HTMLElement;

/** Every control in Setup, put back to what the settings say. Run on every
 *  open, so a control can never show a value that is not the one in use. */
function applySettingsToForm(): void {
  gridToggle.checked = settings.grid;
  gridLabel.textContent = settings.grid ? "Enabled" : "Disabled";
  homeToggle.checked = settings.homeAfterSend;
  homeLabel.textContent = settings.homeAfterSend ? "Enabled" : "Disabled";
  selTextToggle.checked = settings.selectionStylesText;
  selTextLabel.textContent = settings.selectionStylesText ? "Enabled" : "Disabled";
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
    panes: { preferences: "wbTabPreferences", data: "wbTabData", info: "wbTabInfo" },
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
  homeToggle = document.getElementById("wbHomeToggle") as HTMLInputElement;
  homeLabel = document.getElementById("wbHomeLabel")!;
  selTextToggle = document.getElementById("wbSelTextToggle") as HTMLInputElement;
  selTextLabel = document.getElementById("wbSelTextLabel")!;
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
  homeToggle.addEventListener("change", () => {
    settings.homeAfterSend = homeToggle.checked;
    saveSettings();
    applySettingsToForm();
  });
  selTextToggle.addEventListener("change", () => {
    settings.selectionStylesText = selTextToggle.checked;
    saveSettings();
    applySettingsToForm();
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
    { label: "Cut", disabled: !selection, onClick: cutSelection },
    { label: "Copy", disabled: !selection, onClick: () => void copySelection() },
    {
      label: "Paste",
      disabled: !clipboard,
      onClick: () => {
        // Where the menu was opened, not wherever the pointer went after.
        lastPointer = menuPoint;
        pasteClipboard();
      },
    },
    { label: "Delete", danger: true, disabled: !selection, onClick: deleteSelection },
    { separator: true },
    { label: "Send to Kanban…", disabled: isEmpty(), onClick: () => openSend() },
    { label: "Send Selection to Kanban…", disabled: !selection, onClick: () => openSend("image") },
    { label: "Clear Whiteboard…", danger: true, disabled: isEmpty(), onClick: requestClear },
    // A menu on a background carries the app-wide rows, or it has removed them.
    { separator: true },
    ...backgroundMenu(),
  ];
}

const SIZE_LABELS: Record<SizeId, string> = { fine: "Small", medium: "Medium", bold: "Large" };

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
  const runsCarry = (note.runs ?? []).some(
    (r) => (patch.ink !== undefined && r.ink !== undefined) || (patch.size !== undefined && r.size !== undefined),
  );
  if (
    !runsCarry &&
    (patch.ink === undefined || patch.ink === note.ink) &&
    (patch.size === undefined || patch.size === note.size)
  ) {
    return;
  }
  checkpoint();
  styleWholeNote(note, patch);
  const el = noteEls.get(id);
  if (el) renderRuns(el, note);
  markDirty();
  updateChrome();
}

/** Opens the system color picker for the pen or for one text box. */
function pickColorFor(target: typeof colorFor): void {
  colorFor = target;
  pickerSelection = editingId ? captureEditSelection() : null;
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
  // Written out on the way past if anything is still queued. See
  // flushOnQuit in shell.ts.
  flushOnQuit("whiteboard", onWhiteboardToolExit);
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
  // Off the board, a paste goes near the top of the view instead.
  surface.addEventListener("pointerleave", () => {
    lastPointer = null;
  });
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
    b.addEventListener("click", () => {
      const mode = b.dataset.mode as Mode;
      setMode(mode);
      if (mode === "shape" || mode === "erase") toggleModePop(mode);
      else closePops();
    });
  });
  document.querySelectorAll<HTMLButtonElement>(".wb-shape-btn").forEach((b) => {
    b.addEventListener("click", () => {
      settings.shape = b.dataset.shape as ShapeKind;
      saveSettings();
      closePops();
      updateChrome();
    });
  });
  document.querySelectorAll<HTMLButtonElement>(".wb-eraser-btn").forEach((b) => {
    b.addEventListener("click", () => {
      settings.eraser = b.dataset.eraser as EraserKind;
      saveSettings();
      closePops();
      updateChrome();
    });
  });
  document.querySelectorAll<HTMLButtonElement>(".wb-size-btn").forEach((b) => {
    b.addEventListener("click", () => setSize(b.dataset.size as SizeId));
  });
  /* Color, size, Undo and Redo work on the box being typed in, so pressing
     them must not take the focus out of it: a mousedown that is let through
     blurs the box, which ends the edit before the click arrives. */
  const keepsTyping = [
    colorBtn,
    undoBtn,
    redoBtn,
    ...document.querySelectorAll<HTMLButtonElement>(".wb-size-btn, #wbColorPop .wb-swatch"),
  ];
  for (const b of keepsTyping) {
    b.addEventListener("mousedown", (e) => {
      if (editingId) e.preventDefault();
    });
  }
  // While typing, Undo and Redo are the box's own typing history.
  undoBtn.addEventListener("click", () => (editingId ? document.execCommand("undo") : undo()));
  redoBtn.addEventListener("click", () => (editingId ? document.execCommand("redo") : redo()));
  sendOpenBtn.addEventListener("click", () => openSend());
  document.getElementById("wbZoomOutBtn")!.addEventListener("click", () => stepZoom(-1));
  document.getElementById("wbZoomInBtn")!.addEventListener("click", () => stepZoom(1));
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

  const repaintForTheme = (): void => {
    resolveInkColors();
    updateCursor();
    requestRedraw();
  };
  window.addEventListener("themechange", repaintForTheme);
  /* A Custom theme is applied by writing its colors onto the page's root
     element, and the theme editor previews edits the same way, and neither
     announces a "themechange". The text boxes follow those colors on their
     own, through CSS; the canvas only sees them when asked, so it watches the
     root for them. Batched to one repaint a frame, since a custom theme
     writes forty-odd properties one at a time. */
  let themeRepaintQueued = false;
  new MutationObserver(() => {
    if (themeRepaintQueued) return;
    themeRepaintQueued = true;
    requestAnimationFrame(() => {
      themeRepaintQueued = false;
      repaintForTheme();
    });
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });

  updateChrome();
  void load();
}
