import type { SupabaseClient } from '@supabase/supabase-js';
import type { ProdutoCatalogo, VariacaoProduto } from './App';

// Visitantes só podem consultar estas três colunas de Estoque.
// Não ampliar as permissões do banco para acomodar um select('*').
export async function buscarCatalogo(client: SupabaseClient) {
  const [produtos, variacoes, estoque] = await Promise.all([
    client.from('Produto').select('*').order('id_prd'),
    client.from('Produto_Variacao').select('*').order('id_var'),
    client.from('Estoque').select('id_prd_fk,id_var_fk,disponivel_est'),
  ]);

  const erro = produtos.error || variacoes.error || estoque.error;
  if (erro) throw erro;

  const disponibilidade = new Map<string, number>();
  for (const item of estoque.data ?? []) {
    disponibilidade.set(`${item.id_prd_fk}:${item.id_var_fk}`,
      Math.max(0, Number(item.disponivel_est) || 0));
  }

  const selecaoInicial: Record<number, number> = {};
  const catalogo: ProdutoCatalogo[] = (produtos.data ?? []).map((p: any) => {
    const opcoes: VariacaoProduto[] = (variacoes.data ?? [])
      .filter((v: any) => v.id_prd_fk === p.id_prd)
      .map((v: any) => ({
        id_var: Number(v.id_var),
        id_prd_fk: Number(v.id_prd_fk),
        nome_var: v.nome_var,
        preco_var: Number(v.preco_var),
        peso_var: Number(v.peso_var ?? 0),
        validade_dias_var: Number(v.validade_dias_var ?? 0),
        prazo_producao_dias_uteis_var: Number(v.prazo_producao_dias_uteis_var ?? 0),
        tem_lactose_var: Boolean(v.tem_lactose_var),
        tem_gluten_var: Boolean(v.tem_gluten_var),
        disponivel_est: disponibilidade.get(`${p.id_prd}:${v.id_var}`) ?? 0,
      }));

    if (opcoes.length) {
      selecaoInicial[p.id_prd] = (opcoes.find(v => v.disponivel_est > 0) ?? opcoes[0]).id_var;
    }
    return {
      id_prd: Number(p.id_prd),
      nome_prd: p.nome_prd,
      descricao_prd: p.descricao_prd,
      imagem_prd: p.imagem_prd || 'https://images.unsplash.com/photo-1499636136210-6f4ee915583e?auto=format&fit=crop&w=800&q=80',
      variacoes: opcoes,
    };
  }).filter(p => p.variacoes.length > 0);

  return { produtos: catalogo, selecaoInicial };
}
