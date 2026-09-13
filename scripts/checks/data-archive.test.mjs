/* =============================================================================
   WHOLE-FOLDER EXPORT AND IMPORT
   -----------------------------------------------------------------------------
   The Data tab replaces everything the app owns, which makes it the most
   destructive screen in the app and the one whose failures are worst.

   The archive's own rules (a manifest is required, an entry may not climb out
   of the folder, an archive may not arm itself, an empty one is refused) are
   unit-tested in Rust, where the zip can actually be built and unpacked. What
   is checked HERE is the wiring those rules hang off, which Rust cannot see:
   that the swap happens at the one moment it is safe, that consent is a
   separate act from unpacking, that nothing is ever deleted, and that the
   screen's controls exist.
============================================================================= */

import test from "node:test";
import assert from "node:assert/strict";
import { read, slice, htmlIds, filesUnder } from "./_source.mjs";

const rs = () => read("src-tauri/src/data_archive.rs");

/** The module's code with its comments and its #[cfg(test)] block blanked out.
 *
 *  Needed because several of these checks are "this module must not mention
 *  X", and the module's own header explains at length why it does not. Three of
 *  them failed on their own explanation before this existed. The test fixtures
 *  go too: they build a folder with a budget file in it on purpose. */
function code() {
  let text = rs()
    .replace(/\/\*[\s\S]*?\*\//g, (b) => b.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (b) => b.replace(/[^\n]/g, " "));
  const at = text.search(/#\[cfg\(test\)\]\s*mod\s+\w+\s*\{/);
  return at === -1 ? text : text.slice(0, at);
}

test("the folder swap happens before anything has opened a file", () => {
  /* The whole reason an import restarts the app is that the swap needs a
     moment when nothing is holding a file in either folder. setup() is that
     moment, and only its very top: the version judgement below reads the stamp
     the incoming folder brings with it, and the layout migration rearranges
     whatever is there. Judging or migrating the outgoing folder and then
     replacing it would answer a question about a folder that is gone. */
  const lib = read("src-tauri/src/lib.rs");
  const setupAt = lib.indexOf(".setup(|app| {");
  assert.notEqual(setupAt, -1, "setup() is not where it was");

  const swapAt = lib.indexOf("data_archive::take_pending_import", setupAt);
  const judgeAt = lib.indexOf("judge_data_folder(app.handle())", setupAt);
  const migrateAt = lib.indexOf("migrate_data_layout(app.handle())", setupAt);

  assert.notEqual(swapAt, -1, "nothing applies a staged import at startup");
  assert.ok(swapAt < judgeAt, "the folder is judged before the import that replaces it");
  assert.ok(swapAt < migrateAt, "the layout migration runs before the import that replaces it");
});

test("unpacking an archive is not the same as agreeing to it", () => {
  /* An archive is unpacked BEFORE the user is asked anything, so that a bad one
     is refused while the live folder is still untouched. That leaves a full
     copy of somebody's data staged before they have said yes, so the swap must
     not key off "is there a staging folder": declining "replace all of your
     data" would then have replaced all of their data at the next launch.

     It keys off a marker instead, which only the restart writes. */
  const src = rs();
  assert.match(src, /const READY_MARKER/, "there is no marker separating consent from staging");

  const swap = slice("src-tauri/src/data_archive.rs", "pub fn take_pending_import", "\n}");
  assert.match(
    swap,
    /if !marker\.is_file\(\) \{\s*return None;/,
    "the swap runs on an unpacked folder without checking anyone agreed to it",
  );

  const restart = slice("src-tauri/src/data_archive.rs", "pub fn restart_for_import", "\n}");
  assert.match(restart, /fs::write\(staging\.join\(READY_MARKER\)/, "nothing ever arms an import");

  // Written in exactly one place, or "consent" stops meaning anything.
  const writers = [...src.matchAll(/fs::write\([^)]*READY_MARKER/g)].length;
  assert.equal(writers, 1, "the arming marker is written from more than one place");

  // And an archive cannot carry one, which would arm itself on unpack.
  const unpack = slice("src-tauri/src/data_archive.rs", "fn unpack<", "\n}");
  assert.match(unpack, /name == READY_MARKER/, "an archive can smuggle in the arming marker");
});

test("an import replaces the folder by renaming it, never by deleting it", () => {
  /* The state an import replaced is the only way back from an import that
     turned out to be the wrong archive. A remove_dir_all on the live folder
     would make this the one action in the app with no undo at all. */
  const swap = slice("src-tauri/src/data_archive.rs", "pub fn take_pending_import", "\n}");
  assert.match(swap, /fs::rename\(&root, &replaced\)/, "the live folder is not set aside");

  /* There is exactly ONE delete in here and it is the empty-folder case:
     data_root() creates the folder as it resolves it, so a first run would
     otherwise leave an empty "replaced" folder behind that looks like a backup
     and is not. It is gated on there being nothing to keep, and that gate is
     the whole safety property. */
  /* Counted by WHAT is deleted, not how many deletes there are. The other one
     is the arming marker, which is removed before the swap so it cannot land
     inside the live folder and re-arm a later launch. */
  const rootDeletes = [...swap.matchAll(/remove_(?:dir_all|file)\(&(\w+)\)/g)].map((m) => m[1]);
  assert.deepEqual(
    rootDeletes.filter((what) => what !== "marker"),
    ["root"],
    "the swap deletes something other than the arming marker and the empty folder",
  );
  const guarded = /if had_data \{[\s\S]*?\} else \{[^}]*remove_dir_all\(&root\)/.test(swap);
  assert.ok(guarded, "the swap deletes the data folder outside the empty-folder branch");
  assert.match(
    swap,
    /let had_data = fs::read_dir\(&root\)/,
    "nothing checks whether the folder being replaced had anything in it",
  );
  assert.match(swap, /fs::rename\(&staging, &root\)/, "the staged folder is not moved into place");

  /* And it can never leave BOTH gone. If setting the live folder aside fails,
     nothing has happened; if moving staging in fails, the live folder goes
     straight back. */
  assert.match(
    swap,
    /let _ = fs::rename\(&replaced, &root\);/,
    "a half-failed swap leaves no data folder at all",
  );
});

test("the staging folder is a sibling of the data folder, not a child", () => {
  // The swap renames the data folder itself, so a staging folder inside it
  // would be renamed away with the thing it is supposed to replace.
  const beside = slice("src-tauri/src/data_archive.rs", "fn sibling(", "\n}");
  assert.match(beside, /root\.parent\(\)/, "a sibling path is not resolved from the parent");
  assert.ok(
    !beside.includes("root.join("),
    "the fallback puts the staging folder INSIDE the folder the swap renames",
  );

  // Both siblings are named after the data folder rather than being bare, so
  // they sit beside it in %APPDATA%\Roaming instead of looking like strays.
  const src = rs();
  assert.match(src, /const INCOMING_SUFFIX: &str = "\.srbk-incoming"/, "the staging folder is not named after the data folder");
  assert.match(src, /const REPLACED_SUFFIX: &str = "\.srbk-replaced-"/, "a set-aside folder is not named after the data folder");
  assert.match(
    slice("src-tauri/src/data_archive.rs", "fn incoming_dir", "\n}"),
    /sibling\(&data_root\(app\), INCOMING_SUFFIX\)/,
    "the staging folder does not go through the shared sibling helper",
  );
});

test("an import is deliberately allowed while the data folder is frozen", () => {
  /* A frozen folder is one written by a NEWER build, and every write is
     refused until that is resolved. Restoring an older export is exactly how
     somebody resolves it, so refusing here would turn the guard into a trap.
     Written down because the obvious review comment is "why is there no
     deny_if_frozen on the most destructive command in the app". */
  assert.ok(
    !code().includes("deny_if_frozen"),
    "the import is guarded by the freeze, which makes a newer folder unrecoverable",
  );
  // And the reason is written down, in the prose this check is careful to skip.
  assert.match(rs(), /DELIBERATELY NOT GUARDED BY `deny_if_frozen`/, "the reason is not written down");
});

test("the archive names itself, and refuses one from a newer build", () => {
  const src = rs();
  assert.match(src, /const MANIFEST: &str/, "an archive carries nothing identifying it");
  assert.match(src, /manifest\.app != APP_TAG/, "any zip at all is accepted");
  assert.match(
    src,
    /manifest\.schema > DATA_SCHEMA_VERSION/,
    "an archive from a newer build is unpacked rather than refused",
  );
  // The same constant the folder's own stamp is judged against, so the two
  // cannot drift into disagreeing about what this build understands.
  assert.match(src, /use crate::\{[^}]*DATA_SCHEMA_VERSION/, "the archive judges against its own number");
});

test("the Data tab has the controls the module expects", () => {
  // Every id the module reaches for without an optional chain has to exist, or
  // the tab throws on open and shows nothing.
  const ids = htmlIds();
  for (const id of [
    "dataExportBtn",
    "dataImportBtn",
    "dataFolderOpenBtn",
    "dataFolderSummary",
    "dataFolderPath",
    "dataImportPending",
    "dataImportPendingBadge",
    "dataImportRestartBtn",
    "dataImportDiscardBtn",
  ]) {
    assert.ok(ids.has(id), `the Data tab has no #${id}`);
  }
});

test("the per-tool export is gone, all of it", () => {
  /* Seven hand-written gather/apply pairs, a dropdown, a per-tool badge and a
     bespoke sealing format for the one tool that encrypts. Replaced by a zip of
     the folder, which needs none of them. Checked because a leftover half of it
     is dead code that still looks like a feature. */
  const leftovers = filesUnder("src", ".ts")
    .filter((f) => read(f).includes("registerTransferable"))
    .concat(
      filesUnder("src-tauri/src", ".rs").filter((f) => {
        // Stripped of comments for the same reason as code() above: the new
        // module's header explains what it replaced, by name.
        const text = read(f)
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/\/\/[^\n]*/g, "");
        return text.includes("export_tool_json") || text.includes("budget_seal_export");
      }),
    );
  assert.deepEqual(leftovers, [], "these still carry part of the per-tool export");

  // And the screen is the folder's, not a tool's.
  const html = read("index.html");
  const tab = html.slice(
    html.indexOf('id="settingsTabData"'),
    html.indexOf('id="sidebarEditBackdrop"'),
  );
  assert.ok(!tab.includes("dataToolSelect"), "the Data tab still lists tools");
});

test("an encrypted tool's files are copied, never read", () => {
  /* The reason this rework settled the encryption question. The old path
     gathered through the tool, which meant decrypting into memory and writing
     budget records in the clear from a tool the user had deliberately locked.
     Copying bytes cannot do that, and the archive has no idea which files are
     which. The check is that nothing here knows about a tool at all. */
  const src = code();
  for (const tool of ["budget", "kanban", "game_stats", "time_tracker", "decrypt", "rusqlite"]) {
    assert.ok(
      !src.includes(tool),
      `the archive knows about ${tool}, so it is reading files rather than copying them`,
    );
  }
  // What it DOES do is walk and copy, which is the whole of it.
  assert.match(src, /fn collect_files/, "the archive does not walk the folder");
  assert.match(src, /std::io::copy/, "the archive does not copy file contents verbatim");
});
