import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsOptional, ValidateNested } from 'class-validator';
import { ApprovalStatusDto } from './approval-status.dto';

export class SiteApprovalsDto {
  @ApiPropertyOptional({ type: ApprovalStatusDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ApprovalStatusDto)
  county?: ApprovalStatusDto;

  @ApiPropertyOptional({ type: ApprovalStatusDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ApprovalStatusDto)
  nema?: ApprovalStatusDto;

  @ApiPropertyOptional({ type: ApprovalStatusDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ApprovalStatusDto)
  nca?: ApprovalStatusDto;
}
