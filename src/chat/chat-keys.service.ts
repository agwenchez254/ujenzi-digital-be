import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { KeyWrapDto } from '../e2ee/dto/e2ee.dto';
import { verifyMessageSignature } from '../e2ee/e2ee.crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ChatService } from './chat.service';
import { ResolvedChannel } from './chat.types';
import { AddWrapsDto, PublishEpochDto } from './dto/chat-keys.dto';
import { CreateChatMessageDto } from './dto/create-chat-message.dto';

export interface KeyStatus {
  /** The conversation only accepts encrypted messages. */
  encrypted: boolean;
  /** Current key generation; 0 until someone publishes the first key. */
  epoch: number;
  /** Someone who should no longer read new messages still holds the current key. */
  rotationRequired: boolean;
  /** Active devices of current members that have no copy of the current key yet. */
  missingDevices: { deviceId: string; userId: string }[];
  /** Members with no registered device: they cannot read encrypted messages at all. */
  membersWithoutDevices: string[];
}

/** Errors the client reacts to carry a stable machine-readable `error` code. */
const conflict = (code: string, message: string) => new ConflictException({ message, error: code });

/**
 * Server side of the conversation-key protocol (see docs/e2ee.md). The server is a
 * directory and a gatekeeper: it never sees a conversation key or any plaintext, but it
 * refuses messages that are unsigned, forged, from the wrong device, or encrypted under a
 * key someone who has since left still holds.
 */
@Injectable()
export class ChatKeysService {
  constructor(
    private prisma: PrismaService,
    private chat: ChatService,
  ) {}

  /** Current epoch, whether it needs rotating, and who still needs a copy of it. */
  async getStatus(channel: ResolvedChannel): Promise<KeyStatus> {
    const [participantIds, latest, encrypted] = await Promise.all([
      this.chat.getParticipantIds(channel),
      this.prisma.chatKeyEpoch.findFirst({
        where: { channelKey: channel.room },
        orderBy: { epoch: 'desc' },
        include: { wraps: { select: { deviceId: true } } },
      }),
      this.chat.isEncryptedChannel(channel.room),
    ]);
    const devices = await this.activeDevicesOf(participantIds);
    const withDevices = new Set(devices.map((d) => d.userId));
    const membersWithoutDevices = participantIds.filter((id) => !withDevices.has(id));

    if (!latest) {
      return { encrypted, epoch: 0, rotationRequired: false, missingDevices: [], membersWithoutDevices };
    }
    const wrapped = new Set(latest.wraps.map((w) => w.deviceId));
    const allowed = new Set(devices.map((d) => d.id));
    return {
      encrypted,
      epoch: latest.epoch,
      // A wrap for a device that is revoked or belongs to someone no longer in the conversation.
      rotationRequired: [...wrapped].some((id) => !allowed.has(id)),
      missingDevices: devices
        .filter((d) => !wrapped.has(d.id))
        .map((d) => ({ deviceId: d.id, userId: d.userId })),
      membersWithoutDevices,
    };
  }

  async statusFor(channel: ResolvedChannel, user: AuthenticatedUser): Promise<KeyStatus> {
    await this.assertMember(channel, user);
    return this.getStatus(channel);
  }

  /** Public keys needed to wrap keys for members and to verify who signed which message. */
  async getDirectory(channel: ResolvedChannel, user: AuthenticatedUser) {
    const participantIds = await this.assertMember(channel, user);
    // Former members' devices too: their old messages still need verifying.
    const signers = await this.prisma.chatMessage.findMany({
      where: {
        siteId: channel.siteId,
        inspectionId: channel.inspectionId,
        encrypted: true,
        senderDeviceId: { not: null },
      },
      distinct: ['senderDeviceId'],
      select: { senderDeviceId: true },
    });
    const devices = await this.prisma.userDevice.findMany({
      where: {
        OR: [
          { userId: { in: participantIds } },
          { id: { in: signers.map((s) => s.senderDeviceId as string) } },
        ],
      },
      select: {
        id: true,
        userId: true,
        label: true,
        encryptionKey: true,
        signingKey: true,
        revokedAt: true,
      },
    });
    return devices.map(({ revokedAt, ...device }) => ({
      ...device,
      revoked: !!revokedAt,
      member: participantIds.includes(device.userId),
    }));
  }

  /** The copies of the conversation key addressed to this user's devices, every epoch. */
  async getMine(channel: ResolvedChannel, user: AuthenticatedUser) {
    await this.assertMember(channel, user);
    const wraps = await this.prisma.chatKeyWrap.findMany({
      where: {
        epoch: { channelKey: channel.room },
        device: { userId: user.userId, revokedAt: null },
      },
      include: { epoch: { select: { epoch: true, createdByDeviceId: true } } },
      orderBy: { epoch: { epoch: 'asc' } },
    });
    return wraps.map((w) => ({
      epoch: w.epoch.epoch,
      createdByDeviceId: w.epoch.createdByDeviceId,
      deviceId: w.deviceId,
      wrappedKey: w.wrappedKey,
      ephemeralKey: w.ephemeralKey,
      iv: w.iv,
    }));
  }

