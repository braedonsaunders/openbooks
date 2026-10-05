import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/database";
import { isUuid } from "@openbooks/engine/platform/identifiers";
import { ensurePartyRoleRow } from "../party-roles";
import type { ApplicationContext } from "./context";
import { assertApplicationPermission } from "./context";
import { conflict, invalidInput } from "./errors";

export interface CustomerUpsertAddress {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  country?: string | null;
}

export interface CustomerUpsertInput {
  /** Exact party id when the caller already knows it. */
  id?: string;
  /** Storefront/integrator identity: both or neither, like documents. */
  externalRef?: string;
  externalSource?: string;
  email?: string;
  name?: string;
  kind?: string;
  phone?: string | null;
  address?: CustomerUpsertAddress;
}

const PARTY_KINDS = new Set(["company", "person", "customer", "vendor", "employee"]);

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Key an external identity exactly the way the parties source-identity index
 * does: `custom.source = { system, externalId }`. The unique index behind
 * this lookup is the same one the party drawer writes, so an API upsert and
 * a drawer edit can never fork one customer into two rows.
 */
export async function upsertApplicationCustomer(
  context: ApplicationContext,
  input: CustomerUpsertInput,
): Promise<{ id: string; created: boolean }> {
  assertApplicationPermission(context, "parties.manage");
  const orgId = context.authz.user.orgId;
  const actorId = context.authz.user.id;

  if (input.id !== undefined) {
    if (!isUuid(input.id)) throw invalidInput("id must be a UUID");
    const row = (await db.execute<{ id: string }>(sql`
      select id from parties where id = ${input.id} and org_id = ${orgId}`)).rows[0];
    if (!row) throw invalidInput(`customer "${input.id}" not found in this organization`);
    await ensurePartyRoleRow(db, { orgId, partyId: row.id, kind: "customer", actorId });
    return { id: row.id, created: false };
  }

  const ref = text(input.externalRef);
  const source = text(input.externalSource);
  if ((input.externalRef !== undefined || input.externalSource !== undefined) && (!ref || !source)) {
    throw invalidInput(
      "externalRef and externalSource travel together — send both or omit both",
    );
  }
  if (
    input.address !== undefined &&
    (typeof input.address !== "object" || input.address === null || Array.isArray(input.address))
  ) {
    throw invalidInput("address must be an object with line1, city, region, postalCode, and country fields");
  }
  const email = text(input.email);
  if (input.email !== undefined && input.email !== null && !email) {
    throw invalidInput("email must not be blank — send a real address or omit it");
  }
  if (email && !email.includes("@")) {
    throw invalidInput(`email "${email}" is not an email address — check the spelling and try again`);
  }
  const name = text(input.name);
  const kind = text(input.kind) ?? "company";
  if (!PARTY_KINDS.has(kind)) {
    throw invalidInput(`kind must be one of ${[...PARTY_KINDS].join(", ")}`);
  }

  // Strongest key first: the external identity is unique per org and source.
  if (ref && source) {
    const row = (await db.execute<{ id: string }>(sql`
      select id from parties
       where org_id = ${orgId}
         and custom->'source'->>'system' = ${source}
         and custom->'source'->>'externalId' = ${ref}
       limit 1`)).rows[0];
    if (row) {
      await updateUpsertedParty(orgId, actorId, row.id, {
        ...(input.email !== undefined ? { email } : {}),
        ...(input.name !== undefined ? { name } : {}),
        ...(input.phone !== undefined ? { phone: text(input.phone) } : {}),
        address: input.address,
      });
      return { id: row.id, created: false };
    }
  }
  if (email) {
    const rows = (await db.execute<{ id: string }>(sql`
      select id from parties
       where org_id = ${orgId} and lower(email) = lower(${email})
       order by id limit 3`)).rows;
    if (rows.length > 1) {
      throw conflict(
        `email "${email}" matches ${rows.length} parties — match by externalRef instead, or merge the duplicates in the customers list`,
      );
    }
    const row = rows[0];
    if (row) {
      await updateUpsertedParty(orgId, actorId, row.id, {
        ...(input.name !== undefined ? { name } : {}),
        ...(input.phone !== undefined ? { phone: text(input.phone) } : {}),
        address: input.address,
        source: ref && source ? { system: source, externalId: ref } : undefined,
      });
      return { id: row.id, created: false };
    }
  }
  // Weakest key last: a bare name may only resolve when it is unambiguous.
  if (name && !ref && !email) {
    const rows = (await db.execute<{ id: string }>(sql`
      select id from parties
       where org_id = ${orgId} and display_name = ${name}
       order by id limit 3`)).rows;
    if (rows.length > 1) {
      throw conflict(
        `"${name}" matches ${rows.length} parties — match by email or externalRef instead, or merge the duplicates in the customers list`,
      );
    }
    const row = rows[0];
    if (row) {
      await updateUpsertedParty(orgId, actorId, row.id, {
        phone: input.phone ?? undefined,
        address: input.address,
      });
      return { id: row.id, created: false };
    }
  }
  if (!name) {
    throw invalidInput(
      "no customer matched — send a name to create one, or match by id, email, or externalRef",
    );
  }
  let insertedId: string | null = null;
  try {
    const inserted = (await db.execute<{ id: string }>(sql`
      insert into parties (org_id, kind, display_name, email, phone, is_active, custom, created_by, updated_by)
      values (${orgId}, ${kind}, ${name}, ${email}, ${text(input.phone) ?? null}, true,
              ${ref && source ? JSON.stringify({ source: { system: source, externalId: ref } }) : "{}"}::jsonb,
              ${actorId}, ${actorId})
      returning id`)).rows[0];
    // A write that matches zero rows is a failure, not a success.
    insertedId = inserted?.id ?? null;
  } catch (error) {
    // A concurrent import claimed the same external identity between the
    // lookup and this insert: name the winner instead of a bare violation.
    let cursor: unknown = error;
    for (let depth = 0; depth < 4 && cursor !== null && typeof cursor === "object"; depth++) {
      const node = cursor as { code?: unknown; constraint?: unknown };
      if (node.code === "23505" && node.constraint === "parties_org_source_identity" && ref && source) {
        const winner = (await db.execute<{ id: string }>(sql`
          select id from parties
           where org_id = ${orgId}
             and custom->'source'->>'system' = ${source}
             and custom->'source'->>'externalId' = ${ref}
           limit 1`)).rows[0];
        throw conflict(
          winner
            ? `externalRef "${ref}" from "${source}" was just claimed by another customer — match that customer by id instead`
            : `externalRef "${ref}" from "${source}" is already in use — match by id instead`,
          winner ? { existingId: winner.id } : undefined,
        );
      }
      cursor = (cursor as { cause?: unknown }).cause;
    }
    throw error;
  }
  if (!insertedId) throw invalidInput("the customer could not be created — try again");
  const inserted = { id: insertedId };
  await ensurePartyRoleRow(db, { orgId, partyId: inserted.id, kind: "customer", actorId });
  if (input.address) await upsertDefaultBillingAddress(orgId, actorId, inserted.id, input.address);
  return { id: inserted.id, created: true };
}

