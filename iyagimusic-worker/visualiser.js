// The chip's own status, drawn as one moving column per voice.
//
// A twenty-band spectrum analyser would be a costume here. Nothing in this
// player ever computes a spectrum -- the chip hands over its output and
// nothing else -- so a row of bands would be a picture of an FFT we would have
// to invent, of a chip that has voices rather than bands. What the chip does
// know is what each voice is doing, so that is what these columns show: how
// loud the voice actually came out, how hard its modulator is driving it, what
// note it is holding, and -- on an OPL3 -- which way it is panned.
//
// The column count comes from the worklet rather than from a constant here,
// because it is 9, 11, 18 or 20 depending on the chip and the mode. Only one
// rule is assumed, and the chip guarantees it: **the five rhythm voices are
// always the last five columns.**

import {
  METER_STRIDE, M_PEAK, M_MOD_DB, M_NOTE, M_KEY_ON, M_STATE, M_VOLUME, M_TIMBRE,
  M_PAN, PAN_LEFT, PAN_RIGHT, PAN_CENTRE,
  T_CAR_WAVE, T_MOD_WAVE, T_ADDITIVE, T_FEEDBACK, T_FOUROP, T_CONN2, T_WAVE_MASK,
  RHYTHM_VOICES,
  CF_RHYTHM, CF_TREMOLO, CF_VIBRATO, CF_WAVESEL, CF_OPL3, CF_FOUROP,
} from "./lib/player.js";

/**
 * Full scale for the level bars. One operator at full amplitude comes out at
 * about 0.5 on the chip's mix bus (see the scaling note in opl/chip.js), so a
 * voice reaching the top of its bar is a voice as loud as the chip gets.
 */
const FULL_SCALE = 0.5;
/** How much of the chip's range the bars cover. 96 dB would be mostly floor. */
const RANGE_DB = 48;

/** Meter ballistics: fast to rise, unhurried to fall, with a peak that hangs. */
const FALL_DB_PER_S = 42;
const CAP_HOLD_MS = 620;
const CAP_FALL_DB_PER_S = 16;

/** Voice names in rhythm mode, where the last five voices are drums. §6. */
const DRUM_NAMES = ["BD", "SD", "TOM", "TC", "HH"];
const DRUM_TITLES = ["베이스 드럼", "스네어 드럼", "톰톰", "탑 심벌", "하이햇"];

const NOTE_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
/**
 * The eight waveforms, in register order: 0xE0 selects between these. The
 * first four are the OPL2's; the last four need an OPL3 with NEW set, so on a
 * YM3812 only the first four ever appear.
 */
const WAVE_NAMES = ["사인", "반파", "전파", "펄스", "배속 사인", "배속 전파", "사각", "톱니"];
const EG_NAMES = ["꺼짐", "어택", "디케이", "서스테인", "릴리스"];
/** §11: the 0xC0 stereo switches, which are enables rather than a pan knob. */
const PAN_NAMES = { [PAN_LEFT]: "왼쪽", [PAN_RIGHT]: "오른쪽", [PAN_CENTRE]: "가운데" };
/** §10: the four-operator connections, by the two channels' CNT bits. */
const FOUROP_NAMES = [
  "1→2→3→4", "1→2→3, 4", "1, 2→3→4", "1, 2→3, 4",
];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** An amplitude as a fraction of the bar, on a decibel scale. */
function levelOf(peak) {
  if (!(peak > 0)) return 0;
  return clamp01(1 + (20 * Math.log10(peak / FULL_SCALE)) / RANGE_DB);
}

/** An attenuation in dB as a fraction of the bar. Negative means "no such". */
function attenuationLevel(db) {
  if (db < 0) return 0;
  return clamp01(1 - db / RANGE_DB);
}

