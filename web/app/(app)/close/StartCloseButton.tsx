"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Play } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { Button, Select } from "@openbooks/ui";

export function StartCloseButton({
  periodId,
  books,
  defaultBookId,
}: {
  periodId: string;
  books: any[];
  defaultBookId?: string;
}) {
  const t = useTranslations("close");
  const router = useRouter();
  const [bookId, setBookId] = useState(defaultBookId ?? books[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  async function start() {
    setBusy(true);
    try {
      const response = await fetch("/api/close/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ periodId, bookId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? t("errors.actionFailed"));
      router.push(`/close?run=${data.runId}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("errors.actionFailed"));
      setBusy(false);
    }
  }
  return (
    <div className="flex items-center gap-1">
      {books.length > 1 ? (
        <Select
          className="w-28"
          value={bookId}
          onChange={(e) => setBookId(e.target.value)}
        >
          {books.map((book) => (
            <option key={book.id} value={book.id}>
              {book.name}
            </option>
          ))}
        </Select>
      ) : null}
      <Button size="sm" disabled={busy || !bookId} onClick={start}>
        <Play size={14} />
        {busy ? t("actions.starting") : t("actions.start")}
      </Button>
    </div>
  );
}
