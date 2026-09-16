import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Bot, Check, ChevronDown, Gauge, RefreshCw } from "lucide-react";
import type { ReactElement } from "react";
import type { ProviderModelCatalogGroup, ProviderModelSettingsSnapshot } from "../types.js";

export function ConversationModelSelectors({
  catalogs,
  selectedProviderId,
  modelId,
  reasoningEffort,
  loading = false,
  onRefresh,
  onSelectProviderModel,
  onSelectReasoningEffort,
}: {
  catalogs: ProviderModelCatalogGroup[];
  selectedProviderId: string | null;
  modelId: string | null;
  reasoningEffort: string | null;
  loading?: boolean;
  onRefresh?: () => void | Promise<void>;
  onSelectProviderModel(providerId: string, modelId: string | null): void | Promise<void>;
  onSelectReasoningEffort(effort: string | null): void | Promise<void>;
}): ReactElement {
  const selectedGroup = catalogs.find((group) => group.providerId === selectedProviderId) ?? null;
  const snapshot = selectedGroup?.snapshot ?? null;
  const candidate = selectedCandidate(snapshot, modelId);
  const resolvedModelId = modelId ?? snapshot?.effectiveModel?.modelId ?? null;
  const modelLabel = candidate?.label ?? resolvedModelId ?? (loading ? "正在检测模型" : "选择模型");
  const effort = candidate?.supportedReasoningEfforts.find((option) => option.value === reasoningEffort);
  const selectedModelValue = selectedProviderId ? modelSelectionValue(selectedProviderId, modelId) : "";

  return (
    <div className="agent-model-selectors" data-testid="agent-model-selectors">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button type="button" className="agent-model-menu-trigger" aria-label={`模型：${modelLabel}`}>
            <Bot size={14} aria-hidden="true" /><span>{modelLabel}</span><ChevronDown size={13} aria-hidden="true" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="agent-model-menu-content" side="top" align="start" sideOffset={6} collisionPadding={12}>
            {catalogs.length === 0 ? <DropdownMenu.Label className="agent-model-menu-empty">{loading ? "正在读取模型目录…" : "没有可用模型"}</DropdownMenu.Label> : null}
            <DropdownMenu.RadioGroup value={selectedModelValue} onValueChange={(value) => {
              const [providerId, selectedModelId] = value.split("\0", 2);
              if (providerId) void onSelectProviderModel(providerId, selectedModelId || null);
            }}>
              {catalogs.map((group, index) => (
                <div key={group.providerId}>
                  {index > 0 ? <DropdownMenu.Separator className="agent-model-menu-separator" /> : null}
                  <DropdownMenu.Label className="agent-model-menu-label">{group.displayName}</DropdownMenu.Label>
                  {group.status === "error" ? <div className="agent-model-menu-error">{group.message ?? "模型目录暂时不可用"}</div> : null}
                  {group.status === "loading" ? <div className="agent-model-menu-empty">正在检测…</div> : null}
                  {group.snapshot ? <>
                    <ModelItem value={modelSelectionValue(group.providerId, null)} label="使用该服务默认模型" description={group.snapshot.effectiveModel?.modelId ?? "由服务决定"} />
                    {group.snapshot.candidates.map((item) => <ModelItem key={`${group.providerId}:${item.modelId}`} value={modelSelectionValue(group.providerId, item.modelId)} label={item.label} description={item.modelId === item.label ? item.source : `${item.modelId} · ${item.source}`} />)}
                  </> : null}
                </div>
              ))}
            </DropdownMenu.RadioGroup>
            {onRefresh ? <>
              <DropdownMenu.Separator className="agent-model-menu-separator" />
              <DropdownMenu.Item className="agent-model-menu-item agent-model-menu-refresh" onSelect={() => void onRefresh()}>
                <RefreshCw size={14} aria-hidden="true" /><span>{loading ? "正在刷新" : "重新检测模型"}</span>
              </DropdownMenu.Item>
            </> : null}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button type="button" className="agent-model-menu-trigger" aria-label={`思考强度：${effort?.label ?? "模型默认值"}`} disabled={!candidate}>
            <Gauge size={14} aria-hidden="true" /><span>{effort?.label ?? "模型默认值"}</span><ChevronDown size={13} aria-hidden="true" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="agent-model-menu-content agent-reasoning-menu-content" side="top" align="start" sideOffset={6} collisionPadding={12}>
            <DropdownMenu.RadioGroup value={reasoningEffort ?? "__default__"} onValueChange={(value) => void onSelectReasoningEffort(value === "__default__" ? null : value)}>
              <ReasoningItem value="__default__" label="模型默认值" description={candidate?.defaultReasoningEffort ? `默认：${candidate.defaultReasoningEffort}` : undefined} />
              {candidate?.supportedReasoningEfforts.map((option) => <ReasoningItem key={option.value} value={option.value} label={option.label} description={option.description} />)}
            </DropdownMenu.RadioGroup>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}

function ModelItem({ value, label, description }: { value: string; label: string; description?: string }): ReactElement {
  return <DropdownMenu.RadioItem className="agent-model-menu-item" value={value}>
    <span className="agent-model-menu-check"><DropdownMenu.ItemIndicator><Check size={14} aria-hidden="true" /></DropdownMenu.ItemIndicator></span>
    <span className="agent-model-menu-copy"><strong>{label}</strong>{description ? <small>{description}</small> : null}</span>
  </DropdownMenu.RadioItem>;
}

function ReasoningItem({ value, label, description }: { value: string; label: string; description?: string }): ReactElement {
  return <DropdownMenu.RadioItem className="agent-model-menu-item" value={value}>
    <span className="agent-model-menu-check"><DropdownMenu.ItemIndicator><Check size={14} aria-hidden="true" /></DropdownMenu.ItemIndicator></span>
    <span className="agent-model-menu-copy"><strong>{label}</strong>{description ? <small>{description}</small> : null}</span>
  </DropdownMenu.RadioItem>;
}

function selectedCandidate(snapshot: ProviderModelSettingsSnapshot | null, modelId: string | null) {
  const resolved = modelId ?? snapshot?.effectiveModel?.modelId ?? null;
  return resolved ? snapshot?.candidates.find((item) => item.modelId.toLowerCase() === resolved.toLowerCase()) ?? null : null;
}

function modelSelectionValue(providerId: string, modelId: string | null): string {
  return `${providerId}\0${modelId ?? ""}`;
}
