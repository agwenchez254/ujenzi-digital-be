import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class MarkReadDto {
  @ApiProperty({ description: 'Newest message the user has seen in this conversation' })
  @IsUUID()
  messageId!: string;
}
