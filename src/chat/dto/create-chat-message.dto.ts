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

  @ApiPropertyOptional({
    description:
      'Id generated on the sending device. Retrying a send with the same clientId (e.g. after reconnecting) returns the original message instead of posting a duplicate.',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  clientId?: string;
}
