/* =============================================================================
   STARTUP ORDER  (the blank-window check)
   -----------------------------------------------------------------------------
   This is the check that would have caught the launch failure of 2026-08-21.

   The symptom: the app window opens completely empty. No error dialog, nothing.

   The cause, in plain terms: some of the app's files import each other in a
   loop (A needs B, B needs C, C needs A). When files form a loop, one of them
   necessarily finishes loading before the others. If a file reads a shared
   value from a loop partner *as it loads*, that value may not exist yet, and
   the browser stops dead. Nothing runs.

   The distinction that matters: reading a shared value INSIDE a function is
   always fine, because functions only run later, when something calls them.
   Only code that runs immediately as the file loads is at risk. So this check
   looks specifically for immediately-run code reading a value from a loop
   partner, and ignores everything inside functions.

   Why the normal build does not catch it: `tsc` checks the code is
   type-correct and `vite build` checks it bundles. Neither one RUNS any of it,
   so this fault passes both and only appears on launch.
============================================================================= */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT, read } from "./_source.mjs";

/** Every TypeScript source file under src/, as module ids like "src/shell". */
function moduleIds(dir = "src", acc = []) {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) moduleIds(rel, acc);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      acc.push(rel.slice(0, -3));
    }
  }
  return acc;
}

/** Strips line comments and block comments so braces inside them don't count. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/** { imported: [module ids], bindings: Map<localName, module id> } for one file. */
function parseImports(id) {
  const text = stripComments(read(`${id}.ts`));
  const imported = [];
  const bindings = new Map();
  for (const m of text.matchAll(/import\s+([\s\S]*?)\s+from\s+"\.\/([a-z-]+)"/g)) {
    const target = `src/${m[2]}`;
    imported.push(target);
    // Named bindings only; a default or namespace import can't be a bare const.
    const named = /\{([\s\S]*?)\}/.exec(m[1]);
    if (!named) continue;
    for (const part of named[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) bindings.set(name, target);
    }
  }
  return { imported, bindings };
}

/** Module ids that can reach themselves through imports (i.e. sit in a loop). */
function modulesInCycles(graph) {
  const inCycle = new Set();
  for (const start of graph.keys()) {
    const seen = new Set();
    const stack = [...(graph.get(start) ?? [])];
    while (stack.length) {
      const next = stack.pop();
      if (next === start) {
        inCycle.add(start);
        break;
      }
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(...(graph.get(next) ?? []));
    }
  }
  return inCycle;
}

/** Removes function and arrow-function bodies from a chunk of code.
 *
 *  Needed because a top-level statement can CONTAIN code that doesn't run yet.
 *  `button.addEventListener("click", () => { ... })` runs immediately as far as
 *  registering the handler goes, but everything inside the callback waits for a
 *  click. Only the outer statement is immediately-run code.
 *
 *  Deliberately keeps `if (...) { }` and `for (...) { }` blocks, which DO run at
 *  load, by only stripping a block that directly follows `=>` or a `function`
 *  parameter list. */
function stripFunctionBodies(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    const m = /^(=>\s*|function[^(){}]*\([^()]*\)\s*)\{/.exec(rest);
    if (!m) {
      out += text[i];
      i++;
      continue;
    }
    out += m[1];
    let depth = 0;
    let j = i + m[0].length - 1;
    for (; j < text.length; j++) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    i = j + 1;
  }
  return out;
}

/** The file's statements that RUN as it loads, i.e. top-level code that is not
 *  a function or class declaration. Function bodies are excluded because they
 *  don't execute until called.
 *
 *  Relies on the source being conventionally formatted: a top-level statement
 *  begins in column 0 and continues until its brackets balance. That holds
 *  throughout this codebase and is checked by the guard test below. */
function immediatelyRunCode(id) {
  const lines = stripComments(read(`${id}.ts`)).split("\n");
  const out = [];
  let depth = 0;
  let collecting = false;
  let isDeclaration = false;

  for (const line of lines) {
    const startsStatement = depth === 0 && line.length > 0 && !/^\s/.test(line);
    if (startsStatement) {
      collecting = true;
      isDeclaration =
        /^(export\s+)?(default\s+)?(async\s+)?function\b/.test(line) ||
        /^(export\s+)?(abstract\s+)?class\b/.test(line) ||
        /^(import|export)\b/.test(line);
    }
    if (collecting && !isDeclaration) out.push(line);

    for (const ch of line.replace(/"[^"]*"|'[^']*'|`[^`]*`/g, "")) {
      if (ch === "{" || ch === "(" || ch === "[") depth++;
      else if (ch === "}" || ch === ")" || ch === "]") depth--;
    }
    if (depth <= 0) {
      depth = 0;
      collecting = false;
    }
  }
  return stripFunctionBodies(out.join("\n"));
}

const ids = moduleIds();
const parsed = new Map(ids.map((id) => [id, parseImports(id)]));
const graph = new Map(ids.map((id) => [id, parsed.get(id).imported]));
const cyclic = modulesInCycles(graph);

test("no file reads a shared value from a circular import while it loads (blank-window guard)", () => {
  const problems = [];

  for (const id of ids) {
    if (!cyclic.has(id)) continue; // not in a loop, cannot have this problem
    const { bindings } = parsed.get(id);
    const code = immediatelyRunCode(id);

    for (const [name, source] of bindings) {
      if (!cyclic.has(source)) continue; // partner isn't in the loop
      if (source === id) continue;
      // Constants only: a function imported from a loop partner is fine, it is
      // referenced now but not CALLED until later.
      if (!/^[A-Z][A-Z0-9_]{2,}$/.test(name)) continue;
      if (new RegExp(String.raw`\b${name}\b`).test(code)) {
        problems.push(`${id}.ts reads ${name} from ${source}.ts as it loads`);
      }
    }
  }

  assert.deepEqual(
    problems,
    [],
    "These will open the app to a blank window. Move the value into a file that " +
      "imports nothing (see src/theme-ids.ts), then import it from there.",
  );
});

test("the file holding the theme startup values still imports nothing", () => {
  // This is what GUARANTEES the check above stays satisfiable rather than
  // leaving it to luck. A file with no imports is never in a loop, so it is
  // always fully loaded before anything that reads it.
  const imports = [...read("src/theme-ids.ts").matchAll(/^\s*import\s/gm)];
  assert.deepEqual(
    imports.map((m) => m[0].trim()),
    [],
    "theme-ids.ts must not import anything, that is the entire reason it exists",
  );
});

test("the import loops this project has are the ones we know about", () => {
  // Not a failure on its own, loops are legal. This pins the shape of the app
  // so a NEW loop shows up as a deliberate decision rather than a surprise.
  assert.deepEqual(
    [...cyclic].sort(),
    [
      "src/cycle-theme",
      "src/docs",
      "src/lockscreen",
      "src/shell",
      "src/sidebar-edit",
      "src/sound",
      "src/theme-core",
      "src/theme-editor",
      "src/theme-picker",
    ],
    "the set of files importing each other in a loop has changed",
  );
});

test("the top-level scan can actually see code (guards the checks above)", () => {
  // If the formatting assumption in immediatelyRunCode() ever breaks, the main
  // check would silently pass by finding nothing. This proves it still reads
  // real statements, and still excludes function bodies.
  const code = immediatelyRunCode("src/theme-editor");
  assert.match(code, /_tePrevTheme/, "top-level declarations are not being seen");
  assert.ok(
    !/function tePopulateSwatches/.test(code),
    "function bodies are being included, which would cause false alarms",
  );
});
