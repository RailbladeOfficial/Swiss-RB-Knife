/* =============================================================================
   DAYS BETWEEN DATES
   -----------------------------------------------------------------------------
   Picks two dates and breaks down the span between them.

   THE COUNTING RULE
   -----------------------------------------------------------------------------
   Everything here measures ELAPSED days. The start date is not counted.
   Aug 1 → Aug 8 is 7, because seven days elapse to get you from the 1st to the
   8th, and the same date twice is 0. That is the "how long until / how long
   since" reading, and it's the number the tool leads with. The other reading (
   counting both endpoints, so Aug 1–8 is 8 "days involved", which is what you
   want for booking a hotel or billing a stay) is shown as a clearly labelled
   secondary figure rather than left for the user to guess at.

   All arithmetic is done on plain YYYY-MM-DD strings parsed to UTC midnight.
   Using UTC rather than local time is deliberate: a local-time Date for a
   calendar date lands on a wall-clock midnight that daylight saving can shift
   by an hour, and a 23- or 25-hour "day" is enough to make a division round to
   the wrong integer. There is no time-of-day component in this tool at all, so
   there is nothing that UTC costs us.
============================================================================= */

import { flash } from "../shell";

/* =============================================================================
   TYPES
============================================================================= */

interface DateSpan {
  /** Elapsed whole days, always >= 0. The headline number. */
  days: number;
  /** True when the second date is earlier than the first. */
  reversed: boolean;
  /** Calendar-aware Y/M/D breakdown of the same span. */
  years: number;
  months: number;
  remainderDays: number;
  /** Whole weeks and the days left over. */
  weeks: number;
  weekRemainderDays: number;
  /** Days that fall Mon–Fri / Sat–Sun within the elapsed range. */
  weekdays: number;
  weekendDays: number;
}

/* =============================================================================
   ELEMENT REFS
============================================================================= */

let startInput: HTMLInputElement;
let endInput: HTMLInputElement;
let headlineEl: HTMLElement;
let headlineSubEl: HTMLElement;
let breakdownEl: HTMLElement;

/** Which reading leads. Deliberately not persisted, it's a way of looking at
 *  the answer, flipped per question, not a standing preference. Defaults to
 *  elapsed, which is the rule the rest of the tool is built on. */
let countMode: "elapsed" | "inclusive" = "elapsed";

const MS_PER_DAY = 86_400_000;

/* =============================================================================
   DATE MATH
============================================================================= */

/** Parses YYYY-MM-DD to a UTC-midnight timestamp, or NaN if unparseable. */
function parseDate(value: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return NaN;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const ts = Date.UTC(year, month - 1, day);
  const d = new Date(ts);
  // Rejects Feb 30 and friends, which Date.UTC would silently roll forward.
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return NaN;
  }
  return ts;
}

function toIsoDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Adds whole months, clamping the day to the target month's length, so one
 *  month after Jan 31 is Feb 28 (or Feb 29), not Mar 3. */
function addMonthsClamped(ts: number, n: number): number {
  const d = new Date(ts);
  const monthIndex = d.getUTCMonth() + n;
  const targetYear = d.getUTCFullYear() + Math.floor(monthIndex / 12);
  const targetMonth = ((monthIndex % 12) + 12) % 12;
  // Day 0 of the following month is the last day of this one.
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return Date.UTC(targetYear, targetMonth, Math.min(d.getUTCDate(), lastDay));
}

/** Calendar Y/M/D between two UTC-midnight timestamps, earlier first.
 *
 *  Defined as: the most whole months you can add to the start date without
 *  passing the end date, then whatever days are left over. Written this way
 *  rather than as the usual subtract-and-borrow because borrowing breaks when
 *  the day-of-month difference is larger than the month being borrowed from.
 *  Jan 31 → Mar 1 borrows February's 28 days against a 30-day deficit and
 *  lands on a NEGATIVE day count. Walking forward can't produce that: the
 *  remainder is a real distance between two real dates, so it's non-negative
 *  by construction. (Jan 31 → Mar 1 is "1 month, 1 day": one month lands on
 *  Feb 28, and Mar 1 is a day past it.) */
