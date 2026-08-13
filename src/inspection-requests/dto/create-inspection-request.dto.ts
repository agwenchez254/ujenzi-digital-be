import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsString, IsUUID } from 'class-validator';

export class CreateInspectionRequestDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  siteId: string;

  @ApiProperty({ example: '2026-08-10' })
  @IsDateString()
  requestedDate: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}
