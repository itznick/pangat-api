import { StaffRole } from '../common/enums/index.js';

/**
 * Least-privilege view of an order. The kitchen only needs to know WHAT to cook, for WHICH table or parcel and WHEN.
 * Customer contact details, delivery address and every money / payment field are removed for the CHEF role
 * (this includes the shared Kitchen Station account), so a kitchen tablet can never leak them.
 */
const KITCHEN_HIDDEN = [
  'customerPhone', 'deliveryAddress', 'deliveryInstructions', 'trackingToken', 'idempotencyKey', 'deliveryFee',
  'subtotal', 'gstAmount', 'serviceChargeAmount', 'totalAmount',
  'paymentMethod', 'paymentStatus', 'settledAt', 'refundAmount', 'refundReason', 'refundedAt', 'refundedByStaffId',
  'billNumber', 'creditNoteNumber', 'feedback',
] as const;

const firstName = (n?: string | null) => (n ? String(n).trim().split(/\s+/)[0] : n ?? null);

export function isKitchenOnly(user?: { role?: string; isPlatformAdmin?: boolean } | null): boolean {
  return Boolean(user && user.role === StaffRole.CHEF && !user.isPlatformAdmin);
}

export function redactForKitchen<T extends Record<string, any>>(order: T): T {
  if (!order || typeof order !== 'object') return order;
  const out: Record<string, any> = { ...order };
  for (const k of KITCHEN_HIDDEN) delete out[k];
  if ('customerName' in out) out.customerName = firstName(out.customerName); // enough to call out a parcel
  if (Array.isArray(out.items)) {
    out.items = out.items.map((i: Record<string, any>) => {
      const c = { ...i };
      delete c.price;
      if (Array.isArray(c.selectedModifiers)) c.selectedModifiers = c.selectedModifiers.map((m: Record<string, any>) => { const { price: _p, priceDelta: _d, ...rest } = m; return rest; });
      return c;
    });
  }
  if (out.restaurant && typeof out.restaurant === 'object') {
    out.restaurant = { id: out.restaurant.id, name: out.restaurant.name, slug: out.restaurant.slug };
  }
  return out as T;
}

export const redactOrdersFor = <T extends Record<string, any>>(user: any, orders: T[]): T[] =>
  isKitchenOnly(user) ? orders.map(redactForKitchen) : orders;
