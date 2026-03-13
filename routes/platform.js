import express from 'express';
import speakeasy from 'speakeasy';
import QRCode from 'qrcode';
import { authMiddleware, adminMiddleware, generateToken } from '../middleware/auth.js';
import { comparePassword, hashPassword } from '../utils/password.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

// Função auxiliar para ler o banco de dados
const getDB = (readDB) => readDB();
const saveDB = (writeDB, data) => writeDB(data);

// ============ AUTENTICAÇÃO ============

// Login do Platform Admin (Etapa 1: validar email/senha)
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const db = getDB(req.app.get('readDB'));

    // Procurar admin no database (somente em platformAdmins)
    const admin = db.platformAdmins?.find(a => a.email === email);

    if (!admin) {
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }

    // Verificar senha
    const isPasswordValid = await comparePassword(password, admin.password);

    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }

    // Se 2FA estiver desabilitado, gerar token diretamente
    if (!admin.twoFactorEnabled) {
      const user = {
        id: admin.id,
        email: admin.email,
        name: admin.name,
        role: 'admin',
        userType: 'platform-admin'
      };

      const token = generateToken(user);

      // Salvar token no database
      admin.platform_token = token;
      const adminIndex = db.platformAdmins?.findIndex(a => a.id === admin.id);
      if (adminIndex !== -1) {
        db.platformAdmins[adminIndex] = admin;
        saveDB(req.app.get('writeDB'), db);
      }

      return res.json({
        requiresTwoFactor: false,
        token,
        user: {
          id: admin.id,
          email: admin.email,
          name: admin.name,
          role: 'admin',
          userType: 'platform-admin'
        }
      });
    }

    // Retornar status do 2FA se estiver habilitado
    return res.json({
      requiresTwoFactor: true,
      email: admin.email
    });
  } catch (error) {
    console.error('Erro no login:', error);
    return res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Gerar QR Code para configurar 2FA
router.post('/2fa/setup', async (req, res) => {
  const { email } = req.body;

  try {
    const db = getDB(req.app.get('readDB'));
    const adminIndex = db.platformAdmins?.findIndex(a => a.email === email);

    if (adminIndex === -1) {
      return res.status(404).json({ error: 'Administrador não encontrado' });
    }

    const admin = db.platformAdmins[adminIndex];

    // Gerar secret se ainda não tiver
    if (!admin.twoFactorSecret) {
      const secret = speakeasy.generateSecret({
        name: `Pag2Pay Platform (${email})`,
        issuer: 'Pag2Pay'
      });

      admin.twoFactorSecret = secret.base32;
      db.platformAdmins[adminIndex] = admin;
      saveDB(req.app.get('writeDB'), db);
    }

    // Gerar QR Code
    const otpauthUrl = speakeasy.otpauthURL({
      secret: admin.twoFactorSecret,
      label: email,
      issuer: 'Pag2Pay Platform',
      encoding: 'base32'
    });

    const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);

    return res.json({
      qrCode: qrCodeDataUrl,
      secret: admin.twoFactorSecret
    });
  } catch (error) {
    console.error('Erro ao gerar 2FA:', error);
    return res.status(500).json({ error: 'Erro ao gerar código 2FA' });
  }
});

// Verificar código 2FA e fazer login
router.post('/2fa/verify', async (req, res) => {
  const { email, token: twoFactorToken } = req.body;

  try {
    const db = getDB(req.app.get('readDB'));
    const adminIndex = db.platformAdmins?.findIndex(a => a.email === email);

    if (adminIndex === -1) {
      return res.status(404).json({ error: 'Administrador não encontrado' });
    }

    const admin = db.platformAdmins[adminIndex];

    if (!admin.twoFactorSecret) {
      return res.status(400).json({ error: '2FA não configurado' });
    }

    // Verificar código TOTP
    const verified = speakeasy.totp.verify({
      secret: admin.twoFactorSecret,
      encoding: 'base32',
      token: twoFactorToken,
      window: 2 // Aceita códigos de 1 minuto antes/depois (tolerância)
    });

    if (!verified) {
      return res.status(401).json({ error: 'Código de verificação inválido' });
    }

    // Ativar 2FA se ainda não estiver ativo
    if (!admin.twoFactorEnabled) {
      admin.twoFactorEnabled = true;
      db.platformAdmins[adminIndex] = admin;
      saveDB(req.app.get('writeDB'), db);
    }

    // Gerar token JWT
    const user = {
      id: admin.id,
      email: admin.email,
      name: admin.name,
      userType: 'platform-admin'
    };

    const token = generateToken(user);

    return res.json({
      user,
      token
    });
  } catch (error) {
    console.error('Erro ao verificar 2FA:', error);
    return res.status(500).json({ error: 'Erro ao verificar código' });
  }
});

