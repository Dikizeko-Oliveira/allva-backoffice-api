# Makefile for Allva API

# Variables
NPM := npm
NPX := npx

# Default target
.DEFAULT_GOAL := help

.PHONY: help install dev build start lint format prisma-generate prisma-migrate prisma-deploy prisma-studio docker-up docker-down

help: ## Show this help message
	@echo "Usage: make [target]"
	@echo ""
	@echo "Targets:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies
	$(NPM) install

dev: ## Start the application in development mode
	$(NPM) run dev

build: ## Build the application
	$(NPM) run build

start: ## Start the application in production mode
	$(NPM) run start:prod


# Prisma Commands
prisma-generate: ## Generate Prisma client
	$(NPX) prisma generate

prisma-migrate: ## Run Prisma migrations in development (creates migration files)
	$(NPX) prisma migrate dev

deploy: ## Apply pending migrations to the database (fixes 'prisma deploy' issue)
	$(NPX) prisma migrate deploy
	$(NPX) prisma generate

prisma-studio: ## Open Prisma Studio
	$(NPX) prisma studio


# Docker Commands
docker-up: ## Start local infrastructure (Postgres, Redis)
	docker-compose up -d

docker-down: ## Stop local infrastructure
	docker-compose down
