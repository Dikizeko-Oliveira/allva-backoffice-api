import { EnterpriseContract } from '../entities';

export type ListContractsFilter = {
  status?: string;
  organizationId?: string;
  page: number;
  pageSize: number;
};

export type ListContractsResult = {
  items: EnterpriseContract[];
  total: number;
  page: number;
  pageSize: number;
};

/**
 * Um contrato vivo com o que o ciclo de vida precisa saber dele.
 *
 * Traz a fatura em aberto mais antiga junto porque a decisão de suspender é a
 * mesma que a leitura de acesso já toma — e o job chama `resolveContractAccess`
 * com estes dados, em vez de reimplementar a régua. É o que garante que o
 * status gravado e o calculado nunca divirjam.
 */
export type ContractLifecycleRef = {
  id: string;
  organizationId: string | null;
  status: string;
  startsAt: Date;
  endsAt: Date;
  gracePeriodDays: number;
  oldestUnpaidDueAt: Date | null;
  /** Já existe um contrato apontando para este como origem da renovação. */
  hasSuccessor: boolean;
};

/** Um contrato ativo cuja organização ainda não teve a IA precificada. */
export type ContractWithoutAiBudget = {
  contractId: string;
  number: string;
  status: string;
  organizationId: string;
  organizationName: string;
  activatedAt: Date | null;
  /**
   * Os anúncios que o contrato vendeu — a escala que dimensiona o teto.
   *
   * Vem junto porque é o que torna a lista acionável: 300 anúncios e 40.000
   * pedem tetos de ordens diferentes, e sem o número o operador teria de abrir
   * cada contrato para saber qual é qual.
   *
   * Nulo é "herda o plano". O custo em reais **não** vem daqui de propósito:
   * seria uma constante de moeda no domínio, e ela apodrece em silêncio no
   * primeiro reajuste de fornecedor. Quem responde isso é `pnpm ai:cost`, com
   * dado medido.
   */
  maxMonitoredAds: number | null;
};

/** Os nomes que uma tela de contrato mostra e o agregado não carrega. */
export type ContractLabels = {
  leadCompanyName: string;
  organizationName: string | null;
  planName: string;
  createdAt: Date;
};

export abstract class EnterpriseContractsRepositoryInterface {
  abstract findById(id: string): Promise<EnterpriseContract | null>;

  /**
   * O contrato que governa o acesso desta organização **agora**.
   *
   * Uma organização acumula contratos ao longo do tempo — a renovação gera um
   * novo e preserva o anterior como histórico comercial. Quem responde por
   * acesso é o vigente, e é por isso que a busca é por organização e não uma
   * lista: quem pergunta é o resolver de entitlement, que precisa de uma
   * resposta, não de uma coleção para desempatar.
   */
  abstract findLiveByOrganizationId(
    organizationId: string,
  ): Promise<EnterpriseContract | null>;

  /**
   * Todos os contratos vivos da organização.
   *
   * Diferente de `findLiveByOrganizationId`, que já desempata: aqui quem
   * pergunta precisa do conjunto. A ativação usa isto para recusar uma vigência
   * que se sobrepõe a outra — a pergunta não é "qual governa?", é "algum destes
   * cobre os mesmos dias?".
   */
  abstract listLiveByOrganizationId(
    organizationId: string,
  ): Promise<EnterpriseContract[]>;

  abstract list(filter: ListContractsFilter): Promise<ListContractsResult>;

  /**
   * Contratos ativos cuja organização está **sem teto diário de gasto com IA**.
   *
   * ## Por que uma listagem, e não um campo obrigatório
   *
   * A alternativa era travar a ativação até o comercial precificar a IA. Ela
   * resolve o esquecimento e cria um problema pior: um contrato assinado que
   * não entra no ar porque falta um número que ninguém tem ainda — e o número
   * honesto só existe depois de uma semana de operação real (`pnpm ai:cost`).
   *
   * ## Por que a ausência precisa ser vista, e não só logada
   *
   * Sem teto é uma escolha defensável — melhor que cortar entrega contratada
   * com um número de autoatendimento. O que ela não pode ser é escolha por
   * omissão. O provisionamento já registra `provisioning.sem_teto_de_ia`, e log
   * é fácil de não ler; esta lista é a mesma informação num lugar onde alguém
   * de fato procura.
   *
   * Só contrato **provisionado** entra: antes da ativação não há organização, e
   * portanto não há linha de configuração onde faltar um teto.
   */
  abstract listWithoutAiBudget(): Promise<ContractWithoutAiBudget[]>;

  /**
   * Empresa do lead, organização e plano de cada contrato, numa consulta só.
   * Sem isto, cada linha da lista do painel custava três `GET` a mais.
   */
  abstract findLabels(ids: string[]): Promise<Map<string, ContractLabels>>;

  abstract save(contract: EnterpriseContract): Promise<void>;
  abstract update(contract: EnterpriseContract): Promise<void>;

  /**
   * O próximo número da sequência do ano — `ENT-2026-0012`.
   *
   * Mora no repositório porque a resposta depende do que já foi gravado. A
   * unicidade de `contract_number` é a rede: duas criações simultâneas no mesmo
   * segundo produzem o mesmo número, e a segunda falha alto em vez de gravar um
   * duplicado silencioso.
   */
  abstract nextContractNumber(year: number): Promise<string>;

  /**
   * Os contratos vivos, com o estado de pagamento, para o job de ciclo de vida.
   *
   * `limit` porque é um job: a carteira inteira numa passada seguraria conexão
   * do pool sem necessidade, e a próxima hora pega o resto.
   */
  abstract listLive(now: Date, limit: number): Promise<ContractLifecycleRef[]>;
}
