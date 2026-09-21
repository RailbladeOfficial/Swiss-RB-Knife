/* =============================================================================
   MENU: shared primitive
   -----------------------------------------------------------------------------
   The app's small floating command list: a column of labeled buttons that
   opens next to something, runs one action, and dismisses itself. Kanban's
   board and card three-dot menus are the first users; right-click menus are
   the reason it lives here rather than in kanban.ts.

   Not a Modal, and deliberately so. A Modal is a destination: it dims the app
   behind it, stacks, and is closed on purpose. A menu is a passing choice,
   pinned to the thing it acts on and dismissed by looking away. Different
   lifecycle, different primitive.

   Only ONE menu is open at a time, app-wide. Opening a second closes the
   first, which is what you want from a menu bar and what makes the dismissal
   bookkeeping a single pair of module-level variables rather than a stack.

   -----------------------------------------------------------------------------
   USAGE

     openMenu(anchorElement, [
       { label: "Card Stats", onClick: () => openCardStats(card) },
       { label: "Duplicate", onClick: () => duplicate(card) },
       { label: "Delete", onClick: () => confirmDelete(card), danger: true },
     ]);

   The first argument is where to put it, and takes either form:

     an element   the menu hangs below it, left edges aligned. This is the
                  dropdown case: a three-dot button, a header action.
     a point      { x, y } in viewport coordinates. This is the right-click
                  case, where the cursor is the anchor and there is no element
                  to measure. Pass a MouseEvent's clientX/clientY straight in.

   Either way the menu is kept fully on screen; see positionMenu().

   The SECOND argument takes a function as well as an array. Pass a function
   when any row is marked keepOpen: that row leaves the menu up, and the panel
   is then built again from the function so its ticks, counts and grayed-out
   rows describe what the click just did. attachMenu already does this for its
   callers. An array is still right for a menu whose every row closes it.

   -----------------------------------------------------------------------------
   WIRING A RIGHT-CLICK MENU

   shell.ts cancels the webview's own menu everywhere, and does it on the
   bubbling phase at window level, so an element's own handler runs first and
   this is all a caller needs:

     el.addEventListener("contextmenu", (e) => {
       e.preventDefault();
       openMenu({ x: e.clientX, y: e.clientY }, [ ...items ]);
     });

   That window-level handler is also the fallback: a right-click no element
   claimed opens the app's background menu (Settings / About / Immersive /
   Exit, plus the open tool's own header buttons), and a right-click in a text
   field opens the editing menu in edit-menu.ts. So "no menu here" now means
   "the app-wide menu", never "the webview's menu".

   Styling lives in menu.css, linked from index.html.
============================================================================= */

/** One row of a menu.
 *
 *  A row is either a command (a `label`, plus an `onClick` or a `submenu`) or
 *  a `separator`, never both. */
