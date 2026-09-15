export interface FeatureSurface<TView, TActions> {
  readonly view: Readonly<TView>;
  readonly actions: Readonly<TActions>;
}
