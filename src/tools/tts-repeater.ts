/* =============================================================================
   TTS REPEATER
   -----------------------------------------------------------------------------
   Speaks a message aloud on a repeating interval. Built for the "nag me until I
   do the thing" case: set a message, set an interval, walk away.

   Architecture notes:
     • THE INTERVAL IS KEPT IN RUST, not in a setInterval here. A minimized or
       occluded WebView2 window is a hidden page as far as Chromium is
       concerned, and hidden pages get their timers clamped to about one
       wake-up per minute after ~5 minutes. Since this tool is specifically
       meant to keep working while you're doing something else, the schedule
       lives on an OS thread (src-tauri/src/tools/tts_repeater.rs) which emits
       "tts-repeater-tick"; this file only reacts. The one timer that IS local
       is the status-line countdown, which is cosmetic. Nobody is reading it
       while the window is hidden, and it recomputes from an absolute deadline
       so it self-corrects the moment the window is visible again.
     • TWO TIMING MODES, and they schedule differently. "From message start"
       is a free-running repeat: the Rust timer is armed once and every
       repetition lands on the interval, cutting off any reading still in
       progress. "From message end" can't be scheduled ahead at all. The gap
       only begins when the speech stops, which only the frontend can observe
:       so each cycle arms a fresh one-shot from the utterance's `end`
       handler. See emitUtterance() / armNextRepetition().
     • Every tick carries the Rust generation counter that produced it, and
       anything not matching activeGeneration is dropped. Without that, a
       stop→start inside the outgoing thread's cancellation window could let
       the dying thread speak once against the new run. runEpoch does the same
       job for utterance callbacks, which can outlive the run that created
       them.
     • config is read from / written to the DOM rather than mirrored in a state
       object: the form IS the state while idle, and while running the form is
       disabled, so there's no second copy to keep in sync. runningConfig holds
       the snapshot taken at Start so that speaking is unaffected by anything
       that could still change underneath it.
     • Speech itself is the Web Speech API (window.speechSynthesis), which in
       WebView2 is backed by the installed Windows SAPI voices.

   Rust commands used:
     save_tts_repeater_data, load_tts_repeater_data,
     tts_repeater_start_timer, tts_repeater_stop_timer
============================================================================= */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { flash, escapeHtml } from "../shell";
import { Modal } from "../modal";
import { setSeasonalCanvasElevated, isSeasonalEffectRunning } from "../theme-core";

/* =============================================================================
   TYPES
============================================================================= */

type IntervalUnit = "seconds" | "minutes";
type RepeatMode = "forever" | "count";

/** Where the gap between repetitions is measured from.
 *  "start". Every `interval` from the moment a repetition BEGINS. The
 *            schedule is fixed, so a message longer than the interval is cut
 *            off to let the next one land on time.
 *  "end":   the gap begins when the message finishes being read, so the
 *            interval is silence between readings and nothing is ever
 *            truncated. Total cycle time is message length + interval. */
type TimerBasis = "start" | "end";

/** Everything that defines one "run", also exactly what a preset stores. */
interface TtsConfig {
  message: string;
  intervalAmount: number;
  intervalUnit: IntervalUnit;
  repeatMode: RepeatMode;
  repeatCount: number;
  timerBasis: TimerBasis;
  /** SpeechSynthesisVoice.voiceURI, or "" for the system default voice. */
  voiceUri: string;
  rate: number;
  pitch: number;
  volume: number;
}

interface TtsPreset extends TtsConfig {
  id: string;
  name: string;
}

/** Appearance of the Display View overlay. Deliberately NOT part of TtsConfig:
 *  this is how the tool looks, not what a given run says, so presets don't
 *  carry it and loading one never changes your display setup. */
interface TtsDisplaySettings {
  /** "theme" tracks the active app theme; "custom" uses bgColor/textColor. */
  look: "theme" | "custom";
  bgColor: string;
  textColor: string;
  align: "left" | "center" | "right";
  /** Rendered text size in px. */
  fontSize: number;
  /** Keep the glow the active theme puts on its header titles (neon's cyan
   *  bloom, terminal's green, Halloween's orange). Off strips it. Themes
   *  without a glow have nothing to strip. Theme look only, "custom" picks
   *  two exact colours and is flat by definition. */
  glow: boolean;
  /** Let the active theme's seasonal effect (Christmas snow, Halloween
   *  lightning, Patriot fireworks) play OVER the Display View instead of
   *  being hidden behind it. Doesn't start an effect that's off; it only
   *  decides whether a running one is painted above the overlay. */
  animate: boolean;
}

/** Shape of tts-repeater.json. `settings` is the last-used form state. */
interface TtsStore {
  settings: TtsConfig | null;
  presets: TtsPreset[];
  display: TtsDisplaySettings | null;
}

/* =============================================================================
   CONSTANTS
============================================================================= */

const MESSAGE_MAX_CHARS = 1000;

/** Matches the bounds enforced in tts_repeater.rs. Checked here too so the
 *  user gets a sentence instead of a rejected invoke. */
const MIN_INTERVAL_MS = 1_000;
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1_000;

const REPEAT_COUNT_MAX = 9_999;

/** Spoken by the Test button when the message box is empty, so testing a voice
 *  doesn't require writing the real message first. */
const TEST_FALLBACK_TEXT = "This is a test of the selected voice.";

const DEFAULT_DISPLAY: TtsDisplaySettings = {
  look: "theme",
  bgColor: "#000000",
  textColor: "#ffffff",
  align: "center",
  fontSize: 72,
  glow: true,
  animate: true,
};

const DISPLAY_FONT_MIN = 16;
const DISPLAY_FONT_MAX = 200;

/** How long the Display View exit button stays visible after the pointer last
 *  moved. Long enough to aim for, short enough that an idle cursor doesn't
 *  leave app chrome sitting on a stream. */
const DISPLAY_EXIT_IDLE_MS = 2000;

const DEFAULT_CONFIG: TtsConfig = {
  message: "",
  intervalAmount: 30,
  intervalUnit: "seconds",
  repeatMode: "forever",
  repeatCount: 10,
  timerBasis: "start",
  voiceUri: "",
  rate: 1,
  pitch: 1,
  volume: 1,
};

/* =============================================================================
   STATE
============================================================================= */

let presets: TtsPreset[] = [];

/** False until loadStore() has finished (successfully or not). Guards every
 *  write: initTTSRepeater() doesn't await the load, so an edit made in the
 *  first moments of app start would otherwise persist the still-empty presets
 *  array over the real one. */
