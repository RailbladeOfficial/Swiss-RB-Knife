/* =============================================================================
   TIMESTAMPS IN NAMES
   -----------------------------------------------------------------------------
   One format for every name this app builds from a clock, YYYY-MM-DD_HH-MM-SS,
   in local time. Four places had drifted off it before these existed: the
   Auto-Backup log filenames and the Image CCR output folder were fourteen
   unbroken digits, the Dummy File Generator folder used a dash where the
   underscore goes, and the saved random theme was compact digits under a comment
   calling itself human-readable.

   None of that breaks anything, which is exactly why it drifted: a filename is
   never read back by the code that wrote it, so nothing anywhere complains. The
   only thing that notices is the person looking at the folder.

   The timezone half matters more. Snapshot bucket folders are ordered by sorting
   their names, so a folder holding both UTC-named and local-named buckets sorts
   wrongly, and west of UTC that means the pruner deletes the newest snapshot it
   just took. These pin the naming to the local clock at both ends: the Rust that
   writes a bucket name, and the TypeScript that reads one back for display.
============================================================================= */

import test from "node:test";
import assert from "node:assert/strict";
import { read, filesUnder } from "./_source.mjs";

const HOUSE_FORMAT = "%Y-%m-%d_%H-%M-%S";

const rustFiles = () => filesUnder("src-tauri/src", ".rs");
const tsFiles = () => filesUnder("src", ".ts");

test("every date format string in Rust is the house format", () => {
  // Catches a new call site inventing its own arrangement of the same parts,
  // which is how the Dummy File Generator ended up a dash off.
  const problems = [];
  for (const file of rustFiles()) {
    for (const m of read(file).matchAll(/"(%[YmdHMSy][^"]*)"/g)) {
      if (m[1] !== HOUSE_FORMAT) problems.push(`${file}: ${m[1]}`);
    }
  }
  assert.deepEqual(problems, [], `expected only ${HOUSE_FORMAT}`);
});

test("nothing builds a run-together timestamp", () => {
  // yyyyMMddHHmmss and its JS equivalent. Legal, sorts fine, unreadable.
  const problems = [];
  for (const file of [...rustFiles(), ...tsFiles()]) {
    const src = read(file);
    if (/yyyyMMddHHmmss/.test(src)) problems.push(`${file}: yyyyMMddHHmmss`);
    if (/YYYYMMDDHHMMSS/.test(src)) problems.push(`${file}: YYYYMMDDHHMMSS`);
  }
  assert.deepEqual(problems, []);
});

test("only timestamp.ts assembles a name out of date parts", () => {
  // Three tools had grown their own copy of the same six-line padStart block.
  // Using the clock to DISPLAY something is fine; joining the parts into a
  // string is the thing that belongs in one place.
  const problems = [];
  for (const file of tsFiles()) {
    if (file === "src/core/timestamp.ts") continue;
    // The specific shape: an array literal holding the date parts, joined into
    // one string. Reading the clock for anything else is none of this check's
    // business, which is why it looks for the array and the join together
    // rather than for the calls scattered anywhere in the file.
    const joinsParts =
      /\[[^\]]*getFullYear\(\)[^\]]*getSeconds\(\)[^\]]*\]\s*\.join\(/s.test(read(file));
    if (joinsParts) problems.push(file);
  }
  assert.deepEqual(problems, [], "should import fileTimestamp() instead");
});

test("snapshot bucket names are written on the local clock", () => {
  // Utc::now() here is the regression that makes the pruner delete the newest
  // bucket while old UTC-named ones survive.
  const problems = [];
  for (const file of rustFiles()) {
    for (const line of read(file).split("\n")) {
      if (line.includes("Utc::now()")) problems.push(`${file}: ${line.trim()}`);
    }
  }
  assert.deepEqual(problems, [], "use Local::now() / crate::file_timestamp()");
});

test("snapshot bucket names are read back on the local clock", () => {
  // The other half. Parsing a local name as UTC shows every snapshot in the
  // restore list off by the whole timezone offset.
  for (const file of ["src/core/tool-backups.ts", "src/core/db-backups.ts"]) {
    assert.doesNotMatch(
      read(file),
      /Date\.UTC/,
      `${file} must not read a bucket name as UTC`,
    );
  }
});

test("the format constant and the shared helpers still exist", () => {
  // Without this, renaming any of them would make every check above pass by
  // checking nothing.
  assert.match(
    read("src-tauri/src/lib.rs"),
    /BACKUP_FOLDER_FORMAT: &str = "%Y-%m-%d_%H-%M-%S"/,
    "the house format constant moved or changed",
  );
  assert.match(
    read("src-tauri/src/lib.rs"),
    /pub\(crate\) fn file_timestamp\(\)/,
    "the Rust helper moved or was renamed",
  );
  const ts = read("src/core/timestamp.ts");
  for (const fn of ["fileTimestamp", "fileDate", "formatFileTimestamp"]) {
    assert.match(ts, new RegExp(`export (function|const) ${fn}\\b`), `${fn} missing`);
  }
});
