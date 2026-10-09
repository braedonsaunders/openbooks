"use client";
import { useState } from "react";
import { RecordTabs } from "@/components/module-home/record-tabs";
import { PutawayQueue, type StagedStockRowView } from "./PutawayQueue";
import { ReceiptQueue, type ReceiptQueueRow } from "./ReceiptQueue";
export function WarehouseExecutionQueue({
  rows,
  receipts,
  canPost,
}: {
  rows: StagedStockRowView[];
  receipts: ReceiptQueueRow[];
  canPost: boolean;
}) {
  const [tab, setTab] = useState("receive");
  return (
    <div className="space-y-3">
      <RecordTabs
        label="Warehouse execution"
        tabs={[
          { key: "receive", label: "Receive" },
          { key: "putaway", label: "Putaway" },
        ]}
        active={tab}
        onChange={setTab}
      />
      {tab === "receive" ? (
        <ReceiptQueue rows={receipts} canPost={canPost} />
      ) : (
        <PutawayQueue rows={rows} canPost={canPost} />
      )}
    </div>
  );
}
