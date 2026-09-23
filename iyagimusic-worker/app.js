// The page. Everything that makes sound happens in the worklet; this file
// reads files, keeps the UI honest, and lines the lyrics up with the playhead.
//
// The controls are IMPLAY's (docs/ENGINE_SPEC.en.md §13): transport, a speed
// in steps of 5%, a key in semitones, and a seek that restarts the song and
// runs silently up to where it was asked to land. What IMPLAY also had -- a
// mixer, a microphone, a lyric editor, a karaoke scorer -- is not here.

import { identify, resolveIssSpans, METER_STRIDE, M_KEY_ON, RHYTHM_VOICES, CF_RHYTHM }
  from "./lib/player.js";
import { createVisualiser } from "./visualiser.js";

const $ = (id) => document.getElementById(id);
const els = {
  rack: $("rack"), open: $("open"), files: $("files"), veil: $("dropveil"),
  title: $("title"), file: $("file"), index: $("index"), badge: $("stereo-badge"),
  bank: $("bank"), count: $("count"), warn: $("warn"),
  channels: $("channels"),
  prev: $("prev"), rew: $("rew"), ff: $("ff"), next: $("next"), play: $("play"), stop: $("stop"),
  slower: $("slower"), speed: $("speed"), faster: $("faster"),
  lower: $("lower"), key: $("key"), higher: $("higher"),
  gain: $("gain"),
  clock: $("clock"), length: $("length"), progress: $("progress"),
  lyricsUnit: document.querySelector(".unit-lyrics"),
  credits: $("credits"), lines: $("lines"), view: $("view"), follow: $("follow"),
  remix: $("remix"), remixNote: $("remix-note"),
};

// ── settings ──────────────────────────────────────────────────────────────
//
// The four switches and the volume are the listener's, and outlive a song and
// a visit. Browser storage can be missing or refuse (private windows, blocked
// site data); the page then simply starts from the defaults every time.

const SETTINGS_KEY = "iyagimusic.settings";
const DEFAULTS = { tone: "standard", speaker: "default", output: "stereo", loop: "off", volume: 100 };
const settings = { ...DEFAULTS };
try {
  Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}"));
} catch { /* no storage: defaults */ }
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* fine */ }
}

// ── speed and key: IMPLAY's units ─────────────────────────────────────────
//
// IMPLAY keeps its speed in half-percent steps, 200 for as written, and moves
// it by 10 -- five per cent -- up to 800 (ENGINE_SPEC §13). It lets it fall to
// 0, where its timer gives up and runs at the PC's 18.2 Hz default; this stops
// at 5% instead. The key moves a semitone at a time, to two octaves either way.
const SPEED_UNIT = 200, SPEED_STEP = 10, SPEED_MIN = 10, SPEED_MAX = 800;
const KEY_LIMIT = 24;
let speedUnits = SPEED_UNIT;
let transpose = 0;

// ── state ─────────────────────────────────────────────────────────────────

let ctx = null;
let node = null;
let dryGain = null, wetGain = null;
let playing = false;
let ended = false;
/** What the worklet last said about the song: duration, tempo, voices… */
let song = null;
/** @type {{position:number, tempo:number}} */
let clock = { position: 0, tempo: 0 };
/** The dropped songs, in order, each with its bank and lyrics paired up. */
let playlist = [];
let current = -1;
let lyricState = null;
/** The song currently loaded, kept for the handoff to Microtone. */
let loaded = null;

const scope = createVisualiser($("meter"), $("chipline"));

// ── audio graph ───────────────────────────────────────────────────────────

/**
 * "그 시절": the song through a small desktop PC speaker, as an impulse
 * response (SMOLSPKR.BIN: float32 little-endian, stereo interleaved, 48 kHz).
 *
 * The response is anything but quiet -- +24 dB at 3.5 kHz, and -27 dB at
 * 90 Hz -- so it is applied un-normalised and brought back by one fixed
 * gain. That gain matches the two paths by loudness: across 79 corpus
 * songs (60 .ims, 19 .sop, 20 s each from 10 s in, rendered as this page
 * plays them), BS.1770 integrated loudness came out 12.45 LU higher through
 * the speaker, median, with a spread of 1.8. 10^(-12.45/20) = 0.239. At that
 * gain 12 of the 79 peak above full scale, the worst by 3.3 dB.
 */
const SPEAKER_URL = "SMOLSPKR.BIN";
const SPEAKER_RATE = 48000;
const SPEAKER_GAIN = 0.239;
const CROSSFADE_S = 0.03;

