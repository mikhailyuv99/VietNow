"""Shared helpers for the Telegram listener: config, AI classification+translation, DB upsert."""

from __future__ import annotations

import asyncio
import io
import json
import logging
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from dotenv import load_dotenv
from openai import OpenAI, RateLimitError
from supabase import Client, create_client
from tenacity import retry, stop_after_attempt, wait_exponential
from telethon import TelegramClient
from telethon.tl.custom.message import Message
from telethon.tl.types import MessageMediaPhoto

load_dotenv()

log = logging.getLogger("vn_listener")
if not log.handlers:
    logging.basicConfig(
        level=os.getenv("LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s - %(message)s",
    )


# --- Configuration ---------------------------------------------------------

DEFAULT_CATEGORIES: tuple[str, ...] = (
    "housing",
    "visa_legal",
    "jobs",
    "food",
    "transport",
    "health",
    "services",
    "events",
    "classifieds",
    "tourism",
    "education",
    "other",
)

KNOWN_CITIES: tuple[str, ...] = (
    "Hanoi",
    "HCMC",
    "Da Nang",
    "Nha Trang",
    "Phu Quoc",
    "Vung Tau",
    "Da Lat",
    "Hai Phong",
    "Mui Ne",
    "Hoi An",
)


@dataclass(frozen=True)
class Config:
    tg_api_id: int
    tg_api_hash: str
    tg_session: str
    tg_channel: str
    supabase_url: str
    supabase_service_key: str
    openai_api_key: str
    openai_model: str
    backfill_days: int
    media_bucket: str

    @classmethod
    def from_env(cls) -> "Config":
        def required(key: str) -> str:
            value = os.getenv(key, "").strip()
            if not value:
                raise RuntimeError(f"Missing required env var: {key}")
            return value

        return cls(
            tg_api_id=int(required("TG_API_ID")),
            tg_api_hash=required("TG_API_HASH"),
            tg_session=os.getenv("TG_SESSION", "./vn_listener.session"),
            tg_channel=required("TG_CHANNEL").lstrip("@"),
            supabase_url=required("SUPABASE_URL"),
            supabase_service_key=required("SUPABASE_SERVICE_KEY"),
            openai_api_key=required("OPENAI_API_KEY"),
            openai_model=os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
            backfill_days=int(os.getenv("BACKFILL_DAYS", "365")),
            media_bucket=os.getenv("MEDIA_BUCKET", "chat-media"),
        )


# --- Clients ---------------------------------------------------------------


def make_supabase(cfg: Config) -> Client:
    return create_client(cfg.supabase_url, cfg.supabase_service_key)


def make_openai(cfg: Config) -> OpenAI:
    return OpenAI(api_key=cfg.openai_api_key)


# --- AI classification + translation --------------------------------------

_SYSTEM_PROMPT = (
    "You enrich messages from a Russian-language Telegram community for Russians living in Vietnam. "
    "You MUST answer with a single JSON object, no prose. "
    "Given a message (usually in Russian), produce:\n"
    "  - categories: array of zero or more of "
    f"{list(DEFAULT_CATEGORIES)}. Pick all that apply. If none, use [\"other\"].\n"
    "  - ai_tags: 0 to 6 short lowercase free-form tags (latin chars, digits, hyphen), "
    "capturing specific things like profession, item, service, or topic. "
    "Examples: \"marketer\", \"scooter-rent\", \"bank-card\", \"1-bedroom\", \"dentist\".\n"
    "  - city: one of "
    f"{list(KNOWN_CITIES)} if a Vietnamese city is clearly referenced, otherwise null. "
    "Use \"HCMC\" for Saigon / Ho Chi Minh City.\n"
    "  - text_en: English translation of the message (keep it natural, preserve emojis and phone/links as-is).\n"
    "  - text_vi: Vietnamese translation of the message.\n"
    "If the input is empty, media-only, or not meaningful, return all empty/defaults."
)


def _fallback_result() -> dict[str, Any]:
    return {
        "categories": ["other"],
        "ai_tags": [],
        "city": None,
        "text_en": "",
        "text_vi": "",
    }


def _is_quota_exhausted(exc: BaseException) -> bool:
    body = str(exc).lower()
    return "insufficient_quota" in body or "exceeded your current quota" in body


@retry(wait=wait_exponential(multiplier=1, min=2, max=30), stop=stop_after_attempt(4), reraise=True)
def classify_and_translate(client: OpenAI, model: str, text_ru: str) -> dict[str, Any]:
    """Call the model and return a normalized dict. Safe against bad JSON."""
    text = (text_ru or "").strip()
    if not text:
        return _fallback_result()

    try:
        response = client.chat.completions.create(
            model=model,
            temperature=0,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": text[:4000]},
            ],
        )
    except RateLimitError as exc:
        if _is_quota_exhausted(exc):
            log.warning("OpenAI quota/billing issue — storing message without AI tags/translations. Check billing at platform.openai.com")
            return _fallback_result()
        raise
    raw = response.choices[0].message.content or "{}"

    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        log.warning("Model returned non-JSON, using fallback. Raw: %s", raw[:200])
        return _fallback_result()

    categories = [c for c in data.get("categories", []) if c in DEFAULT_CATEGORIES]
    if not categories:
        categories = ["other"]

    ai_tags_raw = data.get("ai_tags", []) or []
    ai_tags: list[str] = []
    for t in ai_tags_raw:
        if not isinstance(t, str):
            continue
        slug = re.sub(r"[^a-z0-9\-]+", "-", t.lower()).strip("-")
        if slug and slug not in ai_tags:
            ai_tags.append(slug)
        if len(ai_tags) >= 6:
            break

    city = data.get("city")
    if city not in KNOWN_CITIES:
        city = None

    return {
        "categories": categories,
        "ai_tags": ai_tags,
        "city": city,
        "text_en": (data.get("text_en") or "").strip()[:6000],
        "text_vi": (data.get("text_vi") or "").strip()[:6000],
    }


