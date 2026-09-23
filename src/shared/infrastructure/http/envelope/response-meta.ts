/**
 * O `meta` de §7.0.1 — a parte da resposta que responde "de onde veio esse
 * número".
 *
 * P7: *nenhum número sem procedência, nenhum diagnóstico sem evidência mínima*.
 * Um score de 41 sem `asOf` e sem `algoVersion` não é informação — é uma
 * afirmação que ninguém consegue contestar nem reproduzir.
 */

/**
 * `DataMaturity` e `EvidenceSufficiency` **mudaram de endereço em A2-S5**, e a
 * mudança foi cobrada pelo harness: os detectores declaram `evidenceSufficiency`
 * no achado que produzem, e domínio não importa infraestrutura (§16.6).
 *
 * O reexport preserva o ponto de importação de quem já os consumia — o que
 * mudou é onde eles nascem, não como se lê a resposta.
 */
import type {
  DataMaturity,
  EvidenceSufficiency,
} from 'src/shared/domain/provenance';

export type { DataMaturity, EvidenceSufficiency };

/**
 * As versões que produziram o número. Todas opcionais porque nem toda rota tem
 * todas — uma listagem de waste não tem `engineVersion` —, mas uma rota de
 * inteligência sem **nenhuma** delas é violação de P7, e o harness cobra.
 */
export type Provenance = {
  /** A janela ativa da organização (DEC-11: o rollup a declara, não a filtra). */
  windowDays?: number;
  algoVersion?: string;
  detectorVersion?: string;
  detectorProfileVersion?: string;
  engineVersion?: string;
  /**
   * A **terceira** coisa versionada do sistema (§4.5), ao lado de `algoVersion`
   * e `detectorVersion` — e a última a ganhar procedência, porque só passou a
   * produzir número em A2-S9.
   *
   * §20-H3 condiciona a automação supervisionada a 90 dias de acurácia, e em 90
   * dias a lógica de medição muda pelo menos uma vez. Sem a versão na resposta,
   * quem lê não tem como saber que dois números do mesmo painel vieram de
   * réguas diferentes.
   */
  measurementVersion?: string;
  /**
   * A versão do prompt que escreveu o texto — **a quarta coisa versionada**.
   *
   * Entrou com a geração de copy, e é a primeira superfície em que a IA produz
   * o artefato em vez de explicá-lo. D16 já fazia de `activePromptVersions` um
   * mapa por tarefa justamente porque os prompts evoluem em ritmos diferentes;
   * sem a versão na resposta, comparar duas gerações do mesmo anúncio não diria
   * se a diferença veio do anúncio ou de uma reescrita de instrução nossa.
   *
   * Anda junto de `aiProvider` e `aiModel` pelo mesmo motivo: aqui a
   * procedência não é do número, é do texto que vai ao ar sob a marca do
   * cliente.
   */
  promptVersion?: string;
  aiProvider?: string | null;
  aiModel?: string | null;
  /** Itens deixados de fora por não casarem a janela declarada (DEC-11). */
  excludedByWindowMismatch?: number;
  /**
   * Quantos ficaram fora da ordenação pelos pisos de §12.4.
   *
   * O número, e não só o rótulo `PARTIAL`: "alguns itens foram omitidos" é uma
   * informação que o usuário não consegue usar. "3 de 240 ficaram fora por
   * confiança abaixo de 0,40" é — ele decide se investiga ou se ignora.
   */
  excludedByScoreFloor?: number;
  /**
   * A leitura foi cortada no piso de histórico do plano, e esta é a data.
   *
   * Presente **só quando cortou**: a ausência significa que a janela pedida
   * coube inteira. Declarar é o que impede a série truncada de ser lida como a
   * série real — o usuário concluiria coisas erradas sobre a própria mídia por
   * causa de um limite comercial que ninguém lhe mostrou.
   */
  historyTruncatedAt?: string;
};

/**
 * §12.2 — quanto do modelo de score cada plataforma **permite** cobrir.
 *
 * Vai no `meta` porque a comparabilidade entre plataformas é preservada por
 * declaração, não por exclusão: sem isto, um anúncio de Search com cobertura
 * 0,45 e um de Meta com 0,45 apareceriam idênticos na lista — e o primeiro está
 * no teto do que é possível medir, enquanto o segundo perdeu metade do sinal.
 */
export type CoverageByPlatform = Record<string, number>;

export type OrganizationMeta = {
  baseCurrency: string;
  /**
   * §8.7: em `RECOMPUTING_CURRENCY` os números da organização estão sendo
   * reescritos. A tela precisa saber disso para não apresentar um agregado a
   * meio caminho como se fosse o valor final.
   */
  recomputingCurrency: boolean;
};

/**
 * §7.0.5 — **duas formas de paginar, e `hasMore` é a única comum às duas.**
 *
 * Lista volátil (inteligência) devolve `nextCursor`: a ordenação muda a cada
 * ciclo, e "página 2" deixaria de significar a mesma coisa entre duas cargas.
 * Lista de **contexto** devolve `total` e pagina por `page`/`limit` — que ali
 * sempre foi o certo, porque a ordenação é estável (`/creatives` ordena por
 * `name, id`, que não se reordenam sozinhos).
 *
 * **`total` em vez de `nextCursor`, e nada além disso**, no lado do contexto:
 * página e limite o cliente já sabe, foi ele quem os pediu; o que ele não tem
 * como saber é quantos existem do outro lado. Sem esse campo a rota paginava
 * sem dizer, e a tela não tinha como oferecer "Próxima" sem chutar.
 *
 * Os dois campos são opcionais porque **cada rota preenche um** — ler o campo
 * da outra forma é sinal de que o cliente supôs a paginação errada.
 */
export type PageMeta = {
  /** Listas por cursor. Opaco: repasse como `cursor=`, não parseie. */
  nextCursor?: string | null;
  /** Listas de contexto (`page`/`limit`): quantos existem no total. */
  total?: number;
  hasMore: boolean;
};

export type ResponseMeta = {
  /** Instante a que o dado se refere — não o instante da resposta. */
  asOf?: string;
  dataMaturity?: DataMaturity;
  evidenceSufficiency?: EvidenceSufficiency;
  provenance?: Provenance;
  organization?: OrganizationMeta;
  page?: PageMeta;
  coverageByPlatform?: CoverageByPlatform;
};

/**
 * O que um handler devolve para ser envelopado. É uma classe, e não um objeto
 * literal, porque o interceptor precisa distinguir "resposta ads-first" de
 * "objeto que por acaso tem as chaves `data` e `meta`" — e um `instanceof` é a
 * única checagem que não erra.
 */
export class EnvelopedResult<T> {
  constructor(
    readonly data: T,
    readonly meta: ResponseMeta = {},
  ) {}
}

/** Açúcar de leitura: `return envelope(items, { asOf, provenance })`. */
export function envelope<T>(data: T, meta: ResponseMeta = {}) {
  return new EnvelopedResult(data, meta);
}
