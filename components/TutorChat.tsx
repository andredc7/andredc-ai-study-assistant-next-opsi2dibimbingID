"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type TutorMode = "EXPLAIN" | "QUIZ";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

const STORAGE_KEY = "ai_study_assistant_messages_v1";

const COURSE_OPTIONS = [
  "Kalkulus",
  "Pemrograman Dasar",
  "Statistika",
  "Struktur Data",
  "Kecerdasan Buatan",
];

function safeParseMessages(raw: string | null): ChatMessage[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (m) =>
          m &&
          typeof m === "object" &&
          (m as ChatMessage).role &&
          typeof (m as ChatMessage).content === "string"
      )
      .map((m) => ({ role: (m as ChatMessage).role, content: (m as ChatMessage).content }));
  } catch {
    return [];
  }
}

export default function TutorChat() {
  const [mode, setMode] = useState<TutorMode>("EXPLAIN");
  const [course, setCourse] = useState<string>(COURSE_OPTIONS[0] ?? "Umum");
  const [message, setMessage] = useState<string>("");
  const [isLoading, setIsLoading] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [error, setError] = useState<string | null>(null);

  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // Read sessionStorage once after mount (client-only).
    // Avoid setState sync warnings by doing it as a microtask.
    queueMicrotask(() => {
      setMessages(safeParseMessages(sessionStorage.getItem(STORAGE_KEY)));
    });
  }, []);


  useEffect(() => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
  }, [messages]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  const canSubmit = useMemo(() => {
    return !isLoading && message.trim().length > 0;
  }, [isLoading, message]);

  async function submit() {
    const trimmed = message.trim();
    if (!trimmed) return;

    setError(null);
    setIsLoading(true);

    const nextUser: ChatMessage = { role: "user", content: trimmed };

    // Optimistic UI: tampilkan user dulu
    const historyForApi: ChatMessage[] = [...messages];
    setMessages((prev) => [...prev, nextUser]);
    setMessage("");

    try {
      // Use streaming endpoint to receive progressive updates
      const postBody = JSON.stringify({ message: trimmed, mode, course, history: historyForApi });

      // add an assistant placeholder to messages and remember its index
      const assistantPlaceholder: ChatMessage = { role: "assistant", content: "" };
      const displayMessages: ChatMessage[] = [...historyForApi, nextUser, assistantPlaceholder];
      const assistantIndex = displayMessages.length - 1;
      setMessages(displayMessages);

      const res = await fetch("/api/tutor/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: postBody,
      });

      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        throw new Error(`Request failed: ${res.status} ${text}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let doneStream = false;

      while (!doneStream) {
        const { value, done } = await reader.read();
        if (value) {
          buffer += decoder.decode(value, { stream: true });

          // process SSE-style events separated by double newlines
          let index;
          while ((index = buffer.indexOf('\n\n')) !== -1) {
            const raw = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);

            const lines = raw.split(/\r?\n/);
            let dataLines: string[] = [];
            let eventName = "message";
            for (const line of lines) {
              if (line.startsWith("event:")) eventName = line.replace(/^event:\s*/, "");
              if (line.startsWith("data:")) dataLines.push(line.replace(/^data:\s*/, ""));
            }

            const data = dataLines.join('\n');
            if (eventName === "done") {
              doneStream = true;
              break;
            }

            if (data) {
              // append chunk to assistant message at assistantIndex
              setMessages((prev) =>
                prev.map((m, i) => (i === assistantIndex ? { ...m, content: (m.content || "") + data } : m))
              );
            }
          }
        }

        if (done) break;
      }

      // ensure any remaining buffer (unlikely) is applied
      if (buffer.trim()) {
        setMessages((prev) => prev.map((m, i) => (i === assistantIndex ? { ...m, content: (m.content || "") + buffer } : m)));
      }
    } catch (e) {
      const msg = typeof e === "object" && e !== null && "message" in e ? (e as any).message : "Unknown error";
      setError(msg);

      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "Maaf, terjadi kesalahan saat memproses permintaan. Silakan coba lagi.",
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  }

  function resetSession() {
    sessionStorage.removeItem(STORAGE_KEY);
    setMessages([]);
    setMessage("");
    setError(null);
    setMode("EXPLAIN");
    setCourse(COURSE_OPTIONS[0] ?? "Umum");
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="rounded-2xl border border-zinc-200 bg-white p-4 sm:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-zinc-900">Tutor AI</h2>
            <p className="text-sm text-zinc-600">Pilih mode, pilih mata kuliah, lalu ajukan pertanyaan.</p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-2 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2">
              <span className="text-sm font-medium text-zinc-700">Mode</span>
              <button
                type="button"
                onClick={() => setMode("EXPLAIN")}
                className={`rounded-lg px-3 py-1 text-sm font-semibold transition ${
                  mode === "EXPLAIN"
                    ? "bg-violet-600 text-white"
                    : "bg-white text-zinc-700 hover:bg-zinc-100"
                }`}
              >
                Explain
              </button>
              <button
                type="button"
                onClick={() => setMode("QUIZ")}
                className={`rounded-lg px-3 py-1 text-sm font-semibold transition ${
                  mode === "QUIZ"
                    ? "bg-violet-600 text-white"
                    : "bg-white text-zinc-700 hover:bg-zinc-100"
                }`}
              >
                Quiz
              </button>
            </div>

            <select
              value={course}
              onChange={(e) => setCourse(e.target.value)}
              className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-800"
              aria-label="Pilih mata kuliah"
            >
              {COURSE_OPTIONS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
              {!COURSE_OPTIONS.includes(course) && (
                <option value={course}>{course}</option>
              )}
            </select>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-zinc-200 bg-white overflow-hidden">
        <div className="max-h-[46vh] sm:max-h-[52vh] overflow-auto p-4 sm:p-6">
          {messages.length === 0 ? (
            <div className="text-center text-zinc-600 py-12">
              <p className="font-medium text-zinc-700">Belum ada percakapan.</p>
              <p className="text-sm">Tulis pertanyaanmu di bawah, lalu klik <b>Kirim</b>.</p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {messages.map((m, idx) => (
                <div
                  key={idx}
                  className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[90%] whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-sm border ${
                      m.role === "user"
                        ? "bg-violet-600 text-white border-violet-600"
                        : "bg-zinc-50 text-zinc-900 border-zinc-200"
                    }`}
                  >
                    {m.content}
                  </div>
                </div>
              ))}
              {isLoading && (
                <div className="flex justify-start">
                  <div className="max-w-[90%] rounded-2xl bg-zinc-50 border border-zinc-200 px-4 py-3 text-sm text-zinc-700">
                    Sedang berpikir...
                  </div>
                </div>
              )}
              <div ref={endRef} />
            </div>
          )}
        </div>

        <div className="border-t border-zinc-200 p-4 sm:p-6">
          <label className="block text-sm font-medium text-zinc-700 mb-2" htmlFor="user-message">
            Pertanyaan
          </label>
          <textarea
            id="user-message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={
              mode === "EXPLAIN"
                ? `Contoh: Jelaskan konsep integral tentu dengan langkah-langkah singkat.`
                : `Contoh: Buat quiz tentang statistika deskriptif untuk mahasiswa.`
            }
            className="w-full min-h-[110px] resize-y rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-violet-500"
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                e.preventDefault();
                if (canSubmit) submit();
              }
            }}
          />

          <div className="mt-3 flex flex-col sm:flex-row gap-2 sm:items-center sm:justify-between">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={submit}
                disabled={!canSubmit}
                className={`rounded-xl px-4 py-2 text-sm font-semibold transition border ${
                  canSubmit
                    ? "bg-violet-600 border-violet-600 text-white hover:bg-violet-700"
                    : "bg-violet-300 border-violet-300 text-white cursor-not-allowed"
                }`}
              >
                {isLoading ? "Mengirim..." : "Kirim"}
              </button>
              <button
                type="button"
                onClick={resetSession}
                disabled={isLoading}
                className="rounded-xl px-4 py-2 text-sm font-semibold transition bg-white border border-zinc-200 text-zinc-700 hover:bg-zinc-50 disabled:opacity-60"
              >
                Reset Sesi
              </button>
            </div>

            <div className="text-xs text-zinc-500">
              Tip: Ctrl/Cmd + Enter untuk kirim.
            </div>
          </div>

          {error && (
            <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

