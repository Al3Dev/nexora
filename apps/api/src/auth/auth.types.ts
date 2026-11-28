export type Role = 'owner' | 'admin' | 'cashier';

export interface AuthContext {
  userId: string;
  /** Present on tenant-scoped routes after membership was verified. */
  tenantId?: string;
  role?: Role;
}

export interface TenantAuthContext extends AuthContext {
  tenantId: string;
  role: Role;
}
