-- Special (job) pricing for JOB 3734.
-- Run AFTER pricing.sql: Dashboard > SQL Editor > New query > paste this whole file > Run. Safe to re-run.
-- Built from the supplier price books/quotes with the app's import rules (item codes; lowest price wins for duplicates).

begin;

-- GIC · GIC material quote - IBM B004-3 (4 items)
insert into public.price_books (id, job_number, supplier, name, active) values ('a3f3f4fe-280f-42af-a501-c6f2d9141a44', '3734', 'GIC', 'GIC material quote - IBM B004-3', true)
  on conflict (id) do update set job_number = excluded.job_number, name = excluded.name, active = true, updated_at = now();
insert into public.price_book_items (book_id, item_key, item_name, unit, price) values
  ('a3f3f4fe-280f-42af-a501-c6f2d9141a44', 'GIC|20431', '1 1/8 x 1 x 6'' Insul-Lock', 'FT', 3.664),
  ('a3f3f4fe-280f-42af-a501-c6f2d9141a44', 'GIC|20474', '1 1/8 x 2 x 6'' Insul-Lock', 'FT', 15.861),
  ('a3f3f4fe-280f-42af-a501-c6f2d9141a44', 'GIC|19903', '2 3/16 x 48 x 300 FSK faced duct wrap, .75 PCF', 'RL', 105.024),
  ('a3f3f4fe-280f-42af-a501-c6f2d9141a44', 'GIC|20521', '620 Adhesive, Gallon, Black, 4/BX', 'EA', 115.278)
on conflict (book_id, item_key) do update set price = least(public.price_book_items.price, excluded.price), item_name = excluded.item_name, unit = excluded.unit, updated_at = now();

-- CT-Homans · Homans material quote - IBM B004-3 (72 items)
insert into public.price_books (id, job_number, supplier, name, active) values ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', '3734', 'CT-Homans', 'Homans material quote - IBM B004-3', true)
  on conflict (id) do update set job_number = excluded.job_number, name = excluded.name, active = true, updated_at = now();
