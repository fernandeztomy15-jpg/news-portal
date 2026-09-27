import { z } from "zod";

export const TopicPickSchema = z.object({
  topic: z.string(),
  query: z.string(),
});

export const ArticleScoreSchema = z.object({
  id: z.string(),
  score: z.number().min(0).max(100),
  reason: z.string(),
  discard: z.boolean(),
});

export const ScoringResponseSchema = z.object({
  articles: z.array(ArticleScoreSchema),
});

/**
 * Arma el prompt que le pide a la LLM elegir un tema de "descubrimiento":
 * un tema fuera de lo habitual del usuario, evitando repetir los temas
 * usados recientemente.
 */
export function buildTopicPickPrompt(recentTopics: string[]): string {
  const recentList =
    recentTopics.length > 0
      ? recentTopics.map((topic) => `- ${topic}`).join("\n")
      : "(sin temas recientes registrados)";

  return `Sos un curador editorial que elige UN tema de "descubrimiento" para presentarle a un lector.

El objetivo de la sección de descubrimiento es introducir al lector temas de interés general
que estén FUERA de sus intereses habituales, para ampliar su panorama. No se trata de un tema
que el lector ya sigue, sino de algo nuevo, relevante y de calidad periodística.

Temas usados recientemente (evitalos, elegí algo distinto para no repetir):
${recentList}

Elegí un tema concreto y noticioso (no una categoría genérica como "tecnología", sino algo
específico y actual, por ejemplo "el hallazgo de una nueva especie marina" o "un avance en
baterías de estado sólido") y una consulta de búsqueda breve para encontrar noticias sobre ese
tema.

Respondé exclusivamente con un objeto JSON con esta forma exacta:
{
  "topic": "<tema elegido, breve>",
  "query": "<consulta de búsqueda para encontrar noticias sobre ese tema>"
}`;
}

interface ScoringCandidate {
  id: string;
  title: string;
  summary: string | null;
  category: string;
}

interface BuildScoringPromptInput {
  weights: Record<string, number>;
  likedTitles: string[];
  dislikedTitles: string[];
  candidates: ScoringCandidate[];
}

/**
 * Arma el prompt que le pide a la LLM puntuar una lista de artículos candidatos.
 *
 * Regla clave: para la categoría "descubrimiento" hay que IGNORAR los pesos de
 * afinidad del usuario (y su historial de gustos) y juzgar solo el interés y la
 * calidad periodística general de la nota. Para el resto de las categorías, en
 * cambio, hay que USAR los pesos de afinidad y el historial de likes/dislikes
 * para juzgar qué tan relevante es la nota para este lector en particular.
 */
export function buildScoringPrompt(input: BuildScoringPromptInput): string {
  const { weights, likedTitles, dislikedTitles, candidates } = input;

  const weightsList =
    Object.keys(weights).length > 0
      ? Object.entries(weights)
          .map(([category, weight]) => `- ${category}: ${weight}`)
          .join("\n")
      : "(sin pesos registrados todavía)";

  const likedList =
    likedTitles.length > 0
      ? likedTitles.map((title) => `- ${title}`).join("\n")
      : "(sin títulos que le gustaron registrados todavía)";

  const dislikedList =
    dislikedTitles.length > 0
      ? dislikedTitles.map((title) => `- ${title}`).join("\n")
      : "(sin títulos que no le gustaron registrados todavía)";

  const candidatesJson = JSON.stringify(
    candidates.map((c) => ({
      id: c.id,
      title: c.title,
      summary: c.summary,
      category: c.category,
    })),
    null,
    2
  );

  return `Sos un curador editorial que puntúa artículos candidatos para el feed personalizado de un lector.

Pesos de afinidad por categoría (más alto = más interés del lector en esa categoría):
${weightsList}

Títulos de notas que le gustaron al lector en el pasado (usalos como referencia de gusto):
${likedList}

Títulos de notas que NO le gustaron al lector en el pasado (evitá recomendar algo similar):
${dislikedList}

REGLA CRÍTICA sobre la categoría "descubrimiento":
Para cualquier artículo candidato cuya "category" sea exactamente "descubrimiento", IGNORÁ POR
COMPLETO los pesos de afinidad de arriba y el historial de likes/dislikes. Esos artículos NO se
juzgan por si le interesan al lector según su gusto habitual — se juzgan únicamente por su
interés general y calidad periodística intrínseca (¿es una nota bien escrita, relevante,
noticiosa, de calidad, para un lector cualquiera?). El propósito de "descubrimiento" es sacar al
lector de su zona de confort, así que aplicarle sus pesos de afinidad sería contradictorio con
ese propósito. No apliques los pesos ni el historial de gustos a estos artículos bajo ninguna
circunstancia.

Para TODAS LAS DEMÁS categorías (cualquier "category" distinta de "descubrimiento"):
Juzgá la relevancia de cada artículo usando los pesos de afinidad por categoría de arriba y el
historial de títulos que le gustaron o no le gustaron al lector. Una categoría con peso alto
indica mayor interés del lector; los títulos que le gustaron indican el tipo de enfoque o ángulo
que prefiere, y los que no le gustaron indican qué evitar.

Artículos candidatos:
${candidatesJson}

Para cada artículo candidato, asigná:
- "score": un número entero de 0 a 100 que refleje qué tan bueno es incluir este artículo en el
  feed del lector, aplicando la regla de arriba según corresponda a su categoría.
- "reason": una razón breve (una oración) que explique el score.
- "discard": true si el artículo no debería incluirse en el feed en absoluto (por baja calidad,
  irrelevancia, o duplicado), false en caso contrario.

Respondé exclusivamente con un objeto JSON con esta forma exacta:
{
  "articles": [
    { "id": "<id del artículo>", "score": <0-100>, "reason": "<razón breve>", "discard": <true|false> }
  ]
}

Incluí una entrada por cada artículo candidato, usando exactamente su "id" original.`;
}
