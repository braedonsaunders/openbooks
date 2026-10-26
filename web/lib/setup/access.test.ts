import assert from "node:assert/strict";
import test from "node:test";
import { setupSectionManagePermission } from "./access";

test("rehomed command sections use their declared manage permission", () => {
  assert.equal(
    setupSectionManagePermission({
      command: { name: "setFramework", permission: "funds.manage", feature: "fundAccounting" },
    }),
    "funds.manage",
  );
});

test("generic setup sections retain the setup manage permission", () => {
  assert.equal(setupSectionManagePermission({ command: undefined }), "admin.setup.manage");
});
