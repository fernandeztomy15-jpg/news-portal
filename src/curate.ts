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
import { MAX_ARTICLES_PER_CATEGORY, selectOverflowIds } from "./lib/categoryCap.js";

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

const ALL_CATEGORIES = [...INTEREST_CATEGORIES, "descubrimiento"];

const LIKED_SAMPLE_SIZE = 30;

// Ventana de "reciente" para candidatos a puntuar: coincide a propósito
// con DIGEST_WINDOW_HOURS del frontend (web/src/lib/queries.ts) — no
// tiene sentido curar (y gastar tokens en) artículos que la UI nunca va
// a mostrar porque ya cayeron fuera de la ventana de 48hs del digest.
// También acota el volumen de candidatos a un rango manejable: sin este
// filtro, la primera corrida después de una migración vería TODO el
// backlog histórico con curated_at is null.
const CANDIDATE_RECENCY_HOURS = 48;

// Tamaño de lote para scoreArticles. Con max_tokens=16000 en la
// respuesta, un solo llamado con 500-1000+ candidatos (5 feeds de Google
// News x ~100 items, más el backlog) trunca el JSON de salida y hace
// fallar el parseo entero. Lotes de ~60 mantienen la respuesta bien por
// debajo del límite con margen para reasons descriptivas.
const SCORING_BATCH_SIZE = 60;

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

function getRecencyWindowStartIso(): string {
  return new Date(
    Date.now() - CANDIDATE_RECENCY_HOURS * 60 * 60 * 1000
  ).toISOString();
}

async function getUncuratedInterestArticles(): Promise<CandidateArticle[]> {
  const { data, error } = await supabase
    .from("articles")
    .select("id, title, summary, category")
    .is("curated_at", null)
    .in("category", INTEREST_CATEGORIES)
    .gte("fetched_at", getRecencyWindowStartIso());

  if (error) {
    throw new Error(
      `No pude leer artículos sin curar de las categorías de interés: ${error.message}`
    );
  }
  return data ?? [];
}

