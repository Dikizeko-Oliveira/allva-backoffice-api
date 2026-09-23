import { readSourceFiles, SRC_ROOT } from './support/source-tree';

/**
 * **P8 como gate de código, não só de dados.**
 *
 * > *"Toda `Recommendation` em `APPLIED` com janela pós completa tem outcome
 * > persistido; nenhuma mudança de versão sem relatório de replay."*
 *
 * A metade "com janela completa" só é verificável contra um banco com histórico,
 * e `recommendation-outcomes.spec` cobre a consulta. O que **este** arquivo
 * protege é a metade estrutural, e é a que quebra primeiro: o ciclo de §17.3 só
 * fecha se cada elo existir e apontar para o seguinte.
 *
 * A razão de existir é concreta. Entre A2-S6 e A2-S8, `capturePreWindow` viveu
 * no repositório **sem um único chamador**: o plano declarava a captura pré-janela
 * como entregue, `tsc` não tinha o que reclamar — um método não chamado compila —
 * e nenhum teste montava a cadeia inteira. A ausência só apareceu ao escrever a
 * medição, três sprints depois, e teria custado 90 dias de histórico se a
 * medição tivesse ficado para a v2.1.
 */

const sources = readSourceFiles(SRC_ROOT);

function read(path: string): string {
  const file = sources.find((candidate) => candidate.path.endsWith(path));
  if (!file) throw new Error(`Arquivo esperado não encontrado: ${path}`);
  return file.content;
}

function exists(path: string): boolean {
  return sources.some((candidate) => candidate.path.endsWith(path));
}

