import type { ClaimStatus } from './protection-types';
import type { ProtectionCoverage, ProtectionRequestWindow } from './protection-policy';
export type { ProtectionCoverage, ProtectionRequestWindow } from './protection-policy';

export type CustomerIssueCode = 'damaged' | 'missing_items' | 'wrong_item' | 'delivered_not_received' | 'not_arrived' | 'delayed' | 'other';
export interface CustomerSelection { item_id: string; quantity: number; }
export interface CustomerLocation { latitude: number; longitude: number; accuracy_meters: number; captured_at: string; }
export type CustomerCaptureCategory = 'damaged_item' | 'outer_packaging' | 'shipping_label' | 'additional';
export interface CustomerCaptureSession { id: string; category: CustomerCaptureCategory; expires_at: string; }
export interface CustomerEvidence {
  id: string; kind: 'image' | 'video'; original_name: string; size_bytes: number; url: string;
  source?: 'upload' | 'camera';
  /** Records the capture workflow only; this is not a claim of image authenticity. */
  capture?: { category: CustomerCaptureCategory; requested_at: string; received_at: string };
}
export interface CustomerClaim {
  public_no: string; protection_no: string; reason: string; issue_code: CustomerIssueCode | null;
  received_package: boolean | null; description: string; status: ClaimStatus;
  requested_amount_cents: number; approved_amount_cents: number | null; currency: string;
  selections: CustomerSelection[]; created_at: string; updated_at: string; customer_message: string | null;
  evidence: CustomerEvidence[]; location: CustomerLocation | null;
  camera_exception_reason?: string | null;
  messages: Array<{ id: string; description: string; created_at: string; evidence: CustomerEvidence[] }>;
}
export interface CustomerProtectionOrder {
  protection_no: string; order_number: string; currency: string; purchased_at: string | null;
  customer_name: string; protection_fee_cents: number | null; remaining_amount_cents: number | null;
  shipping_address: { address1: string; address2: string; city: string; province: string; postal_code: string; country: string };
  items: Array<{ id: string; title: string; image_url: string | null; quantity: number; amount_cents: number | null; available_quantity: number; available_amount_cents: number | null; has_active_claim: boolean; request_windows?: ProtectionRequestWindow[] }>;
  shipments: Array<{ id: string; tracking_numbers: string[]; carrier: string; status: string; item_quantities: CustomerSelection[] }>;
}
export interface CustomerOrderResponse {
  ok: true; order: CustomerProtectionOrder; claims: CustomerClaim[];
  coverage?: ProtectionCoverage;
  eligibility: { can_submit: boolean; reason_code: string | null; message: string | null };
  limits: { max_files: number; max_file_bytes: number; max_total_bytes: number };
}
export interface CustomerClaimInput {
  submission_id: string; received_package: boolean; issue_code: CustomerIssueCode;
  selections: CustomerSelection[]; description: string; evidence_ids: string[]; location: CustomerLocation | null;
  camera_exception_reason?: string | null;
}
export interface CustomerMessageInput { submission_id: string; description: string; evidence_ids: string[]; }
