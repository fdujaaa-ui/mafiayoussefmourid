// Mafia Arabic narrator — Google Gemini Charon via Cloudflare Worker.
// No Lovable TTS and no local/browser voice fallback.

let ctx: AudioContext | null = null;

const cache = new Map<string, Float32Array>();
const inflight = new Map<string, Promise<Float32Array>>();

let activeSources: AudioBufferSourceNode[] = [];
let generation = 0;
let pendingCompletion: (() => void) | null = null;

const SAMPLE_RATE = 24000;

const WORKER_URL =
  "https://mafia-voice.younessydey707.workers.dev";

const DB_NAME = "mafia-narrator";
const DB_STORE = "audio";

class NarratorRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") {
    return null;
  }

  const Ctor =
    window.AudioContext ??
    (
      window as unknown as {
        webkitAudioContext?: typeof AudioContext;
      }
    ).webkitAudioContext;

  if (!Ctor) {
    return null;
  }

  if (!ctx) {
    ctx = new Ctor({
      sampleRate: SAMPLE_RATE,
    });
  }

  return ctx;
}

async function openAudioDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);

    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains(DB_STORE)) {
        database.createObjectStore(DB_STORE);
      }
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onerror = () => {
      reject(request.error);
    };
  });
}

async function saveAudio(
  text: string,
  samples: Float32Array,
) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    const db = await openAudioDB();

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(
        DB_STORE,
        "readwrite",
      );

      tx.objectStore(DB_STORE).put(
        samples,
        text,
      );

      tx.oncomplete = () => {
        resolve();
      };

      tx.onerror = () => {
        reject(tx.error);
      };
    });

    db.close();
  } catch {
    // Memory cache still works if IndexedDB is unavailable.
  }
}

async function loadAudio(
  text: string,
): Promise<Float32Array | null> {
  if (cache.has(text)) {
    return cache.get(text)!;
  }

  if (typeof window === "undefined") {
    return null;
  }

  try {
    const db = await openAudioDB();

    const result =
      await new Promise<Float32Array | null>(
        (resolve, reject) => {
          const tx = db.transaction(
            DB_STORE,
            "readonly",
          );

          const request =
            tx.objectStore(DB_STORE).get(text);

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

          request.onerror = () => {
            reject(request.error);
          };
        },
      );

    db.close();

    if (result) {
      cache.set(text, result);
    }

    return result;
  } catch {
    return null;
  }
}

export function initNarrator() {
  const c = getCtx();

  if (c && c.state === "suspended") {
    void c.resume().catch(() => {});
  }
}

export function stopSpeaking(
  completeCurrent = false,
) {
  generation++;

  for (const source of activeSources) {
    try {
      source.stop();
    } catch {
      // Ignore already stopped sources.
    }
  }

  activeSources = [];

  const completion = pendingCompletion;
  pendingCompletion = null;

  if (completeCurrent) {
    completion?.();
  }
}

function pcmToFloat(
  bytes: Uint8Array,
): Float32Array {
  const usable =
    bytes.length -
    (bytes.length % 2);

  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    usable,
  );

  const out = new Float32Array(
    usable / 2,
  );

  for (let i = 0; i < out.length; i++) {
    out[i] =
      view.getInt16(
        i * 2,
        true,
      ) / 32768;
  }

  return out;
}

function concat(
  chunks: Float32Array[],
): Float32Array {
  const total = chunks.reduce(
    (n, c) => n + c.length,
    0,
  );

  const out = new Float32Array(total);

  let offset = 0;

  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }

  return out;
}

