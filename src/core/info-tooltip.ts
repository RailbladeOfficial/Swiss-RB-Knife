/* =============================================================================
   INFO TOOLTIPS: the bubble behind an (i) button
   -----------------------------------------------------------------------------
   A click-to-toggle popover, not a modal: a floating explanation anchored under
   whichever icon was clicked. One bubble element for the whole app, moved and
   refilled per click, because only one of these is ever open at a time.

   Auto-Backup and Kanban had one of these each, and they had already drifted:
   Kanban's flips the bubble ABOVE the button when there is no room below, and
   Auto-Backup's did not, so an (i) near the bottom of a tall modal opened a
   bubble half off the screen. That is the bug this kind of duplication produces
   -- not two implementations disagreeing on purpose, but one of them quietly
   being older than the other. The shared one keeps the flip.

   The class name is passed in rather than fixed, because each tool styles its
   own bubble (`.ab-info-tooltip`, `.kb-info-tooltip`) to match the panel it
   opens over. The behavior is the shared part; the look is not.

   Imports nothing, so any tool can pull it in without load-order worries.
============================================================================= */

/** The single bubble, made on first use and reused forever after. */
let bubble: HTMLDivElement | null = null;
/** Which button opened it, so clicking that same button closes it again. */
let openedBy: HTMLButtonElement | null = null;

/** How far the bubble stays from the window's edges, and from its button. */
const EDGE_GAP = 8;
const BUTTON_GAP = 6;

/** Hides the bubble, if one is showing. Safe to call when none is. */
export function closeInfoTooltip(): void {
  bubble?.classList.remove("visible");
  openedBy = null;
}

/**
 * Shows `text` under `btn`, or hides it if that button's bubble is already up.
 *
 * `className` styles the bubble for the panel it opens over. Re-applied on
 * every call rather than once at creation, because the same bubble is shared by
 * every tool and the last one to use it left its own class on.
 */
export function toggleInfoTooltip(
  btn: HTMLButtonElement,
  text: string,
  className: string,
): void {
  if (openedBy === btn) {
    closeInfoTooltip();
    return;
  }
  if (!bubble) {
    bubble = document.createElement("div");
    document.body.appendChild(bubble);
  }
  bubble.className = className;
  bubble.textContent = text;
  bubble.classList.add("visible");

  /* Measured AFTER the text is set and the bubble is visible, so the clamping
     below works off the real rendered size rather than off zero. */
  const rect = btn.getBoundingClientRect();
  const width = bubble.offsetWidth;
  const height = bubble.offsetHeight;

  const left = Math.min(
    Math.max(EDGE_GAP, rect.left + rect.width / 2 - width / 2),
    window.innerWidth - width - EDGE_GAP,
  );
  // Flipped above the button when there is no room below, which there often is
  // not: these live in modals that can reach the bottom of the window.
  const top =
    rect.bottom + height + BUTTON_GAP + EDGE_GAP > window.innerHeight
      ? Math.max(EDGE_GAP, rect.top - height - BUTTON_GAP)
      : rect.bottom + BUTTON_GAP;

  bubble.style.left = `${left}px`;
  bubble.style.top = `${top}px`;
  openedBy = btn;
}

/**
 * Wires every `(i)` button under `container` that carries a `data-tooltip`, and
 * closes the bubble on any other click in the document.
 *
 * `selector` is the tool's own button class, so this only claims the buttons it
 * was pointed at.
 */
export function bindInfoTooltips(
  container: ParentNode,
  selector: string,
  className: string,
): void {
  container.querySelectorAll<HTMLButtonElement>(selector).forEach((btn) => {
    btn.addEventListener("click", (e) => {
      // Or the document listener below would see the same click and close the
      // bubble the instant it opened.
      e.stopPropagation();
      toggleInfoTooltip(btn, btn.dataset.tooltip ?? "", className);
    });
  });
  installDismissers();
}

/** The two ways a bubble goes away on its own. Installed once for the whole
 *  app rather than once per caller: both tools used to add their own pair, so
 *  two of each ran on every click. */
let dismissersInstalled = false;

function installDismissers(): void {
  if (dismissersInstalled) return;
  dismissersInstalled = true;
  // A click anywhere else, which is how a popover is expected to behave.
  document.addEventListener("click", () => closeInfoTooltip());
  // A resize moves the button the bubble was measured against, so it would be
  // left pointing at nothing.
  window.addEventListener("resize", () => closeInfoTooltip());
}
