import { readFileSync, writeFileSync } from 'fs';

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

/**
 * Calcula o Turbina Score de um produto (0-150)
 *
 * Fórmula baseada em:
 * - Número de vendas (peso 40%)
 * - Valor total vendido (peso 30%)
 * - Taxa de conversão (peso 20%)
 * - Tempo desde criação (peso 10%)
 *
 * @param {Object} product - Produto
 * @param {Array} sales - Vendas do produto
 * @returns {number} Score entre 0 e 150
 */
export function calculateTurbinaScore(product, sales = []) {
  try {
    // Vendas deste produto
    const productSales = sales.filter(s => s.productId === product.id && s.status === 'completed');

    // 1. Componente de vendas (0-60 pontos - peso 40%)
    const numSales = productSales.length;
    const salesScore = Math.min(60, numSales * 0.5); // Cada venda = 0.5 pontos (max 60)

    // 2. Componente de valor (0-45 pontos - peso 30%)
    const totalValue = productSales.reduce((sum, sale) => sum + (sale.totalAmount || 0), 0);
    const valueScore = Math.min(45, (totalValue / 1000) * 0.3); // R$1000 = 0.3 pontos (max 45)

    // 3. Componente de taxa de conversão (0-30 pontos - peso 20%)
    // Assumindo que temos dados de visualizações (se não tiver, usamos afiliações como proxy)
    const views = product.views || (product.affiliations?.length || 1) * 100;
    const conversionRate = views > 0 ? (numSales / views) * 100 : 0;
    const conversionScore = Math.min(30, conversionRate * 100); // Taxa de 30% = 30 pontos

    // 4. Componente de tempo (0-15 pontos - peso 10%)
    // Produtos mais antigos com vendas consistentes ganham pontos
    const createdDate = new Date(product.createdAt || Date.now());
    const ageInDays = (Date.now() - createdDate.getTime()) / (1000 * 60 * 60 * 24);
    const ageScore = numSales > 0 ? Math.min(15, (ageInDays / 30) * 3) : 0; // Cada mês = 3 pontos (max 15)

    // Score final (0-150)
    const totalScore = Math.round(salesScore + valueScore + conversionScore + ageScore);

    return Math.min(150, Math.max(0, totalScore));
  } catch (error) {
    console.error('Erro ao calcular Turbina Score:', error);
    return 0;
  }
}

/**
 * Atualiza o Turbina Score de todos os produtos
 */
export function updateAllTurbinaScores() {
  try {
    console.log('📊 Atualizando Turbina Scores...');

    const db = readDatabase();

    if (!db.products || !Array.isArray(db.products)) {
      console.log('⚠️  Nenhum produto encontrado');
      return;
    }

    const sales = db.sales || [];
    let updatedCount = 0;

    db.products.forEach(product => {
      const newScore = calculateTurbinaScore(product, sales);

      // Atualizar score se mudou
      if (product.turbinaScore !== newScore) {
        product.turbinaScore = newScore;
        updatedCount++;
      }
    });

    if (updatedCount > 0) {
      saveDatabase(db);
      console.log(`✅ ${updatedCount} produto(s) atualizado(s)`);
    } else {
      console.log('ℹ️  Nenhuma atualização necessária');
    }

    return updatedCount;
  } catch (error) {
    console.error('❌ Erro ao atualizar Turbina Scores:', error);
    return 0;
  }
}

/**
 * Atualiza o Turbina Score de um produto específico
 */
export function updateProductTurbinaScore(productId) {
  try {
    const db = readDatabase();

    const product = db.products?.find(p => p.id === productId);
    if (!product) {
      console.log(`⚠️  Produto ${productId} não encontrado`);
      return null;
    }

    const sales = db.sales || [];
    const newScore = calculateTurbinaScore(product, sales);

    product.turbinaScore = newScore;
    saveDatabase(db);

    console.log(`✅ Turbina Score do produto "${product.name}" atualizado para ${newScore}`);
    return newScore;
  } catch (error) {
    console.error('❌ Erro ao atualizar Turbina Score do produto:', error);
    return null;
  }
}

/**
 * Inicializa turbinaScore em todos os produtos que não têm
 */
export function initializeTurbinaScores() {
  try {
    console.log('🚀 Inicializando Turbina Scores...');

    const db = readDatabase();

    if (!db.products || !Array.isArray(db.products)) {
      console.log('⚠️  Nenhum produto encontrado');
      return;
    }

    let initializedCount = 0;

    db.products.forEach(product => {
      if (product.turbinaScore === undefined) {
        product.turbinaScore = 0;
        initializedCount++;
      }
    });

    if (initializedCount > 0) {
      saveDatabase(db);
      console.log(`✅ ${initializedCount} produto(s) inicializado(s) com turbinaScore = 0`);

      // Calcular scores reais
      updateAllTurbinaScores();
    } else {
      console.log('ℹ️  Todos os produtos já possuem turbinaScore');
    }
  } catch (error) {
    console.error('❌ Erro ao inicializar Turbina Scores:', error);
  }
}

export default {
  calculateTurbinaScore,
  updateAllTurbinaScores,
  updateProductTurbinaScore,
  initializeTurbinaScores
};
