import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsLatitude, IsLongitude, IsOptional, IsString } from 'class-validator';

export class UploadMediaDto {
  @ApiProperty({ example: -1.2921, description: 'Where the photo/video was captured.' })
  @Type(() => Number)
  @IsLatitude()
  latitude: number;

  @ApiProperty({ example: 36.8219 })
  @Type(() => Number)
  @IsLongitude()
  longitude: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  caption?: string;
}
