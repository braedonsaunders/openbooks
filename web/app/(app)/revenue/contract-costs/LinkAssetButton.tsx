"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button, Drawer, SearchSelect } from "@openbooks/ui";
import { readApiErrorMessage } from "@/lib/api-error";

/** Link an imported commission to its revenue contract, in context. */
export function LinkAssetButton({
  assetId,
  contracts,
}: {
  assetId: string;
  contracts: { id: string; number: string; customer: string }[];
}) {
  const t = useTranslations("contractCosts");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [contractId, setContractId] = useState("");

  async function submit() {
    if (!contractId) return;
    setBusy(true);
    try {
      const res = await fetch("/api/revenue/contract-costs/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assetId, revenueContractId: contractId }),
      });
      if (!res.ok) throw new Error(await readApiErrorMessage(res, t("link.failed")));
      toast.success(t("link.saved"));
      setOpen(false);
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("link.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>{t("link.open")}</Button>
      {open && (
        <Drawer
          open
          onClose={() => setOpen(false)}
          title={t("link.title")}
          description={t("link.description")}
        >
          <div className="space-y-4 p-4">
            <div className="space-y-1">
              <label className="text-sm font-medium">{t("link.contract")}</label>
              <SearchSelect
                value={contractId}
                options={contracts.map((c) => ({ value: c.id, label: `${c.number} · ${c.customer}` }))}
                onChange={(v) => setContractId(v ?? "")}
                ariaLabel={t("link.contract")}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setOpen(false)}>
                {t("common.cancel")}
              </Button>
              <Button onClick={submit} disabled={busy || !contractId}>
                {t("link.submit")}
              </Button>
            </div>
          </div>
        </Drawer>
      )}
    </>
  );
}
