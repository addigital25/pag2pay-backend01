# Platform Admin API - Documentação Completa

## 🔐 Autenticação

Todas as rotas (exceto `/login`) requerem autenticação via JWT Bearer token.

**Header obrigatório:**
```
Authorization: Bearer {seu-token-aqui}
```

---

## 📋 Endpoints

### 1. Autenticação

#### POST `/api/platform/login`
Autenticar admin da plataforma.

**Body:**
```json
{
  "email": "admin@pag2pay.com",
  "password": "admin123"
}
```

**Resposta (200):**
```json
{
  "user": {
    "id": "platform-admin-1",
    "email": "admin@pag2pay.com",
    "name": "Platform Admin",
    "userType": "platform-admin"
  },
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**Segurança:**
- Senha armazenada com bcrypt hash
- Token JWT expira em 7 dias
- Primeiro login cria automaticamente o hash da senha

---

### 2. Estatísticas

#### GET `/api/platform/stats`
Obter estatísticas gerais da plataforma.

**Resposta (200):**
```json
{
  "totalUsers": 3,
  "pendingUsers": 1,
  "approvedUsers": 1,
  "totalProducts": 5,
  "pendingProducts": 2,
  "activeProducts": 2,
  "totalRevenue": 103622.00,
  "totalCommission": 3108.66
}
```

---

### 3. Gerenciamento de Usuários

#### GET `/api/platform/users`
Listar usuários com paginação e filtros avançados.

**Query Parameters:**

| Parâmetro | Tipo | Descrição | Padrão |
|-----------|------|-----------|--------|
| `page` | number | Número da página | 1 |
| `limit` | number | Itens por página | 10 |
| `status` | string | Filtrar por status (pending, approved, rejected) | - |
| `accountType` | string | Filtrar por tipo (pf, pj) | - |
| `withdrawalLocked` | boolean | Filtrar por saque bloqueado | - |
| `splitStatus` | string | Filtrar por status split | - |
| `search` | string | Busca textual (nome, email, cpf, cnpj, telefone) | - |
| `sortBy` | string | Campo para ordenar | createdAt |
| `sortOrder` | string | Ordem (asc, desc) | desc |

**Exemplos:**
```bash
# Usuários pendentes, página 1
GET /api/platform/users?status=pending&page=1&limit=10

# Usuários PJ com saque bloqueado
GET /api/platform/users?accountType=pj&withdrawalLocked=true

# Buscar por nome
GET /api/platform/users?search=joão

# Ordenar por total de vendas
GET /api/platform/users?sortBy=totalSales&sortOrder=desc
```

**Resposta (200):**
```json
{
  "users": [...],
  "pagination": {
    "currentPage": 1,
    "totalPages": 3,
    "totalItems": 25,
    "itemsPerPage": 10,
    "hasNextPage": true,
    "hasPrevPage": false
  },
  "filters": {
    "status": "pending",
    "accountType": null,
    "withdrawalLocked": null,
    "splitStatus": null,
    "search": null
  }
}
```

---

#### GET `/api/platform/users/:id`
Obter detalhes completos de um usuário.

**Resposta (200):**
```json
{
  "id": 1,
  "name": "Carolina Pires dos Santos",
  "email": "carolpsantos11@gmail.com",
  "phone": "(64) 99221-4255",
  "accountType": "pf",
  "cpf": "043.782.441-10",
  "status": "approved",
  "kyc": {...},
  "enderecoPF": {...},
  "documentos": {...},
  "dadosBancarios": {...},
  "splitStatus": "active",
  "withdrawalLocked": false
}
```

---

#### POST `/api/platform/users/:id/approve`
Aprovar usuário e todos os seus documentos/dados bancários.

**Resposta (200):**
```json
{
  "message": "Usuário aprovado com sucesso",
  "user": {...}
}
```

---

#### POST `/api/platform/users/:id/reject`
Rejeitar usuário.

**Body:**
```json
{
  "reason": "Documentos inválidos"
}
```

**Resposta (200):**
```json
{
  "message": "Usuário rejeitado",
  "user": {...}
}
```

---

#### PATCH `/api/platform/users/:id/status`
Atualizar status do usuário.

**Body:**
```json
{
  "status": "approved"
}
```

---

#### POST `/api/platform/users/:id/lock-withdrawal`
Travar ou destravar saque do usuário.

**Body:**
```json
{
  "locked": true
}
```

**Resposta (200):**
```json
{
  "message": "Saque travado",
  "user": {...}
}
```

---

#### POST `/api/platform/users/:id/documents/:type/approve`
Aprovar documento específico.

**Tipos disponíveis:** `selfie`, `documento`, `contrato`

**Exemplo:**
```bash
POST /api/platform/users/2/documents/selfie/approve
```

---

#### POST `/api/platform/users/:id/documents/:type/reject`
Rejeitar documento específico.

**Body:**
```json
{
  "reason": "Foto fora de foco"
}
```

---

#### POST `/api/platform/users/:id/bank-account/approve`
Aprovar conta bancária.

---

#### POST `/api/platform/users/:id/bank-account/reject`
Rejeitar conta bancária.

**Body:**
```json
{
  "reason": "Dados não conferem"
}
```

---

### 4. Gerenciamento de Produtos

#### GET `/api/platform/products`
Listar produtos com paginação e filtros avançados.

**Query Parameters:**

| Parâmetro | Tipo | Descrição | Padrão |
|-----------|------|-----------|--------|
| `page` | number | Número da página | 1 |
| `limit` | number | Itens por página | 10 |
| `status` | string | Filtrar por status (pending, active, suspended, rejected) | - |
| `category` | string | Filtrar por categoria | - |
| `seller` | string | Filtrar por vendedor | - |
| `minPrice` | number | Preço mínimo | - |
| `maxPrice` | number | Preço máximo | - |
| `minSales` | number | Vendas mínimas | - |
| `maxSales` | number | Vendas máximas | - |
| `search` | string | Busca textual | - |
| `sortBy` | string | Campo para ordenar | createdAt |
| `sortOrder` | string | Ordem (asc, desc) | desc |

**Exemplos:**
```bash
# Produtos pendentes
GET /api/platform/products?status=pending

