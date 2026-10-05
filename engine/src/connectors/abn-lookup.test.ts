import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { checkAbn } from "./abn-lookup.ts";
import { VatValidationError } from "./vat-validation.ts";

function transportFor(body: string, status = 200): typeof fetch {
  return (async () => new Response(body, { status })) as typeof fetch;
}

describe("checkAbn", () => {
  test("an Active ABN is valid", async () => {
    const verdict = await checkAbn(
      { value: "51123456789", guid: "guid" },
      transportFor(
        `callback({"Abn":"51123456789","AbnStatus":"Active","AbnStatusEffectiveFrom":"2000-11-01","EntityTypeName":"Company"})`,
      ),
    );
    assert.equal(verdict.valid, true);
  });

  test("a Cancelled ABN is invalid", async () => {
    const verdict = await checkAbn(
      { value: "51123456789", guid: "guid" },
      transportFor(`callback({"Abn":"51123456789","AbnStatus":"Cancelled"})`),
    );
    assert.equal(verdict.valid, false);
  });

  test("a missing GUID refuses before any request", async () => {
    let called = false;
    const counting: typeof fetch = (async (...args: Parameters<typeof fetch>) => {
      called = true;
      return transportFor("")(...args);
    }) as typeof fetch;
    await assert.rejects(() => checkAbn({ value: "51123456789" }, counting), VatValidationError);
    assert.equal(called, false);
  });

  test("a registry outage throws instead of passing", async () => {
    await assert.rejects(
      () => checkAbn({ value: "51123456789", guid: "guid" }, transportFor("error", 500)),
      VatValidationError,
    );
  });
});
