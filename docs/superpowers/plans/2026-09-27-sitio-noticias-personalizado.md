# Sitio de Noticias Personalizado Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convertir el scaffold de ingesta de `news-portal` en un sitio de noticias personal, sin login, con un agente de curación por LLM que aprende de likes/dislikes.

**Architecture:** Se extiende el proyecto de ingesta existente (Node/TS, GitHub Actions, Supabase) con un segundo script (`src/curate.ts`) que puntúa artículos con Claude Haiku 4.5, y se agrega una app Next.js (`web/`) desplegada en Vercel que lee de la misma base de Supabase y expone un endpoint de feedback.

**Tech Stack:** TypeScript/Node 22 (ESM), `@anthropic-ai/sdk` + `zod`, Supabase (Postgres), GitHub Actions (cron), Next.js (App Router) + Tailwind en `web/`, Vercel. Test runner: `node:test` vía `tsx --test` en ambos paquetes (sin agregar Jest/Vitest — consistente con el estilo minimalista ya existente en el repo).

**Spec:** `docs/superpowers/specs/2026-09-27-sitio-noticias-personalizado-design.md`

## Global Constraints

- Modelo LLM: `claude-haiku-4-5`, sin `thinking` (se omite el parámetro).
- Tope de gasto: $5 USD/mes, reforzado en dos capas (límite en cuenta Anthropic + chequeo propio en código).
- Ajuste de peso por like/dislike: ±0.15, clamp [0.2, 3.0], valor inicial 1.0.
- 6 categorías fijas: `macro`, `mercado`, `tech`, `emprendimientos`, `deportes`, `descubrimiento`. `category_weights` NO incluye `descubrimiento`.
- Ventana de exhibición en el frontend: últimas 48 horas (`curated_at`).
- Sin autenticación en el sitio, sin traducción de contenido, sin scraping fuera de RSS, sin login contra fuentes pagas.
- Node >= 22, TypeScript estricto, ESM (`"type": "module"`), sigue el estilo ya presente en `src/ingest.ts` y `src/lib/rss.ts` (no lanzar excepciones desde funciones de fetch/parseo — devolver `{ok, ...}`).

## Review Focus

- Artículo de categoría `descubrimiento` sin fila en `sources` (`source_id` null) — la tarjeta debe mostrar un nombre de fuente igual, cayendo al hostname de `url`, no romper el render ni el join.
- Corrida de curación con cero artículos candidatos (día sin novedades) — no debe llamar a la Llamada LLM #2 ni loguear un error; debe cerrar `curation_runs` con `status='ok'` y `articles_scored=0`.
- Like/dislike repetido sobre el mismo artículo (toggle de 👍 a 👎 o viceversa, o click repetido sobre el mismo botón) — el ajuste de `category_weights` debe aplicar el delta neto correcto, no sumar ambos impulsos ni desviar el peso con clicks repetidos.
- Feedback sobre un artículo cuya categoría no tiene fila en `category_weights` (no debería pasar si el seed corrió bien, pero no debe tirar un 500 silencioso si pasa).
- El chequeo de presupuesto es "antes de la corrida", no por-llamada — una corrida que arranca justo debajo del tope de $5 puede terminar unos centavos por encima; documentado como comportamiento aceptado, no bug, dado el margen real (~$1-2/mes estimado vs. tope de $5).

---

## Task 1: Migración de base de datos — schema + fuentes nuevas + pesos

**Files:**
- Create: `supabase/migrations/0002_curation_and_market.sql`
- Modify: `README.md:` (agregar sección "Migraciones" con la instrucción de correr este archivo después del `schema.sql` original)

**Interfaces:**
- Produces: tablas `category_weights(category text primary key, weight numeric, updated_at timestamptz)` y `curation_runs(id uuid, started_at timestamptz, finished_at timestamptz, status text, model text, input_tokens integer, output_tokens integer, estimated_cost_usd numeric, discovery_topic text, discovery_query_url text, articles_scored integer, articles_discarded integer, error_message text)`; columnas nuevas en `articles`: `score numeric`, `reason text`, `curated_at timestamptz`, `discarded boolean not null default false`; `articles.source_id` pasa a nullable. Todo esto lo consumen las tareas 4, 6, 7, 9, 11, 13.

- [ ] **Step 1: Escribir la migración SQL**