# Produtos da categoria Cursos com preço entre 100 e 500
GET /api/platform/products?category=Cursos&minPrice=100&maxPrice=500

# Top vendedores
GET /api/platform/products?sortBy=sales&sortOrder=desc&limit=10

# Buscar por nome
GET /api/platform/products?search=react
```

**Resposta (200):**
```json
{
  "products": [...],
  "pagination": {
    "currentPage": 1,
    "totalPages": 2,
    "totalItems": 15,
    "itemsPerPage": 10,
    "hasNextPage": true,
    "hasPrevPage": false
  },
  "stats": {
    "totalRevenue": 103622.00,
    "totalSales": 1126,
    "totalCommission": 3108.66,
    "averagePrice": 207.24
  },
  "filters": {
    "status": "pending",
    "category": null,
    "seller": null,
    "minPrice": null,
    "maxPrice": null,
    "search": null
  }
}
```

---

#### GET `/api/platform/products/:id`
Obter detalhes de um produto.

**Resposta (200):**
```json
{
  "id": 1,
  "name": "Curso de React Avançado",
  "seller": "João Silva",
  "sellerId": 123,
  "price": 297.00,
  "sales": 156,
  "revenue": 46332.00,
  "commission": 1389.96,
  "status": "active",
  "category": "Cursos",
  "createdAt": "2024-01-15"
}
```

---

#### POST `/api/platform/products/:id/approve`
Aprovar produto.

**Resposta (200):**
```json
{
  "message": "Produto aprovado com sucesso",
  "product": {...}
}
```

---

#### POST `/api/platform/products/:id/reject`
Rejeitar produto.

**Body:**
```json
{
  "reason": "Conteúdo inadequado"
}
```

---

#### PATCH `/api/platform/products/:id/status`
Atualizar status do produto.

**Body:**
```json
{
  "status": "active"
}
```

---

#### POST `/api/platform/products/:id/suspend`
Suspender produto.

**Body:**
```json
{
  "reason": "Reclamações de clientes"
}
```

**Resposta (200):**
```json
{
  "message": "Produto suspenso",
  "product": {...}
}
```

---

## 📊 Paginação

### Estrutura de Resposta
```json
{
  "data": [...],
  "pagination": {
    "currentPage": 1,
    "totalPages": 5,
    "totalItems": 47,
    "itemsPerPage": 10,
    "hasNextPage": true,
    "hasPrevPage": false
  }
}
```

### Navegação
- **Primeira página:** `?page=1`
- **Próxima página:** `?page=2`
- **Itens por página:** `?limit=20`

---

## 🔍 Filtros Avançados

### Operadores de Comparação
- **Texto:** Busca parcial case-insensitive
- **Números:** Operadores min/max para intervalos
- **Booleanos:** true/false
- **Datas:** Ordenação cronológica

### Exemplos de Filtros Combinados
```bash
# Usuários PJ aprovados com vendas acima de 10000
GET /api/platform/users?accountType=pj&status=approved&minSales=10000

# Produtos da categoria Cursos, pendentes, com preço até 500
GET /api/platform/products?category=Cursos&status=pending&maxPrice=500

# Top 5 produtos mais vendidos
GET /api/platform/products?sortBy=sales&sortOrder=desc&limit=5
```

---

## 🔒 Segurança

### Hashing de Senhas
- Algoritmo: **bcrypt**
- Salt Rounds: **10**
- Verificação automática de hash vs texto plano

### JWT
- Algoritmo: **HS256**
- Expiração: **7 dias**
- Claims: id, email, role, name

### Proteção de Rotas
- Middleware `authMiddleware`: Valida token
- Middleware `adminMiddleware`: Verifica role platform-admin
- Todas as rotas protegidas exceto `/login`

---

## ⚠️ Códigos de Erro

| Código | Descrição |
|--------|-----------|
| 200 | Sucesso |
| 400 | Requisição inválida |
| 401 | Não autenticado |
| 403 | Acesso negado |
| 404 | Recurso não encontrado |
| 500 | Erro interno |

---

## 📝 Notas

1. Todos os endpoints requerem autenticação
2. Token deve ser incluído no header Authorization
3. Paginação padrão: 10 itens por página
4. Ordenação padrão: createdAt descendente
5. Busca é case-insensitive
6. Filtros podem ser combinados
