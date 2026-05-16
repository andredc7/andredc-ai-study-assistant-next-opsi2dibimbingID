import { NextRequest } from "next/server";

type TutorMode = "EXPLAIN" | "QUIZ";
type Message = { role: "user" | "assistant"; content: string };

// This endpoint streams SSE-style chunks for progressive UI updates.
export async function POST(req: NextRequest) {
  try {
    const apiKey = process.env.GOOGLE_AI_API_KEY;
    if (!apiKey) return new Response(JSON.stringify({ error: "Missing GOOGLE_AI_API_KEY" }), { status: 500 });

    const body = (await req.json()) as {
      message: string;
      mode: TutorMode;
      course: string;
      history?: Message[];
    };

    const { message, mode, course, history = [] } = body;
    const systemPrompt = buildSystemPrompt({ mode, course });

    const historyText = history
      .map((m) => `${m.role === "assistant" ? "Tutor" : "Siswa"}: ${m.content}`)
      .join("\n");

    const promptText = [systemPrompt.trim(), historyText, `Siswa: ${message}`]
      .filter(Boolean)
      .join("\n\n");

    const modelCandidates = [process.env.GOOGLE_GEMINI_MODEL ?? "gemini-2.5-flash", "text-bison-001", "chat-bison-001"];
    const maxOutputTokens = Number(process.env.GOOGLE_GEMINI_MODEL_MAX_TOKENS ?? "900");
    const temperature = Number(process.env.GOOGLE_GEMINI_MODEL_TEMPERATURE ?? (mode === "QUIZ" ? "0.7" : "0.4"));
    const topP = Number(process.env.GOOGLE_GEMINI_MODEL_TOP_P ?? "0.9");

    let upstreamRes: Response | null = null;
    const attemptErrors: string[] = [];
    let usedModel = "";
    let usedEndpoint = "";

    for (const model of modelCandidates) {
      const isGemini = model.startsWith("gemini");

      if (isGemini) {
        for (const version of ["v1beta2", "v1"]) {
          const url = `https://generativelanguage.googleapis.com/${version}/models/${model}:generateContent`;
          const res = await fetch(`${url}?key=${apiKey}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
            body: JSON.stringify({ contents: [{ parts: [{ text: promptText }] }], generationConfig: { temperature, maxOutputTokens } }),
          });

          if (res.ok) {
            upstreamRes = res;
            usedModel = model;
            usedEndpoint = url;
            break;
          }

          const text = await res.text().catch(() => "");
          attemptErrors.push(`model=${model} url=${url} status=${res.status} body=${text}`);
        }
      } else {
        for (const version of ["v1beta2", "v1"]) {
          const url = `https://generativelanguage.googleapis.com/${version}/models/${model}:generateText`;
          const res = await fetch(`${url}?key=${apiKey}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
            body: JSON.stringify({ prompt: { text: promptText }, temperature, topP, maxOutputTokens }),
          });

          if (res.ok) {
            upstreamRes = res;
            usedModel = model;
            usedEndpoint = url;
            break;
          }

          const text = await res.text().catch(() => "");
          attemptErrors.push(`model=${model} url=${url} status=${res.status} body=${text}`);
        }
      }

      if (upstreamRes) break;
    }

    if (!upstreamRes || !upstreamRes.ok) {
      return new Response(JSON.stringify({ error: "LLM request failed", details: attemptErrors.join(" | ") }), { status: 502 });
    }

    // If upstream responded with an event-stream or chunked body, proxy it directly.
    const upstreamContentType = upstreamRes.headers.get("content-type") ?? "";
    if (upstreamRes.body && upstreamContentType.includes("text/event-stream")) {
      // Proxy the upstream event stream directly to the client
      const stream = new ReadableStream({
        async start(controller) {
          const reader = upstreamRes.body!.getReader();
          const encoder = new TextEncoder();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value) {
                // forward raw chunk as-is
                controller.enqueue(value);
              }
            }
          } catch (err) {
            // swallow errors and close
          } finally {
            controller.close();
            try {
              reader.releaseLock();
            } catch {}
          }
        },
      });

      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
        },
      });
    }

    // Fallback: parse JSON and stream chunks as SSE (existing behavior)
    const data = await upstreamRes.json();

    const candidateText =
      data?.candidates?.[0]?.content?.parts?.[0]?.text ??
      data?.candidates?.[0]?.content?.[0]?.text ??
      data?.candidates?.[0]?.output ??
      data?.output?.[0]?.content?.[0]?.text ??
      null;
    const finishReason = data?.candidates?.[0]?.finishReason ?? data?.finishReason ?? null;

    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        function enqueueEvent(text: string) {
          // SSE `data:` event; ensure multiline safety
          const safe = text.replace(/\n/g, "\ndata: ");
          controller.enqueue(encoder.encode(`data: ${safe}\n\n`));
        }

        // send initial chunk
        if (candidateText) enqueueEvent(candidateText);

        // if truncated, attempt continuations and stream them as they arrive
        if (finishReason === "MAX_TOKENS" && usedEndpoint) {
          const maxContinuations = 4; // allow a few continuations when streaming
          for (let i = 0; i < maxContinuations; i++) {
            try {
              const contPrompt = "Lanjutkan jawaban sebelumnya tanpa mengulang teks yang sudah ada.";
              const contBody = usedEndpoint.includes(":generateContent")
                ? JSON.stringify({ contents: [{ parts: [{ text: contPrompt }] }], generationConfig: { temperature, maxOutputTokens } })
                : JSON.stringify({ prompt: { text: contPrompt }, temperature, topP, maxOutputTokens });

              const contRes = await fetch(`${usedEndpoint}?key=${apiKey}`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
                body: contBody,
              });

              if (!contRes.ok) break;

              const contData = await contRes.json();
              const contText =
                contData?.candidates?.[0]?.content?.parts?.[0]?.text ??
                contData?.candidates?.[0]?.content?.[0]?.text ??
                contData?.candidates?.[0]?.output ??
                contData?.output?.[0]?.content?.[0]?.text ??
                null;

              if (contText) enqueueEvent(contText);

              const contFinish = contData?.candidates?.[0]?.finishReason ?? contData?.finishReason ?? null;
              if (contFinish !== "MAX_TOKENS") break;
            } catch (err) {
              break;
            }
          }
        }

        // final done event
        controller.enqueue(encoder.encode("event: done\ndata: {}\n\n"));
        controller.close();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  } catch (e: unknown) {
    const msg = typeof e === "object" && e !== null && "message" in e ? (e as any).message : "Unknown error";
    return new Response(JSON.stringify({ error: msg }), { status: 500 });
  }
}

function buildSystemPrompt({ mode, course }: { mode: TutorMode; course: string }) {
  const common = `
Kamu adalah tutor belajar yang ahli. Jawablah dalam bahasa Indonesia.
Gunakan gaya mengajar yang jelas, runtut, dan mudah dipahami.
Selalu sesuaikan konteks dengan mata kuliah: ${course}.
Jika informasi yang diminta kurang, ajukan pertanyaan klarifikasi singkat sebelum menjawab.`;

  if (mode === "EXPLAIN") {
    return `
MODE EXPLAIN:
- Berikan penjelasan konsep secara step-by-step.
- Sertakan contoh sederhana yang relevan.
- Akhiri dengan ringkasan poin penting.
${common}`;
  }

  return `
MODE QUIZ:
- Buat latihan soal berdasarkan konteks yang sesuai permintaan pengguna.
- Buat minimal 5 soal.
- Gunakan format yang konsisten (misal: pilihan ganda A-D).
- Sertakan kunci jawaban dan pembahasan singkat untuk setiap soal.
${common}`;
}
