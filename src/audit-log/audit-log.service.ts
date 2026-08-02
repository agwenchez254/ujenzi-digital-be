import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QueryAuditLogDto } from './dto/query-audit-log.dto';

@Injectable()
export class AuditLogService {
  constructor(private prisma: PrismaService) {}

  async log(
    userId: string | null,
    action: string,
    entityType: string,
    entityId: string | null,
    details?: Prisma.InputJsonValue,
    ipAddress?: string,
  ): Promise<void> {
    await this.prisma.auditLog.create({
      data: { userId, action, entityType, entityId, details, ipAddress },
    });
  }

  findMany(query: QueryAuditLogDto) {
    const where: Prisma.AuditLogWhereInput = {
      entityType: query.entityType,
      userId: query.userId,
      createdAt: {
        gte: query.dateFrom ? new Date(query.dateFrom) : undefined,
        lte: query.dateTo ? new Date(query.dateTo) : undefined,
      },
    };

    return this.prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: query.skip ?? 0,
      take: query.take ?? 50,
    });
  }
}
