/**
 * Connector-neutral field-ticket import core.
 *
 * A ticket number alone never identifies a source ticket: two connectors can
 * export different tickets under the same number. A replay requires an exact
 * source-system + externalId match against the stored source marker; a
 * same-number record from another source (or with no marker at all) refuses
 * by name instead of attaching the new source's header to the old document
 * or silently no-op-ing the new ticket away.
 *
 * Apply is atomic, not resumable: every ticket's project resolves before
 * the first write, and all writes commit in one tenant transaction, so one
 * unmapped job leaves zero writes behind — never a partial import reported
 * as success. Within the transaction each ticket still serializes on its
 * number and re-checks identity under lock.
 */
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db, withOrgTransaction } from "@openbooks/engine/platform/db";
import { isUuid } from "@openbooks/engine/platform/identifiers";
import { normalizeDecimal, toUnits } from "@openbooks/engine/money/money";
import { isIsoCalendarDate } from "@openbooks/engine/platform/civil-date";
import { lockActorCommandAuthority } from "@openbooks/engine/organization/actor-command-authority";
import {
  acquireOrgFeatureGateLock,
  lockAndCheckOrgFeature,
} from "@openbooks/engine/organization/org-feature-lock";
import { lockScopeRows, subsidiaryScopeAllows } from "@openbooks/engine/organization/scope";
import {
  fieldTicketSourceHeaderRowSha256,
  type FieldTicketSourceHeaderRow,
} from "@openbooks/engine/projects/field-ticket-source-headers";

/** A source billable-timesheet fact carried by its native field ticket. */
export interface ImportBillableCharge {
  sourceId: string;
  ticketRef: string;
  jobRef: string;
  itemRef: string;
  sourceDocumentRef: string | null;
  amount: string;
  quantity: string;
  unitPrice: string;
  occurredOn: string;
}

export interface SourceChargeLine {
  id: string;
  sourceDocumentRef: string;
  itemRef: string;
  amount: string;
  quantity: string;
  occurredOn: string;
  fieldTicketId: string | null;
}

export interface ChargeLineLink {
  sourceTransactionId: string;
  nativeLineId: string;
  ticketRef: string;
  ticketDocumentId: string;
  previousTicketDocumentId: string | null;
}

function chargeSignature(
  row: Pick<
    ImportBillableCharge,
    "sourceDocumentRef" | "itemRef" | "amount" | "quantity" | "occurredOn"
  >,
): string {
  return [
    row.sourceDocumentRef,
    row.itemRef,
    normalizeDecimal(row.amount, 4),
    normalizeDecimal(row.quantity, 8),
    row.occurredOn,
  ].join("\u0000");
}

/**
 * Link source billable transactions to their exact existing sales-order
 * lines. A composite match may contain duplicate lines only when every
 * source row has the same ticket identity and source/native multiplicities
 * match; ambiguous or incomplete lineage refuses closed.
 */
export function matchBillableChargeLines(
  charges: readonly ImportBillableCharge[],
  nativeLines: readonly SourceChargeLine[],
  ticketDocumentBySourceRef: ReadonlyMap<string, string>,
): ChargeLineLink[] {
  const sourceGroups = new Map<string, ImportBillableCharge[]>();
  for (const charge of charges) {
    if (!charge.sourceDocumentRef) continue;
    const key = chargeSignature(charge);
    sourceGroups.set(key, [...(sourceGroups.get(key) ?? []), charge]);
  }
  const nativeGroups = new Map<string, SourceChargeLine[]>();
  for (const line of nativeLines) {
    const key = chargeSignature({
      sourceDocumentRef: line.sourceDocumentRef,
      itemRef: line.itemRef,
      amount: line.amount,
      quantity: line.quantity,
      occurredOn: line.occurredOn,
    });
    nativeGroups.set(key, [...(nativeGroups.get(key) ?? []), line]);
  }

  const links: ChargeLineLink[] = [];
  for (const [key, sourceRows] of sourceGroups) {
    sourceRows.sort((a, b) => a.sourceId.localeCompare(b.sourceId));
    const nativeRows = [...(nativeGroups.get(key) ?? [])].sort((a, b) => a.id.localeCompare(b.id));
    if (nativeRows.length !== sourceRows.length) {
      throw new Error(
        `refusing billable-timesheet import: source/native sales-order line counts differ for document ${sourceRows[0]!.sourceDocumentRef} ` +
          `(source ${sourceRows.length}, native ${nativeRows.length})`,
      );
    }
    const ticketRefs = [...new Set(sourceRows.map((row) => row.ticketRef))];
    if (ticketRefs.length !== 1) {
      throw new Error(
        `refusing billable-timesheet import: source document ${sourceRows[0]!.sourceDocumentRef} has identical charge lines assigned to multiple tickets; reconcile the source line identity`,
      );
    }
    const ticketRef = ticketRefs[0]!;
    const ticketDocumentId = ticketDocumentBySourceRef.get(ticketRef);
    if (!ticketDocumentId) {
      throw new Error(
        `refusing billable-timesheet import: source ticket ${ticketRef} has no imported native field ticket`,
      );
    }
    for (let index = 0; index < sourceRows.length; index++) {
      const charge = sourceRows[index]!;
      const line = nativeRows[index]!;
      if (line.fieldTicketId && line.fieldTicketId !== ticketDocumentId) {
        throw new Error(
          `refusing billable-timesheet import: native sales-order line ${line.id} is already linked to a different field ticket`,
        );
      }
      links.push({
        sourceTransactionId: charge.sourceId,
        nativeLineId: line.id,
        ticketRef,
        ticketDocumentId,
        previousTicketDocumentId: line.fieldTicketId,
      });
    }
  }
  return links;
}

/** Parse the explicit JSON payload used by the governed source re-import. */
export function parseBillableChargesJson(text: string): ImportBillableCharge[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new Error("billable-timesheet source file is not valid JSON", { cause });
  }
  if (!Array.isArray(value)) {
    throw new Error("billable-timesheet source file must contain a JSON array");
  }
  const seen = new Set<string>();
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`billable-timesheet row ${index + 1} must be an object`);
    }
    const row = raw as Record<string, unknown>;
    const sourceId = typeof row.sourceId === "string" ? row.sourceId.trim() : "";
    const ticketRef = typeof row.ticketRef === "string" ? row.ticketRef.trim() : "";
    const jobRef = typeof row.jobRef === "string" ? row.jobRef.trim() : "";
    const itemRef = typeof row.itemRef === "string" ? row.itemRef.trim() : "";
    const sourceDocumentRef =
      row.sourceDocumentRef === null
        ? null
        : typeof row.sourceDocumentRef === "string"
          ? row.sourceDocumentRef.trim() || null
          : undefined;
    if (
      !/^\d+$/.test(sourceId) ||
      !/^\d+$/.test(ticketRef) ||
      !/^\d+$/.test(jobRef) ||
      !/^\d+$/.test(itemRef) ||
      sourceDocumentRef === undefined ||
      (sourceDocumentRef !== null && !/^\d+$/.test(sourceDocumentRef))
    ) {
      throw new Error(`billable-timesheet row ${index + 1} has an invalid source identity`);
    }
    if (seen.has(sourceId)) {
      throw new Error(`billable-timesheet source transaction ${sourceId} appears more than once`);
    }
    seen.add(sourceId);
    const decimal = (key: "amount" | "quantity" | "unitPrice", scale: number): string => {
      if (typeof row[key] !== "string")
        throw new Error(`billable-timesheet ${sourceId} has no exact ${key}`);
      return normalizeDecimal(row[key] as string, scale);
    };
    const amount = decimal("amount", 4);
    const quantity = decimal("quantity", 8);
    const unitPrice = decimal("unitPrice", 8);
    if (
      toUnits(amount) < 0n ||
      quantity === "0.00000000" ||
      quantity.startsWith("-") ||
      unitPrice.startsWith("-")
    ) {
      throw new Error(
        `billable-timesheet ${sourceId} has a negative amount or non-positive quantity`,
      );
    }
    const occurredOn = typeof row.occurredOn === "string" ? row.occurredOn.trim() : "";
    if (!isIsoCalendarDate(occurredOn)) {
      throw new Error(`billable-timesheet ${sourceId} has an invalid work date`);
    }
    return {
      sourceId,
      ticketRef,
      jobRef,
      itemRef,
      sourceDocumentRef,
      amount,
      quantity,
      unitPrice,
      occurredOn,
    };
  });
}

