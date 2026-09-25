# Kim Industries Material Orders (Field App)

A phone-friendly web app that lets field crews build material orders from the company price list
(`data/source/Material_Dashboard.xlsx`, 22,365 items from 5 suppliers).

## How it works for the crew

1. **New Material Order.** Pick the **supplier** first (CT-DI, CT-SPI, GIC, CT-Homans, CT-AIT).
   After that, only that supplier's items and prices are shown.
2. **Enter the job number** (required). Job name is optional, and recent jobs are one tap away.
3. **Add materials**, either way:
   - **Search.** Type it the way you'd say it. `1/2" x 1" fiberglass pipe`, `1/2x1 fg pc`, `.5 x 1 fiberglass`
     and `1-1/2 x 1 1/2` all work. Size is **pipe size × thickness**. Shorthand is understood:
     FG, PC, ELL, MW/min wool, CALSIL, FOAMGLAS, SS, ALUM, JKT, 90/45.
   - **Browse by Category.** Pipe Covering › Fiberglass › JM, then narrow the list with the
     **Pipe size** and **Thickness** drop-downs.
   - Tap **+ Add** and enter a quantity. For LF/FT items the +10/+25/+50/+100 buttons speed this up.
     Items that aren't in the price list can be added by hand.
4. **Review.** Adjust quantities and set needed-by date, delivery or pickup, and notes.
   You can choose whether the listed pricing appears on the order.
5. **Create Order.** Send it as a Kim Industries-branded **PDF**: on phones, **Send PDF** attaches it
   to an email or text. You can also email the order as text, print it, copy it or download a CSV.
   Orders are numbered per job: `<job #>-001`, `-002`, `-003`… Every order is saved in **Order History**. Use **Reorder (copy)** to start a new draft
   from an old order at current prices.

**Price Lookup** on the home screen searches every supplier's prices without starting an order.

## Shared database (Supabase)

With Supabase connected, every crew member signs in. Orders are shared across the company, and order
numbers are handed out by the database, so two phones can never produce the same `24-118-002`.
The app still works with no signal: changes are saved on the phone and uploaded when it reconnects.
Orders created offline get their number once the phone is back online.

**One-time setup**
1. In Supabase, open **SQL Editor → New query**, paste in [`supabase/schema.sql`](supabase/schema.sql)
   and click **Run**. It creates the `orders`, `job_counters` and `supplier_contacts` tables, the
   `next_order_number()` function, and security rules that allow signed-in users only.
2. **Authentication → Sign In / Providers:** keep Email enabled and turn **off** "Allow new users to sign up",
   so only people the office adds can get in.
3. **Authentication → Users → Add user:** create each crew member with an email and password.
   Tick "Auto Confirm User".
4. **Project Settings → API:** copy the **Project URL** and the **anon / publishable key** into
   [`js/config.js`](js/config.js), then commit. The anon key is safe to publish, because the
   database only responds to signed-in users.

Leave `js/config.js` empty to run in single-device mode, where orders are saved only on each phone.

Sent orders can't be deleted. Only drafts can.

## Shop stock, users & permissions

**Shop Stock** (home screen) lists material on hand in our shops by **Division**: 100, 200, 300, 400,
450, 600 and 700. Stock is tracked by *material*, not by supplier. For example, "1/2" x 1" Fiberglass
Pipe Covering · JM · ASJ" is one material, whether it was bought from CT-DI, CT-SPI or CT-Homans.
The supplier only matters when an order is being created.

- **Everyone** can see shop stock.
- **People with shop permission** can add, remove or correct stock (*Add Material to Shop* → find
  the material → pick a division → enter the quantity). Every change is logged with who made it, when,
  and the job #.
- **Admins** manage people under **Settings → Users & Permissions**: add someone, give or take away
  shop permission, make them an admin, turn off their access, or reset their password.
  `amandak@kimindustries.com` is the first admin.

