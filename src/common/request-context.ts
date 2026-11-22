import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * Who is calling and from where, for the lifetime of one request. Audit entries, error logs and the response header all read
 * the same request id, so one customer complaint ("it failed at 7:42") can be traced end to end.
 */
export interface RequestContext {
  requestId: string;
  ip: string | null;
  userAgent: string | null;
}

const als = new AsyncLocalStorage<RequestContext>();

export const currentRequest = (): RequestContext | undefined => als.getStore();
export const runWithRequest = <T>(ctx: RequestContext, fn: () => T): T => als.run(ctx, fn);

/** Express middleware: assign a request id, capture the real client address (needs `trust proxy`), expose the id to the client. */
export function requestContextMiddleware(req: any, res: any, next: () => void) {
  const requestId = randomUUID();
  res.setHeader('X-Request-Id', requestId);
  const ip = String(req.ip || req.socket?.remoteAddress || '').slice(0, 64) || null;
  const userAgent = String(req.headers?.['user-agent'] || '').slice(0, 255) || null;
  als.run({ requestId, ip, userAgent }, next);
}
