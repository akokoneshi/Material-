// Supabase Edge Function: lets an app admin create a login for a new crew member.
// Deploy: Dashboard > Edge Functions > (your function) > Code: replace ALL of index.ts with this file,
// click Deploy, then in the function's Settings turn OFF "Verify JWT" (this code checks the caller itself).
// The function's name must match adminFunction in js/config.js.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    // Newer projects expose sb_secret_ keys as SUPABASE_SECRET_KEYS (JSON); older ones SUPABASE_SERVICE_ROLE_KEY.
    let adminKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    if (!adminKey) {
      try { adminKey = Object.values(JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}"))[0] as string || ""; } catch { /* ignore */ }
    }
    if (!adminKey) return reply({ error: "Function has no service key available" }, 500);
    const service = createClient(url, adminKey);

    // Who is calling?
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer /i, "");
    const { data: caller, error: callerErr } = await service.auth.getUser(token);
    if (callerErr || !caller.user?.email) return reply({ error: "Not signed in" }, 401);
    const { data: me } = await service.from("app_users").select("role, blocked")
      .eq("email", caller.user.email.toLowerCase()).maybeSingle();
    if (!me || me.role !== "admin" || me.blocked) return reply({ error: "Only an admin can do this" }, 403);

    const body = await req.json();
    const email = String(body.email || "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return reply({ error: "Enter a valid email" }, 400);

    if (body.action === "create") {
      const password = String(body.password || "");
      if (password.length < 8) return reply({ error: "Password must be at least 8 characters" }, 400);
      const { error } = await service.auth.admin.createUser({
        email, password, email_confirm: true, user_metadata: { full_name: body.name || "" },
      });
      if (error && !/already/i.test(error.message)) return reply({ error: error.message }, 400);
      return reply({ ok: true, existed: !!error });
    }

    if (body.action === "reset-password") {
      const password = String(body.password || "");
      if (password.length < 8) return reply({ error: "Password must be at least 8 characters" }, 400);
      const { data: list, error: listErr } = await service.auth.admin.listUsers({ perPage: 1000 });
      if (listErr) return reply({ error: listErr.message }, 400);
      const user = list.users.find((u) => (u.email || "").toLowerCase() === email);
      if (!user) return reply({ error: "No login exists for that email" }, 404);
      const { error } = await service.auth.admin.updateUserById(user.id, { password });
      if (error) return reply({ error: error.message }, 400);
      return reply({ ok: true });
    }

    return reply({ error: "Unknown action" }, 400);
  } catch (e) {
    return reply({ error: String(e?.message || e) }, 500);
  }
});
