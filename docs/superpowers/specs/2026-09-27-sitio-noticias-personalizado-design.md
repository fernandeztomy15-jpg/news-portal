# Sitio de noticias privado y personalizado — Diseño

**Fecha:** 2026-09-27
**Estado:** Aprobado en brainstorming, pendiente de plan de implementación.

## 1. Objetivo

Reemplazar el digest matutino que nunca llegó a tener frontend por un sitio
web personal donde Tomás pueda, todos los días:

- Ver noticias agrupadas por tema de interés, ya priorizadas para él.
- Marcar like/dislike para que la priorización aprenda con el tiempo.
- Hacer click para profundizar en la fuente original.
- Tener una sección de "descubrimiento" que lo saque de su propia burbuja.

Se parte del scaffold existente en este mismo repo (`src/ingest.ts`,
`supabase/schema.sql`, el workflow de GitHub Actions) en lugar de
reescribirlo — se decidió explícitamente diseñar sin sentirse atado a esas
decisiones previas, pero reusar lo que sigue teniendo sentido.

## 2. Alcance

**Incluido:**
- 5 categorías fijas: `macro`, `tech`, `emprendimientos`, `deportes`,
  `descubrimiento`.
- Fuentes RSS ya confirmadas (Ades, Infobae, Ámbito, Olé) + WSJ (RSS
  público, sin login) + una búsqueda de Google News RSS por cada una de
  las 4 categorías de interés.
- Un agente de curación que corre 2 veces al día, usa Claude Haiku 4.5,
  y decide qué mostrar, con qué prioridad y por qué.
- Aprendizaje por like/dislike vía pesos de categoría, ajustados en el
  momento (no solo en la corrida del LLM).
- Categoría "descubrimiento": el LLM elige un tema nuevo cada corrida
  (evitando repetir los últimos 14 días) y busca en Google News RSS sobre
  ese tema, sin aplicar los pesos de afinidad del usuario.
- Tope de gasto de $5/mes en el LLM, reforzado en dos capas (límite en la
  cuenta de Anthropic + chequeo propio antes de cada corrida).
- Frontend: sitio único (Next.js en Vercel), sin login, agrupado por
  categoría, ventana de 48hs, sin cantidad fija de artículos (el LLM
  descarta lo irrelevante en vez de truncar a un número fijo).

**Explícitamente fuera de alcance (v1):**
- Notificaciones o envío por mail — el usuario entra al sitio, no le
  llega nada.
- Autenticación/login en el sitio — es una URL sin restricciones.
- Login del scraper contra cuentas pagas (WSJ) para traer contenido
  completo — solo RSS público, título + resumen.
- Traducción de contenido — cada fuente se muestra en su idioma original.
- Cualquier scraping fuera de RSS (no hay fase de "scrape" para fuentes
  sin feed, como Reuters, TyC Sports o ESPN Argentina — quedan igual de
  inactivas que en el scaffold original).

## 3. Arquitectura general

```
GitHub Actions (cron, 2x/día)
  ├─ 1. Ingesta RSS (existente, extendida)
  │     sources activas (RSS fijo + Google News por categoría + WSJ)
  │     → upsert en `articles`, log en `ingestion_runs`
  │
  └─ 2. Curación (nueva)
        a. Chequea gasto del mes en `curation_runs` — si ≥ $5, no llama al LLM
        b. Llamada LLM #1 (chica): elige tema de "descubrimiento"
        c. Busca ese tema en Google News RSS (código, sin LLM)
        d. Llamada LLM #2: puntúa/descarta todos los artículos nuevos
           (4 categorías de interés + descubrimiento)
        e. Guarda score/reason/discarded en `articles`,
           tokens/costo/tema en `curation_runs`

Supabase (Postgres)
  sources, articles, ingestion_runs (existentes, extendidos)
  category_weights, curation_runs (nuevas)

Next.js (Vercel, sin login)
  Server component: lee `articles` agrupados por categoría (últimas 48hs,
  discarded=false, order by score desc)
  API route /api/feedback: togglea liked/disliked y ajusta category_weights
```

## 4. Modelo de datos

Se reusan `sources`, `articles`, `ingestion_runs` tal como están en
`supabase/schema.sql`, con estos cambios:

```sql
alter table articles
  add column score        numeric,
  add column reason        text,
  add column curated_at    timestamptz,
  add column discarded     boolean not null default false;

alter table articles alter column source_id drop not null;
-- los artículos de "descubrimiento" no tienen una fila fija en `sources`

create table category_weights (
  category    text primary key,   -- macro | tech | emprendimientos | deportes
                                    -- (descubrimiento NO tiene peso)
  weight      numeric not null default 1.0,
  updated_at  timestamptz not null default now()
);

create table curation_runs (
  id                  uuid primary key default gen_random_uuid(),
  started_at          timestamptz not null default now(),
  finished_at         timestamptz,
  status              text not null default 'running', -- ok | error | skipped_budget
  model               text,
  input_tokens        integer,
  output_tokens        integer,
  estimated_cost_usd  numeric,
  discovery_topic     text,
  discovery_query_url text,
  articles_scored     integer not null default 0,
  articles_discarded  integer not null default 0,
  error_message       text
);
```

**Fuentes nuevas a insertar en `sources`** (mismo patrón que las
existentes; Google News RSS es, técnicamente, un feed RSS válido, así
que usan `source_type = 'rss'` igual que las demás — el ingest actual
(`src/ingest.ts`) las procesa sin ningún cambio de código, solo hace
falta la fila en la tabla):

