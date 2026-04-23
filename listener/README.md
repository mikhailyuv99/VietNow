# Telegram listener

Small Python service that mirrors the public Telegram channel into a Supabase
Postgres database, with AI-generated category tags and RU/EN/VI translations.
The website's `search/` page queries that database.

## What's in this folder

- `common.py` — shared helpers: config loading, Supabase + OpenAI clients, message enrichment and upsert.
- `live.py` — long-running listener (new + edited messages).
- `backfill.py` — one-shot importer for the last N days of history.
- `requirements.txt` — Python deps (Telethon, Supabase, OpenAI, tenacity, python-dotenv).
- `Dockerfile` / `Procfile` / `fly.toml` — deployment configs.
- `.env.example` — copy to `.env` and fill in.

## One-time setup (15–30 min)

### 1. Create a Supabase project

1. Go to https://supabase.com → **New project** (free tier).
2. In the SQL editor, paste and run `../db/schema.sql`.
3. Go to **Storage → New bucket**, name it `chat-media`, toggle **Public bucket** ON.
   This is where the listener stores photo thumbnails so the website can show them.
4. From **Project Settings → API**, grab:
   - **Project URL** → put in `.env` as `SUPABASE_URL` and in `assets/config.js` as `supabaseUrl`.
   - **service_role key** (secret) → `.env` `SUPABASE_SERVICE_KEY`. Never expose this in the browser.
   - **anon public key** → `assets/config.js` `supabaseAnonKey`. Safe to expose.

### 2. Get Telegram API credentials

1. Open https://my.telegram.org, log in with your phone.
2. Click **API development tools** → create an app (any name/description).
3. Copy `api_id` (number) and `api_hash` (long string) into `.env`.

### 3. Get an OpenAI API key

1. https://platform.openai.com/api-keys → create a key.
2. Add it to `.env` as `OPENAI_API_KEY`.
3. Model stays as `gpt-4o-mini` by default (cheap).

### 4. Fill `.env`

```bash
cp .env.example .env
# then open .env and paste in the values
```

Set `TG_CHANNEL` to the public channel username **without** the `@`.

## Running locally

```powershell
cd listener
python -m venv .venv
.venv\Scripts\Activate.ps1   # (PowerShell on Windows)
pip install -r requirements.txt

# First run: Telethon will ask for your phone number and a login code.
# The resulting vn_listener.session file is your credentials — keep it private.
python live.py
```

To import historical messages (last 365 days by default):

```powershell
python backfill.py              # full year
python backfill.py --days 90    # last 3 months
python backfill.py --limit 100  # tiny test batch
```

Both scripts upsert by `(tg_channel, tg_message_id)`, so it's always safe to re-run.

## Costs at a glance

- **Supabase** free tier: 500 MB DB, 5 GB egress/month. Easily fits hundreds of thousands of messages.
- **OpenAI `gpt-4o-mini`**: ~$0.15 / 1M input tokens, ~$0.60 / 1M output. For ~100 msgs/day × ~600 tokens total, well under $1/month.
- **Host**: Railway or Fly.io hobby tier is enough ($0–5/month). Or run on your own PC with auto-restart.

## Deploying the listener

### Option A — Railway (simplest)

1. Push this `listener/` folder to a GitHub repo (make sure `.env` and `*.session` are ignored).
2. https://railway.app → **New project → Deploy from GitHub**.
3. Railway auto-detects Python and runs `python live.py` (from `Procfile`).
4. Under **Variables**, paste all the `.env` values.
5. Add a **Volume** mounted at `/data` and set `TG_SESSION=/data/vn_listener.session`.
6. For the **first deploy only**, you need a session file. Two easy options:
   - Generate `vn_listener.session` locally (run `python live.py` once, let it log in), then use Railway's shell to upload that file into `/data/`.
   - Or run `live.py` interactively once via `railway shell`, enter the SMS code, then detach.
7. The listener now runs 24/7; restarts keep the session.

### Option B — Fly.io

```bash
cd listener
fly launch --no-deploy   # accept the existing fly.toml
fly volumes create vn_listener_data --size 1 --region sin
fly secrets set TG_API_ID=... TG_API_HASH=... TG_CHANNEL=... \
                SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \
                OPENAI_API_KEY=...
fly deploy
# First login: fly ssh console -> cd /app && python live.py (enter SMS code once)
```

### Option C — Your own PC (fine for low traffic)

Run `python live.py` in a terminal or as a Windows service (`nssm install`).
If your PC is offline, ingestion pauses; it resumes on reconnect.

## Updating

- Change the prompt or add categories → edit `common.py`, redeploy.
- Re-classify old messages → delete the DB rows and run `backfill.py` again.
- Pause ingestion → stop the service; Telegram keeps the backlog and Telethon will catch up when you restart (up to normal Telegram history limits).

## Troubleshooting

- **`FloodWaitError`** — Telegram rate limited us. Telethon retries automatically. If you see this during backfill, let it sleep.
- **`ChannelPrivateError`** — the channel is private; the account used in the session must be a member.
- **OpenAI timeouts** — `classify_and_translate` has exponential backoff (4 attempts). Persistent failures fall back to `other`-only tagging so ingestion never stops.
- **Empty search results on the website** — check (a) `assets/config.js` URL+anon key, (b) that the `messages` table has rows, (c) browser devtools Network tab for a 2xx response from `/rest/v1/rpc/search_messages`.
