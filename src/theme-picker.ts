/* =============================================================================
   THEME PICKER  (the Choose Theme modal)
   -----------------------------------------------------------------------------
   Split out of shell.ts. This is the modal a person uses to CHOOSE a theme:
   the tabbed tile grid, the preview swatches, the Cycle/Random/Custom panels
   and their sub-options.

   Deliberately its own file rather than part of theme-core.ts, because the two
   answer different questions. theme-core owns "what does applying a theme DO"
   (swap the stylesheet, paint a palette, run the seasonal canvas effects) and
   is used headlessly: Cycle applies themes on a timer with this modal never
   opened. This file owns "how does a person pick one", which is modal chrome,
   tile rendering, tab state and preview fetching. Folding it into theme-core
   would put ~700 lines of picker UI in front of everyone reading the module
   that actually applies themes, and would make theme-core depend on markup
   that only exists while a modal is open.
============================================================================= */

import { Modal, ModalTabs } from "./modal";
import { THEME_GROUPS, type ThemePickerTab } from "./theme-ids";
import { ANIMATED_THEMES, getActiveCustomId, setActiveCustomId, themeCssUrl } from "./theme-core";
import {
  clearCustomTheme,
  customThemes,
  openThemeEditor,
  requestDeleteCustomTheme,
} from "./theme-editor";
import {
  getActiveHolidayOverrideThemeId,
  getDayNightStatus,
  getHolidayOverrideEndDate,
} from "./cycle-theme";
import { PERSISTENT_RANDOM_KEY } from "./random-theme";
import {
  type CustomTheme,
  applySettings,
  cycleDayThemeSelect,
  cycleNightThemeSelect,
  saveSettings,
  settings,
  settingsModal,
  themeSelect,
} from "./shell";

/* Element refs used only by this modal, moved here with it. */
const themePickerBackdrop = document.getElementById("themePickerBackdrop")!;
const themePickerBack = document.getElementById("themePickerBack")!;
const themePickerClose = document.getElementById("themePickerClose")!;
const themePickerGrid = document.getElementById("themePickerGrid")!;
const themePickerCycleTileWrap = document.getElementById("themePickerCycleTileWrap")!;
const themePickerRandomTileWrap = document.getElementById("themePickerRandomTileWrap")!;
const themeCurrentBadge = document.getElementById("themeCurrentBadge")!;
const themeEditBtn = document.getElementById("themeEditBtn")!;
const randomSubsettings = document.getElementById("randomSubsettings")!;
const cycleSubsettings = document.getElementById("cycleSubsettings")!;
const cycleIntervalRow = document.getElementById("cycleIntervalRow")!;
const cycleOrderRow = document.getElementById("cycleOrderRow")!;
const cycleNowRow = document.getElementById("cycleNowRow")!;
const cycleIncludeCustomRow = document.getElementById("cycleIncludeCustomRow")!;
const cycleSeasonOnlyRow = document.getElementById("cycleSeasonOnlyRow")!;
const cycleHolidayFullSeasonRow = document.getElementById("cycleHolidayFullSeasonRow")!;
const cycleHolidayActiveNote = document.getElementById("cycleHolidayActiveNote")!;
const cycleDayNightRows = document.getElementById("cycleDayNightRows")!;
const cycleDayNightNote = document.getElementById("cycleDayNightNote")!;
const themeAnimationsToggle = document.getElementById("themeAnimationsToggle") as HTMLInputElement;
const themeAnimationsLabel = document.getElementById("themeAnimationsLabel")!;
const themeAnimationsList = document.getElementById("themeAnimationsList")!;
const themeAnimationsPerTheme = document.getElementById("themeAnimationsPerTheme")!;



const DIE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.2" fill="currentColor" stroke="none"/><circle cx="16" cy="8" r="1.2" fill="currentColor" stroke="none"/><circle cx="8" cy="16" r="1.2" fill="currentColor" stroke="none"/><circle cx="16" cy="16" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/></svg>`;
const CYCLE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></svg>`;
const PALETTE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22a9.5 9.5 0 1 1 0-19c4.7 0 9 3.5 9 8 0 2.5-2 4-4.5 4H15a2 2 0 0 0-1.5 3.3c.4.5.5 1.2.1 1.7-.4.6-1 1-1.6 1z"/><circle cx="7.5" cy="10.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="10.5" cy="7" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="7" r="1.2" fill="currentColor" stroke="none"/><circle cx="17" cy="11" r="1.2" fill="currentColor" stroke="none"/></svg>`;
const EDIT_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>`;
const TRASH_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /></svg>`;

