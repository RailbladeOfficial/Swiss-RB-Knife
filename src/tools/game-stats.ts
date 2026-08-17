/* =============================================================================
   GAME STATS
   -----------------------------------------------------------------------------
   Frontend logic for the Game Stats tool. Tracks card/board game results
   (Five Crowns first) and computes stats automatically from the logged game
   history. No hand-maintained spreadsheet formulas.

   Architecture notes:
     • Profiles are a single global pool shared across every game type this
       tool ever grows to support (not a per-game-type roster), a profile's
       individual stats view breaks totals down by game/table instead.
     • Running totals, "table" groupings (the exact set of players in a game),
       and completion state are always DERIVED from `games`, never stored,
       editing a historical game just mutates the array and everything
       downstream recomputes, so there's nothing to reconcile.
     • Everything Five-Crowns-specific (round structure, overtime tie-break
       algorithm, stat catalog) lives in game-stats-five-crowns.ts behind a
       small GameDefinition-shaped interface, so a second game later doesn't
       require changes here.
     • Unlike Time Tracker's Activities/Projects, a profile with 1+ logged
       games can only be retired, never permanently deleted. Game Stats'
       table/stat identity is keyed on player id, so reassigning history to
       an "Unknown" placeholder (Time Tracker's approach) would corrupt table
       groupings and stats instead of just losing a label.

   Rust commands used:
     save_game_stats_data, load_game_stats_data,
     save_game_stats_draft, load_game_stats_draft
============================================================================= */

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { devError, flash, setSubNavHandler, shortPath } from "../shell";
import { Modal } from "../modal";
import {
  buildFixedRounds,
  reconcileOvertimeRounds,
  deriveGameState,
  roundLabel,
  gameLabel,
  tableKey,
  tableKeyOf,
  sortChronologically,
  gamesForTable,
  outsInGame,
  mostOutsInARowInGame,
  computePlayerStats,
  computeTableStats,
  computeWinChart,
  computeRunningTotalsPerRound,
  streakListDetail,
  leadChangesInGame,
  comebackInGame,
  isWireToWire,
  roundReachingThreshold,
  finishPosition,
  templateGameRows,
  templateReadmeRows,
  parseGameSheet,
  gameNumberFromSheetName,
  PACE_THRESHOLDS,
  FIRST_ROUND,
  LAST_FIXED_ROUND,
  type PlayerStats,
  type GameReference,
  type StatPolarity,
  type MarginGame,
  type OvertimeGameRef,
  type Streak,
  type PaceThreshold,
  type PaceEntry,
  type ParsedSheetGame,
} from "./game-stats-five-crowns";
import { readWorkbook, buildWorkbook, toBase64, fromBase64, WorkbookError } from "./game-stats-xlsx";

/* =============================================================================
   TYPES
============================================================================= */

type ProfileStatus = "active" | "retired";
export type Profile = { id: string; name: string; status: ProfileStatus };

// One played round within a game instance. For Five Crowns, roundIndex 3-13
// are the fixed rounds (card count == roundIndex); 14+ are overtime rounds,
// entered only when the running totals are tied after round 13 (see
// game-stats-five-crowns.ts for the tie-break algorithm).
export type RoundEntry = {
  roundIndex: number;
  isOvertime: boolean;
  // Who plays this round. All of a game's players for rounds 3-13, but only
  // the currently-tied players for an overtime round.
  participantIds: string[];
  // profileId -> that player's score for this round, null until entered.
  scores: Record<string, number | null>;
};

export type GameType = "five-crowns";

export const GAME_TYPES: { value: GameType; label: string }[] = [
  { value: "five-crowns", label: "Five Crowns" },
];

export function gameTypeLabel(type: GameType): string {
  return GAME_TYPES.find((t) => t.value === type)?.label ?? type;
}

/** A roster + game type the user has actually played, so it can be given a
 *  friendly name ("Thursday Crew") instead of always reading as a list of
 *  names. Created automatically the first time a game is saved with a new
 *  roster, see ensureTableFor(): and only ever edited, never hand-added,
 *  mirroring how profiles appear when you type a new name into a game.
 *  `name: ""` means "no custom name", so the display falls back to the
 *  joined player names and keeps tracking profile renames. */
export type GameTable = {
  key: string;
  gameType: GameType;
  playerIds: string[];
  name: string;
};

export type GameInstance = {
  id: string;
  gameType: GameType;
  // Counts within this game's TABLE (game type + exact roster), not globally:
  // your 176th Five Crowns game with the same three people is Game 176 even
  // if other tables logged games in between, matching how a paper scoresheet
  // pad is numbered. Assigned once at creation and never renumbered, so it
  // stays a reliable reference for streak ranges and career records even
  // after other games are deleted. Also doubles as play order within a table
  // (see sortChronologically), which is what keeps streaks correct for users
  // who never fill in dates.
  gameNumber: number;
  date: string; // YYYY-MM-DD, or "" when settings.requireDate is off and left blank
  playerIds: string[]; // entry order, drives column order in the grid
  rounds: RoundEntry[];
  // Set when the user explicitly declines to play overtime for a tie
  // (only reachable when settings.autoOvertime is off), lets the tie stand
  // as a shared win instead of leaving the game stuck "in progress" forever.
  tieAccepted?: boolean;
  createdAt: string;
  updatedAt: string;
};

export type GameStatsSettings = {
  // When false, Date can be left blank on a game (New Game and Edit both).
  requireDate: boolean;
  // When false, a tie found after Round 13 prompts for confirmation instead
  // of silently adding an overtime round.
  autoOvertime: boolean;
  // ISO timestamp of the most recent successful spreadsheet import, or
  // undefined if none has happened yet.
  lastImportAt?: string;
};

const DEFAULT_SETTINGS: GameStatsSettings = {
  requireDate: true,
  autoOvertime: true,
};

type GameStatsData = {
  profiles: Profile[];
  games: GameInstance[];
  tables: GameTable[];
  settings: Partial<GameStatsSettings>;
};

/* =============================================================================
   MODULE-LEVEL STATE
============================================================================= */

let profiles: Profile[] = [];
let games: GameInstance[] = [];
let tables: GameTable[] = [];
let settings: GameStatsSettings = { ...DEFAULT_SETTINGS };

function makeId(): string {
  return crypto.randomUUID();
}

/* =============================================================================
   PERSISTENCE
============================================================================= */

async function loadFromDisk(): Promise<void> {
  try {
    const raw = await invoke<string>("load_game_stats_data");
    const parsed = JSON.parse(raw) as Partial<GameStatsData>;
    profiles = Array.isArray(parsed.profiles) ? parsed.profiles : [];
    games = Array.isArray(parsed.games) ? parsed.games : [];
    tables = Array.isArray(parsed.tables) ? parsed.tables : [];
    settings = { ...DEFAULT_SETTINGS, ...parsed.settings };
  } catch (err) {
    devError("Game Stats: failed to load data", err);
    profiles = [];
    games = [];
    tables = [];
    settings = { ...DEFAULT_SETTINGS };
  }
  // Backfills table records for games logged before tables existed. Purely
  // additive. It never touches gameNumber, so historical numbering (and its
  // correspondence to a paper scoresheet) is preserved exactly as saved.
  backfillTables();
}

async function saveToDisk(): Promise<void> {
  const data: GameStatsData = { profiles, games, tables, settings };
  try {
    await invoke("save_game_stats_data", { data: JSON.stringify(data) });
  } catch (err) {
    devError("Game Stats: failed to save data", err);
  }
}

/* =============================================================================
   TABLES: registry of every roster+game-type actually played
   -----------------------------------------------------------------------------
   Tables are auto-discovered from `games`, never hand-created: the moment a
   game is saved with a roster that's never been seen, a record appears so the
   user can name it later. The `games` array stays the source of truth for
   which tables EXIST. This registry only adds the user-supplied name on top,
   so a stale record can never invent a table that has no games.
============================================================================= */

/** Ensures a table record exists for this game's roster, returning it. */
function ensureTableFor(game: GameInstance): GameTable {
  const key = tableKeyOf(game);
  let table = tables.find((t) => t.key === key);
  if (!table) {
    table = { key, gameType: game.gameType, playerIds: [...game.playerIds], name: "" };
    tables.push(table);
  }
  return table;
}

function backfillTables(): void {
  games.forEach((game) => ensureTableFor(game));
  // Drop records whose last game was deleted, otherwise a since-emptied
  // table lingers in every picker forever.
  const live = new Set(games.map(tableKeyOf));
  tables = tables.filter((t) => live.has(t.key));
}

/** Player names joined, the fallback when a table has no custom name. Derived
 *  rather than stored so profile renames flow through automatically. */
function autoTableLabel(playerIds: string[]): string {
  return playerIds.map(playerName).join(", ");
}

function tableLabelForKey(key: string): string {
  const table = tables.find((t) => t.key === key);
  if (!table) return "Unknown table";
  return table.name || autoTableLabel(table.playerIds);
}

/** How many games have been logged at a table, drives the Setup list badge. */
function tableGameCount(key: string): number {
  return games.filter((g) => tableKeyOf(g) === key).length;
}

/* =============================================================================
   PROFILES: shared helpers
============================================================================= */

/** Number of logged games a profile appears in, drives the Setup list's
 *  count badge, the Edit modal's context line, and the delete gate below. */
function gameCountFor(profileId: string): number {
  return games.filter((g) => g.playerIds.includes(profileId)).length;
}

function gameCountLabel(count: number): string {
  return `${count} ${count === 1 ? "game" : "games"}`;
}

/** A profile can only be permanently deleted once retired AND unused,
 *  otherwise deleting it would corrupt table groupings and stats for every
 *  historical game it played in. Retiring (which never touches history)
 *  is always available instead. */
function canDeleteProfile(profile: Profile): boolean {
  return profile.status === "retired" && gameCountFor(profile.id) === 0;
}

function setGsContextLines(container: HTMLElement, lines: string[]): void {
  container.innerHTML = "";
  lines.forEach((text) => {
    const line = document.createElement("div");
    line.className = "gs-context-line";
    line.textContent = text;
    container.appendChild(line);
  });
}

/**
 * Explicit add from the Setup modal's "+ New Profile" button. Reactivates a
 * matching retired profile instead of creating a duplicate; blocks (and
 * flashes) if the name matches an already-active profile, since two active
 * profiles can't share a name. Returns false on that failure so the modal
 * can stay open. Mirrors Time Tracker's addOrReactivateActivity.
 */
function addOrReactivateProfile(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) {
    flash("Name cannot be empty", "error");
    return false;
  }

  const existing = profiles.find((p) => p.name.toLowerCase() === trimmed.toLowerCase());
  if (existing && existing.status === "active") {
    flash("Profile already exists", "error");
    return false;
  }
  const wasReactivated = !!existing && existing.status === "retired";
  if (existing) {
    existing.status = "active";
  } else {
    profiles.push({ id: makeId(), name: trimmed, status: "active" });
  }

  flash(wasReactivated ? "Profile reactivated" : "Profile added", "success");
  saveToDisk();
  // A new/reactivated name has to reach the autocomplete datalist and the
  // Stats compare pickers, not just the Setup list it was added from.
  refreshGsNameDependentUI();
  return true;
}

function buildProfileRow(item: Profile): HTMLElement {
  const row = document.createElement("div");
  row.className = "setup-item";
  if (item.status === "retired") row.classList.add("setup-item-retired");

  const nameSpan = document.createElement("span");
  nameSpan.className = "setup-item-name";
  nameSpan.textContent = item.name;
  if (item.status === "retired") {
    const retiredBadge = document.createElement("span");
    retiredBadge.className = "setup-item-retired-badge";
    retiredBadge.textContent = "Retired";
    retiredBadge.style.marginLeft = "8px";
    nameSpan.appendChild(retiredBadge);
  }
  row.appendChild(nameSpan);

  const countSpan = document.createElement("span");
  countSpan.className = "setup-item-count";
  countSpan.textContent = gameCountLabel(gameCountFor(item.id));
  row.appendChild(countSpan);

  const chevron = document.createElement("span");
  chevron.className = "setup-item-chevron";
  chevron.textContent = "›";
  row.appendChild(chevron);

  row.style.cursor = "pointer";
  row.addEventListener("click", () => openProfileEdit(item));
  return row;
}

function renderProfilesList(): void {
  const container = document.getElementById("gsProfilesList");
  if (!container) return;
  container.innerHTML = "";

  if (profiles.length === 0) {
    const empty = document.createElement("div");
    empty.className = "gs-empty";
    empty.textContent = "No profiles yet. Add one above, or just type a name when starting a game.";
    container.appendChild(empty);
    return;
  }

  [...profiles]
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === "active" ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .forEach((item) => container.appendChild(buildProfileRow(item)));
}

/* =============================================================================
   MODAL: GS SETUP (Profiles / Preferences tabs)
   Module-level so the Add/Edit/Delete modals can reopen Setup afterward.
============================================================================= */

type GsSetupTab = "profiles" | "tables" | "preferences";
let gsActiveSetupTab: GsSetupTab = "profiles";
let gsSetupModal: Modal | null = null;
const _gsSetupPanesToReset = new Set<string>();

function activateGsSetupTab(tab: GsSetupTab): void {
  gsActiveSetupTab = tab;
  document
    .querySelectorAll<HTMLButtonElement>("#gsSettingsModal .setup-tab")
    .forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.gsTab === tab);
    });

  const paneIds: Record<GsSetupTab, string> = {
    profiles: "gsTabProfiles",
    tables: "gsTabTables",
    preferences: "gsTabPreferences",
  };

  for (const [key, id] of Object.entries(paneIds)) {
    const pane = document.getElementById(id)!;
    const isActive = key === tab;
    pane.style.display = isActive ? "" : "none";
    if (isActive && _gsSetupPanesToReset.has(id)) {
      pane.scrollTop = 0;
      _gsSetupPanesToReset.delete(id);
    }
  }
}

function openGsSetupOnTab(tab?: GsSetupTab): void {
  if (tab) gsActiveSetupTab = tab;
  getGsSetupModal().open();
}

function getGsSetupModal(): Modal {
  if (!gsSetupModal) {
    gsSetupModal = new Modal(document.getElementById("gsSettingsBackdrop")!, {
      closeOnEsc: true,
      onOpen: () => {
        activateGsSetupTab(gsActiveSetupTab);
        renderProfilesList();
        renderTablesList();
        applyGsPreferenceLabels();
      },
      onClosed: () => {
        _gsSetupPanesToReset.add("gsTabProfiles");
        _gsSetupPanesToReset.add("gsTabTables");
        _gsSetupPanesToReset.add("gsTabPreferences");
        // Adding/retiring a profile changes Home's Players tile, and Setup is
        // usually opened from Home, repaint so it isn't left stale.
        if (currentGsView === "home") renderHomeDashboard();
      },
    });

    document
      .querySelectorAll<HTMLButtonElement>("#gsSettingsModal .setup-tab")
      .forEach((btn) => {
        btn.addEventListener("click", () => activateGsSetupTab(btn.dataset.gsTab as GsSetupTab));
      });

    document.getElementById("gsSettingsClose")!.addEventListener("click", () => gsSetupModal!.close());
  }
  return gsSetupModal;
}

/* =============================================================================
   MODAL: PROFILE ADD / EDIT
============================================================================= */

let gsProfileAddModal: Modal | null = null;
let gsProfileEditModal: Modal | null = null;
let gsProfileEditItem: Profile | null = null;

function getProfileAddModal(): Modal {
  if (!gsProfileAddModal) {
    const nameInput = document.getElementById("gsProfileAddName") as HTMLInputElement;

    gsProfileAddModal = new Modal(document.getElementById("gsProfileAddBackdrop")!, {
      closeOnEsc: true,
      onOpen: () => setTimeout(() => nameInput.focus(), 50),
    });

    function goBack() { gsProfileAddModal!.close(); openGsSetupOnTab("profiles"); }
    function doSave() {
      if (!addOrReactivateProfile(nameInput.value)) return;
      gsProfileAddModal!.close();
      openGsSetupOnTab("profiles");
    }

    document.getElementById("gsProfileAddBack")!.addEventListener("click", goBack);
    document.getElementById("gsProfileAddClose")!.addEventListener("click", () => gsProfileAddModal!.close());
    document.getElementById("gsProfileAddCancel")!.addEventListener("click", goBack);
    document.getElementById("gsProfileAddSave")!.addEventListener("click", doSave);
    nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doSave(); } });
  }
  return gsProfileAddModal;
}

function openProfileAdd(): void {
  getGsSetupModal().close();
  (document.getElementById("gsProfileAddName") as HTMLInputElement).value = "";
  getProfileAddModal().open();
}

function getProfileEditModal(): Modal {
  if (!gsProfileEditModal) {
    const nameInput = document.getElementById("gsProfileEditName") as HTMLInputElement;
    const retireBtn = document.getElementById("gsProfileEditRetire") as HTMLButtonElement;
    const deleteBtn = document.getElementById("gsProfileEditDelete") as HTMLButtonElement;

    gsProfileEditModal = new Modal(document.getElementById("gsProfileEditBackdrop")!, {
      closeOnEsc: true,
      onOpen: () => setTimeout(() => nameInput.focus(), 50),
      onClosed: () => { gsProfileEditItem = null; },
    });

    function goBack() { gsProfileEditModal!.close(); openGsSetupOnTab("profiles"); }
    function doSave() {
      if (!gsProfileEditItem) return;
      const item = gsProfileEditItem;
      const name = nameInput.value.trim();
      if (!name) { flash("Name cannot be empty", "error"); return; }

      // Profiles are referenced by id everywhere (unlike Time Tracker's
      // free-text activity/project names), so a rename never needs to touch
      // historical games, just block colliding with another active profile.
      if (name.toLowerCase() !== item.name.toLowerCase()) {
        const collision = profiles.find(
          (p) => p.id !== item.id && p.name.toLowerCase() === name.toLowerCase(),
        );
        if (collision) { flash("Another active profile already has that name", "error"); return; }
      }

      item.name = name;
      saveToDisk();
      refreshGsNameDependentUI();
      flash("Profile saved", "success");
      goBack();
    }

    document.getElementById("gsProfileEditBack")!.addEventListener("click", goBack);
    document.getElementById("gsProfileEditClose")!.addEventListener("click", () => gsProfileEditModal!.close());
    document.getElementById("gsProfileEditCancel")!.addEventListener("click", goBack);
    document.getElementById("gsProfileEditSave")!.addEventListener("click", doSave);
    nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doSave(); } });

    retireBtn.addEventListener("click", () => {
      if (!gsProfileEditItem) return;
      gsProfileEditItem.status = gsProfileEditItem.status === "active" ? "retired" : "active";
      saveToDisk();
      refreshGsNameDependentUI();
      flash(gsProfileEditItem.status === "retired" ? "Profile retired" : "Profile reactivated", "success");
      goBack();
    });

    deleteBtn.addEventListener("click", () => {
      if (!gsProfileEditItem) return;
      const item = gsProfileEditItem;
      gsProfileEditModal!.close();
      openProfileDelete(item.id, item.name);
    });
  }
  return gsProfileEditModal;
}

function openProfileEdit(item: Profile): void {
  gsProfileEditItem = item;
  getGsSetupModal().close();
  getProfileEditModal(); // ensure wired
  (document.getElementById("gsProfileEditName") as HTMLInputElement).value = item.name;
  setGsContextLines(document.getElementById("gsProfileEditContext")!, [
    gameCountLabel(gameCountFor(item.id)),
  ]);
  const retireBtn = document.getElementById("gsProfileEditRetire") as HTMLButtonElement;
  const deleteBtn = document.getElementById("gsProfileEditDelete") as HTMLButtonElement;
  retireBtn.textContent = item.status === "active" ? "Retire" : "Reactivate";
  deleteBtn.style.display = canDeleteProfile(item) ? "" : "none";
  getProfileEditModal().open();
}

/* =============================================================================
   MODAL: TABLE EDIT (rename only)
   -----------------------------------------------------------------------------
   A table's identity IS its roster + game, so there's nothing else to edit and
   no delete: removing a table would mean deleting its games. Clearing the name
   just reverts to the auto "A, B, C" label.
============================================================================= */

let gsTableEditModal: Modal | null = null;
let gsTableEditKey: string | null = null;

function buildTableRow(table: GameTable): HTMLElement {
  const row = document.createElement("div");
  row.className = "setup-item";

  const nameSpan = document.createElement("span");
  nameSpan.className = "setup-item-name";
  nameSpan.textContent = table.name || autoTableLabel(table.playerIds);
  if (table.name) {
    // Custom name replaces the roster in the list, so show the roster too,
    // otherwise there'd be no way to tell two named tables apart.
    const roster = document.createElement("span");
    roster.className = "gs-table-roster";
    roster.textContent = autoTableLabel(table.playerIds);
    nameSpan.appendChild(roster);
  }
  row.appendChild(nameSpan);

  const countSpan = document.createElement("span");
  countSpan.className = "setup-item-count";
  countSpan.textContent = gameCountLabel(tableGameCount(table.key));
  row.appendChild(countSpan);

  const chevron = document.createElement("span");
  chevron.className = "setup-item-chevron";
  chevron.textContent = "›";
  row.appendChild(chevron);

  row.style.cursor = "pointer";
  row.addEventListener("click", () => openTableEdit(table));
  return row;
}

function renderTablesList(): void {
  const container = document.getElementById("gsTablesList");
  if (!container) return;
  container.innerHTML = "";

  const live = listAllTables();
  if (live.length === 0) {
    const empty = document.createElement("div");
    empty.className = "gs-empty";
    empty.textContent = "No tables yet. One appears here the first time a group plays a game.";
    container.appendChild(empty);
    return;
  }

  live.forEach((option) => {
    const table = tables.find((t) => t.key === option.key);
    if (table) container.appendChild(buildTableRow(table));
  });
}

/* -----------------------------------------------------------------------
   Seat order. The order a table's players appear in, everywhere. Stored on
   the table record and mirrored onto every game at that table, because it's
   each GAME's playerIds that drives its round-grid columns and its stats
   columns; leaving those alone would make the setting look ignored on the
   only screens where it shows.

   Reordering is safe to apply retroactively: scores are keyed by player id,
   and tableKey() sorts before hashing, so neither a game's data nor its table
   identity depends on this order.
------------------------------------------------------------------------ */

const GS_DRAG_HANDLE_SVG = `
  <svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
    <circle cx="8" cy="6" r="1.6" /><circle cx="16" cy="6" r="1.6" />
    <circle cx="8" cy="12" r="1.6" /><circle cx="16" cy="12" r="1.6" />
    <circle cx="8" cy="18" r="1.6" /><circle cx="16" cy="18" r="1.6" />
  </svg>`;

// Which row is mid-drag, shared by every row's dragover handler so a row can
// find and move the node actually being dragged.
let gsSeatDragId: string | null = null;

function buildSeatRow(playerId: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "gs-seat-row";
  row.dataset.playerId = playerId;
  row.draggable = true;

  const handle = document.createElement("span");
  handle.className = "gs-seat-handle";
  handle.innerHTML = GS_DRAG_HANDLE_SVG;
  handle.title = "Drag to reorder";
  row.appendChild(handle);

  const name = document.createElement("span");
  name.className = "gs-seat-name";
  name.textContent = playerName(playerId);
  row.appendChild(name);

  row.addEventListener("dragstart", (e) => {
    gsSeatDragId = playerId;
    row.classList.add("dragging");
    e.dataTransfer?.setData("text/plain", playerId);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  });
  row.addEventListener("dragend", () => {
    row.classList.remove("dragging");
    gsSeatDragId = null;
  });
  row.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (!gsSeatDragId || gsSeatDragId === playerId) return;
    const dragged = row.parentElement?.querySelector<HTMLElement>(
      `[data-player-id="${CSS.escape(gsSeatDragId)}"]`,
    );
    if (!dragged) return;
    const rect = row.getBoundingClientRect();
    const before = e.clientY - rect.top < rect.height / 2;
    row.parentElement?.insertBefore(dragged, before ? row : row.nextSibling);
  });
  // Without this some drop targets reject the drop and the row snaps back.
  row.addEventListener("drop", (e) => e.preventDefault());

  return row;
}

