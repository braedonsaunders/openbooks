import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { checkHmrcVatId } from "./hmrc-vat.ts";
import { VatValidationError } from "./vat-validation.ts";

function transportFor(payload: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
}

describe("checkHmrcVatId", () => {
  test("a known VRN is valid with its consultation number", async () => {
    const verdict = await checkHmrcVatId(
      { value: "GB123456789", accessToken: "token" },
      transportFor({
        processingDate: "2026-10-05T00:00:00.000Z",
        consultationNumber: "C123456789",
        target: { address: { line1: "London" } },
      }),
    );
    assert.equal(verdict.valid, true);
    assert.equal(verdict.consultationNumber, "C123456789");
  });

  test("an unknown VRN is invalid, not an outage", async () => {
    const verdict = await checkHmrcVatId(
      { value: "GB000000000", accessToken: "token" },
      transportFor({ code: "NOT_FOUND" }, 404),
    );
    assert.equal(verdict.valid, false);
  });

  test("a missing access token refuses before any request", async () => {
    let called = false;
    const counting: typeof fetch = (async (...args: Parameters<typeof fetch>) => {
      called = true;
      return transportFor({})(...args);
    }) as typeof fetch;
    await assert.rejects(() => checkHmrcVatId({ value: "GB123456789" }, counting), VatValidationError);
    assert.equal(called, false);
  });

  test("an HMRC outage throws instead of passing", async () => {
    await assert.rejects(
      () => checkHmrcVatId({ value: "GB123456789", accessToken: "token" }, transportFor({}, 500)),
      VatValidationError,
    );
  });
});
