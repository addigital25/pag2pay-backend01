import express from 'express';

const router = express.Router();

// ============ PRODUTOS ============

// GET /api/platform/products - Listar todos os produtos (com paginação e filtros)
router.get('/', (req, res) => {
  const db = req.app.get('readDB')();
  const {
    status,
    search,
    category,
    seller,
    minPrice,
    maxPrice,
    minSales,
    maxSales,
    page = 1,
    limit = 10,
    sortBy = 'createdAt',
    sortOrder = 'desc'
  } = req.query;

  // Converter produtos do database.json para o formato esperado pelo Platform Admin
  let products = (db.products || []).map(product => ({
    ...product, // Incluir TODOS os campos do produto original
    seller: product.producerName,
    sellerId: product.producerId,
    sales: 0, // TODO: calcular vendas reais
    revenue: 0, // TODO: calcular receita real
    commission: 0, // TODO: calcular comissão real
    status: product.approvalStatus === 'APROVADO' ? 'active' :
            product.approvalStatus === 'PENDENTE' ? 'pending' : 'suspended',
    pendingReason: product.approvalStatus === 'PENDENTE' ? 'Aguardando aprovação inicial' :
                   product.rejectionReason || undefined,
    suspensionReason: product.approvalStatus === 'SUSPENSO' ? product.suspensionReason : undefined
  }));

  // Filtros
  if (status) {
    products = products.filter(p => p.status === status);
  }

  if (category) {
    products = products.filter(p => p.category === category);
  }

  if (seller) {
    const sellerLower = seller.toLowerCase();
    products = products.filter(p => p.seller.toLowerCase().includes(sellerLower));
  }

  // Filtros de preço
  if (minPrice) {
    products = products.filter(p => p.price >= parseFloat(minPrice));
  }

  if (maxPrice) {
    products = products.filter(p => p.price <= parseFloat(maxPrice));
  }

  // Filtros de vendas
  if (minSales) {
    products = products.filter(p => (p.sales || 0) >= parseInt(minSales));
  }

  if (maxSales) {
    products = products.filter(p => (p.sales || 0) <= parseInt(maxSales));
  }

  // Busca textual
  if (search) {
    const searchLower = search.toLowerCase();
    products = products.filter(p =>
      p.name.toLowerCase().includes(searchLower) ||
      p.seller.toLowerCase().includes(searchLower) ||
      p.category.toLowerCase().includes(searchLower)
    );
  }

  // Ordenação
  products.sort((a, b) => {
    let aVal = a[sortBy];
    let bVal = b[sortBy];

    // Para datas
    if (sortBy === 'createdAt') {
      aVal = new Date(aVal).getTime();
      bVal = new Date(bVal).getTime();
    }

    // Para números
    if (['price', 'sales', 'revenue', 'commission'].includes(sortBy)) {
      aVal = aVal || 0;
      bVal = bVal || 0;
    }

    if (sortOrder === 'asc') {
      return aVal > bVal ? 1 : -1;
    } else {
      return aVal < bVal ? 1 : -1;
    }
  });

  // Se não tiver parâmetros de paginação, retornar array simples
  // (compatibilidade com frontend que espera array direto)
  if (!req.query.page && !req.query.limit && Object.keys(req.query).length === 0) {
    return res.json(products);
  }

  // Paginação (para uso futuro)
  const pageNum = parseInt(page);
  const limitNum = parseInt(limit);
  const startIndex = (pageNum - 1) * limitNum;
  const endIndex = startIndex + limitNum;
  const totalProducts = products.length;
  const totalPages = Math.ceil(totalProducts / limitNum);
  const paginatedProducts = products.slice(startIndex, endIndex);

  // Estatísticas dos produtos filtrados
  const stats = {
    totalRevenue: products.reduce((sum, p) => sum + (p.revenue || 0), 0),
    totalSales: products.reduce((sum, p) => sum + (p.sales || 0), 0),
    totalCommission: products.reduce((sum, p) => sum + (p.commission || 0), 0),
    averagePrice: products.length > 0
      ? products.reduce((sum, p) => sum + p.price, 0) / products.length
      : 0
  };

  res.json({
    products: paginatedProducts,
    pagination: {
      currentPage: pageNum,
      totalPages,
      totalItems: totalProducts,
      itemsPerPage: limitNum,
      hasNextPage: pageNum < totalPages,
      hasPrevPage: pageNum > 1
    },
    stats,
    filters: {
      status,
      category,
      seller,
      minPrice,
      maxPrice,
      minSales,
      maxSales,
      search
    }
  });
});

