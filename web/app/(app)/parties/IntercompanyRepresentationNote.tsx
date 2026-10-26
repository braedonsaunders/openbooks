"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

type Representation = { role: "customer" | "vendor"; subsidiaryId: string; subsidiaryName: string };

/**
 * States, on the party record, which subsidiary this customer or vendor
 * represents to its sister entities. Its documents are intercompany: they
 * post through the intercompany pair's receivable or payable account and
 * are paired and reconciled. The representation is configured in Setup, so
 * the note links there. When Intercompany transactions is off, or the reader
 * cannot see representations, nothing renders.
 */
export function IntercompanyRepresentationNote({
  partyId,
}: {
  partyId: string | null | undefined;
}) {
  const t = useTranslations("intercompany");
  const [representations, setRepresentations] = useState<Representation[]>([]);
  useEffect(() => {
    if (!partyId) return;
    let cancelled = false;
    fetch(`/api/intercompany/representations?partyId=${encodeURIComponent(partyId)}`)
      .then(async (res) => {
        if (cancelled || !res.ok) return;
        const payload: unknown = await res.json().catch(() => null);
        const list =
          payload && typeof payload === "object"
            ? (payload as { representations?: unknown }).representations
            : null;
        if (!cancelled && Array.isArray(list)) setRepresentations(list as Representation[]);
      })
      .catch(() => {
        // A failed read shows no note; posting enforces the representation.
      });
    return () => {
      cancelled = true;
    };
  }, [partyId]);
  if (representations.length === 0) return null;
  return (
    <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-100">
      {representations.map((representation) => (
        <p key={representation.role}>
          {t(
            representation.role === "customer"
              ? "party.representsAsCustomer"
              : "party.representsAsVendor",
            { subsidiary: representation.subsidiaryName },
          )}
        </p>
      ))}
      <Link
        className="text-xs font-medium underline-offset-2 hover:underline"
        href={"/admin/setup/intercompany-representing-parties" as never}
      >
        {t("party.manageRepresentation")}
      </Link>
    </div>
  );
}
