import { seedPostingAccount, seedEnabledPayrollConfiguration } from "./fixtures.ts";

/** Canadian account classifications and native payroll posting configuration. */
export async function seedCanadianPostingAccounts(orgId: string) {
  const account = seedPostingAccount.bind(null, orgId);
  const wageExpense = await account("6000", "Wages expense", "expense");
  const burdenExpense = await account("6010", "Payroll burden", "expense");
  const netPayable = await account("2300", "Wages payable", "liability_current");
  const craPayable = await account("2310", "CRA remittances payable", "liability_current");
  const vacationPayable = await account("2320", "Vacation payable", "liability_current");
  await seedEnabledPayrollConfiguration(orgId, {
    wageExpenseAccountId: wageExpense,
    burdenExpenseAccountId: burdenExpense,
    netPayAccountId: netPayable,
    cppPayableAccountId: craPayable,
    eiPayableAccountId: craPayable,
    taxPayableAccountId: craPayable,
    vacationPayableAccountId: vacationPayable,
    wagesTo: "expense",
  });
  return { wageExpense, burdenExpense, netPayable, craPayable, vacationPayable };
}

/** Union payroll keeps fringe costs and remittances on their declared accounts. */
export async function seedUnionPostingAccounts(orgId: string, withDues: boolean) {
  const account = seedPostingAccount.bind(null, orgId);
  const wageExpense = await account("6000", "Wages expense", "expense");
  const fringeExpense = await account("6020", "Union fringes", "expense");
  const netPayable = await account("2300", "Wages payable", "liability_current");
  const craPayable = await account("2310", "CRA payable", "liability_current");
  const duesPayable = withDues ? await account("2330", "Union dues payable", "liability_current") : null;
  const fringePayable = await account("2340", "Union fringes payable", "liability_current");
  await seedEnabledPayrollConfiguration(orgId, {
    wageExpenseAccountId: wageExpense, burdenExpenseAccountId: fringeExpense,
    netPayAccountId: netPayable, cppPayableAccountId: craPayable,
    eiPayableAccountId: craPayable, taxPayableAccountId: craPayable,
    vacationPayableAccountId: craPayable, wagesTo: "expense",
  });
  return { wageExpense, fringeExpense, netPayable, craPayable, duesPayable, fringePayable };
}
