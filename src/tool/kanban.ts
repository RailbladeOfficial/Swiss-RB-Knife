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

import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
import { formatBackupName, formatBackupBytes as formatBytes } from "../core/tool-backups";
import { registerTransferable } from "../core/data-transfer";
import {
  AGENT_PERMISSIONS,
  AGENT_PERMISSION_GROUPS,
  agentStatus,
  groupPermissions,
  permissionSummary,
  testAgentConnection,
  boardConfig,
  clearAgentLog,
  AGENT_CLIENTS,
  agentClient,
  connectionCommand,
  connectionConfig,
  loadAgentConfig,
  newConnection,
  opLabel,
  permissionLabel,
  readAgentLog,
  saveAgentConfig,
  type AgentLogEntry,
  starterPermissions,
  type AgentConfig,
  type AgentToken,
} from "./kanban-agents";
import {
  applyRichTextCommand,
  bindRichTextLinks,
  renderRichText,
  richTextToPlain,
  type RichTextCommand,
} from "../core/rich-text";

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

/** The names shipped with the app. What a board actually shows comes from
 *  settings, which start as a copy of this and can be renamed. */
export const DEFAULT_PRIORITY_LABELS: Record<Priority, string> = {
  none: "None",
  trivial: "Trivial",
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};

/** What a priority is CALLED on this install. Reads the setting, which starts
 *  as a copy of the shipped names and can be renamed per level.
 *
 *  Every place that shows a rung to a person goes through here. Reading
 *  DEFAULT_PRIORITY_LABELS directly would show the shipped name and quietly
 *  ignore the rename, which is the bug this function exists to prevent. */
export function priorityLabel(level: Priority): string {
  return kbSettings.priorityLabels[level] || DEFAULT_PRIORITY_LABELS[level];
}

/** The same, for Effort. */
export function effortLabel(level: Effort): string {
  return kbSettings.effortLabels[level] || DEFAULT_EFFORT_LABELS[level];
}

/** Green through red, skipping "none", which is the absence of a priority and
 *  so has no color: a card with no priority set must not be painted gray as if
 *  gray were a priority. */
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

/* -----------------------------------------------------------------------------
   EFFORT
   -----------------------------------------------------------------------------
   How HEAVY a card is, which is a different question from how urgent it is.
   Kept as its own scale rather than folded into Priority because the two
   disagree constantly: the most urgent thing on a board is often the smallest,
   and the biggest is often the one nobody has scheduled. A board that can only
   say "critical" cannot tell those apart.

   FIVE RUNGS PLUS "none", mirroring Priority exactly, so a card with no
   estimate reads as unset rather than as the middle. Both the LABELS and the
   COLORS are settable, unlike Priority's rungs, which were fixed because the
   ramp is the meaning. Effort's names are genuinely a house style: a team that
   says "points" and a team that says "t-shirts" mean the same five things.
----------------------------------------------------------------------------- */

export type Effort = "none" | "tiny" | "small" | "medium" | "large" | "huge";

/** Lightest to heaviest, and the order the picker offers them in. */
export const EFFORTS: readonly Effort[] = ["none", "tiny", "small", "medium", "large", "huge"];

export const DEFAULT_EFFORT_LABELS: Record<Effort, string> = {
  none: "None",
  tiny: "Tiny",
  small: "Small",
  medium: "Medium",
  large: "Large",
  huge: "Huge",
};

/** A single hue getting darker rather than Priority's green-to-red ramp. Effort
 *  is not a warning, and painting a big card red would read as an alarm next to
 *  a board whose reds already mean "urgent". */
export const DEFAULT_EFFORT_COLORS: Record<Effort, string> = {
  none: "#6b7280",
  tiny: "#9db8d8",
  small: "#6f97c9",
  medium: "#4a76b8",
  large: "#33569a",
  huge: "#233a72",
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
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif", "ico"]);
const VIDEO_EXTS = new Set(["mp4", "webm", "ogv", "m4v", "mov"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "oga", "m4a", "flac", "aac", "opus"]);

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
   *  and (with the preference on) a drop here stamps the Complete date. */
  isDone: boolean;
  collapsed: boolean;
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
export type NewCardPosition = "top" | "bottom";

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
  /** Skip the reading face and open every card ready to type in.
   *
   *  Per board because it tracks how a board is USED: a board you are actively
   *  building wants the fields, and one you mostly consult wants the reading
   *  face and the protection from a stray keystroke that comes with it. */
  openCardsInEditMode: boolean;
}

/** Everything in BoardScopedSettings is a DEFAULT that a board may override.
 *  The five added here are tool-wide and cannot be overridden. */
export interface KbSettings extends BoardScopedSettings {
  overdueWarn: boolean;
  /** Comma-separated column titles a brand-new board starts with. */
  defaultColumns: string;
  /** Prefilled into the New Board form. Empty means no suggestion. */
  defaultBoardName: string;
  /** One color per priority level. Global rather than per board: a level has
   *  to look the same everywhere or it stops being a shared scale. */
  priorityColors: Record<Priority, string>;
  /** Renamed rungs. Starts as a copy of the shipped names. */
  priorityLabels: Record<Priority, string>;
  effortColors: Record<Effort, string>;
  effortLabels: Record<Effort, string>;
}

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
const MAX_CARDS_PER_BOARD = 5000;
const MAX_COLUMNS_PER_BOARD = 24;
const MAX_SUBTASKS_PER_CARD = 100;

const MAX_TITLE_LEN = 200;
const MAX_DESC_LEN = 8000;

/** Ceilings on the two things a card can now accumulate without bound. A
 *  comment thread and an attachment list are both rendered in full inside one
 *  modal, so these are the same kind of limit MAX_SUBTASKS_PER_CARD is: what
 *  keeps the card openable, not a ration. */
const MAX_COMMENT_LEN = 8000;
const MAX_COMMENTS_PER_CARD = 250;
const MAX_ATTACHMENTS = 50;
/** Kept in step with MAX_ATTACHMENT_BYTES in kanban.rs, which is the one that
 *  actually enforces it. This copy exists so a paste can be refused before it
 *  is encoded rather than after. */
const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;

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
  // What the card IS and what came with it, then when it is wanted, then what
  // has happened to it. Anything can be dragged anywhere; this is only the
  // start.
  sectionOrder: ["description", "attachments", "due", "stages"],
  // Off, so a card opens as something to read. Editing is a thing you ask for.
  openCardsInEditMode: false,
  overdueWarn: true,
  defaultColumns: SYSTEM_DEFAULT_COLUMNS,
  defaultBoardName: "",
  priorityColors: { ...DEFAULT_PRIORITY_COLORS },
  priorityLabels: { ...DEFAULT_PRIORITY_LABELS },
  effortColors: { ...DEFAULT_EFFORT_COLORS },
  effortLabels: { ...DEFAULT_EFFORT_LABELS },
};

/* =============================================================================
   STATE
============================================================================= */

let boards: Board[] = [];
/** Every card of every board, flat. One array, because every question worth
 *  asking spans columns and boards; see the note at the top of the file.
 *
 *  This used to carry an exception for locked boards, whose contents were not
 *  in memory. Board encryption is gone (see LOADING), so there is no longer a
 *  board whose cards are absent, and code that still assumed one would be
 *  guarding against a state that cannot happen. */
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
let initialized = false;

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

   Three steps: the preferences file, the index, then one file per board. There
   used to be five, and two of them were about deciding which boards were
   ciphertext and which could be opened. Nothing here encrypts any more, so
   every board is simply read.
----------------------------------------------------------------------------- */

