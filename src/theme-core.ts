/* =============================================================================
   THEME CORE  — applyTheme() dispatcher + seasonal canvas effects
   -----------------------------------------------------------------------------
   Owns applyTheme() (the single entry point for switching to a named theme,
   Random, or a Custom theme) and the seasonal canvas animations (Christmas
   snow, Halloween lightning, Thanksgiving leaves, Halo swirl, Valentine
   hearts, Patriot fireworks, Mardi Gras beads, Rainbow sparkle trail). Also
   owns `_activeCustomId` — which custom theme (if any) is currently active —
   since that's fundamentally theme-selection state, not shell chrome.

   Split out of shell.ts (Tier 6). Genuinely two-way coupled with
   theme-editor.ts: this file calls applyCustomThemeById()/clearCustomTheme()
   (theme-editor.ts owns custom-theme storage), and theme-editor.ts calls
   applyTheme() (e.g. to revert a live preview). Standard ES module circular
   import — both directions are plain function references only invoked from
   event handlers/later calls, never at module top-level, so load order is
   never actually a problem. Flagging it here so it isn't a surprise later.
============================================================================= */

import { settings } from "./shell";
import {
  PERSISTENT_RANDOM_KEY,
  applyPalette,
  clearRandomPalette,
  generateChaoticPalette,
  generateRandomPalette,
} from "./random-theme";
import { applyCustomThemeById, clearCustomTheme } from "./theme-editor";
import { activateCycleTheme, getCurrentCycleUnderlyingThemeId } from "./cycle-theme";

export const themeLink = document.getElementById("themeLink") as HTMLLinkElement;

/** Builds the URL for a theme's CSS file, stamped with the current build id.
 *  Theme CSS is swapped at runtime via themeLink.href rather than flowing
 *  through Vite's module graph, so it never gets a content hash like
 *  shell.css etc. do — without a cache-busting query string, WebView2's HTTP
 *  cache keeps serving old theme CSS after an in-place app update, since the
 *  URL never changes even though the file on disk did. Every place that sets
 *  themeLink.href (or fetches a theme's CSS directly) should go through this. */
export function themeCssUrl(themeId: string): string {
  return `/themes/${themeId}.css?v=${__BUILD_ID__}`;
}

/** Which custom theme (if any) is currently active. Theme-selection state —
 *  owned here rather than in theme-editor.ts's storage/editing logic. Mutate
 *  only through setActiveCustomId(); the binding itself is exported read-only
 *  (live ES-module bindings update automatically for importers). */
let _activeCustomId: string | null = null;

export function getActiveCustomId(): string | null {
  return _activeCustomId;
}

export function setActiveCustomId(id: string | null): void {
  _activeCustomId = id;
}

/** Applies a named theme, the random palette system, or a custom theme.
 *  For standard themes: loads the CSS file and clears any leftover inline
 *  random overrides. For "random": generates and applies a palette immediately
 *  (persistent reuses the stored palette; regenerative always generates fresh).
 *  For "custom": applies the selected custom theme by id. */
export function applyTheme(themeName: string): void {
  if (themeName === "custom") {
    themeLink.href = themeCssUrl("default");
    themeLink.onload = () => {
      if (_activeCustomId) applyCustomThemeById(_activeCustomId);
    };
    if (_activeCustomId) applyCustomThemeById(_activeCustomId);
    return;
  }

  if (themeName === "cycle") {
    activateCycleTheme();
    return;
  }

  if (themeName === "random") {
    const generator = settings.randomHarmonized
      ? generateRandomPalette
      : generateChaoticPalette;
    if (settings.randomPersistent) {
      // Persistent: reuse stored palette, generate+store if none exists
      let palette: Record<string, string>;
      const stored = localStorage.getItem(PERSISTENT_RANDOM_KEY);
      if (stored) {
        try {
          palette = JSON.parse(stored);
        } catch {
          palette = generator();
        }
      } else {
        palette = generator();
      }
      localStorage.setItem(PERSISTENT_RANDOM_KEY, JSON.stringify(palette));
      themeLink.href = themeCssUrl("default");
      themeLink.onload = () => applyPalette(palette);
      applyPalette(palette);
    } else {
      // Regenerative: generate fresh every time applyTheme is called
      const palette = generator();
      themeLink.href = themeCssUrl("default");
      themeLink.onload = () => applyPalette(palette);
      applyPalette(palette);
    }
    return;
  }

  // Standard theme: load CSS first, clear inline overrides once ready.
  // clearRandomPalette() is called immediately AND on onload because if the new
  // href is the same as the current one (e.g. switching from Random to Default,
  // both of which use default.css as a base), the browser won't fire onload.
  localStorage.removeItem(PERSISTENT_RANDOM_KEY);
  themeLink.href = themeCssUrl(themeName);
  themeLink.onload = () => {
    clearRandomPalette();
    clearCustomTheme();
    // CSS file is now loaded and :root vars are live — notify tools.
    window.dispatchEvent(new CustomEvent("themechange"));
  };
  clearRandomPalette();
  clearCustomTheme();
}

/* =============================================================================
   SEASONAL THEME EFFECTS  (Christmas snow / Halloween lightning)
   -----------------------------------------------------------------------------
   Canvas-based instead of CSS keyframes so each flake/bolt is genuinely
   independent: no shared "loop" for the whole layer to visibly snap back on,
   and shapes/timing can be randomized per-instance instead of picked from a
   handful of fixed keyframe steps. One shared full-window canvas, appended as
   the LAST child of <body> so it always paints above ordinary content
   (including panels, which was the complaint with the old body::before/::after
   version) while staying below the toast/lock-screen layer (z-index 9999+).
   pointer-events stays off throughout, so nothing here can ever block a click.
============================================================================= */

interface Snowflake {
  x: number;
  y: number;
  r: number;
  speed: number;
  drift: number;
  driftPhase: number;
  driftFreq: number;
  wanderVel: number;
}

interface LightningStrike {
  points: { x: number; y: number }[];
  branches: { x: number; y: number }[][];
  bornAt: number;
  lifespanMs: number;
}

interface Leaf {
  x: number;
  y: number; // baseline y — actual draw position adds a sinusoidal bob on top
  rotation: number;
  rotationSpeed: number;
  speed: number; // px/sec, left to right
  size: number;
  color: string;
  bobPhase: number;
  bobFreq: number;
  bobAmp: number;
}

interface HeartParticle {
  x: number;
  y: number;
  vy: number; // gentle upward float, px/sec
  rotation: number;
  size: number; // base size — actual drawn size is this times the scale curve below
  maxScale: number; // how big it grows relative to `size` at the peak of its life (1.15-2.0, randomized per heart)
  color: string;
  bornAt: number;
  lifespanMs: number;
}

let seasonalCanvas: HTMLCanvasElement | null = null;
let seasonalCtx: CanvasRenderingContext2D | null = null;
let seasonalAnimationId: number | null = null;
let seasonalResizeHandler: (() => void) | null = null;
let seasonalMouseMoveHandler: ((e: MouseEvent) => void) | null = null;
let seasonalMouseDownHandler: ((e: MouseEvent) => void) | null = null;
let seasonalClickHandler: ((e: MouseEvent) => void) | null = null;
let seasonalActiveTheme: string | null = null;

let snowflakes: Snowflake[] = [];
let snowPile: number[] = [];
const SNOW_PILE_COLUMN_WIDTH = 5; // px per accumulation bucket along the bottom edge
const SNOW_PILE_MAX_HEIGHT = 100; // px cap — settles into a bank instead of swallowing the UI
const SNOW_MAX_SLOPE = 1.5; // px — max height difference tolerated between adjacent columns before it slides
const SNOW_RELAX_PASSES = 4; // relaxation sweeps per frame; alternates direction, see relaxSnowPile()
const SNOW_WANDER_ACCEL = 55; // px/sec² — magnitude of the random gust nudges applied to wanderVel each frame
const SNOW_WANDER_DAMPING = 0.86; // per-frame decay applied to wanderVel so gusts settle instead of accumulating forever

let lightningStrikes: LightningStrike[] = [];
let lightningTimeoutId: number | null = null;
/** Pending double-strike timers. Unlike lightningTimeoutId (the scheduler,
 *  of which exactly one is ever in flight), several of these can overlap —
 *  each strike independently rolls for a quick restrike. They're collected
 *  so stopSeasonalEffect() can cancel every one; an untracked timer that
 *  fires after teardown would push onto the cleared lightningStrikes array
 *  with no animation loop left to drain it. */
let lightningRestrikeTimeouts: number[] = [];
const LIGHTNING_DARKEN_STRENGTH = 0.4; // how far the screen dims at peak flash brightness, so bolts pop by contrast

let leaves: Leaf[] = [];
let leafTimeoutId: number | null = null;
const LEAF_COLORS = ["#e8631f", "#c22a1e", "#ff8a3f", "#e8b93d", "#8b5a2e", "#d9432a"]; // burnt orange / deep red / bright orange / gold / saddle-brown / tomato — matches thanksgiving.css's chart palette
const LEAF_GUST_MIN_MS = 30_000;
const LEAF_GUST_MAX_MS = 60_000; // gusts land 30-60s apart, randomized each time

