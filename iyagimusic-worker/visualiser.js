// The display unit's level meter: one LED column per voice, and under each a
// lamp that is lit while the voice holds a note.
//
// It looks like IMPLAY's spectrum display and is not one. IMPLAY's bars were
// not a spectrum either -- they were each channel's note velocity, decaying --
// and a twenty-band analyser here would be a picture of an FFT we would have
// to invent, of a chip that has voices rather than bands. These columns are
// each voice's real output level, read off the chip by the worklet.
//
// The column count comes from the worklet rather than from a constant here,
// because it is 9, 11, 18 or 20 depending on the chip and the mode. Only one
// rule is assumed, and the chip guarantees it: **the five rhythm voices are
// always the last five columns.**
//
// Drawn on a canvas because it redraws every frame: twenty columns of DOM
// nodes restyled at 60 Hz costs more than painting them.

import {
  METER_STRIDE, M_PEAK, M_KEY_ON, RHYTHM_VOICES,
  CF_RHYTHM, CF_TREMOLO, CF_VIBRATO, CF_OPL3, CF_FOUROP,
} from "./lib/player.js";

/**
 * Full scale for the columns. One operator at full amplitude comes out at
 * about 0.5 on the chip's mix bus (see the scaling note in opl/chip.js), so a
 * voice reaching the top is a voice as loud as the chip gets.
 */
const FULL_SCALE = 0.5;
/** How much of the chip's range the columns cover. 96 dB would be mostly floor. */
const RANGE_DB = 48;
/** LED rungs per column. */
const RUNGS = 16;

/** Meter ballistics: fast to rise, unhurried to fall, with a peak that hangs. */
const FALL_DB_PER_S = 42;
const CAP_HOLD_MS = 620;
const CAP_FALL_DB_PER_S = 16;

