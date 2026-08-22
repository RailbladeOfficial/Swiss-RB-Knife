/* =============================================================================
   SOUND: notification cues, the Choose Sound Pack modal, and cue volume
   -----------------------------------------------------------------------------
   Split out of shell.ts, where this feature was spread across three separate
   places with unrelated code between them: the pack picker and the tool-facing
   API in one block, the active <audio> elements and cue-volume plumbing in
   another, with the reminder modals and toast display in between. Anyone
   changing "how loud a cue is" previously had to know all three.

   Circular with shell.ts (it needs playback and SOUND_PACKS, this needs
   settings and flash). Safe because nothing here reads an imported value while
   the file loads; scripts/checks/module-init.test.mjs enforces that.
============================================================================= */

import { Modal } from "./modal";
import {
  SOUND_PACKS,
  type SoundPack,
  flash,
  saveSettings,
  settings,
  settingsModal,
} from "./shell";

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
   Tools that need their own alert cue (Countdown Timer's timer-end alarm) pick from
   the same packs the app ships rather than bundling audio of their own. The
   pack list stays private; these two functions are the whole surface.
============================================================================= */

/** Every cue in every pack (both the success and the error sound) as
 *  pickable options. Ids are "<packId>:<kind>", and an EMPTY pack id means
 *  "whichever pack the app is set to", resolved late so changing the app's
 *  sound pack changes the tool's cue with it. */
export function getSoundOptions(): { id: string; name: string }[] {
  const options: { id: string; name: string }[] = [
    { id: ":success", name: "App pack: Success" },
    { id: ":error", name: "App pack: Error" },
  ];
  SOUND_PACKS.forEach((p) => {
    options.push({ id: `${p.id}:success`, name: `${p.name}: Success` });
    options.push({ id: `${p.id}:error`, name: `${p.name}: Error` });
  });
  return options;
}

/** Resolves a stored sound id to a playable url. Accepts "<packId>:<kind>",
 *  and tolerates the older bare "<packId>" (and "") forms, which meant that
 *  pack's success cue. Returns null when the pack no longer exists
 *  (uninstalled/renamed) so callers degrade to silence rather than throwing. */
export function resolveSoundUrl(soundId: string): string | null {
  const [packPart, kindPart] = soundId.split(":");
  const wanted = packPart || settings.soundPack;
  const pack = SOUND_PACKS.find((p) => p.id === wanted);
  if (!pack) return null;
  return (kindPart === "error" ? pack.error : pack.success) ?? null;
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

/** Tracks whatever preview cue is currently playing so a new preview click
 *  can stop it. Without this, rapid clicks across tiles/buttons stack up
 *  and play over each other instead of replacing one another. */
let _soundPackPreviewAudio: HTMLAudioElement | null = null;

/** Plays one specific pack's cue directly, a standalone preview, not tied
 *  to the active successAudio/errorAudio elements used by flash(). Only one
 *  preview ever plays at a time; starting a new one kills the last. */
function previewSoundPackCue(pack: SoundPack, kind: "success" | "error"): void {
  const src = kind === "success" ? pack.success : pack.error;
  if (!src) return;

  if (_soundPackPreviewAudio) {
    _soundPackPreviewAudio.pause();
    _soundPackPreviewAudio.currentTime = 0;
  }

  const audio = new Audio(src);
  _soundPackPreviewAudio = audio;
  audio.addEventListener("ended", () => {
    if (_soundPackPreviewAudio === audio) _soundPackPreviewAudio = null;
  });
  // Through playCue so a preview is heard at the volume the cue will actually
  // play at, which is the whole point of previewing it.
  playCue(audio);
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
    previewSoundPackCue(pack, "success");
  });
  actions.appendChild(successBtn);

  const errorBtn = document.createElement("button");
  errorBtn.className = "sound-pack-preview-btn error";
  errorBtn.title = "Preview error sound";
  errorBtn.innerHTML = SPEAKER_SVG;
  errorBtn.disabled = !pack.error;
  errorBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    previewSoundPackCue(pack, "error");
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

soundPackPickerBack.addEventListener("click", () => {
  soundPackPickerModal.close();
  settingsModal.open();
});

soundPackPickerClose.addEventListener("click", () => soundPackPickerModal.close());

/* ── Notification volume ──────────────────────────────────────────────────
   Lives on the Audio tab of General Settings, above Notification Sound: same
   subject, but it applies to whichever pack is selected rather than being
   part of picking one. Wired up here, next to the pack picker it shares a tab
   with, rather than up in the settings-modal section. Persisting is debounced
   off the "change" event rather than "input", so dragging across the range
   writes settings once at the end instead of thirty times on the way. */

const soundVolumeSlider = document.getElementById(
  "soundVolumeSlider",
) as HTMLInputElement;
const soundVolumeValue = document.getElementById("soundVolumeValue")!;
const soundVolumeReset = document.getElementById("soundVolumeReset")!;

/** How the current value reads on screen. Three cases, because the two ends of
 *  the range aren't levels: the bottom notch is silence and the centre is the
 *  app's original loudness. */
function toastVolumeLabel(db: number): string {
  if (db <= TOAST_VOLUME_MUTED_DB) return "Muted";
  if (db === 0) return "Default";
  return `${db > 0 ? "+" : ""}${db} dB`;
}

/** Syncs the slider, its read-out, and the Reset button's enabled state to the
 *  current setting. Called from applySettings(), so load, reset-to-defaults and
 *  reopening the modal all stay in step. */
export function applyToastVolumeSettings(): void {
  const db = settings.toastVolumeDb;
  soundVolumeSlider.value = String(db);
  soundVolumeValue.textContent = toastVolumeLabel(db);
  soundVolumeValue.classList.toggle("is-muted", db <= TOAST_VOLUME_MUTED_DB);
  (soundVolumeReset as HTMLButtonElement).disabled = db === 0;
}

/** Live feedback while dragging: the read-out tracks the thumb, but nothing is
 *  written to disk until the drag ends. */
soundVolumeSlider.addEventListener("input", () => {
  settings.toastVolumeDb = clampToastVolume(Number(soundVolumeSlider.value));
  applyToastVolumeSettings();
});

soundVolumeSlider.addEventListener("change", () => {
  void saveSettings();
  // Play the active pack's success cue at the new level, so the setting is
  // judged by ear at the moment it's chosen. Muted plays nothing, which is
  // itself the correct preview.
  if (successAudio) playCue(successAudio);
});

soundVolumeReset.addEventListener("click", () => {
  settings.toastVolumeDb = 0;
  applyToastVolumeSettings();
  void saveSettings();
  if (successAudio) playCue(successAudio);
});

/** Double-click the read-out to type an exact dB value, matching the inline
 *  edits elsewhere in the app (Auto-Backup's paths, Budget's amounts, the
 *  Countdown clock): Enter or Tab commits, Escape cancels, blur commits.
 *
 *  Typing is the only way to hit a specific number on a 36-step slider without
 *  fighting the thumb, and "mute"/"muted"/"off" are accepted as words since the
 *  bottom notch has no number to type. */
function beginToastVolumeEdit(): void {
  if (soundVolumeValue.querySelector("input")) return; // already editing

  const original = settings.toastVolumeDb;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "sound-volume-edit";
  input.value =
    original <= TOAST_VOLUME_MUTED_DB ? "muted" : String(original);
  input.setAttribute("aria-label", "Notification volume in decibels");

  soundVolumeValue.textContent = "";
  soundVolumeValue.appendChild(input);
  input.focus();
  input.select();

  let handledByKeydown = false;

  function finish(db: number): void {
    settings.toastVolumeDb = db;
    applyToastVolumeSettings();
    void saveSettings();
    if (successAudio) playCue(successAudio);
  }

  function commit(): void {
    const raw = input.value.trim().toLowerCase();
    if (raw === "muted" || raw === "mute" || raw === "off") {
      finish(TOAST_VOLUME_MUTED_DB);
      return;
    }
    // "Default" is what the read-out shows at 0, so accept it back.
    if (raw === "default") {
      finish(0);
      return;
    }
    // Tolerates a typed "dB" suffix and a leading "+".
    const parsed = Number(raw.replace(/\s*db$/, "").replace(/^\+/, ""));
    if (!Number.isFinite(parsed)) {
      applyToastVolumeSettings(); // put the old value back
      flash(
        `Enter a number between ${TOAST_VOLUME_MIN_DB} and ${TOAST_VOLUME_MAX_DB}, or "muted"`,
        "error",
      );
      return;
    }
    finish(clampToastVolume(parsed));
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
      applyToastVolumeSettings();
    }
  });

  input.addEventListener("blur", () => {
    if (handledByKeydown) return;
    commit();
  });
}

