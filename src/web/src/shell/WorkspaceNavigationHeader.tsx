import { PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";
import { useCallback, useEffect, useRef, type ReactElement, type RefObject } from "react";
import type { ProductModeToggleViewModel } from "../presentation/core-workbench-experience.js";
import type { ProjectNavigationFeatureSurface } from "../presentation/project-navigation.js";
import { ProductModeToggle } from "./ProductModeToggle.js";
import { ProjectConversationSearchPalette } from "./ProjectConversationSearchPalette.js";
import { DesktopUpdateDock } from "./DesktopUpdateDock.js";

export function WorkspaceNavigationHeader({ mode, onToggleMode, navigation, mobileSidebarOpen, onToggleMobileSidebar, mobileSidebarToggleRef }: {
  mode: ProductModeToggleViewModel;
  onToggleMode: () => void;
  navigation: ProjectNavigationFeatureSurface;
  mobileSidebarOpen: boolean;
  onToggleMobileSidebar: () => void;
  mobileSidebarToggleRef: RefObject<HTMLButtonElement | null>;
}): ReactElement {
  const searchRef = useRef<HTMLButtonElement | null>(null);
  const searchOpen = navigation.view.overlay.kind === "search";
  const toggleSearch = useCallback(() => {
    navigation.actions.onOpenSearch();
    if (!searchOpen) void navigation.actions.onPrepareSearch();
  }, [navigation.actions, searchOpen]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault(); toggleSearch();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleSearch]);
  return (
    <header className="workspace-navigation-header" data-testid="product-mode-control">
      <div className="workspace-navigation-header-primary">
        <button ref={mobileSidebarToggleRef} type="button" className="mobile-sidebar-toggle" aria-label={mobileSidebarOpen ? "关闭会话栏" : "打开会话栏"} aria-controls="project-conversation-sidebar" aria-expanded={mobileSidebarOpen} onClick={onToggleMobileSidebar}>
          {mobileSidebarOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
        </button>
        <ProductModeToggle view={mode} onToggle={onToggleMode} />
      </div>
      <div className="workspace-navigation-header-actions">
        <DesktopUpdateDock className="workspace-update-dock" displayWhen="mobile" />
        <button ref={searchRef} type="button" className="workspace-navigation-search" aria-label="搜索项目和会话" aria-expanded={searchOpen} title="搜索项目和会话 (Ctrl+K)" onClick={toggleSearch}><Search size={18} /></button>
      </div>
      <ProjectConversationSearchPalette surface={navigation} triggerRef={searchRef} />
    </header>
  );
}
