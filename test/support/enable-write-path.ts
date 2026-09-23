/**
 * Destrava as duas trancas de escrita **antes de qualquer import do app**.
 *
 * ## Por que um módulo, e não uma linha no `beforeAll`
 *
 * `EnvModule` chama `ConfigModule.forRoot({ validate })` na lista `imports:` do
 * decorador — e decorador é avaliado no **import**, não na instanciação. Quando
 * `beforeAll` roda, `.env` já foi lido e validado, e mexer em `process.env` ali
 * não muda nada. A primeira redação deste E2E fez exatamente isso e passou vinte
 * minutos parecendo um problema de guarda.
 *
 * Como `import` é içado, a única forma de rodar antes é ser um módulo importado
 * **primeiro**. Daí este arquivo existir em vez de duas linhas soltas.
 *
 * ## Por que não um `setupFiles` global
 *
 * Porque isto liga a escrita em mídia paga. Um arquivo de setup global a
 * ligaria para a suíte inteira, e o teste que dependesse do padrão — `false`,
 * `true`, que é como produção sobe — passaria a testar outra coisa sem que nada
 * no arquivo dele dissesse isso. Quem quer o caminho de escrita destravado
 * importa esta linha e assume o que ela faz.
 */

process.env.PLATFORM_ACTIONS_ENABLED = 'true';
process.env.PLATFORM_ACTIONS_DRY_RUN_ONLY = 'false';

export const WRITE_PATH_ENABLED = true;
