/* =============================================================================
   KANBAN BOARDS
   -----------------------------------------------------------------------------
   Boards of columns of cards, with the card dragged across the columns rather
   than edited into a new state. Local, single-user: no assignment, no sharing,
   no accounts. What that leaves is the part of Kanban that was always the
   point, making the work visible and limiting how much of it is in flight.

   Architecture notes:

     • ONE FLAT `cards` ARRAY, keyed by boardId + columnId, rather than cards
       nested inside their column. Every question worth asking spans columns
       ("what is overdue", "what got finished this month", "where is card 42"),
       and a nested shape answers those by walking three levels and rebuilding
       the answer each time. Order within a column is an explicit `order` field,
       re-sequenced from the DOM after every drag, so a reorder is one commit
       rather than a splice into a shared array.

     • COLUMNS ARE NESTED IN THE BOARD, and their order is the array order. They
       are a property of the board's shape, are never queried across boards, and
       there are rarely more than half a dozen. The asymmetry with cards is
       deliberate, not an oversight.

     • STAGE DATES ARE THE MODEL, not a log. A card carries four dates (due,
       start work, start testing, complete). The Advance button stamps the next
       one with today and Undo clears the most recent, but every one of them is
       also directly editable, because the honest case is that work started on
       Tuesday and you are filling the card in on Thursday. Every duration this
       tool reports is computed from those four dates and nothing else, so a
       stat can always be traced to a date you can see and correct.

     • DERIVED, NEVER STORED. Card counts, WIP pressure, overdue state, lead and
       cycle times, board stats: all computed on render from `cards`. Nothing is
       cached, so nothing can disagree with the board you are looking at.

     • A CARD'S NUMBER IS PER BOARD AND PERMANENT. `id` is a UUID and is what
       everything actually references; `number` is the small human handle
       ("#42") shown on the card, assigned once from the board's own counter and
       never reissued, so it stays a reliable thing to say out loud even after
       cards around it are deleted. Same rule as Game Stats' game numbers.

     • THE CARD MODAL SAVES AS YOU TYPE (debounced). A card is a thing you poke
       at repeatedly, and a Save button on that is a way to lose a subtask you
       ticked. The board underneath re-renders from the same state on close.

   Rust commands used:
     save_kanban_data, load_kanban_data, list_kanban_backups, read_kanban_backup,
     import_kanban_image, delete_kanban_image, export_kanban_data
============================================================================= */

import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  devError,
  flash,
  setSubNavHandler,
  setToolAttention,
  shortPath,
  settings as shellSettings,
} from "../core/shell";
import { Modal, ModalTabs } from "../modal/modal";
import { attachMenu, closeMenu, openMenu, type MenuItem } from "../menu/menu";

/* =============================================================================
   TYPES
============================================================================= */

export type KbStatus = "active" | "retired";

/** A grouping of tags that only mean something together: "Versions" holding
 *  v0.1.0/v0.2.0, "Areas" holding UI/Backend/Docs. Filtering treats each
 *  category as its own facet (see cardMatchesFilters). */
/**
 * A grouping of tags that only mean something together: "Versions" holding
 * v0.1.0/v0.2.0, "Areas" holding UI/Backend/Docs.
 *
 * ORDER IS RANK. A category's position in Board.tagCategories decides where its
 * tags appear on a card and which one a tag-colored card takes its color from,
 * so "Priority-ish things first, Areas last" is expressible by moving the
 * category rather than by a separate number that could disagree with the list.
 */
export interface TagCategory {
  id: string;
  name: string;
  /** What a tag in this category falls back to. null means the category has no
   *  color of its own, and a tag that also has none renders as a plain outline
   *  rather than being given a color it never asked for. */
  color: string | null;
  status: KbStatus;
}

export interface Tag {
  id: string;
  categoryId: string;
  name: string;
  /** null inherits the category's color. */
  color: string | null;
  status: KbStatus;
}

/* -----------------------------------------------------------------------------
   PRIORITY
   -----------------------------------------------------------------------------
   A fixed ladder rather than a user-defined vocabulary, unlike tags. Priority
   only means anything if the levels mean the same thing everywhere: "High" on
   one board and "High" on another have to be comparable, or sorting and
   coloring by it says nothing. The COLORS are configurable, because those are
   presentation; the rungs are not.
----------------------------------------------------------------------------- */

export type Priority = "none" | "trivial" | "low" | "medium" | "high" | "critical";

/** Lowest to highest, and the order the picker offers them in. */
export const PRIORITIES: readonly Priority[] = [
  "none",
  "trivial",
  "low",
  "medium",
  "high",
  "critical",
];

export const PRIORITY_LABELS: Record<Priority, string> = {
  none: "None",
  trivial: "Trivial",
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};

/** Green through red, skipping "none", which is the absence of a priority and
 *  so has no color: a card with no priority set must not be painted grey as if
 *  grey were a priority. */
/** Blue, then green through red. Blue rather than a paler green for Trivial
 *  because it sits OUTSIDE the urgency ramp: "worth doing, not worth ranking"
 *  is a different statement from "low urgency", and a colder hue says that
 *  without needing a legend. */
export const DEFAULT_PRIORITY_COLORS: Record<Priority, string> = {
  none: "#6b7280",
  trivial: "#3e8ce8",
  low: "#30a46c",
  medium: "#e0a11b",
  high: "#e5651f",
  critical: "#e5484d",
};

/**
 * Where a card's color comes from.
 *
 *   "manual"    the color set on the card itself
 *   "tag"       the first tag it carries, walking categories in rank order
 *   "priority"  the color of its priority level
 *
 * Set as a default per board and overridable per card, because "every card on
 * this board is colored by priority" is a board-level decision and "except this
 * one" is a card-level one.
 */
export type CardColorMode = "manual" | "tag" | "priority";

/** How a solid card's text is chosen. "auto" measures contrast; the other two
 *  are for when you want it to match a set of cards regardless. */
export type CardTextColor = "auto" | "light" | "dark";

export interface Subtask {
  id: string;
  text: string;
  done: boolean;
}

/** The three stamps the Advance button walks through, in order. `due` is
 *  deliberately not one of them: it is a target, not a thing that happened. */
export const STAGES = ["started", "testing", "completed"] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  started: "Work Started",
  testing: "Testing Started",
  completed: "Completed",
};

/** What the Advance button says when the card's furthest stamp is the one
 *  before this stage. Indexed the same way STAGES is. */
export const ADVANCE_LABELS: Record<Stage, string> = {
  started: "Start Work",
  testing: "Start Testing",
  completed: "Mark Complete",
};

export interface CardDates {
  due: string | null;
  started: string | null;
  testing: string | null;
  completed: string | null;
}

export interface Card {
  id: string;
  boardId: string;
  columnId: string;
  /** Per-board, permanent, human-facing. See the header note. */
  number: number;
  title: string;
  description: string;
  /** The MANUAL color, as #rrggbb, or null for the theme's own card surface.
   *  Only used when this card resolves to the "manual" color mode. */
  color: string | null;
  /** null follows the board's default color mode. */
  colorMode: CardColorMode | null;
  textColor: CardTextColor;
  priority: Priority;
  tagIds: string[];
  subtasks: Subtask[];
  dates: CardDates;
  /** Out of the board but not destroyed. Archived cards keep their column so
   *  restoring puts them back where they were. */
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  /** Position within its column. Re-sequenced 0..n-1 on every commit. */
  order: number;
}

export interface Column {
  id: string;
  title: string;
  /** Kanban's one non-negotiable practice. null means unlimited. */
  wipLimit: number | null;
  /** Cards here count as finished: throughput is measured from this column,
   *  and (with the preference on) a drop here stamps the Complete date. */
  isDone: boolean;
  collapsed: boolean;
}

export interface BoardBackground {
  /** Absolute path inside the app's kanban-backgrounds/ folder. */
  path: string;
  /** CSS blur radius in px, 0-24. */
  blur: number;
  /** CSS brightness percentage, 15-150. */
  brightness: number;
}

/**
 * A board, as the app holds it in memory. On disk it is split in two, and the
 * seam runs right through this object:
 *
 *   the INDEX (kanban-index.json, always plaintext) carries id, name,
 *   description, background, createdAt and updatedAt, so the gallery can list
 *   and draw a board it cannot open;
 *
 *   the BOARD FILE (kanban-board-<id>.json or .enc) carries columns and
 *   nextCardNumber, alongside that board's cards.
 *
 * `locked` is the whole reason the seam is where it is: an encrypted board
 * whose contents have not been decrypted this session is a real board with a
 * real name and a real background and no columns and no cards. Everything that
 * renders a board has to cope with that, and putting the flag on the board
 * itself is what makes the compiler and the reader agree about where.
 */
export interface Board {
  id: string;
  name: string;
  description: string;
  columns: Column[];
  background: BoardBackground | null;
  /** Next value for a new card's `number`. Only ever increases. */
  nextCardNumber: number;
  createdAt: number;
  updatedAt: number;
  /** Encrypted and not opened this session: contents are empty. */
  locked: boolean;
  /** THIS BOARD's tag vocabulary. See the note on KanbanIndex. */
  tagCategories: TagCategory[];
  tags: Tag[];
  /** The settings this board disagrees with the defaults about. Absent keys
   *  mean "whatever the default is", and keep meaning that when the default
   *  changes, which is the entire point of storing the exceptions rather than
   *  a full copy. */
  overrides: Partial<BoardScopedSettings>;
}

/** The board fields that live in the always-plaintext index. */
export type BoardMeta = Omit<
  Board,
  "columns" | "nextCardNumber" | "locked" | "tagCategories" | "tags" | "overrides"
>;

/** The board fields that live in the per-board file, which may be encrypted.
 *  Its tags are in here rather than in the index on purpose: a board's tag
 *  names ("v0.3.0-hotfix", a client name) are as revealing as its cards, so an
 *  encrypted board's vocabulary is encrypted with it. */
export interface BoardContents {
  columns: Column[];
  cards: Card[];
  nextCardNumber: number;
  tagCategories: TagCategory[];
  tags: Tag[];
  overrides: Partial<BoardScopedSettings>;
}

/**
 * kanban-index.json: the board list, plus the DEFAULT tag vocabulary.
 *
 * The tags here are templates, not the tags on any card. Cards carry ids from
 * their own board's vocabulary (Board.tags), which starts empty and is filled
 * by copying from these defaults and then diverging.
 *
 * That split exists because a tag axis is usually shared and its values usually
 * are not: every board wants a "Versions" category, and no two boards want the
 * same versions in it. One global list would force every board to carry every
 * other board's version numbers.
 */
export interface KanbanIndex {
  boards: BoardMeta[];
  tagCategories: TagCategory[];
  tags: Tag[];
}

export type CardSize = "comfortable" | "compact";

/** Where a new card lands. Not a setting: the control you used says which end
 *  you meant. The + in the column header adds to the top, the Add card button
 *  at the foot of the column adds to the bottom. */
export type NewCardPosition = "top" | "bottom";

/** The blocks of the card modal, in the order they are shown. Reorderable, as
 *  a default and then per board, because which of these you look at first is a
 *  property of how you work rather than of the tool. */
export type CardSection = "description" | "tags" | "subtasks" | "due" | "stages";

export const CARD_SECTIONS: readonly CardSection[] = [
  "description",
  "tags",
  "subtasks",
  "due",
  "stages",
];

export const CARD_SECTION_LABELS: Record<CardSection, string> = {
  description: "Description",
  tags: "Tags",
  subtasks: "Subtasks",
  due: "Due Date",
  stages: "Stage Dates",
};

/**
 * The settings a board is allowed to disagree with.
 *
 * Every one of these describes how a board LOOKS or how working on it BEHAVES,
 * which is exactly the kind of thing that differs between a release board and a
 * shopping list. The settings that are not in here (the overdue warning, the
 * default column set, the tool lock) are properties of the tool as a whole, and
 * a per-board answer to them would be meaningless or actively confusing.
 */
export interface BoardScopedSettings {
  confirmDelete: boolean;
  autoCompleteOnDone: boolean;
  showTags: boolean;
  showSubtasks: boolean;
  showDates: boolean;
  showNumbers: boolean;
  /** The small delete button in a card's top corner, on the board itself. */
  showCardDelete: boolean;
  /** The work-stage dates (started / testing / completed) and the Advance
   *  button. */
  showStages: boolean;
  /** The due date. Separate from showStages, and separately optional: a due
   *  date is a target rather than a record of something that happened, and a
   *  board can reasonably want one without the other in either direction. */
  showDue: boolean;
  /** Where a card on this board gets its color from, unless the card says
   *  otherwise. */
  cardColorMode: CardColorMode;
  cardSize: CardSize;
  sectionOrder: CardSection[];
}

/** Everything in BoardScopedSettings is a DEFAULT that a board may override.
 *  The three added here are tool-wide and cannot be overridden. */
export interface KbSettings extends BoardScopedSettings {
  overdueWarn: boolean;
  /** Comma-separated column titles a brand-new board starts with. */
  defaultColumns: string;
  /** Prefilled into the New Board form. Empty means no suggestion. */
  defaultBoardName: string;
  /** One color per priority level. Global rather than per board: a level has
   *  to look the same everywhere or it stops being a shared scale. */
  priorityColors: Record<Priority, string>;
  /**
   * Ask for the Kanban password when the tool is opened, rather than only when
   * an encrypted board is opened.
   *
   * This IS the "lock the whole tool" feature, and it is a gate rather than a
   * second layer of encryption. Nothing is encrypted twice by turning it on and
   * no board has to be decrypted first, because it asks for the same one
   * password the boards already use. Meaningless (and ignored) when no board is
   * encrypted, since there is then no password to ask for.
   */
  lockOnOpen: boolean;
}

/**
 * The shape of an EXPORT, and only of an export. Nothing on disk looks like
 * this: the live data is split across kanban-settings.json, kanban-index.json
 * and one file per board.
 *
 * Deliberately self-contained rather than mirroring that split. A file you take
 * out of the app has to stand on its own; an export that referenced five other
 * files it did not come with would not be an export.
 */
export interface KanbanStore {
  version: number;
  /** Each board carries its own tags and overrides, so an exported board is
   *  complete on its own rather than needing the defaults to be read back. */
  boards: Board[];
  cards: Card[];
  /** The DEFAULT vocabulary, for reference. Not what any card points at. */
  tagCategories: TagCategory[];
  tags: Tag[];
  settings: KbSettings | null;
}

/* =============================================================================
   CONSTANTS
============================================================================= */

const STORE_VERSION = 1;

/** How long an edit sits before it is written. Long enough that typing a
 *  description is one write rather than forty, short enough that a crash
 *  between keystroke and save costs half a second of typing. */
const SAVE_DEBOUNCE_MS = 400;

/** Ceilings that exist to keep the board renderable rather than to ration
 *  anything: every card in a column is in the DOM at once, and the whole board
 *  re-renders after each drag. */
const MAX_CARDS_PER_BOARD = 2000;
const MAX_COLUMNS_PER_BOARD = 24;
const MAX_SUBTASKS_PER_CARD = 100;

const MAX_TITLE_LEN = 200;
const MAX_DESC_LEN = 8000;

/** The card color swatches. Twelve hues at two lightnesses each would be a
 *  color picker; this is a palette, so it is one row of hues chosen to stay
 *  distinguishable from each other AND from every theme's own card surface.
 *  The custom picker beside them covers everything else. */
const CARD_COLORS = [
  "#e5484d", "#e5651f", "#e0a11b", "#8ab61c",
  "#30a46c", "#12a5a5", "#3e8ce8", "#5b5bd6",
  "#8e4ec6", "#c94f9c", "#8b6a4a", "#6b7280",
];

/** Default color for a new tag category, and the fallback for any tag whose
 *  stored color is unreadable. */
const DEFAULT_TAG_COLOR = "#4c8dff";

/** The column set a fresh install starts with, and what Reset puts back. Held
 *  separately from DEFAULT_SETTINGS so that "reset" means these five
 *  specifically rather than "whatever the default object happens to say" -
 *  the same thing today, and not the day someone edits one of them.
 *
 *  The trailing "*" marks the column that means done; see splitDoneMark. */
const SYSTEM_DEFAULT_COLUMNS = "Backlog, Planned, Work In Progress, Testing, Completed*";

/** The two inks card and chip text can be set in. Near-black rather than pure
 *  black because a pure-black label on a mid-tone card reads as a hole; the
 *  contrast maths below uses these exact values, so what is measured is what
 *  is painted. */
const DARK_INK = "#101014";
const LIGHT_INK = "#ffffff";

const DEFAULT_SETTINGS: KbSettings = {
  confirmDelete: true,
  autoCompleteOnDone: true,
  showTags: true,
  showSubtasks: true,
  showDates: true,
  showNumbers: true,
  showCardDelete: false,
  showStages: true,
  showDue: true,
  cardColorMode: "manual",
  cardSize: "comfortable",
  // What the card IS, then what it needs, then when it is wanted, then what has
  // happened to it. Anything can be dragged anywhere; this is only the start.
  sectionOrder: ["description", "tags", "subtasks", "due", "stages"],
  overdueWarn: true,
  defaultColumns: SYSTEM_DEFAULT_COLUMNS,
  defaultBoardName: "",
  priorityColors: { ...DEFAULT_PRIORITY_COLORS },
  lockOnOpen: false,
};

/* =============================================================================
   STATE
============================================================================= */

let boards: Board[] = [];
/** Cards for every board whose contents are in memory. A locked board
 *  contributes nothing here, which is exactly why it renders as locked. */
let cards: Card[] = [];
/** The DEFAULT tag vocabulary, from the index. Templates to copy onto a board,
 *  never what a card points at: see the note on KanbanIndex. */
let globalTagCategories: TagCategory[] = [];
let globalTags: Tag[] = [];
let kbSettings: KbSettings = { ...DEFAULT_SETTINGS };

/** False until the first load has settled. Guards every write, so an edit made
 *  in the first moments of app start cannot persist over the real data. */
let storeLoaded = false;

let saveTimer: number | null = null;

/* -----------------------------------------------------------------------------
   WHAT IS DIRTY
   -----------------------------------------------------------------------------
   Saving used to be one call writing one blob. With the files split, "save" has
   to know WHICH file changed, or renaming a board would rewrite every board you
   own and the split would have bought nothing.

   Three flags, set by the mutation helpers (markIndex / markBoard / markSettings)
   and cleared by the flush. Deliberately coarse: within one file the whole file
   is rewritten, because a board file is a few KB and partial writes are how you
   get a file that disagrees with itself.
----------------------------------------------------------------------------- */
let dirtyIndex = false;
let dirtySettings = false;
const dirtyBoards = new Set<string>();

/* -----------------------------------------------------------------------------
   ENCRYPTION STATE
   -----------------------------------------------------------------------------
   One password for the whole tool; each board opts in individually. See the
   header of kanban.rs for why it is one and not one per board.
----------------------------------------------------------------------------- */

/** Board ids that have an .enc file on disk. Read from the backend, never
 *  inferred from a stored flag: a flag can disagree with the files. */
let encryptedBoardIds = new Set<string>();

/**
 * The password, held for as long as this visit to the tool lasts and never
 * written anywhere. Cleared by Lock Now, and by leaving the tool when
 * lockOnOpen is set.
 *
 * Held at all because the alternative is retyping it on every debounced save,
 * which would make an encrypted board unusable rather than secure.
 */
let sessionPassword: string | null = null;

/** True while the tool-lock gate is covering the tool. */
let authGateShowing = false;

/**
 * False until initKanban() has run.
 *
 * This is not defensive habit, it is a real ordering problem: shell.ts calls
 * loadShellState() at the TOP of its init and every init*() at the bottom, so
 * an app whose saved startup target is this tool navigates into it, and fires
 * onKanbanToolEntry(), before a single element reference here has been
 * assigned. Without this guard that is a crash on launch, and the only way to
 * get out of it is to edit the settings file by hand.
 */
let initialised = false;

/** Which board the board view is showing, or null on the gallery. */
let currentBoardId: string | null = null;

/** Session-scoped filters. Cleared on tool entry and when leaving a board, the
 *  same "only reset if you leave the view as a whole" rule Game Stats uses:
 *  opening a card is a detour, walking out to the gallery is a departure. */
let filterText = "";
let filterTagIds = new Set<string>();
let filterDue: "any" | "overdue" | "soon" | "none" = "any";
let filterBarOpen = false;

/** The card the card modal is currently showing. */
let openCardId: string | null = null;

/* =============================================================================
   ELEMENT REFS
   Assigned in initKanban(), never at module load: this file is imported by
   shell.ts, so its body runs before the shell has finished setting itself up.
============================================================================= */

let viewBoards: HTMLElement;
let viewBoard: HTMLElement;
let boardGrid: HTMLElement;
let boardsEmpty: HTMLElement;
let boardSearchInput: HTMLInputElement;
let gallerySummary: HTMLElement;
let boardBgLayer: HTMLElement;
let boardTitleEl: HTMLElement;
let boardCountsEl: HTMLElement;
let columnsEl: HTMLElement;
let columnsEmpty: HTMLElement;
let cardSearchInput: HTMLInputElement;
let filterBar: HTMLElement;
let filterBtn: HTMLButtonElement;
let boardSetupBtn: HTMLButtonElement;
let headerNoticeWrap: HTMLElement;
let headerNotice: HTMLElement;
let authView: HTMLElement;

/* =============================================================================
   SMALL UTILITIES
============================================================================= */

function newId(): string {
  return crypto.randomUUID();
}

/** Today as YYYY-MM-DD in LOCAL time. Not toISOString(), which is UTC and
 *  stamps a card with tomorrow's date for anyone east of Greenwich in the
 *  evening. */
function today(): string {
  return new Date().toLocaleDateString("en-CA");
}

/** Parses a YYYY-MM-DD string to a local Date at midday. Midday, not midnight,
 *  so a day difference computed across a daylight-saving boundary is still a
 *  whole number of days rather than 0.958 of one. */
export function parseDay(value: string | null | undefined): Date | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0, 0);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Whole days from `from` to `to`, or null if either is missing/unparseable.
 *  Negative when `to` precedes `from`, which callers rely on for "overdue by". */
