"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button, Drawer, Input, Label, Textarea } from "@openbooks/ui";
import { useBusinessToday } from "@/components/business-date-provider";
export function ReverseAssetChange({
  id,
  domain = "asset",
  effectiveOn,
}: {
  id: string;
  domain?: "asset" | "consolidation";
  effectiveOn?: string;
}) {
  const router = useRouter(),
    today = useBusinessToday();
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [date, setDate] = useState(effectiveOn ?? today),
    [reason, setReason] = useState(""),
    [key, setKey] = useState(() => crypto.randomUUID());
  async function propose() {
    setBusy(true);
    try {
      const r = await fetch(
        domain === "asset"
          ? `/api/accounting/changes/${id}/reverse`
          : `/api/consolidation/changes/${id}/reverse`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...(domain === "asset" ? { effectiveOn: date } : {}),
            reason,
            idempotencyKey: key,
          }),
        },
      );
      if (!r.ok) {
        const refusal = await r.json().catch(() => ({}));
        throw new Error(refusal.error ?? "Could not propose reversal");
      }
      const value = (await r.json()) as { changeId: string };
      setOpen(false);
      router.push(`/accounting/changes?change=${value.changeId}`);
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Could not propose reversal",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Propose reversal
      </Button>
      <Drawer
        stacked
        open={open}
        onClose={() => setOpen(false)}
        title={
          domain === "asset"
            ? "Reverse asset change"
            : "Correct loss of control"
        }
        description="The original journals remain intact. Reversal requires a new independent approval."
        footer={
          <Button disabled={busy} onClick={propose}>
            Prepare reversal
          </Button>
        }
      >
        <div className="space-y-4">
          {domain === "asset" ? (
            <div>
              <Label>Reversal date</Label>
              <Input
                type="date"
                value={date}
                onChange={(e) => {
                  setDate(e.target.value);
                  setKey(crypto.randomUUID());
                }}
              />
            </div>
          ) : (
            <p>
              The correction uses the original disposal date. Its accounting
              period must be open, and later retained-interest consolidation
              prevents this reversal.
            </p>
          )}
          <div>
            <Label>Reason</Label>
            <Textarea
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                setKey(crypto.randomUUID());
              }}
            />
          </div>
        </div>
      </Drawer>
    </>
  );
}
