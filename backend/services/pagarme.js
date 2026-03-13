import fetch from 'node-fetch';
import { createRecipientV1 } from './pagarme-v1.js';

/**
 * Serviço de integração com a API Pagar.me
 * Suporta API V1/V4 (chaves privadas) e API V5 (sk_test/sk_live)
 * Documentação: https://docs.pagar.me/
 */

/**
 * Buscar recebíveis (payables) de uma transação no Pagar.me
 * @param {string} transactionId - ID da transação no Pagar.me
 * @param {string} apiKey - Chave da API do Pagar.me
 * @returns {Promise<Array>} Array de recebíveis com datas de pagamento
 */
export async function getPayables(transactionId, apiKey) {
  try {
    const url = `https://api.pagar.me/1/transactions/${transactionId}/payables?api_key=${apiKey}`;

    console.log(`📊 Buscando recebíveis da transação ${transactionId}...`);

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Erro ao buscar recebíveis: ${response.status} ${response.statusText}`);
    }

    const payables = await response.json();

    console.log(`✅ ${payables.length} recebível(is) encontrado(s)`);

    // Retornar recebíveis com informações relevantes
    return payables.map(payable => ({
      id: payable.id,
      status: payable.status, // waiting_funds, prepaid, paid
      amount: payable.amount / 100, // Converter de centavos para reais
      fee: payable.fee / 100,
      installment: payable.installment,
      paymentDate: payable.payment_date, // Data de liberação do dinheiro
      originalPaymentDate: payable.original_payment_date,
      type: payable.type, // credit, refund, etc
      transactionId: payable.transaction_id,
      recipientId: payable.recipient_id
    }));

  } catch (error) {
    console.error('❌ Erro ao buscar recebíveis:', error.message);
    throw error;
  }
}

/**
 * Buscar recebíveis por período de pagamento
 * @param {string} apiKey - Chave da API
 * @param {Date} startDate - Data inicial
 * @param {Date} endDate - Data final
 * @param {string} recipientId - (Opcional) ID do recebedor
 * @returns {Promise<Array>} Array de recebíveis
 */
export async function getPayablesByPeriod(apiKey, startDate, endDate, recipientId = null) {
  try {
    // Converter datas para timestamp em milissegundos
    const startTimestamp = startDate.getTime();
    const endTimestamp = endDate.getTime();

    let url = `https://api.pagar.me/1/payables?api_key=${apiKey}&payment_date=>=${startTimestamp}&payment_date=<=${endTimestamp}&count=1000`;

    if (recipientId) {
      url += `&recipient_id=${recipientId}`;
    }

    console.log(`📊 Buscando recebíveis do período ${startDate.toLocaleDateString()} a ${endDate.toLocaleDateString()}...`);

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Erro ao buscar recebíveis: ${response.status} ${response.statusText}`);
    }

    const payables = await response.json();

    console.log(`✅ ${payables.length} recebível(is) encontrado(s) no período`);

    return payables.map(payable => ({
      id: payable.id,
      status: payable.status,
      amount: payable.amount / 100,
      fee: payable.fee / 100,
      installment: payable.installment,
      paymentDate: payable.payment_date,
      originalPaymentDate: payable.original_payment_date,
      type: payable.type,
      transactionId: payable.transaction_id,
      recipientId: payable.recipient_id,
      accrualDate: payable.accrual_date // Data de captura da transação
    }));

  } catch (error) {
    console.error('❌ Erro ao buscar recebíveis por período:', error.message);
    throw error;
  }
}

/**
 * Converter timestamp do Pagar.me para data ISO
 * @param {number} timestamp - Timestamp em milissegundos
 * @returns {string} Data no formato ISO (YYYY-MM-DD)
 */
export function convertPaymentDateToISO(timestamp) {
  if (!timestamp) return null;

  const date = new Date(timestamp);
  return date.toISOString().split('T')[0];
}

/**
 * Buscar data de liberação de um pedido específico
 * @param {string} pagarmeOrderId - ID do pedido no Pagar.me
 * @param {string} apiKey - Chave da API
 * @returns {Promise<string|null>} Data de liberação no formato YYYY-MM-DD
 */
export async function getReleaseDate(pagarmeOrderId, apiKey) {
  try {
    // Buscar recebíveis da transação
    const payables = await getPayables(pagarmeOrderId, apiKey);

    if (!payables || payables.length === 0) {
      console.log('⚠️ Nenhum recebível encontrado para esta transação');
      return null;
    }

    // Pegar o recebível do tipo 'credit' (crédito principal)
    const mainPayable = payables.find(p => p.type === 'credit') || payables[0];

    // Converter timestamp para data ISO
    const releaseDate = convertPaymentDateToISO(mainPayable.paymentDate);

    console.log(`✅ Data de liberação: ${releaseDate}`);

    return releaseDate;

  } catch (error) {
    console.error('❌ Erro ao buscar data de liberação:', error.message);
    return null;
  }
}

/**
 * Criar transação PIX com splits na Pagar.me
 * @param {Object} params - Parâmetros da transação
 * @param {number} params.amount - Valor em centavos
 * @param {Object} params.customer - Dados do cliente
 * @param {Array} params.splits - Array de splits
 * @param {string} params.apiKey - Chave da API
 * @returns {Promise<Object>} Dados da transação criada
 */
export async function createPixTransaction(params) {
  const { amount, customer, splits, apiKey, expirationMinutes = 2880 } = params;

  try {
    console.log(`💳 Criando transação PIX com splits...`);

    const payload = {
      api_key: apiKey,
      amount: amount, // Valor já em centavos
      payment_method: 'pix',
      customer: {
        name: customer.name,
        email: customer.email || 'cliente@exemplo.com',
        type: customer.cpf.length === 11 ? 'individual' : 'corporation',
        document_number: customer.cpf.replace(/\D/g, ''),
        phone_numbers: [customer.phone?.replace(/\D/g, '') || '11999999999']
      },
      pix_expiration_date: new Date(Date.now() + expirationMinutes * 60 * 1000).toISOString(),
      split_rules: splits.map(split => ({
        recipient_id: split.recipient_id,
        amount: split.amount,
        liable: split.liable,
        charge_processing_fee: split.charge_processing_fee
      }))
    };

    const response = await fetch('https://api.pagar.me/1/transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Erro Pagar.me: ${JSON.stringify(error)}`);
    }

    const transaction = await response.json();

    console.log(`✅ Transação PIX criada: ${transaction.id}`);

    return {
      transactionId: transaction.id,
      status: transaction.status,
      pixQrCode: transaction.pix_qr_code,
      pixCopyPaste: transaction.pix_emv,
      expiresAt: transaction.pix_expiration_date
    };

  } catch (error) {
    console.error('❌ Erro ao criar transação PIX:', error.message);
    throw error;
  }
}

