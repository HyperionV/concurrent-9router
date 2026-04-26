import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(process.cwd());
const emptyModuleStub = `
export default {};
`;
const usageDbStub = `
export function trackPendingRequest() {}
export async function appendRequestLog() {}
export async function saveRequestUsage() {}
export async function saveRequestDetail() {}
`;

function resolveRepoPath(relativePath) {
  return pathToFileURL(path.join(repoRoot, relativePath)).href;
}

function resolveMaybeExtensionless(relativePath) {
  const fullPath = path.join(repoRoot, relativePath);
  if (fs.existsSync(`${fullPath}.js`))
    return pathToFileURL(`${fullPath}.js`).href;
  if (fs.existsSync(fullPath)) {
    const stat = fs.statSync(fullPath);
    if (stat.isFile()) return pathToFileURL(fullPath).href;
    if (stat.isDirectory() && fs.existsSync(path.join(fullPath, "index.js"))) {
      return pathToFileURL(path.join(fullPath, "index.js")).href;
    }
  }
  return pathToFileURL(fullPath).href;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith(".css")) {
    return {
      url: `data:text/javascript,${encodeURIComponent(emptyModuleStub)}`,
      shortCircuit: true,
    };
  }

  if (specifier === "@/lib/usageDb.js") {
    return {
      url: `data:text/javascript,${encodeURIComponent(usageDbStub)}`,
      shortCircuit: true,
    };
  }

  if (specifier.startsWith("@/")) {
    return {
      url: resolveMaybeExtensionless(
        path.join(
          "src",
          specifier.endsWith("/")
            ? `${specifier.slice(2)}index`
            : specifier.slice(2),
        ),
      ),
      shortCircuit: true,
    };
  }

  if (specifier === "open-sse") {
    return {
      url: resolveRepoPath("open-sse/index.js"),
      shortCircuit: true,
    };
  }

  if (specifier.startsWith("open-sse/")) {
    return {
      url: resolveMaybeExtensionless(
        specifier.endsWith("/") ? `${specifier}index` : specifier,
      ),
      shortCircuit: true,
    };
  }

  return nextResolve(specifier, context);
}
