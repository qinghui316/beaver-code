import { useState, type ReactElement } from "react";
import type { DesktopReleaseNotes as ReleaseNotes } from "../../../types/workbench-update.js";

export function DesktopReleaseNotes({ notes }: { notes: ReleaseNotes | null | undefined }): ReactElement {
  const [language, setLanguage] = useState<"zhCN" | "enUS">("zhCN");
  if (notes === undefined) return <p className="desktop-release-notes-state">正在加载更新说明…</p>;
  if (notes === null) return <p className="desktop-release-notes-state">更新说明暂不可用。</p>;
  const selected = notes[language];
  return <section className="desktop-release-notes" aria-label="更新说明">
    <div className="desktop-release-notes-languages" role="group" aria-label="说明语言">
      <button type="button" aria-pressed={language === "zhCN"} onClick={() => setLanguage("zhCN")}>中文</button>
      <button type="button" aria-pressed={language === "enUS"} onClick={() => setLanguage("enUS")}>English</button>
    </div>
    <div lang={language === "zhCN" ? "zh-CN" : "en"}>
      <p>{selected.summary}</p>
      <ul>{selected.changes.map((change, index) => <li key={index}>{change}</li>)}</ul>
    </div>
  </section>;
}
