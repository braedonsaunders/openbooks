import assert from 'node:assert/strict'
import test from 'node:test'
import { compileTemplateHtml, renderTemplate } from '@openbooks/pdf'
import { PDF_RECORD_TYPE_BY_KEY } from './catalog'
import { starterTemplate } from './starters'

for (const recordType of ['payroll_cheque']) {
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

test('pay_stub prints non-cash taxable items apart from cash earnings, with YTD on every row', () => {
  const source = starterTemplate(PDF_RECORD_TYPE_BY_KEY.pay_stub!).sourceHtml
  const compiled = compileTemplateHtml(source)
  const printed = renderTemplate(compiled.compiledHtml, {
    employee_name: 'Avery Lin', employee_address: '18 Maple Ave, Toronto ON M4E 2T1',
    employee_address_line1: '18 Maple Ave', employee_address_locality: 'Toronto ON M4E 2T1',
    cheque_number: '10815', period_start: 'Sep 20, 2026', period_end: 'Sep 26, 2026', pay_date: 'Oct 2, 2026',
    earnings_detail: [{ description: 'Regular Wages', hours: '40.00', rate: '$30.00', current: '$1,200.00', ytd_amount: '$16,800.00' },
      { description: 'Statutory Holiday', hours: '', rate: '', current: '$0.00', ytd_amount: '$720.00' }],
    earnings_current_total: '$1,200.00', earnings_ytd_total: '$17,520.00',
    withholdings: [{ description: 'Federal Income Tax', current: '$110.00', ytd_amount: '$1,540.00' }],
    withholdings_current_total: '$110.00', withholdings_ytd_total: '$1,540.00',
    taxable_company_items: [{ description: 'Group life premium', current: '$5.00', ytd_amount: '$70.00' }],
    net_adjustments: [{ description: 'CPP', current: '-$67.39', ytd_amount: '-$943.46' }],
    net_adjustments_current_total: '-$67.39', net_adjustments_ytd_total: '-$943.46',
    net_pay: '$1,022.61', ytd_net: '$15,036.54',
  })
  const companyItems = printed.indexOf('Taxable Company Items')
  assert.ok(companyItems > 0, 'the taxable company items section prints')
  assert.ok(printed.indexOf('Group life premium') > companyItems, 'a non-cash benefit prints under taxable company items')
  assert.ok(printed.indexOf('Regular Wages') < companyItems, 'cash earnings print in the earnings section')
  assert.match(printed, /Statutory Holiday[\s\S]*\$720\.00/, 'a component paid earlier in the year still prints its YTD')
  assert.match(printed, /Net pay[\s\S]*\$1,022\.61[\s\S]*\$15,036\.54/, 'net pay is the cash paid, with its YTD')
  assert.match(printed, /Cheque number: 10815/)
})