export function dayDiff(from: string | null, to: string | null): number | null {
  const a = parseDay(from);
  const b = parseDay(to);
  if (!a || !b) return null;
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

/** Renders a date in the app's chosen order. The stored form is always
 *  YYYY-MM-DD; only the display flips. */
function formatDate(value: string | null): string {
  if (!value) return "—";
  if (!shellSettings.americanDates) return value;
  const [y, m, d] = value.split("-");
  return `${m}-${d}-${y}`;
}

/** "same day" / "1 day" / "12 days". Used everywhere a duration is reported,
 *  so a zero-length stage never reads as the ambiguous "0 days". */
export function describeDays(n: number): string {
  if (n === 0) return "same day";
  const abs = Math.abs(n);
  return `${abs} ${abs === 1 ? "day" : "days"}`;
}

/** The epoch-ms timestamp a card was created, as a YYYY-MM-DD local date, so
 *  it can be compared against the stage dates on the same footing. */
export function createdDay(card: Card): string {
  return new Date(card.createdAt).toLocaleDateString("en-CA");
}

function clampInt(value: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

function trimTo(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

/* =============================================================================
   COLOR
   -----------------------------------------------------------------------------
   A solid card is a card the theme no longer controls, so the text on it has
   to be chosen rather than inherited. This does that properly (WCAG relative
   luminance and contrast ratio) rather than by the usual "is the average of
   the channels over 128" shortcut, which gets pure yellow and mid blue exactly
   backwards: yellow is far brighter than its average suggests and needs dark
   ink, saturated blue is far darker and needs light.
============================================================================= */

export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** True for anything hexToRgb can read. Used to reject a color that came off
 *  disk in some other shape before it reaches a style property. */
export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && hexToRgb(value) !== null;
}

function channelToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 1;
  return (
    0.2126 * channelToLinear(rgb.r) +
    0.7152 * channelToLinear(rgb.g) +
    0.0722 * channelToLinear(rgb.b)
  );
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Whichever of the two inks is more legible on `background`. Measured against
 *  the actual ink values, not against pure black and white, so the answer
 *  matches what gets painted. */
export function readableTextOn(background: string): string {
  return contrastRatio(background, DARK_INK) >= contrastRatio(background, LIGHT_INK)
    ? DARK_INK
    : LIGHT_INK;
}

/** The ink to actually paint, honouring a card's choice.
 *
 *  "auto" measures and picks the readable one, which is the right default and
 *  what everything did before this was a choice. Forcing light or dark is for
 *  when a run of cards should match each other more than each should be
 *  individually optimal, and it is allowed to be the less readable option:
 *  that is what asking for it means. */
export function inkFor(background: string, preference: CardTextColor): string {
  if (preference === "light") return LIGHT_INK;
  if (preference === "dark") return DARK_INK;
  return readableTextOn(background);
}

/** `hex` at `alpha`, as an rgba() string. For the secondary text and hairlines
 *  on a solid card, which have to be a wash of the CHOSEN ink rather than of
 *  the theme's muted color, or they vanish. */
function inkWash(hex: string, alpha: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return `rgba(128,128,128,${alpha})`;
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

/** Paints an element as a solid colored surface with legible text on it, or
 *  strips that painting when `color` is null. One function so the card, the
 *  board tile and the color swatches can never disagree about what a color
 *  looks like. */
function applySolidColor(
  el: HTMLElement,
  color: string | null,
  textColor: CardTextColor = "auto",
): void {
  if (!color || !isHexColor(color)) {
    el.classList.remove("kb-solid");
    el.style.removeProperty("background");
    el.style.removeProperty("color");
    el.style.removeProperty("--kb-ink-soft");
    el.style.removeProperty("--kb-ink-faint");
    el.style.removeProperty("--kb-ink-border");
    return;
  }
  const ink = inkFor(color, textColor);
  el.classList.add("kb-solid");
  el.style.background = color;
  el.style.color = ink;
  // The border goes out as a CUSTOM PROPERTY, not as an inline border-color.
  // An inline declaration beats every rule in the stylesheet, so setting it
  // directly would freeze the border for the element's whole life: the hover
  // state could never brighten it. A variable is a value the stylesheet can
  // still make decisions with.
  el.style.setProperty("--kb-ink-border", inkWash(ink, 0.28));
  el.style.setProperty("--kb-ink-soft", inkWash(ink, 0.75));
  el.style.setProperty("--kb-ink-faint", inkWash(ink, 0.3));
}

/* =============================================================================
   PERSISTENCE
============================================================================= */

/* -----------------------------------------------------------------------------
   LOADING

   Order matters and is not arbitrary:

     1. settings, because lockOnOpen decides whether the tool even opens;
     2. the index, which is the board list;
     3. lock status, which says which of those boards are ciphertext;
     4. the plaintext boards' contents.

   Encrypted boards are NOT loaded here. They stay locked until asked for, which
   is the entire point of encrypting them.
----------------------------------------------------------------------------- */

async function loadAll(): Promise<void> {
  try {
    await loadSettings();
    await loadIndex();
    await refreshLockStatus();
    await loadUnlockedBoards();
  } catch (err) {
    devError("[kanban] load failed", err);
    flash(`Couldn't load Kanban data: ${String(err)}`, "error", 8000);
  } finally {
    // Set even on failure. A load that errored has already been reported, and
    // leaving writes blocked for the rest of the session would silently stop
    // persisting everything the user does next.
    storeLoaded = true;
  }
  applySettingsToForm();
  // Applied here as well as on tool entry, because the entry hook may have
  // already run and returned early (see `initialised`) while this load was
  // still in flight. Without it, launching straight into a locked Kanban shows
  // no gate at all for that first visit.
  showAuthGate(gateRequired());
  renderAll();
}

async function loadSettings(): Promise<void> {
  const raw = await invoke<string>("load_kanban_settings");
  kbSettings = normalizeSettings((JSON.parse(raw) ?? {}) as Partial<KbSettings>);
}

async function loadIndex(): Promise<void> {
  const raw = await invoke<string>("load_kanban_index");
  const parsed = (JSON.parse(raw) ?? {}) as Partial<KanbanIndex>;

  globalTagCategories = Array.isArray(parsed.tagCategories)
    ? parsed.tagCategories.map(normalizeTagCategory).filter((c): c is TagCategory => c !== null)
    : [];
  globalTags = Array.isArray(parsed.tags)
    ? parsed.tags.map(normalizeTag).filter((t): t is Tag => t !== null)
    : [];
  // Every board starts locked and empty. loadBoardContents() is the only thing
  // that unlocks one, so a board whose file fails to load stays visibly locked
  // rather than silently appearing to have no cards.
  boards = Array.isArray(parsed.boards)
    ? parsed.boards.map(normalizeBoardMeta).filter((b): b is Board => b !== null)
    : [];
  cards = [];
}

async function refreshLockStatus(): Promise<void> {
  const status = await invoke<{ hasPassword: boolean; encryptedBoardIds: string[] }>(
    "kanban_lock_status",
  );
  encryptedBoardIds = new Set(status.encryptedBoardIds);
}

/** Reads in every board that is not encrypted. Done up front rather than on
 *  demand so the gallery can show real card counts and column shapes: a tile
 *  that had to say "open me to find out" for an unencrypted board would be
 *  worse than no tile. */
async function loadUnlockedBoards(): Promise<void> {
  for (const board of boards) {
    if (encryptedBoardIds.has(board.id)) continue;
    await loadBoardContents(board);
  }
  reconcile();
}

/** Pulls one board's columns and cards into memory. `password` is required
 *  exactly when the board is encrypted. Returns false when the contents could
 *  not be read, leaving the board locked. */
async function loadBoardContents(board: Board, password?: string): Promise<boolean> {
  const encrypted = encryptedBoardIds.has(board.id);
  let raw: string;
  try {
    raw = encrypted
      ? await invoke<string>("kanban_decrypt_board", { boardId: board.id, password })
      : await invoke<string>("load_kanban_board", { boardId: board.id });
  } catch (err) {
    devError("[kanban] board load failed", board.id, err);
    throw err;
  }

  const parsed = JSON.parse(raw) as Partial<BoardContents> | null;
  // A board file that does not exist yet is a brand-new board, not an error.
  const contents = normalizeContents(parsed ?? {});

  board.columns = contents.columns;
  board.nextCardNumber = contents.nextCardNumber;
  board.tagCategories = contents.tagCategories;
  board.tags = contents.tags;
  board.overrides = contents.overrides;
  board.locked = false;

  // Replace rather than append, so re-loading a board (after a restore, say)
  // cannot leave two copies of the same card in the array.
  cards = cards.filter((c) => c.boardId !== board.id);
  for (const card of contents.cards) card.boardId = board.id;
  cards.push(...contents.cards);
  return true;
}

/** Drops one board's contents back out of memory and marks it locked again.
 *  The counterpart to loadBoardContents, used by Lock Now and by leaving the
 *  tool: "loaded into memory only" has to have a moment where it stops. */
function unloadBoardContents(board: Board): void {
  board.columns = [];
  board.nextCardNumber = 1;
  board.tagCategories = [];
  board.tags = [];
  board.overrides = {};
  board.locked = true;
  cards = cards.filter((c) => c.boardId !== board.id);
}

/* -----------------------------------------------------------------------------
   SAVING
----------------------------------------------------------------------------- */

function markIndex(): void {
  dirtyIndex = true;
  queueSave();
}

function markSettings(): void {
  dirtySettings = true;
  queueSave();
}

/** Marks every board that is actually in memory. For the two edits that reach
 *  across boards at once: deleting a tag, or deleting a category, strips that
 *  tag from cards on every board. A LOCKED board is deliberately skipped, and
 *  that is a real limitation worth stating: its cards keep the deleted tag's id
 *  until it is next unlocked, at which point reconcile() drops the dangling
 *  reference on load. Nothing is lost, and nothing is written blind. */
function markEveryLoadedBoard(): void {
  for (const board of boards) {
    if (!board.locked) dirtyBoards.add(board.id);
  }
  queueSave();
}

/** Marks one board's CONTENTS as needing a write. Also marks the index, since
 *  every path that changes a board's contents also moves its updatedAt, and
 *  that lives in the index. */
function markBoard(boardId: string): void {
  dirtyBoards.add(boardId);
  dirtyIndex = true;
  queueSave();
}

function buildIndex(): KanbanIndex {
  return {
    boards: boards.map((b) => ({
      id: b.id,
      name: b.name,
      description: b.description,
      background: b.background,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
    })),
    tagCategories: globalTagCategories,
    tags: globalTags,
  };
}

function buildContents(board: Board): BoardContents {
  return {
    columns: board.columns,
    cards: cards.filter((c) => c.boardId === board.id),
    nextCardNumber: board.nextCardNumber,
    tagCategories: board.tagCategories,
    tags: board.tags,
    overrides: board.overrides,
  };
}

/** Writes whichever of the three kinds of file is dirty, and nothing else.
 *
 *  A locked board is skipped rather than written: its contents are not in
 *  memory, so "saving" it would write an empty board over a full one. That
 *  cannot normally happen (you cannot edit what you cannot see) but it is the
 *  single most destructive thing this file could do, so it is refused here
 *  rather than assumed impossible.
 */
async function saveNow(): Promise<void> {
  if (!storeLoaded) return;

  const boardIds = [...dirtyBoards];
  const wantIndex = dirtyIndex;
  const wantSettings = dirtySettings;
  dirtyBoards.clear();
  dirtyIndex = false;
  dirtySettings = false;

  try {
    if (wantSettings) {
      await invoke("save_kanban_settings", { data: JSON.stringify(kbSettings) });
    }
    if (wantIndex) {
      await invoke("save_kanban_index", { data: JSON.stringify(buildIndex()) });
    }
    for (const id of boardIds) {
      const board = getBoard(id);
      if (!board || board.locked) continue;
      const data = JSON.stringify(buildContents(board));
      if (encryptedBoardIds.has(id)) {
        if (!sessionPassword) {
          // Reached only if the password was cleared with an edit still queued,
          // which lockNow() flushes to prevent. Re-flagged rather than dropped,
          // so unlocking again writes it instead of losing it.
          dirtyBoards.add(id);
          continue;
        }
        await invoke("kanban_save_board_encrypted", {
          boardId: id,
          password: sessionPassword,
          data,
        });
      } else {
        await invoke("save_kanban_board", { boardId: id, data });
      }
    }
  } catch (err) {
    devError("[kanban] save failed", err);
    // Put the flags back: an edit that failed to write is still an unsaved
    // edit, and the next save should try again rather than pretend it landed.
    if (wantSettings) dirtySettings = true;
    if (wantIndex) dirtyIndex = true;
    for (const id of boardIds) dirtyBoards.add(id);
    flash(`Couldn't save Kanban data: ${String(err)}`, "error", 8000);
  }
}

/** The one call every mutation goes through. Debounced, because dragging a card
 *  fires several state changes in a row and typing a description fires one per
 *  keystroke. */
function queueSave(): void {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    void saveNow();
  }, SAVE_DEBOUNCE_MS);
}

/** Writes a queued edit NOW rather than letting it wait. Called before anything
 *  that replaces state wholesale (a snapshot restore) or that takes the
 *  password away (Lock Now, leaving the tool), so nothing is sitting in the
 *  debounce when the thing it needed goes. */
async function flushSave(): Promise<void> {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  await saveNow();
}

/* -----------------------------------------------------------------------------
   NORMALISATION
   Everything below coerces one record from disk into a complete, in-range
   object, or returns null to drop it. A record that cannot be repaired into
   something the renderer can draw is worse than a missing one: it takes the
   whole board down on the first render.
----------------------------------------------------------------------------- */

/** Coerces a stored section order into a complete, duplicate-free list.
 *
 *  A partial list is not an error and is not rejected: a stored order written
 *  before a new section existed is simply missing it, and the right answer is
 *  to append the missing one rather than to throw the user's arrangement away.
 *  Unknown names are dropped for the same reason in reverse. */
export function normalizeSectionOrder(raw: unknown): CardSection[] {
  const seen = new Set<CardSection>();
  const out: CardSection[] = [];
  if (Array.isArray(raw)) {
    for (const value of raw) {
      if (CARD_SECTIONS.includes(value as CardSection) && !seen.has(value as CardSection)) {
        seen.add(value as CardSection);
        out.push(value as CardSection);
      }
    }
  }

  /* A section the stored order has never heard of goes where the DEFAULT order
     puts it, not on the end.

     Appending was the obvious thing and it was wrong: an order saved before Due
     Date existed would get Due Date after Stage Dates, which is not where the
     default puts it and not what anyone asked for. Inserting it relative to the
     neighbours it already knows about respects both the arrangement the user
     made and the intent of the new section's default position. */
  for (const [index, section] of CARD_SECTIONS.entries()) {
    if (seen.has(section)) continue;
    // The nearest earlier section in the default order that the stored list
    // already has; the newcomer goes straight after it.
    let at = 0;
    for (let i = index - 1; i >= 0; i--) {
      const anchor = CARD_SECTIONS[i];
      const position = out.indexOf(anchor);
      if (position !== -1) {
        at = position + 1;
        break;
      }
    }
    out.splice(at, 0, section);
    seen.add(section);
  }
  return out;
}

/** The board-overridable half, coerced. Shared by the global settings and by a
 *  board's overrides, so a value means the same thing in both places. */
function normalizeScoped(raw: Partial<BoardScopedSettings>, base: BoardScopedSettings): BoardScopedSettings {
  const bool = (v: unknown, fallback: boolean): boolean =>
    typeof v === "boolean" ? v : fallback;
  return {
    confirmDelete: bool(raw.confirmDelete, base.confirmDelete),
    autoCompleteOnDone: bool(raw.autoCompleteOnDone, base.autoCompleteOnDone),
    showTags: bool(raw.showTags, base.showTags),
    showSubtasks: bool(raw.showSubtasks, base.showSubtasks),
    showDates: bool(raw.showDates, base.showDates),
    showNumbers: bool(raw.showNumbers, base.showNumbers),
    showCardDelete: bool(raw.showCardDelete, base.showCardDelete),
    showStages: bool(raw.showStages, base.showStages),
    showDue: bool(raw.showDue, base.showDue),
    cardColorMode: normalizeColorMode(raw.cardColorMode) ?? base.cardColorMode,
    cardSize: raw.cardSize === "compact" ? "compact" : raw.cardSize === "comfortable" ? "comfortable" : base.cardSize,
    sectionOrder: normalizeSectionOrder(raw.sectionOrder ?? base.sectionOrder),
  };
}

function normalizeColorMode(raw: unknown): CardColorMode | null {
  return raw === "manual" || raw === "tag" || raw === "priority" ? raw : null;
}

function normalizeTextColor(raw: unknown): CardTextColor {
  return raw === "light" || raw === "dark" ? raw : "auto";
}

function normalizePriority(raw: unknown): Priority {
  return PRIORITIES.includes(raw as Priority) ? (raw as Priority) : "none";
}

/** One color per priority level, filling in from the defaults rather than
 *  rejecting a partial map: a settings file written before a level existed is
 *  simply missing it. */
function normalizePriorityColors(raw: unknown): Record<Priority, string> {
  const src = (raw ?? {}) as Partial<Record<Priority, string>>;
  const out = {} as Record<Priority, string>;
  for (const level of PRIORITIES) {
    out[level] = normalizeColor(src[level], DEFAULT_PRIORITY_COLORS[level]);
  }
  return out;
}

export function normalizeSettings(raw: Partial<KbSettings>): KbSettings {
  const bool = (v: unknown, fallback: boolean): boolean =>
    typeof v === "boolean" ? v : fallback;
  return {
    ...normalizeScoped(raw, DEFAULT_SETTINGS),
    overdueWarn: bool(raw.overdueWarn, DEFAULT_SETTINGS.overdueWarn),
    defaultColumns:
      typeof raw.defaultColumns === "string"
        ? raw.defaultColumns.slice(0, 400)
        : DEFAULT_SETTINGS.defaultColumns,
    defaultBoardName:
      typeof raw.defaultBoardName === "string" ? raw.defaultBoardName.slice(0, 120) : "",
    priorityColors: normalizePriorityColors(raw.priorityColors),
    lockOnOpen: bool(raw.lockOnOpen, DEFAULT_SETTINGS.lockOnOpen),
  };
}

/** A board's overrides: only the keys it actually disagrees about.
 *
 *  Absent keys are absent on purpose and must stay absent. Filling them in with
 *  the current default would freeze that default into the board, so changing
 *  the default later would stop reaching the boards that never disagreed with
 *  it, which is the whole feature. */
export function normalizeOverrides(raw: unknown): Partial<BoardScopedSettings> {
  if (!raw || typeof raw !== "object") return {};
  const src = raw as Partial<BoardScopedSettings>;
  const out: Partial<BoardScopedSettings> = {};
  const bools = [
    "confirmDelete",
    "autoCompleteOnDone",
    "showTags",
    "showSubtasks",
    "showDates",
    "showNumbers",
    "showCardDelete",
    "showStages",
    "showDue",
  ] as const;
  for (const key of bools) {
    if (typeof src[key] === "boolean") out[key] = src[key];
  }
  const mode = normalizeColorMode(src.cardColorMode);
  if (mode) out.cardColorMode = mode;
  if (src.cardSize === "compact" || src.cardSize === "comfortable") {
    out.cardSize = src.cardSize;
  }
  if (Array.isArray(src.sectionOrder)) {
    out.sectionOrder = normalizeSectionOrder(src.sectionOrder);
  }
  return out;
}

function normalizeStatus(raw: unknown): KbStatus {
  return raw === "retired" ? "retired" : "active";
}

function normalizeColor(raw: unknown, fallback: string): string {
  return isHexColor(raw) ? raw.toLowerCase() : fallback;
}

/** A color that is allowed to be absent. Distinct from normalizeColor: "no
 *  color" is a real answer for a tag or a category, and must not be quietly
 *  turned into the default one. */
function normalizeOptionalColor(raw: unknown): string | null {
  return isHexColor(raw) ? raw.toLowerCase() : null;
}

function normalizeTagCategory(raw: unknown): TagCategory | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Partial<TagCategory>;
  if (typeof c.id !== "string" || !c.id) return null;
  return {
    id: c.id,
    name: trimTo(c.name, 80) || "Untitled Category",
    color: normalizeOptionalColor(c.color),
    status: normalizeStatus(c.status),
  };
}

function normalizeTag(raw: unknown): Tag | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Partial<Tag>;
  if (typeof t.id !== "string" || !t.id) return null;
  if (typeof t.categoryId !== "string" || !t.categoryId) return null;
  return {
    id: t.id,
    categoryId: t.categoryId,
    name: trimTo(t.name, 60) || "Untitled Tag",
    color: normalizeOptionalColor(t.color),
    status: normalizeStatus(t.status),
  };
}

function normalizeColumn(raw: unknown): Column | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Partial<Column>;
  if (typeof c.id !== "string" || !c.id) return null;
  const limit =
    typeof c.wipLimit === "number" && Number.isFinite(c.wipLimit) && c.wipLimit > 0
      ? clampInt(c.wipLimit, 1, 999, 1)
      : null;
  return {
    id: c.id,
    title: trimTo(c.title, 80) || "Untitled",
    wipLimit: limit,
    isDone: c.isDone === true,
    collapsed: c.collapsed === true,
  };
}

function normalizeBackground(raw: unknown): BoardBackground | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Partial<BoardBackground>;
  if (typeof b.path !== "string" || !b.path) return null;
  return {
    path: b.path,
    blur: clampInt(b.blur, 0, 24, 0),
    brightness: clampInt(b.brightness, 15, 150, 100),
  };
}

/** A board id has to survive being interpolated into a filename. The backend
 *  refuses anything else (valid_board_id in kanban.rs); this is the same rule
 *  on this side, so a bad id is dropped at load rather than turning into a
 *  failed save every time that board is touched. */
export function isSafeBoardId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= 64 &&
    /^[A-Za-z0-9_-]+$/.test(id)
  );
}

/** One entry from the index. Produces a LOCKED, contentless board: columns and
 *  nextCardNumber live in the board's own file, and loadBoardContents() is the
 *  only thing that fills them in. */
function normalizeBoardMeta(raw: unknown): Board | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Partial<BoardMeta>;
  if (!isSafeBoardId(b.id)) return null;
  const now = Date.now();
  return {
    id: b.id,
    name: trimTo(b.name, 120) || "Untitled Board",
    description: trimTo(b.description, 300),
    background: normalizeBackground(b.background),
    createdAt: typeof b.createdAt === "number" ? b.createdAt : now,
    updatedAt: typeof b.updatedAt === "number" ? b.updatedAt : now,
    columns: [],
    nextCardNumber: 1,
    tagCategories: [],
    tags: [],
    overrides: {},
    locked: true,
  };
}

/** One board's own file: its columns, cards, card counter, tag vocabulary and
 *  the settings it disagrees with. */
function normalizeContents(raw: Partial<BoardContents>): BoardContents {
  return {
    columns: Array.isArray(raw.columns)
      ? raw.columns
          .map(normalizeColumn)
          .filter((c): c is Column => c !== null)
          .slice(0, MAX_COLUMNS_PER_BOARD)
      : [],
    cards: Array.isArray(raw.cards)
      ? raw.cards.map(normalizeCard).filter((c): c is Card => c !== null)
      : [],
    nextCardNumber:
      typeof raw.nextCardNumber === "number" && raw.nextCardNumber > 0
        ? Math.floor(raw.nextCardNumber)
        : 1,
    tagCategories: Array.isArray(raw.tagCategories)
      ? raw.tagCategories.map(normalizeTagCategory).filter((c): c is TagCategory => c !== null)
      : [],
    tags: Array.isArray(raw.tags)
      ? raw.tags.map(normalizeTag).filter((t): t is Tag => t !== null)
      : [],
    overrides: normalizeOverrides(raw.overrides),
  };
}

function normalizeSubtask(raw: unknown): Subtask | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Partial<Subtask>;
  if (typeof s.id !== "string" || !s.id) return null;
  return {
    id: s.id,
    text: trimTo(s.text, 300),
    done: s.done === true,
  };
}

/** A date field is kept only if it is a real YYYY-MM-DD. Anything else becomes
 *  null rather than being carried through, because every duration in the tool
 *  is subtracted from these and a half-valid date would produce a number that
 *  looks real and is not. */
function normalizeDay(raw: unknown): string | null {
  return typeof raw === "string" && parseDay(raw) !== null ? raw : null;
}

function normalizeCard(raw: unknown): Card | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Partial<Card> & { dates?: Partial<CardDates> };
  if (typeof c.id !== "string" || !c.id) return null;
  if (typeof c.boardId !== "string" || !c.boardId) return null;
  if (typeof c.columnId !== "string" || !c.columnId) return null;
  const now = Date.now();
  const d: Partial<CardDates> = c.dates ?? {};
  return {
    id: c.id,
    boardId: c.boardId,
    columnId: c.columnId,
    number: typeof c.number === "number" && c.number > 0 ? Math.floor(c.number) : 0,
    title: trimTo(c.title, MAX_TITLE_LEN),
    description: trimTo(c.description, MAX_DESC_LEN),
    color: normalizeOptionalColor(c.color),
    colorMode: normalizeColorMode(c.colorMode),
    textColor: normalizeTextColor(c.textColor),
    priority: normalizePriority(c.priority),
    tagIds: Array.isArray(c.tagIds) ? c.tagIds.filter((t) => typeof t === "string") : [],
    subtasks: Array.isArray(c.subtasks)
      ? c.subtasks
          .map(normalizeSubtask)
          .filter((s): s is Subtask => s !== null)
          .slice(0, MAX_SUBTASKS_PER_CARD)
      : [],
    dates: {
      due: normalizeDay(d.due),
      started: normalizeDay(d.started),
      testing: normalizeDay(d.testing),
      completed: normalizeDay(d.completed),
    },
    archived: c.archived === true,
    createdAt: typeof c.createdAt === "number" ? c.createdAt : now,
    updatedAt: typeof c.updatedAt === "number" ? c.updatedAt : now,
    order: typeof c.order === "number" && Number.isFinite(c.order) ? c.order : 0,
  };
}

/** Repairs the relationships BETWEEN records after a load: drops cards whose
 *  board is gone, re-homes cards whose column is gone, drops tag references to
 *  tags that no longer exist, and hands out card numbers to anything that
 *  arrived without one.
 *
 *  Runs on every load rather than only on a suspicious one. An orphan card is
 *  invisible (nothing renders it) but still counted by every stat, which is
 *  the kind of disagreement that gets noticed months later as "the numbers are
 *  wrong" with no way to work out why. */
function reconcile(): void {
  const boardById = new Map(boards.map((b) => [b.id, b]));

  // A tag whose category vanished has nothing left to mean. Done per board and
  // once more for the defaults, since each board owns its own vocabulary.
  const globalCategoryIds = new Set(globalTagCategories.map((c) => c.id));
  globalTags = globalTags.filter((t) => globalCategoryIds.has(t.categoryId));

  const liveTagIdsByBoard = new Map<string, Set<string>>();
  for (const board of boards) {
    if (board.locked) continue;
    const categoryIds = new Set(board.tagCategories.map((c) => c.id));
    board.tags = board.tags.filter((t) => categoryIds.has(t.categoryId));
    liveTagIdsByBoard.set(board.id, new Set(board.tags.map((t) => t.id)));
  }

  cards = cards.filter((card) => {
    const board = boardById.get(card.boardId);
    if (!board) return false;
    // A locked board has no columns in memory, so every check below would read
    // as "its column is gone" and delete the card. Nothing should ever put a
    // card here for a locked board, but the cost of being wrong about that is
    // deleting somebody's work, so it is checked rather than assumed.
    if (board.locked) return true;
    if (!board.columns.some((col) => col.id === card.columnId)) {
      // Its column is gone. The first column is a place it can be seen and
      // dealt with; silently deleting someone's card because a column was
      // removed is never the right trade.
      if (board.columns.length === 0) return false;
      card.columnId = board.columns[0].id;
    }
    // Against THIS board's vocabulary. A tag id from another board is not a
    // tag this card can wear, which is what makes a cross-board move strip
    // them (see moveCardToBoard) rather than leave dangling references.
    const liveTagIds = liveTagIdsByBoard.get(board.id) ?? new Set<string>();
    card.tagIds = card.tagIds.filter((id) => liveTagIds.has(id));
    if (card.number <= 0) {
      card.number = board.nextCardNumber;
      board.nextCardNumber += 1;
    } else if (card.number >= board.nextCardNumber) {
      // A hand-edited file (or a restored snapshot from a later state) can
      // carry numbers past the counter. Pushing the counter up is what stops
      // the next new card colliding with an existing one.
      board.nextCardNumber = card.number + 1;
    }
    return true;
  });

  for (const board of boards) resequence(board.id);
}

/** Rewrites `order` as 0..n-1 within every column of one board, preserving the
 *  order the cards are already in. Called after any change to membership or
 *  position so the numbers never drift into ties or gaps. */
function resequence(boardId: string): void {
  const byColumn = new Map<string, Card[]>();
  for (const card of cards) {
    if (card.boardId !== boardId) continue;
    const list = byColumn.get(card.columnId) ?? [];
    list.push(card);
    byColumn.set(card.columnId, list);
  }
  for (const list of byColumn.values()) {
    list.sort((a, b) => a.order - b.order);
    list.forEach((card, i) => {
      card.order = i;
    });
  }
}

/* =============================================================================
   DERIVED LOOKUPS
============================================================================= */

function getBoard(id: string | null): Board | null {
  if (!id) return null;
  return boards.find((b) => b.id === id) ?? null;
}

function getCard(id: string | null): Card | null {
  if (!id) return null;
  return cards.find((c) => c.id === id) ?? null;
}

function getColumn(board: Board, columnId: string): Column | null {
  return board.columns.find((c) => c.id === columnId) ?? null;
}

/* -----------------------------------------------------------------------------
   TAG SCOPE
   -----------------------------------------------------------------------------
   Every tag lookup is answered against ONE board's vocabulary. There is no
   app-wide "the tags" any more, because there is no app-wide answer: two boards
   can both have a "Versions" category holding entirely different versions, and
   that is the point of the feature.

   `activeTagScope` is the board whose vocabulary the card modal and the filter
   bar are working in. It tracks the board view rather than being passed down
   through fifteen render functions, and it is set in exactly one place
   (setTagScope, called from showKbView) so it cannot drift.
----------------------------------------------------------------------------- */

let activeTagScope: Board | null = null;

function setTagScope(board: Board | null): void {
  activeTagScope = board;
}

/** The vocabulary in play right now: the board being viewed, or nothing. */
function scopeTags(): Tag[] {
  return activeTagScope?.tags ?? [];
}

function scopeTagCategories(): TagCategory[] {
  return activeTagScope?.tagCategories ?? [];
}

function getTag(id: string): Tag | null {
  return scopeTags().find((t) => t.id === id) ?? null;
}

/* -----------------------------------------------------------------------------
   RESOLVED COLORS
   -----------------------------------------------------------------------------
   Three things can be colored and none of them stores the answer: a tag may
   inherit its category's, a card may take a tag's or its priority's. Resolving
   on every render rather than writing the result down is what stops a
   recolored category leaving stale copies of its old color behind on tags and
   cards that were supposed to be following it.
----------------------------------------------------------------------------- */

/** A tag's color: its own, or its category's, or none at all. "None" is a real
 *  answer and renders as a plain outlined chip; it is not a reason to invent
 *  a color. */
export function tagColor(tag: Tag, categories: TagCategory[]): string | null {
  if (tag.color) return tag.color;
  return categories.find((c) => c.id === tag.categoryId)?.color ?? null;
}

/** One card's tags, in RANK ORDER: categories in the order the board lists
 *  them, then tags in the order that category lists them. The order matters
 *  twice over, since it decides both how the chips read on the card and which
 *  tag a tag-colored card takes its color from. */
export function orderedCardTags(card: Card, board: Board): Tag[] {
  const out: Tag[] = [];
  for (const category of board.tagCategories) {
    for (const tag of board.tags) {
      if (tag.categoryId !== category.id) continue;
      if (card.tagIds.includes(tag.id)) out.push(tag);
    }
  }
  // A tag whose category has gone missing would otherwise vanish from the card
  // silently. reconcile() normally prevents that; this is the belt to its
  // braces, and it keeps the chip visible where it can be noticed and removed.
  for (const id of card.tagIds) {
    if (out.some((t) => t.id === id)) continue;
    const orphan = board.tags.find((t) => t.id === id);
    if (orphan) out.push(orphan);
  }
  return out;
}

/** Which color mode is in force for a card: its own choice, or its board's. */
export function cardColorMode(card: Card, board: Board | null): CardColorMode {
  return card.colorMode ?? effective(board).cardColorMode;
}

/** The color to paint a card, or null for the theme's own card surface.
 *
 *  Returning null rather than a fallback color is deliberate for the derived
 *  modes: a card colored "by priority" with no priority set, or "by tag" with
 *  no colored tag, has nothing to say, and a grey card would be saying
 *  something. It just looks like every other uncolored card until it has a
 *  reason not to. */
export function resolveCardColor(card: Card, board: Board | null): string | null {
  const mode = cardColorMode(card, board);
  if (mode === "manual") return card.color;
  if (mode === "priority") {
    return card.priority === "none" ? null : kbSettings.priorityColors[card.priority];
  }
  if (!board) return null;
  for (const tag of orderedCardTags(card, board)) {
    const color = tagColor(tag, board.tagCategories);
    if (color) return color;
  }
  return null;
}

function getTagCategory(id: string): TagCategory | null {
  return scopeTagCategories().find((c) => c.id === id) ?? null;
}

/* -----------------------------------------------------------------------------
   SETTING SCOPE
   -----------------------------------------------------------------------------
   Every board-overridable setting is read through here and never off kbSettings
   directly, so "the default, unless this board says otherwise" is one rule in
   one place rather than a conditional at each of forty call sites.
----------------------------------------------------------------------------- */

/** The settings in force for one board: the defaults, with that board's
 *  overrides laid over them. Passing null (the gallery, where no board is in
 *  play) gives the plain defaults. */
function effective(board: Board | null): BoardScopedSettings {
  const base: BoardScopedSettings = {
    confirmDelete: kbSettings.confirmDelete,
    autoCompleteOnDone: kbSettings.autoCompleteOnDone,
    showTags: kbSettings.showTags,
    showSubtasks: kbSettings.showSubtasks,
    showDates: kbSettings.showDates,
    showNumbers: kbSettings.showNumbers,
    showCardDelete: kbSettings.showCardDelete,
    showStages: kbSettings.showStages,
    showDue: kbSettings.showDue,
    cardColorMode: kbSettings.cardColorMode,
    cardSize: kbSettings.cardSize,
    sectionOrder: kbSettings.sectionOrder,
  };
  if (!board) return base;
  return { ...base, ...board.overrides };
}

/** The settings in force for the board a given card is on. */
function effectiveForCard(card: Card): BoardScopedSettings {
  return effective(getBoard(card.boardId));
}

/** Live (non-archived) cards in one column, in board order. */
function cardsInColumn(boardId: string, columnId: string): Card[] {
  return cards
    .filter((c) => c.boardId === boardId && c.columnId === columnId && !c.archived)
    .sort((a, b) => a.order - b.order);
}

function liveCardsOnBoard(boardId: string): Card[] {
  return cards.filter((c) => c.boardId === boardId && !c.archived);
}

