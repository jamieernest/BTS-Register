import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, CAST_CSV, fakeLdap } from './helpers.js';
import { importCast, importShows } from '../src/csv.js';
import { loadConfig } from '../src/config.js';
import { validateTicket } from '../src/cas.js';

async function seeded(opts) {
  const t = await setup(opts);
  await importCast(t.db, CAST_CSV, fakeLdap); // seed directly so a test's ldapLookup override only affects sign-in
  importShows(t.db, 'date,name,call_time\n2026-07-10,Opening,18:30\n');
  return t;
}
const registered = (t) => t.db.prepare('SELECT COUNT(*) n FROM registrations').get().n;

test('register on a show day is recorded once (idempotent)', async () => {
  const t = await seeded();
  const a = await t.post('/register', {}, t.cast);
  assert.match(await a.text(), /You&#39;re registered|You're registered/);
  const first = t.db.prepare('SELECT registered_at FROM registrations').get().registered_at;
  t.setNow('2026-07-10T19:00:00Z');
  await t.post('/register', {}, t.cast);
  assert.equal(registered(t), 1);
  assert.equal(t.db.prepare('SELECT registered_at FROM registrations').get().registered_at, first);
  t.close();
});

test('register is refused on a non-show day, using the configured timezone', async () => {
  const t = await seeded();
  t.setNow('2026-07-11T12:00:00Z');
  assert.match(await (await t.post('/register', {}, t.cast)).text(), /no show today/i);
  // 23:30 UTC on the 10th is 00:30 BST on the 11th: not a show day in Europe/London
  t.setNow('2026-07-10T23:30:00Z');
  await t.post('/register', {}, t.cast);
  assert.equal(registered(t), 0);
  t.close();
});

test('allow-list: not on the cast list gets a clear message; username match is case-insensitive', async () => {
  const t = await seeded();
  const stranger = t.cookieFor({ username: 'zzz999', role: 'cast' });
  const r = await t.post('/register', {}, stranger);
  assert.equal(r.status, 403);
  assert.match(await r.text(), /not on the cast list/i);
  assert.equal(registered(t), 0);
  // cast list has TWJK20 imported in upper case; header identity in mixed case still matches
  const x = await setup({ env: { TRUST_X_USER_HEADER: 'true' } });
  await x.post('/marshal/import/cast', { csv: CAST_CSV }, x.marshal);
  await x.post('/marshal/import/shows', { csv: 'date\n2026-07-10\n' }, x.marshal);
  await x.req('/register', { method: 'POST', headers: { 'x-user': 'TwJk20' } });
  assert.equal(registered(x), 1);
  t.close(); x.close();
});

test('X-User header is ignored unless enabled', async () => {
  const t = await seeded();
  await t.req('/register', { method: 'POST', headers: { 'x-user': 'twjk20' } });
  assert.equal(registered(t), 0);
  t.close();
});

test('a marshal session wins over X-User; a malformed cookie is just anonymous', async () => {
  const x = await setup({ env: { TRUST_X_USER_HEADER: 'true' } });
  assert.equal((await x.req('/marshal', { cookie: x.marshal, headers: { 'x-user': 'twjk20' } })).status, 200);
  assert.notEqual((await x.req('/', { cookie: 'session=%' })).status, 500);
  x.close();
});

test('dev mode is refused when NODE_ENV=production', () => {
  const env = { SESSION_SECRET: 'x'.repeat(20), PUBLIC_URL: 'https://r.test', DEV_MODE: 'true' };
  assert.throws(() => loadConfig({ ...env, NODE_ENV: 'production' }), /DEV_MODE/);
  assert.doesNotThrow(() => loadConfig({ ...env, NODE_ENV: 'development' }));
  assert.equal(loadConfig({ ...env, NODE_ENV: 'development' }).ldap.enabled, false); // dev: skipped unless LDAP_URL set
  const prod = loadConfig({ ...env, DEV_MODE: '', NODE_ENV: 'production' }).ldap;
  assert.deepEqual([prod.enabled, prod.url, prod.baseDn, prod.userAttribute], [true, 'ldap://ldap.bath.ac.uk', 'o=bath.ac.uk', 'uid']);
});

test('marshal routes need a Keycloak login; cast cannot enter', async () => {
  const t = await seeded();
  assert.equal((await t.req('/marshal')).status, 302);
  assert.equal((await t.req('/marshal', { cookie: t.cast })).status, 403);
  const cb = await t.req('/marshal/callback?state=s1&code=c', { headers: { cookie: `oidc=${encodeURIComponent((await import('../src/session.js')).sign({ state: 's1', verifier: 'v1', exp: Date.now() + 60000 }, t.config.sessionSecret))}` } });
  assert.equal(cb.headers.get('location'), '/marshal');
  assert.match(cb.headers.get('set-cookie'), /session=/);
  t.close();
});

test('marshal can mark present, list unaccounted, export csv', async () => {
  const t = await seeded();
  await t.post('/register', {}, t.cast);
  await t.post('/marshal/mark', { username: 'JL3820' }, t.marshal);
  assert.equal(registered(t), 2);
  const csv = await (await t.req('/marshal/export.csv', { cookie: t.marshal })).text();
  assert.match(csv, /twjk20,.*present/);
  assert.match(csv, /jl3820,.*present,.*marshal,marsh/);
  t.db.prepare('DELETE FROM registrations WHERE username = ?').run('jl3820');
  assert.match(await (await t.req('/marshal/print', { cookie: t.marshal })).text(), /jl3820/);
  t.close();
});

test('CAS: callback sets the session cookie; validator parses success and failure', async () => {
  const t = await seeded();
  const ok = await t.req('/cas/callback?ticket=good');
  assert.match(ok.headers.get('set-cookie'), /session=.*HttpOnly.*Secure/i);
  assert.equal((await t.req('/cas/callback?ticket=bad')).status, 401);
  const xml = (b) => async () => ({ ok: true, text: async () => b });
  const args = { casUrl: 'https://cas.test', service: 'https://r/cb', ticket: 'ST-1' };
  assert.equal(await validateTicket({ ...args, fetchImpl: xml("<cas:serviceResponse xmlns:cas='x'><cas:authenticationSuccess><cas:user>TWJK20</cas:user></cas:authenticationSuccess></cas:serviceResponse>") }), 'twjk20');
  await assert.rejects(validateTicket({ ...args, fetchImpl: xml("<cas:authenticationFailure code='INVALID_TICKET'/>") }));
  t.close();
});

const signIn = async (t) => {
  const r = await t.req('/cas/callback?ticket=good');
  return r.headers.get('set-cookie').split(';')[0];
};

test('sign-in shows the LDAP display name and keeps it in the session (no re-query per page)', async () => {
  let calls = 0;
  const t = await seeded({ ldapLookup: async () => { calls++; return { name: 'Alice From Ldap' }; } });
  const cookie = await signIn(t);
  const home = await (await t.req('/', { cookie })).text();
  assert.match(home, /Alice From Ldap/);
  await t.post('/register', {}, cookie);
  assert.match(await (await t.req('/', { cookie })).text(), /Alice From Ldap[\s\S]*registered|registered[\s\S]*Alice From Ldap/);
  assert.equal(calls, 1);
  t.close();
});

test('sign-in falls back to the cast-list name, then the username, when LDAP fails or has no name', async () => {
  for (const ldapLookup of [async () => { throw new Error('down'); }, async () => ({ name: '' }), async () => null]) {
    const t = await seeded({ ldapLookup });
    const res = await t.req('/', { cookie: await signIn(t) });
    assert.match(await res.text(), /Alice A/); // cast-list name
    t.close();
  }
  const t = await setup({ ldapLookup: async () => { throw new Error('down'); } }); // not imported: username
  assert.match(await (await t.req('/', { cookie: await signIn(t) })).text(), /twjk20/);
  t.close();
});