function renderSeatList(playerIds: string[]): void {
  const container = document.getElementById("gsTableEditSeats")!;
  container.innerHTML = "";
  playerIds.forEach((id) => container.appendChild(buildSeatRow(id)));
}

/** Rewrites a table's seat order and pushes it through to every game played
 *  there, so the change is visible in the round grid and the stats columns
 *  rather than only in this modal. */
function applySeatOrder(table: GameTable, orderedIds: string[]): void {
  table.playerIds = [...orderedIds];
  const seat = new Map(orderedIds.map((id, i) => [id, i]));
  const bySeat = (a: string, b: string) => (seat.get(a) ?? 0) - (seat.get(b) ?? 0);

  games.forEach((game) => {
    if (tableKeyOf(game) !== table.key) return;
    game.playerIds = [...game.playerIds].sort(bySeat);
    // Overtime rounds carry only the tied players, so this is a subset sort.
    // It keeps those rows reading left-to-right in the same order as the rest.
    game.rounds.forEach((round) => {
      round.participantIds = [...round.participantIds].sort(bySeat);
    });
  });
}

function getTableEditModal(): Modal {
  if (!gsTableEditModal) {
    const nameInput = document.getElementById("gsTableEditName") as HTMLInputElement;

    gsTableEditModal = new Modal(document.getElementById("gsTableEditBackdrop")!, {
      closeOnEsc: true,
      onOpen: () => setTimeout(() => nameInput.focus(), 50),
      onClosed: () => { gsTableEditKey = null; },
    });

    function goBack() { gsTableEditModal!.close(); openGsSetupOnTab("tables"); }
    function doSave() {
      const table = tables.find((t) => t.key === gsTableEditKey);
      if (!table) return;
      const name = nameInput.value.trim();
      if (name && tables.some((t) => t.key !== table.key && t.name.toLowerCase() === name.toLowerCase())) {
        flash("Another table already has that name", "error");
        return;
      }
      // Read the order back from the DOM rather than tracking it during the
      // drag, so closing with Cancel really does discard the rearrangement.
      const orderedIds = Array.from(
        document.getElementById("gsTableEditSeats")!.querySelectorAll<HTMLElement>("[data-player-id]"),
      ).map((el) => el.dataset.playerId!);
      const orderChanged = orderedIds.some((id, i) => table.playerIds[i] !== id);

      table.name = name;
      if (orderChanged) applySeatOrder(table, orderedIds);
      saveToDisk();
      flash(
        orderChanged && name ? "Table updated" : orderChanged ? "Seat order updated" : name ? "Table renamed" : "Table name cleared",
        "success",
      );
      // The name shows up in filters, the carousel and section headers.
      refreshGsNameDependentUI();
      goBack();
    }

    document.getElementById("gsTableEditBack")!.addEventListener("click", goBack);
    document.getElementById("gsTableEditClose")!.addEventListener("click", () => gsTableEditModal!.close());
    document.getElementById("gsTableEditCancel")!.addEventListener("click", goBack);
    document.getElementById("gsTableEditSave")!.addEventListener("click", doSave);
    nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doSave(); } });
  }
  return gsTableEditModal;
}

function openTableEdit(table: GameTable): void {
  gsTableEditKey = table.key;
  getGsSetupModal().close();
  getTableEditModal();
  (document.getElementById("gsTableEditName") as HTMLInputElement).value = table.name;
  renderSeatList(table.playerIds);
  setGsContextLines(document.getElementById("gsTableEditContext")!, [
    `${gameTypeLabel(table.gameType)} · ${autoTableLabel(table.playerIds)}`,
    gameCountLabel(tableGameCount(table.key)),
  ]);
  getTableEditModal().open();
}

/* =============================================================================
   SPREADSHEET TEMPLATE / IMPORT
   -----------------------------------------------------------------------------
   Import is all-or-nothing by design. A game log is a record of things that
   actually happened, and a half-applied import leaves the user unable to tell
   which half, so every sheet is validated first and the whole workbook is
   rejected on any problem, with every problem listed at once so the fixes can
   be made in a single pass through Excel.

   The sheet layout, and the parsing of it, live in game-stats-five-crowns.ts
   (it's that game's scoresheet); the ZIP/XML plumbing lives in
   game-stats-xlsx.ts. What's left here is the part that needs to know about
   profiles, tables and the existing game log.
============================================================================= */

const GS_TEMPLATE_MAX_SHEETS = 200;

/** Builds a Read Me plus one blank scoresheet per game, named "Game 1",
 *  "Game 2", ... "Game <count>", ready to fill in and re-import as-is. */
async function downloadGameTemplate(count: number): Promise<void> {
  try {
    const sheets: { name: string; rows: string[][] }[] = [{ name: "Read Me", rows: templateReadmeRows() }];
    for (let i = 1; i <= count; i++) {
      sheets.push({ name: `Game ${i}`, rows: templateGameRows(["Player 1", "Player 2", "Player 3"]) });
    }
    const bytes = buildWorkbook(sheets);
    const now = new Date();
    const timestamp = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
      String(now.getHours()).padStart(2, "0"),
      String(now.getMinutes()).padStart(2, "0"),
      String(now.getSeconds()).padStart(2, "0"),
    ].join("-");
    const path = await invoke<string>("write_game_stats_download", {
      filename: `five-crowns-game-log-template-${timestamp}.xlsx`,
      dataBase64: toBase64(bytes),
    });
    flash(`Template saved to ${shortPath(path)}`, "success");
  } catch (err) {
    devError("Game Stats template download failed", err);
    flash(String(err), "error");
  }
}

/** A validated game, still holding player NAMES, profiles aren't created
 *  until the entire workbook has passed. */
type PendingImport = { parsed: ParsedSheetGame; ids: string[]; game: GameInstance };

/** Maps a sheet's player names onto profile ids, inventing a stable stand-in
 *  id for anyone not yet known. The stand-ins are swapped for real profiles at
 *  commit time, validation must not have side effects, or a rejected import
 *  would still litter the profile list. */
function provisionalPlayerIds(names: string[], pending: Map<string, string>): string[] {
  return names.map((name) => {
    const key = name.toLowerCase();
    const existing = profiles.find((p) => p.name.toLowerCase() === key);
    if (existing) return existing.id;
    let id = pending.get(key);
    if (!id) {
      id = makeId();
      pending.set(key, id);
    }
    return id;
  });
}

/** Turns validated sheets into games, or returns every reason it can't. */
function prepareImport(sheets: { name: string; rows: string[][] }[], gameType: GameType): {
  imports: PendingImport[];
  newProfiles: Map<string, string>;
  errors: string[];
} {
  const errors: string[] = [];
  const gameSheets = sheets.filter((s) => gameNumberFromSheetName(s.name) !== null);

  if (gameSheets.length === 0) {
    return {
      imports: [],
      newProfiles: new Map(),
      errors: ['No game sheets found. Each game needs its own sheet named "Game 1", "Game 2", and so on.'],
    };
  }

  // name(lowercased) -> id for players this workbook would introduce.
  const pendingProfiles = new Map<string, string>();
  const nameCasing = new Map<string, string>();
  const imports: PendingImport[] = [];
  // (table, gameNumber) pairs claimed so far, seeded with what's already saved.
  const claimed = new Set(games.map((g) => `${tableKeyOf(g)}#${g.gameNumber}`));

  for (const sheet of gameSheets) {
    const result = parseGameSheet(sheet.name, sheet.rows);
    if (!result.ok) {
      errors.push(...result.errors);
      continue;
    }
    const parsed = result.game;
    parsed.playerNames.forEach((n) => nameCasing.set(n.toLowerCase(), n));
    const ids = provisionalPlayerIds(parsed.playerNames, pendingProfiles);
    const byName = new Map(parsed.playerNames.map((name, i) => [name, ids[i]]));

    const now = new Date().toISOString();
    const game: GameInstance = {
      id: makeId(),
      gameType,
      gameNumber: parsed.gameNumber,
      // Spreadsheets carry no date, and the app has always allowed games
      // without one, see the Require Date preference.
      date: "",
      playerIds: ids,
      rounds: parsed.rounds.map((round) => {
        const participantIds = ids.filter((id) =>
          Object.keys(round.scores).some((name) => byName.get(name) === id),
        );
        const scores: Record<string, number | null> = {};
        participantIds.forEach((id) => {
          const name = parsed.playerNames.find((n) => byName.get(n) === id)!;
          scores[id] = round.scores[name];
        });
        return { roundIndex: round.roundIndex, isOvertime: round.isOvertime, participantIds, scores };
      }),
      createdAt: now,
      updatedAt: now,
    };

    const key = `${tableKeyOf(game)}#${game.gameNumber}`;
    if (claimed.has(key)) {
      errors.push(
        `${sheet.name}: this table already has a Game ${game.gameNumber}. Renumber the sheet, or delete the existing game first.`,
      );
      continue;
    }
    claimed.add(key);

    // The rules decide whether a scoresheet is actually finished, an
    // unresolved tie after round 13 needs overtime rows that aren't there.
    if (!deriveGameState(game).isComplete) {
      errors.push(
        `${sheet.name}: the game isn't finished: the final totals are tied, so it needs overtime rows.`,
      );
      continue;
    }

    imports.push({ parsed, ids, game });
  }

  const newProfiles = new Map<string, string>();
  pendingProfiles.forEach((id, key) => newProfiles.set(nameCasing.get(key) ?? key, id));
  return { imports, newProfiles, errors };
}

function commitImport(imports: PendingImport[], newProfiles: Map<string, string>): void {
  newProfiles.forEach((id, name) => {
    profiles.push({ id, name, status: "active" });
  });

  // Sorted so a table created by this import is seeded by its earliest game,
  // which is what fixes its seat order for everything that follows.
  [...imports]
    .sort((a, b) => a.game.gameNumber - b.game.gameNumber)
    .forEach(({ game }) => {
      game.playerIds = canonicalSeatOrder(game.gameType, game.playerIds);
      // The rounds were built in the sheet's column order, so re-sort their
      // participant lists to match. Same invariant applySeatOrder() keeps.
      const seat = new Map(game.playerIds.map((id, i) => [id, i]));
      game.rounds.forEach((round) => {
        round.participantIds = [...round.participantIds].sort(
          (a, b) => (seat.get(a) ?? 0) - (seat.get(b) ?? 0),
        );
      });
      games.push(game);
      ensureTableFor(game);
    });

  backfillTables();
  saveToDisk();
  refreshProfileDatalist();
  refreshHistoricalFilterOptions();
  refreshStatsTableOptions();
  refreshFillFromTableOptions();
  refreshSuggestedGameNumber();
}

/* =============================================================================
   MODAL: IMPORT WORKBOOK
   Choose-then-run, mirroring Time Tracker's CSV Import modal
   (getCsvImportModal() in time-tracker.ts): pick a file, then confirm with a
   separate Import button, with the result (or every validation error) shown
   inline rather than in a follow-up modal.
============================================================================= */

function refreshGsImportStatusUI(): void {
  const text = settings.lastImportAt
    ? `Last import: ${formatImportTimestamp(settings.lastImportAt)}`
    : "Never imported";
  const badge = document.getElementById("gsImportStatus");
  if (badge) badge.textContent = text;
  const modalLine = document.getElementById("gsImportLastRow");
  if (modalLine) modalLine.textContent = text;
}

function showGsImportResult(kind: "success" | "error", summary: string, errors: string[]): void {
  const el = document.getElementById("gsImportSummary") as HTMLElement;
  el.textContent = summary;
  el.className = `gs-import-summary ${kind}`;
  const list = document.getElementById("gsImportErrorList")!;
  list.innerHTML = "";
  errors.forEach((message) => {
    const li = document.createElement("li");
    li.textContent = message;
    list.appendChild(li);
  });
}

let gsImportModal: Modal | null = null;
let gsImportResultModal: Modal | null = null;
let gsImportSelectedPath: string | null = null;
let gsImportGameType: GameType = "five-crowns";
let gsImportLastOk = false;

function resetGsImportModalState(): void {
  gsImportSelectedPath = null;
  document.getElementById("gsImportFileName")!.textContent = "No file selected";
  (document.getElementById("gsImportRunBtn") as HTMLButtonElement).disabled = true;
}

/** Opens the result modal in place of the Import modal (replaceModal), so the
 *  Import modal's file selection survives underneath for "Try Again". */
function openGsImportResult(kind: "success" | "error", summary: string, errors: string[]): void {
  gsImportLastOk = kind === "success";
  showGsImportResult(kind, summary, errors);
  const actionBtn = document.getElementById("gsImportResultActionBtn") as HTMLButtonElement;
  actionBtn.textContent = gsImportLastOk ? "Done" : "Try Again";
  getGsImportResultModal().open();
}

function getGsImportResultModal(): Modal {
  if (!gsImportResultModal) {
    gsImportResultModal = new Modal(document.getElementById("gsImportResultBackdrop")!, {
      closeOnEsc: true,
      replaceModal: getGsImportModal(),
    });

    // Abandons the whole flow regardless of outcome. Same destination as a
    // successful "Done", since there's nothing left on the Import modal worth
    // returning to once the result modal's X is clicked.
    const finish = () => {
      gsImportResultModal!.close();
      resetGsImportModalState();
      openGsSetupOnTab("preferences");
    };
    document.getElementById("gsImportResultClose")!.addEventListener("click", finish);

    document.getElementById("gsImportResultActionBtn")!.addEventListener("click", () => {
      if (gsImportLastOk) {
        finish();
      } else {
        // Reopen the Import modal directly (not openGsImportModal(), which
        // would reset the file selection) so the chosen file is still there.
        gsImportResultModal!.close();
        getGsImportModal().open();
      }
    });
  }
  return gsImportResultModal;
}

async function runGsImport(): Promise<void> {
  if (!gsImportSelectedPath) return;
  const runBtn = document.getElementById("gsImportRunBtn") as HTMLButtonElement;
  runBtn.disabled = true;

  let sheets: { name: string; rows: string[][] }[];
  try {
    const base64 = await invoke<string>("read_game_stats_workbook", { path: gsImportSelectedPath });
    sheets = await readWorkbook(fromBase64(base64));
  } catch (err) {
    devError("Game Stats workbook read failed", err);
    // A WorkbookError is already phrased for the user; anything else is a
    // Rust-side message (missing file, over the size limit) that also is.
    runBtn.disabled = false;
    openGsImportResult("error", "Import failed", [err instanceof WorkbookError ? err.message : String(err)]);
    return;
  }

  const { imports, newProfiles, errors } = prepareImport(sheets, gsImportGameType);
  if (errors.length > 0) {
    runBtn.disabled = false;
    openGsImportResult(
      "error",
      `Nothing was imported: ${errors.length} ${errors.length === 1 ? "problem" : "problems"} to fix`,
      errors,
    );
    return;
  }

  commitImport(imports, newProfiles);
  settings.lastImportAt = new Date().toISOString();
  saveToDisk();
  refreshGsImportStatusUI();

  const profileNote = newProfiles.size
    ? ` New ${newProfiles.size === 1 ? "profile" : "profiles"}: ${[...newProfiles.keys()].join(", ")}.`
    : "";
  runBtn.disabled = false;
  openGsImportResult(
    "success",
    `Imported ${imports.length} ${imports.length === 1 ? "game" : "games"}.${profileNote}`,
    [],
  );
  flash("Workbook import complete", "success");
}

function getGsImportModal(): Modal {
  if (!gsImportModal) {
    gsImportModal = new Modal(document.getElementById("gsImportBackdrop")!, {
      closeOnEsc: true,
      onOpen: () => refreshGsImportStatusUI(),
      onClosed: () => resetGsImportModalState(),
    });

    const goBack = () => { gsImportModal!.close(); openGsSetupOnTab("preferences"); };

    document.getElementById("gsImportBack")!.addEventListener("click", goBack);
    document.getElementById("gsImportClose")!.addEventListener("click", goBack);
    document.getElementById("gsImportCancelBtn")!.addEventListener("click", goBack);

    fillGameTypeSelect(document.getElementById("gsImportGameTypeSelect") as HTMLSelectElement, gsImportGameType);
    document.getElementById("gsImportGameTypeSelect")!.addEventListener("change", (e) => {
      gsImportGameType = (e.target as HTMLSelectElement).value as GameType;
    });

    document.getElementById("gsImportTemplateBtn")!.addEventListener("click", () => {
      const countInput = document.getElementById("gsImportTemplateCount") as HTMLInputElement;
      const count = Math.min(GS_TEMPLATE_MAX_SHEETS, Math.max(1, Math.round(Number(countInput.value)) || 1));
      countInput.value = String(count);
      void downloadGameTemplate(count);
    });

    document.getElementById("gsImportChooseBtn")!.addEventListener("click", async () => {
      const selected = await open({
        multiple: false,
        directory: false,
        title: "Choose a game log workbook",
        filters: [{ name: "Excel Workbook", extensions: ["xlsx"] }],
      });
      if (!selected || Array.isArray(selected)) return;
      gsImportSelectedPath = selected;
      document.getElementById("gsImportFileName")!.textContent = selected.split(/[\\/]/).pop() || selected;
      (document.getElementById("gsImportRunBtn") as HTMLButtonElement).disabled = false;
    });

    document.getElementById("gsImportRunBtn")!.addEventListener("click", () => { void runGsImport(); });
  }
  return gsImportModal;
}

function openGsImportModal(): void {
  getGsSetupModal().close();
  resetGsImportModalState();
  getGsImportModal().open();
}

/* =============================================================================
   MODAL: PROFILE DELETE CONFIRM
   Only reachable via canDeleteProfile()'s gate (retired AND zero logged
   games). Delete Permanently is hidden otherwise, so no "reassign history"
   handling is needed here.
============================================================================= */

let gsProfileDeleteModal: Modal | null = null;
let pendingProfileDelete: { id: string; name: string } | null = null;

function getProfileDeleteModal(): Modal {
  if (!gsProfileDeleteModal) {
    gsProfileDeleteModal = new Modal(document.getElementById("gsProfileDeleteBackdrop")!, {
      closeOnEsc: true,
      onClosed: () => { pendingProfileDelete = null; },
    });

    document.getElementById("gsProfileDeleteConfirmBtn")!.addEventListener("click", () => {
      if (!pendingProfileDelete) return;
      const { id } = pendingProfileDelete;
      profiles = profiles.filter((p) => p.id !== id);
      pendingProfileDelete = null;
      saveToDisk();
      refreshGsNameDependentUI();
      gsProfileDeleteModal!.close();
      openGsSetupOnTab("profiles");
      flash("Profile deleted", "success");
    });

    document.getElementById("gsProfileDeleteCancelBtn")!.addEventListener("click", () => {
      pendingProfileDelete = null;
      gsProfileDeleteModal!.close();
      openGsSetupOnTab("profiles");
    });
  }
  return gsProfileDeleteModal;
}

function openProfileDelete(id: string, name: string): void {
  pendingProfileDelete = { id, name };
  document.getElementById("gsProfileDeleteMessage")!.textContent =
    `Permanently delete "${name}"? This can't be undone.`;
  getProfileDeleteModal().open();
}

/* =============================================================================
   VIEW SWITCHING (Home / New Game / Historical / Stats)
============================================================================= */

type GsView = "home" | "new-game" | "historical" | "stats";

const GS_VIEW_IDS: Record<GsView, string> = {
  home: "gsViewHome",
  "new-game": "gsViewNewGame",
  historical: "gsViewHistorical",
  stats: "gsViewStats",
};

let currentGsView: GsView = "home";

/* Each of the three working views picks a game type FIRST, then narrows to a
   table/player within it, tables are per game type, so the game is the outer
   axis everywhere. Kept per-view rather than as one global so switching views
   never silently re-scopes another one. */
let gsNewGameType: GameType = "five-crowns";
let gsHistGameType: GameType = "five-crowns";
let gsStatsGameType: GameType = "five-crowns";

/**
 * Filter lifetime, per the rule "only reset if you leave the view as a whole":
 * a view's own selections survive detours into a game's detail screen (which
 * is a SUB-view of wherever you came from), and are only cleared when you
 * deliberately go somewhere else. The other nav destinations, a view's own
 * Back button, or another tool entirely (see onGameStatsToolEntry).
 *
 * So the reset is NOT done here on every departure. It's driven by the
 * caller, since only the caller knows whether this is a detour or a real
 * exit, showGsView() can't tell "opened a game from Historical" apart from
 * "clicked New Game" when both land on the same view id.
 */
function showGsView(view: GsView): void {
  currentGsView = view;

  for (const [key, id] of Object.entries(GS_VIEW_IDS)) {
    document.getElementById(id)!.style.display = key === view ? "" : "none";
  }
  // Home's tiles are derived from `games`, so they're rebuilt on every
  // arrival rather than kept in sync from each mutation site.
  if (view === "home") renderHomeDashboard();
  pushGsViewHistory(view, view === "new-game" && gsGameMode !== "create" ? editingGameId ?? undefined : undefined);
}

/** Clears whatever the view you're leaving had selected. Called only from
 *  real exits (nav buttons, Back, and tool re-entry) never from opening a
 *  game, which is a sub-view of the list you opened it from. */
function leaveGsView(from: GsView): void {
  if (from === "historical") resetHistoricalFilters();
  if (from === "stats") resetStatsSelections();
}

/* -----------------------------------------------------------------------
   Mouse back/forward, a small history stack local to this tool's own
   sub-pages, claimed via shell.ts's setSubNavHandler() only while the
   Game Stats tool view is actually visible (see gsSubNavBack/Forward).

   Entries carry a gameId for the detail view, so stepping back through a
   chain of games (reached via the carousel or the jump-to-number field)
   returns to each game in turn rather than dumping you back at the list.
------------------------------------------------------------------------ */

type GsHistoryEntry = { view: GsView; gameId?: string };

let gsViewHistory: GsHistoryEntry[] = [{ view: "home" }];
let gsViewHistoryIndex = 0;
let gsIsNavigatingHistory = false;

function pushGsViewHistory(view: GsView, gameId?: string): void {
  if (gsIsNavigatingHistory) return;
  const current = gsViewHistory[gsViewHistoryIndex];
  if (current && current.view === view && current.gameId === gameId) return;
  gsViewHistory = gsViewHistory.slice(0, gsViewHistoryIndex + 1);
  gsViewHistory.push({ view, gameId });
  gsViewHistoryIndex = gsViewHistory.length - 1;
}

/** Replays a history entry without re-recording it. A game-detail entry
 *  whose game was since deleted degrades to its bare view rather than
 *  dead-ending the back button. */
function applyGsHistoryEntry(entry: GsHistoryEntry): void {
  gsIsNavigatingHistory = true;
  const game = entry.gameId ? games.find((g) => g.id === entry.gameId) : undefined;
  if (entry.view === "new-game" && game) {
    openGameForView(game, { recordHistory: false });
  } else {
    showGsView(entry.view);
  }
  gsIsNavigatingHistory = false;
}

/** Whether the tool is actually rendered right now, checking this element's
 *  own style.display isn't enough, since leaving the tool for another one
 *  hides it by removing the .active class from its ancestor #section-games
 *  (a CSS-level hide), not by touching this element's inline style at all.
 *  offsetParent is null for anything hidden by itself OR by an ancestor. */
function gsToolIsVisible(): boolean {
  const view = document.getElementById("games-tool-game-stats");
  return !!view && view.offsetParent !== null;
}

function gsSubNavBack(): boolean {
  if (!gsToolIsVisible() || gsViewHistoryIndex <= 0) return false;
  gsViewHistoryIndex--;
  applyGsHistoryEntry(gsViewHistory[gsViewHistoryIndex]);
  return true;
}

function gsSubNavForward(): boolean {
  if (!gsToolIsVisible() || gsViewHistoryIndex >= gsViewHistory.length - 1) return false;
  gsViewHistoryIndex++;
  applyGsHistoryEntry(gsViewHistory[gsViewHistoryIndex]);
  return true;
}

function gsToday(): string {
  return new Date().toLocaleDateString("en-CA");
}

function playerName(id: string): string {
  return profiles.find((p) => p.id === id)?.name ?? "?";
}

/** Games newest-first. The order Historical lists them in. Delegates to the
 *  stats engine's play-order rule (game number within a table, date/entry
 *  time across tables) and reverses it, so the list can't disagree with what
 *  the streaks and win chart consider "most recent". */
