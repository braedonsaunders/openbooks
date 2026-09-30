# Canadian cumulative withholding

OpenBooks supports the CRA T4127 periodic method (Option 1) and cumulative averaging (Option 2). The periodic method applies until the employer records an election. The CRA describes cumulative averaging in [T4127 Chapter 5](https://www.canada.ca/en/revenue-agency/services/forms-publications/payroll/t4127-payroll-deductions-formulas/t4127-jan/t4127-jan-payroll-deductions-formulas-computer-programs.html).

On the employee’s Payroll profile, open the withholding records and file **Employer withholding method election**. Select the method, supply the reason and supporting record, and set its effective date. This is the employer’s administrative election, not a separate employee tax form. The dated record and its audit evidence are retained when a later election supersedes it.

An Option 2 election starts a new income-tax averaging window on its effective date. The window resets at the beginning of each calendar year. Scheduled pay dates determine elapsed periods, including periods with no cheque; off-cycle cheques do not create extra periods. CPP, CPP2 and EI continue to use the calendar-year contribution history when the income-tax window resets. Québec provincial income tax continues through its separate TP-1015 calculation.

To continue a prior provider’s averaging window, enter its earlier start and last included pay date on the election. Complete the **Averaging window** fields in **Payroll → Opening Balances**, as well as the ordinary calendar-year openings. Confirm that the complete imported history agrees with the prior provider’s report. The window fields are not additional annual earnings: they describe the portion of the annual openings inside that window. Imported and committed payroll must not overlap.

The calculation keeps periodic tax, bonus tax and additional requested withholding separate. Bonuses use the Option 2 annual tax difference. The pay stub’s calculation trace shows the projection-period count, elapsed periods, annual taxable income, periodic withholding history and bonus withholding history.

An election cannot take effect across already committed payroll. Use a later effective date, or correct the affected payroll through the controlled void and replacement workflow. A record changed after a run was calculated requires recalculation before commit. Missing history, overlapping imports and invalid dates are refused with the input that needs correction.
