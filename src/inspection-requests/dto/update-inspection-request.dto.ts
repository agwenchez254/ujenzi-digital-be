import { OmitType, PartialType } from '@nestjs/swagger';
import { CreateInspectionRequestDto } from './create-inspection-request.dto';

export class UpdateInspectionRequestDto extends PartialType(
  OmitType(CreateInspectionRequestDto, ['contractorId'] as const),
) {}
