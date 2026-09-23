import { createHash, createHmac, randomUUID } from 'crypto';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/configure-app';
import { PrismaService } from '../../src/shared/infrastructure/database/prisma/prisma.service';
import { ensureTenant, removeTenant } from '../support/tenant-fixture';
import { requireDatabaseWhenExpected } from '../support/database';

/**
 * **As rotas administrativas respondem a três públicos, e a cada um do seu
 * jeito.** Quem não está autenticado recebe `401`; quem está mas não tem papel
 * de plataforma recebe `403`; quem tem passa **só onde a permissão dele
 * alcança**.
 *
 * ## Por que este arquivo existe
 *
 * Nada travava esse contrato. Os controllers sob `/admin` não declaram guard
 * nenhum — a autorização mora nos casos de uso, de propósito, e a
 * autenticação vem de um `AuthGuard` **global**, registrado no bootstrap. É uma
 * combinação correta e frágil de perceber: um `@Public()` colocado sem querer
 * num controller administrativo, ou o `setupAuth` removido de `configureApp`,
 * abririam a carteira de contratos sem quebrar um único teste.
 *
 * A prova de que a lacuna era real: durante a validação do Enterprise, um arnês
 * que subia o `AppModule` **sem** o bootstrap produziu `500` em vez de `401`, e
 * isso foi reportado como defeito da API. Não era — era o arnês. Um teste que
 * exercitasse a configuração de verdade teria respondido a pergunta em
 * segundos, em vez de custar uma investigação e uma correção de rumo.
 *
 * ## Por que ele sobe a aplicação inteira
 *
 * Porque o que está sendo verificado **é** a fiação. Um teste de controller com
 * o guard mockado provaria que o mock funciona. É também por isso que ele chama
 * `configureApp`, e não repete as chamadas de configuração: repetir faria o
 * teste passar mesmo depois de alguém remover o `setupAuth` da aplicação real.
 *
 * ## Capacidade, nunca hierarquia
 *
 * `platform-rbac.ts` documenta a regra e `sales-leads-authorization.spec.ts` a
 * prova no nível do caso de uso: operador não é "admin menor" que herda um
 * subconjunto do que a administração pode — cada papel tem exatamente a
 * permissão que a matriz lista, nem mais. Leads comerciais é `leads:read`,
 * de `ALLVA_SALES`/`ALLVA_ADMIN`; operador não tem essa linha na matriz, e
 * por isso as rotas de leitura administrativa não têm todas o mesmo dono. Um
 * teste que assumisse "operador passa em todas" reintroduziria a hierarquia
 * pela porta dos fundos — foi exatamente essa suposição, aqui, que este
 * arquivo carregava até a matriz virar capacidade (commit `4f3d3f9`).
 */

const LABEL = 'admin-routes-authorization';
const SUFFIX = 'admin-routes-spec';
const USER_AGENT = 'admin-routes-authorization.spec';

let app: NestExpressApplication | null = null;
let baseUrl = '';
let prisma: PrismaService;
let skipReason = '';

/** Tokens emitidos no `beforeAll`, um por público. */
let operatorToken = '';
let memberToken = '';
let salesToken = '';
let organizationId = '';

const base64url = (value: Buffer | string) =>
  Buffer.from(value).toString('base64url');

/**
 * HS256 na mão, e não pelo provedor da aplicação.
 *
 * `JwtJoseProvider` carrega `jose` por import dinâmico — a biblioteca é
 * ESM-only —, e isso não resolve dentro da VM do Jest sem
 * `--experimental-vm-modules`. Ligar essa flag mudaria o runner de todo o
 * projeto para poder assinar uma string aqui.
 *
 * Assinar é **preparo**: o que está sob teste é o que a aplicação faz com o
 * token, e ela o verifica pelo caminho de verdade. Um token assinado com o
 * mesmo segredo e o mesmo algoritmo é indistinguível do que o login emite —
 * se deixasse de ser, a verificação recusaria e este teste falharia, que é o
 * comportamento certo.
 */
function signHs256(payload: Record<string, unknown>, secret: string): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const body = base64url(
    JSON.stringify({ ...payload, iat: now, exp: now + 3600 }),
  );
  const signature = createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64url');

  return `${header}.${body}.${signature}`;
}