let storeLoaded = false;

/** Populated asynchronously, see refreshVoiceOptions(). */
let voices: SpeechSynthesisVoice[] = [];

let running = false;

/** The config captured at Start. Null while idle. */
let runningConfig: TtsConfig | null = null;

/** Utterances spoken so far in the current run, including the immediate one. */
let spokenCount = 0;

/** Generation of the Rust timer currently driving us; -1 while stopped.
 *  Ticks stamped with anything else are stale and ignored. */
let activeGeneration = -1;

/** Absolute time the next utterance is due, for the status countdown. Re-based
 *  on every tick, so any drift against the Rust schedule lasts one interval and
 *  never accumulates. Zero means "no countdown to show", in "after each
 *  message" mode nothing is scheduled while the message is still being read. */
let nextDueAt = 0;

/** Bumped on every Start. Utterance callbacks capture it and bail if it has
 *  moved on, which is what stops a previous run's `end` handler from re-arming
 *  a timer (or announcing a completion) against the run that replaced it. */
let runEpoch = 0;

/** Display-only 1s repaint of the status line. Null while idle. */
let statusTimer: ReturnType<typeof setInterval> | null = null;

/** Debounce handle for persisting the form as last-used settings. */
let saveSettingsTimer: ReturnType<typeof setTimeout> | null = null;

/** Preset queued for deletion, held while the confirm modal is up. */
let pendingDeleteId: string | null = null;

let display: TtsDisplaySettings = { ...DEFAULT_DISPLAY };

let displayOpen = false;

/** Hides the Display View exit button once the pointer has been still. */
let displayExitTimer: ReturnType<typeof setTimeout> | null = null;

/* =============================================================================
   ELEMENT REFS
============================================================================= */

let messageInput: HTMLTextAreaElement;
let messageCount: HTMLElement;
let intervalAmountInput: HTMLInputElement;
let repeatCountInput: HTMLInputElement;
let repeatCountField: HTMLElement;
let voiceSelect: HTMLSelectElement;
let rateInput: HTMLInputElement;
let pitchInput: HTMLInputElement;
let volumeInput: HTMLInputElement;
let rateValue: HTMLElement;
let pitchValue: HTMLElement;
let volumeValue: HTMLElement;
let testBtn: HTMLButtonElement;
let startBtn: HTMLButtonElement;
let statusEl: HTMLElement;
let presetNameInput: HTMLInputElement;
let presetListEl: HTMLElement;
let displayBtn: HTMLButtonElement;
let resetBtn: HTMLButtonElement;

let displayOverlay: HTMLElement;
let displayTextEl: HTMLElement;
let displayExitBtn: HTMLButtonElement;
let displayBgInput: HTMLInputElement;
let displayFgInput: HTMLInputElement;
let displayCustomRow: HTMLElement;
let displayEffectsRow: HTMLElement;
let displayGlowToggle: HTMLInputElement;
let displayAnimateToggle: HTMLInputElement;
let glowNote: HTMLElement;
let animateNote: HTMLElement;
let displaySizeInput: HTMLInputElement;
let displaySizeValue: HTMLElement;
let displaySizeEntry: HTMLInputElement;
let displayPreview: HTMLElement;
let displayPreviewText: HTMLElement;

let presetsModal: Modal | null = null;
let presetDeleteModal: Modal | null = null;
let setupModal: Modal | null = null;

/* =============================================================================
   PERSISTENCE
============================================================================= */

async function loadStore(): Promise<void> {
  try {
    const raw = await invoke<string>("load_tts_repeater_data");
    const parsed = JSON.parse(raw) as Partial<TtsStore>;
    presets = Array.isArray(parsed.presets) ? parsed.presets : [];
    display = normalizeDisplay(parsed.display ?? {});
    applyDisplayToSetupForm();
    syncSetupUI();
    if (parsed.settings) applyConfig(normalizeConfig(parsed.settings));
  } catch (err) {
    // A corrupt or unreadable data file shouldn't cost the user the tool,
    // fall back to defaults and say so once.
    presets = [];
    flash(`Couldn't load saved TTS Repeater data: ${String(err)}`, "error");
  } finally {
    // Set even on failure: a load that errored has already been reported, and
    // leaving writes blocked forever would silently stop persisting anything
    // for the rest of the session.
    storeLoaded = true;
  }
}

async function saveStore(): Promise<void> {
  if (!storeLoaded) return;
  const store: TtsStore = { settings: readConfig(), presets, display };
  try {
    await invoke("save_tts_repeater_data", { data: JSON.stringify(store) });
  } catch (err) {
    flash(`Couldn't save TTS Repeater data: ${String(err)}`, "error");
  }
}

/** Persists the form as last-used settings, coalescing the burst of events a
 *  slider drag or a typed message produces into one write. */
function queueSaveSettings(): void {
  if (saveSettingsTimer !== null) clearTimeout(saveSettingsTimer);
  saveSettingsTimer = setTimeout(() => {
    saveSettingsTimer = null;
    void saveStore();
  }, 600);
}

/* =============================================================================
   CONFIG  ⇄  FORM
============================================================================= */

/** Coerces anything loaded from disk (or an older data file) into a complete,
 *  in-range config, so no later code has to defend against a missing field. */
function normalizeConfig(raw: Partial<TtsConfig>): TtsConfig {
  const num = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;

  return {
    message: typeof raw.message === "string" ? raw.message.slice(0, MESSAGE_MAX_CHARS) : "",
    intervalAmount: Math.max(1, Math.round(num(raw.intervalAmount, DEFAULT_CONFIG.intervalAmount))),
    intervalUnit: raw.intervalUnit === "minutes" ? "minutes" : "seconds",
    repeatMode: raw.repeatMode === "count" ? "count" : "forever",
    repeatCount: Math.min(
      REPEAT_COUNT_MAX,
      Math.max(1, Math.round(num(raw.repeatCount, DEFAULT_CONFIG.repeatCount))),
    ),
    timerBasis: raw.timerBasis === "end" ? "end" : "start",
    voiceUri: typeof raw.voiceUri === "string" ? raw.voiceUri : "",
    // The API accepts rate up to 10, but past ~2 the Windows voices are past
    // intelligibility, so the slider stops where the usable range does.
    rate: Math.min(2, Math.max(0.1, num(raw.rate, 1))),
    pitch: Math.min(2, Math.max(0, num(raw.pitch, 1))),
    volume: Math.min(1, Math.max(0, num(raw.volume, 1))),
  };
}

