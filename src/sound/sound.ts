/* =============================================================================
   SOUND: every cue the app plays, and the Audio tab that configures them
   -----------------------------------------------------------------------------
   Three kinds of cue live here, each with its own sound and its own volume:

     notifications  a success/error pair from the selected pack, played by
                    flash(). Packs are hand-written in shell.ts's SOUND_PACKS
                    and chosen in the Choose Notification Sound Pack modal.
     button presses  one cue, played by a delegated click listener in shell.ts.
     modal opens     one cue, played from the global modal open hook.

   The latter two are picked from whatever files are in
   public/sounds/button-sounds/ and public/sounds/modal-sounds/, listed for us
   in the generated sound-manifest.ts, each in its own picker modal. Both
   default to None, so an install that never opens the Audio tab sounds exactly
   as it always did.

   A fourth folder, public/sounds/timer-sounds/, holds no app cue at all. It is
   there for the Countdown Timer's alarm, which picks from every one of these
   sources through getSoundOptions() below.

   When two of these would sound at the same instant, the CUE PRIORITY GATE
   further down decides which one is actually heard.

   The Audio tab itself is only three rows now, one Customize button per cue.
   Each cue's sound and its volume are set together in that cue's picker,
   because a level only means anything next to the sound it applies to.

   Split out of shell.ts, where this feature was spread across three separate
   places with unrelated code between them: the pack picker and the tool-facing
   API in one block, the active <audio> elements and cue-volume plumbing in
   another, with the reminder modals and toast display in between. Anyone
   changing "how loud a cue is" previously had to know all three.

   Circular with shell.ts (it needs playback and SOUND_PACKS, this needs
   settings and flash). Safe because nothing here reads an imported value while
   the file loads; scripts/checks/module-init.test.mjs enforces that.
============================================================================= */

import { Modal } from "../modal/modal";
import {
  BUTTON_SOUNDS,
  MODAL_SOUNDS,
  TIMER_SOUNDS,
  type SoundEffect,
  findSoundEffect,
} from "./sound-manifest";
import {
  SOUND_PACKS,
  type SoundPack,
  currentSoundPackId,
  flash,
  saveSettings,
  settings,
  settingsModal,
  openSettingsOnTab,
} from "../core/shell";

/* Element refs used only by this feature, moved here with it. */
const soundPackEditBtn = document.getElementById("soundPackEditBtn")!;
const soundPackCurrentBadge = document.getElementById("soundPackCurrentBadge")!;
const soundPackPickerBackdrop = document.getElementById("soundPackPickerBackdrop")!;
const soundPackPickerBack = document.getElementById("soundPackPickerBack")!;
const soundPackPickerClose = document.getElementById("soundPackPickerClose")!;
const soundPackPickerGrid = document.getElementById("soundPackPickerGrid")!;

/* =============================================================================
   CHOOSE SOUND PACK MODAL
   -----------------------------------------------------------------------------
   Tile cards, same modal-replaces-Settings pattern as Sidebar/Theme. Unlike
   Theme's tiles, these don't preview a different palette, a sound pack has
   no visuals of its own, so the cards just render in the app's own current
   theme. Each card has two icon buttons that play that pack's success/error
   cue directly (independent of the currently *active* pack, and without
   selecting it), selecting the pack itself happens by clicking the tile.
============================================================================= */

