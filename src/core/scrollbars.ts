/* =============================================================================
   SCROLLBARS  (Settings > Display > Scrollbars)
   -----------------------------------------------------------------------------
   Every scrollbar in the app is hidden by default, and each area can be given
   its own back. This file owns the modal that switches them and the body
   classes that say which are on. What a scrollbar LOOKS like is not here: the
   shared look is in shell.css, drawn from the theme's own colors, and a theme
   with a look of its own (Nostalgia's 90s bar) restyles it in its theme sheet.

   ONE CLASS PER AREA, read by CSS through an inherited custom property rather
   than a selector per area. The areas nest (a text box in a modal in the app),
   and "the innermost area decides" is exactly what inheritance does for free.
   Doing it with selectors instead means an ordering fight between five
   overlapping rules, each of which has to switch the others off.

   In an import loop with shell.ts, like sidebar-edit.ts, and safe for the same
   reason: nothing here reads an imported value while the file loads.
============================================================================= */

import { Modal } from "../modal/modal";
import { SCROLLBAR_AREAS, type ScrollbarArea } from "./settings-store";
import { isToolVisible, openSettingsOnTab, saveSettings, settings, settingsModal } from "./shell";

const scrollbarsBackdrop = document.getElementById("scrollbarsBackdrop")!;
const scrollbarsBadge = document.getElementById("scrollbarsBadge")!;
const areaToggles = Array.from(
  scrollbarsBackdrop.querySelectorAll<HTMLInputElement>("input[data-scrollbar-area]"),
);

/** The areas that belong to one tool, by that tool's sidebar key. Their rows
 *  are left out while the tool is hidden, since there is nothing of it on
 *  screen for the switch to act on. The stored choice is kept, so showing the
 *  tool again brings the row back as it was. */
const AREA_TOOL: Partial<Record<ScrollbarArea, string>> = {
  whiteboard: "productivity/whiteboard",
  columns: "productivity/kanban",
};

function areaOffered(area: ScrollbarArea): boolean {
  const tool = AREA_TOOL[area];
  return tool === undefined || isToolVisible(tool);
}

/** Puts the stored choice on the page: a body class per area that is on, the
 *  modal's switches, and the badge beside Customize. Safe to call any time. */
export function applyScrollbars(): void {
  const on = new Set(settings.scrollbars);
  for (const area of SCROLLBAR_AREAS) {
    document.body.classList.toggle(`scrollbars-${area}`, on.has(area));
  }
  for (const toggle of areaToggles) {
    const area = toggle.dataset.scrollbarArea as ScrollbarArea;
    const shown = on.has(area);
    toggle.checked = shown;
    const label = toggle.closest(".toggle-with-label")?.querySelector(".scrollbars-state");
    if (label) label.textContent = shown ? "Shown" : "Hidden";
    const row = toggle.closest<HTMLElement>(".settings-row");
    if (row) row.style.display = areaOffered(area) ? "" : "none";
  }
  // Counted over the rows actually listed, so the badge never claims an area
  // the modal does not show.
  const offered = SCROLLBAR_AREAS.filter(areaOffered);
  const count = offered.filter((area) => on.has(area)).length;
  scrollbarsBadge.textContent =
    count === 0 ? "All hidden" : count === offered.length ? "All shown" : `${count} shown`;
}

for (const toggle of areaToggles) {
  toggle.addEventListener("change", () => {
    const area = toggle.dataset.scrollbarArea as ScrollbarArea;
    const on = new Set(settings.scrollbars);
    if (toggle.checked) on.add(area);
    else on.delete(area);
    // A new array rather than an edit in place: settings is spread from
    // DEFAULT_SETTINGS on a reset, so the array it holds may be the default's.
    settings.scrollbars = SCROLLBAR_AREAS.filter((a) => on.has(a));
    applyScrollbars();
    void saveSettings();
  });
}

// Replaces the App Settings modal rather than stacking on it, and the Back
// arrow is what returns there. Same shape as Edit Home/Sidebar.
const scrollbarsModal = new Modal(scrollbarsBackdrop, {
  closeOnEsc: true,
  onOpen: () => applyScrollbars(),
});

document.getElementById("scrollbarsEditBtn")!.addEventListener("click", () => {
  settingsModal.close({ handoff: true });
  scrollbarsModal.open();
});

document.getElementById("scrollbarsBack")!.addEventListener("click", () => {
  scrollbarsModal.close();
  openSettingsOnTab("display");
});

document.getElementById("scrollbarsClose")!.addEventListener("click", () => scrollbarsModal.close());
