import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCpa005File,
  buildNachaFile,
  buildSepaFile,
  carryingAmountForSettlement,
  type Cpa005Run,
  type EftSettings,
  type NachaSettings,
  PaymentError,
  realizedFxControlAdjustment,
} from "./payments.ts";

test("partial settlement allocates carrying value exactly beyond Number's safe range", () => {
  assert.equal(
    carryingAmountForSettlement("900719925474.0991", "300000000000.0000", "100000000000.0000"),
    "300239975158.0330",
  );
});

test("final settlement consumes the exact residual without a rounding tail", () => {
  assert.equal(carryingAmountForSettlement("0.0001", "0.3333", "0.3333"), "0.0001");
  assert.throws(
    () => carryingAmountForSettlement("10", "5", "5.0001"),
    (error: Error) => error instanceof PaymentError,
  );
});

test("realized FX adjustment clears customer and vendor control carrying values", () => {
  // Customer invoice AR +120 settled by receipt AR -130: debit AR 10,
  // credit realized gain 10.
  assert.equal(realizedFxControlAdjustment("-130.0000", "120.0000"), "10.0000");
  // Vendor bill AP -120 settled by payment AP +130: credit AP 10,
  // debit realized loss 10.
  assert.equal(realizedFxControlAdjustment("130.0000", "-120.0000"), "-10.0000");
  assert.equal(realizedFxControlAdjustment("120.0000", "-120.0000"), "0.0000");
});

// ---------------------------------------------------------------------------
// CPA-005 credit file — Payments Canada Standard 005 (2024 ed.)
// ---------------------------------------------------------------------------

const EFT: EftSettings = {
  originatorId: "0123456789",
  originatorShortName: "ACME SHORT",
  originatorLongName: "ACME CONSTRUCTION LIMITED",
  dataCentre: "12345",
  originatingDataCentre: "54321",
  institution: "003",
  transit: "00412",
  account: "1234567",
};

const NACHA: NachaSettings = {
  odfiRouting: "021000021",
  immediateDestination: " 021000021",
  immediateOrigin: " 123456789",
  destinationName: "BANK",
  originName: "ACME",
  companyName: "ACME CONSTRUCTION",
  companyId: "1123456789",
};

function nachaFile(accountNumber: string): string {
  return buildNachaFile({
    settings: NACHA,
    effectiveDate: new Date(2026, 2, 5),
    creationDate: new Date(2026, 2, 3),
    entries: [{
      transactionCode: "22",
      routingNumber: "021000021",
      accountNumber,
      amountCents: 12500n,
      individualId: "BILL-0001",
      individualName: "FIRST PAYEE",
    }],
  });
}

function cpa005Run(overrides: Partial<Cpa005Run> = {}): Cpa005Run {
  return {
    settings: EFT,
    fileCreationNumber: 7,
    fileCreationDate: new Date(2026, 2, 3),
    payments: [
      {
        amountCents: 125_00n,
        fundsDate: new Date(2026, 2, 5),
        institution: "004",
        transit: "10231",
        accountNumber: "998877",
        payeeName: "FIRST PAYEE",
        crossReference: "BILL-0001",
      },
      {
        amountCents: 4_999n,
        fundsDate: new Date(2026, 2, 5),
        institution: "001",
        transit: "20044",
        accountNumber: "112233",
        payeeName: "SECOND PAYEE",
        crossReference: "BILL-0002",
      },
    ],
    ...overrides,
  };
}

/** The 240-character credit segments of the file's single C record. */
function creditSegments(content: string): string[] {
  const record = content.split("\r\n").find((r) => r.startsWith("C"));
  assert.ok(record, "file has no C record");
  const body = record.slice(24); // "C" + 9-digit sequence + 14-char origin control
  return [body.slice(0, 240), body.slice(240, 480)];
}

test("the CPA-005 item trace number carries its four mandated components", () => {
  const segments = creditSegments(buildCpa005File(cpa005Run()));

  // DE 12 (segment positions 41–62): destination data centre with the trailing
  // digit dropped (4) + originating direct clearer's data centre (5) + file
  // creation number (4) + item sequence (9). Zero-filling any component is a
  // rejected item, which is what this writer used to emit.
  assert.equal(segments[0]!.slice(40, 62), "1234" + "54321" + "0007" + "000000001");
  assert.equal(segments[1]!.slice(40, 62), "1234" + "54321" + "0007" + "000000002");
  // The sequence is per item within the file, so no two credits share a trace.
  assert.notEqual(segments[0]!.slice(40, 62), segments[1]!.slice(40, 62));
});

