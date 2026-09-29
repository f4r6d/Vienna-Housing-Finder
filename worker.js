// ============================================================
//  Willhaben Wien Finder — Version 21.0
//  Fixed: Working Tabs (Logs, Telegram, Settings)
// ============================================================

const WORKERS_AI_MODEL = "@cf/qwen/qwen3.8-27b";
const JEV_MODEL = "jev-1.13.0";

const TIME_BUDGET_MS = 25000;
const NOTIFICATION_THRESHOLD = 0.7;
const MAX_PAGES_PER_RUN = 5;
const SCRAPE_TIME_LIMIT = 10000;
const WORKER_URL = "https://vienna-housing.lizadferi3.workers.dev";
const CRON_LOCK_TIMEOUT_MS = 480000;
const CLEANUP_INTERVAL_MS = 600000;
const LOG_RETENTION_HOURS = 48;
const PER_PAGE = 20;
const LOGS_PER_PAGE = 50;

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(handleCron(env)); },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/telegram/webhook" && request.method === "POST") {
      return handleTelegramWebhook(env, request);
    }

    // API Routes
    if (url.pathname === "/api/stats") return handleGetStats(env);
    if (url.pathname === "/api/logs") return handleGetLogs(env, url);
    if (url.pathname === "/api/telegram-users") return handleGetTelegramUsers(env);
    if (url.pathname === "/api/test-telegram") return handleTestTelegram(env);
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

    const response = await serveUI(env, url);
    const newHeaders = new Headers(response.headers);
    newHeaders.set("Cache-Control", "no-store");
    return new Response(response.body, { status: response.status, headers: newHeaders });
  },
};

// ============================================================
//  Mutex Lock
// ============================================================
async function acquireCronLock(env) {
  try {
    const row = await env.DB.prepare(`SELECT value, updated_at FROM system_state WHERE key = 'cron_running'`).first();
    if (row && row.value === '1') {
      const updatedAt = row.updated_at ? new Date(row.updated_at.replace(' ', 'T') + 'Z').getTime() : 0;
      const age = Number.isNaN(updatedAt) ? 0 : Date.now() - updatedAt;
      if (age < CRON_LOCK_TIMEOUT_MS) return false;
    }
    await env.DB.prepare(`
      INSERT INTO system_state (key, value, updated_at) VALUES ('cron_running', '1', datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = datetime('now')
    `).run();
    return true;
  } catch { return true; }
}

async function releaseCronLock(env) {
  try { await env.DB.prepare(`UPDATE system_state SET value = '0', updated_at = datetime('now') WHERE key = 'cron_running'`).run(); } catch {}
}

