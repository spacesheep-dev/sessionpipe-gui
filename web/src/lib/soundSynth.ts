// SPDX-License-Identifier: Apache-2.0
// Owned by: web. The five built-in notification sounds, synthesised with WebAudio. Split
// from sounds.ts so the first load carries none of it: it arrives with the first sound.
import type { BuiltinSound } from "./sounds";

interface Tone {
  type?: OscillatorType;
  /** Peak gain, 0–1. */
  peak?: number;
  /** Seconds to the peak: never zero, so no click. */
  attack?: number;
  /** A glide to this frequency over the tone. */
  to?: number;
}

/** Plays one built-in sound: every one under 400 ms, a soft onset, a natural decay. */
export function synth(c: AudioContext, id: BuiltinSound, volume: number): void {
  const t0 = c.currentTime + 0.01;
  const master = c.createGain();
  master.gain.setValueAtTime(volume, t0);
  master.connect(c.destination);
  const tone = (freq: number, start: number, dur: number, o: Tone = {}) => {
    const osc = c.createOscillator();
    osc.type = o.type ?? "sine";
    osc.frequency.setValueAtTime(freq, start);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, start + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, start);
    g.gain.linearRampToValueAtTime(o.peak ?? 0.5, start + (o.attack ?? 0.012));
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(g);
    g.connect(master);
    osc.start(start);
    osc.stop(start + dur + 0.02);
  };
  switch (id) {
    case "chime": // A5 then D6, overlapping: 0.38 s
      tone(880, t0, 0.22, { peak: 0.45 });
      tone(1174.66, t0 + 0.14, 0.24, { peak: 0.4 });
      break;
    case "tick": // one short, bright triangle: 0.07 s
      tone(1760, t0, 0.07, { type: "triangle", peak: 0.3, attack: 0.004 });
      break;
    case "thud": // a sine dropping an octave and a half: 0.3 s
      tone(150, t0, 0.3, { peak: 0.9, attack: 0.008, to: 50 });
      break;
    case "blip": // a triangle rising an octave: 0.18 s
      tone(523.25, t0, 0.18, { type: "triangle", peak: 0.35, to: 1046.5 });
      break;
    case "marimba": // a fundamental with two fading partials: 0.3 s
      tone(659.25, t0, 0.3, { peak: 0.5, attack: 0.004 });
      tone(1318.5, t0, 0.12, { peak: 0.14, attack: 0.004 });
      tone(2637, t0, 0.06, { peak: 0.05, attack: 0.004 });
      break;
  }
}
