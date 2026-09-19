import type { AgentAccessControlProps } from "../shell/AgentAccessControl.js";
import { useState, type ReactElement } from "react";
import { ArrowUp, Bot, RefreshCw } from "lucide-react";
import { ConversationComposerSurface } from "../shell/composer.js";
import { productModeExperience } from "../presentation/core-workbench-experience.js";
import type { ProjectReadinessComposerFeatureSurface } from "../presentation/conversation-workspace.js";
import { WorkspacePicker } from "./WorkspacePicker.js";
import { parseReviewCommand } from "../reviewCommand.js";
import type {
  AgentTurnMode,
  ProductMode,
  ProjectGitReviewOptions,
  ProviderModelCatalogGroup,
  ProviderReviewTarget,
  ProjectStatus,
  SkillListItem,
  TopicAttachment,
  TopicFileReference,
} from "../types.js";

export function ProjectHomeView({
  projects,
  onOpenProject,
  onRefresh,
}: {
  projects: ProjectStatus[];
  onOpenProject: (projectId: string) => Promise<void>;
  onRefresh: () => Promise<void>;
}): ReactElement {
  return (
    <section className="home-chat-surface" aria-label="项目首页">
      <div className="home-chat-center">
        <div className="home-chat-mark" aria-label="Agent">
          <Bot size={50} />
        </div>
        <h1>创造任何东西</h1>
        <WorkspacePicker
          projects={projects}
          selectedProjectId={null}
          onOpenProject={onOpenProject}
          onRefresh={onRefresh}
        />
      </div>
    </section>
  );
}
export function ProjectReadinessHomeFeature({
  surface,
}: {
  surface: ProjectReadinessComposerFeatureSurface;
}): ReactElement {
  return <ProjectReadinessHome {...surface.view} {...surface.actions} />;
}

