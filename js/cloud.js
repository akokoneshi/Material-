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

  // Supabase returns at most 1,000 rows per request, so read big tables page by page.
  // makeQuery() must return a fresh, ordered query each time.
  function fetchAll(makeQuery, pageSize) {
    pageSize = pageSize || 1000;
    var all = [];
    function page(from) {
      return makeQuery().range(from, from + pageSize - 1).then(must).then(function (rows) {
        all = all.concat(rows);
        return rows.length < pageSize ? all : page(from + pageSize);
      });
    }
    return page(0);
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
    return client.from("app_users").select("*")
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
    return fetchAll(function () {
      return client.from("shop_stock").select("item_key, item_name, unit, category, model, division, qty, updated_by, updated_at")
        .order("item_name").order("item_key").order("division");
    });
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
    return client.from("app_users").select("*").order("email").then(must);
  };

  Cloud.saveUser = function (u) {
    return client.from("app_users").upsert({
      email: u.email.trim().toLowerCase(), name: u.name || null, role: u.role || "user",
      can_edit_shop: !!u.can_edit_shop, blocked: !!u.blocked, updated_at: new Date().toISOString(),
      can_review_invoices: !!u.can_review_invoices
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

  // ---------------------------------------------------------------- special (job) pricing books

  // All books with their items: [{id, job_number, job_key, supplier, name, active, updated_at, items:[{item_key, price, ...}]}]
  Cloud.listBooks = function () {
    return client.from("price_books").select("id, job_number, job_keys, supplier, name, active, updated_at")
      .order("job_number").then(must).then(function (books) {
        if (!books.length) return books;
        return fetchAll(function () {
          return client.from("price_book_items").select("book_id, item_key, item_name, unit, price").order("book_id").order("item_key");
        })
          .then(function (items) {
            var byBook = {};
            items.forEach(function (it) { (byBook[it.book_id] = byBook[it.book_id] || []).push(it); });
            books.forEach(function (b) { b.items = byBook[b.id] || []; });
            return books;
          });
      }, function (e) {
        if (/PGRST205|42P01|does not exist|schema cache/i.test((e && (e.code + " " + e.message)) || "")) { var err = new Error("setup"); err.setupMissing = true; throw err; }
        throw e;
      });
  };

  Cloud.saveBook = function (b) {
    var row = { job_number: b.job_number.trim(), supplier: b.supplier, name: b.name || null, active: b.active !== false, updated_at: new Date().toISOString() };
    var q = b.id ? client.from("price_books").update(row).eq("id", b.id) : client.from("price_books").insert(row);
    return q.select("id").then(must).then(function (rows) { return rows[0].id; });
  };

  Cloud.deleteBook = function (id) {
    return client.from("price_books").delete().eq("id", id).then(must);
  };

  // rows: [{item_key, item_name, unit, price}]
  Cloud.upsertBookItems = function (bookId, rows) {
    var now = new Date().toISOString();
    var payload = rows.map(function (r) { return { book_id: bookId, item_key: r.item_key, item_name: r.item_name, unit: r.unit, price: r.price, updated_at: now }; });
    var chain = Promise.resolve();
    for (var i = 0; i < payload.length; i += 500) {
      (function (chunk) {
        chain = chain.then(function () { return client.from("price_book_items").upsert(chunk, { onConflict: "book_id,item_key" }).then(must); });
      })(payload.slice(i, i + 500));
    }
    return chain.then(function () {
      return client.from("price_books").update({ updated_at: now }).eq("id", bookId).then(must);
    });
  };

  Cloud.deleteBookItem = function (bookId, itemKey) {
    return client.from("price_book_items").delete().eq("book_id", bookId).eq("item_key", itemKey).then(must);
  };

  // ---------------------------------------------------------------- vendor invoices

  Cloud.listInvoices = function () {
    return fetchAll(function () {
      return client.from("invoices").select("*").order("created_at", { ascending: false }).order("id");
    });
  };

  Cloud.getInvoice = function (id) {
    return client.from("invoices").select("*").eq("id", id).single().then(must);
  };

  // Upload the file, create the invoice record, then start the AI agent on it.
  Cloud.uploadInvoice = function (file) {
    var safe = String(file.name || "invoice").replace(/[^\w.\-]+/g, "_").slice(-80);
    var path = new Date().toISOString().slice(0, 10) + "/" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7) + "_" + safe;
    return client.storage.from("invoices").upload(path, file, { contentType: file.type || undefined, upsert: false }).then(must)
      .then(function () {
        return client.from("invoices").insert({ file_path: path, file_name: file.name, file_type: file.type || null, status: "processing" })
          .select("id").single().then(must);
      })
      .then(function (row) {
        Cloud.runInvoiceAgent(row.id).catch(function (e) {
          // (queries only run when awaited/then'd)
          return client.from("invoices").update({ status: "error", error: e.message }).eq("id", row.id).then(function () {});
        });
        return row.id;
      });
  };

  Cloud.runInvoiceAgent = function (invoiceId, orderId) {
    var fn = cfg.invoiceFunction || "invoice-agent";
    return client.functions.invoke(fn, { body: { invoice_id: invoiceId, order_id: orderId || null } }).then(function (res) {
      if (res.error) {
        var ctx = res.error.context;
        if (res.error.name === "FunctionsFetchError") throw new Error("Couldn't reach the \"" + fn + "\" function. Check it's deployed with that name and \"Verify JWT\" is off.");
        if (ctx && ctx.status === 404) throw new Error("Supabase has no Edge Function named \"" + fn + "\".");
        if (ctx && typeof ctx.json === "function") return ctx.json().then(function (j) { throw new Error(j.error || res.error.message); }, function () { throw res.error; });
        throw res.error;
      }
      if (res.data && res.data.error) throw new Error(res.data.error);
      return res.data;
    });
  };

  Cloud.updateInvoice = function (id, patch) {
    patch.updated_at = new Date().toISOString();
    return client.from("invoices").update(patch).eq("id", id).then(must);
  };

  Cloud.deleteInvoice = function (inv) {
    return client.from("invoices").delete().eq("id", inv.id).then(must).then(function () {
      return client.storage.from("invoices").remove([inv.file_path]).catch(function () { /* file cleanup is best effort */ });
    });
  };

  Cloud.invoiceFileUrl = function (path) {
    return client.storage.from("invoices").createSignedUrl(path, 600).then(must).then(function (d) { return d.signedUrl; });
  };

  Cloud.downloadInvoiceFile = function (path) {
    return client.storage.from("invoices").download(path).then(must);
  };

  // ---------------------------------------------------------------- price-list requests (admin approves)

  Cloud.listCatalogItems = function () {
    return fetchAll(function () { return client.from("catalog_items").select("*").eq("active", true).order("created_at").order("id"); });
  };

  Cloud.submitCatalogRequest = function (r) {
    return client.from("catalog_requests").insert({
      supplier: r.supplier, name: r.name, model: r.model || null, unit: r.unit || null,
      price: r.price > 0 ? r.price : null, job_number: r.job_number || null, order_id: r.order_id || null
    }).then(must);
  };

  // Admins get every request; everyone else only their own (enforced by the database).
  Cloud.listCatalogRequests = function () {
    return fetchAll(function () { return client.from("catalog_requests").select("*").order("created_at", { ascending: false }).order("id"); });
  };

  Cloud.approveCatalogRequest = function (req, item) {
    var id = "KIM-" + Math.random().toString(36).slice(2, 8).toUpperCase();
    return client.from("catalog_items").insert({
      id: id, supplier: item.supplier, name: item.name, model: item.model || null, unit: item.unit || "EA",
      category: item.category || "Added Items", price: item.price > 0 ? item.price : 0
    }).then(must).then(function () {
      return client.from("catalog_requests").update({
        status: "approved", item_id: id, review_note: item.note || null, reviewed_by: user.email, reviewed_at: new Date().toISOString()
      }).eq("id", req.id).then(must);
    }).then(function () { return id; });
  };

  Cloud.updateCatalogItem = function (id, f) {
    return client.from("catalog_items").update({
      name: f.name, model: f.model || null, unit: f.unit || "EA", category: f.category || "Added Items",
      price: f.price > 0 ? f.price : 0, updated_at: new Date().toISOString()
    }).eq("id", id).then(must);
  };

  Cloud.rejectCatalogRequest = function (req, note) {
    return client.from("catalog_requests").update({
      status: "rejected", review_note: note || null, reviewed_by: user.email, reviewed_at: new Date().toISOString()
    }).eq("id", req.id).then(must);
  };

  window.Cloud = Cloud;
})();