async function speakerBuffer() {
  const res = await fetch(SPEAKER_URL);
  if (!res.ok) throw new Error(`${SPEAKER_URL}: ${res.status}`);
  const data = new Float32Array(await res.arrayBuffer());
  const frames = data.length >> 1;
  const at48 = new AudioBuffer({ numberOfChannels: 2, length: frames, sampleRate: SPEAKER_RATE });
  const left = at48.getChannelData(0), right = at48.getChannelData(1);
  for (let i = 0; i < frames; i++) { left[i] = data[2 * i]; right[i] = data[2 * i + 1]; }
  if (ctx.sampleRate === SPEAKER_RATE) return at48;
  // A ConvolverNode only takes a buffer at its context's own rate. Where the
  // browser would not give us a 48 kHz context, let it resample the response.
  const length = Math.ceil(frames * ctx.sampleRate / SPEAKER_RATE);
  const off = new OfflineAudioContext(2, length, ctx.sampleRate);
  const src = new AudioBufferSourceNode(off, { buffer: at48 });
  src.connect(off.destination);
  src.start();
  return off.startRendering();
}

async function ensureAudio() {
  if (node) return node;
  // 48 kHz asked for, not assumed: it is the response's rate, and the browser
  // resamples to the device either way.
  try { ctx = new AudioContext({ sampleRate: SPEAKER_RATE }); }
  catch { ctx = new AudioContext(); }
  await ctx.audioWorklet.addModule("iyagi-processor.bundle.js");
  node = new AudioWorkletNode(ctx, "iyagi-processor", { outputChannelCount: [2] });
  node.port.onmessage = (e) => onWorkletMessage(e.data);
  dryGain = new GainNode(ctx, { gain: settings.speaker === "vintage" ? 0 : 1 });
  wetGain = new GainNode(ctx, { gain: settings.speaker === "vintage" ? SPEAKER_GAIN : 0 });
  node.connect(dryGain).connect(ctx.destination);
  // The speaker path is wired once its response has arrived; until then (or
  // if it never does) the dry path is what plays.
  speakerBuffer().then((buffer) => {
    const conv = new ConvolverNode(ctx, { disableNormalization: true, buffer });
    node.connect(conv).connect(wetGain).connect(ctx.destination);
  }).catch(() => {
    wetGain.gain.value = 0;
    dryGain.gain.value = 1;
    setSwitch("speaker", "default", false);
    switchButton("speaker", "vintage").disabled = true;
  });
  return node;
}

function applySpeaker() {
  if (!ctx) return;
  const vintage = settings.speaker === "vintage";
  const t = ctx.currentTime;
  dryGain.gain.setTargetAtTime(vintage ? 0 : 1, t, CROSSFADE_S);
  wetGain.gain.setTargetAtTime(vintage ? SPEAKER_GAIN : 0, t, CROSSFADE_S);
}

const post = (msg) => node?.port.postMessage(msg);

