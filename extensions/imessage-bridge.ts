/**
 * iMessage Bridge Extension
 *
 * Connects Pi to iMessage via BlueBubbles REST API.
 * Polls for incoming messages, injects them as user messages,
 * and sends assistant responses back via iMessage.
 *
 * Config via environment variables:
 *   BB_PASSWORD  - BlueBubbles server password (default: Zawsx@12)
 *   BB_URL       - BlueBubbles server URL (default: http://localhost:1234)
 *   BB_PHONE     - Phone number to bridge (default: +61435599858)
 *   BB_POLL_INTERVAL - Poll interval in ms (default: 2000)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import * as https from "node:https";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type SendUserMessageContent = Parameters<ExtensionAPI["sendUserMessage"]>[0];
type SendUserMessageBlock = Extract<SendUserMessageContent, readonly unknown[]>[number];
type BlueBubblesAttachment = { guid?: string; mimeType?: string };
type BlueBubblesChat = { chatIdentifier?: string };
type BlueBubblesMessage = {
  dateCreated?: number;
  isFromMe?: boolean;
  handle?: { address?: string };
  chats?: BlueBubblesChat[];
  text?: string;
  attachments?: BlueBubblesAttachment[];
};
type BlueBubblesResponse<T> = {
  data?: T;
  message?: string;
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const BB_PASSWORD = process.env.BB_PASSWORD || "Zawsx@12";
const BB_URL = process.env.BB_URL || "http://localhost:1234";
const BB_PHONE = process.env.BB_PHONE || "+61435599858";
const BB_POLL_INTERVAL = parseInt(process.env.BB_POLL_INTERVAL || "2000");
const CHAT_GUID = `iMessage;-;${BB_PHONE}`;
const ATTACHMENTS_DIR = path.join(process.env.HOME || "~", "claude-memory/imessage/attachments");

export default function (pi: ExtensionAPI) {
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let lastMessageTime = 0;
  let waitingForReply = false; // true when we've injected an iMessage and are waiting for the turn to end
  let latestCtx: ExtensionContext | null = null;
  let enabled = false;

  fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });

  // ═══════════════════════════════════════
  // HTTP helpers
  // ═══════════════════════════════════════

  function request<T = unknown>(method: string, urlPath: string, body?: JsonValue): Promise<T> {
    return new Promise((resolve, reject) => {
      const url = new URL(urlPath, BB_URL);
      url.searchParams.set("password", BB_PASSWORD);

      const mod = url.protocol === "https:" ? https : http;
      const payload = body ? JSON.stringify(body) : undefined;

      const req = mod.request(url, {
        method,
        headers: payload ? { "Content-Type": "application/json" } : {},
      }, (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => data += chunk);
        res.on("end", () => {
          try { resolve(JSON.parse(data) as T); }
          catch { resolve(data as T); }
        });
      });

      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  function downloadAttachment(guid: string, mime: string): Promise<{ path: string; isAudio: boolean } | null> {
    return new Promise((resolve) => {
      const url = new URL(`/api/v1/attachment/${guid}/download`, BB_URL);
      url.searchParams.set("password", BB_PASSWORD);

      const mod = url.protocol === "https:" ? https : http;
      mod.get(url, (res) => {
        const contentType = res.headers["content-type"] || mime;
        const extMap: Record<string, string> = {
          "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif",
          "image/webp": ".webp", "image/heic": ".heic",
          "video/mp4": ".mp4", "audio/mpeg": ".mp3",
          "audio/mp4": ".m4a", "audio/x-m4a": ".m4a",
          "audio/aac": ".aac", "audio/caf": ".caf",
          "application/pdf": ".pdf",
        };
        const isAudio = (contentType || "").startsWith("audio/");
        const ext = extMap[contentType || ""] || "";
        const filename = `${guid.replace(/\//g, "_")}${ext}`;
        const filepath = path.join(ATTACHMENTS_DIR, filename);

        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          fs.writeFileSync(filepath, Buffer.concat(chunks));
          log(`Downloaded attachment: ${filepath}`);
          resolve({ path: filepath, isAudio });
        });
        res.on("error", () => resolve(null));
      }).on("error", () => resolve(null));
    });
  }

  // ═══════════════════════════════════════
  // Logging
  // ═══════════════════════════════════════

  function log(msg: string) {
    console.log(`[iMessage] ${msg}`);
  }

  // ═══════════════════════════════════════
  // Send iMessage via BlueBubbles
  // ═══════════════════════════════════════

  async function sendIMessage(text: string) {
    try {
      await request("POST", "/api/v1/message/text", {
        chatGuid: CHAT_GUID,
        message: text,
      });
      log(`Sent reply (${text.length} chars)`);
    } catch (err: unknown) {
      log(`Failed to send: ${errorMessage(err)}`);
    }
  }

  async function sendTypingIndicator() {
    try {
      await request("POST", `/api/v1/chat/${CHAT_GUID}/typing`);
    } catch {}
  }

  // ═══════════════════════════════════════
  // Poll for new messages
  // ═══════════════════════════════════════

  async function getLatestMessageTime(): Promise<number> {
    try {
      const res = await request<BlueBubblesResponse<BlueBubblesMessage[]>>("POST", "/api/v1/message/query", {
        limit: 1, sort: "DESC",
      });
      const msgs = res?.data || [];
      return msgs.length > 0 ? msgs[0].dateCreated || 0 : 0;
    } catch (err: unknown) {
      log(`Error getting latest message time: ${errorMessage(err)}`);
      return 0;
    }
  }

  async function pollMessages() {
    if (!enabled || !latestCtx) return;

    try {
      const res = await request<BlueBubblesResponse<BlueBubblesMessage[]>>("POST", "/api/v1/message/query", {
        limit: 20,
        sort: "DESC",
        after: lastMessageTime,
        with: ["chat", "handle", "attachment"],
      });

      const messages = (res?.data || []).reverse();

      for (const msg of messages) {
        const msgTime = msg.dateCreated || 0;
        if (msgTime <= lastMessageTime) continue;

        lastMessageTime = Math.max(lastMessageTime, msgTime);

        // Skip our own messages
        if (msg.isFromMe) continue;

        // Check it's from Matt
        const handle = msg.handle || {};
        const address = handle.address || "";
        const fromMatt = BB_PHONE && address.includes(BB_PHONE.replace("+", ""));
        if (!fromMatt) {
          const chats = msg.chats || [];
          const chatMatch = chats.some((c) => (c.chatIdentifier || "").includes(BB_PHONE));
          if (!chatMatch) continue;
        }

        // Process the message
        await processMessage(msg);
      }
    } catch (err: unknown) {
      log(`Poll error: ${errorMessage(err)}`);
    }
  }

  async function processMessage(msg: BlueBubblesMessage) {
    let text = msg.text || "";
    const attachments = msg.attachments || [];

    const attachmentPaths: string[] = [];
    let voiceNotePath: string | null = null;

    for (const att of attachments) {
      const guid = att.guid || "";
      const mime = att.mimeType || "";
      if (!guid) continue;
      const result = await downloadAttachment(guid, mime);
      if (result) {
        attachmentPaths.push(result.path);
        if (result.isAudio) voiceNotePath = result.path;
      }
    }

    // Build the message content
    let fullMessage = text;
    if (voiceNotePath) {
      fullMessage = `[Voice note from Matt at ${voiceNotePath} — transcribe and respond]`;
      if (text) fullMessage += ` (caption: ${text})`;
    } else if (attachmentPaths.length > 0) {
      fullMessage += ` [Attachments: ${attachmentPaths.join(", ")}]`;
    }

    if (!fullMessage.trim()) return;

    log(`From Matt: ${fullMessage.substring(0, 100)}...`);

    // Send typing indicator
    await sendTypingIndicator();

    // Inject as a real user message
    waitingForReply = true;

    // Build content array with images if applicable
    const imageExts = [".jpg", ".jpeg", ".png", ".gif", ".webp"];
    const imageAttachments = attachmentPaths.filter(p =>
      imageExts.some(ext => p.toLowerCase().endsWith(ext))
    );

    if (imageAttachments.length > 0 && !voiceNotePath) {
      const content: SendUserMessageBlock[] = [];
      if (text) content.push({ type: "text", text: `[iMessage from Matt] ${text}` });
      for (const imgPath of imageAttachments) {
        try {
          const imgData = fs.readFileSync(imgPath);
          const ext = path.extname(imgPath).toLowerCase().replace(".", "");
          const mediaType = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
          content.push({
            type: "image",
            data: imgData.toString("base64"),
            mimeType: mediaType,
          });
        } catch {}
      }
      pi.sendUserMessage(content, { deliverAs: "followUp" });
    } else {
      pi.sendUserMessage(`[iMessage from Matt] ${fullMessage}`, { deliverAs: "followUp" });
    }
  }

  // ═══════════════════════════════════════
  // Capture responses and send back
  // ═══════════════════════════════════════

  pi.on("turn_end", async (event, ctx) => {
    if (!enabled || !waitingForReply) return;
    waitingForReply = false;

    // Extract the assistant's text response from the turn
    const message = event.message;
    if (message.role !== "assistant") return;

    // Get text content from the message
    const responseText = message.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    if (!responseText.trim()) return;

    // Strip markdown for iMessage (keep it readable)
    const cleanText = responseText
      .replace(/```[\s\S]*?```/g, "[code block]") // collapse code blocks
      .replace(/`([^`]+)`/g, "$1") // inline code → plain
      .replace(/\*\*([^*]+)\*\*/g, "$1") // bold → plain
      .replace(/\*([^*]+)\*/g, "$1") // italic → plain
      .replace(/^#{1,6}\s+/gm, "") // strip headers
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // links → text
      .trim();

    // iMessage has a practical limit — split long messages
    const MAX_LEN = 4000;
    if (cleanText.length <= MAX_LEN) {
      await sendIMessage(cleanText);
    } else {
      // Split on paragraph boundaries
      const paragraphs = cleanText.split(/\n\n+/);
      let chunk = "";
      for (const para of paragraphs) {
        if (chunk.length + para.length + 2 > MAX_LEN) {
          if (chunk) await sendIMessage(chunk.trim());
          chunk = para;
        } else {
          chunk += (chunk ? "\n\n" : "") + para;
        }
      }
      if (chunk) await sendIMessage(chunk.trim());
    }
  });

  // ═══════════════════════════════════════
  // Lifecycle
  // ═══════════════════════════════════════

  pi.on("session_start", async (_event, ctx) => {
    latestCtx = ctx;

    // Check if BlueBubbles is reachable
    try {
      const res = await request<BlueBubblesResponse<unknown>>("GET", "/api/v1/ping");
      if (res?.message === "pong") {
        enabled = true;
        log("Connected to BlueBubbles");
        ctx.ui.setStatus("imessage", "📱 iMessage bridge active");

        // Start from current latest message
        lastMessageTime = await getLatestMessageTime();
        log(`Starting poll from message time: ${lastMessageTime}`);

        // Start polling
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = setInterval(pollMessages, BB_POLL_INTERVAL);
      } else {
        log("BlueBubbles not responding — bridge disabled");
      }
    } catch (err: unknown) {
      log(`BlueBubbles unreachable (${errorMessage(err)}) — bridge disabled`);
    }
  });

  pi.on("session_shutdown", async () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    enabled = false;
    log("Bridge shut down");
  });

  // ═══════════════════════════════════════
  // Commands
  // ═══════════════════════════════════════

  pi.registerCommand("imessage", {
    description: "Send an iMessage to Matt",
    handler: async (args, ctx) => {
      if (!enabled) {
        ctx.ui.notify("iMessage bridge not connected", "error");
        return;
      }
      const text = args.trim();
      await sendIMessage(text);
      ctx.ui.notify(`Sent iMessage: ${text.substring(0, 50)}...`, "info");
    },
  });

  pi.registerCommand("imessage-status", {
    description: "Check iMessage bridge status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        enabled
          ? `iMessage bridge active. Polling every ${BB_POLL_INTERVAL / 1000}s. Last message time: ${lastMessageTime}`
          : "iMessage bridge disabled (BlueBubbles unreachable)",
        "info"
      );
    },
  });
}
