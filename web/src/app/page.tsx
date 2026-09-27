import { supabase } from "@/lib/supabaseClient";
import {
  CATEGORY_ORDER,
  getDigestWindowStart,
  groupArticlesByCategory,
  type ArticleRow,
} from "@/lib/queries";
import { ArticleCard } from "./components/ArticleCard";

const CATEGORY_LABELS: Record<(typeof CATEGORY_ORDER)[number], string> = {
  macro: "Macro",
  mercado: "Mercado",
  tech: "Tech",
  emprendimientos: "Emprendimientos",
  deportes: "Deportes",
  descubrimiento: "Descubrimiento",
};

export default async function Home() {
  const { data, error } = await supabase
    .from("articles")
    .select(
      "id, title, url, category, score, reason, liked, curated_at, source:sources(name)"
    )
    .eq("discarded", false)
    .gte("curated_at", getDigestWindowStart(new Date()).toISOString())
    .order("score", { ascending: false });

  if (error) {
    throw new Error(`No se pudo cargar el digest: ${error.message}`);
  }

  // The untyped Supabase client (no generated `Database` types) cannot
  // infer join cardinality from the select string alone, so it widens the
  // embedded `source:sources(name)` relation to an array in its static
  // types. At runtime, PostgREST returns a single object (or null) here
  // because `articles.source_id -> sources.id` is many-to-one, matching
  // the `ArticleRow["source"]` contract from Tarea 9. Bridge via
  // `unknown` since the inferred and declared shapes don't overlap.
  const grouped = groupArticlesByCategory(
    (data ?? []) as unknown as ArticleRow[]
  );

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-10 px-4 py-10">
      <h1 className="text-2xl font-semibold">Digest de noticias</h1>
      {CATEGORY_ORDER.map((category) => {
        const articles = grouped.get(category) ?? [];

        return (
          <section key={category} className="flex flex-col gap-4">
            <h2 className="text-lg font-semibold">
              {CATEGORY_LABELS[category]}
            </h2>
            {articles.length === 0 ? (
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                Sin novedades hoy
              </p>
            ) : (
              <div className="flex flex-col gap-4">
                {articles.map((article) => (
                  <ArticleCard key={article.id} article={article} />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </main>
  );
}
