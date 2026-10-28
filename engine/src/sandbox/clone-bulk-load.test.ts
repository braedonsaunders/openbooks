import assert from "node:assert/strict";
import test from "node:test";
import { readCloneBulkLoadSetting } from "./clone-bulk-load.ts";

test("clone bulk loading is on by default and turns off only by an explicit off", () => {
  assert.equal(readCloneBulkLoadSetting({}), true);
  assert.equal(readCloneBulkLoadSetting({ OPENBOOKS_SANDBOX_CLONE_BULK_LOAD: "on" }), true);
  assert.equal(readCloneBulkLoadSetting({ OPENBOOKS_SANDBOX_CLONE_BULK_LOAD: "off" }), false);
  assert.throws(
    () => readCloneBulkLoadSetting({ OPENBOOKS_SANDBOX_CLONE_BULK_LOAD: "fast" }),
    /OPENBOOKS_SANDBOX_CLONE_BULK_LOAD/,
  );
});
