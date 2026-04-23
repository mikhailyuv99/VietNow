"""One-shot backfill: import the last N days of channel history (default 365)
into Supabase, enriched + translated like the live listener.

Run:
    python backfill.py
    python backfill.py --days 90        # override the .env value
    python backfill.py --limit 500      # cap the number of messages (for testing)

Idempotent: safe to re-run; messages are upserted on (tg_channel, tg_message_id).
"""

from __future__ import annotations

import argparse
import asyncio
import logging
from datetime import datetime, timedelta, timezone

from telethon import TelegramClient

from common import Config, make_openai, make_supabase, process_message

log = logging.getLogger("vn_listener.backfill")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Backfill Telegram channel history into Supabase.")
    p.add_argument("--days", type=int, default=None, help="How many days of history to import (overrides BACKFILL_DAYS)")
    p.add_argument("--limit", type=int, default=None, help="Maximum messages to process (debug)")
    return p.parse_args()


async def main() -> None:
    args = parse_args()
    cfg = Config.from_env()
    days = args.days if args.days is not None else cfg.backfill_days
    cutoff = datetime.now(tz=timezone.utc) - timedelta(days=days)

    sb = make_supabase(cfg)
    oai = make_openai(cfg)

    client = TelegramClient(cfg.tg_session, cfg.tg_api_id, cfg.tg_api_hash)
    await client.start()
    entity = await client.get_entity(cfg.tg_channel)
    log.info("Backfill: channel=%s cutoff=%s days=%s limit=%s", cfg.tg_channel, cutoff.isoformat(), days, args.limit)

    stored = 0
    seen = 0
    async for msg in client.iter_messages(entity, offset_date=None, reverse=False):
        seen += 1
        if msg.date is None:
            continue
        posted = msg.date if msg.date.tzinfo else msg.date.replace(tzinfo=timezone.utc)
        if posted < cutoff:
            log.info("Reached cutoff at msg_id=%s posted=%s, stopping.", msg.id, posted.isoformat())
            break

        ok = await process_message(client, sb, oai, cfg, msg)
        if ok:
            stored += 1
        if args.limit and seen >= args.limit:
            log.info("Hit --limit, stopping.")
            break

        if seen % 50 == 0:
            log.info("Progress: seen=%s stored=%s last_posted=%s", seen, stored, posted.isoformat())

    log.info("Backfill done. Seen=%s stored=%s", seen, stored)
    await client.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
