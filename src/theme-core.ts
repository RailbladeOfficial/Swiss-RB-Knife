/* =============================================================================
   THEME CORE  — applyTheme() dispatcher + seasonal canvas effects
   -----------------------------------------------------------------------------
   Owns applyTheme() (the single entry point for switching to a named theme,
   Random, or a Custom theme) and the Christmas/Halloween seasonal canvas
   animations. Also owns `_activeCustomId` — which custom theme (if any) is
   currently active — since that's fundamentally theme-selection state, not
   shell chrome.

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

export const themeLink = document.getElementById("themeLink") as HTMLLinkElement;

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
    themeLink.href = "/themes/default.css";
    themeLink.onload = () => {
      if (_activeCustomId) applyCustomThemeById(_activeCustomId);
    };
    if (_activeCustomId) applyCustomThemeById(_activeCustomId);
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
      themeLink.href = "/themes/default.css";
      themeLink.onload = () => applyPalette(palette);
      applyPalette(palette);
    } else {
      // Regenerative: generate fresh every time applyTheme is called
      const palette = generator();
      themeLink.href = "/themes/default.css";
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
  themeLink.href = `/themes/${themeName}.css`;
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

let seasonalCanvas: HTMLCanvasElement | null = null;
let seasonalCtx: CanvasRenderingContext2D | null = null;
let seasonalAnimationId: number | null = null;
let seasonalResizeHandler: (() => void) | null = null;
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
const LIGHTNING_DARKEN_STRENGTH = 0.4; // how far the screen dims at peak flash brightness, so bolts pop by contrast

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
 *  animation frame and any pending strike timers, drops the resize listener,
 *  and removes the canvas entirely. Called before starting a new effect and
 *  whenever the active theme stops being Christmas/Halloween. */
function stopSeasonalEffect(): void {
  if (seasonalAnimationId !== null) {
    cancelAnimationFrame(seasonalAnimationId);
    seasonalAnimationId = null;
  }
  if (lightningTimeoutId !== null) {
    window.clearTimeout(lightningTimeoutId);
    lightningTimeoutId = null;
  }
  if (seasonalResizeHandler) {
    window.removeEventListener("resize", seasonalResizeHandler);
    seasonalResizeHandler = null;
  }
  if (seasonalCanvas) {
    seasonalCanvas.remove();
    seasonalCanvas = null;
    seasonalCtx = null;
  }
  snowflakes = [];
  snowPile = [];
  lightningStrikes = [];
  seasonalActiveTheme = null;
}

/** Starts (or leaves running) the canvas effect matching the given theme
 *  name, tearing down whatever was running before. No-ops if the requested
 *  effect is already active. Called on startup and on every "themechange". */
function applySeasonalEffect(themeName: string): void {
  if (seasonalActiveTheme === themeName) return;
  stopSeasonalEffect();
  if (themeName === "christmas") {
    seasonalActiveTheme = "christmas";
    startChristmasSnow();
  } else if (themeName === "halloween") {
    seasonalActiveTheme = "halloween";
    startHalloweenLightning();
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
      window.setTimeout(spawnStrike, 60 + Math.random() * 90);
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
  document.addEventListener("click", () => spawnStrike());
}

window.addEventListener("themechange", () =>
  applySeasonalEffect(settings.theme),
);