function gamesNewestFirst(source: GameInstance[]): GameInstance[] {
  return sortChronologically(source).reverse();
}

/* =============================================================================
   HOME: dashboard tiles + recent games
   -----------------------------------------------------------------------------
   Everything here is derived from `games`/`profiles` on each render, same as
   the rest of the tool. Nothing is cached or stored.
============================================================================= */

function buildTile(
  value: string,
  label: string,
  opts: { sub?: string; alert?: boolean; title?: string } = {},
): HTMLElement {
  const tile = document.createElement("div");
  tile.className = "gs-tile";
  if (opts.alert) tile.classList.add("gs-tile-alert");
  if (opts.title) tile.title = opts.title;

  const valueEl = document.createElement("div");
  valueEl.className = "gs-tile-value";
  valueEl.textContent = value;
  tile.appendChild(valueEl);

  const labelEl = document.createElement("div");
  labelEl.className = "gs-tile-label";
  labelEl.textContent = label;
  tile.appendChild(labelEl);

  if (opts.sub) {
    const subEl = document.createElement("div");
    subEl.className = "gs-tile-sub";
    subEl.textContent = opts.sub;
    tile.appendChild(subEl);
  }
  return tile;
}

/** Wins per player across every completed game, a tie counts as a win for
 *  each winner, matching how deriveGameState reports shared victories. */
function winLeader(): { name: string; wins: number } | null {
  const tally = new Map<string, number>();
  games.forEach((g) => {
    const state = deriveGameState(g);
    if (!state.isComplete) return;
    state.winnerIds.forEach((id) => tally.set(id, (tally.get(id) ?? 0) + 1));
  });
  if (tally.size === 0) return null;
  const [id, wins] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
  return { name: playerName(id), wins };
}

/** "2026-08-07" -> "Aug 7, 2026". Games saved with the date left blank (the
 *  requireDate preference off) fall back to an em dash. */
