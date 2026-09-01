/* =============================================================================
   RICH TEXT: the renderer for text the USER wrote
   -----------------------------------------------------------------------------
   There are now two Markdown renderers in this app and they are not
   interchangeable. The one in docs.ts renders the project's own shipped
   documents (README.md, SECURITY.md, the changelog): trusted files that are
   part of the build, so it passes raw HTML blocks straight through on purpose,
   because those documents use HTML for things Markdown cannot express.

   This one renders text a person typed into a card or a comment. That text is
   not trusted and never becomes markup:

     • every character of the source is HTML-escaped BEFORE any tag is emitted,
       so the only tags in the output are ones this file wrote;
     • no raw HTML passthrough, at all, in any position;
     • a link's destination never reaches an href. It is checked against an
       allowlist of schemes and then parked in a data attribute, so even a
       scheme this file failed to think of cannot be navigated to by a click.

   The escape-then-emit order is the whole safety argument, and it is why the
   inline pass below walks the string in one scan rather than running a chain of
   .replace() calls: a chain escapes first and then rewrites, which means the
   later rules are matching against text that has already grown "&amp;" in it.

   WHAT IT SUPPORTS, and why that list and not a longer one. Headings, bold,
   italic, strikethrough, inline code, fenced code, links, bullet and numbered
   lists, task lists, quotes, rules and pipe tables. That is the set a person
   reaches for when writing down what a piece of work actually is. Images are
   deliberately NOT part of it: a card's pictures are its attachments, which are
   real files this app owns, and a Markdown image tag pointing at somebody
   else's server would be both a broken image (the CSP blocks it) and a beacon.
   Image syntax renders as a link so nothing typed is silently swallowed.

   A single newline inside a paragraph is a line break, not a space. This is a
   notes field, not a typesetting system: the person pressed Enter because they
   wanted a new line.
============================================================================= */

import { openUrl } from "@tauri-apps/plugin-opener";

/** Schemes a link in user text is allowed to carry. Everything else renders as
 *  plain text, which is the honest outcome: the words are still there and the
 *  thing that cannot be trusted is not clickable. */
const SAFE_LINK_SCHEME = /^(?:https?:\/\/|mailto:)/i;

/** Bare URLs get linked too. Trailing punctuation is excluded so a URL at the
 *  end of a sentence does not swallow the full stop. */
const BARE_URL = /https?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]}]/;

/** The destination inside a link's brackets. One level of nested parentheses is
 *  allowed, because Wikipedia-shaped URLs end in one and stopping at the first
 *  ")" would cut the address in half and leave a stray bracket in the text. */
const DESTINATION = "(?:[^()\\s]|\\([^()\\s]*\\))*";

/** Markdown's optional link title, [a](url "tip"). Consumed and discarded: a
 *  tooltip on a link inside a card note is not worth a second attribute, but a
 *  title typed out of habit should not stop the link from working. */
const TITLE = '(?:\\s+"[^"]*")?';

export function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* -----------------------------------------------------------------------------
   INLINE PASS
----------------------------------------------------------------------------- */

/** One scan, one alternation, so every rule sees the ORIGINAL characters. The
 *  order of the branches is the precedence: code spans win over everything
 *  inside them, and the image branch has to come before the link branch or
 *  "![alt](src)" matches as a link and leaves a stray "!" behind. */
const INLINE = new RegExp(
  [
    "(?<code>`[^`\\n]+`)",
    `(?<image>!\\[(?<imgAlt>[^\\]]*)\\]\\((?<imgSrc>${DESTINATION})${TITLE}\\))`,
    `(?<link>\\[(?<linkText>[^\\]]+)\\]\\((?<linkHref>${DESTINATION})${TITLE}\\))`,
    "(?<strong>\\*\\*(?<strongText>[^*]+)\\*\\*)",
    "(?<strongU>__(?<strongUText>[^_]+)__)",
    "(?<strike>~~(?<strikeText>[^~]+)~~)",
    "(?<em>\\*(?<emText>[^*\\n]+)\\*)",
    "(?<emU>\\b_(?<emUText>[^_\\n]+)_\\b)",
    `(?<url>${BARE_URL.source})`,
  ].join("|"),
  "g",
);

/** Renders one line's inline formatting. `raw` is the untouched source line;
 *  everything that is not a recognised construct is escaped on the way out.
 *
 *  Every match is collected BEFORE any of them is handled, because handling one
 *  recurses back into this function (bold text can contain a link, a link's
 *  label can contain code). Walking a shared global regex with exec() while a
 *  nested call is walking the same object with the same lastIndex loses matches
 *  in the outer pass; matchAll works on a clone, and spreading it finishes the
 *  scan before the first recursion starts. */
