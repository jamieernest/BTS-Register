// CAS 2.0 against auth.bath.ac.uk. Both /serviceValidate and /p3/serviceValidate answer with
// CAS 2.0 XML; we use /serviceValidate (no attributes needed, the username is enough).
export const casLoginUrl = (casUrl, service) => `${casUrl}/login?service=${encodeURIComponent(service)}`;

// Returns the lower-cased CAS username, or throws. `fetchImpl` is injectable for tests.
export async function validateTicket({ casUrl, service, ticket, fetchImpl = fetch }) {
  const url = `${casUrl}/serviceValidate?service=${encodeURIComponent(service)}&ticket=${encodeURIComponent(ticket)}`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`CAS validate returned HTTP ${res.status}`);
  const xml = await res.text();
  if (!/<cas:authenticationSuccess[\s>]/.test(xml)) throw new Error('CAS rejected the ticket');
  const m = xml.match(/<cas:user>\s*([^<\s]+)\s*<\/cas:user>/);
  if (!m) throw new Error('CAS response had no user');
  return m[1].toLowerCase();
}
