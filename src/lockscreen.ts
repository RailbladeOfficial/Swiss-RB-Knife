/* =============================================================================
   LOCK SCREEN  — app-lock PIN/password gate + set/change credential modal
   -----------------------------------------------------------------------------
   Owns the full-window lock screen overlay (not a Modal — no Escape, no drag,
   no close except successful unlock) shown at startup when App Lock is on,
   and the Set/Change Credential modal used to configure it from Settings.

   Split out of shell.ts (Tier 6). One-directional dependency on shell.ts core
   only (settings, flash, quitApp, saveSettings, settingsModal) — nothing here
   is needed by theme-core/theme-editor/random-theme, and this file doesn't
   need docs.ts despite runStartupGates() (in docs.ts) being the thing that
   calls showLockScreen() — that direction is docs.ts -> lockscreen.ts only.
============================================================================= */

import { invoke } from "@tauri-apps/api/core";
import { Modal } from "./modal";
import { settings, flash, quitApp, saveSettings, settingsModal } from "./shell";

/* ── Element refs ────────────────────────────────────────────────────────── */

const appLockToggle = document.getElementById(
  "appLockToggle",
) as HTMLInputElement;
const appLockLabel = document.getElementById("appLockLabel")!;
const lockSubsettings = document.getElementById("lockSubsettings")!;
const lockChangeBtn = document.getElementById("lockChangeBtn")!;
const lockRemoveBtn = document.getElementById("lockRemoveBtn")!;

// ── Set-credential modal refs ──────────────────────────────────────────────
const setLockBackdrop = document.getElementById("setLockBackdrop")!;
const setLockBack = document.getElementById("setLockBack")!;
const setLockClose = document.getElementById("setLockClose")!;
const setLockTitle = document.getElementById("setLockTitle")!;
const setLockHint = document.getElementById("setLockHint")!;
const setLockPickPin = document.getElementById("setLockPickPin")!;
const setLockPickPassword = document.getElementById("setLockPickPassword")!;
const setLockInput = document.getElementById(
  "setLockInput",
) as HTMLInputElement;
const setLockShowInput = document.getElementById("setLockShowInput")!;
const setLockConfirm = document.getElementById(
  "setLockConfirm",
) as HTMLInputElement;
const setLockShowConfirm = document.getElementById("setLockShowConfirm")!;
const setLockError = document.getElementById("setLockError")!;
const setLockCancelBtn = document.getElementById("setLockCancelBtn")!;
const setLockSaveBtn = document.getElementById("setLockSaveBtn")!;

// ── Lock screen refs ───────────────────────────────────────────────────────
export const lockScreen = document.getElementById("lockScreen")!;
export const lockPinView = document.getElementById("lockPinView")!;
export const lockPasswordView = document.getElementById("lockPasswordView")!;
const lockDots = document.getElementById("lockDots")!;
const lockNumpad = document.getElementById("lockNumpad")!;
const lockBackspace = document.getElementById("lockBackspace")!;
export const lockPinError = document.getElementById("lockPinError")!;
export const lockPasswordInput = document.getElementById(
  "lockPasswordInput",
) as HTMLInputElement;
const lockShowPassword = document.getElementById("lockShowPassword")!;
const lockSubmitBtn = document.getElementById("lockSubmitBtn")!;
export const lockPasswordError = document.getElementById("lockPasswordError")!;
const lockExitBtn = document.getElementById("lockExitBtn")!;
const lockExitBtnPw = document.getElementById("lockExitBtnPw")!;

/* -----------------------------------------------------------------------------
   PIN flow: numpad buttons build a string; auto-submits after 4 digits.
   Password flow: input + submit button; Enter key also submits.
   A resolve callback (_lockResolve) lets runStartupGates await correct entry.
----------------------------------------------------------------------------- */

let _lockResolve: (() => void) | null = null;
let _pinBuffer = "";

/** Clears the PIN entry buffer. Exported so shell.ts's init() can reset lock
 *  state on startup without reassigning this module's private binding directly
 *  (ES module imports of `let` bindings are read-only from the importer's side). */
export function resetPinBuffer(): void {
  _pinBuffer = "";
}
const PIN_LENGTH = 4;

/** Shows the lock screen and returns a Promise that resolves when unlocked.
 *  If the lock screen is already visible (pre-shown in init before window.show()),
 *  just attaches the resolve callback without re-initializing the view. */