function onWorkletMessage(msg) {
  switch (msg.type) {
    case "loaded":
      showSong(msg);
      break;
    case "position":
      clock = { position: msg.position, tempo: msg.tempo };
      updateClock();
      updateLyrics(msg.lyricTick);
      updateChannels(msg);
      scope.push(msg);
      break;
    case "ended":
      onEnded();
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
 * Which song formats name their instruments instead of carrying them, and so
 * need a `.bnk` alongside. A `.sop` carries its own (SOP §3), which is why it
 * is the one format that must not be warned about for arriving without one.
 */
const NEEDS_BANK = { ims: true, rol: true, sop: false };

const stemOf = (name) => name.replace(/\.[^.]*$/, "").toUpperCase();

/**
 * The bundled general bank, fetched once and only when a song first needs it.
 * .ims files name their patches but do not carry them, so without a bank
 * nothing sounds; shipping one is what makes a bare drop work.
 */
const BUNDLED_BANK_URL = "STANDARD.BNK";
const BUNDLED_NAME = "STANDARD.BNK (내장)";
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

/**
 * Sort a drop into a playlist by what the bytes say, not by the extension:
 * the corpus is full of files whose names lie.
 *
 * Each song gets the bank and the lyrics that share its name. A bank that
 * shares no song's name is a general one, and backs up every song's own; the
 * bundled bank backs up both. Lyrics that share no name go to the song only
 * when there is exactly one of each -- anything else would be a guess.
 */
async function intake(fileList) {
  const songs = [], banks = [], lyrics = [];
  for (const file of fileList) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const kind = identify(bytes);
    const item = { bytes, name: file.name, stem: stemOf(file.name), kind };
    if (kind === "ims" || kind === "rol" || kind === "sop") songs.push(item);
    else if (kind === "bnk") banks.push(item);
    else if (kind === "iss") lyrics.push(item);
  }
  songs.sort((a, b) => a.name.localeCompare(b.name, "ko"));
  const songStems = new Set(songs.map((s) => s.stem));
  const general = banks.filter((b) => !songStems.has(b.stem));
  return songs.map((s) => {
    const own = banks.find((b) => b.stem === s.stem);
    const bank = NEEDS_BANK[s.kind] ? (own ?? general[0] ?? null) : null;
    const spare = NEEDS_BANK[s.kind] ? (general.find((b) => b !== bank) ?? null) : null;
    const iss = lyrics.find((l) => l.stem === s.stem) ??
      (songs.length === 1 && lyrics.length === 1 ? lyrics[0] : null);
    return { song: s, bank, spare, iss };
  });
}

async function openFiles(fileList) {
  const list = await intake(fileList);
  if (!list.length) {
    showError("재생할 수 있는 파일이 없습니다. .ims, .rol 또는 .sop 파일을 넣어 주세요.");
    return;
  }
  playlist = list;
  await playEntry(0, true);
}

/** Load playlist entry `i`, and start it if `autoplay`. */
async function playEntry(i, autoplay) {
  const entry = playlist[i];
  if (!entry) return;
  current = i;
  const needsBank = NEEDS_BANK[entry.song.kind];
  let bank = entry.bank?.bytes, bankName = entry.bank?.name ?? "";
  let fallback = entry.spare?.bytes, fallbackName = entry.spare?.name ?? "";
  if (needsBank) {
    // The bundled bank goes last in line: under the song's own bank, or in
    // its place when the drop brought none.
    const bundled = await bundledBankBytes();
    if (!bank && bundled) { bank = bundled; bankName = BUNDLED_NAME; }
    else if (!fallback && bundled) { fallback = bundled; fallbackName = BUNDLED_NAME; }
  }
  await ensureAudio();
  await ctx.resume();
  setPlaying(false);
  ended = false;
  scope.clear();
  speedUnits = SPEED_UNIT;
  transpose = 0;
  pendingPlay = autoplay;
  post({
    type: "load",
    song: entry.song.bytes,
    bank, fallbackBank: fallback,
    lyrics: entry.iss?.bytes,
    loop: settings.loop === "on",
    // A fraction of the chip's headroom rather than an absolute scale: twenty
    // OPL3 voices need more room than nine OPL2 ones, and the player knows how
    // much. See `IyagiMusic.volume`.
    volume: settings.volume / 100,
    // IMPLAY's stereo for anything that is not a .sop; "mono" folds it back
    // to exactly the YM3812's output, so this costs a mono listener nothing.
    implayStereo: true,
    mono: settings.output === "mono",
    tone: settings.tone,
    speed: 1,
    transpose: 0,
  });
  els.file.textContent = entry.song.name;
  els.index.textContent = playlist.length > 1 ? `[${i + 1} / ${playlist.length}]` : "";
  els.bank.textContent = !needsBank ? "음색 내장 (.sop)"
    : bankName ? bankName + (fallbackName ? ` → ${fallbackName}` : "") : "음색 뱅크 없음";
  entryNames = { bank: bankName };
  // Keep the bytes: the remix button hands the very same pair to Microtone,
  // so the listener never has to save a file and find it again. The KIND goes
  // with them, because the receiving end picks its converter by extension and
  // `intake` has just finished establishing that the name may not say.
  loaded = { name: entry.song.name || "song", kind: entry.song.kind,
             song: entry.song.bytes, bank: needsBank ? bank : undefined, bankName };
  els.remix?.classList.remove("remix-idle");
  remixNote(needsBank
    ? "곡을 열면 음색 뱅크까지 그대로 넘겨 드립니다"
    : "악기가 곡 안에 들어 있어 파일 하나로 그대로 넘어갑니다");
}
let pendingPlay = false;
let entryNames = { bank: "" };

function showError(message) {
  els.warn.hidden = false;
  els.warn.textContent = message;
}

// ── the display ───────────────────────────────────────────────────────────

function showSong(msg) {
  song = msg;
  const name = playlist[current]?.song.name ?? "";
  els.title.textContent = msg.title.trim() || name || "제목 없음";
  els.title.parentElement.title = els.title.textContent;
  els.count.textContent = `사용 악기 ${msg.instrumentCount}개`;
  scope.mode = msg.implayStereo ? "IMPLAY 스테레오" : "";
  updateBadge();

  if (msg.missing.length) {
    els.warn.hidden = false;
    els.warn.textContent =
      `음색 ${msg.missing.length}개를 뱅크에서 찾지 못했습니다 (${msg.missing.slice(0, 6).join(", ")}` +
      `${msg.missing.length > 6 ? " …" : ""}). 해당 성부는 소리가 나지 않습니다.`;
  } else if (NEEDS_BANK[msg.kind] && !entryNames.bank) {
    // Only for a format that names its instruments without carrying them. A
    // .sop arrives with no bank because it needs none, and warning about that
    // would be telling the listener to go and find a file that does not exist.
    els.warn.hidden = false;
    els.warn.textContent = "음색 뱅크(.bnk)가 없어 소리가 나지 않을 수 있습니다.";
  } else {
    els.warn.hidden = true;
  }

  channelShape = { voices: -1, rhythm: false };
  els.lyricsUnit.classList.add("song-open");
  setupLyrics(msg.lyrics, msg.tickBeat);
  for (const b of [els.play, els.stop, els.prev, els.next, els.rew, els.ff,
    els.slower, els.speed, els.faster, els.lower, els.key, els.higher, els.progress]) {
    b.disabled = false;
  }
  els.length.textContent = formatTime(msg.duration);
  clock = { position: 0, tempo: msg.tempo };
  updateClock();
  updateShiftLabels();
  if (pendingPlay) { pendingPlay = false; setPlaying(true); }
}

function updateBadge() {
  const stereo = song?.canStereo && settings.output !== "mono";
  els.badge.textContent = song ? (stereo ? "STEREO" : "MONO") : "—";
}

const formatTime = (s) => {
  const t = Math.max(0, Math.floor(s || 0));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};

// ── the voice list ────────────────────────────────────────────────────────
//
// IMPLAY's panel: each voice's number, its instrument, a lamp lit while it
// holds a note (IMPLAY drew a "P" in two colours), and the key shift it is
// playing at. The drums show no key: this player leaves them where they are.

let channelShape = { voices: -1, rhythm: false };
let channelRows = [];
let tempoRow = null;
let patchNames = [];

function buildChannels(voices, rhythm) {
  channelShape = { voices, rhythm };
  const drums = rhythm ? voices - RHYTHM_VOICES : voices;
  const DRUM_NAMES = ["베이스 드럼", "스네어", "톰톰", "심벌", "하이햇"];
  channelRows = [];
  const nodes = [];
  for (let v = 0; v < voices; v++) {
    const drum = v >= drums;
    const row = document.createElement("div");
    row.className = drum ? "chrow drum unused" : "chrow unused";
    const n = document.createElement("span"); n.className = "n"; n.textContent = String(v + 1);
    const name = document.createElement("span"); name.className = "name";
    name.textContent = drum ? DRUM_NAMES[v - drums] : "—";
    const lamp = document.createElement("span"); lamp.className = "lamp";
    const shift = document.createElement("span"); shift.className = "shift-val";
    row.append(n, name, lamp, shift);
    nodes.push(row);
    channelRows.push({ row, name, shift, drum, on: false, used: false, drumName: name.textContent });
  }
  tempoRow = document.createElement("div");
  tempoRow.className = "chrow tempo";
  nodes.push(tempoRow);
  // Two columns, filled top to bottom, with the tempo line last: IMPLAY's
  // six-and-five-plus-tempo, and as many rows as a bigger song needs.
  els.channels.style.setProperty("--rows", String(Math.ceil((voices + 1) / 2)));
  els.channels.replaceChildren(...nodes);
  refreshChannelText();
}

function refreshChannelText() {
  for (let v = 0; v < channelRows.length; v++) {
    const c = channelRows[v];
    if (!c.drum) {
      const text = patchNames[v] || "—";
      if (c.name.textContent !== text) c.name.textContent = text;
    } else if (patchNames[v] && c.name.textContent !== patchNames[v]) {
      c.name.textContent = patchNames[v];
    }
    c.shift.textContent = c.drum ? "·" : formatKey(transpose);
  }
  updateTempoRow();
}

function updateTempoRow() {
  if (!tempoRow) return;
  // Integer division, as IMPLAY's own display does: 112 at 90% reads 100.
  const bpm = Math.floor(clock.tempo * speedUnits / SPEED_UNIT);
  tempoRow.innerHTML = "";
  const a = document.createElement("span");
  a.append("템포 = ");
  const b = document.createElement("b"); b.textContent = String(bpm);
  a.append(b);
  const pct = document.createElement("span");
  pct.textContent = `${Math.round(speedUnits / 2)}%`;
  tempoRow.append(a, pct);
}

const formatKey = (k) => `${k < 0 ? "−" : k > 0 ? "+" : "±"}${String(Math.abs(k)).padStart(2, "0")}`;

let shownTempo = -1;
function updateChannels(msg) {
  const rhythm = (msg.chipFlags & CF_RHYTHM) !== 0;
  if (msg.voices !== channelShape.voices || rhythm !== channelShape.rhythm) {
    buildChannels(msg.voices, rhythm);
  }
  if (msg.patchNames) { patchNames = msg.patchNames; refreshChannelText(); }
  for (let v = 0; v < channelRows.length; v++) {
    const c = channelRows[v];
    const on = msg.meter[v * METER_STRIDE + M_KEY_ON] > 0;
    if (on !== c.on) { c.on = on; c.row.classList.toggle("on", on); }
    if (on && !c.used) { c.used = true; c.row.classList.remove("unused"); }
  }
  if (msg.tempo !== shownTempo) { shownTempo = msg.tempo; updateTempoRow(); }
}

// ── speed and key ─────────────────────────────────────────────────────────

function setSpeed(units) {
  speedUnits = Math.min(SPEED_MAX, Math.max(SPEED_MIN, units));
  post({ type: "speed", value: speedUnits / SPEED_UNIT });
  updateShiftLabels();
  updateTempoRow();
}
function setKey(k) {
  transpose = Math.min(KEY_LIMIT, Math.max(-KEY_LIMIT, k));
  post({ type: "transpose", value: transpose });
  updateShiftLabels();
  refreshChannelText();
}
function updateShiftLabels() {
  els.speed.textContent = `${Math.round(speedUnits / 2)}%`;
  els.speed.classList.toggle("moved", speedUnits !== SPEED_UNIT);
  els.key.textContent = transpose ? `키 ${formatKey(transpose)}` : "키";
  els.key.classList.toggle("moved", transpose !== 0);
}

els.slower.addEventListener("click", () => setSpeed(speedUnits - SPEED_STEP));
els.faster.addEventListener("click", () => setSpeed(speedUnits + SPEED_STEP));
els.speed.addEventListener("click", () => setSpeed(SPEED_UNIT));
els.lower.addEventListener("click", () => setKey(transpose - 1));
els.higher.addEventListener("click", () => setKey(transpose + 1));
els.key.addEventListener("click", () => setKey(0));

// ── transport ─────────────────────────────────────────────────────────────

function setPlaying(on) {
  if (on && ended) { post({ type: "seek", seconds: 0 }); ended = false; }
  playing = on;
  els.play.classList.toggle("playing", on);
  els.play.setAttribute("aria-label", on ? "일시정지" : "재생");
  post({ type: on ? "play" : "pause" });
}

function seekTo(seconds) {
  if (!song) return;
  ended = false;
  post({ type: "seek", seconds });
  if (lyricState) lyricState.cue = -2;
}

function onEnded() {
  if (current + 1 < playlist.length) { playEntry(current + 1, true); return; }
  playing = false;
  ended = true;
  els.play.classList.remove("playing");
}

els.play.addEventListener("click", async () => {
  await ctx?.resume();
  setPlaying(!playing);
});
els.stop.addEventListener("click", () => {
  setPlaying(false);
  post({ type: "stop" });
  ended = false;
  if (lyricState) lyricState.cue = -2;
});
// IMPLAY's Home starts the song over and its End goes to the next one -- or,
// with only one, does what Home does.
function restartOrPrevious() {
  if (clock.position > 3 || current <= 0) seekTo(0);
  else playEntry(current - 1, playing);
}
function nextOrRestart() {
  if (current + 1 < playlist.length) playEntry(current + 1, playing);
  else seekTo(0);
}
els.prev.addEventListener("click", restartOrPrevious);
els.next.addEventListener("click", nextOrRestart);

/**
 * Rewind and fast-forward, IMPLAY's way: while the key is held a cursor walks
 * along the progress bar, and the song jumps there when it is let go. A tap is
 * a five-second step.
 */
const SCRUB_TAP_S = 5;
const SCRUB_TICK_MS = 60;
let scrub = null;
function startScrub(dir) {
  if (!song || scrub) return;
  const target = clamp(clock.position + dir * SCRUB_TAP_S, 0, song.duration);
  scrub = { dir, target, timer: setInterval(() => {
    // Crossing the whole bar takes about nine seconds, whatever the song's length.
    scrub.target = clamp(scrub.target + dir * song.duration / 150, 0, song.duration);
    showProgress(scrub.target);
  }, SCRUB_TICK_MS) };
  showProgress(target);
}
function endScrub() {
  if (!scrub) return;
  clearInterval(scrub.timer);
  const target = scrub.target;
  scrub = null;
  seekTo(target);
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
for (const [button, dir] of [[els.rew, -1], [els.ff, 1]]) {
  button.addEventListener("pointerdown", (e) => { if (e.button === 0) startScrub(dir); });
  for (const type of ["pointerup", "pointerleave", "pointercancel"]) {
    button.addEventListener(type, endScrub);
  }
  button.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); startScrub(dir); }
  });
  button.addEventListener("keyup", (e) => { if (e.key === "Enter" || e.key === " ") endScrub(); });
}

