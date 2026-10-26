import assert from "node:assert/strict";
import test from "node:test";

const { reportDrawerRequested } = await import("./global-drawer-hosts");

test("a posted journal entry link mounts the shell report host on any page", () => {
  assert.equal(
    reportDrawerRequested("?asset=asset-1&txn=0192a0b0-0000-7000-8000-000000000001"),
    true,
  );
  assert.equal(reportDrawerRequested("txn=0192a0b0-0000-7000-8000-000000000001"), true);
});

test("drills, record drawers and account registers mount the shell report host", () => {
  assert.equal(reportDrawerRequested("?reportDrill=ledger%3Aabc"), true);
  assert.equal(
    reportDrawerRequested("?reportRecord=doc-1&reportRecordKind=customer_invoice"),
    true,
  );
  assert.equal(reportDrawerRequested("?accountRegister=acct-1"), true);
});

test("pages without a report overlay key leave the report host unmounted", () => {
  assert.equal(reportDrawerRequested(""), false);
  assert.equal(reportDrawerRequested("?asset=asset-1&tab=journal"), false);
  assert.equal(reportDrawerRequested("?entry=doc-1&mode=edit"), false);
});