// ============================================================
//  Quota
// ============================================================
async function isAiQuotaExhausted(env) {
  try {
    const row = await env.DB.prepare(`SELECT value FROM system_state WHERE key = 'ai_quota_exhausted_until'`).first();
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
  const locked = await acquireCronLock(env);
  if (!locked) { console.log("⏭️ Cron läuft bereits"); return; }

  console.log("⏰ Cron gestartet:", new Date().toISOString());
  const successLogs = [];

  try {
    const settings = await loadSettings(env);

    await scrapeWillhabenPages(env);
    console.log(`   ⏱️ Scraping: ${Date.now() - startTime}ms`);

    const quotaExhausted = await isAiQuotaExhausted(env);
    if (quotaExhausted) {
      console.log("   ⚠️ AI Quota erschöpft");
    } else if (Date.now() - startTime < TIME_BUDGET_MS - 12000) {
      await runExtractionStage(env, 3, successLogs);
      console.log(`   ⏱️ Extraction: ${Date.now() - startTime}ms`);
    }

    await runJevStage(env, settings, 10, successLogs);
    console.log(`   ⏱️ Jev: ${Date.now() - startTime}ms`);

    // Cleanup
    const cleanupRow = await env.DB.prepare(`SELECT updated_at FROM system_state WHERE key = 'last_cleanup'`).first();
    const lastCleanup = cleanupRow?.updated_at ? new Date(cleanupRow.updated_at.replace(' ', 'T') + 'Z').getTime() : 0;
    const lastCleanupSafe = Number.isNaN(lastCleanup) ? 0 : lastCleanup;
    if (Date.now() - lastCleanupSafe > CLEANUP_INTERVAL_MS) {
      await env.DB.prepare(`DELETE FROM request_logs WHERE created_at < datetime('now', '-${LOG_RETENTION_HOURS} hours')`).run();
      await env.DB.prepare(`
        INSERT INTO system_state (key, value, updated_at) VALUES ('last_cleanup', '1', datetime('now'))
        ON CONFLICT(key) DO UPDATE SET updated_at = datetime('now')
      `).run();
    }

    // Batch success logs
    if (successLogs.length > 0) {
      const stmt = env.DB.prepare(`
        INSERT INTO request_logs (service, url, status, response_snippet, created_at)
        VALUES (?, ?, 200, ?, datetime('now'))
      `);
      const batch = successLogs.map(l => stmt.bind(
        l.service, (l.url || "").substring(0, 500), (l.message || "").substring(0, 500)
      ));
      await env.DB.batch(batch);
      console.log(`   📝 ${successLogs.length} Success-Logs`);
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
  try { await env.DB.batch(batch); } catch { return 0; }
  return newListings.length;
}

// ============================================================
//  STAGE 2: Workers AI
// ============================================================
async function runExtractionStage(env, limit, successLogs) {
  const { results } = await env.DB.prepare(`
    SELECT id, url, title FROM listings WHERE extraction_done = 0
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

    if (address && sizeM2) {
      const dup = await env.DB.prepare(`
        SELECT id FROM listings WHERE address = ? AND size_m2 = ? AND id != ? AND extraction_done = 1 LIMIT 1
      `).bind(address, sizeM2, listing.id).first();
      if (dup) {
        await env.DB.prepare(`DELETE FROM listings WHERE id = ?`).bind(listing.id).run();
        await env.DB.prepare(`
          UPDATE listings SET title = ?, url = ?, willhaben_code = ?,
              extracted_data = ?, image_url = ?, raw_text = ?,
              address = ?, size_m2 = ?, total_cost_eur = ?,
              extraction_done = 1, jev_done = 0, jev_score = 0, jev_result = NULL,
              updated_at = datetime('now') WHERE id = ?
        `).bind(listing.title, listing.url, listing.willhaben_code || null,
          JSON.stringify(extraction), imageUrl, cleanText, address, sizeM2, totalCost, dup.id).run();
        successLogs.push({ service: "workers-ai", url: WORKERS_AI_MODEL, message: `#${listing.id} → EDIT` });
        continue;
      }
    }

    await env.DB.prepare(`
      UPDATE listings SET extracted_data = ?, extraction_done = 1, image_url = ?, raw_text = ?,
          address = ?, size_m2 = ?, total_cost_eur = ?, updated_at = datetime('now')
      WHERE id = ?
    `).bind(JSON.stringify(extraction), imageUrl, cleanText, address, sizeM2, totalCost, listing.id).run();

    successLogs.push({ service: "workers-ai", url: WORKERS_AI_MODEL, message: `#${listing.id}: ${address || '?'} (${totalCost || '?'} EUR)` });
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
    await logError(env, "workers-ai", WORKERS_AI_MODEL, error);
    if (error.includes("4006") || error.includes("daily free allocation")) await markAiQuotaExhausted(env);
    return null;
  }
}

// ============================================================
//  STAGE 3: Jev
// ============================================================
async function runJevStage(env, settings, limit, successLogs) {
  const { results } = await env.DB.prepare(`
    SELECT id, url, title, extracted_data, raw_text FROM listings
    WHERE extraction_done = 1 AND jev_done = 0 ORDER BY updated_at ASC LIMIT ?
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
      "nicht für wohnzwecke", "nicht fuer wohnzwecke", "nur als arbeitsraum",
      "geschäftsraum", "gewerbeobjekt", "gewerbeimmobilie", "bürofläche", "bueroflaeche",
      "gemeindewohnung", "gemeindebau", "wiener wohnen", "wiener wohnticket",
      "wohnticket", "bonuspunkte", "vormerkschein", "genossenschaftswohnung",
      "genossenschaft", "direktvergabe", "kurzzeitmiete",
    ];
    const wgPatterns = [/\bwg\b/i, /wohngemeinschaft/i, /mitbewohner/i, /zimmer in/i, /zimmer frei/i, /wg[- ]zimmer/i, /\bwg\s*[-:]/i];

    const foundKeywords = negativeKeywords.filter(kw => allText.includes(kw));
    const foundWg = wgPatterns.filter(re => re.test(allText));
    const isReserved = /reserviert/i.test(allText);

    const allowedTypes = settings.allowed_property_types || [];
    const isWgType = extracted.property_type === 'wg_room';
    const rejectWg = (foundWg.length > 0 || isWgType) && !allowedTypes.includes('wg_room');

    if (foundKeywords.length > 0 || rejectWg || isReserved) {
      const reasons = [];
      if (foundKeywords.length > 0) reasons.push(`Keywords: ${foundKeywords.join(", ")}`);
      if (rejectWg) reasons.push("WG");
      if (isReserved) reasons.push("Reserviert");
      await env.DB.prepare(`
        UPDATE listings SET jev_result = ?, jev_score = 0, jev_done = 1,
          status = CASE WHEN status = 'new' THEN 'archived' ELSE status END,
          updated_at = datetime('now') WHERE id = ?
      `).bind(JSON.stringify({ rejected: true, reason: reasons.join(" | ") }), listing.id).run();
      successLogs.push({ service: "jev", url: JEV_MODEL, message: `#${listing.id}: REJECTED — ${reasons.join(" | ").substring(0, 80)}` });
      continue;
    }

    if (extracted.property_type && !allowedTypes.includes(extracted.property_type) && extracted.property_type !== 'other') {
      await env.DB.prepare(`
        UPDATE listings SET jev_result = ?, jev_score = 0, jev_done = 1,
          status = CASE WHEN status = 'new' THEN 'archived' ELSE status END,
          updated_at = datetime('now') WHERE id = ?
      `).bind(JSON.stringify({ rejected: true, reason: `Typ "${extracted.property_type}"` }), listing.id).run();
      successLogs.push({ service: "jev", url: JEV_MODEL, message: `#${listing.id}: REJECTED — Typ ${extracted.property_type}` });
      continue;
    }

    const jevInput = `Titel: ${listing.title || "?"}
Gesamtkosten pro Monat: ${extracted.total_monthly_cost_eur ? extracted.total_monthly_cost_eur + " EUR" : "?"}
Kaltmiete: ${extracted.cold_rent_eur ? extracted.cold_rent_eur + " EUR" : "?"}
Adresse: ${extracted.address || "?"}
Wohnfläche: ${extracted.size_m2 ? extracted.size_m2 + " m²" : "?"}
Zimmer: ${extracted.rooms || "?"}
Objekttyp: ${extracted.property_type || "?"}
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

      const verdict = score >= NOTIFICATION_THRESHOLD ? "APPROVED" : "Low";
      successLogs.push({ service: "jev", url: JEV_MODEL, message: `#${listing.id}: ${verdict} — Score ${(score * 100).toFixed(0)}%` });

      if (score >= NOTIFICATION_THRESHOLD) {
        try { await notifyTelegram(env, { ...listing, jev_score: score, extracted }); } catch {}
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
//  Logging
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
//  Telegram
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
        ON CONFLICT(chat_id) DO UPDATE SET username = excluded.username, first_name = excluded.first_name,
          is_active = 1, last_seen = datetime('now')
      `).bind(chatId, username, firstName).run();
      await sendTelegramWithKeyboard(env, chatId, `✅ *Willkommen!*`);
    }
    else if (text === "/stop" || text === "⏸ Stop") {
      await env.DB.prepare(`UPDATE telegram_users SET is_active = 0 WHERE chat_id = ?`).bind(chatId).run();
      await sendTelegramWithKeyboard(env, chatId, `🔕 Abbestellt.`);
    }
    else if (text === "/status" || text === "📊 Status") {
      const { results } = await env.DB.prepare(`SELECT COUNT(*) as count FROM telegram_users WHERE is_active = 1 AND is_blocked = 0`).all();
      await sendTelegramWithDashboardButton(env, chatId, `📊 *Status*\n\nAktive Nutzer: *${results[0]?.count || 0}*`);
    }
    else {
      await sendTelegramWithKeyboard(env, chatId, `Verfügbare Tasten: ⏸ Stop, ▶️ Start, 📊 Status`);
    }
    return json({ ok: true });
  } catch (err) { return json({ ok: false, error: err.toString() }, 500); }
}

async function sendTelegramMessage(env, chatId, text, extra = {}) {
  if (!env.TELEGRAM_BOT_TOKEN) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown', disable_web_page_preview: false, ...extra }),
    });
    return await res.json();
  } catch { return null; }
}

async function sendTelegramWithKeyboard(env, chatId, text) {
  return sendTelegramMessage(env, chatId, text, {
    reply_markup: { keyboard: [[{ text: "⏸ Stop" }, { text: "▶️ Start" }], [{ text: "📊 Status" }]], resize_keyboard: true, one_time_keyboard: true }
  });
}

async function sendTelegramWithDashboardButton(env, chatId, text) {
  return sendTelegramMessage(env, chatId, text, {
    reply_markup: { inline_keyboard: [[{ text: "🌐 Dashboard", url: WORKER_URL }]] }
  });
}

async function notifyTelegram(env, listing) {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  const { results: users } = await env.DB.prepare(`SELECT chat_id FROM telegram_users WHERE is_active = 1 AND is_blocked = 0`).all();
  if (users.length === 0) return;
  const score = ((listing.jev_score || 0) * 100).toFixed(0);
  const ext = listing.extracted || {};
  const price = ext.total_monthly_cost_eur ? `€ ${ext.total_monthly_cost_eur}` : 'Preis unbekannt';
  const size = ext.size_m2 ? `${ext.size_m2} m²` : '';
  const rooms = ext.rooms ? `${ext.rooms} Zi.` : '';
  const address = ext.address || listing.title || 'Unbekannt';
  const messageText = `🏠 *Neue passende Wohnung!*\n\n📍 ${address}\n💰 ${price}${size ? ` · 📐 ${size}` : ''}${rooms ? ` · 🚪 ${rooms}` : ''}\n⭐ Score: *${score}%*\n\n[🔗 Auf Willhaben öffnen](${listing.url})`;

  for (const user of users) {
    try {
      const existing = await env.DB.prepare(`SELECT 1 FROM notified_listings WHERE listing_id = ? AND chat_id = ?`).bind(listing.id, user.chat_id).first();
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
  const limit = Math.min(100, parseInt(url.searchParams.get("limit") || "50"));
  const service = url.searchParams.get("service") || "";
  const status = url.searchParams.get("status") || "";
  let query = `SELECT id, service, url, status, error, response_snippet, created_at FROM request_logs WHERE created_at >= datetime('now', '-48 hours')`;
  const params = [];
  if (service) { query += ` AND service = ?`; params.push(service); }
  if (status === "success") query += ` AND status = 200`;
  if (status === "error") query += ` AND status >= 400`;
  query += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);
  const { results } = await env.DB.prepare(query).bind(...params).all();
  return json({ logs: results });
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
  const { results: users } = await env.DB.prepare(`SELECT chat_id FROM telegram_users WHERE is_active = 1 AND is_blocked = 0`).all();
  if (users.length === 0) return json({ success: false, message: "Keine aktiven Nutzer", sent: 0 });
  let sent = 0;
  for (const user of users) {
    const result = await sendTelegramMessage(env, user.chat_id, `🧪 Test ✅`);
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

async function handleSaveSettings(env, request) {
  try {
    const body = await request.json();
    const stmt = env.DB.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
    `);
    const batch = [];
    for (const [k, v] of Object.entries(body)) batch.push(stmt.bind(k, Array.isArray(v) ? v.join(",") : String(v)));
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
    UPDATE listings SET extraction_done = 0, jev_done = 0, jev_score = 0, jev_result = NULL,
        extracted_data = NULL, raw_text = NULL,
        status = CASE WHEN status IN ('archived') THEN 'new' ELSE status END,
        updated_at = datetime('now') WHERE id = ?
  `).bind(id).run();
  return json({ success: true, id });
}

async function handleRetryAllFailed(env) {
  await clearAiQuotaExhausted(env);
  const result = await env.DB.prepare(`
    UPDATE listings SET extraction_done = 0, jev_done = 0, jev_score = 0, jev_result = NULL,
        extracted_data = NULL, raw_text = NULL,
        status = CASE WHEN status IN ('archived') THEN 'new' ELSE status END,
        updated_at = datetime('now') WHERE extraction_done = -1 OR jev_done = -1
  `).run();
  return json({ success: true, changes: result.meta?.changes || 0 });
}

async function handleUpdateStatus(env, id, status) {
  await env.DB.prepare(`UPDATE listings SET status = ?, updated_at = datetime('now') WHERE id = ?`).bind(status, id).run();
  return json({ success: true });
}

// ============================================================
//  UI — Server-Side Rendering mit Tabs
// ============================================================
async function serveUI(env, url) {
  const tab = url.searchParams.get("tab") || "listings";

  // 🔧 Parallel: Stats + Settings + Telegram-Users für Header
  const [stats, settings, tgUsers, quotaExhausted] = await Promise.all([
    env.DB.prepare(`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN status = 'favorite' THEN 1 ELSE 0 END) as favorites,
        SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END) as archived,
        SUM(CASE WHEN extraction_done = -1 OR jev_done = -1 THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN (extraction_done = 0 OR jev_done = 0) AND extraction_done >= 0 AND jev_done >= 0 THEN 1 ELSE 0 END) as pending
      FROM listings
    `).first(),
    loadSettings(env),
    env.DB.prepare(`SELECT COUNT(*) as count FROM telegram_users WHERE is_active = 1 AND is_blocked = 0`).first(),
    isAiQuotaExhausted(env),
  ]);

  // محتوای تب
  let tabContent = "";
  if (tab === "logs") tabContent = await renderLogsTab(env, url);
  else if (tab === "telegram") tabContent = await renderTelegramTab(env);
  else if (tab === "settings") tabContent = renderSettingsTab(settings);
  else tabContent = await renderListingsTab(env, url);

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
  .tab { flex: 1; padding: 14px 8px; border: none; background: none; cursor: pointer; font-size: 13px; font-weight: 600; color: #666; border-bottom: 3px solid transparent; min-height: 48px; white-space: nowrap; font-family: inherit; text-decoration: none; text-align: center; display: flex; align-items: center; justify-content: center; }
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
  .filter-btn { display: inline-block; padding: 8px 14px; border: 1px solid #d2d2d7; border-radius: 20px; background: white; cursor: pointer; font-size: 13px; font-weight: 600; white-space: nowrap; flex-shrink: 0; color: #1d1d1f; font-family: inherit; min-height: 36px; user-select: none; text-decoration: none; line-height: 1.4; }
  .filter-btn.active { background: #0071e3; color: white; border-color: #0071e3; font-weight: 700; }
  .quota-banner { padding: 12px 16px; background: #fff3cd; border-radius: 12px; margin-bottom: 14px; font-size: 13px; color: #856404; border: 1px solid #ffc107; }
  .pagination { display: flex; justify-content: space-between; align-items: center; margin: 12px 0; padding: 12px; background: white; border-radius: 12px; }
  .page-btn { padding: 10px 16px; border: 1px solid #d2d2d7; border-radius: 10px; background: white; cursor: pointer; font-size: 13px; font-weight: 600; font-family: inherit; text-decoration: none; color: #1d1d1f; display: inline-block; }
  .page-btn.disabled { opacity: 0.3; cursor: not-allowed; }
  .page-btn:hover { background: #f0f0f5; }
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
  .log-status-ok { color: #34c759; font-weight: 700; font-size: 12px; }
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
  .action-btn { padding: 10px 16px; border: 1px solid #d2d2d7; border-radius: 10px; background: white; cursor: pointer; font-size: 13px; font-weight: 600; min-height: 42px; font-family: inherit; text-decoration: none; display: inline-block; color: #1d1d1f; }
  .action-btn.danger { border-color: #ff3b30; color: #ff3b30; }
  .action-btn.success { border-color: #34c759; color: #34c759; }
  .action-btn.active { background: #0071e3; color: white; border-color: #0071e3; }
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
  .log-filters { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 14px; }
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
    <div class="stat"><div class="stat-value">${stats?.pending || 0}</div><div class="stat-label">Wartend</div></div>
    <div class="stat"><div class="stat-value">${stats?.failed || 0}</div><div class="stat-label">Fehler</div></div>
  </div>
</div>

<div class="tabs">
  <a class="tab ${tab === 'listings' ? 'active' : ''}" href="/">📋 Anzeigen</a>
  <a class="tab ${tab === 'logs' ? 'active' : ''}" href="/?tab=logs">📊 Logs</a>
  <a class="tab ${tab === 'telegram' ? 'active' : ''}" href="/?tab=telegram">📱 Telegram</a>
  <a class="tab ${tab === 'settings' ? 'active' : ''}" href="/?tab=settings">⚙️ Einstellungen</a>
</div>

<div class="container">
  ${quotaExhausted && tab === 'listings' ? '<div class="quota-banner">⚠️ <strong>AI-Kontingent erschöpft</strong></div>' : ''}
  ${tabContent}
</div>

<script>
const API_BASE = '${url.origin}';

async function toggleFavorite(id, currentStatus) {
  const endpoint = currentStatus === 'favorite' ? '/api/unfavorite/' : '/api/favorite/';
  await fetch(API_BASE + endpoint + id, { method: 'POST' });
  location.reload();
}
async function toggleArchive(id, currentStatus) {
  const endpoint = currentStatus === 'archived' ? '/api/unarchive/' : '/api/archive/';
  await fetch(API_BASE + endpoint + id, { method: 'POST' });
  location.reload();
}
async function retryListing(id) {
  await fetch(API_BASE + '/api/retry/' + id, { method: 'POST' });
  location.reload();
}
async function retryAllFailed() {
  if (!confirm('Alle fehlgeschlagenen erneut verarbeiten?')) return;
  const res = await fetch(API_BASE + '/api/retry-all-failed', { method: 'POST' });
  const data = await res.json();
  if (data.success) { alert('✅ ' + data.changes + ' Anzeigen markiert.'); location.reload(); }
}
async function forceRun() {
  if (!confirm('Cron jetzt starten?')) return;
  await fetch(API_BASE + '/api/force-run');
  alert('✅ Cron gestartet. In 60 Sekunden Seite aktualisieren.');
}
async function resetAll() {
  if (!confirm('Alle Anzeigen werden gelöscht!')) return;
  await fetch(API_BASE + '/api/reset-all');
  location.reload();
}
async function testAll() {
  if (!confirm('Test-Nachricht an alle senden?')) return;
  const res = await fetch(API_BASE + '/api/test-telegram');
  const data = await res.json();
  alert(data.success ? '✅ ' + data.sent + '/' + data.total : '❌ ' + (data.message || 'Fehler'));
}
async function blockUser(chatId) {
  if (!confirm('Sperren?')) return;
  await fetch(API_BASE + '/api/telegram-user/' + chatId + '/block', { method: 'POST' });
  location.reload();
}
async function unblockUser(chatId) {
  await fetch(API_BASE + '/api/telegram-user/' + chatId + '/unblock', { method: 'POST' });
  location.reload();
}
async function testSingle(chatId) {
  await fetch(API_BASE + '/api/telegram-user/' + chatId + '/test', { method: 'POST' });
  alert('✅ OK');
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
</script>
</body>
</html>`;

  return new Response(html, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
}