/** Same job as normalizeConfig(), for the display settings. A hex colour that
 *  isn't a hex colour would silently blank an <input type="color">, so the
 *  shape check here is what keeps the Setup form honest. */
function normalizeDisplay(raw: Partial<TtsDisplaySettings>): TtsDisplaySettings {
  const hex = (v: unknown, fallback: string): string =>
    typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v : fallback;

  const size = typeof raw.fontSize === "number" && Number.isFinite(raw.fontSize)
    ? Math.round(raw.fontSize)
    : DEFAULT_DISPLAY.fontSize;

  return {
    look: raw.look === "custom" ? "custom" : "theme",
    bgColor: hex(raw.bgColor, DEFAULT_DISPLAY.bgColor),
    textColor: hex(raw.textColor, DEFAULT_DISPLAY.textColor),
    align: raw.align === "left" || raw.align === "right" ? raw.align : "center",
    fontSize: Math.min(DISPLAY_FONT_MAX, Math.max(DISPLAY_FONT_MIN, size)),
    glow: raw.glow !== false,
    animate: raw.animate !== false,
  };
}

function activeSegValue(groupId: string, fallback: string): string {
  const active = document.querySelector<HTMLElement>(`#${groupId} .toggle-btn.active`);
  return active?.dataset.value ?? fallback;
}

function setSegValue(groupId: string, value: string): void {
  document.querySelectorAll<HTMLButtonElement>(`#${groupId} .toggle-btn`).forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.value === value);
  });
}

/** Reads the current form. Raw, validation happens in validateConfig(). */
function readConfig(): TtsConfig {
  return {
    message: messageInput.value,
    intervalAmount: parseInt(intervalAmountInput.value, 10) || 0,
    intervalUnit: activeSegValue("tts-interval-unit", "seconds") as IntervalUnit,
    repeatMode: activeSegValue("tts-repeat-mode", "forever") as RepeatMode,
    repeatCount: parseInt(repeatCountInput.value, 10) || 0,
    timerBasis: activeSegValue("tts-timer-basis", "start") as TimerBasis,
    voiceUri: voiceSelect.value,
    rate: parseFloat(rateInput.value),
    pitch: parseFloat(pitchInput.value),
    volume: parseFloat(volumeInput.value),
  };
}

function applyConfig(config: TtsConfig): void {
  messageInput.value = config.message;
  intervalAmountInput.value = String(config.intervalAmount);
  setSegValue("tts-interval-unit", config.intervalUnit);
  setSegValue("tts-repeat-mode", config.repeatMode);
  setSegValue("tts-timer-basis", config.timerBasis);
  repeatCountInput.value = String(config.repeatCount);
  // The voice may not exist on this machine (a preset moved between PCs, or a
  // voice uninstalled). Assigning an absent value leaves the select at "", the
  // system-default option, which is the right fallback, so no special case.
  voiceSelect.value = config.voiceUri;
  rateInput.value = String(config.rate);
  pitchInput.value = String(config.pitch);
  volumeInput.value = String(config.volume);
  syncDerivedUI();
}

function intervalMsOf(config: TtsConfig): number {
  return config.intervalAmount * (config.intervalUnit === "minutes" ? 60_000 : 1_000);
}

/** Returns an error sentence, or null when the config is good to run. */
function validateConfig(config: TtsConfig): string | null {
  if (!config.message.trim()) return "Enter a message to speak.";
  if (config.message.length > MESSAGE_MAX_CHARS) {
    return `Message is too long. ${MESSAGE_MAX_CHARS} characters max.`;
  }
  if (!Number.isFinite(config.intervalAmount) || config.intervalAmount < 1) {
    return "Interval must be at least 1.";
  }

  const ms = intervalMsOf(config);
  if (ms < MIN_INTERVAL_MS) return "Interval must be at least 1 second.";
  if (ms > MAX_INTERVAL_MS) return "Interval can't be longer than 24 hours.";

  if (config.repeatMode === "count") {
    if (!Number.isFinite(config.repeatCount) || config.repeatCount < 1) {
      return "Repeat count must be at least 1.";
    }
    if (config.repeatCount > REPEAT_COUNT_MAX) {
      return `Repeat count can't exceed ${REPEAT_COUNT_MAX}.`;
    }
  }
  return null;
}

/* =============================================================================
   VOICES
   -----------------------------------------------------------------------------
   getVoices() is empty on first call in a fresh WebView and fills in
   asynchronously, announced by the voiceschanged event, so this runs once at
   init and again on every voiceschanged, preserving whatever was selected.
============================================================================= */

function refreshVoiceOptions(): void {
  const previous = voiceSelect.value;
  voices = window.speechSynthesis.getVoices();

  voiceSelect.innerHTML = "";
  const defaultOpt = document.createElement("option");
  defaultOpt.value = "";
  defaultOpt.textContent = "System default";
  voiceSelect.appendChild(defaultOpt);

  // Grouped by language so a machine with a dozen installed voices stays
  // scannable; single-language machines just get one group.
  const byLang = new Map<string, SpeechSynthesisVoice[]>();
  voices.forEach((voice) => {
    const list = byLang.get(voice.lang) ?? [];
    list.push(voice);
    byLang.set(voice.lang, list);
  });

  [...byLang.keys()].sort().forEach((lang) => {
    const group = document.createElement("optgroup");
    group.label = lang;
    byLang.get(lang)!.forEach((voice) => {
      const opt = document.createElement("option");
      opt.value = voice.voiceURI;
      opt.textContent = voice.name;
      group.appendChild(opt);
    });
    voiceSelect.appendChild(group);
  });

  // Restore the prior pick if it's still installed; otherwise fall back to the
  // system default rather than silently landing on some other voice.
  voiceSelect.value = [...voiceSelect.options].some((o) => o.value === previous) ? previous : "";
}

/* =============================================================================
   SPEAKING
============================================================================= */

/** Queues one utterance and hands it back, so a caller can hang an `end`
 *  handler on it (see emitUtterance's final repetition). */
function speak(config: TtsConfig, text: string): SpeechSynthesisUtterance {
  const utterance = new SpeechSynthesisUtterance(text);
  const voice = voices.find((v) => v.voiceURI === config.voiceUri);
  if (voice) utterance.voice = voice;
  utterance.rate = config.rate;
  utterance.pitch = config.pitch;
  utterance.volume = config.volume;
  window.speechSynthesis.speak(utterance);
  return utterance;
}

