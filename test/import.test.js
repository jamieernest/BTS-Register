import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { importCast, importShows, parseCsv } from '../src/csv.js';
import { fakeLdap } from './helpers.js';

const count = (db, t) => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;

test('parseCsv handles quotes, CRLF, BOM and blank lines', () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n"x,1","he said ""hi"""\r\n\r\n'), [['a', 'b'], ['x,1', 'he said "hi"']]);
});

test('cast import: lowercases, uses LDAP name when CSV has none, re-import is safe', async () => {
  const db = openDb(':memory:');
  let r = await importCast(db, 'username,name\nTWJK20,\njl3820,Bobby\n', fakeLdap);
  assert.equal(r.ok, true);
  assert.deepEqual(db.prepare('SELECT username, name FROM cast_members ORDER BY username').all().map((x) => ({ ...x })),
    [{ username: 'jl3820', name: 'Bobby' }, { username: 'twjk20', name: 'Alice Ldap' }]);
  r = await importCast(db, 'username\ntwjk20\n', fakeLdap);
  assert.equal(r.updated, 1);
  assert.equal(count(db, 'cast_members'), 2);
});

test('cast import: unknown LDAP user and in-file duplicates reject everything', async () => {
  const db = openDb(':memory:');
  const r = await importCast(db, 'username\ntwjk20\nnobody1\nTWJK20\n', fakeLdap);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /Row 3.*not found in LDAP/);
  assert.match(r.errors.join('\n'), /Row 4.*duplicate/);
  assert.equal(count(db, 'cast_members'), 0);
});

test('cast import: no LDAP (dev) requires a name; missing column reported', async () => {
  const db = openDb(':memory:');
  assert.equal((await importCast(db, 'username\nabc1\n', null)).ok, false);
  assert.equal((await importCast(db, 'username,name\nabc1,Abe\n', null)).ok, true);
  assert.match((await importCast(db, 'name\nAbe\n', null)).errors[0], /Missing required column/);
});

test('show import: validates dates and call times, upserts', () => {
  const db = openDb(':memory:');
  const bad = importShows(db, 'date,call_time\n2026-02-30,19:00\n2026-07-10,25:00\n2026-07-11,\n2026-07-11,\n');
  assert.equal(bad.errors.length, 3);
  assert.equal(count(db, 'shows'), 0);
  assert.equal(importShows(db, 'date,name,call time\n2026-07-10,Opening,18:30\n').ok, true);
  const r = importShows(db, 'date,name\n2026-07-10,Renamed\n');
  assert.equal(r.updated, 1);
  assert.equal(db.prepare('SELECT name FROM shows').get().name, 'Renamed');
});
