/* =============================================================================
   MENU: shared primitive
   -----------------------------------------------------------------------------
   The app's small floating command list: a column of labelled buttons that
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

   -----------------------------------------------------------------------------
   WIRING A RIGHT-CLICK MENU

   shell.ts already cancels the webview's own menu everywhere except text
   fields, and does it on the bubbling phase, so an element's own handler runs
   first and this is all a caller needs:

     el.addEventListener("contextmenu", (e) => {
       e.preventDefault();
       openMenu({ x: e.clientX, y: e.clientY }, [ ...items ]);
     });

   Styling lives in menu.css, linked from index.html.
============================================================================= */

/** One row of a menu. */
export interface MenuItem {
  /** The row's text. Plain text, never markup. */
  label: string;
  /** Runs after the menu has closed, so the action can open a modal of its
   *  own without the menu still sitting over it. Ignored when `submenu` is
   *  set: that row's job is to open the submenu. */
  onClick?: () => void;
  /** Turns the row into a drill-down into these items. See DRILL-DOWN below. */
  submenu?: MenuItem[];
  /** Renders in the danger color. For destructive rows (Delete, Remove). */
  danger?: boolean;
  /** Greys the row out and makes it unclickable. Prefer this over omitting a
   *  row that is sometimes available: a menu whose length changes is harder
   *  to build muscle memory for than one with a greyed-out entry. */
  disabled?: boolean;
}

/* -----------------------------------------------------------------------------
   DRILL-DOWN, NOT FLYOUT

   A row with a `submenu` replaces the menu's contents in place and grows a
   "‹ Back" row at the top, rather than opening a panel off the side.

   That is a deliberate choice, not a shortcut. A side flyout needs hover
   intent (so crossing a neighbouring row on the diagonal does not swap the
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

/** Opens a menu at `anchor`. Replaces any menu already open. */
export function openMenu(anchor: MenuAnchor, items: MenuItem[]): void {
  closeMenu();
  if (items.length === 0) return;

  const menu = document.createElement("div");
  menu.className = "menu";
  // A menu is a list of commands, so it says so: without this a screen reader
  // reads a bare stack of buttons with no indication they belong together.
  menu.setAttribute("role", "menu");

  /** Fills the panel with one level. `back` is the level to return to, or
   *  null at the top. Re-entrant: a submenu row calls it again. */
  const renderLevel = (level: MenuItem[], back: MenuItem[] | null): void => {
    menu.textContent = "";

    if (back) {
      const backBtn = document.createElement("button");
      backBtn.type = "button";
      backBtn.className = "menu-item menu-item-back";
      backBtn.setAttribute("role", "menuitem");
      backBtn.textContent = "‹ Back";
      backBtn.addEventListener("click", () => {
        renderLevel(back, null);
        // The level being returned to is usually taller, so it can now hang
        // off the bottom of the window if it was opened low down.
        positionMenu(menu, anchor);
      });
      menu.appendChild(backBtn);
    }

    for (const item of level) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "menu-item";
      btn.setAttribute("role", "menuitem");
      if (item.danger) btn.classList.add("menu-item-danger");
      btn.disabled = item.disabled === true;

      if (item.submenu && item.submenu.length > 0) {
        btn.classList.add("menu-item-parent");
        // The chevron is a separate element rather than part of the label so
        // it can be pushed to the right edge whatever the label's length.
        const text = document.createElement("span");
        text.textContent = item.label;
        const chevron = document.createElement("span");
        chevron.className = "menu-item-chevron";
        chevron.textContent = "›";
        // Decorative: the label already says what the row does, and a screen
        // reader announcing a lone "›" after it is noise.
        chevron.setAttribute("aria-hidden", "true");
        btn.append(text, chevron);
        btn.addEventListener("click", () => {
          renderLevel(item.submenu!, level);
          positionMenu(menu, anchor);
        });
      } else {
        btn.textContent = item.label;
        btn.addEventListener("click", () => {
          closeMenu();
          item.onClick?.();
        });
      }

      menu.appendChild(btn);
    }
  };

  renderLevel(items, null);

  // Appended before positioning: the placement math needs the menu's real
  // measured size, which does not exist until it is in the document.
  document.body.appendChild(menu);
  positionMenu(menu, anchor);

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

   Returning null (or an empty list) from the builder means "no menu here",
   and the event is left alone so the webview's own menu still appears. That
   is the right behaviour for a text field inside a row.
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
    // A text field inside the target keeps its own Cut/Copy/Paste; see the
    // contextmenu handler in shell.ts, which makes the same exemption.
    if (isTextEntry(e.target)) return;
    const items = typeof build === "function" ? build(e) : build;
    if (!items || items.length === 0) return;
    e.preventDefault();
    // Rows nest (a card inside a column inside a board). Without this the
    // outer element's handler would fire next and replace the menu the inner
    // one just opened, so the most specific target always wins.
    e.stopPropagation();
    openMenu({ x: e.clientX, y: e.clientY }, items);
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
    openMenu({ x: e.clientX, y: e.clientY }, items);
  });
}

/** Mirrors shell.ts's isTextEntry(): the elements whose native right-click
 *  menu (Cut / Copy / Paste / Select All) is worth more than an app menu.
 *  Duplicated rather than imported because menu.ts imports nothing, which is
 *  what keeps it safe to pull into any module without risking a load-order
 *  loop. It is six lines and the rule has not changed since inputs existed. */
function isTextEntry(target: EventTarget | null): boolean {
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
