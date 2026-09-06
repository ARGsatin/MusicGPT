#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { tsImport } from "tsx/esm/api";
import { highRiskReleaseCases } from "../apps/server/evals/intelligence-trajectories.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultCachePath = path.resolve(scriptDir, "../apps/server/evals/high-risk-release-cache.json");
const args = parseArgs(process.argv.slice(2));

if (highRiskReleaseCases.length !== 25) {
  throw new Error(`Refusing to evaluate an invalid release set (${highRiskReleaseCases.length}/25)`);
}

const cachePath = path.resolve(args.cachePath ?? defaultCachePath);
if (!args.live && !args.cacheOnly) {
  const evaluatorPath = path.resolve(scriptDir, "../apps/server/evals/offline-intelligence-evaluator.ts");
  const offlineModule = await tsImport(pathToFileURL(evaluatorPath).href, { parentURL: import.meta.url });
  const offline = await offlineModule.runOfflineIntelligenceEvaluation({
    ...(args.simulateFailureCaseId ? { simulateFailureCaseId: args.simulateFailureCaseId } : {})
  });
  const summary = {
    mode: offline.mode,
    total: offline.total,
    executed: offline.executed,
    channelExecutions: offline.channelExecutions,
    fallbackPlannerChannelExecutions: offline.fallbackPlannerChannelExecutions,
    passed: offline.passed,
    failed: offline.failed,
    releaseReady: offline.releaseReady,
    failedCases: offline.results
      .filter((item) => item.status === "failed")
      .map((item) => ({
        caseId: item.caseId,
        channels: item.channels.filter((channel) => !channel.passed).map((channel) => ({
          channel: channel.channel,
          errorCodes: channel.errorCodes
        }))
      })),
    privacy: offline.privacy
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (summary.failed > 0 || summary.executed !== 150) process.exitCode = 1;
} else {
  const liveEvaluatorPath = path.resolve(scriptDir, "../apps/server/evals/live-intelligence-evaluator.ts");
  const liveEvaluator = await tsImport(pathToFileURL(liveEvaluatorPath).href, { parentURL: import.meta.url });
  const cacheBinding = {
    evaluatorVersion: liveEvaluator.LIVE_EVALUATOR_VERSION,
    corpusHash: liveEvaluator.hashLiveEvaluationCorpus(highRiskReleaseCases),
    channelSet: [...liveEvaluator.LIVE_CHANNEL_SET]
  };
  const cache = args.live
    ? await runConfiguredLiveEvaluation({
        evaluator: liveEvaluator,
        cases: highRiskReleaseCases,
        timeoutMs: args.timeoutMs
      })
    : readAndValidateCache(
        cachePath,
        highRiskReleaseCases.map((item) => item.id),
        cacheBinding
      );

  if (args.live && args.writeCache) writeSanitizedCache(cachePath, cache);
  const summary = summarize(cache, args.live ? "live:isolated-text+voice" : "cache");
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (args.requirePass && !summary.releaseReady) process.exitCode = 1;
}

function parseArgs(argv) {
  const parsed = {
    live: false,
    cacheOnly: false,
    writeCache: false,
    requirePass: false,
    timeoutMs: 15_000,
    cachePath: undefined,
    simulateFailureCaseId: undefined
  };

  for (const argument of argv) {
    if (argument === "--live") parsed.live = true;
    else if (argument === "--cache-only") parsed.cacheOnly = true;
    else if (argument === "--write-cache") parsed.writeCache = true;
    else if (argument === "--require-pass") parsed.requirePass = true;
    else if (argument.startsWith("--timeout-ms=")) parsed.timeoutMs = Number(argument.slice("--timeout-ms=".length));
    else if (argument.startsWith("--cache=")) parsed.cachePath = argument.slice("--cache=".length);
    else if (argument.startsWith("--simulate-failure=")) parsed.simulateFailureCaseId = argument.slice("--simulate-failure=".length);
    else if (argument === "--help") {
      process.stdout.write([
        "MusicGPT high-risk intelligence evaluator",
        "",
        "Default: execute all 150 fixed trajectories through the deterministic MusicCommand fixture. No network request is made.",
        "  node scripts/evaluate-intelligence.mjs",
        "",
        "Live (explicit, 25 model plans; each plan runs in isolated text and voice MusicCommand fixtures):",
        "  node scripts/evaluate-intelligence.mjs --live [--write-cache] [--require-pass]",
        "  [--timeout-ms=15000]",
        "",
        "Inspect a previously sanitized 25-case paid-run cache without network:",
        "  node scripts/evaluate-intelligence.mjs --cache-only [--cache=path]",
        "",
        "The cache stores case IDs and verdict booleans only; prompts, responses and credentials are never written.",
        ""
      ].join("\n"));
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }

  if (!parsed.live && parsed.writeCache) throw new Error("--write-cache requires --live");
  if (parsed.live && parsed.cacheOnly) throw new Error("--live and --cache-only are mutually exclusive");
  if ((parsed.live || parsed.cacheOnly) && parsed.simulateFailureCaseId) {
    throw new Error("--simulate-failure is available only for the offline evaluator self-test");
  }
  if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs < 1_000 || parsed.timeoutMs > 120_000) {
    throw new Error("--timeout-ms must be between 1000 and 120000");
  }
  return parsed;
}

function readAndValidateCache(cacheFile, releaseIds, expectedBinding) {
  const parsed = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  if (parsed?.schemaVersion !== 2 || !Array.isArray(parsed.results)) {
    throw new Error("Invalid intelligence evaluation cache schema");
  }
  if (containsForbiddenRawField(parsed)) {
    throw new Error("Intelligence evaluation cache contains a forbidden raw field");
  }
  if (
    parsed.evaluatorVersion !== expectedBinding.evaluatorVersion ||
    parsed.corpusHash !== expectedBinding.corpusHash ||
    JSON.stringify(parsed.channelSet) !== JSON.stringify(expectedBinding.channelSet)
  ) {
    throw new Error("Intelligence evaluation cache binding does not match this evaluator and corpus");
  }
  if (
    !/^[a-f0-9]{64}$/u.test(parsed.corpusHash) ||
    !(parsed.provider === null || typeof parsed.provider === "string") ||
    !(parsed.model === null || typeof parsed.model === "string") ||
    typeof parsed.source !== "string"
  ) {
    throw new Error("Intelligence evaluation cache has invalid provider/model metadata");
  }
  const actualIds = parsed.results.map((item) => item?.caseId);
  if (actualIds.length !== 25 || new Set(actualIds).size !== 25 || actualIds.some((id, index) => id !== releaseIds[index])) {
    throw new Error("Intelligence evaluation cache does not match the fixed 25-case release set");
  }
  const allowedStatuses = new Set(["pending", "passed", "failed"]);
  for (const result of parsed.results) {
    if (!allowedStatuses.has(result.status)) throw new Error(`Invalid cached status for ${result.caseId}`);
  }
  return parsed;
}

async function runConfiguredLiveEvaluation({ evaluator, cases, timeoutMs }) {
  const configPath = path.resolve(scriptDir, "../apps/server/src/config.ts");
  const assistantPath = path.resolve(scriptDir, "../apps/server/src/aiDjAssistant.ts");
  const [configModule, assistantModule] = await Promise.all([
    tsImport(pathToFileURL(configPath).href, { parentURL: import.meta.url }),
    tsImport(pathToFileURL(assistantPath).href, { parentURL: import.meta.url })
  ]);
  const liveConfig = configModule.config;
  if (!liveConfig.openAiApiKey || liveConfig.aiProvider === "local") {
    throw new Error("A configured OpenAI-compatible provider is required for --live");
  }
  const assistant = new assistantModule.OpenAiDjAssistant({
    apiKey: liveConfig.openAiApiKey,
    baseUrl: liveConfig.openAiBaseUrl,
    model: liveConfig.openAiModel,
    provider: liveConfig.aiProvider,
    chatMaxTokens: liveConfig.aiDjChatMaxTokens
  });
  return evaluator.runLiveIntelligenceEvaluation({ assistant, cases, timeoutMs });
}

function containsForbiddenRawField(value) {
  if (!value || typeof value !== "object") return false;
  const forbiddenKeys = new Set([
    "utterance", "input", "prompt", "response", "request", "apikey", "authorization",
    "cookie", "rawoutput", "modeloutput", "error", "errormessage"
  ]);
  for (const [key, nested] of Object.entries(value)) {
    if (forbiddenKeys.has(key.toLowerCase())) return true;
    if (containsForbiddenRawField(nested)) return true;
  }
  return false;
}

function writeSanitizedCache(cacheFile, cacheValue) {
  const sanitized = {
    schemaVersion: 2,
    evaluatorVersion: cacheValue.evaluatorVersion,
    corpusHash: cacheValue.corpusHash,
    channelSet: cacheValue.channelSet,
    policyVersion: cacheValue.policyVersion ?? "listening-policy-v1",
    provider: typeof cacheValue.provider === "string" ? cacheValue.provider.slice(0, 40) : null,
    model: typeof cacheValue.model === "string" ? cacheValue.model.slice(0, 80) : null,
    generatedAt: cacheValue.generatedAt,
    source: cacheValue.source,
    modelPlanExecutions: Number(cacheValue.modelPlanExecutions) || 0,
    commandChannelExecutions: Number(cacheValue.commandChannelExecutions) || 0,
    results: cacheValue.results.map((item) => ({
      caseId: item.caseId,
      status: item.status,
      actionMatches: Boolean(item.actionMatches),
      seamMatches: Boolean(item.seamMatches),
      unsafeAction: Boolean(item.unsafeAction),
      textPassed: Boolean(item.textPassed),
      voicePassed: Boolean(item.voicePassed),
      channelConsistent: Boolean(item.channelConsistent),
      ...(item.errorCode ? { errorCode: item.errorCode } : {}),
      ...(Array.isArray(item.errorCodes) ? { errorCodes: item.errorCodes.filter((code) => typeof code === "string" && /^[a-z_.:]+$/u.test(code)) } : {})
    }))
  };
  const temporaryPath = `${cacheFile}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(sanitized, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, cacheFile);
}

function summarize(cacheValue, mode) {
  const passed = cacheValue.results.filter((item) => item.status === "passed").length;
  const failedCount = cacheValue.results.filter((item) => item.status === "failed").length;
  const pending = cacheValue.results.filter((item) => item.status === "pending").length;
  const completed = passed + failedCount;
  const unsafeActions = cacheValue.results.filter((item) => item.unsafeAction === true).length;
  const channelMismatches = cacheValue.results.filter((item) => item.channelConsistent === false).length;
  const successRate = completed === 0 ? null : passed / completed;
  const errorActionRate = completed === 0 ? null : unsafeActions / completed;
  return {
    mode,
    evaluatorVersion: cacheValue.evaluatorVersion,
    corpusHash: cacheValue.corpusHash,
    channelSet: cacheValue.channelSet,
    provider: cacheValue.provider ?? null,
    model: cacheValue.model ?? null,
    total: cacheValue.results.length,
    modelPlanExecutions: Number(cacheValue.modelPlanExecutions) || 0,
    commandChannelExecutions: Number(cacheValue.commandChannelExecutions) || 0,
    passed,
    failed: failedCount,
    pending,
    successRate,
    errorActionRate,
    channelMismatches,
    releaseReady: completed === 25 && successRate >= 0.92 && errorActionRate === 0 && channelMismatches === 0,
    cacheWritten: Boolean(args.live && args.writeCache),
    privacy: "case_ids_and_verdicts_only"
  };
}
