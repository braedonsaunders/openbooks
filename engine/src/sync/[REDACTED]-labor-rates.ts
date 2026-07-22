import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg, { type PoolClient } from "pg";

type Row = Record<string, unknown>;

const IMPORT_NAMESPACE = "6db78b1a-ea6c-5f09-bb8a-3724ee886c92";

export function deterministicUuid(
  resource: string,
  sourceId: string | number,
): string {
  const ns = Buffer.from(IMPORT_NAMESPACE.replaceAll("-", ""), "hex");
  const hash = createHash("sha1")
    .update(ns)
    .update(`${resource}:${sourceId}`)
    .digest()
    .subarray(0, 16);
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function yesNo(value: unknown): boolean | null {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "yes" || normalized === "true" || normalized === "1")
    return true;
  if (normalized === "no" || normalized === "false" || normalized === "0")
    return false;
  return null;
}

function present(value: unknown): boolean {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function numberOrNull(value: unknown): string | null {
  if (!present(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? String(value) : null;
}

export interface GenericAdjustment {
  code: string;
  name: string;
  category:
    "markup" | "travel" | "allowance" | "minimum" | "surcharge" | "other";
  calculation:
    "percent" | "fixed" | "per_hour" | "per_day" | "distance" | "time" | "text";
  value: string | null;
  unit: string | null;
  presentation: "included" | "separate" | "informational";
  threshold: string | null;
  thresholdUnit: string | null;
  referenceText: string | null;
}

/** Translate source-specific fields into the general labor adjustment model. */
export function translateAdjustments(rate: Row): GenericAdjustment[] {
  const out: GenericAdjustment[] = [];
  const push = (row: GenericAdjustment) => out.push(row);
  const markup = numberOrNull(rate.Markup);
  if (markup !== null)
    push({
      code: "markup",
      name: "Markup",
      category: "markup",
      calculation: "percent",
      value: markup,
      unit: null,
      presentation: "included",
      threshold: null,
      thresholdUnit: null,
      referenceText: null,
    });

  const travelType = String(rate.TravelType ?? "").trim();
  const travelValue = numberOrNull(rate.HourAmount);
  if (
    present(rate.TravelBreakout) ||
    present(rate.TravelType) ||
    travelValue !== null
  ) {
    push({
      code: "travel",
      name: "Travel",
      category: "travel",
      calculation:
        travelType.toLowerCase() === "hourly" ? "per_hour" : "per_day",
      value: travelValue,
      unit: travelType || null,
      presentation:
        yesNo(rate.TravelBreakout) === true ? "separate" : "included",
      threshold: null,
      thresholdUnit: null,
      referenceText: null,
    });
  }

  const perDiem = numberOrNull(rate.PerDiem);
  if (perDiem !== null)
    push({
      code: "per-diem",
      name: "Per diem",
      category: "allowance",
      calculation: "per_day",
      value: perDiem,
      unit: "day",
      presentation:
        yesNo(rate.PerDiemAddToRate) === true ? "included" : "separate",
      threshold: null,
      thresholdUnit: null,
      referenceText: present(rate.PerDiemAddress)
        ? String(rate.PerDiemAddress)
        : null,
    });

  const perDiemAdded = numberOrNull(rate.PerDiemAdded);
  if (perDiemAdded !== null)
    push({
      code: "per-diem-added",
      name: "Per-diem rate addition",
      category: "allowance",
      calculation: "per_hour",
      value: perDiemAdded,
      unit: "hour",
      presentation: "included",
      threshold: null,
      thresholdUnit: null,
      referenceText: null,
    });

  if (present(rate.CallInMinimum))
    push({
      code: "call-in-minimum",
      name: "Call-in minimum",
      category: "minimum",
      calculation: "text",
      value: null,
      unit: null,
      presentation: "informational",
      threshold: null,
      thresholdUnit: null,
      referenceText: String(rate.CallInMinimum),
    });

  const distance = numberOrNull(rate.KMToDestination);
  if (distance !== null)
    push({
      code: "distance-threshold",
      name: "Distance threshold",
      category: "travel",
      calculation: "distance",
      value: null,
      unit: "km",
      presentation: "informational",
      threshold: distance,
      thresholdUnit: "km",
      referenceText: present(rate.PerDiemCalculationType)
        ? String(rate.PerDiemCalculationType)
        : null,
    });

  const minutes = numberOrNull(rate.MinutesToDestination);
  if (minutes !== null)
    push({
      code: "time-threshold",
      name: "Travel-time threshold",
      category: "travel",
      calculation: "time",
      value: null,
      unit: "minute",
      presentation: "informational",
      threshold: minutes,
      thresholdUnit: "minute",
      referenceText: present(rate.PerDiemCalculationType)
        ? String(rate.PerDiemCalculationType)
        : null,
    });

  const surcharge = numberOrNull(rate.FuelSurchargePercentage);
  if (surcharge !== null)
    push({
      code: "source-surcharge",
      name: "Surcharge",
      category: "surcharge",
      calculation: "percent",
      value: surcharge,
      unit: null,
      presentation: "separate",
      threshold: null,
      thresholdUnit: null,
      referenceText: null,
    });
  return out;
}

interface SourceCustomer {
  id: number;
  NetsuiteID: number | null;
  Name: string;
  IsInactive?: boolean;
}
interface SourceJob {
  CustomerID: number | null;
  RateID: number | null;
}

/** The source table contains rows written by two historical code paths: most
 * store a customer external id, while one workflow stored the local row id.
 * Prefer the live UI's external-id interpretation, except when job/card usage
 * proves that only the local-id candidate is coherent. */
export function resolveCustomerReference(
  raw: number,
  rateId: number,
  byLocalId: Map<number, SourceCustomer>,
  byExternalId: Map<number, SourceCustomer>,
  jobRatePairs: Set<string>,
): {
  customer: SourceCustomer | null;
  mode: "external" | "local" | "unresolved";
} {
  const external = byExternalId.get(raw);
  const local = byLocalId.get(raw);
  if (external && local && external.id !== local.id) {
    const externalEvidence =
      external.NetsuiteID != null &&
      jobRatePairs.has(`${external.NetsuiteID}:${rateId}`);
    const localEvidence =
      local.NetsuiteID != null &&
      jobRatePairs.has(`${local.NetsuiteID}:${rateId}`);
    if (localEvidence && !externalEvidence)
      return { customer: local, mode: "local" };
    return { customer: external, mode: "external" };
  }
  if (external) return { customer: external, mode: "external" };
  if (local) return { customer: local, mode: "local" };
  return { customer: null, mode: "unresolved" };
}

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const at = line.indexOf("=");
    if (at < 1) continue;
    let value = line.slice(at + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1);
    out[line.slice(0, at).trim()] = value;
  }
  return out;
}

async function bulkInsert(
  client: PoolClient,
  table: string,
  columns: string[],
  rows: unknown[][],
  conflict: string,
  chunkSize = 250,
): Promise<void> {
  const q = (name: string) => `"${name.replaceAll('"', '""')}"`;
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const chunk = rows.slice(offset, offset + chunkSize);
    const values: unknown[] = [];
    const tuples = chunk.map(
      (row) =>
        `(${row
          .map((value) => {
            values.push(value);
            return `$${values.length}`;
          })
          .join(",")})`,
    );
    await client.query(
      `insert into ${q(table)} (${columns.map(q).join(",")}) values ${tuples.join(",")} ${conflict}`,
      values,
    );
  }
}

