import type { ClaimStatus, ProtectionItem, ProtectionOrder } from './protection-types';
import { extractProtectionTimeline } from './protection-policy';

export class ProtectionError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}
export const CLAIM_STATUSES: ClaimStatus[] = ['submitted', 'reviewing', 'needs_info', 'approved', 'rejected', 'closed'];
export const CLAIM_REASONS = ['lost', 'damaged', 'stolen', 'delayed', 'other'] as const;
export const ACTIVE_CLAIM_STATUSES = ['submitted', 'reviewing', 'needs_info', 'approved'];
export const record = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
export const text = (v: unknown): string => typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : '';

/** Decimal strings are converted without binary floating-point rounding. */
export function cents(value: unknown): number | null {
  const raw = text(value);
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) return null;
  const [whole, fraction = ''] = raw.split('.');
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(result) && result >= 0 ? result : null;
}
function sumKnown(values: Array<number | null>): number | null {
  if (values.some(v => v === null)) return null;
  const sum = values.reduce<number>((a, b) => a + b!, 0);
  return Number.isSafeInteger(sum) ? sum : null;
}
function twoDecimalCurrency(currency: string): boolean {
  if (!/^[A-Z]{3}$/.test(currency)) return false;
  try { return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits === 2; }
  catch { return false; }
}
function imageUrl(value: unknown): string | null {
  const raw = text(value);
  try { const url = new URL(raw.startsWith('//') ? `https:${raw}` : raw); return ['https:', 'http:'].includes(url.protocol) ? url.href : null; }
  catch { return null; }
}
function discountAmount(value: unknown): {amount:number|null;invalid:boolean} {
  if(value===null||value===undefined||value==='')return {amount:null,invalid:false};
  let parsed=value;
  if(typeof parsed==='string'){try{parsed=JSON.parse(parsed);}catch{return {amount:null,invalid:true};}}
  if(!Array.isArray(parsed))return {amount:null,invalid:true};
  const amounts=parsed.map(item=>cents(record(item).total_discount_amount));
  const amount=sumKnown(amounts);
  return {amount,invalid:amount===null};
}
function dateOrNull(value:unknown):string|null {
  const date=value?new Date(value as string):null;
  return date&&Number.isFinite(date.getTime())?date.toISOString():null;
}
function serviceState(lines:Record<string,any>[],fulfillments:unknown):string {
  const packages=Array.isArray(fulfillments)?fulfillments.map(record):[];
  const states=lines.map(line=>{
    const matches=packages.flatMap(parcel=>Array.isArray(parcel.line_items)?parcel.line_items
      .filter((item:unknown)=>text(record(item).id)===text(line.id))
      .map((item:unknown)=>({status:text(parcel.status),quantity:record(item).ship_quantity??record(item).quantity})):[]);
    if(matches.length){
      const quantity=Number.isSafeInteger(line.quantity)&&line.quantity>0?line.quantity:Infinity;
      const shipped=matches.filter(item=>['shipped','finished'].includes(item.status)).reduce((sum,item)=>sum+(Number.isSafeInteger(item.quantity)&&item.quantity>0?item.quantity:0),0);
      const finished=matches.filter(item=>item.status==='finished').reduce((sum,item)=>sum+(Number.isSafeInteger(item.quantity)&&item.quantity>0?item.quantity:0),0);
      return finished>=quantity?2:shipped>=quantity?1:0;
    }
    const status=text(line.fulfillment_status);
    return status==='finished'?2:['fulfilled','shipped'].includes(status)?1:0;
  });
  return states.every(state=>state===2)?'completed':states.every(state=>state>=1)?'fulfilled':states.some(state=>state>0)?'partial':'pending';
}

export type NormalizedProtectionOrder = Omit<ProtectionOrder, 'id' | 'public_no' | 'claim_count'>;

