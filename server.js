import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';

// Carregar variáveis de ambiente
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const DB_FILE = './database.json';

// Configuração CORS para produção
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5173',
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
          password: 'admin123',
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
      products: [
        {
          id: '1',
          code: 'pro9yxgx',
          name: 'Curso de Marketing Digital',
          description: 'Aprenda estratégias avançadas de marketing',
          price: 497.00,
          image: 'https://via.placeholder.com/300x200/4F46E5/FFFFFF?text=Marketing+Digital',
          stock: 50,
          producerId: '2',
          producerName: 'Usuário Demo',
          affiliateEnabled: true,
          affiliateCommission: 30,
          paymentMethods: {
            pix: true,
            boleto: true,
            creditCard: true,
            afterPay: true
          },
          category: 'Educação',
          productType: 'Curso',
          status: 'active',
          approvalStatus: 'APROVADO'
        },
        {
          id: '2',
          code: 'proe78xe',
          name: 'E-book: Vendas Online',
          description: 'Guia completo para vender na internet',
          price: 97.00,
          image: 'https://via.placeholder.com/300x200/7C3AED/FFFFFF?text=E-book+Vendas',
          stock: 100,
          producerId: '2',
          producerName: 'Usuário Demo',
          affiliateEnabled: true,
          affiliateCommission: 40,
          paymentMethods: {
            pix: true,
            boleto: true,
            creditCard: true,
            afterPay: false
          },
          category: 'Marketing',
          productType: 'E-book',
          status: 'active',
          approvalStatus: 'PENDENTE'
        },
        {
          id: '3',
          code: 'prom4vgk',
          name: 'Mentoria Individual',
          description: 'Sessões personalizadas de consultoria',
          price: 997.00,
          image: 'https://via.placeholder.com/300x200/059669/FFFFFF?text=Mentoria',
          stock: 10,
          producerId: '2',
          producerName: 'Usuário Demo',
          affiliateEnabled: false,
          affiliateCommission: 0,
          paymentMethods: {
            pix: true,
            boleto: false,
            creditCard: true,
            afterPay: false
          },
          category: 'Negócios',
          productType: 'Assinatura',
          status: 'active',
          approvalStatus: 'AGUARDANDO ALTERAÇÃO'
        }
      ],
      orders: [
        {
          id: 'demo-order-1',
          productId: '1',
          productName: 'Curso de Marketing Digital',
          productPrice: 497.00,
          quantity: 1,
          totalValue: 497.00,
          producerId: '2',
          producerName: 'Usuário Demo',
          affiliateId: null,
          affiliateName: null,
          producerCommission: 497.00,
          affiliateCommission: 0,
          customer: {
            name: 'Cliente Teste',
            email: 'cliente@exemplo.com',
            phone: '(11) 99999-9999',
            address: 'Rua Exemplo, 123',
            city: 'São Paulo',
            state: 'SP',
            zipCode: '01234-567'
          },
          paymentMethod: 'pix',
          paymentStatus: 'paid',
          status: 'shipped',
          trackingCode: 'BR123456789',
          shippingInfo: {
            carrier: 'Correios',
            estimatedDelivery: '2026-03-05',
            shippingStatus: 'shipped',
            shippingDate: new Date().toISOString()
          },
          createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
          updatedAt: new Date().toISOString(),
          paidAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString()
        }
      ],
      affiliations: [],
      commissions: []
    };
    writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2));
  }
}

function readDB() {
  return JSON.parse(readFileSync(DB_FILE, 'utf-8'));
}

