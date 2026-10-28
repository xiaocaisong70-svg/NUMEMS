"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { History } from "lucide-react";

export default function HistoryArchive({ kind, render }: { kind: "request" | "notice" | "audit"; render?: (items: Record<string, unknown>[]) => ReactNode }) {
  const [items, setItems] = useState<Record<string, unknown>[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [archiveCount, setArchiveCount] = useState<number | null>(null);
  const [capacityWarning, setCapacityWarning] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  async function load() {
    if (busy || cursor === null) return;
    setBusy(true); setError(""); abort.current = new AbortController();
    const timeout = setTimeout(() => abort.current?.abort(), 15000);
    try {
      const query = new URLSearchParams({ kind, limit: "50", ...(cursor ? { cursor } : {}) });
      const response = await fetch(`/api/history?${query}`, { cache: "no-store", signal: abort.current.signal });
      const data = await response.json() as { page?: { items: Record<string, unknown>[]; nextCursor: string | null; archiveCount: number; capacityWarning: boolean }; error?: string };
      if (!response.ok || !data.page) throw new Error(data.error || "无法读取历史记录，请重新登录或稍后重试。");
      setItems(old => [...new Map([...old, ...data.page!.items].map(item => [String(item.id), item])).values()]);
      setCursor(data.page.nextCursor); setArchiveCount(data.page.archiveCount); setCapacityWarning(data.page.capacityWarning);
    } catch (e) { if (!abort.current?.signal.aborted) setError(e instanceof Error ? e.message : "历史记录读取失败。");
      else setError("历史记录读取超时，请重试。"); }
    finally { clearTimeout(timeout); setBusy(false); }
  }
  return <div className="history-archive">
    {items.length > 0 && (render ? render(items) : <div className="activity">{items.map(item => <div key={String(item.id)}><History size={17}/><div><strong>{String(item.title || item.type || item.action || "申请动态")}</strong><p>{String(item.message || "已记录状态变更")}</p></div><small>{new Date(String(item.createdAt || item.at)).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })}</small></div>)}</div>)}
    <div className="panel-heading"><span className="quiet">{archiveCount !== null && `${archiveCount} 条归档记录 · `}{cursor === null ? "较早记录已加载完毕" : "较早记录按页加载，不影响当前席位办理"}</span>{cursor !== null && <button className="button small soft" disabled={busy} onClick={() => void load()}>{busy ? "读取中…" : items.length ? "加载更多历史" : "查看更早记录"}</button>}</div>
    {capacityWarning && <p className="form-note" role="status">归档已达 50,000 条，请管理员评估存储额度并安排离线导出或保留期限；系统不会自行删除历史。</p>}
    {error && <p className="form-note" role="alert">{error}</p>}
  </div>;
}
