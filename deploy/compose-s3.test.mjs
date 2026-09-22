/**
 * Web/worker processes must never hold the object store's root credentials.
 *
 * compose.yaml used to hand `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`
 * straight to web/worker as `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`, so
 * any file-read primitive in the application tier yielded full administrative
 * control of object storage (create/delete users, policies, any bucket).
 * minio-init now provisions a dedicated app user with a custom policy
 * scoped to the app bucket only, and web/worker receive those credentials.
 * These are contract tests over compose.yaml because the property under test
 * (which secret each service receives) only fails at deploy time.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const compose = readFileSync(join(root, "compose.yaml"), "utf8");

/** Strip comments so the prose explaining a boundary cannot satisfy its test. */
const code = compose
  .split("\n")
  .map((line) => line.replace(/(^|\s)#.*$/, "$1"))
  .join("\n");

const serviceBlock = (name) => {
  const start = code.indexOf(`  ${name}:`);
  assert.ok(start > -1, `test fixture: service ${name} must exist`);
  const rest = code.slice(start + name.length + 4);
  const next = rest.search(/\n  [a-z0-9-]+:/);
  return next === -1 ? rest : rest.slice(0, next);
};

test("web/worker S3 credentials do not come from the root user", () => {
  const anchor = code.slice(code.indexOf("x-openbooks-runtime-environment:"), code.indexOf("services:"));
  assert.match(anchor, /S3_ACCESS_KEY_ID/, "test fixture: shared anchor must configure S3 creds");
  assert.doesNotMatch(anchor, /S3_ACCESS_KEY_ID:.*MINIO_ROOT_USER/, "app S3 access key must not be the root user");
  assert.doesNotMatch(
    anchor,
    /S3_SECRET_ACCESS_KEY:.*MINIO_ROOT_PASSWORD/,
    "app S3 secret must not be the root password",
  );
  assert.match(anchor, /S3_ACCESS_KEY_ID:.*MINIO_APP_USER/, "app S3 access key must be the dedicated app user");
  assert.match(
    anchor,
    /S3_SECRET_ACCESS_KEY:.*MINIO_APP_PASSWORD/,
    "app S3 secret must be the dedicated app password",
  );
});

test("the app object-storage password is required, never defaulted", () => {
  assert.match(
    code,
    /\$\{MINIO_APP_PASSWORD:\?/,
    "a missing app password must fail compose interpolation instead of deploying with an empty secret",
  );
});

test("minio-init creates the dedicated user with a bucket-scoped policy", () => {
  const init = serviceBlock("minio-init");
  assert.match(init, /mc admin user add/, "minio-init must create the app user");
  assert.match(init, /mc admin policy create/, "minio-init must create a custom policy (canned policies are server-wide)");
  assert.match(init, /mc admin policy set/, "minio-init must attach the policy to the app user");
  assert.match(init, /arn:aws:s3:::openbooks/, "the custom policy must scope to the app bucket");
  assert.doesNotMatch(init, /"s3:\*"/, "the custom policy must not grant wildcard S3 actions");
  assert.doesNotMatch(init, /arn:aws:s3:::\*/, "the custom policy must not cover every bucket");
});

test("root credentials stay with minio/minio-init only", () => {
  for (const name of ["web", "worker", "bootstrap"]) {
    const block = serviceBlock(name);
    assert.doesNotMatch(block, /MINIO_ROOT_(USER|PASSWORD)/, `${name} must never receive root credentials`);
  }
  const init = serviceBlock("minio-init");
  assert.match(init, /MINIO_ROOT_USER/, "minio-init still needs root to administer users/policies");
});
