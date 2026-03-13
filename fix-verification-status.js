const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, 'db.json');

// Ler o banco de dados
const readDB = () => {
  try {
    const data = fs.readFileSync(dbPath, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Erro ao ler o banco de dados:', error);
    return { users: [], userVerifications: [] };
  }
};

// Escrever no banco de dados
const writeDB = (data) => {
  try {
    fs.writeFileSync(dbPath, JSON.stringify(data, null, 2), 'utf-8');
    console.log('✅ Banco de dados atualizado com sucesso!');
  } catch (error) {
    console.error('❌ Erro ao escrever no banco de dados:', error);
  }
};

// Corrigir status
const fixVerificationStatus = () => {
  const db = readDB();

  if (!db.userVerifications || db.userVerifications.length === 0) {
    console.log('ℹ️ Nenhuma verificação encontrada no banco de dados.');
    return;
  }

  let fixedCount = 0;

  db.userVerifications = db.userVerifications.map((verification) => {
    // Se o status principal é 'not_submitted' ou 'draft', corrigir sub-status
    if (verification.status === 'not_submitted' || verification.status === 'draft') {
      const needsFix =
        verification.kyc?.status !== 'not_submitted' ||
        verification.documentos?.statusSelfie !== 'not_submitted' ||
        verification.documentos?.statusDocumento !== 'not_submitted' ||
        verification.dadosBancarios?.status !== 'not_submitted';

      if (needsFix) {
        fixedCount++;
        console.log(`🔧 Corrigindo verificação do usuário ${verification.userId}...`);

        return {
          ...verification,
          status: 'not_submitted',
          kyc: { status: 'not_submitted' },
          documentos: {
            statusSelfie: 'not_submitted',
            statusDocumento: 'not_submitted'
          },
          dadosBancarios: { status: 'not_submitted' }
        };
      }
    }

    return verification;
  });

  if (fixedCount > 0) {
    writeDB(db);
    console.log(`✅ ${fixedCount} verificação(ões) corrigida(s)!`);
  } else {
    console.log('✅ Nenhuma verificação precisou ser corrigida.');
  }
};

// Executar o script
console.log('🚀 Iniciando correção de status de verificações...\n');
fixVerificationStatus();
console.log('\n✨ Processo concluído!');
