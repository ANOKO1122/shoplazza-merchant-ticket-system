import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import express from 'express';
import sharp from 'sharp';
import { Pool } from 'pg';
import { PROTECTION_SCHEMA_SQL } from './protection-schema';
import { PROTECTION_NOTIFICATION_SCHEMA_SQL } from './protection-notification-schema';
import { EMAIL_PREFERENCES_SCHEMA_SQL } from './email-preferences-schema';
import { PROTECTION_CUSTOMER_SCHEMA_SQL } from './protection-customer-schema';
import { createProtectionCustomerRouter, createProtectionCustomerAdminRouter } from './protection-customer-routes';
import { createProtectionAccessLink, digest, exchangeProtectionAccessToken, getProtectionCustomer } from './protection-customer-auth';
import { createProtectionRouter } from './protection-routes';
import { createProtectionClaim, syncProtectionOrders, updateProtectionClaim } from './protection-service';
import { closeDatabasePools } from './pg';
import { validateCustomerClaim, validateCustomerLocation } from './protection-customer-service';
import { saveProtectionEvidence, evidenceStoragePath, uploadProtectionEvidence, cleanupProtectionOrphanEvidence } from './protection-customer-media';

test('customer question branch and optional location validation reject contradictory or malformed input',()=>{
  const body={submission_id:crypto.randomUUID(),received_package:true,issue_code:'damaged',selections:[{item_id:'coat',quantity:1}],description:'Damaged coat',evidence_ids:[],location:null};
  assert.equal(validateCustomerClaim(body).issue_code,'damaged');
  assert.throws(()=>validateCustomerClaim({...body,issue_code:'not_arrived'}),/does not match/);
  assert.throws(()=>validateCustomerClaim({...body,received_package:false}),/does not match/);
  assert.throws(()=>validateCustomerClaim({...body,camera_exception_reason:' too short '}),/10 to/);
  assert.throws(()=>validateCustomerClaim({...body,camera_exception_reason:123}),/10 to/);
  assert.throws(()=>validateCustomerClaim({...body,issue_code:'wrong_item',camera_exception_reason:'A long enough camera exception.'}),/only used/);
  assert.equal(validateCustomerLocation(null),null);
  assert.throws(()=>validateCustomerLocation({latitude:91,longitude:0,accuracy_meters:1,captured_at:new Date().toISOString()}),/location/);
  assert.throws(()=>validateCustomerLocation({latitude:0,longitude:0,accuracy_meters:-1,captured_at:new Date().toISOString()}),/location/);
});

test('new not-received claims require location for every supported issue',()=>{
  const base={submission_id:crypto.randomUUID(),received_package:false,selections:[{item_id:'coat',quantity:1}],description:'The package has not arrived.',evidence_ids:[]};
  const location={latitude:0,longitude:0,accuracy_meters:12,captured_at:new Date().toISOString()};
  for(const issue_code of ['delayed','not_arrived','delivered_not_received']){
    for(const missing of [{},{location:null}])assert.throws(()=>validateCustomerClaim({...base,issue_code,...missing}),error=>{
      assert.match((error as Error).message,/location.*required|enable.*location/i);
      assert.doesNotMatch((error as Error).message,/without|skip|optional/i);return true;
    });
    assert.deepEqual(validateCustomerClaim({...base,issue_code,location}).location,location);
  }
});

test('invalid required location cannot invite skipping and optional received claims still accept no location',()=>{
  const base={submission_id:crypto.randomUUID(),received_package:false,issue_code:'not_arrived',selections:[{item_id:'coat',quantity:1}],description:'No package received.',evidence_ids:[]};
  const now=Date.now(),location={latitude:40.7,longitude:-74,accuracy_meters:25,captured_at:new Date(now).toISOString()};
  for(const invalid of [{},{...location,latitude:91},{...location,longitude:-181},{...location,latitude:NaN},{...location,latitude:'40.7'},{...location,accuracy_meters:-1},{...location,accuracy_meters:100001},{...location,captured_at:new Date(now-25*3600000).toISOString()},{...location,captured_at:new Date(now+11*60000).toISOString()}]){
    assert.throws(()=>validateCustomerClaim({...base,location:invalid}),error=>{
      assert.match((error as Error).message,/location/i);
      assert.doesNotMatch((error as Error).message,/without|skip|optional/i);return true;
    });
  }
  for(const issue_code of ['damaged','missing_items'])for(const optional of [{},{location:null}]){
    assert.equal(validateCustomerClaim({...base,received_package:true,issue_code,...optional}).location,null);
  }
});

test('private evidence rejects disguised documents and video without a real stream',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'protection-media-test-'));const previous=process.env.SUPPORT_PROTECTION_EVIDENCE_DIR;process.env.SUPPORT_PROTECTION_EVIDENCE_DIR=root;
  try{
    for(const mime of ['image/png','video/mp4']){const file=path.join(root,crypto.randomUUID());await fs.writeFile(file,'<html>private but not evidence</html>');await assert.rejects(saveProtectionEvidence({path:file,size:36,mimetype:mime,originalname:'fixture'} as Express.Multer.File),/processed|valid/);await assert.rejects(fs.stat(file));}
    const file=path.join(root,'original');await sharp({create:{width:10,height:10,channels:3,background:'#fff'}}).jpeg().toFile(file);
    const saved=await saveProtectionEvidence({path:file,size:(await fs.stat(file)).size,mimetype:'image/jpeg',originalname:'../photo.jpg'} as Express.Multer.File);
    assert.equal(saved.kind,'image');assert.equal(saved.original_name,'photo.jpg');assert.equal((await sharp(evidenceStoragePath(saved.storage_name)).metadata()).format,'webp');
    assert.throws(()=>evidenceStoragePath('../../secret'),/not found/);
  }finally{if(previous===undefined)delete process.env.SUPPORT_PROTECTION_EVIDENCE_DIR;else process.env.SUPPORT_PROTECTION_EVIDENCE_DIR=previous;await fs.rm(root,{recursive:true,force:true});}
});

