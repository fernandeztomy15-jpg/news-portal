import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  throw new Error(
    "Faltan SUPABASE_URL y/o SUPABASE_SERVICE_ROLE_KEY. " +
      "Copiá .env.example a .env.local y completalo (local), o cargalos " +
      "como variables de entorno del proyecto en Vercel."
  );
}

// Service role: este cliente corre server-side (Server Components / Route
// Handlers), nunca en el browser. No exponer esta key al cliente.
export const supabase = createClient(url, key, {
  auth: { persistSession: false },
});