// ============ ESTATÍSTICAS ============

// GET /api/platform/stats - Estatísticas gerais
router.get('/stats', authMiddleware, adminMiddleware, (req, res) => {
  console.log('📊 [PLATFORM STATS] Endpoint /api/platform/stats foi chamado');
  console.log('📊 [PLATFORM STATS] User:', req.user?.id, req.user?.email);
  const db = getDB(req.app.get('readDB'));

  // Usar db.users para usuários reais
  const allUsers = db.users || [];
  const allProducts = db.products || [];
  const allOrders = db.orders || [];

  // Calcular receita total de pedidos pagos
  const paidOrders = allOrders.filter(o => o.paymentStatus === 'paid');
  const totalRevenue = paidOrders.reduce((sum, o) => sum + (o.totalValue || 0), 0);

  // Calcular comissão da plataforma (3% sobre cada venda)
  const platformCommissionRate = 0.03;
  const totalCommission = totalRevenue * platformCommissionRate;

  const stats = {
    totalUsers: allUsers.length,
    pendingUsers: allUsers.filter(u => u.status === 'pending').length,
    approvedUsers: allUsers.filter(u => u.status === 'approved' || u.role === 'user').length,
    totalProducts: allProducts.length,
    pendingProducts: allProducts.filter(p => p.status === 'pending').length,
    activeProducts: allProducts.filter(p => p.status === 'active' || p.status === 'approved').length,
    totalRevenue: parseFloat(totalRevenue.toFixed(2)),
    totalCommission: parseFloat(totalCommission.toFixed(2))
  };

  console.log('📊 [PLATFORM STATS] Retornando stats:', stats);
  res.json(stats);
});

// GET /api/platform/financial-stats - Estatísticas financeiras detalhadas
router.get('/financial-stats', authMiddleware, adminMiddleware, (req, res) => {
  const db = getDB(req.app.get('readDB'));

  // Calcular receita total de todos os pedidos pagos
  const allOrders = db.orders || [];
  const paidOrders = allOrders.filter(o => o.paymentStatus === 'paid');
  const totalRevenue = paidOrders.reduce((sum, o) => sum + (o.totalValue || 0), 0);

  // Calcular comissão da plataforma (assumindo 3% sobre cada venda)
  const platformCommissionRate = 0.03;
  const platformCommission = totalRevenue * platformCommissionRate;

  // Calcular receita mensal (últimos 30 dias)
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const monthlyOrders = paidOrders.filter(o => new Date(o.createdAt) >= thirtyDaysAgo);
  const monthlyRevenue = monthlyOrders.reduce((sum, o) => sum + (o.totalValue || 0), 0);

  // Calcular crescimento mensal (comparar com 30 dias anteriores)
  const sixtyDaysAgo = new Date();
  sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
  const previousMonthOrders = paidOrders.filter(o => {
    const orderDate = new Date(o.createdAt);
    return orderDate >= sixtyDaysAgo && orderDate < thirtyDaysAgo;
  });
  const previousMonthRevenue = previousMonthOrders.reduce((sum, o) => sum + (o.totalValue || 0), 0);
  const monthlyGrowth = previousMonthRevenue > 0
    ? ((monthlyRevenue - previousMonthRevenue) / previousMonthRevenue) * 100
    : monthlyRevenue > 0 ? 100 : 0;

  // Dados de vendas dos últimos 6 meses
  const salesData = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const monthDate = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const nextMonth = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);

    const monthOrders = paidOrders.filter(o => {
      const orderDate = new Date(o.createdAt);
      return orderDate >= monthDate && orderDate < nextMonth;
    });

    const monthRevenue = monthOrders.reduce((sum, o) => sum + (o.totalValue || 0), 0);
    const monthCommission = monthRevenue * platformCommissionRate;

    salesData.push({
      name: monthDate.toLocaleDateString('pt-BR', { month: 'short' }),
      vendas: parseFloat(monthRevenue.toFixed(2)),
      comissão: parseFloat(monthCommission.toFixed(2))
    });
  }

  // Usuários recentes
  const recentUsers = (db.users || [])
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 5)
    .map(u => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      createdAt: u.createdAt
    }));

  // Top produtos (ordenados por número de vendas)
  const productSales = {};
  paidOrders.forEach(order => {
    order.items?.forEach(item => {
      if (!productSales[item.productId]) {
        productSales[item.productId] = {
          productId: item.productId,
          productName: item.productName || 'Produto',
          totalSales: 0,
          totalRevenue: 0,
          quantity: 0
        };
      }
      productSales[item.productId].totalSales += 1;
      productSales[item.productId].quantity += item.quantity || 1;
      productSales[item.productId].totalRevenue += (item.price || 0) * (item.quantity || 1);
    });
  });

  const topProducts = Object.values(productSales)
    .sort((a, b) => b.totalRevenue - a.totalRevenue)
    .slice(0, 5)
    .map(p => ({
      ...p,
      totalRevenue: parseFloat(p.totalRevenue.toFixed(2))
    }));

  const stats = {
    totalRevenue: parseFloat(totalRevenue.toFixed(2)),
    platformCommission: parseFloat(platformCommission.toFixed(2)),
    monthlyRevenue: parseFloat(monthlyRevenue.toFixed(2)),
    monthlyGrowth: parseFloat(monthlyGrowth.toFixed(2))
  };

  res.json({
    success: true,
    stats,
    salesData,
    recentUsers,
    topProducts
  });
});

