import "server-only";

import { column, link, page, ref, text, type PageSpec } from "@braedonsaunders/appkit-viewspec";
import { registeredListTable } from "../../../../lib/list/prepared-spec";
import type { GenealogyEdge } from "@openbooks/engine/manufacturing/genealogy";

export interface GenealogyRow extends GenealogyEdge {
  evidenceLabel: string;
  issuedLabel: string;
  receivedLabel: string;
  orderHref: string;
  componentLotHref: string | null;
  componentSerialHref: string | null;
  outputLotHref: string | null;
  outputSerialHref: string | null;
}

export interface GenealogyData {
  edges: GenealogyRow[];
  columns: {
    evidence: string;
    depth: string;
    order: string;
    component: string;
    componentLot: string;
    componentSerial: string;
    issued: string;
    output: string;
    outputLot: string;
    outputSerial: string;
    received: string;
  };
  emptyTitle: string;
  emptyDescription: string;
}

const f = ref<GenealogyData>();
const row = ref<GenealogyRow>();

export function genealogySpec(_data: GenealogyData): PageSpec {
  return page({
    layout: "bare",
    body: [
      registeredListTable("manufacturing_genealogy", {
        variant: "app",
        rows: f("edges"),
        rowKey: row("id"),
        empty: { title: f("emptyTitle"), description: f("emptyDescription") },
        columns: [
          column(f("columns.evidence"), text(row("evidenceLabel"))),
          column(f("columns.depth"), text(row("depth"))),
          column(f("columns.order"), link(row("orderNumber"), row("orderHref"))),
          column(f("columns.component"), text(row("componentItem"))),
          column(f("columns.componentLot"), link(row("componentLotNumber"), row("componentLotHref"))),
          column(f("columns.componentSerial"), link(row("componentSerialNumber"), row("componentSerialHref"))),
          column(f("columns.issued"), text(row("issuedLabel"))),
          column(f("columns.output"), text(row("outputItem"))),
          column(f("columns.outputLot"), link(row("outputLotNumber"), row("outputLotHref"))),
          column(f("columns.outputSerial"), link(row("outputSerialNumber"), row("outputSerialHref"))),
          column(f("columns.received"), text(row("receivedLabel"))),
        ],
      }),
    ],
  });
}