/** Returns the display name for whatever theme is currently active, a
 *  built-in theme's label, "Random", or the active custom theme's own name
 *  (falling back to "Custom" if none is resolvable). Drives both the
 *  Settings-row badge and (indirectly, via re-render) the picker's active
 *  tile highlight. */
function getThemeDisplayName(themeId: string): string {
  if (themeId === "random") return "Random";
  if (themeId === "cycle") return "Cycle";
  if (themeId === "custom") {
    const activeId = getActiveCustomId();
    const active = activeId ? customThemes.find((t) => t.id === activeId) : undefined;
    return active ? active.name : "Custom";
  }
  for (const group of THEME_GROUPS) {
    const match = group.themes.find((t) => t.id === themeId);
    if (match) return match.label;
  }
  return themeId;
}

export function refreshThemeCurrentBadge(): void {
  themeCurrentBadge.textContent = getThemeDisplayName(settings.theme);
}

const THEME_PREVIEW_VAR_NAMES = [
  "--color-bg",
  "--color-panel",
  "--color-text",
  "--color-text-muted",
  "--color-btn",
  "--color-accent",
  // Budget's 8-color chart palette, deliberately vivid/distinct per theme
  // (see the "Blue / emerald / amber / red / violet / cyan / orange / mint"
  // comment in each theme's own CSS), so it doubles as a rich "fingerprint"
  // strip for the preview tile. Present in every built-in theme's CSS file
  // AND in RANDOM_VARS (so custom themes carry it too), safe for both tile
  // kinds.
  "--color-chart-1",
  "--color-chart-2",
  "--color-chart-3",
  "--color-chart-4",
  "--color-chart-5",
  "--color-chart-6",
  "--color-chart-7",
  "--color-chart-8",
] as const;

const CHART_VAR_NAMES = [
  "--color-chart-1",
  "--color-chart-2",
  "--color-chart-3",
  "--color-chart-4",
  "--color-chart-5",
  "--color-chart-6",
  "--color-chart-7",
  "--color-chart-8",
] as const;

// Keyed by theme id. These are small static files under /themes/, so a
// per-id fetch is cheap and only ever happens once per session.
const themePreviewCache = new Map<string, Record<string, string>>();

async function fetchThemePreviewVars(themeId: string): Promise<Record<string, string>> {
  const cached = themePreviewCache.get(themeId);
  if (cached) return cached;
  const vars: Record<string, string> = {};
  try {
    const res = await fetch(themeCssUrl(themeId));
    const text = await res.text();
    for (const name of THEME_PREVIEW_VAR_NAMES) {
      const match = text.match(new RegExp(`${name}:\\s*([^;]+);`));
      if (match) vars[name] = match[1]!.trim();
    }
  } catch {
    // Preview tile just keeps its CSS-default colours if the fetch fails.
  }
  themePreviewCache.set(themeId, vars);
  return vars;
}

/** Paints a set of preview vars onto a tile's .theme-tile-preview markup. */
function applyPreviewVars(preview: HTMLElement, vars: Record<string, string>): void {
  if (vars["--color-bg"]) preview.style.background = vars["--color-bg"]!;

  const header = preview.querySelector<HTMLElement>(".theme-tile-preview-header");
  if (header && vars["--color-panel"]) header.style.background = vars["--color-panel"]!;

  const dot = preview.querySelector<HTMLElement>(".theme-tile-preview-dot");
  if (dot && vars["--color-btn"]) dot.style.background = vars["--color-btn"]!;

  const bar = preview.querySelector<HTMLElement>(".theme-tile-preview-bar");
  if (bar && vars["--color-accent"]) bar.style.background = vars["--color-accent"]!;

  const chips = preview.querySelectorAll<HTMLElement>(".theme-tile-preview-chips span");
  CHART_VAR_NAMES.forEach((name, i) => {
    const chip = chips[i];
    if (chip && vars[name]) chip.style.background = vars[name]!;
  });

  const lines = preview.querySelectorAll<HTMLElement>(".theme-tile-preview-lines span");
  if (lines[0] && vars["--color-text"]) lines[0].style.background = vars["--color-text"]!;
  if (lines[1] && vars["--color-text-muted"]) lines[1].style.background = vars["--color-text-muted"]!;
}

