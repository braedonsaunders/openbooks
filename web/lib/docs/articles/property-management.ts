import type { DocArticle } from '../types'

export const propertyManagement: DocArticle = {
  slug: 'property-management',
  title: 'Property Management',
  category: 'transactions',
  order: 7,
  summary:
    'Set up properties and units, activate tenant leases, bill recurring rent, account for security deposits, and reconcile common-area maintenance costs.',
  updated: '2026-07-31',
  keywords: [
    'property management',
    'property',
    'unit',
    'lease',
    'tenant',
    'rent',
    'escalation',
    'late fee',
    'security deposit',
    'CAM',
    'common area maintenance',
    'reconciliation',
  ],
  related: ['sales-workflow', 'payments-and-applications', 'fixed-assets-depreciation'],
  body: `# Property Management

The Property Management module joins day-to-day lease operations to the native
OpenBooks receivables and general-ledger controls. Rent and CAM charges become
ordinary customer invoices or credits, while security deposits post to a bank
account and a dedicated liability account. This keeps the tenant subledger,
open receivables, cash, and financial statements in agreement.

Switch it on in **Company Settings → Features → Property management**. The
Property Management industry preset enables it automatically. Turning the
feature off never removes records, and it is blocked while an active lease
would otherwise be hidden.

## Before the first lease

Prepare the following master data before opening **Operations → Property
Management**:

- Create a subsidiary for the legal entity that owns or manages the property.
- Create a location for each property so posted revenue and expenses can be
  reported by building.
- Create each tenant as a customer.
- Create income accounts for rent, recoveries, and fees.
- Create a current-liability account for deposits held and select the bank
  account that receives or refunds the cash.
- Optionally create a fixed-asset record for the building and improvements.

A managed property links these accounting records together. Its units carry
the rentable area and occupancy information used by lease operations and CAM
allocation. A vacant unit can be prepared before a tenant or lease is known.

## Creating and activating a lease

Create the lease from the **Leases** tab, select its property, unit, tenant,
term, billing day, currency, and default accounts, then add its charges. A
charge can recur monthly or quarterly, or occur once. Base rent, estimated CAM,
parking, storage, and other tenant charges can use separate income accounts.

Activation validates that the lease has the information required to bill. The
schedule generator then produces dated charge lines for the term. Partial first
or last months are prorated according to the lease policy. Scheduling is
idempotent: running it again extends or fills the schedule without duplicating
an existing charge date.

Use effective-dated escalations for contractual rent changes. An escalation can
set a new amount, increase the current amount by a percentage, or apply a fixed
increase. Applying it updates future billing while preserving the prior terms
and the audit history.

## Billing rent and fees

The **Rent** tab shows scheduled charges that are ready to bill. **Bill rent**
groups eligible lines into native customer invoices with the tenant, property
location, due date, accounts, and source details attached. The resulting
invoice follows the normal receivables lifecycle and appears in Accounts
Receivable, collections, customer statements, and financial reports.

Late fees are assessed from overdue posted invoices according to the lease
policy. The assessment creates a governed charge and schedule line before it is
billed, so an operator can trace the fee from lease terms to the resulting
invoice. Re-running the assessment does not create another fee for the same
source and assessment date.

Lease termination stops future operations at the recorded end date without
rewriting invoices or schedules that already form part of the accounting
history.

## Security deposits

Use the **Deposits** tab to receive, refund, adjust, or accrue interest on a
deposit. Every transaction creates a balanced journal entry. Receipts debit the
selected bank account and credit the deposit liability; refunds reverse that
movement. The deposit balance is calculated from its transaction history rather
than stored as an editable total.

A deposit may be applied to a posted tenant invoice. The application reduces
the deposit liability and settles the selected receivable through the standard
applications ledger. Record the business reason and retain supporting evidence
when local rules require a notice or itemized deduction. Deposit law varies by
jurisdiction, so configure accounts and operating procedures with professional
advice.

## CAM reconciliation

Create a CAM pool for the property and reconciliation period. Select the posted
expense accounts that belong in the pool, then choose the allocation method:
equal shares, rentable area, or custom percentages. Estimated CAM already
billed through lease charges is compared with the tenant's share of actual
eligible costs.

Finalizing the pool reads posted general-ledger expenses for the property's
location and freezes the allocation result. Review every tenant allocation
before billing. A positive true-up becomes a customer invoice; a negative
true-up becomes a customer credit. Both use the native posting path, so the CAM
result is visible in receivables and the ledger without a parallel balance.

## Period-end review

At month end, reconcile scheduled rent to generated invoices, investigate
past-due balances, and compare the deposit transaction total with the deposit
liability account by property. At CAM year end, confirm pool expense accounts,
property location coding, rentable-area dates, exclusions, and estimates billed
before finalization. These checks preserve the line from lease terms through
tenant activity to the financial statements.
`,
}
