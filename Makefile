# Makefile for Allva Backoffice API

# Variables
PNPM := pnpm

# Default target
.DEFAULT_GOAL := help

.PHONY: help install dev build start lint format prisma-generate prisma-migrate prisma-deploy prisma-studio docker-up docker-down

help: ## Show this help message
	@echo "Usage: make [target]"
	@echo ""
	@echo "Targets:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies
	$(PNPM) install

dev: ## Start the application in development mode
	$(PNPM) dev

build: ## Build the application
	$(PNPM) build

start: ## Start the application in production mode
	$(PNPM) start:prod


# Prisma Commands
prisma-generate: ## Generate Prisma client
	$(PNPM) prisma generate

prisma-migrate: ## Run Prisma migrations in development (creates migration files)
	$(PNPM) prisma migrate dev

deploy: ## Apply pending migrations to the database (fixes 'prisma deploy' issue)
	$(PNPM) prisma migrate deploy
	$(PNPM) prisma generate

prisma-studio: ## Open Prisma Studio
	$(PNPM) prisma studio


# Docker Commands
docker-up: ## Start local infrastructure (Postgres, Redis)
	docker-compose up -d

docker-down: ## Stop local infrastructure
	docker-compose down
