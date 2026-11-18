/** Shared API contracts. Money is integer cents; timestamps are ISO strings. */
export type ClaimStatus = 'submitted' | 'reviewing' | 'needs_info' | 'approved' | 'rejected' | 'closed';
export type ClaimReason = 'lost' | 'damaged' | 'stolen' | 'delayed' | 'other';
export interface ProtectionItem { id: string; product_id: string; variant_id: string; title: string; image_url: string | null; quantity: number; amount_cents: number | null; is_protection: boolean; }
export interface ProtectionOrder {
 id: string; public_no: string; store_subdomain: string; store_name: string; order_id: string; order_number: string;
 customer_email: string; customer_name: string; currency: string; order_amount_cents: number | null; protection_fee_cents: number | null;
 protected_value_cents: number | null; refund_amount_cents: number | null; payment_status: string; order_status: string; fulfillment_status: string; refund_status: string;
 paid_at: string | null; synced_at: string; items: ProtectionItem[]; logistics: unknown; shipping_address: unknown;
 claim_count: number; service_fulfillment_status: string;
 timeline?: import('./protection-policy').ProtectionTimeline;
}
export interface ProtectionClaim {
 id: string; public_no: string; protection_order_id: string; protection_public_no: string; store_subdomain: string; store_name: string; order_number: string;
 customer_email: string; customer_name: string; reason: ClaimReason; description: string; status: ClaimStatus;
 requested_amount_cents: number; approved_amount_cents: number | null; currency: string; item_ids: string[];
 assignee_id: number | null; assignee_name: string | null; revision: number; created_at: string; updated_at: string;
 resolution_note: string | null; external_reference: string | null;
 customer_message?: string | null;
}
export interface ProtectionEvent { id: string; actor_name: string; action: string; note: string; created_at: string; detail?: {from_status?:ClaimStatus;to_status?:ClaimStatus;approved_amount_cents?:number|null;external_reference?:string|null}; }
export interface ClaimDetail { claim: ProtectionClaim; order: ProtectionOrder; events: ProtectionEvent[]; customer_submission?: import('./protection-customer-types').CustomerClaim; }
export interface ProtectionStats {
 first_protection_day: string | null;
 protected_orders: number; claims: number; pending_claims: number; approved_claims: number; rejected_claims: number; closed_claims: number;
 currencies: Array<{currency: string; protection_fee_cents: number | null; protected_value_cents: number | null; unknown_orders: number; requested_amount_cents: number; approved_amount_cents: number}>;
 daily: Array<{date: string; paid_orders: number; orders: number; claims: number}>;
 by_store: Array<{store_subdomain: string; store_name: string; paid_orders: number; orders: number; claims: number; pending: number}>;
 synced_at: string | null;
}
export interface ProtectionStore {
 id: number; subdomain: string; store_name: string; store_enabled: boolean; configured: boolean; enabled: boolean;
 theme_id: string | null; theme_family: string | null; active_theme_id: string | null; version: string | null;
 health: 'unknown' | 'healthy' | 'disabled' | 'needs_adaptation' | 'error'; health_message: string; checked_at: string | null;
 product_ids: string[]; fulfillment_enabled: boolean; latest_job: ProtectionInstallJob | null;
}
export interface ProtectionInstallJob { id: string; store_subdomain: string; action: 'check' | 'install' | 'disable'; status: 'queued' | 'running' | 'succeeded' | 'failed'; message: string; created_at: string; finished_at: string | null; }
export interface ProtectionList<T> { ok: true; items: T[]; total: number; page: number; page_size: number; }
export type ProtectionEmailEventType = 'shipment' | 'completion' | 'claim_update';
export type ProtectionEmailStatus = 'pending' | 'sending' | 'sent' | 'cancelled';
export interface ProtectionEmailRecord {
 id: string; event_type: ProtectionEmailEventType; status: ProtectionEmailStatus;
 protection_order_id: string; protection_public_no: string; claim_id: string | null; claim_public_no: string | null;
 store_subdomain: string; store_name: string; order_number: string; recipient_email: string;
 target_status: ClaimStatus | null; attempts: number;
 created_at: string; updated_at: string; sent_at: string | null; next_attempt_at: string | null;
 manual_requested_at: string | null; last_error_code: string | null;
}
