# Use Node.js 18
FROM node:18-alpine

# Diretório de trabalho
WORKDIR /app

# Copiar arquivos de dependências
COPY package*.json ./

# Instalar dependências
RUN npm install --legacy-peer-deps --only=production && npm cache clean --force

# Copiar código da aplicação
COPY . .

# Gerar Prisma Client
RUN npx prisma generate

# Criar diretório de uploads
RUN mkdir -p uploads

# Expor porta
EXPOSE 3000

# Comando de start: executar seed DEPOIS iniciar servidor
CMD ["sh", "-c", "node prisma/seed.js && node server.js"]
