import { readFileSync } from 'fs';

const DB_FILE = './database.json';

function readDB() {
  return JSON.parse(readFileSync(DB_FILE, 'utf-8'));
}

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🔍 VERIFICANDO RECIPIENT ID DA PLATAFORMA');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

try {
  const db = readDB();

  // Buscar configuração do platform-admin
  const platformConfig = db.pagarmeConfigs?.find(c => c.userId === 'platform-admin');

  if (!platformConfig) {
    console.log('❌ Configuração da plataforma não encontrada');
    console.log('   UserId esperado: platform-admin\n');

    if (db.pagarmeConfigs && db.pagarmeConfigs.length > 0) {
      console.log('📋 Configurações encontradas:');
      db.pagarmeConfigs.forEach((config, index) => {
        console.log(`   ${index + 1}. UserId: ${config.userId}`);
        console.log(`      privateKey: ${config.privateKey ? '✅ Presente' : '❌ Ausente'}`);
        console.log(`      splitReceiverId: ${config.splitReceiverId || '❌ Ausente'}`);
      });
    }
  } else {
    console.log('✅ Configuração da plataforma encontrada!');
    console.log(`   UserId: ${platformConfig.userId}`);
    console.log(`   privateKey: ${platformConfig.privateKey ? '✅ Configurada' : '❌ Não configurada'}`);

    if (platformConfig.splitReceiverId) {
      console.log(`   splitReceiverId: ✅ ${platformConfig.splitReceiverId}`);
    } else {
      console.log(`   splitReceiverId: ❌ NÃO CONFIGURADO`);
    }
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (!platformConfig?.splitReceiverId) {
    console.log('❌ PROBLEMA ENCONTRADO: splitReceiverId não configurado!\n');
    console.log('📝 COMO RESOLVER:');
    console.log('1. Acesse: http://localhost:3000/platform');
    console.log('2. Vá em: Configurações → Integrações → Pagar.me');
    console.log('3. Preencha o campo "ID do Recebedor (Split)"');
    console.log('');
    console.log('💡 OPÇÕES para obter o Recipient ID:');
    console.log('');
    console.log('Opção A: Usar recipient de um usuário existente');
    console.log('  - Vá em: Usuários → Lista de usuários');
    console.log('  - Encontre um usuário com "Conta Split" criada');
    console.log('  - Copie o Recipient ID (re_...)');
    console.log('  - Cole no campo "ID do Recebedor"');
    console.log('');
    console.log('Opção B: Criar recipient específico para a plataforma');
    console.log('  - Crie um usuário admin com seus dados bancários');
    console.log('  - Crie a conta split desse usuário');
    console.log('  - Copie o Recipient ID gerado');
    console.log('  - Cole no campo "ID do Recebedor"');
  } else {
    console.log('✅ TUDO CONFIGURADO CORRETAMENTE!');
    console.log('   Você pode gerar PIX/Boleto com splits agora! 🚀');
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

} catch (error) {
  console.error('❌ Erro ao ler banco de dados:', error.message);
}
