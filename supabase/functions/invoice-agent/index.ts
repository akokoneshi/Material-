// Supabase Edge Function: "invoice-agent"
// Reads an uploaded vendor invoice with Claude, finds the matching material order, and compares
// every line's pricing against the order. Results land in public.invoices for review in the app.
//
// Deploy: Dashboard > Edge Functions > Deploy a new function > Via Editor, name it "invoice-agent",
// paste this file, Deploy. Then in the function's Settings turn OFF "Verify JWT" (this code checks the
// caller itself).
// AI provider - add ONE of these under Edge Functions > Secrets:
//   GEMINI_API_KEY     Google Gemini (free tier available at aistudio.google.com). Used if set.
//   ANTHROPIC_API_KEY  Anthropic Claude.
import Anthropic from "npm:@anthropic-ai/sdk@^0.128.0";
import { GoogleGenAI, FinishReason } from "npm:@google/genai@^2.24.0";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

const USE_GEMINI = !!Deno.env.get("GEMINI_API_KEY");
// "gemini-flash-latest" always points at Google's current Flash model (free tier).
const MODEL = Deno.env.get("INVOICE_MODEL") || (USE_GEMINI ? "gemini-flash-latest" : "claude-opus-5");
// Used when the main Gemini model stays overloaded (503) or rate-limited (429) after retries.
const GEMINI_BACKUP_MODEL = Deno.env.get("INVOICE_BACKUP_MODEL") || "gemini-flash-lite-latest";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const EFFORT = (Deno.env.get("INVOICE_EFFORT") || "high") as "low" | "medium" | "high" | "xhigh" | "max";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

// ---------------------------------------------------------------- what the agent reads from an invoice

type InvoiceLine = {
  line: number;
  item_code: string | null;
  description: string;
  quantity: number | null;
  unit: string | null;
  unit_price: number | null;
  extended: number | null;
};
type Extracted = {
  vendor_name: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  po_number: string | null;
  job_reference: string | null;
  other_references: string[];
  subtotal: number | null;
  freight: number | null;
  tax: number | null;
  total: number | null;
  lines: InvoiceLine[];
};

const nullable = (type: string) => ({ type: [type, "null"] });
const EXTRACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["vendor_name", "invoice_number", "invoice_date", "po_number", "job_reference", "other_references", "subtotal", "freight", "tax", "total", "lines"],
  properties: {
    vendor_name: nullable("string"),
    invoice_number: nullable("string"),
    invoice_date: nullable("string"),
    po_number: nullable("string"),
    job_reference: nullable("string"),
    other_references: { type: "array", items: { type: "string" } },
    subtotal: nullable("number"),
    freight: nullable("number"),
    tax: nullable("number"),
    total: nullable("number"),
    lines: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["line", "item_code", "description", "quantity", "unit", "unit_price", "extended"],
        properties: {
          line: { type: "integer" },
          item_code: nullable("string"),
          description: { type: "string" },
          quantity: nullable("number"),
          unit: nullable("string"),
          unit_price: nullable("number"),
          extended: nullable("number"),
        },
      },
    },
  },
};

const EXTRACT_PROMPT = `You are reading a vendor invoice for Kim Industries, a mechanical insulation contractor. \
Suppliers include Distribution International (DI), Homans Associates, Specialty Products and Insulation (SPI), \
General Insulation (GIC) and AIT.

Extract the invoice exactly as printed:
- vendor_name, invoice_number, invoice_date (as printed).
- po_number: the customer PO / purchase order / "your order" number. Kim Industries order numbers look like \
"<job number>-<3 digits>", e.g. "24-118-003". Put any other job, release or reference numbers you see in \
job_reference / other_references.
- lines: one entry per billed product line, in order, numbered from 1. item_code is the vendor's product / \
part / item number (not the line number). quantity is the quantity billed/shipped on this invoice (not \
backordered). unit_price is the price per unit of measure; unit is that unit of measure (LF, FT, EA, RL, BX...). \
extended is the line total. Do not include freight, fuel surcharge, tax or other charges as lines; put freight and \
tax in their own fields.
- Numbers are plain numbers (no $ or commas). Use null for anything not printed. Do not guess.`;

// ---------------------------------------------------------------- matching the order

