import type { Corpus, CorpusEvent, ExpectedBalances } from "../corpus-lib/types.ts";

/**
 * The independent oracle: a deliberately tiny, obviously-correct double-entry
 * ledger that computes the expected balances for a corpus.
 *
 * INDEPENDENCE RULE — this module imports NOTHING from the OpenBooks engine
 * (not even its money utilities). It has its own integer-cents arithmetic and
 * its own statement of the posting semantics, written from the corpus spec in
 * the README, so a defect shared with the product cannot hide here.
 *
 * Posting semantics (the cross-system contract):
 *   journal            — apply signed lines as given; must sum to zero.
 *   customer_invoice   — DR ar (total),   CR each line account.
 *   customer_credit    — DR each line,    CR ar (total).   Open item is NEGATIVE.
 *   vendor_bill        — DR each line,    CR ap (total).
 *   vendor_credit      — DR ap (total),   CR each line.    Open item is NEGATIVE.
 *   expense_report     — DR each line,    CR employeePayable (total).
 *   customer_payment   — DR bank,             CR target control (Σ allocations).
 *   vendor_payment     — DR target control,   CR bank.
 * A payment's control account is its TARGETS' control account (ar for
 * invoices/credits, ap for bills, employeePayable for expense reports); one
 * payment may not settle items on different control accounts.
 * Allocations reduce the target event's remaining open balance toward zero and
 * may never exceed it. No rounding tolerance exists anywhere: every amount must
 * parse as an exact two-decimal value and every event must balance to the cent.
 */

// ---- standalone integer-cents arithmetic ------------------------------------

export function toCents(s: string): bigint {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(s.trim());
  if (!m) throw new Error(`not an exact two-decimal amount: "${s}"`);
  const sign = m[1] === "-" ? -1n : 1n;
  const whole = BigInt(m[2]!);
  const frac = BigInt((m[3] ?? "").padEnd(2, "0") || "0");
  return sign * (whole * 100n + frac);
}

export function fromCents(c: bigint): string {
  const sign = c < 0n ? "-" : "";
  const abs = c < 0n ? -c : c;
  return `${sign}${abs / 100n}.${String(abs % 100n).padStart(2, "0")}`;
}

// ---- the ledger --------------------------------------------------------------

type Side = "ar" | "ap";

interface OpenItem {
  event: string;
  party: string;
  side: Side;
  /** The control account this item lives on (ar / ap / employeePayable). */
  control: string;
  /** Signed remaining amount (invoices/bills positive, credits negative). */
  remaining: bigint;
}

export interface ReferenceResult {
  trialBalance: Record<string, string>;
  openBalances: Record<string, { ar?: string; ap?: string }>;
  eventCount: number;
}

export class ReferenceLedger {
  private balances = new Map<string, bigint>();
  private openItems = new Map<string, OpenItem>();
  private seenIds = new Set<string>();
  private accounts: Set<string>;
  private parties: Map<string, Set<string>>;

  constructor(private corpus: Pick<Corpus, "accounts" | "parties">) {
    this.accounts = new Set(corpus.accounts.map((a) => a.key));
    this.parties = new Map(corpus.parties.map((p) => [p.key, new Set(p.roles)]));
    for (const required of ["ar", "ap", "bank"]) {
      if (!this.accounts.has(required)) throw new Error(`corpus is missing the "${required}" account`);
    }
  }

  private post(account: string, cents: bigint): void {
    if (!this.accounts.has(account)) throw new Error(`unknown account key "${account}"`);
    this.balances.set(account, (this.balances.get(account) ?? 0n) + cents);
  }

  private requireParty(key: string, role: "customer" | "vendor" | "employee", event: string): void {
    const roles = this.parties.get(key);
    if (!roles) throw new Error(`${event}: unknown party "${key}"`);
    if (!roles.has(role)) throw new Error(`${event}: party "${key}" lacks the ${role} role`);
  }

