import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SitePersonnelRole } from '@prisma/client';
import {
  IsBoolean,
  IsEmail,
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

// A freeform CONTRACTOR always needs an invitation (site ownership transfers
// on acceptance, so it must go to a real, confirmed account). Every other
// freeform role only needs one if sendInvite was explicitly requested.
@ValidatorConstraint({ name: 'requiresEmailWhenInvited' })
class RequiresEmailWhenInvitedConstraint implements ValidatorConstraintInterface {
  validate(email: unknown, args: ValidationArguments): boolean {
    const dto = args.object as SitePersonnelInputDto;
    if (dto.userId) return true;
    const inviteRequired = dto.role === SitePersonnelRole.CONTRACTOR || dto.sendInvite;
    return !inviteRequired || Boolean(email);
  }

  defaultMessage(): string {
    return 'email is required to send a signup invitation (mandatory for the contractor role)';
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

  @ApiPropertyOptional({
    description:
      'Required when sendInvite is true, or always for a freeform CONTRACTOR. Sends a signup invitation to this address.',
  })
  @IsOptional()
  @IsEmail()
  @Validate(RequiresEmailWhenInvitedConstraint)
  email?: string;

  @ApiPropertyOptional({
    default: false,
    description: 'Freeform, non-contractor roles only — whether to email this person a signup invitation.',
  })
  @IsOptional()
  @IsBoolean()
  sendInvite?: boolean;
}
