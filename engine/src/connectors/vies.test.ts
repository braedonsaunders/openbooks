import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { checkViesVatId } from "./vies.ts";
import { VatValidationError } from "./vat-validation.ts";

function transportFor(payload: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
}

describe("checkViesVatId", () => {
  test("a valid VIES answer carries the consultation number", async () => {
    const verdict = await checkViesVatId(
      { value: "DE123456789" },
      transportFor({
        countryCode: "DE",
        vatNumber: "123456789",
        requestDate: "2026-10-05",
        valid: true,
        name: "Example GmbH",
        address: "Berlin",
        consultationNumber: "W123456789",
      }),
    );
    assert.equal(verdict.valid, true);
    assert.equal(verdict.consultationNumber, "W123456789");
    assert.equal(verdict.traderName, "Example GmbH");
  });

  test("an explicit invalid verdict is not an error", async () => {
    const verdict = await checkViesVatId(
      { value: "DE000000000" },
      transportFor({ countryCode: "DE", vatNumber: "000000000", valid: false }),
    );
    assert.equal(verdict.valid, false);
    assert.equal(verdict.consultationNumber, null);
  });

  test("an authority outage throws instead of passing", async () => {
    await assert.rejects(
      () => checkViesVatId({ value: "DE123456789" }, transportFor({ fault: true }, 503)),
      (error: unknown) => {
        assert.ok(error instanceof VatValidationError);
        assert.match(error.message, /VIES/);
        return true;
      },
    );
  });

  test("a verdict without a boolean refuses instead of guessing", async () => {
    await assert.rejects(
      () => checkViesVatId({ value: "DE123456789" }, transportFor({ unexpected: "shape" })),
      VatValidationError,
    );
  });
});
