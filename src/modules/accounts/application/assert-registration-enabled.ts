import { EnvService } from 'src/shared/infrastructure/config/env.service';
import { DomainError } from 'src/shared/infrastructure/http/errors/domain-error';

/**
 * A recusa de criar conta nova, **uma só para as três portas**.
 *
 * São três caminhos independentes até a mesma conta criada, e nenhum deles
 * passa pelos outros: o cadastro por senha (`POST /accounts`), o cadastro por
 * Google (`POST /auth/google/register`) e o **primeiro login por Facebook**
 * (`POST /auth/facebook`), que cria a conta na hora quando o e-mail ainda não
 * existe. O login por Google é o único que não cria — ele recusa com
 * `ACCOUNT_REGISTRATION_REQUIRED`.
 *
 * A landing já mostra uma lista de espera no lugar do formulário, e é por isso
 * que esta função existe: esconder a tela não fecha porta nenhuma. Os botões de
 * Google e Facebook continuam na tela de **login**, que segue aberta para os
 * testers, e `POST /accounts` é público e responde a qualquer cliente HTTP.
 *
 * Uma função e não três `if`: uma quarta porta é questão de tempo — foi assim
 * que `RegisterWithGoogleUseCase` acabou criando a conta por fora de
 * `CreateAccountWithPasswordUseCase`, com o próprio `Account.create` — e três
 * cópias divergem antes disso.
 *
 * `KILL_SWITCH` porque é exatamente isso: o pedido está correto e a instalação
 * é que não o atende agora. A categoria devolve 403 e `retryable: false` — o
 * cliente não ganha nada insistindo, e a saída é a lista de espera.
 */
export function assertRegistrationEnabled(env: EnvService): void {
  if (!env.get('REGISTRATION_DISABLED')) return;

  throw new DomainError({
    code: 'REGISTRATION_DISABLED',
    category: 'KILL_SWITCH',
    message: 'Novos cadastros estão temporariamente fechados.',
    remediation:
      'A plataforma está em fase final de testes. Entre na lista de espera para ser avisado quando os cadastros abrirem.',
  });
}
