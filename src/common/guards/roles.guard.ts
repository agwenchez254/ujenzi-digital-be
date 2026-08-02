import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppRole } from '@prisma/client';
import { AuthenticatedUser } from '../../auth/types/jwt-payload.type';
import { ALLOW_NO_ROLE_KEY } from '../decorators/allow-no-role.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user as AuthenticatedUser | undefined;
    if (!user) {
      return false;
    }

    const allowNoRole = this.reflector.getAllAndOverride<boolean>(ALLOW_NO_ROLE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (allowNoRole) {
      return true;
    }

    if (user.roles.length === 0) {
      throw new ForbiddenException('Account has no assigned roles yet');
    }

    const requiredRoles = this.reflector.getAllAndOverride<AppRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    return requiredRoles.some((role) => user.roles.includes(role));
  }
}
