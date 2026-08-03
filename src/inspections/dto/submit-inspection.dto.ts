import { ApiProperty } from '@nestjs/swagger';
import { IsLatitude, IsLongitude } from 'class-validator';
import { UpdateInspectionDto } from './update-inspection.dto';

export class SubmitInspectionDto extends UpdateInspectionDto {
  @ApiProperty({ example: -1.2921, description: "The engineer's current latitude, checked against the site's geofence." })
  @IsLatitude()
  latitude: number;

  @ApiProperty({ example: 36.8219 })
  @IsLongitude()
  longitude: number;
}