test('an unavailable evidence directory returns an HTTP error without hanging or unhandled cleanup rejection',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'protection-dir-error-')),file=path.join(root,'regular-file'),previous=process.env.SUPPORT_PROTECTION_EVIDENCE_DIR;
  await fs.writeFile(file,'fixture');process.env.SUPPORT_PROTECTION_EVIDENCE_DIR=file;
  const app=express();app.post('/upload',uploadProtectionEvidence,(_req,res)=>res.json({ok:true}));app.use((_error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>res.status(500).json({ok:false}));
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  try{const form=new FormData();form.set('upload_id',crypto.randomUUID());form.set('file',new Blob(['fixture'],{type:'image/png'}),'fixture.png');const response=await fetch(`http://127.0.0.1:${(server.address() as any).port}/upload`,{method:'POST',body:form,signal:AbortSignal.timeout(2000)});assert.equal(response.status,500);}
  finally{await new Promise<void>(resolve=>server.close(()=>resolve()));if(previous===undefined)delete process.env.SUPPORT_PROTECTION_EVIDENCE_DIR;else process.env.SUPPORT_PROTECTION_EVIDENCE_DIR=previous;await fs.rm(root,{recursive:true,force:true});}
});

test('real MP4 and WebM evidence are parsed as video streams',{skip:!process.env.SUPPORT_PROTECTION_TEST_FFMPEG},async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'protection-real-video-')),previous=process.env.SUPPORT_PROTECTION_EVIDENCE_DIR;process.env.SUPPORT_PROTECTION_EVIDENCE_DIR=root;
  try{
    for(const format of ['mp4','webm']){
      const file=path.join(root,`input.${format}`);
      await promisify(execFile)(process.env.SUPPORT_PROTECTION_TEST_FFMPEG!,['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=white:s=16x16:d=0.2','-c:v',format==='mp4'?'libx264':'libvpx-vp9','-pix_fmt','yuv420p',file],{timeout:15000});
      const saved=await saveProtectionEvidence({path:file,size:(await fs.stat(file)).size,mimetype:`video/${format}`,originalname:`fixture.${format}`} as Express.Multer.File);
      assert.equal(saved.kind,'video');assert.equal(saved.mime_type,`video/${format}`);assert.ok((await fs.stat(evidenceStoragePath(saved.storage_name))).size>0);
    }
    const fake=path.join(root,'fake.mp4');await fs.writeFile(fake,Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.alloc(100)]));
    await assert.rejects(saveProtectionEvidence({path:fake,size:112,mimetype:'video/mp4',originalname:'fake.mp4'} as Express.Multer.File),/verified|valid video/);
  }finally{if(previous===undefined)delete process.env.SUPPORT_PROTECTION_EVIDENCE_DIR;else process.env.SUPPORT_PROTECTION_EVIDENCE_DIR=previous;await fs.rm(root,{recursive:true,force:true});}
});

