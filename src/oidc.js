import * as client from 'openid-client';

// Keycloak authorization-code flow with PKCE (same pattern/env names as BTS-Dress-Notes).
// Returned object is what app.js expects: begin() -> {url, state, verifier}; finish(url, {state, verifier}) -> {username, name}.
export function createOidc({ issuer, clientId, clientSecret }, redirectUri) {
  let config;
  const get = async () => (config ??= await client.discovery(new URL(issuer), clientId, clientSecret));
  return {
    async begin() {
      const c = await get();
      const verifier = client.randomPKCECodeVerifier();
      const state = client.randomState();
      const url = client.buildAuthorizationUrl(c, {
        redirect_uri: redirectUri,
        scope: 'openid profile',
        code_challenge: await client.calculatePKCECodeChallenge(verifier),
        code_challenge_method: 'S256',
        state,
      });
      return { url: url.href, state, verifier };
    },
    async finish(currentUrl, { state, verifier }) {
      const c = await get();
      const tokens = await client.authorizationCodeGrant(c, new URL(currentUrl), { pkceCodeVerifier: verifier, expectedState: state });
      const claims = tokens.claims();
      if (!claims?.sub) throw new Error('Keycloak returned no identity claims');
      return { username: (claims.preferred_username || claims.sub).toLowerCase(), name: claims.name || claims.preferred_username || claims.sub };
    },
  };
}
