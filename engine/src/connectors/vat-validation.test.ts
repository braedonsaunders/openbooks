import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  normalizeVatId,
  VatValidationError,
  boundAuthorityExcerpt,
} from "./vat-validation.ts";

describe("normalizeVatId", () => {
  test("VIES numbers shed spaces and dots, uppercased", () => {
    assert.equal(normalizeVatId("vies", "de 123.456.789"), "DE123456789");
  });

  test("a VIES number without a country prefix is refused with its remedy", () => {
    assert.throws(
      () => normalizeVatId("vies", "123456789"),
      (error: unknown) => {
        assert.ok(error instanceof VatValidationError);
        assert.match(error.message, /country code/);
        return true;
      },
    );
  });

  test("a nine-digit HMRC number gains its GB prefix", () => {
    assert.equal(normalizeVatId("hmrc", "123456789"), "GB123456789");
  });

  test("a malformed HMRC number names the expected shape", () => {
    assert.throws(
      () => normalizeVatId("hmrc", "GB123"),
      (error: unknown) => {
        assert.ok(error instanceof VatValidationError);
        assert.match(error.message, /9 digits/);
        return true;
      },
    );
  });

  test("an ABN must be eleven digits, not a guess", () => {
    assert.equal(normalizeVatId("abn", "51 123 456 789"), "51123456789");
    assert.throws(
      () => normalizeVatId("abn", "5112345678"),
      (error: unknown) => {
        assert.ok(error instanceof VatValidationError);
        assert.match(error.message, /11 digits/);
        return true;
      },
    );
  });

  test("an unknown scheme is refused by name", () => {
    assert.throws(
      () => normalizeVatId("gst", ""),
      (error: unknown) => {
        assert.ok(error instanceof VatValidationError);
        return true;
      },
    );
  });
});

describe("boundAuthorityExcerpt", () => {
  test("trader detail is truncated to its bounds", () => {
    const excerpt = boundAuthorityExcerpt({
      valid: true,
      consultationNumber: "W123456789",
      traderName: "x".repeat(500),
      traderAddress: "y".repeat(500),
    });
    assert.equal(excerpt.traderName?.length, 120);
    assert.equal(excerpt.traderAddress?.length, 200);
    assert.equal(excerpt.valid, true);
  });
});
