/**
 * Diagnóstico do storage configurado, para rodar **no ambiente que se quer
 * verificar** — a sua máquina e o staging falham por motivos diferentes e o
 * erro cru não distingue os dois.
 *
 *   pnpm storage:check            # só leitura: credencial + assinatura
 *   pnpm storage:check --write    # também sobe e apaga um objeto de teste
 *
 * Sem `--write` ele não toca no bucket: pedir uma URL assinada é operação de
 * assinatura, não de escrita, e é justamente a etapa que costuma falhar sozinha
 * — dá para ter permissão de gravar no bucket e mesmo assim não conseguir
 * assinar, porque são autorizações diferentes em serviços diferentes.
 *
 * O valor daqui não é o "deu certo", é o mapeamento do erro para a correção:
 * `Could not load the default credentials` e
 * `Permission 'iam.serviceAccounts.signBlob' denied` são problemas distintos,
 * em camadas distintas, e a mensagem do SDK não diz o que fazer com nenhum dos
 * dois.
 */
import 'dotenv/config';
import { readFileSync } from 'fs';
import { envSchema } from '../src/shared/infrastructure/config/env';
import { EnvService } from '../src/shared/infrastructure/config/env.service';
import { resolveStorageProvider } from '../src/shared/infrastructure/storage/storage.module';

const WRITE = process.argv.includes('--write');

/** As correções, indexadas pelo trecho de erro que as denuncia. */
const REMEDIES: Array<{ match: RegExp; diagnosis: string; fix: string[] }> = [
  {
    match: /Could not load the default credentials/i,
    diagnosis:
      'Nenhuma credencial encontrada: não há chave no .env nem Application Default Credentials no ambiente.',
    fix: [
      'Local  → baixe o JSON de uma service account e aponte GCS_KEY_FILENAME para ele',
      'Local  → ou instale o gcloud e rode: gcloud auth application-default login --impersonate-service-account=SA@PROJETO.iam.gserviceaccount.com',
      'Google Cloud → anexe uma service account ao serviço (Cloud Run/GKE); nada no .env',
    ],
  },
  {
    match: /Cannot sign data without .?client_email/i,
    diagnosis:
      'A credencial é de USUÁRIO (gcloud auth application-default login), e usuário não assina — falta client_email.',
    fix: [
      'Refaça com impersonação: gcloud auth application-default login --impersonate-service-account=SA@PROJETO.iam.gserviceaccount.com',
      'Ou aponte GCS_KEY_FILENAME para o JSON de uma service account',
    ],
  },
  {
    match: /iam\.serviceAccounts\.signBlob|signBlob.*(denied|permission)/i,
    diagnosis:
      'A service account existe mas não pode assinar por si mesma. Assinatura sem chave em mãos passa pela API IAM.',
    fix: [
      'gcloud services enable iamcredentials.googleapis.com',
      'gcloud iam service-accounts add-iam-policy-binding SA@PROJETO.iam.gserviceaccount.com \\',
      '  --member="serviceAccount:SA@PROJETO.iam.gserviceaccount.com" \\',
      '  --role="roles/iam.serviceAccountTokenCreator"',
    ],
  },
  {
    match: /storage\.objects\.(create|delete|get)|does not have storage/i,
    diagnosis: 'Autenticou, mas a identidade não tem permissão no bucket.',
    fix: [
      'gcloud storage buckets add-iam-policy-binding gs://BUCKET \\',
      '  --member="serviceAccount:SA@PROJETO.iam.gserviceaccount.com" \\',
      '  --role="roles/storage.objectAdmin"',
    ],
  },
  {
    // `\b404\b`, e não `404`: sem as bordas isto casava com qualquer número
    // que contivesse 404 — um client id do Google, por exemplo — e o
    // diagnóstico saía confiante e errado. Foi o primeiro achado do script.
    match: /bucket does not exist|\b404\b|\bNot Found\b/i,
    diagnosis: 'Credencial válida, bucket não encontrado.',
    fix: [
      'Confira GCS_BUCKET (nome exato, sem gs://) e se ele está no projeto de GCS_PROJECT_ID',
    ],
  },
  {
    match: /STORAGE_NOT_CONFIGURED/,
    diagnosis: 'O provider se recusou antes de chamar a nuvem: falta o bucket.',
    fix: ['Preencha GCS_BUCKET (ou AWS_S3_BUCKET, se STORAGE_PROVIDER=S3)'],
  },
];

function explain(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.log(`\n  ✗ ${message.split('\n')[0]}`);

  const remedy = REMEDIES.find((entry) => entry.match.test(message));

  if (!remedy) {
    console.log('\n  Sem correção conhecida para este erro. Rastro completo:');
    console.log(error);
    return;
  }

  console.log(`\n  ${remedy.diagnosis}\n`);
  for (const line of remedy.fix) console.log(`    ${line}`);
}

/**
 * Olha o arquivo de credencial ANTES de chamar a nuvem.
 *
 * Vale a pré-checagem porque os dois erros mais comuns aqui chegam
 * irreconhecíveis do outro lado: um caminho com `~` vira um ENOENT com o
 * diretório do repositório colado na frente, e um JSON de **OAuth client**
 * baixado no lugar da chave de service account falha lá adiante, na assinatura,
 * sem nada que aponte para o arquivo errado. São arquivos vizinhos no console
 * do Google e não servem um para o outro.
 */
