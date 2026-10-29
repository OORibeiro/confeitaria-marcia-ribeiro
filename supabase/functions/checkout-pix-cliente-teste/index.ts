// PACOTE 03. Ambiente de teste. A consulta não cria cobrança.
declare const Deno: { env: { get(name: string): string | undefined }; serve(handler: (req: Request) => Promise<Response>): unknown };
type Dependencies = { env: (name: string) => string | undefined; fetch: typeof fetch; log: (data: unknown) => void };

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

class Falha extends Error {
  constructor(
    public status: number,
    mensagem: string,
  ) {
    super(mensagem);
  }
}

function responder(status: number, dados: Record<string, unknown>) {
  return new Response(JSON.stringify(dados), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...(status === 503 ? { "Retry-After": "60" } : {}),
    },
  });
}

function centavos(valor: unknown): bigint {
  const texto = String(valor);

  if (!/^\d{1,10}(\.\d{1,2})?$/.test(texto)) {
    throw new Falha(409, "Valor do pagamento inválido.");
  }

  const [inteiro, decimal = ""] = texto.split(".");

  return BigInt(inteiro) * 100n +
    BigInt(decimal.padEnd(2, "0"));
}

function formatarValor(valor: bigint): string {
  return `${valor / 100n}.${String(valor % 100n).padStart(2, "0")}`;
}

