// Mafia Arabic narrator — Google Gemini Charon via Cloudflare Worker.
// Charon only.
// Generated audio is permanently cached on the device using IndexedDB.
// Once an audio phrase is saved, playing it does NOT call Gemini.

let ctx: AudioContext | null = null;

const cache = new Map<string, Float32Array>();
const inflight = new Map<string, Promise<Float32Array>>();

let activeSource: AudioBufferSourceNode | null = null;
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
): Promise<void> {
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

      tx.oncomplete = () => resolve();

      tx.onerror = () => {
        reject(tx.error);
      };
    });

    db.close();
  } catch {
    // Memory cache remains available.
  }
}

async function loadAudio(
  text: string,
): Promise<Float32Array | null> {
  const cleanText = text.trim();

  if (!cleanText) {
    return null;
  }

  if (cache.has(cleanText)) {
    return cache.get(cleanText)!;
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
            tx.objectStore(DB_STORE).get(
              cleanText,
            );

          request.onsuccess = () => {
            const value = request.result;

            if (value instanceof Float32Array) {
              resolve(value);
              return;
            }

            if (value instanceof ArrayBuffer) {
              resolve(
                new Float32Array(value),
              );
              return;
            }

            resolve(null);
          };

          request.onerror = () => {
            reject(request.error);
          };
        },
      );

    db.close();

    if (result) {
      cache.set(cleanText, result);
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

  if (activeSource) {
    try {
      activeSource.stop();
    } catch {
      // Already stopped.
    }

    activeSource = null;
  }

  const completion =
    pendingCompletion;

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

async function requestCharonAudio(
  text: string,
): Promise<Float32Array> {
  const cleanText = text.trim();

  if (!cleanText) {
    throw new Error("النص فارغ.");
  }

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

  let tail = new Uint8Array(0);

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
        chunks.push(
          pcmToFloat(
            raw.subarray(
              0,
              usable,
            ),
          ),
        );
      }
    }
  }

  const totalLength =
    chunks.reduce(
      (total, chunk) =>
        total + chunk.length,
      0,
    );

  if (!totalLength) {
    throw new Error(
      "لم يتم استلام صوت Charon.",
    );
  }

  const merged =
    new Float32Array(
      totalLength,
    );

  let offset = 0;

  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  return merged;
}

/**
 * Gets audio from the device first.
 *
 * IMPORTANT:
 * If the phrase already exists in IndexedDB,
 * Gemini is NOT contacted.
 *
 * Gemini is contacted only when the exact phrase
 * has never been saved on this device.
 */
