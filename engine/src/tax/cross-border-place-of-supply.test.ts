import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  assessEuDistanceThreshold,
  CrossBorderTaxError,
  determineCrossBorderSupply,
} from "./cross-border-place-of-supply.ts";

const B2C_DIGITAL = {
  supplyKind: "digital_service",
  customerKind: "consumer",
  sellerCountry: "IE",
} as const;

describe("B2C digital place of supply", () => {
  test("two agreeing pieces resolve the customer country", () => {
    const result = determineCrossBorderSupply({
      ...B2C_DIGITAL,
      evidence: [
        { kind: "billing_address", country: "DE" },
        { kind: "ip_country", country: "DE" },
      ],
    });
    assert.equal(result.outcome, "customer_country");
    assert.equal(result.country, "DE");
  });

  test("a third dissenting signal does not overrule two agreeing pieces", () => {
    const result = determineCrossBorderSupply({
      ...B2C_DIGITAL,
      evidence: [
        { kind: "billing_address", country: "FR" },
        { kind: "ip_country", country: "FR" },
        { kind: "sim_country", country: "DE" },
      ],
    });
    assert.equal(result.outcome, "customer_country");
    assert.equal(result.country, "FR");
  });

  test("one piece is insufficient and the refusal names the remedy", () => {
    assert.throws(
      () =>
        determineCrossBorderSupply({
          ...B2C_DIGITAL,
          evidence: [{ kind: "billing_address", country: "DE" }],
        }),
      (error: unknown) => {
        assert.ok(error instanceof CrossBorderTaxError);
        assert.match(error.message, /two/i);
        assert.match(error.message, /collect/i);
        return true;
      },
    );
  });

  test("conflicting top pieces refuse and list both sides", () => {
    assert.throws(
      () =>
        determineCrossBorderSupply({
          ...B2C_DIGITAL,
          evidence: [
            { kind: "billing_address", country: "DE" },
            { kind: "ip_country", country: "FR" },
          ],
        }),
      (error: unknown) => {
        assert.ok(error instanceof CrossBorderTaxError);
        assert.match(error.message, /DE/);
        assert.match(error.message, /FR/);
        assert.match(error.message, /billing_address/);
        assert.match(error.message, /ip_country/);
        return true;
      },
    );
  });

  test("custom precedence reorders which pieces decide", () => {
    const result = determineCrossBorderSupply({
      ...B2C_DIGITAL,
      evidence: [
        { kind: "billing_address", country: "DE" },
        { kind: "sim_country", country: "DE" },
      ],
      evidencePrecedence: ["sim_country", "billing_address"],
    });
    assert.equal(result.outcome, "customer_country");
    assert.equal(result.country, "DE");
    assert.deepEqual(result.evidence, ["sim_country", "billing_address"]);
  });
});

describe("B2B reverse charge", () => {
  test("a valid VIES ID in another member state reverse-charges services", () => {
    const result = determineCrossBorderSupply({
      supplyKind: "digital_service",
      customerKind: "business",
      sellerCountry: "IE",
      evidence: [],
      businessVatId: { scheme: "vies", value: "DE123456789", status: "valid" },
    });
    assert.equal(result.outcome, "reverse_charge");
    assert.equal(result.country, "DE");
  });

  test("a valid VIES ID for goods names the intra-Community supply", () => {
    const result = determineCrossBorderSupply({
      supplyKind: "goods",
      customerKind: "business",
      sellerCountry: "NL",
      evidence: [],
      shipToCountry: "BE",
      businessVatId: { scheme: "vies", value: "BE0123456789", status: "valid" },
    });
    assert.equal(result.outcome, "reverse_charge");
    assert.match(result.note, /138/);
  });

  test("an invalid ID refuses instead of silently charging B2C VAT", () => {
    assert.throws(
      () =>
        determineCrossBorderSupply({
          supplyKind: "digital_service",
          customerKind: "business",
          sellerCountry: "IE",
          evidence: [{ kind: "billing_address", country: "DE" }],
          businessVatId: { scheme: "vies", value: "DE000", status: "invalid" },
        }),
      (error: unknown) => {
        assert.ok(error instanceof CrossBorderTaxError);
        assert.match(error.message, /invalid/);
        return true;
      },
    );
  });

  test("an unverified ID refuses and leaves the decision to the operator", () => {
    assert.throws(
      () =>
        determineCrossBorderSupply({
          supplyKind: "digital_service",
          customerKind: "business",
          sellerCountry: "IE",
          evidence: [],
          businessVatId: { scheme: "vies", value: "DE123456789", status: "unverified" },
        }),
      (error: unknown) => {
        assert.ok(error instanceof CrossBorderTaxError);
        assert.match(error.message, /unverified/);
        return true;
      },
    );
  });

  test("a business without any ID is taxed as a consumer", () => {
    const result = determineCrossBorderSupply({
      ...B2C_DIGITAL,
      customerKind: "business",
      evidence: [
        { kind: "billing_address", country: "DE" },
        { kind: "card_bin_country", country: "DE" },
      ],
    });
    assert.equal(result.outcome, "customer_country");
    assert.equal(result.country, "DE");
  });
});

describe("goods place of supply", () => {
  test("B2C goods follow the ship-to country alone", () => {
    const result = determineCrossBorderSupply({
      supplyKind: "goods",
      customerKind: "consumer",
      sellerCountry: "IE",
      evidence: [],
      shipToCountry: "FR",
    });
    assert.equal(result.outcome, "customer_country");
    assert.equal(result.country, "FR");
  });

  test("B2C goods without a destination refuse by name", () => {
    assert.throws(
      () =>
        determineCrossBorderSupply({
          supplyKind: "goods",
          customerKind: "consumer",
          sellerCountry: "IE",
          evidence: [{ kind: "billing_address", country: "FR" }],
        }),
      (error: unknown) => {
        assert.ok(error instanceof CrossBorderTaxError);
        assert.match(error.message, /ship-to/i);
        return true;
      },
    );
  });

  test("goods shipped outside the covered states are an export", () => {
    const result = determineCrossBorderSupply({
      supplyKind: "goods",
      customerKind: "consumer",
      sellerCountry: "IE",
      evidence: [],
      shipToCountry: "US",
    });
    assert.equal(result.outcome, "export");
    assert.equal(result.country, "US");
  });

  test("digital B2C outside the covered states is out of EU VAT scope, not a silent zero", () => {
    const result = determineCrossBorderSupply({
      ...B2C_DIGITAL,
      evidence: [
        { kind: "billing_address", country: "US" },
        { kind: "ip_country", country: "US" },
      ],
    });
    assert.equal(result.outcome, "export");
    assert.equal(result.country, "US");
  });

  test("a home-state supply stays domestic", () => {
    const result = determineCrossBorderSupply({
      ...B2C_DIGITAL,
      evidence: [
        { kind: "billing_address", country: "IE" },
        { kind: "ip_country", country: "IE" },
      ],
    });
    assert.equal(result.outcome, "seller_country");
    assert.equal(result.country, "IE");
  });
});

describe("EU distance-sales threshold", () => {
  test("crossing EUR 10,000 raises the alert with the new total", () => {
    const result = assessEuDistanceThreshold("9999.99", "0.01");
    assert.equal(result.crossed, true);
    assert.equal(result.total, "10000.0000");
    assert.match(result.alert, /10,000/);
  });

  test("staying below the threshold reports the running total", () => {
    const result = assessEuDistanceThreshold("8000.00", "1500.00");
    assert.equal(result.crossed, false);
    assert.equal(result.total, "9500.0000");
    assert.equal(result.alert, null);
  });
});
