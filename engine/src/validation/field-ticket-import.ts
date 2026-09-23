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
import { db, withOrg } from "../platform/db.ts";

export interface ImportTicket {
  sourceId: string;
  number: string;
  jobRef: string;
  empRef: string;
  customerRef: string;
  begin: string;
  end: string;
  billed: boolean;
  final: boolean;
  approval: string;
  foremanRef: string;
  po: string | null;
  description: string | null;
}

export interface ExistingTicket {
  id: string;
  sourceSystem: string | null;
  sourceExternalId: string | null;
}

export interface UnmappedTicket {
  sourceId: string;
  number: string;
  jobRef: string;
}

export interface FieldTicketImportResult {
  created: number;
  nativeCreated: number;
  existing: number;
  unmapped: UnmappedTicket[];
}

export function parseTicketTsv(text: string): ImportTicket[] {
  return text
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((columns) => columns.length >= 13 && /^\d+$/.test(columns[0]!))
    .map((columns) => ({
      sourceId: columns[0]!,
      number: columns[1]!,
      jobRef: columns[2]!,
      empRef: columns[3]!,
      customerRef: columns[4]!,
      begin: columns[5]!,
      end: columns[6]!,
      billed: columns[7] === "Yes",
      final: columns[8] === "Yes",
      approval: columns[9]!,
      foremanRef: columns[10]!,
      po: columns[11] === "NULL" ? null : columns[11]!,
      description: (columns[12] ?? "").trim() || null,
    }));
}

/**
 * Decide whether an incoming ticket creates a document or replays one. An
 * exact source-system + externalId match is the only replay; anything else
 * sharing the number refuses by name with both identities.
 */