export function showLockScreen(): Promise<void> {
  return new Promise<void>((resolve) => {
    _lockResolve = resolve;

    // If already visible (pre-shown in init), just wire the resolve and focus
    if (lockScreen.style.display === "flex") {
      requestAnimationFrame(() => {
        if (settings.lockCredentialType === "password") {
          lockPasswordInput.focus();
        }
      });
      return;
    }

    // Render the correct variant based on saved setting
    if (settings.lockCredentialType === "pin") {
      lockPinView.style.display = "";
      lockPasswordView.style.display = "none";
      buildPinDots(0);
      _pinBuffer = "";
      lockPinError.textContent = "";
    } else {
      lockPinView.style.display = "none";
      lockPasswordView.style.display = "";
      lockPasswordInput.value = "";
      lockPasswordError.textContent = "";
    }

    lockScreen.style.display = "flex";
    requestAnimationFrame(() => {
      if (settings.lockCredentialType === "password") {
        lockPasswordInput.focus();
      }
    });
  });
}

/** Fades and removes the lock screen, then resolves the startup gate.
 *  Uses setTimeout matching the CSS transition duration (0.3s) — same pattern
 *  as modal.ts close() — to avoid early teardown from child transitionend events. */
function dismissLockScreen(): void {
  lockScreen.classList.add("lock-fading");
  setTimeout(() => {
    lockScreen.style.display = "none";
    lockScreen.classList.remove("lock-fading");
    _lockResolve?.();
    _lockResolve = null;
  }, 300);
}

/** Rebuilds the PIN dot indicators for the given fill count. */
export function buildPinDots(filled: number, error = false): void {
  lockDots.innerHTML = "";
  for (let i = 0; i < PIN_LENGTH; i++) {
    const dot = document.createElement("div");
    dot.className =
      "lock-dot" + (i < filled ? (error ? " error" : " filled") : "");
    lockDots.appendChild(dot);
  }
}

/** Flashes the dots red on wrong PIN, then resets. Uses toast for the message. */
function pinErrorFlash(): void {
  buildPinDots(PIN_LENGTH, true);
  flash("Incorrect PIN", "error");
  setTimeout(() => {
    _pinBuffer = "";
    buildPinDots(0);
  }, 700);
}

/** Submits the current PIN buffer for verification. */
async function submitPin(): Promise<void> {
  if (_pinBuffer.length !== PIN_LENGTH) return;
  try {
    const ok = await invoke<boolean>("verify_lock", { credential: _pinBuffer });
    if (ok) {
      dismissLockScreen();
    } else {
      pinErrorFlash();
    }
  } catch {
    pinErrorFlash();
  }
}

/** Submits the password input for verification. */
async function submitPassword(): Promise<void> {
  const val = lockPasswordInput.value;
  if (!val) return;
  try {
    const ok = await invoke<boolean>("verify_lock", { credential: val });
    if (ok) {
      dismissLockScreen();
    } else {
      flash("Incorrect password", "error");
      lockPasswordInput.classList.add("lock-input-error");
      lockPasswordInput.value = "";
      setTimeout(() => {
        lockPasswordInput.classList.remove("lock-input-error");
      }, 1200);
    }
  } catch {
    flash("Verification error", "error");
  }
}

// PIN numpad interaction
lockNumpad.addEventListener("click", async (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(
    "[data-digit]",
  );
  if (!btn || _pinBuffer.length >= PIN_LENGTH) return;
  _pinBuffer += btn.dataset.digit!;
  buildPinDots(_pinBuffer.length);
  if (_pinBuffer.length === PIN_LENGTH) {
    // Small delay so user sees all dots fill before the async verify fires
    await new Promise<void>((r) => setTimeout(r, 80));
    await submitPin();
  }
});

lockBackspace.addEventListener("click", () => {
  if (_pinBuffer.length > 0) {
    _pinBuffer = _pinBuffer.slice(0, -1);
    buildPinDots(_pinBuffer.length);
  }
});

// Allow physical keyboard for PIN
document.addEventListener("keydown", (e) => {
  if (lockScreen.style.display === "none" || lockScreen.style.display === "")
    return;
  if (settings.lockCredentialType !== "pin") return;
  if (e.key >= "0" && e.key <= "9" && _pinBuffer.length < PIN_LENGTH) {
    _pinBuffer += e.key;
    buildPinDots(_pinBuffer.length);
    if (_pinBuffer.length === PIN_LENGTH) {
      submitPin();
    }
  }
  if (e.key === "Backspace" && _pinBuffer.length > 0) {
    _pinBuffer = _pinBuffer.slice(0, -1);
    buildPinDots(_pinBuffer.length);
  }
});

