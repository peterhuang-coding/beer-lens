"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { CaseLabel, CaseRecord } from "@/lib/beer-agent/cases";

const statuses = ["unlabeled", "reviewed", "fixed", "ignored"] as const;
const labels: Exclude<CaseLabel, null>[] = ["good", "intent_wrong", "ocr_wrong", "recommendation_bad", "hallucination", "memory_wrong", "data_missing", "response_bad"];
const field: CSSProperties = { background: "#0f1115", color: "#e8eaf0", border: "1px solid #394150", borderRadius: 5, padding: 8, maxWidth: "100%" };
const button: CSSProperties = { ...field, cursor: "pointer" };

async function responseData<T>(response: Response): Promise<T> {
  if (!response.ok) {
    if (response.status === 403) throw new Error("访问被拒绝，请填写有效的 Debug API token 后重试。");
    throw new Error(`请求失败 (HTTP ${response.status})`);
  }
  return response.json() as Promise<T>;
}

export default function CasesView() {
  const detailPanel = useRef<HTMLDivElement>(null);
  const [tokenInput, setTokenInput] = useState("");
  const [token, setToken] = useState("");
  const [status, setStatus] = useState("");
  const [label, setLabel] = useState("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [cases, setCases] = useState<CaseRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ case: CaseRecord; trace: unknown } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [reviewStatus, setReviewStatus] = useState<CaseRecord["status"]>("unlabeled");
  const [reviewLabel, setReviewLabel] = useState<CaseLabel>(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    fetch(`/api/cases?${query}`, { cache: "no-store", headers: { "x-debug-token": token }, signal: controller.signal })
      .then(responseData<CaseRecord[]>)
      .then(data => { if (!controller.signal.aborted) setCases(data); })
      .catch(err => { if (!controller.signal.aborted) setError(String(err.message ?? err)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [query, token, refresh]);

  useEffect(() => {
    if (!selected) return;
    detailPanel.current?.focus();
    const controller = new AbortController();
    setDetail(null);
    setDetailError("");
    setFeedback("");
    setSaveError("");
    setDetailLoading(true);
    fetch(`/api/cases/${encodeURIComponent(selected)}`, { cache: "no-store", headers: { "x-debug-token": token }, signal: controller.signal })
      .then(responseData<{ case: CaseRecord; trace: unknown }>)
      .then(data => {
        if (controller.signal.aborted) return;
        setDetail(data);
        setReviewStatus(data.case.status);
        setReviewLabel(data.case.label);
        setNote(data.case.note ?? "");
      })
      .catch(err => { if (!controller.signal.aborted) setDetailError(String(err.message ?? err)); })
      .finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    return () => controller.abort();
  }, [selected, token]);

  async function save() {
    if (!detail) return;
    setSaving(true);
    setFeedback("");
    setSaveError("");
    try {
      const updated = await fetch(`/api/cases/${encodeURIComponent(detail.case.id)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json", "x-debug-token": token },
        body: JSON.stringify({ status: reviewStatus, label: reviewLabel, note }),
      }).then(responseData<CaseRecord>);
      setDetail(current => current ? { ...current, case: updated } : current);
      setFeedback("已保存审核结果。");
      setRefresh(value => value + 1);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return <section aria-label="Cases 审核">
    <h2 style={{ fontSize: 17 }}>Cases · 对话案例审核</h2>
    <form className="card" onSubmit={event => {
      event.preventDefault();
      setToken(tokenInput);
      setQuery(new URLSearchParams({ status, label, search: search.trim() }).toString());
      setRefresh(value => value + 1);
    }}>
      <fieldset disabled={saving} style={{ border: 0, padding: 0, display: "flex", flexWrap: "wrap", alignItems: "end", gap: 12 }}>
        <label>审核状态<br /><select style={field} value={status} onChange={event => setStatus(event.target.value)}><option value="">全部状态</option>{statuses.map(value => <option key={value}>{value}</option>)}</select></label>
        <label>案例标签<br /><select style={field} value={label} onChange={event => setLabel(event.target.value)}><option value="">全部标签</option>{labels.map(value => <option key={value}>{value}</option>)}</select></label>
        <label>搜索输入 / 回复<br /><input style={field} value={search} onChange={event => setSearch(event.target.value)} placeholder="关键词" /></label>
        <label>Debug API token<br /><input style={field} type="password" autoComplete="off" value={tokenInput} onChange={event => setTokenInput(event.target.value)} placeholder="仅当前页面使用" /></label>
        <button style={button} type="submit">筛选 / 刷新</button>
      </fieldset>
    </form>
    {error && <p role="alert" style={{ color: "#f85149" }}>{error}</p>}
    {loading ? <p role="status">加载案例中…</p> : !error && <div className="card" style={{ marginTop: 16, overflowX: "auto" }}>
      <p className="muted">{cases.length} 条案例</p>
      {cases.length === 0 ? <p>没有符合条件的案例。可清空筛选条件后重试。</p> : <table style={{ width: "100%" }}>
        <thead><tr><th scope="col">时间 / 输入</th><th scope="col">意图</th><th scope="col">状态 / 标签</th><th scope="col">操作</th></tr></thead>
        <tbody>{cases.map(record => <tr key={record.id}>
          <td style={{ maxWidth: 460, overflowWrap: "anywhere" }}><small className="muted">{new Date(record.createdAt).toLocaleString()}</small><div>{record.input.text || "（图片输入）"}{record.input.hasImage ? " 🖼" : ""}</div></td>
          <td>{record.intent.name}</td><td>{record.status}<br />{record.label ?? "未标注"}</td>
          <td><button style={button} disabled={saving} aria-label={`查看案例 ${record.id}`} onClick={() => setSelected(record.id)}>查看</button></td>
        </tr>)}</tbody>
      </table>}
    </div>}
    {selected && <div ref={detailPanel} tabIndex={-1} aria-label="案例详情" className="card" style={{ marginTop: 16 }}>
      <button style={button} disabled={saving} onClick={() => { setSelected(null); setDetail(null); }}>关闭详情</button>
      {detailLoading && <p role="status">加载详情中…</p>}
      {detailError && <p role="alert" style={{ color: "#f85149" }}>{detailError}</p>}
      {detail && <>
        <h3 style={{ overflowWrap: "anywhere" }}>{detail.case.id}</h3>
        <p style={{ whiteSpace: "pre-wrap" }}><strong>输入：</strong>{detail.case.input.text || "（图片输入）"}</p>
        <p style={{ whiteSpace: "pre-wrap" }}><strong>回复预览：</strong>{detail.case.replyPreview || "（无回复）"}</p>
        <p>意图：{detail.case.intent.name} · 候选数：{detail.case.candidateCount}</p>
        {!!detail.case.warnings.length && <p style={{ color: "#f5a524" }}>警告：{detail.case.warnings.join("；")}</p>}
        <form onSubmit={event => { event.preventDefault(); void save(); }}>
          <fieldset disabled={saving} style={{ border: 0, padding: 0, display: "grid", gap: 12 }}>
            <label>审核状态（详情） <select style={field} value={reviewStatus} onChange={event => setReviewStatus(event.target.value as CaseRecord["status"])}>{statuses.map(value => <option key={value}>{value}</option>)}</select></label>
            <label>案例标签（详情） <select style={field} value={reviewLabel ?? ""} onChange={event => setReviewLabel((event.target.value || null) as CaseLabel)}><option value="">未标注</option>{labels.map(value => <option key={value}>{value}</option>)}</select></label>
            <label>审核备注<br /><textarea style={{ ...field, width: "100%", boxSizing: "border-box" }} rows={4} maxLength={10000} value={note} onChange={event => setNote(event.target.value)} /></label>
            <button style={{ ...button, justifySelf: "start" }} type="submit">{saving ? "保存中…" : "保存审核"}</button>
          </fieldset>
        </form>
        {feedback && <p role="status" style={{ color: "#3fb950" }}>{feedback}</p>}
        {saveError && <p role="alert" style={{ color: "#f85149" }}>{saveError}</p>}
        <details style={{ marginTop: 16 }}><summary>完整案例与 Trace</summary><pre style={{ overflow: "auto", maxHeight: 480, fontSize: 12 }}>{JSON.stringify(detail, null, 2)}</pre></details>
        {detail.trace === null && <p className="muted">原始 Trace 不存在或已清理，仍可审核已保存的案例。</p>}
      </>}
    </div>}
  </section>;
}
