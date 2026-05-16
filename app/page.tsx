export default function Home() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6">
      <h1 className="text-2xl font-bold">AI Study Assistant</h1>
      <p className="mt-2 text-zinc-600">Andre Dwiyanto Cahyana · OPSI 2</p>
      <a
        href="/chat"
        className="mt-6 rounded-xl bg-violet-600 px-4 py-2 text-white font-semibold hover:bg-violet-700 transition"
      >
        Mulai Belajar
      </a>
    </div>
  );
}
