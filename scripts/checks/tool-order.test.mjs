/* =============================================================================
   CLASSIC ORDER
   -----------------------------------------------------------------------------
   ALL_TOOLS is written in Classic order, and that order is a ranking: the
   heaviest, most-used tools first. With categories switched on, the sidebar and
   Home group tools under headings drawn in TOOL_CATEGORIES order, so the
   headings have to follow the same ranking or Classic stops meaning what it
   says. Moving Kanban to the top without moving Productivity ahead of Tracking
   would still have drawn the Tracking heading first, with Kanban three tools
   down. Nothing on screen explains that; this does.

   And the README lists the tools in the same order, because it is the same
   ranking told to someone who has not installed the app yet.
============================================================================= */

import test from "node:test";
import assert from "node:assert/strict";

import { read, slice } from "./_source.mjs";

function classicTools() {
  return [...slice("src/core/shell.ts", "export const ALL_TOOLS", "];").matchAll(/section: "(\w+)", tool: "[\w-]+", label: "([^"]+)"/g)].map(
    (m) => ({ section: m[1], label: m[2] }),
  );
}

test("the category headings come in the order their tools do in Classic", () => {
  const tools = classicTools();
  assert.ok(tools.length >= 10, "ALL_TOOLS did not parse");
  const firstSeen = [...new Set(tools.map((t) => t.section))];
  const categories = [...slice("src/core/shell.ts", "export const TOOL_CATEGORIES", "];").matchAll(/id: "(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    categories,
    firstSeen,
    "TOOL_CATEGORIES is out of step with ALL_TOOLS, so grouped Classic draws a heading ahead of the tool that ranks first",
  );
});

test("the README lists the tools in Classic order", () => {
  const readme = [...read("README.md").matchAll(/^### - \*\*(.+?)\*\*/gm)].map((m) => m[1]);
  assert.deepEqual(readme, classicTools().map((t) => t.label), "the README's tool sections are not in Classic order");
});
