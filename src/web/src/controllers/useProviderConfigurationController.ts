import { useCallback, useEffect, useRef, useState } from "react";
import { fetchJson } from "../api.js";
import { userFacingErrorMessage } from "../presentation/user-facing-language.js";
import type {
  ProductMode,
  ProviderCapabilitySnapshot,
  ProviderDiagnostics,
  ProviderModelCatalogGroup,
  ProviderModelSettingsSnapshot,
} from "../types.js";

export interface ProviderConfigurationInput {
  projectId: string | null;
  productMode?: ProductMode;
  projectDefaultProviderId: string | null;
  conversationProviderId: string | null;
  onError(message: string): void;
}

export function useProviderConfigurationController(
  input: ProviderConfigurationInput,
) {
  const productMode = input.productMode ?? "harness";
  const scopeIdentity = providerConfigurationScopeIdentity(
    input.projectId,
    productMode,
  );
  const [diagnostics, setDiagnostics] = useState<ProviderDiagnostics | null>(
    null,
  );
  const [modelSettings, setModelSettings] =
    useState<ProviderModelSettingsSnapshot | null>(null);
  const [capabilities, setCapabilities] = useState<
    ProviderCapabilitySnapshot[]
  >([]);
  const [capabilitiesError, setCapabilitiesError] = useState<string | null>(
    null,
  );
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(
    null,
  );
  const [modelCatalogs, setModelCatalogs] = useState<
    ProviderModelCatalogGroup[]
  >([]);
  const [resolvedScopeIdentity, setResolvedScopeIdentity] = useState<
    string | null
  >(null);
  const requestGenerationRef = useRef(0);
  const onErrorRef = useRef(input.onError);
  const selectedProviderIdRef = useRef<string | null>(null);
  const draftProviderIdRef = useRef<string | null>(null);
  const draftProviderScopeRef = useRef<string | null>(null);
  const scopeResolved = resolvedScopeIdentity === scopeIdentity;
  const visibleDiagnostics = scopeResolved ? diagnostics : null;
  const visibleModelSettings = scopeResolved ? modelSettings : null;
  const visibleCapabilities = scopeResolved ? capabilities : [];
  const visibleCapabilitiesError = scopeResolved ? capabilitiesError : null;
  const visibleSelectedProviderId = scopeResolved ? selectedProviderId : null;
  const visibleModelCatalogs = scopeResolved ? modelCatalogs : [];
  selectedProviderIdRef.current = visibleSelectedProviderId;
  onErrorRef.current = input.onError;

  const providerPath = useCallback(
    (providerId: string, leaf: "diagnostics" | "models") =>
      input.projectId
        ? `/api/projects/${encodeURIComponent(input.projectId)}/providers/${encodeURIComponent(providerId)}/${leaf}`
        : `/api/providers/${encodeURIComponent(providerId)}/${leaf}`,
    [input.projectId],
  );

  const loadProviderDetails = useCallback(
    async (
      providerId: string,
      generation = requestGenerationRef.current,
    ): Promise<{
      diagnostics: ProviderDiagnostics | null;
      models: ProviderModelSettingsSnapshot | null;
    }> => {
      const [rawDiagnostics, rawModels] = await Promise.all([
        fetchJson<unknown>(providerPath(providerId, "diagnostics")),
        fetchJson<unknown>(providerPath(providerId, "models")),
      ]);
      const details = {
        diagnostics: isProviderDiagnostics(rawDiagnostics)
          ? rawDiagnostics
          : null,
        models:
          isProviderModelSettingsSnapshot(rawModels) &&
          rawModels.providerId === providerId
            ? rawModels
            : null,
      };
      if (generation === requestGenerationRef.current) {
        setDiagnostics(details.diagnostics);
        setModelSettings(details.models);
      }
      return details;
    },
    [providerPath],
  );

  const loadModelCatalogs = useCallback(
    async (
      providerCapabilities: ProviderCapabilitySnapshot[],
      generation: number,
    ): Promise<ProviderModelCatalogGroup[]> => {
      setModelCatalogs(
        providerCapabilities.map((provider) => ({
          providerId: provider.providerId,
          displayName: provider.displayName,
          status: "loading",
          snapshot: null,
        })),
      );
      const groups = await Promise.all(
        providerCapabilities.map(
          async (provider): Promise<ProviderModelCatalogGroup> => {
            try {
              const raw = await fetchJson<unknown>(
                providerPath(provider.providerId, "models"),
              );
              const snapshot =
                isProviderModelSettingsSnapshot(raw) &&
                raw.providerId === provider.providerId
                  ? raw
                  : null;
              if (!snapshot) throw new Error("模型目录格式无效。");
              return {
                providerId: provider.providerId,
                displayName: provider.displayName,
                status: "ready",
                snapshot,
              };
            } catch (cause) {
              return {
                providerId: provider.providerId,
                displayName: provider.displayName,
                status: "error",
                snapshot: null,
                message: userFacingErrorMessage(cause, "settings"),
              };
            }
          },
        ),
      );
      if (generation === requestGenerationRef.current) setModelCatalogs(groups);
      return groups;
    },
    [providerPath],
  );

  const reload = useCallback(async (): Promise<void> => {
    const generation = ++requestGenerationRef.current;
    setResolvedScopeIdentity(null);
    const path = providerCapabilitiesPath(input.projectId, productMode);
    const payload = await fetchJson<{ providers?: unknown[] }>(path);
    if (generation !== requestGenerationRef.current) return;
    const nextCapabilities = Array.isArray(payload.providers)
      ? payload.providers.filter((value): value is ProviderCapabilitySnapshot =>
          isProviderCapabilitySnapshot(value, productMode),
        )
      : [];
    setCapabilities(nextCapabilities);
    setCapabilitiesError(null);
    const restoredProviderId =
      !input.conversationProviderId &&
      draftProviderScopeRef.current === scopeIdentity
        ? draftProviderIdRef.current
        : null;
    const providerId =
      restoredProviderId ??
      selectEffectiveProviderId({
        conversationProviderId: input.conversationProviderId,
        projectDefaultProviderId: input.projectDefaultProviderId,
        selectedProviderId: selectedProviderIdRef.current,
        capabilities: nextCapabilities,
      });
    setSelectedProviderId(providerId);
    const catalogPromise = loadModelCatalogs(nextCapabilities, generation);
    if (!providerId) {
      setDiagnostics(null);
      setModelSettings(null);
      await catalogPromise;
      if (generation !== requestGenerationRef.current) return;
      setResolvedScopeIdentity(scopeIdentity);
      return;
    }
    if (
      !nextCapabilities.some((candidate) => candidate.providerId === providerId)
    ) {
      setDiagnostics(null);
      setModelSettings(null);
      await catalogPromise;
      if (generation !== requestGenerationRef.current) return;
      setResolvedScopeIdentity(scopeIdentity);
      return;
    }
    const diagnosticsPromise = fetchJson<unknown>(
      providerPath(providerId, "diagnostics"),
    ).catch(() => null);
    const [groups, rawDiagnostics] = await Promise.all([
      catalogPromise,
      diagnosticsPromise,
    ]);
    if (generation !== requestGenerationRef.current) return;
    setDiagnostics(
      isProviderDiagnostics(rawDiagnostics) ? rawDiagnostics : null,
    );
    setModelSettings(
      groups.find((group) => group.providerId === providerId)?.snapshot ?? null,
    );
    setResolvedScopeIdentity(scopeIdentity);
  }, [
    input.conversationProviderId,
    input.projectDefaultProviderId,
    input.projectId,
    loadModelCatalogs,
    productMode,
    providerPath,
    scopeIdentity,
  ]);

  useEffect(() => {
    let active = true;
    reload().catch((cause: unknown) => {
      if (active) {
        const message = userFacingErrorMessage(cause, "settings");
        setCapabilities([]);
        setCapabilitiesError(message);
        setResolvedScopeIdentity(scopeIdentity);
        onErrorRef.current(message);
      }
    });
    return () => {
      active = false;
      requestGenerationRef.current += 1;
    };
  }, [reload]);

  useEffect(() => {
    if (
      !input.conversationProviderId &&
      draftProviderScopeRef.current === scopeIdentity &&
      draftProviderIdRef.current
    )
      return;
    const providerId = selectEffectiveProviderId({
      conversationProviderId: input.conversationProviderId,
      projectDefaultProviderId: input.projectDefaultProviderId,
      selectedProviderId: visibleSelectedProviderId,
      capabilities: visibleCapabilities,
    });
    if (scopeResolved && providerId !== visibleSelectedProviderId)
      setSelectedProviderId(providerId);
  }, [
    input.conversationProviderId,
    input.projectDefaultProviderId,
    scopeIdentity,
    scopeResolved,
    visibleCapabilities,
    visibleSelectedProviderId,
  ]);

  const selectProvider = useCallback(
    async (providerId: string): Promise<void> => {
      if (providerId === visibleSelectedProviderId) return;
      const generation = ++requestGenerationRef.current;
      draftProviderIdRef.current = null;
      draftProviderScopeRef.current = null;
      setSelectedProviderId(providerId);
      setDiagnostics(null);
      setModelSettings(null);
      setResolvedScopeIdentity(null);
      try {
        const details = await loadProviderDetails(providerId, generation);
        if (generation === requestGenerationRef.current) {
          setModelCatalogs((current) =>
            current.map((group) =>
              group.providerId === providerId
                ? {
                    ...group,
                    status: details.models ? "ready" : "error",
                    snapshot: details.models,
                    message: details.models ? undefined : "模型目录格式无效。",
                  }
                : group,
            ),
          );
          setResolvedScopeIdentity(scopeIdentity);
        }
      } catch (cause) {
        if (generation === requestGenerationRef.current) {
          setCapabilitiesError(userFacingErrorMessage(cause, "settings"));
          setResolvedScopeIdentity(scopeIdentity);
        }
      }
    },
    [loadProviderDetails, scopeIdentity, visibleSelectedProviderId],
  );

  const restoreDraftProvider = useCallback(
    (providerId: string | null): void => {
      if (input.conversationProviderId) return;
      draftProviderIdRef.current = providerId;
      draftProviderScopeRef.current = scopeIdentity;
      // Draft restoration can race the initial capability request. Restart the
      // complete projection, so invalidating that request cannot strand an empty
      // catalog while only provider details are marked resolved.
      const pendingReload = reload();
      const generation = requestGenerationRef.current;
      void pendingReload.catch((cause: unknown) => {
        if (generation === requestGenerationRef.current) {
          setCapabilities([]);
          setCapabilitiesError(userFacingErrorMessage(cause, "settings"));
          setResolvedScopeIdentity(scopeIdentity);
        }
      });
    },
    [input.conversationProviderId, reload, scopeIdentity],
  );

  return {
    diagnostics: visibleDiagnostics,
    modelSettings: visibleModelSettings,
    capabilities: visibleCapabilities,
    capabilitiesLoading: !scopeResolved,
    capabilitiesError: visibleCapabilitiesError,
    selectedProviderId: visibleSelectedProviderId,
    modelCatalogs: visibleModelCatalogs,
    modelCatalogsBusy:
      !scopeResolved ||
      visibleModelCatalogs.some((group) => group.status === "loading"),
    selectProvider,
    restoreDraftProvider,
    reload,
  };
}

