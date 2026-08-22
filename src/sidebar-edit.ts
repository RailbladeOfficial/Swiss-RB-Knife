/* =============================================================================
   SIDEBAR ORDER / VISIBILITY  (Edit Sidebar modal)
   -----------------------------------------------------------------------------
   Split out of shell.ts. Everything here serves one feature: which tools appear
   in the sidebar, in what order, and the modal that edits that.

   Drives three surfaces from a single source of truth (settings.sidebarItems):
   the sidebar nav-items, the Home dashboard's .tool-card-grid, and the
   "Specific Tool" options in the On Startup select. Reordering/hiding here only
   ever moves/hides existing DOM nodes. It never touches a tool's own data or
   settings, so a re-shown tool picks up exactly where it left off.

   Imports from shell.ts and is imported back by it, which is a circular import.
   That is the existing shape of this codebase rather than something new, and it
   is safe here because nothing in this file reads an imported value while the
   file loads: every use is inside a function or an event handler. The check in
   scripts/checks/module-init.test.mjs enforces exactly that.
============================================================================= */

import { Modal } from "./modal";
import {
  ALL_TOOLS,
  SIDEBAR_SORT_MODES,
  type SidebarItemState,
  type SidebarSortMode,
  _activeViewKey,
  activateSection,
  applySidebarSortMode,
  flash,
  saveSettings,
  settings,
  settingsModal,
  startupSelect,
} from "./shell";

/* Element refs used only by this feature, moved here with it. */
const sidebarEditBtn = document.getElementById("sidebarEditBtn")!;
const sidebarEditBackdrop = document.getElementById("sidebarEditBackdrop")!;
const sidebarEditBack = document.getElementById("sidebarEditBack")!;
const sidebarEditClose = document.getElementById("sidebarEditClose")!;
const sidebarEditShownList = document.getElementById("sidebarEditShownList")!;
const sidebarEditHiddenList = document.getElementById("sidebarEditHiddenList")!;
const sidebarEditHiddenSection = document.getElementById("sidebarEditHiddenSection")!;
const sidebarHiddenBadge = document.getElementById("sidebarHiddenBadge")!;
const navListEl = document.getElementById("navList")!;
const toolCardGrid = document.querySelector<HTMLElement>(".tool-card-grid");

const SIDEBAR_DRAG_HANDLE_SVG = `
  <svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
    <circle cx="8" cy="6" r="1.6" /><circle cx="16" cy="6" r="1.6" />
    <circle cx="8" cy="12" r="1.6" /><circle cx="16" cy="12" r="1.6" />
    <circle cx="8" cy="18" r="1.6" /><circle cx="16" cy="18" r="1.6" />
  </svg>`;

// Same open-eye / eye-with-slash pair used elsewhere in the app to mark a
// visible vs. hidden item. The slashed version here is Budget's exact
// "Excluded from Charts" icon (see budget.ts's summary-row builder), reused
// verbatim so "hidden" reads identically everywhere in the app.
const EYE_SVG_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
const EYE_SHOWN_SVG = `<svg ${EYE_SVG_ATTRS}><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_HIDDEN_SVG = `<svg ${EYE_SVG_ATTRS}><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

/** Whether the given "section/tool" key is currently shown. Defaults to true
 *  for a key with no recorded state, normalizeSidebarItems() should always
 *  have added one for every known tool, so this is just a safety net. */
export function isToolPinned(key: string): boolean {
  return settings.sidebarItems.find((it) => it.key === key)?.pinned ?? true;
}

/** Re-syncs the "Specific Tool" options in the On Startup select with the
 *  current visibility state: hides/disables options for hidden tools so a
 *  user never sees (or can pick) a tool that isn't on the sidebar. If the
 *  currently-selected startup target IS one of those now-hidden options,
 *  falls back to "lastView" and persists the change, otherwise the select
 *  would be silently pointed at an option the user can no longer choose. */