// GET /api/platform/products/:id - Obter produto por ID
router.get('/:id', (req, res) => {
  const db = req.app.get('readDB')();
  const product = db.products?.find(p => p.id == req.params.id);

  if (!product) {
    return res.status(404).json({ error: 'Produto não encontrado' });
  }

  // Retornar produto completo com todos os campos + campos calculados do Platform Admin
  const platformProduct = {
    ...product, // Todos os campos originais do produto
    seller: product.producerName,
    sellerId: product.producerId,
    sales: 0,
    revenue: 0,
    commission: 0,
    status: product.approvalStatus === 'APROVADO' ? 'active' :
            product.approvalStatus === 'PENDENTE' ? 'pending' : 'suspended',
    pendingReason: product.approvalStatus === 'PENDENTE' ? 'Aguardando aprovação inicial' :
                   product.rejectionReason || undefined,
    suspensionReason: product.approvalStatus === 'SUSPENSO' ? product.suspensionReason : undefined
  };

  res.json(platformProduct);
});

// PATCH /api/platform/products/:id/approve - Aprovar produto
router.patch('/:id/approve', (req, res) => {
  const db = req.app.get('readDB')();
  const productIndex = db.products?.findIndex(p => p.id == req.params.id);

  if (productIndex === -1 || productIndex === undefined) {
    return res.status(404).json({ error: 'Produto não encontrado' });
  }

  // Atualizar status
  db.products[productIndex].approvalStatus = 'APROVADO';
  db.products[productIndex].approvedAt = new Date().toISOString();

  req.app.get('writeDB')(db);

  console.log(`✅ [PLATFORM] Produto aprovado: ${db.products[productIndex].name}`);

  res.json({
    success: true,
    message: 'Produto aprovado com sucesso'
  });
});

// PATCH /api/platform/products/:id/reject - Rejeitar produto
router.patch('/:id/reject', (req, res) => {
  const db = req.app.get('readDB')();
  const { reason } = req.body;
  const productIndex = db.products?.findIndex(p => p.id == req.params.id);

  if (productIndex === -1 || productIndex === undefined) {
    return res.status(404).json({ error: 'Produto não encontrado' });
  }

  // Atualizar status
  db.products[productIndex].approvalStatus = 'REJEITADO';
  db.products[productIndex].rejectedAt = new Date().toISOString();
  db.products[productIndex].rejectionReason = reason || 'Não especificado';

  req.app.get('writeDB')(db);

  console.log(`❌ [PLATFORM] Produto rejeitado: ${db.products[productIndex].name}`);

  res.json({
    success: true,
    message: 'Produto rejeitado'
  });
});

// DELETE /api/platform/products/:id - Excluir produto permanentemente
router.delete('/:id', (req, res) => {
  const db = req.app.get('readDB')();
  const productIndex = db.products?.findIndex(p => p.id == req.params.id);

  if (productIndex === -1 || productIndex === undefined) {
    return res.status(404).json({ error: 'Produto não encontrado' });
  }

  const productName = db.products[productIndex].name;
  const productId = db.products[productIndex].id;

  // Remover produto do array
  db.products.splice(productIndex, 1);

  req.app.get('writeDB')(db);

  console.log(`🗑️ [PLATFORM] Produto excluído permanentemente: ${productName} (ID: ${productId})`);

  res.json({
    success: true,
    message: 'Produto excluído com sucesso'
  });
});

// PATCH /api/platform/products/:id/status - Atualizar status do produto
router.patch('/:id/status', (req, res) => {
  const db = req.app.get('readDB')();
  const { status } = req.body;
  const productIndex = db.products?.findIndex(p => p.id == req.params.id);

  if (productIndex === -1 || productIndex === undefined) {
    return res.status(404).json({ error: 'Produto não encontrado' });
  }

  // Mapear status do Platform Admin para database.json
  const statusMap = {
    'active': 'APROVADO',
    'pending': 'PENDENTE',
    'suspended': 'SUSPENSO'
  };

  db.products[productIndex].approvalStatus = statusMap[status] || status;
  db.products[productIndex].statusUpdatedAt = new Date().toISOString();

  req.app.get('writeDB')(db);

  res.json({
    success: true,
    message: 'Status atualizado'
  });
});

// PATCH /api/platform/products/:id/suspend - Suspender produto
router.patch('/:id/suspend', (req, res) => {
  const db = req.app.get('readDB')();
  const { reason } = req.body;
  const productIndex = db.products?.findIndex(p => p.id == req.params.id);

  if (productIndex === -1 || productIndex === undefined) {
    return res.status(404).json({ error: 'Produto não encontrado' });
  }

  // Atualizar status
  db.products[productIndex].approvalStatus = 'SUSPENSO';
  db.products[productIndex].suspendedAt = new Date().toISOString();
  db.products[productIndex].suspensionReason = reason || 'Não especificado';

  req.app.get('writeDB')(db);

  console.log(`⛔ [PLATFORM] Produto suspenso: ${db.products[productIndex].name}`);

  res.json({
    success: true,
    message: 'Produto suspenso'
  });
});

