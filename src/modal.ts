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

   Content and per-modal wiring stay in the owning file (shell.ts / a tool .ts);
   this primitive only handles the chrome and behaviour. Per-modal hooks:
     onOpen(): runs after the modal is displayed (load content, reset tabs…)
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
    this.opts.onOpen?.();
  }

  close(): void {
    if (!this.isOpen) return;

    const i = openStack.indexOf(this);
    if (i !== -1) openStack.splice(i, 1);

    this.backdrop.classList.remove("open");
    // Deactivate the shared overlay when the last modal closes
    syncOverlay();

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
