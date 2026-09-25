/*
 * Supabase connection for shared orders.
 * Find these in Supabase: Project Settings > API (or "Connect" > App frameworks).
 *   supabaseUrl:     Project URL, e.g. https://abcdefghijk.supabase.co
 *   supabaseAnonKey: the "anon" / "publishable" key (safe to ship: the database only
 *                    lets signed-in users in - see supabase/schema.sql).
 * Leave both empty to run in single-device mode (orders saved on the phone only).
 */
window.APP_CONFIG = {
  supabaseUrl: "https://drhnhpuzrfmlvcmkzmmg.supabase.co",
  supabaseAnonKey: "sb_publishable_ZilRyEAiV3t2urJzPy7nOg_DijyIo89",
  // Name of the Edge Function deployed from supabase/functions/admin-users/index.ts
  adminFunction: "swift-processor"
};
