/** Preserve database numeric text for payroll money shown by the module home. */
export function payrollYtdMoneyAmounts(row: {
  gross?: string | null
  net?: string | null
  employer_cost?: string | null
}): { gross: string; net: string; employerCost: string } {
  return {
    gross: row.gross ?? '0',
    net: row.net ?? '0',
    employerCost: row.employer_cost ?? '0',
  }
}
