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
} from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
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

    const messages: string[] =
      exRes && typeof exRes === 'object' && Array.isArray((exRes as any).message)
        ? (exRes as any).message
        : [
            exRes && typeof exRes === 'object'
              ? (exRes as any).message ?? 'Internal server error'
              : (exception as Error)?.message ?? 'Internal server error',
          ];

    const errorLabel =
      exRes && typeof exRes === 'object'
        ? (exRes as any).error ?? HttpStatus[status]
        : HttpStatus[status];

    res.status(status).json({
      success:    false,
      statusCode: status,
      error:      errorLabel,
      message:    messages,
      path:       req.url,
      timestamp:  new Date().toISOString(),
    });
  }
}