async function fetchAudio(
  text: string,
  onChunk?: (
    chunk: Float32Array,
  ) => void,
): Promise<Float32Array> {
  const cleanText = text.trim();

  if (!cleanText) {
    throw new Error("النص فارغ.");
  }

  // 1. Memory cache
  const memoryCached =
    cache.get(cleanText);

  if (memoryCached) {
    onChunk?.(memoryCached);
    return memoryCached;
  }

  // 2. Device cache
  const deviceCached =
    await loadAudio(cleanText);

  if (deviceCached) {
    onChunk?.(deviceCached);
    return deviceCached;
  }

  // 3. Prevent duplicate requests
  const running =
    inflight.get(cleanText);

  if (running) {
    const samples = await running;
    onChunk?.(samples);
    return samples;
  }

  // 4. Google Gemini Charon through Cloudflare Worker
  const task = (async () => {
    const response = await fetch(
      WORKER_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: cleanText,
        }),
      },
    );

    if (!response.ok || !response.body) {
      const detail =
        await response.text().catch(
          () => "",
        );

      throw new NarratorRequestError(
        detail ||
          `تعذّر تشغيل صوت Charon (${response.status})`,
        response.status,
      );
    }

    const reader =
      response.body
        .pipeThrough(
          new TextDecoderStream(),
        )
        .getReader();

    let buffer = "";

    const chunks: Float32Array[] = [];

    let playbackChunks: Float32Array[] = [];
    let playbackSamples = 0;

    let tail = new Uint8Array(0);

    let receivedDone = false;

    const flushPlayback = () => {
      if (!playbackSamples) {
        return;
      }

      onChunk?.(
        concat(playbackChunks),
      );

      playbackChunks = [];
      playbackSamples = 0;
    };

    for (;;) {
      const { value, done } =
        await reader.read();

      if (done) {
        break;
      }

      buffer += value;

      const lines =
        buffer.split("\n");

      buffer =
        lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data:")) {
          continue;
        }

        const payloadText =
          line.slice(5).trim();

        if (
          !payloadText ||
          payloadText === "[DONE]"
        ) {
          continue;
        }

        let payload: {
          type?: string;
          audio?: string;
        };

        try {
          payload =
            JSON.parse(payloadText);
        } catch {
          continue;
        }

        if (
          payload.type ===
          "speech.audio.done"
        ) {
          receivedDone = true;
          continue;
        }

        if (
          payload.type !==
            "speech.audio.delta" ||
          !payload.audio
        ) {
          continue;
        }

        const binary =
          atob(payload.audio);

        const raw =
          new Uint8Array(
            tail.length +
              binary.length,
          );

        raw.set(tail);

        for (
          let i = 0;
          i < binary.length;
          i++
        ) {
          raw[
            tail.length + i
          ] =
            binary.charCodeAt(i);
        }

        const usable =
          raw.length -
          (raw.length % 2);

        tail =
          raw.slice(usable);

        if (usable > 0) {
          const chunk =
            pcmToFloat(
              raw.subarray(
                0,
                usable,
              ),
            );

          chunks.push(chunk);

          playbackChunks.push(
            chunk,
          );

          playbackSamples +=
            chunk.length;

          if (
            playbackSamples >=
            SAMPLE_RATE * 0.16
          ) {
            flushPlayback();
          }
        }
      }
    }

    flushPlayback();

    const merged =
      concat(chunks);

    if (!merged.length) {
      throw new Error(
        "لم يتم استلام صوت Charon.",
      );
    }

    if (!receivedDone) {
      throw new Error(
        "انقطع اتصال صوت Charon قبل اكتمال الجملة.",
      );
    }

    // Save generated Charon audio on this device.
    cache.set(
      cleanText,
      merged,
    );

    await saveAudio(
      cleanText,
      merged,
    );

    return merged;
  })();

  inflight.set(
    cleanText,
    task,
  );

  try {
    return await task;
  } finally {
    inflight.delete(
      cleanText,
    );
  }
}

export async function prepareVoice(
  text: string,
): Promise<boolean> {
  if (!text.trim()) {
    return false;
  }

  try {
    await fetchAudio(
      text.trim(),
    );

    return true;
  } catch {
    return false;
  }
}

export function prefetch(
  text: string,
) {
  if (!text.trim()) {
    return;
  }

  void fetchAudio(
    text.trim(),
  ).catch(() => {});
}

export type SpeakOptions = {
  muted?: boolean;
  onEnd?: () => void;
  onError?: (
    message: string,
  ) => void;
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

  const myGeneration =
    generation;

  let completed = false;

  const complete = () => {
    if (
      completed ||
      myGeneration !==
        generation
    ) {
      return;
    }

    completed = true;

    if (
      pendingCompletion ===
      complete
    ) {
      pendingCompletion = null;
    }

    onEnd?.();
  };

  pendingCompletion =
    complete;

  if (muted) {
    window.setTimeout(
      () => {
        if (
          myGeneration ===
          generation
        ) {
          complete();
        }
      },
      Math.min(
        4000,
        400 +
          text.length * 55,
      ),
    );

    return;
  }

  const c = getCtx();

  if (!c) {
    onError?.(
      "تعذّر تشغيل صوت Charon على هذا الجهاز.",
    );

    complete();
    return;
  }

  if (
    c.state === "suspended"
  ) {
    void c.resume().catch(
      () => {},
    );
  }

  let started = false;
  let streamFinished =
    false;

  let scheduled = 0;
  let playhead = 0;

  const finish = () => {
    if (
      myGeneration !==
        generation ||
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
      myGeneration !==
        generation ||
      completed ||
      !samples.length
    ) {
      return;
    }

    started = true;

    const audioBuffer =
      c.createBuffer(
        1,
        samples.length,
        SAMPLE_RATE,
      );

    audioBuffer.copyToChannel(
      samples as Float32Array<ArrayBuffer>,
      0,
    );

    const source =
      c.createBufferSource();

    source.buffer =
      audioBuffer;

    source.connect(
      c.destination,
    );

    scheduled++;

    source.onended = () => {
      scheduled--;

      activeSources =
        activeSources.filter(
          (item) =>
            item !== source,
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

    source.start(
      playhead,
    );

    playhead +=
      audioBuffer.duration;

    activeSources.push(
      source,
    );
  };

  fetchAudio(
    text,
    schedule,
  )
    .then(() => {
      if (
        myGeneration !==
          generation ||
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
            (playhead -
              c.currentTime) *
              1000 +
              1200,
          ),
        );
      }
    })
    .catch(
      (error: unknown) => {
        if (
          myGeneration !==
            generation ||
          completed
        ) {
          return;
        }

        const message =
          error instanceof Error
            ? error.message
            : "تعذّر تشغيل صوت Charon.";

        onError?.(
          message,
        );

        if (!started) {
          complete();
        } else {
          streamFinished =
            true;

          finish();
        }
      },
    );
}
