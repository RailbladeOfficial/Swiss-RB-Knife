/* =============================================================================
   KANBAN MODEL: what a board is made of
   -----------------------------------------------------------------------------
   The shapes and the fixed vocabulary. A Board, a Column, a Card, a Tag; the
   priority and effort ladders with the names and colors they ship with; the
   stages; the ceilings; the color maths for a card someone has painted.

   A LEAF. This file imports nothing, from anywhere, and that is its whole
   job. Every other Kanban file is in a load-order loop with kanban.ts, which
   is safe but delicate, and the thing that makes those loops thick is that
   the types and constants everyone needs used to live in the middle of the
   board. Now they do not, and each loop carries only what genuinely has to
   cross it: live state and the operations on it.

   Nothing here reads the tool's state, touches the DOM, or calls the back
   end. Anything that wants to do one of those is not model, and the two
   label functions are the worked example: the priority NAMES ship from here,
   but priorityLabel() reads the board's rename and so stays in kanban.ts.

   If you add something here and find yourself reaching for an import, that
   is the file telling you the thing belongs somewhere else.
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
   THE TWO SCALES
   -----------------------------------------------------------------------------
   PRIORITY is how urgent a card is. EFFORT is how heavy it is, which is a
   different question: the most urgent thing on a board is often the smallest,
   and the biggest is often the one nobody has scheduled. A board that can only
   say "critical" cannot tell those apart, so they are two ladders rather than
   one.

   BOTH ARE NOW BUILT, not fixed. They shipped as five rungs each and stayed
   that way on the argument that a shared scale only means something if "High"
   means the same everywhere. That argument holds for one scale being shared,
   which it still is: these live in the tool's settings and no board overrides
   them. It never held for the NUMBER five, which was only ever the number this
   app happened to pick. Three is a real answer, and so is fifteen.

   AN ID IS NOT A NAME. Cards store the id, which is made once and never moves;
   the name and the color are what you edit. That is what makes renaming
   "High" to "Now" a rename rather than a silent reassignment of every card.

   ORDER IS RANK, lowest to highest, and it is the array's own order. Sorting
   by Priority and painting a card by it both read the position, so dragging a
   rung up the list is the whole of what reordering means.

   "NONE" IS NOT A RUNG. It is the absence of one: never in the array, never
   deletable, never colored, and always offered first, both in a picker and in
   the editor. A card with no priority set must not be painted gray as though
   gray were a priority. Only its NAME is settable, which is why the label sits
   in settings beside the ladder rather than in it.

   REMOVING A RUNG IS THE HARD CASE, and it is handled where the cards are
   (see THE SCALE EDITOR in kanban.ts), not here. A card set to a level that
   stopped existing has no honest answer, so the editor counts what is on the
   rung across every board and makes you say where those cards go before it
   will delete it.
----------------------------------------------------------------------------- */

/** A rung's id, or NO_LEVEL. Priority and Effort are the same shape and the
 *  same code serves both; the two aliases below exist so a signature still
 *  says which scale it is talking about. */
export type LevelId = string;
export type Priority = LevelId;
export type Effort = LevelId;

/** The absence of a level. Reserved: no rung may be given this id. */
export const NO_LEVEL = "none";

/** One rung. */
export interface ScaleLevel {
  id: string;
  name: string;
  color: string;
}

/** What the absence of a level is called until someone renames it. */
export const DEFAULT_NONE_LABEL = "None";

/** Blue, then green through red. Blue rather than a paler green for Trivial
 *  because it sits OUTSIDE the urgency ramp: "worth doing, not worth ranking"
 *  is a different statement from "low urgency", and a colder hue says that
 *  without needing a legend.
 *
 *  The ids are the five this app shipped with, and they are load-bearing: a
 *  card written by any earlier version stores one of them. */
export const DEFAULT_PRIORITY_LEVELS: readonly ScaleLevel[] = [
  { id: "trivial", name: "Trivial", color: "#3e8ce8" },
  { id: "low", name: "Low", color: "#30a46c" },
  { id: "medium", name: "Medium", color: "#e0a11b" },
  { id: "high", name: "High", color: "#e5651f" },
  { id: "critical", name: "Critical", color: "#e5484d" },
];

