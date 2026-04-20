import { CodexExecutor } from "./codex.js";
import { DefaultExecutor } from "./default.js";

const executors = {
  codex: new CodexExecutor(),
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
export { CodexExecutor } from "./codex.js";
export { DefaultExecutor } from "./default.js";
