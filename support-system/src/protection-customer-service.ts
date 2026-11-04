import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { query } from './pg';
import { ACTIVE_CLAIM_STATUSES, ProtectionError, claimAllocation, record, text } from './protection-domain';
import { assertOrderEligible, assertNoOverlap, assertProtectionRequestWindow, balanceState, getProtectionOrder, lockedCurrentOrder, transaction } from './protection-service';
import { evaluateProtectionCoverage } from './protection-policy';
import type { ProtectionOrder } from './protection-types';
import type { ProtectionCustomerIdentity } from './protection-customer-auth';
import type { CustomerCaptureCategory, CustomerCaptureSession, CustomerClaim, CustomerClaimInput, CustomerEvidence, CustomerIssueCode, CustomerLocation, CustomerOrderResponse, CustomerSelection } from './protection-customer-types';

export const EVIDENCE_LIMITS={max_files:6,max_file_bytes:25*1024*1024,max_total_bytes:100*1024*1024};
export const CAPTURE_CATEGORIES:readonly CustomerCaptureCategory[]=['damaged_item','outer_packaging','shipping_label','additional'];
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const iso=(value:any)=>new Date(value).toISOString();
const issueReasons:Record<CustomerIssueCode,string>={damaged:'damaged',missing_items:'lost',wrong_item:'other',delivered_not_received:'stolen',not_arrived:'lost',delayed:'delayed',other:'other'};
const hash=(value:unknown)=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function validateIdempotency(value:unknown):string{if(typeof value!=='string'||!UUID.test(value))throw new ProtectionError('Please refresh this request and try again.');return value.toLowerCase();}
export function validateCustomerLocation(value:unknown):CustomerLocation|null {
  if(value===null||value===undefined)return null;
  const v=record(value),time=Date.parse(v.captured_at);
  if(typeof v.latitude!=='number'||!Number.isFinite(v.latitude)||Math.abs(v.latitude)>90||typeof v.longitude!=='number'||!Number.isFinite(v.longitude)||Math.abs(v.longitude)>180
    ||typeof v.accuracy_meters!=='number'||!Number.isFinite(v.accuracy_meters)||v.accuracy_meters<0||v.accuracy_meters>100000
    ||!Number.isFinite(time)||time>Date.now()+10*60*1000||time<Date.now()-24*60*60*1000)throw new ProtectionError('The location information is invalid. You can continue without sharing your location.');
  return {latitude:v.latitude,longitude:v.longitude,accuracy_meters:v.accuracy_meters,captured_at:new Date(time).toISOString()};
}
function evidenceIds(value:unknown):string[]{
  if(!Array.isArray(value)||value.length>EVIDENCE_LIMITS.max_files||value.some(v=>typeof v!=='string'||!UUID.test(v))||new Set(value).size!==value.length)throw new ProtectionError('Please select up to six valid evidence files.');
  return value;
}
function description(value:unknown):string {if(typeof value!=='string'||!value.trim()||value.length>10000)throw new ProtectionError('Please describe the issue using up to 10,000 characters.');return value.trim();}
export function validateCustomerClaim(input:unknown):CustomerClaimInput{
  const v=record(input),received=v.received_package,issue=v.issue_code;
  if(typeof received!=='boolean'||typeof issue!=='string'||!Object.prototype.hasOwnProperty.call(issueReasons,issue))throw new ProtectionError('Please answer whether you received the package and select an issue.');
  if((received&&['not_arrived','delivered_not_received','delayed'].includes(issue))||(!received&&['damaged','missing_items','wrong_item'].includes(issue)))throw new ProtectionError('The selected issue does not match your package answer.');
  if(!Array.isArray(v.selections)||!v.selections.length||v.selections.length>100||v.selections.some((s:any)=>!s||typeof s.item_id!=='string'||!s.item_id||!Number.isSafeInteger(s.quantity)||s.quantity<1)
    ||new Set(v.selections.map((s:any)=>s.item_id)).size!==v.selections.length)throw new ProtectionError('Please select valid items and quantities.');
  let exception:string|undefined;
  if(v.camera_exception_reason!==undefined&&v.camera_exception_reason!==null&&v.camera_exception_reason!==''){
    if(typeof v.camera_exception_reason!=='string'||v.camera_exception_reason.trim().length<10||v.camera_exception_reason.length>2000)throw new ProtectionError('Please explain why you cannot use the camera in 10 to 2,000 characters.');
    if(issue!=='damaged')throw new ProtectionError('A camera exception is only used for a damage request.');
    exception=v.camera_exception_reason.trim();
  }
  return {submission_id:validateIdempotency(v.submission_id),received_package:received,issue_code:issue as CustomerIssueCode,selections:v.selections.map((s:any)=>({item_id:s.item_id,quantity:s.quantity})).sort((a:CustomerSelection,b:CustomerSelection)=>a.item_id.localeCompare(b.item_id)),description:description(v.description),evidence_ids:evidenceIds(v.evidence_ids).sort(),location:validateCustomerLocation(v.location),...(exception?{camera_exception_reason:exception}:{})};
}
function assertIdentity(order:ProtectionOrder,identity:ProtectionCustomerIdentity){if(order.customer_email.toLowerCase()!==identity.email.toLowerCase()||order.id!==identity.orderId)throw new ProtectionError('This access link is no longer valid.',401);}
function assertEligible(order:ProtectionOrder){try{assertOrderEligible(order);}catch{throw new ProtectionError('A new request is not available for this order because its eligibility could not be confirmed. You can still view existing requests.');}}
export function evidenceView(row:any):CustomerEvidence{
  const camera=row.source==='camera'&&row.capture_id&&CAPTURE_CATEGORIES.includes(row.capture_category)&&row.capture_requested_at&&row.capture_received_at;
  return{id:row.id,kind:row.kind,original_name:row.original_name,size_bytes:Number(row.size_bytes),url:`/api/protection/evidence/${row.id}`,source:camera?'camera':'upload',
    ...(camera?{capture:{category:row.capture_category,requested_at:iso(row.capture_requested_at),received_at:iso(row.capture_received_at)}}:{})};
}
export async function createCustomerCaptureSession(identity:ProtectionCustomerIdentity,input:unknown):Promise<CustomerCaptureSession>{
  const category=record(input).category;
  if(!CAPTURE_CATEGORIES.includes(category))throw new ProtectionError('Choose a valid photo category.');
  return transaction(async client=>{
    const order=await lockedCurrentOrder(client,identity.orderId);assertIdentity(order,identity);
    const pending=await client.query(`SELECT count(*)::int AS n FROM support_protection_capture_sessions WHERE protection_order_id=$1 AND session_hash=$2 AND upload_id IS NULL AND expires_at>clock_timestamp()`,[identity.orderId,identity.sessionHash]);
    if(pending.rows[0].n>=24)throw new ProtectionError('Please use an existing camera session or wait a few minutes before trying again.',429);
    const id=crypto.randomUUID();
    const r=await client.query(`INSERT INTO support_protection_capture_sessions(id,protection_order_id,session_hash,category,expires_at) VALUES($1,$2,$3,$4,clock_timestamp()+interval '5 minutes') RETURNING expires_at`,[id,identity.orderId,identity.sessionHash,category]);
    return{id,category,expires_at:iso(r.rows[0].expires_at)};
  });
}
function usedQuantities(order:ProtectionOrder,claims:Record<string,any>[]):Record<string,number>{
  const used:Record<string,number>={};
  for(const claim of claims)if(['approved','closed'].includes(claim.status)){
    const selections:Array<CustomerSelection>=claim.selections_json||claim.item_ids.map((id:string)=>({item_id:id,quantity:order.items.find(i=>i.id===id)?.quantity||0}));
    for(const s of selections)used[s.item_id]=(used[s.item_id]||0)+s.quantity;
  }
  return used;
}

