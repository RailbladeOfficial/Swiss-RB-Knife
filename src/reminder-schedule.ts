/* =============================================================================
   REMINDER SCHEDULE: shared scheduling math for the tool reminders
   -----------------------------------------------------------------------------
   Auto-Backup and Budget both nag on the same two schedules:

     interval  every N days since the thing last happened.
     monthly   on given days of the month (payday, the 1st, whenever the bills
               land), due if the thing hasn't happened since the most recent
               one passed.

   Only the baseline differs. Auto-Backup measures from the last completed
   backup, Budget from the last time its numbers changed. Everything else is
   identical, so it lives here rather than in either tool: two copies of
   date arithmetic this fiddly WILL drift, and the failure mode is a reminder
   that quietly never fires (or won't stop firing) on one tool only.

   Written against LOCAL time throughout. "The 15th" means the 15th where the
   user is, and a reminder that fires a day early in one timezone is a bug.
============================================================================= */

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Sorted, de-duplicated integers in 1–31; anything else is dropped. Used both
 *  for settings loaded off disk (hand-editable, so anything could be in there)
 *  and for what the user types into a Setup field. */
export function normalizeMonthDays(raw: unknown[]): number[] {
  const days = raw
    .map((d) => (typeof d === "number" ? Math.round(d) : NaN))
    .filter((d) => Number.isInteger(d) && d >= 1 && d <= 31);
  return [...new Set(days)].sort((a, b) => a - b);
}

/** Parses a free-text day-of-month field ("1, 15", "1 15", "1/15/31") into a
 *  clean day list. Splits on any run of non-digits, so whatever separator the
 *  user reaches for works. Returns [] when nothing usable is in there, callers
 *  decide what to fall back to. */
export function parseMonthDaysInput(text: string): number[] {
  return normalizeMonthDays(
    text
      .split(/[^0-9]+/)
      .filter((s) => s !== "")
      .map((s) => Number(s)),
  );
}

/** Local-midnight timestamp of day `day` in the given month, folded back to the
 *  month's last day when the month is shorter, so "the 31st" still fires in
 *  February. `month` may be out of range; Date normalizes it, which is how
 *  lastMonthlyTrigger steps back across a year boundary. */
function monthDayTimestamp(year: number, month: number, day: number): number {
  const lastDayOfMonth = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(day, lastDayOfMonth)).getTime();
}

/** The most recent configured day-of-month trigger at or before `now`, or -1
 *  when there are no configured days.
 *
 *  Checking this month and last month is enough: every configured day occurs
 *  once a month, so the latest one that has already passed is always in one of
 *  the two. */
export function lastMonthlyTrigger(days: number[], now: number): number {
  const ref = new Date(now);
  let latest = -1;
  for (const day of days) {
    for (const monthsBack of [0, 1]) {
      const t = monthDayTimestamp(
        ref.getFullYear(),
        ref.getMonth() - monthsBack,
        day,
      );
      if (t <= now && t > latest) latest = t;
    }
  }
  return latest;
}

/** Whether a reminder is owed, for either schedule.
 *
 *  `baselineMs` is when the thing last happened, a completed backup, a budget
 *  edit. A baseline of 0 (never) is the caller's business to handle before
 *  getting here; so is a baseline in the future, which this reads as "not due"
 *  rather than trying to guess what a backwards clock meant. */
export function isReminderDue(
  baselineMs: number,
  mode: "interval" | "monthly",
  intervalDays: number,
  monthDays: number[],
  now: number = Date.now(),
): boolean {
  if (baselineMs <= 0) return false;
  if (baselineMs > now) return false;

  return mode === "monthly"
    ? baselineMs < lastMonthlyTrigger(monthDays, now)
    : now - baselineMs >= intervalDays * DAY_MS;
}
