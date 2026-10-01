import { readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import process from "node:process";

const root = resolve(process.cwd());
const webRoot = resolve(root, "src/web/src");
const sourceRoot = resolve(root, "src");
const webFiles = await collectSourceFiles(webRoot);
const sourceFiles = await collectSourceFiles(sourceRoot);
const violations = [];

const timelineProtocolOwners = new Set([
  "src/web/src/canonicalTimelineController.ts",
  "src/web/src/canonicalTimelineStore.ts",
  "src/web/src/workbenchProjectionStream.ts",
  "src/web/src/types.ts",
]);
const projectionStreamOwner = "src/web/src/workbenchProjectionStream.ts";
const workspaceResourceOwner = "src/web/src/controllers/useWorkspaceResourceController.ts";
const appShellOwner = "src/web/src/App.tsx";
const officeSourceAdapterOwner = "src/web/src/office/agentSurfaceOfficeSourceAdapter.ts";
const officeActivityCompilerOwner = "src/web/src/office/officeActivityCompiler.ts";
const officeVisualContractOwner = "src/web/src/office/officeVisualContract.ts";
const officeVisualCommandOwners = new Set([
  officeActivityCompilerOwner,
  officeVisualContractOwner,
  "src/web/src/office/OfficeParticipantRenderer.ts",
  "src/web/src/office/PixiOfficeRenderer.tsx",
]);
const appForbiddenDomainAccess = [
  "consumeWorkbenchLiveStream",
  "postJson",
  "/workbench/topics/live",
  "/messages/live",
  "/workbench/projections/agent-graph/",
  "/workspace-resources/resolve",
  "/providers/capabilities",
  "/providers/",
  "/skills",
  "/attachments",
];
const retiredSymbols = [
  "conversationTranscripts",
  "parentAgentTranscript",
  "messageCellIdsRef",
  "messagePlacementRef",
  "liveTranscript",
  "/workbench/projections/transcript/",
  "buildParentAgentTranscript",
  "buildAgentScopedTranscriptCells",
  "pageParentAgentTranscript",
  "appendConversationThreadEntry",
  "TopicThreadLogPage",
  "readConversationThreadPage",
  "encodeTopicThreadCursor",
  "decodeTopicThreadCursor",
  "listMessagesBeforePosition",
  "sendTopicMessageReplay",
  "/messages/stream",
  "inferStoredAgentSurfaceId",
  "child.canonicalId ??",
  "AgentOfficeProjection",
  "AgentOfficeSeat",
  "useAgentOfficeController",
  "/workbench/projections/agent-office/",
  "/agents/terminate",
  "terminateExactChildAgent",
  "pendingAgentTerminations",
  "terminateSelectedAgent",
  'event: "topic.message"',
  'event: "assistant.message"',
  "officeRuntimeCalibration.generated",
  "OFFICE_SCENE_CALIBRATION",
  "/__aho/agent-office-calibration",
  "calibrationAdjustment",
  "calibrationOffset",
  "HarnessOfficeAdapter",
  "harnessOfficeAdapter",
  "mapHarnessState",
  "staticStandby",
  "standbyScreenProfile",
  "OfficeAmbientActivityId",
  "OfficeAmbientPreference",
  "ambientPreferences",
  "mobilityActive",
  "visit-coffee",
  "use-treadmill",
  "use-toilet",
  "play-game-1",
  "play-game-2",
];

for (const file of webFiles) {
  const relativePath = normalizePath(relative(root, file));
  const content = await readFile(file, "utf8");
  if (["src/web/src/controllers/useDecisionInspectorController.ts", "src/web/src/controllers/useConversationActionController.ts"].includes(relativePath)
    && /from\s+["'][^"']*(?:panels\/|shell\/|App\.)/.test(content)) {
    violations.push(`${relativePath}: decision/action owners consume pure contracts and ports, not UI components`);
  }
  if (relativePath === "src/web/src/controllers/useDecisionInspectorController.ts"
    && /from\s+["'][^"']*(?:\/api\.|provider-runtime|persistence|application-history)/.test(content)) {
    violations.push(`${relativePath}: confirmation presentation delegates execution and navigation to owner ports`);
  }
  if (relativePath === "src/web/src/panels/workbench/DecisionPanels.tsx"
    && /from\s+["'][^"']*(?:controllers\/|\/api\.|provider-runtime|persistence)/.test(content)) {
    violations.push(`${relativePath}: confirmation view consumes its pure contract only`);
  }
  if (relativePath !== "src/web/src/controllers/application-history-adapter.ts"
    && /\bhistory\.(?:pushState|replaceState)\s*\(/.test(content)) {
    violations.push(`${relativePath}: application History writes belong to application-history-adapter`);
  }
  if (/^src\/web\/src\/(?:controllers\/application-|controllers\/useApplicationNavigationController)/.test(relativePath)
    && /from\s+["'][^"']*(?:shell\/|panels\/|canonicalTimeline)/.test(content)) {
    violations.push(`${relativePath}: navigation consumes owner ports and contracts, not presentation or timeline owners`);
  }
  if (relativePath === "src/web/src/controllers/useSkillsSettingsController.ts"
    && /from\s+["'][^"']*application-(?:history|navigation)/.test(content)) {
    violations.push(`${relativePath}: skills management must not depend on navigation`);
  }
  if (!timelineProtocolOwners.has(relativePath) && content.includes("timeline.patch")) {
    violations.push(`${relativePath}: Timeline SSE interpretation belongs to canonicalTimelineController`);
  }
  if (relativePath !== "src/web/src/canonicalTimelineController.ts"
    && /workbench\/conversations\/[^\s"'`]+\/timeline/.test(content)) {
    violations.push(`${relativePath}: Timeline HTTP requests belong to canonicalTimelineController`);
  }
  if (relativePath !== projectionStreamOwner && content.includes("/workbench/events/live")) {
    violations.push(`${relativePath}: project EventSource belongs to workbenchProjectionStream`);
  }
  if (relativePath !== workspaceResourceOwner && content.includes("/workspace-resources/resolve")) {
    violations.push(`${relativePath}: resource resolution belongs to useWorkspaceResourceController`);
  }
  if (relativePath === appShellOwner) {
    for (const symbol of appForbiddenDomainAccess) {
      if (content.includes(symbol)) violations.push(`${relativePath}: migrated domain access ${symbol} does not belong in the App shell`);
    }
  }
  if (content.includes("texture.trim")) {
    violations.push(`${relativePath}: Office/product coordinates must not compensate Pixi atlas trim`);
  }
  if (content.includes("new OfficeCalibrationResolver(")
    && relativePath !== "src/web/src/office/agentOfficeRuntimeComposition.ts") {
    violations.push(`${relativePath}: OfficeCalibrationResolver construction belongs to Agent Office runtime composition`);
  }
  if (relativePath.startsWith("src/web/src/office/")
    && relativePath !== officeSourceAdapterOwner
    && /\b(?:AgentSurfaceProjection|AgentSurfaceStatus)\b/.test(content)) {
    violations.push(`${relativePath}: Agent Surface contracts belong behind AgentSurfaceOfficeSourceAdapter`);
  }
  if (relativePath.startsWith("src/web/src/office/")
    && !officeVisualCommandOwners.has(relativePath)
    && /kind:\s*["'](?:playAction|playRouteStage|followRoute|setScreen|setEffect|showParticipant|hideParticipant)["']/.test(content)) {
    violations.push(`${relativePath}: low-level Office visual commands must be constructed by OfficeActivityCompiler`);
  }
  if (/actionId:\s*["']standby["'][\s\S]{0,160}?loop:\s*true/.test(content)
    || /loop:\s*true[\s\S]{0,160}?actionId:\s*["']standby["']/.test(content)) {
    violations.push(`${relativePath}: standby is only the one-shot look-around material and must never loop`);
  }
  if (relativePath === "src/web/src/office/officePresentationRegistry.ts"
    && /\b(?:OfficeActionId|actionId|officeVisualContract)\b/.test(content)) {
    violations.push(`${relativePath}: role presentation may contain semantic activities, not material action ids`);
  }
  if (["src/web/src/office/OfficeParticipantRenderer.ts", "src/web/src/office/PixiOfficeRenderer.tsx"].includes(relativePath)
    && /\b(?:OfficePresentationPreferences|presentationPreferences)\b/.test(content)) {
    violations.push(`${relativePath}: renderers must not receive role scheduling preferences`);
  }
  if ([
    "src/web/src/office/ambientScheduler.ts",
    "src/web/src/office/officeActivityCompiler.ts",
    "src/web/src/office/officeBehaviorPolicy.ts",
    "src/web/src/office/officeDirector.ts",
    "src/web/src/office/officeOccupancyPolicy.ts",
    "src/web/src/office/officePresentationRegistry.ts",
  ].includes(relativePath) && /\b(?:Codex|Claude)\b/i.test(content)) {
    violations.push(`${relativePath}: Office behavior and occupancy must treat actor ids as provider-opaque`);
  }
}

try {
  await readFile(resolve(root, "tests/unit/web-app.test.tsx"), "utf8");
  violations.push("tests/unit/web-app.test.tsx: retired giant App test must not return");
} catch (cause) {
  if (cause?.code !== "ENOENT") throw cause;
}

for (const file of sourceFiles) {
  const relativePath = normalizePath(relative(root, file));
  const content = await readFile(file, "utf8");
  for (const symbol of retiredSymbols) {
    if (content.includes(symbol)) violations.push(`${relativePath}: retired Timeline symbol ${symbol}`);
  }
}

// Composer controllers consume shared input parsing and pure DTOs, never UI owners.
for (const file of webFiles) {
  const path = normalizePath(relative(root, file));
  const content = await readFile(file, "utf8");
  if (path.startsWith("src/web/src/controllers/") && /from\s+["'][^"']*shell\/(?:file-mentions|skill-mentions|composer|ComposerExecutionControls)/.test(content)) violations.push(`${path}: Composer controllers must depend on shared parsing and contracts`);
}
const deliverySource = await readFile(resolve(root, "src/workbench/conversation-input-delivery.ts"), "utf8");
if (/from\s+["'][^"']*conversation-turn-queue\.js/.test(deliverySource)) violations.push("Input delivery must not import the queue Owner");
const captureSource = await readFile(resolve(root, "src/workbench/live-transcript.ts"), "utf8");
if (/from\s+["'][^"']*conversation-(?:turn-queue|input-delivery)/.test(captureSource)) violations.push("Transcript capture must not import queue or input delivery");
for (const path of ["src/workbench/conversation-turn-queue-contract.ts", "src/types/skill-catalog.ts"]) {
  const content = await readFile(resolve(root, path), "utf8");
  if (/^import(?!\s+type\b)|^export\s+(?:function|class|const)\b/m.test(content)) violations.push(`${path}: contracts must contain only types`);
}

const calibrationContract = await readFile(resolve(root, "scripts/office-calibration-v3.ts"), "utf8");
for (const retiredStage of ["standby-start", "standby-end"]) {
  if (calibrationContract.includes(retiredStage)) {
    violations.push(`scripts/office-calibration-v3.ts: retired Office route stage ${retiredStage}`);
  }
}

if (violations.length > 0) {
  process.stderr.write(`Frontend boundary lint failed:\n${violations.map((item) => `- ${item}`).join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(`Frontend boundary lint passed (${webFiles.length} web files, ${sourceFiles.length} source files).\n`);

async function collectSourceFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...await collectSourceFiles(path));
    else if (entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name)) result.push(path);
  }
  return result;
}

function normalizePath(value) {
  return value.split(sep).join("/");
}