/** Explicit public projection: never expose internal notes, assignees, or payout references. */
export async function getCustomerClaim(orderId:string,publicNo:string):Promise<CustomerClaim|null>{
  const result=await query(`SELECT c.*,o.public_no AS protection_no FROM support_protection_claims c JOIN support_protection_orders o ON o.id=c.protection_order_id WHERE c.protection_order_id=$1 AND c.public_no=$2`,[orderId,publicNo]);
  const row=result.rows[0];if(!row)return null;
  const [files,messages]=await Promise.all([query('SELECT * FROM support_protection_evidence WHERE claim_id=$1 ORDER BY created_at,id',[row.id]),query('SELECT id,description,created_at FROM support_protection_customer_messages WHERE claim_id=$1 ORDER BY id',[row.id])]);
  return {public_no:row.public_no,protection_no:row.protection_no,reason:row.reason,issue_code:row.issue_code||null,received_package:row.received_package??null,
    description:row.source==='customer'?row.description:'This request was registered by the store.',status:row.status,requested_amount_cents:Number(row.requested_amount_cents),approved_amount_cents:row.approved_amount_cents===null?null:Number(row.approved_amount_cents),currency:row.currency,
    selections:row.selections_json||[],created_at:iso(row.created_at),updated_at:iso(row.updated_at),customer_message:row.customer_message||null,
    evidence:files.rows.filter(f=>!f.message_id).map(evidenceView),location:row.location_json||null,camera_exception_reason:row.camera_exception_reason||null,
    messages:messages.rows.map(m=>({id:String(m.id),description:m.description,created_at:iso(m.created_at),evidence:files.rows.filter(f=>String(f.message_id)===String(m.id)).map(evidenceView)}))};
}
export async function getCustomerClaimForAdmin(id:string):Promise<CustomerClaim|undefined>{
  const r=await query(`SELECT c.protection_order_id,c.public_no,c.source,
    EXISTS(SELECT 1 FROM support_protection_customer_messages m WHERE m.claim_id=c.id)
      OR EXISTS(SELECT 1 FROM support_protection_evidence e WHERE e.claim_id=c.id) AS has_customer_material
    FROM support_protection_claims c WHERE c.id=$1`,[id]);
  const row=r.rows[0];
  return row&&(row.source==='customer'||row.has_customer_material)?(await getCustomerClaim(String(row.protection_order_id),row.public_no))||undefined:undefined;
}
export async function getCustomerOrder(identity:ProtectionCustomerIdentity):Promise<CustomerOrderResponse>{
  const detail=await getProtectionOrder(identity.orderId);if(!detail)throw new ProtectionError('Protection order not found.',404);
  const o=detail.order;assertIdentity(o,identity);
  const balances=await balanceState({query} as Pick<PoolClient,'query'>,o);
  const used=usedQuantities(o,balances.rows);
  let canSubmit=true;try{assertEligible(o);}catch{canSubmit=false;}
  const address=record(o.shipping_address),str=(...values:unknown[])=>text(values.find(v=>typeof v==='string'&&v.trim()));
  const items=o.items.filter(i=>!i.is_protection).map(i=>{
    const active=balances.rows.some(c=>ACTIVE_CLAIM_STATUSES.includes(c.status)&&c.item_ids.includes(i.id));
    const available=i.amount_cents===null||balances.orderBalance===null?null:Math.max(0,Math.min(balances.orderBalance,i.amount_cents-(balances.approved[i.id]||0)));
    return{id:i.id,title:i.title,image_url:i.image_url,quantity:i.quantity,amount_cents:i.amount_cents,available_quantity:active||available===null||available===0?0:Math.max(0,i.quantity-(used[i.id]||0)),available_amount_cents:available,has_active_claim:active,request_windows:evaluateProtectionCoverage(o,{itemIds:[i.id]}).windows};
  });
  const shipments=(Array.isArray(o.logistics)?o.logistics:[]).map(record).filter(p=>!['cancelled','canceled'].includes(text(p.status))).map(p=>{
    const lines=Array.isArray(p.line_items)?p.line_items:[];
    const tracking=Array.isArray(p.tracking_items)?p.tracking_items.map(record):[];
    const numbers=[p.tracking_number,...tracking.map(t=>t.tracking_number)].filter(v=>typeof v==='string'&&v.trim()).map((v:string)=>v.trim());
    return{id:text(p.id),tracking_numbers:Array.from(new Set<string>(numbers)),carrier:str(p.tracking_company,...tracking.map(t=>t.tracking_company)),status:text(p.status),item_quantities:lines.map((l:any)=>({item_id:text(l.id||l.line_item_id),quantity:Number(l.ship_quantity??l.quantity)||0})).filter((l:CustomerSelection)=>items.some(i=>i.id===l.item_id)&&Number.isSafeInteger(l.quantity)&&l.quantity>0)};
  });
  const claims=(await Promise.all(detail.claims.map(c=>getCustomerClaim(o.id,c.public_no)))).filter((c):c is CustomerClaim=>c!==null);
  const hasAvailable=items.some(i=>i.available_quantity>0);
  const coverage=evaluateProtectionCoverage(o),hasOpenWindow=items.some(i=>i.available_quantity>0&&i.request_windows.some(window=>window.status==='open'));
  return{ok:true,order:{protection_no:o.public_no,order_number:o.order_number,store_name:o.store_name,currency:o.currency,purchased_at:o.paid_at,customer_name:o.customer_name,protection_fee_cents:o.protection_fee_cents,remaining_amount_cents:balances.orderBalance,
    shipping_address:{address1:str(address.address1,address.address),address2:str(address.address2),city:str(address.city),province:str(address.province,address.province_code),postal_code:str(address.zip,address.zip_code,address.postal_code),country:str(address.country,address.country_code)},items,shipments},
    claims,coverage,eligibility:{can_submit:canSubmit&&hasAvailable&&hasOpenWindow,reason_code:!canSubmit?'manual_review':!hasAvailable?'no_available_items':!hasOpenWindow?'request_window':null,message:!canSubmit?'A new request is not available because this order’s eligibility could not be confirmed. You can still view existing requests.':!hasAvailable?'No items are currently available for a new request. You can view or add information to an existing request below.':!hasOpenWindow?'No request window is currently open. Select an issue to check its dates.':null},limits:EVIDENCE_LIMITS};
}
async function lockEvidence(client:PoolClient,identity:ProtectionCustomerIdentity,ids:string[]){
  if(!ids.length)return [];
  const rows=await client.query(`SELECT * FROM support_protection_evidence WHERE id=ANY($1::uuid[]) FOR UPDATE`,[ids]);
  if(rows.rows.length!==ids.length||rows.rows.some(f=>String(f.protection_order_id)!==identity.orderId||f.session_hash!==identity.sessionHash||f.claim_id))throw new ProtectionError('An evidence file is unavailable. Please upload it again.');
  if(rows.rows.reduce((sum,f)=>sum+Number(f.size_bytes),0)>EVIDENCE_LIMITS.max_total_bytes)throw new ProtectionError('Evidence files must total no more than 100 MB.');
  return rows.rows;
}
function assertDamageEvidence(files:Record<string,any>[],initial:boolean,exception?:string|null){
  if(files.some(file=>file.kind!=='image'||evidenceView(file).source!=='camera'))throw new ProtectionError('Damage requests accept photos taken through the camera flow only. Please remove gallery uploads.');
  if(initial&&!exception&&!files.some(file=>file.capture_category==='damaged_item'))throw new ProtectionError('Take at least one photo of the damaged item, or explain why you cannot use the camera for manual review.');
}
export async function createCustomerClaim(identity:ProtectionCustomerIdentity,input:unknown):Promise<CustomerClaim>{
  const body=validateCustomerClaim(input),fingerprint=hash(body);
  const publicNo=await transaction(async client=>{
    const order=await lockedCurrentOrder(client,identity.orderId);assertIdentity(order,identity);
    const duplicate=await client.query('SELECT public_no,submission_hash FROM support_protection_claims WHERE protection_order_id=$1 AND submission_id=$2',[identity.orderId,body.submission_id]);
    if(duplicate.rows[0]){if(duplicate.rows[0].submission_hash!==fingerprint)throw new ProtectionError('This request was already submitted with different details.',409);return duplicate.rows[0].public_no;}
    assertEligible(order);const balances=await balanceState(client,order),ids=body.selections.map(s=>s.item_id),used=usedQuantities(order,balances.rows);
    const policy=assertProtectionRequestWindow(order,issueReasons[body.issue_code],ids);
    try{assertNoOverlap(balances.rows,ids);}catch{throw new ProtectionError('An existing request for a selected item is still being reviewed. Please open that request to add information.',409);}
    let amount=0;
    for(const selection of body.selections){
      const item=order.items.find(i=>i.id===selection.item_id&&!i.is_protection);
      if(!item||selection.quantity>item.quantity-(used[item.id]||0))throw new ProtectionError('The selected item quantity exceeds the remaining eligible quantity.');
      if(item.amount_cents===null)throw new ProtectionError('The item amount could not be verified. A new request is not available for this item.');
      amount+=Math.min(Math.floor(item.amount_cents*selection.quantity/item.quantity),Math.max(0,item.amount_cents-(balances.approved[item.id]||0)));
    }
    amount=balances.orderBalance===null?0:Math.min(amount,balances.orderBalance);
    try{claimAllocation(order.items,ids,amount,balances.approved,balances.orderBalance,body.selections);}catch{throw new ProtectionError('The selected items have no verified refundable balance. A new request cannot be submitted for these items.');}
    const files=await lockEvidence(client,identity,body.evidence_ids);
    if(body.issue_code==='damaged')assertDamageEvidence(files,true,body.camera_exception_reason);
    const r=await client.query(`INSERT INTO support_protection_claims(protection_order_id,reason,description,requested_amount_cents,currency,item_ids,source,selections_json,received_package,issue_code,location_json,submission_id,submission_hash,camera_exception_reason)
      VALUES($1,$2,$3,$4,$5,$6,'customer',$7,$8,$9,$10,$11,$12,$13) RETURNING id,public_no`,[order.id,issueReasons[body.issue_code],body.description,amount,order.currency,JSON.stringify(ids),JSON.stringify(body.selections),body.received_package,body.issue_code,body.location?JSON.stringify(body.location):null,body.submission_id,fingerprint,body.camera_exception_reason||null]);
    const claim=r.rows[0];
    await client.query('UPDATE support_protection_claims SET policy_snapshot_json=$2 WHERE id=$1',[claim.id,JSON.stringify(policy)]);
    if(body.evidence_ids.length)await client.query('UPDATE support_protection_evidence SET claim_id=$1 WHERE id=ANY($2::uuid[])',[claim.id,body.evidence_ids]);
    await client.query(`INSERT INTO support_protection_claim_events(claim_id,actor_id,actor_name,actor_type,action,note,detail_json) VALUES($1,NULL,'Customer','customer','customer_submitted',$2,$3)`,[claim.id,body.description,JSON.stringify({source:'customer',issue_code:body.issue_code,selections:body.selections,camera_exception_reason:body.camera_exception_reason||null})]);
    return claim.public_no;
  });
  return (await getCustomerClaim(identity.orderId,publicNo))!;
}
export async function addCustomerClaimMessage(identity:ProtectionCustomerIdentity,publicNo:string,input:unknown):Promise<CustomerClaim>{
  const v=record(input),body={submission_id:validateIdempotency(v.submission_id),description:description(v.description),evidence_ids:evidenceIds(v.evidence_ids).sort()},fingerprint=hash(body);
  await transaction(async client=>{
    const order=await lockedCurrentOrder(client,identity.orderId);assertIdentity(order,identity);
    const r=await client.query('SELECT id,status,reason,issue_code FROM support_protection_claims WHERE protection_order_id=$1 AND public_no=$2 FOR UPDATE',[identity.orderId,publicNo]);
    if(!r.rows[0])throw new ProtectionError('Request not found.',404);const claim=r.rows[0];
    const duplicate=await client.query('SELECT submission_hash FROM support_protection_customer_messages WHERE claim_id=$1 AND submission_id=$2',[claim.id,body.submission_id]);
    if(duplicate.rows[0]){if(duplicate.rows[0].submission_hash!==fingerprint)throw new ProtectionError('This information was already submitted with different details.',409);return;}
    if(!['submitted','reviewing','needs_info'].includes(claim.status))throw new ProtectionError('This request no longer accepts additional information.',409);
    const count=await client.query('SELECT count(*)::int AS n FROM support_protection_customer_messages WHERE claim_id=$1',[claim.id]);
    if(count.rows[0].n>=20)throw new ProtectionError('This request has reached its limit for additional messages. You can still view its details and status.',429);
    const files=await lockEvidence(client,identity,body.evidence_ids);
    if(claim.reason==='damaged'||claim.issue_code==='damaged')assertDamageEvidence(files,false);
    const message=await client.query('INSERT INTO support_protection_customer_messages(claim_id,submission_id,submission_hash,description) VALUES($1,$2,$3,$4) RETURNING id',[claim.id,body.submission_id,fingerprint,body.description]);
    if(body.evidence_ids.length)await client.query('UPDATE support_protection_evidence SET claim_id=$1,message_id=$2 WHERE id=ANY($3::uuid[])',[claim.id,message.rows[0].id,body.evidence_ids]);
    await client.query(`UPDATE support_protection_claims SET status=CASE WHEN status='needs_info' THEN 'reviewing' ELSE status END,revision=revision+1,updated_at=now() WHERE id=$1`,[claim.id]);
    await client.query(`INSERT INTO support_protection_claim_events(claim_id,actor_id,actor_name,actor_type,action,note,detail_json) VALUES($1,NULL,'Customer','customer','customer_message',$2,$3)`,[claim.id,body.description,JSON.stringify({message_id:String(message.rows[0].id),before:{status:claim.status},after:{status:claim.status==='needs_info'?'reviewing':claim.status}})]);
  });
  return (await getCustomerClaim(identity.orderId,publicNo))!;
}
