# Platform Admin API - Testes de Requisições

## Configuração

**Base URL:** `http://localhost:3001/api/platform`

**Credenciais de Login:**
- Email: `admin@pag2pay.com`
- Senha: `admin123`

---

## 1. Autenticação

### Login do Platform Admin
```bash
curl -X POST http://localhost:3001/api/platform/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@pag2pay.com",
    "password": "admin123"
  }'
```

**Resposta Esperada:**
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

---

## 2. Estatísticas

### Obter Estatísticas Gerais
```bash
curl -X GET http://localhost:3001/api/platform/stats \
  -H "Authorization: Bearer SEU_TOKEN_AQUI"
```

**Resposta Esperada:**
```json
{
  "totalUsers": 3,
  "pendingUsers": 1,
  "approvedUsers": 1,
  "totalProducts": 5,
  "pendingProducts": 2,
  "activeProducts": 2,
  "totalRevenue": 103622,
  "totalCommission": 3108.66
}
```

---

## 3. Gerenciamento de Usuários

### Listar Todos os Usuários
```bash
curl -X GET http://localhost:3001/api/platform/users \
  -H "Authorization: Bearer SEU_TOKEN_AQUI"
```

### Listar Usuários Pendentes
```bash
curl -X GET "http://localhost:3001/api/platform/users?status=pending" \
  -H "Authorization: Bearer SEU_TOKEN_AQUI"
```

### Buscar Usuários por Nome/Email
```bash
curl -X GET "http://localhost:3001/api/platform/users?search=joão" \
  -H "Authorization: Bearer SEU_TOKEN_AQUI"
```

### Obter Detalhes de um Usuário
```bash
curl -X GET http://localhost:3001/api/platform/users/1 \
  -H "Authorization: Bearer SEU_TOKEN_AQUI"
```

### Aprovar Usuário
```bash
curl -X POST http://localhost:3001/api/platform/users/2/approve \
  -H "Authorization: Bearer SEU_TOKEN_AQUI" \
  -H "Content-Type: application/json"
```

### Rejeitar Usuário
```bash
curl -X POST http://localhost:3001/api/platform/users/2/reject \
  -H "Authorization: Bearer SEU_TOKEN_AQUI" \
  -H "Content-Type: application/json" \
  -d '{
    "reason": "Documentos inválidos ou incompletos"
  }'
```

### Atualizar Status do Usuário
```bash
curl -X PATCH http://localhost:3001/api/platform/users/2/status \
  -H "Authorization: Bearer SEU_TOKEN_AQUI" \
  -H "Content-Type: application/json" \
  -d '{
    "status": "approved"
  }'
```

### Travar Saque de Usuário
```bash
curl -X POST http://localhost:3001/api/platform/users/1/lock-withdrawal \
  -H "Authorization: Bearer SEU_TOKEN_AQUI" \
  -H "Content-Type: application/json" \
  -d '{
    "locked": true
  }'
```

### Destravar Saque de Usuário
```bash
curl -X POST http://localhost:3001/api/platform/users/1/lock-withdrawal \
  -H "Authorization: Bearer SEU_TOKEN_AQUI" \
  -H "Content-Type: application/json" \
  -d '{
    "locked": false
  }'
```

### Aprovar Documento Específico
```bash
curl -X POST http://localhost:3001/api/platform/users/2/documents/selfie/approve \
  -H "Authorization: Bearer SEU_TOKEN_AQUI"
```

### Rejeitar Documento Específico
```bash
curl -X POST http://localhost:3001/api/platform/users/2/documents/selfie/reject \
  -H "Authorization: Bearer SEU_TOKEN_AQUI" \
  -H "Content-Type: application/json" \
  -d '{
    "reason": "Foto fora de foco ou não identifica o rosto"
  }'
```

### Aprovar Conta Bancária
```bash
curl -X POST http://localhost:3001/api/platform/users/2/bank-account/approve \
  -H "Authorization: Bearer SEU_TOKEN_AQUI"
```

### Rejeitar Conta Bancária
```bash
curl -X POST http://localhost:3001/api/platform/users/2/bank-account/reject \
  -H "Authorization: Bearer SEU_TOKEN_AQUI" \
  -H "Content-Type: application/json" \
  -d '{
    "reason": "Dados bancários não conferem com o titular"
  }'
```

