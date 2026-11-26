import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import { requestContextMiddleware } from './common/request-context.js';
import compression from 'compression';
import { AppModule } from './app.module.js';
import { ResponseInterceptor } from './common/interceptors/response.interceptor.js';
import { HttpExceptionFilter } from './common/filters/http-exception.filter.js';
import { buildCorsPolicy } from './common/security/cors.js';
import { publicMenuCache } from './common/cache/ttl-cache.js';
import { NoNullBytesGuard } from './common/guards/no-null-bytes.guard.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  const configService = app.get(ConfigService);

  // Behind a load balancer the real client is the address the balancer saw, never a value the client typed.
  // TRUST_PROXY_HOPS = how many proxies sit in front of the API (Render: 1). req.ip, rate limiting and audit evidence all rely on it.
  const hops = Number.parseInt(process.env.TRUST_PROXY_HOPS ?? '1', 10);
  (app.getHttpAdapter().getInstance() as any).set('trust proxy', Number.isInteger(hops) && hops >= 0 ? hops : 1);
  app.use(requestContextMiddleware);

  // Security: Helmet headers configured for cross-origin APIs & web sockets
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  // gzip/br-less clients are unaffected; everyone else gets compressed JSON (orders/report lists shrink ~10x)
  app.use(compression());

  // Any completed write invalidates the public menu cache so diners never see data older than the last change
  app.use((req: any, res: any, next: any) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') res.on('finish', () => publicMenuCache.clear());
    next();
  });

  // Global API Prefix: /api/v1/... (excluding public root & health checks for uptime monitors/Render)
  app.setGlobalPrefix('api/v1', {
    exclude: ['health', 'api/v1/health', ''],
  });

  // CORS: only the web app origin(s) in FRONTEND_URL (see common/security/cors.ts for the exact rules)
  const cors = buildCorsPolicy({
    FRONTEND_URL: process.env.FRONTEND_URL || configService.get<string>('FRONTEND_URL'),
    CORS_ALLOWED_SUFFIXES: process.env.CORS_ALLOWED_SUFFIXES || configService.get<string>('CORS_ALLOWED_SUFFIXES'),
    NODE_ENV: process.env.NODE_ENV,
  });
  if (cors.unconfigured) {
    console.warn(
      cors.production
        ? '⚠️  FRONTEND_URL is not set: browsers on other origins are BLOCKED. Set it to your web app URL(s), comma-separated.'
        : '⚠️  FRONTEND_URL is not set: CORS accepts any origin (development only).',
    );
  }
  app.enableCors({
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) =>
      callback(null, cors.isAllowed(origin)),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Idempotency-Key'],
  });

  // A NUL character anywhere in the request is refused as a 400 (PostgreSQL would turn it into a 500)
  app.useGlobalGuards(new NoNullBytesGuard());

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
