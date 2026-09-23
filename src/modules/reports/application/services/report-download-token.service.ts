import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtServiceInterface } from 'src/modules/auth/domain/ports';

/**
 * A reivindicação que separa este token de um token de acesso. Ver a nota de
 * segurança na classe.
 */
const PURPOSE = 'report-download';

/**
 * O token que viaja dentro do link de download no e-mail.
 *
 * Existe por uma limitação que não tem contorno: **quem clica num link de
 * e-mail não envia cabeçalho `Authorization`**. Ou a autorização viaja na
 * própria URL, ou o e-mail deixa de oferecer download direto.
 *
 * ## Por que ele não vira um token de acesso
 *
 * Ele é assinado com `JWT_SECRET_KEY`, a mesma chave dos tokens de sessão — o
 * que naturalmente levanta a pergunta. **Não vira**, por duas razões
 * independentes:
 *
 * 1. `AuthMiddleware` exige `sid` no payload, procura a sessão no banco e
 *    recusa quando ela não existe ou está revogada. Este token não carrega
 *    `sid` nenhum, então morre em `INVALID_TOKEN` antes de qualquer coisa.
 * 2. `purpose` é conferido aqui. Se um dia a exigência de sessão mudar, a
 *    segunda tranca continua de pé.
 *
 * ## Qual é o alcance dele
 *
 * Um relatório, de uma conta. `reportId` é conferido contra o da rota, então o
 * token de um relatório não abre outro — sem isso, quem recebesse um e-mail
 * poderia trocar o id na URL e ler o relatório seguinte da mesma conta.
 *
 * A validade é a de `JWT_EXPIRES_IN` (7 dias por padrão), que é também o teto
 * de uma URL assinada V4. Quem clica depois disso recebe uma recusa clara em
 * vez de um arquivo — e pede de novo pelo app.
 */
@Injectable()
export class ReportDownloadTokenService {
  constructor(
    @Inject(JwtServiceInterface)
    private readonly jwt: JwtServiceInterface,
  ) {}

  issue(accountId: string, reportId: string): Promise<string> {
    return this.jwt.sign({ sub: accountId, reportId, purpose: PURPOSE });
  }

  /** O `accountId` que o token autoriza, ou 401. */
  async verify(token: string, reportId: string): Promise<string> {
    let payload: Record<string, unknown>;

    try {
      payload = await this.jwt.verify(token);
    } catch {
      throw this.refuse();
    }

    const accountId = payload.sub;

    // As três conferências em conjunto: assinatura válida, propósito certo e
    // relatório certo. Qualquer uma sozinha deixaria uma porta aberta.
    if (
      payload.purpose !== PURPOSE ||
      payload.reportId !== reportId ||
      typeof accountId !== 'string' ||
      !accountId
    ) {
      throw this.refuse();
    }

    return accountId;
  }

  /**
   * Uma recusa só, sem dizer qual das conferências falhou: distinguir "token
   * inválido" de "token de outro relatório" contaria a quem está tentando
   * exatamente o que ele precisa saber para tentar de novo.
   */
  private refuse(): UnauthorizedException {
    return new UnauthorizedException({
      code: 'INVALID_DOWNLOAD_TOKEN',
      message: 'Link de download inválido ou expirado',
    });
  }
}
