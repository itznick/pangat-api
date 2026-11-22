import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { PlatformAuditService, actorOf } from './audit.service.js';

/** Restaurant-console API areas. A platform administrator reaching any of these is looking at a restaurant's own data. */
const MERCHANT_AREAS = /^\/api\/v1\/(orders|restaurants|menu|tables|inventory|reports|organizations)(\/|$|\?)/;
const WINDOW_MS = 10 * 60_000;

/**
 * Records every time Pangat staff open a restaurant's console data. One entry per admin + area + restaurant per 10 minutes
 * (a dashboard that polls would otherwise write thousands of rows). Failures to record never block the read, but are logged loudly.
 */
@Injectable()
export class PlatformAccessInterceptor implements NestInterceptor {
  private readonly seen = new Map<string, number>();
  constructor(private readonly audit: PlatformAuditService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() === 'http') {
      const req = context.switchToHttp().getRequest();
      const u = req?.user;
      const path = String(req?.originalUrl || req?.url || '');
      if (u && (u.isPlatformAdmin === true || u.role === 'PLATFORM_SUPER_ADMIN') && MERCHANT_AREAS.test(path)) {
        const area = path.split('?')[0].split('/')[3];
        const target = String(req.query?.restaurantSlug || req.params?.slug || req.params?.id || req.query?.restaurantId || '-');
        const key = `${u.id}:${area}:${target}:${req.method === 'GET' ? 'r' : 'w'}`;
        const now = Date.now();
        if (now - (this.seen.get(key) ?? 0) > WINDOW_MS) {
          this.seen.set(key, now);
          if (this.seen.size > 5000) for (const [k, t] of this.seen) if (now - t > WINDOW_MS) this.seen.delete(k);
          void this.audit.record(actorOf(req), {
            action: req.method === 'GET' ? 'MERCHANT_DATA_VIEWED' : 'MERCHANT_DATA_CHANGED',
            category: 'PRIVACY',
            entityType: 'restaurant_console',
            entityId: target.slice(0, 100),
            entityLabel: area,
            summary: `${req.method === 'GET' ? 'Opened' : 'Changed'} restaurant ${area} data (${target})`,
          });
        }
      }
    }
    return next.handle();
  }
}
