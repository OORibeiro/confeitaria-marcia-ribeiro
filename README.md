# Loja Virtual - Confeitaria Márcia Ribeiro

Projeto completo em **React + Vite + TypeScript + Tailwind CSS** configurado para conectar ao banco de dados e às Edge Functions do Supabase (`wjyoharjddlnwhhmfawu`).

## Como abrir e rodar no seu VS Code

1. Extraia este arquivo `.zip` em uma pasta no seu computador.
2. Abra a pasta `confeitaria-marcia-ribeiro` dentro do **VS Code**.
3. Crie um arquivo chamado `.env.local` na raiz do projeto (copiando o `.env.example`) e cole a sua chave pública `ANON_KEY` do Supabase:
   ```env
   VITE_SUPABASE_URL=https://wjyoharjddlnwhhmfawu.supabase.co
   VITE_SUPABASE_ANON_KEY=sua_chave_anon_publica_aqui
   ```
4. Abra o terminal do VS Code (`Ctrl + '` ou `Terminal > New Terminal`) e execute:
   ```bash
   npm install
   npm run dev
   ```
5. O site abrirá em `http://localhost:5173`.

