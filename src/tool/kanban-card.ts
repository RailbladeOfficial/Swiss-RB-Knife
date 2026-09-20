/* =============================================================================
   KANBAN CARD: the card modal, and the files a card carries
   -----------------------------------------------------------------------------
   One card, opened. Everything from the moment you click a card face to the
   moment the modal closes: its fields, its stages, its color, its
   attachments, the picture viewer, the description editor, comments,
   subtasks and the tag row.

   The fourth file to come out of kanban.ts, and the biggest. The others each
   answer one question about agents; this one answers "what does a card look
   like when you open it", which is a genuinely separate job from "what does
   the board look like".

   WHAT STAYED BEHIND, and why it is not arbitrary. Operations on a card that
   the BOARD also performs live in kanban.ts: stampCard, moveCardToColumn,
   moveCardToBoard, requestDeleteCard, stageOrderWarning. The board's
   right-click menu and the card face call all of those without the modal
   being open at all, so they belong to the board. They used to be filed in
   this section, which is the main reason it looked impossible to separate.

   WHAT CAME WITH IT that might look like it should not: attachmentsRoot and
   the attachment file plumbing. Attachments are a card's files, added and
   removed on this screen; the board only asks which ones a card has, for the
   cover image. Board BACKGROUNDS are the opposite and stayed with the board.

   THE LOOP with kanban.ts is deliberate, and the same one the other three
   files have. Nothing here reads a value from kanban.ts as this file LOADS;
   every reference is inside a function, and the earliest one runs is the
   first time a card is opened. See standards section 9, and
   module-init.test.mjs, which is what keeps that true.
============================================================================= */

import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { devError, flash } from "../core/shell";
import { Modal, ModalTabs } from "../modal/modal";
import { closeMenu, openMenu, type MenuItem } from "../menu/menu";
import { formatBytes } from "../core/format";
import { openCardStats } from "./kanban-stats";
import { paintTagChip, cardOwnerMenu } from "./kanban-card-face";
import { newId } from "../core/ids";
import { localDay, today } from "../core/timestamp";
import {
  applyRichTextCommand,
  bindRichTextLinks,
  renderRichText,
  type RichTextCommand,
} from "../core/rich-text";
import type {
  Attachment,
  Board,
  Card,
  CardColorMode,
  CardComment,
  CardSection,
  Tag,
  TagCategory,
} from "./kanban-model";
import {
  applySolidColor,
  boards,
  cardColorMode,
  cards,
  createdMoment,
  dayDiff,
  describeDays,
  duplicateCard,
  effective,
  effectiveForCard,
  effortChoices,
  effortColorOf,
  effortLabel,
  flushSave,
  formatDate,
  furthestStage,
  getBoard,
  getCard,
  getColumn,
  hasTimeOfDay,
  kbConfirm,
  moveCardToBoard,
  moveCardToColumn,
  normalizeColorMode,
  normalizeEffort,
  normalizePriority,
  normalizeTextColor,
  nowStamp,
  openBoardSetup,
  openTagEditor,
  orderedCardTags,
  priorityChoices,
  priorityColorOf,
  priorityLabel,
  type LevelChoice,
  readableTextOn,
  renderAll,
  requestDeleteCard,
  resolveCardColor,
  setTagEditHandoff,
  stageOrderWarning,
  stampCard,
  tagColor,
  topOpenKanbanModal,
} from "./kanban";
import {
  ADVANCE_LABELS,
  CARD_COLORS,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  MAX_COMMENTS_PER_CARD,
  MAX_COMMENT_LEN,
  MAX_DESC_LEN,
  MAX_SUBTASKS_PER_CARD,
  MAX_TITLE_LEN,
  STAGES,
  STAGE_LABELS,
  attachmentKind,
} from "./kanban-model";

/* -----------------------------------------------------------------------------
   THE CARD MODAL'S OWN STATE

   These live here rather than with the tool's other modal handles because
   only this file opens, closes or assigns them, and a value can only be
   assigned by the file that declares it. kanban.ts and kanban-executor.ts
   both READ openCardId, which an import gives them for free.
----------------------------------------------------------------------------- */

export let _cardColorModal: Modal | null = null;
export let _cardModal: Modal | null = null;

/** The card the card modal is currently showing. */
export let openCardId: string | null = null;

