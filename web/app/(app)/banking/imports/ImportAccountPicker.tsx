'use client'

import { useState } from 'react'
import { Select } from '@openbooks/ui'
import { ImportStatementButton } from '../[accountId]/ImportStatementButton'

export interface ImportAccountOption {
  id: string
  label: string
}

/**
 * The statement-import entry point for the cross-account /banking/imports
 * history page. The canonical import dialog is per-account
 * (ImportStatementButton needs an accountId), so this picker carries the
 * bank account context: choose the account, then import into it. The same
 * widget serves the header CTA and the empty-state action — one
 * implementation, never two.
 */
export function ImportAccountPicker({
  accounts,
  selectLabel,
  placeholder,
}: {
  accounts: ImportAccountOption[]
  selectLabel: string
  placeholder: string
}) {
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '')
  const selected = accounts.find((account) => account.id === accountId) ?? accounts[0]
  // No reconcilable accounts: render nothing. The list's empty state carries
  // the guidance instead — it names the reconcilable prerequisite and links
  // to the Chart of Accounts — so the picker must not invent a second one.
  if (!selected) return null
  return (
    <span className="inline-flex items-center gap-2">
      <Select
        value={selected.id}
        onChange={(e) => setAccountId(e.target.value)}
        className="h-9 w-auto max-w-56"
        aria-label={selectLabel}
        placeholder={placeholder}
      >
        {accounts.map((account) => (
          <option key={account.id} value={account.id}>
            {account.label}
          </option>
        ))}
      </Select>
      <ImportStatementButton accountId={selected.id} />
    </span>
  )
}