// ============ USUÁRIOS ============

// GET /api/platform/users - Listar todos os usuários (com paginação e filtros)
router.get('/users', authMiddleware, adminMiddleware, (req, res) => {
  const db = getDB(req.app.get('readDB'));
  const {
    status,
    search,
    accountType,
    withdrawalLocked,
    splitStatus,
    page = 1,
    limit = 10,
    sortBy = 'createdAt',
    sortOrder = 'desc'
  } = req.query;

  console.log('📊 [PLATFORM USERS] Endpoint chamado, total users no DB:', db.users?.length || 0);

  // CORREÇÃO: Usar db.users ao invés de db.platformUsers
  let users = db.users || [];

  // FILTRAR: Esconder admin master (role: 'admin') da lista de usuários
  // O admin master não deve aparecer na lista para evitar exclusão acidental
  users = users.filter(u => u.role !== 'admin');

  console.log('📊 [PLATFORM USERS] Users carregados:', users.length);

  // Filtros
  if (status) {
    users = users.filter(u => u.status === status);
  }

  if (accountType) {
    users = users.filter(u => u.accountType === accountType);
  }

  if (withdrawalLocked !== undefined) {
    const isLocked = withdrawalLocked === 'true';
    users = users.filter(u => u.withdrawalLocked === isLocked);
  }

  if (splitStatus) {
    users = users.filter(u => u.splitStatus === splitStatus);
  }

  // Busca textual
  if (search) {
    const searchLower = search.toLowerCase();
    users = users.filter(u =>
      u.name.toLowerCase().includes(searchLower) ||
      u.email.toLowerCase().includes(searchLower) ||
      (u.cpf && u.cpf.includes(search)) ||
      (u.cnpj && u.cnpj.includes(search)) ||
      (u.phone && u.phone.includes(search))
    );
  }

  // Ordenação
  users.sort((a, b) => {
    let aVal = a[sortBy];
    let bVal = b[sortBy];

    // Para datas
    if (sortBy === 'createdAt') {
      aVal = new Date(aVal).getTime();
      bVal = new Date(bVal).getTime();
    }

    // Para números
    if (sortBy === 'totalSales' || sortBy === 'totalProducts') {
      aVal = aVal || 0;
      bVal = bVal || 0;
    }

    if (sortOrder === 'asc') {
      return aVal > bVal ? 1 : -1;
    } else {
      return aVal < bVal ? 1 : -1;
    }
  });

  // Paginação
  const pageNum = parseInt(page);
  const limitNum = parseInt(limit);
  const startIndex = (pageNum - 1) * limitNum;
  const endIndex = startIndex + limitNum;
  const totalUsers = users.length;
  const totalPages = Math.ceil(totalUsers / limitNum);
  const paginatedUsers = users.slice(startIndex, endIndex);

  // Mapear usuários para garantir que todos tenham um status
  // E COMBINAR com dados de userVerifications (se existirem)
  const mappedUsers = paginatedUsers.map(user => {
    // Buscar dados de verificação em userVerifications
    const verification = db.userVerifications?.find(v => v.userId === user.id);

    console.log('🔍 [MAPPING USER]', user.email, '- Tem verification:', !!verification);

    return {
      ...user,
      // Se não tiver status, definir como 'novo' (usuário recém-criado sem documentos)
      status: user.status || 'novo',
      // Garantir que tem accountType
      accountType: user.accountType || verification?.accountType || (user.cnpj ? 'pj' : 'pf'),
      // ADICIONAR dados de verification (se existir)
      ...(verification && {
        formData: verification.formData,
        kyc: verification.kyc,
        documentos: verification.documentos,
        dadosBancarios: verification.dadosBancarios,
        documents: verification.documents,
        verificationStatus: verification.status,
        submittedAt: verification.submittedAt,
        updatedAt: verification.updatedAt
      })
    };
  });

  console.log('📊 [PLATFORM USERS] Retornando', mappedUsers.length, 'usuários (página', pageNum, 'de', totalPages, ')');
  console.log('📊 [PLATFORM USERS] Total filtrado:', totalUsers);

  res.json({
    users: mappedUsers,
    pagination: {
      currentPage: pageNum,
      totalPages,
      totalItems: totalUsers,
      itemsPerPage: limitNum,
      hasNextPage: pageNum < totalPages,
      hasPrevPage: pageNum > 1
    },
    filters: {
      status,
      accountType,
      withdrawalLocked,
      splitStatus,
      search
    }
  });
});

