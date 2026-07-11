import { AntigravityExecutor } from "./antigravity.js";
import { CodexExecutor } from "./codex.js";
import { DefaultExecutor } from "./default.js";
import { GrokCliExecutor } from "./grok-cli.js";

const grokCli = new GrokCliExecutor();

const executors = {
  codex: new CodexExecutor(),
  antigravity: new AntigravityExecutor(),
  "grok-cli": grokCli,
  gcli: grokCli,
  gb: grokCli,
};

const defaultCache = new Map();

export function getExecutor(provider) {
  if (executors[provider]) return executors[provider];
  if (!defaultCache.has(provider))
    defaultCache.set(provider, new DefaultExecutor(provider));
  return defaultCache.get(provider);
}

export function hasSpecializedExecutor(provider) {
  return !!executors[provider];
}

export { BaseExecutor } from "./base.js";
export { AntigravityExecutor } from "./antigravity.js";
export { CodexExecutor } from "./codex.js";
export { DefaultExecutor } from "./default.js";
export { GrokCliExecutor } from "./grok-cli.js";
