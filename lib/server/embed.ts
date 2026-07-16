// bge-m3 임베딩 (Ollama) + 코사인 유사도 (설계서 §4.3)
const OLLAMA = process.env.OLLAMA_URL ?? "http://localhost:11434";
const EMBED_MODEL = process.env.EMBED_MODEL ?? "bge-m3";

export async function embed(inputs: string[]): Promise<number[][]> {
  const r = await fetch(`${OLLAMA}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: inputs }),
  });
  if (!r.ok) throw new Error(`embed ${r.status}`);
  const j = (await r.json()) as { embeddings: number[][] };
  return j.embeddings;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}