let heartParticles: HeartParticle[] = [];
const HEART_COLORS = ["#e0294b", "#ff2d78", "#c9184a", "#ff6f9c"]; // crimson / hot pink / deep pink / blush — matches valentine.css

let fireworkRockets: FireworkRocket[] = [];
let fireworkSparks: FireworkSpark[] = [];
let fireworkFlashes: number[] = []; // bornAt timestamps of recent bursts, driving the darken-on-burst overlay
let fireworkTimeoutId: number | null = null;
const FIREWORK_COLORS_PATRIOT = ["#FF0000", "#0000FF", "#ffffff"]; // Old Glory Red / Old Glory Blue (official US flag hex values) / white
const FIREWORK_COLORS_RAINBOW = ["#ff0000", "#ff7f00", "#ffff00", "#00ff00", "#00ffff", "#0000ff", "#7f00ff", "#ff007f", "#ffffff"]; // full multi-colored spark palette — also what "single" bursts draw their one color from
const FIREWORK_GOLDEN_ANGLE = 2.399963229728653; // radians — used to space points evenly across a disc/star for the dot-matrix shapes
const FIREWORK_GRAVITY = 260; // px/sec² — pulls the rising rocket back down; it bursts the moment this crosses back past 0 (apex)
const FIREWORK_SPARK_GRAVITY = 140; // px/sec² — lighter fall for the burst sparks
const FIREWORK_DARKEN_STRENGTH = 0.35; // how far the screen dims at peak burst brightness, so sparks pop by contrast
const FIREWORK_FLASH_DURATION_MS = 6600; // how long the darken overlay takes to fully dissipate after a burst — 2x the previous duration, to stay lit through the now much longer-lived sparks
const FIREWORK_LAUNCH_MIN_MS = 3600;
const FIREWORK_LAUNCH_MAX_MS = 14000; // launches land 7.2-28s apart, randomized each time — half the previous cadence

interface FireworkRocket {
  x: number;
  y: number;
  vx: number;
  vy: number; // negative = rising; gravity pulls this back toward 0, and it bursts the moment it crosses back past 0 (apex)
  trail: { x: number; y: number }[]; // recent positions, drawn as a fading spark tail
}

interface FireworkSpark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  bornAt: number;
  lifespanMs: number;
}

interface SwirlParticle {
  x: number;
  y: number;
  vx: number; // px/sec
  vy: number; // px/sec
  age: number; // seconds since spawn
  maxLife: number; // seconds
}

let swirlParticles: SwirlParticle[] = [];
let swirlDotPattern: CanvasPattern | null = null;
const SWIRL_RGB = "111, 160, 224"; // #6fa0e0 — matches this theme's --color-btn (halo.css), sampled off the Halo 3 menu's blue
const SWIRL_GRID = 5; // px — dot-grid cell size; particles snap to it so the glow reads as lit pixels, not a blob
const SWIRL_DOT_RADIUS = 2.4; // px — reactive dot size, deliberately bigger than the ambient grid's own dots
const SWIRL_SPAWN_JITTER = 26; // px — spread applied around the cursor's motion path when spawning particles
const SWIRL_MAX_PARTICLES = 1600; // hard cap so a frantic mouse can't runaway the particle count
const SWIRL_VORTEX_ACCEL = 55; // px/sec² — force perpendicular to velocity that curls particles into little swirls
const SWIRL_DRAG = 0.92; // per-frame (at 60fps) velocity damping
const SWIRL_HALO_RADIUS = 110; // px — soft glow pool, sized around the cursor while it's moving
// Per-frame (at 60fps) decay of the halo's movement-driven visibility — the
// knob to turn if the glow should linger longer (closer to 1) or vanish
// faster (closer to 0) after the cursor stops. At 0.93 the halo fades to
// ~1% opacity roughly 1 second after the last mousemove.
const SWIRL_ACTIVITY_DECAY = 0.93;
// Anchors the halo/particle origin a little off the literal cursor
// coordinate — always opposite whichever direction the cursor last moved,
// so the glow trails behind the cursor no matter which way it's travelling
// instead of sitting fixed to one side (which reads wrong once the cursor
// heads toward that side).
const SWIRL_ORIGIN_OFFSET = 30; // px

interface BeadStrand {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rotation: number;
  rotationSpeed: number;
  color: string;
  beadCount: number;
  beadSpacing: number; // px between bead centers along the strand
  beadRadius: number;
  bounces: number; // bounces left before this strand resets to the top
}

let beadStrands: BeadStrand[] = [];
const BEAD_COLORS = ["#7b2fbe", "#00a550", "#ffd700"]; // purple / green / gold — the traditional Mardi Gras trio, matches mardi-gras.css
const BEAD_GRAVITY = 460; // px/sec² — heavier fall than snow, so beads read as solid plastic rather than drifting flakes
const BEAD_BOUNCE_DAMPING = 0.45; // velocity kept per bounce — a couple of shrinking bounces, not endless

interface SparkleParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number; // seconds since spawn
  maxLife: number; // seconds
  size: number;
  hue: number; // 0-360
  rotation: number;
  rotationSpeed: number;
}

let sparkleParticles: SparkleParticle[] = [];
let sparkleHueCursor = 0; // advances with every spawn so consecutive trail particles step through the spectrum
const SPARKLE_HUE_STEP = 14; // degrees advanced per spawn — full spectrum cycles roughly every ~26 spawns
const SPARKLE_MAX_PARTICLES = 900; // raised well above the Halo swirl's cap — a much longer-lived trail keeps far more particles alive at once
const SPARKLE_ORIGIN_OFFSET = 26; // px — same "anchor opposite the direction of travel" trick as the Halo swirl, so the trail lags behind the cursor instead of centering on it

/** Creates (once) and returns the shared full-window canvas + context used by
 *  both seasonal effects, resizing it to the current window/DPR each call. */
function ensureSeasonalCanvas(): { ctx: CanvasRenderingContext2D } {
  if (!seasonalCanvas) {
    seasonalCanvas = document.createElement("canvas");
    seasonalCanvas.id = "seasonalEffectsCanvas";
    seasonalCanvas.style.position = "fixed";
    seasonalCanvas.style.inset = "0";
    seasonalCanvas.style.width = "100vw";
    seasonalCanvas.style.height = "100vh";
    seasonalCanvas.style.pointerEvents = "none";
    seasonalCanvas.style.zIndex = "5000";
    document.body.appendChild(seasonalCanvas);
  }
  const ctx = seasonalCanvas.getContext("2d");
  if (!ctx)
    throw new Error("2d canvas context unavailable for seasonal effects");
  seasonalCtx = ctx;
  resizeSeasonalCanvas();
  return { ctx };
}

/** Sizes the canvas's backing store to the window at the current device pixel
 *  ratio so flakes/bolts stay crisp on high-DPI displays, and re-applies the
 *  DPR transform (resizing a canvas element always resets its context). */