function calendarBreakdown(fromTs: number, toTs: number): { years: number; months: number; days: number } {
  const from = new Date(fromTs);
  const to = new Date(toTs);

  // Estimate from the raw month difference, then correct by at most one: the
  // estimate lands in the same calendar month as `to`, so it can only ever
  // overshoot by falling later within that month.
  let months =
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
  if (addMonthsClamped(fromTs, months) > toTs) months--;

  const anchor = addMonthsClamped(fromTs, months);
  return {
    years: Math.floor(months / 12),
    months: months % 12,
    days: Math.round((toTs - anchor) / MS_PER_DAY),
  };
}

/** Counts Sat/Sun in the elapsed range. The days AFTER the start date up to
 *  and including the end date, matching the elapsed-days rule the whole tool
 *  runs on. */
function countWeekendDays(fromTs: number, toTs: number): number {
  const totalDays = Math.round((toTs - fromTs) / MS_PER_DAY);
  if (totalDays <= 0) return 0;

  // Whole weeks contribute exactly two weekend days each; only the remainder
  // has to be walked, so a 40-year span is still a handful of iterations.
  const wholeWeeks = Math.floor(totalDays / 7);
  let weekend = wholeWeeks * 2;

  const walked = wholeWeeks * 7;
  for (let i = walked + 1; i <= totalDays; i++) {
    const dow = new Date(fromTs + i * MS_PER_DAY).getUTCDay();
    if (dow === 0 || dow === 6) weekend++;
  }
  return weekend;
}

/** The whole computation. Order-insensitive: a reversed pair reports the same
 *  span with `reversed` set, rather than a negative number or an error. */