/** A single hue getting darker rather than Priority's green-to-red ramp.
 *  Effort is not a warning, and painting a big card red would read as an alarm
 *  next to a board whose reds already mean "urgent". */
export const DEFAULT_EFFORT_LEVELS: readonly ScaleLevel[] = [
  { id: "tiny", name: "Tiny", color: "#9db8d8" },
  { id: "small", name: "Small", color: "#6f97c9" },
  { id: "medium", name: "Medium", color: "#4a76b8" },
  { id: "large", name: "Large", color: "#33569a" },
  { id: "huge", name: "Huge", color: "#233a72" },
];

/** Long enough that nobody sensible meets it, short enough that the pickers
 *  stay pickers: a right-click submenu scrolls past 10.5 rows, and a scale
 *  that needs more than this is a tag category wearing a ladder's clothes. */
export const MAX_SCALE_LEVELS = 50;

/** A rung's name is drawn in a chip on a card face. A 400-character one would
 *  push the rest of the card off the screen. */
export const MAX_LEVEL_NAME_LEN = 24;

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

/**
 * Who made this, when it was not the person at the keyboard.
 *
 * ABSENT MEANS THE USER, which is every card and every comment that existed
 * before agent access did, so nothing has to be migrated and nothing has to be
 * versioned. The same rule Board.overrides and Attachment.file already follow.
 *
 * `by` is the CONNECTION id, not the token: revoking and reissuing a token
 * leaves an agent still recognized as the author of its own cards, which is
 * what makes "edit cards it created" survive a rotated secret.
 */
export interface AgentAuthor {
  kind: "agent";
  by: string;
  label: string;
}

/* -----------------------------------------------------------------------------
   WHOSE CARD IS IT
   -----------------------------------------------------------------------------
   Three answers, because "who made this" and "whose request is it" are the same
   question on a board one person shares with their agents:

     user      the person using the app
     agent     an AI agent, named, and matched by id so an agent still owns the
               cards it made after its connection secret is regenerated
     external  somebody else asked for this. Their name is free text, because
               they are not a user of this app and never will be.

   ABSENT MEANS USER. Every card written before this existed was made by the
   person at the keyboard, so undefined reads as "user" rather than "unknown".
   Storing nothing for the common case also keeps the board files from growing
   a line per card to say the obvious.
----------------------------------------------------------------------------- */

export interface UserAuthor {
  kind: "user";
}

export interface ExternalAuthor {
  kind: "external";
  /** Who asked. Free text: they are not a user of this app. */
  label: string;
}

export type CardAuthor = AgentAuthor | UserAuthor | ExternalAuthor;

export const AUTHOR_KINDS = ["user", "agent", "external"] as const;

/** How an owner reads in the stats table and the menu. */
export function authorLabel(author: CardAuthor | undefined): string {
  if (!author || author.kind === "user") return "You";
  if (author.kind === "agent") return author.label;
  return author.label ? `${author.label} (external)` : "External";
}

/**
 * A file hung off a card or off one of its comments.
 *
 * `path` is the TOOL'S OWN COPY, inside kanban-attachments/, never the file the
 * user picked. That is what makes an attachment survive its source being moved,
 * renamed or thrown away, and it is what lets the copy be unlinked when the
 * thing holding it goes.
 *
 * `name` is the original filename and exists only to be read: the copy on disk
 * is named by the attachment's id, so two "screenshot.png" cannot collide.
 *
 * How it is DRAWN is derived from the name, never stored: see attachmentKind.
 * Storing it would mean a file that renders as a picture today because the
 * extension list said so then.
 */
