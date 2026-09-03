import { createServer } from "node:net";
import { after, afterEach, beforeEach } from "node:test";

async function runOwner() {
  const { createScratchOrg, dropScratchOrg, closeScratchOrgPool, getScratchOrgLifecycleMetrics } =
    await import("../engine/src/test-fixtures.ts");
  // Force pool initialization before advertising readiness. The owner is the
  // only process allowed to bootstrap or tear down tenants; test-file workers
  // lease these committed slots over the line protocol below.
  const initial = await createScratchOrg();
  await dropScratchOrg(initial.orgId);

  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      void (async () => {
        let response;
        try {
          const request = JSON.parse(line);
          if (request.op === "lease") {
            response = { ok: true, org: await createScratchOrg() };
          } else if (request.op === "release") {
            await dropScratchOrg(String(request.orgId));
            response = { ok: true };
          } else if (request.op === "close") {
            let closeError;
            try {
              await closeScratchOrgPool();
            } catch (error) {
              closeError = String(error);
            }
            const metrics = getScratchOrgLifecycleMetrics();
            response = closeError ? { ok: false, error: closeError, metrics } : { ok: true, metrics };
            process.stdout.write(`[fixture-lifecycle] ${JSON.stringify(metrics)}\n`);
            socket.end(`${JSON.stringify(response)}\n`);
            server.close(() => process.exit(closeError ? 1 : 0));
            return;
          } else {
            throw new Error(`unknown fixture owner operation: ${request.op}`);
          }
        } catch (error) {
          response = { ok: false, error: String(error) };
        }
        socket.end(`${JSON.stringify(response)}\n`);
      })();
    });
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture owner failed to bind");
    process.stdout.write(`FIXTURE_OWNER_READY ${address.port}\n`);
  });
}

if (process.argv.includes("--owner")) {
  await runOwner();
} else {
  // This hook is imported only by a canonical owner process. It is
  // process-global, so teardown cannot multiply with the number of workers.
  // Keep the worker event loop alive while top-level module-hook imports and
  // database promises settle. Without this guard the runner finishes the
  // tests registered before a file's top-level await continuation resolves
  // and force-exits the worker before the late-registered tests ever run,
  // producing a silent partial file run. The timer is cleared in the final
  // hook below, after the owner lease and receipt protocol closes.
  const workerKeepAlive = setInterval(() => {}, 1_000);
  const {
    closeScratchOrgPool,
    getScratchOrgLifecycleMetrics,
    releaseOutstandingScratchOrgLeases,
  } = await import("../engine/src/test-fixtures.ts");
  // Legacy integration tests often lease a scratch org without an explicit
  // drop call. Preserve a small file-scoped working set (some suites build a
  // shared fixture in a module-level harness), but drain it once the fixed
  // pool budget is reached so sequential legacy tests cannot starve later
  // leases. The final `after` hook always drains any remainder. Any
  // reset/leak error is thrown from the hook and therefore fails the worker
  // closed.
  // Drain forgotten leases at each top-level test boundary. Legacy
  // integration tests often lease a scratch org without an explicit drop
  // call; the worker ledger tracks those leases and this hook returns them,
  // so a forgotten drop can never starve the fixed pool or leak into the
  // owner's close receipt. The drain runs only when the finished test has no
  // still-running parent: subtests share their parent's fixture, so draining
  // at a subtest boundary would reset the org while siblings still use it.
  // A file that memoizes one org across top-level tests keeps resolving the
  // same slot — the integration partition runs files serially through one
  // owner, so no other test can take the slot while it sits clean — and an
  // explicit file-level drop stays idempotent, so releasing an already
  // dropped lease is a no-op.
  // Depth counting assumes serial test execution, which the integration
  // partition guarantees by construction (--test-concurrency=1). A cancelled
  // test can skip its hooks, so the counter is clamped rather than trusted
  // exactly: the drain fires whenever no test is observably open.
  let openTestDepth = 0;
  beforeEach(() => {
    openTestDepth += 1;
  });
  afterEach(async () => {
    openTestDepth = Math.max(0, openTestDepth - 1);
    if (openTestDepth === 0) {
      await releaseOutstandingScratchOrgLeases();
    }
  });
  // Root `after` callbacks run after the tests registered before them. Files
  // that register DB tests from a top-level await continuation (after this
  // module was imported) run those late tests after this hook: the canonical
  // owner path is unaffected — late leases still traverse the suite owner and
  // the owner's receipt stays complete — but in no-owner local runs this
  // receipt may print before the first lease. The owner receipt is the only
  // authoritative lifecycle evidence; worker receipts are best-effort.
  after(async () => {
    let failure;
    try {
      await releaseOutstandingScratchOrgLeases();
      await closeScratchOrgPool();
    } catch (error) {
      failure = error;
    } finally {
      clearInterval(workerKeepAlive);
      // The suite-level owner emits the single authoritative receipt. Worker
      // processes still release their leases here, but must not publish
      // zero-valued per-process metrics that could be mistaken for the suite
      // total by CI verification.
      if (!process.env.OPENBOOKS_TEST_FIXTURE_OWNER_PORT) {
        process.stdout.write(`[fixture-lifecycle] ${JSON.stringify(getScratchOrgLifecycleMetrics())}\n`);
      }
    }
    if (failure) throw failure;
  });
}
