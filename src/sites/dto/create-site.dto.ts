import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DevelopmentType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { SiteApprovalsDto } from './site-approvals.dto';
import { SitePersonnelInputDto } from './site-personnel-input.dto';

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
    example: 500,
    default: 500,
    description: 'Meters. Defaults to 500 in the database if omitted.',
  })
  @IsOptional()
  @IsInt()
  @Min(50)
  @Max(2000)
  geofenceRadius?: number;

  @ApiProperty({ example: '123 River Road, Nairobi' })
  @IsString()
  address: string;

  @ApiPropertyOptional({ example: 'Foundation' })
  @IsOptional()
  @IsString()
  constructionPhase?: string;

  @ApiPropertyOptional({ enum: DevelopmentType })
  @IsOptional()
  @IsEnum(DevelopmentType)
  developmentType?: DevelopmentType;

  @ApiPropertyOptional({ example: 'Kenya' })
  @IsOptional()
  @IsString()
  country?: string;

  @ApiPropertyOptional({ example: 'Nairobi' })
  @IsOptional()
  @IsString()
  county?: string;

  @ApiPropertyOptional({ example: 'Westlands' })
  @IsOptional()
  @IsString()
  constituency?: string;

  @ApiPropertyOptional({ example: 'Nairobi' })
  @IsOptional()
  @IsString()
  town?: string;

  @ApiPropertyOptional({ example: 'LR 209/1234' })
  @IsOptional()
  @IsString()
  plotNumber?: string;

  @ApiPropertyOptional({ type: [String], example: ['Near Sarit Centre'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  landmarks?: string[];

  @ApiPropertyOptional({ type: SiteApprovalsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => SiteApprovalsDto)
  approvals?: SiteApprovalsDto;

  @ApiPropertyOptional({
    type: [SitePersonnelInputDto],
    description: 'Replaces the entire personnel roster — there is no item-level merge.',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SitePersonnelInputDto)
  personnel?: SitePersonnelInputDto[];
}
