/* =============================================================================
   DEV LOG: error-path logging that stays out of production builds
   -----------------------------------------------------------------------------
   In a `vite build`, import.meta.env.DEV resolves to a compile-time `false`, so
   these calls never run in the shipped app and the console stays clean for end
   users, while `npm run dev` keeps full diagnostics.

   This lives in its own file, and that file imports NOTHING, for one reason:
   theme-core.ts deliberately does not import shell.ts. These helpers used to
   live in shell, so the modules outside its import graph could not reach them
   and quietly used a bare console.warn instead, which then logged in
   production alongside every sibling call that was correctly silent. A leaf
   module is reachable from everywhere without putting anything into a cycle.

   shell.ts re-exports both, so the several dozen files already importing them
   from there keep working and there is still one obvious place to import from.
============================================================================= */

const IS_DEV: boolean =
  (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV === true;

/** console.error, but silent in production builds. */
export function devError(...args: unknown[]): void {
  if (IS_DEV) console.error(...args);
}

/** console.warn, but silent in production builds. */
export function devWarn(...args: unknown[]): void {
  if (IS_DEV) console.warn(...args);
}

/** True only under `npm run dev`. Exported for the handful of places that
 *  guard a whole block rather than one log line. */
export const isDev = IS_DEV;
