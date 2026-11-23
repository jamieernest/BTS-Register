import express from 'express';
import { sign, verify, readCookie } from './session.js';
import { casLoginUrl, validateTicket } from './cas.js';
import { importCast, importShows, csvCell } from './csv.js';
import { todayIn } from './db.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const USER_RE = /^[a-z0-9._-]{1,64}$/i; // sanity bound for header/claim values only; the cast list is the real allow-list

const page = (title, body, user) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<link rel="stylesheet" href="/style.css"></head><body><main>
${user ? `<form method="post" action="/logout" class="top">${esc(user.name || user.username)} <button class="link">Log out</button></form>` : ''}
${body}</main><script src="/page.js"></script></body></html>`;

/**
 * deps: { config, db, ldapLookup|null, cas: {validate(service, ticket)}, oidc: {begin(), finish(url, pending)}, now() }
 * All network-facing deps are injected so tests need no real CAS/Keycloak/LDAP.
 */
export function createApp({ config, db, ldapLookup = null, cas, oidc, now = () => new Date() }) {
  cas ??= { validate: (service, ticket) => validateTicket({ casUrl: config.casUrl, service, ticket }) };
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
    next();
  });
  app.use(express.static(new URL('../public', import.meta.url).pathname, { setHeaders: (r) => r.set('Cache-Control', 'no-cache') }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  const setCookie = (res, name, payload, maxAgeMs, path = '/') =>
    res.cookie(name, sign({ ...payload, exp: now().getTime() + maxAgeMs }, config.sessionSecret), {
      httpOnly: true, secure: config.cookieSecure, sameSite: 'lax', maxAge: maxAgeMs, path,
    });
  const startSession = (res, user) => setCookie(res, 'session', user, config.sessionHours * 3600_000);

  // Identity: signed session cookie (so a Keycloak marshal stays a marshal) > optional X-User header (Traefik forwardAuth, opt-in).
  app.use((req, res, next) => {
    req.user = null;
    const s = verify(readCookie(req, 'session'), config.sessionSecret, now().getTime());
    if (s) req.user = { username: s.username, name: s.name, role: s.role };
    else if (config.trustXUser) {
      const h = req.get('x-user');
      if (h && USER_RE.test(h.trim())) req.user = { username: h.trim().toLowerCase(), role: 'cast' };
    }
    next();
  });

  const today = () => todayIn(config.timezone, now());
  const showOn = (date) => db.prepare('SELECT * FROM shows WHERE date = ?').get(date);
  const castMember = (u) => db.prepare('SELECT * FROM cast_members WHERE username = ?').get(u);
  const regOf = (date, u) => db.prepare('SELECT * FROM registrations WHERE show_date = ? AND username = ?').get(date, u);
  const fmtTime = (iso) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: config.timezone, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const showLabel = (d, s) => `${esc(s?.name || 'Show')} &middot; ${esc(d)}${s?.call_time ? ` &middot; call ${esc(s.call_time)}` : ''}`;

  // ---------- auth routes ----------
  app.get('/login', (req, res) => res.redirect(casLoginUrl(config.casUrl, `${config.publicUrl}/cas/callback`)));

  app.get('/cas/callback', async (req, res) => {
    const ticket = typeof req.query.ticket === 'string' ? req.query.ticket : '';
    if (!ticket) return res.redirect('/login');
    try {
      const username = await cas.validate(`${config.publicUrl}/cas/callback`, ticket);
      startSession(res, { username, name: castMember(username)?.name || username, role: 'cast' });
      res.redirect('/');
    } catch (e) {
      console.error('CAS login failed:', e.message);
      res.status(401).send(page('Login failed', '<h1>Login failed</h1><p>The university login could not be verified.</p><p><a class="btn" href="/login">Try again</a></p>'));
    }
  });

  app.get('/marshal/login', async (req, res) => {
    try {
      const { url, state, verifier } = await oidc.begin();
      setCookie(res, 'oidc', { state, verifier }, 10 * 60_000, '/marshal/callback');
      res.redirect(url);
    } catch (e) {
      console.error('Keycloak begin failed:', e.message);
      res.status(503).send(page('Marshal login unavailable', '<h1>Marshal login unavailable</h1><p>Keycloak is not configured or not reachable.</p>'));
    }
  });

  app.get('/marshal/callback', async (req, res) => {
    const pending = verify(readCookie(req, 'oidc'), config.sessionSecret, now().getTime());
    res.clearCookie('oidc', { path: '/marshal/callback' });
    if (!pending) return res.redirect('/marshal/login');
    try {
      const id = await oidc.finish(`${config.publicUrl}${req.originalUrl}`, pending);
      startSession(res, { username: id.username, name: id.name, role: 'marshal' }); // any Keycloak user is a marshal
      res.redirect('/marshal');
    } catch (e) {
      console.error('Keycloak callback failed:', e.message);
      res.status(401).send(page('Login failed', '<h1>Login failed</h1><p><a class="btn" href="/marshal/login">Try again</a></p>'));
    }
  });

  app.post('/logout', (req, res) => {
    res.clearCookie('session', { path: '/' });
    res.redirect('/');
  });

  if (config.devMode) {
    // Local use only; config.js refuses DEV_MODE with NODE_ENV=production.
    app.get('/dev/login', (req, res) => {
      const username = String(req.query.user || 'dev1').toLowerCase();
      if (!USER_RE.test(username)) return res.status(400).send('bad user');
      startSession(res, { username, name: `Dev ${username}`, role: req.query.role === 'marshal' ? 'marshal' : 'cast' });
      res.redirect(req.query.role === 'marshal' ? '/marshal' : '/');
    });
  }

  // ---------- cast ----------
  const castHome = (user, notice = '') => {
    const date = today();
    const show = showOn(date);
    const member = castMember(user.username);
    if (!member) {
      return [403, page('Not on the cast list', `<h1>Not on the cast list</h1><p><strong>${esc(user.username)}</strong> is not on the cast list for this show. Please see a fire marshal.</p>`, user)];
    }
    if (!show) {
      return [200, page('No show today', `<h1>Hello ${esc(member.name)}</h1><p>There is no show today (${esc(date)}), so there is nothing to register for.</p>`, user)];
    }
    const reg = regOf(date, member.username);
    const body = reg
      ? `<div class="ok"><h1>You're registered</h1><p>${esc(member.name)}, recorded at <strong>${esc(fmtTime(reg.registered_at))}</strong>.</p></div>`
      : `<h1>Hello ${esc(member.name)}</h1><p>${showLabel(date, show)}</p><form method="post" action="/register"><button class="big">I'm here</button></form>`;
    return [200, page('Register', `${notice}${body}`, user)];
  };

  app.get('/', (req, res) => {
    if (!req.user) {
      return res.send(page('Cast register', '<h1>Cast register</h1><p>Log in with your university account to register that you are here.</p><p><a class="btn" href="/login">Log in with university login</a></p><p class="small"><a href="/marshal/login">Fire marshal login</a></p>'));
    }
    if (req.user.role === 'marshal') return res.redirect('/marshal');
    const [status, html] = castHome(req.user);
    res.status(status).send(html);
  });

  app.post('/register', (req, res) => {
    if (!req.user || req.user.role !== 'cast') return res.redirect('/');
    const date = today();
    if (castMember(req.user.username) && showOn(date)) {
      // Idempotent: a second tap keeps the original timestamp.
      db.prepare('INSERT OR IGNORE INTO registrations (show_date, username, registered_at, method) VALUES (?, ?, ?, ?)')
        .run(date, req.user.username, now().toISOString(), 'self');
    }
    const [status, html] = castHome(req.user);
    res.status(status).send(html);
  });

  // ---------- marshal ----------
  const marshalOnly = (req, res, next) => {
    if (!req.user) return res.redirect('/marshal/login');
    if (req.user.role !== 'marshal') return res.status(403).send(page('Marshals only', '<h1>Marshals only</h1><p>Fire marshals log in via the marshal login.</p>', req.user));
    next();
  };

  const roll = (date) => {
    const present = db.prepare(`SELECT c.username, c.name, r.registered_at, r.method, r.marked_by FROM registrations r
      JOIN cast_members c ON c.username = r.username WHERE r.show_date = ? ORDER BY c.name`).all(date);
    const missing = db.prepare(`SELECT username, name FROM cast_members
      WHERE username NOT IN (SELECT username FROM registrations WHERE show_date = ?) ORDER BY name`).all(date);
    return { present, missing };
  };

  const importForm = (kind, label, hint) => `<form method="post" action="/marshal/import/${kind}"><h3>${label}</h3><p class="small">${hint}</p>
    <input type="file" accept=".csv,text/csv" data-fill="${kind}-csv"><textarea id="${kind}-csv" name="csv" rows="4" required></textarea><button>Import</button></form>`;

  app.get('/marshal', marshalOnly, (req, res) => {
    const date = today();
    const show = showOn(date);
    let live = `<p>No show is scheduled for today (${esc(date)}).</p>`;
    if (show) {
      const { present, missing } = roll(date);
      live = `<p>${showLabel(date, show)}</p><p class="count"><strong>${present.length}</strong> registered &middot; <strong>${missing.length}</strong> unaccounted for</p>
        <p><a class="btn" href="/marshal/print" target="_blank">Printable unaccounted list</a> <a class="btn" href="/marshal/export.csv">Export CSV</a></p>
        <h2>Unaccounted for</h2>${missing.length ? `<table>${missing.map((m) => `<tr><td>${esc(m.name)}</td><td>${esc(m.username)}</td>
          <td><form method="post" action="/marshal/mark"><input type="hidden" name="username" value="${esc(m.username)}"><button>Mark present</button></form></td></tr>`).join('')}</table>` : '<p>Everyone is accounted for.</p>'}
        <h2>Registered</h2>${present.length ? `<table>${present.map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(p.username)}</td>
          <td>${esc(fmtTime(p.registered_at))}${p.method === 'marshal' ? ` (marked by ${esc(p.marked_by)})` : ''}</td></tr>`).join('')}</table>` : '<p>Nobody yet.</p>'}`;
    }
    const counts = `${db.prepare('SELECT COUNT(*) n FROM cast_members').get().n} cast, ${db.prepare('SELECT COUNT(*) n FROM shows').get().n} show dates loaded`;
    res.send(page('Fire marshal', `<h1>Fire marshal view</h1>${live}<h2>Import</h2><p class="small">${counts}</p>
      ${importForm('cast', 'Cast list', 'CSV columns: <code>username</code> (required), <code>name</code> (optional: taken from LDAP if blank). Usernames are checked against LDAP.')}
      ${importForm('shows', 'Show dates', 'CSV columns: <code>date</code> (YYYY-MM-DD), optional <code>name</code>, <code>call_time</code> (HH:MM).')}`, req.user));
  });

  const importResult = (res, r, what) => res.status(r.ok ? 200 : 422).send(page('Import', r.ok
    ? `<h1>${what} imported</h1><p>${r.added} added, ${r.updated} updated.</p><p><a class="btn" href="/marshal">Back</a></p>`
    : `<h1>${what} not imported</h1><p>Nothing was changed. Fix these and try again:</p><ul>${r.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul><p><a class="btn" href="/marshal">Back</a></p>`));

  app.post('/marshal/import/cast', marshalOnly, async (req, res) => {
    importResult(res, await importCast(db, req.body.csv, ldapLookup), 'Cast list');
  });
  app.post('/marshal/import/shows', marshalOnly, (req, res) => {
    importResult(res, importShows(db, req.body.csv), 'Show dates');
  });

  app.post('/marshal/mark', marshalOnly, (req, res) => {
    const date = today();
    const u = String(req.body.username || '').toLowerCase();
    if (!showOn(date)) return res.status(409).send(page('No show today', '<h1>No show today</h1><p><a class="btn" href="/marshal">Back</a></p>', req.user));
    if (!castMember(u)) return res.status(404).send(page('Unknown', '<h1>Not on the cast list</h1><p><a class="btn" href="/marshal">Back</a></p>', req.user));
    db.prepare('INSERT OR IGNORE INTO registrations (show_date, username, registered_at, method, marked_by) VALUES (?, ?, ?, ?, ?)')
      .run(date, u, now().toISOString(), 'marshal', req.user.username);
    res.redirect('/marshal');
  });

  app.get('/marshal/print', marshalOnly, (req, res) => {
    const date = today();
    const show = showOn(date);
    const { missing } = roll(date);
    res.send(page('Unaccounted for', `<h1>Unaccounted for</h1><p>${showLabel(date, show)} &middot; printed ${esc(fmtTime(now().toISOString()))}</p>
      ${show ? `<table class="print">${missing.map((m) => `<tr><td class="box"></td><td>${esc(m.name)}</td><td>${esc(m.username)}</td></tr>`).join('')}</table>` : '<p>No show today.</p>'}
      <p class="noprint"><button data-print>Print</button></p>`));
  });

  app.get('/marshal/export.csv', marshalOnly, (req, res) => {
    const date = today();
    const { present, missing } = roll(date);
    const lines = ['show_date,username,name,status,registered_at,method,marked_by',
      ...present.map((p) => [date, p.username, p.name, 'present', p.registered_at, p.method, p.marked_by].map(csvCell).join(',')),
      ...missing.map((m) => [date, m.username, m.name, 'unaccounted', '', '', ''].map(csvCell).join(','))];
    res.type('text/csv').set('Content-Disposition', `attachment; filename="register-${date}.csv"`).send(lines.join('\r\n') + '\r\n');
  });

  return app;
}
