export const MONTHLY_BUDGET_CAP_USD = 5;

export function hasExceededBudget(
  spentUsdThisMonth: number,
  capUsd: number
): boolean {
  return spentUsdThisMonth >= capUsd;
}
