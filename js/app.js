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
        return Cloud.getSupplierEmails().then(function (m) { store.set("supplierEmails", m); }, function () { /* keep cached */ });
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
        if (state.view === "home" || state.view === "history") render();
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
  function orderTotal(o) { return round2(o.lines.reduce(function (s, l) { return s + lineTotal(l); }, 0)); }
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
      "</div></div>";
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
    var h = topbar("Price Lookup", state.lookupSupplier || "All suppliers", backBtn("home", "Home"));
    h += '<main class="page"><label class="field" style="margin-bottom:6px"><span>Supplier</span><select class="input" id="lookup-supplier">' +
      '<option value="">All suppliers</option>' +
      SUPPLIERS.map(function (s) { return '<option' + (s === state.lookupSupplier ? " selected" : "") + ">" + esc(s) + "</option>"; }).join("") +
      "</select></label>" + finderHtml() + "</main>";
    return h;
  };
  AFTER.lookup = function () {
    afterFinder();
    document.getElementById("lookup-supplier").addEventListener("change", function (e) {
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
    var h = '<ul class="results">';
    list.slice(0, state.shown).forEach(function (it) {
      var line = inOrder[it.key];
      h += '<li class="result' + (line ? " in-order" : "") + '">' +
        '<button class="r-main" data-action="item" data-key="' + esc(it.key) + '">' +
        '<div class="r-name">' + esc(it.name) + "</div>" +
        '<div class="r-sub">' + (showSup ? '<span class="sup-tag">' + esc(it.supplier) + "</span> · " : "") + esc(it.category) + (it.model ? " · #" + esc(it.model) : "") + "</div>" +
        '<div class="r-price">' + priceHtml(it.price, it.unit) + "</div></button>";
      if (o) {
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
    var it = BY_KEY[key];
    if (!it) return;
    if (state.view === "lookup") {
      openSheet('<h2>' + esc(it.name) + "</h2><dl class=\"kv\"><dt>Supplier</dt><dd>" + esc(it.supplier) + "</dd><dt>Price</dt><dd>" +
        (it.price > 0 ? fmtMoney(it.price) : "TBD") + " / " + esc(it.unit) + "</dd><dt>Category</dt><dd>" + esc(it.category) + "</dd>" +
        (it.model ? "<dt>Model #</dt><dd>" + esc(it.model) + "</dd>" : "") + "<dt>Item ID</dt><dd>" + esc(it.id) + "</dd></dl>" +
        '<div class="btn-row" style="margin-top:18px"><button class="btn" data-action="close-sheet">Close</button>' +
        '<button class="btn primary" data-action="order-from-lookup" data-supplier="' + esc(it.supplier) + '">Start order with ' + esc(it.supplier) + "</button></div>");
      return;
    }
    var o = currentOrder();
    var existing = o.lines.filter(function (l) { return l.key === key; })[0];
    var qty = existing ? existing.qty : "";
    openQtySheet({
      title: it.name,
      sub: it.category + (it.model ? " · #" + it.model : ""),
      price: it.price, unit: it.unit, qty: qty, existing: !!existing,
      onSave: function (q) {
        var ord = currentOrder();
        var l = ord.lines.filter(function (x) { return x.key === key; })[0];
        if (l) l.qty = q;
        else ord.lines.push({ key: key, id: it.id, name: it.name, unit: it.unit, price: it.price, model: it.model, category: it.category, qty: q });
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
      '<div style="font-weight:700">' + (opt.price > 0 ? fmtMoney(opt.price) + " / " + esc(opt.unit) : "Price TBD / " + esc(opt.unit)) + "</div>" +
      '<div class="big-stepper"><button type="button" data-step="-1" aria-label="Decrease">−</button>' +
      '<input id="qty" type="number" inputmode="decimal" min="0" step="any" value="' + esc(opt.qty) + '" placeholder="0" aria-label="Quantity">' +
      '<button type="button" data-step="1" aria-label="Increase">+</button></div>' +
      '<div class="unit-label">' + esc(opt.unit) + '</div>' +
      '<div class="chips quick">' + quick.map(function (n) { return '<button type="button" class="chip" data-add="' + n + '">+' + n + "</button>"; }).join("") + "</div>" +
      '<div class="line-total" id="line-total"></div>' +
      '<div class="btn-row">' + (opt.existing ? '<button class="btn danger" id="qty-remove">Remove</button>' : '<button class="btn" data-action="close-sheet">Cancel</button>') +
      '<button class="btn primary" id="qty-save">' + (opt.existing ? "Update" : "Add to Order") + "</button></div>";
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

    h += '<h3>Materials (' + o.lines.length + ")</h3><div class=\"card\">";
    if (!o.lines.length) h += '<div class="empty">No materials yet.</div>';
    o.lines.forEach(function (l) {
      h += '<div class="line"><div><div class="l-name">' + esc(l.name) + "</div>" +
        '<div class="l-sub">' + (l.custom ? "Not in price list" : esc(l.category) + (l.model ? " · #" + esc(l.model) : "")) + " · " +
        (l.price > 0 ? fmtMoney(l.price) : "Price TBD") + " / " + esc(l.unit) + "</div></div>" +
        '<div class="l-ext">' + (l.price > 0 ? fmtMoney(lineTotal(l)) : "—") + "</div>" +
        '<div class="l-controls"><div class="stepper"><button data-action="line-step" data-key="' + esc(l.key) + '" data-step="-1" aria-label="Decrease">−</button>' +
        '<input type="number" inputmode="decimal" min="0" step="any" value="' + esc(fmtQty(l.qty)) + '" data-line-qty="' + esc(l.key) + '" aria-label="Quantity">' +
        '<span class="u">' + esc(l.unit) + '</span><button data-action="line-step" data-key="' + esc(l.key) + '" data-step="1" aria-label="Increase">+</button></div>' +
        '<button class="link-btn" data-action="line-remove" data-key="' + esc(l.key) + '">Remove</button></div></div>';
    });
    h += '<div class="totals"><span>Estimated total</span><span id="order-total">' + fmtMoney(orderTotal(o)) + "</span></div>";
    if (o.lines.some(function (l) { return !(l.price > 0); })) h += '<div class="notice">Some items have no listed price and are not included in the total.</div>';
    h += '<div class="btn-row" style="margin-top:10px"><button class="btn" data-action="to-build">' + ICON.plus + 'Add more materials</button>' +
      '<button class="btn" data-action="custom-item">Add unlisted item</button></div></div>';

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
    var ready = !!o.number;
    var canSharePdf = !!(navigator.canShare && window.File && navigator.canShare({ files: [new File([""], "x.pdf", { type: "application/pdf" })] }));
    var h = topbar(o.number ? "Order " + o.number : "New order (# pending)", "Job " + o.jobNumber + " · " + o.supplier, backBtn(editable ? "to-review" : "history", "Back"), syncPill());
    h += '<main class="page">';
    h += '<div class="card done-card"><div class="done-icon">' + (o.status === "sent" ? "✓" : "➜") + '</div><h2 style="margin-top:0">' +
      (o.status === "sent" ? "Order sent" : "Order ready to send") + "</h2>" +
      '<div class="hint">' + o.lines.length + " item" + (o.lines.length === 1 ? "" : "s") + " · " + (o.showPricing ? "Est. " + fmtMoney(orderTotal(o)) : "pricing hidden") + "</div>" +
      '<label class="toggle" style="justify-content:center"><input type="checkbox" id="send-pricing"' + (o.showPricing ? " checked" : "") + ">Include listed pricing</label></div>";
    if (!ready) {
      h += '<div class="notice">This order gets its number (' + esc(o.jobNumber) + "-00#) as soon as the phone is back online. Sending is available after that.</div>";
    }
    h += '<div class="tile-list' + (ready ? "" : " disabled") + '">' +
      (canSharePdf ? sendTile("share-pdf", "Send PDF (email / text)", "Kim Industries PDF, attached with any app") : "") +
      sendTile("email", "Email to supplier", emailFor(o.supplier) ? "To " + emailFor(o.supplier) + " · order in the email body" : "Opens your email app · order in the email body") +
      sendTile("pdf", "Download PDF", "Kim Industries purchase order") +
      sendTile("print", "Print", "Printable purchase order") +
      (navigator.share ? sendTile("share", "Share as text", "Send with any app on this phone") : "") +
      sendTile("copy", "Copy order text", "Paste into a text or email") +
      sendTile("csv", "Download spreadsheet (CSV)", "Opens in Excel") +
      "</div>";
    h += '<h3>Preview</h3><div class="card preview-card"><div class="po-preview">' + printHtml(o) + "</div></div>";
    h += '<div class="btn-row" style="margin:16px 0 40px">' +
      (o.status === "sent" ? '<button class="btn" data-action="reopen">Edit order</button>' : '<button class="btn brand" data-action="mark-sent"' + (ready ? "" : " disabled") + ">Mark as sent</button>") +
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
    o.lines.forEach(function (l, i) {
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
    o.lines.forEach(function (l, i) {
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
    o.lines.forEach(function (l, i) {
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
      var body = o.lines.map(function (l, i) {
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
        if (o.lines.some(function (l) { return !(l.price > 0); })) {
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
        err.textContent = !navigator.onLine ? "No internet connection. Connect and try again."
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
      h += '<div class="card"><div class="t-sub" style="color:var(--muted)">Signed in as</div><div style="font-weight:700;margin-bottom:10px">' + esc(Cloud.user.email) + "</div>" +
        '<button type="button" class="btn" data-action="sign-out">Sign out</button></div>';
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