// GET /api/platform/users/:id - Obter usuário por ID
router.get('/users/:id', authMiddleware, adminMiddleware, (req, res) => {
  const db = getDB(req.app.get('readDB'));
  const userId = req.params.id;

  // Buscar usuário em db.users
  const user = db.users?.find(u => u.id === userId);

  if (!user) {
    return res.status(404).json({ error: 'Usuário não encontrado' });
  }

  // Buscar dados de verificação em userVerifications
  const verification = db.userVerifications?.find(v => v.userId === userId);

  // Combinar dados do usuário com dados de verificação
  const combinedUser = {
    ...user,
    // Se houver verification, adicionar os dados
    ...(verification && {
      formData: verification.formData,
      accountType: verification.accountType || (user.cnpj ? 'pj' : 'pf'),
      kyc: verification.kyc,
      documentos: verification.documentos,
      dadosBancarios: verification.dadosBancarios,
      documents: verification.documents,
      verificationStatus: verification.status,
      submittedAt: verification.submittedAt,
      updatedAt: verification.updatedAt
    })
  };

  console.log('📋 [GET USER BY ID] Usuário:', userId, '- Tem verification:', !!verification);

  res.json(combinedUser);
});

// POST /api/platform/users/:id/approve - Aprovar usuário
router.post('/users/:id/approve', authMiddleware, adminMiddleware, (req, res) => {
  const db = getDB(req.app.get('readDB'));
  const userId = req.params.id; // UUID é string, não usar parseInt
  const userIndex = db.platformUsers?.findIndex(u => u.id === userId);

  if (userIndex === -1 || userIndex === undefined) {
    return res.status(404).json({ error: 'Usuário não encontrado' });
  }

  // Atualizar status
  db.platformUsers[userIndex].status = 'approved';
  db.platformUsers[userIndex].approvedAt = new Date().toISOString();
  db.platformUsers[userIndex].approvedBy = req.user.id;

  // Aprovar documentos e dados bancários
  if (db.platformUsers[userIndex].documentos) {
    db.platformUsers[userIndex].documentos.statusSelfie = 'approved';
    db.platformUsers[userIndex].documentos.statusDocumento = 'approved';
    if (db.platformUsers[userIndex].documentos.statusContrato) {
      db.platformUsers[userIndex].documentos.statusContrato = 'approved';
    }
  }

  if (db.platformUsers[userIndex].dadosBancarios) {
    db.platformUsers[userIndex].dadosBancarios.status = 'approved';
  }

  // Mudar status do usuário para 'aprovado' em db.users
  const userInUsersIndex = db.users?.findIndex(u => u.id === userId);
  if (userInUsersIndex !== -1 && userInUsersIndex !== undefined) {
    const currentStatus = db.users[userInUsersIndex].status;
    db.users[userInUsersIndex].status = 'aprovado';
    console.log(`✅ [APPROVE] Status do usuário alterado: ${currentStatus} → aprovado`);
  } else {
    console.log(`⚠️ [APPROVE] Usuário ${userId} não encontrado em db.users`);
  }

  saveDB(req.app.get('writeDB'), db);

  // Registrar log
  const ip = req.ip || req.connection.remoteAddress;
  logger.success(
    'APPROVAL_GRANTED',
    req.user.email || 'admin@platform.com',
    `Usuário ${db.platformUsers[userIndex].name} aprovado`,
    ip,
    `ID: ${userId}, Email: ${db.platformUsers[userIndex].email}`
  );

  res.json({
    message: 'Usuário aprovado com sucesso',
    user: db.platformUsers[userIndex]
  });
});

