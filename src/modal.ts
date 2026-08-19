/* =============================================================================
   MODAL: shared primitive
   -----------------------------------------------------------------------------
   Wraps a `.modal-backdrop` element (which contains a single `.modal` panel) and
   owns every behaviour common to all modals in the app:

     • open / close lifecycle (display + .open class + transition-end teardown)
     • body.modal-open toggling
     • a single shared open-stack so Escape closes only the TOP-most modal
     • z-index stacking by depth (so a modal opened over another sits above it)
     • header-region drag (grab the top chrome strip to move its modal) + reset-on-close
     • automatic scroll reset of the inner .modal-body on open and after close
     • tab strips, via ModalTabs (see below) passed as the `tabs` option

   Content and per-modal wiring stay in the owning file (shell.ts / a tool .ts);
   this primitive only handles the chrome and behaviour. Per-modal hooks:
     onOpen(): runs after the modal is displayed (load content…)
     onClosed(): runs after the close transition finishes & display:none is set
                  (collapse resets, extra scroll resets, etc.)

   A single global open-hook (setGlobalModalOpenHook) runs before every open so
   theme-level concerns (e.g. regenerative random palette) stay out of here.
============================================================================= */

export interface ModalOptions {
  /** Close when the dimmed backdrop (outside the panel) is clicked. Default false. */
  closeOnBackdrop?: boolean;
  /** Close when Escape is pressed while this modal is the top-most. Default true. */
  closeOnEsc?: boolean;
  /**
   * This modal's tab strip, if it has one. Handing it over means the primitive
   * owns the whole tab lifecycle: it re-activates the current tab on open,
   * queues pane scroll resets on close, and returns to the first tab on a real
   * close so the next fresh open starts there. See ModalTabs.
   */
  tabs?: ModalTabsController;
  /** Runs after the modal is shown (content load, tab reset, etc.). */
  onOpen?: () => void;
  /** Runs after the close transition completes and display is set to none. */
  onClosed?: () => void;
  /**
   * When set, opening this modal immediately closes the given parent modal so
   * they replace rather than stack. The parent's onClosed hook is NOT fired.
   * The caller re-opens the parent if needed (e.g. via a back-arrow button).
   * Standard pattern for secondary modals (bill editor, encryption settings…)
   * that should replace a parent rather than layer on top of it.
   */
  replaceModal?: Modal;
}

/* -----------------------------------------------------------------------------
   ModalTabs
   ---------------------------------------------------------------------------
   The one way to do tabs inside a modal. Pair it with the .modal-tabs /
   .modal-tab / .modal-tab-pane markup documented in modal.css and a tabbed
   modal needs no switching code of its own:

     const tabs = new ModalTabs({
       scope: "#budgetSetupModal",     // which modal's tabs these are
       key: "budgetTab",               // dataset key on each .modal-tab button
       panes: { sources: "budgetTabSources", bills: "budgetTabBills" },
     });
     new Modal(backdrop, { tabs, onOpen: () => renderLists() });

   Scoping matters: .modal-tab is shared app-wide, so an unscoped query would
   toggle every modal's tabs at once.

   Which tab you land on:
     • Opening the modal fresh starts on the FIRST tab in `panes` (or whatever
       `defaultTab` returns, for a modal with a smarter idea of "first").
     • Leaving for a child modal and coming back keeps the tab you were on.
   Both fall out of one rule, that a real close forgets the current tab, while
   the two ways a modal steps aside for a child do not: `replaceModal` (which
   never fires the parent's close path) and close({ handoff: true }).

   Pane scroll position is reset on close too, but applied lazily: scrollTop on
   a display:none element is a no-op, so each pane is flagged here and reset at
   the moment it is next made visible.
----------------------------------------------------------------------------- */

/** The slice of ModalTabs that Modal itself drives. Kept generic-free so a
 *  Modal can hold a ModalTabs of any tab-id union without the option type
 *  having to name it. */
export interface ModalTabsController {
  restore(): void;
  reset(): void;
}

