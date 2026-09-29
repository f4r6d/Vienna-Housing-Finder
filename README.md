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
