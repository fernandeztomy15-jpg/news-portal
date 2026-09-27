import "dotenv/config";
import { supabase } from "./lib/supabase.js";
import { fetchFeed, type FeedItem } from "./lib/rss.js";
import { buildGoogleNewsRssUrl } from "./lib/googleNews.js";
import { HAIKU_4_5_MODEL_ID, estimateCostUsd } from "./lib/pricing.js";
import { MONTHLY_BUDGET_CAP_USD, hasExceededBudget } from "./lib/budget.js";
import {
  pickDiscoveryTopic,
  scoreArticles,
  type ArticleScoreResult,
} from "./lib/anthropicClient.js";

// Las 5 categorías de interés fijas del usuario (tienen fila en
// category_weights). 'descubrimiento' es una categoría aparte, elegida
// por la LLM en cada corrida, y nunca tiene peso propio: el prompt de
// scoring la juzga por calidad general, no por afinidad.
const INTEREST_CATEGORIES = [
  "macro",
  "mercado",
  "tech",
  "emprendimientos",
  "deportes",
];

const LIKED_SAMPLE_SIZE = 30;

type CandidateArticle = {
  id: string;
  title: string;
  summary: string | null;
  category: string;
};

async function insertRunningRow(): Promise<string> {
  const { data, error } = await supabase
    .from("curation_runs")
    .insert({ status: "running" })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(
      `No pude crear la fila de curation_runs: ${error?.message}`
    );
  }
  return data.id as string;
}

async function updateRun(
  runId: string,
  patch: Record<string, unknown>
): Promise<void> {
  const { error } = await supabase
    .from("curation_runs")
    .update(patch)
    .eq("id", runId);

  if (error) {
    throw new Error(
      `No pude actualizar curation_runs (id=${runId}): ${error.message}`
    );
  }
}

// Suma estimated_cost_usd de todas las corridas del mes en curso,
// EXCLUYENDO la fila recién creada para esta corrida (por id, no por
// timestamp: es exacto incluso si started_at cae justo en el borde
// del mes o hay desfasaje de reloj).
async function getSpentThisMonthUsd(excludeRunId: string): Promise<number> {
  const now = new Date();
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  ).toISOString();

  const { data, error } = await supabase
    .from("curation_runs")
    .select("estimated_cost_usd")
    .gte("started_at", monthStart)
    .neq("id", excludeRunId);

  if (error) {
    throw new Error(
      `No pude sumar el gasto del mes en curation_runs: ${error.message}`
    );
  }

  return (data ?? []).reduce(
    (sum, row) => sum + (Number(row.estimated_cost_usd) || 0),
    0
  );
}

async function getRecentDiscoveryTopics(): Promise<string[]> {
  const fourteenDaysAgo = new Date(
    Date.now() - 14 * 24 * 60 * 60 * 1000
  ).toISOString();

  const { data, error } = await supabase
    .from("curation_runs")
    .select("discovery_topic")
    .not("discovery_topic", "is", null)
    .gte("started_at", fourteenDaysAgo);

  if (error) {
    throw new Error(
      `No pude leer discovery_topic recientes de curation_runs: ${error.message}`
    );
  }

  return (data ?? [])
    .map((row) => row.discovery_topic as string | null)
    .filter((topic): topic is string => Boolean(topic));
}

async function getUncuratedInterestArticles(): Promise<CandidateArticle[]> {
  const { data, error } = await supabase
    .from("articles")
    .select("id, title, summary, category")
    .is("curated_at", null)
    .in("category", INTEREST_CATEGORIES);

  if (error) {
    throw new Error(
      `No pude leer artículos sin curar de las categorías de interés: ${error.message}`
    );
  }
  return data ?? [];
}

