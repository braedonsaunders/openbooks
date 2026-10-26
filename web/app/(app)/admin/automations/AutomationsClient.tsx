"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button, Drawer, Input, Label, Select } from "@openbooks/ui";
import { toast } from "sonner";
import { readApiErrorMessage } from "../../../../lib/api-error";

/**
 * Client islands for the automations list: the New-automation dialog (name
 * + trigger kind, creating a draft recipe and landing on its builder) and
 * per-row enable/disable/run-now controls. Every refusal renders with its
 * message intact — res.ok is checked before any body is parsed.
 */

const TRIGGER_KINDS = [
  "schedule",
  "date_relative",
  "field_change",
  "event",
  "document",
  "manual",
] as const;

// Event-sourced triggers stage nothing in production yet (no writer feeds
// the event queue), so enabling a recipe on one is refused by the API —
// say so here instead of letting an author discover it at enable time.
const UNAVAILABLE_TRIGGER_KINDS = ["field_change", "event", "document"] as const;

function defaultTrigger(kind: string): Record<string, unknown> {
  switch (kind) {
    case "schedule":
      return { kind, cron: "0 9 * * MON", timezone: "UTC" };
    case "date_relative":
      return {
        kind,
        entity: "employment",
        dateField: "service_start",
        offsetDays: 3,
        direction: "before",
        atTime: "09:00",
      };
    case "field_change":
      return { kind, entity: "employment", field: "status" };
    case "event":
      return {
        kind,
        subjectKind: "hrm_employment_change_request",
        eventKind: "approved",
      };
    case "document":
      return { kind, event: "signed" };
    default:
      return { kind: "manual" };
  }
}

export function NewAutomationButton({ label }: { label: string }) {
  const t = useTranslations("admin.automations");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<string>("schedule");
  const [recipeKey, setRecipeKey] = useState<string>("");
  const [recipes, setRecipes] = useState<
    {
      key: string;
      name: string;
      description: string;
      trigger: Record<string, unknown>;
      actions: Record<string, unknown>[];
    }[]
  >([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    fetch("/api/automations/recipes", { method: "GET" })
      .then(async (res) => {
        if (!res.ok) return;
        const payload = (await res.json().catch(() => ({}))) as {
          recipes?: typeof recipes;
        };
        if (Array.isArray(payload.recipes)) setRecipes(payload.recipes);
      })
      .catch(() => {});
  }, [open]);

  async function create() {
    const recipe = recipes.find((r) => r.key === recipeKey);
    const recipeName = recipe?.name ?? "";
    if (!name.trim() && !recipe) {
      setError(t("list.nameRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/automations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          recipe
            ? {
                name: name.trim() || recipeName,
                description: recipe.description,
                trigger: recipe.trigger,
                rules: {},
                conditions: {},
                actions: recipe.actions,
              }
            : {
                name: name.trim(),
                trigger: defaultTrigger(kind),
                rules: {},
                conditions: {},
                actions: [{ kind: "send_notification", to: "manager", body: "" }],
              },
        ),
      });
      if (!res.ok) {
        setError(await readApiErrorMessage(res, t("list.createFailed")));
        return;
      }
      const payload = (await res.json().catch(() => ({}))) as {
        automation?: { id?: string };
      };
      const id = payload.automation?.id;
      setOpen(false);
      if (typeof id === "string") router.push(`/admin/automations/${id}` as never);
      else router.refresh();
    } catch {
      setError(t("list.createFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>{label}</Button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title={t("list.newTitle")}
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>
              {t("list.cancel")}
            </Button>
            <Button disabled={busy} onClick={create}>
              {t("list.create")}
            </Button>
          </>
        }
      >
        <div className="grid gap-3">
          <div className="grid gap-1">
            <Label htmlFor="automation-recipe">{t("list.recipeLabel")}</Label>
            <Select
              id="automation-recipe"
              value={recipeKey}
              onChange={(e) => {
                const key = e.target.value;
                setRecipeKey(key);
                const picked = recipes.find((r) => r.key === key);
                if (picked && !name.trim()) setName(picked.name);
                setError(null);
              }}
            >
              <option value="">{t("list.recipeBlank")}</option>
              {recipes.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid gap-1">
            <Label htmlFor="automation-name">{t("list.nameLabel")}</Label>
            <Input
              id="automation-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("list.namePlaceholder")}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="automation-trigger">{t("list.triggerLabel")}</Label>
            <Select
              id="automation-trigger"
              value={kind}
              disabled={recipeKey !== ""}
              onChange={(e) => setKind(e.target.value)}
            >
              {TRIGGER_KINDS.map((k) => {
                const unavailable = (UNAVAILABLE_TRIGGER_KINDS as readonly string[]).includes(k);
                return (
                  <option key={k} value={k} disabled={unavailable}>
                    {t(`triggerKinds.${k}`)}
                    {unavailable ? ` (${t("triggerKindUnavailable")})` : ""}
                  </option>
                );
              })}
            </Select>
            {(UNAVAILABLE_TRIGGER_KINDS as readonly string[]).includes(kind) ? (
              <p className="text-sm text-amber-700 dark:text-amber-300">
                {t("triggerKindUnavailableNote")}
              </p>
            ) : null}
          </div>
          {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
        </div>
      </Drawer>
    </>
  );
}

export function AutomationRowActions({
  id,
  status,
  runLabel,
  enableLabel,
  disableLabel,
  actionFailed,
}: {
  id: string;
  status: string;
  runLabel: string;
  enableLabel: string;
  disableLabel: string;
  actionFailed: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function call(
    url: string,
    body?: Record<string, unknown>,
    headers?: Record<string, string>,
  ) {
    setBusy(true);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          ...(body ? { "content-type": "application/json" } : {}),
          ...headers,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!res.ok) toast.error(await readApiErrorMessage(res, actionFailed));
      router.refresh();
    } catch {
      toast.error(actionFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      {status === "enabled" ? (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => call(`/api/automations/${id}/status`, { status: "disabled" })}
        >
          {disableLabel}
        </Button>
      ) : (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => call(`/api/automations/${id}/status`, { status: "enabled" })}
        >
          {enableLabel}
        </Button>
      )}
      <Button
        variant="outline"
        disabled={busy || status !== "enabled"}
        onClick={() =>
          call(`/api/automations/${id}/run`, {}, { "Idempotency-Key": crypto.randomUUID() })
        }
      >
        {runLabel}
      </Button>
    </span>
  );
}
