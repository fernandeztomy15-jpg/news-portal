export const WEIGHT_STEP = 0.15;
export const WEIGHT_MIN = 0.2;
export const WEIGHT_MAX = 3.0;

/**
 * Compute the delta to apply to a category's affinity weight when user feedback changes.
 *
 * @param previousLiked - The user's previous feedback state: true (liked), false (disliked), null (no feedback)
 * @param newLiked - The user's new feedback state: true (like) or false (dislike)
 * @returns The weight delta to apply
 *
 * Cases:
 * - null → true: +0.15 (first like)
 * - null → false: -0.15 (first dislike)
 * - true → true: 0 (repeat like, no change)
 * - false → false: 0 (repeat dislike, no change)
 * - true → false: -0.30 (toggle: revert +0.15, then apply -0.15)
 * - false → true: +0.30 (toggle: revert -0.15, then apply +0.15)
 */
export function computeWeightDelta(previousLiked: boolean | null, newLiked: boolean): number {
  // No previous feedback
  if (previousLiked === null) {
    return newLiked ? WEIGHT_STEP : -WEIGHT_STEP;
  }

  // Same as before: no-op
  if (previousLiked === newLiked) {
    return 0;
  }

  // Toggle: revert previous + apply new
  // true → false: revert +0.15 (-0.15) + apply -0.15 = -0.30
  // false → true: revert -0.15 (+0.15) + apply +0.15 = +0.30
  return newLiked ? 2 * WEIGHT_STEP : -2 * WEIGHT_STEP;
}

/**
 * Clamp a weight value to the allowed range [WEIGHT_MIN, WEIGHT_MAX].
 */
export function clampWeight(weight: number): number {
  if (weight < WEIGHT_MIN) {
    return WEIGHT_MIN;
  }
  if (weight > WEIGHT_MAX) {
    return WEIGHT_MAX;
  }
  return weight;
}
