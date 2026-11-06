import { MapPin, Mail, Phone, MessageCircle, ArrowRight } from 'lucide-react';
import { contatoLoja } from './contatoLoja';

export function SobreNos({ verCatalogo }: { verCatalogo: () => void }) {
  return <section className="mx-auto max-w-4xl space-y-6">
    <div className="rounded-3xl border border-amber-200 bg-amber-50 p-6 sm:p-10">
      <p className="text-xs font-semibold uppercase tracking-widest text-amber-800">Confeitaria Márcia Ribeiro</p>
      <h1 className="mt-3 font-serif text-3xl font-bold sm:text-4xl">Sobre nós</h1>
      <p className="mt-5 text-lg leading-relaxed text-stone-700">Somos uma confeitaria artesanal em Praia Grande, São Paulo. Nosso catálogo reúne doces para você escolher seus sabores e fazer seu pedido online.</p>
    </div>
    <div className="grid gap-5 sm:grid-cols-2">
      <article className="rounded-2xl border border-stone-200 bg-white p-6">
        <h2 className="font-serif text-xl font-bold">Escolha do seu jeito</h2>
        <p className="mt-3 leading-relaxed text-stone-600">Confira as opções de cada produto, os preços e a disponibilidade. Você pode combinar sabores, respeitando o limite de 10 potes por pedido.</p>
      </article>
      <article className="rounded-2xl border border-stone-200 bg-white p-6">
        <h2 className="font-serif text-xl font-bold">Do pedido à entrega</h2>
        <p className="mt-3 leading-relaxed text-stone-600">Consulte o frete para seu CEP no carrinho e confira o prazo de produção informado em cada produto. Depois da compra, acompanhe seu pedido na página Perfil.</p>
      </article>
    </div>
    <button type="button" onClick={verCatalogo} className="inline-flex items-center gap-2 rounded-xl bg-amber-800 px-5 py-3 font-semibold text-white hover:bg-amber-900">
      Conhecer o catálogo <ArrowRight className="h-4 w-4" />
    </button>
  </section>;
}

export function Contato({ verPerfil }: { verPerfil: () => void }) {
  const whatsapp = contatoLoja.whatsapp.replace(/\D/g, '');
  const temCanais = Boolean(whatsapp || contatoLoja.email || contatoLoja.telefone);
  const card = 'flex items-start gap-3 rounded-2xl border border-stone-200 bg-white p-5';
  return <section className="mx-auto max-w-4xl space-y-6">
    <div>
      <p className="text-xs font-semibold uppercase tracking-widest text-amber-800">Confeitaria Márcia Ribeiro</p>
      <h1 className="mt-3 font-serif text-3xl font-bold sm:text-4xl">Contato</h1>
      <p className="mt-4 text-stone-600">Dúvidas sobre produtos ou pedidos? Confira nossos canais de atendimento.</p>
    </div>
    <div className="grid gap-4 sm:grid-cols-2">
      <div className={card}><MapPin className="mt-1 h-5 w-5 shrink-0 text-amber-800" /><div><h2 className="font-semibold">Nossa localização</h2><p className="mt-1 text-stone-600">Praia Grande, São Paulo</p></div></div>
      {whatsapp && <a href={'https://wa.me/' + whatsapp} target="_blank" rel="noopener noreferrer" className={card + ' hover:border-emerald-600'}>
        <MessageCircle className="mt-1 h-5 w-5 shrink-0 text-emerald-700" /><div><h2 className="font-semibold">WhatsApp</h2><p className="mt-1 text-stone-600">Conversar com a confeitaria</p></div>
      </a>}
      {contatoLoja.email && <a href={'mailto:' + contatoLoja.email} className={card + ' hover:border-amber-700'}>
        <Mail className="mt-1 h-5 w-5 shrink-0 text-amber-800" /><div className="min-w-0"><h2 className="font-semibold">E-mail</h2><p className="mt-1 break-all text-stone-600">{contatoLoja.email}</p></div>
      </a>}
      {contatoLoja.telefone && <a href={'tel:' + contatoLoja.telefone.replace(/[^+\d]/g, '')} className={card + ' hover:border-amber-700'}>
        <Phone className="mt-1 h-5 w-5 shrink-0 text-amber-800" /><div><h2 className="font-semibold">Telefone</h2><p className="mt-1 text-stone-600">{contatoLoja.telefone}</p></div>
      </a>}
    </div>
    {!temCanais && <p className="rounded-xl bg-amber-50 p-4 text-sm text-stone-700">Os canais de contato estão sendo atualizados. Para consultar um pedido já realizado, acesse seu perfil.</p>}

    <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6">
      <h2 className="font-serif text-xl font-bold">Já fez um pedido?</h2>
      <p className="mt-2 text-stone-600">Entre na sua conta para consultar o pagamento e acompanhar a preparação e o envio.</p>
      <button type="button" onClick={verPerfil} className="mt-4 inline-flex items-center gap-2 rounded-xl bg-amber-800 px-4 py-3 font-semibold text-white hover:bg-amber-900">Acessar meu perfil <ArrowRight className="h-4 w-4" /></button>
    </div>
  </section>;
}
