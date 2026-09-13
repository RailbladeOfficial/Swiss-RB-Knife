/* =============================================================================
   IDS
   -----------------------------------------------------------------------------
   One place that decides what an id is.

   Four tools had grown their own `makeId()` or `newId()`, all four one line and
   all four the same line. That is fine right up until the day the answer has to
   change, and then it is four edits and a search that has to find every spelling
   of the name.

   Imports nothing, so any module can pull it in without thinking about load
   order. Same reason as core/timestamp.ts.
============================================================================= */

/**
 * A fresh id for something the user just made: a card, an entry, a profile.
 *
 * `crypto.randomUUID()` rather than a counter, because these end up in files
 * that get merged, imported and restored from snapshots. Two boards created on
 * two machines, or a card restored beside the one that replaced it, must not be
 * able to collide, and a counter in a per-tool file cannot promise that.
 */
export function newId(): string {
  return crypto.randomUUID();
}
