const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 5;
const attempts = new Map<string, number[]>();

export function rateLimited(ip: string, postingId: string): boolean {
  const key = `${ip}|${postingId}`;
  const now = Date.now();
  const recent = (attempts.get(key) ?? []).filter((at) => now - at < WINDOW_MS);
  recent.push(now);
  attempts.set(key, recent);
  // Bound the map: drop keys whose window fully expired on every write.
  if (attempts.size > 10_000) {
    for (const [k, v] of attempts) {
      if (v.every((at) => now - at >= WINDOW_MS)) attempts.delete(k);
    }
  }
  return recent.length > MAX_PER_WINDOW;
}

export function __resetApplyRateLimitForTests(): void {
  attempts.clear();
}
