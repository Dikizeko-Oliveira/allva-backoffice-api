import {
  SRC_ROOT,
  importedModules,
  readSourceFiles,
} from './support/source-tree';

const sources = readSourceFiles(SRC_ROOT).filter(
  (file) => !file.path.endsWith('.spec.ts'),
);

/**
 * Comentário não é código. Sem isto, o próprio texto que **explica** por que não
 * se autoriza por rank derrubaria o gate — foi o que aconteceu na primeira
 * execução, e a lição é que um gate que pune a documentação da regra ensina a
 * apagar a documentação.
 *
 * O `[^:]` antes de `//` preserva `https://` dentro de string; nada aqui depende
 * de o corte ser perfeito, só de `rankOf` e `ROLE_RANK` sobreviverem quando são
 * código de verdade.
 */
function stripComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Um arquivo que **consome** a hierarquia de papéis — não quem a define. */
function importsRoleRank(content: string): boolean {
  const code = stripComments(content);
  if (!/\brankOf\b|\bROLE_RANK\b/.test(code)) return false;

  return importedModules(code).some((specifier) =>
    /(^|\/)(rbac|roles)$|\/rbac\/roles$/.test(specifier),
  );
}

/**
 * **Cargo e capacidade são eixos separados.**
 *
 * `ROLE_RANK` responde *"este ator pode mexer naquele membro?"* — hierarquia,
 * e a anti-escalação de `organizations` depende dela. Autorização responde
 * outra coisa: *"este ator pode fazer isto?"*. Ler a primeira como resposta da
 * segunda entrega a `FINANCE` (rank 60) o poder de pausar anúncios e mover
 * orçamento, porque ele passa por cima de `ANALYST` (rank 40) numa escada que
 * nunca foi sobre escrita em mídia.
 *
 * O gate existe porque a confusão é sintaticamente barata — `rankOf(role) >=
 * rankOf('ANALYST')` cabe numa linha e parece razoável isolada — e cara em
 * produção, onde ela move dinheiro de verdade.
 */
describe('autorização por capacidade, nunca por rank', () => {
  /**
   * Lista de **exceção**, não de permissão: a pergunta que estes arquivos fazem é
   * de fato hierárquica. Nenhum arquivo novo entra aqui sem isso.
   *
   * Os use cases são a gestão de membros, onde rank decide **autorização** —
   * quem pode mexer em quem. Enviar e revogar convite entram pela mesma razão:
   * conceder um papel é mexer em quem, só que antes de a pessoa existir na
   * organização. Sem a comparação, o convite era o desvio da troca de papel —
   * um ADMIN proibido de promover alguém a ADMIN convidava um.
   *
   * `MembershipFreezeService` é de outra natureza e vale dizer por quê: ele não
   * autoriza nada. Ele **ordena** quem mantém assento quando o plano encolhe, e
   * ordenar por antiguidade sozinha congelaria administradores para preservar
   * visualizadores mais antigos. A regra que este teste protege — nunca decidir
   * acesso a capacidade por comparação de papéis — continua intacta: a decisão
   * final é do usuário, e o rank só escolhe o padrão.
   */
  const HIERARCHY_CALLERS = [
    'src/modules/organizations/application/services/membership-freeze.service.ts',
    'src/modules/organizations/application/use-cases/revoke-organization-invitation.usecase.ts',
    'src/modules/organizations/application/use-cases/send-organization-invitation.usecase.ts',
    'src/modules/organizations/application/use-cases/update-organization-user-role.usecase.ts',
    'src/modules/organizations/application/use-cases/update-organization-user-status.usecase.ts',
    'src/modules/organizations/application/use-cases/remove-organization-user.usecase.ts',
  ];

  it('só a gestão de membros consulta a hierarquia de papéis', () => {
    const offenders = sources
      .filter((file) => importsRoleRank(file.content))
      .map((file) => file.path)
      .filter((path) => !HIERARCHY_CALLERS.includes(path));

    expect(offenders).toEqual([]);
  });

  it('a lista de exceção não apodrece (guarda a guarda)', () => {
    // Se um dos três for renomeado ou parar de usar rank, a exceção some junto —
    // senão a lista vira permissão histórica para um caminho que já não existe.
    const actual = sources
      .filter((file) => importsRoleRank(file.content))
      .map((file) => file.path)
      .sort();

    expect(actual).toEqual([...HIERARCHY_CALLERS].sort());
  });

  it('nenhuma decisão de escrita em plataforma consulta rank', () => {
    const offenders = sources
      .filter((file) => file.path.startsWith('src/modules/platform-actions/'))
      .filter((file) => /\brankOf\b|\bROLE_RANK\b/.test(file.content))
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });

  it('o guard decide por permissão resolvida, não por comparação de papel', () => {
    const guard = sources.find((file) =>
      file.path.endsWith('guards/organization-access.guard.ts'),
    );

    expect(guard).toBeDefined();
    expect(guard!.content).toMatch(/permissionResolver\.can\(/);
    expect(guard!.content).not.toMatch(/\brankOf\b|\bROLE_RANK\b/);
  });
});

/**
 * §13.5 — **toda rota que escreve em plataforma declara a permissão que exige.**
 *
 * O gate nasce antes das rotas de A2-S7 de propósito: uma rota de escrita sem
 * `@RequirePermissions` não falha em teste nenhum, responde 200 e move dinheiro
 * — e o `OrganizationAccessGuard` a deixa passar, porque rota sem metadado é
 * rota que optou por não ter RBAC (`return true`). Este é o teste que transforma
 * o esquecimento em CI vermelho.
 */
describe('§13.5 — rotas de escrita declaram permissão', () => {
  const WRITE_DECORATOR = /@(Post|Put|Patch|Delete)\(/;

  const actionControllers = sources.filter(
    (file) =>
      file.path.startsWith('src/modules/platform-actions/') &&
      file.path.includes('/controllers/'),
  );

  it('todo controller de platform-actions com rota de escrita exige permissão', () => {
    const offenders = actionControllers
      .filter((file) => WRITE_DECORATOR.test(file.content))
      .filter((file) => !/@RequirePermissions\(/.test(file.content))
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });

  it('nenhuma permissão de ação é exigida fora do vocabulário declarado', () => {
    // `@RequirePermissions('actions:exec')` compila se o literal existir na
    // união e falha em `tsc` se não — mas um typo dentro de uma string em
    // módulo não tipado passaria. O gate cobre o caso de a união crescer sem a
    // matriz crescer junto.
    const declared = new Set([
      'actions:read',
      'actions:execute',
      'actions:execute_sensitive',
      'actions:consent_manage',
      'actions:kill_switch',
    ]);

    const used = sources.flatMap((file) => {
      const matches = file.content.matchAll(/'(actions:[a-z_]+)'/g);
      return [...matches].map((match) => match[1]);
    });

    const unknown = [...new Set(used)].filter(
      (permission) => !declared.has(permission),
    );

    expect(unknown).toEqual([]);
  });
});
