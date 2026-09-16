/* =============================================================================
   TIMESTAMPS, FOR THE BUILD SCRIPTS
   -----------------------------------------------------------------------------
   The Node half of the one timestamp standard (dev/app-standards.md section 6).
   Rust has crate::file_timestamp(), the front end has core/timestamp.ts, and
   anything under scripts/ that writes a date comes here.

   LOCAL, always. A date in generated output is read by a person, so the only
   clock that means anything is the one on their wall. toISOString() is UTC:
   THIRD_PARTY_LICENSES.md was stamped with it, so from 20:00 Eastern onward
   every generated copy claimed to have been made tomorrow.

   UTC is still right for an instant stored in a data file, which nothing in
   this folder writes.
============================================================================= */

const pad = (n) => String(n).padStart(2, "0");

/** `YYYY-MM-DD` on the local clock. */
export function localDay(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The house format, `YYYY-MM-DD_HH-MM-SS`, on the local clock. Here so the
 *  next script that needs a generated NAME does not hand-build one. */
export function fileTimestamp(date = new Date()) {
  return (
    `${localDay(date)}_` +
    `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  );
}
