import assert from "node:assert/strict";
import test from "node:test";
import { createClonePacer, DEFAULT_CLONE_PACING, readClonePacing } from "./clone-pacing.ts";

function fakeClock(start = 0) {
  let now = start;
  const sleeps: number[] = [];
  return {
    sleeps,
    advance(ms: number) {
      now += ms;
    },
    clock: {
      now: () => now,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        now += ms;
      },
    },
  };
}

test("clone pacing defaults apply when no override is configured", () => {
  assert.deepEqual(readClonePacing({}), DEFAULT_CLONE_PACING);
});

test("clone pacing refuses malformed overrides instead of running unthrottled", () => {
  for (const [name, value] of [
    ["OPENBOOKS_SANDBOX_CLONE_WAL_BYTES_PER_SECOND", "0"],
    ["OPENBOOKS_SANDBOX_CLONE_WAL_BYTES_PER_SECOND", "fast"],
    ["OPENBOOKS_SANDBOX_CLONE_DUTY_CYCLE", "1.5"],
    ["OPENBOOKS_SANDBOX_CLONE_DUTY_CYCLE", "-0.2"],
    ["OPENBOOKS_SANDBOX_CLONE_CHUNK_ROWS", "250.5"],
  ] as const) {
    assert.throws(() => readClonePacing({ [name]: value }), new RegExp(name));
  }
  assert.deepEqual(
    readClonePacing({
      OPENBOOKS_SANDBOX_CLONE_WAL_BYTES_PER_SECOND: "1048576",
      OPENBOOKS_SANDBOX_CLONE_DUTY_CYCLE: "0.25",
      OPENBOOKS_SANDBOX_CLONE_CHUNK_ROWS: "1000",
    }),
    { walBytesPerSecond: 1048576, dutyCycle: 0.25, chunkRows: 1000 },
  );
});

test("clone pacer holds write-ahead-log volume to its budget", async () => {
  const { clock, sleeps, advance } = fakeClock();
  let position = 1_000n;
  const pacer = await createClonePacer(
    { walBytesPerSecond: 1_000_000, dutyCycle: 1, chunkRows: 5000 },
    async () => position,
    clock,
  );
  // 4 MB written in one second at a 1 MB/s budget needs three more seconds.
  advance(1000);
  position += 4_000_000n;
  await pacer.afterStatement();
  assert.deepEqual(sleeps, [3000]);
  // Within budget: no pause.
  advance(1000);
  position += 500_000n;
  await pacer.afterStatement();
  assert.deepEqual(sleeps, [3000]);
});

test("clone pacer yields the primary for its duty cycle even without log access", async () => {
  const { clock, sleeps, advance } = fakeClock();
  const pacer = await createClonePacer(
    { walBytesPerSecond: 1_000_000, dutyCycle: 0.5, chunkRows: 5000 },
    async () => null,
    clock,
  );
  advance(800);
  await pacer.afterStatement();
  assert.deepEqual(sleeps, [800]);
});

test("clone pacer bounds a single pause", async () => {
  const { clock, sleeps, advance } = fakeClock();
  let position = 0n;
  const pacer = await createClonePacer(
    { walBytesPerSecond: 1, dutyCycle: 1, chunkRows: 5000 },
    async () => position,
    clock,
  );
  advance(10);
  position += 10_000_000n;
  await pacer.afterStatement();
  assert.deepEqual(sleeps, [30_000]);
});
