import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ler o banco de dados atual
const dbPath = path.join(__dirname, 'database.json');
const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));

// Produto fake realista para testes
const fakeProduct = {
  id: "fake-prod-emagrecedor-001",
  code: "EMAGRECE01",
  name: "Emagrecedor Natural Premium",
  description: "Suplemento natural para emagrecimento saudável. Fórmula exclusiva com ingredientes naturais que aceleram o metabolismo e auxiliam na queima de gordura.",
  price: 197.00,
  image: "https://via.placeholder.com/400x300/FF6B6B/FFFFFF?text=Emagrecedor+Premium",
  producerId: "2",
  producerName: "Usuário Demo",
  affiliateEnabled: true,
  affiliateCommission: 40,
  paymentMethods: {
    pix: true,
    boleto: true,
    creditCard: true,
    afterPay: true
  },
  category: "Saúde e Bem-estar",
  productType: "Físico",
  status: "active",
  approvalStatus: "APROVADO",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),

  // Planos realistas com preços progressivos
  plans: [
    {
      id: Date.now() + 1,
      code: "EMG1MES",
      name: "1 Frasco - Experimente",
      description: "Teste o produto por 30 dias",
      price: 197.00,
      itemsQuantity: 1,
      isActive: true,
      status: 'ATIVO',
      approvedSales: 0,
      paymentMethods: {
        creditCard: true,
        boleto: true,
        pix: true,
        afterPay: true
      },
      maxInstallments: 12,
      createdAt: new Date().toISOString()
    },
    {
      id: Date.now() + 2,
      code: "EMG3MES",
      name: "3 Frascos - Recomendado",
      description: "Tratamento de 90 dias - Economize 15%",
      price: 497.00,
      itemsQuantity: 3,
      isActive: true,
      status: 'ATIVO',
      approvedSales: 0,
      paymentMethods: {
        creditCard: true,
        boleto: true,
        pix: true,
        afterPay: true
      },
      maxInstallments: 12,
      createdAt: new Date().toISOString()
    },
    {
      id: Date.now() + 3,
      code: "EMG5MES",
      name: "5 Frascos - Super Oferta",
      description: "Tratamento completo de 150 dias - Economize 25%",
      price: 737.00,
      itemsQuantity: 5,
      isActive: true,
      status: 'ATIVO',
      approvedSales: 0,
      paymentMethods: {
        creditCard: true,
        boleto: true,
        pix: true,
        afterPay: true
      },
      maxInstallments: 12,
      createdAt: new Date().toISOString()
    },
    {
      id: Date.now() + 4,
      code: "EMG10MES",
      name: "10 Frascos - Melhor Preço",
      description: "Fornecimento de 300 dias - Economize 35%",
      price: 1277.00,
      itemsQuantity: 10,
      isActive: true,
      status: 'ATIVO',
      approvedSales: 0,
      paymentMethods: {
        creditCard: true,
        boleto: true,
        pix: true,
        afterPay: true
      },
      maxInstallments: 12,
      createdAt: new Date().toISOString()
    }
  ],

  // Array de cupons vazio (sem cupons para teste)
  coupons: [],

  // Configuração de checkout
  checkoutConfig: {
    paymentMethods: {
      pix: true,
      boleto: true,
      creditCard: true,
      receiveAndPay: true
    },
    fieldsRequired: {
      name: true,
      email: true,
      phone: true,
      cpf: true,
      address: true,
      city: true,
      state: true,
      zipCode: true
    }
  },

  // Configuração de afiliados
  affiliation: {
    enabled: true,
    commission: 40,
    customCommission: false
  }
};

// Verificar se o produto já existe
const existingIndex = db.products.findIndex(p => p.id === fakeProduct.id);

if (existingIndex !== -1) {
  // Atualizar produto existente
  db.products[existingIndex] = fakeProduct;
  console.log('✅ Produto fake ATUALIZADO:', fakeProduct.name);
} else {
  // Adicionar novo produto
  db.products.push(fakeProduct);
  console.log('✅ Produto fake CRIADO:', fakeProduct.name);
}

// Salvar de volta no banco de dados
fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));

console.log('\n📦 Detalhes do produto fake:');
console.log('   ID:', fakeProduct.id);
console.log('   Nome:', fakeProduct.name);
console.log('   Código:', fakeProduct.code);
console.log('   Categoria:', fakeProduct.category);
console.log('   Preço base:', `R$ ${fakeProduct.price.toFixed(2)}`);
console.log('   Comissão afiliado:', `${fakeProduct.affiliateCommission}%`);
console.log('\n📋 Planos criados:', fakeProduct.plans.length);
fakeProduct.plans.forEach((plan, index) => {
  console.log(`   ${index + 1}. ${plan.name} - R$ ${plan.price.toFixed(2)} (${plan.itemsQuantity} frascos)`);
});
console.log('\n🎟️ Cupons:', fakeProduct.coupons.length, '(sem cupons - pronto para testes)');
console.log('\n🎯 Produto pronto para testar:');
console.log('   ✓ Criação de cupons');
console.log('   ✓ Edição de planos');
console.log('   ✓ Checkout com múltiplos planos');
console.log('   ✓ Sistema de afiliados');
console.log('\n🌐 Acesse: http://localhost:3000/admin/products/edit/' + fakeProduct.id);