export interface ModalTabsOptions<T extends string> {
  /** Selector for the modal panel that owns these tabs, e.g. "#settingsModal". */
  scope: string;
  /** camelCase dataset key on each .modal-tab button, e.g. "budgetTab". */
  key: string;
  /**
   * Tab id → pane element id. Insertion order matters: the first tab is where
   * a fresh open lands unless defaultTab says otherwise. Several tabs MAY name
   * the same pane (the theme picker's Main/Holiday/Special/Custom all render
   * into one grid); the pane then shows for any of them.
   */
  panes: Record<T, string>;
  /**
   * Where a FRESH open lands, if not simply the first tab. Evaluated at open
   * time, so it can read current app state. The theme picker uses it to open
   * on whichever tab houses the theme in use.
   */
  defaultTab?: () => T;
  /** Runs after a tab is activated, for panes that need rendering on show. */
  onActivate?: (tab: T) => void;
}

export class ModalTabs<T extends string> implements ModalTabsController {
  private opts: ModalTabsOptions<T>;
  private readonly first: T;
  /** null means "next open is a fresh one", see reset(). */
  private current: T | null = null;
  private pendingScrollReset = new Set<string>();

  constructor(opts: ModalTabsOptions<T>) {
    this.opts = opts;
    this.first = Object.keys(opts.panes)[0] as T;

    this.buttons().forEach((btn) => {
      btn.addEventListener("click", () => {
        const tab = btn.dataset[opts.key] as T | undefined;
        if (tab) this.activate(tab);
      });
    });
  }

  private buttons(): HTMLButtonElement[] {
    return Array.from(
      document.querySelectorAll<HTMLButtonElement>(`${this.opts.scope} .modal-tab`),
    );
  }

  /** The tab that would show right now: the one in use, or the fresh-open default. */
  get active(): T {
    return this.current ?? this.opts.defaultTab?.() ?? this.first;
  }

  /** Selects a tab: marks its button and shows its pane, hiding the others. */
  activate(tab: T): void {
    this.current = tab;

    this.buttons().forEach((btn) => {
      btn.classList.toggle("active", btn.dataset[this.opts.key] === tab);
    });

    // Keyed by pane id, not tab id, so panes shared by several tabs resolve
    // once and don't fight each other over display.
    const activePane = this.opts.panes[tab];
    for (const id of new Set(Object.values(this.opts.panes) as string[])) {
      const pane = document.getElementById(id);
      if (!pane) continue;
      const isActive = id === activePane;
      pane.style.display = isActive ? "" : "none";
      // Earliest point a queued scroll reset can actually take effect.
      if (isActive && this.pendingScrollReset.has(id)) {
        pane.scrollTop = 0;
        this.pendingScrollReset.delete(id);
      }
    }

    this.opts.onActivate?.(tab);
  }

  /**
   * Chooses the tab the NEXT open lands on, without touching the DOM.
   *
   * For callers that pick a tab and then open the modal (a deep link into one
   * tab, a child modal handing back to a specific tab). Going through activate()
   * there would render the tab twice, once for the caller and once for the
   * open, which matters when onActivate does real work.
   */
  select(tab: T): void {
    this.current = tab;
  }

  /** Shows the tab in use, or the fresh-open default. What Modal runs on open. */
  restore(): void {
    this.activate(this.active);
  }

  /** Marks the next open as fresh and queues every pane for a scroll reset.
   *  What Modal runs on a real close, so reopening starts from the top. */
  reset(): void {
    this.current = null;
    Object.values(this.opts.panes).forEach((id) =>
      this.pendingScrollReset.add(id as string),
    );
  }
}

/* -----------------------------------------------------------------------------
   Module-level shared state. One stack and one set of global listeners for the
   whole app, regardless of how many Modal instances exist.
----------------------------------------------------------------------------- */

const openStack: Modal[] = [];
let listenersBound = false;
let globalOpenHook: (() => void) | null = null;

const BASE_Z = 1000;

// Must be >= the longest close transition in modal.css (.modal transform 0.25s).
const MODAL_FADE_MS = 280;

// Shared dim + blur overlay. One element, always a single layer.
// Activated when the first modal opens, deactivated when the last closes.
const _overlay = document.getElementById("modalOverlay")!;

/** Syncs the shared overlay: active whenever any modal is in the open stack. */
function syncOverlay(): void {
  _overlay.classList.toggle("active", openStack.length > 0);
}

