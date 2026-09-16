import { Info } from "lucide-react";
import type { ReactElement } from "react";
import type { ProductMode } from "../types.js";
import { productModeExperience } from "./core-workbench-experience.js";

export function ModeExperienceGuide({ mode }: {
  mode: ProductMode;
}): ReactElement {
  const experience = productModeExperience(mode);
  return (
    <span
      className="product-mode-compact-guide"
      tabIndex={0}
      aria-label={`${experience.title}。${experience.description}`}
      title={`${experience.title}。${experience.description}`}
    >
      <Info size={14} aria-hidden="true" />
    </span>
  );
}