# --- Message handling -----------------------------------------------------


_URL_RE = re.compile(r"https?://\S+", re.IGNORECASE)


def _posted_at(msg: Message) -> datetime:
    dt = msg.date
    if dt is None:
        return datetime.now(tz=timezone.utc)
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def _author_name(msg: Message) -> str | None:
    sender = getattr(msg, "sender", None)
    if sender is None:
        return None
    for attr in ("title", "username"):
        v = getattr(sender, attr, None)
        if v:
            return str(v)
    first = getattr(sender, "first_name", None)
    last = getattr(sender, "last_name", None)
    name = " ".join(x for x in (first, last) if x)
    return name or None


def telegram_url(channel: str, message_id: int) -> str:
    return f"https://t.me/{channel}/{message_id}"


def _media_type(msg: Message) -> str | None:
    media = getattr(msg, "media", None)
    if media is None:
        return None
    if isinstance(media, MessageMediaPhoto) or getattr(msg, "photo", None):
        return "photo"
    if getattr(msg, "video", None):
        return "video"
    if getattr(msg, "document", None):
        return "document"
    return "other"


async def upload_photo_if_any(
    tg: TelegramClient, sb: Client, bucket: str, channel: str, msg: Message
) -> str | None:
    """If the message has a photo, download the largest size and upload it to
    Supabase Storage. Returns the public URL, or None."""
    if _media_type(msg) != "photo":
        return None
    try:
        buf = io.BytesIO()
        await tg.download_media(msg, file=buf)
        data = buf.getvalue()
        if not data:
            return None
        path = f"{channel}/{msg.id}.jpg"
        try:
            sb.storage.from_(bucket).upload(
                path,
                data,
                file_options={"content-type": "image/jpeg", "upsert": "true"},
            )
        except Exception as exc:
            # Treat "already exists" and other upload errors as best-effort.
            log.warning("Storage upload skipped for msg %s: %s", msg.id, exc)
        return sb.storage.from_(bucket).get_public_url(path)
    except Exception as exc:
        log.warning("Failed to download/upload photo for msg %s: %s", msg.id, exc)
        return None


def build_row(
    channel: str,
    msg: Message,
    enrichment: dict[str, Any],
    media_url: str | None = None,
) -> dict[str, Any]:
    text_ru = (msg.message or "").strip()
    media_type = _media_type(msg)
    has_media = media_type is not None
    has_link = bool(_URL_RE.search(text_ru))

    return {
        "tg_channel": channel,
        "tg_message_id": int(msg.id),
        "posted_at": _posted_at(msg).isoformat(),
        "author": _author_name(msg),
        "telegram_url": telegram_url(channel, int(msg.id)),
        "text_ru": text_ru,
        "text_en": enrichment["text_en"],
        "text_vi": enrichment["text_vi"],
        "categories": enrichment["categories"],
        "ai_tags": enrichment["ai_tags"],
        "city": enrichment["city"],
        "has_link": has_link,
        "has_media": has_media,
        "media_type": media_type,
        "media_url": media_url,
    }


def should_skip(msg: Message) -> bool:
    """Skip noise: empty service messages, pure reactions, etc."""
    if msg is None:
        return True
    text = (msg.message or "").strip()
    if not text and not getattr(msg, "media", None):
        return True
    return False


def upsert_message(sb: Client, row: dict[str, Any]) -> None:
    sb.table("messages").upsert(row, on_conflict="tg_channel,tg_message_id").execute()


async def process_message(
    tg: TelegramClient,
    sb: Client,
    openai_client: OpenAI,
    cfg: Config,
    msg: Message,
) -> bool:
    """Enrich, store media, and upsert a single message. Returns True if stored."""
    if should_skip(msg):
        return False
    text_ru = (msg.message or "").strip()

    try:
        enrichment = await asyncio.to_thread(
            classify_and_translate, openai_client, cfg.openai_model, text_ru
        )
    except Exception as exc:
        log.exception("Enrichment failed for msg %s: %s", msg.id, exc)
        enrichment = _fallback_result()

    media_url = await upload_photo_if_any(tg, sb, cfg.media_bucket, cfg.tg_channel, msg)

    row = build_row(cfg.tg_channel, msg, enrichment, media_url=media_url)
    try:
        await asyncio.to_thread(upsert_message, sb, row)
    except Exception as exc:
        log.exception("DB upsert failed for msg %s: %s", msg.id, exc)
        return False
    log.info(
        "Stored msg %s (%s) categories=%s city=%s media=%s",
        msg.id,
        row["posted_at"],
        row["categories"],
        row["city"],
        row["media_type"],
    )
    return True
