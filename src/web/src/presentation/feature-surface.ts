export interface FeatureSurface<TView, TActions> {
  readonly view: Readonly<TView>;
  readonly actions: Readonly<TActions>;
}

type ActionKey<T> = {
  [K in keyof T]-?: K extends `on${string}` ? K : never;
}[keyof T];

export type FeatureSurfaceView<T> = Omit<T, ActionKey<T>>;
export type FeatureSurfaceActions<T> = Pick<T, ActionKey<T>>;

export function splitFeatureSurface<T extends object>(props: T): FeatureSurface<FeatureSurfaceView<T>, FeatureSurfaceActions<T>> {
  const view: Partial<T> = {};
  const actions: Partial<T> = {};
  for (const key of Object.keys(props) as Array<keyof T>) {
    if (String(key).startsWith("on")) actions[key] = props[key];
    else view[key] = props[key];
  }
  return {
    view: view as FeatureSurfaceView<T>,
    actions: actions as FeatureSurfaceActions<T>,
  };
}
