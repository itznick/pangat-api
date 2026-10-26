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

export enum OrderStatus {
  RECEIVED  = 'RECEIVED',
  PREPARING = 'PREPARING',
  READY     = 'READY',
  COMPLETED = 'COMPLETED',
}

export enum PaymentStatus {
  PENDING = 'PENDING',
  PAID    = 'PAID',
  FAILED  = 'FAILED',
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
