'use client'

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Link2Off } from "lucide-react";
import { Button } from "@openbooks/ui";
import { readApiErrorMessage } from "../../../lib/api-error";
import { promptDialog } from "@/lib/prompt";

/**
 * Unlink one external identity from its channel. Channel-less provider links
 * (Stripe) render no button: their owning surface unlinks them. Unlinking is
 * audited and needs a reason, so this never uses the generic setup delete.
 */
export function UnlinkExternalLinkButton({
  channelId,
  provider,
  externalAccount,
  objectType,
  externalId,
  canManage,
}: {
  channelId: string | null;
  provider: string;
  externalAccount: string;
  objectType: string;
  externalId: string;
  canManage: boolean;
}) {
  const t = useTranslations("channels");
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function unlink() {
    const reason = await promptDialog({
      title: t("links.unlinkTitle", { externalId }),
      message: t("links.unlinkBody", { provider, externalAccount }),
      label: t("home.reasonLabel"),
      confirmLabel: t("links.unlinkConfirm"),
    });
    if (!reason || !channelId) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/channels/${channelId}/links`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "unlink", objectType, externalId, reason }),
      });
      if (!res.ok) {
        toast.error(await readApiErrorMessage(res, t("links.toast.unlinkFailed", { status: res.status })));
        return;
      }
      toast.success(t("links.toast.unlinked"));
      router.refresh();
    } catch {
      toast.error(t("links.toast.unlinkFailed", { status: "network" }));
    } finally {
      setBusy(false);
    }
  }

  if (!canManage || !channelId) return null;
  return (
    <Button size="sm" variant="outline" disabled={busy} onClick={() => void unlink()}>
      <Link2Off size={14} /> {t("links.unlink")}
    </Button>
  );
}