async function fetchAudio(
  text: string,
): Promise<Float32Array> {
  const cleanText = text.trim();

  if (!cleanText) {
    throw new Error("النص فارغ.");
  }

  // 1. Fast memory cache.
  const memoryCached =
    cache.get(cleanText);

  if (memoryCached) {
    return memoryCached;
  }

  // 2. Permanent device cache.
  const deviceCached =
    await loadAudio(cleanText);

  if (deviceCached) {
    return deviceCached;
  }

  // 3. Avoid duplicate Gemini requests.
  const running =
    inflight.get(cleanText);

  if (running) {
    return running;
  }

  // 4. Only now contact Cloudflare/Gemini.
  const task = (async () => {
    const samples =
      await requestCharonAudio(
        cleanText,
      );

    cache.set(
      cleanText,
      samples,
    );

    // Save permanently on the device.
    await saveAudio(
      cleanText,
      samples,
    );

    return samples;
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
  const cleanText = text.trim();

  if (!cleanText) {
    return false;
  }

  try {
    await fetchAudio(
      cleanText,
    );

    return true;
  } catch {
    return false;
  }
}

export function prefetch(
  text: string,
) {
  const cleanText = text.trim();

  if (!cleanText) {
    return;
  }

  void fetchAudio(
    cleanText,
  ).catch(() => {});
}

/* =========================================================
   SAVED MAFIA PLAYER NAMES
   ========================================================= */

export const SAVED_PLAYER_NAMES = [
  "يوسف",
  "زكرياء",
  "هاجر",
  "مريم",
  "أحلام",
  "أسماء",
  "عمر",
] as const;

/* =========================================================
   STATIC CHARON VOICE PACK
   ========================================================= */

const STATIC_VOICE_PACK = [
  "بدأ توزيع الأدوار.",
  "أمسك الهاتف الآن وتأكد أن لا أحد يرى الشاشة.",
  "أمسك الهاتف الآن وحدك، واستعد لرؤية دورك بسرية.",

  "الليلة بدأت. المدينة تنام الآن. الجميع يغمض عينيه.",

  "المافيا، افتحوا أعينكم. تعرّفوا على بعضكم، ثم اختاروا ضحيتكم.",
  "المافيا، أغمضوا أعينكم.",

  "الطبيب، افتح عينيك. من تريد أن تنقذ هذه الليلة؟",
  "الطبيب، أغمض عينيك.",

  "المحقق، افتح عينيك. من تشك فيه هذه الليلة؟",
  "المحقق، أغمض عينيك.",

  "انتهى الليل. أشرقت الشمس، افتحوا أعينكم جميعاً.",

  "مرّت الليلة بسلام، لم يمت أحد هذه الليلة.",

  "حان وقت التصويت. اختاروا من تشكّون أنه من المافيا.",

  "انتهى تصويت أهل المدينة.",
  "خرج من اللعبة.",
  "انتهت اللعبة.",
  "فازت المافيا.",
  "فاز أهل المدينة.",
] as const;

/* =========================================================
   PREPARE ALL SAVED CHARRON VOICES
   ========================================================= */

/**
 * Generates and saves the Voice Pack on the device.
 *
 * This should be used ONCE while the phone has internet.
 *
 * IMPORTANT:
 * Gemini's free TTS quota is limited, so requests are
 * deliberately spaced out.
 *
 * After a phrase is saved, it is skipped forever on this
 * device unless its exact text changes.
 */
export async function prepareVoicePack(
  onProgress?: (
    current: number,
    total: number,
  ) => void,
): Promise<void> {
  const texts =
    new Set<string>();

  // Player names.
  for (const name of SAVED_PLAYER_NAMES) {
    texts.add(name);
  }

  // Static game phrases.
  for (const text of STATIC_VOICE_PACK) {
    texts.add(text);
  }

  // Exact phrases containing the saved player names.
  for (const name of SAVED_PLAYER_NAMES) {
    texts.add(
      `${name}، أمسك الهاتف الآن وحدك، واستعد لرؤية دورك بسرية.`,
    );

    texts.add(
      `${name}، أمسك الهاتف الآن وتأكد أن لا أحد يرى الشاشة.`,
    );

    texts.add(
      `مع شروق الشمس، وُجد ${name} مقتولاً على يد المافيا.`,
    );

    texts.add(
      `هاجمت المافيا ${name}، لكن الطبيب أنقذه.`,
    );

    texts.add(
      `تم إخراج ${name} من اللعبة.`,
    );
  }

  const list =
    [...texts];

  const total =
    list.length;

  let current = 0;

  for (const text of list) {
    const cleanText =
      text.trim();

    if (!cleanText) {
      current++;

      onProgress?.(
        current,
        total,
      );

      continue;
    }

    // Check device FIRST.
    const alreadySaved =
      await loadAudio(
        cleanText,
      );

    if (!alreadySaved) {
      // This is the ONLY place where a new Gemini
      // generation happens during preparation.
      await fetchAudio(
        cleanText,
      );

      // Gemini free tier is limited to about
      // 3 TTS requests per minute in the current setup.
      // Wait before generating another NEW phrase.
      await new Promise(
        (resolve) =>
          setTimeout(
            resolve,
            22000,
          ),
      );
    }

    current++;

    onProgress?.(
      current,
      total,
    );
  }
}

/* =========================================================
   SPEAK
   ========================================================= */

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

  const cleanText =
    text.trim();

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
      complete,
      Math.min(
        4000,
        400 +
          cleanText.length * 55,
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

  if (c.state === "suspended") {
    void c.resume().catch(
      () => {},
    );
  }

  /*
   * fetchAudio() checks:
   *
   * 1. Memory
   * 2. IndexedDB on the phone
   * 3. Only if missing -> Cloudflare -> Gemini
   *
   * Therefore saved phrases do not consume
   * Gemini requests during normal gameplay.
   */
  fetchAudio(
    cleanText,
  )
    .then(
      (samples) => {
        if (
          myGeneration !==
            generation ||
          completed
        ) {
          return;
        }

        if (!samples.length) {
          complete();
          return;
        }

        const audioBuffer =
          c.createBuffer(
            1,
            samples.length,
            SAMPLE_RATE,
          );

        audioBuffer.copyToChannel(
          samples,
          0,
        );

        const source =
          c.createBufferSource();

        source.buffer =
          audioBuffer;

        source.connect(
          c.destination,
        );

        activeSource =
          source;

        source.onended = () => {
          if (
            activeSource ===
            source
          ) {
            activeSource = null;
          }

          complete();
        };

        source.start(
          c.currentTime +
            0.015,
        );
      },
    )
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

        complete();
      },
    );
}
