import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import type { PostingDeps } from "../posting.ts";

/**
 * NativeContext — everything an adapter needs to build INSERT-READY documents:
 * the org's control accounts and the source-ref → openbooks-id maps for every
 * entity family, keyed by the adapter's refKey in each row's `custom` jsonb.
 * Built by the sync engine AFTER the entity streams load, so a brand-new
 * account/party/item referenced by a new transaction always resolves.
 */

export interface NativeDocLine {
  accountId: string | null;
  itemId: string | null;
  /** Line-level subledger entity (customer/vendor/employee → parties). Source
   *  systems carry the entity on the LINE (NetSuite line "Name", QBO line
   *  Entity); AR/AP journal legs settle/age by it. Null falls back to the
   *  header party at posting time. A source line entity that is a job resolves
   *  to `projectId` instead. */
  partyId?: string | null;
  amount: string;
  taxAmount: string;
  taxOverridden: boolean;
  taxCodeId: string | null;
  departmentId: string | null;
  projectId: string | null;
  /** Resolved custom segment value ids keyed by segment definition key. */
  extraDims?: Record<string, string>;
  /** Optional legal-entity override (advanced intercompany journals). */
  subsidiaryId?: string | null;
  description: string | null;
  lineNumber: number;
}

export interface NativeDocument {
  /** Stable id in the source system (idempotency + change detection). */
  sourceRef: string;
  /** openbooks document kind (drives the posting rule). */
  kind: string;
  /** false = order/quote — document only, no GL. */
  posting: boolean;
  partyId: string | null;
  /** Source legal entity; undefined falls back to the tenant root. */
  subsidiaryId?: string | null;
  /** Transaction currency; omitted = the source base currency (home). */
  currency?: string;
  /** Transaction→base fx rate; omitted = "1". Line amounts are in `currency`. */
  fxRate?: string;
  documentDate: string; // ISO yyyy-mm-dd
  dueDate: string | null;
  memo: string | null;
  referenceNumber: string | null;
  /** Per-document AR/AP/card control override (stored in custom). */
  controlAccountId: string | null;
  /** Header defaults for registry-defined custom segments. */
  extraDims?: Record<string, string>;
  /** Non-posting docs carry their totals (posting docs derive from the entry). */
  subtotal?: string;
  total?: string;
  lines: NativeDocLine[];
}

/** Live progress emitted during a sync so the UI can show a real bar. */
export interface SyncProgress {
  phase: "starting" | "entities" | "pull" | "post" | "applications" | "verify" | "done";
  message: string;
  /** X of Y for the current phase (omit when not countable). */
  current?: number;
  total?: number;
  docsNew?: number;
  docsAmended?: number;
  docsUnchanged?: number;
  docsFailed?: number;
  /** Bounded source-ref/error samples retained while a long run continues. */
  failureSamples?: string[];
  ordersNew?: number;
}

export interface NativeContext {
  orgId: string;
  refKey: string;
  baseCurrency: string;
  control: PostingDeps["control"];
  /** Best-effort progress sink so an adapter's pull can report "X of Y". */
  onProgress?: (p: SyncProgress) => void;
  accountByRef: Map<string, { id: string; number: string | null; name: string; type: string }>;
  /** Reverse: openbooks account id → its source ref (control-account checks). */
  accountRefById: Map<string, string>;
  partyByRef: Map<string, string>;
  deptByRef: Map<string, string>;
  projectByRef: Map<string, string>;
  itemByRef: Map<string, string>;
  subsidiaryByRef: Map<string, string>;
  /** segment key → source value ref → openbooks segment value id. */
  segmentValueByRef: Map<string, Map<string, string>>;
  rootSubsidiaryId: string;
  /** Rounded-percent → tax code (rate-keyed: source systems key tax by rate). */
  taxByRate: Map<string, { id: string; rate: string }>;
  /** Source ref → tax code id (ref-keyed: sources whose taxes are entities). */
  taxCodeByRef: Map<string, string>;
  periodFor(date: string): string | undefined;
}

