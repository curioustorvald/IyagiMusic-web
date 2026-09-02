// The page. Everything that makes sound happens in the worklet; this file
// reads files, keeps the UI honest, and lines the lyrics up with the playhead.

import { identify, resolveIssSpans } from "./lib/player.js";
import { createVisualiser } from "./visualiser.js";

const $ = (id) => document.getElementById(id);
const els = {
  drop: $("drop"), pick: $("pick"), files: $("files"), stage: $("stage"),
  title: $("title"), meta: $("meta"), warn: $("warn"),
  play: $("play"), stop: $("stop"), loop: $("loop"), gain: $("gain"),
  clock: $("clock"), lyrics: $("lyrics"), credits: $("credits"), lines: $("lines"),
  view: $("view"), follow: $("follow"),
  scope: $("scope"), scopeToggle: $("scope-toggle"),
  meters: $("meters"), chipFlags: $("chipflags"),
  remix: $("remix"), remixNote: $("remix-note"),
};

/**
 * Auto-follow keeps the sung line in the middle of the window, but it must
 * yield the moment the reader takes hold of the scroller -- otherwise every
 * cue yanks the view back and browsing the lyric is impossible. It comes back
 * on its own after a quiet spell, or immediately from the button.
 */
const FOLLOW_RESUME_MS = 6000;
let following = true;
let followTimer = 0;

const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/**
 * The chip's own status, one column per voice. Eleven bars moving at 60 Hz is
 * exactly the kind of thing someone asks the browser to stop doing, so a
 * reader who has asked for less motion gets the panel folded away rather than
 * a stilled version of it.
 */
const scope = createVisualiser(els.meters, els.chipFlags);
function setScopeOpen(open) {
  els.scope.toggleAttribute("data-collapsed", !open);
  els.scopeToggle.setAttribute("aria-expanded", String(open));
  els.scopeToggle.textContent = open ? "숨기기" : "보이기";
  scope.setActive(open);
}
els.scopeToggle.addEventListener("click", () =>
  setScopeOpen(els.scope.hasAttribute("data-collapsed")));
setScopeOpen(!reduceMotion);

function setFollowing(on) {
  following = on;
  els.follow.hidden = on;
  clearTimeout(followTimer);
  if (!on) followTimer = setTimeout(() => setFollowing(true), FOLLOW_RESUME_MS);
  if (on && lyricState) centreLine(activeLineNode() ?? lyricState.nodes[0]);
}

const activeLineNode = () => els.lines.querySelector(".line.on");

/** Half the window, so even the first and last lines can reach the middle. */
function sizeLyricPadding() {
  if (!els.view) return;
  const line = els.lines.firstElementChild;
  const lineHeight = line ? line.offsetHeight : 0;
  els.lines.style.setProperty("--pad",
    `${Math.max(0, (els.view.clientHeight - lineHeight) / 2)}px`);
}

let ctx = null;
let node = null;
let playing = false;
let lyricState = null;
/** The song currently loaded, kept for the handoff below. */
let loaded = null;

/**
 * The bundled general bank, fetched once and only when a song first needs it.
 * .ims files name their patches but do not carry them, so without a bank
 * nothing sounds; shipping one is what makes a bare drop work.
 */
const BUNDLED_BANK_URL = "STANDARD.BNK";
let bundledBank;
async function bundledBankBytes() {
  if (bundledBank !== undefined) return bundledBank;
  try {
    const res = await fetch(BUNDLED_BANK_URL);
    bundledBank = res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
  } catch {
    bundledBank = null;                    // forked without the bank; fine
  }
  return bundledBank;
}

// ── audio graph ───────────────────────────────────────────────────────────

async function ensureAudio() {
  if (node) return node;
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  await ctx.audioWorklet.addModule("iyagi-processor.bundle.js");
  node = new AudioWorkletNode(ctx, "iyagi-processor", { outputChannelCount: [2] });
  node.connect(ctx.destination);
  node.port.onmessage = (e) => onWorkletMessage(e.data);
  return node;
}

function onWorkletMessage(msg) {
  switch (msg.type) {
    case "loaded":
      showSong(msg);
      break;
    case "position":
      els.clock.textContent = formatTime(msg.seconds);
      updateLyrics(msg.tick);
      scope.push(msg);
      break;
    case "ended":
      setPlaying(false);
      break;
    case "error":
      showError(msg.message);
      break;
    default:
      break;
  }
}

// ── file intake ───────────────────────────────────────────────────────────

/**
 * Sort a dropped batch by what the bytes say, not by the extension: the
 * corpus is full of files whose names lie.
 */
