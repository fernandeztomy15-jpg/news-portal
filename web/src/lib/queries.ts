export const CATEGORY_ORDER = [
  "macro",
  "mercado",
  "tech",
  "emprendimientos",
  "deportes",
  "descubrimiento",
] as const;

export type ArticleRow = {
  id: string;
  title: string;
  url: string;
  category: string;
  score: number | null;
  reason: string | null;
  liked: boolean | null;
  curated_at: string;
  source: { name: string } | null;
};

const DIGEST_WINDOW_HOURS = 48;
const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * Agrupa artículos por categoría, respetando el orden fijo de
 * CATEGORY_ORDER. Cada categoría de CATEGORY_ORDER aparece como clave en
 * el Map resultante, en ese orden, incluso si no tiene artículos.
 */
export function groupArticlesByCategory(
  articles: ArticleRow[]
): Map<string, ArticleRow[]> {
  const grouped = new Map<string, ArticleRow[]>();

  for (const category of CATEGORY_ORDER) {
    grouped.set(category, []);
  }

  for (const article of articles) {
    const bucket = grouped.get(article.category);
    if (bucket) {
      bucket.push(article);
    } else {
      grouped.set(article.category, [article]);
    }
  }

  return grouped;
}

/**
 * Devuelve el inicio de la ventana del digest: `now` menos 48 horas.
 */
export function getDigestWindowStart(now: Date): Date {
  return new Date(now.getTime() - DIGEST_WINDOW_HOURS * MS_PER_HOUR);
}
