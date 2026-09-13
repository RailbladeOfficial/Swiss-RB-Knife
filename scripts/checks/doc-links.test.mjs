/* =============================================================================
   LINKS IN THE PROJECT'S OWN DOCUMENTS
   -----------------------------------------------------------------------------
   The root documents are read in two places: on GitHub, where a relative link
   resolves against the repo, and inside the app, where the doc viewer routes
   the known filenames to their modals. A link can work in one and be dead in
   the other without anything saying so. README, ATTRIBUTION and LICENSING all
   linked THIRD_PARTY_LICENSES.md at the repo root, where it has never existed:
   the file is generated into public/. It opened fine in the app and went
   nowhere on GitHub.
============================================================================= */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { ROOT, read } from "./_source.mjs";

const DOCS = ["README.md", "ATTRIBUTION.md", "LICENSING.md", "SECURITY.md", "CONTRIBUTING.md"];

/** Every relative target a document points at: markdown links and images, and
 *  the src/href attributes of the raw HTML the README uses for screenshots. */
function relativeTargets(text) {
  const targets = [
    ...[...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]),
    ...[...text.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((m) => m[1]),
  ];
  return targets
    .filter((t) => !/^(?:[a-z]+:|#)/i.test(t))
    .map((t) => t.split("#")[0])
    .filter(Boolean);
}

test("every relative link in the project's documents points at a file that exists", () => {
  const dead = [];
  for (const doc of DOCS) {
    if (!fs.existsSync(path.join(ROOT, doc))) continue;
    for (const target of relativeTargets(read(doc))) {
      if (!fs.existsSync(path.join(ROOT, target))) dead.push(`${doc} -> ${target}`);
    }
  }
  assert.deepEqual(dead, [], "these links go nowhere on GitHub");
});

test("the license list linked at its real path still opens in the app", () => {
  /* The link is written as public/THIRD_PARTY_LICENSES.md for GitHub's sake.
     The doc viewer keys its modals on the bare filename, so without the prefix
     being dropped the in-app link would fall through to the system browser. */
  const docs = read("src/core/docs.ts");
  assert.ok(docs.includes('href.startsWith("public/")'), "the doc viewer no longer maps public/ links to their modal");
  assert.ok(docs.includes('"THIRD_PARTY_LICENSES.md": () => openLicensing("thirdparty")'));
});
