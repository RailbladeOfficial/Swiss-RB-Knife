/* =============================================================================
   KANBAN AGENT OPERATIONS: carrying out what an agent asks for
   -----------------------------------------------------------------------------
   The third piece of agent access, and the only one that touches the board.

     kanban-agents.ts   what is ALLOWED: permissions, tokens, the connection
                        block. A leaf: it imports neither of the other two.
     this file          what HAPPENS: one function per operation, plus the
                        listener and the dispatcher that pick them.
     kanban.ts          the board itself, which is where the model and every
                        ordinary mutation live.

   IT WAS THE BOTTOM THOUSAND LINES OF kanban.ts, lifted out unchanged. The
   seam was already there: the rest of that file needed exactly one name from
   this section, listenForAgentRequests, and this section needs no DOM, no
   modal and no rendering of its own.

   ABOUT THE IMPORT LOOP. kanban.ts imports the listener from here and this
   file imports the board from there, which is a cycle, and a deliberate one.
   It is safe for the reason standards section 9 gives: nothing here reads a
   value from kanban.ts as this file LOADS. Every reference is inside a
   function, and the earliest any of them runs is the first agent request,
   long after both files have finished loading. module-init.test.mjs is what
   holds that true.

   The alternative was a dependency object passed in at init, which for the
   thirty-odd names below would be thirty lines of plumbing restating what an
   import already says.
============================================================================= */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { devError } from "../core/dev-log";
import { newId } from "../core/ids";
import { today } from "../core/timestamp";
import { permissionLabel } from "./kanban-agents";
// openCardId and cardEditing say whether the user has this card open and is
// typing in it, which is what an agent write has to refuse. They moved to the
// card modal's own file in 0.8.0; renderCardModal and allAttachments with them.
import {
  allAttachments,
  cardEditing,
  openCardId,
  renderCardModal,
} from "./kanban-card";
import type {
  Board,
  Card,
  CardAuthor,
  CardComment,
  Column,
  Effort,
  NewCardPosition,
  Priority,
  Subtask,
  Tag,
  TagCategory,
} from "./kanban";
import {
  DEFAULT_TAG_COLOR,
  EFFORTS,
  MAX_CARDS_PER_BOARD,
  MAX_COLUMNS_PER_BOARD,
  MAX_COMMENTS_PER_CARD,
  MAX_COMMENT_LEN,
  MAX_DESC_LEN,
  MAX_SUBTASKS_PER_CARD,
  MAX_TITLE_LEN,
  PRIORITIES,
  STAGES,
  archivedCardsOnBoard,
  arrivalStage,
  authorLabel,
  cardMatchesText,
  cards,
  cardsInColumn,
  clampInt,
  createCard,
  deleteCard,
  flushSave,
  getBoard,
  getCard,
  getColumn,
  isHexColor,
  isOverdue,
  liveCardsOnBoard,
  moveCardToColumn,
  normalizeMoment,
  orderedCardTags,
  parseDay,
  renderAll,
  resequence,
  stageOrderWarning,
  stampCard,
  storeLoaded,
  touchBoard,
  trimTo,
} from "./kanban";

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
  /** Set only by the gate, for an edit it has already refused: answer with the
   *  wording that names the exact switch, and perform nothing. */
  explain?: boolean;
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
/** A due date: a calendar day and nothing else.
 *
 *  A time is REFUSED here rather than accepted and dropped. parseDay takes
 *  either shape, so an agent sending "2026-09-06T14:00" for a due date would
 *  have been told yes, had it written, and then found it gone at the next load
 *  when normalizeDay refused it. Being told no is the honest answer. */
function agentDay(params: Record<string, unknown>, key: string): string | null | undefined {
  if (!(key in params)) return undefined;
  const value = params[key];
  if (value === null) return null;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && parseDay(value) !== null) {
    return value;
  }
  throw new AgentError(`"${key}" must be a date as YYYY-MM-DD, or null to clear it.`);
}

/** A stage stamp: a day, or a day and a time. Normalized the same way a stamp
 *  from the front end is, so an agent writing "2026-09-06 14:00" produces a
 *  value that sorts and compares like every other one. */
function agentMoment(params: Record<string, unknown>, key: string): string | null | undefined {
  if (!(key in params)) return undefined;
  const value = params[key];
  if (value === null) return null;
  const normalized = normalizeMoment(value);
  if (normalized !== null) return normalized;
  throw new AgentError(
    `"${key}" must be YYYY-MM-DD or YYYY-MM-DDTHH:MM, or null to clear it.`,
  );
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
      "To allow this: Swiss RB Knife > Kanban > this board > Setup > Agents > What It May Do > " +
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
        'To allow it: Swiss RB Knife > Kanban > this board > Setup > Agents > What It May Do > "Edit cards it created".',
    );
  }
}

