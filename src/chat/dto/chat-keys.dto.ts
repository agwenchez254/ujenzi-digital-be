import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsUUID, Min, ValidateNested } from 'class-validator';
import { KeyWrapDto } from '../../e2ee/dto/e2ee.dto';

// A conversation can have at most ~50 people with up to 10 devices each.
const MAX_WRAPS = 500;

export class PublishEpochDto {
  @ApiProperty({ description: 'Must be exactly the current epoch + 1 (1 for the first key)' })
  @IsInt()
  @Min(1)
  epoch!: number;

  @ApiProperty({ description: 'The sending device that generated the key; it must also receive a wrap' })
  @IsUUID()
  deviceId!: string;

  @ApiProperty({ type: [KeyWrapDto], description: 'The new epoch key encrypted for each recipient device' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_WRAPS)
  @ValidateNested({ each: true })
  @Type(() => KeyWrapDto)
  wraps!: KeyWrapDto[];
}

export class AddWrapsDto {
  @ApiProperty({ description: 'An existing epoch to share with more devices (new member, new device)' })
  @IsInt()
  @Min(1)
  epoch!: number;

  @ApiProperty({ type: [KeyWrapDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_WRAPS)
  @ValidateNested({ each: true })
  @Type(() => KeyWrapDto)
  wraps!: KeyWrapDto[];
}
