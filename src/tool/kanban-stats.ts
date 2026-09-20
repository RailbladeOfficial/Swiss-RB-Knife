/* =============================================================================
   KANBAN STATS: the two numbers screens
   -----------------------------------------------------------------------------
   Card Stats answers "what happened to this one card", Board Stats answers
   "what is happening to this board". Neither changes anything: they read the
   record and draw a table, which is what makes them a clean pair to keep
   away from the code that does change things.

   Together because they share their table builder and their formatting, and
   because splitting two screens that ask the same kind of question into two
   files would be filing by size rather than by subject.

   The usual loop with kanban.ts, and safe for the usual reason: nothing here
   reads a value from it as this file LOADS. See standards section 9.
============================================================================= */

/* The two modal handles live here rather than with the tool's others: only
   this file opens or assigns them, and a value can only be assigned by the
   file that declares it. kanban.ts READS both, to find the topmost open
   modal, which an import gives it. */

import { Modal } from "../modal/modal";
import { today } from "../core/timestamp";
import type {
  Board,
  Card,
} from "./kanban";
import {
  archivedCardsOnBoard,
  authorLabel,
  createdDay,
  dayDiff,
  describeDays,
  formatDate,
  furthestStage,
  getTag,
  isOverdue,
  liveCardsOnBoard,
  stageOrderWarning,
} from "./kanban";
import { buildTagChip } from "./kanban-card-face";
import { getCardModal, openCard } from "./kanban-card";

export let _cardStatsModal: Modal | null = null;
export let _boardStatsModal: Modal | null = null;

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
export let statsCardId: string | null = null;

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

export function openCardStats(card: Card): void {
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

export function mean(values: number[]): number | null {
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

export function openBoardStats(board: Board): void {
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
