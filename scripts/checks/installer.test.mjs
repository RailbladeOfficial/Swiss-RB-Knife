/* =============================================================================
   THE WINDOWS INSTALLER
   -----------------------------------------------------------------------------
   Everything here is invisible until `npm run tauri build` runs, which is not
   something that happens on the way to a normal change. A path typo in the
   bundle config does not fail a build: NSIS is handed a define that points at
   nothing, and the installer comes out wearing the stock 1990s artwork with no
   warning anywhere. These checks are the only thing standing between that and
   a release.
   ========================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { ROOT, exists, read, slice } from "./_source.mjs";

const conf = () => JSON.parse(read("src-tauri/tauri.conf.json"));

/** Width and height out of a BMP's header, or null if it is not a BMP.
 *  Bytes 0-1 are the "BM" signature; the DIB header at offset 14 carries the
 *  dimensions as signed 32-bit little-endian at 18 and 22. */
function bmpSize(rel) {
  const buf = fs.readFileSync(path.join(ROOT, rel));
  if (buf.length < 26 || buf[0] !== 0x42 || buf[1] !== 0x4d) return null;
  return { w: buf.readInt32LE(18), h: buf.readInt32LE(22), bpp: buf.readUInt16LE(28) };
}

test("the installer's artwork is present, and is what NSIS can actually read", () => {
  /* NSIS reads BMP for these two slots and nothing else. A PNG renamed .bmp,
     or a 32-bit BMP with an alpha channel, is not an error: MUI composites it
     itself and the result is a black rectangle or a blank panel depending on
     the build. Both have to be 24-bit, and both have to be the size MUI
     reserves, because it does not scale them. */
  const slots = [
    { key: "sidebarImage", rel: "src-tauri/installer/sidebar.bmp", w: 164, h: 314 },
    { key: "headerImage", rel: "src-tauri/installer/header.bmp", w: 150, h: 57 },
  ];
  const nsis = conf().bundle.windows.nsis;
  for (const slot of slots) {
    assert.equal(
      nsis[slot.key],
      slot.rel.replace("src-tauri/", ""),
      `the bundle config does not point ${slot.key} at ${slot.rel}`,
    );
    assert.ok(exists(slot.rel), `${slot.rel} is referenced by the config but is not in the tree`);
    const size = bmpSize(slot.rel);
    assert.ok(size, `${slot.rel} is not a BMP, whatever it is named`);
    assert.equal(
      `${size.w}x${size.h}`,
      `${slot.w}x${slot.h}`,
      `${slot.rel} is not the size MUI reserves for it, and MUI will not scale it`,
    );
    assert.equal(size.bpp, 24, `${slot.rel} is not 24-bit, so its alpha channel will render black`);
  }
});

