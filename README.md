# TMTCo Custom SSPR Portal (Cloudflare Workers)

This is a **Cloudflare Workers + KV** version of the custom SSPR portal:
- Signs users in with Microsoft Entra ID (OAuth2)
- Optionally calls Microsoft Graph `/me`
- Redirects users to Microsoft's official password reset page (no passwords collected here)

## Deploy from Cloudflare Dashboard (no CLI required)

1) Push this repo to a **private GitHub repo** (do NOT commit real secrets).
2) Cloudflare Dashboard → **Workers & Pages** → **Create application** → **Workers**.
3) **Connect to GitHub** → select repo/branch → Framework preset: None → Deploy.
4) Cloudflare Dashboard → **Storage & Databases** → **KV** → Create namespace: `SSPR_SESSIONS`.
5) Worker → **Settings** → **Variables**:
   - KV bindings: bind `SESSIONS` to `SSPR_SESSIONS`
   - Secrets: `CLIENT_SECRET`
   - Vars (plain text):
     - `TENANT_ID`
     - `CLIENT_ID`
     - `BASE_URL` (e.g. https://ssrp.directory.themrtechguy.com)
     - `TENANT_HINT_DOMAIN` (optional)
     - `BRAND_TITLE` (optional)
     - `SUPPORT_URL` (optional)
     - `GRAPH_CHECKS_ENABLED` (optional "true"/"false")
6) Worker → **Settings** → **Triggers** → **Custom Domains** → add `ssrp.directory.themrtechguy.com`
7) Entra Admin Center → App Registration → **Authentication** → add Redirect URI:
   - `https://ssrp.directory.themrtechguy.com/auth/callback`

## Notes
- This worker stores a short-lived session in KV (20 min).
- The session cookie is HttpOnly + SameSite=Lax.
- For stricter security, you can add full `id_token` signature validation (JWKS).
