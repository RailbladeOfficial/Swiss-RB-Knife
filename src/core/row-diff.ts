/* =============================================================================
   ROW DIFF: working out what actually changed since the last write
   -----------------------------------------------------------------------------
   Game Stats keeps its records in the database and writes the ones that
   changed rather than all of them. It is the only caller; Kanban and Time
   Tracker were in the database for a while and went back to JSON files, where a
   save rewrites the whole file and there is nothing to diff.

   The obvious way to know which records changed is to mark each one dirty as it
   is edited. Game Stats is not shaped for that: its records are edited in
   fifteen or so places, several of which rewrite fields in place across many
   records at once (renaming a player, merging games, splitting a round). Marking
   dirty at every one means auditing all of them and getting every one right, and
   the cost of missing one is an edit that silently never saves. That is the
   worst failure this app has.

   So it compares instead. Each record is serialized once after every write and
   kept; the next write serializes again and sends only what differs. It cannot
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
 * `previous` is what was last successfully written, as id -> serialized form.
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