function formatGameDate(date: string): string {
  if (!date) return "—";
  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** ISO timestamp -> "Aug 7, 2026, 3:45 PM", for the import status badge/line. */
function formatImportTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${date}, ${time}`;
}

/** Home is a launchpad, not a dashboard: four destinations plus a thin strip
 *  of at-a-glance numbers. It deliberately shows no game list (browsing
 *  belongs to Historical, which can filter) and no game-type switcher, since
 *  each destination picks its own game type on arrival. */
function renderHomeDashboard(): void {
  const tiles = document.getElementById("gsHomeTiles");
  if (!tiles) return;
  tiles.innerHTML = "";
  const inProgress = games.filter((g) => !deriveGameState(g).isComplete).length;
  const activeProfiles = profiles.filter((p) => p.status === "active").length;
  const retiredProfiles = profiles.length - activeProfiles;
  const leader = winLeader();
  const tableCount = listAllTables().length;

  tiles.appendChild(
    buildTile(String(games.length), "Games Logged", {
      sub: tableCount > 0 ? `${tableCount} ${tableCount === 1 ? "table" : "tables"}` : undefined,
    }),
  );
  tiles.appendChild(
    buildTile(String(activeProfiles), "Players", {
      sub: retiredProfiles > 0 ? `${retiredProfiles} retired` : undefined,
    }),
  );
  tiles.appendChild(
    leader
      ? buildTile(leader.name, "Most Wins", {
          sub: `${leader.wins} ${leader.wins === 1 ? "win" : "wins"}`,
          title: leader.name,
        })
      : buildTile("—", "Most Wins", { sub: "No completed games" }),
  );
  if (inProgress > 0) {
    tiles.appendChild(
      buildTile(String(inProgress), "In Progress", { sub: "Unfinished games", alert: true }),
    );
  }
}

/* =============================================================================
   NEW GAME: step 1: title / date / players
============================================================================= */

// The game instance under construction, only exists once "Start Game" has
// been clicked (step 2). Discarded on Save, Cancel, or "Start Over".
let newGameDraft: GameInstance | null = null;
// Non-null while editing an already-saved game from the Historical list.
// Save replaces that record in place instead of pushing a new one, and
// player editing (step 1) is skipped entirely since changing an existing
// game's players is a bigger structural edit than this flow supports.
let editingGameId: string | null = null;
// Where Save/Cancel should return to. Home for a fresh game, Historical
// Games when editing an existing record from that list.
let newGameReturnView: GsView = "home";

function refreshProfileDatalist(): void {
  const datalist = document.getElementById("gsProfileDatalist") as HTMLDataListElement | null;
  if (!datalist) return;
  datalist.innerHTML = "";
  profiles
    .filter((p) => p.status === "active")
    .map((p) => p.name)
    .sort((a, b) => a.localeCompare(b))
    .forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      datalist.appendChild(opt);
    });
}

/** Resolves a typed player name to a profile id: matches an existing profile
 *  case-insensitively (reactivating it if retired, entering someone in a
 *  new game means they're playing again), or silently creates a new active
 *  profile if there's no match. Returns null only for a blank name. */
function resolvePlayerName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const existing = profiles.find((p) => p.name.toLowerCase() === trimmed.toLowerCase());
  if (existing) {
    if (existing.status === "retired") {
      existing.status = "active";
      saveToDisk();
    }
    return existing.id;
  }
  const profile: Profile = { id: makeId(), name: trimmed, status: "active" };
  profiles.push(profile);
  saveToDisk();
  refreshProfileDatalist();
  return profile.id;
}

function buildPlayerPickerRow(index: number): HTMLElement {
  const row = document.createElement("div");
  row.className = "gs-player-picker-row";

  // Seat number. The row order here becomes the game's column order, so it's
  // worth making explicit rather than leaving it implied by the placeholder.
  const seat = document.createElement("span");
  seat.className = "gs-player-index";
  seat.textContent = String(index + 1);
  row.appendChild(seat);

  const input = document.createElement("input");
  input.type = "text";
  input.autocomplete = "off";
  input.setAttribute("list", "gsProfileDatalist");
  input.placeholder = `Player ${index + 1}`;
  input.addEventListener("input", () => {
    // Full state pass rather than just the hint: whether Clear Players has
    // anything left to clear changes as the names are typed and erased.
    refreshPlayerPickerState();
    // The roster decides which table's sequence this game joins, so the
    // suggested number has to follow every edit to the names.
    refreshSuggestedGameNumber();
  });
  row.appendChild(input);

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "gs-player-remove-btn";
  removeBtn.title = "Remove player";
  removeBtn.textContent = "×";
  removeBtn.addEventListener("click", () => removePlayerPickerRow(row));
  row.appendChild(removeBtn);

  return row;
}

const GS_MIN_PLAYERS = 2;
const GS_MAX_PLAYERS = 8;

/** Keeps each row's placeholder ("Player N") matching its current position.
 *  Without this, removing a row from the middle leaves the surviving rows
 *  showing stale placeholder numbers, and a later "+ Add Player" can end up
 *  reusing one of those same numbers on a second, different row. */
function renumberPlayerPickerRows(): void {
  const container = document.getElementById("gsPlayerPickers")!;
  Array.from(container.children).forEach((row, i) => {
    const input = row.querySelector("input");
    if (input) input.placeholder = `Player ${i + 1}`;
    const seat = row.querySelector(".gs-player-index");
    if (seat) seat.textContent = String(i + 1);
  });
}

/** Footer line under the setup panel: how many seats are filled, and (once
 *  the minimum is met) whether any name is new to the profile pool. The only
 *  place the silent profile creation in resolvePlayerName() is surfaced
 *  before it happens. */
function refreshPlayerCountHint(): void {
  const hint = document.getElementById("gsPlayerCountHint");
  const container = document.getElementById("gsPlayerPickers");
  if (!hint || !container) return;

  const names = Array.from(container.querySelectorAll("input"))
    .map((input) => input.value.trim())
    .filter(Boolean);
  const seats = container.children.length;

  if (names.length < GS_MIN_PLAYERS) {
    hint.textContent = `${names.length} of ${seats} seats filled, a game needs at least ${GS_MIN_PLAYERS} players.`;
    return;
  }
  const newNames = names.filter(
    (name) => !profiles.some((p) => p.name.toLowerCase() === name.toLowerCase()),
  );
  const base = `${names.length} ${names.length === 1 ? "player" : "players"} ready`;
  hint.textContent = newNames.length
    ? `${base}. New profile${newNames.length === 1 ? "" : "s"} for ${newNames.join(", ")}.`
    : `${base}.`;
}

function refreshPlayerPickerState(): void {
  const container = document.getElementById("gsPlayerPickers")!;
  const canRemove = container.children.length > GS_MIN_PLAYERS;
  container.querySelectorAll<HTMLButtonElement>(".gs-player-remove-btn").forEach((btn) => {
    btn.disabled = !canRemove;
  });
  // "+ Add Player" stays enabled at the cap on purpose, addPlayerPickerRow()
  // flashes why, which is more useful than a silently dead button. Clear is
  // different: at the default two empty seats it would do literally nothing,
  // so it greys out instead of pretending to act.
  const clearBtn = document.getElementById("gsClearPlayersBtn") as HTMLButtonElement | null;
  if (clearBtn) clearBtn.disabled = !isPlayerPickerDirty();
  refreshPlayerCountHint();
}

/** True when Clear Players has something to undo. Either extra seats or any
 *  name typed into one. */
function isPlayerPickerDirty(): boolean {
  const container = document.getElementById("gsPlayerPickers")!;
  if (container.children.length > GS_MIN_PLAYERS) return true;
  return Array.from(container.querySelectorAll("input")).some((input) => input.value.trim() !== "");
}

/** Empties the roster back to the default blank seats. The "fill from table"
 *  select is reset alongside it, leaving it pointing at a table whose players
 *  are no longer on screen would misreport where the game number came from. */
function clearPlayerPickers(): void {
  const container = document.getElementById("gsPlayerPickers")!;
  container.innerHTML = "";
  for (let i = 0; i < GS_MIN_PLAYERS; i++) container.appendChild(buildPlayerPickerRow(i));
  (document.getElementById("gsFillFromTableSelect") as HTMLSelectElement).value = "";
  refreshPlayerPickerState();
  renumberPlayerPickerRows();
  refreshSuggestedGameNumber();
}

function removePlayerPickerRow(row: HTMLElement): void {
  const container = document.getElementById("gsPlayerPickers")!;
  if (container.children.length <= GS_MIN_PLAYERS) return;
  row.remove();
  refreshPlayerPickerState();
  renumberPlayerPickerRows();
  refreshSuggestedGameNumber();
}

function addPlayerPickerRow(): void {
  const container = document.getElementById("gsPlayerPickers")!;
  if (container.children.length >= GS_MAX_PLAYERS) {
    flash(`Five Crowns tops out around ${GS_MAX_PLAYERS} players`, "error");
    return;
  }
  container.appendChild(buildPlayerPickerRow(container.children.length));
  refreshPlayerPickerState();
  renumberPlayerPickerRows();
}

/** The next number for a specific table, game type + exact roster. Scoping
 *  it this way is what stops a game at some OTHER table from punching a hole
 *  in this table's sequence: your 176th game with the same three people is
 *  Game 176 no matter what else got logged in between.
 *
 *  Based on the highest number ever assigned AT THAT TABLE, not its game
 *  count, so deleting a game doesn't cause a later one to be reused. */
function nextGameNumber(gameType: GameType, playerIds: string[]): number {
  const key = tableKey(gameType, playerIds);
  return games.filter((g) => tableKeyOf(g) === key).reduce((max, g) => Math.max(max, g.gameNumber), 0) + 1;
}

function refreshFillFromTableOptions(): void {
  const select = document.getElementById("gsFillFromTableSelect") as HTMLSelectElement;
  // Preserved the same way the other option lists do it, so this is safe to
  // call purely to re-label the options (a profile rename changes every
  // auto-generated table label) without silently dropping the user's pick.
  const current = select.value;
  select.innerHTML = "";
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = "(None)";
  select.appendChild(blank);
  listAllTables(gsNewGameType).forEach((t) => {
    const opt = document.createElement("option");
    opt.value = t.key;
    opt.textContent = t.label;
    select.appendChild(opt);
  });
  select.value = [...select.options].some((o) => o.value === current) ? current : "";
}

/** Replaces the current player picker rows with the given table's players,
 *  pre-filled by name (still resolved to profile ids the normal way at
 *  Start Game, same as if typed by hand). */
function applyFillFromTable(key: string): void {
  const table = listAllTables(gsNewGameType).find((t) => t.key === key);
  if (!table) return;
  const container = document.getElementById("gsPlayerPickers")!;
  container.innerHTML = "";
  table.playerIds.forEach((id, i) => {
    const row = buildPlayerPickerRow(i);
    (row.querySelector("input") as HTMLInputElement).value = playerName(id);
    container.appendChild(row);
  });
  refreshPlayerPickerState();
  renumberPlayerPickerRows();
  refreshSuggestedGameNumber();
}

/* -----------------------------------------------------------------------
   Suggested game number, shown on the setup panel BEFORE the game starts,
   so it can be checked against a paper scoresheet while the roster is still
   on screen. Locked by default (the auto value is right whenever games are
   entered in order); the unlock toggle is there for the rare transcription
   slip, and warns rather than silently leaving a hole in the sequence.
------------------------------------------------------------------------ */

let gsGameNumberUnlocked = false;

/** Profile ids for whatever's currently typed into the player rows, without
 *  creating any profiles, resolvePlayerName() does that, but only once the
 *  game actually starts. Unknown names simply don't resolve yet, so the
 *  suggested number treats the roster as new until they exist. */
function draftPlayerIds(): string[] {
  const container = document.getElementById("gsPlayerPickers");
  if (!container) return [];
  const ids: string[] = [];
  Array.from(container.querySelectorAll("input")).forEach((input) => {
    const name = (input as HTMLInputElement).value.trim();
    if (!name) return;
    const match = profiles.find((p) => p.name.toLowerCase() === name.toLowerCase());
    ids.push(match ? match.id : `new:${name.toLowerCase()}`);
  });
  return ids;
}

function suggestedGameNumber(): number {
  return nextGameNumber(gsNewGameType, draftPlayerIds());
}

function refreshSuggestedGameNumber(): void {
  const input = document.getElementById("gsGameNumberInput") as HTMLInputElement | null;
  if (!input) return;
  // While unlocked the user owns the value, recomputing would stomp on what
  // they're mid-way through typing.
  if (!gsGameNumberUnlocked) input.value = String(suggestedGameNumber());
  refreshGameNumberHint();
}

function refreshGameNumberHint(): void {
  const hint = document.getElementById("gsGameNumberHint");
  const input = document.getElementById("gsGameNumberInput") as HTMLInputElement | null;
  if (!hint || !input) return;

  const suggested = suggestedGameNumber();
  const typed = Number(input.value.trim());
  const ids = draftPlayerIds();
  const known = ids.length > 0 && ids.every((id) => !id.startsWith("new:"));
  const tableLabel = known ? tableLabelForKey(tableKey(gsNewGameType, ids)) : "";

  if (!gsGameNumberUnlocked) {
    hint.classList.remove("gs-hint-warn");
    hint.textContent =
      suggested === 1
        ? "First game for this table, so numbering starts at 1."
        : `Counts within ${tableLabel || "this table"} only.`;
    return;
  }

  if (!Number.isInteger(typed) || typed < 1) {
    hint.classList.add("gs-hint-warn");
    hint.textContent = "Game number must be a whole number of 1 or more.";
    return;
  }
  const clash = games.find(
    (g) => tableKeyOf(g) === tableKey(gsNewGameType, ids) && g.gameNumber === typed,
  );
  if (clash) {
    hint.classList.add("gs-hint-warn");
    hint.textContent = `This table already has a Game ${typed}.`;
  } else if (typed > suggested) {
    hint.classList.add("gs-hint-warn");
    hint.textContent = `Skips ${typed - suggested} number${typed - suggested === 1 ? "" : "s"}, leaving a gap after Game ${suggested - 1}.`;
  } else {
    hint.classList.remove("gs-hint-warn");
    hint.textContent = `Suggested: ${suggested}.`;
  }
}

function setGameNumberUnlocked(unlocked: boolean): void {
  gsGameNumberUnlocked = unlocked;
  const input = document.getElementById("gsGameNumberInput") as HTMLInputElement;
  const btn = document.getElementById("gsGameNumberLockBtn") as HTMLButtonElement;
  input.readOnly = !unlocked;
  input.classList.toggle("gs-locked-input", !unlocked);
  btn.classList.toggle("is-unlocked", unlocked);
  btn.title = unlocked ? "Lock game number (use the suggested value)" : "Unlock to set the game number by hand";
  btn.setAttribute("aria-label", btn.title);
  if (!unlocked) input.value = String(suggestedGameNumber());
  refreshGameNumberHint();
}

/* -----------------------------------------------------------------------
   Game mode, "create" is the original New Game flow (Save Game/Cancel at
   the bottom, players editable in step 1). "view"/"edit" are reached by
   double-clicking a Historical card: read-only with an Edit button in the
   header and a Delete Game button at the bottom, until Edit is clicked,
   which swaps the header button for Save Changes/Discard Changes and
   unlocks the date and round grid for editing.
------------------------------------------------------------------------ */

type GsGameMode = "create" | "view" | "edit";
let gsGameMode: GsGameMode = "create";
// Snapshot taken the moment Edit is clicked, so Discard Changes can revert
// to it regardless of how many edits were made since.
let gsPreEditSnapshot: GameInstance | null = null;

/** True while the round grid's score inputs should be disabled, only in
 *  "view" mode. Consulted by renderRoundGrid(). */
let gsGameReadOnly = false;

function applyGsGameMode(): void {
  const isCreate = gsGameMode === "create";
  const isView = gsGameMode === "view";
  const isEdit = gsGameMode === "edit";

  document.getElementById("gsEditPlayersBtn")!.style.display = isCreate ? "" : "none";
  document.getElementById("gsViewEditBtn")!.style.display = isView ? "" : "none";
  document.getElementById("gsViewSaveBtn")!.style.display = isEdit ? "" : "none";
  document.getElementById("gsViewDiscardBtn")!.style.display = isEdit ? "" : "none";

  document.getElementById("gsSaveGameBtn")!.style.display = isCreate ? "" : "none";
  document.getElementById("gsCancelGameBtn")!.style.display = isCreate ? "" : "none";
  document.getElementById("gsDeleteGameBtn")!.style.display = isCreate ? "none" : "";

  const crumb = document.getElementById("gsNewGameCrumb");
  if (crumb) crumb.textContent = isCreate ? "New Game" : isEdit ? "Editing Game" : "Game Detail";

  const dateInput = document.getElementById("gsGameDateEdit") as HTMLInputElement;
  dateInput.disabled = isView;
  (document.getElementById("gsGameDateNowBtn") as HTMLButtonElement).disabled = isView;

  document.getElementById("gsGameCarousel")!.style.display = isView ? "" : "none";
  // The centered carousel bar is the one place "Game N" shows in read-only
  // view. The header's own title would just be a redundant second copy.
  document.getElementById("gsPlayersSummary")!.style.display = isView ? "none" : "";

  gsGameReadOnly = isView;
  renderGameHeader();
  renderRoundGrid();
}

/* -----------------------------------------------------------------------
   Game header, title, status badges and the live scoreboard strip.
   The scoreboard restates the running totals from the grid's footer in a
   glanceable form, so the current standings are readable without tracking
   the bottom row across a wide, horizontally-scrolled grid.
------------------------------------------------------------------------ */

function addGameBadge(container: HTMLElement, text: string, variant: string): void {
  const badge = document.createElement("span");
  badge.className = `gs-badge ${variant}`;
  badge.textContent = text;
  container.appendChild(badge);
}

function renderGameBadges(game: GameInstance): void {
  const container = document.getElementById("gsGameBadges");
  if (!container) return;
  container.innerHTML = "";

  const state = deriveGameState(game);
  if (state.isComplete) addGameBadge(container, "Final", "gs-badge-done");
  else addGameBadge(container, "In Progress", "gs-badge-live");

  const otCount = game.rounds.filter((r) => r.isOvertime).length;
  if (otCount > 0) {
    addGameBadge(container, otCount === 1 ? "Overtime" : `${otCount}× Overtime`, "gs-badge-ot");
  }
  if (gsGameMode === "view") addGameBadge(container, "Read Only", "gs-badge-readonly");
}

/** Rewrites the scoreboard chips in place. Cheap enough to call on every
 *  score edit. It never touches the grid, so focus is unaffected. */
function renderScoreboard(game: GameInstance): void {
  const board = document.getElementById("gsScoreboard");
  if (!board) return;
  board.innerHTML = "";

  const state = deriveGameState(game);
  // Five Crowns is low-score-wins, so the leader is the current minimum,
  // once complete, defer to the derived winners (which handle accepted ties).
  const best = Math.min(...game.playerIds.map((id) => state.totals[id]));

  game.playerIds.forEach((id) => {
    const chip = document.createElement("div");
    chip.className = "gs-score-chip";
    const isLeading = state.isComplete ? state.winnerIds.includes(id) : state.totals[id] === best;
    if (isLeading) chip.classList.add("leader");

    const name = document.createElement("div");
    name.className = "gs-score-chip-name";
    name.textContent = playerName(id);
    name.title = playerName(id);
    chip.appendChild(name);

    const value = document.createElement("div");
    value.className = "gs-score-chip-value";
    value.textContent = String(state.totals[id]);
    chip.appendChild(value);

    board.appendChild(chip);
  });
}

/** Full header refresh, title, date field, badges, scoreboard, carousel. */
function renderGameHeader(): void {
  if (!newGameDraft) return;
  const game = newGameDraft;
  document.getElementById("gsPlayersSummary")!.textContent = gameLabel(game);
  (document.getElementById("gsGameDateEdit") as HTMLInputElement).value = game.date;
  renderGameBadges(game);
  renderScoreboard(game);
  renderGameCarousel();
}

/* -----------------------------------------------------------------------
   GAME DETAIL CAROUSEL: read-only view only (applyGsGameMode toggles its
   visibility). Steps to whichever game has the next/previous stable
   gameNumber (independent of however Historical's filter got you here, so
   the sequence stays predictable) and double-clicking the Game ID swaps in
   a number input to jump straight to any game.
------------------------------------------------------------------------ */

/* Both of these stay WITHIN the current game's table. Game numbers only mean
   anything relative to their own table (stepping from a T/V/S Game 176 into
   an unrelated A/B/C Game 177 would be nonsense) so the carousel walks that
   table's own sequence and the jump field resolves against it. */

function gameByNumberAtTable(current: GameInstance, num: number): GameInstance | undefined {
  const key = tableKeyOf(current);
  return games.find((g) => tableKeyOf(g) === key && g.gameNumber === num);
}

/** Nearest game at the same table in the given direction, skips over any
 *  numbers whose game was since deleted, since numbers are never reused. */
function adjacentGame(current: GameInstance, direction: 1 | -1): GameInstance | undefined {
  const key = tableKeyOf(current);
  return games
    .filter((g) => tableKeyOf(g) === key)
    .filter((g) => (direction === 1 ? g.gameNumber > current.gameNumber : g.gameNumber < current.gameNumber))
    .sort((a, b) => (direction === 1 ? a.gameNumber - b.gameNumber : b.gameNumber - a.gameNumber))[0];
}

/** Swaps the detail view to another already-saved game, staying read-only,
 *  shared by the carousel arrows and the Game ID jump-to-number edit. Always
 *  lands in "view" mode: there's nothing to lose by abandoning an in-progress
 *  edit, since edits aren't written back until Save Changes is clicked. */
function jumpToGame(game: GameInstance): void {
  openGameForView(game);
}

function renderGameCarousel(): void {
  if (!newGameDraft) return;
  document.getElementById("gsGameCarouselLabel")!.textContent = gameLabel(newGameDraft);
  // Which table's sequence you're walking, since the number alone no longer
  // says. Two tables can each have a Game 40.
  document.getElementById("gsGameCarouselTable")!.textContent = tableLabelForKey(tableKeyOf(newGameDraft));
  (document.getElementById("gsGameCarouselPrevBtn") as HTMLButtonElement).disabled = !adjacentGame(newGameDraft, -1);
  (document.getElementById("gsGameCarouselNextBtn") as HTMLButtonElement).disabled = !adjacentGame(newGameDraft, 1);
}

// True while the label is swapped for the jump-to-number input, so blur (from
// either Enter or Escape) knows whether to actually act on the typed value.
let gsGameIdEditCancelled = false;

function beginGameIdEdit(): void {
  if (!newGameDraft || gsGameMode !== "view") return;
  gsGameIdEditCancelled = false;
  const input = document.getElementById("gsGameCarouselInput") as HTMLInputElement;
  input.value = String(newGameDraft.gameNumber);
  document.getElementById("gsGameCarouselLabel")!.style.display = "none";
  input.style.display = "";
  input.focus();
  input.select();
}

function commitGameIdEdit(): void {
  const input = document.getElementById("gsGameCarouselInput") as HTMLInputElement;
  const raw = input.value.trim();
  input.style.display = "none";
  document.getElementById("gsGameCarouselLabel")!.style.display = "";
  if (gsGameIdEditCancelled || !raw || !newGameDraft) return;

  const num = Number(raw);
  if (!Number.isFinite(num)) { flash("Enter a valid game number", "error"); return; }
  if (num === newGameDraft.gameNumber) return;
  const target = gameByNumberAtTable(newGameDraft, num);
  if (!target) {
    flash(`No Game ${num} at ${tableLabelForKey(tableKeyOf(newGameDraft))}`, "error");
    return;
  }
  jumpToGame(target);
}

/** Returns to step 1 with a blank date/two empty player slots, discarding
 *  whatever round entry (if any) was in progress. */
function resetNewGameSetup(): void {
  (document.getElementById("gsGameDate") as HTMLInputElement).value = settings.requireDate ? gsToday() : "";
  refreshProfileDatalist();
  // Options first: clearPlayerPickers() blanks the select's value, which only
  // sticks if the option list it is being cleared against is already current.
  refreshFillFromTableOptions();
  clearPlayerPickers();
  setGameNumberUnlocked(false);
  document.getElementById("gsNewGameSetup")!.style.display = "";
  document.getElementById("gsNewGameEntry")!.style.display = "none";
  newGameDraft = null;
  editingGameId = null;
  newGameReturnView = "home";
  gsGameViewChain = [];
  gsGameMode = "create";
  gsPreEditSnapshot = null;
}

/* Chain of games visited without going back to the list, so the detail
   view's own Back button can retrace it. Opening a game from Historical
   starts a fresh chain; the carousel and the jump-to-number field extend it.
   Only ids are kept. The game is re-read from `games` on the way back, so a
   deletion mid-chain can't resurrect stale data. */
let gsGameViewChain: string[] = [];

/** Opens an already-saved game read-only (step 1 is skipped. This flow
 *  doesn't support changing an existing game's players). Views a deep copy
 *  so nothing is written back until Save Changes is explicitly clicked.
 *
 *  Note this deliberately does NOT reset Historical's filters: a game detail
 *  is a sub-view of whatever list you opened it from, so the selection is
 *  still there when you come back. */
function openGameForView(
  game: GameInstance,
  opts: { returnView?: GsView; recordHistory?: boolean } = {},
): void {
  newGameDraft = structuredClone(game);
  editingGameId = game.id;
  newGameReturnView = opts.returnView ?? newGameReturnView;
  gsGameMode = "view";
  gsPreEditSnapshot = null;
  // A fresh entry point (from a list) or a mouse-back/forward jump both start
  // the chain over, only walking games in-place (carousel, jump-to-number)
  // extends it, since that's the only case Back should retrace.
  if (opts.returnView || opts.recordHistory === false) gsGameViewChain = [];
  gsGameViewChain.push(game.id);

  document.getElementById("gsNewGameSetup")!.style.display = "none";
  document.getElementById("gsNewGameEntry")!.style.display = "";
  // Show the view (making the whole subtree visible) before rendering the
  // grid/chart, drawLineChart() reads canvas.clientWidth, which is 0 for
  // anything still inside a display:none ancestor.
  if (opts.recordHistory === false) {
    currentGsView = "new-game";
    for (const [key, id] of Object.entries(GS_VIEW_IDS)) {
      document.getElementById(id)!.style.display = key === "new-game" ? "" : "none";
    }
  } else {
    showGsView("new-game");
  }
  applyGsGameMode();
}

/** The detail view's Back button: retrace the chain of games one step if you
 *  arrived here from another game, otherwise return to the list. */
function gameDetailBack(): void {
  gsGameViewChain.pop();
  const previousId = gsGameViewChain[gsGameViewChain.length - 1];
  const previous = previousId ? games.find((g) => g.id === previousId) : undefined;
  if (previous) {
    gsGameViewChain.pop(); // openGameForView re-pushes it
    openGameForView(previous);
    return;
  }
  const returnView = newGameReturnView;
  gsGameViewChain = [];
  newGameDraft = null;
  editingGameId = null;
  showGsView(returnView);
  // The selections were preserved, but the numbers behind them may not have
  // been. The game just left could have been edited or deleted from its
  // detail view. Recomputing is cheap next to showing a stale record.
  if (returnView === "stats") refreshStatsView();
}

function enterEditMode(): void {
  if (!newGameDraft) return;
  gsPreEditSnapshot = structuredClone(newGameDraft);
  gsGameMode = "edit";
  applyGsGameMode();
}

function saveGameChanges(): void {
  if (!newGameDraft || !editingGameId) return;
  newGameDraft.updatedAt = new Date().toISOString();
  const idx = games.findIndex((g) => g.id === editingGameId);
  if (idx >= 0) games[idx] = newGameDraft;
  saveToDisk();
  flash("Changes saved", "success");
  gsGameMode = "view";
  gsPreEditSnapshot = null;
  applyGsGameMode();
}

function discardGameChanges(): void {
  if (gsPreEditSnapshot) newGameDraft = structuredClone(gsPreEditSnapshot);
  gsPreEditSnapshot = null;
  gsGameMode = "view";
  applyGsGameMode();
}

/** Seats a known table's players in the order that table already uses,
 *  whatever order the names were typed in. Table identity ignores order (S/T/V
 *  and T/V/S are the same table), so this doesn't change which table the game
 *  joins. It just stops the round grid's columns, and every stat table built
 *  from them, from shuffling between games at the same table.
 *
 *  A roster that isn't a known table keeps the typed order, which then becomes
 *  that table's order the moment it's registered. */
function canonicalSeatOrder(gameType: GameType, ids: string[]): string[] {
  const table = tables.find((t) => t.key === tableKey(gameType, ids));
  if (!table) return ids;
  const seated = table.playerIds.filter((id) => ids.includes(id));
  // Defensive: if the stored roster somehow disagrees about membership, keep
  // the typed order rather than silently dropping a player from the game.
  return seated.length === ids.length ? seated : ids;
}

function startNewGame(): void {
  const container = document.getElementById("gsPlayerPickers")!;
  const inputs = Array.from(container.querySelectorAll("input")) as HTMLInputElement[];
  const typedIds: string[] = [];
  for (const input of inputs) {
    const id = resolvePlayerName(input.value);
    if (!id) { flash("Every player slot needs a name", "error"); return; }
    if (typedIds.includes(id)) { flash("The same player can't be picked twice", "error"); return; }
    typedIds.push(id);
  }
  if (typedIds.length < GS_MIN_PLAYERS) { flash("A game needs at least 2 players", "error"); return; }
  const ids = canonicalSeatOrder(gsNewGameType, typedIds);

  // Auto value unless the lock was explicitly opened. A hand-typed number is
  // still rejected if it would collide, a table can't have two Game 42s,
  // since the number is how a game is referred to everywhere else.
  const numberInput = document.getElementById("gsGameNumberInput") as HTMLInputElement;
  let gameNumber = nextGameNumber(gsNewGameType, ids);
  if (gsGameNumberUnlocked) {
    const typed = Number(numberInput.value.trim());
    if (!Number.isInteger(typed) || typed < 1) {
      flash("Game number must be a whole number of 1 or more", "error");
      return;
    }
    const key = tableKey(gsNewGameType, ids);
    if (games.some((g) => tableKeyOf(g) === key && g.gameNumber === typed)) {
      flash(`This table already has a Game ${typed}`, "error");
      return;
    }
    gameNumber = typed;
  }

  const dateInput = (document.getElementById("gsGameDate") as HTMLInputElement).value;
  const date = dateInput || (settings.requireDate ? gsToday() : "");
  const now = new Date().toISOString();

  newGameDraft = {
    id: makeId(),
    gameType: gsNewGameType,
    gameNumber,
    date,
    playerIds: ids,
    rounds: buildFixedRounds(ids),
    createdAt: now,
    updatedAt: now,
  };
  gsGameMode = "create";

  document.getElementById("gsNewGameSetup")!.style.display = "none";
  document.getElementById("gsNewGameEntry")!.style.display = "";
  applyGsGameMode();
}

/* =============================================================================
   NEW GAME: step 2: round entry grid
============================================================================= */

function buildTotalsRow(game: GameInstance): HTMLTableRowElement {
  const state = deriveGameState(game);
  const totalsRow = document.createElement("tr");
  totalsRow.className = "gs-totals-row";
  const totalsLabelTd = document.createElement("td");
  totalsLabelTd.textContent = state.isComplete ? "Final" : "Total";
  totalsRow.appendChild(totalsLabelTd);
  game.playerIds.forEach((id) => {
    const td = document.createElement("td");
    td.colSpan = 2;
    td.className = "gs-col-start";
    td.textContent = String(state.totals[id]);
    if (state.isComplete && state.winnerIds.includes(id)) td.classList.add("gs-winner-cell");
    totalsRow.appendChild(td);
  });
  return totalsRow;
}

/** Rewrites just the totals footer in place, leaving the round rows (and
 *  whatever cell currently has focus) untouched. Safe to call after any
 *  score edit that didn't change the number of rounds. */
function updateTotalsFooter(): void {
  if (!newGameDraft) return;
  const tfoot = document.querySelector("#gsRoundGridWrap tfoot");
  if (!tfoot) return;
  tfoot.innerHTML = "";
  tfoot.appendChild(buildTotalsRow(newGameDraft));
}

/** One running-total snapshot per round, carrying a player's total forward
 *  unchanged on rounds they don't participate in (overtime rounds they're
 *  not tied into), mirrors the paired score/total columns from the user's
 *  original spreadsheet. */
/** Rewrites just the per-round running-total cells in place, never touches
 *  the score <input>s, so focus is never disturbed. Safe to call after any
 *  score edit that didn't change the number of rounds. */
function updateRunningTotalsDisplay(): void {
  if (!newGameDraft) return;
  const snapshots = computeRunningTotalsPerRound(newGameDraft);
  newGameDraft.rounds.forEach((round, i) => {
    const snap = snapshots[i];
    newGameDraft!.playerIds.forEach((id) => {
      const cell = document.querySelector<HTMLElement>(
        `[data-total-round="${round.roundIndex}"][data-total-player="${id}"]`,
      );
      if (cell) cell.textContent = String(snap[id]);
    });
  });
}

function renderRoundGrid(): void {
  const wrap = document.getElementById("gsRoundGridWrap")!;
  wrap.innerHTML = "";
  if (!newGameDraft) return;
  const game = newGameDraft;

  const table = document.createElement("table");
  table.className = "gs-round-grid";

  const thead = document.createElement("thead");
  const nameRow = document.createElement("tr");
  const corner = document.createElement("th");
  corner.rowSpan = 2;
  nameRow.appendChild(corner);
  game.playerIds.forEach((id) => {
    const th = document.createElement("th");
    th.colSpan = 2;
    th.className = "gs-col-start";
    th.textContent = playerName(id);
    nameRow.appendChild(th);
  });
  thead.appendChild(nameRow);

  const subRow = document.createElement("tr");
  game.playerIds.forEach(() => {
    const scoreTh = document.createElement("th");
    scoreTh.className = "gs-subheader gs-col-start";
    scoreTh.textContent = "Score";
    subRow.appendChild(scoreTh);
    const totalTh = document.createElement("th");
    totalTh.className = "gs-subheader";
    totalTh.textContent = "Total";
    subRow.appendChild(totalTh);
  });
  thead.appendChild(subRow);
  table.appendChild(thead);

  const snapshots = computeRunningTotalsPerRound(game);

  const tbody = document.createElement("tbody");
  game.rounds.forEach((round, i) => {
    const tr = document.createElement("tr");
    if (round.isOvertime) tr.className = "gs-round-ot-row";
    const labelTd = document.createElement("td");
    labelTd.className = "gs-round-label-cell";
    labelTd.textContent = roundLabel(round);
    tr.appendChild(labelTd);

    const snap = snapshots[i];
    game.playerIds.forEach((id) => {
      const scoreTd = document.createElement("td");
      scoreTd.className = "gs-col-start";
      if (round.participantIds.includes(id)) {
        const input = document.createElement("input");
        input.type = "number";
        input.min = "0";
        input.step = "1";
        input.inputMode = "numeric";
        input.disabled = gsGameReadOnly;
        input.dataset.round = String(round.roundIndex);
        input.dataset.player = id;
        const score = round.scores[id];
        input.value = score == null ? "" : String(score);
        scoreTd.appendChild(input);
      } else {
        scoreTd.classList.add("gs-round-cell-na");
        scoreTd.textContent = "—";
      }
      tr.appendChild(scoreTd);

      const totalTd = document.createElement("td");
      totalTd.className = "gs-round-total-cell";
      totalTd.dataset.totalRound = String(round.roundIndex);
      totalTd.dataset.totalPlayer = id;
      totalTd.textContent = String(snap[id]);
      tr.appendChild(totalTd);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  const tfoot = document.createElement("tfoot");
  tfoot.appendChild(buildTotalsRow(game));
  table.appendChild(tfoot);

  wrap.appendChild(table);
  renderGameBadges(game);
  renderScoreboard(game);
  drawProgressChart();
}

/** Live line chart of each player's running total, round by round, as the
 *  grid is filled in. Same drawLineChart() used for the table Win Chart. */
function progressChartSeries(game: GameInstance): { series: GsChartSeries[]; xLabels: string[] } {
  const snapshots = computeRunningTotalsPerRound(game);
  return {
    series: game.playerIds.map((id) => ({ name: playerName(id), values: snapshots.map((s) => s[id]) })),
    xLabels: game.rounds.map(roundLabel),
  };
}

function drawProgressChart(): void {
  if (!newGameDraft) return;
  const canvas = document.getElementById("gsProgressChartCanvas") as HTMLCanvasElement | null;
  if (!canvas) return;
  const { series, xLabels } = progressChartSeries(newGameDraft);
  drawLineChart(canvas, series, xLabels);
}

function openProgressChartExpand(): void {
  if (!newGameDraft) return;
  const { series, xLabels } = progressChartSeries(newGameDraft);
  // Series follow game.playerIds, so a winner's series index is just their
  // seat. Empty for an unfinished game, which is what leaves the star off.
  const { winnerIds } = deriveGameState(newGameDraft);
  const winners = newGameDraft.playerIds
    .map((id, i) => (winnerIds.includes(id) ? i : -1))
    .filter((i) => i >= 0);
  openChartExpand({ title: `${gameLabel(newGameDraft)}: Progress`, series, xLabels, winners });
}

/** Reads one cell's typed value into the draft's round data and rebuilds the
 *  overtime tail. Rejects negative/non-numeric input by reverting the field.
 *  Any edit invalidates a previously-accepted tie (see the overtime confirm
 *  modal below) since the totals it applied to may no longer be the same. */
function commitRoundScore(input: HTMLInputElement): void {
  if (!newGameDraft) return;
  const roundIndex = Number(input.dataset.round);
  const playerId = input.dataset.player!;
  const round = newGameDraft.rounds.find((r) => r.roundIndex === roundIndex);
  if (!round) return;

  const raw = input.value.trim();
  if (raw === "") {
    round.scores[playerId] = null;
  } else {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      flash("Scores must be zero or a positive number", "error");
      input.value = round.scores[playerId] == null ? "" : String(round.scores[playerId]);
      return;
    }
    round.scores[playerId] = Math.round(n);
  }
  newGameDraft.tieAccepted = false;
  const pending = reconcileOvertimeRounds(newGameDraft, settings.autoOvertime);
  if (pending) openOvertimeConfirmModal(pending);
}

/** True for the last player-cell of the grid's current last round. The one
 *  spot where Tab/Enter needs to be intercepted, since the next round (if
 *  any) may not exist in the DOM yet until overtime is reconciled. Every
 *  other cell uses native Tab order / normal column navigation. */
function isBoundaryCell(input: HTMLInputElement): boolean {
  if (!newGameDraft) return false;
  const lastRound = newGameDraft.rounds[newGameDraft.rounds.length - 1];
  if (Number(input.dataset.round) !== lastRound.roundIndex) return false;
  const ids = lastRound.participantIds;
  return input.dataset.player === ids[ids.length - 1];
}

function focusCell(wrap: HTMLElement, roundIndex: number, playerId: string): void {
  wrap
    .querySelector<HTMLInputElement>(`input[data-round="${roundIndex}"][data-player="${playerId}"]`)
    ?.focus();
}

/** All rounds a given player actually participates in, in order, a
 *  "column" for Enter/Shift+Enter navigation. Always starts at round 3
 *  (every player plays every fixed round); only its bottom varies, since a
 *  player drops out once they're no longer tied in an overtime round. */
function columnRoundsFor(game: GameInstance, playerId: string): RoundEntry[] {
  return game.rounds.filter((r) => r.participantIds.includes(playerId));
}

/** Enter moves down a player's column to their next round; Shift+Enter moves
 *  up. At the bottom of a column, Enter continues at the top of the next
 *  player's column (round 3), except at the grid's true last cell, where
 *  it defers to the same commit/reconcile/append-or-save logic as Tab. At
 *  the top of a column, Shift+Enter continues at the bottom of the previous
 *  player's column. Off either end of the whole grid, it's a no-op. */
function handleColumnEnter(input: HTMLInputElement, goingDown: boolean): void {
  if (!newGameDraft) return;
  const wrap = document.getElementById("gsRoundGridWrap")!;
  const game = newGameDraft;
  const playerId = input.dataset.player!;
  const roundIndex = Number(input.dataset.round);
  const col = columnRoundsFor(game, playerId);
  const idx = col.findIndex((r) => r.roundIndex === roundIndex);
  const playerIdx = game.playerIds.indexOf(playerId);

  if (goingDown) {
    if (idx < col.length - 1) {
      focusCell(wrap, col[idx + 1].roundIndex, playerId);
      return;
    }
    if (isBoundaryCell(input)) {
      const roundsBefore = game.rounds.length;
      commitRoundScore(input);
      if (!newGameDraft) return;
      renderRoundGrid();
      const roundsAfter = newGameDraft.rounds.length;
      if (roundsAfter > roundsBefore) {
        const newLast = newGameDraft.rounds[newGameDraft.rounds.length - 1];
        focusCell(wrap, newLast.roundIndex, newLast.participantIds[0]);
      } else {
        document.getElementById("gsSaveGameBtn")?.focus();
      }
      return;
    }
    if (playerIdx < game.playerIds.length - 1) {
      focusCell(wrap, FIRST_ROUND, game.playerIds[playerIdx + 1]);
    }
  } else {
    if (idx > 0) {
      focusCell(wrap, col[idx - 1].roundIndex, playerId);
      return;
    }
    if (playerIdx > 0) {
      const prevPlayer = game.playerIds[playerIdx - 1];
      const prevCol = columnRoundsFor(game, prevPlayer);
      focusCell(wrap, prevCol[prevCol.length - 1].roundIndex, prevPlayer);
    }
  }
}

function wireRoundGridEvents(): void {
  const wrap = document.getElementById("gsRoundGridWrap")!;

  wrap.addEventListener("change", (e) => {
    const input = e.target as HTMLInputElement;
    if (!newGameDraft || input.tagName !== "INPUT") return;
    const roundsBefore = newGameDraft.rounds.length;
    commitRoundScore(input);
    if (!newGameDraft) return;
    // Only rebuild the whole table when the overtime tail actually changed
    // shape (a round appeared/disappeared), otherwise just refresh the
    // totals footer and running-total cells in place so focus isn't yanked
    // away from wherever the browser's own Tab handling already sent it.
    if (newGameDraft.rounds.length !== roundsBefore) {
      renderRoundGrid();
    } else {
      updateTotalsFooter();
      updateRunningTotalsDisplay();
      renderGameBadges(newGameDraft);
      renderScoreboard(newGameDraft);
      drawProgressChart();
    }
  });

  wrap.addEventListener("keydown", (e) => {
    const input = e.target as HTMLInputElement;
    if (!newGameDraft || input.tagName !== "INPUT") return;

    if (e.key === "Enter") {
      e.preventDefault();
      handleColumnEnter(input, !e.shiftKey);
      return;
    }

    if (e.key !== "Tab" || e.shiftKey) return;
    if (!isBoundaryCell(input)) return;
    e.preventDefault();
    const roundCountBefore = newGameDraft.rounds.length;
    commitRoundScore(input);
    renderRoundGrid();
    const roundCountAfter = newGameDraft.rounds.length;
    if (roundCountAfter > roundCountBefore) {
      const newLastRound = newGameDraft.rounds[newGameDraft.rounds.length - 1];
      const firstId = newLastRound.participantIds[0];
      focusCell(wrap, newLastRound.roundIndex, firstId);
    } else {
      document.getElementById("gsSaveGameBtn")?.focus();
    }
  });
}

/* =============================================================================
   MODAL: OVERTIME CONFIRM
   Only reached when settings.autoOvertime is off, reconcileOvertimeRounds()
   reports the round it would add without committing it, so a decline here
   just leaves the game as-is (tieAccepted marks the tie as the final
   result instead of leaving the game stuck "in progress").
============================================================================= */

let gsOvertimeConfirmModal: Modal | null = null;
let pendingOvertimeRound: RoundEntry | null = null;

function getOvertimeConfirmModal(): Modal {
  if (!gsOvertimeConfirmModal) {
    gsOvertimeConfirmModal = new Modal(document.getElementById("gsOvertimeConfirmBackdrop")!, {
      closeOnEsc: true,
      onClosed: () => { pendingOvertimeRound = null; },
    });

    document.getElementById("gsOvertimeConfirmAddBtn")!.addEventListener("click", () => {
      if (!pendingOvertimeRound || !newGameDraft) return;
      newGameDraft.rounds.push(pendingOvertimeRound);
      pendingOvertimeRound = null;
      gsOvertimeConfirmModal!.close();
      renderRoundGrid();
    });

    document.getElementById("gsOvertimeConfirmDeclineBtn")!.addEventListener("click", () => {
      if (newGameDraft) newGameDraft.tieAccepted = true;
      pendingOvertimeRound = null;
      gsOvertimeConfirmModal!.close();
      renderRoundGrid();
    });
  }
  return gsOvertimeConfirmModal;
}

function openOvertimeConfirmModal(pending: RoundEntry): void {
  if (!newGameDraft) return;
  pendingOvertimeRound = pending;
  const tiedTotal = deriveGameState(newGameDraft).totals[pending.participantIds[0]];
  const names = pending.participantIds.map(playerName).join(", ");
  document.getElementById("gsOvertimeConfirmMessage")!.textContent =
    `${names} are tied at ${tiedTotal} points. Add an overtime round (${roundLabel(pending)}) to break the tie?`;
  getOvertimeConfirmModal().open();
}

function saveNewGame(): void {
  if (!newGameDraft) return;
  newGameDraft.updatedAt = new Date().toISOString();

  if (editingGameId) {
    const idx = games.findIndex((g) => g.id === editingGameId);
    if (idx >= 0) games[idx] = newGameDraft; else games.push(newGameDraft);
  } else {
    games.push(newGameDraft);
  }
  // A brand-new roster becomes a nameable table the moment its first game is
  // saved, same as a typed name becomes a profile.
  ensureTableFor(newGameDraft);
  saveToDisk();
  flash("Game saved", "success");

  const returnView = newGameReturnView;
  newGameDraft = null;
  editingGameId = null;
  gsGameViewChain = [];
  if (returnView === "historical") renderHistoricalList();
  showGsView(returnView);
}

function cancelNewGame(): void {
  const returnView = newGameReturnView;
  newGameDraft = null;
  editingGameId = null;
  gsGameViewChain = [];
  showGsView(returnView);
}

/* =============================================================================
   HISTORICAL GAMES
============================================================================= */

type GsHistFilterMode = "player" | "table";
let gsHistFilterMode: GsHistFilterMode = "player";
// Nothing renders until a player, table, or "All" is explicitly picked,
// avoids loading/rendering the whole game log just to land on the view.
// Reset to false every time the Historical view is freshly opened.
let gsHistoricalHasSelection = false;

type GsHistLayout = "list" | "cards";
let gsHistLayout: GsHistLayout = "list";

/** Flips the list/card layout. The toggle is a single button whose glyph is
 *  the layout you'd switch TO (CSS picks the icon off `.is-cards`), so the
 *  label and tooltip both describe the action rather than the current state. */
function activateGsHistLayout(layout: GsHistLayout): void {
  gsHistLayout = layout;
  const btn = document.getElementById("gsHistLayoutBtn");
  if (btn) {
    btn.classList.toggle("is-cards", layout === "cards");
    const next = layout === "list" ? "card" : "list";
    btn.title = `Switch to ${next} view`;
    btn.setAttribute("aria-label", btn.title);
  }
  renderHistoricalList();
}

/** One game card, shared by the Historical list and Home's Recent strip.
 *  The whole card is a single-click target. No hidden double-click, and no
 *  separate "Open" button competing with it. It's given button semantics so
 *  the keyboard reaches it the same way the pointer does. */
function buildGameRow(game: GameInstance): HTMLElement {
  const state = deriveGameState(game);

  const row = document.createElement("div");
  row.className = "gs-game-row";
  if (!state.isComplete) row.classList.add("gs-game-row-live");
  row.tabIndex = 0;
  row.setAttribute("role", "button");
  // returnView starts a fresh game chain: this is the entry point into the
  // detail view, so Back from here belongs to the list, not to whatever game
  // happened to be open before.
  const open = () => openGameForView(game, { returnView: "historical" });
  row.addEventListener("click", open);
  row.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    open();
  });

  const header = document.createElement("div");
  header.className = "gs-game-row-header";

  const titleWrap = document.createElement("div");
  titleWrap.className = "gs-game-row-titles";

  const titleSpan = document.createElement("span");
  titleSpan.className = "gs-game-row-title";
  titleSpan.textContent = gameLabel(game);
  titleWrap.appendChild(titleSpan);

  const dateSpan = document.createElement("span");
  dateSpan.className = "gs-game-row-date";
  dateSpan.textContent = game.date ? formatGameDate(game.date) : "No date";
  titleWrap.appendChild(dateSpan);

  // Completed games are already signalled by the green rail and the
  // highlighted winner chip, so only the exceptions get a badge here.
  if (!state.isComplete) addGameBadge(titleWrap, "In Progress", "gs-badge-live");
  const otCount = game.rounds.filter((r) => r.isOvertime).length;
  if (otCount > 0) {
    addGameBadge(titleWrap, otCount === 1 ? "OT" : `${otCount}× OT`, "gs-badge-ot");
  }
  header.appendChild(titleWrap);
  row.appendChild(header);

  const playersLine = document.createElement("div");
  playersLine.className = "gs-game-row-players";
  game.playerIds.forEach((id) => {
    const chip = document.createElement("span");
    chip.className = "gs-game-row-player";
    if (state.isComplete && state.winnerIds.includes(id)) {
      chip.classList.add("gs-game-row-winner");
    }
    const nameEl = document.createElement("span");
    nameEl.textContent = playerName(id);
    chip.appendChild(nameEl);
    const scoreEl = document.createElement("span");
    scoreEl.className = "gs-game-row-player-score";
    scoreEl.textContent = String(state.totals[id]);
    chip.appendChild(scoreEl);
    playersLine.appendChild(chip);
  });
  row.appendChild(playersLine);

  return row;
}

/** Sets the "N games" line in the Historical toolbar (blank until something
 *  has actually been selected, matching the list's own placeholder state). */
function setHistoricalCount(text: string): void {
  const el = document.getElementById("gsHistoricalCount");
  if (el) el.textContent = text;
}

/** A labelled run of games from one table. Filtering by player can pull in
 *  several tables at once, and since each numbers its games independently,
 *  one flat list would silently interleave two unrelated "Game 40"s and bury
 *  a short table's games below a long one's. Sections keep each table's run
 *  visible and self-explanatory. */
function buildHistoricalSection(key: string, sectionGames: GameInstance[]): HTMLElement {
  const section = document.createElement("div");
  section.className = "gs-hist-section";

  const header = document.createElement("div");
  header.className = "gs-hist-section-header";
  const title = document.createElement("span");
  title.className = "gs-hist-section-title";
  title.textContent = tableLabelForKey(key);
  header.appendChild(title);
  const count = document.createElement("span");
  count.className = "gs-hist-section-count";
  count.textContent = `${sectionGames.length} ${sectionGames.length === 1 ? "game" : "games"}`;
  header.appendChild(count);
  section.appendChild(header);

  const list = document.createElement("div");
  list.className = "gs-historical-list";
  list.classList.toggle("cards", gsHistLayout === "cards");
  sectionGames.forEach((game) => list.appendChild(buildGameRow(game)));
  section.appendChild(list);
  return section;
}

function renderHistoricalList(): void {
  const container = document.getElementById("gsHistoricalList")!;
  container.innerHTML = "";
  // Sections carry their own inner list, so the outer container only gets the
  // grid class in the flat (single-table) case.
  container.classList.remove("cards");

  if (!gsHistoricalHasSelection) {
    setHistoricalCount("");
    const empty = document.createElement("div");
    empty.className = "gs-empty";
    empty.textContent = "Pick a player or table above, or hit Show All, to see games.";
    container.appendChild(empty);
    return;
  }

  // Game type is the outer axis, tables only exist within one game.
  let filtered = games.filter((g) => g.gameType === gsHistGameType);
  if (gsHistFilterMode === "player") {
    const filterId = (document.getElementById("gsHistoricalFilter") as HTMLSelectElement).value;
    if (filterId) filtered = filtered.filter((g) => g.playerIds.includes(filterId));
  } else {
    const filterKey = (document.getElementById("gsHistoricalTableFilter") as HTMLSelectElement).value;
    if (filterKey) filtered = filtered.filter((g) => tableKeyOf(g) === filterKey);
  }

  filtered = gamesNewestFirst(filtered);
  setHistoricalCount(`${filtered.length} ${filtered.length === 1 ? "game" : "games"}`);

  if (filtered.length === 0) {
    const empty = document.createElement("div");
    empty.className = "gs-empty";
    empty.textContent = games.length === 0 ? "No games logged yet." : "No games match this filter.";
    container.appendChild(empty);
    return;
  }

  const byTable = new Map<string, GameInstance[]>();
  filtered.forEach((game) => {
    const key = tableKeyOf(game);
    const bucket = byTable.get(key);
    if (bucket) bucket.push(game); else byTable.set(key, [game]);
  });

  if (byTable.size <= 1) {
    container.classList.toggle("cards", gsHistLayout === "cards");
    filtered.forEach((game) => container.appendChild(buildGameRow(game)));
    return;
  }

  // Biggest run first, so the table you play most is what you land on.
  [...byTable.entries()]
    .sort((a, b) => b[1].length - a[1].length || tableLabelForKey(a[0]).localeCompare(tableLabelForKey(b[0])))
    .forEach(([key, sectionGames]) => container.appendChild(buildHistoricalSection(key, sectionGames)));
}

function activateGsHistFilterMode(mode: GsHistFilterMode): void {
  gsHistFilterMode = mode;
  document
    .querySelectorAll<HTMLButtonElement>("#gsViewHistorical [data-gs-hist-filter-mode]")
    .forEach((btn) => btn.classList.toggle("active", btn.dataset.gsHistFilterMode === mode));
  document.getElementById("gsHistoricalFilter")!.style.display = mode === "player" ? "" : "none";
  document.getElementById("gsHistoricalTableFilter")!.style.display = mode === "table" ? "" : "none";
  renderHistoricalList();
}

/** Called only when Historical is genuinely being left (see leaveGsView) so
 *  coming back starts from a clean "pick a player or table" state. Opening a
 *  game and returning does NOT go through here. */
function resetHistoricalFilters(): void {
  gsHistoricalHasSelection = false;
  (document.getElementById("gsHistoricalFilter") as HTMLSelectElement).value = "";
  (document.getElementById("gsHistoricalTableFilter") as HTMLSelectElement).value = "";
  renderHistoricalList();
}

function refreshHistoricalFilterOptions(): void {
  const select = document.getElementById("gsHistoricalFilter") as HTMLSelectElement;
  const current = select.value;
  select.innerHTML = "";
  const allOpt = document.createElement("option");
  allOpt.value = "";
  allOpt.textContent = "All players";
  select.appendChild(allOpt);
  // Only players who've actually played this game, a profile with no games
  // here would filter to an empty list every time.
  const playedIds = new Set(
    games.filter((g) => g.gameType === gsHistGameType).flatMap((g) => g.playerIds),
  );
  [...profiles]
    .filter((p) => playedIds.has(p.id))
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((p) => {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name;
      select.appendChild(opt);
    });
  select.value = [...select.options].some((o) => o.value === current) ? current : "";

  const tableSelect = document.getElementById("gsHistoricalTableFilter") as HTMLSelectElement;
  const currentTable = tableSelect.value;
  tableSelect.innerHTML = "";
  const allTablesOpt = document.createElement("option");
  allTablesOpt.value = "";
  allTablesOpt.textContent = "All tables";
  tableSelect.appendChild(allTablesOpt);
  listAllTables(gsHistGameType).forEach((t) => {
    const opt = document.createElement("option");
    opt.value = t.key;
    opt.textContent = t.label;
    tableSelect.appendChild(opt);
  });
  tableSelect.value = [...tableSelect.options].some((o) => o.value === currentTable) ? currentTable : "";
}

/** Populates any game-type <select>. One option per supported game. */
function fillGameTypeSelect(select: HTMLSelectElement, current: GameType): void {
  select.innerHTML = "";
  GAME_TYPES.forEach((t) => {
    const opt = document.createElement("option");
    opt.value = t.value;
    opt.textContent = t.label;
    select.appendChild(opt);
  });
  select.value = current;
}

/* =============================================================================
   MODAL: DELETE GAME CONFIRM
============================================================================= */

let gsGameDeleteModal: Modal | null = null;
let pendingGameDelete: string | null = null;

function getGameDeleteModal(): Modal {
  if (!gsGameDeleteModal) {
    gsGameDeleteModal = new Modal(document.getElementById("gsGameDeleteBackdrop")!, {
      closeOnEsc: true,
      onClosed: () => { pendingGameDelete = null; },
    });

    document.getElementById("gsGameDeleteConfirmBtn")!.addEventListener("click", () => {
      if (!pendingGameDelete) return;
      games = games.filter((g) => g.id !== pendingGameDelete);
      const wasViewingDeleted = pendingGameDelete === editingGameId;
      gsGameViewChain = gsGameViewChain.filter((id) => id !== pendingGameDelete);
      pendingGameDelete = null;
      // Deleting a table's last game retires the table record with it.
      backfillTables();
      saveToDisk();
      gsGameDeleteModal!.close();
      flash("Game deleted", "success");
      if (wasViewingDeleted) {
        newGameDraft = null;
        editingGameId = null;
        gsGameMode = "create";
        showGsView("historical");
      }
      renderHistoricalList();
    });

    document.getElementById("gsGameDeleteCancelBtn")!.addEventListener("click", () => {
      pendingGameDelete = null;
      gsGameDeleteModal!.close();
    });
  }
  return gsGameDeleteModal;
}

function openGameDelete(id: string, title: string): void {
  pendingGameDelete = id;
  document.getElementById("gsGameDeleteMessage")!.textContent =
    `Permanently delete "${title}"? This can't be undone.`;
  getGameDeleteModal().open();
}

