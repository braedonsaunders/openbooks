import assert from "node:assert/strict";
import test from "node:test";
import { createKdfExecutor, KdfCapacityError } from "./auth-kdf-capacity";

test("KDF executor bounds active work and its admission queue", async () => {
  const executor = createKdfExecutor({ maxActive: 2, maxQueued: 2 });
  const releases: Array<() => void> = [];
  const held = () => executor.run(() => new Promise<void>((resolve) => releases.push(resolve)));
  const first = held();
  const second = held();
  const third = held();
  const fourth = held();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(executor.snapshot(), { active: 2, queued: 2 });
  await assert.rejects(held(), KdfCapacityError);

  releases.shift()!();
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(executor.snapshot(), { active: 2, queued: 1 });
  releases.shift()!();
  releases.shift()!();
  await Promise.all([second, third]);
  await new Promise((resolve) => setImmediate(resolve));
  releases.shift()!();
  await fourth;
  assert.deepEqual(executor.snapshot(), { active: 0, queued: 0 });
});
