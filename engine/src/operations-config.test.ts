import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("Compose infrastructure images use deliberate release tags", async () => {
  const compose = await readFile(join(repoRoot, "compose.yaml"), "utf8");
  for (const image of ["postgres", "redis", "minio/minio", "minio/mc"]) {
    assert.doesNotMatch(compose, new RegExp(`image:\\s*${image.replace("/", "\\/")}:latest(?:\\s|$)`));
  }
  assert.match(compose, /postgres:16\.\d+-alpine\d+\.\d+/);
  assert.match(compose, /redis:7\.\d+\.\d+-alpine\d+\.\d+/);
  assert.match(compose, /minio\/minio:RELEASE\.\d{4}-\d{2}-\d{2}T/);
  assert.match(compose, /minio\/mc:RELEASE\.\d{4}-\d{2}-\d{2}T/);
  assert.equal(
    [...compose.matchAll(/^\s*image:\s*(postgres|redis|minio\/minio|minio\/mc):[^\s]+@sha256:[0-9a-f]{64}\s*$/gm)].length,
    4,
    "all four stateful infrastructure images must be digest-pinned",
  );
});

test("Compose passes every supported OTLP/HTTP endpoint to the runtimes", async () => {
  const compose = await readFile(join(repoRoot, "compose.yaml"), "utf8");
  for (const variable of [
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
    "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  ]) {
    const interpolation = "${" + variable + ":-}";
    assert.ok(
      compose.includes(`  ${variable}: ${interpolation}`),
      `${variable} must be passed through the shared runtime environment`,
    );
  }
});
