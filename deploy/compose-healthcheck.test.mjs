/**
 * The minio service healthcheck must use a binary the pinned image ships.
 *
 * curl left the minio image in late 2023 (ubi-micro base, minio/minio#18372)
 * and the pinned RELEASE.2025-04-22 image postdates that removal, so the old
 * `curl -f .../minio/health/live` probe could never pass: minio stayed
 * unhealthy forever and minio-init — gated on `service_healthy` — never ran,
 * which in turn wedged web/worker behind `service_completed_successfully`.
 * `mc` ships inside the server image for exactly this purpose and `mc ready`
 * is MinIO's documented probe. These are contract tests over compose.yaml
 * because the property under test (which binary the probe execs) only fails
 * at deploy time, after everything downstream has already wedged.
 *
 * Verification note: the pinned digest could not be pulled in this
 * environment (registry unreachable), so the "curl is absent / mc is
 * present" premise rests on the vendor's own admin guide (which prescribes
 * `["CMD", "mc", "ready", "local"]`), the minio/minio#18372 removal record,
 * and multiple independent compose stacks that hit `curl: not found` on
 * recent images and converged on the same probe. Re-verify against the image
 * filesystem when the pin is next moved.
 */
// source-pin-contract: compose healthcheck and dependency policy (compose.yaml: minio curl-free probe, init ordering)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const compose = readFileSync(join(root, "compose.yaml"), "utf8");

/** Strip comments so the prose explaining a probe cannot satisfy its test. */
const code = compose
  .split("\n")
  .map((line) => line.replace(/(^|\s)#.*$/, "$1"))
  .join("\n");

const minioBlock = code.slice(code.indexOf("  minio:"), code.indexOf("  minio-init:"));
assert.ok(minioBlock.includes("test:"), "test fixture: minio service block must exist");

test("the minio healthcheck does not use curl (absent from the image)", () => {
  assert.doesNotMatch(minioBlock, /\bcurl\b/, "curl is not shipped in recent minio images; the probe could never pass");
  assert.doesNotMatch(minioBlock, /\bwget\b/, "wget is not shipped in the ubi-micro-based minio image either");
});

test("the minio healthcheck uses the image's own client readiness probe", () => {
  assert.match(minioBlock, /\bmc\b.*\bready\b/, "the probe must shell out to the mc binary the server image ships");
});

test("minio-init still waits on a healthy minio before creating the bucket", () => {
  const initBlock = code.slice(code.indexOf("  minio-init:"));
  assert.match(initBlock, /service_healthy/, "bucket creation must stay gated on minio health");
});
