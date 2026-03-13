import bcrypt from 'bcryptjs';

const SALT_ROUNDS = 10;

/**
 * Gera hash de uma senha
 * @param {string} password - Senha em texto plano
 * @returns {Promise<string>} Hash da senha
 */
export const hashPassword = async (password) => {
  return await bcrypt.hash(password, SALT_ROUNDS);
};

/**
 * Compara uma senha em texto plano com um hash
 * @param {string} password - Senha em texto plano
 * @param {string} hash - Hash armazenado
 * @returns {Promise<boolean>} True se a senha está correta
 */
export const comparePassword = async (password, hash) => {
  return await bcrypt.compare(password, hash);
};

/**
 * Verifica se uma string já é um hash bcrypt
 * @param {string} str - String para verificar
 * @returns {boolean} True se for um hash bcrypt
 */
export const isBcryptHash = (str) => {
  return str && str.startsWith('$2a$') || str.startsWith('$2b$') || str.startsWith('$2y$');
};