// ── the progress bar and clock ────────────────────────────────────────────

let dragging = false;
function showProgress(seconds) {
  els.clock.textContent = formatTime(seconds);
  if (song?.duration > 0) els.progress.value = String(Math.round(1000 * seconds / song.duration));
}
function updateClock() {
  if (dragging || scrub) return;
  showProgress(clock.position);
}
els.progress.addEventListener("input", () => {
  dragging = true;
  if (song) els.clock.textContent = formatTime(song.duration * els.progress.value / 1000);
});
els.progress.addEventListener("change", () => {
  dragging = false;
  if (song) seekTo(song.duration * els.progress.value / 1000);
});

els.gain.value = String(settings.volume);
els.gain.addEventListener("input", () => {
  settings.volume = Number(els.gain.value);
  saveSettings();
  post({ type: "volume", value: settings.volume / 100 });
});

// ── the four switches ─────────────────────────────────────────────────────

const switchButton = (set, value) =>
  document.querySelector(`.switch button[data-set="${set}"][data-value="${value}"]`);

function setSwitch(set, value, save = true) {
  settings[set] = value;
  for (const b of document.querySelectorAll(`.switch button[data-set="${set}"]`)) {
    b.setAttribute("aria-checked", String(b.dataset.value === value));
  }
  if (save) saveSettings();
}
function applySwitch(set) {
  switch (set) {
    case "tone": post({ type: "tone", value: settings.tone }); break;
    case "speaker": applySpeaker(); break;
    case "output": post({ type: "mono", value: settings.output === "mono" }); updateBadge(); break;
    case "loop": post({ type: "loop", value: settings.loop === "on" }); break;
    default: break;
  }
}
for (const b of document.querySelectorAll(".switch button")) {
  b.addEventListener("click", () => {
    setSwitch(b.dataset.set, b.dataset.value);
    applySwitch(b.dataset.set);
  });
}
for (const set of ["tone", "speaker", "output", "loop"]) {
  if (!switchButton(set, settings[set])) settings[set] = DEFAULTS[set];
  setSwitch(set, settings[set], false);
}

