import { Catch, HttpException, HttpStatus, Logger, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';

interface HttpResponse {
  status(code: number): HttpResponse;
  json(body: unknown): void;
}

// PostgreSQL error codes that indicate bad client input rather than a server fault.
const PG_CLIENT_ERRORS: Record<string, { status: number; message: string }> = {
  '23505': { status: HttpStatus.CONFLICT, message: 'Resource already exists' },
  '23514': { status: HttpStatus.BAD_REQUEST, message: 'Value violates a constraint' },
  '23503': { status: HttpStatus.BAD_REQUEST, message: 'Referenced resource does not exist' },
  '22P02': { status: HttpStatus.BAD_REQUEST, message: 'Malformed value' },
  '22003': { status: HttpStatus.BAD_REQUEST, message: 'Number out of range' },
};

/** Maps errors to JSON responses without leaking SQL or stack traces. */
@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<HttpResponse>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      res.status(status).json(typeof body === 'string' ? { statusCode: status, message: body } : body);
      return;
    }

    const code = (exception as { code?: unknown } | null)?.code;
    const mapped = typeof code === 'string' ? PG_CLIENT_ERRORS[code] : undefined;
    if (mapped) {
      res.status(mapped.status).json({ statusCode: mapped.status, message: mapped.message });
      return;
    }

    this.logger.error(exception instanceof Error ? (exception.stack ?? exception.message) : String(exception));
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ statusCode: 500, message: 'Internal server error' });
  }
}
