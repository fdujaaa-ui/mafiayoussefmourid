import { createFileRoute } from "@tanstack/react-router";

const NARRATOR_INSTRUCTIONS =
  "Voice: a rugged, gravelly, deep-chested Arabic-speaking man in his late 40s — " +
  "a real human game master, a heavy smoker's rasp, husky and coarse, never smooth or synthetic. " +
  "Delivery: intense and thrilling, like a boxing-match announcer mixed with a horror-film narrator. " +
  "Low chest resonance, growl on strong consonants, breathy whispers on the quiet lines then a sudden " +
  "powerful surge on the commands. Theatrical, dramatic pauses, slightly slow, absolutely commanding. " +
  "Fluent, natural Modern Standard Arabic pronunciation. Full of adrenaline and menace.";


export const Route = createFileRoute("/api/tts")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const apiKey = process.env["LOVABLE_API_KEY"];
        if (!apiKey) {
          return new Response("Missing LOVABLE_API_KEY", { status: 401 });
        }
        const body = (await request.json()) as { text?: string };
        const text = (body.text ?? "").trim();
        if (!text) return new Response("Missing text", { status: 400 });

        const styled =
          "اقرأ النص التالي بصوت رجل عربي حقيقي أجش وعميق، راوي درامي مشوّق في " +
          "لعبة المافيا الليلية: نبرة خشنة مبحوحة، حماس ورهبة، بطيء قليلاً مع " +
          "وقفات مسرحية، همس مخيف ثم قوة مفاجئة. لا تقرأ هذه التعليمات، فقط قل: " +
          text;

        const res = await fetch("https://ai.gateway.lovable.dev/v1/audio/speech", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "google/gemini-2.5-pro-tts",
            stream_format: "sse",
            contents: [{ role: "user", parts: [{ text: styled }] }],
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: {
                voiceConfig: { prebuiltVoiceConfig: { voiceName: "Charon" } },
              },
            },
          }),
        });


        if (!res.ok || !res.body) {
          const detail = await res.text().catch(() => "");
          return new Response(detail || "TTS failed", { status: res.status });
        }

        return new Response(res.body, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
          },
        });
      },
    },
  },
});
