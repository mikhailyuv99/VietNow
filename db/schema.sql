-- Vietnam Chat Search — Supabase / Postgres schema.
--
-- How to apply:
--   1. Create a free project at https://supabase.com
--   2. Open the SQL editor and paste the contents of this file
--   3. Run it once. Safe to re-run (idempotent).
--
-- Notes:
--   - "text_ru" holds the original Telegram text (we assume source is Russian).
--   - "text_en" and "text_vi" are machine translations produced by the listener.
--   - "tsv" is a generated tsvector covering all three languages, used for full-text search.
--   - Row-Level Security is enabled. Anonymous users get read-only access through the "anon" role.

create extension if not exists "uuid-ossp";

create table if not exists public.messages (
    id              uuid primary key default uuid_generate_v4(),
    tg_channel      text        not null,
    tg_message_id   bigint      not null,
    posted_at       timestamptz not null,
    author          text,
    telegram_url    text        not null,

    text_ru         text        not null default '',
    text_en         text        not null default '',
    text_vi         text        not null default '',

    categories      text[]      not null default '{}',
    ai_tags         text[]      not null default '{}',
    city            text,

    has_link        boolean     not null default false,
    has_media       boolean     not null default false,
    media_type      text,
    media_url       text,

    tsv tsvector generated always as (
        setweight(to_tsvector('simple', coalesce(text_ru, '')), 'A') ||
        setweight(to_tsvector('simple', coalesce(text_en, '')), 'A') ||
        setweight(to_tsvector('simple', coalesce(text_vi, '')), 'A') ||
        setweight(to_tsvector('simple', coalesce(array_to_string(categories, ' '), '')), 'B') ||
        setweight(to_tsvector('simple', coalesce(array_to_string(ai_tags,    ' '), '')), 'B') ||
        setweight(to_tsvector('simple', coalesce(city, '')), 'B')
    ) stored,

    inserted_at     timestamptz not null default now(),
    updated_at      timestamptz not null default now(),

    constraint messages_channel_msg_unique unique (tg_channel, tg_message_id)
);

create index if not exists messages_posted_at_idx on public.messages (posted_at desc);
create index if not exists messages_tsv_idx       on public.messages using gin (tsv);
create index if not exists messages_categories_idx on public.messages using gin (categories);
create index if not exists messages_ai_tags_idx   on public.messages using gin (ai_tags);
create index if not exists messages_city_idx      on public.messages (city);

-- Keep updated_at fresh on changes.
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
    new.updated_at = now();
    return new;
end$$;

drop trigger if exists messages_set_updated_at on public.messages;
create trigger messages_set_updated_at
    before update on public.messages
    for each row execute procedure public.set_updated_at();

-- Row-Level Security.
alter table public.messages enable row level security;

-- Allow public (anon) read-only access. The listener uses the service-role key which bypasses RLS.
drop policy if exists "messages are readable by anyone" on public.messages;
create policy "messages are readable by anyone"
    on public.messages for select
    using (true);

-- ---------------------------------------------------------------------------
-- Optional: a simple RPC to search messages with highlighting and filters.
-- The website can call this through the Supabase REST (`/rest/v1/rpc/search_messages`),
-- or fall back to a regular PostgREST query. Both paths are supported by the frontend.
-- ---------------------------------------------------------------------------

create or replace function public.search_messages(
    q                text         default '',
    categories_in    text[]       default null,
    cities_in        text[]       default null,
    since            timestamptz  default null,
    until            timestamptz  default null,
    page_size        int          default 20,
    page_offset      int          default 0
)
returns table (
    id              uuid,
    tg_channel      text,
    tg_message_id   bigint,
    posted_at       timestamptz,
    author          text,
    telegram_url    text,
    text_ru         text,
    text_en         text,
    text_vi         text,
    categories      text[],
    ai_tags         text[],
    city            text,
    has_link        boolean,
    has_media       boolean,
    media_type      text,
    media_url       text,
    rank            real
)
language sql stable as $$
    with query as (
        select case when coalesce(trim(q), '') = '' then null
                    else websearch_to_tsquery('simple', q) end as tsq
    )
    select m.id,
           m.tg_channel,
           m.tg_message_id,
           m.posted_at,
           m.author,
           m.telegram_url,
           m.text_ru,
           m.text_en,
           m.text_vi,
           m.categories,
           m.ai_tags,
           m.city,
           m.has_link,
           m.has_media,
           m.media_type,
           m.media_url,
           case when (select tsq from query) is null then 0
                else ts_rank(m.tsv, (select tsq from query)) end as rank
      from public.messages m, query
     where ( query.tsq is null or m.tsv @@ query.tsq )
       and ( categories_in is null or m.categories && categories_in )
       and ( cities_in     is null or m.city = any(cities_in) )
       and ( since is null or m.posted_at >= since )
       and ( until is null or m.posted_at <  until )
     order by
           case when (select tsq from query) is null then 0
                else ts_rank(m.tsv, (select tsq from query)) end desc,
           m.posted_at desc
     limit page_size offset page_offset;
$$;

-- ---------------------------------------------------------------------------
-- Safe migrations for existing installs (idempotent). No-ops on a fresh DB.
-- ---------------------------------------------------------------------------
alter table public.messages add column if not exists media_type text;
alter table public.messages add column if not exists media_url  text;

-- ---------------------------------------------------------------------------
-- Contacts: messages submitted through the website's floating chatbox.
-- ---------------------------------------------------------------------------
create table if not exists public.contacts (
    id          uuid primary key default uuid_generate_v4(),
    created_at  timestamptz not null default now(),
    name        text,
    email       text,
    message     text not null,
    user_agent  text,
    locale      text
);

alter table public.contacts enable row level security;

-- Anyone can submit a contact message; nobody can read them except via the
-- service-role key (e.g. the admin in the Supabase dashboard).
drop policy if exists "anyone can insert contacts" on public.contacts;
create policy "anyone can insert contacts"
    on public.contacts for insert
    with check (
        char_length(coalesce(message, '')) between 1 and 4000
    );

-- ---------------------------------------------------------------------------
-- Storage bucket for message media (photos). Create it once in the Supabase
-- dashboard (Storage -> New bucket -> name: "chat-media", public: ON).
-- The listener uploads JPEGs to "<channel>/<message_id>.jpg" and stores the
-- public URL in messages.media_url.
-- ---------------------------------------------------------------------------
