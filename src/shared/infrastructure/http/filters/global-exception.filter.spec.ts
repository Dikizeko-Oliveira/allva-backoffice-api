import { ArgumentsHost, BadRequestException } from '@nestjs/common';
import { GlobalExceptionFilter } from './global-exception.filter';

function hostFor(correlationId?: string) {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const request = {
    method: 'GET',
    path: '/api/v1/alerts',
    url: '/api/v1/alerts?page=abc',
    correlationId,
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => request,
    }),
  } as unknown as ArgumentsHost;

  return { host, status, json };
}

describe('GlobalExceptionFilter — correlationId (GAP-058)', () => {
  function filterWithLogger() {
    const filter = new GlobalExceptionFilter();
    const error = jest
      .spyOn((filter as any).logger, 'error')
      .mockImplementation(() => undefined);
    return { filter, error };
  }

  it('o log do 500 leva o id da requisição', () => {
    const { filter, error } = filterWithLogger();
    const { host } = hostFor('bff-123');

    filter.catch(new Error('boom'), host);

    expect(String(error.mock.calls[0][0])).toBe(
      'Unhandled exception on GET /api/v1/alerts correlationId=bff-123',
    );
  });

  it('o corpo do 500 devolve o mesmo id', () => {
    const { filter } = filterWithLogger();
    const { host, status, json } = hostFor('bff-123');

    filter.catch(new Error('boom'), host);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 500, correlationId: 'bff-123' }),
    );
  });

  // Fora de uma requisição com middleware (teste, script), o corpo fica como era.
  it('sem id, o corpo não ganha o campo', () => {
    const { filter } = filterWithLogger();
    const { host, json } = hostFor(undefined);

    filter.catch(new Error('boom'), host);

    expect(json.mock.calls[0][0]).not.toHaveProperty('correlationId');
  });

  // O formato de HttpException não muda: o id já vai no header.
  it('não altera o corpo de HttpException', () => {
    const { filter } = filterWithLogger();
    const { host, json } = hostFor('bff-123');

    filter.catch(new BadRequestException({ code: 'X', message: 'y' }), host);

    expect(json).toHaveBeenCalledWith({ code: 'X', message: 'y' });
  });
});