/* =============================================================================
   RUN CONTROL
============================================================================= */

async function startRepeating(): Promise<void> {
  const config = readConfig();
  const error = validateConfig(config);
  if (error) {
    flash(error, "error");
    return;
  }

  startBtn.disabled = true;
  try {
    if (config.timerBasis === "start") {
      // Free-running repeat: the schedule is set once and holds for the run.
      activeGeneration = await invoke<number>("tts_repeater_start_timer", {
        intervalMs: intervalMsOf(config),
        oneShot: false,
      });
    } else {
      // Nothing to schedule yet. The gap only starts once the first message
      // has finished being read, so the timer is armed from its `end` handler.
      activeGeneration = -1;
    }
  } catch (err) {
    flash(`Couldn't start the repeater: ${String(err)}`, "error");
    return;
  } finally {
    startBtn.disabled = false;
  }

  running = true;
  runningConfig = config;
  spokenCount = 0;
  runEpoch++;
  nextDueAt = config.timerBasis === "start" ? Date.now() + intervalMsOf(config) : 0;

  syncRunningUI();
  void saveStore();

  // Clear the queue first. A previous run's final line is deliberately left
  // to finish speaking (see emitUtterance), and a Test can still be going.
  // Either would otherwise play ahead of this run's first utterance.
  window.speechSynthesis.cancel();

  // Started BEFORE the first utterance on purpose: with a repeat count of 1
  // that utterance ends the run immediately, and a setInterval assigned after
  // it would outlive the run it was meant to time.
  statusTimer = setInterval(renderStatus, 1000);

  // Speak immediately, exactly as the original did, waiting a full interval
  // for the first one makes a long interval feel broken.
  emitUtterance();
  renderStatus();
}

/** Shared teardown for both ways a run can end. `cancelSpeech` is the only
 *  difference between them: stopping on the user's word cuts off whatever is
 *  mid-sentence, while a run that reached its own repeat count lets the final
 *  line finish. */
async function teardownRun(cancelSpeech: boolean): Promise<void> {
  // Flip local state first: a tick already in flight is then dropped by the
  // `running` guard even before the generation check gets to it.
  running = false;
  runningConfig = null;
  activeGeneration = -1;

  if (statusTimer !== null) {
    clearInterval(statusTimer);
    statusTimer = null;
  }

  if (cancelSpeech) window.speechSynthesis.cancel();

  try {
    await invoke("tts_repeater_stop_timer");
  } catch (err) {
    flash(`Couldn't stop the repeat timer: ${String(err)}`, "error");
  }

  syncRunningUI();
  renderStatus();
}

async function stopRepeating(reason?: string): Promise<void> {
  await teardownRun(true);
  if (reason) flash(reason, "success");
}

/** Speaks one repetition and applies the repeat-count limit. */
function emitUtterance(): void {
  if (!runningConfig) return;
  const config = runningConfig;
  const epoch = runEpoch;

  // "From the start of each message" mode: the schedule wins. If the previous
  // repetition is still being read when its interval is up, it gets cut off so
  // this one lands on time. Without this, a message longer than the interval
  // queues up behind itself and the backlog grows without bound, so the count
  // races ahead of what you've actually heard.
  if (config.timerBasis === "start") window.speechSynthesis.cancel();

  const utterance = speak(config, config.message);
  spokenCount++;

  if (config.repeatMode === "count" && spokenCount >= config.repeatCount) {
    const total = spokenCount;
    // The completion toast waits for the last repetition to FINISH speaking.
    // Firing it here would play the toast's notification sound over the very
    // message the run exists to deliver, you'd hear the chime instead of the
    // words. `end` and `error` are mutually exclusive per the spec, but a
    // synthesis engine that fires neither would otherwise swallow the toast
    // entirely, so both paths funnel through one latch.
    let announced = false;
    const announce = (): void => {
      if (announced) return;
      announced = true;
      // A new run began before this line finished (which also cancelled it),
      // reporting the old run as finished now would be about something the
      // user has already moved on from.
      if (runEpoch !== epoch || running) return;
      flash(`Finished: spoke ${total} time${total === 1 ? "" : "s"}.`, "success");
    };
    utterance.addEventListener("end", announce);
    utterance.addEventListener("error", announce);

    void teardownRun(false);
    return;
  }

  if (config.timerBasis === "end") {
    // The gap only starts once this reading is over, so the next tick is armed
    // from here rather than being on a schedule. Same one-shot latch as the
    // announce above, for the same reason: two re-arms would mean two timers.
    let rearmed = false;
    const rearm = (): void => {
      if (rearmed) return;
      rearmed = true;
      if (runEpoch !== epoch || !running) return;
      void armNextRepetition(config, epoch);
    };
    utterance.addEventListener("end", rearm);
    utterance.addEventListener("error", rearm);
  }

  renderStatus();
}

/** Schedules the single next repetition, for "after each message" mode. */
async function armNextRepetition(config: TtsConfig, epoch: number): Promise<void> {
  let generation: number;
  try {
    generation = await invoke<number>("tts_repeater_start_timer", {
      intervalMs: intervalMsOf(config),
      oneShot: true,
    });
  } catch (err) {
    // Nothing is scheduled now, so the run would hang silently, end it
    // loudly instead of leaving a Stop button attached to nothing.
    flash(`Repeater stopped: couldn't schedule the next message: ${String(err)}`, "error");
    void teardownRun(false);
    return;
  }

  // The await is a real gap: Stop (or another Start) can land inside it, and
  // the timer just created would then be orphaned and still tick.
  if (runEpoch !== epoch || !running) {
    void invoke("tts_repeater_stop_timer");
    return;
  }

  activeGeneration = generation;
  nextDueAt = Date.now() + intervalMsOf(config);
  renderStatus();
}

/* =============================================================================
   UI SYNC
============================================================================= */

/** Enables/disables everything that must not change mid-run, and repoints the
 *  Start button. Uses the disabled attribute plus a class hook rather than the
 *  original's inline backgroundColor, so themes stay in charge of the colours. */
