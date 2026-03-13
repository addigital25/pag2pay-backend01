#!/usr/bin/env node
/**
 * Script de Verificação de Configuração
 * Verifica se a chave da API Pagar.me está configurada corretamente
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Carregar .env
dotenv.config({ path: join(__dirname, '.env') });

console.log('\n╔═══════════════════════════════════════════════════════════════════════════╗');
console.log('║                                                                           ║');
console.log('║                 🔍 VERIFICAÇÃO DE CONFIGURAÇÃO 🔍                          ║');
console.log('║                                                                           ║');
console.log('╚═══════════════════════════════════════════════════════════════════════════╝\n');

let hasErrors = false;

// Verificar chave da API
const apiKey = process.env.PAGARME_API_KEY;

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
console.log('📋 VERIFICANDO: Chave da API Pagar.me');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

if (!apiKey) {
  console.error('❌ ERRO: PAGARME_API_KEY não está definida no arquivo .env\n');
  hasErrors = true;
} else if (apiKey === 'sk_test_COLE_SUA_CHAVE_AQUI') {
  console.error('❌ ERRO: PAGARME_API_KEY ainda está com o valor padrão!\n');
  console.error('   Valor atual: sk_test_COLE_SUA_CHAVE_AQUI\n');
  console.error('   ⚠️  Você precisa substituir pela sua chave REAL da Pagar.me!\n');
  hasErrors = true;
} else if (apiKey.includes('COLE_SUA_CHAVE')) {
  console.error('❌ ERRO: PAGARME_API_KEY contém texto de placeholder!\n');
  console.error(`   Valor atual: ${apiKey}\n`);
  hasErrors = true;
} else if (!apiKey.startsWith('sk_test_') && !apiKey.startsWith('sk_live_')) {
  console.error('❌ ERRO: PAGARME_API_KEY não parece ser uma chave válida!\n');
  console.error('   Chaves válidas começam com: sk_test_ ou sk_live_\n');
  console.error(`   Valor atual: ${apiKey.substring(0, 15)}...\n`);
  hasErrors = true;
} else {
  console.log('✅ PAGARME_API_KEY configurada corretamente!\n');
  console.log(`   Tipo: ${apiKey.startsWith('sk_test_') ? 'TESTE (desenvolvimento)' : 'PRODUÇÃO (live)'}\n`);
  console.log(`   Chave: ${apiKey.substring(0, 15)}...${apiKey.substring(apiKey.length - 5)}\n`);
}

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

// Outras verificações
console.log('📋 OUTRAS CONFIGURAÇÕES:\n');

const configs = {
  'PORT': process.env.PORT || '3001',
  'NODE_ENV': process.env.NODE_ENV || 'development',
  'FRONTEND_URL': process.env.FRONTEND_URL || 'http://localhost:3000'
};

for (const [key, value] of Object.entries(configs)) {
  console.log(`   ${key}: ${value}`);
}

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

if (hasErrors) {
  console.error('❌ CONFIGURAÇÃO INCOMPLETA!\n');
  console.error('📋 COMO CORRIGIR:\n');
  console.error('1. Acesse: https://dashboard.pagar.me/');
  console.error('2. Vá em: Configurações → Chaves de API');
  console.error('3. Copie sua "Chave Secreta de Teste" (sk_test_...)');
  console.error('4. Edite o arquivo: backend/.env');
  console.error('5. Substitua: PAGARME_API_KEY=sk_test_COLE_SUA_CHAVE_AQUI');
  console.error('6. Por: PAGARME_API_KEY=sk_test_SUA_CHAVE_REAL');
  console.error('7. Salve o arquivo e reinicie o servidor\n');
  console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  process.exit(1);
} else {
  console.log('✅ CONFIGURAÇÃO OK! Tudo pronto para usar.\n');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  process.exit(0);
}