---

## 4. Gerenciamento de Produtos

### Listar Todos os Produtos
```bash
curl -X GET http://localhost:3001/api/platform/products \
  -H "Authorization: Bearer SEU_TOKEN_AQUI"
```

### Listar Produtos Pendentes
```bash
curl -X GET "http://localhost:3001/api/platform/products?status=pending" \
  -H "Authorization: Bearer SEU_TOKEN_AQUI"
```

### Buscar Produtos por Nome
```bash
curl -X GET "http://localhost:3001/api/platform/products?search=react" \
  -H "Authorization: Bearer SEU_TOKEN_AQUI"
```

### Obter Detalhes de um Produto
```bash
curl -X GET http://localhost:3001/api/platform/products/1 \
  -H "Authorization: Bearer SEU_TOKEN_AQUI"
```

### Aprovar Produto
```bash
curl -X POST http://localhost:3001/api/platform/products/3/approve \
  -H "Authorization: Bearer SEU_TOKEN_AQUI" \
  -H "Content-Type: application/json"
```

### Rejeitar Produto
```bash
curl -X POST http://localhost:3001/api/platform/products/3/reject \
  -H "Authorization: Bearer SEU_TOKEN_AQUI" \
  -H "Content-Type: application/json" \
  -d '{
    "reason": "Conteúdo não está de acordo com as políticas da plataforma"
  }'
```

### Atualizar Status do Produto
```bash
curl -X PATCH http://localhost:3001/api/platform/products/3/status \
  -H "Authorization: Bearer SEU_TOKEN_AQUI" \
  -H "Content-Type: application/json" \
  -d '{
    "status": "active"
  }'
```

### Suspender Produto
```bash
curl -X POST http://localhost:3001/api/platform/products/1/suspend \
  -H "Authorization: Bearer SEU_TOKEN_AQUI" \
  -H "Content-Type: application/json" \
  -d '{
    "reason": "Reclamações de clientes sobre o produto"
  }'
```

---

## 5. Testes Completos com Script

### Script de Teste Automático (test-api.sh)

```bash
#!/bin/bash

BASE_URL="http://localhost:3001/api/platform"

echo "=== 1. Login ==="
LOGIN_RESPONSE=$(curl -s -X POST $BASE_URL/login \
  -H "Content-Type: application/json" \
  -d '{"email": "admin@pag2pay.com", "password": "admin123"}')

echo $LOGIN_RESPONSE | jq '.'

TOKEN=$(echo $LOGIN_RESPONSE | jq -r '.token')
echo "Token: $TOKEN"
echo ""

echo "=== 2. Obter Estatísticas ==="
curl -s -X GET $BASE_URL/stats \
  -H "Authorization: Bearer $TOKEN" | jq '.'
echo ""

echo "=== 3. Listar Usuários ==="
curl -s -X GET $BASE_URL/users \
  -H "Authorization: Bearer $TOKEN" | jq '.users[] | {id, name, status}'
echo ""

echo "=== 4. Listar Produtos ==="
curl -s -X GET $BASE_URL/products \
  -H "Authorization: Bearer $TOKEN" | jq '.products[] | {id, name, status}'
echo ""

echo "=== 5. Aprovar Usuário ID 2 ==="
curl -s -X POST $BASE_URL/users/2/approve \
  -H "Authorization: Bearer $TOKEN" | jq '.'
echo ""

echo "=== Testes Concluídos ==="
```

### Para executar:
```bash
chmod +x test-api.sh
./test-api.sh
```

---

## 6. Códigos de Status HTTP

- **200 OK** - Requisição bem-sucedida
- **201 Created** - Recurso criado com sucesso
- **400 Bad Request** - Dados inválidos
- **401 Unauthorized** - Token não fornecido ou inválido
- **403 Forbidden** - Acesso negado (não é admin)
- **404 Not Found** - Recurso não encontrado
- **500 Internal Server Error** - Erro no servidor

---

## 7. Observações

1. Sempre incluir o header `Authorization: Bearer {token}` após o login
2. O token expira em 7 dias
3. Todos os endpoints requerem autenticação, exceto o `/login`
4. Apenas usuários com role `platform-admin` podem acessar estes endpoints