insert into public.price_book_items (book_id, item_key, item_name, unit, price) values
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00372', '1 3/8" X 1/2" Armaflex Self Seal', 'FT', 3.29),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00532', '3/4" X 1" Fiberglass Pipe Covering', 'FT', 1.44),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00446', '1" X 1" Fiberglass Pipe Covering', 'FT', 1.55),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00442', '1 1/4" X 1" Fiberglass Pipe Covering', 'FT', 1.68),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00434', '1 1/2" X 1" Fiberglass Pipe Covering', 'FT', 1.81),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00499', '2" X 1" Fiberglass Pipe Covering', 'FT', 1.96),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00488', '2 1/2" X 1" Fiberglass Pipe Covering', 'FT', 2.22),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00526', '3" X 1" Fiberglass Pipe Covering', 'FT', 2.38),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00540', '4" X 1" Fiberglass Pipe Covering', 'FT', 3.15),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00547', '5" X 1" Fiberglass Pipe Covering', 'FT', 3.55),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00432', '1 1/2" X 1 1/2" Fiberglass Pipe Covering', 'FT', 3.06),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00485', '2 1/2" X 1 1/2" Fiberglass Pipe Covering', 'FT', 3.37),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00516', '3" X 1 1/2" Fiberglass Pipe Covering', 'FT', 3.79),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00534', '4" X 1 1/2" Fiberglass Pipe Covering', 'FT', 4.31),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00545', '5" X 1 1/2" Fiberglass Pipe Covering', 'FT', 4.83),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00556', '6" X 1 1/2" Fiberglass Pipe Covering', 'FT', 5.1),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00435', '1 1/2" X 2 1/2" Fiberglass Pipe Covering', 'FT', 5.46),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00501', '2" X 2 1/2" Fiberglass Pipe Covering', 'FT', 5.73),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00489', '2 1/2" X 2 1/2" Fiberglass Pipe Covering', 'FT', 6.59),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00541', '4" X 2 1/2" Fiberglass Pipe Covering', 'FT', 7.96),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00544', '4" X 3" Fiberglass Pipe Covering', 'FT', 9.97),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00537', '4 1/2" X 1" Fiberglass Pipe Covering', 'FT', 3.25),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00570', '8" X 1" Fiberglass Pipe Covering', 'FT', 6.15),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00423', '10" X 1" Fiberglass Pipe Covering', 'FT', 6.52),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00569', '8" X 1 1/2" Fiberglass Pipe Covering', 'FT', 7.14),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00576', '9" X 1 1/2" Fiberglass Pipe Covering', 'FT', 7.44),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00571', '8" X 2 1/2" Fiberglass Pipe Covering', 'FT', 12.2),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00454', '12" X 3" Fiberglass Pipe Covering', 'FT', 21.65),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00088', '#2 90s Aluminum Fitting Covers', 'EA', 7.29),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00089', '#3 90s Aluminum Fitting Covers', 'EA', 7.89),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00090', '#4 90s Aluminum Fitting Covers', 'EA', 9.33),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00093', '#7 90s Aluminum Fitting Covers', 'EA', 9.78),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00095', '#9 90s Aluminum Fitting Covers', 'EA', 11.44),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00096', '#10 90s Aluminum Fitting Covers', 'EA', 11.61),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00097', '#11 90s Aluminum Fitting Covers', 'EA', 13.39),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00099', '#13 90s Aluminum Fitting Covers', 'EA', 11.35),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00100', '#14 90s Aluminum Fitting Covers', 'EA', 13.48),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00101', '#15 90s Aluminum Fitting Covers', 'EA', 30.58),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00103', '#17 90s Aluminum Fitting Covers', 'EA', 15.39),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00105', '#19 90s Aluminum Fitting Covers', 'EA', 14.62),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00106', '#20 90s Aluminum Fitting Covers', 'EA', 17.14),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00107', '#21 90s Aluminum Fitting Covers', 'EA', 18.4),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00109', '#23 90s Aluminum Fitting Covers', 'EA', 20.8),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00110', '#24 90s Aluminum Fitting Covers', 'EA', 22.81),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00111', '#25 90s Aluminum Fitting Covers', 'EA', 41.14),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00115', '#29 90s Aluminum Fitting Covers', 'EA', 23.86),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00116', '#30 90s Aluminum Fitting Covers', 'EA', 23.39),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00119', '#33 90s Aluminum Fitting Covers', 'EA', 31),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00120', '#34 90s Aluminum Fitting Covers', 'EA', 36),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00121', '#35 90s Aluminum Fitting Covers', 'EA', 27.98),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00125', '#39 90s Aluminum Fitting Covers', 'EA', 31.57),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00130', '#44 90s Aluminum Fitting Covers', 'EA', 35.77),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00137', '#52 90s Aluminum Fitting Covers', 'EA', 89.83),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00139', '#54 90s Aluminum Fitting Covers', 'EA', 99.02),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00131', '#45 90s Aluminum Fitting Covers', 'EA', 51.94),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00141', '#56 90s Aluminum Fitting Covers', 'EA', 72.72),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00133', '#47 90s Aluminum Fitting Covers', 'EA', 48.98),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00169', '#2 Embossed Aluminum Fitting Covers', 'EA', 1.82),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00173', '#4 Embossed Aluminum Fitting Covers', 'EA', 2.16),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00177', '#6 Embossed Aluminum Fitting Covers', 'EA', 2.63),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00181', '#8 Embossed Aluminum Fitting Covers', 'EA', 3.47),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00678', '2.2" X 48" X 75'' R6 JM Microlite', 'EA', 98.28),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00670', '2" X 36" X 26'' JM Microflex', 'EA', 278.85),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00209', '1 1/2" X 36" X 48" Armaflex Pipe Insulation', 'FT', 36.96),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00026', '520 1 PT', 'PT', 102.88),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00046', 'CP-33 White 1GL Mastic Chil-Out VR Brush/Spray', 'GAL', 25.36),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT01040', '4" X 150" Foil Tape', 'RL', 18.06),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00062', '2 1/8 Minicup Insulated', 'BX', 95.78),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00061', 'Minicup 2 Insulated', 'BX', 95.26),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT22364', '4" X 150'' FSK Tape', 'RL', 15.58),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT00048', 'CP-35 White 1GL Mastic Chil-Perm VR Brush/Spray', 'GAL', 47),
  ('6f04a05c-18b2-4fed-aa93-597b61efeb5c', 'CT-Homans|CT01041', '3" X 150" ASJ Tape', 'RL', 21.63)
on conflict (book_id, item_key) do update set price = least(public.price_book_items.price, excluded.price), item_name = excluded.item_name, unit = excluded.unit, updated_at = now();

