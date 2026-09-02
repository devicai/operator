/**
 * Bound a promise with a wall-clock budget.
 *
 * Losing the race does NOT cancel the underlying work — it only stops the
 * caller waiting on it. Use it where the work is a round-trip to something
 * that may never answer (the Docker socket, a wedged container) and where
 * hanging would stall a loop that has other things to do.
 */
export async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
