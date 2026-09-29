// ============================================================
//  Willhaben Wien Finder — Version 17.0
//  Single Model, Mutex Lock, Reduced Logging, Optimized Queries
// ============================================================

// 🔧 Single Model — kein Fallback
const WORKERS_AI_MODEL = "@cf/qwen/qwen3.8-27b";
const JEV_MODEL = "jev-1.13.0";

const TIME_BUDGET_MS = 25000;
const NOTIFICATION_THRESHOLD = 0.7;
const MAX_PAGES_PER_RUN = 5;
const SCRAPE_TIME_LIMIT = 10000;
const WORKER_URL = "https://vienna-housing.lizadferi3.workers.dev";
const CRON_LOCK_TIMEOUT_MS = 300000; // 5 Minuten

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(handleCron(env)); },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Telegram Webhook
    if (url.pathname === "/telegram/webhook" && request.method === "POST") {
      return handleTelegramWebhook(env, request);
    }

    // API Routes
    if (url.pathname === "/api/all-listings") return handleGetAllListings(env);
    if (url.pathname === "/api/stats") return handleGetStats(env);
    if (url.pathname === "/api/logs") return handleGetLogs(env, url);
    if (url.pathname === "/api/ai-status") return handleGetAiStatus(env);
    if (url.pathname === "/api/telegram-users") return handleGetTelegramUsers(env);
    if (url.pathname === "/api/test-telegram") return handleTestTelegram(env);
    if (url.pathname === "/api/set-webhook") return handleSetWebhook(env, url);
    if (url.pathname === "/api/settings" && request.method === "GET") return handleGetSettings(env);
    if (url.pathname === "/api/settings" && request.method === "POST") return handleSaveSettings(env, request);
    if (url.pathname === "/api/force-run") return handleForceRun(env, ctx);
    if (url.pathname === "/api/reset-all") return handleResetAll(env);
    if (url.pathname === "/api/retry-all-failed" && request.method === "POST") return handleRetryAllFailed(env);
    if (url.pathname.startsWith("/api/retry/")) return handleRetry(env, url.pathname.split("/").pop());
    if (url.pathname.startsWith("/api/favorite/")) return handleUpdateStatus(env, url.pathname.split("/").pop(), "favorite");
    if (url.pathname.startsWith("/api/unfavorite/")) return handleUpdateStatus(env, url.pathname.split("/").pop(), "new");
    if (url.pathname.startsWith("/api/archive/")) return handleUpdateStatus(env, url.pathname.split("/").pop(), "archived");
    if (url.pathname.startsWith("/api/unarchive/")) return handleUpdateStatus(env, url.pathname.split("/").pop(), "new");
    if (url.pathname.startsWith("/api/telegram-user/")) {
      const parts = url.pathname.split("/");
      const chatId = parts[3];
      const action = parts[4];
      if (action === "block") return handleBlockUser(env, chatId, true);
      if (action === "unblock") return handleBlockUser(env, chatId, false);
      if (action === "test") return handleTestSingleUser(env, chatId);
    }

    // UI ohne Cache
    const response = await serveUI(env, url);
    const newHeaders = new Headers(response.headers);
    newHeaders.set("Cache-Control", "no-store, no-cache, must-revalidate");
    return new Response(response.body, { status: response.status, headers: newHeaders });
  },
};

// ============================================================
//  Mutex Lock — verhindert überlappende Cron-Runs
// ============================================================
async function acquireCronLock(env) {
  try {
    const row = await env.DB.prepare(
      `SELECT value, updated_at FROM system_state WHERE key = 'cron_running'`
    ).first();

    if (row && row.value === '1') {
      // Prüfen, ob der alte Lock abgelaufen ist
      const updatedAt = row.updated_at ? new Date(row.updated_at + 'Z').getTime() : 0;
      const age = Date.now() - updatedAt;

      if (age < CRON_LOCK_TIMEOUT_MS) {
        console.log(`⏭️ Cron läuft bereits (Alter: ${Math.round(age / 1000)}s) — überspringe`);
        return false;
      }
      console.log(`⚠️ Stale lock (${Math.round(age / 1000)}s) — übernehme`);
    }

    await env.DB.prepare(`
      INSERT INTO system_state (key, value, updated_at) VALUES ('cron_running', '1', datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = datetime('now')
    `).run();

    return true;
  } catch (err) {
    console.error("Lock-Fehler:", err);
    return true; // Im Zweifelsfall fortfahren
  }
}

async function releaseCronLock(env) {
  try {
    await env.DB.prepare(`
      UPDATE system_state SET value = '0', updated_at = datetime('now') WHERE key = 'cron_running'
    `).run();
  } catch (err) { console.error("Unlock-Fehler:", err); }
}

// ============================================================
//  Quota Management
// ============================================================
async function isAiQuotaExhausted(env) {
  try {
    const row = await env.DB.prepare(
      `SELECT value FROM system_state WHERE key = 'ai_quota_exhausted_until'`
    ).first();
    if (!row || !row.value) return false;
    return Date.now() < new Date(row.value).getTime();
  } catch { return false; }
}

