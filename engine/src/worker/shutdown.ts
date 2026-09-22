/**
 * Worker-process shutdown sequencing.
 *
 * In-flight BullMQ jobs need the shared Redis clients to mark completion:
 * draining a worker while its connections are already closing strands the
 * job, which then re-runs after restart (e.g. `close_events` recording
 * `package.delivered` twice). So the order is load-bearing — workers drain
 * first with connections alive, shared connections close second, telemetry
 * last — and this module owns it in one testable place instead of inline in
 * the process entrypoint.
 */

export type DrainableWorker = {
  close: () => Promise<unknown>;
};

/**
 * Drain every worker, then close shared job connections, then stop
 * telemetry. One worker's close failure is logged, never fatal: it must not
 * strand the other workers' drains or skip the connection close, and the
 * process still exits through its normal path once every stage has run.
 */
export async function shutdownWorkerProcess(
  workers: readonly DrainableWorker[],
  closeJobConnections: () => Promise<unknown>,
  stopTelemetry: () => Promise<unknown>,
): Promise<void> {
  const workerResults = await Promise.allSettled(workers.map((w) => w.close()));
  // Connections close only after EVERY worker drained: a job finishing its
  // completion mark during another worker's slow drain still has Redis.
  await closeJobConnections();
  await stopTelemetry().catch(() => {});
  for (const result of workerResults) {
    if (result.status === "rejected") {
      console.error(
        "[worker] drain failed:",
        result.reason instanceof Error ? result.reason.message : result.reason,
      );
    }
  }
}
