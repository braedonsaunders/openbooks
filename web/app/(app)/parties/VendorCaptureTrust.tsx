"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Badge } from "@openbooks/ui";

interface TrustSummary {
  trusted: boolean;
  cleanStreak: number;
  threshold: number;
  policyEnabled: boolean;
}

/**
 * The vendor's earned capture trust, derived from its captured bills on
 * every read: shown only while the organization's auto-post policy is on,
 * because trust changes nothing otherwise. A reader without AP access, or a
 * vendor with no captures, sees nothing.
 */
export function VendorCaptureTrust({ partyId }: { partyId: string }) {
  const t = useTranslations("apInbox.trust");
  const [summary, setSummary] = useState<TrustSummary | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`/api/ap-capture/vendor-trust/${encodeURIComponent(partyId)}`, {
      headers: { accept: "application/json" },
    })
      .then(async (response) => (response.ok ? response.json() : null))
      .then((body: TrustSummary | null) => {
        if (live) setSummary(body);
      })
      .catch(() => {
        if (live) setSummary(null);
      });
    return () => {
      live = false;
    };
  }, [partyId]);
  if (!summary || !summary.policyEnabled) return null;
  return (
    <div className="flex items-center gap-2 text-sm">
      <Badge variant={summary.trusted ? "success" : "secondary"}>
        {summary.trusted
          ? t("trusted", { count: summary.cleanStreak })
          : t("building", { count: summary.cleanStreak, threshold: summary.threshold })}
      </Badge>
    </div>
  );
}
