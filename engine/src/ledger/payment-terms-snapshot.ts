import type { DocumentPaymentTermsSnapshot } from "@openbooks/schema";
import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { isIsoCalendarDate } from "../platform/iso-date.ts";
import { addCalendarDays } from "../platform/civil-date.ts";
import { cmp } from "../money/money.ts";

type Subject = { kind: string; partyId: string | null; documentDate: string };

export class PaymentTermsEvidenceError extends Error {}

function refusal(): never {
  throw new PaymentTermsEvidenceError(
    "The posted bill has missing or invalid retained payment terms. Select a payment run without automatic discount capture; do not substitute current vendor terms for posted evidence.",
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

function days(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 3_652_058
  );
}

function percent(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{1,15}(?:\.\d{1,4})?$/.test(value) &&
    cmp(value, "0") >= 0 &&
    cmp(value, "100") < 0
  );
}

/** Validate stored authority before discount arithmetic or date construction. */
export function readDocumentPaymentTermsSnapshot(
  value: unknown,
  subject: Subject,
): DocumentPaymentTermsSnapshot {
  if (
    !record(value) ||
    !exactKeys(value, [
      "version",
      "mode",
      "source",
      "documentKind",
      "partyId",
      "documentDate",
      "terms",
    ]) ||
    value.version !== 1 ||
    value.documentKind !== subject.kind ||
    value.partyId !== subject.partyId ||
    value.documentDate !== subject.documentDate ||
    !isIsoCalendarDate(subject.documentDate) ||
    (subject.partyId !== null && !isUuid(subject.partyId))
  )
    refusal();
  if (value.mode === "not_applicable") {
    if (
      subject.kind !== "expense_report" ||
      value.source !== "not_applicable" ||
      value.terms !== null
    )
      refusal();
  } else {
    if (subject.kind !== "vendor_bill" || subject.partyId === null) refusal();
    if (value.source === "none") {
      if (value.mode !== "no_discount" || value.terms !== null) refusal();
    } else {
      if ((value.source !== "vendor" && value.source !== "company") || !record(value.terms))
        refusal();
      const terms = value.terms;
      if (
        !exactKeys(terms, [
          "id",
          "name",
          "netDays",
          "discountDays",
          "discountPercent",
          "revisionHash",
        ]) ||
        !isUuid(terms.id) ||
        typeof terms.name !== "string" ||
        !terms.name.trim() ||
        !days(terms.netDays) ||
        (terms.discountDays !== null && !days(terms.discountDays)) ||
        (terms.discountPercent !== null && !percent(terms.discountPercent)) ||
        typeof terms.revisionHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(terms.revisionHash)
      )
        refusal();
      const hasDiscount =
        terms.discountPercent !== null && cmp(terms.discountPercent as string, "0") > 0;
      if (hasDiscount && terms.discountDays === null) refusal();
      if (value.mode !== (hasDiscount ? "discount" : "no_discount")) refusal();
      try {
        addCalendarDays(subject.documentDate, terms.netDays as number);
        if (hasDiscount) addCalendarDays(subject.documentDate, terms.discountDays as number);
      } catch {
        refusal();
      }
    }
  }
  return value as unknown as DocumentPaymentTermsSnapshot;
}

/** Capture only at native posting, while the source rows remain locked through commit. */
export async function captureDocumentPaymentTerms(
  runner: SqlExecutor,
  orgId: string,
  subject: Subject,
): Promise<DocumentPaymentTermsSnapshot | null> {
  if (subject.kind !== "vendor_bill" && subject.kind !== "expense_report") return null;
  const base = {
    version: 1 as const,
    documentKind: subject.kind,
    partyId: subject.partyId,
    documentDate: subject.documentDate,
  };
  if (subject.kind === "expense_report") {
    return readDocumentPaymentTermsSnapshot(
      { ...base, mode: "not_applicable", source: "not_applicable", terms: null },
      subject,
    );
  }
  if (!subject.partyId || !isUuid(subject.partyId)) {
    throw new PaymentTermsEvidenceError(
      "A vendor bill needs a valid vendor before payment terms can be retained at posting.",
    );
  }
  // A party update lock also fences insertion of a previously absent vendor role.
  const party = (
    await runner.execute<{ id: string }>(
      sql`
    select id from parties where org_id = ${orgId} and id = ${subject.partyId} for update
  `,
      "objects",
    )
  )[0];
  if (!party)
    throw new PaymentTermsEvidenceError("The bill vendor was not found in this organization.");
  const role = (
    await runner.execute<{ payment_terms_id: string | null }>(
      sql`
    select payment_terms_id from vendor_roles
    where org_id = ${orgId} and party_id = ${subject.partyId} for share
  `,
      "objects",
    )
  )[0];
  let source: "vendor" | "company" = "vendor";
  let termsId: unknown = role?.payment_terms_id ?? null;
  if (termsId === null) {
    const organization = (
      await runner.execute<{ default_terms_id: unknown }>(
        sql`
      select settings #>> '{billing,defaultPaymentTermsId}' as default_terms_id
      from orgs where id = ${orgId} for share
    `,
        "objects",
      )
    )[0];
    if (!organization) throw new PaymentTermsEvidenceError("The bill organization was not found.");
    termsId = organization.default_terms_id;
    source = "company";
  }
  if (termsId === null) {
    return readDocumentPaymentTermsSnapshot(
      { ...base, mode: "no_discount", source: "none", terms: null },
      subject,
    );
  }
  if (!isUuid(termsId))
    throw new PaymentTermsEvidenceError(
      "The configured payment terms identifier is invalid. Correct the vendor or company payment terms before posting.",
    );
  const terms = (
    await runner.execute<{
      id: string;
      name: string;
      netDays: number;
      discountDays: number | null;
      discountPercent: string | null;
      revisionHash: string;
    }>(
      sql`
    select id, name, net_days as "netDays", discount_days as "discountDays", discount_percent::text as "discountPercent",
      encode(digest(convert_to((to_jsonb(payment_terms) - 'custom' - 'id' - 'org_id')::text, 'UTF8'), 'sha256'), 'hex') as "revisionHash"
    from payment_terms where org_id = ${orgId} and id = ${termsId} and is_active for share
  `,
      "objects",
    )
  )[0];
  if (!terms)
    throw new PaymentTermsEvidenceError(
      "The configured payment terms are missing or inactive. Select active terms before posting the bill.",
    );
  const snapshot = {
    ...base,
    source,
    mode:
      terms.discountPercent !== null &&
      percent(terms.discountPercent) &&
      cmp(terms.discountPercent, "0") > 0
        ? "discount"
        : "no_discount",
    terms,
  };
  try {
    return readDocumentPaymentTermsSnapshot(snapshot, subject);
  } catch (cause) {
    throw new PaymentTermsEvidenceError(
      "The configured payment terms need valid nonnegative days and a discount percentage below 100 before posting.",
      { cause },
    );
  }
}
