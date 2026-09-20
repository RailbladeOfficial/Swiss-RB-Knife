/* =============================================================================
   KANBAN CARD FACE: a card as the board draws it
   -----------------------------------------------------------------------------
   The tile. Its title, its chips, its cover picture, its due date, its
   progress, its colors, and the menu you get by right-clicking it.

   THE OTHER HALF OF A CARD, and the pairing is the point:

     kanban-card-face.ts   a card sitting on the board, drawn hundreds at a
                           time, read-only until you touch it
     kanban-card.ts        one card opened, every field editable

   Those are different jobs with different costs. The face is redrawn for
   every card on every render, so what it does per card matters; the modal
   exists once and can afford to be thorough. Keeping them apart stops the
   two being read as one thing.

   Only three names cross back into kanban.ts (buildCardEl, buildTagChip,
   paintTagChip) and nothing here writes the board's state, which is why this
   was the cleanest seam left in the file.

   The usual loop with kanban.ts, safe for the usual reason: nothing here
   reads a value from it as this file LOADS. See standards section 9.
============================================================================= */

import { flash } from "../core/shell";
import { attachMenu, type MenuItem } from "../menu/menu";
import { richTextToPlain } from "../core/rich-text";
import type {
  Board,
  Card,
  CardAuthor,
  Tag,
  TagCategory,
} from "./kanban";
import {
  EFFORTS,
  PRIORITIES,
  applySolidColor,
  authorLabel,
  boards,
  cards,
  clearCardSelection,
  currentBoardId,
  currentView,
  dayDiff,
  deleteCard,
  describeDays,
  duplicateCard,
  effective,
  effortLabel,
  formatDate,
  furthestStage,
  getBoard,
  handleCardClick,
  isOverdue,
  kbConfirm,
  kbSettings,
  moveCardToBoard,
  moveCardToColumn,
  orderedCardTags,
  priorityLabel,
  pruneCardSelection,
  readableTextOn,
  renderAll,
  reopenQuickAdd,
  requestDeleteCard,
  resolveCardColor,
  selectedCardIds,
  selectedCards,
  stampCard,
  tagColor,
  trimTo,
} from "./kanban";
import { boardConfig, type AgentToken } from "./kanban-agents";
import { agentConfig } from "./kanban-agents-tab";
import { attachCardDragHandlers } from "./kanban-dnd";
import { openCardStats } from "./kanban-stats";
import {
  allAttachments,
  cardTagMenu,
  openCard,
  openCardColor,
  renderCardModal,
  type KbCardTab,
} from "./kanban-card";

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

