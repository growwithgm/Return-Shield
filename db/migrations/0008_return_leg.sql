-- The second code every return travels under, and which leg an event belongs to.
--
-- SAFE TO RUN BEFORE DEPLOYING, and it has to be run first. Everything here is
-- additive: three nullable columns on `shipments`, one defaulted column on
-- `shipment_events`, three check constraints and three indexes. Nothing the
-- version live today reads or writes changes shape, so the running app carries
-- on untouched either side of the deploy.
--
-- (The order matters the other way round. Migration first, Sync fork second:
-- when 0005 was deployed first, an escalation-tick read
-- `shipments.close_reason` before the column existed and failed.)
--
-- WHY THERE IS A SECOND CODE AT ALL. When Correos send a parcel back they do
-- not add events to the original tracking code — they create a new shipment,
-- with its own code, whose destination is our warehouse:
--
--   PKA6TP9800129340147006H   out to the customer
--   DXA6TP9800129340128012S   the same parcel coming back
--
-- The original goes quiet the moment the return starts, so nothing in this
-- database had ever reached `returned`: the leg that ends at our door is
-- always the second code. See lib/carriers/correos/return-code.ts.

ALTER TABLE "shipments" ADD COLUMN "return_code" text;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "return_code_source" text;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "returned_at" timestamp with time zone;--> statement-breakpoint

-- `correos` — they named it, in `associatedShipments` on the lookup.
-- `derived` — we worked it out from the original with the published check
-- letter, which reproduces all 109 real codes the operator collected.
-- Kept apart because a code Correos told us is never recomputed, so moving the
-- returns address (RETURN_POSTCODE) cannot rewrite a code they confirmed.
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_return_code_source_valid"
  CHECK (return_code_source IS NULL OR return_code_source IN ('correos', 'derived'));--> statement-breakpoint

-- The sweep asks Correos about return codes as well as originals, and the
-- answer has to find its way back to the right shipment row.
CREATE INDEX "shipments_return_code_idx" ON "shipments" USING btree ("return_code");--> statement-breakpoint

-- When the RETURN LEG was last asked about, which is not the same question as
-- when the parcel was.
--
-- It needs a column of its own because `last_reconciled_at` is what the due
-- rule reads (lib/recheck.ts): stamping that from a return-leg lookup would
-- make the parcel look freshly checked and defer its OUTBOUND check by up to
-- twelve hours — and a parcel in `bad_address` is on the three-hourly list
-- precisely because somebody is waiting on it.
ALTER TABLE "shipments" ADD COLUMN "return_checked_at" timestamp with time zone;--> statement-breakpoint
-- The queue is "oldest first, never-asked first", which is this index.
CREATE INDEX "shipments_return_check_idx"
  ON "shipments" USING btree ("return_checked_at")
  WHERE "return_code" IS NOT NULL AND "returned_at" IS NULL;--> statement-breakpoint
-- The Returns tab, and "back with us per Correos but never scanned in".
CREATE INDEX "shipments_returned_idx" ON "shipments" USING btree ("returned_at");--> statement-breakpoint

-- Which journey an event belongs to.
--
-- Return events are stored on the SAME shipment row, because they are the same
-- parcel and the operator reads one timeline. But they must never drive the
-- state machine the way an outbound event does: a "En reparto" on the return
-- leg is the parcel being driven back to US, and read as an outbound event it
-- would say the customer is about to receive it — then send them a message
-- about it. So the leg is on the row, project() reads it, and the only thing a
-- return event can do is move the parcel to `returning`, or to `returned` when
-- it is delivered.
--
-- Defaulted, so every event already in the table is outbound, which is what
-- they all are.
ALTER TABLE "shipment_events" ADD COLUMN "leg" text DEFAULT 'outbound' NOT NULL;--> statement-breakpoint
ALTER TABLE "shipment_events" ADD CONSTRAINT "shipment_events_leg_valid"
  CHECK (leg IN ('outbound', 'return'));--> statement-breakpoint

-- The timeline reads a parcel's events by leg, and the projection reads them
-- all; this covers the first and the existing shipment index covers the second.
CREATE INDEX "shipment_events_leg_idx" ON "shipment_events" USING btree ("shipment_id","leg","occurred_at");--> statement-breakpoint

-- And the Scanner's side of the same discovery.
--
-- A scan is matched to a parcel on the first fifteen characters of its code —
-- see 0007_scanner.sql and lib/scan/match.ts. Those fifteen are PREFIX plus
-- CORE, so the two legs of one parcel have different bases:
--
--   PKA6TP980012934   went out as
--   DXA6TP980012934   came back as
--
-- Equal from the third character and different in the first two, which is why
-- every DX label the warehouse ever scanned matched nothing and was filed
-- under "Not in Return Shield". These two indexes serve the comparison that
-- skips the prefix: fifteen characters from the third for a 23-character
-- Código de Bulto (which includes the parcel number, so it names one box), and
-- thirteen for an EXPEDICIÓN (which names the shipment). The widths are
-- constants so the index can actually be used.
CREATE INDEX "shipments_core_idx" ON "shipments" USING btree (substr("shipping_code", 3, 15));--> statement-breakpoint
CREATE INDEX "shipments_core13_idx" ON "shipments" USING btree (substr("shipping_code", 3, 13));--> statement-breakpoint

-- The scans side of the same matching, which the Parcels list runs twice per
-- row.
--
-- `latestScanLateral` ("has it left the warehouse / has it come back") now
-- also looks for a scan whose code IS the parcel's return code, and for one
-- whose characters 3-17 match the parcel's. Neither could use an index:
-- `scans_batch_code_idx` is on (batch_id, code_as_read) and cannot serve
-- `code_as_read` alone, and nothing indexed the core at all. Two laterals per
-- row over a growing scans table is the one place in this change that would
-- have turned into a sequential scan on the busiest screen.
CREATE INDEX "scans_code_idx" ON "scans" USING btree ("code_as_read");--> statement-breakpoint
CREATE INDEX "scans_core_idx"
  ON "scans" USING btree (substr("code_as_read", 3, 15), "direction", "scanned_at");--> statement-breakpoint

-- When somebody corrected a scan's direction, and nothing else.
--
-- On 20 November fifty-two outgoing parcels were scanned in Incoming mode, and
-- on 25 November thirty more. Both piles have to be moved to Outgoing, and a
-- scan quietly changing direction is the one thing on the Returns tab that
-- could not be explained afterwards — "this parcel was in the warehouse on the
-- 20th" became "it never was", with no record of who decided that or when.
-- So the correction is stamped. Nullable, because almost no scan is moved.
ALTER TABLE "scans" ADD COLUMN "direction_changed_at" timestamp with time zone;
