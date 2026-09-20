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

## Estado de las fuentes (actualizado 20/9/2026, Sesión 1)

Confirmadas en vivo y activas (fetch real, HTTP 200, XML válido):

- **Ades — Parte Diario**: `https://albertoades.substack.com/feed`
- **Infobae Economía**: `https://www.infobae.com/arc/outboundfeeds/rss/category/economia/`
- **Ámbito Economía**: `https://www.ambito.com/rss/pages/economia.xml`
- **Olé**: `https://www.ole.com.ar/rss/ultimas-noticias`

Sin RSS confirmado, quedan inactivas (`active = false`, `feed_url =
null`) en `supabase/schema.sql`:

- **Bloomberg Línea**: no encontramos ningún feed documentado ni por búsqueda.
- **ESPN Argentina**: `espn.com.ar/rss/...` redirige a una URL rota (http, 302 a vacío). No probamos el feed general de espndeportes.espn.com porque no es específicamente "ESPN Argentina".
- **TyC Sports**: `/feed` y `/arc/outboundfeeds/rss/` devuelven 404 en vivo.

Si en algún momento encontrás/confirmás una URL real para alguna de
estas tres, activarla es solo un `update` (ver sección de abajo) — no
hace falta tocar código ni redeployar.

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
   Con las 4 fuentes activas (ver estado abajo), esto debería traer
   e insertar artículos reales sin error. Si alguna fuente falla en
   el futuro (feed movido, timeout, etc.), lo vas a ver clarito en la
   consola y en `ingestion_runs.error_message` — ese es justamente el
   caso que antes quedaba invisible.
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