function inline(raw: string): string {
  let out = "";
  let last = 0;

  for (const m of [...raw.matchAll(INLINE)]) {
    const g = m.groups!;
    out += escapeHtmlText(raw.slice(last, m.index));
    last = m.index + m[0].length;

    if (g.code !== undefined) {
      out += `<code class="rt-code">${escapeHtmlText(g.code.slice(1, -1))}</code>`;
    } else if (g.image !== undefined) {
      // See the header: image syntax is shown as a link, never as an <img>.
      const src = g.imgSrc ?? "";
      out += g.imgAlt ? anchor(src, g.imgAlt) : anchor(src, src || "image", true);
    } else if (g.link !== undefined) {
      out += anchor(g.linkHref ?? "", g.linkText ?? "");
    } else if (g.strong !== undefined) {
      out += `<strong>${inline(g.strongText ?? "")}</strong>`;
    } else if (g.strongU !== undefined) {
      out += `<strong>${inline(g.strongUText ?? "")}</strong>`;
    } else if (g.strike !== undefined) {
      out += `<s>${inline(g.strikeText ?? "")}</s>`;
    } else if (g.em !== undefined) {
      out += `<em>${inline(g.emText ?? "")}</em>`;
    } else if (g.emU !== undefined) {
      out += `<em>${inline(g.emUText ?? "")}</em>`;
    } else if (g.url !== undefined) {
      // The label IS the URL, so it must not be handed back to the scanner: it
      // would match the bare-URL branch again and recurse until the stack ran
      // out. Same reason the image branch above passes plain when it has no alt.
      out += anchor(g.url, g.url, true);
    }
  }

  out += escapeHtmlText(raw.slice(last));
  return out;
}

/** A link, or the label as plain text when the destination is not a scheme this
 *  app will hand to the operating system. The URL goes in data-rt-href rather
 *  than href: nothing in the rendered output is navigable on its own, and the
 *  click handler is the only route out (see bindRichTextLinks). */
function anchor(href: string, label: string, plainLabel = false): string {
  // `plainLabel` says the label is literal text rather than more Markdown. Every
  // other recursion in this file strictly shrinks the string (a wrapper's
  // delimiters are gone by the time its contents come back round), so a label
  // that is itself the URL is the only place the scan could fail to terminate.
  // It is closed here rather than with a depth counter, which would silently
  // truncate deeply nested formatting instead.
  const text = (plainLabel ? escapeHtmlText(label) : inline(label)) || escapeHtmlText(href);
  if (!SAFE_LINK_SCHEME.test(href)) return text;
  return `<a class="rt-link" role="link" tabindex="0" data-rt-href="${escapeHtmlText(href)}">${text}</a>`;
}

/* -----------------------------------------------------------------------------
   BLOCK PASS
----------------------------------------------------------------------------- */

type ListKind = "ul" | "ol" | null;

/**
 * Renders user-written Markdown to HTML that is safe to assign with innerHTML.
 *
 * Returns an empty string for empty input, so a caller can use the result's
 * emptiness to decide whether to draw a container at all.
 */
