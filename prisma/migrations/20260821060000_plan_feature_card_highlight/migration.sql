-- `visible_on_landing` respondia "esta linha entra na tabela de precos?", e a
-- resposta era 20 das 31 linhas. Com a secao "Compare nossos planos" passando a
-- renderizar a matriz inteira, essa pergunta deixou de ter consumidor: as 11
-- linhas escondidas — `audit-trail`, `base-currency` e `report-email` entre elas
-- — sao justamente diferenciadores que a tabela deve mostrar.
--
-- A pergunta que sobrou e outra: "esta linha cabe nas ~8 do card?". Renomear em
-- vez de somar uma segunda coluna evita deixar no schema uma flag sem leitor,
-- que e o tipo de coisa que o proximo leitor interpreta como intencional.
--
-- RENAME, e nao DROP + ADD: o Prisma nao infere renomeacao e geraria as duas
-- operacoes, derrubando a coluna com as 124 linhas ja gravadas.
ALTER TABLE "plan_features" RENAME COLUMN "visible_on_landing" TO "landing_highlight";

-- O padrao inverte junto com o significado. Antes toda feature nova aparecia na
-- vitrine ate alguem escondê-la; agora ela fica fora do card ate alguem promovê-la
-- — que e o certo quando so 8 de 31 cabem.
ALTER TABLE "plan_features" ALTER COLUMN "landing_highlight" SET DEFAULT false;
