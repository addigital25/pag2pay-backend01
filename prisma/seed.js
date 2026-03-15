import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Iniciando seed do banco de dados...');

  try {
    // Senha admin vem da variável de ambiente (Railway)
    // Se não configurar, usa senha padrão
    const defaultPassword = process.env.ADMIN_DEFAULT_PASSWORD || 'Admin@2024!';

    if (!process.env.ADMIN_DEFAULT_PASSWORD) {
      console.log('⚠️  AVISO: Configure ADMIN_DEFAULT_PASSWORD no Railway para máxima segurança!');
    }

    // Verificar se já existe snapshot
    let snapshot = await prisma.databaseSnapshot.findUnique({
      where: { id: 'singleton' }
    });

    if (!snapshot) {
      console.log('📦 Criando snapshot inicial...');

      const adminPassword = await bcrypt.hash(defaultPassword, 10);

      const initialData = {
        users: [
          {
            id: '1',
            email: 'admin@pag2pay.com',
            password: adminPassword,
            name: 'Administrador Master',
            role: 'admin',
            createdAt: new Date().toISOString()
          }
        ],
        products: [],
        orders: [],
        affiliations: [],
        commissions: [],
        withdrawals: [],
        bankAccounts: [],
        transactions: [],
        deletionRequests: [],
        deletedProducts: [],
        pagarmeConfigs: [],
        platformSettings: {
          financial: {
            invoicePrefix: 'PAG2PAY',
            platformFees: { pix: 3.67, boleto: 3.67, creditCard: 5.99 }
          }
        },
        platformFeesByAcquirer: {}
      };

      snapshot = await prisma.databaseSnapshot.create({
        data: {
          id: 'singleton',
          data: initialData
        }
      });

      console.log('✅ Snapshot criado com admin!');
    } else {
      console.log('📊 Snapshot já existe, verificando admin...');

      const data = snapshot.data;
      const hasAdmin = data.users?.some(u => u.role === 'admin');

      if (!hasAdmin) {
        console.log('❌ Admin não encontrado, adicionando...');

        if (!data.users) data.users = [];

        const adminPassword = await bcrypt.hash(defaultPassword, 10);

        data.users.push({
          id: '1',
          email: 'admin@pag2pay.com',
          password: adminPassword,
          name: 'Administrador Master',
          role: 'admin',
          createdAt: new Date().toISOString()
        });

        await prisma.databaseSnapshot.update({
          where: { id: 'singleton' },
          data: { data }
        });

        console.log('✅ Admin adicionado!');
      } else {
        console.log('✅ Admin existe');

        // Atualizar senha APENAS se variável de ambiente foi configurada
        if (process.env.ADMIN_DEFAULT_PASSWORD) {
          const adminIndex = data.users.findIndex(u => u.role === 'admin');
          if (adminIndex !== -1) {
            const adminPassword = await bcrypt.hash(defaultPassword, 10);
            data.users[adminIndex].password = adminPassword;
            data.users[adminIndex].email = 'admin@pag2pay.com';

            await prisma.databaseSnapshot.update({
              where: { id: 'singleton' },
              data: { data }
            });

            console.log('✅ Senha do admin atualizada via env var!');
          }
        } else {
          console.log('ℹ️  Senha do admin não será alterada (use env var para atualizar)');
        }
      }
    }

    console.log('\n🎉 Seed concluído!');
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  CREDENCIAIS DO ADMINISTRADOR');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📧 Email: admin@pag2pay.com');
    console.log('🔑 Senha: (ver variável de ambiente)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  } catch (error) {
    console.error('❌ Erro no seed:', error);
    throw error;
  }
}

main()
  .catch((e) => {
    console.error('❌ Erro fatal no seed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