/** The wording for an edit the gate has ALREADY refused because neither edit
 *  switch is on. Which of the two would have allowed it depends on whose card
 *  it is, and only this side can see that, so the gate asks here before it
 *  answers the agent. It reads the card and returns a sentence; it never
 *  changes anything, and the request stays refused whatever it says. An empty
 *  answer (no such card) leaves the gate's own sentence naming both. */
function explainEditRefusal(
  board: Board,
  req: AgentRequest,
  params: Record<string, unknown>,
): Record<string, unknown> {
  let card: Card;
  try {
    card = agentCard(board, params);
  } catch {
    return {};
  }
  const own = agentOwns(card, req);
  const label = permissionLabel(own ? "editCard" : "editOthersCards");
  const whose = own
    ? "by this agent"
    : card.createdBy && card.createdBy.kind !== "user"
      ? `by ${authorLabel(card.createdBy)}, not by this agent`
      : "in Swiss RB Knife, not by this agent";
  return {
    message:
      `Permission denied. Card #${card.number} was created ${whose}, so editing it needs ` +
      `"${label}", which is not allowed on the board "${board.name}". ` +
      `To allow it: Swiss RB Knife > Kanban > ${board.name} > Setup > Agents > What It May Do > "${label}".`,
  };
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
      `To allow it: Swiss RB Knife > Kanban > this board > Setup > Agents > What It May Do > "${label}".`,
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
      // "completed" for a done column, the column's own stage, or null.
      stage: arrivalStage(column),
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
  // Due is a target and is a day; the three stages are records of something
  // that happened and carry the time it happened at.
  const due = agentDay(params, "due");
  if (due !== undefined) {
    card.dates.due = due;
    touched = true;
  }
  for (const field of STAGES) {
    const value = agentMoment(params, field);
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
        "Swiss RB Knife > Kanban > this board > Setup > Agents > What It May Do > " +
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

/** The stage date a column stamps, as an agent sent it: undefined when not
 *  given, null for none. Completed is refused rather than accepted, because a
 *  column stamps Completed by meaning done, the same as in Column Settings. */
function agentColumnStage(params: Record<string, unknown>): "started" | "testing" | null | undefined {
  if (!("stage" in params)) return undefined;
  const raw = params.stage;
  if (raw === null || raw === "none" || raw === "") return null;
  if (raw === "started" || raw === "testing") return raw;
  if (raw === "completed") {
    throw new AgentError("A column stamps Completed by meaning done. Set isDone to true instead of stage.");
  }
  throw new AgentError('stage must be "started", "testing" or null.');
}

function agentCreateColumn(board: Board, params: Record<string, unknown>): Record<string, unknown> {
  if (board.columns.length >= MAX_COLUMNS_PER_BOARD) {
    throw new AgentError(`This board already has the maximum of ${MAX_COLUMNS_PER_BOARD} columns.`);
  }
  const title = agentRequiredString(params, "title").trim().slice(0, 60);
  if (board.columns.some((c) => c.title.toLowerCase() === title.toLowerCase())) {
    throw new AgentError(`This board already has a column called "${title}".`);
  }
  const isDone = agentBool(params, "isDone") ?? false;
  const stage = agentColumnStage(params) ?? null;
  if (isDone && stage) {
    throw new AgentError("A done column always stamps Completed, so it cannot stamp another stage as well.");
  }
  const column: Column = {
    id: newId(),
    title,
    wipLimit: agentWipLimit(params),
    isDone,
    stage,
    collapsed: false,
  };
  const rawPosition = params.position;
  const at =
    typeof rawPosition === "number"
      ? clampInt(rawPosition, 0, board.columns.length, board.columns.length)
      : board.columns.length;
  board.columns.splice(at, 0, column);
  touchBoard(board);
  return { created: { id: column.id, title: column.title, position: at, stage: arrivalStage(column) } };
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
  // Checked before anything changes, so a refused stage leaves the column as it was.
  const stage = agentColumnStage(params);
  const isDone = agentBool(params, "isDone");
  if ((isDone ?? column.isDone) && stage) {
    throw new AgentError(
      `"${column.title}" means done, so it always stamps Completed and cannot stamp another stage. ` +
        "Send isDone: false in the same request to change that.",
    );
  }
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
  if (isDone !== undefined) column.isDone = isDone;
  // A done column stamps Completed, so it keeps no stage of its own.
  if (column.isDone) column.stage = null;
  else if (stage !== undefined) column.stage = stage;
  touchBoard(board);
  return {
    column: {
      id: column.id,
      title: column.title,
      wipLimit: column.wipLimit,
      isDone: column.isDone,
      stage: arrivalStage(column),
    },
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
  // The gate's question about an edit it has already refused. Answered with
  // words before anything that counts as work, and never reaches the switch.
  if (req.explain) return explainEditRefusal(board, req, req.params ?? {});

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
export function listenForAgentRequests(): void {
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