const SPEAKER_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>`;

/* =============================================================================
   SOUND API FOR TOOLS
   -----------------------------------------------------------------------------
   Tools that need their own alert cue (Countdown Timer's timer-end alarm) pick
   from the sounds the app already ships rather than bundling audio of their
   own. Four sources are on offer: the notification packs, the button and modal
   cue folders, and timer-sounds/, which exists purely so the timer can have an
   alarm that is not doing double duty as a UI click.

   ID FORMAT, and why it looks like this. The original scheme was
   "<packId>:<kind>", with an empty pack id meaning "whichever pack the app is
   set to". Stored settings are full of those, so it still parses exactly as it
   did. The manifest-backed folders were added alongside it under three
   reserved head words:

     ""  / ":success" / ":error"     the app's current pack, resolved late
     "<packId>" / "<packId>:<kind>"  one specific pack, "" kind meaning success
     "timer:<cueId>"                 public/sounds/timer-sounds/
     "button:<cueId>"                public/sounds/button-sounds/
     "modal:<cueId>"                 public/sounds/modal-sounds/

   The three reserved words are matched BEFORE the pack list, so a pack could
   shadow one by taking that id. scripts/checks/settings.test.mjs asserts none
   ever does.
============================================================================= */

/** Reserved head words in a sound id, mapped to the manifest list each one
 *  names. Kept as one object so the resolver and the collision check in the
 *  test suite are reading from the same place. */
export const CUE_NAMESPACES = ["timer", "button", "modal"] as const;

function namespaceList(head: string): SoundEffect[] | null {
  if (head === "timer") return TIMER_SOUNDS;
  if (head === "button") return BUTTON_SOUNDS;
  if (head === "modal") return MODAL_SOUNDS;
  return null;
}

/** One optgroup's worth of choices. */
export interface SoundOptionGroup {
  label: string;
  options: { id: string; name: string }[];
}

/** Everything a tool can offer as an alert cue, grouped by where it comes
 *  from so a dropdown can render optgroups rather than one flat run of a
 *  hundred entries. Empty groups are omitted: a cue folder with nothing in it
 *  should not leave a labelled but empty heading in the list.
 *
 *  Timer Sounds come first, being purpose-built alarms. The group after them
 *  tracks whatever the app's sound pack is set to, rather than pinning a
 *  specific one, so changing the app's pack changes the tool's cue with it. */
export function getSoundOptions(): SoundOptionGroup[] {
  const packCues: { id: string; name: string }[] = [];
  SOUND_PACKS.forEach((p) => {
    packCues.push({ id: `${p.id}:success`, name: `${p.name}: Success` });
    packCues.push({ id: `${p.id}:error`, name: `${p.name}: Error` });
  });

  const fromManifest = (ns: string, list: SoundEffect[]): { id: string; name: string }[] =>
    list.map((s) => ({ id: `${ns}:${s.id}`, name: s.name }));

  return [
    // Timer sounds lead: they are the only ones written to BE an alarm, so
    // they are what someone opening this dropdown most likely wants.
    { label: "Timer Sounds", options: fromManifest("timer", TIMER_SOUNDS) },
    {
      label: "Current App Sound Pack",
      options: [
        { id: ":success", name: "Success" },
        { id: ":error", name: "Error" },
      ],
    },
    { label: "Notification Packs", options: packCues },
    { label: "Button Sounds", options: fromManifest("button", BUTTON_SOUNDS) },
    { label: "Modal Sounds", options: fromManifest("modal", MODAL_SOUNDS) },
  ].filter((group) => group.options.length > 0);
}

/** Resolves a stored sound id to a playable url, in any of the forms listed
 *  in this section's header. Returns null when whatever it names is no longer
 *  there (a pack removed, a cue file taken out of its folder) so callers
 *  degrade to silence rather than throwing or fetching a 404. */
export function resolveSoundUrl(soundId: string): string | null {
  const sep = soundId.indexOf(":");
  const head = sep === -1 ? soundId : soundId.slice(0, sep);
  const tail = sep === -1 ? "" : soundId.slice(sep + 1);

  const list = namespaceList(head);
  if (list) return findSoundEffect(list, tail)?.url ?? null;

  // Through the rename map, so an alarm cue stored against a pack's old id
  // keeps playing instead of falling silent.
  const pack = SOUND_PACKS.find((p) => p.id === currentSoundPackId(head || settings.soundPack));
  if (!pack) return null;
  return (tail === "error" ? pack.error : pack.success) ?? null;
}

/** Plays a cue once and resolves when it finishes (or immediately fails
 *  quiet). Resolving on `ended` is what lets a caller chain repeats without
 *  them overlapping into mush. */
export function playSoundUrl(url: string): Promise<void> {
  return new Promise((resolve) => {
    const audio = new Audio(url);
    const done = (): void => resolve();
    audio.addEventListener("ended", done, { once: true });
    audio.addEventListener("error", done, { once: true });
    audio.play().catch(done);
  });
}

export function refreshSoundPackCurrentBadge(): void {
  const pack = SOUND_PACKS.find((p) => p.id === settings.soundPack);
  soundPackCurrentBadge.textContent = pack ? pack.name : settings.soundPack;
}

/** Tracks whatever preview is currently playing so a new preview click can
 *  stop it. Without this, rapid clicks across tiles/buttons stack up and play
 *  over each other instead of replacing one another. Shared by all three
 *  pickers, though only one is ever open at a time. */
let _previewAudio: HTMLAudioElement | null = null;

/** Plays one specific sound directly, a standalone preview, not tied to the
 *  active elements that flash() and the cue hooks play through. `db` is the
 *  level of the category being previewed and defaults to the notification
 *  level. Only one preview ever plays at a time; starting a new one kills the
 *  last. A missing src (a pack that mutes a cue, the None tile) plays nothing. */
function previewSound(src: string | undefined, db?: number): void {
  if (!src) return;

  if (_previewAudio) {
    _previewAudio.pause();
    _previewAudio.currentTime = 0;
  }

  const audio = new Audio(src);
  _previewAudio = audio;
  audio.addEventListener("ended", () => {
    if (_previewAudio === audio) _previewAudio = null;
  });
  // Through playCue so a preview is heard at the volume the cue will actually
  // play at, which is the whole point of previewing it.
  playCue(audio, db);
}

/** Selects a sound pack. Same effect the old dropdown's "change" handler
 *  had: applies it, persists it, and flashes a success toast (which, using
 *  the newly-loaded pack, doubles as an audible confirmation). */
function selectSoundPack(id: string): void {
  settings.soundPack = id;
  loadSoundPack(settings.soundPack);
  saveSettings();
  refreshSoundPackCurrentBadge();
  renderSoundPackPickerGrid();
  flash("Sound pack updated", "success");
}

function buildSoundPackTile(pack: SoundPack): HTMLElement {
  const tile = document.createElement("div");
  tile.className = pack.id === settings.soundPack ? "sound-pack-tile active" : "sound-pack-tile";

  const name = document.createElement("span");
  name.className = "sound-pack-tile-name";
  name.textContent = pack.name;
  tile.appendChild(name);

  const actions = document.createElement("div");
  actions.className = "sound-pack-tile-actions";

  const successBtn = document.createElement("button");
  successBtn.className = "sound-pack-preview-btn success";
  successBtn.title = "Preview success sound";
  successBtn.innerHTML = SPEAKER_SVG;
  successBtn.disabled = !pack.success;
  successBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    previewSound(pack.success);
  });
  actions.appendChild(successBtn);

  const errorBtn = document.createElement("button");
  errorBtn.className = "sound-pack-preview-btn error";
  errorBtn.title = "Preview error sound";
  errorBtn.innerHTML = SPEAKER_SVG;
  errorBtn.disabled = !pack.error;
  errorBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    previewSound(pack.error);
  });
  actions.appendChild(errorBtn);

  tile.appendChild(actions);

  tile.addEventListener("click", () => selectSoundPack(pack.id));
  return tile;
}

function renderSoundPackPickerGrid(): void {
  soundPackPickerGrid.innerHTML = "";
  SOUND_PACKS.forEach((pack) => soundPackPickerGrid.appendChild(buildSoundPackTile(pack)));
}

const soundPackPickerModal = new Modal(soundPackPickerBackdrop, {
  closeOnEsc: true,
  onOpen: () => renderSoundPackPickerGrid(),
});

soundPackEditBtn.addEventListener("click", () => {
  settingsModal.close({ handoff: true });
  soundPackPickerModal.open();
});

// All three sound pickers are reached from Settings > Audio.
soundPackPickerBack.addEventListener("click", () => {
  soundPackPickerModal.close();
  openSettingsOnTab("audio");
});

soundPackPickerClose.addEventListener("click", () => soundPackPickerModal.close());

/* =============================================================================
   CHOOSE BUTTON SOUND / CHOOSE MODAL SOUND MODALS
   -----------------------------------------------------------------------------
   The picker above again, twice, for the cues that are a single sound rather
   than a success/error pair. One factory rather than two near-identical
   copies: the two differ only in which manifest list they show, which setting
   they write and which elements they are bolted to.

   The grid leads with a None tile, because silence is the default and has to
   stay reachable. A tile rather than a "clear" button so that switching a cue
   off is the same gesture as switching it on.

   A stored id whose file is not in THIS build lights no tile and reads
   "Unavailable" on the badge, but the setting itself is left alone. The
   folders are scanned at build time, so a cue can be absent from one build and
   back in the next; quietly rewriting the choice to None would make that
   unrecoverable.
============================================================================= */

interface CuePickerOptions {
  /** Element ids: the Audio tab's Customize button and its badge, then the
   *  modal's backdrop, its hint line, its two header buttons and its grid. */
  edit: string;
  badge: string;
  backdrop: string;
  hint: string;
  back: string;
  close: string;
  grid: string;
  /** Everything the manifest found in this cue's folder. */
  list: SoundEffect[];
  /** Folder name for the empty-state line, e.g. "button-sounds". */
  folder: string;
  get: () => string;
  set: (id: string) => void;
  /** The level this cue plays at, so a preview matches what a real one will
   *  sound like rather than the notification level. */
  db: () => number;
  /** Re-points the reused <audio> element after a selection. */
  reload: () => void;
}

function createCuePicker(opts: CuePickerOptions): { refreshBadge: () => void } {
  const editBtn = document.getElementById(opts.edit)!;
  const badge = document.getElementById(opts.badge)!;
  const backdrop = document.getElementById(opts.backdrop)!;
  const hint = document.getElementById(opts.hint)!;
  const closeBtn = document.getElementById(opts.close)!;
  const backBtn = document.getElementById(opts.back)!;
  const grid = document.getElementById(opts.grid)!;

  /* The markup's own wording, kept so the empty state can swap it out and put
     it back rather than the two copies drifting apart. */
  const defaultHint = hint.textContent ?? "";

  function refreshBadge(): void {
    const id = opts.get();
    if (!id) badge.textContent = "None";
    else badge.textContent = findSoundEffect(opts.list, id)?.name ?? "Unavailable";
  }

  /** One tile. `sound` is null for the None tile, which still carries a
   *  (disabled) preview button so it matches the height of the rest. */
  function buildTile(sound: SoundEffect | null): HTMLElement {
    const id = sound ? sound.id : "";
    const tile = document.createElement("div");
    tile.className = id === opts.get() ? "sound-pack-tile active" : "sound-pack-tile";

    const name = document.createElement("span");
    name.className = "sound-pack-tile-name";
    name.textContent = sound ? sound.name : "None";
    tile.appendChild(name);

    const actions = document.createElement("div");
    actions.className = "sound-pack-tile-actions";

    const previewBtn = document.createElement("button");
    previewBtn.className = "sound-pack-preview-btn neutral";
    previewBtn.title = sound ? `Preview ${sound.name}` : "Nothing to preview";
    previewBtn.innerHTML = SPEAKER_SVG;
    previewBtn.disabled = !sound;
    previewBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      previewSound(sound?.url, opts.db());
    });
    actions.appendChild(previewBtn);
    tile.appendChild(actions);

    tile.addEventListener("click", () => select(id));
    return tile;
  }

  function select(id: string): void {
    opts.set(id);
    opts.reload();
    void saveSettings();
    refreshBadge();
    render();
    // Playing the new choice is the confirmation, at the level it will
    // actually be heard at. None plays nothing, which is the right answer.
    previewSound(findSoundEffect(opts.list, id)?.url, opts.db());
  }

  function render(): void {
    hint.textContent =
      opts.list.length > 0
        ? defaultHint
        : `Nothing in the ${opts.folder} folder yet, so None is the only option.`;
    grid.innerHTML = "";
    grid.appendChild(buildTile(null));
    opts.list.forEach((sound) => grid.appendChild(buildTile(sound)));
  }

  const modal = new Modal(backdrop, { closeOnEsc: true, onOpen: () => render() });

  editBtn.addEventListener("click", () => {
    settingsModal.close({ handoff: true });
    modal.open();
  });

  backBtn.addEventListener("click", () => {
    modal.close();
    openSettingsOnTab("audio");
  });

  closeBtn.addEventListener("click", () => modal.close());

  return { refreshBadge };
}

/* =============================================================================
   CUE VOLUMES  (one at the foot of each sound picker)
   -----------------------------------------------------------------------------
   Three independent levels: notifications (the toast cues), button presses and
   modal opens. Each sits under the tile grid of the picker that chooses its
   sound. They share one slider implementation because the read-out wording,
   the mute notch, the Reset button and the double-click-to-type editor are
   identical for all three, and the alternative was that whole apparatus
   written out three times over.

   Persisting is debounced off the "change" event rather than "input", so
   dragging across the range writes settings once at the end instead of thirty
   times on the way. Each control previews its own sound on release so the
   level is judged by ear at the moment it is chosen.
============================================================================= */

interface VolumeControlOptions {
  /** Element ids for the slider, its read-out, and its Reset button. */
  slider: string;
  value: string;
  reset: string;
  /** Names the value in the inline editor's aria-label, e.g. "Button". */
  label: string;
  get: () => number;
  set: (db: number) => void;
  /** Plays whatever this control governs, at the level just chosen. */
  preview: () => void;
}

/** How the current value reads on screen. Three cases, because the two ends of
 *  the range aren't levels: the bottom notch is silence and the centre is the
 *  app's original loudness. */
function cueVolumeLabel(db: number): string {
  if (db <= CUE_VOLUME_MUTED_DB) return "Muted";
  if (db === 0) return "Default";
  return `${db > 0 ? "+" : ""}${db} dB`;
}

/** Wires one slider + read-out + Reset trio to one settings field. Returns the
 *  sync() that repaints it, which applyAudioSettings() calls so load,
 *  reset-to-defaults and reopening the modal all stay in step. */
function createVolumeControl(opts: VolumeControlOptions): { sync: () => void } {
  const slider = document.getElementById(opts.slider) as HTMLInputElement;
  const value = document.getElementById(opts.value)!;
  const reset = document.getElementById(opts.reset) as HTMLButtonElement;

  function sync(): void {
    const db = opts.get();
    slider.value = String(db);
    value.textContent = cueVolumeLabel(db);
    value.classList.toggle("is-muted", db <= CUE_VOLUME_MUTED_DB);
    reset.disabled = db === 0;
  }

  function commitValue(db: number): void {
    opts.set(db);
    sync();
    void saveSettings();
    opts.preview();
  }

  /* Live feedback while dragging: the read-out tracks the thumb, but nothing
     is written to disk until the drag ends. */
  slider.addEventListener("input", () => {
    opts.set(clampCueVolumeDb(Number(slider.value)));
    sync();
  });

  slider.addEventListener("change", () => {
    void saveSettings();
    opts.preview();
  });

  reset.addEventListener("click", () => commitValue(0));

  /** Double-click the read-out to type an exact dB value, matching the inline
   *  edits elsewhere in the app (Auto-Backup paths, Budget amounts, the
   *  Countdown clock): Enter or Tab commits, Escape cancels, blur commits.
   *
   *  Typing is the only way to hit a specific number on a 36-step slider
   *  without fighting the thumb, and "mute"/"muted"/"off" are accepted as words
   *  since the bottom notch has no number to type. */
  function beginEdit(): void {
    if (value.querySelector("input")) return; // already editing

    const original = opts.get();
    const input = document.createElement("input");
    input.type = "text";
    input.className = "sound-volume-edit";
    input.value = original <= CUE_VOLUME_MUTED_DB ? "muted" : String(original);
    input.setAttribute("aria-label", `${opts.label} volume in decibels`);

    value.textContent = "";
    value.appendChild(input);
    input.focus();
    input.select();

    let handledByKeydown = false;

    function commit(): void {
      const raw = input.value.trim().toLowerCase();
      if (raw === "muted" || raw === "mute" || raw === "off") {
        commitValue(CUE_VOLUME_MUTED_DB);
        return;
      }
      // "Default" is what the read-out shows at 0, so accept it back.
      if (raw === "default") {
        commitValue(0);
        return;
      }
      // Tolerates a typed "dB" suffix and a leading "+".
      const parsed = Number(raw.replace(/\s*db$/, "").replace(/^\+/, ""));
      if (!Number.isFinite(parsed)) {
        sync(); // put the old value back
        flash(
          `Enter a number between ${CUE_VOLUME_MIN_DB} and ${CUE_VOLUME_MAX_DB}, or "muted"`,
          "error",
        );
        return;
      }
      commitValue(clampCueVolumeDb(parsed));
    }

    input.addEventListener("keydown", (e) => {
      // The slider is a sibling control; stop arrow keys from reaching it.
      e.stopPropagation();
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        handledByKeydown = true;
        commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        handledByKeydown = true;
        sync();
      }
    });

    input.addEventListener("blur", () => {
      if (handledByKeydown) return;
      commit();
    });
  }

  value.addEventListener("dblclick", beginEdit);

  return { sync };
}

const toastVolumeControl = createVolumeControl({
  slider: "soundVolumeSlider",
  value: "soundVolumeValue",
  reset: "soundVolumeReset",
  label: "Notification",
  get: () => settings.toastVolumeDb,
  set: (db) => {
    settings.toastVolumeDb = db;
  },
  // Muted plays nothing, which is itself the correct preview.
  preview: () => {
    if (successAudio) playCue(successAudio);
  },
});

const buttonVolumeControl = createVolumeControl({
  slider: "buttonVolumeSlider",
  value: "buttonVolumeValue",
  reset: "buttonVolumeReset",
  label: "Button",
  get: () => settings.buttonVolumeDb,
  set: (db) => {
    settings.buttonVolumeDb = db;
  },
  preview: () => playButtonCueNow(),
});

const modalVolumeControl = createVolumeControl({
  slider: "modalVolumeSlider",
  value: "modalVolumeValue",
  reset: "modalVolumeReset",
  label: "Modal",
  get: () => settings.modalVolumeDb,
  set: (db) => {
    settings.modalVolumeDb = db;
  },
  preview: () => playModalCueNow(),
});

/* =============================================================================
   CUE PRIORITY GATE
   -----------------------------------------------------------------------------
   The problem this solves: most buttons in this app also do something that has
   a cue of its own. A click opens a modal, or flashes a toast, or both. Played
   as-is, two cues land on the same millisecond and arrive as mush rather than
   as two pieces of information.

   The rule: at most one cue per moment, and the most informative one wins.

     notification (3)  the outcome of what you did. Never suppressed.
     modal        (2)  a surface opened.
     button       (1)  "your click registered", the least informative of the
                       three and the one that gives way.

   Two mechanisms, because a collision can happen in either order:

   1. Everything is queued to the end of the current task instead of playing
      inline. A click handler runs start to finish in one task, so a modal open
      or a synchronous flash() lands in the same queue as the button cue that
      preceded it, and the lower rank is dropped before it is ever heard. The
      delay is one macrotask, a few milliseconds, well under the ~20ms where a
      cue starts to feel detached from the click that caused it.

   2. A short window after something plays, during which a STRICTLY lower rank
      is dropped. This catches the reverse order (the toast fires first, the
      modal opens a tick later) and the near-miss that a single task boundary
      cannot see. Strictly lower, so two toasts in a row still behave exactly
      as they always did; this gate is here to referee between categories, not
      to thin out repeats within one.

   What it deliberately does NOT do: suppress a cue that arrives well after the
   one before it. Roughly 15 of the app's flash() calls sit behind an await, so
   the toast lands 50-300ms after the click that started it. That reads as
   "click ... saved", which is action-then-result, two facts worth hearing.
   Collapsing it would delete information rather than tidy anything up.

   Previews bypass all of this: a speaker button in a picker, or a volume
   slider being released, must always make its sound, because judging it is the
   entire point of pressing it.
============================================================================= */

const CUE_RANK_BUTTON = 1;
const CUE_RANK_MODAL = 2;
const CUE_RANK_NOTIFICATION = 3;

/** How long after a cue a strictly lower-ranked one is considered to be
 *  landing "on top of" it. Long enough to cover a handler that awaits a
 *  resolved promise or two, short enough that a deliberate second action is
 *  never silently swallowed. */
const CUE_COLLISION_MS = 120;

let _lastCueRank = 0;
let _lastCueAt = -Infinity;
let _queuedRank = 0;
let _queuedTimer: ReturnType<typeof setTimeout> | null = null;

/** Queues one cue, subject to the two rules above. `play` runs on the next
 *  task if nothing better turns up between now and then. */
function requestCue(rank: number, play: () => void): void {
  const now = performance.now();

  // Rule 2: something more important played a moment ago.
  if (now - _lastCueAt < CUE_COLLISION_MS && _lastCueRank > rank) return;

  // Rule 1: something at least as important is already queued from this same
  // gesture. Equal ranks replace rather than stack, matching what the shared
  // <audio> element would have done anyway (a second play() restarts it).
  if (_queuedTimer !== null) {
    if (_queuedRank > rank) return;
    clearTimeout(_queuedTimer);
  }

  _queuedRank = rank;
  _queuedTimer = setTimeout(() => {
    _queuedTimer = null;
    _queuedRank = 0;
    _lastCueRank = rank;
    _lastCueAt = performance.now();
    play();
  }, 0);
}

/* =============================================================================
   UI CUES  (button presses and modal opens)
   -----------------------------------------------------------------------------
   Both are off by default, and both are chosen from whatever files happen to
   be in public/sounds/button-sounds/ and public/sounds/modal-sounds/ (see
   sound-manifest.ts, which a prebuild script regenerates from those folders).
   An empty folder is a normal state: the picker then offers None alone and
   says so.

   One reused <audio> element per category rather than a new one per press.
   Two reasons: rapid clicking restarts the same element instead of stacking
   dozens of overlapping voices, and the Web Audio boost path in playCue() may
   only wire a given element once, so a fresh element per click could never be
   boosted above unity.
============================================================================= */

let buttonAudio: HTMLAudioElement | null = null;
let modalAudio: HTMLAudioElement | null = null;

/** Points the two reused elements at whatever the settings currently name.
 *  Null for None, and null for an id whose file has left the folder, so a
 *  stale setting is silent rather than a failed fetch on every click. */
function loadUiCues(): void {
  const button = findSoundEffect(BUTTON_SOUNDS, settings.buttonSoundId);
  const modal = findSoundEffect(MODAL_SOUNDS, settings.modalSoundId);
  buttonAudio = button ? new Audio(button.url) : null;
  modalAudio = modal ? new Audio(modal.url) : null;
}

/* Straight to the element, no gate. The previews use these, because pressing
   a speaker button or releasing a volume slider has to make its sound: hearing
   it is the entire reason the control was touched. */
function playButtonCueNow(): void {
  if (buttonAudio) playCue(buttonAudio, settings.buttonVolumeDb);
}

function playModalCueNow(): void {
  if (modalAudio) playCue(modalAudio, settings.modalVolumeDb);
}

/** Plays the button cue, through the priority gate. Exported because the
 *  delegated click listener that drives it lives in shell.ts, alongside the
 *  app's other document-level listeners.
 *
 *  Returns early when no cue is chosen rather than queueing a silent one, so a
 *  cue set to None never takes the queue slot away from a real one. */
export function playButtonCue(): void {
  if (!buttonAudio) return;
  requestCue(CUE_RANK_BUTTON, playButtonCueNow);
}

/** Plays the modal-open cue, through the priority gate. Called from the global
 *  modal open hook. */
export function playModalCue(): void {
  if (!modalAudio) return;
  requestCue(CUE_RANK_MODAL, playModalCueNow);
}

/** Plays a toast's cue, through the priority gate. flash() calls this rather
 *  than reaching for playCue() directly, so that the outcome of an action
 *  always beats the click that started it. Notifications hold the top rank, so
 *  in practice this is only ever queued, never dropped. */
export function playToastCue(type: "success" | "error"): void {
  const audio = type === "error" ? errorAudio : successAudio;
  if (!audio) return;
  requestCue(CUE_RANK_NOTIFICATION, () => playCue(audio));
}

const buttonCuePicker = createCuePicker({
  edit: "buttonSoundEditBtn",
  badge: "buttonSoundCurrentBadge",
  backdrop: "buttonSoundPickerBackdrop",
  hint: "buttonSoundPickerHint",
  back: "buttonSoundPickerBack",
  close: "buttonSoundPickerClose",
  grid: "buttonSoundPickerGrid",
  list: BUTTON_SOUNDS,
  folder: "button-sounds",
  get: () => settings.buttonSoundId,
  set: (id) => {
    settings.buttonSoundId = id;
  },
  db: () => settings.buttonVolumeDb,
  reload: loadUiCues,
});

const modalCuePicker = createCuePicker({
  edit: "modalSoundEditBtn",
  badge: "modalSoundCurrentBadge",
  backdrop: "modalSoundPickerBackdrop",
  hint: "modalSoundPickerHint",
  back: "modalSoundPickerBack",
  close: "modalSoundPickerClose",
  grid: "modalSoundPickerGrid",
  list: MODAL_SOUNDS,
  folder: "modal-sounds",
  get: () => settings.modalSoundId,
  set: (id) => {
    settings.modalSoundId = id;
  },
  db: () => settings.modalVolumeDb,
  reload: loadUiCues,
});

/** Syncs everything the Audio tab and the three pickers show to current
 *  settings: the volume sliders, the two cue badges, and the reused <audio>
 *  elements behind the cues. Called from applySettings(). */
export function applyAudioSettings(): void {
  toastVolumeControl.sync();
  buttonVolumeControl.sync();
  modalVolumeControl.sync();
  buttonCuePicker.refreshBadge();
  modalCuePicker.refreshBadge();
  loadUiCues();
}

// Active pack's audio elements, swapped out by loadSoundPack() whenever the
// Sound Pack setting changes. Null means that cue is muted for this pack.
export let successAudio: HTMLAudioElement | null = null;
export let errorAudio: HTMLAudioElement | null = null;

/** Swaps the active success/error Audio elements to the given pack. Falls
 *  back to the first registered pack if the id is unknown (e.g. a pack was
 *  removed after being selected). A pack that omits a path mutes that cue. */
export function loadSoundPack(id: string): void {
  const pack = SOUND_PACKS.find((p) => p.id === id) ?? SOUND_PACKS[0];
  successAudio = pack.success ? new Audio(pack.success) : null;
  errorAudio = pack.error ? new Audio(pack.error) : null;
}
// NOT called at module load, deliberately. Doing so would read an imported
// value while this file is still loading, across the circular import with
// shell.ts, which is the fault that once opened the app to a blank window. The
// startup path already covers it: applySettings() calls
// loadSoundPack(settings.soundPack) as soon as settings are read. Until then
// both cue elements stay null, and flash() checks them before playing, so a
// toast fired that early is silent rather than broken.

/* =============================================================================
   CUE PLAYBACK AND THE DECIBEL SCALE
   -----------------------------------------------------------------------------
   One scale, shared by all three levels (toastVolumeDb, buttonVolumeDb,
   modalVolumeDb): a decibel offset from the level the app has always played
   at. 0 dB is that level and the default, so an untouched install sounds
   exactly as it did before any of this existed.

   Two mechanisms, because one alone can't cover the range:

     quieter (<= 0 dB)  HTMLAudioElement.volume, which is a 0..1 multiplier.
     louder  (>  0 dB)  volume is already pinned at its 1.0 ceiling, so a boost
                        has to go through a Web Audio GainNode, which has no
                        upper limit.

   The Web Audio graph is built lazily, per element, and ONLY when a boost is
   actually asked for. Cues are load-bearing feedback, and routing every one of
   them through an AudioContext that might be suspended or unavailable would
   risk silence for people who never touch this slider. Quieter and default
   keep the plain, proven path.

   Once an element has been wired it stays wired, which is fine: the element's
   own `volume` is applied before the graph sees it, so the two multiply
   cleanly and attenuation still works on a wired element.
============================================================================= */

const CUE_VOLUME_MAX_DB = 5;
const CUE_VOLUME_MIN_DB = -25;
/** One step below the quietest real setting, standing for silence rather than
 *  for a level. -25 dB is already very quiet but still audible, and there was
 *  no way to say "off" without a value that means it. */
const CUE_VOLUME_MUTED_DB = CUE_VOLUME_MIN_DB - 1;

/** Holds a stored or typed value inside the slider's range, including the mute
 *  notch at the bottom. Shared by all three cue volumes and by loadSettings(),
 *  so a hand-edited settings.json cannot put any of them out of range. */
export function clampCueVolumeDb(db: number): number {
  if (!Number.isFinite(db)) return 0;
  return Math.min(CUE_VOLUME_MAX_DB, Math.max(CUE_VOLUME_MUTED_DB, Math.round(db)));
}

/** Linear amplitude for a decibel offset. 0 dB is 1.0 (unchanged), +6 dB is
 *  roughly double, -6 dB roughly half, and the mute notch is a hard 0. */
function dbToGain(db: number): number {
  if (db <= CUE_VOLUME_MUTED_DB) return 0;
  return Math.pow(10, db / 20);
}

let _audioCtx: AudioContext | null = null;
/** Gain node per boosted element. Also serves as the "is this one wired yet"
 *  check, since createMediaElementSource() may only be called once per
 *  element and throws on a second attempt. */
const _boostNodes = new WeakMap<HTMLAudioElement, GainNode>();

/** Returns the shared AudioContext, creating it on first boost. Null when the
 *  browser has no Web Audio at all, which sends callers back to the plain path
 *  rather than failing. */
function audioContext(): AudioContext | null {
  if (_audioCtx) return _audioCtx;
  try {
    _audioCtx = new AudioContext();
  } catch {
    _audioCtx = null;
  }
  return _audioCtx;
}

/** Applies a volume level to one cue element and plays it from the start.
 *  `db` defaults to the notification level, so the toast callers that predate
 *  the button/modal cues read exactly as they did; those two pass their own.
 *  Never throws: a rejected play() (autoplay policy, missing file) is swallowed
 *  exactly as it was before, and any Web Audio failure degrades to the plain
 *  element at its 1.0 ceiling rather than to silence. */
export function playCue(audio: HTMLAudioElement, db: number = settings.toastVolumeDb): void {
  const gain = dbToGain(db);

  // Muted: don't start playback at all rather than playing at volume 0, so a
  // muted cue costs nothing and can't be heard through a boosted graph.
  if (gain === 0) return;

  audio.volume = Math.min(1, gain);

  if (gain > 1) {
    try {
      const ctx = audioContext();
      if (ctx) {
        // A context created before any user gesture starts suspended.
        if (ctx.state === "suspended") void ctx.resume();

        const existing = _boostNodes.get(audio);
        if (existing) {
          existing.gain.value = gain;
        } else if (ctx.state === "running") {
          // Only ever wire an element into a RUNNING graph. Connecting a media
          // element to Web Audio replaces its normal output, so wiring into a
          // suspended context would mute the cue outright. A boosted setting
          // restored at launch, before any click has resumed audio, would then
          // silence the very first toast. Skipping the boost costs loudness for
          // one cue; wiring blind costs the cue.
          const node = ctx.createGain();
          ctx.createMediaElementSource(audio).connect(node);
          node.connect(ctx.destination);
          node.gain.value = gain;
          _boostNodes.set(audio, node);
        }
      }
    } catch {
      /* Boost unavailable; the element still plays at full volume. */
    }
  } else {
    // Back down to unity so an element wired during an earlier boost doesn't
    // keep multiplying after the slider comes back down.
    const node = _boostNodes.get(audio);
    if (node) node.gain.value = 1;
  }

  audio.currentTime = 0;
  audio.play().catch(() => {});
}