function archivedCardsOnBoard(boardId: string): Card[] {
  return cards
    .filter((c) => c.boardId === boardId && c.archived)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** True when the card has a due date that has already passed and it is not
 *  finished. A completed card past its due date is late, not overdue: there is
 *  nothing left to do about it, so it should not keep shouting. */
export function isOverdue(card: Card, todayStr: string = today()): boolean {
  if (card.archived) return false;
  if (!card.dates.due) return false;
  // A board that has switched due dates off has nothing to be late for, and
  // nagging about a date it will not show you is worse than not nagging.
  if (!effectiveForCard(card).showDue) return false;
  if (card.dates.completed) return false;
  const diff = dayDiff(todayStr, card.dates.due);
  return diff !== null && diff < 0;
}

/** Index of the furthest stage this card has reached, or -1 for none. */
export function furthestStage(card: Card): number {
  let idx = -1;
  STAGES.forEach((stage, i) => {
    if (card.dates[stage]) idx = i;
  });
  return idx;
}

/* =============================================================================
   FILTERING
   -----------------------------------------------------------------------------
   Faceted, not a flat OR: selecting v0.2.0 and v0.3.0 under Versions means
   "either version", but also selecting UI under Areas means "either version
   AND in the UI". That is what people expect from a set of tag filters and it
   is the only reading where adding a filter can never widen the result.
============================================================================= */

function anyFilterActive(): boolean {
  return filterText.trim() !== "" || filterTagIds.size > 0 || filterDue !== "any";
}

export function cardMatchesText(card: Card, needle: string): boolean {
  const q = needle.trim().toLowerCase();
  if (!q) return true;
  // "#42" and a bare "42" both find card 42. The number is the handle people
  // actually use out loud, so it has to be searchable as one.
  const numeric = q.replace(/^#/, "");
  if (numeric && /^\d+$/.test(numeric) && String(card.number) === numeric) return true;
  if (card.title.toLowerCase().includes(q)) return true;
  if (card.description.toLowerCase().includes(q)) return true;
  return card.subtasks.some((s) => s.text.toLowerCase().includes(q));
}

function cardMatchesTags(card: Card): boolean {
  if (filterTagIds.size === 0) return true;
  const wantedByCategory = new Map<string, Set<string>>();
  for (const tagId of filterTagIds) {
    const tag = getTag(tagId);
    if (!tag) continue;
    const set = wantedByCategory.get(tag.categoryId) ?? new Set<string>();
    set.add(tagId);
    wantedByCategory.set(tag.categoryId, set);
  }
  for (const wanted of wantedByCategory.values()) {
    if (!card.tagIds.some((id) => wanted.has(id))) return false;
  }
  return true;
}

function cardMatchesDue(card: Card, todayStr: string): boolean {
  switch (filterDue) {
    case "any":
      return true;
    case "none":
      return !card.dates.due;
    case "overdue":
      return isOverdue(card, todayStr);
    case "soon": {
      if (!card.dates.due || card.dates.completed) return false;
      const diff = dayDiff(todayStr, card.dates.due);
      return diff !== null && diff <= 7;
    }
  }
}

function cardMatchesFilters(card: Card, todayStr: string): boolean {
  return (
    cardMatchesText(card, filterText) &&
    cardMatchesTags(card) &&
    cardMatchesDue(card, todayStr)
  );
}

function clearFilters(): void {
  filterText = "";
  filterTagIds.clear();
  filterDue = "any";
  filterBarOpen = false;
  if (cardSearchInput) cardSearchInput.value = "";
}

/* =============================================================================
   VIEWS + THIS TOOL'S OWN BACK/FORWARD STACK
   -----------------------------------------------------------------------------
   Two views, and a small history stack local to them, claimed through
   shell.ts's setSubNavHandler() (the same arrangement Game Stats uses). The
   handler checks whether this tool is actually on screen before claiming a
   press, so the shell can hold several tools' handlers at once and at most one
   ever answers.

   The card modal is folded into the same gesture on purpose. Mouse-back with a
   card open should close the card, because that is what "back" means from
   inside something you opened; letting it fall through would jump the whole
   tool out from behind an open modal.
============================================================================= */

type KbView = "boards" | "board";

interface KbHistoryEntry {
  view: KbView;
  boardId?: string;
}

let currentView: KbView = "boards";
let kbHistory: KbHistoryEntry[] = [{ view: "boards" }];
let kbHistoryIndex = 0;
let kbNavigatingHistory = false;

/** Switches view and records it. `boardId` is required for "board" and is what
 *  makes stepping back through several boards return to each in turn rather
 *  than dumping you at the gallery. */
function showKbView(view: KbView, boardId?: string): void {
  if (view === "board") {
    const board = getBoard(boardId ?? null);
    // A history entry whose board was since deleted degrades to the gallery
    // rather than dead-ending the back button on a blank screen.
    if (!board) {
      showKbView("boards");
      return;
    }
    currentBoardId = board.id;
    // Tags are per board, so "which vocabulary is in play" has to move with the
    // view. One place sets it, so it cannot drift out of step with the board on
    // screen.
    setTagScope(board);
  } else {
    // Leaving a board is a real departure, so its filters go with it. Opening
    // a card from the board is not: that path never comes through here.
    if (currentView === "board") clearFilters();
    currentBoardId = null;
    setTagScope(null);
  }

  currentView = view;
  applyViewVisibility();

  renderAll();
  pushKbHistory(view, currentBoardId ?? undefined);
}

/**
 * The ONE place that decides which of the three top-level panes is on screen.
 *
 * There were two before (view switching and the lock gate) and they disagreed:
 * clicking the sidebar icon while the gate was up called showKbView, which
 * unhid the gallery from behind the gate. Anything that can reveal a locked
 * board has to be impossible by construction rather than by remembering, so
 * both callers now go through here and the gate always wins.
 */
function applyViewVisibility(): void {
  const gated = authGateShowing;
  authView.style.display = gated ? "" : "none";
  viewBoards.style.display = !gated && currentView === "boards" ? "" : "none";
  viewBoard.style.display = !gated && currentView === "board" ? "" : "none";
  boardSetupBtn.style.display = !gated && currentView === "board" ? "" : "none";
}

function pushKbHistory(view: KbView, boardId?: string): void {
  if (kbNavigatingHistory) return;
  const current = kbHistory[kbHistoryIndex];
  if (current && current.view === view && current.boardId === boardId) return;
  kbHistory = kbHistory.slice(0, kbHistoryIndex + 1);
  kbHistory.push({ view, boardId });
  kbHistoryIndex = kbHistory.length - 1;
}

function applyKbHistoryEntry(entry: KbHistoryEntry): void {
  kbNavigatingHistory = true;
  showKbView(entry.view, entry.boardId);
  kbNavigatingHistory = false;
}

/** Whether the tool is actually rendered right now. Checking this element's
 *  own style.display is not enough: leaving for another tool hides it by
 *  dropping the .active class from its ancestor #section-productivity, which never
 *  touches this element's inline style. offsetParent is null for anything
 *  hidden by itself OR by an ancestor. */
function kbToolIsVisible(): boolean {
  const view = document.getElementById("productivity-tool-kanban");
  return !!view && view.offsetParent !== null;
}

/** The top-most open modal belonging to this tool, checked child-first so a
 *  stats sheet opened over the card closes before the card does. Returns null
 *  when none of them are open. */
function topOpenKanbanModal(): Modal | null {
  const stack = [
    _confirmModal,
    _passwordModal,
    _cardStatsModal,
    _boardStatsModal,
    _archiveModal,
    _tagEditModal,
    _tagCatEditModal,
    _columnEditModal,
    _cardColorModal,
    _boardSetupModal,
    _newBoardModal,
    _cardModal,
    _setupModal,
  ];
  return stack.find((m) => m?.isOpen) ?? null;
}

function kbSubNavBack(): boolean {
  if (!kbToolIsVisible()) return false;
  const modal = topOpenKanbanModal();
  if (modal) {
    // Closing a confirm reopens whatever it replaced, via its onClosed hook, so
    // backing out of one lands where it was launched from rather than on the
    // board behind it.
    modal.close();
    return true;
  }
  if (kbHistoryIndex <= 0) return false;
  kbHistoryIndex--;
  applyKbHistoryEntry(kbHistory[kbHistoryIndex]);
  return true;
}

function kbSubNavForward(): boolean {
  if (!kbToolIsVisible()) return false;
  // Forward through a modal would have to guess which one to reopen, and
  // reopening a delete confirm nobody asked for is the worst possible guess.
  if (topOpenKanbanModal()) return true;
  if (kbHistoryIndex >= kbHistory.length - 1) return false;
  kbHistoryIndex++;
  applyKbHistoryEntry(kbHistory[kbHistoryIndex]);
  return true;
}

/* =============================================================================
   TOP-LEVEL RENDER
============================================================================= */

function renderAll(): void {
  if (currentView === "boards") renderGallery();
  else renderBoardView();
  refreshOverdueAttention();
}

/** Flags the tool while anything is past its due date, through the same
 *  sidebar pulse + header notice Auto-Backup and Budget use, so "something
 *  needs you" reads the same wherever it comes from. */
function refreshOverdueAttention(): void {
  const todayStr = today();
  const overdue = kbSettings.overdueWarn
    ? cards.filter((c) => isOverdue(c, todayStr)).length
    : 0;

  setToolAttention("productivity", "kanban", overdue > 0);

  if (overdue > 0) {
    headerNoticeWrap.style.display = "";
    headerNotice.textContent =
      overdue === 1 ? "1 card is past its due date" : `${overdue} cards are past their due date`;
  } else {
    headerNoticeWrap.style.display = "none";
    headerNotice.textContent = "";
  }
}

/* =============================================================================
   BOARD GALLERY
============================================================================= */

function renderGallery(): void {
  const needle = boardSearchInput.value.trim().toLowerCase();
  const visible = boards.filter(
    (b) =>
      !needle ||
      b.name.toLowerCase().includes(needle) ||
      b.description.toLowerCase().includes(needle),
  );

  boardGrid.replaceChildren();
  for (const board of visible) boardGrid.appendChild(buildBoardTile(board));

  const totalCards = cards.filter((c) => !c.archived).length;
  gallerySummary.textContent =
    boards.length === 0
      ? ""
      : `${boards.length} ${boards.length === 1 ? "board" : "boards"} · ${totalCards} ${
          totalCards === 1 ? "card" : "cards"
        }`;

  if (boards.length === 0) {
    boardsEmpty.style.display = "";
    boardsEmpty.textContent =
      "No boards yet. Make one and give it a background so you can tell it apart at a glance.";
  } else if (visible.length === 0) {
    boardsEmpty.style.display = "";
    boardsEmpty.textContent = "No board matches that search.";
  } else {
    boardsEmpty.style.display = "none";
  }
}

/** One gallery tile. A div rather than a button because it contains a real
 *  button (Edit), and a button inside a button is invalid markup that browsers
 *  resolve by silently dropping the inner one. Keyboard access is restored
 *  explicitly: tabindex, a role, and Enter/Space. */
function buildBoardTile(board: Board): HTMLElement {
  const tile = document.createElement("div");
  tile.className = "kb-board-tile";
  tile.dataset.boardId = board.id;
  tile.tabIndex = 0;
  tile.setAttribute("role", "button");
  tile.title = board.description || board.name;

  const bg = document.createElement("span");
  bg.className = "kb-board-tile-bg";
  if (board.background) {
    bg.style.backgroundImage = `url("${convertFileSrc(board.background.path)}")`;
    bg.style.filter = `blur(${board.background.blur}px) brightness(${board.background.brightness}%)`;
    // A blurred layer fades out at its own edges, so it is grown past the tile
    // and the tile clips it. Scaled by the blur radius rather than a fixed
    // amount, because a 24px blur bleeds four times as far as a 6px one.
    bg.style.transform = `scale(${1 + board.background.blur / 90})`;
  } else {
    bg.classList.add("kb-board-tile-bg-empty");
  }
  tile.appendChild(bg);

  const body = document.createElement("span");
  body.className = "kb-board-tile-body";

  const name = document.createElement("span");
  name.className = "kb-board-tile-name";
  name.textContent = board.name;
  body.appendChild(name);

  if (board.description) {
    const desc = document.createElement("span");
    desc.className = "kb-board-tile-desc";
    desc.textContent = board.description;
    body.appendChild(desc);
  }

  // The mini column bars are the tile's real content: a board's shape (a lot
  // in Backlog, nothing in Testing) is recognisable at a glance in a way a
  // total never is.
  const bars = document.createElement("span");
  bars.className = "kb-board-tile-bars";
  const live = liveCardsOnBoard(board.id);
  const peak = Math.max(
    1,
    ...board.columns.map((col) => live.filter((c) => c.columnId === col.id).length),
  );
  for (const col of board.columns.slice(0, 8)) {
    const count = live.filter((c) => c.columnId === col.id).length;
    const bar = document.createElement("span");
    bar.className = "kb-board-tile-bar";
    if (col.isDone) bar.classList.add("kb-board-tile-bar-done");
    bar.style.setProperty("--kb-bar", `${Math.round((count / peak) * 100)}%`);
    bar.title = `${col.title}: ${count}`;
    bars.appendChild(bar);
  }
  body.appendChild(bars);

  const stats = document.createElement("span");
  stats.className = "kb-board-tile-stats";
  if (board.locked) {
    // No counts, and not because they are being withheld for effect: the cards
    // are ciphertext, so there is genuinely nothing here to count.
    tile.classList.add("kb-board-tile-locked");
    stats.textContent = "Encrypted · click to unlock";
  } else {
    const todayStr = today();
    const overdue = live.filter((c) => isOverdue(c, todayStr)).length;
    const done = live.filter((c) => {
      const col = getColumn(board, c.columnId);
      return col?.isDone === true;
    }).length;
    const bits = [`${live.length} ${live.length === 1 ? "card" : "cards"}`, `${done} done`];
    if (overdue > 0) bits.push(`${overdue} overdue`);
    stats.textContent = bits.join(" · ");
    if (overdue > 0) stats.classList.add("kb-stat-alert");
  }
  body.appendChild(stats);

  if (board.locked) {
    const padlock = document.createElement("span");
    padlock.className = "kb-board-tile-lock";
    padlock.title = "Encrypted";
    padlock.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="4" y="10.5" width="16" height="10.5" rx="2" />' +
      '<path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" /></svg>';
    tile.appendChild(padlock);
  }

  tile.appendChild(body);

  const edit = document.createElement("button");
  edit.className = "kb-tile-edit-btn";
  edit.type = "button";
  edit.title = "Board settings";
  edit.textContent = "Edit";
  edit.addEventListener("click", (e) => {
    e.stopPropagation();
    openBoardSetup(board);
  });
  tile.appendChild(edit);

  const enter = (): void => void openBoardFromGallery(board.id);
  tile.addEventListener("click", enter);
  tile.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      enter();
    }
  });

  /* No Delete Board here, deliberately.
     Every destructive confirm in this tool has to name where dismissing it
     puts you back (see kbConfirm, and the check that enforces it in
     scripts/checks/kanban.test.mjs). A confirm launched from a gallery tile
     has no such place: it replaced no modal, because none was open. Rather
     than invent a journey back, Delete stays where it already lives, one row
     down from here in Board Settings, which the confirm can return to. */
  attachMenu(tile, () => {
    const archived = archivedCardsOnBoard(board.id).length;
    return [
      { label: "Open Board", onClick: enter },
      { label: "Board Settings…", onClick: () => openBoardSetup(board) },
      { label: "Board Stats…", onClick: () => openBoardStats(board) },
      {
        label: `Archived Cards (${archived})`,
        disabled: archived === 0,
        onClick: () => openArchive(board),
      },
      {
        label: "Copy Columns to a New Board",
        onClick: () => duplicateBoardAsTemplate(board),
      },
    ];
  });

  return tile;
}

/* =============================================================================
   BOARD VIEW
============================================================================= */

/** Entering a board from the gallery. Split out from showKbView because
 *  unlocking is asynchronous and showKbView is called from places (history
 *  replay, the icon shortcut) that cannot wait on a password prompt. */
async function openBoardFromGallery(boardId: string): Promise<void> {
  const board = getBoard(boardId);
  if (!board) return;
  if (board.locked && !(await unlockBoard(board))) return;
  showKbView("board", board.id);
}

function renderBoardView(): void {
  const board = getBoard(currentBoardId);
  if (!board) {
    showKbView("boards");
    return;
  }

  boardTitleEl.textContent = board.name;
  applyBoardBackground(board);
  renderBoardCounts(board);
  renderFilterBar(board);
  renderColumns(board);
}

function applyBoardBackground(board: Board): void {
  const bg = board.background;
  if (!bg) {
    boardBgLayer.style.display = "none";
    boardBgLayer.style.removeProperty("background-image");
    viewBoard.classList.remove("kb-has-bg");
    return;
  }
  boardBgLayer.style.display = "";
  boardBgLayer.style.backgroundImage = `url("${convertFileSrc(bg.path)}")`;
  boardBgLayer.style.filter = `blur(${bg.blur}px) brightness(${bg.brightness}%)`;
  // Same edge-bleed correction as the gallery tile; see the note there.
  boardBgLayer.style.transform = `scale(${1 + bg.blur / 90})`;
  viewBoard.classList.add("kb-has-bg");
}

function renderBoardCounts(board: Board): void {
  const todayStr = today();
  const live = liveCardsOnBoard(board.id);
  const shown = live.filter((c) => cardMatchesFilters(c, todayStr)).length;
  const archived = archivedCardsOnBoard(board.id).length;

  const bits: string[] = [];
  bits.push(
    anyFilterActive()
      ? `${shown} of ${live.length} cards`
      : `${live.length} ${live.length === 1 ? "card" : "cards"}`,
  );
  if (archived > 0) bits.push(`${archived} archived`);
  boardCountsEl.textContent = bits.join(" · ");

  filterBtn.classList.toggle("active", anyFilterActive());
}

function renderColumns(board: Board): void {
  const todayStr = today();
  columnsEl.replaceChildren();

  if (board.locked) {
    // Reachable through history replay (mouse-back into a board that was
    // locked in the meantime), so it says what happened rather than looking
    // like a board that lost its columns.
    columnsEmpty.style.display = "";
    columnsEmpty.textContent = "This board is encrypted and locked. Go back and open it again to unlock it.";
    return;
  }
  if (board.columns.length === 0) {
    columnsEmpty.style.display = "";
    columnsEmpty.textContent = "This board has no columns yet. Add one to start.";
    return;
  }
  columnsEmpty.style.display = "none";

  for (const column of board.columns) {
    columnsEl.appendChild(buildColumn(board, column, todayStr));
  }
}

function buildColumn(board: Board, column: Column, todayStr: string): HTMLElement {
  const el = document.createElement("section");
  el.className = "kb-column";
  el.dataset.columnId = column.id;
  if (column.collapsed) el.classList.add("kb-column-collapsed");
  if (column.isDone) el.classList.add("kb-column-done");

  const all = cardsInColumn(board.id, column.id);
  const visible = all.filter((c) => cardMatchesFilters(c, todayStr));
  // The WIP number counts every card in the column, not the filtered subset:
  // a limit that moved when you typed in a search box would be worthless.
  const over = column.wipLimit !== null && all.length > column.wipLimit;
  const atLimit = column.wipLimit !== null && all.length === column.wipLimit;
  if (over) el.classList.add("kb-column-over-wip");

  /* ── Header ── */
  const head = document.createElement("header");
  head.className = "kb-column-head";

  const grip = document.createElement("span");
  grip.className = "kb-column-grip";
  grip.title = "Drag to reorder this column";
  grip.textContent = "⠿";
  head.appendChild(grip);

  const title = document.createElement("span");
  title.className = "kb-column-title";
  title.textContent = column.title;
  head.appendChild(title);

  /* An add button where the count is, so "there are three here and I want a
     fourth" is one movement rather than a trip to the bottom of the column. It
     opens the same quick-add form the footer button does, so there is one way
     a card gets made and two places to start it. */
  const quickAdd = document.createElement("button");
  quickAdd.type = "button";
  quickAdd.className = "kb-icon-btn kb-column-add-inline";
  quickAdd.textContent = "+";
  quickAdd.title = `Add a card to the top of ${column.title}`;
  quickAdd.addEventListener("click", () => {
    const footer = el.querySelector<HTMLElement>(".kb-column-footer");
    const addBtn = footer?.querySelector<HTMLButtonElement>(".kb-column-add");
    if (!footer || !addBtn) return;
    // A collapsed column has no form to open into, so it opens first.
    if (column.collapsed) {
      column.collapsed = false;
      touchBoard(board);
      renderBoardView();
      const reopened = columnsEl.querySelector<HTMLElement>(
        `.kb-column[data-column-id="${CSS.escape(column.id)}"] .kb-column-footer`,
      );
      const reopenedBtn = reopened?.querySelector<HTMLButtonElement>(".kb-column-add");
      if (reopened && reopenedBtn) openQuickAdd(board, column, reopened, reopenedBtn, "top");
      return;
    }
    if (addBtn.style.display !== "none") openQuickAdd(board, column, footer, addBtn, "top");
  });
  head.appendChild(quickAdd);

  const count = document.createElement("span");
  count.className = "kb-column-count";
  if (over) count.classList.add("kb-stat-alert");
  else if (atLimit) count.classList.add("kb-stat-warn");
  count.textContent =
    column.wipLimit === null ? String(all.length) : `${all.length} / ${column.wipLimit}`;
  count.title =
    column.wipLimit === null
      ? `${all.length} cards`
      : over
        ? `Over the limit of ${column.wipLimit}. Finish something here before starting more.`
        : `${all.length} of a limit of ${column.wipLimit}`;
  head.appendChild(count);

  const collapseBtn = document.createElement("button");
  collapseBtn.className = "kb-icon-btn kb-column-btn";
  collapseBtn.type = "button";
  collapseBtn.title = column.collapsed ? "Expand column" : "Collapse column";
  collapseBtn.textContent = column.collapsed ? "▸" : "▾";
  collapseBtn.addEventListener("click", () => {
    column.collapsed = !column.collapsed;
    touchBoard(board);
    renderBoardView();
  });
  head.appendChild(collapseBtn);

  const editBtn = document.createElement("button");
  editBtn.className = "kb-icon-btn kb-column-btn";
  editBtn.type = "button";
  editBtn.title = "Column settings";
  editBtn.textContent = "⚙";
  editBtn.addEventListener("click", () => openColumnEditor(board, column));
  head.appendChild(editBtn);

  // On the header, not the whole column: the cards inside have their own menu,
  // and a right-click on empty space below them should still reach this one,
  // which is what the footer's menu further down is for.
  attachMenu(head, () => {
    const footer = el.querySelector<HTMLElement>(".kb-column-footer");
    const addBtn = footer?.querySelector<HTMLButtonElement>(".kb-column-add");
    const canAdd = Boolean(footer && addBtn && !column.collapsed);
    return [
      {
        label: "Add Card at Top",
        disabled: !canAdd,
        onClick: () => openQuickAdd(board, column, footer!, addBtn!, "top"),
      },
      {
        label: "Add Card at Bottom",
        disabled: !canAdd,
        onClick: () => openQuickAdd(board, column, footer!, addBtn!, "bottom"),
      },
      {
        label: column.collapsed ? "Expand Column" : "Collapse Column",
        onClick: () => {
          column.collapsed = !column.collapsed;
          touchBoard(board);
          renderBoardView();
        },
      },
      { label: "Column Settings…", onClick: () => openColumnEditor(board, column) },
      {
        label: "Archive All Cards Here",
        disabled: all.length === 0,
        onClick: () => {
          for (const c of all) c.archived = true;
          touchBoard(board);
          flash(all.length === 1 ? "1 card archived." : `${all.length} cards archived.`);
          renderAll();
        },
      },
    ];
  });

  el.appendChild(head);

  /* ── Cards ── */
  const body = document.createElement("div");
  body.className = "kb-column-body";
  body.dataset.columnId = column.id;
  for (const card of visible) body.appendChild(buildCardEl(board, card, todayStr));

  if (visible.length === 0) {
    const empty = document.createElement("p");
    empty.className = "kb-column-empty";
    empty.textContent = all.length === 0 ? "Nothing here yet." : "Nothing matches the filter.";
    body.appendChild(empty);
  }
  attachCardDropTarget(body);
  el.appendChild(body);

  /* ── Quick add ──
     A form that stays open after each Enter, because capturing five things you
     just thought of is one action, not five. */
  const footer = document.createElement("div");
  footer.className = "kb-column-footer";

  const addBtn = document.createElement("button");
  addBtn.className = "kb-column-add";
  addBtn.type = "button";
  addBtn.textContent = "+ Add card";
  addBtn.title = `Add a card to the bottom of ${column.title}`;
  // The foot of the column adds to the foot of the column.
  addBtn.addEventListener("click", () => openQuickAdd(board, column, footer, addBtn, "bottom"));
  footer.appendChild(addBtn);

  // The empty space under the last card is the natural "put something here"
  // target, so it gets the two add actions and nothing else.
  attachMenu(footer, () => [
    {
      label: "Add Card at Top",
      onClick: () => openQuickAdd(board, column, footer, addBtn, "top"),
    },
    {
      label: "Add Card at Bottom",
      onClick: () => openQuickAdd(board, column, footer, addBtn, "bottom"),
    },
  ]);
  el.appendChild(footer);

  attachColumnDragHandlers(board, el, grip, column);
  return el;
}

/** The inline capture form. `position` comes from WHICH control opened it: the
 *  + in the header means the top, the button at the foot means the bottom. */
function openQuickAdd(
  board: Board,
  column: Column,
  footer: HTMLElement,
  addBtn: HTMLButtonElement,
  position: NewCardPosition,
): void {
  addBtn.style.display = "none";

  const form = document.createElement("div");
  form.className = "kb-quick-add";

  const input = document.createElement("textarea");
  input.className = "kb-quick-add-input";
  input.rows = 2;
  input.placeholder = "Card title, then Enter";
  input.spellcheck = true;
  form.appendChild(input);

  const row = document.createElement("div");
  row.className = "kb-quick-add-row";

  const save = document.createElement("button");
  save.type = "button";
  save.textContent = "Add";
  row.appendChild(save);

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "modal-cancel-btn";
  cancel.textContent = "Done";
  row.appendChild(cancel);

  form.appendChild(row);
  footer.appendChild(form);
  input.focus();

  function commit(): void {
    const title = input.value.trim();
    if (!title) return;
    const created = createCard(board, column.id, title, position);
    if (!created) return;
    // Re-render so the new card appears, then reopen the form in the same
    // column so a run of captures is uninterrupted.
    renderBoardView();
    const nextColumn = columnsEl.querySelector<HTMLElement>(
      `.kb-column[data-column-id="${CSS.escape(column.id)}"] .kb-column-footer`,
    );
    const nextBtn = nextColumn?.querySelector<HTMLButtonElement>(".kb-column-add");
    if (nextColumn && nextBtn) openQuickAdd(board, column, nextColumn, nextBtn, position);
  }

  function close(): void {
    form.remove();
    addBtn.style.display = "";
  }

  save.addEventListener("click", commit);
  cancel.addEventListener("click", close);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });
}

/* =============================================================================
   THE CARD FACE
============================================================================= */

/** What the card's stage chip says, or null when it has not started. */
export function stageChipLabel(card: Card): string | null {
  switch (furthestStage(card)) {
    case 0:
      return "In Progress";
    case 1:
      return "In Testing";
    case 2:
      return "Done";
    default:
      return null;
  }
}

function buildCardEl(board: Board, card: Card, todayStr: string): HTMLElement {
  // This board's settings, not the app's: a board may show tags where the
  // default hides them, and vice versa.
  const settings = effective(board);

  const el = document.createElement("article");
  el.className = "kb-card";
  el.dataset.cardId = card.id;
  el.draggable = true;
  if (settings.cardSize === "compact") el.classList.add("kb-card-compact");

  const overdue = isOverdue(card, todayStr);
  if (overdue) el.classList.add("kb-card-overdue");
  // Resolved, never stored: a card colored by tag or by priority follows those
  // the moment they change, with no copy of the old color left behind.
  applySolidColor(el, resolveCardColor(card, board), card.textColor);

  /* Top strip: the card number and its due state, the two things you scan a
     column for. Rendered even when both are empty so titles line up. */
  const top = document.createElement("div");
  top.className = "kb-card-top";

  if (settings.showNumbers) {
    const num = document.createElement("span");
    num.className = "kb-card-number";
    num.textContent = `#${card.number}`;
    top.appendChild(num);
  }

  if (card.priority !== "none") {
    const chip = document.createElement("span");
    chip.className = "kb-card-priority";
    chip.textContent = PRIORITY_LABELS[card.priority];
    chip.title = `Priority: ${PRIORITY_LABELS[card.priority]}`;
    // Painted its own level color even when the card is not colored by
    // priority: the chip is the readout, and it has to mean the same thing
    // whatever the card around it is doing.
    const color = kbSettings.priorityColors[card.priority];
    chip.style.background = color;
    chip.style.color = readableTextOn(color);
    top.appendChild(chip);
  }

  if (settings.showDates && settings.showDue) {
    const chip = buildDueChip(card, todayStr);
    if (chip) top.appendChild(chip);
    // The stage chip only says anything on a board that keeps stage dates.
    const stage = settings.showStages ? stageChipLabel(card) : null;
    if (stage) {
      const stageEl = document.createElement("span");
      stageEl.className = "kb-card-stage-chip";
      if (furthestStage(card) === 2) stageEl.classList.add("kb-card-stage-done");
      stageEl.textContent = stage;
      top.appendChild(stageEl);
    }
  }
  if (settings.showCardDelete) {
    // A bin on the card face, off by default. It sits on a surface whose main
    // gesture is dragging, so it is only ever offered deliberately, it stays
    // out of the way until the card is hovered, and it still goes through the
    // same confirmation the menu does.
    const bin = document.createElement("button");
    bin.type = "button";
    bin.className = "kb-card-delete";
    bin.title = `Delete card #${card.number}`;
    // Solid, not outlined. At 13px an outlined bin is four hairlines and reads
    // as a smudge; the filled body is the only thing that makes it legible as a
    // bin at this size. The two slots are cut out of the fill rather than drawn
    // on top, so they stay visible on any card color.
    bin.innerHTML =
      '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none">' +
      '<path d="M9 4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1h5a1 1 0 1 1 0 2H4a1 1 0 0 1 0-2h5V4zm2 1h2V5h-2v0z" />' +
      '<path fill-rule="evenodd" d="M6.2 8h11.6l-.93 12.07A2 2 0 0 1 14.88 22H9.12a2 2 0 0 1-1.99-1.93L6.2 8zm3.3 3a.9.9 0 0 0-.9.9v6.2a.9.9 0 0 0 1.8 0v-6.2a.9.9 0 0 0-.9-.9zm5 0a.9.9 0 0 0-.9.9v6.2a.9.9 0 0 0 1.8 0v-6.2a.9.9 0 0 0-.9-.9z" />' +
      "</svg>";
    bin.addEventListener("click", (e) => {
      // Without this the card underneath also opens, so you get a confirm on
      // top of the card you were trying not to have to open.
      e.stopPropagation();
      requestDeleteCard(card);
    });
    top.appendChild(bin);
  }

  if (top.childElementCount > 0) el.appendChild(top);

  const title = document.createElement("div");
  title.className = "kb-card-title";
  title.textContent = card.title || "Untitled";
  el.appendChild(title);

  if (settings.showTags && card.tagIds.length > 0) {
    const tagRow = document.createElement("div");
    tagRow.className = "kb-card-tags";
    // Rank order, not the order they were ticked in: the same two tags read the
    // same way on every card, and the leftmost is the one a tag-colored card
    // takes its color from.
    for (const tag of orderedCardTags(card, board)) {
      tagRow.appendChild(buildTagChip(tag, board.tagCategories, { showCategory: false }));
    }
    if (tagRow.childElementCount > 0) el.appendChild(tagRow);
  }

  if (settings.showSubtasks && card.subtasks.length > 0) {
    const done = card.subtasks.filter((s) => s.done).length;
    const wrap = document.createElement("div");
    wrap.className = "kb-card-sub";

    const track = document.createElement("span");
    track.className = "kb-card-sub-track";
    const fill = document.createElement("span");
    fill.className = "kb-card-sub-fill";
    fill.style.width = `${Math.round((done / card.subtasks.length) * 100)}%`;
    if (done === card.subtasks.length) fill.classList.add("kb-card-sub-fill-complete");
    track.appendChild(fill);
    wrap.appendChild(track);

    const label = document.createElement("span");
    label.className = "kb-card-sub-count";
    label.textContent = `${done}/${card.subtasks.length}`;
    wrap.appendChild(label);

    el.appendChild(wrap);
  }

  el.addEventListener("click", () => openCard(card.id));
  attachMenu(el, () => boardCardMenu(card));
  attachCardDragHandlers(board, el, card);
  return el;
}

/** The card's right-click menu, as opened from its face on the board.
 *
 *  Deliberately NOT the same list as the three-dot menu inside the card
 *  modal. That one acts on a card you already have open, so it can close the
 *  modal afterwards and has no need to offer "Open". This one is the reverse:
 *  it is the shortcut past opening the card at all, which is why priority,
 *  column and board — the three fields most often changed on their own — are
 *  here as submenus but are plain form controls in the modal. */
function boardCardMenu(card: Card): MenuItem[] {
  const board = getBoard(card.boardId);

  const priorityItems: MenuItem[] = PRIORITIES.map((p) => ({
    label: PRIORITY_LABELS[p],
    disabled: card.priority === p,
    onClick: () => {
      card.priority = p;
      stampCard(card);
      renderAll();
    },
  }));

  const columnItems: MenuItem[] = (board?.columns ?? []).map((col) => ({
    label: col.title,
    disabled: col.id === card.columnId,
    onClick: () => {
      moveCardToColumn(card, col.id);
      renderAll();
    },
  }));

  // Only boards that can actually receive a card. moveCardToBoard rejects a
  // column-less target with an error toast, so offering one here would be
  // offering a row whose only outcome is a complaint.
  const boardItems: MenuItem[] = boards
    .filter((b) => b.id !== card.boardId && b.columns.length > 0)
    .map((b) => ({
      label: b.name,
      onClick: () => {
        moveCardToBoard(card, b.id);
        renderAll();
      },
    }));

  return [
    { label: "Open Card…", onClick: () => openCard(card.id) },
    { label: "Priority", submenu: priorityItems },
    // A one-column board has nowhere to move a card to, and a board with no
    // other boards beside it has nowhere to send one.
    ...(columnItems.length > 1
      ? [{ label: "Move to Column", submenu: columnItems }]
      : []),
    ...(boardItems.length > 0
      ? [{ label: "Move to Board", submenu: boardItems }]
      : []),
    { label: "Card Color…", onClick: () => openCardColor(card) },
    { label: "Card Stats…", onClick: () => openCardStats(card) },
    {
      label: "Duplicate Card",
      onClick: () => {
        const copy = duplicateCard(card);
        if (copy) {
          flash(`Duplicated as #${copy.number}.`);
          renderAll();
        }
      },
    },
    {
      label: "Copy Title",
      onClick: () => {
        void navigator.clipboard
          .writeText(card.title)
          .then(() => flash("Title copied."))
          .catch(() => flash("Couldn't reach the clipboard.", "error"));
      },
    },
    {
      label: "Archive Card",
      onClick: () => {
        card.archived = true;
        stampCard(card);
        flash("Card archived.");
        renderAll();
      },
    },
    {
      label: "Delete Card",
      danger: true,
      // No reopen: the card was never opened, so cancelling the confirm has
      // nothing to go back to but the board it is already sitting on.
      onClick: () => requestDeleteCard(card),
    },
  ];
}

/** The due-date chip, or null when the card has no due date. Says how the date
 *  relates to today rather than only printing it: "in 3 days" is the thing you
 *  wanted to know, and the exact date is on the tooltip for when it is not. */
