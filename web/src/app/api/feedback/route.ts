import { supabase } from "@/lib/supabaseClient";
import { clampWeight, computeWeightDelta } from "@/lib/weights";

interface FeedbackRequestBody {
  article_id: string;
  liked: boolean;
}

function isFeedbackRequestBody(value: unknown): value is FeedbackRequestBody {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.article_id === "string" &&
    candidate.article_id.length > 0 &&
    typeof candidate.liked === "boolean"
  );
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!isFeedbackRequestBody(body)) {
    return Response.json(
      { error: "Expected { article_id: string; liked: boolean }" },
      { status: 400 }
    );
  }

  const { article_id, liked } = body;

  // Step 1: leer el artículo.
  const { data: article, error: articleError } = await supabase
    .from("articles")
    .select("id, category, liked")
    .eq("id", article_id)
    .maybeSingle();

  if (articleError) {
    return Response.json({ error: articleError.message }, { status: 500 });
  }

  if (!article) {
    return Response.json({ error: "Article not found" }, { status: 404 });
  }

  // Step 2: guardar el nuevo estado de like/dislike en el artículo.
  const { error: updateArticleError } = await supabase
    .from("articles")
    .update({ liked })
    .eq("id", article_id);

  if (updateArticleError) {
    return Response.json({ error: updateArticleError.message }, { status: 500 });
  }

  // Step 3: leer la fila de category_weights para la categoría del artículo.
  const { data: weightRow, error: weightError } = await supabase
    .from("category_weights")
    .select("category, weight")
    .eq("category", article.category)
    .maybeSingle();

  if (weightError) {
    return Response.json({ error: weightError.message }, { status: 500 });
  }

  // Step 4: si existe fila de pesos para la categoría, ajustar el peso.
  // Si no existe (categoría desconocida / sin seed), no es un error: el like
  // ya quedó guardado, simplemente se salta el ajuste de peso.
  if (weightRow) {
    const newWeight = clampWeight(
      weightRow.weight + computeWeightDelta(article.liked, liked)
    );

    const { error: updateWeightError } = await supabase
      .from("category_weights")
      .update({ weight: newWeight, updated_at: new Date().toISOString() })
      .eq("category", article.category);

    if (updateWeightError) {
      return Response.json({ error: updateWeightError.message }, { status: 500 });
    }
  }

  // Step 5: responder ok.
  return Response.json({ ok: true });
}