export function resolveTicketIdentity(
  ticket: ImportTicket,
  existing: ExistingTicket | undefined,
  sourceSystem: string,
): "create" | "replay" {
  if (!existing) return "create";
  if (
    existing.sourceSystem === sourceSystem &&
    existing.sourceExternalId === ticket.sourceId
  ) {
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

async function sourceIdMap(table: string, orgId: string): Promise<Map<string, string>> {
  const rows = (
    await db.execute(sql.raw(
      `select custom->>'nsId' k, id from "${table}" where org_id = '${orgId}' and custom->>'nsId' is not null`,
    ))
  ).rows;
  return new Map<string, string>(
    rows.map((row) => [String(row.k), String(row.id)]),
  );
}

export async function importFieldTickets(input: {
  orgId: string;
  sourceSystem: string;
  tickets: readonly ImportTicket[];
  apply: boolean;
}): Promise<FieldTicketImportResult> {
  const { orgId, sourceSystem, tickets } = input;
  const projects = await sourceIdMap("projects", orgId);
  const parties = await sourceIdMap("parties", orgId);
  const actor = (
    await db.execute(
      sql`select id from users where org_id = ${orgId} order by created_at limit 1`,
    )
  ).rows[0]?.id ?? null;
  const org = (
    await db.execute(sql`select base_currency from orgs where id = ${orgId}`)
  ).rows[0] as { base_currency?: string } | undefined;
  const baseCurrency = org?.base_currency?.trim();
  if (!baseCurrency) throw new Error("target organization has no base currency");

  const existingTickets = new Map<string, ExistingTicket>(
    (
      await db.execute<{
        n: string;
        id: string;
        source_system: string | null;
        source_external_id: string | null;
      }>(sql`
        select document_number n, id,
               custom->'source'->>'system' as source_system,
               custom->'source'->>'externalId' as source_external_id
          from documents where org_id = ${orgId} and kind = 'field_ticket'`)
    ).rows.map(
      (row): [string, ExistingTicket] => [
        String(row.n),
        {
          id: String(row.id),
          sourceSystem: row.source_system ? String(row.source_system) : null,
          sourceExternalId: row.source_external_id
            ? String(row.source_external_id)
            : null,
        },
      ],
    ),
  );

  // Every ticket's project resolves before the first write: one unmapped
  // job refuses the whole import with its source refs, before anything
  // commits. This pre-check names every offender at once; the single
  // transaction below is what guarantees zero writes even for failures the
  // pre-check cannot foresee.
  const unmapped: UnmappedTicket[] = tickets
    .filter((ticket) => !projects.get(ticket.jobRef))
    .map((ticket) => ({
      sourceId: ticket.sourceId,
      number: ticket.number,
      jobRef: ticket.jobRef,
    }));
  if (!input.apply) {
    return { created: 0, nativeCreated: 0, existing: 0, unmapped };
  }
  if (unmapped.length > 0) {
    const refs = unmapped
      .map((row) => `source ticket ${row.sourceId} (number ${row.number}, job ${row.jobRef})`)
      .join("; ");
    throw new Error(
      `refusing import: ${unmapped.length} ticket(s) reference unknown source projects: ${refs}; ` +
        "map every job before importing — no ticket was written",
    );
  }

  // One tenant transaction for the whole import: any refusal rolls every
  // ticket back, so automation never reads a partial import as success.
  return withOrg(orgId, async () => {
    let created = 0;
    let nativeCreated = 0;
    let existing = 0;
    for (const ticket of tickets) {
      const projectId = projects.get(ticket.jobRef)!;
      // Serialize concurrent importers of this number, then recheck inside
      // the lock: a row that appeared after the preload above is verified by
      // identity like any other, never assumed to be ours.
      await db.execute(sql`
        select pg_advisory_xact_lock(hashtextextended(${"field-ticket-import:" + orgId + ":" + ticket.number}, 0))
      `);
      const current = (
        await db.execute<{
          id: string;
          source_system: string | null;
          source_external_id: string | null;
        }>(sql`
          select id,
                 custom->'source'->>'system' as source_system,
                 custom->'source'->>'externalId' as source_external_id
            from documents
           where org_id = ${orgId} and kind = 'field_ticket' and document_number = ${ticket.number}
           for update
        `)
      ).rows[0];
      const rechecked: ExistingTicket | undefined = current
        ? {
            id: String(current.id),
            sourceSystem: current.source_system ? String(current.source_system) : null,
            sourceExternalId: current.source_external_id
              ? String(current.source_external_id)
              : null,
          }
        : undefined;
      const known = rechecked ?? existingTickets.get(ticket.number);
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
            periodBegin: ticket.begin,
            periodEnd: ticket.end,
            billed: ticket.billed,
            finalTicket: ticket.final,
            approval: ticket.approval,
          },
        };
        const inserted = (
          await db.execute<{ id: string }>(sql`
            insert into documents (org_id, kind, document_number, party_id, project_id, document_date, currency,
                                   status, memo, subtotal, tax_total, total, reference_number, created_by, custom)
            values (${orgId}, 'field_ticket', ${ticket.number}, ${parties.get(ticket.customerRef) ?? null}, ${projectId},
                    ${ticket.end}, ${baseCurrency}, ${ticket.approval === "Yes" ? "approved" : "draft"}, ${ticket.description},
                    '0', '0', '0', ${ticket.po}, ${actor},
                    ${JSON.stringify(sourceMetadata)}::jsonb)
            returning id`)
        ).rows;
        if (inserted.length !== 1) {
          throw new Error(
            `refusing import: writing source ticket ${ticket.sourceId} (number ${ticket.number}) matched ${inserted.length} rows; re-run the import`,
          );
        }
        ticketDocId = String(inserted[0]!.id);
        existingTickets.set(ticket.number, {
          id: ticketDocId,
          sourceSystem,
          sourceExternalId: ticket.sourceId,
        });
        created++;
      }

      // The document above is verified ours (created with our marker or an
      // identity-matched replay), so ensuring its native header is safe. The
      // no-op on conflict is the idempotent replay, not a silent drop: it
      // fires only for our own already-imported ticket.
      const native = await db.execute(sql`
        insert into field_tickets
          (document_id, org_id, period, period_start, period_end,
           foreman_party_id, created_by, updated_by)
        values (${ticketDocId}, ${orgId}, 'weekly', ${ticket.begin}, ${ticket.end},
                ${parties.get(ticket.foremanRef) ?? null}, ${actor}, ${actor})
        on conflict (document_id) do nothing
        returning document_id
      `);
      nativeCreated += native.rows.length;
    }
    return { created, nativeCreated, existing, unmapped };
  });
}