function inspectKeyFile(path: string): boolean {
  console.log('\n[0/3] arquivo de credencial');

  if (path.startsWith('~')) {
    console.log(`\n  ✗ o caminho começa com "~": ${path}`);
    console.log(
      '\n  Valor de .env é literal — nem o shell nem o SDK expandem "~",',
    );
    console.log('  então ele vira um diretório relativo e o arquivo some.\n');
    console.log('    Use o caminho absoluto: /Users/<você>/...');
    return false;
  }

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    console.log(`\n  ✗ arquivo não encontrado: ${path}\n`);
    console.log('    Confira o caminho, ou deixe GCS_KEY_FILENAME vazio para');
    console.log('    usar Application Default Credentials.');
    return false;
  }

  let json: Record<string, unknown>;
  try {
    json = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    console.log(`\n  ✗ o arquivo não é JSON válido: ${path}`);
    return false;
  }

  if (json.type !== 'service_account') {
    const kind =
      json.web || json.installed ? 'OAuth client ID' : String(json.type);
    console.log(`\n  ✗ este não é uma chave de service account (é: ${kind})`);
    console.log(
      '\n  Um OAuth client ID (client_secret_….apps.googleusercontent.com.json)',
    );
    console.log(
      '  serve para login de USUÁRIO. Ele não tem private_key, então',
    );
    console.log('  não assina URL nenhuma.\n');
    console.log('    Console → IAM e Admin → Contas de serviço → a conta →');
    console.log('    Chaves → Adicionar chave → Criar nova → JSON');
    return false;
  }

  const missing = ['client_email', 'private_key'].filter((key) => !json[key]);
  if (missing.length > 0) {
    console.log(
      `\n  ✗ chave de service account incompleta: falta ${missing.join(', ')}`,
    );
    return false;
  }

  console.log(`  ✓ service account: ${String(json.client_email)}`);
  return true;
}

async function main(): Promise<void> {
  const parsed = envSchema.parse(process.env);
  const env = {
    get: (key: string) => (parsed as Record<string, unknown>)[key],
  } as unknown as EnvService;

  const storage = resolveStorageProvider(env);

  const chosen = parsed.STORAGE_PROVIDER;
  const bucket = chosen === 'S3' ? parsed.AWS_S3_BUCKET : parsed.GCS_BUCKET;
  const credential = parsed.GCS_KEY_FILENAME
    ? 'GCS_KEY_FILENAME'
    : parsed.GCS_CLIENT_EMAIL && parsed.GCS_PRIVATE_KEY
      ? 'GCS_CLIENT_EMAIL + GCS_PRIVATE_KEY'
      : 'Application Default Credentials (nada no .env)';

  console.log('storage.check');
  console.log(`  STORAGE_PROVIDER : ${chosen}`);
  console.log(`  provider ativo   : ${storage.provider}`);
  console.log(`  bucket           : ${bucket || '<vazio>'}`);
  if (chosen === 'GCS') {
    console.log(`  projeto          : ${parsed.GCS_PROJECT_ID || '<vazio>'}`);
    console.log(`  credencial       : ${credential}`);
    console.log(
      `  URL de leitura   : ${parsed.GCS_PUBLIC_BASE_URL || 'host padrão do bucket'}`,
    );
  }

  if (parsed.GCS_KEY_FILENAME && !inspectKeyFile(parsed.GCS_KEY_FILENAME)) {
    process.exitCode = 1;
    return;
  }

  console.log('\n[1/3] assinar uma URL (credencial + permissão de assinatura)');
  try {
    const signed = await storage.getPresignedUrl(
      'storage-check.png',
      'image/png',
      'storage-check',
    );
    console.log(`  ✓ assinou — chave: ${signed.key}`);
  } catch (error) {
    explain(error);
    process.exitCode = 1;
    return;
  }

  if (!WRITE) {
    console.log('\n[2/3] escrita e leitura no bucket');
    console.log('  – puladas. Rode com --write para o ciclo completo.');
    return;
  }

  console.log('\n[2/3] subir um objeto de teste');
  let uploaded: { url: string; key: string };
  try {
    uploaded = await storage.upload(
      Buffer.from('storage-check'),
      'storage-check.txt',
      'text/plain',
      'storage-check',
    );
    console.log(`  ✓ subiu   — ${uploaded.url}`);
  } catch (error) {
    explain(error);
    process.exitCode = 1;
    return;
  }

  // A verificação que decide se o front renderiza: num bucket privado a URL
  // crua tem que dar 403 e a assinada tem que dar 200. Uma sem a outra não
  // prova nada — se as duas derem 200, o bucket está público e a assinatura
  // está sendo dispensada sem ninguém perceber.
  console.log(
    '\n[3/3] ler o objeto: URL crua deve ser negada, assinada deve servir',
  );
  try {
    const raw = await fetch(uploaded.url);
    console.log(
      raw.ok
        ? `  ⚠ URL CRUA respondeu ${raw.status} — o bucket está público`
        : `  ✓ URL crua negada (${raw.status}), como se espera de bucket privado`,
    );

    const readUrl = await storage.getReadUrl(uploaded.url);
    const signed = await fetch(readUrl);

    if (signed.ok) {
      console.log(`  ✓ URL assinada serviu o objeto (${signed.status})`);
    } else {
      console.log(`  ✗ URL assinada respondeu ${signed.status}`);
      console.log(`\n  ${(await signed.text()).slice(0, 300)}`);
      process.exitCode = 1;
    }
  } catch (error) {
    explain(error);
    process.exitCode = 1;
  } finally {
    await storage.deleteByUrl(uploaded.url);
    console.log(`  ✓ apagou  — ${uploaded.key}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