export interface MenuItem {
  /** The row's text. Plain text, never markup. Ignored on a separator. */
  label?: string;
  /** Runs after the menu has closed, so the action can open a modal of its
   *  own without the menu still sitting over it. Ignored when `submenu` is
   *  set: that row's job is to open the submenu. */
  onClick?: () => void;
  /** Leaves the menu up after `onClick`, and builds it again from the
   *  caller so the row's own state is current.
   *
   *  For the EDIT rows: priority, effort, owner, tags. Those are the ones you
   *  reach for several at a time, and a menu that closes on each one makes
   *  putting three tags on a card three right-clicks and six drill-downs. A
   *  row that opens a screen of its own, moves the card somewhere else, or
   *  destroys something must NOT set this: the menu would be left describing
   *  something that is no longer in front of you.
   *
   *  Only meaningful when the caller passed its rows as a function; see
   *  MenuItems. With a plain array there is nothing to rebuild from, so the
   *  panel would redraw the stale list. */
  keepOpen?: boolean;
  /** Turns the row into a drill-down into these items. See DRILL-DOWN below. */
  submenu?: MenuItem[];
  /** What the menu remembers this submenu row BY, when its label is not
   *  stable. Defaults to the label.
   *
   *  A keepOpen click rebuilds the whole tree and walks back to where you were
   *  by matching rows. A label that carries a live count, like "Types (2)",
   *  changes on exactly the click that triggered the rebuild, so the walk found
   *  nothing and the menu closed: ticking a tag shut the tag menu. Give such a
   *  row a key that does not change, such as the id of the thing it stands for. */
  key?: string;
  /** Renders in the danger color. For destructive rows (Delete, Remove). */
  danger?: boolean;
  /** A color chip before the label, as #rrggbb. For rows that stand for
   *  something the user has already given a color to, so the menu and the thing
   *  it produces are recognizably the same. Omit for rows that have no color;
   *  an invented one would read as meaning something. */
  swatch?: string;
  /** Grays the row out and makes it unclickable. Prefer this over omitting a
   *  row that is sometimes available: a menu whose length changes is harder
   *  to build muscle memory for than one with a grayed-out entry. */
  disabled?: boolean;
  /** A ruled gap instead of a row. For menus assembled from two sources that
   *  mean different things: the open tool's own header actions above, the
   *  app-wide ones below. Leading, trailing and doubled separators are
   *  dropped when the level is rendered, so a caller can splice one in
   *  between two lists without first checking either is non-empty. */
  separator?: boolean;
}

/* -----------------------------------------------------------------------------
   DRILL-DOWN, NOT FLYOUT

   A row with a `submenu` replaces the menu's contents in place and grows a
   "‹ Back" row at the top, rather than opening a panel off the side.

   That is a deliberate choice, not a shortcut. A side flyout needs hover
   intent (so crossing a neighboring row on the diagonal does not swap the
   panel out from under the cursor), its own edge-flipping when it would open
   off-screen, and a dismissal model where the parent stays open while the
   child has the pointer. Drill-down needs none of that: there is still
   exactly one panel, one set of dismissal listeners, and nothing to chase.

   The cost is one extra click to back out, which only matters if you open a
   submenu by mistake.
----------------------------------------------------------------------------- */

/** Where a menu should open. An element to hang beneath, or a viewport point
 *  (a cursor position) to open at. */
export type MenuAnchor = HTMLElement | { x: number; y: number };

/** How much clearance to leave between the menu and the window edge. */
const EDGE_GAP = 8;

/** The gap between an element anchor and the menu hanging off it. */
const ANCHOR_GAP = 4;

/** How many rows a menu shows before it scrolls.
 *
 *  The HALF is the whole point. Cutting a menu off at a whole number of rows
 *  produces a panel that looks complete and is not: a board with thirty tags
 *  in one category would read as having ten. Half a row hanging off the
 *  bottom edge is the only thing on screen that says keep going, which is why
 *  the scrollbar can be hidden without leaving the list a trap. */
const MAX_ROWS = 8.5;

/**
 * Caps a rendered level at MAX_ROWS and lets the rest scroll.
 *
 * MEASURED, not a fixed pixel figure. A row's height comes from its padding
 * and its font size, both of which are theme-facing CSS, and a hardcoded
 * max-height here would quietly become nine and a half rows the day either
 * changes.
 *
 * And measured WHERE THE ROWS ACTUALLY ARE, not as row height times ten and a
 * half. Separators take up height too, so that sum landed the cut short by a
 * separator's worth each time one came before it: with the right number of
 * rule lines above, the cut fell on a row's edge and the half row that says
 * "there is more" disappeared (the Whiteboard's grouped menus did exactly
 * this). The cut is placed through the middle of the row itself instead, so
 * whatever sits above it, the half row is always a half row.
 *
 * Also the one thing keeping a long menu inside the window: before this, a
 * level taller than the viewport was placed at the top edge and simply ran
 * off the bottom with no way to reach the rest.
 *
 * Called on every draw, because each level has its own length.
 */
