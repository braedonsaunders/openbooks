/** Refusals of security events (exercise, settlement, forfeiture, expiry, cancellation, repurchase, transfer, conversion, repayment, void, reversal, 83(b) election) and of MFN elections. */
export const EVENT_REFUSALS = {
  eventKindMissing: {
    code: "equity_event_invalid",
    message: "Choose what happened to the security.",
    remedy: "Choose an event kind.",
  },
  eventNotApplicable: {
    code: "equity_event_invalid",
    message:
      "{event, select, exercise {An exercise} settle {A settlement} forfeit {A forfeiture} expire {An expiry} cancel {A cancellation} repurchase {A repurchase} transfer {A transfer} convert {A conversion} void {A void} repay {A repayment} reverse {A reversal} election_83b {An 83(b) election} other {This event}} cannot be recorded on {kind, select, share {a share certificate} option {an option} rsu {an RSU} warrant {a warrant} safe {a SAFE} note {a convertible note} other {this security}}.",
    remedy: "Choose an event that applies to this security.",
    params: { event: "choice", kind: "choice" },
  },
  eventSecurityVoid: {
    code: "equity_security_void",
    status: 409,
    message: "Security {security} is void.",
    remedy: "A void security takes no further events; record the event on a security that stands.",
    params: { security: "text" },
  },
  eventBeforeIssue: {
    code: "equity_event_invalid",
    message: "The event cannot precede the issue date, {issueDate}.",
    remedy: "Date the event on or after {issueDate}.",
    params: { issueDate: "date" },
  },
  eventQuantityNotPositive: {
    code: "equity_event_invalid",
    message: "The quantity must be at least one share.",
    remedy: "Enter a quantity of at least one under “{field}”.",
    params: { field: "term" },
  },
  convertibleNotOutstanding: {
    code: "equity_convertible_settled",
    status: 409,
    message:
      "Security {security} is {status, select, outstanding {outstanding} exercised {exercised} settled {settled} forfeited {forfeited} expired {expired} cancelled {cancelled} repurchased {repurchased} transferred {transferred} converted {converted} void {void} repaid {repaid} not_issued {not yet issued} other {no longer outstanding}} as of {date}.",
    remedy:
      "Record a settlement only on an outstanding SAFE or note; reverse the earlier settlement first if it was recorded in error.",
    params: { security: "text", status: "choice", date: "date" },
  },
  exerciseAfterExpiry: {
    code: "equity_security_expired",
    status: 409,
    message: "Security {security} expired on {date}.",
    remedy: "Record the expiry instead.",
    params: { security: "text", date: "date" },
  },
  nothingVestedUntilNext: {
    code: "equity_event_nothing_vested",
    status: 409,
    message:
      "Every unit of {security} vested by {date} is already {event, select, exercise {exercised} other {settled}} or no longer outstanding; the next units vest on {nextVest}.",
    remedy: "Set “{field}” on or after {nextVest}, when the next units vest.",
    params: { security: "text", date: "date", event: "choice", nextVest: "date", field: "term" },
  },
  nothingVestedYet: {
    code: "equity_event_nothing_vested",
    status: 409,
    message: "Nothing on {security} is vested yet on {date}; the first units vest on {nextVest}.",
    remedy: "Set “{field}” on or after {nextVest}, when the first units vest.",
    params: { security: "text", date: "date", nextVest: "date", field: "term" },
  },
  nothingVestedEver: {
    code: "equity_event_nothing_vested",
    status: 409,
    message:
      "No units of {security} are vested and {event, select, exercise {unexercised} other {unsettled}} on {date}, and no further units vest under its schedule.",
    remedy:
      "Review the award's history: every vested unit is already exercised, settled, forfeited or expired.",
    params: { security: "text", event: "choice", date: "date" },
  },
  exerciseExceedsOutstanding: {
    code: "equity_event_exceeds_vested",
    status: 409,
    message:
      "Only {ceiling} {ceilingCount, plural, one {unit is} other {units are}} outstanding on {date}.",
    remedy: "Exercise no more than {ceiling} {ceilingCount, plural, one {unit} other {units}}.",
    params: { ceiling: "shares", date: "date" },
  },
  exerciseExceedsVested: {
    code: "equity_event_exceeds_vested",
    status: 409,
    message:
      "Only {ceiling} {ceilingCount, plural, one {unit is} other {units are}} vested and {event, select, exercise {unexercised} other {unsettled}} on {date}.",
    remedy:
      "Record no more than {ceiling} {ceilingCount, plural, one {unit} other {units}}; unvested units cannot be {event, select, exercise {exercised} other {settled}}.",
    params: { ceiling: "shares", event: "choice", date: "date" },
  },
  earlyExerciseTermsMissing: {
    code: "equity_repurchase_terms_missing",
    status: 409,
    message:
      "Grant {security} does not record the price at which the company repurchases unvested shares.",
    remedy:
      "Exercise no more than the {ceiling} vested {ceilingCount, plural, one {unit} other {units}}.",
    params: { security: "text", ceiling: "shares" },
  },
  exerciseBelowPar: {
    code: "equity_below_par",
    status: 409,
    message: "The shares would be issued below par value.",
    remedy: "Review the exercise price and the class's par value.",
  },
  eventExceedsHolding: {
    code: "equity_event_exceeds_holding",
    status: 409,
    message:
      "Only {ceiling} {ceilingCount, plural, one {unit is} other {units are}} {event, select, forfeit {unvested} expire {vested and unexercised} other {outstanding}} on {date}.",
    remedy: "Record no more than {ceiling} {ceilingCount, plural, one {unit} other {units}}.",
    params: { ceiling: "shares", event: "choice", date: "date" },
  },
  repurchaseExceedsOutstanding: {
    code: "equity_event_exceeds_holding",
    status: 409,
    message:
      "Only {ceiling} {ceilingCount, plural, one {share is} other {shares are}} outstanding on {date}.",
    remedy: "Repurchase no more than {ceiling} {ceilingCount, plural, one {share} other {shares}}.",
    params: { ceiling: "shares", date: "date" },
  },
  restrictedRepurchaseMixed: {
    code: "equity_restricted_repurchase_mixed",
    status: 409,
    message:
      "{ceiling} of the shares {ceilingCount, plural, one {is} other {are}} unvested on {date}; the company repurchases unvested shares on the grant's terms.",
    remedy:
      "Repurchase the {ceiling} unvested {ceilingCount, plural, one {share} other {shares}} first, then record a separate repurchase of vested shares.",
    params: { ceiling: "shares", date: "date" },
  },
  restrictedRepurchaseTermsMissing: {
    code: "equity_repurchase_terms_missing",
    status: 409,
    message: "Grant {grant} does not record the repurchase price of unvested shares.",
    remedy: "Record “{field}” on the grant's terms before repurchasing unvested shares.",
    params: { grant: "text", field: "term" },
  },
  repurchaseFairValueMissing: {
    code: "equity_event_invalid",
    message:
      "The grant repurchases unvested shares at the lower of cost and fair market value, so the fair market value on the repurchase date is required.",
    remedy: "Enter “{field}” on the repurchase date.",
    params: { field: "term" },
  },
  repurchaseFairValueNegative: {
    code: "equity_event_invalid",
    message: "“{field}” cannot be negative.",
    remedy: "Enter “{field}” as zero or more.",
    params: { field: "term" },
  },
  repurchasePriceFixed: {
    code: "equity_repurchase_price_fixed",
    status: 409,
    message: "The grant prices this repurchase at {amount}.",
    remedy: "Clear “{field}”; the repurchase price follows the grant's terms.",
    params: { amount: "money", field: "term" },
  },
  earlyExerciseDepositUnreconciled: {
    code: "equity_deposit_unreconciled",
    status: 409,
    message: "The early-exercise deposit of {security} is not on the ledger.",
    remedy:
      "Review the exercise entry in the journal; the deposit is credited by the exercise and released by the compensation run.",
    params: { security: "text" },
  },
  repurchaseAmountNegative: {
    code: "equity_event_invalid",
    message: "“{field}” cannot be negative.",
    remedy: "Enter the cash paid for the shares under “{field}”.",
    params: { field: "term" },
  },
  transfereeIsHolder: {
    code: "equity_event_invalid",
    message: "The transferee is already the holder.",
    remedy: "Choose a different holder under “{field}”.",
    params: { field: "term" },
  },
  transferExceedsVested: {
    code: "equity_event_exceeds_vested",
    status: 409,
    message:
      "Only {ceiling} vested {ceilingCount, plural, one {unit} other {units}} can be transferred on {date}.",
    remedy: "Transfer no more than {ceiling} {ceilingCount, plural, one {unit} other {units}}.",
    params: { ceiling: "shares", date: "date" },
  },
  conversionNotPreferred: {
    code: "equity_event_invalid",
    message: "Only preferred shares convert into common.",
    remedy: "Choose a preferred share certificate.",
  },
  conversionTargetMissing: {
    code: "equity_event_invalid",
    message: "Choose the common class the shares convert into.",
    remedy: "Choose a common class of the legal entity.",
  },
  conversionClassMismatch: {
    code: "equity_event_invalid",
    status: 409,
    message: "Class {shareClass} converts into {target}.",
    remedy: "Convert into the class's conversion class, or amend the conversion class first.",
    params: { shareClass: "text", target: "text" },
  },
  conversionClassMismatchUnnamed: {
    code: "equity_event_invalid",
    status: 409,
    message: "Class {shareClass} converts into another common class.",
    remedy: "Convert into the class's conversion class, or amend the conversion class first.",
    params: { shareClass: "text" },
  },
  conversionClassNotEffective: {
    code: "equity_event_invalid",
    message: "Class {shareClass} is not effective until {date}.",
    remedy: "Date the conversion on or after {date}.",
    params: { shareClass: "text", date: "date" },
  },
  conversionExceedsHolding: {
    code: "equity_event_exceeds_holding",
    status: 409,
    message:
      "Only {ceiling} {ceilingCount, plural, one {share} other {shares}} can convert on {date}.",
    remedy: "Convert no more than {ceiling} {ceilingCount, plural, one {share} other {shares}}.",
    params: { ceiling: "shares", date: "date" },
  },
  conversionBelowOneCommon: {
    code: "equity_event_invalid",
    message: "The shares convert into less than one common share.",
    remedy: "Convert more shares.",
  },
  conversionRoundMissing: {
    code: "equity_event_invalid",
    message: "Choose the round the instrument converts in.",
    remedy: "Choose a round of the legal entity.",
  },
  conversionOffClosingDate: {
    code: "equity_event_invalid",
    message: "Round {round} closed on {date}; an instrument converts in it on its closing date.",
    remedy: "Date the conversion on {date}.",
    params: { round: "text", date: "date" },
  },
  conversionTermsVoid: {
    code: "equity_conversion_terms_void",
    status: 409,
    message:
      "The MFN election on {security} of {electedOn} adopted the terms of {source}, which is void as of {voidedOn}.",
    remedy:
      "Reverse the MFN election on {security}, dated on or before {closedOn} (Securities → {security} → MFN terms → Reverse election), then convert it again on the terms that stand.",
    params: {
      security: "text",
      electedOn: "date",
      source: "text",
      voidedOn: "date",
      closedOn: "date",
    },
  },
  conversionBelowOneShare: {
    code: "equity_event_invalid",
    status: 409,
    message: "The instrument converts into less than one share.",
    remedy: "Review the round price and the instrument's terms.",
  },
  convertingAmountUnreconciled: {
    code: "equity_interest_unreconciled",
    status: 409,
    message: "The converting amount of {security} does not match what the ledger carries.",
    remedy: "Review the instrument's issuance and interest entries in the journal.",
    params: { security: "text" },
  },
  conversionBelowPar: {
    code: "equity_below_par",
    status: 409,
    message: "The conversion would issue shares below par value.",
    remedy: "Review the round price and the class's par value.",
  },
  repaymentAmountMissing: {
    code: "equity_event_invalid",
    message: "The amount repaid must be more than zero.",
    remedy: "Enter the cash paid to the holder under “{field}”.",
    params: { field: "term" },
  },
  safeRepaymentAmount: {
    code: "equity_repayment_amount",
    status: 409,
    message: "A SAFE is repaid at its purchase amount, {amount}.",
    remedy:
      "Record the repayment at the purchase amount; record any settlement difference as a separate journal entry.",
    params: { amount: "money" },
  },
  voidMfnSource: {
    code: "equity_void_mfn_source",
    status: 409,
    message:
      "{safe} adopted the terms of {security} by its MFN election of {electedOn}; voiding {security} would leave that election naming terms entered in error.",
    remedy:
      "Reverse the MFN election on {safe} first (Securities → {safe} → MFN terms → Reverse election), then void {security}.",
    params: { safe: "text", security: "text", electedOn: "date" },
  },
  voidMfnSourceConverted: {
    code: "equity_void_mfn_source",
    status: 409,
    message:
      "{safe} adopted the terms of {security} by its MFN election of {electedOn}; voiding {security} would leave that election naming terms entered in error.",
    remedy:
      "Void certificate {certificate}, which the conversion of {safe} produced, dated {convertedOn} (the round's closing date); reverse the MFN election on {safe} (Securities → {safe} → MFN terms → Reverse election); then void {security} and convert {safe} again.",
    params: {
      safe: "text",
      security: "text",
      electedOn: "date",
      certificate: "text",
      convertedOn: "date",
    },
  },
  voidHasActivity: {
    code: "equity_void_has_activity",
    status: 409,
    message: "Security {security} has recorded activity and cannot be voided.",
    remedy:
      "Void the certificates its events produced first, reverse its other events, or record a cancellation instead.",
    params: { security: "text" },
  },
  reversalTargetUnknown: {
    code: "equity_event_unknown",
    status: 404,
    message: "The event to reverse does not exist on this security.",
    remedy: "Choose an event from the security's history.",
  },
  eventFinal: {
    code: "equity_event_not_reversible",
    status: 409,
    message: "{event, select, void {A void} other {A reversal}} cannot be reversed.",
    remedy:
      "Voids and reversals are final; record the security or event again if it is still needed.",
    params: { event: "choice" },
  },
  eventNotReversible: {
    code: "equity_event_not_reversible",
    status: 409,
    message:
      "{event, select, exercise {An exercise} settle {A settlement} forfeit {A forfeiture} expire {An expiry} cancel {A cancellation} repurchase {A repurchase} transfer {A transfer} convert {A conversion} void {A void} repay {A repayment} reverse {A reversal} election_83b {An 83(b) election} other {This event}} cannot be reversed.",
    remedy: "Void the certificate the event produced instead; that undoes the event.",
    params: { event: "choice" },
  },
  eventAlreadyReversed: {
    code: "equity_event_reversed",
    status: 409,
    message: "The event is already reversed.",
    remedy: "Reload the security's history.",
  },
  reversalBeforeEvent: {
    code: "equity_event_invalid",
    message: "The reversal cannot precede the event it reverses, dated {date}.",
    remedy: "Date the reversal on or after {date}.",
    params: { date: "date" },
  },
  reversalHasDependents: {
    code: "equity_reversal_has_dependents",
    status: 409,
    message:
      "Later activity on {security} relies on the {event, select, forfeit {forfeiture} expire {expiry} cancel {cancellation} repurchase {repurchase} repay {repayment} election_83b {83(b) election} other {event}} of {date}: {count} later {countCount, plural, one {event} other {events}}, the latest on {latestOn}.",
    remedy:
      "Undo the later activity first, latest first, starting with the {latest, select, exercise {exercise} settle {settlement} forfeit {forfeiture} expire {expiry} cancel {cancellation} repurchase {repurchase} transfer {transfer} convert {conversion} repay {repayment} election_83b {83(b) election} other {event}} of {latestOn}: reverse each, or void the certificate it produced; then reverse this {event, select, forfeit {forfeiture} expire {expiry} cancel {cancellation} repurchase {repurchase} repay {repayment} election_83b {83(b) election} other {event}}.",
    params: {
      security: "text",
      event: "choice",
      date: "date",
      count: "count",
      latest: "choice",
      latestOn: "date",
    },
  },
  election83bNotApplicable: {
    code: "equity_83b_not_applicable",
    status: 409,
    message: "Security {security} has no vesting schedule, so no 83(b) election applies.",
    remedy: "Record 83(b) elections on restricted stock only.",
    params: { security: "text" },
  },
  election83bWindowClosed: {
    code: "equity_83b_window_closed",
    status: 409,
    message: "The 83(b) window for {security} closed on {deadline}.",
    remedy:
      "An election must be filed within 30 days of {issueDate}; record only an election filed on or before {deadline}.",
    params: { security: "text", deadline: "date", issueDate: "date" },
  },
  election83bRecorded: {
    code: "equity_83b_recorded",
    status: 409,
    message: "An 83(b) election filed on {date} is already recorded.",
    remedy: "Reverse the recorded election first if its date was entered in error.",
    params: { date: "date" },
  },
  mfnNotApplicable: {
    code: "equity_mfn_not_applicable",
    message: "Security {security} has no most-favored-nation term.",
    remedy: "Record MFN elections only on SAFEs issued with the MFN term.",
    params: { security: "text" },
  },
  mfnElectionClosed: {
    code: "equity_mfn_closed",
    status: 409,
    message:
      "Security {security} is {status, select, outstanding {outstanding} exercised {exercised} settled {settled} forfeited {forfeited} expired {expired} cancelled {cancelled} repurchased {repurchased} transferred {transferred} converted {converted} void {void} repaid {repaid} not_issued {not yet issued} other {no longer outstanding}} as of {date}; its terms can no longer change.",
    remedy:
      "Record an election only while the SAFE is outstanding; correct a conversion by voiding the certificate it produced first.",
    params: { security: "text", status: "choice", date: "date" },
  },
  mfnReversalClosedConverted: {
    code: "equity_mfn_closed",
    status: 409,
    message:
      "Security {security} is {status, select, outstanding {outstanding} exercised {exercised} settled {settled} forfeited {forfeited} expired {expired} cancelled {cancelled} repurchased {repurchased} transferred {transferred} converted {converted} void {void} repaid {repaid} not_issued {not yet issued} other {no longer outstanding}} as of {date}; its terms can no longer change.",
    remedy:
      "Void certificate {certificate}, which the conversion produced, dated {date} (the round's closing date), to undo the conversion; then reverse the election and convert {security} again.",
    params: { security: "text", status: "choice", date: "date", certificate: "text" },
  },
  mfnReversalClosed: {
    code: "equity_mfn_closed",
    status: 409,
    message:
      "Security {security} is {status, select, outstanding {outstanding} exercised {exercised} settled {settled} forfeited {forfeited} expired {expired} cancelled {cancelled} repurchased {repurchased} transferred {transferred} converted {converted} void {void} repaid {repaid} not_issued {not yet issued} other {no longer outstanding}} as of {date}; its terms can no longer change.",
    remedy:
      "Reverse the {status, select, repaid {repayment} other {cancellation}} first, then reverse the election.",
    params: { security: "text", status: "choice", date: "date" },
  },
  mfnBackdated: {
    code: "equity_mfn_backdated",
    status: 409,
    message: "An MFN election or reversal on {security} is already recorded from {date}.",
    remedy:
      "Date the {action, select, election {election} other {reversal}} on or after {date} under “{field}”.",
    params: { security: "text", date: "date", action: "choice", field: "term" },
  },
  mfnSourceNotConvertible: {
    code: "equity_mfn_not_better",
    status: 409,
    message: "The instrument is not a SAFE or note of this legal entity.",
    remedy: "Choose a SAFE or convertible note issued after this SAFE.",
  },
  mfnSourceNotLater: {
    code: "equity_mfn_not_better",
    status: 409,
    message: "{source} was issued on {sourceIssuedOn}, not after {safe}, issued on {safeIssuedOn}.",
    remedy:
      "Choose an instrument issued after this SAFE; the MFN term covers later instruments only.",
    params: { source: "text", sourceIssuedOn: "date", safe: "text", safeIssuedOn: "date" },
  },
  mfnSourceNotYetIssued: {
    code: "equity_mfn_not_better",
    status: 409,
    message: "{source} was not yet issued on {date}.",
    remedy: "Set “{field}” on or after {issuedOn}, when {source} was issued.",
    params: { source: "text", date: "date", issuedOn: "date", field: "term" },
  },
  mfnSourceCurrency: {
    code: "equity_mfn_not_better",
    status: 409,
    message: "{source} is stated in {sourceCurrency}, not {currency}.",
    remedy: "Choose an instrument stated in {currency}.",
    params: { source: "text", sourceCurrency: "text", currency: "text" },
  },
  mfnSourceVoid: {
    code: "equity_mfn_not_better",
    status: 409,
    message: "{source} is void.",
    remedy: "Choose an instrument that stands; a void instrument's terms were entered in error.",
    params: { source: "text" },
  },
  mfnTermsAlreadyAdopted: {
    code: "equity_mfn_not_better",
    status: 409,
    message: "{safe} already carries the terms of {source} from {date}.",
    remedy: "Nothing to elect; the terms are already adopted.",
    params: { safe: "text", source: "text", date: "date" },
  },
  mfnSourceNoTerms: {
    code: "equity_mfn_not_better",
    status: 409,
    message: "{source} has neither a valuation cap nor a discount.",
    remedy: "Choose an instrument with a cap or a discount the SAFE lacks or betters.",
    params: { source: "text" },
  },
  mfnTermsNotBetter: {
    code: "equity_mfn_not_better",
    status: 409,
    message: "None of the terms of {source} is better than the terms of {safe} in force on {date}.",
    remedy:
      "Choose an instrument whose cap is lower, discount higher or conversion post-money where the SAFE's is pre-money.",
    params: { source: "text", safe: "text", date: "date" },
  },
  mfnElectionUnknown: {
    code: "equity_mfn_election_unknown",
    status: 404,
    message: "The MFN election does not exist on this SAFE.",
    remedy: "Choose an election from the SAFE's MFN terms.",
  },
  mfnElectionAlreadyReversed: {
    code: "equity_mfn_reversed",
    status: 409,
    message: "The MFN election is already reversed.",
    remedy: "Reload the SAFE's MFN terms.",
  },
  mfnReversalBeforeElection: {
    code: "equity_date_invalid",
    message: "The reversal cannot precede the election, dated {date}.",
    remedy: "Date the reversal on or after {date}.",
    params: { date: "date" },
  },
  mfnReversalHasDependents: {
    code: "equity_mfn_reversal_has_dependents",
    status: 409,
    message: "A later MFN election on {security} is recorded from {date}.",
    remedy: "Reverse the election of {date} first, latest first.",
    params: { security: "text", date: "date" },
  },
} as const;
