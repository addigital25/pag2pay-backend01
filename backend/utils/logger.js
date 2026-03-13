import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, '..', 'database.json');

// Função para ler o database
function readDatabase() {
  try {
    const data = fs.readFileSync(dbPath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Erro ao ler database:', error);
    return null;
  }
}

// Função para salvar o database
function saveDatabase(db) {
  try {
    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.error('Erro ao salvar database:', error);
    return false;
  }
}

/**
 * Registra um log da plataforma
 * @param {string} level - Nível do log: 'info', 'success', 'warning', 'error'
 * @param {string} action - Ação realizada (ex: 'USER_LOGIN', 'APPROVAL_GRANTED')
 * @param {string} user - Email ou identificador do usuário
 * @param {string} description - Descrição da ação
 * @param {string} ip - IP do usuário
 * @param {string} details - Detalhes adicionais
 */
function logPlatformAction(level, action, user, description, ip = 'unknown', details = '') {
  const db = readDatabase();
  if (!db) return false;

  // Inicializar array de logs se não existir
  if (!db.platformLogs) {
    db.platformLogs = [];
  }

  // Criar novo log
  const newLog = {
    id: db.platformLogs.length + 1,
    timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
    level: level,
    action: action,
    user: user,
    description: description,
    ip: ip,
    details: details
  };

  // Adicionar log no início do array (mais recentes primeiro)
  db.platformLogs.unshift(newLog);

  // Limitar a 1000 logs para não crescer infinitamente
  if (db.platformLogs.length > 1000) {
    db.platformLogs = db.platformLogs.slice(0, 1000);
  }

  // Salvar database
  return saveDatabase(db);
}

// Funções de conveniência
const logger = {
  info: (action, user, description, ip, details) => {
    return logPlatformAction('info', action, user, description, ip, details);
  },
  success: (action, user, description, ip, details) => {
    return logPlatformAction('success', action, user, description, ip, details);
  },
  warning: (action, user, description, ip, details) => {
    return logPlatformAction('warning', action, user, description, ip, details);
  },
  error: (action, user, description, ip, details) => {
    return logPlatformAction('error', action, user, description, ip, details);
  }
};

export { logger, logPlatformAction };
