import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

export class AcceptInspectionRequestDto {
  @ApiPropertyOptional({ description: 'Required when an administrator accepts on behalf of an engineer.' })
  @IsOptional()
  @IsUUID()
  engineerId?: string;
}