export function ProjectReadinessHome({
  project,
  providerDisplayName,
  modelLabel,
  projects,
  selectedProjectId,
  onCreateDemand,
  draft,
  onDraftChange,
  draftFileRefs,
  onDraftFileRefsChange,
  draftAttachments,
  onAttachFiles,
  onRemoveAttachment,
  skills,
  activeSkillIds,
  onToggleSkill,
  onOpenProject,
  onRefresh,
  resetToken,
  selectedProviderId,
  productMode,
  agentTurnMode,
  accessView,
  onSelectAccess,
  onRefreshAccess,
  onSelectAgentTurnMode,
  agentTurnModeDisabledReason,
  planModeDisabledReason,
  agentModelId,
  agentReasoningEffort,
  providerModelCatalogs,
  providerModelCatalogsBusy,
  onRefreshProviderModels,
  onSelectAgentProviderModel,
  onSelectAgentReasoningEffort,
  reviewOpen,
  reviewOptions,
  reviewLoading,
  reviewSubmitting,
  onOpenReview,
  onCloseReview,
  onStartReview,
  onStartReviewCommand,
  onReviewCommandError,
}: {
  project: ProjectStatus;
  providerDisplayName?: string;
  modelLabel: string;
  projects: ProjectStatus[];
  selectedProjectId: string | null;
  onCreateDemand: (
    body: string,
    fileRefs?: TopicFileReference[],
    attachmentIds?: string[],
    attachmentFiles?: File[],
  ) => Promise<void>;
  draft: string;
  onDraftChange: (value: string) => void;
  draftFileRefs: TopicFileReference[];
  onDraftFileRefsChange: (refs: TopicFileReference[]) => void;
  draftAttachments: TopicAttachment[];
  onAttachFiles: (files: File[]) => Promise<TopicAttachment[]>;
  onRemoveAttachment: (attachmentId: string) => Promise<void>;
  enabledSkillCount?: number;
  skills?: SkillListItem[];
  activeSkillIds?: string[];
  onToggleSkill?: (skillId: string) => void | Promise<void>;
  onOpenProject: (projectId: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  resetToken?: number;
  selectedProviderId?: string;
  productMode: ProductMode;
  agentTurnMode: AgentTurnMode;
  accessView?: AgentAccessControlProps["accessView"];
  onSelectAccess?: AgentAccessControlProps["onSelectAccess"];
  onRefreshAccess?: AgentAccessControlProps["onRefreshAccess"];
  onSelectAgentTurnMode: (mode: AgentTurnMode) => void | Promise<void>;
  agentTurnModeDisabledReason?: string | null;
  planModeDisabledReason?: string | null;
  agentModelId: string | null;
  agentReasoningEffort: string | null;
  providerModelCatalogs?: ProviderModelCatalogGroup[];
  providerModelCatalogsBusy?: boolean;
  onRefreshProviderModels?: () => void | Promise<void>;
  onSelectAgentProviderModel: (
    providerId: string,
    modelId: string | null,
  ) => void | Promise<void>;
  onSelectAgentReasoningEffort: (effort: string | null) => void | Promise<void>;
  reviewOpen?: boolean;
  reviewOptions?: ProjectGitReviewOptions | null;
  reviewLoading?: boolean;
  reviewSubmitting?: boolean;
  onOpenReview?: (capturedCommand?: string) => void | Promise<void>;
  onCloseReview?: () => void;
  onStartReview?: (target: ProviderReviewTarget) => void | Promise<void>;
  onStartReviewCommand?: (
    target: ProviderReviewTarget,
    capturedCommand: string,
  ) => void | Promise<void>;
  onReviewCommandError?: (message: string) => void;
}): ReactElement {
  const [submitting, setSubmitting] = useState(false);
  const canStartDemand = project.pathExists;
  const canAttach = canStartDemand;
  const modeExperience = productModeExperience(productMode);

  async function submitDemand(): Promise<void> {
    if (productMode === "agent") {
      const command = parseReviewCommand(draft);
      if (command.kind === "open-selector") {
        await onOpenReview?.(draft);
        return;
      }
      if (command.kind === "target") {
        await onStartReviewCommand?.(command.target, draft);
        return;
      }
      if (command.kind === "invalid") {
        onReviewCommandError?.(command.message);
        return;
      }
    }
    const body = draft.trim();
    if ((!body && draftAttachments.length === 0) || !canStartDemand) return;
    setSubmitting(true);
    try {
      await onCreateDemand(
        body,
        draftFileRefs,
        draftAttachments.map((attachment) => attachment.id),
      );
    } catch {
      // The App shell owns the user-facing error message; keep the draft intact.
    } finally {
      setSubmitting(false);
    }
  }

  async function attachFiles(files: File[]): Promise<void> {
    if (!canAttach || files.length === 0) return;
    await onAttachFiles(files);
  }

  return (
    <section className="home-chat-surface" aria-label="项目对话首页">
      <div className="home-chat-center">
        <div
          className="home-chat-mark"
          aria-label={productMode === "agent" ? "Agent" : "AHO"}
        >
          <Bot size={50} />
        </div>
        <h1>{modeExperience.title}</h1>
        <WorkspacePicker
          projects={projects}
          selectedProjectId={selectedProjectId}
          onOpenProject={onOpenProject}
          onRefresh={onRefresh}
        />

        <ConversationComposerSurface
          ariaLabel="新建需求对话"
          inputAriaLabel="新建需求输入框"
          className="home-demand-composer"
          value={draft}
          onChange={onDraftChange}
          disabledReason={
            !canStartDemand
              ? "项目目录不可用"
              : submitting
                ? "正在创建会话"
                : undefined
          }
          placeholder="描述你的需求"
          projectId={project.project?.id ?? null}
          skills={skills}
          activeSkillIds={activeSkillIds}
          selectedFileRefs={draftFileRefs}
          attachments={draftAttachments}
          onAttachFiles={attachFiles}
          onRemoveAttachment={onRemoveAttachment}
          onToggleSkill={onToggleSkill}
          onSelectedFileRefsChange={onDraftFileRefsChange}
          productMode={productMode}
          accessView={accessView}
          onSelectAccess={onSelectAccess}
          onRefreshAccess={onRefreshAccess}
          agentTurnMode={agentTurnMode}
          onSelectAgentTurnMode={onSelectAgentTurnMode}
          planModeDisabledReason={planModeDisabledReason}
          agentTurnModeDisabledReason={agentTurnModeDisabledReason}
          providerDisplayName={providerDisplayName}
          modelLabel={modelLabel}
          selectedProviderId={selectedProviderId}
          agentModelId={agentModelId}
          agentReasoningEffort={agentReasoningEffort}
          providerModelCatalogs={providerModelCatalogs}
          providerModelCatalogsBusy={providerModelCatalogsBusy}
          onRefreshProviderModels={onRefreshProviderModels}
          onSelectAgentProviderModel={onSelectAgentProviderModel}
          onSelectAgentReasoningEffort={onSelectAgentReasoningEffort}
          reviewOpen={reviewOpen}
          reviewOptions={reviewOptions}
          reviewLoading={reviewLoading}
          reviewSubmitting={reviewSubmitting}
          onOpenReview={onOpenReview}
          onCloseReview={onCloseReview}
          onStartReview={onStartReview}
          onSubmit={submitDemand}
          focusToken={resetToken}
          trailingControls={
            <button
            className="composer-send"
            type="button"
              disabled={
                !canStartDemand ||
                submitting ||
                Boolean(agentTurnModeDisabledReason) ||
                (!draft.trim() && draftAttachments.length === 0)
              }
            onClick={() => void submitDemand()}
            title={agentTurnModeDisabledReason ?? "创建需求对话"}
            aria-label="创建需求对话"
          >
              {submitting ? (
                <RefreshCw size={16} className="spin" />
              ) : (
                <ArrowUp size={17} />
              )}
            </button>
          }
        />
      </div>
    </section>
  );
}