async function markAiQuotaExhausted(env) {
  const until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare(`
    INSERT INTO system_state (key, value, updated_at) VALUES ('ai_quota_exhausted_until', ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).bind(until).run();
}

async function clearAiQuotaExhausted(env) {
  await env.DB.prepare(`UPDATE system_state SET value = '', updated_at = datetime('now') WHERE key = 'ai_quota_exhausted_until'`).run();
}

// ============================================================
//  CRON
// ============================================================
async function handleCron(env) {
  const startTime = Date.now();

  // 🔧 Mutex Lock
  const locked = await acquireCronLock(env);
  if (!locked) return;

  console.log("⏰ Cron gestartet:", new Date().toISOString());

  try {
    const settings = await loadSettings(env);

    // ۱. Scraping
    await scrapeWillhabenPages(env);
    console.log(`   ⏱️ Scraping: ${Date.now() - startTime}ms`);

    // ۲. Extraction — nur wenn Quota verfügbar
    const quotaExhausted = await isAiQuotaExhausted(env);
    if (quotaExhausted) {
      console.log("   ⚠️ AI Quota erschöpft — Extraction übersprungen");
    } else if (Date.now() - startTime < TIME_BUDGET_MS - 12000) {
      await runExtractionStage(env, 3);
      console.log(`   ⏱️ Extraction: ${Date.now() - startTime}ms`);
    }

    // ۳. Jev
    await runJevStage(env, settings, 10);
    console.log(`   ⏱️ Jev: ${Date.now() - startTime}ms`);

    // Cleanup — nur alle 10 Minuten (grob: jede 5. Cron bei 2-Min-Intervall)
    const cleanupRow = await env.DB.prepare(
      `SELECT updated_at FROM system_state WHERE key = 'last_cleanup'`
    ).first();
    const lastCleanup = cleanupRow?.updated_at ? new Date(cleanupRow.updated_at + 'Z').getTime() : 0;
    if (Date.now() - lastCleanup > 600000) {
      await env.DB.prepare(`DELETE FROM request_logs WHERE created_at < datetime('now', '-2 days')`).run();
      await env.DB.prepare(`
        INSERT INTO system_state (key, value, updated_at) VALUES ('last_cleanup', '1', datetime('now'))
        ON CONFLICT(key) DO UPDATE SET updated_at = datetime('now')
      `).run();
    }

    console.log(`✅ Cron abgeschlossen in ${Date.now() - startTime}ms`);
  } catch (err) {
    console.error("❌ Cron Fehler:", err);
    await logError(env, "system", "cron", err.toString());
  } finally {
    await releaseCronLock(env);
  }
}

// ============================================================
//  STAGE 1: Scraping
// ============================================================
async function scrapeWillhabenPages(env) {
  const startTime = Date.now();
  let currentPage = 1, scraped = 0, totalNew = 0, totalFound = 0;

  while (scraped < MAX_PAGES_PER_RUN) {
    if (Date.now() - startTime > SCRAPE_TIME_LIMIT) break;

    const pageUrl = buildUrl(env.WILLHABEN_URL, currentPage);
    let html = null, status = 0, error = null;

    try {
      const res = await fetch(pageUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
          "Accept-Language": "de-AT,de;q=0.9",
        },
      });
      status = res.status;
      html = await res.text();
    } catch (err) { error = err.toString(); }

    if (error || !html || status !== 200) {
      await logError(env, "willhaben", pageUrl, error || `HTTP ${status}`);
      break;
    }

    if (html.includes("captcha") || html.includes("Ich bin kein Roboter")) break;

    const links = extractListingLinks(html);
    totalFound += links.length;
    if (links.length === 0) break;

    const added = await saveListingsToDb(env, links);
    totalNew += added;

    const hasNext = html.includes('rel="next"') || html.includes("nächste");
    if (!hasNext) break;

    currentPage++;
    scraped++;
  }
  console.log(`   📊 Scraping: ${totalFound} gefunden, ${totalNew} neu`);
}

function extractListingLinks(html) {
  const listings = [];
  const regex = /<a[^>]+href="(\/iad\/immobilien\/d\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const url = "https://www.willhaben.at" + match[1];
    const codeMatch = url.match(/\/(\d+)\/?$/);
    const code = codeMatch ? codeMatch[1] : url;
    const title = match[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().substring(0, 200);
    if (title.length > 20) listings.push({ code, url, title });
  }
  return listings;
}

async function saveListingsToDb(env, listings) {
  if (listings.length === 0) return 0;
  const codes = listings.map(l => l.code);
  const placeholders = codes.map(() => '?').join(',');

  const { results } = await env.DB.prepare(
    `SELECT willhaben_code FROM listings WHERE willhaben_code IN (${placeholders})`
  ).bind(...codes).all();

  const existingCodes = new Set(results.map(r => r.willhaben_code));
  const newListings = listings.filter(l => !existingCodes.has(l.code));
  if (newListings.length === 0) return 0;

  const stmt = env.DB.prepare(`INSERT INTO listings (willhaben_code, url, title) VALUES (?, ?, ?)`);
  const batch = newListings.map(l => stmt.bind(l.code, l.url, l.title));

  try { await env.DB.batch(batch); }
  catch (err) { return 0; }
  return newListings.length;
}

// ============================================================
//  STAGE 2: Workers AI (Single Model)
// ============================================================
async function runExtractionStage(env, limit) {
  const { results } = await env.DB.prepare(`
    SELECT id, url, title FROM listings
    WHERE extraction_done = 0
    ORDER BY scraped_at ASC LIMIT ?
  `).bind(limit).all();

  if (results.length === 0) return;

  for (const listing of results) {
    let html = null, status = 0;

    try {
      const res = await fetch(listing.url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
          "Accept-Language": "de-AT,de;q=0.9",
        },
      });
      status = res.status;
      html = await res.text();
    } catch {}

    if (!html || status !== 200) {
      await env.DB.prepare(`UPDATE listings SET extraction_done = -1 WHERE id = ?`).bind(listing.id).run();
      continue;
    }

    const imageMatch = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i)
                    || html.match(/<meta\s+content="([^"]+)"\s+property="og:image"/i);
    const imageUrl = imageMatch ? imageMatch[1].replace(/&amp;/g, '&') : null;

    const cleanText = cleanHtmlForAI(html);
    const extraction = await callWorkersAI(env, cleanText, listing.title);

    if (!extraction) {
      await env.DB.prepare(`UPDATE listings SET extraction_done = -1, image_url = ? WHERE id = ?`).bind(imageUrl, listing.id).run();
      continue;
    }

    const address = extraction.address || null;
    const sizeM2 = extraction.size_m2 || null;
    const totalCost = extraction.total_monthly_cost_eur || null;

    // Edit-Detection
    if (address && sizeM2) {
      const dup = await env.DB.prepare(`
        SELECT id FROM listings
        WHERE address = ? AND size_m2 = ? AND id != ? AND extraction_done = 1 LIMIT 1
      `).bind(address, sizeM2, listing.id).first();

      if (dup) {
        await env.DB.prepare(`DELETE FROM listings WHERE id = ?`).bind(listing.id).run();
        await env.DB.prepare(`
          UPDATE listings
          SET title = ?, url = ?, willhaben_code = ?,
              extracted_data = ?, image_url = ?, raw_text = ?,
              address = ?, size_m2 = ?, total_cost_eur = ?,
              extraction_done = 1, jev_done = 0, jev_score = 0, jev_result = NULL,
              updated_at = datetime('now')
          WHERE id = ?
        `).bind(
          listing.title, listing.url, listing.willhaben_code || null,
          JSON.stringify(extraction), imageUrl, cleanText,
          address, sizeM2, totalCost, dup.id
        ).run();
        continue;
      }
    }

    await env.DB.prepare(`
      UPDATE listings
      SET extracted_data = ?, extraction_done = 1, image_url = ?, raw_text = ?,
          address = ?, size_m2 = ?, total_cost_eur = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).bind(
      JSON.stringify(extraction), imageUrl, cleanText,
      address, sizeM2, totalCost, listing.id
    ).run();

    await new Promise(r => setTimeout(r, 200));
  }
}

function cleanHtmlForAI(html) {
  let clean = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  clean = clean.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");
  clean = clean.replace(/<!--[\s\S]*?-->/g, " ");
  clean = clean.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return clean.substring(0, 4000);
}