function buildDueChip(card: Card, todayStr: string): HTMLElement | null {
  if (!card.dates.due) return null;
  const diff = dayDiff(todayStr, card.dates.due);
  const chip = document.createElement("span");
  chip.className = "kb-card-due";
  chip.title = `Due ${formatDate(card.dates.due)}`;

  if (diff === null) {
    chip.textContent = formatDate(card.dates.due);
    return chip;
  }
  if (card.dates.completed) {
    const late = dayDiff(card.dates.due, card.dates.completed);
    chip.classList.add("kb-card-due-done");
    chip.textContent = late !== null && late > 0 ? `${describeDays(late)} late` : "On time";
    chip.title = `Due ${formatDate(card.dates.due)}, completed ${formatDate(card.dates.completed)}`;
    return chip;
  }
  if (diff < 0) {
    chip.classList.add("kb-card-due-over");
    chip.textContent = `${describeDays(diff)} over`;
  } else if (diff === 0) {
    chip.classList.add("kb-card-due-soon");
    chip.textContent = "Due today";
  } else if (diff <= 7) {
    chip.classList.add("kb-card-due-soon");
    chip.textContent = `in ${describeDays(diff)}`;
  } else {
    chip.textContent = formatDate(card.dates.due);
  }
  return chip;
}

/**
 * Paints one chip-shaped control in a tag's color, filled or outlined.
 *
 * A color is now allowed to be ABSENT: a tag can decline to set one and its
 * category can decline too. An uncolored chip is drawn as a plain outline in
 * the theme's own palette rather than being handed an arbitrary color, because
 * "no color" is a choice someone made and the tool should not overrule it.
 */
function paintTagChip(el: HTMLElement, color: string | null, filled: boolean): void {
  if (!color) {
    el.style.removeProperty("background");
    el.style.removeProperty("color");
    el.style.removeProperty("border-color");
    el.classList.toggle("kb-tag-plain", true);
    el.classList.toggle("kb-tag-plain-filled", filled);
    return;
  }
  el.classList.remove("kb-tag-plain", "kb-tag-plain-filled");
  el.style.borderColor = color;
  el.style.background = filled ? color : "transparent";
  if (filled) el.style.color = readableTextOn(color);
  else el.style.removeProperty("color");
}

/** A tag chip painted in the tag's color (its own, or its category's), with the
 *  ink chosen for contrast. Shared by the card face, the card modal's picker
 *  and the filter bar, so a tag looks like itself everywhere. */
function buildTagChip(
  tag: Tag,
  categories: TagCategory[],
  opts: { showCategory?: boolean } = {},
): HTMLElement {
  const chip = document.createElement("span");
  chip.className = "kb-tag-chip";
  paintTagChip(chip, tagColor(tag, categories), true);
  const category = categories.find((c) => c.id === tag.categoryId) ?? null;
  chip.textContent = opts.showCategory && category ? `${category.name}: ${tag.name}` : tag.name;
  chip.title = category ? `${category.name}: ${tag.name}` : tag.name;
  if (tag.status === "retired") chip.classList.add("kb-tag-chip-retired");
  return chip;
}

/* =============================================================================
   DRAG AND DROP
   -----------------------------------------------------------------------------
   HTML5 drag and drop, moving the real element live rather than drawing a
   placeholder: the card you are dragging IS the preview, so what you see
   during the drag is exactly what you get after it.

   The commit happens on `dragend`, never on `drop`. dragend fires whatever
   happens (dropped on a column, dropped on the padding, dropped outside the
   window, cancelled with Escape), so it is the only hook that cannot leave the
   already-reordered DOM disagreeing with the stored order. That exact bug is
   what the same note in sidebar-edit.ts is about.
============================================================================= */

let dragCardId: string | null = null;
let dragColumnId: string | null = null;

function attachCardDragHandlers(board: Board, el: HTMLElement, card: Card): void {
  el.addEventListener("dragstart", (e) => {
    // Without this the column underneath also starts dragging when its own
    // draggable flag happens to be set.
    e.stopPropagation();
    dragCardId = card.id;
    el.classList.add("kb-dragging");
    e.dataTransfer?.setData("text/plain", card.id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  });

  el.addEventListener("dragend", (e) => {
    e.stopPropagation();
    el.classList.remove("kb-dragging");
    dragCardId = null;
    commitCardOrderFromDom(board);
  });
}

/** The first card in `body` whose midpoint is below `y`, i.e. the one the
 *  dragged card should be inserted before. null means "past the last one". */
function cardBeforePoint(body: HTMLElement, y: number): HTMLElement | null {
  const others = Array.from(
    body.querySelectorAll<HTMLElement>(".kb-card:not(.kb-dragging)"),
  );
  for (const el of others) {
    const rect = el.getBoundingClientRect();
    if (y < rect.top + rect.height / 2) return el;
  }
  return null;
}

function attachCardDropTarget(body: HTMLElement): void {
  body.addEventListener("dragover", (e) => {
    if (!dragCardId) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";

    const dragged = columnsEl.querySelector<HTMLElement>(
      `.kb-card[data-card-id="${CSS.escape(dragCardId)}"]`,
    );
    if (!dragged) return;

    // The "nothing here yet" line is a sibling of the cards, so it has to get
    // out of the way or the dragged card lands under it.
    body.querySelector(".kb-column-empty")?.remove();

    const before = cardBeforePoint(body, e.clientY);
    if (before) body.insertBefore(dragged, before);
    else body.appendChild(dragged);
  });

  // Needed only so the browser accepts the drop at all; the work is in dragend.
  body.addEventListener("drop", (e) => e.preventDefault());
}

/** Reads the board's live DOM order back into the cards. Also applies the
 *  one side effect a move is allowed to have: stamping the Complete date when
 *  a card lands in a column that means done. */
function commitCardOrderFromDom(board: Board): void {
  const todayStr = today();
  let changed = false;
  let autoStamped = 0;

  for (const body of columnsEl.querySelectorAll<HTMLElement>(".kb-column-body")) {
    const columnId = body.dataset.columnId;
    if (!columnId) continue;
    const column = getColumn(board, columnId);
    const ids = Array.from(body.querySelectorAll<HTMLElement>(".kb-card")).map(
      (el) => el.dataset.cardId ?? "",
    );

    ids.forEach((id, index) => {
      const card = getCard(id);
      if (!card) return;
      const movedColumn = card.columnId !== columnId;
      if (!movedColumn && card.order === index) return;

      changed = true;
      card.columnId = columnId;
      card.order = index;
      card.updatedAt = Date.now();

      if (
        movedColumn &&
        column?.isDone &&
        effective(board).autoCompleteOnDone &&
        !card.dates.completed
      ) {
        card.dates.completed = todayStr;
        autoStamped += 1;
      }
    });
  }

  if (!changed) return;
  resequence(board.id);
  touchBoard(board);
  if (autoStamped > 0) {
    flash(
      autoStamped === 1
        ? "Stamped the card's Complete date."
        : `Stamped ${autoStamped} cards' Complete dates.`,
    );
  }
  // Re-render rather than trusting the dragged DOM: the WIP badges, the
  // "nothing here yet" lines and the stage chips all changed underneath.
  renderBoardView();
}

/** Columns drag from their grip only. Setting `draggable` for the life of the
 *  press (rather than always) is what keeps a card drag from being swallowed
 *  by its column: only one of the two is ever draggable at a time. */
function attachColumnDragHandlers(
  board: Board,
  el: HTMLElement,
  grip: HTMLElement,
  column: Column,
): void {
  grip.addEventListener("pointerdown", () => {
    el.draggable = true;
    // The release is listened for on the DOCUMENT, not on the grip. A press
    // that never became a drag, and whose pointer wandered off the grip before
    // being released, would otherwise never fire the grip's own pointerup and
    // leave the column draggable for good, quietly hijacking text selection
    // inside it from then on.
    document.addEventListener(
      "pointerup",
      () => {
        el.draggable = false;
      },
      { once: true },
    );
  });

  el.addEventListener("dragstart", (e) => {
    if (!el.draggable) return;
    dragColumnId = column.id;
    el.classList.add("kb-column-dragging");
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  });

  el.addEventListener("dragend", () => {
    el.draggable = false;
    el.classList.remove("kb-column-dragging");
    if (!dragColumnId) return;
    dragColumnId = null;
    commitColumnOrderFromDom(board);
  });

  el.addEventListener("dragover", (e) => {
    if (!dragColumnId || dragColumnId === column.id) return;
    e.preventDefault();
    const dragged = columnsEl.querySelector<HTMLElement>(
      `.kb-column[data-column-id="${CSS.escape(dragColumnId)}"]`,
    );
    if (!dragged) return;
    const rect = el.getBoundingClientRect();
    const before = e.clientX < rect.left + rect.width / 2;
    columnsEl.insertBefore(dragged, before ? el : el.nextSibling);
  });
}

function commitColumnOrderFromDom(board: Board): void {
  const order = Array.from(columnsEl.querySelectorAll<HTMLElement>(".kb-column")).map(
    (el) => el.dataset.columnId ?? "",
  );
  const byId = new Map(board.columns.map((c) => [c.id, c]));
  const next: Column[] = [];
  for (const id of order) {
    const col = byId.get(id);
    if (col) {
      next.push(col);
      byId.delete(id);
    }
  }
  // Anything the DOM did not name (should be nothing) keeps its old place at
  // the end rather than being dropped.
  next.push(...byId.values());

  const unchanged =
    next.length === board.columns.length && next.every((c, i) => c.id === board.columns[i].id);
  if (unchanged) return;

  board.columns = next;
  touchBoard(board);
  renderBoardView();
}

/* =============================================================================
   FILTER BAR
============================================================================= */

function renderFilterBar(board: Board): void {
  // Forced open whenever a filter is on, so a board showing three of forty
  // cards can never look like a board with three cards.
  const show = filterBarOpen || anyFilterActive();
  filterBar.style.display = show ? "" : "none";
  if (!show) return;

  filterBar.replaceChildren();

  const live = liveCardsOnBoard(board.id);
  const usedTagIds = new Set(live.flatMap((c) => c.tagIds));

  for (const category of board.tagCategories) {
    if (category.status === "retired") continue;
    // Only tags that are actually ON a card on this board. A filter offering
    // forty tags that would all return nothing is noise, not power.
    const catTags = board.tags.filter(
      (t) => t.categoryId === category.id && (usedTagIds.has(t.id) || filterTagIds.has(t.id)),
    );
    if (catTags.length === 0) continue;

    const group = document.createElement("div");
    group.className = "kb-filter-group";

    const label = document.createElement("span");
    label.className = "kb-filter-label";
    label.textContent = category.name;
    group.appendChild(label);

    for (const tag of catTags) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "kb-filter-chip";
      btn.textContent = tag.name;
      const on = filterTagIds.has(tag.id);
      btn.classList.toggle("active", on);
      paintTagChip(btn, tagColor(tag, board.tagCategories), on);
      btn.addEventListener("click", () => {
        if (filterTagIds.has(tag.id)) filterTagIds.delete(tag.id);
        else filterTagIds.add(tag.id);
        renderBoardView();
      });
      group.appendChild(btn);
    }
    filterBar.appendChild(group);
  }

  const dueGroup = document.createElement("div");
  dueGroup.className = "kb-filter-group kb-filter-group-due";
  const dueLabel = document.createElement("span");
  dueLabel.className = "kb-filter-label";
  dueLabel.textContent = "Due";
  dueGroup.appendChild(dueLabel);

  const DUE_OPTIONS: { value: typeof filterDue; label: string }[] = [
    { value: "any", label: "Any" },
    { value: "overdue", label: "Overdue" },
    { value: "soon", label: "Next 7 days" },
    { value: "none", label: "No due date" },
  ];
  for (const option of DUE_OPTIONS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "kb-filter-chip";
    btn.textContent = option.label;
    btn.classList.toggle("active", filterDue === option.value);
    btn.addEventListener("click", () => {
      filterDue = option.value;
      renderBoardView();
    });
    dueGroup.appendChild(btn);
  }
  filterBar.appendChild(dueGroup);

  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "modal-cancel-btn kb-filter-clear";
  clear.textContent = "Clear filters";
  clear.disabled = !anyFilterActive();
  clear.addEventListener("click", () => {
    clearFilters();
    filterBarOpen = true;
    renderBoardView();
  });
  filterBar.appendChild(clear);
}

/* =============================================================================
   MUTATIONS
============================================================================= */

/** Stamps a board as edited. Every mutation path ends here, so "when did this
 *  board last change" is one field rather than a scan of its cards, and so
 *  exactly one board's file is queued for writing rather than all of them. */
function touchBoard(board: Board): void {
  board.updatedAt = Date.now();
  markBoard(board.id);
}

function createCard(
  board: Board,
  columnId: string,
  title: string,
  position: NewCardPosition,
): Card | null {
  if (liveCardsOnBoard(board.id).length >= MAX_CARDS_PER_BOARD) {
    flash(
      `This board is at its limit of ${MAX_CARDS_PER_BOARD} cards. Archive some finished work first.`,
      "error",
      8000,
    );
    return null;
  }
  const now = Date.now();
  const existing = cardsInColumn(board.id, columnId);
  const card: Card = {
    id: newId(),
    boardId: board.id,
    columnId,
    number: board.nextCardNumber,
    title: title.slice(0, MAX_TITLE_LEN),
    description: "",
    color: null,
    colorMode: null,
    textColor: "auto",
    priority: "none",
    tagIds: [],
    subtasks: [],
    dates: { due: null, started: null, testing: null, completed: null },
    archived: false,
    createdAt: now,
    updatedAt: now,
    // Placed at whichever end was asked for, by giving it an order the
    // resequence below turns into a real index.
    order: position === "top" ? -1 : existing.length,
  };
  board.nextCardNumber += 1;
  cards.push(card);
  resequence(board.id);
  touchBoard(board);
  return card;
}

function deleteCard(card: Card): void {
  cards = cards.filter((c) => c.id !== card.id);
  const board = getBoard(card.boardId);
  if (board) {
    resequence(board.id);
    touchBoard(board);
  } else {
    // Orphan card with no board left to attribute it to. Nothing to write to a
    // board file, but the index still has to learn the card is gone.
    markIndex();
  }
}

function duplicateCard(card: Card): Card | null {
  const board = getBoard(card.boardId);
  if (!board) return null;
  const now = Date.now();
  const copy: Card = {
    ...card,
    id: newId(),
    number: board.nextCardNumber,
    title: `${card.title} (copy)`.slice(0, MAX_TITLE_LEN),
    // Subtask ids have to be fresh too, or ticking one on the copy would look
    // for it on the original.
    subtasks: card.subtasks.map((s) => ({ ...s, id: newId(), done: false })),
    tagIds: [...card.tagIds],
    // The stage stamps belong to the work that was actually done, not to a new
    // copy of the card. The due date is a plan and does carry over.
    dates: { due: card.dates.due, started: null, testing: null, completed: null },
    archived: false,
    createdAt: now,
    updatedAt: now,
    order: card.order + 0.5,
  };
  board.nextCardNumber += 1;
  cards.push(copy);
  resequence(board.id);
  touchBoard(board);
  return copy;
}

/* =============================================================================
   MODAL INSTANCES
   -----------------------------------------------------------------------------
   All lazily constructed on first use, the pattern the rest of the app's tools
   use: wiring a dozen modals at startup costs the launch path for screens most
   sessions never open. Declared together here because topOpenKanbanModal()
   (further up) needs the whole set to answer the back button.
============================================================================= */

let _setupModal: Modal | null = null;
let _newBoardModal: Modal | null = null;
let _boardSetupModal: Modal | null = null;
let _cardColorModal: Modal | null = null;
let _columnEditModal: Modal | null = null;
let _cardModal: Modal | null = null;
let _cardStatsModal: Modal | null = null;
let _boardStatsModal: Modal | null = null;
let _archiveModal: Modal | null = null;
let _tagCatEditModal: Modal | null = null;
let _tagEditModal: Modal | null = null;
let _confirmModal: Modal | null = null;
let _passwordModal: Modal | null = null;

/* =============================================================================
   CONFIRM
   One modal for every destructive action in this tool, with the caller
   supplying the words. Eight near-identical confirms would drift apart, and
   the one that drifted would be the one that deleted something.
============================================================================= */

let confirmAction: (() => void) | null = null;
/** How to get back to whatever this confirm replaced, if it is dismissed. */
let confirmReopen: (() => void) | null = null;

function getConfirmModal(): Modal {
  if (!_confirmModal) {
    _confirmModal = new Modal(document.getElementById("kbConfirmBackdrop")!, {
      closeOnEsc: true,
      onClosed: () => {
        // Still set means this was dismissed by something that did not go
        // through the buttons below: Escape, or a future close path. Both of
        // those are dismissals, so they owe the same journey back.
        const back = confirmReopen;
        confirmAction = null;
        confirmReopen = null;
        back?.();
      },
    });

    /** Dismissed rather than confirmed: put back what this replaced. */
    const dismiss = (): void => {
      const back = confirmReopen;
      confirmAction = null;
      confirmReopen = null;
      _confirmModal!.close({ handoff: true });
      back?.();
    };
    document.getElementById("kbConfirmCancelBtn")!.addEventListener("click", dismiss);

    document.getElementById("kbConfirmOkBtn")!.addEventListener("click", () => {
      // Captured before the close, because onClosed clears both.
      const action = confirmAction;
      confirmAction = null;
      confirmReopen = null;
      _confirmModal!.close({ handoff: true });
      action?.();
    });
  }
  return _confirmModal;
}

/**
 * Asks, over the top of nothing.
 *
 * Nothing in this tool stacks: a confirm REPLACES whatever it was launched
 * from. Two dimmed panels deep is a place where it stops being obvious which
 * one the buttons belong to, and this particular panel deletes things.
 *
 * `reopen` is how to get back, and it is the caller's job because only the
 * caller knows: reopening the Modal object is not enough, since these modals
 * clear the state that says which card or board they were showing when they
 * close. It runs on dismissal. After a confirm, the action decides what comes
 * next, which is usually nothing, because the thing it was showing is gone.
 */
function kbConfirm(
  opts: { title: string; message: string; confirmLabel: string; reopen?: () => void },
  onConfirm: () => void,
): void {
  // Handoff, so the parent does not reset its tab or scroll on the way out.
  topOpenKanbanModal()?.close({ handoff: true });

  const modal = getConfirmModal();
  document.getElementById("kbConfirmTitle")!.textContent = opts.title;
  document.getElementById("kbConfirmMessage")!.textContent = opts.message;
  document.getElementById("kbConfirmOkBtn")!.textContent = opts.confirmLabel;
  confirmAction = onConfirm;
  confirmReopen = opts.reopen ?? null;
  modal.open();
}

/* =============================================================================
   CARD MODAL
============================================================================= */

function getCardModal(): Modal {
  if (_cardModal) return _cardModal;

  const backdrop = document.getElementById("kbCardBackdrop")!;
  const titleInput = document.getElementById("kbCardTitleInput") as HTMLInputElement;
  const descInput = document.getElementById("kbCardDescInput") as HTMLTextAreaElement;
  const columnSelect = document.getElementById("kbCardColumnSelect") as HTMLSelectElement;
  const boardSelect = document.getElementById("kbCardBoardSelect") as HTMLSelectElement;
  const dueInput = document.getElementById("kbCardDueInput") as HTMLInputElement;
  const subtaskInput = document.getElementById("kbCardSubtaskInput") as HTMLInputElement;
  const colorCustom = document.getElementById("kbCardColorCustom") as HTMLInputElement;

  _cardModal = new Modal(backdrop, {
    closeOnEsc: true,
    onClosed: () => {
      openCardId = null;
      closeMenu();
      // The board behind was not being kept in step while the modal was open;
      // this is where it catches up in one pass.
      renderAll();
    },
  });

  const withCard = (fn: (card: Card) => void) => () => {
    const card = getCard(openCardId);
    if (card) fn(card);
  };

  titleInput.addEventListener("input", () => {
    const card = getCard(openCardId);
    if (!card) return;
    card.title = titleInput.value.slice(0, MAX_TITLE_LEN);
    stampCard(card);
    renderCardHeader(card);
  });

  descInput.addEventListener("input", () => {
    const card = getCard(openCardId);
    if (!card) return;
    card.description = descInput.value.slice(0, MAX_DESC_LEN);
    stampCard(card);
  });

  columnSelect.addEventListener("change", () => {
    const card = getCard(openCardId);
    if (!card) return;
    moveCardToColumn(card, columnSelect.value);
    renderCardModal();
  });

  const prioritySelect = document.getElementById("kbCardPrioritySelect") as HTMLSelectElement;
  prioritySelect.addEventListener("change", () => {
    const card = getCard(openCardId);
    if (!card) return;
    card.priority = normalizePriority(prioritySelect.value);
    stampCard(card);
  });

  boardSelect.addEventListener("change", () => {
    const card = getCard(openCardId);
    if (!card) return;
    moveCardToBoard(card, boardSelect.value);
    renderCardModal();
  });

  dueInput.addEventListener("change", () => {
    const card = getCard(openCardId);
    if (!card) return;
    card.dates.due = dueInput.value || null;
    stampCard(card);
    renderCardDue(card);
  });

  document.getElementById("kbCardDueClearBtn")!.addEventListener(
    "click",
    withCard((card) => {
      card.dates.due = null;
      dueInput.value = "";
      stampCard(card);
      renderCardDue(card);
    }),
  );

  document.getElementById("kbCardAdvanceBtn")!.addEventListener(
    "click",
    withCard((card) => {
      advanceStage(card);
      renderCardStages(card);
      // Stamping Completed changes what the due row says ("finished on time"),
      // so the two are always redrawn together.
      renderCardDue(card);
    }),
  );

  document.getElementById("kbCardUndoStageBtn")!.addEventListener(
    "click",
    withCard((card) => {
      undoStage(card);
      renderCardStages(card);
      renderCardDue(card);
    }),
  );

  const addSubtask = withCard((card) => {
    const text = subtaskInput.value.trim();
    if (!text) return;
    if (card.subtasks.length >= MAX_SUBTASKS_PER_CARD) {
      flash(`A card holds at most ${MAX_SUBTASKS_PER_CARD} subtasks.`, "error");
      return;
    }
    card.subtasks.push({ id: newId(), text: text.slice(0, 300), done: false });
    subtaskInput.value = "";
    stampCard(card);
    renderCardSubtasks(card);
    subtaskInput.focus();
  });
  document.getElementById("kbCardSubtaskAddBtn")!.addEventListener("click", addSubtask);
  subtaskInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addSubtask();
    }
  });

  document.getElementById("kbCardManageTagsBtn")!.addEventListener("click", () => {
    const card = getCard(openCardId);
    const board = card ? getBoard(card.boardId) : null;
    if (!board) return;
    // This board's own vocabulary, not the defaults: those are templates, and
    // adding one there would not put a tag on this card.
    _cardModal!.close({ handoff: true });
    openBoardSetup(board, "tags");
  });

  /* Everything that is an ACTION on the card rather than a field of it. The
     footer these came from is gone: with every edit applying live there was
     nothing left for it to hold except two destructive buttons sitting under
     the cursor. */
  document.getElementById("kbCardMenuBtn")!.addEventListener("click", (e) => {
    const card = getCard(openCardId);
    if (!card) return;
    openMenu(e.currentTarget as HTMLElement, [
      { label: "Card Color", onClick: () => openCardColor(card) },
      { label: "Card Stats", onClick: () => openCardStats(card) },
      {
        label: "Duplicate Card",
        onClick: () => {
          const copy = duplicateCard(card);
          if (copy) {
            flash(`Duplicated as #${copy.number}.`);
            openCard(copy.id);
          }
        },
      },
      {
        label: "Copy Title",
        onClick: () => {
          void navigator.clipboard
            .writeText(card.title)
            .then(() => flash("Title copied."))
            .catch(() => flash("Couldn't reach the clipboard.", "error"));
        },
      },
      {
        label: card.archived ? "Restore to Board" : "Archive Card",
        onClick: () => {
          card.archived = !card.archived;
          stampCard(card);
          flash(card.archived ? "Card archived." : "Card restored to the board.");
          _cardModal!.close();
        },
      },
      {
        label: "Delete Card",
        danger: true,
        // The confirm replaces the card modal, so dismissing it comes back to
        // the card. Confirming has nothing to come back to.
        onClick: () => requestDeleteCard(card, { reopen: () => openCard(card.id) }),
      },
    ]);
  });

  document.getElementById("kbCardClose")!.addEventListener("click", () => _cardModal!.close());

  return _cardModal;
}

/** Deletes a card, asking first unless this board says not to. The single
 *  delete path, shared by the card menu and by the bin on the card face, so the
 *  confirmation preference cannot end up honoured in one place and not the
 *  other. */
function requestDeleteCard(card: Card, opts: { reopen?: () => void } = {}): void {
  const remove = (): void => {
    deleteCard(card);
    // The board has to redraw HERE. Deleting from the card modal happened to
    // work because closing that modal redraws; deleting from the bin on the
    // card face did not, so the card stayed on the board until you left it and
    // came back. The delete is what needs the redraw, not the modal.
    renderAll();
    flash("Card deleted.");
  };
  if (!effectiveForCard(card).confirmDelete) {
    // No confirm means nothing replaced the card modal, so it is still open
    // over a card that no longer exists.
    if (_cardModal?.isOpen) _cardModal.close();
    remove();
    return;
  }
  kbConfirm(
    {
      title: `Delete card #${card.number}?`,
      message: `"${card.title || "Untitled"}" and its ${card.subtasks.length} subtask(s) go for good. Archive instead if you only want it off the board.`,
      confirmLabel: "Delete",
      reopen: opts.reopen,
    },
    remove,
  );
}

/** Marks a card edited and queues the write. Every card mutation goes through
 *  it so `updatedAt` can never be forgotten by one path and not another. */
function stampCard(card: Card): void {
  card.updatedAt = Date.now();
  const board = getBoard(card.boardId);
  if (!board) return;
  board.updatedAt = card.updatedAt;
  markBoard(board.id);
}

function openCard(cardId: string): void {
  const card = getCard(cardId);
  if (!card) return;
  openCardId = cardId;
  renderCardModal();
  getCardModal().open();
}

function renderCardModal(): void {
  const card = getCard(openCardId);
  if (!card) return;
  const settings = effectiveForCard(card);

  renderCardHeader(card);
  (document.getElementById("kbCardTitleInput") as HTMLInputElement).value = card.title;
  (document.getElementById("kbCardDescInput") as HTMLTextAreaElement).value = card.description;
  renderCardPlacement(card);
  renderCardDue(card);
  renderCardSubtasks(card);

  renderCardTags(card);

  // Both date blocks are optional, and each goes entirely rather than being
  // emptied: an empty titled box reads as something that failed to load.
  const stagesSection = document.getElementById("kbCardStagesSection") as HTMLElement;
  stagesSection.style.display = settings.showStages ? "" : "none";
  if (settings.showStages) renderCardStages(card);

  const dueSection = document.getElementById("kbCardDueSection") as HTMLElement;
  dueSection.style.display = settings.showDue ? "" : "none";

  applyCardSectionOrder(settings.sectionOrder);
}

/** Rearranges the card's blocks to the order in force for its board. Moving the
 *  existing elements rather than rebuilding them keeps every listener and every
 *  bit of in-progress typing intact. */
function applyCardSectionOrder(order: CardSection[]): void {
  const host = document.getElementById("kbCardSections")!;
  for (const section of order) {
    const el = host.querySelector<HTMLElement>(`[data-kb-section="${section}"]`);
    // appendChild on an element already in the parent MOVES it, so walking the
    // order in sequence leaves the DOM in exactly that order.
    if (el) host.appendChild(el);
  }
}

function renderCardHeader(card: Card): void {
  const board = getBoard(card.boardId);
  const label = document.getElementById("kbCardHeaderLabel")!;
  const bits = [`Card #${card.number}`];
  if (board) bits.push(board.name);
  if (card.archived) bits.push("Archived");
  label.textContent = bits.join(" · ");
}

/** The board and column selects. Both are real moves rather than a display,
 *  which is why the column list is rebuilt from whichever board is selected. */
function renderCardPlacement(card: Card): void {
  const boardSelect = document.getElementById("kbCardBoardSelect") as HTMLSelectElement;
  const columnSelect = document.getElementById("kbCardColumnSelect") as HTMLSelectElement;

  boardSelect.replaceChildren();
  for (const board of boards) {
    const option = document.createElement("option");
    option.value = board.id;
    option.textContent = board.name;
    boardSelect.appendChild(option);
  }
  boardSelect.value = card.boardId;

  columnSelect.replaceChildren();
  const board = getBoard(card.boardId);
  for (const column of board?.columns ?? []) {
    const option = document.createElement("option");
    option.value = column.id;
    option.textContent = column.title;
    columnSelect.appendChild(option);
  }
  columnSelect.value = card.columnId;

  const prioritySelect = document.getElementById("kbCardPrioritySelect") as HTMLSelectElement;
  prioritySelect.replaceChildren();
  for (const level of PRIORITIES) {
    const option = document.createElement("option");
    option.value = level;
    option.textContent = PRIORITY_LABELS[level];
    prioritySelect.appendChild(option);
  }
  prioritySelect.value = card.priority;
}

function moveCardToColumn(card: Card, columnId: string): void {
  const board = getBoard(card.boardId);
  if (!board) return;
  const column = getColumn(board, columnId);
  if (!column || column.id === card.columnId) return;

  card.columnId = column.id;
  card.order = -1; // to the top of its new column, then resequenced
  if (column.isDone && effective(board).autoCompleteOnDone && !card.dates.completed) {
    card.dates.completed = today();
    flash("Stamped the card's Complete date.");
  }
  resequence(board.id);
  stampCard(card);
}

function moveCardToBoard(card: Card, boardId: string): void {
  const target = getBoard(boardId);
  const from = getBoard(card.boardId);
  if (!target || target.id === card.boardId) return;
  if (target.columns.length === 0) {
    flash("That board has no columns to move the card into.", "error");
    renderCardPlacement(card);
    return;
  }

  const previous = card.number;
  card.boardId = target.id;
  card.columnId = target.columns[0].id;
  card.order = -1;
  // A card number only means anything within its own board, so crossing boards
  // means taking a new one. Said out loud, because "#42" may be written down
  // somewhere outside this app.
  card.number = target.nextCardNumber;
  target.nextCardNumber += 1;

  if (from) resequence(from.id);
  resequence(target.id);
  stampCard(card);
  flash(`Moved to ${target.name}. It is now #${card.number} (was #${previous}).`);
}

/* -----------------------------------------------------------------------------
   STAGES
----------------------------------------------------------------------------- */

/** Sets the next unstamped stage to today. */
function advanceStage(card: Card): void {
  const next = furthestStage(card) + 1;
  if (next >= STAGES.length) return;
  card.dates[STAGES[next]] = today();
  stampCard(card);
}

/** Clears the most recent stamp. The undo for the button above, and the reason
 *  a one-click stage advance is safe to offer at all. */
function undoStage(card: Card): void {
  const current = furthestStage(card);
  if (current < 0) return;
  card.dates[STAGES[current]] = null;
  stampCard(card);
}

/** A stage order that cannot have happened (testing before work started),
 *  described plainly, or null when the dates are consistent. Not an error and
 *  nothing is blocked: hand-entered dates get typed wrong, and the fix is to
 *  say so next to them rather than to refuse the entry. */
export function stageOrderWarning(card: Card): string | null {
  const chain: { label: string; value: string | null }[] = [
    { label: "created", value: createdDay(card) },
    { label: "work started", value: card.dates.started },
    { label: "testing started", value: card.dates.testing },
    { label: "completed", value: card.dates.completed },
  ];
  const set = chain.filter((s) => s.value !== null);
  for (let i = 1; i < set.length; i++) {
    const diff = dayDiff(set[i - 1].value, set[i].value);
    if (diff !== null && diff < 0) {
      return `${set[i].label} is before ${set[i - 1].label}`;
    }
  }
  return null;
}