/**
 * Sessão real, e não só um JWT assinado: o token carrega `sid` e o middleware
 * o resolve contra a tabela. Um `sid` inventado renderia um token que parece
 * válido e é recusado — que foi como a primeira versão desta verificação
 * concluiu, errado, que o operador não tinha acesso.
 */
async function issueToken(account: {
  id: string;
  email: string;
  name: string;
}): Promise<string> {
  const session = await prisma.session.create({
    data: {
      id: randomUUID(),
      accountId: account.id,
      refreshTokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      userAgent: USER_AGENT,
    },
  });

  return signHs256(
    {
      sub: account.id,
      sid: session.id,
      email: account.email,
      name: account.name,
    },
    process.env.JWT_SECRET_KEY as string,
  );
}

async function status(path: string, token?: string): Promise<number> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return response.status;
}

beforeAll(async () => {
  const database = await requireDatabaseWhenExpected(LABEL);

  if (!database.reachable) {
    skipReason = database.reason;
    return;
  }

  app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    logger: false,
  });
  // A configuração da aplicação de verdade — é ela que está sob teste.
  configureApp(app);
  await app.listen(0);
  baseUrl = (await app.getUrl()).replace('[::1]', 'localhost');

  prisma = app.get(PrismaService);

  if (!process.env.JWT_SECRET_KEY) {
    skipReason = 'JWT_SECRET_KEY ausente — sem ela não há token a emitir';
    return;
  }

  /**
   * Cria os três papéis, em vez de procurá-los.
   *
   * `findFirst` por papel devolvia `null` no banco vazio do CI, e o spec pulava:
   * as rotas administrativas ficavam sem teste de autorização — justamente a
   * asserção que ele existe para fazer.
   *
   * O inquilino vem do fixture compartilhado; os três papéis são deste teste,
   * porque é o contraste entre eles que está sob prova — inclusive o contraste
   * entre operador e comercial, que não são o mesmo "nível" de acesso.
   */
  const tenant = await ensureTenant(prisma, SUFFIX);

  const operator = await prisma.account.upsert({
    where: { id: `${SUFFIX}-operator` },
    update: {},
    create: {
      id: `${SUFFIX}-operator`,
      name: 'Operador',
      email: `${SUFFIX}-operator@exemplo.test`,
      passwordHash: 'nao-usado-em-teste',
      role: 'ALLVA_OPERATOR',
    },
  });

  const member = await prisma.account.upsert({
    where: { id: `${SUFFIX}-member` },
    update: {},
    create: {
      id: `${SUFFIX}-member`,
      name: 'Membro comum',
      email: `${SUFFIX}-member@exemplo.test`,
      passwordHash: 'nao-usado-em-teste',
      role: 'USER',
    },
  });

  const sales = await prisma.account.upsert({
    where: { id: `${SUFFIX}-sales` },
    update: {},
    create: {
      id: `${SUFFIX}-sales`,
      name: 'Comercial',
      email: `${SUFFIX}-sales@exemplo.test`,
      passwordHash: 'nao-usado-em-teste',
      role: 'ALLVA_SALES',
    },
  });

  const organization = { id: tenant.organizationId };

  organizationId = organization.id;
  operatorToken = await issueToken(operator);
  memberToken = await issueToken(member);
  salesToken = await issueToken(sales);
}, 120_000);

/**
 * Timeout próprio: derrubar a aplicação inteira — filas, agendadores, pool do
 * Prisma — passa dos 5 s padrão do Jest, e o estouro reprovava a suíte com
 * todos os casos verdes.
 */
afterAll(async () => {
  if (prisma) {
    await prisma.session.deleteMany({ where: { userAgent: USER_AGENT } });
    // Os três papéis saem antes do inquilino: nenhum deles é dono dele.
    await prisma.account.deleteMany({
      where: {
        id: {
          in: [`${SUFFIX}-operator`, `${SUFFIX}-member`, `${SUFFIX}-sales`],
        },
      },
    });
    await removeTenant(prisma, SUFFIX);
  }
  await app?.close();
}, 60_000);