// ============================================================
//  Tab Renderers
// ============================================================
async function renderListingsTab(env, url) {
  const filter = url.searchParams.get("filter") || "approved";
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1"));
  const offset = (page - 1) * PER_PAGE;

  let whereClause = "";
  if (filter === "approved") whereClause = "WHERE jev_done = 1 AND jev_score >= 0.7 AND status != 'archived' AND (jev_result IS NULL OR jev_result NOT LIKE '%\"rejected\":true%')";
  else if (filter === "favorite") whereClause = "WHERE status = 'favorite'";
  else if (filter === "archived") whereClause = "WHERE status = 'archived'";
  else if (filter === "new") whereClause = "WHERE status = 'new' AND (jev_result IS NULL OR jev_result NOT LIKE '%\"rejected\":true%') AND extraction_done >= 0 AND jev_done >= 0";
  else if (filter === "failed") whereClause = "WHERE extraction_done = -1 OR jev_done = -1";
  else if (filter === "pending") whereClause = "WHERE (extraction_done = 0 OR jev_done = 0) AND extraction_done >= 0 AND jev_done >= 0";
  else if (filter === "rejected") whereClause = "WHERE jev_result LIKE '%\"rejected\":true%'";

  const [listingsRes, totalRes] = await Promise.all([
    env.DB.prepare(`
      SELECT id, willhaben_code, url, title, scraped_at, extracted_data, extraction_done,
             jev_result, jev_score, jev_done, status, image_url,
             address, size_m2, total_cost_eur
      FROM listings ${whereClause}
      ORDER BY jev_score DESC, scraped_at DESC
      LIMIT ? OFFSET ?
    `).bind(PER_PAGE, offset).all(),
    env.DB.prepare(`SELECT COUNT(*) as cnt FROM listings ${whereClause}`).first(),
  ]);

  const listings = listingsRes.results || [];
  const total = totalRes?.cnt || 0;
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));

  const cardsHtml = listings.length > 0 ? listings.map(renderCardServer).join("") :
    '<div class="empty"><div class="empty-icon">🏠</div><h2>Keine Anzeigen</h2></div>';

  const paginationHtml = totalPages > 1 ? `
    <div class="pagination">
      ${page > 1 ? `<a href="/?filter=${filter}&page=${page - 1}" class="page-btn">◀ Zurück</a>` : `<span class="page-btn disabled">◀ Zurück</span>`}
      <span class="info">Seite ${page} / ${totalPages} (${total})</span>
      ${page < totalPages ? `<a href="/?filter=${filter}&page=${page + 1}" class="page-btn">Weiter ▶</a>` : `<span class="page-btn disabled">Weiter ▶</span>`}
    </div>
  ` : "";

  const filterBtns = [
    ["approved", "✅ Bestätigt"], ["all", "Alle"], ["favorite", "⭐ Favoriten"],
    ["new", "🆕 Neu"], ["pending", "⏳ Wartend"], ["archived", "📦 Archiv"],
    ["rejected", "⛔ Abgelehnt"], ["failed", "⚠️ Fehler"],
  ].map(([key, label]) =>
    `<a href="/?filter=${key}&page=1" class="filter-btn ${filter === key ? 'active' : ''}">${label}</a>`
  ).join("");

  return `
    <div class="toolbar">
      <div class="toolbar-actions">
        <button class="primary" onclick="forceRun()">⚡ Jetzt ausführen</button>
        <button class="warning" onclick="retryAllFailed()">🔄 Alle Fehler erneut</button>
        <button class="danger" onclick="resetAll()">🗑️ Löschen</button>
      </div>
    </div>
    <div class="filter-scroll-wrapper"><div class="filter-scroll-inner">${filterBtns}</div></div>
    ${paginationHtml}
    <div id="listings-container">${cardsHtml}</div>
    ${paginationHtml}
  `;
}

