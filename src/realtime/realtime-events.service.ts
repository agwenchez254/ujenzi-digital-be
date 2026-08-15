import { Injectable } from '@nestjs/common';
import { AppRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PushContent, PushService } from './push.service';
import { RealtimeGateway } from './realtime.gateway';

export interface RealtimeTargets {
  siteIds?: string[];
  roles?: AppRole[];
  userIds?: string[];
}

@Injectable()
export class RealtimeEventsService {
  constructor(
    private gateway: RealtimeGateway,
    private prisma: PrismaService,
    private pushService: PushService,
  ) {}

  async emit(event: string, payload: unknown, targets: RealtimeTargets, push: PushContent): Promise<void> {
    const rooms = [
      ...(targets.siteIds ?? []).map((id) => `site:${id}`),
      ...(targets.roles ?? []).map((role) => `role:${role}`),
      ...(targets.userIds ?? []).map((id) => `user:${id}`),
    ];
    if (rooms.length) {
      this.gateway.server.to(rooms).emit(event, payload);
    }

    const userIds = await this.resolveUserIds(targets);

    // Administrators see every notification regardless of who the event was
    // actually targeted at — added here rather than at each call site so
    // every current and future emit() call gets this for free.
    const admins = await this.prisma.userRole.findMany({
      where: { role: 'administrator' },
      select: { userId: true },
    });
    const recipientIds = new Set([...userIds, ...admins.map((a) => a.userId)]);

    if (recipientIds.size) {
      await this.prisma.notification.createMany({
        data: [...recipientIds].map((userId) => ({
          userId,
          type: event,
          title: push.title,
          body: push.body,
          link: push.url,
        })),
      });
    }

    await Promise.all(userIds.map((userId) => this.notifyIfOffline(userId, push)));
  }

  private async resolveUserIds(targets: RealtimeTargets): Promise<string[]> {
    const ids = new Set<string>(targets.userIds ?? []);

    if (targets.siteIds?.length) {
      const [personnel, sites] = await Promise.all([
        this.prisma.sitePersonnel.findMany({
          where: { siteId: { in: targets.siteIds }, userId: { not: null } },
          select: { userId: true },
        }),
        this.prisma.site.findMany({
          where: { id: { in: targets.siteIds } },
          select: { contractorId: true },
        }),
      ]);
      personnel.forEach((p) => p.userId && ids.add(p.userId));
      sites.forEach((s) => ids.add(s.contractorId));
    }

    if (targets.roles?.length) {
      const usersWithRole = await this.prisma.userRole.findMany({
        where: { role: { in: targets.roles } },
        select: { userId: true },
      });
      usersWithRole.forEach((u) => ids.add(u.userId));
    }

    return [...ids];
  }

  private isOnline(userId: string): boolean {
    const room = this.gateway.server.sockets.adapter.rooms.get(`user:${userId}`);
    return !!room && room.size > 0;
  }

  private async notifyIfOffline(userId: string, push: PushContent): Promise<void> {
    if (this.isOnline(userId)) {
      return;
    }
    const subscriptions = await this.prisma.pushSubscription.findMany({ where: { userId } });
    await Promise.all(subscriptions.map((sub) => this.pushService.send(sub, push)));
  }
}