function capHeight(menu: HTMLElement): void {
  // Cleared first: the cap is measured from the rows, and one left over from
  // the taller level we just replaced is what they would measure against.
  menu.style.maxHeight = "";

  const rows = menu.querySelectorAll<HTMLElement>(":scope > .menu-item");
  if (rows.length === 0) return;
  const style = getComputedStyle(menu);

  /** The panel's own padding and border: what surrounds the rows. */
  const frame =
    parseFloat(style.paddingTop) +
    parseFloat(style.paddingBottom) +
    parseFloat(style.borderTopWidth) +
    parseFloat(style.borderBottomWidth);

  /* Read rather than assumed, because this file does not own menu.css and a
     global reset could turn up later. Under border-box, max-height is
     measured from the outer edge, which is where the cut below is measured
     from; under content-box the top padding and border sit outside it, and
     the window budget has to make room for the frame instead. */
  const borderBox = style.boxSizing === "border-box";

  /* The row the cut goes through: the eleventh, for ten and a half. A level
     with no such row is short enough to show whole, so only the window caps
     it. Back counts as a row here, because it takes a row's space. */
  const whole = Math.floor(MAX_ROWS);
  const cutRow = rows[whole];
  let budget = Infinity;
  if (cutRow) {
    const box = menu.getBoundingClientRect();
    const at = cutRow.getBoundingClientRect();
    // From the panel's outer top edge to the line through that row.
    // scrollTop because a rebuilt level may still be scrolled when measured.
    const cut = at.top - box.top + menu.scrollTop + at.height * (MAX_ROWS - whole);
    budget = borderBox
      ? cut
      : cut - parseFloat(style.paddingTop) - parseFloat(style.borderTopWidth);
  }
  const rowHeight = rows[0].getBoundingClientRect().height;
  /* Never taller than the window either, however few rows that comes to. It
     is also the only thing stopping a long level running off the bottom edge
     with no way to reach the rest: before this there was no cap at all. */
  const ceiling = window.innerHeight - EDGE_GAP * 2 - (borderBox ? 0 : frame);

  // One row is the floor. A window too short for even that is better scrolled
  // than collapsed to nothing.
  menu.style.maxHeight = `${Math.max(rowHeight, Math.min(budget, ceiling))}px`;
}

/** Drops separators that would rule off nothing: one at either end of a
 *  level, and any run of them collapsed to a single line. Lets a caller build
 *  a menu by concatenation without having to know which of its parts came
 *  back empty. */
function tidySeparators(level: MenuItem[]): MenuItem[] {
  const out: MenuItem[] = [];
  for (const item of level) {
    if (!item.separator) {
      out.push(item);
      continue;
    }
    if (out.length > 0 && !out[out.length - 1].separator) out.push(item);
  }
  while (out.length > 0 && out[out.length - 1].separator) out.pop();
  return out;
}

let openMenuEl: HTMLElement | null = null;

/** Aborting this tears down every dismissal listener the open menu
 *  registered, in one call, without having to hold a reference to each. */
let menuDismiss: AbortController | null = null;

/** Closes whatever menu is open. Safe to call when none is. Worth calling
 *  from the onClosed hook of any modal a menu can be opened from, so the menu
 *  does not outlive the surface it belongs to. */
export function closeMenu(): void {
  openMenuEl?.remove();
  openMenuEl = null;
  menuDismiss?.abort();
  menuDismiss = null;
}

/** True while a menu is on screen. For callers that need to suppress a
 *  competing gesture (a drag, a hover preview) while one is up. */
export function isMenuOpen(): boolean {
  return openMenuEl !== null;
}

/** How a caller hands its rows over.
 *
 *  A plain array is the common case: the rows are decided when the menu
 *  opens and nothing about them changes while it is up.
 *
 *  A FUNCTION is what a menu containing `keepOpen` rows needs. Those rows
 *  change the very thing the menu is describing, so after one runs the panel
 *  has to be built again from the new state rather than redrawn from the list
 *  it was opened with. Passing the builder rather than its output is what
 *  makes that possible. */
export type MenuItems = MenuItem[] | (() => MenuItem[]);