/**
 * Criar transação de Boleto com splits na Pagar.me
 * @param {Object} params - Parâmetros da transação
 * @param {number} params.amount - Valor em centavos
 * @param {Object} params.customer - Dados do cliente
 * @param {Array} params.splits - Array de splits
 * @param {string} params.apiKey - Chave da API
 * @returns {Promise<Object>} Dados da transação criada
 */
export async function createBoletoTransaction(params) {
  const { amount, customer, splits, apiKey } = params;

  try {
    console.log(`💳 Criando transação Boleto com splits...`);

    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + 3); // 3 dias úteis

    const payload = {
      api_key: apiKey,
      amount: amount,
      payment_method: 'boleto',
      boleto_expiration_date: dueDate.toISOString().split('T')[0],
      customer: {
        name: customer.name,
        email: customer.email || 'cliente@exemplo.com',
        type: customer.cpf.length === 11 ? 'individual' : 'corporation',
        document_number: customer.cpf.replace(/\D/g, ''),
        phone_numbers: [customer.phone?.replace(/\D/g, '') || '11999999999'],
        address: {
          street: customer.address || 'Rua Exemplo',
          street_number: customer.number || '123',
          neighborhood: customer.neighborhood || 'Centro',
          city: customer.city || 'São Paulo',
          state: customer.state || 'SP',
          zipcode: customer.zipCode?.replace(/\D/g, '') || '01000000'
        }
      },
      split_rules: splits.map(split => ({
        recipient_id: split.recipient_id,
        amount: split.amount,
        liable: split.liable,
        charge_processing_fee: split.charge_processing_fee
      }))
    };

    const response = await fetch('https://api.pagar.me/1/transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Erro Pagar.me: ${JSON.stringify(error)}`);
    }

    const transaction = await response.json();

    console.log(`✅ Transação Boleto criada: ${transaction.id}`);

    return {
      transactionId: transaction.id,
      status: transaction.status,
      boletoUrl: transaction.boleto_url,
      boletoBarcode: transaction.boleto_barcode,
      dueDate: transaction.boleto_expiration_date
    };

  } catch (error) {
    console.error('❌ Erro ao criar transação Boleto:', error.message);
    throw error;
  }
}

