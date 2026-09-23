import { UnauthorizedException } from '@nestjs/common';
import { JwtServiceInterface } from 'src/modules/auth/domain/ports';
import { ReportDownloadTokenService } from './report-download-token.service';

/** JWT de mentira: o payload viaja em JSON, a "assinatura" é um prefixo. */
function fakeJwt(): JwtServiceInterface {
  return {
    sign: async (payload: Record<string, unknown>) =>
      `assinado.${JSON.stringify(payload)}`,
    verify: async (token: string) => {
      if (!token.startsWith('assinado.')) throw new Error('bad signature');
      return JSON.parse(token.slice('assinado.'.length)) as Record<
        string,
        unknown
      >;
    },
  };
}

describe('ReportDownloadTokenService', () => {
  const service = new ReportDownloadTokenService(fakeJwt());

  it('devolve a conta que o token autoriza', async () => {
    const token = await service.issue('conta-1', 'relatorio-1');

    await expect(service.verify(token, 'relatorio-1')).resolves.toBe('conta-1');
  });

  /**
   * A garantia principal: `AuthMiddleware` exige `sid` de sessão viva, e este
   * token não carrega nenhum. Sem isso, um link de e-mail assinado com a mesma
   * chave viraria credencial de acesso à API inteira.
   */
  it('não carrega sid, então não serve como token de sessão', async () => {
    const token = await service.issue('conta-1', 'relatorio-1');
    const payload = JSON.parse(token.slice('assinado.'.length)) as Record<
      string,
      unknown
    >;

    expect(payload.sid).toBeUndefined();
    expect(payload.purpose).toBe('report-download');
  });

  /**
   * Sem esta conferência, quem recebesse um e-mail trocaria o id na URL e leria
   * o relatório seguinte da mesma conta.
   */
  it('recusa o token de um relatório em outro', async () => {
    const token = await service.issue('conta-1', 'relatorio-1');

    await expect(service.verify(token, 'relatorio-2')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('recusa token de outro propósito assinado com a mesma chave', async () => {
    const alheio = `assinado.${JSON.stringify({
      sub: 'conta-1',
      reportId: 'relatorio-1',
      purpose: 'password-reset',
    })}`;

    await expect(service.verify(alheio, 'relatorio-1')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it.each([
    ['assinatura inválida', 'lixo'],
    ['token vazio', ''],
  ])('recusa %s', async (_label, token) => {
    await expect(service.verify(token, 'relatorio-1')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('recusa sem dizer qual conferência falhou', async () => {
    const outro = await service.issue('conta-1', 'relatorio-1');
    const erros: string[] = [];

    for (const [token, id] of [
      [outro, 'relatorio-2'],
      ['lixo', 'relatorio-1'],
    ] as const) {
      await service.verify(token, id).catch((error: UnauthorizedException) => {
        erros.push(JSON.stringify(error.getResponse()));
      });
    }

    expect(new Set(erros).size).toBe(1);
  });
});
