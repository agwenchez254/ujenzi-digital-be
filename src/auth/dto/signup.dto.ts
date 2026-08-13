import { ApiProperty } from '@nestjs/swagger';
import { AppRole } from '@prisma/client';
import { ArrayMinSize, IsArray, IsEmail, IsIn, IsOptional, IsString, MinLength } from 'class-validator';

export const SELF_SIGNUP_ROLES: AppRole[] = [
  AppRole.engineer,
  AppRole.contractor,
  AppRole.site_representative,
  AppRole.developer,
];

export class SignupDto {
  @ApiProperty({ example: 'contractor1@example.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ minLength: 8 })
  @MinLength(8)
  password: string;

  @ApiProperty({ example: 'Contractor One' })
  @IsString()
  name: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  company?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  certificationDetails?: string;

  @ApiProperty({ enum: SELF_SIGNUP_ROLES, isArray: true })
  @IsArray()
  @ArrayMinSize(1)
  @IsIn(SELF_SIGNUP_ROLES, { each: true })
  roles: AppRole[];
}
