import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsString, Validate, ValidateNested, ValidatorConstraint, ValidatorConstraintInterface } from 'class-validator';
import { isAllowedPushEndpoint } from '../push-endpoint-allowlist';

@ValidatorConstraint({ name: 'isAllowedPushEndpoint' })
class IsAllowedPushEndpointConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && isAllowedPushEndpoint(value);
  }

  defaultMessage(): string {
    return 'endpoint must be an https URL from a known push service (FCM, Mozilla, WNS, or Apple)';
  }
}

class PushKeysDto {
  @ApiProperty()
  @IsString()
  p256dh: string;

  @ApiProperty()
  @IsString()
  auth: string;
}

export class SubscribePushDto {
  @ApiProperty()
  @IsString()
  @Validate(IsAllowedPushEndpointConstraint)
  endpoint: string;

  @ApiProperty({ type: PushKeysDto })
  @ValidateNested()
  @Type(() => PushKeysDto)
  keys: PushKeysDto;
}
