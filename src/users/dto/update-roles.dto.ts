import { ApiProperty } from '@nestjs/swagger';
import { AppRole } from '@prisma/client';
import { ArrayMinSize, IsArray, IsEnum } from 'class-validator';

export class UpdateRolesDto {
  @ApiProperty({ enum: AppRole, isArray: true })
  @IsArray()
  @ArrayMinSize(1)
  @IsEnum(AppRole, { each: true })
  roles: AppRole[];
}
