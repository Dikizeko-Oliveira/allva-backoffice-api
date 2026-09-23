import type {
  ActionLevel,
  AdActionType,
  FormatScope,
} from 'src/modules/ads/domain/platform/platform-profile';
import type { AdActionParameters } from 'src/modules/ads/domain/actions/action-parameters.schema';
import type { AdUnitKind } from 'src/modules/ads/domain/ad-unit';

/**
 * O vocabulário de §13.2 — o que um gateway de escrita recebe, devolve e
 * declara saber fazer.
 *
 * Os tipos vivem no domínio porque são **contrato**, não detalhe de transporte:
 * é sobre eles que a capability registry responde "esta ação é oferecível?", e é
 * neles que o caminho de execução decide entre repetir, recusar e desistir.
 */

/** Onde a validação chegou — e, por consequência, o que ela ainda não sabe. */
export type ValidationDepth = 'LOCAL_ONLY' | 'PLATFORM';

/**
 * O que uma plataforma declara sobre um tipo de ação.
 *
 * **`supported: false` é resposta, não erro** (P6). Uma ação que a plataforma
 * não faz é declarada com motivo e nunca oferecida — o oposto de descobrir isso
 * num 400 depois do clique do usuário.
 */
export type AdActionCapability = {
  type: AdActionType;
  supported: boolean;
  reversible: boolean;
  /**
   * A plataforma não edita: recria. O anúncio ganha id novo, o aprendizado
   * reinicia e a prova social zera — o usuário precisa saber **antes** de
   * confirmar (§13.3), e a linhagem precisa saber depois (§9.5 passo 6).
   */
  requiresRecreate: boolean;
  /** P1 — toda derivação de mídia é declarada, nunca silenciosa. */
  createsEntity: boolean;
  /**
   * Até onde o dry-run consegue verificar. `LOCAL_ONLY` pega parâmetro faltante
   * e moeda errada; só `PLATFORM` pega "este ad set está sob CBO e não aceita
   * orçamento próprio". Um dry-run local que aprova 100 anúncios aprova
   * exatamente as operações que a plataforma vai recusar.
   */
  validationDepth: ValidationDepth;
  constraints?: Record<string, unknown>;
  unsupportedReason?: string;
  /**
   * A ação só existe para anúncios destes formatos. Ausente: todos.
   *
   * Tipado, e não em `constraints`, porque a disponibilidade **decide** por ele:
   * no Google, trocar título vale para o anúncio de busca e trocar CTA para o
   * de display — oferecer as duas em todo anúncio era oferecer botões que só
   * falhavam na execução.
   */
  formats?: FormatScope;
  /**
   * As unidades sobre as quais a ação existe, em qualquer nível. Ausente: só o
   * anúncio.
   *
   * O padrão é fechado de propósito. O grupo de recursos do Performance Max é
   * outro recurso na plataforma, e uma ação escrita para anúncio mandaria a
   * escrita para um id que não é de anúncio; a campanha de um anúncio Smart+
   * tem rota própria no TikTok. Cada ação precisa **declarar** que sabe
   * escrever sobre a unidade antes de ser oferecida nela (D23/D24).
   */
  units?: readonly AdUnitKind[];
};

/** A entidade em que a ação incide — o alvo de I2 (§13.5). */
export type ActionTarget = {
  type: ActionLevel;
  /**
   * O id do domínio. É por ele que I2 exclui escritas concorrentes: dois
   * anúncios do mesmo conjunto disputam a mesma entidade, e o id externo só
   * existe depois da resolução de credencial.
   */
  internalId: string;
  /** O id na plataforma, resolvido no momento da execução. */
  externalId: string;
};

export type AdActionCommand = {
  type: AdActionType;
  level: ActionLevel;
  target: ActionTarget;
  parameters: AdActionParameters;
  /**
   * Moeda da **conta** (M3). Viaja no comando porque o gateway converte valor
   * monetário para a unidade menor da plataforma, e fazê-lo com a moeda-base
   * moveria dinheiro real na quantia errada.
   */
  accountCurrency: string;
};

export type ExecutionContext = {
  /** A chave que a plataforma recebe para não executar duas vezes (A8, ⊕2). */
  idempotencyKey: string;
  /** A integração cujo orçamento de chamadas esta escrita consome (R4). */
  integrationId: string;
  externalAccountId: string;
  accessToken: string;
  correlationId: string | null;
  attempt: number;
};

export type ValidationFailure = {
  code: string;
  message: string;
  field?: string;
};

export type ValidationResult = {
  valid: boolean;
  /** Onde a validação parou. Uma aprovação `LOCAL_ONLY` não é uma aprovação. */
  depth: ValidationDepth;
  failures: ValidationFailure[];
};

/**
 * O desfecho de uma escrita, do ponto de vista da plataforma.
 *
 * As quatro possibilidades não são graus do mesmo eixo: `FAILED` pede retry,
 * `REJECTED_BY_PLATFORM` pede que o usuário mude alguma coisa, e `UNSUPPORTED`
 * diz que não havia o que tentar. Colapsá-las num booleano faria o worker
 * repetir indefinidamente uma ação que a plataforma nunca vai aceitar.
 */
export type AdActionResult = {
  /**
   * `PARTIALLY_COMPLETED`: a plataforma **criou** a entidade e a sequência não
   * terminou. Nunca repetível — repetir criaria outra.
   */
  status:
    | 'SUCCEEDED'
    | 'FAILED'
    | 'REJECTED_BY_PLATFORM'
    | 'UNSUPPORTED'
    | 'PARTIALLY_COMPLETED';
  /**
   * Em `PARTIALLY_COMPLETED`: a entidade criada pode estar entregando. Uma ação
   * da Allva nunca deve aumentar gasto em silêncio, e é este campo que faz o
   * desfecho virar alerta crítico em vez de uma linha no histórico.
   */
  exposureRisk?: boolean;
  /**
   * O id novo quando a ação recria. **Persistido em `ActionExecution`**: sem
   * ele, o outcome de P8 mede o anúncio antigo e lê "gasto foi a zero" como
   * sucesso absoluto, quando o gasto só saiu do campo de visão.
   */
  platformEntityId?: string;
  raw?: unknown;
  errorCode?: string;
  errorMessage?: string;
  retryable: boolean;
};

/**
 * O estado observado na plataforma, para a escada de verificação.
 *
 * A verificação não pergunta "deu certo?" — o `execute` já respondeu isso. Ela
 * pergunta *"a plataforma concorda com o que achamos que fizemos?"*, e a
 * diferença entre as duas é o que separa uma escrita confirmada de uma escrita
 * aceita e revertida por uma regra da plataforma dois minutos depois.
 */
export type ObservedEntityState = {
  status: string | null;
  dailyBudgetMinor?: string | null;
  lifetimeBudgetMinor?: string | null;
  raw?: unknown;
};
