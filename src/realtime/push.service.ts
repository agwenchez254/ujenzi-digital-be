import { Injectable, Logger } from '@nestjs/common';
import { PushSubscription } from '@prisma/client';
import * as webpush from 'web-push';
import { PrismaService } from '../prisma/prisma.service';
import { isAllowedPushEndpoint } from './push-endpoint-allowlist';

export interface PushContent {
  title: string;
  body: string;
  url?: string;
}

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);

  constructor(private prisma: PrismaService) {
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT!,
      process.env.VAPID_PUBLIC_KEY!,
      process.env.VAPID_PRIVATE_KEY!,
    );
  }

  async send(subscription: PushSubscription, content: PushContent): Promise<void> {
    // Defense-in-depth: re-validate even though SubscribePushDto already checks this at
    // subscribe time, in case a row was ever created through another path.
    if (!isAllowedPushEndpoint(subscription.endpoint)) {
      this.logger.warn(`Refusing to send push to disallowed endpoint host for subscription ${subscription.id}`);
      return;
    }

    try {
      await webpush.sendNotification(
        { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
        JSON.stringify(content),
      );
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      if (statusCode === 404 || statusCode === 410) {
        await this.prisma.pushSubscription.delete({ where: { id: subscription.id } }).catch(() => undefined);
      } else {
        this.logger.warn(`Push send failed for subscription ${subscription.id}: ${String(error)}`);
      }
    }
  }
}