export function buildCardEl(board: Board, card: Card, todayStr: string): HTMLElement {
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

  /* EFFORT SITS BESIDE PRIORITY, in the same strip and the same shape, because
     the two are read together: "urgent and small" and "urgent and huge" are
     different plans and a face showing one without the other hides that.

     OUTLINED RATHER THAN FILLED. Two solid chips side by side compete, and
     priority is the one that should win a glance across a full column. Effort
     carries its color as a border and its text, so it is legible without
     shouting. Hidden at "none", like priority: an unset estimate is not an
     estimate of nothing. */
  if (card.effort !== "none") {
    const chip = document.createElement("span");
    chip.className = "kb-card-effort";
    chip.textContent = effortLabel(card.effort);
    chip.title = `Effort: ${effortLabel(card.effort)}`;
    // Only the text color is set: the border reads currentColor, so one value
    // paints both and they cannot drift apart.
    chip.style.color = kbSettings.effortColors[card.effort];
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

  /* What the card is carrying that its face cannot show: a description, files,
     comments. Shown whenever there are any, with no preference behind it:
     unlike tags or subtasks, these say nothing about the work itself, they say
     there is something inside this card you cannot see from here, which is the
     one thing a card face cannot afford to keep quiet about. */
  const hasDescription = card.description.trim().length > 0;
  const attachmentCount = allAttachments(card).length;
  if (hasDescription || attachmentCount > 0 || card.comments.length > 0) {
    const meta = document.createElement("div");
    meta.className = "kb-card-meta";
    /* `tab` is what makes an item clickable. The description and attachments
       do not pass one, because they have no tab of their own: they are blocks
       on Basic, which is where the card opens anyway. A null `count` draws the
       icon alone, for a thing a card has one of or none. */
    const item = (svg: string, count: number | null, title: string, tab?: KbCardTab): void => {
      const span = document.createElement("span");
      span.className = tab ? "kb-card-meta-item kb-card-count-link" : "kb-card-meta-item";
      span.title = title;
      span.innerHTML = svg;
      if (count !== null) {
        const label = document.createElement("span");
        label.textContent = String(count);
        span.appendChild(label);
      }
      if (tab) {
        span.addEventListener("click", (e) => {
          e.stopPropagation();
          openCard(card.id, tab);
        });
      }
      meta.appendChild(span);
    };
    if (hasDescription) {
      // A notepad: a page with two binder rings and three lines of writing.
      item(
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
          'stroke-linecap="round" stroke-linejoin="round">' +
          '<rect x="5" y="4" width="14" height="18" rx="2" />' +
          '<path d="M9 2v4M15 2v4M9 11h6M9 15h6M9 19h3" />' +
          "</svg>",
        null,
        "This card has a description",
      );
    }
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

  if (selectedCardIds.has(card.id)) el.classList.add("kb-card-selected");

  el.addEventListener("click", (e) => {
    // A selection gesture never opens the card: the point of Ctrl+clicking six
    // of them is to act on six, not to end up looking at the last one.
    if (handleCardClick(card, e)) return;
    openCard(card.id);
  });
  /* Right-clicking INSIDE a selection acts on the selection; right-clicking
     anywhere else drops it and behaves as it always did. Silently acting on a
     selection you had forgotten about is the failure worth avoiding here, and
     the menu says how many it is about to touch. */
  attachMenu(el, () =>
    selectedCardIds.size > 1 && selectedCardIds.has(card.id)
      ? bulkCardMenu(selectedCards())
      : (clearCardSelection(), boardCardMenu(card)),
  );
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
export function cardOwnerMenu(card: Card): MenuItem[] {
  return ownerChoices(card.boardId, currentExternalLabel(card), (owner) => setCardOwner(card, owner));
}

/** The owner choices themselves, shared by one card and by a selection, so the
 *  two can never offer different people. `apply` is what picking one does. */
function ownerChoices(
  boardId: string,
  externalDefault: string,
  apply: (owner: CardAuthor | undefined) => void,
): MenuItem[] {
  const items: MenuItem[] = [
    {
      label: "You",
      keepOpen: true,
      onClick: () => apply(undefined),
    },
  ];

  for (const token of agentConnectionsForBoard(boardId)) {
    items.push({
      label: token.label,
      keepOpen: true,
      onClick: () => apply({ kind: "agent", by: token.id, label: token.label }),
    });
  }

  /* NOT keepOpen, unlike the rows above it: this one puts a prompt on screen,
     and a menu left standing behind a dialog is a menu about something you
     can no longer see. */
  items.push({
    label: "External\u2026",
    onClick: () => {
      /* Free text, because the person it names is not a user of this app and
         there is no list to pick them from. Prompt rather than a modal of its
         own: it is one short string, and a modal would be a screen to say a
         name on. */
      const who = window.prompt("Who asked for this card?", externalDefault);
      if (who === null) return;
      apply({ kind: "external", label: trimTo(who, 80) });
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
/**
 * The right-click menu for a selection, rather than for one card.
 *
 * Every entry is the plural of one that is already on the single-card menu, and
 * nothing new: a menu that grows options only reachable by selecting several
 * cards would be a second way to do things, discovered by accident.
 *
 * What is deliberately NOT here: Open Card, Add Card Below, Card Color and Card
 * Stats. Each of those opens a screen about one card, and the honest plural of
 * "open this" is not "open eleven of them".
 *
 * Every action re-reads the selection through `selectedCards()` at the moment
 * it runs, so a card deleted between opening the menu and clicking an entry is
 * simply not in the list rather than a stale object written back to the board.
 */
/* Escape drops the selection, which is the one gesture every list in every
   program agrees on. Bound once, on the document, and only doing anything when
   there IS a selection, so it never competes with a modal's own Escape. */
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || selectedCardIds.size === 0) return;
  if (currentView !== "board") return;
  e.preventDefault();
  clearCardSelection();
});

function bulkCardMenu(selection: Card[]): MenuItem[] {
  const count = selection.length;
  const boardId = selection[0]?.boardId ?? currentBoardId;
  const board = getBoard(boardId);

  /** Runs `apply` over everything still selected, then redraws once. Once,
   *  because redrawing per card on a selection of forty is forty full rebuilds
   *  of every column. The selection stays, so a second change to the same
   *  cards is one right-click rather than re-selecting them all. */
  const overSelection = (apply: (card: Card) => void, done: (n: number) => void): void => {
    const live = selectedCards();
    for (const card of live) apply(card);
    pruneCardSelection();
    renderAll();
    done(live.length);
  };

  const priorityItems: MenuItem[] = PRIORITIES.map((p) => ({
    label: priorityLabel(p),
    keepOpen: true,
    onClick: () =>
      overSelection(
        (card) => {
          card.priority = p;
          stampCard(card);
        },
        (n) => flash(`${n} cards set to ${priorityLabel(p)}.`),
      ),
  }));

  const effortItems: MenuItem[] = EFFORTS.map((eff) => ({
    label: effortLabel(eff),
    keepOpen: true,
    onClick: () =>
      overSelection(
        (card) => {
          card.effort = eff;
          stampCard(card);
        },
        (n) => flash(`${n} cards set to ${effortLabel(eff)}.`),
      ),
  }));

  /* Only the columns on the board the selection is on. A selection can only
     ever be on one board, because it is cleared when the board changes. */
  const columnItems: MenuItem[] = (board?.columns ?? []).map((col) => ({
    label: col.title,
    onClick: () =>
      overSelection(
        (card) => moveCardToColumn(card, col.id),
        (n) => flash(`${n} cards moved to ${col.title}.`),
      ),
  }));

  const boardItems: MenuItem[] = boards
    .filter((b) => b.id !== boardId && b.columns.length > 0)
    .map((b) => ({
      label: b.name,
      onClick: () =>
        overSelection(
          (card) => moveCardToBoard(card, b.id),
          (n) => flash(`${n} cards moved to ${b.name}.`),
        ),
    }));

  /* TAGS OVER THE WHOLE SELECTION. Filing eleven cards under one tag was the
     one thing this menu could not do, so it was eleven right-clicks or eleven
     card openings, which is exactly the work a multi-select exists to avoid.

     Shaped like the single-card tag menu (one drill-down per category, a tick
     beside what is already on) with one addition it needs and that one does
     not: a selection can be PARTLY tagged, so the mark has three states, and
     clicking a partial one puts the tag on everything rather than taking it
     off, which is what someone reaching for a half-applied tag means. */
  const tagItems: MenuItem[] = [];
  {
    const categories = board?.tagCategories ?? [];
    const boardTags = board?.tags ?? [];
    for (const category of categories) {
      /* A retired tag is still offered when some of the selection carries it,
         so a bulk action can take one OFF; it is never offered as something to
         put on. Same rule the card menu follows, read across a set. */
      const catTags = boardTags.filter(
        (t) =>
          t.categoryId === category.id &&
          (t.status === "active" || selection.some((c) => c.tagIds.includes(t.id))),
      );
      if (catTags.length === 0) continue;

      tagItems.push({
        label: category.name,
        submenu: catTags.map((tag) => {
          const on = selection.filter((c) => c.tagIds.includes(tag.id)).length;
          /* Three states, not two: a figure space for none, a tick for all,
             and a dash for some, all the same width so the names line up. */
          const mark = on === 0 ? " " : on === count ? "✓" : "–";
          return {
            label: `${mark} ${tag.name}${on > 0 && on < count ? ` (${on} of ${count})` : ""}`,
            swatch: tagColor(tag, categories) ?? undefined,
            keepOpen: true,
            onClick: () => {
              // Re-read at click time, not from `selection`: the count that
              // decided the mark was taken when the menu was built.
              const live = selectedCards();
              const removing = live.length > 0 && live.every((c) => c.tagIds.includes(tag.id));
              overSelection(
                (card) => {
                  if (removing) card.tagIds = card.tagIds.filter((id) => id !== tag.id);
                  else if (!card.tagIds.includes(tag.id)) card.tagIds.push(tag.id);
                  else return; // already correct, so nothing to stamp
                  stampCard(card);
                },
                (n) =>
                  flash(
                    removing
                      ? `"${tag.name}" taken off ${n} cards.`
                      : `"${tag.name}" put on ${n} cards.`,
                  ),
              );
            },
          };
        }),
      });
    }

    if (tagItems.length > 0) {
      tagItems.push({ separator: true });
      tagItems.push({
        label: "Clear All Tags",
        danger: true,
        disabled: selection.every((c) => c.tagIds.length === 0),
        onClick: () =>
          overSelection(
            (card) => {
              if (card.tagIds.length === 0) return;
              card.tagIds = [];
              stampCard(card);
            },
            (n) => flash(`Tags cleared from ${n} cards.`),
          ),
      });
    }
  }

  /* The External prompt is prefilled only when every selected card already
     names the same outside person; otherwise there is no one name to offer. */
  const externals = new Set(selection.map((c) => currentExternalLabel(c)));
  const ownerItems = ownerChoices(boardId, externals.size === 1 ? [...externals][0] : "", (owner) =>
    overSelection(
      (card) => {
        card.createdBy = owner;
        stampCard(card);
      },
      (n) => flash(`${n} cards set to ${authorLabel(owner)}.`),
    ),
  );

  return [
    // Not clickable: a heading, so the menu says what it is about to act on.
    { label: `${count} cards selected`, disabled: true },
    { label: "Priority", submenu: priorityItems },
    { label: "Effort", submenu: effortItems },
    ...(tagItems.length > 0 ? [{ label: "Tags", submenu: tagItems }] : []),
    { label: "Owner", submenu: ownerItems },
    ...(columnItems.length > 1 ? [{ label: "Move to Column", submenu: columnItems }] : []),
    ...(boardItems.length > 0 ? [{ label: "Move to Board", submenu: boardItems }] : []),
    {
      label: "Duplicate Cards",
      onClick: () => {
        /* Read once and copied from that list, not from selectedCards() inside
           the loop: each copy joins `cards`, and a loop re-reading the board
           would find its own output and duplicate forever. */
        const live = selectedCards();
        let made = 0;
        for (const card of live) if (duplicateCard(card)) made += 1;
        // The originals stay selected, not the copies.
        pruneCardSelection();
        renderAll();
        flash(made === live.length ? `Duplicated ${made} cards.` : `Duplicated ${made} of ${live.length} cards.`);
      },
    },
    {
      label: "Copy Titles",
      onClick: () => {
        const text = selectedCards().map((c) => c.title).join("\n");
        void navigator.clipboard
          .writeText(text)
          .then(() => flash(`${selection.length} titles copied.`))
          .catch(() => flash("Couldn't reach the clipboard.", "error"));
      },
    },
    {
      label: "Archive Cards",
      onClick: () =>
        overSelection(
          (card) => {
            card.archived = true;
            stampCard(card);
          },
          (n) => flash(`${n} cards archived.`),
        ),
    },
    {
      label: "Delete Cards",
      danger: true,
      onClick: () => {
        const live = selectedCards();
        const remove = (): void => {
          for (const card of live) deleteCard(card);
          pruneCardSelection();
          renderAll();
          flash(`${live.length} cards deleted.`);
        };
        /* ALWAYS confirmed, whatever the per-card setting says. That setting is
           about the friction of deleting one card you are looking at; this is
           several at once, some of them scrolled out of view, and it names the
           count because that is the number worth checking before agreeing. */
        kbConfirm(
          {
            title: `Delete ${live.length} cards?`,
            message:
              `${live.length} cards and everything on them go for good. ` +
              `Archive instead if you only want them off the board.`,
            confirmLabel: `Delete ${live.length}`,
            /* Nothing to go back to, and said so rather than left out: this
               came off a right-click on the board, so dismissing it lands on
               the board, which is where it started. */
            reopen: undefined,
          },
          remove,
        );
      },
    },
  ];
}

function boardCardMenu(card: Card): MenuItem[] {
  const board = getBoard(card.boardId);

  const priorityItems: MenuItem[] = PRIORITIES.map((p) => ({
    label: priorityLabel(p),
    disabled: card.priority === p,
    keepOpen: true,
    onClick: () => {
      card.priority = p;
      stampCard(card);
      renderAll();
    },
  }));

  /* Effort and Tags are here because the SELECTION menu has them, and a menu
     that can do more to eleven cards than to one reads as a bug in whichever
     of the two you found second. Both are on the card face, so both are things
     you can look at and want to change without opening anything. */
  const effortItems: MenuItem[] = EFFORTS.map((eff) => ({
    label: effortLabel(eff),
    disabled: card.effort === eff,
    keepOpen: true,
    onClick: () => {
      card.effort = eff;
      stampCard(card);
      renderAll();
    },
  }));

  // Same shape as the card modal's tag menu, one drill-down per category with
  // a tick beside what is on, because it is the same question asked from a
  // different place.
  const tagItems: MenuItem[] = board
    ? cardTagMenu(card, board.tagCategories, board.tags, () => renderAll())
    : [];

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

  const column = board?.columns.find((c) => c.id === card.columnId);

  return [
    { label: "Open Card…", onClick: () => openCard(card.id) },
    /* Straight under this one, rather than at an end of the column. Writing a
       list in order is the common case and the two existing entry points both
       land somewhere else, so it was always a card added and then dragged. */
    ...(board && column
      ? [{
          label: "Add Card Below",
          onClick: () => reopenQuickAdd(board, column, { below: card.id }),
        }]
      : []),
    { label: "Priority", submenu: priorityItems },
    { label: "Effort", submenu: effortItems },
    ...(tagItems.length > 0 ? [{ label: "Tags", submenu: tagItems }] : []),
    { label: "Owner", submenu: cardOwnerMenu(card) },
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
      // No reopen: the card was never opened, so canceling the confirm has
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
export function paintTagChip(el: HTMLElement, color: string | null, filled: boolean): void {
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
export function buildTagChip(
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
