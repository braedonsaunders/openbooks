import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "..", "..");

test("the built server does not bundle the engine composition root", () => {
  const built = existsSync(join(root, "web/.next/server"));
  if (!built) {
    assert.notEqual(
      process.env.OPENBOOKS_REQUIRE_ENGINE_INSTANCE,
      "1",
      "standalone server output is required",
    );
    return;
  }
  const result = spawnSync(process.execPath, ["scripts/verify-engine-runtime-instance.mjs"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout ?? ""}${result.stderr ?? ""}`);
});
