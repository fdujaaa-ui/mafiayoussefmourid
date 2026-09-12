// Cinematic Arabic narrator powered by Lovable AI text-to-speech.
// Charon audio is cached permanently in IndexedDB so previously generated
// lines continue working even after Lovable AI credits run out or the device
// goes offline. No browser voice fallback is used.

let ctx: AudioContext | null = null;
const cache = new Map<string, Float32Array>();
const inflight = new Map<string, Promise<Float32Array>>();
const persistentCache = new Map<string, Float32Array>();
const localInflight = new Map<string, Promise<Float32Array>>();

const LOCAL_VOICE = "ar_JO-kareem-medium";
let localVoiceReady: Promise<void> | null = null;

let activeSources: AudioBufferSourceNode[] = [];
let generation = 0;
let pendingCompletion: (() => void) | null = null;

const SAMPLE_RATE = 24000;
const STREAM_BLOCK_SAMPLES = Math.round(SAMPLE_RATE * 0.16);

const DB_NAME = "mafia-narrator";
const DB_STORE = "audio";

class NarratorRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function blobToSamples(blob: Blob): Promise<Float32Array> {
  const c = getCtx();

  if (!c) {
    throw new Error("تعذّر تشغيل الصوت المحلي على هذا الجهاز.");
  }

  const decoded = await c.decodeAudioData(await blob.arrayBuffer());
  return new Float32Array(decoded.getChannelData(0));
}

/**
 * Download and initialize the permanent Arabic male voice on this device.
 * The model is kept by the browser and does not use any paid credits.
 */
export async function prepareOfflineVoice(
  onProgress?: (percent: number) => void,
): Promise<void> {
  if (typeof window === "undefined") return;

  if (!localVoiceReady) {
    localVoiceReady = (async () => {
      const tts = await import("@mintplex-labs/piper-tts-web");
      const storedVoices: string[] = await tts.stored().catch(
        () => [] as string[],
      );

      if (!storedVoices.includes(LOCAL_VOICE)) {
        await tts.download(LOCAL_VOICE, (progress) => {
          if (progress.total > 0) {
            onProgress?.(
              Math.min(100, Math.round((progress.loaded / progress.total) * 100)),
            );
          }
        });
      }

      // Warm the WebAssembly engine too, so all runtime files are cached.
      await tts.predict({ text: "جاهز", voiceId: LOCAL_VOICE });
      onProgress?.(100);
    })().catch((error: unknown) => {
      localVoiceReady = null;
      throw error;
    });
  }

  return localVoiceReady;
}

async function generateLocalAudio(text: string): Promise<Float32Array> {
  const running = localInflight.get(text);
  if (running) return running;

  const task = (async () => {
    await prepareOfflineVoice();
    const tts = await import("@mintplex-labs/piper-tts-web");
    const wav = await tts.predict({ text, voiceId: LOCAL_VOICE });
    const samples = await blobToSamples(wav);

    if (!samples.length) {
      throw new Error("لم يتمكن الصوت المحلي من قراءة الجملة.");
    }

    cache.set(text, samples);
    await saveAudio(text, samples);
    return samples;
  })();

  localInflight.set(text, task);

  try {
    return await task;
  } finally {
    localInflight.delete(text);
  }
}

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;

  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;

  if (!Ctor) return null;

  if (!ctx) {
    ctx = new Ctor({ sampleRate: SAMPLE_RATE });
  }

  return ctx;
}

/** Open the permanent local audio database. */
async function openAudioDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);

    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains(DB_STORE)) {
        database.createObjectStore(DB_STORE);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Save Charon audio permanently on this device/browser. */
async function saveAudio(text: string, samples: Float32Array) {
  if (typeof window === "undefined") return;

  try {
    const db = await openAudioDB();

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).put(samples, text);

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    db.close();
    persistentCache.set(text, samples);
  } catch {
    // The in-memory cache still works if IndexedDB is unavailable.
  }
}