function resizeSeasonalCanvas(): void {
  if (!seasonalCanvas || !seasonalCtx) return;
  const dpr = window.devicePixelRatio || 1;
  seasonalCanvas.width = Math.round(window.innerWidth * dpr);
  seasonalCanvas.height = Math.round(window.innerHeight * dpr);
  seasonalCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

/** Tears down whichever seasonal effect is currently running: cancels the
 *  animation frame and any pending strike timers, drops the resize/mousemove
 *  listeners, and removes the canvas entirely. Called before starting a new
 *  effect and whenever the active theme stops being one that has an effect. */
function stopSeasonalEffect(): void {
  if (seasonalAnimationId !== null) {
    cancelAnimationFrame(seasonalAnimationId);
    seasonalAnimationId = null;
  }
  if (lightningTimeoutId !== null) {
    window.clearTimeout(lightningTimeoutId);
    lightningTimeoutId = null;
  }
  for (const id of lightningRestrikeTimeouts) window.clearTimeout(id);
  lightningRestrikeTimeouts = [];
  if (leafTimeoutId !== null) {
    window.clearTimeout(leafTimeoutId);
    leafTimeoutId = null;
  }
  if (fireworkTimeoutId !== null) {
    window.clearTimeout(fireworkTimeoutId);
    fireworkTimeoutId = null;
  }
  if (seasonalResizeHandler) {
    window.removeEventListener("resize", seasonalResizeHandler);
    seasonalResizeHandler = null;
  }
  if (seasonalMouseMoveHandler) {
    window.removeEventListener("mousemove", seasonalMouseMoveHandler);
    seasonalMouseMoveHandler = null;
  }
  if (seasonalMouseDownHandler) {
    window.removeEventListener("mousedown", seasonalMouseDownHandler);
    seasonalMouseDownHandler = null;
  }
  if (seasonalClickHandler) {
    document.removeEventListener("click", seasonalClickHandler);
    seasonalClickHandler = null;
  }
  if (seasonalCanvas) {
    seasonalCanvas.remove();
    seasonalCanvas = null;
    seasonalCtx = null;
  }
  snowflakes = [];
  snowPile = [];
  lightningStrikes = [];
  leaves = [];
  heartParticles = [];
  fireworkRockets = [];
  fireworkSparks = [];
  fireworkFlashes = [];
  beadStrands = [];
  sparkleParticles = [];
  swirlParticles = [];
  seasonalActiveTheme = null;
}

/** Every theme that has a canvas effect, with a short description of what it
 *  actually does. Single source of truth: applySeasonalEffect() dispatches on
 *  these ids, and the Theme Picker's Preferences tab builds its per-theme
 *  toggle list straight from this array — so adding an effect below is all it
 *  takes for it to appear (and be switchable) in the UI. Ordered to match the
 *  Holiday tab's own order, with the one Special-tab effect (Halo) last. */
export const ANIMATED_THEMES: { id: string; label: string; effect: string }[] = [
  { id: "valentine", label: "Valentine", effect: "Floating hearts" },
  { id: "mardi-gras", label: "Mardi Gras", effect: "Falling bead strands" },
  { id: "rainbow", label: "Rainbow", effect: "Cursor sparkle trail" },
  { id: "patriot", label: "Patriot", effect: "Fireworks" },
  { id: "halloween", label: "Halloween", effect: "Lightning strikes" },
  { id: "thanksgiving", label: "Thanksgiving", effect: "Blowing leaves" },
  { id: "christmas", label: "Christmas", effect: "Falling snow" },
  { id: "halo", label: "Halo", effect: "Cursor glow swirl" },
];

/** Whether the given theme's canvas effect is allowed to run: the master
 *  "Theme Animations" switch, then that theme's own opt-out. Themes with no
 *  effect at all return true here and simply match nothing in the dispatch
 *  below — this answers "is it permitted", not "does it have one". */
export function isThemeAnimationEnabled(themeId: string): boolean {
  if (!settings.themeAnimations) return false;
  return !settings.themeAnimationsOff.includes(themeId);
}

/** Starts (or leaves running) the canvas effect matching the given theme
 *  name, tearing down whatever was running before. No-ops if the requested
 *  effect is already active. Called on startup, on every "themechange", and
 *  whenever an animation toggle changes (which re-dispatches "themechange"). */
function applySeasonalEffect(themeName: string): void {
  // Checked before the already-active early-return below, so turning an
  // animation off tears down a running effect instead of leaving it up.
  if (!isThemeAnimationEnabled(themeName)) {
    stopSeasonalEffect();
    return;
  }
  if (seasonalActiveTheme === themeName) return;
  stopSeasonalEffect();
  if (themeName === "christmas") {
    seasonalActiveTheme = "christmas";
    startChristmasSnow();
  } else if (themeName === "halloween") {
    seasonalActiveTheme = "halloween";
    startHalloweenLightning();
  } else if (themeName === "thanksgiving") {
    seasonalActiveTheme = "thanksgiving";
    startThanksgivingLeaves();
  } else if (themeName === "halo") {
    seasonalActiveTheme = "halo";
    startHaloSwirl();
  } else if (themeName === "valentine") {
    seasonalActiveTheme = "valentine";
    startValentineHearts();
  } else if (themeName === "patriot") {
    seasonalActiveTheme = "patriot";
    startPatriotFireworks();
  } else if (themeName === "mardi-gras") {
    seasonalActiveTheme = "mardi-gras";
    startMardiGrasBeads();
  } else if (themeName === "rainbow") {
    seasonalActiveTheme = "rainbow";
    startRainbowSparkles();
  }
}

/** Christmas snowfall. Each flake is an independent object that falls,
 *  drifts side to side, and — once it reaches the accumulated snow line at
 *  its x position — "lands" (adding a little height to that column of the
 *  snowbank) and respawns at the top. Because every flake resets itself
 *  individually there's no shared loop for the whole layer to visibly snap
 *  back on; the snowfall is continuous for as long as the theme is active. */
function startChristmasSnow(): void {
  const { ctx } = ensureSeasonalCanvas();

  const pileColumns = Math.ceil(window.innerWidth / SNOW_PILE_COLUMN_WIDTH) + 1;
  snowPile = new Array(pileColumns).fill(0);

  function spawnSnowflake(randomY: boolean): Snowflake {
    return {
      x: Math.random() * window.innerWidth,
      y: randomY ? Math.random() * window.innerHeight : -10,
      r: 1.5 + Math.random() * 2.5,
      speed: 20 + Math.random() * 40, // px/sec
      drift: 10 + Math.random() * 20, // sway amplitude
      driftPhase: Math.random() * Math.PI * 2,
      driftFreq: 0.25 + Math.random() * 0.9, // sway rate — varies per flake so they don't all swing in lockstep
      wanderVel: 0, // slow random-walk "gust" velocity, built up frame to frame below
    };
  }

  window.setTimeout(() => {
    const flakeCount = Math.min(200, Math.round((window.innerWidth * window.innerHeight) / 2000),);
    snowflakes = Array.from({ length: flakeCount }, () => spawnSnowflake(true));
  }, 300); // give the window time to reach its final/restored size first

  function pileHeightAt(x: number): number {
    const col = Math.max(
      0,
      Math.min(snowPile.length - 1, Math.floor(x / SNOW_PILE_COLUMN_WIDTH)),
    );
    return snowPile[col] ?? 0;
  }

  function addToPile(x: number, amount: number): void {
    const col = Math.max(
      0,
      Math.min(snowPile.length - 1, Math.floor(x / SNOW_PILE_COLUMN_WIDTH)),
    );
    const current = snowPile[col] ?? 0;
    if (current < SNOW_PILE_MAX_HEIGHT) {
      snowPile[col] = Math.min(SNOW_PILE_MAX_HEIGHT, current + amount);
    }
    // Spread a little into the immediate neighbours so the bank reads as a
    // drift rather than a bar chart.
    for (const neighbor of [col - 1, col + 1]) {
      if (neighbor < 0 || neighbor >= snowPile.length) continue;
      const neighborCurrent = snowPile[neighbor] ?? 0;
      if (neighborCurrent < SNOW_PILE_MAX_HEIGHT) {
        snowPile[neighbor] = Math.min(
          SNOW_PILE_MAX_HEIGHT,
          neighborCurrent + amount * 0.3,
        );
      }
    }
  }

  /** Enforces a maximum height difference between adjacent columns — real
   *  snow has an angle of repose; ours didn't, which is why a busy pile
   *  turned into stalagmites instead of a level bank. Each pass nudges half
   *  the excess from a too-tall column into its shorter neighbor. Run a few
   *  passes a frame, alternating sweep direction, so tall spikes settle out
   *  in a couple of frames even under a heavy snowfall rate, with no bias
   *  toward one side from always relaxing left-to-right. */
  function relaxSnowPile(): void {
    for (let pass = 0; pass < SNOW_RELAX_PASSES; pass++) {
      const forward = pass % 2 === 0;
      const start = forward ? 0 : snowPile.length - 2;
      const end = forward ? snowPile.length - 1 : -1;
      const step = forward ? 1 : -1;
      for (let i = start; i !== end; i += step) {
        const a = snowPile[i] ?? 0;
        const b = snowPile[i + 1] ?? 0;
        const diff = a - b;
        if (Math.abs(diff) <= SNOW_MAX_SLOPE) continue;
        const move = (Math.abs(diff) - SNOW_MAX_SLOPE) * 0.5;
        if (diff > 0) {
          snowPile[i] = a - move;
          snowPile[i + 1] = b + move;
        } else {
          snowPile[i] = a + move;
          snowPile[i + 1] = b - move;
        }
      }
    }
  }

  let lastFrame = performance.now();

  function frame(now: number): void {
    const dt = Math.min(0.05, (now - lastFrame) / 1000); // clamp so a stalled/background tab doesn't jump-cut
    lastFrame = now;

    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

    relaxSnowPile();

    // Snowbank silhouette across the bottom edge.
    if (snowPile.length > 0 && snowPile.some((h) => h > 0)) {
      ctx.beginPath();
      ctx.moveTo(0, window.innerHeight);
      for (let i = 0; i < snowPile.length; i++) {
        ctx.lineTo(
          i * SNOW_PILE_COLUMN_WIDTH,
          window.innerHeight - (snowPile[i] ?? 0),
        );
      }
      ctx.lineTo(window.innerWidth, window.innerHeight);
      ctx.closePath();
      ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
      ctx.fill();
    }

    for (const flake of snowflakes) {
      flake.driftPhase += dt * flake.driftFreq;
      // Smoothed random walk ("gusts"): nudge velocity randomly each frame,
      // then decay it — an Ornstein-Uhlenbeck-style process. This is what
      // actually breaks up the pure-sine look; the sine term alone just
      // offsets in phase/amplitude, which still reads as "the same wave"
      // repeating for every flake.
      flake.wanderVel += (Math.random() - 0.5) * SNOW_WANDER_ACCEL * dt;
      flake.wanderVel *= Math.pow(SNOW_WANDER_DAMPING, dt * 60);
      flake.x +=
        Math.sin(flake.driftPhase) * flake.drift * dt * 4 +
        flake.wanderVel * dt;
      flake.y += flake.speed * dt;
      // Wrap horizontally so drift never permanently walks a flake off-screen.
      if (flake.x < -10) flake.x = window.innerWidth + 10;
      if (flake.x > window.innerWidth + 10) flake.x = -10;

      const groundY = window.innerHeight - pileHeightAt(flake.x);
      if (flake.y + flake.r >= groundY) {
        addToPile(flake.x, 0.15 + Math.random() * 0.25);
        Object.assign(flake, spawnSnowflake(false));
        continue;
      }

      ctx.beginPath();
      ctx.arc(flake.x, flake.y, flake.r, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
      ctx.fill();
    }

    seasonalAnimationId = requestAnimationFrame(frame);
  }

  seasonalAnimationId = requestAnimationFrame(frame);

  seasonalResizeHandler = () => {
    resizeSeasonalCanvas();
    const newColumns =
      Math.ceil(window.innerWidth / SNOW_PILE_COLUMN_WIDTH) + 1;
    if (newColumns !== snowPile.length) {
      const resized = new Array(newColumns).fill(0);
      for (let i = 0; i < Math.min(newColumns, snowPile.length); i++) {
        resized[i] = snowPile[i] ?? 0;
      }
      snowPile = resized;
    }
  };
  window.addEventListener("resize", seasonalResizeHandler);
}

/** Halloween lightning. Each strike's shape is generated fresh via recursive
 *  midpoint displacement (the standard fractal-lightning technique), so no
 *  two bolts look alike, and strikes are scheduled on a randomized interval
 *  rather than a fixed CSS loop, so the timing never falls into a rhythm. */
function startHalloweenLightning(): void {
  const { ctx } = ensureSeasonalCanvas();

  /** Recursively displaces the midpoint of a line segment to build a jagged
   *  bolt path from (x1,y1) to (x2,y2), pushing each final point into `points`. */
  function midpointBolt(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    displace: number,
    points: { x: number; y: number }[],
  ): void {
    if (displace < 6) {
      points.push({ x: x2, y: y2 });
      return;
    }
    const midX = (x1 + x2) / 2 + (Math.random() - 0.5) * displace;
    const midY = (y1 + y2) / 2;
    midpointBolt(x1, y1, midX, midY, displace / 1.9, points);
    midpointBolt(midX, midY, x2, y2, displace / 1.9, points);
  }

  function spawnStrike(): void {
    const startX = window.innerWidth * (0.1 + Math.random() * 0.8);
    const startY = 0;
    const endY = window.innerHeight * (0.55 + Math.random() * 0.4);
    const endX = startX + (Math.random() - 0.5) * window.innerWidth * 0.18;

    const points: { x: number; y: number }[] = [{ x: startX, y: startY }];
    midpointBolt(startX, startY, endX, endY, window.innerWidth * 0.12, points);

    const branches: { x: number; y: number }[][] = [];
    const branchCount = Math.random() < 0.4 ? 0 : Math.random() < 0.75 ? 1 : 2;
    for (let b = 0; b < branchCount; b++) {
      const originIndex =
        1 + Math.floor(Math.random() * Math.max(1, points.length - 2));
      const origin = points[originIndex];
      if (!origin) continue;
      const branchEndY =
        origin.y + (endY - origin.y) * (0.3 + Math.random() * 0.4);
      const branchEndX =
        origin.x + (Math.random() - 0.5) * window.innerWidth * 0.15;
      const branchPoints: { x: number; y: number }[] = [
        { x: origin.x, y: origin.y },
      ];
      midpointBolt(
        origin.x,
        origin.y,
        branchEndX,
        branchEndY,
        window.innerWidth * 0.06,
        branchPoints,
      );
      branches.push(branchPoints);
    }

    lightningStrikes.push({
      points,
      branches,
      bornAt: performance.now(),
      lifespanMs:
        Math.random() < 0.10
          ? 2500 + Math.random() * 2500 // occasional long, lingering flash
          : 250 + Math.random() * 250, // normal quick flash
    });

    // Occasional quick double-strike, like real lightning restriking the same area.
    if (Math.random() < 0.22) {
      const id = window.setTimeout(() => {
        lightningRestrikeTimeouts = lightningRestrikeTimeouts.filter((t) => t !== id);
        spawnStrike();
      }, 60 + Math.random() * 90);
      lightningRestrikeTimeouts.push(id);
    }
  }

  function scheduleNextStrike(): void {
    const delay = 1000 + Math.random() * 2500; // noticeably more active than the original 2.2-8.7s gaps
    lightningTimeoutId = window.setTimeout(() => {
      spawnStrike();
      scheduleNextStrike();
    }, delay);
  }

  /** Two-pulse Gaussian flicker curve — a quick bright flash, brief dip, a
   *  fainter second pulse, then fade out — so each strike stutters like real
   *  lightning instead of doing a simple linear fade. */
  function flickerIntensity(elapsedMs: number, lifespanMs: number): number {
    const t = elapsedMs / lifespanMs;
    if (t >= 1) return 0;
    const pulse1 = Math.exp(-Math.pow((t - 0.08) / 0.06, 2));
    const pulse2 = Math.exp(-Math.pow((t - 0.32) / 0.1, 2)) * 0.55;
    return Math.min(1, pulse1 + pulse2);
  }

  function strokeBolt(
    points: { x: number; y: number }[],
    alpha: number,
    coreWidth: number,
  ): void {
    const [first, ...rest] = points;
    if (!first || rest.length === 0) return;

    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    // Wide soft purple glow pass.
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    for (const p of rest) ctx.lineTo(p.x, p.y);
    ctx.strokeStyle = `rgba(147, 112, 219, ${alpha * 0.5})`;
    ctx.lineWidth = coreWidth * 5;
    ctx.shadowColor = `rgba(147, 112, 219, ${alpha * 0.8})`;
    ctx.shadowBlur = 22;
    ctx.stroke();

    // Bright white-purple core.
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    for (const p of rest) ctx.lineTo(p.x, p.y);
    ctx.strokeStyle = `rgba(240, 235, 255, ${alpha})`;
    ctx.lineWidth = coreWidth;
    ctx.shadowBlur = 10;
    ctx.stroke();

    ctx.restore();
  }

  function frame(now: number): void {
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    lightningStrikes = lightningStrikes.filter(
      (strike) => now - strike.bornAt < strike.lifespanMs,
    );

    let maxAlpha = 0;
    for (const strike of lightningStrikes) {
      const alpha = flickerIntensity(now - strike.bornAt, strike.lifespanMs);
      if (alpha > maxAlpha) maxAlpha = alpha;
    }
    if (maxAlpha > 0.01) {
      ctx.fillStyle = `rgba(5, 0, 12, ${maxAlpha * LIGHTNING_DARKEN_STRENGTH})`;
      ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
    }

    for (const strike of lightningStrikes) {
      const alpha = flickerIntensity(now - strike.bornAt, strike.lifespanMs);
      if (alpha <= 0.01) continue;
      strokeBolt(strike.points, alpha, 2.2);
      for (const branch of strike.branches)
        strokeBolt(branch, alpha * 0.6, 1.3);
    }
    seasonalAnimationId = requestAnimationFrame(frame);
  }

  seasonalAnimationId = requestAnimationFrame(frame);
  lightningTimeoutId = window.setTimeout(
    () => {
      spawnStrike();
      scheduleNextStrike();
    },
    400 + Math.random() * 800,
  ); // first strike arrives quickly

  seasonalResizeHandler = () => resizeSeasonalCanvas();
  window.addEventListener("resize", seasonalResizeHandler);
  // Tracked in a module-level handle like every other seasonal listener, so
  // stopSeasonalEffect() can drop it. Left untracked, each switch back to
  // Halloween stacked another permanent listener, and clicks made AFTER
  // leaving the theme still pushed onto lightningStrikes — an array the
  // cancelled animation loop no longer drains.
  seasonalClickHandler = () => spawnStrike();
  document.addEventListener("click", seasonalClickHandler);
}

/** Thanksgiving leaves. Unlike the continuous Christmas snow, this is a
 *  one-shot gust: a small batch of leaves spawns off-screen to the left at a
 *  random height, blows straight across to off-screen on the right, and is
 *  discarded — then the next gust is scheduled 30-90s later. Each leaf bobs
 *  up and down on its own sine phase as it travels so the gust doesn't read
 *  as a single rigid row sliding across. */
function startThanksgivingLeaves(): void {
  const { ctx } = ensureSeasonalCanvas();

  function spawnGust(): void {
    const count = 10 + Math.floor(Math.random() * 91); // 10-100 leaves per gust
    for (let i = 0; i < count; i++) {
      leaves.push({
        x: -40 - Math.random() * 400, // staggered starting points off-screen left
        y: window.innerHeight * (0.05 + Math.random() * 0.9), // random height, not pinned to the bottom
        rotation: Math.random() * Math.PI * 2,
        rotationSpeed: (Math.random() - 0.5) * 4,
        speed: 90 + Math.random() * 100, // px/sec, left to right
        size: 9 + Math.random() * 9,
        color: LEAF_COLORS[Math.floor(Math.random() * LEAF_COLORS.length)]!,
        bobPhase: Math.random() * Math.PI * 2,
        bobFreq: 1 + Math.random() * 1.5,
        bobAmp: 8 + Math.random() * 14,
      });
    }
  }

  function scheduleNextGust(): void {
    const delay = LEAF_GUST_MIN_MS + Math.random() * (LEAF_GUST_MAX_MS - LEAF_GUST_MIN_MS);
    leafTimeoutId = window.setTimeout(() => {
      spawnGust();
      scheduleNextGust();
    }, delay);
  }

  function drawLeaf(x: number, y: number, rotation: number, size: number, color: string): void {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rotation);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, -size);
    ctx.quadraticCurveTo(size * 0.9, -size * 0.2, 0, size);
    ctx.quadraticCurveTo(-size * 0.9, -size * 0.2, 0, -size);
    ctx.fill();
    ctx.strokeStyle = "rgba(0, 0, 0, 0.25)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, -size * 0.9);
    ctx.lineTo(0, size * 0.9);
    ctx.stroke();
    ctx.restore();
  }

  let lastFrame = performance.now();

  function frame(now: number): void {
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

    for (let i = leaves.length - 1; i >= 0; i--) {
      const leaf = leaves[i]!;
      leaf.bobPhase += dt * leaf.bobFreq;
      leaf.x += leaf.speed * dt;
      leaf.rotation += leaf.rotationSpeed * dt;

      if (leaf.x - leaf.size > window.innerWidth + 40) {
        leaves.splice(i, 1);
        continue;
      }

      drawLeaf(leaf.x, leaf.y + Math.sin(leaf.bobPhase) * leaf.bobAmp, leaf.rotation, leaf.size, leaf.color);
    }

    seasonalAnimationId = requestAnimationFrame(frame);
  }

  seasonalAnimationId = requestAnimationFrame(frame);

  // First gust arrives well under the normal 30-90s gap so the theme doesn't
  // feel empty right after switching to it; every gust after that follows
  // the full randomized interval.
  leafTimeoutId = window.setTimeout(
    () => {
      spawnGust();
      scheduleNextGust();
    },
    3000 + Math.random() * 5000,
  );

  seasonalResizeHandler = () => resizeSeasonalCanvas();
  window.addEventListener("resize", seasonalResizeHandler);
}

