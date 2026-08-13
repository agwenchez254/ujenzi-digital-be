import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsIn } from 'class-validator';
import { PERMISSION_CATALOG, Permission } from '../permission.constants';

export class UpdateRolePermissionsDto {
  @ApiProperty({ enum: PERMISSION_CATALOG, isArray: true })
  @IsArray()
  @IsIn(PERMISSION_CATALOG, { each: true })
  permissions: Permission[];
}
