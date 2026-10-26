/**
 * Import billable timesheets (field tickets) exactly from a connector export.
 *
 * A field ticket is the crew's week on a job — approved, customer-signed, and in
 * many businesses the actual UNIT OF BILLING. Without them a migrated tenant can
 * neither reproduce how it bills nor produce the backup its customers expect.
 *
 * Reads two explicit tab-separated exports (no live source connection):
 *   --headers  id, TSNumber, JobID, EmpID, CustomerID, PPEBegin, PPEEnd,
 *                     Billed, FinalTimesheet, ApprovalStatus, ForemanID,
 *                     SuperintendentID, PO, Description
 *   --rows     TimesheetID, EmpID, ItemId, Shortform, then 7 days x
 *                     (Reg, Over, Double)
 *
 * Creates one `field_ticket` document plus its native `field_tickets` header.
 * It deliberately does not infer time lineage from coincident project/person/
 * date/hour values. Exact line attachment is a separate source-identity
 * reconciliation (`link-field-ticket-time-by-source.ts`).
 *
 * Usage: npx tsx scripts/validation/import-field-tickets.ts
 *   --org=<uuid> --headers=/path/headers.tsv --rows=/path/rows.tsv
 *   --source-system=<stable connector id> --actor=<target-org user UUID>
 *   [--charges=/path/billable-timesheet-charges.json]
 *   [--plan-only=true]
 *   [--out=/path/report.json] [--apply --production]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import {
  assertImportOrgId,
  importFieldTickets,
  parseBillableChargesJson,
} from "./field-ticket-import.ts";
import { parseFieldTicketSourceHeaders } from "@openbooks/engine/projects/field-ticket-source-headers";
import { resolveTargetOrg } from "./target-org.ts";
import { retry } from "./retry.ts";

const args = new Map(
  process.argv
    .slice(2)
    .filter((arg) => arg.startsWith("--"))
    .map((arg) => {
      const [key, ...value] = arg.slice(2).split("=");
      return [key!, value.length ? value.join("=") : "true"];
    }),
);
const ORG = assertImportOrgId(
  args.get("org") ??
    process.env.TARGET_ORG ??
    process.env.SANDBOX_ORG ??
    (() => {
      throw new Error("--org, TARGET_ORG, or SANDBOX_ORG is required");
    })(),
);
const APPLY = args.get("apply") === "true";
const PLAN_ONLY = args.get("plan-only") === "true";
if (PLAN_ONLY && APPLY) throw new Error("--plan-only cannot be combined with --apply");
if (args.has("identity-bindings"))
  throw new Error(
    "source identity admission is held; --identity-bindings is not supported because artifact hashes and native work facts do not certify ticket source lineage — certify through certify-field-ticket-source-identity.ts, then re-run the import",
  );
const HEADERS = args.get("headers") ?? "/tmp/ft-head.tsv";
const ROWS = args.get("rows") ?? null;
const CHARGES = args.get("charges") ?? null;
const OUT = args.get("out") ?? null;
const SOURCE_SYSTEM = args.get("source-system")?.trim();
if (!SOURCE_SYSTEM || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(SOURCE_SYSTEM)) {
  throw new Error("--source-system is required and must be a stable connector id");
}
if (!existsSync(HEADERS)) throw new Error("--headers source artifact is required");
if (ROWS && !existsSync(ROWS)) throw new Error("--rows source artifact does not exist");
if (CHARGES && !existsSync(CHARGES)) throw new Error("--charges source artifact does not exist");

interface Row {
  ticketId: string;
  empRef: string;
  itemRef: string;
  hours: { day: number; kind: string; h: number }[];
}

const headersArtifact = readFileSync(HEADERS);
const chargesArtifact = CHARGES ? readFileSync(CHARGES) : null;
const sourceProof = {
  headersSha256: createHash("sha256").update(headersArtifact).digest("hex"),
  chargesSha256:
    chargesArtifact === null ? null : createHash("sha256").update(chargesArtifact).digest("hex"),
};
const parseTickets = () => parseFieldTicketSourceHeaders(headersArtifact);
const parseCharges = () =>
  chargesArtifact === null ? [] : parseBillableChargesJson(chargesArtifact.toString("utf8"));

const parseRows = (): Row[] =>
  (ROWS ? readFileSync(ROWS, "utf8") : "")
    .split("\n")
    .map((l) => l.split("\t"))
    .filter((c) => c.length >= 25 && /^\d+$/.test(c[0]!))
    .map((c) => {
      const hours: Row["hours"] = [];
      for (let d = 0; d < 7; d++) {
        const base = 4 + d * 3;
        for (const [off, kind] of [
          [0, "Regular"],
          [1, "Over"],
          [2, "Double"],
        ] as const) {
          const h = Number(c[base + off] ?? 0);
          if (h > 0) hours.push({ day: d, kind, h });
        }
      }
      return { ticketId: c[0]!, empRef: c[1]!, itemRef: c[2]!, hours };
    });

(async () => {
  await resolveTargetOrg(ORG);

  const tickets = parseTickets();
  const rows = parseRows();
  const charges = parseCharges();
  console.log(
    `export: ${tickets.length} tickets, ${rows.length} crew rows, ${rows.reduce((t, r) => t + r.hours.length, 0)} day/type hour cells, ${charges.length} billable charges`,
  );

  // Identity, project validation, and all writes live in the import core:
  // a same-number ticket from another source refuses by name, and one
  // unmapped job refuses the whole import atomically before anything commits.
  const result = await retry(() =>
    importFieldTickets({
      orgId: ORG,
      sourceSystem: SOURCE_SYSTEM!,
      tickets,
      charges,
      sourceProof,
      apply: APPLY,
      actorId: args.get("actor"),
    }),
  );
  const { created, nativeCreated, nativeUpdated, existing } = result;
  const unresolvedTickets = result.unmapped.length;
  const unmappedRoles = result.unmapped.reduce((count, row) => count + row.missingRoles.length, 0);
  const identityCounts = result.identityPlan
    ? {
        new: result.identityPlan.filter((row) => row.action === "new").length,
        exactReplay: result.identityPlan.filter((row) => row.action === "exact_replay").length,
        admissionHeld: result.identityPlan.filter((row) => row.action === "admission_held").length,
        mismatch: result.identityPlan.filter((row) => row.action === "mismatch").length,
      }
    : null;
  const report = {
    mode: APPLY ? "apply" : "plan",
    source: {
      ticketHeaders: tickets.length,
      crewRows: rows.length,
      nonzeroHourCells: rows.reduce((total, row) => total + row.hours.length, 0),
      billableCharges: charges.length,
      artifactDigests: sourceProof,
      artifactDigestsCertifyNativeIdentity: false,
    },
    result: {
      created,
      nativeCreated,
      nativeUpdated,
      existing,
      unresolvedTickets,
      unmappedRoles,
      billableChargesCreated: result.billableChargesCreated,
      billableChargesUpdated: result.billableChargesUpdated,
      billableChargesUnchanged: result.billableChargesUnchanged,
      salesOrderLinesLinked: result.salesOrderLinesLinked,
      identityPlan: result.identityPlan ?? null,
      identityCounts,
      adoptionPerformed: false,
    },
  };
  if (identityCounts) {
    console.log(
      `identity plan: new ${identityCounts.new}, exact replay ${identityCounts.exactReplay}, admission held ${identityCounts.admissionHeld}, mismatch ${identityCounts.mismatch}; source identities adopted 0`,
    );
  }
  console.log(
    `${APPLY ? "imported" : "PLAN"}: tickets created ${created}, native headers added ${nativeCreated}, headers updated ${nativeUpdated}, already present ${existing}, unresolved tickets ${unresolvedTickets}, unmapped roles ${unmappedRoles}, billable charges created ${result.billableChargesCreated}, corrected ${result.billableChargesUpdated}, unchanged ${result.billableChargesUnchanged}, sales-order ticket links added ${result.salesOrderLinesLinked}`,
  );
  if (OUT) writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
  if (APPLY) {
    const v = await retry(() =>
      db.execute(
        sql`
      select (select count(*) from documents where org_id = ${ORG} and kind = 'field_ticket')::int tickets,
             (select count(*) from field_tickets where org_id = ${ORG})::int native_headers`,
        "objects",
      ),
    );
    console.log("verify:", JSON.stringify(v[0]));
  }
  process.exit(0);
})().catch((e) => {
  const chain: string[] = [];
  for (let c = e; c; c = c.cause)
    if (c?.message) chain.push(String(c.message).replace(/\s+/g, " ").slice(0, 200));
  console.error("FATAL:", chain.pop() ?? "unknown");
  process.exit(1);
});