-- CT-SPI · SPI material quote - IBM B004 (41 items)
insert into public.price_books (id, job_number, supplier, name, active) values ('ba5e841e-680d-42f1-a493-9102773be7dc', '3734', 'CT-SPI', 'SPI material quote - IBM B004', true)
  on conflict (id) do update set job_number = excluded.job_number, name = excluded.name, active = true, updated_at = now();
insert into public.price_book_items (book_id, item_key, item_name, unit, price) values
  ('ba5e841e-680d-42f1-a493-9102773be7dc', 'CT-SPI|CT02215', '1 3/8" X 1" Aerocel Self Seal', 'FT', 4.29),
  ('ba5e841e-680d-42f1-a493-9102773be7dc', 'CT-SPI|CT02135', '1 3/8" X 2" Aerocel Pipe Insulation', 'FT', 13.9),
  ('ba5e841e-680d-42f1-a493-9102773be7dc', 'CT-SPI|CT01919', '3/4" X 1" Fiberglass Pipe Covering', 'FT', 1.17),
  ('ba5e841e-680d-42f1-a493-9102773be7dc', 'CT-SPI|CT01857', '1" X 1" Fiberglass Pipe Covering', 'FT', 1.26),
  ('ba5e841e-680d-42f1-a493-9102773be7dc', 'CT-SPI|CT01774', '1 1/4" X 1" Fiberglass Pipe Covering', 'FT', 1.36),
  ('ba5e841e-680d-42f1-a493-9102773be7dc', 'CT-SPI|CT01767', '1 1/2" X 1" Fiberglass Pipe Covering', 'FT', 1.47),
  ('ba5e841e-680d-42f1-a493-9102773be7dc', 'CT-SPI|CT01904', '2" X 1" Fiberglass Pipe Covering', 'FT', 1.59),
  ('ba5e841e-680d-42f1-a493-9102773be7dc', 'CT-SPI|CT01863', '2 1/2" X 1" Fiberglass Pipe Covering', 'FT', 1.8),
  ('ba5e841e-680d-42f1-a493-9102773be7dc', 'CT-SPI|CT01923', '3" X 1" Fiberglass Pipe Covering', 'FT', 1.93),
  ('ba5e841e-680d-42f1-a493-9102773be7dc', 'CT-SPI|CT01941', '4" X 1" Fiberglass Pipe Covering', 'FT', 2.57),
  ('ba5e841e-680d-42f1-a493-9102773be7dc', 'CT-SPI|CT01951', '5" X 1" Fiberglass Pipe Covering', 'FT', 2.89),
  ('ba5e841e-680d-42f1-a493-9102773be7dc', 'CT-SPI|CT01768', '1 1/2" X 1 1/2" Fiberglass Pipe Covering', 'FT', 2.49),
  ('ba5e841e-680d-42f1-a493-9102773be7dc', 'CT-SPI|CT01905', '2" X 1 1/2" Fiberglass Pipe Covering', 'FT', 2.75),
  ('ba5e841e-680d-42f1-a493-9102773be7dc', 'CT-SPI|CT01924', '3" X 1 1/2" Fiberglass Pipe Covering', 'FT', 3.09),
  ('ba5e841e-680d-42f1-a493-9102773be7dc', 'CT-SPI|CT01942', '4" X 1 1/2" Fiberglass Pipe Covering', 'FT', 3.51),
  ('ba5e841e-680d-42f1-a493-9102773be7dc', 'CT-SPI|CT01952', '5" X 1 1/2" Fiberglass Pipe Covering', 'FT', 3.93),
  ('ba5e841e-680d-42f1-a493-9102773be7dc', 'CT-SPI|CT01962', '6" X 1 1/2" Fiberglass Pipe Covering', 'FT', 4.15),
  ('ba5e841e-680d-42f1-a493-9102773be7dc', 'CT-SPI|CT01771', '1 1/2" X 2 1/2" Fiberglass Pipe Covering', 'FT', 4.45),
  ('ba5e841e-680d-42f1-a493-9102773be7dc', 'CT-SPI|CT01908', '2" X 2 1/2" Fiberglass Pipe Covering', 'FT', 4.66),
  ('ba5e841e-680d-42f1-a493-9102773be7dc', 'CT-SPI|CT01867', '2 1/2" X 2 1/2" Fiberglass Pipe Covering', 'FT', 5.37),
  ('ba5e841e-680d-42f1-a493-9102773be7dc', 'CT-SPI|CT01945', '4" X 2 1/2" Fiberglass Pipe Covering', 'FT', 6.48),
  ('ba5e841e-680d-42f1-a493-9102773be7dc', 'CT-SPI|CT01946', '4" X 3" Fiberglass Pipe Covering', 'FT', 8.12),
  ('ba5e841e-680d-42f1-a493-9102773be7dc', 'CT-SPI|CT01993', '9" X 3" Fiberglass Pipe Covering', 'FT', 13.21),
  ('ba5e841e-680d-42f1-a493-9102773be7dc', 'CT-SPI|CT01788', '10" X 3" Fiberglass Pipe Covering', 'FT', 14.15),
  ('ba5e841e-680d-42f1-a493-9102773be7dc', 'CT-SPI|CT01797', '11" X 3" Fiberglass Pipe Covering', 'FT', 18.16),
  ('ba5e841e-680d-42f1-a493-9102773be7dc', 'CT-SPI|CT01804', '12" X 3" Fiberglass Pipe Covering', 'FT', 17.65),
  ('ba5e841e-680d-42f1-a493-9102773be7dc', 'CT-SPI|CT01813', '14" X 3" Fiberglass Pipe Covering', 'FT', 21.14),
  ('ba5e841e-680d-42f1-a493-9102773be7dc', 'CT-SPI|CT01838', '17" X 3" Fiberglass Pipe Covering', 'FT', 26.77),
  ('ba5e841e-680d-42f1-a493-9102773be7dc', 'CT-SPI|CT01805', '12" X 3 1/2" Fiberglass Pipe Covering', 'FT', 19.22),
  ('ba5e841e-680d-42f1-a493-9102773be7dc', 'CT-SPI|CT01814', '14" X 3 1/2" Fiberglass Pipe Covering', 'FT', 23.58),
  ('ba5e841e-680d-42f1-a493-9102773be7dc', 'CT-SPI|CT01817', '14" X 5" Fiberglass Pipe Covering', 'FT', 40.91),
  ('ba5e841e-680d-42f1-a493-9102773be7dc', 'CT-SPI|CT01833', '16" X 5" Fiberglass Pipe Covering', 'FT', 46.03),
  ('ba5e841e-680d-42f1-a493-9102773be7dc', 'CT-SPI|CT01933', '4 1/2" X 1" Fiberglass Pipe Covering', 'FT', 2.64),
  ('ba5e841e-680d-42f1-a493-9102773be7dc', 'CT-SPI|CT01980', '8" X 1" Fiberglass Pipe Covering', 'FT', 5.01),
  ('ba5e841e-680d-42f1-a493-9102773be7dc', 'CT-SPI|CT01784', '10" X 1" Fiberglass Pipe Covering', 'FT', 5.32),
  ('ba5e841e-680d-42f1-a493-9102773be7dc', 'CT-SPI|CT01981', '8" X 1 1/2" Fiberglass Pipe Covering', 'FT', 5.82),
  ('ba5e841e-680d-42f1-a493-9102773be7dc', 'CT-SPI|CT01990', '9" X 1 1/2" Fiberglass Pipe Covering', 'FT', 6.05),
  ('ba5e841e-680d-42f1-a493-9102773be7dc', 'CT-SPI|CT01983', '8" X 2 1/2" Fiberglass Pipe Covering', 'FT', 9.95),
  ('ba5e841e-680d-42f1-a493-9102773be7dc', 'CT-SPI|CT01992', '9" X 2 1/2" Fiberglass Pipe Covering', 'FT', 10.88),
  ('ba5e841e-680d-42f1-a493-9102773be7dc', 'CT-SPI|CT01126', '2" AP Fiberglass Boards', 'SF', 3.62),
  ('ba5e841e-680d-42f1-a493-9102773be7dc', 'CT-SPI|CT22238', '1" Aerocel Sheet RL', 'SF', 3.43)
on conflict (book_id, item_key) do update set price = least(public.price_book_items.price, excluded.price), item_name = excluded.item_name, unit = excluded.unit, updated_at = now();

commit;

-- Check: price books for this job and their item counts.
select job_number, supplier, name, (select count(*) from public.price_book_items i where i.book_id = b.id) as items from public.price_books b where '3734' = any(b.job_keys) order by supplier, name;