**Checking the shop is required when ordering.** When someone adds an item that we have in a shop, the
app stops and shows what's on hand in each division. They must choose either **use it from the shop**
(capped at what's available) or **order from the supplier**. Shop lines go on a separate "Pull from our
shop" list. They never appear on the supplier's order, PDF or total. Once the order is sent, people with
shop permission see it under **Waiting to be pulled**. Tapping **Mark pulled** takes the material out
of stock.

**One-time setup**
1. **SQL Editor:** run [`supabase/shop.sql`](supabase/shop.sql) after `schema.sql`.
2. *(Optional, lets admins create logins inside the app.)* **Edge Functions → Deploy a new function →
   Via Editor**. Name it `admin-users`, paste in
   [`supabase/functions/admin-users/index.ts`](supabase/functions/admin-users/index.ts), and click
   **Deploy**. Without it, admins can still set permissions in the app, but logins have to be created
   in **Authentication → Users**.

## Running / hosting

The app is static files, with no server code and no build step.

- **Try it locally:** `python3 -m http.server` in this folder, then open http://localhost:8000
- **Host it** on any static host, such as GitHub Pages (Settings › Pages › deploy from this branch),
  Netlify or an internal web server. Once it's served over HTTPS, crews can use **Add to Home Screen**,
  and it keeps working with poor or no signal.

## Updating the price list

1. Replace `data/source/Material_Dashboard.xlsx` with the new export. It needs the same columns:
   Item Name, Unit, Categories, Expected Price, Manufacturer, Model Number, Internal Identifier.
2. Run:
   ```
   pip install openpyxl
   python3 scripts/build_catalog.py
   ```
3. Commit the regenerated `data/catalog.js` and redeploy.

The **Manufacturer** column is used as the supplier. Items priced at 0 show as "Price TBD" and are
left out of the order total.

## Tests

```
node tests/search.test.js
```

## Special (job) pricing

Admins manage **price books** under **Special Pricing** (home screen), organized **by job #**. Each book
belongs to one supplier and one job. A price book that applies to several jobs is copied into each job,
either by entering several job #s when creating it or with **Copy to another job**. When anyone builds an order for one of those jobs,
every item that's in one of that job's books automatically uses the job price, with a green **Job price** tag.
Everything else uses the regular price list. Crews don't have to do anything. If an item appears more than
once, whether in one book or across a job's books, the **lowest** price wins. Draft orders re-price
automatically when books change; sent orders keep the prices they were sent with.

**Adding a book:** Special Pricing → New price book (job #s + supplier) → then either
**Add item** (search and type the job price) or **Import Excel / CSV / PDF**. The importer reads:
- supplier Excel/CSV/ODS price sheets (finds the item-code and price columns on the best sheet)
- price-book PDFs where item codes are followed by prices (e.g. Homans pricebooks)
- quote PDFs (DI, Homans, GIC). It uses the unit price and checks qty × price = amount, so garbled lines
  are skipped, not guessed.
- quotes with no item codes (e.g. SPI), matched by description. You tick which matches to keep; only
  size + material + type matches start ticked.

The importer never uses a price with a different unit than the price list, or one wildly off from the
regular price. It lists those lines so you can add them by hand. Scanned (image-only) PDFs can't be read.
Ask the supplier for a text PDF or Excel.

**One-time setup:** run [`supabase/pricing.sql`](supabase/pricing.sql) (after `shop.sql`).
The price books sent so far are pre-built in [`supabase/special-pricing/`](supabase/special-pricing/),
one file per job. Run each one in the SQL Editor. If you already loaded the older shared (multi-job) files, run
[`supabase/split_books_by_job.sql`](supabase/split_books_by_job.sql) once instead. It gives every job its own copy.

## Invoice Approval (AI agent)

Upload vendor invoices (PDF or photos) under **Invoice Approval**. An AI agent (Claude, running in the
`invoice-agent` Supabase Edge Function so the API key never reaches phones):
1. **reads** the invoice: vendor, invoice #, PO / references, and every line (item code, description, qty, unit, unit price).
2. **finds the order**: first by our order # on the invoice (e.g. PO "24-118-003"), otherwise by the products
   (the sent order from that supplier whose item codes best match, boosted if the job # is printed).
3. **matches lines** by item code (tolerant of O/0 and I/1 misreads). The agent pairs any leftover lines by description.
4. **compares prices** with plain arithmetic: invoice unit price vs. the price on our order (including job
   pricing). It flags lines billed at a different price and lines that weren't on the order, and notes short or over shipments.

Invoices land in tabs: **Needs review** (pricing doesn't match / no order found / couldn't read), **Matches order**,
**Approved**, **Sent back**. On each invoice the reviewer can **Approve**, choose a different order, re-run the check, or
**Send back to supplier**. That opens an email (subject "Incorrect invoice [number]") listing the mismatched lines,
with our order PDF and the vendor's invoice attached. Nothing is sent automatically: on phones it opens the
share sheet with the attachments; on computers it downloads both files and opens an email draft to attach them to.

Who can see invoices: admins, and people given **Can review invoices** in Users & Permissions.

**One-time setup**
1. **SQL Editor:** run [`supabase/invoices.sql`](supabase/invoices.sql). It creates the table, permission, and a private `invoices` storage bucket.
2. Get an Anthropic API key (console.anthropic.com → API Keys).
3. **Edge Functions → Secrets:** add `ANTHROPIC_API_KEY` with that key.
4. **Edge Functions → Deploy a new function → Via Editor:** name it **`invoice-agent`**, paste
   [`supabase/functions/invoice-agent/index.ts`](supabase/functions/invoice-agent/index.ts), click **Deploy**, then in the
   function's **Settings** turn **off** "Verify JWT". (If Supabase gives it a different name, put that name in
   `invoiceFunction` in `js/config.js`.)

Model: `claude-opus-5` with adaptive thinking. Set the secret `INVOICE_MODEL` / `INVOICE_EFFORT` to change them.
