import { AppRole } from '@prisma/client';
import { ArrayMinSize, IsArray, IsEmail, IsEnum, IsOptional, IsString, MinLength } from 'class-validator';

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
  @IsEnum(AppRole, { each: true })
  roles: AppRole[];
}
