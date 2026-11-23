# BTS-Register

Cast register for fire evacuation. Cast connect to the venue wifi, log in with university SSO (CAS) and tap **I'm here** on a show day. Fire marshals (anyone who logs in via Keycloak) see who is registered and who is unaccounted for.

Node.js ≥ 22.5 (uses built-in `node:sqlite`), SQLite, Express.

## Run

```sh
npm install
cp .env.example .env   # fill in SESSION_SECRET, PUBLIC_URL, KEYCLOAK_*
npm start
npm test
```

All settings are in `.env.example` with comments. The server refuses to start on invalid config (missing `SESSION_SECRET`/`PUBLIC_URL`, bad `TIMEZONE`, or `DEV_MODE=true` with `NODE_ENV=production`).

## Using it

1. Marshal logs in at `/marshal/login` (Keycloak) and imports CSVs on the marshal page.
2. **Cast list** CSV: columns `username` (required) and `name` (optional). Each username is looked up in LDAP; rows whose user does not exist are rejected, and a blank `name` is filled from LDAP `displayName`. Usernames are stored lower-case.
3. **Show dates** CSV: `date` (`YYYY-MM-DD`), optional `name`, `call_time` (`HH:MM`).
4. Imports are all-or-nothing: any bad row means nothing is written and every row error is listed. Re-importing updates existing rows by username/date, so there are no duplicates. Re-import never deletes anyone.
5. Cast log in at `/`, and only usernames on the cast list can register (others see "not on the cast list"). Registering is only possible on a show date in `TIMEZONE`, checked server-side; a second tap keeps the first timestamp.
6. Marshal page (`/marshal`) shows today's registered and unaccounted-for cast, can mark someone present, print the unaccounted list (`/marshal/print`) and export CSV (`/marshal/export.csv`).

## Authentication

- **Cast: CAS** at `https://auth.bath.ac.uk`. Redirect to `/login?service=<PUBLIC_URL>/cas/callback`; the ticket is validated server-side at `/serviceValidate` (CAS 2.0 XML). I confirmed that `/serviceValidate` and `/p3/serviceValidate` both respond with CAS 2.0 XML for an invalid ticket, but I could not complete a real login, so a successful response has not been seen against the live server. `/serviceValidate` is what the code uses; if success responses turn out to differ, change `src/cas.js`. The session is an HMAC-signed, httpOnly, secure cookie lasting 6 hours.
- **Marshal: Keycloak** OIDC authorization code flow with PKCE (`openid-client`, same env var names as BTS-Dress-Notes: `KEYCLOAK_ISSUER`, `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_CLIENT_SECRET`). Any user who authenticates is a marshal (no group check). In the Keycloak client, add valid redirect URI `<PUBLIC_URL>/marshal/callback`. Logging out clears this app's cookie only, not the Keycloak session.
- **LDAP**: `ldap://ldap.bath.ac.uk`, anonymous bind. Found by an anonymous query: naming contexts `o=bath.ac.uk` (users are `uid=<name>,ou=people,o=bath.ac.uk`) and `dc=maths,dc=bath,dc=ac,dc=uk`; attributes `uid` and `displayName`. All configurable via `LDAP_*`. Used only at cast import. The cast list stays the allow-list for registering.
- **Optional `X-User` header**: set `TRUST_X_USER_HEADER=true` to treat the `X-User` header (e.g. from Traefik forwardAuth `authResponseHeaders`) as the cast identity instead of CAS login, unless a valid session cookie is present (so a Keycloak marshal stays a marshal). Off by default. Only safe when the app is reachable solely through that proxy; marshal access always needs Keycloak.
- **Dev mode**: `DEV_MODE=true` enables `/dev/login?user=twjk20&role=marshal` and skips LDAP unless `LDAP_URL` is set. Startup is refused when `NODE_ENV=production`.

POSTs rely on `SameSite=Lax` cookies for CSRF protection.

## Deployment behind Traefik

The app has no IP logic; only expose it through Traefik with an IP allow-list middleware (dynamic config):

```yaml
http:
  middlewares:
    venue-only:
      ipAllowList:            # Traefik v3 (use ipWhiteList on v2)
        sourceRange:
          - "203.0.113.0/24"  # the venue's public egress IP / range
  routers:
    register:
      rule: Host(`register.example.com`)
      entryPoints: [websecure]
      middlewares: [venue-only]
      service: register
      tls: {}
  services:
    register:
      loadBalancer:
        servers:
          - url: http://127.0.0.1:3000
```

Bind/firewall the app port so that it is not reachable except via Traefik.
