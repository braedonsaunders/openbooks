import { sql } from "drizzle-orm";
import { subsidiaryVisibleFilter } from "../organization/subsidiary-scope.ts";
import { db, withOrgContext } from "../platform/db.ts";

export interface ChannelStockLocationOption {
  value: string;
  label: string;
}

/**
 * Active stock locations a channel may map, labelled with the location name.
 * A location is offered only when it is org-wide or belongs to the channel's
 * legal entity, and only when the caller can see that subsidiary.
 */
export function listChannelStockLocationOptions(
  orgId: string,
  channelId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<ChannelStockLocationOption[]> {
  return withOrgContext(orgId, () =>
    db.execute<ChannelStockLocationOption>(
      sql`
      select sl.id as value, concat_ws(' ', nullif(l.name, ''), concat('(', sl.code, ')')) as label
        from stock_locations sl
        join locations l on l.org_id = sl.org_id and l.id = sl.location_id
        join sales_channels c on c.org_id = sl.org_id and c.id = ${channelId}
       where sl.org_id = ${orgId} and sl.is_active
         and (l.subsidiary_id is null or l.subsidiary_id = c.subsidiary_id)
         ${subsidiaryVisibleFilter(sql`l.subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })}
       order by l.name, sl.code limit 2000`,
      "objects",
    ),
  );
}
