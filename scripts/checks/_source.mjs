/* =============================================================================
   SHARED HELPERS FOR THE CHECK SUITE
   -----------------------------------------------------------------------------
   Most of the app's front-end modules touch `document` the moment they load, so
   a test process (which has no browser) cannot import them. These checks read
   the source files as TEXT and assert things about their contents instead.

   That is a real limitation and worth being clear about: these verify that the
   app's lists, ids and files agree with each other. They do not click buttons.
   Where a module IS safe to import (theme-ids.ts imports nothing and touches no
   browser API), the matching test file imports it for real instead of reading it
   as text, and those are true unit tests.
============================================================================= */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
export const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

/** The chunk of a source file between `startMarker` and the next `endMarker`.
 *  Used to isolate one array/object literal so a regex can't wander into the
 *  next one and silently pick up entries that belong to something else. */
export function slice(rel, startMarker, endMarker) {
  const text = read(rel);
  const start = text.indexOf(startMarker);
  if (start === -1) throw new Error(`${rel}: marker not found: ${startMarker}`);
  const end = text.indexOf(endMarker, start + startMarker.length);
  if (end === -1) throw new Error(`${rel}: end marker not found after ${startMarker}`);
  return text.slice(start, end);
}

/** Every built-in theme the picker offers, in picker order.
 *  Reads theme-ids.ts, which is where the registry lives so that the picker,
 *  cycle-theme and theme-core can all reach it without importing each other. */
export function themeGroups() {
  const text = read("src/theme-ids.ts");
  const block = text.slice(text.indexOf("export const THEME_GROUPS"));
  const themes = [...block.matchAll(/\{ id: "([a-z-]+)", label: "([^"]+)" \}/g)].map(
    (m) => ({ id: m[1], label: m[2] }),
  );
  const tabs = [...block.matchAll(/tab: "([a-z]+)"/g)].map((m) => m[1]);
  return { themes, tabs };
}

/** Theme CSS files present on disk (ids, not filenames). */
export function themeFiles() {
  return fs
    .readdirSync(path.join(ROOT, "public/themes"))
    .filter((f) => f.endsWith(".css"))
    .map((f) => f.slice(0, -4));
}

/** The <option> values and labels inside one <select>, in document order. */
export function selectOptions(selectId) {
  const html = read("index.html");
  const at = html.indexOf(`id="${selectId}"`);
  if (at === -1) throw new Error(`index.html: no select #${selectId}`);
  const block = html.slice(at, html.indexOf("</select>", at));
  return [...block.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)</g)].map((m) => ({
    value: m[1],
    label: m[2].trim(),
  }));
}

/** Every file under `dir` (relative to the repo root) ending in `ext`. */
export function filesUnder(dir, ext, acc = []) {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) filesUnder(rel, ext, acc);
    else if (entry.name.endsWith(ext)) acc.push(rel);
  }
  return acc;
}

/** All front-end TypeScript, concatenated. Fine for "is X mentioned anywhere"
 *  questions; use filesUnder() when the answer needs to name a file. */
export const allFrontEndSource = () =>
  filesUnder("src", ".ts")
    .map((f) => read(f))
    .join("\n");

/** Every `id="..."` present in index.html. */
export function htmlIds() {
  return new Set([...read("index.html").matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
}

/** Every id="..." in index.html, as a list, so duplicates stay visible. */
export function htmlIdList() {
  return [...read("index.html").matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
}

/** An attribute value from a single tag identified by its id. */
export function tagAttr(elementId, attr) {
  const html = read("index.html");
  const at = html.indexOf(`id="${elementId}"`);
  if (at === -1) throw new Error(`index.html: no element #${elementId}`);
  const tag = html.slice(html.lastIndexOf("<", at), html.indexOf(">", at) + 1);
  const m = new RegExp(`${attr}="([^"]*)"`).exec(tag);
  return m ? m[1] : null;
}