const databaseUrl=process.env.SUPPORT_PROTECTION_CUSTOMER_TEST_DATABASE_URL;
test('customer portal isolation, evidence, repeated claims and review quantities work together',{skip:!databaseUrl},async t=>{
  assert.match(new URL(databaseUrl!).pathname,/_test$/);process.env.SUPPORT_DATABASE_URL=databaseUrl;process.env.SUPPORT_PROTECTION_POLICY_BASIS='shipment';
  const pool=new Pool({connectionString:databaseUrl}),root=await fs.mkdtemp(path.join(os.tmpdir(),'protection-http-test-'));
  process.env.SUPPORT_PROTECTION_EVIDENCE_DIR=root;
  let server:ReturnType<express.Express['listen']>|undefined;
  const actor={agentId:1,name:'Fixture reviewer',role:'admin'};
  try{
    await pool.query(`DROP FUNCTION IF EXISTS camera_fixture_insert_failure() CASCADE;
      DROP TABLE IF EXISTS support_protection_notification_outbox,support_protection_evidence,support_protection_capture_sessions,support_protection_customer_messages,support_protection_customer_sessions,support_protection_access_tokens,support_protection_claim_events,support_protection_claims,support_protection_orders,support_protection_sync_state,support_protection_sync_dirty,support_protection_stores,support_order_snapshots,support_agent_sessions,support_agents CASCADE;
      CREATE TABLE support_agents(id BIGINT PRIMARY KEY,name TEXT,enabled BOOLEAN DEFAULT true,role TEXT DEFAULT 'admin');INSERT INTO support_agents VALUES(1,'Fixture reviewer',true,'admin');
      CREATE TABLE support_agent_sessions(session_token_hash TEXT,agent_id BIGINT,expires_at TIMESTAMPTZ);
      CREATE TABLE support_protection_stores(store_subdomain TEXT PRIMARY KEY,product_ids JSONB,enabled BOOLEAN DEFAULT true,config_json JSONB DEFAULT '{}');INSERT INTO support_protection_stores VALUES('fixture-store','["protection"]',true,'{}');
      CREATE TABLE support_order_snapshots(id BIGSERIAL PRIMARY KEY,store_subdomain TEXT,store_name TEXT,order_id TEXT,order_number TEXT,customer_email TEXT,customer_name TEXT,order_amount TEXT,order_currency TEXT,payment_status TEXT,order_status TEXT,fulfillment_status TEXT,refund_status TEXT,refund_amount TEXT,paid_at TIMESTAMPTZ,items_json JSONB,raw_order_json JSONB,shipping_address_json JSONB,updated_at TIMESTAMPTZ DEFAULT now(),fetched_at TIMESTAMPTZ DEFAULT now());`);
    await pool.query(PROTECTION_SCHEMA_SQL);await pool.query(PROTECTION_CUSTOMER_SCHEMA_SQL);
    await pool.query(EMAIL_PREFERENCES_SCHEMA_SQL);
    await pool.query(PROTECTION_NOTIFICATION_SCHEMA_SQL);await pool.query(PROTECTION_CUSTOMER_SCHEMA_SQL);
    await pool.query(PROTECTION_NOTIFICATION_SCHEMA_SQL);
    const lines=[{id:'coat',product_id:'goods',quantity:3,total_price:'99.99',product_title:'Fixture coat'},{id:'service',product_id:'protection',quantity:1,total_price:'3.00',product_title:'Fixture protection'}];
    for(const id of ['first','second'])await pool.query(`INSERT INTO support_order_snapshots(store_subdomain,store_name,order_id,order_number,customer_email,customer_name,order_amount,order_currency,payment_status,order_status,fulfillment_status,refund_status,refund_amount,paid_at,items_json,raw_order_json,shipping_address_json) VALUES('fixture-store','Fixture store',$1,$1,$2,'Fixture customer','102.99','USD','paid','placed','waiting','','0',now(),$3,$4,'{"address1":"Fixture street","private_note":"DO NOT EXPOSE"}')`,[id,`${id}@example.invalid`,JSON.stringify(lines),JSON.stringify({total_discount:'0',secret:'DO NOT EXPOSE',created_at:new Date(Date.now()-80*86400000).toISOString(),_support_completed_at:new Date(Date.now()-86400000).toISOString(),_support_completed_source:'orders/finished.updated_at',fulfillments:[{id:'fixture-parcel',status:'shipped',created_at:new Date(Date.now()-70*86400000).toISOString(),line_items:[{id:'coat',ship_quantity:3}]}]})]);
    await syncProtectionOrders(200);
    const orders=(await pool.query('SELECT id,order_id,public_no FROM support_protection_orders ORDER BY order_id')).rows;
    const app=express();app.set('trust proxy',1);app.use(express.json());app.use('/api/protection',createProtectionCustomerRouter());app.use('/api/admin/protection',createProtectionCustomerAdminRouter());app.use('/api/admin/protection',createProtectionRouter());
    server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server!.once('listening',resolve));
    const base=`http://127.0.0.1:${(server.address() as any).port}`;process.env.SUPPORT_PROTECTION_PUBLIC_BASE_URL=base;process.env.SUPPORT_PROTECTION_ALLOW_LOCAL_HTTP='true';
    const access=async(id:string)=>{const url=await createProtectionAccessLink(String(id));const token=new URLSearchParams(new URL(url).hash.slice(1)).get('access');const r=await fetch(base+'/api/protection/session',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({access_token:token})});assert.equal(r.status,200);assert.equal(((await r.json()) as any).protection_no,orders.find(o=>String(o.id)===String(id))!.public_no);assert.match(r.headers.get('set-cookie')!,/HttpOnly/);return r.headers.get('set-cookie')!.split(';')[0];};
    const first=await access(orders[0].id),second=await access(orders[1].id),adminToken='fixture-admin-session',admin=`support_session=${adminToken}`;
    await pool.query('INSERT INTO support_agent_sessions VALUES($1,1,now()+interval \'1 hour\')',[crypto.createHash('sha256').update(adminToken).digest('hex')]);
    const request=(url:string,cookie:string,body?:unknown,method=body?'POST':'GET')=>fetch(base+url,{method,headers:{Cookie:cookie,...(cookie===first?{'X-Protection-Reference':orders[0].public_no}:cookie===second?{'X-Protection-Reference':orders[1].public_no}:{}),...(body?{'Content-Type':'application/json',Origin:base}:{})},...(body?{body:JSON.stringify(body)}:{})});
    let evidenceId:string,claim:any,cameraFixture:any;
    const submission={submission_id:crypto.randomUUID(),received_package:false,issue_code:'delayed',selections:[{item_id:'coat',quantity:1}],description:'Fixture incorrect coat',evidence_ids:[] as string[],location:{latitude:40.7,longitude:-74,accuracy_meters:25,captured_at:new Date().toISOString()}};
    await t.test('HTTP new not-received claims reject missing or invalid location without writing a claim',async()=>{
      const before=Number((await pool.query('SELECT count(*)::int n FROM support_protection_claims')).rows[0].n);
      for(const location of [undefined,null,{...submission.location,longitude:181}]){
        const response=await fetch(base+'/api/protection/claims',{method:'POST',headers:{Cookie:first,Origin:base,'Content-Type':'application/json','X-Protection-Reference':orders[0].public_no,'X-Forwarded-For':'10.23.0.8'},body:JSON.stringify({...submission,submission_id:crypto.randomUUID(),location})});
        assert.equal(response.status,400);const body=await response.json() as any;assert.match(body.error,/location/i);assert.doesNotMatch(body.error,/without|skip|optional/i);
      }
      assert.equal(Number((await pool.query('SELECT count(*)::int n FROM support_protection_claims')).rows[0].n),before);
    });
    await t.test('new access links last 120 days, stay unique per order, and preserve legacy expiry and 12-hour sessions',async()=>{
      const tokenFrom=(url:string)=>new URLSearchParams(new URL(url).hash.slice(1)).get('access')!;
      const token=tokenFrom(await createProtectionAccessLink(String(orders[0].id)));
      const row=(await pool.query('SELECT * FROM support_protection_access_tokens WHERE token_hash=$1',[digest(token)])).rows[0];
      assert.equal(row.expires_at.getTime()-row.created_at.getTime(),120*86400000);
      const otherToken=tokenFrom(await createProtectionAccessLink(String(orders[1].id)));
      assert.notEqual(otherToken,token);
      const otherRow=(await pool.query('SELECT protection_order_id,expires_at,created_at FROM support_protection_access_tokens WHERE token_hash=$1',[digest(otherToken)])).rows[0];
      assert.equal(String(row.protection_order_id),String(orders[0].id));
      assert.equal(String(otherRow.protection_order_id),String(orders[1].id));
      assert.equal(otherRow.expires_at.getTime()-otherRow.created_at.getTime(),120*86400000);
      assert.equal((await exchangeProtectionAccessToken(otherToken)).protection_no,orders[1].public_no);
      await assert.rejects(pool.query(`INSERT INTO support_protection_access_tokens(token_hash,protection_order_id,customer_email,expires_at)
        VALUES($1,$2,'second@example.invalid',now()+interval '120 days')`,[digest(token),orders[1].id]),(error:any)=>error.code==='23505');
      const {session}=await exchangeProtectionAccessToken(token);
      const sessionRow=(await pool.query('SELECT * FROM support_protection_customer_sessions WHERE session_hash=$1',[digest(session)])).rows[0];
      assert.equal(sessionRow.expires_at.getTime()-sessionRow.created_at.getTime(),12*3600000);
      const requestFor=(value:string)=>({headers:{cookie:`protection_customer=${value}`}} as any);
      assert.ok(await getProtectionCustomer(requestFor(session)));
      await pool.query("UPDATE support_protection_access_tokens SET revoked_at=now() WHERE token_hash=$1",[digest(token)]);
      await assert.rejects(exchangeProtectionAccessToken(token),/invalid or expired/);
      assert.equal(await getProtectionCustomer(requestFor(session)),null);
      const legacy=`pa_${crypto.randomBytes(32).toString('base64url')}`;
      const legacyRow=(await pool.query(`INSERT INTO support_protection_access_tokens(token_hash,protection_order_id,customer_email,expires_at)
        VALUES($1,$2,'first@example.invalid',now()+interval '30 days') RETURNING expires_at`,[digest(legacy),orders[0].id])).rows[0];
      await exchangeProtectionAccessToken(legacy);await createProtectionAccessLink(String(orders[0].id));
      assert.equal((await pool.query('SELECT expires_at FROM support_protection_access_tokens WHERE token_hash=$1',[digest(legacy)])).rows[0].expires_at.getTime(),legacyRow.expires_at.getTime());
      const previous90=`pa_${crypto.randomBytes(32).toString('base64url')}`;
      const previous90Row=(await pool.query(`INSERT INTO support_protection_access_tokens(token_hash,protection_order_id,customer_email,expires_at)
        VALUES($1,$2,'first@example.invalid',now()+interval '90 days') RETURNING expires_at`,[digest(previous90),orders[0].id])).rows[0];
      await createProtectionAccessLink(String(orders[0].id));
      assert.equal((await pool.query('SELECT expires_at FROM support_protection_access_tokens WHERE token_hash=$1',[digest(previous90)])).rows[0].expires_at.getTime(),previous90Row.expires_at.getTime());
      const short=(await pool.query("UPDATE support_protection_access_tokens SET expires_at=now()+interval '1 hour' WHERE token_hash=$1 RETURNING expires_at",[digest(legacy)])).rows[0];
      const clipped=await exchangeProtectionAccessToken(legacy);
      assert.equal((await pool.query('SELECT expires_at FROM support_protection_customer_sessions WHERE session_hash=$1',[digest(clipped.session)])).rows[0].expires_at.getTime(),short.expires_at.getTime());
      await pool.query("UPDATE support_protection_access_tokens SET expires_at=now()-interval '1 second' WHERE token_hash=$1",[digest(legacy)]);
      await assert.rejects(exchangeProtectionAccessToken(legacy),/invalid or expired/);
      assert.equal(await getProtectionCustomer(requestFor(clipped.session)),null);
    });
    await t.test('customer windows expose verified dates and cannot be bypassed with unsupported issues or an unopened date',async()=>{
      const view=await(await request('/api/protection/order',first)).json() as any;
      assert.equal('store_name' in view.order,false,'Customer order response must not expose the merchant name');
      assert.equal(view.coverage.policy_version,'2026-11-03:shipment');assert.ok(view.order.items[0].request_windows.every((w:any)=>w.status==='open'));
      const unsupported=await request('/api/protection/claims',first,{...submission,submission_id:crypto.randomUUID(),received_package:true,issue_code:'wrong_item'});
      assert.equal(unsupported.status,400);assert.match(((await unsupported.json()) as any).error,/outside shipping protection/);
      const saved=(await pool.query('SELECT timeline_json FROM support_protection_orders WHERE id=$1',[orders[0].id])).rows[0].timeline_json;
      await pool.query(`UPDATE support_protection_orders SET timeline_json=jsonb_set(timeline_json,'{items,coat,shipped_at}',to_jsonb((now()-interval '25 days')::text)) WHERE id=$1`,[orders[0].id]);
      const early=await request('/api/protection/claims',first,{...submission,submission_id:crypto.randomUUID()});assert.equal(early.status,400);assert.match(((await early.json()) as any).error,/not opened/);
      await pool.query('UPDATE support_protection_orders SET timeline_json=$2 WHERE id=$1',[orders[0].id,JSON.stringify(saved)]);
    });
    await t.test('separate sessions reject ticket tokens, missing auth, and cross-origin writes',async()=>{
      assert.equal((await request('/api/protection/order','')).status,401);
      assert.equal((await request('/api/protection/order',admin)).status,401);
      assert.equal((await request('/api/protection/session','',{access_token:'ta_fake'})).status,401);
      const foreign=await fetch(base+'/api/protection/claims',{method:'POST',headers:{Cookie:first,Origin:'https://evil.invalid','Content-Type':'application/json'},body:JSON.stringify(submission)});assert.equal(foreign.status,403);
      const data=await(await request('/api/protection/order',first)).json() as any;assert.equal(data.order.order_number,'first');assert.equal(JSON.stringify(data).includes('DO NOT EXPOSE'),false);
      const staleTab=await fetch(base+'/api/protection/claims',{method:'POST',headers:{Cookie:second,Origin:base,'Content-Type':'application/json','X-Protection-Reference':orders[0].public_no},body:JSON.stringify(submission)});
      assert.equal(staleTab.status,409);assert.equal(((await staleTab.json()) as any).error_code,'protection_reference_mismatch');
      const staleRead=await fetch(base+'/api/protection/order',{headers:{Cookie:second,'X-Protection-Reference':orders[0].public_no}});assert.equal(staleRead.status,409);
    });
    await t.test('uploads stay private; owner and admin can read; other orders cannot; unsubmitted files can be removed',async()=>{
      const image=await sharp({create:{width:10,height:10,channels:3,background:'#fff'}}).png().toBuffer();
      const uploadId=crypto.randomUUID();const form=new FormData();form.set('upload_id',uploadId);form.set('file',new Blob([image],{type:'image/png'}),'fixture.png');
      const upload=await fetch(base+'/api/protection/evidence',{method:'POST',headers:{Cookie:first,Origin:base,'X-Protection-Reference':orders[0].public_no},body:form});assert.equal(upload.status,201,await upload.clone().text());const data=await upload.json() as any;evidenceId=data.evidence.id;
      assert.equal((await request(data.evidence.url,'')).status,401);assert.equal((await request(data.evidence.url,second)).status,404);assert.equal((await request(data.evidence.url,first)).status,200);assert.equal((await request(data.evidence.url,admin)).status,200);
      const range=await fetch(base+data.evidence.url,{headers:{Cookie:admin,Range:'bytes=0-9'}});assert.equal(range.status,206);assert.equal((await range.arrayBuffer()).byteLength,10);
      const retryForm=new FormData();retryForm.set('upload_id',uploadId);retryForm.set('file',new Blob([image],{type:'image/png'}),'fixture.png');
      const retried=await fetch(base+'/api/protection/evidence',{method:'POST',headers:{Cookie:first,Origin:base,'X-Protection-Reference':orders[0].public_no},body:retryForm});assert.equal(retried.status,201);assert.equal(((await retried.json()) as any).evidence.id,evidenceId);
      assert.equal((await pool.query('SELECT count(*)::int n FROM support_protection_evidence')).rows[0].n,1);
      const otherImage=await sharp({create:{width:10,height:10,channels:3,background:'#000'}}).png().toBuffer();const conflictForm=new FormData();conflictForm.set('upload_id',uploadId);conflictForm.set('file',new Blob([otherImage],{type:'image/png'}),'fixture.png');
      assert.equal((await fetch(base+'/api/protection/evidence',{method:'POST',headers:{Cookie:first,Origin:base,'X-Protection-Reference':orders[0].public_no},body:conflictForm})).status,409);
      assert.equal((await request(data.evidence.url,second,{},'DELETE')).status,404);
      assert.equal((await request(data.evidence.url,first,{},'DELETE')).status,200);
      const form2=new FormData();form2.set('upload_id',crypto.randomUUID());form2.set('file',new Blob([image],{type:'image/png'}),'fixture.png');const r=await fetch(base+'/api/protection/evidence',{method:'POST',headers:{Cookie:first,Origin:base,'X-Protection-Reference':orders[0].public_no},body:form2});evidenceId=((await r.json()) as any).evidence.id;
    });
    await t.test('submission is idempotent and quantity is server-priced; other contract evidence is rejected',async()=>{
      const foreign=await request('/api/protection/claims',second,{...submission,evidence_ids:[evidenceId]});assert.equal(foreign.status,400);
      submission.evidence_ids=[evidenceId];const firstResponse=await request('/api/protection/claims',first,submission);assert.equal(firstResponse.status,201,await firstResponse.clone().text());claim=((await firstResponse.json()) as any).claim;
      assert.equal(claim.requested_amount_cents,3333);assert.equal(claim.evidence.length,1);
      assert.deepEqual(claim.location,submission.location);
      const retry=await request('/api/protection/claims',first,submission);assert.equal(((await retry.json()) as any).claim.public_no,claim.public_no);
      assert.equal((await request('/api/protection/claims',first,{...submission,description:'changed'})).status,409);
      assert.equal((await request(`/api/protection/claims/${claim.public_no}`,second)).status,404);
      assert.equal((await request(`/api/protection/evidence/${evidenceId}`,first,{},'DELETE')).status,404);
    });
    await t.test('legacy claims without location remain readable and supplementable; public reply stays separate from internal notes',async()=>{
      const row=(await pool.query('SELECT id FROM support_protection_claims WHERE public_no=$1',[claim.public_no])).rows[0];
      await pool.query('UPDATE support_protection_claims SET location_json=NULL WHERE id=$1',[row.id]);
      const updated=await updateProtectionClaim(String(row.id),{revision:1,status:'needs_info',note:'PRIVATE INVESTIGATION',customer_message:'Please add a photo of the packaging.'},actor);
      const publicDetail=await(await request(`/api/protection/claims/${claim.public_no}`,first)).json() as any;
      assert.equal(publicDetail.claim.received_package,false);assert.equal(publicDetail.claim.location,null);
      assert.equal(publicDetail.claim.customer_message,'Please add a photo of the packaging.');assert.equal(JSON.stringify(publicDetail).includes('PRIVATE INVESTIGATION'),false);
      const message={submission_id:crypto.randomUUID(),description:'Package details',evidence_ids:[]};
      const reply=await request(`/api/protection/claims/${claim.public_no}/messages`,first,message);assert.equal(reply.status,201);const result=await reply.json() as any;assert.equal(result.claim.public_no,claim.public_no);assert.equal(result.claim.status,'reviewing');
      assert.equal(result.claim.location,null);
      await request(`/api/protection/claims/${claim.public_no}/messages`,first,message);
      assert.equal((await pool.query('SELECT count(*)::int n FROM support_protection_customer_messages WHERE claim_id=$1',[row.id])).rows[0].n,1);
      await assert.rejects(updateProtectionClaim(String(row.id),{revision:updated.revision,status:'approved',approved_amount_cents:3333},actor),/其他操作/);
    });
    await t.test('rejection permits a new issue with stable contract; approvals reserve selected quantity',async()=>{
      const row=(await pool.query('SELECT id,revision FROM support_protection_claims WHERE public_no=$1',[claim.public_no])).rows[0];
      await updateProtectionClaim(String(row.id),{revision:row.revision,status:'rejected',note:'PRIVATE REASON',customer_message:'The evidence is incomplete.'},actor);
      const next=await request('/api/protection/claims',first,{...submission,submission_id:crypto.randomUUID(),evidence_ids:[]});const replacement=((await next.json()) as any).claim;assert.notEqual(replacement.public_no,claim.public_no);assert.equal(replacement.protection_no,claim.protection_no);
      const current=(await pool.query('SELECT id,revision FROM support_protection_claims WHERE public_no=$1',[replacement.public_no])).rows[0];
      await assert.rejects(updateProtectionClaim(String(current.id),{revision:current.revision,status:'approved',approved_amount_cents:3334},actor),/申请|余额/);
      const approved=await updateProtectionClaim(String(current.id),{revision:current.revision,status:'approved',approved_amount_cents:3000,note:'PRIVATE APPROVAL'},actor);
      await updateProtectionClaim(String(current.id),{revision:approved.revision,status:'closed',note:'PRIVATE CLOSURE',external_reference:'PRIVATE TRANSFER'},actor);
      const data=await(await request('/api/protection/order',first)).json() as any;assert.equal(data.order.items[0].available_quantity,2);assert.equal(JSON.stringify(data).includes('PRIVATE'),false);
      assert.equal((await request('/api/protection/claims',first,{...submission,submission_id:crypto.randomUUID(),evidence_ids:[],selections:[{item_id:'coat',quantity:3}]})).status,400);
      const r=await request('/api/protection/claims',first,{...submission,submission_id:crypto.randomUUID(),evidence_ids:[],selections:[{item_id:'coat',quantity:2}]});assert.equal(r.status,201);assert.equal(((await r.json()) as any).claim.requested_amount_cents,6666);
      const adminDetail=await(await request(`/api/admin/protection/claims/${current.id}`,admin)).json() as any;assert.ok(adminDetail.customer_submission);assert.equal(adminDetail.claim.external_reference,'PRIVATE TRANSFER');
    });
    await t.test('camera tickets bind photos to the customer session and expire while successful retries remain idempotent',async()=>{
      const headers={Cookie:second,Origin:base,'X-Protection-Reference':orders[1].public_no,'X-Forwarded-For':'10.23.0.2'};
      const capture=async(category:string)=>fetch(base+'/api/protection/capture-sessions',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({category})});
      const ticketResponse=await capture('damaged_item');assert.equal(ticketResponse.status,201,await ticketResponse.clone().text());const ticket=((await ticketResponse.json()) as any).capture;
      assert.equal(ticket.category,'damaged_item');assert.ok(Date.parse(ticket.expires_at)>Date.now());
      assert.equal((await capture('forged_category')).status,400);
      const image=await sharp({create:{width:12,height:12,channels:3,background:'#fff'}}).png().toBuffer();
      const upload=async(captureId:string|undefined,uploadId=crypto.randomUUID(),bytes=image,customHeaders=headers)=>{const form=new FormData();form.set('upload_id',uploadId);if(captureId)form.set('capture_id',captureId);form.set('file',new Blob([bytes],{type:'image/png'}),'camera.png');return fetch(base+'/api/protection/evidence',{method:'POST',headers:customHeaders,body:form});};
      const wrongOrder=await upload(ticket.id,crypto.randomUUID(),image,{...headers,Cookie:first,'X-Protection-Reference':orders[0].public_no});assert.equal(wrongOrder.status,400);
      const otherCookie=await access(orders[1].id);assert.equal((await upload(ticket.id,crypto.randomUUID(),image,{...headers,Cookie:otherCookie})).status,400);
      const expired=((await(await capture('outer_packaging')).json()) as any).capture;await pool.query("UPDATE support_protection_capture_sessions SET expires_at=now()-interval '1 second' WHERE id=$1",[expired.id]);assert.equal((await upload(expired.id)).status,400);
      const uploadId=crypto.randomUUID(),photoResponse=await upload(ticket.id,uploadId);assert.equal(photoResponse.status,201,await photoResponse.clone().text());const photo=((await photoResponse.json()) as any).evidence;
      assert.equal(photo.source,'camera');assert.equal(photo.capture.category,'damaged_item');assert.ok(Date.parse(photo.capture.received_at)>=Date.parse(photo.capture.requested_at));
      await pool.query("UPDATE support_protection_capture_sessions SET expires_at=now()-interval '1 second' WHERE id=$1",[ticket.id]);
      const retry=await upload(ticket.id,uploadId);assert.equal(retry.status,201);assert.equal(((await retry.json()) as any).evidence.id,photo.id);
      assert.equal((await upload(ticket.id)).status,409);assert.equal((await upload(undefined,uploadId)).status,409);
      const otherBytes=await sharp({create:{width:12,height:12,channels:3,background:'#000'}}).png().toBuffer();assert.equal((await upload(ticket.id,uploadId,otherBytes)).status,409);
      // Keep the server-ticketed fixture for the claim-rule tests below.
      cameraFixture=photo;
    });
    await t.test('damage claims require camera evidence or a visible manual-review exception; supplements cannot bypass the rule',async()=>{
      const headers={Cookie:second,Origin:base,'X-Protection-Reference':orders[1].public_no,'X-Forwarded-For':'10.23.0.3','Content-Type':'application/json'};
      const submit=async(extra:Record<string,unknown>)=>fetch(base+'/api/protection/claims',{method:'POST',headers,body:JSON.stringify({...submission,submission_id:crypto.randomUUID(),received_package:true,issue_code:'damaged',evidence_ids:[],...extra})});
      const genericForm=new FormData();genericForm.set('upload_id',crypto.randomUUID());genericForm.set('file',new Blob([await sharp({create:{width:12,height:12,channels:3,background:'#f00'}}).png().toBuffer()],{type:'image/png'}),'gallery.png');
      const {['Content-Type']:_,...uploadHeaders}=headers;const genericResponse=await fetch(base+'/api/protection/evidence',{method:'POST',headers:uploadHeaders,body:genericForm});assert.equal(genericResponse.status,201);const generic=((await genericResponse.json()) as any).evidence;
      assert.equal((await submit({})).status,400);
      assert.equal((await submit({camera_exception_reason:'no'})).status,400);
      const exception='This device has no working camera. Please review my request manually.';
      const forbidden=await submit({evidence_ids:[generic.id],camera_exception_reason:exception,source:'camera'});assert.equal(forbidden.status,400);assert.match(((await forbidden.json()) as any).error,/ordinary attachments/);
      const exceptionResponse=await submit({camera_exception_reason:exception});assert.equal(exceptionResponse.status,201,await exceptionResponse.clone().text());const exceptionClaim=((await exceptionResponse.json()) as any).claim;
      assert.equal(exceptionClaim.camera_exception_reason,exception);assert.equal(exceptionClaim.status,'submitted');
      const exceptionRow=(await pool.query('SELECT id,revision FROM support_protection_claims WHERE public_no=$1',[exceptionClaim.public_no])).rows[0];
      const detail=await(await request(`/api/admin/protection/claims/${exceptionRow.id}`,admin)).json() as any;assert.equal(detail.customer_submission.camera_exception_reason,exception);
      await updateProtectionClaim(String(exceptionRow.id),{revision:exceptionRow.revision,status:'rejected',note:'Fixture reset'},actor);
      const normalResponse=await submit({evidence_ids:[cameraFixture.id]});assert.equal(normalResponse.status,201,await normalResponse.clone().text());const normal=((await normalResponse.json()) as any).claim;
      assert.equal(normal.evidence[0].capture.category,'damaged_item');assert.equal(normal.camera_exception_reason,null);
      const add=(evidence_ids:string[])=>fetch(base+`/api/protection/claims/${normal.public_no}/messages`,{method:'POST',headers,body:JSON.stringify({submission_id:crypto.randomUUID(),description:'More fixture information',evidence_ids})});
      assert.equal((await add([generic.id])).status,400);assert.equal((await add([])).status,201);
      // A legacy damage claim keeps its original gallery evidence readable but
      // cannot add a new gallery attachment under the new camera policy.
      const row=(await pool.query('SELECT id FROM support_protection_claims WHERE public_no=$1',[normal.public_no])).rows[0];
      await pool.query('UPDATE support_protection_evidence SET claim_id=$1 WHERE id=$2',[row.id,generic.id]);
      const legacy=await(await request(`/api/protection/claims/${normal.public_no}`,second)).json() as any;assert.equal(legacy.claim.evidence.some((e:any)=>e.id===generic.id&&e.source==='upload'),true);
    });
    await t.test('customer camera and text supplements to a legacy admin damage claim are visible to staff without exposing its private description',async()=>{
      const active=(await pool.query("SELECT id,revision FROM support_protection_claims WHERE protection_order_id=$1 AND status='submitted' ORDER BY id DESC LIMIT 1",[orders[1].id])).rows[0];
      await updateProtectionClaim(String(active.id),{revision:active.revision,status:'rejected',note:'Fixture closes previous request'},actor);
      const legacy=await createProtectionClaim({protection_order_id:String(orders[1].id),item_ids:['coat'],reason:'damaged',description:'PRIVATE LEGACY INVESTIGATION',requested_amount_cents:1000},actor);
      const headers={Cookie:second,Origin:base,'X-Protection-Reference':orders[1].public_no,'X-Forwarded-For':'10.23.0.6'};
      const captureResponse=await fetch(base+'/api/protection/capture-sessions',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({category:'additional'})});assert.equal(captureResponse.status,201);const ticket=((await captureResponse.json()) as any).capture;
      const form=new FormData();form.set('upload_id',crypto.randomUUID());form.set('capture_id',ticket.id);form.set('file',new Blob([await sharp({create:{width:12,height:12,channels:3,background:'#def'}}).png().toBuffer()],{type:'image/png'}),'camera.png');
      const upload=await fetch(base+'/api/protection/evidence',{method:'POST',headers,body:form});assert.equal(upload.status,201);const photo=((await upload.json()) as any).evidence;
      const supplement=await fetch(base+`/api/protection/claims/${legacy.public_no}/messages`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({submission_id:crypto.randomUUID(),description:'Additional camera photo for the registered damage claim',evidence_ids:[photo.id]})});assert.equal(supplement.status,201);assert.equal(JSON.stringify(await supplement.json()).includes('PRIVATE LEGACY INVESTIGATION'),false);
      const detail=await(await request(`/api/admin/protection/claims/${legacy.id}`,admin)).json() as any;
      assert.equal(detail.claim.description,'PRIVATE LEGACY INVESTIGATION');
      assert.ok(detail.customer_submission,'Staff must see material added by the customer to a legacy claim');
      assert.equal(detail.customer_submission.messages[0].evidence[0].source,'camera');
      assert.equal(detail.customer_submission.messages[0].description,'Additional camera photo for the registered damage claim');
      assert.equal(detail.customer_submission.description,'This request was registered by the store.');
    });
    await t.test('camera consumption is atomic, photo-only and single-use under concurrent uploads; abandoned tickets are bounded and cleaned',async()=>{
      const headers={Cookie:second,Origin:base,'X-Protection-Reference':orders[1].public_no,'X-Forwarded-For':'10.23.0.4'};
      const capture=async(category='additional')=>fetch(base+'/api/protection/capture-sessions',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({category})});
      const ticket=((await(await capture()).json()) as any).capture;
      const image=await sharp({create:{width:12,height:12,channels:3,background:'#abc'}}).png().toBuffer();
      const upload=async(captureId:string,uploadId=crypto.randomUUID(),mimetype='image/png')=>{const form=new FormData();form.set('upload_id',uploadId);form.set('capture_id',captureId);form.set('file',new Blob([image],{type:mimetype}),'fixture');return fetch(base+'/api/protection/evidence',{method:'POST',headers,body:form});};
      const video=await upload(ticket.id,crypto.randomUUID(),'video/mp4');assert.equal(video.status,400);assert.match(((await video.json()) as any).error,/still photos/);
      const competing=await Promise.all([upload(ticket.id),upload(ticket.id)]);assert.deepEqual(competing.map(r=>r.status).sort(),[201,409]);
      const photo=((await competing.find(r=>r.status===201)!.json()) as any).evidence;
      const broken=((await(await capture('shipping_label')).json()) as any).capture,uploadId=crypto.randomUUID();
      await pool.query(`CREATE FUNCTION camera_fixture_insert_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.capture_category='shipping_label' THEN RAISE EXCEPTION 'fixture insert failure'; END IF; RETURN NEW; END$$;
        CREATE TRIGGER camera_fixture_insert_failure BEFORE INSERT ON support_protection_evidence FOR EACH ROW EXECUTE FUNCTION camera_fixture_insert_failure();`);
      assert.equal((await upload(broken.id,uploadId)).status,500);
      assert.equal((await pool.query('SELECT upload_id FROM support_protection_capture_sessions WHERE id=$1',[broken.id])).rows[0].upload_id,null);
      await pool.query('DROP TRIGGER camera_fixture_insert_failure ON support_protection_evidence; DROP FUNCTION camera_fixture_insert_failure();');
      assert.equal((await upload(broken.id,uploadId)).status,201);
      assert.equal((await fetch(base+photo.url,{method:'DELETE',headers:{...headers,'Content-Type':'application/json'},body:'{}'})).status,200);
      let created=0,limited=false;
      for(let n=0;n<25;n++){const r=await capture();if(r.status===429){limited=true;break;}assert.equal(r.status,201);created++;}
      assert.equal(limited,true);assert.ok(created<=24);
      await pool.query("UPDATE support_protection_capture_sessions SET expires_at=now()-interval '25 hours'");
      await cleanupProtectionOrphanEvidence();
      assert.equal((await pool.query('SELECT count(*)::int n FROM support_protection_capture_sessions c WHERE NOT EXISTS(SELECT 1 FROM support_protection_evidence e WHERE e.capture_id=c.id)')).rows[0].n,0);
      assert.ok((await pool.query('SELECT count(*)::int n FROM support_protection_capture_sessions')).rows[0].n>0,'Referenced capture metadata stays available');
    });
    await t.test('changing customer identity revokes prior customer token access',async()=>{
      await pool.query("UPDATE support_protection_orders SET customer_email='new@example.invalid' WHERE id=$1",[orders[0].id]);assert.equal((await request('/api/protection/order',first)).status,401);
    });
  }finally{if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));await pool.end();await closeDatabasePools();await fs.rm(root,{recursive:true,force:true});}
});