async function classify(fileList) {
  const found = { song: null, songName: "", bank: null, bankName: "", lyrics: null };
  const banks = [];
  for (const file of fileList) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    switch (identify(bytes)) {
      case "ims":
      case "rol":
        if (!found.song) { found.song = bytes; found.songName = file.name; }
        break;
      case "bnk":
        banks.push({ bytes, name: file.name });
        break;
      case "iss":
        if (!found.lyrics) found.lyrics = bytes;
        break;
      default:
        break;
    }
  }
  // Prefer a bank whose name matches the song's -- that is the song's own
  // bank, and it must win over any general one in the same drop.
  const stem = found.songName.replace(/\.[^.]*$/, "").toUpperCase();
  const own = banks.find((b) => b.name.replace(/\.[^.]*$/, "").toUpperCase() === stem);
  const chosen = own ?? banks[0];
  if (chosen) { found.bank = chosen.bytes; found.bankName = chosen.name; }
  const spare = banks.find((b) => b !== chosen);
  found.fallbackBank = spare?.bytes;
  found.fallbackName = spare?.name ?? "";
  return found;
}

async function load(fileList) {
  const found = await classify(fileList);
  if (!found.song) {
    showError("재생할 수 있는 파일이 없습니다. .ims 또는 .rol 파일을 넣어 주세요.");
    return;
  }
  // Fall back to the bundled bank when the drop did not include one.
  if (!found.bank) {
    const bytes = await bundledBankBytes();
    if (bytes) { found.bank = bytes; found.bankName = "STANDARD.BNK (내장)"; }
  } else if (!found.fallbackBank) {
    found.fallbackBank = await bundledBankBytes() ?? undefined;
    if (found.fallbackBank) found.fallbackName = "STANDARD.BNK (내장)";
  }
  await ensureAudio();
  await ctx.resume();
  setPlaying(false);
  scope.clear();
  node.port.postMessage({
    type: "load",
    song: found.song,
    bank: found.bank,
    fallbackBank: found.fallbackBank,
    lyrics: found.lyrics,
    loop: els.loop.checked,
    gain: Number(els.gain.value) / 100,
  });
  // Keep a local copy of the header for the info panel, so the worklet only
  // has to report what it alone knows.
  els.stage.hidden = false;
  els.stage.dataset.songName = found.songName;
  els.stage.dataset.bankName = found.bankName;
  els.stage.dataset.fallbackName = found.fallbackName ?? "";
  // Keep the bytes: the remix button hands the very same pair to Microtone,
  // so the listener never has to save a file and find it again.
  loaded = { name: found.songName || "song.ims", song: found.song,
             bank: found.bank, bankName: found.bankName };
  els.remix?.classList.remove("remix-idle");
}

function showError(message) {
  els.stage.hidden = false;
  els.warn.hidden = false;
  els.warn.textContent = message;
  els.play.disabled = true;
  els.stop.disabled = true;
}

// ── song panel ────────────────────────────────────────────────────────────

function showSong(msg) {
  const name = els.stage.dataset.songName || "";
  els.title.textContent = msg.title.trim() || name || "제목 없음";
  const rows = [
    ["형식", msg.kind === "ims" ? "IMS (이야기 뮤직 사운드)" : "ROL (애드립 Visual Composer)"],
    ["파일", name],
  ];
  if (els.stage.dataset.bankName) {
    const extra = els.stage.dataset.fallbackName;
    rows.push(["음색 뱅크", els.stage.dataset.bankName + (extra ? ` → ${extra}` : "")]);
  }
  els.meta.replaceChildren(...rows.flatMap(([k, v]) => {
    const dt = document.createElement("dt"); dt.textContent = k;
    const dd = document.createElement("dd"); dd.textContent = v;
    return [dt, dd];
  }));

  if (msg.missing.length) {
    els.warn.hidden = false;
    els.warn.textContent =
      `음색 ${msg.missing.length}개를 뱅크에서 찾지 못했습니다 (${msg.missing.slice(0, 6).join(", ")}` +
      `${msg.missing.length > 6 ? " …" : ""}). 해당 성부는 소리가 나지 않습니다.`;
  } else if (!els.stage.dataset.bankName) {
    els.warn.hidden = false;
    els.warn.textContent = "음색 뱅크(.bnk)가 없어 소리가 나지 않을 수 있습니다.";
  } else {
    els.warn.hidden = true;
  }

  setupLyrics(msg.lyrics, msg.tickBeat);
  els.play.disabled = false;
  els.stop.disabled = false;
  els.clock.textContent = "0:00";
}

const formatTime = (s) =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

// ── lyrics ────────────────────────────────────────────────────────────────

/** East-Asian wide characters take two cells, which is what ISS counts in. */
const isWide = (ch) => {
  const c = ch.codePointAt(0);
  return (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) ||
    (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6);
};