export interface ExistingTicket {
  id: string;
  sourceSystem: string | null;
  sourceExternalId: string | null;
  sourceJobRef?: string | null;
  hasSourceMetadata?: boolean;
  projectId?: string | null;
  subsidiaryId?: string | null;
}

/** Artifact digests record provenance; they do not certify native identity. */
export interface SourceArtifactProof {
  headersSha256: string;
  chargesSha256: string | null;
}

export interface TicketIdentityPlan {
  sourceTicketId: string;
  documentNumber: string;
  action: "new" | "exact_replay" | "admission_held" | "mismatch";
  adoptionPerformed: false;
  nativeDocumentId: string | null;
  sourceRowSha256: string;
  reasons: string[];
}

/** Only a persisted exact source marker establishes a replay. Native work
 * facts and artifact hashes cannot substitute for ticket source lineage. */
export function classifyTicketIdentity(input: {
  ticket: FieldTicketSourceHeaderRow;
  sourceSystem: string;
  existing: ExistingTicket | undefined;
  sourceIdentityConflict?: boolean;
  unresolvedReferences?: boolean;
  expectedProjectId?: string;
  expectedSubsidiaryId?: string | null;
}): TicketIdentityPlan {
  const { ticket, existing } = input;
  const row = (
    action: TicketIdentityPlan["action"],
    reasons: string[] = [],
  ): TicketIdentityPlan => ({
    sourceTicketId: ticket.sourceId,
    documentNumber: ticket.number,
    action,
    adoptionPerformed: false,
    nativeDocumentId: existing?.id ?? null,
    sourceRowSha256: fieldTicketSourceHeaderRowSha256(ticket),
    reasons,
  });
  if (input.sourceIdentityConflict)
    return row("mismatch", ["source_identity_has_different_or_ambiguous_native_number"]);
  if (input.unresolvedReferences) return row("admission_held", ["source_references_unresolved"]);
  if (
    existing &&
    input.expectedProjectId &&
    (existing.projectId !== input.expectedProjectId ||
      existing.subsidiaryId !== input.expectedSubsidiaryId)
  ) {
    return row("mismatch", ["native_project_or_legal_entity_mismatch"]);
  }
  if (!existing) return row("new");
  if (existing.sourceSystem === input.sourceSystem && existing.sourceExternalId === ticket.sourceId)
    return row("exact_replay");
  if (
    existing.hasSourceMetadata ||
    existing.sourceSystem !== null ||
    existing.sourceExternalId !== null
  ) {
    return row("mismatch", ["source_identity_conflict_or_incomplete_metadata"]);
  }
  return row("admission_held", [
    "native_ticket_source_lineage_missing",
    "governed_native_identity_certification_required",
  ]);
}

export interface UnmappedTicket {
  sourceId: string;
  number: string;
  jobRef: string;
  missingRoles: { role: "foreman" | "superintendent"; sourceRef: string }[];
  missingCustomerRef: string | null;
}

export interface FieldTicketImportResult {
  created: number;
  nativeCreated: number;
  nativeUpdated: number;
  existing: number;
  billableChargesCreated: number;
  billableChargesUpdated: number;
  billableChargesUnchanged: number;
  salesOrderLinesLinked: number;
  unmapped: UnmappedTicket[];
  /** Present only in read-only plans; applying still rechecks identity under locks. */
  identityPlan?: TicketIdentityPlan[];
}

/**
 * Decide whether an incoming ticket creates a document or replays one. An
 * exact source-system + externalId match is the only replay; anything else
 * sharing the number refuses by name with both identities.
 */
export function resolveTicketIdentity(
  ticket: FieldTicketSourceHeaderRow,
  existing: ExistingTicket | undefined,
  sourceSystem: string,
): "create" | "replay" {
  if (!existing) return "create";
  if (existing.sourceSystem === sourceSystem && existing.sourceExternalId === ticket.sourceId) {
    return "replay";
  }
  throw new Error(
    `refusing import: field ticket number ${ticket.number} already exists ` +
      `from a different source (system ${existing.sourceSystem ?? "unknown"}, ` +
      `external id ${existing.sourceExternalId ?? "unknown"}); source ` +
      `${sourceSystem} ticket ${ticket.sourceId} is not represented — ` +
      `reconcile the number collision before importing`,
  );
}

/**
 * Refuse a non-UUID import target before any database work. The import CLI
 * takes --org/TARGET_ORG/SANDBOX_ORG from the operator's shell, and an
 * unvalidated value reaches SQL — so a quote in the value must die here with
 * its remedy, never in a query.
 */
export function assertImportOrgId(orgId: string): string {
  if (!isUuid(orgId)) {
    throw new Error(
      `--org must be a UUID (received ${JSON.stringify(orgId)}); ` +
        "pass --org=<uuid>, TARGET_ORG, or SANDBOX_ORG from the target organization",
    );
  }
  return orgId;
}

export async function sourceIdMap(
  table: "projects" | "parties" | "items",
  orgId: string,
): Promise<Map<string, string>> {
  // Only the closed table-name union is an SQL identifier. Tenant identity
  // remains a bound value; duplicate external identities refuse closed.
  const rows = await db.execute(
    sql`
      select custom->>'nsId' k, id from ${sql.raw(`"${table}"`)}
       where org_id = ${orgId} and custom->>'nsId' is not null order by id for share
    `,
    "objects",
  );
  const mapped = new Map<string, string>();
  for (const row of rows) {
    const ref = String(row.k);
    if (mapped.has(ref))
      throw new Error(
        `refusing import: ${table} source reference ${ref} maps to multiple native records`,
      );
    mapped.set(ref, String(row.id));
  }
  return mapped;
}

