import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

// One versioned aggregate lets D1 serialize allocation and all audit events in
// one compare-and-swap. Appropriate for a small internal seat pool.
export const portalState = sqliteTable("portal_state", {
  id: text("id").primaryKey(),
  revision: integer("revision").notNull().default(0),
  document: text("document").notNull(),
});

// Additive archive: closed records leave the frequently CAS-written aggregate,
// but remain durable and authorized through the paginated history endpoint.
export const portalHistory = sqliteTable("portal_history", {
  kind: text("kind").notNull(),
  id: text("id").notNull(),
  email: text("email").notNull(),
  userId: text("user_id").notNull(),
  sortAt: text("sort_at").notNull(),
  payload: text("payload").notNull(),
}, table => [
  primaryKey({ columns: [table.kind, table.id] }),
  index("portal_history_kind_date").on(table.kind, table.sortAt, table.id),
  index("portal_history_owner_date").on(table.kind, table.email, table.userId, table.sortAt, table.id),
]);