// Artículos de 'descubrimiento' insertados en una corrida anterior que
// quedaron sin puntuar (curated_at is null) — por ejemplo porque esa
// corrida falló en el paso de scoring después de insertarlos. Sin esto
// quedarían huérfanos para siempre: la query de arriba solo mira las 5
// categorías de interés, nunca 'descubrimiento'. Misma ventana de
// recencia que el resto, para no resucitar un backlog viejo sin límite.
async function getUncuratedDiscoveryArticles(): Promise<CandidateArticle[]> {
  const { data, error } = await supabase
    .from("articles")
    .select("id, title, summary, category")
    .is("curated_at", null)
    .eq("category", "descubrimiento")
    .gte("fetched_at", getRecencyWindowStartIso());

  if (error) {
    throw new Error(
      `No pude leer artículos de descubrimiento sin curar: ${error.message}`
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

// Aplica el tope duro de MAX_ARTICLES_PER_CATEGORY sobre los artículos
// actualmente activos (discarded=false) de cada categoría, sin importar
// en qué corrida se hayan puntuado. Corre después de persistir los
// resultados del scoring, como red de seguridad independiente del
// criterio de descarte de la LLM (ver categoryCap.ts).
async function enforceCategoryCap(): Promise<void> {
  for (const category of ALL_CATEGORIES) {
    const { data, error } = await supabase
      .from("articles")
      .select("id, score")
      .eq("category", category)
      .eq("discarded", false);

    if (error) {
      throw new Error(
        `No pude leer artículos activos de '${category}' para aplicar el tope: ${error.message}`
      );
    }

    const overflowIds = selectOverflowIds(
      (data ?? []) as Array<{ id: string; score: number | null }>,
      MAX_ARTICLES_PER_CATEGORY
    );
    if (overflowIds.length === 0) continue;

    const { error: updateError } = await supabase
      .from("articles")
      .update({ discarded: true })
      .in("id", overflowIds);

    if (updateError) {
      throw new Error(
        `No pude aplicar el tope de ${MAX_ARTICLES_PER_CATEGORY} en '${category}': ${updateError.message}`
      );
    }
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

async function main() {
  // Paso 1: registrar el inicio de la corrida ANTES de gastar nada — si
  // el proceso muere a mitad de camino, igual queda rastro (mismo
  // motivo que ingestion_runs en ingest.ts).
  const runId = await insertRunningRow();

  // Declarados ACÁ AFUERA del try (no con `let` adentro) a propósito: si
  // el catch-all del paso 11 necesita registrar el gasto acumulado hasta
  // el momento del fallo, tiene que poder leer estas variables. Un `let`
  // declarado dentro del bloque try no es visible desde su catch en JS —
  // ese era justamente el bug: la llamada a pickDiscoveryTopic (y
  // cualquier lote de scoreArticles que sí hubiera completado antes de
  // que un lote posterior fallara) nunca se registraba en curation_runs
  // cuando la corrida terminaba en error, y el freno de presupuesto del
  // paso 2 quedaba ciego a ese gasto real para siempre.
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let articlesScored = 0;
  let articlesDiscarded = 0;

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

    totalInputTokens += discoveryPick.inputTokens;
    totalOutputTokens += discoveryPick.outputTokens;

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

    // Paso 5: candidatos ya existentes en las categorías de interés, más
    // artículos de 'descubrimiento' de corridas anteriores que quedaron
    // sin puntuar (ver getUncuratedDiscoveryArticles) — así, si el paso
    // de scoring de una corrida previa falló después de insertarlos,
    // esta corrida los vuelve a intentar en vez de dejarlos huérfanos
    // para siempre.
    const [interestCandidates, previouslyUncuratedDiscovery] =
      await Promise.all([
        getUncuratedInterestArticles(),
        getUncuratedDiscoveryArticles(),
      ]);

    // Paso 6: insertar los de descubrimiento recién traídos por RSS
    // (todavía no existen en 'articles') y sumarlos a la lista de
    // candidatos. insertDiscoveryArticles usa ignoreDuplicates, así que
    // solo devuelve filas nuevas — no puede pisarse con
    // previouslyUncuratedDiscovery.
    const discoveryCandidates = await insertDiscoveryArticles(discoveryItems);
    const candidates: CandidateArticle[] = [
      ...interestCandidates,
      ...previouslyUncuratedDiscovery,
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

    // Paso 8: puntuar candidatos (Llamadas LLM #2, #3, ... una por lote).
    // Un solo llamado con todos los candidatos puede superar los ~250
    // artículos que caben en max_tokens=16000 de respuesta y truncar el
    // JSON (ver anthropicClient.ts). Partimos en lotes de
    // SCORING_BATCH_SIZE y llamamos a scoreArticles una vez por lote,
    // sin cambiar su firma.
    const [likedTitles, dislikedTitles, weights] = await Promise.all([
      getSampleTitles(true),
      getSampleTitles(false),
      getCategoryWeights(),
    ]);

    const batches = chunk(candidates, SCORING_BATCH_SIZE);

    for (const [batchIndex, batch] of batches.entries()) {
      // ids realmente enviados a la LLM en ESTE lote — cualquier id que
      // la LLM devuelva y no esté acá es descartado antes de tocar la
      // base (id inventado, mal formado, o de otro lote). Evita que un
      // solo id inválido en la respuesta aborte la corrida entera al
      // intentar un update con un uuid inválido.
      const sentIds = new Set(batch.map((c) => c.id));

      const scoring = await scoreArticles({
        weights,
        likedTitles,
        dislikedTitles,
        candidates: batch.map(({ id, title, summary, category }) => ({
          id,
          title,
          summary,
          category,
        })),
      });

      // Acumulamos tokens de este lote ANTES de persistir, para que si
      // persistArticleScore tira más abajo, el catch-all del paso 11 ya
      // vea el gasto de este lote reflejado en totalInputTokens/
      // totalOutputTokens.
      totalInputTokens += scoring.inputTokens;
      totalOutputTokens += scoring.outputTokens;

      // Persistimos los resultados de ESTE lote ya, en vez de acumular
      // todo y persistir al final — así, si un lote posterior falla, el
      // trabajo de los lotes anteriores no se pierde.
      for (const result of scoring.results) {
        if (!sentIds.has(result.id)) {
          console.warn(
            `Lote ${batchIndex + 1}/${batches.length}: la LLM devolvió un id ` +
              `que no corresponde a ningún candidato de este lote (id=${result.id}). ` +
              `Se ignora ese resultado, no se persiste.`
          );
          continue;
        }
        await persistArticleScore(result);
        articlesScored += 1;
        if (result.discard) {
          articlesDiscarded += 1;
        }
      }
    }

    // Paso 9.5: tope duro por categoría — red de seguridad además del
    // criterio de descarte de la LLM (ver enforceCategoryCap).
    await enforceCategoryCap();

    // Paso 10: cerrar la corrida con el costo total (Llamada #1 + todas
    // las llamadas de scoring) y el resumen de lo REALMENTE puntuado
    // (no lo que la LLM dijo que devolvía, sino lo que se persistió).
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
      // Incluso en error registramos model/tokens/costo acumulados hasta
      // el momento del fallo (posiblemente $0 si falló antes de la
      // primera llamada a la LLM) — así el chequeo de presupuesto del
      // paso 2 nunca subestima el gasto real de una corrida fallida,
      // sea cual sea el paso en el que reventó.
      await updateRun(runId, {
        status: "error",
        error_message: message,
        finished_at: new Date().toISOString(),
        model: HAIKU_4_5_MODEL_ID,
        input_tokens: totalInputTokens,
        output_tokens: totalOutputTokens,
        estimated_cost_usd: estimateCostUsd(
          totalInputTokens,
          totalOutputTokens
        ),
        articles_scored: articlesScored,
        articles_discarded: articlesDiscarded,
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
