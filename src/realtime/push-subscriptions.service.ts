import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SubscribePushDto } from './dto/subscribe-push.dto';
import { UnsubscribePushDto } from './dto/unsubscribe-push.dto';

@Injectable()
export class PushSubscriptionsService {
  constructor(private prisma: PrismaService) {}

  async subscribe(userId: string, dto: SubscribePushDto): Promise<void> {
    const existing = await this.prisma.pushSubscription.findUnique({ where: { endpoint: dto.endpoint } });
    if (existing && existing.userId !== userId) {
      throw new ForbiddenException('This push subscription endpoint belongs to another user');
    }

    await this.prisma.pushSubscription.upsert({
      where: { endpoint: dto.endpoint },
      create: { userId, endpoint: dto.endpoint, p256dh: dto.keys.p256dh, auth: dto.keys.auth },
      update: { p256dh: dto.keys.p256dh, auth: dto.keys.auth },
    });
  }

  async unsubscribe(userId: string, dto: UnsubscribePushDto): Promise<void> {
    await this.prisma.pushSubscription.deleteMany({ where: { endpoint: dto.endpoint, userId } });
  }

  getVapidPublicKey(): { publicKey: string | undefined } {
    return { publicKey: process.env.VAPID_PUBLIC_KEY };
  }
}
