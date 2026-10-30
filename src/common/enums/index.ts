// ─────────────────────────────────────────────────────────────────────────────
// src/common/enums/index.ts  –  Pangat canonical enum definitions
// Mirror the exact string unions from pangat-web/src/types/domain.ts
// ─────────────────────────────────────────────────────────────────────────────

export enum TableStatus {
  VACANT   = 'VACANT',
  OCCUPIED = 'OCCUPIED',
  PREPPING = 'PREPPING',
  SERVED   = 'SERVED',
}

export enum OrderType {
  DINE_IN  = 'DINE_IN',
  TAKEAWAY = 'TAKEAWAY',
  DELIVERY = 'DELIVERY',
}

export enum OrderStatus {
  RECEIVED   = 'RECEIVED',
  PREPARING  = 'PREPARING',
  READY      = 'READY',
  DISPATCHED = 'DISPATCHED',
  COMPLETED  = 'COMPLETED',
  CANCELLED  = 'CANCELLED',
}

export enum PaymentStatus {
  PENDING            = 'PENDING',
  PAID               = 'PAID',
  FAILED             = 'FAILED',
  REFUND_PENDING     = 'REFUND_PENDING',
  PARTIALLY_REFUNDED = 'PARTIALLY_REFUNDED',
  REFUNDED           = 'REFUNDED',
}

export enum PaymentMethod {
  UPI_INSTANT     = 'UPI_INSTANT',
  PAY_AT_COUNTER  = 'PAY_AT_COUNTER',
}

export enum ModifierType {
  SINGLE   = 'SINGLE',
  MULTIPLE = 'MULTIPLE',
}

export enum StaffRole {
  PLATFORM_SUPER_ADMIN = 'PLATFORM_SUPER_ADMIN',
  SUPER_OWNER          = 'SUPER_OWNER',
  STORE_MANAGER        = 'STORE_MANAGER',
  CHEF                 = 'CHEF',
  STEWARD              = 'STEWARD',
}

export enum LeadStatus {
  NEW        = 'NEW',
  CONTACTED  = 'CONTACTED',
  SCHEDULED  = 'SCHEDULED',
  ONBOARDED  = 'ONBOARDED',
}

export enum AuditAction {
  ORDER_STATUS_CHANGED   = 'ORDER_STATUS_CHANGED',
  ORDER_STAGE_REGRESSED  = 'ORDER_STAGE_REGRESSED',
  ORDER_ITEMS_EDITED     = 'ORDER_ITEMS_EDITED',
  ORDER_CANCELLED        = 'ORDER_CANCELLED',
  ORDER_REFUND_REQUESTED = 'ORDER_REFUND_REQUESTED',
  ORDER_REFUND_SETTLED   = 'ORDER_REFUND_SETTLED',
  STOCK_ADJUSTED         = 'STOCK_ADJUSTED',
  STOCK_RECEIVED         = 'STOCK_RECEIVED',
  INGREDIENT_CREATED     = 'INGREDIENT_CREATED',
  INGREDIENT_UPDATED     = 'INGREDIENT_UPDATED',
}

export enum UnitOfMeasure {
  KG     = 'KG',
  GRAM   = 'GRAM',
  LITRE  = 'LITRE',
  ML     = 'ML',
  PIECE  = 'PIECE',
  PACKET = 'PACKET',
}

export enum StockMovementType {
  OPENING_STOCK               = 'OPENING_STOCK',
  RECEIVED                    = 'RECEIVED',
  MANUAL_ADJUSTMENT           = 'MANUAL_ADJUSTMENT',
  ORDER_CONSUMPTION           = 'ORDER_CONSUMPTION',
  ORDER_CANCELLATION_REVERSAL = 'ORDER_CANCELLATION_REVERSAL',
  WASTAGE                     = 'WASTAGE',
}
