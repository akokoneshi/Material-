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
  function putOrder(order) {
    order.updatedAt = new Date().toISOString();
    var list = getOrders(), found = false;
    for (var i = 0; i < list.length; i++) if (list[i].id === order.id) { list[i] = order; found = true; }
    if (!found) list.unshift(order);
    saveOrders(list);
  }
  function deleteOrder(id) { saveOrders(getOrders().filter(function (o) { return o.id !== id; })); }
  function settings() { return store.get("settings", { name: "", phone: "", supplierEmails: {} }); }

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
    var orders = getOrders();
    var drafts = orders.filter(function (o) { return o.status === "draft"; });
    var h = topbar("Material Orders", "Field ordering",
      '<span style="width:8px"></span>',
      '<button class="icon-btn" data-action="settings" aria-label="Settings">' + ICON.gear + "</button>");
    h += '<main class="page">';
    h += '<div class="home-actions">' +
      '<button class="btn primary big block" data-action="new-order">' + ICON.plus + "New Material Order</button>" +
      '<div class="btn-row">' +
      '<button class="btn" data-action="lookup">' + ICON.tag + "Price Lookup</button>" +
      '<button class="btn" data-action="history">' + ICON.list + "Order History</button>" +
      "</div></div>";
    if (drafts.length) {
      h += "<h3>Continue a draft</h3><div class=\"tile-list\">";
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
      '<div class="t-sub">' + esc(o.number) + " · " + esc(fmtDate(o.updatedAt)) + "</div>" +
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
    var recent = store.get("recentJobs", []);
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
      number: newOrderNumber(jobNumber),
      status: "draft",
      supplier: supplier,
      jobNumber: jobNumber,
      jobName: jobName,
      requestedBy: s.name || "",
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
    h += '<div class="card"><dl class="kv"><dt>Order #</dt><dd>' + esc(o.number) + "</dd><dt>Supplier</dt><dd>" + esc(o.supplier) +
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
    var h = topbar("Order " + o.number, "Job " + o.jobNumber + " · " + o.supplier, backBtn(editable ? "to-review" : "history", "Back"));
    h += '<main class="page">';
    h += '<div class="card" style="text-align:center"><div style="font-size:40px">✅</div><h2 style="margin-top:0">' +
      (o.status === "sent" ? "Order sent" : "Order ready to send") + "</h2>" +
      '<div class="hint">' + o.lines.length + " items · " + (o.showPricing ? "Est. " + fmtMoney(orderTotal(o)) : "pricing hidden") + "</div>" +
      '<label class="toggle" style="justify-content:center"><input type="checkbox" id="send-pricing"' + (o.showPricing ? " checked" : "") + ">Include listed pricing</label></div>";
    h += '<div class="tile-list">' +
      sendTile("email", "Email to supplier", emailFor(o.supplier) ? "To " + emailFor(o.supplier) : "Opens your email app") +
      (navigator.share ? sendTile("share", "Share / Text", "Send with any app on this phone") : "") +
      sendTile("print", "Print or save as PDF", "Printable purchase order") +
      sendTile("copy", "Copy order text", "Paste into a text or email") +
      sendTile("csv", "Download spreadsheet (CSV)", "Opens in Excel") +
      "</div>";
    h += '<h3>Preview</h3><div class="card" style="overflow:auto"><pre style="white-space:pre-wrap;margin:0;font-size:13px">' + esc(orderText(o)) + "</pre></div>";
    h += '<div class="btn-row" style="margin:16px 0 40px">' +
      (o.status === "sent" ? '<button class="btn" data-action="reopen">Edit order</button>' : '<button class="btn brand" data-action="mark-sent">Mark as sent</button>') +
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
  function emailFor(supplier) { return (settings().supplierEmails || {})[supplier] || ""; }

  function orderText(o) {
    var p = o.showPricing;
    var t = "MATERIAL ORDER " + o.number + "\n" +
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

  function printHtml(o) {
    var p = o.showPricing;
    var h = '<div class="po"><div class="po-head"><div><h1>Material Order</h1><div>Order # <b>' + esc(o.number) + "</b></div><div>Date: " + esc(fmtDate(o.createdAt)) + "</div></div>" +
      "<div><div><b>Supplier:</b> " + esc(o.supplier) + "</div><div><b>Job #:</b> " + esc(o.jobNumber) + "</div>" +
      (o.jobName ? "<div><b>Job name:</b> " + esc(o.jobName) + "</div>" : "") +
      (o.requestedBy ? "<div><b>Requested by:</b> " + esc(o.requestedBy) + (o.phone ? " · " + esc(o.phone) : "") + "</div>" : "") +
      (o.needBy ? "<div><b>Needed by:</b> " + esc(fmtDate(o.needBy)) + "</div>" : "") +
      "<div><b>Delivery:</b> " + (o.delivery === "pickup" ? "Will call / pickup" : "Deliver to job" + (o.deliverTo ? " - " + esc(o.deliverTo) : "")) + "</div></div></div>" +
      "<table><thead><tr><th>#</th><th class=\"num\">Qty</th><th>Unit</th><th>Description</th><th>Model #</th>" + (p ? '<th class="num">Unit Price</th><th class="num">Ext</th>' : "") + "</tr></thead><tbody>";
    o.lines.forEach(function (l, i) {
      h += "<tr><td>" + (i + 1) + '</td><td class="num">' + esc(fmtQty(l.qty)) + "</td><td>" + esc(l.unit) + "</td><td>" + esc(l.name) + "</td><td>" + esc(l.model || "") + "</td>" +
        (p ? '<td class="num">' + (l.price > 0 ? fmtMoney(l.price) : "TBD") + '</td><td class="num">' + (l.price > 0 ? fmtMoney(lineTotal(l)) : "") + "</td>" : "") + "</tr>";
    });
    h += "</tbody></table>" + (p ? '<div class="po-total">Estimated total: ' + fmtMoney(orderTotal(o)) + "</div>" : "") +
      (o.notes ? '<div class="po-notes"><b>Notes:</b> ' + esc(o.notes) + "</div>" : "") +
      '<div class="sig"><div>Ordered by</div><div>Received by / date</div></div></div>';
    return h;
  }

  function doSend(kind) {
    var o = currentOrder();
    var subject = "Material Order " + o.number + " - Job " + o.jobNumber + (o.jobName ? " (" + o.jobName + ")" : "");
    var text = orderText(o);
    if (kind === "email") {
      location.href = "mailto:" + encodeURIComponent(emailFor(o.supplier)) + "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(text);
    } else if (kind === "share") {
      navigator.share({ title: subject, text: text }).catch(function () { /* cancelled */ });
    } else if (kind === "print") {
      document.getElementById("print-area").innerHTML = printHtml(o);
      window.print();
    } else if (kind === "copy") {
      copyText(text);
    } else if (kind === "csv") {
      var blob = new Blob([orderCsv(o)], { type: "text/csv" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "Material-Order_" + o.number.replace(/[^\w-]+/g, "_") + ".csv";
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    }
    if (o.status !== "sent") {
      o.status = "sent";
      o.sentAt = new Date().toISOString();
      putOrder(o);
      setTimeout(render, 300);
    }
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
    var orders = getOrders();
    var h = topbar("Order History", orders.length + " orders on this device", backBtn("home", "Home"));
    h += '<main class="page">';
    if (!orders.length) h += '<div class="empty">No orders yet.</div>';
    else {
      h += '<div class="tile-list">';
      orders.forEach(function (o) { h += orderTile(o); });
      h += "</div>";
    }
    h += "</main>";
    return h;
  };

  // ----- settings
  VIEWS.settings = function () {
    var s = settings();
    var h = topbar("Settings", "", backBtn("home", "Home"));
    h += '<main class="page"><form id="settings-form"><div class="card">' +
      '<label class="field"><span>Your name</span><input class="input" name="name" autocomplete="name" value="' + esc(s.name) + '"></label>' +
      '<label class="field" style="margin:0"><span>Your phone</span><input class="input" name="phone" type="tel" autocomplete="tel" value="' + esc(s.phone) + '"></label></div>' +
      '<h3>Supplier order emails</h3><div class="card"><p class="hint" style="margin-top:0">Optional. Used to pre-fill the "To" line when emailing an order.</p>';
    SUPPLIERS.forEach(function (sup) {
      h += '<label class="field"><span>' + esc(sup) + '</span><input class="input" type="email" data-sup="' + esc(sup) + '" value="' + esc((s.supplierEmails || {})[sup] || "") + '" placeholder="orders@example.com"></label>';
    });
    h += "</div></form><p class=\"hint\">Orders and settings are saved on this device only.</p></main>";
    return h;
  };
  AFTER.settings = function () {
    document.getElementById("settings-form").addEventListener("input", function (e) {
      var s = settings();
      s.supplierEmails = s.supplierEmails || {};
      if (e.target.name) s[e.target.name] = e.target.value;
      var sup = e.target.getAttribute("data-sup");
      if (sup) s.supplierEmails[sup] = e.target.value.trim();
      store.set("settings", s);
    });
  };

  // ---------------------------------------------------------------- actions
  var ACTIONS = {
    "home": function () { go("home"); },
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
      copy.number = newOrderNumber(copy.jobNumber);
      copy.status = "draft";
      copy.lines = lines;
      copy.needBy = "";
      copy.createdAt = new Date().toISOString();
      delete copy.sentAt;
      putOrder(copy);
      state.orderId = copy.id;
      toast("Copied as new draft " + copy.number);
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
  render();
  setTimeout(ensureIndex, 50);

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(function () { /* offline support unavailable */ });
  }
})();
