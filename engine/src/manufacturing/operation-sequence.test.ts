import assert from "node:assert/strict";
import test from "node:test";
import { sequenceBlocker } from "./operation-sequence.ts";

const roast = { sequence: 10, name: "Roast", status: "running" };
const cool = { sequence: 15, name: "Cool", status: "pending" };
const pack = { sequence: 20, name: "Pack", status: "pending" };

test("an operation is blocked by the earliest earlier operation that is not done", () => {
  assert.deepEqual(sequenceBlocker([roast, pack], 20), roast);
  assert.deepEqual(sequenceBlocker([roast, cool, pack], 20), roast);
  assert.deepEqual(sequenceBlocker([{ ...roast, status: "paused" }, pack], 20), {
    ...roast,
    status: "paused",
  });
});

test("a paused or pending earlier operation blocks a later start just as a running one does", () => {
  assert.equal(sequenceBlocker([{ ...roast, status: "pending" }, pack], 20)?.name, "Roast");
});

test("completed earlier operations do not block", () => {
  assert.equal(sequenceBlocker([{ ...roast, status: "done" }, pack], 20), null);
  assert.equal(
    sequenceBlocker([{ ...roast, status: "done" }, { ...cool, status: "done" }, pack], 20),
    null,
  );
});

test("the first operation of an order is never blocked", () => {
  assert.equal(sequenceBlocker([roast, pack], 10), null);
});

test("operations at or after the requested sequence never block it", () => {
  assert.equal(sequenceBlocker([roast, pack], 15), roast);
  assert.equal(sequenceBlocker([{ ...roast, status: "done" }, pack], 15), null);
});

test("the blocker is found regardless of the order operations are listed in", () => {
  assert.equal(sequenceBlocker([pack, cool, roast], 20)?.name, "Roast");
});