function writeDB(data) {
  writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

initDB();

// Rotas de Autenticação

// Login de Usuário
app.post('/api/auth/login/user', (req, res) => {
  const db = readDB();
  const { email, password } = req.body;

  const user = db.users.find(u => u.email === email && u.password === password && u.role === 'user');

  if (user) {
    const { password, ...userWithoutPassword } = user;
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
app.post('/api/auth/login/admin', (req, res) => {
  const db = readDB();
  const { email, password } = req.body;

  const user = db.users.find(u => u.email === email && u.password === password && u.role === 'admin');

  if (user) {
    const { password, ...userWithoutPassword } = user;
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
app.post('/api/auth/login', (req, res) => {
  const db = readDB();
  const { email, password } = req.body;

  const user = db.users.find(u => u.email === email && u.password === password);

  if (user) {
    const { password, ...userWithoutPassword } = user;
    res.json({
      success: true,
      user: userWithoutPassword,
      token: uuidv4()
    });
  } else {
    res.status(401).json({ success: false, error: 'Email ou senha inválidos' });
  }
});

app.post('/api/auth/register', (req, res) => {
  const db = readDB();
  const { email, password, name } = req.body;

  const existingUser = db.users.find(u => u.email === email);
  if (existingUser) {
    return res.status(400).json({ success: false, error: 'Email já cadastrado' });
  }

  const newUser = {
    id: uuidv4(),
    email,
    password,
    name,
    role: 'user',
    createdAt: new Date().toISOString()
  };

  db.users.push(newUser);
  writeDB(db);

  const { password: _, ...userWithoutPassword } = newUser;
  res.status(201).json({
    success: true,
    user: userWithoutPassword,
    token: uuidv4()
  });
});

// Rotas de Produtos
app.get('/api/products', (req, res) => {
  const db = readDB();
  const { userId, type } = req.query;

  let products = db.products;

  if (type === 'my-products' && userId) {
    products = products.filter(p => p.producerId === userId);
  } else if (type === 'affiliate-store') {
    products = products.filter(p => p.affiliateEnabled && p.status === 'active');
  } else if (type === 'my-affiliations' && userId) {
    const userAffiliations = db.affiliations.filter(a => a.affiliateId === userId);
    const affiliatedProductIds = userAffiliations.map(a => a.productId);
    products = products.filter(p => affiliatedProductIds.includes(p.id));
  }

  res.json(products);
});

app.get('/api/products/:id', (req, res) => {
  const db = readDB();
  const product = db.products.find(p => p.id === req.params.id);
  if (product) {
    res.json(product);
  } else {
    res.status(404).json({ error: 'Produto não encontrado' });
  }
});

app.post('/api/products', (req, res) => {
  const db = readDB();
  const productData = req.body;

  const newProduct = {
    id: uuidv4(),
    code: generateProductCode(),
    ...productData,
    createdAt: new Date().toISOString(),
    status: 'active',
    approvalStatus: 'PENDENTE'
  };

  db.products.push(newProduct);
  writeDB(db);

  res.status(201).json(newProduct);
});

app.patch('/api/products/:id', (req, res) => {
  const db = readDB();
  const productIndex = db.products.findIndex(p => p.id === req.params.id);

  if (productIndex === -1) {
    return res.status(404).json({ error: 'Produto não encontrado' });
  }

  db.products[productIndex] = {
    ...db.products[productIndex],
    ...req.body,
    updatedAt: new Date().toISOString()
  };

  writeDB(db);
  res.json(db.products[productIndex]);
});

// Rotas de Afiliações
app.post('/api/affiliations', (req, res) => {
  const db = readDB();
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

app.get('/api/affiliations', (req, res) => {
  const db = readDB();
  const { affiliateId } = req.query;

  let affiliations = db.affiliations;

  if (affiliateId) {
    affiliations = affiliations.filter(a => a.affiliateId === affiliateId);
  }

  res.json(affiliations);
});

// Rotas de Pedidos
app.post('/api/orders', (req, res) => {
  const db = readDB();
  const { productId, customer, quantity = 1, paymentMethod = 'pix', affiliateId = null } = req.body;

  const product = db.products.find(p => p.id === productId);
  if (!product) {
    return res.status(404).json({ error: 'Produto não encontrado' });
  }

  const totalValue = product.price * quantity;

  // Calcular comissões
  let producerCommission = totalValue;
  let affiliateCommission = 0;

  if (affiliateId && product.affiliateEnabled) {
    affiliateCommission = (totalValue * product.affiliateCommission) / 100;
    producerCommission = totalValue - affiliateCommission;
  }

  const order = {
    id: uuidv4(),
    productId,
    productName: product.name,
    productPrice: product.price,
    quantity,
    totalValue,
    producerId: product.producerId,
    producerName: product.producerName,
    affiliateId,
    affiliateName: affiliateId ? db.users.find(u => u.id === affiliateId)?.name : null,
    producerCommission,
    affiliateCommission,
    customer,
    paymentMethod,
    paymentStatus: paymentMethod === 'afterPay' ? 'pending_delivery' : 'pending',
    status: 'pending', // pending -> shipped -> delivered -> paid
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

  // Criar registro de comissão
  if (affiliateCommission > 0) {
    const commission = {
      id: uuidv4(),
      orderId: order.id,
      productId,
      producerId: product.producerId,
      affiliateId,
      producerCommission,
      affiliateCommission,
      totalValue,
      status: 'pending',
      createdAt: new Date().toISOString()
    };
    db.commissions.push(commission);
  }

  writeDB(db);

  res.status(201).json(order);
});

app.get('/api/orders', (req, res) => {
  const db = readDB();
  res.json(db.orders);
});

app.get('/api/orders/:id', (req, res) => {
  const db = readDB();
  const order = db.orders.find(o => o.id === req.params.id);
  if (order) {
    res.json(order);
  } else {
    res.status(404).json({ error: 'Pedido não encontrado' });
  }
});

app.patch('/api/orders/:id', (req, res) => {
  const db = readDB();
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
  res.json(db.orders[orderIndex]);
});

// Rotas de Comissões
app.get('/api/commissions', (req, res) => {
  const db = readDB();
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

// Rotas de Usuários (Admin)
app.get('/api/users', (req, res) => {
  const db = readDB();
  const users = db.users.map(user => {
    const { password, ...userWithoutPassword } = user;
    return userWithoutPassword;
  });
  res.json(users);
});

app.patch('/api/users/:id', (req, res) => {
  const db = readDB();
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

app.delete('/api/users/:id', (req, res) => {
  const db = readDB();
  const userIndex = db.users.findIndex(u => u.id === req.params.id);

  if (userIndex === -1) {
    return res.status(404).json({ error: 'Usuário não encontrado' });
  }

  db.users.splice(userIndex, 1);
  writeDB(db);

  res.json({ success: true, message: 'Usuário excluído com sucesso' });
});

// Dashboard Stats
app.get('/api/dashboard/stats', (req, res) => {
  const db = readDB();
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

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`📊 API disponível em http://localhost:${PORT}/api`);
});
