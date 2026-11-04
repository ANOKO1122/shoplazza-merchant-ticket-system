import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { Pool } from 'pg';
import { createVisibilityPublicRouter, VISIBILITY_STORE, VISIBILITY_THEME } from './product-visibility';
import { VISIBILITY_SCHEMA } from './product-visibility-schema';

const rule = { enabled: false, keyword: 'men', tags: ['女', 'VIP'], device: 'both', revision: 9, updated_at: '2026-11-02T12:00:00.000Z' };
async function fixture(run: (base: string, calls: Array<{sql: string; values: unknown[]}>) => Promise<void>, result: 'ok'|'missing'|'error' = 'ok') {
  const calls: Array<{sql: string; values: unknown[]}> = [];
  const db = { async query(sql: string, values: unknown[]) {
    calls.push({sql,values});
    assert.match(sql, /^SELECT enabled,keyword,tags,device,revision,updated_at FROM support_product_visibility WHERE store_subdomain=\$1$/);
    assert.deepEqual(values, [VISIBILITY_STORE]);
    if (result === 'error') throw new Error('PRIVATE database connection details');
    return { rows: result === 'missing' ? [] : [{...rule}] };
  }} as any;
  const app = express();app.use('/api/storefront/visibility', createVisibilityPublicRouter({db}));
  const server = app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  try { await run(`http://127.0.0.1:${(server.address() as {port:number}).port}`,calls); }
  finally { server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve())); }
}

test('retained public visibility endpoint returns only the saved pilot rule with no cache and cross-origin read access',async()=>{
  await fixture(async(base,calls)=>{
    const response=await fetch(base+'/api/storefront/visibility/amao04',{headers:{Origin:'https://amao04.myshoplaza.com'}});
    assert.equal(response.status,200);assert.equal(response.headers.get('access-control-allow-origin'),'*');assert.equal(response.headers.get('cache-control'),'no-store');
    assert.deepEqual(await response.json(),{ok:true,store:VISIBILITY_STORE,theme:VISIBILITY_THEME,scope:'homepage-and-search',rule});
    assert.equal(calls.length,1);
    assert.equal((await fetch(base+'/api/storefront/visibility/another-store')).status,404);assert.equal(calls.length,1);
  });
});

test('retired editing interface is not restored and public writes cannot mutate the rule',async()=>{
  await fixture(async(base,calls)=>{
    for(const method of ['POST','PUT','PATCH','DELETE']) {
      const response=await fetch(base+'/api/storefront/visibility/amao04',{method,headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:true,keyword:'overwrite'})});
      assert.equal(response.status,405);assert.equal(response.headers.get('allow'),'GET, HEAD');
    }
    assert.equal((await fetch(base+'/api/admin/product-visibility')).status,404);assert.equal(calls.length,0);
  });
});

test('missing or unavailable rules fail closed at the API without fabricating configuration or leaking database details',async()=>{
  for(const result of ['missing','error'] as const) await fixture(async(base,calls)=>{
    const response=await fetch(base+'/api/storefront/visibility/amao04');
    assert.equal(response.status,503);assert.equal(response.headers.get('cache-control'),'no-store');
    assert.deepEqual(await response.json(),{ok:false,error:'Configuration unavailable'});assert.equal(calls.length,1);
  },result);
});

const databaseUrl=process.env.SUPPORT_PRODUCT_VISIBILITY_TEST_DATABASE_URL;
test('visibility schema is additive and preserves saved pilot configuration on repeated startup',{skip:!databaseUrl},async t=>{
  const url=new URL(databaseUrl!);assert.ok(['127.0.0.1','localhost'].includes(url.hostname));assert.match(url.pathname,/_test$/);
  const pool=new Pool({connectionString:databaseUrl});
  try {
    await pool.query('DROP TABLE IF EXISTS support_product_visibility');
    await t.test('fresh schema supplies the historical preview defaults, then preserves all saved fields',async()=>{
      await pool.query(VISIBILITY_SCHEMA);
      const initial=(await pool.query('SELECT * FROM support_product_visibility')).rows[0];
      assert.equal(initial.store_subdomain,VISIBILITY_STORE);assert.equal(initial.enabled,true);assert.equal(initial.keyword,'women');assert.equal(initial.device,'desktop');assert.equal(initial.revision,0);assert.deepEqual(initial.tags,[]);
      await pool.query("UPDATE support_product_visibility SET enabled=false,keyword='men',tags='[\"女\",\"VIP\"]',device='both',revision=9,updated_at='2026-11-02T12:00:00Z' WHERE store_subdomain=$1",[VISIBILITY_STORE]);
      const saved=(await pool.query('SELECT * FROM support_product_visibility')).rows;
      await pool.query(VISIBILITY_SCHEMA);await pool.query(VISIBILITY_SCHEMA);
      assert.deepEqual((await pool.query('SELECT * FROM support_product_visibility')).rows,saved);
    });
    await t.test('pre-tag schema upgrades without resetting existing settings',async()=>{
      await pool.query(`ALTER TABLE support_product_visibility DROP COLUMN tags`);
      const before=(await pool.query('SELECT * FROM support_product_visibility')).rows[0];
      await pool.query(VISIBILITY_SCHEMA);
      const after=(await pool.query('SELECT * FROM support_product_visibility')).rows[0];
      assert.deepEqual(after,{...before,tags:[]});
    });
  } finally { await pool.end(); }
});
