// Script de diagnóstico de webhook
import { readFileSync } from 'fs';

const db = JSON.parse(readFileSync('./database.json', 'utf8'));

console.log('🔍 ====== DIAGNÓSTICO DE WEBHOOKS ======\n');

// 1. Verificar se há webhooks cadastrados
console.log('1️⃣ WEBHOOKS CADASTRADOS:');
if (!db.webhooks || db.webhooks.length === 0) {
  console.log('❌ PROBLEMA: Nenhum webhook cadastrado no sistema!');
  console.log('');
  console.log('📝 SOLUÇÃO:');
  console.log('   1. Acesse o painel com login de USUÁRIO (verde)');
  console.log('   2. Vá em Configurações > Webhooks');
  console.log('   3. Clique em "Novo Webhook"');
  console.log('   4. Preencha:');
  console.log('      - Nome: Botconversa');
  console.log('      - URL: [sua URL do Botconversa]');
  console.log('      - Produto: Todos os produtos (ou específico)');
  console.log('      - Status: ATIVO (toggle ligado)');
  console.log('      - Eventos: Marque "Aguardando pagamento" e "Pagamento Aprovado"');
  console.log('');
  process.exit(1);
} else {
  console.log(`✅ Total de webhooks: ${db.webhooks.length}`);
  db.webhooks.forEach((w, i) => {
    console.log(`\n   Webhook ${i + 1}:`);
    console.log(`   - ID: ${w.id}`);
    console.log(`   - Nome: ${w.name}`);
    console.log(`   - URL: ${w.url}`);
    console.log(`   - Status: ${w.status ? '✅ ATIVO' : '❌ INATIVO'}`);
    console.log(`   - Produto: ${w.product || 'Todos os produtos'}`);
    console.log(`   - UserID: ${w.userId}`);
    console.log(`   - Código de autenticação: ${w.code}`);
    console.log(`   - Eventos configurados:`);
    Object.entries(w.events).forEach(([evento, ativo]) => {
      console.log(`     ${ativo ? '✅' : '⬜'} ${evento}`);
    });
  });
}

console.log('\n');

// 2. Verificar usuários
console.log('2️⃣ USUÁRIOS DO SISTEMA:');
if (db.users) {
  db.users.forEach(u => {
    console.log(`   - ID: ${u.id} | Nome: ${u.name} | Role: ${u.role}`);
  });
}

console.log('\n');

// 3. Verificar produtos
console.log('3️⃣ PRODUTOS CADASTRADOS:');
if (db.products) {
  db.products.forEach(p => {
    console.log(`   - ID: ${p.id} | Nome: ${p.name} | Produtor ID: ${p.producerId}`);
  });
}

console.log('\n');

// 4. Verificar pedidos recentes
console.log('4️⃣ PEDIDOS RECENTES (últimos 5):');
if (db.orders && db.orders.length > 0) {
  const ultimosPedidos = db.orders.slice(-5);
  ultimosPedidos.forEach(o => {
    console.log(`   - ID: ${o.id} | Produto: ${o.productName} | Status: ${o.paymentStatus} | Produtor ID: ${o.producerId}`);
  });
} else {
  console.log('   ℹ️  Nenhum pedido criado ainda');
}

console.log('\n');

// 5. Verificar logs de webhook
console.log('5️⃣ LOGS DE WEBHOOK (últimos 10):');
if (db.webhookLogs && db.webhookLogs.length > 0) {
  const ultimosLogs = db.webhookLogs.slice(-10);
  ultimosLogs.forEach(log => {
    console.log(`   - ${log.dataHora} | ${log.webhookName} | Evento: ${log.evento} | ${log.sucesso ? '✅' : '❌'} Status: ${log.statusCode || 'ERRO'}`);
    if (log.erro) {
      console.log(`     Erro: ${log.erro}`);
    }
  });
} else {
  console.log('   ℹ️  Nenhum log de webhook registrado');
  console.log('   💡 Isso significa que nenhum webhook foi disparado ainda');
}

console.log('\n');

// Resumo de diagnóstico
console.log('📊 ====== RESUMO DO DIAGNÓSTICO ======\n');

const problemas = [];
const alertas = [];

if (!db.webhooks || db.webhooks.length === 0) {
  problemas.push('❌ Nenhum webhook cadastrado - CADASTRE UM WEBHOOK!');
}

if (db.webhooks && db.webhooks.length > 0) {
  const webhooksInativos = db.webhooks.filter(w => !w.status);
  if (webhooksInativos.length > 0) {
    alertas.push(`⚠️  ${webhooksInativos.length} webhook(s) INATIVO(S) - Ative o toggle!`);
  }

  const webhooksSemEventos = db.webhooks.filter(w => {
    const eventosAtivos = Object.values(w.events).filter(e => e === true);
    return eventosAtivos.length === 0;
  });
  if (webhooksSemEventos.length > 0) {
    alertas.push(`⚠️  ${webhooksSemEventos.length} webhook(s) sem eventos marcados!`);
  }
}

if (!db.webhookLogs || db.webhookLogs.length === 0) {
  alertas.push('⚠️  Nenhum webhook foi disparado ainda - crie um pedido teste');
}

if (problemas.length === 0 && alertas.length === 0) {
  console.log('✅ Tudo configurado corretamente!');
  console.log('');
  console.log('🧪 PRÓXIMO PASSO: Testar');
  console.log('   1. Crie um pedido de teste no checkout');
  console.log('   2. Verifique se o webhook chegou no Botconversa');
  console.log('   3. Veja os logs em Configurações > Webhooks > Logs');
} else {
  if (problemas.length > 0) {
    console.log('🚨 PROBLEMAS CRÍTICOS:');
    problemas.forEach(p => console.log(`   ${p}`));
    console.log('');
  }

  if (alertas.length > 0) {
    console.log('⚠️  ALERTAS:');
    alertas.forEach(a => console.log(`   ${a}`));
    console.log('');
  }
}

console.log('=====================================\n');