/** Opens a menu at `anchor`. Replaces any menu already open. */
export function openMenu(anchor: MenuAnchor, items: MenuItems): void {
  closeMenu();

  const build: () => MenuItem[] = typeof items === "function" ? items : () => items;

  const top = build();
  // Separators alone are not a menu: a caller that assembled every group out
  // of nothing would otherwise get an empty panel with a rule in it.
  if (top.length === 0 || top.every((item) => item.separator === true)) return;

  /* The check above already built the tree, so the first draw uses that one
     rather than asking for another. Not about the cost: a builder is allowed
     to have a side effect (the card menu drops a stale selection as it
     builds), and running it twice for one opening would run that twice. */
  let firstBuild: MenuItem[] | null = top;
  const buildOnce = (): MenuItem[] => {
    const tree = firstBuild ?? build();
    firstBuild = null;
    return tree;
  };

  const menu = document.createElement("div");
  menu.className = "menu";
  // A menu is a list of commands, so it says so: without this a screen reader
  // reads a bare stack of buttons with no indication they belong together.
  menu.setAttribute("role", "menu");

  /* WHERE WE ARE, HELD AS KEYS RATHER THAN AS THE ROWS THEMSELVES.
     The drill-down path used to be the actual MenuItem arrays, passed down as
     the level to go back to. That cannot survive a rebuild: a keepOpen row
     inside a submenu produces a whole new tree, and the arrays we were
     holding belong to the old one. So the path is re-walked by something the
     two trees have in common: each row's key, which is its label unless the
     label changes on the click itself (see MenuItem.key). */
  const trail: string[] = [];

  /** The level `trail` points at, built fresh from the caller each time.
   *  Null when a rebuild no longer has that submenu in it, which is the
   *  honest answer for a category whose last tag was just deleted. */
  const levelAt = (): MenuItem[] | null => {
    let level = buildOnce();
    for (const step of trail) {
      const row = level.find((i) => !i.separator && (i.key ?? i.label) === step && i.submenu);
      if (!row?.submenu || row.submenu.length === 0) return null;
      level = row.submenu;
    }
    return level;
  };

  /** Fills the panel with one level, growing a "‹ Back" row whenever there is
   *  somewhere to go back to. */
  const renderLevel = (level: MenuItem[]): void => {
    menu.textContent = "";

    if (trail.length > 0) {
      const backBtn = document.createElement("button");
      backBtn.type = "button";
      backBtn.className = "menu-item menu-item-back";
      backBtn.setAttribute("role", "menuitem");
      backBtn.textContent = "‹ Back";
      backBtn.addEventListener("click", () => {
        trail.pop();
        render();
      });
      menu.appendChild(backBtn);
    }

    for (const item of tidySeparators(level)) {
      if (item.separator) {
        const rule = document.createElement("div");
        rule.className = "menu-sep";
        // Presentational: a screen reader reading the rows in order already
        // hears where one group ends, and "separator" announced aloud is not
        // information a listener can act on.
        rule.setAttribute("aria-hidden", "true");
        menu.appendChild(rule);
        continue;
      }

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "menu-item";
      btn.setAttribute("role", "menuitem");
      if (item.danger) btn.classList.add("menu-item-danger");
      btn.disabled = item.disabled === true;

      /** What clicking the row does, once its contents are in place. */
      const activate = (): void => {
        if (item.keepOpen) {
          // The panel is about to be thrown away and built again, so the
          // scroll position has to be carried across by hand or a long tag
          // list jumps back to the top on every tick.
          const scroll = menu.scrollTop;
          item.onClick?.();
          render();
          menu.scrollTop = scroll;
          return;
        }
        closeMenu();
        item.onClick?.();
      };

      if (item.submenu && item.submenu.length > 0) {
        btn.classList.add("menu-item-parent");
        // The chevron is a separate element rather than part of the label so
        // it can be pushed to the right edge whatever the label's length.
        const text = document.createElement("span");
        text.textContent = item.label ?? "";
        const chevron = document.createElement("span");
        chevron.className = "menu-item-chevron";
        chevron.textContent = "›";
        // Decorative: the label already says what the row does, and a screen
        // reader announcing a lone "›" after it is noise.
        chevron.setAttribute("aria-hidden", "true");
        btn.append(text, chevron);
        btn.addEventListener("click", () => {
          trail.push(item.key ?? item.label ?? "");
          render();
        });
      } else if (item.swatch) {
        // Swatch then label, as two elements, so the color is a block rather
        // than a character and the labels below it still line up.
        const dot = document.createElement("span");
        dot.className = "menu-item-swatch";
        dot.style.background = item.swatch;
        dot.setAttribute("aria-hidden", "true");
        const text = document.createElement("span");
        text.textContent = item.label ?? "";
        btn.append(dot, text);
        btn.addEventListener("click", activate);
      } else {
        btn.textContent = item.label ?? "";
        btn.addEventListener("click", activate);
      }

      menu.appendChild(btn);
    }

    capHeight(menu);
  };

  /** Draws whatever `trail` now points at, and places the panel again: a
   *  level reached by drilling in is a different height from the one it
   *  replaced. Closes instead when the path has gone. */
  const render = (): void => {
    const level = levelAt();
    if (!level || level.length === 0) {
      closeMenu();
      return;
    }
    renderLevel(level);
    positionMenu(menu, anchor);
  };

  // A menu never takes focus. Pressing a <button> focuses it, which blurs
  // whatever had focus before, and the text-field menu (edit-menu.ts) acts on
  // the field's live selection: losing it between the right-click and the
  // click on Copy would leave nothing to copy. Canceling mousedown is the
  // one thing that suppresses the focus shift while still letting the click
  // through. Nothing in the app drives a menu by keyboard, so there is
  // nothing here that wanted the focus.
  menu.addEventListener("mousedown", (e) => e.preventDefault());

  // Appended before the first draw: both the height cap and the placement
  // math need the menu's real measured size, which does not exist until it is
  // in the document.
  document.body.appendChild(menu);
  render();

  openMenuEl = menu;
  menuDismiss = new AbortController();
  const signal = menuDismiss.signal;

  // Dismissal is registered on the NEXT frame. Registering it now would let
  // the very click (or right-click) that opened the menu carry on bubbling up
  // to the document and immediately close it again.
  requestAnimationFrame(() => {
    if (signal.aborted) return;
    document.addEventListener(
      "pointerdown",
      (e) => {
        if (!menu.contains(e.target as Node)) closeMenu();
      },
      { signal },
    );
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Escape") closeMenu();
      },
      { signal },
    );
    // A menu is positioned in fixed viewport coordinates against a layout that
    // is about to change, so it is closed rather than chased.
    window.addEventListener("resize", closeMenu, { signal });
  });
}

