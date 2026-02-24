import type { FastifyReply } from "fastify";

export interface ErrorEnvelope {
  code: string;
  message: string;
  remediation?: string;
  details?: Record<string, unknown>;
}

export function sendError(reply: FastifyReply, status: number, envelope: ErrorEnvelope): FastifyReply {
  return reply.status(status).send(envelope);
}
