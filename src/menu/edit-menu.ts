/* =============================================================================
   EDIT MENU: the right-click menu for text fields
   -----------------------------------------------------------------------------
   Cut / Copy / Paste / Select All / Undo / Redo, drawn by the app instead of
   by the webview.

   Until now text fields were the one place the webview's own menu was left
   alone (see the contextmenu handler in shell.ts), because its editing
   commands were real function with nothing to replace them. This is the
   replacement: the same six commands, in the app's own menu, themed like
   everything else and free of the webview entries (Back, Reload, Save as,
   Inspect) that sat alongside them.

   -----------------------------------------------------------------------------
   HOW THE COMMANDS ARE RUN

   Through document.execCommand(), not by writing to field.value. That is a
   deprecated API, and it is still the only one that edits a field the way
   typing does: it keeps the field's native undo stack intact, so Undo after a
   Paste goes back one paste rather than finding an empty history. Setting
   .value directly wipes that history, which would make the Undo row on this
   very menu a lie.

   Clipboard reads are the exception. execCommand("paste") is refused by every
   Chromium-based webview, so Paste goes through navigator.clipboard.readText()
   and then inserts what came back with execCommand("insertText"), which is
   still an ordinary, undoable edit. If the read is refused (the webview can
   deny clipboard access), the menu says so rather than failing silently,
   because Ctrl+V still works and the user needs to be told to use it.

   -----------------------------------------------------------------------------
   FOCUS

   None of this works if the field loses its selection when the menu is
   clicked, so two things guard it: menu.ts cancels mousedown inside the menu
   (a menu never takes focus), and every command here re-focuses the field and
   restores the selection captured at right-click time before it runs. Either
   one alone would do in the normal case; both, because a field that closes on
   blur would otherwise be a live bug rather than a cosmetic one.
============================================================================= */

import { openMenu, type MenuItem } from "./menu";

/** The two field types with their own selection API. Everything else this
 *  menu opens on (a contenteditable region) is handled through the document
 *  selection instead. */
type InputLike = HTMLInputElement | HTMLTextAreaElement;

/** A captured selection, or null when the field does not report one. */
interface SelectionRange {
  start: number;
  end: number;
}

/** How the menu reports a refused clipboard read. Injected by shell.ts rather
 *  than imported, so this file stays free of the shell and can be pulled into
 *  any module without a load-order loop. */
type Notify = (message: string, type?: "success" | "error") => void;

let notify: Notify | null = null;

/** Registers the toast function the menu uses for a refused clipboard read.
 *  Called once, from shell.ts. */
export function setEditMenuNotify(fn: Notify): void {
  notify = fn;
}

function isInputLike(el: EventTarget | null): el is InputLike {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}

/* -----------------------------------------------------------------------------
   Reading the field

   Everything below is written to survive an <input type="number">, which is a
   text entry by every measure a user cares about but THROWS on selectionStart
   and setSelectionRange rather than returning null. So each read is guarded,
   and "cannot tell" is treated as "assume there is a selection": a grayed-out
   Copy on a field that does have text selected is a worse wrong answer than a
   live Copy that turns out to have nothing to do.
----------------------------------------------------------------------------- */

/** The field's current selection, or null if it does not report one. */
function readSelection(el: HTMLElement): SelectionRange | null {
  if (!isInputLike(el)) return null;
  try {
    const { selectionStart: start, selectionEnd: end } = el;
    if (start === null || end === null) return null;
    return { start, end };
  } catch {
    return null;
  }
}

/** The selected text, or null when the field does not report a selection. */
function readSelectedText(el: HTMLElement): string | null {
  if (isInputLike(el)) {
    const range = readSelection(el);
    return range ? el.value.slice(range.start, range.end) : null;
  }
  return window.getSelection()?.toString() ?? "";
}

/** Whether the field holds anything at all, for graying out Select All. */
function hasContent(el: HTMLElement): boolean {
  return isInputLike(el) ? el.value.length > 0 : (el.textContent ?? "").length > 0;
}

/** Whether the field refuses edits. A readonly field still gets Copy and
 *  Select All, which is the whole reason it is on this menu. */
function isReadOnly(el: HTMLElement): boolean {
  if (isInputLike(el)) return el.readOnly;
  return !el.isContentEditable;
}

/** Puts focus and the captured selection back on the field, so a command runs
 *  against the same text that was under the cursor when the menu opened. */
