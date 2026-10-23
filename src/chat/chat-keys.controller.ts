import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ChatGateway } from './chat.gateway';
import { ChatService } from './chat.service';
import { ChatKeysService } from './chat-keys.service';
import { AddWrapsDto, PublishEpochDto } from './dto/chat-keys.dto';

@ApiTags('Chat encryption keys')
@ApiBearerAuth()
@Throttle({ default: { limit: 60, ttl: 60_000 } })
@Controller('chat')
export class ChatKeysController {
  constructor(
    private chat: ChatService,
    private keys: ChatKeysService,
    private gateway: ChatGateway,
  ) {}

  @ApiOperation({ summary: 'Key state of a conversation: current epoch, rotation needed, devices missing a key' })
  @Get(':type/:id/keys/status')
  async status(
    @Param('type') type: string,
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const channel = await this.chat.resolveChannel(type, id, user);
    return this.keys.statusFor(channel, user);
  }

  @ApiOperation({ summary: 'Members\' device public keys, for wrapping conversation keys and verifying signatures' })
  @Get(':type/:id/keys/directory')
  async directory(
    @Param('type') type: string,
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const channel = await this.chat.resolveChannel(type, id, user);
    return this.keys.getDirectory(channel, user);
  }

  @ApiOperation({ summary: 'Copies of the conversation key addressed to your devices (all epochs)' })
  @Get(':type/:id/keys/mine')
  async mine(
    @Param('type') type: string,
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const channel = await this.chat.resolveChannel(type, id, user);
    return this.keys.getMine(channel, user);
  }

  @ApiOperation({ summary: 'Publish the next conversation key epoch, wrapped for each member device' })
  @Post(':type/:id/keys/epochs')
  async publish(
    @Param('type') type: string,
    @Param('id') id: string,
    @Body() dto: PublishEpochDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const channel = await this.chat.resolveChannel(type, id, user);
    const result = await this.keys.publishEpoch(channel, user, dto);
    this.gateway.emitKeysChanged(channel, result.epoch);
    return result;
  }

  @ApiOperation({ summary: 'Share an existing epoch with more member devices (new member, new device)' })
  @Post(':type/:id/keys/wraps')
  async addWraps(
    @Param('type') type: string,
    @Param('id') id: string,
    @Body() dto: AddWrapsDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const channel = await this.chat.resolveChannel(type, id, user);
    const result = await this.keys.addWraps(channel, user, dto);
    this.gateway.emitKeysChanged(channel, dto.epoch);
    return result;
  }
}
