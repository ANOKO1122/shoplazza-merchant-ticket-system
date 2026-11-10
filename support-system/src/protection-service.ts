import type { PoolClient } from 'pg';
import { getClient, query } from './pg';
import { ACTIVE_CLAIM_STATUSES, CLAIM_REASONS, CLAIM_STATUSES, ProtectionError, claimAllocation, normalizeProtectionSnapshot, record, text, validateClaimTransition } from './protection-domain';
import type { ClaimDetail, ClaimStatus, ProtectionClaim, ProtectionList, ProtectionOrder, ProtectionStats } from './protection-types';
import { evaluateProtectionCoverage } from './protection-policy';
import { enqueueProtectionLifecycleNotifications } from './protection-lifecycle-notification';

export interface ProtectionActor { agentId: number; name: string; role: string; }
export interface ProtectionFilters { q?: string; store?: string; from?: string; to?: string; status?: string; reason?: string; page?: number; page_size?: number; }
type Db = Pick<PoolClient, 'query'>;
const nullableNumber = (v: unknown): number | null => v === null || v === undefined ? null : Number(v);
const iso = (v: unknown): string | null => v ? new Date(v as string).toISOString() : null;
const orderColumns = `o.*, (SELECT count(*)::int FROM support_protection_claims c WHERE c.protection_order_id=o.id) AS claim_count`;
const claimColumns = `c.*,o.public_no AS protection_public_no,o.store_subdomain,o.store_name,o.order_number,o.customer_email,o.customer_name,a.name AS assignee_name`;
const claimJoins = `FROM support_protection_claims c JOIN support_protection_orders o ON o.id=c.protection_order_id LEFT JOIN support_agents a ON a.id=c.assignee_id`;

function mapOrder(row: Record<string, any>): ProtectionOrder {
  return { id:String(row.id),public_no:row.public_no,store_subdomain:row.store_subdomain,store_name:row.store_name,
    order_id:row.order_id,order_number:row.order_number,customer_email:row.customer_email,customer_name:row.customer_name,
    currency:row.currency,order_amount_cents:nullableNumber(row.order_amount_cents),protection_fee_cents:nullableNumber(row.protection_fee_cents),
    protected_value_cents:nullableNumber(row.protected_value_cents),refund_amount_cents:nullableNumber(row.refund_amount_cents),
    payment_status:row.payment_status,order_status:row.order_status,fulfillment_status:row.fulfillment_status,refund_status:row.refund_status,
    paid_at:iso(row.paid_at),synced_at:iso(row.synced_at)!,items:row.items_json,logistics:row.logistics_json,
    shipping_address:row.shipping_address_json,claim_count:Number(row.claim_count||0),service_fulfillment_status:row.service_fulfillment_status,timeline:row.timeline_json||{} };
}
function mapClaim(row: Record<string, any>): ProtectionClaim {
  return { id:String(row.id),public_no:row.public_no,protection_order_id:String(row.protection_order_id),protection_public_no:row.protection_public_no,
    store_subdomain:row.store_subdomain,store_name:row.store_name,order_number:row.order_number,customer_email:row.customer_email,customer_name:row.customer_name,
    reason:row.reason,description:row.description,status:row.status,requested_amount_cents:Number(row.requested_amount_cents),
    approved_amount_cents:nullableNumber(row.approved_amount_cents),currency:row.currency,item_ids:row.item_ids,
    assignee_id:nullableNumber(row.assignee_id),assignee_name:row.assignee_name||null,revision:row.revision,
    created_at:iso(row.created_at)!,updated_at:iso(row.updated_at)!,resolution_note:row.resolution_note,external_reference:row.external_reference,customer_message:row.customer_message||null };
}
function validId(value: unknown): string {
  const id=text(value);
  if (!/^[1-9]\d{0,18}$/.test(id) || BigInt(id)>9223372036854775807n) throw new ProtectionError('无效的记录编号');
  return id;
}
function pagination(filters: ProtectionFilters) {
  const page=Number(filters.page??1),size=Number(filters.page_size??30);
  if (!Number.isSafeInteger(page)||page<1||page>1000000||!Number.isSafeInteger(size)||size<1||size>100) throw new ProtectionError('分页参数无效');
  return {page,page_size:size};
}
function conditions(filters: ProtectionFilters, kind: 'order'|'claim') {
  const parts:string[]=[];const args:unknown[]=[];
  const add=(sql:string,value:unknown)=>{args.push(value);parts.push(sql.replace('?',`$${args.length}`));};
  if (filters.store) { if (filters.store.length>255) throw new ProtectionError('店铺参数无效'); add('o.store_subdomain=?',filters.store); }
  if (filters.q) {
    if(filters.q.length>200)throw new ProtectionError('搜索内容过长');
    const fields=kind==='order'?['o.order_number','o.public_no','o.customer_email','o.customer_name']:['c.public_no','o.public_no','o.order_number','o.customer_email','o.customer_name'];
    args.push(`%${filters.q.replace(/[\\%_]/g,'\\$&')}%`); parts.push(`(${fields.map(f=>`${f} ILIKE $${args.length}`).join(' OR ')})`);
  }
  const dateField=kind==='order'?'o.paid_at':'c.created_at';
  for(const key of ['from','to'] as const) if(filters[key]) {
    const date=filters[key]!;
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date) throw new ProtectionError('日期格式无效');
    add(`${dateField} ${key==='from'?'>=':'<'} ?::date${key==='to'?" + interval '1 day'":''}`,date);
  }
  if(filters.from&&filters.to&&filters.from>filters.to)throw new ProtectionError('开始日期不能晚于结束日期');
  if(kind==='claim'&&filters.status){if(!CLAIM_STATUSES.includes(filters.status as ClaimStatus))throw new ProtectionError('申请状态无效');add('c.status=?',filters.status);}
  if(kind==='claim'&&filters.reason){if(!(CLAIM_REASONS as readonly string[]).includes(filters.reason))throw new ProtectionError('问题类型无效');add('c.reason=?',filters.reason);}
  return {where:parts.length?`WHERE ${parts.join(' AND ')}`:'',args};
}

