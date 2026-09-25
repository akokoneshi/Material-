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
      total: o.lines.reduce(function (s, l) { return s + (+l.qty || 0) * (+l.price || 0); }, 0).toFixed(2),
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

  window.Cloud = Cloud;
})();
