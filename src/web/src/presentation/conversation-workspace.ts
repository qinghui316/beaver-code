export interface ConversationWorkspaceChromeInput {
  readonly governanceVisible: boolean;
  readonly primaryConfirmationPresent: boolean;
  readonly otherConfirmationCount: number;
  readonly maintenanceConfirmationCount: number;
  readonly providerDiagnosticName?: string | null;
  readonly selectedProviderId: string | null;
  readonly providerOptions: readonly { readonly id: string; readonly label: string }[];
}

export interface ConversationWorkspaceChromeViewModel {
  readonly pendingConfirmationCount: number;
  readonly providerDisplayName: string;
}

export function projectConversationWorkspaceChrome(
  input: ConversationWorkspaceChromeInput,
): ConversationWorkspaceChromeViewModel {
  const pendingConfirmationCount = input.governanceVisible
    ? (input.primaryConfirmationPresent ? 1 : 0)
      + input.otherConfirmationCount
      + input.maintenanceConfirmationCount
    : 0;
  const providerDisplayName = input.providerDiagnosticName?.trim()
    || input.providerOptions.find((provider) => provider.id === input.selectedProviderId)?.label
    || (input.providerOptions.length === 1 ? input.providerOptions[0]!.label : "正在加载");
  return { pendingConfirmationCount, providerDisplayName };
}