/**
 * Criar transação de Cartão de Crédito com splits na Pagar.me
 * @param {Object} params - Parâmetros da transação
 * @param {number} params.amount - Valor em centavos
 * @param {Object} params.customer - Dados do cliente
 * @param {Object} params.card - Dados do cartão
 * @param {Array} params.splits - Array de splits
 * @param {number} params.installments - Número de parcelas
 * @param {string} params.apiKey - Chave da API
 * @returns {Promise<Object>} Dados da transação criada
 */
export async function createCardTransaction(params) {
  const { amount, customer, card, splits, installments = 1, apiKey } = params;

  try {
    console.log(`💳 Criando transação Cartão com splits...`);

    const payload = {
      api_key: apiKey,
      amount: amount,
      payment_method: 'credit_card',
      installments: installments,
      card_number: card.number.replace(/\s/g, ''),
      card_holder_name: card.name,
      card_expiration_date: card.expiry.replace('/', ''),
      card_cvv: card.cvv,
      customer: {
        name: customer.name,
        email: customer.email || 'cliente@exemplo.com',
        type: customer.cpf.length === 11 ? 'individual' : 'corporation',
        document_number: customer.cpf.replace(/\D/g, ''),
        phone_numbers: [customer.phone?.replace(/\D/g, '') || '11999999999']
      },
      split_rules: splits.map(split => ({
        recipient_id: split.recipient_id,
        amount: split.amount,
        liable: split.liable,
        charge_processing_fee: split.charge_processing_fee
      }))
    };

    const response = await fetch('https://api.pagar.me/1/transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Erro Pagar.me: ${JSON.stringify(error)}`);
    }

    const transaction = await response.json();

    console.log(`✅ Transação Cartão criada: ${transaction.id}`);

    return {
      transactionId: transaction.id,
      status: transaction.status,
      acquirerResponseCode: transaction.acquirer_response_code,
      authorizationCode: transaction.authorization_code
    };

  } catch (error) {
    console.error('❌ Erro ao criar transação Cartão:', error.message);
    throw error;
  }
}

/**
 * Criar transferência (saque) para um recebedor na Pagar.me
 * @param {Object} params - Parâmetros da transferência
 * @param {number} params.amount - Valor em centavos
 * @param {string} params.recipientId - ID do recebedor no Pagar.me
 * @param {string} params.apiKey - Chave da API
 * @returns {Promise<Object>} Dados da transferência criada
 */
export async function createTransfer(params) {
  const { amount, recipientId, apiKey } = params;

  try {
    console.log(`💸 Criando transferência de R$ ${(amount / 100).toFixed(2)} para recebedor ${recipientId}...`);

    const payload = {
      api_key: apiKey,
      amount: amount, // Valor em centavos
      recipient_id: recipientId
    };

    const response = await fetch('https://api.pagar.me/1/transfers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const error = await response.json();
      console.error('❌ Erro detalhado da Pagar.me:', error);

      // Tratar erros específicos
      if (error.errors) {
        const errorMessages = error.errors.map(e => `${e.parameter_name}: ${e.message}`).join(', ');
        throw new Error(`Erro na transferência: ${errorMessages}`);
      }

      throw new Error(`Erro Pagar.me: ${JSON.stringify(error)}`);
    }

    const transfer = await response.json();

    console.log(`✅ Transferência criada com sucesso: ${transfer.id}`);
    console.log(`   Status: ${transfer.status}`);
    console.log(`   Data de transferência: ${new Date(transfer.date_created).toLocaleString('pt-BR')}`);

    return {
      transferId: transfer.id,
      status: transfer.status, // pending_transfer, transferred, failed, processing, canceled
      amount: transfer.amount / 100,
      fee: transfer.fee / 100,
      dateCreated: transfer.date_created,
      fundingDate: transfer.funding_date, // Data prevista para crédito
      fundingEstimatedDate: transfer.funding_estimated_date,
      recipientId: transfer.recipient_id,
      bankAccount: transfer.bank_account,
      metadata: transfer.metadata
    };

  } catch (error) {
    console.error('❌ Erro ao criar transferência:', error.message);
    throw error;
  }
}

