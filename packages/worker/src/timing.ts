/**
 * Runs `fn` and logs a warning when it takes longer than `thresholdMs` of wall time.
 * (On the free plan the limit is 10 ms CPU; network waits do not count, so this
 * is a coarse hint: if a step with no I/O shows up here, it is a CPU suspect.)
 */
export async function timed<T>(
  label: string,
  fn: () => Promise<T> | T,
  thresholdMs = 50,
): Promise<T> {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    const ms = Date.now() - start;
    if (ms > thresholdMs) console.warn(`[slow] ${label} took ${ms} ms`);
  }
}
