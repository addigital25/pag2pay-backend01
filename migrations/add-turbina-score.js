import { readFileSync, writeFileSync } from 'fs';
import { initializeTurbinaScores } from '../services/turbinaScore.js';

const DB_FILE = './database.json';

console.log('🚀 Executando migração: Adicionar turbinaScore aos produtos');
console.log('═'.repeat(60));

try {
  // Executar inicialização
  initializeTurbinaScores();

  console.log('═'.repeat(60));
  console.log('✅ Migração concluída com sucesso!');
  console.log('');
  console.log('📊 O campo turbinaScore foi adicionado a todos os produtos.');
  console.log('⚡ Os scores foram calculados automaticamente baseado nas vendas.');
  console.log('');
} catch (error) {
  console.error('❌ Erro na migração:', error);
  process.exit(1);
}
