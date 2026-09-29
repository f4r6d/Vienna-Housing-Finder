# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-09-29

### Added
- Initial release
- Automated scraping of Willhaben.at listings
- Workers AI integration (Qwen 3.8 27B) for structured data extraction
- TypeSafe Jev Engine evaluation with score-based filtering
- Telegram bot with `/start`, `/stop`, `/status` commands
- Server-rendered web dashboard with 4 tabs (Listings, Logs, Telegram, Settings)
- Cloudflare D1 persistence
- Mutex lock to prevent overlapping cron runs
- AI quota management (auto-skip extraction for 24h when exhausted)
- Edit detection (updates existing records when address + size match)
- Duplicate detection via `willhaben_code` unique index
- Automatic log cleanup (48-hour retention)
