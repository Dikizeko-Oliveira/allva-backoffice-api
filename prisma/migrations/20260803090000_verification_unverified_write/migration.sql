-- A2-S7 — o estado terminal da escada de verificação (§13.4).
--
-- `INCONCLUSIVE` significa "ainda não sei, pergunto no próximo degrau". Quando
-- os quatro degraus acabam, não há próximo degrau — e manter a execução em
-- INCONCLUSIVE a deixaria esperando para sempre por algo que não vai acontecer,
-- que é exatamente o "status não terminal sem caminho de saída" que §16.16
-- proíbe.
--
-- Aditiva: valor novo no enum, nenhuma linha existente muda.
ALTER TYPE "VerificationResult" ADD VALUE IF NOT EXISTS 'UNVERIFIED_WRITE';
