export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getConsoleBuffer } = await import("@/lib/consoleBuffer.js");
    getConsoleBuffer();
  }
}