/** Map a cell offset to a character index within a line. */
function cellToIndex(text, cell) {
  let cells = 0;
  for (let i = 0; i < text.length; i++) {
    if (cells >= cell) return i;
    cells += isWide(text[i]) ? 2 : 1;
  }
  return text.length;
}

function setupLyrics(iss, tickBeat) {
  lyricState = null;
  els.lyrics.hidden = true;
  els.credits.replaceChildren();
  els.lines.replaceChildren();
  if (!iss) return;

  // The four credit fields almost never hold credits: across the whole known
  // corpus they are either the field labels left untouched or one ISS tool's
  // default handles, and not one of them ever matches the artist named in the
  // song's own title. Showing them would be inventing an attribution.
  // See docs/FILE_FORMATS.en.md section 4.1.
  const PLACEHOLDER_CREDITS = new Set([
    "WRITER", "COMPOSER", "SINGER", "EDITOR",
    "LeeYS", "MunBK", "KimTH", "Solgher", "Damul", "Salmosa",
  ]);
  const credits = [
    ["작사", iss.writer], ["작곡", iss.composer],
    ["노래", iss.singer], ["제작", iss.editor],
  ].filter(([, v]) => v && v.trim() && !PLACEHOLDER_CREDITS.has(v.trim()));
  els.credits.replaceChildren(...credits.map(([k, v]) => {
    const span = document.createElement("span");
    span.append(`${k} `);
    const b = document.createElement("b");
    b.textContent = v.trim();
    span.append(b);
    return span;
  }));

  const nodes = iss.lines.map((text) => {
    const div = document.createElement("div");
    div.className = "line";
    div.textContent = text || " ";
    return div;
  });
  els.lines.replaceChildren(...nodes);
  lyricState = { iss, nodes, tickBeat, cue: -1, spans: resolveIssSpans(iss) };
  els.lyrics.hidden = false;
  // Lay out first, then park on the opening line: before the first cue there
  // is nothing "current", and a lyric sitting at the top of the window reads
  // as broken rather than as not-started-yet.
  requestAnimationFrame(() => {
    sizeLyricPadding();
    setFollowing(true);
    centreLine(nodes[0]);
  });
}

function updateLyrics(tick) {
  if (!lyricState) return;
  const { iss, nodes } = lyricState;
  let index = -1;
  for (let i = 0; i < iss.cues.length; i++) {
    if (iss.cues[i].tick > tick) break;
    index = i;
  }
  if (index === lyricState.cue) return;
  lyricState.cue = index;
  if (index < 0) return;
  const span = lyricState.spans[index];
  const line = nodes[span.line];
  if (!line) return;

  for (const n of nodes) {
    if (n.classList.contains("on")) n.textContent = n.dataset.text ?? n.textContent;
    n.classList.remove("on", "near");
  }
  const text = iss.lines[span.line] ?? "";
  line.dataset.text = text || " ";
  line.classList.add("on");
  // The neighbours stay legible but recede, which is what makes the middle
  // read as "now" without needing any other marker.
  for (const offset of [-2, -1, 1, 2]) nodes[span.line + offset]?.classList.add("near");

  // The span already accounts for everything coloured so far on this line;
  // convert its cell columns to character indices.
  const from = cellToIndex(text, span.from);
  const to = cellToIndex(text, span.to);
  // Empty lines render as a single space so they keep their height; slice
  // that placeholder rather than `text` itself, or an empty line would go
  // content-less (and collapse) the moment it becomes the active line.
  const display = text || " ";
  line.replaceChildren(
    document.createTextNode(display.slice(0, from)),
    Object.assign(document.createElement("mark"), { textContent: display.slice(from, to) }),
    document.createTextNode(display.slice(to)),
  );
  if (following) centreLine(line);
}

/** Scroll so `line` sits in the middle of the window. */
function centreLine(line) {
  if (!line) return;
  const target = line.offsetTop + line.offsetHeight / 2 - els.view.clientHeight / 2;
  els.view.scrollTo({ top: Math.max(0, target), behavior: reduceMotion ? "auto" : "smooth" });
}

// ── controls ──────────────────────────────────────────────────────────────

function setPlaying(on) {
  playing = on;
  els.play.textContent = on ? "일시정지" : "재생";
  node?.port.postMessage({ type: on ? "play" : "pause" });
}

els.play.addEventListener("click", async () => {
  await ctx?.resume();
  setPlaying(!playing);
});
els.stop.addEventListener("click", () => {
  setPlaying(false);
  node?.port.postMessage({ type: "stop" });
  els.clock.textContent = "0:00";
  if (lyricState) lyricState.cue = -1;
});
els.loop.addEventListener("change", () =>
  node?.port.postMessage({ type: "loop", value: els.loop.checked }));
