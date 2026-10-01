// IMAC (Iyagi Music Archival Container) -- the files 이야기 뮤직 아카이브
// (imsarchive.curioustorvald.com) serves. One IMAC is one original song, and
// every arrangement and revision of it that circulated is a VARIANT: the song,
// its bank and its lyrics byte for byte as they were found, plus a JSON of
// what is known about them.
//
// The page plays the variants, not the container, so this is only a reader.
// The archive's own reader and writer is `tapgol-worker/imac.js` in
// theimsarchive-web; this is the reading half of it, kept apart because the
// two sites deploy separately.
//
//   RIFF <size> "IMAC"
//     "modT" <8>  u64 LE, last update, Unix seconds
//     "creT" <8>  u64 LE, creation, Unix seconds
//     "V000" <n>  a variant: a run of sub-chunks, exactly like a LIST body
//       "IMS " / "ROL " / "SOP " / "KIS " / "ONG "   the music, one per kind present
//       "ISS " / "TXT "                              lyrics, and their text source
//       "BNK " / "2IM " / "2IS "                     instruments
//       "META"                                       UTF-8 JSON
//     "V001" ...
//
// Every chunk is padded to an even length and the size never counts the pad.
// META's `files` holds each file's verbatim name, which is what the page shows.

const dec = new TextDecoder();

/** Whether `bytes` is an IMAC, whatever the file was called. */
export function isImac(bytes) {
  return bytes.length >= 12
    && dec.decode(bytes.subarray(0, 4)) === "RIFF"
    && dec.decode(bytes.subarray(8, 12)) === "IMAC";
}

function* chunks(b, from, to) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = from;
  while (o + 8 <= to) {
    const id = dec.decode(b.subarray(o, o + 4));
    const size = dv.getUint32(o + 4, true);
    if (o + 8 + size > to) throw new Error(`IMAC chunk ${id} runs past its parent`);
    yield { id, body: b.subarray(o + 8, o + 8 + size) };
    o += 8 + size + (size & 1);
  }
}

/**
 * The variants of an IMAC in order, each `{index, files, meta}`: `files` keyed
 * by chunk ID ("IMS ", "BNK "...), `meta` the parsed JSON or null.
 * @param {Uint8Array} bytes
 */
export function readImac(bytes) {
  if (!isImac(bytes)) throw new Error("not an IMAC file");
  const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
  const variants = [];
  for (const c of chunks(bytes, 12, Math.min(bytes.length, 8 + size))) {
    if (!/^V\d{3}$/.test(c.id)) continue;
    const v = { index: Number(c.id.slice(1)), files: {}, meta: null };
    for (const s of chunks(c.body, 0, c.body.length)) {
      if (s.id !== "META") { v.files[s.id] = s.body; continue; }
      try { v.meta = JSON.parse(dec.decode(s.body)); } catch { /* names are all it was for */ }
    }
    variants.push(v);
  }
  return variants.sort((a, b) => a.index - b.index);
}

/**
 * The verbatim name META gives a variant's file of chunk `id`, or a stand-in
 * made from the IMAC's own name when META has none.
 * @param {{meta: any}} variant @param {string} id @param {string} imacName
 */
export function imacFileName(variant, id, imacName) {
  const key = `${id.trim().toLowerCase()}_filename`;
  const named = variant.meta?.files?.[key];
  if (named) return named;
  return `${imacName.replace(/\.[^.]*$/, "")}.${id.trim()}`;
}