/**
 * Buscar status de uma transferência
 * @param {string} transferId - ID da transferência
 * @param {string} apiKey - Chave da API
 * @returns {Promise<Object>} Dados da transferência
 */
export async function getTransferStatus(transferId, apiKey) {
  try {
    const url = `https://api.pagar.me/1/transfers/${transferId}?api_key=${apiKey}`;

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Erro ao buscar transferência: ${response.status}`);
    }

    const transfer = await response.json();

    return {
      transferId: transfer.id,
      status: transfer.status,
      amount: transfer.amount / 100,
      fee: transfer.fee / 100,
      dateCreated: transfer.date_created,
      fundingDate: transfer.funding_date,
      recipientId: transfer.recipient_id
    };

  } catch (error) {
    console.error('❌ Erro ao buscar status da transferência:', error.message);
    throw error;
  }
}

/**
 * Criar recebedor (recipient) na Pagar.me
 * @param {Object} params - Dados do recebedor
 * @param {Object} params.bankAccount - Dados da conta bancária
 * @param {string} params.transferInterval - Intervalo de transferência (daily, weekly, monthly)
 * @param {string} params.apiKey - Chave da API
 * @returns {Promise<Object>} Dados do recebedor criado
 */
export async function createRecipient(params) {
  const { bankAccount, transferInterval = 'daily', apiKey } = params;

  try {
    // ⚠️ VALIDAR CHAVE DA API
    if (!apiKey || apiKey === 'sk_test_COLE_SUA_CHAVE_AQUI' || apiKey.includes('COLE_SUA_CHAVE')) {
      console.error('\n❌❌❌ ERRO DE CONFIGURAÇÃO ❌❌❌');
      console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.error('⚠️  A chave da API Pagar.me NÃO está configurada!');
      console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      console.error('📋 COMO RESOLVER:');
      console.error('1. Acesse: https://dashboard.pagar.me/');
      console.error('2. Faça login na sua conta');
      console.error('3. Vá em: Configurações → Chaves de API');
      console.error('4. Copie sua "Chave Secreta de Teste" (começa com sk_test_)');
      console.error('5. Edite o arquivo: backend/.env');
      console.error('6. Substitua: PAGARME_API_KEY=sk_test_COLE_SUA_CHAVE_AQUI');
      console.error('7. Por: PAGARME_API_KEY=sk_test_SUA_CHAVE_REAL_AQUI');
      console.error('8. Reinicie o servidor backend (Ctrl+C e npm run dev)');
      console.error('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

      throw new Error('CHAVE DA API PAGAR.ME NÃO CONFIGURADA! Veja instruções acima no console.');
    }

    // 🔍 DETECTAR VERSÃO DA API pela chave
    // API V5: Chaves começam com sk_test_, sk_live_, ou apenas sk_
    // API V1: Chaves antigas começam com ak_ ou não têm prefixo sk_
    const isV5Key = apiKey.startsWith('sk_');

    if (!isV5Key) {
      // Usar API V1 para chaves privadas antigas (começam com ak_ ou outro formato)
      console.log('🔄 Detectado: Chave Privada (API V1/V4)');
      return await createRecipientV1(params);
    }

    console.log(`👤 Criando recebedor na Pagar.me API V5...`);
    console.log(`   🔑 Tipo de chave: ${apiKey.startsWith('sk_test_') ? 'Teste' : apiKey.startsWith('sk_live_') ? 'Produção' : 'Secret Key'}`);
    console.log(`   Titular: ${bankAccount.legal_name}`);
    console.log(`   Banco: ${bankAccount.bank_code}`);
    console.log(`   Agência: ${bankAccount.agencia}${bankAccount.agencia_dv ? '-' + bankAccount.agencia_dv : ''}`);
    console.log(`   Conta: ${bankAccount.conta}${bankAccount.conta_dv ? '-' + bankAccount.conta_dv : ''}`);

    // API V5 - Novo formato
    // Construir default_bank_account (só incluir campos não vazios)
    const bankAccountPayload = {
      bank: bankAccount.bank_code,
      branch_number: bankAccount.agencia,
      account_number: bankAccount.conta,
      account_check_digit: bankAccount.conta_dv,
      type: bankAccount.type === 'conta_poupanca' ? 'savings' : 'checking',
      holder_name: bankAccount.legal_name,
      holder_type: bankAccount.document_number.replace(/\D/g, '').length === 11 ? 'individual' : 'company',
      holder_document: bankAccount.document_number.replace(/\D/g, '')
    };

    // Adicionar branch_check_digit SOMENTE se tiver valor
    if (bankAccount.agencia_dv && bankAccount.agencia_dv.trim() !== '') {
      bankAccountPayload.branch_check_digit = bankAccount.agencia_dv;
    }

    const payload = {
      name: bankAccount.legal_name,
      email: bankAccount.email || 'naotemEmail@exemplo.com',
      document: bankAccount.document_number.replace(/\D/g, ''),
      type: bankAccount.document_number.replace(/\D/g, '').length === 11 ? 'individual' : 'company',
      default_bank_account: bankAccountPayload,
      transfer_settings: {
        transfer_enabled: true,
        transfer_interval: transferInterval,
        transfer_day: transferInterval === 'weekly' ? 5 : 0
      }
    };

    console.log('\n📤 Payload API V5:', JSON.stringify(payload, null, 2));

    // API V5 usa Basic Auth (base64)
    const authHeader = Buffer.from(apiKey + ':').toString('base64');

    const response = await fetch('https://api.pagar.me/core/v5/recipients', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${authHeader}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      console.error('❌ Erro detalhado da Pagar.me V5:', error);

      // Tratar erros específicos
      if (error.errors) {
        const errorMessages = Object.entries(error.errors)
          .map(([field, messages]) => `${field}: ${Array.isArray(messages) ? messages.join(', ') : messages}`)
          .join('; ');
        throw new Error(`Erro ao criar recebedor: ${errorMessages}`);
      }

      throw new Error(`Erro Pagar.me V5: ${error.message || JSON.stringify(error)}`);
    }

    const recipient = await response.json();

    console.log(`✅ Recebedor criado com sucesso na API V5!`);
    console.log(`   ID: ${recipient.id}`);
    console.log(`   Status: ${recipient.status}`);
    console.log(`   Transferência: ${recipient.transfer_settings?.transfer_interval}`);

    return {
      recipientId: recipient.id,
      status: recipient.status,
      transferInterval: recipient.transfer_settings?.transfer_interval,
      transferEnabled: recipient.transfer_settings?.transfer_enabled,
      bankAccount: {
        bankCode: recipient.default_bank_account?.bank,
        agencia: recipient.default_bank_account?.branch_number,
        agenciaDv: recipient.default_bank_account?.branch_check_digit,
        conta: recipient.default_bank_account?.account_number,
        contaDv: recipient.default_bank_account?.account_check_digit,
        legalName: recipient.default_bank_account?.holder_name,
        documentNumber: recipient.default_bank_account?.holder_document
      },
      createdAt: recipient.created_at
    };

  } catch (error) {
    console.error('❌ Erro ao criar recebedor:', error.message);
    throw error;
  }
}

/**
 * Atualizar dados de um recebedor
 * @param {string} recipientId - ID do recebedor
 * @param {Object} params - Dados a atualizar
 * @param {string} params.apiKey - Chave da API
 * @returns {Promise<Object>} Dados do recebedor atualizado
 */
export async function updateRecipient(recipientId, params) {
  const { bankAccount, transferInterval, apiKey } = params;

  try {
    console.log(`🔄 Atualizando recebedor ${recipientId}...`);

    const payload = {
      api_key: apiKey
    };

    if (bankAccount) {
      payload.bank_account = {
        bank_code: bankAccount.bank_code,
        agencia: bankAccount.agencia,
        agencia_dv: bankAccount.agencia_dv || null,
        conta: bankAccount.conta,
        conta_dv: bankAccount.conta_dv,
        type: bankAccount.type || 'conta_corrente',
        document_number: bankAccount.document_number.replace(/\D/g, ''),
        legal_name: bankAccount.legal_name
      };
    }

    if (transferInterval) {
      payload.transfer_interval = transferInterval;
    }

    const response = await fetch(`https://api.pagar.me/1/recipients/${recipientId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const error = await response.json();
      console.error('❌ Erro ao atualizar recebedor:', error);
      throw new Error(`Erro Pagar.me: ${JSON.stringify(error)}`);
    }

    const recipient = await response.json();

    console.log(`✅ Recebedor atualizado com sucesso!`);

    return {
      recipientId: recipient.id,
      status: recipient.status,
      transferInterval: recipient.transfer_interval
    };

  } catch (error) {
    console.error('❌ Erro ao atualizar recebedor:', error.message);
    throw error;
  }
}

