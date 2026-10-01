import assert from 'node:assert/strict'
import test from 'node:test'
import { compileTemplateHtml, renderTemplate } from '@openbooks/pdf'
import { PDF_RECORD_TYPE_BY_KEY } from './catalog'
import { starterTemplate } from './starters'

for (const recordType of ['pay_stub', 'payroll_cheque']) {
  test(`${recordType} prints non-cash earnings separately from the cash payment`, () => {
    const source = starterTemplate(PDF_RECORD_TYPE_BY_KEY[recordType]!).sourceHtml
    const compiled = compileTemplateHtml(source)
    const values = {
      gross: '$2,500.00', cash_gross: '$2,400.00', non_cash_earnings: '$100.00',
      net_pay: '$1,950.00', has_non_cash_earnings: true,
      earnings: [{ description: 'Salary', amount: '$2,400.00', non_cash: false },
        { description: 'Gift card', amount: '$100.00', non_cash: true }],
    }
    const printed = renderTemplate(compiled.compiledHtml, values)
    assert.match(printed, /Non-cash benefits/)
    assert.match(printed, /Cash earnings/)
    assert.match(printed, /Gift card[^<]*<span[^>]*> · Non-cash/)
    assert.doesNotMatch(printed, /Salary[^<]*<span[^>]*> · Non-cash/)
    assert.match(printed, /\$1,950\.00/, 'net pay remains the actual cash payment')
    const cashOnly = renderTemplate(compiled.compiledHtml, { ...values, has_non_cash_earnings: false,
      earnings: [{ description: 'Salary', amount: '$2,400.00', non_cash: false }] })
    assert.doesNotMatch(cashOnly, /Non-cash benefits|Cash earnings| · Non-cash/)
  })
}
