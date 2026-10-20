import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// One versioned aggregate lets D1 serialize allocation and all audit events in
// one compare-and-swap. Appropriate for a small internal seat pool.
export const portalState = sqliteTable("portal_state", {
  id: text("id").primaryKey(),
  revision: integer("revision").notNull().default(0),
  document: text("document").notNull(),
});