/** Snapshot rows are untrusted provider data. Missing amounts remain unknown. */
export function normalizeProtectionSnapshot(snapshot: Record<string, any>, productIds: string[]): NormalizedProtectionOrder | null {
  const raw = record(snapshot.raw_order_json);
  const source = Array.isArray(snapshot.items_json) ? snapshot.items_json : [];
  const own = new Set(productIds);
  if (!source.some((line: any) => own.has(text(line?.product_id)))) return null;
  const currency = text(snapshot.order_currency || raw.currency).toUpperCase();
  const allowMoney = twoDecimalCurrency(currency);
  const discounts=source.map((value:unknown)=>discountAmount(record(value).discount_applications));
  const orderDiscount=cents(raw.total_discount??raw.total_discounts);
  // total_price is gross in Shoplazza's order API. All order discounts must be
  // accounted for before an absent per-line allocation can safely mean zero.
  const allocatedDiscounts=discounts.reduce((sum:number,item:{amount:number|null})=>sum+(item.amount??0),0);
  const discountsAccounted=orderDiscount!==null&&allocatedDiscounts===orderDiscount&&!discounts.some((item:{invalid:boolean})=>item.invalid);
  const items: ProtectionItem[] = source.map((value: unknown,index:number) => {
    const line = record(value);
    const isProtection = own.has(text(line.product_id));
    const quantity = Number.isSafeInteger(line.quantity) && line.quantity > 0 ? line.quantity : 0;
    let gross = allowMoney ? cents(line.total_price) : null;
    if (gross === null && allowMoney && quantity > 0 && (isProtection || discountsAccounted)) {
      const price = cents(line.price);
      gross = price !== null && Number.isSafeInteger(price * quantity) ? price * quantity : null;
    }
    const discount=discounts[index];
    let amount=allowMoney?cents(line.final_line_price):null;
    if(amount===null&&gross!==null&&!discount.invalid&&(isProtection||discountsAccounted)){
      const deduction=discount.amount??0;
      amount=deduction<=gross?gross-deduction:null;
    }
    if (!quantity) amount = null;
    const refunded = line.refund_quantity_total;
    return { id: text(line.id), product_id: text(line.product_id), variant_id: text(line.variant_id),
      title: text(line.product_title || line.title) || '未命名商品', image_url: imageUrl(record(line.image).src || line.image_url),
      quantity, amount_cents: amount, is_protection: isProtection,
      refunded_quantity: Number.isSafeInteger(refunded) && refunded >= 0 ? Math.min(refunded, quantity) : 0 };
  });
  const ownLines = source.filter((line: any) => own.has(text(line?.product_id)));
  const allRefunded = ownLines.every((line:any)=>Number.isSafeInteger(line.quantity)&&line.quantity>0&&Number.isSafeInteger(line.refund_quantity_total)&&line.refund_quantity_total>=line.quantity);
  const refunded = allowMoney ? cents(snapshot.refund_amount || raw.total_refund_price) : null;
  const refundStatus = text(snapshot.refund_status);
  const paymentStatus = text(snapshot.payment_status);
  return {
    store_subdomain: text(snapshot.store_subdomain), store_name: text(snapshot.store_name) || text(snapshot.store_subdomain),
    order_id: text(snapshot.order_id), order_number: text(snapshot.order_number) || text(snapshot.order_id),
    customer_email: text(snapshot.customer_email), customer_name: text(snapshot.customer_name), currency,
    order_amount_cents: allowMoney ? cents(snapshot.order_amount) : null,
    protection_fee_cents: sumKnown(items.filter(item => item.is_protection).map(item => item.amount_cents)),
    protected_value_cents: sumKnown(items.filter(item => !item.is_protection).map(item => item.amount_cents)),
    refund_amount_cents: refunded ?? ((['partially_refunded','refunded','refunding','refund_failed'].includes(refundStatus) || ['partially_refunded', 'refunded', 'refunding', 'refund_failed'].includes(paymentStatus)) ? null : 0),
    payment_status: paymentStatus, order_status: text(snapshot.order_status), fulfillment_status: text(snapshot.fulfillment_status), refund_status: refundStatus,
    paid_at: dateOrNull(snapshot.paid_at),
    synced_at: new Date().toISOString(), items, logistics: Array.isArray(raw.fulfillments) ? raw.fulfillments : [],
    shipping_address: record(snapshot.shipping_address_json), service_fulfillment_status: allRefunded?'refunded':serviceState(ownLines,raw.fulfillments),
    timeline: extractProtectionTimeline(raw, items.filter(item => !item.is_protection)),
  };
}

