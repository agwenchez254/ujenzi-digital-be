import { SetMetadata } from '@nestjs/common';

export const ALLOW_NO_ROLE_KEY = 'allowNoRole';
export const AllowNoRole = () => SetMetadata(ALLOW_NO_ROLE_KEY, true);
