/* =============================================================================
   IMAGE CCR
   -----------------------------------------------------------------------------
   A Cancel you pressed is reported as a cancel. The resize used to come back as
   a red "Resize failed: Cancelled by user.", which read as something going
   wrong when it was the button doing its job. The backend flags the one outcome
   that is a cancel, and the resize screen says it differently.
============================================================================= */

import test from "node:test";
import assert from "node:assert/strict";

import { read } from "./_source.mjs";

test("a canceled resize is not reported as a failure", () => {
  const rs = read("src-tauri/src/tools/image_ccr.rs");
  assert.match(rs, /pub canceled:\s+bool,/, "the resize-complete event cannot say it was a cancel");
  assert.match(
    rs,
    /canceled: true,\s*success: false,\s*message: "Canceled by user\."/,
    "the Cancel outcome is not the one flagged as canceled",
  );
  assert.equal(rs.split("canceled: true,").length - 1, 1, "an outcome other than Cancel is flagged as a cancel");

  const ts = read("src/tool/image-ccr.ts");
  const at = ts.indexOf("} else if (payload.canceled) {");
  assert.ok(at > -1, "the resize screen treats a cancel as a failure");
  const branch = ts.slice(at, ts.indexOf("} else {", at));
  assert.match(branch, /"success"/, "a cancel is shown in the error style");
  assert.doesNotMatch(branch, /failed/i, "a cancel still says it failed");
});
