// Speech gate (pet/ui/speech-gate.js) with synthetic 16 kHz audio, run through the capture worklet's level math:
// the RMS of each 40 ms chunk and the RMS below ~900 Hz (two one-pole low-passes), as in pet/ui/audio-worklets.js.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createSpeechGate } from "../pet/ui/speech-gate.js";

const RATE = 16000;
const CHUNK = 640;
let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;

function levels(samples) {
  const a = 1 - Math.exp((-2 * Math.PI * 900) / RATE);
  let l1 = 0;
  let l2 = 0;
  const out = [];
  for (let c = 0; c + CHUNK <= samples.length; c += CHUNK) {
    let sum = 0;
    let low = 0;
    for (let i = c; i < c + CHUNK; i++) {
      const s = samples[i];
      sum += s * s;
      l1 += a * (s - l1);
      l2 += a * (l1 - l2);
      low += l2 * l2;
    }
    out.push({ level: Math.sqrt(sum / CHUNK), low: Math.sqrt(low / CHUNK) });
  }
  return out;
}
const seconds = (s) => Math.round(s * RATE);
const noise = (n, rms) => Array.from({ length: n }, () => rand() * rms * Math.sqrt(3));
/** Harmonics with falling amplitude (formant-ish) and ~4 Hz syllables. */
function voice(n, rms, f0 = 150) {
  const out = new Array(n);
  let norm = 0;
  for (let h = 1; h * f0 < 3500; h++) norm += (1 / h) ** 2;
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    let v = 0;
    for (let h = 1; h * f0 < 3500; h++) v += Math.sin(2 * Math.PI * h * f0 * t) / h;
    out[i] = (v / Math.sqrt(norm / 2)) * rms * (0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t));
  }
  return out;
}
/** 5 ms clicks, ~9 per second, on a quiet room. */
function typing(n, rms, perSecond = 9) {
  const out = noise(n, 0.003);
  for (let k = 0; k < (n / RATE) * perSecond; k++) {
    const at = Math.floor(Math.abs(rand()) * (n - 200));
    for (let i = 0; i < 80; i++) out[at + i] += rand() * rms * Math.exp(-i / 20);
  }
  return out;
}
const mix = (...parts) => parts.flat();

function run(samples, filter, { silenceMs = 700, petSpeaking = false } = {}) {
  const gate = createSpeechGate();
  const opens = [];
  let sent = 0;
  levels(samples).forEach(({ level, low }, i) => {
    const r = gate.push({ pcm: i, level, low, now: i * 40, filter, silenceMs, petSpeaking });
    if (r.send.length && !opens.some((e) => e.closed === undefined)) opens.push({ at: i * 40, preroll: r.send.length });
    if (r.ended) opens.at(-1).closed = i * 40;
    sent += r.send.length;
  });
  return { opens, sentMs: sent * 40 };
}

for (const filter of ["standard", "strong"]) {
  test(`${filter}: a quiet room never opens the gate`, () => {
    assert.equal(run(noise(seconds(6), 0.003), filter).opens.length, 0);
  });
  test(`${filter}: typing does not open the gate`, () => {
    assert.equal(run(typing(seconds(8), 0.25), filter).opens.length, 0);
  });
  test(`${filter}: a fan turning on does not open the gate`, () => {
    assert.equal(run(mix(noise(seconds(2), 0.003), noise(seconds(8), 0.03)), filter).opens.length, 0);
  });
  test(`${filter}: speech opens within 300 ms, with pre-roll, and closes after the end-of-turn pause`, () => {
    const r = run(mix(noise(seconds(2), 0.003), voice(seconds(1.5), 0.08).map((v) => v + rand() * 0.003), noise(seconds(3), 0.003)), filter);
    assert.equal(r.opens.length, 1);
    const [open] = r.opens;
    assert.ok(open.at >= 2000 && open.at <= 2300, `opened at ${open.at} ms`);
    assert.ok(open.preroll >= 5, `pre-roll ${open.preroll} chunks`);
    assert.ok(open.closed >= 3500 + 700 && open.closed <= 3500 + 1600, `closed at ${open.closed} ms`);
  });
  test(`${filter}: speech over a loud fan still opens`, () => {
    const loud = filter === "strong" ? 0.15 : 0.1; // strong asks for a clearly raised voice
    const r = run(mix(noise(seconds(3), 0.02), voice(seconds(1.5), loud).map((v) => v + rand() * 0.02), noise(seconds(2), 0.02)), filter);
    assert.equal(r.opens.length, 1);
  });
}

test("standard: soft speech (RMS 0.025) opens", () => {
  assert.equal(run(mix(noise(seconds(2), 0.003), voice(seconds(1.5), 0.025), noise(seconds(2), 0.003)), "standard").opens.length, 1);
});
test("strong: a faint distant voice (RMS 0.012) is ignored", () => {
  assert.equal(run(mix(noise(seconds(2), 0.003), voice(seconds(1.5), 0.012), noise(seconds(2), 0.003)), "strong").opens.length, 0);
});
test("light: everything is sent, as before the gate existed", () => {
  assert.equal(run(noise(seconds(2), 0.003), "light").sentMs, 2000);
});
test("standard: a faint echo of the pet does not open, talking over it does (barge-in)", () => {
  const echo = run(mix(noise(seconds(2), 0.003), voice(seconds(1), 0.015, 220), noise(seconds(1), 0.003)), "standard", { petSpeaking: true });
  assert.equal(echo.opens.length, 0);
  const bargeIn = run(mix(noise(seconds(2), 0.003), voice(seconds(1), 0.08), noise(seconds(1), 0.003)), "standard", { petSpeaking: true });
  assert.equal(bargeIn.opens.length, 1);
});
test("reset() forgets the room and an open gate", () => {
  const gate = createSpeechGate();
  levels(mix(noise(seconds(1), 0.003), voice(seconds(0.5), 0.08))).forEach(({ level, low }, i) =>
    gate.push({ pcm: i, level, low, now: i * 40, filter: "standard", silenceMs: 700, petSpeaking: false }),
  );
  assert.equal(gate.open, true);
  gate.reset();
  assert.equal(gate.open, false);
});
