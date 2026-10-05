import { sql } from "drizzle-orm";
import {
  EXTERNAL_LINK_NATIVE_TABLES,
  EXTERNAL_LINK_OBJECT_TYPES,
  EXTERNAL_LINK_PROVIDERS,
} from "@openbooks/schema";
import { CommerceError, pgCause } from "./errors.ts";
import {
  acquireOrgFeatureGateLock,
  lockAndCheckOrgFeature,
} from "../organization/org-feature-lock.ts";
import { db, withOrg } from "../platform/db.ts";

export type ExternalLinkFeature = "salesChannels" | "usageBilling";

export interface ExternalLinkInput {
  channelId?: string | null;
  provider: string;
  externalAccount: string;
  objectType: string;
  externalId: string;
  externalParentId?: string | null;
  nativeTable: string;
  nativeId: string;
}

export interface ExternalLinkRow {
  id: string;
  channelId: string | null;
  provider: string;
  externalAccount: string;
  objectType: string;
  externalId: string;
  externalParentId: string | null;
  nativeTable: string;
  nativeId: string;
  externalUpdatedAt: string | null;
  lastSyncedAt: string | null;
}

function refuse(code: string, message: string, remedy: string, field: string | null = null, status: 422 | 409 = 422): never {
  throw new CommerceError(code, message, remedy, { field, status });
}

function cleanText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function checkEnum(value: string, allowed: readonly string[], label: string, field: string): void {
  if (!allowed.includes(value)) {
    refuse(
      `external_link_${field}_unknown`,
      `External link ${label} "${value}" is not a known ${label}.`,
      `Choose one of ${allowed.join(", ")}.`,
      field,
    );
  }
}

interface LinkDbRow extends Record<string, unknown> {
  id: string;
  channel_id: string | null;
  provider: string;
  external_account: string;
  object_type: string;
  external_id: string;
  external_parent_id: string | null;
  native_table: string;
  native_id: string;
  external_updated_at: string | null;
  last_synced_at: string | null;
}

function toRow(row: LinkDbRow): ExternalLinkRow {
  return {
    id: row.id,
    channelId: row.channel_id,
    provider: row.provider,
    externalAccount: row.external_account,
    objectType: row.object_type,
    externalId: row.external_id,
    externalParentId: row.external_parent_id,
    nativeTable: row.native_table,
    nativeId: row.native_id,
    externalUpdatedAt: row.external_updated_at,
    lastSyncedAt: row.last_synced_at,
  };
}

const LINK_COLUMNS = sql`id, channel_id, provider, external_account, object_type, external_id, external_parent_id, native_table, native_id, external_updated_at, last_synced_at`;

function featureRemedy(feature: ExternalLinkFeature): string {
  return feature === "salesChannels"
    ? "Enable Sales Channels in Company Settings → Features."
    : "Enable Usage Billing in Company Settings → Features.";
}

async function requireFeature(orgId: string, feature: ExternalLinkFeature): Promise<void> {
  if (!(await lockAndCheckOrgFeature(db, orgId, feature))) {
    refuse(
      "feature_off",
      feature === "salesChannels"
        ? "Sales Channels is turned off for this organization."
        : "Usage billing is turned off for this organization.",
      featureRemedy(feature),
    );
  }
}

/**
 * Record one external identity. Either unique side colliding refuses by name,
 * identifying both records: the operator decides which mapping is correct
 * instead of the engine silently keeping the first or the last.
 */
