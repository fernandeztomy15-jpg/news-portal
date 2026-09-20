import Parser from "rss-parser";

const parser = new Parser({
  timeout: Number(process.env.FETCH_TIMEOUT_MS ?? 15000),
  headers: {
    // Algunos sitios bloquean el user-agent default de node-fetch.
    "User-Agent":
      "Mozilla/5.0 (compatible; TomasNewsPortalBot/0.1; +https://github.com/)",
  },
});

export type FeedItem = {
  title: string;
  url: string;
  summary: string | null;
  publishedAt: string | null; // ISO string o null si el feed no lo trae
  raw: unknown;
};

/**
 * Trae y parsea un feed RSS/Atom. NO lanza si falla — devuelve
 * { ok: false, error } para que el orquestador (ingest.ts) pueda
 * seguir con las demás fuentes aunque esta falle. Esto es la
 * diferencia central respecto al comportamiento anterior: una fuente
 * caída ya no hace desaparecer todo en silencio.
 */
export async function fetchFeed(
  feedUrl: string
): Promise<
  { ok: true; items: FeedItem[] } | { ok: false; error: string }
> {
  try {
    const feed = await parser.parseURL(feedUrl);

    const items: FeedItem[] = (feed.items ?? [])
      .filter((item) => item.link && item.title)
      .map((item) => ({
        title: item.title!.trim(),
        url: item.link!.trim(),
        summary: item.contentSnippet ?? item.summary ?? null,
        publishedAt: item.isoDate ?? item.pubDate ?? null,
        raw: item,
      }));

    return { ok: true, items };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}
