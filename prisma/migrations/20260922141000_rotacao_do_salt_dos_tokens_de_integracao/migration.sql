-- ═══════════════════════════════════════════════════════════════════════════
-- O salt do cifrador mudou de nome: toda integração volta a DISCONNECTED
--
-- ## Por que isto é uma migração, e não só uma troca de string
--
-- `TokenCipherService` deriva a chave AES com
-- `scryptSync(INTEGRATION_TOKEN_ENCRYPTION_KEY, SALT)`. O salt é entrada da
-- derivação, não rótulo: trocar `adnexa-integration-token-cipher` por
-- `allva-integration-token-cipher` produz **outra chave**, e todo payload
-- `v1:` gravado com a anterior deixa de abrir.
--
-- E isso não falharia só na sincronização. `IntegrationsPrismaRepository.toEntity`
-- decifra `access_token` em **toda** leitura de integração, sem olhar o status:
-- um token órfão derrubaria com 500 a própria tela de integrações, que é onde
-- a pessoa iria para reconectar. O estrago seria circular.
--
-- ## Sentinela em texto puro, não string vazia
--
-- `decrypt` recusa payload vazio e, sem o prefixo `v1:`, devolve o valor como
-- veio (o caminho de token legado, que existe desde a introdução do cifrador).
-- A sentinela usa esse caminho de propósito: a leitura passa, a tela abre, e
-- qualquer chamada ao provedor falha com credencial inválida — que é
-- exatamente o que se quer dizer.
--
-- `expires_at` vai para o passado e `status` para `DISCONNECTED` para que o
-- worker de sync pule a linha (`sync.worker.ts` → `INTEGRATION_DISCONNECTED`)
-- em vez de tentar renovar com um refresh token que também não abre mais.
--
-- ## O que a pessoa precisa fazer
--
-- Reconectar cada conta de anúncios por OAuth. Nada além do token é perdido:
-- `ad_accounts`, `ads`, métricas e histórico continuam onde estavam, presos à
-- mesma linha de `integrations`.
-- ═══════════════════════════════════════════════════════════════════════════

UPDATE "integrations"
SET "access_token"    = 'revoked:salt-rotation-20260922',
    "refresh_token"   = NULL,
    "expires_at"      = NOW() - INTERVAL '1 day',
    "status"          = 'DISCONNECTED',
    "disconnected_at" = COALESCE("disconnected_at", NOW()),
    "sync_error"      = 'Credencial invalidada pela rotação do salt de criptografia; reconecte a conta.',
    "updated_at"      = NOW()
WHERE "access_token" LIKE 'v1:%';
