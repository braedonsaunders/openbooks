import assert from "node:assert/strict";
import test from "node:test";
import {
  closeDeliveryManualEmailIntentKey,
  closeDeliveryManualJobId,
} from "./close-delivery";

const SCOPE = {
  packageId: "018f6b2a-7c1d-7d3e-9f4a-2b8c4d5e6f70",
  periodId: "01904632-9c9a-7b1e-8f2a-1c3d5e7f9001",
  bookId: "01904632-9c9a-7b1e-8f2a-1c3d5e7f9002",
  idempotencyKey: "01904632-9c9a-7b1e-8f2a-1c3d5e7f9003",
} as const;
const ORG = "01904632-9c9a-7b1e-8f2a-1c3d5e7f9004";

test("a manual send intent derives one deterministic queue and email identity", () => {
  // A double-click or retried Send-now reuses the request's client key, so
  // both submissions must collapse onto the same queue job and the same
  // email delivery — never two mails.
  assert.equal(closeDeliveryManualJobId(SCOPE), closeDeliveryManualJobId(SCOPE));
  assert.equal(
    closeDeliveryManualEmailIntentKey({ orgId: ORG, ...SCOPE }),
    closeDeliveryManualEmailIntentKey({ orgId: ORG, ...SCOPE }),
  );
});

test("a new client key mints new identities so later sends are never swallowed", () => {
  const other = { ...SCOPE, idempotencyKey: "01904632-9c9a-7b1e-8f2a-1c3d5e7f9005" };
  assert.notEqual(closeDeliveryManualJobId(SCOPE), closeDeliveryManualJobId(other));
  assert.notEqual(
    closeDeliveryManualEmailIntentKey({ orgId: ORG, ...SCOPE }),
    closeDeliveryManualEmailIntentKey({ orgId: ORG, ...other }),
  );
});

test("manual send identities refuse unusable scope", () => {
  assert.throws(() => closeDeliveryManualJobId({ ...SCOPE, packageId: "not-a-uuid" }));
  assert.throws(() => closeDeliveryManualJobId({ ...SCOPE, idempotencyKey: "" }));
  assert.throws(() => closeDeliveryManualJobId({ ...SCOPE, periodId: undefined }));
  assert.throws(() => closeDeliveryManualEmailIntentKey({ orgId: "bad", ...SCOPE }));
});
