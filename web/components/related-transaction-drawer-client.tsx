"use client";

import { DocumentDrawer } from "./document-drawer";
import { CreditApplicationsPanel } from "./credit-applications-panel";
import type { CreditApplicationsDrawer } from "../lib/credit-applications-drawer";
import { PaymentDrawer } from "../app/(app)/payments/PaymentDrawer";
import { OrderDrawer } from "../app/(app)/_order/OrderDrawer";
import { ExpenseDrawer } from "../app/(app)/expenses/ExpenseDrawer";
import { JournalDrawer } from "../app/(app)/journal/JournalDrawer";
import { FieldTicketDrawer } from "../app/(app)/field-tickets/FieldTicketDrawer";
import { PickListDrawer } from "../app/(app)/picks/PickListDrawer";
import { ShipmentDrawer } from "../app/(app)/shipments/ShipmentDrawer";

export type DocumentDrawerData = Parameters<typeof DocumentDrawer>[0] & {
  creditApplications?: CreditApplicationsDrawer | null;
};

export type RelatedTransactionDrawerData =
  | { type: "document"; props: DocumentDrawerData }
  | { type: "payment"; props: Parameters<typeof PaymentDrawer>[0] }
  | { type: "order"; props: Parameters<typeof OrderDrawer>[0] }
  | { type: "expense"; props: Parameters<typeof ExpenseDrawer>[0] }
  | { type: "journal"; props: Parameters<typeof JournalDrawer>[0] }
  | { type: "fieldTicket"; props: Parameters<typeof FieldTicketDrawer>[0] }
  | { type: "pickList"; props: Parameters<typeof PickListDrawer>[0] }
  | { type: "shipment"; props: Parameters<typeof ShipmentDrawer>[0] };

export function RelatedTransactionDrawerClient({ data }: { data: RelatedTransactionDrawerData }) {
  if (data.type === "document") {
    const { creditApplications, ...props } = data.props;
    return (
      <DocumentDrawer
        {...props}
        afterContent={
          creditApplications ? (
            <CreditApplicationsPanel
              documentId={creditApplications.documentId}
              side={creditApplications.side}
              partyId={creditApplications.partyId}
              canApply={creditApplications.canApply}
            />
          ) : undefined
        }
      />
    );
  }
  if (data.type === "payment") return <PaymentDrawer {...data.props} />;
  if (data.type === "order") return <OrderDrawer {...data.props} />;
  if (data.type === "expense") return <ExpenseDrawer {...data.props} />;
  if (data.type === "journal") return <JournalDrawer {...data.props} />;
  if (data.type === "pickList") return <PickListDrawer {...data.props} />;
  if (data.type === "shipment") return <ShipmentDrawer {...data.props} />;
  return <FieldTicketDrawer {...data.props} />;
}
