import type { GroupSettingsRecord } from "../persistence/state";
import { type ActivationCredentials, AGENT_TYPE, PLATFORM_ID } from "../types";
export type FetchLike = typeof fetch;
export type ClawChatApiErrorKind = "validation" | "transport" | "api" | "auth";
export class ClawChatApiError extends Error {
  constructor(
    readonly kind: ClawChatApiErrorKind,
    message: string,
    readonly meta: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ClawChatApiError";
  }
}
export interface AgentConnectResult {
  access_token?: string;
  refresh_token?: string | null;
  agent?: { id?: string; user_id?: string; owner_id?: string };
  conversation?: { id?: string } | null;
}
export interface ClawChatUserProfile {
  nickname: string | null;
}
export interface ClawChatApiClient {
  agentsConnect(params: { code: string; existingUserId?: string | null }): Promise<AgentConnectResult>;
  getUserProfile(userId: string): Promise<ClawChatUserProfile>;
  updateMyProfile(patch: unknown): Promise<unknown>;
  getMyGroupSettings(): Promise<{ authoritative: boolean; rows: GroupSettingsRecord[] }>;
}

export function createClawChatApiClient(options: {
  baseUrl: string;
  deviceId: string;
  token?: string | null;
  fetchImpl?: FetchLike;
}): ClawChatApiClient & {
  getAgentOwnerProfile(): Promise<{ id: string | null; nickname: string | null; locale: string | null }>;
} {
  const baseUrl = normalizeBaseUrl(options.baseUrl, "baseUrl");
  const deviceId = options.deviceId.trim();
  if (!deviceId) throw new ClawChatApiError("validation", "deviceId is required");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
      ...extra,
      "x-device-id": deviceId,
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    };
  }
  async function readEnvelope<T>(response: Response, path: string): Promise<T> {
    if (response.status === 401) throw new ClawChatApiError("auth", "unauthorized", { path });
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (error) {
      throw new ClawChatApiError(
        "transport",
        `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        { path },
      );
    }
    if (parsed && typeof parsed === "object" && "code" in parsed) {
      const record = parsed as Record<string, unknown>;
      const code = typeof record.code === "number" ? record.code : Number(record.code);
      if (code !== 0)
        throw new ClawChatApiError("api", typeof record.msg === "string" ? record.msg : `code=${record.code}`, {
          path,
          code: record.code,
          data: record.data,
        });
      return record.data as T;
    }
    if (!response.ok)
      throw new ClawChatApiError("transport", `HTTP ${response.status}`, {
        path,
        status: response.status,
        body: parsed,
      });
    return parsed as T;
  }
  async function call<T>(
    method: string,
    path: string,
    init: { body?: BodyInit; headers?: Record<string, string>; base?: string } = {},
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(`${init.base ?? baseUrl}${path}`, {
        method,
        headers: authHeaders(init.headers),
        ...(init.body !== undefined ? { body: init.body } : {}),
      });
    } catch (error) {
      throw new ClawChatApiError(
        "transport",
        `fetch failed: ${error instanceof Error ? error.message : String(error)}`,
        { path },
      );
    }
    return await readEnvelope<T>(response, path);
  }
  function json(body: unknown): { body: string; headers: Record<string, string> } {
    return { body: JSON.stringify(body), headers: { "content-type": "application/json" } };
  }
  function requireId(value: string, label: string): string {
    const trimmed = value.trim();
    if (!trimmed) throw new ClawChatApiError("validation", `${label} is required`);
    return trimmed;
  }
  return {
    async agentsConnect(params) {
      const body: Record<string, string> = {
        code: requireId(params.code, "agentsConnect: code"),
        platform: PLATFORM_ID,
        type: AGENT_TYPE,
      };
      if (params.existingUserId?.trim()) body.user_id = params.existingUserId.trim();
      return await call<AgentConnectResult>("POST", "/v1/agents/connect", json(body));
    },
    async getAgentOwnerProfile() {
      const profile = await call<Record<string, unknown>>("GET", "/v1/agents/me/owner");
      return {
        id: optionalTrimmedString(profile.id),
        nickname: optionalTrimmedString(profile.nickname),
        locale: optionalTrimmedString(profile.locale),
      };
    },
    async getUserProfile(userId) {
      const profile = await call<Record<string, unknown>>(
        "GET",
        `/v1/users/${encodeURIComponent(requireId(userId, "getUserProfile: userId"))}`,
      );
      return { nickname: optionalTrimmedString(profile.nickname) };
    },
    async updateMyProfile(patch) {
      return await call<unknown>("PATCH", "/v1/users/me", json(patch));
    },
    async getMyGroupSettings() {
      let data: Record<string, unknown>;
      try {
        data = await call<Record<string, unknown>>("GET", "/v1/agents/me/group-settings");
      } catch (error) {
        if (error instanceof ClawChatApiError && error.kind === "auth") throw error;
        return { authoritative: false, rows: [] };
      }
      if (!data || typeof data !== "object" || Array.isArray(data)) return { authoritative: false, rows: [] };
      if (!Array.isArray(data.settings)) return { authoritative: false, rows: [] };
      const parsedRows: GroupSettingsRecord[] = [];
      for (const value of data.settings) {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          return { authoritative: false, rows: [] };
        }
        const row = value as Record<string, unknown>;
        const conversationId = typeof row.conversation_id === "string" ? row.conversation_id.trim() : "";
        const replyMode = row.reply_mode === "mention" || row.reply_mode === "all" ? row.reply_mode : null;
        const batchDelaySeconds = row.batch_delay_seconds;
        const version = row.version;
        if (
          !conversationId ||
          typeof row.muted !== "boolean" ||
          !replyMode ||
          typeof batchDelaySeconds !== "number" ||
          !Number.isSafeInteger(batchDelaySeconds) ||
          batchDelaySeconds < 0 ||
          typeof version !== "number" ||
          !Number.isSafeInteger(version) ||
          version < 0
        ) {
          return { authoritative: false, rows: [] };
        }
        parsedRows.push({ conversationId, muted: row.muted, replyMode, batchDelaySeconds, version });
      }
      const rowsByConversation = new Map<string, GroupSettingsRecord>();
      for (const row of parsedRows) {
        const existing = rowsByConversation.get(row.conversationId);
        if (!existing || row.version >= existing.version) rowsByConversation.set(row.conversationId, row);
      }
      return { authoritative: true, rows: [...rowsByConversation.values()] };
    },
  };
}

export function normalizeActivationResult(localAgentId: string, raw: AgentConnectResult): ActivationCredentials {
  const accessToken = requireTrimmedString(raw.access_token, "access_token");
  const agent = raw.agent ?? {};
  return {
    localAgentId,
    accessToken,
    refreshToken: optionalTrimmedString(raw.refresh_token),
    serverAgentId: optionalTrimmedString(agent.id),
    userId: requireTrimmedString(agent.user_id, "agent.user_id"),
    ownerUserId: requireTrimmedString(agent.owner_id, "agent.owner_id"),
    conversationId: raw.conversation ? optionalTrimmedString(raw.conversation.id) : null,
  };
}
function normalizeBaseUrl(value: string, label: string): string {
  const trimmed = value.trim().replace(/\/+$/u, "");
  if (!/^https?:\/\//iu.test(trimmed))
    throw new ClawChatApiError("validation", `${label} must start with http:// or https://`);
  return trimmed;
}
function requireTrimmedString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new ClawChatApiError("api", `agents/connect response missing required field ${field}`);
  return value.trim();
}
function optionalTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
