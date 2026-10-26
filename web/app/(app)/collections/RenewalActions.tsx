"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Input } from "@openbooks/ui";
import { readApiErrorMessage } from "@/lib/api-error";
import { DateField } from "@/components/date-field";
export function RenewalActions({
  subscriptionId,
  initialDocument,
  canAccept,
}: {
  subscriptionId: string;
  initialDocument: { documentId: string; kind: string } | null;
  canAccept: boolean;
}) {
  const router = useRouter();
  const [date, setDate] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [document, setDocument] = useState<{ documentId: string; kind: string } | null>(
      initialDocument,
    ),
    [reason, setReason] = useState("");
  async function generate() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/subscriptions/renewals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "generate", subscriptionId, asOf: date }),
      });
      if (!res.ok) {
        setError(await readApiErrorMessage(res, "Renewal could not be generated"));
        return;
      }
      setDocument(await res.json());
    } catch {
      setError("Renewal could not be generated");
    } finally {
      setBusy(false);
    }
  }
  async function accept() {
    if (!document) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/subscriptions/renewals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "accept", documentId: document.documentId, reason }),
      });
      if (!res.ok) {
        setError(await readApiErrorMessage(res, "Renewal could not be accepted"));
        return;
      }
      setDocument(null);
      router.refresh();
    } catch {
      setError("Renewal could not be accepted");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-2">
      <p>
        <Link className="underline" href="/admin/setup/subscription-renewal-policies">
          Renewal policy and reminders
        </Link>
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-sm">
          Review as of <DateField value={date} onChange={(value) => setDate(value)} />
        </label>
        <Button variant="outline" disabled={busy || !date} onClick={generate}>
          Generate renewal document
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {document ? (
        <Link
          className="underline"
          href={
            document.kind === "quote"
              ? `/estimates?estimate=${document.documentId}`
              : `/sales-orders?order=${document.documentId}`
          }
        >
          Open renewal {document.kind === "quote" ? "quote" : "sales order"}
        </Link>
      ) : null}
      {document && canAccept ? (
        <>
          <label className="block text-sm">
            Renewal acceptance reason
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <Button variant="outline" disabled={busy || reason.trim().length < 8} onClick={accept}>
            Accept approved renewal
          </Button>
        </>
      ) : null}
    </section>
  );
}
