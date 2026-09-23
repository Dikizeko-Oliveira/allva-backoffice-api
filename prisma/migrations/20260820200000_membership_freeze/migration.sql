-- Congelamento de assentos por limite de plano.
--
-- `SeatLimitService` só recusava convite novo: quem descia do Profissional (10)
-- para o Individual (3) ficava com 10 membros ativos indefinidamente. Custo sem
-- receita, e um convite a assinar o plano caro, descer e manter tudo.
--
-- Coluna própria e não `status = BLOCKED`: bloqueio é decisão de administrador,
-- e o upgrade precisa descongelar o que o plano congelou sem reativar quem
-- alguém desligou de propósito.
ALTER TABLE "organization_users" ADD COLUMN "frozen_at" TIMESTAMP(3);

CREATE INDEX "organization_users_organization_id_frozen_at_idx"
  ON "organization_users"("organization_id", "frozen_at");
