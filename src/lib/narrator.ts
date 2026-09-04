// Cinematic Arabic narrator powered by Lovable AI text-to-speech.
// Streams PCM audio so playback starts almost instantly, caches every line
// so repeated phrases play with zero delay, and falls back to the built-in
// browser voice if the network is unavailable.

let ctx: AudioContext | null = null;
const cache = new Map<string, Float32Array>();
const inflight = new Map<string, Promise<Float32Array>>();
let activeSources: AudioBufferSourceNode[] = [];
let generation = 0;
let pendingCompletion: (() => void) | null = null;

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

export function stopSpeaking(completeCurrent = false) {
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
  const completion = pendingCompletion;
  pendingCompletion = null;
  if (completeCurrent) completion?.();
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

async function fetchAudio(
  text: string,
  onChunk?: (chunk: Float32Array) => void,
): Promise<Float32Array> {
  const cached = cache.get(text);
  if (cached) {
    onChunk?.(cached);
    return cached;
  }
  const running = inflight.get(text);
  if (running) {
    const samples = await running;
    onChunk?.(samples);
    return samples;
  }

  const task = (async () => {
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      throw new Error(detail || `تعذّر تشغيل صوت المرشد (${res.status})`);
    }
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
        if (usable > 0) {
          const chunk = pcmToFloat(raw.subarray(0, usable));
          chunks.push(chunk);
          onChunk?.(chunk);
        }
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

export type SpeakOptions = {
  muted?: boolean;
  onEnd?: () => void;
  onError?: (message: string) => void;
};

export function speak(text: string, opts: SpeakOptions = {}) {
  const { muted, onEnd, onError } = opts;
  stopSpeaking();
  const myGen = generation;

  let completed = false;
  const complete = () => {
    if (completed) return;
    completed = true;
    if (pendingCompletion === complete) pendingCompletion = null;
    onEnd?.();
  };
  pendingCompletion = complete;

  if (muted) {
    window.setTimeout(() => {
      if (myGen === generation) complete();
    }, Math.min(4000, 400 + text.length * 55));
    return;
  }

  // No internet: skip the cloud voice entirely unless the line is cached.
  if (
    typeof navigator !== "undefined" &&
    navigator.onLine === false &&
    !cache.has(text)
  ) {
    browserFallback(text, false, complete);
    return;
  }

  const c = getCtx();
  if (!c) {
    browserFallback(text, false, complete);
    return;
  }
  if (c.state === "suspended") void c.resume().catch(() => {});


  // Guarantees the game never freezes waiting on the network: if the
  // cinematic voice has not started within a short window, we speak the
  // line with the built-in voice instead.
  let started = false;
  let streamFinished = false;
  let scheduled = 0;
  let playhead = 0;
  const finish = () => {
    if (myGen !== generation || !streamFinished || scheduled > 0) return;
    complete();
  };
  const watchdog = window.setTimeout(() => {
    if (started || myGen !== generation || completed) return;
    started = true;
    onError?.("تأخر الصوت السينمائي، تم تشغيل الصوت الاحتياطي فوراً.");
    browserFallback(text, false, complete);
  }, cache.has(text) ? 1200 : 3500);

  const schedule = (samples: Float32Array) => {
    if (myGen !== generation || completed || !samples.length) return;
    if (!started) {
      started = true;
      window.clearTimeout(watchdog);
    }
    const buffer = c.createBuffer(1, samples.length, SAMPLE_RATE);
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    const source = c.createBufferSource();
    source.buffer = buffer;
    source.connect(c.destination);
    scheduled++;
    source.onended = () => {
      scheduled--;
      activeSources = activeSources.filter((item) => item !== source);
      finish();
    };
    playhead = playhead === 0 ? c.currentTime + 0.05 : Math.max(playhead, c.currentTime);
    source.start(playhead);
    playhead += buffer.duration;
    activeSources.push(source);
  };

  fetchAudio(text, schedule)
    .then(() => {
      if (myGen !== generation || completed) return;
      streamFinished = true;
      finish();
      if (scheduled > 0) {
        window.setTimeout(complete, Math.max(1000, (playhead - c.currentTime) * 1000 + 1200));
      }
    })
    .catch((error: unknown) => {
      if (myGen !== generation || completed) return;
      window.clearTimeout(watchdog);
      const message = error instanceof Error ? error.message : "تعذّر تشغيل صوت المرشد.";
      onError?.(message);
      if (!started) {
        started = true;
        browserFallback(text, false, complete);
      } else {
        streamFinished = true;
        finish();
      }
    });
}

