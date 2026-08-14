import { ApiProperty } from '@nestjs/swagger';
import { IsEmail } from 'class-validator';

export class LookupUserDto {
  @ApiProperty()
  @IsEmail()
  email: string;
}
