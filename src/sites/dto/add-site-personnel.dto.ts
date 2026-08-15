import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, ValidateNested } from 'class-validator';
import { SitePersonnelInputDto } from './site-personnel-input.dto';

export class AddSitePersonnelDto {
  @ApiProperty({ type: [SitePersonnelInputDto], description: 'New entries to append to the roster.' })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SitePersonnelInputDto)
  personnel: SitePersonnelInputDto[];
}
