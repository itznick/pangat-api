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
import { Logger } from '@nestjs/common';

import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import * as crypto from 'crypto';
import { Restaurant } from '../restaurants/entities/restaurant.entity.js';
import { Order } from '../orders/entities/order.entity.js';
import { Staff } from '../auth/entities/staff.entity.js';

@WebSocketGateway({
  cors: {
    // Authorization is enforced per room (JWT / tracking token), so the transport accepts any origin
    // (phones on the local network, tablets, deployment domains).
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => callback(null, true),
    credentials: true,
  },
})
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(EventsGateway.name);
  private readonly connectedClients = new Set<string>();
  private readonly outletRooms = new Map<string, Set<string>>();

  constructor(
    private readonly jwtService: JwtService,
    private readonly dataSource: DataSource,
  ) {}

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
    const room = `${kind}:${slug}`;
    client.join(room);
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
    if (!allowed && client.data?.user && (await this.stillValid(client))) {
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
    this.server.to(kdsRoom).emit('order:new', order);
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
      this.server.to(`kds:${cleanSlug}`).emit('order:status', { orderId, status, order });
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
      this.server.to(`kds:${cleanSlug}`).emit('order:paid', payload);
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
      this.server.to(`kds:${cleanSlug}`).emit('order:updated', { orderId, order });
      this.server.to(`admin:${cleanSlug}`).emit('order:updated', { orderId, order });
    }
    this.logger.log(`Emitted order:updated for order #${orderId}`);
  }

  emitTableStatus(restaurantSlug: string, table: any) {
    const cleanSlug = (restaurantSlug || 'pangat').trim().toLowerCase();
    const adminRoom = `admin:${cleanSlug}`;
    this.server.to(adminRoom).emit('table:status', table);
    this.logger.log(`Emitted table:status for table ${table?.tableNumber} (${table?.status}) to ${adminRoom}`);
  }
}
