import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { utcDateFromParts } from "../platform/civil-date.ts";
import {
  buildRbcStd152File,
  type RbcStd152Settings,
  type RbcStd152Payment,
} from "./rail-rbc-std152.ts";

const settings: RbcStd152Settings = {
  clientNumber: "1234567890",
  originatorLongName: "Example Employer",
  originatorShortName: "Example",
  transactionCode: "200",
  serviceCurrency: "CAD",
  transmission: "file_transfer_legacy",
  environment: "production",
};
const credit: RbcStd152Payment = {
  amountCents: 189989n,
  fundsDate: "2026-07-16",
  institution: "003",
  transit: "01234",
  accountNumber: "00123456",
  payeeName: "O’Neil-Smith, Élodie J.",
  crossReference: "PAY 1234",
};
const build = (changes: Partial<RbcStd152Payment> = {}, config = settings) =>
  buildRbcStd152File({
    settings: config,
    fileCreationNumber: 37,
    fileCreationDate: "2026-07-15",
    payments: [{ ...credit, ...changes }],
  });

test("STD152 uses published offsets, exact cents, significant account digits and monotonic logical sequence", () => {
  const [routing, header, payment, trailer, end] = build().split("\r\n");
  assert.equal(routing!.length, 94);
  assert.ok(routing!.startsWith("$$AAPDSTD0152[PROD[NL$$"));
  for (const record of [header!, payment!, trailer!])
    assert.equal(Buffer.byteLength(record, "ascii"), 152);
  assert.equal(header!.slice(0, 20), "000001AHDR1234567890");
  assert.equal(header!.slice(50, 65), "00372026196CAD1");
  assert.equal(payment!.slice(0, 20), "000002C2001234567890");
  assert.equal(payment!.slice(42, 51), "000301234");
  assert.equal(payment!.slice(51, 69), "00123456          ");
  assert.equal(payment!.slice(70, 80), "0000189989");
  assert.equal(payment!.slice(86, 93), "2026197");
  assert.equal(payment!.slice(93, 123).trim(), "O NEIL SMITH ELODIE J");
  assert.equal(payment!.slice(140, 152), "CAD CAN    N");
  assert.equal(trailer!.slice(0, 20), "000003ZTRL1234567890");
  assert.equal(trailer!.slice(20, 40), "00000100000000189989");
  assert.equal(end, "");
  assert.equal(build(), build());
});

test("STD152 refuses unsupported names, invalid civil dates, dates outside bank window and overflowing cash", () => {
  assert.throws(() => build({ payeeName: "Example\nRecipient" }), /ASCII/);
  assert.throws(() => build({ payeeName: "李" }), /ASCII/);
  assert.throws(() => build({ fundsDate: "2026-02-30" }), /civil day/);
  assert.throws(() => build({ fundsDate: "2026-06-14" }), /30 days/);
  assert.throws(() => build({ amountCents: 10000000000n }), /10-digit/);
  assert.throws(() => build({ amountCents: 0n }), /positive integer/);
  assert.throws(() => build({ accountNumber: "001-234" }), /significant/);
});

test("STD152 supports explicit test and direct transmission without silently changing service currency", () => {
  const records = build(
    {},
    { ...settings, transmission: "direct", environment: "test", serviceCurrency: "USD" },
  ).split("\r\n");
  assert.equal(records[0]!.length, 152);
  assert.equal(records[0]!.slice(50, 54), "TEST");
  assert.equal(records[0]!.slice(61, 64), "USD");
  assert.equal(records[1]!.slice(140, 143), "USD");
});

function isoOrdinal(value: string): string {
  const date = utcDateFromParts(Number(value.slice(0, 4)), 0, Number(value.slice(4)));
  return date.toISOString().slice(0, 10);
}

// Synthetic diagnostics retain a legacy producer's restarted sequence and
// conventional recipient punctuation. They are input evidence, not bank-valid goldens.
for (const [name, count] of [
  ["main", 94],
  ["additional", 12],
] as const) {
  test(`STD152 preserves ${name} synthetic diagnostic cash, routing, references and dates while normalizing names and sequence`, () => {
    const original = readFileSync(
      new URL(`./fixtures/rbc-std152/${name}-synthetic.txt`, import.meta.url),
      "ascii",
    )
      .split("\r\n")
      .filter(Boolean);
    const header = original[1]!;
    const sourceCredits = original.filter((record) => record[6] === "C");
    const sourceTrailer = original.at(-1)!;
    assert.equal(sourceCredits.length, count);
    const config: RbcStd152Settings = {
      clientNumber: header.slice(10, 20),
      originatorLongName: header.slice(20, 50).trim(),
      originatorShortName: sourceCredits[0]!.slice(125, 140).trim(),
      transactionCode: "200",
      serviceCurrency: "CAD",
      transmission: "file_transfer_legacy",
      environment: "test",
    };
    const generated = buildRbcStd152File({
      settings: config,
      fileCreationNumber: 1,
      fileCreationDate: isoOrdinal(header.slice(54, 61)),
      payments: sourceCredits.map((record) => ({
        amountCents: BigInt(record.slice(70, 80)),
        fundsDate: isoOrdinal(record.slice(86, 93)),
        institution: record.slice(43, 46),
        transit: record.slice(46, 51),
        accountNumber: record.slice(51, 69).trim(),
        payeeName: record.slice(93, 123).trim(),
        crossReference: record.slice(21, 40).trim(),
        paymentNumber: record.slice(40, 42),
        language: record[123] as "E" | "F",
      })),
    })
      .split("\r\n")
      .filter(Boolean);
    assert.equal(generated.length, original.length);
    generated.slice(1).forEach((record, index) => {
      assert.equal(record.length, 152);
      assert.equal(record.slice(0, 6), String(index + 1).padStart(6, "0"));
    });
    sourceCredits.forEach((source, index) => {
      const target = generated[index + 2]!;
      assert.equal(target.slice(40, 93), source.slice(40, 93));
      assert.equal(target.slice(21, 40), source.slice(21, 40).toUpperCase());
      assert.equal(
        target.slice(93, 123).trim(),
        source
          .slice(93, 123)
          .toUpperCase()
          .replace(/[.,'-]/g, " ")
          .replace(/ +/g, " ")
          .trim(),
      );
    });
    assert.equal(generated.at(-1)!.slice(20, 40), sourceTrailer.slice(20, 40));
  });
}