/* =============================================================================
   STATS & COMPARE
============================================================================= */

type GsStatsMode = "profile" | "table";
let gsStatsMode: GsStatsMode = "profile";
const GS_MAX_COMPARE = 4;

/** "Game 5" for one entry; "Game 5 (+2 more)" for several tied for the same
 *  record. N is the first game where the record occurred, X is the count
 *  of additional games that tie it. */
function formatGameRefs(refs: GameReference[]): string {
  if (refs.length === 0) return "—";
  if (refs.length === 1) return refs[0].gameTitle;
  return `${refs[0].gameTitle} (+${refs.length - 1} more)`;
}

/* The three helpers below return the VALUE half of a table-stats record only.
   The label is rendered as its own column by the .gs-record-row grid, so
   baking "Label: " into the string would double it up. */

function recordListText(entries: (GameReference & { value: number })[]): string {
  if (entries.length === 0) return "—";
  return `${entries[0].value}: ${formatGameRefs(entries)}`;
}

function marginGameText(entries: MarginGame[]): string {
  if (entries.length === 0) return "—";
  const e = entries[0];
  return `${playerName(e.firstPlaceId)} ${e.firstScore} vs ${playerName(e.secondPlaceId)} ${e.secondScore} (margin ${e.margin}): ${formatGameRefs(entries)}`;
}

function overtimeGamesText(refs: OvertimeGameRef[]): string {
  if (refs.length === 0) return "none";
  const parts = refs.map((r) => `${r.gameNumber} (${r.otCount === 1 ? "OT" : `${r.otCount}OT`})`);
  return parts.join(", ");
}

/** Looks up a game's stable gameNumber for streak-range display, falls
 *  back gracefully if the game was since deleted (the streak itself is
 *  still valid history, it just can't cite an exact game anymore). */
function gameNumberFor(gameId: string): number | null {
  return games.find((g) => g.id === gameId)?.gameNumber ?? null;
}

function streakCell(streak: Streak | null): StatDetailRow {
  if (!streak) return { value: "0", gameRef: "—" };
  const fromNum = gameNumberFor(streak.fromGameId);
  const toNum = gameNumberFor(streak.toGameId);
  const gameRef = fromNum == null || toNum == null ? "—" : fromNum === toNum ? `Game ${fromNum}` : `Games ${fromNum}-${toNum}`;
  // Opens at the streak's first game. The natural place to start reading it.
  return { value: String(streak.length), gameRef, gameId: streak.fromGameId };
}

/* -----------------------------------------------------------------------
   Double-click detail, a ranked breakdown behind any stat cell that has
   more than one number behind it (career records, milestone games).
------------------------------------------------------------------------ */

// gameId lets a detail row double-click straight through to that game's
// detail view. The row already names the game, so it should be reachable.
type StatDetailRow = { value: string; gameRef: string; gameId?: string };
type StatDetail = { title: string; rows: StatDetailRow[] };

function completedGamesFor(playerId: string, scopedGames: GameInstance[]): GameInstance[] {
  return scopedGames.filter((g) => g.playerIds.includes(playerId) && deriveGameState(g).isComplete);
}

function topGameScoresDetail(playerId: string, scopedGames: GameInstance[], dir: "desc" | "asc"): StatDetail {
  const scored = completedGamesFor(playerId, scopedGames)
    .map((g) => ({ game: g, value: deriveGameState(g).totals[playerId] }))
    .sort((a, b) => (dir === "desc" ? b.value - a.value : a.value - b.value));
  return {
    title: `${playerName(playerId)}: ${dir === "desc" ? "Highest" : "Lowest"} Game Scores`,
    rows: scored.map((s) => ({ value: String(s.value), gameRef: gameLabel(s.game), gameId: s.game.id })),
  };
}

function topRoundScoresDetail(playerId: string, scopedGames: GameInstance[]): StatDetail {
  const sortable: { value: number; gameRef: string; gameId: string }[] = [];
  completedGamesFor(playerId, scopedGames).forEach((g) => {
    g.rounds.forEach((r) => {
      if (!r.participantIds.includes(playerId)) return;
      const score = r.scores[playerId];
      if (score == null) return;
      sortable.push({ value: score, gameRef: `${gameLabel(g)}, Round ${roundLabel(r)}`, gameId: g.id });
    });
  });
  sortable.sort((a, b) => b.value - a.value);
  const rows: StatDetailRow[] = sortable.map((r) => ({
    value: String(r.value),
    gameRef: r.gameRef,
    gameId: r.gameId,
  }));
  return { title: `${playerName(playerId)}: Highest Round Scores`, rows };
}

function topOutsDetail(playerId: string, scopedGames: GameInstance[], dir: "desc" | "asc"): StatDetail {
  const scored = completedGamesFor(playerId, scopedGames)
    .map((g) => ({ game: g, value: outsInGame(g, playerId) }))
    .sort((a, b) => (dir === "desc" ? b.value - a.value : a.value - b.value));
  return {
    title: `${playerName(playerId)}: ${dir === "desc" ? "Most" : "Fewest"} Outs by Game`,
    rows: scored.map((s) => ({ value: String(s.value), gameRef: gameLabel(s.game), gameId: s.game.id })),
  };
}

function mostOutsInARowDetail(playerId: string, scopedGames: GameInstance[]): StatDetail {
  const scored = completedGamesFor(playerId, scopedGames)
    .map((g) => ({ game: g, value: mostOutsInARowInGame(g, playerId) }))
    .sort((a, b) => b.value - a.value);
  return {
    title: `${playerName(playerId)}: Most Outs in a Row by Game`,
    rows: scored.map((s) => ({ value: String(s.value), gameRef: gameLabel(s.game), gameId: s.game.id })),
  };
}

function milestoneDetail(playerId: string, scopedGames: GameInstance[], threshold: 200 | 300): StatDetail {
  const scored = completedGamesFor(playerId, scopedGames)
    .map((g) => ({ game: g, value: deriveGameState(g).totals[playerId] }))
    .filter((s) => s.value >= threshold)
    .sort((a, b) => b.value - a.value);
  return {
    title: `${playerName(playerId)}: ${threshold}+ Point Games`,
    rows: scored.map((s) => ({ value: String(s.value), gameRef: gameLabel(s.game), gameId: s.game.id })),
  };
}

function topWinningScoresDetail(playerId: string, scopedGames: GameInstance[]): StatDetail {
  const scored = completedGamesFor(playerId, scopedGames)
    .filter((g) => deriveGameState(g).winnerIds.includes(playerId))
    .map((g) => ({ game: g, value: deriveGameState(g).totals[playerId] }))
    .sort((a, b) => b.value - a.value);
  return {
    title: `${playerName(playerId)}: Highest Winning Scores`,
    rows: scored.map((s) => ({ value: String(s.value), gameRef: gameLabel(s.game), gameId: s.game.id })),
  };
}

function bottomLosingScoresDetail(playerId: string, scopedGames: GameInstance[]): StatDetail {
  const scored = completedGamesFor(playerId, scopedGames)
    .filter((g) => !deriveGameState(g).winnerIds.includes(playerId))
    .map((g) => ({ game: g, value: deriveGameState(g).totals[playerId] }))
    .sort((a, b) => a.value - b.value);
  return {
    title: `${playerName(playerId)}: Lowest Losing Scores`,
    rows: scored.map((s) => ({ value: String(s.value), gameRef: gameLabel(s.game), gameId: s.game.id })),
  };
}

/** Every game where the player crossed `threshold`, ranked by how early they
 *  crossed it. Games that finished under the line aren't listed, there's no
 *  round to report for a line never crossed. */
function paceDetail(
  playerId: string,
  scopedGames: GameInstance[],
  threshold: PaceThreshold,
  dir: "asc" | "desc",
): StatDetail {
  const scored = completedGamesFor(playerId, scopedGames)
    .map((g) => ({ game: g, round: roundReachingThreshold(g, playerId, threshold) }))
    .filter((s): s is { game: GameInstance; round: RoundEntry } => s.round !== null)
    .sort((a, b) => (dir === "asc" ? a.round.roundIndex - b.round.roundIndex : b.round.roundIndex - a.round.roundIndex));
  return {
    title: `${playerName(playerId)}: ${dir === "asc" ? "Quickest" : "Slowest"} to ${threshold}`,
    rows: scored.map((s) => ({
      value: `Rd ${roundLabel(s.round)}`,
      gameRef: gameLabel(s.game),
      gameId: s.game.id,
    })),
  };
}

/** Every game where the player finished in exactly this place, backs the
 *  Runner Up / Third Place / ... rows, all of which share this same shape. */
function placeDetail(playerId: string, scopedGames: GameInstance[], place: number, label: string): StatDetail {
  const scored = completedGamesFor(playerId, scopedGames)
    .filter((g) => finishPosition(g, playerId) === place)
    .map((g) => ({ game: g, value: deriveGameState(g).totals[playerId] }))
    .sort((a, b) => a.value - b.value);
  return {
    title: `${playerName(playerId)}: ${label} Finishes`,
    rows: scored.map((s) => ({
      value: String(s.value),
      gameRef: gameLabel(s.game),
      gameId: s.game.id,
    })),
  };
}

/** Wins ranked by how decisive they were. The biggest blowouts first. */
function winMarginDetail(playerId: string, scopedGames: GameInstance[]): StatDetail {
  const scored = completedGamesFor(playerId, scopedGames)
    .filter((g) => deriveGameState(g).winnerIds.includes(playerId))
    .map((g) => {
      const { totals, winnerIds } = deriveGameState(g);
      const others = g.playerIds.filter((id) => !winnerIds.includes(id));
      if (others.length === 0) return null;
      const nextBest = Math.min(...others.map((id) => totals[id]));
      return { game: g, value: nextBest - totals[playerId] };
    })
    .filter((s): s is { game: GameInstance; value: number } => s !== null)
    .sort((a, b) => b.value - a.value);
  return {
    title: `${playerName(playerId)}: Margins in Wins`,
    rows: scored.map((s) => ({
      value: `${s.value} ahead`,
      gameRef: gameLabel(s.game),
      gameId: s.game.id,
    })),
  };
}

/** Losses ranked by how close they were. The games that got away first. */
function lossMarginDetail(playerId: string, scopedGames: GameInstance[]): StatDetail {
  const scored = completedGamesFor(playerId, scopedGames)
    .filter((g) => !deriveGameState(g).winnerIds.includes(playerId))
    .map((g) => {
      const { totals } = deriveGameState(g);
      const winning = Math.min(...g.playerIds.map((id) => totals[id]));
      return { game: g, value: totals[playerId] - winning };
    })
    .sort((a, b) => a.value - b.value);
  return {
    title: `${playerName(playerId)}: Margins in Losses`,
    rows: scored.map((s) => ({
      value: `${s.value} behind`,
      gameRef: gameLabel(s.game),
      gameId: s.game.id,
    })),
  };
}

function ordinal(n: number): string {
  // 11th/12th/13th are the exceptions that a bare last-digit rule gets wrong.
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return `${n}${suffix}`;
}

// Runner Up (2) through Twelfth Place (12) spelled out, matching how a
// person actually says a standing out loud, beyond that a card-game table
// is implausible enough that falling back to "13th Place" etc. is fine.
const PLACE_ORDINAL_WORDS = [
  "", "First", "Second", "Third", "Fourth", "Fifth", "Sixth",
  "Seventh", "Eighth", "Ninth", "Tenth", "Eleventh", "Twelfth",
];

/** Row/detail-title label for a "finished in place N" stat, N >= 2 (place 1
 *  is just Wins, tracked separately). */
function placeStatLabel(place: number): string {
  if (place === 2) return "Runner Up";
  return PLACE_ORDINAL_WORDS[place] ? `${PLACE_ORDINAL_WORDS[place]} Place` : `${ordinal(place)} Place`;
}

/** Every win (or loss) streak the player's ever had, longest first. The
 *  breakdown behind double-clicking Longest Win/Losing Streak. */
function streakListDetailRows(playerId: string, scopedGames: GameInstance[], type: "win" | "loss"): StatDetail {
  const chronological = sortChronologically(completedGamesFor(playerId, scopedGames));
  return {
    title: `${playerName(playerId)}: ${type === "win" ? "Winning" : "Losing"} Streaks`,
    rows: streakListDetail(chronological, playerId, type).map(streakCell),
  };
}