// Inserta los artículos de descubrimiento recién traídos por RSS
// (todavía no existen en 'articles') y devuelve solo los que
// efectivamente se insertaron. Mismo patrón que ingestSource() en
// ingest.ts: onConflict('url') + ignoreDuplicates para dedupe real a
// nivel DB, sin fila de 'sources' asociada (source_id=null).
async function insertDiscoveryArticles(
  items: FeedItem[]
): Promise<CandidateArticle[]> {
  if (items.length === 0) return [];

  const rows = items.map((item) => ({
    source_id: null,
    category: "descubrimiento",
    title: item.title,
    url: item.url,
    summary: item.summary,
    published_at: item.publishedAt,
    raw: item.raw,
  }));

  const { data, error } = await supabase
    .from("articles")
    .upsert(rows, { onConflict: "url", ignoreDuplicates: true })
    .select("id, title, summary, category");

  if (error) {
    throw new Error(
      `No pude insertar artículos de descubrimiento: ${error.message}`
    );
  }
  return data ?? [];
}

async function getSampleTitles(liked: boolean): Promise<string[]> {
  const { data, error } = await supabase
    .from("articles")
    .select("title")
    .eq("liked", liked)
    .limit(LIKED_SAMPLE_SIZE);

  if (error) {
    throw new Error(
      `No pude leer artículos con liked=${liked}: ${error.message}`
    );
  }
  return (data ?? []).map((row) => row.title as string);
}

async function getCategoryWeights(): Promise<Record<string, number>> {
  const { data, error } = await supabase
    .from("category_weights")
    .select("category, weight");

  if (error) {
    throw new Error(`No pude leer category_weights: ${error.message}`);
  }

  const weights: Record<string, number> = {};
  for (const row of data ?? []) {
    weights[row.category as string] = Number(row.weight);
  }
  return weights;
}

async function persistArticleScore(result: ArticleScoreResult): Promise<void> {
  const { error } = await supabase
    .from("articles")
    .update({
      score: result.score,
      reason: result.reason,
      discarded: result.discard,
      curated_at: new Date().toISOString(),
    })
    .eq("id", result.id);

  if (error) {
    throw new Error(
      `No pude actualizar articles (id=${result.id}) con el resultado del scoring: ${error.message}`
    );
  }
}