function refreshStartupSelectOptions(): void {
  let selectedNowHidden = false;
  ALL_TOOLS.forEach((meta) => {
    const optValue = `${meta.section}:${meta.tool}`;
    const opt = startupSelect.querySelector<HTMLOptionElement>(
      `option[value="${optValue}"]`,
    );
    if (!opt) return;
    const shown = isToolPinned(meta.key);
    opt.hidden = !shown;
    opt.disabled = !shown;
    if (!shown && settings.startupTarget === optValue) selectedNowHidden = true;
  });

  if (selectedNowHidden) {
    settings.startupTarget = "lastView";
    saveSettings();
  }
  startupSelect.value = settings.startupTarget;
}

/** Updates the "Sidebar:" row's status badge in General Settings, hidden
 *  entirely when nothing is hidden, "N tools hidden" otherwise. Mirrors Time
 *  Tracker's CSV import status badge pattern. */
function refreshSidebarHiddenBadge(): void {
  const hiddenCount = settings.sidebarItems.filter((it) => !it.pinned).length;
  if (hiddenCount === 0) {
    sidebarHiddenBadge.style.display = "none";
    return;
  }
  sidebarHiddenBadge.textContent =
    hiddenCount === ALL_TOOLS.length
      ? "All tools hidden"
      : `${hiddenCount} ${hiddenCount === 1 ? "tool" : "tools"} hidden`;
  sidebarHiddenBadge.style.display = "";
}

/** Reorders and shows/hides the sidebar nav-items and Home dashboard
 *  tool-cards to match settings.sidebarItems, then re-syncs the On Startup
 *  select and the Settings-row status badge. Call after ANY change to
 *  settings.sidebarItems (drag, show/hide toggle, reset, or a fresh
 *  settings load). */
export function applySidebarOrder(): void {
  // Sorting happens here rather than only at the moment a sort button is
  // clicked, so the usage-driven modes stay live: opening a tool re-ranks the
  // sidebar on the spot instead of at next launch.
  applySidebarSortMode();

  const shownKeys = settings.sidebarItems.filter((it) => it.pinned).map((it) => it.key);
  const shownSet = new Set(shownKeys);

  // Move shown items into order (appendChild on an already-attached node
  // relocates it, repeated in desired order, this leaves everything in that
  // order without disturbing the fixed, non-reorderable nav-items around it:
  // the sidebar-toggle control and Home always stay first).
  shownKeys.forEach((key) => {
    const meta = ALL_TOOLS.find((t) => t.key === key);
    if (!meta) return;
    const li = document.querySelector<HTMLElement>(
      `.nav-item[data-section="${meta.section}"][data-tool="${meta.tool}"]`,
    );
    if (li) {
      li.style.display = "";
      navListEl.appendChild(li);
    }
    const card = toolCardGrid?.querySelector<HTMLElement>(
      `.tool-card[data-section="${meta.section}"][data-tool="${meta.tool}"]`,
    );
    if (card) {
      card.style.display = "";
      toolCardGrid!.appendChild(card);
    }
  });

  ALL_TOOLS.forEach((meta) => {
    if (shownSet.has(meta.key)) return;
    const li = document.querySelector<HTMLElement>(
      `.nav-item[data-section="${meta.section}"][data-tool="${meta.tool}"]`,
    );
    if (li) li.style.display = "none";
    const card = toolCardGrid?.querySelector<HTMLElement>(
      `.tool-card[data-section="${meta.section}"][data-tool="${meta.tool}"]`,
    );
    if (card) card.style.display = "none";
  });

  refreshStartupSelectOptions();
  refreshSidebarHiddenBadge();

  // Every path that changes tool visibility funnels through here, so this is
  // the one place a "sidebarchange" needs announcing. Tools that offer a
  // hand-off to another tool (Countdown Timer → Time Tracker) listen for it so they
  // can disable that offer when the target has been hidden.
  window.dispatchEvent(new CustomEvent("sidebarchange"));
}

/** Whether a tool is currently shown in the sidebar / on Home. Exported for
 *  tools that cross-link to another tool: a hand-off to something the user
 *  has deliberately hidden shouldn't be on offer. Keys are the same
 *  "section/tool" strings ALL_TOOLS uses. */
export function isToolVisible(key: string): boolean {
  return isToolPinned(key);
}

/** Shows or hides a tool, moving it to the end of its new group (shown
 *  entries stay a flat, freely-reorderable list; hidden entries have no
 *  meaningful order of their own). Persists immediately, re-renders both the
 *  live sidebar/Home and (if open) the Edit Sidebar modal, and, per spec,
 *  redirects to Home if the tool being hidden is the one currently open. */
