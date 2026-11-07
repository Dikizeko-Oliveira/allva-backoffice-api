import { integrationDatabaseUrl } from './integration-database';

// O `PrismaService` lê `DATABASE_URL`: aponta-o para o banco da suíte antes
// de qualquer import da aplicação.
process.env.DATABASE_URL = integrationDatabaseUrl();
process.env.ALLVA_API_URL ??= 'http://localhost:8080';
