import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toUserFacingFailure, type UserFacingFailure } from "../presentation/user-facing-language.js";
import type { ProductMode, SkillListItem, SkillRootListItem } from "../types.js";
import { projectSkillsCatalog } from "./skills-catalog-projection.js";
import type { SkillCatalogFilter, SkillsSettingsSurface } from "./skills-settings-contract.js";
import {
  skillsSettingsHttpPort,
  skillsSettingsIdentityKey,
  type SkillsSettingsIdentity,
  type SkillsSettingsPort,
} from "./skills-settings-http-adapter.js";

export function useSkillsSettingsController({
  active,
  projectId,
  productMode,
  conversationId,
  providerId,
  onRefresh,
  port = skillsSettingsHttpPort,
}: {
  active: boolean;
  projectId: string | null;
  productMode: ProductMode;
  conversationId: string | null;
  providerId: string | null;
  onRefresh: () => Promise<void>;
  port?: SkillsSettingsPort;
}): SkillsSettingsSurface {
  const identityKey = skillsSettingsIdentityKey({ projectId, productMode, conversationId, providerId });
  const identityKeyRef = useRef(identityKey);
  identityKeyRef.current = identityKey;
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;
  const loadGenerationRef = useRef(0);
  const actionGenerationRef = useRef(0);
  const actionInFlightRef = useRef(false);
  const [skills, setSkills] = useState<readonly SkillListItem[]>([]);
  const [roots, setRoots] = useState<readonly SkillRootListItem[]>([]);
  const [catalogErrors, setCatalogErrors] = useState<readonly { path: string; message: string }[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SkillCatalogFilter>("all");
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [sourcePath, setSourcePath] = useState("");
  const [loading, setLoading] = useState(false);
  const [resolvedIdentityKey, setResolvedIdentityKey] = useState<string | null>(null);
  const [failure, setFailure] = useState<UserFacingFailure | null>(null);
  const [actionFailure, setActionFailure] = useState<UserFacingFailure | null>(null);
  const [busy, setBusy] = useState(false);

  const identity: SkillsSettingsIdentity | null = projectId
    ? { projectId, productMode, conversationId, providerId }
    : null;

  const load = useCallback(async (target: SkillsSettingsIdentity, targetIdentityKey: string): Promise<boolean> => {
    const generation = ++loadGenerationRef.current;
    setLoading(true);
    setFailure(null);
    try {
      const payload = await port.load(target);
      if (generation !== loadGenerationRef.current || targetIdentityKey !== identityKeyRef.current) return false;
      setSkills(Array.isArray(payload.skills) ? payload.skills : []);
      setRoots(Array.isArray(payload.roots) ? payload.roots : []);
      setCatalogErrors(Array.isArray(payload.errors) ? payload.errors : []);
      setResolvedIdentityKey(targetIdentityKey);
      return true;
    } catch (cause) {
      if (generation !== loadGenerationRef.current || targetIdentityKey !== identityKeyRef.current) return false;
      setSkills([]);
      setRoots([]);
      setCatalogErrors([]);
      setFailure(toUserFacingFailure(cause, "load"));
      setResolvedIdentityKey(targetIdentityKey);
      return false;
    } finally {
      if (generation === loadGenerationRef.current && targetIdentityKey === identityKeyRef.current) setLoading(false);
    }
  }, [port]);

  useEffect(() => {
    loadGenerationRef.current += 1;
    actionGenerationRef.current += 1;
    actionInFlightRef.current = false;
    setSkills([]);
    setRoots([]);
    setCatalogErrors([]);
    setQuery("");
    setFilter("all");
    setSelectedSkillId(null);
    setSourcesOpen(false);
    setDiagnosticsOpen(false);
    setSourcePath("");
    setFailure(null);
    setActionFailure(null);
    setBusy(false);
    if (!active || !identity) {
      setLoading(false);
      setResolvedIdentityKey(identityKey);
      return;
    }
    setResolvedIdentityKey(null);
    void load(identity, identityKey);
    return () => {
      loadGenerationRef.current += 1;
      actionGenerationRef.current += 1;
      actionInFlightRef.current = false;
    };
  }, [active, identityKey, load]);

  const run = useCallback(async (operation: (target: SkillsSettingsIdentity) => Promise<void>): Promise<boolean> => {
    const target = identity;
    const targetIdentityKey = identityKey;
    if (!target || actionInFlightRef.current) return false;
    actionInFlightRef.current = true;
    const generation = ++actionGenerationRef.current;
    setBusy(true);
    setActionFailure(null);
    try {
      await operation(target);
      if (generation !== actionGenerationRef.current || targetIdentityKey !== identityKeyRef.current) return false;
      const loaded = await load(target, targetIdentityKey);
      if (!loaded || generation !== actionGenerationRef.current || targetIdentityKey !== identityKeyRef.current) return false;
      await onRefreshRef.current();
      return generation === actionGenerationRef.current && targetIdentityKey === identityKeyRef.current;
    } catch (cause) {
      if (generation === actionGenerationRef.current && targetIdentityKey === identityKeyRef.current) {
        setActionFailure(toUserFacingFailure(cause, "settings"));
      }
      return false;
    } finally {
      if (generation === actionGenerationRef.current && targetIdentityKey === identityKeyRef.current) {
        actionInFlightRef.current = false;
        setBusy(false);
      }
    }
  }, [identity, identityKey, load]);

  const view = useMemo(() => projectSkillsCatalog({
    hasProject: Boolean(projectId),
    resolved: resolvedIdentityKey === identityKey,
    loading,
    skills: resolvedIdentityKey === identityKey ? skills : [],
    roots: resolvedIdentityKey === identityKey ? roots : [],
    catalogErrors: resolvedIdentityKey === identityKey ? catalogErrors : [],
    failure: resolvedIdentityKey === identityKey ? failure : null,
    actionFailure: resolvedIdentityKey === identityKey ? actionFailure : null,
    query,
    filter,
    conversationId,
    selectedSkillId,
    sourcePath,
    sourcesOpen,
    diagnosticsOpen,
    busy,
  }), [actionFailure, busy, catalogErrors, conversationId, diagnosticsOpen, failure, filter, identityKey, loading, projectId, query, resolvedIdentityKey, roots, selectedSkillId, skills, sourcePath, sourcesOpen]);

  return {
    view,
    actions: {
      refresh: async () => { await run((target) => port.refresh(target)); },
      setQuery: (nextQuery) => { setQuery(nextQuery); setSelectedSkillId(null); },
      setFilter: (nextFilter) => { setFilter(nextFilter); setSelectedSkillId(null); },
      openSkill: (skillId) => { setActionFailure(null); setSelectedSkillId(skillId); },
      closeSkill: () => { if (!actionInFlightRef.current) { setSelectedSkillId(null); setActionFailure(null); } },
      setProviderEnabled: async (skillId, enabled) => { await run((target) => port.setProviderEnabled(target, skillId, enabled)); },
      openSources: () => { setActionFailure(null); setSourcesOpen(true); },
      closeSources: () => { if (!actionInFlightRef.current) { setSourcesOpen(false); setSourcePath(""); setActionFailure(null); } },
      setSourcePath,
      addSource: async (rootPath) => {
        const added = await run((target) => port.addSource(target, rootPath.trim()));
        if (added) setSourcePath("");
      },
      openDiagnostics: () => setDiagnosticsOpen(true),
      closeDiagnostics: () => setDiagnosticsOpen(false),
    },
  };
}
