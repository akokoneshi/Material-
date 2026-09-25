/* Field Material Orders - single page app (no build step). */
(function () {
  "use strict";

  var S = window.MaterialSearch;
  var CAT = window.CATALOG;
  var PAGE = 50;

  // ---------------------------------------------------------------- catalog
  var ITEMS = CAT.items.map(function (r, i) {
    return {
      idx: i,
      name: r[0],
      unit: CAT.units[r[1]],
      category: CAT.categories[r[2]],
      price: r[3],
      model: r[4],
      id: r[5],
      supplier: CAT.suppliers[r[6]]
    };
  });
  var BY_KEY = {};
  var BY_SUPPLIER = {};
  ITEMS.forEach(function (it) {
    it.key = it.supplier + "|" + it.id;
    BY_KEY[it.key] = it;
    (BY_SUPPLIER[it.supplier] = BY_SUPPLIER[it.supplier] || []).push(it);
  });
  var SUPPLIERS = CAT.suppliers.slice().sort(function (a, b) {
    return BY_SUPPLIER[b].length - BY_SUPPLIER[a].length;
  });
  var indexed = false;
  function ensureIndex() {
    if (!indexed) { S.buildIndex(ITEMS); indexed = true; }
  }

  // ---------------------------------------------------------------- storage
  var store = {
    get: function (k, d) {
      try { var v = localStorage.getItem("mo." + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; }
    },
    set: function (k, v) {
      try { localStorage.setItem("mo." + k, JSON.stringify(v)); return true; } catch (e) { toast("Could not save on this device"); return false; }
    }
  };
  function getOrders() { return store.get("orders", []); }
  function saveOrders(list) { store.set("orders", list); }
  function getOrder(id) { return getOrders().filter(function (o) { return o.id === id; })[0] || null; }
  // Every change is saved on the device first (works with no signal), marked dirty,
  // and pushed to the shared database by syncNow().
  function putOrder(order) {
    order.updatedAt = new Date().toISOString();
    order.dirty = true;
    var list = getOrders(), found = false;
    for (var i = 0; i < list.length; i++) if (list[i].id === order.id) { list[i] = order; found = true; }
    if (!found) list.unshift(order);
    saveOrders(list);
    scheduleSync();
  }
  function deleteOrder(id) {
    saveOrders(getOrders().filter(function (o) { return o.id !== id; }));
    if (Cloud.enabled) {
      var del = store.get("pendingDeletes", []);
      del.push(id);
      store.set("pendingDeletes", del);
      scheduleSync();
    }
  }
  function settings() { return store.get("settings", { name: "", phone: "", supplierEmails: {} }); }
  function myName() {
    var s = settings();
    if (s.name) return s.name;
    var u = Cloud.user;
    if (u) return (u.user_metadata && (u.user_metadata.full_name || u.user_metadata.name)) || u.email.split("@")[0];
    return "";
  }
  // Job numbers recently ordered against (by anyone, when the shared database is on).
  function recentJobs() {
    var seen = {}, out = [];
    store.get("recentJobs", []).concat(getOrders()).forEach(function (j) {
      var k = String(j.jobNumber || "").trim().toUpperCase();
      if (!k || seen[k] || out.length >= 8) return;
      seen[k] = 1;
      out.push({ jobNumber: j.jobNumber, jobName: j.jobName });
    });
    return out;
  }
  // ---------------------------------------------------------------- shop stock & permissions
  var DIVISIONS = ["100", "200", "300", "400", "450", "600", "700"];
  function getStock() { return store.get("stock", []); }
  function access() { return store.get("access", { role: "user", can_edit_shop: false, blocked: false }); }
  function isAdmin() { return Cloud.enabled && !!Cloud.user && access().role === "admin"; }
  function canEditShop() { return Cloud.enabled && !!Cloud.user && (access().role === "admin" || !!access().can_edit_shop) && !access().blocked; }

  // Shop stock is tracked per MATERIAL, not per supplier item: the same 1/2" x 1" JM fiberglass
  // pipe covering bought from CT-DI, CT-SPI or CT-Homans is one material in the shop.
  // Material = category (type + brand) + unit + sizes + fitting shape (90/45/tee...),
  // or, for items without sizes, category + cleaned-up name.
  // Words that make two same-size items different products (shape, jacket, finish, grade).
  var VARIANT_WORDS = {
    "90": 1, "45": 1, "180": 1, tee: 1, cap: 1, sw: 1, scr: 1, sr: 1, lr: 1, insert: 1, mitered: 1, valve: 1, flange: 1,
    union: 1, coupling: 1, reducer: 1, block: 1, grooved: 1, plain: 1, asj: 1, ssl: 1, asph: 1, rc: 1, hot: 1, cold: 1,
    saran: 1, "540": 1, "560": 1, b11: 1, bc: 1, pittwrap: 1, ultra: 1, max: 1, fsk: 1, pvc: 1, embossed: 1, smooth: 1,
    stucco: 1, split: 1, slit: 1, unslit: 1, tube: 1, lock: 1, sheet: 1, roll: 1, clear: 1, black: 1, white: 1,
    gray: 1, fire: 1, retardant: 1, reinf: 1, mil: 1
  };
  function unitNorm(u) { u = String(u || "").toUpperCase(); return u === "FT" ? "LF" : u; }
  function materialKey(name, category, unit) {
    var clean = String(name).replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
    var d = S.itemDims(name);
    // Only merge across suppliers when the name leads with a size chain like 1/2" x 1" (pipe size x thickness).
    if (d.length >= 2 && /^\d/.test(clean) && S.itemDims(clean.replace(/[a-wyz].*$/i, "")).length >= 2) {
      var split = function (t) { return t.toLowerCase().replace(/self[\s-]*seal/g, "ssl").replace(/(\d)([a-z])/g, "$1 $2").split(/[^a-z0-9]+/); };
      var v = {};
      // Variant words anywhere in the name (including "(Ultra)"), plus numbers after the size, e.g. "4 MIL" vs "6 MIL".
      split(name).forEach(function (w) { if (VARIANT_WORDS[w]) v[w] = 1; });
      var afterSize = false;
      split(clean).forEach(function (w) {
        if (/^[a-wyz]/.test(w)) afterSize = true;
        if (afterSize && /^\d+$/.test(w)) v[w] = 1;
      });
      // Fiberglass pipe covering is ASJ unless it says otherwise.
      if (/^Pipe Covering > Fiberglass/.test(category) && !v.plain && !v.asj) v.asj = 1;
      return "M|" + (category || "") + "|" + unitNorm(unit) + "|" + d.map(function (x) { return x.v + (x.u || "in"); }).join("x") + "|" + Object.keys(v).sort().join(",");
    }
    return "N|" + (category || "") + "|" + unitNorm(unit) + "|" + clean.toLowerCase().replace(/[^a-z0-9#\/.]+/g, " ").trim() + "|" +
      (String(name).match(/\(([^)]*)\)/g) || []).join("").toLowerCase();
  }
  function itemMaterialKey(it) { if (!it._mkey) materials(); return it._mkey; }

  // One entry per material across all suppliers (used when adding shop stock).
  var MATERIALS = null, MAT_BY_KEY = {};
  function materials() {
    if (MATERIALS) return MATERIALS;
    var raw = {};
    ITEMS.forEach(function (it) {
      var k = materialKey(it.name, it.category, it.unit);
      (raw[k] = raw[k] || []).push(it);
    });
    // If one supplier has several items that land together but carry different model numbers
    // (e.g. JM 300 vs 600 board with identical names), they're different products: split by model.
    var groups = {};
    Object.keys(raw).forEach(function (k) {
      var list = raw[k], models = {}, clash = false;
      list.forEach(function (it) {
        var m = models[it.supplier] = models[it.supplier] || {};
        m[it.model] = 1;
        if (Object.keys(m).length > 1) clash = true;
      });
      list.forEach(function (it) {
        it._mkey = clash ? k + "|#" + it.model : k;
        if (clash) it._mmodel = it.model;
        (groups[it._mkey] = groups[it._mkey] || []).push(it);
      });
    });
    MATERIALS = Object.keys(groups).map(function (k) {
      var list = groups[k];
      // Friendliest description: the shortest name once box counts / ODs in brackets are removed.
      var best = list.slice().sort(function (a, b) {
        var ca = a.name.replace(/\([^)]*\)/g, "").length, cb = b.name.replace(/\([^)]*\)/g, "").length;
        return ca - cb;
      })[0];
      var m = { key: k, name: k.charAt(0) === "M" ? materialName(k, best) : best.name.replace(/\s*\((?:\d+|[\d.]+)\)\s*/g, " ").replace(/\s+/g, " ").trim(), unit: unitNorm(best.unit), category: best.category, model: best._mmodel || "", material: true, count: list.length };
      MAT_BY_KEY[k] = m;
      return m;
    });
    MATERIALS.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
    return MATERIALS;
  }

  // Supplier-neutral description, e.g. 1/2" x 1" Fiberglass Pipe Covering · JM · ASJ
  function materialName(k, it) {
    var dims = S.itemDims(it.name).map(function (d) { return S.formatSize(d.v) + (d.u === "ft" ? "'" : '"'); }).join(" x ");
    var parts = String(it.category || "").split(" > ");
    var type = parts[0] || "", mat = parts[1] || "", brand = parts[2] || "";
    if (/s$/.test(type) && !/ss$/.test(type)) type = type.replace(/ies$/, "y").replace(/([^s])s$/, "$1");
    var variants = (k.split("|")[4] || "").split(",").filter(Boolean).map(function (w) { return w.toUpperCase(); });
    var order = { "90": 0, "45": 1, "180": 2, TEE: 3 };
    variants.sort(function (a, b) { return (order[a] != null ? order[a] : 9) - (order[b] != null ? order[b] : 9) || (a < b ? -1 : 1); });
    return (dims + " " + (mat ? mat + " " : "") + type).trim() + (brand && brand !== "Fabricated" ? " · " + brand : brand ? " · Fabricated" : "") +
      (variants.length ? " · " + variants.join(" ") : "") + (it._mmodel ? " · #" + it._mmodel : "");
  }

  var stockIdx = null;
  function stockIndex() {
    if (stockIdx) return stockIdx;
    stockIdx = {};
    getStock().forEach(function (r) { (stockIdx[r.item_key] = stockIdx[r.item_key] || []).push(r); });
    return stockIdx;
  }
  function shopMatches(it) {
    if (!Cloud.enabled) return [];
    return (stockIndex()[it.material ? it.key : itemMaterialKey(it)] || [])
      .filter(function (r) { return +r.qty > 0; })
      .sort(function (a, b) { return b.qty - a.qty; });
  }
  function setStock(rows) { store.set("stock", rows); stockIdx = null; }
  function refreshStock() {
    if (!Cloud.enabled || !Cloud.user) return Promise.resolve();
    return Cloud.listStock().then(setStock, function () { /* keep cached */ });
  }

  function supplierEmails() { return Cloud.enabled ? store.get("supplierEmails", {}) : (settings().supplierEmails || {}); }

  // ---------------------------------------------------------------- sync
  var sync = { state: Cloud.enabled ? "idle" : "local", timer: null, running: false, again: false };

  function scheduleSync(delay) {
    if (!Cloud.enabled) return;
    clearTimeout(sync.timer);
    sync.timer = setTimeout(syncNow, delay == null ? 1200 : delay);
  }

  function setSyncState(s) {
    sync.state = s;
    var el = document.getElementById("sync-pill");
    if (el) el.outerHTML = syncPill();
  }

  function syncNow() {
    if (!Cloud.enabled || !Cloud.user) return Promise.resolve();
    if (sync.running) { sync.again = true; return Promise.resolve(); }
    if (!navigator.onLine) { setSyncState(pendingCount() ? "offline" : "idle"); return Promise.resolve(); }
    sync.running = true;
    setSyncState("syncing");
    var chain = Promise.resolve();

    store.get("pendingDeletes", []).forEach(function (id) {
      chain = chain.then(function () { return Cloud.deleteOrder(id); }).then(function () {
        store.set("pendingDeletes", store.get("pendingDeletes", []).filter(function (x) { return x !== id; }));
      });
    });

    getOrders().filter(function (o) { return o.dirty; }).forEach(function (snap) {
      chain = chain.then(function () {
        var o = getOrder(snap.id);
        if (!o || !o.dirty) return;
        var numbered = o.number ? Promise.resolve(o.number) : Cloud.nextOrderNumber(o.jobNumber);
        return numbered.then(function (num) {
          o = getOrder(snap.id) || o;
          o.number = num;
          return Cloud.pushOrder(o).then(function () {
            // Only clear the flag if nobody edited the order while it was uploading.
            var list = getOrders();
            list.forEach(function (x) {
              if (x.id === o.id) {
                x.number = num;
                if (x.updatedAt === o.updatedAt) delete x.dirty;
              }
            });
            saveOrders(list);
          });
        });
      });
    });

    chain = chain.then(function () { return Cloud.pullOrders(); }).then(mergeRemote)
      .then(function () {
        return Promise.all([
          Cloud.getSupplierEmails().then(function (m) { store.set("supplierEmails", m); }, function () { /* keep cached */ }),
          Cloud.getMyAccess().then(function (a) { store.set("access", a); }, function () { /* keep cached */ }),
          refreshStock()
        ]);
      })
      .then(function () {
        store.set("lastSync", new Date().toISOString());
        setSyncState(pendingCount() ? "offline" : "synced");
      }, function (err) {
        console.warn("Sync failed", err);
        setSyncState("error");
      })
      .then(function () {
        sync.running = false;
        if (sync.again) { sync.again = false; scheduleSync(300); }
        if (state.view === "home" || state.view === "history" || state.view === "shop") render();
        else if (state.view === "send") render();
        else if (state.view === "review") refreshOrderNumber();
      });
    return chain;
  }

  function mergeRemote(remote) {
    var local = getOrders();
    var byId = {};
    local.forEach(function (o) { byId[o.id] = o; });
    var deleted = store.get("pendingDeletes", []);
    var remoteIds = {};
    var merged = [];
    remote.forEach(function (r) {
      remoteIds[r.id] = 1;
      if (deleted.indexOf(r.id) >= 0) return;
      var l = byId[r.id];
      merged.push(l && l.dirty ? l : r);
    });
    // Keep local orders that haven't been uploaded yet; drop ones deleted by someone else.
    var oldest = remote.length >= 1000 ? remote[remote.length - 1].updatedAt : "";
    local.forEach(function (l) {
      if (remoteIds[l.id]) return;
      if (l.dirty || (oldest && l.updatedAt < oldest)) merged.push(l);
    });
    merged.sort(function (a, b) { return a.updatedAt < b.updatedAt ? 1 : -1; });
    saveOrders(merged);
  }

  function pendingCount() {
    return getOrders().filter(function (o) { return o.dirty; }).length + store.get("pendingDeletes", []).length;
  }

  function syncPill() {
    if (!Cloud.enabled) return '<span id="sync-pill"></span>';
    var s = sync.state, n = pendingCount();
    var map = {
      idle: ["", "Ready"],
      syncing: ["busy", "Syncing…"],
      synced: ["ok", "Synced"],
      offline: ["warn", n + " waiting · offline"],
      error: ["warn", "Sync issue · retry"]
    };
    var m = map[s] || map.idle;
    return '<button id="sync-pill" class="sync-pill ' + m[0] + '" data-action="sync-now" title="Sync with the office">' +
      '<span class="dot"></span>' + esc(m[1]) + "</button>";
  }

  function refreshOrderNumber() {
    var o = currentOrder();
    document.querySelectorAll("[data-order-number]").forEach(function (el) { el.textContent = orderNo(o); });
  }
  function orderNo(o) { return o && o.number ? o.number : "Number assigned when online"; }

  window.addEventListener("online", function () { scheduleSync(200); });
  window.addEventListener("offline", function () { setSyncState(pendingCount() ? "offline" : "idle"); });
  document.addEventListener("visibilitychange", function () { if (!document.hidden) scheduleSync(200); });
  setInterval(function () { if (!document.hidden) scheduleSync(0); }, 60000);

  // ---------------------------------------------------------------- helpers
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  var money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
  function fmtMoney(n) { return money.format(n || 0); }
  function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
  function lineTotal(l) { return round2((+l.qty || 0) * (+l.price || 0)); }
  // Lines marked source:"shop" come out of our own shop stock and never go to the supplier.
  function isShop(l) { return l.source === "shop"; }
  function supLines(o) { return o.lines.filter(function (l) { return !isShop(l); }); }
  function shopLines(o) { return o.lines.filter(isShop); }
  function orderTotal(o) { return round2(supLines(o).reduce(function (s, l) { return s + lineTotal(l); }, 0)); }
  function fmtQty(q) { return String(+(+q).toFixed(3)); }
  function priceHtml(price, unit) {
    return price > 0
      ? fmtMoney(price) + ' <span class="unit">/ ' + esc(unit) + "</span>"
      : '<span class="tbd">Price TBD</span> <span class="unit">/ ' + esc(unit) + "</span>";
  }
  function fmtDate(iso) {
    if (!iso) return "";
    var d = new Date(iso.length === 10 ? iso + "T12:00:00" : iso);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }
  function today() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  // Order numbers are per job: <job#>-001, <job#>-002, ...
  // The counter is kept separately so numbers of deleted orders are never reused.
  function newOrderNumber(jobNumber) {
    var job = String(jobNumber).trim();
    var jobKey = job.toUpperCase();
    var counters = store.get("jobSeq", {});
    var last = counters[jobKey] || 0;
    getOrders().forEach(function (o) {
      if (String(o.jobNumber).trim().toUpperCase() !== jobKey) return;
      var m = String(o.number).match(/-(\d+)$/);
      if (m && o.number.slice(0, -m[0].length).toUpperCase() === jobKey) last = Math.max(last, +m[1]);
    });
    counters[jobKey] = last + 1;
    store.set("jobSeq", counters);
    return job + "-" + String(last + 1).padStart(3, "0");
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  var toastTimer;
  function toast(msg) {
    var t = document.getElementById("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("show"); }, 1800);
  }
  var ICON_SHOP = '<svg class="ico-inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"><path d="M3 9l1.5-5h15L21 9"/><path d="M4 9v11h16V9"/><path d="M3 9h18"/><path d="M9 20v-6h6v6"/></svg>';
  var ICON = {
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
    tag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"><path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/></svg>'
  };

  // ---------------------------------------------------------------- state
  var state = {
    view: "home",        // home | supplier | job | build | review | send | history | lookup | settings
    orderId: null,
    draft: null,         // new-order wizard data {supplier, jobNumber, jobName}
    mode: "search",      // search | browse
    query: "",
    browsePath: [],
    browseAll: false,
    sizeA: "", sizeB: "", filterText: "",
    shown: PAGE,
    lookupSupplier: ""
  };
  var app = document.getElementById("app");

  function go(view, patch) {
    state.view = view;
    if (patch) for (var k in patch) state[k] = patch[k];
    state.shown = PAGE;
    render();
    window.scrollTo(0, 0);
    try { history.pushState({ v: view, o: state.orderId }, ""); } catch (e) { /* ignore */ }
  }
  window.addEventListener("popstate", function (e) {
    var s = e.state;
    if (!s) { state.view = "home"; }
    else { state.view = s.v; state.orderId = s.o; }
    if ((state.view === "build" || state.view === "review" || state.view === "send") && !getOrder(state.orderId)) state.view = "home";
    render();
  });

  function currentOrder() { return state.orderId ? getOrder(state.orderId) : null; }

  // ---------------------------------------------------------------- rendering
  function topbar(title, sub, left, right) {
    return '<header class="topbar">' + (left || "") +
      "<h1>" + esc(title) + (sub ? '<span class="sub">' + esc(sub) + "</span>" : "") + "</h1>" +
      (right || "") + "</header>";
  }
  function backBtn(action, label) {
    return '<button class="icon-btn" data-action="' + action + '" aria-label="' + esc(label || "Back") + '">' + ICON.back + "</button>";
  }

  function render() {
    var v = state.view;
    var html = VIEWS[v] ? VIEWS[v]() : VIEWS.home();
    app.innerHTML = html;
    if (AFTER[v]) AFTER[v]();
  }

  var VIEWS = {}, AFTER = {};

  // ----- home
  VIEWS.home = function () {
    var me = Cloud.user ? Cloud.user.email : "";
    var drafts = getOrders().filter(function (o) {
      return o.status === "draft" && (!Cloud.enabled || !o.createdBy || o.createdBy === me);
    });
    var h = '<header class="topbar home-top"><img class="top-logo" src="assets/kim-logo.png" alt="Kim Industries">' +
      '<h1>Material Orders<span class="sub">' + esc(myName() ? "Hi, " + myName() : "Field ordering") + "</span></h1>" +
      syncPill() + '<button class="icon-btn" data-action="settings" aria-label="Settings">' + ICON.gear + "</button></header>";
    h += '<main class="page">';
    h += '<div class="home-actions">' +
      '<button class="btn primary big block" data-action="new-order">' + ICON.plus + "New Material Order</button>" +
      '<div class="btn-row">' +
      '<button class="btn" data-action="lookup">' + ICON.tag + "Price Lookup</button>" +
      '<button class="btn" data-action="history">' + ICON.list + "Order History</button>" +
      (Cloud.enabled ? '<button class="btn" data-action="shop">' + ICON_SHOP + "Shop Stock</button>" : "") +
      (isAdmin() ? '<button class="btn" data-action="users">' + ICON.gear + "Users</button>" : "") +
      "</div></div>";
    if (access().blocked) h += '<div class="notice">Your access has been turned off. Contact the office.</div>';
    var pulls = canEditShop() ? pendingPulls() : [];
    if (pulls.length) h += '<button class="tile pull-alert" data-action="shop"><div class="t-main"><div class="t-title">' + ICON_SHOP + pulls.length + " order" + (pulls.length === 1 ? "" : "s") + ' waiting on shop material</div><div class="t-sub">Tap to pull and update stock</div></div><span class="chev">›</span></button>';
    if (drafts.length) {
      h += "<h3>" + (Cloud.enabled ? "Your drafts" : "Continue a draft") + '</h3><div class="tile-list">';
      drafts.slice(0, 5).forEach(function (o) { h += orderTile(o); });
      h += "</div>";
    }
    h += '<p class="hint" style="margin-top:28px;font-size:13px">Price list: ' + esc(ITEMS.length.toLocaleString()) +
      " items from " + SUPPLIERS.length + " suppliers · updated " + esc(fmtDate(CAT.built)) + "</p>";
    h += "</main>";
    return h;
  };

  function orderTile(o) {
    var n = o.lines.length;
    return '<button class="tile" data-action="open-order" data-id="' + esc(o.id) + '"><div class="t-main">' +
      '<div class="t-title">Job ' + esc(o.jobNumber) + (o.jobName ? " · " + esc(o.jobName) : "") + "</div>" +
      '<div class="t-sub">' + esc(o.supplier) + " · " + n + " item" + (n === 1 ? "" : "s") + " · " + fmtMoney(orderTotal(o)) + "</div>" +
      '<div class="t-sub">' + esc(orderNo(o)) + (o.createdByName ? " · " + esc(o.createdByName) : "") + " · " + esc(fmtDate(o.updatedAt)) + "</div>" +
      (o.dirty && Cloud.enabled ? '<div class="t-sub unsynced">Not yet synced to office</div>' : "") +
      '</div><span class="badge ' + (o.status === "draft" ? "draft" : "sent") + '">' + (o.status === "draft" ? "Draft" : "Sent") + "</span></button>";
  }

  // ----- step 1: supplier
  VIEWS.supplier = function () {
    var h = topbar("New Material Order", "Step 1 of 2", backBtn("home"));
    h += '<main class="page"><div class="step">Step 1 of 2</div><h2>Which supplier are you ordering from?</h2>' +
      '<p class="hint">Only this supplier\'s items and pricing will be shown.</p><div class="tile-list">';
    SUPPLIERS.forEach(function (s) {
      var sel = state.draft && state.draft.supplier === s;
      h += '<button class="tile' + (sel ? " selected" : "") + '" data-action="pick-supplier" data-supplier="' + esc(s) + '">' +
        '<div class="t-main"><div class="t-title">' + esc(s) + '</div><div class="t-sub">' +
        BY_SUPPLIER[s].length.toLocaleString() + " items</div></div><span class=\"chev\">›</span></button>";
    });
    h += "</div></main>";
    return h;
  };

  // ----- step 2: job number
  VIEWS.job = function () {
    var d = state.draft || {};
    var recent = recentJobs();
    var h = topbar("New Material Order", "Step 2 of 2 · " + d.supplier, backBtn("to-supplier"));
    h += '<main class="page"><div class="step">Step 2 of 2</div><h2>Enter the job number</h2>' +
      '<p class="hint">Ordering from <b>' + esc(d.supplier) + '</b>. <button class="link-btn" style="color:var(--focus);min-height:0;padding:0" data-action="to-supplier">Change</button></p>' +
      '<form id="job-form" novalidate>' +
      '<label class="field"><span>Job number <span class="req">*</span></span>' +
      '<input class="input huge" id="job-number" name="jobNumber" autocomplete="off" autocapitalize="characters" enterkeyhint="next" required value="' + esc(d.jobNumber || "") + '" placeholder="e.g. 24-118">' +
      '<div class="error-text" id="job-error" hidden>Job number is required.</div></label>';
    if (recent.length) {
      h += '<div class="hint" style="margin:-6px 0 0">Recent jobs</div><div class="chips">';
      recent.forEach(function (j) {
        h += '<button type="button" class="chip" data-action="pick-job" data-job="' + esc(j.jobNumber) + '" data-name="' + esc(j.jobName || "") + '">' +
          esc(j.jobNumber) + (j.jobName ? " · " + esc(j.jobName) : "") + "</button>";
      });
      h += "</div>";
    }
    h += '<label class="field"><span>Job name / location <small style="color:var(--muted);font-weight:500">(optional)</small></span>' +
      '<input class="input" id="job-name" name="jobName" autocomplete="off" value="' + esc(d.jobName || "") + '" placeholder="e.g. Mercy Hospital Boiler Rm"></label>' +
      '<button class="btn primary big block" type="submit">Start Adding Materials</button></form></main>';
    return h;
  };
  AFTER.job = function () {
    var input = document.getElementById("job-number");
    if (!input.value) input.focus();
    document.getElementById("job-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var num = input.value.trim();
      if (!num) {
        input.classList.add("invalid");
        document.getElementById("job-error").hidden = false;
        input.focus();
        return;
      }
      createOrder(state.draft.supplier, num, document.getElementById("job-name").value.trim());
    });
    input.addEventListener("input", function () {
      input.classList.remove("invalid");
      document.getElementById("job-error").hidden = true;
    });
  };

  function createOrder(supplier, jobNumber, jobName) {
    var s = settings();
    var order = {
      id: uid(),
      number: Cloud.enabled ? null : newOrderNumber(jobNumber),
      createdBy: Cloud.user ? Cloud.user.email : "",
      createdByName: myName(),
      status: "draft",
      supplier: supplier,
      jobNumber: jobNumber,
      jobName: jobName,
      requestedBy: myName(),
      phone: s.phone || "",
      needBy: "",
      delivery: "deliver",
      deliverTo: "",
      notes: "",
      showPricing: true,
      lines: [],
      createdAt: new Date().toISOString()
    };
    putOrder(order);
    scheduleSync(0);
    var recent = store.get("recentJobs", []).filter(function (j) { return j.jobNumber !== jobNumber; });
    recent.unshift({ jobNumber: jobNumber, jobName: jobName });
    store.set("recentJobs", recent.slice(0, 6));
    state.draft = null;
    go("build", { orderId: order.id, mode: "search", query: "", browsePath: [], browseAll: false, sizeA: "", sizeB: "", filterText: "" });
    toast("Order started for Job " + jobNumber);
  }

  // ----- build (search / browse) and lookup share this
  function scopeItems() {
    if (state.view === "shop-add") { var m = materials(); if (!m._indexed) { S.buildIndex(m); m._indexed = true; } return m; }
    if (state.view === "lookup") return state.lookupSupplier ? BY_SUPPLIER[state.lookupSupplier] : ITEMS;
    var o = currentOrder();
    return o ? BY_SUPPLIER[o.supplier] || [] : [];
  }

  VIEWS.build = function () {
    var o = currentOrder();
    if (!o) return VIEWS.home();
    var h = topbar("Job " + o.jobNumber, o.supplier + (o.jobName ? " · " + o.jobName : ""),
      backBtn("home", "Home"),
      '<button class="icon-btn" data-action="review" aria-label="Review order">Review</button>');
    h += '<main class="page has-cartbar">' + finderHtml() + "</main>";
    h += cartBar(o);
    return h;
  };
  AFTER.build = function () { afterFinder(); };

  VIEWS.lookup = function () {
    var adding = state.view === "shop-add";
    var h = adding ? topbar("Add Material to Shop", "Find it in the price list", backBtn("shop", "Shop stock"))
      : topbar("Price Lookup", state.lookupSupplier || "All suppliers", backBtn("home", "Home"));
    h += '<main class="page">' + (adding ? '<p class="hint" style="margin-top:0">Search or browse for the material (any supplier - it doesn\'t matter where it came from), then tap it to enter how much we have and which division it\'s in.</p>' + finderHtml() + "</main>" : "");
    if (adding) return h;
    h += '<label class="field" style="margin-bottom:6px"><span>Supplier</span><select class="input" id="lookup-supplier">' +
      '<option value="">All suppliers</option>' +
      SUPPLIERS.map(function (s) { return '<option' + (s === state.lookupSupplier ? " selected" : "") + ">" + esc(s) + "</option>"; }).join("") +
      "</select></label>" + finderHtml() + "</main>";
    return h;
  };
  VIEWS["shop-add"] = function () { return VIEWS.lookup(); };
  AFTER["shop-add"] = function () { AFTER.lookup(); };
  AFTER.lookup = function () {
    afterFinder();
    var sel = document.getElementById("lookup-supplier");
    if (sel) sel.addEventListener("change", function (e) {
      state.lookupSupplier = e.target.value;
      state.browsePath = []; state.browseAll = false; state.sizeA = state.sizeB = "";
      render();
    });
  };

  function finderHtml() {
    var h = '<div class="seg" role="tablist" style="margin-bottom:6px">' +
      '<button role="tab" data-action="mode" data-mode="search" class="' + (state.mode === "search" ? "on" : "") + '">Search</button>' +
      '<button role="tab" data-action="mode" data-mode="browse" class="' + (state.mode === "browse" ? "on" : "") + '">Browse by Category</button></div>';
    h += state.mode === "search" ? searchHtml() : browseHtml();
    return h;
  }

  var EXAMPLES = ['1/2" x 1" fiberglass pipe', '2 x 1-1/2 fg 90', "4x1 mineral wool", "#20 pvc 90", "aluminum jacketing", "armaflex 7/8", "mastic", "ss bands"];

  function searchHtml() {
    var h = '<div class="searchbar"><div class="search-wrap">' + ICON.search +
      '<input class="search-input" id="q" type="search" inputmode="search" enterkeyhint="search" autocomplete="off" autocorrect="off" spellcheck="false" ' +
      'placeholder=\'Try 1/2" x 1" fiberglass pipe\' value="' + esc(state.query) + '" aria-label="Search materials">' +
      (state.query ? '<button class="search-clear" data-action="clear-q" aria-label="Clear search">✕</button>' : "") +
      '</div><div id="search-meta"></div></div><div id="results"></div>';
    return h;
  }

  function runSearch() {
    var meta = document.getElementById("search-meta");
    var box = document.getElementById("results");
    if (!box) return;
    var q = state.query.trim();
    if (!q) {
      meta.innerHTML = "";
      box.innerHTML = '<div class="examples"><div class="hint">Type a size and material, e.g. pipe size × thickness. Tap an example:</div><div class="chips">' +
        EXAMPLES.map(function (e) { return '<button class="chip" data-action="example" data-q="' + esc(e) + '">' + esc(e) + "</button>"; }).join("") +
        '</div><div class="hint">Or switch to <b>Browse by Category</b> to pick from lists.</div></div>';
      return;
    }
    ensureIndex();
    var scope = scopeItems();
    var res = S.search(scope, q);
    var understood = "";
    if (res.parsed.dims.length || res.parsed.words.length) {
      understood = '<div class="understood">' +
        (res.parsed.dims.length ? "<span>Size: " + esc(res.parsed.dims.map(function (d) { return S.formatSize(d.v) + (d.u === "ft" ? "'" : '"'); }).join(" × ")) + "</span>" : "") +
        res.parsed.words.map(function (w) { return "<span>" + esc(w) + "</span>"; }).join("") + "</div>";
    }
    meta.innerHTML = '<div class="search-meta"><b>' + res.results.length.toLocaleString() + "</b> match" + (res.results.length === 1 ? "" : "es") + understood + "</div>";
    var h = "";
    if (res.partial) h += '<div class="notice">No exact match for every word. Showing the closest items.</div>';
    if (!res.results.length) {
      h += '<div class="empty"><p><b>Nothing found.</b></p><p>Check the size (pipe size first, then thickness), try fewer words, or browse by category.</p>' +
        (state.view === "build" ? '<button class="btn" data-action="custom-item">Add an item that isn\'t listed</button>' : "") + "</div>";
    }
    h += resultsHtml(res.results);
    box.innerHTML = h;
  }

  function resultsHtml(list) {
    var o = state.view === "build" ? currentOrder() : null;
    var inOrder = {};
    if (o) o.lines.forEach(function (l) { if (l.key) inOrder[l.key] = l; });
    var showSup = state.view === "lookup";
    var adding = state.view === "shop-add";
    var h = '<ul class="results">';
    list.slice(0, state.shown).forEach(function (it) {
      var line = inOrder[it.key];
      h += '<li class="result' + (line ? " in-order" : "") + '">' +
        '<button class="r-main" data-action="item" data-key="' + esc(it.key) + '">' +
        '<div class="r-name">' + esc(it.name) + "</div>" +
        '<div class="r-sub">' + (showSup ? '<span class="sup-tag">' + esc(it.supplier) + "</span> · " : "") + esc(it.category) + (it.model ? " · #" + esc(it.model) : "") + "</div>" +
        (it.material ? '<div class="r-sub">Sold by the ' + esc(it.unit) + (it.count > 1 ? " · " + it.count + " price-list items" : "") + "</div>" : '<div class="r-price">' + priceHtml(it.price, it.unit) + "</div>") + shopBadge(it) + "</button>";
      if (adding) {
        h += '<button class="r-add" data-action="item" data-key="' + esc(it.key) + '" aria-label="Add to shop stock"><span class="plus">+</span><small>Stock</small></button>';
      } else if (o) {
        h += '<button class="r-add" data-action="item" data-key="' + esc(it.key) + '" aria-label="' + (line ? "Change quantity" : "Add to order") + '">' +
          (line ? "<span>" + esc(fmtQty(line.qty)) + "</span><small>" + esc(it.unit) + "</small><small>Edit</small>" : '<span class="plus">+</span><small>Add</small>') + "</button>";
      }
      h += "</li>";
    });
    h += "</ul>";
    if (list.length > state.shown) {
      h += '<button class="btn block more" data-action="more">Show more (' + (list.length - state.shown).toLocaleString() + " more)</button>";
    }
    return h;
  }

  function shopBadge(it) {
    var m = shopMatches(it);
    if (!m.length) return "";
    var byUnit = {};
    m.forEach(function (r) { var u = r.unit || it.unit; byUnit[u] = (byUnit[u] || 0) + (+r.qty); });
    return '<div class="r-shop">' + ICON_SHOP + "In shop: " + Object.keys(byUnit).map(function (u) { return fmtQty(byUnit[u]) + " " + esc(u); }).join(", ") +
      " · Div " + m.map(function (r) { return esc(r.division); }).join(", ") + "</div>";
  }

  // ----- browse
  function categoryTree(items) {
    var root = { name: "", path: "", count: 0, children: {} };
    items.forEach(function (it) {
      var parts = it.category.split(" > "), node = root;
      root.count++;
      for (var i = 0; i < parts.length; i++) {
        var p = parts.slice(0, i + 1).join(" > ");
        node = node.children[parts[i]] = node.children[parts[i]] || { name: parts[i], path: p, count: 0, children: {} };
        node.count++;
      }
    });
    return root;
  }

  function browseNode() {
    var tree = categoryTree(scopeItems()), node = tree;
    for (var i = 0; i < state.browsePath.length; i++) {
      var next = node.children[state.browsePath[i]];
      if (!next) { state.browsePath = state.browsePath.slice(0, i); break; }
      node = next;
    }
    return node;
  }

  function isPipeish(path) { return /^(Pipe Covering|Fitting Covers|Hangers|Blocks|Saddles|Valve)/.test(path); }

  function browseHtml() {
    var node = browseNode();
    var h = '<nav class="crumbs" aria-label="Category path"><button data-action="crumb" data-depth="0">All categories</button>';
    state.browsePath.forEach(function (p, i) {
      h += '<span class="sep">›</span><button data-action="crumb" data-depth="' + (i + 1) + '">' + esc(p) + "</button>";
    });
    h += "</nav>";
    var kids = Object.keys(node.children).map(function (k) { return node.children[k]; });
    kids.sort(function (a, b) { return b.count - a.count; });
    if (kids.length && !state.browseAll) {
      h += '<div class="tile-list">';
      if (node.path) {
        h += '<button class="tile" data-action="browse-all"><div class="t-main"><div class="t-title">All ' + esc(node.name) + '</div><div class="t-sub">' +
          node.count.toLocaleString() + " items</div></div><span class=\"chev\">›</span></button>";
      }
      kids.forEach(function (k) {
        h += '<button class="tile" data-action="browse-into" data-name="' + esc(k.name) + '"><div class="t-main"><div class="t-title">' + esc(k.name) +
          '</div><div class="t-sub">' + k.count.toLocaleString() + " items" + (Object.keys(k.children).length ? " · " + Object.keys(k.children).length + " groups" : "") +
          "</div></div><span class=\"chev\">›</span></button>";
      });
      h += "</div>";
      return h;
    }
    // item list for this category, with size filters
    var items = categoryItems(node.path);
    var a = {}, b = {};
    items.forEach(function (it) {
      var d = dimsOf(it);
      if (d[0]) a[d[0].v] = 1;
      if (d[1] && (!state.sizeA || String(d[0].v) === state.sizeA)) b[d[1].v] = 1;
    });
    var pipe = isPipeish(node.path);
    var aKeys = Object.keys(a).map(Number).sort(function (x, y) { return x - y; });
    var bKeys = Object.keys(b).map(Number).sort(function (x, y) { return x - y; });
    h += '<div class="filters">';
    if (aKeys.length > 1) h += selectHtml("sizeA", pipe ? "Pipe size" : "Size", aKeys, state.sizeA);
    if (bKeys.length > 1) h += selectHtml("sizeB", pipe ? "Thickness" : "Size 2", bKeys, state.sizeB);
    h += '<label class="field full"><span>Filter this list</span><input class="input" id="filter-text" type="search" autocomplete="off" placeholder="e.g. ASJ, knauf, 90" value="' + esc(state.filterText) + '"></label>';
    h += '</div><div id="browse-results"></div>';
    return h;
  }

  function selectHtml(id, label, keys, val) {
    return '<label class="field"><span>' + label + '</span><select class="input" id="' + id + '"><option value="">Any</option>' +
      keys.map(function (k) { return '<option value="' + k + '"' + (String(k) === val ? " selected" : "") + ">" + esc(S.formatSize(k)) + '"</option>'; }).join("") +
      "</select></label>";
  }

  function dimsOf(it) { if (!it._dims) it._dims = S.itemDims(it.name); return it._dims; }

  function categoryItems(path) {
    return scopeItems().filter(function (it) {
      return !path || it.category === path || it.category.lastIndexOf(path + " > ", 0) === 0;
    });
  }

  function renderBrowseResults() {
    var box = document.getElementById("browse-results");
    if (!box) return;
    var node = browseNode();
    var items = categoryItems(node.path).filter(function (it) {
      var d = dimsOf(it);
      if (state.sizeA && !(d[0] && String(d[0].v) === state.sizeA)) return false;
      if (state.sizeB && !(d[1] && String(d[1].v) === state.sizeB)) return false;
      return true;
    });
    if (state.filterText.trim()) {
      ensureIndex();
      items = S.search(items, state.filterText).results;
    } else {
      items.forEach(function (it) { if (!it._sortKey) it._sortKey = dimsOf(it).map(function (d) { return d.v; }); });
      items.sort(S.compareSize);
    }
    box.innerHTML = '<div class="search-meta" style="margin-bottom:8px"><b>' + items.length.toLocaleString() + "</b> items</div>" +
      (items.length ? resultsHtml(items) : '<div class="empty">No items match these filters.</div>');
  }

  var searchTimer;
  function afterFinder() {
    if (state.mode === "search") {
      var q = document.getElementById("q");
      q.addEventListener("input", function () {
        state.query = q.value;
        state.shown = PAGE;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(function () {
          runSearch();
          var wrap = q.parentNode, clear = wrap.querySelector(".search-clear");
          if (q.value && !clear) wrap.insertAdjacentHTML("beforeend", '<button class="search-clear" data-action="clear-q" aria-label="Clear search">✕</button>');
          if (!q.value && clear) clear.remove();
        }, 140);
      });
      q.addEventListener("keydown", function (e) { if (e.key === "Enter") q.blur(); });
      if (!state.query && matchMedia("(min-width: 700px)").matches) q.focus();
      runSearch();
    } else {
      ["sizeA", "sizeB"].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.addEventListener("change", function () {
          state[id] = el.value;
          if (id === "sizeA") state.sizeB = "";
          state.shown = PAGE;
          render();
        });
      });
      var ft = document.getElementById("filter-text");
      if (ft) ft.addEventListener("input", function () {
        state.filterText = ft.value;
        state.shown = PAGE;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(renderBrowseResults, 140);
      });
      renderBrowseResults();
    }
  }

  function refreshList() {
    if (state.mode === "search") runSearch(); else renderBrowseResults();
    var bar = document.getElementById("cartbar");
    var o = currentOrder();
    if (bar && o) bar.outerHTML = cartBar(o);
  }

  function cartBar(o) {
    var n = o.lines.length;
    return '<div class="cartbar" id="cartbar"><div class="cartbar-inner"><div class="c-info">' +
      '<div class="c-count">' + n + " item" + (n === 1 ? "" : "s") + " in order</div>" +
      '<div class="c-total">' + (o.lines.length ? "Est. " + fmtMoney(orderTotal(o)) : "Search or browse to add materials") + "</div></div>" +
      '<button class="btn primary" data-action="review"' + (n ? "" : " disabled") + ">Review Order ›</button></div></div>";
  }

  // ----- quantity sheet
  function openSheet(html, after) {
    var root = document.getElementById("sheet-root");
    root.innerHTML = '<div class="sheet-backdrop" data-action="close-sheet-bg"><div class="sheet" role="dialog" aria-modal="true">' + html + "</div></div>";
    document.body.style.overflow = "hidden";
    if (after) after(root.querySelector(".sheet"));
  }
  function closeSheet() {
    document.getElementById("sheet-root").innerHTML = "";
    document.body.style.overflow = "";
  }

  function openItemSheet(key) {
    var it = state.view === "shop-add" ? MAT_BY_KEY[key] : BY_KEY[key];
    if (!it) return;
    if (state.view === "lookup") {
      openSheet('<h2>' + esc(it.name) + "</h2><dl class=\"kv\"><dt>Supplier</dt><dd>" + esc(it.supplier) + "</dd><dt>Price</dt><dd>" +
        (it.price > 0 ? fmtMoney(it.price) : "TBD") + " / " + esc(it.unit) + "</dd><dt>Category</dt><dd>" + esc(it.category) + "</dd>" +
        (it.model ? "<dt>Model #</dt><dd>" + esc(it.model) + "</dd>" : "") + "<dt>Item ID</dt><dd>" + esc(it.id) + "</dd></dl>" +
        '<div class="btn-row" style="margin-top:18px"><button class="btn" data-action="close-sheet">Close</button>' +
        '<button class="btn primary" data-action="order-from-lookup" data-supplier="' + esc(it.supplier) + '">Start order with ' + esc(it.supplier) + "</button></div>");
      return;
    }
    if (state.view === "shop-add") { openStockSheet(itemRef(it)); return; }
    var o = currentOrder();
    var existing = o.lines.filter(function (l) { return l.key === key; })[0];
    // Required check: if we have this material in a shop, the crew must choose shop or supplier first.
    var matches = shopMatches(it);
    if (matches.length && !existing) { openShopCheckSheet(it, matches); return; }
    openSupplierQty(it, existing);
  }

  function itemRef(it) { return { key: it.key, name: it.name, unit: it.unit, category: it.category, model: it.model }; }

  function openShopCheckSheet(it, matches) {
    var o = currentOrder();
    var claimed = {};
    shopLines(o).forEach(function (l) { claimed[l.stockKey + "|" + l.division] = (claimed[l.stockKey + "|" + l.division] || 0) + (+l.qty || 0); });
    var h = '<div class="shop-alert">' + ICON_SHOP + "<div><b>We have this in the shop</b><div>Use shop material first if it covers what you need.</div></div></div>" +
      "<h2>" + esc(it.name) + "</h2>" + '<div class="tile-list">';
    matches.forEach(function (r) {
      var left = +r.qty - (claimed[r.item_key + "|" + r.division] || 0);
      h += '<button class="tile shop-tile" data-shop-pick="' + esc(r.item_key + "|" + r.division) + '"' + (left > 0 ? "" : " disabled") + '>' +
        '<span class="div-badge">Div ' + esc(r.division) + '</span><div class="t-main"><div class="t-title">' + esc(fmtQty(left)) + " " + esc(r.unit || it.unit) + " available</div>" +
        '<div class="t-sub">' + esc(r.item_name) + "</div>" +
        (left > 0 ? '<div class="t-sub">Tap to use from the shop</div>' : '<div class="t-sub">Already used on this order</div>') + '</div><span class="chev">›</span></button>';
    });
    h += '</div><button class="btn block" style="margin-top:14px" id="order-anyway">Not enough / wrong item - order from ' + esc(o.supplier) + "</button>" +
      '<button class="btn block" style="margin-top:8px" data-action="close-sheet">Cancel</button>';
    openSheet(h, function (sheet) {
      sheet.querySelectorAll("[data-shop-pick]").forEach(function (b) {
        b.addEventListener("click", function () {
          var k = b.getAttribute("data-shop-pick");
          var r = matches.filter(function (m) { return m.item_key + "|" + m.division === k; })[0];
          closeSheet();
          openShopQty(it, r, +r.qty - (claimed[k] || 0));
        });
      });
      sheet.querySelector("#order-anyway").addEventListener("click", function () {
        closeSheet();
        openSupplierQty(it, null, true);
      });
    });
  }

  function openShopQty(it, r, available) {
    var key = "shop:" + r.item_key + ":" + r.division;
    openQtySheet({
      title: r.item_name,
      sub: "From our shop · Div " + r.division,
      note: fmtQty(available) + " " + (r.unit || it.unit) + " available in Div " + r.division,
      price: 0, unit: r.unit || it.unit, qty: "", existing: false, saveLabel: "Use from Shop",
      validate: function (q) { return q > available + 1e-9 ? "Only " + fmtQty(available) + " available in Div " + r.division : ""; },
      onSave: function (q) {
        var ord = currentOrder();
        var l = ord.lines.filter(function (x) { return x.key === key && !x.pulled; })[0];
        if (l) l.qty = +(l.qty + q).toFixed(3);
        else ord.lines.push({
          key: key, source: "shop", division: r.division, stockKey: r.item_key, name: r.item_name, unit: r.unit || it.unit,
          category: r.category, model: r.model, price: 0, qty: q, pulled: false
        });
        putOrder(ord);
        toast("From shop: " + fmtQty(q) + " " + (r.unit || it.unit) + " (Div " + r.division + ")");
      }
    });
  }

  function openSupplierQty(it, existing, checkedShop) {
    var key = it.key;
    var qty = existing ? existing.qty : "";
    openQtySheet({
      title: it.name,
      sub: it.category + (it.model ? " · #" + it.model : ""),
      price: it.price, unit: it.unit, qty: qty, existing: !!existing,
      onSave: function (q) {
        var ord = currentOrder();
        var l = ord.lines.filter(function (x) { return x.key === key; })[0];
        if (l) l.qty = q;
        else ord.lines.push({ key: key, id: it.id, name: it.name, unit: it.unit, price: it.price, model: it.model, category: it.category, qty: q, shopChecked: !!checkedShop });
        putOrder(ord);
        toast((l ? "Updated: " : "Added: ") + fmtQty(q) + " " + it.unit);
      },
      onRemove: function () { removeLine(key); }
    });
  }

  function openQtySheet(opt) {
    var quick = /^(LF|FT|SF|LY)$/.test(opt.unit) ? [10, 25, 50, 100] : [1, 5, 10, 25];
    var h = "<h2>" + esc(opt.title) + "</h2>" +
      (opt.sub ? '<div class="hint" style="margin-top:-6px">' + esc(opt.sub) + "</div>" : "") +
      '<div style="font-weight:700">' + (opt.note ? esc(opt.note) : opt.price > 0 ? fmtMoney(opt.price) + " / " + esc(opt.unit) : "Price TBD / " + esc(opt.unit)) + "</div>" +
      '<div class="big-stepper"><button type="button" data-step="-1" aria-label="Decrease">−</button>' +
      '<input id="qty" type="number" inputmode="decimal" min="0" step="any" value="' + esc(opt.qty) + '" placeholder="0" aria-label="Quantity">' +
      '<button type="button" data-step="1" aria-label="Increase">+</button></div>' +
      '<div class="unit-label">' + esc(opt.unit) + '</div>' +
      '<div class="chips quick">' + quick.map(function (n) { return '<button type="button" class="chip" data-add="' + n + '">+' + n + "</button>"; }).join("") + "</div>" +
      '<div class="line-total" id="line-total"></div>' +
      '<div class="btn-row">' + (opt.existing ? '<button class="btn danger" id="qty-remove">Remove</button>' : '<button class="btn" data-action="close-sheet">Cancel</button>') +
      '<button class="btn primary" id="qty-save">' + (opt.saveLabel || (opt.existing ? "Update" : "Add to Order")) + "</button></div>";
    openSheet(h, function (sheet) {
      var input = sheet.querySelector("#qty");
      function upd() {
        var q = parseFloat(input.value) || 0;
        sheet.querySelector("#line-total").innerHTML = q > 0 && opt.price > 0 ? "Line total: <b>" + fmtMoney(round2(q * opt.price)) + "</b>" : "&nbsp;";
      }
      sheet.querySelectorAll("[data-step]").forEach(function (b) {
        b.addEventListener("click", function () {
          var q = (parseFloat(input.value) || 0) + (+b.getAttribute("data-step"));
          input.value = Math.max(0, +q.toFixed(3));
          upd();
        });
      });
      sheet.querySelectorAll("[data-add]").forEach(function (b) {
        b.addEventListener("click", function () {
          input.value = +((parseFloat(input.value) || 0) + (+b.getAttribute("data-add"))).toFixed(3);
          upd();
        });
      });
      input.addEventListener("input", upd);
      input.addEventListener("keydown", function (e) { if (e.key === "Enter") sheet.querySelector("#qty-save").click(); });
      sheet.querySelector("#qty-save").addEventListener("click", function () {
        var q = parseFloat(input.value);
        if (!(q > 0)) { input.focus(); toast("Enter a quantity"); return; }
        var bad = opt.validate && opt.validate(+q.toFixed(3));
        if (bad) { input.focus(); toast(bad); return; }
        opt.onSave(+q.toFixed(3));
        closeSheet();
        afterChange();
      });
      var rm = sheet.querySelector("#qty-remove");
      if (rm) rm.addEventListener("click", function () { opt.onRemove(); closeSheet(); afterChange(); });
      upd();
      setTimeout(function () { input.focus(); input.select(); }, 60);
    });
  }

  function afterChange() {
    if (state.view === "build") refreshList(); else render();
  }

  function removeLine(key) {
    var o = currentOrder();
    o.lines = o.lines.filter(function (l) { return l.key !== key; });
    putOrder(o);
    toast("Removed from order");
  }

  function openCustomSheet() {
    var h = "<h2>Add an item that isn't listed</h2><form id=\"custom-form\">" +
      '<label class="field"><span>Description <span class="req">*</span></span><input class="input" id="c-name" required placeholder=\'e.g. 3" x 1" fiberglass pipe, special order\'></label>' +
      '<div class="filters"><label class="field"><span>Quantity <span class="req">*</span></span><input class="input" id="c-qty" type="number" inputmode="decimal" min="0" step="any"></label>' +
      '<label class="field"><span>Unit</span><select class="input" id="c-unit">' + ["EA", "LF", "FT", "SF", "RL", "BX", "PK", "GAL", "SET"].map(function (u) { return "<option>" + u + "</option>"; }).join("") + "</select></label>" +
      '<label class="field full"><span>Price per unit (if known)</span><input class="input" id="c-price" type="number" inputmode="decimal" min="0" step="any" placeholder="Leave blank if unknown"></label></div>' +
      '<div class="btn-row"><button type="button" class="btn" data-action="close-sheet">Cancel</button><button class="btn primary" type="submit">Add to Order</button></div></form>';
    openSheet(h, function (sheet) {
      sheet.querySelector("#c-name").focus();
      sheet.querySelector("#custom-form").addEventListener("submit", function (e) {
        e.preventDefault();
        var name = sheet.querySelector("#c-name").value.trim();
        var qty = parseFloat(sheet.querySelector("#c-qty").value);
        if (!name) { sheet.querySelector("#c-name").focus(); return; }
        if (!(qty > 0)) { sheet.querySelector("#c-qty").focus(); toast("Enter a quantity"); return; }
        var o = currentOrder();
        o.lines.push({
          key: "custom:" + uid(), custom: true, id: "", name: name, unit: sheet.querySelector("#c-unit").value,
          price: parseFloat(sheet.querySelector("#c-price").value) || 0, model: "", category: "Not in price list", qty: +qty.toFixed(3)
        });
        putOrder(o);
        closeSheet();
        toast("Added: " + name);
        afterChange();
      });
    });
  }

  // ----- review
  VIEWS.review = function () {
    var o = currentOrder();
    if (!o) return VIEWS.home();
    var h = topbar("Review Order", "Job " + o.jobNumber + " · " + o.supplier, backBtn("to-build", "Back to materials"));
    h += '<main class="page">';
    h += '<div class="card"><dl class="kv"><dt>Order #</dt><dd data-order-number>' + esc(orderNo(o)) + "</dd><dt>Supplier</dt><dd>" + esc(o.supplier) +
      "</dd><dt>Job #</dt><dd>" + esc(o.jobNumber) + "</dd>" + (o.jobName ? "<dt>Job name</dt><dd>" + esc(o.jobName) + "</dd>" : "") + "</dl></div>";

    var sup = supLines(o), shp = shopLines(o);
    h += '<h3>Order from ' + esc(o.supplier) + " (" + sup.length + ')</h3><div class="card">';
    if (!sup.length) h += '<div class="empty">' + (shp.length ? "Nothing to order from the supplier - everything is coming from the shop." : "No materials yet.") + "</div>";
    sup.forEach(function (l) { h += lineHtml(l); });
    if (sup.length) {
      h += '<div class="totals"><span>Estimated total</span><span id="order-total">' + fmtMoney(orderTotal(o)) + "</span></div>";
      if (sup.some(function (l) { return !(l.price > 0); })) h += '<div class="notice">Some items have no listed price and are not included in the total.</div>';
    }
    h += '<div class="btn-row" style="margin-top:10px"><button class="btn" data-action="to-build">' + ICON.plus + 'Add more materials</button>' +
      '<button class="btn" data-action="custom-item">Add unlisted item</button></div></div>';
    if (shp.length) {
      h += '<h3>' + ICON_SHOP + 'Pull from our shop (' + shp.length + ')</h3><div class="card shop-card">';
      shp.forEach(function (l) { h += lineHtml(l); });
      h += '<div class="hint" style="margin:8px 0 0">These are not sent to the supplier.</div></div>';
    }

    h += '<h3>Delivery & details</h3><div class="card"><form id="details-form">' +
      '<label class="field"><span>Requested by</span><input class="input" name="requestedBy" autocomplete="name" value="' + esc(o.requestedBy) + '" placeholder="Your name"></label>' +
      '<label class="field"><span>Phone</span><input class="input" name="phone" type="tel" autocomplete="tel" value="' + esc(o.phone) + '"></label>' +
      '<label class="field"><span>Needed by</span><input class="input" name="needBy" type="date" min="' + today() + '" value="' + esc(o.needBy) + '"></label>' +
      '<div class="field"><span style="display:block;font-weight:600;margin-bottom:6px">Delivery</span><div class="seg">' +
      '<button type="button" data-action="delivery" data-val="deliver" class="' + (o.delivery === "deliver" ? "on" : "") + '">Deliver to job</button>' +
      '<button type="button" data-action="delivery" data-val="pickup" class="' + (o.delivery === "pickup" ? "on" : "") + '">Will call / pickup</button></div></div>' +
      (o.delivery === "deliver" ? '<label class="field"><span>Deliver to</span><textarea class="input" name="deliverTo" placeholder="Jobsite address, gate, contact">' + esc(o.deliverTo) + "</textarea></label>" : "") +
      '<label class="field"><span>Notes for supplier</span><textarea class="input" name="notes" placeholder="Anything the supplier should know">' + esc(o.notes) + "</textarea></label>" +
      "</form></div>";

    h += '<h3>Pricing</h3><div class="card"><label class="toggle"><input type="checkbox" id="show-pricing"' + (o.showPricing ? " checked" : "") + ">" +
      "Include listed pricing on the order</label><div class=\"hint\" style=\"margin:0\">Turn off to send quantities only.</div></div>";

    h += '<div class="btn-row" style="margin:20px 0 8px"><button class="btn primary big" data-action="to-send"' + (o.lines.length ? "" : " disabled") + ">Create Order ›</button></div>" +
      '<div class="btn-row" style="margin-bottom:40px"><button class="btn" data-action="save-draft">Save as draft</button>' +
      '<button class="btn danger" data-action="delete-order">Delete order</button></div>';
    h += "</main>";
    return h;
  };
  AFTER.review = function () {
    var form = document.getElementById("details-form");
    form.addEventListener("input", function (e) {
      var o = currentOrder();
      if (!e.target.name) return;
      o[e.target.name] = e.target.value;
      putOrder(o);
      if (e.target.name === "requestedBy" || e.target.name === "phone") {
        var s = settings();
        s[e.target.name === "requestedBy" ? "name" : "phone"] = e.target.value;
        store.set("settings", s);
      }
    });
    document.getElementById("show-pricing").addEventListener("change", function (e) {
      var o = currentOrder();
      o.showPricing = e.target.checked;
      putOrder(o);
    });
    app.querySelectorAll("[data-line-qty]").forEach(function (inp) {
      inp.addEventListener("change", function () {
        var q = parseFloat(inp.value);
        var key = inp.getAttribute("data-line-qty");
        if (!(q > 0)) {
          if (confirm("Remove this item from the order?")) { removeLine(key); }
          render();
          return;
        }
        setLineQty(key, q);
        render();
      });
    });
  };

  function lineHtml(l) {
    var shop = isShop(l);
    return '<div class="line' + (shop ? " shop-line" : "") + '"><div><div class="l-name">' + esc(l.name) + "</div>" +
      '<div class="l-sub">' + (shop
        ? '<span class="div-tag">Div ' + esc(l.division) + "</span> " + (l.pulled ? "Pulled ✓" : "To be pulled from shop")
        : (l.custom ? "Not in price list" : esc(l.category) + (l.model ? " · #" + esc(l.model) : "")) + " · " +
          (l.price > 0 ? fmtMoney(l.price) : "Price TBD") + " / " + esc(l.unit)) + "</div></div>" +
      '<div class="l-ext">' + (shop ? "Shop" : l.price > 0 ? fmtMoney(lineTotal(l)) : "—") + "</div>" +
      (shop && l.pulled ? '<div class="l-controls"><b>' + esc(fmtQty(l.qty)) + " " + esc(l.unit) + "</b></div>" :
      '<div class="l-controls"><div class="stepper"><button data-action="line-step" data-key="' + esc(l.key) + '" data-step="-1" aria-label="Decrease">−</button>' +
      '<input type="number" inputmode="decimal" min="0" step="any" value="' + esc(fmtQty(l.qty)) + '" data-line-qty="' + esc(l.key) + '" aria-label="Quantity">' +
      '<span class="u">' + esc(l.unit) + '</span><button data-action="line-step" data-key="' + esc(l.key) + '" data-step="1" aria-label="Increase">+</button></div>' +
      '<button class="link-btn" data-action="line-remove" data-key="' + esc(l.key) + '">Remove</button></div>') + "</div>";
  }

  function setLineQty(key, q) {
    var o = currentOrder();
    o.lines.forEach(function (l) { if (l.key === key) l.qty = +(+q).toFixed(3); });
    putOrder(o);
  }

  // ----- send / finished order
  VIEWS.send = function () {
    var o = currentOrder();
    if (!o) return VIEWS.home();
    var editable = o.status === "draft";
    var ready = !!o.number || !supLines(o).length;
    var canSharePdf = !!(navigator.canShare && window.File && navigator.canShare({ files: [new File([""], "x.pdf", { type: "application/pdf" })] }));
    var h = topbar(o.number ? "Order " + o.number : "New order (# pending)", "Job " + o.jobNumber + " · " + o.supplier, backBtn(editable ? "to-review" : "history", "Back"), syncPill());
    h += '<main class="page">';
    h += '<div class="card done-card"><div class="done-icon">' + (o.status === "sent" ? "✓" : "➜") + '</div><h2 style="margin-top:0">' +
      (o.status === "sent" ? "Order sent" : "Order ready to send") + "</h2>" +
      '<div class="hint">' + supLines(o).length + " from " + esc(o.supplier) + (shopLines(o).length ? " · " + shopLines(o).length + " from our shop" : "") +
        (supLines(o).length ? " · " + (o.showPricing ? "Est. " + fmtMoney(orderTotal(o)) : "pricing hidden") : "") + "</div>" +
      '<label class="toggle" style="justify-content:center"><input type="checkbox" id="send-pricing"' + (o.showPricing ? " checked" : "") + ">Include listed pricing</label></div>";
    var hasSup = supLines(o).length > 0, shp = shopLines(o);
    if (shp.length) {
      var waiting = shp.filter(function (l) { return !l.pulled; });
      h += '<h3>' + ICON_SHOP + 'Pull from our shop</h3><div class="card shop-card">' + shp.map(function (l) {
        return lineSummary(l).replace("</div>", l.pulled ? ' <span class="badge sent">Pulled</span></div>' : "</div>");
      }).join("");
      if (waiting.length && canEditShop() && o.status === "sent") h += '<button class="btn primary block" style="margin-top:10px" data-action="open-pull" data-id="' + esc(o.id) + '">Mark pulled &amp; update shop stock</button>';
      else if (waiting.length && canEditShop()) h += '<div class="hint" style="margin:8px 0 0">After the order is sent you can mark these pulled here.</div>';
      else if (waiting.length) h += '<div class="hint" style="margin:8px 0 0">Shop staff will see this on the Shop Stock screen and pull it.</div>';
      h += "</div>";
    }
    if (!hasSup) h += '<div class="notice">Nothing to order from ' + esc(o.supplier) + ' - everything on this order is coming from the shop.</div>';
    if (!ready) {
      h += '<div class="notice">This order gets its number (' + esc(o.jobNumber) + "-00#) as soon as the phone is back online. Sending is available after that.</div>";
    }
    if (hasSup) h += '<h3>Send to ' + esc(o.supplier) + '</h3><div class="tile-list' + (ready ? "" : " disabled") + '">' +
      (canSharePdf ? sendTile("share-pdf", "Send PDF (email / text)", "Kim Industries PDF, attached with any app") : "") +
      sendTile("email", "Email to supplier", emailFor(o.supplier) ? "To " + emailFor(o.supplier) + " · order in the email body" : "Opens your email app · order in the email body") +
      sendTile("pdf", "Download PDF", "Kim Industries purchase order") +
      sendTile("print", "Print", "Printable purchase order") +
      (navigator.share ? sendTile("share", "Share as text", "Send with any app on this phone") : "") +
      sendTile("copy", "Copy order text", "Paste into a text or email") +
      sendTile("csv", "Download spreadsheet (CSV)", "Opens in Excel") +
      "</div>";
    if (hasSup) h += '<h3>Preview</h3><div class="card preview-card"><div class="po-preview">' + printHtml(o) + "</div></div>";
    h += '<div class="btn-row" style="margin:16px 0 40px">' +
      (o.status === "sent" ? '<button class="btn" data-action="reopen">Edit order</button>' : '<button class="btn brand" data-action="mark-sent"' + (ready ? "" : " disabled") + ">" + (hasSup ? "Mark as sent" : "Submit shop pull") + "</button>") +
      '<button class="btn" data-action="duplicate">Reorder (copy)</button><button class="btn" data-action="home">Done</button></div>';
    h += "</main>";
    return h;
  };
  AFTER.send = function () {
    document.getElementById("send-pricing").addEventListener("change", function (e) {
      var o = currentOrder();
      o.showPricing = e.target.checked;
      putOrder(o);
      render();
    });
  };
  function sendTile(kind, title, sub) {
    return '<button class="tile" data-action="send" data-kind="' + kind + '"><div class="t-main"><div class="t-title">' + esc(title) +
      '</div><div class="t-sub">' + esc(sub) + "</div></div><span class=\"chev\">›</span></button>";
  }
  function emailFor(supplier) { return supplierEmails()[supplier] || ""; }

  function orderText(o) {
    var p = o.showPricing;
    var t = "KIM INDUSTRIES - MATERIAL ORDER " + o.number + "\n" +
      "Supplier: " + o.supplier + "\n" +
      "Job #: " + o.jobNumber + (o.jobName ? " - " + o.jobName : "") + "\n" +
      "Date: " + fmtDate(o.createdAt) + "\n" +
      (o.requestedBy ? "Requested by: " + o.requestedBy + (o.phone ? " (" + o.phone + ")" : "") + "\n" : "") +
      (o.needBy ? "Needed by: " + fmtDate(o.needBy) + "\n" : "") +
      (o.delivery === "pickup" ? "Delivery: Will call / pickup\n" : "Delivery: Deliver to job" + (o.deliverTo ? " - " + o.deliverTo.replace(/\n/g, ", ") : "") + "\n") +
      "\n";
    supLines(o).forEach(function (l, i) {
      t += (i + 1) + ". " + fmtQty(l.qty) + " " + l.unit + " - " + l.name + (l.model ? " [#" + l.model + "]" : "");
      if (p) t += l.price > 0 ? " @ " + fmtMoney(l.price) + " = " + fmtMoney(lineTotal(l)) : " @ price TBD";
      t += "\n";
    });
    if (p) t += "\nESTIMATED TOTAL: " + fmtMoney(orderTotal(o)) + "\n";
    if (o.notes) t += "\nNotes: " + o.notes + "\n";
    return t;
  }

  function csvCell(v) {
    v = String(v == null ? "" : v);
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }
  function orderCsv(o) {
    var p = o.showPricing;
    var rows = [["Order #", o.number], ["Supplier", o.supplier], ["Job #", o.jobNumber], ["Job name", o.jobName], ["Date", fmtDate(o.createdAt)],
      ["Requested by", o.requestedBy], ["Needed by", o.needBy ? fmtDate(o.needBy) : ""],
      ["Delivery", o.delivery === "pickup" ? "Will call / pickup" : "Deliver to job: " + (o.deliverTo || "")], ["Notes", o.notes], []];
    var head = ["Line", "Qty", "Unit", "Description", "Model #", "Item ID", "Category"];
    if (p) head.push("Unit Price", "Ext Price");
    rows.push(head);
    supLines(o).forEach(function (l, i) {
      var r = [i + 1, fmtQty(l.qty), l.unit, l.name, l.model, l.id, l.category];
      if (p) r.push(l.price > 0 ? l.price.toFixed(2) : "", l.price > 0 ? lineTotal(l).toFixed(2) : "");
      rows.push(r);
    });
    if (p) rows.push([], ["", "", "", "", "", "", "", "Total", orderTotal(o).toFixed(2)]);
    return rows.map(function (r) { return r.map(csvCell).join(","); }).join("\r\n");
  }

  function deliveryText(o) {
    return o.delivery === "pickup" ? "Will call / pickup" : "Deliver to job" + (o.deliverTo ? " - " + o.deliverTo.replace(/\n/g, ", ") : "");
  }

  function printHtml(o) {
    var p = o.showPricing;
    var h = '<div class="po"><div class="po-brand"><img src="assets/kim-logo.png" alt="Kim Industries">' +
      '<div class="po-title"><h1>Material Order</h1><div>Order # <b>' + esc(orderNo(o)) + "</b></div><div>Date: " + esc(fmtDate(o.createdAt)) + "</div></div></div>" +
      '<div class="po-rule"></div><div class="po-head"><div>' +
      "<div><b>Supplier:</b> " + esc(o.supplier) + "</div><div><b>Job #:</b> " + esc(o.jobNumber) + "</div>" +
      (o.jobName ? "<div><b>Job name:</b> " + esc(o.jobName) + "</div>" : "") + "</div><div>" +
      (o.requestedBy ? "<div><b>Requested by:</b> " + esc(o.requestedBy) + (o.phone ? " · " + esc(o.phone) : "") + "</div>" : "") +
      (o.needBy ? "<div><b>Needed by:</b> " + esc(fmtDate(o.needBy)) + "</div>" : "") +
      "<div><b>Delivery:</b> " + esc(deliveryText(o)) + "</div></div></div>" +
      '<table><thead><tr><th>#</th><th class="num">Qty</th><th>Unit</th><th>Description</th><th>Model #</th>' + (p ? '<th class="num">Unit Price</th><th class="num">Ext</th>' : "") + "</tr></thead><tbody>";
    supLines(o).forEach(function (l, i) {
      h += "<tr><td>" + (i + 1) + '</td><td class="num">' + esc(fmtQty(l.qty)) + "</td><td>" + esc(l.unit) + "</td><td>" + esc(l.name) + "</td><td>" + esc(l.model || "") + "</td>" +
        (p ? '<td class="num">' + (l.price > 0 ? fmtMoney(l.price) : "TBD") + '</td><td class="num">' + (l.price > 0 ? fmtMoney(lineTotal(l)) : "") + "</td>" : "") + "</tr>";
    });
    h += "</tbody></table>" + (p ? '<div class="po-total">Estimated total: ' + fmtMoney(orderTotal(o)) + "</div>" : "") +
      (o.notes ? '<div class="po-notes"><b>Notes:</b> ' + esc(o.notes) + "</div>" : "") +
      '<div class="sig"><div>Ordered by</div><div>Received by / date</div></div></div>';
    return h;
  }

  // ----- PDF (Kim Industries branded)
  var logoData = null;
  function loadLogo() {
    if (logoData) return Promise.resolve(logoData);
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        var c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext("2d").drawImage(img, 0, 0);
        logoData = { url: c.toDataURL("image/png"), w: img.naturalWidth, h: img.naturalHeight };
        resolve(logoData);
      };
      img.onerror = reject;
      img.src = "assets/kim-logo.png";
    });
  }

  function pdfName(o) { return "Kim-Industries_Material-Order_" + String(o.number || o.jobNumber).replace(/[^\w-]+/g, "_") + ".pdf"; }

  function buildPdf(o) {
    return loadLogo().then(function (logo) {
      var BLUE = [27, 117, 188], RED = [237, 28, 36], INK = [35, 31, 32], GREY = [95, 105, 118];
      var doc = new window.jspdf.jsPDF({ unit: "pt", format: "letter" });
      var W = doc.internal.pageSize.getWidth(), M = 40, p = o.showPricing;
      var lw = 92, lh = lw * logo.h / logo.w;
      doc.addImage(logo.url, "PNG", M, 30, lw, lh);
      doc.setTextColor.apply(doc, INK);
      doc.setFont("helvetica", "bold").setFontSize(22).text("MATERIAL ORDER", W - M, 58, { align: "right" });
      doc.setFont("helvetica", "normal").setFontSize(11).setTextColor.apply(doc, GREY);
      doc.text("Order #", W - M - 110, 80);
      doc.text("Date", W - M - 110, 96);
      doc.setTextColor.apply(doc, INK).setFont("helvetica", "bold");
      doc.text(orderNo(o), W - M, 80, { align: "right" });
      doc.text(fmtDate(o.createdAt), W - M, 96, { align: "right" });
      var y = Math.max(30 + lh, 100) + 14;
      doc.setFillColor.apply(doc, BLUE).rect(M, y, W - 2 * M - 70, 4, "F");
      doc.setFillColor.apply(doc, RED).rect(W - M - 66, y, 66, 4, "F");
      y += 24;

      function field(label, value, x, yy, width) {
        doc.setFont("helvetica", "normal").setFontSize(9).setTextColor.apply(doc, GREY).text(label.toUpperCase(), x, yy);
        doc.setFont("helvetica", "bold").setFontSize(11).setTextColor.apply(doc, INK);
        var lines = doc.splitTextToSize(value || "-", width);
        doc.text(lines, x, yy + 14);
        return yy + 14 + lines.length * 13 + 8;
      }
      var colW = (W - 2 * M - 20) / 2, x2 = M + colW + 20;
      var yl = y, yr = y;
      yl = field("Supplier", o.supplier, M, yl, colW);
      yl = field("Job #", o.jobNumber + (o.jobName ? "  -  " + o.jobName : ""), M, yl, colW);
      if (o.requestedBy || o.phone) yr = field("Requested by", (o.requestedBy || "") + (o.phone ? "  ·  " + o.phone : ""), x2, yr, colW);
      if (o.needBy) yr = field("Needed by", fmtDate(o.needBy), x2, yr, colW);
      yr = field("Delivery", deliveryText(o), x2, yr, colW);
      y = Math.max(yl, yr) + 4;

      var head = ["#", "Qty", "Unit", "Description", "Model #"];
      if (p) head.push("Unit Price", "Ext");
      var body = supLines(o).map(function (l, i) {
        var r = [i + 1, fmtQty(l.qty), l.unit, l.name, l.model || ""];
        if (p) r.push(l.price > 0 ? fmtMoney(l.price) : "TBD", l.price > 0 ? fmtMoney(lineTotal(l)) : "");
        return r;
      });
      var colStyles = { 0: { cellWidth: 24 }, 1: { halign: "right", cellWidth: 44 }, 2: { cellWidth: 36 }, 4: { cellWidth: 82 } };
      if (p) { colStyles[5] = { halign: "right", cellWidth: 62 }; colStyles[6] = { halign: "right", cellWidth: 68 }; }
      window.autoTable(doc, {
        head: [head], body: body, startY: y, margin: { left: M, right: M, bottom: 50 },
        styles: { font: "helvetica", fontSize: 9.5, cellPadding: 5, textColor: INK, lineColor: [215, 222, 230], lineWidth: 0.5 },
        headStyles: { fillColor: BLUE, textColor: 255, fontStyle: "bold" },
        alternateRowStyles: { fillColor: [244, 248, 252] },
        columnStyles: colStyles
      });
      y = doc.lastAutoTable.finalY + 18;
      var H = doc.internal.pageSize.getHeight();
      function room(n) { if (y + n > H - 60) { doc.addPage(); y = 50; } }
      if (p) {
        room(24);
        doc.setFont("helvetica", "bold").setFontSize(13).setTextColor.apply(doc, INK);
        doc.text("Estimated total:  " + fmtMoney(orderTotal(o)), W - M, y, { align: "right" });
        y += 22;
        if (supLines(o).some(function (l) { return !(l.price > 0); })) {
          doc.setFont("helvetica", "normal").setFontSize(9).setTextColor.apply(doc, GREY).text("Items marked TBD are not included in the total.", W - M, y, { align: "right" });
          y += 16;
        }
      }
      if (o.notes) {
        var nl = doc.splitTextToSize(o.notes, W - 2 * M);
        room(24 + nl.length * 13);
        doc.setFont("helvetica", "bold").setFontSize(10).setTextColor.apply(doc, INK).text("Notes", M, y);
        doc.setFont("helvetica", "normal").text(nl, M, y + 14);
        y += 20 + nl.length * 13;
      }
      room(70);
      y += 40;
      doc.setDrawColor.apply(doc, INK).setLineWidth(0.7);
      doc.line(M, y, M + 220, y);
      doc.line(W - M - 220, y, W - M, y);
      doc.setFont("helvetica", "normal").setFontSize(9).setTextColor.apply(doc, GREY);
      doc.text("Ordered by", M, y + 12);
      doc.text("Received by / date", W - M - 220, y + 12);

      var pages = doc.getNumberOfPages();
      for (var i = 1; i <= pages; i++) {
        doc.setPage(i);
        doc.setFontSize(8.5).setTextColor.apply(doc, GREY);
        doc.text("Kim Industries  ·  Material Order " + orderNo(o), M, H - 24);
        doc.text("Page " + i + " of " + pages, W - M, H - 24, { align: "right" });
      }
      return doc.output("blob");
    });
  }

  function downloadBlob(blob, name) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function doSend(kind) {
    var o = currentOrder();
    if (!o.number) { toast("Waiting for an order number - connect to the internet"); scheduleSync(0); return; }
    var subject = "Kim Industries Material Order " + o.number + " - Job " + o.jobNumber + (o.jobName ? " (" + o.jobName + ")" : "");
    var text = orderText(o);
    var done = Promise.resolve(true);
    if (kind === "email") {
      location.href = "mailto:" + encodeURIComponent(emailFor(o.supplier)) + "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(text);
    } else if (kind === "share") {
      done = navigator.share({ title: subject, text: text }).then(function () { return true; }, function () { return false; });
    } else if (kind === "share-pdf" || kind === "pdf") {
      toast("Creating PDF…");
      done = buildPdf(o).then(function (blob) {
        if (kind === "pdf") { downloadBlob(blob, pdfName(o)); return true; }
        var file = new File([blob], pdfName(o), { type: "application/pdf" });
        return navigator.share({ files: [file], title: subject, text: subject + (emailFor(o.supplier) ? "\nSupplier email: " + emailFor(o.supplier) : "") })
          .then(function () { return true; }, function (e) { return !(e && e.name === "AbortError") && (downloadBlob(blob, pdfName(o)), true); });
      }, function (e) {
        console.error(e);
        toast("Couldn't create the PDF");
        return false;
      });
    } else if (kind === "print") {
      document.getElementById("print-area").innerHTML = printHtml(o);
      var img = document.querySelector("#print-area img");
      if (img && !img.complete) img.onload = function () { window.print(); };
      else window.print();
    } else if (kind === "copy") {
      copyText(text);
    } else if (kind === "csv") {
      downloadBlob(new Blob([orderCsv(o)], { type: "text/csv" }), "Material-Order_" + o.number.replace(/[^\w-]+/g, "_") + ".csv");
    }
    done.then(function (ok) {
      o = currentOrder();
      if (ok && o.status !== "sent") {
        o.status = "sent";
        o.sentAt = new Date().toISOString();
        putOrder(o);
        setTimeout(render, 300);
      }
    });
  }

  function copyText(text) {
    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); toast("Copied"); } catch (e) { toast("Copy failed"); }
      ta.remove();
    }
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(function () { toast("Copied"); }, fallback);
    else fallback();
  }

  // ----- history
  // ----- shop stock
  function pendingPulls() {
    return getOrders().filter(function (o) {
      return o.status === "sent" && shopLines(o).some(function (l) { return !l.pulled; });
    });
  }

  VIEWS.shop = function () {
    var h = topbar("Shop Stock", "Material on hand in our shops", backBtn("home", "Home"), syncPill());
    h += '<main class="page">';
    if (!Cloud.enabled) return h + '<div class="empty">Shop stock needs the shared database.</div></main>';
    if (canEditShop()) h += '<button class="btn primary big block" data-action="shop-add" style="margin-bottom:14px">' + ICON.plus + "Add Material to Shop</button>";
    else h += '<div class="notice">You can see shop stock. To add or remove material, ask an admin for permission.</div>';

    var pulls = canEditShop() ? pendingPulls() : [];
    if (pulls.length) {
      h += '<h3>Waiting to be pulled (' + pulls.length + ')</h3><div class="tile-list" style="margin-bottom:8px">';
      pulls.forEach(function (o) {
        var ls = shopLines(o).filter(function (l) { return !l.pulled; });
        h += '<button class="tile" data-action="open-pull" data-id="' + esc(o.id) + '"><div class="t-main"><div class="t-title">Job ' + esc(o.jobNumber) + " · " + esc(orderNo(o)) + "</div>" +
          '<div class="t-sub">' + ls.length + " item" + (ls.length === 1 ? "" : "s") + " · " + esc(o.createdByName || "") + "</div>" +
          '<div class="t-sub">' + ls.slice(0, 2).map(function (l) { return esc(fmtQty(l.qty) + " " + l.unit + " " + l.name) + " (Div " + esc(l.division) + ")"; }).join("<br>") + "</div>" +
          '</div><span class="badge draft">Pull</span></button>';
      });
      h += "</div>";
    }

    h += '<div class="searchbar"><div class="search-wrap">' + ICON.search +
      '<input class="search-input" id="stock-q" type="search" autocomplete="off" placeholder=\'Search shop stock, e.g. 1/2 x 1 fiberglass\' value="' + esc(state.stockQuery || "") + '" aria-label="Search shop stock"></div>' +
      '<div class="chips" style="margin:10px 0 0"><button class="chip' + (state.stockDiv ? "" : " on") + '" data-action="stock-div" data-div="">All divisions</button>' +
      DIVISIONS.map(function (d) { return '<button class="chip' + (state.stockDiv === d ? " on" : "") + '" data-action="stock-div" data-div="' + d + '">' + d + "</button>"; }).join("") +
      '</div></div><div id="stock-list"></div></main>';
    return h;
  };
  AFTER.shop = function () {
    var q = document.getElementById("stock-q");
    if (!q) return;
    q.addEventListener("input", function () {
      state.stockQuery = q.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(renderStockList, 140);
    });
    renderStockList();
  };

  function renderStockList() {
    var box = document.getElementById("stock-list");
    if (!box) return;
    var rows = getStock().filter(function (r) { return !state.stockDiv || r.division === state.stockDiv; });
    var items = rows.map(function (r) { return { name: r.item_name, category: r.category || "", model: r.model || "", row: r }; });
    if ((state.stockQuery || "").trim()) {
      S.buildIndex(items);
      items = S.search(items, state.stockQuery).results;
    } else {
      items.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : a.row.division < b.row.division ? -1 : 1; });
    }
    if (!getStock().length) {
      box.innerHTML = '<div class="empty"><p><b>No shop stock entered yet.</b></p>' + (canEditShop() ? "<p>Tap <b>Add Material to Shop</b> to start.</p>" : "") + "</div>";
      return;
    }
    if (!items.length) { box.innerHTML = '<div class="empty">Nothing matches.</div>'; return; }
    box.innerHTML = '<div class="search-meta" style="margin-bottom:8px"><b>' + items.length + "</b> item" + (items.length === 1 ? "" : "s") + "</div>" +
      '<ul class="results">' + items.slice(0, 300).map(function (x) {
        var r = x.row;
        return '<li class="result stock-row"><button class="r-main" data-action="stock-item" data-key="' + esc(r.item_key) + '" data-div="' + esc(r.division) + '">' +
          '<div class="r-name">' + esc(r.item_name) + '</div><div class="r-sub">' + esc(r.category || "") + (r.model ? " · #" + esc(r.model) : "") + "</div>" +
          '<div class="r-sub">Updated ' + esc(fmtDate(r.updated_at)) + (r.updated_by ? " by " + esc(r.updated_by.split("@")[0]) : "") + "</div></button>" +
          '<div class="stock-qty"><span class="div-badge">Div ' + esc(r.division) + '</span><b>' + esc(fmtQty(r.qty)) + "</b><small>" + esc(r.unit || "") + "</small></div></li>";
      }).join("") + "</ul>";
  }

  // Stock sheet: see what's on hand for one material and (with permission) add / remove / set it.
  function openStockSheet(item, presetDiv) {
    var rows = getStock().filter(function (r) { return r.item_key === item.key; });
    var div = presetDiv || (rows[0] && rows[0].division) || "";
    var edit = canEditShop();
    var h = "<h2>" + esc(item.name) + "</h2>" + '<div class="hint" style="margin-top:-6px">' + esc(item.category || "") + (item.model ? " · #" + esc(item.model) : "") + "</div>";
    h += '<div class="onhand">' + (rows.length ? rows.map(function (r) {
      return '<div><span class="div-badge">Div ' + esc(r.division) + "</span><b>" + esc(fmtQty(r.qty)) + " " + esc(r.unit || item.unit || "") + "</b></div>";
    }).join("") : '<div class="hint" style="margin:0">None in the shop yet.</div>') + "</div>";
    if (edit) {
      h += '<div class="field"><span style="display:block;font-weight:600;margin-bottom:6px">Division <span class="req">*</span></span><div class="chips div-chips">' +
        DIVISIONS.map(function (d) { return '<button type="button" class="chip' + (d === div ? " on" : "") + '" data-div="' + d + '">' + d + "</button>"; }).join("") + "</div></div>" +
        '<div class="big-stepper"><button type="button" data-step="-1" aria-label="Decrease">−</button>' +
        '<input id="stock-qty" type="number" inputmode="decimal" min="0" step="any" placeholder="0" aria-label="Quantity">' +
        '<button type="button" data-step="1" aria-label="Increase">+</button></div><div class="unit-label">' + esc(item.unit || "") + "</div>" +
        '<label class="field" style="margin-top:12px"><span>Note / job # (optional)</span><input class="input" id="stock-note" placeholder="e.g. Leftover from job 24-118"></label>' +
        '<div class="btn-row"><button class="btn primary" data-stock-op="add">' + ICON.plus + "Add to shop</button>" +
        '<button class="btn" data-stock-op="remove">Remove</button><button class="btn" data-stock-op="set">Set count</button></div>' +
        '<div class="hint" style="font-size:13px">Add = put more in. Remove = taken out. Set count = what\'s actually on the shelf now.</div>';
    } else {
      h += '<div class="notice">Only people with shop permission can change stock.</div>';
    }
    h += '<h3 style="margin-top:18px">History</h3><div id="stock-history" class="hint">Loading…</div>' +
      '<button class="btn block" style="margin-top:12px" data-action="close-sheet">Close</button>';
    openSheet(h, function (sheet) {
      Cloud.stockLog(item.key).then(function (log) {
        var el = sheet.querySelector("#stock-history");
        if (!el) return;
        el.innerHTML = log.length ? log.map(function (e) {
          return '<div class="log-row"><b class="' + (e.delta >= 0 ? "pos" : "neg") + '">' + (e.delta > 0 ? "+" : "") + esc(fmtQty(e.delta)) + "</b> Div " + esc(e.division) +
            " → " + esc(fmtQty(e.qty_after)) + '<div class="t-sub">' + esc(fmtDate(e.at)) + " · " + esc((e.by_email || "").split("@")[0]) +
            (e.job_number ? " · Job " + esc(e.job_number) : "") + (e.reason ? " · " + esc(e.reason) : "") + "</div></div>";
        }).join("") : "No changes recorded yet.";
      }, function () { var el = sheet.querySelector("#stock-history"); if (el) el.textContent = "History unavailable offline."; });
      if (!edit) return;
      var input = sheet.querySelector("#stock-qty");
      sheet.querySelectorAll(".div-chips .chip").forEach(function (c) {
        c.addEventListener("click", function () {
          div = c.getAttribute("data-div");
          sheet.querySelectorAll(".div-chips .chip").forEach(function (x) { x.classList.toggle("on", x === c); });
        });
      });
      sheet.querySelectorAll("[data-step]").forEach(function (b) {
        b.addEventListener("click", function () { input.value = Math.max(0, +((parseFloat(input.value) || 0) + (+b.getAttribute("data-step"))).toFixed(3)); });
      });
      sheet.querySelectorAll("[data-stock-op]").forEach(function (b) {
        b.addEventListener("click", function () {
          var op = b.getAttribute("data-stock-op");
          var q = parseFloat(input.value);
          if (!div) { toast("Pick a division"); return; }
          if (!(q >= 0) || (op !== "set" && !(q > 0))) { input.focus(); toast("Enter a quantity"); return; }
          if (!navigator.onLine) { toast("Connect to the internet to change shop stock"); return; }
          var note = sheet.querySelector("#stock-note").value.trim();
          var job = (note.match(/\b\d{2,}-\d+\b/) || [])[0] || null;
          b.disabled = true;
          Cloud.adjustStock({
            item: item, division: div,
            delta: op === "add" ? q : op === "remove" ? -q : null,
            set: op === "set" ? q : null,
            reason: note || (op === "add" ? "Added to shop" : op === "remove" ? "Removed from shop" : "Count corrected"),
            job: job
          }).then(function (now) {
            return refreshStock().then(function () {
              closeSheet();
              toast("Div " + div + ": now " + fmtQty(now) + " " + (item.unit || ""));
              if (state.view === "shop-add") go("shop"); else render();
            });
          }, function (e) {
            b.disabled = false;
            toast(/permission/i.test(e.message) ? "You don't have permission to change shop stock" : e.message || "Couldn't save");
          });
        });
      });
    });
  }

  // Pull the shop lines of an order out of stock (shop-permission users).
  function openPullSheet(orderId) {
    var o = getOrder(orderId);
    if (!o) return;
    var ls = shopLines(o).filter(function (l) { return !l.pulled; });
    var h = "<h2>Pull from shop - Job " + esc(o.jobNumber) + "</h2>" + '<div class="hint" style="margin-top:-6px">' + esc(orderNo(o)) + (o.createdByName ? " · requested by " + esc(o.createdByName) : "") + "</div>" +
      '<div class="card" style="box-shadow:none">' + ls.map(lineSummary).join("") + "</div>" +
      '<div class="btn-row"><button class="btn" data-action="close-sheet">Cancel</button><button class="btn primary" id="do-pull">Mark pulled &amp; update stock</button></div>';
    openSheet(h, function (sheet) {
      sheet.querySelector("#do-pull").addEventListener("click", function (e) {
        e.target.disabled = true;
        pullShopLines(orderId).then(function () { closeSheet(); render(); }, function () { e.target.disabled = false; });
      });
    });
  }
  function lineSummary(l) {
    return '<div class="log-row"><span class="div-badge">Div ' + esc(l.division) + "</span> <b>" + esc(fmtQty(l.qty)) + " " + esc(l.unit) + "</b> " + esc(l.name) + "</div>";
  }

  function pullShopLines(orderId) {
    if (!navigator.onLine) { toast("Connect to the internet to update shop stock"); return Promise.reject(); }
    var o = getOrder(orderId);
    var chain = Promise.resolve();
    shopLines(o).filter(function (l) { return !l.pulled; }).forEach(function (l) {
      chain = chain.then(function () {
        return Cloud.adjustStock({
          item: { key: l.stockKey, name: l.name, unit: l.unit, category: l.category, model: l.model },
          division: l.division, delta: -l.qty, reason: "Pulled for job", job: o.jobNumber, orderId: o.id
        }).then(function () {
          var cur = getOrder(orderId);
          cur.lines.forEach(function (x) {
            if (x.key === l.key && !x.pulled) { x.pulled = true; x.pulledBy = Cloud.user.email; x.pulledAt = new Date().toISOString(); }
          });
          putOrder(cur);
        });
      });
    });
    return chain.then(function () {
      toast("Pulled from shop - stock updated");
      scheduleSync(0);
      return refreshStock();
    }, function (e) {
      toast(e && e.message ? e.message : "Couldn't update stock");
      refreshStock();
      throw e;
    });
  }

  // ----- users & permissions (admin)
  VIEWS.users = function () {
    var h = topbar("Users & Permissions", "Admin", backBtn("settings", "Settings"));
    h += '<main class="page">';
    if (!isAdmin()) return h + '<div class="empty">Only an admin can manage users.</div></main>';
    h += '<div class="card"><h2 style="margin-top:0;font-size:18px">Add a person</h2><form id="user-form" autocomplete="off">' +
      '<label class="field"><span>Email <span class="req">*</span></span><input class="input" name="email" type="email" required placeholder="name@kimindustries.com"></label>' +
      '<label class="field"><span>Name</span><input class="input" name="name" placeholder="First and last name"></label>' +
      '<label class="toggle"><input type="checkbox" name="can_edit_shop">Can add / remove shop stock</label>' +
      '<label class="toggle"><input type="checkbox" name="admin">Admin (can manage users)</label>' +
      '<label class="field" style="margin-top:8px"><span>Temporary password (creates their login)</span><input class="input" name="password" type="text" minlength="8" placeholder="At least 8 characters - leave blank if they already have a login"></label>' +
      '<div class="error-text" id="user-error" hidden></div>' +
      '<button class="btn primary block" type="submit">Save person</button></form></div>';
    h += '<h3>People</h3><div id="user-list" class="hint">Loading…</div></main>';
    return h;
  };
  AFTER.users = function () {
    if (!isAdmin()) return;
    loadUsers();
    document.getElementById("user-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var f = e.target, err = document.getElementById("user-error"), btn = f.querySelector("button[type=submit]");
      var u = { email: f.email.value.trim().toLowerCase(), name: f.name.value.trim(), can_edit_shop: f.can_edit_shop.checked, role: f.admin.checked ? "admin" : "user" };
      var pw = f.password.value;
      err.hidden = true;
      if (!u.email) { f.email.focus(); return; }
      if (pw && pw.length < 8) { err.textContent = "Password must be at least 8 characters."; err.hidden = false; return; }
      btn.disabled = true;
      var step = pw ? Cloud.adminUsers({ action: "create", email: u.email, password: pw, name: u.name }) : Promise.resolve();
      step.then(function (r) {
        return Cloud.saveUser(u).then(function () {
          toast(pw ? (r && r.existed ? "Saved - they already had a login" : "Login created - give them the password") : "Saved");
          f.reset();
          loadUsers();
        });
      }).catch(function (ex) {
        var m = ex && ex.message || "Couldn't save";
        if (/Failed to send|FunctionsFetchError|not found|404/i.test(m)) m = "Couldn't create the login: the admin-users function isn't set up in Supabase yet. Permissions were not saved. Leave the password blank to save permissions only, and create the login in Supabase > Authentication > Users.";
        err.textContent = m;
        err.hidden = false;
      }).then(function () { btn.disabled = false; });
    });
  };
  function loadUsers() {
    Cloud.listUsers().then(function (list) {
      state.users = list;
      var el = document.getElementById("user-list");
      if (!el) return;
      var me = (Cloud.user.email || "").toLowerCase();
      el.className = "";
      el.innerHTML = list.length ? '<div class="tile-list">' + list.map(function (u) {
        var self = u.email === me;
        return '<div class="card user-card' + (u.blocked ? " blocked" : "") + '"><div class="u-head"><div><div class="t-title">' + esc(u.name || u.email.split("@")[0]) +
          (u.role === "admin" ? ' <span class="badge sent">Admin</span>' : "") + (u.blocked ? ' <span class="badge">Access off</span>' : "") + "</div>" +
          '<div class="t-sub">' + esc(u.email) + (self ? " (you)" : "") + "</div></div></div>" +
          '<label class="toggle"><input type="checkbox" data-user-flag="can_edit_shop" data-email="' + esc(u.email) + '"' + (u.can_edit_shop || u.role === "admin" ? " checked" : "") + (u.role === "admin" ? " disabled" : "") + ">Can add / remove shop stock</label>" +
          (self ? "" : '<label class="toggle"><input type="checkbox" data-user-flag="admin" data-email="' + esc(u.email) + '"' + (u.role === "admin" ? " checked" : "") + ">Admin</label>" +
            '<label class="toggle"><input type="checkbox" data-user-flag="blocked" data-email="' + esc(u.email) + '"' + (u.blocked ? " checked" : "") + ">Turn off access</label>") +
          '<div class="btn-row"><button class="btn" data-action="user-password" data-email="' + esc(u.email) + '">Reset password</button>' +
          (self ? "" : '<button class="btn danger" data-action="user-remove" data-email="' + esc(u.email) + '">Remove from list</button>') + "</div></div>";
      }).join("") + "</div>" : '<div class="empty">No one added yet.</div>';
      el.insertAdjacentHTML("beforeend", '<p class="hint" style="font-size:13px">People with a login who aren\'t listed here can order and look up shop stock, but can\'t change it.</p>');
      el.querySelectorAll("[data-user-flag]").forEach(function (cb) {
        cb.addEventListener("change", function () {
          var u = state.users.filter(function (x) { return x.email === cb.getAttribute("data-email"); })[0];
          var flag = cb.getAttribute("data-user-flag");
          var nu = JSON.parse(JSON.stringify(u));
          if (flag === "admin") nu.role = cb.checked ? "admin" : "user";
          else nu[flag] = cb.checked;
          Cloud.saveUser(nu).then(function () { toast("Saved"); loadUsers(); }, function (e) { toast(e.message || "Couldn't save"); loadUsers(); });
        });
      });
    }, function (e) {
      var el = document.getElementById("user-list");
      if (el) el.textContent = "Couldn't load users: " + (e.message || "check your connection") + ". Has supabase/shop.sql been run?";
    });
  }

  VIEWS.history = function () {
    var all = getOrders();
    var me = Cloud.user ? Cloud.user.email : "";
    var f = state.historyFilter || "";
    var mine = state.historyMine && Cloud.enabled;
    var q = f.trim().toUpperCase();
    var orders = all.filter(function (o) {
      if (mine && o.createdBy !== me) return false;
      if (!q) return true;
      return [o.jobNumber, o.jobName, o.number, o.supplier, o.createdByName].join(" ").toUpperCase().indexOf(q) >= 0;
    });
    var h = topbar("Order History", Cloud.enabled ? "All company orders" : "Orders on this device", backBtn("home", "Home"), syncPill());
    h += '<main class="page"><div class="searchbar"><div class="search-wrap">' + ICON.search +
      '<input class="search-input" id="history-q" type="search" autocomplete="off" placeholder="Job #, job name, order # or supplier" value="' + esc(f) + '" aria-label="Filter orders"></div>';
    if (Cloud.enabled) {
      h += '<div class="seg" style="margin-top:10px"><button data-action="history-mine" data-val="0" class="' + (mine ? "" : "on") + '">Everyone</button>' +
        '<button data-action="history-mine" data-val="1" class="' + (mine ? "on" : "") + '">Just mine</button></div>';
    }
    h += '</div><div id="history-list">' + historyList(orders) + "</div></main>";
    return h;
  };
  function historyList(orders) {
    if (!orders.length) return '<div class="empty">No orders found.</div>';
    return '<div class="tile-list">' + orders.slice(0, 200).map(orderTile).join("") + "</div>";
  }
  AFTER.history = function () {
    var inp = document.getElementById("history-q");
    inp.addEventListener("input", function () {
      state.historyFilter = inp.value;
      var y = window.scrollY;
      render();
      var el = document.getElementById("history-q");
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      window.scrollTo(0, y);
    });
  };

  // ----- sign in
  VIEWS.login = function () {
    return '<main class="page login"><div class="login-card">' +
      '<img class="login-logo" src="assets/kim-logo.png" alt="Kim Industries">' +
      '<h2>Material Orders</h2><p class="hint">Sign in with your Kim Industries account.</p>' +
      '<form id="login-form"><label class="field"><span>Email</span><input class="input" id="login-email" type="email" autocomplete="username" required value="' + esc(store.get("lastEmail", "")) + '"></label>' +
      '<label class="field"><span>Password</span><input class="input" id="login-pass" type="password" autocomplete="current-password" required></label>' +
      '<div class="error-text" id="login-error" hidden></div>' +
      '<button class="btn primary big block" type="submit" id="login-btn">Sign In</button></form>' +
      '<p class="hint" style="margin-top:18px;font-size:14px">No account or forgot your password? Ask the office to set you up.</p></div></main>';
  };
  AFTER.login = function () {
    var email = document.getElementById("login-email"), pass = document.getElementById("login-pass");
    (email.value ? pass : email).focus();
    document.getElementById("login-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var err = document.getElementById("login-error"), btn = document.getElementById("login-btn");
      err.hidden = true;
      btn.disabled = true;
      btn.textContent = "Signing in…";
      Cloud.signIn(email.value.trim(), pass.value).then(function (u) {
        store.set("lastEmail", u.email);
        if (store.get("owner", "") !== u.email) {
          // Different person on this phone: don't show the previous user's unsynced cache.
          saveOrders(getOrders().filter(function (o) { return o.dirty; }));
          store.set("owner", u.email);
        }
        go("home");
        syncNow();
      }, function (ex) {
        btn.disabled = false;
        btn.textContent = "Sign In";
        err.textContent = !navigator.onLine || /fetch|network/i.test(ex && ex.message) ? "Can't reach the server. Check your internet connection and try again."
          : /invalid/i.test(ex && ex.message) ? "Email or password is incorrect." : (ex && ex.message) || "Could not sign in.";
        err.hidden = false;
      });
    });
  };

  // ----- settings
  VIEWS.settings = function () {
    var s = settings();
    var emails = supplierEmails();
    var h = topbar("Settings", "", backBtn("home", "Home"));
    h += '<main class="page"><form id="settings-form">';
    if (Cloud.enabled && Cloud.user) {
      h += '<div class="card"><div class="t-sub" style="color:var(--muted)">Signed in as</div><div style="font-weight:700;margin-bottom:4px">' + esc(Cloud.user.email) + "</div>" +
        '<div class="hint" style="margin:0 0 10px">' + (isAdmin() ? "Admin" : canEditShop() ? "Can change shop stock" : "Crew member") + "</div>" +
        '<div class="btn-row">' + (isAdmin() ? '<button type="button" class="btn brand" data-action="users">Users &amp; Permissions</button>' : "") +
        '<button type="button" class="btn" data-action="sign-out">Sign out</button></div></div>';
    }
    h += '<div class="card"><label class="field"><span>Your name (shown on orders)</span><input class="input" name="name" autocomplete="name" value="' + esc(s.name || myName()) + '"></label>' +
      '<label class="field" style="margin:0"><span>Your phone</span><input class="input" name="phone" type="tel" autocomplete="tel" value="' + esc(s.phone) + '"></label></div>' +
      '<h3>Supplier order emails</h3><div class="card"><p class="hint" style="margin-top:0">Pre-fills the "To" line when emailing an order.' +
      (Cloud.enabled ? " Shared with everyone in the company." : "") + "</p>";
    SUPPLIERS.forEach(function (sup) {
      h += '<label class="field"><span>' + esc(sup) + '</span><input class="input" type="email" data-sup="' + esc(sup) + '" value="' + esc(emails[sup] || "") + '" placeholder="orders@supplier.com"></label>';
    });
    h += "</div></form><p class=\"hint\">" + (Cloud.enabled ? "Orders are shared through the Kim Industries database and saved on this phone for offline use."
      : "Orders are saved on this device only.") + "</p></main>";
    return h;
  };
  AFTER.settings = function () {
    var form = document.getElementById("settings-form");
    form.addEventListener("input", function (e) {
      var s = settings();
      if (e.target.name) { s[e.target.name] = e.target.value; store.set("settings", s); }
    });
    form.addEventListener("change", function (e) {
      var sup = e.target.getAttribute("data-sup");
      if (!sup) return;
      var val = e.target.value.trim();
      if (Cloud.enabled) {
        var m = store.get("supplierEmails", {});
        m[sup] = val;
        store.set("supplierEmails", m);
        Cloud.setSupplierEmail(sup, val).then(function () { toast("Saved for everyone"); }, function () { toast("Couldn't save - check your connection"); });
      } else {
        var s = settings();
        s.supplierEmails = s.supplierEmails || {};
        s.supplierEmails[sup] = val;
        store.set("settings", s);
        toast("Saved");
      }
    });
  };

  // ---------------------------------------------------------------- actions
  var ACTIONS = {
    "home": function () { go("home"); },
    "shop": function () { go("shop"); refreshStock().then(function () { if (state.view === "shop") renderStockList(); }); },
    "shop-add": function () {
      if (!canEditShop()) { toast("You don't have permission to change shop stock"); return; }
      go("shop-add", { mode: "search", query: "", browsePath: [], browseAll: false, sizeA: "", sizeB: "", filterText: "" });
    },
    "stock-div": function (el) { state.stockDiv = el.getAttribute("data-div"); render(); },
    "stock-item": function (el) {
      var key = el.getAttribute("data-key");
      var r = getStock().filter(function (x) { return x.item_key === key; })[0];
      if (r) openStockSheet({ key: r.item_key, name: r.item_name, unit: r.unit, category: r.category, model: r.model }, el.getAttribute("data-div"));
    },
    "open-pull": function (el) { openPullSheet(el.getAttribute("data-id")); },
    "users": function () { go("users"); },
    "user-remove": function (el) {
      var email = el.getAttribute("data-email");
      if (!confirm("Remove " + email + " from the list? Their shop permission goes away (their login still works - use 'Turn off access' to block them).")) return;
      Cloud.deleteUser(email).then(function () { toast("Removed"); loadUsers(); }, function (e) { toast(e.message || "Couldn't remove"); });
    },
    "user-password": function (el) {
      var email = el.getAttribute("data-email");
      var pw = prompt("New password for " + email + " (at least 8 characters):");
      if (pw == null) return;
      if (pw.length < 8) { toast("Password must be at least 8 characters"); return; }
      Cloud.adminUsers({ action: "reset-password", email: email, password: pw }).then(function () { toast("Password changed"); }, function (e) {
        toast(/Failed to send|FunctionsFetchError|404/i.test(e.message || "") ? "Set up the admin-users function in Supabase first" : e.message || "Couldn't change password");
      });
    },
    "sync-now": function () { syncNow().then(function () { if (sync.state === "synced") toast("Up to date"); }); },
    "history-mine": function (el) { state.historyMine = el.getAttribute("data-val") === "1"; render(); },
    "sign-out": function () {
      var n = pendingCount();
      if (n && !confirm(n + " change(s) haven't reached the office yet and will be lost. Sign out anyway?")) return;
      Cloud.signOut().then(function () {
        saveOrders([]);
        store.set("pendingDeletes", []);
        go("login");
      });
    },
    "settings": function () { go("settings"); },
    "history": function () { go("history"); },
    "lookup": function () { go("lookup", { mode: "search", query: "", browsePath: [], browseAll: false, sizeA: "", sizeB: "", filterText: "" }); },
    "new-order": function () { state.draft = {}; go("supplier"); },
    "to-supplier": function () { go("supplier"); },
    "pick-supplier": function (el) {
      state.draft = state.draft || {};
      state.draft.supplier = el.getAttribute("data-supplier");
      go("job");
    },
    "pick-job": function (el) {
      document.getElementById("job-number").value = el.getAttribute("data-job");
      document.getElementById("job-name").value = el.getAttribute("data-name");
      document.getElementById("job-number").dispatchEvent(new Event("input"));
    },
    "order-from-lookup": function (el) {
      closeSheet();
      state.draft = { supplier: el.getAttribute("data-supplier") };
      go("job");
    },
    "open-order": function (el) {
      var o = getOrder(el.getAttribute("data-id"));
      if (!o) return;
      state.orderId = o.id;
      if (o.status === "draft") go(o.lines.length ? "review" : "build", { mode: "search", query: "", browsePath: [], browseAll: false });
      else go("send");
    },
    "mode": function (el) {
      state.mode = el.getAttribute("data-mode");
      state.shown = PAGE;
      render();
    },
    "clear-q": function () {
      state.query = "";
      render();
      var q = document.getElementById("q");
      if (q) q.focus();
    },
    "example": function (el) {
      state.query = el.getAttribute("data-q");
      render();
    },
    "more": function () {
      state.shown += PAGE * 2;
      refreshList();
    },
    "crumb": function (el) {
      state.browsePath = state.browsePath.slice(0, +el.getAttribute("data-depth"));
      state.browseAll = false; state.sizeA = state.sizeB = state.filterText = ""; state.shown = PAGE;
      render();
    },
    "browse-into": function (el) {
      state.browsePath = state.browsePath.concat(el.getAttribute("data-name"));
      state.browseAll = false; state.sizeA = state.sizeB = state.filterText = ""; state.shown = PAGE;
      render();
      window.scrollTo(0, 0);
    },
    "browse-all": function () {
      state.browseAll = true; state.shown = PAGE;
      render();
    },
    "item": function (el) { openItemSheet(el.getAttribute("data-key")); },
    "custom-item": function () { openCustomSheet(); },
    "close-sheet": closeSheet,
    "close-sheet-bg": function (el, e) { if (e.target === el) closeSheet(); },
    "review": function () { go("review"); },
    "to-review": function () { go("review"); },
    "to-build": function () { go("build"); },
    "line-step": function (el) {
      var key = el.getAttribute("data-key");
      var o = currentOrder();
      var l = o.lines.filter(function (x) { return x.key === key; })[0];
      var q = +(l.qty + (+el.getAttribute("data-step"))).toFixed(3);
      if (q <= 0) {
        if (!confirm("Remove this item from the order?")) return;
        removeLine(key);
      } else setLineQty(key, q);
      var y = window.scrollY;
      render();
      window.scrollTo(0, y);
    },
    "line-remove": function (el) {
      if (!confirm("Remove this item from the order?")) return;
      removeLine(el.getAttribute("data-key"));
      var y = window.scrollY;
      render();
      window.scrollTo(0, y);
    },
    "delivery": function (el) {
      var o = currentOrder();
      o.delivery = el.getAttribute("data-val");
      putOrder(o);
      var y = window.scrollY;
      render();
      window.scrollTo(0, y);
    },
    "save-draft": function () { toast("Draft saved"); go("home"); },
    "delete-order": function () {
      if (!confirm("Delete this order? This can't be undone.")) return;
      deleteOrder(state.orderId);
      state.orderId = null;
      toast("Order deleted");
      go("home");
    },
    "to-send": function () {
      var o = currentOrder();
      if (!o.jobNumber) { toast("Job number is required"); return; }
      if (!o.lines.length) { toast("Add at least one item"); return; }
      go("send");
    },
    "send": function (el) { doSend(el.getAttribute("data-kind")); },
    "mark-sent": function () {
      var o = currentOrder();
      o.status = "sent";
      o.sentAt = new Date().toISOString();
      putOrder(o);
      toast("Marked as sent");
      render();
    },
    "reopen": function () {
      var o = currentOrder();
      o.status = "draft";
      putOrder(o);
      go("review");
    },
    "duplicate": function () {
      var o = currentOrder();
      // Re-price from the current price list where the item still exists.
      var lines = o.lines.map(function (l) {
        var it = l.key && BY_KEY[l.key];
        var c = JSON.parse(JSON.stringify(l));
        if (it) c.price = it.price;
        if (c.source === "shop") { c.pulled = false; delete c.pulledBy; delete c.pulledAt; }
        return c;
      });
      var copy = JSON.parse(JSON.stringify(o));
      copy.id = uid();
      copy.number = Cloud.enabled ? null : newOrderNumber(copy.jobNumber);
      copy.createdBy = Cloud.user ? Cloud.user.email : "";
      copy.createdByName = myName();
      copy.status = "draft";
      copy.lines = lines;
      copy.needBy = "";
      copy.createdAt = new Date().toISOString();
      delete copy.sentAt;
      putOrder(copy);
      scheduleSync(0);
      state.orderId = copy.id;
      toast("Copied as a new draft");
      go("review");
    }
  };

  document.addEventListener("click", function (e) {
    var el = e.target.closest("[data-action]");
    if (!el) return;
    var fn = ACTIONS[el.getAttribute("data-action")];
    if (fn) { fn(el, e); }
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && document.getElementById("sheet-root").innerHTML) closeSheet();
  });

  // ---------------------------------------------------------------- start
  try { history.replaceState({ v: "home" }, ""); } catch (e) { /* ignore */ }
  if (!Cloud.enabled) {
    render();
  } else {
    app.innerHTML = '<div class="loading"><img src="assets/kim-logo.png" alt="Kim Industries" style="width:140px"><div>Loading…</div></div>';
    Cloud.init().then(function (u) {
      if (u) {
        store.set("owner", u.email);
        render();
        syncNow();
      } else if (!navigator.onLine && store.get("owner", "")) {
        // No signal, but this phone was signed in before: keep working, sync when back online.
        render();
        setSyncState("offline");
      } else {
        state.view = "login";
        render();
      }
    });
    window.addEventListener("online", function () {
      if (Cloud.user || state.view === "login") return;
      Cloud.init().then(function (u) { if (u) syncNow(); else go("login"); });
    });
  }
  setTimeout(ensureIndex, 50);

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(function () { /* offline support unavailable */ });
  }
})();
