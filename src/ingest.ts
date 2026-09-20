import "dotenv/config";
import { supabase, type SourceRow } from "./lib/supabase.js";
import { fetchFeed } from "./lib/rss.js";

async function getActiveSources(): Promise<SourceRow[]> {
  const { data, error } = await supabase
    .from("sources")
    .select("id, name, category, feed_url, source_type, active")
    .eq("active", true);

  if (error) throw new Error(`No pude leer 'sources': ${error.message}`);
  return data ?? [];
}

async function ingestSource(source: SourceRow) {
  const startedAt = new Date().toISOString();

  // Registro el inicio de la corrida ANTES de fetchear: si el proceso
  // muere a mitad de camino (timeout duro, OOM, etc.), igual queda
  // rastro de que arrancó y no terminó, en vez de no quedar nada.
  const { data: runRow, error: runInsertError } = await supabase
    .from("ingestion_runs")
    .insert({ source_id: source.id, started_at: startedAt, status: "running" })
    .select("id")
    .single();

  if (runInsertError || !runRow) {
    console.error(
      `[${source.id}] no pude crear el registro de ingestion_runs:`,
      runInsertError?.message
    );
    return;
  }

  if (source.source_type !== "rss" || !source.feed_url) {
    await supabase
      .from("ingestion_runs")
      .update({
        finished_at: new Date().toISOString(),
        status: "skipped",
        error_message: "Fuente sin feed_url RSS confirmada (source_type != rss o feed_url null).",
      })
      .eq("id", runRow.id);
    console.warn(`[${source.id}] SKIPPED — sin feed_url RSS.`);
    return;
  }

  const result = await fetchFeed(source.feed_url);

  if (!result.ok) {
    await supabase
      .from("ingestion_runs")
      .update({
        finished_at: new Date().toISOString(),
        status: "error",
        error_message: result.error,
      })
      .eq("id", runRow.id);
    console.error(`[${source.id}] ERROR: ${result.error}`);
    return;
  }

  const rows = result.items.map((item) => ({
    source_id: source.id,
    category: source.category,
    title: item.title,
    url: item.url,
    summary: item.summary,
    published_at: item.publishedAt,
    raw: item.raw,
  }));

  // onConflict('url') + ignoreDuplicates: dedupe real a nivel DB.
  // Si el mismo artículo aparece en dos corridas, no se duplica ni
  // pisa contenido ya guardado.
  const { data: inserted, error: upsertError } = await supabase
    .from("articles")
    .upsert(rows, { onConflict: "url", ignoreDuplicates: true })
    .select("id");

  if (upsertError) {
    await supabase
      .from("ingestion_runs")
      .update({
        finished_at: new Date().toISOString(),
        status: "error",
        items_found: rows.length,
        error_message: upsertError.message,
      })
      .eq("id", runRow.id);
    console.error(`[${source.id}] ERROR al insertar: ${upsertError.message}`);
    return;
  }

  await supabase
    .from("ingestion_runs")
    .update({
      finished_at: new Date().toISOString(),
      status: "ok",
      items_found: rows.length,
      items_inserted: inserted?.length ?? 0,
    })
    .eq("id", runRow.id);

  console.log(
    `[${source.id}] OK — ${rows.length} items en el feed, ${inserted?.length ?? 0} nuevos insertados.`
  );
}

async function main() {
  const sources = await getActiveSources();

  if (sources.length === 0) {
    console.warn(
      "No hay fuentes activas en la tabla 'sources'. Revisá supabase/schema.sql " +
        "o activá alguna con: update sources set active = true where id = '...';"
    );
    return;
  }

  console.log(`Corriendo ingesta para ${sources.length} fuente(s) activa(s)...`);

  // Secuencial y no Promise.all: así los logs quedan legibles y un
  // timeout de una fuente no compite por recursos con las demás.
  for (const source of sources) {
    await ingestSource(source);
  }

  console.log("Ingesta terminada.");
}

main().catch((err) => {
  console.error("Fallo fatal del script de ingesta:", err);
  process.exit(1);
});
