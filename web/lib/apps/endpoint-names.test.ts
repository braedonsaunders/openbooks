import assert from "node:assert/strict";
import test from "node:test";
import { nextActionName } from "./endpoint-names";

test("the first added action is action-1 even when the starter ships its own endpoint", () => {
  assert.equal(nextActionName([]), "action-1");
  assert.equal(nextActionName([{ name: "sample-tool" }]), "action-1");
  assert.equal(nextActionName([{ name: "sample-tool" }, { name: "action-1" }]), "action-2");
  assert.equal(nextActionName([{ name: "action-2" }]), "action-1");
});
