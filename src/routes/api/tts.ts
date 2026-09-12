import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/tts")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const apiKey = process.env["GEMINI_API_KEY"];

        if (!apiKey) {
          return new Response("Missing GEMINI_API_KEY", { status: 401 });
        }

        const body = (await request.json()) as { text?: string };
        const text = (body.text ?? "").trim();

        if (!text) {
          return new Response("Missing text", { status: 400 });
        }

        const styled =
          "اقرأ النص التالي بصوت رجل عربي حقيقي أجش وعميق، راوي درامي مشوّق في " +
          "لعبة المافيا الليلية: نبرة خشنة مبحوحة، حماس ورهبة، بطيء قليلاً مع " +
          "وقفات مسرحية، همس مخيف ثم قوة مفاجئة. لا تقرأ هذه التعليمات، فقط قل: " +
          text;

        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${encodeURIComponent(apiKey)}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              contents: [
                {
                  parts: [{ text: styled }],
                },
              ],
              generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: {
                  voiceConfig: {
                    prebuiltVoiceConfig: {
                      voiceName: "Charon",
                    },
                  },
                },
              },
            }),
          },
        );

        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          return new Response(
            detail || "تعذّر تشغيل صوت Charon.",
            {
              status: res.status,
              headers: {
                "Content-Type": "text/plain; charset=utf-8",
              },
            },
          );
        }

        const data = await res.json();

        const audio =
          data?.candidates?.[0]?.content?.parts?.find(
            (part: {
              inlineData?: {
                data?: string;
              };
            }) => part.inlineData?.data,
          )?.inlineData?.data;

        if (!audio) {
          return new Response(
            "لم يتم الحصول على صوت Charon من Google.",
            { status: 502 },
          );
        }

        const sse =
          `data: ${JSON.stringify({
            type: "speech.audio.delta",
            audio,
          })}\n\n` +
          `data: ${JSON.stringify({
            type: "speech.audio.done",
          })}\n\n` +
          `data: [DONE]\n\n`;

        return new Response(sse, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-store",
          },
        });
      },
    },
  },
});