// Show/hide password toggle — our own button; browser's native reveal is suppressed via CSS
lockShowPassword.addEventListener("click", () => {
  const isHidden = lockPasswordInput.type === "password";
  lockPasswordInput.type = isHidden ? "text" : "password";
  const eyeIcon = document.getElementById("lockEyeIcon")!;
  eyeIcon.innerHTML = isHidden
    ? `<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
       <line x1="1" y1="1" x2="23" y2="23" />`
    : `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
       <circle cx="12" cy="12" r="3" />`;
});

lockSubmitBtn.addEventListener("click", submitPassword);
lockPasswordInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") submitPassword();
});

// Exit app from the lock screen
lockExitBtn.addEventListener("click", quitApp);
lockExitBtnPw.addEventListener("click", quitApp);

/* =============================================================================
   SECURITY SETTINGS  (App Lock)
============================================================================= */

/** Updates the Security subsettings UI to match current settings. */
export function applyLockSettings(): void {
  appLockToggle.checked = settings.appLock;
  appLockLabel.textContent = settings.appLock ? "On" : "Off";
  lockSubsettings.style.maxHeight = settings.appLock ? "200px" : "0";
}

// Enable/disable app lock toggle
appLockToggle.addEventListener("change", async () => {
  if (appLockToggle.checked) {
    // Turning ON: open set-credential flow first; only enable if saved
    appLockToggle.checked = false; // revert visually until credential is saved
    settingsModal.close();
    const saved = await openSetLockModal("enable");
    if (!saved) {
      // User cancelled — leave lock off
      settingsModal.open();
      return;
    }
    settings.appLock = true;
    await saveSettings();
    applyLockSettings();
    settingsModal.open();
    flash("App lock enabled", "success");
  } else {
    // Turning OFF
    settings.appLock = false;
    try {
      await invoke("clear_lock_hash");
    } catch {
      /* non-critical */
    }
    await saveSettings();
    applyLockSettings();
    flash("App lock disabled", "success");
  }
});

lockChangeBtn.addEventListener("click", async () => {
  settingsModal.close();
  await openSetLockModal("change");
  settingsModal.open();
});

lockRemoveBtn.addEventListener("click", async () => {
  settings.appLock = false;
  try {
    await invoke("clear_lock_hash");
  } catch {
    /* non-critical */
  }
  await saveSettings();
  applyLockSettings();
  flash("App lock removed", "success");
});

/* =============================================================================
   SET / CHANGE CREDENTIAL MODAL
============================================================================= */

const setLockModal = new Modal(setLockBackdrop, {
  closeOnEsc: false, // don't allow escape during the set-lock flow
});

/** Resets a set-lock eye icon SVG back to the visible-eye (password hidden) state. */
function _resetSetLockEye(iconId: string): void {
  const el = document.getElementById(iconId);
  if (!el) return;
  el.innerHTML = `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />`;
}

/** Wires a show/hide toggle button to its paired password input. */
function _wireSetLockShowBtn(
  btn: HTMLElement,
  input: HTMLInputElement,
  iconId: string,
): void {
  btn.addEventListener("click", () => {
    const hidden = input.type === "password";
    input.type = hidden ? "text" : "password";
    const icon = document.getElementById(iconId)!;
    icon.innerHTML = hidden
      ? `<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
         <line x1="1" y1="1" x2="23" y2="23" />`
      : `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
         <circle cx="12" cy="12" r="3" />`;
  });
}

// Wire the set-lock modal show/hide buttons once at startup (they persist across openings)
_wireSetLockShowBtn(setLockShowInput, setLockInput, "setLockInputEye");
_wireSetLockShowBtn(setLockShowConfirm, setLockConfirm, "setLockConfirmEye");

/** Configures the set-lock modal inputs for the currently selected type.
 *  Called whenever the user switches type inside the modal picker. */
