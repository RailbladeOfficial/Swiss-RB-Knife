/* =============================================================================
   SIDEBAR ORDER / VISIBILITY  (Edit Home/Sidebar modal)
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

import { Modal } from "../modal/modal";
import {
  ALL_TOOLS,
  SIDEBAR_SORT_MODES,
  TOOL_CATEGORIES,
  type SidebarItemState,
  type SidebarSortMode,
  _activeViewKey,
  activateSection,
  applySidebarSortMode,
  flash,
  saveSettings,
  settings,
  settingsModal,
  openSettingsOnTab,
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
const sidebarSortSelect = document.getElementById("sidebarSortSelect") as HTMLSelectElement;
const toolCategoriesToggle = document.getElementById(
  "toolCategoriesToggle",
) as HTMLInputElement;
const toolCategoriesLabel = document.getElementById("toolCategoriesLabel")!;
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

/** Updates the "Home/Sidebar:" row's status badge in App Settings, hidden
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

/* Category headings are built here rather than living in index.html, because
   which ones exist depends on what is currently shown: a category whose every
   tool has been hidden must not leave a heading behind with nothing under it.
   Both are torn down and rebuilt on every pass, which is what keeps them
   correct after a hide, a re-show, a re-sort or the toggle itself. */
const NAV_GROUP_CLASS = "nav-group-label";
const CARD_GROUP_CLASS = "tool-card-group-head";

function clearCategoryHeadings(): void {
  navListEl.querySelectorAll(`.${NAV_GROUP_CLASS}`).forEach((el) => el.remove());
  toolCardGrid?.querySelectorAll(`.${CARD_GROUP_CLASS}`).forEach((el) => el.remove());
}

/** Sidebar heading. Carries a rule as well as its text because the collapsed
 *  52px rail has no room for a word: the two cross-fade, so the heading reads
 *  as a hairline separator collapsed and as a label expanded. */
function buildNavGroupHeading(label: string): HTMLElement {
  const li = document.createElement("li");
  li.className = NAV_GROUP_CLASS;
  li.setAttribute("aria-hidden", "true");
  const rule = document.createElement("span");
  rule.className = "nav-group-rule";
  const text = document.createElement("span");
  text.className = "nav-group-text";
  text.textContent = label;
  li.append(rule, text);
  return li;
}

/** Home dashboard heading. Spans the full width of the card grid so the cards
 *  under it start on a fresh row. */
function buildCardGroupHeading(label: string): HTMLElement {
  const head = document.createElement("div");
  head.className = CARD_GROUP_CLASS;
  const text = document.createElement("span");
  text.className = "tool-card-group-text";
  text.textContent = label;
  const rule = document.createElement("span");
  rule.className = "tool-card-group-rule";
  head.append(text, rule);
  return head;
}

/**
 * The shown tools, grouped the way they are DRAWN.
 *
 * Categories partition the order, they do not replace it. Whatever
 * settings.sidebarItems already says (a sort mode, or a hand-dragged order)
 * still decides the order within each heading, so switching the toggle on and
 * back off returns the exact list you had.
 *
 * A tool's category IS its section: a key is "<category>/<tool>", so this reads
 * the one grouping the tool has rather than a second one kept alongside it.
 *
 * SHARED WITH THE BLADE WALK, which is why it is a function rather than four
 * lines inside applySidebarOrder. The Blades theme colors tools by their
 * position on screen, and it read the flat stored order while the sidebar drew
 * a grouped one, so with categories switched on every color was wrong: the
 * sidebar showed Tracking first and the palette was still counting from
 * whatever settings.sidebarItems happened to hold. One function, one order.
 */
function shownGroups(): { label: string | null; keys: string[] }[] {
  const shownKeys = settings.sidebarItems.filter((it) => it.pinned).map((it) => it.key);
  if (!settings.toolCategories) return [{ label: null, keys: shownKeys }];
  return TOOL_CATEGORIES.map((cat) => ({
    label: cat.label as string | null,
    keys: shownKeys.filter((key) => ALL_TOOLS.find((t) => t.key === key)?.section === cat.id),
  })).filter((group) => group.keys.length > 0);
}

/** Reorders and shows/hides the sidebar nav-items and Home dashboard
 *  tool-cards to match settings.sidebarItems, then re-syncs the On Startup
 *  select and the Settings-row status badge. Call after ANY change to
 *  settings.sidebarItems (drag, show/hide toggle, reset, or a fresh
 *  settings load). */
