import type { ArticleRow } from "./queries.js";

export function getSourceLabel(
  article: Pick<ArticleRow, "source" | "url">
): string {
  if (article.source !== null) {
    return article.source.name;
  }

  const hostname = new URL(article.url).hostname;
  return hostname.startsWith("www.") ? hostname.slice(4) : hostname;
}