/**
 * As três rotas de leitura, uma por controller administrativo.
 *
 * Leitura porque o que se verifica é o portão, não o efeito: um `POST` provaria
 * a mesma coisa e deixaria escrita para trás em cada passada.
 *
 * As três exigem **algum** papel de plataforma — é o que as três primeiras
 * asserções abaixo verificam, juntas. Qual papel específico cada uma exige é
 * outra pergunta, e é onde elas divergem: contratos e cota são `orgs:read`
 * (operador tem); leads comerciais é `leads:read` (operador não tem — ver
 * `LEADS_ROUTE` e os testes de "operador" e "comercial" adiante).
 */
const LEADS_ROUTE: [string, string] = [
  'leads comerciais',
  '/api/v1/admin/sales-leads',
];

const ADMIN_READ_ROUTES = () => [
  ['contratos', '/api/v1/admin/contracts'],
  LEADS_ROUTE,
  [
    'cota da organização',
    `/api/v1/admin/organizations/${organizationId}/quota`,
  ],
];

/** As rotas de leitura que a permissão do operador (`orgs:read`) de fato cobre. */
const OPERATOR_READ_ROUTES = () =>
  ADMIN_READ_ROUTES().filter(([nome]) => nome !== LEADS_ROUTE[0]);

describe('autorização das rotas administrativas', () => {
  it('o banco está alcançável (senão os casos abaixo são pulados)', () => {
    if (skipReason) {
      console.warn(`[${LABEL}] pulado: ${skipReason}`);
    }
    expect(true).toBe(true);
  });

  it('sem token: 401 em todas', async () => {
    if (skipReason) return;

    for (const [nome, path] of ADMIN_READ_ROUTES()) {
      expect([nome, await status(path)]).toEqual([nome, 401]);
    }
  });

  it('com token inválido: 401 em todas', async () => {
    if (skipReason) return;

    /**
     * O middleware de autenticação é permissivo por construção: um token que
     * não verifica não derruba a requisição, ele deixa `req.user` vazio e
     * segue. Quem transforma isso em `401` é o guard global — sem ele, o
     * controller receberia `undefined` e estouraria `500`, que é o que um
     * backoffice com sessão expirada leria em vez de "faça login de novo".
     */
    for (const [nome, path] of ADMIN_READ_ROUTES()) {
      expect([nome, await status(path, 'nao-e-um-token')]).toEqual([nome, 401]);
    }
  });

  it('autenticado sem papel de plataforma: 403 em todas', async () => {
    if (skipReason) return;

    // `403`, e não `404`: a conta existe e a rota existe — o que falta é
    // permissão, e dizer outra coisa mandaria o cliente do backoffice procurar
    // um recurso que está lá.
    for (const [nome, path] of ADMIN_READ_ROUTES()) {
      expect([nome, await status(path, memberToken)]).toEqual([nome, 403]);
    }
  });

  it('operador: 200 nas rotas que a permissão dele cobre', async () => {
    if (skipReason) return;

    /**
     * O outro lado da asserção, e o que impede a proteção de virar bloqueio: um
     * guard que recusasse todo mundo passaria nos três casos acima. Só nas
     * rotas que `orgs:read` cobre — leads comerciais não é uma delas, e é o
     * próximo teste que prova isso, não este.
     */
    for (const [nome, path] of OPERATOR_READ_ROUTES()) {
      expect([nome, await status(path, operatorToken)]).toEqual([nome, 200]);
    }
  });

  it('operador: 403 em leads comerciais — capacidade, não hierarquia', async () => {
    if (skipReason) return;

    // O caso que a suposição "operador passa em tudo" escondia: `leads:read`
    // não está na matriz do operador, só na do comercial e da administração
    // (`platform-rbac.ts`). Um operador com sessão válida e nenhum outro papel
    // continua sem ver a base de leads.
    const [, path] = LEADS_ROUTE;
    expect(await status(path, operatorToken)).toBe(403);
  });

  it('comercial: 200 em leads comerciais', async () => {
    if (skipReason) return;

    // O outro lado do teste acima: a permissão existe e alcança quem a matriz
    // diz que deveria — sem isto, os dois testes de recusa (operador, membro)
    // provariam só que a rota bloqueia todo mundo, nunca que ela abre para
    // alguém.
    const [, path] = LEADS_ROUTE;
    expect(await status(path, salesToken)).toBe(200);
  });
});
