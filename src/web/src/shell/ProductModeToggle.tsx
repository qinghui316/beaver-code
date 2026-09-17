import { MessageSquareCode, Workflow } from "lucide-react";
import type { ReactElement } from "react";
import type { ProductModeToggleViewModel } from "../presentation/core-workbench-experience.js";

export function ProductModeToggle({ view, onToggle }: { view: ProductModeToggleViewModel; onToggle: () => void }): ReactElement {
  const Icon = view.currentMode === "agent" ? MessageSquareCode : Workflow;
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
      <span className="product-mode-toggle-content" key={view.currentMode}>
        <Icon size={16} aria-hidden="true" />
        <strong>{view.currentLabel}</strong>
      </span>
      {activity ? <span className={`product-mode-toggle-activity ${activity}`} aria-hidden="true" /> : null}
    </button>
  );
}