function renderCardStages(card: Card): void {
  const grid = document.getElementById("kbCardStages")!;
  grid.replaceChildren();

  grid.appendChild(buildStageRow("Created", createdDay(card), null));
  for (const stage of STAGES) {
    grid.appendChild(
      buildStageRow(STAGE_LABELS[stage], card.dates[stage], (value) => {
        card.dates[stage] = value;
        stampCard(card);
        renderCardStages(card);
        renderCardDue(card);
      }),
    );
  }

  const furthest = furthestStage(card);
  const advance = document.getElementById("kbCardAdvanceBtn") as HTMLButtonElement;
  const undo = document.getElementById("kbCardUndoStageBtn") as HTMLButtonElement;

  if (furthest + 1 < STAGES.length) {
    const next = STAGES[furthest + 1];
    advance.disabled = false;
    advance.textContent = ADVANCE_LABELS[next];
    advance.title = `Stamps ${STAGE_LABELS[next]} with today's date.`;
  } else {
    advance.disabled = true;
    advance.textContent = "All Stages Stamped";
    advance.title = "Every stage date is filled in.";
  }

  undo.disabled = furthest < 0;
  undo.title =
    furthest < 0
      ? "Nothing stamped yet."
      : `Clears ${STAGE_LABELS[STAGES[furthest]]}.`;

  const summary = document.getElementById("kbCardStageSummary")!;
  const warning = stageOrderWarning(card);
  summary.textContent = warning
    ? `Check the dates: ${warning}.`
    : furthest < 0
      ? "Not started."
      : `Furthest stage: ${STAGE_LABELS[STAGES[furthest]]}.`;
  summary.classList.toggle("kb-stat-alert", warning !== null);
}

/**
 * The due date, which is NOT one of the stages and does not go with them.
 *
 * A stage date records something that happened; a due date is a target you set
 * in advance, and it is what the overdue warning and the card's due chip read.
 * So it keeps its own place in the card and stays available on a board that has
 * stage dates switched off entirely.
 *
 * It still reports against the completed stamp when there is one, because
 * "finished four days late" is the thing you want to know and the only place
 * both halves of it exist.
 */
function renderCardDue(card: Card): void {
  const dueInput = document.getElementById("kbCardDueInput") as HTMLInputElement;
  dueInput.value = card.dates.due ?? "";
  const dueNote = document.getElementById("kbCardDueNote")!;
  dueNote.classList.remove("kb-stat-alert");
  if (!card.dates.due) {
    dueNote.textContent = "No due date.";
  } else if (card.dates.completed) {
    const late = dayDiff(card.dates.due, card.dates.completed);
    dueNote.textContent =
      late === null ? "" : late > 0 ? `Finished ${describeDays(late)} late.` : "Finished on time.";
    if (late !== null && late > 0) dueNote.classList.add("kb-stat-alert");
  } else {
    const diff = dayDiff(today(), card.dates.due);
    if (diff === null) dueNote.textContent = "";
    else if (diff < 0) {
      dueNote.textContent = `${describeDays(diff)} overdue.`;
      dueNote.classList.add("kb-stat-alert");
    } else if (diff === 0) dueNote.textContent = "Due today.";
    else dueNote.textContent = `Due in ${describeDays(diff)}.`;
  }
}

/** One stage row: a label, an editable date (or a fixed one for Created) and a
 *  clear button. `onChange` null means the row is read-only. */
function buildStageRow(
  label: string,
  value: string | null,
  onChange: ((value: string | null) => void) | null,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "kb-stage-row";

  const labelEl = document.createElement("span");
  labelEl.className = "kb-stage-label";
  labelEl.textContent = label;
  row.appendChild(labelEl);

  if (!onChange) {
    const fixed = document.createElement("span");
    fixed.className = "kb-stage-fixed";
    fixed.textContent = formatDate(value);
    row.appendChild(fixed);
    return row;
  }

  const input = document.createElement("input");
  input.type = "date";
  input.className = "kb-stage-input";
  input.value = value ?? "";
  input.addEventListener("change", () => onChange(input.value || null));
  row.appendChild(input);

  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "kb-icon-btn kb-stage-clear";
  clear.title = `Clear ${label}`;
  clear.textContent = "×";
  clear.disabled = value === null;
  clear.addEventListener("click", () => onChange(null));
  row.appendChild(clear);

  return row;
}

/* -----------------------------------------------------------------------------
   COLOR
----------------------------------------------------------------------------- */

/**
 * The card's color, on its own screen, reached from the card's three-dot menu.
 *
 * It was a block in the card's body, which put a color picker permanently in
 * front of someone writing a description. A color is something you do to a
 * card once; it does not need to be on screen every time the card is.
 */
function getCardColorModal(): Modal {
  if (_cardColorModal) return _cardColorModal;

  const custom = document.getElementById("kbCardColorCustom") as HTMLInputElement;
  const modeSelect = document.getElementById("kbCardColorModeSelect") as HTMLSelectElement;
  const textSelect = document.getElementById("kbCardTextColorSelect") as HTMLSelectElement;

  _cardColorModal = new Modal(document.getElementById("kbCardColorBackdrop")!, {
    closeOnEsc: true,
    onClosed: () => {
      colorCardId = null;
      // The board behind was not being kept in step while this was open, and a
      // color is the one edit here that changes how the card looks on it.
      renderAll();
    },
  });

  custom.addEventListener("input", () => {
    const card = getCard(colorCardId);
    if (!card) return;
    card.color = custom.value.toLowerCase();
    // Picking a color is a statement that this card has one, so it also takes
    // the card off whatever derived mode it was on. Otherwise the picker would
    // appear to do nothing.
    card.colorMode = "manual";
    stampCard(card);
    renderCardColors(card);
  });

  modeSelect.addEventListener("change", () => {
    const card = getCard(colorCardId);
    if (!card) return;
    card.colorMode = modeSelect.value === "default" ? null : normalizeColorMode(modeSelect.value);
    stampCard(card);
    renderCardColors(card);
  });

  textSelect.addEventListener("change", () => {
    const card = getCard(colorCardId);
    if (!card) return;
    card.textColor = normalizeTextColor(textSelect.value);
    stampCard(card);
    renderCardColors(card);
  });

  document.getElementById("kbCardColorClose")!.addEventListener("click", () =>
    _cardColorModal!.close(),
  );
  document.getElementById("kbCardColorBack")!.addEventListener("click", () => {
    const back = colorCardId;
    _cardColorModal!.close({ handoff: true });
    if (back) openCard(back);
  });

  return _cardColorModal;
}

/** Which card the color sheet is about. Tracked separately from openCardId for
 *  the same reason statsCardId is: the card modal clears that when its own
 *  close finishes, which happens while this sheet is still on screen. */
let colorCardId: string | null = null;

function openCardColor(card: Card): void {
  colorCardId = card.id;
  document.getElementById("kbCardColorTitle")!.textContent = `Card #${card.number} Color`;
  renderCardColors(card);
  getCardModal().close({ handoff: true });
  getCardColorModal().open();
}

function renderCardColors(card: Card): void {
  const board = getBoard(card.boardId);
  const mode = cardColorMode(card, board);

  const modeSelect = document.getElementById("kbCardColorModeSelect") as HTMLSelectElement;
  modeSelect.value = card.colorMode ?? "default";
  // The board's own answer is named in the option, so "Follow the board" is a
  // statement rather than a question.
  const boardMode = effective(board).cardColorMode;
  const boardLabel: Record<CardColorMode, string> = {
    manual: "a color set on the card",
    tag: "its top tag",
    priority: "its priority",
  };
  modeSelect.options[0].textContent = `Follow the board (${boardLabel[boardMode]})`;

  // The swatches only mean anything when the card's color is its own.
  (document.getElementById("kbCardColorManualRow") as HTMLElement).style.display =
    mode === "manual" ? "" : "none";

  (document.getElementById("kbCardTextColorSelect") as HTMLSelectElement).value = card.textColor;
  renderCardColorPreview(card, board);

  const row = document.getElementById("kbCardColorRow")!;
  row.replaceChildren();

  const none = document.createElement("button");
  none.type = "button";
  none.className = "kb-swatch kb-swatch-none";
  none.title = "No color: use the theme's card surface";
  none.textContent = "∅";
  none.classList.toggle("active", card.color === null);
  none.addEventListener("click", () => {
    card.color = null;
    stampCard(card);
    renderCardColors(card);
  });
  row.appendChild(none);


  for (const color of CARD_COLORS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "kb-swatch";
    btn.style.background = color;
    // The tick has to be legible on the swatch it sits on, same rule the card
    // itself follows.
    btn.style.color = readableTextOn(color);
    btn.title = color;
    btn.textContent = card.color === color ? "✓" : "";
    btn.classList.toggle("active", card.color === color);
    btn.addEventListener("click", () => {
      card.color = color;
      card.colorMode = "manual";
      stampCard(card);
      renderCardColors(card);
    });
    row.appendChild(btn);
  }

  const custom = document.getElementById("kbCardColorCustom") as HTMLInputElement;
  if (card.color) custom.value = card.color;
}

/** A real card, painted the way the board will paint it. The point of showing
 *  it here is that the derived modes have no swatch to look at: "from its
 *  priority" is only visible as the card it produces. */
function renderCardColorPreview(card: Card, board: Board | null): void {
  const preview = document.getElementById("kbCardColorPreview") as HTMLElement;
  const title = document.getElementById("kbCardColorPreviewTitle")!;
  title.textContent = card.title || "Untitled";
  const number = preview.querySelector<HTMLElement>(".kb-card-number");
  if (number) number.textContent = `#${card.number}`;
  applySolidColor(preview, resolveCardColor(card, board), card.textColor);
}

/* -----------------------------------------------------------------------------
   SUBTASKS
----------------------------------------------------------------------------- */

function renderCardSubtasks(card: Card): void {
  const list = document.getElementById("kbCardSubtaskList")!;
  list.replaceChildren();

  for (const subtask of card.subtasks) {
    const row = document.createElement("div");
    row.className = "kb-subtask-row";
    if (subtask.done) row.classList.add("kb-subtask-done");

    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = subtask.done;
    check.addEventListener("change", () => {
      subtask.done = check.checked;
      stampCard(card);
      renderCardSubtasks(card);
    });
    row.appendChild(check);

    const text = document.createElement("input");
    text.type = "text";
    text.className = "kb-subtask-text";
    text.value = subtask.text;
    text.addEventListener("input", () => {
      subtask.text = text.value.slice(0, 300);
      stampCard(card);
    });
    row.appendChild(text);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "kb-icon-btn";
    remove.title = "Remove subtask";
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      card.subtasks = card.subtasks.filter((s) => s.id !== subtask.id);
      stampCard(card);
      renderCardSubtasks(card);
    });
    row.appendChild(remove);

    list.appendChild(row);
  }

  const done = card.subtasks.filter((s) => s.done).length;
  const total = card.subtasks.length;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  (document.getElementById("kbCardSubtaskBar") as HTMLElement).style.width = `${pct}%`;
  document.getElementById("kbCardSubtaskSummary")!.textContent =
    total === 0 ? "None yet." : `${done} of ${total} done (${pct}%)`;
}

/* -----------------------------------------------------------------------------
   TAGS ON A CARD
----------------------------------------------------------------------------- */

function renderCardTags(card: Card): void {
  const picker = document.getElementById("kbCardTagPicker")!;
  picker.replaceChildren();

  // This card's own board's vocabulary, not the defaults. A card can only wear
  // a tag that exists on the board it is on.
  const board = getBoard(card.boardId);
  const boardCategories = board?.tagCategories ?? [];
  const boardTags = board?.tags ?? [];

  const usable = boardCategories.filter(
    (c) =>
      c.status === "active" ||
      boardTags.some((t) => t.categoryId === c.id && card.tagIds.includes(t.id)),
  );

  if (usable.length === 0) {
    const empty = document.createElement("p");
    empty.className = "placeholder-text";
    empty.textContent =
      "This board has no tags yet. Board Setup > Tags can copy in the defaults or add its own.";
    picker.appendChild(empty);
    return;
  }

  for (const category of usable) {
    // A retired tag stays visible on the cards that already carry it (dropping
    // it would rewrite history) but is not offered to cards that do not.
    const catTags = boardTags.filter(
      (t) => t.categoryId === category.id && (t.status === "active" || card.tagIds.includes(t.id)),
    );
    if (catTags.length === 0) continue;

    const group = document.createElement("div");
    group.className = "kb-tag-group";

    const label = document.createElement("span");
    label.className = "kb-tag-group-label";
    label.textContent = category.name;
    group.appendChild(label);

    for (const tag of catTags) {
      const on = card.tagIds.includes(tag.id);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "kb-tag-toggle";
      btn.classList.toggle("active", on);
      btn.textContent = tag.name;
      paintTagChip(btn, tagColor(tag, boardCategories), on);
      btn.title = tag.status === "retired" ? `${tag.name} (retired)` : tag.name;
      btn.addEventListener("click", () => {
        if (on) card.tagIds = card.tagIds.filter((id) => id !== tag.id);
        else card.tagIds.push(tag.id);
        stampCard(card);
        renderCardTags(card);
      });
      group.appendChild(btn);
    }
    picker.appendChild(group);
  }
}

/* =============================================================================
   CARD STATS
   -----------------------------------------------------------------------------
   Every figure is a subtraction between two dates on the card, so every one of
   them can be checked against the dates shown right above it. Where a date is
   missing, the row says which one instead of inventing a number.
============================================================================= */

export interface StatRow {
  label: string;
  value: string;
  note?: string;
  alert?: boolean;
}

export function computeCardStats(card: Card, todayStr: string): StatRow[] {
  const created = createdDay(card);
  const { started, testing, completed, due } = card.dates;
  const rows: StatRow[] = [];

  const span = (
    label: string,
    from: string | null,
    to: string | null,
    missing: string,
  ): StatRow => {
    const diff = dayDiff(from, to);
    return diff === null
      ? { label, value: "—", note: missing }
      : { label, value: describeDays(diff), note: diff < 0 ? "the dates are out of order" : undefined, alert: diff < 0 };
  };

  rows.push({ label: "Created", value: formatDate(created) });
  rows.push({
    label: completed ? "Age at completion" : "Age",
    value: describeDays(dayDiff(created, completed ?? todayStr) ?? 0),
    note: completed ? undefined : "still open",
  });

  rows.push(span("Waiting to start", created, started, "no work-started date"));
  rows.push(
    span(
      "In progress",
      started,
      testing ?? completed,
      started ? "not out of progress yet" : "no work-started date",
    ),
  );
  rows.push(span("In testing", testing, completed, testing ? "not finished yet" : "no testing date"));

  rows.push(
    span("Lead time (created to complete)", created, completed, "not completed yet"),
  );
  rows.push(
    span(
      "Cycle time (start to complete)",
      started,
      completed,
      started ? "not completed yet" : "no work-started date",
    ),
  );

  if (!due) {
    rows.push({ label: "Due", value: "—", note: "no due date" });
  } else if (completed) {
    const late = dayDiff(due, completed) ?? 0;
    rows.push({
      label: "Due",
      value: formatDate(due),
      note: late > 0 ? `finished ${describeDays(late)} late` : `finished ${describeDays(-late)} early`,
      alert: late > 0,
    });
  } else {
    const diff = dayDiff(todayStr, due) ?? 0;
    rows.push({
      label: "Due",
      value: formatDate(due),
      note: diff < 0 ? `${describeDays(diff)} overdue` : `in ${describeDays(diff)}`,
      alert: diff < 0,
    });
  }

  const done = card.subtasks.filter((s) => s.done).length;
  rows.push({
    label: "Subtasks",
    value: card.subtasks.length === 0 ? "None" : `${done} of ${card.subtasks.length} done`,
  });

  rows.push({
    label: "Tags",
    value: card.tagIds.length === 0 ? "None" : String(card.tagIds.length),
    note:
      card.tagIds.length === 0
        ? undefined
        : card.tagIds
            .map((id) => getTag(id)?.name)
            .filter((n): n is string => !!n)
            .join(", "),
  });

  return rows;
}

/** Which card the stats sheet is about. Tracked separately from openCardId,
 *  which the card modal clears when its own close finishes: a handoff close
 *  skips the tab reset but still runs onClosed, so by the time the stats sheet
 *  is on screen openCardId is already null and Back would have nothing to
 *  return to. */
let statsCardId: string | null = null;

function getCardStatsModal(): Modal {
  if (!_cardStatsModal) {
    _cardStatsModal = new Modal(document.getElementById("kbCardStatsBackdrop")!, {
      closeOnEsc: true,
      onClosed: () => {
        statsCardId = null;
      },
    });
    document
      .getElementById("kbCardStatsClose")!
      .addEventListener("click", () => _cardStatsModal!.close());
    document.getElementById("kbCardStatsBack")!.addEventListener("click", () => {
      const back = statsCardId;
      _cardStatsModal!.close({ handoff: true });
      if (back) openCard(back);
    });
  }
  return _cardStatsModal;
}

function openCardStats(card: Card): void {
  statsCardId = card.id;
  document.getElementById("kbCardStatsTitle")!.textContent = `Card #${card.number} Stats`;
  const body = document.getElementById("kbCardStatsBody")!;
  body.replaceChildren();

  const heading = document.createElement("p");
  heading.className = "kb-stats-heading";
  heading.textContent = card.title || "Untitled";
  body.appendChild(heading);

  body.appendChild(buildStatTable(computeCardStats(card, today())));

  const warning = stageOrderWarning(card);
  if (warning) {
    const note = document.createElement("p");
    note.className = "subhint kb-stat-alert";
    note.textContent = `These dates disagree with each other: ${warning}. Fix them on the card and the numbers above correct themselves.`;
    body.appendChild(note);
  }

  // Handoff so the card modal does not reset its own chrome on the way out.
  // It DOES still run its onClosed hook a moment later (handoff only skips the
  // tab reset), which is exactly why the back arrow reads statsCardId above
  // rather than openCardId: that one is already null by the time you press it.
  getCardModal().close({ handoff: true });
  getCardStatsModal().open();
}

function buildStatTable(rows: StatRow[]): HTMLElement {
  const table = document.createElement("div");
  table.className = "kb-stat-table";
  for (const row of rows) {
    const line = document.createElement("div");
    line.className = "kb-stat-row";

    const label = document.createElement("span");
    label.className = "kb-stat-label";
    label.textContent = row.label;
    line.appendChild(label);

    const value = document.createElement("span");
    value.className = "kb-stat-value";
    if (row.alert) value.classList.add("kb-stat-alert");
    value.textContent = row.value;
    line.appendChild(value);

    const note = document.createElement("span");
    note.className = "kb-stat-note";
    note.textContent = row.note ?? "";
    line.appendChild(note);

    table.appendChild(line);
  }
  return table;
}

/* =============================================================================
   BOARD STATS
============================================================================= */

/** Median rather than only the mean, because a single card that sat in a
 *  backlog for eight months drags an average somewhere no real card has ever
 *  been. Both are shown; where they disagree, that disagreement is itself the
 *  useful signal. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function computeBoardStats(board: Board, todayStr: string): StatRow[] {
  const live = liveCardsOnBoard(board.id);
  const archived = archivedCardsOnBoard(board.id);
  const all = [...live, ...archived];
  const rows: StatRow[] = [];

  const doneColumns = new Set(board.columns.filter((c) => c.isDone).map((c) => c.id));
  const inDone = live.filter((c) => doneColumns.has(c.columnId)).length;
  const started = live.filter((c) => furthestStage(c) >= 0 && !c.dates.completed).length;
  const overdue = live.filter((c) => isOverdue(c, todayStr)).length;
  const dueSoon = live.filter((c) => {
    if (!c.dates.due || c.dates.completed) return false;
    const diff = dayDiff(todayStr, c.dates.due);
    return diff !== null && diff >= 0 && diff <= 7;
  }).length;

  rows.push({ label: "Cards on the board", value: String(live.length) });
  rows.push({ label: "In a done column", value: String(inDone) });
  rows.push({ label: "Started, not finished", value: String(started) });
  rows.push({ label: "Overdue", value: String(overdue), alert: overdue > 0 });
  rows.push({ label: "Due in the next 7 days", value: String(dueSoon) });
  rows.push({ label: "Archived", value: String(archived.length) });

  // Throughput counts COMPLETED STAMPS, not the done column: a card can sit in
  // Done for a month, and "finished this week" has to mean the week it was
  // finished in.
  const completed = all.filter((c) => c.dates.completed);
  const within = (days: number): number =>
    completed.filter((c) => {
      const diff = dayDiff(c.dates.completed, todayStr);
      return diff !== null && diff >= 0 && diff <= days;
    }).length;

  rows.push({ label: "Completed in the last 7 days", value: String(within(7)) });
  rows.push({ label: "Completed in the last 30 days", value: String(within(30)) });
  rows.push({ label: "Completed all time", value: String(completed.length) });

  const leadTimes = completed
    .map((c) => dayDiff(createdDay(c), c.dates.completed))
    .filter((n): n is number => n !== null && n >= 0);
  const cycleTimes = completed
    .map((c) => dayDiff(c.dates.started, c.dates.completed))
    .filter((n): n is number => n !== null && n >= 0);

  const describeSet = (label: string, values: number[], missing: string): StatRow => {
    const m = median(values);
    const a = mean(values);
    if (m === null || a === null) return { label, value: "—", note: missing };
    return {
      label,
      value: describeDays(Math.round(m)),
      note: `median of ${values.length}; mean ${describeDays(Math.round(a))}`,
    };
  };

  rows.push(
    describeSet("Lead time", leadTimes, "no card has both a created and a completed date"),
  );
  rows.push(
    describeSet("Cycle time", cycleTimes, "no card has both a work-started and a completed date"),
  );

  const openCards = live.filter((c) => !c.dates.completed);
  const oldest = openCards.reduce<Card | null>(
    (acc, c) => (acc === null || c.createdAt < acc.createdAt ? c : acc),
    null,
  );
  rows.push({
    label: "Oldest card still open",
    value: oldest ? `#${oldest.number}` : "—",
    note: oldest
      ? `${oldest.title || "Untitled"} · ${describeDays(dayDiff(createdDay(oldest), todayStr) ?? 0)} old`
      : "nothing open",
  });

  const overLimit = board.columns.filter(
    (col) => col.wipLimit !== null && live.filter((c) => c.columnId === col.id).length > col.wipLimit,
  );
  rows.push({
    label: "Columns over their WIP limit",
    value: String(overLimit.length),
    note: overLimit.length === 0 ? undefined : overLimit.map((c) => c.title).join(", "),
    alert: overLimit.length > 0,
  });

  return rows;
}

function getBoardStatsModal(): Modal {
  if (!_boardStatsModal) {
    _boardStatsModal = new Modal(document.getElementById("kbBoardStatsBackdrop")!, {
      closeOnEsc: true,
    });
    document
      .getElementById("kbBoardStatsClose")!
      .addEventListener("click", () => _boardStatsModal!.close());
  }
  return _boardStatsModal;
}

function openBoardStats(board: Board): void {
  const todayStr = today();
  document.getElementById("kbBoardStatsTitle")!.textContent = `${board.name} · Stats`;
  const body = document.getElementById("kbBoardStatsBody")!;
  body.replaceChildren();

  body.appendChild(buildStatTable(computeBoardStats(board, todayStr)));

  /* Per-column breakdown. A table rather than more stat rows, because the
     comparison between columns is the whole point of it. */
  const live = liveCardsOnBoard(board.id);
  const colHeading = document.createElement("p");
  colHeading.className = "kb-stats-heading";
  colHeading.textContent = "Columns";
  body.appendChild(colHeading);

  const table = document.createElement("div");
  table.className = "kb-stat-table";
  for (const column of board.columns) {
    const count = live.filter((c) => c.columnId === column.id).length;
    const over = column.wipLimit !== null && count > column.wipLimit;
    const line = document.createElement("div");
    line.className = "kb-stat-row";

    const label = document.createElement("span");
    label.className = "kb-stat-label";
    label.textContent = column.title + (column.isDone ? " (done)" : "");
    line.appendChild(label);

    const value = document.createElement("span");
    value.className = "kb-stat-value";
    if (over) value.classList.add("kb-stat-alert");
    value.textContent = column.wipLimit === null ? String(count) : `${count} / ${column.wipLimit}`;
    line.appendChild(value);

    const note = document.createElement("span");
    note.className = "kb-stat-note";
    note.textContent = over ? "over the limit" : column.wipLimit === null ? "no limit" : "";
    line.appendChild(note);

    table.appendChild(line);
  }
  body.appendChild(table);

  /* Tag spread. Only tags that are actually in use, most-used first, so this
     stays a picture of the board rather than a list of the tag vocabulary. */
  const counts = new Map<string, number>();
  for (const card of live) {
    for (const id of card.tagIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  if (counts.size > 0) {
    const tagHeading = document.createElement("p");
    tagHeading.className = "kb-stats-heading";
    tagHeading.textContent = "Tags in use";
    body.appendChild(tagHeading);

    const tagWrap = document.createElement("div");
    tagWrap.className = "kb-stats-tags";
    const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    for (const [tagId, count] of ordered) {
      const tag = getTag(tagId);
      if (!tag) continue;
      const wrap = document.createElement("span");
      wrap.className = "kb-stats-tag";
      wrap.appendChild(buildTagChip(tag, board.tagCategories, { showCategory: true }));
      const n = document.createElement("span");
      n.className = "kb-stats-tag-count";
      n.textContent = `× ${count}`;
      wrap.appendChild(n);
      tagWrap.appendChild(wrap);
    }
    body.appendChild(tagWrap);
  }

  getBoardStatsModal().open();
}

/* =============================================================================
   ARCHIVE
============================================================================= */

let archiveBoardId: string | null = null;

function getArchiveModal(): Modal {
  if (!_archiveModal) {
    _archiveModal = new Modal(document.getElementById("kbArchiveBackdrop")!, {
      closeOnEsc: true,
      onClosed: () => {
        archiveBoardId = null;
        renderAll();
      },
    });
    document
      .getElementById("kbArchiveClose")!
      .addEventListener("click", () => _archiveModal!.close());
  }
  return _archiveModal;
}

function openArchive(board: Board): void {
  archiveBoardId = board.id;
  document.getElementById("kbArchiveTitle")!.textContent = `${board.name} · Archived Cards`;
  renderArchiveList();
  getArchiveModal().open();
}

function renderArchiveList(): void {
  const board = getBoard(archiveBoardId);
  const list = document.getElementById("kbArchiveList")!;
  list.replaceChildren();
  if (!board) return;

  const archived = archivedCardsOnBoard(board.id);
  if (archived.length === 0) {
    const empty = document.createElement("p");
    empty.className = "placeholder-text";
    empty.textContent = "Nothing archived on this board.";
    list.appendChild(empty);
    return;
  }

  for (const card of archived) {
    const row = document.createElement("div");
    row.className = "setup-item kb-archive-row";

    const name = document.createElement("span");
    name.className = "setup-item-name";
    name.textContent = `#${card.number}  ${card.title || "Untitled"}`;
    row.appendChild(name);

    const where = document.createElement("span");
    where.className = "setup-item-count";
    const column = getColumn(board, card.columnId);
    where.textContent = column ? column.title : "no column";
    row.appendChild(where);

    /** Puts the card back, optionally into a chosen column. Without one it
     *  goes to the column it left from, or the first column if that column has
     *  been deleted while it was away. */
    const restoreCard = (columnId?: string): void => {
      card.archived = false;
      if (columnId) card.columnId = columnId;
      else if (!getColumn(board, card.columnId) && board.columns.length > 0) {
        card.columnId = board.columns[0].id;
      }
      card.order = -1;
      resequence(board.id);
      stampCard(card);
      renderArchiveList();
      flash(`#${card.number} is back on the board.`);
    };

    const restore = document.createElement("button");
    restore.type = "button";
    restore.className = "settings-action-btn";
    restore.textContent = "Restore";
    restore.addEventListener("click", () => restoreCard());
    row.appendChild(restore);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger-btn";
    remove.textContent = "Delete";
    remove.addEventListener("click", () => {
      kbConfirm(
        {
          title: `Delete card #${card.number}?`,
          message: `"${card.title || "Untitled"}" goes for good. Restoring it to the board is still an option until you do this.`,
          confirmLabel: "Delete",
          reopen: () => openArchive(board),
        },
        () => {
          deleteCard(card);
          // The archive was replaced by the confirm, so it is reopened rather
          // than re-rendered in place.
          openArchive(board);
        },
      );
    });
    row.appendChild(remove);

    // Restore and Delete are already buttons on the row; the menu is here for
    // "Restore to Column", which otherwise means restoring and then dragging.
    attachMenu(row, () => [
      { label: "Restore to Board", onClick: () => restoreCard() },
      ...(board.columns.length > 0
        ? [
            {
              label: "Restore to Column",
              submenu: board.columns.map((col) => ({
                label: col.title,
                onClick: () => restoreCard(col.id),
              })),
            },
          ]
        : []),
      { label: "Delete Permanently", danger: true, onClick: () => remove.click() },
    ]);

    list.appendChild(row);
  }
}

/* =============================================================================
   NEW BOARD
   -----------------------------------------------------------------------------
   The one board form with a Create button, because it is the one moment where
   the board does not exist yet. Everything after this is edited live in Board
   Setup.
============================================================================= */

function getNewBoardModal(): Modal {
  if (_newBoardModal) return _newBoardModal;

  const nameInput = document.getElementById("kbNewBoardNameInput") as HTMLInputElement;
  const descInput = document.getElementById("kbNewBoardDescInput") as HTMLInputElement;

  _newBoardModal = new Modal(document.getElementById("kbNewBoardBackdrop")!, {
    closeOnEsc: true,
    onOpen: () => setTimeout(() => nameInput.focus(), 50),
  });

  const create = (): void => {
    const name = nameInput.value.trim();
    if (!name) {
      flash("A board needs a name.", "error");
      return;
    }
    const now = Date.now();
    const board: Board = {
      id: newId(),
      name: name.slice(0, 120),
      description: descInput.value.trim().slice(0, 300),
      columns: defaultColumns(),
      background: null,
      nextCardNumber: 1,
      // A new board starts with NO tags of its own. Board Setup > Tags copies
      // the defaults in on request; doing it automatically would push every
      // board's version numbers onto every other board, which is the exact
      // thing the per-board vocabulary exists to stop.
      tagCategories: [],
      tags: [],
      overrides: {},
      createdAt: now,
      updatedAt: now,
      // Open by definition: it has no contents to be locked out of, and
      // encrypting it is a later, deliberate act.
      locked: false,
    };
    boards.push(board);
    markBoard(board.id);
    _newBoardModal!.close();
    // A board you just made is a board you want to be standing in.
    showKbView("board", board.id);
    flash("Board created.");
  };

  document.getElementById("kbNewBoardCreateBtn")!.addEventListener("click", create);
  for (const id of ["kbNewBoardCancelBtn", "kbNewBoardClose"]) {
    document.getElementById(id)!.addEventListener("click", () => _newBoardModal!.close());
  }
  for (const el of [nameInput, descInput]) {
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        create();
      }
    });
  }

  return _newBoardModal;
}

