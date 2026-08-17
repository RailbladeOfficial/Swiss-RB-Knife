/* =============================================================================
   DOCS: About/Changelog/Licensing/README/Security/Contributing/Full License
           modals, the README image lightbox, the Markdown renderer, the
           license-agreement first-launch gate, and startup gate sequencing.
   -----------------------------------------------------------------------------
   Split out of shell.ts (Tier 6). runStartupGates() here is the app's actual
   startup sequencer (app lock -> license agreement -> auto-changelog ->
   runStartupNudges) and calls into lockscreen.ts (showLockScreen) and back
   into shell.ts core (maybeShowBackupReminder / maybeShowBudgetReminder. The
   tool reminder nags aren't legal/about content, so they stay in core shell.ts
   despite living right next to this code in the original file).

   CHANGELOG_SEEN_KEY and LICENSE_ACCEPTED_KEY moved here from random-theme.ts
:   they were physically declared in the Random Theme Helpers section of the
   original file despite being changelog/license-agreement concerns with
   nothing to do with theming.
============================================================================= */

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Modal } from "./modal";
import {
  settings,
  flash,
  devError,
  escapeHtml,
  saveSettings,
  settingsModal,
  quitApp,
  maybeShowBackupReminder,
  maybeShowBudgetReminder,
  setAboutUpdatePulse,
  gentleNudge,
  type UpdateInfo,
  LICENSE_VERSION,
} from "./shell";
import { showLockScreen } from "./lockscreen";

const LICENSE_ACCEPTED_KEY = "shell-license-accepted-version";
const CHANGELOG_SEEN_KEY = "shell-changelog-seen-version";

/* ── Element refs ────────────────────────────────────────────────────────── */

const aboutBtn = document.getElementById("aboutBtn")!;
const aboutBackdrop = document.getElementById("aboutBackdrop")!;
const aboutClose = document.getElementById("aboutClose")!;

const changelogBackdrop = document.getElementById("changelogBackdrop")!;
const changelogClose = document.getElementById("changelogClose")!;
const changelogBack = document.getElementById("changelogBack")!;

const licensingBackdrop = document.getElementById("licensingBackdrop")!;
const licensingClose = document.getElementById("licensingClose")!;
const licensingBack = document.getElementById("licensingBack")!;

const fullLicenseBackdrop = document.getElementById("fullLicenseBackdrop")!;
const fullLicenseClose = document.getElementById("fullLicenseClose")!;
const fullLicenseBack = document.getElementById("fullLicenseBack")!;

const readmeBackdrop = document.getElementById("readmeBackdrop")!;
const readmeClose = document.getElementById("readmeClose")!;
const readmeBack = document.getElementById("readmeBack")!;

const securityBackdrop = document.getElementById("securityBackdrop")!;
const securityClose = document.getElementById("securityClose")!;
const securityBack = document.getElementById("securityBack")!;

const contributingBackdrop = document.getElementById("contributingBackdrop")!;
const contributingClose = document.getElementById("contributingClose")!;
const contributingBack = document.getElementById("contributingBack")!;

const imageLightboxBackdrop = document.getElementById("imageLightboxBackdrop")!;
const imageLightboxClose = document.getElementById("imageLightboxClose")!;
const imageLightboxBack = document.getElementById("imageLightboxBack")!;
const imageLightboxTitle = document.getElementById("imageLightboxTitle")!;
const imageLightboxImg = document.getElementById(
  "imageLightboxImg",
) as HTMLImageElement;

const licenseAgreementBackdrop = document.getElementById(
  "licenseAgreementBackdrop",
)!;
const licenseAcceptBtn = document.getElementById("licenseAcceptBtn")!;
const licenseDeclineBtn = document.getElementById("licenseDeclineBtn")!;

/* ── State ───────────────────────────────────────────────────────────────── */

let changelogLoaded = false;
let readmeLoaded = false;
let securityLoaded = false;
let contributingLoaded = false;
let fullLicenseLoaded = false;
let lightboxSourceImg: HTMLImageElement | null = null;
let activeTab = "license";
let _pendingReminderAfterChangelogClose = false;
let _updateInfo: UpdateInfo | null = null;
let fullLicenseReturn: (() => void) | null = null;
const licensingTabCache: Record<string, string> = {};

const aboutModal = new Modal(aboutBackdrop);

aboutBtn.addEventListener("click", () => aboutModal.open());
aboutClose.addEventListener("click", () => aboutModal.close());

// External links inside about body open in the browser; modal links are handled separately
aboutBackdrop.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  if (target.tagName === "A") {
    const anchor = target as HTMLAnchorElement;
    if (
      anchor.id === "changelogLink" ||
      anchor.id === "licensingLink" ||
      anchor.id === "readmeLink" ||
      anchor.id === "securityLink" ||
      anchor.id === "contributingLink"
    )
      return;
    e.preventDefault();
    if (anchor.href) openUrl(anchor.href);
  }
});

document.getElementById("changelogLink")!.addEventListener("click", (e) => {
  e.preventDefault();
  aboutModal.close();
  openChangelog();
});

document.getElementById("licensingLink")!.addEventListener("click", (e) => {
  e.preventDefault();
  aboutModal.close();
  openLicensing();
});

document.getElementById("readmeLink")!.addEventListener("click", (e) => {
  e.preventDefault();
  aboutModal.close();
  openReadme();
});

document.getElementById("securityLink")!.addEventListener("click", (e) => {
  e.preventDefault();
  aboutModal.close();
  openSecurity();
});

document.getElementById("contributingLink")!.addEventListener("click", (e) => {
  e.preventDefault();
  aboutModal.close();
  openContributing();
});

/* =============================================================================
   UPDATE CHECK  (shell-level)
   -----------------------------------------------------------------------------
   Opt-in, fire-and-forget version check against the GitHub Releases API (see
   lib.rs `check_for_updates`. The only network call the app makes).

   Two kinds of output, the same split Auto-Backup's and Budget's reminders use:

     • PASSIVE signals, up for as long as a newer un-ignored release exists.
       The pulsing About icon in the sidebar, the Home top-bar line, and a
       notice + Ignore button in the About modal. Every one of them funnels
       through refreshUpdateUI(), so there's a single place that reflects
       _updateInfo into the DOM.
     • One ANNOUNCEMENT per run, a toast (Gentle) or a modal (Aggressive),
       per settings.updateNotifyAggressive. See announceUpdate() below.

   (The Settings toggle that enables all of this, and the Gentle/Aggressive
   mode switch, are wired in the General Settings section.)
============================================================================= */

