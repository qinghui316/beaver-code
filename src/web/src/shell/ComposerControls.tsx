import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { Bot, ChevronDown, Info, Settings2, X } from "lucide-react";

export function ComposerControls({
  providerDisplayName = "AI 服务",
  modelLabel,
  onOpenModelSettings,
  providerOptions = [],
  selectedProviderId,
  onSelectProvider,
  requestDescription = "设置下一次 Agent 请求",
  readOnly = false,
  children,
}: {
  providerDisplayName?: string;
  modelLabel: string;
  onOpenModelSettings?: () => void;
  providerOptions?: Array<{ id: string; label: string }>;
  selectedProviderId?: string;
  onSelectProvider?: (providerId: string) => void;
  requestDescription?: string;
  readOnly?: boolean;
  children?: ReactNode;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const closeOnPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("pointerdown", closeOnPointerDown);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("pointerdown", closeOnPointerDown);
    };
  }, [open]);

  return (
    <div className="composer-model-control" ref={rootRef}>
      <button
        type="button"
        className="composer-model-trigger"
        aria-label={readOnly ? `当前 AHO 模型配置：${modelLabel}` : `模型与推理设置，当前模型：${modelLabel}`}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{modelLabel}</span>{readOnly ? <Info size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
      </button>
      {open ? (
        <section className="composer-model-popover" role="dialog" aria-label={readOnly ? "当前 AHO 配置" : "模型与推理设置"}>
          <header>
            <div><strong>{readOnly ? "当前 AHO 配置" : "模型与推理"}</strong><small>{requestDescription}</small></div>
            <button type="button" className="icon-button" aria-label={readOnly ? "关闭 AHO 配置" : "关闭模型与推理设置"} onClick={() => setOpen(false)}><X size={15} /></button>
          </header>
          <div className="composer-provider-summary">
            <Bot size={15} aria-hidden="true" />
            {!readOnly && providerOptions.length > 1 ? (
              <label>
                <span className="sr-only">选择 AI 服务</span>
                <select value={selectedProviderId ?? ""} onChange={(event) => onSelectProvider?.(event.target.value)} aria-label="选择 AI 服务">
                  {!selectedProviderId ? <option value="" disabled>选择 AI 服务</option> : null}
                  {providerOptions.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
                </select>
              </label>
            ) : <span>{providerDisplayName}</span>}
          </div>
          {children}
          {onOpenModelSettings ? (
            <button type="button" className="composer-model-settings-link" onClick={() => { setOpen(false); onOpenModelSettings(); }}>
              <Settings2 size={14} aria-hidden="true" />模型与服务设置
            </button>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
