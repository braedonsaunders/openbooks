import assert from "node:assert/strict";
import test from "node:test";
// Side effect: publishes the built-in packs' certificate sources, the same
// way any production importer of the pack registry does.
import "./packs.ts";
import {
  certificateAnswersProblem,
  packCertificates,
  PayrollCertificateError,
  profileColumnChoices,
  profileColumnCountBounds,
  profileColumnField,
  registerPayrollCertificates,
} from "./certificates.ts";

/**
 * The profile editor and the profile POST read a pack's withholding form
 * through these helpers instead of reimplementing it (the W-4's choice set,
 * the TD1's 0–10 claim-code band). Pure: declarations are data, and these
 * cases never reach a database.
 */

registerPayrollCertificates({
  country: "XX",
  certificates: [
    {
      key: "xx_form",
      form: "XX-1",
      label: "Fixture withholding certificate",
      scope: { level: "country" },
      purpose: "withholding",
      citation: "Fixture statute, section 1",
      summary: "A fixture certificate for the column-mapping helpers.",
      storage: "profile_columns",
      fields: [
        {
          key: "status",
          label: "Filing status",
          kind: "choice",
          choices: [
            { value: "alone", label: "Alone" },
            { value: "together", label: "Together" },
          ],
          default: "alone",
          required: true,
          storage: { kind: "column", column: "filing_status" },
          help: "Who the fixture employee files with.",
        },
        {
          key: "codes",
          label: "Claim codes",
          kind: "count",
          min: "0",
          max: "5",
          storage: { kind: "column", column: "federal_claim_code" },
          help: "How many fixture credits are claimed.",
        },
        {
          key: "extra",
          label: "Extra amount",
          kind: "amount",
          decimals: 4,
          min: "0",
          storage: { kind: "column", column: "additional_tax_per_period" },
          help: "An extra fixture amount per period.",
        },
      ],
    },
  ],
});

test("profile column helpers read a pack's declared fields", () => {
  assert.deepEqual(profileColumnChoices("XX", "filing_status"), ["alone", "together"]);
  assert.deepEqual(profileColumnCountBounds("XX", "federal_claim_code"), { min: 0, max: 5 });
  assert.equal(profileColumnField("XX", "federal_claim_code")?.key, "codes");
});

test("profile column helpers refuse what the pack does not declare that way", () => {
  // Undeclared column: no field, no choices, no band.
  assert.equal(profileColumnField("XX", "w4_allowances"), null);
  assert.equal(profileColumnChoices("XX", "w4_allowances"), null);
  assert.equal(profileColumnCountBounds("XX", "w4_allowances"), null);
  // Declared, but the wrong kind: an amount is neither a choice nor a count.
  assert.equal(profileColumnChoices("XX", "additional_tax_per_period"), null);
  assert.equal(profileColumnCountBounds("XX", "additional_tax_per_period"), null);
  assert.equal(profileColumnCountBounds("XX", "filing_status"), null);
  // Unknown country: the pack registry's own refusal, not an empty answer.
  assert.throws(() => profileColumnField("ZZ", "filing_status"), PayrollCertificateError);
});

test("answer validation accepts a complete NL declaration and refuses what it does not admit", () => {
  // The write half of the pack-declared entry surface: the certificates API
  // validates here, so NL answers that pass this are exactly what the NL
  // engine reads back through the typed readers.
  const [opgaaf, premies] = packCertificates("NL").certificates;
  assert.equal(
    certificateAnswersProblem(opgaaf!, {
      apply_loonheffingskorting: "true",
      age_class: "aow_1946",
      aok_apply: "false",
      jgk_apply: "true",
    }),
    null,
  );
  assert.equal(
    certificateAnswersProblem(premies!, {
      awf_laag: "true",
      aof_hoog: "false",
      whk_percent: "1.25",
      sv_loon_ytd: "0",
    }),
    null,
  );
  // Absent answers fall back to declared defaults at read time, so only a
  // required field with no default is a problem when missing.
  assert.equal(certificateAnswersProblem(opgaaf!, {}), null);
  assert.equal(certificateAnswersProblem(premies!, {}), null);
  // An undeclared key is refused rather than stored where no engine reads it.
  assert.match(
    certificateAnswersProblem(opgaaf!, { nl_age_class: "under_aow" }) ?? "",
    /not a field/,
  );
  // A choice outside the declaration, a non-canonical flag, and a Whk
  // percentage outside 0–100 are all refused by name.
  assert.match(
    certificateAnswersProblem(opgaaf!, { age_class: "aow_1970" }) ?? "",
    /is not one of/,
  );
  assert.match(
    certificateAnswersProblem(opgaaf!, { apply_loonheffingskorting: "yes" }) ?? "",
    /not "true" or "false"/,
  );
  assert.match(certificateAnswersProblem(premies!, { whk_percent: "101" }) ?? "", /above the declared maximum/);
  assert.match(certificateAnswersProblem(premies!, { whk_percent: "een" }) ?? "", /not a decimal/);
  // The required FR domicile (no default) must be answered; an answered one
  // with the defaulted rate option passes.
  const pas = packCertificates("FR").certificates.find((certificate) => certificate.key === "fr_pas_option")!;
  assert.match(certificateAnswersProblem(pas, {}) ?? "", /"domicile" is required/);
  assert.equal(
    certificateAnswersProblem(pas, { domicile: "metropole" }),
    null,
  );
  // Count and code kinds, through the DE pack's real declaration.
  const nachweis = packCertificates("DE").certificates.find((certificate) => certificate.key === "de_pv_nachweis")!;
  assert.equal(
    certificateAnswersProblem(nachweis, { kinderlosenzuschlag: "true", abschlag_kinder: "2" }),
    null,
  );
  assert.match(
    certificateAnswersProblem(nachweis, { kinderlosenzuschlag: "true", abschlag_kinder: "5" }) ?? "",
    /above the declared maximum/,
  );
  const elstam = packCertificates("DE").certificates.find((certificate) => certificate.key === "de_elstam")!;
  assert.equal(certificateAnswersProblem(elstam, { konfession: "rk" }), null);
});

test("built-in packs expose the shapes the profile surface was hardcoding", () => {
  assert.deepEqual(profileColumnChoices("US", "filing_status"), [
    "single",
    "married_joint",
    "head_household",
  ]);
  assert.deepEqual(profileColumnCountBounds("CA", "federal_claim_code"), { min: 0, max: 10 });
  assert.deepEqual(profileColumnCountBounds("CA", "provincial_claim_code"), { min: 0, max: 10 });
  assert.deepEqual(profileColumnCountBounds("US", "w4_allowances"), { min: 0, max: 99 });
  // Canada declares no filing status: a non-null answer is refused, never
  // validated against the W-4's choices.
  assert.equal(profileColumnChoices("CA", "filing_status"), null);
});
