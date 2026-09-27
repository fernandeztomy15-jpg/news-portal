alter table articles
  add column score        numeric,
  add column reason       text,
  add column curated_at   timestamptz,
  add column discarded    boolean not null default false;

alter table articles alter column source_id drop not null;

create table category_weights (
  category    text primary key,
  weight      numeric not null default 1.0,
  updated_at  timestamptz not null default now()
);

create table curation_runs (
  id                   uuid primary key default gen_random_uuid(),
  started_at           timestamptz not null default now(),
  finished_at          timestamptz,
  status               text not null default 'running',
  model                text,
  input_tokens         integer,
  output_tokens        integer,
  estimated_cost_usd   numeric,
  discovery_topic      text,
  discovery_query_url  text,
  articles_scored      integer not null default 0,
  articles_discarded   integer not null default 0,
  error_message        text
);

insert into category_weights (category, weight) values
  ('macro', 1.0), ('mercado', 1.0), ('tech', 1.0),
  ('emprendimientos', 1.0), ('deportes', 1.0)
on conflict (category) do nothing;

insert into sources (id, name, category, feed_url, source_type, active) values
  ('wsj-markets', 'WSJ Markets', 'mercado', 'https://feeds.content.dowjones.io/public/rss/RSSMarketsMain', 'rss', true),
  ('google-news-macro', 'Google News: economía argentina', 'macro', 'https://news.google.com/rss/search?q=econom%C3%ADa+argentina&hl=es-419', 'rss', true),
  ('google-news-mercado', 'Google News: mercados', 'mercado', 'https://news.google.com/rss/search?q=d%C3%B3lar+bonos+acciones+argentina&hl=es-419', 'rss', true),
  ('google-news-tech', 'Google News: tecnología', 'tech', 'https://news.google.com/rss/search?q=tecnolog%C3%ADa&hl=es-419', 'rss', true),
  ('google-news-emprendimientos', 'Google News: startups', 'emprendimientos', 'https://news.google.com/rss/search?q=startups+argentina&hl=es-419', 'rss', true),
  ('google-news-deportes', 'Google News: deportes', 'deportes', 'https://news.google.com/rss/search?q=deportes+argentina&hl=es-419', 'rss', true)
on conflict (id) do nothing;
