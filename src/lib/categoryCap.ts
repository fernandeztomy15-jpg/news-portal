// Tope duro de artículos activos por categoría, además del criterio de
// descarte de la LLM. Sirve de red de seguridad: si la LLM no descarta
// lo suficiente (por ejemplo, en frío, sin likes/dislikes todavía, los
// pesos son neutros y no tiene mucha base para ser exigente), esto
// evita que una sola corrida deje 50+ artículos "activos" en una
// categoría, que ya no es un digest sino una lista interminable.
export const MAX_ARTICLES_PER_CATEGORY = 8;

/**
 * Dado el conjunto de artículos actualmente activos (discarded=false)
 * de UNA categoría, devuelve los ids que hay que descartar para que
 * queden como mucho `max`, priorizando quedarse con los de mayor
 * score. No lanza ni toca la base — pura función de decisión, la
 * llamada a Supabase vive en curate.ts.
 */
export function selectOverflowIds(
  rows: Array<{ id: string; score: number | null }>,
  max: number
): string[] {
  const sorted = [...rows].sort(
    (a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity)
  );
  return sorted.slice(max).map((row) => row.id);
}
