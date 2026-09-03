/* =============================================================================
   TIMESTAMPS FOR NAMES
   -----------------------------------------------------------------------------
   One format for every name this app builds from a clock: YYYY-MM-DD_HH-MM-SS,
   in the user's LOCAL time. Files, folders, snapshot buckets, generated theme
   names, exported reports and templates.

   Why this shape. It sorts chronologically as a plain string, which is what lets
   the snapshot pruner order buckets by name instead of parsing dates. It reads
   in a file browser without translating a Unix timestamp. It has no colons, so
   it is legal in a Windows filename. And the underscore keeps the date and the
   time apart at a glance, which fourteen unbroken digits does not.

   Why local rather than UTC. This is a local, single-machine desktop tool. A
   name is read by the person who made it, next to the thing it names, so the
   only clock that means anything to them is the one on their wall.

   NOTE the difference between a NAME and a STORED INSTANT. This module is for
   names. A moment recorded inside a data file (exportedAt, updatedAt) stays an
   ISO 8601 UTC string, because that is a machine-readable instant that has to
   survive a timezone change and compare correctly against another one. Format
   those for reading at the point they are displayed, not at the point they are
   stored.

   This file imports NOTHING, on purpose. Same reason as dev-log.ts: a leaf
   module is reachable from anywhere without putting anything into an import
   cycle. Three tools had grown their own copy of the six-line padStart block
   before this existed.
============================================================================= */

const pad = (n: number): string => String(n).padStart(2, "0");

/** `YYYY-MM-DD_HH-MM-SS` in local time. The house format for anything named
 *  after the moment it was made. */
export function fileTimestamp(when: Date = new Date()): string {
  const date = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
  const time = `${pad(when.getHours())}-${pad(when.getMinutes())}-${pad(when.getSeconds())}`;
  return `${date}_${time}`;
}

/** `YYYY-MM-DD` in local time, for a name that only needs the day. */
export function fileDate(when: Date = new Date()): string {
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
}

/** A name in the house format read back for display, e.g. a snapshot bucket
 *  folder. Returns the name unchanged if it is not in that format.
 *
 *  Parsed as LOCAL, because that is what wrote it. It used to be parsed as UTC,
 *  correctly, back when the buckets were named in UTC; reading a local name as
 *  UTC now would put every snapshot in the list off by the whole timezone
 *  offset. */
export function formatFileTimestamp(name: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/.exec(name);
  if (!m) return name;
  const when = new Date(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6]),
  );
  return Number.isNaN(when.getTime()) ? name : when.toLocaleString();
}
