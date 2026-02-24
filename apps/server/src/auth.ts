import { randomBytes } from "node:crypto";
import { sha256Hex, type Scope } from "@obsync/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";

export interface AuthContext {
  userId: string;
  scopes: Scope[];
  authType: "jwt" | "api_key";
}

export async function installAuth(server: FastifyInstance, pool: Pool): Promise<void> {
  server.decorateRequest("authContext", null);

  server.decorate(
    "authenticate",
    async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const authHeader = request.headers.authorization;
      const queryToken = (request.query as { token?: string } | undefined)?.token;
      const protocolToken = request.headers["sec-websocket-protocol"];
      const token = authHeader?.startsWith("Bearer ")
        ? authHeader.slice("Bearer ".length)
        : typeof queryToken === "string"
          ? queryToken
          : typeof protocolToken === "string"
            ? protocolToken
            : null;

      if (!token) {
        reply.code(401).send({ code: "UNAUTHORIZED", message: "Missing bearer token" });
        return;
      }

      try {
        const jwtPayload = authHeader?.startsWith("Bearer ")
          ? await request.jwtVerify<{ userId: string }>()
          : (await server.jwt.verify<{ userId: string }>(token));
        request.authContext = {
          userId: jwtPayload.userId,
          scopes: ["admin", "write", "read"],
          authType: "jwt"
        };
        return;
      } catch {
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
          reply.code(401).send({ code: "UNAUTHORIZED", message: "Invalid token" });
          return;
        }

        request.authContext = {
          userId: row.user_id,
          scopes: row.scopes as Scope[],
          authType: "api_key"
        };
      }
    }
  );
}

export function generateApiKeySecret(): string {
  return `obsk_${randomBytes(32).toString("hex")}`;
}
