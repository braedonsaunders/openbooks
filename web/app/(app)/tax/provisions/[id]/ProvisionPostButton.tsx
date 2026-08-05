"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@openbooks/ui";

export function ProvisionPostButton({ runId }: { runId: string }) {
  const t = useTranslations("tax.provisions");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function post() {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/tax/provisions/${runId}/post`, { method: "POST" });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    setBusy(false);
    if (!res.ok) {
      setError(json.error ?? res.statusText);
      return;
    }
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
