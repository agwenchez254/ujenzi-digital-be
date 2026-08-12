import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SitePersonnelRole } from '@prisma/client';
import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

@ValidatorConstraint({ name: 'exactlyOneOfUserIdOrName' })
class ExactlyOneOfUserIdOrNameConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const dto = args.object as SitePersonnelInputDto;
    return Boolean(dto.userId) !== Boolean(dto.name);
  }

  defaultMessage(): string {
    return 'Provide exactly one of userId (linked account) or name (freeform contact)';
  }
}

export class SitePersonnelInputDto {
  @ApiProperty({ enum: SitePersonnelRole })
  @IsEnum(SitePersonnelRole)
  @Validate(ExactlyOneOfUserIdOrNameConstraint)
  role: SitePersonnelRole;

  @ApiPropertyOptional({ format: 'uuid', description: 'Set when this person has a registered account.' })
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional({
    description: 'Set when this person has no account (e.g. a quantity surveyor referenced for records only).',
  })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ description: 'Phone/email — only meaningful alongside name (freeform contact).' })
  @IsOptional()
  @IsString()
  contact?: string;
}
