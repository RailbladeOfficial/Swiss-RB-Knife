/* =============================================================================
   GAME STATS: SPREADSHEET (.xlsx) READ / WRITE
   -----------------------------------------------------------------------------
   A deliberately small, dependency-free .xlsx layer: just enough to read a
   workbook the user maintains by hand, and to write the template that teaches
   them its shape.

   Why hand-rolled rather than a library: the app ships no runtime JS
   dependencies, and the slice of the format actually needed here is tiny,
   read cell text from named sheets, write cell text to named sheets. No
   styles to interpret, no formulas to evaluate (Excel caches every formula's
   last result in the file, which is exactly what a reader wants), no dates.

   The two halves are asymmetric on purpose:
     • Reading must cope with whatever Excel produced, so entries are
       DEFLATE-decompressed via the WebView's built-in DecompressionStream.
     • Writing only has to produce something Excel will open, so every entry is
       STORED uncompressed, which means no compressor is needed at all, and a
       few KB of template is not worth one.

   Nothing here knows what a game is; see game-stats-five-crowns.ts for the
   sheet-shape rules and game-stats.ts for the import flow around them.
============================================================================= */

/** A sheet reduced to text. `rows[r][c]` is 0-indexed and dense, short rows
 *  and skipped cells are padded with "" so callers can index by column
 *  without bounds-checking every access. */
export type SheetData = { name: string; rows: string[][] };

/** Signals a file that isn't readable as a workbook at all (as opposed to one
 *  that reads fine but holds the wrong data, that's the caller's business).
 *  Carries a message written for the user, not the console. */
export class WorkbookError extends Error {}

/* =============================================================================
   ZIP: READING
   An .xlsx is a ZIP archive of XML parts. Only the central directory is walked
   up front; entry bodies are decompressed on demand, so a workbook carrying
   900 chart parts (as the author's own does) costs nothing to skip past.
============================================================================= */

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

type ZipEntry = { name: string; method: number; compressedSize: number; localOffset: number };

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** The End of Central Directory record sits at the very end of the file, but
 *  a trailing comment can push it back by up to 64 KB, hence the scan rather
 *  than a fixed offset. */
function findEocd(bytes: Uint8Array): number {
  const view = viewOf(bytes);
  const earliest = Math.max(0, bytes.length - (0xffff + 22));
  for (let i = bytes.length - 22; i >= earliest; i--) {
    if (view.getUint32(i, true) === SIG_EOCD) return i;
  }
  return -1;
}

function readCentralDirectory(bytes: Uint8Array): Map<string, ZipEntry> {
  const eocd = findEocd(bytes);
  if (eocd < 0) {
    throw new WorkbookError("That file isn't a spreadsheet. No ZIP directory was found in it.");
  }
  const view = viewOf(bytes);
  const count = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  // The all-ones sentinels mean the real values live in a ZIP64 record. Excel
  // only emits those past 65,535 parts or 4 GB, neither of which a game log
  // will reach, so this reports the limit rather than implementing it.
  if (count === 0xffff || cdOffset === 0xffffffff) {
    throw new WorkbookError("That workbook uses the ZIP64 format, which this importer can't read.");
  }

  const entries = new Map<string, ZipEntry>();
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== SIG_CENTRAL) {
      throw new WorkbookError("That workbook's internal directory is damaged and can't be read.");
    }
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries.set(name, { name, method, compressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Returns an entry's decompressed text, or null if the archive has no such
 *  part, absence is normal (sharedStrings.xml only exists if the workbook
 *  uses shared strings), so it isn't treated as an error here. */
async function readEntryText(
  bytes: Uint8Array,
  entries: Map<string, ZipEntry>,
  name: string,
): Promise<string | null> {
  const entry = entries.get(name);
  if (!entry) return null;

  const view = viewOf(bytes);
  const local = entry.localOffset;
  if (view.getUint32(local, true) !== SIG_LOCAL) {
    throw new WorkbookError(`That workbook's "${name}" section is damaged and can't be read.`);
  }
  // The local header repeats the name and extra fields, and its extra field
  // length routinely DIFFERS from the central directory's, so the body offset
  // has to be computed from the local header, never from the central one.
  const nameLen = view.getUint16(local + 26, true);
  const extraLen = view.getUint16(local + 28, true);
  const start = local + 30 + nameLen + extraLen;
  const body = bytes.subarray(start, start + entry.compressedSize);

  if (entry.method === 0) return new TextDecoder().decode(body);
  if (entry.method === 8) return new TextDecoder().decode(await inflateRaw(body));
  throw new WorkbookError(`That workbook uses an unsupported compression method (${entry.method}).`);
}

/* =============================================================================
   SHEET XML: READING
============================================================================= */

/** "A" -> 0, "Z" -> 25, "AA" -> 26. Cell references carry their column letters,
 *  which is the only reliable way to place a cell: Excel omits empty cells
 *  entirely, so position within the row tells you nothing. */
function columnIndex(cellRef: string): number {
  let index = 0;
  for (const ch of cellRef) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) break; // hit the row digits
    index = index * 26 + (code - 64);
  }
  return index - 1;
}

