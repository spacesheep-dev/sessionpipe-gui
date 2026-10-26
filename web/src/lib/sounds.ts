// SPDX-License-Identifier: Apache-2.0
// Owned by: web. Notification sounds: one per kind of moment (a prompt needs you, a
// question, an error, something delivered), each one of five short WebAudio-synthesised
// sounds or the file you uploaded. The choices, the master switch and the volume live in
// localStorage; the uploaded file lives in IndexedDB on this device (≤ 500 KB, as a data
// URL). Browsers keep audio muted until a gesture has reached the AudioContext, so
// `unlocked` says whether anything can be heard yet. Played by the toasts (lib/toasts.ts)
// for the same moments they show.
import { useSyncExternalStore } from "react";
import { whenIdle } from "./lazy";

export type SoundKind = "needsYou" | "question" | "error" | "done";
export const SOUND_KINDS: { kind: SoundKind; label: string; hint: string }[] = [
  { kind: "needsYou", label: "Needs you", hint: "a permission prompt waits for an answer" },
  { kind: "question", label: "Question", hint: "a question, input wanted, an idle prompt" },
  { kind: "error", label: "Error", hint: "a turn ended with an error" },
  { kind: "done", label: "Done", hint: "a message you sent came back delivered" },
];

export type BuiltinSound = "chime" | "tick" | "thud" | "blip" | "marimba";
export const BUILTIN_SOUNDS: { id: BuiltinSound; label: string }[] = [
  { id: "chime", label: "Two-note chime" },
  { id: "tick", label: "Soft tick" },
  { id: "thud", label: "Low thud" },
  { id: "blip", label: "Rising blip" },
  { id: "marimba", label: "Marimba tap" },
];
const BUILTIN_IDS = new Set<string>(BUILTIN_SOUNDS.map((s) => s.id));

/** A built-in sound, or the uploaded file. */
export type SoundChoice = BuiltinSound | "custom";

export interface SoundSettings {
  on: boolean;
  /** 0–1. */
  volume: number;
  kinds: Record<SoundKind, SoundChoice>;
  /** The uploaded file, by name and size; the audio itself is in IndexedDB. */
  custom: { name: string; bytes: number } | null;
}

export interface SoundState extends SoundSettings {
  /** This browser has WebAudio at all. */
  supported: boolean;
  /** A gesture has reached the AudioContext; until then nothing is heard. */
  unlocked: boolean;
  /** A sound was due while still locked: the toasts show the "click to enable" note once. */
  wanted: boolean;
}

export const KEY = "sessionpipe-gui.sounds";
export const MAX_CUSTOM_BYTES = 500 * 1024;
const DEFAULT_KINDS: Record<SoundKind, BuiltinSound> = {
  needsYou: "chime",
  question: "blip",
  error: "thud",
  done: "tick",
};
const DEFAULTS: SoundSettings = { on: true, volume: 0.6, kinds: DEFAULT_KINDS, custom: null };

type AudioContextCtor = new () => AudioContext;
const ctor = (): AudioContextCtor | undefined =>
  typeof window === "undefined"
    ? undefined
    : (window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext);

const read = (): SoundSettings => {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const p = JSON.parse(raw) as Partial<SoundSettings>;
    const c = p.custom;
    const custom =
      c && typeof c === "object" && typeof c.name === "string" ? { name: c.name, bytes: Number(c.bytes) || 0 } : null;
    const kinds: Record<SoundKind, SoundChoice> = { ...DEFAULT_KINDS };
    for (const k of SOUND_KINDS) {
      const v = p.kinds?.[k.kind];
      if ((v === "custom" && custom) || (typeof v === "string" && BUILTIN_IDS.has(v))) kinds[k.kind] = v;
    }
    const volume = typeof p.volume === "number" && p.volume >= 0 && p.volume <= 1 ? p.volume : DEFAULTS.volume;
    return { on: p.on !== false, volume, kinds, custom };
  } catch {
    return DEFAULTS;
  }
};

let state: SoundState = { ...read(), supported: !!ctor(), unlocked: false, wanted: false };
const listeners = new Set<() => void>();
const commit = (next: SoundState) => {
  state = next;
  for (const l of listeners) l();
};
const persist = (patch: Partial<SoundSettings>) => {
  const next = { ...state, ...patch };
  try {
    const { on, volume, kinds, custom } = next;
    localStorage.setItem(KEY, JSON.stringify({ on, volume, kinds, custom }));
  } catch {
    // the choice lasts for this page only
  }
  commit(next);
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export function useSounds(): SoundState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}

export const setSoundsOn = (on: boolean): void => persist({ on });
export const setSoundVolume = (volume: number): void => persist({ volume: Math.max(0, Math.min(1, volume)) });
export const setSoundChoice = (kind: SoundKind, choice: SoundChoice): void => {
  if (choice === "custom" && !state.custom) return;
  persist({ kinds: { ...state.kinds, [kind]: choice } });
};

// ----- the uploaded file: IndexedDB, one record -----

