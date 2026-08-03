import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsString, IsUUID } from 'class-validator';

export class CreateInspectionRequestDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  siteId: string;

  @ApiPropertyOptional({
    description:
      'Administrator only — the contractor to create this request for. Ignored/forbidden for contractor callers, who always create for themselves.',
  })
  @IsOptional()
  @IsUUID()
  contractorId?: string;

  @ApiProperty({ example: '2026-08-10' })
  @IsDateString()
  requestedDate: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}
