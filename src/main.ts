import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { ResponseInterceptor } from './common/interceptors/response.interceptor.js';
import { HttpExceptionFilter } from './common/filters/http-exception.filter.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  const configService = app.get(ConfigService);

  // Security: Helmet headers configured for cross-origin APIs & web sockets
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  // Global API Prefix: /api/v1/... (excluding public root & health checks for uptime monitors/Render)
  app.setGlobalPrefix('api/v1', {
    exclude: ['health', 'api/v1/health', ''],
  });

  // Dynamic CORS configuration supporting comma-separated frontend URLs
  const rawFrontendUrl =
    process.env.FRONTEND_URL ||
    configService.get<string>('FRONTEND_URL') ||
    'http://localhost:5173';
  const configuredOrigins = rawFrontendUrl
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);
  const defaultOrigins = [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:3000',
  ];
  const allowedOrigins = Array.from(
    new Set([...configuredOrigins, ...defaultOrigins]),
  );

  // FRONTEND_URL is the allow-list. When it is not configured we stay open (and say so in the log) rather than
  // locking every browser out of the API; once it is set, only those origins (plus *.netlify.app etc.) get through.
  const originsConfigured = Boolean(process.env.FRONTEND_URL || configService.get<string>('FRONTEND_URL'));
  if (!originsConfigured) {
    console.warn('⚠️  FRONTEND_URL is not set: CORS accepts any origin. Set it to your web app URL(s), comma-separated.');
  }
  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      // Requests with no origin (curl, server-to-server, health checks)
      if (!origin) return callback(null, true);
      if (!originsConfigured) return callback(null, true);
      const host = (() => {
        try {
          return new URL(origin).hostname;
        } catch {
          return '';
        }
      })();
      const ok =
        allowedOrigins.includes('*') ||
        allowedOrigins.includes(origin) ||
        host.endsWith('.onrender.com') ||
        host.endsWith('.netlify.app') ||
        host.endsWith('.vercel.app');
      return callback(null, ok);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Idempotency-Key'],
  });

  // Global DTO input validation & transformation
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Global standard response envelope: { success, statusCode, message, data, timestamp }
  app.useGlobalInterceptors(new ResponseInterceptor());

  // Global standard error filter
  app.useGlobalFilters(new HttpExceptionFilter());

  // Render injects dynamic ports via process.env.PORT.
  // Bind to '0.0.0.0' so incoming Render container routing is not blocked.
  const port = process.env.PORT || configService.get<number>('PORT') || 4000;
  await app.listen(port, '0.0.0.0');
  console.log(`🚀 Pangat API is running on: http://0.0.0.0:${port}/api/v1`);
  console.log(`💚 Health check active at: http://0.0.0.0:${port}/health`);
}
bootstrap();
