import type { UserFacingFailure } from "./user-facing-language.js";

export interface SurfaceAction {
  readonly id: string;
  readonly label: string;
  readonly emphasis: "primary" | "secondary" | "danger";
  readonly disabledReason?: string;
}

export type AsyncSurfaceState<T> =
  | { readonly status: "loading" }
  | {
      readonly status: "error";
      readonly failure: UserFacingFailure;
      readonly actions: readonly SurfaceAction[];
    }
  | {
      readonly status: "empty";
      readonly title: string;
      readonly description?: string;
      readonly actions: readonly SurfaceAction[];
    }
  | { readonly status: "ready"; readonly data: T };
