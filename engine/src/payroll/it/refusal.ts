import { PayrollError } from "../error.ts";

/**
 * The IT pack's named refusal. Alone in its own module so the assessed-saldo
 * channel (./surtax-balances.ts) can raise it without importing the whole
 * statutory engine, which imports the channel back — the same
 * module-evaluation cycle ../error.ts documents.
 */
export class ItPayrollRefusal extends PayrollError {}
