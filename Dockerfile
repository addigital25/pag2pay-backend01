FROM node:20-alpine

# Instalar dependências do sistema
RUN apk add --no-cache \
    openssl \
    ca-certificates \
    curl

# Criar diretório da aplicação
WORKDIR /app

# Copiar package.json e package-lock.json
COPY package*.json ./

# Instalar dependências
RUN npm install --legacy-peer-deps --only=production && npm cache clean --force

# Copiar código da aplicação
COPY . .

# Gerar Prisma Client
RUN npx prisma generate

# Criar diretório de uploads
RUN mkdir -p uploads && chmod 777 uploads

# Expor porta
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl -f http://localhost:3001/health || exit 1

# Comando para iniciar
CMD ["sh", "-c", "node prisma/seed.js && node server.js"]