function setPinned(key: string, shown: boolean): void {
  const item = settings.sidebarItems.find((it) => it.key === key);
  if (!item || item.pinned === shown) return;
  item.pinned = shown;

  const withoutItem = settings.sidebarItems.filter((it) => it.key !== key);
  const shownItems = withoutItem.filter((it) => it.pinned);
  const hiddenItems = withoutItem.filter((it) => !it.pinned);
  settings.sidebarItems = shown
    ? [...shownItems, item, ...hiddenItems]
    : [...shownItems, ...hiddenItems, item];

  applySidebarOrder();
  saveSettings();
  renderSidebarEditModal();

  if (!shown && _activeViewKey === key) {
    activateSection("home");
  }
}

// Tracks which shown row is mid-drag, shared by every row's dragover
// handler so a row can find (and move) the node actually being dragged.
let sidebarDragKey: string | null = null;

function attachSidebarDragHandlers(row: HTMLElement, key: string): void {
  row.draggable = true;

  row.addEventListener("dragstart", (e) => {
    sidebarDragKey = key;
    row.classList.add("dragging");
    e.dataTransfer?.setData("text/plain", key);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  });

  // dragend fires unconditionally (whether or not the drag ended over a
  // valid drop target) so the commit belongs here, not in "drop". Relying
  // on "drop" alone would leave the live (already-reordered) DOM out of
  // sync with settings.sidebarItems whenever the user releases outside any
  // row (e.g. drops on the modal's padding or off the modal entirely).
  row.addEventListener("dragend", () => {
    row.classList.remove("dragging");
    sidebarDragKey = null;
    commitShownOrderFromDom();
  });

  row.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (!sidebarDragKey || sidebarDragKey === key) return;
    const draggedEl = sidebarEditShownList.querySelector<HTMLElement>(
      `[data-key="${CSS.escape(sidebarDragKey)}"]`,
    );
    if (!draggedEl) return;
    const rect = row.getBoundingClientRect();
    const before = e.clientY - rect.top < rect.height / 2;
    row.parentElement?.insertBefore(draggedEl, before ? row : row.nextSibling);
  });

  // Still needed so the browser allows the drop to occur at all (without
  // this, some drop targets reject it and the row snaps back).
  row.addEventListener("drop", (e) => e.preventDefault());
}

/** Reads the shown list's current DOM order (post-drag) and writes it back
 *  into settings.sidebarItems, leaving the hidden group's order untouched. */
function commitShownOrderFromDom(): void {
  const orderedKeys = Array.from(
    sidebarEditShownList.querySelectorAll<HTMLElement>("[data-key]"),
  ).map((el) => el.dataset.key!);
  const hiddenItems = settings.sidebarItems.filter((it) => !it.pinned);
  settings.sidebarItems = [
    ...orderedKeys.map((key) => settings.sidebarItems.find((it) => it.key === key)!),
    ...hiddenItems,
  ];
  // A hand-placed order IS the mode from here on. Without this the active sort
  // would re-apply on the very next applySidebarOrder() and silently undo the
  // drag the user just made.
  settings.sidebarSort = "custom";
  applySidebarOrder();
  saveSettings();
  refreshSidebarSortButtons();
}

/** Marks whichever sort button matches the active mode. Nothing is marked
 *  under "custom", a dragged order isn't any of them. */
function refreshSidebarSortButtons(): void {
  document.querySelectorAll<HTMLButtonElement>(".sidebar-sort-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.sort === settings.sidebarSort);
  });
}

