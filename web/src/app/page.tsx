import { supabase } from "@/lib/supabaseClient";
import {
  CATEGORY_ORDER,
  getDigestWindowStart,
  groupArticlesByCategory,
  type ArticleRow,
} from "@/lib/queries";
import { ArticleCard } from "./components/ArticleCard";

// El digest se arma con datos que cambian dos veces por día (corrida de
// curación por GitHub Actions) y con feedback de likes/dislikes en
// cualquier momento. Sin esto, Next.js prerenderiza la página una sola
// vez en build time y el digest queda congelado para siempre en
// producción — justamente lo opuesto al propósito de este proyecto.
export const dynamic = "force-dynamic";

const CATEGORY_LABELS: Record<(typeof CATEGORY_ORDER)[number], string> = {
  macro: "Macro",
  mercado: "Mercado",
  tech: "Tech",
  emprendimientos: "Emprendimientos",
  deportes: "Deportes",
  descubrimiento: "Descubrimiento",
};

function formatTodayLabel(now: Date): string {
  const label = now.toLocaleDateString("es-AR", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

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
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-6 py-10">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Tu digest</h1>
        <p className="mt-0.5 text-sm text-ink-muted">
          {formatTodayLabel(new Date())}
        </p>
      </header>
      {CATEGORY_ORDER.map((category) => {
        const articles = grouped.get(category) ?? [];

        return (
          <section key={category} className="flex flex-col">
            <div className="mb-3 flex items-baseline justify-between border-b border-rule-strong pb-1.5">
              <h2 className="font-semibold text-accent">
                {CATEGORY_LABELS[category]}
              </h2>
              {articles.length > 0 && (
                <span className="text-xs text-ink-faint">
                  {articles.length}{" "}
                  {articles.length === 1 ? "nota" : "notas"}
                </span>
              )}
            </div>
            {articles.length === 0 ? (
              <p className="text-sm text-ink-muted">Sin novedades hoy</p>
            ) : (
              <div className="flex flex-col">
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