async function callWorkersAI(env, text, title) {
  try {
    const response = await env.AI.run(WORKERS_AI_MODEL, {
      messages: [
        { role: "system", content: "Du bist ein Experte für österreichische Immobilienanzeigen. Antworte AUSSCHLIESSLICH mit einem kompakten JSON-Objekt." },
        { role: "user", content: `Gib ein JSON mit diesen Feldern zurück:
- total_monthly_cost_eur (Zahl oder null)
- cold_rent_eur (Zahl oder null)
- address (string oder null, max 100 Zeichen)
- district (string oder null)
- size_m2 (Zahl oder null)
- rooms (Zahl oder null)
- property_type ("apartment" | "wg_room" | "studio" | "other")
- is_gemeindewohnung (true/false)
- is_genossenschaft (true/false)
- description (string, MAX 300 Zeichen)
- available_from (string oder null)

Titel: ${title}

Anzeige:
${text}` }
      ],
      response_format: { type: "json_object" },
      max_tokens: 700,
      chat_template_kwargs: { enable_thinking: false }
    });

    let content = response?.choices?.[0]?.message?.content || response?.response || response;
    let data;
    if (typeof content === 'string') {
      content = content.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
      try { data = JSON.parse(content); }
      catch (parseErr) {
        let fixed = content;
        const ob = (fixed.match(/{/g) || []).length - (fixed.match(/}/g) || []).length;
        const ok = (fixed.match(/\[/g) || []).length - (fixed.match(/]/g) || []).length;
        if ((fixed.match(/"/g) || []).length % 2 === 1) fixed += '"';
        for (let j = 0; j < ok; j++) fixed += ']';
        for (let j = 0; j < ob; j++) fixed += '}';
        data = JSON.parse(fixed);
      }
    } else { data = content; }

    return {
      total_monthly_cost_eur: data.total_monthly_cost_eur ?? null,
      cold_rent_eur: data.cold_rent_eur ?? null,
      address: data.address ?? null,
      district: data.district ?? null,
      size_m2: data.size_m2 ?? null,
      rooms: data.rooms ?? null,
      property_type: data.property_type || "other",
      is_gemeindewohnung: data.is_gemeindewohnung ?? false,
      is_genossenschaft: data.is_genossenschaft ?? false,
      description: (data.description || "").substring(0, 500),
      available_from: data.available_from ?? null,
    };
  } catch (err) {
    const error = err.toString();

    // Nur Fehler loggen, nicht jeden Versuch
    await logError(env, "workers-ai", WORKERS_AI_MODEL, error);

    // Quota-Handling
    if (error.includes("4006") || error.includes("daily free allocation")) {
      console.log("   🛑 Quota erschöpft — markiere");
      await markAiQuotaExhausted(env);
    }

    return null;
  }
}

// ============================================================
//  STAGE 3: Jev (Single Model)
// ============================================================
async function runJevStage(env, settings, limit) {
  const { results } = await env.DB.prepare(`
    SELECT id, url, title, extracted_data, raw_text FROM listings
    WHERE extraction_done = 1 AND jev_done = 0
    ORDER BY updated_at ASC LIMIT ?
  `).bind(limit).all();

  if (results.length === 0) return;

  for (const listing of results) {
    let extracted = {};
    try { extracted = JSON.parse(listing.extracted_data); } catch {}

    const descLower = (extracted.description || "").toLowerCase();
    const titleLower = (listing.title || "").toLowerCase();
    const rawLower = (listing.raw_text || "").toLowerCase().substring(0, 4000);
    const allText = titleLower + " " + descLower + " " + rawLower;

    const negativeKeywords = [
      "nicht für wohnzwecke", "nicht fuer wohnzwecke",
      "nur als arbeitsraum", "geschäftsraum", "gewerbeobjekt",
      "gewerbeimmobilie", "bürofläche", "bueroflaeche",
      "gemeindewohnung", "gemeindebau", "wiener wohnen",
      "wiener wohnticket", "wohnticket", "bonuspunkte",
      "vormerkschein", "genossenschaftswohnung", "genossenschaft",
      "direktvergabe", "kurzzeitmiete",
    ];

    const wgPatterns = [
      /\bwg\b/i, /wohngemeinschaft/i, /mitbewohner/i,
      /zimmer in/i, /zimmer frei/i, /wg[- ]zimmer/i, /\bwg\s*[-:]/i
    ];

    const foundKeywords = negativeKeywords.filter(kw => allText.includes(kw));
    const foundWg = wgPatterns.filter(re => re.test(allText));
    const isReserved = /reserviert/i.test(allText);

    const allowedTypes = settings.allowed_property_types || [];
    const isWgType = extracted.property_type === 'wg_room';
    const rejectWg = (foundWg.length > 0 || isWgType) && !allowedTypes.includes('wg_room');

    if (foundKeywords.length > 0 || rejectWg || isReserved) {
      const reasons = [];
      if (foundKeywords.length > 0) reasons.push(`Keywords: ${foundKeywords.join(", ")}`);
      if (rejectWg) reasons.push("WG nicht erlaubt");
      if (isReserved) reasons.push("Reserviert");

      await env.DB.prepare(`
        UPDATE listings SET jev_result = ?, jev_score = 0, jev_done = 1,
          status = CASE WHEN status = 'new' THEN 'archived' ELSE status END,
          updated_at = datetime('now') WHERE id = ?
      `).bind(JSON.stringify({ rejected: true, reason: reasons.join(" | ") }), listing.id).run();
      continue;
    }

    if (extracted.property_type && !allowedTypes.includes(extracted.property_type) && extracted.property_type !== 'other') {
      await env.DB.prepare(`
        UPDATE listings SET jev_result = ?, jev_score = 0, jev_done = 1,
          status = CASE WHEN status = 'new' THEN 'archived' ELSE status END,
          updated_at = datetime('now') WHERE id = ?
      `).bind(JSON.stringify({ rejected: true, reason: `Typ "${extracted.property_type}" nicht erlaubt` }), listing.id).run();
      continue;
    }

    const jevInput = `Titel: ${listing.title || "Unbekannt"}
Gesamtkosten pro Monat: ${extracted.total_monthly_cost_eur ? extracted.total_monthly_cost_eur + " EUR" : "Unbekannt"}
Kaltmiete: ${extracted.cold_rent_eur ? extracted.cold_rent_eur + " EUR" : "Unbekannt"}
Adresse: ${extracted.address || "Unbekannt"}
Wohnfläche: ${extracted.size_m2 ? extracted.size_m2 + " m²" : "Unbekannt"}
Zimmer: ${extracted.rooms || "Unbekannt"}
Objekttyp: ${extracted.property_type || "Unbekannt"}
Gemeindewohnung: ${extracted.is_gemeindewohnung ? "Ja" : "Nein"}
Genossenschaftswohnung: ${extracted.is_genossenschaft ? "Ja" : "Nein"}

Beschreibung:
${(extracted.description || "Keine Beschreibung").substring(0, 1000)}`;

    const jevResult = await callJev(env, jevInput, buildJevQuestions(settings));

    if (jevResult) {
      const score = calculateScore(jevResult, settings);
      await env.DB.prepare(`
        UPDATE listings SET jev_result = ?, jev_score = ?, jev_done = 1, updated_at = datetime('now')
        WHERE id = ?
      `).bind(JSON.stringify(jevResult), score, listing.id).run();

      if (score >= NOTIFICATION_THRESHOLD) {
        try { await notifyTelegram(env, { ...listing, jev_score: score, extracted }); }
        catch (e) {}
      }
    } else {
      await env.DB.prepare(`UPDATE listings SET jev_done = -1 WHERE id = ?`).bind(listing.id).run();
    }

    await new Promise(r => setTimeout(r, 200));
  }
}

function buildJevQuestions(settings) {
  return {
    is_within_budget: { type: "noul", instructions: `Is the total monthly cost ${settings.max_price} EUR or less? Include Warmmiete, Betriebskosten. TRUE if total <= ${settings.max_price}.` },
    is_in_target_city: { type: "noul", instructions: `Is this property located in ${settings.target_city}?` },
    property_type: {
      type: "choice",
      instructions: "What type of property is this?",
      criteria: { "apartment": "Eine ganze Wohnung", "wg_room": "Ein WG-Zimmer", "studio": "Ein Studio", "other": "Andere" }
    },
    is_excluded_type: {
      type: "noul",
      instructions: `Is this a Gemeindewohnung, Genossenschaftswohnung, or not for residential use? Keywords: "Gemeindewohnung", "Gemeindebau", "Wiener Wohnen", "Wohnticket", "Bonuspunkte", "Vormerkschein", "Genossenschaftswohnung", "Genossenschaft", "Direktvergabe", "Reserviert", "Nicht für Wohnzwecke", "Nur als Arbeitsraum", "Gewerbe", "Büro". TRUE if ANY appear.`
    },
    suitable_for_non_eu_student: {
      type: "noul",
      instructions: `Is this property legally suitable for a non-EU student (Iranian)? FALSE for: Gemeindewohnung, Genossenschaftswohnung, non-residential, "Wiener Wohnticket" or "Vormerkschein". TRUE for normal apartments, WG-Zimmer, studios without restrictions.`
    }
  };
}

async function callJev(env, text, questions) {
  try {
    const res = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: { "Authorization": `Bearer ${env.TYPESAFE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: JEV_MODEL, state: text, questions }),
    });

    if (res.status !== 200) {
      await logError(env, "jev", JEV_MODEL, `HTTP ${res.status}`);
      return null;
    }

    const resText = await res.text();
    const data = JSON.parse(resText);
    return data.answers || data;
  } catch (err) {
    await logError(env, "jev", JEV_MODEL, err.toString());
    return null;
  }
}

function calculateScore(jev, settings) {
  let score = 0;
  score += (jev.is_within_budget?.noul ?? 0) * 0.25;
  score += (jev.is_in_target_city?.noul ?? 0) * 0.10;
  score += (1 - (jev.is_excluded_type?.noul ?? 0)) * 0.40;
  score += (jev.suitable_for_non_eu_student?.noul ?? 0) * 0.25;
  return Math.round(score * 100) / 100;
}

// ============================================================
//  TELEGRAM
// ============================================================
async function handleTelegramWebhook(env, request) {
  try {
    const update = await request.json();
    const message = update.message;
    if (!message || !message.text) return json({ ok: true });

    const chatId = message.chat.id.toString();
    const text = message.text.trim();
    const username = message.from?.username || null;
    const firstName = message.from?.first_name || null;

    await env.DB.prepare(`UPDATE telegram_users SET last_seen = datetime('now') WHERE chat_id = ?`).bind(chatId).run();

    if (text === "/start" || text === "▶️ Start") {
      await env.DB.prepare(`
        INSERT INTO telegram_users (chat_id, username, first_name, is_active, is_blocked, subscribed_at, last_seen)
        VALUES (?, ?, ?, 1, 0, datetime('now'), datetime('now'))
        ON CONFLICT(chat_id) DO UPDATE SET
          username = excluded.username, first_name = excluded.first_name,
          is_active = 1, last_seen = datetime('now')
      `).bind(chatId, username, firstName).run();

      await sendTelegramWithKeyboard(env, chatId,
        `✅ *Willkommen!*\n\nDu erhältst ab jetzt Benachrichtigungen über neue, passende Wohnungen in Wien.`
      );
    }
    else if (text === "/stop" || text === "⏸ Stop") {
      await env.DB.prepare(`UPDATE telegram_users SET is_active = 0 WHERE chat_id = ?`).bind(chatId).run();
      await sendTelegramWithKeyboard(env, chatId, `🔕 Abbestellt.`);
    }
    else if (text === "/status" || text === "📊 Status") {
      const { results } = await env.DB.prepare(`SELECT COUNT(*) as count FROM telegram_users WHERE is_active = 1 AND is_blocked = 0`).all();
      await sendTelegramWithDashboardButton(env, chatId,
        `📊 *Status*\n\nAktive Nutzer: *${results[0]?.count || 0}*`
      );
    }
    else {
      await sendTelegramWithKeyboard(env, chatId, `Verfügbare Tasten: ⏸ Stop, ▶️ Start, 📊 Status`);
    }

    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: err.toString() }, 500);
  }
}

async function sendTelegramMessage(env, chatId, text, extra = {}) {
  if (!env.TELEGRAM_BOT_TOKEN) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown', disable_web_page_preview: false, ...extra }),
    });
    return await res.json();
  } catch { return null; }
}

async function sendTelegramWithKeyboard(env, chatId, text) {
  return sendTelegramMessage(env, chatId, text, {
    reply_markup: {
      keyboard: [[{ text: "⏸ Stop" }, { text: "▶️ Start" }], [{ text: "📊 Status" }]],
      resize_keyboard: true,
    }
  });
}

async function sendTelegramWithDashboardButton(env, chatId, text) {
  return sendTelegramMessage(env, chatId, text, {
    reply_markup: { inline_keyboard: [[{ text: "🌐 Dashboard", url: WORKER_URL }]] }
  });
}

async function notifyTelegram(env, listing) {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  const { results: users } = await env.DB.prepare(
    `SELECT chat_id FROM telegram_users WHERE is_active = 1 AND is_blocked = 0`
  ).all();
  if (users.length === 0) return;

  const score = ((listing.jev_score || 0) * 100).toFixed(0);
  const ext = listing.extracted || {};
  const price = ext.total_monthly_cost_eur ? `€ ${ext.total_monthly_cost_eur}` : 'Preis unbekannt';
  const size = ext.size_m2 ? `${ext.size_m2} m²` : '';
  const rooms = ext.rooms ? `${ext.rooms} Zi.` : '';
  const address = ext.address || listing.title || 'Unbekannt';

  const messageText =
    `🏠 *Neue passende Wohnung!*\n\n` +
    `📍 ${address}\n` +
    `💰 ${price}${size ? ` · 📐 ${size}` : ''}${rooms ? ` · 🚪 ${rooms}` : ''}\n` +
    `⭐ Score: *${score}%*\n\n` +
    `[🔗 Auf Willhaben öffnen](${listing.url})`;

  for (const user of users) {
    try {
      const existing = await env.DB.prepare(
        `SELECT 1 FROM notified_listings WHERE listing_id = ? AND chat_id = ?`
      ).bind(listing.id, user.chat_id).first();
      if (existing) continue;

      const result = await sendTelegramMessage(env, user.chat_id, messageText);
      if (result && result.ok) {
        await env.DB.prepare(`INSERT OR IGNORE INTO notified_listings (listing_id, chat_id) VALUES (?, ?)`).bind(listing.id, user.chat_id).run();
        await env.DB.prepare(`UPDATE telegram_users SET notifications_sent = notifications_sent + 1 WHERE chat_id = ?`).bind(user.chat_id).run();
      }
      await new Promise(r => setTimeout(r, 50));
    } catch {}
  }
}

// ============================================================
//  Settings
// ============================================================
async function loadSettings(env) {
  const { results } = await env.DB.prepare(`SELECT key, value FROM settings`).all();
  const settings = {};
  for (const row of results) {
    if (row.key === "allowed_property_types") settings[row.key] = row.value.split(",").map(s => s.trim());
    else if (row.value === "true" || row.value === "false") settings[row.key] = row.value === "true";
    else if (!isNaN(row.value)) settings[row.key] = Number(row.value);
    else settings[row.key] = row.value;
  }
  return settings;
}

function buildUrl(base, page) {
  const u = new URL(base);
  u.searchParams.set("page", page.toString());
  return u.toString();
}

// ============================================================
//  Logging — nur Fehler
// ============================================================
async function logError(env, service, url, error) {
  try {
    await env.DB.prepare(`
      INSERT INTO request_logs (service, url, status, error, created_at)
      VALUES (?, ?, 500, ?, datetime('now'))
    `).bind(service, (url || "").substring(0, 500), (error || "").substring(0, 500)).run();
  } catch {}
}

// ============================================================
//  API Handlers
// ============================================================
async function handleGetStats(env) {
  const stats = await env.DB.prepare(`
    SELECT COUNT(*) as total,
      SUM(CASE WHEN status = 'favorite' THEN 1 ELSE 0 END) as favorites,
      SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END) as archived,
      SUM(CASE WHEN extraction_done = -1 OR jev_done = -1 THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN (extraction_done = 0 OR jev_done = 0) AND extraction_done >= 0 AND jev_done >= 0 THEN 1 ELSE 0 END) as pending
    FROM listings
  `).first();
  const quotaExhausted = await isAiQuotaExhausted(env);
  return json({ stats, ai_quota_exhausted: quotaExhausted });
}

async function handleGetLogs(env, url) {
  const limit = Math.min(50, parseInt(url.searchParams.get("limit") || "50"));
  const service = url.searchParams.get("service") || "";
  let query = `SELECT id, service, url, status, error, created_at FROM request_logs`;
  const params = [];
  if (service) { query += ` WHERE service = ?`; params.push(service); }
  query += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);

  const { results } = await env.DB.prepare(query).bind(...params).all();
  return json({ logs: results });
}

async function handleGetAiStatus(env) {
  const exhausted = await isAiQuotaExhausted(env);
  const row = await env.DB.prepare(`SELECT value FROM system_state WHERE key = 'ai_quota_exhausted_until'`).first();
  return json({ exhausted, until: row?.value || null });
}

async function handleGetTelegramUsers(env) {
  const { results } = await env.DB.prepare(`
    SELECT chat_id, username, first_name, subscribed_at, last_seen, is_active, is_blocked, notifications_sent
    FROM telegram_users ORDER BY subscribed_at DESC
  `).all();
  return json({ users: results });
}

async function handleTestTelegram(env) {
  if (!env.TELEGRAM_BOT_TOKEN) return json({ success: false, message: "Token fehlt", sent: 0 });
  const { results: users } = await env.DB.prepare(
    `SELECT chat_id FROM telegram_users WHERE is_active = 1 AND is_blocked = 0`
  ).all();
  if (users.length === 0) return json({ success: false, message: "Keine aktiven Nutzer", sent: 0 });

  const testText = `🧪 *Test* ✅`;
  let sent = 0;
  for (const user of users) {
    const result = await sendTelegramMessage(env, user.chat_id, testText);
    if (result && result.ok) sent++;
    await new Promise(r => setTimeout(r, 50));
  }
  return json({ success: true, sent, total: users.length });
}

async function handleTestSingleUser(env, chatId) {
  const result = await sendTelegramMessage(env, chatId, `🧪 Test ✅`);
  return json({ success: !!(result && result.ok) });
}

async function handleBlockUser(env, chatId, blocked) {
  await env.DB.prepare(`UPDATE telegram_users SET is_blocked = ? WHERE chat_id = ?`).bind(blocked ? 1 : 0, chatId).run();
  return json({ success: true, blocked });
}

async function handleSetWebhook(env, url) {
  if (!env.TELEGRAM_BOT_TOKEN) return json({ success: false, error: "Token fehlt" }, 400);
  const webhookUrl = `${url.origin}/telegram/webhook`;
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl }),
    });
    const data = await res.json();
    return json({ success: data.ok, webhook_url: webhookUrl, telegram_response: data });
  } catch (err) { return json({ success: false, error: err.toString() }, 500); }
}

async function handleGetSettings(env) { return json(await loadSettings(env)); }

async function handleSaveSettings(env, request) {
  try {
    const body = await request.json();
    const stmt = env.DB.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
    `);
    const batch = [];
    for (const [k, v] of Object.entries(body)) {
      batch.push(stmt.bind(k, Array.isArray(v) ? v.join(",") : String(v)));
    }
    await env.DB.batch(batch);
    return json({ success: true });
  } catch (err) { return json({ success: false, error: err.toString() }, 500); }
}

async function handleForceRun(env, ctx) {
  ctx.waitUntil(handleCron(env));
  return json({ success: true, message: "Cron gestartet." });
}

async function handleResetAll(env) {
  await env.DB.prepare(`DELETE FROM listings`).run();
  await env.DB.prepare(`DELETE FROM request_logs`).run();
  await env.DB.prepare(`DELETE FROM notified_listings`).run();
  await clearAiQuotaExhausted(env);
  return json({ success: true });
}

async function handleRetry(env, id) {
  await env.DB.prepare(`
    UPDATE listings
    SET extraction_done = 0, jev_done = 0, jev_score = 0, jev_result = NULL,
        extracted_data = NULL, raw_text = NULL,
        status = CASE WHEN status IN ('archived') THEN 'new' ELSE status END,
        updated_at = datetime('now')
    WHERE id = ?
  `).bind(id).run();
  return json({ success: true, id });
}

async function handleRetryAllFailed(env) {
  await clearAiQuotaExhausted(env);
  const result = await env.DB.prepare(`
    UPDATE listings
    SET extraction_done = 0, jev_done = 0, jev_score = 0, jev_result = NULL,
        extracted_data = NULL, raw_text = NULL,
        status = CASE WHEN status IN ('archived') THEN 'new' ELSE status END,
        updated_at = datetime('now')
    WHERE extraction_done = -1 OR jev_done = -1
  `).run();
  return json({ success: true, changes: result.meta?.changes || 0, quota_cleared: true });
}

async function handleUpdateStatus(env, id, status) {
  await env.DB.prepare(`UPDATE listings SET status = ?, updated_at = datetime('now') WHERE id = ?`).bind(status, id).run();
  return json({ success: true });
}

// ============================================================
//  All Listings API (mit Cache)
// ============================================================
async function handleGetAllListings(env) {
  const { results } = await env.DB.prepare(`
    SELECT id, willhaben_code, url, title, scraped_at, extracted_data, extraction_done,
           jev_result, jev_score, jev_done, status, image_url,
           address, size_m2, total_cost_eur
    FROM listings
    ORDER BY jev_score DESC, scraped_at DESC
    LIMIT 500
  `).all();

  // Cache 30 Sekunden für schnelle Wiederholungen
  return new Response(JSON.stringify({ listings: results }), {
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
      "Cache-Control": "public, max-age=30"
    }
  });
}

// ============================================================
//  UI
// ============================================================
async function serveUI(env, url) {
  // 🔧 Parallel DB Queries
  const [stats, telegramUsers, quotaExhausted, settings] = await Promise.all([
    env.DB.prepare(`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN status = 'favorite' THEN 1 ELSE 0 END) as favorites,
        SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END) as archived,
        SUM(CASE WHEN extraction_done = -1 OR jev_done = -1 THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN extraction_done = 1 AND jev_done = 0 THEN 1 ELSE 0 END) as jev_pending,
        SUM(CASE WHEN extraction_done = 0 THEN 1 ELSE 0 END) as extraction_pending
      FROM listings
    `).first(),
    env.DB.prepare(`SELECT COUNT(*) as count FROM telegram_users WHERE is_active = 1 AND is_blocked = 0`).first(),
    isAiQuotaExhausted(env),
    loadSettings(env)
  ]);

  const html = `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, user-scalable=no">
<meta name="theme-color" content="#1d1d1f">
<title>Willhaben Wien</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
  html, body { overflow-x: hidden; max-width: 100vw; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Roboto, sans-serif; background: #f5f5f7; color: #1d1d1f; font-size: 15px; line-height: 1.45; padding-bottom: env(safe-area-inset-bottom); }
  .header { background: linear-gradient(180deg, #1d1d1f 0%, #2c2c2e 100%); color: white; padding: 14px 16px 16px; padding-top: calc(14px + env(safe-area-inset-top)); }
  .header h1 { font-size: 17px; font-weight: 700; margin-bottom: 12px; }
  .stats { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; }
  .stat { text-align: center; background: rgba(255,255,255,0.08); border-radius: 10px; padding: 10px 4px 8px; }
  .stat-value { font-size: 18px; font-weight: 700; line-height: 1; }
  .stat-label { opacity: 0.65; font-size: 9px; margin-top: 4px; text-transform: uppercase; }
  .tabs { background: rgba(255,255,255,0.92); backdrop-filter: saturate(180%) blur(20px); display: flex; border-bottom: 1px solid #e0e0e0; position: sticky; top: 0; z-index: 100; padding: 0 4px; overflow-x: auto; scrollbar-width: none; }
  .tabs::-webkit-scrollbar { display: none; }
  .tab { flex: 1; padding: 14px 8px; border: none; background: none; cursor: pointer; font-size: 13px; font-weight: 600; color: #666; border-bottom: 3px solid transparent; min-height: 48px; white-space: nowrap; font-family: inherit; }
  .tab.active { color: #0071e3; border-bottom-color: #0071e3; }
  .container { padding: 14px 12px; max-width: 1200px; margin: 0 auto; overflow-x: hidden; }
  .toolbar { display: flex; flex-direction: column; gap: 10px; margin-bottom: 16px; }
  .toolbar-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .toolbar-actions .primary { grid-column: 1 / -1; }
  .toolbar button { padding: 12px 14px; border: 1px solid #d2d2d7; border-radius: 12px; background: white; cursor: pointer; font-size: 13px; font-weight: 600; min-height: 46px; white-space: nowrap; font-family: inherit; }
  .toolbar button.danger { border-color: #ff3b30; color: #ff3b30; }
  .toolbar button.warning { border-color: #ff9500; color: #ff9500; }
  .toolbar button.primary { background: #34c759; color: white; border-color: #34c759; font-size: 15px; font-weight: 700; }
  .filter-scroll-wrapper { width: 100%; max-width: 100%; overflow-x: auto; overflow-y: hidden; -webkit-overflow-scrolling: touch; scrollbar-width: none; margin: 0 -12px; padding: 4px 12px 10px; }
  .filter-scroll-wrapper::-webkit-scrollbar { display: none; }
  .filter-scroll-inner { display: inline-flex; gap: 6px; white-space: nowrap; }
  .filter-btn { padding: 8px 14px; border: 1px solid #d2d2d7; border-radius: 20px; background: white; cursor: pointer; font-size: 13px; font-weight: 600; white-space: nowrap; flex-shrink: 0; color: #1d1d1f; font-family: inherit; min-height: 36px; user-select: none; transition: background 0.15s, color 0.15s; }
  .filter-btn.active { background: #0071e3; color: white; border-color: #0071e3; font-weight: 700; }
  .filter-btn:active { transform: scale(0.95); }
  .filter-btn .count { display: inline-block; margin-left: 4px; padding: 1px 7px; border-radius: 10px; background: rgba(0,0,0,0.08); font-size: 11px; font-weight: 700; }
  .filter-btn.active .count { background: rgba(255,255,255,0.25); color: white; }
  .quota-banner { padding: 12px 16px; background: #fff3cd; border-radius: 12px; margin-bottom: 14px; font-size: 13px; color: #856404; border: 1px solid #ffc107; }
  .pagination { display: flex; justify-content: space-between; align-items: center; margin: 16px 0; padding: 12px; background: white; border-radius: 12px; }
  .pagination button { padding: 10px 16px; border: 1px solid #d2d2d7; border-radius: 10px; background: white; cursor: pointer; font-size: 13px; font-weight: 600; font-family: inherit; }
  .pagination button:disabled { opacity: 0.3; cursor: not-allowed; }
  .pagination .info { font-size: 13px; color: #666; font-weight: 600; }
  .card { background: white; border-radius: 14px; padding: 14px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); display: grid; grid-template-columns: 1fr; gap: 12px; }
  .card-image { width: 100%; aspect-ratio: 16 / 10; border-radius: 10px; object-fit: cover; background: #f0f0f5; display: block; }
  .card-image-placeholder { display: flex; align-items: center; justify-content: center; font-size: 40px; color: #c7c7cc; background: linear-gradient(135deg, #f5f5f7 0%, #e8e8ed 100%); }
  .card h3 { font-size: 14.5px; font-weight: 600; margin-bottom: 10px; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .meta { display: flex; flex-wrap: wrap; gap: 6px 8px; font-size: 12.5px; color: #555; margin-bottom: 10px; }
  .meta span { display: inline-flex; align-items: center; gap: 3px; background: #f5f5f7; padding: 3px 8px; border-radius: 8px; white-space: nowrap; }
  .badge { display: inline-block; padding: 4px 10px; border-radius: 20px; font-size: 11px; font-weight: 700; }
  .badge-match { background: #d1f2d1; color: #1a7a1a; }
  .badge-pending { background: #fff3cd; color: #856404; }
  .badge-jev { background: #ffe4c4; color: #8a5a00; }
  .badge-favorite { background: #ffe0e0; color: #c00; }
  .badge-archived { background: #e0e0e0; color: #555; }
  .badge-error { background: #ffd6d6; color: #b00; }
  .badge-rejected { background: #f0e0f0; color: #6a1a6a; }
  .badge-blocked { background: #ffd6d6; color: #b00; }
  .card-footer { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 4px; }
  .card-score { font-size: 11.5px; color: #666; font-weight: 600; }
  .score-bar { height: 4px; background: #e0e0e0; border-radius: 3px; margin-top: 6px; overflow: hidden; }
  .score-fill { height: 100%; border-radius: 3px; }
  .card-actions { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 6px; }
  .card-actions button, .card-actions a { padding: 11px 6px; border: 1px solid #d2d2d7; border-radius: 10px; background: white; cursor: pointer; font-size: 12px; font-weight: 600; min-height: 44px; display: flex; align-items: center; justify-content: center; text-decoration: none; color: #1d1d1f; font-family: inherit; }
  .card-actions a { color: #0071e3; border-color: #0071e3; }
  .card-actions button.retry { color: #ff9500; border-color: #ff9500; }
  .empty { text-align: center; padding: 70px 20px; color: #86868b; }
  .empty-icon { font-size: 48px; margin-bottom: 16px; opacity: 0.6; }
  .log-card { background: white; border-radius: 12px; padding: 12px 14px; margin-bottom: 8px; box-shadow: 0 1px 2px rgba(0,0,0,0.04); font-size: 12.5px; }
  .log-card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; gap: 8px; flex-wrap: wrap; }
  .log-card-time { color: #86868b; font-size: 11px; }
  .log-status-err { color: #ff3b30; font-weight: 700; font-size: 12px; }
  .log-service { font-weight: 700; padding: 3px 8px; border-radius: 6px; font-size: 10.5px; }
  .log-service.willhaben, .log-service.willhaben-detail { background: #e3f2fd; color: #1565c0; }
  .log-service.workers-ai { background: #f3e5f5; color: #7b1fa2; }
  .log-service.jev { background: #fff3e0; color: #e65100; }
  .log-service.telegram { background: #e0f7fa; color: #00838f; }
  .log-service.system { background: #ffebee; color: #c62828; }
  .log-row { display: flex; gap: 10px; align-items: flex-start; padding: 5px 0; border-top: 1px solid #f5f5f7; }
  .log-row:first-child { border-top: none; }
  .log-label { color: #86868b; font-size: 11px; min-width: 60px; flex-shrink: 0; }
  .log-value { font-family: ui-monospace, monospace; font-size: 11px; word-break: break-all; flex: 1; }
  .settings-form { background: white; border-radius: 14px; padding: 20px 16px; max-width: 640px; margin: 0 auto; }
  .settings-form h2 { font-size: 18px; font-weight: 700; margin-bottom: 22px; }
  .form-group { margin-bottom: 24px; }
  .form-group label { display: block; font-weight: 600; margin-bottom: 8px; font-size: 14px; }
  .form-group input[type="number"], .form-group input[type="text"] { width: 100%; padding: 13px 14px; border: 1px solid #d2d2d7; border-radius: 12px; font-size: 16px; background: #fafafa; font-family: inherit; }
  .checkbox-group { display: flex; flex-direction: column; gap: 8px; }
  .checkbox-item { display: flex; align-items: center; gap: 12px; font-size: 14.5px; cursor: pointer; padding: 12px 14px; background: #f5f5f7; border-radius: 12px; min-height: 50px; }
  .checkbox-item input { width: 22px; height: 22px; cursor: pointer; accent-color: #0071e3; }
  .save-btn { background: #0071e3; color: white; padding: 15px 24px; border: none; border-radius: 12px; font-size: 15px; font-weight: 700; cursor: pointer; width: 100%; min-height: 50px; font-family: inherit; }
  .success-msg { background: #d1f2d1; color: #1a7a1a; padding: 14px; border-radius: 12px; margin-bottom: 18px; display: none; font-size: 13.5px; font-weight: 600; text-align: center; }
  .action-btn { padding: 10px 16px; border: 1px solid #d2d2d7; border-radius: 10px; background: white; cursor: pointer; font-size: 13px; font-weight: 600; min-height: 42px; font-family: inherit; }
  .action-btn.danger { border-color: #ff3b30; color: #ff3b30; }
  .action-btn.success { border-color: #34c759; color: #34c759; }
  .info-box { background: #e3f2fd; border-radius: 12px; padding: 14px 16px; margin-bottom: 16px; font-size: 13px; }
  .user-card { background: white; border-radius: 12px; padding: 14px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }
  .user-info { flex: 1; min-width: 200px; }
  .user-info strong { display: block; font-size: 14px; margin-bottom: 2px; }
  .user-info .sub { font-size: 11px; color: #86868b; }
  .user-actions { display: flex; gap: 6px; flex-wrap: wrap; }
  .status-bar { padding: 12px 14px; border-radius: 12px; margin-bottom: 14px; font-size: 13px; }
  .status-bar.success { background: #d1f2d1; color: #1a7a1a; }
  .status-bar.error { background: #ffebee; color: #c62828; }
  .status-bar.info { background: #e3f2fd; color: #1565c0; }
  @media (min-width: 768px) {
    .header { padding: 18px 32px; display: flex; justify-content: space-between; align-items: center; gap: 16px; }
    .header h1 { font-size: 20px; margin-bottom: 0; }
    .stats { display: flex; gap: 24px; }
    .stat { background: none; padding: 0; }
    .stat-value { font-size: 24px; }
    .tab { flex: 0 0 auto; padding: 14px 20px; font-size: 14px; }
    .container { padding: 24px 16px; }
    .toolbar { flex-direction: row; align-items: center; }
    .toolbar-actions { display: flex; gap: 10px; }
    .toolbar-actions .primary { grid-column: auto; padding: 10px 24px; font-size: 14px; }
    .filter-scroll-wrapper { margin: 0; padding: 0; overflow: visible; }
    .filter-scroll-inner { flex-wrap: wrap; display: flex; }
    .card { display: grid; grid-template-columns: 180px 1fr auto; gap: 20px; padding: 16px; align-items: start; }
    .card-image { aspect-ratio: 4/3; height: 140px; width: 180px; }
    .card h3 { font-size: 16px; -webkit-line-clamp: 2; }
    .meta span { background: none; padding: 0; }
    .card-actions { display: flex; flex-direction: column; gap: 6px; width: 130px; }
    .card-actions button, .card-actions a { padding: 8px 14px; min-height: 38px; font-size: 12.5px; }
    .settings-form { padding: 28px; }
    .save-btn { width: auto; min-width: 200px; }
    .checkbox-group { flex-direction: row; flex-wrap: wrap; }
    .checkbox-item { flex: 0 0 auto; }
  }
</style>
</head>
<body>

<div class="header">
  <h1>🏠 Willhaben Wien</h1>
  <div class="stats">
    <div class="stat"><div class="stat-value">${stats?.total || 0}</div><div class="stat-label">Gesamt</div></div>
    <div class="stat"><div class="stat-value">${stats?.favorites || 0}</div><div class="stat-label">Favoriten</div></div>
    <div class="stat"><div class="stat-value">${stats?.archived || 0}</div><div class="stat-label">Archiv</div></div>
    <div class="stat"><div class="stat-value">${(stats?.extraction_pending || 0) + (stats?.jev_pending || 0)}</div><div class="stat-label">Wartend</div></div>
    <div class="stat"><div class="stat-value">${stats?.failed || 0}</div><div class="stat-label">Fehler</div></div>
  </div>
</div>

<div class="tabs">
  <button class="tab active" data-tab="listings">📋 Anzeigen</button>
  <button class="tab" data-tab="logs">📊 Logs</button>
  <button class="tab" data-tab="telegram">📱 Telegram</button>
  <button class="tab" data-tab="settings">⚙️ Einstellungen</button>
</div>

<div class="container">
  <div id="tab-listings">
    ${quotaExhausted ? '<div class="quota-banner">⚠️ <strong>AI-Kontingent erschöpft</strong> — neue Anzeigen werden morgen verarbeitet. Jev-Auswertung läuft trotzdem!</div>' : ''}

    <div class="toolbar">
      <div class="toolbar-actions">
        <button class="primary" onclick="forceRun()">⚡ Jetzt ausführen</button>
        <button class="warning" onclick="retryAllFailed()">🔄 Alle Fehler erneut</button>
        <button class="danger" onclick="resetAll()">🗑️ Löschen</button>
      </div>
    </div>

    <div class="filter-scroll-wrapper">
      <div class="filter-scroll-inner" id="filter-inner">
        <button class="filter-btn active" data-filter="approved">✅ Bestätigt <span class="count" id="c-approved">0</span></button>
        <button class="filter-btn" data-filter="all">Alle <span class="count" id="c-all">0</span></button>
        <button class="filter-btn" data-filter="favorite">⭐ Favoriten <span class="count" id="c-favorite">0</span></button>
        <button class="filter-btn" data-filter="new">🆕 Neu <span class="count" id="c-new">0</span></button>
        <button class="filter-btn" data-filter="jev_pending">⚖️ Jev ausstehend <span class="count" id="c-jev_pending">0</span></button>
        <button class="filter-btn" data-filter="pending">⏳ Wartend <span class="count" id="c-pending">0</span></button>
        <button class="filter-btn" data-filter="archived">📦 Archiv <span class="count" id="c-archived">0</span></button>
        <button class="filter-btn" data-filter="rejected">⛔ Abgelehnt <span class="count" id="c-rejected">0</span></button>
        <button class="filter-btn" data-filter="failed">⚠️ Fehler <span class="count" id="c-failed">0</span></button>
      </div>
    </div>

    <div id="listings-container">
      <div class="empty"><div class="empty-icon">⏳</div><h2>Lade...</h2></div>
    </div>

    <div id="pagination-top" class="pagination" style="display:none;">
      <button onclick="changePage(-1)">◀ Zurück</button>
      <span class="info" id="page-info"></span>
      <button onclick="changePage(1)">Weiter ▶</button>
    </div>
    <div id="pagination-bottom" class="pagination" style="display:none;">
      <button onclick="changePage(-1)">◀ Zurück</button>
      <span class="info" id="page-info-bottom"></span>
      <button onclick="changePage(1)">Weiter ▶</button>
    </div>
  </div>

  <div id="tab-logs" style="display:none;">
    <div style="margin-bottom:14px;display:flex;gap:8px;flex-wrap:wrap;">
      <button class="action-btn" onclick="loadLogs()">🔄 Aktualisieren</button>
      <button class="action-btn" onclick="loadLogs('willhaben')">📥 Willhaben</button>
      <button class="action-btn" onclick="loadLogs('workers-ai')">🤖 Workers AI</button>
      <button class="action-btn" onclick="loadLogs('jev')">⚖️ Jev</button>
      <button class="action-btn" onclick="loadLogs('telegram')">📱 Telegram</button>
    </div>
    <div id="logs-content"><div class="empty"><div class="empty-icon">📋</div><h2>Klicke auf "Aktualisieren"</h2></div></div>
  </div>

  <div id="tab-telegram" style="display:none;">
    <div class="info-box"><strong>📱 Telegram Bot</strong><br>Aktive Nutzer: <strong>${telegramUsers?.count || 0}</strong></div>
    <div style="margin-bottom:16px;display:flex;gap:8px;flex-wrap:wrap;">
      <button class="action-btn" onclick="loadTelegramUsers()">👥 Nutzer anzeigen</button>
      <button class="action-btn" onclick="testNotification()">📤 Test an alle</button>
    </div>
    <div id="telegram-status" class="status-bar" style="display:none;"></div>
    <div id="telegram-users"></div>
  </div>

  <div id="tab-settings" style="display:none;">
    <div class="settings-form">
      <div class="success-msg" id="settings-success">✅ Gespeichert!</div>
      <h2>⚙️ Filter</h2>
      <div class="form-group">
        <label>💰 Max. Preis (EUR)</label>
        <input type="number" id="max_price" value="${settings.max_price || 550}" inputmode="numeric">
      </div>
      <div class="form-group">
        <label>🏙️ Stadt</label>
        <input type="text" id="target_city" value="${settings.target_city || 'Wien'}">
      </div>
      <div class="form-group">
        <label>🏠 Erlaubte Typen</label>
        <div class="checkbox-group">
          <label class="checkbox-item"><input type="checkbox" class="ptype" value="apartment" ${(settings.allowed_property_types || []).includes('apartment') ? 'checked' : ''}> <span>Wohnung</span></label>
          <label class="checkbox-item"><input type="checkbox" class="ptype" value="wg_room" ${(settings.allowed_property_types || []).includes('wg_room') ? 'checked' : ''}> <span>WG-Zimmer</span></label>
          <label class="checkbox-item"><input type="checkbox" class="ptype" value="studio" ${(settings.allowed_property_types || []).includes('studio') ? 'checked' : ''}> <span>Studio</span></label>
          <label class="checkbox-item"><input type="checkbox" class="ptype" value="other" ${(settings.allowed_property_types || []).includes('other') ? 'checked' : ''}> <span>Sonstiges</span></label>
        </div>
      </div>
      <button class="save-btn" onclick="saveSettings()">💾 Speichern</button>
    </div>
  </div>
</div>

<script>
const API_BASE = '${url.origin}';
const PER_PAGE = 20;

// Alte Service Workers entfernen
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(registrations => {
    for (let reg of registrations) reg.unregister();
  });
  if (window.caches) {
    caches.keys().then(names => names.forEach(name => caches.delete(name)));
  }
}

let allListings = [];
let currentFilter = 'approved';
let currentPage = 1;
let filteredListings = [];

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    ['listings', 'logs', 'telegram', 'settings'].forEach(t => {
      const el = document.getElementById('tab-' + t);
      if (el) el.style.display = 'none';
    });
    document.getElementById('tab-' + tab.dataset.tab).style.display = 'block';
    if (tab.dataset.tab === 'logs') loadLogs();
    if (tab.dataset.tab === 'telegram') loadTelegramUsers();
  });
});

document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.dataset.filter;
    currentPage = 1;
    applyFilter();
  });
});

function classifyListing(l) {
  let extracted = {};
  try { extracted = l.extracted_data ? JSON.parse(l.extracted_data) : {}; } catch {}
  let jevParsed = {};
  try { jevParsed = l.jev_result ? JSON.parse(l.jev_result) : {}; } catch {}
  const isRejected = jevParsed && jevParsed.rejected === true;
  const isExtractionFailed = l.extraction_done === -1;
  const isJevFailed = l.jev_done === -1;
  const isExtractionPending = l.extraction_done === 0;
  const isJevPending = l.extraction_done === 1 && l.jev_done === 0;
  const isApproved = l.jev_done === 1 && (l.jev_score || 0) >= 0.7 && !isRejected && l.status !== 'archived';

  return {
    isRejected, isExtractionFailed, isJevFailed,
    isExtractionPending, isJevPending, isApproved,
    isFailed: isExtractionFailed || isJevFailed,
    extracted
  };
}

function applyFilter() {
  filteredListings = allListings.filter(l => {
    const c = classifyListing(l);
    switch (currentFilter) {
      case 'approved': return c.isApproved;
      case 'favorite': return l.status === 'favorite';
      case 'archived': return l.status === 'archived';
      case 'new': return l.status === 'new' && !c.isRejected && !c.isFailed;
      case 'jev_pending': return c.isJevPending;
      case 'pending': return c.isExtractionPending || c.isJevPending;
      case 'rejected': return c.isRejected;
      case 'failed': return c.isFailed;
      case 'all': default: return true;
    }
  });
  updateCounts();
  renderPage();
}

function updateCounts() {
  const counts = { approved: 0, all: allListings.length, favorite: 0, new: 0, jev_pending: 0, pending: 0, archived: 0, rejected: 0, failed: 0 };
  for (const l of allListings) {
    const c = classifyListing(l);
    if (c.isApproved) counts.approved++;
    if (l.status === 'favorite') counts.favorite++;
    if (l.status === 'archived') counts.archived++;
    if (l.status === 'new' && !c.isRejected && !c.isFailed) counts.new++;
    if (c.isJevPending) counts.jev_pending++;
    if (c.isExtractionPending || c.isJevPending) counts.pending++;
    if (c.isRejected) counts.rejected++;
    if (c.isFailed) counts.failed++;
  }
  for (const k of Object.keys(counts)) {
    const el = document.getElementById('c-' + k);
    if (el) el.textContent = counts[k];
  }
}

function renderPage() {
  const container = document.getElementById('listings-container');
  const total = filteredListings.length;
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));

  if (currentPage > totalPages) currentPage = totalPages;
  const start = (currentPage - 1) * PER_PAGE;
  const pageItems = filteredListings.slice(start, start + PER_PAGE);

  const pagTop = document.getElementById('pagination-top');
  const pagBot = document.getElementById('pagination-bottom');
  const infoTop = document.getElementById('page-info');
  const infoBot = document.getElementById('page-info-bottom');

  if (totalPages > 1) {
    pagTop.style.display = 'flex';
    pagBot.style.display = 'flex';
    infoTop.textContent = 'Seite ' + currentPage + '/' + totalPages + ' (' + total + ' Anzeigen)';
    infoBot.textContent = 'Seite ' + currentPage + '/' + totalPages;
    pagTop.querySelector('button:first-child').disabled = currentPage <= 1;
    pagTop.querySelector('button:last-child').disabled = currentPage >= totalPages;
    pagBot.querySelector('button:first-child').disabled = currentPage <= 1;
    pagBot.querySelector('button:last-child').disabled = currentPage >= totalPages;
  } else {
    pagTop.style.display = 'none';
    pagBot.style.display = 'none';
  }

  if (pageItems.length === 0) {
    container.innerHTML = '<div class="empty"><div class="empty-icon">🏠</div><h2>Keine Anzeigen</h2><p>Versuche einen anderen Filter.</p></div>';
    return;
  }

  container.innerHTML = pageItems.map(renderCard).join('');
}

function changePage(delta) {
  const totalPages = Math.max(1, Math.ceil(filteredListings.length / PER_PAGE));
  const newPage = currentPage + delta;
  if (newPage < 1 || newPage > totalPages) return;
  currentPage = newPage;
  renderPage();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderCard(l) {
  const c = classifyListing(l);
  const score = l.jev_score || 0;
  const scoreColor = score >= 0.7 ? "#34c759" : score >= 0.4 ? "#ff9500" : "#ff3b30";
  const extracted = c.extracted;

  let badge = '<span class="badge badge-pending">⏳ Wartend</span>';
  if (c.isExtractionFailed) badge = '<span class="badge badge-error">⚠️ Extraction-Fehler</span>';
  else if (c.isJevFailed) badge = '<span class="badge badge-error">⚠️ Jev-Fehler</span>';
  else if (l.status === 'favorite') badge = '<span class="badge badge-favorite">⭐ Favorit</span>';
  else if (l.status === 'archived') badge = '<span class="badge badge-archived">📦 Archiviert</span>';
  else if (c.isRejected) badge = '<span class="badge badge-rejected">⛔ Abgelehnt</span>';
  else if (c.isJevPending) badge = '<span class="badge badge-jev">⚖️ Jev ausstehend</span>';
  else if (l.jev_done === 1) badge = '<span class="badge badge-match">✅ Geprüft</span>';

  const metaItems = [];
  const price = extracted.total_monthly_cost_eur || l.total_cost_eur;
  const size = extracted.size_m2 || l.size_m2;
  const addr = extracted.address || l.address;
  if (price) metaItems.push('<span>💰 € ' + price + '</span>');
  if (size) metaItems.push('<span>📐 ' + size + ' m²</span>');
  if (extracted.rooms) metaItems.push('<span>🚪 ' + extracted.rooms + ' Zi.</span>');
  if (addr) metaItems.push('<span>📍 ' + esc(addr) + '</span>');

  const imageBlock = l.image_url
    ? '<img class="card-image" src="' + esc(l.image_url) + '" loading="lazy" referrerpolicy="no-referrer" onerror="this.outerHTML=&#39;&lt;div class=&quot;card-image card-image-placeholder&quot;&gt;🏠&lt;/div&gt;&#39;">'
    : '<div class="card-image card-image-placeholder">🏠</div>';

  const favBtn = '<button onclick="toggleFavorite(' + l.id + ')">' + (l.status === 'favorite' ? '⭐ Weg' : '⭐ Fav') + '</button>';
  const archBtn = '<button onclick="toggleArchive(' + l.id + ')">' + (l.status === 'archived' ? '📤' : '📦') + '</button>';
  const retryBtn = c.isFailed ? '<button class="retry" onclick="retryListing(' + l.id + ')">🔄</button>' : '';

  return '<div class="card" data-status="' + l.status + '" data-id="' + l.id + '">'
    + imageBlock
    + '<div class="card-content">'
    + '<h3>' + esc(l.title || 'Unbekannt') + '</h3>'
    + '<div class="meta">' + metaItems.join('') + '</div>'
    + '<div class="card-footer">' + badge
    + (l.jev_done === 1 && !c.isRejected ? '<span class="card-score">Score: ' + (score * 100).toFixed(0) + '%</span>' : '')
    + '</div>'
    + '<div class="score-bar"><div class="score-fill" style="width:' + (score * 100) + '%;background:' + scoreColor + ';"></div></div>'
    + '</div>'
    + '<div class="card-actions">'
    + '<a href="' + esc(l.url) + '" target="_blank" rel="noopener">🔗</a>'
    + favBtn + archBtn + retryBtn
    + '</div>'
    + '</div>';
}

async function loadAllListings() {
  try {
    const res = await fetch(API_BASE + '/api/all-listings');
    const data = await res.json();
    allListings = data.listings || [];
    applyFilter();
  } catch (e) {
    document.getElementById('listings-container').innerHTML = '<div class="empty"><div class="empty-icon">❌</div><h2>Fehler beim Laden</h2><p>' + esc(e.message) + '</p></div>';
  }
}

async function toggleFavorite(id) {
  const card = document.querySelector('.card[data-id="' + id + '"]');
  const endpoint = card.dataset.status === 'favorite' ? '/api/unfavorite/' : '/api/favorite/';
  await fetch(API_BASE + endpoint + id, { method: 'POST' });
  await loadAllListings();
}
async function toggleArchive(id) {
  const card = document.querySelector('.card[data-id="' + id + '"]');
  const endpoint = card.dataset.status === 'archived' ? '/api/unarchive/' : '/api/archive/';
  await fetch(API_BASE + endpoint + id, { method: 'POST' });
  await loadAllListings();
}
async function retryListing(id) {
  await fetch(API_BASE + '/api/retry/' + id, { method: 'POST' });
  await loadAllListings();
}
async function retryAllFailed() {
  if (!confirm('Alle fehlgeschlagenen erneut verarbeiten?')) return;
  const res = await fetch(API_BASE + '/api/retry-all-failed', { method: 'POST' });
  const data = await res.json();
  if (data.success) {
    alert('✅ ' + data.changes + ' Anzeigen markiert.');
    await loadAllListings();
  }
}
async function forceRun() {
  const bar = document.createElement('div');
  bar.className = 'status-bar info';
  bar.textContent = '⚡ Läuft im Hintergrund... In 60 Sekunden aktualisieren.';
  document.querySelector('.container').prepend(bar);
  try {
    await fetch(API_BASE + '/api/force-run');
    bar.className = 'status-bar success';
    bar.textContent = '✅ Gestartet! In 60 Sekunden Seite aktualisieren.';
  } catch (e) { bar.className = 'status-bar error'; bar.textContent = '❌ ' + e.message; }
}
async function resetAll() {
  if (!confirm('Alle Anzeigen werden gelöscht!')) return;
  await fetch(API_BASE + '/api/reset-all');
  location.reload();
}

async function loadLogs(service) {
  const container = document.getElementById('logs-content');
  container.innerHTML = '<div class="empty"><div class="empty-icon">⏳</div><h2>Lade...</h2></div>';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const url = API_BASE + '/api/logs' + (service ? '?service=' + service : '');
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    const data = await res.json();
    renderLogs(data.logs);
  } catch (e) {
    clearTimeout(timeout);
    container.innerHTML = '<div class="empty"><div class="empty-icon">❌</div><h2>Fehler</h2><p>' + esc(e.message) + '</p></div>';
  }
}

function renderLogs(logs) {
  if (!logs || logs.length === 0) {
    document.getElementById('logs-content').innerHTML = '<div class="empty"><div class="empty-icon">📋</div><h2>Keine Logs</h2></div>';
    return;
  }
  let html = '';
  for (const log of logs) {
    const snip = log.error || '–';
    html += '<div class="log-card"><div class="log-card-header"><span class="log-card-time">' + esc(log.created_at || '') + '</span><div style="display:flex;gap:6px;"><span class="log-service ' + esc(log.service || '') + '">' + esc(log.service || '') + '</span><span class="log-status-err">' + (log.status || '?') + '</span></div></div><div><div class="log-row"><div class="log-label">URL</div><div class="log-value">' + esc((log.url || '–').substring(0, 120)) + '</div></div>' + (snip !== '–' ? '<div class="log-row"><div class="log-label">Info</div><div class="log-value">' + esc(snip.substring(0, 250)) + '</div></div>' : '') + '</div></div>';
  }
  document.getElementById('logs-content').innerHTML = html;
}

async function loadTelegramUsers() {
  const res = await fetch(API_BASE + '/api/telegram-users');
  const data = await res.json();
  if (!data.users || data.users.length === 0) {
    document.getElementById('telegram-users').innerHTML = '<div class="empty"><div class="empty-icon">👥</div><h2>Keine Nutzer</h2></div>';
    return;
  }
  let html = '<h3 style="margin:14px 0 10px;font-size:14px;">👥 ' + data.users.length + ' Nutzer</h3>';
  for (const u of data.users) {
    const blocked = u.is_blocked === 1;
    const active = u.is_active === 1;
    let statusBadge = '';
    if (blocked) statusBadge = '<span class="badge badge-blocked">🚫 Blockiert</span>';
    else if (active) statusBadge = '<span class="badge badge-match">✓ Aktiv</span>';
    else statusBadge = '<span class="badge badge-archived">⏸ Inaktiv</span>';

    html += '<div class="user-card">'
      + '<div class="user-info"><strong>' + esc(u.first_name || 'Anonym') + (u.username ? ' (@' + esc(u.username) + ')' : '') + '</strong>'
      + '<span class="sub">' + statusBadge + ' · ' + (u.notifications_sent || 0) + ' Nachrichten</span></div>'
      + '<div class="user-actions">'
      + (blocked
          ? '<button class="action-btn success" onclick="unblockUser(&apos;' + u.chat_id + '&apos;)">✅ Entsperren</button>'
          : '<button class="action-btn danger" onclick="blockUser(&apos;' + u.chat_id + '&apos;)">🚫 Sperren</button>')
      + '<button class="action-btn" onclick="testSingleUser(&apos;' + u.chat_id + '&apos;)">📤 Test</button>'
      + '</div></div>';
  }
  document.getElementById('telegram-users').innerHTML = html;
}
async function blockUser(chatId) {
  if (!confirm('Diesen Nutzer sperren?')) return;
  await fetch(API_BASE + '/api/telegram-user/' + chatId + '/block', { method: 'POST' });
  loadTelegramUsers();
}
async function unblockUser(chatId) {
  await fetch(API_BASE + '/api/telegram-user/' + chatId + '/unblock', { method: 'POST' });
  loadTelegramUsers();
}
async function testSingleUser(chatId) {
  await fetch(API_BASE + '/api/telegram-user/' + chatId + '/test', { method: 'POST' });
  alert('Test gesendet');
}
async function testNotification() {
  const status = document.getElementById('telegram-status');
  status.style.display = 'block';
  status.className = 'status-bar info';
  status.textContent = '📤 Sende...';
  const res = await fetch(API_BASE + '/api/test-telegram');
  const data = await res.json();
  if (data.success) {
    status.className = 'status-bar success';
    status.textContent = '✅ An ' + data.sent + ' von ' + data.total + ' gesendet.';
  } else {
    status.className = 'status-bar error';
    status.textContent = '❌ ' + (data.message || 'Fehler');
  }
}
async function saveSettings() {
  const types = Array.from(document.querySelectorAll('.ptype:checked')).map(c => c.value);
  const body = {
    max_price: parseInt(document.getElementById('max_price').value),
    target_city: document.getElementById('target_city').value,
    allowed_property_types: types,
  };
  await fetch(API_BASE + '/api/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const msg = document.getElementById('settings-success');
  msg.style.display = 'block';
  setTimeout(() => msg.style.display = 'none', 3000);
}
function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

loadAllListings();
</script>
</body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
}

// ============================================================
//  JSON Response Helper
// ============================================================
function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { "Content-Type": "application/json;charset=UTF-8" } });
}
