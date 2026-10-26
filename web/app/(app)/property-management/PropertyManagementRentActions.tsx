"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button } from "@openbooks/ui";
import { readApiErrorMessage } from "../../../lib/api-error";

export function PropertyManagementRentActions() {
  const router = useRouter();
  const t = useTranslations("entities.propertyManagement.workspace");
  const [busy, setBusy] = useState(false);

  async function run(action: "billRent" | "assessLateFees") {
    setBusy(true);
    try {
      const response = await fetch("/api/property-management", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!response.ok) {
        throw new Error(await readApiErrorMessage(response, t("toasts.actionFailed")));
      }
      toast.success(t(action === "billRent" ? "toasts.rentBilled" : "toasts.lateFeesAssessed"));
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error && error.message ? error.message : t("toasts.actionFailed"),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" disabled={busy} onClick={() => void run("assessLateFees")}>
        {t("assessLateFees")}
      </Button>
      <Button disabled={busy} onClick={() => void run("billRent")}>
        {t("billDueRent")}
      </Button>
    </div>
  );
}
