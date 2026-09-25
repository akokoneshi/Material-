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
