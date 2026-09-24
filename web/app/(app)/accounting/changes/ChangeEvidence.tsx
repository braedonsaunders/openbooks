import { useTranslations } from "next-intl";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@openbooks/ui";
const fieldKeys = new Set([
  'existingId', 'existingObligationIds', 'ssp', 'standaloneSellingPrice', 'recognitionRuleId',
  'deferredAccountId', 'recognizedAccountId', 'totalAmount', 'catchUp', 'priorRecognized',
  'targetRecognized', 'remaining', 'netCredits', 'newTotal', 'pool',
  'remainingDistinct', 'additionsAtStandalonePrice', 'enforceableRightsEvidence', 'fxRate', 'bookId',
  'effectiveOn', 'scopeReductionPercent', 'commensurateStandalonePrice', 'additionalRightOfUse', 'transfersOwnership',
  'purchaseOptionReasonablyCertain', 'pvOfPayments', 'newRou', 'rouDelta', 'groupCarryingBefore',
  'groupCarryingAfter', 'groupValuationDelta', 'netAssets', 'nci', 'parentGain',
  'groupGain', 'recycledOci', 'transferredOci', 'totalGroupGain', 'retainedFairValue',
  'carryingLiability', 'carryingRou', 'stubInterest', 'stubRou', 'prepaidCarrying',
  'newLiability', 'liabilityDelta', 'removedLiability', 'removedRou', 'gain',
  'settlement', 'settlementPayment', 'payment', 'periods', 'annualRatePercent',
  'paymentTiming', 'paymentFrequency', 'assessment', 'dayCountPolicy', 'specializedAsset',
  'economicLifeMonths', 'leaseTermMonths', 'termThresholdPercent', 'fairValue', 'pvThresholdPercent',
]);
/** Review the complete frozen proposal, including nested assessment inputs.
 * This is record evidence, not a regenerated report or a live calculation. */
export function ChangeEvidence({
  value,
  names = {},
}: {
  value: unknown;
  names?: Record<string, string>;
}) {
  const t = useTranslations("accounting");
  if (value === null || value === undefined)
    return <span className="text-muted-foreground">{t("lifecycle.evidence.notSupplied")}</span>;
  if (typeof value === "boolean") return <span>{value ? t("lifecycle.evidence.yes") : t("lifecycle.evidence.no")}</span>;
  if (typeof value === "string" || typeof value === "number")
    return (
      <span className="break-words">
        {names[String(value)] ?? String(value).replaceAll("_", " ")}
      </span>
    );
  if (Array.isArray(value))
    return (
      <div className="space-y-3">
        {value.map((v, i) => (
          <div key={i} className="rounded border p-3">
            <ChangeEvidence value={v} names={names} />
          </div>
        ))}
      </div>
    );
  if (typeof value === "object")
    return (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("lifecycle.evidence.assessment")}</TableHead>
            <TableHead>{t("lifecycle.evidence.approvedProposal")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {Object.entries(value)
            .filter(([key]) => key !== "idempotencyKey")
            .map(([key, v]) => (
              <TableRow key={key}>
                <TableCell className="align-top">{fieldKeys.has(key) && t.has(`lifecycle.evidence.fields.${key}` as never)
                  ? t(`lifecycle.evidence.fields.${key}` as never)
                  : t("lifecycle.evidence.otherField")}</TableCell>
                <TableCell>
                  <ChangeEvidence value={v} names={names} />
                </TableCell>
              </TableRow>
            ))}
        </TableBody>
      </Table>
    );
  return null;
}


export function ChangeFacts({ value }: { value: Record<string, unknown> }) {
  const t = useTranslations("accounting");
  return (
    <dl className="grid grid-cols-2 gap-2">
      {Object.entries(value)
        .filter(([key, v]) => fieldKeys.has(key) && (typeof v === "string" || typeof v === "number" || typeof v === "boolean"))
        .map(([key, v]) => (
          <div key={key}>
            <dt className="text-sm text-slate-500">{t.has(`lifecycle.evidence.fields.${key}` as never)
              ? t(`lifecycle.evidence.fields.${key}` as never)
              : t("lifecycle.evidence.otherField")}</dt>
            <dd>{typeof v === "boolean" ? v ? t("lifecycle.evidence.yes") : t("lifecycle.evidence.no") : String(v).replaceAll("_", " ")}</dd>
          </div>
        ))}
    </dl>
  );
}
