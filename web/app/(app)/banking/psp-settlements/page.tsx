"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Button, Card, Input, Label, PageHeader, Select } from "@openbooks/ui";
import { useBusinessToday } from "../../../../components/business-date-provider";
import {
  ListPageLayout,
  PageContainer,
} from "../../../../components/page-layout";

/**
 * Minimal PSP settlement import UI — paste Stripe/Recurly/Chargebee JSON
 * and post the balanced kernel journal for fees/disputes/FX/net deposit.
 */
export default function PspSettlementsPage() {
  const t = useTranslations("banking.pspSettlements");
  const today = useBusinessToday();
  const [batches, setBatches] = useState<any[]>([]);
  const [provider, setProvider] = useState("stripe");
  const [externalRef, setExternalRef] = useState("");
  const [settlementDate, setSettlementDate] = useState(today);
  const [payload, setPayload] = useState("[]");
  const [bankAccountId, setBankAccountId] = useState("");
  const [feeAccountId, setFeeAccountId] = useState("");
  const [clearingAccountId, setClearingAccountId] = useState("");
  const [reversalDate, setReversalDate] = useState(today);
  const [reversalReason, setReversalReason] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    const r = await fetch("/api/psp/settlements");
    if (r.ok) {
      const d = await r.json();
      setBatches(d.batches ?? []);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const importBatch = async () => {
    setErr(null);
    setMsg(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      setErr("Payload must be valid JSON");
      return;
    }
    const body: Record<string, unknown> = {
      action: "import",
      provider,
      externalRef,
      settlementDate,
      bankAccountId: bankAccountId || undefined,
      feeAccountId: feeAccountId || undefined,
      clearingAccountId: clearingAccountId || undefined,
    };
    if (provider === "stripe") {
      body.transactions = parsed;
      body.payoutId = externalRef;
    } else {
      body.payload = parsed;
    }
    const r = await fetch("/api/psp/settlements", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok) {
      setErr(d.error ?? "Import failed");
      return;
    }
    setMsg(`Imported batch ${d.batchId} (net ${d.totals?.netAmount ?? "—"})`);
    void load();
  };

  const post = async (batchId: string) => {
    setErr(null);
    const r = await fetch("/api/psp/settlements", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "post", batchId }),
    });
    const d = await r.json();
    if (!r.ok) {
      setErr(d.error ?? "Post failed");
      return;
    }
    setMsg(`Posted journal ${d.entryId}`);
    void load();
  };

  const reverse = async (batchId: string) => {
    setErr(null);
    if (reversalReason.trim().length < 5) {
      setErr("Enter a reversal reason of at least 5 characters");
      return;
    }
    const r = await fetch("/api/psp/settlements", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "reverse",
        batchId,
        reversalDate,
        reason: reversalReason,
      }),
    });
    const d = await r.json();
    if (!r.ok) {
      setErr(d.error ?? "Reversal failed");
      return;
    }
    setMsg(`Posted controlled reversal journal ${d.entryId}`);
    setReversalReason("");
    void load();
  };

  return (
    <ListPageLayout
      header={
        <PageHeader
          title="PSP settlements"
          description="Import Stripe, Recurly, or Chargebee payouts. Fees, disputes, and FX post through the GL kernel."
        />
      }
    >
      <PageContainer className="space-y-6">
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {t("acceptanceNote")}{" "}
          <Link
            href="/admin/setup/payment-providers"
            className="text-teal-700 hover:underline dark:text-teal-300"
          >
            {t("acceptanceLink")}
          </Link>
        </p>
        {err && <p className="text-sm text-red-600">{err}</p>}
        {msg && (
          <p className="text-sm text-teal-700 dark:text-teal-300">{msg}</p>
        )}

        <Card className="space-y-3 p-4">
          <h3 className="text-sm font-semibold">Import settlement</h3>
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <Label>Provider</Label>
              <Select
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
              >
                <option value="stripe">Stripe</option>
                <option value="recurly">Recurly</option>
                <option value="chargebee">Chargebee</option>
              </Select>
            </div>
            <div>
              <Label>External ref / payout id</Label>
              <Input
                value={externalRef}
                onChange={(e) => setExternalRef(e.target.value)}
              />
            </div>
            <div>
              <Label>Settlement date</Label>
              <Input
                type="date"
                value={settlementDate}
                onChange={(e) => setSettlementDate(e.target.value)}
              />
            </div>
            <div>
              <Label>Bank account id</Label>
              <Input
                value={bankAccountId}
                onChange={(e) => setBankAccountId(e.target.value)}
                placeholder="uuid"
              />
            </div>
            <div>
              <Label>Fee account id</Label>
              <Input
                value={feeAccountId}
                onChange={(e) => setFeeAccountId(e.target.value)}
                placeholder="uuid"
              />
            </div>
            <div>
              <Label>Clearing account id</Label>
              <Input
                value={clearingAccountId}
                onChange={(e) => setClearingAccountId(e.target.value)}
                placeholder="uuid"
              />
            </div>
          </div>
          <div>
            <Label>
              {provider === "stripe"
                ? "Balance transactions JSON array"
                : "Settlement JSON object"}
            </Label>
            <textarea
              className="mt-1 min-h-32 w-full rounded border p-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-950"
              value={payload}
              onChange={(e) => setPayload(e.target.value)}
            />
          </div>
          <Button
            size="sm"
            disabled={!externalRef}
            onClick={() => void importBatch()}
          >
            Import draft
          </Button>
        </Card>

        <Card className="p-4">
          <h3 className="mb-3 text-sm font-semibold">Recent batches</h3>
          <div className="mb-4 grid gap-3 sm:grid-cols-[12rem_1fr]">
            <div>
              <Label>Reversal date</Label>
              <Input
                type="date"
                value={reversalDate}
                onChange={(e) => setReversalDate(e.target.value)}
              />
            </div>
            <div>
              <Label>Reversal reason</Label>
              <Input
                value={reversalReason}
                onChange={(e) => setReversalReason(e.target.value)}
                placeholder="Required evidence for a controlled correction"
                maxLength={500}
              />
            </div>
          </div>
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="py-1">Provider</th>
                <th>Ref</th>
                <th>Date</th>
                <th className="text-right">Net</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {batches.map((b) => (
                <tr key={b.id} className="border-t">
                  <td className="py-1">{b.provider}</td>
                  <td className="font-mono text-xs">{b.externalRef}</td>
                  <td>{b.settlementDate}</td>
                  <td className="text-right tabular-nums">{b.netAmount}</td>
                  <td>{b.status}</td>
                  <td className="text-right">
                    {b.status === "draft" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void post(b.id)}
                      >
                        Post
                      </Button>
                    )}
                    {b.status === "posted" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={reversalReason.trim().length < 5}
                        onClick={() => void reverse(b.id)}
                      >
                        Reverse
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
              {batches.length === 0 && (
                <tr>
                  <td
                    colSpan={6}
                    className="py-4 text-center text-muted-foreground"
                  >
                    No settlements imported yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
      </PageContainer>
    </ListPageLayout>
  );
}
