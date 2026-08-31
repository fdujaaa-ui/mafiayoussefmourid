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

        const res = await fetch("https://ai.gateway.lovable.dev/v1/audio/speech", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "openai/gpt-4o-mini-tts",
            input: text,
            voice: "ash",
            instructions: NARRATOR_INSTRUCTIONS,
            speed: 0.94,
            stream_format: "sse",
            response_format: "pcm",
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