// ── keyboard: IMPLAY's keys where a browser lets us have them ─────────────

window.addEventListener("keydown", (e) => {
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  const target = e.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
  if (!song) return;
  const onButton = target instanceof HTMLButtonElement;
  switch (e.key) {
    case " ":
      if (onButton) return;              // Space presses a focused button
      e.preventDefault();
      ctx?.resume();
      setPlaying(!playing);
      break;
    case "z": case "Z": if (!e.repeat) startScrub(-1); break;
    case "x": case "X": if (!e.repeat) startScrub(1); break;
    case "Home": e.preventDefault(); seekTo(0); break;
    case "End": e.preventDefault(); nextOrRestart(); break;
    case ",": case "<": setSpeed(speedUnits - SPEED_STEP); break;
    case ".": case ">": setSpeed(speedUnits + SPEED_STEP); break;
    case "Insert": setKey(transpose + 1); break;
    case "Delete": setKey(transpose - 1); break;
    default: break;
  }
});
window.addEventListener("keyup", (e) => {
  if (e.key === "z" || e.key === "Z" || e.key === "x" || e.key === "X") endScrub();
});

// ── opening files ─────────────────────────────────────────────────────────

els.open.addEventListener("click", () => els.files.click());
els.files.addEventListener("change", () => {
  if (els.files.files.length) openFiles([...els.files.files]);
  els.files.value = "";
});