const DB = "sessionpipe-gui";
const STORE = "sounds";
const RECORD = "custom";
/** The uploaded file as a data URL, loaded once at boot; the source of truth for playback. */
let customUrl: string | null = null;
let customBuffer: AudioBuffer | null = null;

const idb = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("no IndexedDB"));
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
const idbRun = async <T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
  const db = await idb();
  return new Promise<T>((resolve, reject) => {
    const req = run(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
};

let loaded: Promise<void> | null = null;
/** Reads the uploaded file into memory; once, before the first play. */
const loadCustom = (): Promise<void> => {
  loaded ??= idbRun<unknown>("readonly", (s) => s.get(RECORD))
    .then((v) => {
      if (typeof v === "string") customUrl = v;
    })
    .catch(() => {
      // nothing uploaded, or no IndexedDB here: built-ins only
    });
  return loaded;
};

/** Stores the uploaded file; any kind can then choose "Your sound". Resolves to the reason when refused. */
export async function setCustomSound(file: File): Promise<string | null> {
  if (file.size > MAX_CUSTOM_BYTES)
    return `${Math.round(file.size / 1024)} KB is too big · files up to ${MAX_CUSTOM_BYTES / 1024} KB`;
  if (file.type && !file.type.startsWith("audio/")) return "not an audio file";
  const url = await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(file);
  });
  try {
    await idbRun("readwrite", (s) => s.put(url, RECORD));
  } catch {
    // kept for this page only
  }
  customUrl = url;
  customBuffer = null;
  persist({ custom: { name: file.name, bytes: file.size } });
  return null;
}

/** Forgets the uploaded file; the kinds that used it go back to their built-in defaults. */
export async function removeCustomSound(): Promise<void> {
  customUrl = null;
  customBuffer = null;
  const kinds = { ...state.kinds };
  for (const k of SOUND_KINDS) if (kinds[k.kind] === "custom") kinds[k.kind] = DEFAULT_KINDS[k.kind];
  persist({ kinds, custom: null });
  try {
    await idbRun("readwrite", (s) => s.delete(RECORD));
  } catch {
    // nothing stored
  }
}

// ----- the AudioContext and the gesture that unlocks it -----

let ac: AudioContext | null = null;
const context = (): AudioContext | null => {
  if (ac) return ac;
  const C = ctor();
  if (!C) return null;
  try {
    ac = new C();
  } catch {
    return null;
  }
  ac.addEventListener?.("statechange", () => commit({ ...state, unlocked: ac?.state === "running" }));
  return ac;
};

const tryUnlock = async (): Promise<boolean> => {
  const c = context();
  if (!c) return false;
  if (c.state !== "running") {
    try {
      await c.resume();
    } catch {
      // still locked
    }
  }
  const running = c.state === "running";
  if (running !== state.unlocked) commit({ ...state, unlocked: running });
  return running;
};

let unlockInstalled = false;
/** Resumes the context on the first gesture (pointer or key), anywhere on the page. */
export function installSoundUnlock(): () => void {
  if (unlockInstalled || !state.supported) return () => {};
  unlockInstalled = true;
  whenIdle(() => void import("./soundSynth").catch(() => {}));
  const onGesture = () => {
    void tryUnlock().then((ok) => {
      if (ok) off();
    });
  };
  const off = () => {
    unlockInstalled = false;
    document.removeEventListener("pointerdown", onGesture, true);
    document.removeEventListener("keydown", onGesture, true);
  };
  document.addEventListener("pointerdown", onGesture, true);
  document.addEventListener("keydown", onGesture, true);
  return off;
}

// ----- the sounds themselves (the built-ins are synthesised in soundSynth.ts) -----

async function playCustom(c: AudioContext, volume: number): Promise<boolean> {
  if (!customUrl) return false;
  try {
    if (!customBuffer) {
      const bytes = await (await fetch(customUrl)).arrayBuffer();
      customBuffer = await c.decodeAudioData(bytes);
    }
    const src = c.createBufferSource();
    src.buffer = customBuffer;
    const g = c.createGain();
    g.gain.setValueAtTime(volume, c.currentTime);
    src.connect(g);
    g.connect(c.destination);
    src.start();
    return true;
  } catch {
    return false;
  }
}

/** Plays the sound for one kind. Honours the master switch unless `test` (the Test
 *  button, which is itself the gesture that unlocks audio). Silent while locked, noting
 *  that a sound was wanted. */
export async function playSound(kind: SoundKind, o: { test?: boolean } = {}): Promise<void> {
  if (!state.supported || (!state.on && !o.test)) return;
  if (!(await tryUnlock())) {
    if (!state.wanted) commit({ ...state, wanted: true });
    return;
  }
  const c = context();
  if (!c) return;
  await loadCustom();
  const choice = state.kinds[kind];
  if (choice === "custom" && (await playCustom(c, state.volume))) return;
  // The synthesiser arrives with the first sound (and is fetched when the app is idle).
  const { synth } = await import("./soundSynth");
  synth(c, choice === "custom" ? DEFAULT_KINDS[kind] : choice, state.volume);
}
