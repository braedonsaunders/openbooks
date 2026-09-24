"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@openbooks/ui";
import { readApiErrorMessage } from "@/lib/api-error";

export function ProvisionPostButton({ runId }: { runId: string }) {
  const t = useTranslations("tax.provisions");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function post() {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/tax/provisions/${runId}/post`, { method: "POST" });
    // The status is checked before the body is parsed: an empty or non-JSON
    // error body (where `res.statusText` used to leak a bare "Conflict")
    // falls back to a named message with the status, and a named refusal —
    // which already carries its remedy — renders whole.
    if (!res.ok) {
      setError(await readApiErrorMessage(res, t("postFailed")));
      setBusy(false);
      return;
    }
    setBusy(false);
    router.refresh();
  }

  return (
    <span className="inline-flex items-center gap-2">
      <Button size="sm" disabled={busy} onClick={() => void post()}>
        {busy ? t("posting") : t("post")}
      </Button>
      {error ? <span className="text-xs text-red-600">{error}</span> : null}
    </span>
  );
}
