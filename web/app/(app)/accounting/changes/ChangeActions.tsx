"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@openbooks/ui";
import { toast } from "sonner";
import { readApiErrorMessage } from "@/lib/api-error";
export function ChangeActions({
  id,
  status,
  canSubmit,
  canApply,
}: {
  id: string;
  status: string;
  canSubmit: boolean;
  canApply: boolean;
}) {
  const [busy, setBusy] = useState(false),
    router = useRouter();
  async function act(action: "submit" | "apply") {
    setBusy(true);
    try {
      const res = await fetch(`/api/accounting/changes/${id}/${action}`, {
        method: "POST",
      });
      if (!res.ok)
        throw new Error(
          await readApiErrorMessage(res, "Accounting change failed"),
        );
      toast.success(
        action === "submit"
          ? "Submitted for independent approval"
          : "Approved change applied",
      );
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Accounting change failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex gap-2">
      {status === "draft" && canSubmit ? (
        <Button disabled={busy} onClick={() => act("submit")}>
          Submit for approval
        </Button>
      ) : null}
      {status === "approved" && canApply ? (
        <Button disabled={busy} onClick={() => act("apply")}>
          Apply approved change
        </Button>
      ) : null}
      {status === "pending" ? (
        <Button variant="outline" asChild>
          <Link href="/approvals">Review in Approvals</Link>
        </Button>
      ) : null}
    </div>
  );
}