// POST /api/platform/users/:id/reject - Rejeitar usuário
router.post('/users/:id/reject', authMiddleware, adminMiddleware, (req, res) => {
  const db = getDB(req.app.get('readDB'));
  const userId = req.params.id; // UUID é string, não usar parseInt
  const { reason } = req.body;
  const userIndex = db.platformUsers?.findIndex(u => u.id === userId);

  if (userIndex === -1 || userIndex === undefined) {
    return res.status(404).json({ error: 'Usuário não encontrado' });
  }

  // Atualizar status
  db.platformUsers[userIndex].status = 'rejected';
  db.platformUsers[userIndex].pendingReason = reason || 'Não aprovado';
  db.platformUsers[userIndex].rejectedAt = new Date().toISOString();
  db.platformUsers[userIndex].rejectedBy = req.user.id;

  // Mudar status do usuário para 'rejeitado' em db.users
  const userInUsersIndex = db.users?.findIndex(u => u.id === userId);
  if (userInUsersIndex !== -1 && userInUsersIndex !== undefined) {
    const currentStatus = db.users[userInUsersIndex].status;
    db.users[userInUsersIndex].status = 'rejeitado';
    console.log(`❌ [REJECT] Status do usuário alterado: ${currentStatus} → rejeitado`);
  } else {
    console.log(`⚠️ [REJECT] Usuário ${userId} não encontrado em db.users`);
  }

  saveDB(req.app.get('writeDB'), db);

  // Registrar log
  const ip = req.ip || req.connection.remoteAddress;
  logger.warning(
    'APPROVAL_REJECTED',
    req.user.email || 'admin@platform.com',
    `Usuário ${db.platformUsers[userIndex].name} rejeitado`,
    ip,
    `Motivo: ${reason || 'Não especificado'}`
  );

  res.json({
    message: 'Usuário rejeitado',
    user: db.platformUsers[userIndex]
  });
});

// PATCH /api/platform/users/:id/status - Atualizar status do usuário
router.patch('/users/:id/status', authMiddleware, adminMiddleware, (req, res) => {
  const db = getDB(req.app.get('readDB'));
  const userId = req.params.id; // UUID é string, não usar parseInt
  const { status } = req.body;
  const userIndex = db.platformUsers?.findIndex(u => u.id === userId);

  if (userIndex === -1 || userIndex === undefined) {
    return res.status(404).json({ error: 'Usuário não encontrado' });
  }

  db.platformUsers[userIndex].status = status;
  db.platformUsers[userIndex].statusUpdatedAt = new Date().toISOString();

  saveDB(req.app.get('writeDB'), db);

  res.json({
    message: 'Status atualizado',
    user: db.platformUsers[userIndex]
  });
});

// POST /api/platform/users/:id/lock-withdrawal - Travar/Destravar saque
router.post('/users/:id/lock-withdrawal', authMiddleware, adminMiddleware, (req, res) => {
  const db = getDB(req.app.get('readDB'));
  const userId = req.params.id; // UUID é string, não usar parseInt
  const { locked } = req.body;
  const userIndex = db.platformUsers?.findIndex(u => u.id === userId);

  if (userIndex === -1 || userIndex === undefined) {
    return res.status(404).json({ error: 'Usuário não encontrado' });
  }

  db.platformUsers[userIndex].withdrawalLocked = locked;
  db.platformUsers[userIndex].withdrawalLockedAt = new Date().toISOString();
  db.platformUsers[userIndex].withdrawalLockedBy = req.user.id;

  saveDB(req.app.get('writeDB'), db);

  res.json({
    message: locked ? 'Saque travado' : 'Saque destravado',
    user: db.platformUsers[userIndex]
  });
});

// POST /api/platform/users/:id/documents/:type/approve - Aprovar documento específico
router.post('/users/:id/documents/:type/approve', authMiddleware, adminMiddleware, (req, res) => {
  const db = getDB(req.app.get('readDB'));
  const userId = req.params.id; // UUID é string
  const { type } = req.params;
  const userIndex = db.platformUsers?.findIndex(u => u.id === userId);

  if (userIndex === -1 || userIndex === undefined) {
    return res.status(404).json({ error: 'Usuário não encontrado' });
  }

  if (!db.platformUsers[userIndex].documentos) {
    return res.status(400).json({ error: 'Usuário não possui documentos' });
  }

  const statusField = `status${type.charAt(0).toUpperCase()}${type.slice(1)}`;
  db.platformUsers[userIndex].documentos[statusField] = 'approved';

  saveDB(req.app.get('writeDB'), db);

  res.json({ message: 'Documento aprovado' });
});

// POST /api/platform/users/:id/documents/:type/reject - Rejeitar documento específico
router.post('/users/:id/documents/:type/reject', authMiddleware, adminMiddleware, (req, res) => {
  const db = getDB(req.app.get('readDB'));
  const userId = req.params.id; // UUID é string
  const { type } = req.params;
  const { reason } = req.body;
  const userIndex = db.platformUsers?.findIndex(u => u.id === userId);

  if (userIndex === -1 || userIndex === undefined) {
    return res.status(404).json({ error: 'Usuário não encontrado' });
  }

  if (!db.platformUsers[userIndex].documentos) {
    return res.status(400).json({ error: 'Usuário não possui documentos' });
  }

  const statusField = `status${type.charAt(0).toUpperCase()}${type.slice(1)}`;
  db.platformUsers[userIndex].documentos[statusField] = 'rejected';
  db.platformUsers[userIndex].documentos[`${type}RejectionReason`] = reason;

  saveDB(req.app.get('writeDB'), db);

  res.json({ message: 'Documento rejeitado' });
});

