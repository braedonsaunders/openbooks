/**
 * Next.js instrumentation — runs once when the server process starts.
 * Used to boot the scheduled-script cron runner. See engine/src/scheduler.ts.
 *
 * Only runs in the nodejs server runtime, not during builds.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { ensureScheduler } = await import('@openbooks/engine/src/scheduler.ts')
  ensureScheduler()
}