// The whole window takes a drop. A veil says so while something is dragged
// over it; `dragleave` fires on every child crossed, so the count decides
// when the drag has really left.
let dragDepth = 0;
const carriesFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes("Files");
window.addEventListener("dragenter", (e) => {
  if (!carriesFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  els.veil.hidden = false;
});
window.addEventListener("dragover", (e) => { if (carriesFiles(e)) e.preventDefault(); });
window.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) els.veil.hidden = true;
});
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  els.veil.hidden = true;
  const files = [...(e.dataTransfer?.files ?? [])];
  if (files.length) openFiles(files);
});

// ── lyrics ────────────────────────────────────────────────────────────────

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
  const line = els.lines.firstElementChild;
  const lineHeight = line ? line.offsetHeight : 0;
  els.lines.style.setProperty("--pad",
    `${Math.max(0, (els.view.clientHeight - lineHeight) / 2)}px`);
}

/**
 * Two cells or one, which is what ISS counts in.
 *
 * This was a table of East-Asian-Width ranges, and it was the wrong question.
 * These lines are not arbitrary Unicode -- they came out of `decodeJohab`, one
 * character per Johab code, and the DOS screen the records were written
 * against drew a one-byte code in one cell and a two-byte code in two.  Width
 * belongs to the *bytes*, and no two-byte code decodes below U+0080, so the
 * code point alone recovers it.
 *
 * The table called 470 assigned codes narrow: the KS X 1001 symbol rows below
 * U+2E80 (`·` `◁` `▒` `☆` `―`), and Greek and Cyrillic, which are East-Asian
 * *Ambiguous*.  It also caught the U+FFFD the library falls back to, which
 * stands in for a two-byte code and inherits its two cells.  Any of them on a
 * line dragged every later highlight left, in 567 of the 696 corpus files.
 *
 * Lines are laid out one cell span per character (see `buildLineCells`), each
 * pinned to 1ch or 2ch by this same test -- so `·` gets the two columns the
 * record names even where a browser's own font metrics would call it narrow.
 *
 * TWIN of `isWide` in iss-studio's `src/cells.js`.  Change one, change the
 * other, or the studio starts agreeing with a displayer that no longer exists.
 */
