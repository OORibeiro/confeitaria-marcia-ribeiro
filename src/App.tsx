import React, { useEffect, useRef, useState } from 'react';
import {
  ShoppingBag,
  Truck,
  QrCode,
  Plus,
  Minus,
  AlertCircle,
  Loader2,
  User,
  LogOut,
  Package,
  Sparkles,
  Copy,
  Check,
  ShieldCheck,
  MapPin,
  Lock,
  Mail,
  FileText,
  Phone,
  ClipboardList,
  Settings
} from 'lucide-react';
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase';
import AdminPanel from './AdminPanel';
import { buscarCatalogo } from './catalogo';
import { useCheckout } from './useCheckout';
import PagamentoPedido from './PagamentoPedido';

export interface VariacaoProduto {
  id_var: number;
  id_prd_fk: number;
  nome_var: string;
  preco_var: number;
  peso_var: number;
  validade_dias_var: number;
  prazo_producao_dias_uteis_var: number;
  tem_lactose_var: boolean;
  tem_gluten_var: boolean;
  disponivel_est: number;
}

export interface ProdutoCatalogo {
  id_prd: number;
  nome_prd: string;
  descricao_prd: string | null;
  imagem_prd: string | null;
  variacoes: VariacaoProduto[];
}

export interface ItemCarrinho {
  produto_id: number;
  variacao_id: number;
  nome_produto: string;
  nome_variacao: string;
  preco_unitario: number;
  quantidade: number;
  imagem: string;
  estoque_maximo: number;
}

export interface CotacaoFrete {
  id: number;
  name: string;
  price: number;
  delivery_time: number;
  company: {
    name: string;
    picture?: string;
  };
}

