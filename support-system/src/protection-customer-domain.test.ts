import test from 'node:test';
import assert from 'node:assert/strict';
import { claimAllocation } from './protection-domain';
import type { ProtectionItem } from './protection-types';
const items: ProtectionItem[] = [{id:'a',product_id:'a',variant_id:'a',title:'Three coats',image_url:null,quantity:3,amount_cents:10000,is_protection:false}];
test('selected quantity caps approval to its proportional cents, not the full merchandise row',()=>{
  assert.throws(()=>claimAllocation(items,['a'],3334,{},10000,[{item_id:'a',quantity:1}]),/数量|余额/);
  assert.deepEqual(claimAllocation(items,['a'],3333,{},10000,[{item_id:'a',quantity:1}]),{a:3333});
});
test('quantity selections reject noninteger, excessive, duplicate, and mismatched rows',()=>{
  for(const selections of [[{item_id:'a',quantity:4}],[{item_id:'a',quantity:0}],[{item_id:'a',quantity:1.2}],[{item_id:'b',quantity:1}],[{item_id:'a',quantity:1},{item_id:'a',quantity:1}]])
    assert.throws(()=>claimAllocation(items,['a'],1,{},10000,selections),/数量|商品/);
});
