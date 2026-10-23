import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditLogService } from '../audit-log/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import { isValidP256PublicKey } from './e2ee.crypto';
import { PutKeyBackupDto, RegisterDeviceDto } from './dto/e2ee.dto';

const MAX_ACTIVE_DEVICES_PER_USER = 10;

const PUBLIC_DEVICE = {
  id: true,
  label: true,
  encryptionKey: true,
  signingKey: true,
  createdAt: true,
  revokedAt: true,
} as const;

/** Device registry and passphrase-protected key backup. Holds public keys and an opaque blob only. */
@Injectable()
export class E2eeService {
  constructor(
    private prisma: PrismaService,
    private auditLog: AuditLogService,
  ) {}

  async registerDevice(userId: string, dto: RegisterDeviceDto, ip?: string) {
    if (!isValidP256PublicKey(dto.encryptionKey) || !isValidP256PublicKey(dto.signingKey)) {
      throw new BadRequestException('Keys must be base64 SPKI NIST P-256 public keys');
    }
    if (dto.encryptionKey === dto.signingKey) {
      throw new BadRequestException('Encryption and signing keys must be different keys');
    }

    // Registering the same device again (e.g. after a retry) returns it unchanged.
    const existing = await this.prisma.userDevice.findUnique({
      where: { userId_encryptionKey: { userId, encryptionKey: dto.encryptionKey } },
      select: { ...PUBLIC_DEVICE, signingKey: true },
    });
    if (existing) {
      if (existing.signingKey !== dto.signingKey) {
        throw new ConflictException('This encryption key is already registered with a different signing key');
      }
      if (existing.revokedAt) throw new ConflictException('This device was revoked; generate new keys');
      return existing;
    }

    const active = await this.prisma.userDevice.count({ where: { userId, revokedAt: null } });
    if (active >= MAX_ACTIVE_DEVICES_PER_USER) {
      throw new BadRequestException(
        `You can have up to ${MAX_ACTIVE_DEVICES_PER_USER} active devices. Revoke one you no longer use.`,
      );
    }

    const device = await this.prisma.userDevice.create({
      data: { userId, label: dto.label.trim(), encryptionKey: dto.encryptionKey, signingKey: dto.signingKey },
      select: PUBLIC_DEVICE,
    });
    await this.auditLog.log(userId, 'e2ee.device_registered', 'UserDevice', device.id, { label: dto.label }, ip);
    return device;
  }

  listDevices(userId: string) {
    return this.prisma.userDevice.findMany({
      where: { userId },
      select: PUBLIC_DEVICE,
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Revoked devices can no longer send, and every conversation they hold a key for is
   * flagged for rotation, so the next message is encrypted under a key they never get.
   */
  async revokeDevice(userId: string, deviceId: string, ip?: string) {
    const device = await this.prisma.userDevice.findFirst({ where: { id: deviceId, userId } });
    if (!device) throw new NotFoundException('Device not found');
    if (!device.revokedAt) {
      await this.prisma.userDevice.update({ where: { id: deviceId }, data: { revokedAt: new Date() } });
      await this.auditLog.log(userId, 'e2ee.device_revoked', 'UserDevice', deviceId, { label: device.label }, ip);
    }
    return { ok: true };
  }

  async putBackup(userId: string, dto: PutKeyBackupDto, ip?: string) {
    const data = {
      blob: dto.blob,
      salt: dto.salt,
      kdf: dto.kdf as unknown as Prisma.InputJsonValue,
      version: dto.version ?? 1,
    };
    await this.prisma.keyBackup.upsert({ where: { userId }, create: { userId, ...data }, update: data });
    await this.auditLog.log(userId, 'e2ee.backup_updated', 'KeyBackup', userId, undefined, ip);
    return { ok: true };
  }

  async getBackup(userId: string, ip?: string) {
    const backup = await this.prisma.keyBackup.findUnique({ where: { userId } });
    if (!backup) throw new NotFoundException('No key backup');
    // Fetching the blob is what an attacker with a stolen session would do before
    // guessing the passphrase offline, so every fetch is on the record.
    await this.auditLog.log(userId, 'e2ee.backup_fetched', 'KeyBackup', userId, undefined, ip);
    return {
      blob: backup.blob,
      salt: backup.salt,
      kdf: backup.kdf,
      version: backup.version,
      updatedAt: backup.updatedAt,
    };
  }

  async deleteBackup(userId: string, ip?: string) {
    await this.prisma.keyBackup.deleteMany({ where: { userId } });
    await this.auditLog.log(userId, 'e2ee.backup_deleted', 'KeyBackup', userId, undefined, ip);
    return { ok: true };
  }
}
