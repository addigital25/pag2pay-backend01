import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_FILE = path.join(__dirname, 'database.json');

// Ler o banco de dados
const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));

console.log(`📊 Total de produtos ANTES da remoção: ${db.products.length}`);

// IDs dos produtos fake a serem removidos
const fakeProductIds = [
  'mock-test-product-001',
  'fake-prod-emagrecedor-001'
];

// Remover produtos fake
db.products = db.products.filter(product => {
  const isFake = fakeProductIds.includes(product.id);
  if (isFake) {
    console.log(`❌ Removendo produto fake: ${product.id} - "${product.name}"`);
  }
  return !isFake;
});

console.log(`✅ Total de produtos DEPOIS da remoção: ${db.products.length}`);

// Salvar o banco de dados atualizado
fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');

console.log(`\n✅ Produtos fake removidos com sucesso!`);
console.log(`\nProdutos restantes:`);
db.products.forEach(p => {
  console.log(`  - ${p.id}: "${p.name}" (Status: ${p.approvalStatus})`);
});