/** Mardi Gras beads. Continuous, like Christmas snow, but each "flake" is a
 *  short string of beads (drawn as a rigid chain of circles along its own
 *  local axis, then rotated as a whole) tumbling as it falls under real
 *  gravity. Instead of snow's pile-up-into-a-bank behavior, a strand bounces
 *  off the bottom edge a couple of times with each bounce losing speed, then
 *  resets to the top with fresh randomized properties — beads don't
 *  accumulate, they just keep tumbling through. */
function startMardiGrasBeads(): void {
  const { ctx } = ensureSeasonalCanvas();

  function spawnBead(randomY: boolean): BeadStrand {
    return {
      x: Math.random() * window.innerWidth,
      y: randomY ? Math.random() * window.innerHeight : -30,
      vx: (Math.random() - 0.5) * 30,
      vy: randomY ? Math.random() * 100 : 0,
      rotation: Math.random() * Math.PI * 2,
      rotationSpeed: (Math.random() - 0.5) * 3,
      color: BEAD_COLORS[Math.floor(Math.random() * BEAD_COLORS.length)]!,
      beadCount: 4 + Math.floor(Math.random() * 4), // 4-7
      beadSpacing: 9 + Math.random() * 3,
      beadRadius: 4 + Math.random() * 2,
      bounces: 2 + Math.floor(Math.random() * 3), // 2-4
    };
  }

  window.setTimeout(() => {
    const count = Math.min(16, Math.round((window.innerWidth * window.innerHeight) / 100000));
    beadStrands = Array.from({ length: count }, () => spawnBead(true));
  }, 300); // give the window time to reach its final/restored size first

  function drawBeadStrand(strand: BeadStrand): void {
    ctx.save();
    ctx.translate(strand.x, strand.y);
    ctx.rotate(strand.rotation);
    const half = (strand.beadCount - 1) / 2;

    ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, -half * strand.beadSpacing);
    ctx.lineTo(0, half * strand.beadSpacing);
    ctx.stroke();

    for (let i = 0; i < strand.beadCount; i++) {
      const by = (i - half) * strand.beadSpacing;
      ctx.beginPath();
      ctx.arc(0, by, strand.beadRadius, 0, Math.PI * 2);
      ctx.fillStyle = strand.color;
      ctx.shadowColor = strand.color;
      ctx.shadowBlur = 6;
      ctx.fill();

      // Small offset highlight — reads as a shiny plastic bead instead of a flat dot.
      ctx.beginPath();
      ctx.arc(-strand.beadRadius * 0.3, by - strand.beadRadius * 0.3, strand.beadRadius * 0.3, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255, 255, 255, 0.5)";
      ctx.shadowBlur = 0;
      ctx.fill();
    }
    ctx.restore();
  }

  let lastFrame = performance.now();

  function frame(now: number): void {
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;

    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

    const groundY = window.innerHeight - 4;
    for (const strand of beadStrands) {
      strand.vy += BEAD_GRAVITY * dt;
      strand.x += strand.vx * dt;
      strand.y += strand.vy * dt;
      strand.rotation += strand.rotationSpeed * dt;

      // Conservative worst-case extent regardless of the strand's current
      // rotation — simpler than tracking the true rotated bounding box, and
      // the couple of extra px of margin isn't visible at this size.
      const halfExtent = ((strand.beadCount - 1) / 2) * strand.beadSpacing + strand.beadRadius;
      if (strand.y + halfExtent >= groundY) {
        strand.y = groundY - halfExtent;
        strand.vy = -Math.abs(strand.vy) * BEAD_BOUNCE_DAMPING;
        strand.bounces -= 1;
        if (strand.bounces <= 0 || Math.abs(strand.vy) < 30) {
          Object.assign(strand, spawnBead(false));
        }
      }

      // Wrap horizontal drift instead of letting it walk a strand off-screen.
      if (strand.x < -40) strand.x = window.innerWidth + 40;
      if (strand.x > window.innerWidth + 40) strand.x = -40;

      drawBeadStrand(strand);
    }

    seasonalAnimationId = requestAnimationFrame(frame);
  }

  seasonalAnimationId = requestAnimationFrame(frame);
  seasonalResizeHandler = () => resizeSeasonalCanvas();
  window.addEventListener("resize", seasonalResizeHandler);
}

