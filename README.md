# Vienna Housing Finder 🏠🇦🇹

An automated real-time housing scraper and evaluator for Vienna apartment listings on Willhaben, deployed on Cloudflare Workers and powered by Workers AI and TypeSafe Jev Engine.

## 🚀 Features

- **Automated Scraping:** Periodically fetches real estate listings from Willhaben without requiring external server infrastructure.
- **AI Data Extraction:** Utilizes Cloudflare Workers AI (Qwen, Llama 3.3, Gemma) to convert raw listing HTML into structured JSON metadata (monthly rent, size, location, room count, Gemeindewohnung/Genossenschaft detection).
- **Criteria Evaluation (Jev Engine):** Rates listings using TypeSafe AI rules based on budget, location, property type, and legal suitability for non-EU students.
- **Telegram Bot Alerts:** Delivers instant Telegram notifications for high-matching property alerts.
- **Web Dashboard & Admin Panel:** Responsive mobile-friendly UI connected to Cloudflare D1 (SQLite) for listing filtering, error logging, Telegram user management, and manual run triggers.

## 🛠️ Tech Stack

- **Runtime:** Cloudflare Workers (Serverless JavaScript)
- **Database:** Cloudflare D1 (Serverless Relational SQLite)
- **AI Models:** Cloudflare Workers AI, TypeSafe AI (Jev Engine)
- **Integrations:** Telegram Bot API

## 🛠️ Installation & Deployment Guide

### Option A: Deploy to Cloudflare Workers (Recommended)

This project relies heavily on the Cloudflare ecosystem (Workers, D1, Workers AI). To deploy it to your own Cloudflare account, follow these steps:

**1. Prerequisites**
- Install [Node.js](https://nodejs.org/) and npm.
- Install Wrangler CLI globally: `npm install -g wrangler`
- Login to Cloudflare: `npx wrangler login`

**2. Initialize the Database (Cloudflare D1)**
Create a new D1 database for the project:
\`\`\`bash
npx wrangler d1 create vienna-housing-db
\`\`\`
*Note the output of this command. It will give you the `database_name` and `database_id`.*

**3. Configure `wrangler.toml`**
Create a `wrangler.toml` file in the root directory and add your D1 bindings:
\`\`\`toml
name = "vienna-housing"
main = "src/index.js"
compatibility_date = "2024-02-08"

# Optional: Set native cron trigger (runs every 5 minutes)
[triggers]
crons = ["*/5 * * * *"]

[[d1_databases]]
binding = "DB"
database_name = "vienna-housing-db"
database_id = "YOUR_DATABASE_ID_HERE"
\`\`\`

**4. Set up the Database Schema**
Create a file named `schema.sql` in the root of your project with the following content (this includes the base tables and default configuration settings):

\`\`\`sql
CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  willhaben_code TEXT UNIQUE NOT NULL,
  url TEXT NOT NULL,
  title TEXT,
  scraped_at TEXT DEFAULT (datetime('now')),
  extracted_data TEXT,
  extraction_done INTEGER DEFAULT 0,
  jev_result TEXT,
  jev_score REAL DEFAULT 0,
  jev_done INTEGER DEFAULT 0,
  status TEXT DEFAULT 'new',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  image_url TEXT, address TEXT, size_m2 REAL, total_cost_eur REAL, raw_text TEXT
);

CREATE TABLE IF NOT EXISTS notified_listings (
  listing_id INTEGER NOT NULL,
  chat_id TEXT NOT NULL,
  sent_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (listing_id, chat_id)
);

CREATE TABLE IF NOT EXISTS request_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service TEXT NOT NULL,
  url TEXT,
  status INTEGER,
  request_snippet TEXT,
  response_snippet TEXT,
  error TEXT,
  duration_ms INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scraper_state (
  id INTEGER PRIMARY KEY,
  last_page INTEGER DEFAULT 1,
  is_complete INTEGER DEFAULT 0,
  last_run TEXT,
  updated_at TEXT DEFAULT (datetime('now')),
  last_full_scan TEXT, recheck_after_hours INTEGER DEFAULT 6
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS system_state (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS telegram_users (
  chat_id TEXT PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  subscribed_at TEXT DEFAULT (datetime('now')),
  is_active INTEGER DEFAULT 1,
  is_blocked INTEGER DEFAULT 0, last_seen TEXT, notifications_sent INTEGER DEFAULT 0
);

-- Insert Default Settings
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('max_price', '550'),
  ('allowed_property_types', 'apartment,studio'),
  ('exclude_gemeindewohnung', 'true'),
  ('exclude_genossenschaft', 'true'),
  ('target_city', 'Wien');
\`\`\`

Now, execute this schema on your remote Cloudflare D1 database:
\`\`\`bash
npx wrangler d1 execute vienna-housing-db --remote --file=./schema.sql
\`\`\`

**5. Add Environment Secrets**
Add your sensitive API keys securely using Wrangler:
\`\`\`bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TYPESAFE_API_KEY
npx wrangler secret put TELEGRAM_ADMIN_CHAT_ID
\`\`\`

**6. Deploy!**
Deploy your worker to Cloudflare:
\`\`\`bash
npx wrangler deploy
\`\`\`

---

### Option B: Deploy to a Personal VPS / Ubuntu Server

Since this code uses Cloudflare-specific bindings (`env.DB` for SQLite, `env.AI` for Workers AI), running it directly on a standard Node.js environment requires a compatibility layer. You can containerize the application using Docker and Cloudflare's `workerd` runtime (Miniflare) to mimic the Workers environment on your own Linux server.

**1. Create a `docker-compose.yml` file:**
\`\`\`yaml
version: '3.8'
services:
  worker:
    image: cloudflare/workerd:latest
    volumes:
      - ./:/app
      - worker-data:/app/.wrangler
    working_dir: /app
    ports:
      - "8787:8787"
    command: ["workerd", "serve", "wrangler.toml"]
    restart: unless-stopped

volumes:
  worker-data:
\`\`\`

**2. Initialize Local Database**
Before starting the container, create the local SQLite database that `workerd` will use:
\`\`\`bash
npx wrangler d1 execute vienna-housing-db --local --file=./schema.sql
\`\`\`

**3. Run the Container**
Start the service in detached mode:
\`\`\`bash
docker-compose up -d
\`\`\`
Your application will now be running at `http://localhost:8787`. For production access, you can route it through an Nginx reverse proxy.

*Note: If you self-host, Cloudflare Workers AI calls (`env.AI`) will still require an active internet connection to route requests to Cloudflare's AI network, unless you modify the code to connect to a local LLM instance (e.g., Ollama via an OpenAI-compatible API).*