async function renderLogsTab(env, url) {
  const service = url.searchParams.get("service") || "";
  const statusFilter = url.searchParams.get("status") || "";

  let query = `SELECT id, service, url, status, error, response_snippet, created_at FROM request_logs WHERE created_at >= datetime('now', '-48 hours')`;
  const params = [];
  if (service) { query += ` AND service = ?`; params.push(service); }
  if (statusFilter === "success") query += ` AND status = 200`;
  if (statusFilter === "error") query += ` AND status >= 400`;
  query += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(LOGS_PER_PAGE);

  const { results: logs } = await env.DB.prepare(query).bind(...params).all();

  const filterLinks = [
    ["", "", "🔄 Alle"],
    ["service=willhaben", "", "📥 Willhaben"],
    ["service=workers-ai", "", "🤖 Workers AI"],
    ["service=jev", "", "⚖️ Jev"],
    ["service=telegram", "", "📱 Telegram"],
    ["status=success", "", "✅ Erfolge"],
    ["status=error", "", "❌ Fehler"],
  ].map(([q, _, label]) => {
    const isActive =
      (q === "" && !service && !statusFilter) ||
      (q.startsWith("service=") && service === q.split("=")[1]) ||
      (q === "status=success" && statusFilter === "success") ||
      (q === "status=error" && statusFilter === "error");
    return `<a href="/?tab=logs${q ? '&' + q : ''}" class="action-btn ${isActive ? 'active' : ''}">${label}</a>`;
  }).join(" ");

  let logsHtml = '';
  if (!logs || logs.length === 0) {
    logsHtml = '<div class="empty"><div class="empty-icon">📋</div><h2>Keine Logs</h2></div>';
  } else {
    logsHtml = logs.map(log => {
      const ok = log.status >= 200 && log.status < 300;
      const statusCls = ok ? 'log-status-ok' : 'log-status-err';
      const snip = log.error || log.response_snippet || '–';
      return '<div class="log-card">'
        + '<div class="log-card-header">'
        + '<span class="log-card-time">' + escHtml(log.created_at || '') + '</span>'
        + '<div style="display:flex;gap:6px;">'
        + '<span class="log-service ' + escHtml(log.service || '') + '">' + escHtml(log.service || '') + '</span>'
        + '<span class="' + statusCls + '">' + (log.status || '?') + '</span>'
        + '</div></div>'
        + '<div><div class="log-row"><div class="log-label">Info</div><div class="log-value">' + escHtml(snip.substring(0, 250)) + '</div></div>'
        + (log.url && log.url !== log.service ? '<div class="log-row"><div class="log-label">URL</div><div class="log-value">' + escHtml(log.url.substring(0, 100)) + '</div></div>' : '')
        + '</div></div>';
    }).join('');
  }

  return `
    <div class="log-filters">${filterLinks}</div>
    <div>${logsHtml}</div>
  `;
}

