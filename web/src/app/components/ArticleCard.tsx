import type { ArticleRow } from "@/lib/queries";
import { getSourceLabel } from "@/lib/sourceLabel";
import { FeedbackButtons } from "./FeedbackButtons";

interface ArticleCardProps {
  article: ArticleRow;
}

function formatCuratedAt(isoDate: string): string {
  return new Date(isoDate).toLocaleString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function ArticleCard({ article }: ArticleCardProps) {
  return (
    <article className="flex flex-col gap-2 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <a
        href={article.url}
        target="_blank"
        rel="noreferrer"
        className="font-medium text-blue-700 hover:underline dark:text-blue-400"
      >
        {article.title}
      </a>
      <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
        <span>{getSourceLabel(article)}</span>
        <span aria-hidden="true">·</span>
        <time dateTime={article.curated_at}>
          {formatCuratedAt(article.curated_at)}
        </time>
      </div>
      {article.reason && (
        <p className="text-sm text-zinc-600 dark:text-zinc-300">
          {article.reason}
        </p>
      )}
      <FeedbackButtons articleId={article.id} liked={article.liked} />
    </article>
  );
}