soundVolumeValue.addEventListener("dblclick", beginToastVolumeEdit);

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
   TOAST CUE VOLUME
   -----------------------------------------------------------------------------
   settings.toastVolumeDb shifts every cue up or down from the level the app
   has always played at. 0 dB is that level, so an untouched install sounds
   exactly as it did before this existed.

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

const TOAST_VOLUME_MAX_DB = 5;
const TOAST_VOLUME_MIN_DB = -25;
/** One step below the quietest real setting, standing for silence rather than
 *  for a level. -25 dB is already very quiet but still audible, and there was
 *  no way to say "off" without a value that means it. */
const TOAST_VOLUME_MUTED_DB = TOAST_VOLUME_MIN_DB - 1;

/** Holds a stored or typed value inside the slider's range, including the mute
 *  notch at the bottom. */
export function clampToastVolume(db: number): number {
  if (!Number.isFinite(db)) return 0;
  return Math.min(TOAST_VOLUME_MAX_DB, Math.max(TOAST_VOLUME_MUTED_DB, Math.round(db)));
}

/** Linear amplitude for a decibel offset. 0 dB is 1.0 (unchanged), +6 dB is
 *  roughly double, -6 dB roughly half, and the mute notch is a hard 0. */
function dbToGain(db: number): number {
  if (db <= TOAST_VOLUME_MUTED_DB) return 0;
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

/** Applies the current volume setting to one cue element and plays it from the
 *  start. Never throws: a rejected play() (autoplay policy, missing file) is
 *  swallowed exactly as it was before, and any Web Audio failure degrades to
 *  the plain element at its 1.0 ceiling rather than to silence. */
export function playCue(audio: HTMLAudioElement): void {
  const gain = dbToGain(settings.toastVolumeDb);

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
