import type { BridgeState } from "./codex-bridge.ts";
import { rehydrateHistory } from "./history-policy.ts";
import { rollbackArchiveRows } from "./history-store.ts";

/** Explicit maintenance operation. Restore history into the CURRENT state,
 * guarded by a revision and stopped scheduling; archive table remains intact. */
export async function restoreV11History(db: D1Database, expectedRevision: number) {
  const old = await db.prepare("SELECT revision,document FROM portal_state WHERE id=?").bind("main")
    .first<{ revision: number; document: string }>();
  if (!old || old.revision !== expectedRevision) throw new Error("状态已变化，未执行回退；请重新读取当前版本。");
  const current = JSON.parse(old.document) as BridgeState;
  if(current.codex?.faultRescue && ['pending','uncertain'].includes(current.codex.faultRescue.phase))
    throw new Error('故障诊断尚未交还执行权，禁止版本回退。');
  if (current.config.automationEnabled || current.codex?.enabled || current.codex?.lease || current.codex?.holds?.length || current.codex?.operationFailureOrigin)
    throw new Error("请先停用执行器和云端调度，并结清全部租约与隔离任务后再回退。");
  const archived = await db.prepare("SELECT kind,id,email,user_id,sort_at,payload FROM portal_history ORDER BY sort_at,id").all<{
    kind: string; id: string; email: string; user_id: string; sort_at: string; payload: string;
  }>();
  const restored = rehydrateHistory(current, rollbackArchiveRows(archived.results ?? []));
  const document = JSON.stringify(restored);
  // A single V11 document cannot safely hold an arbitrarily large archive.
  // Fail before writing; the original aggregate and durable archive stay intact.
  if (new TextEncoder().encode(document).byteLength > 1_500_000)
    throw new Error("完整历史超过 V11 单文档安全容量，未执行回退；请保留归档兼容接口或先离线导出归档。");
  const result = await db.prepare("UPDATE portal_state SET document=?,revision=revision+1 WHERE id=? AND revision=?")
    .bind(document, "main", expectedRevision).run();
  if (result.meta.changes !== 1) throw new Error("回退准备期间状态发生变化，未覆盖新申请。");
  return { prepared: true, revision: expectedRevision + 1, requests: restored.requests.length,
    notices: restored.notices.length, audit: restored.audit.length, archivePreserved: true };
}
