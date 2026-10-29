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

@WebSocketGateway({
  cors: {
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      // Allow all connections from mobile phones, local Wi-Fi IP, localhost, or deployment domains
      callback(null, true);
    },
    credentials: true,
  },
})
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(EventsGateway.name);
  private readonly connectedClients = new Set<string>();
  private readonly outletRooms = new Map<string, Set<string>>();

  handleConnection(client: Socket) {
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

  @SubscribeMessage('join:kds')
  handleJoinKds(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: any,
  ) {
    const rawSlug = typeof data === 'string' ? data : (data?.restaurantSlug || 'pangat');
    const slug = rawSlug.trim().toLowerCase();
    const room = `kds:${slug}`;
    client.join(room);
    if (!this.outletRooms.has(slug)) {
      this.outletRooms.set(slug, new Set());
    }
    this.outletRooms.get(slug)!.add(client.id);
    this.logger.log(`Client ${client.id} joined ${room}`);
    return { status: 'joined', room };
  }

  @SubscribeMessage('join:admin')
  handleJoinAdmin(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: any,
  ) {
    const rawSlug = typeof data === 'string' ? data : (data?.restaurantSlug || 'pangat');
    const slug = rawSlug.trim().toLowerCase();
    const room = `admin:${slug}`;
    client.join(room);
    if (!this.outletRooms.has(slug)) {
      this.outletRooms.set(slug, new Set());
    }
    this.outletRooms.get(slug)!.add(client.id);
    this.logger.log(`Client ${client.id} joined ${room}`);
    return { status: 'joined', room };
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

  @SubscribeMessage('join:order')
  handleJoinOrder(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { orderId: string },
  ) {
    const room = `order:${data.orderId}`;
    client.join(room);
    this.logger.log(`Client ${client.id} joined ${room}`);
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