// POST /api/platform/products/:id/request-deletion - Solicitar exclusão de produto
router.post('/:id/request-deletion', (req, res) => {
  const db = req.app.get('readDB')();
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
  req.app.get('writeDB')(db);

  console.log(`🗑️ [PLATFORM] Solicitação de exclusão criada para produto: ${product.name} por ${userName}`);

  res.json({
    success: true,
    message: 'Solicitação de exclusão enviada com sucesso',
    request: deletionRequest
  });
});

// GET /api/platform/deletion-requests - Listar todas as solicitações de exclusão
router.get('/deletion-requests/all', (req, res) => {
  const db = req.app.get('readDB')();
  const { status } = req.query;

  let requests = db.deletionRequests || [];

  // Filtrar por status se fornecido
  if (status) {
    requests = requests.filter(r => r.status === status);
  }

  // Ordenar por data (mais recentes primeiro)
  requests.sort((a, b) => new Date(b.requestedAt) - new Date(a.requestedAt));

  res.json(requests);
});

// PATCH /api/platform/deletion-requests/:id/approve - Aprovar exclusão
router.patch('/deletion-requests/:id/approve', (req, res) => {
  const db = req.app.get('readDB')();
  const { reviewerName, notes } = req.body;
  const requestIndex = db.deletionRequests?.findIndex(r => r.id == req.params.id);

  if (requestIndex === -1 || requestIndex === undefined) {
    return res.status(404).json({ error: 'Solicitação não encontrada' });
  }

  const request = db.deletionRequests[requestIndex];

  // Atualizar solicitação
  db.deletionRequests[requestIndex].status = 'approved';
  db.deletionRequests[requestIndex].reviewedAt = new Date().toISOString();
  db.deletionRequests[requestIndex].reviewedBy = reviewerName;
  db.deletionRequests[requestIndex].reviewerNotes = notes;

  // Encontrar e mover o produto para produtos excluídos
  const productIndex = db.products?.findIndex(p => p.id === request.productId);

  if (productIndex !== -1 && productIndex !== undefined) {
    const product = db.products[productIndex];

    // Inicializar array de produtos excluídos se não existir
    if (!db.deletedProducts) {
      db.deletedProducts = [];
    }

    // Adicionar informações de exclusão ao produto
    const deletedProduct = {
      ...product,
      deletedAt: new Date().toISOString(),
      deletionReason: request.reason,
      deletedBy: request.userName,
      approvedBy: reviewerName
    };

    db.deletedProducts.push(deletedProduct);

    // Remover produto da lista ativa
    db.products.splice(productIndex, 1);
  }

  req.app.get('writeDB')(db);

  console.log(`✅ [PLATFORM] Exclusão aprovada e produto removido: ${request.productName}`);

  res.json({
    success: true,
    message: 'Exclusão aprovada e produto removido com sucesso'
  });
});

// PATCH /api/platform/deletion-requests/:id/reject - Rejeitar exclusão
router.patch('/deletion-requests/:id/reject', (req, res) => {
  const db = req.app.get('readDB')();
  const { reviewerName, notes } = req.body;
  const requestIndex = db.deletionRequests?.findIndex(r => r.id == req.params.id);

  if (requestIndex === -1 || requestIndex === undefined) {
    return res.status(404).json({ error: 'Solicitação não encontrada' });
  }

  // Atualizar solicitação
  db.deletionRequests[requestIndex].status = 'rejected';
  db.deletionRequests[requestIndex].reviewedAt = new Date().toISOString();
  db.deletionRequests[requestIndex].reviewedBy = reviewerName;
  db.deletionRequests[requestIndex].reviewerNotes = notes;

  req.app.get('writeDB')(db);

  console.log(`❌ [PLATFORM] Exclusão rejeitada: ${db.deletionRequests[requestIndex].productName}`);

  res.json({
    success: true,
    message: 'Solicitação de exclusão rejeitada'
  });
});

// GET /api/platform/deleted-products - Listar produtos excluídos
router.get('/deleted-products/all', (req, res) => {
  const db = req.app.get('readDB')();
  const deletedProducts = db.deletedProducts || [];

  // Ordenar por data de exclusão (mais recentes primeiro)
  const sorted = deletedProducts.sort((a, b) =>
    new Date(b.deletedAt) - new Date(a.deletedAt)
  );

  res.json(sorted);
});

export default router;
