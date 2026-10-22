import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RealtimeEventsService } from '../realtime/realtime-events.service';
import { ChatGateway } from './chat.gateway';
import { ChatService } from './chat.service';
import { CreateChatMessageDto } from './dto/create-chat-message.dto';

// Chat is chatty: well above the app-wide 20/min default, still bounded.
const CHAT_THROTTLE = { default: { limit: 120, ttl: 60_000 } };

@ApiTags('Chat')
@ApiBearerAuth()
@Throttle(CHAT_THROTTLE)
@Controller('chat')
export class ChatController {
  constructor(
    private chatService: ChatService,
    private chatGateway: ChatGateway,
    private realtimeEvents: RealtimeEventsService,
  ) {}

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
    return this.chatService.listMessages(channel, {
      before,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @ApiOperation({
    summary:
      'Post a message; it is pushed to everyone viewing the conversation',
  })
  @Post(':type/:id/messages')
  async send(
    @Param('type') type: string,
    @Param('id') id: string,
    @Body() dto: CreateChatMessageDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const channel = await this.chatService.resolveChannel(type, id, user);
    const message = await this.chatService.createMessage(channel, dto, user);
    this.chatGateway.emitMessage(message);
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
}