/** Load previously generated Charon audio from the device. */
async function loadAudio(text: string): Promise<Float32Array | null> {
  if (cache.has(text)) {
    return cache.get(text)!;
  }

  if (persistentCache.has(text)) {
    return persistentCache.get(text)!;
  }

  if (typeof window === "undefined") return null;

  try {
    const db = await openAudioDB();

    const result = await new Promise<Float32Array | null>((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readonly");
      const request = tx.objectStore(DB_STORE).get(text);

      request.onsuccess = () => {
        const value = request.result;

        if (value instanceof Float32Array) {
          resolve(value);
        } else if (value instanceof ArrayBuffer) {
          resolve(new Float32Array(value));
        } else {
          resolve(null);
        }
      };

      request.onerror = () => reject(request.error);
    });

    db.close();

    if (result) {
      cache.set(text, result);
      persistentCache.set(text, result);
    }

    return result;
  } catch {
    return null;
  }
}

/** Call from a user gesture so audio is unlocked and warm. */
export function initNarrator() {
  const c = getCtx();

  if (c && c.state === "suspended") {
    void c.resume().catch(() => {});
  }
}

export function stopSpeaking(completeCurrent = false) {
  generation++;

  for (const source of activeSources) {
    try {
      source.stop();
    } catch {
      /* ignore */
    }
  }

  activeSources = [];

  const completion = pendingCompletion;
  pendingCompletion = null;

  if (completeCurrent) {
    completion?.();
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

  for (const chunk of chunks) {
    out.set(chunk, off);
    off += chunk.length;
  }

  return out;
}

async function fetchAudio(
  text: string,
  onChunk?: (chunk: Float32Array) => void,
): Promise<Float32Array> {
  // 1. Fast memory cache.
  const memoryCached = cache.get(text);

  if (memoryCached) {
    onChunk?.(memoryCached);
    return memoryCached;
  }

  // 2. Permanent device cache.
  const localCached = await loadAudio(text);

  if (localCached) {
    onChunk?.(localCached);
    return localCached;
  }

  // 3. Avoid generating the same sentence twice simultaneously.
  const running = inflight.get(text);

  if (running) {
    const samples = await running;
    onChunk?.(samples);
    return samples;
  }

  // 4. Generate Charon audio from Lovable AI.
  const task = (async () => {
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
    });

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");

      throw new NarratorRequestError(
        detail || `تعذّر تشغيل صوت المرشد (${res.status})`,
        res.status,
      );
    }

    const reader = res.body
      .pipeThrough(new TextDecoderStream())
      .getReader();

    let buffer = "";
    const chunks: Float32Array[] = [];
    let playbackChunks: Float32Array[] = [];
    let playbackSamples = 0;
    let tail = new Uint8Array(0);
    let receivedDone = false;

    const flushPlayback = () => {
      if (!playbackSamples) return;

      onChunk?.(concat(playbackChunks));

      playbackChunks = [];
      playbackSamples = 0;
    };

    for (;;) {
      const { value, done } = await reader.read();

      if (done) break;

      buffer += value;

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data:")) continue;

        const payloadText = line.slice(5).trim();

        if (!payloadText || payloadText === "[DONE]") {
          continue;
        }

        let payload: {
          type?: string;
          audio?: string;
        };

        try {
          payload = JSON.parse(payloadText);
        } catch {
          continue;
        }

        if (payload.type === "speech.audio.done") {
          receivedDone = true;
          continue;
        }

        if (
          payload.type !== "speech.audio.delta" ||
          !payload.audio
        ) {
          continue;
        }

        const bin = atob(payload.audio);

        const raw = new Uint8Array(
          tail.length + bin.length,
        );

        raw.set(tail);

        for (let i = 0; i < bin.length; i++) {
          raw[tail.length + i] = bin.charCodeAt(i);
        }

        const usable = raw.length - (raw.length % 2);

        tail = raw.slice(usable);

        if (usable > 0) {
          const chunk = pcmToFloat(
            raw.subarray(0, usable),
          );

          chunks.push(chunk);

          playbackChunks.push(chunk);
          playbackSamples += chunk.length;

          if (
            playbackSamples >=
            STREAM_BLOCK_SAMPLES
          ) {
            flushPlayback();
          }
        }
      }
    }

    flushPlayback();

    const merged = concat(chunks);

    if (!merged.length) {
      throw new Error("empty audio");
    }

    if (!receivedDone) {
      throw new Error(
        "انقطع اتصال الصوت قبل اكتمال الجملة.",
      );
    }

    // Save permanently on the device.
    cache.set(text, merged);
    await saveAudio(text, merged);

    return merged;
  })();

  inflight.set(text, task);

  try {
    return await task;
  } finally {
    inflight.delete(text);
  }
}

