/* =============================================================================
   EXTERNAL LINKS
   -----------------------------------------------------------------------------
   The one way this app opens a web page in the user's browser.

   It used to be the opener plugin's openUrl, called from four places, plus the
   plugin's own injected script for any target="_blank" link. Both ran the
   hand-off from this elevated process, and a browser the user already has open
   will not take a hand-off from an elevated one, so the link did nothing and
   said nothing. open_external_url (src-tauri/src/external_link.rs) asks
   Explorer to do it instead, at the user's own integrity.

   A LEAF: it imports only the Tauri bridge. rich-text.ts needs it and sits
   below the shell, so pulling shell in here would be a load-order loop for no
   gain. Callers decide how to report a failure; see the toast in docs.ts.
============================================================================= */

import { invoke } from "@tauri-apps/api/core";

/** Opens `url` in the default browser (or mail client, for mailto). Rejects
 *  with the reason when it could not, which is only when both the Explorer
 *  hand-off and the old direct route failed, or the link is not http, https
 *  or mailto. */
export function openExternal(url: string): Promise<void> {
  return invoke<void>("open_external_url", { url });
}

const OPENABLE = ["http:", "https:", "mailto:"];

/**
 * Sends every target="_blank" link in the app through openExternal.
 *
 * This is the job the opener plugin's injected script did, and does no longer:
 * lib.rs turns that script off, because it went straight to the plugin's own
 * elevated open. Same rules it used, so nothing that opened before stops
 * opening: a plain left click on a _blank link, or a Ctrl or Shift click on
 * any link, and only for web and mail addresses. A handler earlier in the
 * page that has already dealt with the click (preventDefault) wins, which is
 * how the About modal's own links avoid being opened twice.
 *
 * Call once, at startup.
 */
export function bindExternalLinks(onError: (reason: unknown) => void): void {
  window.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.altKey) return;
    const anchor = e
      .composedPath()
      .find((n): n is HTMLAnchorElement => n instanceof HTMLAnchorElement);
    if (!anchor?.href) return;
    if (anchor.target !== "_blank" && !e.ctrlKey && !e.shiftKey) return;

    let url: URL;
    try {
      url = new URL(anchor.href);
    } catch {
      return;
    }
    if (!OPENABLE.includes(url.protocol)) return;

    e.preventDefault();
    openExternal(url.href).catch(onError);
  });
}
