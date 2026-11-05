import { integer, pgTable, text } from "drizzle-orm/pg-core";
export const programs = pgTable("programs", {
  id: text("id").primaryKey(),
  details: text("details").notNull().default("{}"),
  motherVessel: text("motherVessel").notNull().default(""),
  lighterVessel: text("lighterVessel").notNull().default(""),
  masterMobile: text("masterMobile").notNull().default(""),
  destination: text("destination").notNull().default(""),
  escortName: text("escortName").notNull().default(""),
  escortMobile: text("escortMobile").notNull().default(""),
  startDate: text("startDate").notNull().default(""),
  endDate: text("endDate").notNull().default(""),
  shift: text("shift").notNull().default(""),
  status: text("status").notNull().default("Recorded"),
  source: text("source").notNull().default("Manual entry"),
  notes: text("notes").notNull().default(""),
  duplicateOf: text("duplicateOf"),
  createdAt: text("createdAt").notNull(),
  revision: integer("revision").notNull().default(0),
});
export const reviews = pgTable("reviews", {
  id: text("id").primaryKey(), aId: text("aId").notNull(), bId: text("bId").notNull(),
  decision: text("decision").notNull(), note: text("note").notNull().default(""), createdAt: text("createdAt").notNull(),
});
export const datasets=pgTable("datasets",{id:text("id").primaryKey(),importedAt:text("importedAt").notNull()});
// Immutable, versioned owner-supplied evidence snapshots, separate from canonical operations.
export const sourceSnapshots=pgTable('site_source_snapshots',{
 id:text('id').primaryKey(),datasetId:text('datasetId').notNull(),kind:text('kind').notNull(),
 payload:text('payload').notNull(),contentHash:text('contentHash').notNull(),
});
// Historical archive only; no live Core deployment is assumed.
export const cashArchive=pgTable("site_cash_archive",{
 id:text("id").primaryKey(),date:text("date").notNull(),source:text("source").notNull(),
 employeePhone:text("employeePhone").notNull(),name:text("name").notNull(),method:text("method").notNull(),
 amountCents:integer("amountCents").notNull(),details:text("details").notNull(),
});
export const operationNotes=pgTable("site_operation_notes",{
 id:text("id").primaryKey(),status:text("status").notNull(),note:text("note").notNull(),
 actor:text("actor").notNull(),updatedAt:text("updatedAt").notNull(),
});
export const paymentDrafts=pgTable("site_payment_drafts",{
 id:text("id").primaryKey(),details:text("details").notNull(),actor:text("actor").notNull(),createdAt:text("createdAt").notNull(),
});
export const settlementDrafts=pgTable('site_settlement_drafts',{
 id:text('id').primaryKey(),details:text('details').notNull(),actor:text('actor').notNull(),createdAt:text('createdAt').notNull(),
});
