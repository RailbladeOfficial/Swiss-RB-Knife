/* =============================================================================
   TOOLS AND INPUTS
   -----------------------------------------------------------------------------
   Two kinds of check.

   Tools: adding or removing a tool means touching several places by hand, with
   nothing reconciling them. Miss one and the tool is half-present: a card that
   opens nothing, or a tool with no way to reach it.

   Inputs: number and slider fields carry their limits as attributes in the page.
   These confirm those limits are sane, because a field whose starting value sits
   outside its own limits, or whose limits are backwards, behaves unpredictably
   the first time it is touched.
============================================================================= */

import test from "node:test";
import assert from "node:assert/strict";
import { read, exists, slice, filesUnder, htmlIds } from "./_source.mjs";

/** The tool registry, the single list everything else is supposed to match. */
function allTools() {
  const block = slice("src/shell.ts", "const ALL_TOOLS", "];");
  return [...block.matchAll(
    /key: "([^"]+)", section: "([a-z-]+)", tool: "([a-z-]+)", label: "([^"]+)"/g,
  )].map((m) => ({ key: m[1], section: m[2], tool: m[3], label: m[4] }));
}

test("the tool list is not empty (guards every tool check below)", () => {
  // Without this, a parsing change would make the checks below pass by
  // checking nothing at all.
  assert.ok(allTools().length >= 9, `expected the full tool list, parsed ${allTools().length}`);
});

test("every tool has BOTH a sidebar entry and a dashboard card", () => {
  // Checked separately on purpose. An earlier version of this test only asked
  // whether the tool was mentioned anywhere, which meant deleting the card
  // still passed because the sidebar entry alone satisfied it. Mutation testing
  // caught that; each way in is now verified in its own right.
  //
  // The third way in, .dashboard-tool-btn, is deliberately not required: only
  // five of the nine tools have one, so it is a partial feature rather than
  // part of the contract.
  const html = read("index.html");
  const missing = [];
  for (const t of allTools()) {
    const marks = `data-section="${t.section}" data-tool="${t.tool}"`;
    for (const cls of ["nav-item", "tool-card"]) {
      if (!new RegExp(`class="${cls}"[^>]*${marks}`).test(html)) {
        missing.push(`${t.label}: no ${cls}`);
      }
    }
  }
  assert.deepEqual(missing, [], "these tools cannot be opened the usual way");
});

test("every tool lives in a section that exists", () => {
  const sections = new Set(
    [...read("index.html").matchAll(/id="section-([a-z-]+)"/g)].map((m) => m[1]),
  );
  const orphans = allTools().filter((t) => !sections.has(t.section));
  assert.deepEqual(
    orphans.map((t) => `${t.label} (in "${t.section}")`),
    [],
    "these tools are filed under a section that does not exist in the page",
  );
});

test("every tool has its own code and styling files", () => {
  const missing = [];
  for (const t of allTools()) {
    // Dummy File Generator's files are named file-gen, so the check is that
    // SOME file pair exists for the tool, matched on either naming.
    const candidates = [t.tool, t.tool.replace(/^dummy-/, "").replace(/-generator$/, "-gen")];
    const hasTs = candidates.some((c) => exists(`src/tools/${c}.ts`));
    const hasCss = candidates.some((c) => exists(`src/tools/${c}.css`));
    if (!hasTs) missing.push(`${t.label}: no .ts file`);
    if (!hasCss) missing.push(`${t.label}: no .css file`);
  }
  assert.deepEqual(missing, [], "these tools are missing their own files");
});

test("every tool's stylesheet is actually loaded by the page", () => {
  // A stylesheet that exists but is never linked means the tool renders
  // unstyled, which looks like a broken screen rather than a missing file.
  const html = read("index.html");
  const linked = new Set(
    [...html.matchAll(/<link[^>]*href="(src\/tools\/[^"]+\.css)"/g)].map((m) => m[1]),
  );
  const onDisk = filesUnder("src/tools", ".css");
  const unlinked = onDisk.filter((f) => !linked.has(f));
  assert.deepEqual(unlinked, [], "these tool stylesheets exist but are never loaded");
});

test("no number or slider field starts outside its own limits", () => {
  const problems = [];
  for (const m of read("index.html").matchAll(/<input[^>]*>/g)) {
    const tag = m[0];
    if (!/type="(number|range)"/.test(tag)) continue;
    const num = (name) => {
      const hit = new RegExp(`${name}="(-?[0-9.]+)"`).exec(tag);
      return hit ? Number(hit[1]) : null;
    };
    const id = (/id="([^"]+)"/.exec(tag) || [])[1] ?? "(unnamed field)";
    const [min, max, value, step] = [num("min"), num("max"), num("value"), num("step")];

    if (min !== null && max !== null && min >= max) problems.push(`${id}: min ${min} >= max ${max}`);
    if (value !== null && min !== null && value < min) problems.push(`${id}: starts at ${value}, below its minimum ${min}`);
    if (value !== null && max !== null && value > max) problems.push(`${id}: starts at ${value}, above its maximum ${max}`);
    if (step !== null && step <= 0) problems.push(`${id}: step ${step} must be positive`);
  }
  assert.deepEqual(problems, []);
});

test("every input the app reads is a field it can actually read", () => {
  // The code casts these to input elements. If one is a <div> or a <select>,
  // reading .value gives undefined and the setting silently never applies.
  const html = read("index.html");
  const source = filesUnder("src", ".ts").map(read).join("\n");
  const asInput = [
    ...source.matchAll(
      /getElementById\(\s*["']([A-Za-z0-9_-]+)["']\s*\)\s*(?:as\s+HTML(?:Input|TextArea|Select)Element|\)?\s*as\s+HTML(?:Input|TextArea|Select)Element)/g,
    ),
  ].map((m) => m[1]);

  const wrong = [];
  for (const id of new Set(asInput)) {
    const at = html.indexOf(`id="${id}"`);
    if (at === -1) continue; // covered by the wiring check
    const tagStart = html.lastIndexOf("<", at);
    const tag = html.slice(tagStart, html.indexOf(">", at) + 1);
    if (!/^<(input|textarea|select)\b/.test(tag)) {
      wrong.push(`${id} is read as a form field but is a ${/^<([a-z]+)/.exec(tag)?.[1]}`);
    }
  }
  assert.deepEqual(wrong, []);
});

test("no dropdown is left permanently empty", () => {
  // A dropdown can legitimately ship empty and be filled from code at runtime
  // (the Cycle day/night theme pickers and the Countdown sound list both do).
  // What is never right is a dropdown that is empty in the page AND that no
  // code ever touches: that one is empty forever, and reads to the user as a
  // setting that refuses to open.
  const html = read("index.html");
  const source = filesUnder("src", ".ts").map(read).join("\n");

  const problems = [];
  for (const m of html.matchAll(/<select\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const [, id, contents] = m;
    if (/<option/.test(contents)) continue; // ships with choices
    if (source.includes(`"${id}"`)) continue; // filled from code
    problems.push(`${id} has no options and no code fills it`);
  }
  assert.deepEqual(problems, []);
});

test("every dropdown that ships with choices is one the app knows about", () => {
  // The reverse orphan: a populated dropdown nothing reads is a control the
  // user can change with no effect.
  const html = read("index.html");
  const source = filesUnder("src", ".ts").map(read).join("\n");
  const ignored = [];
  for (const m of html.matchAll(/<select\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const [, id, contents] = m;
    if (!/<option/.test(contents)) continue;
    if (!source.includes(`"${id}"`)) ignored.push(id);
  }
  assert.deepEqual(ignored, [], "these dropdowns have choices but nothing reads them");
});
