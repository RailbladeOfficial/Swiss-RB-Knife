/* =============================================================================
   FORMAT: numbers as the strings shown on screen
   -----------------------------------------------------------------------------
   Byte sizes, for now. Four copies of this had grown, in two shapes, and the
   two shapes are a real difference rather than drift: a snapshot or an image is
   measured in kilobytes and megabytes, and a backup destination is measured in
   gigabytes and sometimes terabytes. A single function would either stop
   counting at MB and print "512000.00 MB" for a half-terabyte folder, or scale
   to TB and print "0.00 MB" where a file list wants "3.4 KB".

   So there are two, named for what they measure rather than for how they round,
   and picking the wrong one is visible immediately.

   Imports nothing on purpose, so any module can pull it in without thinking
   about load order. See core/timestamp.ts, which is a leaf for the same reason.
============================================================================= */

/**
 * A file's size: `900 B`, `3.4 KB`, `12.75 MB`.
 *
 * Stops at MB, because everything measured with this is one file: a snapshot,
 * an attachment, an exported image. A file big enough to need GB here is a
 * problem this string is not going to fix.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * A whole folder's size: `0 B`, `1.50 KB`, `847.25 GB`.
 *
 * Scales the whole way up, for Auto-Backup, where the number being described is
 * a drive's worth of files. Two decimal places at every step, so a column of
 * these lines up, and an explicit `0 B` because an empty source is a normal
 * answer there rather than an error.
 */
export function formatDataSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size.toFixed(2)} ${units[unit]}`;
}