function buildSidebarEditRow(item: SidebarItemState, draggable: boolean): HTMLElement {
  const row = document.createElement("div");
  row.className = draggable ? "sidebar-edit-item" : "sidebar-edit-item sidebar-edit-item-hidden";
  row.dataset.key = item.key;

  const meta = ALL_TOOLS.find((t) => t.key === item.key);
  if (!meta) return row; // defensive, normalizeSidebarItems() guarantees a match

  const handle = document.createElement("span");
  handle.className = draggable
    ? "sidebar-edit-drag-handle"
    : "sidebar-edit-drag-handle sidebar-edit-drag-handle-disabled";
  handle.innerHTML = SIDEBAR_DRAG_HANDLE_SVG;
  handle.title = "Drag to reorder";
  row.appendChild(handle);

  const iconWrap = document.createElement("span");
  iconWrap.className = "sidebar-edit-icon";
  const sourceIcon = document.querySelector(
    `.nav-item[data-section="${meta.section}"][data-tool="${meta.tool}"] .nav-icon`,
  );
  if (sourceIcon) iconWrap.appendChild(sourceIcon.cloneNode(true));
  row.appendChild(iconWrap);

  const name = document.createElement("span");
  name.className = "sidebar-edit-name";
  name.textContent = meta.label;
  row.appendChild(name);

  const visibilityBtn = document.createElement("button");
  visibilityBtn.className = item.pinned
    ? "sidebar-edit-visibility-btn"
    : "sidebar-edit-visibility-btn is-hidden";
  visibilityBtn.innerHTML = item.pinned ? EYE_SHOWN_SVG : EYE_HIDDEN_SVG;
  visibilityBtn.title = item.pinned
    ? "Hide from sidebar and Home"
    : "Show on sidebar and Home";
  visibilityBtn.addEventListener("click", () => setPinned(item.key, !item.pinned));
  row.appendChild(visibilityBtn);

  if (draggable) attachSidebarDragHandlers(row, item.key);

  return row;
}

function renderSidebarEditModal(): void {
  sidebarEditShownList.innerHTML = "";
  sidebarEditHiddenList.innerHTML = "";

  const shown = settings.sidebarItems.filter((it) => it.pinned);
  const hidden = settings.sidebarItems.filter((it) => !it.pinned);

  shown.forEach((it) => sidebarEditShownList.appendChild(buildSidebarEditRow(it, true)));
  hidden.forEach((it) => sidebarEditHiddenList.appendChild(buildSidebarEditRow(it, false)));

  sidebarEditHiddenSection.style.display = hidden.length > 0 ? "" : "none";
}

// Replaces (rather than stacks on) the General Settings modal. Same pattern
// Time Tracker's Setup → Add/Edit Activity / CSV Import modals use: opening
// closes the parent first, and a back-arrow (not the X) is what reopens it.
const sidebarEditModal = new Modal(sidebarEditBackdrop, {
  closeOnEsc: true,
  onOpen: () => {
    renderSidebarEditModal();
    refreshSidebarSortButtons();
  },
});

sidebarEditBtn.addEventListener("click", () => {
  settingsModal.close({ handoff: true });
  sidebarEditModal.open();
});

sidebarEditBack.addEventListener("click", () => {
  sidebarEditModal.close();
  settingsModal.open();
});

sidebarEditClose.addEventListener("click", () => sidebarEditModal.close());

/** Shows every hidden tool again. Restored items are appended after the
 *  already-shown ones, keeping their relative order. That only matters under
 *  a custom order, since every sort mode re-ranks the whole list anyway. */
document.getElementById("sidebarUnhideAllBtn")!.addEventListener("click", () => {
  const hidden = settings.sidebarItems.filter((it) => !it.pinned);
  if (hidden.length === 0) return;

  const shown = settings.sidebarItems.filter((it) => it.pinned);
  hidden.forEach((it) => { it.pinned = true; });
  settings.sidebarItems = [...shown, ...hidden];

  applySidebarOrder();
  saveSettings();
  renderSidebarEditModal();
  flash(
    hidden.length === 1 ? "1 tool unhidden" : `${hidden.length} tools unhidden`,
    "success",
  );
});

const SIDEBAR_SORT_LABELS: Record<string, string> = {
  classic: "Classic order",
  az: "Sorted A-Z",
  za: "Sorted Z-A",
  recent: "Sorted by most recent",
  used: "Sorted by most used",
};

document.querySelectorAll<HTMLButtonElement>(".sidebar-sort-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const mode = btn.dataset.sort as SidebarSortMode;
    if (!SIDEBAR_SORT_MODES.includes(mode)) return;
    settings.sidebarSort = mode;
    applySidebarOrder();
    saveSettings();
    renderSidebarEditModal();
    refreshSidebarSortButtons();
    flash(SIDEBAR_SORT_LABELS[mode] ?? "Sidebar sorted", "success");
  });
});
