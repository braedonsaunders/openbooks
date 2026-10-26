"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { readApiErrorMessage } from "@/lib/api-error";
import { SignaturePad } from "../../../../components/signature-pad";

/** Signature capture for a visit sign-off: name, optional comment and drawn signature. */
export function VisitSignForm({ token }: { token: string }) {
  const t = useTranslations("service.sign");
  const [signature, setSignature] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [comment, setComment] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [error, setError] = useState("");

  async function submit() {
    if (!signature || !name.trim()) return;
    setState("busy");
    try {
      const response = await fetch("/api/sign/service-visits", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token,
          signature,
          name: name.trim(),
          comment: comment.trim() || null,
        }),
      });
      if (!response.ok) throw new Error(await readApiErrorMessage(response, t("signFailed")));
      setState("done");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("signFailed"));
      setState("error");
    }
  }

  if (state === "done")
    return (
      <div
        role="status"
        className="rounded-lg border border-teal-200 bg-teal-50 p-4 text-center text-sm font-medium text-teal-800"
      >
        {t("signedThanks")}
      </div>
    );
  return (
    <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-700">
      <p className="mb-2 text-sm font-medium text-slate-900 dark:text-slate-100">
        {t("signPrompt")}
      </p>
      <SignaturePad onChange={setSignature} clearLabel={t("clear")} />
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <input
          aria-label={t("yourName")}
          placeholder={t("yourName")}
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="h-9 rounded-md border border-slate-300 px-2 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
        />
        <input
          aria-label={t("comment")}
          placeholder={t("comment")}
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          className="h-9 rounded-md border border-slate-300 px-2 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
        />
      </div>
      {state === "error" ? (
        <p role="alert" className="mt-2 text-sm text-rose-600">
          {error}
        </p>
      ) : null}
      <button
        type="button"
        onClick={() => void submit()}
        disabled={state === "busy" || !signature || !name.trim()}
        className="mt-3 w-full rounded-md bg-teal-600 py-2 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-50"
      >
        {state === "busy" ? t("signing") : t("sign")}
      </button>
    </div>
  );
}
