import { supabase, supabaseEnabled } from "./supabase.js";

/*
  fetch wrapper that attaches the signed-in user's Supabase JWT so the backend
  /api functions can verify the request and enforce roles. When Supabase isn't
  configured it behaves like plain fetch (open local/preview mode).
*/
export async function apiFetch(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (supabaseEnabled) {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  return fetch(path, { ...opts, headers });
}

export async function apiJson(path, opts) {
  const res = await apiFetch(path, opts);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}
