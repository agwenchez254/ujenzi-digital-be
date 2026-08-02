import { AppRole } from '@prisma/client';

export interface AccessTokenPayload {
  sub: string;
  roles: AppRole[];
}

export interface AuthenticatedUser {
  userId: string;
  roles: AppRole[];
}