describe('os seis passos de §17.3 têm elo no código', () => {
  it('3. agir — o apply real existe e passa pelo caminho de escrita único', () => {
    const useCase = read('apply-recommendation-plan.usecase.ts');

    // O gate de P5: aplicar não pode ter caminho próprio de escrita.
    expect(useCase).toMatch(/ApplyPlanExecutorService/);
    expect(read('apply-plan-executor.service.ts')).toMatch(
      /ExecuteActionUseCase/,
    );
    // E ele revalida a premissa antes de qualquer escrita (§9.5 passo 1).
    expect(useCase).toMatch(/revalidate\(/);
  });

  it('4. confirmar — a escada de verificação continua ligada à execução', () => {
    expect(read('verify-action.service.ts')).toMatch(/verifyWrite/);
  });

  /**
   * O elo que faltava até A2-S9, e o que este teste existe para travar: alguém
   * tem de **chamar** a captura. Um método de repositório sem chamador é
   * indistinguível de um entregue, para `tsc` e para o plano.
   */
  it('5. registrar o pré — `buildPreWindow` tem chamador na liquidação', () => {
    const application = read('recommendation-application.service.ts');

    expect(application).toMatch(/buildPreWindow/);
    expect(application).toMatch(/markApplied/);

    // E a transição e o outcome andam juntos, no repositório (§9.5 passo 6).
    expect(read('recommendations-prisma.repository.ts')).toMatch(
      /\$transaction[\s\S]{0,600}recommendationOutcome\.create/,
    );
  });

  it('6. medir — o job existe, é disparado e emite o evento', () => {
    const service = read('measure-outcomes.service.ts');

    expect(service).toMatch(/buildPostWindow/);
    expect(service).toMatch(/recordMeasurement/);
    expect(service).toMatch(/recommendation\.outcome\.measured/);

    // Sem worker e sem cron, o serviço é código morto com testes verdes.
    expect(read('recommendations.worker.ts')).toMatch(/MeasureOutcomesService/);
    expect(read('recommendations.scheduler.ts')).toMatch(/measureOutcomes/);
  });

  it('a medição segue a LINHAGEM, não o ad_id (§3.6, R6)', () => {
    // Medir por `ad_id` leria "gasto foi a zero" como sucesso absoluto quando o
    // gasto só migrou para o sucessor de um `REPLACE_*`.
    expect(read('measure-outcomes.service.ts')).toMatch(/lineageId/);
    expect(read('recommendation-outcomes-prisma.repository.ts')).toMatch(
      /lineageId: input\.lineageId/,
    );
  });
});

describe('nenhum método de port dos módulos de A2-S9 fica sem chamador', () => {
  /**
   * A generalização do defeito acima — e a **lição** do sprint, que não é sobre
   * os métodos de outcome.
   *
   * Um método de port declarado e nunca invocado é uma entrega que existe no
   * plano e não no produto. `tsc` não o pega (um método não chamado compila) e
   * nenhum teste de unidade o pega (ele testa o que existe, não o que falta).
   * A primeira redação deste bloco listava **seis** métodos de outcome à mão, e
   * ela mesma reprovou contra um deles. O audit de fechamento encontrou outros
   * **três** fora da lista — `latestFor`, `accountingFor`, `snapshot` —, o que
   * mostrou que a lista à mão era o problema, não a solução.
   *
   * Agora a varredura é sobre os ports **inteiros** dos módulos que A2-S9 tocou.
   */
  const PORT_FILES = [
    'recommendations/domain/ports/recommendation-outcomes.repository.ts',
    'creative-lab/domain/ports/creative-analysis.repository.ts',
    'sync/domain/ports/retention.repository.ts',
  ];

  const consumers = sources.filter(
    (file) =>
      !file.path.includes('/domain/ports/') &&
      !file.path.includes('/infrastructure/database/'),
  );

  /** `abstract nome(` — os métodos que o port declara como contrato. */
  function abstractMethodsOf(portPath: string): string[] {
    const content = read(portPath);
    return [...content.matchAll(/abstract\s+(\w+)\s*\(/g)].map((m) => m[1]);
  }

  it.each(PORT_FILES)('todo método de `%s` tem chamador', (portPath) => {
    const methods = abstractMethodsOf(portPath);
    expect(methods.length).toBeGreaterThan(0);

    const orphans = methods.filter(
      (method) =>
        !consumers.some((file) =>
          new RegExp(`\\.${method}\\(`).test(file.content),
        ),
    );

    expect(orphans).toEqual([]);
  });
});

describe('a versão da medição é a terceira coisa versionada do sistema', () => {
  it('existe, viaja na procedência e é gravada em toda medição', () => {
    // §20-H3 mede acurácia ao longo de 90 dias, e em 90 dias esta lógica muda ao
    // menos uma vez. Sem a versão, duas réguas entram no mesmo denominador.
    expect(read('outcome-measurement.ts')).toMatch(/MEASUREMENT_VERSION/);
    expect(read('measure-outcomes.service.ts')).toMatch(
      /measurementVersion: MEASUREMENT_VERSION/,
    );
    expect(read('recommendation-read-use-cases.ts')).toMatch(
      /measurementVersion/,
    );
  });
});

describe('as duas rotas herdadas de A2-S5 e A2-S7 existem', () => {
  it('`apply-fix` (§10.9) mora em platform-actions, não em waste', () => {
    // Rota ≠ módulo (D3): corrigir é escrever, e `waste` não conhece quem escreve.
    expect(
      exists(
        'platform-actions/infrastructure/http/controllers/waste-fix.controller.ts',
      ),
    ).toBe(true);
    expect(read('waste-fix.controller.ts')).toMatch(/apply-fix/);
  });

  it('`POST /ads/{id}/analyze` substituiu `POST /creatives/{id}/optimize`', () => {
    expect(read('ad-analysis.controller.ts')).toMatch(
      /@Post\('\/:id\/analyze'\)/,
    );

    /**
     * A rota antiga saiu: nem parqueada, nem renomeada. O que a busca mede é o
     * **decorador**, não a palavra — a primeira redação procurava `optimize` no
     * arquivo e reprovava contra o comentário que explica a remoção, que é
     * exatamente o texto que se quer manter.
     */
    const creativeLab = read('creative-lab.controller.ts');
    expect(creativeLab).not.toMatch(/@(Post|Get)\([^)]*optimi/);
  });
});

/**
 * **Nenhum texto de usuário promete um sprint que já entregou.**
 *
 * O audit de fechamento de A2-S9 encontrou quatro placeholders citando A2-S4 e
 * A2-S6 como futuro — dois e três sprints depois de os dois terem entregue. Um
 * deles estava **fixado por teste**: `ads.controller.spec.ts` exigia que a razão
 * contivesse `'A2-S4'`, o que transformou o placeholder em contrato e o fez
 * sobreviver às duas entregas que deveriam tê-lo removido.
 *
 * A regra é estreita de propósito: um sprint **fechado** não pode aparecer em
 * string que o usuário lê. Comentário de código pode — é lá que a história fica.
 */
describe('nenhuma promessa de sprint já entregue chega ao usuário', () => {
  /** Todos fechados; a lista cresce quando um sprint fecha. */
  const DELIVERED = [
    'A2-S0',
    'A2-S1',
    'A2-S2',
    'A2-S3',
    'A2-S4',
    'A2-S5',
    'A2-S6',
    'A2-S7',
    'A2-S8',
    'A2-S9',
  ];

  /** Linhas de string literal, ignorando comentários de bloco e de linha. */
  function userFacingLines(content: string): string[] {
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter(
        (line) =>
          !line.startsWith('*') &&
          !line.startsWith('//') &&
          !line.startsWith('/*'),
      );
  }

  it.each(DELIVERED)('nenhuma string de usuário promete %s', (sprint) => {
    const offenders = sources
      .filter((file) => !file.path.endsWith('.spec.ts'))
      .flatMap((file) =>
        userFacingLines(file.content)
          .filter((line) => line.includes(sprint) && /['`"]/.test(line))
          .map((line) => `${file.path}: ${line.slice(0, 90)}`),
      );

    expect(offenders).toEqual([]);
  });
});