  /** A member publishes the next key generation, already encrypted for each recipient device. */
  async publishEpoch(channel: ResolvedChannel, user: AuthenticatedUser, dto: PublishEpochDto) {
    const participantIds = await this.assertMember(channel, user);
    const creator = await this.prisma.userDevice.findFirst({
      where: { id: dto.deviceId, userId: user.userId, revokedAt: null },
      select: { id: true },
    });
    if (!creator) throw new ForbiddenException('That device is not yours or has been revoked');

    const current = await this.currentEpoch(channel.room);
    if (dto.epoch !== current + 1) {
      throw conflict('STALE_KEY_EPOCH', `The current epoch is ${current}; the next one must be ${current + 1}`);
    }
    await this.assertWrapsAllowed(dto.wraps, participantIds);
    if (!dto.wraps.some((w) => w.deviceId === creator.id)) {
      throw new BadRequestException('The publishing device must receive a copy of the key too');
    }

    try {
      await this.prisma.chatKeyEpoch.create({
        data: {
          channelKey: channel.room,
          epoch: dto.epoch,
          createdByDeviceId: creator.id,
          wraps: { create: dto.wraps.map((w) => this.wrapData(w)) },
        },
      });
    } catch (error) {
      // Two members rotating at once: the loser must fetch the winner's epoch and retry.
      if ((error as { code?: string })?.code === 'P2002') {
        throw conflict('STALE_KEY_EPOCH', 'Another member already published that epoch');
      }
      throw error;
    }
    return { epoch: dto.epoch };
  }

  /** Share an existing epoch (a new member, a new device, history for a restored device). */
  async addWraps(channel: ResolvedChannel, user: AuthenticatedUser, dto: AddWrapsDto) {
    const participantIds = await this.assertMember(channel, user);
    const epoch = await this.prisma.chatKeyEpoch.findUnique({
      where: { channelKey_epoch: { channelKey: channel.room, epoch: dto.epoch } },
      select: { id: true },
    });
    if (!epoch) throw new NotFoundException('That key epoch does not exist');
    await this.assertWrapsAllowed(dto.wraps, participantIds);

    const result = await this.prisma.chatKeyWrap.createMany({
      data: dto.wraps.map((w) => ({ epochId: epoch.id, ...this.wrapData(w) })),
      skipDuplicates: true,
    });
    return { added: result.count };
  }

  /**
   * Gate for sending. Plaintext is refused once a conversation is encrypted (no
   * downgrade), and an encrypted message must be signed by one of the sender's own
   * active devices, under the current key, in a conversation they are a member of.
   */
  async checkSend(channel: ResolvedChannel, user: AuthenticatedUser, dto: CreateChatMessageDto): Promise<void> {
    const encryptedChannel = await this.chat.isEncryptedChannel(channel.room);
    const supplied = !!dto.ciphertext;

    if (!supplied) {
      if (encryptedChannel) {
        throw new BadRequestException(
          'This conversation is end-to-end encrypted. Messages must be encrypted on your device.',
        );
      }
      return; // plaintext still allowed until the conversation is encrypted
    }

    if (dto.body?.trim()) {
      throw new BadRequestException('Encrypted messages must not include a plaintext body');
    }
    if (!dto.iv || !dto.keyEpoch || !dto.senderDeviceId || !dto.signature || !dto.clientId) {
      throw new BadRequestException(
        'Encrypted messages need ciphertext, iv, keyEpoch, senderDeviceId, signature and clientId',
      );
    }
    await this.assertMember(channel, user);

    const status = await this.getStatus(channel);
    if (status.epoch === 0) {
      throw conflict('KEYS_NOT_INITIALISED', 'No conversation key yet: publish one first');
    }
    if (status.rotationRequired) {
      throw conflict('KEY_ROTATION_REQUIRED', 'Someone who left still holds the key: rotate it before sending');
    }
    if (dto.keyEpoch !== status.epoch) {
      throw conflict('STALE_KEY_EPOCH', `Encrypt under the current epoch (${status.epoch})`);
    }

    const device = await this.prisma.userDevice.findFirst({
      where: { id: dto.senderDeviceId, userId: user.userId, revokedAt: null },
      select: { signingKey: true },
    });
    if (!device) throw new ForbiddenException('Unknown or revoked device');

    const valid = verifyMessageSignature(
      device.signingKey,
      {
        channelKey: channel.room,
        keyEpoch: dto.keyEpoch,
        clientId: dto.clientId,
        authorId: user.userId,
        senderDeviceId: dto.senderDeviceId,
        iv: dto.iv,
        ciphertext: dto.ciphertext as string,
      },
      dto.signature,
    );
    if (!valid) throw new ForbiddenException('Message signature is invalid');
  }

  private wrapData(w: KeyWrapDto) {
    return { deviceId: w.deviceId, wrappedKey: w.wrappedKey, ephemeralKey: w.ephemeralKey, iv: w.iv };
  }

  /** Keys may only be wrapped for active devices of people in the conversation, once each. */
  private async assertWrapsAllowed(wraps: KeyWrapDto[], participantIds: string[]) {
    const ids = wraps.map((w) => w.deviceId);
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException('Each device may appear only once');
    }
    const allowed = new Set((await this.activeDevicesOf(participantIds)).map((d) => d.id));
    const stranger = ids.find((id) => !allowed.has(id));
    if (stranger) {
      throw new BadRequestException(
        `Device ${stranger} is not an active device of a member of this conversation`,
      );
    }
  }

  private activeDevicesOf(userIds: string[]) {
    return this.prisma.userDevice.findMany({
      where: { userId: { in: userIds }, revokedAt: null },
      select: { id: true, userId: true },
    });
  }

  private async currentEpoch(room: string): Promise<number> {
    const latest = await this.prisma.chatKeyEpoch.findFirst({
      where: { channelKey: room },
      orderBy: { epoch: 'desc' },
      select: { epoch: true },
    });
    return latest?.epoch ?? 0;
  }

  /** Key material is for actual members only, whatever else the user's role allows. */
  private async assertMember(channel: ResolvedChannel, user: AuthenticatedUser): Promise<string[]> {
    const participantIds = await this.chat.getParticipantIds(channel);
    if (!participantIds.includes(user.userId)) {
      throw new ForbiddenException('Only members of this conversation can use its keys');
    }
    return participantIds;
  }
}
