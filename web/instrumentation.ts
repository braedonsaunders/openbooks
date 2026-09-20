/**
 * Next.js instrumentation — runs once when the server process starts. Boots the
 * scheduled-script cron runner (engine/src/scheduling/scheduler.ts) only on explicit
 * single-process opt-in (OPENBOOKS_RUN_SCHEDULER=1; never under `next dev` —
 * see engine/src/scheduling/mode.ts) and, when enabled, the built-in SFTP
 * server (engine/src/sftp/manager.ts).
 *
 * Only runs in the nodejs server runtime, not during builds.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { registerNodeInstrumentation } = await import('./instrumentation.node')
    await registerNodeInstrumentation()
  }
}