| id | category | feed_url | source_type |
|---|---|---|---|
| `wsj-markets` | macro | `https://feeds.content.dowjones.io/public/rss/RSSMarketsMain` (confirmado en vivo, 27/9/2026) | rss |
| `google-news-macro` | macro | `https://news.google.com/rss/search?q=econom%C3%ADa+argentina&hl=es-419` | rss |
| `google-news-tech` | tech | `https://news.google.com/rss/search?q=tecnolog%C3%ADa&hl=es-419` | rss |
| `google-news-emprendimientos` | emprendimientos | `https://news.google.com/rss/search?q=startups+argentina&hl=es-419` | rss |
| `google-news-deportes` | deportes | `https://news.google.com/rss/search?q=deportes+argentina&hl=es-419` | rss |

Estas queries son un punto de partida editable — igual que con las
fuentes RSS existentes, cambiarlas es un `update`, no requiere tocar
código. La fuente "descubrimiento" NO va en esta tabla: su query cambia
cada corrida y la resuelve el script de curación directamente (ver
sección 5).

## 5. Lógica de curación

**Ajuste de pesos (código, sin LLM, inmediato):**
Cada like: `weight += 0.15` (tope 3.0). Cada dislike: `weight -= 0.15`
(piso 0.2). Arranca en 1.0. Pasa en la API route de feedback, no espera
a la corrida del LLM.

**Cada corrida del script de curación (2x/día vía GitHub Actions):**

1. Suma `estimated_cost_usd` de `curation_runs` con `started_at` en el
   mes en curso. Si el total es ≥ $5, inserta una fila
   `status='skipped_budget'` y termina sin llamar al LLM.
2. **Llamada LLM #1** (Claude Haiku 4.5, salida estructurada): recibe los
   `discovery_topic` de los últimos 14 días desde `curation_runs` y
   devuelve `{topic, query}` — un tema nuevo no repetido.
3. El script arma la URL de Google News RSS con ese `query` y la
   fetchea (mismo parser RSS que ya existe en `src/lib/rss.ts`).
4. **Llamada LLM #2** (Claude Haiku 4.5, salida estructurada): recibe
   - los pesos actuales de `category_weights`,
   - una muestra de títulos de artículos con `liked=true`/`liked=false`
     recientes (para dar contexto de gusto),
   - todos los artículos con `curated_at is null` de las 4 categorías de
     interés + los recién traídos de descubrimiento,
   y devuelve, por artículo: `{id, score (0-100), reason, discard}`.
   - Para las 4 categorías de interés: el criterio es relevancia según
     pesos + historial de gustos.
   - Para descubrimiento: instrucción explícita de **ignorar** los pesos
     de afinidad — el criterio es solo interés/calidad general.
5. El script actualiza `articles` (score, reason, discarded, curated_at)
   y cierra la fila de `curation_runs` con tokens, costo estimado
   (calculado con el precio conocido de Haiku 4.5: $1/$5 por millón de
   tokens entrada/salida) y el tema de descubrimiento usado.

## 6. Control de costo

Dos capas:
1. **Límite de gasto de $5/mes configurado en la cuenta de Anthropic**
   (console.anthropic.com) — corte real del lado del proveedor.
2. **Chequeo propio en `curation_runs`** antes de cada corrida (paso 1
   de la sección 5) — para no depender de que el límite de la consola
   reaccione a tiempo, y para que quede visible en nuestra propia base
   por qué una corrida no curó nada.

Estimado de uso real: ~$1-2/mes con 2 corridas diarias (ver cálculo
hecho en el brainstorming), muy por debajo del tope de $5.

## 7. Frontend / UX

- Next.js (App Router) + Tailwind, deployado en Vercel, sin login.
- Una sola página, 5 secciones en orden fijo: macro, tech,
  emprendimientos, deportes, descubrimiento.
- Cada sección lee de Supabase (server component, sin API intermedia):
  artículos con `discarded=false`, `curated_at` en las últimas 48hs,
  `category` = la de la sección, ordenados por `score desc`.
- Sección sin resultados → mensaje "sin novedades hoy", no queda en
  blanco.
- Cada tarjeta: título (link a la fuente, `target="_blank"`), fuente,
  `reason` del LLM, fecha, botones 👍/👎.
- `POST /api/feedback` (Next.js API route): recibe `article_id` +
  `liked`, actualiza `articles.liked` y ajusta `category_weights` de la
  categoría de ese artículo. El artículo no desaparece de la vista, solo
  cambia el estado visual del botón tocado.

## 8. Infraestructura y costo total

Todo en tier gratuito salvo el LLM (tope $5/mes):
- **Vercel** (frontend, free tier) — un solo usuario, tráfico mínimo.
- **Supabase** (Postgres, free tier) — volumen de datos bajo.
- **GitHub Actions** (cron 2x/día, free tier) — muy por debajo del límite
  de minutos gratis.
- **Anthropic API** — Claude Haiku 4.5, tope de $5/mes.

## 9. Riesgos conocidos

- **Google News RSS no es una API oficial documentada** — puede cambiar
  de formato o dejar de responder sin aviso, igual de frágil que
  cualquier scraping. Si falla, esa categoría/descubrimiento
  simplemente no trae nada esa corrida (mismo patrón de tolerancia a
  fallos que ya tiene `ingestion_runs` con fuentes rotas).
- **WSJ podría bloquear el feed desde IPs de datacenter** más adelante,
  igual que pasó con el feed directo de Substack de Ades — se confirmó
  en vivo el 27/9/2026 pero no hay garantía de que siga así.
- **Carrera entre las 2 corridas diarias y el chequeo de presupuesto**:
  si ambas corridas se disparan casi al mismo tiempo (no debería pasar
  con cron normal), podrían ambas leer el mismo total acumulado antes de
  que la otra escriba. Riesgo bajo dado el volumen (2 corridas/día, no
  concurrencia real), no se resuelve con locking en v1.