/**
 * Buscar dados de um recebedor
 * @param {string} recipientId - ID do recebedor
 * @param {string} apiKey - Chave da API
 * @returns {Promise<Object>} Dados do recebedor
 */
export async function getRecipient(recipientId, apiKey) {
  try {
    const url = `https://api.pagar.me/1/recipients/${recipientId}?api_key=${apiKey}`;

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Erro ao buscar recebedor: ${response.status}`);
    }

    const recipient = await response.json();

    return {
      recipientId: recipient.id,
      status: recipient.status,
      transferInterval: recipient.transfer_interval,
      transferEnabled: recipient.transfer_enabled,
      bankAccount: recipient.bank_account
    };

  } catch (error) {
    console.error('❌ Erro ao buscar recebedor:', error.message);
    throw error;
  }
}

/**
 * Processar reembolso de uma transação
 * @param {string} transactionId - ID da transação no Pagar.me
 * @param {string} apiKey - Chave da API (opcional, usa .env se não informada)
 * @returns {Promise<Object>} Dados do reembolso
 */
export async function refundTransaction(transactionId, apiKey = null) {
  try {
    const key = apiKey || process.env.PAGARME_API_KEY;
    if (!key) {
      throw new Error('PAGARME_API_KEY não configurada');
    }

    const url = `https://api.pagar.me/1/transactions/${transactionId}/refund`;

    console.log(`🔄 Processando reembolso da transação ${transactionId}...`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        api_key: key
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(`Erro ao processar reembolso: ${response.status} - ${errorData.errors?.[0]?.message || response.statusText}`);
    }

    const refundData = await response.json();

    console.log(`✅ Reembolso processado com sucesso: ${refundData.id}`);
    console.log(`   Status: ${refundData.status}`);
    console.log(`   Valor: R$ ${(refundData.refunded_amount / 100).toFixed(2)}`);

    return {
      id: refundData.id,
      status: refundData.status,
      refundedAmount: refundData.refunded_amount,
      transactionId: refundData.id
    };

  } catch (error) {
    console.error('❌ Erro ao processar reembolso na Pagar.me:', error.message);
    throw error;
  }
}

