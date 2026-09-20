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

     • DESCRIPTIONS AND COMMENTS ARE MARKDOWN, rendered by src/core/rich-text.ts
       and NOT by the renderer in docs.ts. That one passes raw HTML through
       because the documents it draws ship with the app; this text was typed by
       a person, so it is escaped before a single tag is emitted. The file it
       lives in explains the split at length.

     • AN ATTACHMENT IS A COPY THE TOOL OWNS, and its location is DERIVED rather
       than stored: kanban-attachments/<boardId>/<attachmentId>. Cards never
       point at the file you picked, so moving or deleting the original leaves
       the card intact, and a card cannot name a file outside its own board
       because it carries no path at all.

     • AN AI AGENT IS A CLIENT WITH NO AUTHORITY. A board can be opened to a
       local agent (Board Setup > Agents), and everything it asks for is a
       REQUEST this app grants or refuses. The permission check is in
       src-tauri/src/agent_gate.rs, before the request reaches this file; the
       checks that need the record itself (who created this card) are in the
       AGENT OPERATIONS section below. An agent's card is created by the same
       createCard() a button calls, so there is one set of rules rather than
       two.

     • DELETING SOMETHING TAKES ITS FILES, and a deleted file is set aside
       rather than unlinked, so restoring an older snapshot brings them back for
       as long as that snapshot survives. Two things keep that honest: every
       board load sweeps files no card references, and the back end retires a
       file instead of destroying it. See the store's note in kanban.rs.

   Rust commands used:
     save_kanban_index, load_kanban_index,
     save_kanban_board, load_kanban_board, delete_kanban_board,
     list_kanban_backups, read_kanban_backup,
     import_kanban_image, delete_kanban_image, kanban_backgrounds_dir,
     kanban_attachments_dir, import_kanban_attachment, paste_kanban_attachment,
     copy_kanban_attachment, delete_kanban_attachment,
     delete_kanban_board_attachments, sweep_kanban_attachments,
     revive_kanban_attachments, kanban_attachments_exist,
     open_kanban_attachment

   Agent access (see the AGENT OPERATIONS section):
     kanban_agent_reply, kanban_agent_status,
     read_kanban_agent_log, clear_kanban_agent_log

   Preferences go through lib.rs's shared tool-file store, like every other
   tool's, and so does the agent configuration.
============================================================================= */

// The shapes and the fixed vocabulary. A leaf: it imports nothing.
import type {
  AgentAuthor,
  Attachment,
  Board,
  BoardBackground,
  BoardContents,
  BoardMeta,
  BoardScopedSettings,
  BoardSortMode,
  Card,
  CardAuthor,
  CardColorMode,
  CardComment,
  CardDates,
  CardSection,
  CardTextColor,
  Column,
  Effort,
  KanbanIndex,
  KbSettings,
  KbStatus,
  LevelId,
  NewCardPosition,
  Priority,
  ScaleLevel,
  SortField,
  SortRule,
  Stage,
  Subtask,
  Tag,
  TagCategory,
} from "./kanban-model";
import {
  BOARD_SORT_MODES,
  CARD_SECTIONS,
  CARD_SECTION_LABELS,
  DARK_INK,
  DEFAULT_EFFORT_LEVELS,
  DEFAULT_NONE_LABEL,
  DEFAULT_PRIORITY_LEVELS,
  DEFAULT_SETTINGS,
  DEFAULT_TAG_COLOR,
  LIGHT_INK,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  MAX_CARDS_PER_BOARD,
  MAX_COLUMNS_PER_BOARD,
  MAX_COMMENTS_PER_CARD,
  MAX_COMMENT_LEN,
  MAX_DESC_LEN,
  MAX_LEVEL_NAME_LEN,
  MAX_SCALE_LEVELS,
  MAX_SUBTASKS_PER_CARD,
  MAX_TITLE_LEN,
  NO_LEVEL,
  SAVE_DEBOUNCE_MS,
  STAGES,
  STAGE_LABELS,
  SYSTEM_DEFAULT_COLUMNS,
} from "./kanban-model";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  backgroundMenu,
  devError,
  flash,
  setSubNavHandler,
  setToolAttention,
  settings as shellSettings,
  flushOnQuit,
} from "../core/shell";
import { Modal, ModalTabs } from "../modal/modal";
import { attachMenu, openMenu, type MenuItem } from "../menu/menu";
import { formatBackupName } from "../core/tool-backups";
// The bottom thousand lines of this file until 0.8.0; see that file's header
// for why the loop between the two is safe.
import { listenForAgentRequests } from "./kanban-executor";
// A card as the board draws it; the other half of kanban-card.ts.
import { buildCardEl, paintTagChip } from "./kanban-card-face";
// Picking a card or a column up and putting it down.
import {
  attachCardDropTarget,
  attachColumnDragHandlers,
  dragCardId,
} from "./kanban-dnd";
// The two read-only numbers screens.
import {
  _boardStatsModal,
  _cardStatsModal,
  openBoardStats,
} from "./kanban-stats";
// The card modal and a card's attachments; the biggest of the four. See that
// file's header for what stayed behind and why the loop is safe.
import {
  _cardColorModal,
  _cardModal,
  allAttachments,
  cloneAttachments,
  closeTagSearch,
  discardPendingComment,
  forgetAttachmentFiles,
  missingAttachments,
  moveAttachmentsToBoard,
  openCardId,
  renderCardPlacement,
  setAttachmentsRoot,
  sweepBoardAttachments,
  wireTagSearch,
  type TagPickSpec,
  _lightboxModal,
} from "./kanban-card";
// The Agents tab in Board Setup, out of this file for the same reason.
import {
  forgetAgentAccess,
  renderAgentGlobalRow,
  renderAgentsTab,
  wireAgentsTab,
} from "./kanban-agents-tab";
import { formatBytes } from "../core/format";
import { newId } from "../core/ids";
import { bindInfoTooltips, toggleInfoTooltip } from "../core/info-tooltip";
import { loadToolJson, saveToolJson, writesFrozen } from "../core/tool-store";
import { formatStoredDate, today } from "../core/timestamp";
/* Nothing from kanban-agents.ts, from thirty names: the tab took most of
   them, and the owner menu took the last two when the card face moved out.
   Nothing from rich-text either, for the same reason. */


/* =============================================================================
   STATE
============================================================================= */

export let boards: Board[] = [];
/** Every card of every board, flat. One array, because every question worth
 *  asking spans columns and boards; see the note at the top of the file.
 *
 *  This used to carry an exception for locked boards, whose contents were not
 *  in memory. Board encryption is gone (see LOADING), so there is no longer a
 *  board whose cards are absent, and code that still assumed one would be
 *  guarding against a state that cannot happen. */
export let cards: Card[] = [];
/** The DEFAULT tag vocabulary, from the index. Templates to copy onto a board,
 *  never what a card points at: see the note on KanbanIndex. */
let globalTagCategories: TagCategory[] = [];
let globalTags: Tag[] = [];
export let kbSettings: KbSettings = { ...DEFAULT_SETTINGS };

/** False until the first load has settled. Guards every write, so an edit made
 *  in the first moments of app start cannot persist over the real data. */
export let storeLoaded = false;

let saveTimer: number | null = null;

/* -----------------------------------------------------------------------------
   WHAT IS DIRTY
   -----------------------------------------------------------------------------
   Saving is one call per file that changed, never one call that rewrites
   everything. Renaming a board must not cost a write of every board you own.

   Three flags, set by the mutation helpers (markIndex / markBoard / markCard /
   markSettings) and cleared by the flush. Deliberately coarse WITHIN a file:
   whichever board changed is written whole, because a board file is a few KB
   and a partial write is how you get a file that disagrees with itself.
----------------------------------------------------------------------------- */
let dirtySettings = false;
/** Boards whose contents file needs writing: columns, cards, tags, overrides. */
const dirtyBoards = new Set<string>();
/** Whether the index (the board list and the default tag vocabulary) needs
 *  writing. */
let dirtyIndex = false;
/** Boards whose contents file should be deleted. Held separately because by
 *  save time the board is already out of the `boards` array. */
const deletedBoards = new Set<string>();

/* -----------------------------------------------------------------------------
   VIEW STATE
----------------------------------------------------------------------------- */

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
export let initialized = false;

/** Which board the board view is showing, or null on the gallery. */
export let currentBoardId: string | null = null;

/** Session-scoped filters. Cleared on tool entry and when leaving a board, the
 *  same "only reset if you leave the view as a whole" rule Game Stats uses:
 *  opening a card is a detour, walking out to the gallery is a departure. */
let filterText = "";
let filterTagIds = new Set<string>();
let filterDue: "any" | "overdue" | "soon" | "none" = "any";
let filterBarOpen = false;


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
export let columnsEl: HTMLElement;
let columnsEmpty: HTMLElement;
let cardSearchInput: HTMLInputElement;
let filterBar: HTMLElement;
let filterBtn: HTMLButtonElement;
let boardSetupBtn: HTMLButtonElement;
let headerNoticeWrap: HTMLElement;
let headerNotice: HTMLElement;

/* =============================================================================
   SMALL UTILITIES
============================================================================= */

/** Parses a YYYY-MM-DD string to a local Date at midday. Midday, not midnight,
 *  so a day difference computed across a daylight-saving boundary is still a
 *  whole number of days rather than 0.958 of one. */
/**
 * Parses either shape a stored moment can take, in LOCAL time.
 *
 * TWO SHAPES, on purpose. A due date is a calendar day and nothing else, so it
 * is stored as `YYYY-MM-DD`. A stage stamp records the moment something
 * actually happened, so it is stored as `YYYY-MM-DDTHH:MM`, which is exactly
 * what <input type="datetime-local"> reads and writes.
 *
 * A BARE DATE IS PINNED TO NOON, which is not arbitrary: it is what keeps whole
 * -day arithmetic exact across a daylight-saving boundary, where midnight to
 * midnight can be 23 or 25 hours and would round to the wrong number of days.
 * A stamp that carries a real time uses that time, because there the point IS
 * the time.
 */
export function parseDay(value: string | null | undefined): Date | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(value);
  if (!m) return null;
  const hasTime = m[4] !== undefined;
  const d = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    hasTime ? Number(m[4]) : 12,
    hasTime ? Number(m[5]) : 0,
    0,
    0,
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Whether a stored value carries a time as well as a date. */
export function hasTimeOfDay(value: string | null | undefined): boolean {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value);
}

/** A moment in the form a stage stamp is stored and a datetime-local input
 *  reads. Built from the local clock rather than toISOString(), which is UTC
 *  and would stamp the wrong day for anyone west of Greenwich after 5pm. */