/** Registers a callback run immediately before every modal opens.
 *  Used by the shell to regenerate the random palette on open without this
 *  primitive needing any knowledge of the theme system. */
export function setGlobalModalOpenHook(fn: () => void): void {
  globalOpenHook = fn;
}

function topModal(): Modal | undefined {
  return openStack[openStack.length - 1];
}

function syncBodyClass(): void {
  // body.modal-open blocks body scroll while any modal is open.
  // Handled here (not per-modal) so the class tracks the full open stack.
  document.body.classList.toggle("modal-open", openStack.length > 0);
}

/* -----------------------------------------------------------------------------
   Global listeners, bound once, on first open.
   Escape: close only the top-most modal (if it allows Escape).
   Drag:   grab the top strip (top padding + header row) to move its .modal;
           position is reset on close.
----------------------------------------------------------------------------- */

function bindGlobalListeners(): void {
  if (listenersBound) return;
  listenersBound = true;

  // Escape closes the top-most modal only.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const top = topModal();
    if (top && top.escEnabled) {
      e.preventDefault();
      top.close();
    }
  });

  // Header-region drag, start a drag when the press lands in the top "chrome"
  // strip of a modal: the top padding plus the full-width header row. Anything at
  // or below the header's bottom edge (the body, the side padding beside it, the
  // header→body gap, and the bottom) is not a grab handle. Queried at pointerdown
  // so any modal (current or future) works.
  //
  // Pointer events + setPointerCapture instead of mouse events: with plain
  // mouse events, releasing the button OUTSIDE the window (or an alt-tab
  // mid-drag) means mouseup never fires, leaving a live document-level
  // mousemove handler and a modal glued to the cursor until the next click.
  // Capture guarantees the up/cancel event is delivered to the modal no
  // matter where the pointer is, and the AbortController tears down every
  // drag listener in one call on any of the three end conditions.
  document.addEventListener("pointerdown", (e: PointerEvent) => {
    if (e.button !== 0) return; // left button / primary touch only
    const target = e.target as HTMLElement;

    const modal = target.closest<HTMLElement>(".modal");
    if (!modal) return;

    // Don't start a drag from interactive children (buttons, inputs, links…).
    if (target.closest("button, input, select, a, label, textarea")) {
      return;
    }

    // The grab strip runs from the modal's top edge down to the bottom of the
    // header. No header → nothing to grab. (header rect excludes its margin, so
    // the header→body gap is intentionally not draggable.)
    const header = modal.querySelector<HTMLElement>(".modal-header");
    if (!header) return;
    if (e.clientY >= header.getBoundingClientRect().bottom) return;

    e.preventDefault();

    const rect = modal.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;

    // Switch from the centring transform to fixed positioning for the drag.
    modal.style.position = "fixed";
    modal.style.margin = "0";
    modal.style.left = `${rect.left}px`;
    modal.style.top = `${rect.top}px`;
    modal.style.transform = "none";

    modal.setPointerCapture(e.pointerId);

    const drag = new AbortController();

    function onMove(ev: PointerEvent): void {
      const x = Math.max(
        0,
        Math.min(ev.clientX - offsetX, window.innerWidth - modal!.offsetWidth),
      );
      const y = Math.max(
        0,
        Math.min(ev.clientY - offsetY, window.innerHeight - modal!.offsetHeight),
      );
      modal!.style.left = `${x}px`;
      modal!.style.top = `${y}px`;
    }

    function endDrag(): void {
      drag.abort(); // removes ALL listeners registered with this signal
      try {
        modal!.releasePointerCapture(e.pointerId);
      } catch {
        // capture may already be gone (e.g. pointercancel). Nothing to do
      }
    }

    // Capture retargets these to the modal even when the pointer is outside
    // the window, so endDrag is guaranteed to run.
    modal.addEventListener("pointermove", onMove, { signal: drag.signal });
    modal.addEventListener("pointerup", endDrag, { signal: drag.signal });
    modal.addEventListener("pointercancel", endDrag, { signal: drag.signal });
    modal.addEventListener("lostpointercapture", endDrag, { signal: drag.signal });
  });
}

