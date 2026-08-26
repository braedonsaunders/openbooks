import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { db, pool } from "../db.ts";
import { tick } from "./overhead-scheduler.ts";
import { renderReportPdf } from "./render-client.ts";

const redirectStatuses = [301, 302, 303, 307, 308] as const;

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("worker internal-token requests refuse every redirect class at both call sites", async () => {
  const token = "worker-internal-token-redirect-PROOF";
  let redirectedOriginRequests = 0;
  const redirectedOriginTokens: Array<string | string[] | undefined> = [];
  const redirectedOrigin = createServer((req, res) => {
    redirectedOriginRequests += 1;
    redirectedOriginTokens.push(req.headers["x-internal-token"]);
    if (req.url?.startsWith("/api/internal/reports/render")) {
      res.writeHead(200, { "content-type": "application/pdf" });
      res.end("redirected-report");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"published":999}');
  });
  const redirectedOriginUrl = await listen(redirectedOrigin);

  let redirectStatus: number | null = 301;
  const configuredOriginRequests: Array<{
    method: string | undefined;
    path: string;
    token: string | string[] | undefined;
  }> = [];
  const configuredOrigin = createServer((req, res) => {
    configuredOriginRequests.push({
      method: req.method,
      path: req.url ?? "",
      token: req.headers["x-internal-token"],
    });
    if (redirectStatus !== null) {
      res.writeHead(redirectStatus, { location: `${redirectedOriginUrl}${req.url ?? "/capture"}` });
      res.end();
      return;
    }
    if (req.url?.startsWith("/api/internal/reports/render")) {
      res.writeHead(200, { "content-type": "application/pdf" });
      res.end("valid-report");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"published":3}');
  });
  const configuredOriginUrl = await listen(configuredOrigin);

  const originalFetch = globalThis.fetch;
  const redirectModes: Array<RequestRedirect | undefined> = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    redirectModes.push(init?.redirect);
    return originalFetch(input, init);
  }) as typeof fetch;

  const originalDbExecute = db.execute;
  const originalPoolConnect = pool.connect;
  let dbExecuteCalls = 0;
  Reflect.set(db, "execute", async () => {
    dbExecuteCalls += 1;
    return dbExecuteCalls % 2 === 1
      ? { rows: [{ id: "redirect-test-org", cadence: "monthly" }] }
      : { rows: [{ time_zone: "UTC" }] };
  });
  const fakeClient = {
    async query(text: string) {
      if (text.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }], rowCount: 1 };
      if (text.includes("from overhead_rates")) return { rows: [], rowCount: 0 };
      return { rows: [{ pg_advisory_unlock: true }], rowCount: 1 };
    },
    release() {},
  };
  Reflect.set(pool, "connect", async () => fakeClient);

  const originalInternalUrl = process.env.OPENBOOKS_INTERNAL_URL;
  const originalAppUrl = process.env.OPENBOOKS_APP_URL;
  const originalToken = process.env.OPENBOOKS_INTERNAL_TOKEN;
  process.env.OPENBOOKS_INTERNAL_URL = configuredOriginUrl;
  delete process.env.OPENBOOKS_APP_URL;
  process.env.OPENBOOKS_INTERNAL_TOKEN = token;

  const originalConsoleError = console.error;
  const originalConsoleLog = console.log;
  const schedulerErrors: string[] = [];
  const schedulerLogs: string[] = [];
  console.error = (...values: unknown[]) => schedulerErrors.push(values.map(String).join(" "));
  console.log = (...values: unknown[]) => schedulerLogs.push(values.map(String).join(" "));

  try {
    const refusedRenderStatuses: number[] = [];
    for (const status of redirectStatuses) {
      redirectStatus = status;
      try {
        await renderReportPdf("redirect-test-org", "report-definition");
      } catch {
        refusedRenderStatuses.push(status);
      }
      await tick();
    }

    assert.equal(configuredOriginRequests.length, redirectStatuses.length * 2);
    assert.equal(redirectedOriginRequests, 0, "the redirected origin must receive zero requests");
    assert.deepEqual(redirectedOriginTokens, [], "the redirected origin must receive zero internal-token values");
    assert.deepEqual(refusedRenderStatuses, [...redirectStatuses]);
    assert.deepEqual(redirectModes, Array(redirectStatuses.length * 2).fill("error"));

    const redirectFailureCount = schedulerErrors.length;
    redirectStatus = null;
    const pdf = await renderReportPdf("redirect-test-org", "report-definition");
    await tick();

    assert.equal(pdf.toString(), "valid-report");
    assert.equal(schedulerErrors.length, redirectFailureCount, "the valid scheduler publish must not fail");
    assert.ok(schedulerLogs.some((line) => line.includes("published 3 rates")));
    assert.deepEqual(redirectModes.slice(-2), ["error", "error"]);
    assert.deepEqual(
      configuredOriginRequests.slice(-2).map(({ method, path, token: receivedToken }) => ({
        method,
        path: path.split("?")[0],
        token: receivedToken,
      })),
      [
        { method: "GET", path: "/api/internal/reports/render", token },
        { method: "POST", path: "/api/internal/overhead/publish", token },
      ],
    );
    assert.equal(redirectedOriginRequests, 0);
    assert.deepEqual(redirectedOriginTokens, []);
  } finally {
    console.error = originalConsoleError;
    console.log = originalConsoleLog;
    restoreEnv("OPENBOOKS_INTERNAL_URL", originalInternalUrl);
    restoreEnv("OPENBOOKS_APP_URL", originalAppUrl);
    restoreEnv("OPENBOOKS_INTERNAL_TOKEN", originalToken);
    Reflect.set(db, "execute", originalDbExecute);
    Reflect.set(pool, "connect", originalPoolConnect);
    globalThis.fetch = originalFetch;
    await Promise.all([close(configuredOrigin), close(redirectedOrigin)]);
  }
});
