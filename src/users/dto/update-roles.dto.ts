import { AppRole } from '@prisma/client';
import { ArrayMinSize, IsArray, IsEnum } from 'class-validator';

export class UpdateRolesDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsEnum(AppRole, { each: true })
  roles: AppRole[];
}