const updateNotice = document.getElementById("updateNotice")!;
const updateNoticeLink = document.getElementById(
  "updateNoticeLink",
) as HTMLAnchorElement;
const homeUpdateNotice = document.getElementById("homeUpdateNotice")!;
const homeUpdateLink = document.getElementById(
  "homeUpdateLink",
) as HTMLAnchorElement;
const ignoreVersionBtn = document.getElementById("ignoreVersionBtn")!;
const ignoreVersionBackdrop = document.getElementById("ignoreVersionBackdrop")!;
const ignoreVersionBack = document.getElementById("ignoreVersionBack")!;
const ignoreVersionClose = document.getElementById("ignoreVersionClose")!;
const ignoreVersionCancel = document.getElementById("ignoreVersionCancel")!;
const ignoreVersionConfirm = document.getElementById("ignoreVersionConfirm")!;
const ignoreVersionTag = document.getElementById("ignoreVersionTag")!;

const updateNotifyBackdrop = document.getElementById("updateNotifyBackdrop")!;
const updateNotifyVersion = document.getElementById("updateNotifyVersion")!;
const updateNotifyCurrent = document.getElementById("updateNotifyCurrent")!;
const updateNotifyGoBtn = document.getElementById("updateNotifyGoBtn")!;
const updateNotifyLaterBtn = document.getElementById("updateNotifyLaterBtn")!;

/** Compares two "vX.Y.Z" strings numerically. Leading 'v'/'V' and surrounding
 *  whitespace are ignored, missing trailing segments count as 0 (so "1.2" ==
 *  "1.2.0"), and any non-numeric segment is treated as 0. Returns > 0 when
 *  `a` is newer than `b`, < 0 when older, 0 when equal. Plain string compare
 *  would rank "v0.10.0" below "v0.9.0". This doesn't. */
