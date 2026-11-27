# Configuração do Supabase — Fuot IA

O código da interface já tem suporte para cadastro por e-mail, login por e-mail, Google OAuth e histórico sincronizado. Esta configuração externa ainda precisa ser feita no painel do Supabase e no Google Cloud; não é possível ativar OAuth sem as credenciais criadas na sua própria conta.

## 1. Criar o banco de dados do histórico

1. Abra o painel do seu projeto Supabase.
2. Entre em **SQL Editor**.
3. Abra o arquivo [supabase/schema.sql](./supabase/schema.sql) neste repositório.
4. Copie o conteúdo inteiro, cole no SQL Editor e execute.
5. Confirme que a tabela `public.conversations` foi criada.

A tabela usa Row Level Security (RLS): cada usuário autenticado só consegue acessar as próprias conversas. Visitantes não gravam conversas.

## 2. Configurar e-mail e senha

No Supabase, entre em **Authentication → Providers → Email** e habilite o provedor Email. Para maior segurança, mantenha a confirmação de e-mail habilitada.

## 3. Configurar Google OAuth

1. No Google Cloud Console, crie ou selecione um projeto.
2. Configure a tela de consentimento OAuth.
3. Crie uma credencial OAuth do tipo **Web application**.
4. Em **Authorized redirect URIs**, adicione exatamente o callback que aparece em **Supabase → Authentication → Providers → Google**. Normalmente tem o formato `https://SEU-PROJECT-REF.supabase.co/auth/v1/callback`.
5. Copie o Client ID e o Client Secret do Google para os campos correspondentes do provedor Google no Supabase e habilite o provedor.
6. No Supabase, entre em **Authentication → URL Configuration**:
   - Site URL: `https://enzoneymar68-ux.github.io/fuot-ia/`
   - Redirect URLs: adicione `https://enzoneymar68-ux.github.io/fuot-ia/`

Nunca publique o Google Client Secret.

## 4. Colocar as chaves públicas no site

No começo do arquivo `index.html`, localize:

```js
const SUPABASE_URL="COLE_AQUI_A_URL_DO_SEU_PROJETO";
const SUPABASE_ANON_KEY="COLE_AQUI_A_CHAVE_PUBLICA_ANON";
```

Substitua pelos valores de **Project URL** e pela chave pública **anon** (ou publishable key) exibidos em **Supabase → Project Settings → API**.

A chave pública pode ficar no frontend somente porque as tabelas precisam estar protegidas por RLS. **Nunca coloque service_role, secret key, Google Client Secret ou chave privada no HTML/GitHub.**

## 5. Segurança da API da IA — etapa separada

O login do Supabase e as regras RLS protegem o banco de conversas. O Worker da Cloudflare ainda precisa validar o token de acesso Supabase em cada chamada protegida da IA. Essa alteração não pode ser concluída com segurança sem revisar o código atual do Worker. Não considere a API protegida apenas porque o usuário entrou no site.

## 6. Visitantes e confirmação “Sou humano”

- Visitantes podem usar as funções, mas o histórico não é enviado ao Supabase nem gravado no histórico local da conta.
- A confirmação visual “Sou humano” fica lembrada neste aparelho depois do primeiro clique. Ela é apenas uma confirmação de interface, não um sistema real de prevenção contra robôs.
