'use client'

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Pause, Play, Unplug } from "lucide-react";
import { Button } from "@openbooks/ui";
import { readApiErrorMessage } from "../../../../lib/api-error";
import { confirmDialog } from "@/lib/confirm";
import { promptDialog } from "@/lib/prompt";

/** Pause, resume, and disconnect from the workspace header. State moves only through lifecycle actions with a reason. */
export function ChannelActions({
  channelId,
  channelName,
  status,
  canManage,
}: {
  channelId: string;
  channelName: string;
  status: string;
  canManage: boolean;
}) {
  const t = useTranslations("channels");
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  async function act(action: "pause" | "resume" | "disconnect") {
    const reason = await promptDialog({
      title: t(`home.${action}Title`, { name: channelName }),
      message: t(`home.${action}Body`),
      label: t("home.reasonLabel"),
      confirmLabel: t(`home.${action}Confirm`),
    });
    if (!reason) return;
    if (action === "disconnect" && !(await confirmDialog(t("home.disconnectVerify", { name: channelName })))) return;
    setBusy(action);
    try {
      const res = await fetch(`/api/channels/${channelId}/lifecycle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, reason }),
      });
      if (!res.ok) {
        toast.error(await readApiErrorMessage(res, t("home.toast.actionFailed", { status: res.status })));
        return;
      }
      toast.success(t(`home.toast.${action}d`));
      router.refresh();
    } catch {
      toast.error(t("home.toast.actionFailed", { status: "network" }));
    } finally {
      setBusy(null);
    }
  }

  if (!canManage) return null;
  return (
    <ChannelActionButtons status={status} busy={busy} onAct={(action) => void act(action)} t={t} />
  );
}

function ChannelActionButtons({
  status,
  busy,
  onAct,
  t,
}: {
  status: string;
  busy: string | null;
  onAct: (action: "pause" | "resume" | "disconnect") => void;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {status === "active" ? (
        <Button size="sm" variant="outline" disabled={busy != null} onClick={() => onAct("pause")}>
          <Pause size={14} /> {t("home.pause")}
        </Button>
      ) : null}
      {status === "paused" ? (
        <Button size="sm" variant="outline" disabled={busy != null} onClick={() => onAct("resume")}>
          <Play size={14} /> {t("home.resume")}
        </Button>
      ) : null}
      {status !== "disconnected" ? (
        <Button size="sm" variant="outline" disabled={busy != null} onClick={() => onAct("disconnect")}>
          <Unplug size={14} /> {t("home.disconnect")}
        </Button>
      ) : null}
    </div>
  );
}
