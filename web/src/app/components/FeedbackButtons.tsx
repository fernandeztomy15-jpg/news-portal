"use client";

import { useState } from "react";

interface FeedbackButtonsProps {
  articleId: string;
  liked: boolean | null;
}

export function FeedbackButtons({ articleId, liked }: FeedbackButtonsProps) {
  const [currentLiked, setCurrentLiked] = useState<boolean | null>(liked);
  const [pending, setPending] = useState(false);

  async function sendFeedback(nextLiked: boolean) {
    const previousLiked = currentLiked;
    // Optimistic update: reflect the click immediately, without a reload.
    setCurrentLiked(nextLiked);
    setPending(true);

    try {
      const response = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ article_id: articleId, liked: nextLiked }),
      });

      if (!response.ok) {
        // Revert on failure (e.g. article not found, malformed body).
        setCurrentLiked(previousLiked);
      }
    } catch {
      setCurrentLiked(previousLiked);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mt-1 flex gap-4">
      <button
        type="button"
        disabled={pending}
        onClick={() => sendFeedback(true)}
        aria-pressed={currentLiked === true}
        className={`border-b text-xs transition-colors disabled:opacity-50 ${
          currentLiked === true
            ? "border-accent text-accent"
            : "border-transparent text-ink-muted hover:border-ink hover:text-ink"
        }`}
      >
        Más de esto
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={() => sendFeedback(false)}
        aria-pressed={currentLiked === false}
        className={`border-b text-xs transition-colors disabled:opacity-50 ${
          currentLiked === false
            ? "border-accent text-accent"
            : "border-transparent text-ink-muted hover:border-ink hover:text-ink"
        }`}
      >
        Menos de esto
      </button>
    </div>
  );
}
