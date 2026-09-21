/* =============================================================================
   EXTERNAL LINKS
   -----------------------------------------------------------------------------
   Every link that leaves the app goes through open_external_url, which asks
   Explorer to open it at the user's own integrity. Going through the opener
   plugin directly runs the hand-off from this elevated process, and a browser
   the user already has open will not take it: the link silently does nothing.
   That shipped in 0.7.0 as #252, on the About modal, the update notice and the
   README. These checks are what stop a new link quietly bringing it back.
============================================================================= */

import test from "node:test";
import assert from "node:assert/strict";

import { read, filesUnder } from "./_source.mjs";

test("nothing in the front end opens a link through the opener plugin directly", () => {
  const offenders = filesUnder("src", ".ts").filter((f) =>
    /from "@tauri-apps\/plugin-opener"/.test(read(f)),
  );
  assert.deepEqual(
    offenders,
    [],
    "these import the opener plugin; open links with openExternal from core/external-link.ts",
  );
});

test("the opener plugin's own click script stays switched off", () => {
  // It sends every target="_blank" link to the plugin's elevated open_url.
  // bindExternalLinks does that job now, through the unelevated route.
  const lib = read("src-tauri/src/lib.rs");
  assert.match(lib, /open_js_links_on_click\(false\)/, "the plugin's injected link script is back on");
  assert.ok(!/tauri_plugin_opener::init\(\)/.test(lib), "the opener plugin is initialized with its defaults");
  assert.match(lib, /external_link::open_external_url/, "open_external_url is not registered");
});

test("target=_blank links are still caught once the plugin stops catching them", () => {
  const docs = read("src/core/docs.ts");
  assert.match(docs, /bindExternalLinks\(/, "nothing replaces the plugin's _blank handler");
});

test("the Rust side refuses anything that is not a web or mail link", () => {
  const rs = read("src-tauri/src/external_link.rs");
  assert.match(rs, /\["https:\/\/", "http:\/\/", "mailto:"\]/, "the scheme allowlist has changed");
  // The check has to run before either route is tried.
  const body = rs.slice(rs.indexOf("pub fn open_external_url"), rs.indexOf("fn checked_url"));
  assert.ok(
    body.indexOf("checked_url(") < body.indexOf("shell_execute_via_explorer"),
    "a URL reaches the shell before it is checked",
  );
});

test("the foreground right is handed on before the link is", () => {
  // Without it the browser opens but stays behind, flashing on the taskbar:
  // Explorer, not this app, is what starts it, and Windows only lets the
  // process you are using bring a window to the front.
  const rs = read("src-tauri/src/external_link.rs");
  const body = rs.slice(rs.indexOf("pub fn open_external_url"), rs.indexOf("fn pass_on_the_foreground"));
  const handOn = body.indexOf("pass_on_the_foreground()");
  assert.ok(handOn !== -1, "the foreground right is never handed on");
  assert.ok(
    handOn < body.indexOf("shell_execute_via_explorer"),
    "the foreground right is handed on after the link, when it is too late to help",
  );
  assert.match(rs, /AllowSetForegroundWindow\(ASFW_ANY\)/, "the hand-on no longer calls AllowSetForegroundWindow");
});
