import { sql } from "drizzle-orm";
import { db, withBypass, withOrgContext, type SqlExecutor } from "../platform/db.ts";
import { isoDateOf } from "../platform/civil-date.ts";
import { addCalendarDays } from "../platform/civil-date.ts";
import { orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import { assertNotSandbox } from "../organization/sandbox-guard.ts";
import { checkAbn } from "../connectors/abn-lookup.ts";
import { checkHmrcVatId } from "../connectors/hmrc-vat.ts";
import { checkViesVatId } from "../connectors/vies.ts";
import {
  boundAuthorityExcerpt,
  normalizeVatId,
  VatValidationError,
  type VatAuthorityScheme,
  type VatAuthorityVerdict,
} from "../connectors/vat-validation.ts";
import { CrossBorderTaxError } from "./cross-border-place-of-supply.ts";
import { authorityCredentialsForOrg } from "./authority-connections.ts";

/**
 * Business VAT ID validation with cached verdicts and scheduled revalidation.
 *
 * A party_tax_ids row caches the authority's verdict (valid/invalid with the
 * consultation reference, or unverified when no authority has confirmed it).
 * Validate writes through the cache; the org-wide tax_id_revalidation scan
 * re-checks due valid IDs. An authority outage never flips a verdict — the
 * row keeps its previous status as unverified and the operator decides.
 */

export const TAX_ID_REVALIDATION_SCAN_KIND = "tax_id_revalidation";
const REVALIDATION_BATCH = 200;
const DEFAULT_REVALIDATE_AFTER_DAYS = 90;

export interface TaxIdCredentials {
  hmrcAccessToken?: string | null;
  abnGuid?: string | null;
}

export interface ValidateTaxIdOptions {
  transport?: typeof fetch;
  actorId?: string | null;
  reason?: string | null;
  credentials?: TaxIdCredentials;
  revalidateAfterDays?: number;
  today?: string;
}

export interface TaxIdValidationOutcome {
  rowId: string;
  status: "valid" | "invalid" | "unverified";
  consultationNumber: string | null;
  revalidateAfter: string | null;
}

type PartyTaxIdRow = {
  id: string;
  partyId: string;
  scheme: string;
  value: string;
  status: string;
}

async function checkAuthority(
  scheme: VatAuthorityScheme,
  value: string,
  credentials: TaxIdCredentials,
  transport?: typeof fetch,
): Promise<VatAuthorityVerdict> {
  if (scheme === "vies") return checkViesVatId({ value }, transport);
  if (scheme === "hmrc") return checkHmrcVatId({ value, accessToken: credentials.hmrcAccessToken }, transport);
  if (scheme === "abn") return checkAbn({ value, guid: credentials.abnGuid }, transport);
  throw new VatValidationError(
    "no authority client covers GST registrations outside VIES, HMRC and ABN; verify the number manually and record the outcome",
  );
}

/**
 * Validate one cached tax ID against its authority and persist the verdict.
 * Service failures keep the row unverified with the previous consultation
 * evidence; the throw tells the caller the authority — not the number — failed.
 */
export async function validatePartyTaxId(
  tx: SqlExecutor,
  orgId: string,
  rowId: string,
  options: ValidateTaxIdOptions = {},
): Promise<TaxIdValidationOutcome> {
  const rows = (
    await tx.execute<PartyTaxIdRow>(sql`
      select id, party_id as "partyId", scheme, value, status
        from party_tax_ids
       where org_id = ${orgId} and id = ${rowId} and is_active
    `)
  ).rows;
  const row = rows[0];
  if (!row) {
    throw new CrossBorderTaxError(
      "the tax ID row is gone or belongs to another organization; reload the customer record before validating",
    );
  }
  const scheme = row.scheme as VatAuthorityScheme;
  const value = normalizeVatId(scheme, row.value);
  const today = options.today ?? isoDateOf(new Date());
  const interval = options.revalidateAfterDays ?? DEFAULT_REVALIDATE_AFTER_DAYS;

  let verdict: VatAuthorityVerdict;
  try {
    verdict = await checkAuthority(scheme, value, options.credentials ?? {}, options.transport);
  } catch (error) {
    if (!(error instanceof VatValidationError)) throw error;
    await markUnverified(tx, orgId, row, options, today, error.message);
    throw error;
  }
  const status = verdict.valid ? "valid" : "invalid";
  const consultationNumber = verdict.consultationNumber;
  const revalidateAfter = verdict.valid ? addCalendarDays(today, interval) : null;
  const excerpt = JSON.stringify(boundAuthorityExcerpt(verdict));
  const saved = await tx.execute(sql`
    update party_tax_ids
       set status = ${status},
           checked_at = now(),
           checked_by = ${options.actorId ?? null},
           consultation_number = ${consultationNumber},
           response_excerpt = ${excerpt}::jsonb,
           revalidate_after = ${revalidateAfter}::date,
           updated_at = now(),
           updated_by = ${options.actorId ?? null}
     where org_id = ${orgId} and id = ${row.id}
     returning 1
  `);
  if (saved.rows.length !== 1) {
    throw new CrossBorderTaxError(
      "the tax ID validation could not be saved — reload the customer record before retrying",
    );
  }
  await tx.execute(sql`
    insert into audit_log(org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'party_tax_ids', ${row.id}, 'update',
      ${JSON.stringify({
        event: "tax_id_validated",
        before: { status: row.status },
        after: { status, consultationNumber },
        reason: options.reason ?? "operator validation",
      })}::jsonb, ${options.actorId ?? null})
  `);
  return { rowId: row.id, status, consultationNumber, revalidateAfter };
}

async function markUnverified(
  tx: SqlExecutor,
  orgId: string,
  row: PartyTaxIdRow,
  options: ValidateTaxIdOptions,
  today: string,
  cause: string,
): Promise<void> {
  const saved = await tx.execute(sql`
    update party_tax_ids
       set status = 'unverified',
           checked_at = now(),
           checked_by = ${options.actorId ?? null},
           revalidate_after = ${today}::date,
           updated_at = now(),
           updated_by = ${options.actorId ?? null}
     where org_id = ${orgId} and id = ${row.id}
     returning 1
  `);
  if (saved.rows.length !== 1) {
    throw new CrossBorderTaxError(
      "the tax ID validation could not be saved — reload the customer record before retrying",
    );
  }
  await tx.execute(sql`
    insert into audit_log(org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'party_tax_ids', ${row.id}, 'update',
      ${JSON.stringify({
        event: "tax_id_validation_failed",
        before: { status: row.status },
        after: { status: "unverified" },
        reason: cause.slice(0, 300),
      })}::jsonb, ${options.actorId ?? null})
  `);
}

export interface TaxIdRevalidationScanResult {
  scanned: number;
  revalidated: number;
  markedUnverified: number;
  skipped: number;
  failed: number;
  orgErrors: Array<{ orgId: string; error: string }>;
}

export interface TaxIdRevalidationScanOptions {
  transport?: typeof fetch;
  today?: string;
  revalidateAfterDays?: number;
  batchLimit?: number;
  credentialsForOrg?: (orgId: string) => Promise<TaxIdCredentials> | TaxIdCredentials;
}

/**
 * Org-wide revalidation scan (scheduler kind tax_id_revalidation): re-check
 * every due, still-valid ID in each production org with the feature on. One
 * tenant's failure is recorded by name and the scan continues; an authority
 * outage marks the row unverified for the operator instead of flipping it.
 */
export async function runTaxIdRevalidationScan(
  options: TaxIdRevalidationScanOptions = {},
): Promise<TaxIdRevalidationScanResult> {
  const result: TaxIdRevalidationScanResult = {
    scanned: 0,
    revalidated: 0,
    markedUnverified: 0,
    skipped: 0,
    failed: 0,
    orgErrors: [],
  };
  const today = options.today ?? isoDateOf(new Date());
  const limit = options.batchLimit ?? REVALIDATION_BATCH;
  // bypass: scheduler-tick — the unscoped scan discovers due rows in every
  // production organization, then works each row inside its own tenant scope.
  const due = await withBypass(() =>
    db.execute<{ orgId: string }>(sql`
      select distinct t.org_id as "orgId"
        from party_tax_ids t
        join orgs o on o.id = t.org_id
       where o.env_kind = 'production'
         and t.is_active
         and t.status = 'valid'
         and t.revalidate_after <= ${today}::date
       limit ${limit}
    `),
  );
  for (const { orgId } of due.rows) {
    try {
      const one = await runTaxIdRevalidationScanForOrg(orgId, options);
      result.scanned += one.scanned;
      result.revalidated += one.revalidated;
      result.markedUnverified += one.markedUnverified;
      result.skipped += one.skipped;
      result.failed += one.failed;
    } catch (error) {
      result.failed += 1;
      result.orgErrors.push({
        orgId,
        error: error instanceof Error ? error.message.slice(0, 300) : "unknown scan failure",
      });
    }
  }
  return result;
}

/** Revalidate every due ID for one organization inside its tenant scope. */
export async function runTaxIdRevalidationScanForOrg(
  orgId: string,
  options: TaxIdRevalidationScanOptions = {},
): Promise<TaxIdRevalidationScanResult> {
  const result: TaxIdRevalidationScanResult = {
    scanned: 0,
    revalidated: 0,
    markedUnverified: 0,
    skipped: 0,
    failed: 0,
    orgErrors: [],
  };
  if (!orgId.trim()) throw new CrossBorderTaxError("orgId is required for an org-scoped tax ID revalidation scan");
  await assertNotSandbox(orgId, "tax ID revalidation");
  if (!(await orgFeatureEnabled(orgId, "crossBorderTax"))) {
    result.skipped += 1;
    return result;
  }
  const today = options.today ?? isoDateOf(new Date());
  const limit = options.batchLimit ?? REVALIDATION_BATCH;
  // Stored authority credentials are the default: without them every HMRC
  // and ABN revalidation lands unverified with the connect-in-Tax-setup
  // remedy. An explicit override (tests, manual runs) still wins.
  const credentials = options.credentialsForOrg
    ? await options.credentialsForOrg(orgId)
    : await authorityCredentialsForOrg(db, orgId);
  await withOrgContext(orgId, async () => {
    const due = (
      await db.execute<PartyTaxIdRow>(sql`
        select id, party_id as "partyId", scheme, value, status
          from party_tax_ids
         where org_id = ${orgId}
           and is_active
           and status = 'valid'
           and revalidate_after <= ${today}::date
         order by revalidate_after
         limit ${limit}
         for update skip locked
      `)
    ).rows;
    for (const row of due) {
      result.scanned += 1;
      try {
        await validatePartyTaxId(db, orgId, row.id, {
          transport: options.transport,
          credentials,
          revalidateAfterDays: options.revalidateAfterDays,
          today,
          reason: "scheduled revalidation",
        });
        result.revalidated += 1;
      } catch (error) {
        if (error instanceof VatValidationError) result.markedUnverified += 1;
        else {
          result.failed += 1;
          result.orgErrors.push({
            orgId,
            error: error instanceof Error ? error.message.slice(0, 300) : "unknown scan failure",
          });
        }
      }
    }
  });
  return result;
}