export function applySidebarOrder(): void {
  // Sorting happens here rather than only at the moment a sort mode is
  // picked, so the usage-driven modes stay live: opening a tool re-ranks the
  // sidebar on the spot instead of at next launch.
  applySidebarSortMode();

  const shownKeys = settings.sidebarItems.filter((it) => it.pinned).map((it) => it.key);
  const shownSet = new Set(shownKeys);

  clearCategoryHeadings();

  const groups = shownGroups();

  // Move shown items into order (appendChild on an already-attached node
  // relocates it, repeated in desired order, this leaves everything in that
  // order without disturbing the fixed, non-reorderable nav-items around it:
  // the sidebar-toggle control and Home always stay first).
  groups.forEach((group, index) => {
    if (group.label !== null) {
      // "First" is marked here rather than with a :first-child rule, which
      // could not do the job on either surface: the sidebar's first list item
      // is always the collapse toggle, and a hidden Home card is left where it
      // sits (display:none) rather than relocated, so it can sit ahead of the
      // heading in the DOM without being on screen.
      const first = index === 0;
      const navHead = buildNavGroupHeading(group.label);
      const cardHead = buildCardGroupHeading(group.label);
      if (first) {
        navHead.classList.add("is-first");
        cardHead.classList.add("is-first");
      }
      navListEl.appendChild(navHead);
      toolCardGrid?.appendChild(cardHead);
    }
    group.keys.forEach((key) => {
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

  applyBladeOrder();
  refreshStartupSelectOptions();
  refreshSidebarHiddenBadge();

  // Every path that changes tool visibility funnels through here, so this is
  // the one place a "sidebarchange" needs announcing. Tools that offer a
  // hand-off to another tool (Countdown Timer → Time Tracker) listen for it so they
  // can disable that offer when the target has been hidden.
  window.dispatchEvent(new CustomEvent("sidebarchange"));
}

/* -----------------------------------------------------------------------------
   BLADE ORDER  (the Blades theme's per-tool color)
   -----------------------------------------------------------------------------
   Blades hands every tool one of five colors, and the point of the set is that
   walking the sidebar walks red, orange, green, blue, purple and round again.
   That only holds if the color follows the tool's POSITION rather than its
   name, so this stamps `data-blade` (1..5) on each of the four surfaces the
   theme colors: the sidebar row, the Home card, the tool's own view, and
   <body> for whichever tool is open (modals render at body level, outside the
   tool's subtree, so they have no other way to reach it).

   Done here, in TypeScript, rather than as a per-tool block in blades.css,
   because the CSS cannot know the order: the sidebar is reorderable, sortable
   five ways, and grows a row every time a tool ships. The stylesheet keeps the
   five palettes and nothing else.

   The count is walked over EVERY tool, shown ones first in the order they are
   displayed and hidden ones after, so a hidden tool still resolves to a color
   if something opens it, and re-showing it does not shuffle the colors of the
   tools above it. It is stamped for every theme, not only Blades: an unused
   data attribute costs nothing, and gating it on the active theme would mean
   re-running this on every theme change.
----------------------------------------------------------------------------- */

/** How many colors the Blades palette cycles through. Matches the five blade
 *  blocks in public/themes/blades.css; changing one without the other leaves
 *  tools past the fifth with no palette at all. */
const BLADE_COUNT = 5;

/** The order the blades are handed out in: the sidebar exactly as it is drawn,
 *  then whatever is hidden.
 *
 *  Through shownGroups() rather than off settings.sidebarItems, because with
 *  categories switched on those two are different orders. See the note on that
 *  function. */
function bladeOrderedKeys(): string[] {
  const shown = shownGroups().flatMap((group) => group.keys);
  const hidden = settings.sidebarItems.filter((it) => !it.pinned).map((it) => it.key);
  const ordered = [...shown, ...hidden];
  // Anything ALL_TOOLS knows about but settings does not (a tool added between
  // a load and this call) still needs a color rather than falling back to the
  // stylesheet's default green.
  for (const meta of ALL_TOOLS) if (!ordered.includes(meta.key)) ordered.push(meta.key);
  return ordered;
}

/** The blade number for one "section/tool" key, 1-based. */
export function bladeForToolKey(key: string): number {
  const at = bladeOrderedKeys().indexOf(key);
  return (at === -1 ? 0 : at % BLADE_COUNT) + 1;
}

/** Stamps data-blade on every sidebar row, Home card and tool view. Called
 *  from applySidebarOrder, which is the one funnel every reorder, re-sort,
 *  show/hide and settings load already passes through. */
export function applyBladeOrder(): void {
  bladeOrderedKeys().forEach((key, index) => {
    const meta = ALL_TOOLS.find((t) => t.key === key);
    if (!meta) return;
    const blade = String((index % BLADE_COUNT) + 1);
    const sel = `[data-section="${meta.section}"][data-tool="${meta.tool}"]`;
    document
      .querySelectorAll<HTMLElement>(`.nav-item${sel}, .tool-card${sel}`)
      .forEach((el) => {
        el.dataset.blade = blade;
      });
    const view = document.getElementById(`${meta.section}-tool-${meta.tool}`);
    if (view) view.dataset.blade = blade;
  });

  // The open tool's blade, for the modals that sit outside its subtree. Read
  // back off <body> rather than recomputed, so this and switchSection() cannot
  // disagree about which tool is open.
  const active = document.body.dataset.activeTool;
  if (active) document.body.dataset.activeBlade = String(bladeForToolKey(active));
  else delete document.body.dataset.activeBlade;
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
 *  live sidebar/Home and (if open) the Edit Home/Sidebar modal, and, per spec,
 *  redirects to Home if the tool being hidden is the one currently open. */
export function setPinned(key: string, shown: boolean): void {
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
    // With categories on the list is partitioned, and a tool's category is
    // not something a drag gets to change: that is decided in ALL_TOOLS. So a
    // drag that has wandered over another category's rows simply does not
    // insert, which leaves the dragged row where it was and makes the
    // boundary felt rather than announced.
    if (settings.toolCategories && categoryOf(sidebarDragKey) !== categoryOf(key)) return;
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
 *  into settings.sidebarItems, leaving the hidden group's order untouched.
 *
 *  With categories on the DOM order is grouped, so the flat order this stores
 *  comes out grouped too. That is the right answer rather than a side effect:
 *  it is the arrangement the user just made, and it is what they would see
 *  again if they switched categories off. Subheadings carry no data-key, so
 *  they are skipped here rather than needing to be filtered out. */
function commitShownOrderFromDom(): void {
  const orderedKeys = Array.from(
    sidebarEditShownList.querySelectorAll<HTMLElement>("[data-key]"),
  ).map((el) => el.dataset.key!);

  // A drag that moved nothing must not be treated as a hand-placed order.
  // Two ways to get here having changed nothing: picking a row up and
  // dropping it back where it was, and a drag the category guard refused. In
  // both cases writing through would switch the Sort select to Custom, which
  // reads as the app having quietly discarded the sort mode you chose.
  const currentKeys = settings.sidebarItems.filter((it) => it.pinned).map((it) => it.key);
  if (orderedKeys.length === currentKeys.length &&
      orderedKeys.every((key, i) => key === currentKeys[i])) {
    return;
  }

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
  refreshSidebarEditControls();
}

/** Points the Sort select and the Tool Categories toggle at the live state,
 *  and shows the categories-are-on note. "Custom" is a real option on the
 *  select (disabled, so it can be shown but never picked): after a drag the
 *  select still has to be able to say what order you are in. */
function refreshSidebarEditControls(): void {
  sidebarSortSelect.value = settings.sidebarSort;
  toolCategoriesToggle.checked = settings.toolCategories;
  toolCategoriesLabel.textContent = settings.toolCategories ? "Enabled" : "Disabled";
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

/** A tool's category, which is its section. Undefined for a key no tool
 *  claims, which the drag guard treats as its own group rather than as a
 *  match for anything. */
function categoryOf(key: string): string | undefined {
  return ALL_TOOLS.find((t) => t.key === key)?.section;
}

/** Subheading in the shown list, marking where one category's tools end and
 *  the next begins. Not a drop target: it carries no data-key and no drag
 *  handlers, so nothing can be dropped onto it. */
function buildSidebarEditGroupLabel(label: string): HTMLElement {
  const head = document.createElement("div");
  head.className = "sidebar-edit-group-label";
  const text = document.createElement("span");
  text.textContent = label;
  const rule = document.createElement("span");
  rule.className = "sidebar-edit-group-rule";
  head.append(text, rule);
  return head;
}

function renderSidebarEditModal(): void {
  sidebarEditShownList.innerHTML = "";
  sidebarEditHiddenList.innerHTML = "";

  const shown = settings.sidebarItems.filter((it) => it.pinned);
  const hidden = settings.sidebarItems.filter((it) => !it.pinned);

  if (settings.toolCategories) {
    // Same partition the sidebar and Home get, so what you drag is what you
    // see. A category every one of whose tools is hidden gets no subheading,
    // for the same reason it gets no heading on the sidebar.
    TOOL_CATEGORIES.forEach((cat) => {
      const rows = shown.filter((it) => categoryOf(it.key) === cat.id);
      if (rows.length === 0) return;
      sidebarEditShownList.appendChild(buildSidebarEditGroupLabel(cat.label));
      rows.forEach((it) => sidebarEditShownList.appendChild(buildSidebarEditRow(it, true)));
    });
  } else {
    shown.forEach((it) => sidebarEditShownList.appendChild(buildSidebarEditRow(it, true)));
  }

  // The hidden group is never subdivided: hidden tools have no order that is
  // shown or editable, so a heading there would group nothing.
  hidden.forEach((it) => sidebarEditHiddenList.appendChild(buildSidebarEditRow(it, false)));

  sidebarEditHiddenSection.style.display = hidden.length > 0 ? "" : "none";
}

// Replaces (rather than stacks on) the App Settings modal. Same pattern
// Time Tracker's Setup → Add/Edit Activity / CSV Import modals use: opening
// closes the parent first, and a back-arrow (not the X) is what reopens it.
const sidebarEditModal = new Modal(sidebarEditBackdrop, {
  closeOnEsc: true,
  onOpen: () => {
    renderSidebarEditModal();
    refreshSidebarEditControls();
  },
});

sidebarEditBtn.addEventListener("click", () => {
  settingsModal.close({ handoff: true });
  sidebarEditModal.open();
});

// The Customize button that leads here lives on Settings > Preferences, so
// that is where the back arrow returns to, however this modal was reached: the
// Settings button, or a right-click on a Home card or sidebar entry.
sidebarEditBack.addEventListener("click", () => {
  sidebarEditModal.close();
  openSettingsOnTab("preferences");
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

sidebarSortSelect.addEventListener("change", () => {
  const mode = sidebarSortSelect.value as SidebarSortMode;
  // "custom" is only ever arrived at by dragging. The option is disabled, so
  // this is a belt-and-braces guard rather than a reachable path; either way
  // the select is put back to whatever the real mode is.
  if (mode === "custom" || !SIDEBAR_SORT_MODES.includes(mode)) {
    refreshSidebarEditControls();
    return;
  }
  applySidebarSort(mode);
});

/* Tool Categories. Display-only: it groups the sidebar and Home under
   headings and changes nothing about order, pins or a tool's own data, so
   switching it off gives back exactly the flat list you had. */
toolCategoriesToggle.addEventListener("change", () => {
  settings.toolCategories = toolCategoriesToggle.checked;
  applySidebarOrder();
  saveSettings();
  // The modal is open and its list is the thing this setting changes, so it
  // has to be rebuilt here. Without this the subheadings only appear on the
  // next thing that happens to re-render (a sort, a hide, reopening), which
  // reads as the toggle not having worked.
  renderSidebarEditModal();
  refreshSidebarEditControls();
  flash(
    settings.toolCategories ? "Tool categories on" : "Tool categories off",
    "success",
  );
});

/* =============================================================================
   ENTRY POINTS FOR THE RIGHT-CLICK MENUS
   -----------------------------------------------------------------------------
   The Home card and sidebar item menus (wired in shell.ts, which owns those
   elements and the navigation) reach this feature through these three. They
   are the same paths the modal's own controls take, so a menu and the modal
   can never drift apart.
============================================================================= */

/** Opens the Edit Home/Sidebar modal directly, without going through General
 *  Settings first. Closes Settings if it happens to be open, so the two never
 *  stack; that mirrors what the Customize button does. */
export function openSidebarEditModal(): void {
  settingsModal.close({ handoff: true });
  sidebarEditModal.open();
}

/** Applies a sort mode, exactly as picking it in the modal would. Same
 *  re-render, same persistence, same confirmation toast. */
export function applySidebarSort(mode: SidebarSortMode): void {
  if (!SIDEBAR_SORT_MODES.includes(mode)) return;
  settings.sidebarSort = mode;
  applySidebarOrder();
  saveSettings();
  renderSidebarEditModal();
  refreshSidebarEditControls();
  flash(SIDEBAR_SORT_LABELS[mode] ?? "Sidebar sorted", "success");
}

/** The sort modes with their menu labels, in the order the modal lists them,
 *  so a Sort submenu built from this always matches the modal's buttons. */
export const SIDEBAR_SORT_MENU: { mode: SidebarSortMode; label: string }[] = [
  { mode: "classic", label: "Classic Order" },
  { mode: "az", label: "Sort A-Z" },
  { mode: "za", label: "Sort Z-A" },
  { mode: "recent", label: "Sort by Most Recent" },
  { mode: "used", label: "Sort by Most Used" },
];