/** Allocate approvals against individual merchandise rows so later claims cannot reuse their value. */
export function claimAllocation(items: ProtectionItem[], itemIds: string[], amount: number, previouslyApproved: Record<string, number>, orderBalance: number | null, selections?: Array<{item_id:string;quantity:number}>): Record<string, number> {
  if (!Array.isArray(itemIds) || !itemIds.length || itemIds.length > 100 || new Set(itemIds).size !== itemIds.length
    || itemIds.some(id => typeof id !== 'string' || !id)) throw new ProtectionError('请选择有效且不重复的商品');
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new ProtectionError('申请或审核金额必须为正整数分');
  if (orderBalance === null) throw new ProtectionError('订单余额未知，请先核对订单金额和退款');
  const selected = itemIds.map(id => items.find(item => item.id === id));
  if (selected.some(item => !item || item.is_protection)) throw new ProtectionError('申请商品不属于此订单或为保障服务商品');
  if (selected.some(item => item!.amount_cents === null)) throw new ProtectionError('商品金额未知，请先核对订单');
  if(selections !== undefined && (!Array.isArray(selections)||selections.length!==itemIds.length||new Set(selections.map(s=>s?.item_id)).size!==itemIds.length
    ||selections.some(s=>!s||!itemIds.includes(s.item_id)||!Number.isSafeInteger(s.quantity)||s.quantity<1||s.quantity>(items.find(i=>i.id===s.item_id)?.quantity||0))))throw new ProtectionError('申诉商品数量无效');
  const balances = selected.map(item => {
    const refunded = (item as ProtectionItem & { refunded_quantity?: number }).refunded_quantity || 0;
    const available = refunded ? Math.floor(item!.amount_cents! * Math.max(0, item!.quantity - refunded) / item!.quantity) : item!.amount_cents!;
    const quantity=selections?.find(s=>s.item_id===item!.id)?.quantity;
    const cap=quantity===undefined?available:Math.floor(item!.amount_cents!*quantity/item!.quantity);
    return { id: item!.id, balance: Math.min(cap,Math.max(0, available - (previouslyApproved[item!.id] || 0))) };
  });
  if (amount > orderBalance || amount > balances.reduce((sum, item) => sum + item.balance, 0)) throw new ProtectionError('金额超过所选商品或订单剩余可审核余额');
  let remainder = amount;
  const allocation: Record<string, number> = {};
  for (const item of balances.sort((a, b) => a.id.localeCompare(b.id))) {
    const assigned = Math.min(remainder, item.balance);
    if (assigned) allocation[item.id] = assigned;
    remainder -= assigned;
  }
  return allocation;
}

export function validateClaimTransition(from: ClaimStatus, to: ClaimStatus, note?: string, externalReference?: string): void {
  if (!CLAIM_STATUSES.includes(to)) throw new ProtectionError('无效的申请状态');
  if (from === to) return;
  const allowed: Record<ClaimStatus, ClaimStatus[]> = {
    submitted: ['reviewing', 'needs_info', 'approved', 'rejected'],
    reviewing: ['needs_info', 'approved', 'rejected'],
    needs_info: ['reviewing', 'approved', 'rejected'], approved: ['closed'], rejected: [], closed: [],
  };
  if (!allowed[from].includes(to)) throw new ProtectionError('不允许此申请状态变更', 409);
  if (['rejected', 'closed', 'needs_info'].includes(to) && !text(note)) throw new ProtectionError('请填写处理说明');
  if (from === 'approved' && to === 'closed' && !text(externalReference)) throw new ProtectionError('请填写外部处理凭证或记录编号');
}

export function csvCell(value: unknown): string {
  let valueText = value === null || value === undefined ? '' : String(value);
  if (/^[\s\u0000-\u001f]*[=+\-@]/.test(valueText) || /^[\t\r\n]/.test(valueText)) valueText = `'${valueText}`;
  return `"${valueText.replace(/"/g, '""')}"`;
}

export function isSameOriginMutation(origin: string | undefined, fetchSite: string | undefined, protocol: string, host: string | undefined): boolean {
  if (origin) {
    try { return new URL(origin).origin === `${protocol}://${host}`; } catch { return false; }
  }
  return fetchSite === 'same-origin';
}
