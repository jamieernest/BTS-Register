import { loadConfig } from './src/config.js';
import { openDb } from './src/db.js';
import { createApp } from './src/app.js';
import { createOidc } from './src/oidc.js';
import { createLdapLookup } from './src/ldap.js';

let config;
try {
  config = loadConfig();
} catch (e) {
  console.error(`Refusing to start: ${e.message}`);
  process.exit(1);
}
const app = createApp({
  config,
  db: openDb(config.dbPath),
  ldapLookup: config.ldap.enabled ? createLdapLookup(config.ldap) : null,
  oidc: createOidc(config.keycloak, `${config.publicUrl}/marshal/callback`),
});
app.listen(config.port, () => console.log(`BTS-Register listening on :${config.port}${config.devMode ? ' (DEV MODE)' : ''}`));
