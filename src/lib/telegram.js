import { getProviderConnections } from "@/lib/localDb.js";
import { getUsageStats } from "@/lib/usageDb.js";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_THREAD_ID = process.env.TELEGRAM_THREAD_ID;

/**
 * Escape string for Telegram HTML parsing.
 */
function escapeHtml(str) {
  if (typeof str !== "string") return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Send a message via Telegram Bot API.
 */
export async function sendTelegramMessage(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn("[Telegram] BOT_TOKEN or CHAT_ID is not configured in environment.");
    return false;
  }

  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const payload = {
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    };

    if (TELEGRAM_THREAD_ID) {
      payload.message_thread_id = Number(TELEGRAM_THREAD_ID);
    }

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Telegram] Failed to send message: ${response.status} - ${errorText}`);
      return false;
    }

    return true;
  } catch (error) {
    console.error("[Telegram] Error sending message:", error);
    return false;
  }
}

/**
 * Notify the user when a connection is de-activated (disconnected).
 */
export async function notifyConnectionDisconnect(connection) {
  try {
    const allConnections = await getProviderConnections({ isActive: true });
    
    const connName = escapeHtml(
      connection.displayName || connection.name || connection.email || connection.id
    );
    const provider = escapeHtml(connection.provider);
    const error = escapeHtml(connection.lastError || "No error details available");
    
    // Count active connections remaining for this provider
    const remainingCount = allConnections.filter(
      (c) => c.provider === connection.provider && c.id !== connection.id
    ).length;

    const message = `⚠️ <b>Connection Disconnected</b>
<b>Account:</b> ${connName}
<b>Provider:</b> ${provider}
<b>Error:</b> ${error}

<b>Remaining active accounts for ${provider}:</b> ${remainingCount}`;

    return await sendTelegramMessage(message);
  } catch (error) {
    console.error("[Telegram] Error building disconnect notification:", error);
    return false;
  }
}

const BASE64_BLOCK_SIZE = 4;

function extractTierFromJwt(token) {
  try {
    if (!token || typeof token !== "string") return "free";
    const parts = token.split(".");
    if (parts.length !== 3) return "free";
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const missingPadding =
      (BASE64_BLOCK_SIZE - (base64.length % BASE64_BLOCK_SIZE)) %
      BASE64_BLOCK_SIZE;
    const padded = base64 + "=".repeat(missingPadding);
    const payload = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    
    const tier = payload["custom:tier"] || payload.tier || payload.tierId || payload.allowedTiers?.[0] || "";
    if (tier && typeof tier === "string") {
      const lower = tier.toLowerCase();
      if (lower.includes("plus") || lower.includes("pro")) return "plus";
      if (lower.includes("free")) return "free";
      return tier;
    }
    return "free";
  } catch {
    return "free";
  }
}

/**
 * Retrieve current connection usage stats and send a periodic report.
 */
export async function sendUsageReport() {
  try {
    const [stats, allConnections] = await Promise.all([
      getUsageStats("all"),
      getProviderConnections(),
    ]);

    const activeCount = allConnections.filter((c) => c.isActive !== false).length;
    const totalCount = allConnections.length;

    // Aggregate lifetime usage statistics from stats.byAccount
    const connectionUsage = {};
    for (const [key, value] of Object.entries(stats.byAccount || {})) {
      const connId = value.connectionId;
      if (!connId) continue;
      if (!connectionUsage[connId]) {
        connectionUsage[connId] = {
          requests: 0,
          tokens: 0,
        };
      }
      connectionUsage[connId].requests += value.requests || 0;
      connectionUsage[connId].tokens += (value.promptTokens || 0) + (value.completionTokens || 0);
    }

    let report = `<b>Router Connection & Usage Report</b>
<b>Time:</b> ${new Date().toLocaleString("en-US", { timeZone: "Asia/Bangkok" })} (UTC+7)
<b>Active connections:</b> ${activeCount}/${totalCount}\n\n`;

    // Group connections by provider
    const grouped = {};
    for (const conn of allConnections) {
      if (!grouped[conn.provider]) {
        grouped[conn.provider] = [];
      }
      grouped[conn.provider].push(conn);
    }

    for (const [provider, conns] of Object.entries(grouped)) {
      report += `<b>Provider: ${escapeHtml(provider.toUpperCase())}</b>\n`;
      
      for (const conn of conns) {
        const name = escapeHtml(conn.displayName || conn.name || conn.email || conn.id.slice(0, 8));
        const statusIcon = conn.isActive === false ? "🔴" : conn.testStatus === "unavailable" ? "🟡" : "🟢";
        const statusText = conn.isActive === false ? "disabled" : conn.testStatus || "active";
        const tier = extractTierFromJwt(conn.idToken);
        const usage = connectionUsage[conn.id] || { requests: 0, tokens: 0 };
        
        report += `<code>${name}</code> | <i>${tier}</i>  ${statusIcon} (<code>${statusText}</code>)
| Requests: ${usage.requests}
| Token usage: ${usage.tokens}\n\n`;
      }
    }

    return await sendTelegramMessage(report.trim());
  } catch (error) {
    console.error("[Telegram] Error generating usage report:", error);
    return false;
  }
}
