FROM node:22-alpine AS builder

WORKDIR /app

# pnpm
RUN corepack enable && corepack prepare pnpm@8.15.5 --activate

# Dependências primeiro para aproveitar cache
COPY package.json pnpm-lock.yaml ./

# Schema do Prisma precisa existir antes do install (postinstall roda `prisma generate`)
COPY prisma ./prisma

RUN pnpm install --frozen-lockfile

# Código da aplicação
COPY . .

# Prisma Client
RUN pnpm prisma generate

# Build NestJS
RUN pnpm build


FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8081

# pnpm
RUN corepack enable && corepack prepare pnpm@8.15.5 --activate

# Apenas dependências de produção
COPY package.json pnpm-lock.yaml ./

# Schema do Prisma precisa existir antes do install (postinstall roda `prisma generate`)
COPY prisma ./prisma

# `prisma.config.ts` declara `datasource.url` — sem `url` inline no schema
# (padrão de driver adapter), é o único lugar de onde `prisma migrate deploy`
# resolve a connection string. Sem este arquivo o comando falha mesmo com
# DATABASE_URL setada no ambiente.
COPY prisma.config.ts ./prisma.config.ts

RUN pnpm install --prod --frozen-lockfile

# Aplicação compilada
COPY --from=builder /app/dist ./dist

# Assets públicos
COPY --from=builder /app/public ./public

EXPOSE 8081

CMD ["node", "dist/src/main.js"]
