'use client'

import { useTranslations } from "next-intl";
import { useViewerFormat } from "@/lib/viewer-format";
import { UnlinkExternalLinkButton } from "./UnlinkExternalLinkButton";

export interface ExternalIdentityRow {
  id: string;
  channelId: string | null;
  provider: string;
  externalAccount: string;
  objectType: string;
  externalId: string;
  lastSyncedAt: string | null;
}

/**
 * Read-only identity rows with one audited action. The table mirrors the
 * item drawer's External IDs tab; unlinking always goes through the channel
 * endpoint with a reason, never the generic setup delete.
 */
export function ExternalIdsPanel({ links, canUnlink }: { links: ExternalIdentityRow[]; canUnlink: boolean }) {
  const t = useTranslations("channels");
  const { dateTime } = useViewerFormat();
  if (links.length === 0) {
    return <p className="text-sm text-slate-500">{t("links.emptyBody")}</p>;
  }
  return (
    <ul className="divide-y divide-slate-100 dark:divide-slate-800">
      {links.map((link) => (
        <li key={link.id} className="flex items-center justify-between gap-3 py-2">
          <div className="min-w-0">
            <p className="truncate font-mono text-sm">{link.externalId}</p>
            <p className="truncate text-sm text-slate-500">
              {link.provider} · {link.objectType} · {link.externalAccount}
              {link.lastSyncedAt ? ` · ${dateTime(new Date(link.lastSyncedAt))}` : ""}
            </p>
          </div>
          <UnlinkExternalLinkButton
            channelId={link.channelId}
            provider={link.provider}
            externalAccount={link.externalAccount}
            objectType={link.objectType}
            externalId={link.externalId}
            canManage={canUnlink}
          />
        </li>
      ))}
    </ul>
  );
}
