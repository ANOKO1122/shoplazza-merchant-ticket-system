import test from 'node:test';
import assert from 'node:assert/strict';
import { cents, normalizeProtectionSnapshot, claimAllocation, validateClaimTransition, csvCell, isSameOriginMutation } from './protection-domain';

test('money parsing preserves cents and refuses missing, fractional-cent and unsafe amounts', () => {
  assert.equal(cents('12.30'), 1230);
  assert.equal(cents('0'), 0);
  for (const value of ['', null, undefined, 'NaN', '-1', '1.001', '90071992547409.92']) assert.equal(cents(value), null);
});

test('protection recognition uses store product IDs and keeps unknown values unknown', () => {
  const snapshot = { id: '8', store_subdomain: 'fixture', order_id: 'order-1', order_amount: '53', order_currency: 'USD',
    payment_status: 'paid', raw_order_json: {total_discount:'0'}, items_json: [
      { id: 'goods', product_id: 'g', quantity: 2, price: '25', total_price: '45', product_title: 'Coat' },
      { id: 'protection', product_id: 'p', quantity: 1, price: '3', product_title: 'Anything' },
    ] };
  const normalized = normalizeProtectionSnapshot(snapshot, ['p'])!;
  assert.equal(normalized.protection_fee_cents, 300);
  assert.equal(normalized.protected_value_cents, 4500);
  assert.equal(normalizeProtectionSnapshot(snapshot, ['wrong']), null);
  const missing = normalizeProtectionSnapshot({ ...snapshot, items_json: [snapshot.items_json[1], { id: 'unknown', product_id: 'g', quantity: 1 }] }, ['p'])!;
  assert.equal(missing.protected_value_cents, null);
  assert.equal(missing.items[1].amount_cents, null);
});

test('line total_price is gross: subtract Shoplazza serialized discount allocations before evaluating claim balances', () => {
  const result=normalizeProtectionSnapshot({store_subdomain:'fixture',order_id:'discounted',order_currency:'USD',payment_status:'paid',order_amount:'175.76',
    raw_order_json:{total_discount:'9.00'},items_json:[
      {id:'one',product_id:'g1',quantity:1,total_price:'60.99',discount_applications:'[]'},
      {id:'two',product_id:'g2',quantity:1,total_price:'59.99',discount_applications:[]},
      {id:'three',product_id:'g3',quantity:1,total_price:'59.99',discount_applications:JSON.stringify([{type:'discount_mn',total_discount_amount:'9.00',discount_amount:'9.00',discount_quantity:1}])},
      {id:'service',product_id:'p',quantity:1,total_price:'3.79',refund_quantity_total:1},
    ]},['p'])!;
  assert.equal(result.items[2].amount_cents,5099);
  assert.equal(result.protected_value_cents,17197);
  assert.equal(result.service_fulfillment_status,'refunded');
  const unknown=normalizeProtectionSnapshot({order_currency:'USD',payment_status:'paid',items_json:[{id:'g',product_id:'g',quantity:1,price:'50'},{id:'p',product_id:'p',quantity:1,price:'2'}],raw_order_json:{}},['p'])!;
  assert.equal(unknown.items[0].amount_cents,null);
});

test('service fulfillment distinguishes shipped from finished and reads current package line status', () => {
  const base={order_currency:'USD',payment_status:'paid',raw_order_json:{total_discount:'0'},items_json:[{id:'p-line',product_id:'p',quantity:1,price:'2',fulfillment_status:'unfulfilled'}]};
  const snapshot=(status:string)=>({...base,raw_order_json:{...base.raw_order_json,fulfillments:[{id:'package',status,line_items:[{id:'p-line',ship_quantity:1}]}]}});
  assert.equal(normalizeProtectionSnapshot(snapshot('shipped'),['p'])!.service_fulfillment_status,'fulfilled');
  assert.equal(normalizeProtectionSnapshot(snapshot('finished'),['p'])!.service_fulfillment_status,'completed');
  assert.equal(normalizeProtectionSnapshot(snapshot('cancelled'),['p'])!.service_fulfillment_status,'pending');
  assert.equal(normalizeProtectionSnapshot({...base,items_json:[{...base.items_json[0],fulfillment_status:'shipped'}]},['p'])!.service_fulfillment_status,'fulfilled');
});

test('claim allocations prevent approving more than selected unrefunded item balances', () => {
  const items = [{ id: 'a', amount_cents: 3000, is_protection: false }, { id: 'b', amount_cents: 2000, is_protection: false }];
  assert.deepEqual(claimAllocation(items as any, ['a', 'b'], 3500, { a: 1000 }, 4000), { a: 2000, b: 1500 });
  assert.throws(() => claimAllocation(items as any, ['a'], 2001, { a: 1000 }, 4000), /余额/);
  assert.throws(() => claimAllocation(items as any, ['a'], 1500, {}, 1000), /余额/);
  assert.throws(() => claimAllocation([{ id: 'a', amount_cents: null, is_protection: false }] as any, ['a'], 1, {}, 1000), /未知/);
  assert.throws(() => claimAllocation(items as any, ['a', 'a'], 100, {}, 4000), /商品/);
});

test('review decisions require reasons and approved claims only close with an external record', () => {
  assert.doesNotThrow(() => validateClaimTransition('submitted', 'approved', '审核通过', undefined));
  assert.throws(() => validateClaimTransition('reviewing', 'rejected', '', undefined), /说明/);
  assert.throws(() => validateClaimTransition('approved', 'closed', '已在外部处理', ''), /外部/);
  assert.doesNotThrow(() => validateClaimTransition('approved', 'closed', '外部已处理', 'external-42'));
  assert.throws(() => validateClaimTransition('closed', 'approved', 'again', undefined), /状态/);
  assert.throws(() => validateClaimTransition('submitted', 'closed', 'cancel', undefined), /状态/);
});

test('CSV exports neutralize spreadsheet formulas and quote multiline user data', () => {
  assert.equal(csvCell('=1+1'), '"\'=1+1"');
  assert.equal(csvCell('  @SUM(A1)'), '"\'  @SUM(A1)"');
  assert.equal(csvCell('a\n"b"'), '"a\n""b"""');
});

test('mutations reject cross-origin or indeterminate browser origins', () => {
  assert.equal(isSameOriginMutation('https://support.example', 'same-origin', 'https', 'support.example'), true);
  assert.equal(isSameOriginMutation('https://evil.example', 'same-origin', 'https', 'support.example'), false);
  assert.equal(isSameOriginMutation(undefined, 'same-origin', 'https', 'support.example'), true);
  assert.equal(isSameOriginMutation(undefined, undefined, 'https', 'support.example'), false);
});