export async function importFieldTickets(input: {
  orgId: string;
  sourceSystem: string;
  tickets: readonly FieldTicketSourceHeaderRow[];
  /** Imported as source facts on the matching native field-ticket documents. */
  charges?: readonly ImportBillableCharge[];
  /** File provenance only; never used to authorize adoption of native records. */
  sourceProof?: SourceArtifactProof;
  apply: boolean;
  actorId?: string;
}): Promise<FieldTicketImportResult> {
  // The target reaches SQL in every query below: refuse a non-UUID before any
  // database work with a named refusal, never a driver syntax error.
  assertImportOrgId(input.orgId);
  if ("identityBindings" in input) {
    throw new Error(
      "refusing import: source identity admission is held; native ticket source lineage is missing — certify it through the governed field-ticket source-identity certification command, then re-run the import; identity-binding manifests are not supported",
    );
  }
  if (
    input.sourceProof &&
    (!/^[a-f0-9]{64}$/.test(input.sourceProof.headersSha256) ||
      (input.sourceProof.chargesSha256 !== null &&
        !/^[a-f0-9]{64}$/.test(input.sourceProof.chargesSha256)))
  ) {
    throw new Error(
      "refusing import: source artifact digests must be SHA-256; artifact provenance does not certify native ticket identity",
    );
  }
  const { orgId, sourceSystem } = input;
  if (typeof sourceSystem !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(sourceSystem))
    throw new Error("refusing import: sourceSystem must be a stable connector id");
  const tickets = [...input.tickets].sort((a, b) => a.number.localeCompare(b.number));
  const seenTickets = new Set<string>(),
    seenNumbers = new Set<string>();
  for (const ticket of tickets) {
    if (
      typeof ticket.sourceId !== "string" ||
      !ticket.sourceId.trim() ||
      ticket.sourceId.trim() !== ticket.sourceId ||
      typeof ticket.number !== "string" ||
      !ticket.number.trim() ||
      seenTickets.has(ticket.sourceId) ||
      seenNumbers.has(ticket.number)
    ) {
      throw new Error(
        "refusing import: source ticket identities and numbers must be nonempty and appear once",
      );
    }
    seenTickets.add(ticket.sourceId);
    seenNumbers.add(ticket.number);
    if (
      !isIsoCalendarDate(ticket.begin) ||
      !isIsoCalendarDate(ticket.end) ||
      ticket.end < ticket.begin
    ) {
      throw new Error(
        `refusing import: source ticket ${ticket.sourceId} has an invalid work period`,
      );
    }
  }
  if (!isUuid(input.actorId))
    throw new Error(
      "refusing import: --actor must identify an authorized user of the target organization",
    );
  const actor = input.actorId;
  return withOrgTransaction(orgId, async () => {
    const allowed = await lockActorCommandAuthority(
      db,
      orgId,
      actor,
      null,
      input.apply ? "time.manage" : "time.read",
    );
    if (input.apply) await acquireOrgFeatureGateLock(db, orgId);
    if (!(await lockAndCheckOrgFeature(db, orgId, "fieldTickets"))) {
      throw new Error(
        "refusing import: enable Projects and Field Tickets in Company Settings → Features before importing",
      );
    }
    const charges = (input.charges ?? []).map((charge) => ({
      ...charge,
      amount: normalizeDecimal(charge.amount, 4),
      quantity: normalizeDecimal(charge.quantity, 8),
      unitPrice: normalizeDecimal(charge.unitPrice, 8),
    }));
    const projects = await sourceIdMap("projects", orgId);
    const parties = await sourceIdMap("parties", orgId);
    const customers = new Set(
      (
        await db.execute<{ party_id: string }>(
          sql`
      select party_id::text from customer_roles where org_id = ${orgId} order by party_id for share
    `,
          "objects",
        )
      ).map((row) => row.party_id),
    );
    const items = charges.length ? await sourceIdMap("items", orgId) : new Map<string, string>();
    const seenChargeIds = new Set<string>();
    for (const charge of charges) {
      if (
        !/^\d+$/.test(charge.sourceId) ||
        !/^\d+$/.test(charge.ticketRef) ||
        !/^\d+$/.test(charge.jobRef) ||
        !/^\d+$/.test(charge.itemRef)
      ) {
        throw new Error(
          "refusing import: billable-timesheet source, ticket, and item identities must be numeric source references",
        );
      }
      if (seenChargeIds.has(charge.sourceId)) {
        throw new Error(
          `refusing import: billable-timesheet source transaction ${charge.sourceId} appears more than once`,
        );
      }
      seenChargeIds.add(charge.sourceId);
      normalizeDecimal(charge.amount, 4);
      normalizeDecimal(charge.quantity, 8);
      normalizeDecimal(charge.unitPrice, 8);
      if (
        toUnits(charge.amount) < 0n ||
        charge.quantity === "0.00000000" ||
        charge.quantity.startsWith("-") ||
        charge.unitPrice.startsWith("-")
      ) {
        throw new Error(
          `refusing import: billable-timesheet ${charge.sourceId} has a negative charge or non-positive quantity`,
        );
      }
      if (!isIsoCalendarDate(charge.occurredOn)) {
        throw new Error(
          `refusing import: billable-timesheet ${charge.sourceId} has an invalid work date`,
        );
      }
      if (charge.sourceDocumentRef !== null && !/^\d+$/.test(charge.sourceDocumentRef)) {
        throw new Error(
          `refusing import: billable-timesheet ${charge.sourceId} has an invalid sales-order source reference`,
        );
      }
      if (!items.has(charge.itemRef)) {
        throw new Error(
          `refusing import: billable-timesheet ${charge.sourceId} item ${charge.itemRef} is not mapped to a native item`,
        );
      }
    }
    const org = (
      await db.execute(sql`select base_currency from orgs where id = ${orgId}`, "objects")
    )[0] as { base_currency?: string } | undefined;
    const baseCurrency = org?.base_currency?.trim();
    if (!baseCurrency) throw new Error("target organization has no base currency");

    const existingTickets = new Map<string, ExistingTicket>(
      (
        await db.execute<{
          n: string;
          id: string;
          source_system: string | null;
          source_external_id: string | null;
          source_job_ref: string | null;
          has_source_metadata: boolean;
          project_id: string | null;
          subsidiary_id: string | null;
        }>(
          sql`
          select document_number n, id, project_id::text, subsidiary_id::text,
                 custom ? 'source' as has_source_metadata,
                 custom->'source'->>'system' as source_system,
                 custom->'source'->>'externalId' as source_external_id,
                 custom->'source'->>'jobRef' as source_job_ref
            from documents where org_id = ${orgId} and kind = 'field_ticket'`,
          "objects",
        )
      ).map((row): [string, ExistingTicket] => [
        String(row.n),
        {
          id: String(row.id),
          sourceSystem: row.source_system ? String(row.source_system) : null,
          sourceExternalId: row.source_external_id ? String(row.source_external_id) : null,
          sourceJobRef: row.source_job_ref ? String(row.source_job_ref) : null,
          hasSourceMetadata: row.has_source_metadata,
          projectId: row.project_id,
          subsidiaryId: row.subsidiary_id,
        },
      ]),
    );

    const ticketRefs = new Set([
      ...tickets.map((ticket) => ticket.sourceId),
      ...[...existingTickets.values()]
        .filter((ticket) => ticket.sourceSystem === sourceSystem && ticket.sourceExternalId)
        .map((ticket) => ticket.sourceExternalId!),
    ]);
    for (const charge of charges) {
      if (!ticketRefs.has(charge.ticketRef)) {
        throw new Error(
          `refusing import: billable-timesheet ${charge.sourceId} references source ticket ${charge.ticketRef}, which is not present in this import or native tenant`,
        );
      }
    }

    // Every ticket's project resolves before the first write: one unmapped
    // job refuses the whole import with its source refs, before anything
    // commits. This pre-check names every offender at once; the single
    // transaction below is what guarantees zero writes even for failures the
    // pre-check cannot foresee.
    const unmapped: UnmappedTicket[] = tickets.flatMap((ticket) => {
      const missingRoles = (
        [
          ["foreman", ticket.foremanRef],
          ...(ticket.superintendentRef !== undefined
            ? [["superintendent", ticket.superintendentRef] as const]
            : []),
        ] as const
      ).flatMap(([role, sourceRef]) =>
        sourceRef && !parties.has(sourceRef) ? [{ role, sourceRef }] : [],
      );
      const missingCustomerRef =
        ticket.customerRef &&
        (!parties.has(ticket.customerRef) || !customers.has(parties.get(ticket.customerRef)!))
          ? ticket.customerRef
          : null;
      return !projects.get(ticket.jobRef) || missingRoles.length > 0 || missingCustomerRef !== null
        ? [
            {
              sourceId: ticket.sourceId,
              number: ticket.number,
              jobRef: ticket.jobRef,
              missingRoles,
              missingCustomerRef,
            },
          ]
        : [];
    });
    if (!input.apply) {
      const projectScope = await lockScopeRows(
        db,
        orgId,
        [
          ...new Set(
            tickets.flatMap((ticket) =>
              projects.has(ticket.jobRef) ? [projects.get(ticket.jobRef)!] : [],
            ),
          ),
        ].map((id) => ({ kind: "project" as const, id })),
        allowed,
        "share",
      );
      const subsidiaryByProject = new Map(projectScope.map((row) => [row.id, row.subsidiaryId]));
      const candidateIds = tickets.flatMap((ticket) => {
        const existing = existingTickets.get(ticket.number);
        return existing ? [existing.id] : [];
      });
      await lockScopeRows(
        db,
        orgId,
        candidateIds.map((id) => ({ kind: "document" as const, id })),
        allowed,
        "share",
      );
      // Re-read identity and legal-entity facts under their authorization locks.
      const lockedCandidates = candidateIds.length
        ? await db.execute<{
            id: string;
            document_number: string;
            project_id: string | null;
            subsidiary_id: string | null;
            source_system: string | null;
            source_external_id: string | null;
            has_source_metadata: boolean;
          }>(
            sql`
        select id::text, document_number, project_id::text, subsidiary_id::text,
               custom->'source'->>'system' source_system, custom->'source'->>'externalId' source_external_id,
               custom ? 'source' has_source_metadata
          from documents where org_id = ${orgId} and kind = 'field_ticket'
           and id = any(${sql.param(candidateIds)}::uuid[])
      `,
            "objects",
          )
        : [];
      const lockedByNumber = new Map(
        lockedCandidates.map((row) => [
          row.document_number,
          {
            id: row.id,
            sourceSystem: row.source_system,
            sourceExternalId: row.source_external_id,
            hasSourceMetadata: row.has_source_metadata,
            projectId: row.project_id,
            subsidiaryId: row.subsidiary_id,
          },
        ]),
      );
      for (const [number, locked] of lockedByNumber) existingTickets.set(number, locked);
      const nativeNumbersBySourceId = new Map<string, string[]>();
      for (const [number, existing] of existingTickets) {
        if (existing.sourceSystem !== sourceSystem || existing.sourceExternalId === null) continue;
        const numbers = nativeNumbersBySourceId.get(existing.sourceExternalId) ?? [];
        numbers.push(number);
        nativeNumbersBySourceId.set(existing.sourceExternalId, numbers);
      }
      const unresolvedIds = new Set(unmapped.map((row) => row.sourceId));
      const identityPlan = tickets.map((ticket) => {
        const identityNumbers = nativeNumbersBySourceId.get(ticket.sourceId) ?? [];
        const projectId = projects.get(ticket.jobRef);
        return classifyTicketIdentity({
          ticket,
          sourceSystem,
          existing: lockedByNumber.get(ticket.number),
          sourceIdentityConflict:
            identityNumbers.length > 1 ||
            identityNumbers.some((number) => number !== ticket.number),
          unresolvedReferences:
            unresolvedIds.has(ticket.sourceId) || !projectId || !subsidiaryByProject.get(projectId),
          expectedProjectId: projectId,
          expectedSubsidiaryId: projectId ? subsidiaryByProject.get(projectId) : undefined,
        });
      });
      return {
        created: 0,
        nativeCreated: 0,
        nativeUpdated: 0,
        existing: 0,
        billableChargesCreated: 0,
        billableChargesUpdated: 0,
        billableChargesUnchanged: 0,
        salesOrderLinesLinked: 0,
        unmapped,
        identityPlan,
      };
    }
    if (unmapped.length > 0) {
      const refs = unmapped
        .map((row) => {
          const missingRoles = row.missingRoles
            .map(({ role, sourceRef }) => `${role} ${sourceRef}`)
            .join(", ");
          return `source ticket ${row.sourceId} (number ${row.number}, job ${row.jobRef}${missingRoles ? `, unmapped ${missingRoles}` : ""}${row.missingCustomerRef ? `, unmapped customer ${row.missingCustomerRef}` : ""})`;
        })
        .join("; ");
      throw new Error(
        `refusing import: ${unmapped.length} ticket(s) have unresolved project or role references: ${refs}; ` +
          "map every source reference before importing — no ticket was written",
      );
    }

    // One tenant transaction for the whole import: any refusal rolls every
    // ticket back, so automation never reads a partial import as success.
    let created = 0;
    let nativeCreated = 0;
    let nativeUpdated = 0;
    let existing = 0;
    let billableChargesCreated = 0;
    let billableChargesUpdated = 0;
    let billableChargesUnchanged = 0;
    let salesOrderLinesLinked = 0;
    const requestId = randomUUID();
    const createdTicketStatus = new Map<string, string>();
    // The same connector identity serializes header and charges-only imports.
    // This also prevents one source ticket from being created under two numbers.
    for (const sourceId of [...new Set(charges.map((charge) => charge.sourceId))].sort())
      await db.execute(sql`
      select pg_advisory_xact_lock(hashtextextended(${`field-ticket-charge:${orgId}:${sourceSystem}:${sourceId}`}, 0))
    `);
    const sourceLocks = [
      ...new Set([
        ...tickets.map((ticket) => ticket.sourceId),
        ...charges.map((charge) => charge.ticketRef),
      ]),
    ].sort();
    for (const ref of sourceLocks)
      await db.execute(sql`
      select pg_advisory_xact_lock(hashtextextended(${`field-ticket-source:${orgId}:${sourceSystem}:${ref}`}, 0))
    `);
    const projectScope = await lockScopeRows(
      db,
      orgId,
      [...new Set(tickets.map((ticket) => projects.get(ticket.jobRef)!))].map((id) => ({
        kind: "project" as const,
        id,
      })),
      allowed,
      "share",
    );
    const projectEntities = new Map(projectScope.map((row) => [row.id, row.subsidiaryId]));
    if (projectScope.some((row) => row.subsidiaryId === null))
      throw new Error("refusing import: each ticket project needs an explicit legal entity");
    await lockScopeRows(
      db,
      orgId,
      [
        ...new Set(
          tickets.flatMap((ticket) =>
            [ticket.customerRef, ticket.foremanRef, ticket.superintendentRef].flatMap((ref) =>
              ref && parties.has(ref) ? [parties.get(ref)!] : [],
            ),
          ),
        ),
      ].map((id) => ({ kind: "party" as const, id })),
      allowed,
      "share",
      { orgWideNull: true },
    );
    for (const ticket of tickets) {
      const projectId = projects.get(ticket.jobRef)!;
      // Serialize concurrent importers of this number, then recheck inside
      // the lock: a row that appeared after the preload above is verified by
      // identity like any other, never assumed to be ours.
      await db.execute(sql`
        select pg_advisory_xact_lock(hashtextextended(${"field-ticket-import:" + orgId + ":" + ticket.number}, 0))
      `);
      const sourceMatches = await db.execute<{ id: string; document_number: string }>(
        sql`
        select id, document_number from documents
         where org_id = ${orgId} and kind = 'field_ticket'
           and custom->'source'->>'system' = ${sourceSystem}
           and custom->'source'->>'externalId' = ${ticket.sourceId}
         order by id for update
      `,
        "objects",
      );
      if (
        sourceMatches.length > 1 ||
        sourceMatches.some((row) => row.document_number !== ticket.number)
      ) {
        throw new Error(
          `refusing import: source ticket ${ticket.sourceId} already has a different or ambiguous native number`,
        );
      }
      const current = (
        await db.execute<{
          id: string;
          source_system: string | null;
          source_external_id: string | null;
          source_job_ref: string | null;
          project_id: string | null;
          subsidiary_id: string | null;
          status: string;
        }>(
          sql`
          select id, project_id::text, subsidiary_id::text, status,
                 custom->'source'->>'system' as source_system,
                   custom->'source'->>'externalId' as source_external_id,
                   custom->'source'->>'jobRef' as source_job_ref
            from documents
           where org_id = ${orgId} and kind = 'field_ticket' and document_number = ${ticket.number}
           for update
        `,
          "objects",
        )
      )[0];
      const rechecked: ExistingTicket | undefined = current
        ? {
            id: String(current.id),
            sourceSystem: current.source_system ? String(current.source_system) : null,
            sourceExternalId: current.source_external_id
              ? String(current.source_external_id)
              : null,
            sourceJobRef: current.source_job_ref ? String(current.source_job_ref) : null,
          }
        : undefined;
      const known = rechecked;
      if (
        current &&
        (current.project_id !== projectId ||
          current.subsidiary_id !== projectEntities.get(projectId))
      ) {
        throw new Error(
          `refusing import: source ticket ${ticket.sourceId} has a different native project or legal entity`,
        );
      }
      if (rechecked) existingTickets.set(ticket.number, rechecked);
      let ticketDocId: string;
      if (resolveTicketIdentity(ticket, known, sourceSystem) === "replay") {
        ticketDocId = known!.id;
        existing++;
      } else {
        const sourceMetadata = {
          source: {
            system: sourceSystem,
            externalId: ticket.sourceId,
            number: ticket.number,
            jobRef: ticket.jobRef,
            empRef: ticket.empRef,
            foremanRef: ticket.foremanRef,
            superintendentRef: ticket.superintendentRef,
            periodBegin: ticket.begin,
            periodEnd: ticket.end,
            billed: ticket.billed,
            finalTicket: ticket.final,
            approval: ticket.approval,
          },
        };
        const inserted = await db.execute<{ id: string }>(
          sql`
            insert into documents (org_id, kind, document_number, party_id, project_id, subsidiary_id, document_date, currency,
                                   status, memo, subtotal, tax_total, total, reference_number, created_by, custom)
            values (${orgId}, 'field_ticket', ${ticket.number}, ${parties.get(ticket.customerRef) ?? null}, ${projectId}, ${projectEntities.get(projectId)},
                    ${ticket.end}, ${baseCurrency}, 'draft', ${ticket.description},
                    '0', '0', '0', ${ticket.po}, ${actor},
                    ${JSON.stringify(sourceMetadata)}::jsonb)
            returning id`,
          "objects",
        );
        if (inserted.length !== 1) {
          throw new Error(
            `refusing import: writing source ticket ${ticket.sourceId} (number ${ticket.number}) matched ${inserted.length} rows; re-run the import`,
          );
        }
        ticketDocId = String(inserted[0]!.id);
        createdTicketStatus.set(ticketDocId, ticket.approval === "Yes" ? "approved" : "draft");
        const documentAudit = await db.execute(
          sql`
          insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
          values (${orgId}, 'documents', ${ticketDocId}, 'insert',
            ${JSON.stringify({ reason: "source_field_ticket_import", ...sourceMetadata, after: { projectId, subsidiaryId: projectEntities.get(projectId), status: "draft" } })}::jsonb,
            ${actor}, ${requestId}) returning id
        `,
          "objects",
        );
        if (documentAudit.length !== 1)
          throw new Error(
            `refusing import: source ticket ${ticket.sourceId} document was not audited`,
          );
        existingTickets.set(ticket.number, {
          id: ticketDocId,
          sourceSystem,
          sourceExternalId: ticket.sourceId,
          sourceJobRef: ticket.jobRef,
        });
        created++;
      }

      // The source row is identity-verified and serialized above. A replay
      // refreshes its crew-role facts from the source and audits any material
      // change; import timestamps alone never change those work facts.
      const targetForeman = ticket.foremanRef ? parties.get(ticket.foremanRef)! : null;
      const previous = (
        await db.execute<{
          period_start: string;
          period_end: string;
          foreman_party_id: string | null;
          superintendent_party_id: string | null;
        }>(
          sql`
        select period_start::text, period_end::text, foreman_party_id::text, superintendent_party_id::text
          from field_tickets where org_id = ${orgId} and document_id = ${ticketDocId} for update
      `,
          "objects",
        )
      )[0];
      const targetSuperintendent =
        ticket.superintendentRef === undefined
          ? (previous?.superintendent_party_id ?? null)
          : ticket.superintendentRef
            ? parties.get(ticket.superintendentRef)!
            : null;
      if (!previous) {
        if (current?.status === "posted" || current?.status === "voided") {
          throw new Error(
            `refusing import: source ticket ${ticket.sourceId} is ${current.status}; preserve its historical work context`,
          );
        }
        if (current) await refuseUsedTicket(orgId, ticketDocId);
        const native = await db.execute(
          sql`
        insert into field_tickets
          (document_id, org_id, period, period_start, period_end,
           foreman_party_id, superintendent_party_id, created_by, updated_by)
        values (${ticketDocId}, ${orgId}, 'weekly', ${ticket.begin}, ${ticket.end},
                ${targetForeman}, ${targetSuperintendent}, ${actor}, ${actor})
        returning document_id
      `,
          "objects",
        );
        if (native.length !== 1) {
          throw new Error(
            `refusing import: native header for source ticket ${ticket.sourceId} was not created`,
          );
        }
        const headerAudit = await db.execute(
          sql`
          insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
          values (${orgId}, 'field_tickets', ${ticketDocId}, 'insert',
            ${JSON.stringify({
              reason: "source_field_ticket_import",
              sourceSystem,
              sourceExternalId: ticket.sourceId,
              after: {
                periodStart: ticket.begin,
                periodEnd: ticket.end,
                foremanPartyId: targetForeman,
                superintendentPartyId: targetSuperintendent,
              },
            })}::jsonb,
            ${actor}, ${requestId}) returning id
        `,
          "objects",
        );
        if (headerAudit.length !== 1)
          throw new Error(
            `refusing import: source ticket ${ticket.sourceId} header was not audited`,
          );
        nativeCreated++;
      } else {
        const changed =
          previous.period_start !== ticket.begin ||
          previous.period_end !== ticket.end ||
          previous.foreman_party_id !== targetForeman ||
          previous.superintendent_party_id !== targetSuperintendent;
        if (changed) {
          if (current?.status === "posted" || current?.status === "voided") {
            throw new Error(
              `refusing import: source ticket ${ticket.sourceId} is ${current.status}; preserve its historical work facts`,
            );
          }
          await refuseUsedTicket(orgId, ticketDocId);
          const update = await db.execute(
            sql`
            update field_tickets
               set period_start = ${ticket.begin}, period_end = ${ticket.end},
                   foreman_party_id = ${targetForeman}, superintendent_party_id = ${targetSuperintendent},
                   updated_by = ${actor}, updated_at = now()
             where org_id = ${orgId} and document_id = ${ticketDocId}
            returning document_id
          `,
            "objects",
          );
          if (update.length !== 1) {
            throw new Error(
              `refusing import: source ticket ${ticket.sourceId} role update matched ${update.length} native headers`,
            );
          }
          const audit = await db.execute(
            sql`
            insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
            values (${orgId}, 'field_tickets', ${ticketDocId}, 'update',
              ${JSON.stringify({
                reason: "source_field_ticket_import",
                sourceSystem,
                sourceExternalId: ticket.sourceId,
                before: {
                  periodStart: previous.period_start,
                  periodEnd: previous.period_end,
                  foremanPartyId: previous.foreman_party_id,
                  superintendentPartyId: previous.superintendent_party_id,
                },
                after: {
                  periodStart: ticket.begin,
                  periodEnd: ticket.end,
                  foremanPartyId: targetForeman,
                  superintendentPartyId: targetSuperintendent,
                },
              })}::jsonb, ${actor}, ${requestId})
            returning id
          `,
            "objects",
          );
          if (audit.length !== 1) {
            throw new Error(
              `refusing import: source ticket ${ticket.sourceId} header change was not audited`,
            );
          }
          nativeUpdated++;
        }
      }
    }
    if (charges.length > 0) {
      const ticketDocumentBySourceRef = new Map<string, string>();
      const ticketJobBySourceRef = new Map<string, string>();
      const sourceTickets = await db.execute<{
        id: string;
        source_external_id: string;
        source_job_ref: string | null;
      }>(
        sql`
        select id::text id, custom->'source'->>'externalId' source_external_id, custom->'source'->>'jobRef' source_job_ref
          from documents where org_id = ${orgId} and kind = 'field_ticket'
           and custom->'source'->>'system' = ${sourceSystem}
           and custom->'source'->>'externalId' = any(${sql.param(charges.map((charge) => charge.ticketRef))}::text[])
         order by id for update
      `,
        "objects",
      );
      for (const row of sourceTickets) {
        if (ticketDocumentBySourceRef.has(row.source_external_id))
          throw new Error(
            `refusing import: source ticket ${row.source_external_id} has multiple native documents`,
          );
        ticketDocumentBySourceRef.set(row.source_external_id, row.id);
        if (row.source_job_ref)
          ticketJobBySourceRef.set(row.source_external_id, row.source_job_ref);
      }
      for (const ticket of tickets) ticketJobBySourceRef.set(ticket.sourceId, ticket.jobRef);
      const sourceDocumentRefs = [
        ...new Set(
          charges.flatMap((charge) => (charge.sourceDocumentRef ? [charge.sourceDocumentRef] : [])),
        ),
      ];
      const sourceItemRefs = [...new Set(charges.map((charge) => charge.itemRef))];
      if (sourceDocumentRefs.length) {
        const ambiguousOrders = await db.execute(
          sql`
          select custom->>'nsId' from documents where org_id = ${orgId} and kind = 'sales_order'
           and custom->>'nsId' = any(${sql.param(sourceDocumentRefs)}::text[])
           group by custom->>'nsId' having count(*) <> 1
        `,
          "objects",
        );
        if (ambiguousOrders.length)
          throw new Error(
            "refusing import: a sales-order source identity resolves to multiple native documents",
          );
      }
      const nativeLines =
        sourceDocumentRefs.length === 0
          ? []
          : (
              await db.execute<{
                id: string;
                source_document_ref: string;
                item_ref: string;
                amount: string;
                quantity: string;
                occurred_on: string;
                field_ticket_id: string | null;
                status: string;
                project_id: string | null;
                subsidiary_id: string | null;
              }>(
                sql`
          select line.id::text id, doc.custom->>'nsId' source_document_ref,
                 item.custom->>'nsId' item_ref, line.amount::text amount,
                 line.quantity::text quantity, coalesce(line.work_from, doc.document_date)::text occurred_on,
                 line.field_ticket_id::text field_ticket_id, doc.status,
                 coalesce(line.project_id, doc.project_id)::text project_id, doc.subsidiary_id::text subsidiary_id
            from document_lines line
            join documents doc on doc.org_id = line.org_id and doc.id = line.document_id
            join items item on item.org_id = line.org_id and item.id = line.item_id
           where line.org_id = ${orgId} and doc.kind = 'sales_order'
             and doc.custom->>'nsId' = any(${sql.param(sourceDocumentRefs)}::text[])
             and item.custom->>'nsId' = any(${sql.param(sourceItemRefs)}::text[])
           order by doc.id, line.id for update of doc, line
        `,
                "objects",
              )
            ).map((row) => ({
              id: String(row.id),
              sourceDocumentRef: String(row.source_document_ref),
              itemRef: String(row.item_ref),
              amount: String(row.amount),
              quantity: String(row.quantity),
              occurredOn: String(row.occurred_on).slice(0, 10),
              fieldTicketId: row.field_ticket_id ? String(row.field_ticket_id) : null,
              status: row.status,
              projectId: row.project_id,
              subsidiaryId: row.subsidiary_id,
            }));
      const links = matchBillableChargeLines(charges, nativeLines, ticketDocumentBySourceRef);

      const affectedTicketDocuments = new Set<string>();
      const existingSourceLines = await db.execute<{
        id: string;
        document_id: string;
        source_line_ref: string;
        line_number: number;
        item_id: string | null;
        project_id: string | null;
        amount: string;
        quantity: string;
        unit_price: string;
        bill_amount: string | null;
        work_from: string | null;
        work_to: string | null;
        field_ticket_id: string | null;
      }>(sql`
        select id::text id, document_id::text document_id, custom->>'sourceLineRef' source_line_ref,
               line_number, item_id::text item_id, project_id::text project_id,
               amount::text amount, quantity::text quantity, unit_price::text unit_price,
               bill_amount::text bill_amount, work_from::text work_from, work_to::text work_to,
               field_ticket_id::text field_ticket_id
          from document_lines
         where org_id = ${orgId}
           and custom->>'sourceSystem' = ${sourceSystem}
           and custom->>'sourceLineRef' = any(${sql.param(charges.map((charge) => `billable_transaction:${charge.sourceId}`))}::text[])
         order by id for update
      `);
      const sourceLineByRef = new Map<string, (typeof existingSourceLines.rows)[number]>();
      for (const row of existingSourceLines.rows) {
        if (sourceLineByRef.has(row.source_line_ref)) {
          throw new Error(
            `refusing import: source billable-timesheet line ${row.source_line_ref} is duplicated in the native tenant`,
          );
        }
        sourceLineByRef.set(row.source_line_ref, row);
      }
      const nextLineNumberByDocument = new Map<string, number>();
      const ticketDocumentIds = [
        ...new Set(
          charges.flatMap((charge) => {
            const documentId = ticketDocumentBySourceRef.get(charge.ticketRef);
            return documentId ? [documentId] : [];
          }),
        ),
      ];
      const existingMaxLineNumbers =
        ticketDocumentIds.length === 0
          ? []
          : await db.execute<{
              document_id: string;
              next_line_number: number;
            }>(
              sql`
        select document_id::text document_id, coalesce(max(line_number), 0)::int + 1 next_line_number
          from document_lines
         where org_id = ${orgId} and document_id = any(${sql.param(ticketDocumentIds)}::uuid[])
         group by document_id
      `,
              "objects",
            );
      for (const row of existingMaxLineNumbers)
        nextLineNumberByDocument.set(row.document_id, row.next_line_number);
      for (const documentId of ticketDocumentIds)
        if (!nextLineNumberByDocument.has(documentId)) nextLineNumberByDocument.set(documentId, 1);
      for (const charge of charges) {
        const ticketDocumentId = ticketDocumentBySourceRef.get(charge.ticketRef);
        if (!ticketDocumentId) {
          throw new Error(
            `refusing import: source ticket ${charge.ticketRef} is not a native field ticket`,
          );
        }
        if (ticketJobBySourceRef.get(charge.ticketRef) !== charge.jobRef) {
          throw new Error(
            `refusing import: billable-timesheet ${charge.sourceId} job ${charge.jobRef} does not match source ticket ${charge.ticketRef} job ${ticketJobBySourceRef.get(charge.ticketRef) ?? "unknown"}`,
          );
        }
        const itemId = items.get(charge.itemRef)!;
        const ticketRow = (
          await db.execute<{
            project_id: string | null;
            subsidiary_id: string | null;
            status: string;
            period_start: string;
            period_end: string;
          }>(
            sql`
          select doc.project_id::text project_id, doc.subsidiary_id::text subsidiary_id, doc.status,
                 ft.period_start::text, ft.period_end::text
            from documents doc join field_tickets ft on ft.org_id = doc.org_id and ft.document_id = doc.id
           where doc.org_id = ${orgId} and doc.id = ${ticketDocumentId} and doc.kind = 'field_ticket'
           for update of doc
        `,
            "objects",
          )
        )[0];
        if (!ticketRow)
          throw new Error(
            `refusing import: native field-ticket header for source ${charge.ticketRef} is missing`,
          );
        if (
          charge.occurredOn < ticketRow.period_start ||
          charge.occurredOn > ticketRow.period_end
        ) {
          throw new Error(
            `refusing import: billable-timesheet ${charge.sourceId} occurs outside native ticket ${charge.ticketRef}'s work period`,
          );
        }
        if (!ticketRow.subsidiary_id || !subsidiaryScopeAllows(allowed, ticketRow.subsidiary_id))
          throw new Error(
            "refusing import: native field ticket is outside the actor's legal-entity scope",
          );
        if (!ticketRow.project_id)
          throw new Error(
            `refusing import: native field ticket ${charge.ticketRef} has no project`,
          );
        const project = await lockScopeRows(
          db,
          orgId,
          [{ kind: "project", id: ticketRow.project_id }],
          allowed,
          "share",
        );
        if (
          projects.get(charge.jobRef) !== ticketRow.project_id ||
          project[0]?.subsidiaryId !== ticketRow.subsidiary_id
        )
          throw new Error(
            `refusing import: billable-timesheet ${charge.sourceId} project and legal entity do not match the native ticket`,
          );
        const sourceLineRef = `billable_transaction:${charge.sourceId}`;
        const existingLine = sourceLineByRef.get(sourceLineRef);
        if (existingLine && existingLine.document_id !== ticketDocumentId) {
          throw new Error(
            `refusing import: billable-timesheet ${charge.sourceId} already belongs to a different native field ticket`,
          );
        }
        const after = {
          itemId,
          projectId: ticketRow.project_id,
          amount: charge.amount,
          quantity: charge.quantity,
          unitPrice: charge.unitPrice,
          billAmount: charge.amount,
          workFrom: charge.occurredOn,
          workTo: charge.occurredOn,
          fieldTicketId: ticketDocumentId,
          sourceSystem,
          sourceTransactionId: charge.sourceId,
        };
        if (!existingLine) {
          assertChargeWriteAllowed(ticketRow.status, charge.sourceId);
          await refuseUsedTicket(orgId, ticketDocumentId);
          const lineNumber = nextLineNumberByDocument.get(ticketDocumentId)!;
          const inserted = await db.execute<{ id: string }>(
            sql`
            insert into document_lines
              (org_id, document_id, line_number, item_id, description, quantity, unit_price, amount,
               tax_amount, is_billable, project_id, field_ticket_id, bill_amount, work_from, work_to, custom)
            values (${orgId}, ${ticketDocumentId}, ${lineNumber}, ${itemId},
                    ${`Billable timesheet transaction ${charge.sourceId}`}, ${charge.quantity}, ${charge.unitPrice}, ${charge.amount},
                    '0', true, ${ticketRow.project_id}, ${ticketDocumentId}, ${charge.amount}, ${charge.occurredOn}, ${charge.occurredOn},
                    ${JSON.stringify({ sourceLineRef, sourceSystem, sourceTransactionId: charge.sourceId, sourceTicketRef: charge.ticketRef })}::jsonb)
            returning id::text id
          `,
            "objects",
          );
          if (inserted.length !== 1)
            throw new Error(
              `refusing import: billable-timesheet ${charge.sourceId} line was not inserted`,
            );
          const audit = await db.execute(
            sql`
            insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
            values (${orgId}, 'document_lines', ${String(inserted[0]!.id)}, 'insert',
                    ${JSON.stringify({ reason: "source_billable_timesheet_import", sourceSystem, sourceTransactionId: charge.sourceId, sourceTicketRef: charge.ticketRef, after })}::jsonb,
                    ${actor}, ${requestId}) returning id
          `,
            "objects",
          );
          if (audit.length !== 1)
            throw new Error(
              `refusing import: billable-timesheet ${charge.sourceId} line was not audited`,
            );
          nextLineNumberByDocument.set(ticketDocumentId, lineNumber + 1);
          billableChargesCreated++;
          affectedTicketDocuments.add(ticketDocumentId);
        } else {
          const same =
            existingLine.item_id === itemId &&
            existingLine.project_id === ticketRow.project_id &&
            toUnits(existingLine.amount) === toUnits(charge.amount) &&
            normalizeDecimal(existingLine.quantity, 8) === charge.quantity &&
            normalizeDecimal(existingLine.unit_price, 8) === charge.unitPrice &&
            (existingLine.bill_amount === null ? null : toUnits(existingLine.bill_amount)) ===
              toUnits(charge.amount) &&
            existingLine.work_from?.slice(0, 10) === charge.occurredOn &&
            existingLine.work_to?.slice(0, 10) === charge.occurredOn &&
            existingLine.field_ticket_id === ticketDocumentId;
          if (!same) {
            assertChargeWriteAllowed(ticketRow.status, charge.sourceId);
            await refuseUsedTicket(orgId, ticketDocumentId);
            const before = {
              itemId: existingLine.item_id,
              projectId: existingLine.project_id,
              amount: existingLine.amount,
              quantity: existingLine.quantity,
              unitPrice: existingLine.unit_price,
              billAmount: existingLine.bill_amount,
              workFrom: existingLine.work_from,
              workTo: existingLine.work_to,
              fieldTicketId: existingLine.field_ticket_id,
            };
            const updated = await db.execute(
              sql`
              update document_lines set item_id = ${itemId}, project_id = ${ticketRow.project_id},
                     amount = ${charge.amount}, quantity = ${charge.quantity}, unit_price = ${charge.unitPrice},
                     bill_amount = ${charge.amount}, is_billable = true, field_ticket_id = ${ticketDocumentId},
                     work_from = ${charge.occurredOn}, work_to = ${charge.occurredOn},
                     updated_at = now()
               where org_id = ${orgId} and id = ${existingLine.id} and document_id = ${ticketDocumentId}
              returning id
            `,
              "objects",
            );
            if (updated.length !== 1)
              throw new Error(
                `refusing import: source billable-timesheet ${charge.sourceId} correction matched ${updated.length} lines`,
              );
            const audit = await db.execute(
              sql`
              insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
              values (${orgId}, 'document_lines', ${existingLine.id}, 'update',
                      ${JSON.stringify({ reason: "source_billable_timesheet_import", sourceSystem, sourceTransactionId: charge.sourceId, sourceTicketRef: charge.ticketRef, before, after })}::jsonb,
                      ${actor}, ${requestId}) returning id
            `,
              "objects",
            );
            if (audit.length !== 1)
              throw new Error(
                `refusing import: billable-timesheet ${charge.sourceId} correction was not audited`,
              );
            billableChargesUpdated++;
            affectedTicketDocuments.add(ticketDocumentId);
          } else billableChargesUnchanged++;
        }
      }
      const linksToWrite = links.filter((link) => link.previousTicketDocumentId === null);
      for (const link of links) {
        const line = nativeLines.find((row) => row.id === link.nativeLineId)!;
        const ticketRow = (
          await db.execute<{ project_id: string | null; subsidiary_id: string | null }>(
            sql`
          select project_id::text, subsidiary_id::text from documents where org_id = ${orgId} and id = ${link.ticketDocumentId} for share
        `,
            "objects",
          )
        )[0];
        if (
          !ticketRow ||
          line.projectId !== ticketRow.project_id ||
          line.subsidiaryId !== ticketRow.subsidiary_id ||
          !line.subsidiaryId ||
          !subsidiaryScopeAllows(allowed, line.subsidiaryId)
        ) {
          throw new Error(
            `refusing import: sales-order line ${line.id} and ticket do not share an authorized project and legal entity`,
          );
        }
        if (link.previousTicketDocumentId !== null) continue;
        if (line.status !== "draft")
          throw new Error(
            `refusing import: sales-order line ${line.id} is ${line.status}; preserve its source lineage and use the governed document amendment`,
          );
        await lockActorCommandAuthority(db, orgId, actor, line.subsidiaryId, "ar.create");
        if (!(await lockAndCheckOrgFeature(db, orgId, "orders")))
          throw new Error(
            "refusing import: enable Orders in Company Settings → Features before linking source orders",
          );
        await refuseUsedSourceLine(orgId, line.id);
      }
      if (linksToWrite.length) {
        const linkPayload = JSON.stringify(
          linksToWrite.map((link) => ({
            line_id: link.nativeLineId,
            ticket_document_id: link.ticketDocumentId,
            source_transaction_id: link.sourceTransactionId,
            ticket_ref: link.ticketRef,
          })),
        );
        const updated = await db.execute<{ id: string }>(
          sql`
          update document_lines line set field_ticket_id = source.ticket_document_id, updated_at = now()
            from jsonb_to_recordset(${linkPayload}::jsonb) as source(line_id uuid, ticket_document_id uuid, source_transaction_id text, ticket_ref text)
           where line.org_id = ${orgId} and line.id = source.line_id and line.field_ticket_id is null
          returning line.id::text id
        `,
          "objects",
        );
        if (updated.length !== linksToWrite.length)
          throw new Error(
            `refusing import: expected to link ${linksToWrite.length} source sales-order lines, updated ${updated.length}`,
          );
        const audit = await db.execute(
          sql`
          insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
          select ${orgId}, 'document_lines', source.line_id, 'update',
                 jsonb_build_object('reason', 'source_billable_timesheet_ticket_link', 'sourceSystem', ${sourceSystem}::text,
                   'sourceTransactionId', source.source_transaction_id, 'sourceTicketRef', source.ticket_ref,
                   'before', jsonb_build_object('fieldTicketId', null), 'after', jsonb_build_object('fieldTicketId', source.ticket_document_id)),
                 ${actor}, ${requestId}
            from jsonb_to_recordset(${linkPayload}::jsonb) as source(line_id uuid, ticket_document_id uuid, source_transaction_id text, ticket_ref text)
          returning id
        `,
          "objects",
        );
        if (audit.length !== linksToWrite.length)
          throw new Error(
            `refusing import: expected ${linksToWrite.length} sales-order ticket-link audit rows, wrote ${audit.length}`,
          );
        salesOrderLinesLinked = updated.length;
      }
      for (const documentId of affectedTicketDocuments) {
        const before = (
          await db.execute<{ subtotal: string; tax_total: string; total: string }>(
            sql`
          select subtotal::text subtotal, tax_total::text tax_total, total::text total
            from documents where org_id = ${orgId} and id = ${documentId} for update
        `,
            "objects",
          )
        )[0]!;
        const updated = await db.execute<{ subtotal: string; tax_total: string; total: string }>(
          sql`
          update documents doc set
                 subtotal = totals.subtotal, tax_total = totals.tax_total, total = totals.subtotal + totals.tax_total,
                 updated_at = now()
            from (select coalesce(sum(amount), 0) subtotal, coalesce(sum(tax_amount), 0) tax_total
                    from document_lines where org_id = ${orgId} and document_id = ${documentId}) totals
           where doc.org_id = ${orgId} and doc.id = ${documentId}
          returning doc.subtotal::text subtotal, doc.tax_total::text tax_total, doc.total::text total
        `,
          "objects",
        );
        if (updated.length !== 1)
          throw new Error(
            `refusing import: source field-ticket ${documentId} financial totals were not refreshed`,
          );
        const after = updated[0]!;
        if (
          toUnits(before.subtotal) !== toUnits(after.subtotal) ||
          toUnits(before.tax_total) !== toUnits(after.tax_total) ||
          toUnits(before.total) !== toUnits(after.total)
        ) {
          const audit = await db.execute(
            sql`
            insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
            values (${orgId}, 'documents', ${documentId}, 'update',
                    ${JSON.stringify({ reason: "source_billable_timesheet_import", sourceSystem, before, after })}::jsonb,
                    ${actor}, ${requestId}) returning id
          `,
            "objects",
          );
          if (audit.length !== 1)
            throw new Error(
              `refusing import: field-ticket ${documentId} line totals were not audited`,
            );
        }
      }
    }
    for (const [documentId, status] of createdTicketStatus) {
      if (status === "draft") continue;
      const approved = await db.execute(
        sql`
        update documents set status = 'approved', updated_at = now()
         where org_id = ${orgId} and id = ${documentId} and status = 'draft' returning id
      `,
        "objects",
      );
      if (approved.length !== 1)
        throw new Error(
          `refusing import: source field-ticket ${documentId} approval was not recorded`,
        );
      const audit = await db.execute(
        sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
        values (${orgId}, 'documents', ${documentId}, 'update',
          ${JSON.stringify({ reason: "source_field_ticket_import", sourceSystem, before: { status: "draft" }, after: { status: "approved" } })}::jsonb,
          ${actor}, ${requestId}) returning id
      `,
        "objects",
      );
      if (audit.length !== 1)
        throw new Error(
          `refusing import: source field-ticket ${documentId} approval was not audited`,
        );
    }
    return {
      created,
      nativeCreated,
      nativeUpdated,
      existing,
      billableChargesCreated,
      billableChargesUpdated,
      billableChargesUnchanged,
      salesOrderLinesLinked,
      unmapped,
    };
  });
}

/** Source import never bypasses the native financial lifecycle. */
export function assertChargeWriteAllowed(status: string, sourceId: string): void {
  if (status !== "draft")
    throw new Error(
      `refusing import: billable-timesheet ${sourceId} belongs to a ${status} ticket; preserve its financial facts and use the governed document amendment`,
    );
}

async function refuseUsedSourceLine(orgId: string, lineId: string): Promise<void> {
  const used = await db.execute(
    sql`
    select 1 from hrm_benefit_awards a
     where a.org_id = ${orgId}
       and jsonb_path_exists(a.source_snapshot, '$.measurement.settlement.transaction.source.lines[*] ? (@.sourceId == $lineId)', jsonb_build_object('lineId', ${lineId}::text))
     limit 1
  `,
    "objects",
  );
  if (used.length)
    throw new Error(
      `refusing import: native source line ${lineId} is retained by an award; preserve its source facts and record an adjusting award`,
    );
}

async function refuseUsedTicket(orgId: string, documentId: string): Promise<void> {
  const used = await db.execute(
    sql`
    select 1 where exists (
      select 1 from hrm_benefit_awards a where a.org_id = ${orgId}
       and (jsonb_path_exists(a.source_snapshot, '$.measurement.settlement.transaction.source.lines[*] ? (@.documentId == $documentId)', jsonb_build_object('documentId', ${documentId}::text))
         or jsonb_path_exists(a.source_snapshot, '$.measurement.settlement.transaction.recipientContexts[*] ? (@.ticket_reference == $documentId)', jsonb_build_object('documentId', ${documentId}::text)))
    ) or exists (
      select 1 from document_lines l join hrm_benefit_awards a on a.org_id = l.org_id
       where l.org_id = ${orgId} and l.field_ticket_id = ${documentId}
         and jsonb_path_exists(a.source_snapshot, '$.measurement.settlement.transaction.source.lines[*] ? (@.sourceId == $lineId)', jsonb_build_object('lineId', l.id::text))
    ) or exists (
      select 1 from field_ticket_labor_snapshots s where s.org_id = ${orgId} and s.field_ticket_id = ${documentId}
    ) or exists (
      select 1 from field_ticket_signatures s where s.org_id = ${orgId} and s.field_ticket_id = ${documentId}
    ) or exists (
      select 1 from field_tickets ft where ft.org_id = ${orgId} and ft.document_id = ${documentId} and ft.charge_document_id is not null
    ) or exists (
      select 1 from billing_request_field_tickets b where b.org_id = ${orgId} and b.field_ticket_id = ${documentId}
    )
  `,
    "objects",
  );
  if (used.length)
    throw new Error(
      `refusing import: native ticket ${documentId} is retained by issued work or financial evidence; preserve its work facts and use the native correction workflow`,
    );
}
