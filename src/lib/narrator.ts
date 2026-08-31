// Cinematic Arabic narrator powered by Lovable AI text-to-speech.
// Streams PCM audio so playback starts almost instantly, caches every line
// so repeated phrases play with zero delay, and falls back to the built-in
// browser voice if the network is unavailable.

let ctx: AudioContext | null = null;
const cache = new Map<string, Float32Array>();
const inflight = new Map<string, Promise<Float32Array>>();
let activeSources: AudioBufferSourceNode[] = [];
let generation = 0;

const SAMPLE_RATE = 24000;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) ctx = new Ctor({ sampleRate: SAMPLE_RATE });
  return ctx;
}

/** Call from a user gesture so audio is unlocked and warm. */
export function initNarrator() {
  const c = getCtx();
  if (c && c.state === "suspended") void c.resume().catch(() => {});
}

export function stopSpeaking() {
  generation++;
  for (const s of activeSources) {
    try {
      s.stop();
    } catch {
      /* ignore */
    }
  }
  activeSources = [];
  if (typeof window !== "undefined" && window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }
}

function pcmToFloat(bytes: Uint8Array): Float32Array {
  const usable = bytes.length - (bytes.length % 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, usable);
  const out = new Float32Array(usable / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = view.getInt16(i * 2, true) / 32768;
  }
  return out;
}

function concat(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Float32Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

async function fetchAudio(text: string): Promise<Float32Array> {
  const cached = cache.get(text);
  if (cached) return cached;
  const running = inflight.get(text);
  if (running) return running;

  const task = (async () => {
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok || !res.body) throw new Error(`tts ${res.status}`);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    const chunks: Float32Array[] = [];
    let tail = new Uint8Array(0);
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payloadText = line.slice(5).trim();
        if (!payloadText || payloadText === "[DONE]") continue;
        let payload: { type?: string; audio?: string };
        try {
          payload = JSON.parse(payloadText);
        } catch {
          continue;
        }
        if (payload.type !== "speech.audio.delta" || !payload.audio) continue;
        const bin = atob(payload.audio);
        const raw = new Uint8Array(tail.length + bin.length);
        raw.set(tail);
        for (let i = 0; i < bin.length; i++) raw[tail.length + i] = bin.charCodeAt(i);
        const usable = raw.length - (raw.length % 2);
        tail = raw.slice(usable);
        if (usable > 0) chunks.push(pcmToFloat(raw.subarray(0, usable)));
      }
    }
    const merged = concat(chunks);
    if (!merged.length) throw new Error("empty audio");
    cache.set(text, merged);
    return merged;
  })();

  inflight.set(text, task);
  try {
    return await task;
  } finally {
    inflight.delete(text);
  }
}

/** Warm the cache in the background so the next line plays instantly. */
export function prefetch(text: string) {
  if (!text || cache.has(text)) return;
  void fetchAudio(text).catch(() => {});
}

function browserFallback(text: string, muted: boolean, onEnd?: () => void) {
  if (typeof window === "undefined" || !window.speechSynthesis || muted) {
    window.setTimeout(() => onEnd?.(), Math.min(4500, 500 + text.length * 60));
    return;
  }
  const u = new SpeechSynthesisUtterance(text);
  const arabic = window.speechSynthesis
    .getVoices()
    .find((v) => v.lang?.toLowerCase().startsWith("ar"));
  if (arabic) u.voice = arabic;
  u.lang = arabic?.lang ?? "ar-SA";
  u.rate = 0.95;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    onEnd?.();
  };
  u.onend = finish;
  u.onerror = finish;
  window.setTimeout(finish, 2500 + text.length * 130);
  window.speechSynthesis.speak(u);
}

export type SpeakOptions = { muted?: boolean; onEnd?: () => void };

export function speak(text: string, opts: SpeakOptions = {}) {
  const { muted, onEnd } = opts;
  stopSpeaking();
  const myGen = generation;

  if (muted) {
    window.setTimeout(() => {
      if (myGen === generation) onEnd?.();
    }, Math.min(4000, 400 + text.length * 55));
    return;
  }

  const c = getCtx();
  if (!c) {
    browserFallback(text, false, onEnd);
    return;
  }
  if (c.state === "suspended") void c.resume().catch(() => {});

  fetchAudio(text)
    .then((samples) => {
      if (myGen !== generation) return;
      const buffer = c.createBuffer(1, samples.length, SAMPLE_RATE);
      buffer.copyToChannel(samples, 0);
      const source = c.createBufferSource();
      source.buffer = buffer;
      source.connect(c.destination);
      source.onended = () => {
        if (myGen === generation) onEnd?.();
      };
      activeSources.push(source);
      source.start();
    })
    .catch(() => {
      if (myGen !== generation) return;
      browserFallback(text, false, onEnd);
    });
}
