// ========================================
// SCRIPT DE MIGRAÇÃO: database.json → PostgreSQL
// ========================================

import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';

const prisma = new PrismaClient();

async function migrate() {
  try {
    console.log('🚀 Iniciando migração de dados...\n');

    // 1. Ler database.json
    const dbPath = path.join(process.cwd(), 'database.json');

    console.log(`📦 Lendo database.json em: ${dbPath}`);

    if (!fs.existsSync(dbPath)) {
      console.log('⚠️  Arquivo database.json não encontrado!');
      console.log('   Criando snapshot vazio no PostgreSQL...');

      await prisma.databaseSnapshot.upsert({
        where: { id: 'singleton' },
        update: {
          data: {
            users: [],
            products: [],
            orders: [],
            pagarmeConfigs: [],
            platformSettings: {},
            platformFeesByAcquirer: {},
            withdrawals: []
          }
        },
        create: {
          id: 'singleton',
          data: {
            users: [],
            products: [],
            orders: [],
            pagarmeConfigs: [],
            platformSettings: {},
            platformFeesByAcquirer: {},
            withdrawals: []
          }
        }
      });

      console.log('✅ Snapshot vazio criado com sucesso!');
      process.exit(0);
    }

    const fileContent = fs.readFileSync(dbPath, 'utf-8');
    const data = JSON.parse(fileContent);

    console.log('✅ database.json lido com sucesso!');
    console.log(`   - Usuários: ${data.users?.length || 0}`);
    console.log(`   - Produtos: ${data.products?.length || 0}`);
    console.log(`   - Pedidos: ${data.orders?.length || 0}`);
    console.log(`   - Configs Pagar.me: ${data.pagarmeConfigs?.length || 0}`);
    console.log(`   - Saques: ${data.withdrawals?.length || 0}`);

    // 2. Salvar no PostgreSQL
    console.log('\n💾 Salvando no PostgreSQL...');

    await prisma.databaseSnapshot.upsert({
      where: { id: 'singleton' },
      update: {
        data,
        updatedAt: new Date()
      },
      create: {
        id: 'singleton',
        data
      }
    });

    console.log('✅ Dados salvos no PostgreSQL com sucesso!');

    // 3. Verificar
    console.log('\n🔍 Verificando migração...');
    const snapshot = await prisma.databaseSnapshot.findUnique({
      where: { id: 'singleton' }
    });

    if (snapshot && snapshot.data) {
      console.log('✅ Snapshot encontrado no PostgreSQL!');
      console.log(`   ID: ${snapshot.id}`);
      console.log(`   Criado em: ${snapshot.createdAt}`);
      console.log(`   Atualizado em: ${snapshot.updatedAt}`);
      console.log(`   Usuários no snapshot: ${snapshot.data.users?.length || 0}`);
    } else {
      console.log('❌ Erro: Snapshot não encontrado!');
      process.exit(1);
    }

    console.log('\n🎉 Migração concluída com sucesso!');
    console.log('\n📋 Próximos passos:');
    console.log('   1. Substitua as funções readDB() e writeDB() no server.js');
    console.log('   2. Adicione "async/await" nas rotas que usam essas funções');
    console.log('   3. Reinicie o servidor');
    console.log('   4. Teste a aplicação\n');

    process.exit(0);
  } catch (error) {
    console.error('\n❌ Erro durante a migração:', error);
    console.error('\nDetalhes:', error.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

migrate();
