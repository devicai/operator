import {
  BadRequestException,
  HttpException,
  UnauthorizedException,
} from '@nestjs/common';
import { ClientErrorLoggingFilter } from './client-error-logging.filter';

/**
 * The filter exists so a rejected request is never silent. These tests pin the
 * two rejections that actually went missing in production — an auth refusal and
 * a body the ValidationPipe refused — plus the guarantee that it still delegates
 * to Nest's default filter, since it is the one that writes the response.
 */
describe('ClientErrorLoggingFilter', () => {
  const makeHost = (method: string, url: string) =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ method, originalUrl: url }),
        getResponse: () => ({}),
      }),
    }) as any;

  let filter: ClientErrorLoggingFilter;
  let warn: jest.SpyInstance;
  let delegated: jest.SpyInstance;

  beforeEach(() => {
    filter = new ClientErrorLoggingFilter({} as any);
    warn = jest.spyOn((filter as any).logger, 'warn').mockImplementation();
    // Nest's default filter needs a real http adapter to write the response;
    // stubbing it keeps these tests about the logging decision alone.
    delegated = jest
      .spyOn(
        Object.getPrototypeOf(ClientErrorLoggingFilter.prototype),
        'catch',
      )
      .mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  it('logs an auth rejection, which used to leave no trace at all', () => {
    filter.catch(
      new UnauthorizedException('API key is required'),
      makeHost('POST', '/api/v1/sandboxes'),
    );

    expect(warn).toHaveBeenCalledWith(
      'POST /api/v1/sandboxes -> 401 API key is required',
    );
  });

  it('flattens the array the ValidationPipe throws into one readable line', () => {
    filter.catch(
      new BadRequestException({
        message: ['ttlSeconds must not be less than 60', 'cpus must be a number'],
        error: 'Bad Request',
        statusCode: 400,
      }),
      makeHost('POST', '/api/v1/sandboxes'),
    );

    expect(warn).toHaveBeenCalledWith(
      'POST /api/v1/sandboxes -> 400 ttlSeconds must not be less than 60; cpus must be a number',
    );
  });

  it('leaves 5xx to the default filter, which already logs it with its stack', () => {
    filter.catch(
      new HttpException('boom', 503),
      makeHost('GET', '/api/v1/sandboxes'),
    );

    expect(warn).not.toHaveBeenCalled();
  });

  it('does not swallow the exception: the response is still written', () => {
    const host = makeHost('POST', '/api/v1/sandboxes');
    const exception = new UnauthorizedException();

    filter.catch(exception, host);

    expect(delegated).toHaveBeenCalledWith(exception, host);
  });
});
