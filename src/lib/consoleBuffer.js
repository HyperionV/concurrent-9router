import { EventEmitter } from "node:events";

const MAX_BUFFER_LINES = 10000;
const ANSI_REGEX = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const BUFFER_KEY = Symbol.for("nine-router.console.buffer");

export function stripAnsi(str) {
  if (typeof str !== "string") return "";
  return str.replace(ANSI_REGEX, "");
}

export function detectLogLevel(cleanText, isStderr = false) {
  const lower = cleanText.toLowerCase();
  if (isStderr || cleanText.includes("❌") || lower.includes("[error]") || lower.includes("error:")) {
    return "ERROR";
  }
  if (cleanText.includes("⚠️") || lower.includes("[warn]") || lower.includes("warning:")) {
    return "WARN";
  }
  if (cleanText.includes("[DISPATCHER]")) {
    return "DISPATCHER";
  }
  if (cleanText.includes("📥") || cleanText.includes("[REQUEST]") || lower.includes("post /") || lower.includes("get /")) {
    return "REQUEST";
  }
  if (cleanText.includes("📊") || cleanText.includes("[USAGE]")) {
    return "USAGE";
  }
  if (cleanText.includes("🔍") || lower.includes("[debug]") || lower.includes("[format]")) {
    return "DEBUG";
  }
  return "INFO";
}

export function parseSinceToMs(since) {
  if (!since) return null;
  const str = String(since).trim().toLowerCase();
  const match = str.match(/^(\d+)\s*(s|m|h|d)$/);
  if (match) {
    const num = Number.parseInt(match[1], 10);
    const unit = match[2];
    const multipliers = {
      s: 1000,
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
    };
    return Date.now() - num * (multipliers[unit] || 1000);
  }
  const parsed = Date.parse(str);
  return Number.isFinite(parsed) ? parsed : null;
}

class ConsoleBuffer extends EventEmitter {
  constructor() {
    super();
    this.buffer = [];
    this.maxLines = MAX_BUFFER_LINES;
    this.nextId = 1;
    this.intercepted = false;
    this.stats = {
      total: 0,
      errors: 0,
      warnings: 0,
    };
    this.initInterception();
  }

  initInterception() {
    if (this.intercepted) return;
    if (typeof process === "undefined" || !process.stdout || !process.stderr) return;

    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    const originalStderrWrite = process.stderr.write.bind(process.stderr);

    let stdoutRemainder = "";
    let stderrRemainder = "";

    process.stdout.write = (chunk, encoding, callback) => {
      try {
        const text = typeof chunk === "string" ? chunk : chunk.toString(encoding || "utf8");
        stdoutRemainder = this._processChunk(stdoutRemainder + text, false);
      } catch {
        // Safe passthrough on any buffer error
      }
      return originalStdoutWrite(chunk, encoding, callback);
    };

    process.stderr.write = (chunk, encoding, callback) => {
      try {
        const text = typeof chunk === "string" ? chunk : chunk.toString(encoding || "utf8");
        stderrRemainder = this._processChunk(stderrRemainder + text, true);
      } catch {
        // Safe passthrough on any buffer error
      }
      return originalStderrWrite(chunk, encoding, callback);
    };

    this.intercepted = true;
  }

  _processChunk(text, isStderr) {
    const lines = text.split(/\r?\n/);
    const remainder = lines.pop() ?? "";
    for (const raw of lines) {
      if (raw.trim().length > 0) {
        this.pushLine(raw, isStderr);
      }
    }
    return remainder;
  }

  pushLine(raw, isStderr = false) {
    const clean = stripAnsi(raw);
    const level = detectLogLevel(clean, isStderr);
    const timestamp = new Date().toISOString();

    const entry = {
      id: this.nextId++,
      timestamp,
      raw,
      text: clean,
      level,
      isStderr,
    };

    this.stats.total++;
    if (level === "ERROR") this.stats.errors++;
    if (level === "WARN") this.stats.warnings++;

    this.buffer.push(entry);
    if (this.buffer.length > this.maxLines) {
      this.buffer.shift();
    }

    this.emit("log", entry);
    return entry;
  }

  getEntries({
    tail = 500,
    since = null,
    level = null,
    search = "",
    regex = false,
    caseSensitive = false,
  } = {}) {
    let result = this.buffer;

    const sinceMs = parseSinceToMs(since);
    if (sinceMs !== null) {
      result = result.filter((e) => new Date(e.timestamp).getTime() >= sinceMs);
    }

    if (level && level.toUpperCase() !== "ALL") {
      const targetLevel = level.toUpperCase();
      result = result.filter((e) => e.level === targetLevel);
    }

    if (search && search.trim().length > 0) {
      const query = search.trim();
      if (regex) {
        try {
          const re = new RegExp(query, caseSensitive ? "" : "i");
          result = result.filter((e) => re.test(e.text));
        } catch {
          // Invalid regex: treat as empty
        }
      } else {
        if (caseSensitive) {
          result = result.filter((e) => e.text.includes(query));
        } else {
          const lower = query.toLowerCase();
          result = result.filter((e) => e.text.toLowerCase().includes(lower));
        }
      }
    }

    const limit = Math.max(1, Math.min(Number(tail) || 500, this.maxLines));
    if (result.length > limit) {
      result = result.slice(result.length - limit);
    }

    return {
      entries: result,
      totalBuffered: this.buffer.length,
      matched: result.length,
      stats: { ...this.stats },
    };
  }

  clear() {
    this.buffer = [];
    this.stats = { total: 0, errors: 0, warnings: 0 };
    this.emit("clear");
  }
}

export function getConsoleBuffer() {
  if (!globalThis[BUFFER_KEY]) {
    globalThis[BUFFER_KEY] = new ConsoleBuffer();
  }
  return globalThis[BUFFER_KEY];
}

export const consoleBuffer = getConsoleBuffer();
