// Reads and validates configuration. Throws on anything unsafe so the server refuses to start.
const bool = (v) => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').toLowerCase());

export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  const devMode = bool(env.DEV_MODE);
  if (devMode && nodeEnv === 'production') {
    throw new Error('DEV_MODE must not be enabled when NODE_ENV=production');
  }
  const sessionSecret = env.SESSION_SECRET || '';
  if (sessionSecret.length < 16) throw new Error('SESSION_SECRET is required (at least 16 characters)');
  const publicUrl = (env.PUBLIC_URL || '').replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]+/.test(publicUrl)) throw new Error('PUBLIC_URL is required, e.g. https://register.example.com');
  const timezone = env.TIMEZONE || 'Europe/London';
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone });
  } catch {
    throw new Error(`TIMEZONE "${timezone}" is not a valid IANA time zone`);
  }
  // Anonymous bind (ldap.bath.ac.uk needs no credentials). Outside dev mode the lookup is always on;
  // in dev mode it is skipped unless LDAP_URL is set.
  const ldap = {
    enabled: !devMode || Boolean(env.LDAP_URL),
    url: env.LDAP_URL || 'ldap://ldap.bath.ac.uk',
    baseDn: env.LDAP_BASE_DN || 'o=bath.ac.uk',
    userAttribute: env.LDAP_USER_ATTRIBUTE || 'uid',
    nameAttribute: env.LDAP_NAME_ATTRIBUTE || 'displayName',
  };
  return {
    ldap,
    nodeEnv,
    devMode,
    port: Number(env.PORT) || 3000,
    dbPath: env.DB_PATH || './data/register.db',
    publicUrl,
    timezone,
    sessionSecret,
    sessionHours: 6,
    cookieSecure: env.COOKIE_SECURE !== 'false',
    casUrl: (env.CAS_URL || 'https://auth.bath.ac.uk').replace(/\/+$/, ''),
    trustXUser: bool(env.TRUST_X_USER_HEADER),
    keycloak: {
      issuer: env.KEYCLOAK_ISSUER || '',
      clientId: env.KEYCLOAK_CLIENT_ID || '',
      clientSecret: env.KEYCLOAK_CLIENT_SECRET || '',
    },
  };
}
