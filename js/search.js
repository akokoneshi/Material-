/*
 * Material search engine.
 *
 * Understands insulation-style sizes such as  1/2" x 1"  ,  1-1/2 X 2  ,  1 1/2x1  ,  1.5 x 1
 * (pipe size first, then thickness) plus shorthand like FG, PC, ELL, MW, CALSIL, SS, ALUM.
 * Works in the browser (window.MaterialSearch) and in Node (module.exports) for tests.
 */
(function (root) {
  "use strict";

  // ---------- number / size parsing ----------

  var NUM = "(\\d+\\s*-\\s*\\d+\\/\\d+|\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|\\d*\\.\\d+|\\d+)";
  var UNIT = "(?:\\s*(\"|''|inch(?:es)?\\b|in\\b|'|ft\\b|feet\\b|foot\\b))?";
  var SEP = "\\s*[x\u00d7*]\\s*";
  // A size chain: 1/2" x 1" x 18"   (numbers not glued to letters / # / other digits)
  var CHAIN_RE = new RegExp("(?<![\\w#.\\/-])" + NUM + UNIT + "(?:" + SEP + NUM + UNIT + ")*", "gi");
  var PART_RE = new RegExp(NUM + UNIT, "gi");

  function numValue(txt) {
    txt = txt.replace(/\s+/g, " ").trim();
    var m;
    if ((m = txt.match(/^(\d+)\s*[- ]\s*(\d+)\/(\d+)$/))) return +m[1] + m[2] / m[3];
    if ((m = txt.match(/^(\d+)\/(\d+)$/))) return m[2] == 0 ? NaN : m[1] / m[2];
    return parseFloat(txt);
  }

  function unitOf(u) {
    if (!u) return "";
    u = u.toLowerCase();
    if (u === "'" || u === "ft" || u === "feet" || u === "foot") return "ft";
    return "in";
  }

  function normalizeQuotes(s) {
    return String(s || "")
      .replace(/[\u201c\u201d\u2033\u02ba]/g, '"')
      .replace(/[\u2018\u2019\u2032]/g, "'")
      .replace(/\u00b0/g, " ");
  }

  // Parse one chain match into [{v, u}]
  function chainParts(text) {
    var parts = [];
    var m;
    PART_RE.lastIndex = 0;
    while ((m = PART_RE.exec(text))) parts.push({ v: numValue(m[1]), u: unitOf(m[2]) });
    return parts;
  }

  function chainIsSize(text) {
    return /[x\u00d7*]/i.test(text) || /["']|in\b|inch|ft\b|feet|foot/i.test(text);
  }

  // Item names: first chain that has an "x" or an explicit unit; else a leading bare number.
  function itemDims(name) {
    var s = normalizeQuotes(name).replace(/\([^)]*\)/g, " ");
    CHAIN_RE.lastIndex = 0;
    var m;
    while ((m = CHAIN_RE.exec(s))) {
      var t = m[0].trim();
      if (chainIsSize(t)) return chainParts(t);
    }
    var lead = s.match(new RegExp("^\\s*" + NUM + "(?![\\w/.])"));
    return lead ? [{ v: numValue(lead[1]), u: "" }] : [];
  }

  // Query: extracts the size chain and returns the rest as words.
  function parseQuery(q) {
    var s = normalizeQuotes(q).toLowerCase();
    // "1/2x1" -> "1/2 x 1"
    s = s.replace(/(\d)\s*x\s*(\d)/g, "$1 x $2");
    var dims = [];
    var rest = s;
    CHAIN_RE.lastIndex = 0;
    var m;
    var chosen = null;
    var bare = [];
    while ((m = CHAIN_RE.exec(s))) {
      var t = m[0].trim();
      var parts = chainParts(t);
      if (chainIsSize(t)) { chosen = { text: m[0], index: m.index, parts: parts }; break; }
      bare.push({ text: m[0], index: m.index, parts: parts, raw: t });
    }
    if (!chosen) {
      // bare numbers: treat the first one that isn't an angle (45/90/180) as a size
      for (var i = 0; i < bare.length; i++) {
        if (!/^(45|90|180|22|11)$/.test(bare[i].raw)) { chosen = bare[i]; break; }
      }
    }
    if (chosen) {
      dims = chosen.parts;
      rest = s.slice(0, chosen.index) + " " + s.slice(chosen.index + chosen.text.length);
    }
    var words = tokenize(rest).filter(function (w) { return w && !STOP[w]; });
    return { dims: dims, words: words };
  }

  // ---------- words ----------

  var STOP = { x: 1, in: 1, inch: 1, inches: 1, the: 1, and: 1, for: 1, of: 1, with: 1, a: 1, '"': 1, ft: 1 };

  // query word -> canonical word that items are indexed with
  var QUERY_SYN = {
    fg: "fiberglass", fiberglas: "fiberglass", fibreglas: "fiberglass", fibreglass: "fiberglass", fiber: "fiberglass", glassfiber: "fiberglass",
    pc: "pipe", pipecover: "pipe", pipecovering: "pipe",
    ell: "elbow", el: "elbow", els: "elbow", ells: "elbow",
    mw: "mineral", minwool: "mineral", rockwool: "mineral", roxul: "mineral",
    calsil: "calsil", cal: "calsil", calcium: "calsil",
    foamglas: "foamglass", cellular: "foamglass",
    ss: "stainless", alum: "aluminum", al: "aluminum", aluminium: "aluminum",
    jkt: "jacketing", jacket: "jacketing", jacketing: "jacketing",
    ftg: "fitting", ftgs: "fitting", fittings: "fitting",
    cover: "cover", covers: "cover", covering: "cover",
    armaflex: "armaflex", rubber: "rubber", elastomeric: "rubber",
    styro: "styrofoam", eps: "styrofoam",
    iso: "polyiso", polyisocyanurate: "polyiso",
    tees: "tee", elbows: "elbow"
  };

  // Extra canonical words attached to items whose text matches.
  var ITEM_TAGS = [
    [/\bpc\b|p\/c|pipe cover|pipe insul|pipe & tank/, "pipe cover"],
    [/\bf\/g\b|\bfg\b|fiberglass|fibreglass/, "fiberglass"],
    [/min ?wool|mineral|\bmw\b|rockwool|roxul|prorox|thermaljacs/, "mineral"],
    [/foamglas|cellular glass/, "foamglass"],
    [/cal ?sil|calcium silicate/, "calsil"],
    [/\bell\b|\bel\b|elbow|\b(45|90)s?\b|\b(45|90) ?[ls]r\b/, "elbow fitting"],
    [/\btee\b/, "fitting"],
    [/fitting/, "fitting cover"],
    [/armaflex|aerocel|armacell|aeroflex|k-flex|insul-tube|insul-lock|titan|rubber/, "rubber"],
    [/\bss\b|stainless/, "stainless"],
    [/\balum|aluminum/, "aluminum"],
    [/jacket/, "jacketing"],
    [/styrofoam/, "styrofoam"],
    [/polyiso/, "polyiso"]
  ];

  function tokenize(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/(\d)([a-z])/g, "$1 $2")
      .replace(/([a-z])(\d)/g, "$1 $2")
      .split(/[^a-z0-9#]+/)
      .filter(Boolean);
  }

  // Returns the alternatives a query word may match (word, synonym, singular form).
  function canonical(w) {
    var alts = [QUERY_SYN[w] || w];
    if (w.length > 3 && /s$/.test(w) && !/ss$/.test(w)) {
      var sing = w.slice(0, -1);
      alts.push(QUERY_SYN[sing] || sing);
    }
    return alts;
  }

  // ---------- index ----------

  function buildIndex(items) {
    // items: [{name, category, model, supplier, ...}]
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var nameLc = normalizeQuotes(it.name).toLowerCase();
      var hay = nameLc + " " + String(it.category || "").toLowerCase() + " " + String(it.model || "").toLowerCase();
      var extra = "";
      for (var t = 0; t < ITEM_TAGS.length; t++) if (ITEM_TAGS[t][0].test(hay)) extra += " " + ITEM_TAGS[t][1];
      it._nameTokens = uniq(tokenize(nameLc + extra));
      it._allTokens = uniq(tokenize(hay + extra));
      it._dims = itemDims(it.name);
      it._sortKey = it._dims.map(function (d) { return d.v; });
    }
    return items;
  }

  function uniq(a) {
    var seen = {}, out = [];
    for (var i = 0; i < a.length; i++) if (!seen[a[i]]) { seen[a[i]] = 1; out.push(a[i]); }
    return out;
  }

  function tokenMatch(tokens, alts) {
    for (var a = 0; a < alts.length; a++) if (tokenMatch1(tokens, alts[a])) return true;
    return false;
  }

  function tokenMatch1(tokens, w) {
    var exact = w.length <= 2 || /^#?\d/.test(w);
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      if (exact ? t === w : t.lastIndexOf(w, 0) === 0) return true;
    }
    return false;
  }

  function dimsEqual(a, b) {
    return Math.abs(a.v - b.v) < 1e-6 && (!a.u || !b.u || a.u === b.u);
  }

  // 3 = exact chain, 2 = item chain starts with the query sizes, 0 = no match
  function dimScore(itemD, qD) {
    if (!qD.length) return 1;
    if (itemD.length < qD.length) return 0;
    for (var i = 0; i < qD.length; i++) if (!dimsEqual(itemD[i], qD[i])) return 0;
    return itemD.length === qD.length ? 3 : 2;
  }

  function compareSize(a, b) {
    var ka = a._sortKey, kb = b._sortKey, n = Math.max(ka.length, kb.length);
    for (var i = 0; i < n; i++) {
      var x = ka[i] == null ? -1 : ka[i], y = kb[i] == null ? -1 : kb[i];
      if (x !== y) return x - y;
    }
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  }

  /*
   * search(items, query, opts) -> { results, partial, parsed }
   * opts.filter(item) optional pre-filter (e.g. supplier/category).
   */
  function search(items, query, opts) {
    opts = opts || {};
    var parsed = parseQuery(query);
    var words = parsed.words.map(canonical);
    var scored = [];
    var bestPartial = 0;
    var partialList = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (opts.filter && !opts.filter(it)) continue;
      var ds = dimScore(it._dims, parsed.dims);
      if (!ds) continue;
      var hit = 0, inName = 0;
      for (var w = 0; w < words.length; w++) {
        if (tokenMatch(it._nameTokens, words[w])) { hit++; inName++; }
        else if (tokenMatch(it._allTokens, words[w])) hit++;
      }
      var score = ds * 10 + inName * 2 + hit;
      if (hit === words.length) scored.push({ it: it, s: score });
      else if (hit > 0 && parsed.dims.length + hit > 0) {
        if (hit > bestPartial) { bestPartial = hit; partialList = []; }
        if (hit === bestPartial) partialList.push({ it: it, s: score });
      }
    }
    var partial = false;
    if (!scored.length && partialList.length) { scored = partialList; partial = true; }
    scored.sort(function (a, b) { return b.s - a.s || compareSize(a.it, b.it); });
    return {
      results: scored.map(function (x) { return x.it; }),
      partial: partial,
      parsed: { dims: parsed.dims, words: parsed.words }
    };
  }

  function formatSize(v) {
    var whole = Math.floor(v + 1e-9), frac = v - whole;
    if (frac < 1e-6) return String(whole);
    var dens = [2, 4, 8, 16, 32];
    for (var i = 0; i < dens.length; i++) {
      var n = Math.round(frac * dens[i]);
      if (Math.abs(n / dens[i] - frac) < 1e-6) return (whole ? whole + "-" : "") + n + "/" + dens[i];
    }
    return String(+v.toFixed(3));
  }

  var api = {
    search: search,
    buildIndex: buildIndex,
    parseQuery: parseQuery,
    itemDims: itemDims,
    compareSize: compareSize,
    formatSize: formatSize
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.MaterialSearch = api;
})(typeof window !== "undefined" ? window : this);