function _applySetLockType(
  isPin: boolean,
  prevKeydownHandler?: (e: KeyboardEvent) => void,
): (e: KeyboardEvent) => void {
  // Remove old handler if re-configuring
  if (prevKeydownHandler) {
    setLockInput.removeEventListener("keydown", prevKeydownHandler);
    setLockConfirm.removeEventListener("keydown", prevKeydownHandler);
  }

  setLockPickPin.classList.toggle("active", isPin);
  setLockPickPassword.classList.toggle("active", !isPin);

  setLockHint.textContent = isPin
    ? `Enter a ${PIN_LENGTH}-digit PIN`
    : "Enter a password (case sensitive)";
  setLockInput.placeholder = isPin ? "PIN" : "New password";
  setLockInput.type = "password";
  setLockInput.value = "";
  setLockInput.maxLength = isPin ? PIN_LENGTH : 128;
  setLockInput.inputMode = isPin ? "numeric" : "text";
  setLockInput.pattern = isPin ? "[0-9]*" : "";

  setLockConfirm.placeholder = isPin ? "Confirm PIN" : "Confirm password";
  setLockConfirm.type = "password";
  setLockConfirm.value = "";
  setLockConfirm.maxLength = isPin ? PIN_LENGTH : 128;
  setLockConfirm.inputMode = isPin ? "numeric" : "text";
  setLockConfirm.pattern = isPin ? "[0-9]*" : "";

  // Always show reveal buttons — useful for both PIN and password to verify entry
  setLockShowInput.style.display = "";
  setLockShowConfirm.style.display = "";
  _resetSetLockEye("setLockInputEye");
  _resetSetLockEye("setLockConfirmEye");

  setLockError.textContent = "";
  setLockInput.classList.remove("input-error");
  setLockConfirm.classList.remove("input-error");

  // Digit-only filter for PIN
  const onKeydown = (e: KeyboardEvent) => {
    if (!isPin) return;
    const allowed = [
      "Backspace",
      "Delete",
      "Tab",
      "ArrowLeft",
      "ArrowRight",
      "Enter",
    ];
    if (!allowed.includes(e.key) && !/^\d$/.test(e.key)) e.preventDefault();
  };
  setLockInput.addEventListener("keydown", onKeydown);
  setLockConfirm.addEventListener("keydown", onKeydown);

  return onKeydown;
}

/** Opens the set-credential modal.
 *  Includes a PIN/Password picker so the user can choose before entering.
 *  On cancel, both the credential type and the stored hash revert to unchanged.
 *  Returns a promise that resolves to true if the user saved, false if cancelled. */
function openSetLockModal(mode: "enable" | "change"): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    // Snapshot state so cancel can restore it
    const prevCredType = settings.lockCredentialType;

    // Working type for the modal — user can switch before saving
    let modalType: "pin" | "password" = settings.lockCredentialType;

    setLockTitle.textContent =
      mode === "enable" ? "Set App Lock" : "Change Credential";

    let currentKeydownHandler = _applySetLockType(modalType === "pin");

    // Type picker buttons inside the modal
    const onPickPin = () => {
      if (modalType === "pin") return;
      modalType = "pin";
      currentKeydownHandler = _applySetLockType(true, currentKeydownHandler);
      setLockInput.focus();
    };
    const onPickPassword = () => {
      if (modalType === "password") return;
      modalType = "password";
      currentKeydownHandler = _applySetLockType(false, currentKeydownHandler);
      setLockInput.focus();
    };
    setLockPickPin.addEventListener("click", onPickPin);
    setLockPickPassword.addEventListener("click", onPickPassword);

    let _resolved = false;
    function done(saved: boolean): void {
      if (_resolved) return;
      _resolved = true;
      setLockInput.removeEventListener("keydown", currentKeydownHandler);
      setLockConfirm.removeEventListener("keydown", currentKeydownHandler);
      setLockPickPin.removeEventListener("click", onPickPin);
      setLockPickPassword.removeEventListener("click", onPickPassword);
      setLockModal.close();

      if (saved) {
        // Commit the type the user chose inside the modal
        settings.lockCredentialType = modalType;
        // Sync the settings panel type buttons
        applyLockSettings();
        saveSettings();
      } else {
        // Restore the type that was set before the modal opened
        settings.lockCredentialType = prevCredType;
        applyLockSettings();
      }

      resolve(saved);
    }

    const onSave = async () => {
      const isPin = modalType === "pin";
      const val = setLockInput.value;
      const confirm = setLockConfirm.value;

      if (isPin && val.length !== PIN_LENGTH) {
        flash(`PIN must be exactly ${PIN_LENGTH} digits`, "error");
        return;
      }
      if (!isPin && val.length < 1) {
        flash("Password cannot be empty", "error");
        return;
      }
      if (val !== confirm) {
        flash(`${isPin ? "PINs" : "Passwords"} don't match`, "error");
        return;
      }

      try {
        await invoke("save_lock_hash", { credential: val });
        const label = isPin ? "PIN" : "Password";
        done(true);
        flash(`${label} ${mode === "enable" ? "set" : "updated"}`, "success");
      } catch {
        flash("Failed to save credential", "error");
      }
    };

    setLockSaveBtn.onclick = onSave;
    setLockCancelBtn.onclick = () => done(false);
    setLockBack.onclick = () => done(false);
    setLockClose.onclick = () => done(false);

    // Enter in confirm field saves
    const onConfirmEnter = (e: KeyboardEvent) => {
      if (e.key === "Enter") onSave();
    };
    setLockConfirm.addEventListener("keydown", onConfirmEnter);

    setLockModal.open();
    requestAnimationFrame(() => setLockInput.focus());
  });
}
