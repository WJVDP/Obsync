import { randomBytes } from "node:crypto";
import { sha256Hex, type Scope } from "@obsync/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";

export interface AuthContext {
  userId: string;
  scopes: Scope[];
  authType: "jwt" | "api_key";
}

function parseProtocolToken(value: string | string[] | undefined): string | null {
  const raw = typeof value === "string" ? value : Array.isArray(value) ? value.join(",") : "";
  if (!raw) {
    return null;
  }

  const candidates = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const candidate of candidates) {
    if (candidate.toLowerCase() === "obsync-auth" || candidate.toLowerCase() === "bearer") {
      continue;
    }
    if (candidate.toLowerCase().startsWith("bearer ")) {
      return candidate.slice("bearer ".length).trim() || null;
    }
    return candidate;
  }

  return null;
}

function extractAuthToken(request: FastifyRequest): string | null {
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length);
  }

  // Realtime path: preferred websocket protocol token transport.
  const protocolToken = parseProtocolToken(request.headers["sec-websocket-protocol"]);
  if (protocolToken) {
    return protocolToken;
  }

  // Backward compatibility: allow query token for one transition window.
  const queryToken = (request.query as { token?: string } | undefined)?.token;
  if (typeof queryToken === "string" && queryToken.trim()) {
    return queryToken.trim();
  }

  return null;
}

export async function resolveAuthContext(
  server: FastifyInstance,
  pool: Pool,
  request: FastifyRequest
): Promise<AuthContext | null> {
  const token = extractAuthToken(request);
  if (!token) {
    return null;
  }

  try {
    const jwtPayload = await server.jwt.verify<{ userId: string }>(token);
    if (jwtPayload?.userId) {
      return {
        userId: jwtPayload.userId,
        scopes: ["admin", "write", "read"],
        authType: "jwt"
      };
    }
  } catch {
    // Fall through to API key auth.
  }

  const hashedSecret = sha256Hex(token);
  const key = await pool.query<{
    user_id: string;
    scopes: string[];
    revoked_at: Date | null;
  }>(
    `SELECT user_id, scopes, revoked_at
     FROM api_keys
     WHERE hashed_secret = $1`,
    [hashedSecret]
  );

  const row = key.rows[0];
  if (!row || row.revoked_at) {
    return null;
  }

  return {
    userId: row.user_id,
    scopes: row.scopes as Scope[],
    authType: "api_key"
  };
}

export async function installAuth(server: FastifyInstance, pool: Pool): Promise<void> {
  server.decorateRequest("authContext", null);

  server.decorate(
    "authenticate",
    async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const authContext = await resolveAuthContext(server, pool, request);
      if (authContext) {
        request.authContext = authContext;
        return;
      }

      reply.code(401).send({
        code: "UNAUTHORIZED",
        message: "Missing or invalid bearer token",
        remediation: "Provide a valid JWT or API key with Bearer auth"
      });
    }
  );
}

export function generateApiKeySecret(): string {
  return `obsk_${randomBytes(32).toString("hex")}`;
}
