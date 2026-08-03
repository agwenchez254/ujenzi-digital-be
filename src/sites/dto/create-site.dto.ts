import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsLatitude, IsLongitude, IsOptional, IsString, IsUUID, Min } from 'class-validator';

export class CreateSiteDto {
  @ApiProperty({ example: 'Riverside Towers' })
  @IsString()
  name: string;

  @ApiPropertyOptional({
    description:
      'Administrator only — the contractor to create this site for. Ignored/forbidden for contractor callers, who always create for themselves.',
  })
  @IsOptional()
  @IsUUID()
  contractorId?: string;

  @ApiProperty({ example: -1.2921 })
  @IsLatitude()
  latitude: number;

  @ApiProperty({ example: 36.8219 })
  @IsLongitude()
  longitude: number;

  @ApiPropertyOptional({
    example: 100,
    default: 100,
    description: 'Meters. Defaults to 100 in the database if omitted.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  geofenceRadius?: number;

  @ApiProperty({ example: '123 River Road, Nairobi' })
  @IsString()
  address: string;

  @ApiPropertyOptional({ example: 'Foundation' })
  @IsOptional()
  @IsString()
  constructionPhase?: string;
}