function openNewBoard(): void {
  (document.getElementById("kbNewBoardNameInput") as HTMLInputElement).value =
    kbSettings.defaultBoardName;
  (document.getElementById("kbNewBoardDescInput") as HTMLInputElement).value = "";
  getNewBoardModal().open();
}

/* =============================================================================
   BOARD SETUP
   -----------------------------------------------------------------------------
   One board's own settings: what it is, its tag vocabulary, and the preferences
   it disagrees with the defaults about.

   Everything applies as it is changed. There is no draft and therefore no
   orphaned background image to clean up on cancel: picking an image replaces
   the board's background then and there, and the file it replaced is deleted at
   that moment because nothing points at it any more.
============================================================================= */

type KbBoardSetupTab = "board" | "tags" | "preferences";

let boardEditId: string | null = null;
let _boardSetupTabs: ModalTabs<KbBoardSetupTab> | null = null;

function getBoardSetupTabs(): ModalTabs<KbBoardSetupTab> {
  if (!_boardSetupTabs) {
    _boardSetupTabs = new ModalTabs<KbBoardSetupTab>({
      scope: "#kbBoardSetupModal",
      key: "kbBoardTab",
      panes: {
        board: "kbBoardTabBoard",
        tags: "kbBoardTabTags",
        preferences: "kbBoardTabPreferences",
      },
      onActivate: (tab) => {
        if (tab === "board") renderBoardSetupBoardTab();
        if (tab === "tags") {
          tagEditScope = "board";
          tagEditBoardId = boardEditId;
          renderBoardTagList();
        }
        if (tab === "preferences") renderBoardPrefs();
      },
    });
  }
  return _boardSetupTabs;
}

function getBoardSetupModal(): Modal {
  if (_boardSetupModal) return _boardSetupModal;

  const nameInput = document.getElementById("kbBoardNameInput") as HTMLInputElement;
  const descInput = document.getElementById("kbBoardDescInput") as HTMLInputElement;
  const blurRange = document.getElementById("kbBoardBlurRange") as HTMLInputElement;
  const brightRange = document.getElementById("kbBoardBrightnessRange") as HTMLInputElement;

  _boardSetupModal = new Modal(document.getElementById("kbBoardSetupBackdrop")!, {
    closeOnEsc: true,
    tabs: getBoardSetupTabs(),
    onClosed: () => {
      boardEditId = null;
      renderAll();
    },
  });

  const withBoard = (fn: (board: Board) => void) => () => {
    const board = getBoard(boardEditId);
    if (board) fn(board);
  };

  nameInput.addEventListener(
    "input",
    withBoard((board) => {
      board.name = nameInput.value.slice(0, 120) || board.name;
      board.updatedAt = Date.now();
      markIndex();
      document.getElementById("kbBoardSetupTitle")!.textContent = `${board.name} · Setup`;
    }),
  );

  descInput.addEventListener(
    "input",
    withBoard((board) => {
      board.description = descInput.value.slice(0, 300);
      board.updatedAt = Date.now();
      markIndex();
    }),
  );

  document.getElementById("kbBoardSetupBack")!.addEventListener("click", () => {
    _boardSetupModal!.close();
  });
  document
    .getElementById("kbBoardSetupClose")!
    .addEventListener("click", () => _boardSetupModal!.close());

  document.getElementById("kbBoardBgPickBtn")!.addEventListener("click", () => {
    void pickBoardBackground();
  });
  document.getElementById("kbBoardBgClearBtn")!.addEventListener(
    "click",
    withBoard((board) => {
      const old = board.background?.path ?? null;
      board.background = null;
      if (old) void invoke("delete_kanban_image", { path: old }).catch(() => {});
      board.updatedAt = Date.now();
      markIndex();
      renderBoardBgPreview();
    }),
  );

  const onSlide = withBoard((board) => {
    if (!board.background) {
      renderBoardBgPreview();
      return;
    }
    board.background.blur = clampInt(blurRange.value, 0, 24, 0);
    board.background.brightness = clampInt(brightRange.value, 15, 150, 100);
    board.updatedAt = Date.now();
    markIndex();
    renderBoardBgPreview();
  });
  blurRange.addEventListener("input", onSlide);
  brightRange.addEventListener("input", onSlide);

  const encryptToggle = document.getElementById("kbBoardEncryptToggle") as HTMLInputElement;
  encryptToggle.addEventListener("change", () => {
    const board = getBoard(boardEditId);
    if (!board) return;
    // The switch is put back to what the FILES say straight away, and only
    // moves for real once the backend confirms. A toggle that showed
    // "encrypted" because it had been clicked would be the worst possible lie
    // this tool could tell.
    const wanted = encryptToggle.checked;
    encryptToggle.checked = encryptedBoardIds.has(board.id);
    void (wanted ? encryptBoard(board) : decryptBoardToPlain(board)).then(() => {
      renderBoardSetupBoardTab();
      renderSecurityTab();
    });
  });

  document.getElementById("kbBoardCopyDefaultTagsBtn")!.addEventListener(
    "click",
    withBoard((board) => copyDefaultTagsToBoard(board)),
  );
  document.getElementById("kbBoardNewTagCategoryBtn")!.addEventListener(
    "click",
    withBoard((board) => openTagCategoryEditor(null, "board", board)),
  );

  document.getElementById("kbBoardResetPrefsBtn")!.addEventListener(
    "click",
    withBoard((board) => {
      if (Object.keys(board.overrides).length === 0) {
        flash("This board already follows every default.");
        return;
      }
      board.overrides = {};
      markBoard(board.id);
      renderBoardPrefs();
      flash("This board follows the defaults again.");
    }),
  );

  document.getElementById("kbBoardEditDelete")!.addEventListener("click", () => {
    const board = getBoard(boardEditId);
    if (!board) return;
    const count = cards.filter((c) => c.boardId === board.id).length;
    kbConfirm(
      {
        title: `Delete "${board.name}"?`,
        message:
          count === 0
            ? "The board, its columns and its tags go for good."
            : `The board, its ${board.columns.length} column(s), its tags and all ${count} of its cards go for good, archived ones included. Export from Setup > Data first if you want a copy.`,
        confirmLabel: "Delete Board",
        reopen: () => openBoardSetup(board, "board"),
      },
      () => deleteBoard(board),
    );
  });

  return _boardSetupModal;
}

function openBoardSetup(board: Board, tab: KbBoardSetupTab = "board"): void {
  boardEditId = board.id;
  tagEditScope = "board";
  tagEditBoardId = board.id;
  document.getElementById("kbBoardSetupTitle")!.textContent = `${board.name} · Setup`;
  getBoardSetupTabs().select(tab);
  getBoardSetupModal().open();
}

function renderBoardSetupBoardTab(): void {
  const board = getBoard(boardEditId);
  if (!board) return;
  (document.getElementById("kbBoardNameInput") as HTMLInputElement).value = board.name;
  (document.getElementById("kbBoardDescInput") as HTMLInputElement).value = board.description;
  (document.getElementById("kbBoardBlurRange") as HTMLInputElement).value = String(
    board.background?.blur ?? 0,
  );
  (document.getElementById("kbBoardBrightnessRange") as HTMLInputElement).value = String(
    board.background?.brightness ?? 100,
  );
  renderBoardBgPreview();

  const on = encryptedBoardIds.has(board.id);
  (document.getElementById("kbBoardEncryptToggle") as HTMLInputElement).checked = on;
  document.getElementById("kbBoardEncryptLabel")!.textContent = on ? "Yes" : "No";
}

function renderBoardBgPreview(): void {
  const board = getBoard(boardEditId);
  const bg = board?.background ?? null;
  const img = document.getElementById("kbBoardBgPreviewImg")!;
  const empty = document.getElementById("kbBoardBgPreviewEmpty")!;

  const blur = bg?.blur ?? 0;
  const brightness = bg?.brightness ?? 100;
  document.getElementById("kbBoardBlurValue")!.textContent = `${blur}px`;
  document.getElementById("kbBoardBrightnessValue")!.textContent = `${brightness}%`;

  if (!bg) {
    img.style.display = "none";
    img.style.removeProperty("background-image");
    empty.style.display = "";
    return;
  }
  img.style.display = "";
  img.style.backgroundImage = `url("${convertFileSrc(bg.path)}")`;
  img.style.filter = `blur(${blur}px) brightness(${brightness}%)`;
  img.style.transform = `scale(${1 + blur / 90})`;
  empty.style.display = "none";
}

async function pickBoardBackground(): Promise<void> {
  const board = getBoard(boardEditId);
  if (!board) return;

  const picked = await openDialog({
    multiple: false,
    directory: false,
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }],
  });
  if (typeof picked !== "string") return;

  try {
    const stored = await invoke<string>("import_kanban_image", { path: picked });
    // The blur and brightness already dialled in survive a swap of the image:
    // changing the picture is not changing how it is treated.
    const previous = board.background;
    board.background = {
      path: stored,
      blur: previous?.blur ?? 0,
      brightness: previous?.brightness ?? 100,
    };
    // Nothing points at the old file any more, so it goes now rather than
    // accumulating in the data folder for the life of the install.
    if (previous?.path) {
      void invoke("delete_kanban_image", { path: previous.path }).catch(() => {});
    }
    board.updatedAt = Date.now();
    markIndex();
    renderBoardBgPreview();
  } catch (err) {
    flash(String(err), "error", 8000);
  }
}

/* -----------------------------------------------------------------------------
   PER-BOARD PREFERENCE OVERRIDES
   -----------------------------------------------------------------------------
   Three states per row, not two: Default, On, Off. That third state is the
   whole feature. A board left on Default keeps following the default when the
   default changes later; a board pinned to On stays On regardless. Storing only
   what a board actually disagrees about is what makes that possible, so a row
   set back to Default DELETES the key rather than writing the current default
   into it.
----------------------------------------------------------------------------- */

interface OverrideRow {
  key: keyof BoardScopedSettings;
  label: string;
  info: string;
}

const BOARD_OVERRIDE_ROWS: OverrideRow[] = [
  { key: "showTags", label: "Show Tags on Cards", info: "Tag chips on the card face." },
  {
    key: "showSubtasks",
    label: "Show Subtask Progress on Cards",
    info: "The progress bar and the done/total count on the card face.",
  },
  {
    key: "showDates",
    label: "Show Dates on Cards",
    info: "The due chip and the stage chip on the card face.",
  },
  { key: "showNumbers", label: "Show Card Numbers", info: "The #12 handle on the card face." },
  {
    key: "showCardDelete",
    label: "Show a Delete Button on Cards",
    info: "A small bin in the corner of every card on this board.",
  },
  {
    key: "showStages",
    label: "Stage Dates",
    info: "The Work Started / Testing Started / Completed dates and the button that stamps them.",
  },
  {
    key: "showDue",
    label: "Due Date",
    info: "The due date block and the due chip on the card face. Separate from stage dates. Off also means this board's cards never count as overdue.",
  },
  {
    key: "confirmDelete",
    label: "Confirm Before Deleting a Card",
    info: "Whether deleting a card on this board asks first.",
  },
  {
    key: "autoCompleteOnDone",
    label: "Stamp Complete on Drop into a Done Column",
    info: "Only does anything when this board has a column marked as meaning done.",
  },
];

function renderBoardPrefs(): void {
  const board = getBoard(boardEditId);
  const list = document.getElementById("kbBoardPrefsList")!;
  list.replaceChildren();
  if (!board) return;

  for (const row of BOARD_OVERRIDE_ROWS) {
    list.appendChild(buildOverrideRow(board, row));
  }

  // The two non-boolean settings, same three-state rule.
  list.appendChild(
    buildOverrideSelect(board, "cardSize", "Card Size", [
      { value: "comfortable", label: "Comfortable" },
      { value: "compact", label: "Compact" },
    ]),
  );
  list.appendChild(
    buildOverrideSelect(board, "cardColorMode", "Card Color From", [
      { value: "manual", label: "A color set on the card" },
      { value: "tag", label: "Its top tag" },
      { value: "priority", label: "Its priority" },
    ]),
  );

  // Card layout: a whole ordered list rather than one value, so it gets its own
  // "follow the default" switch instead of a three-state select.
  const layout = document.createElement("div");
  layout.className = "settings-row";
  const layoutLabel = document.createElement("span");
  layoutLabel.className = "kb-label-with-info";
  layoutLabel.textContent = "Card Layout";
  layout.appendChild(layoutLabel);

  const layoutBtn = document.createElement("button");
  layoutBtn.type = "button";
  layoutBtn.className = "settings-action-btn";
  const custom = board.overrides.sectionOrder !== undefined;
  layoutBtn.textContent = custom ? "Follow the default" : "Set for this board";
  layoutBtn.addEventListener("click", () => {
    if (custom) delete board.overrides.sectionOrder;
    else board.overrides.sectionOrder = [...effective(board).sectionOrder];
    markBoard(board.id);
    renderBoardPrefs();
  });
  layout.appendChild(layoutBtn);
  list.appendChild(layout);

  const orderHost = document.createElement("div");
  orderHost.className = "kb-section-order";
  if (custom) {
    renderSectionOrderInto(orderHost, board.overrides.sectionOrder!, () => {
      markBoard(board.id);
      renderBoardPrefs();
    });
  } else {
    const note = document.createElement("span");
    note.className = "kb-section-note";
    note.textContent = `Following the default: ${effective(null)
      .sectionOrder.map((sec) => CARD_SECTION_LABELS[sec])
      .join(" · ")}`;
    orderHost.appendChild(note);
  }
  list.appendChild(orderHost);
}

/** One three-state boolean row. */
function buildOverrideRow(board: Board, row: OverrideRow): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "settings-row";

  const label = document.createElement("span");
  label.className = "kb-label-with-info";
  label.textContent = row.label;
  const info = document.createElement("button");
  info.type = "button";
  info.className = "info-trigger-btn kb-info-btn";
  info.textContent = "ℹ";
  info.title = row.info;
  info.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleInfoTooltip(info, row.info);
  });
  label.appendChild(info);
  wrap.appendChild(label);

  const select = document.createElement("select");
  select.className = "settings-select kb-override-select";
  const defaultValue = kbSettings[row.key] as boolean;
  const options: { value: string; label: string }[] = [
    { value: "default", label: `Default (${defaultValue ? "On" : "Off"})` },
    { value: "on", label: "On" },
    { value: "off", label: "Off" },
  ];
  for (const option of options) {
    const el = document.createElement("option");
    el.value = option.value;
    el.textContent = option.label;
    select.appendChild(el);
  }
  const current = board.overrides[row.key] as boolean | undefined;
  select.value = current === undefined ? "default" : current ? "on" : "off";
  if (current !== undefined) wrap.classList.add("kb-override-set");

  select.addEventListener("change", () => {
    if (select.value === "default") delete board.overrides[row.key];
    else {
      (board.overrides as Record<string, unknown>)[row.key] = select.value === "on";
    }
    markBoard(board.id);
    renderBoardPrefs();
  });
  wrap.appendChild(select);
  return wrap;
}

/** One three-state enum row. */
function buildOverrideSelect(
  board: Board,
  key: "cardSize" | "cardColorMode",
  label: string,
  choices: { value: string; label: string }[],
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "settings-row";

  const name = document.createElement("span");
  name.textContent = label;
  wrap.appendChild(name);

  const select = document.createElement("select");
  select.className = "settings-select kb-override-select";
  const defaultLabel =
    choices.find((c) => c.value === kbSettings[key])?.label ?? String(kbSettings[key]);
  const defaultOption = document.createElement("option");
  defaultOption.value = "default";
  defaultOption.textContent = `Default (${defaultLabel})`;
  select.appendChild(defaultOption);
  for (const choice of choices) {
    const el = document.createElement("option");
    el.value = choice.value;
    el.textContent = choice.label;
    select.appendChild(el);
  }
  const current = board.overrides[key];
  select.value = current === undefined ? "default" : current;
  if (current !== undefined) wrap.classList.add("kb-override-set");

  select.addEventListener("change", () => {
    if (select.value === "default") delete board.overrides[key];
    else (board.overrides as Record<string, unknown>)[key] = select.value;
    markBoard(board.id);
    renderBoardPrefs();
  });
  wrap.appendChild(select);
  return wrap;
}

/* -----------------------------------------------------------------------------
   CARD LAYOUT ORDER
   A drag-reorderable list, used both for the global default and for a board's
   override. The array it is handed IS the one it reorders, so the caller only
   has to say what to do afterwards.
----------------------------------------------------------------------------- */

let sectionDragKey: CardSection | null = null;

function renderSectionOrderInto(
  host: HTMLElement,
  order: CardSection[],
  onCommit: () => void,
): void {
  host.replaceChildren();

  for (const section of order) {
    const row = document.createElement("div");
    row.className = "kb-section-order-row";
    row.draggable = true;
    row.dataset.section = section;

    const grip = document.createElement("span");
    grip.className = "kb-column-grip";
    grip.textContent = "⠳";
    row.appendChild(grip);

    const label = document.createElement("span");
    label.className = "kb-section-order-label";
    label.textContent = CARD_SECTION_LABELS[section];
    row.appendChild(label);

    row.addEventListener("dragstart", () => {
      sectionDragKey = section;
      row.classList.add("kb-dragging");
    });
    // Committed on dragend rather than drop, so a release anywhere (on the
    // list, on the padding, outside the window) still lands the new order.
    row.addEventListener("dragend", () => {
      row.classList.remove("kb-dragging");
      sectionDragKey = null;
      const next = Array.from(host.querySelectorAll<HTMLElement>(".kb-section-order-row"))
        .map((el) => el.dataset.section as CardSection)
        .filter((s): s is CardSection => CARD_SECTIONS.includes(s));
      if (next.length !== order.length) return;
      order.splice(0, order.length, ...next);
      onCommit();
    });
    row.addEventListener("dragover", (e) => {
      if (!sectionDragKey || sectionDragKey === section) return;
      e.preventDefault();
      const dragged = host.querySelector<HTMLElement>(
        `.kb-section-order-row[data-section="${CSS.escape(sectionDragKey)}"]`,
      );
      if (!dragged) return;
      const rect = row.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      host.insertBefore(dragged, before ? row : row.nextSibling);
    });

    host.appendChild(row);
  }
}

/* -----------------------------------------------------------------------------
   THE DEFAULT COLUMN SET
   -----------------------------------------------------------------------------
   Stored as one comma-separated string, with an optional "*" marking the column
   that means done. One string rather than an array of objects because that is
   all it is: a list of names and one flag. The editor below turns it into rows
   and back, so the storage stays trivial and the editing stays direct.
----------------------------------------------------------------------------- */

const DONE_MARK = "*";

function defaultColumnTitles(): string[] {
  return kbSettings.defaultColumns
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, MAX_COLUMNS_PER_BOARD);
}

function setDefaultColumnTitles(titles: string[]): void {
  kbSettings.defaultColumns = titles
    // The comma is the separator, so a comma inside a name would silently split
    // that name into two columns the next time this is read back. Stripped on
    // the way in, where it is one column becoming "In Progress Testing" rather
    // than two columns appearing out of nowhere later.
    .map((t) => t.replace(/,/g, " ").trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .slice(0, MAX_COLUMNS_PER_BOARD)
    .join(", ");
  markSettings();
}

/** Whether a stored title carries the done marker, and the title without it. */
function splitDoneMark(title: string): { title: string; isDone: boolean } {
  const isDone = title.endsWith(DONE_MARK);
  return { title: isDone ? title.slice(0, -1).trim() : title, isDone };
}

/** The columns a brand-new board starts with. */
function defaultColumns(): Column[] {
  return defaultColumnTitles().map((raw) => {
    const { title, isDone } = splitDoneMark(raw);
    return {
      id: newId(),
      title: title.slice(0, 80) || "Untitled",
      wipLimit: null,
      isDone,
      collapsed: false,
    };
  });
}

let defaultColumnDragIndex: number | null = null;

/** The Boards tab's column editor: a row per column, reorderable, with exactly
 *  one able to be marked as meaning done. */
function renderDefaultColumns(): void {
  const host = document.getElementById("kbDefaultColumnsList");
  if (!host) return;
  host.replaceChildren();

  const titles = defaultColumnTitles();
  if (titles.length === 0) {
    const empty = document.createElement("p");
    empty.className = "placeholder-text";
    empty.textContent = "No default columns. A new board will start empty.";
    host.appendChild(empty);
    return;
  }

  titles.forEach((raw, index) => {
    const { title, isDone } = splitDoneMark(raw);

    const row = document.createElement("div");
    row.className = "kb-default-column-row";
    row.draggable = true;
    row.dataset.index = String(index);

    const grip = document.createElement("span");
    grip.className = "kb-column-grip";
    grip.textContent = "⠳";
    row.appendChild(grip);

    const name = document.createElement("input");
    name.type = "text";
    name.className = "kb-default-column-name";
    name.value = title;
    name.spellcheck = false;
    name.addEventListener("change", () => {
      const next = defaultColumnTitles();
      next[index] = name.value.trim() + (isDone ? DONE_MARK : "");
      setDefaultColumnTitles(next);
      renderDefaultColumns();
    });
    row.appendChild(name);

    const done = document.createElement("button");
    done.type = "button";
    done.className = "settings-action-btn";
    done.classList.toggle("active", isDone);
    done.textContent = isDone ? "Means done" : "Mark done";
    done.title = "The column throughput is counted from, and the one that can stamp a card complete";
    done.addEventListener("click", () => {
      // Exactly one, so marking a new one unmarks whatever held it. Two "done"
      // columns would make throughput ambiguous and the auto-stamp arbitrary.
      const next = defaultColumnTitles().map((t) => splitDoneMark(t).title);
      if (!isDone) next[index] = next[index] + DONE_MARK;
      setDefaultColumnTitles(next);
      renderDefaultColumns();
    });
    row.appendChild(done);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "kb-icon-btn";
    remove.textContent = "×";
    remove.title = "Remove this default column";
    remove.addEventListener("click", () => {
      const next = defaultColumnTitles();
      next.splice(index, 1);
      setDefaultColumnTitles(next);
      renderDefaultColumns();
    });
    row.appendChild(remove);

    row.addEventListener("dragstart", () => {
      defaultColumnDragIndex = index;
      row.classList.add("kb-dragging");
    });
    row.addEventListener("dragend", () => {
      row.classList.remove("kb-dragging");
      defaultColumnDragIndex = null;
      // Read back from the DOM, so a release anywhere still lands the order.
      const order = Array.from(host.querySelectorAll<HTMLElement>(".kb-default-column-row")).map(
        (el) => Number(el.dataset.index),
      );
      const current = defaultColumnTitles();
      if (order.length !== current.length) return;
      setDefaultColumnTitles(order.map((i) => current[i]));
      renderDefaultColumns();
    });
    row.addEventListener("dragover", (e) => {
      if (defaultColumnDragIndex === null || defaultColumnDragIndex === index) return;
      e.preventDefault();
      const dragged = host.querySelector<HTMLElement>(
        `.kb-default-column-row[data-index="${defaultColumnDragIndex}"]`,
      );
      if (!dragged) return;
      const rect = row.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      host.insertBefore(dragged, before ? row : row.nextSibling);
    });

    host.appendChild(row);
  });
}

/** One color input per priority level. */
function renderPriorityColors(): void {
  const host = document.getElementById("kbPriorityColorsRow");
  if (!host) return;
  host.replaceChildren();

  for (const level of PRIORITIES) {
    // "None" is the absence of a priority, so it has nothing to color.
    if (level === "none") continue;

    const wrap = document.createElement("label");
    wrap.className = "kb-priority-color";

    const input = document.createElement("input");
    input.type = "color";
    input.value = kbSettings.priorityColors[level];
    input.addEventListener("input", () => {
      kbSettings.priorityColors[level] = input.value.toLowerCase();
      markSettings();
      renderAll();
    });
    wrap.appendChild(input);

    const name = document.createElement("span");
    name.textContent = PRIORITY_LABELS[level];
    wrap.appendChild(name);

    host.appendChild(wrap);
  }
}

function deleteBoard(board: Board): void {
  cards = cards.filter((c) => c.boardId !== board.id);
  boards = boards.filter((b) => b.id !== board.id);
  if (board.background) {
    void invoke("delete_kanban_image", { path: board.background.path }).catch(() => {});
  }
  // The board's own file has to go too, or a board deleted from the list leaves
  // its cards on disk forever, still readable and no longer reachable.
  void invoke("delete_kanban_board", { boardId: board.id }).catch((e) =>
    devError("[kanban] board file delete failed", e),
  );
  dirtyBoards.delete(board.id);
  markIndex();
  if (currentBoardId === board.id) showKbView("boards");
  else renderAll();
  flash("Board deleted.");
}

/** Copies a board's shape without its cards. The useful half of "duplicate":
 *  what is worth reusing about a board is its columns, limits and background,
 *  and a copy of forty in-flight cards is just forty cards to delete. */
function duplicateBoardAsTemplate(board: Board): void {
  const now = Date.now();
  const copy: Board = {
    id: newId(),
    name: `${board.name} (copy)`.slice(0, 120),
    description: board.description,
    columns: board.columns.map((c) => ({ ...c, id: newId(), collapsed: false })),
    // The background file is shared rather than copied. Deleting either board
    // would then unlink a file the other still uses, so the copy starts with
    // none and can be given its own.
    background: null,
    nextCardNumber: 1,
    // Copied, since the point of duplicating a board is to reuse its shape and
    // its vocabulary is part of that shape. Fresh ids, so the two diverge from
    // here.
    tagCategories: board.tagCategories.map((c) => ({ ...c, id: newId() })),
    tags: [],
    overrides: { ...board.overrides },
    createdAt: now,
    updatedAt: now,
    locked: false,
  };
  boards.push(copy);
  markBoard(copy.id);
  showKbView("board", copy.id);
  flash("Copied the board's columns into a new board. Give it its own background.");
}

/* =============================================================================
   COLUMN EDITOR
============================================================================= */

let columnEditBoardId: string | null = null;
let columnEditId: string | null = null;

function getColumnEditModal(): Modal {
  if (_columnEditModal) return _columnEditModal;

  const nameInput = document.getElementById("kbColumnNameInput") as HTMLInputElement;
  const wipToggle = document.getElementById("kbColumnWipToggle") as HTMLInputElement;
  const wipField = document.getElementById("kbColumnWipField") as HTMLElement;
  const wipLabel = document.getElementById("kbColumnWipLabel")!;
  const doneToggle = document.getElementById("kbColumnDoneToggle") as HTMLInputElement;
  const doneLabel = document.getElementById("kbColumnDoneLabel")!;

  _columnEditModal = new Modal(document.getElementById("kbColumnEditBackdrop")!, {
    closeOnEsc: true,
    onOpen: () => setTimeout(() => nameInput.focus(), 50),
    onClosed: () => {
      columnEditBoardId = null;
      columnEditId = null;
      renderAll();
    },
  });

  wipToggle.addEventListener("change", () => {
    wipLabel.textContent = wipToggle.checked ? "Yes" : "No";
    wipField.style.maxHeight = wipToggle.checked ? "260px" : "0";
  });
  doneToggle.addEventListener("change", () => {
    doneLabel.textContent = doneToggle.checked ? "Yes" : "No";
  });

  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      saveColumnEditor();
    }
  });

  document.getElementById("kbColumnEditSave")!.addEventListener("click", saveColumnEditor);
  document
    .getElementById("kbColumnEditCancel")!
    .addEventListener("click", () => _columnEditModal!.close());
  document
    .getElementById("kbColumnEditClose")!
    .addEventListener("click", () => _columnEditModal!.close());

  document.getElementById("kbColumnEditDelete")!.addEventListener("click", () => {
    const board = getBoard(columnEditBoardId);
    const column = board ? getColumn(board, columnEditId ?? "") : null;
    if (!board || !column) return;

    const held = cards.filter((c) => c.boardId === board.id && c.columnId === column.id);
    const survivor = board.columns.find((c) => c.id !== column.id);
    const message =
      held.length === 0
        ? "The column is empty, so nothing moves."
        : survivor
          ? `Its ${held.length} card(s) move to "${survivor.title}" rather than being deleted.`
          : `Its ${held.length} card(s) go with it: this is the board's only column, so there is nowhere to move them.`;

    kbConfirm(
      {
        title: `Delete "${column.title}"?`,
        message,
        confirmLabel: "Delete Column",
        reopen: () => openColumnEditor(board, column),
      },
      () => {
        if (survivor) {
          for (const card of held) {
            card.columnId = survivor.id;
            card.order = -1;
          }
        } else {
          cards = cards.filter((c) => !(c.boardId === board.id && c.columnId === column.id));
        }
        board.columns = board.columns.filter((c) => c.id !== column.id);
        resequence(board.id);
        touchBoard(board);
        renderAll();
        flash("Column deleted.");
      },
    );
  });

  return _columnEditModal;
}

function openColumnEditor(board: Board, column: Column | null): void {
  if (!column && board.columns.length >= MAX_COLUMNS_PER_BOARD) {
    flash(`A board holds at most ${MAX_COLUMNS_PER_BOARD} columns.`, "error");
    return;
  }

  columnEditBoardId = board.id;
  columnEditId = column?.id ?? null;

  document.getElementById("kbColumnEditTitle")!.textContent = column
    ? "Edit Column"
    : "New Column";
  (document.getElementById("kbColumnNameInput") as HTMLInputElement).value = column?.title ?? "";

  const wipToggle = document.getElementById("kbColumnWipToggle") as HTMLInputElement;
  const wipInput = document.getElementById("kbColumnWipInput") as HTMLInputElement;
  const hasLimit = (column?.wipLimit ?? null) !== null;
  wipToggle.checked = hasLimit;
  document.getElementById("kbColumnWipLabel")!.textContent = hasLimit ? "Yes" : "No";
  (document.getElementById("kbColumnWipField") as HTMLElement).style.maxHeight = hasLimit
    ? "260px"
    : "0";
  wipInput.value = String(column?.wipLimit ?? 3);

  const doneToggle = document.getElementById("kbColumnDoneToggle") as HTMLInputElement;
  doneToggle.checked = column?.isDone === true;
  document.getElementById("kbColumnDoneLabel")!.textContent = doneToggle.checked ? "Yes" : "No";

  (document.getElementById("kbColumnEditDelete") as HTMLElement).style.display = column
    ? ""
    : "none";

  getColumnEditModal().open();
}

function saveColumnEditor(): void {
  const board = getBoard(columnEditBoardId);
  if (!board) return;

  const title = (document.getElementById("kbColumnNameInput") as HTMLInputElement).value.trim();
  if (!title) {
    flash("A column needs a title.", "error");
    return;
  }

  const wipToggle = document.getElementById("kbColumnWipToggle") as HTMLInputElement;
  const wipInput = document.getElementById("kbColumnWipInput") as HTMLInputElement;
  const doneToggle = document.getElementById("kbColumnDoneToggle") as HTMLInputElement;
  const limit = wipToggle.checked ? clampInt(wipInput.value, 1, 999, 3) : null;

  const existing = columnEditId ? getColumn(board, columnEditId) : null;
  if (existing) {
    existing.title = title.slice(0, 80);
    existing.wipLimit = limit;
    existing.isDone = doneToggle.checked;
  } else {
    board.columns.push({
      id: newId(),
      title: title.slice(0, 80),
      wipLimit: limit,
      isDone: doneToggle.checked,
      collapsed: false,
    });
  }

  touchBoard(board);
  _columnEditModal!.close();
}

/* =============================================================================
   SETUP MODAL
============================================================================= */