/**
 * Generate and permanently save a line before it is needed.
 * This is used for player names and important game phrases.
 */
export async function prepareVoice(text: string): Promise<boolean> {
  if (!text.trim()) return false;

  try {
    await fetchAudio(text.trim());
    return true;
  } catch {
    return false;
  }
}

/** Warm the cache in the background. */
export function prefetch(text: string) {
  if (!text.trim()) return;

  void fetchAudio(text.trim()).catch(() => {});
}

export type SpeakOptions = {
  muted?: boolean;
  onEnd?: () => void;
  onError?: (message: string) => void;
};

export function speak(
  text: string,
  opts: SpeakOptions = {},
) {
  const {
    muted,
    onEnd,
    onError,
  } = opts;

  stopSpeaking();

  const myGen = generation;

  let completed = false;

  const complete = () => {
    if (
      completed ||
      myGen !== generation
    ) {
      return;
    }

    completed = true;

    if (
      pendingCompletion === complete
    ) {
      pendingCompletion = null;
    }

    onEnd?.();
  };

  pendingCompletion = complete;

  if (muted) {
    window.setTimeout(() => {
      if (myGen === generation) {
        complete();
      }
    }, Math.min(4000, 400 + text.length * 55));

    return;
  }

  const c = getCtx();

  if (!c) {
    onError?.(
      "تعذّر تشغيل الصوت على هذا الجهاز.",
    );
    complete();
    return;
  }

  if (c.state === "suspended") {
    void c.resume().catch(() => {});
  }

  let started = false;
  let streamFinished = false;
  let scheduled = 0;
  let playhead = 0;

  const finish = () => {
    if (
      myGen !== generation ||
      !streamFinished ||
      scheduled > 0
    ) {
      return;
    }

    complete();
  };

  const schedule = (
    samples: Float32Array,
  ) => {
    if (
      myGen !== generation ||
      completed ||
      !samples.length
    ) {
      return;
    }

    started = true;

    const buffer = c.createBuffer(
      1,
      samples.length,
      SAMPLE_RATE,
    );

    buffer.copyToChannel(
      samples as Float32Array<ArrayBuffer>,
      0,
    );

    const source =
      c.createBufferSource();

    source.buffer = buffer;
    source.connect(c.destination);

    scheduled++;

    source.onended = () => {
      scheduled--;

      activeSources =
        activeSources.filter(
          (item) => item !== source,
        );

      finish();
    };

    playhead =
      playhead === 0
        ? c.currentTime + 0.05
        : Math.max(
            playhead,
            c.currentTime,
          );

    source.start(playhead);

    playhead += buffer.duration;

    activeSources.push(source);
  };

  fetchAudio(text, schedule)
    .then(() => {
      if (
        myGen !== generation ||
        completed
      ) {
        return;
      }

      streamFinished = true;

      finish();

      if (scheduled > 0) {
        window.setTimeout(
          complete,
          Math.max(
            1000,
            (playhead - c.currentTime) *
              1000 +
              1200,
          ),
        );
      }
    })
    .catch(async (error: unknown) => {
      if (
        myGen !== generation ||
        completed
      ) {
        return;
      }

      if (!started) {
        try {
          const localSamples = await generateLocalAudio(text);

          if (myGen !== generation || completed) return;

          schedule(localSamples);
          streamFinished = true;
          finish();

          if (scheduled > 0) {
            window.setTimeout(
              complete,
              Math.max(1000, (playhead - c.currentTime) * 1000 + 1200),
            );
          }

          return;
        } catch (localError: unknown) {
          const cloudMessage =
            error instanceof Error ? error.message : "تعذّر تشغيل صوت Charon.";
          const localMessage =
            localError instanceof Error
              ? localError.message
              : "تعذّر تشغيل الصوت المحلي.";

          onError?.(`${cloudMessage} ${localMessage}`);
          complete();
          return;
        }
      }

      onError?.(
        error instanceof Error ? error.message : "تعذّر تشغيل صوت المرشد.",
      );
      streamFinished = true;
      finish();
    });
}

