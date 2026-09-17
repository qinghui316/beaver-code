import { useState, type ReactElement } from "react";
import { Folder, Plus } from "lucide-react";
import { postJson, WorkbenchRequestError } from "../api.js";
import { userFacingErrorMessage } from "../presentation/user-facing-language.js";
import type { FolderDialogResult } from "../types.js";

export function ProjectAddForm({ onDone, onBusyChange }: { onDone: (projectId?: string) => Promise<void>; onBusyChange?: (busy: boolean) => void }): ReactElement {
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [manual, setManual] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function reportBusy(action: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(true);
    onBusyChange?.(true);
    try { await action(); } finally { setBusy(false); onBusyChange?.(false); }
  }
  async function submit(selectedPath = path): Promise<void> {
    const response = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: selectedPath, name: name || undefined, confirm: true }),
    });
    if (!response.ok) throw await WorkbenchRequestError.fromResponse(response);
    const result = await response.json() as { project: { id: string } };
    setMessage("项目已添加。");
    await onDone(result.project.id);
  }
  async function chooseFolder(): Promise<void> {
    setMessage(null);
    const result = await postJson<FolderDialogResult>("/api/dialog/open-folder", {});
    if (result.path) {
      setPath(result.path);
      await submit(result.path);
      return;
    }
    if (result.supported === false) {
      setManual(true);
      setMessage("当前系统无法打开文件夹选择器，请手动输入路径。");
      return;
    }
    if (result.canceled) {
      setMessage("已取消选择。");
      return;
    }
    setManual(true);
    setMessage("无法打开文件夹选择器，请手动输入路径。");
  }
  return (
    <form className="project-form" onSubmit={(event) => { event.preventDefault(); void reportBusy(() => submit()).catch((cause: unknown) => setMessage(userFacingErrorMessage(cause, "save"))); }}>
      <button type="button" className="primary-button" disabled={busy} onClick={() => void reportBusy(chooseFolder).catch((cause: unknown) => setMessage(userFacingErrorMessage(cause, "load")))}><Folder size={15} />{busy ? "正在处理" : "打开文件夹"}</button>
      <label className="project-form-field"><span>项目名称（可选）</span><input disabled={busy} type="text" value={name} onChange={(event) => setName(event.target.value)} placeholder="例如 Beaver Code" /></label>
      <button type="button" className="text-button" disabled={busy} onClick={() => setManual(!manual)}>{manual ? "收起路径输入" : "输入路径"}</button>
      {manual ? (
        <>
          <label className="project-form-field"><span>项目路径</span><input disabled={busy} type="text" value={path} onChange={(event) => setPath(event.target.value)} placeholder="例如 E:\\work\\my-app" /></label>
          <button type="submit" className="outline-button" disabled={busy}><Plus size={15} />添加项目</button>
        </>
      ) : null}
      {message ? <small role="status">{message}</small> : null}
    </form>
  );
}

export function ProjectCreateForm({ onDone, onBusyChange }: { onDone: (projectId?: string) => Promise<void>; onBusyChange?: (busy: boolean) => void }): ReactElement {
  const [parentPath, setParentPath] = useState("");
  const [name, setName] = useState("");
  const [git, setGit] = useState(true);
  const [readme, setReadme] = useState(true);
  const [initialCommit, setInitialCommit] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function reportBusy(action: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(true);
    onBusyChange?.(true);
    try { await action(); } finally { setBusy(false); onBusyChange?.(false); }
  }
  async function submit(): Promise<void> {
    const response = await fetch("/api/projects/new", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parentPath, name, git, readme, initialCommit, confirm: true }),
    });
    if (!response.ok) throw await WorkbenchRequestError.fromResponse(response);
    const result = await response.json() as { project: { id: string } };
    setMessage("新项目已创建并注册。");
    await onDone(result.project.id);
  }
  async function chooseParent(): Promise<void> {
    setMessage(null);
    const result = await postJson<FolderDialogResult>("/api/dialog/open-folder", {});
    if (result.path) {
      setParentPath(result.path);
      return;
    }
    if (result.supported === false) {
      setMessage("当前系统无法打开文件夹选择器，请手动输入父目录。");
      return;
    }
    if (result.canceled) {
      setMessage("已取消选择。");
      return;
    }
    setMessage("无法打开文件夹选择器，请手动输入保存位置。");
  }
  return (
    <form className="project-form" onSubmit={(event) => { event.preventDefault(); void reportBusy(submit).catch((cause: unknown) => setMessage(userFacingErrorMessage(cause, "save"))); }}>
      <button type="button" className="outline-button" disabled={busy} onClick={() => void reportBusy(chooseParent).catch((cause: unknown) => setMessage(userFacingErrorMessage(cause, "load")))}><Folder size={15} />选择位置</button>
      <label className="project-form-field"><span>保存位置</span><input disabled={busy} type="text" value={parentPath} onChange={(event) => setParentPath(event.target.value)} placeholder="例如 E:\\work" /></label>
      <label className="project-form-field"><span>项目名称</span><input disabled={busy} type="text" value={name} onChange={(event) => setName(event.target.value)} placeholder="例如 my-app" /></label>
      <label><input disabled={busy} type="checkbox" checked={git} onChange={(event) => setGit(event.target.checked)} /> 初始化 Git</label>
      <label><input disabled={busy} type="checkbox" checked={readme} onChange={(event) => setReadme(event.target.checked)} /> 创建 README</label>
      <label><input disabled={busy} type="checkbox" checked={initialCommit} onChange={(event) => setInitialCommit(event.target.checked)} /> 创建初始提交</label>
      <button type="submit" className="primary-button" disabled={busy || !parentPath.trim() || !name.trim()}><Plus size={15} />{busy ? "正在创建" : "新建项目"}</button>
      {message ? <small role="status">{message}</small> : null}
    </form>
  );
}