export function computeSpan(startIso: string, endIso: string): DateSpan | null {
  const a = parseDate(startIso);
  const b = parseDate(endIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;

  const reversed = b < a;
  const from = reversed ? b : a;
  const to = reversed ? a : b;

  const days = Math.round((to - from) / MS_PER_DAY);
  const cal = calendarBreakdown(from, to);
  const weekendDays = countWeekendDays(from, to);

  return {
    days,
    reversed,
    years: cal.years,
    months: cal.months,
    remainderDays: cal.days,
    weeks: Math.floor(days / 7),
    weekRemainderDays: days % 7,
    weekdays: days - weekendDays,
    weekendDays,
  };
}

/* =============================================================================
   FORMATTING
============================================================================= */

function plural(n: number, unit: string): string {
  return `${n.toLocaleString()} ${unit}${n === 1 ? "" : "s"}`;
}

/** "1 year, 2 months, 3 days", skipping any zero component. Falls back to
 *  "0 days" when every component is zero rather than rendering nothing. */
function formatCalendar(span: DateSpan): string {
  const parts: string[] = [];
  if (span.years) parts.push(plural(span.years, "year"));
  if (span.months) parts.push(plural(span.months, "month"));
  if (span.remainderDays) parts.push(plural(span.remainderDays, "day"));
  return parts.length ? parts.join(", ") : "0 days";
}

function formatWeeks(span: DateSpan): string {
  if (span.weeks === 0) return plural(span.weekRemainderDays, "day");
  if (span.weekRemainderDays === 0) return plural(span.weeks, "week");
  return `${plural(span.weeks, "week")}, ${plural(span.weekRemainderDays, "day")}`;
}

/* =============================================================================
   RENDER
============================================================================= */

function renderRow(label: string, value: string, hint = ""): string {
  return `
    <div class="dbd-row">
      <span class="dbd-row-label">${label}</span>
      <span class="dbd-row-value">${value}</span>
      ${hint ? `<span class="dbd-row-hint">${hint}</span>` : ""}
    </div>`;
}

function render(): void {
  const span = computeSpan(startInput.value, endInput.value);

  if (!span) {
    headlineEl.textContent = "—";
    headlineSubEl.textContent = "Pick both dates to see the breakdown.";
    breakdownEl.innerHTML = "";
    return;
  }

  const inclusive = countMode === "inclusive";

  // The two readings differ by exactly one day, so only the headline and the
  // trailing row swap. Every other breakdown row stays keyed to the elapsed
  // span, which is the only one the calendar/weekday maths is defined on.
  headlineEl.textContent = plural(inclusive ? span.days + 1 : span.days, "day");

  if (span.reversed) {
    headlineSubEl.textContent = inclusive
      ? "counting both dates, and the end date is before the start date, so this counts backwards"
      : "elapsed, and the end date is before the start date, so this counts backwards";
  } else {
    headlineSubEl.textContent = inclusive
      ? "counting both the start and end dates"
      : "elapsed, not counting the start date";
  }

  breakdownEl.innerHTML = [
    renderRow("Calendar", formatCalendar(span)),
    renderRow("Weeks", formatWeeks(span)),
    renderRow("Weekdays", plural(span.weekdays, "day"), "Mon–Fri"),
    renderRow("Weekend days", plural(span.weekendDays, "day"), "Sat–Sun"),
    renderRow("Hours", plural(span.days * 24, "hour")),
    renderRow("Minutes", plural(span.days * 24 * 60, "minute")),
    inclusive
      ? renderRow("Days elapsed", plural(span.days, "day"), "start date not counted")
      : renderRow("Counting both dates", plural(span.days + 1, "day"), "for stays and bookings"),
  ].join("");
}

/* =============================================================================
   ACTIONS
============================================================================= */

function todayIso(): string {
  const now = new Date();
  // Local calendar date, then handled as UTC from here on, see the file
  // header. Going through toISOString() directly would hand back yesterday
  // for anyone west of UTC.
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
}

function shiftDate(which: "start" | "end", days: number): void {
  const input = which === "start" ? startInput : endInput;
  const base = parseDate(input.value);
  if (Number.isNaN(base)) {
    flash(`Set a valid ${which} date first`, "error");
    return;
  }
  input.value = toIsoDate(base + days * MS_PER_DAY);
  render();
}

function swapDates(): void {
  const a = startInput.value;
  startInput.value = endInput.value;
  endInput.value = a;
  render();
}

/** Puts both fields back to today. Deliberately silent: this also runs from
 *  initDaysBetween() to seed the inputs, so a toast in here would fire on every
 *  app launch. The Reset button announces itself at its own call site. */
function resetDates(): void {
  const today = todayIso();
  startInput.value = today;
  endInput.value = today;
  render();
}

/* =============================================================================
   INIT
============================================================================= */

export function initDaysBetween(): void {
  startInput = document.getElementById("dbd-start") as HTMLInputElement;
  endInput = document.getElementById("dbd-end") as HTMLInputElement;
  headlineEl = document.getElementById("dbd-headline")!;
  headlineSubEl = document.getElementById("dbd-headline-sub")!;
  breakdownEl = document.getElementById("dbd-breakdown")!;

  // Both default to today, so the tool opens showing its own rule: same date
  // twice is zero days.
  resetDates();

  [startInput, endInput].forEach((el) => el.addEventListener("change", render));
  [startInput, endInput].forEach((el) => el.addEventListener("input", render));

  document.getElementById("dbd-start-today")!.addEventListener("click", () => {
    startInput.value = todayIso();
    render();
  });
  document.getElementById("dbd-end-today")!.addEventListener("click", () => {
    endInput.value = todayIso();
    render();
  });
  document.getElementById("dbd-swap")!.addEventListener("click", swapDates);
  document.getElementById("dbd-reset")!.addEventListener("click", () => {
    resetDates();
    // Same wording the Dummy File Generator and TTS Repeater use for their own
    // reset buttons, so the action reads identically wherever it appears.
    flash("Tool reset", "success");
  });

  // Which field a nudge moves comes from its row's data-target, so the two
  // rows are the same markup twice over rather than two handlers.
  document.querySelectorAll<HTMLElement>(".dbd-shift-row").forEach((row) => {
    const target = row.dataset.target === "start" ? "start" : "end";
    row.querySelectorAll<HTMLButtonElement>(".dbd-shift-btn").forEach((btn) => {
      btn.addEventListener("click", () => shiftDate(target, Number(btn.dataset.days)));
    });
  });

  document.querySelectorAll<HTMLButtonElement>("#dbd-count-mode .toggle-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      countMode = btn.dataset.value === "inclusive" ? "inclusive" : "elapsed";
      btn.parentElement!.querySelectorAll<HTMLButtonElement>(".toggle-btn")
        .forEach((b) => b.classList.toggle("active", b === btn));
      render();
    });
  });
}