function rowIndex(cellRef: string): number {
  const digits = cellRef.replace(/^[A-Z]+/, "");
  return Number(digits) - 1;
}

function parseSharedStrings(xml: string | null): string[] {
  if (!xml) return [];
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  // Concatenating every <t> handles rich text, where one string is split into
  // several runs, taking only the first would silently truncate it.
  return Array.from(doc.getElementsByTagName("si")).map((si) =>
    Array.from(si.getElementsByTagName("t"))
      .map((t) => t.textContent ?? "")
      .join(""),
  );
}

function parseSheet(xml: string, sharedStrings: string[]): string[][] {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const rows: string[][] = [];

  for (const row of Array.from(doc.getElementsByTagName("row"))) {
    const cells: string[] = [];
    for (const cell of Array.from(row.getElementsByTagName("c"))) {
      const ref = cell.getAttribute("r") ?? "";
      const col = ref ? columnIndex(ref) : cells.length;
      const type = cell.getAttribute("t") ?? "n";

      let text = "";
      if (type === "inlineStr") {
        text = Array.from(cell.getElementsByTagName("t"))
          .map((t) => t.textContent ?? "")
          .join("");
      } else {
        // <v> holds the literal value for numbers and, for a formula cell, the
        // result Excel cached the last time it recalculated, which is exactly
        // what's wanted, since nothing here evaluates formulas.
        const v = cell.getElementsByTagName("v")[0];
        const raw = v?.textContent ?? "";
        text = type === "s" && raw !== "" ? sharedStrings[Number(raw)] ?? "" : raw;
      }

      while (cells.length < col) cells.push("");
      cells[col] = text.trim();
    }

    const r = rowIndex(row.getAttribute("r") ?? "");
    const target = Number.isFinite(r) && r >= 0 ? r : rows.length;
    while (rows.length < target) rows.push([]);
    rows[target] = cells;
  }

  return rows;
}

/**
 * Reads every worksheet in a workbook as text.
 *
 * Sheet order and names come from workbook.xml; the file each sheet actually
 * lives in comes from the workbook's relationship part, because sheet1.xml is
 * NOT reliably the first sheet. Excel reuses part numbers freely as sheets are
 * added, deleted and reordered.
 */
export async function readWorkbook(bytes: Uint8Array): Promise<SheetData[]> {
  const entries = readCentralDirectory(bytes);

  const workbookXml = await readEntryText(bytes, entries, "xl/workbook.xml");
  if (!workbookXml) {
    throw new WorkbookError("That file isn't an Excel workbook (.xlsx). No workbook part was found.");
  }
  const relsXml = await readEntryText(bytes, entries, "xl/_rels/workbook.xml.rels");
  if (!relsXml) {
    throw new WorkbookError("That workbook is missing its relationship data and can't be read.");
  }

  const relDoc = new DOMParser().parseFromString(relsXml, "application/xml");
  const targets = new Map<string, string>();
  for (const rel of Array.from(relDoc.getElementsByTagName("Relationship"))) {
    const id = rel.getAttribute("Id");
    const target = rel.getAttribute("Target");
    if (!id || !target) continue;
    // Targets are relative to xl/ and may be written with a leading slash or
    // a "../" hop depending on which tool wrote the file.
    targets.set(id, `xl/${target.replace(/^\/?(xl\/)?/, "").replace(/^\.\.\//, "")}`);
  }

  const sharedStrings = parseSharedStrings(await readEntryText(bytes, entries, "xl/sharedStrings.xml"));

  const wbDoc = new DOMParser().parseFromString(workbookXml, "application/xml");
  const sheets: SheetData[] = [];
  for (const sheet of Array.from(wbDoc.getElementsByTagName("sheet"))) {
    const name = sheet.getAttribute("name") ?? "";
    const rid = sheet.getAttribute("r:id") ?? sheet.getAttributeNS(
      "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
      "id",
    );
    const part = rid ? targets.get(rid) : undefined;
    if (!part) continue;
    const xml = await readEntryText(bytes, entries, part);
    if (xml == null) continue;
    sheets.push({ name, rows: parseSheet(xml, sharedStrings) });
  }

  if (sheets.length === 0) throw new WorkbookError("That workbook has no readable sheets.");
  return sheets;
}

/* =============================================================================
   ZIP: WRITING (stored, no compression)
============================================================================= */

let crcTable: Uint32Array | null = null;

function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

type PendingFile = { name: string; data: Uint8Array; crc: number };

/** Builds a ZIP with every entry stored uncompressed. Excel accepts this
 *  happily, and it keeps the writer to arithmetic. No DEFLATE encoder. */
