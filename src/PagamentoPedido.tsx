import { useState } from 'react';
import { CheckCircle, Copy, Loader2, QrCode } from 'lucide-react';
import type { useCheckout, EstadoCheckout } from './useCheckout';

type Checkout = ReturnType<typeof useCheckout>;
const textos: Record<EstadoCheckout, { titulo: string; mensagem: string }> = {
  aguardando_pix: { titulo:'Pedido salvo', mensagem:'Seu pedido foi reservado. Gere ou retome o PIX deste mesmo pedido para continuar.' },
  pendente: { titulo:'Aguardando pagamento', mensagem:'Use o PIX enquanto estiver válido. Você pode retomar este pedido pela sua conta.' },
  confirmando: { titulo:'Confirmação em processamento', mensagem:'A confirmação do pagamento está sendo processada. A situação será atualizada nesta página.' },
  aprovado: { titulo:'Pagamento confirmado', mensagem:'Seu pagamento foi confirmado. Acompanhe a preparação e o envio pela sua conta.' },
  expirado: { titulo:'Prazo do PIX encerrado', mensagem:'O código anterior não está disponível para pagamento. Verifique a situação deste pedido, especialmente se você já pagou.' },
  em_analise: { titulo:'Pedido em análise', mensagem:'A loja precisa conferir este pedido. Entre em contato informando o número abaixo.' },
};
export default function PagamentoPedido({ checkout, voltar, novaCompra }: {
  checkout: Checkout; voltar: () => void; novaCompra: () => void;
}) {
  const [copiado,setCopiado]=useState(false);
  const [erroCopia,setErroCopia]=useState<string|null>(null);
  const p=checkout.pedido;
  if (!p) return <div className="max-w-xl mx-auto bg-white border rounded-2xl p-8 text-center">
    {checkout.ocupado ? <><Loader2 className="animate-spin w-8 h-8 mx-auto mb-3"/><p>Recuperando seu pedido...</p></>
      : <><p>Selecione um pedido na sua conta para acompanhar.</p><button onClick={voltar} className="mt-4 underline">Ir para minha conta</button></>}
  </div>;
  const texto=textos[p.estado];
  const codigo=p.estado==='pendente' ? checkout.pix?.copia_e_cola : null;
  const imagem=p.estado==='pendente' ? checkout.pix?.imagem_base64 : null;
  const dinheiro=(valor:number)=>Number(valor).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
  async function copiar(){
    if (!codigo) return;
    try { await navigator.clipboard.writeText(codigo);setCopiado(true);setErroCopia(null); }
    catch { setErroCopia('Não foi possível copiar automaticamente. Selecione e copie o código abaixo.'); }
  }
  return <section className="max-w-2xl mx-auto bg-white p-6 sm:p-8 rounded-2xl border border-stone-200 shadow-sm">
    <div className="text-center">
      {p.estado==='aprovado' ? <CheckCircle className="w-14 h-14 mx-auto text-emerald-700 mb-4"/>
        : <QrCode className="w-14 h-14 mx-auto text-amber-800 mb-4"/>}
      <p className="text-sm text-stone-500">Pedido #{p.numero_pedido || p.pedido_id}</p>
      <h2 className="text-2xl font-serif font-bold text-stone-900 mt-2">{texto.titulo}</h2>
      <p role="status" className="text-sm text-stone-600 mt-3">{texto.mensagem}</p>
      <p className="text-2xl font-bold text-amber-900 mt-4">{dinheiro(p.total)}</p>
      <p className="text-xs text-amber-800 mt-2">Ambiente de teste: não realize pagamento real.</p>
    </div>
    {p.itens?.length ? <ul className="my-6 border-y border-stone-100 py-3 space-y-2 text-sm text-stone-600">
      {p.itens.map((item,i)=><li key={i} className="flex justify-between gap-3">
        <span>{item.quantidade} × {item.produto} ({item.variacao})</span><span>{dinheiro(item.subtotal)}</span>
      </li>)}
    </ul> : null}
    {imagem && <img src={`data:image/png;base64,${imagem}`} alt="QR Code PIX de teste" className="w-52 h-52 mx-auto my-6 border p-2 rounded-xl"/>}
    {codigo && <div className="my-6">
      <label htmlFor="pix-copia-cola" className="block text-sm font-semibold mb-2">PIX Copia e Cola de teste</label>
      <div className="flex gap-2">
        <input id="pix-copia-cola" readOnly value={codigo} className="min-w-0 flex-1 border border-stone-300 rounded-xl p-3 text-xs font-mono"/>
        <button onClick={copiar} className="rounded-xl px-4 bg-amber-800 text-white flex items-center gap-2"><Copy className="w-4 h-4"/>{copiado?'Copiado':'Copiar'}</button>
      </div>
      {erroCopia && <p role="alert" className="mt-2 text-sm text-red-700">{erroCopia}</p>}
    </div>}
    {p.estado==='pendente' && p.pix_expira_em && <p className="text-xs text-center text-stone-500 my-4">
      Válido até {new Date(p.pix_expira_em).toLocaleString('pt-BR')}
    </p>}
    <div className="flex flex-wrap justify-center gap-3 mt-6">
      {!['aprovado','em_analise','confirmando'].includes(p.estado) && <button disabled={checkout.ocupado}
        onClick={()=>void checkout.gerarOuRetomarPix()} className="rounded-xl px-5 py-3 bg-emerald-700 text-white font-semibold disabled:opacity-50">
        {checkout.ocupado?'Consultando...':p.estado==='aguardando_pix'?'Gerar PIX de teste':p.estado==='expirado'?'Verificar situação':'Retomar PIX'}
      </button>}
      <button disabled={checkout.ocupado} onClick={()=>void checkout.atualizar()}
        className="rounded-xl px-5 py-3 border border-stone-300 text-stone-700 disabled:opacity-50">Atualizar situação</button>
      <button onClick={voltar} className="rounded-xl px-5 py-3 border border-stone-300 text-stone-700">Minha conta</button>
    </div>
    <div className="border-t border-stone-100 mt-6 pt-5 text-center">
      <button disabled={checkout.ocupado} onClick={novaCompra} className="underline text-sm text-amber-900 disabled:opacity-50">Iniciar outra compra</button>
      <p className="text-xs text-stone-500 mt-2">Uma nova compra cria outro pedido. Este continuará disponível na sua conta.</p>
    </div>
  </section>;
}
