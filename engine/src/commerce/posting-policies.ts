import { sql } from "drizzle-orm";
import { CommerceError } from "./errors.ts";
import {
  acquireOrgFeatureGateLock,
  lockAndCheckOrgFeature,
} from "../organization/org-feature-lock.ts";
import { db, withOrg } from "../platform/db.ts";
import { isIsoCalendarDate } from "../platform/civil-date.ts";

const FEATURE_REMEDY = "Enable Sales Channels in Company Settings → Features.";

export type ChannelPostingMode = "per_order" | "daily_summary";

export interface ChannelPostingPolicy {
  id: string;
  channelId: string;
  mode: ChannelPostingMode;
  unpaidCreatesSalesOrder: boolean;
  guestCustomerPartyId: string | null;
  createPromotionOnMatchMiss: boolean;
  cutoffTz: string;
  excludedTags: string[];
  excludedSources: string[];
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface SetPostingPolicyInput {
  channelId: string;
  mode: string;
  unpaidCreatesSalesOrder?: boolean;
  guestCustomerPartyId?: string | null;
  createPromotionOnMatchMiss?: boolean;
  cutoffTz?: string;
  excludedTags?: string[];
  excludedSources?: string[];
  effectiveFrom: string;
}

function refuse(code: string, message: string, remedy: string, field: string | null = null, status: 422 | 409 = 422): never {
  throw new CommerceError(code, message, remedy, { field, status });
}

function cleanText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function checkMode(mode: string): ChannelPostingMode {
  if (mode === "per_order" || mode === "daily_summary") return mode;
  refuse(
    "channel_policy_mode_unknown",
    `Posting mode "${mode}" is not a channel posting mode.`,
    "Choose per-order posting or daily-summary posting for the channel.",
    "mode",
  );
}

type PolicyDbRow = Record<string, unknown> & {
  id: string;
  channel_id: string;
  mode: ChannelPostingMode;
  unpaid_creates_sales_order: boolean;
  guest_customer_party_id: string | null;
  create_promotion_on_match_miss: boolean;
  cutoff_tz: string;
  excluded_tags: string[];
  excluded_sources: string[];
  effective_from: string;
  effective_to: string | null;
};

function toPolicy(row: PolicyDbRow): ChannelPostingPolicy {
  return {
    id: row.id,
    channelId: row.channel_id,
    mode: row.mode,
    unpaidCreatesSalesOrder: row.unpaid_creates_sales_order,
    guestCustomerPartyId: row.guest_customer_party_id,
    cutoffTz: row.cutoff_tz,
    createPromotionOnMatchMiss: row.create_promotion_on_match_miss,
    excludedTags: row.excluded_tags ?? [],
    excludedSources: row.excluded_sources ?? [],
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
  };
}

const POLICY_COLUMNS = sql`id, channel_id, mode, unpaid_creates_sales_order, guest_customer_party_id, create_promotion_on_match_miss, cutoff_tz, excluded_tags, excluded_sources, effective_from, effective_to`;

function checkEffectiveDate(value: string): void {
  if (!isIsoCalendarDate(value)) {
    refuse(
      "channel_policy_date_invalid",
      `Effective date "${value}" is not a calendar date.`,
      "Enter the effective date as YYYY-MM-DD.",
      "effectiveFrom",
    );
  }
}

function checkTimezone(value: string): string {
  // Postgres validates the zone name on write below, so a typo refuses at
  // configuration time instead of breaking the summary cut-off later.
  return cleanText(value) ?? "UTC";
}

/** Serialize validated tags as a Postgres array literal (drizzle cannot bind a JS array to a text[] cast). */
function toTextArrayLiteral(values: string[]): string {
  return `{${values.map((value) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`;
}

/**
 * The posting policy in force for a channel on a date. Orders posted under
 * an earlier policy keep their documents: the policy date on the order
 * decides, so a mode switch never reinterprets posted history. A channel
 * with no policy refuses by name — posting without a chosen mode would
 * invent the merchant's granularity.
 */
export async function getPostingPolicy(
  orgId: string,
  channelId: string,
  date: string,
): Promise<ChannelPostingPolicy> {
  checkEffectiveDate(date);
  const row = (await db.execute<PolicyDbRow>(sql`
    select ${POLICY_COLUMNS} from sales_channel_posting_policies
     where org_id = ${orgId} and channel_id = ${channelId}
       and effective_from <= ${date}
       and (effective_to is null or effective_to >= ${date})`)).rows[0];
  if (!row) {
    const channel = (await db.execute<{ name: string }>(sql`
      select name from sales_channels where org_id = ${orgId} and id = ${channelId}`)).rows[0];
    refuse(
      "channel_policy_missing",
      channel
        ? `Channel "${channel.name}" has no posting policy in force on ${date}.`
        : `Channel ${channelId} has no posting policy in force on ${date}.`,
      "Choose the channel's posting mode under Channels → Settings → Posting, effective on or before the order date.",
      "mode",
    );
  }
  return toPolicy(row);
}

/**
 * Set the posting policy from a date, closing the prior open row the day
 * before. Same serialization as the account maps: the open row is locked
 * before it is closed, and the EXCLUDE constraint arbitrates the race.
 */
export async function setPostingPolicy(
  orgId: string,
  actor: string,
  input: SetPostingPolicyInput,
): Promise<ChannelPostingPolicy> {
  const mode = checkMode(input.mode);
  checkEffectiveDate(input.effectiveFrom);
  const cutoffTz = checkTimezone(input.cutoffTz ?? "UTC");
  const excludedTags = (input.excludedTags ?? []).map((tag) => tag.trim()).filter((tag) => tag !== "");
  const excludedSources = (input.excludedSources ?? []).map((source) => source.trim()).filter((source) => source !== "");
  return withOrg(orgId, async () => {
    await acquireOrgFeatureGateLock(db, orgId);
    if (!(await lockAndCheckOrgFeature(db, orgId, "salesChannels"))) {
      refuse("feature_off", "Sales Channels is turned off for this organization.", FEATURE_REMEDY);
    }
    const channel = (await db.execute<{ id: string }>(sql`
      select id from sales_channels where org_id = ${orgId} and id = ${input.channelId}`)).rows[0];
    if (!channel) {
      refuse(
        "channel_not_found",
        "The sales channel does not belong to this organization.",
        "Choose a channel in this organization, or connect it first under Channels.",
        "channelId",
      );
    }
    if (input.guestCustomerPartyId) {
      const guest = (await db.execute<{ id: string }>(sql`
        select id from parties
         where org_id = ${orgId} and id = ${input.guestCustomerPartyId} and kind = 'customer' and is_active`)).rows[0];
      if (!guest) {
        refuse(
          "channel_policy_guest_unavailable",
          "The walk-in customer does not belong to this organization, or is not an active customer.",
          "Choose an active customer party to post guest orders against, or leave it blank to create customers per order.",
          "guestCustomerPartyId",
        );
      }
    }
    // Postgres is the authority on zone names: an unknown zone refuses here
    // with its own message instead of breaking the summary cut-off later.
    try {
      await db.execute(sql`select (now() at time zone ${cutoffTz})`);
    } catch {
      refuse(
        "channel_policy_timezone_unknown",
        `Cut-off time zone "${cutoffTz}" is not a known time zone.`,
        "Enter an IANA time zone name, for example America/Toronto.",
        "cutoffTz",
      );
    }
    const open = (await db.execute<PolicyDbRow>(sql`
      select ${POLICY_COLUMNS} from sales_channel_posting_policies
       where org_id = ${orgId} and channel_id = ${input.channelId}
         and effective_to is null
       for update`)).rows;
    if (open.length > 1) {
      throw new Error(
        `Overlapping open posting policies for channel ${input.channelId}; storage must hold exactly one open row`,
      );
    }
    const prior = open[0];
    if (prior) {
      if (input.effectiveFrom <= prior.effective_from) {
        refuse(
          "channel_policy_effective_before_open",
          `The new policy takes effect ${input.effectiveFrom}, at or before the open row's ${prior.effective_from}.`,
          "Choose an effective date after the open row starts, or close the open row first.",
          "effectiveFrom",
        );
      }
      const closed = await db.execute(sql`
        update sales_channel_posting_policies
           set effective_to = (${input.effectiveFrom}::date - interval '1 day')::date,
               updated_by = ${actor}, updated_at = now()
         where org_id = ${orgId} and id = ${prior.id}`);
      if (closed.rowCount !== 1) {
        throw new Error("Posting policy close matched no row; the policy left while it was locked");
      }
      await db.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${orgId}, 'sales_channel_posting_policies', ${prior.id}, 'update',
          ${JSON.stringify({ before: toPolicy(prior), after: { ...toPolicy(prior), effectiveTo: input.effectiveFrom }, reason: "Superseded by a new effective-dated policy" })}::jsonb, ${actor})`);
    }
    let id: string;
    try {
      const inserted = await db.execute<{ id: string }>(sql`
        insert into sales_channel_posting_policies
          (org_id, channel_id, mode, unpaid_creates_sales_order, guest_customer_party_id,
           create_promotion_on_match_miss, cutoff_tz, excluded_tags, excluded_sources,
           effective_from, created_by, updated_by)
        values (${orgId}, ${input.channelId}, ${mode}, ${input.unpaidCreatesSalesOrder ?? false},
          ${input.guestCustomerPartyId ?? null}, ${input.createPromotionOnMatchMiss ?? false},
          ${cutoffTz}, ${toTextArrayLiteral(excludedTags)}::text[], ${toTextArrayLiteral(excludedSources)}::text[],
          ${input.effectiveFrom}, ${actor}, ${actor})
        returning id`);
      if (inserted.rows.length !== 1) throw new Error("Posting policy insert returned an unexpected row count");
      id = inserted.rows[0]!.id;
    } catch (error) {
      if (error instanceof CommerceError) throw error;
      const candidate = error as { code?: unknown; constraint?: unknown };
      const cause = (candidate as { cause?: unknown }).cause as { code?: unknown; constraint?: unknown } | undefined;
      if (
        candidate.code === "23P01" ||
        candidate.constraint === "sales_channel_posting_policies_no_overlap" ||
        cause?.code === "23P01"
      ) {
        refuse(
          "channel_policy_overlaps",
          "The new posting policy overlaps an existing window for this channel.",
          "Close the overlapping window first, or choose an effective date outside it.",
          "effectiveFrom",
          409,
        );
      }
      throw error;
    }
    const row = (await db.execute<PolicyDbRow>(sql`
      select ${POLICY_COLUMNS} from sales_channel_posting_policies
       where org_id = ${orgId} and id = ${id}`)).rows[0]!;
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'sales_channel_posting_policies', ${id}, 'insert',
        ${JSON.stringify({ before: null, after: toPolicy(row), reason: null })}::jsonb, ${actor})`);
    return toPolicy(row);
  });
}

/** Every policy window for a channel, oldest first, for the Settings history. */
export async function listPostingPolicies(orgId: string, channelId: string): Promise<ChannelPostingPolicy[]> {
  const rows = (await db.execute<PolicyDbRow>(sql`
    select ${POLICY_COLUMNS} from sales_channel_posting_policies
     where org_id = ${orgId} and channel_id = ${channelId}
     order by effective_from`)).rows;
  return rows.map(toPolicy);
}
