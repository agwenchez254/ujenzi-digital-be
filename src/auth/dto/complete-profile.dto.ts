import { AppRole } from '@prisma/client';
import { ArrayMinSize, IsArray, IsIn } from 'class-validator';
import { SELF_SIGNUP_ROLES } from './signup.dto';

export class CompleteProfileDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsIn(SELF_SIGNUP_ROLES, { each: true })
  roles: AppRole[];
}