function buildPreviewSwatchMarkup(): string {
  const chips = CHART_VAR_NAMES.map(() => "<span></span>").join("");
  return (
    '<div class="theme-tile-preview-header"><span class="theme-tile-preview-dot"></span><span class="theme-tile-preview-bar"></span></div>' +
    `<div class="theme-tile-preview-chips">${chips}</div>` +
    '<div class="theme-tile-preview-lines"><span></span><span></span></div>'
  );
}

// Tiles are plain divs, not <button>. The global `button { color:
// var(--color-btn-text) }` rule (meant for solid-colored buttons) made tile
// names unreadable against a transparent tile background on themes where
// --color-btn-text is light (e.g. Light/Patriot), and custom theme tiles
// need real nested <button>s for their edit/delete icons, which HTML doesn't
// allow inside a <button> ancestor. Click handling + hover cursor are
// replicated via CSS/JS instead of relying on native button semantics.
function buildThemeTile(id: string, label: string): HTMLElement {
  const tile = document.createElement("div");
  tile.className = settings.theme === id ? "theme-tile active" : "theme-tile";
  tile.dataset.themeId = id;

  const preview = document.createElement("div");
  preview.className = "theme-tile-preview";
  preview.innerHTML = buildPreviewSwatchMarkup();
  tile.appendChild(preview);
  fetchThemePreviewVars(id).then((vars) => applyPreviewVars(preview, vars));

  const name = document.createElement("span");
  name.className = "theme-tile-name";
  name.textContent = label;
  tile.appendChild(name);

  tile.addEventListener("click", () => selectTheme(id));
  return tile;
}

function buildRandomTile(): HTMLElement {
  const tile = document.createElement("div");
  tile.className = settings.theme === "random" ? "theme-tile active" : "theme-tile";
  tile.dataset.themeId = "random";

  const preview = document.createElement("div");
  preview.className = "theme-tile-preview";
  const iconWrap = document.createElement("div");
  iconWrap.className = "theme-tile-preview-icon";
  iconWrap.innerHTML = DIE_SVG;
  preview.appendChild(iconWrap);
  tile.appendChild(preview);

  const name = document.createElement("span");
  name.className = "theme-tile-name";
  name.textContent = "Random";
  tile.appendChild(name);

  tile.addEventListener("click", () => selectTheme("random"));
  return tile;
}

function buildCycleTile(): HTMLElement {
  const tile = document.createElement("div");
  tile.className = settings.theme === "cycle" ? "theme-tile active" : "theme-tile";
  tile.dataset.themeId = "cycle";

  const preview = document.createElement("div");
  preview.className = "theme-tile-preview";
  const iconWrap = document.createElement("div");
  iconWrap.className = "theme-tile-preview-icon";
  iconWrap.innerHTML = CYCLE_SVG;
  preview.appendChild(iconWrap);
  tile.appendChild(preview);

  const name = document.createElement("span");
  name.className = "theme-tile-name";
  name.textContent = "Cycle";
  tile.appendChild(name);

  tile.addEventListener("click", () => selectTheme("cycle"));
  return tile;
}

function buildCustomThemeTile(theme: CustomTheme): HTMLElement {
  const isActive = settings.theme === "custom" && getActiveCustomId() === theme.id;
  const tile = document.createElement("div");
  tile.className = isActive ? "theme-tile active" : "theme-tile";
  tile.dataset.themeId = theme.id;

  const preview = document.createElement("div");
  preview.className = "theme-tile-preview";
  preview.innerHTML = buildPreviewSwatchMarkup();
  tile.appendChild(preview);
  applyPreviewVars(preview, theme.vars);

  const footer = document.createElement("div");
  footer.className = "theme-tile-footer";

  const name = document.createElement("span");
  name.className = "theme-tile-name";
  name.textContent = theme.name;
  footer.appendChild(name);

  const actions = document.createElement("div");
  actions.className = "theme-tile-custom-actions";

  const editBtn = document.createElement("button");
  editBtn.className = "theme-tile-icon-btn";
  editBtn.title = "Edit theme";
  editBtn.innerHTML = EDIT_SVG;
  editBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    themePickerModal.close();
    openThemeEditor("edit", theme.id);
  });
  actions.appendChild(editBtn);

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "theme-tile-icon-btn theme-tile-icon-btn-danger";
  deleteBtn.title = "Delete theme";
  deleteBtn.innerHTML = TRASH_SVG;
  deleteBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    requestDeleteCustomTheme(theme.id);
  });
  actions.appendChild(deleteBtn);

  footer.appendChild(actions);
  tile.appendChild(footer);

  tile.addEventListener("click", () => selectCustomTheme(theme.id));
  return tile;
}