function restore(el: HTMLElement, range: SelectionRange | null): void {
  el.focus({ preventScroll: true });
  if (!range || !isInputLike(el)) return;
  try {
    el.setSelectionRange(range.start, range.end);
  } catch {
    // A field that cannot be told where its selection is (number) keeps
    // whatever selection it already had, which is the one we captured.
  }
}

/** execCommand, with its two failure modes (returns false, or throws on an
 *  unsupported command) flattened into one. */
function exec(command: string, value?: string): boolean {
  try {
    return document.execCommand(command, false, value);
  } catch {
    return false;
  }
}

/** Last-resort insert for when execCommand("insertText") is refused. Splices
 *  the text in by hand and announces it the way typing would.
 *
 *  Fires `change` as well as `input`, which typing does NOT do until the field
 *  is left. A handler that only saves on `change` would otherwise drop a
 *  pasted value entirely, and a duplicate save is the cheaper of the two
 *  mistakes on a path that only runs when the proper one has already failed. */
function insertByHand(el: HTMLElement, text: string): void {
  if (!isInputLike(el)) return;
  const range = readSelection(el) ?? { start: el.value.length, end: el.value.length };
  el.value = el.value.slice(0, range.start) + text + el.value.slice(range.end);
  const caret = range.start + text.length;
  try {
    el.setSelectionRange(caret, caret);
  } catch {
    // Nothing to do: the value is in, which is the part that matters.
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Reads the clipboard and inserts it as an ordinary, undoable edit. */
async function paste(el: HTMLElement, range: SelectionRange | null): Promise<void> {
  restore(el, range);
  // Tried first on the off-chance a future webview allows it: when it works,
  // it is the browser's own paste, complete with the field's undo entry.
  if (exec("paste")) return;

  let text: string;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    notify?.("Clipboard is not readable here. Press Ctrl+V to paste.", "error");
    return;
  }
  if (text === "") return;

  // Focus can have moved while the read was in flight (the webview may show a
  // permission prompt), so the field is claimed back before the insert.
  restore(el, range);
  if (!exec("insertText", text)) insertByHand(el, text);
}

/** Copies the selection, preferring the synchronous command so the ordinary
 *  case needs no clipboard permission at all. */
function copy(el: HTMLElement, range: SelectionRange | null, andCut: boolean): void {
  restore(el, range);
  if (exec(andCut ? "cut" : "copy")) return;

  const text = readSelectedText(el);
  if (text === null || text === "") return;
  void navigator.clipboard.writeText(text).catch(() => {
    notify?.("Clipboard is not writable here", "error");
  });
  if (andCut) {
    restore(el, range);
    if (!exec("delete")) insertByHand(el, "");
  }
}

/* =============================================================================
   THE MENU
============================================================================= */

/** Opens the text-editing menu for `el` at the cursor.
 *
 *  Called from the one contextmenu handler in shell.ts, which has already
 *  decided that `el` is a text entry. The field's selection is read HERE,
 *  before any menu row is clicked, because that is the last moment it is
 *  guaranteed to be the one the user was looking at. */
export function openEditMenu(el: HTMLElement, x: number, y: number): void {
  const range = readSelection(el);
  const selected = readSelectedText(el);
  // null means "the field would not say", which is taken as yes; see the note
  // above readSelection().
  const hasSelection = selected === null || selected.length > 0;
  const readOnly = isReadOnly(el);

  const items: MenuItem[] = [
    {
      label: "Cut",
      disabled: readOnly || !hasSelection,
      onClick: () => copy(el, range, true),
    },
    {
      label: "Copy",
      disabled: !hasSelection,
      onClick: () => copy(el, range, false),
    },
    {
      label: "Paste",
      disabled: readOnly,
      onClick: () => void paste(el, range),
    },
    { separator: true },
    {
      label: "Select All",
      disabled: !hasContent(el),
      onClick: () => {
        el.focus({ preventScroll: true });
        if (isInputLike(el)) el.select();
        else exec("selectAll");
      },
    },
    { separator: true },
    // Never grayed out: the webview keeps the undo history privately and
    // offers no way to ask whether it holds anything, so the honest choice is
    // a live row that sometimes does nothing rather than a guess at whether
    // there is something to undo.
    {
      label: "Undo",
      disabled: readOnly,
      onClick: () => {
        restore(el, range);
        exec("undo");
      },
    },
    {
      label: "Redo",
      disabled: readOnly,
      onClick: () => {
        restore(el, range);
        exec("redo");
      },
    },
  ];

  openMenu({ x, y }, items);
}