const isWide = (ch) => ch.codePointAt(0) >= 0x80;

/**
 * Split a line into one span per character, each classed `w1`/`w2` by
 * `isWide` so the DOS screen's fixed columns survive browser rendering.
 * Steps by code point: a surrogate pair is one character from one two-byte
 * Johab code, so it becomes one span, not two.
 */
function buildLineCells(text) {
  const cells = [];
  const frag = document.createDocumentFragment();
  for (let i = 0; i < text.length; i += text.codePointAt(i) > 0xffff ? 2 : 1) {
    const span = document.createElement("span");
    span.className = isWide(text[i]) ? "cell w2" : "cell w1";
    span.textContent = String.fromCodePoint(text.codePointAt(i));
    span.dataset.start = i;
    frag.appendChild(span);
    cells.push(span);
  }
  return { frag, cells };
}

/**
 * Map a cell offset to a character index within a line.
 *
 * Steps by code point, not by UTF-16 unit.  Two of Iyagi's own font glyphs
 * decode above the BMP -- the 하늘소 ox and the bubble -- and a surrogate pair
 * is one character from one two-byte code, so it is two cells, not four, and
 * an index may never land between its halves.
 */
function cellToIndex(text, cell) {
  let cells = 0;
  for (let i = 0; i < text.length; i += text.codePointAt(i) > 0xffff ? 2 : 1) {
    if (cells >= cell) return i;
    cells += isWide(text[i]) ? 2 : 1;
  }
  return text.length;
}

function setupLyrics(iss, tickBeat) {
  lyricState = null;
  els.lyricsUnit.classList.remove("has-lyrics");
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
    // An older tool's default: one phrase, "This is song text for IMP",
    // spread over the four fields.
    "This", "is song", "text", "for IMP",
  ]);
  // A few old files keep a picture's file name in the writer field.
  const isPlaceholder = (v) => PLACEHOLDER_CREDITS.has(v) || /\.PCX$/i.test(v);
  const credits = [
    ["작사", iss.writer], ["작곡", iss.composer],
    ["노래", iss.singer], ["제작", iss.editor],
  ].filter(([, v]) => v && v.trim() && !isPlaceholder(v.trim()));
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
    const { frag, cells } = buildLineCells(text || " ");
    div.append(frag);
    div.cells = cells;
    return div;
  });
  els.lines.replaceChildren(...nodes);
  lyricState = { iss, nodes, tickBeat, cue: -1, spans: resolveIssSpans(iss) };
  els.lyricsUnit.classList.add("has-lyrics");
  // Lay out first, then park on the opening line: before the first cue there
  // is nothing "current", and a lyric sitting at the top of the window reads
  // as broken rather than as not-started-yet.
  requestAnimationFrame(() => {
    sizeLyricPadding();
    setFollowing(true);
    centreLine(nodes[0]);
  });
}