/** Column labels in rhythm mode, where the last five voices are drums. */
const DRUM_NAMES = ["BD", "SD", "TT", "TC", "HH"];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** An amplitude as a fraction of the column, on a decibel scale. */
function levelOf(peak) {
  if (!(peak > 0)) return 0;
  return clamp01(1 + (20 * Math.log10(peak / FULL_SCALE)) / RANGE_DB);
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {HTMLElement} chipline one line of text naming the chip and its mode
 */
export function createVisualiser(canvas, chipline) {
  const g = canvas.getContext("2d");
  let columns = [];
  let voices = 0;
  let rhythm = false;
  let meter = null;
  let meterAt = 0;
  let running = false;
  let lastFrame = 0;
  let width = 0, height = 0, dpr = 1;
  let label = "";
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  /** The palette, from the stylesheet's own tokens. */
  let colour = {};
  function readColours() {
    const css = getComputedStyle(document.documentElement);
    const v = (name) => css.getPropertyValue(name).trim();
    colour = {
      low: v("--accent"), mid: v("--accent-2"), high: v("--hot"),
      unlit: v("--unlit"), cap: v("--ink"), text: v("--recede"), drum: v("--accent-2"),
    };
  }
  readColours();

  function resize() {
    dpr = window.devicePixelRatio || 1;
    const box = canvas.getBoundingClientRect();
    width = Math.max(1, Math.round(box.width));
    height = Math.max(1, Math.round(box.height));
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    paint();
  }
  new ResizeObserver(resize).observe(canvas);

  function build(count, isRhythm) {
    voices = count;
    rhythm = isRhythm;
    columns = Array.from({ length: count }, () => ({
      level: 0, cap: 0, capAt: 0, on: false,
    }));
  }

  /** The rung a level fraction lights up to; 0 is none. */
  const rungsOf = (level) => Math.round(level * RUNGS);

  function paint() {
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, height);
    const n = columns.length || 11;
    const pad = 8, labelH = 13, lampH = 5, gapY = 4;
    const top = pad, bottom = height - pad - labelH - lampH - gapY * 2;
    const slot = (width - pad * 2) / n;
    const colW = Math.max(3, Math.min(22, slot * 0.62));
    const rungH = (bottom - top) / RUNGS;
    const drums = rhythm ? voices - RHYTHM_VOICES : voices;
    g.font = `${Math.min(10, Math.max(7, slot * 0.36))}px ui-monospace, monospace`;
    g.textAlign = "center";
    g.textBaseline = "alphabetic";

    for (let v = 0; v < n; v++) {
      const c = columns[v] ?? { level: 0, cap: 0, on: false };
      const x = pad + slot * v + (slot - colW) / 2;
      const lit = rungsOf(c.level);
      const capRung = rungsOf(c.cap);
      for (let r = 0; r < RUNGS; r++) {
        const y = bottom - (r + 1) * rungH;
        const on = r < lit;
        g.fillStyle = on
          ? (r >= RUNGS - 2 ? colour.high : r >= RUNGS * 0.62 ? colour.mid : colour.low)
          : colour.unlit;
        g.fillRect(x, y + 1, colW, Math.max(1, rungH - 2));
      }
      if (capRung > 0 && capRung > lit) {
        g.fillStyle = colour.cap;
        g.globalAlpha = 0.8;
        g.fillRect(x, bottom - capRung * rungH + 1, colW, Math.max(1, Math.min(2, rungH - 2)));
        g.globalAlpha = 1;
      }
      // The lamp: IMPLAY's row of squares under its bars, lit on a key-on.
      const drum = columns.length && v >= drums;
      const lampY = bottom + gapY;
      g.fillStyle = c.on ? (drum ? colour.drum : colour.low) : colour.unlit;
      g.fillRect(x, lampY, colW, lampH);
      g.fillStyle = colour.text;
      const name = columns.length ? (drum ? DRUM_NAMES[v - drums] : String(v + 1)) : "";
      g.fillText(name, x + colW / 2, height - pad);
    }
  }

  function frame(now) {
    const dt = Math.min(0.25, (now - lastFrame) / 1000);
    // Less motion, not none: the meter is information, but it can say it at
    // a quarter of the rate.
    if (reduceMotion && dt < 1 / 15) { requestAnimationFrame(frame); return; }
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
      if (c.level >= c.cap) { c.cap = c.level; c.capAt = now; }
      else if (now - c.capAt > CAP_HOLD_MS) c.cap = Math.max(c.level, c.cap - capFall);
      c.on = fresh && meter[o + M_KEY_ON] > 0;
      if (c.level > 0.001 || c.cap > 0.001 || c.on) moving = true;
    }
    paint();
    if (!fresh && !moving) { running = false; return; }
    requestAnimationFrame(frame);
  }

  function run() {
    if (running) return;
    running = true;
    lastFrame = performance.now();
    requestAnimationFrame(frame);
  }

  function describe(flags, extra) {
    const parts = [(flags & CF_OPL3) ? "YMF262 (OPL3)" : "YM3812 (OPL2)"];
    if (extra) parts.push(extra);
    parts.push(rhythm ? `리듬 ${voices - RHYTHM_VOICES}+${RHYTHM_VOICES}성부` : `${voices}성부`);
    if (flags & CF_FOUROP) parts.push("4연산자");
    if (flags & CF_TREMOLO) parts.push("트레몰로");
    if (flags & CF_VIBRATO) parts.push("비브라토");
    return parts.join(" · ");
  }

  return {
    /** Take one frame of chip status from the worklet. */
    push(msg) {
      const isRhythm = (msg.chipFlags & CF_RHYTHM) !== 0;
      if ((msg.voices | 0) !== voices || isRhythm !== rhythm) build(msg.voices | 0, isRhythm);
      meter = msg.meter;
      meterAt = performance.now();
      const text = describe(msg.chipFlags, this.mode);
      if (text !== label) { label = text; chipline.textContent = text; }
      run();
    },
    /** A word about how the chip is being driven, e.g. IMPLAY's stereo. */
    mode: "",
    /** Forget the song: no columns, everything at rest. */
    clear() {
      meter = null;
      voices = 0;
      columns = [];
      label = "";
      chipline.textContent = "—";
      paint();
    },
  };
}
