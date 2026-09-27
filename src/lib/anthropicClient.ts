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
 *
 * Ojo: acá NO usamos `client.messages.parse()` como en pickDiscoveryTopic.
 * Ese helper hace `create()` + parseo en una sola promesa: si el parseo
 * falla (por ejemplo, JSON truncado porque la respuesta pisó
 * `max_tokens`), el error se tira DESDE ADENTRO de esa promesa y perdemos
 * el `Message` crudo — no hay forma de distinguir "se truncó" de
 * "el JSON vino mal formado por otra razón". Llamando a `create()`
 * directamente conservamos el `Message` crudo (con `stop_reason`) pase lo
 * que pase con el parseo, así podemos dar un mensaje de error específico.
 * El caller (curate.ts) igual manda candidatos en lotes de ~50-80 para
 * que este límite no se toque en la práctica; este chequeo es una red de
 * seguridad para cuando un lote puntual resulte más pesado de lo previsto.
 */
export async function scoreArticles(
  input: Parameters<typeof buildScoringPrompt>[0]
): Promise<ScoreArticlesResult> {
  const outputFormat = zodOutputFormat(ScoringResponseSchema);

  const response = await client.messages.create({
    model: HAIKU_4_5_MODEL_ID,
    max_tokens: MAX_TOKENS,
    messages: [{ role: "user", content: buildScoringPrompt(input) }],
    output_config: {
      format: outputFormat,
    },
  });

  if (response.stop_reason === "max_tokens") {
    throw new Error(
      `scoreArticles: la respuesta de Anthropic se truncó (stop_reason=max_tokens) ` +
        `con ${input.candidates.length} candidatos en el lote. La respuesta quedó ` +
        `incompleta y no se puede parsear — probá con un batch más chico de candidatos.`
    );
  }

  const textBlock = response.content.find(
    (block): block is Extract<typeof block, { type: "text" }> =>
      block.type === "text"
  );

  if (!textBlock) {
    throw new Error(
      "scoreArticles: la respuesta de Anthropic no incluyó ningún bloque de texto."
    );
  }

  let parsed: { articles: ArticleScoreResult[] };
  try {
    parsed = outputFormat.parse(textBlock.text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `scoreArticles: la respuesta de Anthropic no pudo parsearse según ScoringResponseSchema ` +
        `(stop_reason=${response.stop_reason ?? "desconocido"}): ${message}`
    );
  }

  return {
    results: parsed.articles,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}
