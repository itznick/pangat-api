import { EntityManager } from 'typeorm';

/**
 * Statutory serial numbers (CGST Rule 46): consecutive, unique within the financial year, at most 16 characters.
 *   bill         AB12/2627/000123   (outlet code / financial year / 6-digit serial)  = 16 characters
 *   credit note  AB12/2627/C00007   (own series, "C" + 5-digit serial)                = 16 characters
 * The serial comes from a counter row that is incremented INSIDE the issuing transaction: the row lock serialises concurrent
 * payments per outlet, and a rolled-back payment also rolls back its number, so there are no gaps.
 */
export type DocumentKind = 'BILL' | 'CREDIT_NOTE';

/** Indian financial year label for an instant, e.g. 2026-11-22 -> "2627", 2027-03-31 -> "2627", 2027-04-01 IST -> "2728". */
export function fiscalYearOf(when: Date): string {
  // IST = UTC+5:30: a bill paid at 00:10 on 1 April IST belongs to the NEW year even though it is still 31 March in UTC
  const ist = new Date(when.getTime() + 5.5 * 3600_000);
  const y = ist.getUTCFullYear();
  const start = ist.getUTCMonth() >= 3 ? y : y - 1; // month index 3 = April
  return `${String(start % 100).padStart(2, '0')}${String((start + 1) % 100).padStart(2, '0')}`;
}

export function formatDocumentNumber(kind: DocumentKind, prefix: string, fy: string, serial: number): string {
  const n = kind === 'BILL' ? `${prefix}/${fy}/${String(serial).padStart(6, '0')}` : `${prefix}/${fy}/C${String(serial).padStart(5, '0')}`;
  if (n.length > 16) throw new Error(`Document number ${n} is longer than 16 characters (the serial has overflowed)`);
  return n;
}

/** The outlet's short code. Created once, on first use, and never changes. */
export async function ensureInvoicePrefix(em: EntityManager, restaurantId: string): Promise<string> {
  const read = async () => (await em.query('SELECT invoice_prefix FROM restaurants WHERE id = $1', [restaurantId]))[0]?.invoice_prefix as string | null | undefined;
  const existing = await read();
  if (existing) return existing;
  for (let i = 0; i < 12; i++) {
    // The NOT EXISTS keeps a collision from raising an error (which would abort the whole transaction): we simply try another code
    await em.query(
      `UPDATE restaurants SET invoice_prefix = $2 WHERE id = $1 AND invoice_prefix IS NULL
         AND NOT EXISTS (SELECT 1 FROM restaurants WHERE invoice_prefix = $2)`,
      [restaurantId, `${i % 2 ? 'B' : 'A'}${Math.floor(Math.random() * 36 ** 3).toString(36).toUpperCase().padStart(3, '0')}`],
    );
    const got = await read();
    if (got) return got;
  }
  throw new Error('Could not allocate an invoice prefix for this outlet');
}

export async function nextSerial(em: EntityManager, restaurantId: string, kind: DocumentKind, fy: string): Promise<number> {
  const rows = await em.query(
    `INSERT INTO document_sequences (restaurant_id, kind, fiscal_year, last_value) VALUES ($1, $2, $3, 1)
     ON CONFLICT (restaurant_id, kind, fiscal_year) DO UPDATE SET last_value = document_sequences.last_value + 1
     RETURNING last_value`,
    [restaurantId, kind, fy],
  );
  const row = Array.isArray(rows?.[0]) ? rows[0][0] : rows?.[0];
  return Number(row.last_value);
}

export interface BillableOrder {
  id: string;
  restaurantId: string;
  totalAmount: number | string;
  billNumber?: string | null;
  billIssuedAt?: Date | null;
}

/** Give a paid order its bill number (idempotent). Mutates `order`; the caller saves it in the same transaction. */
export async function issueBillNumber(em: EntityManager, order: BillableOrder, actor?: { name?: string | null }, when = new Date()): Promise<string> {
  if (order.billNumber) return order.billNumber;
  const prefix = await ensureInvoicePrefix(em, order.restaurantId);
  const fy = fiscalYearOf(when);
  const number = formatDocumentNumber('BILL', prefix, fy, await nextSerial(em, order.restaurantId, 'BILL', fy));
  await em.query(
    `INSERT INTO tax_documents (restaurant_id, order_id, kind, number, fiscal_year, amount, issued_by, issued_at) VALUES ($1,$2,'BILL',$3,$4,$5,$6,$7)`,
    [order.restaurantId, order.id, number, fy, Number(order.totalAmount), actor?.name ?? null, when],
  );
  order.billNumber = number;
  order.billIssuedAt = when;
  return number;
}

/** A refund after payment needs a credit note that refers to the bill (CGST Rule 53). Returns the credit note number. */
export async function issueCreditNote(
  em: EntityManager,
  order: BillableOrder & { settledAt?: Date | null },
  amount: number,
  reason: string,
  actor?: { name?: string | null },
  when = new Date(),
): Promise<string> {
  // An order paid before numbering existed still needs the bill it is being credited against
  if (!order.billNumber) await issueBillNumber(em, order, actor, order.settledAt ?? when);
  const prefix = await ensureInvoicePrefix(em, order.restaurantId);
  const fy = fiscalYearOf(when);
  const number = formatDocumentNumber('CREDIT_NOTE', prefix, fy, await nextSerial(em, order.restaurantId, 'CREDIT_NOTE', fy));
  await em.query(
    `INSERT INTO tax_documents (restaurant_id, order_id, kind, number, fiscal_year, amount, reason, issued_by, issued_at) VALUES ($1,$2,'CREDIT_NOTE',$3,$4,$5,$6,$7,$8)`,
    [order.restaurantId, order.id, number, fy, amount, reason.slice(0, 500), actor?.name ?? null, when],
  );
  return number;
}