export async function listProtectionOrders(filters:ProtectionFilters={}):Promise<ProtectionList<ProtectionOrder>> {
  const {page,page_size}=pagination(filters);const {where,args}=conditions(filters,'order');
  const [total,rows]=await Promise.all([
    query(`SELECT count(*)::int AS total FROM support_protection_orders o ${where}`,args),
    query(`SELECT ${orderColumns} FROM support_protection_orders o ${where} ORDER BY o.paid_at DESC NULLS LAST,o.id DESC LIMIT $${args.length+1} OFFSET $${args.length+2}`,[...args,page_size,(page-1)*page_size]),
  ]);
  return {ok:true,items:rows.rows.map(mapOrder),total:total.rows[0].total,page,page_size};
}
export async function listProtectionClaims(filters:ProtectionFilters={}):Promise<ProtectionList<ProtectionClaim>> {
  const {page,page_size}=pagination(filters);const {where,args}=conditions(filters,'claim');
  const [total,rows]=await Promise.all([
    query(`SELECT count(*)::int AS total ${claimJoins} ${where}`,args),
    query(`SELECT ${claimColumns} ${claimJoins} ${where} ORDER BY c.created_at DESC,c.id DESC LIMIT $${args.length+1} OFFSET $${args.length+2}`,[...args,page_size,(page-1)*page_size]),
  ]);
  return {ok:true,items:rows.rows.map(mapClaim),total:total.rows[0].total,page,page_size};
}
export async function getProtectionOrder(id:unknown):Promise<{order:ProtectionOrder;claims:ProtectionClaim[]}|null> {
  const orderId=validId(id);
  const rows=await query(`SELECT ${orderColumns} FROM support_protection_orders o WHERE o.id=$1`,[orderId]);
  if(!rows.rows[0])return null;
  const claims=await query(`SELECT ${claimColumns} ${claimJoins} WHERE o.id=$1 ORDER BY c.id DESC`,[orderId]);
  return {order:mapOrder(rows.rows[0]),claims:claims.rows.map(mapClaim)};
}
export async function getProtectionClaim(id:unknown):Promise<ClaimDetail|null> {
  const claimId=validId(id);
  const rows=await query(`SELECT ${claimColumns} ${claimJoins} WHERE c.id=$1`,[claimId]);
  if(!rows.rows[0])return null;
  const [order,events]=await Promise.all([
    query(`SELECT ${orderColumns} FROM support_protection_orders o WHERE o.id=$1`,[rows.rows[0].protection_order_id]),
    query(`SELECT id,actor_name,action,note,created_at,detail_json FROM support_protection_claim_events WHERE claim_id=$1 ORDER BY id`,[claimId]),
  ]);
  return {claim:mapClaim(rows.rows[0]),order:mapOrder(order.rows[0]),events:events.rows.map(e=>({id:String(e.id),actor_name:e.actor_name,action:e.action,note:e.note,created_at:iso(e.created_at)!,
    detail:{from_status:e.detail_json?.before?.status,to_status:e.detail_json?.after?.status,approved_amount_cents:e.detail_json?.after?.approved_amount_cents,external_reference:e.detail_json?.after?.external_reference}}))};
}

