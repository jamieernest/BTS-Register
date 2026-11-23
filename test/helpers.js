import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { after } from 'node:test';
import { sign } from '../src/session.js';

export const baseEnv = {
  SESSION_SECRET: 'test-secret-test-secret', PUBLIC_URL: 'https://reg.test', DEV_MODE: 'true', TIMEZONE: 'Europe/London',
};

export const CAST_CSV = 'name,username\nAlice A,TWJK20\nBob B,jl3820\n';

// Fake LDAP: knows twjk20 and jl3820 only.
export const fakeLdap = async (u) => ({ twjk20: { name: 'Alice Ldap' }, jl3820: { name: 'Bob Ldap' } }[u] ?? null);

export async function setup({ env = {}, clock = '2026-07-10T18:00:00Z', ...deps } = {}) {
  const config = loadConfig({ ...baseEnv, ...env });
  const db = openDb(':memory:');
  let now = new Date(clock);
  const app = createApp({
    config, db, ldapLookup: fakeLdap, now: () => now,
    cas: { validate: async (service, ticket) => { if (ticket !== 'good') throw new Error('bad'); return 'TWJK20'.toLowerCase(); } },
    oidc: {
      begin: async () => ({ url: 'https://kc.test/auth', state: 's1', verifier: 'v1' }),
      finish: async (url, p) => { if (p.state !== 's1') throw new Error('state'); return { username: 'marsh', name: 'Mar Shal' }; },
    },
    ...deps,
  });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  after(() => { server.close(); server.closeAllConnections(); }); // also runs when a test fails
  const url = `http://127.0.0.1:${server.address().port}`;
  const cookieFor = (user) => `session=${encodeURIComponent(sign({ ...user, exp: now.getTime() + 30 * 86400_000 }, config.sessionSecret))}`;
  const req = (path, { cookie, headers, ...o } = {}) => fetch(url + path, { redirect: 'manual', headers: { ...(cookie && { cookie }), ...headers }, ...o });
  const post = (path, body, cookie) => req(path, { method: 'POST', cookie, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
  return { config, db, url, req, post, cookieFor, setNow: (d) => { now = new Date(d); }, close: () => { server.close(); server.closeAllConnections(); }, cast: cookieFor({ username: 'twjk20', role: 'cast' }), marshal: cookieFor({ username: 'marsh', name: 'Mar Shal', role: 'marshal' }) };
}