async function main() {
  // Paso 1: registrar el inicio de la corrida ANTES de gastar nada — si
  // el proceso muere a mitad de camino, igual queda rastro (mismo
  // motivo que ingestion_runs en ingest.ts).
  const runId = await insertRunningRow();

  try {
    // Paso 2: freno de presupuesto. Se chequea ANTES de cualquier
    // llamada a la LLM, incluso antes de elegir el tema de
    // descubrimiento — el orden importa: nada de esto se ejecuta si ya
    // gastamos el tope del mes.
    const spentThisMonth = await getSpentThisMonthUsd(runId);
    if (hasExceededBudget(spentThisMonth, MONTHLY_BUDGET_CAP_USD)) {
      await updateRun(runId, {
        status: "skipped_budget",
        finished_at: new Date().toISOString(),
      });
      console.warn(
        `Presupuesto mensual excedido (gastado=$${spentThisMonth.toFixed(4)}, ` +
          `tope=$${MONTHLY_BUDGET_CAP_USD}). Corrida saltada, sin llamar a la LLM.`
      );
      process.exit(0);
    }

    // Paso 3: elegir tema de descubrimiento (Llamada LLM #1), evitando
    // repetir temas usados en los últimos 14 días.
    const recentTopics = await getRecentDiscoveryTopics();
    const discoveryPick = await pickDiscoveryTopic(recentTopics);

    let totalInputTokens = discoveryPick.inputTokens;
    let totalOutputTokens = discoveryPick.outputTokens;

    // Paso 4: traer artículos de descubrimiento vía Google News RSS. Un
    // fallo acá NO aborta la corrida — mismo criterio de tolerancia a
    // fallos que fetchFeed ya usa en ingest.ts — se trata como cero
    // artículos de descubrimiento.
    const discoveryQueryUrl = buildGoogleNewsRssUrl(discoveryPick.query);
    const discoveryFeedResult = await fetchFeed(discoveryQueryUrl);
    if (!discoveryFeedResult.ok) {
      console.warn(
        `fetchFeed de descubrimiento falló (${discoveryQueryUrl}): ${discoveryFeedResult.error}`
      );
    }
    const discoveryItems = discoveryFeedResult.ok
      ? discoveryFeedResult.items
      : [];

    // Paso 5: candidatos ya existentes en las categorías de interés.
    const interestCandidates = await getUncuratedInterestArticles();

    // Paso 6: insertar los de descubrimiento (todavía no existen en
    // 'articles') y sumarlos a la lista de candidatos.
    const discoveryCandidates = await insertDiscoveryArticles(discoveryItems);
    const candidates: CandidateArticle[] = [
      ...interestCandidates,
      ...discoveryCandidates,
    ];

    if (candidates.length === 0) {
      // Paso 7: nada para puntuar — cerrar la corrida sin llamar a
      // scoreArticles. La Llamada #1 (pickDiscoveryTopic) sí se hizo y
      // tuvo costo real, así que igual se registra su tokens/costo acá
      // (más allá de lo mínimo que pide el brief) para que el chequeo
      // de presupuesto del paso 2 lo contabilice en corridas futuras —
      // de lo contrario, corridas repetidas sin candidatos gastarían
      // dinero real sin que el freno de presupuesto se enterara nunca.
      await updateRun(runId, {
        status: "ok",
        finished_at: new Date().toISOString(),
        model: HAIKU_4_5_MODEL_ID,
        input_tokens: totalInputTokens,
        output_tokens: totalOutputTokens,
        estimated_cost_usd: estimateCostUsd(
          totalInputTokens,
          totalOutputTokens
        ),
        discovery_topic: discoveryPick.topic,
        discovery_query_url: discoveryQueryUrl,
        articles_scored: 0,
        articles_discarded: 0,
      });
      console.log("Sin candidatos para puntuar. Corrida cerrada.");
      return;
    }

    // Paso 8: puntuar candidatos (Llamada LLM #2).
    const [likedTitles, dislikedTitles, weights] = await Promise.all([
      getSampleTitles(true),
      getSampleTitles(false),
      getCategoryWeights(),
    ]);

    const scoring = await scoreArticles({
      weights,
      likedTitles,
      dislikedTitles,
      candidates: candidates.map(({ id, title, summary, category }) => ({
        id,
        title,
        summary,
        category,
      })),
    });

    totalInputTokens += scoring.inputTokens;
    totalOutputTokens += scoring.outputTokens;

    // Paso 9: persistir el resultado de cada artículo puntuado.
    // Secuencial y no Promise.all: mismo criterio que ingest.ts (logs
    // legibles, sin competir por recursos).
    for (const result of scoring.results) {
      await persistArticleScore(result);
    }

    // Paso 10: cerrar la corrida con el costo total (Llamada #1 +
    // Llamada #2) y el resumen de lo puntuado.
    const articlesScored = scoring.results.length;
    const articlesDiscarded = scoring.results.filter((r) => r.discard).length;

    await updateRun(runId, {
      status: "ok",
      finished_at: new Date().toISOString(),
      model: HAIKU_4_5_MODEL_ID,
      input_tokens: totalInputTokens,
      output_tokens: totalOutputTokens,
      estimated_cost_usd: estimateCostUsd(totalInputTokens, totalOutputTokens),
      discovery_topic: discoveryPick.topic,
      discovery_query_url: discoveryQueryUrl,
      articles_scored: articlesScored,
      articles_discarded: articlesDiscarded,
    });

    console.log(
      `Corrida OK — ${articlesScored} artículos puntuados, ${articlesDiscarded} descartados.`
    );
  } catch (err) {
    // Paso 11: cualquier excepción desde el paso 2 en adelante se
    // captura acá — la corrida queda marcada como error en vez de morir
    // en silencio, y el proceso sale con código de error sin lanzar la
    // excepción sin capturar (mismo espíritu que main().catch() más
    // abajo, pero acá alcanza a dejar rastro en curation_runs).
    const message = err instanceof Error ? err.message : String(err);
    console.error("Corrida de curación falló:", message);
    process.exitCode = 1;

    try {
      await updateRun(runId, {
        status: "error",
        error_message: message,
        finished_at: new Date().toISOString(),
      });
    } catch (updateErr) {
      console.error(
        "Además, no pude registrar el error en curation_runs:",
        updateErr
      );
    }
  }
}

main().catch((err) => {
  console.error("Fallo fatal del script de curación:", err);
  process.exit(1);
});
