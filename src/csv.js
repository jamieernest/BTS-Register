import { tx } from './db.js';

// Minimal RFC 4180 parser: quoted fields, "" escapes, CRLF/LF, BOM. Blank lines are skipped.
export function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') { field += '"'; i++; }
      else quoted = false;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (quoted) throw new Error('unterminated quoted field');
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

// Returns { records: [{row, ...fields}], errors } where `row` counts non-blank rows, header = row 1.
function readTable(text, required, optional = []) {
  let rows;
  try {
    rows = parseCsv(String(text ?? ''));
  } catch (e) {
    return { records: [], errors: [e.message] };
  }
  if (!rows.length) return { records: [], errors: ['The file is empty'] };
  const header = rows[0].map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  const missing = required.filter((c) => !header.includes(c));
  if (missing.length) return { records: [], errors: [`Missing required column(s): ${missing.join(', ')}`] };
  const cols = [...required, ...optional].filter((c) => header.includes(c));
  const records = rows.slice(1).map((r, i) => {
    const rec = { row: i + 2 };
    for (const c of cols) rec[c] = (r[header.indexOf(c)] ?? '').trim();
    return rec;
  });
  return { records, errors: [] };
}

// All-or-nothing: if any row is invalid nothing is written. Re-import updates by username (no duplicates).
// `lookup(username)` (see ldap.js) resolves to {name} or null when the user does not exist; it is null
// only in dev mode without LDAP, in which case the CSV must supply the name.
export async function importCast(db, text, lookup) {
  const { records, errors } = readTable(text, ['username'], ['name']);
  const seen = new Set();
  for (const r of records) {
    const u = r.username.toLowerCase();
    if (!u) { errors.push(`Row ${r.row}: username is required`); continue; }
    if (seen.has(u)) { errors.push(`Row ${r.row}: duplicate username "${r.username}" in file`); continue; }
    seen.add(u);
    if (r.name && r.name.length > 100) { errors.push(`Row ${r.row}: name is too long (max 100 characters)`); continue; }
    if (lookup) {
      try {
        const found = await lookup(u);
        if (!found) errors.push(`Row ${r.row}: username "${r.username}" not found in LDAP`);
        else r.name ||= found.name;
      } catch (e) {
        return { ok: false, errors: [`LDAP lookup failed: ${e.message}`] };
      }
    }
    if (!r.name && !errors.length) errors.push(`Row ${r.row}: no name in the CSV and none available`);
  }
  if (!errors.length && !records.length) errors.push('No data rows');
  if (errors.length) return { ok: false, errors };
  let added = 0, updated = 0;
  tx(db, () => {
    const exists = db.prepare('SELECT 1 FROM cast_members WHERE username = ?');
    const up = db.prepare('INSERT INTO cast_members (username, name) VALUES (?, ?) ON CONFLICT(username) DO UPDATE SET name = excluded.name');
    for (const r of records) {
      exists.get(r.username.toLowerCase()) ? updated++ : added++;
      up.run(r.username.toLowerCase(), r.name);
    }
  });
  return { ok: true, added, updated, errors: [] };
}

function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function importShows(db, text) {
  const { records, errors } = readTable(text, ['date'], ['name', 'call_time']);
  const seen = new Set();
  for (const r of records) {
    if (!validDate(r.date)) errors.push(`Row ${r.row}: invalid date "${r.date}" (use YYYY-MM-DD)`);
    else if (seen.has(r.date)) errors.push(`Row ${r.row}: duplicate date ${r.date} in file`);
    else seen.add(r.date);
    if (r.call_time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(r.call_time)) errors.push(`Row ${r.row}: invalid call_time "${r.call_time}" (use HH:MM)`);
  }
  if (!errors.length && !records.length) errors.push('No data rows');
  if (errors.length) return { ok: false, errors };
  let added = 0, updated = 0;
  tx(db, () => {
    const exists = db.prepare('SELECT 1 FROM shows WHERE date = ?');
    const up = db.prepare('INSERT INTO shows (date, name, call_time) VALUES (?, ?, ?) ON CONFLICT(date) DO UPDATE SET name = excluded.name, call_time = excluded.call_time');
    for (const r of records) {
      exists.get(r.date) ? updated++ : added++;
      up.run(r.date, r.name || null, r.call_time || null);
    }
  });
  return { ok: true, added, updated, errors: [] };
}

// Spreadsheet formula injection guard for exported cells.
export function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
