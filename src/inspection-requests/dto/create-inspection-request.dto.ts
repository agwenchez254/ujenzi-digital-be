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

  @ApiProperty({ format: 'uuid', description: 'The engineer the requester chose to inspect the site. Required.' })
  @IsUUID(undefined, { message: 'Choose an engineer for this inspection' })
  engineerId: string;
}