type KbSetupTab = "boards" | "tags" | "preferences" | "security" | "data";

let _setupTabs: ModalTabs<KbSetupTab> | null = null;

function getSetupTabs(): ModalTabs<KbSetupTab> {
  if (!_setupTabs) {
    _setupTabs = new ModalTabs<KbSetupTab>({
      scope: "#kbSetupModal",
      key: "kbTab",
      panes: {
        boards: "kbTabBoards",
        tags: "kbTabTags",
        preferences: "kbTabPreferences",
        security: "kbTabSecurity",
        data: "kbTabData",
      },
      onActivate: (tab) => {
        if (tab === "boards") renderDefaultColumns();
        if (tab === "tags") {
          // The tool's Setup always edits the DEFAULTS. A board's own tags are
          // reached from inside that board.
          tagEditScope = "global";
          tagEditBoardId = null;
          renderTagCategoriesList();
        }
        if (tab === "security") renderSecurityTab();
        // The snapshot list is a disk read, so it is fetched when its tab is
        // actually looked at rather than on every open of the modal.
        if (tab === "data") void refreshDataTab();
      },
    });
  }
  return _setupTabs;
}

function getSetupModal(): Modal {
  if (_setupModal) return _setupModal;

  _setupModal = new Modal(document.getElementById("kbSetupBackdrop")!, {
    closeOnEsc: true,
    tabs: getSetupTabs(),
    onOpen: () => {
      applySettingsToForm();
      renderDefaultColumns();
      tagEditScope = "global";
      tagEditBoardId = null;
      renderTagCategoriesList();
      renderSecurityTab();
    },
    onClosed: () => renderAll(),
  });

  document.getElementById("kbSetupClose")!.addEventListener("click", () => _setupModal!.close());
  document.getElementById("kbNewTagCategoryBtn")!.addEventListener("click", () => {
    openTagCategoryEditor(null, "global", null);
  });

  const boardName = document.getElementById("kbDefaultBoardNameInput") as HTMLInputElement;
  boardName.addEventListener("input", () => {
    kbSettings.defaultBoardName = boardName.value.slice(0, 120);
    markSettings();
  });

  document.getElementById("kbAddDefaultColumnBtn")!.addEventListener("click", () => {
    const titles = defaultColumnTitles();
    titles.push("New Column");
    setDefaultColumnTitles(titles);
    renderDefaultColumns();
  });

  document.getElementById("kbResetDefaultColumnsBtn")!.addEventListener("click", () => {
    kbSettings.defaultColumns = SYSTEM_DEFAULT_COLUMNS;
    markSettings();
    renderDefaultColumns();
    flash("Default columns reset.");
  });

  bindPreferenceControls();

  const lockOnOpen = document.getElementById("kbLockOnOpenToggle") as HTMLInputElement;
  lockOnOpen.addEventListener("change", () => {
    if (lockOnOpen.checked && encryptedBoardIds.size === 0) {
      // Nothing to ask for. Refused rather than stored, so the preference can
      // never be on in a state where it silently does nothing.
      lockOnOpen.checked = false;
      flash("Encrypt at least one board first: the gate asks for that password.", "error", 8000);
      return;
    }
    kbSettings.lockOnOpen = lockOnOpen.checked;
    document.getElementById("kbLockOnOpenLabel")!.textContent = lockOnOpen.checked ? "On" : "Off";
    markSettings();
  });

  document.getElementById("kbLockNowBtn")!.addEventListener("click", () => {
    void lockNow().then(() => {
      renderSecurityTab();
      flash("Locked. Encrypted boards are out of memory again.");
    });
  });

  document.getElementById("kbExportBtn")!.addEventListener("click", () => void exportAll());
  document
    .getElementById("kbBackupRefreshBtn")!
    .addEventListener("click", () => void refreshDataTab());

  return _setupModal;
}

function openSetupOnTab(tab?: KbSetupTab): void {
  if (tab) getSetupTabs().select(tab);
  getSetupModal().open();
}

/** The Security tab: what the password situation is, and which boards use it.
 *  The per-board switch itself lives in each board's own settings, so this list
 *  is a read-out plus a shortcut rather than a second place to change things
 *  from. */
function renderSecurityTab(): void {
  const status = document.getElementById("kbSecurityStatus")!;
  const lockBtn = document.getElementById("kbLockNowBtn") as HTMLButtonElement;
  const lockOnOpen = document.getElementById("kbLockOnOpenToggle") as HTMLInputElement;
  const lockLabel = document.getElementById("kbLockOnOpenLabel")!;

  const count = encryptedBoardIds.size;
  status.textContent =
    count === 0
      ? "Not set"
      : `Set · ${count} board${count === 1 ? "" : "s"} encrypted · ${sessionPassword ? "unlocked" : "locked"}`;

  lockBtn.disabled = count === 0 || sessionPassword === null;
  lockOnOpen.checked = kbSettings.lockOnOpen && count > 0;
  lockLabel.textContent = lockOnOpen.checked ? "On" : "Off";

  const list = document.getElementById("kbSecurityBoardsList")!;
  list.replaceChildren();
  if (boards.length === 0) {
    const empty = document.createElement("p");
    empty.className = "placeholder-text";
    empty.textContent = "No boards yet.";
    list.appendChild(empty);
    return;
  }

  for (const board of boards) {
    const row = document.createElement("div");
    row.className = "setup-item";

    const name = document.createElement("span");
    name.className = "setup-item-name";
    name.textContent = board.name;
    row.appendChild(name);

    const state = document.createElement("span");
    state.className = "setup-item-count";
    state.textContent = encryptedBoardIds.has(board.id)
      ? board.locked
        ? "Encrypted · locked"
        : "Encrypted · open"
      : "Not encrypted";
    row.appendChild(state);

    const open = document.createElement("button");
    open.type = "button";
    open.className = "settings-action-btn";
    open.textContent = "Settings";
    open.addEventListener("click", () => {
      _setupModal!.close({ handoff: true });
      openBoardSetup(board, "board");
    });
    row.appendChild(open);

    list.appendChild(row);
  }
}

/* -----------------------------------------------------------------------------
   TAGS
   -----------------------------------------------------------------------------
   The same editors serve two vocabularies, and which one is being edited is
   held in `tagEditScope` rather than duplicated into two sets of near-identical
   modals:

     "global"  the DEFAULTS, in Setup > Tags. Templates. Nothing wears these.
     "board"   one board's own tags, in Board Setup > Tags. What cards wear.

   A board starts with no tags at all and is filled by copying from the
   defaults, after which the two have nothing to do with each other. That is
   deliberate: "Versions" is worth sharing as an axis and its values never are,
   so copying and then diverging is the honest model. Editing a default later
   does not reach into boards that already copied it, and it should not.
----------------------------------------------------------------------------- */

type TagScope = "global" | "board";

let tagEditScope: TagScope = "global";
/** Which board's vocabulary, when the scope is "board". */
let tagEditBoardId: string | null = null;

function tagScopeBoard(): Board | null {
  return tagEditScope === "board" ? getBoard(tagEditBoardId) : null;
}

function scopedCategories(): TagCategory[] {
  return tagScopeBoard()?.tagCategories ?? (tagEditScope === "global" ? globalTagCategories : []);
}

function scopedTagList(): Tag[] {
  return tagScopeBoard()?.tags ?? (tagEditScope === "global" ? globalTags : []);
}

/** Writes the vocabulary that was just edited to the file it lives in. The
 *  defaults are in the index; a board's are in that board's own file, which is
 *  what makes an encrypted board's tag names encrypted too. */
function commitTagScope(): void {
  const board = tagScopeBoard();
  if (board) markBoard(board.id);
  else markIndex();
}

function setScopedCategories(next: TagCategory[]): void {
  const board = tagScopeBoard();
  if (board) board.tagCategories = next;
  else globalTagCategories = next;
}

function setScopedTags(next: Tag[]): void {
  const board = tagScopeBoard();
  if (board) board.tags = next;
  else globalTags = next;
}

/** Re-renders whichever tag list is currently on screen. */
function renderActiveTagList(): void {
  if (tagEditScope === "board") renderBoardTagList();
  else renderTagCategoriesList();
}

/** The defaults, in the tool's own Setup. */
function renderTagCategoriesList(): void {
  renderTagVocabulary(document.getElementById("kbTagCategoriesList")!, "global", null);
}

/** One board's own tags, in Board Setup. */
function renderBoardTagList(): void {
  const el = document.getElementById("kbBoardTagCategoriesList");
  if (!el) return;
  renderTagVocabulary(el, "board", getBoard(boardEditId));
}

function renderTagVocabulary(wrap: HTMLElement, scope: TagScope, board: Board | null): void {
  wrap.replaceChildren();

  const categories = scope === "board" ? (board?.tagCategories ?? []) : globalTagCategories;
  const allTags = scope === "board" ? (board?.tags ?? []) : globalTags;

  if (categories.length === 0) {
    const empty = document.createElement("p");
    empty.className = "placeholder-text";
    empty.textContent =
      scope === "board"
        ? "This board has no tags yet. Copy the defaults in above, or add a category of its own."
        : 'No default tag categories yet. A category is the axis ("Versions", "Areas"); the tags under it are the values a board starts with.';
    wrap.appendChild(empty);
    return;
  }

  for (const category of categories) {
    const block = document.createElement("div");
    block.className = "kb-tagcat";
    if (category.status === "retired") block.classList.add("kb-tagcat-retired");

    const head = document.createElement("div");
    head.className = "kb-tagcat-head";

    const swatch = document.createElement("span");
    swatch.className = "kb-tagcat-swatch";
    if (category.color) swatch.style.background = category.color;
    else swatch.classList.add("kb-tagcat-swatch-none");
    swatch.title = category.color
      ? `Tags here default to ${category.color}`
      : "No category color: a tag here has no color unless it sets one";
    head.appendChild(swatch);

    const name = document.createElement("span");
    name.className = "kb-tagcat-name";
    name.textContent = category.name;
    head.appendChild(name);

    if (category.status === "retired") {
      const badge = document.createElement("span");
      badge.className = "setup-item-retired-badge";
      badge.textContent = "Retired";
      head.appendChild(badge);
    }

    const catTags = allTags.filter((t) => t.categoryId === category.id);
    const count = document.createElement("span");
    count.className = "setup-item-count";
    count.textContent = `${catTags.length} ${catTags.length === 1 ? "tag" : "tags"}`;
    head.appendChild(count);

    /* Rank. A category's position decides where its tags sit on a card and
       which one a tag-colored card takes its color from, so it needs to be
       movable. Buttons rather than a drag: the list is short, the blocks are
       tall enough that a drag would scroll, and "one step up" is the whole
       operation anyone wants here. */
    const index = categories.indexOf(category);
    const rank = document.createElement("span");
    rank.className = "kb-tagcat-rank";

    const up = document.createElement("button");
    up.type = "button";
    up.className = "kb-icon-btn";
    up.textContent = "▲";
    up.title = "Rank this category higher";
    up.disabled = index === 0;
    up.addEventListener("click", () => moveTagCategory(scope, board, category.id, -1));
    rank.appendChild(up);

    const down = document.createElement("button");
    down.type = "button";
    down.className = "kb-icon-btn";
    down.textContent = "▼";
    down.title = "Rank this category lower";
    down.disabled = index === categories.length - 1;
    down.addEventListener("click", () => moveTagCategory(scope, board, category.id, 1));
    rank.appendChild(down);

    head.appendChild(rank);

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "settings-action-btn";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => openTagCategoryEditor(category, scope, board));
    head.appendChild(editBtn);

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "settings-action-btn";
    addBtn.textContent = "+ Tag";
    addBtn.addEventListener("click", () => openTagEditor(null, category.id, scope, board));
    head.appendChild(addBtn);

    block.appendChild(head);

    const chips = document.createElement("div");
    chips.className = "kb-tagcat-tags";
    if (catTags.length === 0) {
      const empty = document.createElement("span");
      empty.className = "kb-section-note";
      empty.textContent = "No tags in this category yet.";
      chips.appendChild(empty);
    }
    for (const tag of catTags) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "kb-tag-toggle kb-tag-edit-chip";
      btn.textContent = tag.name;
      paintTagChip(btn, tagColor(tag, categories), true);
      if (tag.status === "retired") btn.classList.add("kb-tag-chip-retired");
      // Usage only means anything for a board's own tags. A default is a
      // template and is worn by nothing, so counting cards there would always
      // say zero and read as a bug.
      const used =
        scope === "board" ? cards.filter((c) => c.tagIds.includes(tag.id)).length : null;
      btn.title =
        (used === null ? tag.name : `${tag.name}: on ${used} card(s)`) +
        (tag.status === "retired" ? " · retired" : "");
      btn.addEventListener("click", () => openTagEditor(tag, tag.categoryId, scope, board));
      chips.appendChild(btn);
    }
    block.appendChild(chips);
    wrap.appendChild(block);
  }
}

/** Moves one category up or down the rank. */
function moveTagCategory(scope: TagScope, board: Board | null, id: string, delta: number): void {
  const list = scope === "board" ? board?.tagCategories : globalTagCategories;
  if (!list) return;
  const from = list.findIndex((c) => c.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= list.length) return;
  const [moved] = list.splice(from, 1);
  list.splice(to, 0, moved);

  if (scope === "board" && board) markBoard(board.id);
  else markIndex();
  renderTagVocabulary(
    document.getElementById(scope === "board" ? "kbBoardTagCategoriesList" : "kbTagCategoriesList")!,
    scope,
    board,
  );
}

/**
 * Copies the default vocabulary onto a board.
 *
 * Matched by NAME, not by id, and existing entries are left alone. That means
 * pressing this twice is harmless, and that a board which already has its own
 * "Versions" gains the defaults' missing versions rather than a second category
 * called the same thing.
 *
 * The copies get fresh ids, so from this moment the board's vocabulary is its
 * own and editing a default never reaches back into it.
 */
function copyDefaultTagsToBoard(board: Board): void {
  let addedCategories = 0;
  let addedTags = 0;

  for (const source of globalTagCategories) {
    if (source.status === "retired") continue;
    let target = board.tagCategories.find(
      (c) => c.name.toLowerCase() === source.name.toLowerCase(),
    );
    if (!target) {
      // Appended in the order the defaults are ranked in, so a board that
      // copies them in gets that ranking rather than an arbitrary one.
      target = { id: newId(), name: source.name, color: source.color, status: "active" };
      board.tagCategories.push(target);
      addedCategories += 1;
    }
    for (const tag of globalTags.filter((t) => t.categoryId === source.id)) {
      if (tag.status === "retired") continue;
      const exists = board.tags.some(
        (t) => t.categoryId === target!.id && t.name.toLowerCase() === tag.name.toLowerCase(),
      );
      if (exists) continue;
      board.tags.push({
        id: newId(),
        categoryId: target.id,
        name: tag.name,
        color: tag.color,
        status: "active",
      });
      addedTags += 1;
    }
  }

  if (addedCategories === 0 && addedTags === 0) {
    flash("This board already has every default tag.");
    return;
  }
  markBoard(board.id);
  renderBoardTagList();
  flash(`Copied in ${addedCategories} categor(ies) and ${addedTags} tag(s).`);
}

let tagCatEditId: string | null = null;

function getTagCatEditModal(): Modal {
  if (_tagCatEditModal) return _tagCatEditModal;

  const nameInput = document.getElementById("kbTagCatNameInput") as HTMLInputElement;
  const colorToggle = document.getElementById("kbTagCatColorToggle") as HTMLInputElement;

  colorToggle.addEventListener("change", () => {
    document.getElementById("kbTagCatColorLabel")!.textContent = colorToggle.checked ? "Yes" : "No";
    (document.getElementById("kbTagCatColorField") as HTMLElement).style.display =
      colorToggle.checked ? "" : "none";
  });

  _tagCatEditModal = new Modal(document.getElementById("kbTagCatEditBackdrop")!, {
    closeOnEsc: true,
    onOpen: () => setTimeout(() => nameInput.focus(), 50),
    onClosed: () => {
      tagCatEditId = null;
    },
  });

  const back = (): void => {
    _tagCatEditModal!.close({ handoff: true });
    returnToTagList();
  };
  document.getElementById("kbTagCatEditBack")!.addEventListener("click", back);
  document.getElementById("kbTagCatEditCancel")!.addEventListener("click", back);
  document
    .getElementById("kbTagCatEditClose")!
    .addEventListener("click", () => _tagCatEditModal!.close());
  document.getElementById("kbTagCatEditSave")!.addEventListener("click", saveTagCategoryEditor);
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      saveTagCategoryEditor();
    }
  });

  document.getElementById("kbTagCatEditRetire")!.addEventListener("click", () => {
    const category = scopedCategories().find((c) => c.id === tagCatEditId);
    if (!category) return;
    category.status = category.status === "retired" ? "active" : "retired";
    commitTagScope();
    flash(
      category.status === "retired"
        ? "Category retired. Cards keep the tags they already carry."
        : "Category is back in the pickers.",
    );
    back();
  });

  document.getElementById("kbTagCatEditDelete")!.addEventListener("click", () => {
    const category = scopedCategories().find((c) => c.id === tagCatEditId);
    if (!category) return;
    const owned = scopedTagList().filter((t) => t.categoryId === category.id);
    const ownedIds = new Set(owned.map((t) => t.id));
    const affected =
      tagEditScope === "board"
        ? cards.filter((c) => c.tagIds.some((id) => ownedIds.has(id))).length
        : 0;
    kbConfirm(
      {
        title: `Delete "${category.name}"?`,
        message:
          tagEditScope === "board"
            ? `Its ${owned.length} tag(s) go with it, and they come off the ${affected} card(s) carrying them. ` +
              "Retire the category instead if you just want it out of the pickers."
            : `Its ${owned.length} default tag(s) go with it. Boards that already copied them keep their own copies; this only changes what a board would get next time.`,
        confirmLabel: "Delete Category",
        reopen: () => openTagCategoryEditor(category, tagEditScope, tagScopeBoard()),
      },
      () => {
        if (tagEditScope === "board") {
          for (const card of cards) {
            card.tagIds = card.tagIds.filter((id) => !ownedIds.has(id));
          }
          filterTagIds = new Set([...filterTagIds].filter((id) => !ownedIds.has(id)));
        }
        setScopedTags(scopedTagList().filter((t) => t.categoryId !== category.id));
        setScopedCategories(scopedCategories().filter((c) => c.id !== category.id));
        commitTagScope();
        returnToTagList();
        flash("Category deleted.");
      },
    );
  });

  return _tagCatEditModal;
}

/** Reopens whichever Setup modal the tag editor was launched from.
 *
 *  Reads tagEditBoardId rather than boardEditId. Board Setup was closed with a
 *  handoff to open this editor, and a handoff still runs onClosed a moment
 *  later, which clears boardEditId; by the time you press Save it is long gone.
 *  tagEditBoardId belongs to the editor and lives exactly as long as it does. */
function returnToTagList(): void {
  if (tagEditScope === "global") {
    openSetupOnTab("tags");
    return;
  }
  const board = getBoard(tagEditBoardId);
  if (board) openBoardSetup(board, "tags");
}

function openTagCategoryEditor(
  category: TagCategory | null,
  scope: TagScope,
  board: Board | null,
): void {
  tagEditScope = scope;
  tagEditBoardId = board?.id ?? null;
  tagCatEditId = category?.id ?? null;

  document.getElementById("kbTagCatEditTitle")!.textContent = category
    ? scope === "board"
      ? "Edit Board Tag Category"
      : "Edit Default Tag Category"
    : scope === "board"
      ? "New Board Tag Category"
      : "New Default Tag Category";
  (document.getElementById("kbTagCatNameInput") as HTMLInputElement).value = category?.name ?? "";
  const hasColor = !!category?.color;
  const colorToggle = document.getElementById("kbTagCatColorToggle") as HTMLInputElement;
  colorToggle.checked = hasColor;
  document.getElementById("kbTagCatColorLabel")!.textContent = hasColor ? "Yes" : "No";
  (document.getElementById("kbTagCatColorField") as HTMLElement).style.display = hasColor
    ? ""
    : "none";
  (document.getElementById("kbTagCatColorInput") as HTMLInputElement).value =
    category?.color ?? DEFAULT_TAG_COLOR;

  const retire = document.getElementById("kbTagCatEditRetire") as HTMLElement;
  retire.style.display = category ? "" : "none";
  retire.textContent = category?.status === "retired" ? "Reactivate" : "Retire";
  (document.getElementById("kbTagCatEditDelete") as HTMLElement).style.display = category
    ? ""
    : "none";

  if (scope === "board") getBoardSetupModal().close({ handoff: true });
  else getSetupModal().close({ handoff: true });
  getTagCatEditModal().open();
}

function saveTagCategoryEditor(): void {
  const name = (document.getElementById("kbTagCatNameInput") as HTMLInputElement).value.trim();
  const wantsColor = (document.getElementById("kbTagCatColorToggle") as HTMLInputElement).checked;
  const color = wantsColor
    ? normalizeColor(
        (document.getElementById("kbTagCatColorInput") as HTMLInputElement).value,
        DEFAULT_TAG_COLOR,
      )
    : null;
  if (!name) {
    flash("A category needs a name.", "error");
    return;
  }
  const clash = scopedCategories().find(
    (c) => c.id !== tagCatEditId && c.name.toLowerCase() === name.toLowerCase(),
  );
  if (clash) {
    flash(`There is already a category called "${clash.name}".`, "error");
    return;
  }

  const existing = scopedCategories().find((c) => c.id === tagCatEditId);
  if (existing) {
    existing.name = name.slice(0, 80);
    existing.color = color;
  } else {
    scopedCategories().push({ id: newId(), name: name.slice(0, 80), color, status: "active" });
  }
  commitTagScope();
  _tagCatEditModal!.close({ handoff: true });
  returnToTagList();
}

let tagEditId: string | null = null;

function getTagEditModal(): Modal {
  if (_tagEditModal) return _tagEditModal;

  const nameInput = document.getElementById("kbTagNameInput") as HTMLInputElement;
  const colorInput = document.getElementById("kbTagColorInput") as HTMLInputElement;

  _tagEditModal = new Modal(document.getElementById("kbTagEditBackdrop")!, {
    closeOnEsc: true,
    onOpen: () => setTimeout(() => nameInput.focus(), 50),
    onClosed: () => {
      tagEditId = null;
    },
  });

  const modeSelect = document.getElementById("kbTagColorModeSelect") as HTMLSelectElement;

  const refreshPreview = (): void => {
    const preview = document.getElementById("kbTagPreview")!;
    preview.textContent = nameInput.value.trim() || "Tag";
    const own = modeSelect.value === "own";
    colorInput.style.display = own ? "" : "none";
    // Shown as it will actually render: inheriting from a category with no
    // color is a plain chip, and the preview has to say so rather than
    // pretending a color is coming from somewhere.
    const categoryId = (document.getElementById("kbTagCategorySelect") as HTMLSelectElement).value;
    const inherited = scopedCategories().find((c) => c.id === categoryId)?.color ?? null;
    paintTagChip(preview, own ? colorInput.value : inherited, true);
  };
  nameInput.addEventListener("input", refreshPreview);
  colorInput.addEventListener("input", refreshPreview);
  modeSelect.addEventListener("change", refreshPreview);
  document
    .getElementById("kbTagCategorySelect")!
    .addEventListener("change", refreshPreview);

  const back = (): void => {
    _tagEditModal!.close({ handoff: true });
    returnToTagList();
  };
  document.getElementById("kbTagEditBack")!.addEventListener("click", back);
  document.getElementById("kbTagEditCancel")!.addEventListener("click", back);
  document
    .getElementById("kbTagEditClose")!
    .addEventListener("click", () => _tagEditModal!.close());
  document.getElementById("kbTagEditSave")!.addEventListener("click", saveTagEditor);
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      saveTagEditor();
    }
  });

  document.getElementById("kbTagEditRetire")!.addEventListener("click", () => {
    const tag = scopedTagList().find((t) => t.id === tagEditId);
    if (!tag) return;
    tag.status = tag.status === "retired" ? "active" : "retired";
    commitTagScope();
    flash(
      tag.status === "retired"
        ? "Tag retired. Cards already carrying it keep it."
        : "Tag is back in the pickers.",
    );
    back();
  });

  document.getElementById("kbTagEditDelete")!.addEventListener("click", () => {
    const tag = scopedTagList().find((t) => t.id === tagEditId);
    if (!tag) return;
    const used =
      tagEditScope === "board" ? cards.filter((c) => c.tagIds.includes(tag.id)).length : 0;
    kbConfirm(
      {
        title: `Delete "${tag.name}"?`,
        message:
          tagEditScope === "global"
            ? "Boards that already copied this tag keep their own copy; this only changes what a board would get next time."
            : used === 0
              ? "Nothing is carrying this tag, so nothing else changes."
              : `It comes off the ${used} card(s) carrying it. Retire it instead to keep the history and stop offering it.`,
        confirmLabel: "Delete Tag",
        reopen: () => openTagEditor(tag, tag.categoryId, tagEditScope, tagScopeBoard()),
      },
      () => {
        if (tagEditScope === "board") {
          for (const card of cards) card.tagIds = card.tagIds.filter((id) => id !== tag.id);
          filterTagIds.delete(tag.id);
        }
        setScopedTags(scopedTagList().filter((t) => t.id !== tag.id));
        commitTagScope();
        returnToTagList();
        flash("Tag deleted.");
      },
    );
  });

  return _tagEditModal;
}

function openTagEditor(
  tag: Tag | null,
  categoryId: string | null,
  scope: TagScope,
  board: Board | null,
): void {
  tagEditScope = scope;
  tagEditBoardId = board?.id ?? null;

  const categories = scopedCategories();
  if (categories.length === 0) {
    flash("Make a tag category first: a tag has to live in one.", "error");
    return;
  }
  tagEditId = tag?.id ?? null;

  document.getElementById("kbTagEditTitle")!.textContent = tag ? "Edit Tag" : "New Tag";

  const select = document.getElementById("kbTagCategorySelect") as HTMLSelectElement;
  select.replaceChildren();
  for (const category of categories) {
    const option = document.createElement("option");
    option.value = category.id;
    option.textContent =
      category.status === "retired" ? `${category.name} (retired)` : category.name;
    select.appendChild(option);
  }
  const targetCategory = tag?.categoryId ?? categoryId ?? categories[0].id;
  select.value = targetCategory;

  const nameInput = document.getElementById("kbTagNameInput") as HTMLInputElement;
  const colorInput = document.getElementById("kbTagColorInput") as HTMLInputElement;
  const modeSelect = document.getElementById("kbTagColorModeSelect") as HTMLSelectElement;
  nameInput.value = tag?.name ?? "";
  // A NEW tag starts on inherit, which is the answer that keeps a category
  // looking like one thing until somebody deliberately breaks ranks.
  modeSelect.value = tag?.color ? "own" : "inherit";
  colorInput.value =
    tag?.color ?? categories.find((c) => c.id === targetCategory)?.color ?? DEFAULT_TAG_COLOR;
  colorInput.style.display = modeSelect.value === "own" ? "" : "none";

  const preview = document.getElementById("kbTagPreview")!;
  preview.textContent = tag?.name || "Tag";
  paintTagChip(
    preview,
    tag ? tagColor(tag, categories) : (categories.find((c) => c.id === targetCategory)?.color ?? null),
    true,
  );

  const retire = document.getElementById("kbTagEditRetire") as HTMLElement;
  retire.style.display = tag ? "" : "none";
  retire.textContent = tag?.status === "retired" ? "Reactivate" : "Retire";
  (document.getElementById("kbTagEditDelete") as HTMLElement).style.display = tag ? "" : "none";

  if (scope === "board") getBoardSetupModal().close({ handoff: true });
  else getSetupModal().close({ handoff: true });
  getTagEditModal().open();
}

function saveTagEditor(): void {
  const name = (document.getElementById("kbTagNameInput") as HTMLInputElement).value.trim();
  const own = (document.getElementById("kbTagColorModeSelect") as HTMLSelectElement).value === "own";
  const color = own
    ? normalizeColor(
        (document.getElementById("kbTagColorInput") as HTMLInputElement).value,
        DEFAULT_TAG_COLOR,
      )
    : null;
  const categoryId = (document.getElementById("kbTagCategorySelect") as HTMLSelectElement).value;

  if (!name) {
    flash("A tag needs a name.", "error");
    return;
  }
  if (!scopedCategories().some((c) => c.id === categoryId)) {
    flash("Pick a category for this tag.", "error");
    return;
  }
  const clash = scopedTagList().find(
    (t) =>
      t.id !== tagEditId &&
      t.categoryId === categoryId &&
      t.name.toLowerCase() === name.toLowerCase(),
  );
  if (clash) {
    flash(`That category already has a tag called "${clash.name}".`, "error");
    return;
  }

  const existing = scopedTagList().find((t) => t.id === tagEditId);
  if (existing) {
    existing.name = name.slice(0, 60);
    existing.color = color;
    existing.categoryId = categoryId;
  } else {
    scopedTagList().push({
      id: newId(),
      categoryId,
      name: name.slice(0, 60),
      color,
      status: "active",
    });
  }
  commitTagScope();
  _tagEditModal!.close({ handoff: true });
  returnToTagList();
}

/* =============================================================================
   PREFERENCES
============================================================================= */

/** Wires one On/Off row: the switch, its label, and the write-back. Written
 *  once rather than nine times so a new preference cannot forget to update its
 *  own label or to save. */
function bindToggle(
  inputId: string,
  labelId: string,
  write: (value: boolean) => void,
  labels: [string, string] = ["On", "Off"],
): void {
  const input = document.getElementById(inputId) as HTMLInputElement;
  const label = document.getElementById(labelId)!;
  input.addEventListener("change", () => {
    write(input.checked);
    label.textContent = input.checked ? labels[0] : labels[1];
    markSettings();
    renderAll();
  });
}

function bindPreferenceControls(): void {
  bindToggle("kbConfirmDeleteToggle", "kbConfirmDeleteLabel", (v) => {
    kbSettings.confirmDelete = v;
  });
  bindToggle("kbAutoCompleteToggle", "kbAutoCompleteLabel", (v) => {
    kbSettings.autoCompleteOnDone = v;
  });
  bindToggle("kbShowTagsToggle", "kbShowTagsLabel", (v) => {
    kbSettings.showTags = v;
  });
  bindToggle("kbShowSubtasksToggle", "kbShowSubtasksLabel", (v) => {
    kbSettings.showSubtasks = v;
  });
  bindToggle("kbShowDatesToggle", "kbShowDatesLabel", (v) => {
    kbSettings.showDates = v;
  });
  bindToggle("kbShowNumbersToggle", "kbShowNumbersLabel", (v) => {
    kbSettings.showNumbers = v;
  });
  bindToggle("kbOverdueWarnToggle", "kbOverdueWarnLabel", (v) => {
    kbSettings.overdueWarn = v;
  });
  bindToggle(
    "kbShowCardDeleteToggle",
    "kbShowCardDeleteLabel",
    (v) => {
      kbSettings.showCardDelete = v;
    },
    ["On", "Off"],
  );
  bindToggle("kbShowStagesToggle", "kbShowStagesLabel", (v) => {
    kbSettings.showStages = v;
  });
  bindToggle("kbShowDueToggle", "kbShowDueLabel", (v) => {
    kbSettings.showDue = v;
  });

  const colorMode = document.getElementById("kbCardColorModeDefaultSelect") as HTMLSelectElement;
  colorMode.addEventListener("change", () => {
    kbSettings.cardColorMode = normalizeColorMode(colorMode.value) ?? "manual";
    markSettings();
    renderAll();
  });

  const size = document.getElementById("kbCardSizeSelect") as HTMLSelectElement;
  size.addEventListener("change", () => {
    kbSettings.cardSize = size.value === "compact" ? "compact" : "comfortable";
    markSettings();
    renderAll();
  });

}