function buildZip(files: { name: string; content: string }[]): Uint8Array {
  const encoder = new TextEncoder();
  const prepared: PendingFile[] = files.map((f) => {
    const data = encoder.encode(f.content);
    return { name: f.name, data, crc: crc32(data) };
  });

  const nameBytes = prepared.map((f) => encoder.encode(f.name));
  const localSize = prepared.reduce((sum, f, i) => sum + 30 + nameBytes[i].length + f.data.length, 0);
  const centralSize = prepared.reduce((sum, _f, i) => sum + 46 + nameBytes[i].length, 0);

  const out = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(out.buffer);
  const offsets: number[] = [];
  let p = 0;

  prepared.forEach((file, i) => {
    offsets.push(p);
    view.setUint32(p, SIG_LOCAL, true);
    view.setUint16(p + 4, 20, true); // version needed
    view.setUint16(p + 6, 0, true); // flags
    view.setUint16(p + 8, 0, true); // method: stored
    view.setUint16(p + 10, 0, true); // mod time
    view.setUint16(p + 12, 0x21, true); // mod date, 1980-01-01, a fixed epoch
    view.setUint32(p + 14, file.crc, true);
    view.setUint32(p + 18, file.data.length, true);
    view.setUint32(p + 22, file.data.length, true);
    view.setUint16(p + 26, nameBytes[i].length, true);
    view.setUint16(p + 28, 0, true); // extra length
    p += 30;
    out.set(nameBytes[i], p);
    p += nameBytes[i].length;
    out.set(file.data, p);
    p += file.data.length;
  });

  const centralStart = p;
  prepared.forEach((file, i) => {
    view.setUint32(p, SIG_CENTRAL, true);
    view.setUint16(p + 4, 20, true); // version made by
    view.setUint16(p + 6, 20, true); // version needed
    view.setUint16(p + 8, 0, true);
    view.setUint16(p + 10, 0, true);
    view.setUint16(p + 12, 0, true);
    view.setUint16(p + 14, 0x21, true);
    view.setUint32(p + 16, file.crc, true);
    view.setUint32(p + 20, file.data.length, true);
    view.setUint32(p + 24, file.data.length, true);
    view.setUint16(p + 28, nameBytes[i].length, true);
    view.setUint16(p + 30, 0, true); // extra
    view.setUint16(p + 32, 0, true); // comment
    view.setUint16(p + 34, 0, true); // disk number
    view.setUint16(p + 36, 0, true); // internal attrs
    view.setUint32(p + 38, 0, true); // external attrs
    view.setUint32(p + 42, offsets[i], true);
    p += 46;
    out.set(nameBytes[i], p);
    p += nameBytes[i].length;
  });

  view.setUint32(p, SIG_EOCD, true);
  view.setUint16(p + 4, 0, true);
  view.setUint16(p + 6, 0, true);
  view.setUint16(p + 8, prepared.length, true);
  view.setUint16(p + 10, prepared.length, true);
  view.setUint32(p + 12, centralSize, true);
  view.setUint32(p + 16, centralStart, true);
  view.setUint16(p + 20, 0, true);

  return out;
}

/* =============================================================================
   SHEET XML: WRITING
============================================================================= */

function xmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function columnLetter(index: number): string {
  let letters = "";
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

/** Every cell is written as an inline string, which sidesteps the shared
 *  string table entirely. Excel reads inline strings natively, and a template
 *  is a handful of cells. The table would be pure ceremony. */
function sheetXml(rows: string[][]): string {
  const body = rows
    .map((cells, r) => {
      const written = cells
        .map((text, c) =>
          text === ""
            ? ""
            : `<c r="${columnLetter(c)}${r + 1}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`,
        )
        .join("");
      return `<row r="${r + 1}">${written}</row>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

const NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_SML = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

/** Assembles a complete, Excel-openable .xlsx from sheets of plain text. */
export function buildWorkbook(sheets: SheetData[]): Uint8Array {
  const files: { name: string; content: string }[] = [];

  files.push({
    name: "[Content_Types].xml",
    content:
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      sheets
        .map(
          (_s, i) =>
            `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
        )
        .join("") +
      `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
      `</Types>`,
  });

  files.push({
    name: "_rels/.rels",
    content:
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/>` +
      `</Relationships>`,
  });

  files.push({
    name: "xl/workbook.xml",
    content:
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<workbook xmlns="${NS_SML}" xmlns:r="${NS_REL}"><sheets>` +
      sheets
        .map((s, i) => `<sheet name="${xmlEscape(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join("") +
      `</sheets></workbook>`,
  });

  files.push({
    name: "xl/_rels/workbook.xml.rels",
    content:
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      sheets
        .map(
          (_s, i) =>
            `<Relationship Id="rId${i + 1}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
        )
        .join("") +
      `<Relationship Id="rId${sheets.length + 1}" Type="${NS_REL}/styles" Target="styles.xml"/>` +
      `</Relationships>`,
  });

  // Excel repairs a workbook whose styles part is missing entries it expects,
  // so this ships the documented minimum: one font, the two mandatory fills
  // (the "none"/"gray125" pair), one border, and one cell format.
  files.push({
    name: "xl/styles.xml",
    content:
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<styleSheet xmlns="${NS_SML}">` +
      `<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>` +
      `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
      `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
      `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
      `<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>` +
      `</styleSheet>`,
  });

  sheets.forEach((sheet, i) => {
    files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, content: sheetXml(sheet.rows) });
  });

  return buildZip(files);
}

/** Chunked so a multi-megabyte workbook can't blow the argument limit that
 *  String.fromCharCode(...spread) has on large arrays. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
