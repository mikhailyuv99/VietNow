"""Live Telegram listener: captures every new message in the configured channel
and mirrors it (enriched + translated) into Supabase.

Run:
    python live.py

First launch will prompt for your phone number and an SMS code (Telethon session).
That session file is then reused forever. Protect it like a password.
"""

from __future__ import annotations

import asyncio
import logging

from telethon import TelegramClient, events

from common import Config, make_openai, make_supabase, process_message

log = logging.getLogger("vn_listener.live")


async def main() -> None:
    cfg = Config.from_env()
    sb = make_supabase(cfg)
    oai = make_openai(cfg)

    client = TelegramClient(cfg.tg_session, cfg.tg_api_id, cfg.tg_api_hash)
    await client.start()
    log.info("Connected. Listening on channel: %s", cfg.tg_channel)

    entity = await client.get_entity(cfg.tg_channel)

    @client.on(events.NewMessage(chats=entity))
    async def _on_new(event: events.NewMessage.Event) -> None:
        try:
            await process_message(client, sb, oai, cfg, event.message)
        except Exception:
            log.exception("Failed to process incoming message")

    @client.on(events.MessageEdited(chats=entity))
    async def _on_edit(event: events.MessageEdited.Event) -> None:
        try:
            await process_message(client, sb, oai, cfg, event.message)
        except Exception:
            log.exception("Failed to process edited message")

    await client.run_until_disconnected()


if __name__ == "__main__":
    asyncio.run(main())
