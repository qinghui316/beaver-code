import { createContext, useContext } from "react";
import type { DesktopReleaseNotes } from "../../../types/workbench-update.js";

export interface DesktopUpdateOfferSurface {
  view: {
    available: boolean;
    version: string | null;
    releaseUrl: string | null;
    notes: DesktopReleaseNotes | null | undefined;
    expanded: boolean;
    submitting: boolean;
    failure: string | null;
  };
  actions: {
    open(): void;
    dismiss(): void;
    openReleaseNotes(): void;
    install(): Promise<void>;
  };
}

const unavailableSurface: DesktopUpdateOfferSurface = {
  view: {
    available: false,
    version: null,
    releaseUrl: null,
    notes: null,
    expanded: false,
    submitting: false,
    failure: null,
  },
  actions: {
    open() {},
    dismiss() {},
    openReleaseNotes() {},
    async install() {},
  },
};

export const DesktopUpdateOfferContext = createContext<DesktopUpdateOfferSurface>(unavailableSurface);

export function useDesktopUpdateOffer(): DesktopUpdateOfferSurface {
  return useContext(DesktopUpdateOfferContext);
}
