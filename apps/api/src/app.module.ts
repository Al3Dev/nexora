import { Global, Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth/auth.guard.js';
import { TokenVerifier } from './auth/token-verifier.js';
import { AppExceptionFilter } from './common/http-exception.filter.js';
import type { Config } from './config.js';
import { Database } from './db/database.js';
import { HealthController } from './health/health.controller.js';
import { MetricsController } from './metrics/metrics.controller.js';
import { OrdersController } from './orders/orders.controller.js';
import { ProductsController } from './products/products.controller.js';
import { TenantsController } from './tenants/tenants.controller.js';
import { CONFIG } from './tokens.js';

@Module({ controllers: [ProductsController] })
class CatalogModule {}

@Module({ controllers: [OrdersController] })
class PosModule {}

@Module({ controllers: [MetricsController] })
class AnalyticsModule {}

@Module({ controllers: [TenantsController] })
class TenancyModule {}

@Global()
@Module({})
class CoreModule {
  static forRoot(config: Config, db: Database): DynamicModule {
    return {
      module: CoreModule,
      controllers: [HealthController],
      providers: [
        { provide: CONFIG, useValue: config },
        { provide: Database, useValue: db },
        TokenVerifier,
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: AppExceptionFilter },
      ],
      exports: [CONFIG, Database, TokenVerifier],
    };
  }
}

@Module({})
export class AppModule {
  static forRoot(config: Config, db: Database): DynamicModule {
    return {
      module: AppModule,
      imports: [CoreModule.forRoot(config, db), TenancyModule, CatalogModule, PosModule, AnalyticsModule],
    };
  }
}
