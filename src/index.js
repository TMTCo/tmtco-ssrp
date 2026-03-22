import { Hono } from "hono";

const app = new Hono();

// Primary (your on-prem SSRP)
const SSRP_URL = "https://tmtco-dc.directory.themrtechguy.com";

// Fallback (Microsoft SSPR)
const MS_RESET_URL = "https://passwordreset.microsoftonline.com";

async function isServerUp(url) {
  try {
    const res = await fetch(url, {
      method: "HEAD",
      cf: { cacheTtl: 0 } // don't cache health check
    });
    return res.ok;
  } catch {
    return false;
  }
}

app.get("*", async (c) => {
  const reqUrl = new URL(c.req.url);
  const query = reqUrl.search;

  // Check if SSRP is reachable
  const up = await isServerUp(SSRP_URL);

  if (up) {
    return c.redirect(`${SSRP_URL}${query}`, 302);
  }

  // Fallback to Microsoft if SSRP is down
  return c.redirect(`${MS_RESET_URL}${query}`, 302);
});

// Handle POST just in case
app.post("*", async (c) => {
  const up = await isServerUp(SSRP_URL);

  if (up) {
    return c.redirect(SSRP_URL, 302);
  }

  return c.redirect(MS_RESET_URL, 302);
});

export default app;