function noteName(midi) {
  if (!(midi >= 0)) return "—";
  const n = Math.round(midi);
  return NOTE_NAMES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * @param {HTMLElement} root  the container the columns are drawn into
 * @param {HTMLElement} flags the container for the chip-wide status chips
 */
export function createVisualiser(root, flags) {
  /** @type {Array<object>} one entry per drawn column */
  let columns = [];
  let voices = 0;
  let rhythm = false;

  let meter = null;                 // the last snapshot from the worklet
  let meterAt = 0;                  // when it arrived, for idling out
  let patchNames = [];
  let chipFlags = 0;
  let running = false;
  let active = true;                // false while the panel is collapsed
  let lastFrame = 0;

  const chips = {
    chip: el("span", "chip lit"),
    mode: el("span", "chip lit"),
    tremolo: el("span", "chip", "트레몰로"),
    vibrato: el("span", "chip", "비브라토"),
    wave: el("span", "chip", "파형 선택"),
    fourOp: el("span", "chip", "4연산자"),
  };
  chips.fourOp.hidden = true;
  flags.replaceChildren(chips.chip, chips.mode, chips.tremolo, chips.vibrato,
    chips.wave, chips.fourOp);

  /** The row the drums start on: the chip puts them last, whatever it is. */
  function drumBase(count, isRhythm) {
    return isRhythm ? count - RHYTHM_VOICES : count;
  }

  function buildColumns(count, isRhythm) {
    voices = count;
    rhythm = isRhythm;
    columns = [];
    const made = [];
    const drums = drumBase(count, isRhythm);
    for (let v = 0; v < count; v++) {
      const drum = v >= drums;
      const column = el("div", "ch idle");
      const bars = el("div", "ch-bars");
      const out = el("span", "bar out");
      const outFill = el("i", "fill");
      const cap = el("i", "cap");
      out.append(outFill, cap);
      const mod = el("span", "bar mod");
      const modFill = el("i", "fill");
      mod.append(modFill);
      bars.append(out, mod);
      const name = el("span", "ch-name", drum ? DRUM_NAMES[v - drums] : String(v + 1));
      // The detail is written when the pointer arrives rather than every
      // frame: half of it -- volume, envelope phase -- moves with the music.
      column.addEventListener("pointerenter", () => {
        if (meter) column.title = tooltip(v);
      });
      const note = el("span", "ch-note", "—");
      const patch = el("span", "ch-patch", "—");
      // The pan markers sit either side of the name, on the side the sound
      // actually goes to, so that a glance down the row reads as a stereo
      // picture rather than as a column of symbols to decode. They are only
      // lit when a voice is panned; a centred voice shows neither. Both stay
      // in the layout while unlit (the CSS hides them with `visibility`), so
      // the lit name does not jump sideways when the panning moves.
      const panLeft = el("span", "ch-pan left", "◄");
      const panRight = el("span", "ch-pan right", "►");
      const label = el("span", "ch-label");
      label.append(panLeft, name, panRight);
      column.append(bars, label, note, patch);
      made.push(column);
      columns.push({
        column, outFill, cap, modFill, note, patch, panLeft, panRight, drum,
        level: 0, capLevel: 0, capAt: 0, shownLevel: -1, shownCap: -1, shownMod: -1,
        shownNote: "—", shownPatch: "—", shownPan: -1, keyOn: false, used: false,
      });
    }
    root.replaceChildren(...made);
  }

  /** Everything the column knows, for readers who want the register-level truth. */
  function tooltip(index) {
    const row = meter.subarray(index * METER_STRIDE, (index + 1) * METER_STRIDE);
    const timbre = row[M_TIMBRE] | 0;
    const carWave = (timbre >> T_CAR_WAVE) & T_WAVE_MASK;
    const modWave = (timbre >> T_MOD_WAVE) & T_WAVE_MASK;
    const additive = (timbre >> T_ADDITIVE) & 1;
    const feedback = (timbre >> T_FEEDBACK) & 7;
    const fourOp = (timbre >> T_FOUROP) & 1;
    const conn2 = (timbre >> T_CONN2) & 1;
    const single = row[M_MOD_DB] < 0;
    const drums = drumBase(voices, rhythm);
    const head = index >= drums
      ? `${DRUM_NAMES[index - drums]} — ${DRUM_TITLES[index - drums]}`
      : `${index + 1}번 성부${fourOp ? " (4연산자)" : ""}`;
    const lines = [
      head,
      `음색  ${patchNames[index] || "—"}`,
      `음량  ${row[M_VOLUME] | 0}/127`,
      `포락선  ${EG_NAMES[row[M_STATE] | 0] ?? "—"}`,
      single
        ? `파형  ${WAVE_NAMES[carWave]} (연산자 1개)`
        : `파형  변조기 ${WAVE_NAMES[modWave]} → 반송파 ${WAVE_NAMES[carWave]}`,
    ];
    if (fourOp) {
      lines.push(`결합  ${FOUROP_NAMES[(additive << 1) | conn2]}, 되먹임 ${feedback}`);
    } else if (!single) {
      lines.push(`결합  ${additive ? "가산 (AM)" : "변조 (FM)"}, 되먹임 ${feedback}`);
    }
    if (chipFlags & CF_OPL3) {
      lines.push(`정위  ${PAN_NAMES[row[M_PAN] | 0] ?? "없음"}`);
    }
    return lines.join("\n");
  }

  function draw(now) {
    if (!active) { running = false; return; }
    const dt = Math.min(0.25, (now - lastFrame) / 1000);
    lastFrame = now;
    const fall = (FALL_DB_PER_S / RANGE_DB) * dt;
    const capFall = (CAP_FALL_DB_PER_S / RANGE_DB) * dt;
    // A snapshot older than a few frames means the worklet has stopped
    // sending -- paused, or between songs -- so let everything sink to rest.
    const fresh = meter && now - meterAt < 200;
    let moving = false;

    for (let v = 0; v < columns.length; v++) {
      const c = columns[v];
      const o = v * METER_STRIDE;
      const target = fresh ? levelOf(meter[o + M_PEAK]) : 0;
      c.level = Math.max(target, c.level - fall);
      if (c.level >= c.capLevel) { c.capLevel = c.level; c.capAt = now; }
      else if (now - c.capAt > CAP_HOLD_MS) {
        c.capLevel = Math.max(c.level, c.capLevel - capFall);
      }
      if (c.level > 0.001 || c.capLevel > 0.001) moving = true;

      if (Math.abs(c.level - c.shownLevel) > 0.002) {
        c.shownLevel = c.level;
        c.outFill.style.setProperty("--v", c.level.toFixed(3));
      }
      if (Math.abs(c.capLevel - c.shownCap) > 0.002) {
        c.shownCap = c.capLevel;
        c.cap.style.setProperty("--v", c.capLevel.toFixed(3));
      }
      const mod = fresh ? attenuationLevel(meter[o + M_MOD_DB]) : 0;
      if (Math.abs(mod - c.shownMod) > 0.002) {
        c.shownMod = mod;
        c.modFill.style.setProperty("--v", mod.toFixed(3));
      }

      const keyOn = fresh && meter[o + M_KEY_ON] > 0;
      if (keyOn !== c.keyOn) {
        c.keyOn = keyOn;
        c.column.classList.toggle("on", keyOn);
      }
      // Plenty of songs never touch some of their voices -- a rhythm song
      // with no hi-hat still has a hi-hat voice -- and a column that has
      // never moved should read as unused rather than as broken.
      if (keyOn && !c.used) { c.used = true; c.column.classList.remove("idle"); }
      // The F-number stands until the voice is given another note, so the
      // column keeps showing what it last played and dims instead of
      // blanking. A dash means this voice has never had a pitch at all --
      // an untouched voice, or one of the three drums that are not tonal.
      if (fresh) {
        const note = noteName(meter[o + M_NOTE]);
        if (note !== c.shownNote) { c.shownNote = note; c.note.textContent = note; }
        // The stereo switches move a handful of times a song at most, so this
        // costs nothing and saves a reader guessing why one side is louder.
        const pan = meter[o + M_PAN] | 0;
        if (pan !== c.shownPan) {
          c.shownPan = pan;
          c.panLeft.classList.toggle("lit", pan === PAN_LEFT);
          c.panRight.classList.toggle("lit", pan === PAN_RIGHT);
        }
      }
    }
    if (!fresh && !moving) { running = false; return; }
    requestAnimationFrame(draw);
  }

  function run() {
    if (running || !active) return;
    running = true;
    lastFrame = performance.now();
    requestAnimationFrame(draw);
  }

  /** Text that changes a handful of times a song, updated only when it does. */
  function refreshLabels() {
    for (let v = 0; v < columns.length; v++) {
      const c = columns[v];
      const name = patchNames[v] || "—";
      if (name !== c.shownPatch) {
        c.shownPatch = name;
        c.patch.textContent = name;
      }
    }
  }

  function refreshChips() {
    const opl3 = (chipFlags & CF_OPL3) !== 0;
    chips.chip.textContent = opl3 ? "OPL3 (YMF262)" : "OPL2 (YM3812)";
    chips.mode.textContent = rhythm
      ? `리듬 ${voices - RHYTHM_VOICES}+${RHYTHM_VOICES}성부`
      : `멜로디 ${voices}성부`;
    chips.tremolo.classList.toggle("lit", (chipFlags & CF_TREMOLO) !== 0);
    chips.vibrato.classList.toggle("lit", (chipFlags & CF_VIBRATO) !== 0);
    // On an OPL3 the wave-select switch is gone: all eight waveforms are
    // always reachable, so the chip stays lit rather than reporting 0x01.
    chips.wave.classList.toggle("lit", opl3 || (chipFlags & CF_WAVESEL) !== 0);
    chips.fourOp.hidden = !opl3;
    chips.fourOp.classList.toggle("lit", (chipFlags & CF_FOUROP) !== 0);
  }

  return {
    /** Take one frame of chip status from the worklet. */
    push(msg) {
      const wanted = msg.voices | 0;
      const isRhythm = (msg.chipFlags & CF_RHYTHM) !== 0;
      meter = msg.meter;
      meterAt = performance.now();
      const rebuilt = wanted !== voices || isRhythm !== rhythm;
      if (rebuilt) buildColumns(wanted, isRhythm);
      if (msg.chipFlags !== chipFlags || rebuilt) {
        chipFlags = msg.chipFlags;
        refreshChips();
      }
      if (msg.patchNames || rebuilt) {
        if (msg.patchNames) patchNames = msg.patchNames;
        refreshLabels();
      }
      run();
    },

    /** Collapsed panels stop animating; there is nothing to look at. */
    setActive(on) {
      active = on;
      if (on) run();
    },

    /** Forget the song: empty columns, everything at rest. */
    clear() {
      meter = null;
      patchNames = [];
      voices = 0;
      root.replaceChildren();
      columns = [];
    },
  };
}