export async function transaction<T>(fn:(client:PoolClient)=>Promise<T>):Promise<T>{
  const client=await getClient();
  try{await client.query('BEGIN');const result=await fn(client);await client.query('COMMIT');return result;}
  catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
  finally{client.release();}
}
async function readClaim(client:Db,id:string):Promise<ProtectionClaim>{
  return mapClaim((await client.query(`SELECT ${claimColumns} ${claimJoins} WHERE c.id=$1`,[id])).rows[0]);
}
export async function lockedCurrentOrder(client:Db,id:string):Promise<ProtectionOrder>{
  const orders=await client.query('SELECT *,source_updated_at::text AS source_time FROM support_protection_orders WHERE id=$1 FOR UPDATE',[id]);
  if(!orders.rows[0])throw new ProtectionError('保障订单不存在',404);
  const order=orders.rows[0];
  // Re-read the local webhook snapshot under the review transaction. A pending
  // index batch must not allow approval against a superseded refund/payment view.
  const latest=await client.query(`SELECT s.*,s.updated_at::text AS cursor_time,p.product_ids,
    (s.updated_at>COALESCE($3::timestamptz,'1970-01-01'::timestamptz) OR s.id IS DISTINCT FROM $4::bigint) AS newer
    FROM support_order_snapshots s JOIN support_protection_stores p ON p.store_subdomain=s.store_subdomain
    WHERE s.store_subdomain=$1 AND s.order_id=$2 ORDER BY s.updated_at DESC,s.id DESC LIMIT 1`,
    [order.store_subdomain,order.order_id,order.source_time,order.source_snapshot_id]);
  if(latest.rows[0]?.newer){
    await persistProtectionSnapshot(client,latest.rows[0]);
    return mapOrder((await client.query('SELECT * FROM support_protection_orders WHERE id=$1',[id])).rows[0]);
  }
  return mapOrder(order);
}
export async function balanceState(client:Db,order:ProtectionOrder,excludeId?:string){
  const rows=await client.query(`SELECT id,item_ids,status,approved_amount_cents,allocation_json,selections_json FROM support_protection_claims WHERE protection_order_id=$1${excludeId?' AND id<>$2':''}`,[order.id,...(excludeId?[excludeId]:[])]);
  const approved:Record<string,number>={};let used=0;
  for(const row of rows.rows)if(row.approved_amount_cents!==null&&['approved','closed'].includes(row.status)){
    used+=Number(row.approved_amount_cents);
    for(const [id,value]of Object.entries(record(row.allocation_json)))approved[id]=(approved[id]||0)+Number(value);
  }
  const orderBalance=order.order_amount_cents===null||order.refund_amount_cents===null||order.protection_fee_cents===null?null:
    Math.max(0,order.order_amount_cents-order.refund_amount_cents-order.protection_fee_cents-used);
  return {rows:rows.rows,approved,orderBalance};
}
export function assertOrderEligible(order:ProtectionOrder){
  if(!['paid','partially_refunded','refund_failed'].includes(order.payment_status)||order.order_status==='cancelled'||order.timeline?.cancelled
    ||['removed','refunded'].includes(order.service_fulfillment_status)||order.protection_fee_cents===0)throw new ProtectionError('此订单当前没有可审核的有效保障，请核对支付、取消及退款状态');
  // Status webhooks update refund totals without refreshing merchandise rows.
  // Until verified per-line refund amounts exist, a total balance cannot prove
  // that the selected item still has value (it could belong to another item).
  if((order.refund_amount_cents??0)>0||['partially_refunded','refunded','refunding','refund_failed'].includes(order.payment_status)
    ||['partially_refunded','refunded','refunding','refund_failed'].includes(order.refund_status)
    ||order.items.some(item=>Number((item as any).refunded_quantity)>0))throw new ProtectionError('订单已有退款，逐商品退款明细尚未核验，暂不能新建或通过申请');
}
export function assertNoOverlap(rows:Record<string,any>[],ids:string[]){
  if(rows.some(row=>ACTIVE_CLAIM_STATUSES.includes(row.status)&&row.item_ids.some((id:string)=>ids.includes(id))))throw new ProtectionError('所选商品已有处理中的申请，请先处理原申请',409);
}
export function assertProtectionRequestWindow(order:ProtectionOrder,reason:string,itemIds:string[],at=Date.now()) {
  const coverage=evaluateProtectionCoverage(order,{now:at,itemIds});
  const window=coverage.windows.find(window=>window.reason===reason);
  if(!window)throw new ProtectionError('This issue is outside shipping protection. A request for this issue cannot be submitted through this portal.');
  if(window.status!=='open')throw new ProtectionError(window.message);
  return{policy_version:coverage.policy_version,evaluated_at:coverage.evaluated_at,window,item_ids:itemIds};
}
async function audit(client:Db,claimId:string,actor:ProtectionActor,action:string,note:string,detail:Record<string,unknown>){
  await client.query(`INSERT INTO support_protection_claim_events(claim_id,actor_id,actor_name,action,note,detail_json) VALUES($1,$2,$3,$4,$5,$6)`,[claimId,actor.agentId,actor.name,action,note,JSON.stringify(detail)]);
}

