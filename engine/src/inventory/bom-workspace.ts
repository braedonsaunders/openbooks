import { sql } from "drizzle-orm";
import { db, withOrg } from "../platform/db.ts";
import { readBomPolicyVersion } from "./bom-policy.ts";

interface BomComponentRow {
  id: string;
  componentItemId: string;
  quantityPer: string;
  quantityBasis: "per_unit" | "per_batch" | "per_formula";
  formulaOutputQuantity: string;
  sortOrder: number;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  operationSeq: number | null;
  scrapPct: string | null;
  isByproduct: boolean;
  outputCostWeight: string | null;
  code: string | null;
  name: string | null;
  isActive: boolean | null;
  joinedId: string | null;
  isCurrent: boolean;
}

interface RoutingOperationRow {
  sequence: number;
  name: string;
  backflushAt: string;
}

export type BomWorkspaceResult =
  | { kind: "not_found" }
  | {
      kind: "empty";
      manufacturingEnabled: boolean;
      canProposeRevision: boolean;
      subsidiaries: Array<{ id: string; name: string }>;
      today: string;
    }
  | {
      kind: "loaded";
      manufacturingEnabled: boolean;
      assemblyItemId: string;
      itemKind: string;
      version: string | null;
      today: string;
      canProposeRevision: boolean;
      subsidiaries: Array<{ id: string; name: string }>;
      routingOperations: RoutingOperationRow[];
      components: Array<BomComponentRow>;
      validItems: Array<{ id: string; code: string | null; name: string | null }>;
    };

export async function loadBomWorkspace(input: {
  orgId: string;
  assemblyItemId: string | null;
  manufacturingEnabled: boolean;
  canProposeRevision: boolean;
  today: string;
}): Promise<BomWorkspaceResult> {
  return withOrg(input.orgId, async () => {
    const subsidiaries = input.canProposeRevision
      ? await db.execute<{ id: string; name: string }>(
          sql`
          select id, name from subsidiaries
           where org_id = ${input.orgId} and is_active and not is_elimination
           order by name, id
        `,
          "objects",
        )
      : [];

    if (!input.assemblyItemId) {
      return {
        kind: "empty",
        manufacturingEnabled: input.manufacturingEnabled,
        canProposeRevision: input.canProposeRevision,
        subsidiaries,
        today: input.today,
      };
    }

    const assembly = await db.execute<{ id: string; kind: string }>(
      sql`
      select id, kind from items
       where org_id = ${input.orgId} and id = ${input.assemblyItemId}
    `,
      "objects",
    );
    if (!assembly[0]) return { kind: "not_found" };

    const components = await db.execute<BomComponentRow>(
      sql`
      select line.id,
             line.component_item_id as "componentItemId",
             line.quantity_per::text as "quantityPer",
             line.quantity_basis as "quantityBasis",
             line.formula_output_quantity::text as "formulaOutputQuantity",
             line.sort_order as "sortOrder",
             line.effective_from::text as "effectiveFrom",
             line.effective_to::text as "effectiveTo",
             line.operation_seq as "operationSeq",
             line.scrap_pct::text as "scrapPct",
             line.is_byproduct as "isByproduct",
             line.output_cost_weight::text as "outputCostWeight",
             item.code,
             item.name,
             item.is_active as "isActive",
             item.id as "joinedId",
             ((line.effective_from is null or line.effective_from <= ${input.today}::date)
              and (line.effective_to is null or ${input.today}::date < line.effective_to)) as "isCurrent"
        from bom_components line
        left join items item on item.org_id = line.org_id and item.id = line.component_item_id
       where line.org_id = ${input.orgId} and line.assembly_item_id = ${input.assemblyItemId}
       order by line.sort_order, line.component_item_id, line.operation_seq nulls first,
                line.is_byproduct, line.effective_from nulls first, line.effective_to nulls first
    `,
      "objects",
    );
    const version = await readBomPolicyVersion(db, input.orgId, input.assemblyItemId);

    const routingOperations = input.manufacturingEnabled
      ? await db.execute<RoutingOperationRow>(
          sql`
          select operation.sequence, operation.name, operation.backflush_at as "backflushAt"
            from mfg_routing_operations operation
            join mfg_routings routing
              on routing.org_id = operation.org_id and routing.id = operation.routing_id
           where operation.org_id = ${input.orgId}
             and routing.produced_item_id = ${input.assemblyItemId}
             and routing.status = 'active'
             and routing.effective_from <= ${input.today}::date
             and (routing.effective_to is null or ${input.today}::date < routing.effective_to)
             and (select count(*) from mfg_routings candidate
                   where candidate.org_id = ${input.orgId}
                     and candidate.produced_item_id = ${input.assemblyItemId}
                     and candidate.status = 'active'
                     and candidate.effective_from <= ${input.today}::date
                     and (candidate.effective_to is null or ${input.today}::date < candidate.effective_to)) = 1
           order by operation.sequence
        `,
          "objects",
        )
      : [];

    const componentEligibility =
      assembly[0].kind === "kit"
        ? sql`and item.kind <> 'kit'
              and (item.kind not in ('inventory', 'assembly') or exists (
                select 1 from item_inventory_profiles profile
                 where profile.org_id = item.org_id and profile.item_id = item.id
              ))`
        : sql`and exists (
              select 1 from item_inventory_profiles profile
               where profile.org_id = item.org_id and profile.item_id = item.id
            )`;
    const validItems = await db.execute<{ id: string; code: string | null; name: string | null }>(
      sql`
      select item.id, item.code, item.name
        from items item
       where item.org_id = ${input.orgId} and item.is_active
         ${componentEligibility}
       order by item.code nulls last, item.name
    `,
      "objects",
    );

    return {
      kind: "loaded",
      manufacturingEnabled: input.manufacturingEnabled,
      assemblyItemId: input.assemblyItemId,
      itemKind: assembly[0].kind,
      version,
      today: input.today,
      canProposeRevision: input.canProposeRevision,
      subsidiaries,
      routingOperations,
      components: components.map((line) => ({
        ...line,
        operationSeq: input.manufacturingEnabled ? line.operationSeq : null,
        isByproduct: input.manufacturingEnabled ? line.isByproduct : false,
        outputCostWeight: input.manufacturingEnabled ? line.outputCostWeight : null,
      })),
      validItems,
    };
  });
}