function textTerms(
  rate: Row,
): {
  code: string;
  label: string;
  content: string;
  placement: "header" | "conditions" | "footer";
}[] {
  const defs = [
    ["base-rate", "Base rate", "BaseRate", "header"],
    ["top-message", "Top message", "TopMessage", "header"],
    ["notes", "Notes", "Notes", "conditions"],
    [
      "additional-details",
      "Additional rate details",
      "AdditionalRateDetails",
      "conditions",
    ],
    [
      "applies-regular",
      "Regular-time conditions",
      "RatesApplyReg",
      "conditions",
    ],
    ["applies-overtime", "Overtime conditions", "RatesApplyOver", "conditions"],
    [
      "applies-double-time",
      "Double-time conditions",
      "RatesApplyDouble",
      "conditions",
    ],
    ["applies-shift", "Shift conditions", "RatesApplyShift", "conditions"],
    [
      "per-diem-assistant",
      "Per-diem assistant",
      "PerDiemAssistant",
      "conditions",
    ],
    [
      "per-diem-calculation",
      "Per-diem calculation",
      "PerDiemCalculationType",
      "conditions",
    ],
    [
      "per-diem-add-to-rate",
      "Per-diem added to rate",
      "PerDiemAddToRate",
      "conditions",
    ],
  ] as const;
  return defs
    .filter(([, , source]) => present(rate[source]))
    .map(([code, label, source, placement]) => ({
      code,
      label,
      content: String(rate[source]),
      placement,
    }));
}

