-- Catálogo de planos para a landing page.
--
-- Duas mudanças, ambas aditivas:
--
--   1. `plan_features.key` + `.value` — a tabela só sabia dizer "sim/não". Um
--      limite ("300 anúncios monitorados") só cabia como texto dentro de `name`,
--      e aí a mesma feature vira quatro linhas distintas que nada relaciona. Com
--      `key` estável e o número em `value`, a página de comparação agrupa por
--      `key` e lê a coluna do plano.
--
--   2. `plans.amount_annual` + `.stripe_price_id_annual` — `Subscription.is_annual`
--      já existe, mas o preço anual não tinha onde morar: uma coluna `amount` e um
--      `stripe_price_id` só expressam um dos dois ciclos.

-- ── plan_features ───────────────────────────────────────────────────────────

ALTER TABLE "plan_features" ADD COLUMN "key" TEXT;
ALTER TABLE "plan_features" ADD COLUMN "value" TEXT;

-- Linhas anteriores ao catálogo não têm slug. Derivar do id mantém a coluna
-- NOT NULL sem inventar semântica para dado que o seed vai substituir.
UPDATE "plan_features" SET "key" = 'legacy-' || "id" WHERE "key" IS NULL;

ALTER TABLE "plan_features" ALTER COLUMN "key" SET NOT NULL;

CREATE UNIQUE INDEX "plan_features_plan_id_key_key" ON "plan_features"("plan_id", "key");

-- ── plans ───────────────────────────────────────────────────────────────────

ALTER TABLE "plans" ADD COLUMN "amount_annual" DOUBLE PRECISION;
ALTER TABLE "plans" ADD COLUMN "stripe_price_id_annual" TEXT;

CREATE UNIQUE INDEX "plans_stripe_price_id_annual_key" ON "plans"("stripe_price_id_annual");