test("the artwork can be regenerated rather than redrawn from memory", () => {
  /* The bitmaps are committed on purpose, the same way src-tauri/icons is: a
     release build must not need Python. The generator is committed for the
     other half of that, so when the icon or the palette changes these are
     rebuilt from the app's own colors instead of guessed at in an editor. */
  assert.ok(exists("scripts/generate-installer-art.py"), "the artwork has no generator");
  const gen = read("scripts/generate-installer-art.py");
  assert.match(gen, /installer/, "the generator does not write into src-tauri/installer");
  assert.match(
    gen,
    /icons.{0,4}["']\s*\/\s*["']icon\.png/,
    "the generator does not draw the app's own icon, so the two can drift apart",
  );
});

test("the installer asks you to accept the license", () => {
  /* The app is AGPL-3.0. The installer template only inserts MUI_PAGE_LICENSE
     when the bundle names a license file, so this one line is the difference
     between an installer that presents the terms and one that never mentions
     them. Tauri resolves the path relative to src-tauri/, not to the repo. */
  const licenseFile = conf().bundle.licenseFile;
  assert.ok(licenseFile, "the bundle names no license file, so the installer shows no license page");
  const rel = path.posix.normalize(path.posix.join("src-tauri", licenseFile));
  assert.ok(exists(rel), `licenseFile points at ${rel}, which is not in the tree`);

  /* NSIS's LicenseData reads plain text or RTF and decides which by looking at
     the first bytes. Anything else renders as garbage in the scroll box rather
     than failing the build, so it is checked here or it is found by whoever
     installs the release. */
  const raw = fs.readFileSync(path.join(ROOT, rel));
  assert.ok(raw.length > 100, "the license file is too short to be a license");
  const rtf = raw.subarray(0, 5).toString("latin1") === "{" + String.fromCharCode(92) + "rtf";
  if (!rtf) {
    const control = raw.filter((b) => b < 9 || (b > 13 && b < 32)).length;
    assert.equal(control, 0, "the license file is neither plain text nor RTF");
  }
});

/* -----------------------------------------------------------------------------
   THE VENDORED NSIS TEMPLATE

   src-tauri/installer/installer.nsi is Tauri's own installer template, copied
   into the repo so the wizard can be themed. That copy is the risk: the file is
   nearly a thousand lines of someone else's code with about a hundred of ours
   inside it, and the day it is re-vendored from a newer Tauri the theme goes
   with it unless someone notices. Nothing about that failure is loud. The
   installer still builds, still installs, and just looks like 1998 again.

   These checks are the noticing.
   -------------------------------------------------------------------------- */

const nsi = () => read("src-tauri/installer/installer.nsi");

test("the installer is built from the template in this repo", () => {
  assert.equal(
    conf().bundle.windows.nsis.template,
    "installer/installer.nsi",
    "the bundle is not using the vendored template, so none of the theming ships",
  );
  assert.ok(exists("src-tauri/installer/installer.nsi"), "the vendored template is missing");
});

test("the theme survived whatever last touched the template", () => {
  const src = nsi();
  for (const marker of [
    "SWISS RB KNIFE THEME",
    "END SWISS RB KNIFE THEME",
    "SWISS RB KNIFE THEME, part two",
    "END SWISS RB KNIFE THEME, part two",
  ]) {
    assert.ok(src.includes(marker), `the template has lost its "${marker}" block`);
  }

  // The pieces that do the work, each one a bug that actually happened.
  assert.match(src, /!define MUI_HEADERIMAGE_RIGHT/, "the header bitmap is back on the left");
  assert.match(src, /!define MUI_LICENSEPAGE_RADIOBUTTONS/, "the license page lost its accept/decline choice");
  assert.match(src, /!insertmacro SRBK_THEME_INNER ""/, "the installer has no page painter");
  assert.match(src, /!insertmacro SRBK_THEME_INNER "un\."/, "the uninstaller has no page painter");
  assert.match(src, /!insertmacro SRBK_GUI_INIT ""/, "the installer frame is unpainted");
  assert.match(src, /!insertmacro SRBK_GUI_INIT "un\."/, "the uninstaller frame is unpainted");
  assert.match(
    src,
    /!define MUI_CUSTOMFUNCTION_UNGUIINIT un\.SrbkGuiInit/,
    "only the installer gets a frame painter; the uninstaller's pages will sit in system grey",
  );
});

test("every page in the wizard is painted, not just the ones someone remembered", () => {
  /* A page with no SHOW callback keeps the system's own colors: black text on
     a black background wherever our background reached it. This lists the page
     macros that need one rather than counting, so a page added upstream shows
     up here as a name this test does not know. */
  const src = nsi();
  const needsPainting = [
    "MUI_PAGE_WELCOME",
    "MUI_PAGE_LICENSE",
    "MUI_PAGE_DIRECTORY",
    "MUI_PAGE_STARTMENU",
    "MUI_PAGE_INSTFILES",
    "MUI_PAGE_FINISH",
    "MUI_UNPAGE_INSTFILES",
  ];
  for (const page of needsPainting) {
    const at = src.indexOf(`!insertmacro ${page}`);
    assert.ok(at > 0, `the template no longer has a ${page}`);
    // The define has to be the last one before the macro, because MUI clears it
    // after each page.
    const before = src.slice(Math.max(0, at - 400), at);
    assert.match(
      before,
      /MUI_PAGE_CUSTOMFUNCTION_SHOW (un\.)?SrbkThemeInner\s*$/m,
      `${page} is not painted`,
    );
  }

  // The uninstaller's confirm page owns its SHOW callback already, so the
  // painter is called from inside it instead.
  const confirm = slice("src-tauri/installer/installer.nsi", "Function un.ConfirmShow", "\nFunctionEnd");
  assert.match(confirm, /Call un\.SrbkThemeInner/, "the uninstall confirm page is not painted");
  assert.match(
    confirm,
    /SetCtlColors \$DeleteAppDataCheckbox/,
    "the hand-built check box has no color of its own, and the id walk cannot reach it",
  );
});

test("the wizard and the artwork are the same color", () => {
  /* Two files hold this palette: the template paints the pages, the generator
     paints the bitmaps. They meet on screen, and a mismatch of a few points
     shows up as a seam down the side of the sidebar. */
  const src = nsi();
  const gen = read("scripts/generate-installer-art.py");

  const rgb = (name) => {
    const m = new RegExp(`^${name} = \\((\\d+), (\\d+), (\\d+)\\)`, "m").exec(gen);
    assert.ok(m, `the generator has no ${name}`);
    return m.slice(1, 4).map(Number);
  };
  const hex = (nums) => nums.map((n) => n.toString(16).padStart(2, "0")).join("").toUpperCase();

  const bg = /!define THEME_BG\s+"([0-9A-Fa-f]{6})"/.exec(src);
  assert.ok(bg, "the template has no THEME_BG");
  assert.equal(bg[1].toUpperCase(), hex(rgb("INK")), "the page background is not the artwork's ink");

  const text = /!define THEME_TEXT\s+"([0-9A-Fa-f]{6})"/.exec(src);
  assert.equal(text[1].toUpperCase(), hex(rgb("TEXT")), "the page text is not the artwork's text color");

  /* The progress bar is set through a window message, which takes a COLORREF:
     the same color with its bytes reversed. Getting this wrong is not a build
     error, it is a blue bar where a magenta one was meant. */
  const bar = /!define THEME_BAR_REF\s+0x([0-9A-Fa-f]{6})/.exec(src);
  assert.ok(bar, "the template has no THEME_BAR_REF");
  assert.equal(
    bar[1].toUpperCase(),
    hex(rgb("MAGENTA").slice().reverse()),
    "the progress bar color is not the artwork's magenta, byte-reversed",
  );
});
