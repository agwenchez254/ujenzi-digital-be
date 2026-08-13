import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SubscribePushDto } from './dto/subscribe-push.dto';
import { UnsubscribePushDto } from './dto/unsubscribe-push.dto';

@Injectable()
export class PushSubscriptionsService {
  constructor(private prisma: PrismaService) {}

  async subscribe(userId: string, dto: SubscribePushDto): Promise<void> {
    await this.prisma.pushSubscription.upsert({
      where: { endpoint: dto.endpoint },
      create: { userId, endpoint: dto.endpoint, p256dh: dto.keys.p256dh, auth: dto.keys.auth },
      update: { userId, p256dh: dto.keys.p256dh, auth: dto.keys.auth },
    });
  }

  async unsubscribe(dto: UnsubscribePushDto): Promise<void> {
    await this.prisma.pushSubscription.deleteMany({ where: { endpoint: dto.endpoint } });
  }

  getVapidPublicKey(): { publicKey: string | undefined } {
    return { publicKey: process.env.VAPID_PUBLIC_KEY };
  }
}