function dateOnly(value: unknown): string | null {
  if (!value) return null;
  return new Date(String(value)).toISOString().slice(0, 10);
}

function billingMethod(
  value: unknown,
): "time_and_materials" | "fixed_price" | "cost_plus" | null {
  if (value === "_timeAndMaterials") return "time_and_materials";
  if (value === "_fixedBidInterval" || value === "_fixedBidMilestone")
    return "fixed_price";
  return null;
}

async function ensureOrg(
  client: PoolClient,
  args: { orgId?: string; createOrg?: string; currency: string },
): Promise<string> {
  if (args.orgId) {
    const found = await client.query("select id from orgs where id=$1", [
      args.orgId,
    ]);
    if (!found.rowCount)
      throw new Error(`Target organization ${args.orgId} does not exist`);
    return args.orgId;
  }
  const existing = await client.query(
    "select id from orgs order by created_at",
  );
  if (existing.rowCount === 1) return String(existing.rows[0].id);
  if (existing.rowCount && existing.rowCount > 1)
    throw new Error("Target has multiple organizations; pass --org-id");
  if (!args.createOrg)
    throw new Error("Target has no organization; pass --create-org <name>");
  const orgId = deterministicUuid("org", args.createOrg);
  const subsidiaryId = deterministicUuid("subsidiary", `${orgId}:root`);
  await client.query(
    `insert into orgs (id,name,legal_name,base_currency,country,settings) values ($1,$2,$2,$3,'CA',$4::jsonb) on conflict (id) do update set name=excluded.name,base_currency=excluded.base_currency`,
    [
      orgId,
      args.createOrg,
      args.currency,
      JSON.stringify({ defaultLocale: "en", defaultNavMode: "sidebar" }),
    ],
  );
  await client.query(
    `insert into subsidiaries (id,org_id,name,legal_name,base_currency,country) values ($1,$2,$3,$3,$4,'CA') on conflict (id) do update set name=excluded.name,base_currency=excluded.base_currency`,
    [subsidiaryId, orgId, args.createOrg, args.currency],
  );
  return orgId;
}

export interface ImportSummary {
  orgId: string;
  cards: number;
  validLines: number;
  orphanLines: number;
  customerAssignments: number;
  unresolvedCustomerAssignments: number;
  orphanCustomerRates: number;
  projectAssignments: number;
  orphanProjectRates: number;
  localCustomerReferences: number;
  externalCustomerReferences: number;
  malformedCards: number;
  verifiedCards: number;
  verifiedLines: number;
  verifiedAssignments: number;
}