export async function linkExternal(
  orgId: string,
  actor: string | null,
  input: ExternalLinkInput,
  feature: ExternalLinkFeature,
): Promise<ExternalLinkRow> {
  const provider = cleanText(input.provider) ?? "";
  checkEnum(provider, EXTERNAL_LINK_PROVIDERS, "provider", "provider");
  const externalAccount = cleanText(input.externalAccount);
  if (!externalAccount) refuse("external_link_account_missing", "An external link needs its provider account.", "Enter the shop domain or provider account that owns the external object.", "externalAccount");
  const objectType = cleanText(input.objectType) ?? "";
  checkEnum(objectType, EXTERNAL_LINK_OBJECT_TYPES, "object type", "objectType");
  const externalId = cleanText(input.externalId);
  if (!externalId) refuse("external_link_id_missing", "An external link needs its external id.", "Enter the provider's id for the object.", "externalId");
  const nativeTable = cleanText(input.nativeTable) ?? "";
  checkEnum(nativeTable, EXTERNAL_LINK_NATIVE_TABLES, "native table", "nativeTable");
  if (!cleanText(input.nativeId)) refuse("external_link_native_missing", "An external link needs its native record.", "Choose the OpenBooks record the external object maps to.", "nativeId");
  const nativeId = input.nativeId.trim();

  return withOrg(orgId, async () => {
    await acquireOrgFeatureGateLock(db, orgId);
    await requireFeature(orgId, feature);
    if (provider === "stripe" && input.channelId) {
      refuse(
        "external_link_channel_unexpected",
        "Stripe links are platform identities and carry no channel.",
        "Link the Stripe object without a channel; channel-scoped links use the channel's provider.",
        "channelId",
      );
    }
    if (provider !== "stripe" && !input.channelId) {
      refuse(
        "external_link_channel_missing",
        `A ${provider} link belongs to a channel.`,
        "Link the object through its sales channel so the identity resolves to one storefront.",
        "channelId",
      );
    }
    if (input.channelId) {
      const channel = (await db.execute<{ id: string; kind: string }>(sql`
        select id, kind from sales_channels where org_id = ${orgId} and id = ${input.channelId}`)).rows[0];
      if (!channel) {
        refuse(
          "channel_not_found",
          "The sales channel does not belong to this organization.",
          "Choose a channel in this organization, or connect it first under Channels.",
          "channelId",
        );
      }
      if (channel.kind !== provider) {
        refuse(
          "external_link_provider_mismatch",
          `Channel ${input.channelId} is a ${channel.kind} channel, not ${provider}.`,
          `Link the ${provider} object through a ${provider} channel, or correct the provider.`,
          "provider",
        );
      }
    }
    // The link target must exist: a link to a deleted record would resolve
    // forever to nothing. The table name is an enum-validated identifier
    // above, never raw input, so the fragment cannot escape its quotes;
    // org and record travel as bound parameters.
    const target = (await db.execute<{ id: string }>(sql`
      select id from ${sql.raw(`"${nativeTable}"`)}
       where org_id = ${orgId} and id = ${nativeId}`)).rows[0];
    if (!target) {
      refuse(
        "external_link_target_missing",
        `The ${nativeTable} record ${nativeId} does not belong to this organization.`,
        "Choose an existing record in this organization for the link target.",
        "nativeId",
      );
    }
    const existing = (await db.execute<LinkDbRow>(sql`
      select ${LINK_COLUMNS} from external_links
       where org_id = ${orgId} and provider = ${provider}
         and external_account = ${externalAccount} and object_type = ${objectType}
         and external_id = ${externalId}`)).rows[0];
    if (existing) {
      if (existing.native_id !== nativeId || existing.native_table !== nativeTable) {
        refuse(
          "external_link_conflict",
          `${provider} ${objectType} "${externalId}" (account ${externalAccount}) is already linked to ${existing.native_table} ${existing.native_id}.`,
          "Review the existing link before changing the mapping; unlink it first if the new target is correct.",
          "externalId",
          409,
        );
      }
      return toRow(existing);
    }
    // Name the record already holding the target before inserting: the
    // operator decides which mapping is correct instead of guessing from
    // "another". The insert below still arbitrates the concurrent race.
    const holder = (await db.execute<{ external_id: string }>(sql`
      select external_id from external_links
       where org_id = ${orgId} and provider = ${provider}
         and external_account = ${externalAccount} and object_type = ${objectType}
         and native_table = ${nativeTable} and native_id = ${nativeId}`)).rows[0];
    if (holder && holder.external_id !== externalId) {
      refuse(
        "external_link_target_in_use",
        `${nativeTable} ${nativeId} is already linked to ${provider} ${objectType} "${holder.external_id}" in account ${externalAccount}.`,
        "Review the existing link and choose the correct record; one native record carries one external identity per account.",
        "nativeId",
        409,
      );
    }
    let id: string;
    try {
      // A retry for the same external object is an expected unique-key collision; re-read below to verify its target.
      const inserted = await db.execute<{ id: string }>(sql`
        insert into external_links
          (org_id, channel_id, provider, external_account, object_type, external_id,
           external_parent_id, native_table, native_id, last_synced_at, created_by, updated_by)
        values (${orgId}, ${input.channelId ?? null}, ${provider}, ${externalAccount},
          ${objectType}, ${externalId}, ${cleanText(input.externalParentId) ?? null},
          ${nativeTable}, ${nativeId}, now(), ${actor}, ${actor})
        on conflict (org_id, provider, external_account, object_type, external_id) do nothing
        returning id`);
      if (inserted.rows.length === 1) {
        id = inserted.rows[0]!.id;
      } else if (inserted.rows.length === 0) {
        id = "";
      } else {
        throw new Error("External link insert returned an unexpected row count");
      }
    } catch (error) {
      if (error instanceof CommerceError) throw error;
      const candidate = pgCause(error);
      if (candidate.code !== "23505" || candidate.constraint !== "external_links_native_unique") throw error;
      // A concurrent writer won the race after the pre-check above; the
      // transaction is aborted, so no further read is possible here — the
      // pre-check names the holder on the retry the operator runs next.
      refuse(
        "external_link_target_in_use",
        `${nativeTable} ${nativeId} is already linked to another ${provider} ${objectType} in account ${externalAccount}.`,
        "Review the existing link and choose the correct record; one native record carries one external identity per account.",
        "nativeId",
        409,
      );
    }
    if (!id) {
      const raced = (await db.execute<LinkDbRow>(sql`
        select ${LINK_COLUMNS} from external_links
         where org_id = ${orgId} and provider = ${provider}
           and external_account = ${externalAccount} and object_type = ${objectType}
           and external_id = ${externalId}`)).rows[0];
      if (!raced || raced.native_id !== nativeId || raced.native_table !== nativeTable) {
        refuse(
          "external_link_conflict",
          raced
            ? `${provider} ${objectType} "${externalId}" (account ${externalAccount}) was linked concurrently to ${raced.native_table} ${raced.native_id}.`
            : `${provider} ${objectType} "${externalId}" (account ${externalAccount}) was linked concurrently to a different record.`,
          "Review the existing link before retrying.",
          "externalId",
          409,
        );
      }
      return toRow(raced);
    }
    const row = (await db.execute<LinkDbRow>(sql`
      select ${LINK_COLUMNS} from external_links where org_id = ${orgId} and id = ${id}`)).rows[0]!;
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'external_links', ${id}, 'insert',
        ${JSON.stringify({ before: null, after: toRow(row), reason: null })}::jsonb, ${actor})`);
    return toRow(row);
  });
}

/** Resolve an external identity to its native record, or null when unlinked. */
export async function findNative(
  orgId: string,
  key: { provider: string; externalAccount: string; objectType: string; externalId: string },
): Promise<{ nativeTable: string; nativeId: string } | null> {
  const row = (await db.execute<{ native_table: string; native_id: string }>(sql`
    select native_table, native_id from external_links
     where org_id = ${orgId} and provider = ${key.provider}
       and external_account = ${key.externalAccount} and object_type = ${key.objectType}
       and external_id = ${key.externalId}`)).rows[0];
  return row ? { nativeTable: row.native_table, nativeId: row.native_id } : null;
}

/** Resolve a native record to its external identity, or null when unlinked. */
export async function findExternal(
  orgId: string,
  key: { provider: string; externalAccount: string; objectType: string; nativeTable: string; nativeId: string },
): Promise<ExternalLinkRow | null> {
  const row = (await db.execute<LinkDbRow>(sql`
    select ${LINK_COLUMNS} from external_links
     where org_id = ${orgId} and provider = ${key.provider}
       and external_account = ${key.externalAccount} and object_type = ${key.objectType}
       and native_table = ${key.nativeTable} and native_id = ${key.nativeId}`)).rows[0];
  return row ? toRow(row) : null;
}

/** List every link for one provider account and object type, ordered by external id. */
export async function listExternalLinks(
  orgId: string,
  key: { provider: string; externalAccount: string; objectType: string },
): Promise<Array<{ externalId: string; nativeTable: string; nativeId: string }>> {
  const rows = (await db.execute<{ external_id: string; native_table: string; native_id: string }>(sql`
    select external_id, native_table, native_id from external_links
     where org_id = ${orgId} and provider = ${key.provider}
       and external_account = ${key.externalAccount} and object_type = ${key.objectType}
     order by external_id`)).rows;
  return rows.map((row) => ({ externalId: row.external_id, nativeTable: row.native_table, nativeId: row.native_id }));
}

/** Bulk-resolve external ids to native records in one query. */
export async function bulkFindNative(
  orgId: string,
  provider: string,
  externalAccount: string,
  objectType: string,
  externalIds: string[],
): Promise<Map<string, { nativeTable: string; nativeId: string }>> {
  const out = new Map<string, { nativeTable: string; nativeId: string }>();
  if (externalIds.length === 0) return out;
  const rows = (await db.execute<{ external_id: string; native_table: string; native_id: string }>(sql`
    select external_id, native_table, native_id from external_links
     where org_id = ${orgId} and provider = ${provider}
       and external_account = ${externalAccount} and object_type = ${objectType}
       and external_id in (${sql.join(externalIds.map((id) => sql`${id}`), sql`, `)})`)).rows;
  for (const row of rows) out.set(row.external_id, { nativeTable: row.native_table, nativeId: row.native_id });
  return out;
}

/** Remove an external identity. The native record stays; only the mapping goes, with audit evidence. */
export async function unlinkExternal(
  orgId: string,
  actor: string | null,
  key: { provider: string; externalAccount: string; objectType: string; externalId: string },
  reason: unknown,
  feature: ExternalLinkFeature,
): Promise<void> {
  const why = typeof reason === "string" && reason.trim() !== "" ? reason.trim() : null;
  if (!why) {
    refuse(
      "external_link_reason_missing",
      "A reason is required to unlink an external identity.",
      "Explain why the mapping is wrong so the audit record says what happened.",
      "reason",
    );
  }
  await withOrg(orgId, async () => {
    await acquireOrgFeatureGateLock(db, orgId);
    await requireFeature(orgId, feature);
    const deleted = await db.execute<LinkDbRow>(sql`
      delete from external_links
       where org_id = ${orgId} and provider = ${key.provider}
         and external_account = ${key.externalAccount} and object_type = ${key.objectType}
         and external_id = ${key.externalId}
       returning ${LINK_COLUMNS}`);
    if (deleted.rowCount !== 1 || deleted.rows.length !== 1) {
      refuse(
        "external_link_not_found",
        `${key.provider} ${key.objectType} "${key.externalId}" (account ${key.externalAccount}) has no link in this organization.`,
        "Nothing was unlinked; refresh the list and check the external id.",
        "externalId",
      );
    }
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'external_links', ${deleted.rows[0]!.id}, 'delete',
        ${JSON.stringify({ before: toRow(deleted.rows[0]!), after: null, reason: why })}::jsonb, ${actor})`);
  });
}