function localStamp(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/** Now, as a stage stamp. */
export function nowStamp(): string {
  return localStamp(new Date());
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
 *  YYYY-MM-DD; only the display flips. A stamp carrying a time is handed to
 *  formatMoment instead, so nothing prints a raw "2026-09-06T14:30". */
export function formatDate(value: string | null): string {
  if (!value) return "—";
  if (hasTimeOfDay(value)) return formatMoment(value);
  return formatStoredDate(value, shellSettings.americanDates);
}

/** A stage stamp: the date in the app's chosen order, then the time in the
 *  app's chosen clock. Falls back to the date alone for a value that has no
 *  time, so every caller can use this without asking first. */
function formatMoment(value: string | null): string {
  if (!value) return "—";
  const [day, time] = value.split(/[T ]/);
  const date = formatStoredDate(day, shellSettings.americanDates);
  if (!time) return date;
  const [h, m] = time.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return date;
  if (!shellSettings.hour12) return `${date} ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  const suffix = h < 12 ? "am" : "pm";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${date} ${hour12}:${String(m).padStart(2, "0")}${suffix}`;
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

/** The moment a card was created, date AND time, for showing beside the stage
 *  stamps. Display only: every day count and the stage order check keep using
 *  createdDay(), because a real time there would shift "12 days old" and lead
 *  time by a day depending on the hour, and would flag a Work Started stamp
 *  from earlier on the creation day as out of order. */
export function createdMoment(card: Card): string {
  return localStamp(new Date(card.createdAt));
}

export function clampInt(value: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

export function trimTo(value: unknown, max: number): string {
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

/** The ink to actually paint, honoring a card's choice.
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
export function applySolidColor(
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

   Three steps: the preferences file, the index, then one file per board. There
   used to be five, and two of them were about deciding which boards were
   ciphertext and which could be opened. Nothing here encrypts any more, so
   every board is simply read.
----------------------------------------------------------------------------- */

/* -----------------------------------------------------------------------------
   FILES THIS SESSION COULD NOT READ

   Kanban keeps one file per board plus an index, and its own load/save
   commands rather than the shared tool store, so the store's block does not
   cover them. This is the same rule written for the files it does not cover: a
   file that would not READ is never WRITTEN.

   It has to be per file rather than per tool. A board whose file is corrupt is
   in memory as an empty board, and saving it would replace the cards; the
   index and the eleven other boards are fine and must keep saving. Blocking
   everything would mean one bad board file quietly stopped the whole tool
   persisting, which is the same class of surprise in the other direction.

   Ids are "settings", "index", or a board id. Cleared only by a snapshot
   restore or an import, which REPLACE the file rather than write the empty
   thing that was loaded in its place.
----------------------------------------------------------------------------- */

/** Whether the whole-folder freeze has been mentioned this session. See
 *  writeDirty: once is right, every few seconds is not. */
let frozenNoticeShown = false;

const unreadableFiles = new Set<string>();
/** Ids already reported as skipped, so a debounced save that fires every few
 *  seconds says it once rather than every time. */
const reportedSkips = new Set<string>();

function blockKanbanFile(id: string, describe: string, err: unknown): void {
  unreadableFiles.add(id);
  devError(`[kanban] ${describe} could not be read`, err);
  flash(
    `Kanban could not read ${describe}. It will not be written over this session.`,
    "error",
    12000,
  );
}

/** Called where a file is REPLACED rather than repaired: a snapshot restore or
 *  an import. Both carry a whole file that did not come from the empty thing
 *  the failed load left in memory. */
function unblockKanbanFile(id: string): void {
  unreadableFiles.delete(id);
  reportedSkips.delete(id);
}

function skipWrite(id: string, describe: string): boolean {
  if (!unreadableFiles.has(id)) return false;
  if (!reportedSkips.has(id)) {
    reportedSkips.add(id);
    flash(`Kanban is not saving ${describe}: that file could not be read.`, "error", 9000);
  }
  return true;
}

async function loadAll(): Promise<void> {
  try {
    // Where the attachment files live. Asked for once, because every card that
    // shows a picture needs it and only the back end knows the answer.
    setAttachmentsRoot(await invoke<string>("kanban_attachments_dir"));
    backgroundsRoot = await invoke<string>("kanban_backgrounds_dir");
    await loadSettings();
    await loadRecords();
  } catch (err) {
    devError("[kanban] load failed", err);
    flash(`Couldn't load Kanban data: ${String(err)}`, "error", 8000);
  } finally {
    // Set even on failure, so the tool still works. This is no longer what
    // stands between a failed load and an overwrite: the file that failed is
    // in unreadableFiles and writeDirty skips it, which is a block on the one
    // file rather than on everything the user does next.
    storeLoaded = true;
  }
  applySettingsToForm();
  renderAll();
}

async function loadSettings(): Promise<void> {
  try {
    const parsed = await loadToolJson<Partial<KbSettings> | null>("kanban", "settings");
    kbSettings = normalizeSettings(parsed ?? {});
  } catch (err) {
    // Preferences, so the defaults are a usable screen. The store has already
    // said so and blocked the write; this only keeps the rest of the load
    // going, since a preferences file has nothing to do with the boards.
    devError("[kanban] settings load failed", err);
    kbSettings = normalizeSettings({});
    unreadableFiles.add("settings");
  }
}

/** The index, then every board's contents.
 *
 *  Every board rather than the open one, because the gallery shows real card
 *  counts and overdue badges for every board: loading on demand would mean
 *  every tile saying "open me to find out". */
async function loadRecords(): Promise<void> {
  await loadIndex();
  for (const board of boards) await loadBoardContents(board);
  reconcile();
  for (const board of boards) sweepBoardAttachments(board.id);
}

/** The board list and the default tag vocabulary. */
async function loadIndex(): Promise<void> {
  let parsed: Partial<KanbanIndex>;
  try {
    parsed = ((JSON.parse(await invoke<string>("load_kanban_index")) ?? {}) as Partial<KanbanIndex>);
  } catch (err) {
    // No board list, so nothing below finds any boards and the gallery is
    // empty. The file itself is left exactly as it is.
    blockKanbanFile("index", "the board list (kanban/kanban-index.json)", err);
    parsed = {};
  }

  globalTagCategories = Array.isArray(parsed.tagCategories)
    ? parsed.tagCategories.map(normalizeTagCategory).filter((c): c is TagCategory => c !== null)
    : [];
  globalTags = Array.isArray(parsed.tags)
    ? parsed.tags.map(normalizeTag).filter((t): t is Tag => t !== null)
    : [];
  boards = Array.isArray(parsed.boards)
    ? parsed.boards.map(normalizeBoardMeta).filter((b): b is Board => b !== null)
    : [];
  cards = [];
}

/** Pulls one board's columns and cards into memory. A board file that is not
 *  there yet is a brand-new board, not an error. */
async function loadBoardContents(board: Board): Promise<void> {
  let parsed: Partial<BoardContents> | null;
  try {
    parsed = JSON.parse(await invoke<string>("load_kanban_board", { boardId: board.id }));
  } catch (err) {
    /* A board file that is not THERE is a brand-new board and comes back as
       the empty shape, which parses. One that is there and will not parse is a
       board whose cards are still on disk, and it opens empty. Writing that
       empty board back is what this stops. */
    blockKanbanFile("board", `the board "${board.name}"`, err);
    unreadableFiles.add(board.id);
    parsed = null;
  }
  const contents = normalizeContents(parsed ?? {});

  board.columns = contents.columns;
  board.nextCardNumber = contents.nextCardNumber;
  board.tagCategories = contents.tagCategories;
  board.tags = contents.tags;
  board.overrides = contents.overrides;

  // Replace rather than append, so re-loading a board (after a restore, say)
  // cannot leave two copies of the same card in the array.
  cards = cards.filter((c) => c.boardId !== board.id);
  for (const card of contents.cards) card.boardId = board.id;
  cards.push(...contents.cards);
}


/* -----------------------------------------------------------------------------
   SAVING
----------------------------------------------------------------------------- */

/** Marks the index: the board list and the default tag vocabulary. */
function markIndex(): void {
  dirtyIndex = true;
  queueSave();
}

function markSettings(): void {
  dirtySettings = true;
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
      lastOpenedAt: b.lastOpenedAt,
      openCount: b.openCount,
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
 *  This used to promise that a locked board was skipped rather than written,
 *  because its contents were not in memory and saving it would have put an
 *  empty board over a full one. Board encryption is gone and the loop below has
 *  no such check, so the promise described a guard that was not there, which is
 *  worse than no comment: the next person to touch this would have trusted it.
 *  Every board in `boards` now has its contents loaded, so writing any of them
 *  writes what is actually on it.
 */
/** The save currently running, or a settled promise when nothing is.
 *
 *  Saves are SERIALIZED through this rather than being allowed to overlap, and
 *  that is a correctness requirement rather than tidiness. flushSave() is used
 *  as a barrier by a snapshot restore, which replaces the state wholesale.
 *
 *  Without the chain, a flush that arrives while a debounced save is mid-await
 *  finds the dirty flags already cleared and returns at once, so it is not a
 *  barrier at all: the restore would then race the write it was waiting for. */
let saveChain: Promise<void> = Promise.resolve();

/** Queues a write of everything currently dirty, behind any write already in
 *  flight, and resolves when THIS one has finished. */
function saveNow(): Promise<void> {
  // The catch keeps one failed write from poisoning every later one. writeDirty
  // handles its own errors, so this only ever fires on something unforeseen.
  saveChain = saveChain.catch(() => {}).then(writeDirty);
  return saveChain;
}

async function writeDirty(): Promise<void> {
  if (!storeLoaded) return;
  /* The whole data folder is off limits this session. Asked here rather than
     relied on at the store, because the index and the board files go through
     Kanban's own commands and never reach it.

     Said ONCE. The startup gate has already explained it at length, and this
     runs every few seconds, but staying silent is worse than it sounds here:
     the edit is on screen. Tick a subtask and the bar moves, so without a word
     the only thing to conclude is that it saved. */
  const frozen = writesFrozen();
  if (frozen) {
    if (!frozenNoticeShown) {
      frozenNoticeShown = true;
      flash(`Kanban is not saving: ${frozen}`, "error", 12000);
    }
    return;
  }

  /* Everything that is dirty is taken and CLEARED before the write, so an edit
     made while the write is in flight marks itself dirty again rather than
     being cleared along with the one that is landing. Put back on failure. */
  const boardIds = [...dirtyBoards];
  const goneBoards = [...deletedBoards];
  const wantIndex = dirtyIndex;
  const wantSettings = dirtySettings;
  dirtyBoards.clear();
  deletedBoards.clear();
  dirtyIndex = false;
  dirtySettings = false;

  try {
    if (wantSettings && !skipWrite("settings", "your Kanban preferences")) {
      await saveToolJson("kanban", "settings", kbSettings);
    }
    /* The index goes FIRST. Every write snapshots what it is replacing, and a
       board's contents and the index entry naming it are only meaningful as a
       pair; a snapshot holding cards for a board the index has never heard of
       restores nothing you can reach. */
    if (wantIndex && !skipWrite("index", "the board list")) {
      await invoke("save_kanban_index", { data: JSON.stringify(buildIndex()) });
    }
    for (const id of boardIds) {
      const board = getBoard(id);
      if (!board) continue;
      if (skipWrite(id, `the board "${board.name}"`)) continue;
      await invoke("save_kanban_board", {
        boardId: id,
        data: JSON.stringify(buildContents(board)),
      });
    }
    for (const id of goneBoards) {
      await invoke("delete_kanban_board", { boardId: id });
    }
  } catch (err) {
    devError("[kanban] save failed", err);
    // Put it all back: an edit that failed to write is still an unsaved edit,
    // and the next save should try again rather than pretend it landed.
    if (wantSettings) dirtySettings = true;
    if (wantIndex) dirtyIndex = true;
    for (const id of boardIds) dirtyBoards.add(id);
    for (const id of goneBoards) deletedBoards.add(id);
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

/* -----------------------------------------------------------------------------
   KEEPING THE BOARD IN STEP
   -----------------------------------------------------------------------------
   The board behind the card modal has to show what the card now says. This used
   to be a renderAll() written out at each place that changed something, which
   is a rule nobody can keep: there are 46 writes to a card in this file and six
   of them remembered. Editing a title updated the board; ticking a subtask did
   not, and the card behind sat wrong until the modal closed.

   So it hangs off stampCard() instead, which every one of those 46 already goes
   through, exactly as queueSave() does. Nothing has to remember, and a write
   added later is covered the day it is written.

   DEBOUNCED, and for the same reason the save is: typing a title fires one of
   these per keystroke, and redrawing every column on every letter is work
   nobody asked for. Short enough that leaving a field feels immediate.
----------------------------------------------------------------------------- */

const BOARD_REFRESH_DEBOUNCE_MS = 120;

let boardRefreshTimer: number | null = null;

function queueBoardRefresh(): void {
  if (boardRefreshTimer !== null) clearTimeout(boardRefreshTimer);
  boardRefreshTimer = window.setTimeout(() => {
    boardRefreshTimer = null;
    /* NEVER MID-DRAG. A drag moves the card's element around the DOM and
       commits on dragend; rebuilding the board underneath it would replace the
       very element the pointer is holding, and the drag would die halfway
       across the board. dragend commits and redraws, so nothing is lost by
       waiting: the refresh is dropped rather than deferred. */
    if (dragCardId) return;
    renderAll();
  }, BOARD_REFRESH_DEBOUNCE_MS);
}

/** Writes a queued edit NOW rather than letting it wait. Called before anything
 *  that replaces state wholesale (a snapshot restore) or that takes the
 *  so nothing is left sitting in the debounce while the state it describes is
 *  replaced underneath it. */
export async function flushSave(): Promise<void> {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  await saveNow();
}

/* -----------------------------------------------------------------------------
   NORMALIZATION
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
     neighbors it already knows about respects both the arrangement the user
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
    defaultSort: normalizeSortRules(raw.defaultSort) ?? base.defaultSort,
    openCardsInEditMode: bool(raw.openCardsInEditMode, base.openCardsInEditMode),
    overdueWarn: bool(raw.overdueWarn, base.overdueWarn),
  };
}

/** Sort rules from a file. Returns null for "the file did not say", which is
 *  what lets a board override fall back to the default rather than to nothing.
 *  A rule naming a field this build does not know is dropped: the alternative
 *  is a sort that silently does nothing and cannot be explained. */
function normalizeSortRules(raw: unknown): SortRule[] | null {
  if (!Array.isArray(raw)) return null;
  const known = new Set<string>(["priority", "effort", "number", "name", "due", "created", "updated"]);
  const out: SortRule[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as { field?: unknown; dir?: unknown };
    const dir: "asc" | "desc" = r.dir === "asc" ? "asc" : "desc";
    if (typeof r.field === "string" && known.has(r.field)) {
      out.push({ field: r.field as SortField, dir });
    } else if (
      r.field && typeof r.field === "object" &&
      typeof (r.field as { category?: unknown }).category === "string"
    ) {
      out.push({ field: { category: (r.field as { category: string }).category }, dir });
    }
  }
  return out;
}

export function normalizeColorMode(raw: unknown): CardColorMode | null {
  return raw === "manual" || raw === "tag" || raw === "priority" ? raw : null;
}

export function normalizeTextColor(raw: unknown): CardTextColor {
  return raw === "light" || raw === "dark" ? raw : "auto";
}

/**
 * A card's stored level, KEPT AS WRITTEN rather than checked against the
 * ladder that happens to be loaded.
 *
 * This deliberately does not ask whether the level still exists. Cards are
 * normalized as each board file is read, and dropping an id the settings file
 * does not currently list would blank the card's priority on load and write
 * that back out on the next edit. The two ways to reach that state are exactly
 * the two where the data must survive: a settings file that failed to read
 * (which blocks writing settings, but not boards), and a snapshot restore that
 * brings back one file and not the other.
 *
 * So an unknown id is carried, and the DISPLAY side answers for it: it draws
 * no chip and sorts as unset, which reads exactly like "not set" while the id
 * is still in the file. Put the level back and the cards wearing it come back
 * with it.
 */
export function normalizeLevelId(raw: unknown): LevelId {
  if (typeof raw !== "string") return NO_LEVEL;
  const trimmed = raw.trim().slice(0, 64);
  return trimmed || NO_LEVEL;
}

export function normalizePriority(raw: unknown): Priority {
  return normalizeLevelId(raw);
}

export function normalizeEffort(raw: unknown): Effort {
  return normalizeLevelId(raw);
}

/**
 * One scale's ladder, from whichever shape the settings file is in.
 *
 * TWO SHAPES, because v0.7 wrote a pair of maps keyed by the five fixed rungs
 * and this writes a list. The legacy pair is read into the shipped ladder by
 * id, which is what makes a rename or a recolor made before this survive: the
 * ids never changed, only the shape around them did.
 *
 * A row with no usable id is dropped rather than given one, because an invented
 * id matches no card and would draw an empty rung nothing could be on. A file
 * with no usable rows at all falls back to the defaults, on the grounds that a
 * tool whose Priority picker offers only "None" is broken rather than
 * configured.
 */
function normalizeScaleLevels(
  rawLevels: unknown,
  legacyLabels: unknown,
  legacyColors: unknown,
  defaults: readonly ScaleLevel[],
): ScaleLevel[] {
  const out: ScaleLevel[] = [];
  const seen = new Set<string>([NO_LEVEL]);

  const take = (id: unknown, name: unknown, color: unknown, fallback: ScaleLevel | null): void => {
    if (typeof id !== "string") return;
    const levelId = id.trim().slice(0, 64);
    if (!levelId || seen.has(levelId)) return;
    if (out.length >= MAX_SCALE_LEVELS) return;
    seen.add(levelId);
    const trimmed = typeof name === "string" ? name.trim().slice(0, MAX_LEVEL_NAME_LEN) : "";
    out.push({
      id: levelId,
      name: trimmed || fallback?.name || levelId,
      color: normalizeColor(color, fallback?.color ?? DEFAULT_TAG_COLOR),
    });
  };

  if (Array.isArray(rawLevels)) {
    for (const row of rawLevels) {
      if (!row || typeof row !== "object") continue;
      const level = row as Partial<ScaleLevel>;
      take(level.id, level.name, level.color, defaults.find((d) => d.id === level.id) ?? null);
    }
  } else {
    const labels = (legacyLabels ?? {}) as Record<string, unknown>;
    const colors = (legacyColors ?? {}) as Record<string, unknown>;
    for (const level of defaults) take(level.id, labels[level.id], colors[level.id], level);
  }

  return out.length > 0 ? out : defaults.map((l) => ({ ...l }));
}

/** What the absence of a level is called. v0.7 kept this in the labels map
 *  under the reserved id, so that is where it is looked for when the new field
 *  is missing. */
function normalizeNoneLabel(raw: unknown, legacyLabels: unknown): string {
  const direct = typeof raw === "string" ? raw.trim().slice(0, MAX_LEVEL_NAME_LEN) : "";
  if (direct) return direct;
  const legacy = (legacyLabels ?? {}) as Record<string, unknown>;
  const old = legacy[NO_LEVEL];
  const trimmed = typeof old === "string" ? old.trim().slice(0, MAX_LEVEL_NAME_LEN) : "";
  return trimmed || DEFAULT_NONE_LABEL;
}

export function normalizeSettings(raw: Partial<KbSettings>): KbSettings {
  return {
    // overdueWarn is board-scoped now, so normalizeScoped reads it. A second
    // line for it here would be the same field read twice, and the day the two
    // disagreed the one nearer the bottom would silently win.
    ...normalizeScoped(raw, DEFAULT_SETTINGS),
    boardSort: normalizeBoardSort(raw.boardSort),
    defaultColumns:
      typeof raw.defaultColumns === "string"
        ? raw.defaultColumns.slice(0, 400)
        : DEFAULT_SETTINGS.defaultColumns,
    defaultBoardName:
      typeof raw.defaultBoardName === "string" ? raw.defaultBoardName.slice(0, 120) : "",
    // The two legacy maps are read here and nowhere else. They are not fields
    // on KbSettings any more, so they arrive as strays on the parsed object.
    priorityLevels: normalizeScaleLevels(
      raw.priorityLevels,
      (raw as Record<string, unknown>).priorityLabels,
      (raw as Record<string, unknown>).priorityColors,
      DEFAULT_PRIORITY_LEVELS,
    ),
    priorityNoneLabel: normalizeNoneLabel(
      raw.priorityNoneLabel,
      (raw as Record<string, unknown>).priorityLabels,
    ),
    effortLevels: normalizeScaleLevels(
      raw.effortLevels,
      (raw as Record<string, unknown>).effortLabels,
      (raw as Record<string, unknown>).effortColors,
      DEFAULT_EFFORT_LEVELS,
    ),
    effortNoneLabel: normalizeNoneLabel(
      raw.effortNoneLabel,
      (raw as Record<string, unknown>).effortLabels,
    ),
  };
}

/** A stored board sort, checked against the modes that exist.
 *
 *  There is deliberately no rename map here, unlike RENAMED_SOUND_PACKS or
 *  RENAMED_TOOL_KEYS. Board sorting has not shipped, so "classic" cannot be
 *  sitting in anyone's settings file; a map for it would be permanent
 *  machinery guarding a value that never existed in the wild. Anything
 *  unrecognized, that name included, falls back to the default. */
function normalizeBoardSort(raw: unknown): BoardSortMode {
  if (typeof raw !== "string") return DEFAULT_SETTINGS.boardSort;
  return BOARD_SORT_MODES.some((m) => m.mode === raw)
    ? (raw as BoardSortMode)
    : DEFAULT_SETTINGS.boardSort;
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
  /* EVERY BOOLEAN IN BoardScopedSettings, and adding one there means adding it
     here. A key missing from this list is read back as absent, so the board
     silently falls back to the tool default and the setting looks like it never
     saved. openCardsInEditMode was missing exactly that way. A test now pins
     this list to the interface so the next one cannot go quiet. */
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
    "openCardsInEditMode",
    "overdueWarn",
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
  /* An EMPTY list is a real answer here and has to survive: "this board sorts
     nothing, whatever the default says" is a decision, and dropping it would
     put the board back on a default it had explicitly stepped away from. So
     the test is whether the file had the key at all, not whether it had
     anything in it. */
  if (Array.isArray(src.defaultSort)) {
    out.defaultSort = normalizeSortRules(src.defaultSort) ?? [];
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
    // A done column stamps Completed, so it keeps no stage of its own.
    stage: c.isDone !== true && (c.stage === "started" || c.stage === "testing") ? c.stage : null,
    collapsed: c.collapsed === true,
    // null, not [], for a column that has never been sorted: absent means
    // "follow the board", and an empty list means "manual, and I meant it".
    sort: normalizeSortRules(c.sort),
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
    // Absent means never opened, which the sorts read as "rank last". Not
    // defaulted to `now`: that would tell Most Recent every board on a fresh
    // install was just used.
    lastOpenedAt: typeof b.lastOpenedAt === "number" ? b.lastOpenedAt : undefined,
    openCount: typeof b.openCount === "number" ? b.openCount : undefined,
    columns: [],
    nextCardNumber: 1,
    tagCategories: [],
    tags: [],
    overrides: {},
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

/** An attachment record from disk. The id is the whole thing: it names the file
 *  as well as the record, so a record without one has nothing to point at and
 *  is dropped rather than kept as a row that can only ever say "missing". */
function normalizeAttachment(raw: unknown): Attachment | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Partial<Attachment>;
  if (typeof a.id !== "string" || !a.id) return null;
  // The id becomes a filename, so it is held to the same alphabet Rust holds
  // board ids to. A hand-edited file cannot introduce a separator here.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(a.id)) return null;
  const now = Date.now();
  return {
    id: a.id,
    // A record hand-edited empty still has to show as something clickable.
    name: trimTo(a.name, 200) || "file",
    size: typeof a.size === "number" && a.size >= 0 ? Math.floor(a.size) : 0,
    addedAt: typeof a.addedAt === "number" ? a.addedAt : now,
  };
}

function normalizeAttachments(raw: unknown): Attachment[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeAttachment)
    .filter((a): a is Attachment => a !== null)
    .slice(0, MAX_ATTACHMENTS);
}

function normalizeComment(raw: unknown): CardComment | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Partial<CardComment>;
  if (typeof c.id !== "string" || !c.id) return null;
  const body = trimTo(c.body, MAX_COMMENT_LEN);
  const attachments = normalizeAttachments(c.attachments);
  // A comment with neither words nor files is not a comment. Dropping it here
  // is what stops an empty row appearing under a card with nothing to remove.
  if (!body.trim() && attachments.length === 0) return null;
  const created = typeof c.createdAt === "number" ? c.createdAt : Date.now();
  return {
    id: c.id,
    body,
    attachments,
    createdAt: created,
    // Never earlier than createdAt, so "edited" is a real comparison rather
    // than an artifact of a hand-edited file.
    updatedAt:
      typeof c.updatedAt === "number" && c.updatedAt >= created ? c.updatedAt : created,
    createdBy: normalizeAuthor(c.createdBy),
  };
}

/** A date field is kept only if it is a real YYYY-MM-DD. Anything else becomes
 *  null rather than being carried through, because every duration in the tool
 *  is subtracted from these and a half-valid date would produce a number that
 *  looks real and is not. */
export function normalizeDay(raw: unknown): string | null {
  // A day and only a day: a time on a due date would be a promise the overdue
  // check does not keep, since it compares whole days.
  return typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw) && parseDay(raw) !== null
    ? raw
    : null;
}

/** A stage stamp: either shape, kept as written. Normalized to the T form so
 *  a value that arrived with a space (a hand-edited file, an agent) sorts and
 *  compares the same as one this app wrote. */
export function normalizeMoment(raw: unknown): string | null {
  if (typeof raw !== "string" || parseDay(raw) === null) return null;
  return raw.replace(" ", "T");
}

/** An author survives a round trip only if it is complete. A half-written one
 *  becomes absent, which reads as "the user made this": the safe direction,
 *  since the fallback grants an agent LESS than it might have had. */
/** An agent author and nothing else. What a COMMENT may carry: a comment
 *  arrives either from the person typing it or from an agent over the pipe,
 *  and there is no third way in. */
function normalizeAuthor(raw: unknown): AgentAuthor | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const a = raw as Partial<AgentAuthor>;
  if (a.kind !== "agent") return undefined;
  if (typeof a.by !== "string" || !a.by) return undefined;
  return { kind: "agent", by: a.by, label: trimTo(a.label, 80) || "Agent" };
}

/** A CARD's owner, which may also be set by hand to "external". Undefined is
 *  returned for the user, so the common case stores nothing. */
function normalizeCardAuthor(raw: unknown): CardAuthor | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const a = raw as { kind?: unknown; label?: unknown };
  if (a.kind === "external") {
    return { kind: "external", label: trimTo(a.label, 80) };
  }
  if (a.kind === "user") return { kind: "user" };
  return normalizeAuthor(raw);
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
    // Cards written before Effort existed have no field, and read as unset.
    effort: normalizeEffort(c.effort),
    tagIds: Array.isArray(c.tagIds) ? c.tagIds.filter((t) => typeof t === "string") : [],
    subtasks: Array.isArray(c.subtasks)
      ? c.subtasks
          .map(normalizeSubtask)
          .filter((s): s is Subtask => s !== null)
          .slice(0, MAX_SUBTASKS_PER_CARD)
      : [],
    // Absent from every card written before these existed, which is what the
    // empty-array fallback is for: an older board loads with no attachments
    // and no comments rather than failing to load. The Kanban has not shipped
    // in a release yet, so this covers development data rather than anyone
    // else's, but it costs nothing and it is the rule every other field here
    // already follows.
    attachments: normalizeAttachments(c.attachments),
    comments: Array.isArray(c.comments)
      ? c.comments
          .map(normalizeComment)
          .filter((x): x is CardComment => x !== null)
          .sort((a, b) => a.createdAt - b.createdAt)
          .slice(0, MAX_COMMENTS_PER_CARD)
      : [],
    dates: {
      // A target, so a calendar day and nothing else.
      due: normalizeDay(d.due),
      // Records of something that happened, so they carry the time it happened
      // at. A stamp written before they did is a bare date and stays one:
      // inventing a time for it would be inventing a fact.
      started: normalizeMoment(d.started),
      testing: normalizeMoment(d.testing),
      completed: normalizeMoment(d.completed),
    },
    archived: c.archived === true,
    createdAt: typeof c.createdAt === "number" ? c.createdAt : now,
    updatedAt: typeof c.updatedAt === "number" ? c.updatedAt : now,
    order: typeof c.order === "number" && Number.isFinite(c.order) ? c.order : 0,
    createdBy: normalizeCardAuthor(c.createdBy),
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
    const categoryIds = new Set(board.tagCategories.map((c) => c.id));
    board.tags = board.tags.filter((t) => categoryIds.has(t.categoryId));
    liveTagIdsByBoard.set(board.id, new Set(board.tags.map((t) => t.id)));
  }

  cards = cards.filter((card) => {
    const board = boardById.get(card.boardId);
    if (!board) return false;
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
export function resequence(boardId: string): void {
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

/* -----------------------------------------------------------------------------
   WHAT A RUNG IS CALLED HERE

   The names and colors themselves are in kanban-model.ts, which imports
   nothing. These two cannot be: they read kbSettings, because a board can
   rename its rungs, and a file that reads the tool's live state is not a
   leaf. So the shipped defaults live with the model and the override lives
   with the state that holds it.
----------------------------------------------------------------------------- */

/* -----------------------------------------------------------------------------
   READING A SCALE
   -----------------------------------------------------------------------------
   The ladders live in settings and settings are live state, so none of this is
   model: see standards section 9, and THE TWO SCALES in kanban-model.ts for
   what a ladder is.

   EVERY PLACE THAT SHOWS A RUNG GOES THROUGH HERE. Reading the shipped
   defaults directly would show the shipped name and quietly ignore a rename,
   which is the bug these functions exist to prevent, and now it would also
   show rungs this install has deleted.

   AN UNKNOWN ID IS "UNSET", not an error. normalizeLevelId keeps whatever a
   card was written with; this is the other half of that bargain, and it is why
   every lookup here answers for an id no ladder lists rather than asserting.
----------------------------------------------------------------------------- */

export function priorityLevels(): ScaleLevel[] {
  return kbSettings.priorityLevels;
}

export function effortLevels(): ScaleLevel[] {
  return kbSettings.effortLevels;
}

/** The rung itself, or null for NO_LEVEL and for an id this install has no
 *  rung for. */
export function priorityLevelOf(level: Priority): ScaleLevel | null {
  return kbSettings.priorityLevels.find((l) => l.id === level) ?? null;
}

export function effortLevelOf(level: Effort): ScaleLevel | null {
  return kbSettings.effortLevels.find((l) => l.id === level) ?? null;
}

/** What a priority is CALLED on this install. */
export function priorityLabel(level: Priority): string {
  return priorityLevelOf(level)?.name ?? kbSettings.priorityNoneLabel;
}

export function effortLabel(level: Effort): string {
  return effortLevelOf(level)?.name ?? kbSettings.effortNoneLabel;
}

/** A rung's color, or null where there is no rung to take one from. Null is
 *  the answer for "none" as well as for an unknown id: the absence of a level
 *  has no color, or every unset card would be painted gray as though gray were
 *  a level. */
export function priorityColorOf(level: Priority): string | null {
  return priorityLevelOf(level)?.color ?? null;
}

export function effortColorOf(level: Effort): string | null {
  return effortLevelOf(level)?.color ?? null;
}

/** Where a level sits on its ladder, for sorting. 0 is unset, which is what
 *  both NO_LEVEL and an unknown id come out as, so an unset card sorts below
 *  every rung rather than in the middle of them. */
export function priorityRank(level: Priority): number {
  return kbSettings.priorityLevels.findIndex((l) => l.id === level) + 1;
}

export function effortRank(level: Effort): number {
  return kbSettings.effortLevels.findIndex((l) => l.id === level) + 1;
}

/** One rung as a picker draws it. */
export interface LevelChoice {
  id: LevelId;
  label: string;
  color: string | null;
}

/** What a picker offers: the absence of a level first, then the ladder from
 *  lowest to highest. Built fresh on each call, because the ladder can be
 *  edited between one open and the next. */
export function priorityChoices(): LevelChoice[] {
  return [
    { id: NO_LEVEL, label: kbSettings.priorityNoneLabel, color: null },
    ...kbSettings.priorityLevels.map((l) => ({ id: l.id, label: l.name, color: l.color })),
  ];
}

export function effortChoices(): LevelChoice[] {
  return [
    { id: NO_LEVEL, label: kbSettings.effortNoneLabel, color: null },
    ...kbSettings.effortLevels.map((l) => ({ id: l.id, label: l.name, color: l.color })),
  ];
}

/**
 * A level NAMED from outside the app, as an agent names one, resolved to its
 * id. Null means no such level.
 *
 * BY NAME FIRST, because a name is the only part of a level anyone outside can
 * see: the ids were readable while they were the five shipped words, and a
 * level made on this screen has a generated one nobody could guess. By id
 * second, so a request written against an older build, or copied out of a
 * card's own record, still lands.
 *
 * The reserved id is accepted under its own name too, whatever that has been
 * renamed to, so "unset" reads the way the pickers show it.
 */
function findLevel(levels: ScaleLevel[], noneLabel: string, raw: string): LevelId | null {
  const needle = raw.trim().toLowerCase();
  if (!needle) return null;
  if (needle === NO_LEVEL || needle === noneLabel.toLowerCase()) return NO_LEVEL;
  const byName = levels.find((l) => l.name.toLowerCase() === needle);
  if (byName) return byName.id;
  return levels.find((l) => l.id.toLowerCase() === needle)?.id ?? null;
}

export function findPriorityLevel(raw: string): LevelId | null {
  return findLevel(kbSettings.priorityLevels, kbSettings.priorityNoneLabel, raw);
}

export function findEffortLevel(raw: string): LevelId | null {
  return findLevel(kbSettings.effortLevels, kbSettings.effortNoneLabel, raw);
}

/** What an outside caller may say, lowest rung to highest, with the unset rung
 *  first. Used for the agent's board summary and for the error it gets back
 *  when it names something else. */
export function priorityNames(): string[] {
  return priorityChoices().map((c) => c.label);
}

export function effortNames(): string[] {
  return effortChoices().map((c) => c.label);
}

/* =============================================================================
   DERIVED LOOKUPS
============================================================================= */

export function getBoard(id: string | null): Board | null {
  if (!id) return null;
  return boards.find((b) => b.id === id) ?? null;
}

export function getCard(id: string | null): Card | null {
  if (!id) return null;
  return cards.find((c) => c.id === id) ?? null;
}

export function getColumn(board: Board, columnId: string): Column | null {
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

export function getTag(id: string): Tag | null {
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
 *  no colored tag, has nothing to say, and a gray card would be saying
 *  something. It just looks like every other uncolored card until it has a
 *  reason not to. */
export function resolveCardColor(card: Card, board: Board | null): string | null {
  const mode = cardColorMode(card, board);
  if (mode === "manual") return card.color;
  // Null for "none" and for a level this install no longer has: both mean the
  // card has no priority to be painted by.
  if (mode === "priority") return priorityColorOf(card.priority);
  if (!board) return null;
  for (const tag of orderedCardTags(card, board)) {
    const color = tagColor(tag, board.tagCategories);
    if (color) return color;
  }
  return null;
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
export function effective(board: Board | null): BoardScopedSettings {
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
    defaultSort: kbSettings.defaultSort,
    openCardsInEditMode: kbSettings.openCardsInEditMode,
    overdueWarn: kbSettings.overdueWarn,
  };
  if (!board) return base;
  return { ...base, ...board.overrides };
}

/** The settings in force for the board a given card is on. */
export function effectiveForCard(card: Card): BoardScopedSettings {
  return effective(getBoard(card.boardId));
}

/** Live (non-archived) cards in one column, in board order. */
export function cardsInColumn(boardId: string, columnId: string): Card[] {
  return cards
    .filter((c) => c.boardId === boardId && c.columnId === columnId && !c.archived)
    .sort((a, b) => a.order - b.order);
}

export function liveCardsOnBoard(boardId: string): Card[] {
  return cards.filter((c) => c.boardId === boardId && !c.archived);
}

export function archivedCardsOnBoard(boardId: string): Card[] {
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
  if (card.subtasks.some((s) => s.text.toLowerCase().includes(q))) return true;
  // Comments and filenames are searched too. A card is often findable only by
  // something written on it after the fact ("the crash log Bob sent"), and a
  // filter that could not see those would quietly hide the card that has it.
  if (card.comments.some((c) => c.body.toLowerCase().includes(q))) return true;
  return allAttachments(card).some((a) => a.name.toLowerCase().includes(q));
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

export let currentView: KbView = "boards";
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
    // A selection belongs to the board it was made on. Carrying ids across
    // would mean a bulk action reaching cards that are not on screen.
    /* Arriving at a board is opening it, by whichever way you came: the
       gallery, making it, copying it, or the back button. It used to be
       counted by the gallery alone, so a board you made and then worked in
       never counted as recent. Only on an ARRIVAL, so redrawing the board
       already on screen is not another visit. */
    if (currentBoardId !== board.id) {
      clearCardSelection(false);
      recordBoardUsage(board);
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
    clearCardSelection(false);
    currentBoardId = null;
    setTagScope(null);
  }

  currentView = view;
  applyViewVisibility();

  renderAll();
  pushKbHistory(view, currentBoardId ?? undefined);
}

/** The ONE place that decides which of the two panes is on screen. There were
 *  two such places once, and they disagreed with each other; everything that
 *  changes the view goes through here now. */
function applyViewVisibility(): void {
  viewBoards.style.display = currentView === "boards" ? "" : "none";
  viewBoard.style.display = currentView === "board" ? "" : "none";
  boardSetupBtn.style.display = currentView === "board" ? "" : "none";
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
export function topOpenKanbanModal(): Modal | null {
  const stack = [
    _confirmModal,
    _lightboxModal,
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
    // Both scale screens, which were missing. The consequence was small and
    // real: Reset opens a confirm, and kbConfirm closes whatever it finds open
    // here so it REPLACES it. Finding nothing, it stacked on top of the scale
    // editor and the confirm's own reopen then opened a modal that had never
    // closed. Delete first, since it opens from the editor.
    _scaleDeleteModal,
    _scaleModal,
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

export function renderAll(): void {
  if (currentView === "boards") renderGallery();
  else renderBoardView();
  refreshOverdueAttention();
}

/** Flags the tool while anything is past its due date, through the same
 *  sidebar pulse + header notice Auto-Backup and Budget use, so "something
 *  needs you" reads the same wherever it comes from. */
function refreshOverdueAttention(): void {
  const todayStr = today();
  /* Counted board by board, because the warning is a board's own answer now. A
     board with it off contributes nothing even while its cards are genuinely
     overdue, which is the point: it is a board nobody wants shouted at about. */
  const overdue = cards.filter(
    (c) => effectiveForCard(c).overdueWarn && isOverdue(c, todayStr),
  ).length;

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
  // Re-applied on every render rather than only when the mode is picked, so
  // Most Recent and Most Used stay live. A no-op under Custom and a no-op when
  // nothing moved, so this is not a write per repaint.
  applyBoardSortMode();

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
    bg.style.backgroundImage = `url("${backgroundSrc(board.background)}")`;
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
  // in Backlog, nothing in Testing) is recognizable at a glance in a way a
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
  {
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

  /* DRAGGABLE IN PLACE. A tile is a card in a grid, and everything else in
     this tool that sits in an order is dragged where it sits; making people
     open a modal to reorder the thing already in front of them was the odd one
     out. The modal stays, because it is where the sort MODE lives and because
     a long gallery is easier to rearrange as a list.

     Only while the gallery is unfiltered: the search box hides tiles, and
     dropping between two visible ones says nothing about where it lands among
     the ones you cannot see. */
  if (boards.length > 1 && boardSearchInput.value.trim() === "") {
    attachBoardTileDrag(tile, board);
  }

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

/** Which tile is mid-drag, shared by every tile's dragover handler. */
let boardTileDragId: string | null = null;

/**
 * Drag-to-reorder for one gallery tile.
 *
 * A GRID, not a list, so "before or after" is decided on the horizontal
 * midpoint like the tag chips rather than the vertical one the stacked lists
 * use. Tiles wrap, and measuring top/bottom would put every drop on the same
 * side of whatever tile the cursor was over.
 *
 * The tile is also a click target that opens the board. HTML5 drag and drop
 * suppresses the click that would follow a real drag, so the two do not fight;
 * what needs care is the Edit button inside it, which stops its own click but
 * would still be dragged by. It is left alone: dragging from anywhere on the
 * tile including the button is the same gesture.
 */
function attachBoardTileDrag(tile: HTMLElement, board: Board): void {
  tile.draggable = true;

  tile.addEventListener("dragstart", (e) => {
    boardTileDragId = board.id;
    tile.classList.add("kb-dragging");
    e.dataTransfer?.setData("text/plain", board.name);
  });

  // Committed on dragend rather than drop, so a release anywhere still lands
  // the order. Same rule as every other drag list in this tool.
  tile.addEventListener("dragend", () => {
    tile.classList.remove("kb-dragging");
    boardTileDragId = null;
    commitBoardOrderFromDom(boardGrid, ".kb-board-tile");
  });

  tile.addEventListener("dragover", (e) => {
    if (!boardTileDragId || boardTileDragId === board.id) return;
    e.preventDefault();
    const dragged = boardGrid.querySelector<HTMLElement>(
      `.kb-board-tile[data-board-id="${CSS.escape(boardTileDragId)}"]`,
    );
    if (!dragged) return;
    const rect = tile.getBoundingClientRect();
    const before = e.clientX < rect.left + rect.width / 2;
    boardGrid.insertBefore(dragged, before ? tile : tile.nextSibling);
  });
}

/* =============================================================================
   BOARD VIEW
============================================================================= */

/** Entering a board from the gallery. */
function openBoardFromGallery(boardId: string): void {
  const board = getBoard(boardId);
  if (!board) return;
  // showKbView records the visit, as it does for every way into a board.
  showKbView("board", board.id);
}

export function renderBoardView(): void {
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
  boardBgLayer.style.backgroundImage = `url("${backgroundSrc(bg)}")`;
  boardBgLayer.style.filter = `blur(${bg.blur}px) brightness(${bg.brightness}%)`;
  // Same edge-bleed correction as the gallery tile; see the note there.
  boardBgLayer.style.transform = `scale(${1 + bg.blur / 90})`;
  viewBoard.classList.add("kb-has-bg");
}

/** The absolute path of kanban-backgrounds/, learned once from the back end
 *  in loadAll(). Needed because the asset protocol takes a real path, and
 *  only the back end knows where the data directory is. */
let backgroundsRoot = "";

/**
 * Where a board background actually is.
 *
 * ALWAYS REBUILT FROM THE FILENAME, never used as stored. A background used to
 * be recorded as a whole absolute path, and when the data folder was split into
 * one folder per tool, the file moved and every record kept pointing at where
 * it used to be. The board then drew a background that was not there, with
 * nothing on screen to say why.
 *
 * Taking the last path segment and joining it to the folder the back end
 * reports means the record only has to remember which image, and the app
 * answers where. This is the same rule attachments follow, and for the same
 * reason: a stored path is a guess about the future that a tidy-up can break.
 */
function backgroundSrc(bg: BoardBackground): string {
  // lastIndexOf twice rather than a regex character class. The class that
  // belongs here is [\\/], and a single missing backslash makes it match only
  // forward slashes, which silently does nothing to a Windows path and hands
  // back the whole stale record. This form cannot be got wrong quietly.
  const cut = Math.max(bg.path.lastIndexOf("/"), bg.path.lastIndexOf("\\"));
  const file = cut === -1 ? bg.path : bg.path.slice(cut + 1);
  return convertFileSrc(`${backgroundsRoot}/${file}`);
}

function renderBoardCounts(board: Board): void {
  const todayStr = today();
  const live = liveCardsOnBoard(board.id);
  const shown = live.filter((c) => cardMatchesFilters(c, todayStr)).length;
  const archived = archivedCardsOnBoard(board.id).length;

  // Said beside the total rather than as its own piece, because it is a part
  // of that number, and only while there is a selection to count.
  const selected = selectedCards().filter((c) => c.boardId === board.id).length;

  const bits: string[] = [];
  bits.push(
    (anyFilterActive()
      ? `${shown} of ${live.length} cards`
      : `${live.length} ${live.length === 1 ? "card" : "cards"}`) +
      (selected > 0 ? ` (${selected} selected)` : ""),
  );
  if (archived > 0) bits.push(`${archived} archived`);
  boardCountsEl.textContent = bits.join(" · ");

  filterBtn.classList.toggle("active", anyFilterActive());
}

/** Which board the columns on screen belong to, so a scroll position is only
 *  ever put back on the board it was taken from. */
let renderedBoardId: string | null = null;

/**
 * Draws every column, KEEPING WHERE YOU WERE.
 *
 * This rebuilds the whole column strip, and the strip is where the scrolling
 * happens: `.kb-columns` scrolls sideways and each `.kb-column-body` scrolls
 * down. Throwing the DOM away takes both with it, so closing a card modal sent
 * every column back to the top and the board back to the far left. Any card
 * far enough down a column to need scrolling to was, by definition, a card you
 * then had to scroll back to, every single time.
 *
 * The fix is here rather than at the modal, because the modal is not what did
 * it. Every redraw did: ticking a subtask, a filter change, an agent editing a
 * card. Fixing the one that was noticed would have left the rest.
 *
 * A board SWITCH deliberately starts fresh. Column ids belong to one board so
 * they never match another's, and the sideways position is only restored when
 * the board is the same one, which is what renderedBoardId is for.
 */
function renderColumns(board: Board): void {
  const todayStr = today();
  const sameBoard = renderedBoardId === board.id;

  /* Read BEFORE replaceChildren(). Emptying the strip collapses its width to
     nothing, and the browser clamps scrollLeft to 0 as it does, so this cannot
     be read back afterwards. */
  const keptLeft = sameBoard ? columnsEl.scrollLeft : 0;
  const keptTops = new Map<string, number>();
  if (sameBoard) {
    for (const el of columnsEl.querySelectorAll<HTMLElement>(".kb-column")) {
      const id = el.dataset.columnId;
      const body = el.querySelector<HTMLElement>(".kb-column-body");
      if (id && body && body.scrollTop > 0) keptTops.set(id, body.scrollTop);
    }
  }

  columnsEl.replaceChildren();
  renderedBoardId = board.id;

  if (board.columns.length === 0) {
    columnsEmpty.style.display = "";
    columnsEmpty.textContent = "This board has no columns yet. Add one to start.";
    return;
  }
  columnsEmpty.style.display = "none";

  for (const column of board.columns) {
    columnsEl.appendChild(buildColumn(board, column, todayStr));
  }

  /* Put back what was there. A column holding less than it did (a card was
     deleted, or a filter now hides it) clamps to its new bottom on its own,
     which is the right answer: it goes as close to where you were as there is
     room for, rather than refusing. */
  for (const el of columnsEl.querySelectorAll<HTMLElement>(".kb-column")) {
    const id = el.dataset.columnId;
    const top = id ? keptTops.get(id) : undefined;
    if (top === undefined) continue;
    const body = el.querySelector<HTMLElement>(".kb-column-body");
    if (body) body.scrollTop = top;
  }
  if (keptLeft > 0) columnsEl.scrollLeft = keptLeft;
}

/* =============================================================================
   SORTING A COLUMN
   -----------------------------------------------------------------------------
   A column is a hand-ordered list by default, and that is the point of a board:
   the order means something you decided. But "show me this lot by priority, then
   by type, then alphabetically" is a question you want answered without losing
   the arrangement you built, and dragging forty cards to ask it is not an
   answer.

   So a sort is a VIEW, not a rewrite. `card.order` is never touched. The column
   holds a list of rules, the cards are drawn through them, and clearing the
   rules puts the hand-made order straight back, unchanged, however long the
   sort was on.

   LAYERED, because one key is rarely the question. The rules apply in order and
   the next one only speaks when the previous ties, which is what makes
   "priority, then type, then name" mean what it sounds like.

   THE MENU IS THE EDITOR. Each field in the Sort submenu cycles
   off -> descending -> ascending -> off, and a field switched on joins the end
   of the list. The submenu shows each field's place and direction, so the whole
   rule set is visible in the thing you use to change it, and there is no
   separate screen to open, fill in and close.

   A DROP CLEARS THE SORT. Dragging a card into a sorted column is an explicit
   statement about where that card goes, and honoring it while a sort is on
   would mean the card jumping somewhere else the instant it lands.
============================================================================= */

/** The fields offered in the menu, in the order they are listed. Tag categories
 *  are appended per board, since they are the board's own vocabulary. */
const SORT_FIELDS: { field: SortField; label: string }[] = [
  { field: "priority", label: "Priority" },
  { field: "effort", label: "Effort" },
  { field: "due", label: "Due Date" },
  { field: "number", label: "Card Number" },
  { field: "name", label: "Name" },
  { field: "created", label: "Created" },
  { field: "updated", label: "Last Edited" },
];

function sameField(a: SortField, b: SortField): boolean {
  if (typeof a === "object" && typeof b === "object") return a.category === b.category;
  return a === b;
}

/** A field's name. Takes the CATEGORY LIST rather than a board, because the
 *  same editor sets the tool-wide default, where the vocabulary is the global
 *  one and there is no board to read it off. */
function sortFieldLabel(field: SortField, categories: TagCategory[]): string {
  if (typeof field === "object") {
    return categories.find((c) => c.id === field.category)?.name ?? "Tag";
  }
  return SORT_FIELDS.find((f) => f.field === field)?.label ?? String(field);
}

/** One card's value for one field, as something comparable. Null sorts LAST
 *  whichever direction is asked for: "no due date" is not earlier or later than
 *  a date, it is the absence of one, and burying those at the bottom is what
 *  anyone means by "sort by due date". */
function sortValue(card: Card, field: SortField, board: Board): number | string | null {
  if (typeof field === "object") {
    /* The card's tag from this category, by the category's own order, so a
       Types category listed Bug, Improvement, Feature sorts in that order
       rather than alphabetically. A card with no tag from it sorts last. */
    const tags = board.tags.filter((t) => t.categoryId === field.category);
    const index = tags.findIndex((t) => card.tagIds.includes(t.id));
    return index === -1 ? null : index;
  }
  switch (field) {
    case "priority":
      return priorityRank(card.priority);
    case "effort":
      return effortRank(card.effort);
    case "number":
      return card.number;
    case "name":
      return card.title.trim().toLowerCase();
    case "due":
      return card.dates.due ?? null;
    case "created":
      return card.createdAt;
    case "updated":
      return card.updatedAt;
  }
}

/** Applies the rules. Returns a NEW array; the caller's order is untouched. */
function sortCards(list: Card[], rules: SortRule[], board: Board): Card[] {
  if (rules.length === 0) return list;
  const out = [...list];
  out.sort((a, b) => {
    for (const rule of rules) {
      const av = sortValue(a, rule.field, board);
      const bv = sortValue(b, rule.field, board);
      // Absent values go to the bottom in both directions. See sortValue.
      if (av === null && bv === null) continue;
      if (av === null) return 1;
      if (bv === null) return -1;
      let cmp = 0;
      if (typeof av === "string" && typeof bv === "string") cmp = av.localeCompare(bv);
      else cmp = (av as number) < (bv as number) ? -1 : (av as number) > (bv as number) ? 1 : 0;
      if (cmp !== 0) return rule.dir === "asc" ? cmp : -cmp;
    }
    /* Every rule tied, so the hand-made order breaks it. Falling back to this
       rather than leaving it to the sort's stability is what makes the result
       the same every time it is drawn. */
    return a.order - b.order;
  });
  return out;
}

/** The rules in force for a column: its own, or the board's default when it has
 *  none of its own. `null` on the column means "follow the board"; an empty
 *  array means "manual, whatever the board says". */
export function rulesForColumn(board: Board, column: Column): SortRule[] {
  return column.sort ?? effective(board).defaultSort ?? [];
}

/** Off -> descending -> ascending -> off, appending to the end when it turns on.
 *  One click is the common case (most urgent first), two is the other
 *  direction, three takes it back out. */
function cycleColumnSort(board: Board, column: Column, field: SortField): void {
  const rules = [...rulesForColumn(board, column)];
  const at = rules.findIndex((r) => sameField(r.field, field));
  if (at === -1) rules.push({ field, dir: "desc" });
  else if (rules[at]!.dir === "desc") rules[at] = { field, dir: "asc" };
  else rules.splice(at, 1);
  column.sort = rules;
  touchBoard(board);
  renderBoardView();
}

/** What a column's badge says: where its order comes from, in as few words as
 *  a badge can carry. "Board default" is a different answer from "Manual", and
 *  a row that cannot tell them apart is a row you have to open to read. */
function describeSortBadge(column: Column): string {
  if (column.sort === null || column.sort === undefined) return "Board Default";
  if (column.sort.length === 0) return "Manual";
  return "Customized";
}

/** A rule set as a sentence, for the column header's sorted-by tooltip. The
 *  Board Setup row and the column editor say only whether a sort is set (see
 *  WHAT A SETTINGS BADGE SAYS), so this is the one place rules are spelled
 *  out; anything that comes to spell them out too calls this rather than
 *  writing its own. */
function describeSortRules(rules: SortRule[], categories: TagCategory[]): string {
  if (rules.length === 0) return "Manual, the order you dragged them into";
  return rules
    .map((r) => `${sortFieldLabel(r.field, categories)} ${r.dir === "desc" ? "high to low" : "low to high"}`)
    .join(", then ");
}

/* -----------------------------------------------------------------------------
   WHAT A SETTINGS BADGE SAYS

   Two words at most. A badge is read at a glance to answer one question, "has
   anyone touched this?", and the answer to that is never a sentence. The detail
   belongs on the screen the Customize button opens, which is where someone has
   already decided they want the detail.

   These used to spell the whole rule set out, which made the badge as wide as
   the rules were long and pushed the row around every time they changed.
----------------------------------------------------------------------------- */

/* THE CHAIN, AND WHAT EACH LINK CAN SAY.

   Tool -> board -> column. Each level either follows the one above it or has an
   answer of its own, and NAMES the level it is following, so a badge tells you
   where to go to change it rather than only that you are not there yet.

   A list-valued setting has one more state than a plain one, and it is easy to
   miss: an EMPTY list is an answer. "This board sorts nothing" is a decision
   someone made, and it is not the same as "this board has not been asked". The
   board badge used to collapse those two into "Customized", so a board
   deliberately left manual looked identical to one carrying three sort levels.

   There is no "follow the tool" at column level. A column's parent is its
   board, and a board that is following the tool passes the tool's answer down
   unchanged, so the tool default already reaches every column that has not been
   overridden. A column binding past its board to the tool would be a fourth
   state no other setting in this app has, to answer a question ("ignore this
   board's sort but not the tool's") that copying the rules answers already. */

/** For a TOOL-level setting: is this still what the app ships with? */
function toolBadge(isDefault: boolean): string {
  return isDefault ? "Default" : "Customized";
}

/** For a board-level setting with only two states, like Card Layout, where an
 *  empty list is not a meaningful answer. */
function boardBadge(hasOverride: boolean): string {
  return hasOverride ? "Customized" : "Tool Default";
}

/** For the board's column sort, which has three: following the tool, its own
 *  rules, or deliberately none. */
function describeBoardSortBadge(board: Board): string {
  const own = board.overrides.defaultSort;
  if (own === undefined) return "Tool Default";
  if (own.length === 0) return "Manual";
  return "Customized";
}

/** The Sort submenu for one column. Each row says where that field sits in the
 *  order and which way it runs, so the rule set is readable from the menu. */
function columnSortMenu(board: Board, column: Column): MenuItem[] {
  const rules = rulesForColumn(board, column);
  const fields: { field: SortField; label: string }[] = [
    ...SORT_FIELDS,
    ...board.tagCategories.map((c) => ({ field: { category: c.id }, label: c.name })),
  ];

  const items: MenuItem[] = fields.map(({ field, label }) => {
    const at = rules.findIndex((r) => sameField(r.field, field));
    const rule = at === -1 ? null : rules[at]!;
    /* An active field reads "Priority ↓", and gains its place in the order only
       once there IS an order to have a place in. A lone "1" in front of the
       only rule is noise. */
    const mark = rule ? `${rules.length > 1 ? `${at + 1}. ` : ""}${label} ${rule.dir === "desc" ? "↓" : "↑"}` : label;
    return {
      label: mark,
      onClick: () => cycleColumnSort(board, column, field),
    };
  });

  return [
    {
      label: rules.length === 0 ? "Manual order (drag to arrange)" : "Clear sort, back to manual",
      disabled: rules.length === 0,
      onClick: () => {
        column.sort = [];
        touchBoard(board);
        renderBoardView();
      },
    },
    ...(column.sort !== null && column.sort !== undefined
      ? [{
          label: "Follow the board default",
          onClick: () => {
            column.sort = null;
            touchBoard(board);
            renderBoardView();
          },
        }]
      : []),
    /* The menu is the quick way to flip one level. Reordering levels, and
       reading the whole rule set at once, is what the editor is for. */
    {
      label: "Customize…",
      onClick: () =>
        openSortEditor({ kind: "column", boardId: board.id, columnId: column.id }),
    },
    // The menu's own separator, not a row of dashes standing in for one.
    { separator: true },
    ...items,
  ];
}

/* -----------------------------------------------------------------------------
   THE SORT EDITOR

   One screen, two things it can be pointed at: the board's DEFAULT, set in
   Board Setup, and one COLUMN's own rules, set from that column's settings. The
   menu on a column header stays as the quick way to add or flip a level without
   opening anything; this is where a layered rule set is actually built and
   rearranged, and where the board-wide answer is set at all.

   Two editors would have drifted. The rule set is the same shape in both cases
   and so is every question you can ask of it, so the difference is one target
   object and one sentence at the top.
----------------------------------------------------------------------------- */

/** What the editor is pointed at. Held rather than passed, because the modal's
 *  own buttons fire long after it was opened. */
type SortTarget =
  | { kind: "tool" }
  | { kind: "board"; boardId: string }
  | { kind: "column"; boardId: string; columnId: string };

let sortEditTarget: SortTarget | null = null;
/** Which level is being dragged, by its place in the list. */
let sortDragIndex: number | null = null;
/** Where to go back to when this closes, since it is reached from two places. */
let sortEditReturn: (() => void) | null = null;
let _sortModal: Modal | null = null;

/** The board the editor is working on, or null if it has gone. */
function sortEditBoard(): Board | null {
  if (!sortEditTarget || sortEditTarget.kind === "tool") return null;
  return getBoard(sortEditTarget.boardId);
}

/** The tag vocabulary the editor offers. A board's own for a board or a column,
 *  the global one for the tool default, which is the vocabulary a brand-new
 *  board starts from. */
function sortEditCategories(): TagCategory[] {
  return sortEditBoard()?.tagCategories ?? globalTagCategories;
}

/** The rules being edited, read fresh each time: the editor writes straight
 *  through to the board file, so there is no working copy to get out of step. */
function sortEditRules(): SortRule[] {
  if (!sortEditTarget) return [];
  if (sortEditTarget.kind === "tool") return kbSettings.defaultSort;
  const board = sortEditBoard();
  if (!board) return [];
  if (sortEditTarget.kind === "board") return effective(board).defaultSort;
  const column = getColumn(board, sortEditTarget.columnId);
  return column ? rulesForColumn(board, column) : [];
}

/** Writes the edited rules back to whichever thing is being edited. */
function setSortEditRules(rules: SortRule[]): void {
  if (!sortEditTarget) return;
  if (sortEditTarget.kind === "tool") {
    kbSettings.defaultSort = rules;
    markSettings();
    renderSortEditor();
    renderColumnSortSummary();
    renderBoardView();
    return;
  }
  const board = sortEditBoard();
  if (!board) return;
  if (sortEditTarget.kind === "board") {
    /* Straight onto the board's overrides. A board editing its default IS
       setting an override; there is no third level above it to follow. */
    board.overrides.defaultSort = rules;
  } else {
    const column = getColumn(board, sortEditTarget.columnId);
    if (!column) return;
    column.sort = rules;
  }
  markBoard(board.id);
  renderSortEditor();
  renderBoardView();
}

function getSortModal(): Modal {
  if (_sortModal) return _sortModal;
  _sortModal = new Modal(document.getElementById("kbSortBackdrop")!, {
    closeOnEsc: true,
    onClosed: () => {
      const back = sortEditReturn;
      sortEditTarget = null;
      sortEditReturn = null;
      back?.();
    },
  });

  const goBack = (): void => _sortModal!.close();
  document.getElementById("kbSortBack")!.addEventListener("click", goBack);
  document.getElementById("kbSortClose")!.addEventListener("click", goBack);
  document.getElementById("kbSortClearBtn")!.addEventListener("click", () => setSortEditRules([]));

  /* Whether the board, or the column, has an answer of its own or follows the
     level above it. Turning one on starts from what it was already following,
     so nothing on screen moves until a level is actually added or removed. */
  document.getElementById("kbSortFollowBtn")!.addEventListener("click", () => {
    const board = sortEditBoard();
    if (!board || !sortEditTarget) return;
    if (sortEditTarget.kind === "column") {
      const column = getColumn(board, sortEditTarget.columnId);
      if (!column) return;
      column.sort =
        column.sort === null || column.sort === undefined ? [...rulesForColumn(board, column)] : null;
    } else if (board.overrides.defaultSort === undefined) {
      // Starts from what it was already following, so turning the override on
      // changes nothing until a level is actually added or removed.
      board.overrides.defaultSort = [...effective(null).defaultSort];
    } else {
      delete board.overrides.defaultSort;
    }
    markBoard(board.id);
    renderSortEditor();
    renderBoardView();
  });

  document.getElementById("kbSortAdd")!.addEventListener("change", (e) => {
    const select = e.target as HTMLSelectElement;
    const value = select.value;
    select.value = "";
    if (!value) return;
    const field: SortField = value.startsWith("cat:")
      ? { category: value.slice(4) }
      : (value as SortField);
    // Appended, because a level added is a tie-break for the ones above it.
    setSortEditRules([...sortEditRules(), { field, dir: "desc" }]);
  });

  return _sortModal;
}

/**
 * Opens the editor on the board's default or on one column.
 *
 * `back` is how to return, because this is reached from two different screens
 * and neither of them is the board: without it, closing would drop you on the
 * board rather than where you started.
 */
function openSortEditor(target: SortTarget, back?: () => void): void {
  sortEditTarget = target;
  sortEditReturn = back ?? null;
  renderSortEditor();
  // Replaces whatever launched it rather than stacking on top. See kbConfirm.
  topOpenKanbanModal()?.close({ handoff: true });
  getSortModal().open();
}

function renderSortEditor(): void {
  const board = sortEditBoard();
  const host = document.getElementById("kbSortRules")!;
  const intro = document.getElementById("kbSortIntro")!;
  const title = document.getElementById("kbSortTitle")!;
  const add = document.getElementById("kbSortAdd") as HTMLSelectElement;
  host.replaceChildren();
  if (!board || !sortEditTarget) return;

  const column =
    sortEditTarget.kind === "column" ? getColumn(board, sortEditTarget.columnId) : null;
  title.textContent = column ? `Sort: ${column.title}` : "Default Column Sort";
  const following = !!column && (column.sort === null || column.sort === undefined);
  intro.textContent = column
    ? (following
        ? `${column.title} is following the board's default, shown below. Changing a level gives it its own. `
        : `How ${column.title} orders its cards, whatever the board's default says. `) +
      "Levels apply in order, and each one only decides the order when the ones above it tie."
    : "How every column on this board orders its cards unless that column says otherwise. " +
      "Levels apply in order, and each one only decides the order when the ones above it tie.";

  /* The override row: does this board follow the tool, or this column follow
     its board? Same row for both, so going back to following is never only on
     a right-click menu. */
  const followRow = document.getElementById("kbSortFollowRow") as HTMLElement;
  followRow.style.display = "";
  const followLabel = document.getElementById("kbSortFollowLabel")!;
  const followBadge = document.getElementById("kbSortFollowBadge")!;
  const followBtn = document.getElementById("kbSortFollowBtn")!;
  if (column) {
    const custom = column.sort !== null && column.sort !== undefined;
    followLabel.textContent = "This column";
    followBadge.textContent = describeSortBadge(column);
    followBtn.textContent = custom ? "Follow the board default" : "Set for this column";
  } else {
    const custom = board.overrides.defaultSort !== undefined;
    followLabel.textContent = "This board";
    followBadge.textContent = describeBoardSortBadge(board);
    followBtn.textContent = custom ? "Follow the tool default" : "Set for this board";
  }

  const rules = sortEditRules();

  if (rules.length === 0) {
    const empty = document.createElement("p");
    empty.className = "kb-section-note";
    empty.textContent = column
      ? "No levels, so this column keeps the order you dragged it into."
      : "No levels, so columns keep the order you dragged them into.";
    host.appendChild(empty);
  }

  rules.forEach((rule, index) => {
    const row = document.createElement("div");
    row.className = "kb-sort-rule";
    row.draggable = true;
    row.dataset.ruleIndex = String(index);

    /* Dragged to reorder, the same way the card layout list is, rather than a
       pair of arrows per row. Levels are an order and dragging is how an order
       is expressed; the arrows also cost two controls in a row that is already
       carrying a name and a direction. */
    const grip = document.createElement("span");
    grip.className = "kb-column-grip";
    grip.textContent = "⠳";
    grip.title = "Drag to change which level applies first";
    row.appendChild(grip);

    const rank = document.createElement("span");
    rank.className = "kb-sort-rank";
    rank.textContent = String(index + 1);
    row.appendChild(rank);

    const label = document.createElement("span");
    label.className = "kb-sort-field";
    label.textContent = sortFieldLabel(rule.field, sortEditCategories());
    row.appendChild(label);

    /* The direction reads as words rather than an arrow. "High to low" is
       unambiguous for a ladder and for a date; an arrow is not, and this is
       the screen where the rule is being decided rather than glanced at. */
    const dir = document.createElement("button");
    dir.type = "button";
    dir.className = "settings-action-btn";
    dir.textContent = rule.dir === "desc" ? "High to low" : "Low to high";
    dir.addEventListener("click", () => {
      const next = [...sortEditRules()];
      next[index] = { field: rule.field, dir: rule.dir === "desc" ? "asc" : "desc" };
      setSortEditRules(next);
    });
    row.appendChild(dir);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "kb-icon-btn kb-sort-remove";
    remove.textContent = "×";
    remove.title = "Remove this level";
    remove.addEventListener("click", () =>
      setSortEditRules(sortEditRules().filter((_, i) => i !== index)),
    );
    row.appendChild(remove);

    row.addEventListener("dragstart", () => {
      sortDragIndex = index;
      row.classList.add("kb-dragging");
    });
    /* Committed on dragend rather than drop, so a release anywhere (on the
       list, on the padding, outside the window) still lands the new order.
       Same reason as the card layout list. */
    row.addEventListener("dragend", () => {
      row.classList.remove("kb-dragging");
      sortDragIndex = null;
      const before = sortEditRules();
      const next = Array.from(host.querySelectorAll<HTMLElement>(".kb-sort-rule"))
        .map((el) => before[Number(el.dataset.ruleIndex)])
        .filter((r): r is SortRule => r !== undefined);
      if (next.length !== before.length) return;
      setSortEditRules(next);
    });
    row.addEventListener("dragover", (e) => {
      if (sortDragIndex === null || sortDragIndex === index) return;
      e.preventDefault();
      const dragged = host.querySelector<HTMLElement>(
        `.kb-sort-rule[data-rule-index="${sortDragIndex}"]`,
      );
      if (!dragged) return;
      const rect = row.getBoundingClientRect();
      const above = e.clientY < rect.top + rect.height / 2;
      host.insertBefore(dragged, above ? row : row.nextSibling);
    });

    host.appendChild(row);
  });

  /* The picker only offers what is not already in the list: a field cannot
     sort twice, and a second copy of it would be a level that never speaks. */
  add.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Choose a field…";
  add.appendChild(placeholder);
  const options: { value: string; label: string; field: SortField }[] = [
    ...SORT_FIELDS.map((f) => ({ value: String(f.field), label: f.label, field: f.field })),
    ...board.tagCategories.map((c) => ({
      value: `cat:${c.id}`,
      label: c.name,
      field: { category: c.id } as SortField,
    })),
  ];
  for (const opt of options) {
    if (rules.some((r) => sameField(r.field, opt.field))) continue;
    const el = document.createElement("option");
    el.value = opt.value;
    el.textContent = opt.label;
    add.appendChild(el);
  }
  add.value = "";
  add.disabled = add.children.length <= 1;
}

function buildColumn(board: Board, column: Column, todayStr: string): HTMLElement {
  const el = document.createElement("section");
  el.className = "kb-column";
  el.dataset.columnId = column.id;
  if (column.collapsed) el.classList.add("kb-column-collapsed");
  if (column.isDone) el.classList.add("kb-column-done");

  const all = cardsInColumn(board.id, column.id);
  const visible = visibleCardsInColumn(board, column, todayStr);
  const rules = rulesForColumn(board, column);
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

  /* A sorted column has to look different from one that is hand-arranged, or
     the cards being somewhere unexpected has no explanation on screen. The
     tooltip spells the layers out in order. */
  if (rules.length > 0) {
    const chip = document.createElement("span");
    chip.className = "kb-column-sorted";
    chip.textContent = "⇅";
    chip.title = `Sorted by ${describeSortRules(rules, board.tagCategories)}`;
    head.appendChild(chip);
  }

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
      { label: "Sort Cards", submenu: columnSortMenu(board, column) },
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
/**
 * The inline "type a title, press Enter" form.
 *
 * `host` is where the form goes and `addBtn` is the button it replaces, which
 * for the column footer is the Add card button and for "Add Card Below" is
 * nothing: the form is inserted straight under the card instead, and there is
 * no button to hide or bring back.
 */
function openQuickAdd(
  board: Board,
  column: Column,
  host: HTMLElement,
  addBtn: HTMLButtonElement | null,
  position: NewCardPosition,
): void {
  if (addBtn) addBtn.style.display = "none";

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
  host.appendChild(form);
  input.focus();

  function commit(): void {
    const title = input.value.trim();
    if (!title) return;
    const created = createCard(board, column.id, title, position);
    if (!created) return;
    /* Re-render so the new card appears, then reopen the form so a run of
       captures is uninterrupted. Adding BELOW walks down the column as you go:
       the next one lands under the one just made, which is what typing a list
       in order feels like. Adding at an end stays at that end. */
    const next: NewCardPosition =
      typeof position === "object" ? { below: created.id } : position;
    renderBoardView();
    reopenQuickAdd(board, column, next);
  }

  function close(): void {
    form.remove();
    if (addBtn) addBtn.style.display = "";
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

/** Puts the quick-add form back after a re-render, wherever it belongs for this
 *  position. Split out because the form's own commit needs it and so does the
 *  menu item that opens one under a card. */
export function reopenQuickAdd(board: Board, column: Column, position: NewCardPosition): void {
  const columnEl = columnsEl.querySelector<HTMLElement>(
    `.kb-column[data-column-id="${CSS.escape(column.id)}"]`,
  );
  if (!columnEl) return;

  if (typeof position === "object") {
    const cardEl = columnEl.querySelector<HTMLElement>(
      `.kb-card[data-card-id="${CSS.escape(position.below)}"]`,
    );
    if (!cardEl?.parentElement) return;
    // Its own wrapper, inserted after the card, so the form sits where the new
    // card will and nothing has to be undone when it closes.
    const slot = document.createElement("div");
    slot.className = "kb-quick-add-slot";
    cardEl.parentElement.insertBefore(slot, cardEl.nextSibling);
    openQuickAdd(board, column, slot, null, position);
    return;
  }

  const footer = columnEl.querySelector<HTMLElement>(".kb-column-footer");
  const addBtn = footer?.querySelector<HTMLButtonElement>(".kb-column-add");
  if (footer && addBtn) openQuickAdd(board, column, footer, addBtn, position);
}

/* =============================================================================
   SELECTING MORE THAN ONE CARD
   -----------------------------------------------------------------------------
   Ctrl+click and Shift+click, the way a spreadsheet does it, so a batch of
   cards can be moved, re-prioritized or archived in one go instead of one
   right-click at a time.

   Ctrl+click toggles one card and becomes the new anchor. Shift+click selects
   from the anchor to the card clicked, REPLACING whatever the last range put
   there rather than adding to it, which is what makes a range you got slightly
   wrong fixable by clicking again instead of starting over.

   A RANGE IS WITHIN ONE COLUMN. "The ones in between" only means anything down
   a single list; across columns there is no order to be between. Shift-clicking
   into a different column starts a fresh range there rather than selecting a
   rectangle nobody asked for.

   A BULK ACTION KEEPS THE SELECTION. Setting a priority and then a tag on the
   same eleven cards is two right-clicks, not two rounds of selecting them. The
   selection goes when you say so: a plain click on a card, a right-click on a
   card outside it, a drag of an unselected card, Escape, or leaving the board.
   The only cards an action drops are the ones it took off the screen.

   The selection is BY ID and lives only as long as the board is on screen. It
   is not saved, it is dropped when the board changes, and every action taken on
   it re-reads the cards, so a card deleted by an agent mid-selection is simply
   not there when the action runs rather than a stale object being written back.
----------------------------------------------------------------------------- */

export let selectedCardIds = new Set<string>();
/** Where the next Shift+click measures from. */
let selectionAnchorId: string | null = null;

/** The selected cards that still exist, in board order. */
export function selectedCards(): Card[] {
  return cards.filter((c) => selectedCardIds.has(c.id) && !c.archived);
}

export function clearCardSelection(redraw = true): void {
  if (selectedCardIds.size === 0) return;
  selectedCardIds.clear();
  selectionAnchorId = null;
  if (redraw) renderBoardView();
}

/** After a bulk action: the cards still on screen stay selected, and the ones
 *  the action took off it (archived, deleted, moved to another board, or now
 *  hidden by a filter) leave the selection. Doesn't redraw; the caller does. */
export function pruneCardSelection(): void {
  const todayStr = today();
  for (const id of selectedCardIds) {
    const card = getCard(id);
    const onScreen =
      !!card && !card.archived && card.boardId === currentBoardId && cardMatchesFilters(card, todayStr);
    if (!onScreen) selectedCardIds.delete(id);
  }
  if (selectionAnchorId && !selectedCardIds.has(selectionAnchorId)) selectionAnchorId = null;
}

/** Ctrl+click: this card joins or leaves the selection, and becomes the anchor
 *  either way. Leaving the anchor behind on a card you just deselected is what
 *  makes the next Shift+click measure from somewhere you are not looking. */
function toggleCardSelection(card: Card): void {
  if (selectedCardIds.has(card.id)) selectedCardIds.delete(card.id);
  else selectedCardIds.add(card.id);
  selectionAnchorId = card.id;
  renderBoardView();
}

/** Shift+click: everything between the anchor and this card, in this column. */
function extendCardSelection(card: Card): void {
  const anchor = selectionAnchorId ? getCard(selectionAnchorId) : null;
  // No anchor, or one in another column, so there is nothing to be between.
  if (!anchor || anchor.columnId !== card.columnId || anchor.archived) {
    toggleCardSelection(card);
    return;
  }
  const board = getBoard(card.boardId);
  const col = board ? getColumn(board, card.columnId) : null;
  if (!board || !col) {
    toggleCardSelection(card);
    return;
  }
  const column = visibleCardsInColumn(board, col, today());
  const from = column.findIndex((c) => c.id === anchor.id);
  const to = column.findIndex((c) => c.id === card.id);
  if (from === -1 || to === -1) {
    toggleCardSelection(card);
    return;
  }
  /* Replaces the range rather than adding to it, so overshooting is fixed by
     clicking the right card instead of clearing and starting again. Cards
     picked out individually with Ctrl elsewhere are kept: only this column's
     run is rewritten. */
  for (const c of column) selectedCardIds.delete(c.id);
  for (let i = Math.min(from, to); i <= Math.max(from, to); i++) {
    const c = column[i];
    if (c) selectedCardIds.add(c.id);
  }
  renderBoardView();
}

/** The cards a column is SHOWING, filters and sort included, in the order they
 *  are drawn. A range is measured in this order, and buildColumn draws from it,
 *  so the cards between two clicks are always the cards between them on screen.
 *  Selecting through a card you cannot see would be a selection you cannot
 *  check. */
function visibleCardsInColumn(board: Board, column: Column, todayStr: string): Card[] {
  // Filtered first, then sorted: sorting cards that are not on screen would
  // only cost time, and the order of what IS shown is the same either way.
  const shown = cardsInColumn(board.id, column.id).filter((c) => cardMatchesFilters(c, todayStr));
  return sortCards(shown, rulesForColumn(board, column), board);
}

/**
 * What a click on a card face means.
 *
 * Returns true when the click was a selection gesture and the card should NOT
 * open. Ctrl and Shift are the two that select; a plain click opens the card
 * and drops the selection, because leaving a selection standing behind an open
 * card is how a later bulk action surprises someone.
 */
export function handleCardClick(card: Card, e: MouseEvent): boolean {
  if (e.ctrlKey || e.metaKey) {
    toggleCardSelection(card);
    return true;
  }
  if (e.shiftKey) {
    extendCardSelection(card);
    return true;
  }
  clearCardSelection(false);
  return false;
}

/* =============================================================================
   FILTER BAR
============================================================================= */

function renderFilterBar(board: Board): void {
  /* The button closes the bar whether or not a filter is on. It used to be
     forced open by an active filter, on the grounds that a board showing three
     of forty cards must not look like a board with three cards. The count
     beside the board name says "3 of 40" and the button stays lit, which is the
     same promise kept without holding a strip open that you have finished
     with. */
  filterBar.style.display = filterBarOpen ? "" : "none";
  if (!filterBarOpen) return;

  filterBar.replaceChildren();
  filterBar.appendChild(buildFilterTagGroup(board));

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

/* -----------------------------------------------------------------------------
   THE TAG SIDE OF THE FILTER
   -----------------------------------------------------------------------------
   Every tag in use on the board used to be drawn here as a chip, grouped by
   category. That is a picker on a board with four tags and a wall on a board
   with a Versions category holding a year of releases: the strip grew taller
   than the columns it was filtering, and the two tags actually switched on were
   lost among the thirty that were not.

   So this is the card's tag row doing the same job one level up. The chips are
   what you have CHOSEN and nothing else, and choosing is the search box and the
   drill-down beside them, the same pair of controls in the same order as on a
   card. Nobody has to learn a second way to pick a tag.

   NO CREATE HERE, unlike on a card. A tag no card wears filters to nothing, so
   offering to make one would be offering an empty board.
----------------------------------------------------------------------------- */

/** The tags this board's filter may offer: the ones actually on a card, plus
 *  whatever is already switched on so it can be switched off again. A filter
 *  offering forty tags that would all return nothing is noise, not power. */
function filterableTagIds(board: Board): Set<string> {
  const used = new Set(liveCardsOnBoard(board.id).flatMap((c) => c.tagIds));
  for (const id of filterTagIds) used.add(id);
  return used;
}

function filterTagPickSpec(board: Board): TagPickSpec {
  const offerable = filterableTagIds(board);
  return {
    board,
    has: (tagId) => filterTagIds.has(tagId),
    toggle: (tag) => {
      if (filterTagIds.has(tag.id)) filterTagIds.delete(tag.id);
      else filterTagIds.add(tag.id);
    },
    after: () => renderBoardView(),
    offer: (tag) => offerable.has(tag.id),
    emptyText: "No card on this board carries a tag.",
  };
}

function buildFilterTagGroup(board: Board): HTMLElement {
  const group = document.createElement("div");
  group.className = "kb-filter-group kb-filter-group-tags";

  const label = document.createElement("span");
  label.className = "kb-filter-label";
  label.textContent = "Tags";
  group.appendChild(label);

  // In rank order, the same order the chips take on a card face, so a tag sits
  // in the same place whichever of the two you are reading.
  const chosen: Tag[] = [];
  for (const category of board.tagCategories) {
    for (const tag of board.tags) {
      if (tag.categoryId === category.id && filterTagIds.has(tag.id)) chosen.push(tag);
    }
  }

  for (const tag of chosen) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "kb-tag-chip-btn";
    chip.textContent = tag.name;
    chip.title = `${tag.name}, click to stop filtering by it`;
    paintTagChip(chip, tagColor(tag, board.tagCategories), true);
    chip.addEventListener("click", () => {
      filterTagIds.delete(tag.id);
      renderBoardView();
    });
    group.appendChild(chip);
  }

  if (chosen.length === 0) {
    const none = document.createElement("span");
    none.className = "kb-tag-none";
    none.textContent = "Any";
    group.appendChild(none);
  }

  const search = document.createElement("input");
  search.type = "text";
  search.className = "kb-tag-search";
  search.placeholder = "Find a tag";
  search.spellcheck = false;
  search.autocomplete = "off";
  search.title = "Type to filter the list, Enter to apply.";
  group.appendChild(search);

  const add = document.createElement("button");
  add.type = "button";
  add.className = "kb-tag-add-btn";
  add.textContent = "+";
  add.title = "Filter by a tag, by category";
  add.addEventListener("click", (e) => {
    closeTagSearch();
    // A function rather than a list: every row is keepOpen, so the panel
    // redraws its own ticks and counts as they are clicked.
    openMenu(e.currentTarget as HTMLElement, () => filterTagMenu(board));
  });
  group.appendChild(add);

  wireTagSearch(search, filterTagPickSpec(board));
  return group;
}

/** The drill-down behind the +. One submenu per category, its tags inside,
 *  ticked where the filter has them on. */
function filterTagMenu(board: Board): MenuItem[] {
  const offerable = filterableTagIds(board);
  const items: MenuItem[] = [];

  for (const category of board.tagCategories) {
    if (category.status === "retired") continue;
    const catTags = board.tags.filter((t) => t.categoryId === category.id && offerable.has(t.id));
    if (catTags.length === 0) continue;

    const on = catTags.filter((t) => filterTagIds.has(t.id)).length;
    items.push({
      label: on > 0 ? `${category.name} (${on})` : category.name,
      submenu: catTags.map((tag) => ({
        // A tick rather than a checkbox, the same mark the card's tag menu
        // uses, so the two read as one control in two places.
        label: `${filterTagIds.has(tag.id) ? "\u2713 " : "\u2007 "}${tag.name}`,
        swatch: tagColor(tag, board.tagCategories) ?? undefined,
        keepOpen: true,
        onClick: () => {
          if (filterTagIds.has(tag.id)) filterTagIds.delete(tag.id);
          else filterTagIds.add(tag.id);
          renderBoardView();
        },
      })),
    });
  }

  if (items.length === 0) {
    items.push({ label: "No card on this board carries a tag", disabled: true });
  }
  return items;
}

/* =============================================================================
   MUTATIONS
============================================================================= */

/** Stamps a board as edited. Every mutation path ends here, so "when did this
 *  board last change" is one field rather than a scan of its cards, and so
 *  exactly one board's file is queued for writing rather than all of them. */
export function touchBoard(board: Board): void {
  board.updatedAt = Date.now();
  markBoard(board.id);
}

export function createCard(
  board: Board,
  columnId: string,
  title: string,
  position: NewCardPosition,
): Card | null {
  if (liveCardsOnBoard(board.id).length >= MAX_CARDS_PER_BOARD) {
    flash(
      `This board is at its limit of ${MAX_CARDS_PER_BOARD.toLocaleString()} cards on the board at once.`,
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
    effort: "none",
    tagIds: [],
    subtasks: [],
    attachments: [],
    comments: [],
    dates: { due: null, started: null, testing: null, completed: null },
    archived: false,
    createdAt: now,
    updatedAt: now,
    /* Placed where it was asked for, by giving it an order the resequence
       below turns into a real index. A half step past the card it goes under
       is enough: nothing else can be sitting on it, because every other order
       in the column is a whole number by the time resequence has run. */
    order: newCardOrder(position, existing),
  };
  board.nextCardNumber += 1;
  cards.push(card);
  resequence(board.id);
  touchBoard(board);
  return card;
}

/** The order value a new card starts with, before resequence makes it an index.
 *
 *  A card added below another has to land between it and the next one, and the
 *  only thing that can express "between" here is a fraction: resequence sorts
 *  on this and renumbers, so 3.5 becomes 4 and everything after it shifts down
 *  by one. Falling back to the bottom if the card is gone, which it can be by
 *  the time a menu left open is finally clicked. */
function newCardOrder(position: NewCardPosition, existing: Card[]): number {
  if (position === "top") return -1;
  if (position === "bottom") return existing.length;
  const anchor = existing.find((c) => c.id === position.below);
  return anchor ? anchor.order + 0.5 : existing.length;
}

export function deleteCard(card: Card): void {
  // The card's files go with it. Nothing else can reach them once the card is
  // out of the array, so leaving them behind would be an orphan nobody could
  // ever find to delete.
  forgetAttachmentFiles(card.boardId, allAttachments(card));
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

export function duplicateCard(card: Card): Card | null {
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
    // The copy gets its OWN files. Sharing a path would mean removing the
    // attachment from either card unlinks the bytes the other one still shows;
    // the copy starts pointing at the original's files and is repointed at its
    // own as each copy lands (see cloneAttachments).
    attachments: card.attachments.map((a) => ({ ...a, id: newId() })),
    // The comment thread is what was said about the ORIGINAL piece of work. A
    // duplicate is a new piece of work, so it starts with nothing said about it.
    comments: [],
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
  void cloneAttachments(card, copy);
  return copy;
}

/* -----------------------------------------------------------------------------
   CARD OPERATIONS THE WHOLE TOOL USES

   These were filed under CARD MODAL, which was never right: the board's
   right-click menu, the card face and drag-and-drop all call them, and the
   modal is only one caller among several. stampCard alone has fifteen callers
   outside that section.

   Where a function lives decides what it looks like it belongs to, and these
   belong to the board. Moved here so the card modal can become its own file
   without dragging the board's own operations out with it.
----------------------------------------------------------------------------- */

/** Deletes a card, asking first unless this board says not to. The single
 *  delete path, shared by the card menu and by the bin on the card face, so the
 *  confirmation preference cannot end up honored in one place and not the
 *  other. */
export function requestDeleteCard(card: Card, opts: { reopen?: () => void } = {}): void {
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
export function stampCard(card: Card): void {
  card.updatedAt = Date.now();
  const board = getBoard(card.boardId);
  if (!board) return;
  board.updatedAt = card.updatedAt;
  markBoard(board.id);
  // The board behind the modal shows this card. See KEEPING THE BOARD IN STEP.
  queueBoardRefresh();
}

export function moveCardToColumn(card: Card, columnId: string): void {
  const board = getBoard(card.boardId);
  if (!board) return;
  const column = getColumn(board, columnId);
  if (!column || column.id === card.columnId) return;

  card.columnId = column.id;
  card.order = -1; // to the top of its new column, then resequenced
  const stage = stampOnArrival(board, column, card);
  if (stage) flash(`Stamped the card's ${STAGE_LABELS[stage]} date.`);
  resequence(board.id);
  stampCard(card);
}

/** The stage date a column stamps on a card arriving in it: Completed for a
 *  column that means done, the column's own choice otherwise, or null. */
export function arrivalStage(column: Column): Stage | null {
  return column.isDone ? "completed" : (column.stage ?? null);
}

/** Stamps the stage date a card moving into `column` earns, when the board's
 *  preference is on and that date is still empty. Returns the stage stamped.
 *  The one stamper for every way a card changes column, so a drag and a move
 *  from the card or its menu cannot disagree about what is stamped, or how
 *  precisely. */
export function stampOnArrival(board: Board, column: Column, card: Card): Stage | null {
  if (!effective(board).autoCompleteOnDone) return null;
  const stage = arrivalStage(column);
  if (!stage || card.dates[stage]) return null;
  // The moment, like every other stage stamp: a move is the app watching
  // something happen, so it knows the time as well as the day.
  card.dates[stage] = nowStamp();
  return stage;
}

export function moveCardToBoard(card: Card, boardId: string): void {
  const target = getBoard(boardId);
  const from = getBoard(card.boardId);
  if (!target || target.id === card.boardId) return;
  if (target.columns.length === 0) {
    flash("That board has no columns to move the card into.", "error");
    renderCardPlacement(card);
    return;
  }

  const previous = card.number;
  const fromBoardId = card.boardId;
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
  // The files live in a folder named after the board, so a card crossing boards
  // has to physically take them with it. If the two boards disagree about
  // rather than a rename, so the copy is verified before the original goes.
  if (fromBoardId) void moveAttachmentsToBoard(card, fromBoardId, target.id);
  flash(`Moved to ${target.name}. It is now #${card.number} (was #${previous}).`);
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
  const set = chain.filter((s): s is { label: string; value: string } => s.value !== null);
  for (let i = 1; i < set.length; i++) {
    const prev = set[i - 1].value;
    const cur = set[i].value;
    /* Compared as INSTANTS when both carry a time, not rounded to whole days:
       "completed at 09:00, work started at 14:00" is out of order on the same
       day, and dayDiff would round that to zero and say nothing.

       Compared as DAYS when either is a bare day. Created always is, and so is
       any stamp saved before stamps had times. A bare day covers the whole day,
       so the only thing it can be out of order with is an earlier day. It used
       to be compared as an instant too, and parseDay pins a bare day to noon,
       so a card created at 00:04 and started at 09:00 the same morning read as
       "work started is before created". */
    let outOfOrder: boolean;
    if (hasTimeOfDay(prev) && hasTimeOfDay(cur)) {
      const a = parseDay(prev)?.getTime();
      const b = parseDay(cur)?.getTime();
      outOfOrder = a !== undefined && b !== undefined && b < a;
    } else {
      // Stored as YYYY-MM-DD first, which sorts correctly as text.
      outOfOrder = cur.slice(0, 10) < prev.slice(0, 10);
    }
    if (outOfOrder) return `${set[i].label} is before ${set[i - 1].label}`;
  }
  return null;
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
let _columnEditModal: Modal | null = null;
let _archiveModal: Modal | null = null;
let _tagCatEditModal: Modal | null = null;
let _tagEditModal: Modal | null = null;
let _confirmModal: Modal | null = null;

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
export function kbConfirm(
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

type KbBoardSetupTab = "board" | "tags" | "preferences" | "agents";

export let boardEditId: string | null = null;
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
        agents: "kbBoardTabAgents",
      },
      onActivate: (tab) => {
        if (tab === "board") renderBoardSetupBoardTab();
        if (tab === "tags") {
          tagEditScope = "board";
          tagEditBoardId = boardEditId;
          renderBoardTagList();
        }
        if (tab === "preferences") renderBoardPrefs();
        // Reads the config and the log off disk, so it is fetched when the tab
        // is looked at rather than on every open of the modal. Same rule the
        // snapshot list follows.
        if (tab === "agents") void renderAgentsTab();
      },
    });
  }
  return _boardSetupTabs;
}

export function getBoardSetupModal(): Modal {
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

  document
    .getElementById("kbBoardResetNumbersBtn")!
    .addEventListener("click", requestResetCardNumbers);

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

export function openBoardSetup(board: Board, tab: KbBoardSetupTab = "board"): void {
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
  renderBoardNumberSummary();
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
  img.style.backgroundImage = `url("${backgroundSrc(bg)}")`;
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
    // The filename, not a path. See backgroundSrc and BoardBackground.path.
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

/* THE SAME GROUPS, IN THE SAME ORDER, AS THE TOOL'S OWN PREFERENCES.

   Seventeen rows in one column is a wall, and this list is a subset of that
   wall: whoever reads the two screens is reading the same settings twice and
   should not have to find them twice. So the grouping lives here as structure
   rather than as a comment, and the dividers fall where index.html puts them.

   The tool has two groups this one does not, the two ladders and the overdue
   warning, because neither is something a single board can answer differently. */
/* THE SAME BUCKETS, IN THE SAME ORDER, AS THE TOOL'S OWN PREFERENCES.

   Seventeen rows in one column is a wall, and this list is a subset of that
   wall: whoever reads the two screens is reading the same settings twice and
   should not have to find them twice. So the grouping lives here as structure
   rather than as a comment, and the dividers fall where index.html puts them.

   The tool has the two ladders this one does not, because a level called "Huge"
   on one board and "Epic" on another would make a card's chip mean different
   things depending on where you were standing. */
const BOARD_OVERRIDE_GROUPS: OverrideRow[][] = [
  // Deadlines and urgency: the vocabulary a board tracks work in.
  [
    {
    key: "showDue",
    label: "Due Date",
    info: "The due date block and the due chip on the card face. Separate from stage dates. Off also means this board's cards never count as overdue.",
    },
    {
    key: "showStages",
    label: "Stage Dates",
    info: "The Work Started / Testing Started / Completed dates and the button that stamps them.",
    },
    {
    key: "overdueWarn",
    label: "Warn on Overdue Cards",
    info: "Whether this board's overdue cards pulse the Kanban sidebar icon and get counted in the tool header. A board that keeps due dates it does not work to can stop shouting about them without losing the dates.",
    },
  ],
  // What happens when you use a board.
  [
    {
    key: "confirmDelete",
    label: "Confirm Before Deleting a Card",
    info: "Whether deleting a card on this board asks first.",
    },
    {
    key: "openCardsInEditMode",
    label: "Open Cards in Edit Mode",
    info: "Cards open with their fields live, the way this tool always worked: each one saves as you leave it, and closing the card is a fine way to finish. No edit, save or discard buttons. Off, a card opens as something to read and the pencil switches to the fields.",
    },
    {
    key: "autoCompleteOnDone",
    label: "Stamp Stage Dates When Cards Move In",
    info: "Only does anything when a column on this board means done or stamps a stage date of its own.",
    },
  ],
  // What else a card face shows.
  [
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
  ],
];

function renderBoardPrefs(): void {
  const board = getBoard(boardEditId);
  const list = document.getElementById("kbBoardPrefsList")!;
  list.replaceChildren();
  if (!board) return;

  const divider = (): void => {
    const rule = document.createElement("div");
    rule.className = "settings-section-divider";
    list.appendChild(rule);
  };

  for (const group of BOARD_OVERRIDE_GROUPS) {
    if (list.children.length > 0) divider();
    for (const row of group) list.appendChild(buildOverrideRow(board, row));
  }

  /* Third group: how cards look and how columns arrange them. The two selects
     with the same three-state rule, then the two settings whose value is a list
     and which open a screen of their own. */
  divider();
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

  /* The two list-valued settings. Both use the same row as every other "opens
     its own editor" setting in the app: the name, a badge saying whether this
     board has an answer of its own, and a button that always says Customize.

     They used to be the odd ones out. Card Layout rendered its drag list inline
     under the row, and Column Sort put the whole rule set in the button label,
     which made the button as wide as the rules were long. Neither said in two
     words what the row is read for: has anyone touched this. */
  for (const setting of [
    {
      label: "Card Layout",
      badge: boardBadge(board.overrides.sectionOrder !== undefined),
      open: () =>
        openCardLayoutEditor({ kind: "board", boardId: board.id }, () =>
          openBoardSetup(board, "preferences"),
        ),
    },
    {
      label: "Column Sort",
      badge: describeBoardSortBadge(board),
      open: () =>
        openSortEditor({ kind: "board", boardId: board.id }, () =>
          openBoardSetup(board, "preferences"),
        ),
    },
  ]) {
    const row = document.createElement("div");
    row.className = "settings-row";

    const labelCol = document.createElement("div");
    labelCol.className = "settings-label-col";
    const name = document.createElement("span");
    name.textContent = setting.label;
    labelCol.appendChild(name);

    const badge = document.createElement("span");
    badge.className = "settings-status-badge";
    badge.textContent = setting.badge;
    labelCol.appendChild(badge);
    row.appendChild(labelCol);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "settings-action-btn";
    btn.textContent = "Customize";
    // Back to this tab, not to the board: it is where the button was.
    btn.addEventListener("click", setting.open);
    row.appendChild(btn);

    list.appendChild(row);
  }
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
    toggleInfoTooltip(info, row.info, "kb-info-tooltip");
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
  // The badge is behind this screen and comes back into view when it closes,
  // so it is kept in step here rather than only on the way out.
  renderDefaultColumnsSummary();

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

/* -----------------------------------------------------------------------------
   THE SCALE EDITOR
   -----------------------------------------------------------------------------
   Priority and Effort are the same shape: an ordered ladder of rungs, each with
   a name and a color. One editor serves both, told which one it is looking at,
   the way the tag editors are told which vocabulary they are on.

   THE RUNGS ARE NOW EDITABLE, which they were not. This screen used to rename
   and recolor five fixed levels and say so in its own comment: adding or
   removing one would change what every existing card means, and a card set to
   a level that stopped existing has no honest answer. The second half of that
   is still true. The first was an argument for ANSWERING the question, not for
   refusing it, and five was only ever the number this app happened to pick.

   SO DELETE ASKS. It counts the cards on the rung across every board and, when
   there are any, makes you name the rung they move to before it will do
   anything. That is the same bargain the tag editor strikes, one level up: a
   tag delete says how many cards carry it, and the gentler alternative is
   offered rather than assumed.

   ADD AND REORDER need no such ceremony. A new rung starts empty, and moving
   one changes the order things sort in and nothing about what any card says.

   EDITS WRITE STRAIGHT THROUGH to the live setting, the way every other
   preference in this tool does. There is no Save on this screen and no draft
   to reconcile.
----------------------------------------------------------------------------- */

type ScaleKind = "priority" | "effort";

/** Which scale the shared modal is currently editing. */
let scaleEditKind: ScaleKind = "priority";

/** The row being dragged, by index, or null. Mirrors the default-columns
 *  editor, which is the other reorderable list in this modal. */
let scaleDragIndex: number | null = null;

interface ScaleSpec {
  kind: ScaleKind;
  title: string;
  blurb: string;
  /** The live array, not a copy. */
  levels: ScaleLevel[];
  /** Replaces it, since a reorder and a delete both rebuild the list. */
  setLevels: (next: ScaleLevel[]) => void;
  noneLabel: string;
  setNoneLabel: (next: string) => void;
  defaults: readonly ScaleLevel[];
  /** What a card on this scale stores, for counting before a delete. */
  levelOf: (card: Card) => LevelId;
  setLevelOf: (card: Card, level: LevelId) => void;
}

function scaleSpec(kind: ScaleKind): ScaleSpec {
  return kind === "priority"
    ? {
        kind,
        title: "Priority",
        blurb:
          "How urgent a card is, lowest at the top. Add levels, take them away, drag them into " +
          "the order you rank them in, and rename and recolor each one. None is the absence of a " +
          "level rather than one of them, so it has no color and cannot be removed.",
        levels: kbSettings.priorityLevels,
        setLevels: (next) => {
          kbSettings.priorityLevels = next;
        },
        noneLabel: kbSettings.priorityNoneLabel,
        setNoneLabel: (next) => {
          kbSettings.priorityNoneLabel = next;
        },
        defaults: DEFAULT_PRIORITY_LEVELS,
        levelOf: (card) => card.priority,
        setLevelOf: (card, level) => {
          card.priority = level;
        },
      }
    : {
        kind,
        title: "Effort",
        blurb:
          "How heavy a card is, separately from how urgent, lightest at the top. Make these say " +
          "whatever your team already says: points, t-shirt sizes, hours, or three rungs instead " +
          "of five. None is the absence of a level rather than one of them.",
        levels: kbSettings.effortLevels,
        setLevels: (next) => {
          kbSettings.effortLevels = next;
        },
        noneLabel: kbSettings.effortNoneLabel,
        setNoneLabel: (next) => {
          kbSettings.effortNoneLabel = next;
        },
        defaults: DEFAULT_EFFORT_LEVELS,
        levelOf: (card) => card.effort,
        setLevelOf: (card, level) => {
          card.effort = level;
        },
      };
}

/** True when the ladder is exactly what shipped: same ids, same order, same
 *  names, same colors, and None still called None. */
function scaleIsDefault(spec: ScaleSpec): boolean {
  if (spec.noneLabel !== DEFAULT_NONE_LABEL) return false;
  if (spec.levels.length !== spec.defaults.length) return false;
  return spec.levels.every((level, i) => {
    const shipped = spec.defaults[i]!;
    return level.id === shipped.id && level.name === shipped.name && level.color === shipped.color;
  });
}

/** The badge on each Customize row, and the note at the foot of the editor. It
 *  says how far from the shipped scale this one has moved, so the row says
 *  whether it is worth opening. */
function scaleSummary(kind: ScaleKind): string {
  const spec = scaleSpec(kind);
  if (scaleIsDefault(spec)) return "Default";
  const count = spec.levels.length;
  return `${count} ${count === 1 ? "level" : "levels"}, customized`;
}

function renderScaleSummaries(): void {
  const priority = document.getElementById("kbPrioritySummary");
  if (priority) priority.textContent = scaleSummary("priority");
  const effort = document.getElementById("kbEffortSummary");
  if (effort) effort.textContent = scaleSummary("effort");
}

/** Every card on this level, across every board. Board contents are all in
 *  memory (see loadRecords), so this is a scan of the one array rather than a
 *  read of every file. Archived cards are counted too: they still carry the
 *  level, and leaving them out would make the number a lie the moment one was
 *  brought back. */
function cardsOnLevel(spec: ScaleSpec, levelId: LevelId): Card[] {
  return cards.filter((c) => spec.levelOf(c) === levelId);
}

/** How many boards those cards are spread over, so the confirm can say
 *  "across 3 boards" rather than leaving you to guess whether this is local. */
function boardsOnLevel(list: Card[]): number {
  return new Set(list.map((c) => c.boardId)).size;
}

/** A fresh id for a new rung. Not derived from the name: renaming is meant to
 *  be free, and an id that started as a slug of the name would quietly invite
 *  the two to be treated as the same thing. */
function newLevelId(): string {
  return newId();
}

/** The None row, then one row per rung in ladder order, lowest first.
 *
 *  THE SAME ORDER A PICKER OFFERS, which is also the order this screen drew
 *  before the rungs became editable. Reading the editor and reading the
 *  drop-down should not be two different exercises, and reversing one of them
 *  so that Critical sat at the top would make every drag land somewhere other
 *  than where it looked. */
function renderScaleEditor(): void {
  const spec = scaleSpec(scaleEditKind);
  document.getElementById("kbScaleTitle")!.textContent = spec.title;
  document.getElementById("kbScaleBlurb")!.textContent = spec.blurb;

  const host = document.getElementById("kbScaleRows")!;
  host.replaceChildren();

  const restamp = (): void => {
    document.getElementById("kbScaleNote")!.textContent = scaleSummary(scaleEditKind);
    renderScaleSummaries();
  };

  const commitEdit = (): void => {
    markSettings();
    renderAll();
    restamp();
  };

  /* THE NONE ROW. No grip, no color, no delete: it is not on the ladder and
     cannot be moved off, colored, or taken away. A spacer holds each of those
     columns open so the names still line up into something you can read down. */
  const noneRow = document.createElement("div");
  noneRow.className = "kb-scale-row kb-scale-row-none";

  const gripGap = document.createElement("span");
  gripGap.className = "kb-column-grip kb-scale-grip-spacer";
  noneRow.appendChild(gripGap);

  const swatchGap = document.createElement("span");
  swatchGap.className = "kb-scale-swatch-spacer";
  swatchGap.title = "None has no color: it is the absence of a level.";
  noneRow.appendChild(swatchGap);

  const noneName = document.createElement("input");
  noneName.type = "text";
  noneName.className = "kb-scale-name";
  noneName.maxLength = MAX_LEVEL_NAME_LEN;
  noneName.spellcheck = false;
  noneName.value = spec.noneLabel;
  noneName.placeholder = DEFAULT_NONE_LABEL;
  const commitNone = (): void => {
    const next = noneName.value.trim().slice(0, MAX_LEVEL_NAME_LEN) || DEFAULT_NONE_LABEL;
    noneName.value = next;
    if (next === spec.noneLabel) return;
    spec.setNoneLabel(next);
    commitEdit();
  };
  noneName.addEventListener("change", commitNone);
  noneName.addEventListener("blur", commitNone);
  noneRow.appendChild(noneName);

  const noneUsed = cardsOnLevel(spec, NO_LEVEL).length;
  const noneCount = document.createElement("span");
  noneCount.className = "kb-scale-count";
  noneCount.textContent = noneUsed === 0 ? "" : `${noneUsed} ${noneUsed === 1 ? "card" : "cards"}`;
  noneRow.appendChild(noneCount);

  const noneGap = document.createElement("span");
  noneGap.className = "kb-scale-remove-spacer";
  noneRow.appendChild(noneGap);

  host.appendChild(noneRow);

  spec.levels.forEach((level, index) => {
    const row = document.createElement("div");
    row.className = "kb-scale-row";
    row.draggable = true;
    row.dataset.index = String(index);

    const grip = document.createElement("span");
    grip.className = "kb-column-grip";
    grip.textContent = "\u2833";
    grip.title = "Drag to reorder. The order is the ranking.";
    row.appendChild(grip);

    const color = document.createElement("input");
    color.type = "color";
    color.className = "kb-scale-swatch";
    color.value = level.color;
    color.addEventListener("input", () => {
      level.color = color.value.toLowerCase();
      commitEdit();
    });
    row.appendChild(color);

    const name = document.createElement("input");
    name.type = "text";
    name.className = "kb-scale-name";
    name.maxLength = MAX_LEVEL_NAME_LEN;
    name.spellcheck = false;
    name.value = level.name;
    name.placeholder = spec.defaults.find((d) => d.id === level.id)?.name ?? "Level";
    const commitName = (): void => {
      /* Blank falls back to the shipped name for a rung that has one, and to a
         placeholder for one that does not. A nameless rung would draw an empty
         chip nothing could identify, and no card could be taken off it because
         nothing in the picker could be pointed at. */
      const shipped = spec.defaults.find((d) => d.id === level.id)?.name;
      const next = name.value.trim().slice(0, MAX_LEVEL_NAME_LEN) || shipped || "Level";
      name.value = next;
      if (next === level.name) return;
      level.name = next;
      commitEdit();
    };
    name.addEventListener("change", commitName);
    name.addEventListener("blur", commitName);
    row.appendChild(name);

    const used = cardsOnLevel(spec, level.id).length;
    const count = document.createElement("span");
    count.className = "kb-scale-count";
    count.textContent = used === 0 ? "" : `${used} ${used === 1 ? "card" : "cards"}`;
    row.appendChild(count);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "kb-icon-btn";
    remove.textContent = "\u00d7";
    remove.title = "Remove this level";
    remove.addEventListener("click", () => requestDeleteLevel(spec.kind, level.id));
    row.appendChild(remove);

    /* Read the order back off the DOM on drop, the same way the default column
       editor does, so a release anywhere over the list lands it. */
    row.addEventListener("dragstart", () => {
      scaleDragIndex = index;
      row.classList.add("kb-dragging");
    });
    row.addEventListener("dragend", () => {
      row.classList.remove("kb-dragging");
      scaleDragIndex = null;
      const order = Array.from(host.querySelectorAll<HTMLElement>(".kb-scale-row[data-index]")).map(
        (el) => Number(el.dataset.index),
      );
      const current = spec.levels;
      if (order.length !== current.length) return;
      spec.setLevels(order.map((i) => current[i]!));
      markSettings();
      renderAll();
      renderScaleEditor();
    });
    row.addEventListener("dragover", (e) => {
      if (scaleDragIndex === null || scaleDragIndex === index) return;
      e.preventDefault();
      const dragged = host.querySelector<HTMLElement>(
        `.kb-scale-row[data-index="${scaleDragIndex}"]`,
      );
      if (!dragged) return;
      const rect = row.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      host.insertBefore(dragged, before ? row : row.nextSibling);
    });

    host.appendChild(row);
  });

  const add = document.getElementById("kbScaleAddBtn") as HTMLButtonElement;
  const full = spec.levels.length >= MAX_SCALE_LEVELS;
  add.disabled = full;
  add.title = full
    ? `This scale is at its limit of ${MAX_SCALE_LEVELS} levels.`
    : "Add a level as the highest rung, then drag it where you want it";

  restamp();
}

/** A new rung, added as the HIGHEST, which is the end of the list as this
 *  screen draws it: it lands where you can see it rather than somewhere you
 *  have to go looking, and dragging is one gesture away. Named for its position
 *  so it is identifiable before you have renamed it. */
function addScaleLevel(): void {
  const spec = scaleSpec(scaleEditKind);
  if (spec.levels.length >= MAX_SCALE_LEVELS) {
    flash(`A scale holds at most ${MAX_SCALE_LEVELS} levels.`, "error");
    return;
  }
  spec.setLevels([
    ...spec.levels,
    { id: newLevelId(), name: `Level ${spec.levels.length + 1}`, color: DEFAULT_TAG_COLOR },
  ]);
  markSettings();
  renderAll();
  renderScaleEditor();
}

/* -----------------------------------------------------------------------------
   REMOVING A RUNG
   -----------------------------------------------------------------------------
   The cards on it have to go somewhere, and the app cannot pick for you: the
   rung below is a guess, and so is None. So the count comes first, and where
   they land is a choice you make before the delete button does anything.

   COUNTED ACROSS EVERY BOARD, because the scale is one thing shared by all of
   them. Deleting "High" from a Preferences screen while four boards are using
   it is exactly the case where a local-looking screen must not be trusted to
   only have local consequences.

   ITS OWN MODAL rather than kbConfirm, which draws text and two buttons. The
   destination is the point of this confirm, and a yes/no that quietly picked a
   destination for you would be the thing this whole screen exists to avoid.
----------------------------------------------------------------------------- */

let _scaleDeleteModal: Modal | null = null;
let scaleDeleteKind: ScaleKind = "priority";
let scaleDeleteLevelId: LevelId = "";

function requestDeleteLevel(kind: ScaleKind, levelId: LevelId): void {
  const spec = scaleSpec(kind);
  if (spec.levels.length <= 1) {
    flash("A scale keeps at least one level. Rename this one instead.", "error");
    return;
  }
  scaleDeleteKind = kind;
  scaleDeleteLevelId = levelId;
  getScaleModal().close({ handoff: true });
  getScaleDeleteModal().open();
}

function renderScaleDelete(): void {
  const spec = scaleSpec(scaleDeleteKind);
  const level = spec.levels.find((l) => l.id === scaleDeleteLevelId);
  const affected = level ? cardsOnLevel(spec, level.id) : [];

  document.getElementById("kbScaleDeleteTitle")!.textContent = level
    ? `Remove "${level.name}"?`
    : "Remove level?";

  const boardCount = boardsOnLevel(affected);
  document.getElementById("kbScaleDeleteMessage")!.textContent =
    affected.length === 0
      ? "No card is on this level, so nothing else changes."
      : `${affected.length} ${affected.length === 1 ? "card is" : "cards are"} on this level, ` +
        `across ${boardCount} ${boardCount === 1 ? "board" : "boards"}. ` +
        `Every one of them moves to the level you pick.`;

  /* The destination picker is hidden when nothing is on the rung. There is
     nothing to move, and asking anyway would suggest there was. */
  const field = document.getElementById("kbScaleDeleteMoveField")!;
  field.style.display = affected.length === 0 ? "none" : "";

  const select = document.getElementById("kbScaleDeleteMove") as HTMLSelectElement;
  select.replaceChildren();
  for (const choice of [
    { id: NO_LEVEL, label: spec.noneLabel },
    ...spec.levels.filter((l) => l.id !== scaleDeleteLevelId).map((l) => ({ id: l.id, label: l.name })),
  ]) {
    const option = document.createElement("option");
    option.value = choice.id;
    option.textContent = choice.label;
    select.appendChild(option);
  }
  // The rung below, which is the nearest honest neighbor, rather than None:
  // "this was a High" is better preserved as "Medium" than as "unset". The
  // bottom rung has nothing below it and falls back to None.
  const at = spec.levels.findIndex((l) => l.id === scaleDeleteLevelId);
  const below = at > 0 ? spec.levels[at - 1]!.id : NO_LEVEL;
  select.value = below;
}

function getScaleDeleteModal(): Modal {
  if (_scaleDeleteModal) return _scaleDeleteModal;
  _scaleDeleteModal = new Modal(document.getElementById("kbScaleDeleteBackdrop")!, {
    closeOnEsc: true,
    onOpen: () => renderScaleDelete(),
  });

  const back = (): void => {
    _scaleDeleteModal!.close({ handoff: true });
    getScaleModal().open();
  };

  document.getElementById("kbScaleDeleteCancelBtn")!.addEventListener("click", back);
  document.getElementById("kbScaleDeleteBack")!.addEventListener("click", back);

  document.getElementById("kbScaleDeleteConfirmBtn")!.addEventListener("click", () => {
    const spec = scaleSpec(scaleDeleteKind);
    const level = spec.levels.find((l) => l.id === scaleDeleteLevelId);
    if (!level) {
      back();
      return;
    }
    const select = document.getElementById("kbScaleDeleteMove") as HTMLSelectElement;
    const destination = select.value || NO_LEVEL;

    const affected = cardsOnLevel(spec, level.id);
    const touched = new Set<string>();
    for (const card of affected) {
      spec.setLevelOf(card, destination);
      touched.add(card.boardId);
    }
    // Per board, so only the files that actually changed are queued. A card's
    // own updatedAt is deliberately not stamped: this is a rename of the scale
    // it sits on, not an edit anybody made to the card.
    for (const boardId of touched) markBoard(boardId);

    spec.setLevels(spec.levels.filter((l) => l.id !== level.id));
    markSettings();
    renderAll();

    flash(
      affected.length === 0
        ? `"${level.name}" removed.`
        : `"${level.name}" removed. ${affected.length} ${affected.length === 1 ? "card" : "cards"} moved.`,
    );
    back();
  });

  return _scaleDeleteModal;
}

function openScaleEditor(kind: ScaleKind): void {
  scaleEditKind = kind;
  getSetupModal().close({ handoff: true });
  getScaleModal().open();
}

let _scaleModal: Modal | null = null;

function getScaleModal(): Modal {
  if (_scaleModal) return _scaleModal;
  _scaleModal = new Modal(document.getElementById("kbScaleBackdrop")!, {
    closeOnEsc: true,
    onOpen: () => renderScaleEditor(),
  });

  document.getElementById("kbScaleBack")!.addEventListener("click", () => {
    _scaleModal!.close();
    openSetupOnTab("preferences");
  });
  document.getElementById("kbScaleClose")!.addEventListener("click", () => _scaleModal!.close());
  document.getElementById("kbScaleAddBtn")!.addEventListener("click", () => addScaleLevel());

  document.getElementById("kbScaleResetBtn")!.addEventListener("click", () => {
    const spec = scaleSpec(scaleEditKind);
    /* The cards on a rung that is about to stop existing are the whole reason
       the delete button asks, so a reset that could take several rungs away at
       once has to say the same thing. Counted against the SHIPPED ids, since
       those are the rungs that will exist afterwards. */
    const shipped = new Set(spec.defaults.map((d) => d.id));
    const stranded = cards.filter((c) => {
      const level = spec.levelOf(c);
      return level !== NO_LEVEL && !shipped.has(level);
    }).length;

    kbConfirm(
      {
        title: "Reset " + spec.title + " to default?",
        message:
          `The ${spec.title.toLowerCase()} scale goes back to the five levels that shipped with ` +
          "the app, with their names, their colors and their order. " +
          (stranded === 0
            ? "Every card keeps the level it is on."
            : `${stranded} ${stranded === 1 ? "card is" : "cards are"} on a level that is not one ` +
              `of them and ${stranded === 1 ? "becomes" : "become"} unset.`),
        confirmLabel: "Reset",
        // kbConfirm REPLACES what it was opened from, so dismissing it without
        // this would drop you on the board instead of back on the scale.
        reopen: () => getScaleModal().open(),
      },
      () => {
        const shippedIds = new Set(spec.defaults.map((d) => d.id));
        const touched = new Set<string>();
        for (const card of cards) {
          const level = spec.levelOf(card);
          if (level === NO_LEVEL || shippedIds.has(level)) continue;
          spec.setLevelOf(card, NO_LEVEL);
          touched.add(card.boardId);
        }
        for (const boardId of touched) markBoard(boardId);

        spec.setLevels(spec.defaults.map((l) => ({ ...l })));
        spec.setNoneLabel(DEFAULT_NONE_LABEL);
        markSettings();
        renderAll();
        renderScaleEditor();
      },
    );
  });

  return _scaleModal;
}

function deleteBoard(board: Board): void {
  // Every file this board owns, in one call, WITHOUT needing its cards. That is
  // the whole reason attachments are grouped into a folder per board: deleting
  // a board you cannot open still takes its files with it, which the first cut
  // of this could not do and quietly orphaned them instead.
  void invoke("delete_kanban_board_attachments", { boardId: board.id }).catch((e) =>
    devError("[kanban] board attachment delete failed", e),
  );
  // The missing-file notes for this board go with it. Nothing will ever ask
  // about them again, and the set is the one thing here that outlives the board.
  for (const key of [...missingAttachments]) {
    if (key.startsWith(`${board.id}/`)) missingAttachments.delete(key);
  }
  cards = cards.filter((c) => c.boardId !== board.id);
  boards = boards.filter((b) => b.id !== board.id);
  forgetAgentAccess(board.id);
  if (board.background) {
    void invoke("delete_kanban_image", { path: board.background.path }).catch(() => {});
  }
  /* Queued with the rest of this edit rather than deleted here and now. The
     delete snapshots the board on its way out, and the index write that stops
     naming it has to land in the same flush, or a crash between the two leaves
     a board listed with no file behind it.

     Dropped from the dirty set first: writing a board that is about to be
     deleted would recreate the file the delete just removed. */
  dirtyBoards.delete(board.id);
  deletedBoards.add(board.id);
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
  };
  boards.push(copy);
  markBoard(copy.id);
  showKbView("board", copy.id);
  flash("Copied the board's columns into a new board. Give it its own background.");
}

/* -----------------------------------------------------------------------------
   RESETTING A BOARD'S CARD NUMBERS
   -----------------------------------------------------------------------------
   A card number is per board, permanent and human-facing: it is what you write
   in a commit message, say out loud, and hand an agent. So `nextCardNumber`
   only ever goes up, and nothing renumbers a card that already exists.

   That is right and it leaves one honest complaint. Make a board, make three
   test cards, delete them, and the first real card is #4 forever. The counter
   is remembering something nothing else does.

   WHAT THIS DOES, AND WHY IT IS SAFE. It winds the counter to one past the
   highest number STILL ON THE BOARD, archived cards included, and to 1 when
   nothing is left. It does not touch a single card. So:

     - It can only ever close a gap at the TOP, left by cards that are gone.
       Delete #1 and #2 but keep #3 and the answer is still 4, because 1 and 2
       are numbers you might still have written down and #3 would collide.
     - It can never hand out a number something already has, which is the whole
       failure this is guarding against.
     - Archived cards count. They are not deleted, they come back, and a
       restored #3 landing on a live #3 would be two cards with one name.

   AND IT IS SAFE AGAINST BACKUPS, which is the part worth stating out loud.
   The counter lives in the board's own file next to the cards it counts, so a
   snapshot holds both halves of the same moment. Restoring an older snapshot
   brings back its cards AND the counter that belonged to them; it cannot mix a
   wound-back counter with cards that were numbered under the old one. Nothing
   here reaches into the backups folder at all.
----------------------------------------------------------------------------- */

/** The lowest value `nextCardNumber` may safely take for this board. */
function safeNextCardNumber(boardId: string): number {
  // Archived included: they still exist and still hold their number.
  const highest = cards
    .filter((c) => c.boardId === boardId)
    .reduce((max, c) => Math.max(max, c.number), 0);
  return highest + 1;
}

/** The badge on the Board Setup row: where the counter is, and whether there
 *  is anything to reclaim. */
function renderBoardNumberSummary(): void {
  const badge = document.getElementById("kbBoardNumberSummary");
  if (!badge) return;
  const board = getBoard(boardEditId);
  const button = document.getElementById("kbBoardResetNumbersBtn") as HTMLButtonElement | null;
  if (!board) {
    badge.textContent = "";
    if (button) button.disabled = true;
    return;
  }
  const safe = safeNextCardNumber(board.id);
  const gap = board.nextCardNumber - safe;
  badge.textContent =
    gap > 0
      ? `next #${board.nextCardNumber} \u00b7 ${gap} to reclaim`
      : `next #${board.nextCardNumber} \u00b7 nothing to reclaim`;
  // Nothing to do is said with a disabled button rather than a toast after the
  // fact, which is the house rule for a control that is sometimes available.
  if (button) button.disabled = gap <= 0;
}

function requestResetCardNumbers(): void {
  const board = getBoard(boardEditId);
  if (!board) return;
  const safe = safeNextCardNumber(board.id);
  if (safe >= board.nextCardNumber) return;

  const live = cards.filter((c) => c.boardId === board.id).length;
  kbConfirm(
    {
      title: "Reset this board's card numbering?",
      message:
        `The next new card becomes #${safe} instead of #${board.nextCardNumber}. ` +
        (live === 0
          ? "This board holds no cards, so numbering starts over at 1. "
          : `The ${live} ${live === 1 ? "card" : "cards"} already here keep the numbers they have. `) +
        "Nothing is renumbered, and no number that is still in use can be handed out again.",
      confirmLabel: "Reset Numbering",
      reopen: () => openBoardSetup(board, "board"),
    },
    () => {
      board.nextCardNumber = safe;
      markBoard(board.id);
      renderBoardNumberSummary();
      flash(`Next card on this board is #${safe}.`);
    },
  );
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
  const stageSelect = document.getElementById("kbColumnStageSelect") as HTMLSelectElement;
  // Followed while Done is being flipped, not only when the editor opens.
  doneToggle.addEventListener("change", () => syncColumnStageSelect(stageSelect, doneToggle.checked));
  stageSelect.addEventListener("change", () => {
    stageSelect.dataset.kbPicked = stageSelect.value;
  });

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

/** Puts the column editor's stage choice in step with its Done switch. A done
 *  column always stamps Completed, so the choice shows that and is locked;
 *  switching Done back off returns to whatever was picked before. `stage` is
 *  passed when the editor opens, and left out when only Done changed. */
function syncColumnStageSelect(select: HTMLSelectElement, isDone: boolean, stage?: string | null): void {
  if (stage !== undefined) select.dataset.kbPicked = stage ?? "";
  const completed = select.querySelector<HTMLOptionElement>('option[value="completed"]');
  if (completed) completed.hidden = !isDone;
  select.disabled = isDone;
  select.value = isDone ? "completed" : (select.dataset.kbPicked ?? "");
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
  syncColumnStageSelect(
    document.getElementById("kbColumnStageSelect") as HTMLSelectElement,
    doneToggle.checked,
    column?.stage ?? null,
  );

  (document.getElementById("kbColumnEditDelete") as HTMLElement).style.display = column
    ? ""
    : "none";

  /* Sort is offered only for a column that EXISTS. A column being created has
     no rules to edit and nowhere to store them until it is saved, and a button
     that silently did nothing would be worse than one that is not there. */
  const sortRow = document.getElementById("kbColumnSortRow") as HTMLElement;
  const sortBtn = document.getElementById("kbColumnSortBtn") as HTMLButtonElement;
  const sortBadge = document.getElementById("kbColumnSortSummary")!;
  sortRow.style.display = column ? "" : "none";
  if (column) {
    sortBadge.textContent = describeSortBadge(column);
    sortBtn.onclick = () =>
      // Back to this modal, on the same column, which is where the button was.
      openSortEditor({ kind: "column", boardId: board.id, columnId: column.id }, () =>
        openColumnEditor(board, column),
      );
  }

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
  const stageSelect = document.getElementById("kbColumnStageSelect") as HTMLSelectElement;
  const limit = wipToggle.checked ? clampInt(wipInput.value, 1, 999, 3) : null;
  // A done column stamps Completed, so it keeps no stage of its own.
  const picked = stageSelect.value;
  const stage = !doneToggle.checked && (picked === "started" || picked === "testing") ? picked : null;

  const existing = columnEditId ? getColumn(board, columnEditId) : null;
  if (existing) {
    existing.title = title.slice(0, 80);
    existing.wipLimit = limit;
    existing.isDone = doneToggle.checked;
    existing.stage = stage;
  } else {
    board.columns.push({
      id: newId(),
      title: title.slice(0, 80),
      wipLimit: limit,
      isDone: doneToggle.checked,
      stage,
      collapsed: false,
    });
  }

  touchBoard(board);
  _columnEditModal!.close();
}

/* =============================================================================
   SETUP MODAL
============================================================================= */

type KbSetupTab = "boards" | "tags" | "defaults" | "preferences" | "data";

let _setupTabs: ModalTabs<KbSetupTab> | null = null;

function getSetupTabs(): ModalTabs<KbSetupTab> {
  if (!_setupTabs) {
    _setupTabs = new ModalTabs<KbSetupTab>({
      scope: "#kbSetupModal",
      key: "kbTab",
      panes: {
        boards: "kbTabBoards",
        tags: "kbTabTags",
        defaults: "kbTabDefaults",
        preferences: "kbTabPreferences",
        data: "kbTabData",
      },
      onActivate: (tab) => {
        if (tab === "boards") {
          renderDefaultColumnsSummary();
          renderBoardOrderSummary();
        }
        if (tab === "tags") {
          // The tool's Setup always edits the DEFAULTS. A board's own tags are
          // reached from inside that board.
          tagEditScope = "global";
          tagEditBoardId = null;
          renderTagCategoriesList();
        }
        // The snapshot list is a disk read, so it is fetched when its tab is
        // actually looked at rather than on every open of the modal.
        if (tab === "data") {
          void refreshDataTab();
          void renderAgentGlobalRow();
        }
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
      renderDefaultColumnsSummary();
      renderBoardOrderSummary();
      tagEditScope = "global";
      tagEditBoardId = null;
      renderTagCategoriesList();
    },
    onClosed: () => renderAll(),
  });

  document.getElementById("kbSetupClose")!.addEventListener("click", () => _setupModal!.close());

  document
    .getElementById("kbPriorityEditBtn")!
    .addEventListener("click", () => openScaleEditor("priority"));
  document
    .getElementById("kbEffortEditBtn")!
    .addEventListener("click", () => openScaleEditor("effort"));

  document.getElementById("kbCardLayoutEditBtn")!.addEventListener("click", () =>
    openCardLayoutEditor({ kind: "tool" }, () => openSetupOnTab("defaults")),
  );
  /* Column Sort is a tool-level default too, like Priority, Effort and Card
     Layout. It was reachable only per board and per column, which meant the one
     answer most people want ("newest at the top, everywhere") had to be given
     once per board. */
  document.getElementById("kbColumnSortEditBtn")!.addEventListener("click", () =>
    openSortEditor({ kind: "tool" }, () => openSetupOnTab("defaults")),
  );
  document.getElementById("kbNewTagCategoryBtn")!.addEventListener("click", () => {
    openTagCategoryEditor(null, "global", null);
  });

  const boardName = document.getElementById("kbDefaultBoardNameInput") as HTMLInputElement;
  boardName.addEventListener("input", () => {
    kbSettings.defaultBoardName = boardName.value.slice(0, 120);
    markSettings();
  });

  document.getElementById("kbBoardOrderEditBtn")!.addEventListener("click", () =>
    openBoardOrder(() => openSetupOnTab("boards")),
  );

  document.getElementById("kbDefaultColumnsEditBtn")!.addEventListener("click", () =>
    openDefaultColumns(() => openSetupOnTab("boards")),
  );

  bindPreferenceControls();


  document
    .getElementById("kbBackupRefreshBtn")!
    .addEventListener("click", () => void refreshDataTab());

  return _setupModal;
}

export function openSetupOnTab(tab?: KbSetupTab): void {
  if (tab) getSetupTabs().select(tab);
  getSetupModal().open();
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
 *  what keeps one board's vocabulary out of every other board's file. */
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
    block.dataset.categoryId = category.id;
    if (category.status === "retired") block.classList.add("kb-tagcat-retired");

    const head = document.createElement("div");
    head.className = "kb-tagcat-head";

    /* Rank. A category's position decides where its tags sit on a card and
       which one a tag-colored card takes its color from, so it has to be
       movable.

       Dragged, like every other ordered list in this tool: card layout blocks,
       sort levels, columns, boards and (since this release) the tags inside
       these very blocks. It used to be a pair of arrow buttons, on the grounds
       that the blocks are tall and "one step up" is all anyone wants. That was
       defensible while nothing else on the screen dragged; with the chips
       inside each block now dragging, two gestures for one idea on one screen
       is worse than either. */
    if (categories.length > 1) {
      const grip = document.createElement("span");
      grip.className = "kb-column-grip kb-tagcat-grip";
      grip.textContent = "⠳";
      grip.title = "Drag to rank this category";
      attachTagCategoryDrag(block, grip, wrap, category, scope, board);
      head.appendChild(grip);
    }

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
      btn.dataset.tagId = tag.id;
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
        (tag.status === "retired" ? " · retired" : "") +
        (catTags.length > 1 ? " · drag to reorder" : "");
      btn.addEventListener("click", () => openTagEditor(tag, tag.categoryId, scope, board));
      /* Order matters here for the same reason it does one level up: the tags
         on a card are drawn in vocabulary order, and a tag-colored card takes
         the first color it finds walking them. A category could be ranked and
         its contents could not, so "Critical" stayed wherever it happened to
         be typed.

         A drag rather than the category's up/down buttons: a category list is
         a handful of tall blocks and a "one step up" button suits it, but a
         category's tags are small chips that wrap over several rows, where a
         pair of arrows per chip would be bigger than the chips. */
      if (catTags.length > 1) attachTagChipDrag(btn, chips, tag, scope, board);
      chips.appendChild(btn);
    }
    block.appendChild(chips);
    wrap.appendChild(block);
  }
}

/** Which chip is mid-drag, shared by every chip's dragover handler so a chip
 *  can find the node actually being dragged. */
let tagChipDragId: string | null = null;

/** Drag-to-reorder for one tag chip inside its category's chip row. Committed
 *  on dragend rather than drop, so a release anywhere still lands the order,
 *  which is the same rule the column and card-layout lists follow. */
function attachTagChipDrag(
  chip: HTMLElement,
  row: HTMLElement,
  tag: Tag,
  scope: TagScope,
  board: Board | null,
): void {
  chip.draggable = true;

  chip.addEventListener("dragstart", (e) => {
    // The block around this one is draggable too. Without this, reordering a
    // chip would also look like the start of a category drag.
    e.stopPropagation();
    tagChipDragId = tag.id;
    chip.classList.add("kb-dragging");
    // Without a payload Firefox refuses to start the drag at all, and the
    // chip's own name is the honest thing to be carrying.
    e.dataTransfer?.setData("text/plain", tag.name);
  });

  chip.addEventListener("dragend", () => {
    chip.classList.remove("kb-dragging");
    tagChipDragId = null;
    const order = Array.from(row.querySelectorAll<HTMLElement>(".kb-tag-edit-chip"))
      .map((el) => el.dataset.tagId)
      .filter((id): id is string => typeof id === "string");
    reorderTagsInCategory(scope, board, tag.categoryId, order);
  });

  chip.addEventListener("dragover", (e) => {
    if (!tagChipDragId || tagChipDragId === tag.id) return;
    e.preventDefault();
    const dragged = row.querySelector<HTMLElement>(
      `.kb-tag-edit-chip[data-tag-id="${CSS.escape(tagChipDragId)}"]`,
    );
    if (!dragged) return;
    /* Chips wrap, so this reads the horizontal midpoint rather than the
       vertical one the stacked lists use: on a row of chips "before or after"
       is a left/right question, and measuring it top/bottom would put every
       drop on the same side of whatever chip the cursor was over. */
    const rect = chip.getBoundingClientRect();
    const before = e.clientX < rect.left + rect.width / 2;
    row.insertBefore(dragged, before ? chip : chip.nextSibling);
  });
}

/**
 * Rewrites one category's tags into `orderedIds`, leaving every other
 * category alone.
 *
 * Tags are one flat array with a categoryId on each, not a list per category,
 * so a category's tags own a set of SLOTS in that array rather than a
 * contiguous run. The reorder refills those same slots in the new order, which
 * keeps every other category exactly where it was: splicing the run out and
 * back in would move tags belonging to categories interleaved with this one.
 */
function reorderTagsInCategory(
  scope: TagScope,
  board: Board | null,
  categoryId: string,
  orderedIds: string[],
): void {
  const list = scope === "board" ? board?.tags : globalTags;
  if (!list) return;

  const slots: number[] = [];
  list.forEach((t, i) => {
    if (t.categoryId === categoryId) slots.push(i);
  });

  const byId = new Map(list.map((t) => [t.id, t]));
  const next = orderedIds
    .map((id) => byId.get(id))
    .filter((t): t is Tag => t !== undefined && t.categoryId === categoryId);

  // A count that does not match means the DOM and the data disagree (a tag
  // deleted from under the drag, a stray node). Dropping the reorder is the
  // safe answer; the next render puts the chips back where the data says.
  if (next.length !== slots.length) return;
  if (next.every((t, i) => t.id === list[slots[i]].id)) return;

  slots.forEach((slot, i) => {
    list[slot] = next[i];
  });

  if (scope === "board" && board) markBoard(board.id);
  else markIndex();
  redrawTagVocabulary(scope, board);
}

/** Redraws whichever of the two vocabulary lists holds `scope`. Both the
 *  category drag and the tag drag end here, rather than each naming the host
 *  element itself and having to agree about which id belongs to which scope. */
function redrawTagVocabulary(scope: TagScope, board: Board | null): void {
  const host = document.getElementById(
    scope === "board" ? "kbBoardTagCategoriesList" : "kbTagCategoriesList",
  );
  if (host) renderTagVocabulary(host, scope, board);
}

/** Which category block is mid-drag, shared by every block's dragover handler.
 *  Kept apart from tagChipDragId because a chip drag happens INSIDE a block
 *  and both sets of handlers see it. */
let tagCatDragId: string | null = null;

/**
 * Drag-to-rank for one category block.
 *
 * Only by the grip. A category block is most of the screen and holds a row of
 * draggable chips and four buttons; making the whole thing draggable would
 * mean a stray drag every time someone missed a chip. `draggable` is switched
 * on when the grip is pressed and back off at the end of the drag, which is
 * the only way to say "this element drags, from here" in HTML5 drag and drop.
 */
function attachTagCategoryDrag(
  block: HTMLElement,
  grip: HTMLElement,
  host: HTMLElement,
  category: TagCategory,
  scope: TagScope,
  board: Board | null,
): void {
  block.draggable = false;
  grip.addEventListener("pointerdown", () => {
    block.draggable = true;
  });
  /* A press that never became a drag must not leave the block armed for the
     next one, which would turn a stray press anywhere on it into a drag. On
     the block rather than the grip, so a press-and-release that wandered off
     the grip first still disarms it. */
  block.addEventListener("pointerup", () => {
    block.draggable = false;
  });

  block.addEventListener("dragstart", (e) => {
    // A chip inside started this one. Its own handler has it.
    if (!block.draggable) return;
    e.stopPropagation();
    tagCatDragId = category.id;
    block.classList.add("kb-dragging");
    e.dataTransfer?.setData("text/plain", category.name);
  });

  block.addEventListener("dragend", () => {
    block.draggable = false;
    block.classList.remove("kb-dragging");
    if (!tagCatDragId) return;
    tagCatDragId = null;
    const order = Array.from(host.querySelectorAll<HTMLElement>(".kb-tagcat"))
      .map((el) => el.dataset.categoryId)
      .filter((id): id is string => typeof id === "string");
    commitTagCategoryOrder(scope, board, order);
  });

  block.addEventListener("dragover", (e) => {
    if (!tagCatDragId || tagCatDragId === category.id) return;
    e.preventDefault();
    const dragged = host.querySelector<HTMLElement>(
      `.kb-tagcat[data-category-id="${CSS.escape(tagCatDragId)}"]`,
    );
    if (!dragged) return;
    const rect = block.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    host.insertBefore(dragged, before ? block : block.nextSibling);
  });
}

/** Writes a dragged category order back. Same shape as the board reorder: read
 *  off the DOM so a release anywhere lands, and dropped whole if the DOM and
 *  the data disagree about how many there are. */
function commitTagCategoryOrder(
  scope: TagScope,
  board: Board | null,
  orderedIds: string[],
): void {
  const list = scope === "board" ? board?.tagCategories : globalTagCategories;
  if (!list) return;
  if (orderedIds.length !== list.length) return;
  if (orderedIds.every((id, i) => list[i].id === id)) return;

  const byId = new Map(list.map((c) => [c.id, c]));
  const next = orderedIds
    .map((id) => byId.get(id))
    .filter((c): c is TagCategory => c !== undefined);
  if (next.length !== list.length) return;
  list.splice(0, list.length, ...next);

  if (scope === "board" && board) markBoard(board.id);
  else markIndex();
  redrawTagVocabulary(scope, board);
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
/* Where the tag editors go back to, when it is not the list they were opened
   from. Set by the card's tag search, which reaches the New Tag editor without
   passing through Board Setup at all: dumping someone into Board Setup > Tags
   after they added a tag from a card would be a screen they never asked for
   and had no way back from to the card they were filling in. Cleared as it is
   used, so it never redirects the next, ordinary trip. */
let tagEditReturn: (() => void) | null = null;
/** Run with the tag a save just CREATED, never with one it edited. The card's
 *  tag search uses it to put the new tag straight on the card. */
let tagEditOnCreate: ((tag: Tag) => void) | null = null;

/**
 * Hands the tag editor somewhere to come back to, and something to do with a
 * tag it creates.
 *
 * The card's tag search used to set the two variables above directly. Once
 * the card modal became its own file that stopped being possible: both ends
 * write them, and a value can only be assigned by the file that declares it.
 *
 * Better as a function anyway. Two loose globals poked from two places do not
 * say that they are one handoff and are set together; this does, and it is
 * the only way in from outside.
 */
export function setTagEditHandoff(
  back: (() => void) | null,
  onCreate: ((tag: Tag) => void) | null,
): void {
  tagEditReturn = back;
  tagEditOnCreate = onCreate;
}

function returnToTagList(): void {
  const custom = tagEditReturn;
  tagEditReturn = null;
  if (custom) {
    custom();
    return;
  }
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
      /* Both dropped here, so a canceled "create from a card" leaves nothing
         armed for whatever tag is edited next. Safe despite the back and save
         paths needing tagEditReturn AFTER they close this modal: onClosed
         fires a fade later, by which time returnToTagList has already run and
         cleared it itself. */
      tagEditOnCreate = null;
      tagEditReturn = null;
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

export function openTagEditor(
  tag: Tag | null,
  categoryId: string | null,
  scope: TagScope,
  board: Board | null,
  /** Pre-fills the name on a NEW tag. The card's tag search passes what was
   *  typed into it, so "the tag I wanted does not exist" and "make it" are one
   *  gesture rather than two screens and a retype. */
  startName?: string,
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
  nameInput.value = tag?.name ?? startName ?? "";
  // A NEW tag starts on inherit, which is the answer that keeps a category
  // looking like one thing until somebody deliberately breaks ranks.
  modeSelect.value = tag?.color ? "own" : "inherit";
  colorInput.value =
    tag?.color ?? categories.find((c) => c.id === targetCategory)?.color ?? DEFAULT_TAG_COLOR;
  colorInput.style.display = modeSelect.value === "own" ? "" : "none";

  const preview = document.getElementById("kbTagPreview")!;
  preview.textContent = tag?.name || startName || "Tag";
  paintTagChip(
    preview,
    tag ? tagColor(tag, categories) : (categories.find((c) => c.id === targetCategory)?.color ?? null),
    true,
  );

  const retire = document.getElementById("kbTagEditRetire") as HTMLElement;
  retire.style.display = tag ? "" : "none";
  retire.textContent = tag?.status === "retired" ? "Reactivate" : "Retire";
  (document.getElementById("kbTagEditDelete") as HTMLElement).style.display = tag ? "" : "none";

  /* Whichever list this came off, closed on the way in: a modal opened from a
     modal replaces it rather than stacking. Skipped when the caller has named
     its own way back, because then neither list is open and closing one would
     be closing something that is not there. */
  if (!tagEditReturn) {
    if (scope === "board") getBoardSetupModal().close({ handoff: true });
    else getSetupModal().close({ handoff: true });
  }
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
    const made: Tag = {
      id: newId(),
      categoryId,
      name: name.slice(0, 60),
      color,
      status: "active",
    };
    scopedTagList().push(made);
    const onCreate = tagEditOnCreate;
    tagEditOnCreate = null;
    onCreate?.(made);
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

  bindToggle("kbOpenInEditToggle", "kbOpenInEditLabel", (v) => {
    kbSettings.openCardsInEditMode = v;
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

/* -----------------------------------------------------------------------------
   THE CARD LAYOUT EDITOR

   One screen for the tool default and for one board's override, the same way
   the sort editor serves three levels. It used to be tool-only, and a board set
   its layout on an inline drag list wedged into the Board Setup preferences
   tab, which is why that row never looked like the rows around it.
----------------------------------------------------------------------------- */

type LayoutTarget = { kind: "tool" } | { kind: "board"; boardId: string };

let layoutEditTarget: LayoutTarget = { kind: "tool" };
let layoutEditReturn: (() => void) | null = null;

/** The board being edited, or null when it is the tool default. */
function layoutEditBoard(): Board | null {
  return layoutEditTarget.kind === "board" ? getBoard(layoutEditTarget.boardId) : null;
}

/** The order being edited, as the live array so the drag list can splice it. */
function layoutEditOrder(): CardSection[] | null {
  if (layoutEditTarget.kind === "tool") return kbSettings.sectionOrder;
  const board = layoutEditBoard();
  if (!board) return null;
  // Seeded from what it was already following, so opening the editor on a
  // board that has no override of its own changes nothing until something is
  // actually dragged.
  if (board.overrides.sectionOrder === undefined) return null;
  return board.overrides.sectionOrder;
}

function openCardLayoutEditor(target: LayoutTarget, back?: () => void): void {
  layoutEditTarget = target;
  layoutEditReturn = back ?? null;
  topOpenKanbanModal()?.close({ handoff: true });
  getCardLayoutModal().open();
}

/** The layout list, for whichever of the two things is being edited. */
function renderDefaultSectionOrder(): void {
  const host = document.getElementById("kbSectionOrderList");
  if (!host) return;

  const board = layoutEditBoard();
  const order = layoutEditOrder();

  const followRow = document.getElementById("kbCardLayoutFollowRow") as HTMLElement | null;
  if (followRow) {
    followRow.style.display = board ? "" : "none";
    if (board) {
      const custom = board.overrides.sectionOrder !== undefined;
      document.getElementById("kbCardLayoutFollowBadge")!.textContent = boardBadge(custom);
      document.getElementById("kbCardLayoutFollowBtn")!.textContent = custom
        ? "Follow the tool default"
        : "Set for this board";
    }
  }

  const reset = document.getElementById("kbCardLayoutResetBtn") as HTMLElement | null;
  if (reset) reset.style.display = board ? "none" : "";

  if (!order) {
    // A board following the default has no list of its own to drag yet.
    host.replaceChildren();
    const note = document.createElement("span");
    note.className = "kb-section-note";
    note.textContent = `Following the default: ${effective(null)
      .sectionOrder.map((sec) => CARD_SECTION_LABELS[sec])
      .join(" · ")}`;
    host.appendChild(note);
    renderCardLayoutSummary();
    return;
  }

  renderSectionOrderInto(host, order, () => {
    if (board) markBoard(board.id);
    else markSettings();
    renderDefaultSectionOrder();
    renderCardLayoutSummary();
    renderBoardView();
  });
  renderCardLayoutSummary();
}

/** The row's badge: two words, because that is what a badge is read for. It
 *  used to print the whole order, which made the row as wide as the list. */
function renderCardLayoutSummary(): void {
  const badge = document.getElementById("kbCardLayoutSummary");
  if (!badge) return;
  const isDefault =
    kbSettings.sectionOrder.length === DEFAULT_SETTINGS.sectionOrder.length &&
    kbSettings.sectionOrder.every((s, i) => s === DEFAULT_SETTINGS.sectionOrder[i]);
  badge.textContent = toolBadge(isDefault);
}

/** The same, for the tool-wide column sort. Nothing is the default here, so
 *  "Default" means every column keeps the order you dragged it into. */
function renderColumnSortSummary(): void {
  const badge = document.getElementById("kbColumnSortSummaryDefault");
  if (!badge) return;
  badge.textContent = toolBadge(kbSettings.defaultSort.length === 0);
}

let _cardLayoutModal: Modal | null = null;

function getCardLayoutModal(): Modal {
  if (_cardLayoutModal) return _cardLayoutModal;
  _cardLayoutModal = new Modal(document.getElementById("kbCardLayoutBackdrop")!, {
    closeOnEsc: true,
    onOpen: () => renderDefaultSectionOrder(),
    onClosed: () => {
      const back = layoutEditReturn;
      layoutEditReturn = null;
      layoutEditTarget = { kind: "tool" };
      back?.();
    },
  });

  document.getElementById("kbCardLayoutBack")!.addEventListener("click", () => {
    _cardLayoutModal!.close();
    // Where it was opened from, since it is now reached from two screens.
    if (layoutEditReturn) layoutEditReturn();
    else openSetupOnTab("defaults");
  });

  document.getElementById("kbCardLayoutFollowBtn")!.addEventListener("click", () => {
    const board = layoutEditBoard();
    if (!board) return;
    if (board.overrides.sectionOrder === undefined) {
      board.overrides.sectionOrder = [...effective(null).sectionOrder];
    } else {
      delete board.overrides.sectionOrder;
    }
    markBoard(board.id);
    renderDefaultSectionOrder();
    renderBoardView();
  });
  document
    .getElementById("kbCardLayoutClose")!
    .addEventListener("click", () => _cardLayoutModal!.close());

  document.getElementById("kbCardLayoutResetBtn")!.addEventListener("click", () => {
    kbConfirm(
      {
        title: "Reset the card layout?",
        message:
          "The blocks go back to the order they ship in. Boards with their own layout keep it.",
        confirmLabel: "Reset",
        reopen: () => getCardLayoutModal().open(),
      },
      () => {
        kbSettings.sectionOrder = [...DEFAULT_SETTINGS.sectionOrder];
        markSettings();
        renderDefaultSectionOrder();
        renderAll();
      },
    );
  });

  return _cardLayoutModal;
}

/* -----------------------------------------------------------------------------
   THE BOARD ORDER EDITOR
   -----------------------------------------------------------------------------
   `boards` array order IS gallery order, and until now nothing could change it:
   a board sat wherever it was created, forever, and the only way to get the one
   you use daily to the front was to delete and remake it. The sidebar has had
   this since 0.5.0 and this is the same job one level down, so it is the same
   gesture: one list, dragged.

   Reached from Setup > Boards and from a right-click on the gallery
   background. Both land here rather than one of them being a shortcut to a
   different screen, because "anything offered in a right-click menu should
   also be reachable without one" cuts both ways.

   The search box on the gallery filters what is DRAWN, never what is stored,
   so this list is always every board. Reordering a filtered subset would write
   an order the person could not see the whole of.
----------------------------------------------------------------------------- */

/**
 * Re-orders `boards` in place for the active mode. A no-op under "custom",
 * which is the mode a drag puts you in: sorting there would undo the drag on
 * the next render.
 *
 * Called from renderGallery rather than only when the mode is picked, so the
 * usage-driven modes stay live the way the sidebar's do: opening a board
 * re-ranks the gallery on the spot instead of at the next launch.
 *
 * Every usage-driven sort falls back to alphabetical, so boards that have never
 * been opened land in a stable, predictable order rather than whatever the
 * array happened to hold.
 */
function applyBoardSortMode(): void {
  const mode = kbSettings.boardSort;
  if (mode === "custom") return;
  const byName = (a: Board, b: Board): number => a.name.localeCompare(b.name);
  const next = [...boards];
  switch (mode) {
    case "newest":
      next.sort((a, b) => b.createdAt - a.createdAt);
      break;
    case "oldest":
      next.sort((a, b) => a.createdAt - b.createdAt);
      break;
    case "az":
      next.sort(byName);
      break;
    case "za":
      next.sort((a, b) => byName(b, a));
      break;
    case "recent":
      next.sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0) || byName(a, b));
      break;
    case "used":
      next.sort((a, b) => (b.openCount ?? 0) - (a.openCount ?? 0) || byName(a, b));
      break;
  }
  // Only written when it actually moved. This runs on every gallery render, and
  // marking the index dirty each time would be a disk write per repaint.
  if (next.every((b, i) => boards[i].id === b.id)) return;
  boards = next;
  markIndex();
}

/** Switches the gallery's sort mode and applies it. */
function setBoardSortMode(mode: BoardSortMode): void {
  if (kbSettings.boardSort === mode) return;
  kbSettings.boardSort = mode;
  markSettings();
  applyBoardSortMode();
  renderGallery();
  renderBoardOrderList();
  renderBoardOrderSummary();
}

/** Notes that a board was opened, feeding the Most Recent / Most Used sorts.
 *  Stamped separately from updatedAt: opening a board is not editing it. */
function recordBoardUsage(board: Board): void {
  board.lastOpenedAt = Date.now();
  board.openCount = (board.openCount ?? 0) + 1;
  markIndex();
  // Under a usage-driven mode the order this just changed is on screen behind
  // the board being opened, so it is re-applied now rather than at next launch.
  if (kbSettings.boardSort === "recent" || kbSettings.boardSort === "used") {
    applyBoardSortMode();
  }
}

let _boardOrderModal: Modal | null = null;
let boardOrderReturn: (() => void) | null = null;
/* -----------------------------------------------------------------------------
   THE DEFAULT COLUMNS EDITOR
   -----------------------------------------------------------------------------
   What a NEW board starts with. It used to draw its drag list inline under its
   own row on Setup > Boards, which made that tab the one place in the tool
   where a setting was edited in the middle of a list of settings, and gave a
   drag list no room to be dragged in.

   Now it is the same row every other list-valued setting uses (Card Layout,
   Column Sort, Board Order): the name, a badge saying how it stands, and a
   button that always says Customize.
----------------------------------------------------------------------------- */

let _defaultColumnsModal: Modal | null = null;
let defaultColumnsReturn: (() => void) | null = null;

/** Two words, because that is what a badge is read for: how many, and whether
 *  anyone has touched it. */
function renderDefaultColumnsSummary(): void {
  const badge = document.getElementById("kbDefaultColumnsSummary");
  if (!badge) return;
  const count = defaultColumnTitles().length;
  const untouched = kbSettings.defaultColumns === SYSTEM_DEFAULT_COLUMNS;
  badge.textContent = `${count} ${count === 1 ? "column" : "columns"} \u00b7 ${toolBadge(untouched)}`;
}

function getDefaultColumnsModal(): Modal {
  if (_defaultColumnsModal) return _defaultColumnsModal;

  _defaultColumnsModal = new Modal(document.getElementById("kbDefaultColumnsBackdrop")!, {
    closeOnEsc: true,
    onOpen: () => renderDefaultColumns(),
    onClosed: () => {
      const back = defaultColumnsReturn;
      defaultColumnsReturn = null;
      renderDefaultColumnsSummary();
      back?.();
    },
  });

  document.getElementById("kbDefaultColumnsBack")!.addEventListener("click", () => {
    _defaultColumnsModal!.close({ handoff: true });
    const go = defaultColumnsReturn;
    defaultColumnsReturn = null;
    go?.();
  });
  document
    .getElementById("kbDefaultColumnsClose")!
    .addEventListener("click", () => _defaultColumnsModal!.close());

  document.getElementById("kbAddDefaultColumnBtn")!.addEventListener("click", () => {
    const titles = defaultColumnTitles();
    titles.push("New Column");
    setDefaultColumnTitles(titles);
    renderDefaultColumns();
  });

  document.getElementById("kbResetDefaultColumnsBtn")!.addEventListener("click", () => {
    kbConfirm(
      {
        title: "Reset the default columns?",
        message:
          "A new board goes back to starting with the five columns this app ships with. " +
          "Boards that already exist keep theirs.",
        confirmLabel: "Reset",
        reopen: () => getDefaultColumnsModal().open(),
      },
      () => {
        kbSettings.defaultColumns = SYSTEM_DEFAULT_COLUMNS;
        markSettings();
        renderDefaultColumns();
        flash("Default columns reset.");
      },
    );
  });

  return _defaultColumnsModal;
}

/** Opens the editor. `back` is where its Back arrow goes. */
function openDefaultColumns(back?: () => void): void {
  defaultColumnsReturn = back ?? null;
  const backBtn = document.getElementById("kbDefaultColumnsBack") as HTMLElement;
  backBtn.style.display = back ? "" : "none";
  topOpenKanbanModal()?.close({ handoff: true });
  getDefaultColumnsModal().open();
}

/** Which row is mid-drag, shared by every row's dragover handler. */
let boardOrderDragId: string | null = null;

function renderBoardOrderSummary(): void {
  const badge = document.getElementById("kbBoardOrderSummary");
  if (!badge) return;
  const label = BOARD_SORT_MODES.find((m) => m.mode === kbSettings.boardSort)?.label ?? "Newest First";
  badge.textContent = `${boards.length} ${boards.length === 1 ? "board" : "boards"} \u00b7 ${label}`;
}

function renderBoardOrderList(): void {
  const host = document.getElementById("kbBoardOrderList");
  if (!host) return;
  host.replaceChildren();

  // The select shows the mode in force, including the Custom it can never be
  // set to by hand.
  const sortSelect = document.getElementById("kbBoardSortSelect") as HTMLSelectElement | null;
  if (sortSelect) sortSelect.value = kbSettings.boardSort;

  if (boards.length === 0) {
    const empty = document.createElement("p");
    empty.className = "placeholder-text";
    empty.textContent = "No boards yet, so there is nothing to put in order.";
    host.appendChild(empty);
    return;
  }

  for (const board of boards) {
    const row = document.createElement("div");
    row.className = "kb-board-order-row";
    row.draggable = boards.length > 1;
    row.dataset.boardId = board.id;

    const grip = document.createElement("span");
    grip.className = "kb-column-grip";
    grip.textContent = "⠳";
    row.appendChild(grip);

    const name = document.createElement("span");
    name.className = "kb-board-order-name";
    name.textContent = board.name;
    row.appendChild(name);

    const live = liveCardsOnBoard(board.id).length;
    const count = document.createElement("span");
    count.className = "setup-item-count";
    count.textContent = `${live} ${live === 1 ? "card" : "cards"}`;
    row.appendChild(count);

    row.addEventListener("dragstart", (e) => {
      boardOrderDragId = board.id;
      row.classList.add("kb-dragging");
      e.dataTransfer?.setData("text/plain", board.name);
    });
    // Committed on dragend rather than drop, so a release anywhere (on the
    // list, on the padding, outside the window) still lands the new order.
    row.addEventListener("dragend", () => {
      row.classList.remove("kb-dragging");
      boardOrderDragId = null;
      commitBoardOrderFromDom(host, ".kb-board-order-row");
    });
    row.addEventListener("dragover", (e) => {
      if (!boardOrderDragId || boardOrderDragId === board.id) return;
      e.preventDefault();
      const dragged = host.querySelector<HTMLElement>(
        `.kb-board-order-row[data-board-id="${CSS.escape(boardOrderDragId)}"]`,
      );
      if (!dragged) return;
      const rect = row.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      host.insertBefore(dragged, before ? row : row.nextSibling);
    });

    host.appendChild(row);
  }
}

/** Reads the order back off the DOM and writes it to `boards`. Reading the DOM
 *  rather than tracking indices through the drag is what makes a release
 *  anywhere land correctly.
 *
 *  `selector` because boards are dragged in two places now: the reorder
 *  modal's rows and the gallery's own tiles. Both carry data-board-id and both
 *  land here, so the guards below are written once. */
function commitBoardOrderFromDom(host: HTMLElement, selector: string): void {
  const order = Array.from(host.querySelectorAll<HTMLElement>(selector))
    .map((el) => el.dataset.boardId)
    .filter((id): id is string => typeof id === "string");
  // A count that does not match means the DOM and the data disagree. Dropping
  // the reorder is the safe answer: the next render redraws from the data.
  if (order.length !== boards.length) return;
  if (order.every((id, i) => boards[i].id === id)) return;

  const byId = new Map(boards.map((b) => [b.id, b]));
  const next = order.map((id) => byId.get(id)).filter((b): b is Board => b !== undefined);
  if (next.length !== boards.length) return;
  boards = next;
  /* The order lives in the INDEX, not in any board's own file: it is a fact
     about the collection, and putting it in each board would mean one board's
     file deciding where another one sits. */
  markIndex();

  /* A DRAG IS WHAT PUTS YOU IN CUSTOM. Without this the next render would
     re-apply whatever sort was in force and undo the drag on the spot, which
     reads as the drag not having worked. Same rule as the sidebar's. */
  if (kbSettings.boardSort !== "custom") {
    kbSettings.boardSort = "custom";
    markSettings();
    const sortSelect = document.getElementById("kbBoardSortSelect") as HTMLSelectElement | null;
    if (sortSelect) sortSelect.value = "custom";
  }
  renderGallery();
  renderBoardOrderSummary();
}

function getBoardOrderModal(): Modal {
  if (_boardOrderModal) return _boardOrderModal;

  _boardOrderModal = new Modal(document.getElementById("kbBoardOrderBackdrop")!, {
    closeOnEsc: true,
    onOpen: () => renderBoardOrderList(),
    onClosed: () => {
      const back = boardOrderReturn;
      boardOrderReturn = null;
      renderBoardOrderSummary();
      back?.();
    },
  });

  const back = (): void => {
    _boardOrderModal!.close({ handoff: true });
    const go = boardOrderReturn;
    boardOrderReturn = null;
    // No caller-supplied return means this was opened from the gallery's own
    // background menu, which is where dismissing it already puts you.
    go?.();
  };
  document.getElementById("kbBoardOrderBack")!.addEventListener("click", back);
  document
    .getElementById("kbBoardOrderClose")!
    .addEventListener("click", () => _boardOrderModal!.close());

  const sortSelect = document.getElementById("kbBoardSortSelect") as HTMLSelectElement;
  sortSelect.addEventListener("change", () => {
    const mode = BOARD_SORT_MODES.find((m) => m.mode === sortSelect.value)?.mode;
    // "custom" is disabled in the markup, so this cannot arrive from a pick.
    if (mode && mode !== "custom") setBoardSortMode(mode);
  });

  return _boardOrderModal;
}

/** Opens the reorder screen. `back` is where its Back arrow goes; omit it when
 *  there is nothing behind this screen to return to. */
function openBoardOrder(back?: () => void): void {
  boardOrderReturn = back ?? null;
  // The Back arrow only means anything when something asked to be returned to.
  const backBtn = document.getElementById("kbBoardOrderBack") as HTMLElement;
  backBtn.style.display = back ? "" : "none";
  topOpenKanbanModal()?.close({ handoff: true });
  getBoardOrderModal().open();
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
  setToggle("kbOpenInEditToggle", "kbOpenInEditLabel", kbSettings.openCardsInEditMode);
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

  renderScaleSummaries();
  renderCardLayoutSummary();
  renderColumnSortSummary();
}

/* =============================================================================
   DATA TAB: EXPORT + SNAPSHOTS
============================================================================= */

/* -----------------------------------------------------------------------------
   SNAPSHOTS
   -----------------------------------------------------------------------------
   One bucket per hour, shared with every other tool that snapshots, holding one
   .bak per file that was about to be overwritten. Every write inside an hour
   refreshes that hour's bucket, so what a bucket holds is the LAST state before
   the gap, not the first. Thirty are kept.

   Because the files are split, a bucket holds the boards you actually touched
   in that hour and the index, and not the boards you did not.

   Restoring is per file. Restoring one board puts that board's cards back
   without touching any other board.
----------------------------------------------------------------------------- */

interface KanbanBackupFileInfo {
  file: string;
  bytes: number;
  boardId: string | null;
}

interface KanbanBackupInfo {
  name: string;
  files: KanbanBackupFileInfo[];
}

/** What one captured file is, in words. The board name is looked up rather than
 *  stored in the snapshot, so a board renamed since is described by the name it
 *  has now, which is the one you will recognize. */
function describeBackupFile(entry: KanbanBackupFileInfo): string {
  if (!entry.boardId) return "Board list and tags";
  const board = getBoard(entry.boardId);
  return board ? board.name : "a deleted board";
}

async function refreshDataTab(): Promise<void> {
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
      "No snapshots yet. The first one is taken the next time you change something, " +
      "capturing the state from before that change.";
    list.appendChild(empty);
    return;
  }

  items.forEach((item, index) => {
    const group = document.createElement("div");
    group.className = "tool-backup-group";

    const head = document.createElement("div");
    head.className = "tool-backup-head";
    const when = document.createElement("span");
    when.className = "tool-backup-when";
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
      row.className = "setup-item tool-backup-row";

      const what = document.createElement("span");
      what.className = "setup-item-name";
      what.textContent = describeBackupFile(entry);
      row.appendChild(what);

      const size = document.createElement("span");
      size.className = "tool-backup-size";
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
              "What is there now is snapshotted on the way past, so restoring the newest " +
              "entry afterwards undoes this.",
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
    if (!entry.boardId) await restoreIndexSnapshot(raw);
    else await restoreBoardSnapshot(entry.boardId, raw);

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
  const restored = parsed.boards.map(normalizeBoardMeta).filter((b): b is Board => b !== null);

  // Contents already in memory are carried across onto the restored metadata,
  // so restoring the list does not empty every board you had open.
  const current = new Map(boards.map((b) => [b.id, b]));
  for (const board of restored) {
    const live = current.get(board.id);
    if (!live) continue;
    board.columns = live.columns;
    board.nextCardNumber = live.nextCardNumber;
    board.tagCategories = live.tagCategories;
    board.tags = live.tags;
    board.overrides = live.overrides;
  }
  boards = restored;
  // The list has been REPLACED from a snapshot, so it may be written again
  // even if the file on disk is the one that would not read.
  unblockKanbanFile("index");
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

  // A board the snapshot names that was NOT in memory has just come back, so
  // its file is read the same way a launch reads it.
  for (const board of boards) {
    if (!current.has(board.id)) await loadBoardContents(board).catch(() => undefined);
  }

  reconcile();
  if (currentBoardId && !getBoard(currentBoardId)) showKbView("boards");
  dirtyIndex = true;
  await flushSave();
  await reviveAttachmentsFor(boards.map((b) => b.id));
}

/** Restoring a board replaces that board's columns and cards and nothing else.
 *  Its index entry (name, description, background) is left alone, because those
 *  are not what you are recovering when you reach for a snapshot. */
async function restoreBoardSnapshot(boardId: string, raw: string): Promise<void> {
  const board = getBoard(boardId);
  if (!board) throw new Error("that board is no longer in the board list");

  const parsed = JSON.parse(raw) as Partial<BoardContents> | null;
  const contents = normalizeContents(parsed ?? {});

  board.columns = contents.columns;
  board.nextCardNumber = contents.nextCardNumber;
  board.tagCategories = contents.tagCategories;
  board.tags = contents.tags;
  board.overrides = contents.overrides;
  cards = cards.filter((c) => c.boardId !== boardId);
  for (const card of contents.cards) card.boardId = boardId;
  cards.push(...contents.cards);

  reconcile();
  // Replaced from a snapshot, so this board may be written again.
  unblockKanbanFile(boardId);
  markBoard(boardId);
  await flushSave();
  await reviveAttachmentsFor([boardId]);
}

/** Brings back the files the restored cards expect.
 *
 *  Deleting a card retires its attachments rather than unlinking them (see the
 *  store's note in kanban.rs), so a restore that brings the card back can bring
 *  its files back too, for as long as the snapshot describing them survives. */
async function reviveAttachmentsFor(boardIds: string[]): Promise<void> {
  let revived = 0;
  for (const boardId of boardIds) {
    const wanted = cards
      .filter((c) => c.boardId === boardId)
      .flatMap((c) => allAttachments(c).map((a) => a.id));
    if (wanted.length === 0) continue;
    try {
      revived += await invoke<number>("revive_kanban_attachments", {
        boardId,
        attachmentIds: wanted,
      });
    } catch (err) {
      // The cards are back either way, and their files then report themselves
      // as missing rather than the restore failing over them.
      devError("[kanban] attachment revive failed", err);
    }
  }
  if (revived > 0) flash(`Restored ${revived} attached file(s) with it.`);
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

/* =============================================================================
   INIT + SHELL HOOKS
============================================================================= */


/* =============================================================================
   CARDS FROM ANOTHER TOOL
   -----------------------------------------------------------------------------
   The Whiteboard sends lines of text here to become bare cards, and pictures
   of the board to become a card carrying one. It is the same
   arrangement the agent bridge has, for the same reason: createCard is what the
   buttons call, so a card sent from elsewhere gets a real number, lands where a
   person adding it would have put it, and appears on the board at once.

   ALL OR NOTHING, DECIDED BEFORE ANYTHING IS MADE. Every reason the batch
   cannot land (still loading, a folder from a newer build, a board file that
   would not read, no room) is checked first, so a refusal leaves no half of a
   batch behind on the board.

   "SAVED" MEANS ON DISK. The answer is given after flushSave(), and says
   whether the board actually left the dirty set. The caller clears its own copy
   of the text only on a yes, because a batch that is in memory and has not
   been written yet is still one crash away from existing nowhere.
============================================================================= */

/** A board as another tool needs to see it: enough to offer it in a picker. */
export interface KanbanTarget {
  id: string;
  name: string;
  columns: { id: string; title: string }[];
  /** The board's tags still in use, in the order its setup lists them. */
  tags: { id: string; name: string; category: string }[];
}

/** Every board, in the order the gallery shows them, or null while Kanban is
 *  still loading and has nothing trustworthy to offer. */
export function kanbanTargets(): KanbanTarget[] | null {
  if (!storeLoaded) return null;
  return boards.map((b) => ({
    id: b.id,
    name: b.name,
    columns: b.columns.map((c) => ({ id: c.id, title: c.title })),
    tags: b.tagCategories
      .filter((cat) => cat.status === "active")
      .flatMap((cat) =>
        b.tags
          .filter((t) => t.categoryId === cat.id && t.status === "active")
          .map((t) => ({ id: t.id, name: t.name, category: cat.name })),
      ),
  }));
}

/** A card as a picker lists it. */
export interface CardMatch {
  id: string;
  number: number;
  title: string;
  column: string;
}

/**
 * Cards on a board matching what was typed, best first, for finding one whose
 * exact name you cannot remember.
 *
 * Every word has to match, through the board's own filter (cardMatchesText),
 * so "crash bob" finds the card whose comment mentions Bob's crash log. The
 * ranking puts the title first: a number typed as the card's number, then a
 * title that starts with the words, then one that has every word, then cards
 * that matched only on what is written inside them. Nothing typed lists the
 * most recently changed cards.
 */
export function findCardsOnBoard(boardId: string, query: string, limit = 20): CardMatch[] {
  const board = getBoard(boardId);
  if (!board) return [];
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const live = liveCardsOnBoard(board.id);
  const scored: { card: Card; score: number }[] = [];
  for (const card of live) {
    if (!words.every((w) => cardMatchesText(card, w))) continue;
    const title = card.title.toLowerCase();
    const q = words.join(" ");
    let score = 0;
    if (words.length === 1 && String(card.number) === words[0].replace(/^#/, "")) {
      score = 4;
    } else if (q && title.startsWith(q)) score = 3;
    else if (words.length > 0 && words.every((w) => title.includes(w))) score = 2;
    else if (words.length > 0) score = 1;
    scored.push({ card, score });
  }
  scored.sort((a, b) => b.score - a.score || b.card.updatedAt - a.card.updatedAt);
  return scored.slice(0, limit).map(({ card }) => ({
    id: card.id,
    number: card.number,
    title: card.title,
    column: getColumn(board, card.columnId)?.title ?? "",
  }));
}

/** What new cards can carry from the start, beyond a title. */
export interface IncomingOptions {
  tagIds?: string[];
  priority?: Priority;
  effort?: Effort;
  /** A due date as YYYY-MM-DD, a day and never a moment. */
  due?: string;
  /** Added under whatever the card already carries in its description. */
  description?: string;
}

/** Options checked against the board: tags that are not on it, or no longer
 *  in use, are left off rather than refusing the send. */
function applyIncomingOptions(card: Card, board: Board, options: IncomingOptions | undefined): void {
  if (!options) return;
  // Checked against the ladder rather than carried, unlike a card's own stored
  // level: this is a value arriving from outside, and a rung that does not
  // exist is a mistake at the source rather than history to preserve.
  if (options.priority && priorityLevelOf(options.priority)) card.priority = options.priority;
  if (options.effort && effortLevelOf(options.effort)) card.effort = options.effort;
  // A due date is a day. A value that is not one is left off rather than
  // stored as something the card cannot read back.
  if (options.due && /^\d{4}-\d{2}-\d{2}$/.test(options.due) && parseDay(options.due)) {
    card.dates.due = options.due;
  }
  const extra = options.description?.trim();
  if (extra) card.description = trimTo([card.description, extra].filter(Boolean).join("\n\n"), MAX_DESC_LEN);
  const known = new Set(board.tags.filter((t) => t.status === "active").map((t) => t.id));
  const tagIds = (options.tagIds ?? []).filter((id) => known.has(id));
  if (tagIds.length > 0) card.tagIds = [...new Set(tagIds)];
}

export interface IncomingCard {
  title: string;
  description: string;
  /** Checklist lines, as the card's subtasks. */
  subtasks?: { text: string; done: boolean }[];
}

export type IncomingCardsResult =
  | { ok: true; numbers: number[]; saved: boolean }
  | { ok: false; error: string };

/** Adds the cards to the bottom of one column, in the order given, and writes
 *  the board before answering. */
export async function addCardsFromElsewhere(
  boardId: string,
  columnId: string,
  incoming: IncomingCard[],
  options?: IncomingOptions,
): Promise<IncomingCardsResult> {
  const refusal = incomingRefusal(boardId, columnId, incoming.length);
  if (refusal) return { ok: false, error: refusal };
  // The refusal above has already found both.
  const board = getBoard(boardId)!;
  const column = getColumn(board, columnId)!;

  const numbers: number[] = [];
  for (const item of incoming) {
    const title = item.title.trim();
    if (!title) continue;
    // Room was checked above, so this cannot come back null.
    const card = createCard(board, column.id, title, "bottom");
    if (!card) break;
    card.description = trimTo(item.description, MAX_DESC_LEN);
    applyIncomingOptions(card, board, options);
    card.subtasks = (item.subtasks ?? [])
      .filter((t) => t.text.trim())
      .slice(0, MAX_SUBTASKS_PER_CARD)
      .map((t) => ({ id: newId(), text: trimTo(t.text.trim(), MAX_TITLE_LEN), done: t.done }));
    stampCard(card);
    numbers.push(card.number);
  }

  renderAll();
  await flushSave();
  return { ok: true, numbers, saved: !dirtyBoards.has(board.id) };
}

/** Everything that stops anything being written to a board. Null when it can. */
function boardRefusal(boardId: string): string | null {
  if (!storeLoaded) return "Kanban is still loading. Try again in a moment.";
  const frozen = writesFrozen();
  if (frozen) return `Kanban is not saving: ${frozen}`;
  const board = getBoard(boardId);
  if (!board) return "That board no longer exists.";
  if (unreadableFiles.has(board.id) || unreadableFiles.has("index")) {
    return `Kanban could not read the file for "${board.name}" when the app started, so nothing is added to it.`;
  }
  return null;
}

/** Everything that stops a batch landing on a board, asked before anything is
 *  made. Null when it can land. */
function incomingRefusal(boardId: string, columnId: string, count: number): string | null {
  const refused = boardRefusal(boardId);
  if (refused) return refused;
  const board = getBoard(boardId)!;
  if (!getColumn(board, columnId)) return `That column is no longer on "${board.name}".`;
  const room = MAX_CARDS_PER_BOARD - liveCardsOnBoard(board.id).length;
  if (count > room) {
    return `"${board.name}" has room for ${room.toLocaleString()} more ${room === 1 ? "card" : "cards"}.`;
  }
  return null;
}

/** A PNG added to a card that already exists. Stored first, so a refused
 *  store leaves the card as it was. */
export async function attachImageToCard(
  boardId: string,
  cardId: string,
  fileName: string,
  pngBase64: string,
): Promise<IncomingImageResult> {
  const refusal = boardRefusal(boardId);
  if (refusal) return { ok: false, error: refusal };
  const card = getCard(cardId);
  if (!card || card.boardId !== boardId || card.archived) {
    return { ok: false, error: "That card is no longer on the board." };
  }
  // The card modal saves as you type, so a card open in it is left alone, the
  // same rule an agent is held to.
  if (openCardId === card.id) return { ok: false, error: `Card #${card.number} is open in Kanban.` };
  if (card.attachments.length >= MAX_ATTACHMENTS) {
    return { ok: false, error: `Card #${card.number} has ${MAX_ATTACHMENTS} attachments, the most it can hold.` };
  }
  if (pngBase64.length > (MAX_ATTACHMENT_BYTES / 3) * 4) {
    return {
      ok: false,
      error: `That image is over the ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB limit for one attachment.`,
    };
  }
  let stored: { id: string; name: string; size: number; file: string };
  try {
    stored = await invoke("paste_kanban_attachment", {
      boardId,
      attachmentId: newId(),
      name: fileName,
      dataBase64: pngBase64,
    });
  } catch (err) {
    return { ok: false, error: String(err) };
  }
  // Asked again: the card could have gone while the image was being written.
  const still = getCard(cardId);
  if (!still || still.archived) {
    void invoke("delete_kanban_attachment", { boardId, attachmentId: stored.id }).catch(() => {});
    return { ok: false, error: "That card is no longer on the board." };
  }
  still.attachments.push({
    id: stored.id,
    name: stored.name,
    size: stored.size,
    file: stored.file,
    addedAt: Date.now(),
  });
  stampCard(still);
  renderAll();
  await flushSave();
  return { ok: true, number: still.number, saved: !dirtyBoards.has(boardId) };
}

export type IncomingImageResult =
  | { ok: true; number: number; saved: boolean }
  | { ok: false; error: string };

/** One card at the bottom of a column, carrying a PNG as its attachment. The
 *  image goes into the attachment store first, so a store that refuses it
 *  leaves no card behind pointing at nothing. */
export async function addImageCardFromElsewhere(
  boardId: string,
  columnId: string,
  title: string,
  fileName: string,
  pngBase64: string,
  options?: IncomingOptions,
): Promise<IncomingImageResult> {
  const refusal = incomingRefusal(boardId, columnId, 1);
  if (refusal) return { ok: false, error: refusal };
  if (pngBase64.length > (MAX_ATTACHMENT_BYTES / 3) * 4) {
    return {
      ok: false,
      error: `That image is over the ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB limit for one attachment.`,
    };
  }

  let stored: { id: string; name: string; size: number; file: string };
  try {
    stored = await invoke("paste_kanban_attachment", {
      boardId,
      attachmentId: newId(),
      name: fileName,
      dataBase64: pngBase64,
    });
  } catch (err) {
    return { ok: false, error: String(err) };
  }

  // Asked again: the board could have gone while the image was being written.
  const board = getBoard(boardId);
  const column = board ? getColumn(board, columnId) : null;
  const card = board && column ? createCard(board, column.id, title.trim() || fileName, "bottom") : null;
  if (!card) {
    void invoke("delete_kanban_attachment", { boardId, attachmentId: stored.id }).catch(() => {});
    return { ok: false, error: "That board or column no longer exists." };
  }
  card.attachments.push({
    id: stored.id,
    name: stored.name,
    size: stored.size,
    file: stored.file,
    addedAt: Date.now(),
  });
  applyIncomingOptions(card, board!, options);
  stampCard(card);
  renderAll();
  await flushSave();
  return { ok: true, number: card.number, saved: !dirtyBoards.has(boardId) };
}

export function initKanban(): void {
  // Written out on the way past if anything is still queued. See
  // flushOnQuit in shell.ts.
  flushOnQuit("kanban", onKanbanToolExit);
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

  /* ── Header ── */
  document.getElementById("kbSetupBtn")!.addEventListener("click", () => openSetupOnTab("boards"));

  /* The gallery's own background. A tile's menu stops propagation, so this only
     ever answers a click on the empty space around them, which is the one place
     on this screen with no control to hang "reorder" off.

     IT ENDS WITH THE APP-WIDE ROWS, and that is not decoration. attachMenu
     stops the event once it has rows to show, so the window-level handler in
     shell.ts never runs and About, App Settings, Toggle View and Exit simply
     vanished from every right-click on this screen. Anything that answers a
     right-click on a BACKGROUND has to carry them; backgroundMenu() is the
     same list that handler would have shown, the open tool's header buttons
     included. */
  attachMenu(document.getElementById("kbViewBoards")!, () => [
    { label: "New Board\u2026", onClick: () => openNewBoard() },
    {
      label: "Reorder Boards\u2026",
      disabled: boards.length < 2,
      // No return path: this came off the gallery background, which is where
      // dismissing it already puts you.
      onClick: () => openBoardOrder(),
    },
    { separator: true },
    ...backgroundMenu(),
  ]);
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

  bindInfoTooltips(document, ".kb-info-btn[data-tooltip]", "kb-info-tooltip");

  // Claimed once, for the life of the app. The handler checks whether this
  // tool is on screen before answering, so holding it permanently is safe and
  // several tools can hold one at the same time.
  setSubNavHandler({ back: kbSubNavBack, forward: kbSubNavForward });

  // The same "once, for the life of the app" rule, and for the same reason: an
  // agent's request has nothing to do with which tool the user is looking at.
  listenForAgentRequests();
  wireAgentsTab();

  // Last, and before the load: everything above has to be in place before any
  // shell hook is allowed to run, and loadAll() calls back into rendering.
  initialized = true;
  void loadAll();
}

/** Called by shell.ts whenever the Kanban tool is opened, including on mouse
 *  back/forward replay. Leaving for another tool and coming back is a fresh
 *  start, so the filters go, matching what walking out to the gallery does.
 *  The re-render also picks up a date rollover: a card that was "due tomorrow"
 *  when you left is overdue when you come back the next morning. */
export function onKanbanToolEntry(): void {
  // See `initialized`: the shell can route into this tool before init() has
  // reached it. loadAll() renders once it finishes, so there is nothing lost
  // by doing nothing here.
  if (!initialized) return;
  clearFilters();
  renderAll();
}

/** Called by shell.ts when the Kanban is navigated away from. Lands anything
 *  still sitting in the save debounce, so an edit made in the last half-second
 *  before leaving is not waiting on the next visit. */
export async function onKanbanToolExit(): Promise<void> {
  if (!initialized) return;
  // Leaving the tool ends any comment that was only half written. Its files
  // were already imported, so this is also the last chance to unlink them
  // before nothing points at them any more.
  discardPendingComment();
  await flushSave();
}

/** Called by shell.ts only when the sidebar icon or Home tile is clicked
 *  (never on history replay, which calls onKanbanToolEntry directly). Jumps to
 *  the gallery even from inside a board, and goes through showKbView so the
 *  jump is recorded: mouse-back then returns to the board it interrupted
 *  rather than orphaning it. */
export function onKanbanIconClicked(): void {
  if (!initialized) return;
  showKbView("boards");
}