/**
 * Buscar saldo disponível de um recebedor na Pagar.me
 * @param {string} recipientId - ID do recebedor (re_xxxxxxxx)
 * @param {string} apiKey - Chave secreta da API Pagar.me
 * @returns {Promise<Object>} Saldo do recebedor (valores em centavos)
 */
export async function getRecipientBalance(recipientId, apiKey) {
  try {
    console.log(`💰 Buscando saldo do recebedor ${recipientId}...`);

    // Pagar.me API v5 - Balance endpoint
    const url = `https://api.pagar.me/core/v5/recipients/${recipientId}/balance`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Basic ${Buffer.from(apiKey + ':').toString('base64')}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('❌ Erro ao buscar saldo:', response.status, errorData);
      throw new Error(`Erro Pagar.me: ${response.status} - ${JSON.stringify(errorData)}`);
    }

    const balanceData = await response.json();

    console.log(`✅ Saldo disponível: R$ ${(balanceData.available?.amount || 0) / 100}`);
    console.log(`⏳ Aguardando liberação: R$ ${(balanceData.waiting_funds?.amount || 0) / 100}`);
    console.log(`📤 Total transferido: R$ ${(balanceData.transferred?.amount || 0) / 100}`);

    // Retornar saldo em centavos (padrão Pagar.me)
    return {
      available: balanceData.available?.amount || 0,        // Valor disponível para saque
      waitingFunds: balanceData.waiting_funds?.amount || 0, // Valor aguardando liberação
      transferred: balanceData.transferred?.amount || 0,    // Total já transferido/sacado
      // Informações adicionais (se disponíveis)
      currency: balanceData.available?.currency || 'BRL',
      lastUpdate: new Date().toISOString()
    };

  } catch (error) {
    console.error('❌ Erro ao buscar saldo do recebedor:', error.message);
    throw error;
  }
}

export default {
  getPayables,
  getPayablesByPeriod,
  convertPaymentDateToISO,
  getReleaseDate,
  createPixTransaction,
  createBoletoTransaction,
  createCardTransaction,
  createTransfer,
  getTransferStatus,
  createRecipient,
  updateRecipient,
  getRecipient,
  refundTransaction,
  getRecipientBalance
};