test("composing the item trace number leaves every other credit-segment offset alone", () => {
  const first = creditSegments(buildCpa005File(cpa005Run()))[0]!;

  assert.equal(first.length, 240);
  assert.equal(first.slice(0, 3), "460"); // transaction type
  assert.equal(first.slice(3, 13), "0000012500"); // amount, implied cents
  assert.equal(first.slice(13, 19), "026064"); // 0YYDDD funds date (2026-03-05)
  assert.equal(first.slice(19, 28), "000410231"); // payee institutional id
  assert.equal(first.slice(28, 40), "998877      "); // payee account number
  assert.equal(first.slice(62, 65), "000"); // stored transaction type
  assert.equal(first.slice(65, 80), "ACME SHORT     "); // originator short name
  assert.equal(first.slice(80, 110), "FIRST PAYEE".padEnd(30, " "));
  assert.equal(first.slice(110, 140), "ACME CONSTRUCTION LIMITED".padEnd(30, " "));
  assert.equal(first.slice(140, 150), "0123456789"); // originator user id
  assert.equal(first.slice(150, 169), "BILL-0001".padEnd(19, " "));
  assert.equal(first.slice(169, 178), "000300412"); // institutional id for returns
  assert.equal(first.slice(178, 190), "1234567     "); // account for returns
  assert.equal(first.slice(190, 205), " ".repeat(15)); // originator sundry info
  assert.equal(first.slice(205, 227), " ".repeat(22)); // filler
  assert.equal(first.slice(227, 229), "  "); // settlement code
  assert.equal(first.slice(229, 240), "0".repeat(11)); // invalid data element id

  // Record framing is unchanged: 1464-character A/C/Z records, CRLF-joined.
  const records = buildCpa005File(cpa005Run()).split("\r\n").filter((r) => r !== "");
  assert.deepEqual(records.map((r) => r[0]), ["A", "C", "Z"]);
  for (const record of records) assert.equal(record.length, 1464);
});

// ---------------------------------------------------------------------------
// SEPA pain.001 credit file — exact 2dp amounts, positive credits only
// ---------------------------------------------------------------------------

const SEPA_SETTINGS = {
  originatorName: "ACME CONSTRUCTION LIMITED",
  originatorIban: "DE89370400440532013000",
  originatorBic: "COBADEFFXXX",
};

function sepaPayment(amount: string) {
  return {
    endToEndId: "E2E-BILL-0001",
    amount,
    creditorName: "FIRST PAYEE",
    creditorIban: "FR1420041010050500013M02606",
    remittance: "BILL-0001",
  };
}

function sepaFile(amounts: string[]): string {
  return buildSepaFile({
    settings: SEPA_SETTINGS,
    messageId: "MSG-0001",
    creationDateTime: "2026-03-03T00:00:00",
    executionDate: "2026-03-05",
    payments: amounts.map(sepaPayment),
  });
}

test("the SEPA credit file carries exact instruction amounts in CtrlSum and InstdAmt", () => {
  const content = sepaFile(["125.00", "49.99"]);

  assert.match(content, /<NbOfTxs>2<\/NbOfTxs>/);
  assert.match(content, /<CtrlSum>174.99<\/CtrlSum>/);
  assert.match(content, /<InstdAmt Ccy="EUR">125.00<\/InstdAmt>/);
  assert.match(content, /<InstdAmt Ccy="EUR">49.99<\/InstdAmt>/);
});

test("the SEPA credit file refuses non-positive payments instead of emitting them", () => {
  for (const amount of ["-5.00", "0.00"]) {
    assert.throws(
      () => sepaFile([amount]),
      (error: Error) => error instanceof PaymentError && /payment amounts must be positive/.test(error.message),
      `amount "${amount}" must not reach the bank`,
    );
  }
});

test("the SEPA credit file refuses sub-cent precision instead of rounding it", () => {
  assert.throws(
    () => sepaFile(["10.005"]),
    (error: Error) => error instanceof PaymentError && /sub-cent precision/.test(error.message),
  );
});

test("the SEPA credit file refuses a creditor IBAN with an invalid checksum", () => {
  assert.throws(
    () => buildSepaFile({
      settings: SEPA_SETTINGS,
      messageId: "MSG-0001",
      creationDateTime: "2026-03-03T00:00:00",
      executionDate: "2026-03-05",
      payments: [{
        ...sepaPayment("125.00"),
        creditorIban: "DE89370400440532013001",
      }],
    }),
    (error: Error) => error instanceof PaymentError && /creditor IBAN/.test(error.message),
  );
});

test("the NACHA credit file refuses a blank receiving account number", () => {
  assert.throws(
    () => nachaFile("   "),
    (error: Error) => error instanceof PaymentError && /account number/.test(error.message),
  );
});

test("the NACHA credit file refuses a receiving account number longer than its field", () => {
  assert.throws(
    () => nachaFile("123456789012345678"),
    (error: Error) => error instanceof PaymentError && /17 characters/.test(error.message),
  );
});

test("the CPA-005 credit file refuses a payee account number longer than its field", () => {
  const run = cpa005Run();
  assert.throws(
    () => buildCpa005File({
      ...run,
      payments: run.payments.map((payment, index) =>
        index === 0 ? { ...payment, accountNumber: "1234567890123" } : payment,
      ),
    }),
    (error: Error) => error instanceof PaymentError && /payee account number.*12 characters/.test(error.message),
  );
});

test("a data centre that cannot form a valid trace number refuses to write a file", () => {
  for (const originatingDataCentre of ["00000", "543", "FILL-ME"]) {
    assert.throws(
      () => buildCpa005File(cpa005Run({ settings: { ...EFT, originatingDataCentre } })),
      (error: Error) =>
        error instanceof PaymentError && /originating direct clearer's data centre/.test(error.message),
      `originatingDataCentre "${originatingDataCentre}" must not reach the bank`,
    );
  }
  assert.throws(
    () => buildCpa005File(cpa005Run({ settings: { ...EFT, dataCentre: "1234" } })),
    (error: Error) => error instanceof PaymentError && /destination data centre/.test(error.message),
  );
});