/* =============================================================================
   RIGHT-CLICK WIRING
   -----------------------------------------------------------------------------
   Two helpers so a caller writes the menu's CONTENTS and nothing else. Both
   cancel the default and open at the cursor; the difference is only whether
   the rows are hung on one element or on many.

   Returning null (or an empty list) from the builder means "nothing specific
   to offer here", and the event is left to carry on up to shell.ts, which
   answers it with the app-wide background menu.
============================================================================= */

/** Right-click on `target` opens a menu at the cursor.
 *
 *  `build` runs per click, so the rows can reflect the state at that moment
 *  (a card's current column, whether an entry is already logged). Pass a
 *  plain array instead when the rows never change. */
export function attachMenu(
  target: HTMLElement,
  build: MenuItem[] | ((e: MouseEvent) => MenuItem[] | null),
): void {
  target.addEventListener("contextmenu", (e) => {
    // A text field inside the target keeps Cut/Copy/Paste; the event is left
    // to reach shell.ts, which opens the editing menu for it.
    if (isTextEntry(e.target)) return;
    const items = typeof build === "function" ? build(e) : build;
    if (!items || items.length === 0) return;
    e.preventDefault();
    // Rows nest (a card inside a column inside a board). Without this the
    // outer element's handler would fire next and replace the menu the inner
    // one just opened, so the most specific target always wins.
    e.stopPropagation();
    // The BUILDER goes in, not just the rows it produced, so a keepOpen row
    // can rebuild against the state its own click left behind. The rows in
    // hand are handed over for the first draw so the builder still runs
    // exactly once per opening.
    if (typeof build !== "function") {
      openMenu({ x: e.clientX, y: e.clientY }, items);
      return;
    }
    let first: MenuItem[] | null = items;
    openMenu({ x: e.clientX, y: e.clientY }, () => {
      const rows = first ?? build(e) ?? [];
      first = null;
      return rows;
    });
  });
}

