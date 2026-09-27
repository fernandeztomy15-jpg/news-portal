export function buildGoogleNewsRssUrl(query: string): string {
  const encodedQuery = encodeURIComponent(query);
  return `https://news.google.com/rss/search?q=${encodedQuery}&hl=es-419`;
}
