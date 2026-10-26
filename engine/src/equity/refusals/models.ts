/** Refusals of scenario models: the pro-forma round and the exit waterfall. */
export const MODEL_REFUSALS = {
  exitValueInvalid: {
    code: "equity_waterfall_invalid",
    message:
      "“{field}” must be an amount with at most {places} decimal {placesCount, plural, one {place} other {places}}.",
    remedy: "Enter “{field}” as an amount, such as {example}.",
    params: { field: "term", places: "count", example: "money" },
  },
  transactionFeesInvalid: {
    code: "equity_waterfall_invalid",
    message:
      "“{field}” must be an amount with at most {places} decimal {placesCount, plural, one {place} other {places}}.",
    remedy:
      "Enter the fees paid from the exit under “{field}”, such as {example}, or leave it blank.",
    params: { field: "term", places: "count", example: "money" },
  },
  transactionFeesNegative: {
    code: "equity_waterfall_invalid",
    message: "The transaction fees cannot be negative.",
    remedy: "Enter the fees paid from the exit, or leave them blank.",
  },
  transactionFeesExceedExit: {
    code: "equity_waterfall_invalid",
    message: "The transaction fees exceed the exit value.",
    remedy: "Enter fees no greater than the exit value.",
  },
  exitValueNegative: {
    code: "equity_waterfall_invalid",
    message: "The exit value cannot be negative.",
    remedy: "Enter the proceeds available to equity holders.",
  },
  waterfallUnsettled: {
    code: "equity_waterfall_unsettled",
    status: 409,
    message: "The preferred classes' conversion choices do not settle at this exit value.",
    remedy:
      "Review the classes' preferences, participation caps and seniority, or model a different exit value.",
  },
  roundPreMoneyNotPositive: {
    code: "equity_round_terms_invalid",
    message: "The pre-money valuation must be greater than zero.",
    remedy: "Enter the pre-money valuation.",
  },
  roundInvestmentNotPositive: {
    code: "equity_round_terms_invalid",
    message: "The investment must be greater than zero.",
    remedy: "Enter the new money raised.",
  },
  roundTargetPoolOutOfRange: {
    code: "equity_round_terms_invalid",
    message: "The target pool must be at least {min} and below {max}.",
    remedy: "Enter the post-round pool target as a percentage.",
    params: { min: "percent", max: "percent" },
  },
  roundNoShares: {
    code: "equity_round_no_shares",
    message: "The company has no shares to price the round against.",
    remedy: "Record the company's issued shares before modelling a round.",
  },
  roundUnpriceable: {
    code: "equity_round_unpriceable",
    message:
      "No positive price satisfies these terms: the converting instruments and pool top-up claim the whole pre-money valuation.",
    remedy:
      "Raise the pre-money valuation, lower the pool target, or review the caps and discounts of the converting instruments.",
  },
  roundInvestmentBelowOneShare: {
    code: "equity_round_terms_invalid",
    message: "The investment buys less than one share at the round price.",
    remedy: "Raise the investment or lower the pre-money valuation.",
  },
} as const;
