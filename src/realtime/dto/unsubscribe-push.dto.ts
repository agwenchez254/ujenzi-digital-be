import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class UnsubscribePushDto {
  @ApiProperty()
  @IsString()
  endpoint: string;
}
