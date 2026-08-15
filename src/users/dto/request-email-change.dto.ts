import { ApiProperty } from '@nestjs/swagger';
import { IsEmail } from 'class-validator';

export class RequestEmailChangeDto {
  @ApiProperty({ example: 'new.email@example.com' })
  @IsEmail()
  newEmail: string;
}
