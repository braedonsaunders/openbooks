import { add, fromUnits, neg, sum, toUnits } from "../money/money.ts";
import { canonicalDecimal } from "../money/exact-decimal.ts";
const isZeroAmount = (amount: string) => toUnits(amount) === 0n;
export interface LossOfControlBalance {
  accountId: string;
  amount: string;
  description: string;
}
function money(value: string, label: string) {
  const n = canonicalDecimal(value, 4);
  if (
    n === null ||
    n.replace(/^-/, "").split(".")[0]!.replace(/^0+/, "").length > 15
  )
    throw new Error(`${label} must be an exact ledger amount`);
  return fromUnits(toUnits(n));
}
/** IFRS 10.25 and B98–B99. This is the consolidation adjustment AFTER the
 * parent's separately identified investment-disposal journal. Cash is not
 * booked twice. OCI components preserve their distinct recycle/RE treatment. */
export function measureLossOfControl(args: {
  netAssetBalances: LossOfControlBalance[];
  nciBalance: LossOfControlBalance | null;
  eliminatedInvestmentBalance: LossOfControlBalance;
  parentProceeds: string;
  parentInvestmentCarrying: string;
  parentRetainedCarrying: string;
  investmentTranslationAccountId?: string;
  retainedFairValue: string;
  retainedAccountId: string;
  gainLossAccountId: string;
  oci: {
    accountId: string;
    balance: string;
    treatment: "profit_loss" | "retained_earnings";
    destinationAccountId: string;
    description: string;
  }[];
}) {
  const proceeds = money(args.parentProceeds, "proceeds"),
    carrying = money(
      args.parentInvestmentCarrying,
      "investment carrying amount",
    ),
    retained = money(
      args.parentRetainedCarrying,
      "parent retained carrying value",
    ),
    fairValue = money(args.retainedFairValue, "retained interest fair value");
  if ([proceeds, carrying, retained, fairValue].some((v) => toUnits(v) < 0n))
    throw new Error(
      "proceeds, investment carrying value and retained interest measurements cannot be negative",
    );
  const netAssets = sum(
    args.netAssetBalances.map((l) =>
      money(l.amount, "consolidated asset/liability balance"),
    ),
  );
  const nci = args.nciBalance
    ? neg(money(args.nciBalance.amount, "non-controlling interest balance"))
    : "0.0000";
  const investment = money(
    args.eliminatedInvestmentBalance.amount,
    "eliminated investment",
  );
  const investmentTranslation = add(investment, carrying);
  if (
    toUnits(investmentTranslation) !== 0n &&
    !args.investmentTranslationAccountId
  )
    throw new Error(
      "reconcile the parent investment and its attributed consolidation elimination before recording loss of control",
    );
  const parentGain = add(add(proceeds, retained), neg(carrying));
  const groupGain = add(add(add(proceeds, fairValue), nci), neg(netAssets));
  const lines: LossOfControlBalance[] = [
    ...args.netAssetBalances.map((l) => ({
      ...l,
      amount: neg(money(l.amount, l.description)),
      description: `Derecognize ${l.description}`,
    })),
    {
      ...args.eliminatedInvestmentBalance,
      amount: neg(investment),
      description: "Release the disposed investment elimination",
    },
    ...(args.investmentTranslationAccountId &&
    !isZeroAmount(investmentTranslation)
      ? [
          {
            accountId: args.investmentTranslationAccountId,
            amount: investmentTranslation,
            description: "Release investment translation difference to OCI",
          },
        ]
      : []),
    ...(args.nciBalance
      ? [
          {
            ...args.nciBalance,
            amount: nci,
            description: "Derecognize non-controlling interests",
          },
        ]
      : []),
    {
      accountId: args.retainedAccountId,
      amount: add(fairValue, neg(retained)),
      description: "Remeasure retained interest to fair value",
    },
    {
      accountId: args.gainLossAccountId,
      amount: neg(add(groupGain, neg(parentGain))),
      description: "Consolidated loss-of-control gain or loss adjustment",
    },
  ];
  let recycledOci = "0.0000",
    transferredOci = "0.0000";
  for (const oci of args.oci) {
    const balance = money(oci.balance, "OCI balance");
    if (oci.accountId === oci.destinationAccountId)
      throw new Error(
        "OCI must be released to a distinct profit/loss or retained-earnings account",
      );
    lines.push(
      {
        accountId: oci.accountId,
        amount: neg(balance),
        description: `Release ${oci.description}`,
      },
      {
        accountId: oci.destinationAccountId,
        amount: balance,
        description:
          oci.treatment === "profit_loss"
            ? "Reclassify OCI to profit or loss"
            : "Transfer OCI directly to retained earnings",
      },
    );
    if (oci.treatment === "profit_loss")
      recycledOci = add(recycledOci, neg(balance));
    else transferredOci = add(transferredOci, neg(balance));
  }
  const nonzero = lines.filter((l) => toUnits(l.amount) !== 0n);
  if (toUnits(sum(nonzero.map((l) => l.amount))) !== 0n)
    throw new Error("loss-of-control adjustment does not balance");
  return {
    netAssets,
    nci,
    parentGain,
    groupGain,
    recycledOci,
    transferredOci,
    totalGroupGain: add(groupGain, recycledOci),
    retainedFairValue: fairValue,
    lines: nonzero,
  };
}