function syncRunningUI(): void {
  const controls: (HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement)[] = [
    messageInput, intervalAmountInput, repeatCountInput, voiceSelect,
    rateInput, pitchInput, volumeInput, testBtn,
  ];
  controls.forEach((el) => { el.disabled = running; });
  document
    .querySelectorAll<HTMLButtonElement>("#tts-interval-unit .toggle-btn, #tts-repeat-mode .toggle-btn, #tts-timer-basis .toggle-btn")
    .forEach((btn) => { btn.disabled = running; });

  document.getElementById("tts-repeater-body")!.classList.toggle("tts-running", running);

  startBtn.textContent = running ? "Stop" : "Start";
  startBtn.classList.toggle("danger-btn", running);

  // Display View is offered only mid-run: its whole point is putting the
  // message that's currently being spoken on screen.
  displayBtn.style.display = running ? "" : "none";
  // Resetting the form under a live run would leave the run speaking a message
  // no longer shown anywhere, disabled rather than merely refused, so it
  // reads as unavailable instead of broken.
  resetBtn.disabled = running;

  // The sidebar dot is the only sign of a running repeater once you've
  // navigated away, which is the normal case for this tool.
  document
    .querySelector<HTMLElement>('.nav-item[data-tool="tts-repeater"]')
    ?.classList.toggle("tts-speaking", running);
}

/** Shows/hides the repeat-count field and refreshes the slider read-outs and
 *  character counter. Everything here is derived purely from the form. */
function syncDerivedUI(): void {
  repeatCountField.style.display =
    activeSegValue("tts-repeat-mode", "forever") === "count" ? "" : "none";

  rateValue.textContent = `${parseFloat(rateInput.value).toFixed(2)}×`;
  pitchValue.textContent = parseFloat(pitchInput.value).toFixed(2);
  volumeValue.textContent = `${Math.round(parseFloat(volumeInput.value) * 100)}%`;

  const used = messageInput.value.length;
  messageCount.textContent = `${used} / ${MESSAGE_MAX_CHARS}`;
  messageCount.classList.toggle("tts-count-over", used > MESSAGE_MAX_CHARS);
}

function formatInterval(config: TtsConfig): string {
  const unit = config.intervalUnit === "minutes" ? "minute" : "second";
  return `${config.intervalAmount} ${unit}${config.intervalAmount === 1 ? "" : "s"}`;
}

function renderStatus(): void {
  if (!running || !runningConfig) {
    statusEl.textContent = "Not running.";
    statusEl.classList.remove("tts-status-live");
    return;
  }

  const parts = [
    runningConfig.timerBasis === "start"
      ? `Speaking every ${formatInterval(runningConfig)}`
      : `${formatInterval(runningConfig)} between readings`,
  ];
  parts.push(
    runningConfig.repeatMode === "count"
      ? `${spokenCount} of ${runningConfig.repeatCount} spoken`
      : `${spokenCount} spoken`,
  );

  if (nextDueAt === 0) {
    // "After each message" mode, mid-reading. There is genuinely no deadline
    // to count down to yet.
    parts.push("reading now");
  } else {
    // Absolute deadline, so a throttled repaint while the window was hidden
    // shows the correct number as soon as it next runs rather than a stale one.
    parts.push(`next in ${formatRemaining(Math.max(0, nextDueAt - Date.now()))}`);
  }

  statusEl.textContent = parts.join(" · ");
  statusEl.classList.add("tts-status-live");
}

function formatRemaining(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/* =============================================================================
   SLIDER RAW ENTRY
   -----------------------------------------------------------------------------
   A slider is good for hunting a feel and useless for "exactly 1.35", and
   with rate spanning 0.1–10, one pixel of travel is a meaningful jump. Double-
   clicking a read-out swaps it for a number box; Enter or blur commits, Escape
   backs out. The typed value is clamped to the slider's own min/max, so the
   bounds are declared once, in the markup.
============================================================================= */

function bindSliderEntry(
  slider: HTMLInputElement,
  readout: HTMLElement,
  entry: HTMLInputElement,
  onCommit: () => void,
): void {
  const open = (): void => {
    if (slider.disabled) return;
    entry.value = slider.value;
    readout.hidden = true;
    entry.hidden = false;
    entry.focus();
    entry.select();
  };

  const close = (commit: boolean): void => {
    if (entry.hidden) return;
    if (commit) {
      const parsed = parseFloat(entry.value);
      if (Number.isFinite(parsed)) {
        const min = parseFloat(slider.min);
        const max = parseFloat(slider.max);
        slider.value = String(Math.min(max, Math.max(min, parsed)));
      }
    }
    entry.hidden = true;
    readout.hidden = false;
    onCommit();
  };

  readout.addEventListener("dblclick", open);
  entry.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      close(true);
    } else if (e.key === "Escape") {
      // Stop it here: Escape would otherwise reach the modal stack (Setup) or
      // close Display View out from under an edit.
      e.preventDefault();
      e.stopPropagation();
      close(false);
    }
  });
  entry.addEventListener("blur", () => close(true));
}

/* =============================================================================
   DISPLAY VIEW
   -----------------------------------------------------------------------------
   The message alone, filling the window, for putting "we'll be right back" on
   a stream without also broadcasting the tool that's saying it. Covers the
   sidebar and every other piece of app chrome by construction rather than by
   hiding things one at a time, which is also why it can't be left half-applied.
============================================================================= */

/** Paints the overlay (and the Setup modal's preview) from `display`.
 *
 *  Follow-theme mode sets NO inline colours at all. It hands off entirely to
 *  the .tts-display-themed rules, which resolve through the theme's own tokens
 *  (and the --tts-display-* hooks over them). That's what lets a theme change
 *  mid-run, Cycle mode included, repaint the overlay live, and what makes the
 *  glow and pulse look like the rest of the app rather than a generic effect
 *  bolted on top. Custom mode is the opposite by design: two exact colours,
 *  flat, no effects. */
function applyDisplayAppearance(root: HTMLElement, textEl: HTMLElement): void {
  const themed = display.look !== "custom";

  root.classList.toggle("tts-display-themed", themed);
  root.style.background = themed ? "" : display.bgColor;
  textEl.style.color = themed ? "" : display.textColor;

  // Only ever removes: the glow itself arrives from the theme's own
  // .tool-view-title rule, so "on" is simply not interfering with it.
  textEl.classList.toggle("tts-display-noglow", !display.glow);
  // The font-relative amplifier, gated on the theme actually having a glow so
  // it can only ever strengthen one, never invent one.
  textEl.classList.toggle("tts-display-themeglow", themed && display.glow && themeHasGlow());

  textEl.style.textAlign = display.align;
  textEl.style.fontSize = `${display.fontSize}px`;
}

