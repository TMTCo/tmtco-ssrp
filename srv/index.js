import { Hono } from "hono";

const app = new Hono();

/**
 * Required env vars (set in Cloudflare Dashboard):
 * TENANT_ID
 * CLIENT_ID
 * CLIENT_SECRET (Secret)
 * BASE_URL (e.g. https://ssrp.directory.themrtechguy.com)
 *
 * Optional:
 * TENANT_HINT_DOMAIN (e.g. directory.themrtechguy.com)
 * BRAND_TITLE
 * SUPPORT_URL
 * GRAPH_CHECKS_ENABLED ("true"/"false")
 *
 * KV binding:
 * SESSIONS
 */

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function htmlPage({ title, body, supportUrl, authed }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="/styles.css"/>
</head>
<body>
  <header class="header">
    <div class="container header-inner">
      <div class="brand">
        <div class="logo">TMTCo</div>
        <div class="brand-text">
          <div class="brand-title">${escapeHtml(title)}</div>
          <div class="brand-sub">Secure self-service password reset</div>
        </div>
      </div>
      <div class="header-actions">
        ${authed ? `<form method="post" action="/logout"><button class="btn btn-ghost" type="submit">Sign out</button></form>` : ``}
        <a class="btn btn-ghost" href="${supportUrl}" target="_blank" rel="noopener">Help</a>
      </div>
    </div>
  </header>

  <main class="container">${body}</main>

  <footer class="footer">
    <div class="container footer-inner">
      <span>© ${new Date().getFullYear()} TMTCo</span>
      <span class="dot">•</span>
      <span>This portal never asks for your password.</span>
    </div>
  </footer>
</body>
</html>`;
}

function randomString() {
  return crypto.randomUUID().replaceAll("-", "");
}

function getCookie(req, name) {
  const c = req.header("Cookie") || "";
  const parts = c.split(";").map((x) => x.trim());
  for (const p of parts) {
    if (p.startsWith(name + "=")) return decodeURIComponent(p.slice(name.length + 1));
  }
  return null;
}

function setCookie(name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (opts.httpOnly) parts.push("HttpOnly");
  if (opts.secure) parts.push("Secure");
  if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
  if (opts.path) parts.push(`Path=${opts.path}`);
  if (opts.maxAge != null) parts.push(`Max-Age=${opts.maxAge}`);
  return parts.join("; ");
}

function mustEnv(env, key) {
  if (!env[key] || String(env[key]).trim() === "") {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

function getTenantHint(env) {
  if (env.TENANT_HINT_DOMAIN?.trim()) return env.TENANT_HINT_DOMAIN.trim();
  return `${env.TENANT_ID}.onmicrosoft.com`;
}

function buildResetUrl(env, loginHint) {
  const whr = encodeURIComponent(getTenantHint(env));
  let url = `https://passwordreset.microsoftonline.com/?whr=${whr}`;
  if (loginHint) url += `&login_hint=${encodeURIComponent(loginHint)}`;
  return url;
}

async function graphMe(accessToken) {
  const r = await fetch(
    "https://graph.microsoft.com/v1.0/me?$select=id,displayName,userPrincipalName,accountEnabled",
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!r.ok) throw new Error(`Graph /me failed: ${r.status} ${await r.text()}`);
  return r.json();
}

