import { createClient } from "@supabase/supabase-js";

/*
  Supabase browser client. Reads the public URL + anon key from build-time env
  (VITE_* vars are exposed to the browser by design; the anon key is safe to ship).
  If they're not set, the app runs WITHOUT auth (local/preview) so nothing breaks.
*/
const url = import.meta.env.VITE_SUPABASE_URL;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabaseEnabled = Boolean(url && anon);
export const supabase = supabaseEnabled ? createClient(url, anon) : null;
