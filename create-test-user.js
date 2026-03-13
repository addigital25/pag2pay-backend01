import bcrypt from 'bcryptjs';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';

async function createTestUser() {
  const db = JSON.parse(fs.readFileSync('database.json', 'utf8'));

  // Senha de teste: teste123
  const hashedPassword = await bcrypt.hash('teste123', 10);

  // Procurar se já existe usuário teste
  const existingIndex = db.users.findIndex(u => u.email === 'usuario@pag2pay.com');

  const testUser = {
    id: existingIndex !== -1 ? db.users[existingIndex].id : uuidv4(),
    email: 'usuario@pag2pay.com',
    password: hashedPassword,
    name: 'Usuário Teste',
    phone: '(11) 98765-4321',
    role: 'user',
    status: 'novo',
    commissionRate: 70,
    createdAt: existingIndex !== -1 ? db.users[existingIndex].createdAt : new Date().toISOString()
  };

  if (existingIndex !== -1) {
    db.users[existingIndex] = testUser;
    console.log('✅ Usuário de teste ATUALIZADO');
  } else {
    db.users.push(testUser);
    console.log('✅ Usuário de teste CRIADO');
  }

  fs.writeFileSync('database.json', JSON.stringify(db, null, 2));
  console.log('\n📋 Credenciais de Teste:');
  console.log('📧 Email: usuario@pag2pay.com');
  console.log('🔑 Senha: teste123');
  console.log('👤 Nome: Usuário Teste\n');
}

createTestUser();
