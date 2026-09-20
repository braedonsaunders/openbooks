/**
 * Worker process composition entry (HR-16).
 *
 * The worker boot (engine/src/worker/index.ts) cannot import the
 * automations engine module: worker sits inside the pinned engine
 * dependency cycle and automations reaches back into it through flows,
 * so that edge would grow the pinned cycle the boundary check refuses.
 * Composition therefore lives HERE, outside the engine module graph
 * (like web/instrumentation.node.ts for the web process): this file
 * registers process duties into the engine/src/worker duty registry and
 * then boots the worker. No engine file imports automations; the
 * dependency points from this entry into automations only.
 *
 * Run directly (`tsx scripts/worker-entry.ts`, the `worker` npm script,
 * the Dockerfile worker bundle source). Importing without running (tests)
 * registers duties without booting: the worker boot below runs only when
 * this file IS the process entry point.
 */
import { pathToFileURL } from "node:url";
import { registerWorkerDuty } from "../engine/src/worker/duties.ts";
import { AUTOMATION_TICK_LOCK_KEY, runAutomationTickClaimed } from "../engine/src/automations/tick.ts";

export function registerWorkerDuties(): void {
  // One scanner per key (the registry refuses duplicates): the automation
  // tick covers schedule, date-relative, and queued field-change / event /
  // document triggers, claimed across replicas on its own advisory key.
  // eslint-disable-next-line no-console
  console.log(`[worker] duty registered: automation-tick (${AUTOMATION_TICK_LOCK_KEY})`);
  registerWorkerDuty({
    key: "automation-tick",
    run: async (now: Date) => {
      await runAutomationTickClaimed(now);
    },
  });
}

registerWorkerDuties();

const isMain =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  // Boot the worker (queues, schedulers, heartbeat). Imported lazily so a
  // test import of this entry registers duties without starting the world:
  // engine/src/worker/index.ts self-starts on import. No top-level await:
  // tsx compiles scripts-adjacent files as CJS, where TLA is unsupported.
  void import("../engine/src/worker/index.ts").catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error("[worker] startup failed:", error);
    process.exit(1);
  });
}
