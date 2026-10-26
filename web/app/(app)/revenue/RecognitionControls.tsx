"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@openbooks/ui";
import { toast } from "sonner";
import { promptDialog } from "@/lib/prompt";
import { readApiErrorMessage } from "@/lib/api-error";
import { DateField } from "@/components/date-field";

export function RecognitionControls({
  obligationId,
  held,
  revision,
  deliveredOn,
  deliveryRequired,
}: {
  obligationId: string;
  held: boolean;
  revision: number;
  deliveredOn: string | null;
  deliveryRequired: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [deliveryDate, setDeliveryDate] = useState("");
  async function apply(action: "hold" | "release" | "deliver") {
    const reason = await promptDialog({
      title:
        action === "deliver"
          ? "Record delivery acceptance"
          : action === "hold"
            ? "Hold recognition"
            : "Release recognition",
      label:
        action === "deliver"
          ? "Acceptance or fulfillment evidence and review reason"
          : "Review reason",
      confirmLabel: "Save",
    });
    if (!reason) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/revenue/obligations/${obligationId}/controls`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action,
          reason,
          expectedRevision: revision,
          ...(action === "deliver" ? { effectiveOn: deliveryDate, evidence: reason } : {}),
        }),
      });
      if (!response.ok) {
        toast.error(await readApiErrorMessage(response, "Recognition control could not be saved"));
        return;
      }
      router.refresh();
    } catch {
      toast.error("Recognition control could not be saved");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" disabled={busy} onClick={() => apply(held ? "release" : "hold")}>
        {held ? "Release recognition" : "Hold recognition"}
      </Button>
      {deliveryRequired && !deliveredOn ? (
        <>
          <label className="text-sm">
            Delivery date{" "}
            <DateField value={deliveryDate} onChange={(value) => setDeliveryDate(value)} />
          </label>
          <Button
            variant="outline"
            disabled={busy || !deliveryDate}
            onClick={() => apply("deliver")}
          >
            Record delivery acceptance
          </Button>
        </>
      ) : deliveryRequired ? (
        <span className="text-sm">Delivered {deliveredOn}</span>
      ) : null}
      {held ? <span className="text-sm">Recognition is on hold</span> : null}
    </div>
  );
}
