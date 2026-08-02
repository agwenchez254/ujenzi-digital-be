import { AppRole } from '@prisma/client';
import { ArrayMinSize, IsArray, IsEmail, IsIn, IsOptional, IsString, MinLength } from 'class-validator';

export const SELF_SIGNUP_ROLES: AppRole[] = [
  AppRole.engineer,
  AppRole.contractor,
  AppRole.site_representative,
];

export class SignupDto {
  @IsEmail()
  email: string;

  @MinLength(8)
  password: string;

  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  company?: string;

  @IsOptional()
  @IsString()
  certificationDetails?: string;

  @IsArray()
  @ArrayMinSize(1)
  @IsIn(SELF_SIGNUP_ROLES, { each: true })
  roles: AppRole[];
}
