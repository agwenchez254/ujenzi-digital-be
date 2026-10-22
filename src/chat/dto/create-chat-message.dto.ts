import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class CreateChatMessageDto {
  @ApiPropertyOptional({
    description:
      'Plain-text message body (newlines allowed). May be empty when files are attached.',
    maxLength: 4000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  body?: string;

  @ApiPropertyOptional({
    description: 'Id of the message this one replies to (same channel)',
  })
  @IsOptional()
  @IsUUID()
  replyToId?: string;
}
