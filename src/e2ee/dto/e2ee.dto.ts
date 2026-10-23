import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

const BASE64 = /^[A-Za-z0-9+/_-]+={0,2}$/;
const BASE64_MESSAGE = 'must be base64 encoded';

export class RegisterDeviceDto {
  @ApiProperty({ description: 'Human label, e.g. "Pixel 8" or "Chrome on laptop"', maxLength: 60 })
  @IsString()
  @MaxLength(60)
  label!: string;

  @ApiProperty({ description: 'base64 SPKI ECDH P-256 public key (receives wrapped conversation keys)' })
  @IsString()
  @MaxLength(256)
  @Matches(BASE64, { message: `encryptionKey ${BASE64_MESSAGE}` })
  encryptionKey!: string;

  @ApiProperty({ description: 'base64 SPKI ECDSA P-256 public key (verifies this device\'s signatures)' })
  @IsString()
  @MaxLength(256)
  @Matches(BASE64, { message: `signingKey ${BASE64_MESSAGE}` })
  signingKey!: string;
}

export class KdfParamsDto {
  @ApiProperty({ example: 'PBKDF2-SHA256' })
  @IsString()
  @MaxLength(32)
  algorithm!: string;

  @ApiProperty({ example: 600000 })
  @IsInt()
  @Min(1)
  iterations!: number;
}

export class PutKeyBackupDto {
  @ApiProperty({ description: 'base64 ciphertext of the private keys, encrypted on the device with the passphrase' })
  @IsString()
  @MaxLength(65536)
  @Matches(BASE64, { message: `blob ${BASE64_MESSAGE}` })
  blob!: string;

  @ApiProperty({ description: 'base64 KDF salt' })
  @IsString()
  @MaxLength(256)
  @Matches(BASE64, { message: `salt ${BASE64_MESSAGE}` })
  salt!: string;

  @ApiProperty({ type: KdfParamsDto })
  @IsObject()
  @ValidateNested()
  @Type(() => KdfParamsDto)
  kdf!: KdfParamsDto;

  @ApiPropertyOptional({ description: 'Backup format version' })
  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;
}

export class KeyWrapDto {
  @ApiProperty()
  @IsUUID()
  deviceId!: string;

  @ApiProperty({ description: 'base64: the epoch key encrypted for this device (AES-GCM)' })
  @IsString()
  @MaxLength(512)
  @Matches(BASE64, { message: `wrappedKey ${BASE64_MESSAGE}` })
  wrappedKey!: string;

  @ApiProperty({ description: 'base64 SPKI: the wrapper\'s ephemeral ECDH public key' })
  @IsString()
  @MaxLength(256)
  @Matches(BASE64, { message: `ephemeralKey ${BASE64_MESSAGE}` })
  ephemeralKey!: string;

  @ApiProperty({ description: 'base64 AES-GCM nonce' })
  @IsString()
  @MaxLength(64)
  @Matches(BASE64, { message: `iv ${BASE64_MESSAGE}` })
  iv!: string;
}