export default function App() {
  const [abaAtiva, setAbaAtiva] = useState<'catalogo' | 'carrinho' | 'checkout' | 'acompanhamento' | 'conta' | 'admin'>('catalogo');
  const [produtos, setProdutos] = useState<ProdutoCatalogo[]>([]);
  const [variacaoEscolhidaPorProduto, setVariacaoEscolhidaPorProduto] = useState<Record<number, number>>({});
  const [usandoBancoReal, setUsandoBancoReal] = useState(false);
  const [carregandoProdutos, setCarregandoProdutos] = useState(true);
  const [erroProdutos, setErroProdutos] = useState<string | null>(null);
  const cargaCatalogoRef = useRef(0);

  // Carrinho
  const [carrinho, setCarrinho] = useState<ItemCarrinho[]>([]);
  const [avisoCarrinho, setAvisoCarrinho] = useState<string | null>(null);

  // Cotação de Frete (Melhor Envio)
  const [cepDestino, setCepDestino] = useState('');
  const [cotandoFrete, setCotandoFrete] = useState(false);
  const [erroFrete, setErroFrete] = useState<string | null>(null);
  const [cotacoes, setCotacoes] = useState<CotacaoFrete[]>([]);
  const [cotacaoSelecionada, setCotacaoSelecionada] = useState<CotacaoFrete | null>(null);
  const [cotacaoConfirmada, setCotacaoConfirmada] = useState<{
    id: string; expiraEm: string; cep: string; itens: string; usuarioId: string;
  } | null>(null);
  const requisicaoFreteRef = useRef(0);
  const abortarFreteRef = useRef<AbortController | null>(null);
  const [volumeCalculado, setVolumeCalculado] = useState<{ width: number; height: number; length: number; weight: number; insurance: number } | null>(null);

  // Autenticação e Perfil do Cliente
  const [usuarioLogado, setUsuarioLogado] = useState<any>(null);
  const [perfilCliente, setPerfilCliente] = useState<any>(null);
  const [ehAdmin, setEhAdmin] = useState(false);
  useEffect(() => {
    if (ehAdmin && /^#me_(state|code|erro)=/.test(window.location.hash)) setAbaAtiva('admin');
  }, [ehAdmin]);
  const [meusPedidos, setMeusPedidos] = useState<any[]>([]);
  const [inicializandoAuth, setInicializandoAuth] = useState(true);
  const [carregandoPerfil, setCarregandoPerfil] = useState(false);
  const [erroPerfil, setErroPerfil] = useState<string | null>(null);
  const [revisaoPerfil, setRevisaoPerfil] = useState(0);
  const usuarioAtualRef = useRef<string | null>(null);
  const [emailLogin, setEmailLogin] = useState('');
  const [senhaLogin, setSenhaLogin] = useState('');
  const [modoCadastro, setModoCadastro] = useState(false);
  const [nomeCadastro, setNomeCadastro] = useState('');
  const [cpfCadastro, setCpfCadastro] = useState('');
  const [telefoneCadastro, setTelefoneCadastro] = useState('');
  const [nascimentoCadastro, setNascimentoCadastro] = useState('');
  const [erroAuth, setErroAuth] = useState<string | null>(null);
  const [sucessoAuth, setSucessoAuth] = useState<string | null>(null);
  const [carregandoAuth, setCarregandoAuth] = useState(false);

  // Endereço de entrega
  const [logradouro, setLogradouro] = useState('');
  const [numero, setNumero] = useState('');
  const [complemento, setComplemento] = useState('');
  const [bairro, setBairro] = useState('');
  const [cidade, setCidade] = useState('Praia Grande');
  const [estado, setEstado] = useState('SP');

  // Encomenda e PIX
  const [erroCheckout, setErroCheckout] = useState<string | null>(null);

  const totalPotes = carrinho.reduce((acc, item) => acc + item.quantidade, 0);
  const subtotalItens = carrinho.reduce((acc, item) => acc + item.preco_unitario * item.quantidade, 0);
  const chaveItensFrete = JSON.stringify(carrinho.map(item => ({
    produto_id: item.produto_id, variacao_id: item.variacao_id, quantidade: item.quantidade,
  })).sort((a, b) => a.produto_id - b.produto_id || a.variacao_id - b.variacao_id));
  const cepNormalizado = cepDestino.replace(/\D/g, '');
  const cotacaoValida = Boolean(cotacaoConfirmada && cotacaoSelecionada
    && cotacaoConfirmada.usuarioId === usuarioLogado?.id
    && cotacaoConfirmada.cep === cepNormalizado && cotacaoConfirmada.itens === chaveItensFrete
    && Date.parse(cotacaoConfirmada.expiraEm) > Date.now());
  const subtotalCotado = cotacaoValida && volumeCalculado ? volumeCalculado.insurance : subtotalItens;
  const valorFrete = cotacaoSelecionada ? Number(cotacaoSelecionada.price) : 0;
  const totalPedido = subtotalCotado + valorFrete;
  const checkout = useCheckout(supabase, usuarioLogado?.id, usuarioAtualRef, abaAtiva==='acompanhamento');
  const processandoPedido = checkout.ocupado;

  useEffect(() => {
    const p=checkout.pedido;
    if (!p) return;
    setMeusPedidos(anteriores => {
      const linha={ id_pdd:p.pedido_id,numero_pdd:p.numero_pedido,status_pdd:p.status_pedido,
        valor_pdd:p.total,rastreio_pdd:p.codigo_rastreio,data_pdd:p.datas?.pedido_criado_em || new Date().toISOString() };
      return [linha,...anteriores.filter(a=>a.id_pdd!==p.pedido_id)];
    });
  },[checkout.pedido?.pedido_id,checkout.pedido?.status_pedido,checkout.pedido?.total]);
  useEffect(() => {
    if (checkout.pedido) setAbaAtiva('acompanhamento');
  },[checkout.pedido?.pedido_id]);


  useEffect(() => {
    if (!supabase) {
      setInicializandoAuth(false);
      return;
    }
    // O callback permanece síncrono. Consultas ao Supabase acontecem no efeito
    // abaixo, depois que o evento de autenticação liberou seu bloqueio interno.
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      const user = session?.user ?? null;
      const proximoId = user?.id ?? null;
      if (usuarioAtualRef.current !== proximoId) {
        usuarioAtualRef.current = proximoId;
        // O carrinho pertence à sessão atual; não acompanha outra identidade.
        // Eventos de renovação da mesma conta preservam os itens.
        setCarrinho([]);
        setAvisoCarrinho(null);
        setPerfilCliente(null);
        setEhAdmin(false);
        setMeusPedidos([]);
        setErroPerfil(null);
        invalidarFrete();
        setCepDestino('');
        setLogradouro('');
        setNumero('');
        setComplemento('');
        setBairro('');
        setCidade('Praia Grande');
        setEstado('SP');
        setAbaAtiva(atual => atual === 'admin' || atual === 'acompanhamento' ? 'conta' : atual);
      }
      setUsuarioLogado(user);
      setInicializandoAuth(false);
    });
    return () => {
      usuarioAtualRef.current = null;
      listener.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    const authUserId = usuarioLogado?.id;
    if (!supabase || !authUserId) {
      setCarregandoPerfil(false);
      return;
    }
    let cancelado = false;
    const atual = () => !cancelado && usuarioAtualRef.current === authUserId;
    const client = supabase;
    setCarregandoPerfil(true);
    setErroPerfil(null);

    async function carregarConta() {
      try {
        const [admin, cadastro] = await Promise.all([
          client.rpc('verificar_sou_admin'),
          client.rpc('garantir_meu_cadastro_cliente'),
        ]);
        if (!atual()) return;
        setEhAdmin(!admin.error && admin.data === true);
        if (cadastro.error) throw cadastro.error;
        const clt = cadastro.data;
        if (!clt?.id_clt || clt.auth_user_id !== authUserId) {
          throw new Error('Não foi possível confirmar seu cadastro. Tente novamente.');
        }
        setPerfilCliente(clt);

        const [endereco, pedidos] = await Promise.all([
          client.from('Endereco').select('*').eq('id_clt_fk', clt.id_clt)
            .order('principal_end', { ascending: false }).limit(1).maybeSingle(),
          client.from('Pedido').select('*').eq('id_clt_fk', clt.id_clt)
            .order('data_pdd', { ascending: false }),
        ]);
        if (!atual()) return;
        if (endereco.error || pedidos.error || admin.error) {
          throw endereco.error || pedidos.error || admin.error;
        }
        const end = endereco.data;
        if (end) {
          setLogradouro(end.logradouro_end || '');
          setNumero(end.numero_end || '');
          setComplemento(end.complemento_end || '');
          setBairro(end.bairro_end || '');
          setCidade(end.cidade_end || 'Praia Grande');
          setEstado(end.estado_end || 'SP');
          setCepDestino(end.cep_end || '');
          invalidarFrete();
        }
        setMeusPedidos(pedidos.data ?? []);
      } catch (error: any) {
        if (!atual()) return;
        console.warn('Falha ao carregar a conta:', error?.code ?? 'erro');
        const mensagem = ['23505', '22023'].includes(error?.code)
          ? error.message
          : 'Não foi possível carregar seu cadastro. Tente novamente ou entre em contato com a loja.';
        setErroPerfil(mensagem);
      } finally {
        if (atual()) setCarregandoPerfil(false);
      }
    }
    void carregarConta();
    return () => { cancelado = true; };
  }, [usuarioLogado?.id, revisaoPerfil]);

  useEffect(() => {
    void carregarCatalogoDoSupabase();
    return () => { cargaCatalogoRef.current += 1; };
  }, []);

  async function carregarCatalogoDoSupabase() {
    const versao = ++cargaCatalogoRef.current;
    setCarregandoProdutos(true);
    setErroProdutos(null);
    setUsandoBancoReal(false);
    setProdutos([]);
    setVariacaoEscolhidaPorProduto({});
    try {
      if (!supabase) throw new Error('Loja indisponível no momento.');
      const resultado = await buscarCatalogo(supabase);
      if (versao !== cargaCatalogoRef.current) return;
      setProdutos(resultado.produtos);
      setVariacaoEscolhidaPorProduto(resultado.selecaoInicial);
      setUsandoBancoReal(true);
    } catch (error: any) {
      if (versao !== cargaCatalogoRef.current) return;
      console.warn('Falha ao carregar catálogo:', error?.code ?? 'configuracao_ou_rede');
      setErroProdutos('Não foi possível carregar os produtos. Tente novamente em instantes.');
    } finally {
      if (versao === cargaCatalogoRef.current) setCarregandoProdutos(false);
    }
  }

  function adicionarAoCarrinho(produto: ProdutoCatalogo, variacao: VariacaoProduto) {
    setAvisoCarrinho(null);
    if (totalPotes >= 10) {
      setAvisoCarrinho('O limite máximo por encomenda é de 10 potes para garantir a segurança no transporte.');
      return;
    }

    if (variacao.disponivel_est <= 0) {
      setAvisoCarrinho(`A variação "${variacao.nome_var}" está sem stock disponível.`);
      return;
    }

    setCarrinho(atual => {
      const existente = atual.find(i => i.produto_id === produto.id_prd && i.variacao_id === variacao.id_var);
      if (existente) {
        if (existente.quantidade >= variacao.disponivel_est) {
          setAvisoCarrinho(`Temos apenas ${variacao.disponivel_est} unidade(s) em stock de ${produto.nome_prd} (${variacao.nome_var}).`);
          return atual;
        }
        return atual.map(i =>
          i.produto_id === produto.id_prd && i.variacao_id === variacao.id_var
            ? { ...i, quantidade: i.quantidade + 1 }
            : i
        );
      }
      return [
        ...atual,
        {
          produto_id: produto.id_prd,
          variacao_id: variacao.id_var,
          nome_produto: produto.nome_prd,
          nome_variacao: variacao.nome_var,
          preco_unitario: variacao.preco_var,
          quantidade: 1,
          imagem: produto.imagem_prd || '',
          estoque_maximo: variacao.disponivel_est
        }
      ];
    });

    invalidarFrete();
  }

  function alterarQuantidade(produto_id: number, variacao_id: number, delta: number) {
    setAvisoCarrinho(null);
    if (delta > 0 && totalPotes >= 10) {
      setAvisoCarrinho('O limite máximo por encomenda é de 10 potes.');
      return;
    }

    setCarrinho(atual =>
      atual
        .map(item => {
          if (item.produto_id === produto_id && item.variacao_id === variacao_id) {
            const novaQtd = item.quantidade + delta;
            if (novaQtd > item.estoque_maximo) {
              setAvisoCarrinho(`Stock máximo disponível: ${item.estoque_maximo} unidade(s).`);
              return item;
            }
            return { ...item, quantidade: novaQtd };
          }
          return item;
        })
        .filter(item => item.quantidade > 0)
    );

    invalidarFrete();
  }

  function invalidarFrete() {
    requisicaoFreteRef.current += 1;
    abortarFreteRef.current?.abort();
    abortarFreteRef.current = null;
    setCotandoFrete(false);
    setCotacoes([]);
    setCotacaoSelecionada(null);
    setCotacaoConfirmada(null);
    setVolumeCalculado(null);
    setErroFrete(null);
  }

  useEffect(() => {
    invalidarFrete();
  }, [chaveItensFrete, cepNormalizado, usuarioLogado?.id]);

  useEffect(() => {
    if (!cotacaoConfirmada) return;
    const restante = Date.parse(cotacaoConfirmada.expiraEm) - Date.now();
    const timer = window.setTimeout(() => {
      invalidarFrete();
      setErroFrete('Sua cotação expirou. Calcule o frete novamente.');
    }, Math.max(0, restante));
    return () => window.clearTimeout(timer);
  }, [cotacaoConfirmada]);

  useEffect(() => () => { abortarFreteRef.current?.abort(); }, []);

  async function consultarFreteMelhorEnvio() {
    invalidarFrete();
    if (!supabase || !usuarioLogado || !perfilCliente || carregandoPerfil || erroPerfil) {
      setErroFrete('Entre na sua conta e conclua seu cadastro para calcular o frete.');
      return;
    }
    if (cepNormalizado.length !== 8) {
      setErroFrete('Informe um CEP válido com 8 números.');
      return;
    }
    if (totalPotes < 1 || totalPotes > 10) {
      setErroFrete('Adicione entre 1 e 10 potes ao carrinho.');
      return;
    }
    const versao = ++requisicaoFreteRef.current;
    const usuarioId = usuarioLogado.id;
    const itens = chaveItensFrete;
    const cep = cepNormalizado;
    const atual = () => versao === requisicaoFreteRef.current && usuarioAtualRef.current === usuarioId;
    const controller = new AbortController();
    abortarFreteRef.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 65000);
    setCotandoFrete(true);
    try {
      const { data, error } = await supabase.auth.getSession();
      if (!atual()) return;
      if (error || !data.session?.access_token || data.session.user.id !== usuarioId) {
        throw new Error('Sua sessão expirou. Entre novamente.');
      }
      const resp = await fetch(`${SUPABASE_URL}/functions/v1/melhor-envio-cotacao`, {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${data.session.access_token}` },
        body: JSON.stringify({ cepDestino: cep, itens: JSON.parse(itens) }),
      });
      const dados = await resp.json().catch(() => null);
      if (!atual()) return;
      if (!resp.ok || !dados?.sucesso) throw new Error(dados?.error || 'Não foi possível calcular o frete.');
      if (typeof dados.cotacao_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(dados.cotacao_id)
        || !Number.isFinite(Date.parse(dados.expira_em)) || Date.parse(dados.expira_em) <= Date.now()
        || !Array.isArray(dados.cotacoes) || !dados.cotacoes.length) {
        throw new Error('A cotação não está válida. Calcule novamente.');
      }
      const opcoes: CotacaoFrete[] = dados.cotacoes.map((c: any) => ({
        id: Number(c.id), name: String(c.name), price: Number(c.price),
        delivery_time: Number(c.delivery_time), company: { name: String(c.company?.name || '') },
      }));
      if (opcoes.some(c => !Number.isSafeInteger(c.id) || c.id <= 0 || !Number.isFinite(c.price) || c.price <= 0
        || !Number.isInteger(c.delivery_time) || c.delivery_time < 0 || !c.company.name)) {
        throw new Error('A cotação retornou dados inválidos. Calcule novamente.');
      }
      const volume = dados.volumeCotado;
      if (!volume || ['width','height','length','weight'].some(c => !Number.isFinite(Number(volume[c])) || Number(volume[c]) <= 0)
        || !Number.isFinite(Number(volume.insurance)) || Number(volume.insurance) < 0) {
        throw new Error('Não foi possível confirmar a embalagem. Calcule novamente.');
      }
      setVolumeCalculado({ width: Number(volume.width), height: Number(volume.height), length: Number(volume.length),
        weight: Number(volume.weight), insurance: Number(volume.insurance) });
      setCotacaoConfirmada({ id: dados.cotacao_id, expiraEm: dados.expira_em, cep, itens, usuarioId });
      setCotacoes(opcoes);
      setCotacaoSelecionada(opcoes[0]);
    } catch (error: any) {
      if (!atual()) return;
      setErroFrete(controller.signal.aborted
        ? 'A cotação demorou demais. Tente novamente.'
        : error.message || 'Não foi possível calcular o frete. Tente novamente.');
    } finally {
      window.clearTimeout(timer);
      if (atual()) { setCotandoFrete(false); abortarFreteRef.current = null; }
    }
  }

  async function autenticarCliente(e: React.FormEvent) {
    e.preventDefault();
    setErroAuth(null);
    setSucessoAuth(null);

    if (!supabase) {
      setErroAuth('O acesso à loja está indisponível no momento. Tente novamente mais tarde.');
      return;
    }

    setCarregandoAuth(true);
    try {
      const email = emailLogin.trim();
      if (modoCadastro) {
        const nome = nomeCadastro.trim();
        const cpf = cpfCadastro.replace(/\D/g, '');
        const telefone = telefoneCadastro.trim();
        if (!nome || nome.length > 255) throw new Error('Informe seu nome completo, com até 255 caracteres.');
        if (cpfCadastro.trim() && !/^\d{11}$/.test(cpf)) {
          throw new Error('Informe um CPF com 11 números ou deixe o campo vazio.');
        }
        if (telefone.length > 20) throw new Error('O telefone deve ter no máximo 20 caracteres.');
        const { data, error } = await supabase.auth.signUp({
          email,
          password: senhaLogin,
          options: { data: {
            nome_clt: nome,
            cpf_clt: cpf || null,
            telefone_clt: telefone || null,
            nascimento_clt: nascimentoCadastro || null,
          } },
        });
        if (error) throw error;
        setSenhaLogin('');
        setModoCadastro(false);
        if (!data.session) {
          setSucessoAuth('Confira seu e-mail para confirmar o cadastro. Depois, entre com sua senha. Se já possui uma conta, use a opção de entrar.');
        } else {
          setSucessoAuth(null);
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password: senhaLogin });
        if (error) throw error;
        setSenhaLogin('');
        setSucessoAuth(null);
      }
    } catch (err: any) {
      setErroAuth(err.message || 'Não foi possível autenticar.');
    } finally {
      setCarregandoAuth(false);
    }
  }

  async function finalizarPedidoEGerarPix(e: React.FormEvent) {
    e.preventDefault(); setErroCheckout(null);
    if (!supabase || !usuarioLogado || !perfilCliente || carregandoPerfil || erroPerfil) {
      setErroCheckout('Entre na sua conta e aguarde a conclusão do cadastro.'); return;
    }
    if (checkout.temTentativa && (!cotacaoValida || !logradouro || !numero || !bairro || !cidade || !estado)) {
      const p=await checkout.recuperar();
      if (p) { setCarrinho([]); setAbaAtiva('acompanhamento'); }
      return;
    }
    if (!cotacaoValida || !cotacaoConfirmada || !cotacaoSelecionada) {
      setErroCheckout('Volte ao carrinho e calcule uma cotação válida antes de continuar.'); return;
    }
    if (!logradouro || !numero || !bairro || !cidade || !estado) {
      setErroCheckout('Preencha todos os campos obrigatórios do endereço.'); return;
    }
    const p=await checkout.iniciar({
      p_endereco:{logradouro,numero,complemento:complemento||null,bairro,cidade,estado,cep:cepNormalizado},
      p_itens:JSON.parse(chaveItensFrete),p_cotacao_id:cotacaoConfirmada.id,p_servico_id:cotacaoSelecionada.id,
    });
    if (p) { setCarrinho([]); setAbaAtiva('acompanhamento'); }
  }

  return (
    <div className="min-h-screen flex flex-col bg-amber-50/30 text-stone-800">
      {/* Barra de Status */}
      <div className="bg-stone-900 text-amber-100 text-xs py-2 px-4">
        <div className="max-w-6xl mx-auto flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <MapPin className="w-3.5 h-3.5 text-amber-400" />
            <span>Envios de <strong>Praia Grande - SP</strong> via Melhor Envio (Até 10 potes por pedido)</span>
          </div>
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${usandoBancoReal ? 'bg-emerald-400' : 'bg-amber-400'}`} />
            <span>
              {usandoBancoReal
                ? 'Catálogo atualizado'
                : carregandoProdutos ? 'Carregando produtos...' : 'Catálogo indisponível'}
            </span>
          </div>
        </div>
      </div>

      {/* Cabeçalho Principal */}
      <header className="bg-white/90 backdrop-blur-md sticky top-0 z-30 border-b border-amber-100 shadow-sm">
        <div className="max-w-6xl mx-auto px-4 h-20 flex items-center justify-between">
          <button
            onClick={() => setAbaAtiva('catalogo')}
            className="text-left group focus:outline-none"
          >
            <span className="block text-xs uppercase tracking-widest text-amber-700 font-semibold">
              Alta Confeitaria Artesanal
            </span>
            <span className="text-2xl sm:text-3xl font-serif font-bold text-stone-900 group-hover:text-amber-800 transition-colors">
              Márcia Ribeiro
            </span>
          </button>

          <nav className="flex items-center gap-2 sm:gap-3">
            <button
              onClick={() => setAbaAtiva('catalogo')}
              className={`px-3 py-2 rounded-xl text-sm font-medium transition-colors ${
                abaAtiva === 'catalogo'
                  ? 'bg-amber-100 text-amber-900'
                  : 'text-stone-600 hover:text-stone-900'
              }`}
            >
              Catálogo
            </button>

            {/* Botão Painel Admin (se tiver permissão) */}
            {ehAdmin && (
              <button
                onClick={() => setAbaAtiva('admin')}
                className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-medium border transition-colors ${
                  abaAtiva === 'admin'
                    ? 'bg-amber-800 text-white border-amber-800'
                    : 'bg-amber-50 text-amber-900 border-amber-200 hover:bg-amber-100'
                }`}
              >
                <Settings className="w-4 h-4" />
                <span className="hidden sm:inline">Painel Admin</span>
              </button>
            )}

            <button
              onClick={() => setAbaAtiva('conta')}
              className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-sm font-medium border transition-colors ${
                abaAtiva === 'conta'
                  ? 'bg-stone-900 text-white border-stone-900'
                  : 'bg-white text-stone-700 border-stone-200 hover:border-amber-700'
              }`}
            >
              <User className="w-4 h-4" />
              <span className="hidden sm:inline">
                {usuarioLogado
                  ? (perfilCliente?.nome_clt?.split(' ')[0] || usuarioLogado.email?.split('@')[0])
                  : 'Entrar / Registar'}
              </span>
            </button>

            <button
              onClick={() => setAbaAtiva('carrinho')}
              className="relative flex items-center gap-2 bg-amber-800 hover:bg-amber-900 text-white px-4 py-2.5 rounded-xl text-sm font-medium transition-all shadow-sm"
            >
              <ShoppingBag className="w-4 h-4" />
              <span className="hidden sm:inline">Carrinho</span>
              <span className="bg-amber-100 text-amber-950 font-bold px-2 py-0.5 rounded-full text-xs">
                {totalPotes}/10
              </span>
            </button>
          </nav>
        </div>
      </header>

      {/* Conteúdo Principal */}
      <main className="max-w-6xl mx-auto w-full px-4 py-8 flex-grow">
        {usuarioLogado && checkout.erro && <div role="alert" className="mb-6 p-4 rounded-xl bg-red-50 border border-red-200 text-red-800 text-sm">{checkout.erro}</div>}
        {usuarioLogado && checkout.aviso && <div role="status" className="mb-6 p-4 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 text-sm">{checkout.aviso}</div>}
        {usuarioLogado && checkout.temTentativa && !checkout.pedido && (
          <div className="mb-6 p-4 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 text-sm">
            Há uma tentativa de compra para recuperar. Consulte antes de iniciar outro pedido.{' '}
            <button disabled={checkout.ocupado} onClick={()=>void checkout.recuperar()} className="underline font-semibold disabled:opacity-50">Recuperar tentativa</button>
          </div>
        )}

        {usuarioLogado && carregandoPerfil && (
          <div role="status" className="mb-6 p-4 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 text-sm">
            Carregando seu cadastro...
          </div>
        )}
        {usuarioLogado && erroPerfil && (
          <div role="alert" className="mb-6 p-4 rounded-xl bg-red-50 border border-red-200 text-red-800 text-sm">
            <p>{erroPerfil}</p>
            <button type="button" disabled={carregandoPerfil}
              onClick={() => setRevisaoPerfil(valor => valor + 1)}
              className="mt-2 underline font-semibold disabled:opacity-50">
              Tentar carregar a conta novamente
            </button>
          </div>
        )}
        {avisoCarrinho && (
          <div className="mb-6 bg-amber-100 border border-amber-300 text-amber-900 px-4 py-3 rounded-xl flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-medium">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{avisoCarrinho}</span>
            </div>
            <button onClick={() => setAvisoCarrinho(null)} className="text-xs underline">
              Fechar
            </button>
          </div>
        )}

        {/* ================= PAINEL ADMINISTRATIVO ================= */}
        {abaAtiva === 'admin' && ehAdmin && (
          <AdminPanel />
        )}

        {/* ================= TELA DE LOGIN / CONTA ================= */}
        {abaAtiva === 'conta' && (
          <div className="max-w-3xl mx-auto">
            {!usuarioLogado ? (
              <div className="max-w-md mx-auto bg-white p-8 rounded-2xl border border-stone-200 shadow-sm">
                <div className="text-center mb-6">
                  <div className="w-12 h-12 bg-amber-100 text-amber-800 rounded-full flex items-center justify-center mx-auto mb-3">
                    <User className="w-6 h-6" />
                  </div>
                  <h2 className="text-2xl font-serif font-bold text-stone-900">
                    {modoCadastro ? 'Criar Conta' : 'Aceder à Conta'}
                  </h2>
                  <p className="text-sm text-stone-500 mt-1">
                    {modoCadastro
                      ? 'Registe-se para fazer encomendas e acompanhar envios.'
                      : 'Introduza o seu e-mail e palavra-passe registados.'}
                  </p>
                </div>

                <div className="grid grid-cols-2 bg-stone-100 p-1 rounded-xl mb-6 text-sm font-medium">
                  <button
                    type="button"
                    onClick={() => { setModoCadastro(false); setErroAuth(null); }}
                    className={`py-2 rounded-lg transition-all ${
                      !modoCadastro ? 'bg-white text-stone-900 shadow-sm' : 'text-stone-500'
                    }`}
                  >
                    Iniciar Sessão
                  </button>
                  <button
                    type="button"
                    onClick={() => { setModoCadastro(true); setErroAuth(null); }}
                    className={`py-2 rounded-lg transition-all ${
                      modoCadastro ? 'bg-white text-stone-900 shadow-sm' : 'text-stone-500'
                    }`}
                  >
                    Criar Conta
                  </button>
                </div>

                <form onSubmit={autenticarCliente} className="space-y-4">
                  {modoCadastro && (
                    <>
                      <div>
                        <label className="block text-xs font-medium text-stone-600 mb-1">Nome Completo *</label>
                        <div className="relative">
                          <User className="w-4 h-4 text-stone-400 absolute left-3.5 top-3" />
                          <input
                            type="text"
                            required
                            placeholder="Nome e Sobrenome"
                            value={nomeCadastro}
                            onChange={e => setNomeCadastro(e.target.value)}
                            className="w-full border border-stone-300 rounded-xl pl-10 pr-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber-700"
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className="block text-xs font-medium text-stone-600 mb-1">CPF</label>
                          <div className="relative">
                            <FileText className="w-4 h-4 text-stone-400 absolute left-3.5 top-3" />
                            <input
                              type="text"
                              placeholder="000.000.000-00"
                              value={cpfCadastro}
                              onChange={e => setCpfCadastro(e.target.value)}
                              className="w-full border border-stone-300 rounded-xl pl-10 pr-3 py-2.5 text-sm"
                            />
                          </div>
                        </div>

                        <div>
                          <label className="block text-xs font-medium text-stone-600 mb-1">Telefone / WhatsApp</label>
                          <div className="relative">
                            <Phone className="w-4 h-4 text-stone-400 absolute left-3.5 top-3" />
                            <input
                              type="text"
                              placeholder="(13) 99999-9999"
                              value={telefoneCadastro}
                              onChange={e => setTelefoneCadastro(e.target.value)}
                              className="w-full border border-stone-300 rounded-xl pl-10 pr-3 py-2.5 text-sm"
                            />
                          </div>
                        </div>
                      </div>
                    </>
                  )}

                  <div>
                    <label className="block text-xs font-medium text-stone-600 mb-1">E-mail *</label>
                    <div className="relative">
                      <Mail className="w-4 h-4 text-stone-400 absolute left-3.5 top-3" />
                      <input
                        type="email"
                        required
                        placeholder="seu@email.com"
                        value={emailLogin}
                        onChange={e => setEmailLogin(e.target.value)}
                        className="w-full border border-stone-300 rounded-xl pl-10 pr-4 py-2.5 text-sm"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-stone-600 mb-1">Palavra-passe *</label>
                    <div className="relative">
                      <Lock className="w-4 h-4 text-stone-400 absolute left-3.5 top-3" />
                      <input
                        type="password"
                        required
                        placeholder="••••••••"
                        value={senhaLogin}
                        onChange={e => setSenhaLogin(e.target.value)}
                        className="w-full border border-stone-300 rounded-xl pl-10 pr-4 py-2.5 text-sm"
                      />
                    </div>
                  </div>

                  {erroAuth && (
                    <div className="p-3 bg-red-50 border border-red-200 text-red-700 text-xs rounded-xl">
                      {erroAuth}
                    </div>
                  )}

                  {sucessoAuth && (
                    <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs rounded-xl">
                      {sucessoAuth}
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={carregandoAuth || inicializandoAuth}
                    className="w-full bg-amber-800 hover:bg-amber-900 text-white py-3 rounded-xl font-semibold text-sm transition-colors flex items-center justify-center gap-2"
                  >
                    {carregandoAuth && <Loader2 className="w-4 h-4 animate-spin" />}
                    <span>{modoCadastro ? 'Criar Minha Conta' : 'Iniciar Sessão'}</span>
                  </button>
                </form>
              </div>
            ) : (
              <div className="space-y-6">
                <div className="bg-white p-6 rounded-2xl border border-stone-200 shadow-sm flex flex-wrap items-center justify-between gap-4">
                  <div className="flex items-center gap-4">
                    <div className="w-14 h-14 bg-amber-100 text-amber-900 rounded-full flex items-center justify-center font-serif font-bold text-xl">
                      {(perfilCliente?.nome_clt || usuarioLogado.email || 'C')[0].toUpperCase()}
                    </div>
                    <div>
                      <h2 className="text-xl font-serif font-bold text-stone-900">
                        Olá, {perfilCliente?.nome_clt || usuarioLogado.email}
                      </h2>
                      <p className="text-xs text-stone-500">
                        {usuarioLogado.email} {perfilCliente?.cpf_clt ? `• CPF: ${perfilCliente.cpf_clt}` : ''}
                      </p>
                    </div>
                  </div>

                  <button
                    onClick={async () => {
                      const resultado = await supabase?.auth.signOut();
                      if (resultado?.error) setErroPerfil('Não foi possível sair da conta. Tente novamente.');
                    }}
                    className="flex items-center gap-1.5 text-xs font-semibold text-red-600 hover:bg-red-50 px-4 py-2 rounded-xl border border-red-200 transition-colors"
                  >
                    <LogOut className="w-4 h-4" />
                    <span>Terminar Sessão</span>
                  </button>
                </div>

                <div className="bg-white p-6 rounded-2xl border border-stone-200 shadow-sm">
                  <div className="flex items-center gap-2 mb-4">
                    <ClipboardList className="w-5 h-5 text-amber-800" />
                    <h3 className="text-lg font-serif font-bold text-stone-900">As Minhas Encomendas</h3>
                  </div>

                  {meusPedidos.length === 0 ? (
                    <div className="text-center py-8 text-stone-500 text-sm">
                      Ainda não realizou nenhuma encomenda.
                    </div>
                  ) : (
                    <div className="divide-y divide-stone-100">
                      {meusPedidos.map(ped => (
                        <div key={ped.id_pdd} className="py-4 flex items-center justify-between">
                          <div>
                            <span className="font-semibold text-stone-900 text-sm">
                              Encomenda #{ped.numero_pdd || ped.id_pdd}
                            </span>
                            <span className="block text-xs text-stone-500">
                              Data: {new Date(ped.data_pdd).toLocaleDateString('pt-BR')} • Estado:{' '}
                              <strong className="uppercase text-amber-800">{ped.status_pdd}</strong>
                            </span>
                          </div>
                          <div className="text-right">
                            <span className="font-bold text-stone-900 text-sm">
                              {Number.isFinite(Number(ped.valor_pdd)) && Number(ped.valor_pdd) > 0
                                ? `R$ ${Number(ped.valor_pdd).toFixed(2).replace('.', ',')}`
                                : ped.status_pdd === 'expirado' ? 'Pedido expirado'
                                : ped.status_pdd === 'cancelado' ? 'Pedido cancelado'
                                : ped.status_pdd === 'pendente' ? 'Aguardando pagamento'
                                : 'Valor indisponível'}
                            </span>
                            {ped.rastreio_pdd && (
                              <span className="block text-xs text-emerald-700">
                                Rastreio: {ped.rastreio_pdd}
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ================= TELA 1: CATÁLOGO ================= */}
        {abaAtiva === 'catalogo' && (
          <div>
            <div className="text-center max-w-2xl mx-auto mb-10">
              <span className="inline-flex items-center gap-1.5 bg-amber-100 text-amber-900 text-xs font-semibold px-3 py-1 rounded-full mb-3">
                <Sparkles className="w-3.5 h-3.5" /> Produção artesanal fresca sob encomenda
              </span>
              <h1 className="text-3xl sm:text-5xl font-serif font-bold text-stone-900 mb-3">
                Doces em Pote Artesanais
              </h1>
              <p className="text-stone-600 text-base sm:text-lg">
                Escolha os seus sabores. Enviamos até 10 unidades por pedido em embalagem especial.
              </p>
            </div>

            {carregandoProdutos ? (
              <div className="flex justify-center items-center py-20">
                <Loader2 className="w-8 h-8 animate-spin text-amber-800" />
              </div>
            ) : erroProdutos ? (
              <div role="alert" className="text-center py-12 bg-white border border-red-200 rounded-2xl">
                <p className="text-red-800 mb-4">{erroProdutos}</p>
                <button onClick={() => void carregarCatalogoDoSupabase()}
                  className="px-4 py-2 rounded-xl bg-amber-800 text-white">
                  Tentar novamente
                </button>
              </div>
            ) : produtos.length === 0 ? (
              <div className="text-center py-12 bg-white border border-stone-200 rounded-2xl text-stone-600">
                Nenhum produto disponível no momento.
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
                {produtos.map(produto => {
                  const varIdSelecionada = variacaoEscolhidaPorProduto[produto.id_prd] ?? produto.variacoes[0].id_var;
                  const variacao = produto.variacoes.find(v => v.id_var === varIdSelecionada) || produto.variacoes[0];

                  return (
                    <div
                      key={produto.id_prd}
                      className="bg-white rounded-2xl border border-stone-200/80 overflow-hidden shadow-sm hover:shadow-md transition-all flex flex-col"
                    >
                      <div className="aspect-[4/3] bg-stone-100 overflow-hidden relative">
                        <img
                          src={produto.imagem_prd || ''}
                          alt={produto.nome_prd}
                          className="w-full h-full object-cover hover:scale-105 transition-transform duration-500"
                        />
                        <span className="absolute top-3 left-3 bg-stone-900/80 text-amber-100 text-[11px] font-mono px-2 py-0.5 rounded">
                          ID #{produto.id_prd}
                        </span>
                        <span className={`absolute top-3 right-3 text-xs font-semibold px-2.5 py-1 rounded-full shadow-sm ${
                          variacao.disponivel_est > 0
                            ? 'bg-emerald-100 text-emerald-900'
                            : 'bg-red-100 text-red-800'
                        }`}>
                          {variacao.disponivel_est > 0 ? `${variacao.disponivel_est} em stock` : 'Sem stock'}
                        </span>
                      </div>

                      <div className="p-5 flex flex-col flex-grow">
                        <h2 className="font-serif font-bold text-lg text-stone-900 mb-1.5 leading-snug">
                          {produto.nome_prd}
                        </h2>
                        <p className="text-sm text-stone-600 mb-3 flex-grow">
                          {produto.descricao_prd || 'Doce artesanal preparado com ingredientes selecionados.'}
                        </p>

                        <div className="mb-3">
                          <label className="block text-[11px] font-semibold uppercase tracking-wider text-stone-400 mb-1">
                            Sabor / Variação:
                          </label>
                          <div className="flex flex-wrap gap-1.5">
                            {produto.variacoes.map(v => (
                              <button
                                key={v.id_var}
                                type="button"
                                onClick={() =>
                                  setVariacaoEscolhidaPorProduto(prev => ({
                                    ...prev,
                                    [produto.id_prd]: v.id_var
                                  }))
                                }
                                className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-all ${
                                  variacao.id_var === v.id_var
                                    ? 'bg-amber-800 text-white border-amber-800'
                                    : 'bg-stone-50 text-stone-700 border-stone-200 hover:border-amber-600'
                                }`}
                              >
                                {v.nome_var}
                              </button>
                            ))}
                          </div>
                        </div>

                        <div className="flex flex-wrap gap-1.5 mb-4 text-[11px] text-stone-500">
                          <span className="bg-stone-100 px-2 py-0.5 rounded">
                            Validade: {variacao.validade_dias_var || 7} dias
                          </span>
                          <span className="bg-stone-100 px-2 py-0.5 rounded">
                            Produção: {variacao.prazo_producao_dias_uteis_var || 2}d úteis
                          </span>
                        </div>

                        <div className="pt-3 border-t border-stone-100 flex items-center justify-between">
                          <div>
                            <span className="block text-xs text-stone-400">Preço unitário</span>
                            <span className="text-xl font-bold text-amber-900">
                              R$ {variacao.preco_var.toFixed(2).replace('.', ',')}
                            </span>
                          </div>

                          <button
                            onClick={() => adicionarAoCarrinho(produto, variacao)}
                            disabled={variacao.disponivel_est <= 0}
                            className="bg-amber-800 hover:bg-amber-900 disabled:bg-stone-300 text-white px-4 py-2.5 rounded-xl text-sm font-medium transition-colors flex items-center gap-1.5"
                          >
                            <Plus className="w-4 h-4" />
                            <span>Adicionar</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ================= TELA 2: CARRINHO E COTAÇÃO DO MELHOR ENVIO (COMPLETA) ================= */}
        {abaAtiva === 'carrinho' && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            <div className="lg:col-span-2 space-y-4">
              <div className="bg-white p-6 rounded-2xl border border-stone-200 shadow-sm">
                <div className="flex items-center justify-between mb-6">
                  <h2 className="text-2xl font-serif font-bold text-stone-900">
                    O Seu Carrinho ({totalPotes} {totalPotes === 1 ? 'item' : 'itens'})
                  </h2>
                  <span className="text-xs font-medium text-stone-500">
                    Limite máximo: 10 unidades por caixa
                  </span>
                </div>

                {carrinho.length === 0 ? (
                  <div className="text-center py-12">
                    <ShoppingBag className="w-12 h-12 text-stone-300 mx-auto mb-3" />
                    <p className="text-stone-600 mb-4">O seu carrinho ainda está vazio.</p>
                    <button
                      onClick={() => setAbaAtiva('catalogo')}
                      className="bg-amber-800 text-white px-5 py-2.5 rounded-xl text-sm font-medium"
                    >
                      Ver Doces
                    </button>
                  </div>
                ) : (
                  <div className="divide-y divide-stone-100">
                    {carrinho.map(item => (
                      <div key={`${item.produto_id}-${item.variacao_id}`} className="py-4 flex items-center gap-4">
                        <img
                          src={item.imagem}
                          alt={item.nome_produto}
                          className="w-16 h-16 rounded-xl object-cover bg-stone-100 shrink-0"
                        />
                        <div className="flex-grow">
                          <h3 className="font-semibold text-stone-900">{item.nome_produto}</h3>
                          <p className="text-xs text-stone-500">
                            Variação: <strong>{item.nome_variacao}</strong>
                          </p>
                          <p className="text-sm font-bold text-amber-900 mt-1">
                            R$ {item.preco_unitario.toFixed(2).replace('.', ',')} cada
                          </p>
                        </div>

                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => alterarQuantidade(item.produto_id, item.variacao_id, -1)}
                            aria-label={`Diminuir quantidade de ${item.nome_produto}`}
                            className="p-1.5 rounded-lg border border-stone-200 hover:bg-stone-100"
                          >
                            <Minus className="w-4 h-4" />
                          </button>
                          <span className="w-8 text-center font-semibold">{item.quantidade}</span>
                          <button
                            onClick={() => alterarQuantidade(item.produto_id, item.variacao_id, 1)}
                            aria-label={`Aumentar quantidade de ${item.nome_produto}`}
                            className="p-1.5 rounded-lg border border-stone-200 hover:bg-stone-100"
                          >
                            <Plus className="w-4 h-4" />
                          </button>
                        </div>

                        <div className="text-right min-w-[90px]">
                          <span className="font-bold text-stone-900">
                            R$ {(item.preco_unitario * item.quantidade).toFixed(2).replace('.', ',')}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Simulador de Envio com Melhor Envio */}
              {carrinho.length > 0 && (
                <div className="bg-white p-6 rounded-2xl border border-stone-200 shadow-sm">
                  <div className="flex items-center gap-2 mb-4">
                    <Truck className="w-5 h-5 text-amber-800" />
                    <h3 className="text-lg font-serif font-bold text-stone-900">
                      Entrega (Melhor Envio)
                    </h3>
                  </div>

                  <div className="flex flex-col sm:flex-row gap-3 mb-4">
                    <input
                      type="text"
                      value={cepDestino}
                      onChange={e => { invalidarFrete(); setCepDestino(e.target.value); }}
                      placeholder="Introduza o seu CEP (ex: 11703340)"
                      maxLength={9}
                      className="flex-grow border border-stone-300 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber-700"
                    />
                    <button
                      onClick={consultarFreteMelhorEnvio}
                      disabled={cotandoFrete || !usuarioLogado || carregandoPerfil || !perfilCliente || Boolean(erroPerfil)}
                      className="bg-stone-900 hover:bg-stone-800 text-white px-6 py-2.5 rounded-xl text-sm font-medium flex items-center justify-center gap-2"
                    >
                      {cotandoFrete ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                      <span>Calcular Frete</span>
                    </button>
                  </div>

                  {!usuarioLogado && (
                    <p className="mb-4 text-sm text-stone-600">
                      Entre na sua conta para calcular o frete e continuar a compra.{' '}
                      <button type="button" onClick={() => setAbaAtiva('conta')}
                        className="underline font-semibold text-amber-900">Entrar na conta</button>
                    </p>
                  )}
                  {cotacaoConfirmada && (
                    <p role="status" className="mb-4 text-xs text-stone-600">
                      Cotação válida até {new Date(cotacaoConfirmada.expiraEm).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}.
                    </p>
                  )}
                  {volumeCalculado && (
                    <div className="mb-4 text-xs bg-stone-50 border border-stone-200 rounded-xl p-3 text-stone-600 flex items-center gap-2">
                      <Package className="w-4 h-4 text-amber-800 shrink-0" />
                      <span>
                        Embalagem cotada para <strong>{totalPotes} unidade(s)</strong>:{' '}
                        <strong>{volumeCalculado.width} x {volumeCalculado.length} x {volumeCalculado.height} cm</strong> • Peso: <strong>{volumeCalculado.weight} kg</strong>
                      </span>
                    </div>
                  )}

                  {erroFrete && (
                    <p className="text-sm text-red-600 bg-red-50 p-3 rounded-xl">{erroFrete}</p>
                  )}

                  {cotacoes.length > 0 && (
                    <div className="space-y-2.5 mt-4">
                      {cotacoes.map(cot => (
                        <label
                          key={cot.id}
                          className={`flex items-center justify-between p-4 rounded-xl border cursor-pointer transition-all ${
                            cotacaoSelecionada?.id === cot.id
                              ? 'border-amber-800 bg-amber-50/60'
                              : 'border-stone-200 hover:border-stone-300'
                          }`}
                        >
                          <div className="flex items-center gap-3">
                            <input
                              type="radio"
                              name="frete"
                              checked={cotacaoSelecionada?.id === cot.id}
                              onChange={() => setCotacaoSelecionada(cot)}
                              className="text-amber-800 focus:ring-amber-800"
                            />
                            <div>
                              <span className="font-semibold text-sm text-stone-900">
                                {cot.company.name} - {cot.name}
                              </span>
                              <span className="block text-xs text-stone-500">
                                Prazo estimado: {cot.delivery_time} {cot.delivery_time === 1 ? 'dia útil' : 'dias úteis'}
                              </span>
                            </div>
                          </div>
                          <span className="font-bold text-amber-900">
                            R$ {cot.price.toFixed(2).replace('.', ',')}
                          </span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Resumo da Encomenda */}
            <div className="bg-white p-6 rounded-2xl border border-stone-200 shadow-sm h-fit sticky top-28">
              <h3 className="text-lg font-serif font-bold text-stone-900 mb-4">Resumo da Encomenda</h3>
              <div className="space-y-3 text-sm border-b border-stone-100 pb-4 mb-4">
                <div className="flex justify-between text-stone-600">
                  <span>Subtotal ({totalPotes} itens)</span>
                  <span>R$ {subtotalCotado.toFixed(2).replace('.', ',')}</span>
                </div>
                <div className="flex justify-between text-stone-600">
                  <span>Frete</span>
                  <span>
                    {cotacaoSelecionada
                      ? `R$ ${valorFrete.toFixed(2).replace('.', ',')}`
                      : 'Calcule pelo CEP'}
                  </span>
                </div>
              </div>

              <div className="flex justify-between items-baseline mb-6">
                <span className="font-semibold text-stone-900">Total</span>
                <span className="text-2xl font-bold text-amber-900">
                  R$ {totalPedido.toFixed(2).replace('.', ',')}
                </span>
              </div>

              <button
                onClick={() => setAbaAtiva('checkout')}
                disabled={carrinho.length === 0 || !cotacaoValida || cotandoFrete}
                className="w-full bg-amber-800 hover:bg-amber-900 disabled:bg-stone-300 text-white py-3.5 rounded-xl font-semibold text-sm transition-colors"
              >
                Ir para o Pagamento PIX
              </button>
              {!cotacaoSelecionada && carrinho.length > 0 && (
                <p className="text-xs text-center text-stone-500 mt-2">
                  Introduza o CEP e escolha o tipo de envio para prosseguir.
                </p>
              )}
            </div>
          </div>
        )}

        {/* ================= TELA 3: CHECKOUT E MORADA ================= */}
        {abaAtiva === 'checkout' && (
          <div className="max-w-3xl mx-auto space-y-6">
            <div className="bg-white p-6 rounded-2xl border border-stone-200 shadow-sm flex items-center justify-between">
              <div className="flex items-center gap-3">
                <User className="w-5 h-5 text-amber-800" />
                <div>
                  <h2 className="text-base font-serif font-bold text-stone-900">
                    {usuarioLogado
                      ? `Sessão iniciada como ${perfilCliente?.nome_clt || usuarioLogado.email}`
                      : 'Ainda não iniciou sessão'}
                  </h2>
                  <p className="text-xs text-stone-500">
                    {usuarioLogado
                      ? (carregandoPerfil ? 'Carregando seu cadastro...' : erroPerfil || !perfilCliente ? 'Conclua seu cadastro antes de finalizar.' : 'Os seus dados estão prontos para criar a encomenda.')
                      : 'Entre na sua conta para finalizar o pedido.'}
                  </p>
                </div>
              </div>
              {!usuarioLogado && (
                <button
                  onClick={() => setAbaAtiva('conta')}
                  className="bg-stone-900 text-white px-4 py-2 rounded-xl text-xs font-semibold shrink-0"
                >
                  Entrar / Registar
                </button>
              )}
            </div>

            {!cotacaoValida && (
              <div role="alert" className="p-4 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 text-sm">
                Calcule uma nova cotação de frete antes de finalizar.{' '}
                <button type="button" onClick={() => setAbaAtiva('carrinho')} className="underline font-semibold">
                  Voltar ao carrinho
                </button>
              </div>
            )}
            <form onSubmit={finalizarPedidoEGerarPix} className="bg-white p-6 rounded-2xl border border-stone-200 shadow-sm space-y-4">
              <h2 className="text-lg font-serif font-bold text-stone-900">
                Morada de Entrega (CEP: {cepDestino || 'Não informado'})
              </h2>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="sm:col-span-2">
                  <label className="block text-xs text-stone-500 mb-1">Rua / Logradouro *</label>
                  <input
                    type="text"
                    required
                    value={logradouro}
                    onChange={e => setLogradouro(e.target.value)}
                    className="w-full border border-stone-300 rounded-xl px-3.5 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs text-stone-500 mb-1">Número *</label>
                  <input
                    type="text"
                    required
                    value={numero}
                    onChange={e => setNumero(e.target.value)}
                    className="w-full border border-stone-300 rounded-xl px-3.5 py-2 text-sm"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-stone-500 mb-1">Complemento</label>
                  <input
                    type="text"
                    value={complemento}
                    onChange={e => setComplemento(e.target.value)}
                    placeholder="Apto, Bloco, etc."
                    className="w-full border border-stone-300 rounded-xl px-3.5 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs text-stone-500 mb-1">Bairro *</label>
                  <input
                    type="text"
                    required
                    value={bairro}
                    onChange={e => setBairro(e.target.value)}
                    className="w-full border border-stone-300 rounded-xl px-3.5 py-2 text-sm"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-stone-500 mb-1">Cidade *</label>
                  <input
                    type="text"
                    required
                    value={cidade}
                    onChange={e => setCidade(e.target.value)}
                    className="w-full border border-stone-300 rounded-xl px-3.5 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs text-stone-500 mb-1">Estado (UF) *</label>
                  <input
                    type="text"
                    required
                    maxLength={2}
                    value={estado}
                    onChange={e => setEstado(e.target.value.toUpperCase())}
                    className="w-full border border-stone-300 rounded-xl px-3.5 py-2 text-sm"
                  />
                </div>
              </div>

              {erroCheckout && (
                <div className="p-3 bg-red-50 text-red-700 text-sm rounded-xl border border-red-200">
                  {erroCheckout}
                </div>
              )}

              <div className="pt-4 border-t border-stone-100 flex items-center justify-between">
                <div>
                  <span className="block text-xs text-stone-500">Total com Frete ({cotacaoSelecionada?.name})</span>
                  <span className="text-2xl font-bold text-amber-900">
                    R$ {totalPedido.toFixed(2).replace('.', ',')}
                  </span>
                </div>

                <button
                  type="submit"
                  disabled={processandoPedido || inicializandoAuth || carregandoPerfil || !usuarioLogado || !perfilCliente || Boolean(erroPerfil) || (!cotacaoValida && !checkout.temTentativa)}
                  className="bg-emerald-700 hover:bg-emerald-800 text-white px-6 py-3.5 rounded-xl font-semibold text-sm flex items-center gap-2 shadow-sm"
                >
                  {processandoPedido ? <Loader2 className="w-4 h-4 animate-spin" /> : <QrCode className="w-4 h-4" />}
                  <span>{checkout.temTentativa ? 'Retomar tentativa de compra' : 'Salvar pedido e continuar'}</span>
                </button>
              </div>
            </form>
          </div>
        )}

        {/* ================= TELA 4: RECUPERAÇÃO E SITUAÇÃO DO PAGAMENTO ================= */}
        {abaAtiva==='acompanhamento' && usuarioLogado && (
          <PagamentoPedido checkout={checkout} voltar={()=>setAbaAtiva('conta')}
            novaCompra={()=>{ checkout.novaCompra(); invalidarFrete(); setErroCheckout(null); setAbaAtiva('catalogo'); }}/>
        )}
      </main>

      <footer className="bg-white border-t border-amber-100 py-6 text-center text-xs text-stone-500 mt-16">
        Confeitaria Márcia Ribeiro • Praia Grande, SP • Integrado com Supabase, Melhor Envio e Mercado Pago
      </footer>
    </div>
  );
}