async function renderTelegramTab(env) {
  const { results: users } = await env.DB.prepare(`
    SELECT chat_id, username, first_name, subscribed_at, last_seen, is_active, is_blocked, notifications_sent
    FROM telegram_users ORDER BY subscribed_at DESC
  `).all();

  let usersHtml = '';
  if (!users || users.length === 0) {
    usersHtml = '<div class="empty"><div class="empty-icon">👥</div><h2>Keine Nutzer</h2><p>Sende /start an den Bot.</p></div>';
  } else {
    usersHtml = '<h3 style="margin:14px 0 10px;font-size:14px;">👥 ' + users.length + ' Nutzer</h3>';
    for (const u of users) {
      const blocked = u.is_blocked === 1;
      const active = u.is_active === 1;
      let statusBadge = blocked ? '<span class="badge badge-blocked">🚫 Blockiert</span>'
        : (active ? '<span class="badge badge-match">✓ Aktiv</span>'
        : '<span class="badge badge-archived">⏸ Inaktiv</span>');

      usersHtml += '<div class="user-card">'
        + '<div class="user-info"><strong>' + escHtml(u.first_name || 'Anonym') + (u.username ? ' (@' + escHtml(u.username) + ')' : '') + '</strong>'
        + '<span class="sub">' + statusBadge + ' · ' + (u.notifications_sent || 0) + ' Nachrichten</span></div>'
        + '<div class="user-actions">'
        + (blocked
            ? '<button class="action-btn success" onclick="unblockUser(&apos;' + u.chat_id + '&apos;)">✅ Entsperren</button>'
            : '<button class="action-btn danger" onclick="blockUser(&apos;' + u.chat_id + '&apos;)">🚫 Sperren</button>')
        + '<button class="action-btn" onclick="testSingle(&apos;' + u.chat_id + '&apos;)">📤 Test</button>'
        + '</div></div>';
    }
  }

  return `
    <div class="info-box"><strong>📱 Telegram Bot</strong><br>Nutzer: <strong>${users.length}</strong></div>
    <div style="margin-bottom:16px;">
      <button class="action-btn" onclick="testAll()">📤 Test an alle</button>
    </div>
    <div>${usersHtml}</div>
  `;
}

