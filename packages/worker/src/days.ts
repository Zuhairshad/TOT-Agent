export const DAY_MS = 86_400_000;

/** Whole days from `now` to `deadline` (rounded up), or null if no deadline. */
export function daysLeft(deadline: string | null, now: Date): number | null {
  if (!deadline) return null;
  const t = Date.parse(deadline);
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - now.getTime()) / DAY_MS);
}
