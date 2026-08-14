import { ApiPropertyOptional } from '@nestjs/swagger';
import { RiskLevel } from '@prisma/client';
import { IsEnum, IsObject, IsOptional } from 'class-validator';

export class UpdateInspectionDto {
  @ApiPropertyOptional({ description: 'Tiptap/ProseMirror JSON document.' })
  @IsOptional()
  @IsObject()
  notes?: Record<string, unknown>;

  @ApiPropertyOptional({ enum: RiskLevel })
  @IsOptional()
  @IsEnum(RiskLevel)
  riskLevel?: RiskLevel;
}
