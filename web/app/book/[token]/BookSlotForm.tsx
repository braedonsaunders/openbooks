'use client'

import { useState } from 'react'

/**
 * Candidate self-booking form (HR-18): the proposed slots as radio options
 * with one Book action. Posts to the sessionless booking API; a taken slot
 * surfaces the server's remedy (pick another slot), never a silent failure.
 */
export function BookSlotForm({ token, slots }: { token: string; slots: { id: string; startsAt: string; endsAt: string; timezone: string }[] }) {
  const [slotId, setSlotId] = useState(slots[0]?.id ?? '')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function book() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/recruiting/book/${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slotId }),
      })
      // Error bodies are checked before they are parsed: a refusal is a
      // message naming the remedy, never a parse error.
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        setError(body?.error ?? 'Booking failed. Please try another slot.')
        return
      }
      const body = (await res.json()) as { slot: { startsAt: string; timezone: string } }
      setDone(`${body.slot.startsAt} (${body.slot.timezone})`)
    } catch {
      setError('Booking failed. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <p role="status" className="rounded-md bg-green-50 p-4 text-sm text-green-800">
        Booked: {done}
      </p>
    )
  }

  return (
    <div>
      <fieldset>
        <legend className="mb-2 text-sm font-medium">Available times</legend>
        <div className="space-y-2">
          {slots.map((slot) => (
            <label key={slot.id} className="flex items-center gap-3 rounded-md border p-3 text-sm">
              <input
                type="radio"
                name="slot"
                value={slot.id}
                checked={slotId === slot.id}
                onChange={() => setSlotId(slot.id)}
                className="h-4 w-4"
              />
              <span>
                {slot.startsAt} — {slot.endsAt} ({slot.timezone})
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {error && (
        <p role="alert" className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-800">
          {error}
        </p>
      )}
      <button
        type="button"
        onClick={book}
        disabled={busy || !slotId}
        className="mt-4 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {busy ? 'Booking…' : 'Book this time'}
      </button>
    </div>
  )
}
