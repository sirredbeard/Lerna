import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const maxBody = 16 * 1024 * 1024;

const copilotOnlyModels = new Set(["mai-code-1.1-flash", "mai-code-1-flash-picker"]);

export async function shouldBypassLerna(request) {
  if (new URL(request.url).pathname !== "/responses" || request.method !== "POST") return false;
  try {
    const body = await request.clone().json();
    return copilotOnlyModels.has(body?.model);
  } catch { return false; }
}

export function requestSessionId(request, context, attachedSessionId) {
  if (context.sessionId) return context.sessionId;
  // Copilot 1.0.83 omits the planner's session context, but supplies this header.
  if (new URL(request.url).pathname === "/model/fusion"
      && request.headers.get("x-client-session-id") === attachedSessionId) return attachedSessionId;
  return undefined;
}

export class Bridge {
  #child;
  #pending = new Map();
  #next = 0;
  #closed = false;
  #onResponse;
  #timeouts;

  constructor(binary, args = ["serve"], { onResponse, timeouts } = {}) {
    this.#onResponse = onResponse;
    this.#timeouts = { login: 16 * 60000, forward: 125000, default: 120000, ...timeouts };
    this.#child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.#child.stderr.resume();
    this.#child.stdin.on("error", () => this.#failAll("Lerna's input pipe closed"));
    this.#child.on("error", () => this.#failAll("Lerna could not start"));
    this.#child.on("exit", () => this.#failAll("Lerna stopped"));
    createInterface({ input: this.#child.stdout }).on("line", line => {
      try {
        if (line.length > 128 * 1024) throw new Error("Oversized protocol frame");
        this.#receive(JSON.parse(line));
      } catch { this.#failAll("Invalid response from Lerna"); }
    });
  }

  #send(message) {
    if (this.#closed) throw new Error("Lerna is not running");
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #finish(id, error) {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    pending.cleanup?.();
    if (error) {
      pending.reject(error);
      pending.controller?.error(error);
    }
  }

  #failAll(message) {
    if (this.#closed) return;
    this.#closed = true;
    for (const id of [...this.#pending.keys()]) this.#finish(id, new Error(message));
  }

  #credit(id, pending) {
    if (!pending.credit && this.#pending.has(id)) {
      pending.credit = true;
      this.#send({ op: "credit", requestId: id });
    }
  }

  #refreshTimeout(id, pending) {
    clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      this.#send({ op: "cancel", requestId: id });
      this.#finish(id, new Error("Lerna request timed out"));
    }, pending.timeoutMs);
    pending.timer.unref();
  }

  #receive(message) {
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    if (message.type === "error") {
      this.#finish(message.id, new Error(message.error || "Lerna rejected the operation"));
    } else if (message.type === "result") {
      clearTimeout(pending.timer);
      pending.progress.then(() => {
        pending.resolve(message.value);
        this.#finish(message.id);
      }, error => this.#finish(message.id, error));
    } else if (message.type === "login") {
      this.#refreshTimeout(message.id, pending);
      pending.progress = pending.progress.then(() => {
        if (!pending.onProgress) throw new Error("Azure sign-in needs an interactive session");
        return pending.onProgress(message);
      });
      pending.progress.catch(error => {
        if (!this.#pending.has(message.id)) return;
        this.#send({ op: "cancel", requestId: message.id });
        this.#finish(message.id, error);
      });
    } else if (message.type === "head") {
      this.#refreshTimeout(message.id, pending);
      this.#onResponse?.({ status: message.status, via: message.via, adaptedModel: message.adaptedModel });
      const noBody = [204, 205, 304].includes(message.status);
      pending.noBody = noBody;
      const body = noBody ? null : new ReadableStream({
        start: controller => { pending.controller = controller; },
        pull: () => this.#credit(message.id, pending),
        cancel: () => {
          this.#send({ op: "cancel", requestId: message.id });
          this.#finish(message.id);
        },
      });
      pending.resolve(new Response(body, { status: message.status, headers: message.headers }));
      if (noBody) this.#credit(message.id, pending);
    } else if (message.type === "chunk") {
      this.#refreshTimeout(message.id, pending);
      pending.credit = false;
      if (pending.noBody) this.#credit(message.id, pending);
      else pending.controller.enqueue(Buffer.from(message.data, "base64"));
    } else if (message.type === "end") {
      pending.controller?.close();
      this.#finish(message.id);
    } else {
      throw new Error("Unknown protocol frame");
    }
  }

  #request(op, data, signal, onProgress) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.#closed) return Promise.reject(new Error("Lerna is not running"));
    return new Promise((resolve, reject) => {
      const id = String(++this.#next);
      const abort = () => {
        this.#send({ op: "cancel", requestId: id });
        this.#finish(id, new Error("Lerna request cancelled"));
      };
      const timeoutMs = op === "azure.login" ? this.#timeouts.login
        : op === "forward" ? this.#timeouts.forward : this.#timeouts.default;
      const pending = {
        resolve, reject, timer: undefined, timeoutMs, credit: false, onProgress, progress: Promise.resolve(),
        cleanup: () => signal?.removeEventListener("abort", abort),
      };
      this.#pending.set(id, pending);
      this.#refreshTimeout(id, pending);
      signal?.addEventListener("abort", abort, { once: true });
      this.#send({ id, op, ...data });
    });
  }

  invoke(op, data = {}, { signal, onProgress } = {}) { return this.#request(op, data, signal, onProgress); }

  async forward(request, context) {
    const chunks = [];
    let size = 0;
    if (request.body) {
      const reader = request.body.getReader();
      try {
        while (true) {
          context.signal.throwIfAborted();
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBody) throw new Error("Lerna request exceeds 16 MiB");
          chunks.push(Buffer.from(value));
        }
      } catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
      } finally { reader.releaseLock(); }
    }
    return this.#request("forward", {
      sessionId: context.sessionId,
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body: Buffer.concat(chunks, size).toString("base64"),
    }, context.signal);
  }

  close() {
    this.#failAll("Lerna is shutting down");
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) return;
    this.#child.stdin.end();
    const timer = setTimeout(() => this.#child.kill(), 3000);
    timer.unref();
    this.#child.once("exit", () => clearTimeout(timer));
  }
}