function renderSettingsTab(settings) {
  const types = settings.allowed_property_types || [];
  return `
    <div class="settings-form">
      <div class="success-msg" id="settings-success">✅ Gespeichert!</div>
      <h2>⚙️ Filter</h2>
      <div class="form-group">
        <label>💰 Max. Preis (EUR)</label>
        <input type="number" id="max_price" value="${settings.max_price || 550}" inputmode="numeric">
      </div>
      <div class="form-group">
        <label>🏙️ Stadt</label>
        <input type="text" id="target_city" value="${escHtml(settings.target_city || 'Wien')}">
      </div>
      <div class="form-group">
        <label>🏠 Erlaubte Typen</label>
        <div class="checkbox-group">
          <label class="checkbox-item"><input type="checkbox" class="ptype" value="apartment" ${types.includes('apartment') ? 'checked' : ''}> <span>Wohnung</span></label>
          <label class="checkbox-item"><input type="checkbox" class="ptype" value="wg_room" ${types.includes('wg_room') ? 'checked' : ''}> <span>WG-Zimmer</span></label>
          <label class="checkbox-item"><input type="checkbox" class="ptype" value="studio" ${types.includes('studio') ? 'checked' : ''}> <span>Studio</span></label>
          <label class="checkbox-item"><input type="checkbox" class="ptype" value="other" ${types.includes('other') ? 'checked' : ''}> <span>Sonstiges</span></label>
        </div>
      </div>
      <button class="save-btn" onclick="saveSettings()">💾 Speichern</button>
    </div>
  `;
}

