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

const allowedOrigins = process.env.FRONTEND_URL
  ? process.env.FRONTEND_URL.split(',').map((u) => u.trim()).filter(Boolean)
  : ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:3000'];

@WebSocketGateway({
  cors: {
    origin: allowedOrigins.length > 0 ? allowedOrigins : ['http://localhost:5173'],
    credentials: true,
  },
})
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(EventsGateway.name);

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  @SubscribeMessage('join:kds')
  handleJoinKds(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { restaurantSlug: string },
  ) {
    const room = `kds:${data.restaurantSlug || 'pangat'}`;
    client.join(room);
    this.logger.log(`Client ${client.id} joined ${room}`);
    return { status: 'joined', room };
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
    const room = `kds:${restaurantSlug || 'pangat'}`;
    this.server.to(room).emit('order:new', order);
    this.logger.log(`Emitted order:new to ${room} for order #${order.id}`);
  }

  emitOrderStatus(orderId: string, status: string, order: any) {
    const room = `order:${orderId}`;
    this.server.to(room).emit('order:status', { orderId, status, order });
    // Also emit to KDS
    if (order.restaurant?.slug) {
      this.server.to(`kds:${order.restaurant.slug}`).emit('order:status', { orderId, status, order });
    }
    this.logger.log(`Emitted order:status (${status}) for order #${orderId}`);
  }

  emitOrderPaid(orderId: string, order: any) {
    const room = `order:${orderId}`;
    this.server.to(room).emit('order:paid', { orderId, order });
    if (order.restaurant?.slug) {
      this.server.to(`kds:${order.restaurant.slug}`).emit('order:paid', { orderId, order });
    }
    this.logger.log(`Emitted order:paid for order #${orderId}`);
  }
}
