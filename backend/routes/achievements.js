import express from 'express';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();
const ACHIEVEMENTS_FILE = path.join(__dirname, '../data/achievements.json');
const DB_FILE = path.join(__dirname, '../database.json');

// Helper: Ler database
function readDatabase() {
  if (!existsSync(DB_FILE)) {
    return { users: [], sales: [], withdrawals: [], userAchievements: [] };
  }
  return JSON.parse(readFileSync(DB_FILE, 'utf8'));
}

// Helper: Salvar database
function saveDatabase(data) {
  writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// Helper: Ler achievements
function readAchievements() {
  if (!existsSync(ACHIEVEMENTS_FILE)) {
    return [];
  }
  return JSON.parse(readFileSync(ACHIEVEMENTS_FILE, 'utf8'));
}

// GET /api/achievements - Listar todos os achievements disponíveis
router.get('/', (req, res) => {
  try {
    const achievements = readAchievements();
    res.json(achievements.filter(a => a.isActive));
  } catch (error) {
    console.error('Error fetching achievements:', error);
    res.status(500).json({ error: 'Erro ao buscar conquistas' });
  }
});

// GET /api/achievements/user/:userId - Buscar achievements de um usuário específico
router.get('/user/:userId', (req, res) => {
  try {
    const { userId } = req.params;
    const db = readDatabase();
    const achievements = readAchievements();

    // Buscar achievements do usuário
    const userAchievements = db.userAchievements?.filter(ua => ua.userId == userId) || [];

    // Combinar com dados completos de achievements
    const result = achievements.map(ach => {
      const userAch = userAchievements.find(ua => ua.achievementId === ach.id);

      return {
        ...ach,
        isUnlocked: userAch?.isUnlocked || false,
        unlockedAt: userAch?.unlockedAt || null,
        progress: userAch?.progress || 0,
        modalShown: userAch?.modalShown || false,
        userAchievementId: userAch?.id || null,
        physicalRewardRequested: userAch?.physicalRewardRequested || false,
        physicalRewardStatus: userAch?.physicalRewardStatus || null
      };
    });

    res.json(result);
  } catch (error) {
    console.error('Error fetching user achievements:', error);
    res.status(500).json({ error: 'Erro ao buscar conquistas do usuário' });
  }
});

// POST /api/achievements/check/:userId - Verificar e desbloquear achievements automaticamente
router.post('/check/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const db = readDatabase();
    const achievements = readAchievements();

    if (!db.userAchievements) {
      db.userAchievements = [];
    }

    const user = db.users?.find(u => u.id == userId);
    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    let newUnlocks = [];

    // Verificar cada achievement
    for (const ach of achievements) {
      if (!ach.isActive) continue;

      // Verificar se já foi desbloqueado
      const alreadyUnlocked = db.userAchievements.some(
        ua => ua.userId == userId && ua.achievementId === ach.id && ua.isUnlocked
      );

      if (alreadyUnlocked) continue;

      let shouldUnlock = false;
      let progress = 0;

      // Lógica de verificação baseada no tipo de requirement
      switch (ach.requirement.type) {
        case 'profile_complete':
          shouldUnlock = user.profileComplete === true;
          progress = shouldUnlock ? 100 : 0;
          break;

        case 'first_withdrawal':
          const withdrawals = db.withdrawals?.filter(w => w.userId == userId && w.status === 'completed') || [];
          shouldUnlock = withdrawals.length >= 1;
          progress = shouldUnlock ? 100 : 0;
          break;

        case 'total_sales':
          const sales = db.sales?.filter(s => s.userId == userId && s.status === 'paid') || [];
          const salesCount = sales.length;
          shouldUnlock = salesCount >= ach.requirement.value;
          progress = Math.min(100, (salesCount / ach.requirement.value) * 100);
          break;

        case 'total_withdrawals':
          const userWithdrawals = db.withdrawals?.filter(w => w.userId == userId && w.status === 'completed') || [];
          const totalWithdrawn = userWithdrawals.reduce((sum, w) => sum + (parseFloat(w.amount) || 0), 0);
          shouldUnlock = totalWithdrawn >= ach.requirement.value;
          progress = Math.min(100, (totalWithdrawn / ach.requirement.value) * 100);
          break;

        case 'account_created':
          // Conquista desbloqueada ao criar conta (sempre true para usuários existentes)
          shouldUnlock = true;
          progress = 100;
          break;

        case 'account_age_days':
          // Verificar idade da conta em dias
          if (user.createdAt) {
            const accountCreatedDate = new Date(user.createdAt);
            const now = new Date();
            const daysSinceCreation = Math.floor((now - accountCreatedDate) / (1000 * 60 * 60 * 24));
            shouldUnlock = daysSinceCreation >= ach.requirement.value;
            progress = Math.min(100, (daysSinceCreation / ach.requirement.value) * 100);
          }
          break;

        default:
          console.warn(`Unknown requirement type: ${ach.requirement.type}`);
      }

      // Se deve desbloquear, criar registro
      if (shouldUnlock) {
        const newAchievement = {
          id: `ua_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          userId: parseInt(userId),
          achievementId: ach.id,
          unlockedAt: new Date().toISOString(),
          progress: 100,
          isUnlocked: true,
          modalShown: false,
          physicalRewardRequested: ach.hasPhysicalReward ? false : null,
          physicalRewardStatus: ach.hasPhysicalReward ? 'pending' : null
        };

        db.userAchievements.push(newAchievement);
        newUnlocks.push({
          ...ach,
          userAchievementId: newAchievement.id
        });
      }
    }

    // Salvar se houver novos desbloqueios
    if (newUnlocks.length > 0) {
      saveDatabase(db);
    }

    res.json({
      newUnlocks,
      message: newUnlocks.length > 0 ? `${newUnlocks.length} nova(s) conquista(s) desbloqueada(s)!` : 'Nenhuma nova conquista'
    });
  } catch (error) {
    console.error('Error checking achievements:', error);
    res.status(500).json({ error: 'Erro ao verificar conquistas' });
  }
});

// POST /api/achievements/mark-shown/:userAchievementId - Marcar modal como exibido
router.post('/mark-shown/:userAchievementId', (req, res) => {
  try {
    const { userAchievementId } = req.params;
    const db = readDatabase();

    const userAch = db.userAchievements?.find(ua => ua.id === userAchievementId);
    if (!userAch) {
      return res.status(404).json({ error: 'Conquista de usuário não encontrada' });
    }

    userAch.modalShown = true;
    saveDatabase(db);

    res.json({ success: true, message: 'Modal marcado como exibido' });
  } catch (error) {
    console.error('Error marking modal as shown:', error);
    res.status(500).json({ error: 'Erro ao marcar modal como exibido' });
  }
});

// POST /api/achievements/request-physical/:userAchievementId - Solicitar placa física
router.post('/request-physical/:userAchievementId', (req, res) => {
  try {
    const { userAchievementId } = req.params;
    const db = readDatabase();

    const userAch = db.userAchievements?.find(ua => ua.id === userAchievementId);
    if (!userAch) {
      return res.status(404).json({ error: 'Conquista de usuário não encontrada' });
    }

    const achievements = readAchievements();
    const achievement = achievements.find(a => a.id === userAch.achievementId);

    if (!achievement?.hasPhysicalReward) {
      return res.status(400).json({ error: 'Esta conquista não possui recompensa física' });
    }

    userAch.physicalRewardRequested = true;
    userAch.physicalRewardStatus = 'requested';
    userAch.requestedAt = new Date().toISOString();

    saveDatabase(db);

    res.json({ success: true, message: 'Solicitação de placa física registrada' });
  } catch (error) {
    console.error('Error requesting physical reward:', error);
    res.status(500).json({ error: 'Erro ao solicitar recompensa física' });
  }
});

// ==========================================
// ENDPOINTS PARA ADMINISTRADORES
// ==========================================

// GET /api/admin/users-achievements - Listar todos os usuários com resumo de suas conquistas
router.get('/admin/users-achievements', (req, res) => {
  try {
    const db = readDatabase();
    const achievements = readAchievements();

    // Buscar todos os usuários
    const users = db.users || [];

    // Mapear usuários com resumo de conquistas
    const usersWithAchievements = users.map(user => {
      const userAchievements = db.userAchievements?.filter(ua => ua.userId == user.id) || [];
      const unlockedAchievements = userAchievements.filter(ua => ua.isUnlocked);
      const physicalRewards = userAchievements.filter(ua => {
        const ach = achievements.find(a => a.id === ua.achievementId);
        return ach?.hasPhysicalReward && ua.isUnlocked;
      });

      return {
        id: user.id,
        name: user.name,
        email: user.email,
        totalAchievements: achievements.filter(a => a.isActive).length,
        unlockedAchievements: unlockedAchievements.length,
        physicalRewards: physicalRewards.length
      };
    });

    res.json(usersWithAchievements);
  } catch (error) {
    console.error('Error fetching users achievements:', error);
    res.status(500).json({ error: 'Erro ao buscar conquistas dos usuários' });
  }
});

// GET /api/admin/user/:userId/achievements - Buscar todas as conquistas de um usuário específico (para admin)
router.get('/admin/user/:userId/achievements', (req, res) => {
  try {
    const { userId } = req.params;
    const db = readDatabase();
    const achievements = readAchievements();

    // Verificar se usuário existe
    const user = db.users?.find(u => u.id == userId);
    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    // Buscar achievements do usuário
    const userAchievements = db.userAchievements?.filter(ua => ua.userId == userId) || [];

    // Combinar com dados completos de achievements
    const result = achievements.map(ach => {
      const userAch = userAchievements.find(ua => ua.achievementId === ach.id);

      return {
        ...ach,
        isUnlocked: userAch?.isUnlocked || false,
        unlockedAt: userAch?.unlockedAt || null,
        progress: userAch?.progress || 0,
        modalShown: userAch?.modalShown || false,
        userAchievementId: userAch?.id || null,
        physicalRewardRequested: userAch?.physicalRewardRequested || false,
        physicalRewardStatus: userAch?.physicalRewardStatus || null
      };
    });

    res.json(result);
  } catch (error) {
    console.error('Error fetching user achievements for admin:', error);
    res.status(500).json({ error: 'Erro ao buscar conquistas do usuário' });
  }
});

export default router;
