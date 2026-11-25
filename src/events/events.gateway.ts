import { redactForKitchen } from '../orders/order-redaction.js';
import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger, OnModuleDestroy } from '@nestjs/common';

import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import * as crypto from 'crypto';
import { Restaurant } from '../restaurants/entities/restaurant.entity.js';
import { Order } from '../orders/entities/order.entity.js';
import { Staff } from '../auth/entities/staff.entity.js';
import { decideFeature, getOrgAccess } from '../subscriptions/subscription-access.js';
import { onEntitlementChange } from '../subscriptions/entitlement-events.js';

@WebSocketGateway({
  cors: {
    // Authorization is enforced per room (JWT / tracking token), so the transport accepts any origin
    // (phones on the local network, tablets, deployment domains).
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => callback(null, true),
    credentials: true,
  },
})
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(EventsGateway.name);
  private readonly connectedClients = new Set<string>();
  private readonly outletRooms = new Map<string, Set<string>>();

  /**
   * Live-feed access is not trusted forever. Sockets in the kitchen room are tracked here and re-checked:
   *  - at once when something that decides entitlement changes (subscription, plan edit, global switch, per-restaurant override:
   *    the same signals that invalidate the entitlement caches), debounced so a burst of changes costs one check per organisation;
   *  - periodically (SOCKET_REVALIDATE_MS, default 30 s) as the safety net for changes nobody announced (a period ending by itself,
   *    a direct database edit, a deactivated or password-changed account).
   * Cost: one entitlement lookup per ORGANISATION with kitchen sockets and one batched staff lookup per pass, never one per socket or event.
   */
  private readonly kitchenSockets = new Map<string, { orgId: string; userId: string; iat: number; role: string }>();
  private readonly timers: NodeJS.Timeout[] = [];
  private pending = new Set<string | null>();
  private debounce: NodeJS.Timeout | null = null;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly jwtService: JwtService,
    private readonly dataSource: DataSource,
  ) {
    this.unsubscribe = onEntitlementChange((orgId) => this.scheduleRevalidation(orgId));
    const every = Math.max(500, Number(process.env.SOCKET_REVALIDATE_MS) || 30_000);
    const t = setInterval(() => void this.revalidateAll(true), every);
    t.unref();
    this.timers.push(t);
  }

  onModuleDestroy() {
    this.unsubscribe();
    this.timers.forEach((t) => clearInterval(t));
    if (this.debounce) clearTimeout(this.debounce);
  }

  private scheduleRevalidation(orgId: string | null) {
    this.pending.add(orgId);
    if (this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = null;
      const todo = this.pending;
      this.pending = new Set();
      void (todo.has(null) ? this.revalidateAll(false) : this.revalidateOrgs([...todo] as string[]));
    }, 150);
    this.debounce.unref();
  }

  /** Orgs that currently have kitchen sockets. */
  private orgsWithKitchenSockets(): string[] {
    return [...new Set([...this.kitchenSockets.values()].map((v) => v.orgId))];
  }

  private async revalidateAll(includeStaff: boolean) {
    try {
      await this.revalidateOrgs(this.orgsWithKitchenSockets());
      if (includeStaff) await this.revalidateStaff();
    } catch (e) {
      this.logger.warn(`Kitchen socket re-check failed: ${(e as Error).message}`);
    }
  }

  /** Re-decide KDS access for each organisation that has live kitchen sockets and revoke those that lost it. */
  private async revalidateOrgs(orgIds: string[]) {
    for (const orgId of orgIds) {
      if (![...this.kitchenSockets.values()].some((v) => v.orgId === orgId)) continue;
      let reason: string | null = null;
      try {
        const [feature, access] = await Promise.all([decideFeature(this.dataSource, orgId, 'KDS'), getOrgAccess(this.dataSource, orgId)]);
        if (!feature.allowed) reason = feature.reason;
        else if (access.blocked) reason = 'SUBSCRIPTION';
      } catch (e) {
        this.logger.warn(`Could not re-check KDS access for ${orgId}: ${(e as Error).message}`);
        continue; // never revoke (or grant) on a failed lookup; the next pass tries again
      }
      if (!reason) continue;
      for (const [id, meta] of [...this.kitchenSockets.entries()]) {
        if (meta.orgId === orgId) this.revokeKitchen(id, reason);
      }
    }
  }

  /** Deactivated, deleted or password-changed accounts lose the kitchen feed too (one batched query for all tracked sockets). */
  private async revalidateStaff() {
    if (this.kitchenSockets.size === 0) return;
    const ids = [...new Set([...this.kitchenSockets.values()].map((v) => v.userId))];
    const rows: Array<{ id: string; is_active: boolean; password_changed_at: Date | null }> = await this.dataSource.query(
      'SELECT id, is_active, password_changed_at FROM staff WHERE id = ANY($1::uuid[])',
      [ids],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const [sid, meta] of [...this.kitchenSockets.entries()]) {
      const r = byId.get(meta.userId);
      const stale = !r || r.is_active === false || (r.password_changed_at && meta.iat && meta.iat < Math.floor(new Date(r.password_changed_at).getTime() / 1000));
      if (stale) this.revokeKitchen(sid, 'ACCOUNT');
    }
  }

  /** Take a socket out of every kitchen room, tell it why, and cut the connection when it belongs to a kitchen-only (CHEF) session. */
  private revokeKitchen(socketId: string, reason: string) {
    const meta = this.kitchenSockets.get(socketId);
    this.kitchenSockets.delete(socketId);
    const socket = this.server?.sockets?.sockets?.get(socketId);
    if (!socket) return;
    for (const room of [...socket.rooms]) if (room.startsWith('kds:')) socket.leave(room);
    socket.emit('access:revoked', { feature: 'KDS', reason, message: 'The live kitchen display is no longer available for this restaurant.' });
    this.logger.warn(`Kitchen feed revoked for socket ${socketId} (${reason})`);
    if (meta?.role === 'CHEF') socket.disconnect(true); // a kitchen-only session has nothing else to do here
  }

  /** Staff sockets present their JWT in the handshake; diners connect anonymously and prove ownership per order. */
  handleConnection(client: Socket) {
    const token = (client.handshake?.auth as any)?.token;
    if (typeof token === 'string' && token) {
      try {
        const p: any = this.jwtService.verify(token);
        client.data.user = {
          id: p.sub,
          role: p.role,
          isPlatformAdmin: Boolean(p.isPlatformAdmin || p.role === 'PLATFORM_SUPER_ADMIN'),
          organizationId: p.organizationId ?? null,
          restaurantId: p.restaurantId ?? null,
          iat: p.iat,
        };
      } catch {
        client.data.user = null; // expired / forged: treated as anonymous
      }
    }
    this.connectedClients.add(client.id);
    this.logger.log(`Client connected: ${client.id} (total online: ${this.connectedClients.size})`);
  }

  handleDisconnect(client: Socket) {
    this.connectedClients.delete(client.id);
    this.kitchenSockets.delete(client.id);
    for (const [slug, sockets] of this.outletRooms.entries()) {
      sockets.delete(client.id);
      if (sockets.size === 0) {
        this.outletRooms.delete(slug);
      }
    }
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  /** May this socket's user see the live feed of the outlet with this slug? */
  private async canJoinOutlet(client: Socket, slug: string): Promise<boolean> {
    const user = client.data?.user;
    if (!user) return false;
    if (user.isPlatformAdmin) return true;
    const outlet = await this.dataSource.getRepository(Restaurant).findOne({ where: { slug } });
    if (!outlet) return false;
    if (user.restaurantId && user.restaurantId === outlet.id) return true;
    return Boolean(user.role === 'SUPER_OWNER' && user.organizationId && user.organizationId === outlet.organizationId);
  }

  /** Session still valid? (account active and no password change since the token was issued) */
  private async stillValid(client: Socket): Promise<boolean> {
    const user = client.data?.user;
    if (!user) return false;
    const staff = await this.dataSource.getRepository(Staff).findOne({ where: { id: user.id } });
    if (!staff || staff.isActive === false) return false;
    if (staff.passwordChangedAt && user.iat && user.iat < Math.floor(staff.passwordChangedAt.getTime() / 1000)) return false;
    return true;
  }

  private async joinOutletRoom(client: Socket, kind: 'kds' | 'admin', data: any) {
    const rawSlug = typeof data === 'string' ? data : data?.restaurantSlug;
    const slug = String(rawSlug || '').trim().toLowerCase();
    if (!slug) return { status: 'denied', reason: 'restaurantSlug required' };
    if (!(await this.stillValid(client)) || !(await this.canJoinOutlet(client, slug))) {
      return { status: 'denied', reason: 'unauthorized' };
    }
    // The admin feed carries the full order (customer details and amounts). The kitchen role is redacted by design and only ever gets
    // the kitchen room, so it can never use this room to read what it may not, or to keep a live feed when the kitchen display is off.
    if (kind === 'admin' && client.data.user?.role === 'CHEF') {
      return { status: 'denied', reason: 'unauthorized' };
    }
    // The kitchen display is a plan feature: the live kitchen feed is refused (not just hidden) when the plan, a platform switch or an override
    // says no, and when the subscription has lapsed. The decision is re-made later (see kitchenSockets) so a grant is never permanent.
    let kitchenOrg: string | null = null;
    if (kind === 'kds' && !client.data.user?.isPlatformAdmin) {
      const outlet = await this.dataSource.getRepository(Restaurant).findOne({ where: { slug } });
      if (outlet?.organizationId) {
        const [feature, access] = await Promise.all([decideFeature(this.dataSource, outlet.organizationId, 'KDS'), getOrgAccess(this.dataSource, outlet.organizationId)]);
        if (!feature.allowed) return { status: 'denied', reason: 'feature_unavailable' };
        if (access.blocked) return { status: 'denied', reason: 'subscription_inactive' };
        kitchenOrg = outlet.organizationId;
      }
    }
    const room = `${kind}:${slug}`;
    client.join(room);
    if (kitchenOrg) {
      const u = client.data.user;
      this.kitchenSockets.set(client.id, { orgId: kitchenOrg, userId: u.id, iat: u.iat, role: u.role });
    }
    if (!this.outletRooms.has(slug)) {
      this.outletRooms.set(slug, new Set());
    }
    this.outletRooms.get(slug)!.add(client.id);
    this.logger.log(`Client ${client.id} joined ${room}`);
    return { status: 'joined', room };
  }

  @SubscribeMessage('join:kds')
  async handleJoinKds(@ConnectedSocket() client: Socket, @MessageBody() data: any) {
    return this.joinOutletRoom(client, 'kds', data);
  }

  @SubscribeMessage('join:admin')
  async handleJoinAdmin(@ConnectedSocket() client: Socket, @MessageBody() data: any) {
    return this.joinOutletRoom(client, 'admin', data);
  }

  getConnectedSocketsCount(): number {
    return this.connectedClients.size;
  }

  isOutletOnline(slug: string): boolean {
    const cleanSlug = (slug || '').trim().toLowerCase();
    const sockets = this.outletRooms.get(cleanSlug);
    return Boolean(sockets && sockets.size > 0);
  }

  getActiveOutletSlugs(): string[] {
    return Array.from(this.outletRooms.keys());
  }

  /** Diners need the order's private tracking token; staff of the outlet may also follow any of its orders. */
  @SubscribeMessage('join:order')
  async handleJoinOrder(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { orderId: string; token?: string },
  ) {
    const orderId = String(data?.orderId || '').trim();
    if (!orderId) return { status: 'denied', reason: 'orderId required' };
    const order = await this.dataSource.getRepository(Order).findOne({ where: { id: orderId } });
    if (!order) return { status: 'denied', reason: 'unauthorized' };

    let allowed = false;
    const given = String(data?.token || '');
    if (order.trackingToken && given.length === order.trackingToken.length) {
      allowed = crypto.timingSafeEqual(Buffer.from(given), Buffer.from(order.trackingToken));
    }
    // The order room carries the full, unredacted order: the kitchen role (which is redacted by design) never gets in through its staff
    // credentials; diners still get in with the order's private tracking token.
    if (!allowed && client.data?.user && client.data.user.role !== 'CHEF' && (await this.stillValid(client))) {
      const u = client.data.user;
      if (u.isPlatformAdmin || u.restaurantId === order.restaurantId) {
        allowed = true;
      } else if (u.role === 'SUPER_OWNER' && u.organizationId) {
        const outlet = await this.dataSource.getRepository(Restaurant).findOne({ where: { id: order.restaurantId } });
        allowed = outlet?.organizationId === u.organizationId;
      }
    }
    if (!allowed) return { status: 'denied', reason: 'unauthorized' };
    const room = `order:${orderId}`;
    client.join(room);
    return { status: 'joined', room };
  }

  emitNewOrder(restaurantSlug: string, order: any) {
    const cleanSlug = (restaurantSlug || 'pangat').trim().toLowerCase();
    const kdsRoom = `kds:${cleanSlug}`;
    const adminRoom = `admin:${cleanSlug}`;
    this.server.to(kdsRoom).emit('order:new', redactForKitchen(order));
    this.server.to(adminRoom).emit('order:new', order);
    this.logger.log(`Emitted order:new to ${kdsRoom} & ${adminRoom} for order #${order.id}`);
  }

  emitOrderStatus(orderId: string, status: string, order: any, restaurantSlug?: string) {
    const room = `order:${orderId}`;
    this.server.to(room).emit('order:status', { orderId, status, order });
    // Also emit to KDS and Admin rooms
    const rawSlug = restaurantSlug || order?.restaurant?.slug;
    if (rawSlug) {
      const cleanSlug = rawSlug.trim().toLowerCase();
      this.server.to(`kds:${cleanSlug}`).emit('order:status', { orderId, status, order: redactForKitchen(order) });
      this.server.to(`admin:${cleanSlug}`).emit('order:status', { orderId, status, order });
    }
    this.logger.log(`Emitted order:status (${status}) for order #${orderId}`);
  }

  emitOrderPaid(orderId: string, order: any, restaurantSlug?: string) {
    const room = `order:${orderId}`;
    const settledAt = order?.settledAt ? (order.settledAt instanceof Date ? order.settledAt.toISOString() : String(order.settledAt)) : new Date().toISOString();
    const payload = {
      orderId,
      paymentStatus: 'PAID',
      settledAt,
      order,
    };
    this.server.to(room).emit('order:paid', payload);
    const rawSlug = restaurantSlug || order?.restaurant?.slug;
    if (rawSlug) {
      const cleanSlug = rawSlug.trim().toLowerCase();
      this.server.to(`kds:${cleanSlug}`).emit('order:paid', { orderId, order: redactForKitchen(order) }); // the kitchen is told nothing about money
      this.server.to(`admin:${cleanSlug}`).emit('order:paid', payload);
    }
    this.logger.log(`Emitted order:paid for order #${orderId}`);
  }

  emitOrderUpdated(orderId: string, order: any, restaurantSlug?: string) {
    const room = `order:${orderId}`;
    this.server.to(room).emit('order:updated', { orderId, order });
    const rawSlug = restaurantSlug || order?.restaurant?.slug;
    if (rawSlug) {
      const cleanSlug = rawSlug.trim().toLowerCase();
      this.server.to(`kds:${cleanSlug}`).emit('order:updated', { orderId, order: redactForKitchen(order) });
      this.server.to(`admin:${cleanSlug}`).emit('order:updated', { orderId, order });
    }
    this.logger.log(`Emitted order:updated for order #${orderId}`);
  }

  /** A dish was switched on/off (by hand, or automatically because an ingredient ran out / came back). */
  emitMenuAvailability(restaurantSlug: string, payload: { id: string; name: string; isAvailable: boolean; auto: boolean }) {
    const slug = (restaurantSlug || '').trim().toLowerCase();
    if (!slug) return;
    this.server?.to(`kds:${slug}`).emit('menu:availability', payload);
    this.server?.to(`admin:${slug}`).emit('menu:availability', payload);
  }

  emitTableStatus(restaurantSlug: string, table: any) {
    const cleanSlug = (restaurantSlug || 'pangat').trim().toLowerCase();
    const adminRoom = `admin:${cleanSlug}`;
    this.server.to(adminRoom).emit('table:status', table);
    this.logger.log(`Emitted table:status for table ${table?.tableNumber} (${table?.status}) to ${adminRoom}`);
  }
}