/** One listener on `container` serving every descendant matching `selector`.
 *
 *  For lists that are re-rendered wholesale, or built as a single innerHTML
 *  pass, where per-row listeners would either be thrown away on every render
 *  or number in the thousands (RNGesus does exactly this). `build` receives
 *  the matched row element. */
export function attachMenuDelegated(
  container: HTMLElement,
  selector: string,
  build: (row: HTMLElement, e: MouseEvent) => MenuItem[] | null,
): void {
  container.addEventListener("contextmenu", (e) => {
    if (isTextEntry(e.target)) return;
    const row = (e.target as HTMLElement | null)?.closest<HTMLElement>(selector);
    if (!row || !container.contains(row)) return;
    const items = build(row, e);
    if (!items || items.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    let first: MenuItem[] | null = items;
    openMenu({ x: e.clientX, y: e.clientY }, () => {
      const rows = first ?? build(row, e) ?? [];
      first = null;
      return rows;
    });
  });
}

/**
 * The elements that get the text-editing menu (Cut / Copy / Paste / Select All
 * / Undo / Redo) instead of whatever the surrounding row would have offered. A
 * non-text input (checkbox, range, color, file) has nothing to cut or paste, so
 * it is treated like the rest of the page.
 *
 * A readonly field still qualifies: Copy and Select All are the point there.
 *
 * THIS FILE OWNS IT, and shell.ts imports it from here rather than the other
 * way around. menu.ts imports nothing, which is what keeps it safe to pull into
 * any module without risking a load-order loop, and that stays true only while
 * the shared thing lives at this end. It used to be a copy at each end with a
 * comment on one of them saying so.
 */
export function isTextEntry(target: EventTarget | null): boolean {
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  if (target instanceof HTMLInputElement) {
    return /^(text|search|url|tel|email|password|number|)$/.test(target.type);
  }
  return false;
}

/** Places `menu` against `anchor`, kept inside the window.
 *
 *  Both anchor forms reduce to the same problem: a preferred position, and a
 *  fallback for when the menu would run off the bottom. An element flips to
 *  sit ABOVE itself, so the control that opened the menu stays visible; a
 *  point clamps upward instead, because a cursor has no height to flip
 *  around and shifting it up keeps the menu under the pointer. */
function positionMenu(menu: HTMLElement, anchor: MenuAnchor): void {
  const size = menu.getBoundingClientRect();
  const maxLeft = window.innerWidth - size.width - EDGE_GAP;
  let left: number;
  let top: number;

  if (anchor instanceof HTMLElement) {
    const rect = anchor.getBoundingClientRect();
    left = Math.min(rect.left, maxLeft);
    top =
      rect.bottom + size.height + EDGE_GAP > window.innerHeight
        ? Math.max(EDGE_GAP, rect.top - size.height - ANCHOR_GAP)
        : rect.bottom + ANCHOR_GAP;
  } else {
    left = Math.min(anchor.x, maxLeft);
    top = Math.min(anchor.y, window.innerHeight - size.height - EDGE_GAP);
  }

  menu.style.left = `${Math.max(EDGE_GAP, left)}px`;
  menu.style.top = `${Math.max(EDGE_GAP, top)}px`;
}
