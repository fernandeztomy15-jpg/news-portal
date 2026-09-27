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
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function ArticleCard({ article }: ArticleCardProps) {
  return (
    <article className="flex gap-3 border-b border-rule py-3 last:border-b-0">
      <div
        aria-hidden="true"
        className="w-[3px] shrink-0 self-stretch rounded-full bg-accent/55"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <a
          href={article.url}
          target="_blank"
          rel="noreferrer"
          className="max-w-[62ch] text-[15px] font-semibold leading-snug text-ink hover:text-accent"
        >
          {article.title}
        </a>
        <div className="text-xs text-ink-muted">
          <span>{getSourceLabel(article)}</span>
          <span className="ml-2 text-ink-faint">
            <time dateTime={article.curated_at}>
              {formatCuratedAt(article.curated_at)}
            </time>
          </span>
        </div>
        {article.reason && (
          <p className="max-w-[62ch] text-sm text-ink-muted">
            {article.reason}
          </p>
        )}
        <FeedbackButtons articleId={article.id} liked={article.liked} />
      </div>
    </article>
  );
}
