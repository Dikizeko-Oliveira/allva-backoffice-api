import { SRC_ROOT, readSourceFiles } from './support/source-tree';

const sources = readSourceFiles(SRC_ROOT).filter(
  (file) => !file.path.endsWith('.spec.ts'),
);

/** Mesmo corte de `authorization-model.spec.ts`: comentário não conta. */
function stripComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * As formas pelas quais um use case de backoffice recusa conta de cliente.
 * `isPlatformRole` entra porque o overview e o Operations Hub aceitam
 * **qualquer** papel de plataforma e filtram o conteúdo pela permissão.
 */
const PLATFORM_CHECK =
  /\b(assertPermission|assertPlatformPermission|roleHasPlatformPermission|isPlatformRole)\(/;

const ADMIN_CONTROLLER = /@Controller\(\s*'\/api\/v1\/admin[/']/;

/** Dependências do construtor que carregam a regra: use case ou serviço. */
function injectedCollaborators(content: string): string[] {
  const matches = content.matchAll(
    /private readonly \w+:\s*([A-Z]\w*(?:UseCase|Service))\b/g,
  );
  return [...new Set([...matches].map((match) => match[1]))];
}

function fileExporting(className: string) {
  const declaration = new RegExp(`export class ${className}\\b`);
  return sources.find((file) => declaration.test(file.content));
}

/**
 * **Toda rota `/api/v1/admin/*` recusa conta de cliente.**
 *
 * O backoffice não tem guard de rota: a autorização de plataforma mora no use
 * case, por decisão (`platform-authorization.ts` explica o ciclo de módulos
 * que um guard injetado fecharia). O custo desse desenho é que esquecer é
 * silencioso — um use case novo sem `assertPermission` responde `200` a
 * qualquer conta autenticada, e nada no log denuncia.
 *
 * Este gate transforma o esquecimento em CI vermelho. Ele é deliberadamente
 * grosso: pede que **cada colaborador** injetado num controller admin faça
 * alguma checagem de plataforma. Um serviço auxiliar sem regra própria (um
 * formatador, um cliente de storage) deve ser chamado de dentro de um use case,
 * não injetado direto no controller admin.
 */
describe('rotas de backoffice exigem papel de plataforma', () => {
  const adminControllers = sources.filter((file) =>
    ADMIN_CONTROLLER.test(file.content),
  );

  it('encontra os controllers admin (o gate não passa por estar vazio)', () => {
    expect(adminControllers.length).toBeGreaterThan(5);
  });

  it('todo controller admin injeta ao menos um use case', () => {
    const offenders = adminControllers
      .filter((file) => injectedCollaborators(file.content).length === 0)
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });

  it('todo use case chamado por controller admin checa papel de plataforma', () => {
    const offenders = adminControllers.flatMap((controller) =>
      injectedCollaborators(controller.content)
        .map((className) => ({ className, file: fileExporting(className) }))
        .filter(
          ({ file }) =>
            !file || !PLATFORM_CHECK.test(stripComments(file.content)),
        )
        .map(({ className }) => `${controller.path} → ${className}`),
    );

    expect(offenders).toEqual([]);
  });
});

/**
 * **O produto do cliente recusa conta de plataforma.**
 *
 * O corte é um só, no `EntitlementGuard`, e cobre toda rota com
 * `@RequireAccessStatuses`. Estes asserts fixam as duas metades que fazem ele
 * funcionar: o guard chamar a regra, e o middleware publicar o papel que ela lê.
 * Remover qualquer uma reabre o caminho do operador até o checkout sem que
 * nenhum teste de rota perceba — as rotas continuariam respondendo, só que
 * para a conta errada.
 */
describe('produto do cliente recusa conta de plataforma', () => {
  const read = (path: string) => {
    const file = sources.find((source) => source.path === path);
    if (!file) throw new Error(`arquivo não encontrado: ${path}`);
    return stripComments(file.content);
  };

  it('o EntitlementGuard aplica assertCustomerAccount', () => {
    expect(
      read(
        'src/modules/subscriptions/access/infrastructure/http/guards/entitlement.guard.ts',
      ),
    ).toMatch(/assertCustomerAccount\(/);
  });

  it('o AuthMiddleware publica o papel da conta em req.user', () => {
    expect(
      read(
        'src/modules/auth/infrastructure/http/middlewares/auth.middleware.ts',
      ),
    ).toMatch(/role:\s*user\.role/);
  });
});