/** Whether the active theme puts a glow on its header titles, measured off a
 *  hidden probe wearing the same class rather than hard-coded per theme,
 *  custom themes from the theme editor get the right answer too. */
function themeHasGlow(): boolean {
  const probe = document.getElementById("tts-glow-probe");
  if (!probe) return false;
  const shadow = getComputedStyle(probe).textShadow;
  return shadow !== "" && shadow !== "none";
}

/** Reveals the exit button (and the mouse cursor) then hides both again once
 *  the pointer settles. An arrow parked in the middle of a "we'll be back"
 *  card is as much of a giveaway as the button is. */
function nudgeDisplayExit(): void {
  displayExitBtn.classList.add("tts-display-exit-visible");
  displayOverlay.classList.remove("tts-display-idle");
  if (displayExitTimer !== null) clearTimeout(displayExitTimer);
  displayExitTimer = setTimeout(() => {
    displayExitTimer = null;
    displayExitBtn.classList.remove("tts-display-exit-visible");
    displayOverlay.classList.add("tts-display-idle");
  }, DISPLAY_EXIT_IDLE_MS);
}

function openDisplayView(): void {
  // runningConfig is the source while a run is live so the screen shows what's
  // actually being spoken, not a message edited since. It can be null if the
  // run ended between render and click, hence the form fallback.
  displayTextEl.textContent = runningConfig?.message ?? messageInput.value;
  applyDisplayAppearance(displayOverlay, displayTextEl);
  displayOverlay.style.display = "flex";
  displayOpen = true;
  // The overlay sits above every normal layer, so a running seasonal effect
  // would be hidden behind it. Lifting the canvas is what puts the snow (or
  // lightning, or fireworks) on the card, a big part of what a theme IS.
  setSeasonalCanvasElevated(display.look !== "custom" && display.animate);
  // Show the way out once on entry, then let it fade, otherwise the first
  // thing a new user does is wonder how to get back.
  nudgeDisplayExit();
}

function closeDisplayView(): void {
  if (!displayOpen) return;
  displayOpen = false;
  displayOverlay.style.display = "none";
  setSeasonalCanvasElevated(false);
  if (displayExitTimer !== null) {
    clearTimeout(displayExitTimer);
    displayExitTimer = null;
  }
  displayExitBtn.classList.remove("tts-display-exit-visible");
  displayOverlay.classList.remove("tts-display-idle");
}

/* =============================================================================
   SETUP MODAL  (Display View appearance)
============================================================================= */

function getSetupModal(): Modal {
  if (!setupModal) {
    setupModal = new Modal(document.getElementById("tts-setup-backdrop")!, {
      onOpen: () => {
        applyDisplayToSetupForm();
        syncSetupUI();
      },
    });
    document.getElementById("tts-setup-close")!.addEventListener("click", () => {
      setupModal!.close();
    });

    document
      .querySelectorAll<HTMLButtonElement>("#tts-display-look .toggle-btn, #tts-display-align .toggle-btn")
      .forEach((btn) => {
        btn.addEventListener("click", () => {
          btn.parentElement!.querySelectorAll<HTMLButtonElement>(".toggle-btn")
            .forEach((b) => b.classList.toggle("active", b === btn));
          commitDisplaySettings();
        });
      });

    [displayBgInput, displayFgInput, displaySizeInput].forEach((el) => {
      el.addEventListener("input", commitDisplaySettings);
    });
    [displayGlowToggle, displayAnimateToggle].forEach((el) => {
      el.addEventListener("change", commitDisplaySettings);
    });

    bindSliderEntry(displaySizeInput, displaySizeValue, displaySizeEntry, commitDisplaySettings);

    document.getElementById("tts-display-reset-btn")!.addEventListener("click", () => {
      display = { ...DEFAULT_DISPLAY };
      applyDisplayToSetupForm();
      syncSetupUI();
      void saveStore();
      flash("Display View appearance reset", "success");
    });
  }
  return setupModal;
}

/** Writes the Setup form back into `display`, then repaints everything that
 *  renders from it. The preview, and a Display View that's already up. */
function commitDisplaySettings(): void {
  display = normalizeDisplay({
    look: activeSegValue("tts-display-look", "theme") as TtsDisplaySettings["look"],
    bgColor: displayBgInput.value,
    textColor: displayFgInput.value,
    align: activeSegValue("tts-display-align", "center") as TtsDisplaySettings["align"],
    fontSize: parseInt(displaySizeInput.value, 10),
    glow: displayGlowToggle.checked,
    animate: displayAnimateToggle.checked,
  });
  syncSetupUI();
  void saveStore();
}

/** Pushes `display` into the Setup form controls. */
function applyDisplayToSetupForm(): void {
  setSegValue("tts-display-look", display.look);
  setSegValue("tts-display-align", display.align);
  displayBgInput.value = display.bgColor;
  displayFgInput.value = display.textColor;
  displaySizeInput.value = String(display.fontSize);
  displayGlowToggle.checked = display.glow;
  displayAnimateToggle.checked = display.animate;
}

/** Derived Setup UI: the custom-colour row's visibility, the size read-out,
 *  and the live preview. */
function syncSetupUI(): void {
  displayCustomRow.style.display = display.look === "custom" ? "" : "none";
  displayEffectsRow.style.display = display.look === "custom" ? "none" : "";

  // Both toggles depend on the ACTIVE theme actually having the thing they
  // switch. Rather than greying them out (which reads as "broken") they stay
  // usable and the note says why nothing will change. Re-checked on every
  // themechange, so Cycle mode keeps these honest.
  glowNote.textContent = themeHasGlow() ? "" : "This theme has no glow.";
  animateNote.textContent = isSeasonalEffectRunning()
    ? "Plays over Display View."
    : "This theme has no animation running.";

  displaySizeValue.textContent = `${display.fontSize}px`;

  applyDisplayAppearance(displayPreview, displayPreviewText);
  // The preview box is a fraction of the window's height, so the real font
  // size would overflow it instantly. Scaling by the same ratio keeps the
  // preview honest about proportion, which is the part being judged.
  displayPreviewText.style.fontSize = `${Math.max(8, display.fontSize * 0.28)}px`;

  const message = (runningConfig?.message ?? messageInput.value).trim();
  displayPreviewText.textContent = message || "We'll be right back!";
}

/* =============================================================================
   PRESETS
============================================================================= */

