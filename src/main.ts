import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { ResponseInterceptor } from './common/interceptors/response.interceptor.js';
import { HttpExceptionFilter } from './common/filters/http-exception.filter.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
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

  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      // Allow requests with no origin (e.g. curl, Render health checks, server-to-server)
      if (!origin) return callback(null, true);
      if (
        allowedOrigins.includes('*') ||
        allowedOrigins.includes(origin) ||
        origin.endsWith('.onrender.com') ||
        origin.endsWith('.netlify.app') ||
        origin.endsWith('.vercel.app')
      ) {
        return callback(null, true);
      }
      return callback(null, true);
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
