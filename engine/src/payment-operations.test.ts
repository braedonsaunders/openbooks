import assert from "node:assert/strict";
import test from "node:test";
import { nachaOriginator, sepaOriginator } from "./payment-operations.ts";
import { PaymentError } from "./payments.ts";

/**
 * A debit profile's originator settings arrive as decrypted tenant JSON, so the
 * debit rails have to hold the same line the credit rails hold in
 * `validateNachaSettings`: nothing is a string until it is shown to be one, an
 * unfinished profile is a named refusal, and the ODFI routing is exactly nine
 * digits before the writer slices it to eight.
 */

const NACHA_ORIGINATOR = {
  odfiRouting: "021000021",
  immediateDestination: " 021000021",
  immediateOrigin: "1234567890",
  destinationName: "BANK OF EXAMPLE",
  originName: "EXAMPLE CONSTRUCTION",
  companyName: "EXAMPLE CONST",
  companyId: "1123456789",
};

test("a complete NACHA debit originator parses, trimmed, with the corporate SEC default", () => {
  const settings = nachaOriginator({ ...NACHA_ORIGINATOR, companyName: "  EXAMPLE CONST  " });
  assert.equal(settings.odfiRouting, "021000021");
  assert.equal(settings.companyName, "EXAMPLE CONST");
  assert.equal(settings.entryClassCode, undefined);
  assert.equal(settings.entryDescription, undefined);
});

test("an unfinished NACHA debit profile is named, never written into a file", () => {
  assert.throws(
    () => nachaOriginator({ ...NACHA_ORIGINATOR, companyId: "FILL-ME" }),
    (error: Error) => error instanceof PaymentError && error.message.includes("companyId"),
  );
});

test("a NACHA debit field that is not a string counts as missing rather than stringifying", () => {
  assert.throws(
    () => nachaOriginator({ ...NACHA_ORIGINATOR, originName: { toString: () => "EXAMPLE" } }),
    (error: Error) => error instanceof PaymentError && error.message.includes("originName"),
  );
});

test("an over-long odfiRouting is refused rather than truncated to the wrong institution", () => {
  // The writer slices odfiRouting to 8 characters for the batch and file
  // trailers, so 13 digits would still produce a well-formed 94-character file
  // — addressed to an originating bank the tenant never named.
  assert.throws(
    () => nachaOriginator({ ...NACHA_ORIGINATOR, odfiRouting: "0210000219999" }),
    (error: Error) => error instanceof PaymentError && error.message.includes("9-digit"),
  );
  assert.throws(
    () => nachaOriginator({ ...NACHA_ORIGINATOR, odfiRouting: "02100" }),
    (error: Error) => error instanceof PaymentError && error.message.includes("9-digit"),
  );
});

test("an unrecognised SEC code falls back to CCD instead of reaching the 3-character field", () => {
  assert.equal(nachaOriginator({ ...NACHA_ORIGINATOR, entryClassCode: "WEB" }).entryClassCode, undefined);
  assert.equal(nachaOriginator({ ...NACHA_ORIGINATOR, entryClassCode: "PPD" }).entryClassCode, "PPD");
});

const SEPA_ORIGINATOR = {
  originatorName: "EXAMPLE CONSTRUCTION",
  originatorIban: "DE89370400440532013000",
  originatorBic: "COBADEFFXXX",
  creditorId: "DE98ZZZ09999999999",
};

test("a complete SEPA debit originator parses, trimmed", () => {
  const settings = sepaOriginator({ ...SEPA_ORIGINATOR, originatorBic: " COBADEFFXXX " });
  assert.equal(settings.originatorBic, "COBADEFFXXX");
  assert.equal(settings.creditorId, "DE98ZZZ09999999999");
});

test("an unfinished SEPA debit profile is named, never collected against", () => {
  assert.throws(
    () => sepaOriginator({ ...SEPA_ORIGINATOR, creditorId: "FILL-ME" }),
    (error: Error) => error instanceof PaymentError && error.message.includes("creditorId"),
  );
  assert.throws(
    () => sepaOriginator({ ...SEPA_ORIGINATOR, originatorIban: "   " }),
    (error: Error) => error instanceof PaymentError && error.message.includes("originatorIban"),
  );
});
