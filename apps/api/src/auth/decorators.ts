import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthContext, Role, TenantAuthContext } from './auth.types.js';

export const IS_PUBLIC = 'nexora:public';
export const NO_TENANT = 'nexora:no-tenant';
export const ROLES = 'nexora:roles';

/** Route needs no authentication. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Route needs an authenticated user but no active tenant (e.g. creating a tenant). */
export const NoTenant = () => SetMetadata(NO_TENANT, true);
/** Restrict a tenant-scoped route to these membership roles. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);

function readAuth(ctx: ExecutionContext): AuthContext {
  const req = ctx.switchToHttp().getRequest<{ auth?: AuthContext }>();
  if (!req.auth) throw new Error('Auth context missing: route is not protected by AuthGuard');
  return req.auth;
}

/** Authenticated user on a @NoTenant route. */
export const User = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthContext => readAuth(ctx));

/** Authenticated member of the active tenant. */
export const Member = createParamDecorator((_data: unknown, ctx: ExecutionContext): TenantAuthContext => {
  const auth = readAuth(ctx);
  if (!auth.tenantId || !auth.role) throw new Error('Tenant context missing: route is marked @NoTenant');
  return auth as TenantAuthContext;
});
