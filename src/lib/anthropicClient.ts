import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { HAIKU_4_5_MODEL_ID } from "./pricing.js";
import {
  TopicPickSchema,
  ScoringResponseSchema,
  buildTopicPickPrompt,
  buildScoringPrompt,
} from "./curationPrompt.js";

// Credenciales por entorno (ANTHROPIC_API_KEY): ver .env.example para el
// comentario sobre el tope de gasto mensual configurado en la consola.
const client = new Anthropic();

// No pasamos `thinking`: Haiku 4.5 corre sin thinking extendido a propósito
// (barato y suficiente para elegir un tema o puntuar artículos).
const MAX_TOKENS = 16000;

export interface TopicPickResult {
  topic: string;
  query: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Le pide a la LLM que elija un tema de "descubrimiento" nuevo para el
 * lector, evitando repetir los temas usados recientemente.
 */
export async function pickDiscoveryTopic(
  recentTopics: string[]
): Promise<TopicPickResult> {
  const response = await client.messages.parse({
    model: HAIKU_4_5_MODEL_ID,
    max_tokens: MAX_TOKENS,
    messages: [{ role: "user", content: buildTopicPickPrompt(recentTopics) }],
    output_config: {
      format: zodOutputFormat(TopicPickSchema),
    },
  });

  if (response.parsed_output === null) {
    throw new Error(
      "pickDiscoveryTopic: la respuesta de Anthropic no pudo parsearse según TopicPickSchema."
    );
  }

  return {
    topic: response.parsed_output.topic,
    query: response.parsed_output.query,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}

export interface ArticleScoreResult {
  id: string;
  score: number;
  reason: string;
  discard: boolean;
}

export interface ScoreArticlesResult {
  results: ArticleScoreResult[];
  inputTokens: number;
  outputTokens: number;
}

/**
 * Le pide a la LLM que puntúe una lista de artículos candidatos para el
 * feed personalizado del lector (ver reglas de scoring en curationPrompt.ts).
 */
export async function scoreArticles(
  input: Parameters<typeof buildScoringPrompt>[0]
): Promise<ScoreArticlesResult> {
  const response = await client.messages.parse({
    model: HAIKU_4_5_MODEL_ID,
    max_tokens: MAX_TOKENS,
    messages: [{ role: "user", content: buildScoringPrompt(input) }],
    output_config: {
      format: zodOutputFormat(ScoringResponseSchema),
    },
  });

  if (response.parsed_output === null) {
    throw new Error(
      "scoreArticles: la respuesta de Anthropic no pudo parsearse según ScoringResponseSchema."
    );
  }

  return {
    results: response.parsed_output.articles,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}
