import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class SetPublicSharingDto {
  @ApiProperty()
  @IsBoolean()
  enabled: boolean;
}
