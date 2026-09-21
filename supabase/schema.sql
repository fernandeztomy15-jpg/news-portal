-- Ejecutar esto en el SQL editor de Supabase (o vía `supabase db push`
-- si integrás la CLI) antes de correr el ingest por primera vez.

create extension if not exists "pgcrypto";

-- Catálogo de fuentes. No es estrictamente necesario tener esta tabla
-- (podríamos vivir solo con src/config/sources.ts), pero tenerla en DB
-- te permite: 1) prender/apagar fuentes sin redeployar, 2) ver en un
-- dashboard el estado de cada una, 3) que la sección "rotativa" del
-- digest elija categorías dinámicamente en el futuro.
create table if not exists sources (
  id          text primary key,        -- slug, ej. 'ades-parte-diario'
  name        text not null,           -- nombre para mostrar
  category    text not null,           -- 'macro' | 'tech' | 'emprendimientos' | 'deportes' | 'rotativo'
  feed_url    text,                    -- null si todavía no tiene RSS confirmado
  source_type text not null default 'rss', -- 'rss' | 'scrape' (fase 2)
  active      boolean not null default false,
  created_at  timestamptz not null default now()
);

create table if not exists articles (
  id           uuid primary key default gen_random_uuid(),
  source_id    text not null references sources(id),
  category     text not null,
  title        text not null,
  url          text not null unique,   -- dedupe: un artículo = una URL
  summary      text,
  content      text,
  published_at timestamptz,
  fetched_at   timestamptz not null default now(),
  liked        boolean,                -- para el feedback loop que querés (like/dislike)
  raw          jsonb                   -- item RSS crudo, por si hace falta reprocesar
);

create index if not exists idx_articles_published_at on articles (published_at desc);
create index if not exists idx_articles_category     on articles (category);
create index if not exists idx_articles_source_id     on articles (source_id);

-- Log de cada corrida, por fuente. Esto es lo que te va a permitir ver
-- "por qué Ades no trajo nada hoy" sin tener que adivinar — antes
-- este problema era invisible porque no había dónde mirar.
create table if not exists ingestion_runs (
  id             uuid primary key default gen_random_uuid(),
  source_id      text not null references sources(id),
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  status         text not null default 'running', -- 'ok' | 'error' | 'skipped'
  items_found    integer not null default 0,
  items_inserted integer not null default 0,
  error_message  text
);

create index if not exists idx_ingestion_runs_source_started
  on ingestion_runs (source_id, started_at desc);

-- Seed inicial de fuentes. Las 4 con feed_url + active=true fueron
-- confirmadas EN VIVO (fetch real, HTTP 200, XML válido) el 20/9/2026 —
-- ver detalle de cada URL en el README. El resto sigue inactiva porque
-- no encontramos un feed RSS real que confirmar (ver README).
insert into sources (id, name, category, feed_url, source_type, active) values
  -- Ojo: NO es la URL directa de Substack (esa está bloqueada con 403 para
  -- IPs de datacenter, incluido GitHub Actions — ver README). Este feed_url
  -- es un puente vía email: Tomás recibe el newsletter en Gmail, un filtro
  -- lo reenvía a una dirección de Kill the Newsletter, que expone lo
  -- recibido como Atom feed real. Mismo contenido, sin el bloqueo.
  ('ades-parte-diario', 'Parte Diario (Alberto Ades)', 'macro', 'https://kill-the-newsletter.com/feeds/8m1yf4ism3sdw4qfpuwr.xml', 'rss', true),
  ('reuters-business',  'Reuters Business',            'macro',           null, 'scrape', false), -- RSS discontinuado por Reuters en 2020, confirmado
  ('infobae-economia',  'Infobae Economía',            'macro',           'https://www.infobae.com/arc/outboundfeeds/rss/category/economia/', 'rss', true),
  ('ambito',            'Ámbito',                      'macro',           'https://www.ambito.com/rss/pages/economia.xml', 'rss', true),
  ('bloomberg-linea',   'Bloomberg Línea',              'macro',           null, 'rss',    false), -- feed_url sin confirmar
  ('ole',               'Olé',                          'deportes',        'https://www.ole.com.ar/rss/ultimas-noticias', 'rss', true),
  ('espn-arg',          'ESPN Argentina',              'deportes',        null, 'rss',    false), -- probado en vivo 20/9/2026: espn.com.ar redirige roto, no hay feed confirmado
  ('tyc-sports',        'TyC Sports',                  'deportes',        null, 'rss',    false)  -- probado en vivo 20/9/2026: /feed y /arc/outboundfeeds/rss/ dan 404
on conflict (id) do nothing;
