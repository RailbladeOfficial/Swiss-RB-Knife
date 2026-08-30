#!/usr/bin/env node
/**
 * generate-sound-manifest.mjs
 * Generates src/sound/sound-manifest.ts from whatever audio files are sitting in
 * public/sounds/button-sounds/, public/sounds/modal-sounds/ and
 * public/sounds/timer-sounds/.
 * Run manually: node generate-sound-manifest.mjs
 * Or automatically as a predev/prebuild hook in package.json.
 *
 * Why generated rather than a hand-kept array like SOUND_PACKS in shell.ts:
 * a notification pack is a curated pair of files with a display name worth
 * writing by hand, whereas these two folders are meant to be a drop-in bin.
 * Adding a click sound should be copying a .wav in, not editing TypeScript.
 * Files in public/ never enter Vite's module graph, so import.meta.glob cannot
 * see them; scanning at prebuild time is what fills that gap.
 */

import { readdirSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname, join, extname, basename } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, "..");
const SOUNDS_DIR = join(ROOT_DIR, "public", "sounds");
const OUTPUT_FILE = join(ROOT_DIR, "src", "sound", "sound-manifest.ts");

/* What counts as a playable cue. Anything else in the folder (an -attr.txt
   attribution note, a stray .md, an OS thumbnail file) is skipped rather than
   offered as a sound that would fail to play. */
const AUDIO_EXTENSIONS = new Set([".wav", ".mp3", ".ogg", ".m4a", ".flac", ".webm"]);

/** Folder name -> the export it fills. `prefix` is stripped off the front of
 *  a file name before it becomes a display name; the files are named with
 *  their category so the folders stay readable, but the picker (or optgroup)
 *  already says which category you are looking at. */
const CATEGORIES = [
  { folder: "button-sounds", constName: "BUTTON_SOUNDS", label: "Button", prefix: "button-" },
  { folder: "modal-sounds", constName: "MODAL_SOUNDS", label: "Modal", prefix: "modal-" },
  { folder: "timer-sounds", constName: "TIMER_SOUNDS", label: "Timer", prefix: "timer-" },
];

/** "button-click-1.wav" in button-sounds/ -> "Click 1". The category prefix
 *  comes off the front when the file carries it, so a tile does not read
 *  "Button Click 1" inside a modal already titled Choose Button Sound. What is
 *  left has its separators turned into spaces and each word capitalised, so a
 *  sensibly-named file needs no further curation.
 *
 *  Only the DISPLAY name loses the prefix. The id stays the whole file stem,
 *  so an id still names exactly one file on disk and two files that differ
 *  only by prefix cannot collide. */
function prettify(fileName, prefix) {
  let stem = basename(fileName, extname(fileName));
  if (prefix && stem.toLowerCase().startsWith(prefix) && stem.length > prefix.length) {
    stem = stem.slice(prefix.length);
  }
  return stem
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
    .join(" ");
}

/** The URL the app fetches. Each path segment is encoded separately, so a
 *  dropped-in file whose name has a space (or any other character that has to
 *  travel as an escape) still resolves, without the slashes being eaten too.
 *  The folder names themselves no longer need it, but the file names are
 *  whatever someone happens to copy in. */
function soundUrl(folder, fileName) {
  return `/sounds/${encodeURIComponent(folder)}/${encodeURIComponent(fileName)}`;
}

function scan(folder, prefix) {
  const dir = join(SOUNDS_DIR, folder);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase()))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
    .map((fileName) => ({
      id: basename(fileName, extname(fileName)),
      name: prettify(fileName, prefix),
      url: soundUrl(folder, fileName),
    }));
}

function renderList(constName, folder, entries) {
  const body = entries
    .map(
      (e) =>
        `  { id: ${JSON.stringify(e.id)}, name: ${JSON.stringify(e.name)}, url: ${JSON.stringify(e.url)} },`,
    )
    .join("\n");
  return [
    `/** Everything currently in public/sounds/${folder}/. Empty is a valid`,
    ` *  state: the picker then offers "None" only. */`,
    `export const ${constName}: SoundEffect[] = [`,
    body,
    `];`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

const sections = CATEGORIES.map(({ folder, constName, prefix }) =>
  renderList(constName, folder, scan(folder, prefix)),
);

const output = `/* =============================================================================
   SOUND MANIFEST  (GENERATED FILE, DO NOT EDIT BY HAND)
   -----------------------------------------------------------------------------
   Written by scripts/generate-sound-manifest.mjs, which runs from the predev
   and prebuild hooks. It lists whatever audio files are in
   public/sounds/button-sounds/, public/sounds/modal-sounds/ and
   public/sounds/timer-sounds/, so adding a cue is a matter of dropping a file
   in one of those folders and re-running dev or build. Editing this file
   directly will be undone on the next run.

   Imports nothing on purpose. Like theme-ids.ts this is pure data that the
   circular shell/sound import graph can reach from anywhere without adding an
   edge to it.
============================================================================= */

export interface SoundEffect {
  /** File name without its extension, and what gets persisted in settings. */
  id: string;
  /** Display name shown on the tile in this cue's picker, with the category
   *  prefix its file name carries stripped off. */
  name: string;
  /** URL-encoded path under public/, ready to hand to new Audio(). */
  url: string;
}

${sections.join("\n\n")}

/** Looks a cue up in any of the lists above. Returns null for the empty id
 *  (the "None" option) and for an id whose file has since been removed from
 *  its folder, so a stale setting degrades to silence instead of a failed
 *  fetch. */
export function findSoundEffect(list: SoundEffect[], id: string): SoundEffect | null {
  if (!id) return null;
  return list.find((s) => s.id === id) ?? null;
}
`;

writeFileSync(OUTPUT_FILE, output, "utf8");

const counts = CATEGORIES.map(
  ({ folder, label, prefix }) => `${scan(folder, prefix).length} ${label.toLowerCase()}`,
);
console.log(`\n✅ Written to src/sound/sound-manifest.ts`);
console.log(`   ${counts.join(", ")} sound(s) found\n`);