async function readSession(env, sid) {
  if (!sid) return null;
  const raw = await env.SESSIONS.get(sid);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

app.get("/", async (c) => {
  const env = c.env;
  const title = env.BRAND_TITLE || "TMTCo Password Reset";
  const supportUrl = env.SUPPORT_URL || "https://directory.themrtechguy.com/help";

  const sid = getCookie(c.req, "tmtco_sspr_sid");
  const session = await readSession(env, sid);

  const body = `
  <div class="card">
    <h1>Password reset</h1>
    <p class="muted">Sign in, then you’ll be sent to Microsoft’s official reset page.</p>

    ${
      session?.username
        ? `<p>Signed in as <strong>${escapeHtml(session.username)}</strong></p>
           <a class="btn btn-primary" href="/account">Continue</a>`
        : `<a class="btn btn-primary" href="/auth/login">Sign in to reset password</a>`
    }

    <div class="notice"><strong>Tip:</strong> If you can’t sign in due to MFA issues, use your normal IT support path.</div>
  </div>`;

  return c.html(htmlPage({ title, body, supportUrl, authed: !!session }));
});

app.get("/auth/login", async (c) => {
  const env = c.env;

  try {
    mustEnv(env, "TENANT_ID");
    mustEnv(env, "CLIENT_ID");
    mustEnv(env, "CLIENT_SECRET");
    mustEnv(env, "BASE_URL");
  } catch (e) {
    return c.text(e?.message || "Missing env vars", 500);
  }

  const state = randomString();
  const nonce = randomString();

  // Save state -> KV (5 minutes)
  await env.SESSIONS.put(`state:${state}`, JSON.stringify({ nonce }), { expirationTtl: 300 });

  const redirectUri = `${env.BASE_URL.replace(/\/$/, "")}/auth/callback`;

  const authorizeUrl = new URL(`https://login.microsoftonline.com/${env.TENANT_ID}/oauth2/v2.0/authorize`);
  authorizeUrl.searchParams.set("client_id", env.CLIENT_ID);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("response_mode", "query");
  authorizeUrl.searchParams.set("scope", "openid profile email User.Read");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("nonce", nonce);
  authorizeUrl.searchParams.set("prompt", "select_account");

  return c.redirect(authorizeUrl.toString());
});

app.get("/auth/callback", async (c) => {
  const env = c.env;

  const code = c.req.query("code");
  const state = c.req.query("state");

  if (!code || !state) return c.text("Missing code/state", 400);

  const stateRaw = await env.SESSIONS.get(`state:${state}`);
  if (!stateRaw) return c.text("Invalid or expired state. Try again.", 400);

  const redirectUri = `${env.BASE_URL.replace(/\/$/, "")}/auth/callback`;

  const tokenUrl = `https://login.microsoftonline.com/${env.TENANT_ID}/oauth2/v2.0/token`;
  const form = new URLSearchParams();
  form.set("client_id", env.CLIENT_ID);
  form.set("client_secret", env.CLIENT_SECRET);
  form.set("grant_type", "authorization_code");
  form.set("code", code);
  form.set("redirect_uri", redirectUri);
  form.set("scope", "openid profile email User.Read");

  const r = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });

  if (!r.ok) return c.text(`Token exchange failed: ${r.status} ${await r.text()}`, 500);

  const tok = await r.json();

  // Parse id_token payload to get username hint (not used for security decisions).
  // For strict validation, add JWKS signature verification.
  let username = "user";
  try {
    const idToken = tok.id_token || "";
    const payloadB64 = idToken.split(".")[1] || "";
    const payloadJson = atob(payloadB64.replaceAll("-", "+").replaceAll("_", "/"));
    const payload = JSON.parse(payloadJson);
    username = payload.preferred_username || payload.upn || payload.email || "user";
  } catch {
    // ignore
  }

  const sid = randomString();

  await env.SESSIONS.put(
    sid,
    JSON.stringify({
      username,
      access_token: tok.access_token,
    }),
    { expirationTtl: 1200 } // 20 minutes
  );

  const secure = String(env.BASE_URL || "").startsWith("https://");

  c.header(
    "Set-Cookie",
    setCookie("tmtco_sspr_sid", sid, {
      httpOnly: true,
      secure,
      sameSite: "Lax",
      path: "/",
      maxAge: 1200,
    })
  );

  return c.redirect("/account");
});

app.get("/account", async (c) => {
  const env = c.env;
  const title = env.BRAND_TITLE || "TMTCo Password Reset";
  const supportUrl = env.SUPPORT_URL || "https://directory.themrtechguy.com/help";

  const sid = getCookie(c.req, "tmtco_sspr_sid");
  const session = await readSession(env, sid);

  if (!session?.username) return c.redirect("/");

  const resetUrl = buildResetUrl(env, session.username);

  let me = null;
  let graphError = null;
  if (String(env.GRAPH_CHECKS_ENABLED || "true").toLowerCase() === "true") {
    try {
      me = await graphMe(session.access_token);
    } catch (e) {
      graphError = e?.message || String(e);
    }
  }

  const body = `
  <div class="card">
    <h1>Confirm & reset</h1>
    <p class="muted">You are signed in as <strong>${escapeHtml(session.username)}</strong>.</p>

    ${
      graphError
        ? `<div class="alert alert-warn"><strong>Note:</strong> Graph check failed.<br/><span class="small">${escapeHtml(
            graphError
          )}</span></div>`
        : ""
    }

    ${
      me
        ? `<div class="kv">
            <div><span class="k">Display name</span><span class="v">${escapeHtml(me.displayName)}</span></div>
            <div><span class="k">UPN</span><span class="v">${escapeHtml(me.userPrincipalName)}</span></div>
            <div><span class="k">Account enabled</span><span class="v">${escapeHtml(me.accountEnabled)}</span></div>
          </div>`
        : ""
    }

    <form method="post" action="/go-reset">
      <button class="btn btn-primary" type="submit">Go to Microsoft reset</button>
    </form>

    <p class="small muted" style="margin-top:12px;">Destination: <span class="mono">${escapeHtml(resetUrl)}</span></p>
  </div>`;

  return c.html(htmlPage({ title, body, supportUrl, authed: true }));
});

app.post("/go-reset", async (c) => {
  const env = c.env;
  const sid = getCookie(c.req, "tmtco_sspr_sid");
  const session = await readSession(env, sid);
  if (!session?.username) return c.redirect("/");
  return c.redirect(buildResetUrl(env, session.username));
});

app.post("/logout", async (c) => {
  const env = c.env;
  const sid = getCookie(c.req, "tmtco_sspr_sid");
  if (sid) await env.SESSIONS.delete(sid);

  const secure = String(env.BASE_URL || "").startsWith("https://");

  c.header(
    "Set-Cookie",
    setCookie("tmtco_sspr_sid", "", {
      httpOnly: true,
      secure,
      sameSite: "Lax",
      path: "/",
      maxAge: 0,
    })
  );

  return c.redirect("/");
});

export default app;
