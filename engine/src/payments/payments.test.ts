import assert from "node:assert/strict";
import test from "node:test";
import { buildCpa005File, type Cpa005Run } from "./rail-cpa005.ts";
import { buildNachaFile, nachaFileIdModifierForRunNumber, nachaFileIdModifierForSequence } from "./rail-nacha.ts";
import { buildSepaFile } from "./rail-sepa.ts";
import { carryingAmountForSettlement, persistPaymentFxRate, realizedFxControlAdjustment, sameCurrencyAllocation } from "./settlement-policy.ts";
import { type EftSettings } from "./rail-settings.ts";
import { type NachaSettings } from "./rail-nacha.ts";
import { PaymentError } from "./payment-errors.ts";

test("payment FX rates share the positive, invertible numeric storage domain", () => {
  assert.equal(persistPaymentFxRate("1.25"), "1.2500000000");
  assert.throws(
    () => persistPaymentFxRate("0.0000000010"),
    (error: Error) => error instanceof PaymentError && /inverse fit numeric\(19,10\)/.test(error.message),
  );
  assert.throws(
    () => persistPaymentFxRate("1000000000"),
    (error: Error) => error instanceof PaymentError && /inverse fit numeric\(19,10\)/.test(error.message),
  );
});

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
    effectiveDate: "2026-03-05",
    creationDateTime: "2026-03-03T00:00:00",
    fileIdModifier: "A",
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
    fileCreationDate: "2026-03-03",
    payments: [
      {
        amountCents: 125_00n,
        fundsDate: "2026-03-05",
        institution: "004",
        transit: "10231",
        accountNumber: "998877",
        payeeName: "FIRST PAYEE",
        crossReference: "BILL-0001",
      },
      {
        amountCents: 4_999n,
        fundsDate: "2026-03-05",
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

test("the SEPA credit file refuses a malformed creditor BIC when supplied", () => {
  assert.throws(
    () => buildSepaFile({
      settings: SEPA_SETTINGS,
      messageId: "MSG-0001",
      creationDateTime: "2026-03-03T00:00:00",
      executionDate: "2026-03-05",
      payments: [{
        ...sepaPayment("125.00"),
        creditorBic: "NOT-A-BIC",
      }],
    }),
    (error: Error) => error instanceof PaymentError && /creditor BIC/.test(error.message),
  );
});

test("the SEPA credit file normalizes a lowercase creditor BIC", () => {
  const content = buildSepaFile({
    settings: SEPA_SETTINGS,
    messageId: "MSG-0001",
    creationDateTime: "2026-03-03T00:00:00",
    executionDate: "2026-03-05",
    payments: [{
      ...sepaPayment("125.00"),
      creditorBic: "cobadeffxxx",
    }],
  });
  assert.match(content, /<BIC>COBADEFFXXX<\/BIC>/);
  assert.doesNotMatch(content, /<BIC>cobadeffxxx<\/BIC>/);
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

test("the NACHA credit file refuses to write without an allocated file ID modifier", () => {
  // The modifier is the bank's same-day duplicate-file key: defaulting it to
  // "A" gave every AP file the same identity. Payroll already throws without
  // one; the shared builder now does too.
  for (const fileIdModifier of [undefined, "", "AB", "a", "*"] as const) {
    assert.throws(
      () =>
        buildNachaFile({
          settings: NACHA,
          effectiveDate: "2026-03-05",
          creationDateTime: "2026-03-03T00:00:00",
          fileIdModifier,
          entries: [{
            transactionCode: "22",
            routingNumber: "021000021",
            accountNumber: "998877",
            amountCents: 12500n,
            individualId: "BILL-0001",
            individualName: "FIRST PAYEE",
          }],
        }),
      (error: Error) => error instanceof PaymentError && /allocated file ID modifier/.test(error.message),
      `modifier ${JSON.stringify(fileIdModifier)} must not reach the bank`,
    );
  }
});

test("the NACHA credit file carries its allocated modifier and real creation time in the header", () => {
  const content = buildNachaFile({
    settings: NACHA,
    effectiveDate: "2026-03-05",
    creationDateTime: "2026-03-03T14:05:00",
    fileIdModifier: "B",
    entries: [{
      transactionCode: "22",
      routingNumber: "021000021",
      accountNumber: "998877",
      amountCents: 12500n,
      individualId: "BILL-0001",
      individualName: "FIRST PAYEE",
    }],
  });
  const header = content.split("\n")[0]!;
  // YYMMDD + HHMM + modifier: 260303 + 1405 + B.
  assert.ok(header.includes("2603031405B094"), `header carries date, time and modifier: ${header}`);
});

test("the NACHA modifier allocator advances one letter per file and wraps the alphabet", () => {
  assert.equal(nachaFileIdModifierForSequence(1), "A");
  assert.equal(nachaFileIdModifierForSequence(2), "B");
  assert.equal(nachaFileIdModifierForSequence(26), "Z");
  assert.equal(nachaFileIdModifierForSequence(27), "0");
  assert.equal(nachaFileIdModifierForSequence(36), "9");
  assert.equal(nachaFileIdModifierForSequence(37), "A");
  assert.equal(nachaFileIdModifierForRunNumber("PR-0001"), "A");
  assert.equal(nachaFileIdModifierForRunNumber("PR-0002"), "B");
  // Consecutive runs never share a modifier, so a second file the same day
  // to the same bank cannot collide on "A".
  assert.notEqual(
    nachaFileIdModifierForRunNumber("PR-0002"),
    nachaFileIdModifierForRunNumber("PR-0001"),
  );
});

test("the NACHA creation stamp renders the caller's zoned stamp verbatim", () => {
  // The rail takes an already-zoned `YYYY-MM-DDTHH:MM:SS` stamp — the caller
  // converts the instant in the org's zone once, so no server clock is read
  // here. A string stamp renders the same header on every host by
  // construction; the two-host proof lives in bank-file-civil-dates.test.ts.
  const file = (creationDateTime: string) =>
    buildNachaFile({
      settings: NACHA,
      effectiveDate: "2026-03-05",
      creationDateTime,
      fileIdModifier: "B",
      entries: [{
        transactionCode: "22",
        routingNumber: "021000021",
        accountNumber: "998877",
        amountCents: 12500n,
        individualId: "BILL-0001",
        individualName: "FIRST PAYEE",
      }],
    }).split("\n")[0]!;
  // 2026-03-03T04:05Z is March 3rd 04:05 in UTC but March 2nd 23:05 in New
  // York: each zoned stamp renders exactly its own day and time.
  assert.ok(file("2026-03-03T04:05:00").includes("2603030405B094"), `UTC stamp: ${file("2026-03-03T04:05:00")}`);
  assert.ok(file("2026-03-02T23:05:00").includes("2603022305B094"), `New York stamp: ${file("2026-03-02T23:05:00")}`);
});

test("the NACHA builder refuses a malformed creation stamp instead of guessing", () => {
  for (const creationDateTime of ["2026-03-03 04:05:00", "2026-13-03T04:05:00", "not-a-stamp"] as const) {
    assert.throws(
      () =>
        buildNachaFile({
          settings: NACHA,
          effectiveDate: "2026-03-05",
          creationDateTime,
          fileIdModifier: "B",
          entries: [{
            transactionCode: "22",
            routingNumber: "021000021",
            accountNumber: "998877",
            amountCents: 12500n,
            individualId: "BILL-0001",
            individualName: "FIRST PAYEE",
          }],
        }),
      (error: Error) => error instanceof PaymentError && /YYYY-MM-DDTHH:MM:SS zoned timestamp/.test(error.message),
      `stamp ${JSON.stringify(creationDateTime)} must not reach the bank`,
    );
  }
});

test("the NACHA builder refuses a non-calendar effective date instead of emitting it", () => {
  assert.throws(
    () =>
      buildNachaFile({
        settings: NACHA,
        effectiveDate: "2026-02-30",
        creationDateTime: "2026-03-03T04:05:00",
        fileIdModifier: "B",
        entries: [{
          transactionCode: "22",
          routingNumber: "021000021",
          accountNumber: "998877",
          amountCents: 12500n,
          individualId: "BILL-0001",
          individualName: "FIRST PAYEE",
        }],
      }),
    (error: Error) => error instanceof PaymentError && /effective date "2026-02-30" is not a valid YYYY-MM-DD civil day/.test(error.message),
  );
});

test("the CPA-005 creation date renders the caller's civil day verbatim", () => {
  // Same coverage as the NACHA stamp test above: the rail takes an
  // already-zoned civil day, so the A record carries exactly that day's
  // 0YYDDD on every host. March 3rd 2026 is julian day 62, March 2nd day 61.
  const aRecord = (fileCreationDate: string) =>
    buildCpa005File(cpa005Run({ fileCreationDate })).split("\r\n")[0]!;
  assert.ok(aRecord("2026-03-03").includes("026062"), `March 3rd creation date: ${aRecord("2026-03-03")}`);
  assert.ok(aRecord("2026-03-02").includes("026061"), `March 2nd creation date: ${aRecord("2026-03-02")}`);
});

test("the CPA-005 builder refuses a non-calendar creation day instead of emitting it", () => {
  assert.throws(
    () => buildCpa005File(cpa005Run({ fileCreationDate: "2026-02-30" })),
    (error: Error) => error instanceof PaymentError && /file creation date "2026-02-30" is not a valid YYYY-MM-DD civil day/.test(error.message),
  );
});

test("the NACHA credit file refuses an amount that does not fit its field instead of truncating it", () => {
  // 10,000,000,000 cents is 11 digits: the old slice(0, 10) kept the leading
  // ten and silently dropped the ones place.
  assert.throws(
    () =>
      buildNachaFile({
        settings: NACHA,
        effectiveDate: "2026-03-05",
        creationDateTime: "2026-03-03T00:00:00",
        fileIdModifier: "A",
        entries: [{
          transactionCode: "22",
          routingNumber: "021000021",
          accountNumber: "998877",
          amountCents: 10_000_000_000n,
          individualId: "BILL-0001",
          individualName: "FIRST PAYEE",
        }],
      }),
    (error: Error) => error instanceof PaymentError && /payment amount of 11 digits does not fit its 10-digit field/.test(error.message),
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

test("the CPA-005 credit file refuses a blank payee account number", () => {
  const run = cpa005Run();
  assert.throws(
    () => buildCpa005File({
      ...run,
      payments: run.payments.map((payment, index) =>
        index === 0 ? { ...payment, accountNumber: "   " } : payment,
      ),
    }),
    (error: Error) => error instanceof PaymentError && /payee account number.*blank/.test(error.message),
  );
});

test("the CPA-005 credit file refuses an oversized cross-reference", () => {
  const run = cpa005Run();
  assert.throws(
    () => buildCpa005File({
      ...run,
      payments: run.payments.map((payment, index) =>
        index === 0 ? { ...payment, crossReference: "12345678901234567890" } : payment,
      ),
    }),
    (error: Error) => error instanceof PaymentError && /cross-reference.*19 characters/.test(error.message),
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

test("partial settlement keeps dust visible and splits sum back to the whole", () => {
  // A truncating-division swap zeroes the dust row; an argument swap posts
  // multiples of the open balance instead of fractions of it.
  const cases: Array<[string, string, string, string]> = [
    ["100.0000", "100.0000", "30.0000", "30.0000"],
    ["100.0000", "3.0000", "1.0000", "33.3333"],
    ["0.0003", "0.0003", "0.0001", "0.0001"],
    ["-100.0000", "100.0000", "30.0000", "-30.0000"],
    ["0.0001", "0.0001", "0.0001", "0.0001"],
  ];
  for (const [openBase, openTxn, settledTxn, expected] of cases) {
    assert.equal(
      carryingAmountForSettlement(openBase, openTxn, settledTxn),
      expected,
      `settle ${settledTxn} of ${openTxn} (base ${openBase})`,
    );
  }
  // Settling in two steps accounts for the whole carrying value exactly:
  // first 30 of 100, then the remaining 70 closes at its full value.
  const first = carryingAmountForSettlement("100.0000", "100.0000", "30.0000");
  const second = carryingAmountForSettlement("70.0000", "70.0000", "70.0000");
  assert.equal(first, "30.0000");
  assert.equal(second, "70.0000");
});

test("settlement refuses zero, negative and over-application", () => {
  // Zero or negative settlement amounts would record applications that move
  // no money; over-application would settle more than the item holds. All
  // three must be PaymentError, never a silent clamp.
  for (const settled of ["0.0000", "-0.0001", "-5.0000"]) {
    assert.throws(
      () => carryingAmountForSettlement("10.0000", "10.0000", settled),
      (error: Error) => error instanceof PaymentError,
      `settled=${settled}`,
    );
  }
  assert.throws(
    () => carryingAmountForSettlement("10.0000", "10.0000", "10.0001"),
    (error: Error) => error instanceof PaymentError,
    "settled above open",
  );
  assert.throws(
    () => carryingAmountForSettlement("10.0000", "5.0000", "5.0001"),
    (error: Error) => error instanceof PaymentError,
    "settled above open transaction",
  );
});

test("realized FX adjustment signs gain and loss, including dust", () => {
  // The adjustment is the exact opposite of the carrying pair: a dropped
  // negation books gains as losses. Dust rows pin the sign at one unit.
  const cases: Array<[string, string, string]> = [
    ["-130.0000", "120.0000", "10.0000"],
    ["130.0000", "-120.0000", "-10.0000"],
    ["120.0000", "-120.0000", "0.0000"],
    ["-0.0001", "0.0000", "0.0001"],
    ["0.0001", "0.0000", "-0.0001"],
    ["100.0000", "-99.9999", "-0.0001"],
    ["-100.0000", "99.9999", "0.0001"],
    ["0.0000", "0.0000", "0.0000"],
  ];
  for (const [source, target, expected] of cases) {
    assert.equal(realizedFxControlAdjustment(source, target), expected, `${source} vs ${target}`);
  }
});

test("same-currency allocation carries equal amounts and a rate of one", () => {
  // This shape is what the settlement-evidence validator requires for
  // same-currency applications: equal amounts, unit rate, same_currency
  // source, a human reference, and no provider observation.
  const allocation = sameCurrencyAllocation("line-1", "125.5000");
  assert.equal(allocation.openLineId, "line-1");
  assert.equal(allocation.sourceTransactionAmount, "125.5000");
  assert.equal(allocation.targetTransactionAmount, "125.5000");
  assert.equal(allocation.targetBaseAmount, undefined);
  assert.equal(allocation.settlementRate, "1");
  assert.equal(allocation.settlementRateSource, "same_currency");
  assert.ok(allocation.settlementRateReference.trim().length > 0);
  assert.equal(allocation.settlementFxRateId ?? null, null);
  const withBase = sameCurrencyAllocation("line-2", "10.0000", "10.0000");
  assert.equal(withBase.targetBaseAmount, "10.0000");
  assert.equal(withBase.sourceTransactionAmount, withBase.targetTransactionAmount);
});
