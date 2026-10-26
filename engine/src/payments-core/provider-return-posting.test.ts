import assert from "node:assert/strict";
import test from "node:test";
import {
  assertProviderReturnPosting,
  withProviderReturnPosting,
} from "./provider-return-posting.ts";

test("a staged return receipt requires its owning command and cannot authorize another tenant or receipt", async () => {
  const receipt = {
    orgId: "org",
    id: "receipt",
    custom: { providerReturn: { disputeId: "review" } },
  };
  assert.throws(() => assertProviderReturnPosting(receipt), /resume the refund or dispute review/);
  await withProviderReturnPosting("org", "receipt", async () => {
    await Promise.resolve();
    assert.doesNotThrow(() => assertProviderReturnPosting(receipt));
    assert.throws(
      () => assertProviderReturnPosting({ ...receipt, id: "other" }),
      /provider return/,
    );
    assert.throws(
      () => assertProviderReturnPosting({ ...receipt, orgId: "other" }),
      /provider return/,
    );
  });
  assert.throws(() => assertProviderReturnPosting(receipt), /provider return/);
  assert.doesNotThrow(() => assertProviderReturnPosting({ ...receipt, custom: {} }));
});
