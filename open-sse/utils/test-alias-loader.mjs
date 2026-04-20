const usageDbStub = `
export function trackPendingRequest() {}
export async function appendRequestLog() {}
export async function saveRequestUsage() {}
export async function saveRequestDetail() {}
`;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@/lib/usageDb.js") {
    return {
      url: `data:text/javascript,${encodeURIComponent(usageDbStub)}`,
      shortCircuit: true,
    };
  }

  return nextResolve(specifier, context);
}
