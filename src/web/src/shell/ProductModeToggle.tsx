import { ArrowLeftRight, MessageSquareCode, Workflow } from "lucide-react";
import type { ReactElement } from "react";
import type { ProductModeToggleViewModel } from "../presentation/core-workbench-experience.js";

export function ProductModeToggle({ view, onToggle }: { view: ProductModeToggleViewModel; onToggle: () => void }): ReactElement {
  const activity = view.targetActivity && !["idle", "unavailable"].includes(view.targetActivity) ? view.targetActivity : null;
  return (
    <button
      type="button"
      className="product-mode-toggle"
      aria-label={view.accessibleLabel}
      title={view.title}
      onClick={onToggle}
      data-mode={view.currentMode}
    >
      <span className="product-mode-toggle-stage" aria-hidden="true">
        <span className="product-mode-toggle-content agent">
          <MessageSquareCode size={16} />
          <strong>{view.currentMode === "agent" ? view.currentLabel : view.targetLabel}</strong>
        </span>
        <span className="product-mode-toggle-content harness">
          <Workflow size={16} />
          <strong>{view.currentMode === "harness" ? view.currentLabel : view.targetLabel}</strong>
        </span>
      </span>
      <span className="product-mode-toggle-affordance" aria-hidden="true">
        <ArrowLeftRight size={14} />
        {activity ? <span className={`product-mode-toggle-activity ${activity}`} /> : null}
      </span>
    </button>
  );
}
