import "server-only";

import { getTranslations } from "next-intl/server";
import {
  page,
  pageHeader,
  ref,
  widget,
  widgetBlock,
  type PageSpec,
} from "@braedonsaunders/appkit-viewspec";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { isUuid, pickString } from "../../../lib/list-params";
import { can, requirePermission } from "../../../lib/authz";
import { loadContract, revenueModificationOptions } from "./_lib";
import type { ContractDrawer } from "./ContractDrawer";
import type { RunRecognitionDrawer } from "./RunRecognitionDrawer";

/**
 * Revenue recognition (ASC 606), split into a loader and a spec.
 *
 * The list itself is the universal EntityListView, so the spec places a slot
 * instead of a table: the slot re-derives org/user/permissions from the
 * session. A spec that could name an org id is a cross-tenant read — the same
 * rule that put EntityListView behind `entity-list-view` when the accounts
 * and journal pages were converted. No capability travels through the spec.
 *
 * The header action (Run recognition) and the contract drawer are whole
 * components, not decomposed cells: the loader resolves the permission bit
 * and the drawer payload (with the org guard), and the widgets render them.
 * The drawer owns its per-obligation run buttons internally, exactly as on
 * the native path.
 *
 * Everything else here is loader work copied verbatim from page.tsx: the
 * permission gates and the ?contract= flyout resolution (uuid guard, org
 * guard via loadContract, drawerReturn scoping).
 */

type ContractDrawerProps = Parameters<typeof ContractDrawer>[0];
type RunRecognitionDrawerProps = Parameters<typeof RunRecognitionDrawer>[0];

export interface RevenueData {
  title: string;
  description: string;
  currentParams: Record<string, string | string[] | undefined>;
  canRun: boolean;
  drawerOpen: boolean;
  drawer: ContractDrawerProps | null;
  /** Scope controls for the Run recognition review drawer. */
  books: RunRecognitionDrawerProps["books"];
  periods: RunRecognitionDrawerProps["periods"];
  /** Obligations with unposted plan lines — what the scope picker offers. */
  candidates: RunRecognitionDrawerProps["candidates"];
}

export async function loadRevenue(
  sp: Record<string, string | string[] | undefined>,
): Promise<RevenueData> {
  const t = await getTranslations("revenue");

  const authz = await requirePermission("ar.read");
  const canRun = can(authz, "ar.post");
  const orgId = authz.user.orgId;

  const contractId = typeof sp.contract === "string" ? sp.contract : undefined;
  const openContract =
    contractId && isUuid(contractId)
      ? await loadContract(contractId, orgId, authz.allowedSubsidiaryIds)
      : null;
  const requestedReturn = pickString(sp.drawerReturn);

  const drawer: ContractDrawerProps | null = openContract
    ? {
        payload: openContract,
        modificationOptions: canRun
          ? await revenueModificationOptions(orgId, authz.allowedSubsidiaryIds)
          : undefined,
        canRun,
        closeHref: requestedReturn?.startsWith("/revenue")
          ? requestedReturn
          : "/revenue",
      }
    : null;

  // Scope options only matter to someone who can run recognition; a reader
  // gets no header action, so the queries stay unrun for them.
  const [books, periods, candidates] = canRun
    ? await Promise.all([
        db.execute<{ id: string; name: string; is_primary: boolean }>(sql`
          select id, name, is_primary from accounting_books
           where org_id = ${orgId} and is_active and posts_gl
           order by is_primary desc, code`),
        db.execute<{ id: string; name: string; starts_on: string; ends_on: string }>(sql`
          select id, name, starts_on::text as starts_on, ends_on::text as ends_on
            from accounting_periods
           where org_id = ${orgId} and not is_adjustment
           order by starts_on desc`),
        db.execute<{
          obligation_id: string;
          contract_id: string;
          contract_number: string;
          description: string;
        }>(sql`
          select distinct o.id as obligation_id, c.id as contract_id,
                 c.contract_number, o.description
            from performance_obligations o
            join revenue_contracts c on c.id = o.contract_id and c.org_id = o.org_id
            join recognition_schedules s on s.obligation_id = o.id and s.org_id = o.org_id
            join recognition_schedule_lines l on l.schedule_id = s.id and l.org_id = s.org_id
           where o.org_id = ${orgId} and o.status <> 'cancelled'
             and l.journal_entry_id is null and l.superseded_by_change_id is null
           order by c.contract_number, o.description`),
      ])
    : [{ rows: [] }, { rows: [] }, { rows: [] }];

  return {
    title: t("list.title"),
    description: t("list.description"),
    currentParams: sp,
    canRun,
    drawerOpen: Boolean(drawer),
    drawer,
    books: books.rows.map((row) => ({
      id: String(row.id),
      name: row.name,
      is_primary: row.is_primary,
    })),
    periods: periods.rows.map((row) => ({
      id: String(row.id),
      name: row.name,
      startsOn: row.starts_on,
      endsOn: row.ends_on,
    })),
    candidates: candidates.rows.map((row) => ({
      obligationId: String(row.obligation_id),
      contractId: String(row.contract_id),
      contractNumber: row.contract_number,
      description: row.description,
    })),
  };
}

const f = ref<RevenueData>();

export function revenueSpec(data: RevenueData): PageSpec {
  const runRecognition = {
    widget: "run-recognition",
    props: { books: data.books, periods: data.periods, candidates: data.candidates },
  };
  return page({
    route: '/revenue',
    layout: "list",
    header: [
      pageHeader({
        title: f("title"),
        description: f("description"),
        actions: [
          widget(runRecognition.widget, runRecognition.props, f("canRun")),
        ],
      }),
    ],
    body: [
      // The universal entity list, placed through a slot: it needs an org id,
      // a user id and a permission decision, none of which may travel through
      // a spec. The spec supplies only the record type and the URL it was
      // already rendering with. The native page passes no emptyAction, so
      // neither does the spec — the list's generic empty state renders.
      widgetBlock("entity-list-view", {
        recordType: "revenue_contract",
        sp: data.currentParams,
        drawer: data.drawer
          ? { widget: "contract-drawer", props: { drawer: data.drawer } }
          : null,
      }),
    ],
  });
}
