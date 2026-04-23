# Russians in Vietnam — website

This is a lightweight **static website** for a Telegram community: Russians living/traveling/doing business in Vietnam.

## Pages

- `index.html` — Home
- `cities/index.html` — Cities directory (with search + region filters)
- `business/index.html` — Business directory (with search + category filters)
- `guides/index.html` — Guides / general info
- `search/index.html` — **Telegram-backed search** (keyword + category + city + time range, RU/EN/VI)
- `about/index.html` — About, rules, contact

## Telegram search system

The `/search/` page queries a Supabase database that's kept in sync by a small Python listener which reads the public Telegram channel and enriches every message with categories + RU/EN/VI translations using OpenAI.

- Database schema: [`db/schema.sql`](./db/schema.sql) — paste into the Supabase SQL editor once.
- Listener + backfill: [`listener/`](./listener/README.md).
- Frontend config: edit `supabaseUrl` and `supabaseAnonKey` in [`assets/config.js`](./assets/config.js).

Quick start: see `listener/README.md` for a 15–30 minute setup.

## Important: set your Telegram links

Search and replace these placeholders in the HTML files:

- Main community: `https://t.me/your_telegram_invite`
- City hubs (optional): `https://t.me/your_telegram_city_hcmc` etc.

## Run locally (simple)

Just open `index.html` in your browser.

If you want a local server (recommended for relative links), in PowerShell:

```powershell
cd "C:\Users\mikha\Desktop\VIETNAM CHAT FOR RUSSIANS"
python -m http.server 5173
```

Then open `http://localhost:5173/`.

## Deploy

Because it’s static, you can deploy to:

- Cloudflare Pages
- Netlify
- GitHub Pages
- Any hosting (upload the folder contents)

