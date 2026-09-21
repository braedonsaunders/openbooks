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
  taxBasis = false,
}: {
  id: string;
  domain?: "asset" | "consolidation";
  effectiveOn?: string;
  taxBasis?: boolean;
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
            ...(domain === "asset" && !taxBasis ? { effectiveOn: date } : {}),
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
            ? taxBasis
              ? "Reverse tax basis workpaper"
              : "Reverse asset change"
            : "Correct loss of control"
        }
        description={
          taxBasis
            ? "The original workpaper remains in the audit history. Reversal requires a new independent approval."
            : "The original journals remain intact. Reversal requires a new independent approval."
        }
        footer={
          <Button disabled={busy} onClick={propose}>
            Prepare reversal
          </Button>
        }
      >
        <div className="space-y-4">
          {domain === "asset" && !taxBasis ? (
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
          ) : taxBasis ? (
            <p>
              The correction uses the original workpaper date ({effectiveOn}).
              Apply a replacement tax basis workpaper after this reversal.
              If earlier consolidated matching periods were posted, open the
              replacement in Accounting changes to review and approve its tax
              matching replay. Re-run the latest computed year from Fixed Assets
              tax pools; earlier computed years cannot be overwritten.
            </p>
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