function getPresetsModal(): Modal {
  if (!presetsModal) {
    // The name field is deliberately NOT cleared on open: this modal is
    // re-opened every time the delete-confirm closes, and wiping a half-typed
    // name on the way back would be its own small bug. saveCurrentAsPreset()
    // clears it on success, which is the only moment it's actually stale.
    presetsModal = new Modal(document.getElementById("tts-presets-backdrop")!, {
      onOpen: renderPresetList,
    });
    document.getElementById("tts-presets-close")!.addEventListener("click", () => {
      presetsModal!.close();
    });
    document.getElementById("tts-preset-save-btn")!.addEventListener("click", saveCurrentAsPreset);
    presetNameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        saveCurrentAsPreset();
      }
    });
  }
  return presetsModal;
}

function getPresetDeleteModal(): Modal {
  if (!presetDeleteModal) {
    presetDeleteModal = new Modal(document.getElementById("tts-preset-delete-backdrop")!, {
      replaceModal: getPresetsModal(),
      // Whichever way this modal closes (Delete, Cancel or Escape) the
      // presets list comes back; it's a step inside that flow, not a
      // destination. Clearing the pending id here rather than per-button
      // covers the Escape route too.
      onClosed: () => {
        pendingDeleteId = null;
        getPresetsModal().open();
      },
    });
    document.getElementById("tts-preset-delete-cancel")!.addEventListener("click", () => {
      presetDeleteModal!.close();
    });
    document.getElementById("tts-preset-delete-confirm")!.addEventListener("click", () => {
      const preset = presets.find((p) => p.id === pendingDeleteId);
      presets = presets.filter((p) => p.id !== pendingDeleteId);
      void saveStore();
      renderPresetList();
      presetDeleteModal!.close();
      flash(preset ? `Deleted "${preset.name}".` : "Preset deleted.", "success");
    });
  }
  return presetDeleteModal;
}

function saveCurrentAsPreset(): void {
  const name = presetNameInput.value.trim();
  if (!name) {
    flash("Give the preset a name", "error");
    return;
  }

  const config = readConfig();
  const error = validateConfig(config);
  if (error) {
    // Saving a preset you can't run would just defer the error to load time.
    flash(error, "error");
    return;
  }

  // Same name = update that preset. Two presets with one name is never what
  // someone means, and this makes "tweak and re-save" the obvious gesture.
  const existing = presets.find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    Object.assign(existing, config, { name });
    flash(`Updated "${name}".`, "success");
  } else {
    presets.push({ id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`, name, ...config });
    flash(`Saved "${name}".`, "success");
  }

  presets.sort((a, b) => a.name.localeCompare(b.name));
  presetNameInput.value = "";
  void saveStore();
  renderPresetList();
}

function loadPreset(id: string): void {
  const preset = presets.find((p) => p.id === id);
  if (!preset) return;

  if (running) {
    flash("Stop the repeater before loading a preset", "error");
    return;
  }

  applyConfig(normalizeConfig(preset));
  void saveStore();
  getPresetsModal().close();
  flash(`Loaded "${preset.name}".`, "success");
}

function presetSummary(preset: TtsPreset): string {
  const bits = [`every ${formatInterval(preset)}`];
  bits.push(preset.repeatMode === "count" ? `${preset.repeatCount}×` : "forever");
  const voice = voices.find((v) => v.voiceURI === preset.voiceUri);
  bits.push(voice ? voice.name : "system default voice");
  return bits.join(" · ");
}

function renderPresetList(): void {
  presetListEl.innerHTML = "";

  if (presets.length === 0) {
    const empty = document.createElement("p");
    empty.className = "placeholder-text";
    empty.textContent = "No presets yet. Set up a message above, then save it here with a name.";
    presetListEl.appendChild(empty);
    return;
  }

  presets.forEach((preset) => {
    const row = document.createElement("div");
    row.className = "tts-preset-row";
    // Name, message and summary all carry user text (and a preset can arrive
    // from a hand-edited data file), so all three are escaped.
    row.innerHTML = `
      <div class="tts-preset-info">
        <span class="tts-preset-name">${escapeHtml(preset.name)}</span>
        <span class="tts-preset-message">${escapeHtml(preset.message)}</span>
        <span class="tts-preset-summary">${escapeHtml(presetSummary(preset))}</span>
      </div>
      <div class="tts-preset-actions">
        <button class="tts-preset-load">Load</button>
        <button class="tts-preset-delete modal-cancel-btn" title="Delete preset">Delete</button>
      </div>
    `;
    row.querySelector<HTMLButtonElement>(".tts-preset-load")!
      .addEventListener("click", () => loadPreset(preset.id));
    row.querySelector<HTMLButtonElement>(".tts-preset-delete")!
      .addEventListener("click", () => {
        pendingDeleteId = preset.id;
        document.getElementById("tts-preset-delete-message")!.textContent =
          `Permanently delete the preset "${preset.name}"? This can't be undone.`;
        getPresetDeleteModal().open();
      });
    presetListEl.appendChild(row);
  });
}

/* =============================================================================
   RESET
============================================================================= */

function handleReset(): void {
  if (running) {
    flash("Stop the repeater before resetting", "error");
    return;
  }
  applyConfig({ ...DEFAULT_CONFIG });
  void saveStore();
  flash("Tool reset", "success");
}

/* =============================================================================
   INIT
============================================================================= */