// POST /api/platform/users/:id/bank-account/approve - Aprovar conta bancária
router.post('/users/:id/bank-account/approve', authMiddleware, adminMiddleware, (req, res) => {
  const db = getDB(req.app.get('readDB'));
  const userId = req.params.id; // UUID é string
  const userIndex = db.platformUsers?.findIndex(u => u.id === userId);

  if (userIndex === -1 || userIndex === undefined) {
    return res.status(404).json({ error: 'Usuário não encontrado' });
  }

  if (db.platformUsers[userIndex].dadosBancarios) {
    db.platformUsers[userIndex].dadosBancarios.status = 'approved';
  }

  saveDB(req.app.get('writeDB'), db);

  res.json({ message: 'Conta bancária aprovada' });
});

// POST /api/platform/users/:id/bank-account/reject - Rejeitar conta bancária
router.post('/users/:id/bank-account/reject', authMiddleware, adminMiddleware, (req, res) => {
  const db = getDB(req.app.get('readDB'));
  const userId = req.params.id; // UUID é string
  const { reason } = req.body;
  const userIndex = db.platformUsers?.findIndex(u => u.id === userId);

  if (userIndex === -1 || userIndex === undefined) {
    return res.status(404).json({ error: 'Usuário não encontrado' });
  }

  if (db.platformUsers[userIndex].dadosBancarios) {
    db.platformUsers[userIndex].dadosBancarios.status = 'rejected';
    db.platformUsers[userIndex].dadosBancarios.rejectionReason = reason;
  }

  saveDB(req.app.get('writeDB'), db);

  res.json({ message: 'Conta bancária rejeitada' });
});

// ============ APROVAÇÕES POR SEÇÃO ============

// POST /api/platform/users/:id/section/approve - Aprovar seção específica (KYC, Documentos, Conta Bancária)
router.post('/users/:id/section/approve', authMiddleware, adminMiddleware, (req, res) => {
  const db = getDB(req.app.get('readDB'));
  const userId = req.params.id; // UUID é string
  const { section } = req.body; // 'kyc', 'documentos', 'conta_bancaria'
  const userIndex = db.platformUsers?.findIndex(u => u.id === userId);

  if (userIndex === -1 || userIndex === undefined) {
    return res.status(404).json({ error: 'Usuário não encontrado' });
  }

  // Aprovar a seção específica
  switch(section) {
    case 'kyc':
      if (!db.platformUsers[userIndex].kyc) {
        return res.status(400).json({ error: 'KYC não encontrado' });
      }
      db.platformUsers[userIndex].kyc.status = 'approved';
      db.platformUsers[userIndex].kyc.approvedAt = new Date().toISOString();
      db.platformUsers[userIndex].kyc.approvedBy = req.user.id;
      break;

    case 'documentos':
      if (!db.platformUsers[userIndex].documentos) {
        return res.status(400).json({ error: 'Documentos não encontrados' });
      }
      db.platformUsers[userIndex].documentos.statusSelfie = 'approved';
      db.platformUsers[userIndex].documentos.statusDocumento = 'approved';
      if (db.platformUsers[userIndex].accountType === 'pj' && db.platformUsers[userIndex].documentos.statusContratoSocial) {
        db.platformUsers[userIndex].documentos.statusContratoSocial = 'approved';
      }
      db.platformUsers[userIndex].documentos.approvedAt = new Date().toISOString();
      db.platformUsers[userIndex].documentos.approvedBy = req.user.id;
      break;

    case 'conta_bancaria':
      if (!db.platformUsers[userIndex].dadosBancarios) {
        return res.status(400).json({ error: 'Dados bancários não encontrados' });
      }
      db.platformUsers[userIndex].dadosBancarios.status = 'approved';
      db.platformUsers[userIndex].dadosBancarios.approvedAt = new Date().toISOString();
      db.platformUsers[userIndex].dadosBancarios.approvedBy = req.user.id;
      break;

    default:
      return res.status(400).json({ error: 'Seção inválida' });
  }

  saveDB(req.app.get('writeDB'), db);

  res.json({
    message: `${section} aprovado com sucesso`,
    user: db.platformUsers[userIndex]
  });
});

