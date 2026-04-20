import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");

function resolveAlias(specifier) {
  if (specifier === "open-sse") {
    return pathToFileURL(path.join(repoRoot, "open-sse", "index.js")).href;
  }
  if (specifier.startsWith("open-sse/")) {
    return pathToFileURL(
      path.join(repoRoot, "open-sse", specifier.slice("open-sse/".length)),
    ).href;
  }
  if (specifier.startsWith("@/")) {
    return pathToFileURL(path.join(repoRoot, "src", specifier.slice(2))).href;
  }
  return null;
}

export async function resolve(specifier, context, defaultResolve) {
  const resolved = resolveAlias(specifier);
  if (resolved) {
    return {
      shortCircuit: true,
      url: resolved,
    };
  }
  return defaultResolve(specifier, context, defaultResolve);
}
