import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  throw new Error(
    "Faltan SUPABASE_URL y/o SUPABASE_SERVICE_ROLE_KEY. " +
      "Copiá .env.example a .env y completalo (local), o cargalos " +
      "como secrets del repo (GitHub Actions)."
  );
}

// Service role: este cliente corre server-side (script de ingesta / CI),
// nunca en el browser. No reusar esta key en el frontend del portal.
export const supabase = createClient(url, key, {
  auth: { persistSession: false },
});

export type SourceRow = {
  id: string;
  name: string;
  category: string;
  feed_url: string | null;
  source_type: "rss" | "scrape";
  active: boolean;
};
