/* =============================================================================
   SOUND MANIFEST  (GENERATED FILE, DO NOT EDIT BY HAND)
   -----------------------------------------------------------------------------
   Written by scripts/generate-sound-manifest.mjs, which runs from the predev
   and prebuild hooks. It lists whatever audio files are in
   public/sounds/button-sounds/, public/sounds/modal-sounds/ and
   public/sounds/timer-sounds/, so adding a cue is a matter of dropping a file
   in one of those folders and re-running dev or build. Editing this file
   directly will be undone on the next run.

   Imports nothing on purpose. Like theme-ids.ts this is pure data that the
   circular shell/sound import graph can reach from anywhere without adding an
   edge to it.
============================================================================= */

export interface SoundEffect {
  /** File name without its extension, and what gets persisted in settings. */
  id: string;
  /** Display name shown on the tile in this cue's picker, with the category
   *  prefix its file name carries stripped off. */
  name: string;
  /** URL-encoded path under public/, ready to hand to new Audio(). */
  url: string;
}

/** Everything currently in public/sounds/button-sounds/. Empty is a valid
 *  state: the picker then offers "None" only. */
export const BUTTON_SOUNDS: SoundEffect[] = [
  { id: "button-blip", name: "Blip", url: "/sounds/button-sounds/button-blip.wav" },
  { id: "button-boop", name: "Boop", url: "/sounds/button-sounds/button-boop.wav" },
  { id: "button-click-1", name: "Click 1", url: "/sounds/button-sounds/button-click-1.wav" },
  { id: "button-click-2", name: "Click 2", url: "/sounds/button-sounds/button-click-2.wav" },
  { id: "button-click-3", name: "Click 3", url: "/sounds/button-sounds/button-click-3.wav" },
  { id: "button-ding", name: "Ding", url: "/sounds/button-sounds/button-ding.wav" },
  { id: "button-dong", name: "Dong", url: "/sounds/button-sounds/button-dong.wav" },
  { id: "button-knock", name: "Knock", url: "/sounds/button-sounds/button-knock.wav" },
  { id: "button-pop", name: "Pop", url: "/sounds/button-sounds/button-pop.wav" },
  { id: "button-tap-1", name: "Tap 1", url: "/sounds/button-sounds/button-tap-1.wav" },
  { id: "button-tap-2", name: "Tap 2", url: "/sounds/button-sounds/button-tap-2.wav" },
];

/** Everything currently in public/sounds/modal-sounds/. Empty is a valid
 *  state: the picker then offers "None" only. */
export const MODAL_SOUNDS: SoundEffect[] = [
  { id: "modal-bloop", name: "Bloop", url: "/sounds/modal-sounds/modal-bloop.wav" },
  { id: "modal-doot", name: "Doot", url: "/sounds/modal-sounds/modal-doot.wav" },
  { id: "modal-woah", name: "Woah", url: "/sounds/modal-sounds/modal-woah.wav" },
];

/** Everything currently in public/sounds/timer-sounds/. Empty is a valid
 *  state: the picker then offers "None" only. */
export const TIMER_SOUNDS: SoundEffect[] = [
  { id: "timer-chime-long", name: "Chime Long", url: "/sounds/timer-sounds/timer-chime-long.wav" },
  { id: "timer-chime-short", name: "Chime Short", url: "/sounds/timer-sounds/timer-chime-short.wav" },
];

/** Looks a cue up in any of the lists above. Returns null for the empty id
 *  (the "None" option) and for an id whose file has since been removed from
 *  its folder, so a stale setting degrades to silence instead of a failed
 *  fetch. */
export function findSoundEffect(list: SoundEffect[], id: string): SoundEffect | null {
  if (!id) return null;
  return list.find((s) => s.id === id) ?? null;
}
