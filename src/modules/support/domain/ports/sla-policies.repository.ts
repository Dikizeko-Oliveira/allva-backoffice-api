import type { SlaPolicy } from '../entities';

export abstract class SlaPoliciesRepositoryInterface {
  abstract save(policy: SlaPolicy): Promise<void>;
  abstract update(policy: SlaPolicy): Promise<void>;
  abstract findById(id: string): Promise<SlaPolicy | null>;
  abstract list(): Promise<SlaPolicy[]>;
  abstract listActive(): Promise<SlaPolicy[]>;
  /** A política ativa do escopo, se houver — para recusar a segunda. */
  abstract findActiveByScope(
    priority: string,
    category: string | null,
  ): Promise<SlaPolicy | null>;
}
