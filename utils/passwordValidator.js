// Validador de Senha Forte
// Requisitos: mínimo 8 caracteres, letras maiúsculas, minúsculas, números e caracteres especiais

/**
 * Valida se a senha atende aos requisitos de segurança
 * @param {string} password - Senha a ser validada
 * @returns {Object} { valid: boolean, errors: string[] }
 */
export function validatePassword(password) {
  const errors = [];

  // Verificar comprimento mínimo
  if (!password || password.length < 8) {
    errors.push('A senha deve ter no mínimo 8 caracteres');
  }

  // Verificar comprimento máximo (segurança contra DoS)
  if (password && password.length > 128) {
    errors.push('A senha deve ter no máximo 128 caracteres');
  }

  // Verificar se contém letra minúscula
  if (!/[a-z]/.test(password)) {
    errors.push('A senha deve conter pelo menos uma letra minúscula');
  }

  // Verificar se contém letra maiúscula
  if (!/[A-Z]/.test(password)) {
    errors.push('A senha deve conter pelo menos uma letra maiúscula');
  }

  // Verificar se contém número
  if (!/[0-9]/.test(password)) {
    errors.push('A senha deve conter pelo menos um número');
  }

  // Verificar se contém caractere especial
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
    errors.push('A senha deve conter pelo menos um caractere especial (!@#$%^&*()_+-=[]{};\':"|,.<>?/)');
  }

  // Verificar sequências comuns
  const commonSequences = [
    '123456', '12345678', 'abcdef', 'qwerty', 'password',
    'senha123', '111111', '000000', 'admin123'
  ];

  const lowerPassword = password.toLowerCase();
  for (const sequence of commonSequences) {
    if (lowerPassword.includes(sequence)) {
      errors.push('A senha não pode conter sequências comuns (123456, qwerty, password, etc.)');
      break;
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Verifica força da senha e retorna nível
 * @param {string} password - Senha a ser verificada
 * @returns {Object} { strength: string, score: number }
 */
export function getPasswordStrength(password) {
  let score = 0;

  if (!password) {
    return { strength: 'Muito Fraca', score: 0 };
  }

  // Comprimento
  if (password.length >= 8) score += 1;
  if (password.length >= 12) score += 1;
  if (password.length >= 16) score += 1;

  // Variedade de caracteres
  if (/[a-z]/.test(password)) score += 1;
  if (/[A-Z]/.test(password)) score += 1;
  if (/[0-9]/.test(password)) score += 1;
  if (/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) score += 1;

  // Diversidade (caracteres únicos)
  const uniqueChars = new Set(password).size;
  if (uniqueChars >= 8) score += 1;
  if (uniqueChars >= 12) score += 1;

  // Classificação
  if (score >= 8) {
    return { strength: 'Muito Forte', score };
  } else if (score >= 6) {
    return { strength: 'Forte', score };
  } else if (score >= 4) {
    return { strength: 'Média', score };
  } else if (score >= 2) {
    return { strength: 'Fraca', score };
  } else {
    return { strength: 'Muito Fraca', score };
  }
}

/**
 * Gera sugestão de senha forte
 * @returns {string} Senha forte gerada
 */
export function generateStrongPassword() {
  const lowercase = 'abcdefghijklmnopqrstuvwxyz';
  const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const numbers = '0123456789';
  const special = '!@#$%^&*()_+-=[]{}';

  let password = '';

  // Garantir pelo menos um de cada tipo
  password += lowercase[Math.floor(Math.random() * lowercase.length)];
  password += uppercase[Math.floor(Math.random() * uppercase.length)];
  password += numbers[Math.floor(Math.random() * numbers.length)];
  password += special[Math.floor(Math.random() * special.length)];

  // Adicionar mais caracteres aleatórios
  const allChars = lowercase + uppercase + numbers + special;
  for (let i = password.length; i < 12; i++) {
    password += allChars[Math.floor(Math.random() * allChars.length)];
  }

  // Embaralhar
  return password.split('').sort(() => Math.random() - 0.5).join('');
}
