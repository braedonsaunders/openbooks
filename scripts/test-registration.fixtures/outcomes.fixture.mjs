import assert from "node:assert/strict";
import { test } from "node:test";

test("a real failure remains registered", () => assert.fail("intentional fixture failure"));
test("a skipped test remains registered", { skip: true }, () => {});
test("a pending test remains registered", { todo: true }, () => {});
