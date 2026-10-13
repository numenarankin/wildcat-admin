import { mistral } from "@ai-sdk/mistral";
import { embed, embedMany } from "ai";

/**
 * Text embeddings via Mistral `mistral-embed`. Produces 1024-dim vectors, which
 * must match `document_chunks.embedding` / `agent_memory.embedding` in the
 * Supabase schema. Changing the model means changing the column dimension and
 * re-embedding the corpus.
 */
export const EMBEDDING_MODEL = "mistral-embed";
export const EMBEDDING_DIMENSIONS = 1024;

function model() {
  return mistral.textEmbeddingModel(EMBEDDING_MODEL);
}

/** Embed a single string (e.g. a search query or one memory). */
export async function embedText(value: string): Promise<number[]> {
  const { embedding } = await embed({ model: model(), value });
  return embedding;
}

/** Embed many strings at once (e.g. all chunks of a document). */
export async function embedTexts(values: string[]): Promise<number[][]> {
  if (values.length === 0) return [];
  const { embeddings } = await embedMany({ model: model(), values });
  return embeddings;
}
