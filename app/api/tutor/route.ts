import { NextResponse } from "next/server";

type TutorMode = "EXPLAIN" | "QUIZ";
type Message = { role: "user" | "assistant"; content: string };

export async function POST(req: Request) {
  try {
    const apiKey = process.env.GOOGLE_AI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "Missing GOOGLE_AI_API_KEY" },
        { status: 500 }
      );
    }

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

    

    const modelCandidates = [
      process.env.GOOGLE_GEMINI_MODEL ?? "gemini-2.5-flash",
      "text-bison-001",
      "chat-bison-001",
    ];
    const maxOutputTokens = Number(process.env.GOOGLE_GEMINI_MODEL_MAX_TOKENS ?? "900");
    const temperature = Number(
      process.env.GOOGLE_GEMINI_MODEL_TEMPERATURE ?? (mode === "QUIZ" ? "0.7" : "0.4")
    );
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
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: promptText }] }],
              generationConfig: { temperature, maxOutputTokens },
            }),
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
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              prompt: { text: promptText },
              temperature,
              topP,
              maxOutputTokens,
            }),
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
      return NextResponse.json(
        {
          error: "LLM request failed",
          details: attemptErrors.length > 0 ? attemptErrors.join(" | ") : "No response from Google API",
        },
        { status: 502 }
      );
    }

    const data = await upstreamRes.json();

    const candidateText =
      data?.candidates?.[0]?.content?.parts?.[0]?.text ??
      data?.candidates?.[0]?.content?.[0]?.text ??
      data?.candidates?.[0]?.output ??
      data?.output?.[0]?.content?.[0]?.text ??
      data?.candidates?.[0]?.content?.[0]?.text ??
      null;
    // detect if model stopped because of token limit and auto-continue
    const finishReason = data?.candidates?.[0]?.finishReason ?? data?.finishReason ?? null;

    let fullText = candidateText ?? "";

    if (finishReason === "MAX_TOKENS" && usedEndpoint) {
      const maxContinuations = 2;
      for (let i = 0; i < maxContinuations; i++) {
        try {
          const contPrompt = "Lanjutkan jawaban sebelumnya dengan singkat tanpa mengulang teks yang sudah ada.";
          const contBody = usedEndpoint.includes(":generateContent")
            ? JSON.stringify({
                contents: [{ parts: [{ text: contPrompt }] }],
                generationConfig: { temperature, maxOutputTokens },
              })
            : JSON.stringify({ prompt: { text: contPrompt }, temperature, topP, maxOutputTokens });

          const contRes = await fetch(`${usedEndpoint}?key=${apiKey}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
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

          if (contText) {
            // append with a separating space
            fullText = `${fullText} ${contText}`.trim();
          }

          const contFinish = contData?.candidates?.[0]?.finishReason ?? contData?.finishReason ?? null;
          if (contFinish !== "MAX_TOKENS") break;
        } catch (err) {
          break;
        }
      }
    }

    if (!fullText) {
      return NextResponse.json(
        { error: "No response text from LLM" },
        { status: 502 }
      );
    }

    return NextResponse.json({ answer: fullText }, { status: 200 });
  } catch (e: unknown) {
    const msg =
      typeof e === "object" && e !== null && "message" in e
        ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (e as any).message
        : "Unknown error";

    return NextResponse.json({ error: msg }, { status: 500 });
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