function compareVersions(a: string, b: string): number {
  const parse = (s: string): number[] =>
    s
      .trim()
      .replace(/^v/i, "")
      .split(".")
      .map((p) => parseInt(p, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Reflects the current _updateInfo into the DOM. The single choke point for
 *  every update signal: the sidebar About-icon pulse, the About-modal notice
 *  line, and the Home top-bar "Update Available" line (both with the latest tag
 *  linked to the release page). Safe to call anytime, with no update available
 *  it clears every signal. */
function refreshUpdateUI(): void {
  const info = _updateInfo;
  const available = info?.available ?? false;

  // Goes through shell.ts rather than toggling the class here, so this pulse is
  // phase-locked to the tool reminders', see setAttentionPulse().
  setAboutUpdatePulse(available);

  if (available && info) {
    updateNoticeLink.textContent = info.latest;
    updateNoticeLink.href = info.htmlUrl || "#";
    updateNotice.style.display = "";

    homeUpdateLink.textContent = info.latest;
    homeUpdateLink.href = info.htmlUrl || "#";
    homeUpdateNotice.style.display = "";
  } else {
    updateNotice.style.display = "none";
    homeUpdateNotice.style.display = "none";
  }
}

// Home top-bar update link → open the release page in the default browser.
// (The Home header isn't inside a modal, so it has no aboutBackdrop-style
// delegated link handler, wire it directly.)
homeUpdateLink.addEventListener("click", (e) => {
  e.preventDefault();
  if (_updateInfo?.htmlUrl) openUrl(_updateInfo.htmlUrl);
});

/** Runs the version check, then updates state + UI. Never throws: any failure
 *  (network down, rate-limited, 404 when no release exists, malformed body)
 *  leaves _updateInfo null and the UI untouched, so offline-by-default holds.
 *  An update counts as "available" only when the latest release is newer than
 *  BOTH the running version AND the ignored version, so a release newer than
 *  an ignored one re-surfaces, while the ignored one itself stays silent.
 *  Callers gate on settings.autoCheckUpdates; this function does not.
 *
 *  `announceGentle` forces any resulting announcement to a toast and lets it
 *  fire outside the startup window, for the Settings-toggle path, which is a
 *  check the user just asked for by hand. See announceUpdate(). */
export async function checkForUpdates(announceGentle = false): Promise<void> {
  try {
    const raw = await invoke<{
      current: string;
      latest: string;
      html_url: string;
    }>("check_for_updates");
    const newerThanCurrent = compareVersions(raw.latest, raw.current) > 0;
    const newerThanIgnored =
      compareVersions(raw.latest, settings.ignoredUpdateVersion) > 0;
    _updateInfo = {
      current: raw.current,
      latest: raw.latest,
      htmlUrl: raw.html_url,
      available: newerThanCurrent && newerThanIgnored,
    };
  } catch {
    // Silent by design. No toast, no noise.
    _updateInfo = null;
  }
  refreshUpdateUI();
  if (_updateInfo?.available) {
    _announceOwed = true;
    // Not awaited: nothing is queued behind a check that resolved on its own
    // schedule. runStartupNudges() awaits its own call instead.
    void announceUpdate(announceGentle);
  }
}

/* -----------------------------------------------------------------------------
   Update announcement. The Gentle/Aggressive split (mirrors Auto-Backup's
   reminder modes). The passive signals above fire in both modes and stay up
   for as long as the update exists; this is the one-shot nudge that rides
   along with them, at most once per app run.

   Two flags, because the two things that have to line up before it can fire
   arrive in either order: the check is a network round-trip that may land
   before or after the startup gates (license/changelog) are done, and firing a
   modal on top of a license agreement would be exactly the wrong moment.
----------------------------------------------------------------------------- */

let _updateNotifyResolve: (() => void) | null = null;

const updateNotifyModal = new Modal(updateNotifyBackdrop, {
  // Resolves the startup-nudge queue on every close path, see
  // runStartupNudges() and the matching comment in shell.ts.
  onClosed: () => {
    const resolve = _updateNotifyResolve;
    _updateNotifyResolve = null;
    resolve?.();
  },
});

/** True once the startup gate sequence has cleared and an interruption is fair
 *  game. */
let _startupNotifyReady = false;
/** True when a check has found an update that hasn't been announced yet. */
let _announceOwed = false;

/** Fires the owed announcement if the app is ready for it, then marks it spent.
 *  `forceGentle` downgrades Aggressive to a toast for the Settings-toggle path:
 *  a modal stacked on top of the open Settings modal is a jarring answer to
 *  flipping a switch, and it also bypasses the startup-ready gate since the
 *  user just asked for this check by hand.
 *
 *  @returns a promise that resolves once the announcement is done with the
 *  screen, when the modal is dismissed, or when the toast has been up long
 *  enough to read. That's what lets runStartupNudges() queue the nudges
 *  regardless of which mode each one is in. Resolves immediately when there was
 *  nothing to announce. */
function announceUpdate(forceGentle = false): Promise<void> {
  if (!_announceOwed || !_updateInfo?.available) return Promise.resolve();
  if (!forceGentle && !_startupNotifyReady) return Promise.resolve();
  _announceOwed = false;

  if (settings.updateNotifyAggressive && !forceGentle) {
    updateNotifyVersion.textContent = _updateInfo.latest;
    updateNotifyCurrent.textContent = `v${_updateInfo.current.replace(/^v/i, "")}`;
    updateNotifyModal.open();
    return new Promise<void>((resolve) => {
      _updateNotifyResolve = resolve;
    });
  }

  return gentleNudge(`New version available: ${_updateInfo.latest}`);
}

/** Called by runStartupNudges() once the gates are clear. Announces immediately
 *  if the check has already come back, otherwise leaves the owed announcement
 *  for checkForUpdates() to fire when it does, in which case this resolves
 *  right away and the announcement arrives on its own a moment later. */
function maybeAnnounceUpdate(): Promise<void> {
  _startupNotifyReady = true;
  return announceUpdate();
}

updateNotifyGoBtn.addEventListener("click", () => {
  updateNotifyModal.close();
  if (_updateInfo?.htmlUrl) openUrl(_updateInfo.htmlUrl);
});

updateNotifyLaterBtn.addEventListener("click", () => updateNotifyModal.close());

/* -----------------------------------------------------------------------------
   Ignore-version modal, opened from the About-modal Ignore button. Follows the
   same replace-then-return pattern as the other About sub-modals (changelog,
   licensing…): About closes, this opens; back-arrow and Cancel return to About;
   the X closes out entirely. Only the Confirm button actually writes the
   ignored version, matching the "ignore is committed on the confirm modal,
   not the About button" behaviour we settled on.
----------------------------------------------------------------------------- */

const ignoreVersionModal = new Modal(ignoreVersionBackdrop);

ignoreVersionBtn.addEventListener("click", () => {
  if (_updateInfo) ignoreVersionTag.textContent = _updateInfo.latest;
  aboutModal.close();
  ignoreVersionModal.open();
});

/** Return to the About modal without ignoring, shared by the back arrow and
 *  Cancel. */
function returnToAboutFromIgnore(): void {
  ignoreVersionModal.close();
  aboutModal.open();
}

ignoreVersionBack.addEventListener("click", returnToAboutFromIgnore);
ignoreVersionCancel.addEventListener("click", returnToAboutFromIgnore);
ignoreVersionClose.addEventListener("click", () => ignoreVersionModal.close());

ignoreVersionConfirm.addEventListener("click", async () => {
  if (_updateInfo) {
    // Persist the ignored tag, then locally clear "available" so the notice +
    // pulse drop immediately (a later release, being newer than this tag, will
    // re-surface on the next check).
    settings.ignoredUpdateVersion = _updateInfo.latest;
    await saveSettings();
    _updateInfo = { ..._updateInfo, available: false };
    refreshUpdateUI();
    flash("Version ignored", "success");
  }
  returnToAboutFromIgnore();
});

/* -----------------------------------------------------------------------------
   New Version Notification toggle (General Settings) + enable-confirm modal.
   Off by default. Turning it ON is gated by a confirm modal explaining the one
   network request; the toggle only commits if the user proceeds (same
   revert-on-cancel shape as the App Lock toggle). Enabling also runs a check
   immediately so a pending update surfaces without waiting for the next launch.
   Turning it OFF stops checks and clears any live signal at once.
----------------------------------------------------------------------------- */

const newVersionToggle = document.getElementById(
  "newVersionToggle",
) as HTMLInputElement;
const newVersionLabel = document.getElementById("newVersionLabel")!;
const newVersionSubsettings = document.getElementById("newVersionSubsettings")!;
const newVersionModeToggle = document.getElementById(
  "newVersionModeToggle",
) as HTMLInputElement;
const newVersionModeLabel = document.getElementById("newVersionModeLabel")!;
const updateEnableBackdrop = document.getElementById("updateEnableBackdrop")!;
const updateEnableBack = document.getElementById("updateEnableBack")!;
const updateEnableClose = document.getElementById("updateEnableClose")!;
const updateEnableCancel = document.getElementById("updateEnableCancel")!;
const updateEnableConfirm = document.getElementById("updateEnableConfirm")!;

const updateEnableModal = new Modal(updateEnableBackdrop, {
  closeOnEsc: false,
});

/** Syncs the toggle + its Enabled/Disabled label to the current setting.
 *  Called from applySettings() so load, reset, and reopen all stay in sync. */
export function applyUpdateSettings(): void {
  newVersionToggle.checked = settings.autoCheckUpdates;
  newVersionLabel.textContent = settings.autoCheckUpdates
    ? "Enabled"
    : "Disabled";
  newVersionModeToggle.checked = settings.updateNotifyAggressive;
  newVersionModeLabel.textContent = settings.updateNotifyAggressive
    ? "Aggressive"
    : "Gentle";
  // Tall enough for the mode row plus the two-line hint under it.
  newVersionSubsettings.style.maxHeight = settings.autoCheckUpdates
    ? "160px"
    : "0";
}

newVersionModeToggle.addEventListener("change", async () => {
  settings.updateNotifyAggressive = newVersionModeToggle.checked;
  await saveSettings();
  applyUpdateSettings();
});

/** Opens the enable-confirm modal and resolves true only if the user proceeds.
 *  Back arrow, Cancel, and the X all resolve false; Esc is disabled so it can't
 *  bypass this resolution and strand the caller. Mirrors openSetLockModal. */
function openUpdateEnableModal(): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (proceed: boolean): void => {
      if (settled) return;
      settled = true;
      updateEnableBack.onclick = null;
      updateEnableCancel.onclick = null;
      updateEnableClose.onclick = null;
      updateEnableConfirm.onclick = null;
      updateEnableModal.close();
      resolve(proceed);
    };
    updateEnableBack.onclick = () => done(false);
    updateEnableCancel.onclick = () => done(false);
    updateEnableClose.onclick = () => done(false);
    updateEnableConfirm.onclick = () => done(true);
    updateEnableModal.open();
  });
}

