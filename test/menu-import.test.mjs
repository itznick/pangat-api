import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, parseMenuCsv, parsePrice, parseBool, IMPORT_MAX_ROWS, IMPORT_MAX_BYTES } from '../dist/menu/menu-import.js';

describe('CSV parsing', () => {
  it('handles quotes, doubled quotes, commas and newlines inside a quoted cell, CRLF, a BOM and a trailing blank line', () => {
    const t = parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n"line1\nline2",z\r\n\r\n');
    assert.deepEqual(t[0], ['a', 'b']);
    assert.deepEqual(t[1], ['x, y', 'say "hi"']);
    assert.deepEqual(t[2], ['line1\nline2', 'z']);
  });
  it('accepts a semicolon-separated file (common from spreadsheets in India)', () => {
    assert.deepEqual(parseCsv('name;price\nTea;20\n')[1], ['Tea', '20']);
  });
});

describe('prices and flags', () => {
  it('accepts ₹, Rs, thousands commas and two decimals; refuses everything else', () => {
    assert.equal(parsePrice('₹1,200.50'), 1200.5);
    assert.equal(parsePrice('Rs. 99'), 99);
    assert.equal(parsePrice('120'), 120);
    assert.equal(parsePrice('1,200'), 1200);
    assert.equal(parsePrice('0'), 0);
    for (const bad of ['', 'abc', '-5', '12.345', '1e3', '12,5', '12,50', '1,20', ',5', '1,2000', '100001', 'NaN', '1.2.3']) assert.equal(parsePrice(bad), null, bad);
  });
  it('understands veg/non-veg and yes/no, blank means the default, anything else is an error', () => {
    assert.equal(parseBool('Veg', true), true);
    assert.equal(parseBool('non-veg', true), false);
    assert.equal(parseBool('', true), true);
    assert.equal(parseBool('', false), false);
    assert.equal(parseBool('maybe', true), null);
  });
});

describe('menu file validation', () => {
  const ok = 'category,name,price,description,veg\nBeverages,Masala Chai,20,Strong tea,veg\nSnacks,Chicken Roll,"1,150.50",,non-veg\n';
  it('reads a normal file', () => {
    const r = parseMenuCsv(ok);
    assert.deepEqual(r.fileErrors, []); assert.deepEqual(r.errors, []);
    assert.equal(r.rows.length, 2);
    assert.deepEqual(r.rows[1], { line: 3, category: 'Snacks', name: 'Chicken Roll', price: 1150.5, description: '', isVeg: false, isAvailable: true });
  });
  it('accepts synonyms and any column order; a missing category goes to "Menu"', () => {
    const r = parseMenuCsv('Rate,Dish Name\n40,Poha\n');
    assert.equal(r.rows[0].name, 'Poha'); assert.equal(r.rows[0].category, 'Menu'); assert.equal(r.rows[0].price, 40);
  });
  it('requires name and price columns and says so', () => {
    assert.match(parseMenuCsv('category,price\nA,1').fileErrors.join(' '), /name/);
    assert.match(parseMenuCsv('name,category\nA,B').fileErrors.join(' '), /price/);
    assert.match(parseMenuCsv('').fileErrors.join(' '), /empty/);
    assert.match(parseMenuCsv('   \n  ').fileErrors.join(' '), /empty/);
  });
  it('reports each bad row with its line number and keeps the good ones', () => {
    const r = parseMenuCsv('name,price,veg\nTea,20,veg\n,10,veg\nCoffee,abc,veg\nWada,15,maybe\nSamosa,12,veg\n');
    assert.deepEqual(r.rows.map((x) => x.name), ['Tea', 'Samosa']);
    assert.deepEqual(r.errors.map((e) => e.line), [3, 4, 5]);
    assert.match(r.errors[1].message, /Coffee.*abc/);
  });
  it('limits rows and size', () => {
    const many = 'name,price\n' + Array.from({ length: IMPORT_MAX_ROWS + 1 }, (_, i) => `D${i},1`).join('\n');
    assert.match(parseMenuCsv(many).fileErrors.join(' '), /Too many rows/);
    const big = 'name,price\n' + 'x'.repeat(IMPORT_MAX_BYTES + 10);
    assert.match(parseMenuCsv(big).fileErrors.join(' '), /too large/);
  });
  it('refuses over-long names and categories', () => {
    assert.equal(parseMenuCsv(`name,price\n${'a'.repeat(201)},1`).errors.length, 1);
    assert.equal(parseMenuCsv(`category,name,price\n${'c'.repeat(101)},A,1`).errors.length, 1);
  });
  it('treats text starting with = + - @ as plain text (it is stored, never evaluated)', () => {
    const r = parseMenuCsv('name,price\n=HYPERLINK("x"),5\n');
    assert.equal(r.rows[0].name, '=HYPERLINK("x")');
  });
});