export async function importAdminApp2LaborRates(options: {
  source: pg.PoolConfig;
  targetConnectionString: string;
  orgId?: string;
  createOrg?: string;
  currency: string;
}): Promise<ImportSummary> {
  const source = new pg.Pool(options.source);
  const target = new pg.Pool({
    connectionString: options.targetConnectionString,
  });
  const client = await target.connect();
  try {
    const [
      ratesRes,
      itemsRes,
      customersRes,
      jobsRes,
      departmentsRes,
      rateItemsRes,
      matrixRes,
    ] = await Promise.all([
      source.query(`select * from adminapp2.labour_rate order by id`),
      source.query(`select * from adminapp2.items order by id`),
      source.query(`select * from adminapp2.customers order by id`),
      source.query(`select * from adminapp2.jobs order by id`),
      source.query(`select * from adminapp2.departments order by id`),
      source.query(`select * from adminapp2.labour_rateitem order by id`),
      source.query(`select * from adminapp2.customers_ratematrix order by id`),
    ]);
    await client.query("begin");
    const orgId = await ensureOrg(client, {
      orgId: options.orgId,
      createOrg: options.createOrg,
      currency: options.currency,
    });
    const rootSub = await client.query(
      "select id from subsidiaries where org_id=$1 and parent_id is null limit 1",
      [orgId],
    );
    if (!rootSub.rowCount)
      throw new Error("Target organization has no root subsidiary");
    const rootSubsidiaryId = String(rootSub.rows[0].id);

    const sourceDepartments = departmentsRes.rows as Row[];
    await bulkInsert(
      client,
      "departments",
      ["id", "org_id", "code", "name", "subsidiary_id", "custom"],
      sourceDepartments.map((d) => [
        deterministicUuid("department", String(d.NetsuiteID ?? d.id)),
        orgId,
        String(d.NetsuiteID ?? d.id),
        String(d.Name ?? `Department ${d.id}`),
        rootSubsidiaryId,
        JSON.stringify({
          source: {
            system: "adminapp2",
            id: String(d.id),
            externalId: d.NetsuiteID == null ? null : String(d.NetsuiteID),
          },
        }),
      ]),
      `on conflict (id) do update set code=excluded.code,name=excluded.name,custom=excluded.custom,updated_at=now()`,
    );
    const departmentByExternal = new Map(
      sourceDepartments.map((d) => [
        Number(d.NetsuiteID),
        deterministicUuid("department", String(d.NetsuiteID ?? d.id)),
      ]),
    );

    const referencedItemIds = new Set(
      (rateItemsRes.rows as Row[]).map((r) => Number(r.NetsuiteItemID)),
    );
    const sourceItems = (itemsRes.rows as Row[]).filter((i) =>
      referencedItemIds.has(Number(i.NetsuiteID)),
    );
    await bulkInsert(
      client,
      "items",
      [
        "id",
        "org_id",
        "kind",
        "code",
        "name",
        "description",
        "category",
        "unit",
        "show_on_timesheet",
        "is_active",
        "custom",
      ],
      sourceItems.map((i) => [
        deterministicUuid("item", String(i.NetsuiteID)),
        orgId,
        "labor",
        `SRC-${i.NetsuiteID}`,
        String(i.Name ?? `Labor item ${i.NetsuiteID}`),
        i.Description ?? null,
        i.Category ?? "Labor",
        "hour",
        true,
        i.IsInactive !== true,
        JSON.stringify({
          source: {
            system: "adminapp2",
            id: String(i.id),
            externalId: String(i.NetsuiteID),
          },
        }),
      ]),
      `on conflict (id) do update set name=excluded.name,description=excluded.description,category=excluded.category,is_active=excluded.is_active,custom=excluded.custom,updated_at=now()`,
    );
    const itemByExternal = new Map(
      sourceItems.map((i) => [
        Number(i.NetsuiteID),
        deterministicUuid("item", String(i.NetsuiteID)),
      ]),
    );

    const sourceCustomers = customersRes.rows as SourceCustomer[];
    await bulkInsert(
      client,
      "parties",
      [
        "id",
        "org_id",
        "kind",
        "display_name",
        "subsidiary_id",
        "is_active",
        "custom",
      ],
      sourceCustomers.map((c) => [
        deterministicUuid("customer", c.id),
        orgId,
        "company",
        c.Name || `Customer ${c.id}`,
        rootSubsidiaryId,
        c.IsInactive !== true,
        JSON.stringify({
          source: {
            system: "adminapp2",
            id: String(c.id),
            externalId: c.NetsuiteID == null ? null : String(c.NetsuiteID),
          },
        }),
      ]),
      `on conflict (id) do update set display_name=excluded.display_name,is_active=excluded.is_active,custom=excluded.custom,updated_at=now()`,
    );
    await bulkInsert(
      client,
      "customer_roles",
      ["id", "org_id", "party_id", "currency", "is_active"],
      sourceCustomers.map((c) => [
        deterministicUuid("customer-role", c.id),
        orgId,
        deterministicUuid("customer", c.id),
        options.currency,
        c.IsInactive !== true,
      ]),
      `on conflict (id) do update set currency=excluded.currency,is_active=excluded.is_active,updated_at=now()`,
    );
    const customerByLocal = new Map(
      sourceCustomers.map((c) => [Number(c.id), c]),
    );
    const customerByExternal = new Map(
      sourceCustomers
        .filter((c) => c.NetsuiteID != null)
        .map((c) => [Number(c.NetsuiteID), c]),
    );

    const sourceJobs = jobsRes.rows as (SourceJob & Row)[];
    const jobRatePairs = new Set(
      sourceJobs
        .filter((j) => j.CustomerID != null && j.RateID != null)
        .map((j) => `${j.CustomerID}:${j.RateID}`),
    );
    await bulkInsert(
      client,
      "projects",
      [
        "id",
        "org_id",
        "code",
        "name",
        "customer_id",
        "subsidiary_id",
        "status",
        "billing_method",
        "starts_on",
        "ends_on",
        "notes",
        "is_active",
        "custom",
      ],
      sourceJobs.map((j) => {
        const customer =
          j.CustomerID == null
            ? null
            : customerByExternal.get(Number(j.CustomerID));
        return [
          deterministicUuid("project", String(j.NetsuiteID ?? j.id)),
          orgId,
          String(j.NetsuiteID ?? j.id),
          String(j.Name ?? `Project ${j.id}`),
          customer ? deterministicUuid("customer", customer.id) : null,
          rootSubsidiaryId,
          j.IsInactive === true ? "closed" : "active",
          billingMethod(j.BillingType),
          dateOnly(j.StartDate),
          dateOnly(j.ShipDate),
          j.Notes ?? null,
          j.IsInactive !== true,
          JSON.stringify({
            source: {
              system: "adminapp2",
              id: String(j.id),
              externalId: j.NetsuiteID == null ? null : String(j.NetsuiteID),
              rateId: j.RateID == null ? null : String(j.RateID),
            },
          }),
        ];
      }),
      `on conflict (id) do update set name=excluded.name,customer_id=excluded.customer_id,status=excluded.status,billing_method=excluded.billing_method,starts_on=excluded.starts_on,ends_on=excluded.ends_on,notes=excluded.notes,is_active=excluded.is_active,custom=excluded.custom,updated_at=now()`,
    );

    const timeTypes = [
      [
        deterministicUuid("time-type", `${orgId}:regular`),
        orgId,
        "Regular",
        "1",
        "1",
      ],
      [
        deterministicUuid("time-type", `${orgId}:overtime`),
        orgId,
        "Overtime",
        "1.5",
        "1.5",
      ],
      [
        deterministicUuid("time-type", `${orgId}:double-time`),
        orgId,
        "Double time",
        "2",
        "2",
      ],
    ];
    await bulkInsert(
      client,
      "time_types",
      ["id", "org_id", "name", "cost_multiplier", "bill_multiplier"],
      timeTypes,
      `on conflict (id) do update set name=excluded.name,cost_multiplier=excluded.cost_multiplier,bill_multiplier=excluded.bill_multiplier`,
    );
    const overtimeId = String(timeTypes[1]![0]);
    const doubleTimeId = String(timeTypes[2]![0]);

    const sourceRates = ratesRes.rows as Row[];
    const rateIds = new Set(sourceRates.map((r) => Number(r.id)));
    const malformedCards = sourceRates.filter((r) => {
      const start = dateOnly(r.DateStart);
      const end = dateOnly(r.DateEnd);
      return !start || !end || end < start;
    }).length;
    await bulkInsert(
      client,
      "item_rate_books",
      ["id", "org_id", "code", "name", "currency", "is_default", "is_active"],
      sourceRates.map((r) => [
        deterministicUuid("rate-book", String(r.id)),
        orgId,
        `LAB-${r.id}`,
        String(r.Name ?? `Labor rate ${r.id}`),
        options.currency,
        false,
        true,
      ]),
      `on conflict (id) do update set name=excluded.name,currency=excluded.currency,is_active=true,updated_at=now()`,
    );
    await bulkInsert(
      client,
      "item_rate_versions",
      [
        "id",
        "org_id",
        "rate_book_id",
        "effective_from",
        "effective_to",
        "status",
      ],
      sourceRates.map((r) => {
        const start = dateOnly(r.DateStart);
        const end = dateOnly(r.DateEnd);
        const valid = Boolean(start && end && end >= start);
        return [
          deterministicUuid("rate-version", String(r.id)),
          orgId,
          deterministicUuid("rate-book", String(r.id)),
          valid ? start : (start ?? dateOnly(r.created_at) ?? "1900-01-01"),
          valid ? end : null,
          "draft",
        ];
      }),
      `on conflict (id) do nothing`,
    );
    await bulkInsert(
      client,
      "labor_rate_version_policies",
      ["id", "org_id", "version_id", "derivation_policy"],
      sourceRates.map((r) => [
        deterministicUuid("rate-policy", String(r.id)),
        orgId,
        deterministicUuid("rate-version", String(r.id)),
        yesNo(r.AutoCalculate) === true ? "time_type_multipliers" : "explicit",
      ]),
      `on conflict (id) do update set derivation_policy=excluded.derivation_policy,updated_at=now()`,
    );

    const scopeRows = sourceRates
      .filter(
        (r) =>
          r.DepartmentID != null &&
          departmentByExternal.has(Number(r.DepartmentID)),
      )
      .map((r) => [
        deterministicUuid("rate-scope", `${r.id}:department`),
        orgId,
        deterministicUuid("rate-version", String(r.id)),
        "department",
        departmentByExternal.get(Number(r.DepartmentID)),
        null,
        true,
      ]);
    await bulkInsert(
      client,
      "labor_rate_version_scopes",
      [
        "id",
        "org_id",
        "version_id",
        "scope_type",
        "scope_value_id",
        "scope_value_text",
        "include_children",
      ],
      scopeRows,
      `on conflict (id) do update set scope_value_id=excluded.scope_value_id,scope_value_text=excluded.scope_value_text,include_children=excluded.include_children,updated_at=now()`,
    );

    const adjustmentRows: unknown[][] = [];
    const termRows: unknown[][] = [];
    for (const rate of sourceRates) {
      translateAdjustments(rate).forEach((a, index) =>
        adjustmentRows.push([
          deterministicUuid("rate-adjustment", `${rate.id}:${a.code}`),
          orgId,
          deterministicUuid("rate-version", String(rate.id)),
          a.code,
          a.name,
          a.category,
          a.calculation,
          a.value,
          a.unit,
          a.presentation,
          a.threshold,
          a.thresholdUnit,
          a.referenceText,
          true,
          true,
          true,
          true,
          index,
          true,
        ]),
      );
      textTerms(rate).forEach((term, index) =>
        termRows.push([
          deterministicUuid("rate-term", `${rate.id}:${term.code}`),
          orgId,
          deterministicUuid("rate-version", String(rate.id)),
          term.code,
          term.label,
          term.content,
          term.placement,
          index,
        ]),
      );
      const start = dateOnly(rate.DateStart);
      const end = dateOnly(rate.DateEnd);
      if (!start || !end || end < start)
        termRows.push([
          deterministicUuid("rate-term", `${rate.id}:source-validity`),
          orgId,
          deterministicUuid("rate-version", String(rate.id)),
          "source-validity",
          "Source validity",
          `Start: ${start ?? "not configured"}; end: ${end ?? "not configured"}`,
          "footer",
          999,
        ]);
    }
    await bulkInsert(
      client,
      "labor_rate_adjustments",
      [
        "id",
        "org_id",
        "version_id",
        "code",
        "name",
        "category",
        "calculation",
        "value",
        "unit",
        "presentation",
        "threshold",
        "threshold_unit",
        "reference_text",
        "applies_regular",
        "applies_overtime",
        "applies_double_time",
        "applies_shift",
        "sort_order",
        "is_active",
      ],
      adjustmentRows,
      `on conflict (id) do update set name=excluded.name,category=excluded.category,calculation=excluded.calculation,value=excluded.value,unit=excluded.unit,presentation=excluded.presentation,threshold=excluded.threshold,threshold_unit=excluded.threshold_unit,reference_text=excluded.reference_text,sort_order=excluded.sort_order,is_active=true,updated_at=now()`,
    );
    await bulkInsert(
      client,
      "labor_rate_terms",
      [
        "id",
        "org_id",
        "version_id",
        "code",
        "label",
        "content",
        "placement",
        "sort_order",
      ],
      termRows,
      `on conflict (id) do update set label=excluded.label,content=excluded.content,placement=excluded.placement,sort_order=excluded.sort_order,updated_at=now()`,
    );

    const validRateItems = (rateItemsRes.rows as Row[]).filter(
      (r) =>
        rateIds.has(Number(r.RateID)) &&
        itemByExternal.has(Number(r.NetsuiteItemID)),
    );
    const duplicateCounter = new Map<string, number>();
    const existingLineRows = await client.query(
      `select id from item_rate_lines where id = any($1::uuid[])`,
      [validRateItems.map((r) => deterministicUuid("rate-line", String(r.id)))],
    );
    const existingLineIds = new Set(
      existingLineRows.rows.map((r) => String(r.id)),
    );
    const lineRows = validRateItems
      .map((r) => {
        const key = `${r.RateID}:${r.NetsuiteItemID}`;
        const occurrence = (duplicateCounter.get(key) ?? 0) + 1;
        duplicateCounter.set(key, occurrence);
        const unitCode = occurrence === 1 ? "hour" : `hour-${occurrence}`;
        const typeRates: Record<string, string> = {};
        if (numberOrNull(r.OverTimeRate) != null)
          typeRates[overtimeId] = String(r.OverTimeRate);
        if (numberOrNull(r.DoubleTimeRate) != null)
          typeRates[doubleTimeId] = String(r.DoubleTimeRate);
        return [
          deterministicUuid("rate-line", String(r.id)),
          orgId,
          deterministicUuid("rate-version", String(r.RateID)),
          itemByExternal.get(Number(r.NetsuiteItemID)),
          unitCode,
          occurrence === 1 ? "Hour" : `Hour (source row ${occurrence})`,
          "1",
          null,
          numberOrNull(r.RegularTimeRate),
          JSON.stringify(typeRates),
          occurrence - 1,
        ];
      })
      .filter((row) => !existingLineIds.has(String(row[0])));
    await bulkInsert(
      client,
      "item_rate_lines",
      [
        "id",
        "org_id",
        "version_id",
        "item_id",
        "unit_code",
        "unit_name",
        "base_quantity",
        "cost_rate",
        "bill_rate",
        "time_type_bill_rates",
        "sort_order",
      ],
      lineRows,
      `on conflict (id) do nothing`,
    );
    await bulkInsert(
      client,
      "item_rate_profiles",
      [
        "id",
        "org_id",
        "item_id",
        "base_unit",
        "pricing_policy",
        "invoice_presentation",
        "is_active",
      ],
      sourceItems.map((i) => [
        deterministicUuid("rate-profile", String(i.NetsuiteID)),
        orgId,
        itemByExternal.get(Number(i.NetsuiteID)),
        "hour",
        "explicit",
        "rate_components",
        true,
      ]),
      `on conflict (org_id,item_id) do update set base_unit='hour',pricing_policy='explicit',invoice_presentation='rate_components',is_active=true,updated_at=now()`,
    );

    for (const rate of sourceRates) {
      const start = dateOnly(rate.DateStart);
      const end = dateOnly(rate.DateEnd);
      const status = start && end && end >= start ? "active" : "retired";
      await client.query(
        "update item_rate_versions set status=$1,updated_at=now() where id=$2 and status='draft'",
        [status, deterministicUuid("rate-version", String(rate.id))],
      );
    }

    let localCustomerReferences = 0;
    let externalCustomerReferences = 0;
    let unresolvedCustomerAssignments = 0;
    let orphanCustomerRates = 0;
    const customerAssignments: unknown[][] = [];
    for (const matrix of matrixRes.rows as Row[]) {
      if (!rateIds.has(Number(matrix.RateID))) {
        orphanCustomerRates++;
        continue;
      }
      const resolved = resolveCustomerReference(
        Number(matrix.CustomerID),
        Number(matrix.RateID),
        customerByLocal,
        customerByExternal,
        jobRatePairs,
      );
      if (!resolved.customer) {
        unresolvedCustomerAssignments++;
        continue;
      }
      if (resolved.mode === "local") localCustomerReferences++;
      else externalCustomerReferences++;
      customerAssignments.push([
        deterministicUuid("customer-rate-assignment", String(matrix.id)),
        orgId,
        deterministicUuid("rate-book", String(matrix.RateID)),
        deterministicUuid("rate-version", String(matrix.RateID)),
        deterministicUuid("customer", resolved.customer.id),
        null,
        dateOnly(matrix.StartDate),
        dateOnly(matrix.EndDate),
        "project_start",
        true,
      ]);
    }
    await bulkInsert(
      client,
      "item_rate_book_assignments",
      [
        "id",
        "org_id",
        "rate_book_id",
        "rate_version_id",
        "customer_id",
        "project_id",
        "effective_from",
        "effective_to",
        "date_basis",
        "is_active",
      ],
      customerAssignments,
      `on conflict (id) do update set rate_book_id=excluded.rate_book_id,rate_version_id=excluded.rate_version_id,customer_id=excluded.customer_id,project_id=null,effective_from=excluded.effective_from,effective_to=excluded.effective_to,date_basis=excluded.date_basis,is_active=true,updated_at=now()`,
    );

    let orphanProjectRates = 0;
    const projectAssignments = sourceJobs
      .filter((j) => {
        if (j.RateID == null) return false;
        if (!rateIds.has(Number(j.RateID))) {
          orphanProjectRates++;
          return false;
        }
        return true;
      })
      .map((j) => [
        deterministicUuid("project-rate-assignment", String(j.id)),
        orgId,
        deterministicUuid("rate-book", String(j.RateID)),
        deterministicUuid("rate-version", String(j.RateID)),
        null,
        deterministicUuid("project", String(j.NetsuiteID ?? j.id)),
        null,
        null,
        "usage_date",
        true,
      ]);
    await bulkInsert(
      client,
      "item_rate_book_assignments",
      [
        "id",
        "org_id",
        "rate_book_id",
        "rate_version_id",
        "customer_id",
        "project_id",
        "effective_from",
        "effective_to",
        "date_basis",
        "is_active",
      ],
      projectAssignments,
      `on conflict (id) do update set rate_book_id=excluded.rate_book_id,rate_version_id=excluded.rate_version_id,customer_id=null,project_id=excluded.project_id,effective_from=null,effective_to=null,date_basis=excluded.date_basis,is_active=true,updated_at=now()`,
    );

    const verifiedCards = await client.query(
      `select count(*)::int n from item_rate_versions where id = any($1::uuid[])`,
      [sourceRates.map((r) => deterministicUuid("rate-version", String(r.id)))],
    );
    const verifiedLines = await client.query(
      `select id,bill_rate,time_type_bill_rates from item_rate_lines where id = any($1::uuid[])`,
      [validRateItems.map((r) => deterministicUuid("rate-line", String(r.id)))],
    );
    const verifiedAssignments = await client.query(
      `select count(*)::int n from item_rate_book_assignments where id = any($1::uuid[])`,
      [
        [
          ...customerAssignments.map((row) => row[0]),
          ...projectAssignments.map((row) => row[0]),
        ],
      ],
    );
    const targetLines = new Map(
      verifiedLines.rows.map((row) => [String(row.id), row]),
    );
    const mismatch = validRateItems.find((sourceLine) => {
      const targetLine = targetLines.get(
        deterministicUuid("rate-line", String(sourceLine.id)),
      );
      if (!targetLine) return true;
      const same = (left: unknown, right: unknown) =>
        (left == null && right == null) || Number(left) === Number(right);
      const tiers = (targetLine.time_type_bill_rates ?? {}) as Record<
        string,
        string
      >;
      return (
        !same(sourceLine.RegularTimeRate, targetLine.bill_rate) ||
        !same(sourceLine.OverTimeRate, tiers[overtimeId]) ||
        !same(sourceLine.DoubleTimeRate, tiers[doubleTimeId])
      );
    });
    const verifiedCardCount = Number(verifiedCards.rows[0]?.n ?? 0);
    const verifiedAssignmentCount = Number(verifiedAssignments.rows[0]?.n ?? 0);
    if (
      verifiedCardCount !== sourceRates.length ||
      verifiedLines.rowCount !== validRateItems.length ||
      verifiedAssignmentCount !==
        customerAssignments.length + projectAssignments.length ||
      mismatch
    ) {
      throw new Error(
        `Import verification failed (cards ${verifiedCardCount}/${sourceRates.length}, lines ${verifiedLines.rowCount}/${validRateItems.length}, assignments ${verifiedAssignmentCount}/${customerAssignments.length + projectAssignments.length}${mismatch ? `, first line ${mismatch.id}` : ""})`,
      );
    }

    await client.query("commit");
    return {
      orgId,
      cards: sourceRates.length,
      validLines: validRateItems.length,
      orphanLines: rateItemsRes.rows.length - validRateItems.length,
      customerAssignments: customerAssignments.length,
      unresolvedCustomerAssignments,
      orphanCustomerRates,
      projectAssignments: projectAssignments.length,
      orphanProjectRates,
      localCustomerReferences,
      externalCustomerReferences,
      malformedCards,
      verifiedCards: verifiedCardCount,
      verifiedLines: verifiedLines.rowCount ?? 0,
      verifiedAssignments: verifiedAssignmentCount,
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await Promise.all([source.end(), target.end()]);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (name: string) => {
    const at = argv.indexOf(name);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const envPath = arg("--source-env");
  if (!envPath)
    throw new Error(
      "Usage: --source-env <path> [--org-id <uuid> | --create-org <name>] --currency <ISO>",
    );
  const env = parseEnv(await readFile(envPath, "utf8"));
  const currency = (arg("--currency") ?? "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency))
    throw new Error("--currency must be an ISO 4217 code");
  const targetConnectionString = process.env.OPENBOOKS_DB_URL;
  if (!targetConnectionString) throw new Error("OPENBOOKS_DB_URL is required");
  const summary = await importAdminApp2LaborRates({
    source: {
      host: env.PGHOST,
      port: Number(env.PGPORT || 5432),
      database: env.PGDATABASE,
      user: env.PGUSER,
      password: env.PGPASSWORD,
    },
    targetConnectionString,
    orgId: arg("--org-id"),
    createOrg: arg("--create-org"),
    currency,
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