export function initTTSRepeater(): void {
  messageInput = document.getElementById("tts-message") as HTMLTextAreaElement;
  messageCount = document.getElementById("tts-message-count")!;
  intervalAmountInput = document.getElementById("tts-interval-amount") as HTMLInputElement;
  repeatCountInput = document.getElementById("tts-repeat-count") as HTMLInputElement;
  repeatCountField = document.getElementById("tts-repeat-count-field")!;
  voiceSelect = document.getElementById("tts-voice") as HTMLSelectElement;
  rateInput = document.getElementById("tts-rate") as HTMLInputElement;
  pitchInput = document.getElementById("tts-pitch") as HTMLInputElement;
  volumeInput = document.getElementById("tts-volume") as HTMLInputElement;
  rateValue = document.getElementById("tts-rate-value")!;
  pitchValue = document.getElementById("tts-pitch-value")!;
  volumeValue = document.getElementById("tts-volume-value")!;
  testBtn = document.getElementById("tts-test-btn") as HTMLButtonElement;
  startBtn = document.getElementById("tts-start-btn") as HTMLButtonElement;
  statusEl = document.getElementById("tts-status")!;
  presetNameInput = document.getElementById("tts-preset-name") as HTMLInputElement;
  presetListEl = document.getElementById("tts-preset-list")!;
  displayBtn = document.getElementById("tts-display-btn") as HTMLButtonElement;
  resetBtn = document.getElementById("tts-reset-btn") as HTMLButtonElement;

  displayOverlay = document.getElementById("tts-display-overlay")!;
  displayTextEl = document.getElementById("tts-display-text")!;
  displayExitBtn = document.getElementById("tts-display-exit") as HTMLButtonElement;
  displayBgInput = document.getElementById("tts-display-bg") as HTMLInputElement;
  displayFgInput = document.getElementById("tts-display-fg") as HTMLInputElement;
  displayCustomRow = document.getElementById("tts-display-custom-row")!;
  displayEffectsRow = document.getElementById("tts-display-effects-row")!;
  displayGlowToggle = document.getElementById("tts-display-glow") as HTMLInputElement;
  displayAnimateToggle = document.getElementById("tts-display-animate") as HTMLInputElement;
  glowNote = document.getElementById("tts-glow-note")!;
  animateNote = document.getElementById("tts-animate-note")!;
  displaySizeInput = document.getElementById("tts-display-size") as HTMLInputElement;
  displaySizeValue = document.getElementById("tts-display-size-value")!;
  displaySizeEntry = document.getElementById("tts-display-size-entry") as HTMLInputElement;
  displayPreview = document.getElementById("tts-display-preview")!;
  displayPreviewText = document.getElementById("tts-display-preview-text")!;

  messageInput.maxLength = MESSAGE_MAX_CHARS;

  refreshVoiceOptions();
  // Fires once the platform voice list is ready (and again if it changes).
  // Without it, a cold start shows nothing but "System default".
  window.speechSynthesis.addEventListener("voiceschanged", refreshVoiceOptions);

  /* ── Segmented toggles ── */
  document
    .querySelectorAll<HTMLButtonElement>("#tts-interval-unit .toggle-btn, #tts-repeat-mode .toggle-btn, #tts-timer-basis .toggle-btn")
    .forEach((btn) => {
      btn.addEventListener("click", () => {
        const group = btn.parentElement!;
        group.querySelectorAll<HTMLButtonElement>(".toggle-btn")
          .forEach((b) => b.classList.toggle("active", b === btn));
        syncDerivedUI();
        queueSaveSettings();
      });
    });

  /* ── Live read-outs + persistence ── */
  [rateInput, pitchInput, volumeInput].forEach((slider) => {
    slider.addEventListener("input", () => {
      syncDerivedUI();
      queueSaveSettings();
    });
  });

  /* ── Double-click a read-out to type an exact value ── */
  ([
    [rateInput, rateValue, "tts-rate-entry"],
    [pitchInput, pitchValue, "tts-pitch-entry"],
    [volumeInput, volumeValue, "tts-volume-entry"],
  ] as const).forEach(([slider, readout, entryId]) => {
    bindSliderEntry(slider, readout, document.getElementById(entryId) as HTMLInputElement, () => {
      syncDerivedUI();
      queueSaveSettings();
    });
  });
  messageInput.addEventListener("input", () => {
    syncDerivedUI();
    queueSaveSettings();
  });
  [intervalAmountInput, repeatCountInput, voiceSelect].forEach((el) => {
    el.addEventListener("change", queueSaveSettings);
  });

  /* ── Actions ── */
  testBtn.addEventListener("click", () => {
    const config = readConfig();
    // Test speaks regardless of interval/repeat validity, it's only checking
    // how the voice sounds, and blocking it on an empty interval would be odd.
    window.speechSynthesis.cancel();
    speak(config, config.message.trim() || TEST_FALLBACK_TEXT);
  });

  startBtn.addEventListener("click", () => {
    if (running) void stopRepeating("Repeater stopped.");
    else void startRepeating();
  });

  document.getElementById("tts-presets-btn")!.addEventListener("click", () => {
    getPresetsModal().open();
  });
  document.getElementById("tts-setup-btn")!.addEventListener("click", () => {
    getSetupModal().open();
  });
  resetBtn.addEventListener("click", handleReset);

  /* ── Display View ── */
  displayBtn.addEventListener("click", openDisplayView);
  displayExitBtn.addEventListener("click", closeDisplayView);
  displayOverlay.addEventListener("pointermove", nudgeDisplayExit);
  // Escape is handled here rather than through Modal: the overlay isn't a
  // modal (no backdrop, and it sits above the toast layer), so the shared
  // open-stack never sees it. Modal's own Escape handler only fires when that
  // stack is non-empty, and Display View can't be entered with a modal open,
  // so the two never contend.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && displayOpen) {
      e.preventDefault();
      closeDisplayView();
    }
  });

  // Ctrl+Enter from the message box starts/stops, so a message can be set
  // going without reaching for the mouse.
  messageInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      startBtn.click();
    }
  });

  /* ── Tick from the Rust timer ── */
  listen<number>("tts-repeater-tick", (event) => {
    // Two guards, both load-bearing: `running` drops ticks that raced a Stop,
    // and the generation check drops a dying thread's final tick after a fast
    // stop→start has already begun a new run.
    if (!running || event.payload !== activeGeneration) return;
    if (runningConfig!.timerBasis === "start") {
      nextDueAt = Date.now() + intervalMsOf(runningConfig!);
    } else {
      // The one-shot has fired and its thread has exited. Nothing is scheduled
      // again until this reading ends and emitUtterance re-arms.
      nextDueAt = 0;
      activeGeneration = -1;
    }
    emitUtterance();
  }).catch(() => {});

  // Belt and braces for a dev reload: the process dying takes the Rust thread
  // and the speech queue with it, but a reload leaves the queue mid-sentence.
  window.addEventListener("beforeunload", () => {
    window.speechSynthesis.cancel();
  });

  // A theme swap changes what the preview should show and whether the glow /
  // animation notes still apply. Cycle mode can do that at any moment,
  // including while Setup is open.
  window.addEventListener("themechange", () => {
    // Colours and the theme's own glow follow the new stylesheet on their own;
    // the amplifier class doesn't, because whether the new theme HAS a glow is
    // a measured fact rather than a CSS one.
    if (displayOpen) applyDisplayAppearance(displayOverlay, displayTextEl);
    if (setupModal?.isOpen) syncSetupUI();
  });

  applyDisplayToSetupForm();
  syncSetupUI();
  syncDerivedUI();
  syncRunningUI();
  renderStatus();
  void loadStore();
}
