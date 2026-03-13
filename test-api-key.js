import { readFileSync } from 'fs';

const DB_FILE = './database.json';

function readDB() {
  return JSON.parse(readFileSync(DB_FILE, 'utf-8'));
}

// Função auxiliar para buscar a chave da API Pagar.me do banco de dados
function getPagarmeApiKey() {
  try {
    const db = readDB();

    // Buscar configuração do platform-admin (configuração principal)
    const platformConfig = db.pagarmeConfigs?.find(c => c.userId === 'platform-admin');

    if (platformConfig && platformConfig.privateKey) {
      console.log('✅ Chave Pagar.me encontrada no banco de dados (platform-admin)');
      console.log('📋 Chave (primeiros 20 caracteres):', platformConfig.privateKey.substring(0, 20) + '...');
      console.log('📋 Chave (últimos 4 caracteres):', '...' + platformConfig.privateKey.slice(-4));
      console.log('📏 Tamanho da chave:', platformConfig.privateKey.length, 'caracteres');
      return platformConfig.privateKey;
    }

    // Fallback: buscar primeira configuração disponível
    const firstConfig = db.pagarmeConfigs?.[0];
    if (firstConfig && firstConfig.privateKey) {
      console.log('✅ Chave Pagar.me encontrada no banco de dados (primeira config)');
      console.log('📋 UserId:', firstConfig.userId);
      console.log('📋 Chave (primeiros 20 caracteres):', firstConfig.privateKey.substring(0, 20) + '...');
      console.log('📋 Chave (últimos 4 caracteres):', '...' + firstConfig.privateKey.slice(-4));
      return firstConfig.privateKey;
    }

    console.warn('⚠️ Nenhuma chave Pagar.me configurada no banco de dados');

    // Verificar se existe alguma config
    if (db.pagarmeConfigs && db.pagarmeConfigs.length > 0) {
      console.log('📊 Configurações encontradas:', db.pagarmeConfigs.length);
      db.pagarmeConfigs.forEach((config, index) => {
        console.log(`  ${index + 1}. UserId: ${config.userId}`);
        console.log(`     privateKey presente? ${config.privateKey ? 'SIM' : 'NÃO'}`);
        if (config.privateKey) {
          console.log(`     Tamanho: ${config.privateKey.length} caracteres`);
        }
      });
    } else {
      console.log('❌ Nenhuma configuração Pagar.me encontrada no banco');
    }

    return null;
  } catch (error) {
    console.error('❌ Erro ao buscar chave Pagar.me:', error);
    return null;
  }
}

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🔍 TESTANDO BUSCA DA CHAVE PAGAR.ME NO BANCO DE DADOS');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

const apiKey = getPagarmeApiKey();

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
if (apiKey) {
  console.log('✅ RESULTADO: Chave encontrada e pronta para uso!');

  // Validar formato
  if (apiKey.startsWith('sk_test_')) {
    console.log('✅ Formato: API V5 - Secret Key de TESTE');
  } else if (apiKey.startsWith('sk_live_')) {
    console.log('✅ Formato: API V5 - Secret Key de PRODUÇÃO');
  } else if (apiKey.startsWith('sk_')) {
    console.log('✅ Formato: API V5 - Secret Key');
  } else if (apiKey.startsWith('ak_')) {
    console.log('⚠️  Formato: Chave Pública - ATENÇÃO: você deve usar a Chave PRIVADA (sk_)');
  } else {
    console.log('⚠️  Formato: API V1/V4 (Private Key antiga)');
  }
} else {
  console.log('❌ RESULTADO: Chave NÃO encontrada');
  console.log('');
  console.log('📝 COMO RESOLVER:');
  console.log('1. Acesse o painel de administrador da plataforma');
  console.log('2. Vá em: Configurações > Integrações > Pagar.me');
  console.log('3. Cole sua chave PRIVADA da Pagar.me');
  console.log('4. Clique em "Salvar Configuração"');
}
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