async function updateUpsertedParty(
  orgId: string,
  actorId: string,
  partyId: string,
  patch: {
    email?: string | null;
    name?: string | null;
    phone?: string | null;
    address?: CustomerUpsertAddress;
    source?: { system: string; externalId: string };
  },
): Promise<void> {
  // Attaching an external identity the index already gives to another party
  // would die as a bare unique violation: refuse naming the collision.
  if (patch.source) {
    const holder = (await db.execute<{ id: string }>(sql`
      select id from parties
       where org_id = ${orgId}
         and custom->'source'->>'system' = ${patch.source.system}
         and custom->'source'->>'externalId' = ${patch.source.externalId}
         and id <> ${partyId}
       limit 1`)).rows[0];
    if (holder) {
      throw conflict(
        `externalRef "${patch.source.externalId}" from "${patch.source.system}" already belongs to another customer — match that customer by id instead`,
        { existingId: holder.id },
      );
    }
  }
  if (patch.email !== undefined || patch.name !== undefined || patch.phone !== undefined || patch.source !== undefined) {
    const updated = (await db.execute<{ id: string }>(sql`
      update parties set
        display_name = coalesce(${patch.name ?? null}, display_name),
        email = ${patch.email !== undefined ? patch.email : sql`email`},
        phone = ${patch.phone !== undefined ? (patch.phone ?? null) : sql`phone`},
        custom = ${patch.source ? sql`coalesce(custom, '{}'::jsonb) || ${JSON.stringify({ source: patch.source })}::jsonb` : sql`custom`},
        updated_at = now(), updated_by = ${actorId}
       where id = ${partyId} and org_id = ${orgId}
       returning id`)).rows[0];
    if (!updated) throw invalidInput("the customer could not be updated — try again");
  }
  await ensurePartyRoleRow(db, { orgId, partyId, kind: "customer", actorId });
  if (patch.address) await upsertDefaultBillingAddress(orgId, actorId, partyId, patch.address);
}

/**
 * The upsert's single address is the billing default: an existing default is
 * revised in place so repeated imports never stack duplicate rows, otherwise
 * one is created. A write that matches zero rows is a failure, not a success.
 */
async function upsertDefaultBillingAddress(
  orgId: string,
  actorId: string,
  partyId: string,
  address: CustomerUpsertAddress,
): Promise<void> {
  const line1 = text(address.line1);
  const line2 = text(address.line2);
  const city = text(address.city);
  const region = text(address.region);
  const postalCode = text(address.postalCode);
  const country = text(address.country)?.toUpperCase() ?? null;
  if (country && !/^[A-Z]{2}$/.test(country)) {
    throw invalidInput(`country "${address.country}" must be a two-letter code — send the ISO country and try again`);
  }
  const existing = (await db.execute<{ id: string }>(sql`
    select id from addresses
     where org_id = ${orgId} and party_id = ${partyId} and is_default_billing
     order by updated_at desc limit 1`)).rows[0];
  if (existing) {
    const updated = (await db.execute<{ id: string }>(sql`
      update addresses set
        line1 = coalesce(${line1}, line1), line2 = ${line2 !== undefined ? line2 : sql`line2`},
        city = coalesce(${city}, city), region = coalesce(${region}, region),
        postal_code = coalesce(${postalCode}, postal_code), country = coalesce(${country}, country),
        updated_at = now(), updated_by = ${actorId}
       where id = ${existing.id} and org_id = ${orgId}
       returning id`)).rows[0];
    if (!updated) throw invalidInput("the customer address could not be updated — try again");
    return;
  }
  const inserted = (await db.execute<{ id: string }>(sql`
    insert into addresses (org_id, party_id, line1, line2, city, region, postal_code, country,
                           is_default_billing, created_by, updated_by)
    values (${orgId}, ${partyId}, ${line1}, ${line2}, ${city}, ${region}, ${postalCode}, ${country},
            true, ${actorId}, ${actorId})
    returning id`)).rows[0];
  if (!inserted) throw invalidInput("the customer address could not be saved — try again");
}
