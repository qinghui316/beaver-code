import { MessageSquareCode, Workflow } from "lucide-react";
import type { ReactElement } from "react";
import type { ProductModeToggleViewModel } from "../presentation/core-workbench-experience.js";

export function ProductModeToggle({ view, onToggle }: { view: ProductModeToggleViewModel; onToggle: () => void }): ReactElement {
  const activity = view.targetActivity && !["idle", "unavailable"].includes(view.targetActivity) ? view.targetActivity : null;
  return (
    <button
      type="button"
      className="product-mode-toggle"
      role="switch"
      aria-checked={view.currentMode === "harness"}
      aria-label={view.accessibleLabel}
      title={view.title}
      onClick={onToggle}
      data-mode={view.currentMode}
    >
      <span className="product-mode-toggle-endpoint agent" aria-hidden="true"><MessageSquareCode size={16} /></span>
      <span className="product-mode-toggle-endpoint harness" aria-hidden="true"><Workflow size={16} /></span>
      <span className="product-mode-toggle-thumb" aria-hidden="true">
        <span className="product-mode-toggle-label agent">Agent 模式</span>
        <span className="product-mode-toggle-label harness">AHO 模式</span>
      </span>
      {activity ? <span className={`product-mode-toggle-activity ${activity}`} aria-hidden="true" /> : null}
    </button>
  );
}