function buildNewCustomThemeTile(): HTMLElement {
  const tile = document.createElement("div");
  tile.className = "theme-tile";

  const preview = document.createElement("div");
  preview.className = "theme-tile-preview";
  const iconWrap = document.createElement("div");
  iconWrap.className = "theme-tile-preview-icon";
  iconWrap.innerHTML = PALETTE_SVG;
  preview.appendChild(iconWrap);
  tile.appendChild(preview);

  const name = document.createElement("span");
  name.className = "theme-tile-name";
  name.textContent = "New Custom Theme";
  tile.appendChild(name);

  tile.addEventListener("click", () => {
    themePickerModal.close();
    openThemeEditor("create");
  });
  return tile;
}

/** Which tab houses the currently active theme, main/holiday/special for a
 *  built-in theme, "random" or "custom" for those (regardless, for custom,
 *  of which saved one). */
function tabForCurrentTheme(): ThemePickerTab {
  if (settings.theme === "custom") return "custom";
  if (settings.theme === "random") return "random";
  if (settings.theme === "cycle") return "cycle";
  for (const group of THEME_GROUPS) {
    if (group.themes.some((t) => t.id === settings.theme)) return group.tab;
  }
  return "main";
}

/** Shows/hides the Cycle pane's conditional rows. The interval row only
 *  matters for the "time" trigger, the Full Holiday Season row only matters
 *  once one of Holiday Overrides / Restrict to Holiday Season is on (it's a
 *  shared window-widener for both, so either one turning it on is enough to
 *  make it relevant). Called from applySettings() (so it stays correct even
 *  while the pane isn't open) and whenever the picker renders the Cycle tab. */
/** Fills the two Day/Night theme dropdowns from the same THEME_GROUPS source
 *  the picker itself uses, plus saved custom themes when there are any, so a
 *  new built-in theme shows up here without a second list to maintain.
 *  Rebuilt (rather than built once) because the custom-theme list changes at
 *  runtime; each call re-selects the stored value afterwards. */
const CYCLE_TAB_LABELS: Record<string, string> = {
  main: "Main",
  holiday: "Holiday",
  special: "Special",
};

export function populateDayNightThemeSelects(): void {
  for (const select of [cycleDayThemeSelect, cycleNightThemeSelect]) {
    select.innerHTML = "";
    for (const group of THEME_GROUPS) {
      const optgroup = document.createElement("optgroup");
      optgroup.label = CYCLE_TAB_LABELS[group.tab] ?? group.tab;
      for (const theme of group.themes) {
        const opt = document.createElement("option");
        opt.value = theme.id;
        opt.textContent = theme.label;
        optgroup.appendChild(opt);
      }
      select.appendChild(optgroup);
    }
    if (customThemes.length > 0) {
      const optgroup = document.createElement("optgroup");
      optgroup.label = "Custom";
      for (const theme of customThemes) {
        const opt = document.createElement("option");
        opt.value = theme.id;
        opt.textContent = theme.name;
        optgroup.appendChild(opt);
      }
      select.appendChild(optgroup);
    }
  }
  cycleDayThemeSelect.value = settings.cycleDayThemeId;
  cycleNightThemeSelect.value = settings.cycleNightThemeId;
}

/** One line under the Day/Night controls saying which side of the window is
 *  live and when it flips, so the schedule is legible without waiting for it.
 *  Refreshed from the same "themechange" listener the Holiday note uses, which
 *  the boundary timer fires on every real switch. */
