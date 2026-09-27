export const HAIKU_4_5_MODEL_ID = "claude-haiku-4-5";

export function estimateCostUsd(
  inputTokens: number,
  outputTokens: number
): number {
  return (inputTokens / 1_000_000) * 1 + (outputTokens / 1_000_000) * 5;
}
