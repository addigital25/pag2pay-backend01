/**
 * Middleware para rastreamento de afiliados
 *
 * Captura o parâmetro ?ref=affiliateId da URL e salva em cookie
 * Cookie tem duração "eterna" (10 anos) para garantir 100% de rastreamento
 * Modelo de atribuição: "Último Clique" - sempre sobrescreve com o afiliado mais recente
 */

/**
 * Extrai o affiliateId do cookie ou query string
 * @param {Object} req - Request do Express
 * @returns {string|null} - affiliateId ou null
 */
export function getAffiliateId(req) {
  // 1. Prioridade: Query string (?ref=affiliateId)
  if (req.query.ref) {
    return req.query.ref;
  }

  // 2. Cookie (para sessões subsequentes)
  if (req.cookies && req.cookies.affiliate_ref) {
    return req.cookies.affiliate_ref;
  }

  // 3. Header (para casos especiais)
  if (req.headers['x-affiliate-ref']) {
    return req.headers['x-affiliate-ref'];
  }

  return null;
}

/**
 * Middleware para capturar e salvar referência de afiliado
 * Adicionar em rotas de checkout e páginas de produto
 */
export function captureAffiliateRef(req, res, next) {
  try {
    const affiliateId = req.query.ref;

    if (affiliateId) {
      // Salvar em cookie com duração de 10 anos (praticamente eterno)
      const tenYears = 10 * 365 * 24 * 60 * 60 * 1000;

      res.cookie('affiliate_ref', affiliateId, {
        maxAge: tenYears,
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax'
      });

      console.log(`🔗 Afiliado rastreado: ${affiliateId}`);
    }

    next();
  } catch (error) {
    console.error('Erro ao capturar referência de afiliado:', error);
    next();
  }
}

/**
 * Middleware para registrar clique de afiliado
 * Incrementa contador de cliques na afiliação
 */
export async function trackAffiliateClick(affiliationId, productId) {
  try {
    // Fazer requisição para a rota de rastreamento
    const response = await fetch(`${process.env.API_URL || 'http://localhost:3001'}/api/affiliations/track-click`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        affiliateId: affiliationId,
        productId: productId
      })
    });

    if (response.ok) {
      console.log(`📊 Clique registrado: Afiliado ${affiliationId} - Produto ${productId}`);
    }
  } catch (error) {
    console.error('Erro ao registrar clique de afiliado:', error);
  }
}

/**
 * Middleware para registrar conversão (venda) de afiliado
 * Incrementa contador de vendas e comissão
 */
export async function trackAffiliateConversion(affiliationId, productId, saleValue, commissionValue) {
  try {
    const response = await fetch(`${process.env.API_URL || 'http://localhost:3001'}/api/affiliations/track-conversion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        affiliateId: affiliationId,
        productId: productId,
        saleValue: saleValue,
        commissionValue: commissionValue
      })
    });

    if (response.ok) {
      console.log(`💰 Conversão registrada: Afiliado ${affiliationId} - Comissão R$ ${commissionValue}`);
    }
  } catch (error) {
    console.error('Erro ao registrar conversão de afiliado:', error);
  }
}

/**
 * Calcula a comissão do afiliado baseado na configuração
 * @param {Object} affiliation - Objeto de afiliação
 * @param {number} saleValue - Valor total da venda
 * @returns {number} - Valor da comissão
 */
export function calculateAffiliateCommission(affiliation, saleValue) {
  if (!affiliation) return 0;

  if (affiliation.commissionMode === 'percentage') {
    return (saleValue * affiliation.commissionValue) / 100;
  } else if (affiliation.commissionMode === 'fixed') {
    return affiliation.commissionValue;
  }

  return 0;
}

export default {
  getAffiliateId,
  captureAffiliateRef,
  trackAffiliateClick,
  trackAffiliateConversion,
  calculateAffiliateCommission
};
