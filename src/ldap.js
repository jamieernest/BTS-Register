import { Client, EqualityFilter } from 'ldapts';

// Returns lookup(username) -> {name} | null. Anonymous bind (no bind call); searches the base DN
// for (<userAttribute>=<username>). EqualityFilter escapes the value (no LDAP filter injection).
export function createLdapLookup(cfg) {
  return async (username) => {
    const client = new Client({ url: cfg.url, timeout: 10_000, connectTimeout: 10_000 });
    try {
      const { searchEntries } = await client.search(cfg.baseDn, {
        scope: 'sub',
        filter: new EqualityFilter({ attribute: cfg.userAttribute, value: username }),
        attributes: [cfg.userAttribute, cfg.nameAttribute],
      });
      if (!searchEntries.length) return null;
      const n = searchEntries[0][cfg.nameAttribute];
      return { name: String(Array.isArray(n) ? n[0] : n || '').trim() };
    } finally {
      await client.unbind().catch(() => {});
    }
  };
}
