import { useCallback, useRef, useState } from "react";
import type { ProductMode } from "../types.js";
import { readApplicationLocation } from "./application-navigation-contract.js";

export const PRODUCT_MODE_STORAGE_KEY = "aho.workbench.productMode.v1";

export interface AppModePreferencePort {
  read(): unknown;
  write(productMode: ProductMode): void;
}

export interface AppModeController {
  productMode: ProductMode;
  selectMode(productMode: ProductMode): void;
}

export function useAppModeController(
  preference: AppModePreferencePort = browserAppModePreference,
): AppModeController {
  const preferenceRef = useRef(preference);
  preferenceRef.current = preference;
  const [productMode, setProductMode] = useState<ProductMode>(() => {
    const fallback = restoreProductMode(preference.read());
    return typeof window === "undefined" ? fallback : readApplicationLocation(new URL(window.location.href), fallback).productMode;
  });

  const selectMode = useCallback((nextMode: ProductMode): void => {
    if (!isProductMode(nextMode)) throw new Error("productMode must be agent or harness.");
    preferenceRef.current.write(nextMode);
    setProductMode(nextMode);
  }, []);

  return { productMode, selectMode };
}

export function restoreProductMode(value: unknown): ProductMode {
  return isProductMode(value) ? value : "harness";
}

export function isProductMode(value: unknown): value is ProductMode {
  return value === "agent" || value === "harness";
}

const browserAppModePreference: AppModePreferencePort = {
  read(): unknown {
    try {
      return window.localStorage.getItem(PRODUCT_MODE_STORAGE_KEY);
    } catch {
      return null;
    }
  },
  write(productMode): void {
    try {
      window.localStorage.setItem(PRODUCT_MODE_STORAGE_KEY, productMode);
    } catch {
      // Preference persistence must not make the Workbench unusable.
    }
  },
};
