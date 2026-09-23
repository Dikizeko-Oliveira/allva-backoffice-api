import {
  Organization,
  OrganizationSubscription,
  OrganizationUser,
} from '../entities';

export abstract class OrganizationsRepositoryInterface {
  /**
   * Persiste uma organização **nascida inteira**: a linha da organização, a sua
   * configuração de ads (D16/A10), a participação OWNER do criador e a
   * assinatura que declara o plano, numa transação só.
   *
   * Não existe `save(organization)` sozinho, e a ausência é o ponto. As quatro
   * escritas são as quatro pernas de uma organização utilizável — sem a
   * configuração, os motores de A2-S4 não têm régua para medir a mídia dela;
   * sem a participação, o dono não tem permissão na própria organização, porque
   * é a participação que o RBAC lê, não `owner_id`; sem a assinatura, as
   * dezesseis guardas de `ENFORCED_FEATURE_KEYS` leem plano nulo e negam tudo.
   * Uma assinatura que aceitasse só a primeira deixaria as outras na memória de
   * quem escreve o próximo caminho de criação — e o histórico diz como isso
   * termina duas vezes: a organização provisionada por lead nasceu sem
   * configuração por várias sprints, e a organização do cadastro nasceu sem
   * plano, respondendo `PLAN_FEATURE_NOT_INCLUDED` a quem tinha plano.
   */
  abstract saveWithOwner(
    organization: Organization,
    owner: OrganizationUser,
    subscription: OrganizationSubscription,
  ): Promise<void>;
  abstract update(organization: Organization): Promise<void>;
  abstract findById(id: string): Promise<Organization | null>;
  /**
   * A organização **mais antiga** da conta.
   *
   * Deixou de ser "a" organização quando `owner_id` perdeu o `@unique`: uma
   * conta pode possuir várias. Continua existindo porque quase todo chamador
   * quer a de referência, e a ordem explícita é o que torna a escolha
   * determinística em vez de "a que o banco devolver primeiro".
   */
  abstract findByOwnerId(ownerId: string): Promise<Organization | null>;

  /** Quantas a conta possui — o que a guarda de plano compara com o teto. */
  abstract countByOwnerId(ownerId: string): Promise<number>;

  /** Todas as que a conta possui — o seletor de workspace as une às participações. */
  abstract listByOwnerId(ownerId: string): Promise<Organization[]>;
  abstract listByIds(ids: string[]): Promise<Organization[]>;
}
