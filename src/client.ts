/**
 * TrueNAS JSON-RPC 2.0 WebSocket Client
 * Replaces the deprecated REST API v2.0 with the JSON-RPC 2.0 over WebSocket API.
 * Endpoint: wss://<host>/api/current
 * Auth: auth.login_with_api_key
 */

import WebSocket from "ws";

export interface TrueNASClientConfig {
  baseUrl: string;
  apiKey: string;
  verifySsl?: boolean;
}

export interface JobResult {
  id: number;
  method: string;
  state: string;
  progress: { percent: number; description: string };
  result: unknown;
  error: string | null;
  time_started: { $date: number } | null;
  time_finished: { $date: number } | null;
}

export class TrueNASClient {
  private baseUrl: string;
  private apiKey: string;
  private verifySsl: boolean;

  constructor(config: TrueNASClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.verifySsl = config.verifySsl ?? true;
  }

  // ---------------------------------------------------------------------------
  // WebSocket JSON-RPC transport
  // ---------------------------------------------------------------------------

  private wsUrl(): string {
    const url = new URL(this.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/api/current";
    return url.toString();
  }

  private async rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl(), {
        rejectUnauthorized: this.verifySsl,
      });

      const timeout = setTimeout(() => {
        ws.terminate();
        reject(new Error(`RPC call ${method} timed out`));
      }, 60000);

      let authenticated = false;
      const callId = 2;

      ws.once("open", () => {
        ws.send(JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "auth.login_with_api_key",
          params: [this.apiKey],
        }));
      });

      ws.on("message", (data: Buffer) => {
        let msg: any;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }

        if (msg.id === 1) {
          if (!msg.result) {
            clearTimeout(timeout);
            ws.close();
            reject(new Error("TrueNAS API authentication failed"));
            return;
          }
          authenticated = true;
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: callId, method, params }));
          return;
        }

        if (msg.id === callId && authenticated) {
          clearTimeout(timeout);
          ws.close();
          if (msg.error) {
            reject(new Error(`TrueNAS API error calling ${method}: ${msg.error.message ?? JSON.stringify(msg.error)}`));
          } else {
            resolve(msg.result as T);
          }
        }
      });

      ws.once("error", (err) => {
        clearTimeout(timeout);
        reject(new Error(`WebSocket error calling ${method}: ${err.message}`));
      });
    });
  }

  // ---------------------------------------------------------------------------
  // REST-compatible interface — translates paths to JSON-RPC method calls
  // ---------------------------------------------------------------------------

  /**
   * Converts a REST-style path and HTTP verb into a JSON-RPC method name and params.
   *
   * Rules:
   *   GET  /foo           → foo.query          []
   *   GET  /foo/id/{id}   → foo.get_instance   [id]
   *   POST /foo           → foo.create         [body]
   *   PUT  /foo/id/{id}   → foo.update         [id, body]
   *   DEL  /foo/id/{id}   → foo.delete         [id, body?]
   *   POST /foo/id/{id}/action → foo.action    [id, body?]
   *   POST /foo/action    → foo.action         [body?]
   */
  private pathToRpc(
    verb: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): { method: string; params: unknown[] } {
    // Normalise: strip leading slash, decode URI components
    const clean = path.replace(/^\/+/, "");
    const parts = clean.split("/").map((p) => decodeURIComponent(p));

    // Detect /id/{id} segment
    const idIdx = parts.indexOf("id");
    const hasId = idIdx !== -1 && parts.length > idIdx + 1;
    const rawId = hasId ? parts[idIdx + 1] : undefined;
    const id = rawId !== undefined ? (isNaN(Number(rawId)) ? rawId : Number(rawId)) : undefined;

    // Namespace: everything before /id/... joined with dots
    const nsParts = hasId ? parts.slice(0, idIdx) : parts;
    // If there's an action after /id/{id} pick it up
    const actionParts = hasId ? parts.slice(idIdx + 2) : [];
    const action = actionParts.length > 0 ? actionParts.join(".") : undefined;

    const ns = nsParts.join(".");

    if (action) {
      // POST /pool/id/3/export  → pool.export [3, body]
      const params: unknown[] = id !== undefined ? [id] : [];
      if (body !== undefined) params.push(body);
      return { method: `${ns}.${action}`, params };
    }

    switch (verb) {
      case "GET":
        return hasId
          ? { method: `${ns}.get_instance`, params: [id] }
          : { method: `${ns}.query`, params: [] };
      case "POST":
        return { method: `${ns}.create`, params: body !== undefined ? [body] : [] };
      case "PUT":
        return { method: `${ns}.update`, params: id !== undefined ? [id, body] : [body] };
      case "DELETE":
        return {
          method: `${ns}.delete`,
          params: id !== undefined
            ? (body !== undefined ? [id, body] : [id])
            : (body !== undefined ? [body] : []),
        };
    }
  }

  async get<T = unknown>(path: string, params?: Record<string, unknown>): Promise<T> {
    const { method, params: rpcParams } = this.pathToRpc("GET", path);
    // Translate query params into a filter list appended to query calls
    if (params && Object.keys(params).length > 0 && method.endsWith(".query")) {
      const filters = Object.entries(params).map(([k, v]) => [k, "=", v]);
      return this.rpc<T>(method, [filters]);
    }
    return this.rpc<T>(method, rpcParams);
  }

  async post<T = unknown>(path: string, body?: unknown): Promise<T> {
    const { method, params } = this.pathToRpc("POST", path, body);
    return this.rpc<T>(method, params);
  }

  async put<T = unknown>(path: string, body?: unknown): Promise<T> {
    const { method, params } = this.pathToRpc("PUT", path, body);
    return this.rpc<T>(method, params);
  }

  async delete<T = unknown>(path: string, body?: unknown): Promise<T> {
    const { method, params } = this.pathToRpc("DELETE", path, body);
    return this.rpc<T>(method, params);
  }

  /** Call a JSON-RPC method directly by name */
  async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    return this.rpc<T>(method, params);
  }

  /** Wait for a long-running job to complete */
  async waitForJob(jobId: number, timeoutMs: number = 300000): Promise<JobResult> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const jobs = await this.rpc<JobResult[]>("core.get_jobs", [[["id", "=", jobId]]]);
      const target = Array.isArray(jobs) ? jobs.find((j) => j.id === jobId) : undefined;
      if (target) {
        if (target.state === "SUCCESS") return target;
        if (target.state === "FAILED") throw new Error(`Job ${jobId} failed: ${target.error}`);
        if (target.state === "ABORTED") throw new Error(`Job ${jobId} was aborted`);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`Job ${jobId} timed out after ${timeoutMs}ms`);
  }

  /** Test connectivity */
  async ping(): Promise<boolean> {
    try {
      await this.rpc("system.info");
      return true;
    } catch {
      return false;
    }
  }
}