// POST /api/platform/users/:id/section/reject - Rejeitar seção específica
router.post('/users/:id/section/reject', authMiddleware, adminMiddleware, (req, res) => {
  const db = getDB(req.app.get('readDB'));
  const userId = req.params.id; // UUID é string
  const { section, reason } = req.body;
  const userIndex = db.platformUsers?.findIndex(u => u.id === userId);

  if (userIndex === -1 || userIndex === undefined) {
    return res.status(404).json({ error: 'Usuário não encontrado' });
  }

  // Rejeitar a seção específica
  switch(section) {
    case 'kyc':
      if (!db.platformUsers[userIndex].kyc) {
        return res.status(400).json({ error: 'KYC não encontrado' });
      }
      db.platformUsers[userIndex].kyc.status = 'rejected';
      db.platformUsers[userIndex].kyc.rejectionReason = reason;
      db.platformUsers[userIndex].kyc.rejectedAt = new Date().toISOString();
      db.platformUsers[userIndex].kyc.rejectedBy = req.user.id;
      break;

    case 'documentos':
      if (!db.platformUsers[userIndex].documentos) {
        return res.status(400).json({ error: 'Documentos não encontrados' });
      }
      db.platformUsers[userIndex].documentos.statusSelfie = 'rejected';
      db.platformUsers[userIndex].documentos.statusDocumento = 'rejected';
      db.platformUsers[userIndex].documentos.rejectionReason = reason;
      db.platformUsers[userIndex].documentos.rejectedAt = new Date().toISOString();
      db.platformUsers[userIndex].documentos.rejectedBy = req.user.id;
      break;

    case 'conta_bancaria':
      if (!db.platformUsers[userIndex].dadosBancarios) {
        return res.status(400).json({ error: 'Dados bancários não encontrados' });
      }
      db.platformUsers[userIndex].dadosBancarios.status = 'rejected';
      db.platformUsers[userIndex].dadosBancarios.rejectionReason = reason;
      db.platformUsers[userIndex].dadosBancarios.rejectedAt = new Date().toISOString();
      db.platformUsers[userIndex].dadosBancarios.rejectedBy = req.user.id;
      break;

    default:
      return res.status(400).json({ error: 'Seção inválida' });
  }

  saveDB(req.app.get('writeDB'), db);

  res.json({
    message: `${section} rejeitado`,
    user: db.platformUsers[userIndex]
  });
});

// POST /api/platform/users/:id/request-changes - Solicitar alterações ao usuário
router.post('/users/:id/request-changes', authMiddleware, adminMiddleware, (req, res) => {
  const db = getDB(req.app.get('readDB'));
  const userId = req.params.id; // UUID é string, não usar parseInt
  const { section, message } = req.body;
  const userIndex = db.platformUsers?.findIndex(u => u.id === userId);

  if (userIndex === -1 || userIndex === undefined) {
    return res.status(404).json({ error: 'Usuário não encontrado' });
  }

  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Mensagem é obrigatória' });
  }

  // Criar notificação/mensagem para o usuário
  if (!db.platformUsers[userIndex].notifications) {
    db.platformUsers[userIndex].notifications = [];
  }

  const notification = {
    id: Date.now(),
    type: 'change_request',
    section: section,
    message: message,
    createdAt: new Date().toISOString(),
    createdBy: req.user.id,
    read: false
  };

  db.platformUsers[userIndex].notifications.push(notification);

  // Atualizar status da seção para "pending_changes"
  switch(section) {
    case 'KYC':
      if (db.platformUsers[userIndex].kyc) {
        db.platformUsers[userIndex].kyc.status = 'pending_changes';
        db.platformUsers[userIndex].kyc.changeRequestMessage = message;
      }
      break;
    case 'Documentos':
      if (db.platformUsers[userIndex].documentos) {
        db.platformUsers[userIndex].documentos.statusSelfie = 'pending_changes';
        db.platformUsers[userIndex].documentos.statusDocumento = 'pending_changes';
        db.platformUsers[userIndex].documentos.changeRequestMessage = message;
      }
      break;
    case 'Conta Bancária':
      if (db.platformUsers[userIndex].dadosBancarios) {
        db.platformUsers[userIndex].dadosBancarios.status = 'pending_changes';
        db.platformUsers[userIndex].dadosBancarios.changeRequestMessage = message;
      }
      break;
  }

  // Mudar status do usuário para 'aguardando_ajuste'
  // Procurar usuário em db.users (usar userId diretamente)
  const userInUsersIndex = db.users?.findIndex(u => u.id === userId);
  if (userInUsersIndex !== -1 && userInUsersIndex !== undefined) {
    const currentStatus = db.users[userInUsersIndex].status;
    db.users[userInUsersIndex].status = 'aguardando_ajuste';
    console.log(`📝 [REQUEST CHANGES] Status do usuário alterado: ${currentStatus} → aguardando_ajuste`);
  } else {
    console.log(`⚠️ [REQUEST CHANGES] Usuário ${userId} não encontrado em db.users`);
  }

  saveDB(req.app.get('writeDB'), db);

  res.json({
    message: 'Solicitação de alteração enviada ao usuário',
    notification: notification
  });
});

