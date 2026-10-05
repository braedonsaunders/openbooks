"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import {
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  Label,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@openbooks/ui";
import { readApiErrorMessage } from "../../../../../lib/api-error";
import { parseAdjustmentItems, type AdjustmentImportItem } from "./adjustment-import";

type Account = {
  id: string;
  provider: string;
  displayName: string;
  status: string;
};

type ImportResult = { imported: number; skipped: number } | null;

/**
 * Carrier billing adjustments tab: paste the carrier's billing export,
 * preview the parsed rows with their kinds, then import against one carrier
 * account. Replaying a file converges on provider identity — already-seen
 * adjustments skip instead of double-booking, and the result says so.
 */
export function AdjustmentImportClient() {
  const t = useTranslations("admin.setup.shipping");
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [accountId, setAccountId] = useState("");
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<AdjustmentImportItem[] | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/shipping/accounts");
        if (!res.ok) {
          if (!cancelled) setAccounts([]);
          return;
        }
        const body = (await res.json()) as { accounts?: Account[] };
        if (cancelled) return;
        const active = (body.accounts ?? []).filter((account) => account.status === "active");
        setAccounts(active);
        if (active.length === 1 && active[0]) setAccountId(active[0].id);
      } catch {
        if (!cancelled) setAccounts([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function onParse() {
    setResult(null);
    setFailure(null);
    const parsed = parseAdjustmentItems(text);
    if (!parsed.ok) {
      setPreview(null);
      setParseError(parsed.message);
      return;
    }
    setParseError(null);
    setPreview(parsed.items);
  }

  async function onImport() {
    if (!preview || !accountId) return;
    setBusy(true);
    setFailure(null);
    setResult(null);
    try {
      const res = await fetch("/api/shipping/adjustments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId, items: preview }),
      });
      // The import names skips and failures; parsing the body first would
      // turn its refusal into a syntax error.
      if (!res.ok) throw new Error(await readApiErrorMessage(res, t("adjustments.errors.importFailed")));
      const body = (await res.json()) as { adjustments?: { imported: number; skipped: number } };
      setResult({ imported: body.adjustments?.imported ?? 0, skipped: body.adjustments?.skipped ?? 0 });
      setPreview(null);
      setText("");
    } catch (error) {
      setFailure(error instanceof Error ? error.message : t("adjustments.errors.importFailed"));
    } finally {
      setBusy(false);
    }
  }

  if (accounts === null) {
    return (
      <Card>
        <CardContent>{t("adjustments.loading")}</CardContent>
      </Card>
    );
  }

  if (accounts.length === 0) {
    return (
      <EmptyState
        title={t("adjustments.noAccounts.title")}
        description={t("adjustments.noAccounts.description")}
        action={
          <Button asChild>
            <Link href="/admin/setup/shipping?tab=accounts">{t("adjustments.noAccounts.action")}</Link>
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="adjustment-account">{t("adjustments.account")}</Label>
              <Select
                id="adjustment-account"
                value={accountId}
                onChange={(event) => setAccountId(event.target.value)}
              >
                <option value="">{t("adjustments.accountPlaceholder")}</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.displayName} ({account.provider})
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="adjustment-paste">{t("adjustments.paste")}</Label>
              <textarea
                id="adjustment-paste"
                className="min-h-32 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder={t("adjustments.pastePlaceholder")}
              />
            </div>
            {parseError ? <p className="text-sm text-destructive">{parseError}</p> : null}
            <div className="flex gap-2">
              <Button variant="outline" onClick={onParse} disabled={!text.trim() || !accountId}>
                {t("adjustments.preview")}
              </Button>
              <Button onClick={onImport} disabled={!preview || preview.length === 0 || !accountId || busy}>
                {t("adjustments.import", { count: preview?.length ?? 0 })}
              </Button>
            </div>
            {failure ? <p className="text-sm text-destructive">{failure}</p> : null}
          </div>
        </CardContent>
      </Card>

      {preview && preview.length > 0 ? (
        <Card>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("adjustments.columns.adjustment")}</TableHead>
                  <TableHead>{t("adjustments.columns.shipment")}</TableHead>
                  <TableHead>{t("adjustments.columns.kind")}</TableHead>
                  <TableHead>{t("adjustments.columns.amount")}</TableHead>
                  <TableHead>{t("adjustments.columns.reason")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {preview.map((item) => (
                  <TableRow key={item.providerAdjustmentId}>
                    <TableCell className="font-mono text-[13px]">{item.providerAdjustmentId}</TableCell>
                    <TableCell className="font-mono text-[13px]">{item.providerShipmentId}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{t(`adjustments.kinds.${item.kind}`)}</Badge>
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {item.amount} {item.currency}
                    </TableCell>
                    <TableCell>{item.reason ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}

      {result ? (
        <Card>
          <CardContent>
            <p className="text-sm">
              {t("adjustments.result", { imported: result.imported, skipped: result.skipped })}
            </p>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
