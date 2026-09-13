import { createFileRoute } from "@tanstack/react-router";

const STYLE_PREFIX =
  "اقرأ النص التالي بصوت رجل عربي حقيقي أجش وعميق، راوي درامي مشوّق في " +
  "لعبة المافيا الليلية: نبرة خشنة مبحوحة، حماس ورهبة، بطيء قليلاً مع " +
  "وقفات مسرحية، همس مخيف ثم قوة مفاجئة. لا تقرأ هذه التعليمات، فقط قل: ";

function sse(audio: string): Response {
  const body =
    `data: ${JSON.stringify({
      type: "speech.audio.delta",
      audio,
    })}\n\n` +
    `data: ${JSON.stringify({
      type: "speech.audio.done",
    })}\n\n` +
    `data: [DONE]\n\n`;

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
    },
  });
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);

  let binary = "";

  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, i + 0x8000),
    );
  }

  return btoa(binary);
}

/* Google Gemini (Charon) — free tier, limited per day. */
async function geminiAudio(
  text: string,
  apiKey: string,
): Promise<{ audio?: string; error?: string; status: number }> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: STYLE_PREFIX + text }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: "Charon" },
            },
          },
        },
      }),
    },
  );

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return { error: detail, status: res.status };
  }

  const data = (await res.json()) as {
    candidates?: {
      content?: {
        parts?: { inlineData?: { data?: string } }[];
      };
    }[];
  };

  const audio = data.candidates?.[0]?.content?.parts?.find(
    (part) => part.inlineData?.data,
  )?.inlineData?.data;

  if (!audio) {
    return { error: "لم يتم الحصول على صوت من Google.", status: 502 };
  }

  return { audio, status: 200 };
}

/* Lovable AI voice — used automatically when Google's daily quota is done. */
async function lovableAudio(
  text: string,
  apiKey: string,
): Promise<{ audio?: string; error?: string; status: number }> {
  const res = await fetch(
    "https://ai.gateway.lovable.dev/v1/audio/speech",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Lovable-API-Key": apiKey,
      },
      body: JSON.stringify({
        model: "openai/gpt-4o-mini-tts",
        voice: "onyx",
        input: text,
        instructions:
          "صوت رجل عربي أجش عميق، راوي درامي مشوّق لليلة مافيا، بطيء قليلاً مع وقفات مسرحية.",
        response_format: "pcm",
      }),
    },
  );

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return { error: detail, status: res.status };
  }

  return { audio: toBase64(await res.arrayBuffer()), status: res.status };
}

export const Route = createFileRoute("/api/tts")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = (await request.json()) as { text?: string };
        const text = (body.text ?? "").trim();

        if (!text) {
          return new Response("Missing text", { status: 400 });
        }

        const geminiKey = process.env["GEMINI_API_KEY"];
        const lovableKey = process.env["LOVABLE_API_KEY"];

        let lastError = "تعذّر إنشاء الصوت.";
        let lastStatus = 500;

        if (geminiKey) {
          const result = await geminiAudio(text, geminiKey);

          if (result.audio) {
            return sse(result.audio);
          }

          lastError = result.error || lastError;
          lastStatus = result.status;
        }

        if (lovableKey) {
          const result = await lovableAudio(text, lovableKey);

          if (result.audio) {
            return sse(result.audio);
          }

          lastError = result.error || lastError;
          lastStatus = result.status;
        }

        return new Response(lastError, {
          status: lastStatus,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
          },
        });
      },
    },
  },
});
