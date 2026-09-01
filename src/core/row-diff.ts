/* =============================================================================
   ROW DIFF: working out what actually changed since the last write
   -----------------------------------------------------------------------------
   The tools that moved to the database want to write the records that changed
   rather than all of them. The obvious way to know which those are is to mark
   each one dirty as it is edited, and for the Kanban that was right: every card
   mutation already went through one function, so there was one line to add.

   Time Tracker and Game Stats are not shaped like that. Their records are
   edited in fifteen or so places, several of which rewrite fields in place
   across many records at once (renaming an activity, merging entries, splitting
   one into three). Marking dirty at every one of those means auditing all of
   them and getting every one right, and the cost of missing one is an edit that
   silently never saves. That is the worst failure this app has.

   So they compare instead. Each record is serialised once after every write and
   kept; the next write serialises again and sends only what differs. It cannot
   miss an edit, because it never asks anyone to remember to declare one, and it
   costs one pass of JSON.stringify over records that are already in memory.
============================================================================= */

export interface RowDiff<T> {
  /** Records that are new or whose contents changed. */
  changed: T[];
  /** Ids that were present at the last write and are not here now. */
  deleted: string[];
  /** What to remember, once the write has actually landed. Deliberately NOT
   *  applied here: a diff whose write then failed must not be recorded as
   *  written, or the next save would think there was nothing to do. */
  next: Map<string, string>;
}

/**
 * Works out what to write.
 *
 * `previous` is what was last successfully written, as id -> serialised form.
 * Pass an empty map to treat everything as new, which is what a fresh load
 * followed by a first save should do.
 */
export function diffRows<T>(
  rows: readonly T[],
  key: (row: T) => string,
  previous: ReadonlyMap<string, string>,
): RowDiff<T> {
  const next = new Map<string, string>();
  const changed: T[] = [];

  for (const row of rows) {
    const id = key(row);
    // JSON.stringify over an object literal is stable within one runtime for a
    // given insertion order, and every one of these records is built from the
    // same literal every time, so the comparison is sound without sorting keys.
    const shape = JSON.stringify(row);
    next.set(id, shape);
    if (previous.get(id) !== shape) changed.push(row);
  }

  const deleted: string[] = [];
  for (const id of previous.keys()) {
    if (!next.has(id)) deleted.push(id);
  }

  return { changed, deleted, next };
}