newVersionToggle.addEventListener("change", async () => {
  if (newVersionToggle.checked) {
    // Turning ON: revert visually until confirmed, then gate on the modal.
    // The setting stays off unless the user proceeds through it.
    newVersionToggle.checked = false;
    settingsModal.close();
    const proceed = await openUpdateEnableModal();
    if (!proceed) {
      settingsModal.open(); // left off
      return;
    }
    settings.autoCheckUpdates = true;
    await saveSettings();
    applyUpdateSettings();
    settingsModal.open();
    flash("Version notifications enabled", "success");
    // Run a check now so a pending update shows without a restart. Its
    // announcement is forced Gentle regardless of mode, see announceUpdate()
    // for why a modal is wrong on this path.
    void checkForUpdates(true);
  } else {
    // Turning OFF: stop checking and clear any live pulse/notice immediately.
    settings.autoCheckUpdates = false;
    await saveSettings();
    applyUpdateSettings();
    _updateInfo = null;
    _announceOwed = false;
    refreshUpdateUI();
    flash("Version notifications disabled", "success");
  }
});

/* =============================================================================
   CHANGELOG MODAL  (universal, owned by shell)
============================================================================= */

const changelogModal = new Modal(changelogBackdrop, {
  onOpen: () => loadChangelog(),
  onClosed: () => {
    // Reset collapse state: expand the first block, collapse the rest
    const body = document.getElementById("changelogBody");
    if (body) {
      body
        .querySelectorAll<HTMLElement>(".changelog-version-block")
        .forEach((block, i) => {
          const btn = block.querySelector<HTMLElement>(".changelog-toggle-btn");
          block.classList.toggle("collapsed", i > 0);
          btn?.classList.toggle("rotated", i > 0);
        });
    }
    // This changelog open was the automatic new-version one, now that the
    // user has dismissed it, start the 2s backup-reminder timer. A later
    // manual reopen (e.g. from About) won't have the flag set, so it's a
    // no-op then.
    if (_pendingReminderAfterChangelogClose) {
      _pendingReminderAfterChangelogClose = false;
      window.setTimeout(() => void runStartupNudges(), 2000);
    }
  },
});

/** Every once-per-launch nudge, in one place so their order is deliberate
 *  rather than an accident of where each was wired in. Fired ~2s after the app
 *  is actually ready to look at, see runStartupGates step 4.
 *
 *  Awaited one at a time rather than fired together, so they queue instead of
 *  piling up: each maybe* call resolves immediately when it has nothing to
 *  show, when the user dismisses its modal (Aggressive), or when its toast has
 *  been up long enough to read (Gentle). Three overlapping modal panels (or
 *  three toasts stacked in the corner at once) is what this avoids.
 *
 *  The new-version notice goes first (it's the app-level one and the quickest
 *  to deal with) then the tool reminders behind it.
 *
 *  One case doesn't queue: if the update check is still in flight when this
 *  runs, its announcement resolves immediately and the modal (if Aggressive)
 *  arrives whenever the network does, landing on top of whatever's open. Rare,
 *  since the check starts well before the startup gates finish, and it
 *  self-resolves as soon as the user dismisses it. */
async function runStartupNudges(): Promise<void> {
  await maybeAnnounceUpdate();
  await maybeShowBackupReminder();
  await maybeShowBudgetReminder();
}

function openChangelog(): void {
  changelogModal.open();
}

function closeChangelog(): void {
  changelogModal.close();
}

changelogBack.addEventListener("click", () => {
  closeChangelog();
  aboutModal.open();
});
changelogClose.addEventListener("click", closeChangelog);