  apply(event: CorpusEvent): void {
    if (this.seenIds.has(event.id)) throw new Error(`duplicate event id "${event.id}"`);
    this.seenIds.add(event.id);
    switch (event.kind) {
      case "journal": {
        let net = 0n;
        for (const line of event.lines) {
          const cents = toCents(line.amount);
          this.post(line.account, cents);
          net += cents;
        }
        if (net !== 0n) throw new Error(`${event.id}: journal does not balance (net ${fromCents(net)})`);
        break;
      }
      case "customer_invoice":
      case "customer_credit":
      case "vendor_bill":
      case "vendor_credit":
      case "expense_report": {
        const total = event.lines.reduce((acc, l) => {
          const cents = toCents(l.amount);
          if (cents <= 0n) throw new Error(`${event.id}: commercial line amounts must be positive`);
          return acc + cents;
        }, 0n);
        const isCustomer = event.kind.startsWith("customer");
        const isCredit = event.kind.endsWith("credit");
        const control = event.kind === "expense_report" ? "employeePayable" : isCustomer ? "ar" : "ap";
        const role = event.kind === "expense_report" ? "employee" : isCustomer ? "customer" : "vendor";
        this.requireParty(event.party, role, event.id);
        // Line legs: revenue is credited on invoices (and debited back on credits);
        // cost is debited on bills/expenses (and credited back on vendor credits).
        const lineSign = isCustomer ? (isCredit ? 1n : -1n) : isCredit ? -1n : 1n;
        for (const line of event.lines) this.post(line.account, lineSign * toCents(line.amount));
        // Control leg balances the document; its sign IS the open item's sign
        // (AR: invoices +, credits −; AP mirrored: bills −, vendor credits +).
        const controlSign = -lineSign;
        this.post(control, controlSign * total);
        this.openItems.set(event.id, {
          event: event.id,
          party: event.party,
          side: isCustomer ? "ar" : "ap",
          control,
          remaining: controlSign * total,
        });
        break;
      }
      case "customer_payment":
      case "vendor_payment": {
        const isCustomer = event.kind === "customer_payment";
        // A vendor_payment settles the AP side, which also carries employee
        // reimbursements (expense reports) — either role is a valid payee.
        if (isCustomer) this.requireParty(event.party, "customer", event.id);
        else if (!this.parties.get(event.party)?.has("vendor") && !this.parties.get(event.party)?.has("employee")) {
          throw new Error(`${event.id}: party "${event.party}" lacks the vendor/employee role`);
        }
        let total = 0n;
        let control: string | null = null;
        for (const alloc of event.allocations) {
          const cents = toCents(alloc.amount);
          if (cents <= 0n) throw new Error(`${event.id}: allocation amounts must be positive`);
          const item = this.openItems.get(alloc.event);
          if (!item) throw new Error(`${event.id}: allocation targets unknown event "${alloc.event}"`);
          if (item.party !== event.party) throw new Error(`${event.id}: allocation crosses parties (${alloc.event})`);
          if (item.side !== (isCustomer ? "ar" : "ap")) {
            throw new Error(`${event.id}: allocation crosses subledger sides (${alloc.event})`);
          }
          if (control !== null && control !== item.control) {
            throw new Error(`${event.id}: one payment may not settle items on different control accounts`);
          }
          control = item.control;
          // An application reduces the open item's MAGNITUDE toward zero — the
          // item's sign depends on its side (AP bills carry negative open items).
          const magnitude = item.remaining < 0n ? -item.remaining : item.remaining;
          if (magnitude < cents) {
            throw new Error(
              `${event.id}: over-application of ${fromCents(cents)} against ${alloc.event} (open ${fromCents(item.remaining)})`,
            );
          }
          item.remaining += item.remaining < 0n ? cents : -cents;
          total += cents;
        }
        if (total === 0n || control === null) throw new Error(`${event.id}: payment with no allocations`);
        if (isCustomer) {
          this.post("bank", total);
          this.post(control, -total);
        } else {
          this.post(control, total);
          this.post("bank", -total);
        }
        break;
      }
    }
  }

  result(): ReferenceResult {
    let net = 0n;
    const trialBalance: Record<string, string> = {};
    for (const key of [...this.balances.keys()].sort()) {
      const bal = this.balances.get(key)!;
      net += bal;
      if (bal !== 0n) trialBalance[key] = fromCents(bal);
    }
    if (net !== 0n) throw new Error(`reference ledger out of balance by ${fromCents(net)} — oracle bug`);

    const openBalances: Record<string, { ar?: string; ap?: string }> = {};
    const byPartySide = new Map<string, bigint>();
    for (const item of this.openItems.values()) {
      const key = `${item.party}|${item.side}`;
      byPartySide.set(key, (byPartySide.get(key) ?? 0n) + item.remaining);
    }
    for (const [key, remaining] of [...byPartySide.entries()].sort()) {
      if (remaining === 0n) continue;
      const [party, side] = key.split("|") as [string, Side];
      (openBalances[party] ??= {})[side] = fromCents(remaining);
    }
    return { trialBalance, openBalances, eventCount: this.seenIds.size };
  }
}

/** Run a full corpus through the oracle and produce the published contract. */
export function computeExpected(corpus: Corpus): ExpectedBalances {
  const ledger = new ReferenceLedger(corpus);
  for (const event of corpus.events) ledger.apply(event);
  const { trialBalance, openBalances } = ledger.result();
  return {
    schemaVersion: 1,
    corpus: corpus.name,
    seed: corpus.seed,
    trialBalance,
    openBalances,
    eventCount: corpus.events.length,
  };
}