const SUPPLIER_ALIASES: [RegExp, string][] = [
  [/distribution\s*international|\bDI\b|metro supply/i, "CT-DI"],
  [/homans/i, "CT-Homans"],
  [/specialty\s*products|\bSPI\b/i, "CT-SPI"],
  [/general\s*insulation|\bGIC\b/i, "GIC"],
  [/\bAIT\b|advanced insulation/i, "CT-AIT"],
];
export function supplierFromVendor(name: string | null): string | null {
  if (!name) return null;
  for (const [re, code] of SUPPLIER_ALIASES) if (re.test(name)) return code;
  return null;
}

// Item codes compare without spaces/dashes and with O/0 and I/1 folded (common OCR mix-ups).
export function codeKey(c: string | null | undefined): string {
  return String(c || "").toUpperCase().replace(/[\s\-_.\/]/g, "").replace(/O/g, "0").replace(/I/g, "1");
}
const refKey = (s: string) => String(s || "").toUpperCase().replace(/[\s–—]/g, "").replace(/[^A-Z0-9-]/g, "");

type OrderLine = { key: string; name: string; model?: string; unit: string; price: number; qty: number; source?: string; special?: boolean };
type Order = { id: string; number: string | null; supplier: string; job_number: string; status: string; created_at: string; data: { lines: OrderLine[]; jobNumber?: string } };

