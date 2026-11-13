// ─────────────────────────────────────────────────────────────────────────────
// src/restaurants/operations.ts
//
// Per-outlet operating rules: pause switch, weekly hours, which order types and payment
// methods guests may use, and kitchen prep estimate. Stored as one JSON document on the
// restaurant so new rules never need a schema change.
// ─────────────────────────────────────────────────────────────────────────────

export const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type DayKey = (typeof DAYS)[number];

export interface DayHours {
  closed: boolean;
  /** 24h "HH:mm" */
  open: string;
  close: string;
}

export interface OutletOperations {
  /** Master switch: false pauses all guest ordering immediately. */
  acceptingOrders: boolean;
  pausedMessage: string;
  /** When true, guests can only order inside `hours`. When false, hours are informational. */
  enforceHours: boolean;
  hours: Record<DayKey, DayHours>;
  orderTypes: { dineIn: boolean; takeaway: boolean; delivery: boolean };
  payments: { upi: boolean; payAtCounter: boolean; cod: boolean };
  /** Typical kitchen time shown to guests, in minutes. */
  avgPrepMinutes: number;
  /** Printed at the bottom of customer receipts. */
  receiptFooter: string;
}

const day = (open = '09:00', close = '23:00'): DayHours => ({ closed: false, open, close });

export const DEFAULT_OPERATIONS: OutletOperations = {
  acceptingOrders: true,
  pausedMessage: '',
  enforceHours: false,
  hours: { sun: day(), mon: day(), tue: day(), wed: day(), thu: day(), fri: day(), sat: day() },
  orderTypes: { dineIn: true, takeaway: true, delivery: true },
  payments: { upi: true, payAtCounter: true, cod: true },
  avgPrepMinutes: 15,
  receiptFooter: '',
};

/** Fill any missing keys so older outlets (with `null` / partial JSON) behave like defaults. */
export function resolveOperations(raw?: Partial<OutletOperations> | null): OutletOperations {
  const r = raw ?? {};
  const hours = {} as Record<DayKey, DayHours>;
  for (const d of DAYS) hours[d] = { ...DEFAULT_OPERATIONS.hours[d], ...(r.hours?.[d] ?? {}) };
  return {
    ...DEFAULT_OPERATIONS,
    ...r,
    hours,
    orderTypes: { ...DEFAULT_OPERATIONS.orderTypes, ...(r.orderTypes ?? {}) },
    payments: { ...DEFAULT_OPERATIONS.payments, ...(r.payments ?? {}) },
  };
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

/** Wall-clock parts in India Standard Time, independent of the server's timezone. */
function istParts(now: Date) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => fmt.find((p) => p.type === t)?.value ?? '';
  const dayKey = get('weekday').toLowerCase().slice(0, 3) as DayKey;
  const hour = Number(get('hour')) % 24;
  return { dayKey, minutes: hour * 60 + Number(get('minute')) };
}

export interface OrderingStatus {
  accepting: boolean;
  reason: 'paused' | 'closed' | null;
  message: string | null;
  /** Today's opening hours, for display */
  today: DayHours | null;
}

/** Is this outlet taking guest orders right now? Handles overnight shifts (e.g. 18:00 → 02:00). */
export function getOrderingStatus(raw: Partial<OutletOperations> | null | undefined, now = new Date()): OrderingStatus {
  const ops = resolveOperations(raw);
  const { dayKey, minutes } = istParts(now);
  const today = ops.hours[dayKey] ?? null;

  if (!ops.acceptingOrders) {
    return { accepting: false, reason: 'paused', message: ops.pausedMessage || 'Ordering is paused right now. Please ask our staff.', today };
  }
  if (ops.enforceHours) {
    const prevKey = DAYS[(DAYS.indexOf(dayKey) + 6) % 7];
    const within = (h: DayHours | undefined, m: number, overnightTail: boolean) => {
      if (!h || h.closed) return false;
      const o = toMinutes(h.open);
      const c = toMinutes(h.close);
      if (c > o) return !overnightTail && m >= o && m < c; // same-day shift
      return overnightTail ? m < c : m >= o; // overnight: evening part today, early-morning tail tomorrow
    };
    const open = within(ops.hours[dayKey], minutes, false) || within(ops.hours[prevKey], minutes, true);
    if (!open) {
      return {
        accepting: false,
        reason: 'closed',
        message: today && !today.closed ? `We’re closed right now. Today’s hours: ${today.open} – ${today.close}.` : 'We’re closed today.',
        today,
      };
    }
  }
  return { accepting: true, reason: null, message: null, today };
}
