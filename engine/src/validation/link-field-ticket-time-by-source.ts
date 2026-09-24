/**
 * Deterministically link imported atomic time lines to Field Tickets.
 *
 * The input is connector-neutral source evidence:
 *   [{ "id": "<source time-entry id>", "ticket_number": "FT-123" }]
 *
 * `time_entries.custom.nsId` is only the default source-id field; another
 * connector may pass `--source-key=<custom JSON key>`. Every target line is
 * still one project/job and may reference at most one Field Ticket. This tool
 * never allocates a line across tickets and never changes hours or money.
 *
 * Dry-run is the default. Production writes require all of:
 *   --apply --production --reason="..." --org=<uuid> --actor=<operator user uuid>
 *
 * --actor names the operator: it must be a user of the target organization
 * and is recorded on every audit row the apply writes.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db, withOrg } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import {
  applyTimeTicketLinks,
  classifyTimeTicketLinks,
  resolveTimeTicketLinks,
  type SourceLink,
} from "./field-ticket-time-links.ts";
import { resolveTargetOrg } from "./target-org.ts";

const args = new Map(
  process.argv
    .slice(2)
    .filter((arg) => arg.startsWith("--"))
    .map((arg) => {
      const [key, ...value] = arg.slice(2).split("=");
      return [key!, value.length ? value.join("=") : "true"];
    }),
);
const orgId = args.get("org");
if (!isUuid(orgId)) {
  throw new Error("--org=<uuid> is required");
}
const inputPath = args.get("input") ?? "/tmp/ns-time-ticket.json";
const sourceKey = args.get("source-key") ?? "nsId";
const outputPath =
  args.get("out") ??
  `/tmp/openbooks-field-ticket-source-links-${orgId}-${Date.now()}.json`;
const apply = args.get("apply") === "true";
const excludeProjectConflicts =
  args.get("exclude-project-conflicts") === "true";
const actorArg = args.get("actor")?.trim() ?? "";
if (actorArg && !isUuid(actorArg)) {
  throw new Error("--actor must be a user UUID from the target organization");
}
const reason = args.get("reason")?.trim() ?? "";
if (!existsSync(inputPath)) throw new Error(`input not found: ${inputPath}`);
if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(sourceKey)) {
  throw new Error("--source-key must be a safe JSON object key");
}
if (apply && (reason.length < 10 || reason.length > 500)) {
  throw new Error("--reason must be 10-500 characters when applying");
}
const target = await resolveTargetOrg(orgId);
if (apply && target.isProduction && !process.argv.includes("--production")) {
  throw new Error("--production is required for a live tenant");
}

const raw = JSON.parse(readFileSync(inputPath, "utf8")) as Array<
  Record<string, unknown>
>;
const links: SourceLink[] = raw.map((row) => ({
  sourceRef: String(row.id ?? row.source_ref ?? row.sourceRef ?? "").trim(),
  ticketNumber: String(
    row.ticket_number ?? row.ticketNumber ?? "",
  ).trim(),
}));
const uniqueLinks = new Map<string, SourceLink>();
for (const link of links) {
  if (!link.sourceRef || !link.ticketNumber) {
    throw new Error("every input row requires a source id and ticket number");
  }
  const prior = uniqueLinks.get(link.sourceRef);
  if (prior && prior.ticketNumber !== link.ticketNumber) {
    throw new Error(
      `source time entry ${link.sourceRef} maps to both ${prior.ticketNumber} and ${link.ticketNumber}`,
    );
  }
  uniqueLinks.set(link.sourceRef, link);
}

const BATCH = 1_000;
const resolved = await resolveTimeTicketLinks(
  orgId,
  sourceKey,
  [...uniqueLinks.values()],
);

if (resolved.length !== uniqueLinks.size) {
  throw new Error(
    `source-link cardinality changed: ${uniqueLinks.size} inputs produced ${resolved.length} rows; duplicate source IDs or ticket numbers exist in the target`,
  );
}
const {
  missingTimeEntries,
  missingTickets,
  projectConflicts,
  changes,
  applicableChanges,
  protectedChanges,
  summary,
} = classifyTimeTicketLinks(resolved, links.length, uniqueLinks.size);

if (apply) {
  // Operator identity first: production lineage changes are audited, and an
  // audit row without an actor names no one. Follows the operator-CLI
  // convention (--actor UUID, e.g. scripts/payroll-reconcile-*.ts), verified
  // against the target organization here.
  if (!actorArg) {
    throw new Error(
      "refusing apply: --actor <user UUID> is required so every audit row carries its operator; pass the operator's user id from the target organization",
    );
  }
  const actor = (
    await db.execute(
      sql`select id from users where org_id = ${orgId} and id = ${actorArg}`,
    )
  ).rows[0];
  if (!actor) {
    throw new Error(
      `refusing apply: --actor ${actorArg} is not a user of this organization; pass the operator's user id from the target organization`,
    );
  }
  const actorId = String(actor.id);
  if (
    missingTimeEntries.length ||
    missingTickets.length ||
    (projectConflicts.length && !excludeProjectConflicts) ||
    protectedChanges.length
  ) {
    throw new Error(
      "refusing apply: every source line and Field Ticket must resolve; project conflicts require explicit --exclude-project-conflicts; changed lines must have no invoice/GL provenance",
    );
  }
  const runId = randomUUID();
  const inputSha256 = createHash("sha256")
    .update(readFileSync(inputPath))
    .digest("hex");
  for (let offset = 0; offset < applicableChanges.length; offset += BATCH) {
    const batch = applicableChanges.slice(offset, offset + BATCH).map((row) => ({
      timeEntryId: row.timeEntryId!,
      sourceRef: row.sourceRef,
      ticketNumber: row.ticketNumber,
      fromTicketId: row.currentTicketId,
      fromTicketNumber: row.currentTicketNumber,
      toTicketId: row.targetTicketId!,
      entryProjectId: row.entryProjectId,
      ticketProjectId: row.ticketProjectId,
    }));
    // One tenant transaction per batch: entries are re-read FOR UPDATE and
    // verified against this plan inside it, so a concurrent bill, post, or
    // ticket edit between planning and applying refuses instead of writing.
    await withOrg(orgId, () =>
      applyTimeTicketLinks(orgId, batch, {
        reason,
        inputSha256,
        runId,
        actorId,
      }),
    );
  }
  summary.applied = true;
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  orgId,
  sourceKey,
  sourceArtifact: {
    path: inputPath,
    sha256: createHash("sha256").update(readFileSync(inputPath)).digest("hex"),
  },
  reason: apply ? reason : null,
  summary,
  unresolved: {
    missingTimeEntries,
    missingTickets,
    projectConflicts,
    protectedChanges,
  },
  changes,
};
writeFileSync(outputPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log(`report: ${outputPath}`);
