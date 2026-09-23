-- ═══════════════════════════════════════════════════════════════════════════
-- `ExecutionStatus.PARTIALLY_COMPLETED` e `AlertType.ACTION_PARTIALLY_COMPLETED`
--
-- ## O caso que isto nomeia
--
-- Duplicar um anúncio no TikTok é criar e depois pausar. Se a criação passa e a
-- pausa não é confirmada, a Allva deixou uma cópia possivelmente veiculando —
-- gasto que ninguém confirmou. Isso não é `FAILED` (algo mudou na mídia) nem
-- `SUCCEEDED` (o estado pedido era "duplicado e pausado"). Sem um status
-- próprio, o desfecho mais perigoso ficaria indistinguível de uma falha comum.
--
-- O alerta acompanha: crítico quando a entidade criada pode estar entregando.
--
-- `ADD VALUE` é aditivo e não reescreve linhas; nenhuma execução existente muda.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TYPE "ExecutionStatus" ADD VALUE IF NOT EXISTS 'PARTIALLY_COMPLETED';

ALTER TYPE "AlertType" ADD VALUE IF NOT EXISTS 'ACTION_PARTIALLY_COMPLETED';
