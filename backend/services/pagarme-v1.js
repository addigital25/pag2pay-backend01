import fetch from 'node-fetch';

/**
 * Criar recebedor (recipient) na Pagar.me API V1/V4
 * Usa chaves privadas que terminam com hash (exemplo: f8797276d)
 * @param {Object} params - Parâmetros
 * @param {Object} params.bankAccount - Dados bancários
 * @param {string} params.transferInterval - Intervalo de transferência
 * @param {string} params.apiKey - Chave privada da API
 * @returns {Promise<Object>} Dados do recebedor criado
 */
export async function createRecipientV1(params) {
  const { bankAccount, transferInterval = 'daily', apiKey } = params;

  try {
    console.log(`👤 Criando recebedor na Pagar.me API V1/V4...`);
    console.log(`   Titular: ${bankAccount.legal_name}`);
    console.log(`   Banco: ${bankAccount.bank_code}`);
    console.log(`   Agência: ${bankAccount.agencia}${bankAccount.agencia_dv ? '-' + bankAccount.agencia_dv : ''}`);
    console.log(`   Conta: ${bankAccount.conta}${bankAccount.conta_dv ? '-' + bankAccount.conta_dv : ''}`);

    const payload = {
      api_key: apiKey,
      bank_account: {
        bank_code: bankAccount.bank_code,
        agencia: bankAccount.agencia,
        agencia_dv: bankAccount.agencia_dv || '',
        conta: bankAccount.conta,
        conta_dv: bankAccount.conta_dv,
        type: bankAccount.type === 'conta_poupanca' ? 'conta_poupanca' : 'conta_corrente',
        document_number: bankAccount.document_number.replace(/\D/g, ''),
        legal_name: bankAccount.legal_name
      },
      transfer_interval: transferInterval,
      transfer_enabled: true,
      transfer_day: transferInterval === 'weekly' ? 5 : 0,
      anticipatable_volume_percentage: bankAccount.anticipatable_volume_percentage || 100
    };

    console.log('\n📤 Payload API V1:', JSON.stringify(payload, null, 2));

    const response = await fetch('https://api.pagar.me/1/recipients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      console.error('❌ Erro detalhado da Pagar.me V1:', error);

      // Tratar erros específicos
      if (error.errors) {
        const errorMessages = error.errors.map(e => `${e.parameter_name}: ${e.message}`).join(', ');
        throw new Error(`Erro ao criar recebedor: ${errorMessages}`);
      }

      throw new Error(`Erro Pagar.me V1: ${error.message || JSON.stringify(error)}`);
    }

    const recipient = await response.json();

    console.log(`✅ Recebedor criado com sucesso na API V1!`);
    console.log(`   ID: ${recipient.id}`);
    console.log(`   Status: ${recipient.status}`);
    console.log(`   Transferência: ${recipient.transfer_interval}`);

    return {
      recipientId: recipient.id,
      status: recipient.status,
      transferInterval: recipient.transfer_interval,
      transferEnabled: recipient.transfer_enabled,
      bankAccount: {
        bankCode: recipient.bank_account?.bank_code,
        agencia: recipient.bank_account?.agencia,
        agenciaDv: recipient.bank_account?.agencia_dv,
        conta: recipient.bank_account?.conta,
        contaDv: recipient.bank_account?.conta_dv,
        legalName: recipient.bank_account?.legal_name,
        documentNumber: recipient.bank_account?.document_number
      },
      createdAt: recipient.date_created
    };

  } catch (error) {
    console.error('❌ Erro ao criar recebedor V1:', error.message);
    throw error;
  }
}

export default {
  createRecipientV1
};
