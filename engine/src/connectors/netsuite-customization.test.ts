import assert from 'node:assert/strict';
import test from 'node:test';
import { netsuiteCustomizationChoices, netsuiteCustomRecordFields, type NetSuiteCreds } from './netsuite.ts';
const creds: NetSuiteCreds = { account: 'test', host: 'https://example.invalid', consumerKey: 'consumer', consumerSecret: 'secret', tokenKey: 'token', tokenSecret: 'secret' };
const xml = (body: string) => `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>${body}</s:Body></s:Envelope>`;
const choices = (success = true, total = 1) => xml(`<getCustomizationIdResponse><getCustomizationIdResult><status isSuccess="${success}"/><totalRecords>${total}</totalRecords><customizationRefList><customizationRef internalId="12" scriptId="customrecord_time" type="customRecordType"><name>Time categories</name></customizationRef></customizationRefList></getCustomizationIdResult></getCustomizationIdResponse>`);

test('customization pickers use human names with stable script identities and scope child fields to the selected parent', async () => {
  const requests: string[] = [];
  const transport = (async (_input, init) => {
    assert.equal(init?.redirect, 'error');
    const body = String(init?.body); requests.push(body);
    if (new Headers(init?.headers).get('SOAPAction') === 'getCustomizationId') return new Response(choices());
    assert.match(body, /internalId="12" type="customRecordType"/);
    return new Response(xml('<getListResponse><readResponseList><readResponse><status isSuccess="true"/><record internalId="12"><customFieldList><customField internalId="19"><scriptId>custrecord_multiplier</scriptId><label>Multiplier</label></customField></customFieldList></record></readResponse></readResponseList></getListResponse>'));
  }) as typeof fetch;
  assert.deepEqual(await netsuiteCustomizationChoices('customRecordType', creds, '2022_1', transport), [{ value: 'customrecord_time', label: 'Time categories', internalId: '12' }]);
  assert.deepEqual(await netsuiteCustomRecordFields('customrecord_time', creds, '2022_1', transport), [{ value: 'custrecord_multiplier', label: 'Multiplier', internalId: '19' }]);
  assert.ok(requests.every((body) => body.includes('<tokenPassport')));
  await assert.rejects(netsuiteCustomRecordFields('customrecord_other', creds, '2022_1', transport), /Selected source record is unavailable/);
});

test('customization choices refuse denied, incomplete and malformed metadata instead of showing an empty successful picker', async () => {
  for (const response of [choices(false), choices(true, 2), '<not-complete>']) {
    await assert.rejects(netsuiteCustomizationChoices('customRecordType', creds, '2022_1', (async () => new Response(response)) as typeof fetch), /refused|incomplete/);
  }
});
