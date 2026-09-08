import assert from 'node:assert/strict'
import test from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import { MoneyProvider, useMoney } from './money-provider'

Object.assign(globalThis, { React })

function Amount({ currency }: { currency?: string }) {
  const formatter = useMoney(currency)
  return <span>{formatter.money('100000000000000.0002', { currencyDisplay: 'code', maximumFractionDigits: 4 })}</span>
}

for (const recordCurrency of [undefined, 'USD']) {
  test(`money provider uses ${recordCurrency ?? 'organization currency'} with exact decimal presentation`, () => {
    const markup = renderToStaticMarkup(
      <NextIntlClientProvider locale="en-CA" timeZone="UTC" messages={{}}>
        <MoneyProvider currency="CAD"><Amount currency={recordCurrency} /></MoneyProvider>
      </NextIntlClientProvider>,
    )
    assert.ok(markup.includes(recordCurrency ?? 'CAD'))
    assert.ok(markup.includes('100,000,000,000,000.0002'))
    if (recordCurrency) assert.ok(!markup.includes('CAD'))
  })
}
