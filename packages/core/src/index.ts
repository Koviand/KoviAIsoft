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
  isAutoPcProfile,
  suggestHardwareLoadProfile,
} from "./models/hardwareProfile.js";
export type { HardwareLoadSuggestion } from "./models/hardwareProfile.js";
export * from "./tools/sandbox.js";
export {
  adaptCommandForWindows,
  isBlankCwd,
  isShellFileWriteAttempt,
  resolveTerminalCwd,
  runTerminal,
} from "./tools/terminal.js";
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
