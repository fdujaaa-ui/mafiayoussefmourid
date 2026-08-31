// Instant, offline voice narration using the browser Speech Synthesis API.
// No network round-trip => no delay.

let cachedVoice: SpeechSynthesisVoice | null = null;
let warmed = false;

function pickArabicVoice(): SpeechSynthesisVoice | null {
  if (typeof window === "undefined" || !window.speechSynthesis) return null;
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;
  const ar = voices.filter((v) => v.lang?.toLowerCase().startsWith("ar"));
  if (ar.length) {
    return (
      ar.find((v) => /Maged|Tarik|Laila|Hala|Google/i.test(v.name)) ?? ar[0]
    );
  }
  return null;
}

export function initNarrator() {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  cachedVoice = pickArabicVoice();
  window.speechSynthesis.onvoiceschanged = () => {
    cachedVoice = pickArabicVoice();
  };
  // Warm-up: some engines add latency to the very first utterance.
  if (!warmed) {
    warmed = true;
    try {
      const u = new SpeechSynthesisUtterance(" ");
      u.volume = 0;
      window.speechSynthesis.speak(u);
    } catch {
      /* ignore */
    }
  }
}

export function stopSpeaking() {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();
}

export type SpeakOptions = {
  muted?: boolean;
  rate?: number;
  onEnd?: () => void;
};

/** Speaks immediately. Calls onEnd when finished (or right away if muted/unsupported). */
export function speak(text: string, opts: SpeakOptions = {}) {
  const { muted, rate = 0.92, onEnd } = opts;
  if (typeof window === "undefined" || !window.speechSynthesis || muted) {
    if (onEnd) window.setTimeout(onEnd, Math.min(4000, 400 + text.length * 55));
    return;
  }
  const synth = window.speechSynthesis;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  if (!cachedVoice) cachedVoice = pickArabicVoice();
  if (cachedVoice) u.voice = cachedVoice;
  u.lang = cachedVoice?.lang ?? "ar-SA";
  u.rate = rate;
  u.pitch = 0.95;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    onEnd?.();
  };
  u.onend = finish;
  u.onerror = finish;
  // Safety net in case the engine never fires onend.
  window.setTimeout(finish, 2000 + text.length * 130);
  synth.speak(u);
}
