import { ApiResponse } from '@nestjs/swagger';
import { ApiDomainError } from './api-error.swagger';

jest.mock('@nestjs/swagger', () => ({
  ...jest.requireActual('@nestjs/swagger'),
  ApiResponse: jest.fn(() => () => undefined),
}));

describe('ApiDomainError', () => {
  it('anexa a lista de codes à description quando informada', () => {
    ApiDomainError(409, 'Já existe uma escrita em andamento.', [
      'WRITE_IN_FLIGHT',
      'IDEMPOTENCY_KEY_REUSED',
    ]);

    expect(ApiResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        description:
          'Já existe uma escrita em andamento. — `code`: `WRITE_IN_FLIGHT`, `IDEMPOTENCY_KEY_REUSED`',
      }),
    );
  });

  it('mantém a description sozinha quando nenhum code é informado', () => {
    ApiDomainError(400, 'Requisição inválida.');

    expect(ApiResponse).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'Requisição inválida.' }),
    );
  });
});