export function selectEffectiveProviderId(input: {
  conversationProviderId: string | null;
  projectDefaultProviderId: string | null;
  selectedProviderId: string | null;
  capabilities: ProviderCapabilitySnapshot[];
}): string | null {
  const available = new Set(
    input.capabilities.map((provider) => provider.providerId),
  );
  if (
    input.conversationProviderId &&
    available.has(input.conversationProviderId)
  )
    return input.conversationProviderId;
  if (input.selectedProviderId && available.has(input.selectedProviderId))
    return input.selectedProviderId;
  if (
    input.projectDefaultProviderId &&
    available.has(input.projectDefaultProviderId)
  )
    return input.projectDefaultProviderId;
  return input.capabilities.length === 1
    ? input.capabilities[0]!.providerId
    : null;
}

export function isProviderDiagnostics(
  value: unknown,
): value is ProviderDiagnostics {
  if (!value || typeof value !== "object") return false;
  const diagnostics = value as Partial<ProviderDiagnostics>;
  return (
    typeof diagnostics.providerId === "string" &&
    typeof diagnostics.displayName === "string" &&
    typeof diagnostics.installation === "object" &&
    diagnostics.installation !== null &&
    typeof diagnostics.models === "object" &&
    diagnostics.models !== null
  );
}

export function isProviderModelSettingsSnapshot(
  value: unknown,
): value is ProviderModelSettingsSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<ProviderModelSettingsSnapshot>;
  return (
    typeof snapshot.providerId === "string" &&
    (snapshot.effectiveModel === null ||
      typeof snapshot.effectiveModel === "object") &&
    (snapshot.effectiveModelSource === "selected" ||
      snapshot.effectiveModelSource === "config" ||
      snapshot.effectiveModelSource === "provider-default") &&
    Array.isArray(snapshot.candidates) &&
    snapshot.candidates.every(
      (candidate) =>
        Boolean(candidate) &&
        typeof candidate === "object" &&
        Array.isArray(
          (candidate as ProviderModelSettingsSnapshot["candidates"][number])
            .supportedReasoningEfforts,
        ) &&
        ((candidate as ProviderModelSettingsSnapshot["candidates"][number])
          .defaultReasoningEffort === null ||
          typeof (
            candidate as ProviderModelSettingsSnapshot["candidates"][number]
          ).defaultReasoningEffort === "string"),
    ) &&
    typeof snapshot.available === "boolean"
  );
}

export function isProviderCapabilitySnapshot(
  value: unknown,
  expectedProductMode: ProductMode = "harness",
): value is ProviderCapabilitySnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<ProviderCapabilitySnapshot>;
  return (
    typeof snapshot.providerId === "string" &&
    snapshot.productMode === expectedProductMode &&
    (snapshot.status === "ready" ||
      snapshot.status === "degraded" ||
      snapshot.status === "unavailable") &&
    typeof snapshot.runnable === "boolean" &&
    typeof snapshot.snapshotHash === "string" &&
    typeof snapshot.snapshotVersion === "number" &&
    Array.isArray(snapshot.capabilities)
  );
}

function providerConfigurationScopeIdentity(
  projectId: string | null,
  productMode: ProductMode,
): string {
  return `${projectId ?? ""}\0${productMode}`;
}

export function providerCapabilitiesPath(
  projectId: string | null,
  productMode: ProductMode,
): string {
  const query = `productMode=${encodeURIComponent(productMode)}`;
  return projectId
    ? `/api/projects/${encodeURIComponent(projectId)}/providers/capabilities?${query}`
    : `/api/providers/capabilities?${query}`;
}
