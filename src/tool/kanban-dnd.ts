/* =============================================================================
   KANBAN DRAG AND DROP: moving a card or a column by hand
   -----------------------------------------------------------------------------
   The pointer half of rearranging a board. Everything here is listeners and
   the state one drag needs while it is in flight; where a card actually ends
   up is moveCardToColumn and resequence, which belong to the board and stay
   there.

   Its own file because a drag is a self-contained gesture: it starts, it
   tracks, it drops or it is abandoned, and nothing outside needs to know
   anything about it except how to arm an element. Three functions do that,
   one per kind of thing you can pick up, and they are the whole surface.

   The usual loop with kanban.ts, safe for the usual reason: nothing here
   reads a value from it as this file LOADS. See standards section 9.
============================================================================= */

import { flash } from "../core/shell";
import type {
  Board,
  Card,
  Column,
  Stage,
} from "./kanban-model";
import {
  clearCardSelection,
  columnsEl,
  getCard,
  getColumn,
  renderBoardView,
  resequence,
  rulesForColumn,
  selectedCardIds,
  selectedCards,
  stampOnArrival,
  touchBoard,
} from "./kanban";
import {
  STAGE_LABELS,
} from "./kanban-model";

export let dragCardId: string | null = null;
let dragColumnId: string | null = null;
/** The other selected cards travelling with the one under the pointer, in the
 *  order they were in. Empty for an ordinary one-card drag. */
let dragPassengerIds: string[] = [];

/**
 * DRAGGING A SELECTION.
 *
 * Picking up a card that is part of a selection picks up the whole selection,
 * because that is what selecting them was for. The card under the pointer is
 * the one the browser drags; the rest are moved to sit under it as it goes, so
 * the group stays together and lands where the pointer says.
 *
 * IN THE ORDER THEY WERE IN, not the order they were clicked. A selection built
 * by Ctrl+clicking around a column is still a set of cards with an arrangement
 * on the board, and scrambling that on arrival would make a multi-card drag
 * something you have to tidy up after.
 *
 * Dragging a card that is NOT in the selection drops the selection first: it is
 * an action on that one card, and carrying an unrelated selection into it is
 * how a drag moves eleven things you had forgotten were picked.
 */
export function attachCardDragHandlers(board: Board, el: HTMLElement, card: Card): void {
  el.addEventListener("dragstart", (e) => {
    // Without this the column underneath also starts dragging when its own
    // draggable flag happens to be set.
    e.stopPropagation();

    if (selectedCardIds.size > 1 && selectedCardIds.has(card.id)) {
      dragPassengerIds = selectedCards()
        .filter((c) => c.id !== card.id)
        .map((c) => c.id);
    } else {
      clearCardSelection(false);
      dragPassengerIds = [];
    }

    dragCardId = card.id;
    el.classList.add("kb-dragging");
    for (const id of dragPassengerIds) cardElement(id)?.classList.add("kb-dragging-with");
    e.dataTransfer?.setData("text/plain", card.id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  });

  el.addEventListener("dragend", (e) => {
    e.stopPropagation();
    el.classList.remove("kb-dragging");
    for (const id of dragPassengerIds) cardElement(id)?.classList.remove("kb-dragging-with");
    dragCardId = null;
    dragPassengerIds = [];
    commitCardOrderFromDom(board);
    // The selection survives the drag. Eleven cards just moved together and
    // the next thing you do is as likely to be about the same eleven.
    if (selectedCardIds.size > 0) renderBoardView();
  });
}

/** One card's element on the board, or null when it is not drawn. */
function cardElement(cardId: string): HTMLElement | null {
  return columnsEl.querySelector<HTMLElement>(`.kb-card[data-card-id="${CSS.escape(cardId)}"]`);
}

/** The first card in `body` whose midpoint is below `y`, i.e. the one the
 *  dragged card should be inserted before. null means "past the last one". */
function cardBeforePoint(body: HTMLElement, y: number): HTMLElement | null {
  /* The cards travelling WITH the dragged one are excluded too. They are being
     moved to follow it, so measuring the drop point against them would have
     the insertion point chase the group as it goes. */
  const others = Array.from(
    body.querySelectorAll<HTMLElement>(".kb-card:not(.kb-dragging):not(.kb-dragging-with)"),
  );
  for (const el of others) {
    const rect = el.getBoundingClientRect();
    if (y < rect.top + rect.height / 2) return el;
  }
  return null;
}

export function attachCardDropTarget(body: HTMLElement): void {
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

    /* The rest of the selection is parked directly under the card being
       dragged, in board order, so the group arrives as a block rather than
       scattered through whatever was already in the column. Done here rather
       than on drop because the drop point is only known from the last dragover
       the pointer produced. */
    let after: HTMLElement = dragged;
    for (const id of dragPassengerIds) {
      const passenger = cardElement(id);
      if (!passenger || passenger === dragged) continue;
      after.after(passenger);
      after = passenger;
    }
  });

  // Needed only so the browser accepts the drop at all; the work is in dragend.
  body.addEventListener("drop", (e) => e.preventDefault());
}

/** Reads the board's live DOM order back into the cards. Also applies the
 *  one side effect a move is allowed to have: stamping the stage date that
 *  the column a card lands in stamps. */
function commitCardOrderFromDom(board: Board): void {
  let changed = false;
  const stamped: Stage[] = [];
  /** Columns whose sort a drop just turned off, named so the toast can say so. */
  const unsorted: string[] = [];

  for (const body of columnsEl.querySelectorAll<HTMLElement>(".kb-column-body")) {
    const columnId = body.dataset.columnId;
    if (!columnId) continue;
    const column = getColumn(board, columnId);
    const ids = Array.from(body.querySelectorAll<HTMLElement>(".kb-card")).map(
      (el) => el.dataset.cardId ?? "",
    );

    /* A card dropped into a SORTED column is a statement about where that one
       card goes, and the sort would move it somewhere else the instant it
       landed. The drop wins and the sort comes off, out loud: silently
       ignoring the drop and silently keeping the sort both look like the drag
       failed. Checked before the loop below writes the new order, because that
       is what the sort would be fighting. */
    if (column && rulesForColumn(board, column).length > 0 && ids.includes(dragCardId ?? "")) {
      column.sort = [];
      unsorted.push(column.title);
    }

    ids.forEach((id, index) => {
      const card = getCard(id);
      if (!card) return;
      const movedColumn = card.columnId !== columnId;
      if (!movedColumn && card.order === index) return;

      changed = true;
      card.columnId = columnId;
      card.order = index;
      card.updatedAt = Date.now();

      if (movedColumn && column) {
        const stage = stampOnArrival(board, column, card);
        if (stage) stamped.push(stage);
      }
    });
  }

  if (unsorted.length > 0) {
    flash(`${unsorted.join(" and ")} is back to manual order.`);
    touchBoard(board);
    if (!changed) renderBoardView();
  }
  if (!changed) return;
  resequence(board.id);
  touchBoard(board);
  if (stamped.length === 1) {
    flash(`Stamped the card's ${STAGE_LABELS[stamped[0]]} date.`);
  } else if (stamped.length > 1) {
    flash(`Stamped ${stamped.length} cards' stage dates.`);
  }
  // Re-render rather than trusting the dragged DOM: the WIP badges, the
  // "nothing here yet" lines and the stage chips all changed underneath.
  renderBoardView();
}

/** Columns drag from their grip only. Setting `draggable` for the life of the
 *  press (rather than always) is what keeps a card drag from being swallowed
 *  by its column: only one of the two is ever draggable at a time. */
export function attachColumnDragHandlers(
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