Contenido exacto (del spec, sección 4), con estos agregados sobre lo ya definido en el spec:
- Seed de `category_weights` con las 5 categorías de interés en `weight = 1.0`: `macro`, `mercado`, `tech`, `emprendimientos`, `deportes` (sin `descubrimiento`).
- Las filas de `sources` nuevas exactamente como en la tabla de la sección 4 del spec (`wsj-markets` en `mercado`, y un `google-news-<categoria>` por cada una de las 5 categorías de interés, todas `source_type = 'rss'`, `active = true`).

```sql
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
```

- [ ] **Step 2: Verificación manual (no hay entorno de Supabase en esta sesión)**

Pegar el contenido en el SQL editor de Supabase y correrlo. Verificar con:
```sql
select category, weight from category_weights order by category;
-- esperado: 5 filas, todas weight = 1.0, sin 'descubrimiento'

select id, category, source_type, active from sources
where id in ('wsj-markets','google-news-macro','google-news-mercado','google-news-tech','google-news-emprendimientos','google-news-deportes')
order by id;
-- esperado: 6 filas, todas source_type='rss', active=true
```

- [ ] **Step 3: Actualizar README.md con la instrucción de correr esta migración después de `schema.sql`**

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0002_curation_and_market.sql README.md
git commit -m "feat: migración de curación (schema) + fuentes WSJ/Google News + pesos de categoría"
```

---

## Task 2: `src/lib/googleNews.ts` — construir URL de búsqueda

**Files:**
- Create: `src/lib/googleNews.ts`
- Test: `src/lib/googleNews.test.ts`

**Interfaces:**
- Produces: `buildGoogleNewsRssUrl(query: string): string` — la usa la Tarea 7 (`src/curate.ts`) para la búsqueda de "descubrimiento".

- [ ] **Step 1: Escribir el test**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGoogleNewsRssUrl } from "./googleNews.js";

test("codifica la query y usa español/AR como idioma", () => {
  const url = buildGoogleNewsRssUrl("dólar bonos acciones");
  assert.equal(
    url,
    "https://news.google.com/rss/search?q=d%C3%B3lar%20bonos%20acciones&hl=es-419"
  );
});

test("query vacía sigue produciendo una URL válida", () => {
  const url = buildGoogleNewsRssUrl("");
  assert.ok(url.startsWith("https://news.google.com/rss/search?q=&hl=es-419"));
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx tsx --test src/lib/googleNews.test.ts`
Expected: FAIL — `buildGoogleNewsRssUrl` no existe.

- [ ] **Step 3: Implementar `buildGoogleNewsRssUrl(query: string): string` en `src/lib/googleNews.ts`**

Usar `encodeURIComponent(query)` para el parámetro `q`, fijo `hl=es-419`.

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `npx tsx --test src/lib/googleNews.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/googleNews.ts src/lib/googleNews.test.ts
git commit -m "feat: construir URL de búsqueda de Google News RSS"
```

---

## Task 3: `src/lib/pricing.ts` — estimar costo de una corrida

**Files:**
- Create: `src/lib/pricing.ts`
- Test: `src/lib/pricing.test.ts`

**Interfaces:**
- Produces: `HAIKU_4_5_MODEL_ID = "claude-haiku-4-5"`, `estimateCostUsd(inputTokens: number, outputTokens: number): number`. Los usan las Tareas 6 y 7.

- [ ] **Step 1: Escribir el test**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateCostUsd } from "./pricing.js";

test("calcula costo con precios de Haiku 4.5 ($1/$5 por millón)", () => {
  // 1,000,000 input + 1,000,000 output = $1 + $5 = $6
  assert.equal(estimateCostUsd(1_000_000, 1_000_000), 6);
});

test("volumen bajo típico de una corrida", () => {
  // 6500 input, 1800 output -> (6500/1e6)*1 + (1800/1e6)*5
  const result = estimateCostUsd(6500, 1800);
  assert.ok(Math.abs(result - 0.0155) < 0.0001);
});

