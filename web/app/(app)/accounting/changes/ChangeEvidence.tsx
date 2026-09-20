import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@openbooks/ui";
const labels: Record<string, string> = {
  existingId: "Existing performance obligation",
  existingObligationIds: "Promises affected",
  ssp: "Standalone selling price",
  standaloneSellingPrice: "Extended standalone selling price",
  recognitionRuleId: "Recognition rule",
  deferredAccountId: "Deferred revenue / contract asset",
  recognizedAccountId: "Revenue account",
  totalAmount: "Total allocation",
  catchUp: "Immediate revenue adjustment",
  priorRecognized: "Previously earned revenue",
  targetRecognized: "Revised cumulative earned revenue",
  remaining: "Future recognition",
  netCredits: "Credits already applied to deferred revenue",
  newTotal: "Revised total consideration",
  pool: "Consideration allocated by SSP",
  remainingDistinct: "Remaining promises are distinct",
  additionsAtStandalonePrice: "Additions priced at standalone selling prices",
  enforceableRightsEvidence: "Evidence of enforceable amended rights",
  fxRate: "Recognition exchange rate",
  bookId: "Accounting book",
  effectiveOn: "Effective date",
  scopeReductionPercent: "Right-of-use scope removed (%)",
  commensurateStandalonePrice: "Added right priced at standalone price",
  additionalRightOfUse: "Additional right of use",
  transfersOwnership: "Ownership transfers",
  purchaseOptionReasonablyCertain: "Purchase option reasonably certain",
  pvOfPayments: "Present value of payments",
  newRou: "Revised right-of-use asset",
  rouDelta: "Right-of-use adjustment",
};
function label(key: string) {
  return (
    labels[key] ??
    key
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replaceAll("_", " ")
      .replace(/^./, (s) => s.toUpperCase())
  );
}
/** Review the complete frozen proposal, including nested assessment inputs.
 * This is record evidence, not a regenerated report or a live calculation. */
export function ChangeEvidence({
  value,
  names = {},
}: {
  value: unknown;
  names?: Record<string, string>;
}) {
  if (value === null || value === undefined)
    return <span className="text-muted-foreground">Not supplied</span>;
  if (typeof value === "boolean") return <span>{value ? "Yes" : "No"}</span>;
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
            <TableHead>Assessment / measurement</TableHead>
            <TableHead>Approved proposal</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {Object.entries(value)
            .filter(([key]) => key !== "idempotencyKey")
            .map(([key, v]) => (
              <TableRow key={key}>
                <TableCell className="align-top">{label(key)}</TableCell>
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
