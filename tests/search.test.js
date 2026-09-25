// Run: node tests/search.test.js
const assert = require("assert");
global.window = global;
require("../data/catalog.js");
const S = require("../js/search.js");
const C = window.CATALOG;
const items = S.buildIndex(C.items.map(r => ({ name: r[0], category: C.categories[r[2]], model: r[4], supplier: C.suppliers[r[6]] })));

function names(q, sup) {
  return S.search(items, q, sup ? { filter: i => i.supplier === sup } : {}).results.map(i => i.name);
}

// Size parsing
assert.deepStrictEqual(S.itemDims('1/2" (7/8") X 1" (126) ASJ JM FIBERGLASS PC').map(d => d.v), [0.5, 1]);
assert.deepStrictEqual(S.itemDims("1 1/2 x 1 1/2 Alley-Kat").map(d => d.v), [1.5, 1.5]);
assert.deepStrictEqual(S.itemDims('4-1/8" X 1" (42) ASJ').map(d => d.v), [4.125, 1]);

// Same results whichever way the size is typed
const a = names('1/2" x 1" fiberglass pipe');
assert.ok(a.length >= 6, "expected fiberglass pipe covering results");
assert.ok(a.every(n => /^1\/2"/.test(n)), "all results should be 1/2\" pipe size");
assert.deepStrictEqual(names("1/2x1 fg pc"), a);
assert.deepStrictEqual(names(".5 x 1 fiberglass pipe"), a);
assert.deepStrictEqual(names("1-1/2 x 1 fiberglass pipe"), names("1 1/2 x 1 fiberglass pipe"));

// Order matters: pipe size first, thickness second
assert.ok(names('1" x 1/2" fiberglass pipe').every(n => !/^1\/2"/.test(n)));

// Supplier scoping
assert.ok(names('1/2" x 1" fiberglass pipe', "CT-SPI").length === 1);

// Shorthand and plurals
assert.ok(names("4 x 1 mw elbow").length > 0);
assert.ok(names("stickpins").length > 0);
assert.ok(names("fiberglas pipe").length > 0);

console.log("search tests passed");
