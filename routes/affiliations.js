import express from 'express';
import { readFileSync, writeFileSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();
const DB_FILE = './database.json';

// Função para ler o banco de dados
function readDatabase() {
  try {
    const data = readFileSync(DB_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Erro ao ler database:', error);
    return { users: [], products: [], affiliations: [], sales: [] };
  }
}

// Função para salvar no banco de dados
function saveDatabase(data) {
  try {
    writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
    return true;
  } catch (error) {
    console.error('Erro ao salvar database:', error);
    return false;
  }
}

// GET /api/affiliations/status/:productId/:userId
// Verifica o status de afiliação de um usuário para um produto
router.get('/status/:productId/:userId', (req, res) => {
  try {
    const { productId, userId } = req.params;
    const db = readDatabase();

    // Inicializar affiliations se não existir
    if (!db.affiliations) {
      db.affiliations = [];
    }

    // Buscar afiliação existente
    const affiliation = db.affiliations.find(
      a => a.productId === productId && a.affiliateId === userId
    );

    if (!affiliation) {
      return res.json({
        status: 'not_affiliated',
        affiliateId: null
      });
    }

    // Retornar status da afiliação
    res.json({
      status: affiliation.status, // 'pending', 'approved', 'rejected'
      affiliateId: affiliation.status === 'approved' ? affiliation.id : null
    });
  } catch (error) {
    console.error('Erro ao verificar status de afiliação:', error);
    res.status(500).json({ error: 'Erro ao verificar status de afiliação' });
  }
});

// POST /api/affiliations
// Cria uma nova solicitação de afiliação
router.post('/', (req, res) => {
  try {
    const { productId, affiliateId } = req.body;

    if (!productId || !affiliateId) {
      return res.status(400).json({ error: 'productId e affiliateId são obrigatórios' });
    }

    const db = readDatabase();

    // Inicializar affiliations se não existir
    if (!db.affiliations) {
      db.affiliations = [];
    }

    // Verificar se já existe solicitação
    const existingAffiliation = db.affiliations.find(
      a => a.productId === productId && a.affiliateId === affiliateId
    );

    if (existingAffiliation) {
      return res.status(400).json({
        error: 'Você já possui uma solicitação para este produto',
        status: existingAffiliation.status
      });
    }

    // Buscar produto para obter configuração
    const product = db.products.find(p => p.id === productId);
    if (!product) {
      return res.status(404).json({ error: 'Produto não encontrado' });
    }

    // Verificar se produto está disponível para afiliação
    if (!product.affiliateConfig?.participateInProgram) {
      return res.status(400).json({ error: 'Este produto não está disponível para afiliação' });
    }

    // Determinar status inicial baseado em auto-aprovação
    const initialStatus = product.affiliateConfig?.autoApproval ? 'approved' : 'pending';

    // Criar nova afiliação
    const newAffiliation = {
      id: uuidv4(),
      productId,
      affiliateId,
      status: initialStatus, // 'pending', 'approved', 'rejected'
      createdAt: new Date().toISOString(),
      approvedAt: initialStatus === 'approved' ? new Date().toISOString() : null,
      rejectedAt: null,
      // Copiar configuração de comissão do produto
      commissionType: product.affiliateConfig?.commissionType || 'Último Clique',
      commissionMode: product.affiliateConfig?.commissionMode || 'percentage',
      commissionValue: product.affiliateConfig?.commissionValue || 55,
      cookieDuration: product.affiliateConfig?.cookieDuration || 'Eterno',
      // Estatísticas
      totalSales: 0,
      totalCommission: 0,
      clicks: 0,
      conversions: 0
    };

    db.affiliations.push(newAffiliation);

    if (saveDatabase(db)) {
      res.status(201).json({
        success: true,
        message: initialStatus === 'approved'
          ? 'Afiliação aprovada automaticamente!'
          : 'Solicitação de afiliação enviada com sucesso!',
        affiliation: newAffiliation
      });
    } else {
      res.status(500).json({ error: 'Erro ao salvar afiliação' });
    }
  } catch (error) {
    console.error('Erro ao criar afiliação:', error);
    res.status(500).json({ error: 'Erro ao criar afiliação' });
  }
});

// PATCH /api/affiliations/:id/approve
// Aprova uma solicitação de afiliação
router.patch('/:id/approve', (req, res) => {
  try {
    const { id } = req.params;
    const db = readDatabase();

    if (!db.affiliations) {
      return res.status(404).json({ error: 'Afiliação não encontrada' });
    }

    const affiliation = db.affiliations.find(a => a.id === id);

    if (!affiliation) {
      return res.status(404).json({ error: 'Afiliação não encontrada' });
    }

    if (affiliation.status === 'approved') {
      return res.status(400).json({ error: 'Esta afiliação já está aprovada' });
    }

    // Buscar produto para obter comissão padrão
    const product = db.products?.find(p => p.id === affiliation.productId);

    // Atualizar status
    affiliation.status = 'approved';
    affiliation.approvedAt = new Date().toISOString();
    affiliation.rejectedAt = null;

    // Se não tiver comissão individual definida, usar a comissão padrão do produto
    if (affiliation.individualCommission === undefined || affiliation.individualCommission === null) {
      const defaultCommission = product?.affiliateConfig?.commissionValue || affiliation.commissionValue || 0;
      affiliation.individualCommission = defaultCommission;
      console.log(`✅ Afiliado aprovado com comissão padrão: ${defaultCommission}%`);
    }

    if (saveDatabase(db)) {
      res.json({
        success: true,
        message: 'Afiliação aprovada com sucesso!',
        affiliation
      });
    } else {
      res.status(500).json({ error: 'Erro ao aprovar afiliação' });
    }
  } catch (error) {
    console.error('Erro ao aprovar afiliação:', error);
    res.status(500).json({ error: 'Erro ao aprovar afiliação' });
  }
});

// PATCH /api/affiliations/:id/reject
// Rejeita uma solicitação de afiliação
router.patch('/:id/reject', (req, res) => {
  try {
    const { id } = req.params;
    const db = readDatabase();

    if (!db.affiliations) {
      return res.status(404).json({ error: 'Afiliação não encontrada' });
    }

    const affiliation = db.affiliations.find(a => a.id === id);

    if (!affiliation) {
      return res.status(404).json({ error: 'Afiliação não encontrada' });
    }

    // Atualizar status
    affiliation.status = 'rejected';
    affiliation.rejectedAt = new Date().toISOString();
    affiliation.approvedAt = null;

    if (saveDatabase(db)) {
      res.json({
        success: true,
        message: 'Afiliação rejeitada',
        affiliation
      });
    } else {
      res.status(500).json({ error: 'Erro ao rejeitar afiliação' });
    }
  } catch (error) {
    console.error('Erro ao rejeitar afiliação:', error);
    res.status(500).json({ error: 'Erro ao rejeitar afiliação' });
  }
});

// GET /api/affiliations/product/:productId
// Lista todas as afiliações de um produto
router.get('/product/:productId', (req, res) => {
  try {
    const { productId } = req.params;
    const db = readDatabase();

    if (!db.affiliations) {
      return res.json([]);
    }

    const affiliations = db.affiliations.filter(a => a.productId === productId);

    // Enriquecer com dados do afiliado
    const enrichedAffiliations = affiliations.map(affiliation => {
      const affiliate = db.users?.find(u => u.id === affiliation.affiliateId);
      return {
        ...affiliation,
        affiliate: affiliate ? {
          id: affiliate.id,
          name: affiliate.name,
          email: affiliate.email
        } : null
      };
    });

    res.json(enrichedAffiliations);
  } catch (error) {
    console.error('Erro ao listar afiliações:', error);
    res.status(500).json({ error: 'Erro ao listar afiliações' });
  }
});

// GET /api/affiliations/affiliate/:affiliateId
// Lista todas as afiliações de um afiliado
router.get('/affiliate/:affiliateId', (req, res) => {
  try {
    const { affiliateId } = req.params;
    const db = readDatabase();

    if (!db.affiliations) {
      return res.json([]);
    }

    const affiliations = db.affiliations.filter(a => a.affiliateId === affiliateId);

    // Enriquecer com dados do produto
    const enrichedAffiliations = affiliations.map(affiliation => {
      const product = db.products?.find(p => p.id === affiliation.productId);
      return {
        ...affiliation,
        product: product ? {
          id: product.id,
          name: product.name,
          image: product.image,
          category: product.category
        } : null
      };
    });

    res.json(enrichedAffiliations);
  } catch (error) {
    console.error('Erro ao listar afiliações do afiliado:', error);
    res.status(500).json({ error: 'Erro ao listar afiliações' });
  }
});

// POST /api/affiliations/track-click
// Registra um clique no link de afiliado
router.post('/track-click', (req, res) => {
  try {
    const { affiliateId, productId } = req.body;
    const db = readDatabase();

    if (!db.affiliations) {
      return res.status(404).json({ error: 'Afiliação não encontrada' });
    }

    const affiliation = db.affiliations.find(
      a => a.id === affiliateId && a.productId === productId && a.status === 'approved'
    );

    if (affiliation) {
      affiliation.clicks = (affiliation.clicks || 0) + 1;
      saveDatabase(db);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Erro ao registrar clique:', error);
    res.status(500).json({ error: 'Erro ao registrar clique' });
  }
});

// POST /api/affiliations/track-conversion
// Registra uma conversão (venda) do afiliado
router.post('/track-conversion', (req, res) => {
  try {
    const { affiliateId, productId, saleValue, commissionValue } = req.body;
    const db = readDatabase();

    if (!db.affiliations) {
      return res.status(404).json({ error: 'Afiliação não encontrada' });
    }

    const affiliation = db.affiliations.find(
      a => a.id === affiliateId && a.productId === productId && a.status === 'approved'
    );

    if (affiliation) {
      affiliation.conversions = (affiliation.conversions || 0) + 1;
      affiliation.totalSales = (affiliation.totalSales || 0) + parseFloat(saleValue || 0);
      affiliation.totalCommission = (affiliation.totalCommission || 0) + parseFloat(commissionValue || 0);
      saveDatabase(db);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Erro ao registrar conversão:', error);
    res.status(500).json({ error: 'Erro ao registrar conversão' });
  }
});

// PATCH /api/affiliations/:id/commission
// Atualiza a comissão individual de um afiliado
router.patch('/:id/commission', (req, res) => {
  try {
    const { id } = req.params;
    const { individualCommission } = req.body;
    const db = readDatabase();

    if (!db.affiliations) {
      return res.status(404).json({ error: 'Afiliação não encontrada' });
    }

    const affiliation = db.affiliations.find(a => a.id === id);

    if (!affiliation) {
      return res.status(404).json({ error: 'Afiliação não encontrada' });
    }

    // Validar comissão
    if (individualCommission === undefined || individualCommission === null) {
      return res.status(400).json({ error: 'Comissão individual é obrigatória' });
    }

    const commission = parseFloat(individualCommission);
    if (isNaN(commission) || commission < 0 || commission > 100) {
      return res.status(400).json({ error: 'Comissão deve estar entre 0 e 100' });
    }

    // Atualizar comissão individual
    affiliation.individualCommission = commission;
    affiliation.updatedAt = new Date().toISOString();

    if (saveDatabase(db)) {
      console.log(`✅ Comissão individual do afiliado ${affiliation.affiliateId} atualizada para ${commission}%`);
      res.json({
        success: true,
        message: 'Comissão individual atualizada',
        affiliation
      });
    } else {
      res.status(500).json({ error: 'Erro ao atualizar comissão' });
    }
  } catch (error) {
    console.error('Erro ao atualizar comissão:', error);
    res.status(500).json({ error: 'Erro ao atualizar comissão' });
  }
});

export default router;
