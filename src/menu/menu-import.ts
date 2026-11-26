/**
 * Menu CSV import: parsing and validation only (no database). Pure so every rule can be unit tested.
 *
 * Columns (header row required, any order, case-insensitive, common synonyms accepted):
 *   category | name (required) | price (required) | description | veg | available
 * Prices accept "₹", "Rs", thousands commas and up to two decimals. `veg` accepts veg/non-veg/yes/no/true/false/1/0.
 */

export const IMPORT_MAX_BYTES = 200_000;
export const IMPORT_MAX_ROWS = 500;
export const DEFAULT_CATEGORY = 'Menu';

export interface ImportRow {
  /** 1-based line in the file (the header is line 1) */
  line: number;
  category: string;
  name: string;
  price: number;
  description: string;
  isVeg: boolean;
  isAvailable: boolean;
}
export interface RowError { line: number; message: string }
export interface ParsedImport { rows: ImportRow[]; errors: RowError[]; fileErrors: string[] }

const HEADER_ALIASES: Record<string, string> = {
  category: 'category', 'category name': 'category', section: 'category', group: 'category',
  name: 'name', dish: 'name', item: 'name', 'item name': 'name', 'dish name': 'name',
  price: 'price', rate: 'price', mrp: 'price', amount: 'price', 'price (inr)': 'price', 'price (₹)': 'price',
  description: 'description', desc: 'description', details: 'description',
  veg: 'veg', 'is veg': 'veg', 'veg/non-veg': 'veg', type: 'veg', diet: 'veg',
  available: 'available', 'is available': 'available', availability: 'available', active: 'available',
};

/** RFC 4180 style: commas, quoted fields, doubled quotes, CRLF/LF, newlines inside quotes. Also tolerates a BOM and a semicolon-separated file. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      rows.push(row); row = [];
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

export function parsePrice(raw: string): number | null {
  const s = String(raw ?? '').trim().replace(/^(?:₹|rs\.?|inr)\s*/i, '').trim();
  // A comma is accepted ONLY as a thousands separator (1,200 or 1,200.50). "12,5" is ambiguous (a European decimal?): refuse it rather than
  // silently reading it as 125, which would put a 10x price on the menu.
  if (!/^(\d+|\d{1,3}(,\d{3})+)(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) && n >= 0 && n <= 100_000 ? n : null;
}

export function parseBool(raw: string | undefined, whenBlank: boolean): boolean | null {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === '') return whenBlank;
  if (['yes', 'y', 'true', '1', 'veg', 'vegetarian'].includes(s)) return true;
  if (['no', 'n', 'false', '0', 'non-veg', 'non veg', 'nonveg', 'non-vegetarian', 'egg'].includes(s)) return false;
  return null;
}

export function parseMenuCsv(text: string): ParsedImport {
  const out: ParsedImport = { rows: [], errors: [], fileErrors: [] };
  if (typeof text !== 'string' || !text.trim()) { out.fileErrors.push('The file is empty.'); return out; }
  if (Buffer.byteLength(text, 'utf8') > IMPORT_MAX_BYTES) { out.fileErrors.push(`The file is too large (limit ${Math.round(IMPORT_MAX_BYTES / 1000)} KB). Split it into smaller files.`); return out; }
  const table = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ''));
  if (table.length === 0) { out.fileErrors.push('The file is empty.'); return out; }

  const header = table[0].map((h) => HEADER_ALIASES[h.trim().toLowerCase()] ?? null);
  const col = (k: string) => header.indexOf(k);
  if (col('name') < 0) out.fileErrors.push('Missing a "name" column. The first row must be a header such as: category,name,price,description,veg');
  if (col('price') < 0) out.fileErrors.push('Missing a "price" column.');
  if (out.fileErrors.length) return out;
  if (table.length - 1 > IMPORT_MAX_ROWS) { out.fileErrors.push(`Too many rows (${table.length - 1}). The limit is ${IMPORT_MAX_ROWS} dishes per import.`); return out; }

  // line numbers refer to the original file's non-empty rows, counted from the header as line 1
  for (let i = 1; i < table.length; i++) {
    const cells = table[i];
    const line = i + 1;
    const get = (k: string) => (col(k) >= 0 ? (cells[col(k)] ?? '').trim() : '');
    const name = get('name');
    if (!name) { out.errors.push({ line, message: 'The dish name is empty.' }); continue; }
    if (name.length > 200) { out.errors.push({ line, message: 'The dish name is longer than 200 characters.' }); continue; }
    const price = parsePrice(get('price'));
    if (price === null) { out.errors.push({ line, message: `"${name}": the price "${get('price')}" is not a valid amount (use digits, for example 120 or 120.50).` }); continue; }
    const category = (get('category') || DEFAULT_CATEGORY).replace(/\s+/g, ' ');
    if (category.length > 100) { out.errors.push({ line, message: `"${name}": the category name is longer than 100 characters.` }); continue; }
    const veg = parseBool(get('veg'), true);
    if (veg === null) { out.errors.push({ line, message: `"${name}": "${get('veg')}" is not understood for veg (use veg or non-veg).` }); continue; }
    const avail = parseBool(get('available'), true);
    if (avail === null) { out.errors.push({ line, message: `"${name}": "${get('available')}" is not understood for available (use yes or no).` }); continue; }
    out.rows.push({ line, category, name, price, description: get('description').slice(0, 1000), isVeg: veg, isAvailable: avail });
  }
  return out;
}

export const normKey = (category: string, name: string) => `${category.trim().toLowerCase()}||${name.trim().toLowerCase()}`;
