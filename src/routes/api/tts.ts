import { createFileRoute } from "@tanstack/react-router";

const NARRATOR_INSTRUCTIONS =
  "You are the dramatic game master of a Mafia party game, speaking Arabic. " +
  "Deep, confident, charismatic male voice. Cinematic and suspenseful, like a " +
  "movie trailer narrator whispering secrets at night. Clear pronunciation, " +
  "theatrical pacing with meaningful pauses, warm but commanding. Never robotic.";

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
            voice: "onyx",
            instructions: NARRATOR_INSTRUCTIONS,
            speed: 1.0,
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
