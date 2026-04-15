import type { QuickyConfig } from "../types.js";

/** Resolve an API key suitable for OpenAI's embeddings endpoint. */
export function resolveOpenAIKeyForEmbeddings(
  config: QuickyConfig,
): string | undefined {
  if (config.llm.provider === "openai") {
    if (config.llm.apiKey?.trim()) return config.llm.apiKey;
    const env = config.llm.apiKeyEnv || "OPENAI_API_KEY";
    return process.env[env];
  }
  return (
    process.env.OPENAI_API_KEY ||
    (config.llm.apiKeyEnv
      ? process.env[config.llm.apiKeyEnv]
      : undefined) ||
    undefined
  );
}

export async function fetchOpenAIEmbedding(
  text: string,
  apiKey: string,
  model: string,
): Promise<Float32Array> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, input: text }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI embeddings HTTP ${res.status}: ${err.slice(0, 200)}`);
  }
  const data = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
  const emb = data.data?.[0]?.embedding;
  if (!emb?.length) throw new Error("OpenAI embeddings: empty response");
  return Float32Array.from(emb);
}
