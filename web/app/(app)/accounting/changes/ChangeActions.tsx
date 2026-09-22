"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
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
  const t = useTranslations("accounting");
  async function act(action: "submit" | "apply") {
    setBusy(true);
    try {
      const res = await fetch(`/api/accounting/changes/${id}/${action}`, {
        method: "POST",
      });
      if (!res.ok)
        throw new Error(await readApiErrorMessage(res, t("lifecycle.failed")));
      toast.success(
        action === "submit"
          ? t("lifecycle.submittedToast")
          : t("lifecycle.appliedToast"),
      );
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("lifecycle.failed"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex gap-2">
      {status === "draft" && canSubmit ? (
        <Button disabled={busy} onClick={() => act("submit")}>
          {t("lifecycle.submit")}
        </Button>
      ) : null}
      {status === "approved" && canApply ? (
        <Button disabled={busy} onClick={() => act("apply")}>
          {t("lifecycle.apply")}
        </Button>
      ) : null}
      {status === "pending" ? (
        <Button variant="outline" asChild>
          <Link href="/inbox">{t("lifecycle.reviewInbox")}</Link>
        </Button>
      ) : null}
    </div>
  );
}