function clearLyricMarks() {
  for (const n of lyricState.nodes) {
    if (n.classList.contains("on")) for (const cell of n.cells) cell.classList.remove("mark");
    n.classList.remove("on", "near");
  }
}

/** `tick` is the worklet's `lyricTick`: the cues' own unit, not the song's. */
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
  clearLyricMarks();
  // Back before the first cue -- a seek to the start -- is the not-started
  // state again, parked on the opening line.
  if (index < 0) { if (following) centreLine(nodes[0]); return; }
  const span = lyricState.spans[index];
  const line = nodes[span.line];
  if (!line) return;

  line.classList.add("on");
  // The neighbours stay legible but recede, which is what makes the middle
  // read as "now" without needing any other marker.
  for (const offset of [-2, -1, 1, 2]) nodes[span.line + offset]?.classList.add("near");

  // The span already accounts for everything lit so far on this line, as
  // runs of cells with gaps where no record painted (FILE_FORMATS §4.2);
  // convert each run's cell columns to character indices, then mark the cells
  // (built by `buildLineCells`, each tagged with its own start index) that
  // fall in any of them.
  const text = iss.lines[span.line] ?? "";
  const runs = span.runs.map(([a, b]) => [cellToIndex(text, a), cellToIndex(text, b)]);
  for (const cell of line.cells) {
    const start = Number(cell.dataset.start);
    cell.classList.toggle("mark", runs.some(([from, to]) => start >= from && start < to));
  }
  if (following) centreLine(line);
}

/** Scroll so `line` sits in the middle of the window. */
function centreLine(line) {
  if (!line) return;
  const target = line.offsetTop + line.offsetHeight / 2 - els.view.clientHeight / 2;
  els.view.scrollTo({ top: Math.max(0, target), behavior: reduceMotion ? "auto" : "smooth" });
}

for (const type of ["wheel", "touchmove", "pointerdown"]) {
  els.view.addEventListener(type, () => setFollowing(false), { passive: true });
}
els.view.addEventListener("keydown", (e) => {
  if (/^(Arrow|Page|Home|End)/.test(e.key)) { e.stopPropagation(); setFollowing(false); }
});
els.follow.addEventListener("click", () => setFollowing(true));
window.addEventListener("resize", () => {
  sizeLyricPadding();
  if (following) centreLine(activeLineNode() ?? lyricState?.nodes[0]);
});

// Something to look at before anything is open: an empty voice list.
els.channels.innerHTML = '<p class="placeholder">곡을 열면 성부마다 쓰는 악기가 여기 나옵니다</p>';


// ── "remix this in Microtone" ─────────────────────────────────────────────
//
// Microtone (microtone.cc) is a tracker that runs in the browser and imports
// every format this page plays. Sending the listener off with a download would
// mean saving a file, finding it, and dropping it back in -- and for an .ims or
// a .rol, doing that TWICE, because a song without its instrument bank makes no
// sound. So the song travels in the link: gzipped, base64url, in the URL
// FRAGMENT, which no server ever sees and no cross-origin policy can get in the
// way of. Across the whole reference corpus that is a median 9.5 kB of URL and
// a worst case of 52 kB.
//
// A .sop travels alone: it carries its own instruments (SOP §3), so there is no
// second file to pair up. Its songs are much bigger on disk -- up to 512 kB
// against an .ims's tens of kB -- but they are an event stream of mostly
// repeated bytes and gzip eats them, so the URL is a median 6.1 kB and a worst
// case of 33 kB across the 336 reference files: SMALLER than the .ims case,
// where the bank travels too. Nothing here comes near the ceiling below.
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

/**
 * The name the song travels under.
 *
 * Microtone chooses its converter from the EXTENSION, and this corpus is full
 * of files whose names lie -- `intake` sorted the drop by what the bytes say,
 * so the detected kind is what the other end has to be told, not whatever the
 * file happened to be called.
 */
function handoffName(song) {
  const stem = (song.name || "song").replace(/\.[^.]*$/, "");
  return song.kind ? `${stem}.${song.kind}` : stem;
}

async function handoffUrl(song) {
  const parts = [];
  handoffField(parts, handoffName(song), song.song);
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
