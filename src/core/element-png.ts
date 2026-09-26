/* =============================================================================
   ELEMENT TO PNG
   -----------------------------------------------------------------------------
   Paints a rendered piece of the page onto a canvas and returns it as PNG
   bytes. No library: it walks the element as laid out right now, reading
   positions from getBoundingClientRect and colors from computed style, so the
   picture matches the current theme with nothing to keep in sync.

   What it draws: background colors, borders, border radius, opacity, text
   (placed word by word, so wrapping and alignment come out exactly as shown),
   <canvas> and <img> content, and the clipping of scroll containers.

   What it leaves out: box shadows, gradients and background images (the
   background color underneath is drawn instead), ::before/::after content,
   and inline SVG. None of those carry information in the views that use it.

   Positions come from the live layout, so the element must be displayed when
   this runs. It does not need to be on screen: anything scrolled out of view
   still has a layout and is captured whole.
============================================================================= */

export interface ElementPngOptions {
  /** Opaque fill behind everything. Defaults to the page's own background. */
  background?: string;
  /** Space around the element, in CSS pixels. Default 16. */
  padding?: number;
  /** Output pixels per CSS pixel. Default 2, so text stays sharp when zoomed. */
  scale?: number;
}

/** Chromium's canvas limit is far above this; this is about file size. */
const MAX_SIDE = 16000;

export async function elementToPng(root: HTMLElement, opts: ElementPngOptions = {}): Promise<Uint8Array> {
  // Web fonts that have not finished loading would be drawn in the fallback.
  await document.fonts?.ready;

  const pad = opts.padding ?? 16;
  const box = root.getBoundingClientRect();
  const width = Math.ceil(box.width + pad * 2);
  const height = Math.ceil(box.height + pad * 2);
  let scale = opts.scale ?? 2;
  scale = Math.min(scale, MAX_SIDE / width, MAX_SIDE / height);

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not create an image to draw on.");

  ctx.scale(scale, scale);
  ctx.fillStyle = opts.background ?? pageBackground();
  ctx.fillRect(0, 0, width, height);
  // Every rect below is in viewport space; this moves the element's top-left
  // corner to the padding.
  ctx.translate(pad - box.left, pad - box.top);

  paintElement(ctx, root);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("The image could not be encoded.");
  return new Uint8Array(await blob.arrayBuffer());
}

/** The first opaque background up the page, since a theme may paint the body
 *  with a gradient that has no single color to hand back. */
function pageBackground(): string {
  for (const el of [document.body, document.documentElement]) {
    const c = getComputedStyle(el).backgroundColor;
    if (!isTransparent(c)) return c;
  }
  return "#202020";
}

function isTransparent(color: string): boolean {
  return color === "transparent" || /rgba\([^)]*,\s*0\s*\)$/.test(color);
}

function px(value: string): number {
  return parseFloat(value) || 0;
}

function paintElement(ctx: CanvasRenderingContext2D, el: Element): void {
  const cs = getComputedStyle(el);
  if (cs.display === "none") return;
  // SVG is not drawn (see header), and descending into it only finds shapes.
  if (el instanceof SVGElement) return;

  const opacity = px(cs.opacity || "1");
  if (opacity <= 0) return;

  ctx.save();
  ctx.globalAlpha *= opacity;

  const r = el.getBoundingClientRect();
  const visible = cs.visibility !== "hidden";

  if (visible && r.width > 0 && r.height > 0) {
    const radius = px(cs.borderTopLeftRadius);
    if (!isTransparent(cs.backgroundColor)) {
      ctx.fillStyle = cs.backgroundColor;
      ctx.beginPath();
      ctx.roundRect(r.left, r.top, r.width, r.height, radius);
      ctx.fill();
    }
    paintBorders(ctx, cs, r, radius);

    if (el instanceof HTMLCanvasElement && el.width > 0 && el.height > 0) {
      ctx.drawImage(el, r.left, r.top, r.width, r.height);
    } else if (el instanceof HTMLImageElement && el.complete && el.naturalWidth > 0) {
      try {
        ctx.drawImage(el, r.left, r.top, r.width, r.height);
      } catch {
        // A cross-origin image would taint the canvas; leave it out.
      }
    }
  }

  // A scroll container shows only what is inside its box, so the picture does
  // too, including a sticky column's worth of content scrolled under it.
  if (cs.overflowX !== "visible" || cs.overflowY !== "visible") {
    ctx.beginPath();
    ctx.roundRect(r.left, r.top, r.width, r.height, px(cs.borderTopLeftRadius));
    ctx.clip();
  }

  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      if (visible) paintText(ctx, child as Text, cs);
    } else if (child instanceof Element) {
      paintElement(ctx, child);
    }
  }

  ctx.restore();
}

