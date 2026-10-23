import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Res,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import type { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RealtimeEventsService } from '../realtime/realtime-events.service';
import { ChatGateway } from './chat.gateway';
import { ChatKeysService } from './chat-keys.service';
import { ChatService, NOTIFICATION_PREVIEW_LENGTH } from './chat.service';
import {
  CHAT_INLINE_IMAGE_TYPES,
  CHAT_MAX_FILES,
  CHAT_MAX_FILE_BYTES,
  type ChatMessageView,
  type ResolvedChannel,
} from './chat.types';
import { CreateChatMessageDto } from './dto/create-chat-message.dto';
import { MarkReadDto } from './dto/mark-read.dto';

// Chat is chatty: well above the app-wide 20/min default, still bounded.
const CHAT_THROTTLE = { default: { limit: 120, ttl: 60_000 } };

// Type and size are checked again in ChatService; the interceptor limit stops
// an oversized upload from being buffered at all.
const chatFilesInterceptor = () =>
  FilesInterceptor('files', CHAT_MAX_FILES, {
    limits: { fileSize: CHAT_MAX_FILE_BYTES },
  });

@ApiTags('Chat')
@ApiBearerAuth()
@Throttle(CHAT_THROTTLE)
@Controller('chat')
export class ChatController {
  constructor(
    private chatService: ChatService,
    private chatGateway: ChatGateway,
    private realtimeEvents: RealtimeEventsService,
    private chatKeys: ChatKeysService,
  ) {}

  // Declared before the :type routes so "attachments" is never read as a channel type.
  @ApiOperation({
    summary: 'Download a chat attachment (anyone who can see the conversation)',
  })
  @Get('attachments/:id')
  async attachment(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Res() res: Response,
  ) {
    const { stream, fileName, mimeType, size } =
      await this.chatService.getAttachment(id, user);
    const inline = CHAT_INLINE_IMAGE_TYPES.includes(mimeType);

    res.set({
      'Content-Type': mimeType,
      'Content-Length': String(size),
      // Only raster images render in the page; every other type downloads.
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      'X-Content-Type-Options': 'nosniff',
      // Even if something active slipped through, the browser may not run it.
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, max-age=3600',
    });
    stream.on('error', () => {
      if (!res.headersSent) {
        res.status(404).json({
          statusCode: 404,
          message: 'File not found',
          error: 'Not Found',
        });
      }
    });
    stream.pipe(res);
  }

  @ApiOperation({
    summary:
      'Recent messages in a site group chat or an inspection discussion (oldest first)',
  })
  @Get(':type/:id/messages')
  async messages(
    @Param('type') type: string,
    @Param('id') id: string,
    @Query('before') before: string | undefined,
    @Query('limit') limit: string | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const channel = await this.chatService.resolveChannel(type, id, user);
    const messages = await this.chatService.listMessages(channel, {
      before,
      limit: limit ? Number(limit) : undefined,
      viewerId: user.userId,
    });
    // Loading the latest page means these were seen, so they are not replayed
    // as backlog later. Paging back through older history says nothing new.
    if (!before && messages.length) {
      await this.chatService
        .markDelivered([user.userId], messages)
        .catch(() => undefined);
    }
    return messages;
  }

  @ApiOperation({
    summary:
      'Mark the conversation as read up to a message (turns the sender\'s ticks blue)',
  })
  @Post(':type/:id/read')
  async markRead(
    @Param('type') type: string,
    @Param('id') id: string,
    @Body() dto: MarkReadDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const channel = await this.chatService.resolveChannel(type, id, user);
    await this.chatService.markRead(channel, dto.messageId, user.userId);
    return { ok: true };
  }

  @ApiOperation({
    summary:
      'Who has received and read one of your messages (sender or administrator only)',
  })
  @Get(':type/:id/messages/:messageId/receipts')
  async receipts(
    @Param('type') type: string,
    @Param('id') id: string,
    @Param('messageId') messageId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const channel = await this.chatService.resolveChannel(type, id, user);
    return this.chatService.getMessageReceipts(channel, messageId, user);
  }

  @ApiOperation({
    summary:
      'Post a message, optionally with images or documents; it is pushed to everyone viewing the conversation',
  })
  @ApiConsumes('application/json', 'multipart/form-data')
  @UseInterceptors(chatFilesInterceptor())
  @Post(':type/:id/messages')
  async send(
    @Param('type') type: string,
    @Param('id') id: string,
    @Body() dto: CreateChatMessageDto,
    @UploadedFiles() files: Express.Multer.File[] | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const channel = await this.chatService.resolveChannel(type, id, user);

    // A message queued while the sender was offline is retried with the same
    // clientId; if the first attempt actually landed, hand back that message
    // instead of posting (and notifying everyone about) a duplicate.
    if (dto.clientId) {
      const existing = await this.chatService.findByClientId(
        channel,
        user.userId,
        dto.clientId,
      );
      if (existing) return existing;
    }

    // Encrypted messages must be signed by the sender's device, under the current key.
    await this.chatKeys.checkSend(channel, user, dto);

    let message: ChatMessageView;
    try {
      message = await this.chatService.createMessage(
        channel,
        dto,
        user,
        files ?? [],
      );
    } catch (error) {
      // Two retries racing: the loser trips the (author, clientId) unique index.
      if (dto.clientId && (error as { code?: string })?.code === 'P2002') {
        const existing = await this.chatService.findByClientId(
          channel,
          user.userId,
          dto.clientId,
        );
        if (existing) return existing;
      }
      throw error;
    }
    this.chatGateway.emitMessage(message);
    await this.chatGateway.trackDelivery(message);
    await this.notifyRecipients(channel, message, user.userId);
    return message;
  }

  @ApiOperation({
    summary:
      'People involved in the project (or inspection) with their online status',
  })
  @Get(':type/:id/members')
  async members(
    @Param('type') type: string,
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const channel = await this.chatService.resolveChannel(type, id, user);
    return this.chatService.listMembers(channel, (userId) =>
      this.realtimeEvents.isOnline(userId),
    );
  }

  /**
   * Puts the message in everyone else's notification centre (and sends a push to
   * those offline). A failure here must not fail the send: the message is saved.
   */
  private async notifyRecipients(
    channel: ResolvedChannel,
    message: ChatMessageView,
    authorId: string,
  ): Promise<void> {
    try {
      const [members, target] = await Promise.all([
        this.chatService.listMembers(channel, (userId) =>
          this.realtimeEvents.isOnline(userId),
        ),
        this.chatService.getNotificationTarget(channel),
      ]);
      // The server cannot read an encrypted message, so notifications (and the push
      // services they pass through) carry no text.
      const excerpt = message.e2ee
        ? 'Sent a message'
        : message.body.slice(0, NOTIFICATION_PREVIEW_LENGTH) ||
        (message.attachments.length === 1
          ? 'Sent an attachment'
          : `Sent ${message.attachments.length} attachments`);
      await this.realtimeEvents.emit(
        'notification.chat',
        { channelType: message.channelType, channelId: message.channelId },
        {
          userIds: members.map((m) => m.id).filter((id) => id !== authorId),
          excludeUserIds: [authorId],
        },
        {
          title: `${message.author.name} in ${target.label}`,
          body: excerpt,
          url: target.link,
        },
      );
    } catch {
      // Best effort only.
    }
  }
}