async function loadChangelog(): Promise<void> {
  if (changelogLoaded) return;
  const body = document.getElementById("changelogBody")!;
  try {
    const res = await fetch("CHANGELOG.json");
    const versions = await res.json();
    body.innerHTML = "";

    type ToolMap = Record<string, string | string[]>;
    versions.forEach(
      (
        v: {
          version: string;
          date: string;
          changes: {
            features: ToolMap;
            improvements: ToolMap;
            bugfixes: ToolMap;
          };
        },
        index: number,
      ) => {
        const block = document.createElement("div");
        block.className = "changelog-version-block";

        const versionHeader = document.createElement("div");
        versionHeader.className = "changelog-version-header";

        const vNum = document.createElement("span");
        vNum.className = "changelog-version-number";
        vNum.textContent = `v${v.version}`;

        const vDate = document.createElement("span");
        vDate.className = "changelog-version-date";
        vDate.textContent = v.date;

        const toggleBtn = document.createElement("button");
        toggleBtn.className = "changelog-toggle-btn";
        toggleBtn.setAttribute("aria-label", "Toggle version details");
        toggleBtn.innerHTML = `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

        const contentWrapper = document.createElement("div");
        contentWrapper.className = "changelog-version-content";

        versionHeader.appendChild(vNum);
        versionHeader.appendChild(vDate);
        versionHeader.appendChild(toggleBtn);
        block.appendChild(versionHeader);

        versionHeader.addEventListener("click", () => {
          const isCollapsed = block.classList.contains("collapsed");

          if (isCollapsed) {
            // Expanding: measure actual content height and animate to it
            block.classList.remove("collapsed");
            toggleBtn.classList.remove("rotated");
            // scrollHeight is only valid after the class change removes max-height:0
            const fullHeight = contentWrapper.scrollHeight;
            contentWrapper.style.maxHeight = `${fullHeight}px`;
            // After the max-height transition completes, clear inline style so
            // content stays fluid. Filter to max-height, opacity also fires transitionend.
            const onDone = (ev: TransitionEvent) => {
              if (ev.propertyName !== "max-height") return;
              contentWrapper.style.maxHeight = "";
              contentWrapper.removeEventListener("transitionend", onDone);
            };
            contentWrapper.addEventListener("transitionend", onDone);
            setTimeout(() => {
              const changelogBody = document.getElementById("changelogBody");
              if (changelogBody) {
                changelogBody.scrollTo({
                  top: block.offsetTop - changelogBody.offsetTop,
                  behavior: "smooth",
                });
              }
            }, 350);
          } else {
            // Collapsing: pin current height first so the browser has a start
            // value to transition from, then animate to 0 on the next frame
            contentWrapper.style.maxHeight = `${contentWrapper.scrollHeight}px`;
            requestAnimationFrame(() => {
              block.classList.add("collapsed");
              toggleBtn.classList.add("rotated");
            });
          }
        });

        // Only the latest release (index 0) starts expanded
        if (index > 0) {
          block.classList.add("collapsed");
          toggleBtn.classList.add("rotated");
        }

        const categories: { key: keyof typeof v.changes; label: string }[] = [
          { key: "features", label: "Features" },
          { key: "improvements", label: "Improvements" },
          { key: "bugfixes", label: "Bug Fixes" },
        ];

        categories.forEach(({ key, label }) => {
          const toolMap = v.changes[key];
          if (!toolMap || Object.keys(toolMap).length === 0) return;

          const cat = document.createElement("div");
          cat.className = `changelog-category ${key}`;

          const catHeader = document.createElement("div");
          catHeader.className = `changelog-category-header ${key}`;
          catHeader.textContent = label;
          cat.appendChild(catHeader);

          Object.entries(toolMap).forEach(([toolName, entries]) => {
            const toolGroup = document.createElement("div");
            toolGroup.className = "changelog-tool-group";

            const toolLabel = document.createElement("div");
            toolLabel.className = "changelog-tool-label";
            toolLabel.textContent = toolName;
            toolGroup.appendChild(toolLabel);

            const lines = Array.isArray(entries) ? entries : [entries];
            lines.forEach((text: string) => {
              const item = document.createElement("div");
              item.className = "changelog-item";
              item.textContent = text;
              toolGroup.appendChild(item);
            });

            cat.appendChild(toolGroup);
          });

          contentWrapper.appendChild(cat);
        });

        block.appendChild(contentWrapper);
        body.appendChild(block);
      },
    );

    changelogLoaded = true;
  } catch (err) {
    devError("Changelog load failed:", err);
    body.innerHTML = `<p class="changelog-loading">Failed to load changelog.</p>`;
  }
}

/* =============================================================================
   LICENSING & ATTRIBUTIONS MODAL
============================================================================= */

const licensingModal = new Modal(licensingBackdrop);

function openLicensing(tab = "license"): void {
  activeTab = tab;
  document.querySelectorAll<HTMLElement>(".licensing-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  });
  licensingModal.open();
  loadLicensingTab(tab);
}

function closeLicensing(): void {
  licensingModal.close();
}

licensingBack.addEventListener("click", () => {
  closeLicensing();
  aboutModal.open();
});
licensingClose.addEventListener("click", closeLicensing);

// Internal doc link delegation, routes [LICENSE](LICENSE) etc. to their modals
document.getElementById("licensingBody")!.addEventListener("click", (e) => {
  const anchor = (e.target as HTMLElement).closest<HTMLAnchorElement>(
    "a.md-internal-link",
  );
  if (!anchor) return;
  e.preventDefault();
  const doc = anchor.dataset.doc!;
  if (doc === "LICENSE") {
    // Navigate to the full license: close Licensing, remember it as the return.
    const tab = activeTab;
    closeLicensing();
    fullLicenseReturn = () => openLicensing(tab);
    openFullLicense();
  } else {
    // LICENSING.md / ATTRIBUTION.md / THIRD_PARTY swap the tab in place; README.md
    // opens its own modal.
    INTERNAL_DOC_LINKS[doc]?.();
  }
});

document.getElementById("readmeBody")!.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;

  // Screenshots. README wraps each <img class="md-img"> in a real
  // <a href="./screenshots/…" target="_blank"> so GitHub's renderer can
  // still open the full-size file in a browser tab. That relative path only
  // resolves to a real, externally-reachable URL in dev (Vite's dev server);
  // in a packaged build the page origin is Tauri's internal asset protocol,
  // which the OS's default browser can't load. So in-app we intercept the
  // click before that default navigation fires and show it in our own
  // lightbox instead. Same behaviour in dev and prod, and the markdown
  // source is untouched so GitHub is unaffected.
  //
  // Match against the wrapping <a> too, not just the <img> itself: the
  // whitespace/indentation between "<a>" and "<img>" in the markdown source
  // becomes real text nodes inside the anchor, so a click that lands in that
  // sliver has e.target resolve to the <a> (or its text), not the <img>,
  // and img.md-img alone would miss it, letting the native target="_blank"
  // navigation slip through uncontested.
  const img =
    target.closest<HTMLImageElement>("img.md-img") ??
    target
      .closest<HTMLAnchorElement>("a")
      ?.querySelector<HTMLImageElement>("img.md-img") ??
    null;
  if (img) {
    e.preventDefault();
    openImageLightbox(img);
    return;
  }

  const anchor = target.closest<HTMLAnchorElement>("a.md-internal-link");
  if (!anchor) return;
  e.preventDefault();
  const doc = anchor.dataset.doc!;
  if (!INTERNAL_DOC_LINKS[doc]) return;
  // Navigation model: close README, open the target. For the full license,
  // remember README as the return so its back arrow comes back here.
  closeReadme();
  if (doc === "LICENSE") fullLicenseReturn = () => openReadme();
  INTERNAL_DOC_LINKS[doc]();
});

// Tab switching
document.querySelectorAll<HTMLElement>(".licensing-tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    const tab = btn.dataset.tab!;
    activeTab = tab;
    document.querySelectorAll<HTMLElement>(".licensing-tab").forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === tab);
    });
    loadLicensingTab(tab);
  });
});

async function loadLicensingTab(tab: string): Promise<void> {
  const body = document.getElementById("licensingBody")!;

  // Restore from cache if already loaded
  if (licensingTabCache[tab] !== undefined) {
    body.innerHTML = licensingTabCache[tab];
    body.scrollTop = 0;
    if (tab === "license") rewireLicenseBtn(body);
    return;
  }

  body.innerHTML = `<p class="changelog-loading">Loading...</p>`;

  const urls: Record<string, string> = {
    license: "/LICENSING.md",
    attribution: "/ATTRIBUTION.md",
    thirdparty: "/THIRD_PARTY_LICENSES.md",
  };

  try {
    const res = await fetch(urls[tab]);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const html = renderMarkdown(text);
    licensingTabCache[tab] = html;
    body.innerHTML = html;
    if (tab === "license") rewireLicenseBtn(body);
  } catch {
    body.innerHTML = `<p class="changelog-loading">Could not load file.</p>`;
  }

  body.scrollTop = 0;
}

/** Appends the "View Full License Text" button and wires it. */
function rewireLicenseBtn(body: HTMLElement): void {
  // Remove any stale button first
  body.querySelector(".full-license-btn")?.remove();
  const btn = document.createElement("button");
  btn.className = "modal-cancel-btn full-license-btn";
  btn.textContent = "View Full License Text (GNU AGPL v3)";
  btn.addEventListener("click", () => {
    const tab = activeTab;
    closeLicensing();
    fullLicenseReturn = () => openLicensing(tab);
    openFullLicense();
  });
  body.appendChild(btn);
}

/* =============================================================================
   FULL LICENSE SUB-MODAL
============================================================================= */

const fullLicenseModal = new Modal(fullLicenseBackdrop, {
  onOpen: () => loadFullLicense(),
});

function openFullLicense(): void {
  fullLicenseModal.open();
}

function closeFullLicense(): void {
  fullLicenseModal.close();
}

fullLicenseBack.addEventListener("click", () => {
  const ret = fullLicenseReturn;
  fullLicenseReturn = null;
  closeFullLicense();
  ret?.(); // reopen whichever modal led here (README or Licensing)
});
fullLicenseClose.addEventListener("click", () => {
  fullLicenseReturn = null; // X dismisses entirely. No return
  closeFullLicense();
});

async function loadFullLicense(): Promise<void> {
  if (fullLicenseLoaded) return;
  const body = document.getElementById("fullLicenseBody")!;
  try {
    const res = await fetch("/LICENSE");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const pre = document.createElement("pre");
    pre.className = "full-license-text";
    pre.textContent = text;
    body.innerHTML = "";
    body.appendChild(pre);
    fullLicenseLoaded = true;
  } catch {
    body.innerHTML = `<p class="changelog-loading">Could not load LICENSE file.</p>`;
  }
}

/* =============================================================================
   README MODAL
============================================================================= */

const readmeModal = new Modal(readmeBackdrop, {
  onOpen: () => loadReadme(),
});

function openReadme(): void {
  readmeModal.open();
}

function closeReadme(): void {
  readmeModal.close();
}

readmeBack.addEventListener("click", () => {
  closeReadme();
  aboutModal.open();
});
readmeClose.addEventListener("click", closeReadme);

async function loadReadme(): Promise<void> {
  if (readmeLoaded) return;
  const body = document.getElementById("readmeBody")!;
  try {
    const res = await fetch("/README.md");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    body.innerHTML = renderMarkdown(text);
    readmeLoaded = true;
  } catch {
    body.innerHTML = `<p class="changelog-loading">Could not load README.md.</p>`;
  }
}

/* =============================================================================
   SECURITY POLICY & CONTRIBUTING MODALS
   -----------------------------------------------------------------------------
   Plain single-document modals: fetch the markdown once, render it, and let
   internal doc links route onward. They're independent Modal instances rather
   than extra tabs on the Licensing modal because neither is a licensing
   document, and an independent modal can grow its own behaviour later without
   adding cases to a shared one.

   Both files are copied into public/ by copy-public-docs.mjs, same as
   README.md, a doc that isn't in that script's FILES_TO_COPY list will 404
   here at runtime.
============================================================================= */

/** Fetches a markdown doc from public/ and renders it into `body`.
 *  Returns true on success so the caller can latch its "already loaded" flag
 *  and skip re-fetching on subsequent opens (a failed load stays retryable). */
async function loadMarkdownDoc(
  body: HTMLElement,
  url: string,
  label: string,
): Promise<boolean> {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    body.innerHTML = renderMarkdown(text);
    return true;
  } catch {
    body.innerHTML = `<p class="changelog-loading">Could not load ${escapeHtml(label)}.</p>`;
    return false;
  }
}

/** Routes [LICENSE](LICENSE)-style links inside a simple doc modal: close this
 *  modal, open the target, and make the full-license back arrow return here. */
function wireDocLinks(
  bodyId: string,
  closeSelf: () => void,
  reopenSelf: () => void,
): void {
  document.getElementById(bodyId)!.addEventListener("click", (e) => {
    const anchor = (e.target as HTMLElement).closest<HTMLAnchorElement>(
      "a.md-internal-link",
    );
    if (!anchor) return;
    e.preventDefault();
    const doc = anchor.dataset.doc!;
    if (!INTERNAL_DOC_LINKS[doc]) return;
    closeSelf();
    if (doc === "LICENSE") fullLicenseReturn = reopenSelf;
    INTERNAL_DOC_LINKS[doc]();
  });
}

/* ── Security Policy ─────────────────────────────────────────────────────── */

const securityModal = new Modal(securityBackdrop, {
  onOpen: () => loadSecurity(),
});

function openSecurity(): void {
  securityModal.open();
}

function closeSecurity(): void {
  securityModal.close();
}

securityBack.addEventListener("click", () => {
  closeSecurity();
  aboutModal.open();
});
securityClose.addEventListener("click", closeSecurity);

async function loadSecurity(): Promise<void> {
  if (securityLoaded) return;
  const body = document.getElementById("securityBody")!;
  securityLoaded = await loadMarkdownDoc(body, "/SECURITY.md", "SECURITY.md");
}

wireDocLinks("securityBody", closeSecurity, openSecurity);

/* ── Contributing ────────────────────────────────────────────────────────── */

const contributingModal = new Modal(contributingBackdrop, {
  onOpen: () => loadContributing(),
});

function openContributing(): void {
  contributingModal.open();
}

function closeContributing(): void {
  contributingModal.close();
}

contributingBack.addEventListener("click", () => {
  closeContributing();
  aboutModal.open();
});
contributingClose.addEventListener("click", closeContributing);

async function loadContributing(): Promise<void> {
  if (contributingLoaded) return;
  const body = document.getElementById("contributingBody")!;
  contributingLoaded = await loadMarkdownDoc(
    body,
    "/CONTRIBUTING.md",
    "CONTRIBUTING.md",
  );
}

wireDocLinks("contributingBody", closeContributing, openContributing);

/* =============================================================================
   README IMAGE LIGHTBOX
   -----------------------------------------------------------------------------
   Full-size view of a clicked README screenshot. Replaces README (rather than
   stacking over it) so the shared overlay doesn't flicker between the two.
============================================================================= */

const imageLightboxModal = new Modal(imageLightboxBackdrop, {
  replaceModal: readmeModal,
  // Covers every close path (X, Escape, and the back-arrow's own close
  // call) in one place, rather than clearing it per-button.
  onClosed: () => {
    lightboxSourceImg = null;
  },
});

function openImageLightbox(img: HTMLImageElement): void {
  lightboxSourceImg = img;
  imageLightboxImg.src = img.src;
  imageLightboxTitle.textContent = img.alt || "Screenshot";
  // No title attribute set here. The mouseenter listener below decides
  // on each hover whether the text is actually truncated right now.
  imageLightboxTitle.removeAttribute("title");
  imageLightboxModal.open();
}

// Native tooltip only when the header text is actually ellipsis-truncated.
// Checked on hover (not at open time) since scrollWidth/clientWidth aren't
// meaningful until the modal has been laid out and is visible.
imageLightboxTitle.addEventListener("mouseenter", () => {
  const truncated =
    imageLightboxTitle.scrollWidth > imageLightboxTitle.clientWidth;
  if (truncated) {
    imageLightboxTitle.title = imageLightboxTitle.textContent ?? "";
  } else {
    imageLightboxTitle.removeAttribute("title");
  }
});

function closeImageLightbox(): void {
  imageLightboxModal.close();
}

imageLightboxClose.addEventListener("click", () => {
  // X dismisses entirely. No return to README, matching the Full License
  // modal's close-button convention.
  closeImageLightbox();
});

imageLightboxBack.addEventListener("click", () => {
  const source = lightboxSourceImg;
  closeImageLightbox();
  openReadme();
  // Modal.open() resets the README body's scrollTop to 0 inside its own
  // double-rAF open sequence (see modal.ts). Chaining our own double rAF
  // here queues this scroll strictly after that reset settles, instead of
  // racing it.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      source?.scrollIntoView({ block: "center" });
    });
  });
});

/* =============================================================================
   MARKDOWN RENDERER  (headings, bold/italic, links, inline code, code blocks,
                       tables, blockquotes, unordered lists, HRs)
============================================================================= */

/** Internal doc filenames that should open a modal instead of the browser. */
const INTERNAL_DOC_LINKS: Record<string, () => void> = {
  "LICENSING.md": () => openLicensing("license"),
  LICENSE: () => openFullLicense(),
  "ATTRIBUTION.md": () => openLicensing("attribution"),
  "THIRD_PARTY_LICENSES.md": () => openLicensing("thirdparty"),
  "README.md": () => openReadme(),
  "SECURITY.md": () => openSecurity(),
  "CONTRIBUTING.md": () => openContributing(),
};

function renderMarkdown(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let inTable = false;
  let tableHeaderDone = false;
  let inCodeBlock = false;
  let codeLines: string[] = [];

  // Void elements never carry a closing tag, so a line that opens one of
  // these is always "complete" on its own. No block-mode needed.
  const VOID_TAGS = new Set([
    "img",
    "br",
    "hr",
    "input",
    "meta",
    "link",
    "area",
    "base",
    "col",
    "embed",
    "source",
    "track",
    "wbr",
  ]);
  // Non-void tags worth treating as raw HTML blocks. An allowlist (rather
  // than "any word that looks like a tag") avoids misfiring on Markdown's
  // own <https://example.com> angle-bracket autolink syntax, where "https"
  // would otherwise parse as a plausible-looking tag name.
  const HTML_BLOCK_TAGS = new Set([
    "p",
    "div",
    "span",
    "a",
    "table",
    "thead",
    "tbody",
    "tr",
    "td",
    "th",
    "figure",
    "figcaption",
    "picture",
    "video",
    "details",
    "summary",
    "center",
    "blockquote",
    "ul",
    "ol",
    "li",
    "pre",
    "code",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "sub",
    "sup",
    "kbd",
    "samp",
  ]);
  let inHtmlBlock = false;
  let htmlBlockTag = "";
  let htmlBlockDepth = 0;
  let htmlLines: string[] = [];

  const inlineFormat = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      // Images, must run BEFORE the link rule below, since [alt](src) would
      // otherwise match the link pattern too and leave a stray "!" behind.
      .replace(
        /!\[([^\]]*)\]\(([^)]+)\)/g,
        (_match, alt: string, src: string) =>
          `<img src="${src}" alt="${alt}" class="md-img" loading="lazy">`,
      )
      .replace(
        /\[([^\]]+)\]\(([^)]+)\)/g,
        (_match, label: string, href: string) => {
          // Route internal doc links to their modal; everything else opens in browser
          if (INTERNAL_DOC_LINKS[href]) {
            return `<a href="#" class="md-internal-link" data-doc="${href}">${label}</a>`;
          }
          return `<a href="${href}" target="_blank">${label}</a>`;
        },
      );

  for (const raw of lines) {
    const line = raw.trimEnd();

    // Fenced code block
    if (line.startsWith("```")) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeLines = [];
      } else {
        const escaped = codeLines
          .join("\n")
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
        out.push(`<div class="md-code-block"><code>${escaped}</code></div>`);
        inCodeBlock = false;
        codeLines = [];
      }
      continue;
    }
    if (inCodeBlock) {
      codeLines.push(raw);
      continue;
    }

    // Already inside a raw HTML block, collect verbatim (no escaping, no
    // markdown processing) until this tag's depth returns to zero. Depth
    // tracking (rather than "first closing tag wins") lets the same tag
    // legitimately nest inside itself, e.g. <div><div>...</div></div>.
    if (inHtmlBlock) {
      htmlLines.push(raw);
      const openRe = new RegExp(`<${htmlBlockTag}(?:\\s[^>]*)?>`, "gi");
      const closeRe = new RegExp(`</${htmlBlockTag}>`, "gi");
      const opens = (line.match(openRe) || []).length;
      const closes = (line.match(closeRe) || []).length;
      htmlBlockDepth += opens - closes;
      if (htmlBlockDepth <= 0) {
        out.push(htmlLines.join("\n"));
        inHtmlBlock = false;
        htmlLines = [];
      }
      continue;
    }

    // Start of a raw HTML block. README.md is a trusted local file we
    // already innerHTML the rest of, so passthrough here isn't a new
    // trust boundary. Markdown syntax is NOT processed inside these blocks
    // (matches standard Markdown behaviour), use HTML tags throughout.
    const htmlOpenMatch = line.match(/^<([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/);
    if (htmlOpenMatch) {
      const tag = htmlOpenMatch[1].toLowerCase();
      if (!VOID_TAGS.has(tag) && !HTML_BLOCK_TAGS.has(tag)) {
        // Not a recognized tag (e.g. a <https://...> autolink), fall
        // through to normal inline/paragraph handling below.
      } else {
        const closesOnSameLine = new RegExp(`</${tag}>\\s*$`, "i").test(line);
        if (VOID_TAGS.has(tag) || closesOnSameLine) {
          // Complete on this single line, pass through raw as-is.
          out.push(line);
        } else {
          inHtmlBlock = true;
          htmlBlockTag = tag;
          htmlBlockDepth = 1;
          htmlLines = [raw];
        }
        continue;
      }
    }

    // Headings
    const hMatch = line.match(/^(#{1,4})\s+(.*)/);
    if (hMatch) {
      const level = hMatch[1].length;
      out.push(
        `<h${level} class="md-h${level}">${inlineFormat(hMatch[2])}</h${level}>`,
      );
      continue;
    }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) {
      out.push("<hr class='md-hr'>");
      continue;
    }

    // Table rows
    if (line.startsWith("|")) {
      if (!inTable) {
        inTable = true;
        tableHeaderDone = false;
        out.push("<table class='md-table'>");
      }
      if (/^\|[\s|:-]+\|$/.test(line)) {
        tableHeaderDone = true;
        continue;
      }
      const cells = line
        .split("|")
        .slice(1, -1)
        .map((c) => inlineFormat(c.trim()));
      const tag = tableHeaderDone ? "td" : "th";
      out.push(
        `<tr>${cells.map((c) => `<${tag}>${c}</${tag}>`).join("")}</tr>`,
      );
      continue;
    } else if (inTable) {
      out.push("</table>");
      inTable = false;
      tableHeaderDone = false;
    }

    // Blockquote
    if (line.startsWith("> ")) {
      out.push(
        `<blockquote class="md-blockquote">${inlineFormat(line.slice(2))}</blockquote>`,
      );
      continue;
    }

    // Unordered list item
    const ulMatch = line.match(/^[-*]\s+(.*)/);
    if (ulMatch) {
      out.push(`<li class="md-li">${inlineFormat(ulMatch[1])}</li>`);
      continue;
    }

    // Empty line, emit a sentinel we'll collapse later
    if (line.trim() === "") {
      out.push("<!--blank-->");
      continue;
    }

    // Paragraph
    out.push(`<p class="md-p">${inlineFormat(line)}</p>`);
  }

  if (inTable) out.push("</table>");
  // Safety net: an unclosed HTML block (malformed README) shouldn't silently
  // swallow the rest of the document, flush whatever was collected as-is.
  if (inHtmlBlock) out.push(htmlLines.join("\n"));

  // Collapse runs of blank sentinels into a single small spacer
  return out
    .join("\n")
    .replace(/(<!--blank-->\n?)+/g, '<div class="md-gap"></div>\n');
}

/* =============================================================================
   LICENSE AGREEMENT MODAL  (first-launch / new-version gate)
============================================================================= */

const licenseAgreementModal = new Modal(licenseAgreementBackdrop, {
  closeOnBackdrop: false,
  closeOnEsc: false,
});

async function openLicenseAgreement(): Promise<void> {
  // Lock buttons until user scrolls to bottom
  _setLicenseButtonsLocked(true);
  licenseAgreementModal.open();
  await loadLicenseAgreementText();
}

function closeLicenseAgreement(): void {
  licenseAgreementModal.close();
}

function _setLicenseButtonsLocked(locked: boolean): void {
  const footer = licenseAgreementBackdrop.querySelector<HTMLElement>(
    ".license-agreement-footer",
  );
  if (!footer) return;
  footer.classList.toggle("license-footer-locked", locked);
  licenseAcceptBtn.toggleAttribute("disabled", locked);
  licenseDeclineBtn.toggleAttribute("disabled", locked);
}

async function loadLicenseAgreementText(): Promise<void> {
  const body = document.getElementById("licenseAgreementBody")!;
  try {
    const res = await fetch("LICENSE");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const pre = document.createElement("pre");
    pre.className = "full-license-text";
    pre.textContent = text;
    body.innerHTML = "";
    body.appendChild(pre);
  } catch {
    body.innerHTML = `<p class="changelog-loading">Could not load LICENSE file.</p>`;
    // Can't scroll a short error message, unlock immediately
    _setLicenseButtonsLocked(false);
    return;
  }

  // Unlock buttons once user has scrolled to (or near) the bottom
  const onScroll = () => {
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 8;
    if (atBottom) {
      _setLicenseButtonsLocked(false);
      body.removeEventListener("scroll", onScroll);
    }
  };
  body.addEventListener("scroll", onScroll);
  // Also check immediately in case content is short enough to not need scrolling
  requestAnimationFrame(() => {
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 8;
    if (atBottom) {
      _setLicenseButtonsLocked(false);
      body.removeEventListener("scroll", onScroll);
    }
  });
}

// Resolve callback set by runStartupGates so the accept handler can signal it
let _licenseAcceptedResolve: (() => void) | null = null;

licenseAcceptBtn.addEventListener("click", async () => {
  localStorage.setItem(LICENSE_ACCEPTED_KEY, LICENSE_VERSION);
  closeLicenseAgreement();
  // Signal runStartupGates that acceptance is done and flag is written
  _licenseAcceptedResolve?.();
  _licenseAcceptedResolve = null;
});

licenseDeclineBtn.addEventListener("click", () => {
  quitApp();
});

/* =============================================================================
   STARTUP GATES: license agreement + auto-changelog
   Auto-changelog fires after license is resolved.
============================================================================= */

/** Runs first-launch and version-change gates in sequence after the window is visible.
 *  1. App lock, shown if enabled; user must enter correct PIN/password to proceed.
 *  2. License agreement, shown if never accepted or if LICENSE_VERSION changed.
 *     Decline quits the app; accept writes the accepted version to localStorage.
 *  3. Auto-changelog, opens automatically when the app version has changed
 *     since the last launch. Stores the seen version in localStorage.
 *  4. Startup nudges (new-version notice, backup reminder, budget reminder),
 *     fire ~2s after the app is actually ready to look at: immediately if no
 *     changelog is shown this run, or 2s after the user dismisses the
 *     auto-opened changelog if one is. See runStartupNudges(). */
export async function runStartupGates(appVersion: string): Promise<void> {
  // Gate 1: App lock, verify before anything else is visible
  if (settings.appLock) {
    const hasHash = await invoke<boolean>("lock_is_set").catch(() => false);
    if (hasHash) {
      await showLockScreen();
    }
  }

  const needsLicense =
    localStorage.getItem(LICENSE_ACCEPTED_KEY) !== LICENSE_VERSION;

  if (needsLicense) {
    // Wait for the user to explicitly accept (decline closes the window)
    await new Promise<void>((resolve) => {
      _licenseAcceptedResolve = resolve;
      openLicenseAgreement();
    });
    // Small delay so the license modal finishes its close transition first
    await new Promise<void>((resolve) => setTimeout(resolve, 400));
  }

  const seenVersion = localStorage.getItem(CHANGELOG_SEEN_KEY);
  if (seenVersion !== appVersion) {
    localStorage.setItem(CHANGELOG_SEEN_KEY, appVersion);
    _pendingReminderAfterChangelogClose = true;
    openChangelog();
  } else {
    window.setTimeout(() => void runStartupNudges(), 2000);
  }
}