function paintBorders(ctx: CanvasRenderingContext2D, cs: CSSStyleDeclaration, r: DOMRect, radius: number): void {
  const sides = [
    { w: px(cs.borderTopWidth), c: cs.borderTopColor, s: cs.borderTopStyle },
    { w: px(cs.borderRightWidth), c: cs.borderRightColor, s: cs.borderRightStyle },
    { w: px(cs.borderBottomWidth), c: cs.borderBottomColor, s: cs.borderBottomStyle },
    { w: px(cs.borderLeftWidth), c: cs.borderLeftColor, s: cs.borderLeftStyle },
  ];
  const shows = (s: { w: number; c: string; s: string }) => s.w > 0 && s.s !== "none" && s.s !== "hidden" && !isTransparent(s.c);
  if (!sides.some(shows)) return;

  const same = sides.every((s) => s.w === sides[0].w && s.c === sides[0].c && s.s === sides[0].s);
  if (same) {
    const w = sides[0].w;
    ctx.strokeStyle = sides[0].c;
    ctx.lineWidth = w;
    ctx.setLineDash(sides[0].s === "dashed" ? [w * 3, w * 2] : sides[0].s === "dotted" ? [w, w] : []);
    ctx.beginPath();
    ctx.roundRect(r.left + w / 2, r.top + w / 2, r.width - w, r.height - w, Math.max(0, radius - w / 2));
    ctx.stroke();
    ctx.setLineDash([]);
    return;
  }

  // Mixed sides, as on table cells and accent edges: each drawn as a
  // straight bar, clipped to the rounded box so corners stay round.
  const [top, right, bottom, left] = sides;
  ctx.save();
  if (radius > 0) {
    ctx.beginPath();
    ctx.roundRect(r.left, r.top, r.width, r.height, radius);
    ctx.clip();
  }
  if (shows(top)) fillBar(ctx, top.c, r.left, r.top, r.width, top.w);
  if (shows(right)) fillBar(ctx, right.c, r.right - right.w, r.top, right.w, r.height);
  if (shows(bottom)) fillBar(ctx, bottom.c, r.left, r.bottom - bottom.w, r.width, bottom.w);
  if (shows(left)) fillBar(ctx, left.c, r.left, r.top, left.w, r.height);
  ctx.restore();
}

function fillBar(ctx: CanvasRenderingContext2D, color: string, x: number, y: number, w: number, h: number): void {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

function transformText(text: string, transform: string): string {
  if (transform === "uppercase") return text.toUpperCase();
  if (transform === "lowercase") return text.toLowerCase();
  if (transform === "capitalize") return text.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
  return text;
}

/** Draws a text node one word at a time at the spot the browser laid each
 *  word out, which carries wrapping, alignment and table cell padding over
 *  without re-implementing any of them. */
function paintText(ctx: CanvasRenderingContext2D, node: Text, cs: CSSStyleDeclaration): void {
  const text = node.data;
  if (!text.trim()) return;

  ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  ctx.fillStyle = cs.color;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.letterSpacing = cs.letterSpacing === "normal" ? "0px" : cs.letterSpacing;

  const range = document.createRange();
  for (const m of text.matchAll(/\S+/g)) {
    const start = m.index ?? 0;
    range.setStart(node, start);
    range.setEnd(node, start + m[0].length);
    const rects = range.getClientRects();
    if (rects.length === 0) continue;
    const word = transformText(m[0], cs.textTransform);
    // A range's rect is the font's content area, so its top plus the font's
    // ascent is the baseline the browser drew on.
    const ascent = ctx.measureText(word).fontBoundingBoxAscent;
    if (rects.length === 1) {
      ctx.fillText(word, rects[0].left, rects[0].top + ascent);
    } else {
      // A word broken across lines (break-word on a long name): draw it
      // letter by letter so each piece lands on its own line.
      for (let i = 0; i < m[0].length; i++) {
        range.setStart(node, start + i);
        range.setEnd(node, start + i + 1);
        const cr = range.getBoundingClientRect();
        if (cr.width === 0 && cr.height === 0) continue;
        ctx.fillText(transformText(m[0][i], cs.textTransform), cr.left, cr.top + ascent);
      }
    }
  }
  range.detach();
}
