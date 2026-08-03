import { ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { CreateSiteDto } from './create-site.dto';
import { SITE_STATUSES } from '../site-status';

export class UpdateSiteDto extends PartialType(OmitType(CreateSiteDto, ['contractorId'] as const)) {
  @ApiPropertyOptional({ enum: SITE_STATUSES })
  @IsOptional()
  @IsIn(SITE_STATUSES)
  status?: string;
}
