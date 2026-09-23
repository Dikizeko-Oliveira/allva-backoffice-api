import { SRC_ROOT, readSourceFiles } from './support/source-tree';

/**
 * **Toda rota da superfície ads-first descreve a própria resposta.**
 *
 * O defeito que este gate nasceu para pegar sobreviveu dez sprints: os 13
 * controllers ads-first declaravam 47 `@ApiOperation` — um resumo em prosa — e
 * **zero** schema de resposta. `/docs-json` descrevia a superfície inteira do
 * produto sem shape, enquanto os módulos legados, anteriores à v2.0, tinham 22
 * `@ApiOkResponse`.
 *
 * A consequência não é estética. Quem integra tem duas saídas quando a rota não
 * declara o que devolve: ler os presenters no código-fonte, ou chamar e
 * observar. As duas produzem um cliente acoplado ao que a rota devolveu no dia
 * em que alguém olhou — e a segunda produz um cliente acoplado ao **dado de
 * teste**, que é pior, porque campos nulos naquele momento somem do tipo.
 *
 * `tsc` não tinha o que reclamar: uma rota sem decorator de resposta compila.
 * É a mesma família de "método de port sem chamador" que A2-S9 encontrou —
 * ausência não quebra build.
 */

/** Onde P7 vale, e onde o contrato de resposta precisa ser explícito. */
const INTELLIGENCE_MODULES = [
  'ads',
  'ad-scoring',
  'analytics',
  'creative-lab',
  'platform-actions',
  'recommendations',
  'sync',
  'waste',
];

const ROUTE_DECORATOR = /^\s*@(Get|Post|Patch|Put|Delete)\(/;

/**
 * Qualquer forma de declarar a resposta serve — inclusive
 * `@ApiServiceUnavailableResponse`, que é como uma rota parqueada declara
 * honestamente que não devolve dado. O gate cobra que **haja** contrato, não que
 * ele seja de sucesso.
 */
const RESPONSE_DECORATOR =
  /@(ApiEnvelopeResponse|ApiEnvelopeRawResponse|ApiOkResponse|ApiCreatedResponse|ApiResponse|ApiDomainError|ApiServiceUnavailableResponse)\s*\(/;

/**
 * Um controller inteiro pode declarar a resposta na classe — é o caso de
 * `creative-lab.controller.ts`, cuja única rota é parqueada e o
 * `@ApiServiceUnavailableResponse` vale para todas.
 */
function classLevelResponse(content: string): boolean {
  const classIndex = content.search(/^export class /m);
  if (classIndex < 0) return false;

  return RESPONSE_DECORATOR.test(content.slice(0, classIndex));
}

/**
 * As rotas de um controller e o bloco de decorators que antecede cada uma.
 *
 * Varredura por linha, e não por AST, pelo mesmo motivo dos outros gates deste
 * diretório: o harness não pode depender de compilar o projeto para dizer se o
 * projeto está certo.
 */
function routesWithoutResponse(file: { path: string; content: string }) {
  if (classLevelResponse(file.content)) return [];

  const lines = file.content.split('\n');
  const offenders: string[] = [];

  lines.forEach((line, index) => {
    if (!ROUTE_DECORATOR.test(line)) return;

    // O bloco de decorators vai do verbo HTTP até a assinatura do método. É
    // onde `@ApiOkResponse` e companhia moram, e é só ele que interessa.
    const block: string[] = [];
    for (let cursor = index; cursor < lines.length; cursor += 1) {
      block.push(lines[cursor]);
      if (/^\s{2}(async\s+)?[A-Za-z_$][\w$]*\s*\(/.test(lines[cursor])) break;
    }

    if (!RESPONSE_DECORATOR.test(block.join('\n'))) {
      offenders.push(`${file.path}:${index + 1} → ${line.trim()}`);
    }
  });

  return offenders;
}

const controllers = readSourceFiles(
  SRC_ROOT,
  (file) =>
    file.path.endsWith('.controller.ts') && !file.path.endsWith('.spec.ts'),
);

const intelligenceControllers = controllers.filter((file) =>
  INTELLIGENCE_MODULES.some((module) =>
    file.path.startsWith(`src/modules/${module}/`),
  ),
);

describe('Swagger — a superfície ads-first descreve a própria resposta', () => {
  it('há controllers de inteligência para verificar', () => {
    // Um filtro que passa a não casar nada transformaria este arquivo inteiro
    // numa suíte verde que não verifica coisa alguma.
    expect(intelligenceControllers.length).toBeGreaterThanOrEqual(13);
  });

  it('nenhuma rota de inteligência fica sem contrato de resposta', () => {
    const offenders = intelligenceControllers
      .flatMap(routesWithoutResponse)
      .sort();

    expect(offenders).toEqual([]);
  });

  /**
   * O envelope e o erro tipado entram por `$ref` para que o cliente gerado
   * tenha **um** `ResponseMeta` e **um** `DomainError`, e não um tipo anônimo
   * por rota. Inline, a procedência deixaria de ser comparável entre telas no
   * cliente — que é exatamente a razão de o `meta` existir.
   */
  it('o envelope de resposta é declarado por um helper, não à mão', () => {
    const handRolled = intelligenceControllers
      .filter((file) =>
        /@ApiOkResponse\(\{\s*schema:[\s\S]{0,300}?\bdata\b[\s\S]{0,300}?\bmeta\b/.test(
          file.content,
        ),
      )
      .map((file) => file.path)
      .sort();

    expect(handRolled).toEqual([]);
  });
});
