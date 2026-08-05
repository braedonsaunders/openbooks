import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { once } from "node:events";
import { parseLoadOptions, percentile, runLoadProbe } from "./load-smoke.mjs";

test("percentile uses the nearest-rank method", () => {
  assert.equal(percentile([40, 10, 30, 20], 50), 20);
  assert.equal(percentile([40, 10, 30, 20], 95), 40);
  assert.equal(percentile([], 95), 0);
});

test("load options reject unsafe or malformed targets", () => {
  assert.throws(
    () => parseLoadOptions(["--base-url", "file:///tmp/openbooks"]),
    /http or https/,
  );
  assert.throws(
    () => parseLoadOptions(["--path", "api/v1/health"]),
    /start with/,
  );
  assert.throws(
    () => parseLoadOptions(["--concurrency", "0"]),
    /positive integer/,
  );
});

test("load probe records status, latency, and thresholds", async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const options = parseLoadOptions([
    "--base-url",
    `http://127.0.0.1:${address.port}`,
    "--duration-ms",
    "100",
    "--concurrency",
    "2",
    "--max-p95-ms",
    "1000",
  ]);
  const { failures, result } = await runLoadProbe(options);
  assert.deepEqual(failures, []);
  assert.ok(result.requests > 0);
  assert.equal(result.errors, 0);
  assert.equal(result.statusCounts[200], result.requests);
});