// ============================================================
//  Card Renderer
// ============================================================
function renderCardServer(l) {
  let extracted = {};
  try { extracted = l.extracted_data ? JSON.parse(l.extracted_data) : {}; } catch {}
  let jevParsed = {};
  try { jevParsed = l.jev_result ? JSON.parse(l.jev_result) : {}; } catch {}

  const score = l.jev_score || 0;
  const scoreColor = score >= 0.7 ? "#34c759" : score >= 0.4 ? "#ff9500" : "#ff3b30";
  const isRejected = jevParsed && jevParsed.rejected === true;
  const isExtractionFailed = l.extraction_done === -1;
  const isJevFailed = l.jev_done === -1;
  const isJevPending = l.extraction_done === 1 && l.jev_done === 0;
  const isFailed = isExtractionFailed || isJevFailed;

  let badge = '<span class="badge badge-pending">⏳ Wartend</span>';
  if (isExtractionFailed) badge = '<span class="badge badge-error">⚠️ Extraction-Fehler</span>';
  else if (isJevFailed) badge = '<span class="badge badge-error">⚠️ Jev-Fehler</span>';
  else if (l.status === 'favorite') badge = '<span class="badge badge-favorite">⭐ Favorit</span>';
  else if (l.status === 'archived') badge = '<span class="badge badge-archived">📦 Archiviert</span>';
  else if (isRejected) badge = '<span class="badge badge-rejected">⛔ Abgelehnt</span>';
  else if (isJevPending) badge = '<span class="badge badge-jev">⚖️ Jev ausstehend</span>';
  else if (l.jev_done === 1) badge = '<span class="badge badge-match">✅ Geprüft</span>';

  const metaItems = [];
  const price = extracted.total_monthly_cost_eur || l.total_cost_eur;
  const size = extracted.size_m2 || l.size_m2;
  const addr = extracted.address || l.address;
  if (price) metaItems.push('<span>💰 € ' + price + '</span>');
  if (size) metaItems.push('<span>📐 ' + size + ' m²</span>');
  if (extracted.rooms) metaItems.push('<span>🚪 ' + extracted.rooms + ' Zi.</span>');
  if (addr) metaItems.push('<span>📍 ' + escHtml(addr) + '</span>');

  const imageBlock = l.image_url
    ? '<img class="card-image" src="' + escHtml(l.image_url) + '" loading="lazy" referrerpolicy="no-referrer" onerror="this.outerHTML=\'&lt;div class=&quot;card-image card-image-placeholder&quot;&gt;🏠&lt;/div&gt;\'">'
    : '<div class="card-image card-image-placeholder">🏠</div>';

  const favLabel = l.status === 'favorite' ? '⭐ Weg' : '⭐ Fav';
  const archLabel = l.status === 'archived' ? '📤' : '📦';

  return '<div class="card" data-status="' + l.status + '" data-id="' + l.id + '">'
    + imageBlock
    + '<div class="card-content">'
    + '<h3>' + escHtml(l.title || 'Unbekannt') + '</h3>'
    + '<div class="meta">' + metaItems.join('') + '</div>'
    + '<div class="card-footer">' + badge
    + (l.jev_done === 1 && !isRejected ? '<span class="card-score">Score: ' + (score * 100).toFixed(0) + '%</span>' : '')
    + '</div>'
    + '<div class="score-bar"><div class="score-fill" style="width:' + (score * 100) + '%;background:' + scoreColor + ';"></div></div>'
    + '</div>'
    + '<div class="card-actions">'
    + '<a href="' + escHtml(l.url) + '" target="_blank" rel="noopener">🔗</a>'
    + (isFailed
        ? '<button class="retry" onclick="retryListing(' + l.id + ')">🔄 Retry</button>'
        : '<button onclick="toggleFavorite(' + l.id + ',\'' + l.status + '\')">' + favLabel + '</button>')
    + '<button onclick="toggleArchive(' + l.id + ',\'' + l.status + '\')">' + archLabel + '</button>'
    + (isFailed ? '<span></span>' : '<span></span>')
    + '</div>'
    + '</div>';
}

function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { "Content-Type": "application/json;charset=UTF-8" } });
}
