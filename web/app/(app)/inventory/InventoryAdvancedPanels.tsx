'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Badge, Button, Card, Input, Label, Select } from '@openbooks/ui'

type Item = { id: string; code?: string | null; name?: string | null }
type Loc = { id: string; code?: string | null }
type Acct = { id: string; number?: string | null; name?: string | null }

export function InventoryAdvancedPanels({
  view,
  items,
  locations,
  accounts,
  canManage,
}: {
  view: 'transfers' | 'lots' | 'landed'
  items: Item[]
  locations: Loc[]
  accounts: Acct[]
  canManage: boolean
}) {
  const router = useRouter()
  const [rows, setRows] = useState<any[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const [fromId, setFromId] = useState('')
  const [toId, setToId] = useState('')
  const [itemId, setItemId] = useState('')
  const [qty, setQty] = useState('1')
  const [inTransitAcct, setInTransitAcct] = useState('')

  const [amount, setAmount] = useState('')
  const [freightId, setFreightId] = useState('')
  const [basis, setBasis] = useState('value')
  const [tItem, setTItem] = useState('')
  const [tLoc, setTLoc] = useState('')
  const [targets, setTargets] = useState<{ itemId: string; stockLocationId: string }[]>([])

  const [lotNumber, setLotNumber] = useState('')

  const load = async () => {
    const q = view === 'transfers' ? 'view=transfers' : view === 'lots' ? 'view=lots' : 'view=landed'
    const r = await fetch(`/api/inventory/advanced?${q}`)
    if (!r.ok) return
    const d = await r.json()
    setRows(d.transfers ?? d.lots ?? d.vouchers ?? [])
  }
  useEffect(() => {
    void load()
  }, [view])

  const post = async (body: Record<string, unknown>) => {
    setBusy(true)
    setErr(null)
    const r = await fetch('/api/inventory/advanced', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const d = await r.json().catch(() => ({}))
    setBusy(false)
    if (!r.ok) {
      setErr(d.error ?? 'Failed')
      toast.error(d.error ?? 'Failed')
      return null
    }
    toast.success('Saved')
    void load()
    router.refresh()
    return d
  }

  if (view === 'transfers') {
    return (
      <div className="space-y-4">
        {err && <p className="text-sm text-red-600">{err}</p>}
        {canManage ? (
          <Card className="space-y-3 p-4">
            <h3 className="text-sm font-semibold">New transfer order</h3>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <Label>From</Label>
                <Select value={fromId} onChange={(e) => setFromId(e.target.value)}>
                  <option value="">…</option>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.code}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label>To</Label>
                <Select value={toId} onChange={(e) => setToId(e.target.value)}>
                  <option value="">…</option>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.code}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label>Item</Label>
                <Select value={itemId} onChange={(e) => setItemId(e.target.value)}>
                  <option value="">…</option>
                  {items.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.code ? `${i.code} · ` : ''}
                      {i.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label>Qty</Label>
                <Input value={qty} onChange={(e) => setQty(e.target.value)} />
              </div>
              <div className="sm:col-span-2">
                <Label>In-transit account (optional override)</Label>
                <Select value={inTransitAcct} onChange={(e) => setInTransitAcct(e.target.value)}>
                  <option value="">Use control account</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.number} {a.name}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            <Button
              size="sm"
              disabled={busy || !fromId || !toId || !itemId}
              onClick={() =>
                void post({
                  action: 'createTransfer',
                  fromStockLocationId: fromId,
                  toStockLocationId: toId,
                  inTransitAccountId: inTransitAcct || null,
                  lines: [{ itemId, quantity: qty }],
                })
              }
            >
              Create draft
            </Button>
            <p className="text-xs text-muted-foreground">
              Ship posts DR inventory-in-transit / CR inventory. Receive clears in-transit at destination.
              Set controlAccounts.inventoryInTransit when not overriding.
            </p>
          </Card>
        ) : null}
        <Card className="p-4">
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="py-1">Number</th>
                <th>From → To</th>
                <th>Status</th>
                <th>Ordered</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="py-1 font-mono text-xs">{r.documentNumber}</td>
                  <td>
                    {r.fromCode} → {r.toCode}
                  </td>
                  <td>
                    <Badge variant={r.status === 'received' ? 'success' : 'secondary'}>{r.status}</Badge>
                  </td>
                  <td>{r.orderedOn}</td>
                  <td className="space-x-1 text-right">
                    {canManage && r.status === 'draft' ? (
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void post({ action: 'shipTransfer', id: r.id })}>
                        Ship
                      </Button>
                    ) : null}
                    {canManage && r.status === 'in_transit' ? (
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void post({ action: 'receiveTransfer', id: r.id })}>
                        Receive
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-4 text-center text-muted-foreground">
                    No transfer orders yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </Card>
      </div>
    )
  }

  if (view === 'landed') {
    return (
      <div className="space-y-4">
        {err && <p className="text-sm text-red-600">{err}</p>}
        {canManage ? (
          <Card className="space-y-3 p-4">
            <h3 className="text-sm font-semibold">Multi-receipt landed cost voucher</h3>
            <div className="grid gap-2 sm:grid-cols-3">
              <div>
                <Label>Amount</Label>
                <Input value={amount} onChange={(e) => setAmount(e.target.value)} />
              </div>
              <div>
                <Label>Basis</Label>
                <Select value={basis} onChange={(e) => setBasis(e.target.value)}>
                  <option value="value">By value</option>
                  <option value="quantity">By quantity</option>
                  <option value="weight">By weight</option>
                </Select>
              </div>
              <div>
                <Label>Freight account</Label>
                <Select value={freightId} onChange={(e) => setFreightId(e.target.value)}>
                  <option value="">…</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.number} {a.name}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <div>
                <Label>Target item</Label>
                <Select value={tItem} onChange={(e) => setTItem(e.target.value)}>
                  <option value="">…</option>
                  {items.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.code ? `${i.code} · ` : ''}
                      {i.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label>Location</Label>
                <Select value={tLoc} onChange={(e) => setTLoc(e.target.value)}>
                  <option value="">…</option>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.code}
                    </option>
                  ))}
                </Select>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  if (!tItem || !tLoc) return
                  setTargets((cur) => [...cur, { itemId: tItem, stockLocationId: tLoc }])
                  setTItem('')
                  setTLoc('')
                }}
              >
                Add target
              </Button>
            </div>
            {targets.length > 0 ? (
              <ul className="text-xs text-muted-foreground">
                {targets.map((t, i) => (
                  <li key={i}>
                    {items.find((x) => x.id === t.itemId)?.name} @ {locations.find((x) => x.id === t.stockLocationId)?.code}{' '}
                    <button className="ml-2 text-red-600" type="button" onClick={() => setTargets((cur) => cur.filter((_, j) => j !== i))}>
                      remove
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <Button
              size="sm"
              disabled={busy || !amount || !freightId || targets.length === 0}
              onClick={() =>
                void post({
                  action: 'postLandedVoucher',
                  amount,
                  basis,
                  freightAccountId: freightId,
                  targets,
                })
              }
            >
              Post voucher
            </Button>
          </Card>
        ) : null}
        <Card className="p-4">
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="py-1">Number</th>
                <th>Date</th>
                <th>Basis</th>
                <th className="text-right">Amount</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="py-1 font-mono text-xs">{r.documentNumber}</td>
                  <td>{r.voucherDate}</td>
                  <td>{r.basis}</td>
                  <td className="text-right tabular-nums">{r.amount}</td>
                  <td>{r.status}</td>
                </tr>
              ))}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-4 text-center text-muted-foreground">
                    No landed cost vouchers yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-end gap-2 p-4">
        <div>
          <Label>Lot number</Label>
          <Input value={lotNumber} onChange={(e) => setLotNumber(e.target.value)} />
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            const qs = new URLSearchParams()
            if (lotNumber) qs.set('lotNumber', lotNumber)
            window.location.href = `/reports/lot-recall?${qs.toString()}`
          }}
        >
          Open recall report
        </Button>
      </Card>
      <Card className="p-4">
        <table className="w-full text-sm">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="py-1">Lot</th>
              <th>Item</th>
              <th>Expiry</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="py-1 font-mono">{r.lotNumber}</td>
                <td>
                  {r.itemCode ? `${r.itemCode} · ` : ''}
                  {r.itemName}
                </td>
                <td>{r.expiresOn ?? '—'}</td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={3} className="py-4 text-center text-muted-foreground">
                  No lots yet — receive stock with a lot number.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Card>
    </div>
  )
}