/* -----------------------------------------------------------------------
   Table-level detail. The same double-click breakdown the per-player stats
   get, but for the whole-table records. Each one re-ranks EVERY game at the
   table rather than listing only the games tied for the record, so the
   record row is just the top of a list you can read down and open games from.
------------------------------------------------------------------------ */

function completedTableGames(scopedGames: GameInstance[]): GameInstance[] {
  return scopedGames.filter((g) => deriveGameState(g).isComplete);
}

function combinedScoreDetail(table: TableOption, scopedGames: GameInstance[], dir: "desc" | "asc"): StatDetail {
  const scored = completedTableGames(scopedGames)
    .map((g) => {
      const { totals } = deriveGameState(g);
      return { game: g, value: table.playerIds.reduce((sum, id) => sum + totals[id], 0) };
    })
    .sort((a, b) => (dir === "desc" ? b.value - a.value : a.value - b.value));
  return {
    title: `${table.label}: ${dir === "desc" ? "Highest" : "Lowest"} Combined Scores`,
    rows: scored.map((s) => ({ value: String(s.value), gameRef: gameLabel(s.game), gameId: s.game.id })),
  };
}

/** Margin between first and second place. The two scores are carried into the
 *  game column because the margin alone doesn't say whether it was a tight
 *  low-scoring game or a tight blowout. */
function marginDetail(table: TableOption, scopedGames: GameInstance[], dir: "asc" | "desc"): StatDetail {
  const scored = completedTableGames(scopedGames)
    .map((g) => {
      const { totals } = deriveGameState(g);
      const [firstId, secondId] = [...table.playerIds].sort((a, b) => totals[a] - totals[b]);
      return {
        game: g,
        value: totals[secondId] - totals[firstId],
        matchup: `${playerName(firstId)} ${totals[firstId]} vs ${playerName(secondId)} ${totals[secondId]}`,
      };
    })
    .sort((a, b) => (dir === "asc" ? a.value - b.value : b.value - a.value));
  return {
    title: `${table.label}: ${dir === "asc" ? "Closest" : "Most Lopsided"} Games`,
    rows: scored.map((s) => ({
      value: String(s.value),
      gameRef: `${gameLabel(s.game)}: ${s.matchup}`,
      gameId: s.game.id,
    })),
  };
}

/** Every game at the table ranked by how many times the lead changed hands. */
function leadChangeDetail(table: TableOption, scopedGames: GameInstance[]): StatDetail {
  const scored = completedTableGames(scopedGames)
    .map((g) => ({ game: g, value: leadChangesInGame(g) }))
    .sort((a, b) => b.value - a.value);
  return {
    title: `${table.label}: Most Lead Changes`,
    rows: scored.map((s) => ({
      value: `${s.value} ${s.value === 1 ? "change" : "changes"}`,
      gameRef: gameLabel(s.game),
      gameId: s.game.id,
    })),
  };
}

/** Games where the eventual winner trailed at some point, deepest hole first.
 *  Wire-to-wire games are dropped rather than listed as a 0-point comeback,
 *  they're the opposite thing, and they have their own record. */
function comebackDetail(table: TableOption, scopedGames: GameInstance[]): StatDetail {
  const scored = completedTableGames(scopedGames)
    .map((g) => ({ game: g, comeback: comebackInGame(g) }))
    .filter((s): s is { game: GameInstance; comeback: NonNullable<ReturnType<typeof comebackInGame>> } =>
      (s.comeback?.deficit ?? 0) > 0,
    )
    .sort((a, b) => b.comeback.deficit - a.comeback.deficit);
  return {
    title: `${table.label}: Comebacks`,
    rows: scored.map((s) => ({
      value: `${playerName(s.comeback.playerId)}, ${s.comeback.deficit} behind (Rd ${roundLabel(s.comeback.round)})`,
      gameRef: gameLabel(s.game),
      gameId: s.game.id,
    })),
  };
}

/** "Tim, 74 behind after Rd 7. Game 12". Who and when are both part of the
 *  record: a bare deficit leaves you cross-referencing the game to find out
 *  which player it refers to and where in the game they bottomed out. */
function comebackText(
  entries: (GameReference & { value: number; playerId: string; roundLabel: string })[],
): string {
  if (entries.length === 0 || entries[0].value === 0) return "none";
  const top = entries[0];
  return `${playerName(top.playerId)}, ${top.value} behind after Rd ${top.roundLabel}: ${formatGameRefs(entries)}`;
}

function wireToWireDetail(table: TableOption, scopedGames: GameInstance[]): StatDetail {
  const wins = completedTableGames(scopedGames).filter(isWireToWire);
  return {
    title: `${table.label}: Wire-to-Wire Wins`,
    rows: wins.map((g) => ({
      value: playerName(deriveGameState(g).winnerIds[0]),
      gameRef: gameLabel(g),
      gameId: g.id,
    })),
  };
}

function overtimeDetail(table: TableOption, scopedGames: GameInstance[]): StatDetail {
  const scored = completedTableGames(scopedGames)
    .map((g) => ({ game: g, value: g.rounds.filter((r) => r.isOvertime).length }))
    .filter((s) => s.value > 0)
    .sort((a, b) => b.value - a.value);
  return {
    title: `${table.label}: Overtime Games`,
    rows: scored.map((s) => ({
      value: `${s.value} ${s.value === 1 ? "round" : "rounds"}`,
      gameRef: gameLabel(s.game),
      gameId: s.game.id,
    })),
  };
}

/* -----------------------------------------------------------------------
   The comparison table itself, shared by Profile Compare mode and Table
   Stats mode (auto-populated with everyone at that table), so career
   records sit right in the same ranked/highlighted table as the rate
   stats instead of a separate, non-comparable card underneath.
------------------------------------------------------------------------ */

/** Every stat cell is (value, game reference) (for rate stats the game
 *  column is just blank, but keeping the shape uniform is what lets the
 *  comparison table give every player two physical sub-columns (like the
 *  round-entry grid's Score/Total split) instead of cramming "value) Game
 *  N" into one string. */
type StatCell = { value: string; gameRef: string; gameId?: string };

function paceCell(entries: PaceEntry[]): StatCell {
  if (entries.length === 0) return { value: "—", gameRef: "—" };
  return { value: `Rd ${entries[0].roundLabel}`, gameRef: formatGameRefs(entries) };
}

/** Never having crossed the threshold ranks as infinitely slow, which for a
 *  game where points are damage is the BEST possible showing. Ranking it as 0
 *  instead would invert the highlight and mark the most disciplined player as
 *  the worst. */
function paceRank(entries: PaceEntry[]): number {
  return entries[0]?.value ?? Number.POSITIVE_INFINITY;
}

function recordCell(entries: (GameReference & { value: number })[]): StatCell {
  if (entries.length === 0) return { value: "—", gameRef: "—" };
  return { value: String(entries[0].value), gameRef: formatGameRefs(entries) };
}

type StatRow = {
  key: string;
  label: string;
  /** Section this row belongs to, rendered as a full-width divider row the
   *  first time it appears, so a 19-row table reads as four short lists
   *  instead of one undifferentiated block. Purely presentational. */
  group: string;
  polarity: StatPolarity;
  rank: (s: PlayerStats) => number;
  cell: (s: PlayerStats) => StatCell;
  detail?: (playerId: string, scopedGames: GameInstance[]) => StatDetail;
};

const STAT_ROWS: StatRow[] = [
  { key: "gamesPlayed", label: "Games Played", group: "Rates", polarity: "neutral", rank: (s) => s.rates.gamesPlayed, cell: (s) => ({ value: String(s.rates.gamesPlayed), gameRef: "" }) },
  { key: "wins", label: "Wins", group: "Rates", polarity: "neutral", rank: (s) => s.rates.wins, cell: (s) => ({ value: String(s.rates.wins), gameRef: "" }) },
  // Runner Up / Third Place / ... are spliced in right here, dynamically,
  // see placeStatRows() below and its call site in buildStatsComparisonTable.
  { key: "winPct", label: "Win %", group: "Rates", polarity: "higher-better", rank: (s) => s.rates.winPct, cell: (s) => ({ value: `${s.rates.winPct.toFixed(1)}%`, gameRef: "" }) },
  { key: "totalPoints", label: "Total Points", group: "Rates", polarity: "neutral", rank: (s) => s.rates.totalPoints, cell: (s) => ({ value: String(s.rates.totalPoints), gameRef: "" }) },
  { key: "avgPointsPerGame", label: "Avg Points / Game", group: "Rates", polarity: "lower-better", rank: (s) => s.rates.avgPointsPerGame, cell: (s) => ({ value: s.rates.avgPointsPerGame.toFixed(1), gameRef: "" }) },
  { key: "avgPointsPerRound", label: "Avg Points / Round", group: "Rates", polarity: "lower-better", rank: (s) => s.rates.avgPointsPerRound, cell: (s) => ({ value: s.rates.avgPointsPerRound.toFixed(2), gameRef: "" }) },
  { key: "outsPerGame", label: "Outs / Game", group: "Rates", polarity: "higher-better", rank: (s) => s.rates.outsPerGame, cell: (s) => ({ value: s.rates.outsPerGame.toFixed(2), gameRef: "" }) },
  {
    key: "avgMarginInWins", label: "Avg Margin in Wins", group: "Rates", polarity: "higher-better",
    rank: (s) => s.rates.avgMarginInWins,
    cell: (s) => ({
      value: s.rates.wins === 0 ? "—" : s.rates.avgMarginInWins.toFixed(1),
      gameRef: "",
    }),
    detail: (pid, g) => winMarginDetail(pid, g),
  },
  {
    key: "avgMarginInLosses", label: "Avg Margin in Losses", group: "Rates", polarity: "lower-better",
    rank: (s) => s.rates.avgMarginInLosses,
    cell: (s) => ({
      value: s.rates.wins === s.rates.gamesPlayed ? "—" : s.rates.avgMarginInLosses.toFixed(1),
      gameRef: "",
    }),
    detail: (pid, g) => lossMarginDetail(pid, g),
  },
  {
    key: "highestScoreGame", label: "Highest Score (Game)", group: "Career Records", polarity: "lower-better",
    rank: (s) => s.career.highestScoreGame[0]?.value ?? 0,
    cell: (s) => recordCell(s.career.highestScoreGame),
    detail: (pid, g) => topGameScoresDetail(pid, g, "desc"),
  },
  {
    key: "lowestScoreGame", label: "Lowest Score (Game)", group: "Career Records", polarity: "lower-better",
    rank: (s) => s.career.lowestScoreGame[0]?.value ?? 0,
    cell: (s) => recordCell(s.career.lowestScoreGame),
    detail: (pid, g) => topGameScoresDetail(pid, g, "asc"),
  },
  {
    key: "highestScoreRound", label: "Highest Score (Round)", group: "Career Records", polarity: "lower-better",
    rank: (s) => s.career.highestScoreRound[0]?.value ?? 0,
    cell: (s) => {
      const entries = s.career.highestScoreRound;
      if (entries.length === 0) return { value: "—", gameRef: "—" };
      return { value: `${entries[0].value} (Rd ${entries[0].roundLabel})`, gameRef: formatGameRefs(entries) };
    },
    detail: (pid, g) => topRoundScoresDetail(pid, g),
  },
  {
    key: "mostOutsGame", label: "Most Outs (Game)", group: "Career Records", polarity: "higher-better",
    rank: (s) => s.career.mostOutsGame[0]?.value ?? 0,
    cell: (s) => recordCell(s.career.mostOutsGame),
    detail: (pid, g) => topOutsDetail(pid, g, "desc"),
  },
  {
    key: "fewestOutsGame", label: "Fewest Outs (Game)", group: "Career Records", polarity: "higher-better",
    rank: (s) => s.career.fewestOutsGame[0]?.value ?? 0,
    cell: (s) => recordCell(s.career.fewestOutsGame),
    detail: (pid, g) => topOutsDetail(pid, g, "asc"),
  },
  {
    key: "mostOutsInARow", label: "Most Outs in a Row", group: "Career Records", polarity: "higher-better",
    rank: (s) => s.career.mostOutsInARow[0]?.value ?? 0,
    cell: (s) => recordCell(s.career.mostOutsInARow),
    detail: (pid, g) => mostOutsInARowDetail(pid, g),
  },
  {
    key: "highestWinningScore", label: "Highest Winning Score", group: "Career Records", polarity: "lower-better",
    rank: (s) => s.career.highestWinningScore[0]?.value ?? 0,
    cell: (s) => recordCell(s.career.highestWinningScore),
    detail: (pid, g) => topWinningScoresDetail(pid, g),
  },
  {
    key: "lowestLosingScore", label: "Lowest Losing Score", group: "Career Records", polarity: "lower-better",
    rank: (s) => s.career.lowestLosingScore[0]?.value ?? 0,
    cell: (s) => recordCell(s.career.lowestLosingScore),
    detail: (pid, g) => bottomLosingScoresDetail(pid, g),
  },
  {
    key: "count200", label: "200+ Point Games", group: "Milestones", polarity: "lower-better",
    rank: (s) => s.rates.count200,
    cell: (s) => ({ value: String(s.rates.count200), gameRef: s.rates.count200 ? formatGameRefs(s.rates.games200) : "—" }),
    detail: (pid, g) => milestoneDetail(pid, g, 200),
  },
  {
    key: "count300", label: "300+ Point Games", group: "Milestones", polarity: "lower-better",
    rank: (s) => s.rates.count300,
    cell: (s) => ({ value: String(s.rates.count300), gameRef: s.rates.count300 ? formatGameRefs(s.rates.games300) : "—" }),
    detail: (pid, g) => milestoneDetail(pid, g, 300),
  },
  // Pace. One Quickest/Slowest pair per threshold, generated rather than
  // written out six times so a new threshold is a one-line change.
  ...PACE_THRESHOLDS.flatMap((threshold): StatRow[] => [
    {
      key: `quickestTo${threshold}`, label: `Quickest to ${threshold}`, group: "Pace", polarity: "higher-better",
      rank: (s) => paceRank(s.career.pace[threshold].quickest),
      cell: (s) => paceCell(s.career.pace[threshold].quickest),
      detail: (pid, g) => paceDetail(pid, g, threshold, "asc"),
    },
    {
      key: `slowestTo${threshold}`, label: `Slowest to ${threshold}`, group: "Pace", polarity: "higher-better",
      rank: (s) => paceRank(s.career.pace[threshold].slowest),
      cell: (s) => paceCell(s.career.pace[threshold].slowest),
      detail: (pid, g) => paceDetail(pid, g, threshold, "desc"),
    },
  ]),
  {
    key: "longestWinStreak", label: "Longest Win Streak", group: "Streaks", polarity: "higher-better",
    rank: (s) => s.rates.longestWinStreak?.length ?? 0,
    cell: (s) => streakCell(s.rates.longestWinStreak),
    detail: (pid, g) => streakListDetailRows(pid, g, "win"),
  },
  {
    key: "longestLossStreak", label: "Longest Losing Streak", group: "Streaks", polarity: "lower-better",
    rank: (s) => s.rates.longestLossStreak?.length ?? 0,
    cell: (s) => streakCell(s.rates.longestLossStreak),
    detail: (pid, g) => streakListDetailRows(pid, g, "loss"),
  },
  {
    key: "currentStreak",
    label: "Current Streak",
    group: "Streaks",
    polarity: "neutral",
    rank: () => 0,
    cell: (s) => ({
      value: s.rates.currentStreak.type === "none" ? "—" : `${s.rates.currentStreak.length} ${s.rates.currentStreak.type}${s.rates.currentStreak.length === 1 ? "" : "s"}`,
      gameRef: "",
    }),
  },
];

/** "Runner Up", "Third Place", .... One row per place beyond 1st, but only
 *  for places that are a distinct standing at SOME game someone here has
 *  played: place N only exists once a game has had N+1 players (at a
 *  2-player table, "2nd" is just "lost"). Generated from the actual
 *  statsList being compared rather than kept in STAT_ROWS statically, since
 *  which placings are worth a row depends on the data, not the game type. */
function placeStatRows(statsList: PlayerStats[]): StatRow[] {
  const maxPlayers = Math.max(0, ...statsList.map((s) => s.rates.maxPlayersInAnyGame));
  const rows: StatRow[] = [];
  for (let place = 2; place <= maxPlayers - 1; place++) {
    const label = placeStatLabel(place);
    rows.push({
      key: `place${place}`,
      label,
      group: "Rates",
      polarity: "neutral",
      rank: (s) => s.rates.placeCounts[place] ?? 0,
      cell: (s) => ({ value: String(s.rates.placeCounts[place] ?? 0), gameRef: "" }),
      detail: (pid, g) => placeDetail(pid, g, place, label),
    });
  }
  return rows;
}

/** Best gets green; worst additionally gets red once 3+ are being compared
 *  (matches the 2-vs-3+ behavior described for the Compare view). Neutral
 *  stats (plain counts/totals) are never highlighted, there's no
 *  meaningful "best" games-played count. A row where everyone ties gets no
 *  highlight either. */
function highlightForRow(values: number[], polarity: StatPolarity): ("best" | "worst" | "none")[] {
  if (polarity === "neutral" || values.length < 2) return values.map(() => "none");
  const max = Math.max(...values);
  const min = Math.min(...values);
  if (max === min) return values.map(() => "none");
  const bestVal = polarity === "higher-better" ? max : min;
  const worstVal = polarity === "higher-better" ? min : max;
  const showWorst = values.length >= 3;
  return values.map((v) => {
    if (v === bestVal) return "best";
    if (showWorst && v === worstVal) return "worst";
    return "none";
  });
}

/** Shared by Profile Compare mode (manually selected players, scoped to
 *  their whole history) and Table Stats mode (every player at that table,
 *  scoped to just that table's games). Same table shape either way. Each
 *  player gets two physical sub-columns (Value / Game), matching the
 *  round-entry grid's Score/Total split, instead of squeezing "value.
 *  Game N" into one string. */
