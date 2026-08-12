import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';

export const APPROVAL_STATUSES = ['VALID', 'PENDING', 'EXPIRED'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export class ApprovalStatusDto {
  @ApiProperty({ enum: APPROVAL_STATUSES })
  @IsIn(APPROVAL_STATUSES)
  status: ApprovalStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reference?: string;
}
