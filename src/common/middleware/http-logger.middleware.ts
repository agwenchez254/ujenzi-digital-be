import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';

const MAX_BODY_CHARS = 1500;
const SLOW_REQUEST_MS = 1000;
const REDACTED = '[REDACTED]';
const SENSITIVE_KEY = /pass(word)?|token|secret|authorization|cookie|otp|pin|credential|api[-_]?key|csrf|private|wrapped|ciphertext|blob|signature/i;
const SKIPPED_PATHS = [/^\/docs/, /^\/favicon/];

/** Recursively masks sensitive values so they never reach the logs. */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth > 6) return '[Nested]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [
      k,
      SENSITIVE_KEY.test(k) ? REDACTED : redact(v, depth + 1),
    ]),
  );
}

function stringify(value: unknown): string {
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(redact(value));
  } catch {
    return '[unserializable]';
  }
  if (text === undefined) return '';
  return text.length > MAX_BODY_CHARS
    ? `${text.slice(0, MAX_BODY_CHARS)}… (+${text.length - MAX_BODY_CHARS} chars truncated)`
    : text;
}

function isEmpty(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'object' && Object.keys(value as object).length === 0)
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * Logs one entry per request, written when the response finishes so the request,
 * response, caller and timing appear together. Example:
 *
 *   ✖ 400 POST /auth/login  8ms  1.2KB  [a1b2c3d4]
 *     user:     anonymous  (::1)
 *     body:     {"email":"a@b.co","password":"[REDACTED]"}
 *     response: {"statusCode":400,"message":["email must be an email"],"error":"Bad Request"}
 *
 * Set LOG_HTTP_BODIES=false to hide request/response bodies (always off in production
 * unless explicitly set to "true"). Sensitive fields are redacted either way.
 */
@Injectable()
export class HttpLoggerMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');
  private readonly logBodies =
    process.env.LOG_HTTP_BODIES !== undefined
      ? process.env.LOG_HTTP_BODIES === 'true'
      : process.env.NODE_ENV !== 'production';

  use(req: Request, res: Response, next: NextFunction): void {
    const { method, originalUrl } = req;
    if (SKIPPED_PATHS.some((p) => p.test(originalUrl))) return next();

    const incomingId = req.headers['x-request-id'];
    const requestId =
      typeof incomingId === 'string' && /^[\w-]{1,64}$/.test(incomingId)
        ? incomingId
        : randomUUID().slice(0, 8);
    res.setHeader('x-request-id', requestId);
    res.locals.requestId = requestId;

    const start = process.hrtime.bigint();
    let responseBody: unknown;

    if (this.logBodies) {
      const originalSend = res.send.bind(res);
      res.send = (body?: unknown) => {
        const type = String(res.getHeader('content-type') ?? '');
        if (typeof body === 'string' && /json|text/.test(type)) {
          try {
            responseBody = JSON.parse(body);
          } catch {
            responseBody = body;
          }
        } else if (Buffer.isBuffer(body)) {
          responseBody = `[binary ${formatBytes(body.length)}]`;
        }
        return originalSend(body as never);
      };
    }

    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      const duration = ms < 10 ? `${ms.toFixed(1)}ms` : `${Math.round(ms)}ms`;
      const { statusCode } = res;
      const size = formatBytes(Number(res.getHeader('content-length') ?? 0));
      const slow = ms >= SLOW_REQUEST_MS ? '  🐢 SLOW' : '';
      const icon = statusCode >= 500 ? '✖' : statusCode >= 400 ? '⚠' : '✔';

      const user = req.user as { userId?: string; roles?: string[] } | undefined;
      const who = user?.userId
        ? `${user.userId}${user.roles?.length ? ` (${user.roles.join(', ')})` : ''}`
        : 'anonymous';

      const lines = [
        `${icon} ${statusCode} ${method} ${originalUrl.split('?')[0]}  ${duration}  ${size}  [${requestId}]${slow}`,
        `  user:     ${who}  (${req.ip})`,
      ];
      if (!isEmpty(req.query)) lines.push(`  query:    ${stringify(req.query)}`);
      if (!isEmpty(req.params)) lines.push(`  params:   ${stringify(req.params)}`);

      if (this.logBodies) {
        const contentType = String(req.headers['content-type'] ?? '');
        if (contentType.includes('multipart/form-data')) {
          lines.push('  body:     [multipart upload]');
        } else if (!isEmpty(req.body)) {
          lines.push(`  body:     ${stringify(req.body)}`);
        }
        if (responseBody !== undefined) lines.push(`  response: ${stringify(responseBody)}`);
      }

      const error = res.locals.error as { message: string; stack?: string } | undefined;
      if (error) {
        lines.push(`  error:    ${error.message}`);
        // 5xx stack traces are logged separately by the exception filter.
      }

      const message = lines.join('\n');
      if (statusCode >= 500) this.logger.error(message);
      else if (statusCode >= 400) this.logger.warn(message);
      else this.logger.log(message);
    });

    next();
  }
}