/** Clears any inline drag positioning so the modal re-opens centred. */
function resetPanelPosition(modal: HTMLElement | null): void {
  if (!modal) return;
  modal.style.position = "";
  modal.style.margin = "";
  modal.style.left = "";
  modal.style.top = "";
  modal.style.transform = "";
}

/* -----------------------------------------------------------------------------
   Modal
----------------------------------------------------------------------------- */

export class Modal {
  private backdrop: HTMLElement;
  private panel: HTMLElement | null;
  private opts: ModalOptions;
  readonly escEnabled: boolean;

  constructor(backdrop: HTMLElement, opts: ModalOptions = {}) {
    this.backdrop = backdrop;
    this.panel = backdrop.querySelector<HTMLElement>(".modal");
    this.opts = opts;
    this.escEnabled = opts.closeOnEsc ?? true;

    bindGlobalListeners();

    // Backdrop (dimmed area) click, does NOT close by default. A modal can opt
    // back in with closeOnBackdrop: true. Only acts when this modal is on top.
    backdrop.addEventListener("click", (e) => {
      if (topModal() !== this) return;
      if (e.target === backdrop && opts.closeOnBackdrop === true) this.close();
    });

    // Any [data-modal-close] control inside the modal closes it.
    backdrop
      .querySelectorAll<HTMLElement>("[data-modal-close]")
      .forEach((btn) => btn.addEventListener("click", () => this.close()));
  }

  get isOpen(): boolean {
    return openStack.includes(this);
  }

  open(): void {
    if (this.isOpen) return;
    globalOpenHook?.();

    // Replace-mode: immediately hide the parent modal without firing its
    // onClosed hook. The overlay stays active. No flicker between modals.
    if (this.opts.replaceModal?.isOpen) {
      const parent = this.opts.replaceModal;
      const pi = openStack.indexOf(parent);
      if (pi !== -1) openStack.splice(pi, 1);
      parent.backdrop.classList.remove("open");
      parent.backdrop.style.display = "none";
      parent.backdrop.style.zIndex = "";
      // Reset panel position so it re-opens centred if returned to
      resetPanelPosition(parent.panel);
    }

    openStack.push(this);
    // Activate the shared overlay when the first modal opens (no-op if already active)
    syncOverlay();

    this.backdrop.style.zIndex = String(BASE_Z + openStack.length);
    this.backdrop.style.display = "flex";

    // Double RAF: first lets the browser commit display:flex so the panel
    // starts at opacity:0/scale:0.85; second triggers the transition.
    requestAnimationFrame(() => {
      const body = this.backdrop.querySelector<HTMLElement>(".modal-body");
      if (body) body.scrollTop = 0;
      requestAnimationFrame(() => {
        this.backdrop.classList.add("open");
      });
    });

    syncBodyClass();
    // Before onOpen, so a per-tab render hook sees the right tab selected.
    this.opts.tabs?.restore();
    this.opts.onOpen?.();
  }

  /**
   * Closes the modal.
   *
   * `handoff: true` means "another modal is taking over and will hand control
   * back here" (the Settings → Choose Theme → back flow, and friends). It skips
   * the tab reset so returning lands on the tab you left from, exactly as
   * `replaceModal` does for modals wired that way. Use it whenever a close is
   * immediately followed by opening a child modal with a back arrow.
   */
  close(opts: { handoff?: boolean } = {}): void {
    if (!this.isOpen) return;

    const i = openStack.indexOf(this);
    if (i !== -1) openStack.splice(i, 1);

    this.backdrop.classList.remove("open");
    // Deactivate the shared overlay when the last modal closes
    syncOverlay();

    if (!opts.handoff) this.opts.tabs?.reset();

    window.setTimeout(() => {
      if (this.isOpen) return;
      this.backdrop.style.display = "none";
      this.backdrop.style.zIndex = "";
      const body = this.backdrop.querySelector<HTMLElement>(".modal-body");
      if (body) body.scrollTop = 0;
      resetPanelPosition(this.panel);
      this.opts.onClosed?.();
    }, MODAL_FADE_MS);

    syncBodyClass();
  }

  /** The backdrop element, for callers that need direct access. */
  get root(): HTMLElement {
    return this.backdrop;
  }
}
