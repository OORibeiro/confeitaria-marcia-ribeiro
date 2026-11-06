import React, { useEffect, useRef, useState } from 'react';
import { supabase } from './supabase';

const BUCKET = 'mr-produtos-fotos';
const LIMITE = 5 * 1024 * 1024;
export default function FotoProduto({ valor, onChange, onOcupado, onPendente }: {
  valor: string; onChange: (url: string) => void; onOcupado: (ocupado: boolean) => void;
  onPendente: (pendente: boolean) => void;
}) {
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState('');
  const [aviso, setAviso] = useState('');
  const [foto, setFoto] = useState<ImageBitmap | null>(null);
  const [nome, setNome] = useState('');
  const [zoom, setZoom] = useState(1);
  const [inteira, setInteira] = useState(true);
  const [x, setX] = useState(50);
  const [y, setY] = useState(50);
  const canvas = useRef<HTMLCanvasElement>(null);
  const bitmapAtual = useRef<ImageBitmap | null>(null);
  const vivo = useRef(true);
  const trava = useRef(false);
  useEffect(() => {
    vivo.current = true;
    return () => { vivo.current = false; bitmapAtual.current?.close(); };
  }, []);
  useEffect(() => {
    if (!foto || !canvas.current) return;
    // A prévia e o arquivo enviado usam a mesma composição 4:3.
    const escalaBase = inteira
      ? Math.min(1200 / foto.width, 900 / foto.height)
      : Math.max(1200 / foto.width, 900 / foto.height);
    const largura = foto.width * escalaBase * zoom;
    const altura = foto.height * escalaBase * zoom;
    const contexto = canvas.current.getContext('2d');
    if (!contexto) return;
    contexto.fillStyle = '#ffffff';
    contexto.fillRect(0, 0, 1200, 900);
    contexto.drawImage(foto, (1200 - largura) * x / 100,
      (900 - altura) * y / 100, largura, altura);
  }, [foto, zoom, x, y, inteira]);

  function limparRecorte() {
    bitmapAtual.current?.close(); bitmapAtual.current = null;
    setFoto(null); setNome(''); onPendente(false);
  }
  async function selecionar(e: React.ChangeEvent<HTMLInputElement>) {
    const arquivo = e.target.files?.[0]; e.target.value = '';
    if (!arquivo || trava.current) return;
    setErro(''); setAviso('');
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(arquivo.type)) {
      setErro('Escolha uma foto JPG, PNG ou WebP.'); return;
    }
    if (!arquivo.size || arquivo.size > LIMITE) {
      setErro('A foto deve ter até 5 MB e não pode estar vazia.'); return;
    }
    trava.current = true; setOcupado(true); onOcupado(true);
    let imagem: ImageBitmap | undefined;
    try {
      try { imagem = await createImageBitmap(arquivo); }
      catch { throw new Error('Não foi possível abrir essa foto. Escolha outro arquivo válido.'); }
      if (!imagem.width || !imagem.height || imagem.width * imagem.height > 40000000) {
        throw new Error('Escolha uma foto com até 40 megapixels.');
      }
      if (!vivo.current) { imagem.close(); return; }
      bitmapAtual.current?.close(); bitmapAtual.current = imagem;
      setFoto(imagem); setNome(arquivo.name); setInteira(true); setZoom(1); setX(50); setY(50); onPendente(true);
    } catch (err) {
      imagem?.close();
      if (vivo.current) setErro(err instanceof Error ? err.message : 'Não foi possível abrir a foto.');
    } finally {
      trava.current = false;
      if (vivo.current) { setOcupado(false); onOcupado(false); }
    }
  }
  async function aplicar() {
    if (!foto || !canvas.current || trava.current) return;
    trava.current = true; setOcupado(true); onOcupado(true); setErro(''); setAviso('');
    try {
      if (!supabase) throw new Error('Conexão com a loja indisponível.');
      const arquivo = await new Promise<Blob>((resolve, reject) =>
        canvas.current!.toBlob(b => b ? resolve(b) : reject(new Error('Não foi possível preparar o recorte.')), 'image/webp', 0.9));
      if (arquivo.size > LIMITE) throw new Error('A imagem preparada ultrapassa 5 MB.');
      const { data: { user }, error: authError } = await supabase.auth.getUser();
      if (authError || !user) throw new Error('Entre novamente com sua conta administradora.');
      if (!vivo.current) return;
      const caminho = user.id + '/' + crypto.randomUUID() + (arquivo.type === 'image/webp' ? '.webp' : '.png');
      const { error } = await supabase.storage.from(BUCKET).upload(caminho, arquivo, {
        contentType: arquivo.type, cacheControl: '31536000', upsert: false,
      });
      if (error) throw new Error('Não foi possível enviar a foto. Confira sua conexão, a conta administradora e se o SQL 10 foi instalado.');
      if (!vivo.current) return;
      onChange(supabase.storage.from(BUCKET).getPublicUrl(caminho).data.publicUrl);
      limparRecorte();
      setAviso('Foto enviada. Clique em Salvar produto e variações para aplicá-la.');
    } catch (err) {
      if (vivo.current) setErro(err instanceof Error ? err.message : 'Não foi possível enviar a foto.');
    } finally {
      trava.current = false;
      if (vivo.current) { setOcupado(false); onOcupado(false); }
    }
  }
  const botao = 'rounded-lg border border-stone-300 px-3 py-2 text-sm font-semibold disabled:opacity-50';
  return <div className="space-y-3 rounded-xl border border-stone-200 p-4">
    <label className="block text-sm font-semibold">Selecionar foto do computador
      <input type="file" accept="image/jpeg,image/png,image/webp" disabled={ocupado}
        onChange={e => void selecionar(e)}
        className="mt-2 block w-full min-w-0 text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-emerald-50 file:px-3 file:py-2 file:text-emerald-800" />
    </label>
    <p className="text-xs text-stone-600">JPG, PNG ou WebP, até 5 MB. Selecione a foto e ajuste a parte que aparecerá no catálogo.</p>
    {foto ? <div className="space-y-3">
      <p className="break-all text-sm font-semibold">{nome}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" aria-pressed={inteira} className={botao + (inteira ? ' bg-emerald-700 text-white' : '')}
          disabled={ocupado} onClick={() => { setInteira(true); setZoom(1); setX(50); setY(50); }}>Mostrar foto inteira</button>
        <button type="button" aria-pressed={!inteira} className={botao + (!inteira ? ' bg-emerald-700 text-white' : '')}
          disabled={ocupado} onClick={() => { setInteira(false); setZoom(1); setX(50); setY(50); }}>Preencher quadro</button>
      </div>
      <p className="text-sm font-semibold">Prévia no catálogo — formato 4:3</p>
      <canvas ref={canvas} width={1200} height={900} role="img" aria-label="Prévia do enquadramento no catálogo"
        className="block w-full max-w-sm rounded-xl bg-stone-100" style={{ aspectRatio: '4 / 3' }} />
      <p className="text-xs text-stone-600">Mostrar foto inteira preserva a imagem com margens brancas. Preencher quadro pode cortar as bordas. Diminua o zoom para afastar a foto.</p>
      <label className="block text-sm">Zoom: {zoom.toFixed(2)}×
        <input className="block w-full" type="range" min="0.25" max="3" step="0.05" value={zoom}
          disabled={ocupado} onChange={e => setZoom(Number(e.target.value))} />
      </label>
      <label className="block text-sm">Posição horizontal
        <input className="block w-full" type="range" min="0" max="100" value={x}
          disabled={ocupado} onChange={e => setX(Number(e.target.value))} />
      </label>
      <label className="block text-sm">Posição vertical
        <input className="block w-full" type="range" min="0" max="100" value={y}
          disabled={ocupado} onChange={e => setY(Number(e.target.value))} />
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={botao} disabled={ocupado}
          onClick={() => { setZoom(1); setX(50); setY(50); }}>Centralizar</button>
        <button type="button" className={botao} disabled={ocupado}
          onClick={() => { limparRecorte(); setErro(''); }}>Cancelar recorte</button>
        <button type="button" className={botao + ' bg-emerald-700 text-white'} disabled={ocupado}
          onClick={() => void aplicar()}>Usar este enquadramento</button>
      </div>
      <p className="text-xs text-stone-600">Confirme o enquadramento antes de salvar o produto. Cancelar mantém a imagem anterior.</p>
    </div> : valor.startsWith('https://') && <div className="space-y-2">
      <p className="text-sm font-semibold">Prévia no catálogo — formato 4:3</p>
      <img key={valor} src={valor} alt="Prévia da foto do produto"
        className="block aspect-[4/3] w-full max-w-sm rounded-xl bg-stone-100 object-cover"
        onError={e => { e.currentTarget.style.display = 'none'; }} />
      <p className="text-xs text-stone-600">Para mudar o recorte, selecione novamente a foto original do computador.</p>
    </div>}
    {ocupado && <p role="status" className="text-sm">Preparando ou enviando foto… Aguarde.</p>}
    {erro && <p role="alert" className="text-sm text-red-700">{erro}</p>}
    {aviso && <p role="status" className="text-sm text-emerald-800">{aviso}</p>}
    <label className="block text-sm">Ou use um link de imagem (HTTPS)
      <input type="url" pattern="https://.*" maxLength={2048} value={valor} disabled={ocupado || !!foto}
        onChange={e => { setAviso(''); onChange(e.target.value); }}
        className="mt-1 w-full rounded-xl border border-stone-300 px-3 py-2 text-sm" placeholder="https://..." />
    </label>
    {valor && <button type="button" disabled={ocupado || !!foto} className="text-sm font-semibold text-red-700 disabled:opacity-50"
      onClick={() => { setAviso('Salve o produto para aplicar a remoção.'); onChange(''); }}>Remover foto do produto</button>}
  </div>;
}
