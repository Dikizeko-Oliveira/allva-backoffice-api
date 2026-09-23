-- ═══════════════════════════════════════════════════════════════════════════
-- §12.2 — `ad_scores` persiste as TRÊS grandezas de cobertura (DEC-2/B7)
--
-- A tabela nasceu em A2-S1 com `component_coverage` só. Mas os pisos de §12.4
-- incidem sobre `coverage_ratio`, não sobre a cobertura absoluta — é essa a
-- decisão DEC-2 inteira: com piso absoluto, um anúncio de Search no Google marca
-- 0,45 e some de toda ordenação e de todo alerta, e o produto multi-plataforma
-- desaparece da tela que o define.
--
-- Guardar as outras duas dentro do JSON de `components` funcionaria e seria
-- errado: número sobre o qual um piso incide precisa ser consultável em `WHERE`,
-- e um piso que exige desserializar JSON para ser aplicado é um piso que ninguém
-- aplica na consulta que importa.
--
-- Aditiva (E1). Sem default e nulável: as linhas anteriores — nenhuma, hoje —
-- ficariam sem a grandeza, e inventar 1,0 para elas afirmaria cobertura perfeita
-- sobre um score que não sabemos como foi calculado.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "ad_scores"
  ADD COLUMN "coverage_ratio" DOUBLE PRECISION,
  ADD COLUMN "platform_coverage_max" DOUBLE PRECISION;

-- Os pisos de §12.4 são sempre "confiança E cobertura": o índice serve as duas
-- ordenações de `GET /ads` que os aplicam (`sortBy=aiScore`, `sortBy=scoreDelta`).
CREATE INDEX "ad_scores_org_floors_idx"
  ON "ad_scores" ("organization_id", "ai_confidence", "coverage_ratio");
