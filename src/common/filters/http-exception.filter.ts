// ─────────────────────────────────────────────────────────────────────────────
// src/common/filters/http-exception.filter.ts
// Global exception handler — wraps NestJS HttpExceptions in Pangat error envelope
// ─────────────────────────────────────────────────────────────────────────────

import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { reportServerError } from '../../platform/monitoring.service.js';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx    = host.switchToHttp();
    const res    = ctx.getResponse<Response>();
    const req    = ctx.getRequest<Request>();

    // Errors raised by the body parser (oversized / malformed JSON) are client errors carrying their own 4xx status
    const parserStatus = !(exception instanceof HttpException) ? (exception as any)?.status ?? (exception as any)?.statusCode : undefined;
    const clientParserError = typeof parserStatus === 'number' && parserStatus >= 400 && parserStatus < 500 && Boolean((exception as any)?.expose ?? (exception as any)?.type);
    const status = clientParserError
      ? parserStatus
      : exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const exRes =
      exception instanceof HttpException ? exception.getResponse() : null;

    // Unexpected errors (database, runtime) are logged here and never echoed to the client
    if (!(exception instanceof HttpException) && !clientParserError) {
      this.logger.error(
        `${req.method} ${req.url} -> ${(exception as Error)?.message}`,
        (exception as Error)?.stack,
      );
    }

    if (status >= 500) {
      reportServerError({ method: req.method, url: req.originalUrl || req.url, status, error: exception as Error, userId: (req as any).user?.id, orgId: (req as any).user?.organizationId });
    }

    const messages: string[] =
      exception instanceof HttpException
        ? exRes && typeof exRes === 'object' && Array.isArray((exRes as any).message)
          ? (exRes as any).message
          : [
              exRes && typeof exRes === 'object'
                ? (exRes as any).message ?? 'Request failed'
                : String(exRes ?? 'Request failed'),
            ]
        : clientParserError
          ? [parserStatus === 413 ? 'Request body is too large' : 'Malformed request body']
          : ['Internal server error'];

    // Nest wraps JSON syntax errors as a plain 400 whose message is the raw parser text: replace it with a generic one
    if (status === 400 && messages.some((m) => /JSON|Unexpected token|Expected (property name|double-quoted|','|'\})/i.test(String(m)) && /position|line \d+ column/i.test(String(m)))) {
      messages.splice(0, messages.length, 'Malformed request body');
    }

    const code = exRes && typeof exRes === 'object' ? (exRes as any).code : undefined;

    const errorLabel =
      exRes && typeof exRes === 'object'
        ? (exRes as any).error ?? HttpStatus[status]
        : HttpStatus[status];

    res.status(status).json({
      success:    false,
      statusCode: status,
      error:      errorLabel,
      message:    messages,
      ...(code ? { code } : {}),
      path:       req.url,
      timestamp:  new Date().toISOString(),
    });
  }
}