export function getCardModal(): Modal {
  if (_cardModal) return _cardModal;

  const backdrop = document.getElementById("kbCardBackdrop")!;
  const titleInput = document.getElementById("kbCardTitleInput") as HTMLInputElement;
  const columnSelect = document.getElementById("kbCardColumnSelect") as HTMLSelectElement;
  const boardSelect = document.getElementById("kbCardBoardSelect") as HTMLSelectElement;
  const dueInput = document.getElementById("kbCardDueInput") as HTMLInputElement;
  const subtaskInput = document.getElementById("kbCardSubtaskInput") as HTMLInputElement;

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
      // The tag search panel is parented to <body>, not to the card, so
      // closing the card does not take it with it.
      closeTagSearch();
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
  });

  const effortSelect = document.getElementById("kbCardEffortSelect") as HTMLSelectElement;
  effortSelect.addEventListener("change", () => {
    const card = getCard(openCardId);
    if (!card) return;
    card.effort = normalizeEffort(effortSelect.value);
    stampCard(card);
    renderCardReadonlyValues(card);
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

  /* Today, Tomorrow and End of Week. End of week is the coming Friday, and
     today on a Friday: a due date is a work target, and "by the end of the
     week" means before the weekend. Worked out at the click, in local time, so
     a card modal left open overnight still means the day it is pressed. */
  for (const btn of document.querySelectorAll<HTMLButtonElement>("[data-kb-due-shortcut]")) {
    btn.addEventListener(
      "click",
      withCard((card) => {
        const day = new Date();
        const which = btn.dataset.kbDueShortcut;
        if (which === "tomorrow") day.setDate(day.getDate() + 1);
        else if (which === "friday") day.setDate(day.getDate() + ((5 - day.getDay() + 7) % 7));
        card.dates.due = localDay(day);
        dueInput.value = card.dates.due;
        stampCard(card);
        renderCardDue(card);
      }),
    );
  }

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
    /* A BUILDER, not an array: Owner is a keepOpen row, so the panel is drawn
       again after one is picked and has to be built from the card as it now
       is, not as it was when the button was pressed. */
    openMenu(e.currentTarget as HTMLElement, () => [
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

export type KbCardTab = "basic" | "subtasks" | "comments";

export let cardEditing = false;

/* TWO WAYS TO BE EDITING, and they are not the same thing.
   -----------------------------------------------------------------------------
   Pressing the pencil starts a SESSION: it takes a snapshot, offers save and
   discard, and ends when you pick one. That is for a card you mostly read.

   "Open Cards in Edit Mode" is not a session, it is the tool's old behavior:
   the fields are simply live, every one of them writes as you leave it, and
   closing the card is a perfectly good way to finish. There is nothing to save
   because it is already saved, and nothing to discard because there was never a
   point at which it had not been written.

   So when this is on there is no snapshot, no save, no discard and no pencil.
   Conflating the two put a Save button on a card that had already saved and a
   Discard button that would silently undo edits made ten minutes ago. */
let cardAlwaysEditing = false;

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
  // Drives the CSS that hides all three header controls. See cardAlwaysEditing.
  modal.dataset.kbAlwaysEditing = cardAlwaysEditing ? "true" : "false";

  const card = getCard(openCardId);
  /* Snapshotted on the way IN only, so re-rendering mid-edit cannot overwrite
     the thing Discard is supposed to go back to. Never taken when the board is
     always in edit mode: there is no discard to serve it, and holding a copy of
     the card for a button that does not exist is just a way to get it wrong
     later. */
  if (on && !cardAlwaysEditing && card && !cardEditSnapshot) {
    cardEditSnapshot = structuredClone(card);
  }
  if (!on) cardEditSnapshot = null;

  if (card) renderCardModal();
}

/** Ends the edit session, keeping the changes. Everything was already written
 *  as it was typed, so this only has to put the board in step and change face.
 *
 *  A no-op on a board that is always editing: there is no session to end, and
 *  dropping to the reading face would contradict the preference. */
function saveCardEdit(): void {
  if (cardAlwaysEditing) return;
  setCardEditing(false);
  void flushSave();
  renderAll();
}

/** Leaves edit mode, putting back what was there when it started. */
function cancelCardEdit(): void {
  if (cardAlwaysEditing) return;
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

export function openCard(cardId: string, tab?: KbCardTab): void {
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

  /* Which of the two shapes this board wants. Read per card rather than held,
     because a card dragged to a board with the other preference has to open the
     way THAT board works. setCardEditing renders, so there is no second render
     here. */
  cardEditSnapshot = null;
  cardAlwaysEditing = effectiveForCard(card).openCardsInEditMode;
  setCardEditing(cardAlwaysEditing);

  getCardModal().open();
  // Asked once per open, in the background: a file can vanish between sessions
  // and the card should say so rather than showing a broken picture.
  void refreshAttachmentPresence(card);
}

export function renderCardModal(): void {
  const card = getCard(openCardId);
  if (!card) return;
  const settings = effectiveForCard(card);

  renderCardHeader(card);
  (document.getElementById("kbCardTitleInput") as HTMLInputElement).value = card.title;
  document.getElementById("kbCardTitleDisplay")!.textContent = card.title || "Untitled card";
  renderCardReadonlyValues(card);
  // The tab counts are drawn by renderCardComments and renderCardSubtasks
  // below, which is also what keeps them current after every change.
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
  // Undefined for "none" and for a level this install no longer has: both read
  // as unset, and painting the second one would need a color there is no rung
  // to take it from. See normalizeLevelId in kanban.ts.
  set("kbCardPriorityDisplay", priorityLabel(card.priority), priorityColorOf(card.priority) ?? undefined);
  set("kbCardEffortDisplay", effortLabel(card.effort), effortColorOf(card.effort) ?? undefined);
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
export function renderCardPlacement(card: Card): void {
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

  /* Both ladders are rebuilt on every open. They used to be built from a
     constant, which was fine while the rungs were fixed; a level added since
     this card was last opened has to be in the list. */
  fillLevelSelect("kbCardPrioritySelect", priorityChoices(), card.priority);
  fillLevelSelect("kbCardEffortSelect", effortChoices(), card.effort);
}

/** One scale into one select.
 *
 *  A card carrying a level this install no longer has lands on the first
 *  option, which is the absence of a level: the rest of the card already reads
 *  it as unset, so a select left showing nothing would be the one place
 *  claiming otherwise. Nothing is written by this; the card keeps the id until
 *  somebody actually picks something. */
function fillLevelSelect(id: string, choices: LevelChoice[], current: string): void {
  const select = document.getElementById(id) as HTMLSelectElement;
  select.replaceChildren();
  for (const choice of choices) {
    const option = document.createElement("option");
    option.value = choice.id;
    option.textContent = choice.label;
    select.appendChild(option);
  }
  select.value = current;
  if (select.selectedIndex === -1) select.selectedIndex = 0;
}

/* -----------------------------------------------------------------------------
   STAGES
----------------------------------------------------------------------------- */

/** Sets the next unstamped stage to today. */
function advanceStage(card: Card): void {
  const next = furthestStage(card) + 1;
  if (next >= STAGES.length) return;
  // The moment, not the day. This button's whole job is recording when
  // something happened, and "some time on Tuesday" is a worse answer than the
  // one the clock was already able to give.
  card.dates[STAGES[next]] = nowStamp();
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

function renderCardStages(card: Card): void {
  const grid = document.getElementById("kbCardStages")!;
  grid.replaceChildren();

  grid.appendChild(buildStageRow("Created", createdMoment(card), null));
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
    advance.title = `Stamps ${STAGE_LABELS[next]} with the date and time right now.`;
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
  input.type = "datetime-local";
  input.className = "kb-stage-input";
  /* A stamp written before stage times existed is a bare date, which a
     datetime-local input will not display at all. Shown at midnight so the
     control has something to hold, and left alone in storage until it is
     actually edited: reading a card must not rewrite it. */
  input.value = value ? (hasTimeOfDay(value) ? value : `${value}T00:00`) : "";
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

export function openCardColor(card: Card): void {
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
export function allAttachments(card: Card): Attachment[] {
  return [...card.attachments, ...card.comments.flatMap((c) => c.attachments)];
}

/** "<boardId>/<attachmentId>" for attachments the last check said are not on
 *  disk. Held so a card with a missing file draws it as missing on every render
 *  rather than only on the render that discovered it. */
export const missingAttachments = new Set<string>();

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
export let attachmentsRoot = "";

/** Told to us by loadAll(), which is where the back end is asked. A setter
 *  rather than a plain export because the value is learned over there and
 *  used over here, and only the file that declares a value can assign it. */
export function setAttachmentsRoot(path: string): void {
  attachmentsRoot = path;
}

/** Unlinks the copies behind these records, best effort.
 *
 *  Deliberately fire-and-forget. The card edit that triggered it has already
 *  happened in memory and is about to be written; a file that will not delete
 *  (open in a viewer, say) is not a reason to fail that or to nag about it. */
export function forgetAttachmentFiles(boardId: string, list: Attachment[]): void {
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
export function sweepBoardAttachments(boardId: string): void {
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
export async function cloneAttachments(original: Card, copy: Card): Promise<void> {
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
export async function moveAttachmentsToBoard(
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

export let _lightboxModal: Modal | null = null;
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
export function discardPendingComment(): void {
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
  // The Comments tab's count, redrawn with the list for the same reason the
  // Subtasks one is: every add and delete comes back through here.
  renderCardTabCounts(card);

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

  /* The Subtasks tab's "X/Y" is the same fact as the line above, so it is
     redrawn with it. It used to be drawn only when the card opened, and every
     tick, add and remove left the tab stale until the card was reopened. */
  renderCardTabCounts(card);
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
  const tools = document.getElementById("kbCardTagTools")!;
  row.replaceChildren();
  tools.replaceChildren();

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
    chip.title = `${tag.name}, click to take it off`;
    paintTagChip(chip, tagColor(tag, boardCategories), true);
    chip.addEventListener("click", () => {
      card.tagIds = card.tagIds.filter((id) => id !== tag.id);
      stampCard(card);
      renderCardTags(card);
    });
    row.appendChild(chip);
  }

  if (worn.length === 0) {
    const none = document.createElement("span");
    none.className = "kb-tag-none";
    none.textContent = "None";
    row.appendChild(none);
  }

  /* THE THREE CONTROLS live on the heading line, not at the end of the chips.
     A card with nine tags would otherwise put them a wrapped row lower than a
     card with one, so the thing you reach for moves every time you open a
     different card.

     Search first, because it is the one that scales: a board with sixty tags
     is four drill-downs and a scroll away from the one you want through the
     menu, and one word away through this. The menu stays because it is the
     faster answer when there are eight tags and you want to see all of them,
     and Manage Tags gets its own button because it was buried at the bottom of
     that menu, which is a long way to go for the thing you reach for when the
     tag you want does not exist yet. */
  const search = document.createElement("input");
  search.type = "text";
  search.className = "kb-tag-search";
  search.placeholder = "Find a tag";
  search.spellcheck = false;
  search.autocomplete = "off";
  search.title = "Type to filter, Enter to apply. A name that does not exist offers to make it.";
  tools.appendChild(search);

  const add = document.createElement("button");
  add.type = "button";
  add.className = "kb-tag-add-btn";
  add.textContent = "+";
  add.title = "Put a tag on this card, by category";
  add.addEventListener("click", (e) => {
    closeTagSearch();
    // Rebuilt on each tick rather than opened once: the ticks and the per
    // category counts are what tell you what you have just done.
    openMenu(e.currentTarget as HTMLElement, () => cardTagMenu(card, boardCategories, boardTags));
  });
  tools.appendChild(add);

  const manage = document.createElement("button");
  manage.type = "button";
  manage.className = "kb-tag-add-btn kb-tag-manage-btn";
  manage.title = "Manage this board's tags";
  manage.innerHTML = GEAR_SVG;
  manage.addEventListener("click", () => {
    closeTagSearch();
    openBoardTagsFromCard(card);
  });
  tools.appendChild(manage);

  wireTagSearch(search, cardTagPickSpec(card));
}

/** The card's answer to "what am I picking for". Every active tag on its board
 *  is offered, and a name that matches nothing opens the tag editor with it
 *  filled in. A card whose board has gone is given an empty vocabulary rather
 *  than being refused, because the row above it still has to draw. */
function cardTagPickSpec(card: Card): TagPickSpec {
  const board = getBoard(card.boardId);
  return {
    board: board ?? EMPTY_TAG_BOARD,
    has: (tagId) => card.tagIds.includes(tagId),
    toggle: (tag) => {
      if (card.tagIds.includes(tag.id)) {
        card.tagIds = card.tagIds.filter((id) => id !== tag.id);
      } else {
        card.tagIds.push(tag.id);
      }
      stampCard(card);
    },
    after: () => renderCardTags(card),
    create: (name) => newTagFromCard(card, name),
  };
}

/** Stands in for a board that has gone while its card modal was open. Only the
 *  two vocabulary fields are read by the picker. */
const EMPTY_TAG_BOARD = { tagCategories: [], tags: [] } as unknown as Board;

/** The gear on the Manage Tags button. Inline so it takes the theme's colors
 *  the way every other icon in the app does. */
const GEAR_SVG = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
       stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>`;

/** Leaves the card for this board's tag vocabulary, and comes back here rather
 *  than to Board Setup: the card is where the trip started. */
function openBoardTagsFromCard(card: Card): void {
  const board = getBoard(card.boardId);
  if (!board) return;
  // This board's own vocabulary, not the defaults: those are templates, and
  // adding one there would not put a tag on this card.
  //
  // Optional, because this is now also reached from the board's right-click
  // menu, where there is no open card to step aside for. close() is a no-op on
  // a modal that is not open, but the instance itself may never have been
  // built at all.
  _cardModal?.close({ handoff: true });
  openBoardSetup(board, "tags");
}

/* -----------------------------------------------------------------------------
   THE TAG SEARCH
   -----------------------------------------------------------------------------
   A filter box beside the card's tags, with a grouped list under it: one
   heading per tag category, that category's tags below it, ticked where the
   card already wears one.

   WHY NOT A <select> WITH <optgroup>, which is the obvious answer and the
   shape this is imitating. A native select cannot be typed into to filter, has
   no room for a color swatch or a tick, and on Windows renders in the OS's own
   colors, so it would be the one control in the tool that ignores the theme.

   FIXED POSITIONING, measured off the input. The card modal's body scrolls,
   and a scroll container clips an absolutely positioned child, so a panel
   parented to the row would be cut off at the bottom of the field. Same reason
   menu.ts positions its panels in viewport coordinates, and the same
   consequence: a scroll or a resize closes it rather than being chased.

   ENTER ON A NAME THAT DOES NOT EXIST OFFERS TO MAKE IT. That is the whole
   point of typing rather than picking: the moment you find a tag missing is
   the moment you were going to add it, and until now that meant leaving the
   card for Board Setup and finding your way back.

   TOLD WHAT IT IS PICKING FOR, rather than handed a card. The board's filter
   bar wants exactly this control over a set of tag ids, and the alternative
   was a second copy of the positioning, the outside-click teardown and the
   arrow-key cursor. That is the pair this codebase has already paid to keep
   in step by hand twice. The three ways the two callers differ are the three
   optional members of the spec below.
----------------------------------------------------------------------------- */

/**
 * What a tag search is picking for.
 *
 * `has` and `toggle` rather than a mutable set, because the card writes
 * through stampCard and the filter writes through a redraw. The picker has no
 * business knowing which.
 */
export interface TagPickSpec {
  /** Whose vocabulary is offered. */
  board: Board;
  has: (tagId: string) => boolean;
  toggle: (tag: Tag) => void;
  /** Redraws whatever owns the picker, once a tag has gone on or come off. */
  after: () => void;
  /** Narrows what is offered. A tag already on is offered regardless, so it
   *  can always be taken back off. Omitted means every active tag. */
  offer?: (tag: Tag) => boolean;
  /** What a typed name matching nothing offers to do. Omitted means it offers
   *  nothing, which is right for the filter bar: filtering by a tag no card
   *  wears finds nothing, so making one there is a dead end. */
  create?: (name: string) => void;
  /** The empty state, for when nothing at all can be offered. */
  emptyText?: string;
}

let tagSearchPanel: HTMLElement | null = null;
let tagSearchCleanup: (() => void) | null = null;

/** Takes the panel down. Safe to call when nothing is open. */
export function closeTagSearch(): void {
  tagSearchCleanup?.();
  tagSearchCleanup = null;
  tagSearchPanel?.remove();
  tagSearchPanel = null;
}

export function wireTagSearch(input: HTMLInputElement, spec: TagPickSpec): void {
  const open = (): void => openTagSearch(input, spec);
  input.addEventListener("focus", open);
  input.addEventListener("click", open);
  input.addEventListener("input", open);

  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeTagSearch();
      input.blur();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      openTagSearch(input, spec);
      moveTagSearchCursor(e.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (e.key !== "Enter") return;
    e.preventDefault();
    const rows = tagSearchRows();
    // The highlighted row, or the only one there is: with a single match left
    // there is nothing to choose between, and making someone press Down first
    // is a keystroke that answers a question they have already answered.
    const chosen = rows.find((r) => r.classList.contains("is-active")) ?? (rows.length === 1 ? rows[0] : null);
    if (chosen) {
      chosen.click();
      return;
    }
    const name = input.value.trim();
    if (name) spec.create?.(name);
  });
}

function tagSearchRows(): HTMLElement[] {
  return tagSearchPanel
    ? Array.from(tagSearchPanel.querySelectorAll<HTMLElement>(".kb-tag-dd-row"))
    : [];
}

/** Moves the highlight, wrapping at both ends and scrolling it into view. */
function moveTagSearchCursor(delta: number): void {
  const rows = tagSearchRows();
  if (rows.length === 0) return;
  const at = rows.findIndex((r) => r.classList.contains("is-active"));
  const next = at === -1 ? (delta > 0 ? 0 : rows.length - 1) : (at + delta + rows.length) % rows.length;
  rows.forEach((r, i) => r.classList.toggle("is-active", i === next));
  rows[next].scrollIntoView({ block: "nearest" });
}

function openTagSearch(input: HTMLInputElement, spec: TagPickSpec): void {
  const board = spec.board;

  const needle = input.value.trim().toLowerCase();
  const categories = board.tagCategories;

  // Rebuilt rather than filtered in place, so a tag added, retired or renamed
  // while this is open is right the next keystroke.
  const wasOpen = tagSearchPanel !== null;
  closeTagSearch();

  const panel = document.createElement("div");
  panel.className = "kb-tag-dropdown";
  tagSearchPanel = panel;

  let matches = 0;
  for (const category of categories) {
    /* A retired tag stays reachable for a card that already carries it (so it
       can be taken off) and is not offered to one that does not. Same rule the
       drill-down menu follows. */
    const catTags = board.tags.filter(
      (t) =>
        t.categoryId === category.id &&
        (t.status === "active" || spec.has(t.id)) &&
        (spec.offer === undefined || spec.offer(t) || spec.has(t.id)) &&
        (!needle ||
          t.name.toLowerCase().includes(needle) ||
          category.name.toLowerCase().includes(needle)),
    );
    if (catTags.length === 0) continue;

    const group = document.createElement("div");
    group.className = "kb-tag-dd-group";
    const head = document.createElement("span");
    head.className = "kb-tag-dd-head";
    head.textContent = category.name;
    group.appendChild(head);

    for (const tag of catTags) {
      matches += 1;
      const on = spec.has(tag.id);
      const rowBtn = document.createElement("button");
      rowBtn.type = "button";
      rowBtn.className = "kb-tag-dd-row";
      if (on) rowBtn.classList.add("is-on");

      const swatch = document.createElement("span");
      swatch.className = "kb-tag-dd-swatch";
      const color = tagColor(tag, categories);
      if (color) swatch.style.background = color;
      else swatch.classList.add("kb-tag-dd-swatch-none");
      rowBtn.appendChild(swatch);

      const name = document.createElement("span");
      name.className = "kb-tag-dd-name";
      name.textContent = tag.name;
      rowBtn.appendChild(name);

      if (on) {
        const tick = document.createElement("span");
        tick.className = "kb-tag-dd-tick";
        tick.textContent = "\u2713";
        rowBtn.appendChild(tick);
      }
      if (tag.status === "retired") {
        const badge = document.createElement("span");
        badge.className = "kb-tag-dd-retired";
        badge.textContent = "retired";
        rowBtn.appendChild(badge);
      }

      rowBtn.addEventListener("click", () => {
        spec.toggle(tag);
        closeTagSearch();
        spec.after();
      });
      group.appendChild(rowBtn);
    }
    panel.appendChild(group);
  }

  const typed = input.value.trim();
  if (matches === 0 && !typed) {
    const empty = document.createElement("span");
    empty.className = "kb-tag-dd-empty";
    empty.textContent = spec.emptyText ?? "This board has no tags yet.";
    panel.appendChild(empty);
  }
  if (typed && spec.create) {
    /* Offered whether or not something matched: "Bug" matching "Bugfix" is not
       a reason to refuse to make "Bug". An exact name that already exists is
       the one case where it would only produce a rejection, so it is left out. */
    const exists = board.tags.some((t) => t.name.toLowerCase() === typed.toLowerCase());
    if (!exists) {
      const create = document.createElement("button");
      create.type = "button";
      create.className = "kb-tag-dd-create";
      create.textContent = `Create "${typed}"\u2026`;
      create.addEventListener("click", () => spec.create!(typed));
      panel.appendChild(create);
    }
  }

  document.body.appendChild(panel);
  positionTagSearch(panel, input);
  // Keep the highlight where it was through a rebuild, so typing a letter does
  // not drop a selection the arrow keys just made.
  if (wasOpen) tagSearchRows()[0]?.classList.add("is-active");

  const controller = new AbortController();
  const { signal } = controller;
  // Pointerdown rather than click: a click that lands outside has already
  // moved focus by the time it fires, and a modal underneath would see it.
  document.addEventListener(
    "pointerdown",
    (e) => {
      const target = e.target as Node;
      if (panel.contains(target) || target === input) return;
      closeTagSearch();
    },
    { signal },
  );
  // Positioned in viewport coordinates against a layout that is about to
  // change, so it is closed rather than chased. Same rule as menu.ts.
  window.addEventListener("resize", closeTagSearch, { signal });
  document.getElementById("mainContent")?.addEventListener("scroll", closeTagSearch, { signal });
  panel.closest(".modal-body")?.addEventListener("scroll", closeTagSearch, { signal });
  tagSearchCleanup = () => controller.abort();
}

/** Under the input, flipped above it when there is no room below, and never
 *  wider than the window. */
function positionTagSearch(panel: HTMLElement, input: HTMLElement): void {
  const rect = input.getBoundingClientRect();
  const gap = 4;
  panel.style.minWidth = `${Math.max(rect.width, 200)}px`;
  const height = panel.offsetHeight;
  const below = window.innerHeight - rect.bottom - gap;
  const flip = height > below && rect.top - gap > below;
  panel.style.top = flip ? `${Math.max(gap, rect.top - gap - height)}px` : `${rect.bottom + gap}px`;
  panel.style.left = `${Math.max(gap, Math.min(rect.left, window.innerWidth - panel.offsetWidth - gap))}px`;
}

/** Opens the New Tag editor with the typed name filled in, and puts the tag on
 *  this card once it is saved. The card is closed for the trip (a modal opened
 *  from a modal replaces it rather than stacking) and reopened afterwards. */
function newTagFromCard(card: Card, name: string): void {
  const board = getBoard(card.boardId);
  if (!board) return;
  if (board.tagCategories.length === 0) {
    flash("Make a tag category first: a tag has to live in one.", "error");
    return;
  }
  closeTagSearch();
  const cardId = card.id;
  setTagEditHandoff(
    () => openCard(cardId),
    (tag) => {
      const live = getCard(cardId);
      if (!live || live.tagIds.includes(tag.id)) return;
      live.tagIds.push(tag.id);
      stampCard(live);
    },
  );
  _cardModal!.close({ handoff: true });
  openTagEditor(null, board.tagCategories[0].id, "board", board, name);
}

/** One drill-down per category, tags inside, ticked where the card wears one.
 *
 *  Built fresh on every open so a tag added in the manager and come back from
 *  is in the list without the card being reopened. */
export function cardTagMenu(
  card: Card,
  categories: TagCategory[],
  tags: Tag[],
  /** What to redraw after a tag goes on or comes off. The open card redraws
   *  its own tag row; the board's right-click menu redraws the board, because
   *  the card face carries the chips too. Defaults to the card modal's row,
   *  which is where this menu has always been used from. */
  afterChange: () => void = () => renderCardTags(card),
): MenuItem[] {
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
        keepOpen: true,
        onClick: () => {
          if (card.tagIds.includes(tag.id)) {
            card.tagIds = card.tagIds.filter((id) => id !== tag.id);
          } else {
            card.tagIds.push(tag.id);
          }
          stampCard(card);
          afterChange();
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
  // Same trip the gear beside the search box makes, through the same function.
  // It is offered in both places because a menu row is where it has always
  // been and muscle memory is worth more than tidiness.
  items.push({ label: "Manage Tags\u2026", onClick: () => openBoardTagsFromCard(card) });

  return items;
}