// ============ LOGS ============

// GET /api/platform/logs - Listar logs do sistema (auditoria de ações)
router.get('/logs', authMiddleware, adminMiddleware, (req, res) => {
  const { level, search, limit = 100, offset = 0 } = req.query;

  // Logs mockados de auditoria de ações do sistema
  const allLogs = [
    {
      id: '1',
      timestamp: new Date().toISOString(),
      level: 'info',
      action: 'USER_LOGIN',
      user: 'admin@pag2pay.com',
      description: 'Login bem-sucedido no Platform Admin',
      ip: '192.168.1.100',
      details: 'Autenticação 2FA concluída'
    },
    {
      id: '2',
      timestamp: new Date(Date.now() - 15 * 60000).toISOString(),
      level: 'success',
      action: 'USER_APPROVED',
      user: 'admin@pag2pay.com',
      description: 'Usuário aprovado com sucesso',
      ip: '192.168.1.100',
      details: 'Documentos verificados e aprovados'
    },
    {
      id: '3',
      timestamp: new Date(Date.now() - 30 * 60000).toISOString(),
      level: 'warning',
      action: 'USER_REJECTED',
      user: 'admin@pag2pay.com',
      description: 'Usuário rejeitado',
      ip: '192.168.1.100',
      details: 'Motivo: Documento ilegível'
    },
    {
      id: '4',
      timestamp: new Date(Date.now() - 60 * 60000).toISOString(),
      level: 'info',
      action: 'SETTINGS_UPDATED',
      user: 'admin@pag2pay.com',
      description: 'Configurações da plataforma atualizadas',
      ip: '192.168.1.100',
      details: 'Comissão alterada'
    },
    {
      id: '5',
      timestamp: new Date(Date.now() - 90 * 60000).toISOString(),
      level: 'error',
      action: 'API_ERROR',
      user: 'system',
      description: 'Erro na integração com API externa',
      ip: 'internal',
      details: 'Timeout ao conectar com serviço de pagamento'
    }
  ];

  let logs = [...allLogs];

  // Filtros
  if (level && level !== 'all') {
    logs = logs.filter(log => log.level === level);
  }

  if (search) {
    const searchLower = search.toLowerCase();
    logs = logs.filter(log =>
      (log.description || '').toLowerCase().includes(searchLower) ||
      (log.user || '').toLowerCase().includes(searchLower) ||
      (log.action || '').toLowerCase().includes(searchLower)
    );
  }

  // Paginação
  const total = logs.length;
  const paginatedLogs = logs.slice(parseInt(offset), parseInt(offset) + parseInt(limit));

  res.json({
    success: true,
    logs: paginatedLogs,
    total: total
  });
});

// DELETE /platform/users/:userId - Excluir usuário
router.delete('/users/:userId', authMiddleware, adminMiddleware, (req, res) => {
  const { userId } = req.params;

  console.log('🗑️ [DELETE USER] Tentando excluir usuário:', userId);

  try {
    const db = getDB(req.app.get('readDB'));

    // Encontrar usuário
    const userIndex = db.users.findIndex(u => u.id === userId);

    if (userIndex === -1) {
      console.log('❌ [DELETE USER] Usuário não encontrado:', userId);
      return res.status(404).json({
        success: false,
        error: 'Usuário não encontrado'
      });
    }

    const user = db.users[userIndex];

    // Verificar se é admin (não pode excluir admin)
    if (user.role === 'admin') {
      console.log('❌ [DELETE USER] Tentativa de excluir admin:', userId);
      return res.status(403).json({
        success: false,
        error: 'Não é possível excluir um administrador'
      });
    }

    // Remover usuário do array
    db.users.splice(userIndex, 1);

    // Salvar no database.json
    saveDB(req.app.get('writeDB'), db);

    console.log('✅ [DELETE USER] Usuário excluído com sucesso:', user.name);

    // Log da ação
    if (!db.logs) {
      db.logs = [];
    }
    db.logs.push({
      id: `log-${Date.now()}`,
      action: 'delete_user',
      description: `Usuário ${user.name} (${user.email}) foi excluído do sistema`,
      user: req.user?.email || 'admin',
      timestamp: new Date().toISOString(),
      metadata: {
        userId: user.id,
        userName: user.name,
        userEmail: user.email
      }
    });
    saveDB(req.app.get('writeDB'), db);

    res.json({
      success: true,
      message: `Usuário ${user.name} excluído com sucesso`
    });
  } catch (error) {
    console.error('❌ [DELETE USER] Erro:', error);
    res.status(500).json({
      success: false,
      error: 'Erro ao excluir usuário'
    });
  }
});

export default router;
