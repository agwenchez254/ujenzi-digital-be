import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsString, ValidateNested } from 'class-validator';

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
  endpoint: string;

  @ApiProperty({ type: PushKeysDto })
  @ValidateNested()
  @Type(() => PushKeysDto)
  keys: PushKeysDto;
}