function buildStatsComparisonTable(
  profileIds: string[],
  statsList: PlayerStats[],
  scopedGames: GameInstance[],
): HTMLElement {
  // Scroll container, carries the rounded frame and gives the sticky stat-name
  // column and sticky header something to pin against.
  const wrap = document.createElement("div");
  wrap.className = "gs-stats-table-wrap";

  const table = document.createElement("table");
  table.className = "gs-stats-table";

  const thead = document.createElement("thead");
  const nameRow = document.createElement("tr");
  const corner = document.createElement("th");
  corner.rowSpan = 2;
  nameRow.appendChild(corner);
  profileIds.forEach((id) => {
    const th = document.createElement("th");
    th.colSpan = 2;
    th.className = "gs-col-start";
    th.textContent = playerName(id);
    nameRow.appendChild(th);
  });
  thead.appendChild(nameRow);

  const subRow = document.createElement("tr");
  profileIds.forEach(() => {
    const valueTh = document.createElement("th");
    valueTh.className = "gs-subheader gs-col-start";
    valueTh.textContent = "Value";
    subRow.appendChild(valueTh);
    const gameTh = document.createElement("th");
    gameTh.className = "gs-subheader";
    gameTh.textContent = "Game";
    subRow.appendChild(gameTh);
  });
  thead.appendChild(subRow);
  table.appendChild(thead);

  // Runner Up / Third Place / ... spliced in right after Wins, see
  // placeStatRows().
  const winsIndex = STAT_ROWS.findIndex((r) => r.key === "wins");
  const rows = [
    ...STAT_ROWS.slice(0, winsIndex + 1),
    ...placeStatRows(statsList),
    ...STAT_ROWS.slice(winsIndex + 1),
  ];

  const tbody = document.createElement("tbody");
  let lastGroup = "";
  rows.forEach((row) => {
    if (row.group !== lastGroup) {
      lastGroup = row.group;
      const groupTr = document.createElement("tr");
      groupTr.className = "gs-stats-group-row";
      const groupTd = document.createElement("td");
      groupTd.colSpan = profileIds.length * 2 + 1;
      groupTd.textContent = row.group;
      groupTr.appendChild(groupTd);
      tbody.appendChild(groupTr);
    }

    const tr = document.createElement("tr");
    const labelTd = document.createElement("td");
    labelTd.className = "gs-stats-row-label";
    labelTd.textContent = row.label;
    tr.appendChild(labelTd);

    const values = statsList.map((s) => row.rank(s));
    const highlights = highlightForRow(values, row.polarity);

    statsList.forEach((s, i) => {
      const { value, gameRef } = row.cell(s);
      const valueTd = document.createElement("td");
      valueTd.className = "gs-col-start";
      valueTd.textContent = value;
      if (highlights[i] === "best") valueTd.classList.add("gs-stat-best");
      if (highlights[i] === "worst") valueTd.classList.add("gs-stat-worst");

      const gameTd = document.createElement("td");
      gameTd.className = "gs-stats-game-cell";
      gameTd.textContent = gameRef;

      if (row.detail) {
        const detailFn = row.detail;
        const pid = profileIds[i];
        const openDetail = () => {
          const detail = detailFn(pid, scopedGames);
          openStatDetailModal(detail.title, detail.rows);
        };
        [valueTd, gameTd].forEach((td) => {
          td.classList.add("gs-stat-detail-cell");
          td.title = "Double-click for details";
          td.addEventListener("dblclick", openDetail);
        });
      }

      tr.appendChild(valueTd);
      tr.appendChild(gameTd);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

function renderProfileCompare(profileIds: string[]): void {
  const container = document.getElementById("gsStatsResults")!;
  container.innerHTML = "";
  if (profileIds.length === 0) {
    const empty = document.createElement("div");
    empty.className = "gs-empty";
    empty.textContent = "Pick a profile to see their stats. Add up to four to compare side by side.";
    container.appendChild(empty);
    return;
  }

  const statsList = profileIds.map((id) => computePlayerStats(games, id));
  container.appendChild(buildStatsComparisonTable(profileIds, statsList, games));
}

type TableOption = { key: string; gameType: GameType; playerIds: string[]; label: string };

/** Every table with at least one logged game, newest-name-first alphabetical.
 *  Optionally narrowed to a single game type. The Historical and Stats views
 *  both pick a game first, then a table within it. */
function listAllTables(gameType?: GameType): TableOption[] {
  const live = new Set(games.map(tableKeyOf));
  return tables
    .filter((t) => live.has(t.key) && (!gameType || t.gameType === gameType))
    .map((t) => ({
      key: t.key,
      gameType: t.gameType,
      playerIds: t.playerIds,
      label: t.name || autoTableLabel(t.playerIds),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function refreshStatsTableOptions(): void {
  const select = document.getElementById("gsStatsTableSelect") as HTMLSelectElement;
  const current = select.value;
  select.innerHTML = "";
  listAllTables(gsStatsGameType).forEach((t) => {
    const opt = document.createElement("option");
    opt.value = t.key;
    opt.textContent = t.label;
    select.appendChild(opt);
  });
  if ([...select.options].some((o) => o.value === current)) select.value = current;
}

/* -----------------------------------------------------------------------
   Table Stats face switcher. The same cross-fade Budget Tracker uses for
   Annual Stats. The main face carries the head-to-head card with the player
   breakdowns underneath it; the Win Chart and its table live on the second
   face, since together they're a full screen's worth of content that would
   otherwise push the breakdowns out of sight.

   Only one face is ever in normal flow, so the container height is always
   exact and no gap can be left behind.
------------------------------------------------------------------------ */

type GsTableStatsFace = "main" | "winchart";
let gsTableStatsFace: GsTableStatsFace = "main";
// Deferred so the chart can be drawn at the moment its face becomes visible,
// drawLineChart() reads canvas.clientWidth, which is 0 while display:none.
let gsWinChartDraw: (() => void) | null = null;
const GS_FACE_FADE_MS = 400; // must match the gs-face-* animation duration

function updateWinChartToggleBtn(enabled: boolean): void {
  const btn = document.getElementById("gsWinChartToggleBtn") as HTMLButtonElement | null;
  if (!btn) return;
  btn.style.display = enabled ? "" : "none";
  btn.textContent = gsTableStatsFace === "main" ? "View Win Chart" : "View Table Stats";
}

function toggleTableStatsFace(): void {
  const container = document.getElementById("gsStatsResults")!;
  const front = container.querySelector<HTMLElement>(".gs-flip-front");
  const back = container.querySelector<HTMLElement>(".gs-flip-back");
  if (!front || !back) return;
  // Guards against a second click landing mid-transition, which would leave
  // both faces hidden.
  if (container.dataset.flipping === "1") return;
  container.dataset.flipping = "1";

  gsTableStatsFace = gsTableStatsFace === "main" ? "winchart" : "main";
  updateWinChartToggleBtn(true);

  const showingWinChart = gsTableStatsFace === "winchart";
  const outgoing = showingWinChart ? front : back;
  const incoming = showingWinChart ? back : front;

  outgoing.classList.add("gs-face-hiding");
  window.setTimeout(() => {
    // Midpoint: the outgoing face has reached opacity 0, so swap which face
    // is in flow before fading the incoming one in.
    outgoing.classList.remove("gs-face-hiding");
    outgoing.style.display = "none";
    incoming.style.display = "flex";
    if (showingWinChart) gsWinChartDraw?.();
    incoming.classList.add("gs-face-showing");
    incoming.addEventListener("animationend", function done() {
      incoming.removeEventListener("animationend", done);
      incoming.classList.remove("gs-face-showing");
      delete container.dataset.flipping;
    });
  }, GS_FACE_FADE_MS);
}

function renderTableStats(): void {
  const container = document.getElementById("gsStatsResults")!;
  container.innerHTML = "";
  delete container.dataset.flipping;
  gsWinChartDraw = null;

  const select = document.getElementById("gsStatsTableSelect") as HTMLSelectElement;
  const options = listAllTables(gsStatsGameType);
  const chosen = options.find((t) => t.key === select.value) ?? options[0];
  if (!chosen) {
    const empty = document.createElement("div");
    empty.className = "gs-empty";
    empty.textContent = "No games logged yet. Tables appear once a game has been saved.";
    container.appendChild(empty);
    updateWinChartToggleBtn(false);
    return;
  }

  const scopedGames = gamesForTable(games, chosen.gameType, chosen.playerIds);
  const stats = computeTableStats(games, chosen.gameType, chosen.playerIds);

  const card = document.createElement("div");
  card.className = "panel gs-table-stats-card";

  const header = document.createElement("div");
  header.className = "gs-panel-header";
  const heading = document.createElement("div");
  heading.className = "gs-panel-heading";
  const title = document.createElement("div");
  title.className = "gs-panel-title";
  title.textContent = chosen.label;
  heading.appendChild(title);
  const sub = document.createElement("div");
  sub.className = "gs-panel-sub";
  sub.textContent = `${stats.gamesPlayed} ${stats.gamesPlayed === 1 ? "game" : "games"} at this exact table.`;
  heading.appendChild(sub);
  header.appendChild(heading);
  card.appendChild(header);

  // Head-to-head win counts get the tile treatment. This is the one number
  // people actually come to this view for.
  const h2hTiles = document.createElement("div");
  h2hTiles.className = "gs-h2h-tiles";
  chosen.playerIds.forEach((id) => {
    const h2h = stats.headToHead[id];
    h2hTiles.appendChild(
      buildTile(String(h2h.wins), playerName(id), { sub: `${h2h.winPct.toFixed(1)}% win rate` }),
    );
  });
  card.appendChild(h2hTiles);

  const recordList = document.createElement("div");
  recordList.className = "gs-record-list";
  // `detail` is built lazily. It walks every game at the table, which is
  // wasted work for a row nobody double-clicks.
  const records: { label: string; value: string; detail?: () => StatDetail }[] = [
    {
      label: "Total Points",
      value: String(stats.totalPointsAllTime),
    },
    {
      label: "Highest Combined",
      value: recordListText(stats.highestCombinedScore),
      detail: () => combinedScoreDetail(chosen, scopedGames, "desc"),
    },
    {
      label: "Lowest Combined",
      value: recordListText(stats.lowestCombinedScore),
      detail: () => combinedScoreDetail(chosen, scopedGames, "asc"),
    },
    {
      label: "Closest Game",
      value: marginGameText(stats.closestGame),
      detail: () => marginDetail(chosen, scopedGames, "asc"),
    },
    {
      label: "Most Lopsided",
      value: marginGameText(stats.mostLopsidedGame),
      detail: () => marginDetail(chosen, scopedGames, "desc"),
    },
    {
      label: "Most Lead Changes",
      value: recordListText(stats.mostLeadChanges),
      detail: () => leadChangeDetail(chosen, scopedGames),
    },
    {
      label: "Biggest Comeback",
      // A 0 here means nobody has ever won from behind at this table, which
      // comebackText() reports as "none" rather than a zero-point record.
      value: comebackText(stats.biggestComeback),
      detail: stats.biggestComeback[0]?.value ? () => comebackDetail(chosen, scopedGames) : undefined,
    },
    {
      label: "Wire-to-Wire Wins",
      value: stats.wireToWireGames.length
        ? `${stats.wireToWireGames.length}: ${formatGameRefs(stats.wireToWireGames)}`
        : "none",
      detail: stats.wireToWireGames.length ? () => wireToWireDetail(chosen, scopedGames) : undefined,
    },
    {
      label: "Overtime Games",
      value: overtimeGamesText(stats.overtimeGames),
      // Nothing to rank when the table has never gone to overtime.
      detail: stats.overtimeGames.length ? () => overtimeDetail(chosen, scopedGames) : undefined,
    },
  ];
  records.forEach(({ label, value, detail }) => {
    const row = document.createElement("div");
    row.className = "gs-record-row";
    const labelEl = document.createElement("div");
    labelEl.className = "gs-record-label";
    labelEl.textContent = label;
    row.appendChild(labelEl);
    const valueEl = document.createElement("div");
    valueEl.className = "gs-record-value";
    if (value === "—" || value === "none") valueEl.classList.add("gs-record-empty");
    valueEl.textContent = value;
    row.appendChild(valueEl);

    if (detail && stats.gamesPlayed > 0) {
      row.classList.add("gs-record-row-detail");
      row.title = "Double-click for details";
      row.addEventListener("dblclick", () => {
        const built = detail();
        openStatDetailModal(built.title, built.rows);
      });
    }
    recordList.appendChild(row);
  });
  card.appendChild(recordList);

  // Main face: the head-to-head card with the per-player breakdowns directly
  // underneath it.
  const front = document.createElement("div");
  front.className = "gs-flip-front";
  front.appendChild(card);
  const compareStats = chosen.playerIds.map((id) => computePlayerStats(scopedGames, id));
  front.appendChild(buildStatsComparisonTable(chosen.playerIds, compareStats, scopedGames));

  // Second face: the Win Chart and its table.
  const back = document.createElement("div");
  back.className = "gs-flip-back";
  const winChart = buildWinChartSection(chosen.gameType, chosen.playerIds);
  back.appendChild(winChart.element);
  gsWinChartDraw = winChart.draw;

  container.appendChild(front);
  container.appendChild(back);

  const showingWinChart = gsTableStatsFace === "winchart";
  front.style.display = showingWinChart ? "none" : "flex";
  back.style.display = showingWinChart ? "flex" : "none";
  // Only draw once the face is actually displayed, a canvas inside a
  // display:none ancestor reports clientWidth 0 and renders blank.
  if (showingWinChart) winChart.draw();
  updateWinChartToggleBtn(true);
}

/* =============================================================================
   CHARTS
   -----------------------------------------------------------------------------
   Bespoke Canvas 2D line chart (no charting library dependency, matching
   Budget Tracker's own hand-rolled chart drawing), small enough to keep
   local to this tool rather than sharing budget.ts's private helpers.
============================================================================= */

function gsCssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Canvas fillStyle/strokeStyle silently ignore anything it can't parse, which
 *  would leave a chart drawn in whatever colour was last set. Themes state
 *  colours as hex OR rgb()/rgba()/hsl() (e.g. cake's translucent muted text),
 *  so all of those pass; anything else (empty, or a `var()`/`color-mix()`
 *  that came back unsubstituted) takes the fallback. */
function gsSafeColor(raw: string, fallback: string): string {
  const value = raw.trim();
  if (/^#[0-9a-fA-F]{3,8}$/.test(value)) return value;
  if (/^(rgb|rgba|hsl|hsla)\(/i.test(value)) return value;
  return fallback;
}

const GS_CHART_FALLBACKS = ["#4fc3f7", "#81c784", "#ffb74d", "#e57373", "#ce93d8", "#4db6ac", "#f06292", "#fff176"];

function gsChartPalette(): string[] {
  return GS_CHART_FALLBACKS.map((fb, i) => gsSafeColor(gsCssVar(`--color-chart-${i + 1}`), fb));
}

type GsChartSeries = { name: string; values: number[] };
type GsChartGeometry = { padL: number; padT: number; chartW: number; chartH: number; maxVal: number; n: number };
type GsDrawChartOptions = { height?: number; showXLabels?: boolean };

/** Draws a simple multi-series line chart with a bottom legend, returning
 *  the geometry used (needed by attachChartHover() to map a mouse x back to
 *  a data index without recomputing padding logic separately). `xLabels` is
 *  only actually rendered along the axis when `showXLabels` is set. The
 *  inline versions of these charts skip it to stay compact; the expanded
 *  modal versions turn it on. */
function drawLineChart(
  canvas: HTMLCanvasElement,
  series: GsChartSeries[],
  xLabels: string[],
  options: GsDrawChartOptions = {},
): GsChartGeometry {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth || canvas.parentElement?.clientWidth || 300;
  const H = options.height ?? 200;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  const n = xLabels.length;
  const palette = gsChartPalette();
  const textColor = gsSafeColor(gsCssVar("--color-text-muted"), "#888888");
  const borderColor = gsSafeColor(gsCssVar("--color-border"), "#444444");

  const padL = 30;
  const padR = 12;
  const padT = 12;
  const padB = options.showXLabels ? 34 : 22;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;
  const geometry: GsChartGeometry = { padL, padT, chartW, chartH, maxVal: 1, n };
  if (n === 0 || series.length === 0) return geometry;

  const allValues = series.flatMap((s) => s.values);
  const maxVal = Math.max(1, ...allValues);
  geometry.maxVal = maxVal;

  ctx.strokeStyle = borderColor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, padT);
  ctx.lineTo(padL, padT + chartH);
  ctx.lineTo(padL + chartW, padT + chartH);
  ctx.stroke();

  ctx.fillStyle = textColor;
  ctx.font = "10px sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.fillText("0", padL - 4, padT + chartH);
  ctx.fillText(String(maxVal), padL - 4, padT);

  const xStep = n > 1 ? chartW / (n - 1) : 0;

  if (options.showXLabels) {
    const maxLabels = 14;
    const step = Math.max(1, Math.ceil(n / maxLabels));
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.font = "9px sans-serif";
    for (let i = 0; i < n; i += step) {
      ctx.fillText(xLabels[i], padL + i * xStep, padT + chartH + 6);
    }
    if ((n - 1) % step !== 0) {
      ctx.fillText(xLabels[n - 1], padL + (n - 1) * xStep, padT + chartH + 6);
    }
  }

  series.forEach((s, si) => {
    ctx.strokeStyle = palette[si % palette.length];
    ctx.lineWidth = 2;
    ctx.beginPath();
    s.values.forEach((v, i) => {
      const x = padL + i * xStep;
      const y = padT + chartH - (v / maxVal) * chartH;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  });

  ctx.font = "11px sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  let lx = padL;
  const ly = H - 6;
  series.forEach((s, si) => {
    ctx.fillStyle = palette[si % palette.length];
    ctx.fillRect(lx, ly - 4, 8, 8);
    ctx.fillStyle = textColor;
    ctx.fillText(s.name, lx + 11, ly);
    lx += 11 + ctx.measureText(s.name).width + 14;
  });

  return geometry;
}

/** Tracks mouse position over an expanded chart and shows a tooltip with
 *  every series' value at the nearest data point, only wired for the
 *  modal ("expanded") chart, not the compact inline ones. */
function attachChartHover(
  canvas: HTMLCanvasElement,
  series: GsChartSeries[],
  xLabels: string[],
  geometry: GsChartGeometry,
  winners: number[] = [],
): void {
  const winnerIndexes = new Set(winners);
  const tooltip = document.getElementById("gsChartExpandTooltip")!;
  // The tooltip is absolutely positioned inside this same wrap (canvas's
  // direct parent, position:relative, see .gs-chart-expand-canvas-wrap),
  // so its bounds are what "off the edge" is measured against.
  const wrap = canvas.parentElement!;
  const xStep = geometry.n > 1 ? geometry.chartW / (geometry.n - 1) : 0;
  // Read once per attach rather than per mousemove, drawExpandedChart()
  // re-attaches after every draw (theme repaints included), so this is never
  // stale, and gsChartPalette() is 8 getComputedStyle reads.
  const palette = gsChartPalette();

  canvas.onmousemove = (e: MouseEvent) => {
    if (geometry.n === 0) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let idx = xStep > 0 ? Math.round((mx - geometry.padL) / xStep) : 0;
    idx = Math.max(0, Math.min(geometry.n - 1, idx));

    tooltip.innerHTML = "";
    const header = document.createElement("div");
    header.className = "gs-chart-tooltip-header";
    header.textContent = xLabels[idx];
    tooltip.appendChild(header);
    // Rows stay in seat order. The same order every round, and the same
    // order as the legend and the score grid. Sorting by score would make
    // names jump between positions as the cursor moves across the chart,
    // which costs more in re-reading than the ranking is worth.
    const isFinalPoint = idx === geometry.n - 1;
    series.forEach((s, si) => {
      const line = document.createElement("div");
      line.className = "gs-chart-tooltip-row";

      const swatch = document.createElement("span");
      swatch.className = "gs-chart-tooltip-swatch";
      swatch.style.background = palette[si % palette.length];
      line.appendChild(swatch);

      const text = document.createElement("span");
      text.textContent = `${s.name}: ${s.values[idx]}`;
      line.appendChild(text);

      // Only on the last point, where the standings are the final result.
      if (isFinalPoint && winnerIndexes.has(si)) {
        const star = document.createElement("span");
        star.className = "gs-chart-tooltip-star";
        star.textContent = "★";
        star.title = "Winner";
        line.appendChild(star);
      }

      tooltip.appendChild(line);
    });

    // Must be visible (not display:none) before measuring its own size.
    tooltip.style.display = "block";

    // Default to the cursor's bottom-right, but flip to whichever side
    // actually has room, otherwise near the wrap's right/bottom edge the
    // tooltip gets clipped by the modal instead of just repositioning.
    const gap = 14;
    const tw = tooltip.offsetWidth;
    const th = tooltip.offsetHeight;
    const maxLeft = Math.max(0, wrap.clientWidth - tw);
    const maxTop = Math.max(0, wrap.clientHeight - th);

    let left = mx + gap;
    if (left > maxLeft) left = mx - gap - tw;
    let top = my + gap;
    if (top > maxTop) top = my - gap - th;

    tooltip.style.left = `${Math.max(0, Math.min(left, maxLeft))}px`;
    tooltip.style.top = `${Math.max(0, Math.min(top, maxTop))}px`;
  };
  canvas.onmouseleave = () => { tooltip.style.display = "none"; };
}

type GsChartExpandConfig = {
  title: string;
  series: GsChartSeries[];
  xLabels: string[];
  /** Series indexes to mark with a star at the LAST data point. Only charts
   *  whose final point is a result have one. The Win Chart's last point is
   *  just the current standings, not a game anyone won. */
  winners?: number[];
};

let gsChartExpandModal: Modal | null = null;
let gsChartExpandConfig: GsChartExpandConfig | null = null;

function getChartExpandModal(): Modal {
  if (!gsChartExpandModal) {
    gsChartExpandModal = new Modal(document.getElementById("gsChartExpandBackdrop")!, {
      closeOnEsc: true,
      onOpen: () => drawExpandedChart(),
    });
  }
  return gsChartExpandModal;
}

function drawExpandedChart(): void {
  if (!gsChartExpandConfig) return;
  const canvas = document.getElementById("gsChartExpandCanvas") as HTMLCanvasElement;
  const geometry = drawLineChart(canvas, gsChartExpandConfig.series, gsChartExpandConfig.xLabels, {
    height: 380,
    showXLabels: true,
  });
  attachChartHover(
    canvas,
    gsChartExpandConfig.series,
    gsChartExpandConfig.xLabels,
    geometry,
    gsChartExpandConfig.winners,
  );
}

/** Opens the shared chart-expand modal with a larger redraw of whichever
 *  chart's expand button was clicked (Win Chart or a game's progress
 *  chart), with axis labels and a hover tooltip. */
function openChartExpand(config: GsChartExpandConfig): void {
  gsChartExpandConfig = config;
  document.getElementById("gsChartExpandTitle")!.textContent = config.title;
  getChartExpandModal().open();
}

/** Win Chart, cumulative wins per player at this table, game by game, as
 *  both a table (matching the user's original spreadsheet) and a line
 *  graph on top of it. */
/** Builds the Win Chart panel (table + line canvas) without drawing the
 *  chart yet, drawLineChart() reads canvas.clientWidth, which is 0 until
 *  the canvas is actually attached to the visible document. Callers must
 *  append `element` first, then call `draw()`. */
function buildWinChartSection(
  gameType: GameType,
  playerIds: string[],
): { element: HTMLElement; draw: () => void } {
  const wrap = document.createElement("div");
  wrap.className = "panel gs-win-chart-panel";

  const header = document.createElement("div");
  header.className = "gs-panel-header";
  const heading = document.createElement("div");
  heading.className = "gs-panel-heading";
  const title = document.createElement("div");
  title.className = "gs-panel-title";
  title.textContent = "Win Chart";
  heading.appendChild(title);
  const sub = document.createElement("div");
  sub.className = "gs-panel-sub";
  sub.textContent = "Cumulative wins at this table, game by game.";
  heading.appendChild(sub);
  header.appendChild(heading);
  wrap.appendChild(header);

  const points = computeWinChart(games, gameType, playerIds);
  if (points.length === 0) {
    const empty = document.createElement("div");
    empty.className = "gs-empty";
    empty.textContent = "No completed games at this table yet.";
    wrap.appendChild(empty);
    return { element: wrap, draw: () => {} };
  }

  const winChartSeries = playerIds.map((id) => ({
    name: playerName(id),
    values: points.map((p) => p.cumulativeWins[id]),
  }));
  const winChartXLabels = points.map((p) => String(p.gameNumber));

  const expandBtn = document.createElement("button");
  expandBtn.type = "button";
  expandBtn.className = "gs-chart-expand-btn";
  expandBtn.title = "Expand chart";
  expandBtn.textContent = "⤢";
  expandBtn.addEventListener("click", () => {
    openChartExpand({ title: "Win Chart", series: winChartSeries, xLabels: winChartXLabels });
  });
  header.appendChild(expandBtn);

  const canvas = document.createElement("canvas");
  canvas.className = "gs-chart-canvas";
  wrap.appendChild(canvas);

  const tableWrap = document.createElement("div");
  tableWrap.className = "gs-stats-table-wrap";
  const table = document.createElement("table");
  table.className = "gs-stats-table";

  const thead = document.createElement("thead");
  const nameRow = document.createElement("tr");
  const corner = document.createElement("th");
  corner.rowSpan = 2;
  corner.textContent = "Game";
  nameRow.appendChild(corner);
  playerIds.forEach((id) => {
    const th = document.createElement("th");
    th.colSpan = 2;
    th.className = "gs-col-start";
    th.textContent = playerName(id);
    nameRow.appendChild(th);
  });
  thead.appendChild(nameRow);

  const subRow = document.createElement("tr");
  playerIds.forEach(() => {
    const wonTh = document.createElement("th");
    wonTh.className = "gs-subheader gs-col-start";
    wonTh.textContent = "Won";
    subRow.appendChild(wonTh);
    const totalTh = document.createElement("th");
    totalTh.className = "gs-subheader";
    totalTh.textContent = "Total";
    subRow.appendChild(totalTh);
  });
  thead.appendChild(subRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  points.forEach((point) => {
    const tr = document.createElement("tr");
    const labelTd = document.createElement("td");
    labelTd.className = "gs-stats-row-label";
    labelTd.textContent = String(point.gameNumber);
    tr.appendChild(labelTd);
    playerIds.forEach((id) => {
      const wonTd = document.createElement("td");
      wonTd.className = "gs-col-start";
      if (point.wonThisGame[id]) {
        wonTd.textContent = "✓";
        wonTd.classList.add("gs-winner-cell");
      }
      tr.appendChild(wonTd);
      const totalTd = document.createElement("td");
      totalTd.className = "gs-round-total-cell";
      totalTd.textContent = String(point.cumulativeWins[id]);
      tr.appendChild(totalTd);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  tableWrap.appendChild(table);
  wrap.appendChild(tableWrap);

  const draw = () => drawLineChart(canvas, winChartSeries, winChartXLabels);
  return { element: wrap, draw };
}

/* =============================================================================
   MODAL: STAT DETAIL
============================================================================= */

let gsStatDetailModal: Modal | null = null;
const GS_DETAIL_PAGE_SIZE = 10;
let gsStatDetailRows: StatDetailRow[] = [];
// -1 means "show all", reached by paging right past the last numbered page.
let gsStatDetailPage = 0;

function getStatDetailModal(): Modal {
  if (!gsStatDetailModal) {
    gsStatDetailModal = new Modal(document.getElementById("gsStatDetailBackdrop")!, { closeOnEsc: true });
  }
  return gsStatDetailModal;
}

function renderStatDetailPage(): void {
  const body = document.getElementById("gsStatDetailBody")!;
  body.innerHTML = "";

  if (gsStatDetailRows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "gs-empty";
    empty.textContent = "No data yet.";
    body.appendChild(empty);
  } else {
    const showAll = gsStatDetailPage < 0;
    const startIndex = showAll ? 0 : gsStatDetailPage * GS_DETAIL_PAGE_SIZE;
    const pageRows = showAll
      ? gsStatDetailRows
      : gsStatDetailRows.slice(startIndex, startIndex + GS_DETAIL_PAGE_SIZE);

    const table = document.createElement("table");
    table.className = "gs-stats-table";

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    ["#", "Value", "Game"].forEach((text) => {
      const th = document.createElement("th");
      th.textContent = text;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    pageRows.forEach((row, i) => {
      const tr = document.createElement("tr");
      const rankTd = document.createElement("td");
      rankTd.className = "gs-stats-row-label gs-stat-detail-rank";
      rankTd.textContent = String(startIndex + i + 1);
      tr.appendChild(rankTd);
      const valueTd = document.createElement("td");
      valueTd.textContent = row.value;
      tr.appendChild(valueTd);
      const gameTd = document.createElement("td");
      gameTd.className = "gs-stats-game-cell";
      gameTd.textContent = row.gameRef;
      tr.appendChild(gameTd);

      // The row names a game, so make it openable. Same double-click gesture
      // that got you into this modal from the comparison table.
      const target = row.gameId ? games.find((g) => g.id === row.gameId) : undefined;
      if (target) {
        tr.classList.add("gs-stat-detail-row-link");
        tr.title = `Double-click to open ${gameLabel(target)}`;
        tr.addEventListener("dblclick", () => {
          getStatDetailModal().close();
          openGameFromStats(target);
        });
      }
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    body.appendChild(table);
  }

  const totalPages = Math.ceil(gsStatDetailRows.length / GS_DETAIL_PAGE_SIZE);
  const pager = document.getElementById("gsStatDetailPager")!;
  if (totalPages <= 1) {
    pager.style.display = "none";
    return;
  }
  pager.style.display = "";
  const label = document.getElementById("gsStatDetailPageLabel")!;
  label.textContent =
    gsStatDetailPage < 0 ? `All (${gsStatDetailRows.length})` : `Page ${gsStatDetailPage + 1} of ${totalPages}`;
  label.title = "Click to jump to a page";
  (document.getElementById("gsStatDetailPrevBtn") as HTMLButtonElement).disabled = gsStatDetailPage === 0;
  (document.getElementById("gsStatDetailNextBtn") as HTMLButtonElement).disabled = gsStatDetailPage < 0;
}

/** Swaps the page label for a number input so a long list can be jumped
 *  through instead of clicked one page at a time. */
function beginStatDetailPageJump(): void {
  const totalPages = Math.ceil(gsStatDetailRows.length / GS_DETAIL_PAGE_SIZE);
  if (totalPages <= 1) return;
  const label = document.getElementById("gsStatDetailPageLabel")!;
  const input = document.getElementById("gsStatDetailPageInput") as HTMLInputElement;
  input.max = String(totalPages);
  input.value = gsStatDetailPage < 0 ? "" : String(gsStatDetailPage + 1);
  label.style.display = "none";
  input.style.display = "";
  input.focus();
  input.select();
}

function commitStatDetailPageJump(cancelled = false): void {
  const input = document.getElementById("gsStatDetailPageInput") as HTMLInputElement;
  const raw = input.value.trim();
  input.style.display = "none";
  document.getElementById("gsStatDetailPageLabel")!.style.display = "";
  if (cancelled || !raw) return;

  const totalPages = Math.ceil(gsStatDetailRows.length / GS_DETAIL_PAGE_SIZE);
  const page = Number(raw);
  if (!Number.isInteger(page) || page < 1 || page > totalPages) {
    flash(`Enter a page between 1 and ${totalPages}`, "error");
    return;
  }
  gsStatDetailPage = page - 1;
  renderStatDetailPage();
}

/** Leaves Stats for a game's detail view. Unlike opening one from Historical
 *  this DOES clear the stats selection on the way out, you're leaving the
 *  view proper, and Back from the game returns to Historical where the game
 *  actually lives. */
/** Opening a game from a stat detail is a detour, not an exit, so the Stats
 *  selections are deliberately NOT cleared, and Back returns to Stats with
 *  the same table (or compared profiles) still chosen. Only a real exit from
 *  Stats resets them; see leaveGsView(). */
function openGameFromStats(game: GameInstance): void {
  openGameForView(game, { returnView: "stats" });
}

function openStatDetailModal(title: string, rows: StatDetailRow[]): void {
  document.getElementById("gsStatDetailTitle")!.textContent = title;
  gsStatDetailRows = rows;
  gsStatDetailPage = 0;
  renderStatDetailPage();
  getStatDetailModal().open();
}

/**
 * Repaints every surface whose text is derived from profile or table names,
 * for after any edit that changes them, a profile rename/retire/delete, a
 * table rename, or a seat reorder.
 *
 * Each of these views renders once on arrival rather than re-deriving on
 * every change elsewhere, which is the right default (they're rebuilt from
 * `games` on entry, so they can't drift on their own) but leaves them stale
 * when a name changes underneath them. Without this the edit stays invisible
 * until you leave the view and come back.
 *
 * The wide net is deliberate: table LABELS are auto-generated from their
 * players' names (autoTableLabel), so renaming one person re-labels every
 * table they're in, which reaches the Historical filters, the Stats table
 * picker, the New Game "fill from table" list, and the game carousel, not
 * just the obvious player-name spots. The datalist matters most of all: a
 * stale suggestion there gets a renamed player retyped as a brand new
 * duplicate profile rather than matched to the existing one.
 *
 * Safe to call regardless of which view is on screen. Every one of these
 * no-ops or writes into a hidden container when its view isn't active, all
 * of them preserve any current dropdown selection, and the game-detail pair
 * is guarded on there actually being a draft loaded.
 */
function refreshGsNameDependentUI(): void {
  renderHomeDashboard();

  // The Setup modal re-renders these on open anyway, so this is belt-and-
  // braces for an edit made while it's already showing, and the Tables list
  // needs it regardless, since its rows are labelled from player names.
  renderProfilesList();
  renderTablesList();

  renderHistoricalList();
  refreshHistoricalFilterOptions();

  // Both option lists feed what refreshStatsView() then renders against, so
  // they're rebuilt first.
  refreshStatsTableOptions();
  refreshStatsProfileSelectOptions();
  refreshStatsView();

  refreshProfileDatalist();
  refreshFillFromTableOptions();
  refreshGameNumberHint();

  if (newGameDraft) {
    // Covers the grid's player-column headers, the scoreboard, the badges and
    // the progress chart's series names; the carousel adds the game's table
    // label. renderGameHeader() is deliberately NOT used here. It also
    // rewrites the date input, which has nothing to do with names.
    renderRoundGrid();
    renderGameCarousel();
  }
}

function refreshStatsView(): void {
  if (gsStatsMode === "profile") {
    const container = document.getElementById("gsStatsProfileSelects")!;
    const selects = Array.from(container.querySelectorAll("select")) as HTMLSelectElement[];
    const ids = selects.map((s) => s.value).filter((v): v is string => !!v);
    renderProfileCompare(ids);
  } else {
    renderTableStats();
  }
}

function activateGsStatsMode(mode: GsStatsMode): void {
  gsStatsMode = mode;
  document.querySelectorAll<HTMLButtonElement>("#gsViewStats [data-gs-mode]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.gsMode === mode);
  });
  document.getElementById("gsStatsProfileControls")!.style.display = mode === "profile" ? "" : "none";
  document.getElementById("gsStatsTableControls")!.style.display = mode === "table" ? "" : "none";
  refreshStatsView();
}

/** Called the moment you leave Stats (see showGsView), resets back to
 *  Profile mode with a single blank picker and no table chosen, so coming
 *  back later doesn't show a leftover table selection with nothing
 *  rendered under it, or a stale set of compared profiles. */
function resetStatsSelections(): void {
  (document.getElementById("gsStatsTableSelect") as HTMLSelectElement).value = "";
  // Table Stats always reopens on its main face rather than mid-flip.
  gsTableStatsFace = "main";
  resetStatsProfileSelects();
  activateGsStatsMode("profile");
}

/**
 * Who can still be added to a comparison, given who's already picked.
 *
 * Comparing players who've never sat at the same table is meaningless. Their
 * numbers come from different opponents, different score variance, and in
 * general a different game entirely. So candidates are drawn only from tables
 * that contain EVERY already-selected player: pick S from tables A/B/S and
 * T/V/S and you can still add A, B, T or V; add V and only T remains, since
 * T/V/S is now the only table containing both.
 *
 * With nothing picked yet, anyone who's played this game is fair game.
 */
function eligibleCompareIds(selected: string[]): Set<string> {
  const eligible = new Set<string>();
  listAllTables(gsStatsGameType).forEach((table) => {
    if (!selected.every((id) => table.playerIds.includes(id))) return;
    table.playerIds.forEach((id) => eligible.add(id));
  });
  return eligible;
}

/** (Re)builds a profile <select>'s option list, preserving its selection if
 *  that profile is still a valid choice. `excludeIds` hides profiles already
 *  picked in one of the OTHER compare dropdowns (no comparing someone with
 *  themselves); `allowIds` is the shared-table narrowing above. */
function populateProfileOptions(
  select: HTMLSelectElement,
  excludeIds: Set<string> = new Set(),
  allowIds?: Set<string>,
): void {
  const current = select.value;
  select.innerHTML = "";
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = "Select a profile";
  select.appendChild(blank);
  [...profiles]
    .filter((p) => p.id === current || (!excludeIds.has(p.id) && (!allowIds || allowIds.has(p.id))))
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((p) => {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name + (p.status === "retired" ? " (Retired)" : "");
      select.appendChild(opt);
    });
  select.value = [...select.options].some((o) => o.value === current) ? current : "";
}

/** Refreshes every compare select's option list, to pick up profile renames,
 *  to re-apply the "hide already picked elsewhere" exclusion, and to re-narrow
 *  each dropdown to players who share a table with everything picked in the
 *  others. */
function refreshStatsProfileSelectOptions(): void {
  const selects = Array.from(
    document.querySelectorAll<HTMLSelectElement>("#gsStatsProfileSelects select"),
  );
  const allPicked = selects.map((s) => s.value).filter(Boolean);
  selects.forEach((select) => {
    const others = allPicked.filter((id) => id !== select.value);
    const exclude = new Set(others);
    populateProfileOptions(select, exclude, eligibleCompareIds(others));
  });
  refreshStatsCompareHint();
  // The + Compare button is pointless once nobody new could be added.
  refreshStatsProfileSelectsState();
}

/** Explains the narrowing when it's actually biting, so a missing name reads
 *  as a rule rather than a bug. */
function refreshStatsCompareHint(): void {
  const hint = document.getElementById("gsStatsCompareHint");
  if (!hint) return;
  const picked = Array.from(
    document.querySelectorAll<HTMLSelectElement>("#gsStatsProfileSelects select"),
  ).map((s) => s.value).filter(Boolean);

  if (picked.length === 0) {
    hint.textContent = "";
    return;
  }
  const remaining = [...eligibleCompareIds(picked)].filter((id) => !picked.includes(id));
  hint.textContent = remaining.length
    ? `Can also compare: ${remaining.map(playerName).sort((a, b) => a.localeCompare(b)).join(", ")}.`
    : "No one else has shared a table with this selection.";
}

function buildProfileSelect(): HTMLSelectElement {
  const select = document.createElement("select");
  select.className = "gs-stats-profile-select";
  populateProfileOptions(select);
  select.addEventListener("change", () => {
    refreshStatsProfileSelectOptions();
    refreshStatsView();
  });
  return select;
}

function refreshStatsProfileSelectsState(): void {
  const container = document.getElementById("gsStatsProfileSelects")!;
  const addBtn = document.getElementById("gsStatsAddCompareBtn") as HTMLButtonElement;
  const picked = Array.from(container.querySelectorAll<HTMLSelectElement>("select"))
    .map((s) => s.value)
    .filter(Boolean);
  // Hide + Compare at the cap, and also once no eligible player is left to
  // add, an extra empty dropdown with nothing valid in it is just clutter.
  const noneLeft =
    picked.length > 0 && [...eligibleCompareIds(picked)].every((id) => picked.includes(id));
  addBtn.style.display =
    container.children.length >= GS_MAX_COMPARE || noneLeft ? "none" : "";
}

function buildProfileSelectRow(removable: boolean): HTMLElement {
  const row = document.createElement("div");
  row.className = "gs-stats-profile-select-row";
  row.appendChild(buildProfileSelect());

  if (removable) {
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "gs-player-remove-btn";
    removeBtn.title = "Remove from comparison";
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", () => {
      const container = document.getElementById("gsStatsProfileSelects")!;
      if (container.children.length <= 1) return;
      row.remove();
      refreshStatsProfileSelectsState();
      refreshStatsProfileSelectOptions();
      refreshStatsView();
    });
    row.appendChild(removeBtn);
  }
  return row;
}

function addStatsProfileSelect(): void {
  const container = document.getElementById("gsStatsProfileSelects")!;
  if (container.children.length >= GS_MAX_COMPARE) return;
  container.appendChild(buildProfileSelectRow(true));
  refreshStatsProfileSelectsState();
  refreshStatsProfileSelectOptions();
}

function resetStatsProfileSelects(): void {
  const container = document.getElementById("gsStatsProfileSelects")!;
  container.innerHTML = "";
  container.appendChild(buildProfileSelectRow(false));
  refreshStatsProfileSelectsState();
}

/* =============================================================================
   INIT
============================================================================= */

function applyGsPreferenceLabels(): void {
  const requireDateToggle = document.getElementById("gsRequireDateToggle") as HTMLInputElement;
  requireDateToggle.checked = settings.requireDate;
  document.getElementById("gsRequireDateLabel")!.textContent = settings.requireDate ? "On" : "Off";

  const autoOvertimeToggle = document.getElementById("gsAutoOvertimeToggle") as HTMLInputElement;
  autoOvertimeToggle.checked = settings.autoOvertime;
  document.getElementById("gsAutoOvertimeLabel")!.textContent = settings.autoOvertime ? "On" : "Off";

  refreshGsImportStatusUI();
}

export function initGameStats(): void {
  setSubNavHandler({ back: gsSubNavBack, forward: gsSubNavForward });

  document.getElementById("gsSetupBtn")!.addEventListener("click", () => openGsSetupOnTab());
  document.getElementById("gsProfileNewBtn")!.addEventListener("click", openProfileAdd);

  document.getElementById("gsRequireDateToggle")!.addEventListener("change", (e) => {
    settings.requireDate = (e.target as HTMLInputElement).checked;
    document.getElementById("gsRequireDateLabel")!.textContent = settings.requireDate ? "On" : "Off";
    saveToDisk();
  });
  document.getElementById("gsAutoOvertimeToggle")!.addEventListener("change", (e) => {
    settings.autoOvertime = (e.target as HTMLInputElement).checked;
    document.getElementById("gsAutoOvertimeLabel")!.textContent = settings.autoOvertime ? "On" : "Off";
    saveToDisk();
  });

  document.getElementById("gsNavPlayersBtn")!.addEventListener("click", () => openGsSetupOnTab("profiles"));
  document.getElementById("gsNavTablesBtn")!.addEventListener("click", () => openGsSetupOnTab("tables"));

  document.getElementById("gsNavNewGameBtn")!.addEventListener("click", () => {
    // Deliberately a real exit from wherever you were, so Historical/Stats
    // selections are cleared, unlike opening a game, which is a sub-view.
    leaveGsView(currentGsView);
    resetNewGameSetup();
    showGsView("new-game");
  });
  const openHistorical = () => {
    leaveGsView(currentGsView);
    gsHistoricalHasSelection = false;
    refreshHistoricalFilterOptions();
    renderHistoricalList();
    showGsView("historical");
  };
  document.getElementById("gsNavHistoricalBtn")!.addEventListener("click", openHistorical);
  document.getElementById("gsHistGameTypeSelect")!.addEventListener("change", (e) => {
    gsHistGameType = (e.target as HTMLSelectElement).value as GameType;
    // Tables and players are per game type, so both pickers are rebuilt and
    // the selection starts over rather than pointing at another game's table.
    gsHistoricalHasSelection = false;
    refreshHistoricalFilterOptions();
    renderHistoricalList();
  });
  document.getElementById("gsHistoricalFilter")!.addEventListener("change", () => {
    gsHistoricalHasSelection = true;
    renderHistoricalList();
  });
  document.getElementById("gsHistoricalTableFilter")!.addEventListener("change", () => {
    gsHistoricalHasSelection = true;
    renderHistoricalList();
  });
  document.getElementById("gsHistoricalShowAllBtn")!.addEventListener("click", () => {
    gsHistoricalHasSelection = true;
    (document.getElementById("gsHistoricalFilter") as HTMLSelectElement).value = "";
    (document.getElementById("gsHistoricalTableFilter") as HTMLSelectElement).value = "";
    renderHistoricalList();
  });
  document.querySelectorAll<HTMLButtonElement>("#gsViewHistorical [data-gs-hist-filter-mode]").forEach((btn) => {
    btn.addEventListener("click", () => activateGsHistFilterMode(btn.dataset.gsHistFilterMode as GsHistFilterMode));
  });
  document.getElementById("gsHistLayoutBtn")!.addEventListener("click", () => {
    activateGsHistLayout(gsHistLayout === "list" ? "cards" : "list");
  });
  // Seeds the toggle's tooltip/aria-label for the default (list) layout.
  activateGsHistLayout(gsHistLayout);
  document.getElementById("gsNavStatsBtn")!.addEventListener("click", () => {
    leaveGsView(currentGsView);
    refreshStatsProfileSelectOptions();
    refreshStatsTableOptions();
    // Show the view before rendering, chart drawing reads canvas.clientWidth,
    // which is 0 while any ancestor is still display:none.
    showGsView("stats");
    refreshStatsView();
  });
  document.getElementById("gsStatsGameTypeSelect")!.addEventListener("change", (e) => {
    gsStatsGameType = (e.target as HTMLSelectElement).value as GameType;
    resetStatsProfileSelects();
    refreshStatsProfileSelectOptions();
    refreshStatsTableOptions();
    refreshStatsView();
  });
  document.querySelectorAll<HTMLButtonElement>("[data-gs-back]").forEach((btn) => {
    // The game detail view's Back retraces the chain of games you walked
    // through (carousel / jump-to-number) before returning to the list it
    // started from. The static data-gs-back attribute only covers the
    // simple "always goes Home" case for the other views.
    const isNewGameBack = btn.closest("#gsViewNewGame") != null;
    btn.addEventListener("click", () => {
      if (isNewGameBack) {
        if (gsGameMode === "create") { cancelNewGame(); return; }
        gameDetailBack();
        return;
      }
      const target = btn.dataset.gsBack as GsView;
      leaveGsView(currentGsView);
      showGsView(target);
    });
  });

  document.getElementById("gsAddPlayerBtn")!.addEventListener("click", addPlayerPickerRow);
  document.getElementById("gsClearPlayersBtn")!.addEventListener("click", clearPlayerPickers);
  document.getElementById("gsImportBtn")!.addEventListener("click", openGsImportModal);
  document.getElementById("gsNewGameTypeSelect")!.addEventListener("change", (e) => {
    gsNewGameType = (e.target as HTMLSelectElement).value as GameType;
    refreshFillFromTableOptions();
    (document.getElementById("gsFillFromTableSelect") as HTMLSelectElement).value = "";
    refreshSuggestedGameNumber();
  });
  document.getElementById("gsFillFromTableSelect")!.addEventListener("change", (e) => {
    applyFillFromTable((e.target as HTMLSelectElement).value);
  });
  document.getElementById("gsGameNumberLockBtn")!.addEventListener("click", () => {
    setGameNumberUnlocked(!gsGameNumberUnlocked);
  });
  document.getElementById("gsGameNumberInput")!.addEventListener("input", refreshGameNumberHint);
  document.getElementById("gsStartGameBtn")!.addEventListener("click", startNewGame);
  document.getElementById("gsEditPlayersBtn")!.addEventListener("click", resetNewGameSetup);
  document.getElementById("gsGameDateEdit")!.addEventListener("change", (e) => {
    if (!newGameDraft) return;
    const val = (e.target as HTMLInputElement).value;
    newGameDraft.date = val || (settings.requireDate ? gsToday() : "");
    (e.target as HTMLInputElement).value = newGameDraft.date;
  });
  document.getElementById("gsGameDateNowBtn")!.addEventListener("click", () => {
    if (!newGameDraft) return;
    newGameDraft.date = gsToday();
    (document.getElementById("gsGameDateEdit") as HTMLInputElement).value = newGameDraft.date;
  });
  document.getElementById("gsViewEditBtn")!.addEventListener("click", enterEditMode);
  document.getElementById("gsViewSaveBtn")!.addEventListener("click", saveGameChanges);
  document.getElementById("gsViewDiscardBtn")!.addEventListener("click", discardGameChanges);
  document.getElementById("gsSaveGameBtn")!.addEventListener("click", saveNewGame);
  document.getElementById("gsCancelGameBtn")!.addEventListener("click", cancelNewGame);
  document.getElementById("gsDeleteGameBtn")!.addEventListener("click", () => {
    if (!newGameDraft || !editingGameId) return;
    openGameDelete(editingGameId, `${gameLabel(newGameDraft)} at ${tableLabelForKey(tableKeyOf(newGameDraft))}`);
  });
  document.getElementById("gsProgressChartExpandBtn")!.addEventListener("click", openProgressChartExpand);
  wireRoundGridEvents();

  document.getElementById("gsGameCarouselPrevBtn")!.addEventListener("click", () => {
    if (!newGameDraft) return;
    const prev = adjacentGame(newGameDraft, -1);
    if (prev) jumpToGame(prev);
  });
  document.getElementById("gsGameCarouselNextBtn")!.addEventListener("click", () => {
    if (!newGameDraft) return;
    const next = adjacentGame(newGameDraft, 1);
    if (next) jumpToGame(next);
  });
  document.getElementById("gsGameCarouselLabel")!.addEventListener("dblclick", beginGameIdEdit);
  const gsGameCarouselInput = document.getElementById("gsGameCarouselInput") as HTMLInputElement;
  gsGameCarouselInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); gsGameCarouselInput.blur(); }
    else if (e.key === "Escape") { e.preventDefault(); gsGameIdEditCancelled = true; gsGameCarouselInput.blur(); }
  });
  gsGameCarouselInput.addEventListener("blur", commitGameIdEdit);

  document.querySelectorAll<HTMLButtonElement>("#gsViewStats [data-gs-mode]").forEach((btn) => {
    btn.addEventListener("click", () => activateGsStatsMode(btn.dataset.gsMode as GsStatsMode));
  });
  document.getElementById("gsStatsAddCompareBtn")!.addEventListener("click", addStatsProfileSelect);
  document.getElementById("gsStatsTableSelect")!.addEventListener("change", renderTableStats);
  document.getElementById("gsWinChartToggleBtn")!.addEventListener("click", toggleTableStatsFace);
  resetStatsProfileSelects();

  document.getElementById("gsStatDetailPrevBtn")!.addEventListener("click", () => {
    if (gsStatDetailPage < 0) {
      gsStatDetailPage = Math.ceil(gsStatDetailRows.length / GS_DETAIL_PAGE_SIZE) - 1;
    } else if (gsStatDetailPage > 0) {
      gsStatDetailPage--;
    }
    renderStatDetailPage();
  });
  document.getElementById("gsStatDetailNextBtn")!.addEventListener("click", () => {
    if (gsStatDetailPage < 0) return;
    const totalPages = Math.ceil(gsStatDetailRows.length / GS_DETAIL_PAGE_SIZE);
    gsStatDetailPage = gsStatDetailPage < totalPages - 1 ? gsStatDetailPage + 1 : -1;
    renderStatDetailPage();
  });
  document.getElementById("gsStatDetailPageLabel")!.addEventListener("click", beginStatDetailPageJump);
  const gsPageInput = document.getElementById("gsStatDetailPageInput") as HTMLInputElement;
  gsPageInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commitStatDetailPageJump(); }
    else if (e.key === "Escape") { e.preventDefault(); commitStatDetailPageJump(true); }
  });
  gsPageInput.addEventListener("blur", () => commitStatDetailPageJump());

  // Chart colours are read from CSS custom properties at draw time (see
  // gsChartPalette), so a theme swap leaves every already-painted canvas in
  // the old palette until it's redrawn. Same approach as Budget Tracker:
  // defer one frame so the browser has committed the new custom properties to
  // computed styles before gsCssVar() reads them back, then repaint whichever
  // canvases are actually on screen, a canvas inside a display:none ancestor
  // has clientWidth 0 and would repaint blank.
  window.addEventListener("themechange", () => {
    requestAnimationFrame(() => {
      if (currentGsView === "new-game" && newGameDraft) drawProgressChart();
      if (
        currentGsView === "stats" &&
        gsStatsMode === "table" &&
        gsTableStatsFace === "winchart"
      ) {
        gsWinChartDraw?.();
      }
      if (gsChartExpandModal?.isOpen) drawExpandedChart();
    });
  });

  fillGameTypeSelect(document.getElementById("gsNewGameTypeSelect") as HTMLSelectElement, gsNewGameType);
  fillGameTypeSelect(document.getElementById("gsHistGameTypeSelect") as HTMLSelectElement, gsHistGameType);
  fillGameTypeSelect(document.getElementById("gsStatsGameTypeSelect") as HTMLSelectElement, gsStatsGameType);

  loadFromDisk().then(() => {
    renderProfilesList();
    renderTablesList();
    refreshProfileDatalist();
    applyGsPreferenceLabels();
    renderHomeDashboard();
  });
}

/** Called by shell.ts whenever the Game Stats tool is opened. Leaving for
 *  another tool and coming back is a fresh start, so any Historical/Stats
 *  selection is cleared, matching what the nav buttons do within the tool. */
export function onGameStatsToolEntry(): void {
  resetHistoricalFilters();
  resetStatsSelections();
}

/** Called by shell.ts only when the user explicitly clicks the Game Stats
 *  sidebar icon or Home tile (never on mouse back/forward history replay,
 *  which calls onGameStatsToolEntry() directly), jumps to the tile view,
 *  even from deep inside a game. Goes through showGsView() rather than a
 *  direct currentGsView assignment so the jump is recorded in Game Stats'
 *  own sub-nav history stack: the mouse back button then returns to
 *  whatever view this interrupted, same as any other in-tool navigation,
 *  rather than orphaning it. */
export function onGameStatsIconClicked(): void {
  showGsView("home");
}