test("cero tokens da costo cero", () => {
  assert.equal(estimateCostUsd(0, 0), 0);
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx tsx --test src/lib/pricing.test.ts`
Expected: FAIL — `estimateCostUsd` no existe.

- [ ] **Step 3: Implementar `HAIKU_4_5_MODEL_ID` y `estimateCostUsd(inputTokens: number, outputTokens: number): number` en `src/lib/pricing.ts`**

`estimateCostUsd = (inputTokens / 1_000_000) * 1 + (outputTokens / 1_000_000) * 5`.

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `npx tsx --test src/lib/pricing.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/pricing.ts src/lib/pricing.test.ts
git commit -m "feat: estimar costo en USD de una corrida de curación"
```

---

## Task 4: `src/lib/budget.ts` — chequeo del tope mensual

**Files:**
- Create: `src/lib/budget.ts`
- Test: `src/lib/budget.test.ts`

**Interfaces:**
- Consumes: nada (función pura).
- Produces: `MONTHLY_BUDGET_CAP_USD = 5`, `hasExceededBudget(spentUsdThisMonth: number, capUsd: number): boolean`. La usa la Tarea 7 antes de llamar al LLM.

- [ ] **Step 1: Escribir el test**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { hasExceededBudget, MONTHLY_BUDGET_CAP_USD } from "./budget.js";

test("por debajo del tope no excede", () => {
  assert.equal(hasExceededBudget(4.99, 5), false);
});

test("exactamente en el tope sí excede (no llamar de nuevo)", () => {
  assert.equal(hasExceededBudget(5.0, 5), true);
});

test("por encima del tope excede", () => {
  assert.equal(hasExceededBudget(5.01, 5), true);
});

test("la constante del tope es 5", () => {
  assert.equal(MONTHLY_BUDGET_CAP_USD, 5);
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx tsx --test src/lib/budget.test.ts`
Expected: FAIL

- [ ] **Step 3: Implementar `MONTHLY_BUDGET_CAP_USD` y `hasExceededBudget(spentUsdThisMonth: number, capUsd: number): boolean` en `src/lib/budget.ts`**

`spentUsdThisMonth >= capUsd`.

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `npx tsx --test src/lib/budget.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/budget.ts src/lib/budget.test.ts
git commit -m "feat: chequeo puro del tope de gasto mensual"
```

---

## Task 5: `src/lib/curationPrompt.ts` — esquemas y prompts

**Files:**
- Create: `src/lib/curationPrompt.ts`
- Test: `src/lib/curationPrompt.test.ts`

**Interfaces:**
- Consumes: nada (funciones puras de armado de texto).
- Produces:
  - `TopicPickSchema` (zod): `{ topic: string; query: string }`.
  - `ArticleScoreSchema` (zod): `{ id: string; score: number (0-100); reason: string; discard: boolean }`.
  - `ScoringResponseSchema` (zod): `{ articles: ArticleScoreSchema[] }`.
  - `buildTopicPickPrompt(recentTopics: string[]): string`.
  - `buildScoringPrompt(input: { weights: Record<string, number>; likedTitles: string[]; dislikedTitles: string[]; candidates: Array<{ id: string; title: string; summary: string | null; category: string }> }): string`.
  Los usa la Tarea 6.

- [ ] **Step 1: Escribir los tests**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTopicPickPrompt, buildScoringPrompt } from "./curationPrompt.js";

test("el prompt de tema incluye los temas recientes a evitar", () => {
  const prompt = buildTopicPickPrompt(["historia", "espacio"]);
  assert.match(prompt, /historia/);
  assert.match(prompt, /espacio/);
});

test("el prompt de scoring instruye ignorar pesos para descubrimiento", () => {
  const prompt = buildScoringPrompt({
    weights: { macro: 1.2 },
    likedTitles: ["Suba de tasas en EE.UU."],
    dislikedTitles: [],
    candidates: [
      { id: "a1", title: "Nota de mercado", summary: null, category: "mercado" },
      { id: "d1", title: "Nota de descubrimiento", summary: null, category: "descubrimiento" },
    ],
  });
  assert.match(prompt, /descubrimiento/i);
  assert.match(prompt, /ignor/i); // instrucción de ignorar pesos en descubrimiento
  assert.match(prompt, /"a1"/);
  assert.match(prompt, /"d1"/);
});

test("el prompt de scoring incluye los pesos de categoría", () => {
  const prompt = buildScoringPrompt({
    weights: { macro: 1.45 },
    likedTitles: [],
    dislikedTitles: [],
    candidates: [],
  });
  assert.match(prompt, /1\.45/);
});
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `npx tsx --test src/lib/curationPrompt.test.ts`
Expected: FAIL — nada de esto existe todavía.

- [ ] **Step 3: Implementar los esquemas zod y las dos funciones de prompt en `src/lib/curationPrompt.ts`**

`buildScoringPrompt` debe serializar `candidates` (incluyendo su `id` y `category`) y `weights` en el texto, y agregar una instrucción explícita de que para `category === "descubrimiento"` el criterio es solo interés/calidad general, ignorando los pesos de afinidad — para las demás categorías, el criterio es relevancia según los pesos + `likedTitles`/`dislikedTitles`.

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `npx tsx --test src/lib/curationPrompt.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/curationPrompt.ts src/lib/curationPrompt.test.ts
git commit -m "feat: esquemas zod y prompts de curación (tema + scoring)"
```

---

## Task 6: `src/lib/anthropicClient.ts` — llamadas al LLM

**Files:**
- Create: `src/lib/anthropicClient.ts`
- Modify: `package.json` (agregar dependencias `@anthropic-ai/sdk` y `zod`)
- Modify: `.env.example` (agregar `ANTHROPIC_API_KEY=`)

**Interfaces:**
- Consumes: `TopicPickSchema`, `ScoringResponseSchema`, `buildTopicPickPrompt`, `buildScoringPrompt` de la Tarea 5; `HAIKU_4_5_MODEL_ID` de la Tarea 3.
- Produces:
  - `pickDiscoveryTopic(recentTopics: string[]): Promise<{ topic: string; query: string; inputTokens: number; outputTokens: number }>`
  - `scoreArticles(input: Parameters<typeof buildScoringPrompt>[0]): Promise<{ results: Array<{ id: string; score: number; reason: string; discard: boolean }>; inputTokens: number; outputTokens: number }>`
  Las usa la Tarea 7 (`src/curate.ts`).

- [ ] **Step 1: Instalar dependencias**

```bash
npm install @anthropic-ai/sdk zod
```

- [ ] **Step 2: Agregar `ANTHROPIC_API_KEY=` a `.env.example`** con un comentario indicando que es la key con el tope de $5/mes configurado en console.anthropic.com.

- [ ] **Step 3: Implementar `pickDiscoveryTopic` y `scoreArticles` en `src/lib/anthropicClient.ts`**

Usar `new Anthropic()` (credenciales por entorno), `client.messages.parse({ model: HAIKU_4_5_MODEL_ID, max_tokens: 16000, messages: [{role: "user", content: buildTopicPickPrompt(...) }], output_config: { format: zodOutputFormat(TopicPickSchema) } })` (y análogo para `scoreArticles` con `ScoringResponseSchema`). No pasar `thinking` (se omite). Leer `response.usage.input_tokens` / `response.usage.output_tokens` para devolverlos junto al resultado parseado (`response.parsed_output`); si `parsed_output` es `null`, lanzar un error descriptivo (el llamador en la Tarea 7 lo captura y registra como `status='error'` en `curation_runs`).

- [ ] **Step 4: Verificación manual (llamada real, sin mocks — mismo criterio que `fetchFeed` en este repo)**

Con `ANTHROPIC_API_KEY` real en `.env`, correr un script ad-hoc de una línea (`npx tsx -e '...'`) que llame a `pickDiscoveryTopic([])` y a `scoreArticles(...)` con 1-2 artículos de prueba, e imprimir el resultado — confirmar que devuelve JSON válido acorde al schema y que `inputTokens`/`outputTokens` son > 0. Esto cuesta centavos de dólar; es intencional (es la única forma real de validar contra la API).

- [ ] **Step 5: Commit**

```bash
git add src/lib/anthropicClient.ts package.json package-lock.json .env.example
git commit -m "feat: cliente de Anthropic para elegir tema y puntuar artículos"
```

---

## Task 7: `src/curate.ts` — orquestador de curación

**Files:**
- Create: `src/curate.ts`
- Modify: `package.json` (agregar script `"curate": "tsx src/curate.ts"`)

**Interfaces:**
- Consumes: `supabase` de `src/lib/supabase.ts`; `fetchFeed` de `src/lib/rss.ts`; `buildGoogleNewsRssUrl` (Tarea 2); `estimateCostUsd`, `HAIKU_4_5_MODEL_ID` (Tarea 3); `MONTHLY_BUDGET_CAP_USD`, `hasExceededBudget` (Tarea 4); `pickDiscoveryTopic`, `scoreArticles` (Tarea 6).
- Produces: script ejecutable (`npm run curate`) — no expone funciones a otras tareas.

- [ ] **Step 1: Implementar el flujo en `src/curate.ts`**

Orden exacto:
1. Insertar fila en `curation_runs` con `status='running'`, guardar su `id`.
2. Sumar `estimated_cost_usd` de `curation_runs` donde `started_at >= ` el primer día del mes en curso (excluyendo la fila recién creada). Si `hasExceededBudget(suma, MONTHLY_BUDGET_CAP_USD)` es true: actualizar la fila a `status='skipped_budget'`, `finished_at=now()`, y terminar (`process.exit(0)`) sin llamar al LLM.
3. Leer los últimos 14 días de `discovery_topic` desde `curation_runs` (`not null`, `started_at >= now() - 14 days`). Llamar `pickDiscoveryTopic(recentTopics)`.
4. Construir la URL con `buildGoogleNewsRssUrl(query)` y llamar `fetchFeed(url)` (Tarea existente) — si `ok: false`, tratar como cero artículos de descubrimiento (no aborta la corrida, mismo patrón de tolerancia a fallos que ya usa `ingest.ts`).
5. Leer de `articles` todas las filas con `curated_at is null` y `category` en las 5 categorías de interés (no `descubrimiento`).
6. Combinar esos artículos con los de descubrimiento recién traídos (estos últimos no existen todavía en `articles` — insertarlos primero con `category='descubrimiento'`, `source_id=null`, igual que hace `ingestSource` en `ingest.ts` pero sin fila de `sources` asociada, luego incluirlos en la lista de candidatos).
7. Si la lista combinada de candidatos está vacía: actualizar `curation_runs` a `status='ok'`, `articles_scored=0`, `articles_discarded=0`, `finished_at=now()`, `discovery_topic`/`discovery_query_url` igual (la Llamada #1 sí se hizo), y terminar — **no llamar a `scoreArticles`**.
8. Si no está vacía: leer una muestra (hasta 30) de títulos de `articles` con `liked=true` y otra con `liked=false`, y los pesos de `category_weights`. Llamar `scoreArticles({...})`.
9. Para cada resultado, hacer `update articles set score=..., reason=..., discarded=..., curated_at=now() where id=...`.
10. Sumar `inputTokens`/`outputTokens` de ambas llamadas del paso 3 y 8, calcular `estimateCostUsd(totalInput, totalOutput)`, y cerrar la fila de `curation_runs`: `status='ok'`, `finished_at=now()`, `model=HAIKU_4_5_MODEL_ID`, tokens, costo, `discovery_topic`, `discovery_query_url`, `articles_scored`, `articles_discarded`.
11. Si cualquier paso desde el 3 en adelante lanza una excepción: capturarla, actualizar la fila a `status='error'`, `error_message=<mensaje>`, `finished_at=now()`, y salir con código de error (`process.exitCode = 1`) — sin tirar la excepción sin capturar (mismo patrón que `main().catch(...)` en `ingest.ts`).

- [ ] **Step 2: Verificación manual (integración real, sin mocks)**

Con `.env` completo (Supabase + Anthropic) y al menos un artículo sin curar en la base (correr `npm run ingest` antes si hace falta), correr `npm run curate`. Verificar:
```sql
select status, articles_scored, articles_discarded, discovery_topic, estimated_cost_usd
from curation_runs order by started_at desc limit 1;
-- esperado: status='ok', articles_scored > 0 (si había candidatos), estimated_cost_usd > 0

select title, score, reason, discarded, category from articles
where curated_at is not null order by curated_at desc limit 5;
-- esperado: score/reason poblados, categoría 'descubrimiento' presente si hubo resultados
```
Después, correr `npm run curate` una segunda vez con cero artículos nuevos (`curated_at is null` vacío) y confirmar que la fila de `curation_runs` queda con `articles_scored=0` sin error.

- [ ] **Step 3: Commit**

```bash
git add src/curate.ts package.json
git commit -m "feat: script orquestador de curación (presupuesto, descubrimiento, scoring)"
```

---

## Task 8: GitHub Actions — segunda corrida diaria + secret de Anthropic

**Files:**
- Modify: `.github/workflows/ingest.yml`
- Modify: `README.md`

**Interfaces:**
- Consumes: script `npm run curate` (Tarea 7) y `npm run ingest` (existente).

- [ ] **Step 1: Modificar `.github/workflows/ingest.yml`**

Agregar un segundo horario de cron (ademas de `"0 11 * * *"`, sumar `"0 21 * * *"` — 18hs ART) y, en el job existente, un step nuevo después de `npm run ingest`:
```yaml
      - run: npm run curate
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

- [ ] **Step 2: Actualizar `README.md`**

Agregar a la sección de GitHub Actions: cargar `ANTHROPIC_API_KEY` como secret del repo, y una nota de que el workflow ahora corre 2 veces/día (8am y 18hs ART) e incluye la curación.

- [ ] **Step 3: Verificación manual**

Este paso requiere acceso a la cuenta de GitHub del usuario — **no lo ejecuta el agente**. Instrucciones para Tomás: cargar el secret `ANTHROPIC_API_KEY` en Settings → Secrets and variables → Actions, y disparar el workflow manualmente (`workflow_dispatch`) para confirmar en el log de Actions que ambos steps (`ingest` y `curate`) terminan en verde.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ingest.yml README.md
git commit -m "ci: segunda corrida diaria + step de curación"
```

---

## Task 9: Scaffold de `web/` + lectura de artículos agrupados

**Files:**
- Create: `web/package.json`, `web/tsconfig.json`, `web/next.config.ts`, `web/src/app/layout.tsx`, `web/src/app/globals.css`, `web/.env.example`
- Create: `web/src/lib/supabaseClient.ts`
- Create: `web/src/lib/queries.ts`
- Test: `web/src/lib/queries.test.ts`

**Interfaces:**
- Produces:
  - `supabase` (cliente Supabase server-side, misma forma que `src/lib/supabase.ts` del proyecto raíz — service role key, nunca expuesta al browser).
  - `CATEGORY_ORDER: readonly string[]` = `["macro", "mercado", "tech", "emprendimientos", "deportes", "descubrimiento"]`.
  - `type ArticleRow = { id: string; title: string; url: string; category: string; score: number | null; reason: string | null; liked: boolean | null; curated_at: string; source: { name: string } | null }`.
  - `groupArticlesByCategory(articles: ArticleRow[]): Map<string, ArticleRow[]>` (una entrada por cada valor de `CATEGORY_ORDER`, en ese orden, incluso si está vacía).
  - `getDigestWindowStart(now: Date): Date` (`now` menos 48 horas).
  Las usa la Tarea 11 (`page.tsx`) y la Tarea 12 (`route.ts` usa `supabaseClient`).

- [ ] **Step 1: Scaffold del proyecto Next.js en `web/`**

`npx create-next-app@latest web --typescript --tailwind --app --no-src-dir=false --eslint=false` (o equivalente manual si el comando interactivo no aplica en CI) — App Router, TypeScript, Tailwind. Agregar el script `"test": "tsx --test src/**/*.test.ts"` a `web/package.json` y `tsx`/`@types/node` como devDependencies (mismo test runner que el proyecto raíz).

- [ ] **Step 2: Implementar `web/src/lib/supabaseClient.ts`**

Igual patrón que `src/lib/supabase.ts` del proyecto raíz: lee `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` de `process.env`, lanza si faltan, exporta `supabase`. Crear `web/.env.example` con esas dos variables.

- [ ] **Step 3: Escribir los tests de `queries.ts`**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { groupArticlesByCategory, getDigestWindowStart, CATEGORY_ORDER, type ArticleRow } from "./queries.js";

function article(overrides: Partial<ArticleRow>): ArticleRow {
  return {
    id: "1", title: "t", url: "https://x.com", category: "macro",
    score: 50, reason: "r", liked: null, curated_at: "2026-09-27T00:00:00Z",
    source: null, ...overrides,
  };
}

test("agrupa por categoría en el orden fijo, incluyendo categorías vacías", () => {
  const grouped = groupArticlesByCategory([article({ category: "deportes" })]);
  assert.deepEqual([...grouped.keys()], CATEGORY_ORDER);
  assert.equal(grouped.get("macro")!.length, 0);
  assert.equal(grouped.get("deportes")!.length, 1);
});

test("getDigestWindowStart resta 48 horas", () => {
  const now = new Date("2026-09-27T12:00:00Z");
  const start = getDigestWindowStart(now);
  assert.equal(start.toISOString(), "2026-09-25T12:00:00.000Z");
});
```

- [ ] **Step 4: Correr los tests y verificar que fallan**

Run: `cd web && npx tsx --test src/lib/queries.test.ts`
Expected: FAIL

- [ ] **Step 5: Implementar `CATEGORY_ORDER`, `ArticleRow`, `groupArticlesByCategory`, `getDigestWindowStart` en `web/src/lib/queries.ts`**

- [ ] **Step 6: Correr los tests y verificar que pasan**

Run: `cd web && npx tsx --test src/lib/queries.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add web/
git commit -m "feat: scaffold de Next.js + agrupación de artículos por categoría"
```

---

## Task 10: `web/src/lib/sourceLabel.ts` — nombre de fuente con fallback

**Files:**
- Create: `web/src/lib/sourceLabel.ts`
- Test: `web/src/lib/sourceLabel.test.ts`

**Interfaces:**
- Consumes: `ArticleRow` de la Tarea 9.
- Produces: `getSourceLabel(article: Pick<ArticleRow, "source" | "url">): string`. La usa la Tarea 11.

- [ ] **Step 1: Escribir el test**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { getSourceLabel } from "./sourceLabel.js";

test("usa el nombre de la fuente cuando existe", () => {
  assert.equal(
    getSourceLabel({ source: { name: "Infobae Economía" }, url: "https://infobae.com/x" }),
    "Infobae Economía"
  );
});

test("cae al hostname (sin www.) cuando no hay fuente asociada", () => {
  assert.equal(
    getSourceLabel({ source: null, url: "https://www.clarin.com/nota" }),
    "clarin.com"
  );
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `cd web && npx tsx --test src/lib/sourceLabel.test.ts`
Expected: FAIL

- [ ] **Step 3: Implementar `getSourceLabel` en `web/src/lib/sourceLabel.ts`**

Si `article.source` no es null, devolver `article.source.name`. Si no, `new URL(article.url).hostname` sacando el prefijo `www.` si está.

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `cd web && npx tsx --test src/lib/sourceLabel.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/sourceLabel.ts web/src/lib/sourceLabel.test.ts
git commit -m "feat: nombre de fuente con fallback a hostname para artículos de descubrimiento"
```

---

## Task 11: `web/src/lib/weights.ts` — ajuste de peso por feedback

**Files:**
- Create: `web/src/lib/weights.ts`
- Test: `web/src/lib/weights.test.ts`

**Interfaces:**
- Produces: `WEIGHT_STEP = 0.15`, `WEIGHT_MIN = 0.2`, `WEIGHT_MAX = 3.0`, `computeWeightDelta(previousLiked: boolean | null, newLiked: boolean): number`, `clampWeight(weight: number): number`. Las usa la Tarea 12 (`route.ts`).

- [ ] **Step 1: Escribir el test**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeWeightDelta, clampWeight, WEIGHT_MIN, WEIGHT_MAX } from "./weights.js";

test("sin feedback previo, like suma un paso", () => {
  assert.equal(computeWeightDelta(null, true), 0.15);
});

test("sin feedback previo, dislike resta un paso", () => {
  assert.equal(computeWeightDelta(null, false), -0.15);
});

test("pasar de like a dislike aplica el delta neto (revierte + aplica)", () => {
  assert.equal(computeWeightDelta(true, false), -0.30);
});

test("pasar de dislike a like aplica el delta neto", () => {
  assert.equal(computeWeightDelta(false, true), 0.30);
});

test("click repetido sobre el mismo valor es un no-op", () => {
  assert.equal(computeWeightDelta(true, true), 0);
  assert.equal(computeWeightDelta(false, false), 0);
});

test("clampWeight respeta el piso y el techo", () => {
  assert.equal(clampWeight(0.1), WEIGHT_MIN);
  assert.equal(clampWeight(5), WEIGHT_MAX);
  assert.equal(clampWeight(1.5), 1.5);
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `cd web && npx tsx --test src/lib/weights.test.ts`
Expected: FAIL

- [ ] **Step 3: Implementar las constantes y funciones en `web/src/lib/weights.ts`**

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `cd web && npx tsx --test src/lib/weights.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/weights.ts web/src/lib/weights.test.ts
git commit -m "feat: cálculo puro del delta de peso por like/dislike"
```

---

## Task 12: `web/src/app/api/feedback/route.ts` — endpoint de like/dislike

**Files:**
- Create: `web/src/app/api/feedback/route.ts`

**Interfaces:**
- Consumes: `supabase` (Tarea 9), `computeWeightDelta`, `clampWeight` (Tarea 11).
- Produces: `POST /api/feedback` — lo consume la Tarea 13 (frontend).

- [ ] **Step 1: Implementar `POST(request: Request)` en `web/src/app/api/feedback/route.ts`**

Body esperado: `{ article_id: string; liked: boolean }`.
1. Leer el artículo (`select id, category, liked from articles where id = article_id`). Si no existe, devolver 404.
2. `update articles set liked = liked where id = article_id`.
3. Leer la fila de `category_weights` para `article.category`. Si no existe ninguna fila (categoría desconocida): devolver 200 igual (el like ya se guardó) sin tocar pesos — no es un error fatal, solo se salta el ajuste (Review Focus: no debe tirar 500).
4. Si existe: `newWeight = clampWeight(row.weight + computeWeightDelta(article.liked, liked))`, `update category_weights set weight = newWeight, updated_at = now() where category = article.category`.
5. Devolver `200 { ok: true }`.

- [ ] **Step 2: Verificación manual (integración real, sin mocks)**

Con `web/.env.local` apuntando a Supabase real y `next dev` corriendo, y un artículo de prueba en la base:
```bash
curl -X POST http://localhost:3000/api/feedback -H 'content-type: application/json' \
  -d '{"article_id":"<id-real>","liked":true}'
```
Verificar por SQL que `articles.liked=true` y que `category_weights.weight` de esa categoría subió 0.15. Repetir con `liked:false` sobre el mismo artículo y confirmar que el peso baja 0.30 desde el valor anterior (revierte el like + aplica el dislike). Probar también con un `article_id` inexistente (esperar 404) y, si es posible, con un artículo de una categoría sin fila en `category_weights` (esperar 200 sin cambios de peso).

- [ ] **Step 3: Commit**

```bash
git add web/src/app/api/feedback/route.ts
git commit -m "feat: endpoint de feedback (like/dislike) con ajuste de peso"
```

---

## Task 13: `web/src/app/page.tsx` — página del digest

**Files:**
- Create: `web/src/app/page.tsx`
- Create: `web/src/app/components/ArticleCard.tsx`
- Create: `web/src/app/components/FeedbackButtons.tsx` (client component)

**Interfaces:**
- Consumes: `supabase`, `CATEGORY_ORDER`, `ArticleRow`, `groupArticlesByCategory`, `getDigestWindowStart` (Tarea 9); `getSourceLabel` (Tarea 10); `POST /api/feedback` (Tarea 12).

- [ ] **Step 1: Implementar `page.tsx` como server component (async function)**

Query: `supabase.from("articles").select("id, title, url, category, score, reason, liked, curated_at, source:sources(name)").eq("discarded", false).gte("curated_at", getDigestWindowStart(new Date()).toISOString()).order("score", { ascending: false })`. Pasar el resultado por `groupArticlesByCategory`. Renderizar un `<section>` por cada categoría de `CATEGORY_ORDER`, con su heading, la lista de `ArticleCard`, y el mensaje "Sin novedades hoy" (texto exacto) cuando la lista esté vacía.

- [ ] **Step 2: Implementar `ArticleCard.tsx`**

Tarjeta con: `<a href={article.url} target="_blank" rel="noreferrer">{article.title}</a>`, `getSourceLabel(article)`, `article.reason`, fecha formateada de `article.curated_at`, y `<FeedbackButtons articleId={article.id} liked={article.liked} />`.

- [ ] **Step 3: Implementar `FeedbackButtons.tsx` (client component, `"use client"`)**

Dos botones (👍/👎) que hacen `fetch("/api/feedback", { method: "POST", body: JSON.stringify({ article_id, liked }) })` al click, con estado local optimista para reflejar cuál quedó activo (sin usar `router.refresh()` ni recargar la sección entera).

- [ ] **Step 4: Verificación manual (visual, sin test automatizado — es solo render/estilo)**

Con `web/.env.local` apuntando a datos reales (correr `npm run curate` en el proyecto raíz primero para tener artículos con `score`/`reason`/`curated_at` poblados), correr `cd web && npm run dev` y abrir `http://localhost:3000`. Confirmar: las 6 secciones aparecen en el orden fijo, una categoría sin artículos muestra "Sin novedades hoy", cada tarjeta linkea a la fuente real en pestaña nueva, y tocar 👍/👎 cambia el estado visual del botón sin recargar la página.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/page.tsx web/src/app/components/
git commit -m "feat: página del digest agrupada por categoría con feedback"
```

---

## Task 14: Deploy y configuración de cuenta (checklist, no código)

**Files:**
- Modify: `README.md`

Esta tarea es mayormente pasos que requieren acceso a las cuentas de Tomás — **el agente escribe el checklist en el README pero no puede ejecutar estos pasos por él**.

- [ ] **Step 1: Documentar en `README.md` el checklist de deploy**

- Conectar el repo a Vercel con **root directory = `web/`**, variables de entorno `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY`.
- Cargar el secret `ANTHROPIC_API_KEY` en GitHub Actions (ver Tarea 8).
- Configurar en console.anthropic.com un límite de gasto de **$5/mes** sobre la API key usada.
- Correr la migración de la Tarea 1 en el proyecto de Supabase de producción si todavía no se corrió ahí.

- [ ] **Step 2: Tomás ejecuta el checklist de arriba manualmente** (fuera del alcance de un subagente — requiere sus propias credenciales de Vercel/GitHub/Anthropic).

- [ ] **Step 3: Verificación final end-to-end**

Una vez deployado: abrir la URL de Vercel, confirmar que carga el digest (puede estar vacío si no corrió `curate` todavía), disparar el workflow de GitHub Actions manualmente, y refrescar la página para confirmar que aparecen artículos puntuados.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: checklist de deploy (Vercel, secrets, tope de gasto)"
```