/** Builds (once per effect start) the small repeating tile used to paint the
 *  ambient "pixelated background" — a faint, static dot grid — cheaply. One
 *  fillRect() with this pattern per frame stands in for the tens of thousands
 *  of individual dots a real grid at this density would otherwise cost. */
function buildSwirlDotPattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  const tile = document.createElement("canvas");
  tile.width = SWIRL_GRID;
  tile.height = SWIRL_GRID;
  const tctx = tile.getContext("2d");
  if (!tctx) return null;
  tctx.fillStyle = `rgba(${SWIRL_RGB}, 0.14)`;
  tctx.beginPath();
  tctx.arc(SWIRL_GRID / 2, SWIRL_GRID / 2, 1, 0, Math.PI * 2);
  tctx.fill();
  return ctx.createPattern(tile, "repeat");
}

/** The "Halo" theme's background: a faint static dot grid (the "pixelated
 *  background") with a light-blue glow that puffs out behind the cursor as
 *  it moves, inspired by obfuscator.io's WebGL fluid-sim hero effect (see
 *  the file header comment in public/themes/halo.css for what the real one
 *  does — this is a much cheaper canvas-2D approximation of the same idea:
 *  colored light injected near the cursor, curling into little vortices,
 *  sampled through a dot grid instead of rendered smooth).
 *
 *  Deliberately inert at rest — the glow exists only as a byproduct of
 *  motion, so a still cursor leaves whatever's underneath fully readable.
 *  Two layers ride on movement: a soft radial halo whose visibility tracks a
 *  decaying "activity" value (1 on every mousemove, exponentially decayed to
 *  0 at rest — see SWIRL_ACTIVITY_DECAY, tune this to change how long the
 *  glow lingers after the cursor stops), and a cloud of small particles
 *  ejected in the direction *opposite* the cursor's travel, like the wake
 *  the real site's dye leaves as it's dragged through the fluid, rather than
 *  a trail cast ahead of the motion. Each particle then curls via a force
 *  perpendicular to its own velocity (a cheap stand-in for real fluid
 *  vorticity), drags, and fades out — snapped to the same grid as the
 *  ambient pattern so it reads as extra-bright grid dots, not a free
 *  floating blob. Both layers are anchored SWIRL_ORIGIN_OFFSET px off the
 *  cursor, but not toward a fixed corner — the anchor always sits opposite
 *  whichever direction the cursor last travelled (dirX/dirY below), so the
 *  glow trails behind the cursor no matter which way it's moving instead of
 *  reading as "ahead" of it once the cursor heads toward a fixed offset. */