export interface Attachment {
  /** Also the FILENAME of the copy, inside its board's folder. There is
   *  deliberately no path field: where the file lives is derived from the board
   *  and this id, so a card cannot point at a file outside its own board, a
   *  restored snapshot cannot resurrect a pointer to a stranger's file, and
   *  deleting a board is deleting one folder rather than walking its cards. */
  id: string;
  /** The ORIGINAL filename, for display. The copy on disk is named by the id,
   *  and keeps only this name's extension. */
  name: string;
  /** Bytes of the original, as measured when it was copied in. */
  size: number;
  addedAt: number;
  /** What the copy is called inside its board's folder: the id plus the
   *  original's extension. Absent on anything attached before the extension was
   *  kept, where the file is named by the bare id and that is the fallback.
   *
   *  Written down rather than derived from `name`, so a rule change in the back
   *  end can never leave the front end pointing at a filename that is not
   *  there. It is still only ever the id plus an extension, so it cannot name a
   *  file outside its own board. */
  file?: string;
}

/**
 * A note added to a card after the fact, with its own formatting and its own
 * files. Separate from the description because the two answer different
 * questions: the description is what this card IS and gets edited in place,
 * a comment is what happened and is appended.
 */
export interface CardComment {
  id: string;
  /** Markdown, same dialect as a description. */
  body: string;
  attachments: Attachment[];
  createdAt: number;
  /** Equal to createdAt until the comment is edited; the card shows "edited"
   *  off the difference rather than off a separate flag. */
  updatedAt: number;
  /** Set only when an AI agent wrote this comment. See AgentAuthor. */
  createdBy?: AgentAuthor;
}

/** The four shapes an attachment is drawn in, decided by its extension.
 *  Anything unrecognized is a "file", which is a row you can open rather than
 *  an error: the app not knowing how to preview a .docx is no reason to refuse
 *  to hold one. */
export type AttachmentKind = "image" | "video" | "audio" | "file";

/** Extensions the WebView can draw or play. Deliberately narrower than what can
 *  be ATTACHED: a format outside these lists still attaches and still opens in
 *  whatever program owns it, it just is not previewed in the card. */
export const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif", "ico"]);
export const VIDEO_EXTS = new Set(["mp4", "webm", "ogv", "m4v", "mov"]);
export const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "oga", "m4a", "flac", "aac", "opus"]);

