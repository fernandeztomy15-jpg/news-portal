# news-portal — ingesta

Motor de ingesta RSS → Supabase para el portal de noticias. Fase 1 del
proyecto: solo ingesta y persistencia, sin frontend todavía.

## Qué hace

- Lee la tabla `sources` (Supabase) y procesa las que tengan `active = true`.
- Por cada una, trae su feed RSS, lo parsea y hace upsert en `articles`
  con `url` como clave única (dedupe real, no aproximado).
- Cada corrida, por fuente, queda registrada en `ingestion_runs`
  (éxito, error, cuántos items encontró/insertó). Esto es lo que te
  va a permitir ver por qué una fuente no trajo nada, en vez de
  descubrirlo por ausencia como pasaba con Ades en el digest viejo.
- Una fuente rota no frena a las demás: el error queda logueado y el
  resto de la corrida sigue.

## Lo que NO hice (a propósito, no por olvido)

No completé `feed_url` para Infobae, Ámbito, Bloomberg Línea, Olé,
ESPN ni TyC Sports porque no encontré/pude verificar un feed RSS real
para ninguna en la búsqueda que hice. Quedan en `supabase/schema.sql`
como filas inactivas (`active = false`, `feed_url = null`) para que
las completes vos cuando confirmes la URL real, o las marques como
`source_type = 'scrape'` si terminan sin RSS (ver más abajo).

**Dato verificado, no inferido:** Reuters discontinuó sus feeds RSS
públicos en junio de 2020. Para esa fuente no hay URL que valga la
pena buscar — hay que resolverla con scraping o con un servicio de
terceros (ej. Google News RSS como proxy no oficial, con el riesgo de
que rompa sin aviso).

## Setup

1. **Supabase**: creá un proyecto (si no lo tenés) y corré el
   contenido de `supabase/schema.sql` en el SQL editor. Esto crea las
   tablas y carga la fuente de Ades como único seed activo.
2. **Variables de entorno**: copiá `.env.example` a `.env` y completá
   `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` (Project Settings →
   API, la *service role* key — no la `anon`).
3. **Instalar y correr local**:
   ```bash
   npm install
   npm run ingest
   ```
   Con el seed default, esto va a intentar traer
   `https://albertoades.substack.com/feed`. Si el 404 confirma que
   Ades tiene el RSS desactivado en su config de Substack, vas a
   verlo clarito en la consola y en `ingestion_runs.error_message` —
   ese es justamente el caso que antes quedaba invisible.
4. **GitHub Actions**: en el repo, `Settings → Secrets and variables →
   Actions`, cargá `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` como
   secrets. El workflow en `.github/workflows/ingest.yml` corre todos
   los días a las 8am ART, y también lo podés disparar a mano desde
   la pestaña Actions (`workflow_dispatch`).

## Cómo sumar una fuente nueva

Si tiene RSS confirmado:
```sql
update sources
set feed_url = 'https://ejemplo.com/feed', active = true
where id = 'infobae-economia';
```
No hace falta tocar código ni redeployar.

Si NO tiene RSS (como Reuters), esa fuente necesita un scraper
dedicado — eso es fase 2, no está en este scaffold. La tabla ya tiene
el campo `source_type = 'scrape'` reservado para cuando lo
construyamos.

## Próximo paso sugerido

Llevar esta carpeta a Claude Code en tu Mac (ya lo tenés instalado),
`git init` + push a un repo nuevo, conectar el repo a Vercel (para el
cron nativo que ya habías decidido probar) o dejarlo corriendo por
GitHub Actions como está acá. Desde el chat de Claude.ai no puedo
crear el repo ni tocar tus cuentas de Vercel/Supabase directamente.
