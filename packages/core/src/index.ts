export * from "./appService.js";
export {
  setAppDataDir,
  getAppDataDir,
  ensureDir,
  getRuntimesDir,
  getModelsDir,
  getDbPath,
  getSettingsPath,
  getAttachmentsDir,
} from "./paths.js";
export * from "./system/detect.js";
export {
  configureRuntimeAssetFetcher,
  fetchLatestRuntimeAsset,
  isNewerRuntime,
  parseBuildNumber,
  selectAssetFromRelease,
} from "./runtime/assets.js";
export * from "./runtime/manager.js";
export * from "./models/scanner.js";
export * from "./models/huggingface.js";
export {
  getHfCliStatus,
  resolveHfCli,
  downloadViaHfCli,
  ensureHfCli,
} from "./models/hfCli.js";
export {
  ensureBundledHfCli,
  isBundledHfCliReady,
  resolveBundledHfCli,
} from "./models/hfBundle.js";
export { getHfToolsDir, getPortableRoot } from "./paths.js";
export {
  MODEL_CATALOG,
  buildModelRecommendations,
} from "./models/recommend.js";
export {
  AUTO_PC_PROFILE_ID,
  buildHardwareTierProfiles,
  isAutoPcProfile,
  mergeProfileIntoDefaultParams,
  suggestHardwareLoadProfile,
} from "./models/hardwareProfile.js";
export type { HardwareLoadSuggestion, LoadTier } from "./models/hardwareProfile.js";
export * from "./tools/sandbox.js";
export {
  adaptCommandForWindows,
  cancelActiveTerminals,
  isBlankCwd,
  isShellFileWriteAttempt,
  resolveTerminalCwd,
  runTerminal,
  splitShellChain,
} from "./tools/terminal.js";
export {
  detectAgentTask,
  detectCodingTask,
  detectToolAction,
} from "./agent/intent.js";
export {
  currentPlanStep,
  defaultCodingPlan,
  defaultGenericPlan,
  defaultPlanForTask,
  markCurrentPlanDone,
  normalizePlanDraft,
  PLAN_MAX_STEPS,
  PLAN_MIN_STEPS,
  skipRemainingPlan,
} from "./agent/planner.js";
export {
  buildAgentActionGbnf,
  buildAgentActionJsonSchema,
  nextConstraintModeAfterFailure,
  pickConstraintMode,
} from "./agent/actionSchema.js";
export {
  parseAgentAction,
  sanitizeJsonCandidate,
  validateToolArgs,
} from "./agent/parseAction.js";
export { applyTextReplace } from "./tools/textReplace.js";
export { writeFileAtomic, writeFileAtomicSync } from "./fsAtomic.js";
// resolveAgentPath exported via sandbox *
export * from "./agent/toolsCatalog.js";
export * from "./context/index.js";
export {
  estimateTokens,
  estimateMessagesTokens,
  fitMessagesToContext,
  truncateToTokens,
  isContextOverflowError,
} from "./chat/contextBudget.js";
