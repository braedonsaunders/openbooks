"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  Button,
  Drawer,
  Input,
  Label,
  SearchSelect,
  Select,
  Textarea,
} from "@openbooks/ui";
import { useBusinessToday } from "@/components/business-date-provider";
import { readApiErrorMessage } from "@/lib/api-error";
import type {
  RevenueModificationInput,
  RevenueModificationPromise,
} from "@openbooks/engine/src/revenue/contract-modifications.ts";
import type { ContractPayload, RevenueModificationOptions } from "./_lib";
type Group = RevenueModificationInput["groups"][number];
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
export function ModifyContractButton({
  payload,
  options,
}: {
  payload: ContractPayload;
  options: RevenueModificationOptions;
}) {
  const t = useTranslations("revenue");
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        {t("modify.trigger")}
      </Button>
      {open ? (
        <Form
          payload={payload}
          options={options}
          close={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
function Form({
  payload,
  options,
  close,
}: {
  payload: ContractPayload;
  options: RevenueModificationOptions;
  close: () => void;
}) {
  const t = useTranslations("revenue");
  const router = useRouter(),
    today = useBusinessToday();
  const existing = payload.obligations.filter((o) => o.status !== "cancelled");
  const initial = (id?: string): RevenueModificationPromise => {
    const o = existing.find((o) => o.id === id);
    return {
      existingId: id,
      description: o?.description ?? "",
      standaloneSellingPrice:
        o?.standalone_selling_price ?? o?.allocated_price ?? "",
      recognitionRuleId:
        o?.recognition_rule_id ?? options.rules[0]?.value ?? "",
      recognitionEndsOn: o?.recognition_ends_on ?? null,
      percentComplete: o?.percent_complete ?? "0",
      deferredAccountId: o?.deferred_account_id ?? "",
      recognizedAccountId: o?.recognized_account_id ?? "",
    };
  };
  const empty = (): Group => ({
    treatment: "prospective",
    existingObligationIds: [],
    considerationChange: "0",
    remainingDistinct: false,
    additionsAtStandalonePrice: false,
    promises: [initial()],
  });
  const [groups, setGroups] = useState<Group[]>([
    {
      ...empty(),
      existingObligationIds: existing.map((o) => o.id),
      promises: existing.length
        ? existing.map((o) => initial(o.id))
        : [initial()],
    },
  ]);
  const [date, setDate] = useState(today),
    [reason, setReason] = useState(""),
    [rights, setRights] = useState(""),
    [assessment, setAssessment] = useState(""),
    [busy, setBusy] = useState(false),
    [key] = useState(() => crypto.randomUUID());
  const [subsidiaryId, setSubsidiary] = useState(
    payload.contract.subsidiary_id ??
      (options.subsidiaries.length === 1 ? options.subsidiaries[0]!.value : ""),
  );
  const [rates, setRates] = useState<Record<string, string>>({});
  const patch = (i: number, patch: Partial<Group>) =>
    setGroups((old) => old.map((g, n) => (n === i ? { ...g, ...patch } : g)));
  const promise = (
    i: number,
    n: number,
    patchValue: Partial<RevenueModificationPromise>,
  ) =>
    patch(i, {
      promises: groups[i]!.promises.map((p, k) =>
        k === n ? { ...p, ...patchValue } : p,
      ),
    });
  async function save() {
    setBusy(true);
    try {
      const owner = options.subsidiaries.find((s) => s.value === subsidiaryId);
      const body: RevenueModificationInput = {
        effectiveOn: date,
        reason,
        idempotencyKey: key,
        subsidiaryId,
        enforceableRightsEvidence: rights,
        assessment,
        groups,
        bookRates: options.books.map((b) => ({
          bookId: b.value,
          fxRate:
            rates[b.value] ??
            (!payload.contract.currency ||
            payload.contract.currency === owner?.currency
              ? "1"
              : ""),
        })),
      };
      const res = await fetch(
        `/api/revenue/contracts/${payload.contract.id}/modifications`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok)
        throw new Error(
          await readApiErrorMessage(res, t("modify.proposeFailed")),
        );
      const result = (await res.json()) as { changeId: string };
      close();
      router.push(`/accounting/changes?change=${result.changeId}`);
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("modify.saveFailed"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Drawer
      open
      onClose={close}
      stacked
      size="2xl"
      title={t("modify.title", { number: payload.contract.contract_number })}
      description={t("modify.description")}
    >
      <div className="space-y-5 p-4">
        <Field label={t("modify.fieldEffectiveDate")}>
          <Input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </Field>
        <Field label={t("modify.fieldEntity")}>
          <SearchSelect
            value={subsidiaryId}
            options={options.subsidiaries}
            onChange={(v) => setSubsidiary(v ?? "")}
            ariaLabel={t("modify.entityAria")}
          />
        </Field>
        {options.books.map((b) => (
          <Field key={b.value} label={t("modify.rateLabel", { book: b.label })}>
            <Input
              value={
                rates[b.value] ??
                (!payload.contract.currency ||
                payload.contract.currency ===
                  options.subsidiaries.find((s) => s.value === subsidiaryId)
                    ?.currency
                  ? "1"
                  : "")
              }
              onChange={(e) =>
                setRates((old) => ({ ...old, [b.value]: e.target.value }))
              }
            />
          </Field>
        ))}
        {groups.map((g, i) => (
          <section className="space-y-3 rounded-lg border p-3" key={i}>
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">
                {t("modify.groupTitle", { index: i + 1 })}
              </h3>
              {groups.length > 1 ? (
                <Button
                  variant="ghost"
                  onClick={() =>
                    setGroups((old) => old.filter((_, n) => n !== i))
                  }
                >
                  {t("modify.removeGroup")}
                </Button>
              ) : null}
            </div>
            <Field label={t("modify.treatment")}>
              <Select
                value={g.treatment}
                onChange={(e) =>
                  patch(i, { treatment: e.target.value as Group["treatment"] })
                }
              >
                {[
                  {
                    value: "prospective",
                    label: t("modify.treatProspective"),
                  },
                  {
                    value: "catch_up",
                    label: t("modify.treatCatchUp"),
                  },
                  {
                    value: "separate",
                    label: t("modify.treatSeparate"),
                  },
                ].map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t("modify.consideration")}>
              <Input
                value={g.considerationChange}
                onChange={(e) =>
                  patch(i, { considerationChange: e.target.value })
                }
              />
            </Field>
            <label className="flex gap-2 text-sm">
              <input
                type="checkbox"
                checked={g.remainingDistinct}
                onChange={(e) =>
                  patch(i, { remainingDistinct: e.target.checked })
                }
              />
              {t("modify.distinct")}
            </label>
            <label className="flex gap-2 text-sm">
              <input
                type="checkbox"
                checked={g.additionsAtStandalonePrice}
                onChange={(e) =>
                  patch(i, { additionsAtStandalonePrice: e.target.checked })
                }
              />
              {t("modify.commensurate")}
            </label>
            <p className="text-sm font-medium">{t("modify.affected")}</p>
            {existing.map((o) => (
              <label className="flex gap-2 text-sm" key={o.id}>
                <input
                  type="checkbox"
                  checked={g.existingObligationIds.includes(o.id)}
                  onChange={(e) =>
                    patch(i, {
                      existingObligationIds: e.target.checked
                        ? [...g.existingObligationIds, o.id]
                        : g.existingObligationIds.filter((id) => id !== o.id),
                    })
                  }
                />
                {o.description}
              </label>
            ))}
            <p className="text-xs text-muted-foreground">
              {t("modify.omittedHint")}
            </p>
            {g.promises.map((p, n) => (
              <div className="space-y-3 rounded border p-3" key={n}>
                <Field label={t("modify.promiseAfter")}>
                  <SearchSelect
                    value={p.existingId ?? "new"}
                    options={[
                      { value: "new", label: t("modify.newPromise") },
                      ...existing.map((o) => ({
                        value: o.id,
                        label: o.description,
                      })),
                    ]}
                    onChange={(v) =>
                      patch(i, {
                        promises: g.promises.map((old, k) =>
                          k === n
                            ? initial(
                                v === "new" ? undefined : (v ?? undefined),
                              )
                            : old,
                        ),
                      })
                    }
                    ariaLabel={t("modify.revisedAria")}
                  />
                </Field>
                <Field label={t("modify.fieldDescription")}>
                  <Input
                    value={p.description}
                    onChange={(e) =>
                      promise(i, n, { description: e.target.value })
                    }
                  />
                </Field>
                <Field label={t("modify.ssp")}>
                  <Input
                    value={p.standaloneSellingPrice}
                    onChange={(e) =>
                      promise(i, n, { standaloneSellingPrice: e.target.value })
                    }
                  />
                </Field>
                <Field label={t("modify.rule")}>
                  <SearchSelect
                    value={p.recognitionRuleId}
                    options={options.rules}
                    onChange={(v) =>
                      promise(i, n, { recognitionRuleId: v ?? "" })
                    }
                    ariaLabel={t("modify.ruleAria")}
                  />
                </Field>
                <Field label={t("modify.endsOn")}>
                  <Input
                    type="date"
                    value={p.recognitionEndsOn ?? ""}
                    onChange={(e) =>
                      promise(i, n, {
                        recognitionEndsOn: e.target.value || null,
                      })
                    }
                  />
                </Field>
                <Field label={t("modify.progress")}>
                  <Input
                    value={p.percentComplete}
                    onChange={(e) =>
                      promise(i, n, { percentComplete: e.target.value })
                    }
                  />
                </Field>
                <Field label={t("modify.deferred")}>
                  <SearchSelect
                    value={p.deferredAccountId}
                    options={options.accounts}
                    onChange={(v) =>
                      promise(i, n, { deferredAccountId: v ?? "" })
                    }
                    ariaLabel={t("modify.deferredAria")}
                  />
                </Field>
                <Field label={t("modify.recognized")}>
                  <SearchSelect
                    value={p.recognizedAccountId}
                    options={options.accounts}
                    onChange={(v) =>
                      promise(i, n, { recognizedAccountId: v ?? "" })
                    }
                    ariaLabel={t("modify.recognizedAria")}
                  />
                </Field>
                {["milestone", "usage"].includes(
                  options.rules.find((r) => r.value === p.recognitionRuleId)
                    ?.method ?? "",
                ) ? (
                  <div className="space-y-2">
                    {(p.events ?? []).map((event, ei) => (
                      <div key={ei} className="grid grid-cols-3 gap-2">
                        <Input
                          aria-label={t("modify.eventMonth")}
                          type="month"
                          value={event.periodMonth.slice(0, 7)}
                          onChange={(e) =>
                            promise(i, n, {
                              events: p.events!.map((row, k) =>
                                k === ei
                                  ? {
                                      ...row,
                                      periodMonth: `${e.target.value}-01`,
                                    }
                                  : row,
                              ),
                            })
                          }
                        />
                        <Input
                          aria-label={t("modify.eventAmount")}
                          value={event.amount}
                          onChange={(e) =>
                            promise(i, n, {
                              events: p.events!.map((row, k) =>
                                k === ei
                                  ? { ...row, amount: e.target.value }
                                  : row,
                              ),
                            })
                          }
                        />
                        <Input
                          aria-label={t("modify.eventEvidence")}
                          value={event.description}
                          onChange={(e) =>
                            promise(i, n, {
                              events: p.events!.map((row, k) =>
                                k === ei
                                  ? { ...row, description: e.target.value }
                                  : row,
                              ),
                            })
                          }
                        />
                      </div>
                    ))}
                    <Button
                      variant="outline"
                      onClick={() =>
                        promise(i, n, {
                          events: [
                            ...(p.events ?? []),
                            {
                              periodMonth: `${date.slice(0, 7)}-01`,
                              amount: "",
                              description: "",
                            },
                          ],
                        })
                      }
                    >
                      {t("modify.addEvent")}
                    </Button>
                  </div>
                ) : null}
                {g.promises.length > 1 ? (
                  <Button
                    variant="ghost"
                    onClick={() =>
                      patch(i, {
                        promises: g.promises.filter((_, k) => k !== n),
                      })
                    }
                  >
                    {t("modify.removePromise")}
                  </Button>
                ) : null}
              </div>
            ))}
            <Button
              variant="outline"
              onClick={() => patch(i, { promises: [...g.promises, initial()] })}
            >
              {t("modify.addPromise")}
            </Button>
          </section>
        ))}
        <Button
          variant="outline"
          onClick={() => setGroups((old) => [...old, empty()])}
        >
          {t("modify.addGroup")}
        </Button>
        <Field label={t("modify.rights")}>
          <Textarea
            value={rights}
            onChange={(e) => setRights(e.target.value)}
          />
        </Field>
        <Field label={t("modify.assessment")}>
          <Textarea
            value={assessment}
            onChange={(e) => setAssessment(e.target.value)}
          />
        </Field>
        <Field label={t("modify.reason")}>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
        <Button disabled={busy} onClick={save}>
          {t("modify.propose")}
        </Button>
      </div>
    </Drawer>
  );
}
