/* =============================================================================
   DATABASE SNAPSHOTS: the shared browse-and-restore list
   -----------------------------------------------------------------------------
   Game Stats is the only tool whose records live in the database, and this is
   how it shows its history. Written for more than one because the restore is
   already per tool: a snapshot holds the whole database, and a restore names
   its tool and copies only that tool's tables, so a second tool arriving later
   needs nothing here.

   HOURLY, NOT PER SAVE, and that is the one real difference from the sibling
   module. A snapshot copies the entire database, so taking one on every save
   would cost the whole dataset per keystroke. One is taken at the first change
   of each hour instead, which trades up to an hour of history for a cost that
   does not grow with what you own. Callers say so on screen through `note`.

   A restore is itself captured first, so restoring the wrong snapshot is undone
   by restoring the newest. Same rule the JSON snapshots have.

   The sibling module tool-backups.ts does the same job for the tools kept in
   JSON files, which is every other one. Those capture on EVERY save, because
   there the copy is the same size as the write that triggered it. The two look
   identical on screen and share their styling; they are separate because "which
   file was captured" and "which tables to copy" are genuinely different
   questions.
============================================================================= */

import { invoke } from "@tauri-apps/api/core";

export interface DbBackup {
  /** The snapshot folder's name, a UTC timestamp. */
  name: string;
  bytes: number;
}

/** A snapshot folder name ("2026-09-01_14-00-00") as local date and time. The
 *  name is UTC, so it is parsed as UTC and shown in local time; doing it by
 *  string surgery would show someone three time zones over the wrong hour with
 *  no way to tell. */
export function formatSnapshotName(name: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/.exec(name);
  if (!m) return name;
  const date = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])),
  );
  return Number.isNaN(date.getTime()) ? name : date.toLocaleString();
}

export function formatSnapshotBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export interface DbBackupListOptions {
  /** Which tool's tables a restore should replace. */
  toolId: string;
  /** Where the list is drawn. Emptied and rebuilt on every refresh. */
  host: HTMLElement;
  /** Optional element that gets a short "3 kept" readout. */
  summary?: HTMLElement | null;
  /** What this tool calls the thing being restored, e.g. "Boards and cards". */
  label: string;
  /** One line above the list, for saying something the list itself cannot.
   *  Used to explain that these snapshots are hourly rather than per save. */
  note?: string;
  /** Runs after a successful restore. The caller re-reads and redraws, because
   *  only the caller knows what it is showing. */
  onRestored: () => void | Promise<void>;
}

/**
 * Draws the snapshot list, newest first, and wires each row's Restore button.
 *
 * Built as elements rather than from a template string: these rows carry a
 * timestamp and a size, and building them this way means neither can ever be
 * read as markup.
 */
export async function renderDbBackups(opts: DbBackupListOptions): Promise<void> {
  const { host, summary } = opts;
  host.replaceChildren();

  if (opts.note) {
    const note = document.createElement("p");
    note.className = "kb-section-hint";
    note.textContent = opts.note;
    host.appendChild(note);
  }

  let items: DbBackup[];
  try {
    items = await invoke<DbBackup[]>("list_db_backups");
  } catch (err) {
    if (summary) summary.textContent = "unavailable";
    const error = document.createElement("p");
    error.className = "placeholder-text";
    error.textContent = `Couldn't read the snapshot folder: ${String(err)}`;
    host.appendChild(error);
    return;
  }

  if (summary) summary.textContent = items.length === 0 ? "none yet" : `${items.length} kept`;

  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "placeholder-text";
    empty.textContent =
      "No snapshots yet. One is taken the first time you change something in an hour, " +
      "capturing the state from before that change.";
    host.appendChild(empty);
    return;
  }

  items.forEach((item, index) => {
    const group = document.createElement("div");
    group.className = "tool-backup-group";

    const head = document.createElement("div");
    head.className = "tool-backup-head";
    const when = document.createElement("span");
    when.className = "tool-backup-when";
    when.textContent = formatSnapshotName(item.name);
    head.appendChild(when);
    if (index === 0) {
      const badge = document.createElement("span");
      badge.className = "setup-item-retired-badge";
      badge.textContent = "Newest";
      head.appendChild(badge);
    }
    group.appendChild(head);

    const row = document.createElement("div");
    row.className = "setup-item tool-backup-row";

    const what = document.createElement("span");
    what.className = "setup-item-name";
    what.textContent = opts.label;
    row.appendChild(what);

    const size = document.createElement("span");
    size.className = "tool-backup-size";
    size.textContent = formatSnapshotBytes(item.bytes);
    row.appendChild(size);

    const restore = document.createElement("button");
    restore.type = "button";
    restore.className = "settings-action-btn";
    restore.textContent = "Restore";
    restore.addEventListener("click", () => {
      void (async () => {
        restore.disabled = true;
        try {
          await invoke("restore_db_backup", { toolId: opts.toolId, name: item.name });
          await opts.onRestored();
          await renderDbBackups(opts);
        } catch (err) {
          // Said out loud rather than swallowed. A restore that fails silently
          // leaves the button looking pressed and the data looking restored.
          const failed = document.createElement("p");
          failed.className = "placeholder-text";
          failed.textContent = `Couldn't restore that snapshot: ${String(err)}`;
          host.appendChild(failed);
        } finally {
          restore.disabled = false;
        }
      })();
    });
    row.appendChild(restore);

    group.appendChild(row);
    host.appendChild(group);
  });
}
