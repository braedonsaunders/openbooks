"use client";

import { useId, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { fetchAction } from "@braedonsaunders/appkit-errors";
import { ActionAlert } from "@braedonsaunders/appkit-errors/react";
import { Button, Drawer, Label, SearchSelect, Textarea } from "@openbooks/ui";
import {
  TAX_BASIS_APPLICABLE_SIDE_LABELS,
  attachTaxBasisSource,
  taxBasisSideApplies,
  type TaxAssetBasisSourceChoice,
  type TaxAssetBasisSourcesResponse,
  type TaxBasisDraft,
  type TaxRegimeBasis,
} from "@openbooks/engine/src/tax-returns/asset-basis-policy.ts";
import { useAppAction } from "@/lib/use-app-action";
import { TaxBasisFields } from "./TaxBasisFields";
import { prepareTaxBasisRegime } from "./tax-basis-draft";
import { MacrsVintageAllocations } from "./MacrsVintageAllocations";
import {
  prepareMacrsVintageAllocations,
  type MacrsAllocationEdits,
} from "./macrs-vintage-allocation-draft";

/** Same stacked workpaper Drawer as GroupValuationButton; approved facts go
 * through Accounting changes, never the asset's mutable classification JSON. */
export function TaxBasisButton({ assetId }: { assetId: string }) {
  const router = useRouter();
  const formId = useId();
  const { busy, refusal, execute, refuse, clearRefusal } = useAppAction();
  const [open, setOpen] = useState(false);
  const [sources, setSources] = useState<TaxAssetBasisSourceChoice[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [sourceKey, setSourceKey] = useState("");
  const [drafts, setDrafts] = useState<Record<string, TaxBasisDraft>>({});
  const [allocationEdits, setAllocationEdits] = useState<MacrsAllocationEdits>(
    {},
  );
  const [reason, setReason] = useState("");
  const [assessment, setAssessment] = useState("");
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const source = sources.find((item) => item.key === sourceKey);
  const sellerMacrs = source?.regimes.some(
    ({ code, applicable }) =>
      code === "us_macrs" && taxBasisSideApplies(applicable, "seller"),
  );
  const macrsHistoryRefusal = sellerMacrs
    ? !source?.openMacrsVintages
      ? "The selected source has no tax depreciation history response. Reload the source history before proposing its workpaper."
      : source.openMacrsVintages.status === "history_refused"
        ? source.openMacrsVintages.refusal
        : null
    : null;
  function changed() {
    setRequestKey(crypto.randomUUID());
  }
  async function show() {
    setOpen(true);
    setLoaded(false);
    await execute(
      () =>
        fetchAction<TaxAssetBasisSourcesResponse>(
          `/api/assets/${assetId}/tax-basis`,
        ),
      {
        fallbackMessage: "Could not load the asset's tax workpapers",
        onOk: (result) => {
          setSources(result.sources);
          // A refreshed source must be reselected: a book correction may have
          // invalidated the source and its facts while this drawer was closed.
          setSourceKey("");
          setDrafts({});
          setAllocationEdits({});
          setLoaded(true);
          changed();
        },
      },
    );
  }
  function selectSource(key: string) {
    const selected = sources.find((item) => item.key === key);
    setSourceKey(key);
    setDrafts(
      Object.fromEntries(
        (selected?.regimes ?? []).map(({ code, applicable }) => [
          code,
          attachTaxBasisSource(
            { regime: code },
            {
              sourceOperation: selected!.sourceOperation,
              applicable,
              usSellerMacrs:
                code === "us_macrs" ? selected!.openMacrsVintages : null,
            },
          ),
        ]),
      ),
    );
    setAllocationEdits({});
    setReason("");
    setAssessment("");
    clearRefusal();
    changed();
  }
  async function propose(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!source || !loaded || !source.regimes.length || busy) return;
    const fallbackMessage = "Could not propose the tax basis workpaper";
    if (macrsHistoryRefusal) {
      refuse(macrsHistoryRefusal, fallbackMessage);
      return;
    }
    let regimes: TaxRegimeBasis[];
    try {
      regimes = source.regimes.map(({ code, applicable }) => {
        const draft = attachTaxBasisSource(drafts[code] ?? { regime: code }, {
          sourceOperation: source.sourceOperation,
          applicable,
          usSellerMacrs: code === "us_macrs" ? source.openMacrsVintages : null,
        });
        return prepareTaxBasisRegime(
          draft,
          {
            sourceOperation: source.sourceOperation,
            applicable,
            usSellerMacrs:
              code === "us_macrs" ? source.openMacrsVintages : null,
          },
          code === "us_macrs" &&
            taxBasisSideApplies(applicable, "seller") &&
            source.openMacrsVintages?.status === "ready"
            ? prepareMacrsVintageAllocations(
                source.openMacrsVintages.vintages,
                allocationEdits,
              )
            : undefined,
        );
      });
    } catch (error) {
      refuse(error instanceof Error ? error.message : null, fallbackMessage);
      return;
    }
    await execute(
      () =>
        fetchAction<{ changeId: string }>(`/api/assets/${assetId}/tax-basis`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sourceChangeId: source.sourceChangeId,
            ...(source.sourceEventId
              ? { sourceEventId: source.sourceEventId }
              : {}),
            regimes,
            assessment,
            reason,
            idempotencyKey: requestKey,
          }),
        }),
      {
        fallbackMessage,
        onOk: ({ changeId }) => {
          setOpen(false);
          router.push(
            `/accounting/changes?change=${encodeURIComponent(changeId)}`,
          );
        },
      },
    );
  }
  return (
    <>
      <Button variant="outline" onClick={show} disabled={busy}>
        Tax basis workpaper
      </Button>
      <Drawer
        stacked
        open={open}
        onClose={() => setOpen(false)}
        title="Asset tax basis workpaper"
        description="Record the statutory facts for a disposal or transfer. Independent approval is required before tax depreciation uses them."
        size="lg"
        footer={
          <Button
            type="submit"
            form={formId}
            disabled={
              busy ||
              !loaded ||
              !source?.regimes.length ||
              !!macrsHistoryRefusal
            }
          >
            Create approval proposal
          </Button>
        }
      >
        <form id={formId} className="space-y-5 p-4" onSubmit={propose}>
          <ActionAlert
            error={refusal}
            fallbackMessage="Could not prepare the tax basis workpaper"
          />
          <div className="space-y-1.5">
            <Label htmlFor={`${formId}-source`}>
              Posted disposal or transfer
            </Label>
            <SearchSelect
              id={`${formId}-source`}
              value={sourceKey}
              onChange={selectSource}
              disabled={busy || !loaded}
              placeholder="Select a posted source"
              options={sources.map((item) => ({
                value: item.key,
                label: [
                  item.occurredOn,
                  item.sourceKind.replaceAll("_", " "),
                  item.assetLabel,
                  item.subsidiaryLabel,
                  item.bookLabel,
                  item.receivingAssetLabel
                    ? `To ${item.receivingAssetLabel}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · "),
              }))}
            />
          </div>
          {loaded && !sources.length ? (
            <p>
              No unreversed posted disposal or transfer is available for this
              asset.
            </p>
          ) : null}
          {source ? (
            <>
              <p>
                Effective {source.occurredOn}. The date and legal entities
                follow the posted source.
              </p>
              {macrsHistoryRefusal ? (
                <div className="space-y-2">
                  <p role="alert">{macrsHistoryRefusal}</p>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={show}
                    disabled={busy}
                  >
                    Reload source history
                  </Button>
                </div>
              ) : null}
              {source.appliedWorkpaper ? (
                <p>
                  <Link
                    className="underline"
                    href={`/accounting/changes?change=${encodeURIComponent(source.appliedWorkpaper.changeId)}`}
                  >
                    Open existing workpaper ({source.appliedWorkpaper.status})
                  </Link>
                </p>
              ) : null}
              {!source.regimes.length ? (
                <p>
                  {source.sourceOperation === "intercompany_transfer"
                    ? "Assign the applicable tax classifications on the seller and/or receiving asset's Tax tab before proposing this workpaper."
                    : "Assign the seller asset's tax classification on its Tax tab before proposing this workpaper."}
                </p>
              ) : null}
              {source.regimes.map(({ code, name, applicable }) => (
                <fieldset key={code} className="space-y-3 rounded border p-4">
                  <legend className="px-1 font-semibold">
                    {name} · {TAX_BASIS_APPLICABLE_SIDE_LABELS[applicable]}
                  </legend>
                  <p className="text-sm text-muted-foreground">
                    {applicable === "seller"
                      ? `Applies to ${source.assetLabel}.`
                      : applicable === "buyer"
                        ? `Applies to ${source.receivingAssetLabel ?? "the receiving asset"}.`
                        : `Applies to ${source.assetLabel} and ${source.receivingAssetLabel ?? "the receiving asset"}.`}
                  </p>
                  {code === "us_macrs" &&
                  taxBasisSideApplies(applicable, "seller") &&
                  macrsHistoryRefusal ? null : (
                    <TaxBasisFields
                      draft={
                        drafts[code] ??
                        attachTaxBasisSource(
                          { regime: code },
                          {
                            sourceOperation: source.sourceOperation,
                            applicable,
                            usSellerMacrs:
                              code === "us_macrs"
                                ? source.openMacrsVintages
                                : null,
                          },
                        )
                      }
                      disabled={busy}
                      omitFields={
                        code === "us_macrs" &&
                        taxBasisSideApplies(applicable, "seller") &&
                        source.openMacrsVintages?.status === "ready"
                          ? [
                              "disposedUnadjustedBasis",
                              "remainingUnadjustedBasis",
                            ]
                          : []
                      }
                      onChange={(field, value) => {
                        setDrafts((current) => ({
                          ...current,
                          [code]: { ...current[code], [field]: value },
                        }));
                        changed();
                      }}
                    />
                  )}
                  {code === "us_macrs" &&
                  taxBasisSideApplies(applicable, "seller") &&
                  source.openMacrsVintages?.status === "ready" ? (
                    <MacrsVintageAllocations
                      vintages={source.openMacrsVintages.vintages}
                      edits={allocationEdits}
                      disabled={busy}
                      onChange={(key, field, value) => {
                        setAllocationEdits((current) => ({
                          ...current,
                          [key]: {
                            disposedUnadjustedBasis: "",
                            remainingUnadjustedBasis: "",
                            ...current[key],
                            [field]: value,
                          },
                        }));
                        changed();
                      }}
                    />
                  ) : null}
                </fieldset>
              ))}
              <div className="space-y-1.5">
                <Label htmlFor={`${formId}-assessment`}>
                  Statutory assessment and supporting evidence
                </Label>
                <Textarea
                  id={`${formId}-assessment`}
                  required
                  minLength={8}
                  maxLength={4000}
                  disabled={busy}
                  value={assessment}
                  onChange={(event) => {
                    setAssessment(event.target.value);
                    changed();
                  }}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${formId}-reason`}>Reason</Label>
                <Textarea
                  id={`${formId}-reason`}
                  required
                  minLength={8}
                  maxLength={1000}
                  disabled={busy}
                  value={reason}
                  onChange={(event) => {
                    setReason(event.target.value);
                    changed();
                  }}
                />
              </div>
            </>
          ) : null}
        </form>
      </Drawer>
    </>
  );
}