export function renderRichText(source: string): string {
  if (!source || !source.trim()) return "";

  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];

  let list: ListKind = null;
  let inQuote = false;
  let inFence = false;
  let fence: string[] = [];
  let inTable = false;
  let tableHeaderDone = false;
  let paragraph: string[] = [];

  const closeParagraph = (): void => {
    if (paragraph.length === 0) return;
    // Single newlines inside a paragraph become <br>. See the header note.
    out.push(`<p class="rt-p">${paragraph.join("<br>")}</p>`);
    paragraph = [];
  };
  const closeList = (): void => {
    if (!list) return;
    out.push(`</${list}>`);
    list = null;
  };
  const closeQuote = (): void => {
    if (!inQuote) return;
    out.push("</blockquote>");
    inQuote = false;
  };
  const closeTable = (): void => {
    if (!inTable) return;
    out.push("</tbody></table></div>");
    inTable = false;
    tableHeaderDone = false;
  };
  /** Everything that is currently open except the fence, which owns its own
   *  lifetime. Called before starting any new block so the nesting can never
   *  come out interleaved. */
  const closeAll = (): void => {
    closeParagraph();
    closeList();
    closeQuote();
    closeTable();
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");

    /* Fenced code. Collected verbatim and escaped as one block, so nothing
       inside a fence is ever read as formatting. */
    if (/^\s*```/.test(line)) {
      if (inFence) {
        out.push(`<pre class="rt-pre"><code>${escapeHtmlText(fence.join("\n"))}</code></pre>`);
        inFence = false;
        fence = [];
      } else {
        closeAll();
        inFence = true;
        fence = [];
      }
      continue;
    }
    if (inFence) {
      fence.push(raw);
      continue;
    }

    if (line.trim() === "") {
      closeAll();
      continue;
    }

    // Heading. Capped at three levels: a card description with an <h4> in it is
    // already a document, and deeper levels stop being visually distinct.
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      closeAll();
      const level = heading[1].length;
      out.push(`<h${level + 3} class="rt-h${level}">${inline(heading[2])}</h${level + 3}>`);
      continue;
    }

    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
      closeAll();
      out.push('<hr class="rt-hr">');
      continue;
    }

    // Pipe table. The alignment row is consumed rather than drawn; per-column
    // alignment is not supported, so drawing it would be drawing a lie.
    if (/^\s*\|.*\|\s*$/.test(line)) {
      closeParagraph();
      closeList();
      closeQuote();
      if (!inTable) {
        out.push('<div class="rt-table-wrap"><table class="rt-table"><tbody>');
        inTable = true;
        tableHeaderDone = false;
      }
      if (/^\s*\|[\s|:-]+\|\s*$/.test(line)) {
        tableHeaderDone = true;
        continue;
      }
      const cells = line
        .trim()
        .slice(1, -1)
        .split("|")
        .map((c) => inline(c.trim()));
      const tag = tableHeaderDone ? "td" : "th";
      out.push(`<tr>${cells.map((c) => `<${tag}>${c}</${tag}>`).join("")}</tr>`);
      continue;
    }
    closeTable();

    // Blockquote. Consecutive quoted lines are one quote rather than a stack of
    // one-line quotes, which is what makes a quoted paragraph look quoted.
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      closeParagraph();
      closeList();
      if (!inQuote) {
        out.push('<blockquote class="rt-quote">');
        inQuote = true;
      }
      out.push(`<p class="rt-p">${inline(quote[1])}</p>`);
      continue;
    }
    closeQuote();

    /* List items. A task marker is recognised inside a bullet and drawn as a
       read-only box: these are a way of writing a checklist in prose, and the
       card's own Subtasks block is the one that is actually tickable. */
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      closeParagraph();
      const want: ListKind = bullet ? "ul" : "ol";
      if (list !== want) {
        closeList();
        out.push(`<${want} class="rt-list">`);
        list = want;
      }
      let text = (bullet ? bullet[1] : numbered![1]) ?? "";
      const task = text.match(/^\[([ xX])\]\s+(.*)$/);
      if (task) {
        const checked = task[1].toLowerCase() === "x";
        out.push(
          `<li class="rt-task${checked ? " rt-task-done" : ""}">` +
            `<span class="rt-task-box" aria-hidden="true">${checked ? "✓" : ""}</span>` +
            `<span>${inline(task[2])}</span></li>`,
        );
        continue;
      }
      out.push(`<li>${inline(text)}</li>`);
      continue;
    }
    closeList();

    paragraph.push(inline(line));
  }

  // Anything still open at the end of the source closes here. An unterminated
  // fence flushes what it collected rather than swallowing the rest of the text.
  if (inFence) out.push(`<pre class="rt-pre"><code>${escapeHtmlText(fence.join("\n"))}</code></pre>`);
  closeAll();

  return out.join("\n");
}

/** The same text with its formatting markers taken off, for the places that
 *  need one line of it: a card-face preview, a search index, a tooltip. */
export function richTextToPlain(source: string): string {
  return source
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*[-*+]\s+(\[[ xX]\]\s+)?/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/[*_~]{1,2}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/* -----------------------------------------------------------------------------
   LINKS
----------------------------------------------------------------------------- */

/**
 * Makes the links inside a rendered block work. One delegated listener on the
 * container, so a block that is re-rendered a hundred times does not leave a
 * hundred listeners behind; call it once per container, when the container is
 * created.
 *
 * The destination is re-checked here rather than trusted from the attribute.
 * The renderer already refuses to write an unsafe one, but this is the function
 * that actually hands a string to the operating system, and that check belongs
 * where the handover is.
 */
export function bindRichTextLinks(container: HTMLElement): void {
  const follow = (target: EventTarget | null): void => {
    const link = (target as HTMLElement | null)?.closest?.<HTMLElement>("[data-rt-href]");
    const href = link?.dataset.rtHref;
    if (!href || !SAFE_LINK_SCHEME.test(href)) return;
    void openUrl(href).catch(() => {});
  };
  container.addEventListener("click", (e) => {
    if ((e.target as HTMLElement)?.closest?.("[data-rt-href]")) e.preventDefault();
    follow(e.target);
  });
  container.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    if (!(e.target as HTMLElement)?.closest?.("[data-rt-href]")) return;
    e.preventDefault();
    follow(e.target);
  });
}

/* -----------------------------------------------------------------------------
   THE EDITING TOOLBAR
   -----------------------------------------------------------------------------
   Every button is the same shape of operation: take the selection, put
   something around it or in front of it, and leave the caret somewhere useful.
   Doing that through one function is what keeps the buttons consistent, and
   what keeps undo working: setRangeText is a native edit, so Ctrl+Z still
   walks back through it.
----------------------------------------------------------------------------- */

export type RichTextCommand =
  | "bold"
  | "italic"
  | "strike"
  | "code"
  | "codeblock"
  | "link"
  | "heading"
  | "quote"
  | "bullet"
  | "numbered";

/** What each button wraps a selection in, or puts at the head of its lines. */
const WRAPS: Partial<Record<RichTextCommand, { open: string; close: string; hint: string }>> = {
  bold: { open: "**", close: "**", hint: "bold text" },
  italic: { open: "*", close: "*", hint: "italic text" },
  strike: { open: "~~", close: "~~", hint: "struck text" },
  code: { open: "`", close: "`", hint: "code" },
  codeblock: { open: "```\n", close: "\n```", hint: "code" },
};

const PREFIXES: Partial<Record<RichTextCommand, string>> = {
  heading: "## ",
  quote: "> ",
  bullet: "- ",
};

/**
 * Applies one toolbar command to a textarea, in place.
 *
 * The textarea is left focused with a selection, because the next thing after
 * pressing Bold is always typing: with nothing selected the placeholder word is
 * selected so typing replaces it, and with a selection the wrapped text stays
 * selected so a second format can be applied on top.
 *
 * Does not dispatch an input event; the caller decides what "changed" means for
 * its own field (see the "input" listeners in kanban.ts, which is why every
 * caller fires one after this returns).
 */
export function applyRichTextCommand(area: HTMLTextAreaElement, command: RichTextCommand): void {
  const start = area.selectionStart;
  const end = area.selectionEnd;
  const selected = area.value.slice(start, end);

  if (command === "link") {
    const label = selected || "link text";
    const inserted = `[${label}](https://)`;
    area.setRangeText(inserted, start, end, "end");
    // Caret parked inside the empty destination, which is the part that still
    // has to be filled in.
    const at = start + label.length + 3;
    area.setSelectionRange(at, at + "https://".length);
    area.focus();
    return;
  }

  const wrap = WRAPS[command];
  if (wrap) {
    const body = selected || wrap.hint;
    area.setRangeText(`${wrap.open}${body}${wrap.close}`, start, end, "end");
    area.setSelectionRange(start + wrap.open.length, start + wrap.open.length + body.length);
    area.focus();
    return;
  }

  /* Line prefixes. These apply to whole lines, so the range is widened to the
     line boundaries first: pressing Bullet with the caret mid-word should
     bullet that line, not split it. */
  const lineStart = area.value.lastIndexOf("\n", start - 1) + 1;
  const lineEndAt = area.value.indexOf("\n", end);
  const lineEnd = lineEndAt === -1 ? area.value.length : lineEndAt;
  const block = area.value.slice(lineStart, lineEnd);

  let replaced: string;
  if (command === "numbered") {
    replaced = block
      .split("\n")
      .map((line, i) => `${i + 1}. ${line.replace(/^\s*\d+[.)]\s+/, "")}`)
      .join("\n");
  } else {
    const prefix = PREFIXES[command] ?? "";
    // Pressing the same button again takes the prefix off, so a mis-click is
    // one press to undo rather than a hunt for the character.
    const allPrefixed = block.split("\n").every((line) => line.startsWith(prefix));
    replaced = block
      .split("\n")
      .map((line) => (allPrefixed ? line.slice(prefix.length) : prefix + line))
      .join("\n");
  }

  area.setRangeText(replaced, lineStart, lineEnd, "end");
  area.setSelectionRange(lineStart, lineStart + replaced.length);
  area.focus();
}