export function attachmentExt(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

export function attachmentKind(name: string): AttachmentKind {
  const ext = attachmentExt(name);
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  return "file";
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
  /** How heavy the card is, independent of how urgent. "none" is unset. */
  effort: Effort;
  tagIds: string[];
  subtasks: Subtask[];
  /** Files hung off the card itself, as opposed to off one of its comments. */
  attachments: Attachment[];
  comments: CardComment[];
  dates: CardDates;
  /** Out of the board but not destroyed. Archived cards keep their column so
   *  restoring puts them back where they were. */
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  /** Position within its column. Re-sequenced 0..n-1 on every commit. */
  order: number;
  /** Whose card this is. Absent means the person using the app, which is what
   *  every card written before owners existed was. See CardAuthor. */
  createdBy?: CardAuthor;
}

export interface Column {
  id: string;
  title: string;
  /** Kanban's one non-negotiable practice. null means unlimited. */
  wipLimit: number | null;
  /** Cards here count as finished: throughput is measured from this column,
   *  and (with the preference on) a card moved here is stamped Completed. */
  isDone: boolean;
  /** The stage date a card moved into this column is stamped with, when it has
   *  none yet and the board's preference is on. Only Work Started or Testing
   *  Started: a done column stamps Completed, so a column never holds both.
   *  null (or absent) stamps nothing. */
  stage?: "started" | "testing" | null;
  collapsed: boolean;
  /** How this column is sorted, as a VIEW over the hand-made order.
   *
   *  `null` (or absent) follows the board's default. An empty array is an
   *  explicit "manual, whatever the board says", which is not the same thing:
   *  a column you deliberately dragged into shape has to be able to stay that
   *  way after the board's default changes under it. */
  sort?: SortRule[] | null;
}

export interface BoardBackground {
  /** The image's FILENAME inside the app's kanban-backgrounds/ folder.
   *
   *  Records written before the data folder was split per tool hold a whole
   *  absolute path into the old flat layout instead. Only the filename is ever
   *  read, so those keep working and repair themselves the next time the board
   *  is saved. See backgroundSrc. */
  path: string;
  /** CSS blur radius in px, 0-24. */
  blur: number;
  /** CSS brightness percentage, 15-150. */
  brightness: number;
}

/**
 * A board, as the app holds it in memory. On disk, inside kanban/, it is split
 * in two:
 *
 *   the INDEX (kanban-index.json) carries id, name, description, background,
 *   createdAt and updatedAt, so the gallery is one small read rather than a
 *   read of every board you own;
 *
 *   the BOARD FILE (kanban-boards/kanban-board-<id>.json) carries columns and
 *   nextCardNumber, alongside that board's cards.
 *
 * The split is what keeps a snapshot small: a board write captures that board
 * and the index, and no other board.
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
  /** Epoch ms this board was last OPENED, and how many times. Absent until it
   *  has been. They feed the Most Recent and Most Used board sorts, and they
   *  are deliberately separate from updatedAt: opening a board is not editing
   *  it, and a sort called "most recent" that reshuffled when you merely read
   *  something would be answering a different question.
   *
   *  Same pair, same names and same purpose as SidebarItemState's, because
   *  this is that feature one level down. */
  lastOpenedAt?: number;
  openCount?: number;
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
  "columns" | "nextCardNumber" | "tagCategories" | "tags" | "overrides"
>;

/** The board fields that live in the per-board file. Its tags are in here
 *  rather than in the index because they belong to that board's contents, not
 *  to the list of boards. */
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
/** Where a new card lands. `{ below }` is a card id: the new one goes directly
 *  under it, which is what "Add Card Below" on the right-click menu means. */
export type NewCardPosition = "top" | "bottom" | { below: string };

/** The blocks of the card modal, in the order they are shown. Reorderable, as
 *  a default and then per board, because which of these you look at first is a
 *  property of how you work rather than of the tool. */
/* WHAT IS AND IS NOT REORDERABLE.
   Only the blocks that share the Basic tab. Subtasks and Comments have tabs of
   their own now and Tags is a fixed column at the top, so none of the three has
   an "order" to be in any more. An old stored order still naming them is not an
   error: normalizeSectionOrder keeps only ids this build knows, so those names
   are dropped on read and the rest keep their positions. */
export type CardSection = "description" | "attachments" | "due" | "stages";

export const CARD_SECTIONS: readonly CardSection[] = [
  "description",
  "attachments",
  "due",
  "stages",
];

export const CARD_SECTION_LABELS: Record<CardSection, string> = {
  description: "Description",
  attachments: "Attachments",
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
  /** Stamp a card's stage date when it moves into a column that stamps one.
   *  Named for the only column it used to cover, and kept, because boards and
   *  settings files already store it under this key. */
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
  /** How a column sorts its cards when it has no rules of its own. Empty is
   *  the hand-made order, which is what a board is for; a board whose columns
   *  are all "by priority, then by type" can say so once here instead of on
   *  every column. */
  defaultSort: SortRule[];
  /** Cards open with their fields live and stay that way.
   *
   *  NOT "start an edit session automatically". There is no session: every
   *  field writes as you leave it and closing the card finishes the job, which
   *  is how this tool worked before the reading face existed. So there is
   *  nothing to save and nothing to discard, and none of the three header
   *  controls are drawn.
   *
   *  Per board because it tracks how a board is USED: a board you are actively
   *  building wants the fields, and one you mostly consult wants the reading
   *  face and the protection from a stray keystroke that comes with it. */
  openCardsInEditMode: boolean;
  /** Whether cards on this board past their due date pulse the sidebar and get
   *  counted in the tool header.
   *
   *  PER BOARD, because "past its due date" only means something on a board
   *  that works to dates. A reference board or a someday list has due dates it
   *  set once and does not act on, and a tool-wide switch made that board's
   *  cards nag from every screen or turned the warning off for the boards that
   *  do work to dates. A board whose due dates are off is already excluded by
   *  isOverdue; this is the separate question of whether to shout about them. */
  overdueWarn: boolean;
}

/** Everything in BoardScopedSettings is a DEFAULT that a board may override.
 *  The four added here are tool-wide and cannot be overridden. */
export interface KbSettings extends BoardScopedSettings {
  /** How the board gallery is ordered. The same six the sidebar offers, and
   *  for the same reason: this is that feature one level down. "custom" is
   *  whatever you last dragged it into and is what a drag switches you to,
   *  because a live sort would immediately undo the drag. */
  boardSort: BoardSortMode;
  /** Comma-separated column titles a brand-new board starts with. */
  defaultColumns: string;
  /** Prefilled into the New Board form. Empty means no suggestion. */
  defaultBoardName: string;
  /** The Priority ladder, lowest to highest. Global rather than per board: a
   *  level has to mean and look the same everywhere or it stops being a shared
   *  scale. See THE TWO SCALES. */
  priorityLevels: ScaleLevel[];
  /** What "no priority set" is called. Not a rung; see THE TWO SCALES. */
  priorityNoneLabel: string;
  effortLevels: ScaleLevel[];
  effortNoneLabel: string;
}

/** How the board gallery is ordered.
 *
 *  Shaped after SidebarSortMode, but NOT a copy of it. The sidebar's "Classic"
 *  is the order ALL_TOOLS is written in, an order the app itself decided and
 *  that a user can recognize. Boards have no such order: the only thing the
 *  app knows about when a board arrived is when it was made, so "Classic" here
 *  meant "oldest first" while saying nothing about it. It is two honest modes
 *  instead. */
export type BoardSortMode = "newest" | "oldest" | "az" | "za" | "recent" | "used" | "custom";

/** The modes, with the label each one wears in the picker. One list, so the
 *  <select> and the sorter cannot come to disagree about what exists. */
export const BOARD_SORT_MODES: { mode: BoardSortMode; label: string }[] = [
  // Newest first is the default, and it is first in the list for the same
  // reason: the board you just made is almost always the one you want.
  { mode: "newest", label: "Newest First" },
  { mode: "oldest", label: "Oldest First" },
  { mode: "az", label: "A-Z" },
  { mode: "za", label: "Z-A" },
  { mode: "recent", label: "Most Recent" },
  { mode: "used", label: "Most Used" },
  { mode: "custom", label: "Custom (dragged)" },
];

/**
 * The shape of an EXPORT, and only of an export. Nothing on disk looks like
 * this: the live data is split across kanban-settings.json, kanban-index.json
 * and one file per board in kanban-boards/.
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

/** What a column can be sorted by. Tags sort by the tag a card carries FROM a
 *  named category, which is what "sort by type" and "sort by tool" mean on a
 *  board whose vocabulary is grouped that way. */
export type SortField =
  | "priority"
  | "effort"
  | "number"
  | "name"
  | "due"
  | "created"
  | "updated"
  | { category: string };

export interface SortRule {
  field: SortField;
  /** "desc" first for the ladders, because "most urgent at the top" is the
   *  thing anyone actually wants from a priority sort. */
  dir: "asc" | "desc";
}

/* =============================================================================
   CONSTANTS
============================================================================= */

/** How long an edit sits before it is written. Long enough that typing a
 *  description is one write rather than forty, short enough that a crash
 *  between keystroke and save costs half a second of typing. */
export const SAVE_DEBOUNCE_MS = 400;

/** Ceilings that exist to keep the board renderable rather than to ration
 *  anything: every card in a column is in the DOM at once, and the whole board
 *  re-renders after each drag.
 *
 *  The card ceiling counts LIVE cards only. Archived ones are excluded, so
 *  archiving finished work is the pressure valve rather than deleting it, and a
 *  board's history is not what runs it out of room.
 *
 *  5,000 rather than the original 2,000, on measurement rather than nerve. A
 *  5,000-card board of detailed cards (a paragraph of description, tags, five
 *  subtasks, a couple of comments each) is 8.4 MB of JSON and takes 24 ms to
 *  serialize, which is well inside the 400 ms save debounce. Even 10,000 is
 *  survivable at 37 ms. The data side is simply not what gives out first.
 *
 *  What gives out first is the DOM, and that is why there is still a number
 *  here at all: every live card is an element, the board rebuilds all of them
 *  after each drag, and nothing is virtualised. In practice a board stops being
 *  useful as a BOARD well before it stops being fast, because 5,000 cards is
 *  not a thing anyone can scan. Treat this as the point past which the tool
 *  stops pretending, not as a performance guarantee. */
export const MAX_CARDS_PER_BOARD = 5000;
export const MAX_COLUMNS_PER_BOARD = 24;
export const MAX_SUBTASKS_PER_CARD = 100;

export const MAX_TITLE_LEN = 200;
export const MAX_DESC_LEN = 8000;

/** Ceilings on the two things a card can now accumulate without bound. A
 *  comment thread and an attachment list are both rendered in full inside one
 *  modal, so these are the same kind of limit MAX_SUBTASKS_PER_CARD is: what
 *  keeps the card openable, not a ration. */
export const MAX_COMMENT_LEN = 8000;
export const MAX_COMMENTS_PER_CARD = 250;
export const MAX_ATTACHMENTS = 50;
/** Kept in step with MAX_ATTACHMENT_BYTES in kanban.rs, which is the one that
 *  actually enforces it. This copy exists so a paste can be refused before it
 *  is encoded rather than after. */
export const MAX_ATTACHMENT_BYTES = 256 * 1024 * 1024;

/** The card color swatches. Twelve hues at two lightnesses each would be a
 *  color picker; this is a palette, so it is one row of hues chosen to stay
 *  distinguishable from each other AND from every theme's own card surface.
 *  The custom picker beside them covers everything else. */
export const CARD_COLORS = [
  "#e5484d", "#e5651f", "#e0a11b", "#8ab61c",
  "#30a46c", "#12a5a5", "#3e8ce8", "#5b5bd6",
  "#8e4ec6", "#c94f9c", "#8b6a4a", "#6b7280",
];

/** Default color for a new tag category, and the fallback for any tag whose
 *  stored color is unreadable. */
export const DEFAULT_TAG_COLOR = "#4c8dff";

/** The column set a fresh install starts with, and what Reset puts back. Held
 *  separately from DEFAULT_SETTINGS so that "reset" means these five
 *  specifically rather than "whatever the default object happens to say" -
 *  the same thing today, and not the day someone edits one of them.
 *
 *  The trailing "*" marks the column that means done; see splitDoneMark. */
export const SYSTEM_DEFAULT_COLUMNS = "Backlog, Planned, Work In Progress, Testing, Completed*";

/** The two inks card and chip text can be set in. Near-black rather than pure
 *  black because a pure-black label on a mid-tone card reads as a hole; the
 *  contrast maths below uses these exact values, so what is measured is what
 *  is painted. */
export const DARK_INK = "#101014";
export const LIGHT_INK = "#ffffff";

export const DEFAULT_SETTINGS: KbSettings = {
  boardSort: "newest",
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
  // What the card IS and what came with it, then when it is wanted, then what
  // has happened to it. Anything can be dragged anywhere; this is only the
  // start.
  sectionOrder: ["description", "attachments", "due", "stages"],
  // Manual. A board's order is a decision someone made, and a tool that
  // rearranged it on first open would be overruling that decision unasked.
  defaultSort: [],
  // Off, so a card opens as something to read. Editing is a thing you ask for.
  openCardsInEditMode: false,
  overdueWarn: true,
  defaultColumns: SYSTEM_DEFAULT_COLUMNS,
  defaultBoardName: "",
  // Cloned per level, not just per array: these are edited in place by the
  // scale editor, and a shallow copy would let an edit reach the shipped
  // defaults that Reset to Default reads back from.
  priorityLevels: DEFAULT_PRIORITY_LEVELS.map((l) => ({ ...l })),
  priorityNoneLabel: DEFAULT_NONE_LABEL,
  effortLevels: DEFAULT_EFFORT_LEVELS.map((l) => ({ ...l })),
  effortNoneLabel: DEFAULT_NONE_LABEL,
};