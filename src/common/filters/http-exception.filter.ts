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

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx    = host.switchToHttp();
    const res    = ctx.getResponse<Response>();
    const req    = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const exRes =
      exception instanceof HttpException ? exception.getResponse() : null;

    // Unexpected errors (database, runtime) are logged here and never echoed to the client
    if (!(exception instanceof HttpException)) {
      this.logger.error(
        `${req.method} ${req.url} -> ${(exception as Error)?.message}`,
        (exception as Error)?.stack,
      );
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
        : ['Internal server error'];

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
