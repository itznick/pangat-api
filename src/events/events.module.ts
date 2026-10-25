import { Module, Global } from '@nestjs/common';
import { EventsGateway } from './events.gateway.js';

@Global()
@Module({
  providers: [EventsGateway],
  exports: [EventsGateway],
})
export class EventsModule {}
