/**
 * ============================================================
 *  Auth — Autenticação JWT + bcrypt
 * ============================================================
 *
 *  - hashPassword / comparePassword: bcrypt com salt round 10
 *  - generateToken: JWT com expiração de 7 dias
 *  - auth middleware: valida Bearer token em todas as rotas protegidas
 *
 *  IMPORTANTE: Se JWT_SECRET não estiver definido no .env,
 *  será gerado um secret aleatório — os tokens são invalidados
 *  a cada restart do servidor (usuários terão que logar novamente).
 *  Em produção, SEMPRE defina JWT_SECRET nas variáveis do Railway.
 * ============================================================
 */

const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const crypto = require('crypto');

// Secret para assinar os tokens JWT
// Se não existir no .env, gera aleatório (não sobrevive a restarts)
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET) {
  console.warn('[auth] AVISO: JWT_SECRET não definido. Usando secret aleatório — tokens serão invalidados ao reiniciar.');
}

/** Gera hash bcrypt da senha (salt round 10) */
function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

/** Compara senha em texto plano com hash bcrypt */
function comparePassword(password, hash) {
  return bcrypt.compareSync(password, hash);
}

/** Gera token JWT com id e email do usuário, expira em 7 dias */
function generateToken(user) {
  return jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
}

/**
 * Middleware de autenticação
 * Extrai o token do header Authorization: Bearer <token>
 * Decodifica e injeta req.userId para uso nas rotas
 */
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token não fornecido' });
  }
  try {
    const token = header.slice(7);
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.id; // Disponível em todas as rotas protegidas
    next();
  } catch {
    return res.status(401).json({ error: 'Token inválido ou expirado' });
  }
}

module.exports = { hashPassword, comparePassword, generateToken, auth, JWT_SECRET };
