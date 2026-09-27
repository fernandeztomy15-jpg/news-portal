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
    <div className="flex gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() => sendFeedback(true)}
        aria-pressed={currentLiked === true}
        aria-label="Me gusta"
        className={`rounded px-2 py-1 text-lg leading-none transition-colors disabled:opacity-50 ${
          currentLiked === true
            ? "bg-green-100 dark:bg-green-900"
            : "bg-transparent hover:bg-zinc-100 dark:hover:bg-zinc-800"
        }`}
      >
        👍
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={() => sendFeedback(false)}
        aria-pressed={currentLiked === false}
        aria-label="No me gusta"
        className={`rounded px-2 py-1 text-lg leading-none transition-colors disabled:opacity-50 ${
          currentLiked === false
            ? "bg-red-100 dark:bg-red-900"
            : "bg-transparent hover:bg-zinc-100 dark:hover:bg-zinc-800"
        }`}
      >
        👎
      </button>
    </div>
  );
}
