import { SRC_ROOT, readSourceFiles } from './support/source-tree';

const sources = readSourceFiles(SRC_ROOT).filter(
  (file) => !file.path.endsWith('.spec.ts'),
);

function stripComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * As formas pelas quais um use case decide acesso. `.can(` entra porque o hub
 * e a lista de alertas aceitam qualquer operador e **filtram** o conteúdo pela
 * permissão; `assertScreenAvailable` é a checagem de tela das visões salvas.
 */
const AUTHORIZATION_CHECK =
  /\b(assertPlatformPermission|assertScreenAvailable)\(|\boperator\.(can\(|permissions\b)/;

/**
 * Use cases que servem dado **do próprio operador** e por isso não pedem
 * permissão de plataforma. Cada entrada tem que dizer por quê — e a lista é
 * teto: entrada que passar a checar permissão tem que sair.
 */
const OWN_DATA_USE_CASES: Record<string, string> = {
  'src/modules/preferences/application/use-cases/get-operator-preference.usecase.ts':
    'preferências do próprio operador; o id vem do token',
  'src/modules/preferences/application/use-cases/update-operator-preference.usecase.ts':
    'preferências do próprio operador; o id vem do token',
  'src/modules/auth/application/use-cases/authenticate-operator.usecase.ts':
    'é a própria autenticação: roda antes de existir operador',
};

/**
 * **Todo use case decide acesso.**
 *
 * O backoffice-api não tem guard de permissão por rota: a autorização mora no
 * use case, como no `allva-api` (`platform-authorization.ts` explica). O custo
 * desse desenho é que esquecer é silencioso — um use case novo sem checagem
 * responde `200` a qualquer operador, e nada no log denuncia. Este gate
 * transforma o esquecimento em CI vermelho.
 */
describe('todo use case decide acesso', () => {
  const useCases = sources.filter((file) => file.path.endsWith('.usecase.ts'));

  it('encontra os use cases (o gate não passa por estar vazio)', () => {
    expect(useCases.length).toBeGreaterThan(20);
  });

  it('cada use case checa permissão, ou está na lista de dado próprio', () => {
    const unchecked = useCases
      .filter((file) => !(file.path in OWN_DATA_USE_CASES))
      .filter((file) => !AUTHORIZATION_CHECK.test(stripComments(file.content)))
      .map((file) => file.path);

    expect(unchecked).toEqual([]);
  });

  it('a lista de dado próprio não guarda use case que já checa permissão', () => {
    const stale = Object.keys(OWN_DATA_USE_CASES).filter((path) => {
      const file = useCases.find((candidate) => candidate.path === path);
      return !file || AUTHORIZATION_CHECK.test(stripComments(file.content));
    });

    expect(stale).toEqual([]);
  });

  it('nenhum código decide acesso por papel', () => {
    // `docs/backoffice-api.md` §1.4, regra 2: a pergunta é sempre
    // `can('support:manage')`, nunca `role === 'ALLVA_SUPPORT'`.
    const offenders = sources
      .filter((file) =>
        /platformRole\s*[!=]==|['"]ALLVA_[A-Z]+['"]/.test(
          stripComments(file.content),
        ),
      )
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });
});
