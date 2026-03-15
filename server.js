import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import cron from 'node-cron';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import platformRoutes from './routes/platform.js';
import platformProductsRoutes from './routes/platformProducts.js';
import affiliationsRoutes from './routes/affiliations.js';
import achievementsRoutes from './routes/achievements.js';

// Importar serviços
import turbinaScoreService from './services/turbinaScore.js';
import { logger } from './utils/logger.js';
import { validatePassword, getPasswordStrength } from './utils/passwordValidator.js';

// Importar bibliotecas para rastreio dos Correios
import axios from 'axios';
import * as cheerio from 'cheerio';
import fetch from 'node-fetch';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

// Importar serviço do Pagar.me
import pagarmeService from './services/pagarme.js';

// Prisma Client para PostgreSQL
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// Verificar conexão com PostgreSQL
prisma.$connect()
  .then(() => console.log('✅ Conectado ao PostgreSQL via Prisma'))
  .catch((err) => console.error('❌ Erro ao conectar no PostgreSQL:', err));

// Carregar variáveis de ambiente
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const DB_FILE = './database.json';

// Configuração CORS para produção
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5173',
  'https://dist-cxy.pages.dev',
  'https://pag2pay-frontend-v2.pages.dev',
  process.env.FRONTEND_URL,
  process.env.ADMIN_URL
].filter(Boolean);

app.use(cors({
  origin: function(origin, callback) {
    // Permite requisições sem origin (mobile apps, postman, etc)
    if (!origin) return callback(null, true);

    if (allowedOrigins.indexOf(origin) !== -1 || process.env.NODE_ENV === 'development') {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// =====================================================
// MIDDLEWARE: REQUEST LOGGER
// =====================================================
app.use((req, res, next) => {
  // Logar apenas requisições importantes (não logar polling de notificações)
  if (req.path.startsWith('/api/platform') &&
      !req.path.includes('/users') &&
      !req.path.includes('/products') &&
      !req.path.includes('/withdrawals')) {
    console.log(`🌐 [REQUEST] ${req.method} ${req.path}`);
    console.log(`🔑 [HEADERS] Authorization: ${req.headers.authorization ? 'presente' : 'ausente'}`);
  }
  next();
});

// =====================================================
// MIDDLEWARE: MODO MANUTENÇÃO
// =====================================================
app.use((req, res, next) => {
  // Permitir acesso ao Platform Admin sempre
  if (req.path.startsWith('/api/platform')) {
    return next();
  }

  // Permitir acesso a uploads (imagens, etc)
  if (req.path.startsWith('/uploads')) {
    return next();
  }

  // Verificar se modo manutenção está ativo
  try {
    const db = JSON.parse(readFileSync(DB_FILE, 'utf8'));
    const maintenanceMode = db.platformSettings?.extras?.maintenanceMode || false;

    if (maintenanceMode) {
      return res.status(503).json({
        success: false,
        error: 'Plataforma em Manutenção',
        message: 'Estamos realizando melhorias no sistema. Voltaremos em breve.',
        maintenanceMode: true
      });
    }
  } catch (error) {
    // Se não conseguir ler o DB, continuar normalmente
    console.error('Erro ao verificar modo manutenção:', error);
  }

  next();
});

// Configurar __dirname para ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Criar diretório de uploads se não existir
const uploadsDir = path.join(__dirname, 'uploads');
if (!existsSync(uploadsDir)) {
  mkdirSync(uploadsDir, { recursive: true });
}

// Servir arquivos estáticos da pasta uploads
app.use('/uploads', express.static(uploadsDir));

// Configuração do multer para upload de imagens
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    const uniqueName = `${Date.now()}-${uuidv4()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: function (req, file, cb) {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);

    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Apenas imagens são permitidas (jpeg, jpg, png, gif, webp)'));
    }
  }
});

// Função para gerar código único do produto
function generateProductCode() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let code = 'pro';
  for (let i = 0; i < 5; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// Inicializar banco de dados
function initDB() {
  if (!existsSync(DB_FILE)) {
    const initialData = {
      users: [
        {
          id: '1',
          email: 'admin@pag2pay.com',
          password: '$2b$10$X48XuOpRwt/cNSzdc28Ise64piso9eadB8dPTXvjXnB68M4Kyb3sa',
          name: 'Administrador Master',
          role: 'admin',
          createdAt: new Date().toISOString()
        },
        {
          id: '2',
          email: 'usuario@pag2pay.com',
          password: 'usuario123',
          name: 'Usuário Demo',
          role: 'user',
          commissionRate: 70,
          createdAt: new Date().toISOString()
        }
      ],
      products: [],
      orders: [],
      affiliations: [],
      commissions: []
    };
    writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2));
  }
}

async function readDB() {
  try {
    const snapshot = await prisma.databaseSnapshot.findUnique({
      where: { id: 'singleton' }
    });

    if (snapshot && snapshot.data) {
      return snapshot.data;
    }

    return {
      users: [],
      products: [],
      orders: [],
      pagarmeConfigs: [],
      platformSettings: {
        financial: {
          invoicePrefix: 'PAG2PAY',
          platformFees: { pix: 3.67, boleto: 3.67, creditCard: 5.99 }
        }
      },
      platformFeesByAcquirer: {},
      withdrawals: [],
      affiliations: [],
      bankAccounts: [],
      commissions: [],
      transactions: [],
      deletionRequests: [],
      deletedProducts: []
    };
  } catch (error) {
    console.error('❌ Erro ao ler PostgreSQL:', error);
    try {
      const data = readFileSync(DB_FILE, 'utf-8');
      console.log('⚠️  Usando database.json como fallback');
      return JSON.parse(data);
    } catch (fileError) {
      return { users: [], products: [], orders: [], pagarmeConfigs: [], platformSettings: {}, platformFeesByAcquirer: {}, withdrawals: [] };
    }
  }
}

async function writeDB(data) {
  try {
    await prisma.databaseSnapshot.upsert({
      where: { id: 'singleton' },
      update: { data: data, updatedAt: new Date() },
      create: { id: 'singleton', data: data }
    });
    console.log('✅ Dados salvos no PostgreSQL');
    try {
      writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
    } catch (fileError) {
      console.log('⚠️  Backup em arquivo não disponível');
    }
    return true;
  } catch (error) {
    console.error('❌ Erro ao salvar no PostgreSQL:', error);
    throw error;
  }
}

// Função auxiliar para buscar a chave da API Pagar.me do banco de dados
async function getPagarmeApiKey() {
  try {
    const db = await readDB();

    // Buscar configuração do platform-admin (configuração principal)
    const platformConfig = db.pagarmeConfigs?.find(c => c.userId === 'platform-admin');

    if (platformConfig && platformConfig.privateKey) {
      console.log('🔑 Chave Pagar.me encontrada no banco de dados (platform-admin)');
      return platformConfig.privateKey;
    }

    // Fallback: buscar primeira configuração disponível
    const firstConfig = db.pagarmeConfigs?.[0];
    if (firstConfig && firstConfig.privateKey) {
      console.log('🔑 Chave Pagar.me encontrada no banco de dados (primeira config)');
      return firstConfig.privateKey;
    }

    // Último fallback: tentar variável de ambiente
    if (process.env.PAGARME_API_KEY && !process.env.PAGARME_API_KEY.includes('COLE_SUA_CHAVE')) {
      console.log('🔑 Chave Pagar.me encontrada no .env');
      return process.env.PAGARME_API_KEY;
    }

    console.warn('⚠️ Nenhuma chave Pagar.me configurada');
    return null;
  } catch (error) {
    console.error('❌ Erro ao buscar chave Pagar.me:', error);
    return null;
  }
}

// Função auxiliar para buscar o Recipient ID da plataforma do banco de dados
function getPlatformRecipientId() {
  try {
    const db = await readDB();

    // Buscar configuração do platform-admin (configuração principal)
    const platformConfig = db.pagarmeConfigs?.find(c => c.userId === 'platform-admin');

    if (platformConfig && platformConfig.splitReceiverId) {
      console.log('🏦 Recipient ID da plataforma encontrado no banco de dados');
      return platformConfig.splitReceiverId;
    }

    // Fallback: buscar primeira configuração disponível
    const firstConfig = db.pagarmeConfigs?.[0];
    if (firstConfig && firstConfig.splitReceiverId) {
      console.log('🏦 Recipient ID encontrado no banco de dados (primeira config)');
      return firstConfig.splitReceiverId;
    }

    // Último fallback: tentar variável de ambiente
    if (process.env.PAGARME_PLATFORM_RECIPIENT_ID) {
      console.log('🏦 Recipient ID encontrado no .env');
      return process.env.PAGARME_PLATFORM_RECIPIENT_ID;
    }

    console.warn('⚠️ Nenhum Recipient ID da plataforma configurado');
    return null;
  } catch (error) {
    console.error('❌ Erro ao buscar Recipient ID:', error);
    return null;
  }
}

initDB();

// Tornar readDB e writeDB disponíveis para as rotas
app.set('readDB', readDB);
app.set('writeDB', writeDB);

// ==================== FUNÇÃO PARA BUSCAR TAXAS (PERSONALIZADA OU PADRÃO) ====================
/**
 * Busca taxas aplicáveis para um usuário e método de pagamento
 * Prioriza taxas personalizadas do usuário, senão usa taxas padrão da plataforma
 * @param {string} userId - ID do usuário
 * @param {string} paymentMethod - Método de pagamento ('pix', 'boleto', 'cartao', 'saque')
 * @param {Object} db - Instância do banco de dados
 * @returns {Object} Objeto com as taxas aplicáveis
 */
function getUserFees(userId, paymentMethod, db) {
  const user = db.users?.find(u => u.id === userId);
  const platformFees = db.platformFees || {};

  // Buscar taxas personalizadas do usuário
  const userCustomFees = user?.customFees?.[paymentMethod];

  // Mapear método para estrutura de platformFees
  const platformFeeKey = paymentMethod === 'cartao' ? 'card' : paymentMethod;
  const platformDefaultFees = platformFees[platformFeeKey] || {};

  // Função auxiliar para obter valor com fallback
  const getValue = (customKey, platformKey, defaultValue = 0) => {
    // Se existe valor personalizado e não está vazio, usa ele
    if (userCustomFees && userCustomFees[customKey] !== undefined && userCustomFees[customKey] !== '') {
      return parseFloat(userCustomFees[customKey]);
    }
    // Senão, usa valor padrão da plataforma
    if (platformDefaultFees[platformKey] !== undefined) {
      return parseFloat(platformDefaultFees[platformKey]);
    }
    // Fallback final
    return defaultValue;
  };

  // Retornar taxas baseado no método
  if (paymentMethod === 'pix') {
    return {
      fixedFee: getValue('fixedFee', 'fixedFee', 0),
      variableFee: getValue('variableFee', 'variableFee', 0),
      minFee: getValue('minFee', 'minFee', 0),
      retentionRate: getValue('retentionRate', 'retentionRate', 0),
      retentionDays: getValue('retentionDays', 'retentionDays', 0)
    };
  } else if (paymentMethod === 'boleto') {
    return {
      fixedFee: getValue('fixedFee', 'fixedFee', 0),
      variableFee: getValue('variableFee', 'variableFee', 0),
      retentionRate: getValue('retentionRate', 'retentionRate', 0),
      retentionDays: getValue('retentionDays', 'retentionDays', 0)
    };
  } else if (paymentMethod === 'cartao') {
    return {
      fixedFee: getValue('fixedFee', 'fixedFee', 0),
      variableFee: getValue('variableFee', 'variableFee', 0),
      fixedFee6x: getValue('fixedFee6x', 'installment6FixedFee', 0),
      variableFee6x: getValue('variableFee6x', 'installment6VariableFee', 0),
      fixedFee12x: getValue('fixedFee12x', 'installment12FixedFee', 0),
      variableFee12x: getValue('variableFee12x', 'installment12VariableFee', 0),
      retentionRate: getValue('retentionRate', 'retentionRate', 0),
      retentionDays: getValue('retentionDays', 'retentionDays', 0)
    };
  } else if (paymentMethod === 'saque') {
    return {
      fixedFee: getValue('fixedFee', 'fixedFee', 0),
      variableFee: getValue('variableFee', 'variableFee', 0),
      minWithdrawal: getValue('minWithdrawal', 'minWithdrawal', 0)
    };
  }

  return {};
}

// ==================== FUNÇÃO PARA VALIDAR SAQUES ====================
/**
 * Valida se um saque pode ser realizado baseado nas configurações do usuário
 * @param {string} userId - ID do usuário
 * @param {number} amount - Valor do saque em reais
 * @param {Object} db - Instância do banco de dados
 * @returns {Object} { valid: boolean, error: string }
 */
function validateWithdrawal(userId, amount, db) {
  const user = db.users?.find(u => u.id === userId);

  if (!user) {
    return { valid: false, error: 'Usuário não encontrado' };
  }

  const config = user.withdrawalConfig || {};
  const platformConfig = db.platformSettings?.withdrawal || {};

  // Valor mínimo (usa personalizado se existir, senão usa padrão)
  const minAmount = config.minPerWithdrawal || platformConfig.minPerWithdrawal || 10.00;
  if (amount < minAmount) {
    return {
      valid: false,
      error: `Valor mínimo para saque é R$ ${minAmount.toFixed(2)}`
    };
  }

  // Valor máximo por saque
  const maxPerWithdrawal = config.maxPerWithdrawal || platformConfig.maxPerWithdrawal;
  if (maxPerWithdrawal && amount > maxPerWithdrawal) {
    return {
      valid: false,
      error: `Valor máximo por saque é R$ ${maxPerWithdrawal.toFixed(2)}`
    };
  }

  // Verificar limite diário
  const maxDailyWithdrawal = config.maxDailyWithdrawal || platformConfig.maxDailyWithdrawal;
  if (maxDailyWithdrawal) {
    const today = new Date().toISOString().split('T')[0];
    const withdrawalsToday = db.withdrawals?.filter(w =>
      w.userId === userId &&
      w.status === 'completed' &&
      w.createdAt?.startsWith(today)
    ) || [];

    const totalToday = withdrawalsToday.reduce((sum, w) => sum + (w.amount || 0), 0);

    if ((totalToday + amount) > maxDailyWithdrawal) {
      const remaining = maxDailyWithdrawal - totalToday;
      return {
        valid: false,
        error: `Limite diário excedido. Você ainda pode sacar R$ ${remaining.toFixed(2)} hoje`
      };
    }
  }

  return { valid: true, error: null };
}

// ==================== FUNÇÃO PARA CALCULAR TAXA DE ANTECIPAÇÃO ====================
/**
 * Calcula a taxa de antecipação baseado na configuração do usuário
 * @param {string} userId - ID do usuário
 * @param {number} amount - Valor da transação em centavos
 * @param {number} installments - Número de parcelas
 * @param {Object} db - Instância do banco de dados
 * @returns {number} Taxa de antecipação em centavos
 */
function calculateAnticipationFee(userId, amount, installments, db) {
  // Antecipação só funciona para cartão
  if (installments === 1) {
    return 0; // Sem antecipação para pagamento à vista
  }

  const user = db.users?.find(u => u.id === userId);
  const config = user?.anticipationConfig || {};
  const platformConfig = db.platformSettings?.anticipation || {};

  // Verificar se antecipação customizada está ativada
  const customEnabled = config.customAnticipationEnabled || false;
  if (!customEnabled) {
    return 0; // Antecipação desativada para este vendedor
  }

  // Buscar taxa de antecipação (personalizada ou padrão)
  const anticipationRate = config.anticipationRate || platformConfig.anticipationRate || 0;
  const anticipationDays = config.anticipationDays || platformConfig.anticipationDays || 14;
  const calculateByDays = config.calculateByDays || platformConfig.calculateByDays || false;

  if (calculateByDays) {
    // Calcular taxa por dia antecipado
    // Taxa = (valor × taxa% × dias) / 30
    const dailyRate = (amount * (anticipationRate / 100) * anticipationDays) / 30;
    return Math.round(dailyRate);
  } else {
    // Taxa fixa sobre o valor total
    const fee = amount * (anticipationRate / 100);
    return Math.round(fee);
  }
}

// ==================== FUNÇÃO PARA CALCULAR SALDO DO USUÁRIO ====================
/**
 * Calcula o saldo completo do usuário incluindo saldo negativo
 * @param {string} userId - ID do usuário
 * @param {Object} db - Instância do banco de dados
 * @returns {Object} { available, pending, negative, withdrawn, total }
 */
function calculateUserBalance(userId, db) {
  const user = db.users?.find(u => u.id === userId);
  if (!user) {
    return { available: 0, pending: 0, negative: 0, withdrawn: 0, total: 0 };
  }

  // Buscar pedidos do vendedor
  const orders = db.orders?.filter(order =>
    (order.sellerId === userId || order.producerId === userId) && order.status === 'paid'
  ) || [];

  let availablePix = 0, availableBoleto = 0, availableCard = 0;
  let pendingPix = 0, pendingBoleto = 0, pendingCard = 0;

  const today = new Date();

  for (const order of orders) {
    const sellerAmount = order.sellerAmount || Math.round(order.totalAmount * 0.95);
    const paidDate = new Date(order.paidAt || order.createdAt);
    const daysSincePaid = Math.floor((today - paidDate) / (1000 * 60 * 60 * 24));

    const method = order.paymentMethod;

    if (method === 'pix') {
      // PIX disponível imediatamente
      availablePix += sellerAmount;
    } else if (method === 'boleto') {
      // Boleto disponível após 1 dia
      if (daysSincePaid >= 1) {
        availableBoleto += sellerAmount;
      } else {
        pendingBoleto += sellerAmount;
      }
    } else if (method === 'credit_card' || method === 'card') {
      // Cartão disponível após 30 dias
      if (daysSincePaid >= 30) {
        availableCard += sellerAmount;
      } else {
        pendingCard += sellerAmount;
      }
    }
  }

  const totalAvailable = availablePix + availableBoleto + availableCard;
  const totalPending = pendingPix + pendingBoleto + pendingCard;

  // Calcular saldo negativo
  let totalNegative = 0;
  if (user.negativeBalanceHistory && Array.isArray(user.negativeBalanceHistory)) {
    const activeNegatives = user.negativeBalanceHistory.filter(n => n.status === 'active');
    totalNegative = activeNegatives.reduce((sum, n) => sum + n.amount, 0);
  }

  // Calcular saques
  const withdrawals = db.withdrawals?.filter(w =>
    w.userId === userId && w.status === 'completed'
  ) || [];
  const totalWithdrawn = withdrawals.reduce((sum, w) => sum + (w.amount * 100 || 0), 0);

  return {
    available: totalAvailable,
    pending: totalPending,
    negative: totalNegative,
    withdrawn: totalWithdrawn,
    total: totalAvailable + totalPending + totalNegative - totalWithdrawn
  };
}

// ==================== FUNÇÃO PARA CALCULAR SPLITS E TAXAS ====================
/**
 * Calcula os valores de split baseado nas taxas da plataforma configuradas
 * @param {Object} params - Parâmetros para cálculo
 * @param {number} params.totalAmount - Valor total da transação
 * @param {string} params.paymentMethod - Método de pagamento (pix, boleto, card)
 * @param {number} params.installments - Número de parcelas (para cartão)
 * @param {string} params.producerId - ID do produtor
 * @param {string} params.affiliateId - ID do afiliado (opcional)
 * @param {number} params.affiliateCommission - Comissão do afiliado em % (opcional)
 * @returns {Object} - Objeto com valores calculados e splits
 */
function calculatePlatformSplits(params) {
  const {
    totalAmount,
    paymentMethod,
    installments = 1,
    producerId,
    productId = null,
    affiliateId = null,
    affiliateCommission = 0,
    selectedPlan = null
  } = params;

  const db = await readDB();

  // Buscar taxas da plataforma
  const platformFees = db.platformFees || {};

  let fixedFee = 0;
  let variableFeePercentage = 0;
  let minimumFee = 0;

  // Determinar taxas baseado no método de pagamento
  if (paymentMethod === 'pix' && platformFees.pix) {
    fixedFee = platformFees.pix.fixedFee || 0;
    variableFeePercentage = platformFees.pix.variableFee || 0;
    minimumFee = platformFees.pix.minimumFee || 0;
  } else if (paymentMethod === 'boleto' && platformFees.boleto) {
    fixedFee = platformFees.boleto.fixedFee || 0;
    variableFeePercentage = platformFees.boleto.variableFee || 0;
  } else if (paymentMethod === 'card' && platformFees.card) {
    // Para cartão, usar taxas baseadas no número de parcelas
    if (installments === 1) {
      // À vista
      fixedFee = platformFees.card.cashFixedFee || 0;
      variableFeePercentage = platformFees.card.cashVariableFee || 0;
    } else if (installments <= 6) {
      // Parcelado até 6x
      fixedFee = platformFees.card.installment6FixedFee || 0;
      variableFeePercentage = platformFees.card.installment6VariableFee || 0;
    } else {
      // Parcelado até 12x
      fixedFee = platformFees.card.installment12FixedFee || 0;
      variableFeePercentage = platformFees.card.installment12VariableFee || 0;
    }
  }

  // Calcular taxa variável
  const variableFee = (totalAmount * variableFeePercentage) / 100;

  // Taxa total da plataforma (SEMPRE PRIMEIRA - 10% FIXO)
  let platformFeeTotal = fixedFee + variableFee;

  // Aplicar taxa mínima se configurado
  if (minimumFee > 0 && platformFeeTotal < minimumFee) {
    platformFeeTotal = minimumFee;
  }

  // ========== BUSCAR GERENTES DO PRODUTO ==========
  let managersFees = [];
  let totalManagersFee = 0;

  if (productId) {
    const productManagers = (db.managers || []).filter(m =>
      m.productId === productId &&
      m.status === 'active'
    );

    // Calcular comissão de cada gerente
    productManagers.forEach(manager => {
      const user = db.users.find(u => u.id === manager.userId);
      if (!user || !user.pagarme?.recipientId) return;

      // Verificar escopo (todos os afiliados ou específicos)
      if (manager.scope === 'specific' && affiliateId) {
        if (!manager.affiliateIds || !manager.affiliateIds.includes(affiliateId)) {
          return; // Este gerente não gerencia este afiliado
        }
      }

      // Calcular comissão baseado no tipo
      let managerFee = 0;
      const hasAffiliate = affiliateId !== null;

      if (manager.commissionType === 'percentage') {
        const rate = hasAffiliate ? manager.withAffiliateRate : manager.withoutAffiliateRate;
        managerFee = (totalAmount * rate) / 100;
      } else if (manager.commissionType === 'fixed') {
        managerFee = hasAffiliate ? manager.withAffiliateRate : manager.withoutAffiliateRate;
      }

      if (managerFee > 0) {
        managersFees.push({
          managerId: manager.id,
          userId: manager.userId,
          recipientId: user.pagarme.recipientId,
          amount: managerFee,
          type: manager.commissionType,
          name: user.name
        });
        totalManagersFee += managerFee;
      }
    });
  }

  // ========== BUSCAR FORNECEDOR DO PLANO ==========
  let supplierFee = 0;
  let supplierData = null;

  if (selectedPlan && selectedPlan.supplierData && selectedPlan.supplierData.value > 0) {
    const supplier = db.users.find(u => u.email.toLowerCase() === selectedPlan.supplierData.email.toLowerCase());

    if (supplier && supplier.recipientId && supplier.documentsApproved && supplier.splitAccountActive) {
      supplierFee = selectedPlan.supplierData.value;
      supplierData = {
        userId: supplier.id,
        recipientId: supplier.recipientId,
        email: supplier.email,
        name: supplier.name || supplier.email,
        amount: supplierFee
      };
    }
  }

  // ========== CALCULAR COMISSÃO DO AFILIADO (10% DO RESTANTE) ==========
  let affiliateFee = 0;
  const remainingAfterPlatformAndManagers = totalAmount - platformFeeTotal - totalManagersFee;

  if (affiliateId && affiliateCommission > 0 && remainingAfterPlatformAndManagers > 0) {
    affiliateFee = (remainingAfterPlatformAndManagers * affiliateCommission) / 100;
  }

  // ========== PRODUTOR RECEBE O RESTANTE AUTOMÁTICO (DESCONTANDO FORNECEDOR) ==========
  const producerAmount = totalAmount - platformFeeTotal - totalManagersFee - affiliateFee - supplierFee;

  // Buscar recipient IDs
  const producer = db.users.find(u => u.id === producerId);
  const affiliate = affiliateId ? db.users.find(u => u.id === affiliateId) : null;

  // ========== MONTAR SPLITS NA ORDEM CORRETA PARA PAGAR.ME ==========
  const splits = [];
  const commissions = []; // Para salvar no banco

  // 1º → PLATAFORMA (SEMPRE PRIMEIRO)
  if (platformFeeTotal > 0) {
    splits.push({
      recipient_id: process.env.PAGARME_MASTER_RECIPIENT_ID || 're_master_default',
      amount: Math.round(platformFeeTotal * 100),
      liable: true,
      charge_processing_fee: true,
      type: 'platform'
    });
    commissions.push({
      type: 'platform',
      recipientId: process.env.PAGARME_MASTER_RECIPIENT_ID || 're_master_default',
      amount: platformFeeTotal,
      percentage: variableFeePercentage,
      order: 1
    });
  }

  // 2º → GERENTE(S)
  managersFees.forEach((manager, index) => {
    splits.push({
      recipient_id: manager.recipientId,
      amount: Math.round(manager.amount * 100),
      liable: false,
      charge_processing_fee: false,
      type: 'manager'
    });
    commissions.push({
      type: 'manager',
      managerId: manager.managerId,
      userId: manager.userId,
      recipientId: manager.recipientId,
      amount: manager.amount,
      commissionType: manager.type,
      order: 2 + index
    });
  });

  // 3º → AFILIADO (10% do restante)
  if (affiliateId && affiliateFee > 0) {
    splits.push({
      recipient_id: affiliate?.pagarmeRecipientId || 're_affiliate_default',
      amount: Math.round(affiliateFee * 100),
      liable: false,
      charge_processing_fee: false,
      type: 'affiliate'
    });
    commissions.push({
      type: 'affiliate',
      userId: affiliateId,
      recipientId: affiliate?.pagarmeRecipientId || 're_affiliate_default',
      amount: affiliateFee,
      percentage: affiliateCommission,
      order: 2 + managersFees.length + 1
    });
  }

  // 4º → FORNECEDOR (valor fixo)
  let currentOrder = 2 + managersFees.length + (affiliateFee > 0 ? 2 : 1);
  if (supplierData && supplierFee > 0) {
    splits.push({
      recipient_id: supplierData.recipientId,
      amount: Math.round(supplierFee * 100),
      liable: false,
      charge_processing_fee: false,
      type: 'supplier'
    });
    commissions.push({
      type: 'supplier',
      userId: supplierData.userId,
      recipientId: supplierData.recipientId,
      email: supplierData.email,
      name: supplierData.name,
      amount: supplierFee,
      order: currentOrder,
      description: 'Frete'
    });
    currentOrder++;
  }

  // 5º → PRODUTOR (RESTANTE AUTOMÁTICO)
  if (producerAmount > 0) {
    splits.push({
      recipient_id: producer?.pagarmeRecipientId || 're_producer_default',
      amount: Math.round(producerAmount * 100),
      liable: false,
      charge_processing_fee: false,
      type: 'producer'
    });
    commissions.push({
      type: 'producer',
      userId: producerId,
      recipientId: producer?.pagarmeRecipientId || 're_producer_default',
      amount: producerAmount,
      order: currentOrder
    });
  }

  return {
    totalAmount,
    platformFeeTotal,
    managersFees,
    totalManagersFee,
    affiliateFee,
    supplierFee,
    supplierData,
    producerAmount,
    splits,
    commissions,
    breakdown: {
      fixedFee,
      variableFee,
      variableFeePercentage,
      minimumFee,
      affiliateCommission
    }
  };
}

console.log('💰 Sistema de cálculo de splits da plataforma inicializado');

// ============ ROTAS DO PLATFORM ADMIN ============
// Middleware de debug para rastrear requisições do platform
app.use('/api/platform', (req, res, next) => {
  console.log('🔍 [PLATFORM DEBUG] Request:', {
    method: req.method,
    path: req.path,
    url: req.url,
    fullUrl: req.originalUrl,
    headers: req.headers.authorization ? 'Token presente' : 'Sem token'
  });
  next();
});

app.use('/api/platform', platformRoutes);
app.use('/api/platform/products', platformProductsRoutes);

// ============ ROTAS DE AFILIAÇÃO ============
app.use('/api/affiliations', affiliationsRoutes);

// ============ ROTAS DE CONQUISTAS/PREMIAÇÕES ============
app.use('/api/achievements', achievementsRoutes);

// ========== ENDPOINT DE ESTATÍSTICAS FINANCEIRAS DO ADMIN ==========

// Buscar estatísticas financeiras da plataforma
app.get('/api/platform/financial-stats', async (req, res) => {
  console.log('\n📊 Buscando estatísticas financeiras da plataforma...');

  const db = await readDB();

  try {
    // Calcular estatísticas baseadas em pedidos reais
    const allOrders = db.orders || [];
    const paidOrders = allOrders.filter(o => o.paymentStatus === 'paid');

    // Receita total (soma de todos os pedidos pagos)
    const totalRevenue = paidOrders.reduce((sum, order) => sum + (order.totalValue || 0), 0);

    // Comissão da plataforma (3% sobre as vendas)
    const platformCommissionRate = 0.03;
    const platformCommission = totalRevenue * platformCommissionRate;

    // Total repassado aos vendedores (97% das vendas)
    const totalPayouts = totalRevenue - platformCommission;

    // Repasses pendentes (pedidos pagos mas ainda não liberados)
    const today = new Date();
    const pendingReleaseOrders = paidOrders.filter(order => {
      if (!order.releaseDate) return true;
      const releaseDate = new Date(order.releaseDate);
      return releaseDate > today;
    });
    const pendingPayouts = pendingReleaseOrders.reduce((sum, order) => {
      const sellerAmount = order.producerCommission || (order.totalValue * 0.97);
      return sum + sellerAmount;
    }, 0);

    // Ticket médio
    const averageTicket = paidOrders.length > 0 ? totalRevenue / paidOrders.length : 0;

    // Crescimento mensal (simplificado - comparar com mês anterior)
    const currentMonth = new Date().getMonth();
    const currentYear = new Date().getFullYear();
    const lastMonth = currentMonth === 0 ? 11 : currentMonth - 1;
    const lastMonthYear = currentMonth === 0 ? currentYear - 1 : currentYear;

    const currentMonthOrders = paidOrders.filter(o => {
      const orderDate = new Date(o.paidAt || o.createdAt);
      return orderDate.getMonth() === currentMonth && orderDate.getFullYear() === currentYear;
    });

    const lastMonthOrders = paidOrders.filter(o => {
      const orderDate = new Date(o.paidAt || o.createdAt);
      return orderDate.getMonth() === lastMonth && orderDate.getFullYear() === lastMonthYear;
    });

    const currentMonthRevenue = currentMonthOrders.reduce((sum, o) => sum + (o.totalValue || 0), 0);
    const lastMonthRevenue = lastMonthOrders.reduce((sum, o) => sum + (o.totalValue || 0), 0);

    const monthlyGrowth = lastMonthRevenue > 0
      ? ((currentMonthRevenue - lastMonthRevenue) / lastMonthRevenue) * 100
      : 0;

    // Receita mensal (mês atual)
    const monthlyRevenue = currentMonthRevenue;
    const monthlyCommission = monthlyRevenue * platformCommissionRate;

    // Transações recentes (últimas 10)
    const recentTransactions = paidOrders
      .sort((a, b) => new Date(b.paidAt || b.createdAt) - new Date(a.paidAt || a.createdAt))
      .slice(0, 10)
      .map(order => ({
        id: order.id,
        type: 'commission',
        amount: (order.totalValue || 0) * platformCommissionRate,
        seller: order.producerName || 'Vendedor',
        product: order.productName || 'Produto',
        date: new Date(order.paidAt || order.createdAt).toLocaleString('pt-BR'),
        status: 'completed'
      }));

    // Cronograma de repasses (agrupar por data de liberação)
    const payoutSchedule = {};
    pendingReleaseOrders.forEach(order => {
      const releaseDate = order.releaseDate || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

      if (!payoutSchedule[releaseDate]) {
        payoutSchedule[releaseDate] = {
          date: releaseDate,
          sellers: new Set(),
          totalAmount: 0,
          orders: []
        };
      }

      const sellerAmount = order.producerCommission || (order.totalValue * 0.97);
      payoutSchedule[releaseDate].sellers.add(order.producerId);
      payoutSchedule[releaseDate].totalAmount += sellerAmount;
      payoutSchedule[releaseDate].orders.push(order.id);
    });

    const payoutScheduleArray = Object.values(payoutSchedule)
      .map(item => ({
        scheduledDate: item.date,
        amount: item.totalAmount,
        sellersCount: item.sellers.size,
        ordersCount: item.orders.length,
        status: 'scheduled'
      }))
      .sort((a, b) => new Date(a.scheduledDate) - new Date(b.scheduledDate))
      .slice(0, 10);

    // Dados para gráficos de vendas mensais (últimos 6 meses)
    const salesData = [];
    for (let i = 5; i >= 0; i--) {
      const monthDate = new Date(currentYear, currentMonth - i, 1);
      const month = monthDate.getMonth();
      const year = monthDate.getFullYear();
      const monthName = monthDate.toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '');

      const monthOrders = paidOrders.filter(o => {
        const orderDate = new Date(o.paidAt || o.createdAt);
        return orderDate.getMonth() === month && orderDate.getFullYear() === year;
      });

      const monthRevenue = monthOrders.reduce((sum, o) => sum + (o.totalValue || 0), 0);

      salesData.push({
        name: monthName.charAt(0).toUpperCase() + monthName.slice(1),
        vendas: monthOrders.length,
        receita: monthRevenue
      });
    }

    // Usuários recentes (do banco de dados de usuários)
    const allUsers = db.users || [];
    const recentUsers = allUsers
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 5)
      .map(user => ({
        id: user.id,
        name: user.name || 'Usuário',
        email: user.email,
        type: user.accountType || 'PF',
        date: new Date(user.createdAt).toLocaleDateString('pt-BR'),
        status: user.status || 'approved'
      }));

    // Produtos mais vendidos
    const productSales = {};
    paidOrders.forEach(order => {
      const productId = order.productId;
      const productName = order.productName || 'Produto';

      if (!productSales[productId]) {
        productSales[productId] = {
          id: productId,
          name: productName,
          seller: order.producerName || 'Vendedor',
          sales: 0,
          revenue: 0
        };
      }

      productSales[productId].sales += 1;
      productSales[productId].revenue += order.totalValue || 0;
    });

    const topProducts = Object.values(productSales)
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);

    res.json({
      success: true,
      stats: {
        totalRevenue,
        platformCommission,
        totalPayouts,
        pendingPayouts,
        averageTicket,
        monthlyGrowth,
        monthlyRevenue,
        monthlyCommission
      },
      salesData,
      recentTransactions,
      payoutSchedule: payoutScheduleArray,
      recentUsers,
      topProducts
    });

  } catch (error) {
    console.error('❌ Erro ao buscar estatísticas financeiras:', error);
    res.status(500).json({
      error: 'Erro ao buscar estatísticas financeiras',
      message: error.message
    });
  }
});

// Rotas de Autenticação

// Login de Usuário
app.post('/api/auth/login/user', async (req, res) => {
  const db = await readDB();
  const { email, password } = req.body;

  const user = db.users.find(u => u.email === email && u.role === 'user');

  if (!user) {
    return res.status(401).json({ success: false, error: 'Email ou senha inválidos ou você não tem permissão de usuário' });
  }

  // Verificar senha com bcrypt
  const isPasswordValid = await bcrypt.compare(password, user.password);

  if (isPasswordValid) {
    const { password: _, ...userWithoutPassword } = user;
    res.json({
      success: true,
      user: userWithoutPassword,
      token: uuidv4()
    });
  } else {
    res.status(401).json({ success: false, error: 'Email ou senha inválidos ou você não tem permissão de usuário' });
  }
});

// Login de Administrador
app.post('/api/auth/login/admin', async (req, res) => {
  const db = await readDB();
  const { email, password } = req.body;

  const user = db.users.find(u => u.email === email && u.role === 'admin');

  if (!user) {
    return res.status(401).json({ success: false, error: 'Email ou senha inválidos ou você não tem permissão de administrador' });
  }

  // Verificar senha com bcrypt
  const isPasswordValid = await bcrypt.compare(password, user.password);

  if (isPasswordValid) {
    const { password: _, ...userWithoutPassword } = user;
    res.json({
      success: true,
      user: userWithoutPassword,
      token: uuidv4()
    });
  } else {
    res.status(401).json({ success: false, error: 'Email ou senha inválidos ou você não tem permissão de administrador' });
  }
});

// Manter endpoint genérico para compatibilidade (deprecated)
app.post('/api/auth/login', async (req, res) => {
  const db = await readDB();
  const { email, password } = req.body;

  const user = db.users.find(u => u.email === email);

  if (!user) {
    return res.status(401).json({ success: false, error: 'Email ou senha inválidos' });
  }

  // Verificar senha com bcrypt
  const isPasswordValid = await bcrypt.compare(password, user.password);

  if (isPasswordValid) {
    const { password: _, ...userWithoutPassword } = user;
    res.json({
      success: true,
      user: userWithoutPassword,
      token: uuidv4()
    });
  } else {
    res.status(401).json({ success: false, error: 'Email ou senha inválidos' });
  }
});

// Endpoint de Upload de Imagens
app.post('/api/upload/image', upload.single('image'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nenhuma imagem foi enviada' });
    }

    // Retornar a URL da imagem
    const imageUrl = `http://localhost:${PORT}/uploads/${req.file.filename}`;

    res.json({
      success: true,
      url: imageUrl,
      filename: req.file.filename,
      size: req.file.size,
      mimetype: req.file.mimetype
    });
  } catch (error) {
    console.error('Erro ao fazer upload:', error);
    res.status(500).json({ error: 'Erro ao fazer upload da imagem' });
  }
});

app.post('/api/auth/register', async (req, res) => {
  const db = await readDB();
  const { email, password, name, phone } = req.body;

  // Validar senha forte
  const passwordValidation = validatePassword(password);
  if (!passwordValidation.valid) {
    return res.status(400).json({
      success: false,
      error: 'Senha não atende aos requisitos de segurança',
      errors: passwordValidation.errors
    });
  }

  const existingUser = db.users.find(u => u.email === email);
  if (existingUser) {
    return res.status(400).json({ success: false, error: 'Email já cadastrado' });
  }

  // Hash da senha com bcrypt
  const hashedPassword = await bcrypt.hash(password, 10);

  const newUser = {
    id: uuidv4(),
    email,
    password: hashedPassword,
    name,
    phone: phone || '',
    role: 'user',
    status: 'novo', // Status inicial: usuário recém-criado (sem documentos)
    commissionRate: 70, // Taxa de comissão padrão
    createdAt: new Date().toISOString()
  };

  db.users.push(newUser);
  writeDB(db);

  logger.info('Novo usuário registrado:', {
    userId: newUser.id,
    email: newUser.email,
    name: newUser.name
  });

  const { password: _, ...userWithoutPassword } = newUser;
  res.status(201).json({
    success: true,
    user: userWithoutPassword,
    token: uuidv4(),
    message: 'Conta criada com sucesso!'
  });
});

// Validar senha (endpoint para feedback em tempo real no frontend)
app.post('/api/auth/validate-password', async (req, res) => {
  const { password } = req.body;

  const validation = validatePassword(password);
  const strength = getPasswordStrength(password);

  res.json({
    valid: validation.valid,
    errors: validation.errors,
    strength: strength.strength,
    score: strength.score
  });
});

// Rotas de Produtos
app.get('/api/products', async (req, res) => {
  const db = await readDB();
  const { userId, type } = req.query;

  console.log('🔍 GET /api/products - type:', type, 'userId:', userId);
  let products = db.products;
  console.log('📦 Total de produtos no banco:', products.length);

  if (type === 'my-products' && userId) {
    products = products.filter(p => p.producerId === userId);
  } else if (type === 'affiliate-store') {
    console.log('🏪 Filtrando produtos para vitrine...');
    // Filtrar apenas produtos APROVADOS e visíveis na vitrine
    products = products.filter(p => {
      const isApproved = p.approvalStatus === 'APROVADO';
      const isVisible = p.affiliateConfig?.visibleInStore === true;
      console.log(`  - ${p.name}: aprovado=${isApproved}, visível=${isVisible}`);
      return isApproved && isVisible;
    });
    console.log('✅ Produtos filtrados para vitrine:', products.length);

    // Filtrar planos ocultos para afiliados
    products = products.map(p => ({
      ...p,
      plans: (p.plans || []).filter(plan => !plan.hideFromAffiliates)
    }));

    // Calcular vendas por produto para determinar bestsellers
    const salesByProduct = {};
    db.orders.forEach(order => {
      if (order.paymentStatus === 'paid') {
        order.items.forEach(item => {
          salesByProduct[item.productId] = (salesByProduct[item.productId] || 0) + item.quantity;
        });
      }
    });

    // Determinar threshold para bestseller (top 20% dos produtos mais vendidos)
    const salesValues = Object.values(salesByProduct).sort((a, b) => b - a);
    const bestsellerThreshold = salesValues.length > 0 ? salesValues[Math.floor(salesValues.length * 0.2)] || 5 : 5;

    // Adicionar flag isBestseller aos produtos
    products = products.map(p => ({
      ...p,
      totalSales: salesByProduct[p.id] || 0,
      isBestseller: (salesByProduct[p.id] || 0) >= bestsellerThreshold && (salesByProduct[p.id] || 0) >= 5
    }));
  } else if (type === 'my-affiliations' && userId) {
    const userAffiliations = db.affiliations.filter(a => a.affiliateId === userId);
    const affiliatedProductIds = userAffiliations.map(a => a.productId);
    products = products.filter(p => affiliatedProductIds.includes(p.id));

    // Filtrar planos ocultos para afiliados
    products = products.map(p => ({
      ...p,
      plans: (p.plans || []).filter(plan => !plan.hideFromAffiliates)
    }));
  }

  res.json(products);
});

app.get('/api/products/:id', async (req, res) => {
  const db = await readDB();
  const product = db.products.find(p => p.id === req.params.id);
  if (product) {
    res.json(product);
  } else {
    res.status(404).json({ error: 'Produto não encontrado' });
  }
});

app.post('/api/products', async (req, res) => {
  const db = await readDB();
  const productData = req.body;

  // Configuração padrão de checkout se não fornecida
  const defaultCheckoutConfig = {
    description: 'Checkout Padrão',
    paymentMethods: {
      boleto: true,
      creditCard: true,
      pix: true,
      receiveAndPay: false
    },
    boletoDueDays: 5,
    pixExpirationMinutes: 2880,
    shipping: {
      isFree: true,
      value: 0
    },
    countdown: {
      enabled: false,
      backgroundColor: '#ffffff',
      textColor: '#000000',
      time: '00:00:00',
      title: 'Tempo limitado!',
      text: 'Preço promocional encerrará em:'
    }
  };

  const newProduct = {
    id: uuidv4(),
    code: generateProductCode(),
    ...productData,
    // Garantir que checkoutConfig existe com valores padrão
    checkoutConfig: productData.checkoutConfig || defaultCheckoutConfig,
    createdAt: new Date().toISOString(),
    status: 'active',
    approvalStatus: 'PENDENTE'
  };

  db.products.push(newProduct);
  writeDB(db);

  res.status(201).json(newProduct);
});

app.patch('/api/products/:id', async (req, res) => {
  const db = await readDB();
  const productIndex = db.products.findIndex(p => p.id === req.params.id);

  if (productIndex === -1) {
    return res.status(404).json({ error: 'Produto não encontrado' });
  }

  console.log('\n========================================');
  console.log('📝 PATCH /api/products/:id');
  console.log('========================================');
  console.log('ID do produto:', req.params.id);
  console.log('🏪 affiliateConfig no body:', JSON.stringify(req.body.affiliateConfig, null, 2));
  console.log('✅ approvalStatus no body:', req.body.approvalStatus);
  console.log('Cupons no body:', req.body.coupons);
  console.log('Quantidade de cupons:', req.body.coupons?.length || 0);
  console.log('Tipo do coupons:', typeof req.body.coupons);
  console.log('É array?', Array.isArray(req.body.coupons));

  if (req.body.coupons && Array.isArray(req.body.coupons)) {
    console.log('CUPONS DETALHADOS:');
    req.body.coupons.forEach((coupon, index) => {
      console.log(`  Cupom ${index + 1}:`, JSON.stringify(coupon));
    });
  }

  console.log('Produto ANTES da atualização:', {
    id: db.products[productIndex].id,
    approvalStatus: db.products[productIndex].approvalStatus,
    affiliateConfig: db.products[productIndex].affiliateConfig,
    coupons: db.products[productIndex].coupons?.length || 0
  });

  db.products[productIndex] = {
    ...db.products[productIndex],
    ...req.body,
    updatedAt: new Date().toISOString()
  };

  writeDB(db);

  console.log('Produto DEPOIS da atualização:', {
    id: db.products[productIndex].id,
    approvalStatus: db.products[productIndex].approvalStatus,
    affiliateConfig: db.products[productIndex].affiliateConfig,
    coupons: db.products[productIndex].coupons?.length || 0
  });
  console.log('✅ Produto salvo no database.json');
  console.log('🏪 Aparece na vitrine?',
    db.products[productIndex].approvalStatus === 'APROVADO' &&
    db.products[productIndex].affiliateConfig?.visibleInStore === true ? '✅ SIM' : '❌ NÃO'
  );
  console.log('========================================\n');

  res.json(db.products[productIndex]);
});

// Solicitar exclusão de produto
app.post('/api/products/:id/request-deletion', async (req, res) => {
  const db = await readDB();
  const { reason, userId, userName } = req.body;
  const productIndex = db.products?.findIndex(p => p.id == req.params.id);

  if (productIndex === -1 || productIndex === undefined) {
    return res.status(404).json({ error: 'Produto não encontrado' });
  }

  const product = db.products[productIndex];

  // Inicializar array de solicitações de exclusão se não existir
  if (!db.deletionRequests) {
    db.deletionRequests = [];
  }

  // Criar solicitação de exclusão
  const deletionRequest = {
    id: Date.now(),
    productId: product.id,
    productName: product.name,
    productCategory: product.category,
    productPrice: product.price,
    userId: userId,
    userName: userName,
    reason: reason,
    status: 'pending', // pending, approved, rejected
    requestedAt: new Date().toISOString(),
    reviewedAt: null,
    reviewedBy: null,
    reviewerNotes: null
  };

  db.deletionRequests.push(deletionRequest);
  writeDB(db);

  console.log(`🗑️ [USER] Solicitação de exclusão criada para produto: ${product.name} por ${userName}`);

  res.json({
    success: true,
    message: 'Solicitação de exclusão enviada com sucesso',
    request: deletionRequest
  });
});

// ========== ROTAS DE APROVAÇÃO DE PRODUTOS (ADMIN) ==========

// Listar todos os produtos (com filtro por approvalStatus)
app.get('/api/admin/products', async (req, res) => {
  const db = await readDB();
  const { approvalStatus } = req.query;

  let products = db.products;

  if (approvalStatus) {
    products = products.filter(p => p.approvalStatus === approvalStatus);
  }

  res.json(products);
});

// Aprovar produto
app.patch('/api/admin/products/:id/approve', async (req, res) => {
  const db = await readDB();
  const productIndex = db.products.findIndex(p => p.id === req.params.id);

  if (productIndex === -1) {
    return res.status(404).json({ error: 'Produto não encontrado' });
  }

  db.products[productIndex].approvalStatus = 'APROVADO';
  db.products[productIndex].approvedAt = new Date().toISOString();

  writeDB(db);

  // 🔔 CRIAR NOTIFICAÇÃO para o produtor sobre aprovação do produto
  const product = db.products[productIndex]
  if (product.producerId) {
    global.createNotification(
      product.producerId,
      'product_approved',
      '✅ Produto Aprovado!',
      `Seu produto "${product.name}" foi aprovado e já está disponível para venda!`,
      {
        important: true,
        data: {
          productId: product.id,
          productName: product.name
        },
        actionButton: {
          text: 'Ver Produto',
          icon: '📦',
          link: `/products/${product.id}/edit`
        }
      }
    )
  }

  console.log(`✅ Produto aprovado: ${db.products[productIndex].name}`);

  res.json({
    success: true,
    message: 'Produto aprovado com sucesso',
    product: db.products[productIndex]
  });
});

// Rejeitar produto
app.patch('/api/admin/products/:id/reject', async (req, res) => {
  const db = await readDB();
  const { reason } = req.body;
  const productIndex = db.products.findIndex(p => p.id === req.params.id);

  if (productIndex === -1) {
    return res.status(404).json({ error: 'Produto não encontrado' });
  }

  db.products[productIndex].approvalStatus = 'REJEITADO';
  db.products[productIndex].rejectedAt = new Date().toISOString();
  db.products[productIndex].rejectionReason = reason || 'Não especificado';

  writeDB(db);

  // 🔔 CRIAR NOTIFICAÇÃO para o produtor sobre rejeição do produto
  const product = db.products[productIndex]
  if (product.producerId) {
    global.createNotification(
      product.producerId,
      'product_rejected',
      '❌ Produto Rejeitado',
      `Seu produto "${product.name}" foi rejeitado. Motivo: ${reason || 'Não especificado'}`,
      {
        important: true,
        data: {
          productId: product.id,
          productName: product.name,
          reason: reason
        },
        actionButton: {
          text: 'Ver Produto',
          icon: '📦',
          link: `/products/${product.id}/edit`
        }
      }
    )
  }

  console.log(`❌ Produto rejeitado: ${db.products[productIndex].name} - Motivo: ${reason}`);

  res.json({
    success: true,
    message: 'Produto rejeitado',
    product: db.products[productIndex]
  });
});


// Rotas de Afiliações
app.post('/api/affiliations', async (req, res) => {
  const db = await readDB();
  const { productId, affiliateId } = req.body;

  const product = db.products.find(p => p.id === productId);
  const affiliate = db.users.find(u => u.id === affiliateId);

  if (!product || !affiliate) {
    return res.status(404).json({ error: 'Produto ou afiliado não encontrado' });
  }

  if (!product.affiliateEnabled) {
    return res.status(400).json({ error: 'Este produto não aceita afiliados' });
  }

  const existingAffiliation = db.affiliations.find(
    a => a.productId === productId && a.affiliateId === affiliateId
  );

  if (existingAffiliation) {
    return res.status(400).json({ error: 'Você já é afiliado deste produto' });
  }

  const affiliation = {
    id: uuidv4(),
    productId,
    affiliateId,
    affiliateName: affiliate.name,
    productName: product.name,
    commission: product.affiliateCommission,
    createdAt: new Date().toISOString(),
    status: 'active'
  };

  db.affiliations.push(affiliation);
  writeDB(db);

  res.status(201).json(affiliation);
});

app.get('/api/affiliations', async (req, res) => {
  const db = await readDB();
  const { affiliateId } = req.query;

  let affiliations = db.affiliations;

  if (affiliateId) {
    affiliations = affiliations.filter(a => a.affiliateId === affiliateId);
  }

  res.json(affiliations);
});

// Rotas de Pedidos
app.post('/api/orders', async (req, res) => {
  const db = await readDB();
  const { productId, customer, quantity = 1, paymentMethod = 'pix', pixExpirationMinutes = 2880, boletoDueDays = 5, affiliateId = null, selectedPlanName = null } = req.body;

  const product = db.products.find(p => p.id === productId);
  if (!product) {
    return res.status(404).json({ error: 'Produto não encontrado' });
  }

  // ========== CORREÇÃO: Usar preço do PLANO se selecionado ==========
  let finalPrice = product.price;
  let selectedPlan = null;

  if (selectedPlanName && product.plans && product.plans.length > 0) {
    selectedPlan = product.plans.find(p => p.name === selectedPlanName);
    if (selectedPlan) {
      finalPrice = selectedPlan.price;
      console.log(`✅ Plano selecionado: "${selectedPlanName}" - Preço: R$ ${finalPrice}`);
    } else {
      console.log(`⚠️ Plano "${selectedPlanName}" não encontrado, usando preço base: R$ ${product.price}`);
    }
  }

  const totalValue = finalPrice * quantity;
  console.log(`📊 Cálculo: R$ ${finalPrice} x ${quantity} = R$ ${totalValue}`);

  // ========== CALCULAR SPLITS DA PLATAFORMA (COM GERENTES E FORNECEDOR) ==========
  const installments = req.body.installments || 1;

  // ========== DETERMINAR COMISSÃO DO AFILIADO ==========
  let affiliateCommission = 0;

  if (product.affiliateEnabled) {
    // Verificar se o PLANO tem comissão personalizada
    if (selectedPlan && selectedPlan.affiliation && selectedPlan.affiliation.customCommission) {
      // Usar comissão do PLANO
      const planCommission = selectedPlan.affiliation.customCommissionValue || 0;
      const planType = selectedPlan.affiliation.commissionType || 'percentage';

      if (planType === 'percentage') {
        affiliateCommission = planCommission; // Já é porcentagem
      } else {
        // Tipo 'fixed' - converter para porcentagem baseado no valor total
        affiliateCommission = (planCommission / totalValue) * 100;
      }

      console.log(`🎯 Comissão do PLANO: ${selectedPlan.affiliation.commissionType === 'fixed' ? `R$ ${planCommission} (fixo)` : `${planCommission}%`}`);
    } else {
      // Usar comissão padrão do PRODUTO
      affiliateCommission = product.affiliateCommission || 0;
      console.log(`📦 Comissão padrão do PRODUTO: ${affiliateCommission}%`);
    }
  }

  const splitCalculation = calculatePlatformSplits({
    totalAmount: totalValue,
    paymentMethod: paymentMethod,
    installments: installments,
    producerId: product.producerId,
    productId: productId, // ✅ NOVO: Passar productId para buscar gerentes
    affiliateId: affiliateId,
    affiliateCommission: affiliateCommission, // ✅ MODIFICADO: Usa comissão do plano ou produto
    selectedPlan: selectedPlan // ✅ NOVO: Passar plano para buscar fornecedor
  });

  console.log(`\n💰 ========== CÁLCULO DE SPLITS (COM GERENTES) ==========`);
  console.log(`Valor Total: R$ ${splitCalculation.totalAmount.toFixed(2)}`);
  console.log(`1º Plataforma: R$ ${splitCalculation.platformFeeTotal.toFixed(2)}`);
  console.log(`  - Taxa Fixa: R$ ${splitCalculation.breakdown.fixedFee.toFixed(2)}`);
  console.log(`  - Taxa Variável: R$ ${splitCalculation.breakdown.variableFee.toFixed(2)} (${splitCalculation.breakdown.variableFeePercentage}%)`);
  if (splitCalculation.managersFees && splitCalculation.managersFees.length > 0) {
    console.log(`2º Gerente(s): R$ ${splitCalculation.totalManagersFee.toFixed(2)}`);
    splitCalculation.managersFees.forEach((mgr, i) => {
      console.log(`  - Gerente ${i + 1}: R$ ${mgr.amount.toFixed(2)}`);
    });
  }
  if (splitCalculation.affiliateFee > 0) {
    console.log(`3º Comissão Afiliado: R$ ${splitCalculation.affiliateFee.toFixed(2)} (${splitCalculation.breakdown.affiliateCommission}%)`);
  }
  if (splitCalculation.supplierFee > 0) {
    console.log(`4º Fornecedor (Frete): R$ ${splitCalculation.supplierFee.toFixed(2)}`);
    console.log(`  - Nome: ${splitCalculation.supplierData.name}`);
  }
  const orderNum = 4 + (splitCalculation.supplierFee > 0 ? 1 : 0);
  console.log(`${orderNum}º Valor Produtor (RESTANTE): R$ ${splitCalculation.producerAmount.toFixed(2)}`);
  console.log(`=========================================================\n`);

  // ========== LOG DE DEPURAÇÃO: Dados do Cliente ==========
  console.log(`\n👤 ========== DADOS DO CLIENTE RECEBIDOS ==========`);
  console.log(`Nome: "${customer?.name || 'NÃO INFORMADO'}"`);
  console.log(`Email: "${customer?.email || 'NÃO INFORMADO'}"`);
  console.log(`CPF: "${customer?.cpf || 'NÃO INFORMADO'}"`);
  console.log(`Telefone: "${customer?.phone || 'NÃO INFORMADO'}"`);
  console.log(`Endereço: "${customer?.address || 'NÃO INFORMADO'}"`);
  console.log(`Número: "${customer?.number || 'NÃO INFORMADO'}"`);
  console.log(`Bairro: "${customer?.neighborhood || 'NÃO INFORMADO'}"`);
  console.log(`Cidade: "${customer?.city || 'NÃO INFORMADO'}"`);
  console.log(`Estado: "${customer?.state || 'NÃO INFORMADO'}"`);
  console.log(`CEP: "${customer?.zipCode || 'NÃO INFORMADO'}"`);
  console.log(`==================================================\n`);

  // Calcular comissões (mantido para compatibilidade)
  let producerCommission = splitCalculation.producerAmount;
  let affiliateCommissionAmount = splitCalculation.affiliateFee;

  const orderId = uuidv4();

  const order = {
    id: orderId,
    productId,
    productCode: product.code,
    productName: product.name,
    selectedPlanName,
    selectedPlanPrice: selectedPlan ? selectedPlan.price : null,
    plan: selectedPlan ? {  // ✅ NOVO: Objeto completo do plano para gerar link do checkout
      code: selectedPlan.code,
      name: selectedPlan.name,
      price: selectedPlan.price,
      description: selectedPlan.description,
      itemsQuantity: selectedPlan.itemsQuantity
    } : null,
    productPrice: finalPrice,  // Preço final (plano ou base)
    quantity,
    totalValue,
    producerId: product.producerId,
    producerName: product.producerName,
    affiliateId,
    affiliateName: affiliateId ? db.users.find(u => u.id === affiliateId)?.name : null,
    affiliateEmail: affiliateId ? db.users.find(u => u.id === affiliateId)?.email : null,
    producerCommission,
    affiliateCommission: affiliateCommissionAmount,
    // ✅ NOVO: Informações de splits da plataforma
    platformFee: splitCalculation.platformFeeTotal,
    platformFeeBreakdown: splitCalculation.breakdown,
    splits: splitCalculation.splits, // Splits prontos para enviar à Pagar.me
    customer,
    paymentMethod,
    installments,
    pixExpirationMinutes: paymentMethod === 'pix' ? pixExpirationMinutes : undefined,
    boletoDueDays: paymentMethod === 'boleto' ? boletoDueDays : undefined,
    paymentStatus: paymentMethod === 'afterPay' ? 'scheduled' : 'pending',
    status: 'pending',
    trackingCode: null,
    shippingInfo: {
      carrier: null,
      estimatedDelivery: null,
      shippingStatus: 'not_shipped',
      shippingDate: null
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    paidAt: null
  };

  db.orders.push(order);

  // ========== LOG: Confirmar que foi salvo corretamente ==========
  console.log(`✅ ========== PEDIDO SALVO NO BANCO ==========`);
  console.log(`ID do Pedido: ${order.id}`);
  console.log(`Cliente salvo: "${order.customer?.name}"`);
  console.log(`Email salvo: "${order.customer?.email}"`);
  console.log(`CPF salvo: "${order.customer?.cpf}"`);
  console.log(`Endereço salvo: "${order.customer?.address}, ${order.customer?.number}"`);
  console.log(`Cidade salva: "${order.customer?.city}/${order.customer?.state}"`);
  console.log(`Valor salvo: R$ ${order.totalValue}`);
  console.log(`Plano salvo: "${order.selectedPlanName || 'Sem plano'}"`);
  console.log(`==============================================\n`);

  // ========== CRIAR REGISTROS DE COMISSÕES (TODAS) ==========
  if (!db.orderCommissions) {
    db.orderCommissions = [];
  }

  // Salvar todas as comissões na ordem correta
  if (splitCalculation.commissions && splitCalculation.commissions.length > 0) {
    splitCalculation.commissions.forEach(comm => {
      const commissionRecord = {
        id: uuidv4(),
        orderId: order.id,
        productId,
        type: comm.type, // 'platform', 'manager', 'affiliate', 'producer'
        userId: comm.userId || null,
        managerId: comm.managerId || null,
        recipientId: comm.recipientId,
        amount: comm.amount,
        percentage: comm.percentage || null,
        commissionType: comm.commissionType || null,
        order: comm.order, // Ordem de pagamento (1, 2, 3, 4...)
        status: 'pending',
        createdAt: new Date().toISOString(),
        paidAt: null
      };
      db.orderCommissions.push(commissionRecord);
    });

    console.log(`✅ ${splitCalculation.commissions.length} comissões salvas no banco`);
  }

  // ========== MANTER COMPATIBILIDADE COM SISTEMA ANTIGO ==========
  if (affiliateCommissionAmount > 0) {
    const commission = {
      id: uuidv4(),
      orderId: order.id,
      productId,
      producerId: product.producerId,
      affiliateId,
      producerCommission,
      affiliateCommission: affiliateCommissionAmount,
      totalValue,
      status: 'pending',
      createdAt: new Date().toISOString()
    };
    db.commissions.push(commission);
  }

  // Se for AfterPay, associar CPF bloqueado ao pedido
  if (paymentMethod === 'afterPay' && customer.cpf) {
    if (!db.blockedCpfs) {
      db.blockedCpfs = [];
    }

    // Atualizar bloqueio pendente ou criar novo
    const blockedCpfIndex = db.blockedCpfs.findIndex(b => b.cpf === customer.cpf && b.orderId === 'pending');
    if (blockedCpfIndex !== -1) {
      db.blockedCpfs[blockedCpfIndex].orderId = order.id;
    } else {
      db.blockedCpfs.push({
        id: uuidv4(),
        cpf: customer.cpf,
        orderId: order.id,
        blockedAt: new Date().toISOString()
      });
    }
  }

  writeDB(db);

  // 🔔 CRIAR NOTIFICAÇÃO PARA O PRODUTOR sobre novo pedido criado
  if (product.producerId) {
    const totalFormatted = new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL'
    }).format(totalValue)

    const paymentMethodNames = {
      'pix': 'PIX',
      'boleto': 'Boleto',
      'credit-card': 'Cartão de Crédito',
      'afterPay': 'After Pay'
    }

    global.createNotification(
      product.producerId,
      'sale_new',
      '🛒 Novo Pedido Criado!',
      `Novo pedido de ${paymentMethodNames[paymentMethod] || paymentMethod} no valor de ${totalFormatted} foi criado e está aguardando pagamento.`,
      {
        important: false,
        data: {
          orderId: order.id,
          amount: totalValue,
          paymentMethod: paymentMethod
        },
        actionButton: {
          text: 'Ver Pedido',
          icon: '📊',
          link: `/sales/${order.id}`
        }
      }
    )
  }

  // Disparar webhook baseado no status do pedido
  if (paymentMethod === 'afterPay') {
    // AfterPay começa como "agendado"
    dispararWebhookPortugues(product.producerId, 'agendado', order);

    // Enviar pedido AfterPay (agendado) ao Notazz
    console.log(`\n🔍 Verificando configuração Notazz para usuário ${product.producerId}...`);
    const notazzConfig = db.notazzConfigs?.find(c => c.userId === product.producerId);

    if (notazzConfig) {
      console.log(`✅ Configuração Notazz encontrada:`, {
        webhookId: notazzConfig.webhookId,
        enabled: notazzConfig.enabled,
        autoSend: notazzConfig.autoSend
      });

      if (notazzConfig.enabled && notazzConfig.autoSend) {
        console.log(`🚀 Enviando pedido AfterPay ${order.id} (agendado) automaticamente para Notazz...`);
        enviarPedidoNotazz(order.id, product.producerId);
      } else {
        console.log(`⚠️ Notazz configurado mas:`, {
          enabled: notazzConfig.enabled,
          autoSend: notazzConfig.autoSend
        });
        console.log(`Pedido ${order.id} NÃO será enviado automaticamente`);
      }
    } else {
      console.log(`❌ Nenhuma configuração Notazz encontrada para usuário ${product.producerId}`);
      console.log(`Total de configurações Notazz no banco: ${db.notazzConfigs?.length || 0}`);
      if (db.notazzConfigs && db.notazzConfigs.length > 0) {
        console.log(`IDs de usuários com Notazz configurado:`, db.notazzConfigs.map(c => c.userId));
      }
    }
  } else {
    // Outros métodos começam como "aguardando pagamento"
    dispararWebhookPortugues(product.producerId, 'aguardandoPagamento', order);
  }

  res.status(201).json(order);
});

app.get('/api/orders', async (req, res) => {
  const db = await readDB();
  const { userId, syncReleaseDate } = req.query;

  let orders = db.orders;

  // Filtrar por userId se fornecido
  if (userId) {
    orders = orders.filter(o => o.producerId === userId || o.affiliateId === userId);
  }

  // Se solicitado, sincronizar datas de liberação do Pagar.me
  if (syncReleaseDate === 'true' && userId) {
    try {
      const pagarmeConfig = db.pagarmeConfigs?.find(c => c.userId === userId);

      if (pagarmeConfig && pagarmeConfig.privateKey) {
        // Buscar pedidos pagos que têm ID do Pagar.me mas não têm data de liberação
        const ordersToSync = orders.filter(o =>
          o.paymentStatus === 'paid' &&
          o.pagarmeOrderId &&
          (!o.releaseDate || o.releaseDateSource !== 'pagarme_api')
        );

        console.log(`🔄 Sincronizando datas de liberação de ${ordersToSync.length} pedidos...`);

        // Sincronizar em paralelo (limitar a 5 por vez para não sobrecarregar)
        const batchSize = 5;
        for (let i = 0; i < ordersToSync.length; i += batchSize) {
          const batch = ordersToSync.slice(i, i + batchSize);

          await Promise.all(batch.map(async (order) => {
            try {
              const releaseDate = await pagarmeService.getReleaseDate(order.pagarmeOrderId, pagarmeConfig.privateKey);

              if (releaseDate) {
                const orderIndex = db.orders.findIndex(o => o.id === order.id);
                if (orderIndex !== -1) {
                  db.orders[orderIndex].releaseDate = releaseDate;
                  db.orders[orderIndex].releaseDateSource = 'pagarme_api';
                  db.orders[orderIndex].releaseDateSyncedAt = new Date().toISOString();
                }
              }
            } catch (error) {
              console.error(`Erro ao sincronizar pedido ${order.id}:`, error.message);
            }
          }));
        }

        writeDB(db);
        console.log(`✅ Sincronização concluída`);

        // Recarregar orders após sincronização
        orders = db.orders.filter(o => o.producerId === userId || o.affiliateId === userId);
      }
    } catch (error) {
      console.error('Erro na sincronização automática:', error);
      // Continuar mesmo com erro, retornar os pedidos como estão
    }
  }

  res.json(orders);
});

app.get('/api/orders/:id', async (req, res) => {
  const db = await readDB();
  const order = db.orders.find(o => o.id === req.params.id);
  if (order) {
    res.json(order);
  } else {
    res.status(404).json({ error: 'Pedido não encontrado' });
  }
});

// Cache de rastreio (30 minutos)
const trackingCache = new Map();
const CACHE_DURATION = 30 * 60 * 1000; // 30 minutos em milissegundos

// Função auxiliar para buscar rastreio usando CONTRATOS DO USUÁRIO
async function fetchCorreiosTracking(trackingCode, userId) {
  console.log(`🔍 Tentando buscar rastreio: ${trackingCode} (userId: ${userId})`);

  const db = await readDB();

  // Buscar contratos ativos do usuário
  const userContracts = db.correiosContracts
    .filter(c => c.userId === userId && c.isActive)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)); // Mais antigo primeiro

  // Se não há contratos cadastrados, retornar erro
  if (userContracts.length === 0) {
    console.log('⚠️  Nenhum contrato dos Correios cadastrado para este usuário');
    return null;
  }

  console.log(`📦 ${userContracts.length} contrato(s) encontrado(s) para o usuário`);

  // Tentar cada contrato em ordem
  for (let i = 0; i < userContracts.length; i++) {
    const contract = userContracts[i];

    try {
      console.log(`   → Tentativa ${i + 1}: Contrato "${contract.name}"...`);

      // Descriptografar o token
      const decryptedToken = decryptToken(contract.accessToken);

      const response = await axios.post(
        'https://webservice.correios.com.br/service/rest/rastro/rastroMobile',
        `usuario=${contract.username}&senha=${decryptedToken}&tipo=L&resultado=T&objetos=${trackingCode}`,
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Dart/2.19 (dart:io)',
            'Accept': 'application/xml'
          },
          timeout: 10000
        }
      );

      if (response.data && response.data.includes('<objeto>')) {
        console.log(`   ✅ Sucesso com contrato: ${contract.name}`);

        // Atualizar status do último teste
        const contractIndex = db.correiosContracts.findIndex(c => c.id === contract.id);
        db.correiosContracts[contractIndex].lastTestedAt = new Date().toISOString();
        db.correiosContracts[contractIndex].lastTestStatus = 'success';

        const trackingData = parseCorreiosXML(response.data, trackingCode);
        db.correiosContracts[contractIndex].lastTestMessage = `${trackingData.quantidade} eventos encontrados`;
        writeDB(db);

        return trackingData;
      }
    } catch (error) {
      console.log(`   ❌ Falha no contrato "${contract.name}": ${error.message}`);

      // Atualizar status do último teste
      const contractIndex = db.correiosContracts.findIndex(c => c.id === contract.id);
      db.correiosContracts[contractIndex].lastTestedAt = new Date().toISOString();
      db.correiosContracts[contractIndex].lastTestStatus = 'failed';
      db.correiosContracts[contractIndex].lastTestMessage = error.message;
      writeDB(db);
    }
  }

  // Se todos os contratos falharam, retornar null (sem dados demo)
  console.log('❌ Todos os contratos falharam. Sem rastreio disponível.');
  return null;
}

// Função para fazer parsing do XML dos Correios
function parseCorreiosXML(xmlData, trackingCode) {
  const $ = cheerio.load(xmlData, { xmlMode: true });
  const eventos = [];

  $('evento').each((i, element) => {
    const $evt = $(element);
    const tipo = $evt.find('tipo').text().trim();
    const status = $evt.find('status').text().trim();
    const data = $evt.find('data').text().trim();
    const hora = $evt.find('hora').text().trim();
    const local = $evt.find('local').text().trim();
    const cidade = $evt.find('cidade').text().trim();
    const uf = $evt.find('uf').text().trim();
    const descricao = $evt.find('descricao').text().trim();

    eventos.push({
      data: `${data} ${hora}`,
      local: cidade && uf ? `${cidade}/${uf}` : local,
      status: tipo || status,
      subStatus: descricao ? [descricao] : []
    });
  });

  return {
    codigo: trackingCode,
    eventos: eventos,
    quantidade: eventos.length
  };
}

// ============================================
// SISTEMA DE CRIPTOGRAFIA PARA CONTRATOS CORREIOS
// ============================================

const ENCRYPTION_KEY = process.env.CORREIOS_SECRET_KEY || 'afterpay-correios-secret-key-2024-default'; // Deve ter 32 caracteres
const ALGORITHM = 'aes-256-cbc';

// Ajustar chave para ter exatamente 32 bytes
function getEncryptionKey() {
  const key = Buffer.from(ENCRYPTION_KEY);
  return crypto.createHash('sha256').update(key).digest();
}

// Criptografar token de acesso
function encryptToken(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, getEncryptionKey(), iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

// Descriptografar token de acesso
function decryptToken(encryptedText) {
  const parts = encryptedText.split(':');
  const iv = Buffer.from(parts[0], 'hex');
  const encrypted = parts[1];
  const decipher = crypto.createDecipheriv(ALGORITHM, getEncryptionKey(), iv);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// ============================================
// ENDPOINTS - GESTÃO DE CONTRATOS CORREIOS
// ============================================

// 1. Listar contratos do usuário
app.get('/api/correios-contracts', async (req, res) => {
  try {
    const { userId } = req.query;

    if (!userId) {
      return res.status(400).json({ error: 'userId é obrigatório' });
    }

    const db = await readDB();
    const contracts = db.correiosContracts.filter(c => c.userId === userId);

    // Remover access_token da resposta por segurança
    const safeContracts = contracts.map(({ accessToken, ...contract }) => contract);

    res.json(safeContracts);
  } catch (error) {
    console.error('Erro ao listar contratos:', error);
    res.status(500).json({ error: 'Erro ao listar contratos' });
  }
});

// 2. Criar novo contrato
app.post('/api/correios-contracts', async (req, res) => {
  try {
    const { userId, name, username, accessToken, contractNumber, isActive } = req.body;

    // Validações
    if (!userId || !name || !username || !accessToken || !contractNumber) {
      return res.status(400).json({
        error: 'Campos obrigatórios: userId, name, username, accessToken, contractNumber'
      });
    }

    const db = await readDB();

    // Criptografar o token de acesso
    const encryptedToken = encryptToken(accessToken);

    // Criar novo contrato
    const newContract = {
      id: uuidv4(),
      userId: userId,
      name: name,
      username: username,
      accessToken: encryptedToken,
      contractNumber: contractNumber,
      isActive: isActive !== undefined ? isActive : true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastTestedAt: null,
      lastTestStatus: null,
      lastTestMessage: null
    };

    db.correiosContracts.push(newContract);
    writeDB(db);

    // Retornar sem o token
    const { accessToken: _, ...safeContract } = newContract;

    res.json({
      success: true,
      message: 'Contrato criado com sucesso!',
      contract: safeContract
    });
  } catch (error) {
    console.error('Erro ao criar contrato:', error);
    res.status(500).json({ error: 'Erro ao criar contrato' });
  }
});

// 3. Editar contrato
app.put('/api/correios-contracts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, username, accessToken, contractNumber, isActive } = req.body;

    const db = await readDB();
    const contractIndex = db.correiosContracts.findIndex(c => c.id === id);

    if (contractIndex === -1) {
      return res.status(404).json({ error: 'Contrato não encontrado' });
    }

    // Atualizar campos
    if (name) db.correiosContracts[contractIndex].name = name;
    if (username) db.correiosContracts[contractIndex].username = username;
    if (contractNumber) db.correiosContracts[contractIndex].contractNumber = contractNumber;
    if (isActive !== undefined) db.correiosContracts[contractIndex].isActive = isActive;

    // Se enviou novo token, criptografar e atualizar
    if (accessToken) {
      db.correiosContracts[contractIndex].accessToken = encryptToken(accessToken);
    }

    db.correiosContracts[contractIndex].updatedAt = new Date().toISOString();

    writeDB(db);

    // Retornar sem o token
    const { accessToken: _, ...safeContract } = db.correiosContracts[contractIndex];

    res.json({
      success: true,
      message: 'Contrato atualizado com sucesso!',
      contract: safeContract
    });
  } catch (error) {
    console.error('Erro ao editar contrato:', error);
    res.status(500).json({ error: 'Erro ao editar contrato' });
  }
});

// 4. Deletar contrato
app.delete('/api/correios-contracts/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const db = await readDB();
    const initialLength = db.correiosContracts.length;
    db.correiosContracts = db.correiosContracts.filter(c => c.id !== id);

    if (db.correiosContracts.length === initialLength) {
      return res.status(404).json({ error: 'Contrato não encontrado' });
    }

    writeDB(db);

    res.json({
      success: true,
      message: 'Contrato deletado com sucesso!'
    });
  } catch (error) {
    console.error('Erro ao deletar contrato:', error);
    res.status(500).json({ error: 'Erro ao deletar contrato' });
  }
});

// 5. Testar contrato
app.post('/api/correios-contracts/:id/test', async (req, res) => {
  try {
    const { id } = req.params;
    const { trackingCode } = req.body;

    if (!trackingCode) {
      return res.status(400).json({ error: 'Código de rastreio é obrigatório' });
    }

    const db = await readDB();
    const contract = db.correiosContracts.find(c => c.id === id);

    if (!contract) {
      return res.status(404).json({ error: 'Contrato não encontrado' });
    }

    // Descriptografar o token
    const decryptedToken = decryptToken(contract.accessToken);

    console.log(`🔄 Testando contrato: ${contract.name}`);

    // Tentar buscar rastreio com este contrato
    try {
      const response = await axios.post(
        'https://webservice.correios.com.br/service/rest/rastro/rastroMobile',
        `usuario=${contract.username}&senha=${decryptedToken}&tipo=L&resultado=T&objetos=${trackingCode}`,
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Dart/2.19 (dart:io)',
            'Accept': 'application/xml'
          },
          timeout: 10000
        }
      );

      if (response.data && response.data.includes('<objeto>')) {
        const trackingData = parseCorreiosXML(response.data, trackingCode);

        // Atualizar status do teste
        const contractIndex = db.correiosContracts.findIndex(c => c.id === id);
        db.correiosContracts[contractIndex].lastTestedAt = new Date().toISOString();
        db.correiosContracts[contractIndex].lastTestStatus = 'success';
        db.correiosContracts[contractIndex].lastTestMessage = `${trackingData.quantidade} eventos encontrados`;
        writeDB(db);

        console.log(`✅ Teste bem-sucedido: ${contract.name}`);

        return res.json({
          success: true,
          message: 'Contrato funcionando corretamente!',
          eventsCount: trackingData.quantidade,
          eventos: trackingData.eventos
        });
      } else {
        throw new Error('Resposta XML inválida');
      }
    } catch (error) {
      // Atualizar status do teste como falha
      const contractIndex = db.correiosContracts.findIndex(c => c.id === id);
      db.correiosContracts[contractIndex].lastTestedAt = new Date().toISOString();
      db.correiosContracts[contractIndex].lastTestStatus = 'failed';
      db.correiosContracts[contractIndex].lastTestMessage = error.message;
      writeDB(db);

      console.log(`❌ Teste falhou: ${contract.name} - ${error.message}`);

      return res.status(400).json({
        success: false,
        message: 'Falha ao buscar rastreio',
        error: error.response?.status === 401 ? 'Unauthorized (401)' : error.message,
        suggestions: [
          'Verifique se as credenciais estão corretas',
          'Confirme se o código pertence a este contrato',
          'Verifique se o contrato está ativo nos Correios'
        ]
      });
    }
  } catch (error) {
    console.error('Erro ao testar contrato:', error);
    res.status(500).json({ error: 'Erro ao testar contrato' });
  }
});

// ============================================
// ENDPOINT - RASTREIO DOS CORREIOS (ATUALIZADO)
// ============================================

// Endpoint para buscar rastreio dos Correios
app.get('/api/orders/:orderId/correios-tracking', async (req, res) => {
  try {
    const db = await readDB();
    const order = db.orders.find(o => o.id === req.params.orderId);

    if (!order) {
      return res.status(404).json({ error: 'Pedido não encontrado' });
    }

    if (!order.trackingCode) {
      return res.status(400).json({ error: 'Pedido não possui código de rastreio' });
    }

    // Buscar o produto para obter o producerId (userId do vendedor)
    const product = db.products.find(p => p.id === order.productId);
    if (!product) {
      return res.status(404).json({ error: 'Produto não encontrado' });
    }

    const userId = product.producerId; // ID do usuário vendedor (dono do produto)
    const trackingCode = order.trackingCode;

    // Verificar se existe no cache e ainda está válido
    const cached = trackingCache.get(trackingCode);
    if (cached && (Date.now() - cached.timestamp) < CACHE_DURATION) {
      console.log(`📦 Rastreio do cache: ${trackingCode}`);
      return res.json(cached.data);
    }

    console.log(`🔍 Buscando rastreio nos Correios: ${trackingCode}`);

    // Buscar rastreio nos Correios usando contratos do usuário
    const trackingData = await fetchCorreiosTracking(trackingCode, userId);

    if (!trackingData || !trackingData.eventos || trackingData.eventos.length === 0) {
      return res.status(404).json({
        error: 'Rastreio não encontrado',
        message: 'Não foi possível obter informações de rastreio dos Correios. Verifique se você possui contratos dos Correios cadastrados em Configurações > Integrações > Correios.'
      });
    }

    // Formatar resposta
    const formattedEvents = trackingData.eventos.map(evento => {
      return {
        date: evento.data || new Date().toISOString(),
        location: evento.local || '',
        status: evento.status || '',
        description: evento.subStatus?.[0] || evento.status || ''
      };
    });

    // Determinar status geral
    let generalStatus = 'Em processamento';
    const lastEvent = trackingData.eventos[0];
    if (lastEvent && lastEvent.status) {
      const statusLower = lastEvent.status.toLowerCase();
      if (statusLower.includes('entregue')) {
        generalStatus = 'Entregue';
      } else if (statusLower.includes('trânsito') || statusLower.includes('transito')) {
        generalStatus = 'Em trânsito';
      } else if (statusLower.includes('postado')) {
        generalStatus = 'Postado';
      } else if (statusLower.includes('saiu para entrega')) {
        generalStatus = 'Saiu para entrega';
      }
    }

    const response = {
      trackingCode: trackingCode,
      status: generalStatus,
      lastUpdate: formattedEvents[0]?.date || new Date().toISOString(),
      events: formattedEvents
    };

    // Salvar no cache
    trackingCache.set(trackingCode, {
      data: response,
      timestamp: Date.now()
    });

    console.log(`✅ Rastreio obtido com sucesso: ${formattedEvents.length} eventos`);

    res.json(response);

  } catch (error) {
    console.error('❌ Erro ao buscar rastreio dos Correios:', error);
    res.status(500).json({
      error: 'Erro ao buscar rastreio',
      message: error.message || 'Erro interno ao consultar os Correios. Tente novamente mais tarde.'
    });
  }
});

app.patch('/api/orders/:id', async (req, res) => {
  const db = await readDB();
  const orderIndex = db.orders.findIndex(o => o.id === req.params.id);

  if (orderIndex === -1) {
    return res.status(404).json({ error: 'Pedido não encontrado' });
  }

  const {
    status,
    trackingCode,
    paymentStatus,
    shippingInfo,
    carrier,
    estimatedDelivery
  } = req.body;

  // Atualizar informações de envio
  if (trackingCode || carrier || estimatedDelivery) {
    db.orders[orderIndex].shippingInfo = {
      ...db.orders[orderIndex].shippingInfo,
      ...(trackingCode && { trackingCode }),
      ...(carrier && { carrier }),
      ...(estimatedDelivery && { estimatedDelivery }),
      ...(trackingCode && { shippingStatus: 'shipped', shippingDate: new Date().toISOString() })
    };
  }

  db.orders[orderIndex] = {
    ...db.orders[orderIndex],
    ...(status && { status }),
    ...(trackingCode && { trackingCode }),
    ...(paymentStatus && { paymentStatus }),
    ...(shippingInfo && { shippingInfo: { ...db.orders[orderIndex].shippingInfo, ...shippingInfo } }),
    updatedAt: new Date().toISOString(),
    ...(status === 'paid' && { paidAt: new Date().toISOString() })
  };

  // Atualizar status de comissão se pedido foi pago
  if (status === 'paid' || paymentStatus === 'paid') {
    const commissionIndex = db.commissions.findIndex(c => c.orderId === req.params.id);
    if (commissionIndex !== -1) {
      db.commissions[commissionIndex].status = 'paid';
      db.commissions[commissionIndex].paidAt = new Date().toISOString();
    }
  }

  writeDB(db);

  // Disparar webhooks baseados nas mudanças
  const pedidoAtualizado = db.orders[orderIndex];

  // Pagamento aprovado
  if (paymentStatus === 'paid') {
    dispararWebhookPortugues(pedidoAtualizado.producerId, 'pagamentoAprovado', pedidoAtualizado);

    // Enviar automaticamente para Notazz se configurado
    const notazzConfig = db.notazzConfigs?.find(c => c.userId === pedidoAtualizado.producerId);
    if (notazzConfig && notazzConfig.enabled && notazzConfig.autoSend) {
      console.log(`🚀 Enviando pedido ${pedidoAtualizado.id} (PAGO) automaticamente para Notazz...`);
      enviarPedidoNotazz(pedidoAtualizado.id, pedidoAtualizado.producerId);
    }
  }

  // Pedido agendado (AfterPay)
  if (paymentStatus === 'scheduled') {
    dispararWebhookPortugues(pedidoAtualizado.producerId, 'agendado', pedidoAtualizado);

    // Enviar automaticamente para Notazz se configurado
    const notazzConfig = db.notazzConfigs?.find(c => c.userId === pedidoAtualizado.producerId);
    if (notazzConfig && notazzConfig.enabled && notazzConfig.autoSend) {
      console.log(`🚀 Enviando pedido ${pedidoAtualizado.id} (AGENDADO) automaticamente para Notazz...`);
      enviarPedidoNotazz(pedidoAtualizado.id, pedidoAtualizado.producerId);
    }
  }

  // Código de rastreio adicionado
  if (trackingCode) {
    dispararWebhookPortugues(pedidoAtualizado.producerId, 'codigoRastreio', pedidoAtualizado);
  }

  // Status de entrega
  if (shippingInfo?.shippingStatus === 'shipped' || trackingCode) {
    dispararWebhookPortugues(pedidoAtualizado.producerId, 'saiuParaEntrega', pedidoAtualizado);
  }

  // Pedido cancelado
  if (paymentStatus === 'cancelled') {
    dispararWebhookPortugues(pedidoAtualizado.producerId, 'cancelada', pedidoAtualizado);
  }

  res.json(db.orders[orderIndex]);
});

// ============ ROTAS DE WEBHOOKS ============

// Listar webhooks do usuário
app.get('/api/webhooks', async (req, res) => {
  const db = await readDB();
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({ error: 'userId é obrigatório' });
  }

  const webhooks = db.webhooks?.filter(w => w.userId === userId) || [];
  res.json(webhooks);
});

// Criar novo webhook
app.post('/api/webhooks', async (req, res) => {
  const db = await readDB();
  const { userId, name, url, product, events } = req.body;

  if (!userId || !name || !url) {
    return res.status(400).json({ error: 'userId, name e url são obrigatórios' });
  }

  if (!db.webhooks) {
    db.webhooks = [];
  }

  const novoWebhook = {
    id: uuidv4(),
    userId,
    code: `cowxj${Math.random().toString(36).substring(2, 5)}`,
    name,
    url,
    product: product || '',
    status: true,
    events: events || {
      aguardandoPagamento: true,
      pagamentoAprovado: false,
      cancelada: false,
      agendado: false,
      frustrada: false,
      codigoRastreio: false,
      pedidoEntregue: false,
      saiuParaEntrega: false,
      aguardandoRetirada: false
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  db.webhooks.push(novoWebhook);
  writeDB(db);

  console.log(`✅ Webhook criado: ${name} (${novoWebhook.id})`);
  res.json({ success: true, webhook: novoWebhook });
});

// Atualizar webhook
app.put('/api/webhooks/:id', async (req, res) => {
  const db = await readDB();
  const { id } = req.params;
  const { name, url, product, status, events } = req.body;

  if (!db.webhooks) {
    return res.status(404).json({ error: 'Nenhum webhook encontrado' });
  }

  const webhookIndex = db.webhooks.findIndex(w => w.id === id);

  if (webhookIndex === -1) {
    return res.status(404).json({ error: 'Webhook não encontrado' });
  }

  // Atualizar campos
  if (name !== undefined) db.webhooks[webhookIndex].name = name;
  if (url !== undefined) db.webhooks[webhookIndex].url = url;
  if (product !== undefined) db.webhooks[webhookIndex].product = product;
  if (status !== undefined) db.webhooks[webhookIndex].status = status;
  if (events !== undefined) db.webhooks[webhookIndex].events = events;
  db.webhooks[webhookIndex].updatedAt = new Date().toISOString();

  writeDB(db);

  console.log(`✅ Webhook atualizado: ${db.webhooks[webhookIndex].name}`);
  res.json({ success: true, webhook: db.webhooks[webhookIndex] });
});

// Deletar webhook
app.delete('/api/webhooks/:id', async (req, res) => {
  const db = await readDB();
  const { id } = req.params;

  if (!db.webhooks) {
    return res.status(404).json({ error: 'Nenhum webhook encontrado' });
  }

  const webhookIndex = db.webhooks.findIndex(w => w.id === id);

  if (webhookIndex === -1) {
    return res.status(404).json({ error: 'Webhook não encontrado' });
  }

  const deletedWebhook = db.webhooks[webhookIndex];
  db.webhooks.splice(webhookIndex, 1);
  writeDB(db);

  console.log(`🗑️ Webhook deletado: ${deletedWebhook.name}`);
  res.json({ success: true, message: 'Webhook deletado com sucesso' });
});

// Testar webhook (enviar manualmente)
app.post('/api/webhooks/:id/test', async (req, res) => {
  const db = await readDB();
  const { id } = req.params;

  if (!db.webhooks) {
    return res.status(404).json({ error: 'Nenhum webhook encontrado' });
  }

  const webhook = db.webhooks.find(w => w.id === id);

  if (!webhook) {
    return res.status(404).json({ error: 'Webhook não encontrado' });
  }

  // Criar payload de teste
  const payloadTeste = {
    evento: 'teste',
    data_hora: new Date().toISOString(),
    mensagem: 'Este é um webhook de teste enviado manualmente',
    webhook: {
      id: webhook.id,
      nome: webhook.name,
      codigo: webhook.code
    }
  };

  console.log(`🧪 Teste de webhook: ${webhook.name}`);
  console.log(`📤 Enviando para: ${webhook.url}`);
  console.log(`📦 Payload:`, JSON.stringify(payloadTeste, null, 2));

  // Salvar log do teste
  if (!db.webhookLogs) {
    db.webhookLogs = [];
  }

  db.webhookLogs.push({
    id: uuidv4(),
    webhookId: webhook.id,
    webhookName: webhook.name,
    url: webhook.url,
    evento: 'teste',
    payload: payloadTeste,
    sucesso: true,
    dataHora: new Date().toISOString(),
    resposta: 'Webhook de teste enviado com sucesso (simulado)'
  });

  writeDB(db);

  res.json({
    success: true,
    message: 'Webhook de teste enviado com sucesso',
    payload: payloadTeste
  });
});

// Obter logs de webhooks
app.get('/api/webhooks/:id/logs', async (req, res) => {
  const db = await readDB();
  const { id } = req.params;
  const { limit = 50 } = req.query;

  const logs = db.webhookLogs?.filter(log => log.webhookId === id) || [];

  // Ordenar por data (mais recentes primeiro) e limitar
  const logsOrdenados = logs
    .sort((a, b) => new Date(b.dataHora) - new Date(a.dataHora))
    .slice(0, parseInt(limit));

  res.json(logsOrdenados);
});

// ============ ROTAS DE INTEGRAÇÃO NOTAZZ ============

// Buscar configuração Notazz do usuário
app.get('/api/integrations/notazz', async (req, res) => {
  const db = await readDB();
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({ error: 'userId é obrigatório' });
  }

  const config = db.notazzConfigs?.find(c => c.userId === userId);

  if (config) {
    res.json({
      webhookId: config.webhookId || '',
      enabled: config.enabled,
      autoSend: config.autoSend
    });
  } else {
    res.json({
      webhookId: '',
      enabled: false,
      autoSend: false
    });
  }
});

// ========== ENDPOINT DE DIAGNÓSTICO NOTAZZ ==========
app.get('/api/integrations/notazz/logs', async (req, res) => {
  const db = await readDB();
  const { userId, orderId, limit = 20 } = req.query;

  let logs = db.notazzLogs || [];

  // Filtrar por userId se fornecido
  if (userId) {
    logs = logs.filter(log => log.userId === userId);
  }

  // Filtrar por orderId se fornecido
  if (orderId) {
    logs = logs.filter(log => log.orderId === orderId);
  }

  // Ordenar por data (mais recente primeiro)
  logs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  // Limitar quantidade
  logs = logs.slice(0, parseInt(limit));

  res.json({
    total: logs.length,
    logs: logs.map(log => ({
      ...log,
      timestamp: log.timestamp,
      success: log.success,
      statusCode: log.statusCode,
      orderId: log.orderId,
      responsePreview: JSON.stringify(log.response).substring(0, 200)
    }))
  });
});

// ========== DIAGNÓSTICO: Últimos pedidos criados ==========
app.get('/api/debug/recent-orders', async (req, res) => {
  const db = await readDB();
  const limit = parseInt(req.query.limit) || 5;

  const recentOrders = db.orders
    .slice(-limit)
    .map(order => ({
      id: order.id,
      createdAt: order.createdAt,
      customerName: order.customer?.name,
      customerCPF: order.customer?.cpf,
      customerEmail: order.customer?.email,
      productName: order.productName,
      totalValue: order.totalValue,
      paymentMethod: order.paymentMethod,
      sentToNotazz: order.sentToNotazz || false,
      sentToNotazzAt: order.sentToNotazzAt || null
    }));

  res.json({
    total: db.orders.length,
    recent: recentOrders
  });
});

// ========== SUPER DIAGNÓSTICO: Comparar Banco vs Notazz ==========
app.get('/api/debug/super-diagnostic', async (req, res) => {
  const db = await readDB();
  const limit = parseInt(req.query.limit) || 3;

  // Buscar últimos pedidos
  const lastOrders = db.orders.slice(-limit);

  // Buscar logs correspondentes do Notazz
  const diagnostic = lastOrders.map(order => {
    const notazzLog = db.notazzLogs?.find(log => log.orderId === order.id);

    return {
      pedidoId: order.id,
      criadoEm: order.createdAt,

      // DADOS SALVOS NO BANCO
      dadosBanco: {
        nomeCliente: order.customer?.name,
        cpf: order.customer?.cpf,
        email: order.customer?.email,
        telefone: order.customer?.phone,
        endereco: {
          rua: order.shippingAddress?.address || order.shippingAddress?.street,
          numero: order.shippingAddress?.number,
          bairro: order.shippingAddress?.neighborhood || order.shippingAddress?.district,
          cidade: order.shippingAddress?.city,
          estado: order.shippingAddress?.state,
          cep: order.shippingAddress?.zipCode || order.shippingAddress?.cep
        },
        produto: order.productName,
        valorTotal: order.totalValue,
        metodoPagamento: order.paymentMethod
      },

      // DADOS ENVIADOS AO NOTAZZ
      dadosEnviadosNotazz: notazzLog ? {
        id: notazzLog.payload?.id,
        customer_name: notazzLog.payload?.customer_name,
        customer_email: notazzLog.payload?.customer_email,
        customer_doc: notazzLog.payload?.customer_doc,
        customer_phone: notazzLog.payload?.customer_phone,
        customer_street: notazzLog.payload?.customer_street,
        customer_number: notazzLog.payload?.customer_number,
        customer_city: notazzLog.payload?.customer_city,
        customer_state: notazzLog.payload?.customer_state,
        customer_zipcode: notazzLog.payload?.customer_zipcode,
        product: notazzLog.payload?.product,
        total: notazzLog.payload?.total,
        statusHTTP: notazzLog.statusCode,
        enviadoEm: notazzLog.timestamp
      } : null,

      // ANÁLISE
      foiEnviadoNotazz: !!notazzLog,
      comparacao: notazzLog ? {
        nomeIgual: order.customer?.name === notazzLog.payload?.customer_name,
        valorIgual: parseFloat(order.totalValue) === parseFloat(notazzLog.payload?.total || 0)
      } : null
    };
  });

  res.json({
    totalPedidos: db.orders.length,
    totalLogsNotazz: db.notazzLogs?.length || 0,
    ultimos: diagnostic,
    analiseGeral: {
      todosEnviados: diagnostic.every(d => d.foiEnviadoNotazz),
      algumComDivergencia: diagnostic.some(d =>
        d.comparacao && (!d.comparacao.nomeIgual || !d.comparacao.valorIgual)
      )
    }
  });
});

// ========== CONSULTAR NOTA NO NOTAZZ (por order ID) ==========
app.get('/api/integrations/notazz/check-note/:orderId', async (req, res) => {
  const { orderId } = req.params;
  const { userId } = req.query;

  const db = await readDB();

  // Buscar log do envio
  const log = db.notazzLogs?.find(log => log.orderId === orderId);

  if (!log) {
    return res.json({
      found: false,
      message: 'Nenhum log de envio encontrado para este pedido',
      hint: 'O pedido pode não ter sido enviado ao Notazz ainda'
    });
  }

  res.json({
    found: true,
    orderId: orderId,
    enviado: log.timestamp,
    sucesso: log.success,
    statusHTTP: log.statusCode,
    respostaNotazz: log.response,
    payloadEnviado: log.payload,
    analise: {
      statusHTTP: log.statusCode === 201 || log.statusCode === 200
        ? '✅ Requisição aceita pelo Notazz'
        : '❌ Requisição rejeitada',
      temIdNota: log.response?.id ? `✅ ID da nota: ${log.response.id}` : '⚠️ Resposta não contém ID da nota',
      statusProcessamento: log.response?.statusProcessamento || 'Não informado',
      codigoProcessamento: log.response?.codigoProcessamento || 'Não informado',
      possivelCausa: !log.response?.id
        ? 'Nota pode estar em rascunho ou aguardando aprovação no painel Notazz'
        : 'Nota foi criada. Verifique painel Notazz filtrando por data/CPF'
    }
  });
});

// ========== TESTE DE PAYLOAD MÍNIMO ==========
app.post('/api/integrations/notazz/test-minimal', async (req, res) => {
  const db = await readDB();
  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ error: 'userId é obrigatório' });
  }

  // Buscar configuração do Notazz
  const notazzConfig = db.notazzConfigs?.find(c => c.userId === userId);

  if (!notazzConfig || !notazzConfig.webhookId) {
    return res.status(400).json({ error: 'Configuração Notazz não encontrada' });
  }

  console.log('\n🧪 ========== TESTE DE PAYLOAD MÍNIMO ==========');

  try {
    const timestamp = Date.now();
    const randomSuffix = Math.random().toString(36).substring(2, 8);
    const testId = `TEST-${timestamp}`;
    const uniqueId = `${testId}-${randomSuffix}`;  // ID completamente único

    // ========== PAYLOAD WEBHOOK - SOMENTE CAMPOS DA DOCUMENTAÇÃO ==========
    // Documentação: https://app.notazz.com/docs/webhooks/
    // IMPORTANTE: Enviar campos extras causa erro no Notazz

    const minimalPayload = {
      // ========== CAMPOS OBRIGATÓRIOS ==========
      id: uniqueId,                            // Identificador único da transação
      total: '100.00',                         // Valor total da transação
      status: 'paid',                          // paid, completed, refunded, chargeback
      customer_name: `Cliente Teste ${timestamp}`, // Nome completo do cliente
      product: [{                              // Array de produtos
        id: '1',
        name: 'Produto Teste',
        amount: '1',
        unitary_value: '100.00'
      }],

      // ========== CAMPOS OPCIONAIS (conforme documentação) ==========
      commission: '0.00',                      // Valor da comissão
      date: new Date().toISOString(),          // Data da venda (YYYY-MM-DD HH:MM:SS)
      installments: 1,                         // Número de parcelas
      shipping_name: '',                       // Nome da transportadora
      shipping_method: '',                     // Método de envio
      currency: 'BRL',                         // Moeda (ISO 4217)
      shipping_value: '0.00',                  // Valor do frete
      sale_type: 'producer',                   // producer ou others
      payment_method: 'afterPay',              // Método de pagamento

      // Dados do cliente (opcionais)
      customer_doc: '12345678901',             // CPF/CNPJ
      customer_email: `teste-${timestamp}@email.com`, // Email único
      customer_street: 'Rua Teste',            // Logradouro
      customer_number: '123',                  // Número
      customer_complement: '',                 // Complemento
      customer_district: 'Centro',             // Bairro
      customer_zipcode: '50000000',            // CEP
      customer_city: 'Recife',                 // Cidade
      customer_state: 'PE',                    // Estado (sigla)
      customer_country: 'BR',                  // País (ISO-3166)
      customer_phone: '81987654321',           // Telefone

      // Dados do produtor (opcionais)
      producer_name: 'Pag2 Pay',               // Nome do produtor
      producer_doc: '',                        // CPF/CNPJ do produtor
      producer_email: ''                       // Email do produtor
    };

    const notazzUrl = `https://app.notazz.com/webhook/${notazzConfig.webhookId}`;

    console.log('🌐 URL:', notazzUrl);
    console.log('📦 Payload Mínimo:', JSON.stringify(minimalPayload, null, 2));

    const response = await fetch(notazzUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(minimalPayload)
    });

    console.log('📥 Status HTTP:', response.status);
    console.log('📥 Headers:', Object.fromEntries(response.headers.entries()));

    const text = await response.text();
    console.log('📥 Body (texto bruto):', text);

    let data;
    try {
      data = JSON.parse(text);
      console.log('📥 JSON parseado:', JSON.stringify(data, null, 2));
    } catch {
      console.log('⚠️ Resposta não é JSON');
      data = { raw: text };
    }

    console.log('===========================================\n');

    res.json({
      status: response.status,
      ok: response.ok,
      headers: Object.fromEntries(response.headers.entries()),
      data
    });
  } catch (error) {
    console.error('❌ Erro no teste:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Salvar configuração Notazz
app.post('/api/integrations/notazz', async (req, res) => {
  console.log('\n📝 Recebendo requisição para salvar configuração Notazz...');
  console.log('Body recebido:', req.body);

  const db = await readDB();
  const { userId, webhookId, apiKey, enabled, autoSend } = req.body;

  console.log('Dados extraídos:', { userId, webhookId, apiKey: apiKey ? '***' : 'não fornecida', enabled, autoSend });

  if (!userId) {
    console.log('❌ Erro: userId ausente');
    return res.status(400).json({ error: 'userId é obrigatório' });
  }

  // Aceitar webhookId OU apiKey (pelo menos um)
  if (!webhookId && !apiKey) {
    console.log('❌ Erro: Nem webhookId nem apiKey fornecidos');
    return res.status(400).json({ error: 'webhookId ou apiKey é obrigatório' });
  }

  if (!db.notazzConfigs) {
    console.log('⚠️ Array notazzConfigs não existe, criando...');
    db.notazzConfigs = [];
  }

  const existingIndex = db.notazzConfigs.findIndex(c => c.userId === userId);
  console.log(`Configuração existente? ${existingIndex !== -1 ? `Sim (índice ${existingIndex})` : 'Não'}`);

  const config = {
    userId,
    webhookId: webhookId || '',
    apiKey: apiKey || '',
    enabled: enabled || false,
    autoSend: autoSend || false,
    updatedAt: new Date().toISOString()
  };

  console.log('Configuração a ser salva:', { ...config, apiKey: config.apiKey ? '***OCULTA***' : '' });

  if (existingIndex !== -1) {
    db.notazzConfigs[existingIndex] = config;
  } else {
    db.notazzConfigs.push(config);
  }

  writeDB(db);

  console.log(`✅ Configuração Notazz ${existingIndex !== -1 ? 'atualizada' : 'criada'} para usuário ${userId}`);
  console.log(`📊 Total de configurações Notazz no banco: ${db.notazzConfigs.length}`);

  res.json({ success: true, config });
});

// ========== ENDPOINTS PAGAR.ME ==========

// Buscar configuração Pagar.me do usuário
app.get('/api/integrations/pagarme', async (req, res) => {
  const db = await readDB();
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({ error: 'userId é obrigatório' });
  }

  const config = db.pagarmeConfigs?.find(c => c.userId === userId);

  if (config) {
    res.json({
      publicKey: config.publicKey || '',
      privateKey: config.privateKey || '',
      webhookUrl: config.webhookUrl || '',
      splitReceiverId: config.splitReceiverId || '',
      splitRate: config.splitRate || '3.67',
      splitAnticipationRate: config.splitAnticipationRate || '',
      credentialsLocked: config.credentialsLocked || false,
      splitLocked: config.splitLocked || false,
      enabled: config.enabled || false
    });
  } else {
    res.json({
      publicKey: '',
      privateKey: '',
      webhookUrl: '',
      splitReceiverId: '',
      splitRate: '3.67',
      splitAnticipationRate: '',
      credentialsLocked: false,
      splitLocked: false,
      enabled: false
    });
  }
});

// Salvar configuração Pagar.me
app.post('/api/integrations/pagarme', async (req, res) => {
  console.log('\n📝 Recebendo requisição para salvar configuração Pagar.me...');
  console.log('Body recebido:', { ...req.body, publicKey: req.body.publicKey ? '***' : '', privateKey: req.body.privateKey ? '***' : '' });

  const db = await readDB();
  const {
    userId,
    publicKey,
    privateKey,
    webhookUrl,
    splitReceiverId,
    splitRate,
    splitAnticipationRate,
    credentialsLocked,
    splitLocked,
    enabled
  } = req.body;

  if (!userId) {
    console.log('❌ Erro: userId ausente');
    return res.status(400).json({ error: 'userId é obrigatório' });
  }

  if (!db.pagarmeConfigs) {
    console.log('⚠️ Array pagarmeConfigs não existe, criando...');
    db.pagarmeConfigs = [];
  }

  const existingIndex = db.pagarmeConfigs.findIndex(c => c.userId === userId);
  console.log(`Configuração existente? ${existingIndex !== -1 ? `Sim (índice ${existingIndex})` : 'Não'}`);

  const config = {
    userId,
    publicKey: publicKey || '',
    privateKey: privateKey || '',
    webhookUrl: webhookUrl || `https://app.pag2pay.com/api/v1/gateway/webhook/pagar_me/${userId}`,
    splitReceiverId: splitReceiverId || '',
    splitRate: splitRate || '3.67',
    splitAnticipationRate: splitAnticipationRate || '',
    credentialsLocked: credentialsLocked || false,
    splitLocked: splitLocked || false,
    enabled: enabled || false,
    updatedAt: new Date().toISOString()
  };

  console.log('Configuração a ser salva:', {
    ...config,
    publicKey: config.publicKey ? `${config.publicKey.substring(0, 10)}...` : '',
    privateKey: config.privateKey ? '***OCULTA***' : ''
  });

  if (existingIndex !== -1) {
    db.pagarmeConfigs[existingIndex] = config;
  } else {
    db.pagarmeConfigs.push(config);
  }

  writeDB(db);

  console.log(`✅ Configuração Pagar.me ${existingIndex !== -1 ? 'atualizada' : 'criada'} para usuário ${userId}`);
  console.log(`📊 Total de configurações Pagar.me no banco: ${db.pagarmeConfigs.length}`);

  res.json({ success: true, config: {
    ...config,
    privateKey: config.privateKey ? '***' : '' // Não retornar chave privada completa
  }});
});

// Deletar configuração Pagar.me
app.delete('/api/integrations/pagarme', async (req, res) => {
  const db = await readDB();
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({ error: 'userId é obrigatório' });
  }

  if (!db.pagarmeConfigs) {
    return res.status(404).json({ error: 'Nenhuma configuração encontrada' });
  }

  const existingIndex = db.pagarmeConfigs.findIndex(c => c.userId === userId);

  if (existingIndex === -1) {
    return res.status(404).json({ error: 'Configuração não encontrada' });
  }

  db.pagarmeConfigs.splice(existingIndex, 1);
  writeDB(db);

  console.log(`🗑️ Configuração Pagar.me deletada para usuário ${userId}`);
  res.json({ success: true, message: 'Configuração deletada com sucesso' });
});

// Criar recebedor (conta split) na Pagar.me para um usuário
app.post('/api/integrations/pagarme/create-recipient', async (req, res) => {
  console.log('\n📝 Criando recebedor na Pagar.me...');

  const db = await readDB();
  const { userId, userData } = req.body;

  if (!userId || !userData) {
    return res.status(400).json({ error: 'userId e userData são obrigatórios' });
  }

  try {
    // Buscar configuração Pagar.me da plataforma
    const platformConfig = db.pagarmeConfigs?.find(c => c.userId === 'platform-admin');

    if (!platformConfig || !platformConfig.privateKey) {
      return res.status(400).json({ error: 'Configuração Pagar.me não encontrada. Configure primeiro em Adquirentes > Pagar.me' });
    }

    // Validar dados do usuário
    if (!userData.name || !userData.email || !userData.document) {
      return res.status(400).json({ error: 'Nome, email e documento são obrigatórios' });
    }

    // Criar recebedor na API Pagar.me
    const recipientData = {
      name: userData.name,
      email: userData.email,
      document: userData.document.replace(/\D/g, ''), // Remove formatação
      type: userData.document.length === 14 ? 'individual' : 'company',
      default_bank_account: {
        holder_name: userData.bankAccount?.holderName || userData.name,
        holder_type: userData.document.length === 14 ? 'individual' : 'company',
        holder_document: userData.document.replace(/\D/g, ''),
        bank: userData.bankAccount?.bank || '',
        branch_number: userData.bankAccount?.branch || '',
        branch_check_digit: userData.bankAccount?.branchDigit || '0',
        account_number: userData.bankAccount?.account || '',
        account_check_digit: userData.bankAccount?.accountDigit || '',
        type: userData.bankAccount?.type || 'checking'
      },
      transfer_settings: {
        transfer_enabled: true,
        transfer_interval: 'daily',
        transfer_day: 0
      },
      automatic_anticipation_settings: {
        enabled: false
      }
    };

    console.log('Dados do recebedor:', {
      ...recipientData,
      default_bank_account: { ...recipientData.default_bank_account, account_number: '***' }
    });

    const response = await fetch('https://api.pagar.me/core/v5/recipients', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${platformConfig.privateKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(recipientData)
    });

    const result = await response.json();

    if (!response.ok) {
      console.error('❌ Erro ao criar recebedor:', result);
      return res.status(response.status).json({
        error: 'Erro ao criar recebedor na Pagar.me',
        details: result
      });
    }

    console.log('✅ Recebedor criado com sucesso:', result.id);

    // Atualizar usuário no banco de dados
    const userIndex = db.users?.findIndex(u => u.id === userId);
    if (userIndex !== -1) {
      db.users[userIndex].splitAccountId = result.id;
      db.users[userIndex].splitStatus = 'active';
      db.users[userIndex].splitCreatedAt = new Date().toISOString();
      writeDB(db);
    }

    res.json({
      success: true,
      recipientId: result.id,
      recipient: result
    });

  } catch (error) {
    console.error('❌ Erro ao criar recebedor:', error);
    res.status(500).json({
      error: 'Erro ao criar recebedor',
      message: error.message
    });
  }
});

// Criar transação com split na Pagar.me
app.post('/api/integrations/pagarme/create-order-with-split', async (req, res) => {
  console.log('\n💳 Criando pedido com split na Pagar.me...');

  const db = await readDB();
  const { orderId, paymentMethod } = req.body;

  if (!orderId) {
    return res.status(400).json({ error: 'orderId é obrigatório' });
  }

  try {
    // Buscar pedido
    const order = db.orders?.find(o => o.id === orderId);
    if (!order) {
      return res.status(404).json({ error: 'Pedido não encontrado' });
    }

    // Buscar configuração Pagar.me
    const pagarmeConfig = db.pagarmeConfigs?.find(c => c.userId === order.userId || c.userId === 'platform-admin');

    if (!pagarmeConfig || !pagarmeConfig.privateKey) {
      return res.status(400).json({ error: 'Configuração Pagar.me não encontrada' });
    }

    // Buscar usuário (produtor) para pegar ID do recebedor
    const user = db.users?.find(u => u.id === order.userId);
    if (!user || !user.splitAccountId) {
      return res.status(400).json({ error: 'Usuário não possui conta split criada' });
    }

    // ✅ Buscar prefixo da fatura configurado
    const invoicePrefix = db.platformSettings?.financial?.invoicePrefix || 'PAG2PAY';
    console.log(`📋 Prefixo da fatura: ${invoicePrefix}`);

    // Preparar dados do pedido
    const amountInCents = Math.round(order.totalValue * 100);

    const orderData = {
      customer: {
        name: order.customer?.name || 'Cliente',
        email: order.customer?.email || 'cliente@example.com',
        document: order.customer?.cpf?.replace(/\D/g, '') || '',
        type: 'individual',
        phones: {
          mobile_phone: {
            country_code: '55',
            area_code: order.customer?.phone?.substring(0, 2) || '11',
            number: order.customer?.phone?.substring(2) || '999999999'
          }
        }
      },
      items: [{
        amount: amountInCents,
        description: order.productName || 'Produto',
        quantity: 1,
        code: order.productId || 'PROD001'
      }],
      payments: [{
        payment_method: paymentMethod || 'pix',
        pix: paymentMethod === 'pix' ? {
          expires_in: 3600
        } : undefined,
        credit_card: paymentMethod === 'credit_card' ? {
          // Configurações de cartão de crédito
          installments: 1,
          statement_descriptor: invoicePrefix // ✅ Usa prefixo configurado
        } : undefined,
        boleto: paymentMethod === 'boleto' ? {
          due_at: new Date(Date.now() + (order.boletoDueDays || 5) * 24 * 60 * 60 * 1000).toISOString(), // Usa valor configurado no produto
          instructions: 'Pagar até o vencimento'
        } : undefined
      }],
      // SPLIT RULES - Divisão entre plataforma e produtor
      split: [{
        recipient_id: pagarmeConfig.splitReceiverId, // Recebedor master (plataforma)
        amount: Math.round(amountInCents * 0.10), // 10% para plataforma
        type: 'flat',
        options: {
          charge_processing_fee: true,
          charge_remainder_fee: false,
          liable: true
        }
      }, {
        recipient_id: user.splitAccountId, // Recebedor do produtor
        amount: Math.round(amountInCents * 0.90), // 90% para produtor
        type: 'flat',
        options: {
          charge_processing_fee: false,
          charge_remainder_fee: true,
          liable: false
        }
      }]
    };

    console.log('Criando pedido na Pagar.me com split:', {
      orderId,
      amount: amountInCents,
      splits: orderData.split.map(s => ({ ...s, recipient_id: s.recipient_id.substring(0, 10) + '...' }))
    });

    const response = await fetch('https://api.pagar.me/core/v5/orders', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${platformConfig.privateKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(orderData)
    });

    const result = await response.json();

    if (!response.ok) {
      console.error('❌ Erro ao criar pedido:', result);
      return res.status(response.status).json({
        error: 'Erro ao criar pedido na Pagar.me',
        details: result
      });
    }

    console.log('✅ Pedido criado com sucesso:', result.id);

    // Atualizar pedido no banco
    const orderIndex = db.orders?.findIndex(o => o.id === orderId);
    if (orderIndex !== -1) {
      db.orders[orderIndex].pagarmeOrderId = result.id;
      db.orders[orderIndex].pagarmeStatus = result.status;
      db.orders[orderIndex].paymentInfo = {
        qrCode: result.charges?.[0]?.last_transaction?.qr_code,
        qrCodeUrl: result.charges?.[0]?.last_transaction?.qr_code_url,
        boletoUrl: result.charges?.[0]?.last_transaction?.url,
        barcode: result.charges?.[0]?.last_transaction?.line
      };
      writeDB(db);
    }

    res.json({
      success: true,
      pagarmeOrderId: result.id,
      order: result,
      paymentInfo: {
        qrCode: result.charges?.[0]?.last_transaction?.qr_code,
        qrCodeUrl: result.charges?.[0]?.last_transaction?.qr_code_url,
        boletoUrl: result.charges?.[0]?.last_transaction?.url,
        barcode: result.charges?.[0]?.last_transaction?.line
      }
    });

  } catch (error) {
    console.error('❌ Erro ao criar pedido:', error);
    res.status(500).json({
      error: 'Erro ao criar pedido com split',
      message: error.message
    });
  }
});

// ========== ENDPOINT PARA BUSCAR RECEBÍVEIS (PAYABLES) DO PAGAR.ME ==========

// Buscar recebíveis com datas de liberação do Pagar.me
app.get('/api/integrations/pagarme/payables', async (req, res) => {
  console.log('\n📊 Buscando recebíveis do Pagar.me...');

  const db = await readDB();
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({ error: 'userId é obrigatório' });
  }

  try {
    // Buscar configuração Pagar.me do usuário
    const pagarmeConfig = db.pagarmeConfigs?.find(c => c.userId === userId);

    if (!pagarmeConfig || !pagarmeConfig.privateKey) {
      return res.status(400).json({
        error: 'Configuração Pagar.me não encontrada',
        message: 'Configure suas credenciais do Pagar.me em Configurações > Integrações'
      });
    }

    // Buscar pedidos do usuário que têm ID do Pagar.me
    const userOrders = db.orders?.filter(o =>
      o.producerId === userId &&
      o.pagarmeOrderId &&
      o.paymentStatus === 'paid'
    ) || [];

    console.log(`📦 Encontrados ${userOrders.length} pedidos pagos com ID do Pagar.me`);

    if (userOrders.length === 0) {
      return res.json({
        success: true,
        payables: [],
        message: 'Nenhum pedido pago encontrado com transação no Pagar.me'
      });
    }

    // Buscar recebíveis de cada pedido
    const payablesPromises = userOrders.map(async (order) => {
      try {
        const payables = await pagarmeService.getPayables(order.pagarmeOrderId, pagarmeConfig.privateKey);

        return {
          orderId: order.id,
          pagarmeOrderId: order.pagarmeOrderId,
          productName: order.productName,
          customer: order.customer?.name,
          totalValue: order.totalValue,
          paidAt: order.paidAt,
          payables: payables
        };
      } catch (error) {
        console.error(`❌ Erro ao buscar recebíveis do pedido ${order.id}:`, error.message);
        return null;
      }
    });

    const results = await Promise.all(payablesPromises);
    const validResults = results.filter(r => r !== null);

    console.log(`✅ Recebíveis obtidos de ${validResults.length} pedidos`);

    res.json({
      success: true,
      payables: validResults,
      total: validResults.length
    });

  } catch (error) {
    console.error('❌ Erro ao buscar recebíveis:', error);
    res.status(500).json({
      error: 'Erro ao buscar recebíveis',
      message: error.message
    });
  }
});

// Atualizar data de liberação de um pedido específico
app.post('/api/orders/:id/sync-release-date', async (req, res) => {
  console.log('\n🔄 Sincronizando data de liberação do Pagar.me...');

  const db = await readDB();
  const { id } = req.params;

  try {
    const orderIndex = db.orders.findIndex(o => o.id === id);

    if (orderIndex === -1) {
      return res.status(404).json({ error: 'Pedido não encontrado' });
    }

    const order = db.orders[orderIndex];

    if (!order.pagarmeOrderId) {
      return res.status(400).json({
        error: 'Pedido não possui ID do Pagar.me',
        message: 'Este pedido não foi processado pelo Pagar.me'
      });
    }

    // Buscar configuração Pagar.me
    const pagarmeConfig = db.pagarmeConfigs?.find(c => c.userId === order.producerId);

    if (!pagarmeConfig || !pagarmeConfig.privateKey) {
      return res.status(400).json({ error: 'Configuração Pagar.me não encontrada' });
    }

    // Buscar data de liberação do Pagar.me
    const releaseDate = await pagarmeService.getReleaseDate(order.pagarmeOrderId, pagarmeConfig.privateKey);

    if (releaseDate) {
      // Atualizar pedido com a data real do gateway
      db.orders[orderIndex].releaseDate = releaseDate;
      db.orders[orderIndex].releaseDateSource = 'pagarme_api';
      db.orders[orderIndex].releaseDateSyncedAt = new Date().toISOString();
      db.orders[orderIndex].updatedAt = new Date().toISOString();

      writeDB(db);

      console.log(`✅ Data de liberação atualizada: ${releaseDate}`);

      res.json({
        success: true,
        releaseDate: releaseDate,
        message: 'Data de liberação sincronizada com sucesso'
      });
    } else {
      res.status(404).json({
        error: 'Data de liberação não encontrada',
        message: 'Não foi possível obter a data de liberação do Pagar.me'
      });
    }

  } catch (error) {
    console.error('❌ Erro ao sincronizar data de liberação:', error);
    res.status(500).json({
      error: 'Erro ao sincronizar data de liberação',
      message: error.message
    });
  }
});

// ========== FIM ENDPOINTS PAGAR.ME ==========

// Enviar pedido para o Notazz (gerar nota)
app.post('/api/integrations/notazz/send-order', async (req, res) => {
  const db = await readDB();
  const { orderId, userId } = req.body;

  if (!orderId || !userId) {
    return res.status(400).json({ error: 'orderId e userId são obrigatórios' });
  }

  // Buscar configuração do Notazz
  const notazzConfig = db.notazzConfigs?.find(c => c.userId === userId);

  if (!notazzConfig || !notazzConfig.enabled) {
    return res.status(400).json({ error: 'Integração Notazz não está ativada' });
  }

  // Buscar pedido
  const order = db.orders.find(o => o.id === orderId);

  if (!order) {
    return res.status(404).json({ error: 'Pedido não encontrado' });
  }

  try {
    // Preparar payload para o Notazz
    const notazzPayload = {
      order_id: order.id,
      order_number: order.orderNumber || order.id,
      product_name: order.productName,
      product_price: order.productPrice,
      quantity: order.quantity,
      total_value: order.totalValue,
      customer: {
        name: order.customer?.name || '',
        email: order.customer?.email || '',
        phone: order.customer?.phone || '',
        cpf: order.customer?.cpf || '',
        address: order.customer?.address || '',
        number: order.customer?.number || '',
        complement: order.customer?.complement || '',
        neighborhood: order.customer?.neighborhood || '',
        city: order.customer?.city || '',
        state: order.customer?.state || '',
        zipcode: order.customer?.zipCode || ''
      },
      payment_status: order.paymentStatus,
      created_at: order.createdAt
    };

    console.log(`\n📤 Enviando pedido ${orderId} para Notazz...`);
    console.log(`🔑 Token: ${notazzConfig.token.substring(0, 10)}...`);

    // Enviar para Notazz (simulado - substitua pela URL real da API Notazz)
    const notazzResponse = await fetch('https://api.notazz.com.br/v1/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${notazzConfig.token}`
      },
      body: JSON.stringify(notazzPayload)
    });

    const notazzData = await notazzResponse.json();

    // Salvar log do envio
    if (!db.notazzLogs) {
      db.notazzLogs = [];
    }

    db.notazzLogs.push({
      id: uuidv4(),
      orderId: orderId,
      userId: userId,
      success: notazzResponse.ok,
      statusCode: notazzResponse.status,
      payload: notazzPayload,
      response: notazzData,
      timestamp: new Date().toISOString()
    });

    writeDB(db);

    if (notazzResponse.ok) {
      console.log(`✅ Pedido enviado com sucesso ao Notazz`);
      console.log(`📋 Resposta:`, notazzData);

      res.json({
        success: true,
        message: 'Pedido enviado para Notazz com sucesso',
        notazzResponse: notazzData
      });
    } else {
      console.log(`⚠️ Erro ao enviar pedido ao Notazz: ${notazzResponse.status}`);
      res.status(notazzResponse.status).json({
        success: false,
        error: 'Erro ao enviar pedido para Notazz',
        details: notazzData
      });
    }
  } catch (error) {
    console.error(`❌ Erro ao enviar pedido para Notazz:`, error);
    res.status(500).json({
      success: false,
      error: 'Erro ao comunicar com Notazz',
      details: error.message
    });
  }
});

// Webhook para receber código de rastreio do Notazz
// 📦 WEBHOOK NOTAZZ - Receber rastreio disponível
app.post('/api/integrations/notazz/tracking-webhook', async (req, res) => {
  const db = await readDB();
  const payload = req.body;

  console.log(`\n📥 ========== WEBHOOK NOTAZZ RECEBIDO ==========`);
  console.log(`📦 Payload completo:`, JSON.stringify(payload, null, 2));

  // Extrair dados do payload do Notazz
  const {
    external_id,        // ID do pedido na plataforma
    rastreio_externo,   // Código de rastreio dos Correios
    rastreio,           // URL de rastreio do Notazz
    numero,             // Número da nota fiscal
    chave,              // Chave da nota fiscal
    pdf,                // URL do PDF da nota fiscal
    xml,                // URL do XML da nota fiscal
    statusNota,         // Status da nota (ex: "Autorizada")
    emissao,            // Data de emissão
    rastro              // Array com histórico de rastreamento
  } = payload;

  console.log(`\n📋 Dados extraídos:`);
  console.log(`   🆔 External ID (Pedido): ${external_id}`);
  console.log(`   📦 Rastreio Externo (Correios): ${rastreio_externo}`);
  console.log(`   🔗 URL Rastreio Notazz: ${rastreio}`);
  console.log(`   🧾 Nota Fiscal: ${numero}`);
  console.log(`   📄 PDF: ${pdf}`);
  console.log(`   📊 Status: ${statusNota}`);

  // Validar dados obrigatórios
  if (!external_id) {
    console.log(`❌ ERRO: external_id não fornecido`);
    return res.status(400).json({
      error: 'external_id é obrigatório',
      received: payload
    });
  }

  // Buscar pedido pelo external_id
  const orderIndex = db.orders.findIndex(o => o.id === external_id);

  if (orderIndex === -1) {
    console.log(`❌ ERRO: Pedido ${external_id} não encontrado no banco de dados`);
    console.log(`📋 Pedidos disponíveis: ${db.orders.map(o => o.id).join(', ')}`);
    return res.status(404).json({
      error: 'Pedido não encontrado',
      external_id: external_id,
      available_orders: db.orders.map(o => ({ id: o.id, productName: o.productName }))
    });
  }

  const order = db.orders[orderIndex];
  console.log(`\n✅ Pedido encontrado: ${order.id} - ${order.productName}`);

  // Atualizar pedido com informações do Notazz
  if (rastreio_externo) {
    db.orders[orderIndex].trackingCode = rastreio_externo;
    console.log(`   📦 Código de rastreio adicionado: ${rastreio_externo}`);
  }

  if (rastreio) {
    db.orders[orderIndex].trackingUrl = rastreio;
    console.log(`   🔗 URL de rastreio Notazz adicionada`);
  }

  if (numero) {
    db.orders[orderIndex].notaFiscalNumber = numero;
    console.log(`   🧾 Número da NF adicionado: ${numero}`);
  }

  if (chave) {
    db.orders[orderIndex].notaFiscalKey = chave;
    console.log(`   🔑 Chave da NF adicionada`);
  }

  if (pdf) {
    db.orders[orderIndex].notaFiscalPdfUrl = pdf;
    console.log(`   📄 PDF da NF adicionado`);
  }

  if (xml) {
    db.orders[orderIndex].notaFiscalXmlUrl = xml;
    console.log(`   📊 XML da NF adicionado`);
  }

  if (emissao) {
    db.orders[orderIndex].notaFiscalEmissao = emissao;
    console.log(`   📅 Data de emissão: ${emissao}`);
  }

  db.orders[orderIndex].notazzWebhookReceivedAt = new Date().toISOString();
  db.orders[orderIndex].updatedAt = new Date().toISOString();

  // Atualizar informações de envio
  if (!db.orders[orderIndex].shippingInfo) {
    db.orders[orderIndex].shippingInfo = {};
  }

  if (rastreio_externo) {
    db.orders[orderIndex].shippingInfo.shippingStatus = 'shipped';
    db.orders[orderIndex].shippingInfo.shippingDate = new Date().toISOString();
    db.orders[orderIndex].shippingInfo.carrier = 'Correios';
  }

  // Salvar histórico de rastreamento do Notazz (se disponível)
  if (rastro && Array.isArray(rastro) && rastro.length > 0) {
    if (!db.orders[orderIndex].trackingHistory) {
      db.orders[orderIndex].trackingHistory = [];
    }

    // Adicionar eventos do rastro
    rastro.forEach((evento, index) => {
      if (evento.descricao && evento.descricao.trim()) {
        const trackingEvent = {
          id: uuidv4(),
          status: 'Atualização',
          location: '',
          date: evento.data || new Date().toISOString(),
          description: evento.descricao,
          receivedAt: new Date().toISOString(),
          source: 'notazz_webhook'
        };

        // Adicionar no início (mais recente primeiro)
        db.orders[orderIndex].trackingHistory.unshift(trackingEvent);
        console.log(`   📍 Evento ${index + 1}: ${evento.descricao}`);
      }
    });
  }

  writeDB(db);

  console.log(`\n✅ ========== WEBHOOK PROCESSADO COM SUCESSO ==========`);
  console.log(`📦 Pedido ${external_id} atualizado com sucesso!`);

  if (rastreio_externo) {
    console.log(`📮 Código de rastreio: ${rastreio_externo}`);
  }

  // Disparar webhook interno de código de rastreio (se houver)
  if (rastreio_externo) {
    dispararWebhookPortugues(order.producerId, 'codigoRastreio', db.orders[orderIndex]);
  }

  // Disparar webhook de nota fiscal autorizada (se houver)
  if (numero && statusNota === 'Autorizada') {
    dispararWebhookPortugues(order.producerId, 'notaFiscalAutorizada', db.orders[orderIndex]);
  }

  res.json({
    success: true,
    message: 'Webhook Notazz processado com sucesso',
    order_id: external_id,
    tracking_code: rastreio_externo,
    nota_fiscal: numero,
    updated_fields: {
      trackingCode: !!rastreio_externo,
      trackingUrl: !!rastreio,
      notaFiscalNumber: !!numero,
      notaFiscalPdf: !!pdf,
      trackingHistory: rastro?.length || 0
    }
  });
});

// 🔍 DIAGNÓSTICO NOTAZZ - Verificar configuração e último pedido
app.get('/api/integrations/notazz/diagnostico', async (req, res) => {
  const db = await readDB();
  let { userId } = req.query;

  // Se não passar userId, pegar do primeiro usuário (para facilitar teste)
  if (!userId && db.users && db.users.length > 0) {
    userId = db.users[0].id;
    console.log(`⚠️ userId não fornecido, usando primeiro usuário: ${userId}`);
  }

  if (!userId) {
    return res.status(400).json({ error: 'userId é obrigatório e nenhum usuário encontrado no banco' });
  }

  // Buscar configuração
  const config = db.notazzConfigs?.find(c => c.userId === userId);

  // Buscar últimos pedidos do usuário
  const userOrders = db.orders?.filter(o => o.producerId === userId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 5) || [];

  // Buscar logs do Notazz
  const notazzLogs = db.notazzLogs?.filter(log => log.userId === userId)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, 10) || [];

  // Verificar último pedido AfterPay
  const lastAfterPayOrder = userOrders.find(o => o.paymentMethod === 'afterPay');

  const diagnostico = {
    configuracao: {
      existe: !!config,
      ativada: config?.enabled || false,
      envioAutomatico: config?.autoSend || false,
      webhookId: config?.webhookId || 'NÃO CONFIGURADO',
      ultimaAtualizacao: config?.updatedAt || 'nunca'
    },
    ultimosPedidos: userOrders.map(o => ({
      id: o.id,
      metodo: o.paymentMethod,
      status: o.paymentStatus,
      total: o.totalValue,
      criadoEm: o.createdAt,
      enviadoNotazz: o.sentToNotazz || false,
      enviadoEm: o.sentToNotazzAt || null
    })),
    ultimoPedidoAfterPay: lastAfterPayOrder ? {
      id: lastAfterPayOrder.id,
      status: lastAfterPayOrder.paymentStatus,
      enviadoNotazz: lastAfterPayOrder.sentToNotazz || false,
      enviadoEm: lastAfterPayOrder.sentToNotazzAt || null,
      cliente: lastAfterPayOrder.customer?.name || 'sem nome'
    } : null,
    logsNotazz: notazzLogs.map(log => ({
      orderId: log.orderId,
      sucesso: log.success,
      statusCode: log.statusCode,
      timestamp: log.timestamp,
      erro: log.response?.error || log.response?.message || null
    })),
    verificacoes: {
      configExiste: !!config,
      configAtivada: config?.enabled === true,
      envioAutoAtivo: config?.autoSend === true,
      webhookIdPreenchido: !!config?.webhookId && config.webhookId.length > 0,
      temPedidosAfterPay: userOrders.some(o => o.paymentMethod === 'afterPay'),
      temLogsNotazz: notazzLogs.length > 0
    },
    problemasPossiveis: []
  };

  // Identificar problemas
  if (!config) {
    diagnostico.problemasPossiveis.push('❌ Configuração do Notazz não existe - configure em Settings → Integrações → Notazz');
  }
  if (config && !config.enabled) {
    diagnostico.problemasPossiveis.push('❌ Integração Notazz está DESATIVADA - ative em Settings');
  }
  if (config && !config.autoSend) {
    diagnostico.problemasPossiveis.push('⚠️ Envio automático está DESLIGADO - pedidos não serão enviados automaticamente');
  }
  if (config && (!config.webhookId || config.webhookId.length === 0)) {
    diagnostico.problemasPossiveis.push('❌ Webhook ID não configurado - adicione o ID do webhook do Notazz');
  }
  if (lastAfterPayOrder && !lastAfterPayOrder.sentToNotazz && config?.enabled && config?.autoSend) {
    diagnostico.problemasPossiveis.push('⚠️ Último pedido AfterPay NÃO foi enviado ao Notazz - verifique logs do console do backend');
  }
  if (notazzLogs.length > 0 && notazzLogs[0].success === false) {
    diagnostico.problemasPossiveis.push(`❌ Último envio ao Notazz FALHOU (${notazzLogs[0].statusCode}) - verifique webhook ID e formato do payload`);
  }
  if (diagnostico.problemasPossiveis.length === 0) {
    diagnostico.problemasPossiveis.push('✅ Nenhum problema detectado - configuração parece OK!');
  }

  res.json(diagnostico);
});

// Rotas de Comissões
app.get('/api/commissions', async (req, res) => {
  const db = await readDB();
  const { userId, status } = req.query;

  let commissions = db.commissions;

  if (userId) {
    commissions = commissions.filter(c =>
      c.producerId === userId || c.affiliateId === userId
    );
  }

  if (status) {
    commissions = commissions.filter(c => c.status === status);
  }

  res.json(commissions);
});

// Rota de Validação de Cupom
app.post('/api/coupons/validate', async (req, res) => {
  const db = await readDB();
  const { code, productId } = req.body;

  if (!code || !productId) {
    return res.status(400).json({ error: 'Código do cupom e ID do produto são obrigatórios' });
  }

  // Buscar o produto
  const product = db.products.find(p => p.id === productId);
  if (!product) {
    return res.status(404).json({ error: 'Produto não encontrado' });
  }

  // Buscar o cupom no produto
  const coupon = product.coupons?.find(c =>
    c.code.toUpperCase() === code.toUpperCase() && c.isActive !== false
  );

  if (!coupon) {
    return res.status(404).json({ error: 'Cupom inválido ou inativo' });
  }

  // Retornar os dados do cupom
  res.json({
    code: coupon.code,
    type: coupon.type,
    value: coupon.value,
    isActive: coupon.isActive
  });
});

// Rotas de Usuários (Admin)
app.get('/api/users', async (req, res) => {
  const db = await readDB();
  const users = db.users.map(user => {
    const { password, ...userWithoutPassword } = user;
    return userWithoutPassword;
  });
  res.json(users);
});

// Endpoint para validar fornecedor (supplier)
app.get('/api/suppliers/validate', async (req, res) => {
  const { email } = req.query;

  if (!email) {
    return res.status(400).json({
      valid: false,
      error: 'E-mail não fornecido'
    });
  }

  const db = await readDB();

  // Buscar usuário por e-mail
  const supplier = db.users.find(u => u.email.toLowerCase() === email.toLowerCase());

  if (!supplier) {
    return res.json({
      valid: false,
      error: 'Fornecedor não encontrado'
    });
  }

  // Verificar se tem recipient configurado
  if (!supplier.recipientId) {
    return res.json({
      valid: false,
      error: 'Fornecedor não possui conta split configurada'
    });
  }

  // Verificar se documentos estão aprovados
  if (!supplier.documentsApproved) {
    return res.json({
      valid: false,
      error: 'Documentos pendentes de aprovação'
    });
  }

  // Verificar se conta split está ativa
  if (!supplier.splitAccountActive) {
    return res.json({
      valid: false,
      error: 'Conta split inativa'
    });
  }

  // Fornecedor válido
  res.json({
    valid: true,
    supplier: {
      recipientId: supplier.recipientId,
      name: supplier.name || supplier.email,
      email: supplier.email,
      documentsApproved: supplier.documentsApproved,
      splitAccountActive: supplier.splitAccountActive
    }
  });
});

app.patch('/api/users/:id', async (req, res) => {
  const db = await readDB();
  const userIndex = db.users.findIndex(u => u.id === req.params.id);

  if (userIndex === -1) {
    return res.status(404).json({ error: 'Usuário não encontrado' });
  }

  db.users[userIndex] = {
    ...db.users[userIndex],
    ...req.body,
    updatedAt: new Date().toISOString()
  };

  writeDB(db);

  const { password, ...userWithoutPassword } = db.users[userIndex];
  res.json(userWithoutPassword);
});

app.delete('/api/users/:id', async (req, res) => {
  const db = await readDB();
  const userIndex = db.users.findIndex(u => u.id === req.params.id);

  if (userIndex === -1) {
    return res.status(404).json({ error: 'Usuário não encontrado' });
  }

  db.users.splice(userIndex, 1);
  writeDB(db);

  res.json({ success: true, message: 'Usuário excluído com sucesso' });
});

// ============ CONFIGURAÇÃO DE RECIPIENT (APENAS MANUAL - ADMIN) ============

/**
 * Criar recipient manualmente na Pagar.me (apenas quando admin clicar no botão)
 */
app.post('/api/users/:userId/create-recipient', async (req, res) => {
  try {
    const { userId } = req.params;
    const db = await readDB();

    const userIndex = db.users.findIndex(u => u.id === userId);

    if (userIndex === -1) {
      return res.status(404).json({
        success: false,
        error: 'Usuário não encontrado'
      });
    }

    const user = db.users[userIndex];

    // Verificar se usuário já tem recipient
    if (user.pagarmeRecipientId) {
      return res.status(400).json({
        success: false,
        error: 'Usuário já possui recipient criado',
        recipientId: user.pagarmeRecipientId
      });
    }

    // Verificar se há dados bancários salvos
    const verification = db.userVerifications?.find(v => v.userId === userId);
    if (!verification || !verification.formData) {
      return res.status(400).json({
        success: false,
        error: 'Dados bancários não encontrados. Configure os dados bancários primeiro.'
      });
    }

    // Extrair dados bancários do formData
    const bankData = verification.formData;

    // Extrair dígito verificador da agência (se houver)
    let agencia = bankData.agency || bankData.agencia || '';
    let agencia_dv = bankData.agencyDigit || bankData.agencia_dv || null;

    if (agencia.includes('-')) {
      const parts = agencia.split('-');
      agencia = parts[0].trim();
      agencia_dv = parts[1]?.trim() || null;
    }
    agencia = agencia.replace(/\D/g, ''); // Remove caracteres não numéricos

    // Extrair dígito verificador da conta (sempre presente)
    let conta = bankData.accountNumber || bankData.conta || '';
    let conta_dv = bankData.accountDigit || bankData.conta_dv || '';

    if (conta.includes('-')) {
      const parts = conta.split('-');
      conta = parts[0].trim();
      conta_dv = parts[1]?.trim() || '';
    }
    conta = conta.replace(/\D/g, ''); // Remove caracteres não numéricos

    // Se ainda não tiver dígito, pegar o último dígito da conta
    if (!conta_dv && conta.length > 0) {
      conta_dv = conta.slice(-1);
      conta = conta.slice(0, -1);
    }

    // Preparar objeto bankAccount para a Pagar.me
    const bankAccount = {
      bank_code: bankData.bankCode || bankData.bank_code || '',
      agencia: agencia,
      agencia_dv: agencia_dv,
      conta: conta,
      conta_dv: conta_dv,
      type: bankData.accountType === 'Poupança' || bankData.accountType === 'poupanca' ? 'conta_poupanca' : 'conta_corrente',
      document_number: (user.cpf || user.cnpj || bankData.cpf || bankData.cnpj || bankData.accountHolderDocument)?.replace(/\D/g, ''),
      legal_name: bankData.accountHolder || user.name,
      email: bankData.email || user.email || 'sem-email@exemplo.com'
    };

    // Log para debug
    console.log('\n===== DEBUG: CRIAÇÃO DE RECIPIENT =====');
    console.log('📋 Dados bancários preparados para Pagar.me:');
    console.log(JSON.stringify(bankAccount, null, 2));
    console.log('\n📋 Dados originais do formData:');
    console.log(JSON.stringify(bankData, null, 2));
    console.log('=========================================\n');

    // Validar campos obrigatórios
    const requiredFields = ['bank_code', 'agencia', 'conta', 'conta_dv', 'document_number', 'legal_name'];
    const missingFields = [];
    for (const field of requiredFields) {
      if (!bankAccount[field]) {
        missingFields.push(field);
      }
    }

    if (missingFields.length > 0) {
      console.error('❌ Campos ausentes:', missingFields.join(', '));
      console.error('❌ Dados recebidos do formData:', JSON.stringify(bankData, null, 2));
      return res.status(400).json({
        success: false,
        error: `Dados bancários incompletos. Campo(s) ausente(s): ${missingFields.join(', ')}`,
        hint: 'Verifique se:\n1. Os dados bancários do usuário estão aprovados\n2. A configuração Pagar.me está completa'
      });
    }

    // Marcar status como pending
    db.users[userIndex].splitStatus = 'pending';
    writeDB(db);

    // Criar recipient na Pagar.me
    console.log(`👤 Criando recipient para usuário ${userId}...`);

    const apiKey = await getPagarmeApiKey();
    if (!apiKey) {
      db.users[userIndex].splitStatus = 'not_created';
      writeDB(db);

      return res.status(500).json({
        success: false,
        error: 'CHAVE DA API PAGAR.ME NÃO CONFIGURADA. Configure em: Configurações > Integrações > Pagar.me'
      });
    }

    try {
      const recipient = await pagarmeService.createRecipient({
        bankAccount: bankAccount,
        transferInterval: 'daily',
        apiKey: apiKey
      });

      console.log(`✅ Recipient criado: ${recipient.recipientId}`);

      // Salvar recipient ID e marcar como aprovado
      // ✅ FORMATO NOVO (padrão): user.pagarme.recipientId
      if (!db.users[userIndex].pagarme) {
        db.users[userIndex].pagarme = {};
      }
      db.users[userIndex].pagarme.recipientId = recipient.recipientId;
      db.users[userIndex].pagarme.recipientStatus = recipient.status || 'active';
      db.users[userIndex].pagarme.transferInterval = recipient.transferInterval || 'daily';
      db.users[userIndex].pagarme.transferEnabled = recipient.transferEnabled !== false;
      db.users[userIndex].pagarme.createdAt = recipient.createdAt || new Date().toISOString();

      // ✅ COMPATIBILIDADE: Manter também no formato antigo
      db.users[userIndex].pagarmeRecipientId = recipient.recipientId;
      db.users[userIndex].recipientId = recipient.recipientId; // Fallback adicional

      db.users[userIndex].splitStatus = 'active';
      db.users[userIndex].splitCreatedAt = new Date().toISOString();
      db.users[userIndex].bankAccount = bankAccount;
      db.users[userIndex].updatedAt = new Date().toISOString();

      writeDB(db);

      console.log(`💾 Recipient salvo no usuário em múltiplos formatos para compatibilidade`);
      console.log(`   user.pagarme.recipientId: ${recipient.recipientId}`);
      console.log(`   user.recipientId: ${recipient.recipientId}`);

      res.json({
        success: true,
        message: 'Recipient criado com sucesso!',
        recipientId: recipient.recipientId,
        status: recipient.status,
        transferInterval: recipient.transferInterval
      });

    } catch (pagarmeError) {
      console.error('❌ Erro ao criar recipient na Pagar.me:', pagarmeError.message);
      console.error('❌ Stack trace:', pagarmeError.stack);

      // Voltar status para not_created
      db.users[userIndex].splitStatus = 'not_created';
      writeDB(db);

      // Extrair mensagem de erro mais específica
      let errorMessage = 'Erro ao criar recebedor na Pagar.me';
      let errorDetails = pagarmeError.message;

      // Se a mensagem contém JSON da Pagar.me, tentar parsear
      try {
        const match = pagarmeError.message.match(/\{.*\}/);
        if (match) {
          const errorJson = JSON.parse(match[0]);
          if (errorJson.errors && errorJson.errors.length > 0) {
            errorDetails = errorJson.errors.map(e =>
              `${e.parameter_name}: ${e.message}`
            ).join(', ');
          }
        }
      } catch (parseError) {
        // Manter errorDetails original se não conseguir parsear
      }

      return res.status(500).json({
        success: false,
        error: errorMessage,
        details: errorDetails,
        bankAccountDebug: bankAccount // Incluir dados para debug
      });
    }

  } catch (error) {
    console.error('❌ Erro ao criar recipient:', error);
    res.status(500).json({
      success: false,
      error: 'Erro interno ao criar recipient',
      details: error.message
    });
  }
});

/**
 * Sincronizar recipient com Pagar.me
 */
app.post('/api/users/:userId/sync-recipient', async (req, res) => {
  try {
    const { userId } = req.params;
    const db = await readDB();

    const user = db.users.find(u => u.id === userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'Usuário não encontrado'
      });
    }

    if (!user.pagarmeRecipientId) {
      return res.status(400).json({
        success: false,
        error: 'Usuário não possui recipient criado'
      });
    }

    const apiKey = await getPagarmeApiKey();
    if (!apiKey) {
      return res.status(500).json({
        success: false,
        error: 'CHAVE DA API PAGAR.ME NÃO CONFIGURADA. Configure em: Configurações > Integrações > Pagar.me'
      });
    }

    try {
      const recipient = await pagarmeService.getRecipient(user.pagarmeRecipientId, apiKey);

      console.log(`✅ Recipient sincronizado: ${recipient.recipientId}`);

      res.json({
        success: true,
        message: 'Recipient sincronizado com sucesso',
        recipient: recipient
      });

    } catch (pagarmeError) {
      console.error('❌ Erro ao sincronizar recipient:', pagarmeError.message);

      return res.status(500).json({
        success: false,
        error: 'Erro ao sincronizar com Pagar.me',
        details: pagarmeError.message
      });
    }

  } catch (error) {
    console.error('❌ Erro ao sincronizar recipient:', error);
    res.status(500).json({
      success: false,
      error: 'Erro interno ao sincronizar recipient',
      details: error.message
    });
  }
});

/**
 * Desconectar recipient (remover integração)
 */
app.post('/api/users/:userId/disconnect-recipient', async (req, res) => {
  try {
    const { userId } = req.params;
    const db = await readDB();

    const userIndex = db.users.findIndex(u => u.id === userId);

    if (userIndex === -1) {
      return res.status(404).json({
        success: false,
        error: 'Usuário não encontrado'
      });
    }

    const user = db.users[userIndex];

    if (!user.pagarmeRecipientId) {
      return res.status(400).json({
        success: false,
        error: 'Usuário não possui recipient criado'
      });
    }

    console.log(`🔌 Desconectando recipient ${user.pagarmeRecipientId} do usuário ${userId}...`);

    // Remover recipient ID e resetar status
    delete db.users[userIndex].pagarmeRecipientId;
    delete db.users[userIndex].splitCreatedAt;
    db.users[userIndex].splitStatus = 'not_created';
    db.users[userIndex].updatedAt = new Date().toISOString();
    writeDB(db);

    res.json({
      success: true,
      message: 'Recipient desconectado com sucesso'
    });

  } catch (error) {
    console.error('❌ Erro ao desconectar recipient:', error);
    res.status(500).json({
      success: false,
      error: 'Erro interno ao desconectar recipient',
      details: error.message
    });
  }
});

// ============ ROTAS DE SALDO E TRANSAÇÕES ============

// Obter dados de saldo e vendas do usuário (integrado com Pagar.me)
// ✅ SALDO CONSOLIDADO - Busca de todas as adquirentes configuradas
app.get('/api/users/:userId/balance', async (req, res) => {
  try {
    const { userId } = req.params;
    const db = await readDB();

    // Buscar usuário
    const user = db.users?.find(u => u.id === userId);
    if (!user) {
      return res.status(404).json({ success: false, error: 'Usuário não encontrado' });
    }

    console.log(`💰 Buscando saldo consolidado para usuário ${userId} (${user.name || user.email})`);

    // Array para armazenar saldos de cada adquirente
    let balancesByAcquirer = [];
    let totalAvailable = 0;
    let totalPending = 0;
    let totalTransferred = 0;

    // ✅ 1. PAGAR.ME
    const pagarmeRecipientId = user.pagarme?.recipientId || user.pagarmeRecipientId || user.recipientId;
    if (pagarmeRecipientId && db.platformFeesByAcquirer?.['Pagar.me']?.configured) {
      try {
        const apiKey = process.env.PAGARME_SECRET_KEY;
        if (apiKey) {
          console.log(`🔄 Buscando saldo Pagar.me...`);
          const balanceData = await pagarmeService.getRecipientBalance(pagarmeRecipientId, apiKey);

          balancesByAcquirer.push({
            acquirer: 'Pagar.me',
            available: balanceData.available,
            pending: balanceData.waitingFunds,
            transferred: balanceData.transferred
          });

          totalAvailable += balanceData.available;
          totalPending += balanceData.waitingFunds;
          totalTransferred += balanceData.transferred;

          console.log(`✅ Pagar.me: R$ ${(balanceData.available / 100).toFixed(2)}`);
        }
      } catch (error) {
        console.error(`❌ Erro ao buscar saldo Pagar.me:`, error.message);
      }
    }

    // ✅ 2. MERCADO PAGO (futuro)
    // if (user.mercadopago?.userId && db.platformFeesByAcquirer?.['Mercado Pago']?.configured) {
    //   // TODO: Implementar getMercadoPagoBalance()
    // }

    // ✅ 3. ASAAS (futuro)
    // if (user.asaas?.accessToken && db.platformFeesByAcquirer?.['Asaas']?.configured) {
    //   // TODO: Implementar getAsaasBalance()
    // }

    // Se não encontrou nenhum saldo
    if (balancesByAcquirer.length === 0) {
      console.log('⚠️ Nenhuma adquirente configurada');
      return res.json({
        success: true,
        balance: {
          available: { total: 0 },
          pending: { total: 0 },
          transferred: { total: 0 }
        },
        breakdown: [],
        message: 'Nenhuma adquirente configurada. Configure sua conta bancária primeiro.'
      });
    }

    // Retornar saldo consolidado
    res.json({
      success: true,
      balance: {
        available: { total: totalAvailable },
        pending: { total: totalPending },
        transferred: { total: totalTransferred }
      },
      breakdown: balancesByAcquirer,  // Detalhamento por adquirente (só admin vê)
      lastUpdate: new Date().toISOString(),
      source: 'consolidated_api'
    });

  } catch (error) {
    console.error('❌ Erro ao buscar saldo consolidado:', error);
    res.status(500).json({
      success: false,
      error: 'Erro interno ao buscar saldo',
      details: error.message
    });
  }
});

// ✅ SOLICITAR SAQUE INTELIGENTE - Distribui entre múltiplas adquirentes
app.post('/api/users/:userId/withdraw', async (req, res) => {
  try {
    const { userId } = req.params;
    const { amount } = req.body; // Valor solicitado em centavos
    const db = await readDB();

    const user = db.users?.find(u => u.id === userId);
    if (!user) {
      return res.status(404).json({ success: false, error: 'Usuário não encontrado' });
    }

    console.log(`💸 Solicitação de saque: R$ ${(amount / 100).toFixed(2)} - ${user.name}`);

    // 1. Buscar saldo de todas adquirentes
    let acquirerBalances = [];

    // Pagar.me
    const pagarmeRecipientId = user.pagarme?.recipientId || user.pagarmeRecipientId || user.recipientId;
    if (pagarmeRecipientId && db.platformFeesByAcquirer?.['Pagar.me']?.configured) {
      try {
        const apiKey = process.env.PAGARME_SECRET_KEY;
        if (apiKey) {
          const balanceData = await pagarmeService.getRecipientBalance(pagarmeRecipientId, apiKey);
          acquirerBalances.push({
            acquirer: 'Pagar.me',
            available: balanceData.available,
            recipientId: pagarmeRecipientId,
            masterId: 'platform-master' // ID do master da plataforma
          });
        }
      } catch (error) {
        console.error(`Erro ao buscar saldo Pagar.me:`, error.message);
      }
    }

    // TODO: Adicionar Mercado Pago, Asaas, etc...

    // 2. Ordenar: Pagar.me sempre primeiro
    acquirerBalances.sort((a, b) => {
      if (a.acquirer === 'Pagar.me') return -1;
      if (b.acquirer === 'Pagar.me') return 1;
      return a.acquirer.localeCompare(b.acquirer);
    });

    // 3. Verificar se tem saldo suficiente
    const totalAvailable = acquirerBalances.reduce((sum, a) => sum + a.available, 0);
    if (amount > totalAvailable) {
      return res.status(400).json({
        success: false,
        error: 'Saldo insuficiente',
        available: totalAvailable,
        requested: amount
      });
    }

    // 4. Buscar taxa de saque
    const withdrawFee = db.platformFeesByAcquirer?.['Pagar.me']?.fees?.saque?.fixedFee || 3.67;
    const withdrawFeeInCents = Math.round(withdrawFee * 100);

    // 5. Distribuir saque entre adquirentes
    let remaining = amount;
    let transfers = [];
    let isFirst = true;

    for (const acquirerBalance of acquirerBalances) {
      if (remaining <= 0) break;
      if (acquirerBalance.available <= 0) continue;

      const transferAmount = Math.min(remaining, acquirerBalance.available);
      const feeForThisTransfer = isFirst ? withdrawFeeInCents : withdrawFeeInCents;
      const feePaidBy = isFirst ? 'user' : 'platform';
      const netAmount = isFirst ? transferAmount - feeForThisTransfer : transferAmount;

      transfers.push({
        order: transfers.length + 1,
        acquirer: acquirerBalance.acquirer,
        grossAmount: transferAmount,
        fee: feeForThisTransfer,
        feePaidBy: feePaidBy,
        netAmount: netAmount,
        isFirst: isFirst,
        recipientId: acquirerBalance.recipientId,
        masterId: acquirerBalance.masterId
      });

      remaining -= transferAmount;
      isFirst = false;
    }

    // 6. Calcular totais
    const totalFeeUser = transfers.filter(t => t.feePaidBy === 'user').reduce((s, t) => s + t.fee, 0);
    const totalFeePlatform = transfers.filter(t => t.feePaidBy === 'platform').reduce((s, t) => s + t.fee, 0);
    const totalNetAmount = transfers.reduce((s, t) => s + t.netAmount, 0);

    // 7. Salvar no banco de dados
    if (!db.withdrawals) {
      db.withdrawals = [];
    }

    const withdrawal = {
      id: uuidv4(),
      userId: userId,
      userName: user.name || user.email,
      requestedAmount: amount,
      totalFee: totalFeeUser + totalFeePlatform,
      feeUserPaid: totalFeeUser,
      feePlatformPaid: totalFeePlatform,
      netAmount: totalNetAmount,
      numberOfTransfers: transfers.length,
      transfers: transfers,
      status: 'pending',
      createdAt: new Date().toISOString(),
      bankAccount: user.bankAccount || {}
    };

    db.withdrawals.push(withdrawal);
    writeDB(db);

    console.log(`✅ Saque criado: ${withdrawal.id} - ${transfers.length} transferências`);

    // 8. Retornar detalhes
    res.json({
      success: true,
      withdrawal: {
        id: withdrawal.id,
        requestedAmount: amount,
        feeUserPays: totalFeeUser,
        netAmount: totalNetAmount,
        numberOfTransfers: transfers.length,
        transfers: transfers.map(t => ({
          acquirer: t.acquirer,
          amount: t.grossAmount,
          fee: t.fee,
          feePaidBy: t.feePaidBy,
          netAmount: t.netAmount
        }))
      }
    });

  } catch (error) {
    console.error('❌ Erro ao processar saque:', error);
    res.status(500).json({
      success: false,
      error: 'Erro interno ao processar saque',
      details: error.message
    });
  }
});

// ✅ LISTAR SAQUES DO USUÁRIO
app.get('/api/users/:userId/withdrawals', async (req, res) => {
  try {
    const { userId } = req.params;
    const db = await readDB();

    const user = db.users?.find(u => u.id === userId);
    if (!user) {
      return res.status(404).json({ success: false, error: 'Usuário não encontrado' });
    }

    const withdrawals = (db.withdrawals || [])
      .filter(w => w.userId === userId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json({
      success: true,
      withdrawals: withdrawals
    });

  } catch (error) {
    console.error('❌ Erro ao listar saques:', error);
    res.status(500).json({
      success: false,
      error: 'Erro interno ao listar saques',
      details: error.message
    });
  }
});

// ============ ROTAS DE AUTO-LOGIN ============

// Gerar token de login temporário
app.post('/api/users/:userId/generate-login-token', async (req, res) => {
  try {
    const { userId } = req.params;
    const db = await readDB();

    const user = db.users?.find(u => u.id === userId);
    if (!user) {
      return res.status(404).json({ success: false, error: 'Usuário não encontrado' });
    }

    // Segredo JWT (em produção, use uma variável de ambiente)
    const JWT_SECRET = process.env.JWT_SECRET || 'pag2pay-secret-key-2024';

    // Gerar token JWT que expira em 60 segundos
    const token = jwt.sign(
      {
        userId: user.id,
        email: user.email,
        type: 'auto-login',
        timestamp: Date.now()
      },
      JWT_SECRET,
      { expiresIn: '60s' }
    );

    console.log(`🔐 Token de auto-login gerado para: ${user.name} (${user.email})`);

    res.json({
      success: true,
      token: token
    });

  } catch (error) {
    console.error('❌ Erro ao gerar token:', error);
    res.status(500).json({
      success: false,
      error: 'Erro ao gerar token de acesso',
      details: error.message
    });
  }
});

// Endpoint de auto-login
app.post('/api/auto-login', async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ success: false, error: 'Token não fornecido' });
    }

    const JWT_SECRET = process.env.JWT_SECRET || 'pag2pay-secret-key-2024';

    // Verificar e decodificar token
    const decoded = jwt.verify(token, JWT_SECRET);

    if (decoded.type !== 'auto-login') {
      return res.status(401).json({ success: false, error: 'Token inválido' });
    }

    const db = await readDB();
    const user = db.users?.find(u => u.id === decoded.userId);

    if (!user) {
      return res.status(404).json({ success: false, error: 'Usuário não encontrado' });
    }

    console.log(`✅ Auto-login bem-sucedido: ${user.name} (${user.email})`);

    // Retornar dados do usuário para autenticação
    res.json({
      success: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        accountType: user.accountType,
        role: user.role || 'user',
        status: user.status
      }
    });

  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        error: 'Token expirado',
        message: 'O link de acesso expirou. Gere um novo link.'
      });
    }

    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        error: 'Token inválido',
        message: 'O link de acesso é inválido.'
      });
    }

    console.error('❌ Erro no auto-login:', error);
    res.status(500).json({
      success: false,
      error: 'Erro interno no auto-login',
      details: error.message
    });
  }
});

// ============ ROTAS DE TAXAS PERSONALIZADAS POR USUÁRIO ============

// Obter taxas do usuário
app.get('/api/users/:userId/fees', async (req, res) => {
  try {
    const { userId } = req.params;
    const db = await readDB();

    const user = db.users?.find(u => u.id === userId);
    if (!user) {
      return res.status(404).json({ success: false, error: 'Usuário não encontrado' });
    }

    // Retornar taxas personalizadas do usuário (se existirem)
    res.json({
      success: true,
      fees: user.customFees || null
    });

  } catch (error) {
    console.error('❌ Erro ao buscar taxas:', error);
    res.status(500).json({
      success: false,
      error: 'Erro interno ao buscar taxas',
      details: error.message
    });
  }
});

// Salvar taxas personalizadas do usuário
app.post('/api/users/:userId/fees', async (req, res) => {
  try {
    const { userId } = req.params;
    const { feeType, fees } = req.body;
    const db = await readDB();

    const userIndex = db.users?.findIndex(u => u.id === userId);
    if (userIndex === -1) {
      return res.status(404).json({ success: false, error: 'Usuário não encontrado' });
    }

    // Inicializar customFees se não existir
    if (!db.users[userIndex].customFees) {
      db.users[userIndex].customFees = {
        pix: {},
        boleto: {},
        cartao: {},
        saque: {}
      };
    }

    // Atualizar taxas do tipo específico
    // Só salvar campos que não estão vazios
    const cleanedFees = {};
    for (const [key, value] of Object.entries(fees)) {
      if (value !== '' && value !== null && value !== undefined) {
        cleanedFees[key] = value;
      }
    }

    db.users[userIndex].customFees[feeType] = cleanedFees;
    db.users[userIndex].updatedAt = new Date().toISOString();

    writeDB(db);

    res.json({
      success: true,
      message: `Taxas de ${feeType} atualizadas com sucesso`,
      fees: db.users[userIndex].customFees
    });

  } catch (error) {
    console.error('❌ Erro ao salvar taxas:', error);
    res.status(500).json({
      success: false,
      error: 'Erro interno ao salvar taxas',
      details: error.message
    });
  }
});

// ============ ROTAS DE CONFIGURAÇÃO DE SAQUES ============

// Obter configuração de saques do usuário
app.get('/api/users/:userId/withdrawal-config', async (req, res) => {
  try {
    const { userId } = req.params;
    const db = await readDB();

    const user = db.users?.find(u => u.id === userId);
    if (!user) {
      return res.status(404).json({ success: false, error: 'Usuário não encontrado' });
    }

    // Retornar configuração de saques (se existir)
    res.json({
      success: true,
      config: user.withdrawalConfig || null
    });

  } catch (error) {
    console.error('❌ Erro ao buscar configuração de saques:', error);
    res.status(500).json({
      success: false,
      error: 'Erro interno ao buscar configuração',
      details: error.message
    });
  }
});

// Salvar configuração de saques do usuário
app.post('/api/users/:userId/withdrawal-config', async (req, res) => {
  try {
    const { userId } = req.params;
    const { maxDailyWithdrawal, maxPerWithdrawal, minPerWithdrawal, autoApprovalEnabled } = req.body;
    const db = await readDB();

    const userIndex = db.users?.findIndex(u => u.id === userId);
    if (userIndex === -1) {
      return res.status(404).json({ success: false, error: 'Usuário não encontrado' });
    }

    // Criar objeto de configuração limpo (apenas valores preenchidos)
    const config = {
      autoApprovalEnabled: autoApprovalEnabled || false
    };

    if (maxDailyWithdrawal && maxDailyWithdrawal !== '') {
      config.maxDailyWithdrawal = parseFloat(maxDailyWithdrawal);
    }
    if (maxPerWithdrawal && maxPerWithdrawal !== '') {
      config.maxPerWithdrawal = parseFloat(maxPerWithdrawal);
    }
    if (minPerWithdrawal && minPerWithdrawal !== '') {
      config.minPerWithdrawal = parseFloat(minPerWithdrawal);
    }

    db.users[userIndex].withdrawalConfig = config;
    db.users[userIndex].updatedAt = new Date().toISOString();

    writeDB(db);

    res.json({
      success: true,
      message: 'Configuração de saques atualizada com sucesso',
      config: config
    });

  } catch (error) {
    console.error('❌ Erro ao salvar configuração de saques:', error);
    res.status(500).json({
      success: false,
      error: 'Erro interno ao salvar configuração',
      details: error.message
    });
  }
});

// Solicitar saque
app.post('/api/users/:userId/withdrawal/request', async (req, res) => {
  try {
    const { userId } = req.params;
    const { amount } = req.body;
    const db = await readDB();

    // Validar valor
    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Valor de saque inválido'
      });
    }

    // Buscar usuário
    const user = db.users?.find(u => u.id === userId);
    if (!user) {
      return res.status(404).json({ success: false, error: 'Usuário não encontrado' });
    }

    // Validar saque baseado nas configurações
    const validation = validateWithdrawal(userId, amount, db);
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        error: validation.error
      });
    }

    // Verificar saldo disponível (buscar do endpoint de saldo)
    // Por simplicidade, vou buscar direto aqui
    const orders = db.orders?.filter(order =>
      order.sellerId === userId && order.status === 'paid'
    ) || [];

    let availableBalance = 0;
    for (const order of orders) {
      const sellerAmount = order.sellerAmount || (order.totalAmount * 0.95);
      const paidDate = new Date(order.paidAt || order.createdAt);
      const daysSincePaid = Math.floor((new Date() - paidDate) / (1000 * 60 * 60 * 24));

      // Aplicar regras de liberação
      if (order.paymentMethod === 'pix') {
        availableBalance += sellerAmount;
      } else if (order.paymentMethod === 'boleto' && daysSincePaid >= 1) {
        availableBalance += sellerAmount;
      } else if (order.paymentMethod === 'credit_card' && daysSincePaid >= 30) {
        availableBalance += sellerAmount;
      }
    }

    // Subtrair saques já realizados
    const completedWithdrawals = db.withdrawals?.filter(w =>
      w.userId === userId && w.status === 'completed'
    ) || [];
    const totalWithdrawn = completedWithdrawals.reduce((sum, w) => sum + (w.amount || 0), 0);
    availableBalance -= totalWithdrawn;

    if (amount > availableBalance) {
      return res.status(400).json({
        success: false,
        error: `Saldo insuficiente. Disponível: R$ ${(availableBalance / 100).toFixed(2)}`
      });
    }

    // Verificar se aprovação automática está ativada
    const config = user.withdrawalConfig || {};
    const autoApproval = config.autoApprovalEnabled || false;

    // Criar solicitação de saque
    if (!db.withdrawals) {
      db.withdrawals = [];
    }

    const withdrawal = {
      id: uuidv4(),
      userId: userId,
      amount: amount,
      status: autoApproval ? 'completed' : 'pending',
      requestedAt: new Date().toISOString(),
      approvedAt: autoApproval ? new Date().toISOString() : null,
      approvedBy: autoApproval ? 'auto' : null
    };

    db.withdrawals.push(withdrawal);
    writeDB(db);

    res.json({
      success: true,
      message: autoApproval
        ? 'Saque aprovado automaticamente e processado com sucesso'
        : 'Solicitação de saque criada. Aguardando aprovação manual.',
      withdrawal: withdrawal,
      autoApproved: autoApproval
    });

  } catch (error) {
    console.error('❌ Erro ao processar saque:', error);
    res.status(500).json({
      success: false,
      error: 'Erro interno ao processar saque',
      details: error.message
    });
  }
});

// ============ ROTAS DE CONFIGURAÇÃO DE ANTECIPAÇÃO ============

// Obter configuração de antecipação do usuário
app.get('/api/users/:userId/anticipation-config', async (req, res) => {
  try {
    const { userId } = req.params;
    const db = await readDB();

    const user = db.users?.find(u => u.id === userId);
    if (!user) {
      return res.status(404).json({ success: false, error: 'Usuário não encontrado' });
    }

    res.json({
      success: true,
      config: user.anticipationConfig || null
    });

  } catch (error) {
    console.error('❌ Erro ao buscar configuração de antecipação:', error);
    res.status(500).json({
      success: false,
      error: 'Erro interno ao buscar configuração',
      details: error.message
    });
  }
});

// Salvar configuração de antecipação do usuário
app.post('/api/users/:userId/anticipation-config', async (req, res) => {
  try {
    const { userId } = req.params;
    const { anticipationDays, anticipationRate, calculateByDays, customAnticipationEnabled } = req.body;
    const db = await readDB();

    const userIndex = db.users?.findIndex(u => u.id === userId);
    if (userIndex === -1) {
      return res.status(404).json({ success: false, error: 'Usuário não encontrado' });
    }

    // Criar objeto de configuração limpo
    const config = {
      calculateByDays: calculateByDays || false,
      customAnticipationEnabled: customAnticipationEnabled || false
    };

    if (anticipationDays && anticipationDays !== '') {
      config.anticipationDays = parseInt(anticipationDays);
    }
    if (anticipationRate && anticipationRate !== '') {
      config.anticipationRate = parseFloat(anticipationRate);
    }

    db.users[userIndex].anticipationConfig = config;
    db.users[userIndex].updatedAt = new Date().toISOString();

    writeDB(db);

    res.json({
      success: true,
      message: 'Configuração de antecipação atualizada com sucesso',
      config: config
    });

  } catch (error) {
    console.error('❌ Erro ao salvar configuração de antecipação:', error);
    res.status(500).json({
      success: false,
      error: 'Erro interno ao salvar configuração',
      details: error.message
    });
  }
});

// ============ ROTAS DE VERIFICAÇÃO DE DOCUMENTOS (KYC) ============

// Obter dados de verificação do usuário
app.get('/api/users/:userId/verification', async (req, res) => {
  const db = await readDB();
  const { userId } = req.params;

  if (!db.userVerifications) {
    db.userVerifications = [];
  }

  const verification = db.userVerifications.find(v => v.userId === userId);

  if (verification) {
    // Mapear documentos para o formato esperado pelo frontend
    const mappedVerification = {
      ...verification,
      // Garantir que sub-status sejam 'not_submitted' quando o status principal é 'not_submitted'
      kyc: verification.status === 'not_submitted'
        ? { status: 'not_submitted' }
        : (verification.kyc || { status: 'not_submitted' }),
      documentos: verification.status === 'not_submitted'
        ? { statusSelfie: 'not_submitted', statusDocumento: 'not_submitted' }
        : (verification.documentos || { statusSelfie: 'not_submitted', statusDocumento: 'not_submitted' }),
      dadosBancarios: verification.status === 'not_submitted'
        ? { status: 'not_submitted' }
        : (verification.dadosBancarios || { status: 'not_submitted' }),
      documents: {
        selfie: verification.documents?.selfie || null,
        selfieUrl: verification.documents?.selfieUrl || null,
        // Compatibilidade: retorna idDocument se disponível, senão tenta idFront/idBack
        idDocument: verification.documents?.idDocument || verification.documents?.idFront || verification.documents?.idBack || null,
        idDocumentUrl: verification.documents?.idDocumentUrl || verification.documents?.idFrontUrl || verification.documents?.idBackUrl || null,
        idFront: verification.documents?.idFront || null,
        idFrontUrl: verification.documents?.idFrontUrl || null,
        idBack: verification.documents?.idBack || null,
        idBackUrl: verification.documents?.idBackUrl || null,
        socialContract: verification.documents?.socialContract || null,
        socialContractUrl: verification.documents?.socialContractUrl || null
      }
    };
    res.json(mappedVerification);
  } else {
    // Retornar estrutura padrão se não existir
    res.json({
      userId,
      status: 'not_submitted',
      kyc: { status: 'not_submitted' },
      documentos: { statusSelfie: 'not_submitted', statusDocumento: 'not_submitted' },
      dadosBancarios: { status: 'not_submitted' },
      documents: { selfie: null, selfieUrl: null, idDocument: null, idDocumentUrl: null },
      notifications: []
    });
  }
});

// Enviar/Atualizar documentos de verificação
app.post('/api/users/:userId/verification', async (req, res) => {
  const db = await readDB();
  const { userId } = req.params;
  const { formData, documents, accountType } = req.body;

  if (!db.userVerifications) {
    db.userVerifications = [];
  }

  const existingIndex = db.userVerifications.findIndex(v => v.userId === userId);

  const verification = {
    userId,
    status: 'pending',
    accountType,
    formData,
    documents: {
      selfie: documents.selfie?.name || null,
      selfieUrl: documents.selfie?.data || null,
      // Suporta tanto idDocument (nome antigo) quanto idFront/idBack (novos nomes)
      idDocument: documents.idDocument?.name || null,
      idDocumentUrl: documents.idDocument?.data || null,
      idFront: documents.idFront?.name || null,
      idFrontUrl: documents.idFront?.data || null,
      idBack: documents.idBack?.name || null,
      idBackUrl: documents.idBack?.data || null,
      socialContract: documents.socialContract?.name || null,
      socialContractUrl: documents.socialContract?.data || null
    },
    kyc: { status: 'pending' },
    documentos: { statusSelfie: 'pending', statusDocumento: 'pending' },
    dadosBancarios: { status: 'pending' },
    notifications: [],
    submittedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  if (existingIndex !== -1) {
    db.userVerifications[existingIndex] = verification;
  } else {
    db.userVerifications.push(verification);
  }

  // Atualizar status do usuário: 'novo' → 'aguardando_aprovacao'
  const userIndex = db.users.findIndex(u => u.id === userId);
  if (userIndex !== -1) {
    const currentStatus = db.users[userIndex].status;

    // Se usuário está com status 'novo' ou 'aguardando_ajuste', mudar para 'aguardando_aprovacao'
    if (currentStatus === 'novo' || currentStatus === 'aguardando_ajuste') {
      db.users[userIndex].status = 'aguardando_aprovacao';
      console.log(`✅ [KYC SUBMIT] Status do usuário ${userId} alterado: ${currentStatus} → aguardando_aprovacao`);
    }
  }

  writeDB(db);
  res.json({ success: true, verification });
});

// Salvar rascunho dos documentos (auto-save)
app.post('/api/users/:userId/verification/draft', async (req, res) => {
  const db = await readDB();
  const { userId } = req.params;
  const { formData, documents, accountType } = req.body;

  if (!db.userVerifications) {
    db.userVerifications = [];
  }

  const existingIndex = db.userVerifications.findIndex(v => v.userId === userId);

  // Se já existe verificação, atualizar o rascunho
  if (existingIndex !== -1) {
    // Atualizar apenas os campos do rascunho sem alterar status
    db.userVerifications[existingIndex].formData = formData;
    db.userVerifications[existingIndex].accountType = accountType;

    // Atualizar documentos se fornecidos
    if (documents) {
      db.userVerifications[existingIndex].documents = {
        ...db.userVerifications[existingIndex].documents,
        selfie: documents.selfie?.name || db.userVerifications[existingIndex].documents?.selfie,
        selfieUrl: documents.selfie?.data || db.userVerifications[existingIndex].documents?.selfieUrl,
        idFront: documents.idFront?.name || db.userVerifications[existingIndex].documents?.idFront,
        idFrontUrl: documents.idFront?.data || db.userVerifications[existingIndex].documents?.idFrontUrl,
        idBack: documents.idBack?.name || db.userVerifications[existingIndex].documents?.idBack,
        idBackUrl: documents.idBack?.data || db.userVerifications[existingIndex].documents?.idBackUrl,
        socialContract: documents.socialContract?.name || db.userVerifications[existingIndex].documents?.socialContract,
        socialContractUrl: documents.socialContract?.data || db.userVerifications[existingIndex].documents?.socialContractUrl
      };
    }

    db.userVerifications[existingIndex].updatedAt = new Date().toISOString();
  } else {
    // Criar novo rascunho
    const draft = {
      userId,
      status: 'not_submitted',
      accountType,
      formData,
      documents: {
        selfie: documents.selfie?.name || null,
        selfieUrl: documents.selfie?.data || null,
        idFront: documents.idFront?.name || null,
        idFrontUrl: documents.idFront?.data || null,
        idBack: documents.idBack?.name || null,
        idBackUrl: documents.idBack?.data || null,
        socialContract: documents.socialContract?.name || null,
        socialContractUrl: documents.socialContract?.data || null
      },
      kyc: { status: 'not_submitted' },
      documentos: { statusSelfie: 'not_submitted', statusDocumento: 'not_submitted' },
      dadosBancarios: { status: 'not_submitted' },
      notifications: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    db.userVerifications.push(draft);
  }

  writeDB(db);
  res.json({ success: true, message: 'Rascunho salvo' });
});

// Atualizar status de uma seção específica (usado pelo admin)
app.patch('/api/users/:userId/verification/:section', async (req, res) => {
  const db = await readDB();
  const { userId, section } = req.params;
  const { status, message } = req.body;

  if (!db.userVerifications) {
    db.userVerifications = [];
  }

  const verificationIndex = db.userVerifications.findIndex(v => v.userId === userId);

  if (verificationIndex === -1) {
    return res.status(404).json({ error: 'Verificação não encontrada' });
  }

  const verification = db.userVerifications[verificationIndex];

  // Atualizar status da seção
  if (section === 'kyc') {
    verification.kyc.status = status;
  } else if (section === 'documentos') {
    verification.documentos.statusSelfie = status;
    verification.documentos.statusDocumento = status;
  } else if (section === 'dadosBancarios') {
    verification.dadosBancarios.status = status;
  }

  // Adicionar notificação se houver mensagem
  if (message) {
    if (!verification.notifications) {
      verification.notifications = [];
    }
    verification.notifications.push({
      id: uuidv4(),
      section: section.charAt(0).toUpperCase() + section.slice(1),
      message,
      read: false,
      createdAt: new Date().toISOString()
    });
  }

  // Atualizar status geral
  const allApproved = verification.kyc.status === 'approved' &&
                      verification.documentos.statusSelfie === 'approved' &&
                      verification.documentos.statusDocumento === 'approved' &&
                      verification.dadosBancarios.status === 'approved';

  const anyRejected = verification.kyc.status === 'rejected' ||
                      verification.documentos.statusSelfie === 'rejected' ||
                      verification.documentos.statusDocumento === 'rejected' ||
                      verification.dadosBancarios.status === 'rejected';

  if (allApproved) {
    verification.status = 'approved';
  } else if (anyRejected) {
    verification.status = 'awaiting_adjustment';
  } else {
    verification.status = 'pending';
  }

  verification.updatedAt = new Date().toISOString();

  db.userVerifications[verificationIndex] = verification;
  writeDB(db);

  // 🔔 CRIAR NOTIFICAÇÃO para o usuário sobre aprovação/rejeição de documentos
  const sectionNames = {
    'kyc': 'KYC',
    'documentos': 'Documentos',
    'dadosBancarios': 'Dados Bancários'
  }

  const sectionName = sectionNames[section] || section

  if (status === 'approved') {
    global.createNotification(
      userId,
      'document_approved',
      '✅ Documentos Aprovados!',
      `Sua seção "${sectionName}" foi aprovada${allApproved ? '. Sua conta está totalmente verificada!' : '!'}`,
      {
        important: allApproved,
        data: {
          section: section,
          sectionName: sectionName,
          allApproved: allApproved
        },
        actionButton: {
          text: 'Ver Documentos',
          icon: '📄',
          link: `/documents`
        }
      }
    )
  } else if (status === 'rejected') {
    global.createNotification(
      userId,
      'document_rejected',
      '⚠️ Documentos Rejeitados',
      `Sua seção "${sectionName}" foi rejeitada. ${message || 'Por favor, corrija e reenvie.'}`,
      {
        important: true,
        data: {
          section: section,
          sectionName: sectionName,
          reason: message
        },
        actionButton: {
          text: 'Corrigir Documentos',
          icon: '📄',
          link: `/documents`
        }
      }
    )
  }

  res.json({ success: true, verification });
});

// ============ ROTAS DE GERENCIAMENTO DE USUÁRIOS (ADMIN) ============

// Listar TODOS os usuários cadastrados com status
app.get('/api/platform/users', async (req, res) => {
  const db = await readDB();

  if (!db.users) {
    return res.json([]);
  }

  if (!db.userVerifications) {
    db.userVerifications = [];
  }

  // Mapear todos os usuários com role 'user' e calcular status
  const allUsers = db.users
    .filter(u => u.role === 'user')
    .map(user => {
      const verification = db.userVerifications.find(v => v.userId === user.id);

      let status = 'aguardando_documentos'; // Default: usuário só se cadastrou
      let statusLabel = 'Aguardando Documentos';

      if (verification) {
        if (verification.status === 'approved') {
          status = 'aprovado';
          statusLabel = 'Aprovado';
        } else if (verification.status === 'awaiting_adjustment') {
          status = 'aguardando_ajuste';
          statusLabel = 'Aguardando Ajuste';
        } else if (verification.status === 'rejected') {
          status = 'rejeitado';
          statusLabel = 'Rejeitado';
        } else if (verification.status === 'pending') {
          status = 'aguardando_aprovacao';
          statusLabel = 'Aguardando Aprovação';
        } else if (verification.status === 'not_submitted') {
          status = 'nao_enviado';
          statusLabel = 'Não Enviado';
        }
      }

      return {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        createdAt: user.createdAt,
        status,
        statusLabel,
        verification: verification || null,
        editableByUser: verification?.editableByUser || null // Seções que usuário pode editar
      };
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)); // Mais recentes primeiro

  res.json(allUsers);
});

// Admin edita dados KYC do usuário
app.patch('/api/platform/users/:userId/edit-kyc', async (req, res) => {
  const db = await readDB();
  const { userId } = req.params;
  const { kycData } = req.body;

  if (!db.userVerifications) {
    db.userVerifications = [];
  }

  const verificationIndex = db.userVerifications.findIndex(v => v.userId === userId);

  if (verificationIndex === -1) {
    return res.status(404).json({ error: 'Verificação não encontrada' });
  }

  const verification = db.userVerifications[verificationIndex];

  // Atualizar dados KYC
  if (!verification.formData) {
    verification.formData = {};
  }

  verification.formData = {
    ...verification.formData,
    ...kycData
  };

  verification.updatedAt = new Date().toISOString();
  verification.updatedByAdmin = true;

  db.userVerifications[verificationIndex] = verification;
  writeDB(db);

  res.json({ success: true, verification });
});

// Admin edita dados bancários do usuário
app.patch('/api/platform/users/:userId/edit-bank', async (req, res) => {
  const db = await readDB();
  const { userId } = req.params;
  const { bankData } = req.body;

  if (!db.userVerifications) {
    db.userVerifications = [];
  }

  const verificationIndex = db.userVerifications.findIndex(v => v.userId === userId);

  if (verificationIndex === -1) {
    return res.status(404).json({ error: 'Verificação não encontrada' });
  }

  const verification = db.userVerifications[verificationIndex];

  // Atualizar dados bancários
  if (!verification.formData) {
    verification.formData = {};
  }

  verification.formData = {
    ...verification.formData,
    ...bankData
  };

  verification.updatedAt = new Date().toISOString();
  verification.updatedByAdmin = true;

  db.userVerifications[verificationIndex] = verification;
  writeDB(db);

  res.json({ success: true, verification });
});

// Usuário solicita permissão para editar dados aprovados
app.post('/api/users/:userId/request-edit', async (req, res) => {
  const db = await readDB();
  const { userId } = req.params;
  const { sections } = req.body; // Array de seções: ['kyc', 'dadosBancarios', 'documentos']

  if (!db.userVerifications) {
    db.userVerifications = [];
  }

  const verificationIndex = db.userVerifications.findIndex(v => v.userId === userId);

  if (verificationIndex === -1) {
    return res.status(404).json({ error: 'Verificação não encontrada' });
  }

  const verification = db.userVerifications[verificationIndex];

  // Verificar se está aprovado
  if (verification.status !== 'approved') {
    return res.status(400).json({
      error: 'Apenas usuários com documentos aprovados podem solicitar alteração'
    });
  }

  // Marcar as seções como editáveis pelo usuário
  verification.editableByUser = sections;
  verification.status = 'aguardando_ajuste'; // Mudar status para aguardando ajuste
  verification.requestedEditAt = new Date().toISOString();

  // Resetar status das seções selecionadas para pending
  sections.forEach(section => {
    if (section === 'kyc') {
      verification.kyc.status = 'pending';
    } else if (section === 'dadosBancarios') {
      verification.dadosBancarios.status = 'pending';
    } else if (section === 'documentos') {
      verification.documentos.statusSelfie = 'pending';
      verification.documentos.statusDocumento = 'pending';
    }
  });

  verification.updatedAt = new Date().toISOString();

  db.userVerifications[verificationIndex] = verification;
  writeDB(db);

  res.json({
    success: true,
    message: 'Permissão para editar concedida. Você pode atualizar seus dados agora.',
    verification
  });
});

// ============ ROTAS DE NOTIFICAÇÕES ============

// Listar notificações do usuário
app.get('/api/users/:userId/notifications', async (req, res) => {
  const db = await readDB();
  const { userId } = req.params;

  if (!db.notifications) {
    db.notifications = [];
  }

  // Filtrar notificações do usuário
  const userNotifications = db.notifications
    .filter(n => n.userId === userId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)); // Mais recentes primeiro

  // Contar não lidas
  const unreadCount = userNotifications.filter(n => !n.read).length;

  res.json({
    notifications: userNotifications,
    unreadCount
  });
});

// Marcar notificação como lida
app.patch('/api/users/:userId/notifications/:notificationId/read', async (req, res) => {
  const db = await readDB();
  const { userId, notificationId } = req.params;

  if (!db.notifications) {
    db.notifications = [];
  }

  const notificationIndex = db.notifications.findIndex(
    n => n.id === notificationId && n.userId === userId
  );

  if (notificationIndex === -1) {
    return res.status(404).json({ error: 'Notificação não encontrada' });
  }

  db.notifications[notificationIndex].read = true;
  db.notifications[notificationIndex].readAt = new Date().toISOString();

  writeDB(db);

  res.json({
    success: true,
    notification: db.notifications[notificationIndex]
  });
});

// Marcar todas as notificações como lidas
app.post('/api/users/:userId/notifications/mark-all-read', async (req, res) => {
  const db = await readDB();
  const { userId } = req.params;

  if (!db.notifications) {
    db.notifications = [];
  }

  let markedCount = 0;
  const now = new Date().toISOString();

  db.notifications.forEach(notification => {
    if (notification.userId === userId && !notification.read) {
      notification.read = true;
      notification.readAt = now;
      markedCount++;
    }
  });

  writeDB(db);

  const unreadCount = db.notifications.filter(
    n => n.userId === userId && !n.read
  ).length;

  res.json({
    success: true,
    markedCount,
    unreadCount
  });
});

// Buscar configurações de notificações
app.get('/api/users/:userId/notification-settings', async (req, res) => {
  const db = await readDB();
  const { userId } = req.params;

  if (!db.notificationSettings) {
    db.notificationSettings = [];
  }

  let settings = db.notificationSettings.find(s => s.userId === userId);

  // Configurações padrão se não existir
  if (!settings) {
    settings = {
      userId,
      email: {
        sales: true,
        commissions: true,
        products: true,
        documents: true,
        withdrawals: true,
        platformMessages: true,
        accountUpdates: true,
        newsletter: false,
        tips: false
      },
      web: {
        enabled: true,
        sound: true,
        desktop: false,
        vibration: false
      },
      frequency: 'realtime', // 'realtime', 'daily', 'weekly'
      doNotDisturb: {
        enabled: false,
        startTime: '22:00',
        endTime: '08:00'
      }
    };
  }

  res.json(settings);
});

// Atualizar configurações de notificações
app.patch('/api/users/:userId/notification-settings', async (req, res) => {
  const db = await readDB();
  const { userId } = req.params;
  const updates = req.body;

  if (!db.notificationSettings) {
    db.notificationSettings = [];
  }

  const settingsIndex = db.notificationSettings.findIndex(s => s.userId === userId);

  if (settingsIndex === -1) {
    // Criar novo
    const newSettings = {
      userId,
      email: {
        sales: true,
        commissions: true,
        products: true,
        documents: true,
        withdrawals: true,
        platformMessages: true,
        accountUpdates: true,
        newsletter: false,
        tips: false
      },
      web: {
        enabled: true,
        sound: true,
        desktop: false,
        vibration: false
      },
      frequency: 'realtime',
      doNotDisturb: {
        enabled: false,
        startTime: '22:00',
        endTime: '08:00'
      },
      ...updates,
      updatedAt: new Date().toISOString()
    };
    db.notificationSettings.push(newSettings);
    writeDB(db);
    return res.json({ success: true, settings: newSettings });
  }

  // Atualizar existente (merge profundo)
  if (updates.email) {
    db.notificationSettings[settingsIndex].email = {
      ...db.notificationSettings[settingsIndex].email,
      ...updates.email
    };
  }
  if (updates.web) {
    db.notificationSettings[settingsIndex].web = {
      ...db.notificationSettings[settingsIndex].web,
      ...updates.web
    };
  }
  if (updates.frequency) {
    db.notificationSettings[settingsIndex].frequency = updates.frequency;
  }
  if (updates.doNotDisturb) {
    db.notificationSettings[settingsIndex].doNotDisturb = {
      ...db.notificationSettings[settingsIndex].doNotDisturb,
      ...updates.doNotDisturb
    };
  }

  db.notificationSettings[settingsIndex].updatedAt = new Date().toISOString();

  writeDB(db);

  res.json({
    success: true,
    settings: db.notificationSettings[settingsIndex]
  });
});

// Função helper para criar notificação (será usada por outras rotas)
function createNotification(userId, type, title, message, metadata = {}) {
  const db = await readDB();

  if (!db.notifications) {
    db.notifications = [];
  }

  const notification = {
    id: `notif-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    userId,
    type,
    title,
    message,
    read: false,
    readAt: null,
    important: metadata.important || false,
    createdAt: new Date().toISOString(),
    metadata: metadata.data || {},
    actionButton: metadata.actionButton || null
  };

  db.notifications.push(notification);
  writeDB(db);

  return notification;
}

// Exportar função para uso em outras rotas
global.createNotification = createNotification;

// Dashboard Stats
app.get('/api/dashboard/stats', async (req, res) => {
  const db = await readDB();
  const { userId, role } = req.query;

  let orders = db.orders;

  // Filtrar pedidos por usuário se não for admin
  if (userId && role !== 'admin') {
    orders = orders.filter(o =>
      o.producerId === userId || o.affiliateId === userId
    );
  }

  const stats = {
    totalOrders: orders.length,
    pendingOrders: orders.filter(o => o.status === 'pending').length,
    shippedOrders: orders.filter(o => o.shippingInfo?.shippingStatus === 'shipped').length,
    deliveredOrders: orders.filter(o => o.status === 'delivered').length,
    paidOrders: orders.filter(o => o.paymentStatus === 'paid').length,
    totalRevenue: orders
      .filter(o => o.paymentStatus === 'paid')
      .reduce((sum, o) => sum + o.totalValue, 0),
    pendingRevenue: orders
      .filter(o => o.paymentStatus === 'pending' || o.paymentStatus === 'pending_delivery')
      .reduce((sum, o) => sum + o.totalValue, 0)
  };

  // Se for produtor ou afiliado, calcular comissões
  if (userId && role !== 'admin') {
    const userCommissions = db.commissions.filter(c =>
      c.producerId === userId || c.affiliateId === userId
    );

    stats.totalCommissions = userCommissions
      .filter(c => c.status === 'paid')
      .reduce((sum, c) => {
        if (c.producerId === userId) return sum + c.producerCommission;
        if (c.affiliateId === userId) return sum + c.affiliateCommission;
        return sum;
      }, 0);

    stats.pendingCommissions = userCommissions
      .filter(c => c.status === 'pending')
      .reduce((sum, c) => {
        if (c.producerId === userId) return sum + c.producerCommission;
        if (c.affiliateId === userId) return sum + c.affiliateCommission;
        return sum;
      }, 0);
  }

  res.json(stats);
});

// Endpoints específicos para AfterPay e gerenciamento de pedidos

// Adicionar código de rastreio
app.post('/api/orders/:id/tracking', async (req, res) => {
  const db = await readDB();
  const orderIndex = db.orders.findIndex(o => o.id === req.params.id);

  if (orderIndex === -1) {
    return res.status(404).json({ error: 'Pedido não encontrado' });
  }

  const { trackingCode, carrier, estimatedDelivery } = req.body;

  db.orders[orderIndex].trackingCode = trackingCode;
  db.orders[orderIndex].shippingInfo = {
    ...db.orders[orderIndex].shippingInfo,
    carrier: carrier || 'Correios',
    estimatedDelivery,
    shippingStatus: 'shipped',
    shippingDate: new Date().toISOString()
  };
  db.orders[orderIndex].updatedAt = new Date().toISOString();

  writeDB(db);
  res.json(db.orders[orderIndex]);
});

// Confirmar entrega (AfterPay)
app.post('/api/orders/:id/confirm-delivery', async (req, res) => {
  const db = await readDB();
  const orderIndex = db.orders.findIndex(o => o.id === req.params.id);

  if (orderIndex === -1) {
    return res.status(404).json({ error: 'Pedido não encontrado' });
  }

  const order = db.orders[orderIndex];

  if (order.paymentMethod !== 'afterPay') {
    return res.status(400).json({ error: 'Este endpoint é apenas para AfterPay' });
  }

  // Mudar status de AGENDADO para AGUARDANDO PAGAMENTO
  db.orders[orderIndex].paymentStatus = 'pending_payment';
  db.orders[orderIndex].deliveryConfirmedAt = new Date().toISOString();
  db.orders[orderIndex].updatedAt = new Date().toISOString();

  // Adicionar evento de entrega no rastreamento
  if (!db.orders[orderIndex].trackingHistory) {
    db.orders[orderIndex].trackingHistory = [];
  }

  const deliveryEvent = {
    id: uuidv4(),
    status: 'Entregue',
    location: order.shippingAddress ? `${order.shippingAddress.city || ''} - ${order.shippingAddress.state || ''}`.trim() : 'Local de entrega',
    date: new Date().toISOString(),
    description: 'Objeto entregue ao destinatário',
    receivedAt: new Date().toISOString(),
    source: 'confirmacao_manual',
    confirmedBy: 'producer'
  };

  db.orders[orderIndex].trackingHistory.unshift(deliveryEvent);
  console.log(`📦 Evento de entrega adicionado ao rastreamento do pedido ${order.id}`);

  writeDB(db);

  // Disparar webhook de pedido entregue
  dispararWebhookPortugues(order.producerId, 'pedidoEntregue', db.orders[orderIndex]);

  res.json(db.orders[orderIndex]);
});

// Cancelar venda (AGENDADO)
app.post('/api/orders/:id/cancel', async (req, res) => {
  const db = await readDB();
  const orderIndex = db.orders.findIndex(o => o.id === req.params.id);

  if (orderIndex === -1) {
    return res.status(404).json({ error: 'Pedido não encontrado' });
  }

  const order = db.orders[orderIndex];

  if (order.paymentMethod === 'afterPay' && order.paymentStatus !== 'scheduled') {
    return res.status(400).json({ error: 'Apenas pedidos AGENDADO podem ser cancelados diretamente' });
  }

  db.orders[orderIndex].paymentStatus = 'cancelled';
  db.orders[orderIndex].cancelledAt = new Date().toISOString();
  db.orders[orderIndex].updatedAt = new Date().toISOString();

  // Liberar CPF bloqueado
  if (order.customer.cpf && order.paymentMethod === 'afterPay') {
    const blockedCpfIndex = db.blockedCpfs?.findIndex(b => b.cpf === order.customer.cpf && b.orderId === order.id);
    if (blockedCpfIndex !== -1) {
      db.blockedCpfs.splice(blockedCpfIndex, 1);
    }
  }

  writeDB(db);

  // Disparar webhook de cancelamento
  dispararWebhookPortugues(order.producerId, 'cancelada', db.orders[orderIndex]);

  res.json(db.orders[orderIndex]);
});

// Solicitar cancelamento (FRUSTRADO - requer aprovação admin)
app.post('/api/orders/:id/request-cancellation', async (req, res) => {
  const db = await readDB();
  const orderIndex = db.orders.findIndex(o => o.id === req.params.id);

  if (orderIndex === -1) {
    return res.status(404).json({ error: 'Pedido não encontrado' });
  }

  const { reason } = req.body;

  if (!reason || reason.length < 20) {
    return res.status(400).json({ error: 'Justificativa deve ter no mínimo 20 caracteres' });
  }

  if (!db.cancellationRequests) {
    db.cancellationRequests = [];
  }

  const request = {
    id: uuidv4(),
    orderId: req.params.id,
    orderCode: db.orders[orderIndex].id,
    productName: db.orders[orderIndex].productName,
    customerName: db.orders[orderIndex].customer.name,
    reason,
    status: 'pending', // pending, approved, rejected
    requestedAt: new Date().toISOString(),
    requestedBy: db.orders[orderIndex].producerId
  };

  db.cancellationRequests.push(request);
  db.orders[orderIndex].cancellationRequested = true;
  db.orders[orderIndex].updatedAt = new Date().toISOString();

  writeDB(db);
  res.json(request);
});

// Solicitar estorno (PAGO - requer aprovação admin)
app.post('/api/orders/:id/request-refund', async (req, res) => {
  const db = await readDB();
  const orderIndex = db.orders.findIndex(o => o.id === req.params.id);

  if (orderIndex === -1) {
    return res.status(404).json({ error: 'Pedido não encontrado' });
  }

  const order = db.orders[orderIndex];

  if (order.paymentStatus !== 'paid') {
    return res.status(400).json({ error: 'Apenas pedidos PAGO podem solicitar estorno' });
  }

  const { reason } = req.body;

  if (!reason || reason.length < 20) {
    return res.status(400).json({ error: 'Justificativa deve ter no mínimo 20 caracteres' });
  }

  if (!db.refundRequests) {
    db.refundRequests = [];
  }

  const request = {
    id: uuidv4(),
    orderId: req.params.id,
    orderCode: order.id,
    productName: order.productName,
    customerName: order.customer.name,
    paymentMethod: order.paymentMethod,
    totalValue: order.totalValue,
    reason,
    status: 'pending', // pending, approved, rejected
    requestedAt: new Date().toISOString(),
    requestedBy: order.producerId
  };

  db.refundRequests.push(request);
  db.orders[orderIndex].refundRequested = true;
  db.orders[orderIndex].updatedAt = new Date().toISOString();

  writeDB(db);
  res.json(request);
});

// Alterar data de vencimento do boleto
app.post('/api/orders/:id/update-boleto', async (req, res) => {
  const db = await readDB();
  const orderIndex = db.orders.findIndex(o => o.id === req.params.id);

  if (orderIndex === -1) {
    return res.status(404).json({ error: 'Pedido não encontrado' });
  }

  const order = db.orders[orderIndex];

  if (order.paymentMethod !== 'boleto') {
    return res.status(400).json({ error: 'Este endpoint é apenas para Boleto' });
  }

  const { newDueDate } = req.body;

  // Simular geração de novo boleto
  db.orders[orderIndex].boletoInfo = {
    ...db.orders[orderIndex].boletoInfo,
    dueDate: newDueDate,
    boletoCode: `${Date.now()}${Math.random().toString(36).substr(2, 9)}`,
    updatedAt: new Date().toISOString()
  };
  db.orders[orderIndex].updatedAt = new Date().toISOString();

  writeDB(db);
  res.json(db.orders[orderIndex]);
});

// Atualizar telefone do cliente de um pedido
app.patch('/api/orders/:id/update-phone', async (req, res) => {
  const db = await readDB();
  const orderIndex = db.orders.findIndex(o => o.id === req.params.id);

  if (orderIndex === -1) {
    return res.status(404).json({ error: 'Pedido não encontrado' });
  }

  const { phone } = req.body;

  if (!phone || phone.trim().length < 10) {
    return res.status(400).json({ error: 'Telefone inválido' });
  }

  // Atualizar telefone do cliente no pedido
  db.orders[orderIndex].customer.phone = phone.trim();
  db.orders[orderIndex].updatedAt = new Date().toISOString();

  writeDB(db);

  console.log(`📞 [UPDATE PHONE] Pedido ${req.params.id} - Telefone atualizado: ${phone}`);

  res.json({
    success: true,
    message: 'Telefone atualizado com sucesso',
    order: db.orders[orderIndex]
  });
});

// ========== ROTA DE ALTERAÇÃO DE SENHA ==========

// Alterar senha do usuário
app.post('/api/users/:userId/change-password', async (req, res) => {
  try {
    const { userId } = req.params;
    const { currentPassword, newPassword } = req.body;
    const db = await readDB();

    // Validações básicas
    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Senha atual e nova senha são obrigatórias'
      });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({
        success: false,
        message: 'A nova senha deve ter pelo menos 8 caracteres'
      });
    }

    // Buscar usuário
    const userIndex = db.users.findIndex(u => u.id === userId);
    if (userIndex === -1) {
      return res.status(404).json({
        success: false,
        message: 'Usuário não encontrado'
      });
    }

    const user = db.users[userIndex];

    // Verificar senha atual
    // NOTA: Em produção, você deve usar bcrypt para comparar hashes
    // Por enquanto, comparação direta (assumindo que senha está em texto plano no banco mock)
    if (user.password !== currentPassword) {
      return res.status(401).json({
        success: false,
        message: 'Senha atual incorreta'
      });
    }

    // Atualizar senha
    db.users[userIndex].password = newPassword;
    db.users[userIndex].passwordChangedAt = new Date().toISOString();

    writeDB(db);

    res.json({
      success: true,
      message: 'Senha alterada com sucesso'
    });
  } catch (error) {
    console.error('Erro ao alterar senha:', error);
    res.status(500).json({
      success: false,
      message: 'Erro ao alterar senha'
    });
  }
});

// ========== FIM DA ROTA DE ALTERAÇÃO DE SENHA ==========

// ========== ROTA DE ATUALIZAÇÃO DE PERFIL ==========

// Atualizar dados do usuário
app.patch('/api/users/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const updates = req.body;
    const db = await readDB();

    // Buscar usuário
    const userIndex = db.users.findIndex(u => u.id === userId);
    if (userIndex === -1) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    // Campos que podem ser atualizados
    const allowedFields = ['name', 'phone', 'cpf', 'birthDate', 'address'];

    // Atualizar apenas campos permitidos
    allowedFields.forEach(field => {
      if (updates[field] !== undefined) {
        db.users[userIndex][field] = updates[field];
      }
    });

    db.users[userIndex].updatedAt = new Date().toISOString();

    writeDB(db);

    // Retornar usuário atualizado (sem a senha)
    const { password, ...userWithoutPassword } = db.users[userIndex];

    res.json({
      success: true,
      message: 'Perfil atualizado com sucesso',
      user: userWithoutPassword
    });
  } catch (error) {
    console.error('Erro ao atualizar perfil:', error);
    res.status(500).json({
      success: false,
      error: 'Erro ao atualizar perfil'
    });
  }
});

// ========== FIM DA ROTA DE ATUALIZAÇÃO DE PERFIL ==========

// ========== SISTEMA DE GERENTES COM COMISSÕES ==========

// Buscar usuários para serem gerentes (busca por email)
app.get('/api/users/search-managers', async (req, res) => {
  try {
    const { email, productId } = req.query;
    const db = await readDB();

    if (!email || email.length < 3) {
      return res.json({ users: [] });
    }

    // Buscar usuários que correspondem ao email
    const searchEmail = email.toLowerCase();
    let matchingUsers = db.users.filter(u =>
      u.email && u.email.toLowerCase().includes(searchEmail)
    );

    // Para cada usuário, verificar se pode ser gerente
    const usersWithStatus = matchingUsers.map(user => {
      // Validações
      const hasDocuments = user.documentValidation?.status === 'approved';
      const hasBankAccount = !!user.bankAccount?.bankCode;
      const hasRecipient = !!user.pagarme?.recipientId && user.pagarme?.recipientStatus === 'active';

      const canBeManager = hasDocuments && hasBankAccount && hasRecipient;

      return {
        id: user.id,
        name: user.name,
        email: user.email,
        canBeManager,
        recipientId: user.pagarme?.recipientId || null,
        documentStatus: user.documentValidation?.status || 'pending',
        bankAccountValid: hasBankAccount,
        missingRequirements: [
          ...(!hasDocuments ? ['Documentos não aprovados'] : []),
          ...(!hasBankAccount ? ['Dados bancários não cadastrados'] : []),
          ...(!hasRecipient ? ['Split não cadastrado'] : [])
        ]
      };
    });

    // Limitar a 10 resultados
    const limitedResults = usersWithStatus.slice(0, 10);

    res.json({ users: limitedResults });
  } catch (error) {
    console.error('Erro ao buscar gerentes:', error);
    res.status(500).json({ error: 'Erro ao buscar gerentes' });
  }
});

// Verificar se usuário pode ser gerente
app.get('/api/users/:userId/can-be-manager', async (req, res) => {
  try {
    const { userId } = req.params;
    const db = await readDB();

    const user = db.users.find(u => u.id === userId);

    if (!user) {
      return res.status(404).json({
        canBeManager: false,
        reason: 'Usuário não encontrado'
      });
    }

    // Validações obrigatórias
    const validations = {
      hasAccount: !!user.id,
      documentApproved: user.documentValidation?.status === 'approved',
      hasBankAccount: !!user.bankAccount?.bankCode,
      hasRecipient: !!user.pagarme?.recipientId && user.pagarme?.recipientStatus === 'active'
    };

    const canBeManager = Object.values(validations).every(v => v === true);

    // Identificar o que falta
    const missingRequirements = [];
    if (!validations.documentApproved) missingRequirements.push('Documentos não aprovados');
    if (!validations.hasBankAccount) missingRequirements.push('Dados bancários não cadastrados');
    if (!validations.hasRecipient) missingRequirements.push('Recipient não criado no Pagar.me');

    res.json({
      canBeManager,
      validations,
      missingRequirements,
      recipientId: user.pagarme?.recipientId || null,
      user: {
        id: user.id,
        name: user.name,
        email: user.email
      }
    });
  } catch (error) {
    console.error('Erro ao validar gerente:', error);
    res.status(500).json({ error: 'Erro ao validar gerente' });
  }
});

// ========== FIM DOS ENDPOINTS DE BUSCA E VALIDAÇÃO ==========

// Criar/Cadastrar gerente
app.post('/api/managers', async (req, res) => {
  try {
    const { userId, productId, commissionConfig } = req.body;
    const db = await readDB();

    // Validar campos obrigatórios
    if (!userId || !productId || !commissionConfig) {
      return res.status(400).json({ error: 'Campos obrigatórios faltando' });
    }

    // Verificar se usuário pode ser gerente
    const user = db.users.find(u => u.id === userId);
    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    const canBeManager =
      user.documentValidation?.status === 'approved' &&
      !!user.bankAccount?.bankCode &&
      !!user.pagarme?.recipientId &&
      user.pagarme?.recipientStatus === 'active';

    if (!canBeManager) {
      return res.status(400).json({
        error: 'Usuário não possui requisitos para ser gerente',
        details: 'Verifique documentos, dados bancários e recipient'
      });
    }

    // Verificar se gerente já existe para este produto
    if (!db.managers) db.managers = [];

    const existingManager = db.managers.find(
      m => m.userId === userId && m.productId === productId && m.status === 'active'
    );

    if (existingManager) {
      return res.status(400).json({ error: 'Este usuário já é gerente deste produto' });
    }

    // Criar novo gerente
    const newManager = {
      id: `mgr_${uuidv4()}`,
      userId,
      productId,
      userName: user.name,
      userEmail: user.email,
      pagarmeRecipientId: user.pagarme.recipientId,
      commissionType: commissionConfig.type || 'percentage',
      withAffiliateRate: parseFloat(commissionConfig.withAffiliateRate) || 0,
      withoutAffiliateRate: parseFloat(commissionConfig.withoutAffiliateRate) || 0,
      scope: commissionConfig.scope || 'all',
      affiliateIds: commissionConfig.affiliateIds || [],
      stats: {
        totalSales: 0,
        totalCommission: 0,
        affiliatesCount: 0
      },
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    db.managers.push(newManager);
    writeDB(db);

    res.json(newManager);
  } catch (error) {
    console.error('Erro ao criar gerente:', error);
    res.status(500).json({ error: 'Erro ao criar gerente' });
  }
});

// Listar gerentes de um produto
app.get('/api/products/:productId/managers', async (req, res) => {
  try {
    const { productId } = req.params;
    const db = await readDB();

    if (!db.managers) {
      return res.json([]);
    }

    const productManagers = db.managers.filter(
      m => m.productId === productId && m.status === 'active'
    );

    // Enriquecer com dados do usuário e normalizar estrutura
    const enrichedManagers = productManagers.map(manager => {
      const user = db.users.find(u => u.id === manager.userId);

      // Normalizar estrutura de comissão (compatibilidade)
      const config = manager.commissionConfig || {};

      return {
        ...manager,
        userName: user?.name || 'Usuário',
        userEmail: user?.email || '',
        // Propriedades compatíveis com frontend
        commissionType: config.type || manager.commissionType || 'percentage',
        withAffiliateRate: parseFloat(config.withAffiliateRate || config.withAffiliate || 0),
        withoutAffiliateRate: parseFloat(config.withoutAffiliateRate || config.withoutAffiliate || 0),
        scope: config.scope || manager.scope || 'all',
        affiliateIds: config.affiliateIds || manager.affiliateIds || []
      };
    });

    res.json(enrichedManagers);
  } catch (error) {
    console.error('Erro ao listar gerentes:', error);
    res.status(500).json({ error: 'Erro ao listar gerentes' });
  }
});

// Listar afiliados de um produto
app.get('/api/products/:productId/affiliates', async (req, res) => {
  try {
    const { productId } = req.params;
    const db = await readDB();

    // Buscar afiliações ativas deste produto
    const affiliations = (db.affiliations || []).filter(
      aff => aff.productId === productId && aff.status === 'active'
    );

    // Enriquecer com dados do usuário
    const affiliates = affiliations.map(aff => {
      const user = db.users.find(u => u.id === aff.affiliateId);
      return {
        id: aff.affiliateId,
        name: user?.name || 'Afiliado',
        email: user?.email || '',
        status: aff.status
      };
    });

    res.json(affiliates);
  } catch (error) {
    console.error('Erro ao listar afiliados:', error);
    res.status(500).json({ error: 'Erro ao listar afiliados' });
  }
});

// Atualizar gerente
app.patch('/api/managers/:managerId', async (req, res) => {
  try {
    const { managerId } = req.params;
    const commissionConfig = req.body;
    const db = await readDB();

    if (!db.managers) {
      return res.status(404).json({ error: 'Gerente não encontrado' });
    }

    const managerIndex = db.managers.findIndex(m => m.id === managerId);

    if (managerIndex === -1) {
      return res.status(404).json({ error: 'Gerente não encontrado' });
    }

    // Atualizar configuração de comissões (estrutura normalizada)
    if (commissionConfig) {
      // Atualizar as propriedades diretamente na raiz do objeto
      if (commissionConfig.type) {
        db.managers[managerIndex].commissionType = commissionConfig.type;
      }
      if (commissionConfig.withAffiliateRate !== undefined) {
        db.managers[managerIndex].withAffiliateRate = parseFloat(commissionConfig.withAffiliateRate) || 0;
      }
      if (commissionConfig.withoutAffiliateRate !== undefined) {
        db.managers[managerIndex].withoutAffiliateRate = parseFloat(commissionConfig.withoutAffiliateRate) || 0;
      }
      if (commissionConfig.scope) {
        db.managers[managerIndex].scope = commissionConfig.scope;
      }
      if (commissionConfig.affiliateIds !== undefined) {
        db.managers[managerIndex].affiliateIds = commissionConfig.affiliateIds;
      }
    }

    db.managers[managerIndex].updatedAt = new Date().toISOString();

    writeDB(db);
    res.json(db.managers[managerIndex]);
  } catch (error) {
    console.error('Erro ao atualizar gerente:', error);
    res.status(500).json({ error: 'Erro ao atualizar gerente' });
  }
});

// Desativar gerente
app.delete('/api/managers/:managerId', async (req, res) => {
  try {
    const { managerId } = req.params;
    const db = await readDB();

    if (!db.managers) {
      return res.status(404).json({ error: 'Gerente não encontrado' });
    }

    const managerIndex = db.managers.findIndex(m => m.id === managerId);

    if (managerIndex === -1) {
      return res.status(404).json({ error: 'Gerente não encontrado' });
    }

    // Não deletar, apenas desativar
    db.managers[managerIndex].status = 'inactive';
    db.managers[managerIndex].deactivatedAt = new Date().toISOString();

    writeDB(db);
    res.json({ success: true, message: 'Gerente desativado com sucesso' });
  } catch (error) {
    console.error('Erro ao desativar gerente:', error);
    res.status(500).json({ error: 'Erro ao desativar gerente' });
  }
});

// ========== FIM DOS ENDPOINTS DE GERENTE ==========

// ========== ENDPOINT: BUSCAR COMISSÕES DE UM PEDIDO ==========
app.get('/api/orders/:orderId/commissions', async (req, res) => {
  try {
    const { orderId } = req.params;
    const db = await readDB();

    // Buscar todas as comissões deste pedido
    const commissions = (db.orderCommissions || [])
      .filter(c => c.orderId === orderId)
      .sort((a, b) => a.order - b.order); // Ordenar pela ordem correta (1, 2, 3, 4...)

    // Enriquecer com dados dos usuários
    const enrichedCommissions = commissions.map(comm => {
      let userName = '';
      let userEmail = '';

      if (comm.type === 'platform') {
        userName = 'Plataforma';
        userEmail = 'plataforma@afterpay.com';
      } else if (comm.userId) {
        const user = db.users.find(u => u.id === comm.userId);
        userName = user?.name || 'Desconhecido';
        userEmail = user?.email || '';
      }

      return {
        ...comm,
        userName,
        userEmail
      };
    });

    res.json({
      orderId,
      commissions: enrichedCommissions,
      total: commissions.length
    });
  } catch (error) {
    console.error('Erro ao buscar comissões:', error);
    res.status(500).json({ error: 'Erro ao buscar comissões' });
  }
});

// ========== FIM DO ENDPOINT DE COMISSÕES ==========

// Validar CPF bloqueado
app.post('/api/checkout/validate-cpf', async (req, res) => {
  const db = await readDB();
  const { cpf, paymentMethod } = req.body;

  // Se não for AfterPay, não valida bloqueio
  if (paymentMethod !== 'afterPay') {
    return res.json({ blocked: false });
  }

  if (!db.blockedCpfs) {
    db.blockedCpfs = [];
  }

  // Verificar se CPF está bloqueado
  const blockedCpf = db.blockedCpfs.find(b => b.cpf === cpf);

  if (blockedCpf) {
    const order = db.orders.find(o => o.id === blockedCpf.orderId);
    return res.json({
      blocked: true,
      status: order?.paymentStatus,
      orderId: order?.id
    });
  }

  res.json({ blocked: false });
});

// Bloquear CPF (chamado ao criar pedido AfterPay)
app.post('/api/checkout/block-cpf', async (req, res) => {
  const db = await readDB();
  const { cpf, orderId } = req.body;

  if (!db.blockedCpfs) {
    db.blockedCpfs = [];
  }

  // Adicionar bloqueio temporário (será associado ao pedido depois)
  db.blockedCpfs.push({
    id: uuidv4(),
    cpf,
    orderId: orderId || 'pending',
    blockedAt: new Date().toISOString()
  });

  writeDB(db);
  res.json({ success: true });
});

// ========== ROTAS DE RASTREAMENTO DE ABANDONOS ==========

// Criar/Atualizar rastreamento de checkout abandonado
app.post('/api/checkout/track', async (req, res) => {
  try {
    const db = await readDB();
    const { productId, customer, step, value, sessionId } = req.body;

    if (!db.abandonedCheckouts) {
      db.abandonedCheckouts = [];
    }

    // Buscar se já existe um rastreamento para esta sessão
    const existingIndex = db.abandonedCheckouts.findIndex(
      a => a.sessionId === sessionId && a.status === 'active'
    );

    if (existingIndex !== -1) {
      // Atualizar rastreamento existente
      db.abandonedCheckouts[existingIndex] = {
        ...db.abandonedCheckouts[existingIndex],
        customer,
        step,
        value,
        lastActivityAt: new Date().toISOString()
      };
    } else {
      // Criar novo rastreamento
      const product = db.products.find(p => p.id === productId);

      db.abandonedCheckouts.push({
        id: uuidv4(),
        sessionId,
        productId,
        productName: product?.name || 'Produto não encontrado',
        customer,
        step,
        value,
        status: 'active', // active, converted, abandoned
        createdAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        abandonedAt: null,
        reminderSent: false,
        userId: product?.userId || null
      });
    }

    writeDB(db);
    res.json({ success: true });
  } catch (error) {
    console.error('Erro ao rastrear checkout:', error);
    res.status(500).json({ error: 'Erro ao rastrear checkout' });
  }
});

// Marcar checkout como convertido (quando finaliza compra)
app.post('/api/checkout/track/:sessionId/convert', async (req, res) => {
  try {
    const db = await readDB();
    const { sessionId } = req.params;

    if (!db.abandonedCheckouts) {
      return res.json({ success: true });
    }

    const checkoutIndex = db.abandonedCheckouts.findIndex(
      a => a.sessionId === sessionId && a.status === 'active'
    );

    if (checkoutIndex !== -1) {
      db.abandonedCheckouts[checkoutIndex].status = 'converted';
      db.abandonedCheckouts[checkoutIndex].convertedAt = new Date().toISOString();
      writeDB(db);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Erro ao marcar conversão:', error);
    res.status(500).json({ error: 'Erro ao marcar conversão' });
  }
});

// Buscar carrinhos abandonados (para página de Abandonos)
app.get('/api/reports/abandoned', async (req, res) => {
  try {
    const db = await readDB();
    const userId = req.query.userId;

    if (!db.abandonedCheckouts) {
      return res.json({
        abandoned: [],
        stats: {
          totalValue: 0,
          totalCount: 0,
          abandonmentRate: 0
        }
      });
    }

    // Filtrar apenas abandonos do usuário atual
    let userAbandoned = db.abandonedCheckouts.filter(a => {
      if (userId && a.userId !== userId) return false;
      return a.status === 'abandoned';
    });

    // Ordenar por data mais recente
    userAbandoned.sort((a, b) => new Date(b.abandonedAt) - new Date(a.abandonedAt));

    // Calcular estatísticas
    const totalValue = userAbandoned.reduce((sum, a) => sum + (a.value || 0), 0);
    const totalCount = userAbandoned.length;

    // Calcular taxa de abandono (abandonados vs convertidos nos últimos 30 dias)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const recentCheckouts = db.abandonedCheckouts.filter(a => {
      if (userId && a.userId !== userId) return false;
      const createdDate = new Date(a.createdAt);
      return createdDate >= thirtyDaysAgo;
    });

    const recentAbandoned = recentCheckouts.filter(a => a.status === 'abandoned').length;
    const recentConverted = recentCheckouts.filter(a => a.status === 'converted').length;
    const totalRecent = recentAbandoned + recentConverted;
    const abandonmentRate = totalRecent > 0 ? (recentAbandoned / totalRecent) * 100 : 0;

    res.json({
      abandoned: userAbandoned,
      stats: {
        totalValue,
        totalCount,
        abandonmentRate
      }
    });
  } catch (error) {
    console.error('Erro ao buscar abandonos:', error);
    res.status(500).json({ error: 'Erro ao buscar abandonos' });
  }
});

// Enviar lembrete de carrinho abandonado
app.post('/api/abandoned/:id/reminder', async (req, res) => {
  try {
    const db = await readDB();
    const { id } = req.params;

    if (!db.abandonedCheckouts) {
      return res.status(404).json({ error: 'Abandono não encontrado' });
    }

    const abandonedIndex = db.abandonedCheckouts.findIndex(a => a.id === id);

    if (abandonedIndex === -1) {
      return res.status(404).json({ error: 'Abandono não encontrado' });
    }

    // Marcar lembrete como enviado
    db.abandonedCheckouts[abandonedIndex].reminderSent = true;
    db.abandonedCheckouts[abandonedIndex].reminderSentAt = new Date().toISOString();

    writeDB(db);

    // Aqui você pode adicionar lógica para enviar email real
    // Por enquanto, apenas marcamos como enviado
    console.log(`📧 Lembrete enviado para: ${db.abandonedCheckouts[abandonedIndex].customer?.email}`);

    res.json({ success: true, message: 'Lembrete enviado com sucesso' });
  } catch (error) {
    console.error('Erro ao enviar lembrete:', error);
    res.status(500).json({ error: 'Erro ao enviar lembrete' });
  }
});

// ========== FIM DAS ROTAS DE ABANDONOS ==========

// ========== RELATÓRIO DE CHURN RATE ==========

// GET /api/reports/churn - Calcular churn rate baseado em dados reais
app.get('/api/reports/churn', async (req, res) => {
  try {
    const db = await readDB();
    const userId = req.query.userId;

    // Pegar todos os usuários
    const allUsers = db.users || [];

    // Filtrar por userId se fornecido
    const users = userId
      ? allUsers.filter(u => u.id === userId)
      : allUsers;

    // Calcular período de análise (últimos 12 meses)
    const now = new Date();
    const monthlyData = [];

    for (let i = 11; i >= 0; i--) {
      const monthDate = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const nextMonthDate = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);

      // Usuários que existiam no início do mês
      const startOfMonth = users.filter(u => {
        const createdAt = new Date(u.createdAt);
        return createdAt < monthDate;
      }).length;

      // Usuários que foram criados neste mês
      const newUsers = users.filter(u => {
        const createdAt = new Date(u.createdAt);
        return createdAt >= monthDate && createdAt < nextMonthDate;
      }).length;

      // Simular churn (usuários que pararam de usar) - em produção, isso viria de logs de atividade
      // Por ora, vamos calcular baseado em última atividade ou última compra
      let churnedUsers = 0;

      // Se temos dados de orders, podemos usar para calcular churn real
      if (db.orders && db.orders.length > 0) {
        const usersWithOrders = users.filter(u => {
          const userOrders = db.orders.filter(o => o.userId === u.id);
          if (userOrders.length === 0) return false;

          // Pegar última order do usuário
          const lastOrder = userOrders.sort((a, b) =>
            new Date(b.createdAt) - new Date(a.createdAt)
          )[0];

          const lastOrderDate = new Date(lastOrder.createdAt);

          // Consideramos churn se última compra foi há mais de 60 dias antes do início do mês
          const sixtyDaysBeforeMonth = new Date(monthDate);
          sixtyDaysBeforeMonth.setDate(sixtyDaysBeforeMonth.getDate() - 60);

          return lastOrderDate < sixtyDaysBeforeMonth;
        });

        churnedUsers = usersWithOrders.length;
      } else {
        // Sem dados de orders, usar taxa de churn padrão de 5-8%
        churnedUsers = Math.floor(startOfMonth * 0.06);
      }

      // Calcular totais
      const totalUsers = startOfMonth + newUsers - churnedUsers;
      const churnRate = startOfMonth > 0 ? (churnedUsers / startOfMonth) * 100 : 0;

      monthlyData.push({
        month: monthDate.toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' }),
        fullDate: monthDate.toISOString(),
        startOfMonth,
        newUsers,
        churnedUsers,
        totalUsers,
        churnRate: parseFloat(churnRate.toFixed(2))
      });
    }

    // Calcular estatísticas gerais
    const avgChurnRate = monthlyData.reduce((sum, m) => sum + m.churnRate, 0) / monthlyData.length;
    const totalChurned = monthlyData.reduce((sum, m) => sum + m.churnedUsers, 0);
    const totalNew = monthlyData.reduce((sum, m) => sum + m.newUsers, 0);
    const currentTotal = monthlyData[monthlyData.length - 1]?.totalUsers || 0;

    res.json({
      success: true,
      data: monthlyData,
      stats: {
        avgChurnRate: parseFloat(avgChurnRate.toFixed(2)),
        totalChurned,
        totalNew,
        currentTotal,
        netGrowth: totalNew - totalChurned
      }
    });
  } catch (error) {
    console.error('Erro ao calcular churn rate:', error);
    res.status(500).json({ error: 'Erro ao calcular churn rate' });
  }
});

// ========== FIM DO RELATÓRIO DE CHURN RATE ==========

// Webhook de pagamento (simulado)
app.post('/api/webhooks/payment', async (req, res) => {
  const db = await readDB();
  const { orderId, status } = req.body; // status: 'paid', 'failed'

  const orderIndex = db.orders.findIndex(o => o.id === orderId);
  if (orderIndex === -1) {
    return res.status(404).json({ error: 'Pedido não encontrado' });
  }

  if (status === 'paid') {
    db.orders[orderIndex].paymentStatus = 'paid';
    db.orders[orderIndex].paidAt = new Date().toISOString();
    db.orders[orderIndex].updatedAt = new Date().toISOString();

    // Liberar CPF bloqueado
    const order = db.orders[orderIndex];
    if (order.customer.cpf && order.paymentMethod === 'afterPay') {
      const blockedCpfIndex = db.blockedCpfs?.findIndex(b => b.cpf === order.customer.cpf && b.orderId === order.id);
      if (blockedCpfIndex !== -1) {
        db.blockedCpfs.splice(blockedCpfIndex, 1);
      }
    }

    // ✅ RESETAR flag do Notazz quando pedido for pago
    // Isso permite que o cliente faça novas compras no AfterPay sem bloqueio
    // Nota: Não reenvia automaticamente - apenas libera para futuras compras
    if (db.orders[orderIndex].sentToNotazz) {
      console.log(`🔄 Pedido ${orderId} pago - resetando flag sentToNotazz para permitir futuras compras`);
      db.orders[orderIndex].sentToNotazz = false;
      db.orders[orderIndex].sentToNotazzAt = null;
    }

    // Atualizar comissão
    const commissionIndex = db.commissions.findIndex(c => c.orderId === orderId);
    if (commissionIndex !== -1) {
      db.commissions[commissionIndex].status = 'paid';
      db.commissions[commissionIndex].paidAt = new Date().toISOString();
    }
  }

  writeDB(db);
  res.json({ success: true });
});

// Webhook de rastreio Correios (simulado)
app.post('/api/webhooks/tracking', async (req, res) => {
  const db = await readDB();
  const { trackingCode, status, location, date } = req.body;

  const orderIndex = db.orders.findIndex(o => o.trackingCode === trackingCode);
  if (orderIndex === -1) {
    return res.status(404).json({ error: 'Pedido não encontrado' });
  }

  if (!db.orders[orderIndex].trackingHistory) {
    db.orders[orderIndex].trackingHistory = [];
  }

  db.orders[orderIndex].trackingHistory.push({
    status,
    location,
    date: date || new Date().toISOString()
  });

  db.orders[orderIndex].updatedAt = new Date().toISOString();

  writeDB(db);
  res.json({ success: true });
});

// Jobs automáticos com cron

// Job de rastreio Correios - a cada 15 minutos
cron.schedule('*/15 * * * *', () => {
  console.log('🚚 Executando job de rastreio Correios...');
  const db = await readDB();

  const ordersWithTracking = db.orders.filter(o =>
    o.trackingCode &&
    o.paymentStatus !== 'delivered' &&
    o.paymentStatus !== 'cancelled'
  );

  ordersWithTracking.forEach(order => {
    // Aqui você faria a chamada real para a API dos Correios
    // Por enquanto, apenas log
    console.log(`  Rastreando: ${order.trackingCode}`);
  });
});

// Job de verificação de pagamento - a cada 5 minutos (fallback)
cron.schedule('*/5 * * * *', () => {
  console.log('💰 Executando job de verificação de pagamento...');
  const db = await readDB();

  const pendingOrders = db.orders.filter(o =>
    o.paymentStatus === 'pending' ||
    o.paymentStatus === 'pending_payment'
  );

  pendingOrders.forEach(order => {
    // Aqui você faria a chamada real para a API do banco
    // Por enquanto, apenas log
    console.log(`  Verificando pagamento: ${order.id}`);
  });
});

// Job de verificação de atraso AfterPay - diariamente às 00:00
cron.schedule('0 0 * * *', () => {
  console.log('⏰ Executando job de verificação de atraso AfterPay...');
  const db = await readDB();
  let updated = false;

  const afterPayOrders = db.orders.filter(o =>
    o.paymentMethod === 'afterPay' &&
    (o.paymentStatus === 'pending_payment' || o.paymentStatus === 'overdue')
  );

  afterPayOrders.forEach(order => {
    if (!order.deliveryConfirmedAt) return;

    const daysSinceDelivery = Math.floor(
      (Date.now() - new Date(order.deliveryConfirmedAt).getTime()) / (1000 * 60 * 60 * 24)
    );

    const orderIndex = db.orders.findIndex(o => o.id === order.id);

    // AGUARDANDO PAGAMENTO → ATRASADO (3 dias)
    if (order.paymentStatus === 'pending_payment' && daysSinceDelivery >= 3) {
      db.orders[orderIndex].paymentStatus = 'overdue';
      db.orders[orderIndex].updatedAt = new Date().toISOString();
      console.log(`  Pedido ${order.id} marcado como ATRASADO`);
      updated = true;
    }

    // ATRASADO → FRUSTRADO (7 dias)
    if (order.paymentStatus === 'overdue' && daysSinceDelivery >= 7) {
      db.orders[orderIndex].paymentStatus = 'frustrated';
      db.orders[orderIndex].updatedAt = new Date().toISOString();
      console.log(`  Pedido ${order.id} marcado como FRUSTRADO`);
      updated = true;
    }
  });

  if (updated) {
    writeDB(db);
  }
});

// Job de expiração PIX - a cada 1 hora
cron.schedule('0 * * * *', () => {
  console.log('💎 Executando job de expiração PIX...');
  const db = await readDB();
  let updated = false;

  const pixOrders = db.orders.filter(o =>
    o.paymentMethod === 'pix' &&
    o.paymentStatus === 'pending'
  );

  pixOrders.forEach(order => {
    const daysSinceCreation = Math.floor(
      (Date.now() - new Date(order.createdAt).getTime()) / (1000 * 60 * 60 * 24)
    );

    if (daysSinceCreation >= 2) {
      const orderIndex = db.orders.findIndex(o => o.id === order.id);
      db.orders[orderIndex].paymentStatus = 'cancelled';
      db.orders[orderIndex].cancelledAt = new Date().toISOString();
      db.orders[orderIndex].cancelReason = 'PIX expirado (2 dias)';
      db.orders[orderIndex].updatedAt = new Date().toISOString();
      console.log(`  PIX ${order.id} cancelado por expiração`);
      updated = true;
    }
  });

  if (updated) {
    writeDB(db);
  }
});

// Job de expiração Boleto - diariamente às 06:00
cron.schedule('0 6 * * *', () => {
  console.log('🏦 Executando job de expiração Boleto...');
  const db = await readDB();
  let updated = false;

  const boletoOrders = db.orders.filter(o =>
    o.paymentMethod === 'boleto' &&
    o.paymentStatus === 'pending'
  );

  boletoOrders.forEach(order => {
    const dueDate = order.boletoInfo?.dueDate || order.createdAt;
    const daysSinceDue = Math.floor(
      (Date.now() - new Date(dueDate).getTime()) / (1000 * 60 * 60 * 24)
    );

    if (daysSinceDue >= 7) {
      const orderIndex = db.orders.findIndex(o => o.id === order.id);
      db.orders[orderIndex].paymentStatus = 'cancelled';
      db.orders[orderIndex].cancelledAt = new Date().toISOString();
      db.orders[orderIndex].cancelReason = 'Boleto expirado (7 dias)';
      db.orders[orderIndex].updatedAt = new Date().toISOString();
      console.log(`  Boleto ${order.id} cancelado por expiração`);
      updated = true;
    }
  });

  if (updated) {
    writeDB(db);
  }
});

// Job de atualização de Turbina Scores - a cada 1 hora
cron.schedule('0 * * * *', () => {
  console.log('⚡ Executando job de atualização de Turbina Scores...');
  try {
    const updated = turbinaScoreService.updateAllTurbinaScores();
    console.log(`✅ Turbina Scores atualizados: ${updated} produto(s)`);
  } catch (error) {
    console.error('❌ Erro ao atualizar Turbina Scores:', error);
  }
});

// Job de detecção de carrinhos abandonados - a cada 30 minutos
cron.schedule('*/30 * * * *', () => {
  console.log('🛒 Executando job de detecção de carrinhos abandonados...');
  const db = await readDB();
  let updated = false;

  if (!db.abandonedCheckouts) {
    db.abandonedCheckouts = [];
  }

  const now = new Date();
  const abandonmentThreshold = 30 * 60 * 1000; // 30 minutos em milissegundos

  // Buscar checkouts ativos que não tiveram atividade há mais de 30 minutos
  const activeCheckouts = db.abandonedCheckouts.filter(a => a.status === 'active');

  activeCheckouts.forEach(checkout => {
    const lastActivity = new Date(checkout.lastActivityAt);
    const timeSinceActivity = now - lastActivity;

    // Se passou mais de 30 minutos sem atividade, marcar como abandonado
    if (timeSinceActivity >= abandonmentThreshold) {
      const checkoutIndex = db.abandonedCheckouts.findIndex(a => a.id === checkout.id);
      if (checkoutIndex !== -1) {
        db.abandonedCheckouts[checkoutIndex].status = 'abandoned';
        db.abandonedCheckouts[checkoutIndex].abandonedAt = now.toISOString();
        console.log(`  Carrinho ${checkout.id} marcado como abandonado (${checkout.customer?.email})`);
        updated = true;
      }
    }
  });

  if (updated) {
    writeDB(db);
    console.log(`✅ ${activeCheckouts.length} carrinho(s) verificado(s), alguns marcados como abandonados`);
  }
});

// ============ ROTAS DE REEMBOLSOS ============

// Listar todos os reembolsos pendentes (Admin)
app.get('/api/refunds/pending', async (req, res) => {
  try {
    const db = await readDB();

    // Buscar todos os pedidos com status de reembolso pendente
    const pendingRefunds = db.orders?.filter(order =>
      order.status === 'refund_pending' || order.status === 'refund_requested'
    ) || [];

    // Enriquecer com dados do cliente e produto
    const refundsWithDetails = pendingRefunds.map(order => {
      const customer = db.users?.find(u => u.id === order.customerId);
      const seller = db.users?.find(u => u.id === order.sellerId);
      const product = db.products?.find(p => p.id === order.productId);

      return {
        ...order,
        customerName: customer?.name || 'Cliente não encontrado',
        customerEmail: customer?.email || '',
        customerPhone: customer?.phone || '',
        sellerName: seller?.name || 'Vendedor não encontrado',
        sellerEmail: seller?.email || '',
        productName: product?.name || order.productName || 'Produto não encontrado',
        refundReason: order.refundReason || 'Não informado'
      };
    });

    res.json({
      success: true,
      refunds: refundsWithDetails,
      total: refundsWithDetails.length
    });

  } catch (error) {
    console.error('❌ Erro ao listar reembolsos pendentes:', error);
    res.status(500).json({
      success: false,
      error: 'Erro interno ao listar reembolsos',
      details: error.message
    });
  }
});

// Obter detalhes de um reembolso específico
app.get('/api/refunds/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    const db = await readDB();

    const order = db.orders?.find(o => o.id === orderId);
    if (!order) {
      return res.status(404).json({ success: false, error: 'Pedido não encontrado' });
    }

    // Buscar dados relacionados
    const customer = db.users?.find(u => u.id === order.customerId);
    const seller = db.users?.find(u => u.id === order.sellerId || u.id === order.producerId);
    const product = db.products?.find(p => p.id === order.productId);

    const refundDetails = {
      ...order,
      customerInfo: {
        name: customer?.name || '',
        email: customer?.email || '',
        phone: customer?.phone || '',
        document: customer?.document || order.document || ''
      },
      sellerInfo: {
        name: seller?.name || '',
        email: seller?.email || '',
        recipientId: seller?.pagarmeRecipientId || ''
      },
      productInfo: {
        name: product?.name || order.productName || '',
        code: product?.code || order.productCode || ''
      },
      refundInfo: {
        reason: order.refundReason || '',
        requestedAt: order.refundRequestedAt || null,
        requestedBy: order.refundRequestedBy || null
      }
    };

    res.json({
      success: true,
      refund: refundDetails
    });

  } catch (error) {
    console.error('❌ Erro ao buscar detalhes do reembolso:', error);
    res.status(500).json({
      success: false,
      error: 'Erro interno ao buscar reembolso',
      details: error.message
    });
  }
});

// Aprovar reembolso
app.post('/api/refunds/:orderId/approve', async (req, res) => {
  try {
    const { orderId } = req.params;
    const { adminNotes } = req.body;
    const db = await readDB();

    const orderIndex = db.orders?.findIndex(o => o.id === orderId);
    if (orderIndex === -1) {
      return res.status(404).json({ success: false, error: 'Pedido não encontrado' });
    }

    const order = db.orders[orderIndex];

    // Validar se pedido está com status correto
    if (order.status !== 'refund_pending' && order.status !== 'refund_requested') {
      return res.status(400).json({
        success: false,
        error: 'Pedido não está aguardando aprovação de reembolso'
      });
    }

    // Buscar vendedor
    const seller = db.users?.find(u => u.id === (order.sellerId || order.producerId));
    if (!seller) {
      return res.status(404).json({ success: false, error: 'Vendedor não encontrado' });
    }

    // Calcular quanto deduzir do vendedor
    const sellerDeduction = order.sellerAmount || Math.round(order.totalAmount * 0.95); // 95% se não tiver split

    console.log(`💸 Processando reembolso do pedido ${order.orderNumber || order.id}`);
    console.log(`   Valor total: R$ ${(order.totalAmount / 100).toFixed(2)}`);
    console.log(`   Dedução do vendedor: R$ ${(sellerDeduction / 100).toFixed(2)}`);

    // Calcular saldo disponível do vendedor
    const vendorBalance = calculateUserBalance(seller.id, db);
    const availableBalance = vendorBalance.available || 0;

    console.log(`   Saldo disponível vendedor: R$ ${(availableBalance / 100).toFixed(2)}`);

    // Criar saldo negativo se necessário
    if (availableBalance < sellerDeduction) {
      const shortage = sellerDeduction - availableBalance;
      console.log(`⚠️  Saldo insuficiente! Criando saldo negativo de R$ ${(shortage / 100).toFixed(2)}`);

      // Registrar saldo negativo
      if (!seller.negativeBalanceHistory) {
        seller.negativeBalanceHistory = [];
      }

      seller.negativeBalanceHistory.push({
        id: uuidv4(),
        orderId: order.id,
        orderNumber: order.orderNumber || order.id,
        amount: -shortage,
        reason: `Reembolso - Pedido #${order.orderNumber || order.id}`,
        createdAt: new Date().toISOString(),
        status: 'active'
      });

      const sellerIndex = db.users.findIndex(u => u.id === seller.id);
      if (sellerIndex !== -1) {
        db.users[sellerIndex] = seller;
      }
    }

    // Processar reembolso na Pagar.me (se tiver transaction ID)
    let pagarmeRefundId = null;
    if (order.transactionId) {
      try {
        console.log(`🔄 Processando reembolso na Pagar.me...`);
        const refundResult = await pagarmeService.refundTransaction(order.transactionId);
        pagarmeRefundId = refundResult.id;
        console.log(`✅ Reembolso processado na Pagar.me: ${pagarmeRefundId}`);
      } catch (pagarmeError) {
        console.error(`❌ Erro ao processar reembolso na Pagar.me:`, pagarmeError.message);
        // Continua mesmo com erro na Pagar.me
      }
    }

    // Atualizar status do pedido
    db.orders[orderIndex].status = 'refunded';
    db.orders[orderIndex].refundedAt = new Date().toISOString();
    db.orders[orderIndex].refundApprovedBy = 'admin';
    db.orders[orderIndex].adminNotes = adminNotes || '';
    db.orders[orderIndex].pagarmeRefundId = pagarmeRefundId;

    writeDB(db);

    console.log(`✅ Reembolso aprovado com sucesso!`);

    res.json({
      success: true,
      message: 'Reembolso aprovado com sucesso',
      refundId: pagarmeRefundId,
      negativeBalanceCreated: availableBalance < sellerDeduction,
      negativeAmount: availableBalance < sellerDeduction ? sellerDeduction - availableBalance : 0
    });

  } catch (error) {
    console.error('❌ Erro ao aprovar reembolso:', error);
    res.status(500).json({
      success: false,
      error: 'Erro interno ao aprovar reembolso',
      details: error.message
    });
  }
});

// Recusar reembolso
app.post('/api/refunds/:orderId/reject', async (req, res) => {
  try {
    const { orderId } = req.params;
    const { rejectionReason, adminNotes } = req.body;
    const db = await readDB();

    if (!rejectionReason || rejectionReason.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Motivo da recusa é obrigatório'
      });
    }

    const orderIndex = db.orders?.findIndex(o => o.id === orderId);
    if (orderIndex === -1) {
      return res.status(404).json({ success: false, error: 'Pedido não encontrado' });
    }

    const order = db.orders[orderIndex];

    // Validar se pedido está com status correto
    if (order.status !== 'refund_pending' && order.status !== 'refund_requested') {
      return res.status(400).json({
        success: false,
        error: 'Pedido não está aguardando aprovação de reembolso'
      });
    }

    console.log(`❌ Recusando reembolso do pedido ${order.orderNumber || order.id}`);
    console.log(`   Motivo: ${rejectionReason}`);

    // Voltar status para pago
    db.orders[orderIndex].status = 'paid';
    db.orders[orderIndex].refundRejectedAt = new Date().toISOString();
    db.orders[orderIndex].refundRejectedBy = 'admin';
    db.orders[orderIndex].rejectionReason = rejectionReason;
    db.orders[orderIndex].adminNotes = adminNotes || '';

    writeDB(db);

    console.log(`✅ Reembolso recusado com sucesso!`);

    res.json({
      success: true,
      message: 'Reembolso recusado com sucesso'
    });

  } catch (error) {
    console.error('❌ Erro ao recusar reembolso:', error);
    res.status(500).json({
      success: false,
      error: 'Erro interno ao recusar reembolso',
      details: error.message
    });
  }
});

// Solicitar reembolso (Cliente/Vendedor)
app.post('/api/orders/:orderId/request-refund', async (req, res) => {
  try {
    const { orderId } = req.params;
    const { reason, requestedBy } = req.body;
    const db = await readDB();

    if (!reason || reason.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Motivo do reembolso é obrigatório'
      });
    }

    const orderIndex = db.orders?.findIndex(o => o.id === orderId);
    if (orderIndex === -1) {
      return res.status(404).json({ success: false, error: 'Pedido não encontrado' });
    }

    const order = db.orders[orderIndex];

    // Validar se pedido pode ser reembolsado
    if (order.status !== 'paid') {
      return res.status(400).json({
        success: false,
        error: 'Apenas pedidos pagos podem solicitar reembolso'
      });
    }

    console.log(`📋 Solicitação de reembolso para pedido ${order.orderNumber || order.id}`);
    console.log(`   Motivo: ${reason}`);

    // Atualizar status do pedido
    db.orders[orderIndex].status = 'refund_pending';
    db.orders[orderIndex].refundReason = reason;
    db.orders[orderIndex].refundRequestedAt = new Date().toISOString();
    db.orders[orderIndex].refundRequestedBy = requestedBy || 'customer';

    writeDB(db);

    console.log(`✅ Reembolso solicitado com sucesso!`);

    res.json({
      success: true,
      message: 'Solicitação de reembolso enviada com sucesso'
    });

  } catch (error) {
    console.error('❌ Erro ao solicitar reembolso:', error);
    res.status(500).json({
      success: false,
      error: 'Erro interno ao solicitar reembolso',
      details: error.message
    });
  }
});

// ============ ENDPOINTS DE PAGAMENTO ============

// Gerar PIX
app.post('/api/payments/pix/generate', async (req, res) => {
  const { orderId, amount } = req.body
  const db = await readDB()

  try {
    // Buscar o pedido
    const order = db.orders.find(o => o.id === orderId)
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Pedido não encontrado'
      })
    }

    // Buscar configuração da Pagar.me
    const apiKey = await getPagarmeApiKey()
    if (!apiKey) {
      console.error('❌ PAGARME_API_KEY não configurada')
      return res.status(500).json({
        success: false,
        message: 'Configuração de pagamento não encontrada'
      })
    }

    // Preparar dados do cliente
    const customer = {
      name: order.customer.name,
      email: order.customer.email,
      cpf: order.customer.cpf,
      phone: order.customer.phone
    }

    // Calcular splits (divisão entre plataforma e vendedor)
    const orderAmount = Math.round((order.totalValue || order.totalAmount || 0) * 100) // Converter para centavos

    // Buscar taxas de PIX (personalizada do vendedor ou padrão da plataforma)
    const fees = getUserFees(order.producerId, 'pix', db)
    const fixedFee = fees.fixedFee || 0
    const variableFee = fees.variableFee || 0.99
    const minFee = fees.minFee || 0

    let platformFeeAmount = Math.round((fixedFee * 100) + (orderAmount * (variableFee / 100)))

    // Aplicar taxa mínima se configurada
    if (minFee > 0 && platformFeeAmount < (minFee * 100)) {
      platformFeeAmount = Math.round(minFee * 100)
    }

    const sellerAmount = orderAmount - platformFeeAmount

    // Buscar recipient IDs
    const seller = db.users?.find(u => u.id === order.producerId)
    if (!seller || !seller.pagarmeRecipientId) {
      console.error(`❌ Vendedor ${order.producerId} não possui recipient_id configurado`)
      return res.status(400).json({
        success: false,
        message: 'Vendedor não configurado para receber pagamentos'
      })
    }

    const platformRecipientId = getPlatformRecipientId()
    if (!platformRecipientId) {
      console.error('❌ PAGARME_PLATFORM_RECIPIENT_ID não configurado')
      return res.status(500).json({
        success: false,
        message: 'Configuração da plataforma não encontrada'
      })
    }

    // Preparar splits
    const splits = [
      {
        recipient_id: seller.pagarmeRecipientId,
        amount: sellerAmount,
        liable: true,
        charge_processing_fee: true
      },
      {
        recipient_id: platformRecipientId,
        amount: platformFeeAmount,
        liable: false,
        charge_processing_fee: false
      }
    ]

    console.log(`💰 Gerando PIX via Pagar.me:`)
    console.log(`   Valor total: R$ ${(orderAmount / 100).toFixed(2)}`)
    console.log(`   Taxa plataforma: R$ ${(platformFeeAmount / 100).toFixed(2)}`)
    console.log(`   Valor vendedor: R$ ${(sellerAmount / 100).toFixed(2)}`)

    // Criar transação PIX na Pagar.me
    const transaction = await pagarmeService.createPixTransaction({
      amount: orderAmount,
      customer: customer,
      splits: splits,
      apiKey: apiKey,
      expirationMinutes: 2880 // 48 horas
    })

    console.log(`✅ PIX criado: ${transaction.transactionId}`)

    // Atualizar pedido com informações do PIX
    const orderIndex = db.orders.findIndex(o => o.id === orderId)
    if (orderIndex !== -1) {
      db.orders[orderIndex].pagarmeTransactionId = transaction.transactionId
      db.orders[orderIndex].paymentDetails = {
        method: 'pix',
        pixQrCode: transaction.pixQrCode,
        pixCopyPaste: transaction.pixCopyPaste,
        expiresAt: transaction.expiresAt
      }
      writeDB(db)
    }

    res.json({
      success: true,
      orderId: orderId,
      transactionId: transaction.transactionId,
      pixCopyPaste: transaction.pixCopyPaste,
      qrCodeBase64: transaction.pixQrCode,
      expiresAt: transaction.expiresAt
    })

  } catch (error) {
    console.error('❌ Erro ao gerar PIX:', error.message)
    res.status(500).json({
      success: false,
      message: 'Erro ao gerar PIX. Tente novamente.',
      error: error.message
    })
  }
})

// Gerar Boleto
app.post('/api/payments/boleto/generate', async (req, res) => {
  const { orderId, amount } = req.body
  const db = await readDB()

  try {
    // Buscar o pedido
    const order = db.orders.find(o => o.id === orderId)
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Pedido não encontrado'
      })
    }

    // Buscar configuração da Pagar.me
    const apiKey = await getPagarmeApiKey()
    if (!apiKey) {
      console.error('❌ PAGARME_API_KEY não configurada')
      return res.status(500).json({
        success: false,
        message: 'Configuração de pagamento não encontrada'
      })
    }

    // Preparar dados do cliente com endereço completo
    const customer = {
      name: order.customer.name,
      email: order.customer.email,
      cpf: order.customer.cpf,
      phone: order.customer.phone,
      address: order.customer.address,
      number: order.customer.number,
      neighborhood: order.customer.neighborhood,
      city: order.customer.city,
      state: order.customer.state,
      zipCode: order.customer.zipCode
    }

    // Calcular splits (divisão entre plataforma e vendedor)
    const orderAmount = Math.round((order.totalValue || order.totalAmount || 0) * 100) // Converter para centavos

    // Buscar taxas de Boleto (personalizada do vendedor ou padrão da plataforma)
    const fees = getUserFees(order.producerId, 'boleto', db)
    const fixedFee = fees.fixedFee || 3.50
    const variableFee = fees.variableFee || 0

    const platformFeeAmount = Math.round((fixedFee * 100) + (orderAmount * (variableFee / 100)))
    const sellerAmount = orderAmount - platformFeeAmount

    // Buscar recipient IDs
    const seller = db.users?.find(u => u.id === order.producerId)
    if (!seller || !seller.pagarmeRecipientId) {
      console.error(`❌ Vendedor ${order.producerId} não possui recipient_id configurado`)
      return res.status(400).json({
        success: false,
        message: 'Vendedor não configurado para receber pagamentos'
      })
    }

    const platformRecipientId = getPlatformRecipientId()
    if (!platformRecipientId) {
      console.error('❌ PAGARME_PLATFORM_RECIPIENT_ID não configurado')
      return res.status(500).json({
        success: false,
        message: 'Configuração da plataforma não encontrada'
      })
    }

    // Preparar splits
    const splits = [
      {
        recipient_id: seller.pagarmeRecipientId,
        amount: sellerAmount,
        liable: true,
        charge_processing_fee: true
      },
      {
        recipient_id: platformRecipientId,
        amount: platformFeeAmount,
        liable: false,
        charge_processing_fee: false
      }
    ]

    console.log(`🧾 Gerando Boleto via Pagar.me:`)
    console.log(`   Valor total: R$ ${(orderAmount / 100).toFixed(2)}`)
    console.log(`   Taxa plataforma: R$ ${(platformFeeAmount / 100).toFixed(2)}`)
    console.log(`   Valor vendedor: R$ ${(sellerAmount / 100).toFixed(2)}`)

    // Criar transação Boleto na Pagar.me
    const transaction = await pagarmeService.createBoletoTransaction({
      amount: orderAmount,
      customer: customer,
      splits: splits,
      apiKey: apiKey
    })

    console.log(`✅ Boleto criado: ${transaction.transactionId}`)

    // Atualizar pedido com informações do Boleto
    const orderIndex = db.orders.findIndex(o => o.id === orderId)
    if (orderIndex !== -1) {
      db.orders[orderIndex].pagarmeTransactionId = transaction.transactionId
      db.orders[orderIndex].paymentDetails = {
        method: 'boleto',
        boletoUrl: transaction.boletoUrl,
        boletoBarcode: transaction.boletoBarcode,
        dueDate: transaction.dueDate
      }
      writeDB(db)
    }

    res.json({
      success: true,
      orderId: orderId,
      transactionId: transaction.transactionId,
      barcode: transaction.boletoBarcode,
      dueDate: transaction.dueDate,
      amount: orderAmount / 100,
      beneficiary: 'Pag2Pay Plataforma',
      pdfUrl: transaction.boletoUrl
    })

  } catch (error) {
    console.error('❌ Erro ao gerar Boleto:', error.message)
    res.status(500).json({
      success: false,
      message: 'Erro ao gerar Boleto. Tente novamente.',
      error: error.message
    })
  }
})

// Download PDF do Boleto
app.get('/api/payments/boleto/:orderId/pdf', async (req, res) => {
  // Na produção, gerar PDF real do boleto
  res.send(`
    <html>
      <head>
        <title>Boleto Bancário</title>
        <style>
          body { font-family: Arial; padding: 40px; }
          .header { text-align: center; margin-bottom: 40px; }
          .barcode { font-size: 24px; letter-spacing: 2px; text-align: center; margin: 20px 0; }
          .info { margin: 20px 0; }
          .info-row { display: flex; justify-content: space-between; margin: 10px 0; }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>BOLETO BANCÁRIO</h1>
          <h3>AfterPay Plataforma</h3>
        </div>
        <div class="info">
          <div class="info-row">
            <strong>Beneficiário:</strong>
            <span>AfterPay Plataforma LTDA</span>
          </div>
          <div class="info-row">
            <strong>Vencimento:</strong>
            <span>${new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toLocaleDateString('pt-BR')}</span>
          </div>
          <div class="info-row">
            <strong>Valor:</strong>
            <span>R$ XXX,XX</span>
          </div>
        </div>
        <div class="barcode">
          34191.09012 43067.840015 06080.659014
        </div>
        <p style="text-align: center; color: #666;">
          Este é um boleto de demonstração. Em produção, use uma biblioteca de geração de PDF.
        </p>
      </body>
    </html>
  `)
})

// Processar Cartão de Crédito
app.post('/api/payments/credit-card/process', async (req, res) => {
  const { orderId, amount, cardNumber, cardName, expiryDate, cvv, installments } = req.body
  const db = await readDB()

  // Validações básicas
  if (!cardNumber || cardNumber.length !== 16) {
    return res.status(400).json({
      success: false,
      status: 'refused',
      message: 'Número do cartão inválido',
      refusalReason: 'Número do cartão inválido'
    })
  }

  if (!cvv || (cvv.length !== 3 && cvv.length !== 4)) {
    return res.status(400).json({
      success: false,
      status: 'refused',
      message: 'CVV inválido',
      refusalReason: 'CVV inválido'
    })
  }

  try {
    // Buscar o pedido
    const order = db.orders.find(o => o.id === orderId)
    if (!order) {
      return res.status(404).json({
        success: false,
        status: 'refused',
        message: 'Pedido não encontrado',
        refusalReason: 'Pedido não encontrado'
      })
    }

    // Buscar configuração da Pagar.me do vendedor
    const apiKey = await getPagarmeApiKey()
    if (!apiKey) {
      console.error('❌ PAGARME_API_KEY não configurada')
      return res.status(500).json({
        success: false,
        status: 'processing_error',
        message: 'Configuração de pagamento não encontrada',
        refusalReason: 'Erro de configuração do gateway de pagamento'
      })
    }

    // Preparar dados do cliente
    const customer = {
      name: order.customer.name,
      email: order.customer.email,
      cpf: order.customer.cpf,
      phone: order.customer.phone
    }

    // Preparar dados do cartão
    const card = {
      number: cardNumber,
      name: cardName,
      expiry: expiryDate,
      cvv: cvv
    }

    // Calcular splits (divisão entre plataforma e vendedor)
    const orderAmount = Math.round((order.totalValue || order.totalAmount || 0) * 100) // Converter para centavos

    // Buscar taxas de cartão (personalizada do vendedor ou padrão da plataforma)
    const fees = getUserFees(order.producerId, 'cartao', db)

    // Determinar taxa baseada no número de parcelas
    let fixedFee = fees.fixedFee || 0.40
    let variableFee = fees.variableFee || 3.99

    if (installments >= 6 && installments < 12) {
      fixedFee = fees.fixedFee6x || fixedFee
      variableFee = fees.variableFee6x || variableFee
    } else if (installments >= 12) {
      fixedFee = fees.fixedFee12x || fixedFee
      variableFee = fees.variableFee12x || variableFee
    }

    const platformFeeAmount = Math.round((fixedFee * 100) + (orderAmount * (variableFee / 100)))

    // Calcular taxa de antecipação (se aplicável)
    const anticipationFee = calculateAnticipationFee(order.producerId, orderAmount, installments, db)

    // Valor final do vendedor (descontando taxa de plataforma + taxa de antecipação)
    const sellerAmount = orderAmount - platformFeeAmount - anticipationFee

    // Buscar recipient IDs
    const seller = db.users?.find(u => u.id === order.producerId)
    if (!seller || !seller.pagarmeRecipientId) {
      console.error(`❌ Vendedor ${order.producerId} não possui recipient_id configurado`)
      return res.status(400).json({
        success: false,
        status: 'processing_error',
        message: 'Vendedor não configurado para receber pagamentos',
        refusalReason: 'Vendedor sem configuração de recebimento'
      })
    }

    const platformRecipientId = getPlatformRecipientId()
    if (!platformRecipientId) {
      console.error('❌ PAGARME_PLATFORM_RECIPIENT_ID não configurado')
      return res.status(500).json({
        success: false,
        status: 'processing_error',
        message: 'Configuração da plataforma não encontrada',
        refusalReason: 'Erro de configuração da plataforma'
      })
    }

    // Preparar splits
    const splits = [
      {
        recipient_id: seller.pagarmeRecipientId,
        amount: sellerAmount,
        liable: true,
        charge_processing_fee: true
      },
      {
        recipient_id: platformRecipientId,
        amount: platformFeeAmount + anticipationFee, // Plataforma recebe taxa + antecipação
        liable: false,
        charge_processing_fee: false
      }
    ]

    console.log(`💳 Processando pagamento via Pagar.me:`)
    console.log(`   Valor total: R$ ${(orderAmount / 100).toFixed(2)}`)
    console.log(`   Taxa plataforma: R$ ${(platformFeeAmount / 100).toFixed(2)}`)
    console.log(`   Taxa antecipação: R$ ${(anticipationFee / 100).toFixed(2)}`)
    console.log(`   Valor vendedor: R$ ${(sellerAmount / 100).toFixed(2)}`)
    console.log(`   Parcelas: ${installments}x`)

    // Criar transação na Pagar.me
    const transaction = await pagarmeService.createCardTransaction({
      amount: orderAmount,
      customer: customer,
      card: card,
      splits: splits,
      installments: installments || 1,
      apiKey: apiKey
    })

    console.log(`✅ Transação criada: ${transaction.transactionId}`)
    console.log(`   Status: ${transaction.status}`)

    // Verificar status da transação
    if (transaction.status === 'paid' || transaction.status === 'authorized') {
      // Atualizar status do pedido
      const orderIndex = db.orders.findIndex(o => o.id === orderId)
      if (orderIndex !== -1) {
        db.orders[orderIndex].paymentStatus = 'paid'
        db.orders[orderIndex].paidAt = new Date().toISOString()
        db.orders[orderIndex].pagarmeTransactionId = transaction.transactionId
        db.orders[orderIndex].paymentDetails = {
          method: 'credit_card',
          cardBrand: getCardBrand(cardNumber),
          lastDigits: cardNumber.slice(-4),
          installments: installments || 1,
          authorizationCode: transaction.authorizationCode,
          acquirerResponseCode: transaction.acquirerResponseCode
        }

        // ✅ RESETAR flag do Notazz quando pedido for pago via cartão
        if (db.orders[orderIndex].sentToNotazz) {
          console.log(`🔄 Pedido ${orderId} pago via cartão - resetando flag sentToNotazz`)
          db.orders[orderIndex].sentToNotazz = false
          db.orders[orderIndex].sentToNotazzAt = null
        }

        writeDB(db)
      }

      res.json({
        success: true,
        status: 'approved',
        message: 'Pagamento aprovado com sucesso!',
        transactionId: transaction.transactionId,
        authorizationCode: transaction.authorizationCode,
        orderId: orderId
      })

    } else {
      // Pagamento recusado
      const refusalReason = getRefusalReason(transaction.status, transaction.acquirerResponseCode)

      console.log(`❌ Pagamento recusado:`)
      console.log(`   Status: ${transaction.status}`)
      console.log(`   Código: ${transaction.acquirerResponseCode}`)
      console.log(`   Motivo: ${refusalReason}`)

      res.status(400).json({
        success: false,
        status: 'refused',
        message: refusalReason,
        refusalReason: refusalReason,
        acquirerResponseCode: transaction.acquirerResponseCode,
        transactionId: transaction.transactionId
      })
    }

  } catch (error) {
    console.error('❌ Erro ao processar pagamento:', error.message)

    res.status(500).json({
      success: false,
      status: 'processing_error',
      message: 'Erro ao processar pagamento. Tente novamente.',
      refusalReason: error.message || 'Erro no processamento do pagamento'
    })
  }
})

// Função auxiliar para detectar bandeira do cartão
function getCardBrand(cardNumber) {
  const number = cardNumber.toString()
  if (number.startsWith('4')) return 'Visa'
  if (number.startsWith('5')) return 'Mastercard'
  if (number.startsWith('34') || number.startsWith('37')) return 'American Express'
  if (number.startsWith('6011')) return 'Discover'
  if (number.startsWith('3')) return 'Diners'
  if (number.startsWith('60')) return 'Hipercard'
  return 'Desconhecida'
}

// Função auxiliar para interpretar códigos de recusa
function getRefusalReason(status, acquirerCode) {
  // Mapeamento dos códigos de resposta da adquirente
  const refusalCodes = {
    '05': 'Transação não autorizada. Entre em contato com seu banco.',
    '51': 'Saldo insuficiente. Verifique o limite do cartão.',
    '54': 'Cartão vencido. Utilize outro cartão.',
    '57': 'Transação não permitida para este cartão.',
    '61': 'Valor da compra excede o limite do cartão.',
    '62': 'Cartão com restrição. Entre em contato com seu banco.',
    '63': 'Violação de segurança. Entre em contato com seu banco.',
    '65': 'Limite de transações excedido.',
    '75': 'Senha inválida. Verifique os dados do cartão.',
    '78': 'Cartão não desbloqueado. Entre em contato com seu banco.',
    '82': 'Cartão inválido. Verifique os dados informados.',
    '83': 'Erro ao validar a senha. Verifique os dados do cartão.',
    '91': 'Banco emissor fora do ar. Tente novamente mais tarde.',
    '96': 'Falha no processamento. Tente novamente.',
    '1000': 'Cartão inválido ou bloqueado.',
    '1001': 'Cartão vencido ou data de validade inválida.',
    '1002': 'Código de segurança (CVV) inválido.',
    '1003': 'Transação negada por questões de segurança.',
    '1004': 'Saldo insuficiente ou limite excedido.'
  }

  // Se houver código específico da adquirente, retornar mensagem correspondente
  if (acquirerCode && refusalCodes[acquirerCode]) {
    return refusalCodes[acquirerCode]
  }

  // Mensagens baseadas no status
  if (status === 'refused') {
    return 'Pagamento recusado. Verifique os dados do cartão ou entre em contato com seu banco.'
  }
  if (status === 'processing') {
    return 'Pagamento em processamento. Aguarde a confirmação.'
  }
  if (status === 'pending_review') {
    return 'Pagamento em análise. Você receberá uma notificação em breve.'
  }

  return 'Não foi possível processar o pagamento. Tente novamente ou utilize outro cartão.'
}

// ============ INTEGRAÇÃO NOTAZZ - FUNÇÕES AUXILIARES ============

// Função para enviar pedido ao Notazz (assíncrona, não bloqueia a resposta)
async function enviarPedidoNotazz(orderId, userId) {
  const db = await readDB();
  let notazzPayload = null; // Declarar fora do try para acessar no catch

  try {
    // Buscar configuração do Notazz
    const notazzConfig = db.notazzConfigs?.find(c => c.userId === userId);

    if (!notazzConfig || !notazzConfig.enabled) {
      console.log(`⚠️  Integração Notazz não está ativada para usuário ${userId}`);
      return;
    }

    // Buscar pedido
    const order = db.orders.find(o => o.id === orderId);

    if (!order) {
      console.log(`❌ Pedido ${orderId} não encontrado`);
      return;
    }

    // ========== LOG: Dados do pedido ANTES de processar ==========
    console.log(`\n📦 ========== DADOS DO PEDIDO NO BANCO ==========`);
    console.log(`ID: ${order.id}`);
    console.log(`Cliente no banco: "${order.customer?.name}"`);
    console.log(`Email no banco: "${order.customer?.email}"`);
    console.log(`CPF no banco: "${order.customer?.cpf}"`);
    console.log(`Endereço no banco: "${order.customer?.address}, ${order.customer?.number}"`);
    console.log(`Bairro no banco: "${order.customer?.neighborhood}"`);
    console.log(`Cidade no banco: "${order.customer?.city}/${order.customer?.state}"`);
    console.log(`CEP no banco: "${order.customer?.zipCode}"`);
    console.log(`Valor no banco: R$ ${order.totalValue}`);
    console.log(`Plano no banco: "${order.selectedPlanName || 'Sem plano'}"`);
    console.log(`=================================================\n`);

    // Verificar se pedido já foi enviado ao Notazz
    if (order.sentToNotazz) {
      console.log(`ℹ️ Pedido ${orderId} já foi enviado ao Notazz em ${order.sentToNotazzAt || 'data desconhecida'}`);
      console.log(`⏭️ Pulando envio duplicado`);
      return;
    }

    // Buscar informações do produto
    const product = db.products?.find(p => p.id === order.productId);

    // Mapear status do pedido para status do Notazz
    const statusMap = {
      'paid': 'paid',
      'pending': 'paid',           // AfterPay pendente → considerar pago para NF
      'scheduled': 'paid',         // AfterPay agendado → considerar pago para NF
      'refunded': 'refunded',
      'cancelled': 'refunded',
      'chargeback': 'chargeback'
    };

    const notazzStatus = statusMap[order.paymentStatus] || 'paid';

    // Preparar payload conforme documentação do WEBHOOK Notazz
    // Documentação: https://app.notazz.com/docs/webhooks/

    // Obter endereço de entrega
    const shippingAddr = order.shippingAddress || order.customer || {};

    // CPF/CNPJ do cliente
    const cpfCnpj = (order.customer?.cpf || '').replace(/\D/g, '');

    // Preparar array de produtos no formato do webhook
    const products = [{
      id: order.productId || '1',
      name: order.productName || 'Produto',
      amount: String(order.quantity || 1),
      unitary_value: parseFloat(order.productPrice || order.totalValue || 0).toFixed(2)
    }];

    // ========== FORMATO WEBHOOK PARA CRIAR PEDIDO ==========
    // Documentação: https://app.notazz.com/docs/webhooks/
    // Endpoint: https://app.notazz.com/webhook/{token}
    // Este formato cria o PEDIDO no Notazz (não a NF-e diretamente)

    console.log(`📡 Modo de integração: Webhook (Criar Pedido)`);

    // ========== FUNÇÕES DE FORMATAÇÃO E VALIDAÇÃO ==========

    // Função para garantir que o valor seja string não-vazia
    const garantirString = (valor, padrao = '') => {
      if (valor === null || valor === undefined || valor === '') {
        return String(padrao);
      }
      return String(valor).trim();
    };

    // Função para formatar valores monetários como string
    const formatarValor = (valor) => {
      const num = parseFloat(valor || 0);
      return num.toFixed(2);
    };

    // Função para limpar e validar CPF/CNPJ
    const limparCpfCnpj = (doc) => {
      return String(doc || '').replace(/\D/g, '');
    };

    // Função para limpar CEP
    const limparCep = (cep) => {
      return String(cep || '').replace(/\D/g, '').padStart(8, '0');
    };

    // Função para limpar telefone
    const limparTelefone = (tel) => {
      return String(tel || '').replace(/\D/g, '');
    };

    // ========== VALIDAÇÃO E PREPARAÇÃO DOS DADOS ==========

    // CPF/CNPJ limpo
    const docLimpo = limparCpfCnpj(cpfCnpj);

    // Determinar tipo de pessoa
    let tipoPessoa = 'F'; // Padrão: Pessoa Física
    if (docLimpo.length === 14) {
      tipoPessoa = 'J'; // Pessoa Jurídica (CNPJ)
    } else if (docLimpo.length !== 11) {
      tipoPessoa = 'E'; // Estrangeiro (ou inválido)
    }

    // Validar campos obrigatórios do endereço
    const rua = garantirString(shippingAddr.address || shippingAddr.street, 'Não informado');
    const numero = garantirString(shippingAddr.number, 'S/N');
    const bairro = garantirString(shippingAddr.neighborhood || shippingAddr.district, 'Centro');
    const cidade = garantirString(shippingAddr.city, 'Não informado');
    const uf = garantirString(shippingAddr.state, 'PE').toUpperCase().substring(0, 2);
    const cep = limparCep(shippingAddr.zipCode || shippingAddr.cep);

    // Validar nome do cliente
    const nomeCliente = garantirString(order.customer?.name, 'Cliente');

    // Validar email e telefone
    const email = garantirString(order.customer?.email, '');
    const telefone = limparTelefone(order.customer?.phone);

    // Validar produto
    const nomeProduto = garantirString(order.productName, 'Produto');
    const quantidadeProduto = String(Math.max(1, parseInt(order.quantity) || 1));
    const valorProduto = formatarValor(order.productPrice || order.totalValue);

    // Validar valor total
    const valorTotal = formatarValor(order.totalValue);

    console.log(`\n🔍 ========== VALIDAÇÃO DOS DADOS ==========`);
    console.log(`Cliente: "${nomeCliente}"`);
    console.log(`CPF/CNPJ: "${docLimpo}" (${docLimpo.length} dígitos) - Tipo: ${tipoPessoa}`);
    console.log(`Endereço: "${rua}", ${numero}`);
    console.log(`Bairro: "${bairro}"`);
    console.log(`Cidade: "${cidade}" - UF: "${uf}"`);
    console.log(`CEP: "${cep}" (${cep.length} dígitos)`);
    console.log(`Email: "${email}"`);
    console.log(`Telefone: "${telefone}"`);
    console.log(`Produto: "${nomeProduto}" - Qtd: ${quantidadeProduto} - Valor: R$ ${valorProduto}`);
    console.log(`Valor Total: R$ ${valorTotal}`);
    console.log(`===========================================\n`);

    // Verificar campos críticos
    if (!docLimpo || (docLimpo.length !== 11 && docLimpo.length !== 14)) {
      console.log(`❌ CPF/CNPJ inválido: "${docLimpo}" (tamanho: ${docLimpo.length})`);
      return;
    }

    if (!cep || cep.length !== 8) {
      console.log(`❌ CEP inválido: "${cep}" (tamanho: ${cep.length})`);
      return;
    }

    if (!uf || uf.length !== 2) {
      console.log(`❌ UF inválido: "${uf}"`);
      return;
    }

    if (parseFloat(valorTotal) <= 0) {
      console.log(`❌ Valor total inválido: R$ ${valorTotal}`);
      return;
    }

    // Preparar produtos no formato WEBHOOK (lowercase)
    const webhookProducts = [{
      id: String(order.productId || '1'),
      name: nomeProduto,
      amount: quantidadeProduto,
      unitary_value: valorProduto
    }];

    // ========== PAYLOAD WEBHOOK (CRIAR PEDIDO) ==========
    // Formato conforme documentação: https://app.notazz.com/docs/webhooks/
    // Este formato cria o PEDIDO no Notazz (não gera NF-e diretamente)

    // Gerar identificadores únicos (padrão de outras integrações bem-sucedidas)
    const timestamp = Date.now();
    const randomSuffix = Math.random().toString(36).substring(2, 8);
    const uniqueId = `${order.id}-${timestamp}-${randomSuffix}`;

    // ========== PAYLOAD WEBHOOK - SOMENTE CAMPOS DA DOCUMENTAÇÃO ==========
    // Documentação: https://app.notazz.com/docs/webhooks/
    // IMPORTANTE: Enviar campos extras causa erro no Notazz

    notazzPayload = {
      // ========== CAMPOS OBRIGATÓRIOS ==========
      id: uniqueId,                            // Identificador único da transação
      total: valorTotal,                       // Valor total da transação
      status: notazzStatus,                    // paid, completed, refunded, chargeback
      customer_name: nomeCliente,              // Nome completo do cliente
      product: webhookProducts,                // Array de produtos

      // ========== CAMPOS OPCIONAIS (conforme documentação) ==========
      commission: '0.00',                      // Valor da comissão
      date: order.createdAt || new Date().toISOString(), // Data da venda (YYYY-MM-DD HH:MM:SS)
      installments: 1,                         // Número de parcelas
      shipping_name: '',                       // Nome da transportadora (opcional)
      shipping_method: '',                     // Método de envio (opcional)
      currency: 'BRL',                         // Moeda (ISO 4217)
      shipping_value: '0.00',                  // Valor do frete
      sale_type: 'producer',                   // producer ou others
      payment_method: order.paymentMethod || 'afterPay', // Método de pagamento

      // Dados do cliente (opcionais)
      customer_doc: docLimpo,                  // CPF/CNPJ
      customer_email: email || '',             // Email
      customer_street: rua,                    // Logradouro
      customer_number: numero,                 // Número
      customer_complement: garantirString(shippingAddr.complement, ''), // Complemento
      customer_district: bairro,               // Bairro
      customer_zipcode: cep,                   // CEP
      customer_city: cidade,                   // Cidade
      customer_state: uf,                      // Estado (sigla)
      customer_country: 'BR',                  // País (ISO-3166)
      customer_phone: telefone,                // Telefone

      // Dados do produtor (opcionais)
      producer_name: order.producerName || 'Pag2 Pay',  // Nome do produtor
      producer_doc: '',                        // CPF/CNPJ do produtor
      producer_email: ''                       // Email do produtor
    };

    console.log(`\n📤 ========== ENVIANDO PARA NOTAZZ ==========`);
    console.log(`📤 Pedido: ${orderId}`);
    console.log(`🔑 Webhook Token: ${notazzConfig.webhookId.substring(0, 10)}...`);

    // URL do Webhook Notazz
    const notazzUrl = `https://app.notazz.com/webhook/${notazzConfig.webhookId}`;

    console.log(`🌐 URL: ${notazzUrl}`);
    console.log(`📦 Payload:`, JSON.stringify(notazzPayload, null, 2));

    const notazzResponse = await fetch(notazzUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(notazzPayload)
    });

    console.log(`\n📥 ========== RESPOSTA DO NOTAZZ ==========`);
    console.log(`Status HTTP: ${notazzResponse.status} ${notazzResponse.ok ? '✅' : '❌'}`);
    console.log(`Response Headers:`, Object.fromEntries(notazzResponse.headers.entries()));

    // Capturar o body como texto primeiro para debug
    const responseText = await notazzResponse.text();
    console.log(`Response Body (texto bruto):`, responseText);

    let notazzData;
    try {
      notazzData = JSON.parse(responseText);
      console.log(`Resposta JSON parseada:`, JSON.stringify(notazzData, null, 2));
    } catch (e) {
      console.log(`⚠️ Resposta NÃO é JSON válido. Erro:`, e.message);
      notazzData = { error: 'Resposta não é JSON', raw: responseText };
    }

    console.log(`===========================================\n`);

    // Salvar log do envio
    const dbAtual = readDB(); // Recarregar DB para evitar conflitos
    if (!dbAtual.notazzLogs) {
      dbAtual.notazzLogs = [];
    }

    dbAtual.notazzLogs.push({
      id: uuidv4(),
      orderId: orderId,
      userId: userId,
      success: notazzResponse.ok,
      statusCode: notazzResponse.status,
      payload: notazzPayload,
      response: notazzData,
      timestamp: new Date().toISOString()
    });

    writeDB(dbAtual);

    if (notazzResponse.ok) {
      console.log(`✅ Pedido enviado com sucesso ao Notazz`);
      console.log(`📋 Resposta:`, notazzData);

      // Marcar pedido como enviado para Notazz para evitar duplicação
      const dbParaMarcar = readDB();
      const orderIndexToMark = dbParaMarcar.orders.findIndex(o => o.id === orderId);
      if (orderIndexToMark !== -1) {
        dbParaMarcar.orders[orderIndexToMark].sentToNotazz = true;
        dbParaMarcar.orders[orderIndexToMark].sentToNotazzAt = new Date().toISOString();
        writeDB(dbParaMarcar);
        console.log(`🏷️ Pedido ${orderId} marcado como enviado ao Notazz`);
      }
    } else {
      console.log(`⚠️ Erro ao enviar pedido ao Notazz: ${notazzResponse.status}`);
      console.log(`📋 Detalhes:`, notazzData);
    }
  } catch (error) {
    console.error(`❌ Erro ao enviar pedido para Notazz: ${error.message}`);

    // Salvar log do erro
    try {
      const dbAtual = readDB();
      if (!dbAtual.notazzLogs) {
        dbAtual.notazzLogs = [];
      }

      dbAtual.notazzLogs.push({
        id: uuidv4(),
        orderId: orderId,
        userId: userId,
        success: false,
        statusCode: 0,
        payload: notazzPayload || { error: 'Payload não gerado' },
        error: error.message,
        timestamp: new Date().toISOString()
      });

      writeDB(dbAtual);
    } catch (logError) {
      console.error(`❌ Erro ao salvar log:`, logError.message);
    }
  }
}

// ============ SISTEMA DE WEBHOOKS EM PORTUGUÊS ============

// Função para formatar telefone para formato internacional (55XXXXXXXXXXX)
function formatPhoneToInternational(phone) {
  if (!phone) return '';

  // Remove tudo que não é número
  const numbersOnly = phone.replace(/\D/g, '');

  // Se já tem DDI (começa com 55), retorna como está
  if (numbersOnly.startsWith('55') && numbersOnly.length >= 12) {
    return numbersOnly;
  }

  // Se tem 11 dígitos (celular com DDD), adiciona 55
  if (numbersOnly.length === 11) {
    return '55' + numbersOnly;
  }

  // Se tem 10 dígitos (fixo com DDD), adiciona 55
  if (numbersOnly.length === 10) {
    return '55' + numbersOnly;
  }

  // Se não tem DDD mas tem 9 dígitos (celular sem DDD), retorna só os números
  // O usuário terá que configurar o DDD manualmente
  return numbersOnly;
}

// Função para disparar webhooks em português
async function dispararWebhookPortugues(userId, evento, dadosPedido) {
  const db = await readDB()

  console.log(`\n🔔 ====== DISPARANDO WEBHOOK ======`)
  console.log(`👤 UserId: ${userId}`)
  console.log(`📡 Evento: ${evento}`)
  console.log(`📦 Pedido ID: ${dadosPedido.id}`)
  console.log(`🏷️  Produto: ${dadosPedido.productName} (Código: ${dadosPedido.productCode || 'N/A'}, ID: ${dadosPedido.productId})`)
  console.log(`📊 Total de webhooks no sistema: ${db.webhooks?.length || 0}`)

  // Buscar webhooks configurados pelo usuário
  const webhooksUsuario = db.webhooks?.filter(w =>
    w.userId === userId &&
    w.status === true &&
    w.events[evento] === true
  ) || []

  console.log(`✅ Webhooks encontrados para este usuário e evento: ${webhooksUsuario.length}`)

  if (webhooksUsuario.length === 0) {
    console.log(`📭 Nenhum webhook configurado para o evento: ${evento}`)
    console.log(`💡 Verifique se:`)
    console.log(`   - O webhook está ativo (status: true)`)
    console.log(`   - O evento "${evento}" está marcado`)
    console.log(`   - O userId do webhook (${userId}) corresponde ao produtor do produto`)
    console.log(`=====================================\n`)
    return
  }

  // Mapeamento de eventos (mantém em inglês para compatibilidade)
  const eventosIngles = {
    aguardandoPagamento: 'aguardandoPagamento',
    pagamentoAprovado: 'pagamentoAprovado',
    cancelada: 'cancelada',
    agendado: 'agendado',
    frustrada: 'frustrada',
    codigoRastreio: 'codigoRastreio',
    pedidoEntregue: 'pedidoEntregue',
    saiuParaEntrega: 'saiuParaEntrega',
    aguardandoRetirada: 'aguardandoRetirada'
  }

  // Preparar valores para o payload
  const valorTotal = dadosPedido.totalValue || dadosPedido.productPrice || 0;
  const comissaoProdutor = dadosPedido.producerCommission || 0;
  const comissaoAfiliado = dadosPedido.affiliateCommission || 0;

  // Enviar para cada webhook configurado
  for (const webhook of webhooksUsuario) {
    // Verificar se o webhook é para um produto específico
    if (webhook.product && webhook.product !== '' && webhook.product !== 'Todos os produtos') {
      // O formato do produto pode ser: "CODIGO - Nome do Produto" ou apenas o nome
      // Vamos verificar se o nome do produto do pedido está contido no webhook.product
      const nomeProdutoPedido = dadosPedido.productName || ''
      const codigoProdutoPedido = dadosPedido.productCode || ''
      const idProdutoPedido = dadosPedido.productId || ''

      // Verificar se o webhook corresponde a este produto (por nome, código ou ID)
      const produtoMatch =
        webhook.product.includes(nomeProdutoPedido) || // Contém o nome
        webhook.product.includes(codigoProdutoPedido) || // Contém o código
        webhook.product.includes(idProdutoPedido) // Contém o ID

      if (!produtoMatch) {
        console.log(`⏭️  Pulando webhook "${webhook.name}" - produto "${webhook.product}" não corresponde ao pedido "${nomeProdutoPedido}"`)
        continue // Pular este webhook se não for para este produto
      }

      console.log(`✅ Webhook "${webhook.name}" corresponde ao produto "${nomeProdutoPedido}"`)
    }

    // Construir payload no formato Botconversa (padrão de mercado)
    const payload = {
      // Parâmetros gerais
      basic_authentication: webhook.code || '',
      type: {
        pending: 'pending',
        pending_payment: 'pending',
        scheduled: 'scheduled',
        paid: 'approved',
        cancelled: 'cancelled',
        refunded: 'refunded'
      }[dadosPedido.paymentStatus] || 'pending',
      currency: 'BRL',

      // Informações do produto
      product_name: dadosPedido.productName || '',
      product_key: dadosPedido.productId || '',
      product_type: 'digital',

      // Informações do plano
      plan_key: dadosPedido.productId || '',
      plan_name: dadosPedido.productName || '',
      plan_amount: dadosPedido.quantity || 1,

      // Informações da transação/venda
      trans_key: dadosPedido.id || '',
      trans_createdate: dadosPedido.createdAt || new Date().toISOString(),
      trans_updatedate: dadosPedido.updatedAt || new Date().toISOString(),
      trans_value: valorTotal.toFixed(2),
      trans_status: {
        pending: 'aguardando_pagamento',
        pending_payment: 'aguardando_pagamento',
        scheduled: 'agendado',
        paid: 'pagamento_aprovado',
        cancelled: 'cancelada',
        refunded: 'reembolsado'
      }[dadosPedido.paymentStatus] || 'aguardando_pagamento',

      // Informações do cliente
      client_name: dadosPedido.customer?.name || '',
      client_email: dadosPedido.customer?.email || '',
      client_cellphone: formatPhoneToInternational(dadosPedido.customer?.phone || ''),
      client_document: dadosPedido.customer?.cpf || '',

      // Endereço do cliente
      // Suporta tanto customer.address quanto customer.address (estrutura aninhada)
      client_address: dadosPedido.customer?.address?.street || dadosPedido.customer?.address || '',
      client_address_number: dadosPedido.customer?.address?.number || dadosPedido.customer?.number || '',
      client_address_comp: dadosPedido.customer?.address?.complement || dadosPedido.customer?.complement || '',
      client_address_district: dadosPedido.customer?.address?.neighborhood || dadosPedido.customer?.neighborhood || '',
      client_address_city: dadosPedido.customer?.address?.city || dadosPedido.customer?.city || '',
      client_address_state: dadosPedido.customer?.address?.state || dadosPedido.customer?.state || '',
      client_address_country: 'BR',
      client_address_zipcode: dadosPedido.customer?.address?.zipCode || dadosPedido.customer?.zipCode || '',

      // Método de pagamento
      payment_type: {
        creditCard: 'credit_card',
        pix: 'pix',
        boleto: 'boleto',
        afterPay: 'afterpay'
      }[dadosPedido.paymentMethod] || dadosPedido.paymentMethod || '',

      // Informações do produtor
      producer_name: dadosPedido.producerName || '',
      producer_document: String(dadosPedido.producerId || ''),
      producer_commission: comissaoProdutor.toFixed(2),

      // Informações do afiliado
      affiliate_name: dadosPedido.affiliateName || null,
      affiliate_key: dadosPedido.affiliateId || null,
      affiliate_commission: comissaoAfiliado.toFixed(2),

      // Rastreamento
      tracking_code: dadosPedido.trackingCode || null,

      // Campos adicionais para compatibilidade
      order_id: dadosPedido.id || '',
      order_number: dadosPedido.orderNumber || dadosPedido.id || '',
      order_date: dadosPedido.createdAt || new Date().toISOString(),
      paid_date: dadosPedido.paidAt || null
    }

    try {
      console.log(`\n🚀 Disparando webhook: ${webhook.name}`)
      console.log(`🌐 URL: ${webhook.url}`)
      console.log(`📦 Payload (PT-BR):`, JSON.stringify(payload, null, 2))

      // Enviar webhook via HTTP POST
      const response = await fetch(webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Pag2Pay-Webhook/1.0',
          'X-Webhook-Event': eventosIngles[evento] || evento,
          'X-Webhook-Signature': webhook.code
        },
        body: JSON.stringify(payload)
      })

      const responseText = await response.text()

      console.log(`📡 Resposta HTTP Status: ${response.status}`)
      console.log(`📄 Resposta Body: ${responseText.substring(0, 200)}`)

      // Salvar log do webhook no banco de dados
      if (!db.webhookLogs) {
        db.webhookLogs = []
      }

      db.webhookLogs.push({
        id: uuidv4(),
        webhookId: webhook.id,
        webhookName: webhook.name,
        url: webhook.url,
        evento: eventosIngles[evento] || evento,
        payload: payload,
        sucesso: response.ok,
        statusCode: response.status,
        dataHora: new Date().toISOString(),
        resposta: responseText.substring(0, 500) // Limitar resposta a 500 caracteres
      })

      writeDB(db)

      if (response.ok) {
        console.log(`✅ Webhook enviado com sucesso: ${webhook.name} (Status: ${response.status})`)
      } else {
        console.log(`⚠️ Webhook enviado mas retornou erro: ${webhook.name} (Status: ${response.status})`)
      }
      console.log(`=====================================\n`)

    } catch (error) {
      console.error(`\n❌ ERRO ao enviar webhook ${webhook.name}`)
      console.error(`🌐 URL: ${webhook.url}`)
      console.error(`⚠️ Erro: ${error.message}`)
      console.error(`📋 Stack: ${error.stack}`)

      // Salvar log de erro
      if (!db.webhookLogs) {
        db.webhookLogs = []
      }

      db.webhookLogs.push({
        id: uuidv4(),
        webhookId: webhook.id,
        webhookName: webhook.name,
        url: webhook.url,
        evento: eventosPortugues[evento],
        payload: payload,
        sucesso: false,
        dataHora: new Date().toISOString(),
        erro: error.message
      })

      writeDB(db)
      console.log(`=====================================\n`)
    }
  }
}

// ============ SIMULAÇÃO E WEBHOOKS ============

// Simular confirmação de pagamento (para testes)
app.post('/api/payments/simulate-confirmation', async (req, res) => {
  const { orderId } = req.body
  const db = await readDB()

  const orderIndex = db.orders.findIndex(o => o.id === orderId)
  if (orderIndex === -1) {
    return res.status(404).json({ success: false, message: 'Pedido não encontrado' })
  }

  // Atualizar status do pedido para pago
  db.orders[orderIndex].paymentStatus = 'paid'
  db.orders[orderIndex].paidAt = new Date().toISOString()
  db.orders[orderIndex].updatedAt = new Date().toISOString()

  // Liberar CPF bloqueado se for AfterPay
  const order = db.orders[orderIndex]
  if (order.paymentMethod === 'afterPay' && order.customer.cpf) {
    const blockedCpfIndex = db.blockedCpfs?.findIndex(b => b.cpf === order.customer.cpf && b.orderId === order.id)
    if (blockedCpfIndex !== -1) {
      db.blockedCpfs.splice(blockedCpfIndex, 1)
    }
  }

  // ✅ RESETAR flag do Notazz quando pedido for pago (simulação)
  if (db.orders[orderIndex].sentToNotazz) {
    console.log(`🔄 Pedido ${orderId} pago (simulação) - resetando flag sentToNotazz`)
    db.orders[orderIndex].sentToNotazz = false
    db.orders[orderIndex].sentToNotazzAt = null
  }

  // Atualizar comissão
  const commissionIndex = db.commissions?.findIndex(c => c.orderId === orderId)
  if (commissionIndex !== -1) {
    db.commissions[commissionIndex].status = 'paid'
    db.commissions[commissionIndex].paidAt = new Date().toISOString()
  }

  writeDB(db)

  // Simular envio de email de confirmação
  console.log(`📧 Email de confirmação enviado para: ${order.customer.email}`)
  console.log(`✅ Pagamento confirmado para pedido: ${orderId}`)

  res.json({
    success: true,
    message: 'Pagamento confirmado com sucesso!',
    order: db.orders[orderIndex]
  })
})

// Webhook genérico para confirmação de pagamento (para integração com gateways)
app.post('/api/webhooks/payment-confirmation', async (req, res) => {
  const { orderId, transactionId, status, amount, paymentMethod } = req.body

  console.log('🔔 Webhook recebido:', {
    orderId,
    transactionId,
    status,
    amount,
    paymentMethod
  })

  const db = await readDB()
  const orderIndex = db.orders.findIndex(o => o.id === orderId)

  if (orderIndex === -1) {
    return res.status(404).json({ success: false, message: 'Pedido não encontrado' })
  }

  // Processar webhook baseado no status
  if (status === 'approved' || status === 'paid') {
    db.orders[orderIndex].paymentStatus = 'paid'
    db.orders[orderIndex].paidAt = new Date().toISOString()
    db.orders[orderIndex].transactionId = transactionId
    db.orders[orderIndex].updatedAt = new Date().toISOString()

    // ✅ RESETAR flag do Notazz quando pedido for pago via webhook
    if (db.orders[orderIndex].sentToNotazz) {
      console.log(`🔄 Pedido ${orderId} pago via webhook - resetando flag sentToNotazz`)
      db.orders[orderIndex].sentToNotazz = false
      db.orders[orderIndex].sentToNotazzAt = null
    }

    // Atualizar comissão
    const commissionIndex = db.commissions?.findIndex(c => c.orderId === orderId)
    if (commissionIndex !== -1) {
      db.commissions[commissionIndex].status = 'paid'
      db.commissions[commissionIndex].paidAt = new Date().toISOString()
    }

    writeDB(db)

    // 🔔 CRIAR NOTIFICAÇÃO PARA O PRODUTOR
    const order = db.orders[orderIndex]
    const commission = db.commissions?.find(c => c.orderId === orderId)
    if (commission && order.producerId) {
      const commissionFormatted = new Intl.NumberFormat('pt-BR', {
        style: 'currency',
        currency: 'BRL'
      }).format(commission.amount)

      global.createNotification(
        order.producerId,
        'sale_new',
        '💰 Nova Venda Confirmada!',
        `Você recebeu uma nova venda! Comissão: ${commissionFormatted}`,
        {
          important: true,
          data: {
            orderId: order.id,
            amount: commission.amount,
            paymentMethod: order.paymentMethod
          },
          actionButton: {
            text: 'Ver Venda',
            icon: '📊',
            link: `/sales/${order.id}`
          }
        }
      )
    }

    console.log(`✅ Pagamento aprovado via webhook: ${orderId}`)
    res.json({ success: true, message: 'Pagamento confirmado' })
  } else if (status === 'cancelled' || status === 'refunded') {
    db.orders[orderIndex].paymentStatus = 'cancelled'
    db.orders[orderIndex].updatedAt = new Date().toISOString()
    writeDB(db)

    console.log(`❌ Pagamento cancelado via webhook: ${orderId}`)
    res.json({ success: true, message: 'Pagamento cancelado' })
  } else {
    res.json({ success: true, message: 'Status recebido' })
  }
})

// 🚚 ========== INTEGRAÇÃO 123LOG ========== //

// Obter configuração da integração 123Log
app.get('/api/integrations/123log', async (req, res) => {
  const db = await readDB()
  const integration = db.logisticsIntegrations?.['123log'] || {
    enabled: false,
    webhookKey: '',
    webhookUrl: '',
    notificationSettings: {
      notifyViaBotConversa: true,
      eventsToNotify: []
    }
  }

  res.json(integration)
})

// Atualizar configuração da integração 123Log
app.put('/api/integrations/123log', async (req, res) => {
  const db = await readDB()
  const { webhookKey, notificationSettings } = req.body

  if (!db.logisticsIntegrations) {
    db.logisticsIntegrations = {}
  }

  const webhookUrl = `${process.env.API_URL || 'http://localhost:3001'}/api/webhooks/123log`

  db.logisticsIntegrations['123log'] = {
    enabled: webhookKey ? true : false,
    webhookKey: webhookKey || '',
    webhookUrl: webhookUrl,
    notificationSettings: notificationSettings || {
      notifyViaBotConversa: true,
      eventsToNotify: [
        'codigo_adicionado',
        'objeto_postado',
        'em_transito',
        'saiu_para_entrega',
        'entregue'
      ]
    },
    createdAt: db.logisticsIntegrations?.['123log']?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }

  writeDB(db)

  console.log('✅ Configuração 123Log atualizada')
  res.json(db.logisticsIntegrations['123log'])
})

// Testar webhook 123Log
app.post('/api/integrations/123log/test', async (req, res) => {
  const db = await readDB()
  const integration = db.logisticsIntegrations?.['123log']

  // Permitir teste mesmo sem configuração (para desenvolvimento)
  const testKey = integration?.webhookKey || 'TESTE-LOCAL-' + Date.now()
  const isConfigured = integration?.enabled && integration?.webhookKey

  // Criar um payload de teste usando o formato REAL da 123Log
  const testPayload = {
    integration_key: testKey,
    type: 'TRACKING_STATUS_CHANGED',
    sale_order: {
      id: '123log-teste-' + Date.now(),
      order_number: 'TESTE-' + Date.now(),
      status: {
        status: 'APPROVED',
        description: 'Pedido de teste aprovado'
      },
      customer: {
        name: 'Cliente Teste',
        email: 'teste@afterpay.com',
        phone: '11999999999'
      }
    },
    delivery: {
      carrier: 'Correios',
      service: 'SEDEX',
      tracking_code: 'BR999999999BR',
      status: 'SHIPPED',
      promised_delivery_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      last_event: {
        date: new Date().toISOString(),
        status: 'Teste de integração',
        location: 'Sistema AfterPay - Teste Local',
        description: 'Este é um evento de teste do webhook 123Log. Sistema funcionando corretamente!'
      },
      history: [
        {
          date: new Date().toISOString(),
          status: 'Teste de integração',
          location: 'Sistema AfterPay - Teste Local',
          description: 'Este é um evento de teste do webhook 123Log. Sistema funcionando corretamente!'
        }
      ]
    }
  }

  try {
    const response = await fetch(`http://localhost:3001/api/webhooks/123log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(testPayload)
    })

    const result = await response.json()

    // Teste é considerado sucesso se:
    // 1. Webhook retornou 200 (OK), OU
    // 2. É teste local e foi processado (isTest: true), OU
    // 3. Webhook foi executado (mesmo que pedido não exista)
    const testSuccess = response.ok || result.isTest === true || response.status !== 500

    // Determinar mensagem apropriada
    let message = ''
    if (result.isTest) {
      // Teste local bem-sucedido
      message = '✅ Teste local processado com sucesso! Sistema funcionando corretamente.'
    } else if (response.ok) {
      // Teste com chave - webhook processou com sucesso
      message = '✅ Teste realizado com sucesso! Webhook processado corretamente. Verifique o histórico abaixo.'
    } else if (result.error === 'Pedido não encontrado') {
      // Erro esperado - pedido de teste não existe
      message = '✅ Teste OK! Webhook recebido e processado (pedido de teste não precisa existir). Verifique o histórico abaixo.'
    } else if (result.error === 'Chave de integração inválida') {
      // Chave errada
      message = '❌ Chave de integração inválida. Verifique se salvou a configuração corretamente.'
      testSuccess = false
    } else {
      // Outro erro
      message = result.error || result.message || 'Teste concluído com avisos'
    }

    res.json({
      success: testSuccess,
      status: response.status,
      message: message,
      result: result,
      isLocalTest: !isConfigured,
      details: {
        webhookProcessed: response.status !== 500,
        configuredKey: isConfigured,
        responseStatus: response.status,
        resultMessage: result.message
      }
    })
  } catch (error) {
    console.error('Erro no teste:', error)
    res.status(500).json({
      success: false,
      message: '❌ Erro ao executar teste: ' + error.message,
      error: error.message
    })
  }
})

// Obter logs de webhooks
app.get('/api/webhooks/logs', async (req, res) => {
  const db = await readDB()
  const { source, limit = 20 } = req.query

  let logs = db.webhookLogs || []

  if (source) {
    logs = logs.filter(log => log.source === source)
  }

  logs = logs.slice(0, parseInt(limit))

  res.json(logs)
})

// 🚚 Webhook da 123Log para receber atualizações de rastreamento
app.post('/api/webhooks/123log', async (req, res) => {
  console.log('📦 Webhook 123Log recebido:', JSON.stringify(req.body, null, 2))

  const db = await readDB()

  // Extrair dados do formato real da 123Log
  const {
    integration_key,
    type,
    sale_order,
    delivery
  } = req.body

  // 1. Validar chave de integração
  const integration = db.logisticsIntegrations?.['123log']

  // Permitir teste local sem configuração (chave começa com TESTE-LOCAL-)
  const isLocalTest = integration_key?.startsWith('TESTE-LOCAL-')

  if (!isLocalTest) {
    if (!integration || !integration.enabled) {
      console.log('❌ Integração 123Log não configurada ou desativada')
      return res.status(400).json({ error: 'Integração não configurada' })
    }

    if (integration_key !== integration.webhookKey) {
      console.log('❌ Chave de integração inválida:', integration_key)

      // Registrar tentativa falha
      if (!db.webhookLogs) db.webhookLogs = []
      db.webhookLogs.unshift({
        id: uuidv4(),
        source: '123log',
        receivedAt: new Date().toISOString(),
        orderId: sale_order?.order_number || 'unknown',
        event: type || 'unknown',
        payload: req.body,
        processed: false,
        error: 'Chave de integração inválida',
        notificationSent: false
      })

      // Manter apenas últimos 100 logs
      if (db.webhookLogs.length > 100) {
        db.webhookLogs = db.webhookLogs.slice(0, 100)
      }

      writeDB(db)
      return res.status(401).json({ error: 'Chave de integração inválida' })
    }
  } else {
    console.log('🧪 Teste local detectado - pulando validação de chave')
  }

  // Verificar se temos os dados necessários
  if (!sale_order || !delivery) {
    console.log('❌ Dados incompletos no webhook')
    return res.status(400).json({ error: 'Dados incompletos' })
  }

  // 2. Buscar pedido pelo order_number
  const orderIndex = db.orders.findIndex(o => o.id === sale_order.order_number)

  // Se for teste local e pedido não existe, registrar como sucesso de teste
  if (orderIndex === -1 && isLocalTest) {
    console.log('🧪 Teste local - Pedido de teste não precisa existir no banco')

    // Registrar log de teste bem-sucedido
    if (!db.webhookLogs) db.webhookLogs = []
    db.webhookLogs.unshift({
      id: uuidv4(),
      source: '123log',
      receivedAt: new Date().toISOString(),
      orderId: sale_order.order_number,
      event: type || 'TRACKING_STATUS_CHANGED',
      payload: req.body,
      processed: true,
      error: null,
      notificationSent: false,
      trackingCode: delivery.tracking_code,
      deliveryStatus: delivery.status,
      isTest: true
    })

    if (db.webhookLogs.length > 100) {
      db.webhookLogs = db.webhookLogs.slice(0, 100)
    }

    writeDB(db)

    console.log('✅ Webhook de teste processado com sucesso!')
    return res.json({
      success: true,
      message: '🧪 Teste local processado com sucesso! Sistema funcionando corretamente.',
      orderId: sale_order.order_number,
      trackingCode: delivery.tracking_code,
      deliveryStatus: delivery.status,
      notificationSent: false,
      isTest: true
    })
  }

  if (orderIndex === -1) {
    console.log('❌ Pedido não encontrado:', sale_order.order_number)

    // Verificar se é pedido de teste (começa com TESTE-)
    const isTestOrder = sale_order.order_number?.startsWith('TESTE-')

    // Registrar log
    if (!db.webhookLogs) db.webhookLogs = []
    db.webhookLogs.unshift({
      id: uuidv4(),
      source: '123log',
      receivedAt: new Date().toISOString(),
      orderId: sale_order.order_number,
      event: type || 'TRACKING_STATUS_CHANGED',
      payload: req.body,
      processed: isTestOrder, // Considera processado se for teste
      error: isTestOrder ? null : 'Pedido não encontrado',
      notificationSent: false,
      trackingCode: delivery?.tracking_code || 'N/A',
      deliveryStatus: delivery?.status || 'N/A',
      isTest: isTestOrder
    })

    if (db.webhookLogs.length > 100) {
      db.webhookLogs = db.webhookLogs.slice(0, 100)
    }

    writeDB(db)

    // Se for teste, retorna sucesso mesmo sem pedido
    if (isTestOrder) {
      console.log('✅ Webhook de teste processado (pedido de teste não precisa existir)')
      return res.json({
        success: true,
        message: 'Webhook de teste processado com sucesso',
        orderId: sale_order.order_number,
        trackingCode: delivery?.tracking_code,
        deliveryStatus: delivery?.status,
        notificationSent: false,
        isTest: true
      })
    }

    return res.status(404).json({ error: 'Pedido não encontrado' })
  }

  const order = db.orders[orderIndex]

  // 3. Processar evento
  const eventType = type || 'TRACKING_STATUS_CHANGED'

  // Mapear status da 123Log para descrições legíveis
  const statusMap = {
    'IN_ANALYSIS': 'Em análise',
    'IN_PRODUCTION': 'Em produção',
    'READY_FOR_SHIPPING': 'Pronto para envio',
    'SHIPPED': 'Enviado',
    'IN_TRANSIT': 'Em trânsito',
    'OUT_FOR_DELIVERY': 'Saiu para entrega',
    'DELIVERED': 'Entregue',
    'DELIVERY_FAILED': 'Falha na entrega',
    'RETURNED': 'Devolvido',
    'CANCELED': 'Cancelado'
  }

  // Adicionar ou atualizar código de rastreio
  if (delivery.tracking_code && (!order.trackingCode || order.trackingCode !== delivery.tracking_code)) {
    order.trackingCode = delivery.tracking_code
    order.carrier = delivery.carrier || 'Não informado'
    order.shippingInfo = {
      carrier: delivery.carrier || 'Não informado',
      service: delivery.service || '',
      trackingCode: delivery.tracking_code,
      addedAt: new Date().toISOString(),
      addedBy: 'webhook_123log',
      source: '123log',
      promisedDeliveryDate: delivery.promised_delivery_date || null
    }
    console.log(`✅ Código de rastreio adicionado/atualizado: ${delivery.tracking_code}`)
  }

  // Inicializar histórico se não existir
  if (!order.trackingHistory) order.trackingHistory = []

  // Processar histórico completo da 123Log
  if (delivery.history && Array.isArray(delivery.history)) {
    // Adicionar todos os eventos do histórico que ainda não existem
    delivery.history.forEach(event => {
      // Verificar se já existe evento com a mesma data e descrição
      const exists = order.trackingHistory.some(e =>
        e.date === event.date &&
        e.description === event.description
      )

      if (!exists) {
        const trackingEvent = {
          id: uuidv4(),
          status: event.status || statusMap[delivery.status] || 'Atualização',
          location: event.location || '',
          date: event.date || new Date().toISOString(),
          description: event.description || 'Atualização de rastreamento',
          receivedAt: new Date().toISOString(),
          source: '123log_webhook',
          rawData: event
        }

        order.trackingHistory.push(trackingEvent)
      }
    })

    // Ordenar histórico por data (mais recente primeiro)
    order.trackingHistory.sort((a, b) => new Date(b.date) - new Date(a.date))
  }

  // Adicionar evento mais recente (last_event)
  if (delivery.last_event) {
    const lastEvent = delivery.last_event

    // Verificar se já existe
    const exists = order.trackingHistory.some(e =>
      e.date === lastEvent.date &&
      e.description === lastEvent.description
    )

    if (!exists) {
      const trackingEvent = {
        id: uuidv4(),
        status: lastEvent.status || statusMap[delivery.status] || 'Atualização',
        location: lastEvent.location || '',
        date: lastEvent.date || new Date().toISOString(),
        description: lastEvent.description || 'Atualização de rastreamento',
        receivedAt: new Date().toISOString(),
        source: '123log_webhook',
        rawData: lastEvent
      }

      order.trackingHistory.unshift(trackingEvent)
    }
  }

  order.updatedAt = new Date().toISOString()

  // 4. Determinar evento para notificação
  const deliveryStatus = delivery.status || 'IN_TRANSIT'
  const eventForNotification = deliveryStatus.toLowerCase().replace(/_/g, '_')

  // Mapear eventos da 123Log para eventos configurados
  const eventMap = {
    'shipped': 'objeto_postado',
    'in_transit': 'em_transito',
    'out_for_delivery': 'saiu_para_entrega',
    'delivered': 'entregue',
    'delivery_failed': 'tentativa_entrega'
  }

  const mappedEvent = eventMap[deliveryStatus.toLowerCase()] || eventForNotification

  // 5. Verificar se deve notificar cliente via BotConversa
  let notificationSent = false
  const shouldNotify = integration.notificationSettings?.notifyViaBotConversa &&
                       integration.notificationSettings?.eventsToNotify?.includes(mappedEvent)

  if (shouldNotify && order.customer?.phone) {
    try {
      const lastEventData = delivery.last_event || delivery.history?.[delivery.history.length - 1]
      const statusText = lastEventData?.status || statusMap[deliveryStatus] || deliveryStatus
      const location = lastEventData?.location || 'Não informado'
      const description = lastEventData?.description || ''
      const eventDate = lastEventData?.date || new Date().toISOString()

      // Formatar mensagem para BotConversa
      const message = `🚚 *Atualização de Rastreio*\n\n📦 Pedido: #${order.id}\n🔢 Código: ${delivery.tracking_code}\n🚛 Transportadora: ${delivery.carrier}\n\n✅ *${statusText}*\nLocal: ${location}\nData: ${new Date(eventDate).toLocaleString('pt-BR')}\n\n${description}`

      // Buscar webhook do BotConversa
      const botconversaWebhook = db.webhooks?.find(w =>
        w.product === 'all' &&
        w.events?.includes('tracking_update') &&
        w.userId === order.producerId
      )

      if (botconversaWebhook) {
        const webhookPayload = {
          phone: order.customer.phone,
          message: message,
          metadata: {
            orderId: order.id,
            eventType: 'shipping_update',
            trackingCode: delivery.tracking_code,
            carrier: delivery.carrier,
            status: deliveryStatus,
            source: '123log'
          }
        }

        await fetch(botconversaWebhook.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(webhookPayload)
        })

        notificationSent = true
        console.log(`📲 Cliente notificado via BotConversa: ${order.customer.phone}`)
      }
    } catch (error) {
      console.error('❌ Erro ao notificar cliente:', error)
    }
  }

  // 6. Salvar alterações
  db.orders[orderIndex] = order

  // 7. Registrar log do webhook
  if (!db.webhookLogs) db.webhookLogs = []
  db.webhookLogs.unshift({
    id: uuidv4(),
    source: '123log',
    receivedAt: new Date().toISOString(),
    orderId: sale_order.order_number,
    event: type || 'TRACKING_STATUS_CHANGED',
    payload: req.body,
    processed: true,
    error: null,
    notificationSent: notificationSent,
    trackingCode: delivery.tracking_code,
    deliveryStatus: delivery.status
  })

  // Manter apenas últimos 100 logs
  if (db.webhookLogs.length > 100) {
    db.webhookLogs = db.webhookLogs.slice(0, 100)
  }

  writeDB(db)

  console.log(`✅ Webhook 123Log processado com sucesso: ${sale_order.order_number} - ${delivery.tracking_code}`)
  res.json({
    success: true,
    message: 'Webhook processado com sucesso',
    orderId: sale_order.order_number,
    trackingCode: delivery.tracking_code,
    deliveryStatus: delivery.status,
    notificationSent: notificationSent
  })
})

// Sistema de email removido conforme solicitado

// ==================== ROTAS DE TAXAS DA PLATAFORMA ====================

// ✅ Buscar taxas da plataforma por adquirente
app.get('/api/platform-fees/:acquirer', async (req, res) => {
  const db = await readDB();
  const { acquirer } = req.params;

  // Estrutura de taxas padrão
  const defaultFees = {
    pix: {
      fixedFee: 1.00,
      variableFee: 4.99,
      minimumFee: 0,
      releaseDays: 0,
      retentionDays: 0,
      retentionPercentage: 0,
      hideMinimumFee: false
    },
    boleto: {
      fixedFee: 1.00,
      variableFee: 4.99,
      releaseDays: 2,
      retentionDays: 2,
      retentionPercentage: 0
    },
    card: {
      installmentFee: 3.49,
      cashFixedFee: 1.00,
      cashVariableFee: 4.99,
      installment6FixedFee: 1.00,
      installment6VariableFee: 4.99,
      installment12FixedFee: 1.00,
      installment12VariableFee: 4.99,
      releaseDays: 14,
      retentionDays: 2,
      retentionPercentage: 0,
      chargebackFee: 0
    },
    saque: {
      fixedFee: 3.67,
      variableFee: 0,
      minimumFee: 0
    },
    antecipacao: {
      minimumAnticipation: 'D+2',
      d2Fee: 0,
      d14Fee: 0,
      calculateByDays: false
    }
  };

  // ✅ Inicializar estrutura por adquirente se não existir
  if (!db.platformFeesByAcquirer) {
    db.platformFeesByAcquirer = {};
  }

  // Se não tem taxas para esta adquirente, retornar padrão
  if (!db.platformFeesByAcquirer[acquirer]) {
    db.platformFeesByAcquirer[acquirer] = {
      configured: false,
      fees: defaultFees
    };
    writeDB(db);
  }

  res.json(db.platformFeesByAcquirer[acquirer].fees);
});

// ✅ Salvar taxas da plataforma por adquirente
app.post('/api/platform-fees', async (req, res) => {
  const db = await readDB();
  const { acquirer, type, data } = req.body;

  if (!db.platformFeesByAcquirer) {
    db.platformFeesByAcquirer = {};
  }

  // Inicializar adquirente se não existir
  if (!db.platformFeesByAcquirer[acquirer]) {
    db.platformFeesByAcquirer[acquirer] = {
      configured: false,
      fees: {}
    };
  }

  // Atualizar a taxa específica desta adquirente
  db.platformFeesByAcquirer[acquirer].fees[type] = data;
  db.platformFeesByAcquirer[acquirer].configured = true;
  db.platformFeesByAcquirer[acquirer].lastUpdated = new Date().toISOString();

  // Registrar histórico de alteração
  if (!db.feesHistory) {
    db.feesHistory = [];
  }

  db.feesHistory.unshift({
    id: uuidv4(),
    acquirer,
    type,
    data,
    changedAt: new Date().toISOString(),
    changedBy: 'Admin Sistema'
  });

  // Manter apenas últimos 50 registros
  if (db.feesHistory.length > 50) {
    db.feesHistory = db.feesHistory.slice(0, 50);
  }

  writeDB(db);

  res.json({
    success: true,
    message: 'Taxas atualizadas com sucesso',
    fees: db.platformFees[type]
  });
});

// ===== ENDPOINTS DE SAQUE =====

/**
 * Aprovar saque e processar transferência via Pagar.me
 */
app.post('/api/withdrawals/:id/approve', async (req, res) => {
  try {
    const { id } = req.params;
    const db = await readDB();

    // Buscar saque
    if (!db.withdrawals) db.withdrawals = [];
    const withdrawalIndex = db.withdrawals.findIndex(w => w.id === id);

    if (withdrawalIndex === -1) {
      return res.status(404).json({
        success: false,
        error: 'Saque não encontrado'
      });
    }

    const withdrawal = db.withdrawals[withdrawalIndex];

    // Verificar se já foi processado
    if (withdrawal.status !== 'pending') {
      return res.status(400).json({
        success: false,
        error: `Saque já está com status: ${withdrawal.status}`
      });
    }

    // Buscar usuário/vendedor
    const user = db.users?.find(u => u.id === withdrawal.sellerId);
    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'Usuário não encontrado'
      });
    }

    // Verificar se usuário tem recipientId da Pagar.me
    if (!user.pagarmeRecipientId) {
      return res.status(400).json({
        success: false,
        error: 'Usuário não possui conta configurada na Pagar.me. Configure primeiro o recebedor.'
      });
    }

    // Calcular taxa de saque
    const platformFees = db.platformFees?.saque || { fixedFee: 3.67, variableFee: 0 };
    const withdrawalFee = platformFees.fixedFee + (withdrawal.amount * (platformFees.variableFee / 100));
    const netAmount = withdrawal.amount - withdrawalFee;

    console.log(`💸 Processando saque ${id}:`);
    console.log(`   Valor solicitado: R$ ${withdrawal.amount.toFixed(2)}`);
    console.log(`   Taxa: R$ ${withdrawalFee.toFixed(2)}`);
    console.log(`   Valor líquido: R$ ${netAmount.toFixed(2)}`);

    // Criar transferência na Pagar.me
    try {
      const apiKey = await getPagarmeApiKey();
      if (!apiKey) {
        throw new Error('PAGARME_API_KEY não configurada. Configure em: Configurações > Integrações > Pagar.me');
      }

      const transfer = await pagarmeService.createTransfer({
        amount: Math.round(netAmount * 100), // Converter para centavos
        recipientId: user.pagarmeRecipientId,
        apiKey: apiKey
      });

      console.log(`✅ Transferência criada na Pagar.me: ${transfer.transferId}`);

      // Atualizar saque no banco de dados
      withdrawal.status = 'processing';
      withdrawal.processedDate = new Date().toISOString();
      withdrawal.processedBy = 'Admin'; // Aqui você pode passar o ID do admin logado
      withdrawal.fee = withdrawalFee;
      withdrawal.netAmount = netAmount;
      withdrawal.pagarmeTransferId = transfer.transferId;
      withdrawal.pagarmeStatus = transfer.status;
      withdrawal.fundingDate = transfer.fundingEstimatedDate;

      db.withdrawals[withdrawalIndex] = withdrawal;
      writeDB(db);

      // 🔔 CRIAR NOTIFICAÇÃO para o usuário sobre aprovação do saque
      const amountFormatted = new Intl.NumberFormat('pt-BR', {
        style: 'currency',
        currency: 'BRL'
      }).format(netAmount)

      const fundingDateFormatted = transfer.fundingEstimatedDate
        ? new Date(transfer.fundingEstimatedDate).toLocaleDateString('pt-BR')
        : 'em breve'

      global.createNotification(
        withdrawal.sellerId,
        'withdrawal_approved',
        '💰 Saque Aprovado!',
        `Seu saque de ${amountFormatted} foi aprovado e está sendo processado. Previsão de chegada: ${fundingDateFormatted}.`,
        {
          important: true,
          data: {
            withdrawalId: withdrawal.id,
            amount: netAmount,
            transferId: transfer.transferId,
            fundingDate: transfer.fundingEstimatedDate
          },
          actionButton: {
            text: 'Ver Saque',
            icon: '💸',
            link: `/bank/withdrawals`
          }
        }
      )

      res.json({
        success: true,
        message: 'Saque aprovado e transferência processada com sucesso',
        withdrawal: withdrawal,
        transfer: {
          id: transfer.transferId,
          status: transfer.status,
          fundingDate: transfer.fundingEstimatedDate
        }
      });

    } catch (pagarmeError) {
      console.error('❌ Erro ao processar transferência na Pagar.me:', pagarmeError.message);

      // Marcar como falha mas manter registro
      withdrawal.status = 'failed';
      withdrawal.processedDate = new Date().toISOString();
      withdrawal.errorMessage = pagarmeError.message;

      db.withdrawals[withdrawalIndex] = withdrawal;
      writeDB(db);

      return res.status(500).json({
        success: false,
        error: 'Erro ao processar transferência na Pagar.me',
        details: pagarmeError.message
      });
    }

  } catch (error) {
    console.error('❌ Erro ao aprovar saque:', error);
    res.status(500).json({
      success: false,
      error: 'Erro ao aprovar saque',
      details: error.message
    });
  }
});

/**
 * Rejeitar saque
 */
app.post('/api/withdrawals/:id/reject', async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    if (!reason || reason.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Motivo da rejeição é obrigatório'
      });
    }

    const db = await readDB();

    if (!db.withdrawals) db.withdrawals = [];
    const withdrawalIndex = db.withdrawals.findIndex(w => w.id === id);

    if (withdrawalIndex === -1) {
      return res.status(404).json({
        success: false,
        error: 'Saque não encontrado'
      });
    }

    const withdrawal = db.withdrawals[withdrawalIndex];

    // Verificar se já foi processado
    if (withdrawal.status !== 'pending') {
      return res.status(400).json({
        success: false,
        error: `Saque já está com status: ${withdrawal.status}`
      });
    }

    // Atualizar saque
    withdrawal.status = 'rejected';
    withdrawal.processedDate = new Date().toISOString();
    withdrawal.processedBy = 'Admin'; // Aqui você pode passar o ID do admin logado
    withdrawal.rejectReason = reason;

    db.withdrawals[withdrawalIndex] = withdrawal;
    writeDB(db);

    // 🔔 CRIAR NOTIFICAÇÃO para o usuário sobre rejeição do saque
    const amountFormatted = new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL'
    }).format(withdrawal.amount)

    global.createNotification(
      withdrawal.sellerId,
      'withdrawal_rejected',
      '❌ Saque Rejeitado',
      `Seu saque de ${amountFormatted} foi rejeitado. Motivo: ${reason}`,
      {
        important: true,
        data: {
          withdrawalId: withdrawal.id,
          amount: withdrawal.amount,
          reason: reason
        },
        actionButton: {
          text: 'Ver Detalhes',
          icon: '💸',
          link: `/bank/withdrawals`
        }
      }
    )

    console.log(`❌ Saque ${id} rejeitado. Motivo: ${reason}`);

    res.json({
      success: true,
      message: 'Saque rejeitado com sucesso',
      withdrawal: withdrawal
    });

  } catch (error) {
    console.error('❌ Erro ao rejeitar saque:', error);
    res.status(500).json({
      success: false,
      error: 'Erro ao rejeitar saque',
      details: error.message
    });
  }
});

/**
 * Listar todos os saques
 */
app.get('/api/withdrawals', async (req, res) => {
  try {
    const db = await readDB();
    const { status, sellerId, userId } = req.query;

    let withdrawals = db.withdrawals || [];

    // Filtrar por status
    if (status) {
      withdrawals = withdrawals.filter(w => w.status === status);
    }

    // Filtrar por vendedor (userId ou sellerId)
    if (userId) {
      withdrawals = withdrawals.filter(w => w.userId === userId || w.sellerId === userId);
    } else if (sellerId) {
      withdrawals = withdrawals.filter(w => w.sellerId === parseInt(sellerId));
    }

    // Ordenar por data de solicitação (mais recentes primeiro)
    withdrawals.sort((a, b) => new Date(b.requestDate || b.createdAt) - new Date(a.requestDate || a.createdAt));

    res.json(withdrawals);

  } catch (error) {
    console.error('❌ Erro ao listar saques:', error);
    res.status(500).json({
      success: false,
      error: 'Erro ao listar saques',
      details: error.message
    });
  }
});

/**
 * Criar nova solicitação de saque
 */
app.post('/api/withdrawals', async (req, res) => {
  try {
    const { userId, amount, bankAccountId, status } = req.body;
    const db = await readDB();

    if (!userId || !amount || !bankAccountId) {
      return res.status(400).json({
        success: false,
        error: 'userId, amount e bankAccountId são obrigatórios'
      });
    }

    // Buscar usuário
    const user = db.users?.find(u => u.id === userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'Usuário não encontrado'
      });
    }

    // Buscar conta bancária
    const bankAccount = user.bankAccounts?.find(ba => ba.id === bankAccountId);
    if (!bankAccount) {
      return res.status(404).json({
        success: false,
        error: 'Conta bancária não encontrada'
      });
    }

    // Criar novo saque
    const newWithdrawal = {
      id: uuidv4(),
      userId,
      amount,
      bankAccountId,
      bankAccount: `${bankAccount.bankName} - Ag: ${bankAccount.agency} - Cc: ${bankAccount.accountNumber}`,
      status: status || 'pending',
      createdAt: new Date().toISOString(),
      requestDate: new Date().toISOString()
    };

    // Adicionar saque ao banco
    if (!db.withdrawals) {
      db.withdrawals = [];
    }
    db.withdrawals.push(newWithdrawal);

    // Salvar no banco
    writeDB(db);

    res.json(newWithdrawal);

  } catch (error) {
    console.error('❌ Erro ao criar saque:', error);
    res.status(500).json({
      success: false,
      error: 'Erro ao criar saque',
      details: error.message
    });
  }
});

/**
 * Buscar detalhes de um saque específico
 */
app.get('/api/withdrawals/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const db = await readDB();

    const withdrawal = db.withdrawals?.find(w => w.id === id);

    if (!withdrawal) {
      return res.status(404).json({
        success: false,
        error: 'Saque não encontrado'
      });
    }

    res.json({
      success: true,
      withdrawal: withdrawal
    });

  } catch (error) {
    console.error('❌ Erro ao buscar saque:', error);
    res.status(500).json({
      success: false,
      error: 'Erro ao buscar saque',
      details: error.message
    });
  }
});

// ============ ENDPOINTS DE CONTAS BANCÁRIAS ============

/**
 * Listar contas bancárias de um usuário
 */
app.get('/api/bank-accounts', async (req, res) => {
  try {
    const { userId } = req.query;
    const db = await readDB();

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'userId é obrigatório'
      });
    }

    // Buscar usuário
    const user = db.users?.find(u => u.id === userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'Usuário não encontrado'
      });
    }

    // Retornar contas bancárias do usuário
    const bankAccounts = user.bankAccounts || [];

    res.json(bankAccounts);

  } catch (error) {
    console.error('❌ Erro ao listar contas bancárias:', error);
    res.status(500).json({
      success: false,
      error: 'Erro ao listar contas bancárias',
      details: error.message
    });
  }
});

/**
 * Criar nova conta bancária
 */
app.post('/api/bank-accounts', async (req, res) => {
  try {
    const { userId, bankCode, bankName, agency, accountNumber, accountType, holderName, holderDocument } = req.body;
    const db = await readDB();

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'userId é obrigatório'
      });
    }

    // Buscar usuário
    const userIndex = db.users?.findIndex(u => u.id === userId);
    if (userIndex === -1) {
      return res.status(404).json({
        success: false,
        error: 'Usuário não encontrado'
      });
    }

    // Criar nova conta bancária
    const newBankAccount = {
      id: uuidv4(),
      bankCode,
      bankName,
      agency,
      accountNumber,
      accountType,
      holderName,
      holderDocument,
      createdAt: new Date().toISOString()
    };

    // Adicionar conta ao usuário
    if (!db.users[userIndex].bankAccounts) {
      db.users[userIndex].bankAccounts = [];
    }
    db.users[userIndex].bankAccounts.push(newBankAccount);

    // Salvar no banco
    writeDB(db);

    res.json({
      success: true,
      bankAccount: newBankAccount
    });

  } catch (error) {
    console.error('❌ Erro ao criar conta bancária:', error);
    res.status(500).json({
      success: false,
      error: 'Erro ao criar conta bancária',
      details: error.message
    });
  }
});

// =====================================================
// ENDPOINTS DE EQUIPE (PLATFORM ADMIN)
// =====================================================

// Listar membros da equipe
app.get('/api/platform/team/members', async (req, res) => {
  try {
    const db = await readDB();

    if (!db.teamMembers) {
      db.teamMembers = [];
    }

    // Enriquecer com dados da função
    const enrichedMembers = db.teamMembers.map(member => {
      const role = (db.teamRoles || []).find(r => r.id === member.roleId);
      return {
        ...member,
        roleName: role?.name || 'Sem função',
        roleColor: role?.color || '#6B7280'
      };
    });

    res.json(enrichedMembers);
  } catch (error) {
    console.error('Erro ao listar membros:', error);
    res.status(500).json({ error: 'Erro ao listar membros da equipe' });
  }
});

// Criar novo membro da equipe
app.post('/api/platform/team/members', async (req, res) => {
  try {
    const db = await readDB();

    if (!db.teamMembers) {
      db.teamMembers = [];
    }

    // Verificar se email já existe
    const existingMember = db.teamMembers.find(m => m.email === req.body.email);
    if (existingMember) {
      return res.status(400).json({ error: 'Email já cadastrado' });
    }

    const newMember = {
      id: db.teamMembers.length + 1,
      ...req.body,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      actionsCount: 0
    };

    db.teamMembers.push(newMember);
    writeDB(db);

    res.json(newMember);
  } catch (error) {
    console.error('Erro ao criar membro:', error);
    res.status(500).json({ error: 'Erro ao criar membro da equipe' });
  }
});

// Atualizar membro da equipe
app.patch('/api/platform/team/members/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const db = await readDB();

    if (!db.teamMembers) {
      return res.status(404).json({ error: 'Membro não encontrado' });
    }

    const memberIndex = db.teamMembers.findIndex(m => m.id === parseInt(id));

    if (memberIndex === -1) {
      return res.status(404).json({ error: 'Membro não encontrado' });
    }

    db.teamMembers[memberIndex] = {
      ...db.teamMembers[memberIndex],
      ...req.body,
      updatedAt: new Date().toISOString()
    };

    writeDB(db);
    res.json(db.teamMembers[memberIndex]);
  } catch (error) {
    console.error('Erro ao atualizar membro:', error);
    res.status(500).json({ error: 'Erro ao atualizar membro da equipe' });
  }
});

// Atualizar status do membro
app.patch('/api/platform/team/members/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const db = await readDB();

    if (!db.teamMembers) {
      return res.status(404).json({ error: 'Membro não encontrado' });
    }

    const memberIndex = db.teamMembers.findIndex(m => m.id === parseInt(id));

    if (memberIndex === -1) {
      return res.status(404).json({ error: 'Membro não encontrado' });
    }

    db.teamMembers[memberIndex].status = status;
    db.teamMembers[memberIndex].updatedAt = new Date().toISOString();

    writeDB(db);
    res.json(db.teamMembers[memberIndex]);
  } catch (error) {
    console.error('Erro ao atualizar status:', error);
    res.status(500).json({ error: 'Erro ao atualizar status do membro' });
  }
});

// Deletar membro da equipe
app.delete('/api/platform/team/members/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const db = await readDB();

    if (!db.teamMembers) {
      return res.status(404).json({ error: 'Membro não encontrado' });
    }

    const memberIndex = db.teamMembers.findIndex(m => m.id === parseInt(id));

    if (memberIndex === -1) {
      return res.status(404).json({ error: 'Membro não encontrado' });
    }

    db.teamMembers.splice(memberIndex, 1);
    writeDB(db);

    res.json({ success: true, message: 'Membro removido com sucesso' });
  } catch (error) {
    console.error('Erro ao deletar membro:', error);
    res.status(500).json({ error: 'Erro ao remover membro da equipe' });
  }
});

// Listar funções (roles)
app.get('/api/platform/team/roles', async (req, res) => {
  try {
    const db = await readDB();

    if (!db.teamRoles) {
      db.teamRoles = [];
    }

    // Contar membros por função
    const rolesWithCounts = db.teamRoles.map(role => ({
      ...role,
      membersCount: (db.teamMembers || []).filter(m => m.roleId === role.id).length
    }));

    res.json(rolesWithCounts);
  } catch (error) {
    console.error('Erro ao listar funções:', error);
    res.status(500).json({ error: 'Erro ao listar funções' });
  }
});

// Criar nova função
app.post('/api/platform/team/roles', async (req, res) => {
  try {
    const db = await readDB();

    if (!db.teamRoles) {
      db.teamRoles = [];
    }

    const newRole = {
      id: db.teamRoles.length + 1,
      ...req.body,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      membersCount: 0
    };

    db.teamRoles.push(newRole);
    writeDB(db);

    res.json(newRole);
  } catch (error) {
    console.error('Erro ao criar função:', error);
    res.status(500).json({ error: 'Erro ao criar função' });
  }
});

// Atualizar função
app.patch('/api/platform/team/roles/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const db = await readDB();

    if (!db.teamRoles) {
      return res.status(404).json({ error: 'Função não encontrada' });
    }

    const roleIndex = db.teamRoles.findIndex(r => r.id === parseInt(id));

    if (roleIndex === -1) {
      return res.status(404).json({ error: 'Função não encontrada' });
    }

    db.teamRoles[roleIndex] = {
      ...db.teamRoles[roleIndex],
      ...req.body,
      updatedAt: new Date().toISOString()
    };

    writeDB(db);
    res.json(db.teamRoles[roleIndex]);
  } catch (error) {
    console.error('Erro ao atualizar função:', error);
    res.status(500).json({ error: 'Erro ao atualizar função' });
  }
});

// Deletar função
app.delete('/api/platform/team/roles/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const db = await readDB();

    if (!db.teamRoles) {
      return res.status(404).json({ error: 'Função não encontrada' });
    }

    const roleIndex = db.teamRoles.findIndex(r => r.id === parseInt(id));

    if (roleIndex === -1) {
      return res.status(404).json({ error: 'Função não encontrada' });
    }

    // Verificar se há membros com esta função
    const hasMembers = (db.teamMembers || []).some(m => m.roleId === parseInt(id));
    if (hasMembers) {
      return res.status(400).json({ error: 'Não é possível excluir função com membros associados' });
    }

    db.teamRoles.splice(roleIndex, 1);
    writeDB(db);

    res.json({ success: true, message: 'Função removida com sucesso' });
  } catch (error) {
    console.error('Erro ao deletar função:', error);
    res.status(500).json({ error: 'Erro ao remover função' });
  }
});

// Listar atividades da equipe
app.get('/api/platform/team/activities', async (req, res) => {
  try {
    const db = await readDB();

    if (!db.teamActivities) {
      db.teamActivities = [];
    }

    // Retornar últimas 100 atividades
    const recentActivities = db.teamActivities.slice(-100).reverse();

    res.json(recentActivities);
  } catch (error) {
    console.error('Erro ao listar atividades:', error);
    res.status(500).json({ error: 'Erro ao listar atividades' });
  }
});

// Registrar nova atividade
app.post('/api/platform/team/activities', async (req, res) => {
  try {
    const db = await readDB();

    if (!db.teamActivities) {
      db.teamActivities = [];
    }

    const newActivity = {
      id: db.teamActivities.length + 1,
      ...req.body,
      timestamp: new Date().toISOString()
    };

    db.teamActivities.push(newActivity);

    // Atualizar contagem de ações do membro
    if (req.body.memberId && db.teamMembers) {
      const memberIndex = db.teamMembers.findIndex(m => m.id === req.body.memberId);
      if (memberIndex !== -1) {
        db.teamMembers[memberIndex].actionsCount = (db.teamMembers[memberIndex].actionsCount || 0) + 1;
        db.teamMembers[memberIndex].lastActivity = new Date().toISOString();
      }
    }

    // Manter apenas últimas 1000 atividades
    if (db.teamActivities.length > 1000) {
      db.teamActivities = db.teamActivities.slice(-1000);
    }

    writeDB(db);
    res.json(newActivity);
  } catch (error) {
    console.error('Erro ao registrar atividade:', error);
    res.status(500).json({ error: 'Erro ao registrar atividade' });
  }
});

// Estatísticas da equipe
app.get('/api/platform/team/stats', async (req, res) => {
  try {
    const db = await readDB();

    const members = db.teamMembers || [];
    const roles = db.teamRoles || [];
    const activities = db.teamActivities || [];

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const todayActivities = activities.filter(a => new Date(a.timestamp) >= today);
    const weekActivities = activities.filter(a => new Date(a.timestamp) >= weekAgo);
    const monthActivities = activities.filter(a => new Date(a.timestamp) >= monthAgo);

    // Membros mais ativos
    const mostActiveMembers = members
      .map(m => ({
        name: m.name,
        actions: m.actionsCount || 0,
        avatar: m.avatar || ''
      }))
      .sort((a, b) => b.actions - a.actions)
      .slice(0, 5);

    // Ações por tipo
    const actionTypes = {};
    activities.forEach(a => {
      const type = a.action || 'Outras';
      actionTypes[type] = (actionTypes[type] || 0) + 1;
    });

    const actionsByType = Object.entries(actionTypes)
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    const stats = {
      totalMembers: members.length,
      activeMembers: members.filter(m => m.status === 'active').length,
      totalRoles: roles.length,
      todayActions: todayActivities.length,
      weekActions: weekActivities.length,
      monthActions: monthActivities.length,
      mostActiveMembers,
      actionsByType
    };

    res.json(stats);
  } catch (error) {
    console.error('Erro ao calcular estatísticas:', error);
    res.status(500).json({ error: 'Erro ao calcular estatísticas da equipe' });
  }
});

// =====================================================
// FIM DOS ENDPOINTS DE EQUIPE
// =====================================================

// =====================================================
// ENDPOINTS DE CONFIGURAÇÕES DA PLATAFORMA
// =====================================================

// GET - Buscar configurações da plataforma
app.get('/api/platform/settings', async (req, res) => {
  try {
    const db = await readDB();
    const settings = db.platformSettings || {
      images: {},
      texts: {},
      extras: {}
    };
    res.json(settings);
  } catch (error) {
    console.error('Erro ao buscar configurações:', error);
    res.status(500).json({ error: 'Erro ao buscar configurações' });
  }
});

// POST - Salvar imagens (favicon e logo)
app.post('/api/platform/settings/images', upload.fields([
  { name: 'favicon', maxCount: 1 },
  { name: 'logo', maxCount: 1 },
  { name: 'achievementLogo', maxCount: 1 }
]), (req, res) => {
  try {
    const db = await readDB();

    if (!db.platformSettings) {
      db.platformSettings = { images: {}, texts: {}, extras: {} };
    }

    if (!db.platformSettings.images) {
      db.platformSettings.images = {};
    }

    // Salvar favicon
    if (req.files && req.files.favicon && req.files.favicon[0]) {
      const faviconPath = `/uploads/${req.files.favicon[0].filename}`;
      db.platformSettings.images.favicon = faviconPath;
      db.platformSettings.images.faviconUrl = `http://localhost:3001${faviconPath}`;
    }

    // Salvar logo
    if (req.files && req.files.logo && req.files.logo[0]) {
      const logoPath = `/uploads/${req.files.logo[0].filename}`;
      db.platformSettings.images.logo = logoPath;
      db.platformSettings.images.logoUrl = `http://localhost:3001${logoPath}`;
    }

    // Salvar achievement logo
    if (req.files && req.files.achievementLogo && req.files.achievementLogo[0]) {
      const achievementLogoPath = `/uploads/${req.files.achievementLogo[0].filename}`;
      db.platformSettings.images.achievementLogo = achievementLogoPath;
      db.platformSettings.images.achievementLogoUrl = `http://localhost:3001${achievementLogoPath}`;
    }

    writeDB(db);

    console.log('✅ Imagens da plataforma salvas com sucesso');

    res.json({
      success: true,
      faviconUrl: db.platformSettings.images.faviconUrl,
      logoUrl: db.platformSettings.images.logoUrl,
      achievementLogoUrl: db.platformSettings.images.achievementLogoUrl,
      message: 'Imagens salvas com sucesso'
    });
  } catch (error) {
    console.error('Erro ao salvar imagens:', error);
    res.status(500).json({ success: false, error: 'Erro ao salvar imagens' });
  }
});

// POST - Salvar textos da plataforma
app.post('/api/platform/settings/texts', async (req, res) => {
  try {
    const db = await readDB();

    if (!db.platformSettings) {
      db.platformSettings = { images: {}, texts: {}, extras: {} };
    }

    db.platformSettings.texts = {
      siteTitle: req.body.siteTitle || 'Pag2Pay',
      siteSubtitle: req.body.siteSubtitle || '',
      siteDescription: req.body.siteDescription || '',
      loginWelcomeMessage: req.body.loginWelcomeMessage || '',
      registerWelcomeMessage: req.body.registerWelcomeMessage || ''
    };

    writeDB(db);

    console.log('✅ Textos da plataforma salvos com sucesso');

    res.json({
      success: true,
      texts: db.platformSettings.texts,
      message: 'Textos salvos com sucesso'
    });
  } catch (error) {
    console.error('Erro ao salvar textos:', error);
    res.status(500).json({ success: false, error: 'Erro ao salvar textos' });
  }
});

// POST - Salvar configurações extras
app.post('/api/platform/settings/extras', async (req, res) => {
  try {
    const db = await readDB();

    if (!db.platformSettings) {
      db.platformSettings = { images: {}, texts: {}, extras: {} };
    }

    db.platformSettings.extras = req.body;

    writeDB(db);

    console.log('✅ Configurações extras da plataforma salvas com sucesso');

    res.json({
      success: true,
      extras: db.platformSettings.extras,
      message: 'Configurações extras salvas com sucesso'
    });
  } catch (error) {
    console.error('Erro ao salvar configurações extras:', error);
    res.status(500).json({ success: false, error: 'Erro ao salvar configurações extras' });
  }
});

// GET: Buscar configurações financeiras (Prefixo da fatura)
app.get('/api/platform/settings/financial', async (req, res) => {
  try {
    const db = await readDB();
    const financial = db.platformSettings?.financial || {};

    res.json({
      success: true,
      financial
    });
  } catch (error) {
    console.error('Erro ao buscar configurações financeiras:', error);
    res.status(500).json({ success: false, error: 'Erro ao buscar configurações financeiras' });
  }
});

// POST: Salvar configurações financeiras (Prefixo da fatura)
app.post('/api/platform/settings/financial', async (req, res) => {
  try {
    const { invoicePrefix } = req.body;

    // Validar prefixo (5-9 caracteres)
    if (!invoicePrefix || invoicePrefix.length < 5 || invoicePrefix.length > 9) {
      return res.status(400).json({
        success: false,
        error: 'O prefixo da fatura deve ter entre 5 e 9 caracteres'
      });
    }

    const db = await readDB();

    if (!db.platformSettings) {
      db.platformSettings = { images: {}, texts: {}, extras: {}, financial: {} };
    }

    // Salvar prefixo
    db.platformSettings.financial = {
      invoicePrefix: invoicePrefix.toUpperCase()
    };

    writeDB(db);

    console.log('✅ Prefixo da fatura salvo com sucesso:', invoicePrefix);

    res.json({
      success: true,
      financial: db.platformSettings.financial,
      message: 'Prefixo da fatura salvo com sucesso'
    });
  } catch (error) {
    console.error('Erro ao salvar configurações financeiras:', error);
    res.status(500).json({ success: false, error: 'Erro ao salvar configurações financeiras' });
  }
});

// GET: Buscar configurações de roteamento de adquirentes
app.get('/api/platform/settings/acquirer-routing', async (req, res) => {
  try {
    const db = await readDB();
    const routing = db.platformSettings?.acquirerRouting || {
      pix: [],
      cartao: [],
      boleto: [],
      saque: []
    };

    res.json({
      success: true,
      routing
    });
  } catch (error) {
    console.error('Erro ao buscar configurações de roteamento:', error);
    res.status(500).json({ success: false, error: 'Erro ao buscar configurações de roteamento' });
  }
});

// POST: Salvar configurações de roteamento de adquirentes
app.post('/api/platform/settings/acquirer-routing', async (req, res) => {
  try {
    const { pix, cartao, boleto, saque } = req.body;

    const db = await readDB();

    if (!db.platformSettings) {
      db.platformSettings = { images: {}, texts: {}, extras: {}, financial: {}, acquirerRouting: {} };
    }

    // Salvar configuração de roteamento
    db.platformSettings.acquirerRouting = {
      pix: pix || [],
      cartao: cartao || [],
      boleto: boleto || [],
      saque: saque || []
    };

    writeDB(db);

    console.log('✅ Configurações de roteamento de adquirentes salvas com sucesso');

    res.json({
      success: true,
      routing: db.platformSettings.acquirerRouting,
      message: 'Configurações de roteamento salvas com sucesso'
    });
  } catch (error) {
    console.error('Erro ao salvar configurações de roteamento:', error);
    res.status(500).json({ success: false, error: 'Erro ao salvar configurações de roteamento' });
  }
});

// =====================================================
// FIM DOS ENDPOINTS DE CONFIGURAÇÕES
// =====================================================

// ========== ENDPOINTS DE LOGS DA PLATAFORMA ==========

// Obter todos os logs da plataforma
app.get('/api/platform/logs', async (req, res) => {
  console.log('📋 Buscando logs da plataforma...');

  const db = await readDB();
  let logs = db.platformLogs || [];

  // Filtros opcionais
  const { level, limit, offset, search } = req.query;

  // Filtrar por nível
  if (level && level !== 'all') {
    logs = logs.filter(log => log.level === level);
  }

  // Busca por texto
  if (search) {
    const searchLower = search.toLowerCase();
    logs = logs.filter(log =>
      log.description.toLowerCase().includes(searchLower) ||
      log.user.toLowerCase().includes(searchLower) ||
      log.action.toLowerCase().includes(searchLower) ||
      (log.details && log.details.toLowerCase().includes(searchLower))
    );
  }

  // Total antes da paginação
  const total = logs.length;

  // Paginação
  const limitNum = parseInt(limit) || 100;
  const offsetNum = parseInt(offset) || 0;
  logs = logs.slice(offsetNum, offsetNum + limitNum);

  console.log(`✅ Retornando ${logs.length} logs (total: ${total})`);

  res.json({
    success: true,
    total,
    logs
  });
});

// Criar um novo log manualmente (para testes)
app.post('/api/platform/logs', async (req, res) => {
  const { level, action, user, description, details } = req.body;
  const ip = req.ip || req.connection.remoteAddress;

  const success = logger[level](action, user, description, ip, details);

  if (success) {
    console.log(`✅ Log registrado: ${action}`);
    res.json({ success: true, message: 'Log registrado com sucesso' });
  } else {
    console.error('❌ Erro ao registrar log');
    res.status(500).json({ success: false, message: 'Erro ao registrar log' });
  }
});

// Limpar logs (apenas para admin)
app.delete('/api/platform/logs', async (req, res) => {
  console.log('🗑️ Limpando logs da plataforma...');

  const db = await readDB();
  db.platformLogs = [];
  saveDB(db);

  console.log('✅ Logs limpos com sucesso');
  res.json({ success: true, message: 'Logs limpos com sucesso' });
});

console.log('⏰ Jobs agendados:');
console.log('  - Rastreio Correios: a cada 15 minutos');
console.log('  - Verificação de pagamento: a cada 5 minutos');
console.log('  - Verificação AfterPay: diariamente às 00:00');
console.log('  - Expiração PIX: a cada 1 hora');
console.log('  - Expiração Boleto: diariamente às 06:00');

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`📊 API disponível em http://localhost:${PORT}/api`);
  console.log(`💳 Endpoints de pagamento disponíveis:`);
  console.log(`   - POST /api/payments/pix/generate`);
  console.log(`   - POST /api/payments/boleto/generate`);
  console.log(`   - POST /api/payments/credit-card/process`);
  console.log(`🤝 Endpoints de afiliação disponíveis:`);
  console.log(`   - GET  /api/affiliations/status/:productId/:userId`);
  console.log(`   - POST /api/affiliations`);
  console.log(`   - PATCH /api/affiliations/:id/approve`);
  console.log(`⚡ Turbina Scores: Execute manualmente 'node migrations/add-turbina-score.js'`);
  console.log(`⏰ Turbina Scores atualizam automaticamente a cada 1 hora via cron job`);
});
