"use client";

import { useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { fetchAction } from "@braedonsaunders/appkit-errors";
import { ActionAlert } from "@braedonsaunders/appkit-errors/react";
import { Button, Drawer } from "@openbooks/ui";
import type { TaxMatchingReplayInput } from "@openbooks/engine/src/tax-returns/asset-basis-policy.ts";
import type { TaxMatchingReplayPreview } from "@openbooks/engine/src/tax-returns/consolidated-matching-replay.ts";
import { useAppAction } from "@/lib/use-app-action";
import { prepareTaxMatchingReplay } from "./tax-matching-replay-draft";
import { TaxMatchingReplayForm } from "./TaxMatchingReplayForm";

/** Same stacked Drawer and action path as assets/TaxBasisButton. */
export function TaxMatchingReplayButton({ assetId, replacementWorkpaperChangeId }: {
  assetId: string;
  replacementWorkpaperChangeId: string;
}) {
  const router = useRouter();
  const formId = useId();
  const { busy, refusal, execute, refuse } = useAppAction();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<TaxMatchingReplayPreview | null>(null);
  const [reason, setReason] = useState("");
  const [key, setKey] = useState(() => crypto.randomUUID());
  const endpoint = `/api/assets/${assetId}/tax-matching-replay`;
  async function load() {
    setOpen(true);
    setPreview(null);
    setKey(crypto.randomUUID());
    await execute(
      () => fetchAction<TaxMatchingReplayPreview>(
        `${endpoint}?replacementWorkpaperChangeId=${encodeURIComponent(replacementWorkpaperChangeId)}`,
      ),
      {
        fallbackMessage: "Could not load matching history for the replacement workpaper",
        onOk: (value) => setPreview(value),
      },
    );
  }
  async function propose(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const fallbackMessage = "Could not propose tax matching replay";
    let input: TaxMatchingReplayInput;
    try {
      input = prepareTaxMatchingReplay(preview, assetId, replacementWorkpaperChangeId, reason, key);
    } catch (error) {
      refuse(error instanceof Error ? error.message : null, fallbackMessage);
      return;
    }
    const succeeded = await execute(
      () => fetchAction<{ changeId: string }>(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
      {
        fallbackMessage,
        onOk: ({ changeId }) => {
          setOpen(false);
          router.push(`/accounting/changes?change=${encodeURIComponent(changeId)}`);
        },
      },
    );
    // A stale-source refusal must not leave an enabled proposal for the old
    // evidence. Retain the reason, and require an explicit history refresh.
    if (!succeeded) setPreview(null);
  }
  return (
    <>
      <Button variant="outline" disabled={busy} onClick={load}>Review tax matching replay</Button>
      <Drawer
        stacked open={open} onClose={() => setOpen(false)}
        title="Tax matching replay" size="lg"
        description="Review the replacement opening and cited historical periods before independent approval."
        footer={preview && preview.citedHistoricalPeriodIds.length > 0 ? (
          <Button type="submit" form={formId} disabled={busy || reason.trim().length < 8}>
            Create approval proposal
          </Button>
        ) : undefined}
      >
        <div className="space-y-5 p-4">
          <ActionAlert error={refusal} fallbackMessage="Could not prepare tax matching replay" />
          <Button type="button" variant="outline" disabled={busy} onClick={load}>Reload matching history</Button>
          <TaxMatchingReplayForm formId={formId} preview={preview} reason={reason} busy={busy}
            onReasonChange={(value) => { setReason(value); setKey(crypto.randomUUID()); }} onSubmit={propose} />
        </div>
      </Drawer>
    </>
  );
}
