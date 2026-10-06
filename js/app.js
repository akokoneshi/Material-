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
  // Items an admin approved from price-list requests (catalog_items table), merged into the price list.
  // A row whose id is a regular price-list item's id (e.g. CT00585) is an admin's edit of that item.
  function addCatalogExtras(rows) {
    var added = [], seen = {};
    (rows || []).forEach(function (r) {
      var key = r.supplier + "|" + r.id;
      var ex = BY_KEY[key];
      seen[key] = 1;
      if (ex && !ex.jobOnly) {
        if (!ex.added && !ex.orig) ex.orig = { name: ex.name, unit: ex.unit, category: ex.category, price: ex.price, model: ex.model };
        ex.edited = !ex.added;
        ex.editedBy = r.created_by || ""; ex.editedAt = r.updated_at || r.created_at || "";
        ex.name = r.name; ex.unit = String(r.unit || "EA").toUpperCase(); ex.category = r.category || (ex.added ? "Added Items" : ex.category);
        ex.price = +r.price || 0; ex.model = r.model || "";
        if (indexed) S.buildIndex([ex]);
        if (typeof MATERIALS !== "undefined") { MATERIALS = null; MAT_BY_KEY = {}; }
        return;
      }
      if (ex || !BY_SUPPLIER[r.supplier]) return;
      var it = { idx: ITEMS.length, name: r.name, unit: String(r.unit || "EA").toUpperCase(), category: r.category || "Added Items",
        price: +r.price || 0, model: r.model || "", id: r.id, supplier: r.supplier, key: key, added: true };
      ITEMS.push(it);
      BY_KEY[key] = it;
      BY_SUPPLIER[r.supplier].push(it);
      added.push(it);
    });
    // An edit the admin reset: go back to the price-list values.
    ITEMS.forEach(function (it) {
      if (!it.edited || seen[it.key]) return;
      Object.keys(it.orig).forEach(function (k) { it[k] = it.orig[k]; });
      it.edited = false; it.orig = null;
      if (indexed) S.buildIndex([it]);
      if (typeof MATERIALS !== "undefined") { MATERIALS = null; MAT_BY_KEY = {}; }
    });
    if (added.length) {
      if (indexed) S.buildIndex(added);
      if (typeof MATERIALS !== "undefined") { MATERIALS = null; MAT_BY_KEY = {}; }
    }
    return added.length;
  }

  var indexed = false;
  function ensureIndex() {
    if (!indexed) {
      S.buildIndex(ITEMS.concat(Object.keys(BY_KEY).map(function (k) { return BY_KEY[k]; }).filter(function (it) { return it.jobOnly; })));
      indexed = true;
    }
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
  // Field users: create orders and look at shop stock, nothing else.
  function isField() { return Cloud.enabled && !!Cloud.user && access().role === "field"; }
  function canEditShop() { return Cloud.enabled && !!Cloud.user && !isField() && (access().role === "admin" || !!access().can_edit_shop) && !access().blocked; }

  // ----- jobs by division. Non-admins with divisions assigned only see / order on their divisions' jobs
  // (the database enforces the same rule). No divisions assigned, or no jobs uploaded yet = not limited.
  function getJobs() { return store.get("jobs", []); }
  var jobIdx = null;
  function jobsByKey() {
    if (!jobIdx) { jobIdx = {}; getJobs().forEach(function (j) { jobIdx[jobKey(j.job_number)] = j; }); }
    return jobIdx;
  }
  function setJobs(list) { store.set("jobs", list); jobIdx = null; }
  function refreshJobs() {
    if (!Cloud.enabled || !Cloud.user || !navigator.onLine) return Promise.resolve();
    return Cloud.listJobs().then(function (l) { setJobs(l); store.set("jobsSetupMissing", false); }, function (e) {
      if (/PGRST205|42P01|does not exist|schema cache/i.test((e && (e.code + " " + e.message)) || "")) store.set("jobsSetupMissing", true);
    });
  }
  function myDivisions() { return (access().divisions || []).map(String); }
  function jobsLimited() { return Cloud.enabled && !!Cloud.user && !isAdmin() && myDivisions().length > 0 && getJobs().length > 0; }
  function jobDivision(j) { var r = jobsByKey()[jobKey(j)]; return r ? String(r.division) : ""; }
  function canSeeJob(j) { return !jobsLimited() || myDivisions().indexOf(jobDivision(j)) >= 0; }
  function myJobs() { return getJobs().filter(function (j) { return j.active !== false && canSeeJob(j.job_number); }); }

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
  // ---------------------------------------------------------------- special (job) pricing
  // A job's price books override the regular price list for the items they contain.
  function jobKey(j) { return String(j || "").trim().toUpperCase(); }
  function getBooks() { return store.get("books", []); }
  // A book can cover several jobs: "3479, 3557, 3375".
  function bookJobs(b) { return String(b.job_number || "").split(",").map(jobKey).filter(Boolean); }
  var bookIdx = null;
  function bookIndex() {
    if (bookIdx) return bookIdx;
    bookIdx = {};
    // If an item is in more than one of a job's books, the lowest price wins.
    getBooks().filter(function (b) { return b.active; }).forEach(function (b) {
      bookJobs(b).forEach(function (jk) {
        var m = bookIdx[jk] = bookIdx[jk] || {};
        (b.items || []).forEach(function (it) {
          var cur = m[it.item_key];
          if (!cur || +it.price < cur.price) m[it.item_key] = { price: +it.price, book: b.name || (b.supplier + " job pricing"), bookId: b.id };
        });
      });
    });
    return bookIdx;
  }
  function setBooks(b) { store.set("books", b); bookIdx = null; registerJobItems(); }

  // Quote lines in a job's books that aren't in the regular price list (e.g. Foamglas from a vendor quote).
  // They become items that can be ordered only on that job, from that supplier, at the quoted price.
  function jobItemCategory(name) {
    var n = String(name).toLowerCase();
    var g = /foamglas|cellglas|cellular glass/.test(n) ? "Foamglas / Cellular Glass"
      : /fiberglass|fbg|\bfg\b|fipc|ultra jm/.test(n) ? "Fiberglass"
      : /saddle|shield|tps/.test(n) ? "Saddles & Shields"
      : /\bpvc\b|zeston|proto/.test(n) ? "PVC Jacketing & Fittings"
      : /alum|weatherjac|ell-jac|jacket|c&r|c\/r/.test(n) ? "Aluminum Jacketing & Fittings"
      : /armaflex|aeroflex|aerocel|ilock|insul-lock|kflex|kfit|rubatex|elastomeric/.test(n) ? "Elastomeric"
      : /board|wrap|blanket|blkt|thermax|polyiso|iso\b|microflex|microlite/.test(n) ? "Board & Wrap"
      : /tape|mastic|adhesive|adh\b|cp-?3|chil|polyg|rg2400|pittwrap/.test(n) ? "Tapes, Mastics & Adhesives"
      : /pin|staple|screw|wire|seal|band|strap/.test(n) ? "Fasteners & Banding" : "Other";
    return "Job Quote Items > " + g;
  }
  function registerJobItems() {
    var added = [];
    Object.keys(BY_KEY).forEach(function (k) { if (BY_KEY[k].jobOnly) BY_KEY[k].jobs = {}; });
    getBooks().filter(function (b) { return b.active; }).forEach(function (b) {
      (b.items || []).forEach(function (x) {
        var it = BY_KEY[x.item_key];
        if (it && !it.jobOnly) return;
        if (!it) {
          var id = String(x.item_key).split("|").slice(1).join("|");
          it = { idx: -1, key: x.item_key, id: id, supplier: b.supplier, name: x.item_name || id, unit: String(x.unit || "EA").toUpperCase(),
            category: jobItemCategory(x.item_name), price: +x.price || 0,
            // Show the vendor's code as the part #, but not keys built from a description (e.g. Q-HAMFAB-TYPE-1000-...).
            model: /^Q-[A-Z0-9.\/]+$/.test(id) ? id.slice(2) : "", jobOnly: true, jobs: {} };
          BY_KEY[it.key] = it;
          added.push(it);
        }
        bookJobs(b).forEach(function (jk) { it.jobs[jk] = 1; });
        if (+x.price < it.price || !it.price) it.price = +x.price || 0;
      });
    });
    if (added.length && indexed) S.buildIndex(added);
  }
  function jobItems(job, supplier) {
    var jk = jobKey(job), out = [];
    Object.keys(BY_KEY).forEach(function (k) { var it = BY_KEY[k]; if (it.jobOnly && it.supplier === supplier && it.jobs[jk]) out.push(it); });
    return out;
  }
  function refreshBooks() {
    if (!Cloud.enabled || !Cloud.user || !navigator.onLine) return Promise.resolve();
    return Cloud.listBooks().then(function (b) { setBooks(b); store.set("booksSetupMissing", false); }, function (e) {
      if (e && e.setupMissing) store.set("booksSetupMissing", true);
    });
  }
  function specialFor(job, itemKey) { var m = bookIndex()[jobKey(job)]; return (m && m[itemKey]) || null; }
  function jobHasBooks(job, supplier) {
    var k = jobKey(job);
    return getBooks().some(function (b) { return b.active && bookJobs(b).indexOf(k) >= 0 && (!supplier || b.supplier === supplier); });
  }
  // Effective price for an item on an order: job price if one of the job's books has it, else the regular price.
  function priceFor(o, it) {
    var sp = o ? specialFor(o.jobNumber, it.key) : null;
    return sp ? { price: sp.price, special: true, book: sp.book, regular: it.price } : { price: it.price, special: false, regular: it.price };
  }
  // Keep draft orders on current pricing (e.g. a job book was added after the draft was started).
  function repriceOrder(o) {
    if (!o || o.status !== "draft") return false;
    var changed = false;
    o.lines.forEach(function (l) {
      if (isShop(l) || l.custom) return;
      var it = BY_KEY[l.itemKey || l.key];
      if (!it) return;
      var p = priceFor(o, it);
      if (l.price !== p.price || !!l.special !== p.special) {
        l.price = p.price;
        l.special = p.special;
        l.book = p.special ? p.book : undefined;
        changed = true;
      }
    });
    if (changed) putOrder(o);
    return changed;
  }
  // Field users never see prices; their orders go out without pricing.
  function hidePrices() { return isField(); }
  function jobPriceHtml(p, unit) {
    if (hidePrices()) return '<span class="unit">' + esc(unit) + "</span>";
    return p.special
      ? '<span class="job-price">Job price</span> ' + fmtMoney(p.price) + ' <span class="unit">/ ' + esc(unit) + "</span>" +
        (p.regular > 0 && p.regular !== p.price ? ' <s class="reg">' + fmtMoney(p.regular) + "</s>" : "")
      : priceHtml(p.price, unit);
  }

  function sendCatalogRequests() {
    var q = store.get("pendingCatalogRequests", []);
    if (!q.length || !Cloud.enabled || !Cloud.user || !navigator.onLine) return Promise.resolve();
    var chain = Promise.resolve();
    q.forEach(function (r) {
      chain = chain.then(function () {
        return Cloud.submitCatalogRequest(r).then(function () {
          store.set("pendingCatalogRequests", store.get("pendingCatalogRequests", []).filter(function (x) { return x !== r && JSON.stringify(x) !== JSON.stringify(r); }));
        });
      });
    });
    return chain.catch(function () { /* table missing or offline: keep queued */ });
  }
  function refreshCatalog() {
    if (!Cloud.enabled || !Cloud.user || !navigator.onLine) return Promise.resolve();
    return Promise.all([
      Cloud.listCatalogItems().then(function (rows) { store.set("catalogExtra", rows); addCatalogExtras(rows); }, function () { /* keep cached */ }),
      isAdmin() ? Cloud.listCatalogRequests().then(function (rows) { store.set("catalogRequests", rows); }, function () { /* keep cached */ }) : null
    ]);
  }
  function pendingCatalogRequests() { return store.get("catalogRequests", []).filter(function (r) { return r.status === "pending"; }); }

  function refreshAccess() {
    if (!Cloud.enabled || !Cloud.user || !navigator.onLine) return Promise.resolve();
    var before = JSON.stringify(access());
    return Cloud.getMyAccess().then(function (a) {
      store.set("access", a);
      if (JSON.stringify(a) !== before) render();
    }, function () { /* keep cached */ });
  }
  function setupBanner() {
    return Cloud.enabled && access().setupMissing
      ? '<div class="notice"><b>Database setup not finished.</b> Shop stock and admin features need <code>supabase/shop.sql</code> to be run once in Supabase (SQL Editor → New query → paste → Run). Then reopen this screen.</div>'
      : "";
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
        // Permissions first: what else we load depends on them (admin / invoice reviewer).
        return Cloud.getMyAccess().then(function (a) { store.set("access", a); }, function () { /* keep cached */ }).then(function () { return Promise.all([
          Cloud.getSupplierEmails().then(function (m) { store.set("supplierEmails", m); }, function () { /* keep cached */ }),
          refreshStock(),
          refreshJobs(),
          refreshBooks(),
          refreshInvoices().then(autoRetryInvoices),
          sendCatalogRequests().then(refreshCatalog)
        ]); });
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
        if (state.view === "home" || state.view === "history" || state.view === "shop" || state.view === "pricing" || state.view === "pricing-job" || state.view === "book" || state.view === "invoices" || state.view === "catalog-requests" || state.view === "jobs") render();
        else if ((state.view === "build" || state.view === "review") && repriceOrder(currentOrder())) render();
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
    if (hidePrices()) return '<span class="unit">' + esc(unit) + "</span>";
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
      (isField() ? "" : '<button class="btn" data-action="lookup">' + ICON.tag + "Price Lookup</button>") +
      '<button class="btn" data-action="history">' + ICON.list + "Order History</button>" +
      (Cloud.enabled ? '<button class="btn" data-action="shop">' + ICON_SHOP + "Shop Stock</button>" : "") +
      (isAdmin() ? '<button class="btn" data-action="users">' + ICON.gear + "Users</button>" : "") +
      (isAdmin() ? '<button class="btn" data-action="jobs">' + ICON.list + "Jobs &amp; Divisions</button>" : "") +
      (isAdmin() ? '<button class="btn" data-action="pricing">' + ICON.tag + "Special Pricing</button>" : "") +
      (isAdmin() ? '<button class="btn" data-action="catalog-requests">' + ICON.tag + "Price-list Requests" + (pendingCatalogRequests().length ? " (" + pendingCatalogRequests().length + ")" : "") + "</button>" + '<button class="btn" data-action="edit-products">' + ICON.tag + "Edit Products</button>" : "") +
      (canReviewInvoices() ? '<button class="btn" data-action="invoices">' + ICON.list + "Invoice Approval</button>" : "") +
      "</div></div>";
    if (access().blocked) h += '<div class="notice">Your access has been turned off. Contact the office.</div>';
    if (jobsLimited()) h += '<p class="hint" style="margin:0 0 10px">' + (isField() ? "Field view · " : "") + "Division" + (myDivisions().length === 1 ? " " : "s ") + esc(myDivisions().join(", ")) + "</p>";
    else if (isField()) h += '<p class="hint" style="margin:0 0 10px">Field view</p>';
    h += setupBanner();
    var pulls = canEditShop() ? pendingPulls() : [];
    var catPending = isAdmin() ? pendingCatalogRequests().length : 0;
    if (catPending) h += '<button class="tile pull-alert" data-action="catalog-requests"><div class="t-main"><div class="t-title">' + ICON.tag + catPending + " price-list request" + (catPending === 1 ? "" : "s") + ' to review</div><div class="t-sub">Items the crew asked to add to the price list</div></div><span class="chev">›</span></button>';
    var invAttn = canReviewInvoices() ? getInvoices().filter(function (i) { return i.status === "mismatch" || i.status === "no_order" || i.status === "error"; }).length : 0;
    if (invAttn) h += '<button class="tile pull-alert" data-action="invoices"><div class="t-main"><div class="t-title">' + invAttn + " invoice" + (invAttn === 1 ? "" : "s") + ' need review</div><div class="t-sub">Pricing doesn\'t match the order, or no order was found</div></div><span class="chev">›</span></button>';
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
      '<div class="t-sub">' + esc(o.supplier) + " · " + n + " item" + (n === 1 ? "" : "s") + (hidePrices() ? "" : " · " + fmtMoney(orderTotal(o))) + "</div>" +
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
    var recent = recentJobs().filter(function (j) { return canSeeJob(j.jobNumber); });
    var h = topbar("New Material Order", "Step 2 of 2 · " + d.supplier, backBtn("to-supplier"));
    h += '<main class="page"><div class="step">Step 2 of 2</div><h2>Enter the job number</h2>' +
      '<p class="hint">Ordering from <b>' + esc(d.supplier) + '</b>. <button class="link-btn" style="color:var(--focus);min-height:0;padding:0" data-action="to-supplier">Change</button></p>' +
      '<form id="job-form" novalidate>' +
      '<label class="field"><span>Job number <span class="req">*</span></span>' +
      '<input class="input huge" id="job-number" name="jobNumber" autocomplete="off" autocapitalize="characters" enterkeyhint="next" required value="' + esc(d.jobNumber || "") + '" placeholder="e.g. 24-118">' +
      '<div class="error-text" id="job-error" hidden>Job number is required.</div></label>' +
      (getJobs().length ? '<div id="job-suggest" class="job-suggest"></div>' : "") +
      (jobsLimited() ? '<p class="hint" style="margin:-4px 0 10px">You can order for Division' + (myDivisions().length === 1 ? " " : "s ") + esc(myDivisions().join(", ")) + " jobs.</p>" : "");
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
    var input = document.getElementById("job-number"), nameIn = document.getElementById("job-name"), err = document.getElementById("job-error");
    var box = document.getElementById("job-suggest");
    if (!input.value) input.focus();
    // Jobs from the jobs list (your divisions only), matching what's typed.
    function suggest() {
      if (!box) return;
      var q = jobKey(input.value), mine = myJobs();
      var hits = mine.filter(function (j) { return !q || j.job_number.indexOf(q) >= 0 || String(j.job_name || "").toUpperCase().indexOf(q) >= 0; })
        .sort(function (a, b) { return (b.job_number.indexOf(q) === 0) - (a.job_number.indexOf(q) === 0) || a.job_number.localeCompare(b.job_number, undefined, { numeric: true }); });
      if (q && hits.length === 1 && hits[0].job_number === q) { box.innerHTML = ""; return; }
      box.innerHTML = hits.length ? '<div class="hint" style="margin:0 0 6px">' + (q ? "Matching jobs" : jobsLimited() ? "Your jobs" : "Jobs") + "</div>" +
        hits.slice(0, 8).map(function (j) {
          return '<button type="button" class="tile job-pick" data-action="pick-job" data-job="' + esc(j.job_number) + '" data-name="' + esc(j.job_name || "") + '"><div class="t-main"><div class="t-title">' +
            esc(j.job_number) + (j.job_name ? " · " + esc(j.job_name) : "") + '</div><div class="t-sub">Division ' + esc(j.division) + "</div></div></button>";
        }).join("") + (hits.length > 8 ? '<div class="hint">' + (hits.length - 8) + " more - keep typing</div>" : "")
        : (q && jobsLimited() ? '<div class="hint">No job ' + esc(q) + " in your division" + (myDivisions().length === 1 ? "" : "s") + ".</div>" : "");
    }
    suggest();
    document.getElementById("job-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var num = input.value.trim();
      function bad(msg) { input.classList.add("invalid"); err.textContent = msg; err.hidden = false; input.focus(); }
      if (!num) return bad("Job number is required.");
      var known = jobsByKey()[jobKey(num)];
      if (jobsLimited() && !canSeeJob(num)) {
        return bad(known ? "Job " + known.job_number + " is in Division " + known.division + ", not yours. Ask an admin if you need it."
          : "Job " + jobKey(num) + " isn't in the jobs list for your division" + (myDivisions().length === 1 ? "" : "s") + ". Ask an admin to add it.");
      }
      if (known) num = known.job_number;
      createOrder(state.draft.supplier, num, nameIn.value.trim() || (known && known.job_name) || "");
    });
    input.addEventListener("input", function () {
      input.classList.remove("invalid");
      err.hidden = true;
      var known = jobsByKey()[jobKey(input.value)];
      if (known && known.job_name && !nameIn.value.trim()) nameIn.value = known.job_name;
      suggest();
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
      showPricing: !hidePrices(),
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
    toast(jobHasBooks(jobNumber, supplier) ? "Job " + jobNumber + ": special pricing applied" : "Order started for Job " + jobNumber);
  }

  // ----- build (search / browse) and lookup share this
  function scopeItems() {
    if (state.view === "shop-add") { var m = materials(); if (!m._indexed) { S.buildIndex(m); m._indexed = true; } return m; }
    if (state.view === "lookup") return state.lookupSupplier ? BY_SUPPLIER[state.lookupSupplier] : ITEMS;
    if (state.view === "book-add") { var bk = currentBook(); return bk ? BY_SUPPLIER[bk.supplier] || [] : []; }
    var o = currentOrder();
    if (!o) return [];
    var extra = jobItems(o.jobNumber, o.supplier);
    return extra.length ? (BY_SUPPLIER[o.supplier] || []).concat(extra) : BY_SUPPLIER[o.supplier] || [];
  }

  VIEWS.build = function () {
    var o = currentOrder();
    if (!o) return VIEWS.home();
    repriceOrder(o);
    o = currentOrder();
    var h = topbar("Job " + o.jobNumber, o.supplier + (o.jobName ? " · " + o.jobName : ""),
      backBtn("home", "Home"),
      '<button class="icon-btn" data-action="review" aria-label="Review order">Review</button>');
    h += '<main class="page has-cartbar">' +
      (jobHasBooks(o.jobNumber, o.supplier) ? '<div class="job-pricing-note"><span class="job-price">Job pricing</span> Special prices for Job ' + esc(o.jobNumber) + " are applied automatically.</div>" : "") +
      finderHtml() + "</main>";
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
      "</select></label>" + (state.view === "lookup" && isAdmin() ? editedProductsHtml() : "") + finderHtml() + "</main>";
    return h;
  };
  // Admins: products edited away from the price-list file, one tap from Price Lookup.
  function editedProductsHtml() {
    var ed = ITEMS.filter(function (it) { return it.edited; });
    return '<p class="hint" style="margin:0 0 6px">Admin: tap any product, then <b>Edit product</b> to change its name, part #, unit, price or category.</p>' +
      (ed.length ? '<details class="card" style="padding:10px 14px;margin-bottom:8px"><summary><b>' + ed.length + " edited product" + (ed.length === 1 ? "" : "s") + "</b></summary>" +
        ed.map(function (it) {
          return '<button class="tile" style="margin-top:6px" data-action="catalog-edit" data-key="' + esc(it.key) + '"><div class="t-main"><div class="t-title">' + esc(it.name) + "</div>" +
            '<div class="t-sub">' + esc(it.supplier) + " · " + (it.price > 0 ? fmtMoney(it.price) : "TBD") + " / " + esc(it.unit) + " (was " + (it.orig.price > 0 ? fmtMoney(it.orig.price) : "TBD") + ")</div></div></button>";
        }).join("") + "</details>" : "");
  }
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
        '</div><div class="hint">Or switch to <b>Browse by Category</b> to pick from lists.</div></div>' + manualAddHtml("");
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
        "</div>";
    }
    h += resultsHtml(res.results) + manualAddHtml(q);
    box.innerHTML = h;
  }

  // Orders only: add something that isn't in the price list.
  function manualAddHtml(q) {
    if (state.view !== "build") return "";
    return '<button class="tile manual-add" data-action="custom-item" data-q="' + esc(q || "") + '">' + ICON.plus +
      '<div class="t-main"><div class="t-title">Can\'t find it? Add it manually</div><div class="t-sub">' +
      (q ? "Add \u201c" + esc(q) + "\u201d as an item not in the price list" : "Type the item name yourself; price can be left blank") + "</div></div></button>";
  }

  function resultsHtml(list) {
    var o = state.view === "build" ? currentOrder() : null;
    var inOrder = {};
    if (o) o.lines.forEach(function (l) { var k = l.itemKey || l.key; if (k && !inOrder[k]) inOrder[k] = l; });
    var showSup = state.view === "lookup";
    // Price context: the order being built, or the price book being edited.
    var priceCtx = o || (state.view === "book-add" && currentBook() ? { jobNumber: currentBook().job_number } : null);
    var priceForCtx = function (it) { return priceFor(priceCtx, it); };
    var adding = state.view === "shop-add";
    var h = '<ul class="results">';
    list.slice(0, state.shown).forEach(function (it) {
      var line = inOrder[it.key];
      h += '<li class="result' + (line ? " in-order" : "") + '">' +
        '<button class="r-main" data-action="item" data-key="' + esc(it.key) + '">' +
        '<div class="r-name">' + esc(it.name) + "</div>" +
        '<div class="r-sub">' + (showSup ? '<span class="sup-tag">' + esc(it.supplier) + "</span> · " : "") + esc(it.category) + (it.model ? " · #" + esc(it.model) : "") + "</div>" +
        (it.material ? '<div class="r-sub">Sold by the ' + esc(it.unit) + (it.count > 1 ? " · " + it.count + " price-list items" : "") + "</div>"
          : '<div class="r-price">' + (priceCtx ? jobPriceHtml(priceForCtx(it), it.unit) : priceHtml(it.price, it.unit)) + "</div>") + shopBadge(it) + "</button>";
      if (adding) {
        h += '<button class="r-add" data-action="item" data-key="' + esc(it.key) + '" aria-label="Add to shop stock"><span class="plus">+</span><small>Stock</small></button>';
      } else if (state.view === "book-add") {
        h += '<button class="r-add" data-action="item" data-key="' + esc(it.key) + '" aria-label="Set job price"><span class="plus">$</span><small>Price</small></button>';
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
      h += "</div>" + manualAddHtml("");
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
      (items.length ? resultsHtml(items) : '<div class="empty">No items match these filters.</div>') + manualAddHtml("");
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
      '<div class="c-total">' + (o.lines.length ? (hidePrices() ? "Tap Review when you're done" : "Est. " + fmtMoney(orderTotal(o))) : "Search or browse to add materials") + "</div></div>" +
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
        (it.edited ? '<p class="hint">Edited by an admin. Price list had ' + (it.orig.price > 0 ? fmtMoney(it.orig.price) : "TBD") + " / " + esc(it.orig.unit) + ".</p>" : "") +
        '<div class="btn-row" style="margin-top:18px"><button class="btn" data-action="close-sheet">Close</button>' +
        (isAdmin() && !it.jobOnly ? '<button class="btn" data-action="catalog-edit" data-key="' + esc(it.key) + '">Edit product</button>' : "") +
        '<button class="btn primary" data-action="order-from-lookup" data-supplier="' + esc(it.supplier) + '">Start order with ' + esc(it.supplier) + "</button></div>");
      return;
    }
    if (state.view === "shop-add") { openStockSheet(itemRef(it)); return; }
    if (state.view === "book-add") { openBookPriceSheet(currentBook(), it); return; }
    var o = currentOrder();
    var existing = o.lines.filter(function (l) { return l.key === key; })[0];
    var sameCount = o.lines.filter(function (l) { return (l.itemKey || l.key) === key && !isShop(l); }).length;
    // Required check: if we have this material in a shop, the crew must choose shop or supplier first.
    var matches = shopMatches(it);
    if (matches.length && !existing) { openShopCheckSheet(it, matches); return; }
    openSupplierQty(it, existing, false, sameCount);
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

  function openSupplierQty(it, existing, checkedShop, sameCount) {
    var key = it.key;
    var qty = existing ? existing.qty : "";
    var p = priceFor(currentOrder(), it);
    // The same product can go on the order more than once (e.g. separate releases/areas): extra lines get
    // their own key (item#2, item#3...) and point back at the product with itemKey.
    function addSeparate(q) {
      var ord = currentOrder(), pp = priceFor(ord, it), n = 2;
      while (ord.lines.some(function (x) { return x.key === key + "#" + n; })) n++;
      ord.lines.push({ key: key + "#" + n, itemKey: key, id: it.id, name: it.name, unit: it.unit, price: pp.price, special: pp.special,
        book: pp.special ? pp.book : undefined, model: it.model, category: it.category, qty: q, shopChecked: true });
      putOrder(ord);
      toast("Added as a separate line: " + fmtQty(q) + " " + it.unit);
    }
    openQtySheet({
      title: it.name,
      sub: it.category + (it.model ? " · #" + it.model : "") + (sameCount > 1 ? " · on this order " + sameCount + " times" : ""),
      extraLabel: existing ? "Add as separate line" : "", onExtra: addSeparate, extraFresh: true,
      note: p.special ? "Job price " + fmtMoney(p.price) + " / " + it.unit + (p.regular > 0 ? "  (regular " + fmtMoney(p.regular) + ")" : "") : "",
      price: p.price, unit: it.unit, qty: qty, existing: !!existing,
      onSave: function (q) {
        var ord = currentOrder();
        var pp = priceFor(ord, it);
        var l = ord.lines.filter(function (x) { return x.key === key; })[0];
        if (l) l.qty = q;
        else ord.lines.push({ key: key, id: it.id, name: it.name, unit: it.unit, price: pp.price, special: pp.special, book: pp.special ? pp.book : undefined,
          model: it.model, category: it.category, qty: q, shopChecked: !!checkedShop });
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
      (hidePrices() ? "" : '<div style="font-weight:700">' + (opt.note ? esc(opt.note) : opt.price > 0 ? fmtMoney(opt.price) + " / " + esc(opt.unit) : "Price TBD / " + esc(opt.unit)) + "</div>") +
      '<div class="big-stepper"><button type="button" data-step="-1" aria-label="Decrease">−</button>' +
      '<input id="qty" type="number" inputmode="decimal" min="0" step="any" value="' + esc(opt.qty) + '" placeholder="0" aria-label="Quantity">' +
      '<button type="button" data-step="1" aria-label="Increase">+</button></div>' +
      '<div class="unit-label">' + esc(opt.unit) + '</div>' +
      '<div class="chips quick">' + quick.map(function (n) { return '<button type="button" class="chip" data-add="' + n + '">+' + n + "</button>"; }).join("") + "</div>" +
      '<div class="line-total" id="line-total"></div>' +
      '<div class="btn-row">' + (opt.existing ? '<button class="btn danger" id="qty-remove">Remove</button>' : '<button class="btn" data-action="close-sheet">Cancel</button>') +
      '<button class="btn primary" id="qty-save">' + (opt.saveLabel || (opt.existing ? "Update" : "Add to Order")) + "</button></div>" +
      (opt.extraLabel ? '<button class="btn block" id="qty-extra" style="margin-top:10px">' + ICON.plus + esc(opt.extraLabel) + "</button>" +
        '<p class="hint" style="margin:6px 0 0">Adds this quantity as its own line (e.g. a different area or release); the line above stays as is.</p>' : "");
    openSheet(h, function (sheet) {
      var input = sheet.querySelector("#qty");
      function upd() {
        var q = parseFloat(input.value) || 0;
        sheet.querySelector("#line-total").innerHTML = q > 0 && opt.price > 0 && !hidePrices() ? "Line total: <b>" + fmtMoney(round2(q * opt.price)) + "</b>" : "&nbsp;";
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
      var ex = sheet.querySelector("#qty-extra");
      if (ex) ex.addEventListener("click", function () {
        var q = parseFloat(input.value);
        if (!(q > 0)) { input.focus(); toast("Enter a quantity"); return; }
        opt.onExtra(+q.toFixed(3));
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

  function openCustomSheet(prefill) {
    var h = "<h2>Add an item that isn't in the price list</h2>" +
      '<p class="hint" style="margin-top:-6px">Type what you need.' + (hidePrices() ? "" : " Price can be left blank; the supplier will price it.") + '</p><form id="custom-form">' +
      '<label class="field"><span>Item name / description <span class="req">*</span></span><input class="input" id="c-name" required value="' + esc(prefill || "") + '" placeholder=\'e.g. 3" x 1" fiberglass pipe, special order\'></label>' +
      '<label class="field"><span>Part # <small style="font-weight:500;color:var(--muted)">(optional)</small></span><input class="input" id="c-part" autocomplete="off" placeholder="Supplier part / item number, if you know it"></label>' +
      '<div class="filters"><label class="field"><span>Quantity <span class="req">*</span></span><input class="input" id="c-qty" type="number" inputmode="decimal" min="0" step="any"></label>' +
      '<label class="field"><span>Unit</span><select class="input" id="c-unit">' + ["EA", "LF", "FT", "SF", "RL", "BX", "PK", "GAL", "SET"].map(function (u) { return "<option>" + u + "</option>"; }).join("") + "</select></label>" +
      '<label class="field full"' + (hidePrices() ? " hidden" : "") + '><span>Price per unit <small style="font-weight:500;color:var(--muted)">(optional)</small></span><input class="input" id="c-price" type="number" inputmode="decimal" min="0" step="any" placeholder="Leave blank if unknown"></label></div>' +
      (Cloud.enabled ? '<label class="toggle request-toggle"><input type="checkbox" id="c-request"><span>Ask to add this to the price list<small>An admin reviews it before it\'s added for everyone.</small></span></label>' : "") +
      '<div class="btn-row"><button type="button" class="btn" data-action="close-sheet">Cancel</button><button class="btn primary" type="submit">Add to Order</button></div></form>';
    openSheet(h, function (sheet) {
      var nm = sheet.querySelector("#c-name");
      nm.focus();
      nm.setSelectionRange(nm.value.length, nm.value.length);
      sheet.querySelector("#custom-form").addEventListener("submit", function (e) {
        e.preventDefault();
        var name = sheet.querySelector("#c-name").value.trim();
        var qty = parseFloat(sheet.querySelector("#c-qty").value);
        if (!name) { sheet.querySelector("#c-name").focus(); return; }
        if (!(qty > 0)) { sheet.querySelector("#c-qty").focus(); toast("Enter a quantity"); return; }
        var o = currentOrder();
        var req = sheet.querySelector("#c-request");
        var line = {
          key: "custom:" + uid(), custom: true, id: "", name: name, unit: sheet.querySelector("#c-unit").value,
          price: parseFloat(sheet.querySelector("#c-price").value) || 0, model: sheet.querySelector("#c-part").value.trim(), category: "Not in price list", qty: +qty.toFixed(3),
          requested: !!(req && req.checked)
        };
        o.lines.push(line);
        putOrder(o);
        if (line.requested) {
          // Queued so it also works with no signal; sent with the next sync.
          var q = store.get("pendingCatalogRequests", []);
          q.push({ supplier: o.supplier, name: line.name, model: line.model, unit: line.unit, price: line.price, job_number: o.jobNumber, order_id: o.id });
          store.set("pendingCatalogRequests", q);
          scheduleSync(0);
          toast("Added - sent to the admin to review for the price list");
        }
        closeSheet();
        if (!line.requested) toast("Added: " + name);
        afterChange();
      });
    });
  }

  // ----- review
  VIEWS.review = function () {
    var o = currentOrder();
    if (!o) return VIEWS.home();
    repriceOrder(o);
    o = currentOrder();
    var h = topbar("Review Order", "Job " + o.jobNumber + " · " + o.supplier, backBtn("to-build", "Back to materials"));
    h += '<main class="page">';
    h += '<div class="card"><dl class="kv"><dt>Order #</dt><dd data-order-number>' + esc(orderNo(o)) + "</dd><dt>Supplier</dt><dd>" + esc(o.supplier) +
      "</dd><dt>Job #</dt><dd>" + esc(o.jobNumber) + "</dd>" + (o.jobName ? "<dt>Job name</dt><dd>" + esc(o.jobName) + "</dd>" : "") + "</dl></div>";

    var sup = supLines(o), shp = shopLines(o);
    h += '<h3>Order from ' + esc(o.supplier) + " (" + sup.length + ')</h3><div class="card">';
    if (!sup.length) h += '<div class="empty">' + (shp.length ? "Nothing to order from the supplier - everything is coming from the shop." : "No materials yet.") + "</div>";
    sup.forEach(function (l) { h += lineHtml(l); });
    if (sup.length && !hidePrices()) {
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

    if (!hidePrices()) h += '<h3>Pricing</h3><div class="card"><label class="toggle"><input type="checkbox" id="show-pricing"' + (o.showPricing ? " checked" : "") + ">" +
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
    var sp = document.getElementById("show-pricing");
    if (sp) sp.addEventListener("change", function (e) {
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
        : (l.custom ? "Not in price list" + (l.model ? " · #" + esc(l.model) : "") + (l.requested ? " · requested for price list" : "") : esc(l.category) + (l.model ? " · #" + esc(l.model) : "")) + " · " +
          (hidePrices() ? esc(l.unit) : (l.special ? '<span class="job-price">Job price</span> ' : "") +
          (l.price > 0 ? fmtMoney(l.price) : "Price TBD") + " / " + esc(l.unit))) + "</div></div>" +
      '<div class="l-ext">' + (shop ? "Shop" : hidePrices() ? "" : l.price > 0 ? fmtMoney(lineTotal(l)) : "—") + "</div>" +
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
        (supLines(o).length && !hidePrices() ? " · " + (o.showPricing ? "Est. " + fmtMoney(orderTotal(o)) : "pricing hidden") : "") + "</div>" +
      (hidePrices() ? "" : '<label class="toggle" style="justify-content:center"><input type="checkbox" id="send-pricing"' + (o.showPricing ? " checked" : "") + ">Include listed pricing</label>") + "</div>";
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
    var spp = document.getElementById("send-pricing");
    if (spp) spp.addEventListener("change", function (e) {
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
    var p = o.showPricing && !hidePrices();
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
    var p = o.showPricing && !hidePrices();
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
    var p = o.showPricing && !hidePrices();
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
      var W = doc.internal.pageSize.getWidth(), M = 40, p = o.showPricing && !hidePrices();
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
    h += setupBanner();
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

  // ----- special pricing (admin)
  // Books grouped by job number (each book belongs to one job; older shared books show under each of their jobs).
  function pricingJobs() {
    var map = {};
    getBooks().forEach(function (b) {
      bookJobs(b).forEach(function (j) {
        var e = map[j] = map[j] || { job: j, books: [], items: 0 };
        e.books.push(b);
        e.items += (b.items || []).length;
      });
    });
    return Object.keys(map).sort(function (a, b) { return a.localeCompare(b, undefined, { numeric: true }); }).map(function (k) { return map[k]; });
  }

  VIEWS["pricing-job"] = function () {
    var job = state.pricingJob;
    var entry = pricingJobs().filter(function (j) { return j.job === job; })[0];
    var h = topbar("Job " + job + " special pricing", entry ? entry.books.length + " price book" + (entry.books.length === 1 ? "" : "s") : "", backBtn("pricing", "Special pricing"));
    h += '<main class="page">';
    if (!entry) return h + '<div class="empty">No price books for this job.</div></main>';
    h += '<div class="tile-list">';
    entry.books.slice().sort(function (a, b) { return a.supplier < b.supplier ? -1 : a.supplier > b.supplier ? 1 : (a.name || "") < (b.name || "") ? -1 : 1; }).forEach(function (b) {
      h += '<button class="tile" data-action="open-book" data-id="' + esc(b.id) + '"><div class="t-main"><div class="t-title">' + esc(b.supplier) + "</div>" +
        '<div class="t-sub">' + esc(b.name || "") + '</div><div class="t-sub">' + (b.items || []).length.toLocaleString() + " items" + (b.active ? "" : " · <b>turned off</b>") +
        " · updated " + esc(fmtDate(b.updated_at)) + "</div></div>" + '<span class="chev">›</span></button>';
    });
    h += '</div><button class="btn block" style="margin-top:14px" data-action="new-book-for-job" data-job="' + esc(job) + '">' + ICON.plus + "New price book for Job " + esc(job) + "</button></main>";
    return h;
  };

  function currentBook() { return getBooks().filter(function (b) { return b.id === state.bookId; })[0] || null; }

  VIEWS.pricing = function () {
    var h = topbar("Special Pricing", "Job price books", backBtn("home", "Home"), syncPill());
    h += '<main class="page">';
    if (!isAdmin()) return h + setupBanner() + '<div class="empty">Only an admin can manage special pricing.</div></main>';
    if (store.get("booksSetupMissing", false)) {
      h += '<div class="notice"><b>Database setup not finished.</b> Run <code>supabase/pricing.sql</code> once in Supabase (SQL Editor → New query → paste → Run), then reopen this screen.</div>';
    }
    h += '<p class="hint" style="margin-top:0">When an order is for a job listed here, items in that job\'s price books use the job price automatically. Everything else uses regular pricing.</p>';
    h += '<div class="card"><h2 style="margin-top:0;font-size:18px">New price book</h2><form id="book-form">' +
      '<div class="filters"><label class="field"><span>Job # <span class="req">*</span> <small style="font-weight:500;color:var(--muted)">(several jobs: 3479, 3557 - each gets its own copy)</small></span><input class="input" name="job" required autocomplete="off" placeholder="e.g. 2695"></label>' +
      '<label class="field"><span>Supplier <span class="req">*</span></span><select class="input" name="supplier">' + SUPPLIERS.map(function (x) { return "<option>" + esc(x) + "</option>"; }).join("") + "</select></label>" +
      '<label class="field full"><span>Name (optional)</span><input class="input" name="name" placeholder="e.g. Homans Yale pricebook 1.12.26"></label></div>' +
      '<button class="btn primary block" type="submit">' + ICON.plus + "Create price book</button></form></div>";
    var jobs = pricingJobs();
    h += "<h3>Jobs with special pricing (" + jobs.length + ")</h3>";
    if (!jobs.length) h += '<div class="empty">No special pricing yet.</div>';
    else {
      h += '<div class="tile-list">';
      jobs.forEach(function (j) {
        var sups = {};
        j.books.forEach(function (bk) { sups[bk.supplier] = 1; });
        h += '<button class="tile" data-action="open-pricing-job" data-job="' + esc(j.job) + '"><span class="job-badge">Job ' + esc(j.job) + '</span><div class="t-main">' +
          '<div class="t-title">' + j.books.length + " price book" + (j.books.length === 1 ? "" : "s") + "</div>" +
          '<div class="t-sub">' + esc(Object.keys(sups).join(", ")) + " · " + j.items.toLocaleString() + " job prices</div></div>" +
          '<span class="chev">›</span></button>';
      });
      h += "</div>";
    }
    return h + "</main>";
  };
  AFTER.pricing = function () {
    var f = document.getElementById("book-form");
    if (!f) return;
    if (state.newBookJob) { f.job.value = state.newBookJob; state.newBookJob = ""; f.name.focus(); }
    f.addEventListener("submit", function (e) {
      e.preventDefault();
      var job = f.job.value.split(/[,;\s]+/).map(function (x) { return x.trim(); }).filter(Boolean).join(", ");
      if (!job) { f.job.focus(); return; }
      var btn = f.querySelector("button");
      btn.disabled = true;
      var jobs = job.split(", ");
      // Each job gets its own copy of the book.
      Promise.all(jobs.map(function (j) { return Cloud.saveBook({ job_number: j, supplier: f.supplier.value, name: f.name.value.trim() }); })).then(function (ids) {
        return refreshBooks().then(function () {
          toast(ids.length > 1 ? "Created a price book for each of " + ids.length + " jobs" : "Price book created");
          if (ids.length > 1) go("pricing"); else go("book", { bookId: ids[0] });
        });
      }, function (ex) { btn.disabled = false; toast(ex.message || "Couldn't create the book"); });
    });
  };

  VIEWS.book = function () {
    var b = currentBook();
    if (!b) return VIEWS.pricing();
    var h = topbar("Job " + b.job_number + " · " + b.supplier, b.name || "Price book", backBtn("back-to-job", "Job price books"));
    var items = (b.items || []).map(function (x) { return { row: x, it: BY_KEY[x.item_key] }; });
    h += '<main class="page"><div class="btn-row" style="margin-bottom:10px">' +
      '<button class="btn primary" data-action="book-add">' + ICON.plus + "Add item</button>" +
      '<button class="btn brand" data-action="book-import">Import Excel / CSV / PDF</button></div>' +
      '<input type="file" id="book-file" accept=".xlsx,.xls,.csv,.pdf" hidden>' +
      '<div class="card"><label class="toggle"><input type="checkbox" id="book-active"' + (b.active ? " checked" : "") + ">Use this price book for Job " + esc(b.job_number) + "</label>" +
      '<div class="btn-row"><button class="btn" data-action="book-copy">Copy to another job</button><button class="btn" data-action="book-jobs">Change job #</button>' +
      '<button class="btn" data-action="book-rename">Rename</button><button class="btn danger" data-action="book-delete">Delete book</button></div></div>';
    h += '<div class="searchbar"><div class="search-wrap">' + ICON.search +
      '<input class="search-input" id="book-q" type="search" autocomplete="off" placeholder="Search items in this book" value="' + esc(state.bookQuery || "") + '"></div></div>' +
      '<div class="search-meta" style="margin-bottom:8px"><b>' + items.length.toLocaleString() + "</b> items with job pricing</div>" +
      '<div id="book-items"></div></main>';
    return h;
  };
  AFTER.book = function () {
    var b = currentBook();
    if (!b) return;
    document.getElementById("book-active").addEventListener("change", function (e) {
      var nb = { id: b.id, job_number: b.job_number, supplier: b.supplier, name: b.name, active: e.target.checked };
      Cloud.saveBook(nb).then(refreshBooks).then(function () { toast(nb.active ? "Book turned on" : "Book turned off"); }, function (ex) { toast(ex.message); });
    });
    var q = document.getElementById("book-q");
    q.addEventListener("input", function () { state.bookQuery = q.value; clearTimeout(searchTimer); searchTimer = setTimeout(renderBookItems, 140); });
    document.getElementById("book-file").addEventListener("change", function (e) {
      var f = e.target.files[0];
      e.target.value = "";
      if (f) importPriceFile(b, f);
    });
    renderBookItems();
  };
  function renderBookItems() {
    var b = currentBook(), box = document.getElementById("book-items");
    if (!b || !box) return;
    var list = (b.items || []).map(function (x) {
      var it = BY_KEY[x.item_key];
      return { name: it ? it.name : x.item_name || x.item_key, category: it ? it.category : "", model: it ? it.model : "", row: x, it: it };
    });
    if ((state.bookQuery || "").trim()) { S.buildIndex(list); list = S.search(list, state.bookQuery).results; }
    else list.sort(function (a, b2) { return a.name < b2.name ? -1 : 1; });
    if (!list.length) { box.innerHTML = '<div class="empty">' + ((b.items || []).length ? "Nothing matches." : "No items yet. Add them one at a time or import the supplier's price sheet.") + "</div>"; return; }
    box.innerHTML = '<ul class="results">' + list.slice(0, state.shown).map(function (x) {
      var reg = x.it ? x.it.price : 0;
      return '<li class="result"><button class="r-main" data-action="book-item" data-key="' + esc(x.row.item_key) + '"><div class="r-name">' + esc(x.name) + '</div><div class="r-sub">' + esc(x.category) + (x.model ? " · #" + esc(x.model) : "") + "</div>" +
        '<div class="r-price"><span class="job-price">Job price</span> ' + fmtMoney(x.row.price) + ' <span class="unit">/ ' + esc(x.row.unit || (x.it && x.it.unit) || "") + "</span>" +
        (reg > 0 ? ' <span class="unit">· regular ' + fmtMoney(reg) + "</span>" : "") + "</div></button></li>";
    }).join("") + "</ul>" +
      (list.length > state.shown ? '<button class="btn block more" data-action="book-more">Show more (' + (list.length - state.shown).toLocaleString() + ")</button>" : "");
  }

  VIEWS["book-add"] = function () {
    var b = currentBook();
    if (!b) return VIEWS.pricing();
    return topbar("Add to price book", "Job " + b.job_number + " · " + b.supplier, backBtn("open-book-back", "Back to book")) +
      '<main class="page"><p class="hint" style="margin-top:0">Find the item, then tap it to enter the job price.</p>' + finderHtml() + "</main>";
  };
  AFTER["book-add"] = function () { afterFinder(); };

  function openBookPriceSheet(b, it) {
    var existing = (b.items || []).filter(function (x) { return x.item_key === it.key; })[0];
    var h = "<h2>" + esc(it.name) + '</h2><div class="hint" style="margin-top:-6px">' + esc(it.category) + (it.model ? " · #" + esc(it.model) : "") + "</div>" +
      '<div style="font-weight:700">Regular price: ' + (it.price > 0 ? fmtMoney(it.price) : "TBD") + " / " + esc(it.unit) + "</div>" +
      '<label class="field" style="margin-top:14px"><span>Job ' + esc(b.job_number) + " price per " + esc(it.unit) + '</span><input class="input huge" id="book-price" type="number" inputmode="decimal" min="0" step="any" value="' + (existing ? esc(existing.price) : "") + '"></label>' +
      '<div class="btn-row">' + (existing ? '<button class="btn danger" id="bp-remove">Remove</button>' : '<button class="btn" data-action="close-sheet">Cancel</button>') +
      '<button class="btn primary" id="bp-save">Save job price</button></div>';
    openSheet(h, function (sheet) {
      var inp = sheet.querySelector("#book-price");
      setTimeout(function () { inp.focus(); inp.select(); }, 60);
      sheet.querySelector("#bp-save").addEventListener("click", function (e) {
        var v = parseFloat(inp.value);
        if (!(v >= 0) || inp.value === "") { inp.focus(); toast("Enter a price"); return; }
        e.target.disabled = true;
        Cloud.upsertBookItems(b.id, [{ item_key: it.key, item_name: it.name, unit: it.unit, price: +v.toFixed(4) }]).then(refreshBooks).then(function () {
          closeSheet(); toast("Job price saved"); render();
        }, function (ex) { e.target.disabled = false; toast(ex.message || "Couldn't save"); });
      });
      var rm = sheet.querySelector("#bp-remove");
      if (rm) rm.addEventListener("click", function () {
        Cloud.deleteBookItem(b.id, it.key).then(refreshBooks).then(function () { closeSheet(); toast("Removed - regular price applies"); render(); }, function (ex) { toast(ex.message); });
      });
    });
  }

  // ----- price sheet import (Excel / CSV / text PDF)
  function loadScript(src) {
    return new Promise(function (res, rej) { var sc = document.createElement("script"); sc.src = src; sc.onload = res; sc.onerror = rej; document.head.appendChild(sc); });
  }
  function normCode(c) { return String(c == null ? "" : c).toUpperCase().replace(/[\s]+/g, ""); }
  function parsePrice(v) {
    if (typeof v === "number") return v;
    var m = String(v == null ? "" : v).replace(/[$,\s]/g, "").match(/^\d+(\.\d+)?$/);
    return m ? parseFloat(m[0]) : null;
  }
  function supplierIndex(supplier) {
    var byModel = {}, byId = {}, byName = {};
    (BY_SUPPLIER[supplier] || []).forEach(function (it) {
      if (it.model) (byModel[normCode(it.model)] = byModel[normCode(it.model)] || []).push(it);
      byId[normCode(it.id)] = [it];
      (byName[it.name.toUpperCase().replace(/\s+/g, " ").trim()] = byName[it.name.toUpperCase().replace(/\s+/g, " ").trim()] || []).push(it);
    });
    function exact(c) { return byModel[c] || byId[c] || null; }
    // Scanned/OCR'd PDFs mix up O/0 and I/1 (FIPCO121OAJ = FIPC01210AJ): try those swaps if the code doesn't match.
    function fuzzy(c) {
      var pos = [];
      for (var i = 0; i < c.length; i++) if ("O0I1".indexOf(c[i]) >= 0) pos.push(i);
      if (!pos.length || pos.length > 8) return null;
      var swap = { O: "0", "0": "O", I: "1", "1": "I" };
      for (var mask = 1; mask < (1 << pos.length); mask++) {
        var arr = c.split("");
        pos.forEach(function (p, k) { if (mask & (1 << k)) arr[p] = swap[arr[p]]; });
        var hit = exact(arr.join(""));
        if (hit) return hit;
      }
      return null;
    }
    return function (code, desc) {
      var c = normCode(code);
      return exact(c) || (desc ? byName[String(desc).toUpperCase().replace(/\s+/g, " ").trim()] : null) || (c.length >= 5 ? fuzzy(c) : null) || null;
    };
  }

  // Spreadsheet: find the header row with a price column and a code column on each sheet; use the sheet that matches best.
  function rowsFromWorkbook(wb, lookup) {
    var best = null;
    wb.SheetNames.forEach(function (name) {
      var grid = window.XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: "" });
      for (var r = 0; r < Math.min(grid.length, 40); r++) {
        var head = grid[r].map(function (c) { return String(c).trim().toLowerCase(); });
        var pc = -1, cc = -1, dc = -1;
        head.forEach(function (c, i) {
          if (pc < 0 && /(special|job|net|contract|your)?\s*price|^cost$|^net$|sell/.test(c) && !/list|retail/.test(c)) pc = i;
          if (cc < 0 && /^(product|item code|item #|item no|item number|part|part #|part number|sku|model|model number|model #|catalog|mfr|internal identifier)$/.test(c)) cc = i;
          if (dc < 0 && /description|item name|^name$/.test(c)) dc = i;
        });
        if (pc < 0 || (cc < 0 && dc < 0)) continue;
        var rows = [];
        for (var k = r + 1; k < grid.length; k++) {
          var g = grid[k], code = cc >= 0 ? g[cc] : "", desc = dc >= 0 ? g[dc] : "", raw = g[pc];
          if (!String(code).trim() && !String(desc).trim()) continue;
          rows.push({ code: String(code).trim(), desc: String(desc).trim(), price: parsePrice(raw), call: /call/i.test(String(raw)) });
        }
        var score = rows.filter(function (x) { return x.price != null && lookup(x.code, x.desc); }).length;
        if (!best || score > best.score) best = { score: score, rows: rows, source: 'sheet "' + name + '"' };
        break;
      }
    });
    return best || { rows: [], source: "" };
  }

  // Quote-style PDFs: CODE (: description) / qty / UOM / [qty / UOM] / unit price / amount.
  // Only lines where qty x unit price = amount (within 2%) are accepted, so garbled lines are skipped, not guessed.
  var UOM_RE = /^(LF|FT|EA|EACH|SF|SQFT|RL|ROLL|BX|BOX|PK|CT|CTN|GAL|GA|LB|PC|PCS|SET|KT|KIT|CS|BG|BAG|SH|SHT|TB|TUBE|PR|LY|QT|PT|CN)$/i;
  var NUM_RE = /^\$?\d{1,3}(,\d{3})*(\.\d+)?$|^\$?\d*\.?\d+$/;
  // Works on words, not lines, so it copes with both one-value-per-line and one-row-per-line PDF text.
  // An item starts at a word that is a known item code for this supplier (e.g. "FIPC01210AO" or "FIPC01510AO:").
  function rowsFromQuoteText(text, lookup) {
    var words = text.replace(/(\d) \.(\d)/g, "$1.$2").replace(/\f/g, " \f ").split(/[ \t\n\r]+/).filter(Boolean);
    var num = function (t) { return parseFloat(t.replace(/[$,]/g, "")); };
    var isCode = function (w) {
      var c = w.replace(/:$/, "");
      return /^[A-Z0-9][A-Z0-9\-\/.#]{3,}$/.test(c) && /[A-Z]/.test(c) && /\d/.test(c) && lookup(c) ? c : null;
    };
    var rows = [], skipped = [], pending = [];
    for (var i = 0; i < words.length; i++) {
      var code = isCode(words[i]);
      if (!code) continue;
      var chunk = [], j;
      for (j = i + 1; j < words.length && j < i + 45 && !isCode(words[j]); j++) chunk.push(words[j]);
      var found = null;
      for (var k = 0; k < chunk.length && !found; k++) {
        if (!UOM_RE.test(chunk[k])) continue;
        var q = null;
        for (var b2 = k - 1; b2 >= 0; b2--) if (NUM_RE.test(chunk[b2])) { q = num(chunk[b2]); break; }
        var after = [];
        for (var a = k + 1; a < chunk.length && after.length < 2; a++) {
          if (UOM_RE.test(chunk[a])) break;
          if (NUM_RE.test(chunk[a]) && !(a + 1 < chunk.length && UOM_RE.test(chunk[a + 1]))) after.push(num(chunk[a]));
        }
        if (q != null && after.length === 2 && Math.abs(q * after[0] - after[1]) <= Math.max(1, after[1] * 0.02)) {
          found = { code: code, desc: "", price: after[0], unit: chunk[k].toUpperCase(), call: false };
        }
      }
      if (found) rows.push(found); else pending.push({ code: code, at: i, qty: firstQty(chunk) });
      i = j - 1;
    }
    recoverPagePrices(words, pending, rows, isCode);
    pending.forEach(function (p) { if (!p.done) skipped.push(p.code); });
    return { rows: rows, source: "quote PDF", unreadable: skipped };
  }
  // Quantity right before the first unit word after a code ("44 EA"), if there is one.
  function firstQty(chunk) {
    for (var k = 1; k < chunk.length; k++) if (UOM_RE.test(chunk[k]) && NUM_RE.test(chunk[k - 1])) return parseFloat(chunk[k - 1].replace(/[$,]/g, ""));
    return null;
  }
  // Some PDFs separate a line's numbers from its item code:
  //  (a) prices for a run of lines are printed together at the bottom of the page: "15 EA 7.639 114.59"
  //  (b) the page is in columns: all codes, then all qtys, units, qtys, units, prices, amounts.
  // Rows are only accepted when qty x price = amount.
  function recoverPagePrices(words, pending, rows, isCode) {
    if (!pending.length) return;
    var num = function (t) { return parseFloat(t.replace(/[$,]/g, "")); };
    var valid = function (q, p, a) { return q > 0 && Math.abs(q * p - a) <= Math.max(1, a * 0.02); };
    // page boundaries
    var pages = [], start = 0;
    words.forEach(function (w, i) { if (w === "\f") { pages.push([start, i]); start = i + 1; } });
    pages.push([start, words.length]);
    pages.forEach(function (pg) {
      var pend = pending.filter(function (p) { return p.at >= pg[0] && p.at < pg[1] && !p.done; });
      if (!pend.length) return;
      // (a) orphan "qty UOM price amount" groups on this page, matched in order by quantity
      var tuples = [];
      for (var i = pg[0]; i + 3 < pg[1]; i++) {
        if (NUM_RE.test(words[i]) && UOM_RE.test(words[i + 1]) && NUM_RE.test(words[i + 2]) && NUM_RE.test(words[i + 3]) && valid(num(words[i]), num(words[i + 2]), num(words[i + 3])) &&
            !(i + 4 < pg[1] && UOM_RE.test(words[i + 4]))) {
          tuples.push({ at: i, q: num(words[i]), unit: words[i + 1].toUpperCase(), p: num(words[i + 2]) });
        }
      }
      var used = {};
      pend.forEach(function (p) {
        if (p.qty == null) return;
        for (var t = 0; t < tuples.length; t++) {
          if (used[t] || tuples[t].at < p.at || tuples[t].q !== p.qty) continue;
          used[t] = 1; p.done = true;
          rows.push({ code: p.code, desc: "", price: tuples[t].p, unit: tuples[t].unit, call: false });
          break;
        }
      });
      // (b) column layout: numbers after the last code on the page
      var left = pend.filter(function (p) { return !p.done; });
      if (!left.length) return;
      var last = left[left.length - 1].at, n = left.length, nums = [], units = [];
      for (var k = last + 1; k < pg[1]; k++) {
        // stop at the next item ("CODE :" or "CODE:"), known to the price list or not
        if (isCode(words[k]) || words[k + 1] === ":" || (/:$/.test(words[k]) && /[A-Z]/.test(words[k]) && /\d/.test(words[k]))) break;
        if (NUM_RE.test(words[k])) nums.push(num(words[k]));
        else if (UOM_RE.test(words[k])) units.push(words[k].toUpperCase());
      }
      // Columns are qty, qty, price, amount (units aren't numbers), so use the last 4n numbers;
      // anything before them (numbers inside the last description) is ignored.
      if (nums.length >= 4 * n) {
        var L = nums.length, qty = nums.slice(L - 4 * n, L - 3 * n), price = nums.slice(L - 2 * n, L - n), amt = nums.slice(L - n);
        left.forEach(function (p, i) {
          // (units column is often garbled in these, so the qty x price = amount check is what we rely on)
          if (valid(qty[i], price[i], amt[i])) { p.done = true; rows.push({ code: p.code, desc: "", price: price[i], unit: "", call: false }); }
        });
      }
    });
  }

  // Quotes with no item codes ("2,145  AEROFLEX 1-1/8X1 TUBE  $2.79  LF  $5,985.33"): match by description.
  function rowsFromDescQuote(text) {
    var re = /(?:^|\n)\s*([\d,]+)\s+(.+?)\s+\$([\d,]*\.\d+)\s+([A-Za-z]{2,4})\s+\$([\d,]*\.\d+)/g, m, rows = [];
    while ((m = re.exec(text))) {
      var qty = +m[1].replace(/,/g, ""), price = +m[3].replace(/,/g, ""), ext = +m[5].replace(/,/g, "");
      if (Math.abs(qty * price - ext) > Math.max(1, ext * 0.03)) continue; // not a real priced line
      rows.push({ code: "", desc: m[2].trim(), price: price, unit: m[4].toUpperCase(), byDesc: true });
    }
    return { rows: rows, source: "quote without item codes" };
  }

  // GIC-style quotes: "ILOCK 1-1/8 ID X 1" X 6' 54ft   3.664/ft   197.86" then "KFLEX #6RXLO100118" / "Pn: 28516".
  function rowsFromUnitPriceText(text) {
    var lines = text.split("\n").map(function (l) { return l.trim(); });
    var re = /^(.*?)\s+([\d,]+(?:\.\d+)?)\s*([A-Za-z]{2,4})\s+([\d,]*\.?\d+)\s*\/\s*([A-Za-z]{2,4})\s+([\d,]+\.\d{2})\s*$/;
    var rows = [];
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(re);
      if (!m) continue;
      var qty = +m[2].replace(/,/g, ""), price = +m[4].replace(/,/g, ""), ext = +m[6].replace(/,/g, "");
      if (Math.abs(qty * price - ext) > Math.max(1, ext * 0.02)) continue;
      var code = "", desc = m[1].trim();
      for (var k = i + 1; k < Math.min(lines.length, i + 4); k++) {
        if (re.test(lines[k])) break;
        var c = lines[k].match(/#\s?([A-Z0-9][A-Z0-9\-\/.]{3,})/i);
        if (c && !code) code = c[1];
        else if (!/^Pn:|^\*|^\(/.test(lines[k]) && lines[k] && !c) desc += " " + lines[k];
      }
      rows.push({ code: code, desc: desc, price: price, unit: m[5].toUpperCase(), call: false, descFallback: true });
    }
    return { rows: rows, source: "quote PDF (unit prices)" };
  }

  // Material family and product type words, so "8X5 MW PC" can't match fiberglass pipe covering.
  var FAMILIES = [
    [/\b(FG|FBG|FIBERGLASS|FIBREGLASS|MICRO-?FLEX|MICRO-?LOK)\b/i, /fiberglass/i],
    [/\b(MW|MINERAL|MIN WOOL|ROCKWOOL|ROXUL|PROROX)\b/i, /mineral/i],
    [/\b(AEROFLEX|AEROCEL)\b/i, /aerocel|aeroflex/i],
    [/\b(ARMAFLEX|ARMACELL|AP ARMAFLEX)\b/i, /armaflex|armacell/i],
    [/\b(TPS|CALSIL|CAL SIL|T-?4000|T-?1200)\b/i, /calcium silicate|calsil|cal sil/i],
    [/\b(FOAMGLAS|CELL(ULAR)? GLASS)\b/i, /cellular glass|foamglas/i],
    [/\bPHENOLIC\b/i, /phenolic/i], [/\b(POLYISO|ISO)\b/i, /polyiso/i], [/\bSTYRO/i, /styrofoam/i],
    [/\bPVC\b/i, /pvc/i], [/\b(ALUM|ALUMINUM)\b/i, /alumin/i], [/\b(SS|STAINLESS)\b/i, /stainless/i]
  ];
  function familyOk(desc, it) {
    var hay = it.category + " " + it.name;
    for (var i = 0; i < FAMILIES.length; i++) if (FAMILIES[i][0].test(desc)) return FAMILIES[i][1].test(hay);
    return false; // unknown material: never auto-accept
  }
  function typeOk(desc, it) {
    var fitting = /\b(90|45|ELL|ELBOW|TEE|FITTING|WELD\d*|CAP)\b|WELD90|WELD45/i.test(desc), pc = /\b(PC|PIPE|TUBE|P\/C)\b/i.test(desc);
    if (fitting) return /^Fitting Covers/.test(it.category);
    if (pc) return /^Pipe Covering/.test(it.category);
    return true;
  }
  function matchByDescription(rows, supplier) {
    var items = BY_SUPPLIER[supplier] || [];
    if (!items._indexed) { S.buildIndex(items); items._indexed = true; }
    var U = function (u) { u = String(u || "").toUpperCase(); return { FT: "LF", EACH: "EA" }[u] || u; };
    return rows.map(function (r) {
      var q = r.desc.replace(/(\d)\s*X\s*(\d)/gi, "$1 x $2").replace(/\bFG\b|\bFBG\b/gi, "fiberglass").replace(/\bPC\b/g, "pipe");
      var dims = S.parseQuery(q).dims;
      if (!dims.length) return { row: r, item: null, confident: false };
      var cands = items.filter(function (it) {
        if (U(it.unit) !== U(r.unit)) return false;
        var d = S.itemDims(it.name);
        return d.length === dims.length && dims.every(function (x, i) { return Math.abs(x.v - d[i].v) < 1e-6; });
      });
      var good = cands.filter(function (it) { return familyOk(r.desc, it) && typeOk(r.desc, it); });
      var best = (good.length ? good : cands).slice().sort(function (a, b) {
        var pa = a.price > 0 ? Math.abs(Math.log(r.price / a.price)) : 9, pb = b.price > 0 ? Math.abs(Math.log(r.price / b.price)) : 9;
        return pa - pb;
      })[0] || null;
      var ratio = best && best.price > 0 ? r.price / best.price : 0;
      return { row: r, item: best, confident: !!best && good.length > 0 && good.indexOf(best) >= 0 && ratio > 0.4 && ratio < 1.6 };
    });
  }

  // Price-book PDFs: item codes are followed by their price (e.g. "JM1121FBG 1.67" or "... Call").
  function rowsFromPdfText(text) {
    var re = /(?:^|[^A-Za-z0-9])([A-Z0-9][A-Z0-9\-\/.#]{3,})\s+(\$?\d{1,5}(?:,\d{3})*\.\d{2}|Call)\b/g, m, seen = {}, rows = [];
    while ((m = re.exec(text))) {
      if (seen[m[1]]) continue;
      seen[m[1]] = 1;
      rows.push({ code: m[1], desc: "", price: m[2] === "Call" ? null : parsePrice(m[2]), call: m[2] === "Call" });
    }
    return { rows: rows, source: "PDF" };
  }

  function readPdfText(file) {
    return import(new URL("js/vendor/pdfjs/pdf.min.mjs", location.href).href).then(function (pdfjs) {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL("js/vendor/pdfjs/pdf.worker.min.mjs", location.href).href;
      return file.arrayBuffer().then(function (buf) { return pdfjs.getDocument({ data: buf }).promise; }).then(function (doc) {
        var pages = [];
        for (var i = 1; i <= doc.numPages; i++) pages.push(i);
        return Promise.all(pages.map(function (n) {
          return doc.getPage(n).then(function (pg) { return pg.getTextContent(); }).then(function (tc) {
            return tc.items.map(function (x) { return x.str + (x.hasEOL ? "\n" : " "); }).join("");
          });
        })).then(function (t) { return t.join("\n\f\n"); });
      });
    });
  }

  // Invoice PDFs: the text laid out line by line (items on the same row joined left to right),
  // so the invoice agent can read table rows as text. Empty for scanned PDFs.
  function readPdfLines(file) {
    return import(new URL("js/vendor/pdfjs/pdf.min.mjs", location.href).href).then(function (pdfjs) {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL("js/vendor/pdfjs/pdf.worker.min.mjs", location.href).href;
      return file.arrayBuffer().then(function (buf) { return pdfjs.getDocument({ data: buf }).promise; }).then(function (doc) {
        var pages = [];
        for (var i = 1; i <= Math.min(doc.numPages, 30); i++) pages.push(i);
        return Promise.all(pages.map(function (n) {
          return doc.getPage(n).then(function (pg) { return pg.getTextContent(); }).then(function (tc) {
            var rows = [];
            tc.items.forEach(function (x) {
              if (!x.str || !x.str.trim()) return;
              var y = x.transform[5], row = rows.filter(function (r) { return Math.abs(r.y - y) < 3; })[0];
              if (!row) { row = { y: y, items: [] }; rows.push(row); }
              row.items.push({ x: x.transform[4], s: x.str.trim() });
            });
            rows.sort(function (a, b) { return b.y - a.y; });
            return "--- Page " + n + " ---\n" + rows.map(function (r) {
              return r.items.sort(function (a, b) { return a.x - b.x; }).map(function (it) { return it.s; }).join("   ");
            }).join("\n");
          });
        })).then(function (t) { var all = t.join("\n\n"); return all.replace(/--- Page \d+ ---|\s/g, "").length > 80 ? all : ""; });
      });
    }).catch(function () { return ""; });
  }
  function isPdf(nameOrType) { return /pdf/i.test(nameOrType || ""); }
  // Older invoices (uploaded before text was saved): pull the text from the stored PDF before a re-run.
  function ensureInvoiceText(inv) {
    var done = store.get("invTextDone", {});
    if (done[inv.id] || !(isPdf(inv.file_type) || isPdf(inv.file_name))) return Promise.resolve();
    return Cloud.downloadInvoiceFile(inv.file_path).then(function (blob) { return readPdfLines(blob); })
      .then(function (text) { return Cloud.saveInvoiceText(inv.file_path, text); })
      .then(function () { var d = store.get("invTextDone", {}); d[inv.id] = 1; store.set("invTextDone", d); }, function () {});
  }

  function importPriceFile(b, file) {
    var lookup = supplierIndex(b.supplier);
    toast("Reading " + file.name + "…");
    var parsed;
    if (/\.pdf$/i.test(file.name)) {
      parsed = readPdfText(file).then(function (t) {
        if (!t.replace(/\s/g, "").length) throw new Error("This PDF is a scanned image with no text, so prices can't be read. Ask the supplier for Excel or a text PDF, or add items one at a time.");
        // Try both layouts and keep whichever finds more of this supplier's items.
        var score = function (r) { return r.rows.filter(function (x) { return x.price != null && lookup(x.code, x.desc); }).length; };
        var a = rowsFromPdfText(t), q = rowsFromQuoteText(t, lookup), u = rowsFromUnitPriceText(t);
        var best = [a, q, u].sort(function (x, y) { return score(y) - score(x); })[0];
        if (u.rows.length > 10 && score(u) >= score(best) * 0.5 && u.rows.length > best.rows.length) best = u;
        if (score(best) < 5) { var d = rowsFromDescQuote(t); if (d.rows.length > score(best)) return d; }
        return best;
      });
    } else {
      parsed = (window.XLSX ? Promise.resolve() : loadScript("js/vendor/xlsx.full.min.js")).then(function () { return file.arrayBuffer(); })
        .then(function (buf) { return rowsFromWorkbook(window.XLSX.read(buf, { type: "array" }), lookup); });
    }
    parsed.then(function (res) {
      if (res.rows.length && res.rows[0].byDesc) { previewDescImport(b, file, res); return; }
      var mr = matchRows(res, lookup, b.supplier), matched = mr.matched, unmatched = mr.unmatched, calls = mr.calls,
        wrongUnit = mr.wrongUnit, suspicious = mr.suspicious, dupes = mr.dupes;
      var rows = Object.keys(matched).map(function (k) { return matched[k]; });
      // PDFs pick up stray words that look like codes; only list unmatched rows that look like real item codes.
      var realMiss = unmatched.filter(function (r) { return /\d/.test(r.code) || r.desc; });
      var h = "<h2>Import prices for Job " + esc(b.job_number) + '</h2><div class="hint" style="margin-top:-6px">' + esc(file.name) + (res.source ? " · " + esc(res.source) : "") + "</div>" +
        '<div class="card" style="box-shadow:none"><div class="kv"><dt>Match ' + esc(b.supplier) + " items</dt><dd>" + rows.length.toLocaleString() + "</dd>" +
        "<dt>Say \"Call\" (skipped)</dt><dd>" + calls + "</dd><dt>Not in price list</dt><dd>" + realMiss.length + "</dd>" +
        (dupes ? "<dt>Listed more than once</dt><dd>" + dupes + " (lowest price kept)</dd>" : "") +
        (wrongUnit.length ? "<dt>Different unit (skipped)</dt><dd>" + wrongUnit.length + "</dd>" : "") +
        (suspicious.length ? "<dt>Need a manual check</dt><dd>" + suspicious.length + "</dd>" : "") + "</div></div>" +
        (wrongUnit.length || suspicious.length ? '<details open><summary class="hint">Skipped - add these by hand if needed</summary><div class="hint" style="font-size:13px">' +
          wrongUnit.concat(suspicious).slice(0, 60).map(esc).join("<br>") + "</div></details>" : "") +
        (rows.length ? "" : '<div class="notice">No prices in this file matched ' + esc(b.supplier) + " items. Is this the right supplier's price sheet?</div>") +
        (realMiss.length ? '<details><summary class="hint">Show items not in the price list</summary><div class="hint" style="font-size:13px">' +
          realMiss.slice(0, 60).map(function (r) { return esc(r.code + (r.desc ? " - " + r.desc : "") + " · " + (r.price != null ? fmtMoney(r.price) : "")); }).join("<br>") +
          (realMiss.length > 60 ? "<br>…" : "") + "</div></details>" : "") +
        '<div class="btn-row" style="margin-top:14px"><button class="btn" data-action="close-sheet">Cancel</button>' +
        '<button class="btn primary" id="do-import"' + (rows.length ? "" : " disabled") + ">Import " + rows.length.toLocaleString() + " prices</button></div>";
      openSheet(h, function (sheet) {
        sheet.querySelector("#do-import").addEventListener("click", function (e) {
          e.target.disabled = true;
          e.target.textContent = "Importing…";
          Cloud.upsertBookItems(b.id, rows).then(refreshBooks).then(function () {
            closeSheet(); toast(rows.length.toLocaleString() + " job prices imported"); render();
          }, function (ex) { e.target.disabled = false; e.target.textContent = "Import"; toast(ex.message || "Import failed"); });
        });
      });
    }).catch(function (ex) { alert(ex.message || "Couldn't read that file."); });
  }

  // Turn parsed rows into job prices: match to price-list items, skip different units / implausible prices,
  // keep the lowest price for duplicates.
  function matchRows(res, lookup, supplier) {
    var matched = {}, unmatched = [], calls = 0, wrongUnit = [], suspicious = [], dupes = 0;
    var U = function (u) { u = String(u || "").toUpperCase(); return { EACH: "EA", PC: "EA", PCS: "EA", FT: "LF", SQFT: "SF", ROLL: "RL", BOX: "BX", CTN: "CT", BAG: "BG", SHT: "SH", KIT: "KT", TUBE: "TB", GA: "GAL" }[u] || u; };
    res.rows.forEach(function (r) {
      if (r.call || r.price == null) { if (r.call) calls++; return; }
      var its = r.code ? lookup(r.code, r.desc) : null;
      if (!its && r.descFallback && supplier) {
        var dm = matchByDescription([r], supplier)[0];
        if (dm && dm.confident) its = [dm.item];
      }
      if (!its) { unmatched.push(r); return; }
      its.forEach(function (it) {
        // Quote priced in a different unit than the price list (e.g. per SF vs per roll): can't use it.
        // Exception: "each" vs roll/gallon/box is usually the same package - accept when the price is close to the regular price.
        if (r.unit && U(r.unit) !== U(it.unit)) {
          var eachish = U(r.unit) === "EA" || U(it.unit) === "EA", ratio = it.price > 0 ? r.price / it.price : 0;
          if (!(eachish && ratio > 0.6 && ratio < 1.4)) { wrongUnit.push(r.code + " (" + r.unit + " vs " + it.unit + ")"); return; }
        }
        // Guard against misread numbers: job price should be in the neighborhood of the regular price.
        if (it.price > 0 && (r.price < it.price * 0.15 || r.price > it.price * 5)) { suspicious.push(r.code + " " + fmtMoney(r.price) + " vs regular " + fmtMoney(it.price)); return; }
        var prev = matched[it.key];
        if (prev) dupes++;
        // Same item listed more than once: keep the lowest price.
        if (!prev || r.price < prev.price) matched[it.key] = { item_key: it.key, item_name: it.name, unit: it.unit, price: +r.price.toFixed(4) };
      });
    });
    (res.unreadable || []).forEach(function (c) {
      var its = lookup(c);
      if (its && !its.some(function (it) { return matched[it.key]; })) suspicious.push(c + " (line couldn't be read clearly)");
    });
    return { matched: matched, unmatched: unmatched, calls: calls, wrongUnit: wrongUnit, suspicious: suspicious, dupes: dupes };
  }

  // Preview for quotes matched by description: confident matches are ticked, the rest need a person to confirm.
  function previewDescImport(b, file, res) {
    var list = matchByDescription(res.rows, b.supplier);
    var none = list.filter(function (x) { return !x.item; });
    var withItem = list.filter(function (x) { return x.item; });
    var h = "<h2>Import prices for Job " + esc(b.job_number) + '</h2><div class="hint" style="margin-top:-6px">' + esc(file.name) + " · " + esc(res.source) + "</div>" +
      '<div class="notice">This quote has no item codes, so lines were matched by description. <b>Ticked</b> lines matched size, material and type; please check the rest before importing.</div>' +
      '<div class="desc-list">' + withItem.map(function (x, i) {
        return '<label class="desc-row' + (x.confident ? "" : " unsure") + '"><input type="checkbox" data-i="' + i + '"' + (x.confident ? " checked" : "") + ">" +
          '<div><div><b>' + esc(x.row.desc) + "</b> · " + fmtMoney(x.row.price) + " / " + esc(x.row.unit) + "</div>" +
          '<div class="hint" style="margin:0">→ ' + esc(x.item.name) + " (regular " + (x.item.price > 0 ? fmtMoney(x.item.price) : "TBD") + ")</div></div></label>";
      }).join("") + "</div>" +
      (none.length ? '<details><summary class="hint">' + none.length + " lines had no matching " + esc(b.supplier) + " item</summary><div class=\"hint\" style=\"font-size:13px\">" +
        none.slice(0, 80).map(function (x) { return esc(x.row.desc + " · " + fmtMoney(x.row.price)); }).join("<br>") + "</div></details>" : "") +
      '<div class="btn-row" style="margin-top:14px"><button class="btn" data-action="close-sheet">Cancel</button><button class="btn primary" id="do-import">Import ticked prices</button></div>';
    openSheet(h, function (sheet) {
      var btn = sheet.querySelector("#do-import");
      var count = function () { var n = sheet.querySelectorAll("[data-i]:checked").length; btn.textContent = "Import " + n + " prices"; btn.disabled = !n; };
      sheet.addEventListener("change", count);
      count();
      btn.addEventListener("click", function () {
        var rows = {};
        sheet.querySelectorAll("[data-i]:checked").forEach(function (cb) {
          var x = withItem[+cb.getAttribute("data-i")], prev = rows[x.item.key];
          if (!prev || x.row.price < prev.price) rows[x.item.key] = { item_key: x.item.key, item_name: x.item.name, unit: x.item.unit, price: +x.row.price.toFixed(4) };
        });
        var arr = Object.keys(rows).map(function (k) { return rows[k]; });
        btn.disabled = true;
        Cloud.upsertBookItems(b.id, arr).then(refreshBooks).then(function () { closeSheet(); toast(arr.length + " job prices imported"); render(); },
          function (ex) { btn.disabled = false; toast(ex.message || "Import failed"); });
      });
    });
  }

  // ----- vendor invoices & approval
  function canReviewInvoices() { return Cloud.enabled && !!Cloud.user && !access().blocked && !isField() && (access().role === "admin" || !!access().can_review_invoices); }
  // Non-admins only see invoices for jobs in their divisions (no divisions = none; no job yet = admin only),
  // plus invoices they uploaded themselves. The database enforces the same rule.
  function getInvoices() {
    var all = store.get("invoices", []);
    if (isAdmin()) return all;
    var me = Cloud.user ? String(Cloud.user.email || "").toLowerCase() : "", mine = myDivisions();
    return all.filter(function (i) {
      if (String(i.uploaded_by || "").toLowerCase() === me) return true;
      var j = i.job_number || invJob(i);
      return !!j && mine.indexOf(jobDivision(j)) >= 0;
    });
  }
  function currentInvoice() { return getInvoices().filter(function (x) { return x.id === state.invoiceId; })[0] || null; }
  var INV_STATUS = {
    processing: ["busy", "AI checking…"],
    mismatch: ["bad", "Pricing doesn't match"],
    no_order: ["warn", "No order found"],
    error: ["warn", "Couldn't read"],
    matched: ["ok", "Matches order"],
    approved: ["done", "Approved"],
    sent_back: ["sent", "Rejected / sent back"]
  };
  // Checked before lower prices counted as fine: a "mismatch" whose only differences are lower prices matches.
  function invStatus(i) { return i.status === "mismatch" && i.comparison && !invIssues(i).length ? "matched" : i.status; }
  var INV_FILTERS = [
    ["attention", "Needs review", function (i) { var st = invStatus(i); return st === "mismatch" || st === "no_order" || st === "error"; }],
    ["matched", "Matches order", function (i) { return invStatus(i) === "matched"; }],
    ["processing", "Checking", function (i) { return i.status === "processing"; }],
    ["approved", "Approved", function (i) { return i.status === "approved"; }],
    ["sent_back", "Rejected", function (i) { return i.status === "sent_back"; }],
    ["all", "All", function () { return true; }]
  ];
  function invBadge(st) { var m = INV_STATUS[st] || ["", st]; return '<span class="inv-badge ' + m[0] + '">' + esc(m[1]) + "</span>"; }
  function refreshInvoices() {
    if (!canReviewInvoices() || !navigator.onLine) return Promise.resolve();
    return Cloud.listInvoices().then(function (list) { store.set("invoices", list); store.set("invoicesSetupMissing", false); saveInvoiceJobs(list); }, function (e) {
      if (/PGRST205|42P01|does not exist|schema cache/i.test((e && (e.code + " " + e.message)) || "")) store.set("invoicesSetupMissing", true);
    });
  }
  // Save each invoice's job # (from its order, order number, PO / references or price-list check) so the database
  // can limit invoices by division. Quietly does nothing until supabase/divisions.sql adds the column.
  function saveInvoiceJobs(list) {
    if (store.get("invJobColMissing", false) && Date.now() - store.get("invJobColCheck", 0) < 6 * 3600 * 1000) return;
    var todo = list.filter(function (i) { return i.status !== "processing" && !i.job_number && invJob(i); }).slice(0, 25);
    var chain = Promise.resolve();
    todo.forEach(function (i) {
      chain = chain.then(function () { return Cloud.updateInvoice(i.id, { job_number: invJob(i) }); }).then(function () { i.job_number = invJob(i); });
    });
    chain.then(function () { store.set("invJobColMissing", false); }, function (e) {
      if (/job_number|column|PGRST204|42703/i.test((e && (e.code + " " + e.message)) || "")) { store.set("invJobColMissing", true); store.set("invJobColCheck", Date.now()); }
    });
  }
  // When the AI service was busy, re-run the check by itself a few minutes later (up to 3 times per invoice).
  var BUSY_RE = /overloaded|limit was reached|high demand|took too long|\b(429|503|504)\b/i, AUTO_TRIES = 3, AUTO_WAIT = 2 * 60 * 1000;
  // A check that has said "processing" for over 4 minutes was cut off (e.g. the function's time limit).
  function invStalled(inv) { return inv.status === "processing" && Date.now() - new Date(inv.updated_at || inv.created_at).getTime() > 4 * 60 * 1000; }
  function autoRetryInfo(inv) {
    if (!invStalled(inv) && (inv.status !== "error" || !BUSY_RE.test(inv.error || ""))) return null;
    var tries = (store.get("invAutoRetry", {})[inv.id] || 0);
    if (tries >= AUTO_TRIES) return { done: true, tries: tries };
    return { done: false, tries: tries, due: new Date(inv.updated_at || inv.created_at).getTime() + AUTO_WAIT };
  }
  function autoRetryInvoices() {
    if (!canReviewInvoices() || !navigator.onLine) return;
    getInvoices().forEach(function (inv) {
      var a = autoRetryInfo(inv);
      if (!a || a.done || Date.now() < a.due) return;
      var m = store.get("invAutoRetry", {}); m[inv.id] = a.tries + 1; store.set("invAutoRetry", m);
      ensureInvoiceText(inv).then(function () { return Cloud.runInvoiceAgent(inv.id); }).then(refreshInvoices).then(function () {
        if (state.view === "invoices" || state.view === "invoice") { render(); pollInvoices(); }
      }, function () { /* try again next time */ });
    });
  }
  // While the agent is working (or a busy retry is waiting), check back every few seconds.
  var invPoll = null;
  function pollInvoices() {
    clearTimeout(invPoll);
    if (state.view !== "invoices" && state.view !== "invoice") return;
    var waiting = getInvoices().some(function (i) { var a = autoRetryInfo(i); return a && !a.done; });
    if (waiting) invPoll = setTimeout(function () { autoRetryInvoices(); pollInvoices(); }, 20000);
    if (!getInvoices().some(function (i) { return i.status === "processing" && !invStalled(i); })) return;
    clearTimeout(invPoll);
    invPoll = setTimeout(function () {
      refreshInvoices().then(function () { if (state.view === "invoices" || state.view === "invoice") { var y = window.scrollY; render(); window.scrollTo(0, y); } });
    }, 4000);
  }

  VIEWS.invoices = function () {
    var h = topbar("Invoice Approval", "Vendor invoices checked against orders", backBtn("home", "Home"), syncPill());
    h += '<main class="page">';
    if (!canReviewInvoices()) return h + '<div class="empty">Only admins and people with invoice permission can see invoices.</div></main>';
    if (store.get("invoicesSetupMissing", false)) h += '<div class="notice"><b>Database setup not finished.</b> Run <code>supabase/invoices.sql</code> once in Supabase, then reopen this screen.</div>';
    if (!isAdmin()) h += '<p class="hint" style="margin-top:0">' + (myDivisions().length ? "Showing invoices for Division" + (myDivisions().length === 1 ? " " : "s ") + esc(myDivisions().join(", ")) + " jobs, plus ones you uploaded."
      : "You don't have a division yet, so you only see invoices you upload. Ask an admin to assign your divisions.") + "</p>";
    h += '<button class="btn primary big block" data-action="inv-upload">' + ICON.plus + "Upload invoices</button>" +
      '<input type="file" id="inv-file" accept="application/pdf,image/*" multiple hidden>' +
      '<p class="hint">PDF or a photo. The AI reads each invoice, finds the matching order and flags any line whose price doesn\'t match.</p>';
    var all = getInvoices(), f = state.invFilter || "attention";
    all = all.filter(invMatchesFilter);
    h += '<div class="chips">' + INV_FILTERS.map(function (x) {
      var n = all.filter(x[2]).length;
      return '<button class="chip' + (f === x[0] ? " on" : "") + '" data-action="inv-filter" data-f="' + x[0] + '">' + esc(x[1]) + (x[0] !== "all" ? " (" + n + ")" : "") + "</button>";
    }).join("") + "</div>";
    var list = invListFor(f), sel = state.invSel, groups = invGroups(f, list);
    var nf = invFilterCount(), fo = state.invFltOpen;
    if (getInvoices().length && f !== "processing") {
      h += '<div class="inv-tools">' +
        '<button class="chip' + (nf ? " on" : "") + '" data-action="inv-flt-toggle">' + ICON.search + (nf === 1 && invFlt().supplier ? esc(invFlt().supplier) : nf === 1 && invFlt().job ? "Job " + esc(invFlt().job) : "Filter" + (nf ? " (" + nf + ")" : "")) + "</button>" +
        (invSortable(f) ? '<span class="hint" style="margin:0">Sort:</span>' +
        '<button class="chip' + (invSortMode() === "supplier" ? " on" : "") + '" data-action="inv-sort" data-s="supplier">Supplier</button>' +
        '<button class="chip' + (invSortMode() === "job" ? " on" : "") + '" data-action="inv-sort" data-s="job">Job</button>' +
        '<button class="chip' + (invSortMode() === "date" ? " on" : "") + '" data-action="inv-sort" data-s="date">Date</button>' : "") +
        (list.length ? '<button class="chip" style="margin-left:auto" data-action="inv-select">' + (sel ? "Cancel selecting" : "Select for PDF") + "</button>" : "") + "</div>";
      if (fo || nf) h += invFilterHtml(fo);
    }
    if (!list.length) h += '<div class="empty">' + (nf ? "No invoices match the filter." : all.length ? "Nothing here." : "No invoices uploaded yet.") + "</div>";
    else {
      h += groups.map(function (g) {
        return (g.name ? '<div class="inv-group"><b>' + esc(g.name) + "</b> <span class=\"hint\" style=\"margin:0\">(" + g.items.length + ")</span>" +
          (sel ? '<button class="btn small" data-action="inv-sel-group" data-g="' + esc(g.name) + '">' + (g.items.every(function (i) { return sel[i.id]; }) ? "Unselect" : "Select all") + "</button>" : "") + "</div>" : "") +
          '<div class="tile-list">' + g.items.map(invTileHtml).join("") + "</div>";
      }).join("");
    }
    if (sel) {
      var picked = list.filter(function (i) { return sel[i.id]; }), n = picked.length, tt = invTotals(picked);
      h += '<div class="inv-selbar"><span><b>' + n + "</b> selected" + (n ? '<br><small>Total ' + fmtMoney(tt.total) + (tt.over > 0 ? ' · <b class="neg">Overbilled ' + fmtMoney(tt.over) + "</b>" : "") + "</small>" : "") + "</span>" +
        '<button class="btn small" data-action="inv-sel-all">' + (n === list.length ? "Clear" : "Select all") + "</button>" +
        '<button class="btn primary small" data-action="inv-export-pdf"' + (n ? "" : " disabled") + ">Combined PDF</button></div>";
    }
    return h + "</main>";
  };
  AFTER.invoices = function () {
    // Filter fields: apply as you type / pick, keep focus in the search box.
    [["if-sup", "supplier", "change"], ["if-job", "job", "change"], ["if-from", "from", "change"], ["if-to", "to", "change"], ["if-q", "q", "input"]].forEach(function (x) {
      var el = document.getElementById(x[0]);
      if (el) el.addEventListener(x[2], function () {
        invFlt()[x[1]] = el.value.trim();
        var y = window.scrollY, pos = el.selectionStart; render(); window.scrollTo(0, y);
        var again = document.getElementById(x[0]);
        if (x[0] === "if-q" && again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (e) { /* ignore */ } }
      });
    });
    var inp = document.getElementById("inv-file");
    if (inp) inp.addEventListener("change", function () {
      var files = Array.prototype.slice.call(inp.files || []);
      inp.value = "";
      if (!files.length) return;
      if (!navigator.onLine) { toast("Connect to the internet to upload invoices"); return; }
      toast("Uploading " + files.length + " invoice" + (files.length === 1 ? "" : "s") + "…");
      Promise.all(files.map(function (f) {
        return (isPdf(f.type) || isPdf(f.name) ? readPdfLines(f) : Promise.resolve("")).then(function (text) { return Cloud.uploadInvoice(f, text); })
          .then(null, function (e) { toast(f.name + ": " + (e.message || "upload failed")); });
      }))
        .then(refreshInvoices).then(function () { state.invFilter = "processing"; render(); });
    });
    pollInvoices();
  };

  // After approving / rejecting: open the next invoice still waiting for a decision, in list order (the tab the reviewer
  // was working in first, then the other one). Call before the update so the position in the list is known.
  function nextInvoiceAfter(inv) {
    var tab = state.invFilter === "matched" ? "matched" : "attention", other = tab === "matched" ? "attention" : "matched";
    var inTab = function (t) { return (INV_FILTERS.filter(function (x) { return x[0] === t; })[0])[2]; };
    var before = getInvoices().map(function (i) { return i.id; }), pos = before.indexOf(inv.id);
    return function (msg) {
      var all = getInvoices().filter(function (i) { return i.id !== inv.id; });
      var rank = function (i) { var k = before.indexOf(i.id); return k < 0 ? -1 : k; };
      var pick = function (t) {
        var list = all.filter(inTab(t));
        return list.filter(function (i) { return rank(i) > pos; })[0] || list[0] || null;
      };
      var next = pick(tab), t = tab;
      if (!next) { next = pick(other); t = other; }
      state.invFilter = next ? t : "attention";
      if (!next) { toast(msg + ". No more invoices to review."); go("invoices"); return; }
      var left = all.filter(inTab("attention")).length + all.filter(inTab("matched")).length;
      toast(msg + ". Next invoice (" + left + " left to review)");
      state.invPLOpen = null;
      go("invoice", { invoiceId: next.id });
    };
  }
  // ----- invoice list: sorting (supplier / date) and selecting invoices for one combined PDF
  function invDateMs(i) {
    var d = String(i.invoice_date || "").trim(), m;
    if ((m = d.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/))) return new Date(+m[3] < 100 ? 2000 + +m[3] : +m[3], m[1] - 1, +m[2]).getTime();
    if ((m = d.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return new Date(+m[1], m[2] - 1, +m[3]).getTime();
    var t = Date.parse(d);
    return isNaN(t) ? new Date(i.created_at).getTime() : t;
  }
  // Filter (supplier, invoice date range, search text). Kept for this session.
  function invFlt() { return state.invFlt || (state.invFlt = { supplier: "", job: "", from: "", to: "", q: "" }); }
  function invFilterCount() { var f = invFlt(); return (f.supplier ? 1 : 0) + (f.job ? 1 : 0) + (f.from || f.to ? 1 : 0) + (f.q ? 1 : 0); }
  // Job # of an invoice: its order's job, else the job # in its order number / references, else the one picked in its price-list check.
  function invJob(i) {
    var o = orderForInvoice(i);
    if (o && o.jobNumber) return jobKey(o.jobNumber);
    var pl0 = (store.get("invPL", {})[i.id] || {}).job;
    if (pl0) return jobKey(pl0);
    if (i.job_number) return jobKey(i.job_number);
    var m = String(i.order_number || "").match(/^(.+)-\d{3}$/);
    if (m) return jobKey(m[1]);
    var pl = (store.get("invPL", {})[i.id] || {}).job;
    return jobKey(pl != null && pl !== "" ? pl : guessInvoiceJob(i));
  }
  function invMatchesFilter(i) {
    var f = invFlt();
    if (f.supplier && invSupplierName(i) !== f.supplier) return false;
    if (f.job && invJob(i) !== jobKey(f.job)) return false;
    if (f.from || f.to) {
      var t = invDateMs(i);
      if (f.from && t < new Date(f.from + "T00:00:00").getTime()) return false;
      if (f.to && t > new Date(f.to + "T23:59:59").getTime()) return false;
    }
    if (f.q) {
      var ex = i.extracted || {}, hay = [i.invoice_number, i.order_number, i.vendor_name, i.supplier, i.file_name, ex.po_number, ex.job_reference, i.notes]
        .concat(ex.other_references || []).join(" ").toLowerCase();
      if (f.q.toLowerCase().split(/\s+/).some(function (w) { return w && hay.indexOf(w) < 0; })) return false;
    }
    return true;
  }
  function invFilterHtml(open) {
    var f = invFlt(), sups = {}, jobs = {};
    getInvoices().forEach(function (i) { sups[invSupplierName(i)] = 1; var j = invJob(i); if (j) jobs[j] = 1; });
    if (!open) return '<div class="hint" style="margin:-4px 0 10px">Filtered: ' + esc([f.supplier, f.job ? "Job " + f.job : "", f.from || f.to ? (f.from || "…") + " to " + (f.to || "…") : "", f.q ? '"' + f.q + '"' : ""].filter(Boolean).join(" · ")) +
      ' <button class="link-btn" data-action="inv-flt-clear">Clear</button></div>';
    return '<div class="card inv-flt"><div class="filters">' +
      '<label class="field"><span>Company</span><select class="input" id="if-sup"><option value="">All companies</option>' +
      Object.keys(sups).sort().map(function (x) { return "<option" + (x === f.supplier ? " selected" : "") + ">" + esc(x) + "</option>"; }).join("") + "</select></label>" +
      '<label class="field"><span>Job #</span><select class="input" id="if-job"><option value="">All jobs</option>' +
      Object.keys(jobs).sort(function (a, b) { return a.localeCompare(b, undefined, { numeric: true }); }).map(function (x) { return "<option" + (x === jobKey(f.job) ? " selected" : "") + ">" + esc(x) + "</option>"; }).join("") + "</select></label>" +
      '<label class="field full"><span>Search</span><input class="input" id="if-q" type="search" value="' + esc(f.q) + '" placeholder="Invoice #, order / job #, PO"></label>' +
      '<label class="field"><span>Invoice date from</span><input class="input" id="if-from" type="date" value="' + esc(f.from) + '"></label>' +
      '<label class="field"><span>to</span><input class="input" id="if-to" type="date" value="' + esc(f.to) + '"></label></div>' +
      '<div class="btn-row"><button class="btn small" data-action="inv-flt-clear">Clear filter</button><button class="btn small primary" data-action="inv-flt-toggle">Done</button></div></div>';
  }
  function invSupplierName(i) { return i.supplier || i.vendor_name || "Unknown supplier"; }
  function invSortable(f) { return f === "approved" || f === "sent_back" || f === "all"; }
  function invSortMode() { return store.get("invSort", "supplier"); }
  function invListFor(f) {
    var fn = (INV_FILTERS.filter(function (x) { return x[0] === f; })[0] || INV_FILTERS[5])[2], list = getInvoices().filter(fn).filter(invMatchesFilter);
    if (!invSortable(f)) return list;
    var byDate = function (a, b) { return invDateMs(b) - invDateMs(a) || (a.created_at < b.created_at ? 1 : -1); };
    var mode = invSortMode();
    if (mode === "date") return list.slice().sort(byDate);
    return list.slice().sort(function (a, b) {
      var ga = invGroupName(a, mode), gb = invGroupName(b, mode), na = ga === NO_JOB, nb = gb === NO_JOB;
      return (na - nb) || ga.localeCompare(gb, undefined, { numeric: true }) || byDate(a, b);
    });
  }
  var NO_JOB = "No job #";
  function invGroupName(i, mode) { if (mode === "job") { var j = invJob(i); return j ? "Job " + j : NO_JOB; } return invSupplierName(i); }
  function invGroups(f, list) {
    var mode = invSortMode();
    if (!invSortable(f) || mode === "date") return [{ name: "", items: list }];
    var out = [];
    list.forEach(function (i) { var n = invGroupName(i, mode); if (!out.length || out[out.length - 1].name !== n) out.push({ name: n, items: [] }); out[out.length - 1].items.push(i); });
    return out;
  }
  function invTileHtml(i) {
    var st = invStatus(i), nBad = i.comparison ? invIssues(i).length : i.mismatch_count, sel = state.invSel;
    return '<button class="tile inv-tile ' + st + (sel && sel[i.id] ? " picked" : "") + '" data-action="' + (sel ? "inv-toggle-sel" : "open-invoice") + '" data-id="' + esc(i.id) + '">' +
      (sel ? '<span class="inv-check" aria-hidden="true">' + (sel[i.id] ? "✓" : "") + "</span>" : "") + '<div class="t-main">' +
      '<div class="t-title">' + esc(i.vendor_name || i.supplier || i.file_name || "Invoice") + (i.invoice_number ? " · #" + esc(i.invoice_number) : "") + "</div>" +
      '<div class="t-sub">' + (i.invoice_date ? "Invoice date " + esc(i.invoice_date) + " · " : "") + (i.order_number ? "Order " + esc(i.order_number) : i.status === "processing" ? "Reading invoice…" : "No order matched") +
      (i.total != null ? " · " + fmtMoney(i.total) : "") + "</div>" +
      '<div class="t-sub">' + invBadge(st) + (nBad ? ' <b class="neg">' + nBad + " line" + (nBad === 1 ? "" : "s") + " flagged</b>" : "") +
      " · " + esc(fmtDate(i.created_at)) + "</div></div>" + (sel ? "" : '<span class="chev">›</span>') + "</button>";
  }
  // One PDF with every selected invoice's uploaded file, in list order. PDFs are copied page by page; photos become a page each.
  function imageToJpeg(blob) {
    return new Promise(function (res, rej) {
      var img = new Image(), url = URL.createObjectURL(blob);
      img.onload = function () {
        var k = Math.min(1, 2200 / Math.max(img.naturalWidth, img.naturalHeight)), c = document.createElement("canvas");
        c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
        var g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(function (b) { b ? b.arrayBuffer().then(res, rej) : rej(new Error("couldn't convert the photo")); }, "image/jpeg", 0.85);
      };
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error("this photo format can't be opened here")); };
      img.src = url;
    });
  }
  // Overbilled amount on an invoice: lines billed above the order price (or, with no order, above our price list / job price).
  function invOverbilled(inv) {
    var rows = invCompareRows(inv);
    if (rows.length) return round2(rows.reduce(function (a, r) { return a + (r.status === "price" && r.price_diff > 0 && r.inv_qty ? r.price_diff * r.inv_qty : 0); }, 0));
    var saved = store.get("invPL", {})[inv.id] || {}, sup = saved.supplier || inv.supplier || "", job = saved.job != null ? saved.job : guessInvoiceJob(inv);
    if (!sup || !((inv.extracted || {}).lines || []).length) return 0;
    return round2(priceListCheck(inv, sup, job).reduce(function (a, r) { return a + (r.status === "price" && r.diff > 0 && r.line.quantity ? r.diff * r.line.quantity : 0); }, 0));
  }
  function invTotals(list) {
    var t = { total: 0, over: 0, noTotal: 0, overCount: 0 };
    list.forEach(function (i) {
      if (i.total != null && !isNaN(+i.total)) t.total += +i.total; else t.noTotal++;
      var o = invOverbilled(i); if (o > 0) { t.over += o; t.overCount++; }
    });
    t.total = round2(t.total); t.over = round2(t.over);
    return t;
  }
  // Summary page(s) at the front of the combined PDF: one row per invoice with its total and overbilled amount.
  function addSummaryPages(L, out, list, skipped, title) {
    return out.embedFont(L.StandardFonts.Helvetica).then(function (font) {
      return out.embedFont(L.StandardFonts.HelveticaBold).then(function (bold) {
        var clean = function (t) { return String(t == null ? "" : t).replace(/[^\x20-\x7E\xA0-\xFF]/g, ""); };
        var fit = function (t, f, size, w) { t = clean(t); if (f.widthOfTextAtSize(t, size) <= w) return t; while (t && f.widthOfTextAtSize(t + "...", size) > w) t = t.slice(0, -1); return t + "..."; };
        var money = function (n) { return "$" + (+n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ","); };
        var dark = L.rgb(0.1, 0.1, 0.12), grey = L.rgb(0.42, 0.45, 0.5), red = L.rgb(0.7, 0.06, 0.1), line = L.rgb(0.85, 0.87, 0.9);
        var cols = [["Supplier", 40, 118], ["Invoice #", 160, 86], ["Date", 248, 62], ["Job", 312, 50], ["Status", 364, 64], ["Total", 430, 66, 1], ["Overbilled", 498, 74, 1]];
        var t = invTotals(list), W = 612, H = 792, size = 9, rowH = 16, pages = [], page, y;
        function newPage(first) {
          page = out.insertPage(pages.length, [W, H]); pages.push(page);
          y = H - 48;
          if (first) {
            page.drawText("Kim Industries - Invoice summary", { x: 40, y: y, size: 16, font: bold, color: dark }); y -= 18;
            page.drawText(clean(title + " - " + list.length + " invoice" + (list.length === 1 ? "" : "s") + " - " + new Date().toLocaleDateString()), { x: 40, y: y, size: 10, font: font, color: grey }); y -= 26;
            [["Invoice total", money(t.total) + (t.noTotal ? "  (" + t.noTotal + " without a total)" : ""), dark],
              ["Overbilled", money(t.over) + (t.overCount ? "  on " + t.overCount + " invoice" + (t.overCount === 1 ? "" : "s") : ""), t.over > 0 ? red : dark]].forEach(function (r) {
              page.drawText(r[0], { x: 40, y: y, size: 11, font: font, color: grey });
              page.drawText(clean(r[1]), { x: 140, y: y, size: 12, font: bold, color: r[2] }); y -= 18;
            });
            y -= 12;
          }
          cols.forEach(function (c) { var tx = c[0]; page.drawText(tx, { x: c[3] ? c[1] + c[2] - bold.widthOfTextAtSize(tx, size) : c[1], y: y, size: size, font: bold, color: grey }); });
          y -= 6; page.drawLine({ start: { x: 40, y: y }, end: { x: W - 40, y: y }, thickness: 0.8, color: line }); y -= rowH - 4;
        }
        newPage(true);
        list.forEach(function (i) {
          if (y < 60) newPage(false);
          var o = invOverbilled(i);
          var vals = [invSupplierName(i), i.invoice_number || "-", i.invoice_date || "-", invJob(i) || "-", (INV_STATUS[invStatus(i)] || ["", i.status])[1],
            i.total != null ? money(i.total) : "-", o > 0 ? money(o) : "-"];
          cols.forEach(function (c, k) {
            var f = k === 6 && o > 0 ? bold : font, tx = fit(vals[k], f, size, c[2] - 4);
            page.drawText(tx, { x: c[3] ? c[1] + c[2] - f.widthOfTextAtSize(tx, size) : c[1], y: y, size: size, font: f, color: k === 6 && o > 0 ? red : dark });
          });
          y -= rowH;
        });
        if (y < 80) newPage(false);
        page.drawLine({ start: { x: 40, y: y + rowH - 6 }, end: { x: W - 40, y: y + rowH - 6 }, thickness: 0.8, color: line });
        page.drawText("Total", { x: 40, y: y - 2, size: 10, font: bold, color: dark });
        [[5, money(t.total), dark], [6, money(t.over), t.over > 0 ? red : dark]].forEach(function (r) {
          var c = cols[r[0]]; page.drawText(r[1], { x: c[1] + c[2] - bold.widthOfTextAtSize(r[1], 10), y: y - 2, size: 10, font: bold, color: r[2] });
        });
        y -= 22;
        var notes = ["Overbilled = lines billed above our order price (or, with no order, above our price list / job price), times the quantity billed."]
          .concat(skipped.length ? ["Not in this PDF (file couldn't be read): " + skipped.join("; ")] : []);
        notes.forEach(function (n) {
          var words = clean(n).split(" "), ln = "";
          words.forEach(function (w) {
            if (font.widthOfTextAtSize(ln + " " + w, 8) > W - 80) { if (y < 40) newPage(false); page.drawText(ln, { x: 40, y: y, size: 8, font: font, color: grey }); y -= 11; ln = w; } else ln = ln ? ln + " " + w : w;
          });
          if (ln) { page.drawText(ln, { x: 40, y: y, size: 8, font: font, color: grey }); y -= 14; }
        });
      });
    });
  }
  function exportInvoicesPdf(list, title) {
    var skipped = [], included = [];
    return (window.PDFLib ? Promise.resolve() : loadScript("js/vendor/pdf-lib.min.js")).then(function () {
      var L = window.PDFLib;
      return L.PDFDocument.create().then(function (out) {
        var chain = Promise.resolve();
        list.forEach(function (inv) {
          var label = invSupplierName(inv) + (inv.invoice_number ? " #" + inv.invoice_number : " (" + (inv.file_name || "invoice") + ")");
          chain = chain.then(function () { return Cloud.downloadInvoiceFile(inv.file_path); }).then(function (blob) {
            var type = inv.file_type || blob.type || "", pdf = isPdf(type) || isPdf(inv.file_name || "") || isPdf(inv.file_path || "");
            if (pdf) return blob.arrayBuffer().then(function (buf) { return L.PDFDocument.load(buf, { ignoreEncryption: true }); }).then(function (src) {
              return out.copyPages(src, src.getPageIndices()).then(function (pages) { pages.forEach(function (pg) { out.addPage(pg); }); });
            });
            return imageToJpeg(blob).then(function (buf) { return out.embedJpg(buf); }).then(function (img) {
              var land = img.width > img.height, W = land ? 792 : 612, H = land ? 612 : 792, m = 18;
              var k = Math.min((W - 2 * m) / img.width, (H - 2 * m) / img.height), w = img.width * k, hh = img.height * k;
              out.addPage([W, H]).drawImage(img, { x: (W - w) / 2, y: (H - hh) / 2, width: w, height: hh });
            });
          }).then(function () { included.push(inv); }, function (e) { skipped.push(label + ": " + (e && e.message || "couldn't be read")); });
        });
        return chain.then(function () {
          if (!out.getPageCount()) throw new Error("None of the selected invoice files could be read." + (skipped.length ? "\n" + skipped.join("\n") : ""));
          return addSummaryPages(L, out, included, skipped, title || "Invoices").then(function () { return out.save(); });
        });
      });
    }).then(function (bytes) { return { blob: new Blob([bytes], { type: "application/pdf" }), skipped: skipped, included: included }; });
  }
  // Combined PDF is ready: email it (prefilled like the incorrect-invoice email) or just download it.
  function openCombinedPdfSheet(file, list, skipped, tabName) {
    var t = invTotals(list), n = list.length;
    var subject = "Invoices - " + tabName + " - " + n + " invoice" + (n === 1 ? "" : "s") + " - " + fmtMoney(t.total);
    var body = "Hello,\n\nAttached " + (n === 1 ? "is 1 invoice" : "are " + n + " invoices") + " (" + tabName.toLowerCase() + ") in one PDF.\n\n" +
      "Invoice total: " + fmtMoney(t.total) + (t.noTotal ? " (" + t.noTotal + " without a total)" : "") + "\n" +
      (t.over > 0 ? "Overbilled: " + fmtMoney(t.over) + " on " + t.overCount + " invoice" + (t.overCount === 1 ? "" : "s") + "\n" : "") + "\n" +
      list.map(function (i) {
        var o = invOverbilled(i), j = invJob(i);
        return "- " + invSupplierName(i) + (i.invoice_number ? " #" + i.invoice_number : "") + (i.invoice_date ? ", " + i.invoice_date : "") + (j ? ", Job " + j : "") +
          ": " + (i.total != null ? fmtMoney(i.total) : "no total") + (o > 0 ? " (overbilled " + fmtMoney(o) + ")" : "");
      }).join("\n") + "\n\n" +
      (skipped.length ? "Not included (file couldn't be read): " + skipped.join("; ") + "\n\n" : "") +
      "Thank you,\n" + (myName() || "") + "\nKim Industries";
    var canShare = !!(navigator.canShare && navigator.canShare({ files: [file] }));
    var h = "<h2>Combined PDF ready</h2>" +
      '<p class="hint" style="margin-top:0"><b>' + esc(file.name) + "</b> · " + n + " invoice" + (n === 1 ? "" : "s") + " · total " + fmtMoney(t.total) +
      (t.over > 0 ? ' · <b class="neg">overbilled ' + fmtMoney(t.over) + "</b>" : "") + "</p>" +
      (skipped.length ? '<div class="notice"><b>Left out (file couldn\'t be read):</b><br>' + skipped.map(esc).join("<br>") + "</div>" : "") +
      '<label class="field"><span>To</span><input class="input" id="cp-to" type="email" multiple value="' + esc(store.get("invPdfTo", "")) + '" placeholder="email address(es)"></label>' +
      '<label class="field"><span>Subject</span><input class="input" id="cp-subject" value="' + esc(subject) + '"></label>' +
      '<label class="field"><span>Message</span><textarea class="input" id="cp-body" style="min-height:200px">' + esc(body) + "</textarea></label>" +
      '<div class="btn-row" style="margin-top:12px">' +
      (canShare ? '<button class="btn primary" id="cp-share">Open email with the PDF</button>' : "") +
      '<button class="btn' + (canShare ? "" : " primary") + '" id="cp-mail">' + (canShare ? "Download + email draft" : "Download PDF + open email") + "</button></div>" +
      '<p class="hint" style="font-size:13px">' + (canShare ? "Choose your email app, check the message, and send." : "Your email app opens with the subject and message filled in. Attach the downloaded PDF, then send.") + "</p>" +
      '<div class="btn-row"><button class="btn" data-action="close-sheet">Close</button><button class="btn" id="cp-dl">Just download</button></div>';
    openSheet(h, function (sheet) {
      var v = function (id) { return sheet.querySelector(id).value; };
      var remember = function () { store.set("invPdfTo", v("#cp-to").trim()); };
      var share = sheet.querySelector("#cp-share");
      if (share) share.addEventListener("click", function () {
        remember();
        navigator.share({ files: [file], title: v("#cp-subject"), text: v("#cp-body") }).then(function () { closeSheet(); toast("PDF shared"); },
          function (e) { if (!(e && e.name === "AbortError")) toast(e && e.message || "Couldn't open the share sheet"); });
      });
      sheet.querySelector("#cp-mail").addEventListener("click", function () {
        remember();
        downloadBlob(file, file.name);
        var to = v("#cp-to").trim(), sub = v("#cp-subject"), b = v("#cp-body");
        setTimeout(function () { location.href = "mailto:" + encodeURIComponent(to).replace(/%2C/g, ",") + "?subject=" + encodeURIComponent(sub) + "&body=" + encodeURIComponent(b); }, 400);
        setTimeout(function () { closeSheet(); toast("Attach the downloaded PDF to the email"); }, 1200);
      });
      sheet.querySelector("#cp-dl").addEventListener("click", function () { downloadBlob(file, file.name); closeSheet(); toast("PDF downloaded"); });
    });
  }
  function orderForInvoice(inv) { return inv && inv.order_id ? getOrder(inv.order_id) : null; }

  VIEWS.invoice = function () {
    var inv = currentInvoice();
    if (!inv) return VIEWS.invoices();
    var ex = inv.extracted || {}, cmp = inv.comparison || {}, rows = invCompareRows(inv);
    var order = orderForInvoice(inv);
    var h = topbar(inv.invoice_number ? "Invoice #" + inv.invoice_number : "Invoice", inv.vendor_name || inv.supplier || inv.file_name || "", backBtn("invoices", "Invoices"));
    h += '<main class="page">';
    h += '<div class="card inv-head ' + invStatus(inv) + '">' + invBadge(invStatus(inv)) +
      (inv.status === "processing" ? (invStalled(inv) ? '<div class="error-text">This check is taking too long and probably stopped. Tap Re-run AI check below.</div>'
        : '<p class="hint" style="margin:8px 0 0">The AI is reading this invoice. This page updates by itself.</p>') : "") +
      (inv.status !== "error" && inv.status !== "processing" && inv.error ? '<p class="hint" style="margin:8px 0 0">' + esc(inv.error) + "</p>" : "") +
      (inv.status === "error" ? '<div class="error-text">' + esc(inv.error || "Something went wrong.") + "</div>" +
        (function (a) { return !a ? "" : a.done ? '<p class="hint" style="margin:6px 0 0">Tried again ' + a.tries + ' times automatically. Tap Re-run AI check to try once more.</p>'
          : '<p class="hint" style="margin:6px 0 0">The app will try again by itself' + (a.due > Date.now() ? " in about " + Math.max(1, Math.round((a.due - Date.now()) / 60000)) + " min" : " shortly") + " (keep the app open), or tap Re-run AI check.</p>"; })(autoRetryInfo(inv)) : "") +
      '<dl class="kv" style="margin-top:10px">' +
      "<dt>Vendor</dt><dd>" + esc(inv.vendor_name || "-") + (inv.supplier ? " (" + esc(inv.supplier) + ")" : "") + "</dd>" +
      "<dt>Invoice #</dt><dd>" + esc(inv.invoice_number || "-") + "</dd>" +
      "<dt>Date</dt><dd>" + esc(inv.invoice_date || "-") + "</dd>" +
      (ex.po_number ? "<dt>PO / ref</dt><dd>" + esc(ex.po_number) + "</dd>" : "") +
      "<dt>Total</dt><dd>" + (inv.total != null ? fmtMoney(inv.total) : "-") + (ex.freight || ex.tax ? " (" + [ex.freight ? "freight/FSC " + fmtMoney(ex.freight) : "", ex.tax ? "tax " + fmtMoney(ex.tax) : ""].filter(Boolean).join(", ") + ")" : "") + "</dd>" +
      (ex.read_by ? "<dt>Read by</dt><dd>" + esc(ex.read_by) + "</dd>" : "") +
      "<dt>Uploaded</dt><dd>" + esc(fmtDate(inv.created_at)) + " · " + esc((inv.uploaded_by || "").split("@")[0]) + "</dd>" +
      (inv.reviewed_by ? "<dt>Reviewed</dt><dd>" + esc(fmtDate(inv.reviewed_at)) + " · " + esc(inv.reviewed_by.split("@")[0]) + "</dd>" : "") +
      '</dl><button class="btn block" style="margin-top:10px" data-action="inv-view-file">View invoice file</button></div>';

    // order match
    if (inv.status !== "processing" || invStalled(inv)) {
      h += "<h3>Matched order</h3><div class=\"card\">";
      if (order || inv.order_number) {
        h += '<div class="t-title">Order ' + esc(inv.order_number || (order && order.number) || "") + "</div>" +
          '<div class="t-sub">' + (order ? "Job " + esc(order.jobNumber) + " · " + esc(order.supplier) + " · " + esc(fmtDate(order.createdAt)) : "") +
          " · matched by " + esc({ order_number: "order # on the invoice", products: "products on the invoice", manual: "you" }[inv.match_method] || "-") + "</div>" +
          '<div class="btn-row" style="margin-top:10px">' + (order ? '<button class="btn" data-action="inv-open-order">Open order</button>' : "") +
          '<button class="btn" data-action="inv-change-order">Wrong order?</button></div>';
      } else {
        h += '<p class="hint" style="margin-top:0">The AI couldn\'t tell which order this invoice is for. Pick it:</p>' + orderPickerHtml(inv);
      }
      h += "</div>";
    }

    // comparison
    if (rows.length) {
      var bad = rows.filter(function (r) { return r.status === "price" || r.status === "not_on_order"; }), under = rows.filter(function (r) { return r.status === "under"; });
      var underTxt = underSummary(under, function (r) { return r.price_diff; }, function (r) { return r.inv_qty; });
      h += "<h3>Line by line</h3>";
      h += bad.length ? '<div class="notice bad-notice"><b>' + bad.length + (bad.length === 1 ? " line doesn't" : " lines don't") + " match the order:</b><br>" +
        bad.map(function (r) { return "• " + esc(r.description) + " - " + (r.status === "price" ? "billed " + fmtMoney(r.inv_price) + " vs order " + fmtMoney(r.ord_price) : "not on the order"); }).join("<br>") + underTxt + "</div>"
        : '<div class="notice ok-notice">Every billed line matches ' + (under.length ? "or is below " : "") + "the order pricing." + underTxt + "</div>";
      var ign = (cmp.ignored || []).filter(function (c) { return c.amount; });
      if (ign.length) h += '<p class="hint">Not checked against the order: ' + ign.map(function (c) { return esc(c.description) + " " + fmtMoney(c.amount); }).join(", ") + ".</p>";
      h += '<div class="inv-lines">' + rows.map(invRowHtml).join("") + "</div>";
    }

    // price-list check (no order needed)
    if (inv.status !== "processing" && ((inv.extracted || {}).lines || []).length) {
      if (!inv.order_id || state.invPLOpen === inv.id) h += priceListHtml(inv);
      else h += '<button class="btn block" style="margin-top:12px" data-action="inv-pricelist">Check prices against the price list</button>';
    }

    // actions
    if (inv.status !== "processing" || invStalled(inv)) {
      h += '<h3>Review</h3><div class="card"><label class="field"><span>Notes</span><textarea class="input" id="inv-notes" placeholder="Anything to remember about this invoice">' + esc(inv.notes || "") + "</textarea></label>" +
        '<div class="btn-row">' +
        (inv.status !== "approved" ? '<button class="btn brand" data-action="inv-approve">Approve invoice</button>' : "") +
        (inv.status !== "sent_back" ? '<button class="btn danger" data-action="inv-send-back">Reject invoice</button>' : "") +
        '<button class="btn" data-action="inv-rerun">Re-run AI check</button>' +
        (isAdmin() ? '<button class="btn danger" data-action="inv-delete">Delete</button>' : "") + "</div>" +
        (inv.sent_back_at ? '<div class="hint" style="margin:8px 0 0">Rejected' + (inv.status === "sent_back" ? "" : " earlier") + " " + esc(fmtDate(inv.sent_back_at)) + ".</div>" : "") + "</div>";
    } else {
      h += '<div class="btn-row" style="margin-top:12px"><button class="btn" data-action="inv-stop">Cancel check</button>' +
        (isAdmin() ? '<button class="btn danger" data-action="inv-delete">Delete invoice</button>' : "") + "</div>";
    }
    return h + "</main>";
  };
  AFTER.invoice = function () {
    // Price-list check: remember the supplier / job # chosen for this invoice and redraw.
    ["pl-sup", "pl-job"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener("change", function () {
        var inv = currentInvoice(), m = store.get("invPL", {});
        m[inv.id] = { supplier: document.getElementById("pl-sup").value, job: document.getElementById("pl-job").value.trim() };
        store.set("invPL", m);
        if (id === "pl-job" && m[inv.id].job && !inv.order_id) Cloud.updateInvoice(inv.id, { job_number: jobKey(m[inv.id].job) }).then(null, function () { /* column not added yet */ });
        var y = window.scrollY; render(); window.scrollTo(0, y);
      });
    });
    var n = document.getElementById("inv-notes");
    if (n) n.addEventListener("change", function () {
      var inv = currentInvoice();
      Cloud.updateInvoice(inv.id, { notes: n.value }).then(refreshInvoices).then(function () { toast("Notes saved"); }, function (e) { toast(e.message); });
    });
    var sel = document.getElementById("inv-order-pick");
    if (sel) sel.addEventListener("change", function () { document.getElementById("inv-use-order").disabled = !sel.value; });
    pollInvoices();
  };

  function orderPickerHtml(inv) {
    var cands = ((inv.comparison || {}).candidates || []).map(function (c) { return c.id; });
    var orders = getOrders().filter(function (o) { return o.number && o.status === "sent" && (!inv.supplier || o.supplier === inv.supplier); })
      .sort(function (a, b) { return (cands.indexOf(b.id) >= 0) - (cands.indexOf(a.id) >= 0) || (a.createdAt < b.createdAt ? 1 : -1); }).slice(0, 200);
    return '<select class="input" id="inv-order-pick"><option value="">Choose an order…</option>' + orders.map(function (o) {
      return '<option value="' + esc(o.id) + '">' + esc(o.number + " · Job " + o.jobNumber + " · " + o.supplier + " · " + fmtDate(o.createdAt)) + (cands.indexOf(o.id) >= 0 ? "  ★ likely" : "") + "</option>";
    }).join("") + '</select><button class="btn primary block" style="margin-top:10px" id="inv-use-order" data-action="inv-use-order" disabled>Compare with this order</button>';
  }

  // Comparison rows, with lines billed below the order price as "under" (green, noted) - also for invoices checked earlier.
  function invCompareRows(inv) {
    return ((inv.comparison || {}).rows || []).map(function (r) {
      return r.status === "price" && r.price_diff < 0 ? Object.assign({}, r, { status: "under" }) : r;
    });
  }
  function invIssues(inv) { return invCompareRows(inv).filter(function (r) { return r.status === "price" || r.status === "not_on_order"; }); }
  // "Billed $0.25 / LF less (about $12.50 less in total)"
  function lowerNote(diff, qty, unit, what) {
    var tot = qty ? round2(-diff * qty) : 0;
    return "Billed " + fmtMoney(-diff) + (unit ? " / " + unit : "") + " less than " + what + (tot >= 0.01 ? " (about " + fmtMoney(tot) + " less in total)" : "") + ".";
  }
  function underSummary(list, diffOf, qtyOf) {
    if (!list.length) return "";
    var tot = round2(list.reduce(function (a, r) { var q = qtyOf(r); return a + (q ? -diffOf(r) * q : 0); }, 0));
    return "<br>" + list.length + " line" + (list.length === 1 ? " is" : "s are") + " billed below our price" + (tot >= 0.01 ? ", about " + fmtMoney(tot) + " less in total" : "") + ".";
  }
  function invRowHtml(r) {
    var cls = { ok: "ok", under: "ok", price: "bad", not_on_order: "bad", not_invoiced: "info", no_price: "info" }[r.status] || "";
    var label = { ok: "Matches", under: "Lower than order", price: "Price differs", not_on_order: "Not on order", not_invoiced: "Ordered, not billed", no_price: "No price on invoice" }[r.status] || r.status;
    return '<div class="inv-line ' + cls + '"><div class="il-top"><span class="il-status">' + esc(label) + "</span>" +
      (r.price_diff ? '<span class="il-diff ' + (r.price_diff > 0 ? "neg" : "pos") + '">' + (r.price_diff > 0 ? "+" : "") + fmtMoney(r.price_diff) + " / " + esc(r.unit || "") + "</span>" : "") + "</div>" +
      '<div class="il-name">' + esc(r.description) + (r.code ? ' <span class="hint">#' + esc(r.code) + "</span>" : "") + "</div>" +
      '<div class="il-grid"><div><small>Invoice</small>' + (r.inv_qty != null ? esc(fmtQty(r.inv_qty)) + " × " : "") + (r.inv_price != null ? fmtMoney(r.inv_price) : "-") + "</div>" +
      "<div><small>Order" + (r.job_price ? ' <span class="job-price">Job price</span>' : "") + "</small>" + (r.ord_qty != null ? esc(fmtQty(r.ord_qty)) + " × " : "") + (r.ord_price != null ? fmtMoney(r.ord_price) : "-") + "</div></div>" +
      (r.status === "under" ? '<div class="hint pos" style="margin:4px 0 0">' + esc(lowerNote(r.price_diff, r.inv_qty, r.unit, "the order")) + "</div>" : "") +
      (r.qty_note ? '<div class="hint" style="margin:4px 0 0">' + esc(r.qty_note) + "</div>" : "") +
      (r.matched_by === "agent" ? '<div class="hint" style="margin:4px 0 0">Matched by the AI from the description</div>' : "") + "</div>";
  }

  // ---------------------------------------------------------------- price-list check (no order needed)
  // Compares each billed line with our price list for that supplier (and the job's special pricing when a job # is
  // known): by item code first, then by description + size. Runs in the app; nothing is sent anywhere.
  var PL_CHARGE_RE = /\b(sales\s*tax|tax(es)?|freight|fsc|fuel\s*(sur\s*)?charge|surcharge|delivery|shipping|handling|hazmat)\b/i;
  function plCodeNorm(c) { return String(c || "").toUpperCase().replace(/[\s\-_.\/#]/g, "").replace(/O/g, "0").replace(/I/g, "1"); }
  function plUnit(u) { u = String(u || "").toUpperCase(); return { FT: "LF", EACH: "EA", GA: "GAL", GL: "GAL", ROLL: "RL", BOX: "BX", SHT: "SH" }[u] || u; }
  function guessInvoiceJob(inv) {
    var ex = inv.extracted || {}, order = orderForInvoice(inv);
    if (order) return order.jobNumber;
    var refs = [ex.po_number, ex.job_reference].concat(ex.other_references || []).filter(Boolean).join(" ");
    var m = refs.match(/\b(\d{3,5})(?:-\d{3})?\b/);
    return m ? m[1] : "";
  }
  function priceListCheck(inv, supplier, job) {
    var ex = inv.extracted || {};
    var pool = (BY_SUPPLIER[supplier] || []).concat(job ? jobItems(job, supplier) : []);
    ensureIndex();
    var byCode = {};
    var byName = {}, nameKey = function (x) { return String(x || "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim(); };
    pool.forEach(function (it) { var k = plCodeNorm(it.model); if (k.length >= 4 && !byCode[k]) byCode[k] = it; if (!byName[nameKey(it.name)]) byName[nameKey(it.name)] = it; });
    var ctx = { jobNumber: job || "" };
    return (ex.lines || []).filter(function (l) { return !PL_CHARGE_RE.test((l.item_code || "") + " " + (l.description || "")) || /\d\s*(x|")\s*\d|#\d/i.test(l.description || ""); })
      .map(function (l) {
        var it = byCode[plCodeNorm(l.item_code)] || null, how = it ? "code" : "";
        // Same name as an item (e.g. one added from an earlier invoice without a part #).
        if (!it && l.description && byName[nameKey(l.description)]) { it = byName[nameKey(l.description)]; how = "description"; }
        if (!it && l.description) {
          // Description + size: only accept a clear match (same sizes, every word found).
          var res = S.search(pool, l.description);
          var d = S.itemDims(l.description);
          if (!res.partial && res.results.length && d.length) {
            var c = res.results[0], cd = S.itemDims(c.name);
            if (cd.length >= d.length && d.every(function (x, i) { return Math.abs(x.v - cd[i].v) < 1e-6; })) { it = c; how = "description"; }
          }
        }
        var row = { line: l, it: it, how: how, list: null, special: false, status: "unknown", diff: null, note: "" };
        if (!it) return row;
        var p = priceFor(ctx, it);
        row.list = p.price; row.special = p.special; row.book = p.book;
        if (l.unit_price == null) row.status = "no_price";
        else if (!(p.price > 0)) row.status = "no_list";
        else {
          row.diff = Math.round((l.unit_price - p.price) * 10000) / 10000;
          row.status = Math.abs(l.unit_price - p.price) > Math.max(0.01, p.price * 0.002) ? (l.unit_price < p.price ? "under" : "price") : "ok";
        }
        if (l.unit && it.unit && plUnit(l.unit) !== plUnit(it.unit)) {
          row.note = "Units differ: invoice " + l.unit + ", price list " + it.unit + ". Check the price per unit.";
          if (row.status === "price" || row.status === "under") row.status = "check";
        }
        return row;
      });
  }
  // Where the compared price came from, so a wrong one can be traced (and fixed by an admin).
  function plSourceText(r, sup, job) {
    var it = r.it, s = r.how === "description" ? "Matched by description to: " + esc(it.name) + ". " : "Matched by item code to: " + esc(it.name) + ". ";
    if (r.special) return s + "Price from Job " + esc(job) + "'s special pricing (" + esc(r.book || "price book") + ")" + (it.jobOnly ? "." : "; regular price list " + (it.price > 0 ? fmtMoney(it.price) : "TBD") + ".");
    return s + "Price from the regular " + esc(sup) + " price list (item " + esc(it.id) + (it.model ? ", #" + esc(it.model) : "") + ")" +
      (it.edited ? ", edited by an admin" : "") + (job ? "; Job " + esc(job) + " has no special price for it." : ".");
  }
  function priceListHtml(inv) {
    var ex = inv.extracted || {};
    if (!(ex.lines || []).length) return "";
    var saved = store.get("invPL", {})[inv.id] || {};
    var sup = saved.supplier || inv.supplier || "", job = saved.job != null ? saved.job : guessInvoiceJob(inv);
    var h = '<h3>Price-list check</h3><div class="card"><p class="hint" style="margin-top:0">Compares each billed price with our price list' +
      (job ? " and Job " + esc(job) + "'s special pricing" : "") + ". No order needed.</p>" +
      '<div class="filters"><label class="field"><span>Supplier</span><select class="input" id="pl-sup"><option value="">Pick…</option>' +
      SUPPLIERS.map(function (x) { return "<option" + (x === sup ? " selected" : "") + ">" + esc(x) + "</option>"; }).join("") + "</select></label>" +
      '<label class="field"><span>Job # (for job pricing)</span><input class="input" id="pl-job" value="' + esc(job) + '" placeholder="optional"></label></div>';
    if (!sup) return h + '<p class="hint">Pick the supplier to check prices.</p></div>';
    var rows = priceListCheck(inv, sup, job);
    var bad = rows.filter(function (r) { return r.status === "price"; }), unk = rows.filter(function (r) { return r.status === "unknown"; }),
      under = rows.filter(function (r) { return r.status === "under"; });
    var underTxt = underSummary(under, function (r) { return r.diff; }, function (r) { return r.line.quantity; });
    var over = bad.reduce(function (a, r) { return a + (r.diff > 0 && r.line.quantity ? r.diff * r.line.quantity : 0); }, 0);
    h += bad.length ? '<div class="notice bad-notice"><b>' + bad.length + " line" + (bad.length === 1 ? "" : "s") + " billed at a different price than " + (job ? "the job / price list" : "the price list") + "</b>" +
      (over > 0.005 ? "<br>Overbilled by about " + fmtMoney(round2(over)) + " in total." : "") + underTxt + "</div>"
      : '<div class="notice ok-notice">Every line found in the price list is billed at ' + (under.length ? "or below " : "") + "the listed price." + underTxt + "</div>";
    if (unk.length) h += '<p class="hint">' + unk.length + " line" + (unk.length === 1 ? " isn't" : "s aren't") + " in our price list for " + esc(sup) + " and couldn't be checked.</p>" +
      '<button class="btn block" style="margin-bottom:10px" data-action="inv-add-items">' + ICON.plus + (isAdmin() ? "Add " + (unk.length === 1 ? "it" : "these " + unk.length) + " to our pricing"
        : "Ask an admin to add " + (unk.length === 1 ? "it" : "these " + unk.length)) + "</button>";
    h += '<div class="inv-lines">' + rows.map(function (r) {
      var cls = { ok: "ok", under: "ok", price: "bad", check: "bad", unknown: "info", no_list: "info", no_price: "info" }[r.status];
      var label = { ok: "Matches list", under: r.special ? "Lower than job price" : "Lower than list", price: "Price differs", check: "Check units", unknown: "Not in price list", no_list: "No list price", no_price: "No price on invoice" }[r.status];
      var l = r.line;
      return '<div class="inv-line ' + cls + '"><div class="il-top"><span class="il-status">' + label + "</span>" +
        (r.diff && r.status !== "ok" ? '<span class="il-diff ' + (r.diff > 0 ? "neg" : "pos") + '">' + (r.diff > 0 ? "+" : "") + fmtMoney(r.diff) + " / " + esc(l.unit || "") + "</span>" : "") + "</div>" +
        '<div class="il-name">' + esc(l.description) + (l.item_code ? ' <span class="hint">#' + esc(l.item_code) + "</span>" : "") + "</div>" +
        '<div class="il-grid"><div><small>Invoice</small>' + (l.quantity != null ? esc(fmtQty(l.quantity)) + " × " : "") + (l.unit_price != null ? fmtMoney(l.unit_price) : "-") + "</div>" +
        "<div><small>" + (r.special ? '<span class="job-price">Job price</span>' : "Price list") + "</small>" + (r.list != null ? fmtMoney(r.list) + (r.it ? " / " + esc(r.it.unit) : "") : "-") + "</div></div>" +
        (r.status === "under" ? '<div class="hint pos" style="margin:4px 0 0">' + esc(lowerNote(r.diff, l.quantity, r.it.unit, r.special ? "the job price" : "the price list")) + "</div>" : "") +
        (r.it ? '<div class="hint" style="margin:4px 0 0">' + plSourceText(r, sup, job) + "</div>" : "") +
        (r.note ? '<div class="hint" style="margin:4px 0 0">' + esc(r.note) + "</div>" : "") +
        (r.it && isAdmin() && !r.it.jobOnly ? '<button class="btn small" style="margin-top:8px" data-action="catalog-edit" data-key="' + esc(r.it.key) + '">Edit product</button>' : "") +
        (r.status === "unknown" ? '<button class="btn small" style="margin-top:8px" data-action="inv-add-items" data-line="' + esc(l.line) + '">' + (isAdmin() ? "Add to our pricing" : "Ask to add") + "</button>" : "") + "</div>";
    }).join("") + "</div></div>";
    return h;
  }

  // Add invoice lines that aren't in our pricing: to the day-to-day price list, to the job's special price book, or both.
  // Admins save directly; invoice reviewers who aren't admins send price-list requests for an admin to approve.
  function plUnitFor(u) {
    u = String(u || "").toUpperCase();
    if (CAT.units.indexOf(u) >= 0) return u;
    var m = plUnit(u);
    return CAT.units.indexOf(m) >= 0 ? m : "EA";
  }
  function quoteKey(l) {
    var c = String(l.item_code || "").toUpperCase().replace(/[^A-Z0-9.\/]/g, "");
    return "Q-" + (c.length >= 3 ? c : String(l.description || "ITEM").toUpperCase().replace(/[^A-Z0-9.#\/]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60));
  }
  function openAddItemsSheet(inv, lineNo) {
    var saved = store.get("invPL", {})[inv.id] || {};
    var sup = saved.supplier || inv.supplier || "", job = saved.job != null ? saved.job : guessInvoiceJob(inv);
    var rows = priceListCheck(inv, sup, job).filter(function (r) { return r.status === "unknown" && (lineNo == null || String(r.line.line) === String(lineNo)); });
    if (!rows.length) return;
    var admin = isAdmin(), units = CAT.units.slice().sort();
    var h = "<h2>" + (admin ? "Add to our pricing" : "Ask an admin to add") + "</h2>" +
      '<datalist id="ai-cats"><option value="Added Items">' + CAT.categories.slice().sort().map(function (c) { return '<option value="' + esc(c) + '">'; }).join("") + "</datalist>" +
      '<p class="hint" style="margin-top:0">Supplier: <b>' + esc(sup) + "</b>. Check the name, part #, unit and price before saving.</p>";
    if (admin) {
      h += '<div class="field"><span>Add to</span>' +
        '<label class="toggle"><input type="radio" name="ai-to" value="day" checked>Day-to-day price list (every job)</label>' +
        '<label class="toggle"><input type="radio" name="ai-to" value="job">Job special pricing only</label>' +
        '<label class="toggle"><input type="radio" name="ai-to" value="both">Both</label></div>' +
        '<div id="ai-jobbox" hidden><div class="filters"><label class="field"><span>Job #</span><input class="input" id="ai-job" value="' + esc(job) + '" placeholder="e.g. 3425"></label>' +
        '<label class="field"><span>Price book</span><select class="input" id="ai-book"></select></label></div></div>';
    } else {
      h += '<p class="hint">An admin reviews these under Price-list Requests before they are added.</p>';
    }
    h += rows.map(function (r, i) {
      var l = r.line;
      return '<div class="card ai-row" data-i="' + i + '" style="padding:10px 12px;margin:8px 0">' +
        '<label class="toggle" style="margin:0 0 6px"><input type="checkbox" data-f="on" checked><b>' + esc(l.description) + "</b></label>" +
        '<label class="field"><span>Item name</span><input class="input" data-f="name" value="' + esc(l.description) + '"></label>' +
        '<div class="filters"><label class="field"><span>Part #</span><input class="input" data-f="model" value="' + esc(l.item_code || "") + '"></label>' +
        '<label class="field"><span>Unit</span><select class="input" data-f="unit">' + units.map(function (u) { return "<option" + (u === plUnitFor(l.unit) ? " selected" : "") + ">" + esc(u) + "</option>"; }).join("") + "</select></label>" +
        '<label class="field"><span>Price</span><input class="input" data-f="price" type="number" inputmode="decimal" min="0" step="any" value="' + (l.unit_price != null ? esc(l.unit_price) : "") + '"></label>' +
        (admin ? '<label class="field ai-cat"><span>Category</span><input class="input" data-f="category" list="ai-cats" value="Added Items"></label>' : "") + "</div></div>";
    }).join("") +
      '<div class="error-text" id="ai-err" hidden></div>' +
      '<div class="btn-row" style="margin-top:10px"><button class="btn" data-action="close-sheet">Cancel</button><button class="btn primary" id="ai-save">' + (admin ? "Save" : "Send to admin") + "</button></div>";
    openSheet(h, function (sheet) {
      function target() { var el = sheet.querySelector('input[name="ai-to"]:checked'); return el ? el.value : "day"; }
      function books(j) {
        var k = jobKey(j);
        return getBooks().filter(function (b) { return b.supplier === sup && k && bookJobs(b).indexOf(k) >= 0; });
      }
      function fillBooks() {
        var sel = sheet.querySelector("#ai-book");
        if (!sel) return;
        var j = sheet.querySelector("#ai-job").value.trim(), bs = books(j);
        sel.innerHTML = bs.map(function (b) { return '<option value="' + esc(b.id) + '">' + esc(b.name || b.supplier + " job pricing") + (b.active ? "" : " (off)") + "</option>"; }).join("") +
          '<option value="">New book: ' + esc(sup) + " items from invoices</option>";
      }
      function sync() {
        var t = target(), box = sheet.querySelector("#ai-jobbox");
        if (box) box.hidden = t === "day";
        sheet.querySelectorAll(".ai-cat").forEach(function (el) { el.hidden = t === "job"; });
      }
      sheet.querySelectorAll('input[name="ai-to"]').forEach(function (el) { el.addEventListener("change", sync); });
      var jobIn = sheet.querySelector("#ai-job");
      if (jobIn) jobIn.addEventListener("input", fillBooks);
      fillBooks(); sync();
      sheet.querySelector("#ai-save").addEventListener("click", function (e) {
        var err = sheet.querySelector("#ai-err"), t = target(), j = jobIn ? jobIn.value.trim() : job;
        var picks = [];
        sheet.querySelectorAll(".ai-row").forEach(function (card) {
          var v = {}; card.querySelectorAll("[data-f]").forEach(function (el) { v[el.getAttribute("data-f")] = el.type === "checkbox" ? el.checked : el.value.trim(); });
          if (!v.on) return;
          v.price = parseFloat(v.price) || 0; v.line = rows[+card.getAttribute("data-i")].line; v.supplier = sup;
          picks.push(v);
        });
        function fail(m) { err.textContent = m; err.hidden = false; }
        if (!picks.length) return fail("Tick at least one item.");
        if (picks.some(function (v) { return !v.name; })) return fail("Every item needs a name.");
        if (admin && t !== "day" && !j) return fail("Enter the job # for special pricing.");
        if (admin && t !== "day" && picks.some(function (v) { return !(v.price > 0); })) return fail("Special pricing needs a price for every item.");
        if (!navigator.onLine) return fail("Connect to the internet to save.");
        err.hidden = true; e.target.disabled = true;
        var done;
        if (!admin) {
          done = Promise.all(picks.map(function (v) {
            return Cloud.submitCatalogRequest({ supplier: sup, name: v.name, model: v.model, unit: v.unit, price: v.price, job_number: j || null, order_id: inv.order_id || null });
          })).then(function () { return picks.length + " request" + (picks.length === 1 ? "" : "s") + " sent to the admin"; });
        } else {
          done = (t === "job" ? Promise.resolve(null) : Cloud.addCatalogItems(picks)).then(function (ids) {
            if (t === "day") return null;
            var bookId = sheet.querySelector("#ai-book").value;
            return (bookId ? Promise.resolve(bookId) : Cloud.saveBook({ job_number: j, supplier: sup, name: sup + " items from invoices", active: true })).then(function (id) {
              return Cloud.upsertBookItems(id, picks.map(function (v, i) {
                return { item_key: sup + "|" + (ids ? ids[i] : quoteKey({ item_code: v.model, description: v.name })), item_name: v.name, unit: v.unit, price: +v.price.toFixed(4) };
              }));
            });
          }).then(function () {
            return Promise.all([refreshCatalog(), t === "day" ? null : refreshBooks()]);
          }).then(function () {
            if (t !== "day") { var m = store.get("invPL", {}); m[inv.id] = { supplier: sup, job: j }; store.set("invPL", m); }
            var n = picks.length + " item" + (picks.length === 1 ? "" : "s");
            return t === "day" ? n + " added to the day-to-day price list" : t === "job" ? n + " added to Job " + j + " special pricing" : n + " added to the price list and Job " + j + " special pricing";
          });
        }
        done.then(function (msg) { closeSheet(); toast(msg); var y = window.scrollY; render(); window.scrollTo(0, y); },
          function (ex) { e.target.disabled = false; fail(ex.message || "Couldn't save"); });
      });
    });
  }

  // Reject: optionally email the supplier (subject "Incorrect invoice <#>", our order PDF when there is one + their invoice),
  // then mark the invoice rejected. Works without an order: the price-list check supplies the lines that are wrong.
  function rejectLines(inv, order) {
    if (order) return invIssues(inv).map(function (r) {
      return "- " + r.description + (r.code ? " [#" + r.code + "]" : "") + ": " + (r.status === "price"
        ? "invoiced at " + fmtMoney(r.inv_price) + "/" + (r.unit || "unit") + ", our order price is " + fmtMoney(r.ord_price)
        : "not on our order");
    });
    var saved = store.get("invPL", {})[inv.id] || {}, sup = saved.supplier || inv.supplier || "", job = saved.job != null ? saved.job : guessInvoiceJob(inv);
    if (!sup) return [];
    return priceListCheck(inv, sup, job).filter(function (r) { return r.status === "price" || r.status === "check"; }).map(function (r) {
      var l = r.line;
      return "- " + l.description + (l.item_code ? " [#" + l.item_code + "]" : "") + ": invoiced at " + fmtMoney(l.unit_price) + "/" + (l.unit || "unit") +
        ", our " + (r.special ? "job " + job + " price" : "price") + " is " + fmtMoney(r.list) + "/" + r.it.unit;
    });
  }
  function openSendBackSheet(inv) {
    var order = orderForInvoice(inv);
    var lines = rejectLines(inv, order);
    var subject = "Incorrect invoice " + (inv.invoice_number || "");
    var to = emailFor(inv.supplier || (order && order.supplier)) || "";
    var ref = order ? "our order " + order.number + " (Job " + order.jobNumber + ")" : inv.order_number ? "our order " + inv.order_number : "our pricing";
    var body = "Hello,\n\nInvoice " + (inv.invoice_number || "") + " does not match " + ref + ". Please review and send a corrected invoice.\n\n" +
      (lines.length ? "Lines that don't match:\n" + lines.join("\n") + "\n\n" : "") +
      (order ? "Our order and your invoice are attached." : "Your invoice is attached.") + "\n\nThank you,\n" + (myName() || "") + "\nKim Industries";
    var canShare = !!(navigator.canShare && window.File && navigator.canShare({ files: [new File([""], "a.pdf", { type: "application/pdf" })] }));
    var nFiles = order ? 2 : 1;
    var h = "<h2>Reject invoice</h2>" +
      '<p class="hint" style="margin-top:0">Email the supplier to ask for a corrected invoice, or just mark it rejected.</p>' +
      '<label class="field"><span>To</span><input class="input" id="sb-to" type="email" value="' + esc(to) + '" placeholder="supplier email"></label>' +
      '<label class="field"><span>Subject</span><input class="input" id="sb-subject" value="' + esc(subject) + '"></label>' +
      '<label class="field"><span>Message</span><textarea class="input" id="sb-body" style="min-height:180px">' + esc(body) + "</textarea></label>" +
      '<div class="hint">Attachments: ' + (order ? "<b>Order " + esc(order.number) + ".pdf</b> and " : "") + "<b>" + esc(inv.file_name || "invoice") + "</b></div>" +
      '<div class="btn-row" style="margin-top:12px">' +
      (canShare ? '<button class="btn primary" id="sb-share">Open email with attachment' + (nFiles > 1 ? "s" : "") + "</button>" : "") +
      '<button class="btn' + (canShare ? "" : " primary") + '" id="sb-mail">' + (canShare ? "Download + email draft" : "Download attachment" + (nFiles > 1 ? "s" : "") + " + open email") + "</button></div>" +
      '<p class="hint" style="font-size:13px">' + (canShare ? "Choose your email app, check the message, and send." : "Your email app opens with the subject and message filled in. Attach the downloaded file" + (nFiles > 1 ? "s" : "") + ", then send.") + "</p>" +
      '<label class="field"><span>Reason (saved with the invoice, optional)</span><input class="input" id="sb-reason" placeholder="e.g. Billed above job pricing"></label>' +
      '<div class="btn-row"><button class="btn" data-action="close-sheet">Cancel</button><button class="btn danger" id="sb-only">Reject without emailing</button></div>';
    openSheet(h, function (sheet) {
      function files() {
        var jobs = [Cloud.downloadInvoiceFile(inv.file_path)];
        if (order) { var o = JSON.parse(JSON.stringify(order)); o.showPricing = true; jobs.push(buildPdf(o)); }
        return Promise.all(jobs).then(function (r) {
          var out = [new File([r[0]], inv.file_name || "invoice.pdf", { type: inv.file_type || r[0].type || "application/pdf" })];
          if (order) out.unshift(new File([r[1]], pdfName(o), { type: "application/pdf" }));
          return out;
        });
      }
      function mark(emailed) {
        var reason = sheet.querySelector("#sb-reason").value.trim(), now = new Date().toISOString();
        var patch = { status: "sent_back", sent_back_at: now, reviewed_by: Cloud.user.email, reviewed_at: now };
        var note = [reason ? "Rejected: " + reason : "", emailed ? "" : "(not emailed)"].filter(Boolean).join(" ");
        if (note) patch.notes = (inv.notes ? inv.notes + "\n" : "") + note;
        closeSheet();
        var after = nextInvoiceAfter(inv);
        Cloud.updateInvoice(inv.id, patch).then(refreshInvoices).then(function () { after("Invoice rejected"); }, function (e) { toast(e.message); });
      }
      function done() {
        if (!confirm("Did you send the email? Mark this invoice as rejected?")) { closeSheet(); return; }
        mark(true);
      }
      sheet.querySelector("#sb-only").addEventListener("click", function () { mark(false); });
      var share = sheet.querySelector("#sb-share");
      if (share) share.addEventListener("click", function () {
        share.disabled = true;
        files().then(function (fs) {
          return navigator.share({ files: fs, title: sheet.querySelector("#sb-subject").value, text: sheet.querySelector("#sb-body").value });
        }).then(done, function (e) { share.disabled = false; if (!(e && e.name === "AbortError")) toast(e && e.message || "Couldn't open the share sheet"); });
      });
      sheet.querySelector("#sb-mail").addEventListener("click", function (e) {
        e.target.disabled = true;
        files().then(function (fs) {
          fs.forEach(function (f) { downloadBlob(f, f.name); });
          var s2 = sheet.querySelector("#sb-subject").value, b2 = sheet.querySelector("#sb-body").value, t2 = sheet.querySelector("#sb-to").value.trim();
          setTimeout(function () { location.href = "mailto:" + encodeURIComponent(t2) + "?subject=" + encodeURIComponent(s2) + "&body=" + encodeURIComponent(b2); }, 400);
          setTimeout(done, 1500);
        }, function (ex) { e.target.disabled = false; toast(ex.message || "Couldn't prepare the attachments"); });
      });
    });
  }

  // ----- price-list requests (admin reviews)
  VIEWS["catalog-requests"] = function () {
    var h = topbar("Price-list requests", "Review before items are added", backBtn("home", "Home"), syncPill());
    h += '<main class="page">';
    if (!isAdmin()) return h + '<div class="empty">Only an admin can review price-list requests.</div></main>';
    var all = store.get("catalogRequests", []), pend = all.filter(function (r) { return r.status === "pending"; });
    var units = CAT.units.slice().sort(), cats = CAT.categories.slice().sort();
    h += '<datalist id="cat-list"><option value="Added Items">' + cats.map(function (c) { return '<option value="' + esc(c) + '">'; }).join("") + "</datalist>";
    h += "<h3>Waiting for review (" + pend.length + ")</h3>";
    if (!pend.length) h += '<div class="empty">Nothing waiting. When someone adds an item manually and ticks <b>Ask to add this to the price list</b>, it shows up here for you to edit and approve.</div>';
    pend.forEach(function (r) {
      h += '<div class="card req-card" data-req="' + esc(r.id) + '"><div class="t-sub">Requested by ' + esc((r.requested_by || "").split("@")[0]) + " · " + esc(fmtDate(r.created_at)) +
        (r.job_number ? " · Job " + esc(r.job_number) : "") + "</div>" +
        '<label class="field"><span>Item name</span><input class="input" data-f="name" value="' + esc(r.name) + '"></label>' +
        '<div class="filters"><label class="field"><span>Part #</span><input class="input" data-f="model" value="' + esc(r.model || "") + '"></label>' +
        '<label class="field"><span>Supplier</span><select class="input" data-f="supplier">' + SUPPLIERS.map(function (x) { return "<option" + (x === r.supplier ? " selected" : "") + ">" + esc(x) + "</option>"; }).join("") + "</select></label>" +
        '<label class="field"><span>Unit</span><select class="input" data-f="unit">' + units.map(function (u) { return "<option" + (u === String(r.unit || "EA").toUpperCase() ? " selected" : "") + ">" + esc(u) + "</option>"; }).join("") + "</select></label>" +
        '<label class="field"><span>Price (blank = TBD)</span><input class="input" data-f="price" type="number" inputmode="decimal" min="0" step="any" value="' + (r.price > 0 ? esc(r.price) : "") + '"></label>' +
        '<label class="field full"><span>Category</span><input class="input" data-f="category" list="cat-list" value="Added Items"></label>' +
        '<label class="field full"><span>Note (optional)</span><input class="input" data-f="note" placeholder="For your records"></label></div>' +
        '<div class="btn-row"><button class="btn danger" data-action="req-reject" data-id="' + esc(r.id) + '">Reject</button>' +
        '<button class="btn primary" data-action="req-approve" data-id="' + esc(r.id) + '">Approve &amp; add to price list</button></div></div>';
    });
    var done = all.filter(function (r) { return r.status !== "pending"; }).slice(0, 30);
    if (done.length) {
      h += "<h3>Recently reviewed</h3>" + done.map(function (r) {
        var it = r.item_id ? BY_KEY[r.supplier + "|" + r.item_id] : null;
        return '<div class="card"><div class="t-title">' + esc(it ? it.name : r.name) + " " + (r.status === "approved" ? '<span class="badge sent">Added</span>' : '<span class="badge">Rejected</span>') + "</div>" +
          '<div class="t-sub">' + esc(r.supplier) + (it ? " · " + (it.price > 0 ? fmtMoney(it.price) : "Price TBD") + " / " + esc(it.unit) + (it.model ? " · #" + esc(it.model) : "") : "") +
          " · by " + esc((r.requested_by || "").split("@")[0]) + " · " + esc(fmtDate(r.reviewed_at)) + (r.review_note ? " · " + esc(r.review_note) : "") + "</div>" +
          (it ? '<button class="btn" style="margin-top:8px" data-action="catalog-edit" data-key="' + esc(it.key) + '">Edit item</button>' : "") + "</div>";
      }).join("");
    }
    return h + "</main>";
  };
  function reqFields(id) {
    var card = document.querySelector('[data-req="' + id + '"]'), v = {};
    card.querySelectorAll("[data-f]").forEach(function (el) { v[el.getAttribute("data-f")] = el.value.trim(); });
    v.price = parseFloat(v.price) || 0;
    return v;
  }
  // ----- jobs & divisions (admin)
  // Each job # belongs to one division. Non-admins with divisions only see / order on their divisions' jobs.
  function divOf(v) {
    var t = String(v == null ? "" : v).trim(), m = t.match(/\d{3}/);
    return m ? m[0] : t;
  }
  // Rows from a spreadsheet or pasted text -> [{job_number, job_name, division}] plus problems.
  function jobsFromRows(rows) {
    rows = rows.map(function (r) { return (r || []).map(function (c) { return c == null ? "" : String(c).trim(); }); }).filter(function (r) { return r.some(Boolean); });
    var hi = -1, cJob = 0, cName = -1, cDiv = -1;
    for (var i = 0; i < Math.min(rows.length, 15); i++) {
      var low = rows[i].map(function (c) { return c.toLowerCase(); });
      var d = low.findIndex(function (c) { return /div/.test(c); }), j = low.findIndex(function (c) { return /job|project/.test(c) && !/name|desc/.test(c); });
      if (d >= 0 && j >= 0) { hi = i; cDiv = d; cJob = j; cName = low.findIndex(function (c, k) { return k !== j && k !== d && /name|desc|location|customer|title/.test(c); }); break; }
    }
    if (hi < 0) { // no header: job, name, division  or  job, division
      var w = Math.max.apply(null, rows.map(function (r) { return r.length; }).concat([0]));
      cJob = 0; cDiv = w >= 3 ? 2 : 1; cName = w >= 3 ? 1 : -1;
    }
    var out = [], bad = [], seen = {};
    rows.slice(hi + 1).forEach(function (r, k) {
      var job = jobKey(r[cJob]), div = divOf(r[cDiv]);
      if (!job) return;
      if (!div) { bad.push("Row " + (hi + k + 2) + ": job " + job + " has no division"); return; }
      if (seen[job]) return;
      seen[job] = 1;
      out.push({ job_number: job, job_name: cName >= 0 ? r[cName] || "" : "", division: div });
    });
    return { jobs: out, bad: bad };
  }
  VIEWS.jobs = function () {
    var h = topbar("Jobs & Divisions", "Admin", backBtn("settings", "Settings"), syncPill());
    h += '<main class="page">';
    if (!isAdmin()) return h + '<div class="empty">Only an admin can manage jobs.</div></main>';
    if (store.get("jobsSetupMissing", false)) h += '<div class="notice"><b>Database setup not finished.</b> Run <code>supabase/divisions.sql</code> once in Supabase (SQL Editor → New query → paste → Run), then reopen this screen.</div>';
    var jobs = getJobs(), f = state.jobsDiv || "", q = jobKey(state.jobsQ || "");
    var divs = DIVISIONS.slice();
    jobs.forEach(function (j) { if (divs.indexOf(String(j.division)) < 0) divs.push(String(j.division)); });
    h += '<p class="hint" style="margin-top:0">Every job # belongs to a division. People are given divisions under <b>Users &amp; Permissions</b> and only see and order on those divisions\' jobs. Admins see everything.</p>';
    h += '<div class="card"><h2 style="margin-top:0;font-size:18px">Add a job</h2><form id="job-add" autocomplete="off"><div class="filters">' +
      '<label class="field"><span>Job # <span class="req">*</span></span><input class="input" name="job" required autocapitalize="characters" placeholder="e.g. 3425"></label>' +
      '<label class="field"><span>Division <span class="req">*</span></span><select class="input" name="div">' + divs.map(function (d) { return "<option>" + esc(d) + "</option>"; }).join("") + "</select></label>" +
      '<label class="field full"><span>Job name</span><input class="input" name="name" placeholder="optional"></label></div>' +
      '<button class="btn primary block" type="submit">Save job</button></form>' +
      '<div class="btn-row" style="margin-top:10px"><button class="btn" data-action="jobs-import">Import Excel / CSV</button><button class="btn" data-action="jobs-paste">Paste a list</button></div>' +
      '<input type="file" id="jobs-file" accept=".xlsx,.xls,.csv,.ods" hidden></div>';
    var counts = {};
    jobs.forEach(function (j) { counts[j.division] = (counts[j.division] || 0) + 1; });
    h += "<h3>Jobs (" + jobs.length + ")</h3>";
    h += '<div class="chips"><button class="chip' + (!f ? " on" : "") + '" data-action="jobs-div" data-d="">All</button>' +
      divs.map(function (d) { return '<button class="chip' + (f === d ? " on" : "") + '" data-action="jobs-div" data-d="' + esc(d) + '">Div ' + esc(d) + " (" + (counts[d] || 0) + ")</button>"; }).join("") + "</div>";
    h += '<input class="input" id="jobs-q" type="search" placeholder="Find a job # or name" value="' + esc(state.jobsQ || "") + '" style="margin-bottom:10px">';
    var list = jobs.filter(function (j) { return (!f || String(j.division) === f) && (!q || j.job_number.indexOf(q) >= 0 || String(j.job_name || "").toUpperCase().indexOf(q) >= 0); })
      .sort(function (a, b) { return a.job_number.localeCompare(b.job_number, undefined, { numeric: true }); });
    h += !jobs.length ? '<div class="empty">No jobs yet. Add them above or import a spreadsheet with columns <b>Job #</b>, <b>Job name</b> and <b>Division</b>.</div>'
      : !list.length ? '<div class="empty">No jobs match.</div>'
      : '<div class="tile-list">' + list.slice(0, 300).map(function (j) {
        return '<div class="card job-row"><div class="t-main"><div class="t-title">' + esc(j.job_number) + (j.job_name ? " · " + esc(j.job_name) : "") + "</div></div>" +
          '<select class="input job-div" data-job="' + esc(j.job_number) + '" aria-label="Division">' + divs.map(function (d) { return "<option" + (String(j.division) === d ? " selected" : "") + ">" + esc(d) + "</option>"; }).join("") + "</select>" +
          '<button class="btn small" data-action="job-edit" data-job="' + esc(j.job_number) + '">Edit</button></div>';
      }).join("") + "</div>" + (list.length > 300 ? '<p class="hint">Showing 300 of ' + list.length + ". Search to narrow it down.</p>" : "");
    return h + "</main>";
  };
  AFTER.jobs = function () {
    if (!isAdmin()) return;
    var form = document.getElementById("job-add");
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var job = jobKey(form.job.value);
      if (!job) { form.job.focus(); return; }
      var row = { job_number: job, job_name: form.name.value.trim(), division: form.div.value };
      var ex = jobsByKey()[job];
      if (ex && String(ex.division) !== row.division && !confirm("Job " + job + " is in Division " + ex.division + ". Move it to Division " + row.division + "?")) return;
      Cloud.saveJobs([row]).then(refreshJobs).then(function () { toast("Job " + job + " saved (Division " + row.division + ")"); render(); }, function (ex2) { toast(ex2.message); });
    });
    var qi = document.getElementById("jobs-q");
    qi.addEventListener("input", function () { state.jobsQ = qi.value; var pos = qi.selectionStart; render(); var n = document.getElementById("jobs-q"); n.focus(); try { n.setSelectionRange(pos, pos); } catch (er) { /* ignore */ } });
    document.querySelectorAll(".job-div").forEach(function (sel) {
      sel.addEventListener("change", function () {
        var j = jobsByKey()[sel.getAttribute("data-job")];
        Cloud.saveJobs([{ job_number: j.job_number, job_name: j.job_name, division: sel.value, active: j.active }]).then(refreshJobs)
          .then(function () { toast("Job " + j.job_number + " moved to Division " + sel.value); render(); }, function (ex) { toast(ex.message); render(); });
      });
    });
    var file = document.getElementById("jobs-file");
    file.addEventListener("change", function () {
      var fl = file.files[0]; file.value = "";
      if (!fl) return;
      (window.XLSX ? Promise.resolve() : loadScript("js/vendor/xlsx.full.min.js")).then(function () { return fl.arrayBuffer(); }).then(function (buf) {
        var wb = window.XLSX.read(buf, { type: "array" }), best = null;
        wb.SheetNames.forEach(function (n) {
          var r = jobsFromRows(window.XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, defval: "" }));
          if (!best || r.jobs.length > best.jobs.length) best = r;
        });
        openJobsImportSheet(best || { jobs: [], bad: [] }, fl.name);
      }).then(null, function (ex) { toast("Couldn't read " + fl.name + ": " + (ex.message || ex)); });
    });
  };
  function openJobsImportSheet(res, source) {
    var by = jobsByKey(), add = 0, move = 0, same = 0;
    res.jobs.forEach(function (j) { var ex = by[j.job_number]; if (!ex) add++; else if (String(ex.division) !== j.division || (j.job_name && j.job_name !== ex.job_name)) move++; else same++; });
    var odd = res.jobs.filter(function (j) { return DIVISIONS.indexOf(j.division) < 0; });
    var h = "<h2>Import jobs</h2><p class=\"hint\" style=\"margin-top:0\">From " + esc(source) + "</p>" +
      (res.jobs.length ? "<p><b>" + res.jobs.length + "</b> jobs found: " + add + " new, " + move + " changed" + (same ? ", " + same + " already the same" : "") + ".</p>" +
        '<div class="hint" style="max-height:180px;overflow:auto;border:1px solid var(--border);border-radius:8px;padding:8px">' +
        res.jobs.slice(0, 200).map(function (j) { return esc(j.job_number) + (j.job_name ? " · " + esc(j.job_name) : "") + " → Div " + esc(j.division); }).join("<br>") + (res.jobs.length > 200 ? "<br>…" : "") + "</div>"
        : '<div class="notice">No jobs found. Use columns <b>Job #</b>, <b>Job name</b> and <b>Division</b> (a header row helps), or one job per line: <code>3425, Mercy Hospital, 100</code>.</div>') +
      (odd.length ? '<div class="notice" style="margin-top:8px">' + odd.length + " job" + (odd.length === 1 ? " has a division" : "s have divisions") + " that aren't 100/200/300/400/450/600/700 (e.g. " + esc(odd[0].job_number + " → " + odd[0].division) + "). They'll be saved as written.</div>" : "") +
      (res.bad.length ? '<div class="notice" style="margin-top:8px"><b>Skipped:</b><br>' + res.bad.slice(0, 10).map(esc).join("<br>") + (res.bad.length > 10 ? "<br>…" : "") + "</div>" : "") +
      '<div class="btn-row" style="margin-top:12px"><button class="btn" data-action="close-sheet">Cancel</button>' +
      (res.jobs.length ? '<button class="btn primary" id="ji-save">Save ' + res.jobs.length + " jobs</button>" : "") + "</div>";
    openSheet(h, function (sheet) {
      var b = sheet.querySelector("#ji-save");
      if (b) b.addEventListener("click", function () {
        b.disabled = true; b.textContent = "Saving…";
        Cloud.saveJobs(res.jobs.map(function (j) { var ex = by[j.job_number]; return { job_number: j.job_number, job_name: j.job_name || (ex && ex.job_name) || "", division: j.division }; }))
          .then(refreshJobs).then(function () { closeSheet(); toast(res.jobs.length + " jobs saved"); render(); }, function (ex) { b.disabled = false; b.textContent = "Save"; toast(ex.message); });
      });
    });
  }

  // ----- users & permissions (admin)
  var ROLES = [["user", "Regular user", "Creates orders; can review invoices / edit shop stock if ticked"], ["field", "Field view", "Creates orders and looks at shop stock only"], ["admin", "Admin", "Everything, every division"]];
  function roleSelectHtml(name, role, attrs) {
    return '<select class="input" name="' + name + '"' + (attrs || "") + ">" + ROLES.map(function (r) { return '<option value="' + r[0] + '"' + (r[0] === role ? " selected" : "") + ">" + r[1] + "</option>"; }).join("") + "</select>";
  }
  function divChecksHtml(sel, attrs) {
    return '<div class="div-checks">' + DIVISIONS.map(function (d) {
      return '<label class="div-check"><input type="checkbox" value="' + d + '"' + (sel.indexOf(d) >= 0 ? " checked" : "") + (attrs || "") + ">" + d + "</label>";
    }).join("") + "</div>";
  }
  VIEWS.users = function () {
    var h = topbar("Users & Permissions", "Admin", backBtn("settings", "Settings"));
    h += '<main class="page">';
    if (!isAdmin()) return h + setupBanner() + '<div class="empty">Only an admin can manage users.</div></main>';
    h += '<div class="card"><h2 style="margin-top:0;font-size:18px">Add a person</h2><form id="user-form" autocomplete="off">' +
      '<label class="field"><span>Email <span class="req">*</span></span><input class="input" name="email" type="email" required placeholder="name@kimindustries.com"></label>' +
      '<label class="field"><span>Name</span><input class="input" name="name" placeholder="First and last name"></label>' +
      '<label class="field"><span>User type</span>' + roleSelectHtml("role", "user", ' id="nu-role"') + "</label>" +
      '<div class="field" id="nu-divs"><span>Divisions <small style="color:var(--muted);font-weight:500">(none ticked = all divisions)</small></span>' + divChecksHtml([], ' name="div"') + "</div>" +
      '<div id="nu-perms"><label class="toggle"><input type="checkbox" name="can_edit_shop">Can add / remove shop stock</label>' +
      '<label class="toggle"><input type="checkbox" name="can_review_invoices">Can review invoices</label></div>' +
      '<label class="field" style="margin-top:8px"><span>Temporary password (creates their login)</span><input class="input" name="password" type="text" minlength="8" placeholder="At least 8 characters - leave blank if they already have a login"></label>' +
      '<div class="error-text" id="user-error" hidden></div>' +
      '<button class="btn primary block" type="submit">Save person</button></form></div>';
    h += '<h3>People</h3><div id="user-list" class="hint">Loading…</div></main>';
    return h;
  };
  AFTER.users = function () {
    if (!isAdmin()) return;
    loadUsers();
    var nr = document.getElementById("nu-role");
    var syncNew = function () { document.getElementById("nu-perms").hidden = nr.value !== "user"; document.getElementById("nu-divs").hidden = nr.value === "admin"; };
    nr.addEventListener("change", syncNew); syncNew();
    document.getElementById("user-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var f = e.target, err = document.getElementById("user-error"), btn = f.querySelector("button[type=submit]");
      var role = f.role.value;
      var u = { email: f.email.value.trim().toLowerCase(), name: f.name.value.trim(), role: role,
        can_edit_shop: role === "user" && f.can_edit_shop.checked, can_review_invoices: role === "user" && f.can_review_invoices.checked,
        divisions: role === "admin" ? [] : Array.prototype.slice.call(f.querySelectorAll('input[name="div"]:checked')).map(function (c) { return c.value; }) };
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
        m = "Login not created, nothing saved: " + m;
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
        var divs = (u.divisions || []).map(String), em = esc(u.email);
        return '<div class="card user-card' + (u.blocked ? " blocked" : "") + '"><div class="u-head"><div><div class="t-title">' + esc(u.name || u.email.split("@")[0]) +
          (u.role === "admin" ? ' <span class="badge sent">Admin</span>' : u.role === "field" ? ' <span class="badge">Field</span>' : "") + (u.blocked ? ' <span class="badge">Access off</span>' : "") + "</div>" +
          '<div class="t-sub">' + esc(u.email) + (self ? " (you)" : "") + (u.role === "admin" ? " · all divisions" : " · " + (divs.length ? "Division" + (divs.length === 1 ? " " : "s ") + esc(divs.join(", ")) : "all divisions (none assigned)")) + "</div></div></div>" +
          (self ? "" : '<label class="field" style="margin:8px 0 4px"><span>User type</span>' + roleSelectHtml("role", u.role || "user", ' data-user-role="' + em + '"') + "</label>") +
          (u.role === "admin" ? "" : '<div class="field" style="margin:6px 0"><span>Divisions</span>' + divChecksHtml(divs, ' data-user-div="' + em + '"') + "</div>") +
          (u.role === "user" ? '<label class="toggle"><input type="checkbox" data-user-flag="can_edit_shop" data-email="' + em + '"' + (u.can_edit_shop ? " checked" : "") + ">Can add / remove shop stock</label>" +
            '<label class="toggle"><input type="checkbox" data-user-flag="can_review_invoices" data-email="' + em + '"' + (u.can_review_invoices ? " checked" : "") + ">Can review invoices</label>" : "") +
          (self ? "" : '<label class="toggle"><input type="checkbox" data-user-flag="blocked" data-email="' + em + '"' + (u.blocked ? " checked" : "") + ">Turn off access</label>") +
          '<div class="btn-row"><button class="btn" data-action="user-password" data-email="' + esc(u.email) + '">Reset password</button>' +
          (self ? "" : '<button class="btn danger" data-action="user-remove" data-email="' + esc(u.email) + '">Remove from list</button>') + "</div></div>";
      }).join("") + "</div>" : '<div class="empty">No one added yet.</div>';
      el.insertAdjacentHTML("beforeend", '<p class="hint" style="font-size:13px">People with a login who aren\'t listed here are regular users with no divisions: they can order for any job and look up shop stock, but can\'t change it or review invoices.</p>');
      var findU = function (email) { return state.users.filter(function (x) { return x.email === email; })[0]; };
      var saveU = function (nu) { Cloud.saveUser(nu).then(function () { toast("Saved"); loadUsers(); }, function (e) { toast(e.message || "Couldn't save"); loadUsers(); }); };
      el.querySelectorAll("[data-user-role]").forEach(function (sel) {
        sel.addEventListener("change", function () {
          var nu = JSON.parse(JSON.stringify(findU(sel.getAttribute("data-user-role"))));
          nu.role = sel.value;
          if (nu.role !== "user") { nu.can_edit_shop = false; nu.can_review_invoices = false; }
          if (nu.role === "admin") nu.divisions = [];
          saveU(nu);
        });
      });
      el.querySelectorAll("[data-user-div]").forEach(function (cb) {
        cb.addEventListener("change", function () {
          var email = cb.getAttribute("data-user-div"), nu = JSON.parse(JSON.stringify(findU(email)));
          nu.divisions = Array.prototype.slice.call(el.querySelectorAll('[data-user-div="' + email + '"]:checked')).map(function (c) { return c.value; });
          saveU(nu);
        });
      });
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
      if (!canSeeJob(o.jobNumber) && o.createdBy !== me) return false;
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
    h += '<main class="page">' + setupBanner() + '<form id="settings-form">';
    if (Cloud.enabled && Cloud.user) {
      h += '<div class="card"><div class="t-sub" style="color:var(--muted)">Signed in as</div><div style="font-weight:700;margin-bottom:4px">' + esc(Cloud.user.email) + "</div>" +
        '<div class="hint" style="margin:0 0 10px">' + (isAdmin() ? "Admin" : canEditShop() ? "Can change shop stock" : "Crew member") + "</div>" +
        '<div class="btn-row">' + (isAdmin() ? '<button type="button" class="btn brand" data-action="users">Users &amp; Permissions</button><button type="button" class="btn brand" data-action="jobs">Jobs &amp; Divisions</button><button type="button" class="btn brand" data-action="pricing">Special Pricing</button><button type="button" class="btn brand" data-action="catalog-requests">Price-list Requests</button><button type="button" class="btn brand" data-action="edit-products">Edit Products</button>' : "") +
        '<button type="button" class="btn" data-action="sign-out">Sign out</button></div></div>';
    }
    h += '<div class="card"><label class="field"><span>Your name (shown on orders)</span><input class="input" name="name" autocomplete="name" value="' + esc(s.name || myName()) + '"></label>' +
      '<label class="field" style="margin:0"><span>Your phone</span><input class="input" name="phone" type="tel" autocomplete="tel" value="' + esc(s.phone) + '"></label></div>' +
      '<h3>Supplier order emails</h3><div class="card"><p class="hint" style="margin-top:0">Pre-fills the "To" line when emailing an order.' +
      (Cloud.enabled ? " Shared with everyone in the company." : "") + "</p>";
    var canEditEmails = !Cloud.enabled || isAdmin();
    if (!canEditEmails) h += '<div class="hint" style="margin-top:-6px">Only an admin can change these.</div>';
    SUPPLIERS.forEach(function (sup) {
      h += '<label class="field"><span>' + esc(sup) + '</span><input class="input" type="email" data-sup="' + esc(sup) + '" value="' + esc(emails[sup] || "") + '" placeholder="' + (canEditEmails ? "orders@supplier.com" : "Not set") + '"' + (canEditEmails ? "" : " readonly") + "></label>";
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
      if (!sup || e.target.readOnly) return;
      var val = e.target.value.trim();
      if (Cloud.enabled) {
        var m = store.get("supplierEmails", {});
        m[sup] = val;
        store.set("supplierEmails", m);
        Cloud.setSupplierEmail(sup, val).then(function () { toast("Saved for everyone"); }, function (ex) {
          toast(/row-level|policy|permission/i.test(ex && ex.message || "") ? "Only an admin can change supplier emails" : "Couldn't save - check your connection");
        });
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
    "shop": function () { go("shop"); refreshAccess(); refreshStock().then(function () { if (state.view === "shop") renderStockList(); }); },
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
    "users": function () { go("users"); refreshAccess(); refreshJobs(); },
    "jobs": function () { go("jobs"); refreshAccess(); refreshJobs().then(function () { if (state.view === "jobs") render(); }); },
    "jobs-div": function (el) { state.jobsDiv = el.getAttribute("data-d"); render(); },
    "jobs-import": function () { document.getElementById("jobs-file").click(); },
    "jobs-paste": function () {
      openSheet('<h2>Paste jobs</h2><p class="hint" style="margin-top:0">One job per line: <b>job #, job name, division</b> (or job #, division). Copying rows from Excel works too.</p>' +
        '<textarea class="input" id="jp-text" style="min-height:200px" placeholder="3425, Mercy Hospital, 100\n3712, Regeneron B20, 300"></textarea>' +
        '<div class="btn-row" style="margin-top:10px"><button class="btn" data-action="close-sheet">Cancel</button><button class="btn primary" id="jp-go">Next</button></div>', function (sheet) {
        sheet.querySelector("#jp-go").addEventListener("click", function () {
          var rows = sheet.querySelector("#jp-text").value.split(/\r?\n/).map(function (l) { return l.split(/\t|,|;/); });
          openJobsImportSheet(jobsFromRows(rows), "pasted list");
        });
      });
    },
    "job-edit": function (el) {
      var j = jobsByKey()[el.getAttribute("data-job")];
      if (!j) return;
      openSheet("<h2>Job " + esc(j.job_number) + "</h2>" +
        '<label class="field"><span>Job name</span><input class="input" id="je-name" value="' + esc(j.job_name || "") + '"></label>' +
        '<label class="toggle"><input type="checkbox" id="je-active"' + (j.active !== false ? " checked" : "") + '>Active (shows up when people start an order)</label>' +
        '<div class="btn-row" style="margin-top:12px"><button class="btn danger" id="je-del">Delete job</button><button class="btn" data-action="close-sheet">Cancel</button><button class="btn primary" id="je-save">Save</button></div>', function (sheet) {
        sheet.querySelector("#je-save").addEventListener("click", function () {
          Cloud.saveJobs([{ job_number: j.job_number, division: j.division, job_name: sheet.querySelector("#je-name").value.trim(), active: sheet.querySelector("#je-active").checked }])
            .then(refreshJobs).then(function () { closeSheet(); toast("Saved"); render(); }, function (ex) { toast(ex.message); });
        });
        sheet.querySelector("#je-del").addEventListener("click", function () {
          if (!confirm("Delete job " + j.job_number + "? People in its division won't see its orders any more until it's added back.")) return;
          Cloud.deleteJob(j.job_number).then(refreshJobs).then(function () { closeSheet(); toast("Job deleted"); render(); }, function (ex) { toast(ex.message); });
        });
      });
    },
    "catalog-requests": function () { go("catalog-requests"); refreshCatalog().then(function () { if (state.view === "catalog-requests") render(); }); },
    "req-approve": function (el) {
      var id = el.getAttribute("data-id"), req = store.get("catalogRequests", []).filter(function (r) { return r.id === id; })[0], v = reqFields(id);
      if (!v.name) { toast("Item name is required"); return; }
      el.disabled = true;
      Cloud.approveCatalogRequest(req, v).then(refreshCatalog).then(function () { toast("Added to the price list: " + v.name); render(); },
        function (e) { el.disabled = false; toast(e.message || "Couldn't approve"); });
    },
    "catalog-edit": function (el) {
      var it = BY_KEY[el.getAttribute("data-key")];
      if (!it || it.jobOnly || !isAdmin()) return;
      if (!Cloud.enabled || !navigator.onLine) { toast("Connect to the internet to edit products"); return; }
      var units = CAT.units.slice().sort(), o = it.orig;
      if (units.indexOf(it.unit) < 0) units.push(it.unit);
      var h = "<h2>Edit product</h2>" +
        '<datalist id="ce-cats">' + CAT.categories.slice().sort().map(function (c) { return '<option value="' + esc(c) + '">'; }).join("") + "</datalist>" +
        '<label class="field"><span>Item name</span><input class="input" id="ce-name" value="' + esc(it.name) + '"></label>' +
        '<div class="filters"><label class="field"><span>Part #</span><input class="input" id="ce-model" value="' + esc(it.model || "") + '"></label>' +
        '<label class="field"><span>Unit</span><select class="input" id="ce-unit">' + units.map(function (u) { return "<option" + (u === it.unit ? " selected" : "") + ">" + esc(u) + "</option>"; }).join("") + "</select></label>" +
        '<label class="field"><span>Price (blank = TBD)</span><input class="input" id="ce-price" type="number" inputmode="decimal" min="0" step="any" value="' + (it.price > 0 ? esc(it.price) : "") + '"></label>' +
        '<label class="field"><span>Category</span><input class="input" id="ce-cat" list="ce-cats" value="' + esc(it.category) + '"></label></div>' +
        '<p class="hint">Supplier: ' + esc(it.supplier) + " · Item ID " + esc(it.id) +
        (o ? "<br>Edited" + (it.editedBy ? " by " + esc(it.editedBy.split("@")[0]) : "") + (it.editedAt ? " " + esc(fmtDate(it.editedAt)) : "") +
          ". Original price list: " + (o.price > 0 ? fmtMoney(o.price) : "TBD") + " / " + esc(o.unit) + (o.model ? " · #" + esc(o.model) : "") + (o.name !== it.name ? " · " + esc(o.name) : "") : "") + "</p>" +
        '<p class="hint">Changes apply to everyone. Job special pricing still wins on that job; sent orders keep the prices they were sent with.</p>' +
        '<div class="btn-row">' + (o ? '<button class="btn danger" id="ce-reset">Undo edits</button>' : "") +
        '<button class="btn" data-action="close-sheet">Cancel</button><button class="btn primary" id="ce-save">Save changes</button></div>';
      openSheet(h, function (sheet) {
        function after(msg) { return refreshCatalog().then(function () { closeSheet(); toast(msg); var y = window.scrollY; render(); window.scrollTo(0, y); }); }
        sheet.querySelector("#ce-save").addEventListener("click", function (e) {
          var f = { name: sheet.querySelector("#ce-name").value.trim(), model: sheet.querySelector("#ce-model").value.trim(), unit: sheet.querySelector("#ce-unit").value,
            price: parseFloat(sheet.querySelector("#ce-price").value) || 0, category: sheet.querySelector("#ce-cat").value.trim() };
          if (!f.name) { toast("Item name is required"); return; }
          e.target.disabled = true;
          (it.added ? Cloud.updateCatalogItem(it.id, f) : Cloud.saveCatalogEdit(it, f)).then(function () { return after("Product updated"); }, function (ex) { e.target.disabled = false; toast(ex.message); });
        });
        var rs = sheet.querySelector("#ce-reset");
        if (rs) rs.addEventListener("click", function () {
          if (!confirm("Undo your edits and go back to the price-list values?")) return;
          rs.disabled = true;
          Cloud.resetCatalogEdit(it.id).then(function () { return after("Back to the price-list values"); }, function (ex) { rs.disabled = false; toast(ex.message); });
        });
      });
    },
    "req-reject": function (el) {
      var id = el.getAttribute("data-id"), req = store.get("catalogRequests", []).filter(function (r) { return r.id === id; })[0], v = reqFields(id);
      if (!confirm("Reject this request? It won't be added to the price list.")) return;
      Cloud.rejectCatalogRequest(req, v.note).then(refreshCatalog).then(function () { toast("Request rejected"); render(); }, function (e) { toast(e.message); });
    },
    "invoices": function () { go("invoices"); refreshInvoices().then(function () { if (state.view === "invoices") render(); }); },
    "inv-upload": function () { document.getElementById("inv-file").click(); },
    "inv-filter": function (el) { state.invFilter = el.getAttribute("data-f"); render(); },
    "inv-flt-toggle": function () { state.invFltOpen = !state.invFltOpen; render(); },
    "inv-flt-clear": function () { state.invFlt = null; state.invFltOpen = false; render(); },
    "inv-sort": function (el) { store.set("invSort", el.getAttribute("data-s")); render(); },
    "inv-select": function () { state.invSel = state.invSel ? null : {}; render(); },
    "inv-toggle-sel": function (el) { var id = el.getAttribute("data-id"); if (state.invSel[id]) delete state.invSel[id]; else state.invSel[id] = true; var y = window.scrollY; render(); window.scrollTo(0, y); },
    "inv-sel-group": function (el) {
      var g = el.getAttribute("data-g"), items = invListFor(state.invFilter || "attention").filter(function (i) { return invGroupName(i, invSortMode()) === g; });
      var on = !items.every(function (i) { return state.invSel[i.id]; });
      items.forEach(function (i) { if (on) state.invSel[i.id] = true; else delete state.invSel[i.id]; });
      var y = window.scrollY; render(); window.scrollTo(0, y);
    },
    "inv-sel-all": function () {
      var list = invListFor(state.invFilter || "attention"), on = !list.every(function (i) { return state.invSel[i.id]; });
      state.invSel = {}; if (on) list.forEach(function (i) { state.invSel[i.id] = true; });
      var y = window.scrollY; render(); window.scrollTo(0, y);
    },
    "inv-export-pdf": function (el) {
      var f = state.invFilter || "attention", list = invListFor(f).filter(function (i) { return state.invSel[i.id]; });
      if (!list.length) return;
      if (!navigator.onLine) { toast("Connect to the internet to download the invoice files"); return; }
      el.disabled = true; el.textContent = "Building PDF…";
      var tabName = { approved: "Approved", sent_back: "Rejected", matched: "Matched", attention: "Needs review", all: "All" }[f] || "Selected";
      var name = "Invoices - " + tabName + " - " + new Date().toISOString().slice(0, 10) + ".pdf";
      exportInvoicesPdf(list, tabName + " invoices").then(function (r) {
        state.invSel = null; render();
        openCombinedPdfSheet(new File([r.blob], name, { type: "application/pdf" }), r.included, r.skipped, tabName);
      }, function (e) { el.disabled = false; el.textContent = "Combined PDF"; alert(e.message || "Couldn't build the PDF"); });
    },
    "open-invoice": function (el) { go("invoice", { invoiceId: el.getAttribute("data-id") }); },
    "inv-view-file": function () {
      var inv = currentInvoice(), w = window.open("", "_blank");
      Cloud.invoiceFileUrl(inv.file_path).then(function (u) { if (w) w.location = u; else location.href = u; }, function (e) { if (w) w.close(); toast(e.message); });
    },
    "inv-open-order": function () { var inv = currentInvoice(); state.orderId = inv.order_id; go("send"); },
    "inv-change-order": function () {
      var inv = currentInvoice();
      openSheet("<h2>Compare with a different order</h2>" + orderPickerHtml(inv) + '<button class="btn block" style="margin-top:8px" data-action="close-sheet">Cancel</button>', function (sheet) {
        var sel = sheet.querySelector("#inv-order-pick");
        sel.addEventListener("change", function () { sheet.querySelector("#inv-use-order").disabled = !sel.value; });
      });
    },
    "inv-use-order": function () {
      var inv = currentInvoice(), id = document.getElementById("inv-order-pick").value;
      if (!id) return;
      closeSheet();
      Cloud.runInvoiceAgent(inv.id, id).then(refreshInvoices).then(function () { toast("Comparing with the chosen order…"); render(); }, function (e) { toast(e.message); });
    },
    "inv-rerun": function () {
      var inv = currentInvoice();
      toast("Re-checking…");
      ensureInvoiceText(inv).then(function () { return Cloud.runInvoiceAgent(inv.id); }).then(refreshInvoices).then(function () { toast("AI is re-checking this invoice"); render(); }, function (e) { alert(e.message); });
    },
    "inv-approve": function () {
      var inv = currentInvoice();
      var n = invIssues(inv).length;
      if (n && !confirm(n + " line(s) don't match the order. Approve anyway?")) return;
      var after = nextInvoiceAfter(inv);
      Cloud.updateInvoice(inv.id, { status: "approved", reviewed_by: Cloud.user.email, reviewed_at: new Date().toISOString() })
        .then(refreshInvoices).then(function () { after("Invoice approved"); }, function (e) { toast(e.message); });
    },
    "inv-send-back": function () { openSendBackSheet(currentInvoice()); },
    "inv-add-items": function (el) { openAddItemsSheet(currentInvoice(), el.getAttribute("data-line")); },
    "inv-pricelist": function () { state.invPLOpen = currentInvoice().id; render(); },
    "inv-stop": function () {
      var inv = currentInvoice();
      if (!confirm("Cancel this check? You can re-run it or delete the invoice afterwards.")) return;
      Cloud.updateInvoice(inv.id, { status: "error", error: "Check cancelled. Tap Re-run AI check to try again." })
        .then(refreshInvoices).then(function () { toast("Check cancelled"); render(); }, function (e) { toast(e.message); });
    },
    "inv-delete": function () {
      var inv = currentInvoice();
      if (!confirm("Delete this invoice and its file?")) return;
      Cloud.deleteInvoice(inv).then(refreshInvoices).then(function () { toast("Invoice deleted"); go("invoices"); }, function (e) { toast(e.message); });
    },
    "pricing": function () { state.pricingJob = ""; go("pricing"); refreshAccess(); refreshBooks().then(function () { if (state.view === "pricing") render(); }); },
    "open-book": function (el) {
      var b = getBooks().filter(function (x) { return x.id === el.getAttribute("data-id"); })[0];
      if (b && !state.pricingJob) state.pricingJob = bookJobs(b)[0];
      go("book", { bookId: el.getAttribute("data-id"), bookQuery: "" });
    },
    "open-pricing-job": function (el) { go("pricing-job", { pricingJob: el.getAttribute("data-job") }); },
    "back-to-job": function () {
      var b = currentBook();
      go("pricing-job", { pricingJob: state.pricingJob || (b && bookJobs(b)[0]) });
    },
    "new-book-for-job": function (el) { state.newBookJob = el.getAttribute("data-job"); go("pricing"); },
    "book-copy": function () {
      var b = currentBook(), n = prompt("Copy this price book (" + (b.items || []).length + " prices) to which job #? Several: separate with commas.");
      if (n == null) return;
      var jobs = n.split(/[,;\s]+/).map(function (x) { return x.trim(); }).filter(Boolean);
      if (!jobs.length) return;
      var rows = (b.items || []).map(function (x) { return { item_key: x.item_key, item_name: x.item_name, unit: x.unit, price: +x.price }; });
      toast("Copying…");
      Promise.all(jobs.map(function (j) {
        return Cloud.saveBook({ job_number: j, supplier: b.supplier, name: b.name, active: true }).then(function (id) { return rows.length ? Cloud.upsertBookItems(id, rows) : null; });
      })).then(refreshBooks).then(function () { toast("Copied to Job " + jobs.join(", ")); render(); }, function (ex) { toast(ex.message || "Copy failed"); });
    },
    "open-book-back": function () { go("book"); },
    "book-add": function () { go("book-add", { mode: "search", query: "", browsePath: [], browseAll: false, sizeA: "", sizeB: "", filterText: "" }); },
    "book-import": function () { document.getElementById("book-file").click(); },
    "book-more": function () { state.shown += PAGE * 4; renderBookItems(); },
    "book-item": function (el) {
      var key = el.getAttribute("data-key"), b = currentBook(), it = BY_KEY[key];
      if (it) openBookPriceSheet(b, it);
      else if (confirm("This item is no longer in the price list. Remove it from the book?")) {
        Cloud.deleteBookItem(b.id, key).then(refreshBooks).then(render);
      }
    },
    "book-jobs": function () {
      var b = currentBook(), n = prompt("Job # for this price book (to use it on more jobs, use Copy to another job):", b.job_number);
      if (n == null) return;
      n = n.split(/[,;\s]+/).map(function (x) { return x.trim(); }).filter(Boolean)[0];
      if (!n) return;
      Cloud.saveBook({ id: b.id, job_number: n, supplier: b.supplier, name: b.name, active: b.active }).then(refreshBooks).then(function () { state.pricingJob = n; toast("Moved to Job " + n); render(); }, function (ex) { toast(ex.message); });
    },
    "book-rename": function () {
      var b = currentBook(), n = prompt("Price book name:", b.name || "");
      if (n == null) return;
      Cloud.saveBook({ id: b.id, job_number: b.job_number, supplier: b.supplier, name: n.trim(), active: b.active }).then(refreshBooks).then(render, function (ex) { toast(ex.message); });
    },
    "book-delete": function () {
      var b = currentBook();
      if (!confirm("Delete the " + b.supplier + " price book for Job " + b.job_number + "? Orders will go back to regular pricing for its items.")) return;
      Cloud.deleteBook(b.id).then(refreshBooks).then(function () { toast("Price book deleted"); go("pricing-job"); }, function (ex) { toast(ex.message); });
    },
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
        alert("Password not changed: " + (e.message || "unknown error"));
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
    "settings": function () { go("settings"); refreshAccess(); },
    "history": function () { go("history"); },
    "edit-products": function () { ACTIONS.lookup(); refreshCatalog().then(function () { if (state.view === "lookup") render(); }); },
    "lookup": function () { if (isField()) return; go("lookup", { mode: "search", query: "", browsePath: [], browseAll: false, sizeA: "", sizeB: "", filterText: "" }); },
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
    "custom-item": function (el) { openCustomSheet(el.getAttribute("data-q") || ""); },
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
      if (!canSeeJob(o.jobNumber)) { toast("Job " + o.jobNumber + " isn't in your division" + (myDivisions().length === 1 ? "" : "s")); return; }
      // Re-price from the current price list where the item still exists.
      var lines = o.lines.map(function (l) {
        var it = l.key && BY_KEY[l.itemKey || l.key];
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
  addCatalogExtras(store.get("catalogExtra", []));
  registerJobItems();
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