export function refreshCycleDayNightNote(): void {
  const status = getDayNightStatus();
  if (!status) {
    cycleDayNightNote.style.display = "none";
    return;
  }
  cycleDayNightNote.style.display = "";
  const side = status.daytime ? "Day" : "Night";
  const label = themeLabelForId(status.themeId);
  cycleDayNightNote.textContent = status.nextSwitch
    ? `${side} right now, showing ${label}. Switches at ${formatClock(status.nextSwitch)}.`
    : `${side} all day, showing ${label}.`;
}

/** The note's clock. Honours the app's own Time Format setting rather than the
 *  OS locale, same idiom as the title-bar clock, so the switch time is written
 *  the way the rest of the app writes times. */
function formatClock(at: Date): string {
  return at.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: settings.hour12,
  });
}

/** Display name for a built-in or custom theme id, for the note above. */
function themeLabelForId(themeId: string): string {
  for (const group of THEME_GROUPS) {
    const hit = group.themes.find((t) => t.id === themeId);
    if (hit) return hit.label;
  }
  return customThemes.find((t) => t.id === themeId)?.name ?? themeId;
}

export function syncCycleSettingsVisibility(): void {
  const dayNight = settings.cycleTrigger === "dayNight";
  cycleIntervalRow.style.display = settings.cycleTrigger === "time" ? "" : "none";
  cycleDayNightRows.style.display = dayNight ? "" : "none";
  // Day/Night never builds a pool, so everything that only shapes one goes
  // away rather than sitting there doing nothing. Holiday Overrides stay: that
  // is a force-switch checked ahead of the mode, so it still applies.
  cycleOrderRow.style.display = dayNight ? "none" : "";
  cycleIncludeCustomRow.style.display = dayNight ? "none" : "";
  cycleSeasonOnlyRow.style.display = dayNight ? "none" : "";
  cycleNowRow.style.display = dayNight ? "none" : "";
  cycleHolidayFullSeasonRow.style.display =
    settings.cycleHolidayOverride || (settings.cycleHolidaySeasonOnly && !dayNight)
      ? ""
      : "none";
  refreshCycleDayNightNote();
}

/** Explains, right where the Holiday Override toggles live, why the theme is
 *  currently pinned to a Holiday theme regardless of the cycle rule, shown
 *  only while an override is actually live today. Refreshed on tab render and
 *  on every "themechange" so it tracks Cycle Now, interaction/time advances,
 *  and the holiday-boundary recheck without needing its own polling. */
const HOLIDAY_NOTE_DATE_FMT = new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric" });

export function refreshCycleHolidayNote(): void {
  const holidayId = getActiveHolidayOverrideThemeId();
  if (!holidayId) {
    cycleHolidayActiveNote.style.display = "none";
    return;
  }
  let untilText = "";
  if (settings.cycleHolidayFullSeason) {
    const endDate = getHolidayOverrideEndDate(holidayId);
    if (endDate) {
      const dayAfterEnd = new Date(endDate);
      dayAfterEnd.setDate(dayAfterEnd.getDate() + 1);
      untilText = ` until ${HOLIDAY_NOTE_DATE_FMT.format(dayAfterEnd)}`;
    }
  }
  cycleHolidayActiveNote.textContent =
    `Holiday Override active: showing ${getThemeDisplayName(holidayId)} today, overriding the normal cycle rotation${untilText}.`;
  cycleHolidayActiveNote.style.display = "";
}

/* -----------------------------------------------------------------------------
   Theme Animations (Preferences tab)
----------------------------------------------------------------------------- */

/** Re-applies the seasonal-effect decision for whatever theme is showing.
 *  applySeasonalEffect() already listens for "themechange" and re-reads the
 *  animation settings on each one, so re-dispatching is all it takes to start
 *  or tear down an effect the moment a toggle flips. No direct call needed,
 *  and Cycle's underlying-theme resolution stays in the one place that owns
 *  it (theme-core.ts). */
function refreshSeasonalEffect(): void {
  window.dispatchEvent(new CustomEvent("themechange"));
}

/** Builds one toggle row per animated theme. Rebuilt on each render rather
 *  than diffed, it's eight rows behind a tab that has to be opened, so the
 *  simplicity is worth more than the churn. */
