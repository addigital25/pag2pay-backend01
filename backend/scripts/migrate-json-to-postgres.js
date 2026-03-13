#!/usr/bin/env node

/**
 * Script de Migração: JSON → PostgreSQL
 *
 * Este script migra todos os dados do database.json para PostgreSQL
 */

import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'fs';
import { hash } from 'bcryptjs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const prisma = new PrismaClient();

// Ler database.json
const DB_FILE = path.join(__dirname, '../database.json');

async function migrate() {
  console.log('🚀 Iniciando migração JSON → PostgreSQL...\n');

  try {
    // Ler dados do JSON
    const jsonData = JSON.parse(readFileSync(DB_FILE, 'utf-8'));

    // ==================== 1. MIGRAR USUÁRIOS ====================
    console.log('👥 Migrando usuários...');
    for (const user of jsonData.users || []) {
      // Hash da senha se ainda não estiver hasheada
      let hashedPassword = user.password;
      if (!user.password.startsWith('$2')) {
        hashedPassword = await hash(user.password, 10);
      }

      await prisma.user.upsert({
        where: { id: user.id },
        update: {
          email: user.email,
          password: hashedPassword,
          name: user.name,
          role: user.role,
          commissionRate: user.commissionRate || 70,
        },
        create: {
          id: user.id,
          email: user.email,
          password: hashedPassword,
          name: user.name,
          role: user.role,
          commissionRate: user.commissionRate || 70,
          createdAt: user.createdAt ? new Date(user.createdAt) : new Date(),
        },
      });
    }
    console.log(`✅ ${jsonData.users?.length || 0} usuários migrados\n`);

    // ==================== 2. MIGRAR PLATFORM ADMINS ====================
    console.log('🔐 Migrando administradores...');
    const admins = jsonData.platformAdmins || [];
    for (const admin of admins) {
      let hashedPassword = admin.password;
      if (!admin.password.startsWith('$2')) {
        hashedPassword = await hash(admin.password, 10);
      }

      await prisma.platformAdmin.upsert({
        where: { email: admin.email },
        update: {
          password: hashedPassword,
          name: admin.name,
          userType: admin.userType || 'platform-admin',
        },
        create: {
          id: admin.id,
          email: admin.email,
          password: hashedPassword,
          name: admin.name,
          userType: admin.userType || 'platform-admin',
          createdAt: admin.createdAt ? new Date(admin.createdAt) : new Date(),
        },
      });
    }
    console.log(`✅ ${admins.length} administradores migrados\n`);

    // ==================== 3. MIGRAR PLATFORM USERS ====================
    console.log('📋 Migrando usuários da plataforma...');
    const platformUsers = jsonData.platformUsers || [];
    for (const pUser of platformUsers) {
      await prisma.platformUser.upsert({
        where: { id: pUser.id },
        update: {
          name: pUser.name,
          email: pUser.email,
          phone: pUser.phone,
          accountType: pUser.accountType,
          cpf: pUser.cpf,
          cnpj: pUser.cnpj,
          status: pUser.status,
          pendingReason: pUser.pendingReason,
          kyc: pUser.kyc,
          enderecoPF: pUser.enderecoPF,
          documentos: pUser.documentos,
          dadosBancarios: pUser.dadosBancarios,
          splitStatus: pUser.splitStatus,
          splitAccountId: pUser.splitAccountId,
          splitCreatedAt: pUser.splitCreatedAt ? new Date(pUser.splitCreatedAt) : null,
          withdrawalLocked: pUser.withdrawalLocked || false,
          totalProducts: pUser.totalProducts || 0,
          totalSales: pUser.totalSales || 0,
        },
        create: {
          id: pUser.id,
          name: pUser.name,
          email: pUser.email,
          phone: pUser.phone,
          accountType: pUser.accountType,
          cpf: pUser.cpf,
          cnpj: pUser.cnpj,
          status: pUser.status,
          pendingReason: pUser.pendingReason,
          kyc: pUser.kyc,
          enderecoPF: pUser.enderecoPF,
          documentos: pUser.documentos,
          dadosBancarios: pUser.dadosBancarios,
          splitStatus: pUser.splitStatus,
          splitAccountId: pUser.splitAccountId,
          splitCreatedAt: pUser.splitCreatedAt ? new Date(pUser.splitCreatedAt) : null,
          withdrawalLocked: pUser.withdrawalLocked || false,
          totalProducts: pUser.totalProducts || 0,
          totalSales: pUser.totalSales || 0,
          createdAt: pUser.createdAt ? new Date(pUser.createdAt) : new Date(),
        },
      });
    }
    console.log(`✅ ${platformUsers.length} usuários da plataforma migrados\n`);

    // ==================== 4. MIGRAR PRODUTOS ====================
    console.log('📦 Migrando produtos...');
    const products = jsonData.products || [];
    for (const product of products) {
      await prisma.product.upsert({
        where: { id: product.id },
        update: {
          code: product.code,
          name: product.name,
          description: product.description,
          category: product.category,
          productType: product.productType,
          price: product.price,
          image: product.image,
          salesPageUrl: product.salesPageUrl,
          supportEmail: product.supportEmail,
          warrantyDays: product.warrantyDays || 0,
          producerName: product.producerName,
          approvalStatus: product.approvalStatus || 'PENDENTE',
          approvedAt: product.approvedAt ? new Date(product.approvedAt) : null,
          rejectedAt: product.rejectedAt ? new Date(product.rejectedAt) : null,
          suspendedAt: product.suspendedAt ? new Date(product.suspendedAt) : null,
          rejectionReason: product.rejectionReason,
          suspensionReason: product.suspensionReason,
          turbinaScore: product.turbinaScore || 0,
          affiliateConfig: product.affiliateConfig,
          affiliateCommission: product.affiliateCommission || 0,
          checkoutConfig: product.checkoutConfig,
          paymentMethods: product.paymentMethods,
          plans: product.plans || [],
        },
        create: {
          id: product.id,
          code: product.code,
          name: product.name,
          description: product.description,
          category: product.category,
          productType: product.productType,
          price: product.price,
          image: product.image,
          salesPageUrl: product.salesPageUrl,
          supportEmail: product.supportEmail,
          warrantyDays: product.warrantyDays || 0,
          producerId: product.producerId,
          producerName: product.producerName,
          approvalStatus: product.approvalStatus || 'PENDENTE',
          approvedAt: product.approvedAt ? new Date(product.approvedAt) : null,
          rejectedAt: product.rejectedAt ? new Date(product.rejectedAt) : null,
          suspendedAt: product.suspendedAt ? new Date(product.suspendedAt) : null,
          rejectionReason: product.rejectionReason,
          suspensionReason: product.suspensionReason,
          turbinaScore: product.turbinaScore || 0,
          affiliateConfig: product.affiliateConfig,
          affiliateCommission: product.affiliateCommission || 0,
          checkoutConfig: product.checkoutConfig,
          paymentMethods: product.paymentMethods,
          plans: product.plans || [],
          createdAt: product.createdAt ? new Date(product.createdAt) : new Date(),
          updatedAt: product.updatedAt ? new Date(product.updatedAt) : new Date(),
        },
      });
    }
    console.log(`✅ ${products.length} produtos migrados\n`);

    // ==================== 5. MIGRAR SOLICITAÇÕES DE EXCLUSÃO ====================
    console.log('🗑️  Migrando solicitações de exclusão...');
    const deletionRequests = jsonData.deletionRequests || [];
    for (const request of deletionRequests) {
      await prisma.deletionRequest.create({
        data: {
          id: request.id,
          productId: request.productId,
          productName: request.productName,
          productCategory: request.productCategory,
          productPrice: request.productPrice,
          userId: request.userId,
          userName: request.userName,
          reason: request.reason,
          status: request.status,
          requestedAt: request.requestedAt ? new Date(request.requestedAt) : new Date(),
          reviewedAt: request.reviewedAt ? new Date(request.reviewedAt) : null,
          reviewedBy: request.reviewedBy,
          reviewerNotes: request.reviewerNotes,
        },
      }).catch(() => {
        // Ignorar duplicados
      });
    }
    console.log(`✅ ${deletionRequests.length} solicitações de exclusão migradas\n`);

    // ==================== 6. MIGRAR PRODUTOS EXCLUÍDOS ====================
    console.log('🗂️  Migrando produtos excluídos...');
    const deletedProducts = jsonData.deletedProducts || [];
    for (const product of deletedProducts) {
      await prisma.deletedProduct.create({
        data: {
          originalId: product.id,
          code: product.code || '',
          name: product.name,
          description: product.description,
          category: product.category,
          productType: product.productType,
          price: product.price,
          image: product.image,
          producerId: product.producerId,
          producerName: product.producerName,
          deletionReason: product.deletionReason,
          deletedBy: product.deletedBy,
          approvedBy: product.approvedBy,
          deletedAt: product.deletedAt ? new Date(product.deletedAt) : new Date(),
          originalData: product,
        },
      }).catch(() => {
        // Ignorar duplicados
      });
    }
    console.log(`✅ ${deletedProducts.length} produtos excluídos migrados\n`);

    // ==================== 7. MIGRAR AFILIAÇÕES ====================
    console.log('🤝 Migrando afiliações...');
    const affiliations = jsonData.affiliations || [];
    for (const affiliation of affiliations) {
      // Verificar se produto e afiliado existem
      const productExists = await prisma.product.findUnique({
        where: { id: affiliation.productId }
      });
      const userExists = await prisma.user.findUnique({
        where: { id: affiliation.affiliateId }
      });

      if (productExists && userExists) {
        await prisma.affiliation.upsert({
          where: {
            affiliateId_productId: {
              affiliateId: affiliation.affiliateId,
              productId: affiliation.productId
            }
          },
          update: {
            affiliateName: affiliation.affiliateName,
            productName: affiliation.productName,
            status: affiliation.status,
            commissionRate: affiliation.commissionRate,
            approvedAt: affiliation.approvedAt ? new Date(affiliation.approvedAt) : null,
            rejectedAt: affiliation.rejectedAt ? new Date(affiliation.rejectedAt) : null,
          },
          create: {
            id: affiliation.id,
            affiliateId: affiliation.affiliateId,
            affiliateName: affiliation.affiliateName,
            productId: affiliation.productId,
            productName: affiliation.productName,
            status: affiliation.status,
            commissionRate: affiliation.commissionRate,
            approvedAt: affiliation.approvedAt ? new Date(affiliation.approvedAt) : null,
            rejectedAt: affiliation.rejectedAt ? new Date(affiliation.rejectedAt) : null,
            createdAt: affiliation.createdAt ? new Date(affiliation.createdAt) : new Date(),
          },
        });
      }
    }
    console.log(`✅ ${affiliations.length} afiliações migradas\n`);

    // ==================== RESUMO ====================
    console.log('\n📊 RESUMO DA MIGRAÇÃO:');
    console.log('========================');
    console.log(`✅ Usuários: ${jsonData.users?.length || 0}`);
    console.log(`✅ Admins: ${admins.length}`);
    console.log(`✅ Platform Users: ${platformUsers.length}`);
    console.log(`✅ Produtos: ${products.length}`);
    console.log(`✅ Solicitações de Exclusão: ${deletionRequests.length}`);
    console.log(`✅ Produtos Excluídos: ${deletedProducts.length}`);
    console.log(`✅ Afiliações: ${affiliations.length}`);
    console.log('========================\n');

    console.log('🎉 Migração concluída com sucesso!\n');

  } catch (error) {
    console.error('❌ Erro na migração:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// Executar migração
migrate();