export async function buildNativeContext(
  orgId: string,
  refKey: string,
  baseCurrency: string,
): Promise<NativeContext> {
  const [org] = (
    (await db.execute(sql`
      select settings->'controlAccounts' as ctrl from orgs where id = ${orgId}`)) as unknown as {
      rows: { ctrl: Record<string, string> }[];
    }
  ).rows;
  const ctrl = org?.ctrl ?? {};
  const control: PostingDeps["control"] = {
    ar: ctrl.ar,
    ap: ctrl.ap,
    bank: ctrl.bank,
    taxCollected: ctrl.taxCollected,
    taxPaid: ctrl.taxPaid,
    employeePayable: ctrl.employeePayable,
  };

  const accountByRef = new Map<string, { id: string; number: string | null; name: string; type: string }>();
  const accountRefById = new Map<string, string>();
  for (const r of (
    (await db.execute(sql`
      select id, number, name, type, custom->>${refKey} as ref
        from accounts where org_id = ${orgId} and custom->>${refKey} is not null`)) as unknown as {
      rows: { id: string; number: string | null; name: string; type: string; ref: string }[];
    }
  ).rows) {
    accountByRef.set(r.ref, { id: r.id, number: r.number, name: r.name, type: r.type });
    accountRefById.set(r.id, r.ref);
  }

  const idMap = async (table: string): Promise<Map<string, string>> => {
    const rows = (await db.execute(sql`
      select id, custom->>${refKey} as ref from ${sql.raw(table)}
       where org_id = ${orgId} and custom->>${refKey} is not null`)) as unknown as {
      rows: { id: string; ref: string }[];
    };
    return new Map(rows.rows.map((r) => [r.ref, r.id]));
  };
  const [partyByRef, deptByRef, projectByRef, itemByRef, subsidiaryByRef] = await Promise.all([
    idMap("parties"),
    idMap("departments"),
    idMap("projects"),
    idMap("items"),
    idMap("subsidiaries"),
  ]);

  const segmentValueByRef = new Map<string, Map<string, string>>();
  const segmentRows = (await db.execute(sql`
    select sd.key, sv.id, sv.custom->>${refKey} as ref
      from segment_definitions sd
      join segment_values sv on sv.segment_id = sd.id and sv.org_id = sd.org_id
     where sd.org_id = ${orgId} and sd.source_kind = 'custom'
       and sv.custom->>${refKey} is not null
  `)) as unknown as { rows: { key: string; id: string; ref: string }[] };
  for (const row of segmentRows.rows) {
    const values = segmentValueByRef.get(row.key) ?? new Map<string, string>();
    values.set(row.ref, row.id);
    segmentValueByRef.set(row.key, values);
  }

  const taxByRate = new Map<string, { id: string; rate: string }>();
  const taxCodeByRef = new Map<string, string>();
  for (const r of (
    (await db.execute(sql`
      select tc.id, tr.rate_percent as rate, tc.custom->>${refKey} as ref from tax_codes tc
        left join tax_rates tr on tr.tax_code_id = tc.id
       where tc.org_id = ${orgId}
       order by (tc.custom->>${refKey} is null), tc.created_at, tc.id`)) as unknown as {
      rows: { id: string; rate: string | null; ref: string | null }[];
    }
  ).rows) {
    const rate = r.rate ?? "0";
    const key = String(Math.round(Number(rate)));
    if (!taxByRate.has(key)) taxByRate.set(key, { id: r.id, rate });
    if (r.ref) taxCodeByRef.set(r.ref, r.id);
  }

  const periods = (
    (await db.execute(sql`
      select id, starts_on, ends_on from accounting_periods
       where org_id = ${orgId} and is_adjustment = false order by starts_on`)) as unknown as {
      rows: { id: string; starts_on: string; ends_on: string }[];
    }
  ).rows;
  const periodFor = (d: string) => periods.find((p) => p.starts_on <= d && p.ends_on >= d)?.id;
  const root = (await db.execute(sql`
    select id from subsidiaries where org_id = ${orgId} and parent_id is null limit 1`)) as unknown as {
    rows: { id: string }[];
  };
  if (!root.rows[0]) throw new Error(`org ${orgId} has no root subsidiary`);

  return {
    orgId,
    refKey,
    baseCurrency,
    control,
    accountByRef,
    accountRefById,
    partyByRef,
    deptByRef,
    projectByRef,
    itemByRef,
    subsidiaryByRef,
    segmentValueByRef,
    rootSubsidiaryId: root.rows[0].id,
    taxByRate,
    taxCodeByRef,
    periodFor,
  };
}