function renderThemeAnimationRows(): void {
  themeAnimationsList.innerHTML = "";

  for (const anim of ANIMATED_THEMES) {
    const row = document.createElement("div");
    row.className = "settings-row";

    const label = document.createElement("span");
    label.className = "theme-animation-label";
    const name = document.createElement("span");
    name.textContent = `${anim.label}:`;
    const effect = document.createElement("span");
    effect.className = "theme-animation-effect";
    effect.textContent = anim.effect;
    label.append(name, effect);

    const wrap = document.createElement("div");
    wrap.className = "toggle-with-label";
    const stateLabel = document.createElement("span");
    const enabled = !settings.themeAnimationsOff.includes(anim.id);
    stateLabel.textContent = enabled ? "Enabled" : "Disabled";

    const switchLabel = document.createElement("label");
    switchLabel.className = "toggle-switch";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = enabled;
    const slider = document.createElement("span");
    slider.className = "toggle-slider";
    switchLabel.append(input, slider);

    input.addEventListener("change", () => {
      const off = settings.themeAnimationsOff.filter((id) => id !== anim.id);
      if (!input.checked) off.push(anim.id);
      settings.themeAnimationsOff = off;
      saveSettings();
      stateLabel.textContent = input.checked ? "Enabled" : "Disabled";
      refreshSeasonalEffect();
    });

    wrap.append(stateLabel, switchLabel);
    row.append(label, wrap);
    themeAnimationsList.appendChild(row);
  }
}

/** Paints the Preferences tab from current settings: master toggle state, and
 *  the per-theme list (hidden entirely while the master switch is off, since
 *  those toggles would otherwise be controls that visibly do nothing). */
function renderThemePreferences(): void {
  themeAnimationsToggle.checked = settings.themeAnimations;
  themeAnimationsLabel.textContent = settings.themeAnimations ? "Enabled" : "Disabled";
  themeAnimationsPerTheme.style.display = settings.themeAnimations ? "" : "none";
  if (settings.themeAnimations) renderThemeAnimationRows();
}

themeAnimationsToggle.addEventListener("change", () => {
  settings.themeAnimations = themeAnimationsToggle.checked;
  saveSettings();
  renderThemePreferences();
  refreshSeasonalEffect();
});

/** Fills in whichever tab was just selected. Registered as the theme picker's
 *  ModalTabs onActivate hook, so showing/hiding the panes and marking the tab
 *  button are already done by the time this runs, leaving only the content. */
function renderThemePickerTab(tab: ThemePickerTab): void {
  if (tab === "preferences") {
    renderThemePreferences();
    return;
  }

  if (tab === "random") {
    themePickerRandomTileWrap.innerHTML = "";
    themePickerRandomTileWrap.appendChild(buildRandomTile());
    // Settings are visible either way, but only interactive once Random is
    // actually the active theme, not just being looked at.
    randomSubsettings.classList.toggle("inactive", settings.theme !== "random");
    return;
  }

  if (tab === "cycle") {
    themePickerCycleTileWrap.innerHTML = "";
    themePickerCycleTileWrap.appendChild(buildCycleTile());
    // Same "visible but inert until actually active" treatment as Random.
    cycleSubsettings.classList.toggle("inactive", settings.theme !== "cycle");
    syncCycleSettingsVisibility();
    refreshCycleHolidayNote();
    return;
  }

  themePickerGrid.innerHTML = "";

  if (tab === "custom") {
    customThemes.forEach((ct) => themePickerGrid.appendChild(buildCustomThemeTile(ct)));
    themePickerGrid.appendChild(buildNewCustomThemeTile());
    syncThemeGridHeight();
    return;
  }

  const group = THEME_GROUPS.find((g) => g.tab === tab);
  group?.themes.forEach((t) => themePickerGrid.appendChild(buildThemeTile(t.id, t.label)));
  syncThemeGridHeight();
}

/** Caps the grid at exactly two full tile rows and lets it scroll beyond
 *  that, instead of the old fixed 58vh cap, which could either clip a
 *  second row's titles or leave dead space, since tile height depends on
 *  how many columns the auto-fill grid ends up with. One or two rows: no
 *  cap, so the modal simply grows to fit. Three or more: capped to the
 *  height of the first two rows, so row three+ scrolls into view instead
 *  of being clipped. Reading offsetTop/offsetHeight forces a synchronous
 *  layout, which is fine here since it runs once right after populating
 *  the grid, not on every frame. */