/** The default card layout, as a drag-reorderable list. A board that has not
 *  set its own follows whatever this ends up as, including later changes. */
function renderDefaultSectionOrder(): void {
  const host = document.getElementById("kbSectionOrderList");
  if (!host) return;
  renderSectionOrderInto(host, kbSettings.sectionOrder, () => {
    markSettings();
    renderDefaultSectionOrder();
  });
}

/** Pushes the stored preferences onto the controls. Called after a load, on
 *  every Setup open, and after a snapshot restore (which can change every one
 *  of them at once). */
function applySettingsToForm(): void {
  const setToggle = (inputId: string, labelId: string, on: boolean, labels = ["On", "Off"]) => {
    const input = document.getElementById(inputId) as HTMLInputElement | null;
    const label = document.getElementById(labelId);
    if (!input || !label) return;
    input.checked = on;
    label.textContent = on ? labels[0] : labels[1];
  };

  setToggle("kbConfirmDeleteToggle", "kbConfirmDeleteLabel", kbSettings.confirmDelete);
  setToggle("kbAutoCompleteToggle", "kbAutoCompleteLabel", kbSettings.autoCompleteOnDone);
  setToggle("kbShowTagsToggle", "kbShowTagsLabel", kbSettings.showTags);
  setToggle("kbShowSubtasksToggle", "kbShowSubtasksLabel", kbSettings.showSubtasks);
  setToggle("kbShowDatesToggle", "kbShowDatesLabel", kbSettings.showDates);
  setToggle("kbShowNumbersToggle", "kbShowNumbersLabel", kbSettings.showNumbers);
  setToggle("kbOverdueWarnToggle", "kbOverdueWarnLabel", kbSettings.overdueWarn);
  setToggle("kbShowCardDeleteToggle", "kbShowCardDeleteLabel", kbSettings.showCardDelete);
  setToggle("kbShowStagesToggle", "kbShowStagesLabel", kbSettings.showStages);
  setToggle("kbShowDueToggle", "kbShowDueLabel", kbSettings.showDue);

  const size = document.getElementById("kbCardSizeSelect") as HTMLSelectElement | null;
  if (size) size.value = kbSettings.cardSize;
  const colorMode = document.getElementById(
    "kbCardColorModeDefaultSelect",
  ) as HTMLSelectElement | null;
  if (colorMode) colorMode.value = kbSettings.cardColorMode;
  const boardName = document.getElementById(
    "kbDefaultBoardNameInput",
  ) as HTMLInputElement | null;
  if (boardName) boardName.value = kbSettings.defaultBoardName;

  renderPriorityColors();
  renderDefaultSectionOrder();
}

/* =============================================================================
   DATA TAB: EXPORT + SNAPSHOTS
============================================================================= */

/* -----------------------------------------------------------------------------
   SNAPSHOTS
   -----------------------------------------------------------------------------
   One bucket per hour, shared with every other tool that snapshots, holding one
   .bak per file that was about to be overwritten. Since the split, that means a
   bucket holds the boards you actually touched in that hour and the index, and
   not the boards you did not.

   Restoring is per file. Restoring one board puts that board's cards back
   without touching any other board, which is the thing the old single-blob
   layout could not do at all.
----------------------------------------------------------------------------- */

interface KanbanBackupFileInfo {
  file: string;
  bytes: number;
  boardId: string | null;
  encrypted: boolean;
}

interface KanbanBackupInfo {
  name: string;
  files: KanbanBackupFileInfo[];
}

/** The export is the one place the old self-contained shape is still written:
 *  a file you take out of the app has to stand on its own, not reference five
 *  other files it did not come with.
 *
 *  Locked boards are listed by name and left empty, and the export says so
 *  rather than quietly omitting them. An export that silently dropped half your
 *  boards would be worse than one that refused. */
async function exportAll(): Promise<void> {
  const lockedNames = boards.filter((b) => b.locked).map((b) => b.name);

  const store: KanbanStore & { lockedBoards?: string[] } = {
    version: STORE_VERSION,
    boards: boards.filter((b) => !b.locked),
    cards,
    tagCategories: globalTagCategories,
    tags: globalTags,
    settings: kbSettings,
  };
  if (lockedNames.length > 0) store.lockedBoards = lockedNames;

  try {
    const path = await invoke<string>("export_kanban_data", {
      filename: `kanban-${today()}.json`,
      // Indented: an export is for reading and diffing outside this app, which
      // one long line is useless for.
      data: JSON.stringify(store, null, 2),
    });
    if (lockedNames.length > 0) {
      flash(
        `Exported to ${shortPath(path)}. ${lockedNames.length} locked board(s) were left out: unlock them and export again to include them.`,
        "success",
        10000,
      );
    } else {
      flash(`Exported to ${shortPath(path)}`, "success", 8000);
    }
  } catch (err) {
    flash(`Export failed: ${String(err)}`, "error", 8000);
  }
}

/** Turns a snapshot folder name (UTC, "%Y-%m-%d_%H-%M-%S") into a local date
 *  and time. Shown local because "when was I working" is a local question, and
 *  a UTC stamp on a list of your own edits is a puzzle. */
export function formatBackupName(name: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/.exec(name);
  if (!m) return name;
  const date = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])),
  );
  return Number.isNaN(date.getTime()) ? name : date.toLocaleString();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** What one captured file is, in words. The board name is looked up rather than
 *  stored in the snapshot, so a board renamed since is described by the name it
 *  has now, which is the one you will recognise. */
function describeBackupFile(entry: KanbanBackupFileInfo): string {
  if (!entry.boardId) return "Board list and tags";
  const board = getBoard(entry.boardId);
  const name = board ? board.name : "a deleted board";
  return entry.encrypted ? `${name} (encrypted)` : name;
}

async function refreshDataTab(): Promise<void> {
  const live = cards.filter((c) => !c.archived).length;
  const locked = boards.filter((b) => b.locked).length;
  document.getElementById("kbExportSummary")!.textContent =
    `${boards.length} boards · ${live} cards · ${globalTags.length} default tags` +
    (locked > 0 ? ` · ${locked} locked` : "");

  const list = document.getElementById("kbBackupList")!;
  const summary = document.getElementById("kbBackupSummary")!;
  list.replaceChildren();

  let items: KanbanBackupInfo[];
  try {
    items = await invoke<KanbanBackupInfo[]>("list_kanban_backups");
  } catch (err) {
    summary.textContent = "unavailable";
    const error = document.createElement("p");
    error.className = "placeholder-text";
    error.textContent = `Couldn't read the snapshot folder: ${String(err)}`;
    list.appendChild(error);
    return;
  }

  summary.textContent = items.length === 0 ? "none yet" : `${items.length} kept`;

  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "placeholder-text";
    empty.textContent =
      "No snapshots yet. The first one is taken the next time you change something, capturing the state from before that change.";
    list.appendChild(empty);
    return;
  }

  items.forEach((item, index) => {
    const group = document.createElement("div");
    group.className = "kb-backup-group";

    const head = document.createElement("div");
    head.className = "kb-backup-head";
    const when = document.createElement("span");
    when.className = "kb-backup-when";
    when.textContent = formatBackupName(item.name);
    head.appendChild(when);
    if (index === 0) {
      const badge = document.createElement("span");
      badge.className = "setup-item-retired-badge";
      badge.textContent = "Newest";
      head.appendChild(badge);
    }
    group.appendChild(head);

    for (const entry of item.files) {
      const row = document.createElement("div");
      row.className = "setup-item kb-backup-row";

      const what = document.createElement("span");
      what.className = "setup-item-name";
      what.textContent = describeBackupFile(entry);
      row.appendChild(what);

      const size = document.createElement("span");
      size.className = "setup-item-count";
      size.textContent = formatBytes(entry.bytes);
      row.appendChild(size);

      const restore = document.createElement("button");
      restore.type = "button";
      restore.className = "settings-action-btn";
      restore.textContent = "Restore";
      restore.addEventListener("click", () => {
        const scope = entry.boardId
          ? `the board "${describeBackupFile(entry)}" (its columns and cards)`
          : "the board list and the whole tag vocabulary, across every board";
        kbConfirm(
          {
            title: "Restore this snapshot?",
            message:
              `This replaces ${scope} with the state from ${formatBackupName(item.name)}. ` +
              "What is there now is snapshotted on the way past, so restoring the newest entry afterwards undoes this.",
            confirmLabel: "Restore",
            reopen: () => openSetupOnTab("data"),
          },
          () => void restoreBackup(item.name, entry),
        );
      });
      row.appendChild(restore);

      group.appendChild(row);
    }

    list.appendChild(group);
  });
}

/**
 * Puts one captured file back.
 *
 * Always through the ordinary save path, never by copying the .bak over the
 * live file: an ordinary save snapshots what it replaces, which is what makes a
 * restore you did not mean undoable by restoring the newest entry afterwards.
 */
async function restoreBackup(name: string, entry: KanbanBackupFileInfo): Promise<void> {
  try {
    // Anything still sitting in the debounce has to land first, or the state
    // this restore snapshots on the way past is not the state the user saw.
    await flushSave();

    const raw = await invoke<string>("read_kanban_backup", { name, file: entry.file });

    if (!entry.boardId) {
      await restoreIndexSnapshot(raw);
    } else {
      await restoreBoardSnapshot(entry, raw);
    }

    applySettingsToForm();
    renderTagCategoriesList();
    void refreshDataTab();
    renderAll();
    flash(`Restored ${describeBackupFile(entry)} from ${formatBackupName(name)}.`, "success", 8000);
  } catch (err) {
    devError("[kanban] restore failed", err);
    flash(`Restore failed: ${String(err)}`, "error", 8000);
  }
}

/** Restoring the index restores the board LIST and the tag vocabulary. The
 *  boards' own contents are untouched, so this brings back a deleted board's
 *  name and background (and its file, if that is still on disk) without
 *  rewinding any board's cards. */
async function restoreIndexSnapshot(raw: string): Promise<void> {
  const parsed = JSON.parse(raw) as Partial<KanbanIndex>;
  if (!Array.isArray(parsed.boards)) {
    throw new Error("that snapshot is not a board list");
  }
  const restored = parsed.boards
    .map(normalizeBoardMeta)
    .filter((b): b is Board => b !== null);

  // Contents already in memory are carried across onto the restored metadata,
  // so restoring the list does not silently lock every board you had open.
  const current = new Map(boards.map((b) => [b.id, b]));
  for (const board of restored) {
    const live = current.get(board.id);
    if (live && !live.locked) {
      board.columns = live.columns;
      board.nextCardNumber = live.nextCardNumber;
      board.tagCategories = live.tagCategories;
      board.tags = live.tags;
      board.overrides = live.overrides;
      board.locked = false;
    }
  }
  boards = restored;
  globalTagCategories = Array.isArray(parsed.tagCategories)
    ? parsed.tagCategories.map(normalizeTagCategory).filter((c): c is TagCategory => c !== null)
    : [];
  globalTags = Array.isArray(parsed.tags)
    ? parsed.tags.map(normalizeTag).filter((t): t is Tag => t !== null)
    : [];

  // A board that was in memory but is not in the restored list has just stopped
  // existing, so its cards go with it.
  const known = new Set(boards.map((b) => b.id));
  cards = cards.filter((c) => known.has(c.boardId));

  // Boards named by the snapshot that were not loaded stay locked until asked
  // for, exactly as they would after a normal launch.
  for (const board of boards) {
    if (board.locked && !encryptedBoardIds.has(board.id)) {
      await loadBoardContents(board).catch(() => undefined);
    }
  }

  reconcile();
  if (currentBoardId && !getBoard(currentBoardId)) showKbView("boards");
  dirtyIndex = true;
  await saveNow();
}

/** Restoring a board replaces that board's columns and cards and nothing else.
 *  Its index entry (name, description, background) is left alone, because those
 *  are not what you are recovering when you reach for a snapshot. */
async function restoreBoardSnapshot(
  entry: KanbanBackupFileInfo,
  raw: string,
): Promise<void> {
  const boardId = entry.boardId!;
  const board = getBoard(boardId);
  if (!board) {
    throw new Error("that board is no longer in the board list");
  }

  let payload = raw;
  if (entry.encrypted) {
    const password = sessionPassword ?? (await promptForPassword({
      title: "Unlock the Snapshot",
      message: `That snapshot of "${board.name}" is encrypted. Enter the Kanban password to read it.`,
      reopen: () => openSetupOnTab("data"),
    }));
    if (!password) throw new Error("cancelled");
    // Decrypted from the snapshot's own envelope rather than from the live
    // file, which is the only reason kanban_decrypt_envelope exists.
    payload = await invoke<string>("kanban_decrypt_envelope", {
      envelope: raw,
      password,
    });
    sessionPassword = password;
  }

  const parsed = JSON.parse(payload) as Partial<BoardContents> | null;
  const contents = normalizeContents(parsed ?? {});

  board.columns = contents.columns;
  board.nextCardNumber = contents.nextCardNumber;
  board.locked = false;
  cards = cards.filter((c) => c.boardId !== boardId);
  for (const card of contents.cards) card.boardId = boardId;
  cards.push(...contents.cards);

  reconcile();
  markBoard(boardId);
  await flushSave();
}

/* =============================================================================
   ENCRYPTION: THE PASSWORD PROMPT, THE GATE, AND PER-BOARD OPT-IN
   -----------------------------------------------------------------------------
   The model in one line: ONE Kanban password, each board opts in individually,
   and "lock the tool" asks for that same password before letting you in rather
   than encrypting anything a second time.

   That is what makes the obvious worry go away. Three encrypted boards plus a
   locked tool is not four layers of encryption and does not require decrypting
   anything first: the boards stay exactly as they are, and the lock is a door
   in front of them.
============================================================================= */

interface PasswordRequest {
  title: string;
  message: string;
  /** Ask twice and require a match. For establishing a password, where a typo
   *  you cannot see would encrypt a board you can never open again. */
  confirm?: boolean;
  okLabel?: string;
  /** How to get back to whatever this replaced, once it is done. Same contract
   *  and same reason as kbConfirm's: nothing here stacks. */
  reopen?: () => void;
}

let passwordResolve: ((value: string | null) => void) | null = null;

function getPasswordModal(): Modal {
  if (_passwordModal) return _passwordModal;

  const input = document.getElementById("kbPasswordInput") as HTMLInputElement;
  const confirmInput = document.getElementById("kbPasswordConfirmInput") as HTMLInputElement;

  _passwordModal = new Modal(document.getElementById("kbPasswordBackdrop")!, {
    closeOnEsc: true,
    onOpen: () => setTimeout(() => input.focus(), 50),
    onClosed: () => {
      // Cleared on the way out, always. A password left sitting in a DOM node
      // is a password on screen the next time the modal opens.
      input.value = "";
      confirmInput.value = "";
      document.getElementById("kbPasswordError")!.textContent = "";
      // Resolves null if the modal was dismissed rather than submitted, so a
      // caller awaiting it is never left hanging.
      passwordResolve?.(null);
      passwordResolve = null;
    },
  });

  const submit = (): void => {
    const value = input.value;
    const errorEl = document.getElementById("kbPasswordError")!;
    if (!value) {
      errorEl.textContent = "Enter a password.";
      return;
    }
    const confirmRow = document.getElementById("kbPasswordConfirmRow") as HTMLElement;
    if (confirmRow.style.display !== "none" && value !== confirmInput.value) {
      errorEl.textContent = "The two entries do not match.";
      return;
    }
    const resolve = passwordResolve;
    passwordResolve = null;
    _passwordModal!.close();
    resolve?.(value);
  };

  document.getElementById("kbPasswordOkBtn")!.addEventListener("click", submit);
  for (const id of ["kbPasswordCancelBtn", "kbPasswordCloseBtn"]) {
    document.getElementById(id)!.addEventListener("click", () => _passwordModal!.close());
  }
  for (const el of [input, confirmInput]) {
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    });
  }

  return _passwordModal;
}

/** Asks for a password and resolves to it, or to null if dismissed. */
function promptForPassword(request: PasswordRequest): Promise<string | null> {
  // Replaces rather than stacks; see kbConfirm.
  topOpenKanbanModal()?.close({ handoff: true });

  const modal = getPasswordModal();
  document.getElementById("kbPasswordTitle")!.textContent = request.title;
  document.getElementById("kbPasswordMessage")!.textContent = request.message;
  document.getElementById("kbPasswordOkBtn")!.textContent = request.okLabel ?? "Unlock";
  (
    document.getElementById("kbPasswordConfirmRow") as HTMLElement
  ).style.display = request.confirm ? "" : "none";

  return new Promise<string | null>((resolve) => {
    // Wrapped so the caller's "put it back" runs on every ending: submitted,
    // cancelled, or dismissed with Escape.
    passwordResolve = (value) => {
      request.reopen?.();
      resolve(value);
    };
    modal.open();
  });
}

/** Opens a locked board, asking for the password if this session does not
 *  already hold it. Returns false when the user cancelled or got it wrong. */
async function unlockBoard(board: Board): Promise<boolean> {
  if (!board.locked) return true;

  if (sessionPassword) {
    try {
      await loadBoardContents(board, sessionPassword);
      return true;
    } catch {
      // The held password does not open this board, which should not happen
      // (there is only one) but is recoverable by asking again.
      sessionPassword = null;
    }
  }

  const password = await promptForPassword({
    title: `Unlock "${board.name}"`,
    message: "This board is encrypted. Its cards are decrypted into memory only, never back to disk in the clear.",
  });
  if (!password) return false;

  try {
    await loadBoardContents(board, password);
    sessionPassword = password;
    reconcile();
    return true;
  } catch (err) {
    flash(String(err), "error", 8000);
    return false;
  }
}

/** Turns encryption on for one board. Establishes the Kanban password if this
 *  is the first board to be encrypted, and otherwise checks against it. */
async function encryptBoard(board: Board): Promise<void> {
  if (encryptedBoardIds.has(board.id)) return;

  const hasPassword = encryptedBoardIds.size > 0;
  const password =
    sessionPassword ??
    (await promptForPassword({
      title: hasPassword ? "Encrypt This Board" : "Set the Kanban Password",
      message: hasPassword
        ? "Enter the Kanban password. Every encrypted board on this install uses the same one."
        : "This password encrypts the boards you choose. It cannot be recovered, and no encrypted board can be read without it. Put it somewhere safe.",
      confirm: !hasPassword,
      okLabel: "Encrypt",
      reopen: () => openBoardSetup(board, "board"),
    }));
  if (!password) return;

  try {
    // The board's current state has to be on disk before it is encrypted, or
    // encryption captures whatever was last written rather than what is on
    // screen.
    markBoard(board.id);
    await flushSave();
    await invoke("kanban_encrypt_board", { boardId: board.id, password });
    sessionPassword = password;
    await refreshLockStatus();
    renderAll();
    flash(`"${board.name}" is now encrypted.`);
  } catch (err) {
    flash(String(err), "error", 9000);
  }
}

/** Takes one board back out of encryption, writing it to disk in the clear. */
async function decryptBoardToPlain(board: Board): Promise<void> {
  if (!encryptedBoardIds.has(board.id)) return;

  const password =
    sessionPassword ??
    (await promptForPassword({
      title: `Decrypt "${board.name}"`,
      message: "Enter the Kanban password. This board's cards will be written to disk in the clear.",
      okLabel: "Decrypt",
      reopen: () => openBoardSetup(board, "board"),
    }));
  if (!password) return;

  try {
    if (!board.locked) {
      markBoard(board.id);
      await flushSave();
    }
    await invoke("kanban_decrypt_board_to_plain", { boardId: board.id, password });
    sessionPassword = password;
    await refreshLockStatus();
    if (board.locked) await loadBoardContents(board);
    reconcile();

    // That may have been the last encrypted board, and the tool lock asks for a
    // password that no longer exists. Left set, it would come back on its own
    // the next time any board was encrypted, which nobody asked for.
    if (encryptedBoardIds.size === 0 && kbSettings.lockOnOpen) {
      kbSettings.lockOnOpen = false;
      markSettings();
      flash(
        "No boards are encrypted any more, so the Kanban lock has been switched off with them.",
        "success",
        8000,
      );
    }

    renderAll();
    flash(`"${board.name}" is no longer encrypted.`);
  } catch (err) {
    flash(String(err), "error", 9000);
  }
}

/** Forgets the password and drops every decrypted board back out of memory.
 *  The "only into memory" promise needs a moment where that memory is given
 *  up, and this is it. */
async function lockNow(): Promise<void> {
  // Anything queued has to land while the password is still held, or the edit
  // is stuck until the next unlock.
  await flushSave();
  sessionPassword = null;
  for (const board of boards) {
    if (encryptedBoardIds.has(board.id)) unloadBoardContents(board);
  }
  if (currentBoardId && getBoard(currentBoardId)?.locked) showKbView("boards");
  else renderAll();
}

/* -----------------------------------------------------------------------------
   THE TOOL-LOCK GATE
   -----------------------------------------------------------------------------
   Shown over the whole tool when lockOnOpen is set and a password exists. It is
   a door, not a cipher: passing it holds the password for the visit, which is
   also what unlocks the encrypted boards behind it, so one password entry does
   both jobs and nothing is encrypted twice.
----------------------------------------------------------------------------- */

function gateRequired(): boolean {
  return kbSettings.lockOnOpen && encryptedBoardIds.size > 0 && sessionPassword === null;
}

function showAuthGate(show: boolean): void {
  authGateShowing = show;
  // The views are HIDDEN rather than merely covered: a board rendered behind a
  // gate is a board whose card titles are one screenshot away.
  applyViewVisibility();
  if (!show) return;
  (document.getElementById("kbAuthError") as HTMLElement).textContent = "";
  const input = document.getElementById("kbAuthInput") as HTMLInputElement;
  input.value = "";
  setTimeout(() => input.focus(), 60);
}

async function submitAuthGate(): Promise<void> {
  const input = document.getElementById("kbAuthInput") as HTMLInputElement;
  const errorEl = document.getElementById("kbAuthError")!;
  const value = input.value;
  if (!value) {
    errorEl.textContent = "Enter the Kanban password.";
    return;
  }
  try {
    const ok = await invoke<boolean>("kanban_verify_password", { password: value });
    if (!ok) {
      errorEl.textContent = "Incorrect password.";
      input.select();
      return;
    }
  } catch (err) {
    errorEl.textContent = String(err);
    return;
  }
  sessionPassword = value;
  input.value = "";
  showAuthGate(false);
  renderAll();
}

/* =============================================================================
   INFO TOOLTIPS
   -----------------------------------------------------------------------------
   The ℹ buttons beside the settings rows. Each carries its explanation in
   data-tooltip and shows it in one shared floating bubble.

   Reimplemented here rather than imported, which is this codebase's stated
   convention for this pattern (see the same note in shell.ts and
   auto-backup.ts): the buttons belong to this file, so the twenty lines that
   drive them do too.

   Why buttons and not the paragraphs they replaced: five paragraphs of subtext
   turned a four-row tab into something you had to scroll to find the fifth
   setting in. The words are worth keeping and worth getting out of the way.
============================================================================= */

let infoTooltipEl: HTMLDivElement | null = null;
let infoTooltipOpenBtn: HTMLButtonElement | null = null;

function closeInfoTooltip(): void {
  infoTooltipEl?.classList.remove("visible");
  infoTooltipOpenBtn = null;
}

function toggleInfoTooltip(btn: HTMLButtonElement, text: string): void {
  if (infoTooltipOpenBtn === btn) {
    closeInfoTooltip();
    return;
  }
  if (!infoTooltipEl) {
    infoTooltipEl = document.createElement("div");
    infoTooltipEl.className = "kb-info-tooltip";
    document.body.appendChild(infoTooltipEl);
  }
  infoTooltipEl.textContent = text;
  infoTooltipEl.classList.add("visible");

  // Measured after being made visible, so the clamping below works off the real
  // rendered size rather than off zero.
  const rect = btn.getBoundingClientRect();
  const width = infoTooltipEl.offsetWidth;
  const height = infoTooltipEl.offsetHeight;
  const left = Math.min(
    Math.max(8, rect.left + rect.width / 2 - width / 2),
    window.innerWidth - width - 8,
  );
  // Flipped above the button when there is no room below, which there often is
  // not: these live in a modal that can reach the bottom of the window.
  const top =
    rect.bottom + height + 10 > window.innerHeight
      ? Math.max(8, rect.top - height - 6)
      : rect.bottom + 6;
  infoTooltipEl.style.left = `${left}px`;
  infoTooltipEl.style.top = `${top}px`;
  infoTooltipOpenBtn = btn;
}

function bindInfoTooltips(): void {
  document
    .querySelectorAll<HTMLButtonElement>(".kb-info-btn[data-tooltip]")
    .forEach((btn) => {
      btn.addEventListener("click", (e) => {
        // Without this the document listener below sees the same click and
        // closes the bubble the instant it opens.
        e.stopPropagation();
        toggleInfoTooltip(btn, btn.dataset.tooltip ?? "");
      });
    });
  document.addEventListener("click", () => closeInfoTooltip());
  // A bubble is positioned against a button that has just moved, so it goes
  // rather than pointing at nothing.
  window.addEventListener("resize", () => closeInfoTooltip());
}

/* =============================================================================
   INIT + SHELL HOOKS
============================================================================= */

export function initKanban(): void {
  viewBoards = document.getElementById("kbViewBoards")!;
  viewBoard = document.getElementById("kbViewBoard")!;
  boardGrid = document.getElementById("kbBoardGrid")!;
  boardsEmpty = document.getElementById("kbBoardsEmpty")!;
  boardSearchInput = document.getElementById("kbBoardSearch") as HTMLInputElement;
  gallerySummary = document.getElementById("kbGallerySummary")!;
  boardBgLayer = document.getElementById("kbBoardBg")!;
  boardTitleEl = document.getElementById("kbBoardTitle")!;
  boardCountsEl = document.getElementById("kbBoardCounts")!;
  columnsEl = document.getElementById("kbColumns")!;
  columnsEmpty = document.getElementById("kbColumnsEmpty")!;
  cardSearchInput = document.getElementById("kbCardSearch") as HTMLInputElement;
  filterBar = document.getElementById("kbFilterBar")!;
  filterBtn = document.getElementById("kbFilterBtn") as HTMLButtonElement;
  boardSetupBtn = document.getElementById("kbBoardSetupBtn") as HTMLButtonElement;
  headerNoticeWrap = document.getElementById("kbHeaderNoticeWrap")!;
  headerNotice = document.getElementById("kbHeaderNotice")!;
  authView = document.getElementById("kbAuthView")!;

  /* ── Header ── */
  document.getElementById("kbSetupBtn")!.addEventListener("click", () => openSetupOnTab("tags"));
  boardSetupBtn.addEventListener("click", () => {
    const board = getBoard(currentBoardId);
    if (board) openBoardSetup(board);
  });

  /* ── Gallery ── */
  document.getElementById("kbNewBoardBtn")!.addEventListener("click", () => openNewBoard());
  boardSearchInput.addEventListener("input", () => renderGallery());

  /* ── Board view ── */
  document.getElementById("kbBoardBackBtn")!.addEventListener("click", () => showKbView("boards"));

  cardSearchInput.addEventListener("input", () => {
    filterText = cardSearchInput.value;
    renderBoardView();
  });

  filterBtn.addEventListener("click", () => {
    filterBarOpen = !filterBarOpen;
    renderBoardView();
  });

  document.getElementById("kbAddColumnBtn")!.addEventListener("click", () => {
    const board = getBoard(currentBoardId);
    if (board) openColumnEditor(board, null);
  });

  document.getElementById("kbBoardMenuBtn")!.addEventListener("click", (e) => {
    const board = getBoard(currentBoardId);
    if (!board) return;
    openMenu(e.currentTarget as HTMLElement, [
      { label: "Board Stats", onClick: () => openBoardStats(board) },
      {
        label: `Archived Cards (${archivedCardsOnBoard(board.id).length})`,
        onClick: () => openArchive(board),
      },
      { label: "Copy Columns to a New Board", onClick: () => duplicateBoardAsTemplate(board) },
    ]);
  });

  /* ── Tool lock gate ── */
  const authInput = document.getElementById("kbAuthInput") as HTMLInputElement;
  document.getElementById("kbAuthSubmitBtn")!.addEventListener("click", () => void submitAuthGate());
  authInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void submitAuthGate();
    }
  });

  bindInfoTooltips();

  // Claimed once, for the life of the app. The handler checks whether this
  // tool is on screen before answering, so holding it permanently is safe and
  // several tools can hold one at the same time.
  setSubNavHandler({ back: kbSubNavBack, forward: kbSubNavForward });

  // Last, and before the load: everything above has to be in place before any
  // shell hook is allowed to run, and loadAll() calls back into rendering.
  initialised = true;
  void loadAll();
}

/** Called by shell.ts whenever the Kanban tool is opened, including on mouse
 *  back/forward replay. Leaving for another tool and coming back is a fresh
 *  start, so the filters go, matching what walking out to the gallery does.
 *  The re-render also picks up a date rollover: a card that was "due tomorrow"
 *  when you left is overdue when you come back the next morning. */
export function onKanbanToolEntry(): void {
  // See `initialised`: the shell can route into this tool before init() has
  // reached it. loadAll() applies the gate and renders once it finishes, so
  // there is nothing lost by doing nothing here.
  if (!initialised) return;
  clearFilters();
  // The gate has to be decided before anything renders, or a board flashes on
  // screen for a frame on the way to being hidden.
  showAuthGate(gateRequired());
  renderAll();
}

/**
 * Called by shell.ts when the Kanban is navigated away from.
 *
 * Two jobs, and the order matters: land any queued edit while the password is
 * still held, THEN give the password up. Reversed, an edit made in the last
 * half-second before leaving would be stuck until the next unlock.
 *
 * The password is only given up when the tool lock is on. Without it, the
 * session password is what stops an encrypted board asking again every time you
 * step out to another tool and back, and there is nothing to protect it from:
 * the gate is the feature that says "forget me when I leave".
 */
export async function onKanbanToolExit(): Promise<void> {
  if (!initialised) return;
  await flushSave();
  if (!kbSettings.lockOnOpen || encryptedBoardIds.size === 0) return;
  sessionPassword = null;
  for (const board of boards) {
    if (encryptedBoardIds.has(board.id)) unloadBoardContents(board);
  }
  if (currentBoardId && getBoard(currentBoardId)?.locked) {
    currentBoardId = null;
    currentView = "boards";
  }
}

/** Called by shell.ts only when the sidebar icon or Home tile is clicked
 *  (never on history replay, which calls onKanbanToolEntry directly). Jumps to
 *  the gallery even from inside a board, and goes through showKbView so the
 *  jump is recorded: mouse-back then returns to the board it interrupted
 *  rather than orphaning it. */
export function onKanbanIconClicked(): void {
  if (!initialised) return;
  showKbView("boards");
}
