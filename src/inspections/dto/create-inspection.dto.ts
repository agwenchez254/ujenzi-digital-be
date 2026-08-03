import { ApiProperty } from '@nestjs/swagger';
import { IsLatitude, IsLongitude, IsUUID } from 'class-validator';

export class CreateInspectionDto {
  @ApiProperty({ format: 'uuid', description: 'The accepted InspectionRequest to start.' })
  @IsUUID()
  requestId: string;

  @ApiProperty({ example: -1.2921, description: "The engineer's current latitude, checked against the site's geofence." })
  @IsLatitude()
  latitude: number;

  @ApiProperty({ example: 36.8219 })
  @IsLongitude()
  longitude: number;
}