export async function handleRequest(req: Request, dependencies?: Partial<Dependencies>): Promise<Response> {
  const env = dependencies?.env ?? ((name: string) => Deno.env.get(name));
  const fetch = dependencies?.fetch ?? globalThis.fetch;
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return responder(405, {
      sucesso: false,
      mensagem: "Use POST.",
    });
  }

  let etapa = "autenticacao";
  let pagamentoId: number | null = null;
  let orderId: string | null = null;

  try {
    const supabaseUrl = env("SUPABASE_URL");
    const chavePublica = env("SUPABASE_ANON_KEY");
    const chaveAdmin = env("SUPABASE_SERVICE_ROLE_KEY");
    const tokenMercadoPago = env(
      "MERCADO_PAGO_ACCESS_TOKEN_TEST",
    );

    if (
      !supabaseUrl ||
      !chavePublica ||
      !chaveAdmin ||
      !tokenMercadoPago
    ) {
      throw new Falha(503, "Configuração da função incompleta.");
    }

    const autorizacao = req.headers.get("Authorization") ?? "";

    if (!/^Bearer \S+$/i.test(autorizacao)) {
      throw new Falha(401, "Faça login para continuar.");
    }

    // Valida a sessão no servidor do Supabase Auth.
    const respostaUsuario = await fetch(
      `${supabaseUrl}/auth/v1/user`,
      {
        headers: {
          apikey: chavePublica,
          Authorization: autorizacao,
        },
        signal: AbortSignal.timeout(10000),
      },
    );

    if (!respostaUsuario.ok) {
      throw new Falha(
        respostaUsuario.status >= 500 ? 503 : 401,
        respostaUsuario.status >= 500
          ? "Não foi possível validar o login agora."
          : "Sessão inválida. Faça login novamente.",
      );
    }

    const usuario = await respostaUsuario.json();

    if (!usuario?.id || usuario.is_anonymous === true) {
      throw new Falha(401, "Use uma conta de cliente autenticada.");
    }

    const corpo = await req.json().catch(() => null);
    const pedidoId = corpo?.pedido_id;
    if (corpo?.somente_consulta !== undefined && typeof corpo.somente_consulta !== 'boolean') {
      throw new Falha(400, 'Informe somente_consulta como verdadeiro ou falso.');
    }
    const somenteConsulta = corpo?.somente_consulta === true;

    if (
      !Number.isSafeInteger(pedidoId) ||
      pedidoId <= 0 ||
      pedidoId > 2147483647
    ) {
      throw new Falha(400, "Informe um pedido_id inteiro válido.");
    }

    async function rpc(
      nome: string,
      argumentos: Record<string, unknown>,
      comoCliente: boolean,
    ) {
      const resposta = await fetch(
        `${supabaseUrl}/rest/v1/rpc/${nome}`,
        {
          method: "POST",
          headers: {
            apikey: comoCliente ? chavePublica! : chaveAdmin!,
            Authorization: comoCliente
              ? autorizacao
              : `Bearer ${chaveAdmin}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(argumentos),
          signal: AbortSignal.timeout(15000),
        },
      );

      const dados = await resposta.json().catch(() => null);

      if (!resposta.ok) {
        if (comoCliente && dados?.code === "42501") {
          throw new Falha(403, "Pedido não encontrado ou sem acesso.");
        }

        if (comoCliente && dados?.code === "P0001") {
          throw new Falha(
            409,
            dados.message ?? "O pedido não pode preparar o PIX.",
          );
        }

        throw new Falha(
          503,
          "Não foi possível concluir a operação no banco.",
        );
      }

      return dados;
    }

    async function mercadoPago(
      url: string,
      metodo = "GET",
      dados?: Record<string, unknown>,
      idempotencia?: string,
    ) {
      const resposta = await fetch(url, {
        method: metodo,
        headers: {
          Authorization: `Bearer ${tokenMercadoPago}`,
          "Content-Type": "application/json",
          ...(idempotencia
            ? { "X-Idempotency-Key": idempotencia }
            : {}),
        },
        ...(dados ? { body: JSON.stringify(dados) } : {}),
        signal: AbortSignal.timeout(15000),
      });

      const resultado = await resposta.json().catch(() => null);

      if (!resposta.ok || !resultado) {
        throw new Falha(
          503,
          "Não foi possível concluir a consulta ao Mercado Pago. " +
            "Uma nova tentativa deve usar o mesmo pedido.",
        );
      }

      return resultado;
    }

    // Confere o ambiente antes de preparar qualquer pagamento.
    etapa = "validar_ambiente";

    const conta = await mercadoPago(
      "https://api.mercadolibre.com/users/me",
    );

    if (
      !conta?.id ||
      !Array.isArray(conta.tags) ||
      !conta.tags.includes("test_user")
    ) {
      throw new Falha(
        503,
        "A credencial configurada não pertence a uma conta de teste.",
      );
    }

    etapa = "preparar_pagamento";

    // Esta chamada usa o JWT do cliente.
    // O banco verifica se o pedido pertence a ele.
    const registros = await rpc(
      somenteConsulta ? "consultar_pagamento_pix_cliente_teste" : "preparar_pix_cliente_teste",
      { p_pedido_id: pedidoId },
      true,
    );

    if (somenteConsulta && Array.isArray(registros) && registros.length === 0) {
      return responder(200, { sucesso: true, ambiente: 'teste', pedido_id: pedidoId,
        estado: 'aguardando_pix', pix: null, mensagem: 'Este pedido ainda não possui PIX preparado.' });
    }
    if (!Array.isArray(registros) || registros.length !== 1) {
      throw new Falha(503, "Preparação do pagamento sem resultado único.");
    }

    const pagamento = registros[0];

    pagamentoId = pagamento.pagamento_id;
    orderId = pagamento.order_id ?? null;

    const valorCentavos = centavos(pagamento.valor);
    const valor = formatarValor(valorCentavos);

    if (
      pagamento.pedido_id !== pedidoId ||
      valorCentavos <= 0n ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        .test(pagamento.chave_idempotencia)
    ) {
      throw new Falha(409, "Dados do pagamento inconsistentes.");
    }

    // Um pagamento aprovado no banco não gera outra cobrança.
    if (pagamento.status_pagamento === "aprovado") {
      return responder(200, {
        sucesso: true,
        ambiente: "teste",
        pedido_id: pedidoId,
        pagamento_id: pagamentoId,
        order_id: orderId,
        status_pagamento: "aprovado",
        estado: 'aprovado',
        pix: null,
        valor,
        mensagem: "Pagamento já aprovado. Nenhuma cobrança foi criada.",
      });
    }

    if (pagamento.status_pagamento !== "pendente") {
      throw new Falha(409, "Este pagamento exige análise.");
    }

    if (!orderId && somenteConsulta) {
      return responder(200, { sucesso: true, ambiente: 'teste', pedido_id: pedidoId,
        pagamento_id: pagamentoId, estado: 'aguardando_pix', valor, pix: null,
        mensagem: 'A criação do PIX pode ser retomada usando este mesmo pedido.' });
    }
    if (!orderId) {
      etapa = "criar_pix";

      const reservaAte = Date.parse(pagamento.expira_em);

      // O PIX terá validade de 30 minutos.
      // Exige uma margem antes do vencimento da reserva.
      if (
        !Number.isFinite(reservaAte) ||
        reservaAte - Date.now() < 31 * 60 * 1000
      ) {
        throw new Falha(
          409,
          "A reserva precisa ter pelo menos 31 minutos restantes " +
            "para iniciar a criação do PIX neste teste.",
        );
      }

      const criada = await mercadoPago(
        "https://api.mercadopago.com/v1/orders",
        "POST",
        {
          type: "online",
          processing_mode: "automatic",
          total_amount: valor,
          external_reference: pagamento.chave_idempotencia,
          payer: {
            email: "test_user_br@testuser.com",
            first_name: "APRO",
          },
          transactions: {
            payments: [
              {
                amount: valor,
                expiration_time: "PT30M",
                payment_method: {
                  id: "pix",
                  type: "bank_transfer",
                },
              },
            ],
          },
        },
        pagamento.chave_idempotencia,
      );

      if (
        typeof criada.id !== "string" ||
        !/^ORDTST[A-Z0-9]{1,60}$/.test(criada.id)
      ) {
        throw new Falha(409, "A order retornada não é uma order de teste.");
      }

      orderId = criada.id;
    }

    if (!/^ORDTST[A-Z0-9]{1,60}$/.test(orderId!)) {
      throw new Falha(409, "Identificador de order de teste inválido.");
    }

    etapa = "consultar_pix";

    // Consulta tanto as orders novas quanto as já vinculadas.
    const order = await mercadoPago(
      `https://api.mercadopago.com/v1/orders/${orderId}`,
    );

    const transacoes = order.transactions?.payments;

    if (
      order.id !== orderId ||
      order.type !== "online" ||
      String(order.user_id) !== String(conta.id) ||
      order.currency !== "BRL" ||
      order.external_reference !== pagamento.chave_idempotencia ||
      centavos(order.total_amount) !== valorCentavos ||
      !Array.isArray(transacoes) ||
      transacoes.length !== 1
    ) {
      throw new Falha(409, "A order não corresponde ao pagamento preparado.");
    }

    const transacao = transacoes[0];
    const metodo = transacao.payment_method;

    if (
      typeof transacao.id !== "string" ||
      !/^PAY[A-Z0-9]{1,80}$/.test(transacao.id) ||
      metodo?.id !== "pix" ||
      metodo?.type !== "bank_transfer" ||
      centavos(transacao.amount) !== valorCentavos ||
      (
        pagamento.transacao_id !== null &&
        pagamento.transacao_id !== transacao.id
      )
    ) {
      throw new Falha(409, "A transação PIX não corresponde ao pagamento.");
    }

    const vencimentoGateway = Date.parse(transacao.date_of_expiration);
    const vencimentoReserva = Date.parse(pagamento.expira_em);

    if (
      !Number.isFinite(vencimentoGateway) ||
      !Number.isFinite(vencimentoReserva) ||
      vencimentoGateway > vencimentoReserva
    ) {
      throw new Falha(
        409,
        "O vencimento do PIX não está coberto pela reserva de estoque.",
      );
    }

    etapa = "vincular_pix";

    // A autorização do cliente e a resposta do gateway
    // já foram verificadas antes desta chamada administrativa.
    await rpc(
      "vincular_pix_checkout_teste",
      {
        p_pagamento_id: pagamentoId,
        p_order_id: orderId,
        p_transacao_id: transacao.id,
        p_valor: Number(valor),
      },
      false,
    );

    const aprovadoGateway =
      order.status === "processed" &&
      order.status_detail === "accredited" &&
      transacao.status === "processed" &&
      transacao.status_detail === "accredited";

    if (
      aprovadoGateway &&
      (
        centavos(order.total_paid_amount) !== valorCentavos ||
        centavos(transacao.paid_amount) !== valorCentavos
      )
    ) {
      throw new Falha(409, "O valor aprovado pelo gateway está inconsistente.");
    }

    await rpc('registrar_validade_pix_checkout_teste', {
      p_pagamento_id: pagamentoId, p_order_id: orderId,
      p_transacao_id: transacao.id, p_expira_em: transacao.date_of_expiration,
    }, false);

    const podeExibirPix =
      order.status === "action_required" &&
      transacao.status === "action_required" &&
      vencimentoGateway > Date.now();

    return responder(200, {
      sucesso: true,
      ambiente: "teste",
      pedido_id: pedidoId,
      pagamento_id: pagamentoId,
      order_id: orderId,
      transacao_id: transacao.id,
      valor,
      novo_registro: pagamento.novo_registro,
      status_pagamento: pagamento.status_pagamento,
      status_gateway: order.status,
      status_pagamento_gateway: transacao.status,
      confirmacao_no_banco_pendente: aprovadoGateway,
      estado: aprovadoGateway ? 'confirmando'
        : podeExibirPix ? 'pendente'
        : vencimentoGateway <= Date.now() || order.status_detail === 'expired' || transacao.status_detail === 'expired'
          ? 'expirado' : 'em_analise',
      expira_em: transacao.date_of_expiration,
      pix: podeExibirPix
        ? {
          copia_e_cola: metodo.qr_code ?? null,
          imagem_base64: metodo.qr_code_base64 ?? null,
          link: metodo.ticket_url ?? null,
        }
        : null,
      mensagem: aprovadoGateway
        ? "Gateway aprovado. Confirmação no banco ainda pendente."
        : "PIX de teste consultado e vinculado. Não faça pagamento.",
    });
  } catch (erro) {
    const status = erro instanceof Falha ? erro.status : 503;
    const mensagem = erro instanceof Falha
      ? erro.message
      : "Falha temporária. Retome usando o mesmo pedido.";

    const log = dependencies?.log ?? ((data: unknown) => console.error('falha_checkout_pix_cliente_teste', data));
    log({
      etapa,
      pagamento_id: pagamentoId,
      order_id: orderId,
      status,
    });

    return responder(status, {
      sucesso: false,
      etapa,
      pagamento_id: pagamentoId,
      order_id: orderId,
      mensagem,
    });
  }
}

if (typeof Deno !== 'undefined') Deno.serve(req => handleRequest(req));
