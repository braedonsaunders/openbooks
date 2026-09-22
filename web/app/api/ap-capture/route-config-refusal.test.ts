import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// The capture upload endpoint reads the org's document-capture runtime
// config, which is null when unconfigured but THROWS for a misconfigured
// endpoint or an unseal failure. Collapsing the throw into null mapped real
// errors to a misleading 409 capture_not_configured and sent operators to
// reconfigure a correctly configured endpoint: only null maps to the 409,
// real errors surface with their own message.

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "route.ts"), "utf8");

test("capture config errors surface instead of collapsing into not-configured", () => {
  assert.ok(
    !/getDocumentCaptureRuntimeConfig\([^)]*\)\.catch\(\(\) => null\)/.test(src),
    "a .catch(() => null) on the runtime config turns refusals and unseal failures into capture_not_configured",
  );
  assert.match(src, /capture_not_configured/, "unconfigured orgs still get the 409");
  assert.match(
    src,
    /catch \(error\)[\s\S]*?capture_config_failed/,
    "a config read failure must surface with its own message",
  );
});