function syncThemeGridHeight(): void {
  const tiles = Array.from(themePickerGrid.children) as HTMLElement[];
  if (tiles.length === 0) {
    themePickerGrid.style.maxHeight = "";
    return;
  }
  const rowTops = [...new Set(tiles.map((t) => t.offsetTop))].sort((a, b) => a - b);
  if (rowTops.length < 3) {
    themePickerGrid.style.maxHeight = "none";
    return;
  }
  const secondRowTile = tiles.find((t) => t.offsetTop === rowTops[1])!;
  themePickerGrid.style.maxHeight = `${rowTops[1] + secondRowTile.offsetHeight}px`;
}

// Column count (and therefore row height/count) can change on window
// resize, so re-run the cap while the picker is open and on a tab that
// actually uses the grid (Random/Cycle use their own single-tile panes).
window.addEventListener("resize", () => {
  if (themePickerModal.isOpen && themePickerGrid.style.display !== "none") {
    syncThemeGridHeight();
  }
});

/** Selects a built-in theme or "random"/"custom" by id. Same logic the old
 *  themeSelect "change" handler used to run. Re-renders the picker's active
 *  tab afterward so the active-tile highlight tracks the new selection
 *  without closing the modal (letting you flip through a few before leaving). */
function selectTheme(themeId: string): void {
  if (settings.theme === "random" && themeId !== "random") {
    localStorage.removeItem(PERSISTENT_RANDOM_KEY);
  }
  if (settings.theme === "custom" && themeId !== "custom") {
    clearCustomTheme();
  }
  settings.theme = themeId;
  themeSelect.value = themeId;
  applySettings();
  saveSettings();
  themePickerTabs.restore();
}

/** Selects a specific saved custom theme by id, then applies it via
 *  selectTheme("custom"). */
function selectCustomTheme(customId: string): void {
  setActiveCustomId(customId);
  selectTheme("custom");
}

/* The picker's tab strip, on the shared ModalTabs controller (modal.ts) like
   every other tabbed modal. Two things here are specific to this modal:

   • Main/Holiday/Special/Custom all render into the one #themePickerGrid, so
     they share a pane entry. Cycle, Random and Preferences have their own.
   • A fresh open lands on the tab housing the theme in use, not on Main, via
     defaultTab. Returning from a child modal still keeps the tab you left. */
export const themePickerTabs = new ModalTabs<ThemePickerTab>({
  scope: "#themePickerBackdrop",
  key: "themeTab",
  panes: {
    main: "themePickerGrid",
    holiday: "themePickerGrid",
    special: "themePickerGrid",
    cycle: "themePickerCyclePane",
    random: "themePickerRandomPane",
    custom: "themePickerGrid",
    preferences: "themePickerPreferencesPane",
  },
  defaultTab: () => tabForCurrentTheme(),
  onActivate: (tab) => renderThemePickerTab(tab),
});

// Replaces (rather than stacks on) the General Settings modal, same pattern
// as the Edit Sidebar modal above. Exported: theme-editor.ts's Create/Edit
// Custom Theme flow returns here (not to Settings) when done, since it's now
// only ever reached from this modal.
export const themePickerModal = new Modal(themePickerBackdrop, {
  closeOnEsc: true,
  tabs: themePickerTabs,
});

/** Reopens Choose Theme on the Custom tab. Exported for theme-editor.ts to call
 *  when returning from Create/Edit/Delete Custom Theme. Selecting the tab before
 *  opening beats letting defaultTab decide, because tabForCurrentTheme() tracks
 *  settings.theme, which those flows don't necessarily change (e.g. editing or
 *  deleting a custom theme that isn't the active one). */
export function reopenThemePickerOnCustomTab(): void {
  themePickerTabs.select("custom");
  themePickerModal.open();
}

themeEditBtn.addEventListener("click", () => {
  settingsModal.close({ handoff: true });
  themePickerModal.open();
});

themePickerBack.addEventListener("click", () => {
  themePickerModal.close();
  settingsModal.open();
});

themePickerClose.addEventListener("click", () => themePickerModal.close());

