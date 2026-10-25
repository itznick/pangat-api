// ─────────────────────────────────────────────────────────────────────────────
// src/common/interceptors/response.interceptor.ts
// Wraps every successful response in the standard Pangat envelope:
// { success, statusCode, message, data, timestamp }
// ─────────────────────────────────────────────────────────────────────────────

import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Request, Response } from 'express';

export interface PangatResponse<T> {
  success: boolean;
  statusCode: number;
  message: string;
  data: T;
  timestamp: string;
}

@Injectable()
export class ResponseInterceptor<T>
  implements NestInterceptor<T, PangatResponse<T>>
{
  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<any> {
    const ctx = context.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();

    // Pass through health checks directly without envelope
    if (
      request &&
      (request.url === '/health' ||
        request.url === '/api/v1/health' ||
        request.url?.startsWith('/health?'))
    ) {
      return next.handle();
    }

    return next.handle().pipe(
      map((data) => ({
        success: true,
        statusCode: response.statusCode,
        message: (data as any)?._message ?? 'Request successful',
        data: (data as any)?._message ? (data as any).data : data,
        timestamp: new Date().toISOString(),
      })),
    );
  }
}

/** Helper to attach a custom message to any controller return value */
export function withMessage<T>(data: T, message: string) {
  return { _message: message, data };
}
