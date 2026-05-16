import Link from "next/link";
import TutorChat from "@/components/TutorChat";

export default function ChatPage() {
  return (
    <div className="min-h-screen bg-zinc-50">
      <header className="mx-auto max-w-6xl px-4 py-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Tutor AI</h1>
          <p className="text-zinc-600 text-sm">
            Jelaskan konsep atau latihan soal sesuai mode.
          </p>
        </div>
        <Link
          href="/"
          className="rounded-xl border border-zinc-200 bg-white px-4 py-2 text-sm font-semibold hover:bg-zinc-50 transition"
        >
          Kembali ke Landing
        </Link>
      </header>


      <main className="mx-auto max-w-6xl px-4 pb-16">
        <TutorChat />
      </main>
    </div>
  );
}
