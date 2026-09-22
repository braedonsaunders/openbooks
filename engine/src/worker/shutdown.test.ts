import assert from "node:assert/strict";
import test from "node:test";
import { shutdownWorkerProcess } from "./shutdown.ts";

test("connections close only after every worker has drained", async () => {
  const events: string[] = [];
  let connectionsOpen = true;
  const slowWorker = {
    close: async () => {
      // A job finishing while another worker still drains must see Redis.
      await new Promise((resolve) => setTimeout(resolve, 20));
      events.push(`slow-drained(connections-open=${connectionsOpen})`);
    },
  };
  const fastWorker = {
    close: async () => {
      events.push("fast-drained");
    },
  };
  await shutdownWorkerProcess([slowWorker, fastWorker], async () => {
    connectionsOpen = false;
    events.push("connections-closed");
  }, async () => {
    events.push("telemetry-stopped");
  });
  assert.deepEqual(events, [
    "fast-drained",
    "slow-drained(connections-open=true)",
    "connections-closed",
    "telemetry-stopped",
  ]);
});

test("one worker's close failure still drains the rest and closes connections", async () => {
  const events: string[] = [];
  const errors: unknown[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => void errors.push(args);
  try {
    await shutdownWorkerProcess(
      [
        { close: async () => { events.push("good-drained"); } },
        { close: async () => { throw new Error("drain blew up"); } },
      ],
      async () => { events.push("connections-closed"); },
      async () => { events.push("telemetry-stopped"); },
    );
  } finally {
    console.error = originalConsoleError;
  }
  assert.deepEqual(events, ["good-drained", "connections-closed", "telemetry-stopped"]);
  assert.ok(errors.some((args) => Array.isArray(args) && args.join(" ").includes("drain blew up")));
});

test("telemetry stopping is last and its failure is contained", async () => {
  const events: string[] = [];
  await shutdownWorkerProcess(
    [{ close: async () => { events.push("drained"); } }],
    async () => { events.push("connections-closed"); },
    async () => { throw new Error("telemetry down"); },
  );
  assert.deepEqual(events, ["drained", "connections-closed"]);
});
