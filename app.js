/* Horta Conectada 2026 — app de monitoramento (PWA)
 *
 * Abas:
 *   Painel ......... canteiros, estação meteorológica, sombrite e gráficos
 *   Recomendações .. dados cruzados → sugestões de irrigação e sombrite
 *   Conferência .... situação de cada sensor e da comunicação com o ESP32
 *
 * Os dados vêm da planilha via Apps Script (JSON). Sem URL configurada,
 * o app roda em modo demonstração com dados simulados.
 */
(function () {
  'use strict';

  // ================================================================ configuração
  const PADRAO = {
    API_URL: '',
    INTERVALO_MIN: 15,
    ATUALIZAR_MIN: 5,
    CANTEIROS: { A: 'Canteiro A', B: 'Canteiro B' },
    NOMES: { solo1: 'Sensor 1', solo2: 'Sensor 2', solo3: 'Sensor 3', solo4: 'Sensor 4' },
    SOLO_BRUTO: { SECO_ACIMA: 3500, ENCHARCADO_ABAIXO: 1500 },
    CALIBRACAO: { solo1: null, solo2: null, solo3: null, solo4: null },
    SOLO_PCT: { SECO_ABAIXO: 30, ENCHARCADO_ACIMA: 85 },
    LUZ_BRUTO: { NOITE_ABAIXO: 200, NUBLADO_ATE: 1500, CEU_LIMPO_ATE: 3000 },
    CLIMA: { TEMP_QUENTE: 30, TEMP_FRIO: 20, UMID_AR_SECO: 45, UMID_AR_CHUVA: 90 },
  };

  function mesclar(base, extra) {
    const out = Object.assign({}, base);
    Object.keys(extra || {}).forEach((k) => {
      const v = extra[k];
      out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object'
        ? mesclar(base[k], v) : v;
    });
    return out;
  }

  const CFG = mesclar(PADRAO, window.HORTA_CONFIG || {});
  const params = new URLSearchParams(location.search);
  const MODO_DEMO = !CFG.API_URL || params.has('demo');
  const INTERVALO_MS = CFG.INTERVALO_MIN * 60 * 1000;
  const FUSO = 'America/Campo_Grande';
  const CHAVE_CACHE = 'horta:ultimas-leituras';

  const SONDAS = [
    { chave: 'solo1', canteiro: 'A', gpio: 32 },
    { chave: 'solo2', canteiro: 'A', gpio: 33 },
    { chave: 'solo3', canteiro: 'B', gpio: 34 },
    { chave: 'solo4', canteiro: 'B', gpio: 35 },
  ];
  const nomeSonda = (chave) => CFG.NOMES[chave] || chave;

  const estado = { dias: 1, leituras: [], recebidoEm: 0, carregando: false, aba: 'painel' };
  const graficos = {};
  const $ = (id) => document.getElementById(id);

  // ================================================================ formatação
  const fmtHora = new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, hour: '2-digit', minute: '2-digit' });
  const fmtDia = new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, day: '2-digit', month: '2-digit' });
  const fmtCompleto = new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

  function num(v, casas) {
    if (v === null || v === undefined || isNaN(v)) return '–';
    return v.toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });
  }

  function duracao(ms) {
    const min = Math.round(ms / 60000);
    if (min < 60) return min + ' min';
    const h = Math.floor(min / 60), r = min % 60;
    if (h < 48) return h + ' h' + (r && h < 6 ? ' ' + r + ' min' : '');
    return Math.floor(h / 24) + ' dias';
  }

  function haQuanto(ms) {
    return ms < 60000 ? 'agora mesmo' : 'há ' + duracao(ms);
  }

  const cssVar = (nome) => getComputedStyle(document.documentElement).getPropertyValue(nome).trim();
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ================================================================ classificações
  function calibrado(chave) {
    const c = CFG.CALIBRACAO[chave];
    return c && typeof c.seco === 'number' && typeof c.molhado === 'number' && c.seco !== c.molhado ? c : null;
  }
  const algumCalibrado = () => SONDAS.some((s) => calibrado(s.chave));

  function percentual(chave, bruto) {
    const c = calibrado(chave);
    if (!c || bruto === null || bruto === undefined) return null;
    return Math.max(0, Math.min(100, ((c.seco - bruto) / (c.seco - c.molhado)) * 100));
  }

  const CLASSES_SOLO = {
    seco: { rotulo: 'Seco', cor: '#E3C98F' },
    adequado: { rotulo: 'Adequado', cor: '#6FBF73' },
    encharcado: { rotulo: 'Encharcado', cor: '#4F8FC9' },
  };

  // Classe do solo a partir do valor bruto (ou do % se a sonda estiver calibrada)
  function classeSolo(chave, bruto) {
    if (bruto === null || bruto === undefined) return null;
    const p = percentual(chave, bruto);
    let id;
    if (p !== null) {
      id = p < CFG.SOLO_PCT.SECO_ABAIXO ? 'seco' : p > CFG.SOLO_PCT.ENCHARCADO_ACIMA ? 'encharcado' : 'adequado';
    } else {
      id = bruto > CFG.SOLO_BRUTO.SECO_ACIMA ? 'seco' : bruto < CFG.SOLO_BRUTO.ENCHARCADO_ABAIXO ? 'encharcado' : 'adequado';
    }
    return Object.assign({ id }, CLASSES_SOLO[id]);
  }

  const CLASSES_LUZ = {
    noite: { rotulo: 'Noite' },
    nublado: { rotulo: 'Nublado' },
    ceu: { rotulo: 'Céu limpo' },
    sol: { rotulo: 'Ensolarado' },
  };

  function classeLuz(bruto) {
    if (bruto === null || bruto === undefined) return null;
    const L = CFG.LUZ_BRUTO;
    const id = bruto < L.NOITE_ABAIXO ? 'noite' : bruto <= L.NUBLADO_ATE ? 'nublado' : bruto <= L.CEU_LIMPO_ATE ? 'ceu' : 'sol';
    return Object.assign({ id }, CLASSES_LUZ[id]);
  }

  function classeTemp(t) {
    if (t === null || t === undefined) return null;
    if (t >= CFG.CLIMA.TEMP_QUENTE) return { id: 'quente', rotulo: 'Quente' };
    if (t < CFG.CLIMA.TEMP_FRIO) return { id: 'frio', rotulo: 'Frio' };
    return { id: 'ameno', rotulo: 'Ameno' };
  }

  function classeUmidAr(u) {
    if (u === null || u === undefined) return null;
    if (u <= CFG.CLIMA.UMID_AR_SECO) return { id: 'seco', rotulo: 'Ar seco' };
    if (u >= CFG.CLIMA.UMID_AR_CHUVA) return { id: 'umido', rotulo: 'Muito úmido' };
    return { id: 'normal', rotulo: 'Normal' };
  }

  // Faixas para o fundo e o eixo dos gráficos
  function faixasSolo() {
    if (algumCalibrado()) {
      const P = CFG.SOLO_PCT;
      return { min: 0, max: 100, reverso: false, faixas: [
        { de: 0, ate: P.SECO_ABAIXO, rotulo: 'Seco', cor: 'rgba(227,201,143,.22)' },
        { de: P.SECO_ABAIXO, ate: P.ENCHARCADO_ACIMA, rotulo: 'Adequado', cor: 'rgba(111,191,115,.12)' },
        { de: P.ENCHARCADO_ACIMA, ate: 100, rotulo: 'Encharcado', cor: 'rgba(79,143,201,.16)' },
      ] };
    }
    const B = CFG.SOLO_BRUTO;
    return { min: 0, max: 4095, reverso: true, faixas: [
      { de: B.SECO_ACIMA, ate: 4095, rotulo: 'Seco', cor: 'rgba(227,201,143,.22)' },
      { de: B.ENCHARCADO_ABAIXO, ate: B.SECO_ACIMA, rotulo: 'Adequado', cor: 'rgba(111,191,115,.12)' },
      { de: 0, ate: B.ENCHARCADO_ABAIXO, rotulo: 'Encharcado', cor: 'rgba(79,143,201,.16)' },
    ] };
  }

  function faixasLuz() {
    const L = CFG.LUZ_BRUTO;
    return { min: 0, max: 4095, reverso: false, faixas: [
      { de: 0, ate: L.NOITE_ABAIXO, rotulo: 'Noite', cor: 'rgba(70,80,130,.18)' },
      { de: L.NOITE_ABAIXO, ate: L.NUBLADO_ATE, rotulo: 'Nublado', cor: 'rgba(140,150,160,.14)' },
      { de: L.NUBLADO_ATE, ate: L.CEU_LIMPO_ATE, rotulo: 'Céu limpo', cor: 'rgba(111,168,214,.14)' },
      { de: L.CEU_LIMPO_ATE, ate: 4095, rotulo: 'Ensolarado', cor: 'rgba(224,178,58,.18)' },
    ] };
  }

  // ================================================================ dados
  async function buscarDados(dias) {
    if (MODO_DEMO) return { ok: true, agora: Date.now(), leituras: gerarDemo(dias) };

    const url = CFG.API_URL + (CFG.API_URL.includes('?') ? '&' : '?') + 'dias=' + dias + '&_=' + Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    try {
      const resp = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const json = await resp.json();
      if (!json.ok || !Array.isArray(json.leituras)) throw new Error('Resposta inesperada do Apps Script');
      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  function salvarCache(pacote) {
    try { localStorage.setItem(CHAVE_CACHE, JSON.stringify(pacote)); } catch (e) { /* sem espaço ou modo privado */ }
  }
  function lerCache() {
    try { return JSON.parse(localStorage.getItem(CHAVE_CACHE) || 'null'); } catch (e) { return null; }
  }

  async function atualizar() {
    if (estado.carregando) return;
    estado.carregando = true;
    $('btn-atualizar').classList.add('girando');
    try {
      const json = await buscarDados(estado.dias);
      estado.leituras = json.leituras.sort((a, b) => a.t - b.t);
      estado.recebidoEm = Date.now();
      $('faixa-offline').hidden = true;
      if (!MODO_DEMO) salvarCache({ recebidoEm: estado.recebidoEm, leituras: estado.leituras });
    } catch (erro) {
      console.warn('Falha ao buscar dados:', erro);
      const cache = lerCache();
      if (cache && cache.leituras && !estado.leituras.length) {
        estado.leituras = cache.leituras;
        estado.recebidoEm = cache.recebidoEm;
      }
      const faixa = $('faixa-offline');
      faixa.textContent = navigator.onLine
        ? 'Não foi possível falar com a planilha agora. Mostrando as últimas leituras salvas neste aparelho.'
        : 'Sem internet. Mostrando as últimas leituras salvas neste aparelho.';
      faixa.hidden = false;
    } finally {
      estado.carregando = false;
      $('btn-atualizar').classList.remove('girando');
      desenharTudo();
    }
  }

  // ================================================================ análise de operação
  const ultimaLeitura = () => (estado.leituras.length ? estado.leituras[estado.leituras.length - 1] : null);
  const serie = (chave, n) => { const a = estado.leituras.map((l) => l[chave]); return n ? a.slice(-n) : a; };

  function statusConexao() {
    const u = ultimaLeitura();
    if (!u) return { nivel: 'offline', idade: Infinity };
    const idade = Date.now() - u.t;
    if (idade <= INTERVALO_MS * 2) return { nivel: 'online', idade };
    if (idade <= INTERVALO_MS * 4) return { nivel: 'atrasado', idade };
    return { nivel: 'offline', idade };
  }

  const leiturasEm3h = () => Math.max(3, Math.ceil(180 / CFG.INTERVALO_MIN));

  function analisarAnalogico(chave, opcoes) {
    const recentes = serie(chave, leiturasEm3h());
    const ultimas3 = recentes.slice(-3);
    if (!ultimas3.length || ultimas3.every((v) => v === null || v === undefined)) {
      return { nivel: 'falha', texto: 'Sem leitura recente.' };
    }
    if (opcoes.saturacao && ultimas3.every((v) => v !== null && v >= 4090)) {
      return { nivel: 'falha', texto: 'Preso no máximo (4095). A sonda pode estar fora do solo, solta ou desconectada.' };
    }
    if (opcoes.saturacao && ultimas3.every((v) => v !== null && v <= 5)) {
      return { nivel: 'falha', texto: 'Preso no zero. Possível curto ou fio do sinal encostado no GND.' };
    }
    const validos = recentes.filter((v) => v !== null && v !== undefined);
    const ultimo = validos[validos.length - 1];
    if (ultimo > 5 && ultimo < 4090 && validos.length >= leiturasEm3h() && validos.every((v) => v === validos[0])) {
      return { nivel: 'atencao', texto: 'O valor não muda há 3 horas. Confira a fiação.' };
    }
    return { nivel: 'ok', texto: 'Funcionando.' };
  }

  function analisarDHT() {
    const rec = serie('temp', 3);
    if (!rec.length || rec.every((v) => v === null)) return { nivel: 'falha', texto: 'Sem leitura de temperatura e umidade. Confira o pull-up de 10 kΩ e o fio do GPIO 25.' };
    if (rec.some((v) => v === null)) return { nivel: 'atencao', texto: 'Falhou em parte das últimas leituras.' };
    return { nivel: 'ok', texto: 'Funcionando.' };
  }

  function analisarConexao() {
    const con = statusConexao();
    if (!ultimaLeitura()) return { nivel: 'falha', texto: 'Nenhuma leitura encontrada no período.' };
    if (con.nivel === 'online') return { nivel: 'ok', texto: 'Enviando dados normalmente.' };
    if (con.nivel === 'atrasado') return { nivel: 'atencao', texto: 'Última leitura ' + haQuanto(con.idade) + '. O esperado é a cada ' + CFG.INTERVALO_MIN + ' min.' };
    return { nivel: 'falha', texto: 'Sem dados ' + haQuanto(con.idade) + '. Verifique a energia e o Wi-Fi do ESP32.' };
  }

  // Lista completa de itens de operação (usada na conferência e no selo da aba)
  function itensOperacao() {
    const itens = [{ id: 'esp', titulo: 'ESP32 e Wi-Fi', ligacao: 'Wi-Fi', r: analisarConexao() }];
    SONDAS.forEach((s) => itens.push({
      id: s.chave, titulo: nomeSonda(s.chave) + ' (' + CFG.CANTEIROS[s.canteiro] + ')',
      curto: nomeSonda(s.chave) + ' (' + s.canteiro + ')', ligacao: 'GPIO ' + s.gpio,
      r: analisarAnalogico(s.chave, { saturacao: true }),
    }));
    itens.push({ id: 'dht', titulo: 'DHT22 (temperatura e umidade do ar)', curto: 'DHT22', ligacao: 'GPIO 25', r: analisarDHT() });
    itens.push({ id: 'lum1', titulo: 'LDR 1 (luminosidade)', curto: 'LDR 1', ligacao: 'GPIO 36', r: analisarAnalogico('lum1', { saturacao: false }) });
    itens.push({ id: 'lum2', titulo: 'LDR 2 (luminosidade)', curto: 'LDR 2', ligacao: 'GPIO 39', r: analisarAnalogico('lum2', { saturacao: false }) });
    return itens;
  }

  // ================================================================ recomendações (dados cruzados)
  function soloDoCanteiro(id, u, saudeSondas) {
    const sondas = SONDAS.filter((s) => s.canteiro === id);
    const confiaveis = sondas.filter((s) => saudeSondas[s.chave].nivel !== 'falha' && u && u[s.chave] !== null && u[s.chave] !== undefined);
    if (!confiaveis.length) return { classe: null, valor: null, sondas: [] };
    const media = confiaveis.reduce((a, s) => a + u[s.chave], 0) / confiaveis.length;
    return { classe: classeSolo(confiaveis[0].chave, media), valor: media, sondas: confiaveis.map((s) => nomeSonda(s.chave)) };
  }

  function mediaLuz(u, saude) {
    const vals = ['lum1', 'lum2'].filter((k) => saude[k].nivel !== 'falha' && u && u[k] !== null && u[k] !== undefined).map((k) => u[k]);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }

  function calcularRecomendacoes() {
    const u = ultimaLeitura();
    const saude = {};
    itensOperacao().forEach((i) => { saude[i.id] = i.r; });

    const solo = { A: soloDoCanteiro('A', u, saude), B: soloDoCanteiro('B', u, saude) };
    const temp = u ? u.temp : null, umid = u ? u.umid : null;
    const luzV = mediaLuz(u, saude);
    const cT = classeTemp(temp), cU = classeUmidAr(umid), cL = classeLuz(luzV);
    const C = CFG.CLIMA;

    const quenteSeco = temp !== null && umid !== null && temp >= C.TEMP_QUENTE && umid <= C.UMID_AR_SECO;
    const chuvoso = umid !== null && umid >= C.UMID_AR_CHUVA && cL && (cL.id === 'nublado' || cL.id === 'noite');
    const frioUmido = chuvoso && temp !== null && temp <= C.TEMP_FRIO;

    // ---------- irrigação
    const irr = { nivel: 'ok', texto: 'Manter a programação do Rain Bird.', motivos: [] };
    const secos = ['A', 'B'].filter((c) => solo[c].classe && solo[c].classe.id === 'seco');
    const encharcados = ['A', 'B'].filter((c) => solo[c].classe && solo[c].classe.id === 'encharcado');
    const nomesC = (lista) => lista.map((c) => CFG.CANTEIROS[c]).join(' e ');

    if (secos.length && chuvoso) {
      irr.nivel = 'atencao';
      irr.texto = 'Solo seco em ' + nomesC(secos) + ', mas há indício de chuva: aguardar a próxima leitura antes de irrigar.';
    } else if (secos.length) {
      irr.nivel = 'acao';
      irr.texto = 'Irrigação recomendada em ' + nomesC(secos) + '.';
    } else if (encharcados.length || frioUmido) {
      irr.nivel = 'reduzir';
      irr.texto = encharcados.length
        ? 'Suspender ou reduzir a irrigação em ' + nomesC(encharcados) + '.'
        : 'Reduzir a irrigação: tempo frio e úmido.';
    } else if (chuvoso) {
      irr.nivel = 'reduzir';
      irr.texto = 'Reduzir a irrigação: ar muito úmido e céu fechado.';
    } else if (quenteSeco) {
      irr.nivel = 'atencao';
      irr.texto = 'Manter a programação e redobrar a atenção: dia quente com ar seco.';
    } else if (!solo.A.classe && !solo.B.classe) {
      irr.nivel = 'info';
      irr.texto = 'Sem leitura confiável do solo. Manter a programação do Rain Bird até verificar os sensores.';
    }

    ['A', 'B'].forEach((c) => {
      const s = solo[c];
      if (s.classe) irr.motivos.push(CFG.CANTEIROS[c] + ': solo ' + s.classe.rotulo.toLowerCase() + ' (' + num(s.valor, 0) + ' bruto, ' + s.sondas.join(' e ') + ').');
      else irr.motivos.push(CFG.CANTEIROS[c] + ': sem leitura confiável do solo. Veja a aba Conferência.');
    });
    if (quenteSeco) irr.motivos.push('Temperatura de ' + num(temp, 1) + ' °C com ar a ' + num(umid, 0) + '%: perda de água acelerada.');
    if (chuvoso) irr.motivos.push('Ar a ' + num(umid, 0) + '% com céu ' + (cL.id === 'noite' ? 'escuro' : 'nublado') + ': indício de chuva.');

    // ---------- sombrite
    const somb = { nivel: 'ok', texto: 'Manter aberto.', motivos: [] };
    if (!cL) {
      somb.nivel = 'info';
      somb.texto = 'Sem leitura de luminosidade para sugerir.';
    } else if (cL.id === 'sol' && temp !== null && temp >= C.TEMP_QUENTE) {
      somb.nivel = 'acao';
      somb.texto = 'Fechar o sombrite: sol forte e calor.';
    } else if (temp !== null && temp >= C.TEMP_QUENTE + 3 && cL.id !== 'noite') {
      somb.nivel = 'acao';
      somb.texto = 'Fechar o sombrite: temperatura muito alta.';
    } else if (cL.id === 'sol' && umid !== null && umid <= C.UMID_AR_SECO) {
      somb.nivel = 'atencao';
      somb.texto = 'Fechar nas horas mais quentes: sol forte e ar seco.';
    } else if (cL.id === 'sol') {
      somb.texto = 'Pode ficar aberto. Fechar se a temperatura passar de ' + C.TEMP_QUENTE + ' °C.';
    } else if (cL.id === 'noite') {
      somb.texto = 'Manter aberto: sem sol.';
    }
    if (cL) somb.motivos.push('Luminosidade: ' + cL.rotulo.toLowerCase() + ' (' + num(luzV, 0) + ' bruto, média dos LDRs).');
    if (cT) somb.motivos.push('Temperatura do ar: ' + num(temp, 1) + ' °C (' + cT.rotulo.toLowerCase() + ').');
    if (cU) somb.motivos.push('Umidade do ar: ' + num(umid, 0) + '% (' + cU.rotulo.toLowerCase() + ').');
    const sAtual = estadoSombrite(u);
    if (sAtual.id !== 'sem') somb.motivos.push('Estado atual do sombrite: ' + sAtual.rotulo.toLowerCase() + '.');

    return { irr, somb, solo, temp, umid, luzV, cT, cU, cL, sAtual };
  }

  // Sombrite: coluna J da planilha (1 = fechado, 0 = aberto). Vazia = ainda sem sensor.
  function estadoSombrite(u) {
    const v = u ? u.sombrite : null;
    if (v === 1) return { id: 'fechado', rotulo: 'Fechado' };
    if (v === 0) return { id: 'aberto', rotulo: 'Aberto' };
    return { id: 'sem', rotulo: 'Sem leitura' };
  }

  // ================================================================ desenho: topo e abas
  function desenharConexao() {
    const el = $('conexao');
    const con = statusConexao();
    const u = ultimaLeitura();
    el.dataset.estado = con.nivel;
    let texto;
    if (!u) texto = 'Nenhuma leitura no período';
    else if (con.nivel === 'online') texto = 'Online, última leitura ' + haQuanto(con.idade) + ' (' + fmtHora.format(u.t) + ')';
    else if (con.nivel === 'atrasado') texto = 'Leitura atrasada, a última foi ' + haQuanto(con.idade);
    else texto = 'Sem comunicação, a última leitura foi ' + haQuanto(con.idade);
    $('conexao-texto').textContent = texto;
  }

  function mostrarAba(nome) {
    if (!['painel', 'recomendacoes', 'conferencia'].includes(nome)) nome = 'painel';
    estado.aba = nome;
    document.querySelectorAll('main.aba').forEach((m) => { m.hidden = m.dataset.aba !== nome; });
    document.querySelectorAll('.abas a').forEach((a) => {
      if (a.dataset.aba === nome) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    if (nome === 'painel') desenharGraficos();
  }

  function desenharSelo() {
    const problemas = itensOperacao().filter((i) => i.r.nivel !== 'ok');
    const n = problemas.length;
    const selo = $('selo-conferencia');
    selo.hidden = !n;
    selo.textContent = n;
    selo.dataset.nivel = problemas.some((i) => i.r.nivel === 'falha') ? 'falha' : 'atencao';
    const aviso = $('aviso-conferencia');
    aviso.hidden = !n;
    aviso.dataset.nivel = selo.dataset.nivel;
    aviso.textContent = n === 1
      ? '1 item precisa de verificação. Abrir a conferência de operação'
      : n + ' itens precisam de verificação. Abrir a conferência de operação';
  }

  // ================================================================ desenho: painel
  function desenharPlanta() {
    const u = ultimaLeitura();
    const saude = {};
    SONDAS.forEach((s) => { saude[s.chave] = analisarAnalogico(s.chave, { saturacao: true }); });

    const W = 380, H = 250, larg = 150, alt = 200, topo = 36;
    const canteiros = [{ id: 'A', x: 8 }, { id: 'B', x: W - 8 - larg }];
    const F = 'Atkinson Hyperlegible, sans-serif', FT = 'Bricolage Grotesque, sans-serif';

    let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Planta dos canteiros com a umidade do solo em cada sensor">';
    svg += '<defs><pattern id="sulcos" width="14" height="14" patternUnits="userSpaceOnUse"><ellipse cx="7" cy="7" rx="3.2" ry="1.8" fill="#5E8F48" opacity=".55"/></pattern></defs>';

    canteiros.forEach((c) => {
      const cx = c.x + larg / 2;
      svg += '<text x="' + cx + '" y="22" text-anchor="middle" fill="#E7F0E1" font-family="' + FT + '" font-weight="700" font-size="16">' + esc(CFG.CANTEIROS[c.id]) + '</text>';
      svg += '<rect x="' + c.x + '" y="' + topo + '" width="' + larg + '" height="' + alt + '" rx="10" fill="#5B3F27" stroke="#7A5638" stroke-width="2"/>';
      svg += '<rect x="' + (c.x + 6) + '" y="' + (topo + 6) + '" width="' + (larg - 12) + '" height="' + (alt - 12) + '" rx="6" fill="url(#sulcos)"/>';

      SONDAS.filter((s) => s.canteiro === c.id).forEach((s, i) => {
        const cy = topo + alt * (i === 0 ? 0.28 : 0.72);
        const bruto = u ? u[s.chave] : null;
        const sa = saude[s.chave];
        const cls = sa.nivel === 'falha' ? { rotulo: 'Verificar', cor: '#7C8A80' } : classeSolo(s.chave, bruto);
        const anel = sa.nivel === 'falha' ? '#FF8A8A' : sa.nivel === 'atencao' ? '#F2C94C' : 'rgba(242,247,238,.85)';
        const tracejado = sa.nivel === 'ok' ? '' : ' stroke-dasharray="4 3"';
        const bx = cx - 64, bw = 128;

        svg += '<rect x="' + bx + '" y="' + (cy - 32) + '" width="' + bw + '" height="64" rx="12" fill="#1F4D2E" fill-opacity=".86" stroke="' + anel + '" stroke-width="2"' + tracejado + '/>';
        svg += '<text x="' + (bx + 12) + '" y="' + (cy - 11) + '" fill="#C5D6BC" font-size="11.5" font-family="' + F + '">' + esc(nomeSonda(s.chave)) + '</text>';
        svg += '<text x="' + (bx + bw - 12) + '" y="' + (cy - 11) + '" text-anchor="end" fill="#9FB596" font-size="10.5" font-family="' + F + '">' + (bruto === null || bruto === undefined ? '' : num(bruto, 0)) + '</text>';
        svg += '<circle cx="' + (bx + 19) + '" cy="' + (cy + 11) + '" r="7" fill="' + (cls ? cls.cor : '#7C8A80') + '" stroke="#F2F7EE" stroke-width="1.4"/>';
        svg += '<text x="' + (bx + 33) + '" y="' + (cy + 17) + '" fill="#FFFFFF" font-size="17" font-weight="700" font-family="' + FT + '">' + (cls ? cls.rotulo : 'Sem dado') + '</text>';
      });
    });

    const ex = W / 2, ey = topo + alt / 2;
    svg += '<line x1="' + ex + '" y1="' + ey + '" x2="' + ex + '" y2="' + (ey + 40) + '" stroke="#C5D6BC" stroke-width="2.5"/>';
    svg += '<circle cx="' + ex + '" cy="' + (ey - 10) + '" r="14" fill="#F2F7EE"/>';
    svg += '<path d="M' + (ex - 6) + ' ' + (ey - 10) + 'a6 6 0 1 1 12 0" fill="none" stroke="#1F4D2E" stroke-width="2.2"/>';
    svg += '<circle cx="' + ex + '" cy="' + (ey - 10) + '" r="2.4" fill="#1F4D2E"/>';
    svg += '<text x="' + ex + '" y="' + (ey + 56) + '" text-anchor="middle" fill="#C5D6BC" font-size="10.5" font-family="' + F + '">estação</text>';
    svg += '</svg>';
    $('planta-svg').innerHTML = svg;
  }

  function desenharClima() {
    const u = ultimaLeitura() || {};
    $('v-temp').textContent = num(u.temp, 1);
    $('v-umid').textContent = num(u.umid, 0);
    ['lum1', 'lum2'].forEach((k) => {
      const c = classeLuz(u[k]);
      $('v-' + k).textContent = c ? c.rotulo : '–';
      $('b-' + k).textContent = u[k] === null || u[k] === undefined ? '' : num(u[k], 0) + ' bruto';
    });
  }

  function desenharSombrite() {
    const s = estadoSombrite(ultimaLeitura());
    const caixa = document.querySelector('.sombrite');
    caixa.dataset.estado = s.id;
    $('sombrite-estado').textContent = s.rotulo;
    $('sombrite-nota').textContent = s.id === 'sem'
      ? 'O estado aparece quando os fins de curso (GPIO 13 e 14) forem instalados e enviados para a planilha.'
      : '';
    const fechado = s.id === 'fechado';
    $('sombrite-icone').innerHTML =
      '<svg viewBox="0 0 64 48" width="64" height="48">' +
      '<line x1="6" y1="8" x2="6" y2="44" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>' +
      '<line x1="58" y1="8" x2="58" y2="44" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>' +
      '<line x1="4" y1="8" x2="60" y2="8" stroke="currentColor" stroke-width="2" stroke-dasharray="3 3"/>' +
      (fechado
        ? '<path d="M6 8 L58 8 L58 15 L6 15 Z" fill="currentColor" opacity=".85"/><path d="M14 22v6M24 22v6M34 22v6M44 22v6M50 22v6" stroke="currentColor" stroke-width="2" opacity=".35"/>'
        : '<path d="M6 8 l4 0 l0 7 l-4 0 Z M10 8 l3 0 l0 7 l-3 0 Z" fill="currentColor" opacity=".85"/><circle cx="40" cy="26" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M40 13v4M40 35v4M27 26h4M49 26h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>') +
      '</svg>';
  }

  // ================================================================ desenho: gráficos
  // Pontos com quebra visível onde houve falha de comunicação; guarda o bruto para a dica
  function pontos(chave, transformar) {
    const out = [];
    let anterior = null;
    estado.leituras.forEach((l) => {
      if (anterior && l.t - anterior > INTERVALO_MS * 2.5) out.push({ x: anterior + INTERVALO_MS, y: null });
      const v = l[chave];
      const nulo = v === null || v === undefined;
      out.push({ x: l.t, y: nulo ? null : (transformar ? transformar(v) : v), bruto: nulo ? null : v });
      anterior = l.t;
    });
    return out;
  }

  const DESLOCAMENTO_MS = -4 * 3600 * 1000;   // horário de MS (UTC−4)
  const PASSOS_MIN = [15, 30, 60, 120, 180, 360, 720, 1440];
  function passoEixo(min, max) {
    const p = PASSOS_MIN.find((m) => (max - min) / (m * 60000) <= 6) || 1440;
    return p * 60000;
  }

  function janelaTempo() {
    const fim = Date.now();
    const inicioPeriodo = fim - estado.dias * 24 * 3600 * 1000;
    const recentes = estado.leituras.filter((l) => l.t >= inicioPeriodo);
    const inicio = recentes.length ? Math.max(inicioPeriodo, recentes[0].t - INTERVALO_MS) : inicioPeriodo;
    return { min: inicio, max: fim };
  }

  function marcasTempo(scale) {
    const passo = passoEixo(scale.min, scale.max);
    const ticks = [];
    for (let t = Math.ceil((scale.min + DESLOCAMENTO_MS) / passo) * passo - DESLOCAMENTO_MS; t <= scale.max; t += passo) ticks.push({ value: t });
    scale.ticks = ticks;
  }

  // Eixo Y com nomes das faixas no centro de cada uma
  function eixoFaixas(def) {
    return {
      min: def.min, max: def.max, reverse: def.reverso,
      grid: { display: false },
      afterBuildTicks: (scale) => { scale.ticks = def.faixas.map((f) => ({ value: (f.de + f.ate) / 2 })); },
      ticks: {
        autoSkip: false,
        callback: (v) => { const f = def.faixas.find((x) => Math.abs((x.de + x.ate) / 2 - v) < 1e-6); return f ? f.rotulo : ''; },
      },
    };
  }

  // Plugin: pinta o fundo de cada faixa e marca os limites
  const pluginFaixas = {
    id: 'faixasFundo',
    beforeDatasetsDraw(chart, args, opts) {
      if (!opts || !opts.faixas) return;
      const { ctx, chartArea: a, scales } = chart;
      const y = scales[opts.eixo || 'y'];
      ctx.save();
      opts.faixas.forEach((f) => {
        const y1 = y.getPixelForValue(f.de), y2 = y.getPixelForValue(f.ate);
        const topo = Math.max(a.top, Math.min(y1, y2)), base = Math.min(a.bottom, Math.max(y1, y2));
        ctx.fillStyle = f.cor;
        ctx.fillRect(a.left, topo, a.right - a.left, base - topo);
      });
      ctx.strokeStyle = opts.linha || 'rgba(128,128,128,.35)';
      ctx.setLineDash([4, 4]);
      opts.faixas.forEach((f) => {
        [f.de, f.ate].forEach((v) => {
          if (v <= Math.min(y.min, y.max) || v >= Math.max(y.min, y.max)) return;
          const py = Math.round(y.getPixelForValue(v)) + 0.5;
          ctx.beginPath(); ctx.moveTo(a.left, py); ctx.lineTo(a.right, py); ctx.stroke();
        });
      });
      ctx.restore();
    },
  };

  function opcoesBase(eixos, extras) {
    const grade = cssVar('--linha'), tick = cssVar('--suave');
    const jan = janelaTempo();
    const curto = passoEixo(jan.min, jan.max) < 24 * 3600 * 1000;
    const poucos = estado.leituras.filter((l) => l.t >= jan.min).length < 40;
    const scales = {
      x: {
        type: 'linear', min: jan.min, max: jan.max,
        grid: { color: grade },
        afterBuildTicks: marcasTempo,
        ticks: {
          color: tick, maxRotation: 0,
          callback: (v) => { if (!curto) return fmtDia.format(v); const h = fmtHora.format(v); return h === '00:00' ? fmtDia.format(v) : h; },
        },
      },
    };
    Object.assign(scales, eixos);
    Object.keys(scales).forEach((k) => {
      if (k === 'x') return;
      if (!scales[k].grid) scales[k].grid = { color: grade };
      scales[k].ticks = Object.assign({ color: tick, callback: (v) => num(v, Number.isInteger(v) ? 0 : 1) }, scales[k].ticks || {});
      if (scales[k].title) scales[k].title.color = tick;
    });
    return {
      responsive: true, maintainAspectRatio: false, animation: false, spanGaps: false,
      interaction: { mode: 'index', intersect: false },
      elements: { point: { radius: poucos ? 3.5 : 2, hoverRadius: 6, hitRadius: 8 }, line: { borderWidth: 2, tension: 0.25 } },
      plugins: Object.assign({
        legend: { labels: { color: cssVar('--texto'), boxWidth: 12, boxHeight: 12, usePointStyle: true } },
        tooltip: { callbacks: { title: (it) => (it.length ? fmtCompleto.format(it[0].parsed.x) : '') } },
      }, extras || {}),
      scales,
    };
  }

  function grafico(id, config) {
    if (graficos[id]) graficos[id].destroy();
    graficos[id] = new Chart($(id), config);
  }

  function desenharGraficos() {
    if (estado.aba !== 'painel') return;
    if (typeof Chart === 'undefined') {
      document.querySelectorAll('.grafico .tela').forEach((t) => {
        t.innerHTML = '<p class="nota" style="padding:20px 4px">Os gráficos precisam de internet na primeira abertura do app.</p>';
      });
      return;
    }
    if (!Chart.registry.plugins.get('faixasFundo')) Chart.register(pluginFaixas);
    Chart.defaults.font.family = "'Atkinson Hyperlegible', system-ui, sans-serif";
    const linhaFaixa = cssVar('--suave');

    // ---- solo
    const fs = faixasSolo();
    const pct = algumCalibrado();
    const coresSolo = ['#8A5A32', '#C08A55', '#2E6B42', '#7FA860'];
    const optSolo = opcoesBase({ y: eixoFaixas(fs) }, {
      faixasFundo: { faixas: fs.faixas, linha: linhaFaixa },
      tooltip: { callbacks: {
        title: (it) => (it.length ? fmtCompleto.format(it[0].parsed.x) : ''),
        label: (c) => {
          const b = c.raw.bruto;
          const cls = classeSolo(c.dataset.chave, b);
          return c.dataset.label + ': ' + num(b, 0) + ' bruto' + (pct ? ' (' + num(c.parsed.y, 0) + '%)' : '') + (cls ? ', ' + cls.rotulo.toLowerCase() : '');
        },
      } },
    });
    grafico('g-solo', {
      type: 'line',
      data: { datasets: SONDAS.map((s, i) => ({
        label: nomeSonda(s.chave), chave: s.chave,
        data: pontos(s.chave, pct ? (v) => percentual(s.chave, v) : null),
        borderColor: coresSolo[i], backgroundColor: coresSolo[i],
      })) },
      options: optSolo,
    });

    // ---- clima (unidades reais, sem faixas)
    grafico('g-clima', {
      type: 'line',
      data: { datasets: [
        { label: 'Temperatura', data: pontos('temp'), yAxisID: 'y', borderColor: cssVar('--beterraba'), backgroundColor: cssVar('--beterraba') },
        { label: 'Umidade do ar', data: pontos('umid'), yAxisID: 'y2', borderColor: cssVar('--ceu'), backgroundColor: cssVar('--ceu') },
      ] },
      options: opcoesBase({
        y: { position: 'left', grace: 2, title: { display: true, text: '°C' } },
        y2: { position: 'right', min: 0, max: 100, grid: { drawOnChartArea: false }, title: { display: true, text: '%' } },
      }, {
        tooltip: { callbacks: {
          title: (it) => (it.length ? fmtCompleto.format(it[0].parsed.x) : ''),
          label: (c) => c.dataset.label + ': ' + (c.dataset.yAxisID === 'y' ? num(c.parsed.y, 1) + ' °C' : num(c.parsed.y, 0) + '%'),
        } },
      }),
    });

    // ---- luminosidade
    const fl = faixasLuz();
    grafico('g-luz', {
      type: 'line',
      data: { datasets: [
        { label: 'LDR 1', data: pontos('lum1'), borderColor: cssVar('--sol'), backgroundColor: cssVar('--sol') },
        { label: 'LDR 2', data: pontos('lum2'), borderColor: '#8C6A00', backgroundColor: '#8C6A00' },
      ] },
      options: opcoesBase({ y: eixoFaixas(fl) }, {
        faixasFundo: { faixas: fl.faixas, linha: linhaFaixa },
        tooltip: { callbacks: {
          title: (it) => (it.length ? fmtCompleto.format(it[0].parsed.x) : ''),
          label: (c) => { const cls = classeLuz(c.raw.bruto); return c.dataset.label + ': ' + num(c.raw.bruto, 0) + ' bruto' + (cls ? ', ' + cls.rotulo.toLowerCase() : ''); },
        } },
      }),
    });
  }

  // ================================================================ desenho: recomendações
  function linhaTabela(celulas) {
    const tr = document.createElement('tr');
    celulas.forEach((c, i) => {
      const td = document.createElement(i === 0 ? 'th' : 'td');
      if (i === 0) td.scope = 'row';
      if (c && typeof c === 'object') { td.textContent = c.texto; if (c.classe) td.className = c.classe; }
      else td.textContent = c;
      tr.appendChild(td);
    });
    return tr;
  }

  function desenharDecisao(id, d) {
    const art = $(id);
    art.dataset.nivel = d.nivel;
    art.querySelector('.decisao-texto').textContent = d.texto;
    const ul = art.querySelector('.decisao-motivos');
    ul.innerHTML = '';
    d.motivos.forEach((m) => { const li = document.createElement('li'); li.textContent = m; ul.appendChild(li); });
  }

  function desenharRecomendacoes() {
    const r = calcularRecomendacoes();
    desenharDecisao('dec-irrigacao', r.irr);
    desenharDecisao('dec-sombrite', r.somb);

    const tb = document.querySelector('#tab-condicoes tbody');
    tb.innerHTML = '';
    ['A', 'B'].forEach((c) => {
      const s = r.solo[c];
      tb.appendChild(linhaTabela([
        'Solo, ' + CFG.CANTEIROS[c],
        s.classe ? num(s.valor, 0) + ' bruto (média de ' + s.sondas.join(' e ') + ')' : 'Sem leitura confiável',
        { texto: s.classe ? s.classe.rotulo : '–', classe: 'cls cls-' + (s.classe ? s.classe.id : 'nd') },
      ]));
    });
    tb.appendChild(linhaTabela(['Temperatura do ar', r.temp === null || r.temp === undefined ? '–' : num(r.temp, 1) + ' °C', { texto: r.cT ? r.cT.rotulo : '–', classe: 'cls' }]));
    tb.appendChild(linhaTabela(['Umidade do ar', r.umid === null || r.umid === undefined ? '–' : num(r.umid, 0) + '%', { texto: r.cU ? r.cU.rotulo : '–', classe: 'cls' }]));
    tb.appendChild(linhaTabela(['Luminosidade', r.luzV === null ? '–' : num(r.luzV, 0) + ' bruto (média dos LDRs)', { texto: r.cL ? r.cL.rotulo : '–', classe: 'cls' }]));
    tb.appendChild(linhaTabela(['Sombrite', r.sAtual.id === 'sem' ? 'Sensor ainda não instalado' : 'Fim de curso', { texto: r.sAtual.rotulo, classe: 'cls' }]));

    const B = CFG.SOLO_BRUTO, P = CFG.SOLO_PCT, C = CFG.CLIMA;
    const cal = algumCalibrado();
    const crit = [
      ['Solo seco', cal ? 'umidade abaixo de ' + P.SECO_ABAIXO + '%' : 'valor bruto acima de ' + num(B.SECO_ACIMA, 0), 'Irrigar o canteiro'],
      ['Solo encharcado', cal ? 'umidade acima de ' + P.ENCHARCADO_ACIMA + '%' : 'valor bruto abaixo de ' + num(B.ENCHARCADO_ABAIXO, 0), 'Suspender ou reduzir a irrigação'],
      ['Dia quente e ar seco', 'temperatura a partir de ' + C.TEMP_QUENTE + ' °C e ar até ' + C.UMID_AR_SECO + '%', 'Redobrar a atenção à irrigação'],
      ['Tempo chuvoso', 'ar a partir de ' + C.UMID_AR_CHUVA + '% com céu nublado ou noite', 'Reduzir a irrigação'],
      ['Frio e úmido', 'tempo chuvoso e temperatura até ' + C.TEMP_FRIO + ' °C', 'Reduzir a irrigação'],
      ['Sol forte e calor', 'ensolarado e temperatura a partir de ' + C.TEMP_QUENTE + ' °C', 'Fechar o sombrite'],
      ['Sol forte e ar seco', 'ensolarado e ar até ' + C.UMID_AR_SECO + '%', 'Fechar nas horas mais quentes'],
      ['Noite, nublado ou céu limpo', 'sem sol forte', 'Manter o sombrite aberto'],
    ];
    const tc = document.querySelector('#tab-criterios tbody');
    tc.innerHTML = '';
    crit.forEach((c) => tc.appendChild(linhaTabela(c)));
  }

  // ================================================================ desenho: conferência
  const ROTULO_NIVEL = { ok: 'OK', atencao: 'Verificar', falha: 'Falha' };

  function desenharConferencia() {
    const u = ultimaLeitura();
    const agora = Date.now();
    $('op-ultima').textContent = u ? fmtCompleto.format(u.t) + ' (' + haQuanto(agora - u.t) + ')' : 'Nenhuma';

    const inicio = agora - 24 * 3600 * 1000;
    const ult24 = estado.leituras.filter((l) => l.t >= inicio);
    const base = ult24.length ? Math.max(inicio, ult24[0].t) : inicio;
    const esperadas = Math.max(1, Math.floor((agora - base) / INTERVALO_MS) + (ult24.length ? 1 : 0));
    const taxa = Math.min(100, Math.round((ult24.length / esperadas) * 100));
    $('op-recebidas').textContent = ult24.length + ' de ' + esperadas + ' esperadas (' + taxa + '%)';

    let lacuna = 0, ant = base;
    ult24.forEach((l) => { lacuna = Math.max(lacuna, l.t - ant); ant = l.t; });
    lacuna = Math.max(lacuna, agora - ant);
    $('op-lacuna').textContent = duracao(lacuna);

    const itens = itensOperacao();
    const peso = { falha: 0, atencao: 1, ok: 2 };
    const ul = $('lista-saude');
    ul.innerHTML = '';
    itens.slice().sort((a, b) => peso[a.r.nivel] - peso[b.r.nivel]).forEach((it) => {
      const li = document.createElement('li');
      li.dataset.nivel = it.r.nivel;
      li.innerHTML = '<span class="marca" aria-hidden="true"></span><strong></strong><span class="detalhe"></span>';
      li.querySelector('strong').textContent = it.titulo;
      li.querySelector('.detalhe').textContent = it.r.texto;
      ul.appendChild(li);
    });
    if (!algumCalibrado()) {
      const li = document.createElement('li');
      li.dataset.nivel = 'info';
      li.innerHTML = '<span class="marca" aria-hidden="true"></span><strong>Calibração das sondas</strong><span class="detalhe">Pendente. Até lá, as classes Seco, Adequado e Encharcado usam faixas brutas provisórias.</span>';
      ul.appendChild(li);
    }

    const tb = document.querySelector('#tab-sensores tbody');
    tb.innerHTML = '';
    itens.filter((i) => i.id !== 'esp').forEach((it) => {
      let valor = '–';
      if (u) {
        if (it.id === 'dht') valor = num(u.temp, 1) + ' °C, ' + num(u.umid, 0) + '%';
        else if (u[it.id] !== null && u[it.id] !== undefined) valor = num(u[it.id], 0) + ' bruto';
      }
      tb.appendChild(linhaTabela([it.curto || it.titulo, it.ligacao, valor,{ texto: ROTULO_NIVEL[it.r.nivel], classe: 'nivel nivel-' + it.r.nivel }]));
    });
  }

  // ================================================================ tudo
  function desenharTudo() {
    desenharConexao();
    desenharSelo();
    desenharPlanta();
    desenharClima();
    desenharSombrite();
    desenharRecomendacoes();
    desenharConferencia();
    desenharGraficos();
    $('rodape-fonte').textContent = MODO_DEMO
      ? 'Dados simulados para demonstração.'
      : (estado.recebidoEm ? 'Dados da planilha, atualizados às ' + fmtHora.format(estado.recebidoEm) + '.' : '');
  }

  // ================================================================ modo demonstração
  function gerarDemo(dias) {
    const fim = Date.now() - 6 * 60000;
    const ini = fim - dias * 24 * 3600 * 1000;
    const out = [];
    const ruido = (a) => (Math.random() - 0.5) * a;
    const solo = [2300, 2450, 2900, 3050];
    const lacunaIni = fim - 30 * 3600 * 1000, lacunaFim = lacunaIni + 70 * 60000;

    for (let t = ini; t <= fim; t += INTERVALO_MS) {
      if (t > lacunaIni && t < lacunaFim) continue;
      const h = (((new Date(t).getUTCHours() - 4) + 24) % 24) + new Date(t).getUTCMinutes() / 60;
      const ang = ((h - 9) / 24) * 2 * Math.PI;
      const sol = Math.max(0, Math.sin(((h - 6) / 12) * Math.PI));

      solo.forEach((v, i) => {
        let nv = v + (6 + 26 * sol) * (i < 2 ? 1 : 1.3);
        if (Math.abs(h - 6) < 0.13 || Math.abs(h - 17) < 0.13) nv -= 900;
        solo[i] = Math.max(1200, Math.min(3950, nv));
      });

      out.push({
        t,
        lum1: Math.round(Math.max(40, 3500 * sol + 60 + ruido(140))),
        lum2: Math.round(Math.max(40, 3200 * sol + 50 + ruido(140))),
        solo1: Math.round(solo[0] + ruido(30)),
        solo2: Math.round(solo[1] + ruido(30)),
        solo3: Math.round(solo[2] + ruido(30)),
        solo4: fim - t < 5 * 3600 * 1000 ? 4095 : Math.round(solo[3] + ruido(30)),
        temp: +(25 + 7 * Math.sin(ang) + ruido(0.6)).toFixed(1),
        umid: +Math.max(30, Math.min(98, 68 - 24 * Math.sin(ang) + ruido(3))).toFixed(1),
        sombrite: sol > 0.75 ? 1 : 0,
      });
    }
    return out;
  }

  // ================================================================ eventos
  $('btn-atualizar').addEventListener('click', atualizar);

  document.querySelectorAll('.periodos button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.periodos button').forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
      estado.dias = parseFloat(b.dataset.dias);
      atualizar();
    });
  });

  window.addEventListener('hashchange', () => { mostrarAba(location.hash.slice(1)); window.scrollTo(0, 0); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - estado.recebidoEm > 60000) atualizar();
  });
  window.addEventListener('online', atualizar);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', desenharGraficos);

  setInterval(atualizar, CFG.ATUALIZAR_MIN * 60000);
  setInterval(() => { desenharConexao(); desenharConferencia(); }, 30000);

  $('faixa-demo').hidden = !MODO_DEMO;
  mostrarAba(location.hash.slice(1));

  const cache = lerCache();
  if (!MODO_DEMO && cache && cache.leituras) {
    estado.leituras = cache.leituras;
    estado.recebidoEm = cache.recebidoEm;
    desenharTudo();
  }
  atualizar();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW:', e)));
  }
})();
