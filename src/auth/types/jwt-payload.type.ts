import { AppRole } from '@prisma/client';
import { Permission } from '../../permissions/permission.constants';

export interface AccessTokenPayload {
  sub: string;
  roles: AppRole[];
  permissions: Permission[];
}

export interface AuthenticatedUser {
  userId: string;
  roles: AppRole[];
  permissions: Permission[];
}
