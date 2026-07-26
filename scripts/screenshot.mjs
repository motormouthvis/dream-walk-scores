#!/usr/bin/env node
/**
 * Capture the public surfaces for visual review.
 *
 * Used to check the UI during development and to attach evidence to a pull request. Also
 * exercises the widget against a synthetic partner page, which is the only way to catch
 * the embed breaking — nothing else loads `embed.js` the way a real listing site does.
 *
 *   node scripts/screenshot.mjs [baseUrl] [outputDir]
 */

import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const BASE = (process.argv[2] ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const OUT = process.argv[3] ?? "/tmp/dws-screenshots";
const CHROME = process.env.CHROME_PATH ?? "/usr/bin/google-chrome-stable";

const DESKTOP = { width: 1280, height: 1000, deviceScaleFactor: 2 };
const MOBILE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true };

/** A stand-in for a realtor's listing page, so the SDK has something real to scrape. */
const PARTNER_PAGE = `<!doctype html>
<html><head>
<meta charset="utf-8">
<title>1500 N 23rd St, Fort Pierce, FL 34950 | Dream Neighborhood Realty</title>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"SingleFamilyResidence",
 "address":{"@type":"PostalAddress","streetAddress":"1500 N 23rd St",
 "addressLocality":"Fort Pierce","addressRegion":"FL","postalCode":"34950"}}
</script>
<style>
  body{font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;color:#111}
  .wrap{max-width:760px;margin:0 auto;padding:40px 24px}
  .hero{height:200px;background:linear-gradient(135deg,#1fa55f,#17804a);border-radius:12px}
  h1{font-size:28px;margin:24px 0 4px}
  .addr{color:#666;margin:0 0 24px}
  .price{font-size:24px;font-weight:700;color:#1fa55f}
  #dream-walk-scores{margin-top:32px;border-top:1px solid #eee;padding-top:24px}
</style>
</head><body><div class="wrap">
  <div class="hero"></div>
  <h1>3 bed · 2 bath · 1,840 sq ft</h1>
  <p class="addr">1500 N 23rd St, Fort Pierce, FL 34950</p>
  <p class="price">$389,000</p>
  <p>A stand-in listing page used to verify the embeddable widget end to end.</p>
  <div id="dream-walk-scores"></div>
</div>
<script src="${BASE}/embed.js" async></script>
</body></html>`;

/** Serve the synthetic listing page so the widget runs against a real HTTP origin. */
function servePartnerPage() {
  return new Promise((resolve) => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(PARTNER_PAGE);
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ port: server.address().port, close: () => server.close() });
    });
  });
}

async function shoot(page, name, { fullPage = true } = {}) {
  const path = join(OUT, `${name}.png`);
  await page.screenshot({ path, fullPage });
  console.log(`  ${path}`);
}

/** Wait for the scores to render rather than sleeping a fixed amount. */
async function waitForScores(page, timeout = 90_000) {
  try {
    await page.waitForFunction(
      () => /Walker's Paradise|Very Walkable|Somewhat Walkable|Car-Dependent|Not rated/.test(document.body.innerText),
      { timeout }
    );
    return true;
  } catch {
    return false;
  }
}

async function main() {
  mkdirSync(OUT, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--font-render-hinting=none"],
  });

  try {
    // --- Home page, before and after a lookup ---------------------------------
    const page = await browser.newPage();
    await page.setViewport(DESKTOP);
    await page.goto(BASE, { waitUntil: "networkidle2", timeout: 60_000 });
    await shoot(page, "01-home");

    await page.type('input[aria-label="Address"]', "1500 N 23rd St, Fort Pierce FL");
    await page.click('button[type="submit"]');
    console.log(`  scores rendered: ${await waitForScores(page)}`);
    await shoot(page, "02-home-scored");

    // --- The expanded breakdown -----------------------------------------------
    const toggle = await page.$('button[aria-expanded="false"]');
    if (toggle) {
      await toggle.click();
      await new Promise((r) => setTimeout(r, 800));
      await shoot(page, "03-breakdown");
    }

    // --- Mobile ----------------------------------------------------------------
    const mobile = await browser.newPage();
    await mobile.setViewport(MOBILE);
    await mobile.goto(`${BASE}/?`, { waitUntil: "networkidle2", timeout: 60_000 });
    await mobile.type('input[aria-label="Address"]', "Times Square, New York NY");
    await mobile.click('button[type="submit"]');
    await waitForScores(mobile);
    await shoot(mobile, "04-mobile");

    // --- The embed iframe on its own -------------------------------------------
    const embed = await browser.newPage();
    await embed.setViewport({ width: 380, height: 620, deviceScaleFactor: 2 });
    await embed.goto(`${BASE}/embed?lat=40.758&lng=-73.9855&header=1&address=Times+Square`, {
      waitUntil: "networkidle2",
      timeout: 60_000,
    });
    await waitForScores(embed);
    await shoot(embed, "05-embed-iframe");

    // --- The widget on a synthetic partner page --------------------------------
    // Served over HTTP rather than from a file:// URL. A `file://` page is not a
    // representative test: it has a null origin, so cross-origin requests and framing
    // behave differently from any real partner site and the widget appears broken for
    // reasons that would never occur in production.
    const partnerFile = join(OUT, "partner.html");
    writeFileSync(partnerFile, PARTNER_PAGE);
    const partnerServer = await servePartnerPage();

    const partner = await browser.newPage();
    await partner.setViewport(DESKTOP);
    const consoleErrors = [];
    partner.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    partner.on("requestfailed", (request) => {
      consoleErrors.push(`request failed: ${request.url()} — ${request.failure()?.errorText}`);
    });

    await partner.goto(`http://127.0.0.1:${partnerServer.port}/`, {
      waitUntil: "networkidle2",
      timeout: 60_000,
    });
    // The SDK scrapes, geocodes, then mounts the iframe — several round trips.
    await new Promise((r) => setTimeout(r, 15_000));

    const mounted = await partner.evaluate(
      () => document.querySelector("#dream-walk-scores iframe") !== null
    );
    const rendered = await partner.evaluate(() => {
      const frame = document.querySelector("#dream-walk-scores iframe");
      return frame ? frame.getBoundingClientRect().height > 100 : false;
    });
    console.log(`  widget mounted on the partner page: ${mounted}, sized: ${rendered}`);
    if (consoleErrors.length > 0) {
      console.log(`  page errors:\n    ${consoleErrors.slice(0, 6).join("\n    ")}`);
    }
    await shoot(partner, "06-partner-inline");
    partnerServer.close();

    // --- Admin dashboard --------------------------------------------------------
    if (process.env.ADMIN_PASSWORD) {
      const admin = await browser.newPage();
      await admin.setViewport(DESKTOP);
      await admin.goto(`${BASE}/admin`, { waitUntil: "networkidle2", timeout: 60_000 });
      await admin.type('input[aria-label="Admin password"]', process.env.ADMIN_PASSWORD);
      await admin.click('button[type="submit"]');
      try {
        // Case-insensitive: the metric labels are uppercased in CSS, so `innerText`
        // reports them that way.
        await admin.waitForFunction(() => /scores served/i.test(document.body.innerText), {
          timeout: 20_000,
        });
      } catch {
        // Capture the failed state rather than aborting the whole run — the screenshot is
        // what tells you why.
        console.log("  admin did not load; capturing the failure state");
      }
      await shoot(admin, "07-admin");
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
