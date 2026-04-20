import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");

function resolveExistingPath(candidatePath) {
  if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) {
    return candidatePath;
  }

  const withJsExtension = `${candidatePath}.js`;
  if (fs.existsSync(withJsExtension) && fs.statSync(withJsExtension).isFile()) {
    return withJsExtension;
  }

  const indexJsPath = path.join(candidatePath, "index.js");
  if (fs.existsSync(indexJsPath) && fs.statSync(indexJsPath).isFile()) {
    return indexJsPath;
  }

  return null;
}

function resolveAlias(specifier) {
  if (specifier === "open-sse") {
    return pathToFileURL(path.join(repoRoot, "open-sse", "index.js")).href;
  }
  if (specifier.startsWith("open-sse/")) {
    const resolvedPath = resolveExistingPath(
      path.join(repoRoot, "open-sse", specifier.slice("open-sse/".length)),
    );
    return resolvedPath ? pathToFileURL(resolvedPath).href : null;
  }
  if (specifier.startsWith("@/")) {
    const resolvedPath = resolveExistingPath(
      path.join(repoRoot, "src", specifier.slice(2)),
    );
    return resolvedPath ? pathToFileURL(resolvedPath).href : null;
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