els.gain.addEventListener("input", () =>
  node?.port.postMessage({ type: "gain", value: Number(els.gain.value) / 100 }));

for (const type of ["wheel", "touchmove", "pointerdown"]) {
  els.view.addEventListener(type, () => setFollowing(false), { passive: true });
}
els.view.addEventListener("keydown", (e) => {
  if (/^(Arrow|Page|Home|End)/.test(e.key)) setFollowing(false);
});
els.follow.addEventListener("click", () => setFollowing(true));
window.addEventListener("resize", () => {
  sizeLyricPadding();
  if (following) centreLine(activeLineNode() ?? lyricState?.nodes[0]);
});

els.pick.addEventListener("click", (e) => { e.stopPropagation(); els.files.click(); });
els.drop.addEventListener("click", () => els.files.click());
els.drop.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); els.files.click(); }
});
els.files.addEventListener("change", () => {
  if (els.files.files.length) load([...els.files.files]);
});

for (const type of ["dragenter", "dragover"]) {
  els.drop.addEventListener(type, (e) => { e.preventDefault(); els.drop.classList.add("over"); });
}
for (const type of ["dragleave", "drop"]) {
  els.drop.addEventListener(type, () => els.drop.classList.remove("over"));
}
els.drop.addEventListener("drop", (e) => {
  e.preventDefault();
  const files = [...(e.dataTransfer?.files ?? [])];
  if (files.length) load(files);
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());


// ── "remix this in Microtone" ─────────────────────────────────────────────
//
// Microtone (microtone.cc) is a tracker that runs in the browser and imports
// .ims files. Sending the listener off with a download would mean saving a
// file, finding it, and dropping it back in -- and for this format, doing that
// TWICE, because a song without its instrument bank makes no sound. So the song
// travels in the link: gzipped, base64url, in the URL FRAGMENT, which no server
// ever sees and no cross-origin policy can get in the way of. Across the whole
// reference corpus that is a median 9.5 kB of URL and a worst case of 52 kB.
//
// The receiving half is Microtone's src/ui/handoff.js; the envelope below is
// the same twelve lines written the other way round.

const MICROTONE_URL = "https://microtone.cc/";
const HANDOFF_PREFIX = "#import=";
const HANDOFF_MAGIC = [0x4d, 0x54, 0x48, 0x31];   // "MTH1"
const HANDOFF_GZIP = 1;
/** Past this the URL stops being a sane way to move a file. */
const HANDOFF_MAX = 1_500_000;

function handoffField(parts, name, bytes) {
  const n = new TextEncoder().encode(name).subarray(0, 255);
  parts.push(Uint8Array.of(n.length), n);
  const len = bytes ? bytes.length : 0;
  parts.push(Uint8Array.of(len & 0xff, (len >> 8) & 0xff, (len >> 16) & 0xff, (len >>> 24) & 0xff));
  if (bytes) parts.push(bytes);
}

function toBase64Url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** gzip, where the browser has it; the flag byte says which way it went. */
async function maybeGzip(bytes) {
  if (typeof CompressionStream !== "function") return { bytes, gzipped: false };
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
    const packed = new Uint8Array(await new Response(stream).arrayBuffer());
    return packed.length < bytes.length ? { bytes: packed, gzipped: true } : { bytes, gzipped: false };
  } catch {
    return { bytes, gzipped: false };
  }
}

async function handoffUrl(song) {
  const parts = [];
  handoffField(parts, song.name, song.song);
  handoffField(parts, song.bank ? (song.bankName || "bank.bnk") : "", song.bank ?? null);
  const inner = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { inner.set(p, o); o += p.length; }
  const { bytes, gzipped } = await maybeGzip(inner);
  const out = new Uint8Array(5 + bytes.length);
  out.set(HANDOFF_MAGIC, 0);
  out[4] = gzipped ? HANDOFF_GZIP : 0;
  out.set(bytes, 5);
  return MICROTONE_URL + HANDOFF_PREFIX + toBase64Url(out);
}

function remixNote(text) {
  if (els.remixNote) els.remixNote.textContent = text;
}

els.remix?.addEventListener("click", (e) => {
  if (!loaded) return;                       // no song yet: plain link, plain tab
  e.preventDefault();
  remixNote("Microtone로 보낼 준비 중…");
  handoffUrl(loaded).then((url) => {
    if (url.length > HANDOFF_MAX) {
      remixNote("곡이 너무 커서 링크로 넘길 수 없습니다. 파일을 직접 넣어 주세요.");
      return;
    }
    window.open(url, "_blank", "noopener");
    remixNote("Microtone에서 열었습니다.");
  }).catch(() => {
    remixNote("곡을 넘기지 못했습니다. 파일을 직접 넣어 주세요.");
  });
});
