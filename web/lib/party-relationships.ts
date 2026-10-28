import "server-only";
import { z } from "zod";
import { sql } from "drizzle-orm";
import {
  DOCUMENT_REVISION_PATTERN,
  documentRevisionSql,
  isDocumentRevisionToken,
} from "@openbooks/engine/records/revision";
import type { SqlExecutor } from "@openbooks/engine/platform/db";
import { subsidiaryVisibleFilter } from "./subsidiaries";
import { normalizeCountryCode } from "./countries";

export const partyAddressSchema = z
  .object({
    label: z.string().max(200).nullable().optional().describe("Address label."),
    line1: z.string().max(500).nullable().optional().describe("First street address line."),
    line2: z.string().max(500).nullable().optional().describe("Second street address line."),
    city: z.string().max(200).nullable().optional().describe("City or locality."),
    region: z.string().max(200).nullable().optional().describe("State, province or region."),
    postalCode: z.string().max(40).nullable().optional().describe("Postal or ZIP code."),
    country: z.string().max(2).nullable().optional().describe("ISO 3166-1 alpha-2 country code."),
    isDefaultBilling: z.boolean().optional().describe("Use as the default billing address."),
    isDefaultShipping: z.boolean().optional().describe("Use as the default shipping address."),
  })
  .strict();

export const partyContactSchema = z
  .object({
    firstName: z.string().max(200).nullable().optional().describe("Contact first name."),
    lastName: z.string().max(200).nullable().optional().describe("Contact last name."),
    name: z.string().max(300).nullable().optional().describe("Contact display name."),
    title: z.string().max(200).nullable().optional().describe("Contact job title."),
    role: z.string().max(200).nullable().optional().describe("Contact relationship or function."),
    email: z.string().max(320).nullable().optional().describe("Contact email address."),
    phone: z.string().max(100).nullable().optional().describe("Contact phone number."),
    mobilePhone: z.string().max(100).nullable().optional().describe("Contact mobile number."),
    isPrimary: z.boolean().optional().describe("Mark as the party's primary contact."),
    isActive: z.boolean().optional().describe("Whether this contact is active."),
  })
  .strict();

export type PartyAddressInput = import("zod").infer<typeof partyAddressSchema>;
export type PartyContactInput = import("zod").infer<typeof partyContactSchema>;

export const partyRelationshipsInput = z.object({
  expectedUpdatedAt: z
    .string()
    .regex(new RegExp(DOCUMENT_REVISION_PATTERN))
    .max(60)
    .describe("Current party revision from get_party_relationships."),
  addresses: z.array(partyAddressSchema).max(500).optional().describe("Full address list."),
  contacts: z.array(partyContactSchema).max(500).optional().describe("Full contact list."),
});

export class PartyRelationshipsError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type PartyRelations = {
  partyId: string;
  orgId: string;
  actorId: string;
  addresses?: PartyAddressInput[];
  contacts?: PartyContactInput[];
};

function trimmed(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  return value.trim() || null;
}

function requireRow(rows: unknown[], description: string): void {
  if (rows.length === 0) throw new Error(`${description} was not saved.`);
}

async function relationSnapshot(tx: SqlExecutor, args: PartyRelations) {
  const addresses = await tx.execute(
    sql`select id, label, line1, line2, city, region, postal_code as "postalCode", country,
          is_default_billing as "isDefaultBilling", is_default_shipping as "isDefaultShipping"
        from addresses where org_id = ${args.orgId} and party_id = ${args.partyId} order by id`,
    "objects",
  );
  const contacts = await tx.execute(
    sql`select id, first_name as "firstName", last_name as "lastName", name, title, role,
          email, phone, mobile_phone as "mobilePhone", is_primary as "isPrimary", is_active as "isActive"
        from contacts where org_id = ${args.orgId} and party_id = ${args.partyId} order by id`,
    "objects",
  );
  return { addresses, contacts };
}

