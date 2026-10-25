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
