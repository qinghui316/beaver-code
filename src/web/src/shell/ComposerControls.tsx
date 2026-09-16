import { Bot } from "lucide-react";
import type { ReactElement } from "react";

export function ComposerControls({
  providerDisplayName = "AI 服务",
  modelLabel,
}: {
  providerDisplayName?: string;
  modelLabel: string;
}): ReactElement {
  const label = `${providerDisplayName} · ${modelLabel}`;
  return (
    <div className="composer-model-control composer-model-control-readonly" aria-label={`当前运行配置：${label}`} title={label}>
      <Bot size={14} aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