/** Replace party addresses and contacts within the caller's locked transaction. */
export async function replacePartyRelationships(
  tx: SqlExecutor,
  args: PartyRelations,
): Promise<void> {
  if (args.addresses === undefined && args.contacts === undefined) return;
  const before = await relationSnapshot(tx, args);
  if (args.addresses !== undefined) {
    for (const address of args.addresses) {
      const country = trimmed(address.country);
      if (country && !normalizeCountryCode(country)) {
        throw new PartyRelationshipsError("Country must be a valid ISO country code", 422);
      }
    }
    const addresses = args.addresses
      .map((address) => ({
        label: trimmed(address.label),
        line1: trimmed(address.line1),
        line2: trimmed(address.line2),
        city: trimmed(address.city),
        region: trimmed(address.region),
        postalCode: trimmed(address.postalCode),
        country: normalizeCountryCode(address.country),
        isDefaultBilling: address.isDefaultBilling === true,
        isDefaultShipping: address.isDefaultShipping === true,
      }))
      .filter((address) =>
        [
          address.label,
          address.line1,
          address.line2,
          address.city,
          address.region,
          address.postalCode,
          address.country,
        ].some(Boolean),
      );
    let billingSeen = false;
    let shippingSeen = false;
    for (const address of addresses) {
      if (address.isDefaultBilling) {
        if (billingSeen) address.isDefaultBilling = false;
        billingSeen = true;
      }
      if (address.isDefaultShipping) {
        if (shippingSeen) address.isDefaultShipping = false;
        shippingSeen = true;
      }
    }
    await tx.execute(
      sql`delete from addresses where org_id = ${args.orgId} and party_id = ${args.partyId}`,
    );
    for (const address of addresses) {
      const inserted = await tx.execute(
        sql`insert into addresses (org_id, party_id, label, line1, line2, city, region, postal_code,
              country, is_default_billing, is_default_shipping, created_by, updated_by)
            values (${args.orgId}, ${args.partyId}, ${address.label}, ${address.line1}, ${address.line2},
              ${address.city}, ${address.region}, ${address.postalCode}, ${address.country},
              ${address.isDefaultBilling}, ${address.isDefaultShipping}, ${args.actorId}, ${args.actorId})
            returning id`,
        "objects",
      );
      requireRow(inserted, "Party address");
    }
  }
  if (args.contacts !== undefined) {
    const contacts = args.contacts
      .map((contact) => {
        const firstName = trimmed(contact.firstName);
        const lastName = trimmed(contact.lastName);
        return {
          firstName,
          lastName,
          name: trimmed(contact.name) ?? ([firstName, lastName].filter(Boolean).join(" ") || null),
          title: trimmed(contact.title),
          role: trimmed(contact.role),
          email: trimmed(contact.email),
          phone: trimmed(contact.phone),
          mobilePhone: trimmed(contact.mobilePhone),
          isPrimary: contact.isPrimary === true,
          isActive: contact.isActive !== false,
        };
      })
      .filter((contact) => contact.name || contact.email || contact.phone || contact.mobilePhone);
    let primarySeen = false;
    for (const contact of contacts) {
      if (contact.isPrimary) {
        if (primarySeen) contact.isPrimary = false;
        primarySeen = true;
      }
    }
    await tx.execute(
      sql`delete from contacts where org_id = ${args.orgId} and party_id = ${args.partyId}`,
    );
    for (const contact of contacts) {
      const inserted = await tx.execute(
        sql`insert into contacts (org_id, party_id, first_name, last_name, name, title, role,
              email, phone, mobile_phone, is_primary, is_active, created_by, updated_by)
            values (${args.orgId}, ${args.partyId}, ${contact.firstName}, ${contact.lastName},
              ${contact.name}, ${contact.title}, ${contact.role}, ${contact.email}, ${contact.phone},
              ${contact.mobilePhone}, ${contact.isPrimary}, ${contact.isActive}, ${args.actorId}, ${args.actorId})
            returning id`,
        "objects",
      );
      requireRow(inserted, "Party contact");
    }
  }
  const after = await relationSnapshot(tx, args);
  if (args.addresses !== undefined || args.contacts !== undefined) {
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${args.orgId}, 'parties', ${args.partyId}, 'update',
        ${JSON.stringify({ relationChange: true, before, after })}::jsonb, ${args.actorId})
    `);
  }
}

/** Replace party relationships after checking the party revision and legal-entity scope. */
export async function updatePartyRelationships(
  tx: SqlExecutor,
  args: PartyRelations & {
    expectedUpdatedAt: string;
    allowedSubsidiaryIds: ReadonlySet<string> | null;
  },
): Promise<{ partyId: string; revision: string }> {
  const party = (
    await tx.execute<{ id: string; revision: string }>(
      sql`select p.id, ${documentRevisionSql(sql`p.updated_at`)} as revision
        from parties p where p.org_id = ${args.orgId} and p.id = ${args.partyId}
          ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, args.allowedSubsidiaryIds, { orgWideNull: true })}
        for update`,
      "objects",
    )
  )[0];
  if (!party) throw new PartyRelationshipsError("Party not found", 404);
  if (
    !isDocumentRevisionToken(args.expectedUpdatedAt) ||
    args.expectedUpdatedAt !== party.revision
  ) {
    throw new PartyRelationshipsError(
      "This party changed after you opened it; reload and try again",
      409,
    );
  }
  const touched = await tx.execute(
    sql`update parties set updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond'),
          updated_by = ${args.actorId}
        where org_id = ${args.orgId} and id = ${args.partyId} returning id`,
    "objects",
  );
  requireRow(touched, "Party relationships");
  await replacePartyRelationships(tx, args);
  const current = (
    await tx.execute<{ revision: string }>(
      sql`select ${documentRevisionSql(sql`p.updated_at`)} as revision
        from parties p where p.org_id = ${args.orgId} and p.id = ${args.partyId}`,
      "objects",
    )
  )[0];
  if (!current) throw new Error("Party revision was not returned after saving relationships.");
  return { partyId: args.partyId, revision: current.revision };
}