async function loadAll(): Promise<void> {
  try {
    // Where the attachment files live. Asked for once, because every card that
    // shows a picture needs it and only the back end knows the answer.
    attachmentsRoot = await invoke<string>("kanban_attachments_dir");
    backgroundsRoot = await invoke<string>("kanban_backgrounds_dir");
    await loadSettings();
    await loadRecords();
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
  renderAll();
}

async function loadSettings(): Promise<void> {
  const raw = await invoke<string>("load_tool_file", { toolId: "kanban", kind: "settings" });
  kbSettings = normalizeSettings((JSON.parse(raw) ?? {}) as Partial<KbSettings>);
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
  const raw = await invoke<string>("load_kanban_index");
  const parsed = (JSON.parse(raw) ?? {}) as Partial<KanbanIndex>;

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
  const raw = await invoke<string>("load_kanban_board", { boardId: board.id });
  const parsed = JSON.parse(raw) as Partial<BoardContents> | null;
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

/** Marks the board a card belongs to. The one place card writes are queued
 *  from, called by stampCard(), which every card mutation already went
 *  through. */
function markCard(cardId: string): void {
  const card = getCard(cardId);
  if (card) dirtyBoards.add(card.boardId);
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
    if (wantSettings) {
      await invoke("save_tool_file", {
        toolId: "kanban",
        kind: "settings",
        data: JSON.stringify(kbSettings),
      });
    }
    /* The index goes FIRST. Every write snapshots what it is replacing, and a
       board's contents and the index entry naming it are only meaningful as a
       pair; a snapshot holding cards for a board the index has never heard of
       restores nothing you can reach. */
    if (wantIndex) {
      await invoke("save_kanban_index", { data: JSON.stringify(buildIndex()) });
    }
    for (const id of boardIds) {
      const board = getBoard(id);
      if (!board) continue;
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

/** Writes a queued edit NOW rather than letting it wait. Called before anything
 *  that replaces state wholesale (a snapshot restore) or that takes the
 *  so nothing is left sitting in the debounce while the state it describes is
 *  replaced underneath it. */
async function flushSave(): Promise<void> {
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
    openCardsInEditMode: bool(raw.openCardsInEditMode, base.openCardsInEditMode),
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
function normalizeEffort(raw: unknown): Effort {
  return EFFORTS.includes(raw as Effort) ? (raw as Effort) : "none";
}

function normalizePriorityColors(raw: unknown): Record<Priority, string> {
  const src = (raw ?? {}) as Partial<Record<Priority, string>>;
  const out = {} as Record<Priority, string>;
  for (const level of PRIORITIES) {
    out[level] = normalizeColor(src[level], DEFAULT_PRIORITY_COLORS[level]);
  }
  return out;
}

/** A renamed rung, or the shipped name when the rename is missing, blank or not
 *  a string. Trimmed and capped, because these are drawn in a chip on a card
 *  and a 400-character "priority" would push the rest of the card off screen. */
function normalizeLevelLabels<K extends string>(
  raw: unknown,
  keys: readonly K[],
  fallback: Record<K, string>,
): Record<K, string> {
  const src = (raw ?? {}) as Partial<Record<K, string>>;
  const out = {} as Record<K, string>;
  for (const key of keys) {
    const value = src[key];
    const trimmed = typeof value === "string" ? value.trim().slice(0, 24) : "";
    out[key] = trimmed || fallback[key];
  }
  return out;
}

function normalizeEffortColors(raw: unknown): Record<Effort, string> {
  const src = (raw ?? {}) as Partial<Record<Effort, string>>;
  const out = {} as Record<Effort, string>;
  for (const level of EFFORTS) {
    out[level] = normalizeColor(src[level], DEFAULT_EFFORT_COLORS[level]);
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
    priorityLabels: normalizeLevelLabels(raw.priorityLabels, PRIORITIES, DEFAULT_PRIORITY_LABELS),
    effortColors: normalizeEffortColors(raw.effortColors),
    effortLabels: normalizeLevelLabels(raw.effortLabels, EFFORTS, DEFAULT_EFFORT_LABELS),
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
    // than an artefact of a hand-edited file.
    updatedAt:
      typeof c.updatedAt === "number" && c.updatedAt >= created ? c.updatedAt : created,
    createdBy: normalizeAuthor(c.createdBy),
  };
}

/** A date field is kept only if it is a real YYYY-MM-DD. Anything else becomes
 *  null rather than being carried through, because every duration in the tool
 *  is subtracted from these and a half-valid date would produce a number that
 *  looks real and is not. */
function normalizeDay(raw: unknown): string | null {
  return typeof raw === "string" && parseDay(raw) !== null ? raw : null;
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
      due: normalizeDay(d.due),
      started: normalizeDay(d.started),
      testing: normalizeDay(d.testing),
      completed: normalizeDay(d.completed),
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
 *  no colored tag, has nothing to say, and a gray card would be saying
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
    openCardsInEditMode: kbSettings.openCardsInEditMode,
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
function topOpenKanbanModal(): Modal | null {
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

/** Entering a board from the gallery. */
function openBoardFromGallery(boardId: string): void {
  const board = getBoard(boardId);
  if (!board) return;
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
  boardBgLayer.style.backgroundImage = `url("${backgroundSrc(bg)}")`;
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

  /* Quiet, and on the card face rather than only in the log. A card an agent
     put there looks exactly like one you wrote otherwise, and "where did this
     come from" is a question worth answering at a glance. */
  if (card.createdBy?.kind === "agent") {
    const mark = document.createElement("span");
    mark.className = "kb-card-agent";
    mark.textContent = "AI";
    mark.title = `Created by ${card.createdBy.label}`;
    top.appendChild(mark);
  }

  if (card.priority !== "none") {
    const chip = document.createElement("span");
    chip.className = "kb-card-priority";
    chip.textContent = priorityLabel(card.priority);
    chip.title = `Priority: ${priorityLabel(card.priority)}`;
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
  // The description as a hover summary, with its formatting characters taken
  // off: the point of the card face is not having to open the card to remember
  // what it was, and a tooltip full of asterisks and brackets does not help.
  if (card.description.trim()) {
    const summary = richTextToPlain(card.description);
    title.title = summary.length > 300 ? `${summary.slice(0, 300)}…` : summary;
  }
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

    /* CLICKING THE COUNT OPENS WHAT IT COUNTS.
       The number already says there are subtasks; the click says show me them.
       stopPropagation because the whole card is also a click target, and
       without it this would open the card on Basic and then be overruled. */
    const label = document.createElement("span");
    label.className = "kb-card-sub-count kb-card-count-link";
    label.textContent = `${done}/${card.subtasks.length}`;
    label.title = "Open this card's subtasks";
    label.addEventListener("click", (e) => {
      e.stopPropagation();
      openCard(card.id, "subtasks");
    });
    wrap.appendChild(label);

    el.appendChild(wrap);
  }

  /* How many files and how many comments the card is carrying. Shown whenever
     there are any, with no preference behind it: unlike tags or subtasks, these
     say nothing about the work itself, they say there is something inside this
     card you cannot see from here, which is the one thing a card face cannot
     afford to keep quiet about. */
  const attachmentCount = allAttachments(card).length;
  if (attachmentCount > 0 || card.comments.length > 0) {
    const meta = document.createElement("div");
    meta.className = "kb-card-meta";
    /* `tab` is what makes an item clickable. Attachments do not pass one,
       because they have no tab of their own: they are a block on Basic, which
       is where the card opens anyway. */
    const item = (svg: string, count: number, title: string, tab?: KbCardTab): void => {
      const span = document.createElement("span");
      span.className = tab ? "kb-card-meta-item kb-card-count-link" : "kb-card-meta-item";
      span.title = title;
      span.innerHTML = svg;
      const label = document.createElement("span");
      label.textContent = String(count);
      span.appendChild(label);
      if (tab) {
        span.addEventListener("click", (e) => {
          e.stopPropagation();
          openCard(card.id, tab);
        });
      }
      meta.appendChild(span);
    };
    if (attachmentCount > 0) {
      item(
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
          'stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />' +
          "</svg>",
        attachmentCount,
        `${attachmentCount} attached file(s)`,
      );
    }
    if (card.comments.length > 0) {
      item(
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
          'stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />' +
          "</svg>",
        card.comments.length,
        "Open this card's comments",
        "comments",
      );
    }
    el.appendChild(meta);
  }

  el.addEventListener("click", () => openCard(card.id));
  attachMenu(el, () => boardCardMenu(card));
  attachCardDragHandlers(board, el, card);
  return el;
}

/**
 * Whose card this is, as a submenu.
 *
 * The AGENT choices are the connections this board actually has, read off the
 * agent config rather than typed in, so an owner is a real agent by id and not
 * a name that happens to match one. An agent's cards therefore stay its own
 * when its connection secret is regenerated, which is the whole reason the id
 * and the secret are separate things.
 *
 * The config is read fresh each time the menu opens, because a connection added
 * or revoked while the card was open should be reflected the next time you
 * look, and this menu is opened rarely enough that the read costs nothing.
 */
function cardOwnerMenu(card: Card): MenuItem[] {
  const items: MenuItem[] = [
    {
      label: "You",
      onClick: () => setCardOwner(card, undefined),
    },
  ];

  for (const token of agentConnectionsForBoard(card.boardId)) {
    items.push({
      label: token.label,
      onClick: () => setCardOwner(card, { kind: "agent", by: token.id, label: token.label }),
    });
  }

  items.push({
    label: "External\u2026",
    onClick: () => {
      /* Free text, because the person it names is not a user of this app and
         there is no list to pick them from. Prompt rather than a modal of its
         own: it is one short string, and a modal would be a screen to say a
         name on. */
      const who = window.prompt("Who asked for this card?", currentExternalLabel(card));
      if (who === null) return;
      setCardOwner(card, { kind: "external", label: trimTo(who, 80) });
    },
  });

  return items;
}

/**
 * The agents this board has known, for the owner menu.
 *
 * TWO SOURCES, because neither alone is right:
 *
 *   the cards    every agent that has actually written here, which is the real
 *                answer to "historically connected" and is always in memory
 *   the config   the connections that exist RIGHT NOW, including one just added
 *                that has not written anything yet
 *
 * The config is only in memory once the Agents tab has been looked at, so it is
 * the addition rather than the base. Reading it first and finding null would
 * offer nothing on a board full of agent-written cards, which is the case this
 * menu most obviously has to handle.
 *
 * Deduplicated by id, and the label is whichever the config gives when it has
 * one, since a renamed connection should read under its new name.
 */
function agentConnectionsForBoard(boardId: string): AgentToken[] {
  const byId = new Map<string, AgentToken>();

  for (const card of cards) {
    if (card.boardId !== boardId) continue;
    const author = card.createdBy;
    if (author?.kind !== "agent") continue;
    if (!byId.has(author.by)) {
      byId.set(author.by, { id: author.by, label: author.label, token: "", createdAt: 0 });
    }
  }

  if (agentConfig) {
    for (const token of boardConfig(agentConfig, boardId).tokens) {
      byId.set(token.id, token);
    }
  }

  return [...byId.values()];
}

function currentExternalLabel(card: Card): string {
  return card.createdBy?.kind === "external" ? card.createdBy.label : "";
}

function setCardOwner(card: Card, owner: CardAuthor | undefined): void {
  // Undefined rather than { kind: "user" }: absent IS the user, and writing the
  // object would put a line in every board file to say the default.
  card.createdBy = owner;
  stampCard(card);
  flash(`Owner set to ${authorLabel(owner)}.`);
  renderCardModal();
  renderAll();
}

/** The card's right-click menu, as opened from its face on the board.
 *
 *  Deliberately NOT the same list as the three-dot menu inside the card
 *  modal. That one acts on a card you already have open, so it can close the
 *  modal afterwards and has no need to offer "Open". This one is the reverse:
 *  it is the shortcut past opening the card at all, which is why priority,
 *  column and board, the three fields most often changed on their own, are
 *  here as submenus but are plain form controls in the modal. */
function boardCardMenu(card: Card): MenuItem[] {
  const board = getBoard(card.boardId);

  const priorityItems: MenuItem[] = PRIORITIES.map((p) => ({
    label: priorityLabel(p),
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
      `This board is at its limit of ${MAX_CARDS_PER_BOARD.toLocaleString()} cards on the board at once. ` +
        "Archiving finished work frees room without deleting anything.",
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
let _agentPermModal: Modal | null = null;
let _cardColorModal: Modal | null = null;
let _columnEditModal: Modal | null = null;
let _cardModal: Modal | null = null;
let _cardStatsModal: Modal | null = null;
let _boardStatsModal: Modal | null = null;
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
  const columnSelect = document.getElementById("kbCardColumnSelect") as HTMLSelectElement;
  const boardSelect = document.getElementById("kbCardBoardSelect") as HTMLSelectElement;
  const dueInput = document.getElementById("kbCardDueInput") as HTMLInputElement;
  const subtaskInput = document.getElementById("kbCardSubtaskInput") as HTMLInputElement;
  const colorCustom = document.getElementById("kbCardColorCustom") as HTMLInputElement;

  _cardModal = new Modal(backdrop, {
    /* HANDING THE TABS OVER IS WHAT MAKES A DEEP LINK WORK.
       openCard() calls tabs.select() to choose where a card lands, which only
       records the choice; the Modal is what re-activates it on open. Without
       this the choice was made and never acted on, so clicking a card's comment
       count opened the card on Basic every time. */
    tabs: getCardTabs(),
    closeOnEsc: true,
    onClosed: () => {
      openCardId = null;
      closeMenu();
      /* A comment being written is thrown away only when the card is really
         being left. A handoff (the picture viewer, a confirm) has already
         opened its replacement by the time this runs, so an open Kanban modal
         here means the card is coming back and the half-written comment is
         still wanted. */
      if (!topOpenKanbanModal()) {
        discardPendingComment();
        // Same rule for the description: a card really left comes back showing
        // whichever face its text calls for, rather than the one it happened to
        // be on when it was closed.
        descFieldCardId = null;
        descFieldMode = null;
      }
      // The players in the card go quiet and give their buffers back here
      // rather than whenever the collector next runs.
      releaseMedia(backdrop);
      // The board behind was not being kept in step while the modal was open;
      // this is where it catches up in one pass.
      renderAll();
    },
  });

  const withCard = (fn: (card: Card) => void) => () => {
    const card = getCard(openCardId);
    if (card) fn(card);
  };

  document.getElementById("kbCardEditBtn")!.addEventListener("click", () => {
    setCardEditing(true);
  });
  document.getElementById("kbCardSaveBtn")!.addEventListener("click", () => saveCardEdit());
  document.getElementById("kbCardCancelBtn")!.addEventListener("click", () => cancelCardEdit());

  titleInput.addEventListener("input", () => {
    const card = getCard(openCardId);
    if (!card) return;
    card.title = titleInput.value.slice(0, MAX_TITLE_LEN);
    stampCard(card);
    renderCardHeader(card);
  });

  /* THE BOARD KEEPS UP.
     -------------------------------------------------------------------------
     The card behind the modal used to sit unchanged until the modal closed, so
     renaming a card or changing its priority looked like it had done nothing
     until you dismissed the thing you did it in. Committing a field now redraws
     the board, which is visible around the modal for every card that is not
     directly behind it.

     On CHANGE rather than on input: redrawing the whole board on every
     keystroke of a title is work nobody asked for, and the blur that ends the
     typing is the moment the value is actually settled. */
  titleInput.addEventListener("change", () => {
    renderAll();
    const card = getCard(openCardId);
    if (card) renderCardReadonlyValues(card);
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
    renderCardReadonlyValues(card);
    renderAll();
  });

  const effortSelect = document.getElementById("kbCardEffortSelect") as HTMLSelectElement;
  effortSelect.addEventListener("change", () => {
    const card = getCard(openCardId);
    if (!card) return;
    card.effort = normalizeEffort(effortSelect.value);
    stampCard(card);
    renderCardReadonlyValues(card);
    renderAll();
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

  document.getElementById("kbCardAttachAddBtn")!.addEventListener("click", () => {
    void (async () => {
      const card = getCard(openCardId);
      if (!card) return;
      const boardId = card.boardId;
      const added = await pickAttachments(boardId, card.attachments.length);
      if (added.length === 0) return;
      // Re-read the card: the picker is a native dialog, and the card modal can
      // have been closed and another card opened while it was up.
      const still = getCard(card.id);
      if (!still) {
        forgetAttachmentFiles(boardId, added);
        return;
      }
      still.attachments.push(...added);
      stampCard(still);
      if (openCardId === still.id) renderCardAttachments(still);
    })();
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
      { label: "Owner", submenu: cardOwnerMenu(card) },
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
 *  confirmation preference cannot end up honored in one place and not the
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

/* -----------------------------------------------------------------------------
   READING A CARD VERSUS EDITING ONE
   -----------------------------------------------------------------------------
   A card opens as something to READ. The fields are there, but drawn as values
   rather than as controls, and the pencil in the header switches them over.

   WHY. Most opens are a look, not a change, and a modal made entirely of live
   inputs has no safe state: a stray keystroke in a select is a silent edit to
   real work, and there is no undo for "I did not mean to touch that". A board
   that IS being built can say so once, with the per-board preference, instead
   of every card paying for it.

   WHAT STAYS LIVE EITHER WAY: the three-dot menu, subtasks, and comments.
   Ticking a subtask off and writing a comment are records of what happened
   rather than edits to what the card is, and gating them behind a pencil would
   make the common case the awkward one.
----------------------------------------------------------------------------- */

type KbCardTab = "basic" | "subtasks" | "comments";

let cardEditing = false;

/** The card as it was when editing began, for Cancel to put back. A structured
 *  clone rather than a shallow copy: subtasks, tags and dates are all nested,
 *  and a shallow copy would have Cancel restoring the same arrays it just
 *  edited. */
let cardEditSnapshot: Card | null = null;

let _cardTabs: ModalTabs<KbCardTab> | null = null;

function getCardTabs(): ModalTabs<KbCardTab> {
  if (!_cardTabs) {
    _cardTabs = new ModalTabs<KbCardTab>({
      scope: "#kbCardModal",
      key: "kbCardTab",
      panes: {
        basic: "kbCardTabBasic",
        subtasks: "kbCardTabSubtasks",
        comments: "kbCardTabComments",
      },
    });
  }
  return _cardTabs;
}

/**
 * Puts the modal into reading or editing shape.
 *
 * One attribute on the modal drives it, and CSS decides what that means for
 * each control, rather than a list here toggling twenty elements by hand. The
 * list would be the thing that fell out of date the next time a field was
 * added, and the field it forgot would be the one still editable while the card
 * claimed to be read-only.
 */
function setCardEditing(on: boolean): void {
  cardEditing = on;
  const modal = document.getElementById("kbCardModal")!;
  modal.dataset.kbEditing = on ? "true" : "false";

  const card = getCard(openCardId);
  // Snapshotted on the way IN only, so re-rendering mid-edit cannot overwrite
  // the thing Cancel is supposed to go back to.
  if (on && card && !cardEditSnapshot) cardEditSnapshot = structuredClone(card);
  if (!on) cardEditSnapshot = null;

  if (card) renderCardModal();
}

/** Leaves edit mode, keeping the changes. Everything was already written as it
 *  was typed, so this only has to put the board in step and change face. */
function saveCardEdit(): void {
  setCardEditing(false);
  void flushSave();
  renderAll();
}

/** Leaves edit mode, putting back what was there when it started. */
function cancelCardEdit(): void {
  const card = getCard(openCardId);
  if (card && cardEditSnapshot) {
    // Restored IN PLACE. Everything else in the tool holds this same object,
    // so replacing it in the array would leave the board drawing the old one.
    Object.assign(card, structuredClone(cardEditSnapshot));
    stampCard(card);
  }
  setCardEditing(false);
  void flushSave();
  renderAll();
}

function openCard(cardId: string, tab?: KbCardTab): void {
  const card = getCard(cardId);
  if (!card) return;
  // An inline comment editor belongs to the card it was opened on. Clearing it
  // here rather than on close covers the reopen paths too (a confirm dismissed,
  // the picture viewer's back arrow).
  editingCommentId = null;
  // A composer left holding a different card's words goes now, files included.
  if (pendingCommentCardId && pendingCommentCardId !== cardId) discardPendingComment();
  openCardId = cardId;
  // The composer is built on demand, so the first card opened is not paying for
  // a control it may never use.
  getCommentField();

  /* A card opened by clicking its comment count belongs on Comments, and one
     opened by clicking its subtask progress belongs on Subtasks. Anything else
     starts on Basic rather than wherever the last card was left, because the
     tab you wanted last time says nothing about this card. */
  getCardTabs().select(tab ?? "basic");

  // Straight into the fields when the board asks for it, and the snapshot is
  // taken here so Cancel works on a card that opened already editing.
  // setCardEditing renders, so there is no second render here.
  cardEditSnapshot = null;
  setCardEditing(effectiveForCard(card).openCardsInEditMode);

  getCardModal().open();
  // Asked once per open, in the background: a file can vanish between sessions
  // and the card should say so rather than showing a broken picture.
  void refreshAttachmentPresence(card);
}

function renderCardModal(): void {
  const card = getCard(openCardId);
  if (!card) return;
  const settings = effectiveForCard(card);

  renderCardHeader(card);
  (document.getElementById("kbCardTitleInput") as HTMLInputElement).value = card.title;
  document.getElementById("kbCardTitleDisplay")!.textContent = card.title || "Untitled card";
  renderCardReadonlyValues(card);
  renderCardTabCounts(card);
  renderCardDescription(card);
  renderCardAttachments(card);
  renderCardComments(card);
  renderPendingCommentAttachments();
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

/**
 * The reading face of the four top fields.
 *
 * Drawn every render rather than only outside edit mode: the values are cheap,
 * and a face rendered only when shown is a face that is stale the instant the
 * pencil is pressed.
 *
 * The two SCALE fields carry their level's color, because that color is the
 * whole reason the level is settable. The two PLACEMENT fields do not: a column
 * is not a rung and painting it would invent a meaning.
 */
function renderCardReadonlyValues(card: Card): void {
  const board = getBoard(card.boardId);
  const column = board ? getColumn(board, card.columnId) : null;

  const set = (id: string, text: string, color?: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.style.color = color ?? "";
  };

  set("kbCardColumnDisplay", column?.title ?? "Unknown column");
  set("kbCardBoardDisplay", board?.name ?? "Unknown board");
  set(
    "kbCardPriorityDisplay",
    priorityLabel(card.priority),
    card.priority === "none" ? undefined : kbSettings.priorityColors[card.priority],
  );
  set(
    "kbCardEffortDisplay",
    effortLabel(card.effort),
    card.effort === "none" ? undefined : kbSettings.effortColors[card.effort],
  );
}

/** The counts on the Subtasks and Comments tabs, so a tab says whether it is
 *  worth opening without being opened. Empty rather than "0": a zero badge is
 *  noise on the majority of cards that have neither. */
function renderCardTabCounts(card: Card): void {
  const subtasks = document.getElementById("kbCardSubtaskTabCount");
  if (subtasks) {
    const done = card.subtasks.filter((t) => t.done).length;
    subtasks.textContent = card.subtasks.length ? `${done}/${card.subtasks.length}` : "";
  }
  const comments = document.getElementById("kbCardCommentTabCount");
  if (comments) comments.textContent = card.comments.length ? String(card.comments.length) : "";
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
    option.textContent = priorityLabel(level);
    prioritySelect.appendChild(option);
  }
  prioritySelect.value = card.priority;

  const effortSelect = document.getElementById("kbCardEffortSelect") as HTMLSelectElement;
  effortSelect.replaceChildren();
  for (const level of EFFORTS) {
    const option = document.createElement("option");
    option.value = level;
    option.textContent = effortLabel(level);
    effortSelect.appendChild(option);
  }
  effortSelect.value = card.effort;
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
   ATTACHMENTS
   -----------------------------------------------------------------------------
   An attachment is a COPY the tool owns (see the Attachment type). Everything
   here keeps three things in step: the record on the card, the file in that
   board's folder, and what is on screen.

   THE FILE'S LIFETIME IS THE RECORD'S. Remove the attachment, delete the
   comment, delete the card, delete the board: the copy goes in that same
   action. That is maintained by the paths below, but it is GUARANTEED by
   something else: the file is named by the attachment id inside a folder named
   by the board id, so anything in a board's folder that no card mentions is
   provably garbage. sweepBoardAttachments() collects it after every board load,
   which is what makes the rule survive a crash, a snapshot restore, or a
   hand-edited board file.

   These files are ordinary files. They reach the screen through the same asset
   protocol the board backgrounds use, and open in another program through one
   command scoped to this folder.
----------------------------------------------------------------------------- */

/** Every attachment on a card, its comments included. The one place that
 *  question is answered, so a delete path cannot forget the comments' files. */
function allAttachments(card: Card): Attachment[] {
  return [...card.attachments, ...card.comments.flatMap((c) => c.attachments)];
}

/** "<boardId>/<attachmentId>" for attachments the last check said are not on
 *  disk. Held so a card with a missing file draws it as missing on every render
 *  rather than only on the render that discovered it. */
const missingAttachments = new Set<string>();

function attachmentKey(boardId: string, attachment: Attachment): string {
  return `${boardId}/${attachment.id}`;
}

/** The URL the WebView loads an attachment from. The same asset protocol the
 *  board backgrounds use: these are ordinary files on disk. */
function attachmentUrl(boardId: string, attachment: Attachment): string {
  return convertFileSrc(attachmentPath(boardId, attachment));
}

/** Where the file actually is. Derived, never stored; see the Attachment type. */
function attachmentPath(boardId: string, attachment: Attachment): string {
  return `${attachmentsRoot}/${boardId}/${attachment.file ?? attachment.id}`;
}

/** The absolute path of kanban-attachments/, learned once from the back end.
 *  Needed because the asset protocol takes a real path, and only the back end
 *  knows where the data directory is. */
let attachmentsRoot = "";

/** The same, for kanban-backgrounds/. */
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

/** Unlinks the copies behind these records, best effort.
 *
 *  Deliberately fire-and-forget. The card edit that triggered it has already
 *  happened in memory and is about to be written; a file that will not delete
 *  (open in a viewer, say) is not a reason to fail that or to nag about it. */
function forgetAttachmentFiles(boardId: string, list: Attachment[]): void {
  for (const attachment of list) {
    missingAttachments.delete(attachmentKey(boardId, attachment));
    void invoke("delete_kanban_attachment", {
      boardId,
      attachmentId: attachment.id,
    }).catch(() => {});
  }
}

/**
 * Deletes anything in a board's folder that no card on it mentions.
 *
 * This is the guarantee behind "delete the thing and the file goes". Every
 * other path unlinks the file at the moment it drops the record, but a crash
 * between the two, a snapshot restored from before the file existed, or a
 * hand-edited board file leaves an orphan, and an orphan is unreachable by
 * definition. Run after a board's contents are in memory, which is the only
 * moment the full list of ids it should own actually exists.
 */
function sweepBoardAttachments(boardId: string): void {
  if (!getBoard(boardId)) return;
  const keep = cards
    .filter((c) => c.boardId === boardId)
    .flatMap((c) => allAttachments(c).map((a) => a.id));
  void invoke<number>("sweep_kanban_attachments", { boardId, keep })
    .then((removed) => {
      if (removed > 0) devError(`[kanban] swept ${removed} unreferenced attachment(s)`);
    })
    .catch((err) => devError("[kanban] attachment sweep failed", err));
}

/** Asks which files are actually still there, in one round trip, and redraws if
 *  the answer changed anything. Called when a card is opened: a file can go
 *  missing between sessions and the card should say so rather than showing a
 *  broken picture. */
async function refreshAttachmentPresence(card: Card): Promise<void> {
  const list = allAttachments(card);
  if (list.length === 0) return;
  const boardId = card.boardId;
  try {
    const present = await invoke<boolean[]>("kanban_attachments_exist", {
      boardId,
      attachmentIds: list.map((a) => a.id),
    });
    let changed = false;
    list.forEach((attachment, i) => {
      const key = attachmentKey(boardId, attachment);
      const missing = present[i] === false;
      if (missing === missingAttachments.has(key)) return;
      changed = true;
      if (missing) missingAttachments.add(key);
      else missingAttachments.delete(key);
    });
    // Only if this is still the card on screen: the answer can arrive after the
    // user has moved on, and redrawing then would draw the wrong card.
    if (changed && openCardId === card.id) {
      renderCardAttachments(card);
      renderCardComments(card);
    }
  } catch {
    // A failed check means "no news", not "everything is missing".
  }
}

/**
 * Gives a duplicated card its own copies of the original's files.
 *
 * Runs after the duplicate is already on the board, on purpose: the copy is
 * usable immediately, and each attachment gets its own file as that copy lands.
 * A copy that fails leaves the record pointing at nothing, which the presence
 * check then reports as missing; that is the honest outcome and it is far
 * better than two cards sharing one file, where removing the attachment from
 * either would silently break the other.
 */
async function cloneAttachments(original: Card, copy: Card): Promise<void> {
  if (copy.attachments.length === 0) return;
  for (let i = 0; i < copy.attachments.length; i++) {
    try {
      // The copy has its own id, so it has its own filename. Recorded on the
      // duplicate rather than left to be guessed at.
      copy.attachments[i].file = await invoke<string>("copy_kanban_attachment", {
        fromBoardId: original.boardId,
        toBoardId: copy.boardId,
        fromAttachmentId: original.attachments[i].id,
        toAttachmentId: copy.attachments[i].id,
      });
    } catch (err) {
      devError("[kanban] attachment copy failed", err);
    }
  }
  stampCard(copy);
  if (openCardId === copy.id) renderCardAttachments(copy);
}

/**
 * Moves a card's files into another board's folder.
 *
 * A cross-board move is the one thing the derive-the-path design costs, and it
 * is worth the price: the file has to physically follow the card. Handled in
 * Rust, one call per file.
 */
async function moveAttachmentsToBoard(
  card: Card,
  fromBoardId: string,
  toBoardId: string,
): Promise<void> {
  const list = allAttachments(card);
  if (list.length === 0 || fromBoardId === toBoardId) return;
  for (const attachment of list) {
    try {
      attachment.file = await invoke<string>("copy_kanban_attachment", {
        fromBoardId,
        toBoardId,
        fromAttachmentId: attachment.id,
        // Same id on the other side: it is unique per board by construction and
        // keeping it means the card's records need no rewriting.
        toAttachmentId: attachment.id,
      });
      await invoke("delete_kanban_attachment", {
        boardId: fromBoardId,
        attachmentId: attachment.id,
      });
    } catch (err) {
      flash(`Couldn't move an attached file: ${String(err)}`, "error", 8000);
      devError("[kanban] attachment move failed", err);
    }
  }
  if (openCardId === card.id) {
    renderCardAttachments(card);
    renderCardComments(card);
  }
}

/**
 * Runs the file picker and copies what was chosen into the board's folder.
 * Returns the records to append; the caller decides where they go and saves.
 *
 * `have` is how many the target already holds, so the ceiling is enforced
 * before anything is copied rather than after.
 */
async function pickAttachments(boardId: string, have: number): Promise<Attachment[]> {
  if (have >= MAX_ATTACHMENTS) {
    flash(`That already holds the maximum of ${MAX_ATTACHMENTS} files.`, "error");
    return [];
  }
  const picked = await openDialog({ multiple: true, directory: false });
  const paths = Array.isArray(picked) ? picked : typeof picked === "string" ? [picked] : [];
  if (paths.length === 0) return [];

  const room = MAX_ATTACHMENTS - have;
  if (paths.length > room) {
    flash(`Only ${room} more file(s) fit here; the rest were skipped.`, "error", 6000);
  }

  const out: Attachment[] = [];
  for (const path of paths.slice(0, room)) {
    // The id is minted HERE, before the copy, because it is the filename the
    // copy will be written under.
    const id = newId();
    try {
      const stored = await invoke<{ id: string; name: string; size: number; file: string }>(
        "import_kanban_attachment",
        { boardId, attachmentId: id, path },
      );
      out.push({
        id: stored.id,
        name: stored.name,
        size: stored.size,
        file: stored.file,
        addedAt: Date.now(),
      });
    } catch (err) {
      flash(String(err), "error", 8000);
    }
  }
  return out;
}

/**
 * Stores an image that arrived on the clipboard.
 *
 * The bytes go over as base64 rather than as a byte array: an array serializes
 * as JSON numbers, which is several bytes on the wire per byte of image, and a
 * screenshot is small enough that base64's 33% is the cheaper of the two.
 */
async function attachPastedImage(
  boardId: string,
  blob: Blob,
  have: number,
): Promise<Attachment | null> {
  if (have >= MAX_ATTACHMENTS) {
    flash(`That already holds the maximum of ${MAX_ATTACHMENTS} files.`, "error");
    return null;
  }
  // Refused before the blob is turned into a string, which is where a large
  // paste would cost the most: the base64 form is a third larger again, and
  // both live at once while it is being built.
  if (blob.size > MAX_ATTACHMENT_BYTES) {
    flash(
      `That image is ${(blob.size / (1024 * 1024)).toFixed(1)} MB. The limit for one attachment is ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB.`,
      "error",
      8000,
    );
    return null;
  }
  try {
    const buffer = new Uint8Array(await blob.arrayBuffer());
    // Chunked rather than spread into one apply() call: a few megabytes of
    // image is more arguments than the stack will take at once.
    let binary = "";
    const STEP = 0x8000;
    for (let i = 0; i < buffer.length; i += STEP) {
      binary += String.fromCharCode(...buffer.subarray(i, i + STEP));
    }

    const ext = (blob.type.split("/")[1] || "png").replace(/[^a-z0-9]/gi, "").slice(0, 8);
    const stamp = new Date().toLocaleString("sv-SE").replace(/[: ]/g, "-");
    const id = newId();
    const stored = await invoke<{ id: string; name: string; size: number; file: string }>(
      "paste_kanban_attachment",
      {
        boardId,
        attachmentId: id,
        // A pasted image has no filename of its own, so it is given one that
        // says where it came from and when.
        name: `pasted-${stamp}.${ext || "png"}`,
        dataBase64: btoa(binary),
      },
    );
    return {
      id: stored.id,
      name: stored.name,
      size: stored.size,
      file: stored.file,
      addedAt: Date.now(),
    };
  } catch (err) {
    flash(String(err), "error", 8000);
    return null;
  }
}

/** Hands a file to whatever program owns its type. */
function openAttachment(boardId: string, attachment: Attachment): void {
  void invoke("open_kanban_attachment", {
    boardId,
    attachmentId: attachment.id,
    name: attachment.name,
  }).catch((err) => flash(String(err), "error", 8000));
}

/**
 * Releases the media elements inside a container before it is emptied.
 *
 * A <video> that is removed from the DOM while still holding a source keeps its
 * decoder and its buffered data alive until the collector gets to it, and this
 * container is rebuilt on every keystroke-driven re-render. Pausing and
 * clearing the source first is what makes closing a card with three videos in
 * it give the memory back at that moment rather than eventually.
 */
function releaseMedia(host: HTMLElement): void {
  for (const el of host.querySelectorAll<HTMLMediaElement>("video, audio")) {
    el.pause();
    el.removeAttribute("src");
    // Required as well as removing the attribute: without the reload the
    // element keeps the old resource open.
    el.load();
  }
}

/** Empties a container that may be holding media, without leaking the decoders.
 *  Every attachment list is redrawn through this rather than through a bare
 *  replaceChildren. */
function clearMediaHost(host: HTMLElement): void {
  releaseMedia(host);
  host.replaceChildren();
}

interface AttachmentListOptions {
  /** Which board's folder these live in. */
  boardId: string;
  /** Called after the record has been taken out of its list, to save and redraw.
   *  The file itself is unlinked here. */
  onRemove: (attachment: Attachment) => void;
}

/**
 * Draws one list of attachments into `host`.
 *
 * Three shapes, chosen by extension and never by a stored field: a picture is
 * shown, a video or a sound gets a player, and everything else is a row that
 * opens in whatever program owns it. A file that is no longer on disk keeps its
 * row and says so, because a card silently losing a line is worse than a card
 * telling you something went missing.
 */
function renderAttachmentList(
  host: HTMLElement,
  list: Attachment[],
  opts: AttachmentListOptions,
): void {
  clearMediaHost(host);

  for (const attachment of list) {
    const missing = missingAttachments.has(attachmentKey(opts.boardId, attachment));
    const kind = missing ? "file" : attachmentKind(attachment.name);
    const src = attachmentUrl(opts.boardId, attachment);

    const wrap = document.createElement("div");
    wrap.className = "rt-attach";
    if (missing) wrap.classList.add("rt-attach-missing");

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "rt-attach-remove";
    remove.title = `Remove ${attachment.name}`;
    remove.textContent = "×";
    remove.addEventListener("click", (e) => {
      e.stopPropagation();
      opts.onRemove(attachment);
    });

    const label = (): HTMLElement => {
      const name = document.createElement("button");
      name.type = "button";
      name.className = "rt-attach-name";
      name.textContent = missing ? `${attachment.name} (missing)` : attachment.name;
      name.title = missing ? "This file is no longer in the app's folder." : attachment.name;
      if (missing) name.disabled = true;
      else name.addEventListener("click", () => openAttachment(opts.boardId, attachment));
      return name;
    };
    const size = (): HTMLElement => {
      const el = document.createElement("span");
      el.className = "rt-attach-size";
      el.textContent = formatBytes(attachment.size);
      return el;
    };

    if (kind === "image") {
      const img = document.createElement("img");
      img.className = "rt-attach-img";
      img.src = src;
      img.alt = attachment.name;
      img.loading = "lazy";
      img.title = "Click to view full size";
      img.addEventListener("click", () => openAttachmentLightbox(opts.boardId, attachment));
      // A file deleted from outside the app between the presence check and this
      // render still has to read as missing rather than as a broken icon. So
      // does one on a board that has since been locked, which the handler
      // answers with a refusal rather than with bytes.
      img.addEventListener("error", () => {
        missingAttachments.add(attachmentKey(opts.boardId, attachment));
        wrap.classList.add("rt-attach-missing");
        img.remove();
      });
      wrap.appendChild(img);
    } else if (kind === "video") {
      const video = document.createElement("video");
      video.className = "rt-attach-media";
      video.src = src;
      video.controls = true;
      // Metadata only: a card with four videos on it should not start pulling
      // four files off disk, and decrypting them, the moment it is opened.
      video.preload = "metadata";
      wrap.appendChild(video);
    } else if (kind === "audio") {
      const audio = document.createElement("audio");
      audio.className = "rt-attach-audio";
      audio.src = src;
      audio.controls = true;
      audio.preload = "metadata";
      wrap.appendChild(audio);
    }

    const strip = document.createElement("div");
    strip.className = kind === "file" ? "rt-attach-row" : "rt-attach-caption";
    if (kind === "file") {
      const icon = document.createElement("span");
      icon.className = "rt-attach-icon";
      icon.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
        'stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M14 3v5h5" /><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z" />' +
        "</svg>";
      strip.appendChild(icon);
    }
    strip.appendChild(label());
    strip.appendChild(size());
    strip.appendChild(remove);
    wrap.appendChild(strip);

    host.appendChild(wrap);
  }
}

/* -----------------------------------------------------------------------------
   THE PICTURE VIEWER
   -----------------------------------------------------------------------------
   A card's images are drawn at whatever width the modal has, which is not
   enough to read a screenshot of an error message. This is the full-size view
   of one of them, and it REPLACES the card modal rather than stacking on it,
   like every other secondary modal in this tool; its back arrow says which card
   it goes back to.
----------------------------------------------------------------------------- */

let _lightboxModal: Modal | null = null;
/** The card to reopen when the viewer is dismissed. Named rather than
 *  remembered: there is exactly one route in, and it knows the answer. */
let lightboxReturnCardId: string | null = null;

function getLightboxModal(): Modal {
  if (_lightboxModal) return _lightboxModal;

  const backdrop = document.getElementById("kbLightboxBackdrop")!;
  const img = document.getElementById("kbLightboxImg") as HTMLImageElement;

  _lightboxModal = new Modal(backdrop, {
    closeOnEsc: true,
    onClosed: () => {
      // The source goes when the viewer does. A full-size image left in an
      // <img> that is merely hidden stays decoded in memory for as long as the
      // app runs.
      img.removeAttribute("src");
      lightboxAttachment = null;
      lightboxReturnCardId = null;
    },
  });

  // Back returns to the card; the X and Escape do not. Same split as Card
  // Stats and Card Color, and it is a real distinction rather than two names
  // for one action: the X means you are done looking at this card.
  document.getElementById("kbLightboxClose")!.addEventListener("click", () => {
    _lightboxModal!.close();
  });
  document.getElementById("kbLightboxBack")!.addEventListener("click", () => {
    const back = lightboxReturnCardId;
    _lightboxModal!.close({ handoff: true });
    if (back) openCard(back);
  });
  document.getElementById("kbLightboxOpenBtn")!.addEventListener("click", () => {
    if (lightboxAttachment) openAttachment(lightboxAttachment.boardId, lightboxAttachment.file);
  });

  return _lightboxModal;
}

/** Which picture the viewer is showing, so its Open button knows what to hand
 *  over. Held as the record rather than as a URL, because opening a file and
 *  displaying it are two different routes to it. */
let lightboxAttachment: { boardId: string; file: Attachment } | null = null;

function openAttachmentLightbox(boardId: string, attachment: Attachment): void {
  const modal = getLightboxModal();
  const img = document.getElementById("kbLightboxImg") as HTMLImageElement;
  img.src = attachmentUrl(boardId, attachment);
  img.alt = attachment.name;
  lightboxAttachment = { boardId, file: attachment };
  document.getElementById("kbLightboxTitle")!.textContent = attachment.name;
  lightboxReturnCardId = openCardId;
  if (_cardModal?.isOpen) _cardModal.close({ handoff: true });
  modal.open();
}

/* -----------------------------------------------------------------------------
   THE TEXT EDITOR
   -----------------------------------------------------------------------------
   One control, built once and reused for the description and for every comment,
   so formatting behaves identically wherever text is typed. It has two faces
   and only one of them is in the layout at a time: the textarea you write in,
   and the rendered result you read. Both being present at once would make the
   block change height every time you switched.

   Which face it opens on is derived from the text, never remembered: something
   written opens rendered (that is the thing you came to read), and something
   empty opens ready to type. Clicking the rendered text puts you in the
   textarea at once, because the fastest way from noticing a wrong word to
   fixing it should not be a trip to a button.
----------------------------------------------------------------------------- */

interface RichTextField {
  root: HTMLElement;
  area: HTMLTextAreaElement;
  /** Puts `value` in the field and redraws whichever face is showing. */
  setValue(value: string): void;
  /** Chooses the face from the current text and shows it. */
  showDefaultFace(): void;
  setMode(mode: "edit" | "preview"): void;
  focusEditor(): void;
}

interface RichTextFieldOptions {
  /** Asked before a click on the rendered face opens the editor. A field whose
   *  owner is currently read-only (a card being READ rather than edited) must
   *  not turn into a textarea because somebody clicked the words. Absent means
   *  always editable, which is what the comment composer and its editors are. */
  readOnly?: () => boolean;
  placeholder: string;
  emptyText: string;
  rows: number;
  maxLength: number;
  /** Fires on every keystroke, already clamped to maxLength. */
  onInput: (value: string) => void;
  /** An extra button for the right-hand end of the strip (Attach, Post…). */
  extras?: HTMLElement[];
  /** When set, the field has no preview face and no view switch: it is a
   *  composer, and what you are doing in it is writing. */
  editOnly?: boolean;
  /** Called with an image that arrived on the clipboard. Where it goes differs
   *  by field (the card's own list, the comment being written, the comment
   *  being edited), so the field only reports it. Absent means paste is left to
   *  the browser, which for an image is nothing at all. */
  onPasteImage?: (blob: Blob) => void;
}

/** The buttons, in strip order. Kept as data so the row cannot drift out of
 *  step with what applyRichTextCommand understands. */
const RICH_TEXT_TOOLS: ReadonlyArray<{
  command: RichTextCommand;
  label: string;
  title: string;
  className?: string;
}> = [
  { command: "bold", label: "B", title: "Bold  **text**", className: "rt-tool-bold" },
  { command: "italic", label: "I", title: "Italic  *text*", className: "rt-tool-italic" },
  { command: "strike", label: "S", title: "Strikethrough  ~~text~~", className: "rt-tool-strike" },
  { command: "code", label: "<>", title: "Code  `text`", className: "rt-tool-code" },
  { command: "heading", label: "H", title: "Heading  ## text" },
  { command: "bullet", label: "•", title: "Bullet list  - text" },
  { command: "numbered", label: "1.", title: "Numbered list  1. text" },
  { command: "quote", label: "❝", title: "Quote  > text" },
  { command: "link", label: "🔗", title: "Link  [text](https://…)" },
];

function createRichTextField(opts: RichTextFieldOptions): RichTextField {
  const root = document.createElement("div");
  root.className = "rt-editor";

  const toolbar = document.createElement("div");
  toolbar.className = "rt-toolbar";
  root.appendChild(toolbar);

  const area = document.createElement("textarea");
  area.className = "kb-card-desc";
  area.rows = opts.rows;
  area.spellcheck = true;
  area.placeholder = opts.placeholder;
  area.maxLength = opts.maxLength;

  const preview = document.createElement("div");
  preview.className = "rt-preview rt-body";
  // One delegated listener for the life of this field, not one per render.
  bindRichTextLinks(preview);

  const drawPreview = (): void => {
    const html = renderRichText(area.value);
    if (html) {
      preview.innerHTML = html;
      preview.classList.remove("rt-preview-empty");
    } else {
      preview.textContent = opts.emptyText;
      preview.classList.add("rt-preview-empty");
    }
  };

  const formatButtons: HTMLButtonElement[] = [];
  for (const tool of RICH_TEXT_TOOLS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `rt-tool-btn${tool.className ? ` ${tool.className}` : ""}`;
    btn.title = tool.title;
    btn.textContent = tool.label;
    btn.addEventListener("click", () => {
      applyRichTextCommand(area, tool.command);
      // applyRichTextCommand makes a native edit and deliberately does not
      // announce it; the field is what decides that an edit means "changed".
      area.dispatchEvent(new Event("input"));
    });
    toolbar.appendChild(btn);
    formatButtons.push(btn);
  }

  const gap = document.createElement("span");
  gap.className = "rt-toolbar-gap";
  toolbar.appendChild(gap);

  let editBtn: HTMLButtonElement | null = null;
  let previewBtn: HTMLButtonElement | null = null;

  const setMode = (mode: "edit" | "preview"): void => {
    if (opts.editOnly) return;
    const editing = mode === "edit";
    area.hidden = !editing;
    preview.hidden = editing;
    for (const btn of formatButtons) btn.hidden = !editing;
    editBtn?.classList.toggle("rt-view-active", editing);
    previewBtn?.classList.toggle("rt-view-active", !editing);
    if (!editing) drawPreview();
  };

  if (!opts.editOnly) {
    const makeView = (label: string, mode: "edit" | "preview"): HTMLButtonElement => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rt-view-btn";
      btn.textContent = label;
      btn.addEventListener("click", () => {
        setMode(mode);
        if (mode === "edit") area.focus();
      });
      toolbar.appendChild(btn);
      return btn;
    };
    editBtn = makeView("Write", "edit");
    previewBtn = makeView("Preview", "preview");
  }

  for (const extra of opts.extras ?? []) toolbar.appendChild(extra);

  area.addEventListener("input", () => {
    if (area.value.length > opts.maxLength) area.value = area.value.slice(0, opts.maxLength);
    opts.onInput(area.value);
  });

  /* A screenshot on the clipboard becomes an attachment. Ctrl+V into a card is
     what people actually do with a screenshot of the thing they are describing,
     and the alternative is saving it to disk first purely so it can be picked
     back off it.

     Only images are intercepted. A paste carrying text is left alone entirely,
     including a paste that carries BOTH (copying from a document often does),
     because the text is what was meant and swallowing it to grab a thumbnail
     would be maddening. */
  if (opts.onPasteImage) {
    area.addEventListener("paste", (e) => {
      const data = e.clipboardData;
      if (!data) return;
      if (data.types.includes("text/plain")) return;
      const item = Array.from(data.items).find((i) => i.type.startsWith("image/"));
      const blob = item?.getAsFile();
      if (!blob) return;
      e.preventDefault();
      opts.onPasteImage!(blob);
    });
  }

  root.appendChild(area);
  if (!opts.editOnly) {
    root.appendChild(preview);
    preview.addEventListener("click", (e) => {
      // A click on a link inside the text follows the link; a click on the text
      // around it starts editing.
      if ((e.target as HTMLElement).closest("[data-rt-href]")) return;
      // ...unless nothing here is editable right now, in which case the words
      // are just words. Checked at click time rather than at build time: the
      // same field is read-only and editable at different moments.
      if (opts.readOnly?.() === true) return;
      setMode("edit");
      area.focus();
    });
  }

  const showDefaultFace = (): void => {
    setMode(area.value.trim() ? "preview" : "edit");
  };

  if (opts.editOnly) {
    area.hidden = false;
    preview.hidden = true;
    for (const btn of formatButtons) btn.hidden = false;
  }

  return {
    root,
    area,
    setValue(value: string) {
      area.value = value;
      drawPreview();
    },
    showDefaultFace,
    setMode,
    focusEditor() {
      setMode("edit");
      area.focus();
    },
  };
}

/* -----------------------------------------------------------------------------
   THE CARD'S DESCRIPTION
----------------------------------------------------------------------------- */

let descField: RichTextField | null = null;
/** The card the description field is currently showing. Which face it opens on
 *  is decided once, when the card changes; renderCardModal() also runs when the
 *  column or board select is used, and resetting the face there would drop
 *  someone out of the text they were in the middle of typing. */
let descFieldCardId: string | null = null;

function getDescField(): RichTextField {
  if (descField) return descField;
  descField = createRichTextField({
    // The card's own description follows the card's mode. The comment composer
    // and the inline comment editors deliberately do not: writing a comment is
    // allowed on a card you are only reading.
    readOnly: () => !cardEditing,
    rows: 6,
    maxLength: MAX_DESC_LEN,
    placeholder:
      "What this card actually is. Anything you would otherwise have to reconstruct later.",
    emptyText: "No description yet. Click here to write one.",
    onInput: (value) => {
      const card = getCard(openCardId);
      if (!card) return;
      card.description = value;
      stampCard(card);
    },
    onPasteImage: (blob) => {
      void (async () => {
        const card = getCard(openCardId);
        if (!card) return;
        const added = await attachPastedImage(card.boardId, blob, card.attachments.length);
        if (!added) return;
        // Re-read: storing it was a round trip, and the card can have changed
        // underneath in the meantime.
        const still = getCard(card.id);
        if (!still) {
          forgetAttachmentFiles(card.boardId, [added]);
          return;
        }
        still.attachments.push(added);
        stampCard(still);
        if (openCardId === still.id) renderCardAttachments(still);
        flash("Pasted image attached to this card.");
      })();
    },
  });
  document.getElementById("kbCardDescHost")!.appendChild(descField.root);
  return descField;
}

/** Which mode the description was last drawn for, so a change of mode is told
 *  apart from an ordinary redraw of the same card. Without it, pressing Edit on
 *  a card already showing its rendered face left the field on that face: the
 *  same-card guard below returned before anything switched, and the toolbar
 *  appeared above a preview. */
let descFieldMode: "read" | "edit" | null = null;

function renderCardDescription(card: Card): void {
  const field = getDescField();
  const mode = cardEditing ? "edit" : "read";
  const sameCard = descFieldCardId === card.id;
  const sameMode = descFieldMode === mode;

  descFieldCardId = card.id;
  descFieldMode = mode;

  // A redraw of the same card in the same mode leaves the field alone, because
  // the text in it is already this card's and may be half-typed.
  if (sameCard && sameMode) return;

  if (!sameCard) field.setValue(card.description);

  /* OUTSIDE EDIT MODE THE DESCRIPTION IS READING MATTER, so it is forced to the
     rendered face rather than being left on the textarea. The toolbar and the
     view switch go with it in CSS, and clicking the words does not open the
     editor: see the readOnly hook this field is built with.

     Inside edit mode it opens on whichever face its text calls for, which is
     the textarea when there is nothing written yet. */
  if (mode === "read") field.setMode("preview");
  else field.showDefaultFace();
}

/* -----------------------------------------------------------------------------
   THE CARD'S OWN ATTACHMENTS
----------------------------------------------------------------------------- */

function renderCardAttachments(card: Card): void {
  const host = document.getElementById("kbCardAttachList")!;
  renderAttachmentList(host, card.attachments, {
    boardId: card.boardId,
    onRemove: (attachment) => {
      card.attachments = card.attachments.filter((a) => a.id !== attachment.id);
      forgetAttachmentFiles(card.boardId, [attachment]);
      stampCard(card);
      renderCardAttachments(card);
    },
  });
  const note = document.getElementById("kbCardAttachNote")!;
  note.textContent =
    card.attachments.length === 0
      ? "None yet."
      : `${card.attachments.length} of ${MAX_ATTACHMENTS}`;
}

/* -----------------------------------------------------------------------------
   COMMENTS
   -----------------------------------------------------------------------------
   Appended rather than edited in place, which is what makes them a record of
   what happened rather than a second description. Oldest first, because they
   are read as a sequence.

   The composer at the foot is always in writing mode: what you are doing in it
   is writing. An existing comment is the other way round, and turns into an
   editor only when you say so.
----------------------------------------------------------------------------- */

let commentField: RichTextField | null = null;
/** Files staged on the composer, before the comment they belong to exists. */
let pendingCommentAttachments: Attachment[] = [];
/** Which board's folder those staged files were written into. Held separately
 *  from the card id because discarding them has to work after the card itself
 *  has gone: deleting the card that was being commented on is exactly when the
 *  staged files most need clearing up. */
let pendingCommentBoardId: string | null = null;
/** Which card the composer's contents belong to.
 *
 *  Declared rather than remembered, because the composer survives the card modal
 *  stepping aside. Opening a picture full size, or answering a confirm, closes
 *  the card modal and reopens it, and a half-written comment must not be thrown
 *  away by that; it must also not reappear under the next card. Naming the card
 *  answers both without either path having to know about the other. */
let pendingCommentCardId: string | null = null;
/** The comment currently open in an inline editor, if any. */
let editingCommentId: string | null = null;

function getCommentField(): RichTextField {
  if (commentField) return commentField;

  const attachBtn = document.createElement("button");
  attachBtn.type = "button";
  attachBtn.className = "rt-tool-btn";
  attachBtn.title = "Attach a file to this comment";
  attachBtn.textContent = "📎";
  attachBtn.addEventListener("click", () => {
    void (async () => {
      const card = getCard(openCardId);
      if (!card) return;
      const added = await pickAttachments(card.boardId, pendingCommentAttachments.length);
      if (added.length === 0) return;
      pendingCommentAttachments.push(...added);
      pendingCommentCardId = card.id;
      pendingCommentBoardId = card.boardId;
      renderPendingCommentAttachments();
    })();
  });

  const postBtn = document.createElement("button");
  postBtn.type = "button";
  postBtn.className = "rt-view-btn rt-view-active";
  postBtn.textContent = "Post";
  postBtn.title = "Add this comment (Ctrl+Enter)";
  postBtn.addEventListener("click", () => postComment());

  commentField = createRichTextField({
    rows: 3,
    maxLength: MAX_COMMENT_LEN,
    editOnly: true,
    placeholder: "What happened, what you tried, what it needs next.",
    emptyText: "",
    // Post is NOT in here. See below.
    extras: [attachBtn],
    onInput: () => {},
    onPasteImage: (blob) => {
      void (async () => {
        const card = getCard(openCardId);
        if (!card) return;
        const added = await attachPastedImage(
          card.boardId,
          blob,
          pendingCommentAttachments.length,
        );
        if (!added) return;
        pendingCommentAttachments.push(added);
        pendingCommentCardId = card.id;
        pendingCommentBoardId = card.boardId;
        renderPendingCommentAttachments();
      })();
    },
  });
  commentField.area.addEventListener("input", () => {
    pendingCommentCardId = openCardId;
  });
  commentField.area.addEventListener("keydown", (e) => {
    // Ctrl+Enter posts. Plain Enter is a new line: a comment is prose, and the
    // most common thing after a line is another line.
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      postComment();
    }
  });
  const host = document.getElementById("kbCardCommentHost")!;
  host.appendChild(commentField.root);

  /* POST SITS UNDER THE BOX, not in the strip above it.
     The strip is formatting: things you do TO the text while writing it. Post
     is what you do when you have finished, and putting it up there had you
     reaching back over what you had just written to send it. Below is where
     the writing ends, so that is where the button that ends it goes. */
  const footer = document.createElement("div");
  footer.className = "kb-comment-post-row";
  footer.appendChild(postBtn);
  host.appendChild(footer);

  return commentField;
}

function renderPendingCommentAttachments(): void {
  const host = document.getElementById("kbCardCommentPending")!;
  const boardId = pendingCommentBoardId ?? getCard(openCardId)?.boardId ?? "";
  renderAttachmentList(host, pendingCommentAttachments, {
    boardId,
    onRemove: (attachment) => {
      pendingCommentAttachments = pendingCommentAttachments.filter((a) => a.id !== attachment.id);
      forgetAttachmentFiles(boardId, [attachment]);
      renderPendingCommentAttachments();
    },
  });
}

/** Throws away anything staged on the composer without posting it, files
 *  included. Called when the card modal closes: a half-written comment on card
 *  A must not appear under card B. */
function discardPendingComment(): void {
  if (pendingCommentAttachments.length > 0 && pendingCommentBoardId) {
    forgetAttachmentFiles(pendingCommentBoardId, pendingCommentAttachments);
  }
  pendingCommentAttachments = [];
  pendingCommentBoardId = null;
  pendingCommentCardId = null;
  editingCommentId = null;
  if (commentField) commentField.setValue("");
  const pending = document.getElementById("kbCardCommentPending");
  if (pending) clearMediaHost(pending);
}

function postComment(): void {
  const card = getCard(openCardId);
  if (!card) return;
  const field = getCommentField();
  const body = field.area.value.trim();
  if (!body && pendingCommentAttachments.length === 0) {
    flash("Write something or attach a file first.", "error");
    return;
  }
  if (card.comments.length >= MAX_COMMENTS_PER_CARD) {
    flash(`This card is at its limit of ${MAX_COMMENTS_PER_CARD} comments.`, "error", 6000);
    return;
  }
  const now = Date.now();
  card.comments.push({
    id: newId(),
    body: body.slice(0, MAX_COMMENT_LEN),
    // Taken, not copied: these records already point at files that were
    // imported for this comment, and clearing the staging list is what stops
    // the discard path unlinking them.
    attachments: pendingCommentAttachments,
    createdAt: now,
    updatedAt: now,
  });
  pendingCommentAttachments = [];
  pendingCommentCardId = null;
  pendingCommentBoardId = null;
  field.setValue("");
  renderPendingCommentAttachments();
  stampCard(card);
  renderCardComments(card);
}

/** When a comment was added, in the same words and the same date order the
 *  rest of the tool uses.
 *
 *  Local time throughout. toISOString() would have been shorter and would have
 *  put a comment written at 11pm on the following day, which is exactly the
 *  kind of off-by-one nobody notices until they are reading back a week. */
function commentStamp(comment: CardComment): string {
  const when = new Date(comment.createdAt);
  const day = when.toLocaleDateString("en-CA");
  const time = when.toTimeString().slice(0, 5);
  const stamp = `${formatDate(day)} ${time}`;
  return comment.updatedAt > comment.createdAt ? `${stamp} · edited` : stamp;
}

function renderCardComments(card: Card): void {
  const list = document.getElementById("kbCardCommentList")!;
  clearMediaHost(list);

  for (const comment of card.comments) {
    const row = document.createElement("div");
    row.className = "kb-comment";

    const head = document.createElement("div");
    head.className = "kb-comment-head";
    const stamp = document.createElement("span");
    stamp.className = "kb-comment-stamp";
    stamp.textContent = commentStamp(comment);
    head.appendChild(stamp);

    /* Who said it, when it was not the person reading it. A comment thread six
       months old is exactly where this stops being obvious. */
    if (comment.createdBy?.kind === "agent") {
      const who = document.createElement("span");
      who.className = "kb-comment-author";
      who.textContent = comment.createdBy.label;
      head.appendChild(who);
    }

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "kb-comment-action";
    editBtn.textContent = editingCommentId === comment.id ? "Done" : "Edit";
    editBtn.addEventListener("click", () => {
      editingCommentId = editingCommentId === comment.id ? null : comment.id;
      renderCardComments(card);
    });
    head.appendChild(editBtn);

    const attachBtn = document.createElement("button");
    attachBtn.type = "button";
    attachBtn.className = "kb-comment-action";
    attachBtn.textContent = "Attach";
    attachBtn.addEventListener("click", () => {
      void (async () => {
        const added = await pickAttachments(card.boardId, comment.attachments.length);
        if (added.length === 0) return;
        comment.attachments.push(...added);
        comment.updatedAt = Date.now();
        stampCard(card);
        renderCardComments(card);
      })();
    });
    head.appendChild(attachBtn);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "kb-comment-action kb-comment-danger";
    removeBtn.textContent = "Delete";
    removeBtn.addEventListener("click", () => requestDeleteComment(card, comment));
    head.appendChild(removeBtn);

    row.appendChild(head);

    if (editingCommentId === comment.id) {
      // Built fresh for this one comment and thrown away when editing ends. A
      // pool of reusable editors would have to be told which comment each one
      // is currently pointing at, which is the state this tool keeps getting
      // bitten by.
      const field = createRichTextField({
        rows: 4,
        maxLength: MAX_COMMENT_LEN,
        editOnly: true,
        placeholder: "Edit this comment.",
        emptyText: "",
        onInput: (value) => {
          comment.body = value;
          comment.updatedAt = Date.now();
          stampCard(card);
        },
        onPasteImage: (blob) => {
          void (async () => {
            const added = await attachPastedImage(
              card.boardId,
              blob,
              comment.attachments.length,
            );
            if (!added) return;
            comment.attachments.push(added);
            comment.updatedAt = Date.now();
            stampCard(card);
            renderCardComments(card);
          })();
        },
      });
      field.setValue(comment.body);
      row.appendChild(field.root);
      // Focused after it is in the document, or the caret goes nowhere.
      requestAnimationFrame(() => field.focusEditor());
    } else {
      const body = document.createElement("div");
      body.className = "rt-body kb-comment-body";
      const html = renderRichText(comment.body);
      if (html) {
        body.innerHTML = html;
        bindRichTextLinks(body);
      } else {
        body.classList.add("rt-preview-empty");
        body.textContent = "No text, files only.";
      }
      row.appendChild(body);
    }

    const files = document.createElement("div");
    files.className = "rt-attach-list";
    renderAttachmentList(files, comment.attachments, {
      boardId: card.boardId,
      onRemove: (attachment) => {
        comment.attachments = comment.attachments.filter((a) => a.id !== attachment.id);
        comment.updatedAt = Date.now();
        forgetAttachmentFiles(card.boardId, [attachment]);
        stampCard(card);
        renderCardComments(card);
      },
    });
    row.appendChild(files);

    list.appendChild(row);
  }

  const summary = document.getElementById("kbCardCommentSummary")!;
  summary.textContent =
    card.comments.length === 0 ? "None yet." : `${card.comments.length} comment(s)`;
}

/** Deleting a comment takes its files with it, and asks first on a board that
 *  asks about deletes. Same preference, same confirm modal, same reopen rule as
 *  deleting a card. */
function requestDeleteComment(card: Card, comment: CardComment): void {
  const remove = (): void => {
    forgetAttachmentFiles(card.boardId, comment.attachments);
    card.comments = card.comments.filter((c) => c.id !== comment.id);
    if (editingCommentId === comment.id) editingCommentId = null;
    stampCard(card);
    renderCardComments(card);
  };
  if (!effectiveForCard(card).confirmDelete) {
    remove();
    return;
  }
  kbConfirm(
    {
      title: "Delete this comment?",
      message:
        comment.attachments.length > 0
          ? `The comment and its ${comment.attachments.length} attached file(s) go for good.`
          : "The comment goes for good.",
      confirmLabel: "Delete",
      reopen: () => openCard(card.id),
    },
    () => {
      remove();
      openCard(card.id);
    },
  );
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

/* -----------------------------------------------------------------------------
   THE TAG ROW
   -----------------------------------------------------------------------------
   Every tag on the board used to be drawn as a button, grouped by category,
   whether the card wore it or not. On a board with four tags that is a picker.
   On a board with a Versions category holding a year of releases it is a wall,
   and the four tags the card actually has are lost in it.

   So the ROW shows what the card wears and nothing else, and choosing is a menu
   that opens on demand: one drill-down per category, a tick beside the ones
   already on. A long category becomes a long submenu, which scrolls, instead of
   fifty buttons pushing the description off the screen.

   EDITABLE WHILE READING, unlike the fields above it. Tagging is filing rather
   than editing: you do it to find the card again, not to change what it says.
----------------------------------------------------------------------------- */

function renderCardTags(card: Card): void {
  const row = document.getElementById("kbCardTagPicker")!;
  row.replaceChildren();

  // This card's own board's vocabulary, not the defaults. A card can only wear
  // a tag that exists on the board it is on.
  const board = getBoard(card.boardId);
  const boardCategories = board?.tagCategories ?? [];
  const boardTags = board?.tags ?? [];

  // No board means no vocabulary, so no tags to draw. Guarded here rather than
  // at the top, because the row still has to render its empty state.
  const worn = board ? orderedCardTags(card, board) : [];
  for (const tag of worn) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "kb-tag-chip-btn";
    chip.textContent = tag.name;
    chip.title = `${tag.name} — click to take it off`;
    paintTagChip(chip, tagColor(tag, boardCategories), true);
    chip.addEventListener("click", () => {
      card.tagIds = card.tagIds.filter((id) => id !== tag.id);
      stampCard(card);
      renderCardTags(card);
      renderAll();
    });
    row.appendChild(chip);
  }

  if (worn.length === 0) {
    const none = document.createElement("span");
    none.className = "kb-tag-none";
    none.textContent = "None";
    row.appendChild(none);
  }

  const add = document.createElement("button");
  add.type = "button";
  add.className = "kb-tag-add-btn";
  add.textContent = worn.length === 0 ? "+ Add" : "+";
  add.title = "Put a tag on this card";
  add.addEventListener("click", (e) => {
    openMenu(e.currentTarget as HTMLElement, cardTagMenu(card, boardCategories, boardTags));
  });
  row.appendChild(add);
}

/** One drill-down per category, tags inside, ticked where the card wears one.
 *
 *  Built fresh on every open so a tag added in the manager and come back from
 *  is in the list without the card being reopened. */
function cardTagMenu(card: Card, categories: TagCategory[], tags: Tag[]): MenuItem[] {
  const items: MenuItem[] = [];

  const usable = categories.filter(
    (c) =>
      c.status === "active" ||
      tags.some((t) => t.categoryId === c.id && card.tagIds.includes(t.id)),
  );

  for (const category of usable) {
    /* A retired tag stays visible on the cards that already carry it, because
       dropping it would rewrite history, but is not offered to cards that do
       not have it. */
    const catTags = tags.filter(
      (t) => t.categoryId === category.id && (t.status === "active" || card.tagIds.includes(t.id)),
    );
    if (catTags.length === 0) continue;

    const on = catTags.filter((t) => card.tagIds.includes(t.id)).length;
    items.push({
      label: on > 0 ? `${category.name} (${on})` : category.name,
      submenu: catTags.map((tag) => ({
        // A tick rather than a checkbox: MenuItem draws plain text, and the
        // mark has to survive being read at a glance in a list of twenty.
        label: `${card.tagIds.includes(tag.id) ? "\u2713 " : "\u2007 "}${tag.name}`,
        /* Its own color, so the menu and the chips it produces are recognizably
           the same tags. A tag with no color of its own inherits its category's,
           and one with neither gets no swatch rather than an invented color. */
        swatch: tagColor(tag, categories) ?? undefined,
        onClick: () => {
          if (card.tagIds.includes(tag.id)) {
            card.tagIds = card.tagIds.filter((id) => id !== tag.id);
          } else {
            card.tagIds.push(tag.id);
          }
          stampCard(card);
          renderCardTags(card);
          renderAll();
        },
      })),
    });
  }

  if (items.length === 0) {
    items.push({
      label: "This board has no tags yet",
      disabled: true,
    });
  }

  items.push({ separator: true });
  items.push({
    label: "Manage Tags\u2026",
    onClick: () => {
      const board = getBoard(card.boardId);
      if (!board) return;
      // This board's own vocabulary, not the defaults: those are templates, and
      // adding one there would not put a tag on this card.
      _cardModal!.close({ handoff: true });
      openBoardSetup(board, "tags");
    },
  });

  return items;
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

  /* WHOSE CARD, first, because on a board an agent also writes to it this is
     the row that changes how you read every row under it. */
  rows.push({
    label: "Owner",
    value: authorLabel(card.createdBy),
    note:
      card.createdBy?.kind === "agent"
        ? "created by an AI agent"
        : card.createdBy?.kind === "external"
          ? "someone else's request"
          : undefined,
  });
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
  {
    key: "openCardsInEditMode",
    label: "Open Cards in Edit Mode",
    info: "Skip the reading face and open every card with its fields ready to type in. Subtasks and comments work either way.",
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

/* -----------------------------------------------------------------------------
   THE SCALE EDITOR
   -----------------------------------------------------------------------------
   Priority and Effort are the same shape: a fixed set of rungs, each with a
   name and a color. One editor serves both, told which one it is looking at,
   the way the tag editors are told which vocabulary they are on.

   THE RUNGS THEMSELVES ARE NOT EDITABLE, only their names and colors. Adding or
   removing a rung would change what every existing card means, and a card set
   to a level that stopped existing has no honest answer. Renaming one is safe
   because the id underneath never moves.
----------------------------------------------------------------------------- */

type ScaleKind = "priority" | "effort";

/** Which scale the shared modal is currently editing. */
let scaleEditKind: ScaleKind = "priority";

interface ScaleSpec {
  title: string;
  blurb: string;
  levels: readonly string[];
  labels: Record<string, string>;
  colors: Record<string, string>;
  defaultLabels: Record<string, string>;
  defaultColors: Record<string, string>;
}

/** The live settings objects, not copies: an edit writes straight through to
 *  the setting it is editing, the way every other preference in this tool
 *  does. */
function scaleSpec(kind: ScaleKind): ScaleSpec {
  return kind === "priority"
    ? {
        title: "Priority",
        blurb:
          "How urgent a card is. The ORDER of the levels is fixed, because that order is what " +
          "the color ramp and the sorting mean. Their names and colors are yours.",
        levels: PRIORITIES,
        labels: kbSettings.priorityLabels,
        colors: kbSettings.priorityColors,
        defaultLabels: DEFAULT_PRIORITY_LABELS,
        defaultColors: DEFAULT_PRIORITY_COLORS,
      }
    : {
        title: "Effort",
        blurb:
          "How heavy a card is, separately from how urgent. Rename these to whatever your team " +
          "already says: points, t-shirt sizes, or hours.",
        levels: EFFORTS,
        labels: kbSettings.effortLabels,
        colors: kbSettings.effortColors,
        defaultLabels: DEFAULT_EFFORT_LABELS,
        defaultColors: DEFAULT_EFFORT_COLORS,
      };
}

/** The badge on each Customize row: whether anything differs from what shipped,
 *  so the row says whether it is worth opening. */
function scaleSummary(kind: ScaleKind): string {
  const spec = scaleSpec(kind);
  const renamed = spec.levels.filter((l) => spec.labels[l] !== spec.defaultLabels[l]).length;
  const recolored = spec.levels.filter(
    (l) => l !== "none" && spec.colors[l] !== spec.defaultColors[l],
  ).length;
  if (renamed === 0 && recolored === 0) return "Default";
  const parts: string[] = [];
  if (renamed > 0) parts.push(renamed + " renamed");
  if (recolored > 0) parts.push(recolored + " recolored");
  return parts.join(", ");
}

function renderScaleSummaries(): void {
  const priority = document.getElementById("kbPrioritySummary");
  if (priority) priority.textContent = scaleSummary("priority");
  const effort = document.getElementById("kbEffortSummary");
  if (effort) effort.textContent = scaleSummary("effort");
}

/** One row per rung: its color, and its name as an editable field. */
function renderScaleEditor(): void {
  const spec = scaleSpec(scaleEditKind);
  document.getElementById("kbScaleTitle")!.textContent = spec.title;
  document.getElementById("kbScaleBlurb")!.textContent = spec.blurb;

  const host = document.getElementById("kbScaleRows")!;
  host.replaceChildren();

  const restamp = () => {
    document.getElementById("kbScaleNote")!.textContent = scaleSummary(scaleEditKind);
    renderScaleSummaries();
  };

  for (const level of spec.levels) {
    const row = document.createElement("div");
    row.className = "kb-scale-row";

    /* "None" keeps its name field and loses its color, because it is the
       ABSENCE of a level rather than a level: painting it would make every
       unset card look deliberately gray. A spacer holds the column so the
       names below it still line up. */
    if (level === "none") {
      const spacer = document.createElement("span");
      spacer.className = "kb-scale-swatch-spacer";
      spacer.title = "None has no color: it is the absence of a level.";
      row.appendChild(spacer);
    } else {
      const color = document.createElement("input");
      color.type = "color";
      color.className = "kb-scale-swatch";
      color.value = spec.colors[level];
      color.addEventListener("input", () => {
        spec.colors[level] = color.value.toLowerCase();
        markSettings();
        renderAll();
        restamp();
      });
      row.appendChild(color);
    }

    const name = document.createElement("input");
    name.type = "text";
    name.className = "kb-scale-name";
    name.maxLength = 24;
    name.spellcheck = false;
    name.value = spec.labels[level];
    name.placeholder = spec.defaultLabels[level];
    const commit = () => {
      // Blank falls back to the shipped name rather than leaving a rung nameless,
      // which would draw an empty chip nothing could identify.
      const next = name.value.trim().slice(0, 24) || spec.defaultLabels[level];
      name.value = next;
      spec.labels[level] = next;
      markSettings();
      renderAll();
      restamp();
    };
    name.addEventListener("change", commit);
    name.addEventListener("blur", commit);
    row.appendChild(name);

    host.appendChild(row);
  }

  restamp();
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

  document.getElementById("kbScaleResetBtn")!.addEventListener("click", () => {
    const spec = scaleSpec(scaleEditKind);
    kbConfirm(
      {
        title: "Reset " + spec.title + " to default?",
        message:
          "Every name and color on this scale goes back to what shipped with the app. No card " +
          "changes level: only what the levels are called and how they look.",
        confirmLabel: "Reset",
        // kbConfirm REPLACES what it was opened from, so dismissing it without
        // this would drop you on the board instead of back on the scale.
        reopen: () => getScaleModal().open(),
      },
      () => {
        for (const level of spec.levels) {
          spec.labels[level] = spec.defaultLabels[level];
          spec.colors[level] = spec.defaultColors[level];
        }
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

type KbSetupTab = "boards" | "tags" | "preferences" | "data";

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
      renderDefaultColumns();
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

  document.getElementById("kbCardLayoutEditBtn")!.addEventListener("click", () => {
    getSetupModal().close({ handoff: true });
    getCardLayoutModal().open();
  });
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


  document
    .getElementById("kbBackupRefreshBtn")!
    .addEventListener("click", () => void refreshDataTab());

  return _setupModal;
}

function openSetupOnTab(tab?: KbSetupTab): void {
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

/** The default card layout, as a drag-reorderable list. A board that has not
 *  set its own follows whatever this ends up as, including later changes. */
function renderDefaultSectionOrder(): void {
  const host = document.getElementById("kbSectionOrderList");
  if (!host) return;
  renderSectionOrderInto(host, kbSettings.sectionOrder, () => {
    markSettings();
    renderDefaultSectionOrder();
    renderCardLayoutSummary();
  });
  renderCardLayoutSummary();
}

/** The row's badge: the order in short, so the common case of never having
 *  changed it does not need the modal opened to confirm that. */
function renderCardLayoutSummary(): void {
  const badge = document.getElementById("kbCardLayoutSummary");
  if (!badge) return;
  const isDefault =
    kbSettings.sectionOrder.length === DEFAULT_SETTINGS.sectionOrder.length &&
    kbSettings.sectionOrder.every((s, i) => s === DEFAULT_SETTINGS.sectionOrder[i]);
  badge.textContent = isDefault
    ? "Default"
    : kbSettings.sectionOrder.map((s) => CARD_SECTION_LABELS[s]).join(" · ");
}

let _cardLayoutModal: Modal | null = null;

function getCardLayoutModal(): Modal {
  if (_cardLayoutModal) return _cardLayoutModal;
  _cardLayoutModal = new Modal(document.getElementById("kbCardLayoutBackdrop")!, {
    closeOnEsc: true,
    onOpen: () => renderDefaultSectionOrder(),
  });

  document.getElementById("kbCardLayoutBack")!.addEventListener("click", () => {
    _cardLayoutModal!.close();
    openSetupOnTab("preferences");
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

/* -----------------------------------------------------------------------------
   EXPORT AND IMPORT
   -----------------------------------------------------------------------------
   Registered with the Data tab in App Settings, which owns the buttons; this is
   only what "everything the Kanban holds" means and how to put it back.

   The FILES are not in it. Board backgrounds and card attachments are pictures,
   videos and documents, and a JSON file that inlined them would be enormous and
   unreadable. They are named in the export, so an import restores every card
   with its attachment list intact and those files reported as missing, which is
   the honest outcome: the records came back and the bytes did not.
----------------------------------------------------------------------------- */

interface KanbanExport {
  boards: Board[];
  cards: Card[];
  tagCategories: TagCategory[];
  tags: Tag[];
}

registerTransferable({
  id: "kanban",
  snapshots: true,
  label: "Kanban",
  summary: () =>
    `${boards.length} boards · ${cards.filter((c) => !c.archived).length} cards`,
  note:
    "Board backgrounds and attached files are named in the export but not included, " +
    "so an import brings the cards back and reports their files as missing.",
  gather: async () => ({
    boards,
    cards,
    tagCategories: globalTagCategories,
    tags: globalTags,
  }),
  apply: async (parsed) => {
    const payload = parsed as Partial<KanbanExport> | null;
    if (!payload || !Array.isArray(payload.boards) || !Array.isArray(payload.cards)) {
      throw new Error("that file does not hold a board list");
    }
    // Normalized on the way in, exactly as a load is. A hand-edited export is
    // outside input like any other, and this is the one path where it reaches
    // the app.
    const nextBoards = payload.boards
      .map((raw) => {
        const board = normalizeBoardMeta(raw);
        if (!board) return null;
        /* An exported board carries its CONTENTS as well, and normalizeBoardMeta
           drops them on purpose: its job is reading an index entry, where a
           board's columns and vocabulary are not. So they are layered back on
           from the same record. Without this, importing an export returns every
           board with no columns and no tags. */
        const contents = normalizeContents((raw ?? {}) as Partial<BoardContents>);
        board.columns = contents.columns;
        board.nextCardNumber = contents.nextCardNumber;
        board.tagCategories = contents.tagCategories;
        board.tags = contents.tags;
        board.overrides = contents.overrides;
        return board;
      })
      .filter((b): b is Board => b !== null);
    // The cards travel as their own list, not inside their boards, so
    // contents.cards above is always empty and is deliberately not used.
    const nextCards = payload.cards
      .map(normalizeCard)
      .filter((c): c is Card => c !== null);

    /* Written straight to the files, one board at a time, rather than by
       loading them into memory and letting the ordinary save path do it. An
       import replaces everything, and every one of those writes snapshots what
       it replaced, so the state you had before the import is still in the last
       bucket if the file turns out to be the wrong one.

       Boards that existed before and are not in the import are deleted, or the
       tool would end up showing the union of the two, which is not what
       "replace" means anywhere else in the app. */
    const incoming = new Set(nextBoards.map((b) => b.id));
    for (const board of boards) {
      if (!incoming.has(board.id)) {
        await invoke("delete_kanban_board", { boardId: board.id }).catch(() => {});
      }
    }

    boards = nextBoards;
    cards = nextCards;
    globalTagCategories = Array.isArray(payload.tagCategories)
      ? payload.tagCategories.map(normalizeTagCategory).filter((c): c is TagCategory => c !== null)
      : [];
    globalTags = Array.isArray(payload.tags)
      ? payload.tags.map(normalizeTag).filter((t): t is Tag => t !== null)
      : [];

    // Drops cards pointing at a board the file did not carry, and tag ids no
    // vocabulary in it defines. The same pass a launch makes.
    reconcile();

    await invoke("save_kanban_index", { data: JSON.stringify(buildIndex()) });
    for (const board of boards) {
      await invoke("save_kanban_board", {
        boardId: board.id,
        data: JSON.stringify(buildContents(board)),
      });
    }
    for (const board of boards) sweepBoardAttachments(board.id);

    if (currentBoardId && !getBoard(currentBoardId)) showKbView("boards");
    renderAll();
  },
});

/* =============================================================================
   THE AGENTS TAB
   -----------------------------------------------------------------------------
   Switching agent access on for one board, deciding what it may do, and getting
   the connection into the agent's own config without anybody going near the
   data folder.

   THE CONFIG IS READ FROM DISK EVERY TIME THIS TAB OPENS rather than held in
   memory with the rest of the tool's state. It is written by this screen and
   read by the back end on every single agent request, so the copy that matters
   is the one on disk; keeping a second copy in memory is how the switch you see
   stops being the switch that is enforced.

   WRITES HERE ARE NOT DEBOUNCED, unlike everything else in this file. See
   saveAgentConfig: the gap between turning a permission off and the file saying
   so is a gap in which an agent can still use it.
============================================================================= */

/** The config as this screen last read it. Null until the tab is opened. */
let agentConfig: AgentConfig | null = null;

/* WHICH AGENT THE COPY BUTTONS ARE AIMED AT.
   Session state rather than a saved setting: it changes what is put on the
   clipboard and nothing else, and somebody who connects Claude Code once is
   not served by the app remembering that forever. Defaults to the first
   client, which is the one this was built against. */
let agentClientId: string = AGENT_CLIENTS[0].id;

async function loadAgentConfigForTab(): Promise<AgentConfig> {
  agentConfig = await loadAgentConfig();
  return agentConfig;
}

/** Applies a change and writes it, then redraws. Every switch on this tab goes
 *  through here so that none of them can forget the write. */
async function commitAgentConfig(change: (config: AgentConfig) => void): Promise<void> {
  const config = agentConfig ?? (await loadAgentConfigForTab());
  change(config);
  try {
    await saveAgentConfig(config);
  } catch (err) {
    devError("[kanban] agent config save failed", err);
    flash("Couldn't save the agent settings.", "error", 6000);
    return;
  }
  await renderAgentsTab();
}

function agentBoardConfig(config: AgentConfig, boardId: string) {
  if (!config.boards[boardId]) {
    config.boards[boardId] = { enabled: false, permissions: starterPermissions(), tokens: [] };
  }
  return config.boards[boardId];
}

async function renderAgentsTab(): Promise<void> {
  const board = getBoard(boardEditId);
  if (!board) return;
  const config = await loadAgentConfigForTab();
  const mine = boardConfig(config, board.id);
  const status = await agentStatus();

  const masterOff = document.getElementById("kbAgentMasterOff")!;
  masterOff.style.display = !config.enabled && mine.enabled ? "" : "none";

  const toggle = document.getElementById("kbAgentEnabledToggle") as HTMLInputElement;
  const toggleLabel = document.getElementById("kbAgentEnabledLabel")!;
  toggle.checked = mine.enabled;
  toggleLabel.textContent = mine.enabled ? "On" : "Off";

  /* The badge is the honest answer to "is this actually working". A board
     switched on while the pipe failed to open looks identical otherwise, and
     the agent's error would be the first anybody heard of it. */
  const badge = document.getElementById("kbAgentStatusBadge")!;
  if (!mine.enabled) {
    badge.textContent = "";
  } else if (!config.enabled) {
    badge.textContent = "Blocked by the app-wide switch";
  } else if (!status.listening) {
    badge.textContent = status.error || "Not accepting connections";
  } else if (!status.sidecarFound) {
    badge.textContent = "srbk-agent.exe is missing";
  } else {
    badge.textContent = "Ready";
  }

  document.getElementById("kbAgentBody")!.style.display = mine.enabled ? "" : "none";
  if (!mine.enabled) {
    renderAgentLive(null);
    return;
  }

  document.getElementById("kbAgentPermSummary")!.textContent = permissionSummary(mine.permissions);
  document.getElementById("kbAgentPermSummaryInModal")!.textContent = permissionSummary(
    mine.permissions,
  );

  renderAgentPermissions(board, mine.permissions);
  renderAgentClientPicker();
  renderAgentConnections(board, mine.tokens, status);
  // One read of the log, used twice: the list below and the live badge above
  // are the same facts at two lengths.
  const entries = (await readAgentLog(200)).filter((entry) => entry.boardId === board.id);
  renderAgentLive(entries[0] ?? null);
  renderAgentLog(entries);
}

/** How recently counts as "right now". Long enough to still say so between two
 *  requests an agent makes while it thinks, short enough that a badge reading
 *  "Agent active" is not describing this morning. */
const AGENT_LIVE_WINDOW_MS = 2 * 60 * 1000;

/**
 * The badge that answers "is my agent actually talking to this board".
 *
 * The status badge beside it can only say this app is LISTENING, which is true
 * of a board no agent has ever connected to. This says whether one has, and
 * how long ago, which is the difference between a setup that works and a setup
 * that merely looks right.
 */
function renderAgentLive(latest: AgentLogEntry | null): void {
  const badge = document.getElementById("kbAgentLiveBadge")!;
  if (!latest) {
    badge.style.display = "none";
    return;
  }

  const at = new Date(latest.at).getTime();
  if (Number.isNaN(at)) {
    badge.style.display = "none";
    return;
  }

  const ago = Date.now() - at;
  badge.style.display = "";
  if (ago <= AGENT_LIVE_WINDOW_MS) {
    badge.classList.add("kb-agent-live");
    badge.textContent = `${latest.agent} active now`;
  } else {
    // Still worth showing: "last seen three days ago" is how somebody notices a
    // connection quietly stopped working.
    badge.classList.remove("kb-agent-live");
    badge.textContent = `${latest.agent} last seen ${describeAgo(ago)}`;
  }
}

/** Rough and readable, not precise. Nobody needs the seconds. */
function describeAgo(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "an hour ago" : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

/**
 * The switches, grouped, into the Customize modal's grid.
 *
 * Renders whether or not the modal is open, because the tab re-renders after
 * every change and the modal is a child of the page rather than of the tab: a
 * grid built only on open would show yesterday's state for the moment between
 * a toggle and its save landing.
 */
function renderAgentPermissions(board: Board, permissions: Record<string, boolean>): void {
  const grid = document.getElementById("kbAgentPermissionList")!;
  grid.replaceChildren();

  for (const group of AGENT_PERMISSION_GROUPS) {
    const members = groupPermissions(group);
    if (members.length === 0) continue;

    const box = document.createElement("div");
    box.className = "kb-agent-perm-group";

    const title = document.createElement("div");
    title.className = "kb-agent-perm-group-title";
    title.textContent = group.title;

    const blurb = document.createElement("p");
    blurb.className = "kb-agent-perm-group-blurb";
    blurb.textContent = group.blurb;

    box.append(title, blurb);

    for (const permission of members) {
      box.appendChild(permissionRow(board, permission, permissions));
    }
    grid.appendChild(box);
  }
}

/** One switch and its label. Unchanged in behavior from the flat list this
 *  replaced; only where it is drawn moved. */
function permissionRow(
  board: Board,
  permission: (typeof AGENT_PERMISSIONS)[number],
  permissions: Record<string, boolean>,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "settings-row";

  const label = document.createElement("span");
  label.className = "kb-label-with-info";
  label.textContent = permission.label;
  const info = document.createElement("button");
  info.type = "button";
  info.className = "info-trigger-btn kb-info-btn";
  info.textContent = "ℹ";
  info.title = permission.help;
  info.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleInfoTooltip(info, permission.help);
  });
  label.appendChild(info);
  row.appendChild(label);

  const wrap = document.createElement("div");
  wrap.className = "toggle-with-label";
  const state = document.createElement("span");
  state.textContent = permissions[permission.id] ? "On" : "Off";
  const switchLabel = document.createElement("label");
  switchLabel.className = "toggle-switch";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = permissions[permission.id] === true;
  input.addEventListener("change", () => {
    void commitAgentConfig((config) => {
      agentBoardConfig(config, board.id).permissions[permission.id] = input.checked;
    });
  });
  const slider = document.createElement("span");
  slider.className = "toggle-slider";
  switchLabel.append(input, slider);
  wrap.append(state, switchLabel);
  row.appendChild(wrap);
  return row;
}

/** The agent picker, and the line under it saying where that agent's file is.
 *
 *  Grouped so the terminal agents read as one kind of thing and the editors as
 *  another. Both work identically; the split is only so the list scans. */
function renderAgentClientPicker(): void {
  const select = document.getElementById("kbAgentClientSelect") as HTMLSelectElement;
  if (!select) return;

  if (select.options.length === 0) {
    for (const [label, cli] of [
      ["Coding agents", true],
      ["Editors", false],
    ] as const) {
      const group = document.createElement("optgroup");
      group.label = label;
      for (const client of AGENT_CLIENTS.filter((c) => c.cli === cli)) {
        const option = document.createElement("option");
        option.value = client.id;
        option.textContent = client.label;
        group.appendChild(option);
      }
      select.appendChild(group);
    }
    select.addEventListener("change", () => {
      agentClientId = select.value;
      void renderAgentsTab();
    });
  }

  select.value = agentClientId;
  document.getElementById("kbAgentClientWhere")!.textContent = agentClient(agentClientId).where;
}

function renderAgentConnections(
  board: Board,
  tokens: AgentToken[],
  status: { pipeName: string; sidecarPath: string; sidecarFound: boolean },
): void {
  const list = document.getElementById("kbAgentConnectionList")!;
  list.replaceChildren();

  if (tokens.length === 0) {
    const empty = document.createElement("p");
    empty.className = "kb-agent-empty";
    empty.textContent = "No connections yet. Make one, then paste it into your AI agent.";
    list.appendChild(empty);
    return;
  }

  for (const token of tokens) {
    const row = document.createElement("div");
    row.className = "kb-agent-connection";

    const head = document.createElement("div");
    head.className = "kb-agent-connection-head";
    const name = document.createElement("span");
    name.className = "kb-agent-connection-name";
    name.textContent = token.label;
    const made = document.createElement("span");
    made.className = "kb-agent-connection-date";
    made.textContent = `Added ${formatDate(new Date(token.createdAt).toLocaleDateString("en-CA"))}`;
    head.append(name, made);
    row.appendChild(head);

    const path = document.createElement("div");
    path.className = "kb-agent-connection-path";
    path.textContent = status.sidecarFound
      ? status.sidecarPath
      : `${status.sidecarPath} (not found)`;
    row.appendChild(path);

    const info = {
      boardName: board.name,
      token: token.token,
      sidecarPath: status.sidecarPath,
      pipeName: status.pipeName,
    };

    const actions = document.createElement("div");
    actions.className = "kb-agent-connection-actions";

    const client = agentClient(agentClientId);

    const copyBtn = document.createElement("button");
    copyBtn.className = "settings-action-btn";
    copyBtn.textContent = `Copy for ${client.label}`;
    copyBtn.addEventListener("click", () => {
      void copyAgentText(connectionConfig(info, client), `${client.label} connection`);
    });

    /* Only the agents that HAVE a command get the button for it. An editor is
       configured by editing its file, and a button that copied a command it
       has no way to run would be an instruction to do something impossible. */
    const command = connectionCommand(info, client);
    const copyCmd = document.createElement("button");
    copyCmd.className = "settings-action-btn";
    copyCmd.textContent = "Copy as Command";
    copyCmd.addEventListener("click", () => {
      if (command) void copyAgentText(command, "Command");
    });

    /* The one button that answers the question the others only imply. It runs
       srbk-agent.exe for real, so a pass means this connection works end to
       end and a failure names the part that does not: the exe missing, an
       antivirus blocking it, or a token this board no longer knows. */
    const testBtn = document.createElement("button");
    testBtn.className = "settings-action-btn";
    testBtn.textContent = "Test Connection";
    const testResult = document.createElement("span");
    testResult.className = "kb-agent-test-result";
    testBtn.addEventListener("click", () => {
      testBtn.disabled = true;
      testResult.className = "kb-agent-test-result";
      testResult.textContent = "Testing…";
      testResult.title = "";
      void testAgentConnection(token.token)
        .then((result) => {
          testResult.className = result.ok
            ? "kb-agent-test-result kb-agent-test-ok"
            : "kb-agent-test-result kb-agent-test-bad";
          testResult.textContent = result.summary;
          // The full output is the tooltip rather than the line, because it is
          // several lines of JSON when it passes and a stack of detail when it
          // does not.
          testResult.title = result.detail;
        })
        .finally(() => {
          testBtn.disabled = false;
        });
    });

    const remove = document.createElement("button");
    remove.className = "modal-cancel-btn";
    remove.textContent = "Revoke";
    remove.addEventListener("click", () => {
      kbConfirm(
        {
          title: "Revoke this connection?",
          message:
            `"${token.label}" stops working immediately, and any agent using it needs a new ` +
            "connection. Cards it already created keep its name.",
          confirmLabel: "Revoke",
          reopen: () => openBoardSetup(board, "agents"),
        },
        () => {
          // Reopened AFTER the write, not beside it: the tab renders from the
          // config on disk, so reopening first would draw the revoked
          // connection back one more time before correcting itself.
          void commitAgentConfig((config) => {
            const mine = agentBoardConfig(config, board.id);
            mine.tokens = mine.tokens.filter((t) => t.id !== token.id);
          }).then(() => openBoardSetup(board, "agents"));
        },
      );
    });

    actions.append(copyBtn);
    if (command) actions.append(copyCmd);
    actions.append(testBtn, remove);
    row.appendChild(actions);
    row.appendChild(testResult);
    list.appendChild(row);
  }
}

/** Takes the entries rather than fetching them: the live badge needs the same
 *  read, and two reads of the same file would be two answers. */
function renderAgentLog(entries: AgentLogEntry[]): void {
  const list = document.getElementById("kbAgentLogList")!;
  list.replaceChildren();

  if (entries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "kb-agent-empty";
    empty.textContent = "Nothing yet. Anything an agent does to this board is listed here.";
    list.appendChild(empty);
    return;
  }

  for (const entry of entries.slice(0, 100)) {
    const row = document.createElement("div");
    row.className = entry.ok ? "kb-agent-log-row" : "kb-agent-log-row kb-agent-log-refused";

    const when = document.createElement("span");
    when.className = "kb-agent-log-when";
    const at = new Date(entry.at);
    when.textContent = Number.isNaN(at.getTime()) ? entry.at : at.toLocaleString();

    const what = document.createElement("span");
    what.className = "kb-agent-log-what";
    what.textContent = `${entry.agent}: ${opLabel(entry.op)}`;

    const outcome = document.createElement("span");
    outcome.className = "kb-agent-log-outcome";
    outcome.textContent = entry.ok ? "" : "Refused";
    if (entry.error) outcome.title = entry.error;

    row.append(when, what, outcome);
    list.appendChild(row);
  }
}

/** The same success/failure toast the rest of the app uses for a clipboard
 *  write. */
async function copyAgentText(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    flash(`${what} copied. Paste it into your AI agent's config.`, "success", 5000);
  } catch {
    flash("Couldn't reach the clipboard", "error");
  }
}

/** The summary and kill switch on the tool's own Setup > Data tab. */
async function renderAgentGlobalRow(): Promise<void> {
  const summary = document.getElementById("kbAgentGlobalSummary")!;
  const button = document.getElementById("kbAgentGlobalOffBtn") as HTMLButtonElement;
  const config = await loadAgentConfig();
  const on = Object.entries(config.boards).filter(([, board]) => board.enabled);

  if (!config.enabled) {
    summary.textContent =
      on.length > 0 ? `Off everywhere (${on.length} board(s) set up)` : "Off everywhere";
    button.textContent = "Turn Back On";
    button.className = "settings-action-btn";
  } else if (on.length === 0) {
    summary.textContent = "No boards are open to an agent";
    button.textContent = "Turn Off Everywhere";
    button.className = "danger-btn";
  } else {
    summary.textContent = `${on.length} board${on.length === 1 ? "" : "s"} open to an agent`;
    button.textContent = "Turn Off Everywhere";
    button.className = "danger-btn";
  }
  button.disabled = config.enabled && on.length === 0;
}

function wireAgentGlobalRow(): void {
  document.getElementById("kbAgentGlobalOffBtn")!.addEventListener("click", () => {
    void (async () => {
      const config = await loadAgentConfig();
      if (config.enabled) {
        kbConfirm(
          {
            title: "Turn off agent access?",
            message:
              "Every agent request is refused, on every board, from now. Each board keeps its " +
              "own settings, so turning this back on restores exactly what was allowed before.",
            confirmLabel: "Turn Off",
            reopen: () => openSetupOnTab("data"),
          },
          () => {
            void (async () => {
              config.enabled = false;
              await saveAgentConfig(config);
              flash("Agent access is off for every board.", "success");
              openSetupOnTab("data");
            })();
          },
        );
        return;
      }
      config.enabled = true;
      await saveAgentConfig(config);
      flash("Agent access is on again.", "success");
      await renderAgentGlobalRow();
    })();
  });
}

/** Wires the Agents tab. Called once, from initKanban. */
/** The Customize modal. Built once, on first use, like the rest of this tool's
 *  modals, so a board that never opens it never pays for it. */
function agentPermModal(): Modal {
  if (_agentPermModal) return _agentPermModal;

  _agentPermModal = new Modal(document.getElementById("kbAgentPermBackdrop")!, {
    closeOnEsc: true,
  });

  const back = () => {
    _agentPermModal!.close();
    const board = getBoard(boardEditId);
    if (board) openBoardSetup(board, "agents");
  };
  document.getElementById("kbAgentPermBack")!.addEventListener("click", back);
  document
    .getElementById("kbAgentPermClose")!
    .addEventListener("click", () => _agentPermModal!.close());

  return _agentPermModal;
}

function wireAgentsTab(): void {
  const toggle = document.getElementById("kbAgentEnabledToggle") as HTMLInputElement;
  toggle.addEventListener("change", () => {
    const board = getBoard(boardEditId);
    if (!board) return;
    void commitAgentConfig((config) => {
      const mine = agentBoardConfig(config, board.id);
      mine.enabled = toggle.checked;
      /* Switching a board on switches the app-wide gate on with it. The
         alternative is a user who ticks the board, copies the connection, and
         is refused by a second switch they were never shown. The app-wide one
         exists to turn everything off at once, which is a thing you go looking
         for; it is not a thing to have to find first. */
      if (toggle.checked) config.enabled = true;
      // A board switched on for the first time gets a connection straight away,
      // because a board with permissions and no connection cannot be used and
      // the next step would always have been this button.
      if (toggle.checked && mine.tokens.length === 0) {
        mine.tokens.push(newConnection("Claude Code"));
      }
    });
  });

  document.getElementById("kbAgentMasterOnBtn")!.addEventListener("click", () => {
    void commitAgentConfig((config) => {
      config.enabled = true;
    });
  });

  /* Customize hands off the way every other one in the app does: the setup
     modal steps aside rather than stacking, and Back brings it and its scroll
     position back on the Agents tab. */
  document.getElementById("kbAgentPermEditBtn")!.addEventListener("click", () => {
    const board = getBoard(boardEditId);
    if (!board) return;
    getBoardSetupModal().close({ handoff: true });
    agentPermModal().open();
  });

  document.getElementById("kbAgentAllOffBtn")!.addEventListener("click", () => {
    const board = getBoard(boardEditId);
    if (!board) return;
    void commitAgentConfig((config) => {
      const mine = agentBoardConfig(config, board.id);
      for (const permission of AGENT_PERMISSIONS) mine.permissions[permission.id] = false;
    });
  });

  document.getElementById("kbAgentNewConnectionBtn")!.addEventListener("click", () => {
    const board = getBoard(boardEditId);
    if (!board) return;
    void commitAgentConfig((config) => {
      const mine = agentBoardConfig(config, board.id);
      mine.tokens.push(newConnection(`Agent ${mine.tokens.length + 1}`));
    });
  });

  document.getElementById("kbAgentLogRefreshBtn")!.addEventListener("click", () => {
    void renderAgentsTab();
  });

  document.getElementById("kbAgentLogClearBtn")!.addEventListener("click", () => {
    const board = getBoard(boardEditId);
    if (!board) return;
    kbConfirm(
      {
        title: "Clear the activity list?",
        message:
          "The record of what agents have done is deleted, for every board. Nothing on the " +
          "board itself changes.",
        confirmLabel: "Clear",
        reopen: () => openBoardSetup(board, "agents"),
      },
      () => {
        void (async () => {
          await clearAgentLog();
          openBoardSetup(board, "agents");
        })();
      },
    );
  });

  wireAgentGlobalRow();
}

/** Forgets a deleted board's agent settings.
 *
 *  Not tidiness: the board id is gone, but its TOKENS are still valid keys in a
 *  file the back end reads on every request. Leaving them behind means a live
 *  connection pointing at nothing, which fails with "that board no longer
 *  exists" rather than being refused outright. */
function forgetAgentAccess(boardId: string): void {
  void (async () => {
    try {
      const config = await loadAgentConfig();
      if (!config.boards[boardId]) return;
      delete config.boards[boardId];
      await saveAgentConfig(config);
    } catch (err) {
      devError("[kanban] could not clear agent access for a deleted board", err);
    }
  })();
}

/* =============================================================================
   AGENT OPERATIONS
   -----------------------------------------------------------------------------
   What happens when a local AI agent asks this board to do something.

   HOW A REQUEST GETS HERE. The agent talks to srbk-agent.exe, which talks to
   src-tauri/src/agent_gate.rs over a local named pipe. The gate authenticates
   the token, works out which board it names, checks that board's permissions
   and then emits "kanban-agent-request" for this file to carry out. A request
   the gate refused never arrives here at all.

   WHAT IS DECIDED HERE RATHER THAN THERE. Everything that needs the record in
   front of it:

     • WHO CREATED THIS CARD. "Edit cards it created" against "edit cards
       created by anyone else" is a question about the card, not the request,
       and the gate has never read a board file in its life.
     • WHETHER THE CARD IS OPEN ON SCREEN. The card modal saves as you type, so
       an agent writing to the card the user is editing is a lost update. That
       one card is refused while it is open.
     • EVERY LIMIT THE TOOL ALREADY HAS. Card ceilings, title lengths, comment
       counts. An agent is held to the same numbers a person is.

   WHY THE WHOLE THING GOES THROUGH THE ORDINARY HELPERS. createCard,
   moveCardToColumn, deleteCard and the rest are what the buttons call. An agent
   creating a card takes the same path a person does, which is why the card gets
   a real number, lands in a resequenced column and appears on screen at once.
   Any operation written to touch `cards` directly would be a second, quietly
   diverging copy of the rules.

   THE REPLY IS SENT AFTER THE WRITE LANDS. flushSave() is awaited before the
   answer goes back, so "created card #12" means #12 is on disk, not that it is
   in memory and will be written in 400ms if nothing goes wrong.
============================================================================= */

/** One request, as the gate hands it over. */
interface AgentRequest {
  id: number;
  boardId: string;
  connectionId: string;
  connectionLabel: string;
  op: string;
  params: Record<string, unknown>;
  permissions: Record<string, boolean>;
  ownershipChecked: boolean;
}

/** A refusal, or a failure the agent can do something about. Its message is
 *  what the agent is shown, so every one of them says what was wrong AND what
 *  would fix it. */
class AgentError extends Error {}

/* -----------------------------------------------------------------------------
   RUNAWAY GUARD

   An agent in a loop is the failure this tool cannot otherwise notice: every
   individual request is permitted, and four hundred of them are still four
   hundred permitted requests. A person doing this by hand is rate-limited by
   being a person.

   Deliberately generous, and deliberately not a setting. It is not there to
   ration ordinary work (filing a sprint's worth of cards is thirty writes in a
   burst, which passes); it is there so a runaway stops while the board is still
   recognizable.
----------------------------------------------------------------------------- */
const AGENT_WRITE_WINDOW_MS = 60_000;
const AGENT_WRITES_PER_WINDOW = 120;
let agentWriteTimes: number[] = [];

function checkAgentWriteRate(): void {
  const now = Date.now();
  agentWriteTimes = agentWriteTimes.filter((t) => now - t < AGENT_WRITE_WINDOW_MS);
  if (agentWriteTimes.length >= AGENT_WRITES_PER_WINDOW) {
    throw new AgentError(
      `Too many changes at once: ${AGENT_WRITES_PER_WINDOW} in a minute is the limit. ` +
        "Wait a moment and continue, or ask the user to check what is being changed.",
    );
  }
  agentWriteTimes.push(now);
}

/* -----------------------------------------------------------------------------
   READING THE REQUEST
----------------------------------------------------------------------------- */

function agentString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" ? value : undefined;
}

function agentRequiredString(params: Record<string, unknown>, key: string): string {
  const value = agentString(params, key);
  if (value === undefined || !value.trim()) {
    throw new AgentError(`"${key}" is required and must be a non-empty string.`);
  }
  return value;
}

function agentBool(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key];
  return typeof value === "boolean" ? value : undefined;
}

/** A date argument: a real YYYY-MM-DD, or null to clear it. Absent leaves the
 *  field alone, which is why "not given" and "given as null" have to stay
 *  distinguishable all the way down. */
function agentDay(params: Record<string, unknown>, key: string): string | null | undefined {
  if (!(key in params)) return undefined;
  const value = params[key];
  if (value === null) return null;
  if (typeof value === "string" && parseDay(value) !== null) return value;
  throw new AgentError(`"${key}" must be a date as YYYY-MM-DD, or null to clear it.`);
}

function agentStringList(params: Record<string, unknown>, key: string): string[] | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new AgentError(`"${key}" must be a list of strings.`);
  }
  return value as string[];
}

/** Reads and checks an "effort", the same way priority is read and checked.
 *  Undefined means the request did not mention it, which is different from
 *  "none" and must leave whatever the card already had alone. */
function agentEffort(params: Record<string, unknown>): Effort | undefined {
  const effort = agentString(params, "effort");
  if (effort === undefined) return undefined;
  if (!EFFORTS.includes(effort as Effort)) {
    throw new AgentError(`"effort" must be one of: ${EFFORTS.join(", ")}.`);
  }
  return effort as Effort;
}

function agentPosition(params: Record<string, unknown>): NewCardPosition {
  return agentString(params, "position") === "top" ? "top" : "bottom";
}

/** The card an agent named: by its number on the board, or by its id. Numbers
 *  are what a person reads off a card, so an agent that was told "card 12"
 *  should be able to say 12. */
function agentCard(board: Board, params: Record<string, unknown>): Card {
  const raw = params.card;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return agentCardByNumber(board, Math.floor(raw));
  }
  if (typeof raw === "string" && raw.trim()) {
    const text = raw.trim();
    const asNumber = text.startsWith("#") ? text.slice(1) : text;
    if (/^\d+$/.test(asNumber)) return agentCardByNumber(board, Number(asNumber));
    const card = cards.find((c) => c.id === text && c.boardId === board.id);
    if (card) return card;
    throw new AgentError(`No card with the id "${text}" on this board.`);
  }
  throw new AgentError('"card" is required: the card\'s number on the board, or its id.');
}

function agentCardByNumber(board: Board, number: number): Card {
  const card = cards.find((c) => c.boardId === board.id && c.number === number);
  if (!card) throw new AgentError(`No card numbered ${number} on this board.`);
  return card;
}

/** A column by title or by id, case-insensitively on the title. An agent works
 *  from what the board reads as, and "Work In Progress" is what it reads as. */
function agentColumn(board: Board, name: string): Column {
  const needle = name.trim().toLowerCase();
  const column =
    board.columns.find((c) => c.id === name.trim()) ??
    board.columns.find((c) => c.title.toLowerCase() === needle);
  if (!column) {
    const available = board.columns.map((c) => c.title).join(", ") || "none";
    throw new AgentError(`No column called "${name}" on this board. Columns are: ${available}.`);
  }
  return column;
}

/** A tag by name or id. Names are matched case-insensitively and across every
 *  category, since an agent has no reason to know the category structure. */
function agentTag(board: Board, name: string): Tag {
  const needle = name.trim().toLowerCase();
  const tag =
    board.tags.find((t) => t.id === name.trim()) ??
    board.tags.find((t) => t.name.toLowerCase() === needle);
  if (!tag) {
    const available = board.tags.map((t) => t.name).join(", ") || "none";
    throw new AgentError(`No tag called "${name}" on this board. Tags are: ${available}.`);
  }
  return tag;
}

/* -----------------------------------------------------------------------------
   THE CHECKS THAT NEED THE RECORD
----------------------------------------------------------------------------- */

function agentOwns(record: { createdBy?: CardAuthor }, req: AgentRequest): boolean {
  return record.createdBy?.kind === "agent" && record.createdBy.by === req.connectionId;
}

/**
 * The ownership rule, in one place.
 *
 * "Edit cards created by anyone else" is treated as covering everything,
 * including the agent's own work: a user who has said an agent may change the
 * cards THEY wrote has plainly not meant to stop it changing its own.
 */
function assertMayTouchCard(card: Card, req: AgentRequest): void {
  if (req.permissions.editOthersCards) return;
  if (agentOwns(card, req)) return;
  const whose =
    card.createdBy && card.createdBy.kind !== "user"
      ? `by ${authorLabel(card.createdBy)}`
      : "in Swiss RB Knife";
  throw new AgentError(
    `Permission denied. Card #${card.number} was created ${whose}, not by this agent. ` +
      "To allow this: Swiss RB Knife > Kanban > this board > Setup > Agents > " +
      '"Edit cards created by anyone else".',
  );
}

/** Editing a card's own contents also needs one of the two edit switches. The
 *  gate accepted either; which one applies depends on whose card it is. */
function assertMayEditCard(card: Card, req: AgentRequest): void {
  assertMayTouchCard(card, req);
  if (req.permissions.editOthersCards) return;
  if (!req.permissions.editCard) {
    throw new AgentError(
      'Permission denied. "Edit cards it created" is not allowed on this board. ' +
        "To allow it: Swiss RB Knife > Kanban > this board > Setup > Agents.",
    );
  }
}

/** A permission the OPERATION did not need but this particular request does:
 *  creating a card with tags on it needs the tag switch as well as the card
 *  switch. Checked before anything is built, so a refusal leaves nothing
 *  half-made. */
function assertExtra(req: AgentRequest, permission: string, what: string): void {
  if (req.permissions[permission]) return;
  const label = permissionLabel(permission);
  throw new AgentError(
    `Permission denied. ${what} needs "${label}", which is not allowed on this board. ` +
      `To allow it: Swiss RB Knife > Kanban > this board > Setup > Agents > "${label}".`,
  );
}

/** Refuses to write to the card the user has open.
 *
 *  The card modal saves as you type from its own fields, so a change written
 *  underneath it is overwritten by the next keystroke, and a change written
 *  while the user is mid-sentence loses their sentence. One card is blocked,
 *  not the board. */
function assertCardNotOpen(card: Card): void {
  if (openCardId === card.id) {
    throw new AgentError(
      `Card #${card.number} is open in Swiss RB Knife right now. ` +
        "Ask the user to close it, then try again.",
    );
  }
}

/* -----------------------------------------------------------------------------
   WHAT THE AGENT IS SHOWN

   Shapes built for reading, not the stored records. A card's stored form
   carries ids for its tags, an order field, a board id it already knows and
   attachment bookkeeping it can do nothing with. What goes back is what the
   card SAYS.
----------------------------------------------------------------------------- */

function agentAuthorLabel(record: { createdBy?: CardAuthor }): string {
  const author = record.createdBy;
  if (author?.kind === "agent") return author.label;
  // "external" matters to an agent: it is the difference between a card the
  // user wrote and one they are relaying on somebody else's behalf.
  if (author?.kind === "external") return author.label ? `external: ${author.label}` : "external";
  return "user";
}

function agentCardSummary(card: Card, board: Board, todayStr: string): Record<string, unknown> {
  const column = getColumn(board, card.columnId);
  const done = card.subtasks.filter((s) => s.done).length;
  return {
    number: card.number,
    id: card.id,
    title: card.title,
    column: column?.title ?? "",
    priority: card.priority,
    effort: card.effort,
    tags: orderedCardTags(card, board).map((t) => t.name),
    due: card.dates.due,
    overdue: isOverdue(card, todayStr),
    archived: card.archived,
    subtasks: card.subtasks.length ? `${done}/${card.subtasks.length}` : null,
    comments: card.comments.length,
    createdBy: agentAuthorLabel(card),
  };
}

function agentCardDetail(card: Card, board: Board, todayStr: string): Record<string, unknown> {
  return {
    ...agentCardSummary(card, board, todayStr),
    description: card.description,
    dates: {
      due: card.dates.due,
      started: card.dates.started,
      testing: card.dates.testing,
      completed: card.dates.completed,
    },
    subtaskList: card.subtasks.map((s) => ({ id: s.id, text: s.text, done: s.done })),
    commentList: card.comments.map((c) => ({
      id: c.id,
      body: c.body,
      at: new Date(c.createdAt).toISOString(),
      by: agentAuthorLabel(c),
    })),
    attachments: allAttachments(card).map((a) => a.name),
    createdAt: new Date(card.createdAt).toISOString(),
    updatedAt: new Date(card.updatedAt).toISOString(),
  };
}

/* -----------------------------------------------------------------------------
   THE OPERATIONS
----------------------------------------------------------------------------- */

/** A board's own tag category, by id.
 *
 *  Not getTagCategory(), which answers for whichever scope the TAG EDITOR is
 *  currently pointed at. That is a screen this code never opens, and an agent
 *  request that happened to arrive while the user had the editor on the global
 *  vocabulary would otherwise read the wrong list. */
function agentTagCategory(board: Board, id: string): TagCategory | null {
  return board.tagCategories.find((c) => c.id === id) ?? null;
}

function agentGetBoard(board: Board): Record<string, unknown> {
  const todayStr = today();
  const live = liveCardsOnBoard(board.id);
  return {
    board: { id: board.id, name: board.name, description: board.description },
    columns: board.columns.map((column) => ({
      id: column.id,
      title: column.title,
      wipLimit: column.wipLimit,
      isDone: column.isDone,
      cards: cardsInColumn(board.id, column.id).filter((c) => !c.archived).length,
    })),
    tags: board.tags
      .filter((t) => t.status === "active")
      .map((tag) => ({
        id: tag.id,
        name: tag.name,
        category: agentTagCategory(board, tag.categoryId)?.name ?? "",
      })),
    priorities: PRIORITIES,
    cardCount: live.length,
    archivedCount: archivedCardsOnBoard(board.id).length,
    overdueCount: live.filter((c) => isOverdue(c, todayStr)).length,
  };
}

function agentListCards(board: Board, params: Record<string, unknown>): Record<string, unknown> {
  const todayStr = today();
  const wantArchived = agentBool(params, "archived") === true;
  const columnName = agentString(params, "column");
  const column = columnName ? agentColumn(board, columnName) : null;
  const tagName = agentString(params, "tag");
  const tag = tagName ? agentTag(board, tagName) : null;
  const priority = agentString(params, "priority");
  if (priority !== undefined && !PRIORITIES.includes(priority as Priority)) {
    throw new AgentError(`"priority" must be one of: ${PRIORITIES.join(", ")}.`);
  }
  const effort = agentEffort(params);
  const query = agentString(params, "query");
  const overdueOnly = agentBool(params, "overdue") === true;
  const rawLimit = params.limit;
  const limit = typeof rawLimit === "number" ? clampInt(rawLimit, 1, 500, 100) : 100;

  const matched = cards
    .filter((card) => card.boardId === board.id)
    .filter((card) => card.archived === wantArchived)
    .filter((card) => !column || card.columnId === column.id)
    .filter((card) => !tag || card.tagIds.includes(tag.id))
    .filter((card) => !priority || card.priority === priority)
    .filter((card) => !effort || card.effort === effort)
    .filter((card) => !overdueOnly || isOverdue(card, todayStr))
    .filter((card) => !query || cardMatchesText(card, query))
    .sort((a, b) => b.updatedAt - a.updatedAt);

  return {
    cards: matched.slice(0, limit).map((card) => agentCardSummary(card, board, todayStr)),
    matched: matched.length,
    returned: Math.min(matched.length, limit),
  };
}

function agentCreateCard(
  board: Board,
  req: AgentRequest,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const title = agentRequiredString(params, "title");
  const columnName = agentString(params, "column");
  const column = columnName ? agentColumn(board, columnName) : board.columns[0];
  if (!column) {
    throw new AgentError(
      "This board has no columns, so there is nowhere to put a card. Ask the user to add one.",
    );
  }

  // Everything extra the request carries is checked and resolved BEFORE the
  // card is made, so a refusal leaves no half-built card behind.
  const tagNames = agentStringList(params, "tags");
  const due = agentDay(params, "due");
  const subtaskTexts = agentStringList(params, "subtasks");
  if (tagNames?.length) assertExtra(req, "assignTags", "Putting tags on a card");
  if (due !== undefined) assertExtra(req, "setDates", "Setting a due date");
  if (subtaskTexts?.length) assertExtra(req, "manageSubtasks", "Adding subtasks");
  const tags = tagNames?.map((name) => agentTag(board, name)) ?? [];

  const priority = agentString(params, "priority");
  if (priority !== undefined && !PRIORITIES.includes(priority as Priority)) {
    throw new AgentError(`"priority" must be one of: ${PRIORITIES.join(", ")}.`);
  }
  const effort = agentEffort(params);

  const card = createCard(board, column.id, title, agentPosition(params));
  if (!card) {
    throw new AgentError(
      `This board is at its limit of ${MAX_CARDS_PER_BOARD.toLocaleString()} cards. ` +
        "Ask the user to archive finished work first.",
    );
  }

  card.createdBy = { kind: "agent", by: req.connectionId, label: req.connectionLabel };
  const description = agentString(params, "description");
  if (description !== undefined) card.description = trimTo(description, MAX_DESC_LEN);
  if (priority !== undefined) card.priority = priority as Priority;
  if (effort !== undefined) card.effort = effort;
  card.tagIds = [...new Set(tags.map((t) => t.id))];
  if (due !== undefined) card.dates.due = due;
  if (subtaskTexts?.length) {
    card.subtasks = subtaskTexts
      .slice(0, MAX_SUBTASKS_PER_CARD)
      .map((text) => ({ id: newId(), text: trimTo(text, MAX_TITLE_LEN), done: false }));
  }
  stampCard(card);
  return { created: agentCardDetail(card, board, today()) };
}

function agentUpdateCard(
  board: Board,
  req: AgentRequest,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const card = agentCard(board, params);
  assertMayEditCard(card, req);
  assertCardNotOpen(card);

  const title = agentString(params, "title");
  if (title !== undefined) {
    if (!title.trim()) throw new AgentError("A card's title cannot be empty.");
    card.title = trimTo(title, MAX_TITLE_LEN);
  }
  const description = agentString(params, "description");
  if (description !== undefined) card.description = trimTo(description, MAX_DESC_LEN);
  const priority = agentString(params, "priority");
  if (priority !== undefined) {
    if (!PRIORITIES.includes(priority as Priority)) {
      throw new AgentError(`"priority" must be one of: ${PRIORITIES.join(", ")}.`);
    }
    card.priority = priority as Priority;
  }
  const effort = agentEffort(params);
  if (effort !== undefined) card.effort = effort;
  stampCard(card);
  return { updated: agentCardDetail(card, board, today()) };
}

function agentMoveCard(
  board: Board,
  req: AgentRequest,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const card = agentCard(board, params);
  assertMayTouchCard(card, req);
  assertCardNotOpen(card);
  const column = agentColumn(board, agentRequiredString(params, "column"));

  if (column.id !== card.columnId) {
    // The ordinary path, which is also what stamps the Complete date when the
    // board is set to do that and the card lands in a done column.
    moveCardToColumn(card, column.id);
  }
  card.order = agentPosition(params) === "top" ? -1 : cardsInColumn(board.id, column.id).length;
  resequence(board.id);
  stampCard(card);
  return { moved: agentCardSummary(card, board, today()) };
}

function agentSetCardDates(
  board: Board,
  req: AgentRequest,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const card = agentCard(board, params);
  assertMayTouchCard(card, req);
  assertCardNotOpen(card);

  let touched = false;
  for (const field of ["due", "started", "testing", "completed"] as const) {
    const value = agentDay(params, field);
    if (value === undefined) continue;
    card.dates[field] = value;
    touched = true;
  }
  if (!touched) {
    throw new AgentError(
      'Nothing to set. Give at least one of "due", "started", "testing" or "completed".',
    );
  }
  stampCard(card);
  return { dates: card.dates, warning: stageOrderWarning(card) };
}

function agentArchiveCard(
  board: Board,
  req: AgentRequest,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const card = agentCard(board, params);
  assertMayTouchCard(card, req);
  assertCardNotOpen(card);
  card.archived = agentBool(params, "archived") ?? true;
  resequence(board.id);
  stampCard(card);
  return { number: card.number, archived: card.archived };
}

function agentDeleteCard(
  board: Board,
  req: AgentRequest,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const card = agentCard(board, params);
  assertMayTouchCard(card, req);
  assertCardNotOpen(card);
  const gone = { number: card.number, title: card.title };
  deleteCard(card);
  return { deleted: gone };
}

function agentAddComment(
  board: Board,
  req: AgentRequest,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const card = agentCard(board, params);
  /* Deliberately NOT ownership-checked. Commenting on the user's card is the
     ordinary case ("here is what I found on this one"), and a comment ADDS
     rather than changes: the card still says exactly what the user wrote. The
     comment carries the agent's name, so the board never loses track of who
     said it. */
  const body = agentRequiredString(params, "body");
  if (card.comments.length >= MAX_COMMENTS_PER_CARD) {
    throw new AgentError(
      `Card #${card.number} already has the maximum of ${MAX_COMMENTS_PER_CARD} comments.`,
    );
  }
  const now = Date.now();
  const comment: CardComment = {
    id: newId(),
    body: trimTo(body, MAX_COMMENT_LEN),
    attachments: [],
    createdAt: now,
    updatedAt: now,
    createdBy: { kind: "agent", by: req.connectionId, label: req.connectionLabel },
  };
  card.comments.push(comment);
  stampCard(card);
  return { commented: { card: card.number, id: comment.id } };
}

function agentDeleteComment(
  board: Board,
  req: AgentRequest,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const card = agentCard(board, params);
  const commentId = agentRequiredString(params, "comment");
  const comment = card.comments.find((c) => c.id === commentId);
  if (!comment) throw new AgentError(`No comment with the id "${commentId}" on that card.`);
  /* The COMMENT's author decides here, not the card's. An agent removing its
     own note from the user's card is a different act from editing the user's
     card, and holding it to the card's author would make an agent unable to
     tidy up after itself. */
  if (!req.permissions.editOthersCards && !agentOwns(comment, req)) {
    throw new AgentError(
      "Permission denied. That comment was not written by this agent. To allow this: " +
        "Swiss RB Knife > Kanban > this board > Setup > Agents > " +
        '"Edit cards created by anyone else".',
    );
  }
  assertCardNotOpen(card);
  card.comments = card.comments.filter((c) => c.id !== commentId);
  stampCard(card);
  return { deleted: { card: card.number, comment: commentId } };
}

function agentAddSubtask(
  board: Board,
  req: AgentRequest,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const card = agentCard(board, params);
  assertMayTouchCard(card, req);
  assertCardNotOpen(card);
  if (card.subtasks.length >= MAX_SUBTASKS_PER_CARD) {
    throw new AgentError(
      `Card #${card.number} already has the maximum of ${MAX_SUBTASKS_PER_CARD} subtasks.`,
    );
  }
  const subtask: Subtask = {
    id: newId(),
    text: trimTo(agentRequiredString(params, "text"), MAX_TITLE_LEN),
    done: false,
  };
  card.subtasks.push(subtask);
  stampCard(card);
  return { added: subtask };
}

function agentSetSubtask(
  board: Board,
  req: AgentRequest,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const card = agentCard(board, params);
  assertMayTouchCard(card, req);
  assertCardNotOpen(card);
  const subtaskId = agentRequiredString(params, "subtask");
  const subtask = card.subtasks.find((s) => s.id === subtaskId);
  if (!subtask) throw new AgentError(`No subtask with the id "${subtaskId}" on that card.`);
  const done = agentBool(params, "done");
  const text = agentString(params, "text");
  if (done === undefined && text === undefined) {
    throw new AgentError('Nothing to change. Give "done", "text", or both.');
  }
  if (done !== undefined) subtask.done = done;
  if (text !== undefined) subtask.text = trimTo(text, MAX_TITLE_LEN);
  stampCard(card);
  return { subtask };
}

function agentRemoveSubtask(
  board: Board,
  req: AgentRequest,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const card = agentCard(board, params);
  assertMayTouchCard(card, req);
  assertCardNotOpen(card);
  const subtaskId = agentRequiredString(params, "subtask");
  if (!card.subtasks.some((s) => s.id === subtaskId)) {
    throw new AgentError(`No subtask with the id "${subtaskId}" on that card.`);
  }
  card.subtasks = card.subtasks.filter((s) => s.id !== subtaskId);
  stampCard(card);
  return { removed: subtaskId };
}

function agentSetCardTags(
  board: Board,
  req: AgentRequest,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const card = agentCard(board, params);
  assertMayTouchCard(card, req);
  assertCardNotOpen(card);
  const names = agentStringList(params, "tags");
  if (names === undefined) throw new AgentError('"tags" is required: a list of tag names or ids.');
  // Resolved in full before anything is assigned, so one unknown name does not
  // leave the card holding half a list.
  const tags = names.map((name) => agentTag(board, name));
  card.tagIds = [...new Set(tags.map((t) => t.id))];
  stampCard(card);
  return { tags: orderedCardTags(card, board).map((t) => t.name) };
}

/** A ceiling on the tag vocabulary, and the ONE limit an agent meets that a
 *  person does not. It exists because a person adds tags one dialog at a time
 *  and an agent can add two hundred in a loop, at which point every tag filter
 *  in the tool is unusable. */
const MAX_AGENT_TAGS_PER_BOARD = 200;

function agentCreateTag(board: Board, params: Record<string, unknown>): Record<string, unknown> {
  const name = agentRequiredString(params, "name").trim().slice(0, 60);
  if (board.tags.length >= MAX_AGENT_TAGS_PER_BOARD) {
    throw new AgentError(
      `This board already has ${MAX_AGENT_TAGS_PER_BOARD} tags, which is as many as an agent may add.`,
    );
  }
  const categoryName = agentString(params, "category")?.trim() || "General";
  let category =
    board.tagCategories.find((c) => c.id === categoryName) ??
    board.tagCategories.find((c) => c.name.toLowerCase() === categoryName.toLowerCase());
  if (!category) {
    category = {
      id: newId(),
      name: categoryName.slice(0, 60),
      color: DEFAULT_TAG_COLOR,
      status: "active",
    };
    board.tagCategories.push(category);
  }
  const clash = board.tags.find(
    (t) => t.categoryId === category!.id && t.name.toLowerCase() === name.toLowerCase(),
  );
  if (clash) throw new AgentError(`"${category.name}" already has a tag called "${clash.name}".`);

  const color = agentString(params, "color");
  const tag: Tag = {
    id: newId(),
    categoryId: category.id,
    name,
    color: color !== undefined && isHexColor(color) ? color : null,
    status: "active",
  };
  board.tags.push(tag);
  touchBoard(board);
  return { created: { id: tag.id, name: tag.name, category: category.name } };
}

function agentWipLimit(params: Record<string, unknown>): number | null {
  const raw = params.wipLimit;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new AgentError('"wipLimit" must be a number, or null for no limit.');
  }
  return clampInt(raw, 1, 999, 1);
}

function agentCreateColumn(board: Board, params: Record<string, unknown>): Record<string, unknown> {
  if (board.columns.length >= MAX_COLUMNS_PER_BOARD) {
    throw new AgentError(`This board already has the maximum of ${MAX_COLUMNS_PER_BOARD} columns.`);
  }
  const title = agentRequiredString(params, "title").trim().slice(0, 60);
  if (board.columns.some((c) => c.title.toLowerCase() === title.toLowerCase())) {
    throw new AgentError(`This board already has a column called "${title}".`);
  }
  const column: Column = {
    id: newId(),
    title,
    wipLimit: agentWipLimit(params),
    isDone: agentBool(params, "isDone") ?? false,
    collapsed: false,
  };
  const rawPosition = params.position;
  const at =
    typeof rawPosition === "number"
      ? clampInt(rawPosition, 0, board.columns.length, board.columns.length)
      : board.columns.length;
  board.columns.splice(at, 0, column);
  touchBoard(board);
  return { created: { id: column.id, title: column.title, position: at } };
}

/**
 * Reorders a column.
 *
 * SEPARATE FROM update_column because that one changes what a column IS and
 * this changes where it sits, and an agent asking for the second should not
 * have to resend the first's fields to avoid clearing them. It costs the same
 * permission: both are the board's shape.
 */
function agentMoveColumn(board: Board, params: Record<string, unknown>): Record<string, unknown> {
  const column = agentColumn(board, agentRequiredString(params, "column"));
  const from = board.columns.findIndex((c) => c.id === column.id);

  const raw = params.position;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new AgentError("A position is needed, counting from 0 at the left.");
  }
  // Clamped rather than refused: "put it last" is reasonably written as a
  // number past the end, and refusing that helps nobody.
  const to = clampInt(raw, 0, board.columns.length - 1, from);

  if (to !== from) {
    board.columns.splice(from, 1);
    board.columns.splice(to, 0, column);
    touchBoard(board);
  }
  return {
    moved: { id: column.id, title: column.title, from, to },
    order: board.columns.map((c) => c.title),
  };
}

function agentUpdateColumn(board: Board, params: Record<string, unknown>): Record<string, unknown> {
  const column = agentColumn(board, agentRequiredString(params, "column"));
  const title = agentString(params, "title");
  if (title !== undefined) {
    const trimmed = title.trim().slice(0, 60);
    if (!trimmed) throw new AgentError("A column's title cannot be empty.");
    const clash = board.columns.some(
      (c) => c.id !== column.id && c.title.toLowerCase() === trimmed.toLowerCase(),
    );
    if (clash) throw new AgentError(`This board already has a column called "${trimmed}".`);
    column.title = trimmed;
  }
  if ("wipLimit" in params) column.wipLimit = agentWipLimit(params);
  const isDone = agentBool(params, "isDone");
  if (isDone !== undefined) column.isDone = isDone;
  touchBoard(board);
  return {
    column: { id: column.id, title: column.title, wipLimit: column.wipLimit, isDone: column.isDone },
  };
}

/* -----------------------------------------------------------------------------
   THE DISPATCHER
----------------------------------------------------------------------------- */

/** Operations that change something: what the runaway guard counts, and what
 *  decides whether the board is redrawn and the save flushed. */
const AGENT_WRITE_OPS = new Set([
  "create_card",
  "update_card",
  "move_card",
  "set_card_dates",
  "archive_card",
  "delete_card",
  "add_comment",
  "delete_comment",
  "add_subtask",
  "set_subtask",
  "remove_subtask",
  "set_card_tags",
  "create_tag",
  "create_column",
  "update_column",
  "move_column",
]);

async function runAgentRequest(req: AgentRequest): Promise<Record<string, unknown>> {
  if (!storeLoaded) {
    throw new AgentError("Swiss RB Knife is still loading its boards. Try again in a moment.");
  }
  const board = getBoard(req.boardId);
  if (!board) {
    throw new AgentError(
      "That board no longer exists in Swiss RB Knife. Ask the user for a new connection.",
    );
  }
  const writing = AGENT_WRITE_OPS.has(req.op);
  if (writing) checkAgentWriteRate();

  const params = req.params ?? {};
  let result: Record<string, unknown>;
  switch (req.op) {
    case "get_board":
      result = agentGetBoard(board);
      break;
    case "list_cards":
      result = agentListCards(board, params);
      break;
    case "get_card":
      result = { card: agentCardDetail(agentCard(board, params), board, today()) };
      break;
    case "create_card":
      result = agentCreateCard(board, req, params);
      break;
    case "update_card":
      result = agentUpdateCard(board, req, params);
      break;
    case "move_card":
      result = agentMoveCard(board, req, params);
      break;
    case "set_card_dates":
      result = agentSetCardDates(board, req, params);
      break;
    case "archive_card":
      result = agentArchiveCard(board, req, params);
      break;
    case "delete_card":
      result = agentDeleteCard(board, req, params);
      break;
    case "add_comment":
      result = agentAddComment(board, req, params);
      break;
    case "delete_comment":
      result = agentDeleteComment(board, req, params);
      break;
    case "add_subtask":
      result = agentAddSubtask(board, req, params);
      break;
    case "set_subtask":
      result = agentSetSubtask(board, req, params);
      break;
    case "remove_subtask":
      result = agentRemoveSubtask(board, req, params);
      break;
    case "set_card_tags":
      result = agentSetCardTags(board, req, params);
      break;
    case "create_tag":
      result = agentCreateTag(board, params);
      break;
    case "create_column":
      result = agentCreateColumn(board, params);
      break;
    case "update_column":
      result = agentUpdateColumn(board, params);
      break;
    case "move_column":
      result = agentMoveColumn(board, params);
      break;
    default:
      // The gate refuses anything missing from its own table, so reaching this
      // means the two tables have drifted apart.
      throw new AgentError(`"${req.op}" is not an operation this board understands.`);
  }

  if (writing) {
    // Redrawn and written BEFORE the answer goes back: the user watching the
    // board sees the change at the moment the agent is told about it, and
    // "created card #12" means #12 is on disk.
    renderAll();

    /* AND THE CARD YOU HAVE OPEN, if the agent just changed that one. The board
       behind redrawing while the modal in front of it showed the old values was
       the worst version of this: both on screen, disagreeing.

       NOT while you are editing it. Re-rendering mid-edit would overwrite the
       title you are halfway through typing, and an agent's change is never
       worth taking a person's keystrokes for. The edit wins; the agent's change
       is already saved and shows when the edit ends. */
    if (openCardId && !cardEditing && getCard(openCardId)) renderCardModal();
    await flushSave();
  }
  return result;
}

/** Registered once, for the life of the app. Kanban is initialized at startup
 *  rather than on first entry, so this answers whether or not the tool is the
 *  one currently on screen. */
function listenForAgentRequests(): void {
  void listen<AgentRequest>("kanban-agent-request", (event) => {
    const req = event.payload;
    void (async () => {
      try {
        const result = await runAgentRequest(req);
        await invoke("kanban_agent_reply", { id: req.id, ok: true, result, error: null });
      } catch (err) {
        const message =
          err instanceof AgentError
            ? err.message
            : `Swiss RB Knife could not complete that: ${String(err)}`;
        if (!(err instanceof AgentError)) devError("[kanban] agent request failed", err);
        await invoke("kanban_agent_reply", { id: req.id, ok: false, result: null, error: message });
      }
    })();
  });
}

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

  bindInfoTooltips();

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
