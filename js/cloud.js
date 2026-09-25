/*
 * Thin wrapper around Supabase for shared orders.
 * When js/config.js has no Supabase URL/key the app runs in single-device mode (Cloud.enabled === false).
 */
(function () {
  "use strict";

  var cfg = window.APP_CONFIG || {};
  var enabled = !!(cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase);
  var client = enabled
    ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
        auth: { persistSession: true, autoRefreshToken: true, storageKey: "mo.auth" }
      })
    : null;
  var user = null;

  function orderRow(o) {
    var data = JSON.parse(JSON.stringify(o));
    delete data.dirty;
    return {
      id: o.id,
      number: o.number || null,
      job_number: o.jobNumber,
      job_name: o.jobName || null,
      supplier: o.supplier,
      status: o.status,
      requested_by: o.requestedBy || null,
      total: o.lines.reduce(function (s, l) { return l.source === "shop" ? s : s + (+l.qty || 0) * (+l.price || 0); }, 0).toFixed(2),
      data: data,
      created_by_email: o.createdBy || null,
      created_at: o.createdAt,
      updated_at: o.updatedAt
    };
  }

  function rowToOrder(r) {
    var o = r.data || {};
    o.id = r.id;
    o.number = r.number;
    o.status = r.status;
    o.updatedAt = r.updated_at;
    o.lines = o.lines || [];
    return o;
  }

  function must(res) {
    if (res.error) throw res.error;
    return res.data;
  }

  var Cloud = {
    enabled: enabled,
    get user() { return user; },

    // Resolves with the signed-in user or null.
    init: function () {
      if (!enabled) return Promise.resolve(null);
      client.auth.onAuthStateChange(function (_evt, session) { user = session ? session.user : null; });
      return client.auth.getSession().then(function (res) {
        user = res.data && res.data.session ? res.data.session.user : null;
        return user;
      }, function () { return null; });
    },

    signIn: function (email, password) {
      return client.auth.signInWithPassword({ email: email, password: password }).then(function (res) {
        if (res.error) throw res.error;
        user = res.data.user;
        return user;
      });
    },

    signOut: function () {
      user = null;
      return client.auth.signOut().catch(function () { /* offline: local session is still cleared */ });
    },

    nextOrderNumber: function (jobNumber) {
      return client.rpc("next_order_number", { p_job: jobNumber }).then(must);
    },

    pushOrder: function (o) {
      return client.from("orders").upsert(orderRow(o), { onConflict: "id" }).then(must);
    },

    deleteOrder: function (id) {
      return client.from("orders").delete().eq("id", id).then(must);
    },

    // Most recent orders across the whole company.
    pullOrders: function () {
      return client.from("orders")
        .select("id, number, status, data, updated_at")
        .order("updated_at", { ascending: false })
        .limit(1000)
        .then(must)
        .then(function (rows) { return rows.map(rowToOrder); });
    },

    getSupplierEmails: function () {
      return client.from("supplier_contacts").select("supplier, email").then(must).then(function (rows) {
        var out = {};
        rows.forEach(function (r) { if (r.email) out[r.supplier] = r.email; });
        return out;
      });
    },

    setSupplierEmail: function (supplier, email) {
      return client.from("supplier_contacts")
        .upsert({ supplier: supplier, email: email || null, updated_at: new Date().toISOString() }, { onConflict: "supplier" })
        .then(must);
    }
  };

  // ---------------------------------------------------------------- shop stock & users

  // Permission row for the signed-in user ({role, can_edit_shop, blocked}) or a default for crew.
  Cloud.getMyAccess = function () {
    return client.from("app_users").select("email, name, role, can_edit_shop, blocked")
      .eq("email", (user && user.email || "").toLowerCase()).maybeSingle().then(must)
      .then(function (r) { return r || { role: "user", can_edit_shop: false, blocked: false }; }, function (e) {
        // Table missing = supabase/shop.sql hasn't been run yet.
        if (/PGRST205|42P01|does not exist|schema cache/i.test((e && (e.code + " " + e.message)) || "")) {
          return { role: "user", can_edit_shop: false, blocked: false, setupMissing: true };
        }
        throw e;
      });
  };

  Cloud.listStock = function () {
    return client.from("shop_stock").select("item_key, item_name, unit, category, model, division, qty, updated_by, updated_at")
      .order("item_name").limit(5000).then(must);
  };

  Cloud.stockLog = function (itemKey) {
    return client.from("shop_log").select("division, delta, qty_after, reason, job_number, by_email, at")
      .eq("item_key", itemKey).order("at", { ascending: false }).limit(50).then(must);
  };

  // opt: {item:{key,name,unit,category,model}, division, delta?, set?, reason?, job?, orderId?}
  Cloud.adjustStock = function (opt) {
    return client.rpc("adjust_stock", {
      p_item_key: opt.item.key, p_item_name: opt.item.name, p_unit: opt.item.unit || null,
      p_category: opt.item.category || null, p_model: opt.item.model || null,
      p_division: opt.division, p_delta: opt.delta == null ? 0 : opt.delta,
      p_set: opt.set == null ? null : opt.set,
      p_reason: opt.reason || null, p_job: opt.job || null, p_order: opt.orderId || null
    }).then(must);
  };

  Cloud.listUsers = function () {
    return client.from("app_users").select("email, name, role, can_edit_shop, blocked").order("email").then(must);
  };

  Cloud.saveUser = function (u) {
    return client.from("app_users").upsert({
      email: u.email.trim().toLowerCase(), name: u.name || null, role: u.role || "user",
      can_edit_shop: !!u.can_edit_shop, blocked: !!u.blocked, updated_at: new Date().toISOString()
    }, { onConflict: "email" }).then(must);
  };

  Cloud.deleteUser = function (email) {
    return client.from("app_users").delete().eq("email", email).then(must);
  };

  // Calls the admin-users Edge Function (create a login / reset a password).
  Cloud.adminUsers = function (body) {
    return client.functions.invoke(cfg.adminFunction || "admin-users", { body: body }).then(function (res) {
      if (res.error) {
        var err = res.error, ctx = err.context, status = ctx && ctx.status;
        var fail = function (msg) { var e = new Error(msg); e.fnStatus = status; e.fnKind = err.name; throw e; };
        if (err.name === "FunctionsFetchError") {
          fail("Couldn't reach the \"" + (cfg.adminFunction || "admin-users") + "\" function. In Supabase > Edge Functions > " + (cfg.adminFunction || "admin-users") + ", turn OFF \"Verify JWT\".");
        }
        if (status === 404) fail("Supabase has no Edge Function named \"" + (cfg.adminFunction || "admin-users") + "\". Check the name in js/config.js.");
        if (ctx && typeof ctx.json === "function") {
          return ctx.json().then(function (j) {
            fail((j && (j.error || j.message || j.msg)) || err.message + (status ? " (" + status + ")" : ""));
          }, function () { fail(err.message + (status ? " (" + status + ")" : "")); });
        }
        fail(err.message);
      }
      if (res.data && res.data.error) throw new Error(res.data.error);
      return res.data;
    });
  };

  window.Cloud = Cloud;
})();