function startHaloSwirl(): void {
  const { ctx } = ensureSeasonalCanvas();
  swirlParticles = [];
  swirlDotPattern = buildSwirlDotPattern(ctx);

  let hasMouse = false;
  let mouseX = 0;
  let mouseY = 0;
  let lastMouseX = 0;
  let lastMouseY = 0;
  let activity = 0; // 0..1 — driven up by movement, decays to 0 at rest
  // Unit vector of the cursor's last travel direction — persists between
  // moves (rather than resetting) so the anchor holds its trailing position
  // while activity decays after the cursor stops, instead of snapping away.
  let dirX = 0;
  let dirY = -1;

  const moveHandler = (e: MouseEvent): void => {
    mouseX = e.clientX;
    mouseY = e.clientY;
    if (!hasMouse) {
      hasMouse = true;
      lastMouseX = mouseX;
      lastMouseY = mouseY;
      return;
    }
    const dx = mouseX - lastMouseX;
    const dy = mouseY - lastMouseY;
    const rawLen = Math.hypot(dx, dy);
    const speed = Math.min(60, rawLen);
    lastMouseX = mouseX;
    lastMouseY = mouseY;
    if (speed < 0.5) return;

    activity = 1;
    dirX = dx / rawLen;
    dirY = dy / rawLen;

    // Anchor opposite the direction of travel, so the wake/halo trail behind
    // the cursor no matter which way it's moving.
    const anchorX = mouseX - dirX * SWIRL_ORIGIN_OFFSET;
    const anchorY = mouseY - dirY * SWIRL_ORIGIN_OFFSET;

    // Wake puff: ejected opposite the direction of travel, from the anchor,
    // so it's left behind as the cursor keeps moving forward — not cast
    // ahead of it.
    const wakeAngle = Math.atan2(dy, dx) + Math.PI;
    const count = Math.min(14, Math.max(3, Math.round(speed / 3)));
    for (let i = 0; i < count; i++) {
      if (swirlParticles.length >= SWIRL_MAX_PARTICLES) break;
      const angle = wakeAngle + (Math.random() - 0.5) * 1.4;
      const mag = 10 + speed * (8 + Math.random() * 8) + Math.random() * 20;
      swirlParticles.push({
        x: anchorX + (Math.random() - 0.5) * SWIRL_SPAWN_JITTER,
        y: anchorY + (Math.random() - 0.5) * SWIRL_SPAWN_JITTER,
        vx: Math.cos(angle) * mag,
        vy: Math.sin(angle) * mag,
        age: 0,
        maxLife: 0.9 + Math.random() * 0.7,
      });
    }
  };
  seasonalMouseMoveHandler = moveHandler;
  window.addEventListener("mousemove", moveHandler, { passive: true });

  let lastFrame = performance.now();

  function frame(now: number): void {
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;

    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

    if (swirlDotPattern) {
      ctx.fillStyle = swirlDotPattern;
      ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
    }

    activity *= Math.pow(SWIRL_ACTIVITY_DECAY, dt * 60);

    // Soft halo pooled around the cursor — only visible while activity is
    // still elevated from recent movement; fully gone at rest. Anchored
    // opposite the last travel direction, same as the particle wake.
    if (hasMouse && activity > 0.01) {
      const haloX = mouseX - dirX * SWIRL_ORIGIN_OFFSET;
      const haloY = mouseY - dirY * SWIRL_ORIGIN_OFFSET;
      const halo = ctx.createRadialGradient(
        haloX, haloY, 0,
        haloX, haloY, SWIRL_HALO_RADIUS,
      );
      halo.addColorStop(0, `rgba(${SWIRL_RGB}, ${0.22 * activity})`);
      halo.addColorStop(0.5, `rgba(${SWIRL_RGB}, ${0.09 * activity})`);
      halo.addColorStop(1, `rgba(${SWIRL_RGB}, 0)`);
      ctx.fillStyle = halo;
      ctx.fillRect(
        haloX - SWIRL_HALO_RADIUS, haloY - SWIRL_HALO_RADIUS,
        SWIRL_HALO_RADIUS * 2, SWIRL_HALO_RADIUS * 2,
      );
    }

    for (let i = swirlParticles.length - 1; i >= 0; i--) {
      const p = swirlParticles[i]!;
      p.age += dt;
      if (p.age >= p.maxLife) {
        swirlParticles.splice(i, 1);
        continue;
      }

      const perpLen = Math.hypot(p.vx, p.vy) || 1;
      p.vx += (-p.vy / perpLen) * SWIRL_VORTEX_ACCEL * dt;
      p.vy += (p.vx / perpLen) * SWIRL_VORTEX_ACCEL * dt;
      const drag = Math.pow(SWIRL_DRAG, dt * 60);
      p.vx *= drag;
      p.vy *= drag;
      p.x += p.vx * dt;
      p.y += p.vy * dt;

      const lifeFrac = 1 - p.age / p.maxLife;
      const alpha = lifeFrac * lifeFrac * 0.9;

      const gx = Math.round(p.x / SWIRL_GRID) * SWIRL_GRID;
      const gy = Math.round(p.y / SWIRL_GRID) * SWIRL_GRID;

      ctx.beginPath();
      ctx.arc(gx, gy, SWIRL_DOT_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${SWIRL_RGB}, ${alpha})`;
      ctx.shadowColor = `rgba(${SWIRL_RGB}, ${alpha * 0.8})`;
      ctx.shadowBlur = 8;
      ctx.fill();
    }
    ctx.shadowBlur = 0;

    seasonalAnimationId = requestAnimationFrame(frame);
  }

  seasonalAnimationId = requestAnimationFrame(frame);
  seasonalResizeHandler = () => resizeSeasonalCanvas();
  window.addEventListener("resize", seasonalResizeHandler);
}

/** Rainbow sparkle trail. A cursor-following trail of small 4-point sparkle
 *  shapes, each stamped with the next step around the hue wheel
 *  (sparkleHueCursor advances by SPARKLE_HUE_STEP° per spawn) so the trail
 *  itself reads as a smooth rainbow gradient rather than randomly-colored
 *  confetti. Particles drift with a slight upward float (like glitter dust),
 *  shrink, and fade — reusing the Halo swirl's "spawn along the recent mouse
 *  path, proportional to how far it moved" shape, but simpler: no ambient
 *  dot-grid background or idle halo, since this is meant to be inert at rest
 *  and only ever exist as a trail behind actual movement. */
function startRainbowSparkles(): void {
  const { ctx } = ensureSeasonalCanvas();
  sparkleParticles = [];
  sparkleHueCursor = 0;

  let mouseX = 0;
  let mouseY = 0;
  let lastMouseX = 0;
  let lastMouseY = 0;
  let hasMouse = false;
  // Unit vector of the cursor's last travel direction — persists between
  // moves (rather than resetting), same as the Halo swirl's dirX/dirY, so
  // the anchor holds its trailing position instead of snapping back to the
  // literal cursor point the instant the mouse stops.
  let dirX = 0;
  let dirY = -1;

  const moveHandler = (e: MouseEvent): void => {
    mouseX = e.clientX;
    mouseY = e.clientY;
    if (!hasMouse) {
      hasMouse = true;
      lastMouseX = mouseX;
      lastMouseY = mouseY;
      return;
    }
    const dx = mouseX - lastMouseX;
    const dy = mouseY - lastMouseY;
    const dist = Math.hypot(dx, dy);
    lastMouseX = mouseX;
    lastMouseY = mouseY;
    if (dist < 3) return; // skip sub-pixel jitter so the trail doesn't oversaturate when the cursor barely moves

    dirX = dx / dist;
    dirY = dy / dist;
    // Anchor opposite the direction of travel, so the trail lags behind the
    // cursor no matter which way it's moving — same trick the Halo swirl
    // uses for its wake/halo anchor.
    const anchorX = mouseX - dirX * SPARKLE_ORIGIN_OFFSET;
    const anchorY = mouseY - dirY * SPARKLE_ORIGIN_OFFSET;

    const count = Math.min(4, Math.max(1, Math.round(dist / 10))); // denser than before, for a visually longer trail
    for (let i = 0; i < count; i++) {
      if (sparkleParticles.length >= SPARKLE_MAX_PARTICLES) break;
      sparkleHueCursor = (sparkleHueCursor + SPARKLE_HUE_STEP) % 360;
      sparkleParticles.push({
        x: anchorX + (Math.random() - 0.5) * 10,
        y: anchorY + (Math.random() - 0.5) * 10,
        vx: (Math.random() - 0.5) * 20,
        vy: (Math.random() - 0.5) * 20 - 10,
        age: 0,
        maxLife: 1.8 + Math.random() * 1.4, // much longer-lasting than before (was 0.6-1.1s)
        size: 4 + Math.random() * 4,
        hue: sparkleHueCursor,
        rotation: Math.random() * Math.PI * 2,
        rotationSpeed: (Math.random() - 0.5) * 4,
      });
    }
  };
  seasonalMouseMoveHandler = moveHandler;
  window.addEventListener("mousemove", moveHandler, { passive: true });

  /** A 4-point sparkle/twinkle shape (concave diamond) rather than a plain
   *  dot, so the trail reads as "sparkle dust" and stays visually distinct
   *  from the Halo swirl's round particles. */
  function drawSparkle(x: number, y: number, size: number, hue: number, alpha: number, rotation: number): void {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rotation);
    const color = `hsl(${hue}, 90%, 65%)`;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.moveTo(0, -size);
    ctx.lineTo(size * 0.28, -size * 0.28);
    ctx.lineTo(size, 0);
    ctx.lineTo(size * 0.28, size * 0.28);
    ctx.lineTo(0, size);
    ctx.lineTo(-size * 0.28, size * 0.28);
    ctx.lineTo(-size, 0);
    ctx.lineTo(-size * 0.28, -size * 0.28);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  let lastFrame = performance.now();

  function frame(now: number): void {
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;

    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

    for (let i = sparkleParticles.length - 1; i >= 0; i--) {
      const p = sparkleParticles[i]!;
      p.age += dt;
      if (p.age >= p.maxLife) {
        sparkleParticles.splice(i, 1);
        continue;
      }
      const drag = Math.pow(0.9, dt * 60);
      p.vx *= drag;
      p.vy *= drag;
      p.vy -= 12 * dt; // gentle upward drift, like glitter dust
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rotation += p.rotationSpeed * dt;

      const lifeFrac = 1 - p.age / p.maxLife;
      const alpha = lifeFrac * lifeFrac;
      const size = p.size * (0.6 + 0.4 * lifeFrac);
      drawSparkle(p.x, p.y, size, p.hue, alpha, p.rotation);
    }
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;

    seasonalAnimationId = requestAnimationFrame(frame);
  }

  seasonalAnimationId = requestAnimationFrame(frame);
  seasonalResizeHandler = () => resizeSeasonalCanvas();
  window.addEventListener("resize", seasonalResizeHandler);
}

/** Draws a heart centered on (x, y) — the classic "top notch + two bezier
 *  lobes + point" construction, scaled to `size` and faded by `alpha`. */
function drawHeart(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  rotation: number,
  size: number,
  color: string,
  alpha: number,
): void {
  if (alpha <= 0 || size <= 0) return;
  const topCurveHeight = size * 0.3;
  const hy = -size / 2; // top-center notch — shape spans roughly [-size/2, size/2]

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rotation);
  ctx.beginPath();
  ctx.moveTo(0, hy + topCurveHeight);
  ctx.bezierCurveTo(0, hy, -size / 2, hy, -size / 2, hy + topCurveHeight);
  ctx.bezierCurveTo(
    -size / 2, hy + (size + topCurveHeight) / 2,
    0, hy + (size + topCurveHeight) / 2,
    0, hy + size,
  );
  ctx.bezierCurveTo(
    0, hy + (size + topCurveHeight) / 2,
    size / 2, hy + (size + topCurveHeight) / 2,
    size / 2, hy + topCurveHeight,
  );
  ctx.bezierCurveTo(size / 2, hy, 0, hy, 0, hy + topCurveHeight);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.globalAlpha = alpha;
  ctx.shadowColor = color;
  ctx.shadowBlur = 14 * alpha;
  ctx.fill();
  ctx.restore();
}

/** Valentine hearts. Every mousedown pops one heart into existence right at
 *  the cursor: it grows from a fraction of its final size up to full size
 *  while drifting gently upward and fading out, over a randomized 1-2s
 *  lifespan — one heart per click, like Halloween's onclick lightning strike
 *  is one bolt per click. */
function startValentineHearts(): void {
  const { ctx } = ensureSeasonalCanvas();
  heartParticles = [];

  function spawnHeart(x: number, y: number): void {
    heartParticles.push({
      x,
      y,
      vy: -18 - Math.random() * 14,
      rotation: (Math.random() - 0.5) * 0.5,
      size: 26 + Math.random() * 18,
      maxScale: 1.15 + Math.random() * 0.85, // 115%-200%
      color: HEART_COLORS[Math.floor(Math.random() * HEART_COLORS.length)]!,
      bornAt: performance.now(),
      lifespanMs: 1000 + Math.random() * 1000,
    });
  }

  const mouseDownHandler = (e: MouseEvent): void => spawnHeart(e.clientX, e.clientY);
  seasonalMouseDownHandler = mouseDownHandler;
  window.addEventListener("mousedown", mouseDownHandler);

  function frame(now: number): void {
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

    heartParticles = heartParticles.filter((h) => now - h.bornAt < h.lifespanMs);

    for (const h of heartParticles) {
      const t = (now - h.bornAt) / h.lifespanMs; // 0..1
      const elapsedSec = (now - h.bornAt) / 1000;
      const growEase = 1 - Math.pow(1 - t, 2); // easeOutQuad — fast start, settles near the end
      const scale = 0.25 + growEase * (h.maxScale - 0.25); // starts at 25% size, grows to h.maxScale (115%-200%)
      const alpha = 1 - t;
      const y = h.y + h.vy * elapsedSec;
      drawHeart(ctx, h.x, y, h.rotation, h.size * scale, h.color, alpha);
    }
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;

    seasonalAnimationId = requestAnimationFrame(frame);
  }

  seasonalAnimationId = requestAnimationFrame(frame);
  seasonalResizeHandler = () => resizeSeasonalCanvas();
  window.addEventListener("resize", seasonalResizeHandler);
}

/** Patriot fireworks. Autonomous, like Halloween's lightning strikes: rockets
 *  launch on their own as time passes (no click needed), from random x
 *  positions along the bottom of the screen, to random heights within the
 *  top two-thirds of the screen — each rocket's initial upward velocity is
 *  picked from a target apex height, so higher rockets are simply given more
 *  launch speed rather than bursting on a fixed timer. It rises with a
 *  trailing spark tail, arcing under gravity, and bursts the instant it
 *  crosses its apex (vy flips from negative/rising to non-negative). Each
 *  burst independently rolls a color mode (single locked color from the
 *  rainbow set, assorted rainbow colors, or assorted red/white/blue) and a
 *  shape (scattered, ring, dot-matrix filled circle, spike star, or a
 *  dot-matrix filled star) — see randomColorMode()/randomShapeMode() — so
 *  any color can pair with any shape and consecutive fireworks read as
 *  genuinely varied instead of the same explosion repeated. Occasionally two
 *  launch in quick succession,
 *  mirroring lightning's occasional double-strike. Each burst also registers
 *  a screen-darkening flash (the same "dim the world, then paint the effect
 *  on top" trick the lightning strikes use) so the burst reads as
 *  illuminated against the dimmed backdrop — held long enough to stay lit
 *  through the sparks' now much longer lingering fall. */
function startPatriotFireworks(): void {
  const { ctx } = ensureSeasonalCanvas();

  // Color and shape are independent choices — any of the 3 color modes can
  // pair with any of the 5 shapes, instead of each burst "type" hard-coding
  // its own palette.
  type ColorMode = "single" | "multi" | "patriot";
  type ShapeMode = "scattered" | "ring" | "dotmatrix" | "star" | "dotmatrixStar";

  function randomColorMode(): ColorMode {
    const r = Math.random();
    if (r < 1 / 3) return "single";
    if (r < 2 / 3) return "multi";
    return "patriot";
  }

  function randomShapeMode(): ShapeMode {
    const r = Math.random();
    if (r < 1 / 5) return "scattered";
    if (r < 2 / 5) return "ring";
    if (r < 3 / 5) return "dotmatrix";
    if (r < 4 / 5) return "star";
    return "dotmatrixStar";
  }

  // Ray-casting point-in-polygon test, used by "dotmatrixStar" to keep only
  // the sampled dots that fall inside the star's outline.
  function pointInPolygon(px: number, py: number, poly: { x: number; y: number }[]): boolean {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i]!;
      const b = poly[j]!;
      const intersect =
        a.y > py !== b.y > py && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x;
      if (intersect) inside = !inside;
    }
    return inside;
  }

  // Sparks now live 2x as long again as the last pass (4200-7200ms instead
  // of 2100-3600ms), so the whole show — rise, burst, and fade — lasts even
  // longer per firework.
  function sparkLifespanMs(): number {
    return 4200 + Math.random() * 3000;
  }

  // Takes `now` from the calling frame rather than reading performance.now()
  // itself: burst() runs mid-frame (a rocket can cross its apex partway
  // through frame()'s rocket loop), and by the time it ran, a fresh
  // performance.now() read would land a hair after the frame's own `now` —
  // so on that same frame, `now - bornAt` would come out slightly negative
  // for anything just spawned, which used to send a disc's radius negative
  // and crash canvas's arc(). Sharing one clock avoids the skew entirely.
  function burst(x: number, y: number, now: number): void {
    fireworkFlashes.push(now);

    const colorMode = randomColorMode();
    // "single" locks the whole burst to one color, drawn from the rainbow
    // set (not just red/white/blue) — chosen once up front and reused below.
    const lockedColor =
      colorMode === "single"
        ? FIREWORK_COLORS_RAINBOW[Math.floor(Math.random() * FIREWORK_COLORS_RAINBOW.length)]!
        : null;
    function pickColor(): string {
      if (colorMode === "single") return lockedColor!;
      const pool = colorMode === "patriot" ? FIREWORK_COLORS_PATRIOT : FIREWORK_COLORS_RAINBOW;
      return pool[Math.floor(Math.random() * pool.length)]!;
    }

    const shape = randomShapeMode();

    if (shape === "dotmatrix") {
      // A filled-in circle built from dots, not just an expanding ring —
      // sample points across the *whole* disc (not only its rim) with a
      // sunflower/Fibonacci distribution (r = R·√(fraction), angle = golden
      // angle steps), which spaces points evenly over the area instead of
      // randomly, so it reads as a deliberate dot-matrix pattern. Each dot's
      // outward speed is set so it reaches roughly its sampled radius after
      // ~0.5s, keeping the filled-circle shape recognizable as it blooms.
      const count = 70 + Math.floor(Math.random() * 30); // 70-99 — denser than the ring, to read as "filled"
      const maxRadius = 50 + Math.random() * 30;
      for (let i = 0; i < count; i++) {
        const r = maxRadius * Math.sqrt((i + 0.5) / count);
        const angle = i * FIREWORK_GOLDEN_ANGLE;
        const speed = r / 0.5;
        fireworkSparks.push({
          x,
          y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          color: pickColor(),
          bornAt: now,
          lifespanMs: sparkLifespanMs(),
        });
      }
      return;
    }

    if (shape === "dotmatrixStar") {
      // Same dot-matrix fill idea as "dotmatrix", but carved into a 5-point
      // star instead of a plain disc: sample the dense sunflower disc as
      // usual, then keep only the points that land inside a star polygon
      // (5 outer tips + 5 inner concave vertices, alternating). The
      // inner/outer radius ratio is kept high (stubby points, not thin
      // spikes) so it reads as a plump, semi-filled star silhouette rather
      // than the sparse spike "star" shape below.
      const outerR = 55 + Math.random() * 25;
      const innerR = outerR * 0.5;
      const starPoints = 5;
      const poly: { x: number; y: number }[] = [];
      for (let i = 0; i < starPoints * 2; i++) {
        const angle = (i / (starPoints * 2)) * Math.PI * 2 - Math.PI / 2;
        const rad = i % 2 === 0 ? outerR : innerR;
        poly.push({ x: rad * Math.cos(angle), y: rad * Math.sin(angle) });
      }
      // Oversample the disc since roughly a third to a half of candidates
      // land outside the star's concave notches and get discarded.
      const candidates = 150 + Math.floor(Math.random() * 60);
      for (let i = 0; i < candidates; i++) {
        const r = outerR * Math.sqrt((i + 0.5) / candidates);
        const angle = i * FIREWORK_GOLDEN_ANGLE;
        const px = r * Math.cos(angle);
        const py = r * Math.sin(angle);
        if (!pointInPolygon(px, py, poly)) continue;
        fireworkSparks.push({
          x,
          y,
          vx: px / 0.5,
          vy: py / 0.5,
          color: pickColor(),
          bornAt: now,
          lifespanMs: sparkLifespanMs(),
        });
      }
      return;
    }

    if (shape === "star") {
      // A handful of straight rays (5 points — a nod to the flag's stars)
      // each carrying a spread of sparks at increasing speed, so within a
      // ray the sparks fan out into a spike instead of a scattered blob —
      // together the rays read as a sparse star silhouette rather than a
      // circle (contrast the filled-in "dotmatrixStar" above).
      const points = 5;
      const sparksPerRay = 8 + Math.floor(Math.random() * 4); // 8-11
      for (let p = 0; p < points; p++) {
        const angle = (p / points) * Math.PI * 2 - Math.PI / 2; // one ray points straight up
        for (let j = 0; j < sparksPerRay; j++) {
          const frac = (j + 1) / sparksPerRay;
          const speed = 60 + frac * 220; // tip of the ray moves fastest, so the spike stretches out over time
          fireworkSparks.push({
            x,
            y,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            color: pickColor(),
            bornAt: now,
            lifespanMs: sparkLifespanMs(),
          });
        }
      }
      return;
    }

    if (shape === "ring") {
      const count = 40 + Math.floor(Math.random() * 16); // 40-55, evenly spaced
      const speed = 140 + Math.random() * 80; // shared speed keeps the ring a clean circle as it expands
      for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2;
        fireworkSparks.push({
          x,
          y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          color: pickColor(),
          bornAt: now,
          lifespanMs: sparkLifespanMs(),
        });
      }
      return;
    }

    // "scattered" — the classic randomized-angle, randomized-speed burst.
    const count = 36 + Math.floor(Math.random() * 24); // 36-59 sparks
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 70 + Math.random() * 190;
      fireworkSparks.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        color: pickColor(),
        bornAt: now,
        lifespanMs: sparkLifespanMs(),
      });
    }
  }

  function spawnRocket(): void {
    // Target apex somewhere between 35% and 95% up from the bottom (i.e.
    // bursting anywhere from just above center to near the top, but never
    // lower than the top two-thirds of the screen), then back-solve the
    // launch speed needed to reach it under gravity (v² = 2·g·h) — this is
    // what makes rockets burst at varying heights instead of all popping at
    // the same point.
    const targetHeight = window.innerHeight * (0.35 + Math.random() * 0.6);
    const vy0 = -Math.sqrt(2 * FIREWORK_GRAVITY * targetHeight);
    fireworkRockets.push({
      x: window.innerWidth * (0.05 + Math.random() * 0.9),
      y: window.innerHeight,
      vx: (Math.random() - 0.5) * 40,
      vy: vy0,
      trail: [],
    });
  }

  function scheduleNextLaunch(): void {
    const delay = FIREWORK_LAUNCH_MIN_MS + Math.random() * (FIREWORK_LAUNCH_MAX_MS - FIREWORK_LAUNCH_MIN_MS);
    fireworkTimeoutId = window.setTimeout(() => {
      spawnRocket();
      // Occasional quick second launch, like lightning's double-strike.
      if (Math.random() < 0.3) {
        window.setTimeout(spawnRocket, 80 + Math.random() * 220);
      }
      scheduleNextLaunch();
    }, delay);
  }

  /** Quick single-pulse flash curve for the burst's darken overlay — a fast
   *  rise then a slow fade, unlike lightning's two-pulse flicker since a
   *  firework burst is one clean flash rather than a stuttering strike. */
  function flashIntensity(elapsedMs: number): number {
    if (elapsedMs >= FIREWORK_FLASH_DURATION_MS) return 0;
    const t = elapsedMs / FIREWORK_FLASH_DURATION_MS;
    return Math.exp(-Math.pow((t - 0.1) / 0.3, 2));
  }

  let lastFrame = performance.now();

  function frame(now: number): void {
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;

    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

    for (let i = fireworkRockets.length - 1; i >= 0; i--) {
      const r = fireworkRockets[i]!;
      const nextVy = r.vy + FIREWORK_GRAVITY * dt;
      if (r.vy < 0 && nextVy >= 0) {
        burst(r.x, r.y, now);
        fireworkRockets.splice(i, 1);
        continue;
      }
      r.vy = nextVy;
      r.x += r.vx * dt;
      r.y += r.vy * dt;
      r.trail.push({ x: r.x, y: r.y });
      if (r.trail.length > 8) r.trail.shift();
    }

    fireworkSparks = fireworkSparks.filter((s) => now - s.bornAt < s.lifespanMs);
    for (const s of fireworkSparks) {
      s.vy += FIREWORK_SPARK_GRAVITY * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
    }

    fireworkFlashes = fireworkFlashes.filter((t) => now - t < FIREWORK_FLASH_DURATION_MS);
    let maxFlash = 0;
    for (const t of fireworkFlashes) {
      const a = flashIntensity(now - t);
      if (a > maxFlash) maxFlash = a;
    }
    if (maxFlash > 0.01) {
      ctx.fillStyle = `rgba(0, 0, 10, ${maxFlash * FIREWORK_DARKEN_STRENGTH})`;
      ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
    }

    for (const r of fireworkRockets) {
      if (r.trail.length < 2) continue;
      ctx.save();
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.beginPath();
      const [first, ...rest] = r.trail;
      ctx.moveTo(first!.x, first!.y);
      for (const p of rest) ctx.lineTo(p.x, p.y);
      ctx.strokeStyle = "rgba(255, 214, 130, 0.85)";
      ctx.lineWidth = 2;
      ctx.shadowColor = "rgba(255, 214, 130, 0.8)";
      ctx.shadowBlur = 8;
      ctx.stroke();
      ctx.restore();
    }

    for (const s of fireworkSparks) {
      const alpha = Math.max(0, 1 - (now - s.bornAt) / s.lifespanMs);
      ctx.beginPath();
      ctx.arc(s.x, s.y, 2.2, 0, Math.PI * 2);
      ctx.fillStyle = s.color;
      ctx.globalAlpha = alpha;
      ctx.shadowColor = s.color;
      ctx.shadowBlur = 10 * alpha;
      ctx.fill();
    }

    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;

    seasonalAnimationId = requestAnimationFrame(frame);
  }

  seasonalAnimationId = requestAnimationFrame(frame);

  // First launch arrives quickly, same as lightning's first strike, so the
  // theme doesn't feel empty right after switching to it.
  fireworkTimeoutId = window.setTimeout(() => {
    spawnRocket();
    scheduleNextLaunch();
  }, 400 + Math.random() * 800);

  seasonalResizeHandler = () => resizeSeasonalCanvas();
  window.addEventListener("resize", seasonalResizeHandler);
}

window.addEventListener("themechange", () =>
  applySeasonalEffect(
    settings.theme === "cycle" ? getCurrentCycleUnderlyingThemeId() : settings.theme,
  ),
);