export function findOrder(ex: Extracted, supplier: string | null, orders: Order[]):
  { order: Order | null; method: string | null; candidates: { id: string; number: string | null; score: number }[] } {
  const refs = [ex.po_number, ex.job_reference, ...(ex.other_references || [])].filter(Boolean).map((r) => refKey(r as string));
  // 1) Our order number printed on the invoice (usually as the PO #).
  const byNumber = orders.filter((o) => o.number && refs.some((r) => r.includes(refKey(o.number!))));
  if (byNumber.length) {
    const pick = byNumber.find((o) => !supplier || o.supplier === supplier) || byNumber[0];
    return { order: pick, method: "order_number", candidates: [] };
  }
  // 2) Products: the sent order from this supplier whose item codes best match the invoice lines.
  const invCodes = ex.lines.map((l) => codeKey(l.item_code)).filter((k) => k.length >= 4);
  const scored = orders
    .filter((o) => (!supplier || o.supplier === supplier) && o.status === "sent")
    .map((o) => {
      const lines = (o.data?.lines || []).filter((l) => l.source !== "shop");
      const codes = new Set(lines.map((l) => codeKey(l.model)).filter((k) => k.length >= 4));
      let score = invCodes.filter((k) => codes.has(k)).length;
      const job = refKey(o.job_number);
      // job number printed as its own token, e.g. "JOB 24-118" or "24-118 / ROOF" (but not inside "124-1180")
      if (job && refs.some((r) => new RegExp("(^|[^0-9])" + job.replace(/[-]/g, "\\-") + "($|[^0-9])").test(r))) score += 2;
      return { o, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || (a.o.created_at < b.o.created_at ? 1 : -1));
  const need = Math.max(1, Math.ceil(invCodes.length * 0.3));
  const candidates = scored.slice(0, 5).map((x) => ({ id: x.o.id, number: x.o.number, score: x.score }));
  if (scored.length && scored[0].score >= need) return { order: scored[0].o, method: "products", candidates };
  return { order: null, method: null, candidates };
}

// ---------------------------------------------------------------- comparing lines

export type CompareRow = {
  invoice_line: number | null;
  order_line: number | null;
  code: string | null;
  description: string;
  unit: string | null;
  inv_qty: number | null;
  ord_qty: number | null;
  inv_price: number | null;
  ord_price: number | null;
  price_diff: number | null;
  status: "ok" | "price" | "not_on_order" | "not_invoiced" | "no_price";
  qty_note: string | null;
  job_price: boolean;
  matched_by: "code" | "agent" | null;
};

export function priceMismatch(inv: number, ord: number): boolean {
  return Math.abs(inv - ord) > Math.max(0.01, Math.abs(ord) * 0.002);
}

export function compare(ex: Extracted, order: Order, agentPairs: { invoice_line: number; order_line: number }[]): CompareRow[] {
  const ordLines = (order.data?.lines || []).filter((l) => l.source !== "shop");
  const used = new Set<number>();
  const pairOf = new Map<number, number>();
  // Exact item-code matches first.
  ex.lines.forEach((l) => {
    const k = codeKey(l.item_code);
    if (k.length < 4) return;
    const idx = ordLines.findIndex((o, i) => !used.has(i) && codeKey(o.model) === k);
    if (idx >= 0) { used.add(idx); pairOf.set(l.line, idx); }
  });
  // Then the agent's description matches for whatever is left.
  agentPairs.forEach((p) => {
    const idx = p.order_line - 1;
    if (!pairOf.has(p.invoice_line) && idx >= 0 && idx < ordLines.length && !used.has(idx)) { used.add(idx); pairOf.set(p.invoice_line, idx); }
  });
  const rows: CompareRow[] = ex.lines.map((l) => {
    const idx = pairOf.get(l.line);
    const o = idx == null ? null : ordLines[idx];
    const base = {
      invoice_line: l.line, order_line: idx == null ? null : idx + 1, code: l.item_code, description: l.description,
      unit: l.unit, inv_qty: l.quantity, inv_price: l.unit_price, job_price: !!o?.special,
    };
    if (!o) return { ...base, ord_qty: null, ord_price: null, price_diff: null, status: "not_on_order", qty_note: null, matched_by: null };
    const qtyNote = l.quantity != null && Math.abs(l.quantity - o.qty) > 1e-6
      ? (l.quantity < o.qty ? `Billed ${l.quantity} of ${o.qty} ordered` : `Billed ${l.quantity}, only ${o.qty} ordered`) : null;
    const diff = l.unit_price == null ? null : Math.round((l.unit_price - o.price) * 10000) / 10000;
    const status = l.unit_price == null ? "no_price" : o.price > 0 && priceMismatch(l.unit_price, o.price) ? "price" : "ok";
    return { ...base, ord_qty: o.qty, ord_price: o.price, price_diff: diff, status, qty_note: qtyNote,
      matched_by: codeKey(l.item_code) === codeKey(o.model) && codeKey(o.model).length >= 4 ? "code" : "agent" } as CompareRow;
  });
  ordLines.forEach((o, i) => {
    if (used.has(i)) return;
    rows.push({ invoice_line: null, order_line: i + 1, code: o.model || null, description: o.name, unit: o.unit, inv_qty: null, ord_qty: o.qty,
      inv_price: null, ord_price: o.price, price_diff: null, status: "not_invoiced", qty_note: null, job_price: !!o.special, matched_by: null });
  });
  return rows;
}

// ---------------------------------------------------------------- Claude calls

// What we send the model: an optional file plus text instructions.
type AskInput = { file?: { mediaType: string; base64: string }; text: string };

export async function askJSON<T>(input: AskInput, schema: Record<string, unknown>): Promise<T> {
  return USE_GEMINI ? await askGemini<T>(input, schema) : await askClaude<T>(input, schema);
}

async function askGemini<T>(input: AskInput, schema: Record<string, unknown>): Promise<T> {
  const ai = new GoogleGenAI({ apiKey: Deno.env.get("GEMINI_API_KEY")! });
  const parts: { inlineData?: { mimeType: string; data: string }; text?: string }[] = [];
  if (input.file) parts.push({ inlineData: { mimeType: input.file.mediaType, data: input.file.base64 } });
  parts.push({ text: input.text });
  const callModel = (model: string, withSchema: boolean) => ai.models.generateContent({
    model,
    contents: [{ role: "user", parts: withSchema ? parts : parts.slice(0, -1).concat([{ text: input.text + "\n\nRespond with only JSON matching this JSON Schema:\n" + JSON.stringify(schema) }]) }],
    config: withSchema
      ? { responseMimeType: "application/json", responseJsonSchema: schema, maxOutputTokens: 32000 }
      : { responseMimeType: "application/json", maxOutputTokens: 32000 },
  });
  // Busy (503) / rate-limited (429): retry with growing waits, then try the backup model.
  const call = async (withSchema: boolean) => {
    let last: unknown;
    for (const model of [MODEL, GEMINI_BACKUP_MODEL]) {
      for (const wait of [0, 3000, 8000, 15000]) {
        if (wait) await sleep(wait);
        try {
          return await callModel(model, withSchema);
        } catch (e) {
          last = e;
          const st = (e as { status?: number })?.status;
          if (st !== 503 && st !== 429 && st !== 500) throw e;
        }
      }
    }
    throw last;
  };
  let res;
  try {
    res = await call(true);
  } catch (e) {
    // If this Gemini model rejects part of the schema, fall back to describing it in the prompt.
    if ((e as { status?: number })?.status !== 400) throw e;
    res = await call(false);
  }
  const reason = res.candidates?.[0]?.finishReason;
  if (reason === FinishReason.SAFETY || reason === FinishReason.RECITATION) throw new Error("The AI declined to read this document.");
  if (reason === FinishReason.MAX_TOKENS) throw new Error("The invoice was too long to read in one pass.");
  if (!res.text) throw new Error("The AI returned no result.");
  return JSON.parse(res.text) as T;
}

async function askClaude<T>(input: AskInput, schema: Record<string, unknown>): Promise<T> {
  const anthropic = new Anthropic(); // ANTHROPIC_API_KEY from the function's secrets
  const content: Anthropic.Beta.Messages.BetaContentBlockParam[] = [];
  if (input.file) {
    content.push(input.file.mediaType === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: input.file.base64 } }
      : { type: "image", source: { type: "base64", media_type: input.file.mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp", data: input.file.base64 } });
  }
  content.push({ type: "text", text: input.text });
  const stream = anthropic.beta.messages.stream({
    model: MODEL,
    max_tokens: 32000,
    thinking: { type: "adaptive" },
    output_config: { effort: EFFORT, format: { type: "json_schema", schema } },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default", // if the request is declined, the API retries it on its recommended fallback model
    messages: [{ role: "user", content }],
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === "refusal") throw new Error("The AI declined to read this document.");
  if (msg.stop_reason === "max_tokens") throw new Error("The invoice was too long to read in one pass.");
  const text = msg.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error("The AI returned no result.");
  return JSON.parse(text.text) as T;
}

async function extractInvoice(bytes: Uint8Array, mediaType: string): Promise<Extracted> {
  return await askJSON<Extracted>({ file: { mediaType, base64: encodeBase64(bytes) }, text: EXTRACT_PROMPT }, EXTRACT_SCHEMA);
}

// Pair invoice lines with order lines by description when item codes didn't match.
async function agentMatchLines(invLines: InvoiceLine[], ordLines: OrderLine[]): Promise<{ invoice_line: number; order_line: number }[]> {
  if (!invLines.length || !ordLines.length) return [];
  const prompt = `Match vendor invoice lines to the lines of the purchase order they were billed against. \
Only pair lines that are clearly the same product: same size (pipe size x thickness), material, facing/jacket and \
type. Different item codes for the same product are fine. Leave a line unpaired if unsure. Each order line can be \
used at most once. Ignore price when deciding.

INVOICE LINES:
${invLines.map((l) => `${l.line}. [${l.item_code || "-"}] ${l.description} (${l.unit || ""})`).join("\n")}

ORDER LINES:
${ordLines.map((o, i) => `${i + 1}. [${o.model || "-"}] ${o.name} (${o.unit})`).join("\n")}`;
  const res = await askJSON<{ pairs: { invoice_line: number; order_line: number }[] }>({ text: prompt }, {
    type: "object", additionalProperties: false, required: ["pairs"],
    properties: { pairs: { type: "array", items: { type: "object", additionalProperties: false, required: ["invoice_line", "order_line"],
      properties: { invoice_line: { type: "integer" }, order_line: { type: "integer" } } } } },
  });
  return res.pairs || [];
}

// ---------------------------------------------------------------- pipeline

async function loadOrders(db: SupabaseClient): Promise<Order[]> {
  const out: Order[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("orders").select("id, number, supplier, job_number, status, created_at, data")
      .order("created_at", { ascending: false }).range(from, from + 999);
    if (error) throw error;
    out.push(...(data as Order[]));
    if (data.length < 1000 || out.length >= 5000) break;
  }
  return out;
}

async function compareWithOrder(db: SupabaseClient, ex: Extracted, order: Order) {
  const ordLines = (order.data?.lines || []).filter((l) => l.source !== "shop");
  const codeMatched = new Set(ex.lines.filter((l) => ordLines.some((o) => codeKey(o.model).length >= 4 && codeKey(o.model) === codeKey(l.item_code))).map((l) => l.line));
  const leftoverInv = ex.lines.filter((l) => !codeMatched.has(l.line));
  const usedOrd = new Set(ordLines.map((o, i) => (ex.lines.some((l) => codeKey(l.item_code) === codeKey(o.model) && codeKey(o.model).length >= 4) ? i : -1)));
  const leftoverOrd = ordLines.map((o, i) => ({ o, i })).filter((x) => !usedOrd.has(x.i));
  let pairs: { invoice_line: number; order_line: number }[] = [];
  if (leftoverInv.length && leftoverOrd.length) {
    const local = await agentMatchLines(leftoverInv, leftoverOrd.map((x) => x.o));
    pairs = local.map((p) => ({ invoice_line: p.invoice_line, order_line: leftoverOrd[p.order_line - 1] ? leftoverOrd[p.order_line - 1].i + 1 : -1 }));
  }
  const rows = compare(ex, order, pairs);
  const mismatches = rows.filter((r) => r.status === "price" || r.status === "not_on_order").length;
  return { rows, mismatches };
}

async function processInvoice(db: SupabaseClient, id: string, forcedOrderId?: string | null) {
  const { data: inv, error } = await db.from("invoices").select("*").eq("id", id).single();
  if (error || !inv) throw new Error("Invoice not found");
  try {
    let ex: Extracted = inv.extracted;
    if (!ex || !forcedOrderId) {
      const file = await db.storage.from("invoices").download(inv.file_path);
      if (file.error) throw file.error;
      const mediaType = inv.file_type || (/\.pdf$/i.test(inv.file_name || "") ? "application/pdf" : "image/jpeg");
      ex = await extractInvoice(new Uint8Array(await file.data.arrayBuffer()), mediaType);
    }
    const supplier = supplierFromVendor(ex.vendor_name);
    const orders = await loadOrders(db);
    let order: Order | null = null, method: string | null = null, candidates: { id: string; number: string | null; score: number }[] = [];
    if (forcedOrderId) { order = orders.find((o) => o.id === forcedOrderId) || null; method = "manual"; }
    else ({ order, method, candidates } = findOrder(ex, supplier, orders));

    const base = {
      extracted: ex, vendor_name: ex.vendor_name, supplier: supplier || order?.supplier || null, invoice_number: ex.invoice_number,
      invoice_date: ex.invoice_date, total: ex.total, error: null, updated_at: new Date().toISOString(),
    };
    if (!order) {
      await db.from("invoices").update({ ...base, status: "no_order", order_id: null, order_number: null, match_method: null,
        comparison: { rows: [], candidates }, mismatch_count: 0 }).eq("id", id);
      return;
    }
    const { rows, mismatches } = await compareWithOrder(db, ex, order);
    await db.from("invoices").update({ ...base, status: mismatches ? "mismatch" : "matched", order_id: order.id, order_number: order.number,
      match_method: method, comparison: { rows, candidates }, mismatch_count: mismatches }).eq("id", id);
  } catch (e) {
    console.error(e);
    const status = (e as { status?: number })?.status;
    const msg = status === 429 ? "The AI service's free-tier limit was reached. Wait a minute, then tap Re-run AI check."
      : status === 503 || status === 500 ? "The AI service is overloaded right now (Google's side). Tap Re-run AI check in a few minutes."
      : status ? `AI service error (${status}): ${(e as Error).message}` : String((e as Error)?.message || e);
    await db.from("invoices").update({ status: "error", error: msg, updated_at: new Date().toISOString() }).eq("id", id);
  }
}

// ---------------------------------------------------------------- HTTP entry

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    let key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    if (!key) { try { key = (Object.values(JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}"))[0] as string) || ""; } catch { /* ignore */ } }
    if (!key) return reply({ error: "Function has no service key available" }, 500);
    if (!Deno.env.get("GEMINI_API_KEY") && !Deno.env.get("ANTHROPIC_API_KEY")) return reply({ error: "Add a GEMINI_API_KEY (or ANTHROPIC_API_KEY) secret for this function" }, 500);
    const db = createClient(url, key);

    const token = (req.headers.get("Authorization") || "").replace(/^Bearer /i, "");
    const { data: caller } = await db.auth.getUser(token);
    const email = caller?.user?.email?.toLowerCase();
    if (!email) return reply({ error: "Not signed in" }, 401);
    const { data: me } = await db.from("app_users").select("role, can_review_invoices, blocked").eq("email", email).maybeSingle();
    if (!me || me.blocked || !(me.role === "admin" || me.can_review_invoices)) return reply({ error: "You don't have permission to review invoices" }, 403);

    const body = await req.json();
    if (!body.invoice_id) return reply({ error: "invoice_id is required" }, 400);
    await db.from("invoices").update({ status: "processing", error: null, updated_at: new Date().toISOString() }).eq("id", body.invoice_id);
    const job = processInvoice(db, body.invoice_id, body.order_id || null);
    // Keep working after replying so the app doesn't wait on a long read.
    // deno-lint-ignore no-explicit-any
    const rt = (globalThis as any).EdgeRuntime;
    if (rt && typeof rt.waitUntil === "function") { rt.waitUntil(job); return reply({ ok: true, queued: true }); }
    await job;
    return reply({ ok: true });
  } catch (e) {
    return reply({ error: String((e as Error)?.message || e) }, 500);
  }
});