export async function createProtectionClaim(input:unknown,actor:ProtectionActor):Promise<ProtectionClaim>{
  const body=record(input);const orderId=validId(body.protection_order_id);
  if(!(CLAIM_REASONS as readonly unknown[]).includes(body.reason))throw new ProtectionError('请选择有效的问题类型');
  const description=text(body.description);if(!description||description.length>10000)throw new ProtectionError('请填写不超过10000字的问题说明');
  return transaction(async client=>{
    const order=await lockedCurrentOrder(client,orderId);assertOrderEligible(order);
    const policy=assertProtectionRequestWindow(order,body.reason,Array.isArray(body.item_ids)?body.item_ids:[]);
    const balances=await balanceState(client,order);
    if(Array.isArray(body.item_ids)&&body.item_ids.every((id:unknown)=>typeof id==='string'))assertNoOverlap(balances.rows,body.item_ids);
    claimAllocation(order.items,body.item_ids,body.requested_amount_cents,balances.approved,balances.orderBalance);
    const result=await client.query(`INSERT INTO support_protection_claims(protection_order_id,reason,description,requested_amount_cents,currency,item_ids,policy_snapshot_json)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,[orderId,body.reason,description,body.requested_amount_cents,order.currency,JSON.stringify(body.item_ids),JSON.stringify(policy)]);
    const claimId=String(result.rows[0].id);
    await audit(client,claimId,actor,'created',description,{source:'admin',item_ids:body.item_ids,requested_amount_cents:body.requested_amount_cents});
    return readClaim(client,claimId);
  });
}

export async function updateProtectionClaim(id:unknown,input:unknown,actor:ProtectionActor):Promise<ProtectionClaim>{
  const claimId=validId(id),body=record(input);
  if(!Number.isSafeInteger(body.revision)||body.revision<1)throw new ProtectionError('缺少有效的申请版本');
  const allowed=['revision','status','approved_amount_cents','note','assignee_id','external_reference','customer_message'];
  if(Object.keys(body).some(key=>!allowed.includes(key)))throw new ProtectionError('包含不支持的审核字段');
  if(Object.keys(body).every(key=>key==='revision'))throw new ProtectionError('没有可保存的修改');
  if(body.note!==undefined&&(typeof body.note!=='string'||body.note.length>10000))throw new ProtectionError('处理备注格式无效');
  if(body.external_reference!==undefined&&(typeof body.external_reference!=='string'||body.external_reference.length>500))throw new ProtectionError('外部处理记录格式无效');
  if(body.customer_message!==undefined&&(typeof body.customer_message!=='string'||body.customer_message.length>5000))throw new ProtectionError('顾客可见说明格式无效');
  return transaction(async client=>{
    // Lock the parent first in every write path, including different claims of one order.
    const parent=await client.query('SELECT protection_order_id FROM support_protection_claims WHERE id=$1',[claimId]);
    if(!parent.rows[0])throw new ProtectionError('申请不存在',404);
    const order=await lockedCurrentOrder(client,String(parent.rows[0].protection_order_id));
    const current=(await client.query('SELECT * FROM support_protection_claims WHERE id=$1 FOR UPDATE',[claimId])).rows[0];
    if(current.revision!==body.revision)throw new ProtectionError('申请已被其他操作更新，请刷新后重新确认',409);
    const status:ClaimStatus=body.status??current.status;
    const note=text(body.note),external=body.external_reference===undefined?current.external_reference:text(body.external_reference)||null;
    validateClaimTransition(current.status,status,note,external);
    const assignee=body.assignee_id===undefined?current.assignee_id:body.assignee_id;
    if(assignee!==null){
      if(!Number.isSafeInteger(Number(assignee))||Number(assignee)<=0)throw new ProtectionError('负责人无效');
      const agents=await client.query('SELECT id FROM support_agents WHERE id=$1 AND enabled=true',[assignee]);
      if(!agents.rows[0])throw new ProtectionError('负责人不存在或已停用');
    }
    let amount=current.approved_amount_cents===null?null:Number(current.approved_amount_cents),allocation=current.allocation_json;
    if(body.approved_amount_cents!==undefined&&status!=='approved')throw new ProtectionError('仅通过审核时可设置批准金额');
    if(current.status==='approved'&&body.approved_amount_cents!==undefined&&body.approved_amount_cents!==amount)throw new ProtectionError('已通过的金额不能直接改写',409);
    if(status==='approved'&&current.status!=='approved'){
      assertOrderEligible(order);
      const policy=record(current.policy_snapshot_json),window=record(policy.window);
      if(!['delayed','lost','damaged','stolen'].includes(current.reason))throw new ProtectionError('This legacy issue is outside the configured protection categories. Handle it through ordinary store support.');
      // New-request deadlines do not expire an already eligible review. Legacy
      // claims without recorded policy evidence must be verified at submission time.
      if(window.reason!==current.reason||window.status!=='open'||!Number.isFinite(Date.parse(policy.evaluated_at)))
        assertProtectionRequestWindow(order,current.reason,current.item_ids,new Date(current.created_at).getTime());
      if(order.currency!==current.currency)throw new ProtectionError('订单币种已变化，请核对后重新提交',409);
      amount=body.approved_amount_cents;
      if(!Number.isSafeInteger(amount)||amount!<=0||amount!>Number(current.requested_amount_cents))throw new ProtectionError('批准金额须大于零且不超过申请金额');
      const balances=await balanceState(client,order,claimId);
      assertNoOverlap(balances.rows,current.item_ids);
      allocation=claimAllocation(order.items,current.item_ids,amount!,balances.approved,balances.orderBalance,current.selections_json||undefined);
    }
    if(body.external_reference!==undefined&&current.status!=='approved'&&current.status!=='closed'&&status!=='approved')throw new ProtectionError('通过审核后才可记录外部处理凭证');
    const reasonNote=['approved','rejected','closed'].includes(status)&&status!==current.status?note||null:current.resolution_note;
    await client.query(`UPDATE support_protection_claims SET status=$2,approved_amount_cents=$3,allocation_json=$4,assignee_id=$5,
      resolution_note=$6,external_reference=$7,customer_message=$8,revision=revision+1,updated_at=now() WHERE id=$1`,[claimId,status,amount,JSON.stringify(allocation),assignee,reasonNote,external,body.customer_message===undefined?current.customer_message:text(body.customer_message)||null]);
    await audit(client,claimId,actor,status===current.status?'updated':'status_changed',note,{before:{status:current.status,assignee_id:current.assignee_id,revision:current.revision},after:{status,assignee_id:assignee,approved_amount_cents:amount,external_reference:external,customer_message:body.customer_message===undefined?current.customer_message:text(body.customer_message)||null,revision:current.revision+1}});
    return readClaim(client,claimId);
  });
}

export async function getProtectionStats(filters:ProtectionFilters):Promise<ProtectionStats>{
  const orders=conditions(filters,'order'),claims=conditions(filters,'claim');
  const [orderTotals,claimTotals,fees,amounts,dailyOrders,dailyClaims,storeOrders,storeClaims,sync]=await Promise.all([
    query(`SELECT count(*)::int AS total FROM support_protection_orders o ${orders.where}`,orders.args),
    query(`SELECT count(*)::int AS total,count(*) FILTER(WHERE c.status IN('submitted','reviewing','needs_info'))::int AS pending,
      count(*) FILTER(WHERE c.status='approved')::int AS approved,count(*) FILTER(WHERE c.status='rejected')::int AS rejected,
      count(*) FILTER(WHERE c.status='closed')::int AS closed ${claimJoins} ${claims.where}`,claims.args),
    query(`SELECT currency,
      CASE WHEN count(*) FILTER(WHERE protection_fee_cents IS NULL)=0 THEN sum(protection_fee_cents) END AS fees,
      CASE WHEN count(*) FILTER(WHERE protected_value_cents IS NULL)=0 THEN sum(protected_value_cents) END AS value,
      count(*) FILTER(WHERE protection_fee_cents IS NULL OR protected_value_cents IS NULL)::int AS unknown_orders
      FROM support_protection_orders o ${orders.where} GROUP BY currency`,orders.args),
    query(`SELECT c.currency,sum(c.requested_amount_cents) AS requested,sum(c.approved_amount_cents) AS approved ${claimJoins} ${claims.where} GROUP BY c.currency`,claims.args),
    query(`SELECT to_char(o.paid_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS date,count(*)::int AS count FROM support_protection_orders o ${orders.where} GROUP BY date ORDER BY date DESC LIMIT 366`,orders.args),
    query(`SELECT to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS date,count(*)::int AS count ${claimJoins} ${claims.where} GROUP BY date ORDER BY date DESC LIMIT 366`,claims.args),
    query(`SELECT o.store_subdomain,max(o.store_name) AS store_name,count(*)::int AS count FROM support_protection_orders o ${orders.where} GROUP BY o.store_subdomain`,orders.args),
    query(`SELECT o.store_subdomain,max(o.store_name) AS store_name,count(*)::int AS count,count(*) FILTER(WHERE c.status IN('submitted','reviewing','needs_info'))::int AS pending ${claimJoins} ${claims.where} GROUP BY o.store_subdomain`,claims.args),
    query('SELECT synced_at FROM support_protection_sync_state WHERE id=1'),
  ]);
  const currencies=new Map<string,ProtectionStats['currencies'][number]>();
  for(const row of fees.rows)currencies.set(row.currency,{currency:row.currency,protection_fee_cents:nullableNumber(row.fees),protected_value_cents:nullableNumber(row.value),unknown_orders:row.unknown_orders,requested_amount_cents:0,approved_amount_cents:0});
  for(const row of amounts.rows){const value=currencies.get(row.currency)||{currency:row.currency,protection_fee_cents:0,protected_value_cents:0,unknown_orders:0,requested_amount_cents:0,approved_amount_cents:0};value.requested_amount_cents=Number(row.requested||0);value.approved_amount_cents=Number(row.approved||0);currencies.set(row.currency,value);}
  const daily=new Map<string,ProtectionStats['daily'][number]>();
  for(const row of dailyOrders.rows)if(row.date)daily.set(row.date,{date:row.date,orders:row.count,claims:0});
  for(const row of dailyClaims.rows){const value=daily.get(row.date)||{date:row.date,orders:0,claims:0};value.claims=row.count;daily.set(row.date,value);}
  const stores=new Map<string,ProtectionStats['by_store'][number]>();
  for(const row of storeOrders.rows)stores.set(row.store_subdomain,{store_subdomain:row.store_subdomain,store_name:row.store_name,orders:row.count,claims:0,pending:0});
  for(const row of storeClaims.rows){const value=stores.get(row.store_subdomain)||{store_subdomain:row.store_subdomain,store_name:row.store_name,orders:0,claims:0,pending:0};value.claims=row.count;value.pending=row.pending;stores.set(row.store_subdomain,value);}
  const counts=claimTotals.rows[0];return {protected_orders:orderTotals.rows[0].total,claims:counts.total,pending_claims:counts.pending,approved_claims:counts.approved,rejected_claims:counts.rejected,closed_claims:counts.closed,
    currencies:[...currencies.values()].sort((a,b)=>a.currency.localeCompare(b.currency)),daily:[...daily.values()].sort((a,b)=>a.date.localeCompare(b.date)),by_store:[...stores.values()],synced_at:iso(sync.rows[0]?.synced_at)};
}

/** One durable bounded batch. A new configuration can reset this cursor to reindex older snapshots. */
export async function resetProtectionOrderSync():Promise<void>{await query(`UPDATE support_protection_sync_state SET cursor_updated_at='1970-01-01',cursor_id=0 WHERE id=1`);}
async function persistProtectionSnapshot(client:Db,snapshot:Record<string,any>):Promise<boolean>{
  const normalized=normalizeProtectionSnapshot(snapshot,Array.isArray(snapshot.product_ids)?snapshot.product_ids:[]);
  if(!normalized){
    const result=await client.query(`UPDATE support_protection_orders SET service_fulfillment_status='removed',payment_status=$3,order_status=$4,source_snapshot_id=$5,source_updated_at=$6,synced_at=now() WHERE store_subdomain=$1 AND order_id=$2
      AND (source_updated_at IS NULL OR source_updated_at<=$6::timestamptz)`,[snapshot.store_subdomain,snapshot.order_id,text(snapshot.payment_status),text(snapshot.order_status),snapshot.id,snapshot.cursor_time]);
    return !!result.rowCount;
  }
  const keys=['store_subdomain','store_name','order_id','order_number','customer_email','customer_name','currency','order_amount_cents','protection_fee_cents','protected_value_cents','refund_amount_cents','payment_status','order_status','fulfillment_status','refund_status','paid_at','items_json','logistics_json','shipping_address_json','service_fulfillment_status','source_snapshot_id','source_updated_at'];
  const values=[normalized.store_subdomain,normalized.store_name,normalized.order_id,normalized.order_number,normalized.customer_email,normalized.customer_name,normalized.currency,normalized.order_amount_cents,normalized.protection_fee_cents,normalized.protected_value_cents,normalized.refund_amount_cents,normalized.payment_status,normalized.order_status,normalized.fulfillment_status,normalized.refund_status,normalized.paid_at,JSON.stringify(normalized.items),JSON.stringify(normalized.logistics),JSON.stringify(normalized.shipping_address),normalized.service_fulfillment_status,snapshot.id,snapshot.cursor_time];
  const paidLike=['paid','partially_refunded','refunded','refund_failed','refunding'].includes(normalized.payment_status);
  keys.push('timeline_json');values.push(JSON.stringify(normalized.timeline));
  const result=await client.query(`INSERT INTO support_protection_orders(${keys.join(',')}) SELECT ${keys.map((_,i)=>`$${i+1}`).join(',')}
    WHERE $${keys.length+1}::boolean OR EXISTS(SELECT 1 FROM support_protection_orders WHERE store_subdomain=$1 AND order_id=$3)
    ON CONFLICT(store_subdomain,order_id) DO UPDATE SET ${keys.filter(k=>!['store_subdomain','order_id'].includes(k)).map(k=>`${k}=EXCLUDED.${k}`).join(',')},synced_at=now()
    WHERE support_protection_orders.source_updated_at IS NULL OR support_protection_orders.source_updated_at<=EXCLUDED.source_updated_at
    RETURNING *`,[...values,paidLike]);
  if(result.rows[0])await enqueueProtectionLifecycleNotifications(client,result.rows[0]);
  return !!result.rowCount;
}
export async function syncProtectionOrders(limit=200):Promise<{scanned:number;upserted:number;has_more:boolean}>{
  if(!Number.isSafeInteger(limit)||limit<1||limit>1000)throw new Error('Invalid protection sync batch size');
  return transaction(async client=>{
    const state=(await client.query('SELECT cursor_updated_at::text AS cursor_time,cursor_id FROM support_protection_sync_state WHERE id=1 FOR UPDATE')).rows[0];
    const dirty=await client.query(`SELECT store_subdomain,order_id FROM support_protection_sync_dirty
      ORDER BY touched_at,store_subdomain,order_id LIMIT $1 FOR UPDATE SKIP LOCKED`,[limit]);
    let upserted=0;
    for(const item of dirty.rows){
      const latest=await client.query(`SELECT s.*,s.updated_at::text AS cursor_time,p.product_ids FROM support_order_snapshots s
        JOIN support_protection_stores p ON p.store_subdomain=s.store_subdomain
        WHERE s.store_subdomain=$1 AND s.order_id=$2 ORDER BY s.updated_at DESC,s.id DESC LIMIT 1`,[item.store_subdomain,item.order_id]);
      if(latest.rows[0]&&await persistProtectionSnapshot(client,latest.rows[0]))upserted++;
      // A concurrent snapshot update waits on this row, then inserts/updates its
      // own dirty notification after our deletion commits. No notification is lost.
      await client.query('DELETE FROM support_protection_sync_dirty WHERE store_subdomain=$1 AND order_id=$2',[item.store_subdomain,item.order_id]);
    }
    const remaining=limit-dirty.rows.length;
    const result=await client.query(`SELECT latest.*,latest.updated_at::text AS cursor_time,p.product_ids FROM (
      SELECT DISTINCT ON(s.store_subdomain,s.order_id) s.* FROM support_order_snapshots s
      JOIN support_protection_stores configured ON configured.store_subdomain=s.store_subdomain
      WHERE (s.updated_at,s.id)>($1::timestamptz,$2::bigint)
      ORDER BY s.store_subdomain,s.order_id,s.updated_at DESC,s.id DESC
    ) latest JOIN support_protection_stores p ON p.store_subdomain=latest.store_subdomain
    ORDER BY latest.updated_at,latest.id LIMIT $3`,[state.cursor_time,state.cursor_id,remaining]);
    for(const snapshot of result.rows)if(await persistProtectionSnapshot(client,snapshot))upserted++;
    const last=result.rows[result.rows.length-1];
    if(last)await client.query('UPDATE support_protection_sync_state SET cursor_updated_at=$1,cursor_id=$2,synced_at=now() WHERE id=1',[last.cursor_time,last.id]);
    else await client.query('UPDATE support_protection_sync_state SET synced_at=now() WHERE id=1');
    return {scanned:dirty.rows.length+result.rows.length,upserted,has_more:dirty.rows.length+result.rows.length===limit};
  });
}
