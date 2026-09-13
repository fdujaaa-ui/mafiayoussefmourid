// Mafia Arabic narrator — Charon via Cloudflare Worker
// Gemini is used ONLY when preparing/saving a voice.
// During normal gameplay, speak() uses IndexedDB only.

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

  const db = await openAudioDB();

  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(
        DB_STORE,
        "readwrite",
      );

      tx.objectStore(DB_STORE).put(
        samples,
        text.trim(),
      );

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function loadAudio(
  text: string,
): Promise<Float32Array | null> {
  const cleanText = text.trim();

  if (!cleanText) {
    return null;
  }

  const memory = cache.get(cleanText);

  if (memory) {
    return memory;
  }

  if (typeof window === "undefined") {
    return null;
  }

  try {
    const db = await openAudioDB();

    try {
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

      if (result) {
        cache.set(cleanText, result);
      }

      return result;
    } finally {
      db.close();
    }
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

/*
 * Gemini / Charon generator.
 *
 * THIS FUNCTION IS USED ONLY DURING VOICE-PACK PREPARATION.
 */
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
        `تعذّر إنشاء صوت Charon (${response.status})`,
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

/*
 * PREPARATION ONLY
 *
 * Generates one new Charon voice and saves it
 * permanently in IndexedDB.
 */
async function generateAndSaveVoice(
  text: string,
): Promise<Float32Array> {
  const cleanText = text.trim();

  const existing =
    await loadAudio(cleanText);

  if (existing) {
    return existing;
  }

  const running =
    inflight.get(cleanText);

  if (running) {
    return running;
  }

  const task =
    (async () => {
      const samples =
        await requestCharonAudio(
          cleanText,
        );

      cache.set(
        cleanText,
        samples,
      );

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

/* =========================================================
   SAVED NAMES
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
   VOICE PACK
   ========================================================= */

const STATIC_VOICE_PACK = [
  "بدأ توزيع الأدوار.",
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

  "نعم، هذا الشخص من المافيا.",
  "لا، هذا الشخص بريء.",

  "انتهت اللعبة. المافيا سيطرت على المدينة، الفوز للمافيا!",
  "انتهت اللعبة. تم القضاء على كل أفراد المافيا، الفوز للمدينة!",
] as const;

/*
 * Generates ALL phrases needed by the current game.
 *
 * This is the ONLY function that should consume Gemini.
 */
export async function prepareVoicePack(
  onProgress?: (
    current: number,
    total: number,
  ) => void,
): Promise<void> {
  const texts = new Set<string>();

  for (const text of STATIC_VOICE_PACK) {
    texts.add(text);
  }

  for (const name of SAVED_PLAYER_NAMES) {
    texts.add(name);

    texts.add(
      `${name}، أمسك الهاتف الآن وحدك، واستعد لرؤية دورك بسرية.`,
    );

    texts.add(
      `${name}، أمسك الهاتف الآن وتأكد أن لا أحد يرى الشاشة.`,
    );

    texts.add(
      `مع شروق الشمس، وُجد ${name} مقتولاً على يد المافيا. خرج من اللعبة، وكان دوره.`,
    );

    texts.add(
      `هاجمت المافيا ${name}، لكن الطبيب أنقذه في اللحظة الأخيرة. لم يمت أحد هذه الليلة.`,
    );

    texts.add(
      `انتهى تصويت أهل المدينة. تم إخراج ${name} من اللعبة، وكان دوره.`,
    );
  }

  const list = [...texts].filter(
    (text) => text.trim().length > 0,
  );

  const total = list.length;

  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      window.setTimeout(resolve, ms);
    });

  let sentRequest = false;

  for (let index = 0; index < total; index++) {
    const cleanText = list[index]!.trim();

    onProgress?.(index + 1, total);

    // Already saved on the device → never call Gemini again.
    const saved = await loadAudio(cleanText);

    if (saved) {
      continue;
    }

    // One request at a time, 25s apart.
    if (sentRequest) {
      await wait(25000);
    }

    let lastError: unknown = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        sentRequest = true;

        await generateAndSaveVoice(cleanText);

        lastError = null;
        break;
      } catch (error) {
        lastError = error;

        const status =
          error instanceof NarratorRequestError
            ? error.status
            : 0;

        if (attempt < 3) {
          await wait(status === 429 ? 30000 : 25000);
          continue;
        }
      }
    }

    if (lastError) {
      const message =
        lastError instanceof Error
          ? lastError.message
          : "تعذّر إنشاء الصوت.";

      throw new Error(
        `فشل الصوت ${index + 1} من ${total}: ${message}`,
      );
    }
  }
}

/* =========================================================
   PREPARE ONE VOICE
   ========================================================= */

export async function prepareVoice(
  text: string,
): Promise<boolean> {
  const cleanText =
    text.trim();

  if (!cleanText) {
    return false;
  }

  try {
    await generateAndSaveVoice(
      cleanText,
    );

    return true;
  } catch {
    return false;
  }
}

/* =========================================================
   LOCAL-ONLY SPEAK
   ========================================================= */

export type SpeakOptions = {
  muted?: boolean;

  onEnd?: () => void;

  onError?: (
    message: string,
  ) => void;
};

/*
 * IMPORTANT:
 *
 * speak() DOES NOT call Gemini.
 *
 * It ONLY searches:
 *   1. memory
 *   2. IndexedDB
 *
 * If the phrase isn't saved,
 * it shows an error instead of contacting Gemini.
 */
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
   * LOCAL ONLY.
   *
   * NO Gemini.
   * NO Cloudflare.
   * NO Internet request.
   */
  loadAudio(
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

        if (!samples) {
          onError?.(
            "هذا الصوت غير محفوظ بعد. اضغط «تحميل أصوات Charon» مرة واحدة بالإنترنت.",
          );

          complete();
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
          new Float32Array(samples),
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
      () => {
        if (
          myGeneration !==
            generation ||
          completed
        ) {
          return;
        }

        onError?.(
          "تعذّر تشغيل الصوت المحفوظ.",
        );

        complete();
      },
    );
}
