import { Body, Controller, Delete, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { SubscribePushDto } from './dto/subscribe-push.dto';
import { UnsubscribePushDto } from './dto/unsubscribe-push.dto';
import { PushSubscriptionsService } from './push-subscriptions.service';

@ApiTags('Push')
@Controller('push')
export class PushSubscriptionsController {
  constructor(private pushSubscriptionsService: PushSubscriptionsService) {}

  @ApiOperation({ summary: 'Get the VAPID public key needed to create a push subscription' })
  @Public()
  @Get('vapid-public-key')
  getVapidPublicKey() {
    return this.pushSubscriptionsService.getVapidPublicKey();
  }

  @ApiOperation({ summary: 'Register a push subscription for the current user' })
  @ApiBearerAuth()
  @Post('subscribe')
  subscribe(@Body() dto: SubscribePushDto, @CurrentUser() user: AuthenticatedUser) {
    return this.pushSubscriptionsService.subscribe(user.userId, dto);
  }

  @ApiOperation({ summary: 'Remove a push subscription (e.g. on logout)' })
  @ApiBearerAuth()
  @Delete('subscribe')
  unsubscribe(@Body() dto: UnsubscribePushDto) {
    return this.pushSubscriptionsService.unsubscribe(dto);
  }
}
