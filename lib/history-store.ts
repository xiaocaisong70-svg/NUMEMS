import type { Actor, State } from "./seat-engine.ts";
import { AUTHORIZED_TEST_EMAIL } from "./seat-engine.ts";
import { compactHistory, type HistoryKind, type HistoryRow } from "./history-policy.ts";

export const HISTORY_INSERT_SQL = `INSERT OR IGNORE INTO portal_history(kind,id,email,user_id,sort_at,payload)
SELECT json_extract(value,'$.kind'),json_extract(value,'$.id'),json_extract(value,'$.email'),
json_extract(value,'$.userId'),json_extract(value,'$.sortAt'),json_extract(value,'$.payload')
FROM json_each(?) WHERE EXISTS(SELECT 1 FROM portal_state WHERE id='main' AND revision=?)`;

export async function persistHistoryCas(db: D1Database, previous: State, next: State, revision: number) {
  const compacted = compactHistory(previous, next);
  const document = JSON.stringify(compacted.state);
  if (!compacted.rows.length && document === JSON.stringify(previous)) return { committed: true, state: compacted.state };
  const update = db.prepare("UPDATE portal_state SET document=?, revision=revision+1 WHERE id=? AND revision=?")
    .bind(document, "main", revision);
  if (!compacted.rows.length) {
    const result = await update.run();
    return { committed: result.meta.changes === 1, state: compacted.state };
  }
  // D1 batch is transactional. A failed insert rolls back the update; a stale
  // revision inserts no history and updates no aggregate. No data-loss window.
  const inserts: D1PreparedStatement[] = [];
  for (let i = 0; i < compacted.rows.length; i += 100)
    inserts.push(db.prepare(HISTORY_INSERT_SQL).bind(JSON.stringify(compacted.rows.slice(i, i + 100)), revision));
  const results = await db.batch([...inserts, update]);
  return { committed: results[results.length - 1].meta.changes === 1, state: compacted.state };
}

export type HistoryPage = { kind: HistoryKind; items: Record<string, unknown>[]; nextCursor: string | null; archiveCount: number; capacityWarning: boolean };
export function historyQuery(actor: Actor, kind: HistoryKind, cursor?: string | null, limit = 50) {
  if (!["request", "notice", "audit"].includes(kind) || !Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("历史查询参数无效。");
  if (!actor.isAdmin && kind === "audit") throw new Error("操作日志仅管理员可见。");
  let sql = "SELECT id,sort_at,payload FROM portal_history WHERE kind=?";
  const bindings: (string | number)[] = [kind];
  if (!actor.isAdmin) {
    sql += " AND email=? AND (user_id=? OR user_id=? OR user_id=?)";
    bindings.push(actor.email, actor.userId, `inventory:${actor.email}`,
      actor.email === AUTHORIZED_TEST_EMAIL ? `test:${AUTHORIZED_TEST_EMAIL}` : actor.userId);
  }
  if (cursor) {
    if (cursor.length > 1000) throw new Error("历史游标无效。");
    let parsed: unknown;
    try { parsed = JSON.parse(decodeURIComponent(cursor)); } catch { throw new Error("历史游标无效。"); }
    const p = parsed as { at?: string; id?: string; kind?: string };
    if (!p || typeof p !== "object" || typeof p.at !== "string" || !Number.isFinite(Date.parse(p.at)) ||
        typeof p.id !== "string" || p.id.length > 200 || p.kind !== kind) throw new Error("历史游标无效。");
    sql += " AND (sort_at<? OR (sort_at=? AND id<?))";
    bindings.push(p.at, p.at, p.id);
  }
  sql += " ORDER BY sort_at DESC,id DESC LIMIT ?"; bindings.push(limit + 1);
  return { sql, bindings, limit };
}

export async function readHistoryPage(db: D1Database, actor: Actor, kind: HistoryKind, cursor?: string | null, limit = 50): Promise<HistoryPage> {
  const query = historyQuery(actor, kind, cursor, limit);
  const results = await db.prepare(query.sql).bind(...query.bindings).all<{ id: string; sort_at: string; payload: string }>();
  const rows = results.results ?? [];
  const page = rows.slice(0, limit), last = page[page.length - 1];
  // This count runs only on an explicit history-page load, never on the 10s
  // dashboard refresh or 15s worker queue poll.
  const countQuery = historyQuery(actor, kind, null, 1);
  const countSql = countQuery.sql.replace("SELECT id,sort_at,payload", "SELECT count(*) AS count").replace(" ORDER BY sort_at DESC,id DESC LIMIT ?", "");
  const count = await db.prepare(countSql).bind(...countQuery.bindings.slice(0, -1)).first<{ count: number }>();
  const archiveCount = count?.count ?? 0;
  const archiveTotal = actor.isAdmin
    ? (await db.prepare("SELECT count(*) AS count FROM portal_history").first<{ count: number }>())?.count ?? archiveCount : archiveCount;
  return { kind, items: page.map(r => JSON.parse(r.payload)), nextCursor: rows.length > limit && last
    ? encodeURIComponent(JSON.stringify({ at: last.sort_at, id: last.id, kind })) : null,
    archiveCount, capacityWarning: actor.isAdmin && archiveTotal >= 50_000 };
}

export async function archivedRequestKey(db: D1Database, actor: Actor, key: string) {
  // An old network retry must not create a fresh request after its original
  // terminal request has moved to the archive. Identity remains server-owned.
  const r = await db.prepare("SELECT payload FROM portal_history WHERE kind='request' AND email=? AND user_id=? AND json_extract(payload,'$.requestKey')=? LIMIT 1")
    .bind(actor.email, actor.userId, key).first<{ payload: string }>();
  return r ? JSON.parse(r.payload) : null;
}

export function rollbackArchiveRows(records: { kind: string; id: string; email: string; user_id: string; sort_at: string; payload: string }[]): HistoryRow[] {
  return records.map(r => ({ kind: r.kind as HistoryKind, id: r.id, email: r.email, userId: r.user_id, sortAt: r.sort_at, payload: r.payload }));
}
