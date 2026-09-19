import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, Shield, ShieldAlert } from "lucide-react";
import { useRef, useState } from "react";
import { DialogSurface } from "../presentation/DialogSurface.js";
import type { AgentAccessMode, ConversationAccessView } from "../controllers/conversation-access-contract.js";

export interface AgentAccessControlProps {
  accessView?: ConversationAccessView;
  onSelectAccess?: (mode: AgentAccessMode, confirmed?: boolean) => Promise<void>;
  onRefreshAccess?: () => Promise<void>;
}

export function AgentAccessControl(props: AgentAccessControlProps & { planning: boolean }) {
  return <ScopedAgentAccessControl key={props.accessView?.scopeKey} {...props} />;
}

function ScopedAgentAccessControl({ accessView: view, onSelectAccess, onRefreshAccess, planning }: AgentAccessControlProps & { planning: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  if (!view?.visible) return null;
  const label = view.mode === "full-access" ? "完全访问" : "默认权限";
  return <>
    {planning ? <span className="composer-access-readonly"><Shield size={14} aria-hidden="true" />计划中仅分析</span> :
      <DropdownMenu.Root open={open} onOpenChange={setOpen}>
        <DropdownMenu.Trigger asChild>
          <button ref={triggerRef} type="button" className={`composer-access-trigger${view.mode === "full-access" ? " is-full-access" : ""}`}
            disabled={view.busy} aria-label={`访问权限：${label}`} title="应用于后续新提交">
            {view.mode === "full-access" ? <ShieldAlert size={15} aria-hidden="true" /> : <Shield size={15} aria-hidden="true" />}
            <span>{label}</span><ChevronDown size={12} aria-hidden="true" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="navigation-action-menu composer-access-menu" side="top" align="start" sideOffset={8} collisionPadding={12} aria-label="访问权限">
            <DropdownMenu.Label className="composer-access-description">应用于后续新提交</DropdownMenu.Label>
            <DropdownMenu.Item className="navigation-action-menu-item" disabled={view.busy || Boolean(view.failure)} onSelect={() => void onSelectAccess?.("default")}>
              <Shield size={15} />默认权限{view.mode === "default" ? <Check size={14} /> : null}
            </DropdownMenu.Item>
            <DropdownMenu.Item className="navigation-action-menu-item" disabled={view.busy || Boolean(view.failure) || !view.fullAccessAvailable}
              onSelect={() => { if (view.mode !== "full-access") setConfirming(true); }}>
              <ShieldAlert size={15} />完全访问{view.mode === "full-access" ? <Check size={14} /> : null}
            </DropdownMenu.Item>
            {!view.fullAccessAvailable ? <p className="composer-access-description">当前 AI 服务暂不支持完全访问。</p> : null}
            {view.failure ? <DropdownMenu.Item className="navigation-action-menu-item" onSelect={() => void onRefreshAccess?.()}>重新检测</DropdownMenu.Item> : null}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>}
    <DialogSurface open={confirming} onClose={() => setConfirming(false)} dismissible={!view.busy}
      ariaLabel="允许完全访问" panelClassName="composer-access-dialog" returnFocusRef={triggerRef} portal>
      <ShieldAlert size={24} aria-hidden="true" />
      <h2>允许完全访问？</h2>
      <p>Agent 将能够访问当前系统账户可访问的文件、运行命令并连接网络。该选择应用于后续新提交，不会改变正在执行或已待发送的任务。</p>
      <p>完全访问不代表管理员权限。</p>
      <div className="composer-access-dialog-actions">
        <button type="button" className="secondary-button" disabled={view.busy} onClick={() => setConfirming(false)}>取消</button>
        <button type="button" className="primary-button" disabled={view.busy} onClick={async () => {
          await onSelectAccess?.("full-access", true); setConfirming(false);
        }}>{view.busy ? "正在保存…" : "允许完全访问"}</button>
      </div>
    </DialogSurface>
  </>;
}
