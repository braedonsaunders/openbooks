/** Refusals of the capital structure: share classes and their amendments, splits, plans and their reserves, rounds and their corrections. */
export const STRUCTURE_REFUSALS = {
  authorizedExceeded: {
    code: "equity_authorized_exceeded",
    status: 409,
    message:
      "Class {shareClass} would commit {committed} {committedCount, plural, one {share} other {shares}} on {date} but authorizes {authorized}.",
    remedy:
      "{purpose, select, authorized_amendment {Authorize at least {committed} {committedCount, plural, one {share} other {shares}} of class {shareClass}: its outstanding shares, outstanding awards and unallocated plan pools need them on {date}.} reserve_increase {Add no more than {room} {roomCount, plural, one {share} other {shares}} to the reserve, or first record an authorized-share amendment raising class {shareClass} to at least {committed} {committedCount, plural, one {share} other {shares}}.} plan {Reserve no more than {room} {roomCount, plural, one {share} other {shares}}, or first record an authorized-share amendment raising class {shareClass} to at least {committed} {committedCount, plural, one {share} other {shares}}.} reversal {Record an authorized-share amendment raising class {shareClass} to at least {committed} {committedCount, plural, one {share} other {shares}} before reversing the event.} other {Record an authorized-share amendment raising class {shareClass} to at least {committed} {committedCount, plural, one {share} other {shares}}, or issue {excess} fewer {excessCount, plural, one {share} other {shares}}.}}",
    params: {
      shareClass: "text",
      committed: "shares",
      authorized: "shares",
      excess: "shares",
      room: "shares",
      date: "date",
      purpose: "choice",
    },
  },
  poolExhausted: {
    code: "equity_pool_exhausted",
    status: 409,
    message:
      "Plan {plan} would have {available} {availableCount, plural, one {share} other {shares}} available on {date}.",
    remedy:
      "{action, select, reduce {Remove no more than {maximum} {maximumCount, plural, one {share} other {shares}} from the reserve of plan {plan} from {from}; the rest is granted to awards.} empty {Plan {plan} has no unallocated shares to remove on or after {from}; forfeit or cancel awards first.} other {Grant {shortfall} fewer {shortfallCount, plural, one {unit} other {units}}, or first increase the reserve of plan {plan}.}}",
    params: {
      plan: "text",
      available: "shares",
      date: "date",
      from: "date",
      maximum: "shares",
      shortfall: "shares",
      action: "choice",
    },
  },
  classIdUnknown: {
    code: "equity_class_unknown",
    status: 404,
    message: "The share class does not exist.",
    remedy: "Choose a share class.",
  },
  planIdUnknown: {
    code: "equity_plan_unknown",
    status: 404,
    message: "The plan does not exist.",
    remedy: "Choose a plan.",
  },
  roundIdUnknown: {
    code: "equity_round_unknown",
    status: 404,
    message: "The round does not exist.",
    remedy: "Choose a round of the legal entity.",
  },
  authorizedSharesNotPositive: {
    code: "equity_shares_invalid",
    message: "Authorize at least one share.",
    remedy: "Enter at least one share under “{field}”.",
    params: { field: "term" },
  },
  parValueNegative: {
    code: "equity_decimal_invalid",
    message: "The par value cannot be negative.",
    remedy: "Enter the par value per share under “{field}” (zero for no-par stock).",
    params: { field: "term" },
  },
  classKindInvalid: {
    code: "equity_class_kind_invalid",
    message: "A share class is either common or preferred.",
    remedy: "Choose common or preferred under “{field}”.",
    params: { field: "term" },
  },
  classSeniorityInvalid: {
    code: "equity_class_terms_invalid",
    message: "Seniority must be a whole number from {min} to {max}.",
    remedy:
      "Enter “{field}” as a whole number from {min} to {max}; a higher seniority is paid first.",
    params: { field: "term", min: "count", max: "count" },
  },
  preferredPricesNotPositive: {
    code: "equity_class_terms_invalid",
    message: "Preferred stock needs a positive original issue price and conversion price.",
    remedy:
      "Enter the price the class was sold at under “{issue}”, and a conversion price above zero under “{conversion}” if it differs.",
    params: { issue: "term", conversion: "term" },
  },
  liquidationMultipleNegative: {
    code: "equity_class_terms_invalid",
    message: "The liquidation multiple cannot be negative.",
    remedy: "Enter “{field}” as zero or more, such as {example}.",
    params: { field: "term", example: "multiple" },
  },
  participationCapNotAboveMultiple: {
    code: "equity_class_terms_invalid",
    message: "The participation cap of {cap} must exceed the liquidation multiple of {multiple}.",
    remedy: "Enter “{field}” above {multiple}.",
    params: { field: "term", cap: "multiple", multiple: "multiple" },
  },
  liquidationPreferenceBasisInvalid: {
    code: "equity_class_terms_invalid",
    message: "Choose what the liquidation preference is measured on.",
    remedy:
      "Choose the amount paid for each certificate or the original issue price of the class under “{field}”.",
    params: { field: "term" },
  },
  classCodeTaken: {
    code: "equity_class_code_taken",
    status: 409,
    message: "Class code {code} is already used by this legal entity.",
    remedy: "Choose a different class code.",
    params: { code: "text" },
  },
  conversionClassRequired: {
    code: "equity_class_terms_invalid",
    message: "Choose the common class the preferred shares convert into.",
    remedy:
      "Choose a common class of the legal entity under “{field}”, recording it first if needed.",
    params: { field: "term" },
  },
  conversionClassNotYetEffective: {
    code: "equity_date_invalid",
    message: "Class {target} is not effective until {date}.",
    remedy: "Date the class on or after {date}, or choose another conversion class.",
    params: { target: "text", date: "date" },
  },
  conversionClassNotEffectiveForAmendment: {
    code: "equity_date_invalid",
    message: "Class {target} is not effective until {date}.",
    remedy: "Date the amendment on or after {date}.",
    params: { target: "text", date: "date" },
  },
  conversionClassOnCommon: {
    code: "equity_class_terms_invalid",
    message: "Only a preferred class converts into another class.",
    remedy: "Clear “{field}”.",
    params: { field: "term" },
  },
  conversionClassAmendmentOnCommon: {
    code: "equity_class_terms_invalid",
    message: "Only a preferred class converts into another class.",
    remedy: "Amend the authorized shares instead.",
  },
  conversionPriceAmendmentOnCommon: {
    code: "equity_class_terms_invalid",
    message: "Only a preferred class has a conversion price.",
    remedy: "Amend the authorized shares instead.",
  },
  conversionPriceNotPositive: {
    code: "equity_class_terms_invalid",
    message: "The conversion price must be greater than zero.",
    remedy: "Enter the new conversion price under “{field}”.",
    params: { field: "term" },
  },
  classAmendmentBeforeClass: {
    code: "equity_date_invalid",
    message: "An amendment cannot precede the effective date of class {shareClass} ({date}).",
    remedy: "Date the amendment on or after {date}.",
    params: { shareClass: "text", date: "date" },
  },
  conversionClassUnchanged: {
    code: "equity_amendment_unchanged",
    status: 409,
    message: "Class {shareClass} already converts into {target}.",
    remedy: "Choose a different conversion class.",
    params: { shareClass: "text", target: "text" },
  },
  conversionClassSplitRecorded: {
    code: "equity_amendment_backdated",
    status: 409,
    message:
      "A split of the conversion class is recorded on {date}; changing the conversion class before it would reinterpret it.",
    remedy: "Date the amendment after {date}.",
    params: { date: "date" },
  },
  classAmendmentKindInvalid: {
    code: "equity_amendment_invalid",
    message: "Choose what the amendment changes.",
    remedy: "Amend the authorized shares, the conversion price or the conversion class.",
  },
  splitRatioInvalid: {
    code: "equity_split_ratio_invalid",
    message: "A split ratio needs two different positive whole numbers.",
    remedy:
      "Enter the new and old share counts of the split under “{newShares}” and “{oldShares}”, such as 2 for 1 or 1 for 10.",
    params: { newShares: "term", oldShares: "term" },
  },
  splitBackdated: {
    code: "equity_split_backdated",
    status: 409,
    message:
      "Class {shareClass} has activity recorded through {date}; a split must be dated after it.",
    remedy: "Date the split after {date}.",
    params: { shareClass: "text", date: "date" },
  },
  splitBackdatedByConversion: {
    code: "equity_split_backdated",
    status: 409,
    message:
      "Class {shareClass} converts into {splitClass} and has activity recorded through {date}; the split adjusts its conversion price, so it must be dated after that.",
    remedy: "Date the split after {date}.",
    params: { shareClass: "text", splitClass: "text", date: "date" },
  },
  splitConversionClassMissing: {
    code: "equity_conversion_class_missing",
    status: 409,
    message:
      "Preferred {codes} {classesCount, plural, one {does not name the common class it converts into, so the effect of the split on its conversion price is unknown.} other {do not name the common class they convert into, so the effect of the split on their conversion price is unknown.}}",
    remedy:
      "Record the class each preferred class converts into (Share classes → Amend → “{field}”), then record the split.",
    params: { codes: "list", classes: "count", field: "term" },
  },
  planReserveNotPositive: {
    code: "equity_shares_invalid",
    message: "Reserve at least one share.",
    remedy: "Enter the shares reserved for the plan under “{field}”.",
    params: { field: "term" },
  },
  planBeforeClass: {
    code: "equity_date_invalid",
    message: "A plan cannot precede its share class, effective {date}.",
    remedy: "Date the plan on or after {date}.",
    params: { date: "date" },
  },
  planCodeTaken: {
    code: "equity_plan_code_taken",
    status: 409,
    message: "Plan code {code} is already used by this legal entity.",
    remedy: "Choose a different plan code.",
    params: { code: "text" },
  },
  reserveChangeInvalid: {
    code: "equity_shares_invalid",
    message: "The reserve change must be a nonzero whole number of shares.",
    remedy: "Enter the shares to add under “{field}”, or a negative number to remove shares.",
    params: { field: "term" },
  },
  reserveChangeBeforePlan: {
    code: "equity_date_invalid",
    message: "A reserve change cannot precede plan {plan}, effective {date}.",
    remedy: "Date the change on or after {date}.",
    params: { plan: "text", date: "date" },
  },
  preMoneyUnmeasurable: {
    code: "equity_round_pre_money_inconsistent",
    message:
      "A pre-money valuation of {preMoney} cannot be checked against the round price of {price}: no shares are outstanding before the round.",
    remedy: "State the basis of the valuation under “{field}”.",
    params: { preMoney: "money", price: "price", field: "term" },
  },
  preMoneyInconsistent: {
    code: "equity_round_pre_money_inconsistent",
    message:
      "A pre-money valuation of {preMoney} does not match the round price of {price} times the {fullyDiluted} fully diluted {fullyDilutedCount, plural, one {share} other {shares}} before the round ({implied}).",
    remedy:
      "Enter a pre-money valuation of {implied} or a price per share of {impliedPrice}; if the valuation is stated on another basis (a pool increase or conversions counted in it), state that basis under “{field}”.",
    params: {
      preMoney: "money",
      price: "price",
      fullyDiluted: "shares",
      implied: "money",
      impliedPrice: "price",
      field: "term",
    },
  },
  preMoneyInconsistentPriceLocked: {
    code: "equity_round_pre_money_inconsistent",
    message:
      "A pre-money valuation of {preMoney} does not match the round price of {price} times the {fullyDiluted} fully diluted {fullyDilutedCount, plural, one {share} other {shares}} before the round ({implied}).",
    remedy:
      "Enter a pre-money valuation of {implied} (the price stays at {price}, since live securities were issued or converted at it); if the valuation is stated on another basis (a pool increase or conversions counted in it), state that basis under “{field}”.",
    params: {
      preMoney: "money",
      price: "price",
      fullyDiluted: "shares",
      implied: "money",
      field: "term",
    },
  },
  preMoneyInconsistentValuationOnly: {
    code: "equity_round_pre_money_inconsistent",
    message:
      "A pre-money valuation of {preMoney} does not match the round price of {price} times the {fullyDiluted} fully diluted {fullyDilutedCount, plural, one {share} other {shares}} before the round ({implied}).",
    remedy:
      "Enter a pre-money valuation of {implied}; if the valuation is stated on another basis (a pool increase or conversions counted in it), state that basis under “{field}”.",
    params: {
      preMoney: "money",
      price: "price",
      fullyDiluted: "shares",
      implied: "money",
      field: "term",
    },
  },
  roundPricePerShareNotPositive: {
    code: "equity_round_terms_invalid",
    message: "The price per share must be greater than zero.",
    remedy: "Enter the price per share of the round under “{field}”.",
    params: { field: "term" },
  },
  roundPreMoneyValuationNotPositive: {
    code: "equity_round_terms_invalid",
    message: "The pre-money valuation must be greater than zero.",
    remedy: "Enter the pre-money valuation under “{field}”.",
    params: { field: "term" },
  },
  roundBeforeClass: {
    code: "equity_date_invalid",
    message: "A round cannot close before its share class is effective on {date}.",
    remedy: "Date the round on or after {date}.",
    params: { date: "date" },
  },
  roundNameTaken: {
    code: "equity_round_name_taken",
    status: 409,
    message:
      "A round named {name} already exists for this legal entity, or did before it was renamed or voided.",
    remedy: "Choose a different round name.",
    params: { name: "text" },
  },
  roundNameTooLong: {
    code: "equity_text_invalid",
    message: "The round name must be at most {max} characters.",
    remedy: "Shorten “{field}” to at most {max} characters.",
    params: { field: "term", max: "count" },
  },
  roundIsVoid: {
    code: "equity_round_void",
    status: 409,
    message: "The round is void.",
    remedy: "Record a new round if it is still needed; a void round takes no further changes.",
  },
  roundTermsUnchanged: {
    code: "equity_amendment_unchanged",
    status: 409,
    message: "Round {round} already has these terms.",
    remedy: "Change the name, the price per share or the pre-money valuation.",
    params: { round: "text" },
  },
  roundAmendmentBeforeClose: {
    code: "equity_date_invalid",
    message: "An amendment cannot precede the closing date of round {round} ({date}).",
    remedy: "Date the amendment on or after {date}.",
    params: { round: "text", date: "date" },
  },
  roundPriceLockedBySecurities: {
    code: "equity_round_has_securities",
    status: 409,
    message: "Round {round} has issued or converted {securities} at its price.",
    remedy:
      "Void those certificates first (each void reverses its entry), then amend the price and record them again; or record the correct round and void this one once it is empty.",
    params: { round: "text", securities: "list" },
  },
  roundVoidBeforeClose: {
    code: "equity_date_invalid",
    message: "The void cannot precede the closing date of round {round} ({date}).",
    remedy: "Date the void on or after {date}.",
    params: { round: "text", date: "date" },
  },
  roundVoidHasSecurities: {
    code: "equity_round_has_securities",
    status: 409,
    message: "Round {round} still has {securities} issued or converted in it.",
    remedy:
      "Void those certificates first (each void reverses its entry and returns a converted SAFE or note to outstanding), then void the round.",
    params: { round: "text", securities: "list" },
  },
  antiDilutionBaseMissing: {
    code: "equity_anti_dilution_base_missing",
    message: "The weighted-average adjustment needs the shares outstanding before the round.",
    remedy: "Record the outstanding shares of the company before modelling the round.",
  },
} as const;
