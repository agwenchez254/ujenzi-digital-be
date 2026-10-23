import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Matches, MaxLength, Min } from 'class-validator';

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
  @Matches(/^[A-Za-z0-9_-]+$/, { message: 'clientId may only contain letters, digits, - and _' })
  clientId?: string;

  // --- End-to-end encrypted messages. Sent instead of `body`; all must be present together. ---

  @ApiPropertyOptional({
    description: 'base64 AES-256-GCM ciphertext of the message content. Present only for encrypted messages (omit `body`).',
    maxLength: 16384,
  })
  @IsOptional()
  @IsString()
  @MaxLength(16384)
  @Matches(/^[A-Za-z0-9+/_-]+={0,2}$/, { message: 'ciphertext must be base64 encoded' })
  ciphertext?: string;

  @ApiPropertyOptional({ description: 'base64 AES-GCM nonce (12 bytes)' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^[A-Za-z0-9+/_-]+={0,2}$/, { message: 'iv must be base64 encoded' })
  iv?: string;

  @ApiPropertyOptional({ description: 'Conversation key epoch the message is encrypted under (must be the current one)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  keyEpoch?: number;

  @ApiPropertyOptional({ description: 'The device that encrypted and signed the message (must be yours)' })
  @IsOptional()
  @IsUUID()
  senderDeviceId?: string;

  @ApiPropertyOptional({
    description:
      'base64 ECDSA P-256 signature (raw r||s) over "ujenzi-e2ee-v1|channel|epoch|clientId|authorId|deviceId|iv|ciphertext"',
  })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  @Matches(/^[A-Za-z0-9+/_-]+={0,2}$/, { message: 'signature must be base64 encoded' })
  signature?: string;
}
