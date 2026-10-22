import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateChatMessageDto {
  @ApiProperty({
    description: 'Plain-text message body (newlines allowed)',
    maxLength: 4000,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  body: string;

  @ApiPropertyOptional({
    description: 'Id of the message this one replies to (same channel)',
  })
  @IsOptional()
  @IsUUID()
  replyToId?: string;
}
